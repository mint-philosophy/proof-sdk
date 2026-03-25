import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state';

import { marksPluginKey, getMarks } from '../editor/plugins/marks.js';
import {
  __debugBuildAdjacentSplitInsertMergeTransaction,
  __debugResolveTrackedDeleteIntentFromBeforeInput,
  __debugResolveTrackedDeleteIntentForBeforeInput,
  __debugBuildPlainInsertionSuggestionFallbackTransaction,
  __debugBuildTextPreservingInsertPersistenceTransaction,
  __debugResolveTrackedDeleteRange,
  __debugResolveTrackedTextInputRange,
  __debugHasActiveInsertCoalescingCandidate,
  __debugHasRecentSuggestionsInsertCoalescingState,
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

  const authoredType = schema.marks.proofAuthored;
  state = createState();
  state = state.apply(
    state.tr.addMark(1, state.doc.content.size, authoredType.create({ by: 'human:Anonymous' }))
  );
  let compositionState = state.apply(state.tr.insertText(' brave', 18, 18));
  compositionState = compositionState.apply(
    compositionState.tr.addMark(18, 24, authoredType.create({ by: 'human:Anonymous' }))
  );
  const compositionFallbackTr = __debugBuildPlainInsertionSuggestionFallbackTransaction(state, compositionState);
  assert(compositionFallbackTr, 'Expected plain inserted text fallback to create a suggestion transaction');
  compositionState = compositionState.apply(compositionFallbackTr!);

  const compositionMarks = getMarks(compositionState).filter((mark) => mark.kind === 'insert');
  assertEqual(compositionMarks.length, 1, 'Composition fallback should create one insert suggestion');
  assertEqual(
    (compositionMarks[0]?.data as InsertData | undefined)?.content,
    ' brave',
    'Composition fallback should preserve the inserted text as a suggestion',
  );
  let insertedAuthoredCount = 0;
  compositionState.doc.nodesBetween(18, 24, (node) => {
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type.name === 'proofAuthored')) insertedAuthoredCount += 1;
    return true;
  });
  assertEqual(insertedAuthoredCount, 0, 'Composition fallback should strip authored marks from the inserted range');

  state = createState({ from: 18, to: 18 });
  state = state.apply(
    state.tr.addMark(1, state.doc.content.size, authoredType.create({ by: 'human:Anonymous' }))
  );
  for (const char of ['T', 'C', ' ']) {
    const pos = state.selection.from;
    state = state.apply(wrapTransactionForSuggestions(state.tr.insertText(char, pos, pos), state, true));
  }
  const authoredOverlapInsert = getMarks(state).find((mark) => mark.kind === 'insert');
  assert(authoredOverlapInsert?.range, 'Expected tracked typing to produce an insert mark after authored baseline content');
  let authoredLeakCount = 0;
  state.doc.nodesBetween(authoredOverlapInsert.range!.from, authoredOverlapInsert.range!.to, (node) => {
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type.name === 'proofAuthored')) authoredLeakCount += 1;
    return true;
  });
  assertEqual(authoredLeakCount, 0, 'Wrapped tracked typing should strip inherited authored marks from the full pending insert range');
  assertEqual(
    (authoredOverlapInsert.data as InsertData | undefined)?.content,
    'TC ',
    'Wrapped tracked typing should preserve whitespace inside the pending insert metadata',
  );
  assert(
    __debugHasActiveInsertCoalescingCandidate(state, state.selection.from),
    'A tracked insert that has grown to include trailing whitespace should still register as an active coalescing candidate at the live cursor',
  );
  assert(
    __debugHasRecentSuggestionsInsertCoalescingState(),
    'A tracked insert that has just coalesced trailing whitespace should keep recent insert-cache state alive for the next keystroke',
  );

  state = createState({ from: 18, to: 18 });
  state = state.apply(wrapTransactionForSuggestions(state.tr.insertText(' brave', 18, 18), state, true));
  const prePauseInsert = getMarks(state).find((mark) => mark.kind === 'insert');
  assert(prePauseInsert?.range, 'Expected pre-pause tracked insert range');
  const prePauseMetadata = { ...((marksPluginKey.getState(state) as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {}) };
  const pauseDeleteId = 'pause-delete';
  let pauseState = state.apply(
    state.tr
      .removeMark(prePauseInsert.range!.from, prePauseInsert.range!.to, schema.marks.proofSuggestion)
      .addMark(prePauseInsert.range!.from, prePauseInsert.range!.to, authoredType.create({ by: 'human:Anonymous' }))
      .addMark(
        prePauseInsert.range!.from,
        prePauseInsert.range!.to,
        schema.marks.proofSuggestion.create({ id: pauseDeleteId, kind: 'delete', by: 'human:Anonymous' })
      )
      .setMeta(marksPluginKey, {
        type: 'SET_METADATA',
        metadata: {
          ...Object.fromEntries(Object.entries(prePauseMetadata).filter(([id]) => id !== prePauseInsert.id)),
          [pauseDeleteId]: {
            kind: 'delete',
            by: 'human:Anonymous',
            createdAt: '2026-03-24T00:00:00.000Z',
            status: 'pending',
            quote: ' brave',
            range: { from: prePauseInsert.range!.from, to: prePauseInsert.range!.to },
          },
        },
      })
  );
  assertEqual(
    pauseState.doc.textContent,
    state.doc.textContent,
    'Pause-corruption fixture should preserve the same plain text while changing marks only',
  );
  assertEqual(
    getMarks(pauseState).filter((mark) => mark.kind === 'delete').length,
    1,
    'Pause-corruption fixture should produce one spurious delete suggestion',
  );
  const pausePersistenceFallbackTr = __debugBuildTextPreservingInsertPersistenceTransaction(state, pauseState);
  assert(pausePersistenceFallbackTr, 'Expected text-preserving rewrite fallback to restore the pending insert');
  pauseState = pauseState.apply(pausePersistenceFallbackTr!);

  const repairedPauseMarks = getMarks(pauseState);
  const repairedPauseInsertMarks = repairedPauseMarks.filter((mark) => mark.kind === 'insert');
  const repairedPauseDeleteMarks = repairedPauseMarks.filter((mark) => mark.kind === 'delete');
  assertEqual(repairedPauseInsertMarks.length, 1, 'Pause rewrite fallback should restore a single insert suggestion');
  assertEqual(repairedPauseDeleteMarks.length, 0, 'Pause rewrite fallback should remove the spurious delete suggestion');
  let repairedPauseAuthoredCount = 0;
  pauseState.doc.nodesBetween(prePauseInsert.range!.from, prePauseInsert.range!.to, (node) => {
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type.name === 'proofAuthored')) repairedPauseAuthoredCount += 1;
    return true;
  });
  assertEqual(repairedPauseAuthoredCount, 0, 'Pause rewrite fallback should strip authored marks from the restored insert range');

  state = createState({ from: 18, to: 18 });
  for (const char of 'TC para one from A.') {
    const pos = state.selection.from;
    state = state.apply(wrapTransactionForSuggestions(state.tr.insertText(char, pos, pos), state, true));
  }
  const splitGapOriginalInsert = getMarks(state).find((mark) => mark.kind === 'insert');
  assert(splitGapOriginalInsert?.range, 'Expected original tracked insert before split-gap rewrite');
  const splitGapOriginalMetadata = {
    ...((marksPluginKey.getState(state) as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {}),
  };
  const splitGapOriginalId = splitGapOriginalInsert.id;
  const splitGapText = 'TC para one from A.';
  const splitGapSecondId = 'split-gap-second-insert';
  const splitGapState = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha beta gamma.'),
        schema.text('TC', [schema.marks.proofSuggestion.create({
          id: splitGapOriginalId,
          kind: 'insert',
          by: 'unknown',
        })]),
        schema.text(' '),
        schema.text('para one from A.', [schema.marks.proofSuggestion.create({
          id: splitGapSecondId,
          kind: 'insert',
          by: 'unknown',
        })]),
      ]),
    ]),
    plugins: [marksStatePlugin],
  }).apply(EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha beta gamma.'),
        schema.text('TC', [schema.marks.proofSuggestion.create({
          id: splitGapOriginalId,
          kind: 'insert',
          by: 'unknown',
        })]),
        schema.text(' '),
        schema.text('para one from A.', [schema.marks.proofSuggestion.create({
          id: splitGapSecondId,
          kind: 'insert',
          by: 'unknown',
        })]),
      ]),
    ]),
    plugins: [marksStatePlugin],
  }).tr.setMeta(marksPluginKey, {
    type: 'SET_METADATA',
    metadata: {
      ...splitGapOriginalMetadata,
      [splitGapSecondId]: {
        kind: 'insert',
        by: 'unknown',
        createdAt: '2026-03-25T00:00:00.000Z',
        status: 'pending',
        content: 'para one from A.',
        range: { from: 21, to: 37 },
      },
    },
  }));
  assertEqual(
    splitGapState.doc.textContent,
    state.doc.textContent,
    'Split-gap fixture should preserve the same plain text while fragmenting the insert suggestion into two ids plus a bare space',
  );
  const splitGapPersistenceFallbackTr = __debugBuildTextPreservingInsertPersistenceTransaction(state, splitGapState);
  assert(splitGapPersistenceFallbackTr, 'Expected text-preserving rewrite fallback to merge a split insert gap back into the original suggestion');
  const repairedSplitGapState = splitGapState.apply(splitGapPersistenceFallbackTr!);
  const repairedSplitGapInsertMarks = getMarks(repairedSplitGapState).filter((mark) => mark.kind === 'insert');
  assertEqual(repairedSplitGapInsertMarks.length, 1, 'Split-gap rewrite fallback should leave a single insert suggestion');
  assertEqual(repairedSplitGapInsertMarks[0]?.id, splitGapOriginalId, 'Split-gap rewrite fallback should preserve the original insert mark id');
  assertEqual(
    (repairedSplitGapInsertMarks[0]?.data as InsertData | undefined)?.content,
    splitGapText,
    'Split-gap rewrite fallback should restore the full insert content including the space',
  );

  const splitDuringTypingOldState = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha beta gamma.'),
        schema.text('TC', [schema.marks.proofSuggestion.create({
          id: splitGapOriginalId,
          kind: 'insert',
          by: 'unknown',
        })]),
        schema.text(' '),
      ]),
    ]),
    plugins: [marksStatePlugin],
  }).apply(EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha beta gamma.'),
        schema.text('TC', [schema.marks.proofSuggestion.create({
          id: splitGapOriginalId,
          kind: 'insert',
          by: 'unknown',
        })]),
        schema.text(' '),
      ]),
    ]),
    plugins: [marksStatePlugin],
  }).tr.setMeta(marksPluginKey, {
    type: 'SET_METADATA',
    metadata: {
      [splitGapOriginalId]: {
        kind: 'insert',
        by: 'unknown',
        createdAt: '2026-03-25T00:00:00.000Z',
        status: 'pending',
        content: 'TC',
        range: { from: 18, to: 20 },
      },
    },
  }));
  const splitDuringTypingNewState = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha beta gamma.'),
        schema.text('TC', [schema.marks.proofSuggestion.create({
          id: splitGapOriginalId,
          kind: 'insert',
          by: 'unknown',
        })]),
        schema.text(' '),
        schema.text('para one from A.', [schema.marks.proofSuggestion.create({
          id: splitGapSecondId,
          kind: 'insert',
          by: 'unknown',
        })]),
      ]),
    ]),
    plugins: [marksStatePlugin],
  }).apply(EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha beta gamma.'),
        schema.text('TC', [schema.marks.proofSuggestion.create({
          id: splitGapOriginalId,
          kind: 'insert',
          by: 'unknown',
        })]),
        schema.text(' '),
        schema.text('para one from A.', [schema.marks.proofSuggestion.create({
          id: splitGapSecondId,
          kind: 'insert',
          by: 'unknown',
        })]),
      ]),
    ]),
    plugins: [marksStatePlugin],
  }).tr.setMeta(marksPluginKey, {
    type: 'SET_METADATA',
    metadata: {
      [splitGapOriginalId]: {
        kind: 'insert',
        by: 'unknown',
        createdAt: '2026-03-25T00:00:00.000Z',
        status: 'pending',
        content: 'TC',
        range: { from: 18, to: 20 },
      },
      [splitGapSecondId]: {
        kind: 'insert',
        by: 'unknown',
        createdAt: '2026-03-25T00:00:00.500Z',
        status: 'pending',
        content: 'para one from A.',
        range: { from: 21, to: 37 },
      },
    },
  }));
  const splitDuringTypingMergeTr = __debugBuildAdjacentSplitInsertMergeTransaction(
    splitDuringTypingOldState,
    splitDuringTypingNewState,
  );
  assert(splitDuringTypingMergeTr, 'Expected adjacent split insert merge to heal a bare-space split into a single pending insert');
  const healedSplitDuringTypingState = splitDuringTypingNewState.apply(splitDuringTypingMergeTr!);
  const healedSplitDuringTypingMarks = getMarks(healedSplitDuringTypingState).filter((mark) => mark.kind === 'insert');
  assertEqual(healedSplitDuringTypingMarks.length, 1, 'Adjacent split merge should leave one insert suggestion');
  assertEqual(healedSplitDuringTypingMarks[0]?.id, splitGapOriginalId, 'Adjacent split merge should preserve the original insert id');
  assertEqual(
    (healedSplitDuringTypingMarks[0]?.data as InsertData | undefined)?.content,
    splitGapText,
    'Adjacent split merge should restore the full pending insert content including the bare space gap',
  );

  const echoedSplitDuringTypingMergeTr = __debugBuildAdjacentSplitInsertMergeTransaction(
    splitDuringTypingNewState,
    splitDuringTypingNewState,
  );
  assert(
    echoedSplitDuringTypingMergeTr,
    'Adjacent split merge should still heal a recent same-actor pending/pending split after a collab echo resets the local coalescing cache',
  );
  const healedEchoedSplitDuringTypingState = splitDuringTypingNewState.apply(echoedSplitDuringTypingMergeTr!);
  const healedEchoedSplitDuringTypingMarks = getMarks(healedEchoedSplitDuringTypingState).filter((mark) => mark.kind === 'insert');
  assertEqual(
    healedEchoedSplitDuringTypingMarks.length,
    1,
    'Adjacent split merge should collapse recent pending/pending fragments created by a self-echo back to one insert suggestion',
  );
  assertEqual(
    healedEchoedSplitDuringTypingMarks[0]?.id,
    splitGapOriginalId,
    'Adjacent split merge should preserve the original insert id even when the old state already contains both pending fragments',
  );
  assertEqual(
    (healedEchoedSplitDuringTypingMarks[0]?.data as InsertData | undefined)?.content,
    splitGapText,
    'Adjacent split merge should restore the full pending insert content after a recent pending/pending self-echo split',
  );

  const collabChunkOriginalId = 'collab-chunk-original';
  const collabChunkSecondId = 'collab-chunk-second';
  const collabChunkState = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha beta gamma.'),
        schema.text('TC par', [schema.marks.proofSuggestion.create({
          id: collabChunkOriginalId,
          kind: 'insert',
          by: 'unknown',
        })]),
        schema.text('a one from', [schema.marks.proofSuggestion.create({
          id: collabChunkSecondId,
          kind: 'insert',
          by: 'unknown',
        })]),
        schema.text(' A.'),
      ]),
    ]),
    plugins: [marksStatePlugin],
  }).apply(EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha beta gamma.'),
        schema.text('TC par', [schema.marks.proofSuggestion.create({
          id: collabChunkOriginalId,
          kind: 'insert',
          by: 'unknown',
        })]),
        schema.text('a one from', [schema.marks.proofSuggestion.create({
          id: collabChunkSecondId,
          kind: 'insert',
          by: 'unknown',
        })]),
        schema.text(' A.'),
      ]),
    ]),
    plugins: [marksStatePlugin],
  }).tr.setMeta(marksPluginKey, {
    type: 'SET_METADATA',
    metadata: {
      [collabChunkOriginalId]: {
        kind: 'insert',
        by: 'unknown',
        createdAt: new Date(Date.now() - 200).toISOString(),
        status: 'pending',
        content: 'TC par',
        range: { from: 18, to: 24 },
      },
      [collabChunkSecondId]: {
        kind: 'insert',
        by: 'unknown',
        createdAt: new Date(Date.now() - 100).toISOString(),
        status: 'pending',
        content: 'a one from',
        range: { from: 24, to: 34 },
      },
    },
  }));
  const healedCollabChunkTr = __debugBuildAdjacentSplitInsertMergeTransaction(
    collabChunkState,
    collabChunkState,
  );
  assert(healedCollabChunkTr, 'Expected collab chunk merge to heal adjacent insert fragments and a short bare tail');
  const healedCollabChunkState = collabChunkState.apply(healedCollabChunkTr!);
  const healedCollabChunkMarks = getMarks(healedCollabChunkState).filter((mark) => mark.kind === 'insert');
  assertEqual(healedCollabChunkMarks.length, 1, 'Collab chunk merge should leave one insert suggestion');
  assertEqual(healedCollabChunkMarks[0]?.id, collabChunkOriginalId, 'Collab chunk merge should preserve the first insert id');
  assertEqual(
    (healedCollabChunkMarks[0]?.data as InsertData | undefined)?.content,
    'TC para one from A.',
    'Collab chunk merge should absorb adjacent marked chunks and the short plain tail into one insert suggestion',
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

    let staleDomState = createState({ from: 18, to: 18 });
    for (const char of [' ', 'b', 'r', 'a', 'v', 'e']) {
      const pos = staleDomState.selection.from;
      staleDomState = staleDomState.apply(
        wrapTransactionForSuggestions(staleDomState.tr.insertText(char, pos, pos), staleDomState, true)
      );
      now += 900;
    }

    const coalescedInsert = getMarks(staleDomState).find((mark) => mark.kind === 'insert');
    assert(coalescedInsert?.range, 'Expected tracked insert range after coalesced typing');
    staleDomState = staleDomState.apply(
      staleDomState.tr.setSelection(TextSelection.create(staleDomState.doc, coalescedInsert.range!.to))
    );
    for (const char of ' wow') {
      const staleDomPos = coalescedInsert.range!.from;
      const resolvedRange = __debugResolveTrackedTextInputRange(staleDomState, staleDomPos, staleDomPos);
      staleDomState = staleDomState.apply(
        wrapTransactionForSuggestions(staleDomState.tr.insertText(char, resolvedRange.from, resolvedRange.to), staleDomState, true)
      );
      now += 900;
    }

    const staleDomInsertMarks = getMarks(staleDomState).filter((mark) => mark.kind === 'insert');
    assertEqual(staleDomInsertMarks.length, 1, 'Stale DOM text-input positions inside a pending insert should still extend the same insert suggestion');
    assertEqual(
      staleDomState.doc.textContent,
      'Alpha beta gamma. brave wow',
      'Typing with stale DOM insert positions should append text in forward order instead of reversing it',
    );
    assertEqual(
      (staleDomInsertMarks[0]?.data as InsertData | undefined)?.content,
      ' brave wow',
      'Stale DOM text-input positions should keep insert metadata aligned with the forward-typed content',
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
    for (const char of ['a', 'b']) {
      const pos = state.selection.from;
      state = state.apply(wrapTransactionForSuggestions(state.tr.insertText(char, pos, pos), state, true));
      now += 100;
    }

    const appendPos = state.selection.from;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, appendPos - 2)));
    state = state.apply(
      wrapTransactionForSuggestions(state.tr.insertText('c', appendPos, appendPos), state, true)
    );

    assertEqual(
      state.selection.from,
      appendPos + 1,
      'Tracked append should move the cursor to the end of the coalesced insert even if the prior editor selection was stale',
    );

    const continuePos = state.selection.from;
    state = state.apply(
      wrapTransactionForSuggestions(state.tr.insertText('d', continuePos, continuePos), state, true)
    );

    const staleSelectionInsertMarks = getMarks(state).filter((mark) => mark.kind === 'insert');
    assertEqual(
      state.doc.textContent,
      'Alpha beta gamma.abcd',
      'Typing after a stale-selection append should continue at the end of the insert instead of prepending and reversing characters',
    );
    assertEqual(staleSelectionInsertMarks.length, 1, 'Stale-selection typing should keep a single coalesced insert suggestion');
    assertEqual(
      (staleSelectionInsertMarks[0]?.data as InsertData | undefined)?.content,
      'abcd',
      'Stale-selection typing should preserve insert content in forward typing order',
    );

    state = createState({ from: 18, to: 18 });
    let composedText = '';
    for (const nextText of ['t', 'th', 'thi', 'this', 'this ', 'this i', 'this is']) {
      const compositionTr = state.tr.insertText(nextText, 18, 18 + composedText.length);
      state = state.apply(wrapTransactionForSuggestions(compositionTr, state, true));
      composedText = nextText;
      now += 100;
    }

    const compositionInsertMarks = getMarks(state).filter((mark) => mark.kind === 'insert');
    assertEqual(
      compositionInsertMarks.length,
      1,
      'Composition-style replacement updates should remain a single insert suggestion',
    );
    assertEqual(
      state.doc.textContent,
      'Alpha beta gamma.this is',
      'Composition-style replacement updates should converge on the final committed text without duplicates',
    );
    assertEqual(
      (compositionInsertMarks[0]?.data as InsertData | undefined)?.content,
      'this is',
      'Composition-style replacement updates should keep insert metadata aligned with the latest committed text',
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
    const staleDeleteIntent = __debugResolveTrackedDeleteIntentForBeforeInput('insertText', {
      key: 'Backspace',
      modifiers: { altKey: true },
    });
    assertEqual(
      staleDeleteIntent,
      null,
      'Non-delete beforeinput events should ignore stale modified-delete intents so the next typed character is not swallowed',
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
