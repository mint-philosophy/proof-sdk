import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `proof-share-collab-session-epoch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_PERSIST_DEBOUNCE_MS = '25';

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');

  const slug = `collab-session-epoch-${Math.random().toString(36).slice(2, 10)}`;

  await collab.startCollabRuntimeEmbedded(4000);
  try {
    db.createDocument(slug, '# Content A\n\nLong.', {}, 'Session epoch test');

    const ydocA = new Y.Doc();
    ydocA.getText('markdown').insert(0, '# Content A\n\nLong.');
    const updateA = Y.encodeStateAsUpdate(ydocA);
    const seq = db.appendYUpdate(slug, updateA, 'test');
    db.saveYSnapshot(slug, seq, updateA);

    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as any;
    assert(instance && typeof instance.createDocument === 'function', 'Expected collab runtime to expose a hocuspocus instance');
    let closeConnectionsSawRegisteredDoc: boolean | null = null;
    const originalCloseConnections = typeof instance.closeConnections === 'function'
      ? instance.closeConnections.bind(instance)
      : null;
    if (originalCloseConnections) {
      instance.closeConnections = (documentName?: string) => {
        if (documentName === slug) {
          closeConnectionsSawRegisteredDoc = instance.documents?.has?.(slug) === true;
        }
        return originalCloseConnections(documentName);
      };
    }

    const loaded = await instance.createDocument(
      slug,
      {},
      'test-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );
    assert(typeof loaded?.getText === 'function', 'Expected hocuspocus document to be a Y.Doc');
    assert(String(loaded.getText('markdown').toString()).includes('Content A'), 'Expected initial in-memory doc to reflect content A');
    assert(instance.documents?.has?.(slug) === true, 'Expected stale document to be retained in-memory before epoch bump');

    const nextEpoch = db.bumpDocumentAccessEpoch(slug);
    assert(typeof nextEpoch === 'number' && nextEpoch > 0, 'Expected access epoch bump');
    db.updateDocument(slug, '# Content B\n\nShort.');
    db.clearYjsState(slug);
    collab.__unsafeSchedulePersistDocFromOnChangeForTests(slug, loaded);

    const readableAfterEpochBump = collab.getCanonicalReadableDocumentSync(slug, 'state');
    assert(Boolean(readableAfterEpochBump), 'Expected canonical state read after epoch bump');
    assert(
      (readableAfterEpochBump?.markdown ?? '').includes('Content B'),
      `Expected canonical state read to evict stale in-memory doc and return content B. markdown=${(readableAfterEpochBump?.markdown ?? '').slice(0, 120)}`,
    );
    assert(
      !(readableAfterEpochBump?.markdown ?? '').includes('Content A'),
      `Expected canonical state read not to reuse stale room content A. markdown=${(readableAfterEpochBump?.markdown ?? '').slice(0, 120)}`,
    );
    assert(instance.documents?.has?.(slug) === false, 'Expected canonical state read to evict stale in-memory doc after epoch bump');

    const session = collab.buildCollabSession(slug, 'editor');
    assert(Boolean(session?.token), 'Expected collab session after access epoch bump');
    assert(closeConnectionsSawRegisteredDoc !== false, 'Expected epoch eviction to close stale sockets before dropping the Hocuspocus room');
    assert(instance.documents?.has?.(slug) === false, 'Expected collab session creation to keep stale in-memory doc evicted after epoch bump');

    const reloaded = await instance.createDocument(
      slug,
      {},
      'test-socket-2',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );
    assert(String(reloaded.getText('markdown').toString()).includes('Content B'), 'Expected reloaded document to hydrate canonical content B');

    await new Promise((resolve) => setTimeout(resolve, 75));
    collab.__unsafePersistDocFromOnChangeForTests(slug, loaded);

    const row = db.getDocumentBySlug(slug);
    assert(Boolean(row), 'Expected canonical document row after stale persist attempts');
    assert(
      (row?.markdown ?? '').includes('Content B'),
      `Expected canonical content B to survive stale room persistence. markdown=${(row?.markdown ?? '').slice(0, 120)}`,
    );
    assert(
      !(row?.markdown ?? '').includes('Content A'),
      `Expected stale room content A not to be restored. markdown=${(row?.markdown ?? '').slice(0, 120)}`,
    );

    console.log('✓ collab session issuance evicts stale rooms and drops old-room persistence after access epoch bumps');
  } finally {
    await collab.stopCollabRuntime();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
