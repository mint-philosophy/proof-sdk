import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';
import {
  buildCanonicalShareMarkMetadata,
  getMarkMetadataWithQuotes,
  marksPluginKey,
} from '../editor/plugins/marks.js';
import type { StoredMark } from '../formats/marks.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  }
}

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' },
  },
  marks: {
    proofSuggestion: {
      attrs: {
        id: { default: null },
        kind: { default: 'replace' },
        by: { default: 'unknown' },
      },
      inclusive: false,
      spanning: true,
    },
  },
});

const marksStatePlugin = new Plugin({
  key: marksPluginKey,
  state: {
    init: () => ({ metadata: {}, activeMarkId: null }),
    apply: (tr, value) => {
      const meta = tr.getMeta(marksPluginKey);
      if (meta?.type === 'SET_METADATA') {
        return { ...value, metadata: meta.metadata };
      }
      if (meta?.type === 'SET_ACTIVE') {
        return { ...value, activeMarkId: meta.markId ?? null };
      }
      return value;
    },
  },
});

async function run(): Promise<void> {
  const dbName = `proof-share-track-changes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  delete process.env.PROOF_DB_ENV_INIT;

  const db = await import('../../server/db.ts');
  const { executeDocumentOperationAsync } = await import('../../server/document-engine.ts');

  try {
    const insertOneId = 'insert-one';
    const insertTwoId = 'insert-two';
    const liveDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha'),
        schema.text(' brave', [schema.marks.proofSuggestion.create({ id: insertOneId, kind: 'insert', by: 'human:editor' })]),
        schema.text(' beta gamma.'),
        schema.text(' bold', [schema.marks.proofSuggestion.create({ id: insertTwoId, kind: 'insert', by: 'human:editor' })]),
      ]),
    ]);

    const state = EditorState.create({
      schema,
      doc: liveDoc,
      plugins: [marksStatePlugin],
    });

    const liveMetadata = getMarkMetadataWithQuotes(state);
    const persistedMetadata = buildCanonicalShareMarkMetadata(state, liveMetadata);

    assertEqual(
      liveMetadata[insertOneId]?.quote,
      'brave',
      'Expected live insert metadata to carry the inserted quote before canonicalization',
    );
    assertEqual(
      persistedMetadata[insertOneId]?.range?.from,
      6,
      'Expected first insert to collapse to its canonical insertion point',
    );
    assertEqual(
      persistedMetadata[insertOneId]?.range?.to,
      6,
      'Expected first insert to persist as a collapsed anchor',
    );
    assertEqual(
      persistedMetadata[insertTwoId]?.range?.from,
      18,
      'Expected later insert to be rebased into canonical coordinates before persistence',
    );
    assertEqual(
      persistedMetadata[insertTwoId]?.range?.to,
      18,
      'Expected later insert to persist as a collapsed anchor',
    );
    assert(!persistedMetadata[insertOneId]?.quote, 'Expected persisted insert metadata to drop live quote text');
    assert(!persistedMetadata[insertTwoId]?.startRel, 'Expected persisted insert metadata to omit live relative anchors');

    const slug = `share-track-changes-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(
      slug,
      'Alpha beta gamma.\n',
      persistedMetadata as Record<string, StoredMark>,
      'Share track changes multi-insert regression',
    );

    const accepted = await executeDocumentOperationAsync(slug, 'POST', '/marks/accept', {
      markId: insertOneId,
      by: 'human:test',
    });
    assertEqual(accepted.status, 200, `Expected first insert accept to succeed, got ${accepted.status}`);
    assertEqual(
      String(accepted.body.markdown ?? ''),
      'Alpha brave beta gamma.\n',
      `Expected accepted markdown to materialize only the first insert, got ${JSON.stringify(accepted.body.markdown)}`,
    );

    const acceptedMarks = (accepted.body.marks ?? {}) as Record<string, StoredMark>;
    assert(!acceptedMarks[insertOneId], 'Expected accepted insert to be removed from the response marks payload');
    assertEqual(
      acceptedMarks[insertTwoId]?.range?.from,
      24,
      `Expected later insert to shift forward after accepting an earlier insert, got ${JSON.stringify(acceptedMarks[insertTwoId]?.range)}`,
    );
    assertEqual(
      acceptedMarks[insertTwoId]?.range?.to,
      24,
      'Expected later insert to remain collapsed after rebasing',
    );

    const stored = db.getDocumentBySlug(slug);
    assertEqual(
      stored?.markdown,
      'Alpha brave beta gamma.\n',
      `Expected stored markdown to match accepted insert result, got ${JSON.stringify(stored?.markdown)}`,
    );
    const storedMarks = stored?.marks ? JSON.parse(stored.marks) as Record<string, StoredMark> : {};
    assert(!storedMarks[insertOneId], 'Expected accepted insert to be removed from stored pending marks');
    assertEqual(
      storedMarks[insertTwoId]?.range?.from,
      24,
      `Expected stored later insert to stay rebased after persistence, got ${JSON.stringify(storedMarks[insertTwoId]?.range)}`,
    );

    console.log('share-track-changes-multi-insert-regression.test.ts passed');
  } finally {
    if (prevDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDatabasePath;

    if (prevProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = prevProofEnv;

    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;

    if (prevDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = prevDbEnvInit;

    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
