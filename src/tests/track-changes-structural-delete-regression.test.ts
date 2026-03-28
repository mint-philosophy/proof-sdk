import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state';

import { getMarks, marksPluginKey } from '../editor/plugins/marks.js';
import { wrapTransactionForSuggestions } from '../editor/plugins/suggestions.js';

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
      return value;
    },
  },
});

function run(): void {
  const existingDeleteId = 'existing-delete';
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('She had three reports and '),
      schema.text('top.', [schema.marks.proofSuggestion.create({
        id: existingDeleteId,
        kind: 'delete',
        by: 'human:user',
      })]),
    ]),
    schema.node('paragraph', null, [schema.text('Next para.')]),
  ]);

  const selectionFrom = 1;
  const selectionTo = doc.child(0).nodeSize - 1;

  let state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, selectionFrom, selectionTo),
    plugins: [marksStatePlugin],
  });

  state = state.apply(state.tr.setMeta(marksPluginKey, {
    type: 'SET_METADATA',
    metadata: {
      [existingDeleteId]: {
        kind: 'delete',
        by: 'human:user',
        createdAt: '2026-03-28T00:00:00.000Z',
        status: 'pending',
        quote: 'top.',
        range: { from: 27, to: 31 },
      },
    },
  }));

  const wrapped = wrapTransactionForSuggestions(
    state.tr.delete(selectionFrom, selectionTo),
    state,
    true,
  );
  state = state.apply(wrapped);

  const deleteMarks = getMarks(state).filter((mark) => mark.kind === 'delete');
  assert.equal(
    state.doc.textBetween(0, state.doc.content.size, '\n', '\n'),
    'She had three reports and top.\nNext para.',
    'Expected full-paragraph tracked deletion to preserve visible paragraph text instead of collapsing to an empty shell',
  );
  assert.equal(
    deleteMarks.some((mark) => mark.id === existingDeleteId),
    true,
    'Expected full-paragraph tracked deletion to preserve existing delete marks inside the selected paragraph',
  );
  assert.equal(
    deleteMarks.length,
    2,
    'Expected full-paragraph tracked deletion to add one new delete mark for the plain text and preserve the existing delete mark',
  );

  console.log('✓ track changes preserves mixed plain+delete paragraph selections');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
