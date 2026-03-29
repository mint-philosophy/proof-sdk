import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';

import { marksPluginKey } from '../editor/plugins/marks.js';
import { __debugBuildDisabledInsertedSuggestionCleanupTransaction } from '../editor/plugins/suggestions.js';

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

function createState(doc: ReturnType<Schema['node']>): EditorState {
  return EditorState.create({
    schema,
    doc,
    plugins: [marksStatePlugin],
  });
}

function getTextNodeMarks(state: EditorState): Array<{ text: string; suggestionIds: string[] }> {
  const result: Array<{ text: string; suggestionIds: string[] }> = [];
  state.doc.descendants((node) => {
    if (!node.isText) return true;
    result.push({
      text: node.text ?? '',
      suggestionIds: node.marks
        .filter((mark) => mark.type.name === 'proofSuggestion')
        .map((mark) => String(mark.attrs.id ?? '')),
    });
    return true;
  });
  return result;
}

function run(): void {
  const existingInsertMark = schema.marks.proofSuggestion.create({
    id: 'existing-insert',
    kind: 'insert',
    by: 'human:editor',
  });

  const leakedInsertMark = schema.marks.proofSuggestion.create({
    id: 'existing-insert',
    kind: 'insert',
    by: 'human:editor',
  });

  const oldState = createState(schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('Alpha '),
      schema.text('BETA', [existingInsertMark]),
      schema.text(' delta '),
    ]),
  ]));

  let newState = createState(schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('Alpha '),
      schema.text('BETA', [existingInsertMark]),
      schema.text(' delta '),
      schema.text('GAMMA', [leakedInsertMark]),
    ]),
  ]));
  newState = newState.apply(newState.tr.setStoredMarks([leakedInsertMark]));

  const cleanupTr = __debugBuildDisabledInsertedSuggestionCleanupTransaction(oldState, newState);
  assert(cleanupTr, 'Expected disabled-mode cleanup to strip leaked suggestion marks from inserted plain text');

  const cleanedState = newState.apply(cleanupTr!);
  const textMarks = getTextNodeMarks(cleanedState);

  const betaRun = textMarks.find((entry) => entry.text === 'BETA');
  assert.deepEqual(betaRun?.suggestionIds, ['existing-insert'], 'Expected pre-existing tracked insert to remain intact');

  const gammaRun = textMarks.find((entry) => entry.text === 'GAMMA');
  assert.deepEqual(gammaRun?.suggestionIds ?? [], [], 'Expected Edit-mode inserted text to lose leaked suggestion marks');

  const finalStoredMarks = cleanedState.storedMarks ?? [];
  assert.equal(
    finalStoredMarks.some((mark) => mark.type.name === 'proofSuggestion'),
    false,
    'Expected disabled-mode cleanup to clear leaked proofSuggestion stored marks for subsequent typing',
  );

  console.log('suggestions-disabled-insert-cleanup-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
