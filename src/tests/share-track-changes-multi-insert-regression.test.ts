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

    const prependInsertId = 'prepend-insert';
    const appendInsertId = 'append-insert';
    const crossBlockLiveDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('First baseline paragraph with enough text to test cross-block offset calculations properly.'),
        schema.text(' TC insertion in paragraph one.', [schema.marks.proofSuggestion.create({ id: appendInsertId, kind: 'insert', by: 'human:editor' })]),
      ]),
      schema.node('paragraph', null, [
        schema.text('TC insertion in paragraph two. ', [schema.marks.proofSuggestion.create({ id: prependInsertId, kind: 'insert', by: 'human:editor' })]),
        schema.text('Second baseline paragraph for multi-block accept all verification testing.'),
      ]),
    ]);

    const crossBlockState = EditorState.create({
      schema,
      doc: crossBlockLiveDoc,
      plugins: [marksStatePlugin],
    });

    const crossBlockLiveMetadata = getMarkMetadataWithQuotes(crossBlockState);
    const crossBlockPersistedMetadata = buildCanonicalShareMarkMetadata(crossBlockState, crossBlockLiveMetadata);

    assertEqual(
      crossBlockPersistedMetadata[appendInsertId]?.range?.from,
      92,
      `Expected appended paragraph insert to persist at its canonical insertion point, got ${JSON.stringify(crossBlockPersistedMetadata[appendInsertId]?.range)}`,
    );
    assertEqual(
      crossBlockPersistedMetadata[appendInsertId]?.range?.to,
      92,
      'Expected appended paragraph insert to stay collapsed in persisted metadata',
    );
    assertEqual(
      crossBlockPersistedMetadata[prependInsertId]?.range?.from,
      94,
      `Expected prepended next-paragraph insert to persist as its own canonical insertion point, got ${JSON.stringify(crossBlockPersistedMetadata[prependInsertId]?.range)}`,
    );
    assertEqual(
      crossBlockPersistedMetadata[prependInsertId]?.range?.to,
      94,
      'Expected prepended next-paragraph insert to stay collapsed in persisted metadata',
    );
    assertEqual(
      crossBlockPersistedMetadata[prependInsertId]?.quote,
      'TC insertion in paragraph two.',
      'Expected prepended next-paragraph insert to preserve its quote for block-level resolution',
    );
    assertEqual(
      crossBlockPersistedMetadata[prependInsertId]?.startRel,
      'char:123',
      'Expected prepended next-paragraph insert to preserve its startRel anchor',
    );
    assertEqual(
      crossBlockPersistedMetadata[prependInsertId]?.endRel,
      'char:154',
      'Expected prepended next-paragraph insert to preserve its endRel anchor',
    );
    assert(
      !crossBlockPersistedMetadata[appendInsertId]?.quote,
      'Expected appended paragraph insert to remain quote-less after canonicalization',
    );

    const crossBlockSlug = `share-track-changes-cross-block-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(
      crossBlockSlug,
      'First baseline paragraph with enough text to test cross-block offset calculations properly. TC insertion in paragraph one.\n\nTC insertion in paragraph two. Second baseline paragraph for multi-block accept all verification testing.\n',
      crossBlockPersistedMetadata as Record<string, StoredMark>,
      'Share track changes cross-block prepend regression',
    );

    const crossBlockAccepted = await executeDocumentOperationAsync(crossBlockSlug, 'POST', '/marks/accept-all', {
      markIds: [appendInsertId, prependInsertId],
      by: 'human:test',
    });
    assertEqual(crossBlockAccepted.status, 200, `Expected cross-block accept-all to succeed, got ${crossBlockAccepted.status}`);
    assertEqual(
      String(crossBlockAccepted.body.markdown ?? ''),
      'First baseline paragraph with enough text to test cross-block offset calculations properly. TC insertion in paragraph one.\n\nTC insertion in paragraph two. Second baseline paragraph for multi-block accept all verification testing.\n',
      `Expected cross-block accept-all not to drift the prepended second-paragraph insert into the first paragraph, got ${JSON.stringify(crossBlockAccepted.body.markdown)}`,
    );

    const run34HeadingId = 'run34-heading';
    const run34ParagraphOneId = 'run34-paragraph-one';
    const run34ParagraphTwoId = 'run34-paragraph-two';
    const run34LiveDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Run 34 Accept All Test'),
        schema.text(' TC heading edit', [schema.marks.proofSuggestion.create({ id: run34HeadingId, kind: 'insert', by: 'human:editor' })]),
      ]),
      schema.node('paragraph', null, [
        schema.text('First baseline paragraph with enough text to test cross-block offset calculations properly.'),
        schema.text(' TC insertion in paragraph one.', [schema.marks.proofSuggestion.create({ id: run34ParagraphOneId, kind: 'insert', by: 'human:editor' })]),
      ]),
      schema.node('paragraph', null, [
        schema.text('Second baseline paragraph for multi-block accept all verification testing.'),
        schema.text(' TC insertion in paragraph two.', [schema.marks.proofSuggestion.create({ id: run34ParagraphTwoId, kind: 'insert', by: 'human:editor' })]),
      ]),
    ]);

    const run34State = EditorState.create({
      schema,
      doc: run34LiveDoc,
      plugins: [marksStatePlugin],
    });

    const run34LiveMetadata = getMarkMetadataWithQuotes(run34State);
    const run34PersistedMetadata = buildCanonicalShareMarkMetadata(run34State, run34LiveMetadata);
    for (const markId of [run34HeadingId, run34ParagraphOneId, run34ParagraphTwoId]) {
      assert(
        run34PersistedMetadata[markId]?.range?.from === run34PersistedMetadata[markId]?.range?.to,
        `Expected ${markId} to stay collapsed after canonicalization, got ${JSON.stringify(run34PersistedMetadata[markId])}`,
      );
      assert(
        !run34PersistedMetadata[markId]?.quote,
        `Expected ${markId} to remain quote-less after canonicalization, got ${JSON.stringify(run34PersistedMetadata[markId])}`,
      );
    }

    const run34Slug = `share-track-changes-run34-${Math.random().toString(36).slice(2, 10)}`;
    const run34Markdown = 'Run 34 Accept All Test TC heading edit\n\n'
      + 'First baseline paragraph with enough text to test cross-block offset calculations properly. TC insertion in paragraph one.\n\n'
      + 'Second baseline paragraph for multi-block accept all verification testing. TC insertion in paragraph two.\n';
    db.createDocument(
      run34Slug,
      run34Markdown,
      run34PersistedMetadata as Record<string, StoredMark>,
      'Share track changes run 34 accept-all regression',
    );

    const run34Accepted = await executeDocumentOperationAsync(run34Slug, 'POST', '/marks/accept-all', {
      markIds: [run34HeadingId, run34ParagraphOneId, run34ParagraphTwoId],
      by: 'human:test',
    });
    assertEqual(run34Accepted.status, 200, `Expected run 34 accept-all to succeed, got ${run34Accepted.status}`);
    assertEqual(
      String(run34Accepted.body.markdown ?? ''),
      run34Markdown,
      `Expected run 34 accept-all not to duplicate or drift appended inserts across blocks, got ${JSON.stringify(run34Accepted.body.markdown)}`,
    );
    assertEqual(
      Object.keys((run34Accepted.body.marks ?? {}) as Record<string, StoredMark>).length,
      0,
      'Expected run 34 accept-all to clear all accepted insert marks',
    );

    const rejectParagraphOneId = 'reject-paragraph-one';
    const rejectParagraphTwoId = 'reject-paragraph-two';
    const rejectLiveDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Baseline.'),
      ]),
      schema.node('paragraph', null, [
        schema.text('TC reject one.', [schema.marks.proofSuggestion.create({ id: rejectParagraphOneId, kind: 'insert', by: 'human:editor' })]),
      ]),
      schema.node('paragraph', null, [
        schema.text('TC reject two.', [schema.marks.proofSuggestion.create({ id: rejectParagraphTwoId, kind: 'insert', by: 'human:editor' })]),
      ]),
    ]);

    const rejectState = EditorState.create({
      schema,
      doc: rejectLiveDoc,
      plugins: [marksStatePlugin],
    });
    const rejectLiveMetadata = getMarkMetadataWithQuotes(rejectState);
    const rejectPersistedMetadata = buildCanonicalShareMarkMetadata(rejectState, rejectLiveMetadata);
    const rejectMarkdown = 'Baseline.\n\nTC reject one.\n\nTC reject two.\n';
    const rejectSlug = `share-track-changes-reject-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(
      rejectSlug,
      rejectMarkdown,
      rejectPersistedMetadata as Record<string, StoredMark>,
      'Share track changes reject sibling insert regression',
    );

    const rejected = await executeDocumentOperationAsync(rejectSlug, 'POST', '/marks/reject', {
      markId: rejectParagraphTwoId,
      by: 'human:test',
    });
    assertEqual(rejected.status, 200, `Expected multi-paragraph reject to succeed, got ${rejected.status}`);
    const expectedRejectedMarkdown = 'Baseline.\n\n<span data-proof="suggestion" data-id="reject-paragraph-one" data-by="human:editor" data-kind="insert">TC reject one.</span>\n';
    assertEqual(
      String(rejected.body.markdown ?? ''),
      expectedRejectedMarkdown,
      `Expected rejecting one inserted paragraph to preserve the sibling pending insert paragraph in canonical markdown, got ${JSON.stringify(rejected.body.markdown)}`,
    );
    const rejectedMarks = (rejected.body.marks ?? {}) as Record<string, StoredMark>;
    assert(rejectParagraphOneId in rejectedMarks, 'Expected sibling pending insert metadata to survive after rejecting another paragraph insert');
    assert(!(rejectParagraphTwoId in rejectedMarks), 'Expected rejected insert metadata to be removed');
    const rejectedStored = db.getDocumentBySlug(rejectSlug);
    assertEqual(
      rejectedStored?.markdown,
      expectedRejectedMarkdown,
      `Expected rejecting one inserted paragraph to preserve the sibling pending insert paragraph in the canonical row, got ${JSON.stringify(rejectedStored?.markdown)}`,
    );
    const rejectedProjection = db.getDocumentProjectionBySlug(rejectSlug);
    assertEqual(
      rejectedProjection?.markdown,
      expectedRejectedMarkdown,
      `Expected rejecting one inserted paragraph to preserve the sibling pending insert paragraph in the projection row, got ${JSON.stringify(rejectedProjection?.markdown)}`,
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
