import assert from 'node:assert/strict';
import { Fragment, Schema, Slice } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection, type Transaction } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

import { setCurrentActor } from '../editor/actor';
import { getMarks, marksPluginKey } from '../editor/plugins/marks';
import {
  __debugBuildTrackedSuggestionPasteTransaction,
  __debugResolveLatestPendingSuggestionUndoMarkIds,
  __debugUndoLatestPendingSuggestionEdit,
  wrapTransactionForSuggestions,
} from '../editor/plugins/suggestions';
import type { StoredMark } from '../formats/marks';

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

function createState(docText: string): EditorState {
  return EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(docText)]),
    ]),
    plugins: [marksStatePlugin],
  });
}

function createMockView(state: EditorState): MutableEditorView {
  return {
    state,
    dispatch(tr: Transaction) {
      this.state = this.state.apply(tr);
    },
  } as unknown as MutableEditorView;
}

function updateCreatedAt(state: EditorState, markIds: readonly string[], createdAt: string): EditorState {
  const pluginState = marksPluginKey.getState(state) as { metadata?: Record<string, StoredMark> } | undefined;
  const metadata = { ...(pluginState?.metadata ?? {}) };
  for (const markId of markIds) {
    if (!metadata[markId]) continue;
    metadata[markId] = {
      ...metadata[markId],
      createdAt,
    };
  }
  return state.apply(state.tr.setMeta(marksPluginKey, {
    type: 'SET_METADATA',
    metadata,
  }));
}

function run(): void {
  setCurrentActor('human:user');

  const originalParagraph = 'The control arm demonstrated acceptable compliance throughout all measurement timepoints.';
  const replacementParagraph = 'The intervention arm sustained adherence across the entire follow-up interval.';
  let state = createState(originalParagraph);
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, 1, 1 + originalParagraph.length)),
  );
  state = state.apply(
    wrapTransactionForSuggestions(
      state.tr.insertText(replacementParagraph, 1, 1 + originalParagraph.length),
      state,
      true,
    ),
  );

  const paragraphReplacementUndoIds = __debugResolveLatestPendingSuggestionUndoMarkIds(state);
  assert.equal(paragraphReplacementUndoIds.length, 2, 'Expected full-paragraph tracked replacement to resolve one undo group containing both insert and delete marks');
  assert.equal(getMarks(state).filter((mark) => mark.kind === 'insert').length, 1, 'Expected full-paragraph replacement to create one insert mark');
  assert.equal(getMarks(state).filter((mark) => mark.kind === 'delete').length, 1, 'Expected full-paragraph replacement to create one delete mark');

  let view = createMockView(state);
  assert.equal(__debugUndoLatestPendingSuggestionEdit(view), true, 'Expected TC undo fallback to handle full-paragraph tracked replacement');
  assert.equal(view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n'), originalParagraph, 'Expected TC undo fallback to restore the original full paragraph');
  assert.equal(getMarks(view.state).length, 0, 'Expected TC undo fallback to clear both replacement marks');

  const cutPasteOriginal = 'Alpha beta gamma.';
  state = createState(cutPasteOriginal);
  const cutFrom = cutPasteOriginal.indexOf('beta') + 1;
  const cutTo = cutFrom + 'beta'.length;
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, cutFrom, cutTo)),
  );
  state = state.apply(
    wrapTransactionForSuggestions(state.tr.delete(cutFrom, cutTo), state, true),
  );

  const deleteIds = getMarks(state)
    .filter((mark) => mark.kind === 'delete')
    .map((mark) => mark.id);
  assert.equal(deleteIds.length, 1, 'Expected tracked cut fixture to create one delete mark');
  state = updateCreatedAt(state, deleteIds, '2026-03-30T20:00:00.000Z');

  const cutCursor = cutFrom;
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, cutCursor, cutCursor)),
  );
  const pasteSlice = new Slice(
    Fragment.from(schema.node('paragraph', null, [schema.text('delta')])),
    1,
    1,
  );
  const pasteTr = __debugBuildTrackedSuggestionPasteTransaction(state, pasteSlice, null);
  assert.ok(pasteTr, 'Expected tracked paste helper to build a plain-text paste transaction');
  state = state.apply(wrapTransactionForSuggestions(pasteTr!, state, true));

  const insertIds = getMarks(state)
    .filter((mark) => mark.kind === 'insert')
    .map((mark) => mark.id);
  assert.equal(insertIds.length, 1, 'Expected tracked paste fixture to create one insert mark');
  state = updateCreatedAt(state, insertIds, '2026-03-30T20:00:01.000Z');

  const firstUndoIds = __debugResolveLatestPendingSuggestionUndoMarkIds(state);
  assert.deepEqual(firstUndoIds, insertIds, 'Expected the latest tracked undo group to target the pasted insert before the earlier cut delete');

  view = createMockView(state);
  assert.equal(__debugUndoLatestPendingSuggestionEdit(view), true, 'Expected first TC undo fallback to remove the pasted insert');
  assert.equal(getMarks(view.state).filter((mark) => mark.kind === 'insert').length, 0, 'Expected first TC undo fallback to clear the insert mark');
  assert.equal(getMarks(view.state).filter((mark) => mark.kind === 'delete').length, 1, 'Expected first TC undo fallback to preserve the earlier cut delete');

  const secondUndoIds = __debugResolveLatestPendingSuggestionUndoMarkIds(view.state);
  assert.deepEqual(secondUndoIds, deleteIds, 'Expected the second tracked undo group to target the earlier cut delete');
  assert.equal(__debugUndoLatestPendingSuggestionEdit(view), true, 'Expected second TC undo fallback to remove the cut delete');
  assert.equal(view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n'), cutPasteOriginal, 'Expected TC undo fallback to restore the original cut+pasted text');
  assert.equal(getMarks(view.state).length, 0, 'Expected TC undo fallback to clear both cut and paste marks');

  console.log('✓ track changes undo fallback reverts full-paragraph replacements and cut+pasted suggestion groups');
}

run();
