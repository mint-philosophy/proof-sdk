import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state';

import { marksPluginKey } from '../editor/plugins/marks.js';
import {
  buildRemoteInsertSuggestionBoundaryRepair,
  collectSuggestionSegments,
  getSuggestionTextFromSegments,
  syncInsertSuggestionMetadataFromDoc,
} from '../editor/plugins/suggestion-boundaries.js';

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
    proofAuthored: {
      attrs: {
        by: { default: 'unknown' },
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
      return value;
    },
  },
});

function createMarkedState(): EditorState {
  const insertMark = schema.marks.proofSuggestion.create({
    id: 'insert-1',
    kind: 'insert',
    by: 'user:test',
    status: 'pending',
    content: 'This is a collab test insertion.',
  });

  return EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha '),
        schema.text('This is a collab test insertion.', [insertMark]),
        schema.text(' beta gamma.'),
      ]),
    ]),
    plugins: [marksStatePlugin],
  });
}

function getInsertLength(state: EditorState, id: string): number {
  return getSuggestionTextFromSegments(collectSuggestionSegments(state.doc, id, 'insert'))?.length ?? 0;
}

function run(): void {
  const initialState = createMarkedState();
  const insertStart = 7;
  const suggestionId = 'insert-1';
  const corruptFrom = insertStart + 'This '.length;
  const corruptText = 'REMOTE ';

  let corruptedTr = initialState.tr.insertText(corruptText, corruptFrom, corruptFrom);
  corruptedTr = corruptedTr.addMark(
    corruptFrom,
    corruptFrom + corruptText.length,
    schema.marks.proofSuggestion.create({
      id: 'insert-1',
      kind: 'insert',
      by: 'user:test',
      status: 'pending',
      content: 'This is a collab test insertion.',
    }),
  );
  const corruptedState = initialState.apply(corruptedTr);

  const corruptedSegments = collectSuggestionSegments(corruptedState.doc, suggestionId, 'insert');
  assert.equal(
    getSuggestionTextFromSegments(corruptedSegments),
    'This REMOTE is a collab test insertion.',
    'Expected the simulated collab corruption to fold the remote text into the insert suggestion',
  );

  const repair = buildRemoteInsertSuggestionBoundaryRepair(initialState, corruptedState);
  assert(repair, 'Expected remote insert suggestion repair to detect the inherited mark');

  const repairedState = corruptedState.apply(repair!.transaction);
  const repairedSegments = collectSuggestionSegments(repairedState.doc, suggestionId, 'insert');
  assert.equal(repairedSegments.length, 2, 'Expected repair to split the suggestion around the remote plain-text insertion');
  assert.equal(
    getSuggestionTextFromSegments(repairedSegments),
    'This is a collab test insertion.',
    'Expected suggestion text extraction to ignore the interleaved remote plain text',
  );
  assert.equal(
    repairedState.doc.textContent,
    'Alpha This REMOTE is a collab test insertion. beta gamma.',
    'Expected the plain remote text to remain in the document after stripping inherited suggestion marks',
  );

  const syncedMetadata = syncInsertSuggestionMetadataFromDoc(repairedState.doc, {
    [suggestionId]: {
      kind: 'insert',
      by: 'user:test',
      status: 'pending',
      content: 'This REMOTE is a collab test insertion.',
      quote: 'This REMOTE is a collab test insertion.',
    },
  }, ['insert-1']);

  assert.equal(
    syncedMetadata[suggestionId]?.content,
    'This is a collab test insertion.',
    'Expected metadata repair to preserve only the tracked insert text, not the interleaved remote text',
  );
  assert.equal(
    syncedMetadata[suggestionId]?.quote,
    'This is a collab test insertion.',
    'Expected metadata repair to keep the serialized insert quote aligned with the repaired live text',
  );

  const growingInsertMetadata = {
    [suggestionId]: {
      kind: 'insert' as const,
      by: 'user:test',
      status: 'pending' as const,
      content: 'This REMOTE is a collab test insertion.',
      quote: 'This REMOTE is a collab test insertion.',
    },
  };
  const skippedRepair = buildRemoteInsertSuggestionBoundaryRepair(initialState, corruptedState, growingInsertMetadata);
  assert.equal(
    skippedRepair,
    null,
    'Expected boundary repair to ignore legitimate insert growth when local metadata already matches the expanded insert text',
  );

  const insertLength = getInsertLength(initialState, suggestionId);
  const appendPos = insertStart + insertLength;
  const appendEchoTr = initialState.tr.insertText('!', appendPos, appendPos);
  const appendEchoMarked = appendEchoTr.addMark(
    appendPos,
    appendPos + 1,
    schema.marks.proofSuggestion.create({
      id: suggestionId,
      kind: 'insert',
      by: 'user:test',
      status: 'pending',
      content: 'This is a collab test insertion.',
    }),
  );
  const localEchoState = initialState.apply(
    appendEchoMarked.setSelection(TextSelection.create(appendEchoMarked.doc, appendPos + 1))
  );
  const staleMetadataRepair = buildRemoteInsertSuggestionBoundaryRepair(
    initialState,
    localEchoState,
    {
      [suggestionId]: {
        kind: 'insert',
        by: 'user:test',
        status: 'pending',
        content: 'This is a collab test insertion.',
        quote: 'This is a collab test insertion.',
      },
    },
    {
      preferLocalInsertGrowthAtSelection: true,
      localSelectionFrom: appendPos,
      localSelectionEmpty: true,
    },
  );
  assert.equal(
    staleMetadataRepair,
    null,
    'Expected boundary repair to ignore a recent local self-echo append even when metadata still lags behind the expanded insert text',
  );

  const authoredMark = schema.marks.proofAuthored.create({ by: 'human:test' });
  const fragmentedOldState = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha '),
        schema.text('TC para one from A.', [schema.marks.proofSuggestion.create({
          id: suggestionId,
          kind: 'insert',
          by: 'user:test',
          status: 'pending',
        })]),
        schema.text(' beta gamma.'),
      ]),
    ]),
    plugins: [marksStatePlugin],
  });
  const fragmentedState = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha '),
        schema.text('TC', [schema.marks.proofSuggestion.create({
          id: suggestionId,
          kind: 'insert',
          by: 'user:test',
          status: 'pending',
        })]),
        schema.text(' ', [authoredMark]),
        schema.text('par', [schema.marks.proofSuggestion.create({
          id: suggestionId,
          kind: 'insert',
          by: 'user:test',
          status: 'pending',
        })]),
        schema.text('a', [authoredMark]),
        schema.text(' one from A.', [schema.marks.proofSuggestion.create({
          id: suggestionId,
          kind: 'insert',
          by: 'user:test',
          status: 'pending',
        })]),
        schema.text(' beta gamma.'),
      ]),
    ]),
    plugins: [marksStatePlugin],
  });
  const fragmentedRepair = buildRemoteInsertSuggestionBoundaryRepair(
    fragmentedOldState,
    fragmentedState,
    {
      [suggestionId]: {
        kind: 'insert',
        by: 'user:test',
        status: 'pending',
        content: 'TC para one from A.',
        quote: 'TC para one from A.',
      },
    },
    {
      preferLocalInsertGrowthAtSelection: true,
      localSelectionFrom: 7 + 'TC para'.length,
      localSelectionEmpty: true,
    },
  );
  assert(fragmentedRepair, 'Expected boundary repair to restore missing suggestion coverage for authored gap fragments inside a recent local insert');
  const repairedFragmentedState = fragmentedState.apply(fragmentedRepair!.transaction);
  const repairedFragmentedText = getSuggestionTextFromSegments(collectSuggestionSegments(repairedFragmentedState.doc, suggestionId, 'insert'));
  assert.equal(
    repairedFragmentedText,
    'TC para one from A.',
    'Expected boundary repair to rehydrate authored gap fragments back into the pending insert suggestion',
  );

  const disappearedInsertOldState = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha beta gamma.', [authoredMark]),
        schema.text('Y', [schema.marks.proofSuggestion.create({
          id: suggestionId,
          kind: 'insert',
          by: 'user:test',
          status: 'pending',
        })]),
      ]),
    ]),
    selection: TextSelection.create(
      schema.node('doc', null, [
        schema.node('paragraph', null, [
          schema.text('Alpha beta gamma.', [authoredMark]),
          schema.text('Y', [schema.marks.proofSuggestion.create({
            id: suggestionId,
            kind: 'insert',
            by: 'user:test',
            status: 'pending',
          })]),
        ]),
      ]),
      19,
      19,
    ),
    plugins: [marksStatePlugin],
  });
  const disappearedInsertNewState = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha beta gamma.', [authoredMark]),
        schema.text('Y'),
      ]),
    ]),
    selection: TextSelection.create(
      schema.node('doc', null, [
        schema.node('paragraph', null, [
          schema.text('Alpha beta gamma.', [authoredMark]),
          schema.text('Y'),
        ]),
      ]),
      19,
      19,
    ),
    plugins: [marksStatePlugin],
  });
  const disappearedInsertRepair = buildRemoteInsertSuggestionBoundaryRepair(
    disappearedInsertOldState,
    disappearedInsertNewState,
    {
      [suggestionId]: {
        kind: 'insert',
        by: 'user:test',
        status: 'pending',
        content: 'Y',
        quote: 'Y',
        range: { from: 18, to: 19 },
      },
    },
    {
      preferLocalInsertGrowthAtSelection: true,
      localSelectionFrom: 19,
      localSelectionEmpty: true,
    },
  );
  assert(
    disappearedInsertRepair,
    'Expected boundary repair to restore a recent local insert when a remote self-echo drops the live insert marks entirely',
  );
  const disappearedInsertRepairedState = disappearedInsertNewState.apply(disappearedInsertRepair!.transaction);
  const disappearedSegments = collectSuggestionSegments(disappearedInsertRepairedState.doc, suggestionId, 'insert');
  assert.equal(
    getSuggestionTextFromSegments(disappearedSegments),
    'Y',
    'Expected boundary repair to reapply the missing insert mark onto the existing native text instead of leaving a bare duplicate',
  );
  assert.equal(
    disappearedInsertRepairedState.doc.textContent,
    'Alpha beta gamma.Y',
    'Expected disappeared-insert repair to preserve exactly one typed character in the document',
  );

  console.log('suggestion-boundaries-collab-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
