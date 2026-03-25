import assert from 'node:assert/strict';
import { __markMutationSnapshotTargetsForTests } from '../../server/mark-mutation-snapshot-targets.js';

function run(): void {
  const payload = {
    markId: 'm-old',
    by: 'human:Anonymous',
    markdown: '# Untitled\n\nBaseline.\n\nTC one.\n\nTC two.\n',
    marks: {
      'm-healed': {
        kind: 'insert',
        by: 'human:Anonymous',
        status: 'pending',
        content: 'TC one.',
        quote: 'TC one.',
        range: { from: 20, to: 27 },
        startRel: 'char:20',
        endRel: 'char:27',
      },
      'm-two': {
        kind: 'insert',
        by: 'human:Anonymous',
        status: 'pending',
        content: 'TC two.',
        quote: 'TC two.',
        range: { from: 29, to: 36 },
        startRel: 'char:29',
        endRel: 'char:36',
      },
    },
  };

  const contextMarks = {
    'm-old': {
      kind: 'insert',
      by: 'human:Anonymous',
      status: 'pending',
      content: 'TC',
      quote: 'TC',
      range: { from: 24, to: 24 },
      startRel: 'char:20',
      endRel: 'char:22',
    },
    'm-two': {
      kind: 'insert',
      by: 'human:Anonymous',
      status: 'pending',
      content: 'TC two.',
      quote: 'TC two.',
      range: { from: 31, to: 31 },
      startRel: 'char:28',
      endRel: 'char:35',
    },
  };

  const rewritten = __markMutationSnapshotTargetsForTests.rewriteMarkMutationPayloadSnapshotTargets(payload, contextMarks);
  assert.equal(rewritten.markId, 'm-healed', 'Expected stale split reject target to remap onto the healed snapshot mark');

  const unchanged = __markMutationSnapshotTargetsForTests.rewriteMarkMutationPayloadSnapshotTargets(
    {
      ...payload,
      markId: 'm-healed',
    },
    contextMarks,
  );
  assert.equal(unchanged.markId, 'm-healed', 'Expected an already-current snapshot target to remain unchanged');

  const noCrossParagraphRewrite = __markMutationSnapshotTargetsForTests.rewriteMarkMutationPayloadSnapshotTargets(
    payload,
    {
      'm-old': {
        kind: 'insert',
        by: 'human:Anonymous',
        status: 'pending',
        content: 'Different opening',
        quote: 'Different opening',
        range: { from: 5, to: 5 },
        startRel: 'char:5',
        endRel: 'char:22',
      },
    },
  );
  assert.equal(
    noCrossParagraphRewrite.markId,
    'm-old',
    'Expected snapshot target rewrite to refuse unrelated pending suggestions',
  );

  console.log('mark-mutation-snapshot-targets.test.ts passed');
}

run();
