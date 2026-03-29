import { history, redo, undo } from 'prosemirror-history';
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state';
import { Schema } from '@milkdown/kit/prose/model';

import {
  marksPluginKey,
  getMarks,
} from '../editor/plugins/marks';
import {
  __buildHistorySuggestionMetadataReconciliationTransactionForTests,
  isUndoHistoryTransaction,
  wrapTransactionForSuggestions,
} from '../editor/plugins/suggestions';
import type { StoredMark } from '../formats/marks';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
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
          kind: { default: 'delete' },
          by: { default: 'human:test' },
          quote: { default: null },
          content: { default: null },
          createdAt: { default: null },
          status: { default: 'pending' },
          startRel: { default: null },
          endRel: { default: null },
        },
        inclusive: false,
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
          | { type?: string; metadata?: Record<string, StoredMark>; markId?: string | null; range?: unknown }
          | undefined;
        if (meta?.type === 'SET_METADATA') {
          return {
            ...value,
            metadata: meta.metadata ?? {},
          };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return {
            ...value,
            activeMarkId: meta.markId ?? null,
          };
        }
        if (meta?.type === 'SET_COMPOSE_ANCHOR') {
          return {
            ...value,
            composeAnchorRange: meta.range ?? null,
          };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Alpha beta gamma')]),
    ]),
    plugins: [history(), marksStatePlugin],
  });

  const deleteId = 'undo-delete-mark';
  const deleteTr = state.tr
    .addMark(
      7,
      11,
      schema.marks.proofSuggestion.create({
        id: deleteId,
        kind: 'delete',
        by: 'human:test',
        quote: 'beta',
        createdAt: new Date().toISOString(),
        status: 'pending',
        startRel: 'char:6',
        endRel: 'char:10',
      }),
    )
    .setMeta(marksPluginKey, {
      type: 'SET_METADATA',
      metadata: {
        [deleteId]: {
          kind: 'delete',
          by: 'human:test',
          quote: 'beta',
          createdAt: new Date().toISOString(),
          status: 'pending',
          startRel: 'char:6',
          endRel: 'char:10',
        },
      } satisfies Record<string, StoredMark>,
    });
  state = state.apply(deleteTr);

  const preUndoState = state;
  let undoDispatchApplied = false;
  const undoHandled = undo(state, (tr) => {
    assert(isUndoHistoryTransaction(tr), 'Expected undo transactions to be eligible for history metadata reconciliation');
    state = state.apply(tr);
    undoDispatchApplied = true;
  });
  assert(undoHandled, 'Expected undo to dispatch for a tracked deletion transaction');
  assert(undoDispatchApplied, 'Expected undo to apply a history transaction');

  const pluginMetadataAfterUndo = (marksPluginKey.getState(state) as { metadata?: Record<string, StoredMark> } | undefined)?.metadata ?? {};
  assert(pluginMetadataAfterUndo[deleteId], 'Expected stale delete metadata to survive raw history undo before reconciliation');

  const reconcileTr = __buildHistorySuggestionMetadataReconciliationTransactionForTests(preUndoState, state);
  assert(reconcileTr, 'Expected history reconciliation to generate a metadata cleanup transaction');
  state = state.apply(reconcileTr);

  const pluginMetadataAfterReconcile = (marksPluginKey.getState(state) as { metadata?: Record<string, StoredMark> } | undefined)?.metadata ?? {};
  assert(!pluginMetadataAfterReconcile[deleteId], 'Expected history reconciliation to remove stale delete metadata after undo');

  state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Alpha seasonal beta')]),
    ]),
    selection: TextSelection.create(
      schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text('Alpha seasonal beta')]),
      ]),
      7,
      15,
    ),
    plugins: [history(), marksStatePlugin],
  });

  state = state.apply(wrapTransactionForSuggestions(state.tr.delete(7, 15), state, true));
  state = state.apply(wrapTransactionForSuggestions(state.tr.insertText('annual', 15, 15), state, true));

  const overwritePreUndoState = state;
  const overwriteInsertCount = getMarks(state).filter((mark) => mark.kind === 'insert').length;
  const overwriteDeleteCount = getMarks(state).filter((mark) => mark.kind === 'delete').length;
  assert(overwriteInsertCount === 1, 'Expected overwrite fixture to produce one insert mark before undo');
  assert(overwriteDeleteCount === 1, 'Expected overwrite fixture to produce one delete mark before undo');

  let overwriteUndoHandled = false;
  const overwriteUndoResult = undo(state, (tr) => {
    assert(isUndoHistoryTransaction(tr), 'Expected overwrite undo transactions to be eligible for history metadata reconciliation');
    overwriteUndoHandled = true;
    state = state.apply(tr);
  });
  assert(overwriteUndoResult, 'Expected undo to dispatch for a tracked overwrite fixture');
  assert(overwriteUndoHandled, 'Expected tracked overwrite undo transaction to apply');

  const overwriteRawMarks = getMarks(state);
  assert(
    overwriteRawMarks.some((mark) => mark.kind === 'delete'),
    'Expected raw overwrite undo to leave the paired delete mark behind before reconciliation',
  );

  const overwriteReconcileTr = __buildHistorySuggestionMetadataReconciliationTransactionForTests(
    overwritePreUndoState,
    state,
  );
  assert(overwriteReconcileTr, 'Expected overwrite undo reconciliation transaction');
  state = state.apply(overwriteReconcileTr);

  assert(state.doc.textContent === 'Alpha seasonal beta', 'Expected overwrite undo reconciliation to restore the original text');
  assert(getMarks(state).length === 0, 'Expected overwrite undo reconciliation to remove the paired delete + insert marks');

  state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Alpha seasonal beta')]),
    ]),
    selection: TextSelection.create(
      schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text('Alpha seasonal beta')]),
      ]),
      7,
      15,
    ),
    plugins: [history(), marksStatePlugin],
  });

  state = state.apply(wrapTransactionForSuggestions(state.tr.delete(7, 15), state, true));
  state = state.apply(wrapTransactionForSuggestions(state.tr.insertText('annual', 15, 15), state, true));
  const overwritePreUndoStateWithMetadataDrop = state;
  undo(state, (tr) => {
    assert(isUndoHistoryTransaction(tr), 'Expected dropped-metadata undo transactions to be eligible for history metadata reconciliation');
    state = state.apply(tr);
  });
  const deleteOnlyMetadata = Object.fromEntries(
    Object.entries((marksPluginKey.getState(state) as { metadata?: Record<string, StoredMark> } | undefined)?.metadata ?? {})
      .filter(([, mark]) => mark.kind === 'delete'),
  );
  state = state.apply(state.tr.setMeta(marksPluginKey, {
    type: 'SET_METADATA',
    metadata: deleteOnlyMetadata,
  }));

  const droppedInsertMetadataReconcileTr = __buildHistorySuggestionMetadataReconciliationTransactionForTests(
    overwritePreUndoStateWithMetadataDrop,
    state,
  );
  assert(
    droppedInsertMetadataReconcileTr,
    'Expected overwrite undo reconciliation even when the history runtime has already dropped the insert metadata id',
  );
  state = state.apply(droppedInsertMetadataReconcileTr);
  assert(getMarks(state).length === 0, 'Expected overwrite undo reconciliation to still remove the paired delete when insert metadata is already missing');

  let redoDispatchApplied = false;
  const redoHandled = redo(state, (tr) => {
    assert(!isUndoHistoryTransaction(tr), 'Expected redo transactions not to trigger undo-only history metadata reconciliation');
    state = state.apply(tr);
    redoDispatchApplied = true;
  });
  assert(redoHandled, 'Expected redo to dispatch for the tracked overwrite fixture');
  assert(redoDispatchApplied, 'Expected redo to apply a history transaction');
  assert(!isUndoHistoryTransaction(state.tr), 'Expected ordinary transactions not to be treated as undo history transactions');

  console.log('track-changes-undo-delete-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
