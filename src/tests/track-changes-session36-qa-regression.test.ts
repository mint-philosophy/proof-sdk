import assert from 'node:assert/strict';
import { history, redo, redoDepth, undo, undoDepth } from 'prosemirror-history';
import { Fragment, Schema, Slice } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection, type Transaction } from '@milkdown/kit/prose/state';

import { setCurrentActor } from '../editor/actor';
import { getMarks, marksPluginKey } from '../editor/plugins/marks';
import {
  __debugBuildTrackedSuggestionPasteTransaction,
  __debugResolveLatestPendingSuggestionUndoMarkIds,
  __debugUndoLatestPendingSuggestionEdit,
  resetSuggestionsModuleState,
  setSuggestionsDesiredEnabled,
  suggestionsPlugin,
  wrapTransactionForSuggestions,
} from '../editor/plugins/suggestions';
import type { StoredMark } from '../formats/marks';

type TestState = {
  rawSuggestionsPlugin: Plugin;
  schema: Schema;
  marksStatePlugin: Plugin;
};

function buildSchema(): Schema {
  return new Schema({
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
}

function buildMarksStatePlugin(): Plugin {
  return new Plugin({
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
}

async function initTestState(): Promise<TestState> {
  (globalThis as { window?: unknown }).window = {
    proof: {
      bridge: {
        sendMessage() {},
      },
    },
  };

  const fakeCtx = {
    wait: async () => {},
    update: () => {},
  } as const;

  await (suggestionsPlugin as unknown as (ctx: unknown) => () => Promise<void>)(fakeCtx)();

  return {
    rawSuggestionsPlugin: (suggestionsPlugin as unknown as { plugin: () => Plugin }).plugin(),
    schema: buildSchema(),
    marksStatePlugin: buildMarksStatePlugin(),
  };
}

function createState(testState: TestState, paragraphs: string[], suggestionsEnabled = true): EditorState {
  resetSuggestionsModuleState();
  setSuggestionsDesiredEnabled(suggestionsEnabled);

  let state = EditorState.create({
    schema: testState.schema,
    doc: testState.schema.node('doc', null, paragraphs.map((text) =>
      testState.schema.node('paragraph', null, text.length > 0 ? [testState.schema.text(text)] : []),
    )),
    plugins: [history(), testState.marksStatePlugin, testState.rawSuggestionsPlugin],
  });

  state = state.applyTransaction(
    state.tr.setMeta(testState.rawSuggestionsPlugin.spec.key, { enabled: suggestionsEnabled }),
  ).state;

  return state;
}

function createView(
  getState: () => EditorState,
  setState: (state: EditorState) => void,
): { readonly state: EditorState; dispatch: (tr: Transaction) => void } {
  return {
    get state() {
      return getState();
    },
    dispatch(tr: Transaction) {
      setState(getState().applyTransaction(tr).state);
    },
  };
}

function docText(state: EditorState): string {
  return state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
}

function countParagraphs(state: EditorState): number {
  let count = 0;
  state.doc.descendants((node) => {
    if (node.type.name === 'paragraph') count += 1;
    return true;
  });
  return count;
}

function findInParagraph(state: EditorState, paragraphIndex: number, text: string): number {
  let currentIndex = 0;
  let found = -1;

  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true;
    if (currentIndex === paragraphIndex) {
      const offset = node.textContent.indexOf(text);
      if (offset >= 0) found = pos + 1 + offset;
      return false;
    }
    currentIndex += 1;
    return true;
  });

  if (found < 0) {
    throw new Error(`Could not find "${text}" in paragraph ${paragraphIndex}`);
  }

  return found;
}

function paragraphStart(state: EditorState, paragraphIndex: number): number {
  let currentIndex = 0;
  let found = -1;

  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true;
    if (currentIndex === paragraphIndex) {
      found = pos + 1;
      return false;
    }
    currentIndex += 1;
    return true;
  });

  if (found < 0) {
    throw new Error(`Could not resolve paragraph ${paragraphIndex}`);
  }

  return found;
}

function paragraphEnd(state: EditorState, paragraphIndex: number): number {
  let currentIndex = 0;
  let found = -1;

  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true;
    if (currentIndex === paragraphIndex) {
      found = pos + 1 + node.content.size;
      return false;
    }
    currentIndex += 1;
    return true;
  });

  if (found < 0) {
    throw new Error(`Could not resolve paragraph end for ${paragraphIndex}`);
  }

  return found;
}

