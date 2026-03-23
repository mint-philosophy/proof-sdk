import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state';

import { marksPluginKey, getMarks } from '../editor/plugins/marks.js';
import {
  __debugResolveTrackedDeleteIntentFromBeforeInput,
  __debugResolveTrackedDeleteIntentForBeforeInput,
  __debugResolveTrackedDeleteRange,
  wrapTransactionForSuggestions,
} from '../editor/plugins/suggestions.js';
import type { InsertData } from '../formats/marks.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function getSuggestionMarkAttrContentById(state: EditorState, kind: 'insert' | 'delete' | 'replace'): Map<string, string | null> {
  const result = new Map<string, string | null>();
  state.doc.descendants((node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== 'proofSuggestion') continue;
      if (mark.attrs.kind !== kind) continue;
      const id = typeof mark.attrs.id === 'string' ? mark.attrs.id : '';
      if (!id || result.has(id)) continue;
      result.set(id, typeof mark.attrs.content === 'string' ? mark.attrs.content : null);
    }
    return true;
  });
  return result;
}

function run(): void {
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
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  const createState = (selection?: { from: number; to: number }) => EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Alpha beta gamma.')]),
    ]),
    plugins: [marksStatePlugin],
    ...(selection ? { selection: TextSelection.create(
      schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text('Alpha beta gamma.')]),
      ]),
      selection.from,
      selection.to,
    ) } : {}),
  });

  let state = createState();

  const rawTr = state.tr.insertText('del', 7, 11);
  rawTr.insertText('ta', 10, 10);

  const wrapped = wrapTransactionForSuggestions(rawTr, state, true);
  state = state.apply(wrapped);

  const marks = getMarks(state);
  const insertMarks = marks.filter((mark) => mark.kind === 'insert');
  const deleteMarks = marks.filter((mark) => mark.kind === 'delete');
  const replaceMarks = marks.filter((mark) => mark.kind === 'replace');

  assertEqual(replaceMarks.length, 0, 'Replacement typing should decompose instead of leaving a replace mark');
  assertEqual(deleteMarks.length, 1, 'Replacement typing should create one delete mark');
  assertEqual(deleteMarks[0]?.quote, 'beta', 'Delete mark should preserve the original deleted text');
  assertEqual(insertMarks.length, 1, 'Replacement typing should coalesce into one insert mark');
  assertEqual(
    (insertMarks[0]?.data as InsertData | undefined)?.content,
    'delta',
    'Split replacement typing should coalesce inserted characters into one insert mark',
  );

  state = createState({ from: 7, to: 11 });
  const browserDiffTr = state.tr.insertText('del', 7, 9);
  const browserWrapped = wrapTransactionForSuggestions(browserDiffTr, state, true);
  assert(browserWrapped.getMeta('suggestions-wrapped') === true, 'Selection replacement should mark the transaction as suggestions-wrapped');
  state = state.apply(browserWrapped);

  const browserMarks = getMarks(state);
  const browserInsertMarks = browserMarks.filter((mark) => mark.kind === 'insert');
  const browserDeleteMarks = browserMarks.filter((mark) => mark.kind === 'delete');

  assertEqual(browserDeleteMarks.length, 1, 'Selection replacement should still create one delete mark');
  assertEqual(
    browserDeleteMarks[0]?.quote,
    'beta',
    'Selection replacement should preserve the full selected text even when the browser keeps a shared suffix unchanged',
  );
  assertEqual(browserInsertMarks.length, 1, 'Selection replacement should still create one insert mark');
  assertEqual(
    (browserInsertMarks[0]?.data as InsertData | undefined)?.content,
    'delta',
    'Selection replacement should preserve the full replacement text even when the browser only reports the changed diff',
  );

  const originalDateNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    state = createState({ from: 18, to: 18 });
    for (const char of [' ', 'b', 'r', 'a', 'v', 'e']) {
      const pos = state.selection.from;
      const insertTr = state.tr.insertText(char, pos, pos);
      const wrappedInsertTr = wrapTransactionForSuggestions(insertTr, state, true);
      state = state.apply(wrappedInsertTr);
      now += 900;
    }

    const delayedInsertMarks = getMarks(state).filter((mark) => mark.kind === 'insert');
    assertEqual(delayedInsertMarks.length, 1, 'Adjacent typing with short pauses should still coalesce into one insert suggestion');
    assertEqual(
      state.doc.textContent,
      'Alpha beta gamma. brave',
      'Rapid tracked typing should update the document text once without duplicating the inserted content',
    );
    assertEqual(
      (delayedInsertMarks[0]?.data as InsertData | undefined)?.content,
      ' brave',
      'Coalesced insert suggestion should preserve the full inserted content after short pauses',
    );

    const deletePos = state.selection.from;
    state = state.apply(
      wrapTransactionForSuggestions(state.tr.delete(deletePos - 1, deletePos), state, true)
    );

    const afterBackspaceMarks = getMarks(state).filter((mark) => mark.kind === 'insert');
    assertEqual(afterBackspaceMarks.length, 1, 'Backspacing inside a pending insert should keep a single insert suggestion');
    assertEqual(
      state.doc.textContent,
      'Alpha beta gamma. brav',
      'Backspacing inside a pending insert should remove one character from document text',
    );
    assertEqual(
      (afterBackspaceMarks[0]?.data as InsertData | undefined)?.content,
      ' brav',
      'Backspacing inside a pending insert should update the insert metadata instead of leaving stale content behind',
    );

    now += 6000;
    const resumePos = state.selection.from;
    state = state.apply(
      wrapTransactionForSuggestions(state.tr.insertText('e', resumePos, resumePos), state, true)
    );

    const resumedInsertMarks = getMarks(state).filter((mark) => mark.kind === 'insert');
    assertEqual(resumedInsertMarks.length, 1, 'Typing after backspace should continue the same insert suggestion even after the cache window expires');
    assertEqual(
      state.doc.textContent,
      'Alpha beta gamma. brave',
      'Retyping after backspace should restore the intended document text once',
    );
    assertEqual(
      (resumedInsertMarks[0]?.data as InsertData | undefined)?.content,
      ' brave',
      'Typing after backspace should repair the existing insert suggestion instead of creating a second fragment',
    );

    const resumedInsertAttrContent = [...getSuggestionMarkAttrContentById(state, 'insert').values()][0];
    assertEqual(
      resumedInsertAttrContent,
      ' brave',
      'Typing after backspace should also keep the underlying insert mark attrs in sync with the live insert text',
    );

    state = createState({ from: 18, to: 18 });
    for (const char of ' This is the problem') {
      const pos = state.selection.from;
      state = state.apply(wrapTransactionForSuggestions(state.tr.insertText(char, pos, pos), state, true));
      now += 900;
    }

    const insertDeleteRange = __debugResolveTrackedDeleteRange(state, 'Backspace', { altKey: true });
    assert(insertDeleteRange, 'Expected Option+Delete to resolve a range inside the pending insert');
    state = state.apply(wrapTransactionForSuggestions(state.tr.delete(insertDeleteRange!.from, insertDeleteRange!.to), state, true));

    const optionDeleteInsertMarks = getMarks(state).filter((mark) => mark.kind === 'insert');
    const optionDeleteDeleteMarks = getMarks(state).filter((mark) => mark.kind === 'delete');
    assertEqual(optionDeleteDeleteMarks.length, 0, 'Option+Delete inside a pending insert should not create a delete suggestion');
    assertEqual(optionDeleteInsertMarks.length, 1, 'Option+Delete inside a pending insert should keep the existing insert suggestion');
    assertEqual(
      state.doc.textContent,
      'Alpha beta gamma. This is the ',
      'Option+Delete should remove only the trailing word from the pending insert',
    );
    assertEqual(
      (optionDeleteInsertMarks[0]?.data as InsertData | undefined)?.content,
      ' This is the ',
      'Option+Delete should keep insert metadata aligned with the shortened insert text',
    );
    const optionDeleteInsertAttrContent = [...getSuggestionMarkAttrContentById(state, 'insert').values()][0];
    assertEqual(
      optionDeleteInsertAttrContent,
      ' This is the ',
      'Option+Delete should also keep the underlying insert mark attrs aligned with the shortened insert text',
    );

    state = createState({ from: 18, to: 18 });
    for (const char of ' This is the problem') {
      const pos = state.selection.from;
      state = state.apply(wrapTransactionForSuggestions(state.tr.insertText(char, pos, pos), state, true));
      now += 900;
    }

    const mixedLineDeleteRange = __debugResolveTrackedDeleteRange(state, 'Backspace', { metaKey: true });
    assert(mixedLineDeleteRange, 'Expected Cmd+Delete to resolve a range across original text plus the pending insert');
    state = state.apply(wrapTransactionForSuggestions(state.tr.delete(mixedLineDeleteRange!.from, mixedLineDeleteRange!.to), state, true));

    const mixedLineDeleteInsertMarks = getMarks(state).filter((mark) => mark.kind === 'insert');
    const mixedLineDeleteMarks = getMarks(state).filter((mark) => mark.kind === 'delete');
    assertEqual(mixedLineDeleteInsertMarks.length, 0, 'Cmd+Delete across original text and a pending insert should remove the pending insert');
    assertEqual(mixedLineDeleteMarks.length, 1, 'Cmd+Delete across original text and a pending insert should create a delete suggestion for the original text');
    assertEqual(
      mixedLineDeleteMarks[0]?.quote,
      'Alpha beta gamma.',
      'Cmd+Delete across original text and a pending insert should preserve the original text as the delete quote',
    );
    assertEqual(
      state.doc.textContent,
      'Alpha beta gamma.',
      'Cmd+Delete across original text and a pending insert should leave only the tracked deleted original text in the document',
    );

    state = createState({ from: 7, to: 11 });
    const firstReplacementTr = state.tr.insertText('d', 7, 11);
    firstReplacementTr.setMeta('proof-dom-selection-range', { from: 7, to: 11 });
    state = state.apply(wrapTransactionForSuggestions(firstReplacementTr, state, true));

    const afterFirstReplacementMarks = getMarks(state);
    const replacementDelete = afterFirstReplacementMarks.find((mark) => mark.kind === 'delete');
    assert(replacementDelete?.range, 'Expected first replacement keystroke to create a delete range');

    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, replacementDelete.range!.to))
    );

    for (const char of ['e', 'l', 't', 'a']) {
      const pos = state.selection.from;
      const continuationTr = state.tr.insertText(char, pos, pos);
      state = state.apply(wrapTransactionForSuggestions(continuationTr, state, true));
      now += 900;
    }

    const replacementContinuationMarks = getMarks(state);
    const continuationInsertMarks = replacementContinuationMarks.filter((mark) => mark.kind === 'insert');
    const continuationDeleteMarks = replacementContinuationMarks.filter((mark) => mark.kind === 'delete');
    assertEqual(continuationDeleteMarks.length, 1, 'Replacement continuation should retain a single delete suggestion');
    assertEqual(continuationInsertMarks.length, 1, 'Replacement continuation should keep a single insert suggestion');
    assertEqual(
      (continuationInsertMarks[0]?.data as InsertData | undefined)?.content,
      'delta',
      'Typing after the cursor drifts beyond the delete span should still extend the replacement insert before the pending deletion',
    );

    state = createState({ from: 11, to: 11 });
    const wordDeleteRange = __debugResolveTrackedDeleteRange(state, 'Backspace', { altKey: true });
    assertEqual(wordDeleteRange?.from, 7, 'Option+Delete should resolve to the start of the previous word');
    assertEqual(wordDeleteRange?.to, 11, 'Option+Delete should resolve to the cursor position');
    const wordDeleteIntent = __debugResolveTrackedDeleteIntentFromBeforeInput('deleteWordBackward');
    assertEqual(wordDeleteIntent?.key, 'Backspace', 'deleteWordBackward should map to backward tracked deletion');
    assertEqual(wordDeleteIntent?.modifiers?.altKey, true, 'deleteWordBackward should preserve alt/word-delete semantics');
    state = state.apply(wrapTransactionForSuggestions(state.tr.delete(wordDeleteRange!.from, wordDeleteRange!.to), state, true));
    const wordDeleteMarks = getMarks(state).filter((mark) => mark.kind === 'delete');
    assertEqual(wordDeleteMarks.length, 1, 'Option+Delete should become one delete suggestion');
    assertEqual(wordDeleteMarks[0]?.quote, 'beta', 'Option+Delete should preserve the deleted word');

    state = createState({ from: 11, to: 11 });
    const lineDeleteRange = __debugResolveTrackedDeleteRange(state, 'Backspace', { metaKey: true });
    assertEqual(lineDeleteRange?.from, 1, 'Cmd+Delete should resolve to the start of the textblock');
    assertEqual(lineDeleteRange?.to, 11, 'Cmd+Delete should resolve to the cursor position');
    const lineDeleteIntent = __debugResolveTrackedDeleteIntentFromBeforeInput('deleteSoftLineBackward');
    assertEqual(lineDeleteIntent?.key, 'Backspace', 'deleteSoftLineBackward should map to backward tracked deletion');
    assertEqual(lineDeleteIntent?.modifiers?.metaKey, true, 'deleteSoftLineBackward should preserve line-delete semantics');
    const fallbackLineDeleteIntent = __debugResolveTrackedDeleteIntentForBeforeInput('deleteContentBackward', {
      key: 'Backspace',
      modifiers: { metaKey: true },
    });
    assertEqual(
      fallbackLineDeleteIntent?.modifiers?.metaKey,
      true,
      'Generic deleteContentBackward should reuse the pending modifier intent so Cmd+Delete can still be ignored',
    );
    state = state.apply(wrapTransactionForSuggestions(state.tr.delete(lineDeleteRange!.from, lineDeleteRange!.to), state, true));
    const lineDeleteMarks = getMarks(state).filter((mark) => mark.kind === 'delete');
    assertEqual(lineDeleteMarks.length, 1, 'Cmd+Delete should become one delete suggestion');
    assertEqual(lineDeleteMarks[0]?.quote, 'Alpha beta', 'Cmd+Delete should preserve the deleted textblock prefix');
  } finally {
    Date.now = originalDateNow;
  }

  console.log('✓ replacement typing decomposes into delete + coalesced insert suggestions');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
