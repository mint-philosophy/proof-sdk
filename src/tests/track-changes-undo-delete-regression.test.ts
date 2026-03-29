import { history, undo } from 'prosemirror-history';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';
import { Schema } from '@milkdown/kit/prose/model';

import {
  marksPluginKey,
} from '../editor/plugins/marks';
import { __buildHistorySuggestionMetadataReconciliationTransactionForTests } from '../editor/plugins/suggestions';
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

  console.log('track-changes-undo-delete-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
