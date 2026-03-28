import assert from 'node:assert/strict';
import { Fragment, Schema, Slice } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';

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

let state = EditorState.create({
  schema,
  doc: schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('Alpha beta.')]),
  ]),
  plugins: [marksStatePlugin],
});

const wrappedParagraphPaste = new Slice(
  Fragment.from(schema.node('paragraph', null, [schema.text(' PASTE')])),
  1,
  1,
);

const rawPaste = state.tr.replaceSelection(wrappedParagraphPaste);
const wrappedPaste = wrapTransactionForSuggestions(rawPaste, state, true);
state = state.apply(wrappedPaste);

const insertMarks = getMarks(state).filter((mark) => mark.kind === 'insert');
assert.equal(wrappedPaste.getMeta('suggestions-wrapped'), true, 'Expected paragraph-wrapped paste to be tracked through the suggestions wrapper');
assert.equal(insertMarks.length, 1, 'Expected plain-text paste to create one insertion suggestion');
assert.equal(
  state.doc.textBetween(insertMarks[0]!.range!.from, insertMarks[0]!.range!.to, '\n', '\n'),
  ' PASTE',
  'Expected the inserted paste text to remain covered by the insertion suggestion',
);

console.log('✓ track changes wraps paragraph-shaped plain-text paste as an insertion suggestion');
