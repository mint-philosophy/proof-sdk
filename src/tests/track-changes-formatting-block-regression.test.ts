import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';

import {
  getBlockedTrackChangesMarkMutation,
  wrapTransactionForSuggestions,
} from '../editor/plugins/suggestions.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
  },
  marks: {
    strong: {
      parseDOM: [{ tag: 'strong' }],
      toDOM: () => ['strong', 0],
    },
    em: {
      parseDOM: [{ tag: 'em' }],
      toDOM: () => ['em', 0],
    },
    proofSuggestion: {
      attrs: {
        id: { default: null },
        kind: { default: 'insert' },
        by: { default: 'unknown' },
      },
      inclusive: false,
      spanning: true,
    },
  },
});

function createState(
  text: string,
  selection: { from: number; to: number },
  storedMarks: EditorState['storedMarks'] = null,
): EditorState {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text(text)]),
  ]);

  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, selection.from, selection.to),
    storedMarks,
  });
}

function run(): void {
  const rangeState = createState('carefully designed', { from: 1, to: 10 });
  const boldTr = rangeState.tr.addMark(1, 10, schema.marks.strong.create());
  const blockedBold = getBlockedTrackChangesMarkMutation(boldTr, rangeState);
  assert.deepEqual(
    blockedBold,
    {
      reason: 'mark-step',
      markNames: ['strong'],
      stepTypes: ['addMark'],
    },
    'Expected selected-text bold formatting to be classified as an unsupported TC mark mutation',
  );

  const wrappedBold = wrapTransactionForSuggestions(boldTr, rangeState, true);
  assert.equal(wrappedBold.docChanged, false, 'Expected TC formatting wrapper to convert pure formatting mutations into a no-op');
  assert.equal(wrappedBold.steps.length, 0, 'Expected blocked formatting changes to dispatch no document steps');
  const afterBold = rangeState.apply(wrappedBold);
  assert.equal(
    afterBold.doc.textBetween(0, afterBold.doc.content.size, '\n', '\n'),
    'carefully designed',
    'Expected blocked formatting changes to leave the document text untouched',
  );
  assert.equal(
    afterBold.doc.rangeHasMark(1, 10, schema.marks.strong),
    false,
    'Expected blocked formatting changes not to apply bold markup under TC',
  );

  const proofSuggestionTr = rangeState.tr.addMark(1, 4, schema.marks.proofSuggestion.create({
    id: 'suggestion-1',
    kind: 'delete',
    by: 'human:user',
  }));
  assert.equal(
    getBlockedTrackChangesMarkMutation(proofSuggestionTr, rangeState),
    null,
    'Expected proofSuggestion mark mutations to remain allowed for internal TC flows',
  );

  const cursorState = createState('carefully designed', { from: 5, to: 5 });
  const storedBoldTr = cursorState.tr.addStoredMark(schema.marks.strong.create());
  const blockedStoredBold = getBlockedTrackChangesMarkMutation(storedBoldTr, cursorState);
  assert.deepEqual(
    blockedStoredBold,
    {
      reason: 'stored-mark-toggle',
      markNames: ['strong'],
      stepTypes: [],
    },
    'Expected cursor-level bold toggles to be blocked so future typed text cannot inherit untracked formatting',
  );

  const cursorBoldState = createState('carefully designed', { from: 5, to: 5 }, [schema.marks.strong.create()]);
  const storedBoldOffTr = cursorBoldState.tr.removeStoredMark(schema.marks.strong);
  const blockedStoredBoldOff = getBlockedTrackChangesMarkMutation(storedBoldOffTr, cursorBoldState);
  assert.deepEqual(
    blockedStoredBoldOff,
    {
      reason: 'stored-mark-toggle',
      markNames: ['strong'],
      stepTypes: [],
    },
    'Expected cursor-level bold removal toggles to be blocked under TC as well',
  );

  console.log('track-changes-formatting-block-regression.test.ts passed');
}

run();
