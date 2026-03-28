import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';

import { marksPluginKey } from '../editor/plugins/marks.js';
import { __debugBuildAdjacentSplitInsertMergeTransaction } from '../editor/plugins/suggestions.js';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function run(): void {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'insert' },
          by: { default: 'unknown' },
          status: { default: 'pending' },
          content: { default: null },
          createdAt: { default: null },
          updatedAt: { default: null },
        },
        inclusive: false,
        spanning: true,
      },
      proofAuthored: {
        attrs: {
          by: { default: 'human:Anonymous' },
        },
        inclusive: true,
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
        return value;
      },
    },
  });

  const originalId = 'orig';
  const secondId = 'second';
  const baseState = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha beta gamma.'),
        schema.text('TC', [schema.marks.proofSuggestion.create({ id: originalId, kind: 'insert', by: 'unknown' })]),
        schema.text(' one', [schema.marks.proofSuggestion.create({ id: secondId, kind: 'insert', by: 'unknown' })]),
      ]),
    ]),
    plugins: [marksStatePlugin],
  });

  const fragmentedState = baseState.apply(baseState.tr.setMeta(marksPluginKey, {
    type: 'SET_METADATA',
    metadata: {
      [originalId]: {
        kind: 'insert',
        by: 'unknown',
        createdAt: new Date(Date.now() - 200).toISOString(),
        status: 'pending',
        content: 'TC',
        range: { from: 18, to: 20 },
      },
      [secondId]: {
        kind: 'insert',
        by: 'unknown',
        createdAt: new Date(Date.now() - 100).toISOString(),
        status: 'pending',
        content: ' one',
        range: { from: 20, to: 24 },
      },
    },
  }));

  const mergeTr = __debugBuildAdjacentSplitInsertMergeTransaction(fragmentedState, fragmentedState);
  if (!mergeTr) {
    throw new Error('Expected split-merge helper to heal adjacent insert fragments');
  }

  const healedState = fragmentedState.apply(mergeTr);
  const settledTr = __debugBuildAdjacentSplitInsertMergeTransaction(healedState, healedState);
  assertEqual(
    settledTr,
    null,
    'Expected split-merge helper to reach a fixed point after healing adjacent insert fragments',
  );

  console.log('suggestions-split-merge-fixed-point.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
