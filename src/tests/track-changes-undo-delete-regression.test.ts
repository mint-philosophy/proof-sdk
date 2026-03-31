import { history, redo, undo, undoDepth } from 'prosemirror-history';
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state';
import { Schema } from '@milkdown/kit/prose/model';

import {
  marksPluginKey,
  getMarks,
  accept as acceptMark,
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
      schema.node('paragraph', null, [schema.text('Important content target here.')]),
    ]),
    selection: TextSelection.create(
      schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text('Important content target here.')]),
      ]),
      19,
      25,
    ),
    plugins: [history(), marksStatePlugin],
  });

  state = state.apply(wrapTransactionForSuggestions(state.tr.insertText('CHANGED', 19, 25), state, true));
  assert(undoDepth(state) === 1, 'Expected single-transaction tracked replacement to create one undo history event');

  const singleTransactionOverwritePreUndoState = state;
  let singleTransactionOverwriteUndoHandled = false;
  const singleTransactionOverwriteUndoResult = undo(state, (tr) => {
    assert(isUndoHistoryTransaction(tr), 'Expected single-transaction overwrite undo to be tagged as history undo');
    singleTransactionOverwriteUndoHandled = true;
    state = state.apply(tr);
  });
  assert(singleTransactionOverwriteUndoResult, 'Expected undo to dispatch for the single-transaction overwrite fixture');
  assert(singleTransactionOverwriteUndoHandled, 'Expected single-transaction overwrite undo to apply');

  const singleTransactionOverwriteReconcileTr = __buildHistorySuggestionMetadataReconciliationTransactionForTests(
    singleTransactionOverwritePreUndoState,
    state,
  );
  assert(singleTransactionOverwriteReconcileTr, 'Expected single-transaction overwrite undo reconciliation transaction');
  state = state.apply(singleTransactionOverwriteReconcileTr);
  assert(state.doc.textContent === 'Important content target here.', 'Expected single-transaction overwrite undo reconciliation to restore the original text');
  assert(getMarks(state).length === 0, 'Expected single-transaction overwrite undo reconciliation to clear suggestion marks');
  assert(undoDepth(state) === 0, 'Expected single-transaction overwrite undo reconciliation to leave no second undo step behind');

  const unexpectedSecondUndo = undo(state, () => {
    throw new Error('Unexpected second undo dispatch after tracked overwrite reconciliation');
  });
  assert(!unexpectedSecondUndo, 'Expected second undo not to walk back into tracked overwrite setup after reconciliation');

  const browserUndoShapeText = 'The climate models predicted substantial warming over the coming decades.';
  const browserUndoShapeSelectionFrom = browserUndoShapeText.indexOf('warming') + 1;
  const browserUndoShapeSelectionTo = browserUndoShapeSelectionFrom + 'warming'.length;
  state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(browserUndoShapeText)]),
    ]),
    selection: TextSelection.create(
      schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text(browserUndoShapeText)]),
      ]),
      browserUndoShapeSelectionFrom,
      browserUndoShapeSelectionTo,
    ),
    plugins: [history(), marksStatePlugin],
  });

  state = state.apply(
    wrapTransactionForSuggestions(
      state.tr.insertText('heating', browserUndoShapeSelectionFrom, browserUndoShapeSelectionTo),
      state,
      true,
    ),
  );
  const browserUndoShapePreReconcileState = state;
  const browserUndoShapeDeleteMark = getMarks(state).find((mark) => mark.kind === 'delete');
  assert(browserUndoShapeDeleteMark?.range, 'Expected replacement fixture to expose a delete range before undo-shape reconciliation');

  state = state.apply(
    state.tr.removeMark(
      browserUndoShapeDeleteMark!.range!.from,
      browserUndoShapeDeleteMark!.range!.to,
      schema.marks.proofSuggestion,
    ),
  );
  const browserUndoShapeInsertOnlyMetadata = Object.fromEntries(
    Object.entries((marksPluginKey.getState(state) as { metadata?: Record<string, StoredMark> } | undefined)?.metadata ?? {})
      .filter(([, mark]) => mark.kind === 'insert'),
  );
  state = state.apply(state.tr.setMeta(marksPluginKey, {
    type: 'SET_METADATA',
    metadata: browserUndoShapeInsertOnlyMetadata,
  }));
  assert(
    state.doc.textContent.includes('warmingheating'),
    'Expected simulated browser undo shape to preserve the orphaned replacement insert before reconciliation',
  );
  assert(
    getMarks(state).some((mark) => mark.kind === 'insert') && !getMarks(state).some((mark) => mark.kind === 'delete'),
    'Expected simulated browser undo shape to retain only the insert suggestion before reconciliation',
  );

  const browserUndoShapeReconcileTr = __buildHistorySuggestionMetadataReconciliationTransactionForTests(
    browserUndoShapePreReconcileState,
    state,
  );
  assert(
    browserUndoShapeReconcileTr,
    'Expected history reconciliation to detect and remove orphaned insert suggestions when the paired delete disappears first',
  );
  state = state.apply(browserUndoShapeReconcileTr);
  assert(
    state.doc.textContent === browserUndoShapeText,
    'Expected browser-style overwrite undo reconciliation to remove the orphaned insert and restore the original word',
  );
  assert(
    getMarks(state).length === 0,
    'Expected browser-style overwrite undo reconciliation to clear the surviving insert suggestion as well',
  );

  const duplicatedInsertUndoText = 'The research captured several methodological innovations across cohorts.';
  const duplicatedInsertSelectionFrom = duplicatedInsertUndoText.indexOf('several methodological') + 1;
  const duplicatedInsertSelectionTo = duplicatedInsertSelectionFrom + 'several methodological'.length;
  state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(duplicatedInsertUndoText)]),
    ]),
    selection: TextSelection.create(
      schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text(duplicatedInsertUndoText)]),
      ]),
      duplicatedInsertSelectionFrom,
      duplicatedInsertSelectionTo,
    ),
    plugins: [history(), marksStatePlugin],
  });

  state = state.apply(
    wrapTransactionForSuggestions(
      state.tr.insertText('many key', duplicatedInsertSelectionFrom, duplicatedInsertSelectionTo),
      state,
      true,
    ),
  );
  const duplicatedInsertPreReconcileState = state;
  const duplicatedInsertMark = getMarks(state).find((mark) => mark.kind === 'insert');
  const duplicatedDeleteMark = getMarks(state).find((mark) => mark.kind === 'delete');
  assert(duplicatedInsertMark?.range, 'Expected duplicated-insert undo fixture to expose an insert range before reconciliation');
  assert(duplicatedDeleteMark?.range, 'Expected duplicated-insert undo fixture to expose a delete range before reconciliation');

  state = state.apply(
    state.tr
      .removeMark(
        duplicatedDeleteMark!.range!.from,
        duplicatedDeleteMark!.range!.to,
        schema.marks.proofSuggestion,
      )
      .insertText('many', duplicatedInsertMark!.range!.from, duplicatedInsertMark!.range!.from)
      .addMark(
        duplicatedInsertMark!.range!.from,
        duplicatedInsertMark!.range!.to + 4,
        schema.marks.proofSuggestion.create({
          id: duplicatedInsertMark!.id,
          kind: 'insert',
          by: duplicatedInsertMark!.by,
        }),
      ),
  );
  const duplicatedInsertOnlyMetadata = Object.fromEntries(
    Object.entries((marksPluginKey.getState(state) as { metadata?: Record<string, StoredMark> } | undefined)?.metadata ?? {})
      .filter(([id, mark]) => id === duplicatedInsertMark!.id && mark.kind === 'insert'),
  );
  state = state.apply(state.tr.setMeta(marksPluginKey, {
    type: 'SET_METADATA',
    metadata: duplicatedInsertOnlyMetadata,
  }));
  assert(
    state.doc.textContent.includes('several methodologicalmanymany key innovations'),
    'Expected duplicated-insert undo fixture to preserve the browser-style duplicated insert corruption before reconciliation',
  );

  const duplicatedInsertReconcileTr = __buildHistorySuggestionMetadataReconciliationTransactionForTests(
    duplicatedInsertPreReconcileState,
    state,
  );
  assert(
    duplicatedInsertReconcileTr,
    'Expected history reconciliation to remove a surviving paired insert even when the browser leaves duplicated insert text behind',
  );
  state = state.apply(duplicatedInsertReconcileTr);
  assert(
    state.doc.textContent === duplicatedInsertUndoText,
    'Expected duplicated-insert overwrite undo reconciliation to remove the entire surviving insert range and restore the original text',
  );
  assert(
    getMarks(state).length === 0,
    'Expected duplicated-insert overwrite undo reconciliation to clear the surviving insert suggestion metadata as well',
  );

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

  let acceptState = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('beta', [schema.marks.proofSuggestion.create({
          id: 'accept-insert-mark',
          kind: 'insert',
          by: 'human:test',
        })]),
      ]),
    ]),
    plugins: [history(), marksStatePlugin],
  });
  acceptState = acceptState.apply(acceptState.tr.setMeta(marksPluginKey, {
    type: 'SET_METADATA',
    metadata: {
      'accept-insert-mark': {
        kind: 'insert',
        by: 'human:test',
        content: 'beta',
        createdAt: new Date().toISOString(),
        status: 'pending',
      },
    } satisfies Record<string, StoredMark>,
  }));
  acceptState = acceptState.apply(acceptState.tr.insertText('!', acceptState.doc.content.size));
  assert(undoDepth(acceptState) === 1, 'Expected a plain user edit before accept to create one undo step');

  let acceptTr: any = null;
  const acceptView = {
    get state() {
      return acceptState;
    },
    dispatch(tr: any) {
      acceptTr = tr;
      acceptState = acceptState.apply(tr);
    },
  } as const;
  const acceptHandled = acceptMark(acceptView as any, 'accept-insert-mark');
  assert(acceptHandled, 'Expected accept to succeed for the pending insert fixture');
  assert(acceptTr?.getMeta('addToHistory') === false, 'Expected accept to stay out of undo history');
  assert(undoDepth(acceptState) === 1, 'Expected accept to be transparent to the existing undo stack');

  let acceptPassThroughUndoHandled = false;
  const acceptPassThroughUndo = undo(acceptState, (tr) => {
    acceptPassThroughUndoHandled = true;
    acceptState = acceptState.apply(tr);
  });
  assert(acceptPassThroughUndo, 'Expected undo to pass through accept and target the prior user edit');
  assert(acceptPassThroughUndoHandled, 'Expected pass-through undo to dispatch a history transaction');
  assert(acceptState.doc.textContent === 'beta', 'Expected pass-through undo to remove only the pre-accept plain user edit');
  assert(getMarks(acceptState).length === 0, 'Expected accepted insert suggestion to remain plain text after pass-through undo');

  const oldPrefixInsertId = 'history-mismatch-prefix';
  const oldDeleteId = 'history-mismatch-delete';
  const oldOverwriteInsertId = 'history-mismatch-overwrite-insert';
  const oldHistoryMetadata: Record<string, StoredMark> = {
    [oldPrefixInsertId]: {
      kind: 'insert',
      by: 'human:test',
      content: 'RESULTS: ',
      createdAt: new Date().toISOString(),
      status: 'pending',
    },
    [oldDeleteId]: {
      kind: 'delete',
      by: 'human:test',
      quote: 'seasonal',
      createdAt: new Date().toISOString(),
      status: 'pending',
    },
    [oldOverwriteInsertId]: {
      kind: 'insert',
      by: 'human:test',
      content: 'annual',
      createdAt: new Date().toISOString(),
      status: 'pending',
    },
  };
  const oldHistoryDoc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('RESULTS: ', [schema.marks.proofSuggestion.create({
        id: oldPrefixInsertId,
        kind: 'insert',
        by: 'human:test',
      })]),
      schema.text('Alpha '),
      schema.text('seasonal', [schema.marks.proofSuggestion.create({
        id: oldDeleteId,
        kind: 'delete',
        by: 'human:test',
      })]),
      schema.text('annual', [schema.marks.proofSuggestion.create({
        id: oldOverwriteInsertId,
        kind: 'insert',
        by: 'human:test',
      })]),
      schema.text(' beta'),
    ]),
  ]);
  const corruptedHistoryDoc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('RERESULTRESULTS: ', [schema.marks.proofSuggestion.create({
        id: oldPrefixInsertId,
        kind: 'insert',
        by: 'human:test',
      })]),
      schema.text('Alpha seasonal'),
      schema.text('annual', [schema.marks.proofSuggestion.create({
        id: oldOverwriteInsertId,
        kind: 'insert',
        by: 'human:test',
      })]),
      schema.text(' beta'),
    ]),
  ]);
  let oldHistoryState = EditorState.create({
    schema,
    doc: oldHistoryDoc,
    plugins: [history(), marksStatePlugin],
  });
  oldHistoryState = oldHistoryState.apply(oldHistoryState.tr.setMeta(marksPluginKey, {
    type: 'SET_METADATA',
    metadata: oldHistoryMetadata,
  }));
  let corruptedHistoryState = EditorState.create({
    schema,
    doc: corruptedHistoryDoc,
    plugins: [history(), marksStatePlugin],
  });
  corruptedHistoryState = corruptedHistoryState.apply(corruptedHistoryState.tr.setMeta(marksPluginKey, {
    type: 'SET_METADATA',
    metadata: {
      [oldPrefixInsertId]: oldHistoryMetadata[oldPrefixInsertId]!,
      [oldOverwriteInsertId]: oldHistoryMetadata[oldOverwriteInsertId]!,
    },
  }));
  const mismatchedInsertReconcileTr = __buildHistorySuggestionMetadataReconciliationTransactionForTests(
    oldHistoryState,
    corruptedHistoryState,
  );
  assert(
    mismatchedInsertReconcileTr,
    'Expected overwrite-style history reconciliation to generate a cleanup transaction for the mismatched surviving insert',
  );
  const reconciledCorruptedHistoryState = corruptedHistoryState.apply(mismatchedInsertReconcileTr);
  assert(
    reconciledCorruptedHistoryState.doc.textContent === 'RERESULTRESULTS: Alpha seasonalannual beta',
    'Expected mismatched surviving insert cleanup to preserve the live text while stripping only the corrupted surviving insert mark',
  );
  const reconciledCorruptedMarks = getMarks(reconciledCorruptedHistoryState);
  const reconciledCorruptedMetadata = (marksPluginKey.getState(reconciledCorruptedHistoryState) as
    { metadata?: Record<string, StoredMark> }
    | undefined)?.metadata ?? {};
  assert(
    !reconciledCorruptedMarks.some((mark) => mark.id === oldPrefixInsertId),
    'Expected mismatched surviving insert cleanup to remove the corrupted surviving insert mark from the document',
  );
  assert(
    !reconciledCorruptedMetadata[oldPrefixInsertId],
    'Expected mismatched surviving insert cleanup to drop the corrupted surviving insert metadata entry as well',
  );

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
