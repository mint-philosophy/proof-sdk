import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function setMarkdown(doc: Y.Doc, value: string): void {
  const text = doc.getText('markdown');
  const current = text.toString();
  if (current.length > 0) text.delete(0, current.length);
  if (value.length > 0) text.insert(0, value);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const dbName = `proof-collab-empty-fragment-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const previousDbPath = process.env.DATABASE_PATH;
  const previousIdleTimeout = process.env.COLLAB_DOC_IDLE_TIMEOUT_MS;
  const previousMaxLoadedDocs = process.env.COLLAB_MAX_LOADED_DOCS;
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');
  const { getHeadlessMilkdownParser } = await import('../../server/milkdown-headless.ts');

  const slug = `empty-fragment-${Math.random().toString(36).slice(2, 10)}`;
  const markdownA = [
    '# Launch Plan',
    '',
    'Initial paragraph.',
  ].join('\n');
  const browserMarker = `browser-marker-${Math.random().toString(36).slice(2, 8)}`;
  const markdownB = [
    '# Launch Plan',
    '',
    `Initial paragraph. ${browserMarker}`,
  ].join('\n');

  try {
    db.createDocument(slug, markdownA, {}, 'empty fragment persistence regression');

    // Simulate a broken persisted Yjs baseline: markdown text exists, fragment is empty.
    const brokenPersisted = new Y.Doc();
    setMarkdown(brokenPersisted, markdownA);
    const update = Y.encodeStateAsUpdate(brokenPersisted);
    const seq = db.appendYUpdate(slug, update, 'broken-persisted-baseline');
    db.saveYSnapshot(slug, seq, update);
    getDbForTest(db).prepare(`
      UPDATE documents
      SET y_state_version = ?
      WHERE slug = ?
    `).run(seq, slug);

    await collab.startCollabRuntimeEmbedded(4000);
    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as {
      createDocument?: (
        slug: string,
        request: Record<string, unknown>,
        socketId: string,
        context: Record<string, unknown>,
        hooks: Record<string, unknown>,
      ) => Promise<Y.Doc>;
    };
    assert(instance && typeof instance.createDocument === 'function', 'Expected collab test instance');

    await instance.createDocument(
      slug,
      {},
      'empty-fragment-persist-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );
    const loadedDoc = collab.__unsafeGetLoadedDocForTests(slug);
    assert(Boolean(loadedDoc), 'Expected live loaded doc after collab load');

    const healedFragmentMarkdown = await collab.getLoadedCollabMarkdownFromFragment(slug);
    assert(
      healedFragmentMarkdown?.includes('Initial paragraph.') === true,
      `Expected load to repair empty persisted fragment from markdown. markdown=${String(healedFragmentMarkdown)}`,
    );

    const parser = await getHeadlessMilkdownParser();
    const nextDoc = parser.parseMarkdown(markdownB);
    loadedDoc!.transact(() => {
      const fragment = loadedDoc!.getXmlFragment('prosemirror');
      const length = fragment.length;
      if (length > 0) fragment.delete(0, length);
      prosemirrorToYXmlFragment(nextDoc as any, fragment as any);
    }, 'browser-edit');

    collab.__unsafePersistDocFromOnChangeForTests(slug, loadedDoc!);
    await sleep(250);

    const row = db.getDocumentBySlug(slug);
    assert(Boolean(row), 'Expected canonical document row after browser-style fragment persist');
    assert(
      (row?.markdown ?? '').includes(browserMarker),
      `Expected browser-origin fragment edit to reach canonical markdown after empty-fragment repair. markdown=${String(row?.markdown ?? '')}`,
    );

    const emptiedDoc = parser.parseMarkdown('');
    loadedDoc!.transact(() => {
      const fragment = loadedDoc!.getXmlFragment('prosemirror');
      const length = fragment.length;
      if (length > 0) fragment.delete(0, length);
      prosemirrorToYXmlFragment(emptiedDoc as any, fragment as any);
    }, 'browser-delete-all');

    collab.__unsafePersistDocFromOnChangeForTests(slug, loadedDoc!);
    await sleep(250);

    const emptiedRow = db.getDocumentBySlug(slug);
    assert(Boolean(emptiedRow), 'Expected canonical row after browser-style full delete');
    assert(
      (emptiedRow?.markdown ?? '').trim().length === 0,
      `Expected browser-style full delete to persist empty markdown instead of restoring content. markdown=${String(emptiedRow?.markdown ?? '')}`,
    );

    await collab.stopCollabRuntime();
    await collab.startCollabRuntimeEmbedded(4000);
    const reconnectInstance = collab.__unsafeGetHocuspocusInstanceForTests() as {
      createDocument?: (
        slug: string,
        request: Record<string, unknown>,
        socketId: string,
        context: Record<string, unknown>,
        hooks: Record<string, unknown>,
      ) => Promise<Y.Doc>;
    };
    assert(reconnectInstance && typeof reconnectInstance.createDocument === 'function', 'Expected reconnect collab test instance');

    await reconnectInstance.createDocument(
      slug,
      {},
      'empty-fragment-delete-reconnect-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );
    const reloadedMarkdown = collab.__unsafeGetLoadedDocForTests(slug)?.getText('markdown').toString() ?? null;
    assert(
      (reloadedMarkdown ?? '').trim().length === 0,
      `Expected reconnect after full delete to stay empty instead of restoring content. markdown=${String(reloadedMarkdown)}`,
    );

    await collab.stopCollabRuntime();
    const cachedReadable = collab.getCanonicalReadableDocumentSync(slug, 'state');
    assert(Boolean(cachedReadable), 'Expected sync canonical read to populate persisted-doc cache');
    assert(
      collab.__unsafeHasPersistedDocCacheForTests(slug),
      'Expected sync canonical read to cache persisted Yjs state for reuse',
    );
    assert(
      collab.__unsafeGetLoadedDocForTests(slug) === null,
      'Expected stopped runtime to leave only the persisted-doc cache populated',
    );

    process.env.COLLAB_DOC_IDLE_TIMEOUT_MS = '1';
    process.env.COLLAB_MAX_LOADED_DOCS = '1';
    await sleep(10);
    collab.__unsafeRunDocEvictionForTests();
    assert(
      collab.__unsafeHasPersistedDocCacheForTests(slug) === false,
      'Expected idle eviction to clear cache-only persisted Y.Doc entries',
    );

    console.log('✓ empty persisted fragments repair on load, browser-style full deletes stay empty, and cache-only persisted docs evict when idle');
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDbPath;
    }
    if (previousIdleTimeout === undefined) {
      delete process.env.COLLAB_DOC_IDLE_TIMEOUT_MS;
    } else {
      process.env.COLLAB_DOC_IDLE_TIMEOUT_MS = previousIdleTimeout;
    }
    if (previousMaxLoadedDocs === undefined) {
      delete process.env.COLLAB_MAX_LOADED_DOCS;
    } else {
      process.env.COLLAB_MAX_LOADED_DOCS = previousMaxLoadedDocs;
    }
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

function getDbForTest(dbModule: typeof import('../../server/db.ts')) {
  return dbModule.getDb();
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
