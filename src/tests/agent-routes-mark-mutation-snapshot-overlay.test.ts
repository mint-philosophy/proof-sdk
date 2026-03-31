import assert from 'node:assert/strict';
import { __agentRoutesMarkMutationSnapshotForTests } from '../../server/agent-routes.js';
import { normalizeStoredMarksAgainstMarkdown } from '../../server/mark-anchor-normalization.js';

function run(): void {
  const normalizedAuthoritative = __agentRoutesMarkMutationSnapshotForTests.normalizeBatchMutationSnapshotMarkdown(
    '# Untitled\n\nBaseline.\n\n\n\nTC two.\n',
  );
  const normalizedSnapshot = __agentRoutesMarkMutationSnapshotForTests.normalizeBatchMutationSnapshotMarkdown(
    '# Untitled\n\nBaseline.\n\nTC two.\n',
  );
  assert.equal(
    normalizedAuthoritative,
    normalizedSnapshot,
    'Expected visible-text normalization to treat structurally equivalent blank-paragraph variants as equal',
  );

  const snapshotMarks = {
    'm-second': {
      kind: 'insert',
      by: 'human:Anonymous',
      createdAt: '2026-03-25T16:28:54.032Z',
      status: 'pending',
      content: 'TC two.',
      range: { from: 22, to: 22 },
      startRel: 'char:19',
      endRel: 'char:26',
      quote: 'TC two.',
    },
  };

  const context = {
    doc: {
      markdown: '# Untitled\n\nBaseline.\n\n\n\nTC two.\n',
      marks: JSON.stringify({
        'm-second': {
          kind: 'insert',
          by: 'human:Anonymous',
          createdAt: '2026-03-25T16:28:54.032Z',
          status: 'pending',
          content: 'TC two.',
          range: { from: 24, to: 31 },
          startRel: 'char:20',
          endRel: 'char:27',
          quote: 'TC two.',
        },
      }),
      plain_text: '# Untitled\n\nBaseline.\n\n\n\nTC two.\n',
      read_source: 'projection',
    },
    mutationBase: {
      token: 'mt1:test',
      source: 'live_yjs',
      schemaVersion: 'mt1',
      markdown: '# Untitled\n\nBaseline.\n\n\n\nTC two.\n',
      marks: {
        'm-second': {
          kind: 'insert',
          by: 'human:Anonymous',
          createdAt: '2026-03-25T16:28:54.032Z',
          status: 'pending',
          content: 'TC two.',
          range: { from: 24, to: 31 },
          startRel: 'char:20',
          endRel: 'char:27',
          quote: 'TC two.',
        },
      },
    },
  } as any;

  const overlaid = __agentRoutesMarkMutationSnapshotForTests.overlayMarkMutationPayloadSnapshot(
    context,
    {
      markId: 'm-second',
      markdown: '# Untitled\n\nBaseline.\n\nTC two.\n',
      marks: snapshotMarks,
    },
  );
  assert.equal(
    overlaid.doc.markdown,
    '# Untitled\n\nBaseline.\n\nTC two.\n',
    'Expected snapshot overlay to accept equivalent visible text and replace the mutation markdown',
  );
  assert.equal(
    overlaid.preserveMutationBaseDocument,
    true,
    'Expected snapshot overlay to mark the mutation context so async hydration preserves the client snapshot markdown',
  );
  const expectedSnapshotMarks = normalizeStoredMarksAgainstMarkdown(
    '# Untitled\n\nBaseline.\n\nTC two.\n',
    snapshotMarks as any,
  );
  assert.deepEqual(
    JSON.parse(overlaid.doc.marks),
    expectedSnapshotMarks,
    'Expected snapshot overlay to replace the mutation marks with the normalized client snapshot marks',
  );

  const unchanged = __agentRoutesMarkMutationSnapshotForTests.overlayMarkMutationPayloadSnapshot(
    context,
    {
      markId: 'm-second',
      markdown: '# Untitled\n\nBaseline changed.\n\nTC two.\n',
      marks: snapshotMarks,
    },
  );
  assert.equal(
    unchanged.doc.markdown,
    context.doc.markdown,
    'Expected snapshot overlay to refuse snapshots whose visible text actually differs',
  );

  const acceptRaceAuthoritativeMarkdown = [
    'words ',
    '<span data-proof="suggestion" data-id="m-alpha-delete" data-kind="delete">alpha</span>',
    '<span data-proof="suggestion" data-id="m-alpha-insert" data-kind="insert">A1</span>',
    ' bravo charlie end.',
  ].join('');
  const acceptRaceAuthoritativeMarks = {
    'm-alpha-delete': {
      kind: 'delete',
      by: 'human:Anonymous',
      createdAt: '2026-03-29T18:05:00.000Z',
      status: 'pending',
      quote: 'alpha',
      range: { from: 6, to: 11 },
      startRel: 'char:6',
      endRel: 'char:11',
    },
    'm-alpha-insert': {
      kind: 'insert',
      by: 'human:Anonymous',
      createdAt: '2026-03-29T18:05:00.000Z',
      status: 'pending',
      content: 'A1',
      quote: 'A1',
      range: { from: 11, to: 13 },
      startRel: 'char:11',
      endRel: 'char:13',
    },
  };
  const acceptRaceSnapshotMarkdown = [
    'words A1 ',
    '<span data-proof="suggestion" data-id="m-bravo-delete" data-kind="delete">bravo</span>',
    '<span data-proof="suggestion" data-id="m-bravo-insert" data-kind="insert">B2</span>',
    ' charlie end.',
  ].join('');
  const acceptRaceSnapshotMarks = {
    'm-bravo-delete': {
      kind: 'delete',
      by: 'human:Anonymous',
      createdAt: '2026-03-29T18:05:01.000Z',
      status: 'pending',
      quote: 'bravo',
      range: { from: 9, to: 14 },
      startRel: 'char:9',
      endRel: 'char:14',
    },
    'm-bravo-insert': {
      kind: 'insert',
      by: 'human:Anonymous',
      createdAt: '2026-03-29T18:05:01.000Z',
      status: 'pending',
      content: 'B2',
      quote: 'B2',
      range: { from: 14, to: 16 },
      startRel: 'char:14',
      endRel: 'char:16',
    },
  };
  const acceptRaceContext = {
    doc: {
      markdown: acceptRaceAuthoritativeMarkdown,
      marks: JSON.stringify(acceptRaceAuthoritativeMarks),
      plain_text: acceptRaceAuthoritativeMarkdown,
      read_source: 'projection',
    },
    mutationBase: {
      token: 'mt1:accept-race-window',
      source: 'live_yjs',
      schemaVersion: 'mt1',
      markdown: acceptRaceAuthoritativeMarkdown,
      marks: acceptRaceAuthoritativeMarks,
    },
  } as any;

  const overlaidAcceptRace = __agentRoutesMarkMutationSnapshotForTests.overlayMarkMutationPayloadSnapshot(
    acceptRaceContext,
    {
      markIds: ['m-alpha-delete', 'm-alpha-insert', 'm-bravo-delete', 'm-bravo-insert'],
      markdown: acceptRaceSnapshotMarkdown,
      marks: acceptRaceSnapshotMarks,
    },
  );
  assert.equal(
    overlaidAcceptRace.doc.markdown,
    acceptRaceSnapshotMarkdown,
    'Expected overlay admission to keep edits made during the accept reconnect window even when the batch request still carries stale accepted mark ids from the server cache',
  );
  assert.deepEqual(
    JSON.parse(overlaidAcceptRace.doc.marks),
    normalizeStoredMarksAgainstMarkdown(
      acceptRaceSnapshotMarkdown,
      acceptRaceSnapshotMarks as any,
    ),
    'Expected accept-reconnect overlay admission to preserve only the newer pending replacement pair from the local snapshot',
  );

  const replacementPairSnapshotMarkdown = [
    'words A B ',
    '<span data-proof="suggestion" data-id="m-charlie-delete" data-kind="delete">charlie</span>',
    '<span data-proof="suggestion" data-id="m-charlie-insert" data-kind="insert">C</span>',
    ' ',
    '<span data-proof="suggestion" data-id="m-delta-delete" data-kind="delete">delta</span>',
    '<span data-proof="suggestion" data-id="m-delta-insert" data-kind="insert">D</span>',
    ' end.',
  ].join('');
  const replacementPairSnapshotMarks = {
    'm-charlie-delete': {
      kind: 'delete',
      by: 'human:Anonymous',
      createdAt: '2026-03-29T18:00:00.000Z',
      status: 'pending',
      quote: 'charlie',
      range: { from: 10, to: 17 },
      startRel: 'char:10',
      endRel: 'char:17',
    },
    'm-charlie-insert': {
      kind: 'insert',
      by: 'human:Anonymous',
      createdAt: '2026-03-29T18:00:00.000Z',
      status: 'pending',
      content: 'C',
      quote: 'C',
      range: { from: 17, to: 18 },
      startRel: 'char:17',
      endRel: 'char:18',
    },
    'm-delta-delete': {
      kind: 'delete',
      by: 'human:Anonymous',
      createdAt: '2026-03-29T18:00:01.000Z',
      status: 'pending',
      quote: 'delta',
      range: { from: 19, to: 24 },
      startRel: 'char:19',
      endRel: 'char:24',
    },
    'm-delta-insert': {
      kind: 'insert',
      by: 'human:Anonymous',
      createdAt: '2026-03-29T18:00:01.000Z',
      status: 'pending',
      content: 'D',
      quote: 'D',
      range: { from: 24, to: 25 },
      startRel: 'char:24',
      endRel: 'char:25',
    },
  };
  const replacementPairContext = {
    doc: {
      markdown: 'words A B charlie delta end.',
      marks: JSON.stringify({}),
      plain_text: 'words A B charlie delta end.',
      read_source: 'projection',
    },
    mutationBase: {
      token: 'mt1:replacement-pair-test',
      source: 'live_yjs',
      schemaVersion: 'mt1',
      markdown: 'words A B charlie delta end.',
      marks: {},
    },
  } as any;

  const overlaidReplacementBatch = __agentRoutesMarkMutationSnapshotForTests.overlayMarkMutationPayloadSnapshot(
    replacementPairContext,
    {
      markIds: [
        'm-charlie-delete',
        'm-charlie-insert',
        'm-delta-delete',
        'm-delta-insert',
      ],
      markdown: replacementPairSnapshotMarkdown,
      marks: replacementPairSnapshotMarks,
    },
  );
  assert.equal(
    overlaidReplacementBatch.doc.markdown,
    replacementPairSnapshotMarkdown,
    'Expected batch snapshot overlay to preserve local replacement-pair markup even when the authoritative visible text is still stale',
  );
  assert.equal(
    overlaidReplacementBatch.preserveMutationBaseDocument,
    true,
    'Expected batch replacement-pair overlay to preserve the client snapshot as the mutation base document',
  );
  assert.deepEqual(
    JSON.parse(overlaidReplacementBatch.doc.marks),
    normalizeStoredMarksAgainstMarkdown(
      replacementPairSnapshotMarkdown,
      replacementPairSnapshotMarks as any,
    ),
    'Expected batch replacement-pair overlay to normalize and preserve the local snapshot marks for accept-all',
  );

  const mixedSequenceAuthoritativeMarkdown = [
    'words ',
    '<span data-proof="suggestion" data-id="m-alpha-delete" data-kind="delete">alpha</span>',
    '<span data-proof="suggestion" data-id="m-alpha-insert" data-kind="insert">A</span>',
    ' ',
    '<span data-proof="suggestion" data-id="m-bravo-delete" data-kind="delete">bravo</span>',
    '<span data-proof="suggestion" data-id="m-bravo-insert" data-kind="insert">B</span>',
    ' end.',
  ].join('');
  const mixedSequenceAuthoritativeMarks = {
    'm-alpha-delete': {
      kind: 'delete',
      by: 'human:Anonymous',
      createdAt: '2026-03-29T18:10:00.000Z',
      status: 'pending',
      quote: 'alpha',
      range: { from: 6, to: 11 },
      startRel: 'char:6',
      endRel: 'char:11',
    },
    'm-alpha-insert': {
      kind: 'insert',
      by: 'human:Anonymous',
      createdAt: '2026-03-29T18:10:00.000Z',
      status: 'pending',
      content: 'A',
      quote: 'A',
      range: { from: 11, to: 12 },
      startRel: 'char:11',
      endRel: 'char:12',
    },
    'm-bravo-delete': {
      kind: 'delete',
      by: 'human:Anonymous',
      createdAt: '2026-03-29T18:10:01.000Z',
      status: 'pending',
      quote: 'bravo',
      range: { from: 13, to: 18 },
      startRel: 'char:13',
      endRel: 'char:18',
    },
    'm-bravo-insert': {
      kind: 'insert',
      by: 'human:Anonymous',
      createdAt: '2026-03-29T18:10:01.000Z',
      status: 'pending',
      content: 'B',
      quote: 'B',
      range: { from: 18, to: 19 },
      startRel: 'char:18',
      endRel: 'char:19',
    },
  };
  const mixedSequenceSnapshotMarkdown = [
    'words alpha ',
    '<span data-proof="suggestion" data-id="m-bravo-delete" data-kind="delete">bravo</span>',
    '<span data-proof="suggestion" data-id="m-bravo-insert" data-kind="insert">B</span>',
    ' end.',
  ].join('');
  const mixedSequenceSnapshotMarks = {
    'm-bravo-delete': mixedSequenceAuthoritativeMarks['m-bravo-delete'],
    'm-bravo-insert': mixedSequenceAuthoritativeMarks['m-bravo-insert'],
  };
  const mixedSequenceContext = {
    doc: {
      markdown: mixedSequenceAuthoritativeMarkdown,
      marks: JSON.stringify(mixedSequenceAuthoritativeMarks),
      plain_text: mixedSequenceAuthoritativeMarkdown,
      read_source: 'projection',
    },
    mutationBase: {
      token: 'mt1:mixed-sequence-test',
      source: 'live_yjs',
      schemaVersion: 'mt1',
      markdown: mixedSequenceAuthoritativeMarkdown,
      marks: mixedSequenceAuthoritativeMarks,
    },
  } as any;

  const overlaidMixedSequence = __agentRoutesMarkMutationSnapshotForTests.overlayMarkMutationPayloadSnapshot(
    mixedSequenceContext,
    {
      markId: 'm-bravo-delete',
      markdown: mixedSequenceSnapshotMarkdown,
      marks: mixedSequenceSnapshotMarks,
    },
  );
  assert.equal(
    overlaidMixedSequence.doc.markdown,
    mixedSequenceSnapshotMarkdown,
    'Expected overlay admission to keep a newer snapshot after a prior reject removes a different pending insert from the server-visible state',
  );
  assert.deepEqual(
    JSON.parse(overlaidMixedSequence.doc.marks),
    normalizeStoredMarksAgainstMarkdown(
      mixedSequenceSnapshotMarkdown,
      mixedSequenceSnapshotMarks as any,
    ),
    'Expected mixed-sequence overlay admission to preserve the newer snapshot marks for the follow-up review action',
  );

  const postRejectAuthoritativeMarkdown = 'words target end.';
  const postRejectSnapshotMarkdown = 'words targetSECOND end.';
  const postRejectSnapshotMarks = {
    'm-target-delete-second': {
      kind: 'delete',
      by: 'human:Anonymous',
      createdAt: '2026-03-29T19:10:00.000Z',
      status: 'pending',
      quote: 'target',
      range: { from: 6, to: 12 },
      startRel: 'char:6',
      endRel: 'char:12',
    },
    'm-target-insert-second': {
      kind: 'insert',
      by: 'human:Anonymous',
      createdAt: '2026-03-29T19:10:00.000Z',
      status: 'pending',
      content: 'SECOND',
      quote: 'SECOND',
      range: { from: 12, to: 18 },
      startRel: 'char:12',
      endRel: 'char:18',
    },
  };
  const postRejectContext = {
    doc: {
      markdown: postRejectAuthoritativeMarkdown,
      marks: JSON.stringify({}),
      plain_text: postRejectAuthoritativeMarkdown,
      read_source: 'projection',
    },
    mutationBase: {
      token: 'mt1:post-reject-same-word',
      source: 'live_yjs',
      schemaVersion: 'mt1',
      markdown: postRejectAuthoritativeMarkdown,
      marks: {},
    },
  } as any;

  const overlaidPostReject = __agentRoutesMarkMutationSnapshotForTests.overlayMarkMutationPayloadSnapshot(
    postRejectContext,
    {
      markIds: ['m-target-delete-second', 'm-target-insert-second'],
      markdown: postRejectSnapshotMarkdown,
      marks: postRejectSnapshotMarks,
    },
  );
  assert.equal(
    overlaidPostReject.doc.markdown,
    postRejectSnapshotMarkdown,
    'Expected overlay admission to keep the post-reject same-word re-edit snapshot when Accept All runs before the server has seen the new replacement pair',
  );
  assert.deepEqual(
    JSON.parse(overlaidPostReject.doc.marks),
    normalizeStoredMarksAgainstMarkdown(
      postRejectSnapshotMarkdown,
      postRejectSnapshotMarks as any,
    ),
    'Expected post-reject same-word overlay admission to preserve the pending replacement-pair marks from the local snapshot',
  );

  const selectAllAuthoritativeMarkdown = 'Alpha beta.\nGamma delta.\n';
  const selectAllSnapshotMarkdown = [
    '<span data-proof="suggestion" data-id="m-select-all-delete" data-kind="delete">Alpha beta.\nGamma delta.</span>',
    '<span data-proof="suggestion" data-id="m-select-all-insert" data-kind="insert">REPLACED</span>',
  ].join('\n');
  const selectAllSnapshotMarks = {
    'm-select-all-delete': {
      kind: 'delete',
      by: 'human:user',
      createdAt: '2026-03-30T20:00:00.000Z',
      status: 'pending',
      quote: 'Alpha beta. Gamma delta.',
      range: { from: 1, to: 26 },
      startRel: 'char:0',
      endRel: 'char:24',
    },
    'm-select-all-insert': {
      kind: 'insert',
      by: 'human:user',
      createdAt: '2026-03-30T20:00:00.000Z',
      status: 'pending',
      content: 'REPLACED',
      quote: 'REPLACED',
      range: { from: 28, to: 28 },
      startRel: 'char:25',
      endRel: 'char:33',
    },
  };
  const selectAllContext = {
    doc: {
      markdown: selectAllAuthoritativeMarkdown,
      marks: JSON.stringify({}),
      plain_text: selectAllAuthoritativeMarkdown,
      read_source: 'projection',
    },
    mutationBase: {
      token: 'mt1:select-all-snapshot',
      source: 'live_yjs',
      schemaVersion: 'mt1',
      markdown: selectAllAuthoritativeMarkdown,
      marks: {},
    },
  } as any;

  const overlaidSelectAll = __agentRoutesMarkMutationSnapshotForTests.overlayMarkMutationPayloadSnapshot(
    selectAllContext,
    {
      markIds: ['m-select-all-delete', 'm-select-all-insert'],
      markdown: selectAllSnapshotMarkdown,
      marks: selectAllSnapshotMarks,
    },
  );
  assert.equal(
    overlaidSelectAll.doc.markdown,
    selectAllSnapshotMarkdown,
    'Expected overlay admission to preserve a whole-document replacement snapshot for accept-all',
  );
  assert.deepEqual(
    JSON.parse(overlaidSelectAll.doc.marks),
    normalizeStoredMarksAgainstMarkdown(
      selectAllSnapshotMarkdown,
      selectAllSnapshotMarks as any,
    ),
    'Expected whole-document replacement overlay admission to preserve the normalized local snapshot marks for accept-all',
  );

  console.log('agent-routes-mark-mutation-snapshot-overlay.test.ts passed');
}

run();
