import assert from 'node:assert/strict';
import { __agentRoutesMarkMutationSnapshotForTests } from '../../server/agent-routes.js';

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
  assert.deepEqual(
    JSON.parse(overlaid.doc.marks),
    snapshotMarks,
    'Expected snapshot overlay to replace the mutation marks with the client snapshot marks',
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

  console.log('agent-routes-mark-mutation-snapshot-overlay.test.ts passed');
}

run();
