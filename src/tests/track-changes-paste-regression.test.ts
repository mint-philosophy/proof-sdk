import assert from 'node:assert/strict';
import { Fragment, Schema, Slice } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state';

import { getMarks, marksPluginKey } from '../editor/plugins/marks.js';
import {
  __debugBuildTrackedSuggestionPasteTransaction,
  wrapTransactionForSuggestions,
} from '../editor/plugins/suggestions.js';

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

const multilineBaseDoc = schema.node('doc', null, [
  schema.node('paragraph', null, [schema.text('Alpha beta.')]),
]);

state = EditorState.create({
  schema,
  doc: multilineBaseDoc,
  selection: TextSelection.create(multilineBaseDoc, 7, 11),
  plugins: [marksStatePlugin],
});

const multilinePaste = new Slice(
  Fragment.fromArray([
    schema.node('paragraph', null, [schema.text('very')]),
    schema.node('paragraph', null, [schema.text('old')]),
  ]),
  1,
  1,
);

const rawMultilinePaste = state.tr.replaceSelection(multilinePaste);
const wrappedMultilinePaste = wrapTransactionForSuggestions(rawMultilinePaste, state, true);
state = state.apply(wrappedMultilinePaste);

const deleteMarks = getMarks(state).filter((mark) => mark.kind === 'delete');
const multilineInsertMarks = getMarks(state).filter((mark) => mark.kind === 'insert');
const multilineInsertTexts = multilineInsertMarks
  .map((mark) => state.doc.textBetween(mark.range!.from, mark.range!.to, '\n', '\n'))
  .sort();

assert.equal(
  wrappedMultilinePaste.getMeta('suggestions-wrapped'),
  true,
  'Expected multiline plain-text paste to stay on the tracked suggestions path',
);
assert.equal(deleteMarks.length, 1, 'Expected multiline replacement paste to preserve the deleted selection as one delete suggestion');
assert.deepEqual(multilineInsertTexts, ['old', 'very'], 'Expected multiline paste to create tracked insertions for each pasted text segment');
assert.equal(
  state.doc.textBetween(deleteMarks[0]!.range!.from, deleteMarks[0]!.range!.to, '\n', '\n'),
  'beta',
  'Expected the overwritten word to remain visible under a delete suggestion after multiline paste',
);
assert.equal(
  state.doc.textBetween(0, state.doc.content.size, '\n', '\n'),
  'Alpha betavery\nold.',
  'Expected multiline paste to preserve paragraph structure while keeping the deleted word visible for review',
);

console.log('✓ track changes wraps multiline plain-text paste as tracked delete+insert suggestions');

const staleSelectionDoc = schema.node('doc', null, [
  schema.node('paragraph', null, [schema.text('Alpha beta gamma delta.')]),
]);

state = EditorState.create({
  schema,
  doc: staleSelectionDoc,
  selection: TextSelection.create(staleSelectionDoc, 18, 18),
  plugins: [marksStatePlugin],
});

const staleSelectionPaste = new Slice(
  Fragment.from(schema.node('paragraph', null, [schema.text('TWO')])),
  1,
  1,
);

const staleSelectionRawPaste = __debugBuildTrackedSuggestionPasteTransaction(
  state,
  staleSelectionPaste,
  { from: 7, to: 11 },
);

assert.ok(
  staleSelectionRawPaste,
  'Expected tracked paste helper to build a transaction when a live DOM selection range is provided',
);

const staleSelectionWrappedPaste = wrapTransactionForSuggestions(staleSelectionRawPaste!, state, true);
state = state.apply(staleSelectionWrappedPaste);

const staleSelectionDeleteMarks = getMarks(state).filter((mark) => mark.kind === 'delete');
const staleSelectionInsertMarks = getMarks(state).filter((mark) => mark.kind === 'insert');

assert.equal(
  staleSelectionDeleteMarks.length,
  1,
  'Expected stale PM selection paste replacement to preserve one delete suggestion for the live DOM-selected word',
);
assert.equal(
  staleSelectionInsertMarks.length,
  1,
  'Expected stale PM selection paste replacement to create one insert suggestion for the pasted text',
);
assert.equal(
  state.doc.textBetween(staleSelectionDeleteMarks[0]!.range!.from, staleSelectionDeleteMarks[0]!.range!.to, '\n', '\n'),
  'beta',
  'Expected the delete suggestion to still cover the live DOM-selected word rather than the stale PM cursor position',
);
assert.equal(
  state.doc.textBetween(staleSelectionInsertMarks[0]!.range!.from, staleSelectionInsertMarks[0]!.range!.to, '\n', '\n'),
  'TWO',
  'Expected the insert suggestion to cover the pasted replacement text when PM selection is stale',
);

console.log('✓ track changes paste uses the live DOM selection when PM selection is stale');
