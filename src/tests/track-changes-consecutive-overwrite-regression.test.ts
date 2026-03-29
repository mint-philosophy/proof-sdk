import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state';

import { marksPluginKey, getMarks } from '../editor/plugins/marks.js';
import {
  __debugShouldRunTextPreservingInsertPersistenceFallback,
  __debugResolveTrackedDeleteRange,
  wrapTransactionForSuggestions,
} from '../editor/plugins/suggestions.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

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
    proofAuthored: {
      attrs: {
        by: { default: 'human:Anonymous' },
      },
      inclusive: true,
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

function createState(text: string): EditorState {
  return EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(text)]),
    ]),
    plugins: [marksStatePlugin],
  });
}

function resolveNthTextRange(state: EditorState, target: string, occurrence = 1): { from: number; to: number } {
  let searchFrom = 0;
  let start = -1;
  for (let count = 0; count < occurrence; count += 1) {
    start = state.doc.textContent.indexOf(target, searchFrom);
    if (start < 0) break;
    searchFrom = start + target.length;
  }
  assert(start >= 0, `Expected to find "${target}" occurrence ${occurrence} in "${state.doc.textContent}"`);
  return { from: start + 1, to: start + 1 + target.length };
}

function buildTrackedDeleteTransaction(
  state: EditorState,
  rangeOverride?: { from: number; to: number } | null,
): ReturnType<typeof wrapTransactionForSuggestions> {
  const deleteRange = __debugResolveTrackedDeleteRange(state, 'Backspace', undefined, rangeOverride);
  assert(deleteRange, 'Expected tracked delete range');
  const rawTr = state.tr.delete(deleteRange!.from, deleteRange!.to);
  if (rangeOverride && rangeOverride.to > rangeOverride.from) {
    rawTr.setMeta('proof-dom-selection-range', rangeOverride);
  }
  return wrapTransactionForSuggestions(rawTr, state, true);
}

function applyTrackedDelete(
  state: EditorState,
  rangeOverride?: { from: number; to: number } | null,
): EditorState {
  return state.apply(buildTrackedDeleteTransaction(state, rangeOverride));
}

function typeTrackedText(state: EditorState, text: string): EditorState {
  let nextState = state;
  for (const char of text) {
    const pos = nextState.selection.from;
    nextState = nextState.apply(
      wrapTransactionForSuggestions(nextState.tr.insertText(char, pos, pos), nextState, true),
    );
  }
  return nextState;
}

function run(): void {
  let state = createState('Alpha bravo charlie delta echo foxtrot golf hotel.');

  const bravoRange = resolveNthTextRange(state, 'bravo');
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, bravoRange.from, bravoRange.to)));
  state = applyTrackedDelete(state, bravoRange);
  state = typeTrackedText(state, 'BRAVO');

  let deleteMarks = getMarks(state).filter((mark) => mark.kind === 'delete');
  let insertMarks = getMarks(state).filter((mark) => mark.kind === 'insert');
  assertEqual(deleteMarks.length, 1, 'Expected first overwrite to create one delete mark');
  assertEqual(insertMarks.length, 1, 'Expected first overwrite to create one insert mark');
  assertEqual(deleteMarks[0]?.quote, 'bravo', 'Expected first overwrite delete mark to preserve the replaced word');

  const deltaRange = resolveNthTextRange(state, 'delta');
  const staleDeleteRange = __debugResolveTrackedDeleteRange(state, 'Backspace');
  assert(staleDeleteRange, 'Expected stale tracked delete range');
  assert(
    state.doc.textBetween(staleDeleteRange!.from, staleDeleteRange!.to, '') !== 'delta',
    'Expected stale editor selection after overwrite 1 not to point at the next selected overwrite target',
  );

  const domDeleteRange = __debugResolveTrackedDeleteRange(state, 'Backspace', undefined, deltaRange);
  assert(domDeleteRange, 'Expected DOM-backed delete range for second overwrite');
  assertEqual(
    state.doc.textBetween(domDeleteRange!.from, domDeleteRange!.to, ''),
    'delta',
    'Expected DOM selection override to target the selected word during consecutive overwrites',
  );

  const secondDeleteTr = buildTrackedDeleteTransaction(state, deltaRange);
  assert(
    secondDeleteTr.getMeta('suggestions-wrapped') === true,
    'Expected consecutive overwrite deletions to be wrapped as tracked suggestion transactions',
  );
  assert(
    !__debugShouldRunTextPreservingInsertPersistenceFallback([secondDeleteTr]),
    'Expected appendTransaction text-preserving insert fallback to skip suggestions-wrapped overwrite deletions',
  );
  state = state.apply(secondDeleteTr);
  state = typeTrackedText(state, 'DELTA');

  deleteMarks = getMarks(state).filter((mark) => mark.kind === 'delete');
  insertMarks = getMarks(state).filter((mark) => mark.kind === 'insert');
  assertEqual(deleteMarks.length, 2, 'Expected consecutive keyboard overwrites to accumulate delete marks');
  assertEqual(insertMarks.length, 2, 'Expected consecutive keyboard overwrites to keep both insert suggestions');
  assert(
    deleteMarks.some((mark) => mark.quote === 'delta'),
    'Expected second consecutive keyboard overwrite to preserve the deleted word in a delete mark',
  );

  console.log('✓ track changes preserves delete marks across consecutive keyboard overwrites');
}

run();
