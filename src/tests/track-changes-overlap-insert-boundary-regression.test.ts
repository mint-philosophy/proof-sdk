import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection, type Transaction } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

import { setCurrentActor } from '../editor/actor';
import { getMarks, marksPluginKey } from '../editor/plugins/marks';
import {
  __debugResolveLatestPendingSuggestionUndoMarkIds,
  __debugUndoLatestPendingSuggestionEdit,
  wrapTransactionForSuggestions,
} from '../editor/plugins/suggestions';
import type { StoredMark } from '../formats/marks';

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
        kind: { default: 'insert' },
        by: { default: 'unknown' },
        quote: { default: null },
        content: { default: null },
        createdAt: { default: null },
        status: { default: 'pending' },
      },
      inclusive: false,
      spanning: true,
      parseDOM: [],
      toDOM(mark) {
        return ['span', { 'data-proof': 'suggestion', 'data-id': mark.attrs.id, 'data-kind': mark.attrs.kind }, 0];
      },
    },
  },
});

const marksStatePlugin = new Plugin({
  key: marksPluginKey,
  state: {
    init: () => ({ metadata: {}, activeMarkId: null, composeAnchorRange: null }),
    apply: (tr, value) => {
      const meta = tr.getMeta(marksPluginKey) as
        | { type?: string; metadata?: Record<string, StoredMark> }
        | undefined;
      if (meta?.type === 'SET_METADATA') {
        return {
          ...value,
          metadata: meta.metadata ?? {},
        };
      }
      return value;
    },
  },
});

type MutableEditorView = EditorView & { state: EditorState };

function createView(state: EditorState): MutableEditorView {
  return {
    state,
    dispatch(tr: Transaction) {
      this.state = this.state.apply(tr);
    },
  } as unknown as MutableEditorView;
}

function run(): void {
  setCurrentActor('human:user');

  const baseText = 'The study recruited participants from multiple sites.';
  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(baseText)]),
    ]),
    plugins: [marksStatePlugin],
  });

  const recruitedStart = baseText.indexOf('recruited') + 1;
  const recruitedEnd = recruitedStart + 'recruited'.length;
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, recruitedStart, recruitedEnd)),
  );
  state = state.apply(
    wrapTransactionForSuggestions(
      state.tr.insertText('enrolled', recruitedStart, recruitedEnd),
      state,
      true,
    ),
  );

  const initialDeleteMarks = getMarks(state).filter((mark) => mark.kind === 'delete');
  const initialInsertMarks = getMarks(state).filter((mark) => mark.kind === 'insert');
  assert.equal(initialDeleteMarks.length, 1, 'Expected first replacement to create one delete mark');
  assert.equal(initialInsertMarks.length, 1, 'Expected first replacement to create one insert mark');

  const enrolledInsert = initialInsertMarks[0]!;
  assert.ok(enrolledInsert.range, 'Expected the first replacement insert to expose a live range');
  const overlapFrom = enrolledInsert.range!.from;
  const overlapTo = overlapFrom + 'enrolled participa'.length;
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, overlapFrom, overlapTo)),
  );
  state = state.apply(
    wrapTransactionForSuggestions(
      state.tr.insertText('included volunt', overlapFrom, overlapTo),
      state,
      true,
    ),
  );

  const marksAfterOverlap = getMarks(state);
  const deleteMarksAfterOverlap = marksAfterOverlap.filter((mark) => mark.kind === 'delete');
  const insertMarksAfterOverlap = marksAfterOverlap.filter((mark) => mark.kind === 'insert');
  assert.equal(insertMarksAfterOverlap.length, 1, 'Expected overlap replacement to leave one current insert suggestion instead of accumulating insert-only corruption');
  assert.ok(deleteMarksAfterOverlap.length >= 2, 'Expected overlap replacement to preserve a delete mark for the overwritten original text instead of silently dropping it');
  assert.ok(
    state.doc.textBetween(0, state.doc.content.size, '\n', '\n').includes('participa'),
    'Expected the overwritten plain-text tail to remain visible under a delete suggestion before review',
  );

  const latestUndoGroupIds = __debugResolveLatestPendingSuggestionUndoMarkIds(state);
  assert.ok(latestUndoGroupIds.length >= 2, 'Expected the newest overlap replacement to resolve as a grouped replacement suggestion');

  const view = createView(state);
  assert.equal(__debugUndoLatestPendingSuggestionEdit(view), true, 'Expected rejecting the newest overlap replacement group to succeed');
  const textAfterReject = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n');
  assert.ok(
    textAfterReject.includes('participants'),
    'Expected rejecting the overlap replacement to preserve the original participant text instead of losing it',
  );
  assert.equal(getMarks(view.state).filter((mark) => mark.kind === 'insert').length, 0, 'Expected overlap rejection to clear the latest insert suggestion');
  assert.equal(getMarks(view.state).filter((mark) => mark.kind === 'delete').length, 1, 'Expected overlap rejection to leave only the original pending delete suggestion');

  console.log('✓ track changes preserves original text when a replacement overlaps an existing insert boundary');
}

run();