function applyWrapped(state: EditorState, tr: Transaction): EditorState {
  return state.applyTransaction(
    wrapTransactionForSuggestions(tr, state, true),
  ).state;
}

function applyRaw(state: EditorState, tr: Transaction): EditorState {
  return state.applyTransaction(tr).state;
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
  return state.applyTransaction(state.tr.setMeta(marksPluginKey, {
    type: 'SET_METADATA',
    metadata,
  })).state;
}

function marksSnapshot(state: EditorState): string {
  return JSON.stringify(
    getMarks(state)
      .map((mark) => ({
        id: mark.id,
        kind: mark.kind,
        range: mark.range ?? null,
        text: mark.range ? state.doc.textBetween(mark.range.from, mark.range.to, '\n', '\n') : null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function runTrackChangesUndo(state: EditorState): { state: EditorState; usedFallback: boolean } {
  let nextState = state;
  const beforeDoc = docText(nextState);
  const beforeMarks = marksSnapshot(nextState);

  const historyHandled = undo(state, (tr) => {
    nextState = nextState.applyTransaction(tr).state;
  });
  const changed = docText(nextState) !== beforeDoc || marksSnapshot(nextState) !== beforeMarks;
  if (historyHandled && changed) {
    return { state: nextState, usedFallback: false };
  }

  const view = createView(
    () => nextState,
    (resolved) => {
      nextState = resolved;
    },
  );
  const fallbackHandled = __debugUndoLatestPendingSuggestionEdit(view as never);
  assert.equal(
    fallbackHandled,
    true,
    'Expected TC undo fallback to resolve the latest pending suggestion group when native history produces no document change',
  );
  return { state: nextState, usedFallback: true };
}

function runHistoryUndo(state: EditorState): EditorState {
  let nextState = state;
  const handled = undo(state, (tr) => {
    nextState = nextState.applyTransaction(tr).state;
  });
  assert.equal(handled, true, 'Expected undo to dispatch a history transaction');
  return nextState;
}

function runHistoryRedo(state: EditorState): EditorState {
  let nextState = state;
  const handled = redo(state, (tr) => {
    nextState = nextState.applyTransaction(tr).state;
  });
  assert.equal(handled, true, 'Expected redo to dispatch a history transaction');
  return nextState;
}

function runCrossParagraphCutPasteUndo(testState: TestState): void {
  let state = createState(testState, [
    'Alpha beta one.',
    'Gamma delta two.',
    'Tail paragraph.',
  ]);
  const original = docText(state);

  const cutFrom = findInParagraph(state, 0, 'beta');
  const cutTo = findInParagraph(state, 1, 'delta') + 'delta'.length;
  state = applyWrapped(state, state.tr.delete(cutFrom, cutTo));

  const deleteIds = getMarks(state).filter((mark) => mark.kind === 'delete').map((mark) => mark.id);
  assert(deleteIds.length >= 1, 'Expected cross-paragraph cut to create delete suggestions');
  state = updateCreatedAt(state, deleteIds, '2026-03-30T20:00:00.000Z');

  const pasteAt = paragraphStart(state, 2);
  state = applyRaw(state, state.tr.setSelection(TextSelection.create(state.doc, pasteAt, pasteAt)));
  const pasteSlice = new Slice(
    Fragment.fromArray([
      testState.schema.node('paragraph', null, [testState.schema.text('beta one.')]),
      testState.schema.node('paragraph', null, [testState.schema.text('Gamma delta')]),
    ]),
    1,
    1,
  );
  const pasteTr = __debugBuildTrackedSuggestionPasteTransaction(state, pasteSlice, null);
  assert.ok(pasteTr, 'Expected cross-paragraph cut clipboard text to build a tracked paste transaction');
  state = applyWrapped(state, pasteTr!);

  const insertIds = getMarks(state).filter((mark) => mark.kind === 'insert').map((mark) => mark.id);
  assert(insertIds.length >= 2, 'Expected cross-paragraph paste to create insert suggestions for the pasted blocks');
  state = updateCreatedAt(state, insertIds, '2026-03-30T20:00:01.000Z');

  assert.deepEqual(
    __debugResolveLatestPendingSuggestionUndoMarkIds(state).slice().sort(),
    insertIds.slice().sort(),
    'Expected cross-paragraph paste to resolve as the newest pending undo group before the earlier cut',
  );

  state = runTrackChangesUndo(state).state;
  assert.equal(
    getMarks(state).filter((mark) => mark.kind === 'insert').length,
    0,
    'Expected first cross-paragraph undo to remove the pasted insert suggestions',
  );
  assert(
    getMarks(state).some((mark) => mark.kind === 'delete'),
    'Expected first cross-paragraph undo to preserve the earlier cut delete suggestions',
  );

  state = runTrackChangesUndo(state).state;
  assert.equal(docText(state), original, 'Expected second cross-paragraph undo to restore the original paragraphs');
  assert.equal(getMarks(state).length, 0, 'Expected second cross-paragraph undo to clear the remaining cut suggestions');
  assert.equal(countParagraphs(state), 3, 'Expected cross-paragraph undo to restore the original paragraph structure');
}

function runExecCommandReplacementUndo(testState: TestState): void {
  let state = createState(testState, ['Alpha beta gamma.']);
  const original = docText(state);

  const from = findInParagraph(state, 0, 'beta');
  state = applyWrapped(
    state,
    state.tr.insertText('delta', from, from + 'beta'.length),
  );

  assert.equal(getMarks(state).filter((mark) => mark.kind === 'insert').length, 1, 'Expected execCommand-style replacement to create one insert suggestion');
  assert.equal(getMarks(state).filter((mark) => mark.kind === 'delete').length, 1, 'Expected execCommand-style replacement to create one delete suggestion');
  assert(undoDepth(state) >= 1, 'Expected execCommand-style replacement to add an undoable history event');

  state = runTrackChangesUndo(state).state;
  assert.equal(docText(state), original, 'Expected undo to restore the original text after execCommand-style replacement');
  assert.equal(getMarks(state).length, 0, 'Expected undo to clear replacement suggestions after execCommand-style replacement');
}

function runLargeReplacementUndo(testState: TestState): void {
  const largeSelection = Array.from({ length: 60 }, (_, index) => `segment-${index}`).join(' ');
  const original = `Prefix ${largeSelection} suffix.`;
  const replacement = 'condensed summary';
  let state = createState(testState, [original]);

  const from = findInParagraph(state, 0, largeSelection);
  assert(largeSelection.length > 300, 'Expected large replacement fixture to span more than 300 characters');
  state = applyWrapped(
    state,
    state.tr.insertText(replacement, from, from + largeSelection.length),
  );

  assert.equal(getMarks(state).filter((mark) => mark.kind === 'insert').length, 1, 'Expected large replacement to create one insert suggestion');
  assert.equal(getMarks(state).filter((mark) => mark.kind === 'delete').length, 1, 'Expected large replacement to create one delete suggestion');

  state = runTrackChangesUndo(state).state;
  assert.equal(docText(state), original, 'Expected undo to restore the full 300+ character selection after replacement');
  assert.equal(getMarks(state).length, 0, 'Expected undo to clear large replacement suggestions');
}

function runModeSwitchUndoStability(testState: TestState): void {
  let state = createState(testState, ['Alpha beta gamma.'], false);
  const plainInsertPos = paragraphEnd(state, 0);
  state = applyRaw(state, state.tr.insertText(' plain', plainInsertPos, plainInsertPos));
  assert.equal(getMarks(state).length, 0, 'Expected Edit mode typing to produce plain text with no suggestions');

  const view = createView(
    () => state,
    (resolved) => {
      state = resolved;
    },
  );

  state = state.applyTransaction(
    state.tr.setMeta(testState.rawSuggestionsPlugin.spec.key, { enabled: true }),
  ).state;
  setSuggestionsDesiredEnabled(true);
  assert.equal((view.state as EditorState), state, 'Expected view state binding to remain intact after mode switch setup');

  const betaFrom = findInParagraph(state, 0, 'beta');
  state = applyWrapped(state, state.tr.insertText('delta', betaFrom, betaFrom + 'beta'.length));
  state = runTrackChangesUndo(state).state;
  assert.equal(docText(state), 'Alpha beta gamma. plain', 'Expected undo after a mode switch to restore the mixed plain+TC state cleanly');
  assert.equal(getMarks(state).length, 0, 'Expected undo after a mode switch to clear the tracked replacement suggestions');

  const gammaFrom = findInParagraph(state, 0, 'gamma');
  state = applyWrapped(state, state.tr.insertText('theta', gammaFrom, gammaFrom + 'gamma'.length));
  assert.equal(getMarks(state).filter((mark) => mark.kind === 'insert').length, 1, 'Expected Track Changes to remain functional after the mode-switch undo');
  assert.equal(getMarks(state).filter((mark) => mark.kind === 'delete').length, 1, 'Expected the next tracked replacement after the mode-switch undo to stay paired');
  assert.equal(docText(state).split('plain').length - 1, 1, 'Expected post-undo editing after a mode switch not to duplicate earlier plain-text edits');
}

function runFragmentedSuggestionGrouping(testState: TestState): void {
  let state = createState(testState, ['The study recruited participants from multiple sites.']);

  const recruitedStart = findInParagraph(state, 0, 'recruited');
  state = applyRaw(
    state,
    state.tr.setSelection(TextSelection.create(state.doc, recruitedStart, recruitedStart + 'recruited'.length)),
  );
  state = applyWrapped(
    state,
    state.tr.insertText('enrolled', recruitedStart, recruitedStart + 'recruited'.length),
  );

  const firstInsert = getMarks(state).find((mark) => mark.kind === 'insert');
  assert(firstInsert?.range, 'Expected initial grouped replacement fixture to expose an insert range');

  const overlapFrom = firstInsert.range!.from;
  const overlapTo = overlapFrom + 'enrolled participa'.length;
  state = applyRaw(
    state,
    state.tr.setSelection(TextSelection.create(state.doc, overlapFrom, overlapTo)),
  );
  state = applyWrapped(
    state,
    state.tr.insertText('included volunt', overlapFrom, overlapTo),
  );

  assert.equal(
    getMarks(state).filter((mark) => mark.kind === 'insert').length,
    1,
    'Expected overlapping edits to keep one current insert suggestion instead of fragmenting into multiple insert-only groups',
  );
  assert(
    getMarks(state).filter((mark) => mark.kind === 'delete').length >= 2,
    'Expected overlapping edits to preserve delete suggestions for the overwritten content instead of collapsing group structure',
  );
  assert(
    __debugResolveLatestPendingSuggestionUndoMarkIds(state).length >= 2,
    'Expected the latest overlapping edit to remain addressable as one grouped pending replacement',
  );

  const view = createView(
    () => state,
    (resolved) => {
      state = resolved;
    },
  );
  assert.equal(__debugUndoLatestPendingSuggestionEdit(view as never), true, 'Expected grouped overlap undo fallback to reject the newest suggestion group');
  assert(
    docText(state).includes('participants'),
    'Expected grouped overlap undo fallback to preserve the original participant text after rejecting the newest overlap edit',
  );
}

function runUndoRedoStability(testState: TestState): void {
  let state = createState(testState, ['Alpha seasonal beta.']);
  const original = docText(state);
  const from = findInParagraph(state, 0, 'seasonal');
  state = applyWrapped(state, state.tr.insertText('annual', from, from + 'seasonal'.length));

  const replaced = docText(state);
  const replacedMarks = marksSnapshot(state);
  assert.notEqual(replaced, original, 'Expected undo/redo fixture to change document text on the tracked replacement');
  assert.equal(undoDepth(state) >= 1, true, 'Expected tracked replacement to create an undoable history event');

  state = runHistoryUndo(state);
  assert.equal(docText(state), original, 'Expected undo to restore the original text before redo');
  assert.equal(getMarks(state).length, 0, 'Expected undo to clear tracked suggestions before redo');
  assert.equal(redoDepth(state) >= 1, true, 'Expected redo depth after undoing a tracked replacement');

  state = runHistoryRedo(state);
  assert.equal(docText(state), replaced, 'Expected redo to restore the tracked replacement text without corruption');
  assert.equal(marksSnapshot(state), replacedMarks, 'Expected redo to restore the tracked suggestion structure without duplication');

  state = runHistoryUndo(state);
  assert.equal(docText(state), original, 'Expected a second undo after redo to return cleanly to the original text');
  assert.equal(getMarks(state).length, 0, 'Expected a second undo after redo to clear the replacement suggestions cleanly');
}

async function run(): Promise<void> {
  setCurrentActor('human:user');
  const testState = await initTestState();

  runCrossParagraphCutPasteUndo(testState);
  runExecCommandReplacementUndo(testState);
  runLargeReplacementUndo(testState);
  runModeSwitchUndoStability(testState);
  runFragmentedSuggestionGrouping(testState);
  runUndoRedoStability(testState);

  console.log('track-changes-session36-qa-regression.test.ts passed');
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
