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

  const corruptedSegments = collectSuggestionSegments(corruptedState.doc, 'insert-1', 'insert');
  assert.equal(
    getSuggestionTextFromSegments(corruptedSegments),
    'This REMOTE is a collab test insertion.',
    'Expected the simulated collab corruption to fold the remote text into the insert suggestion',
  );

  const repair = buildRemoteInsertSuggestionBoundaryRepair(initialState, corruptedState);
  assert(repair, 'Expected remote insert suggestion repair to detect the inherited mark');

  const repairedState = corruptedState.apply(repair!.transaction);
  const repairedSegments = collectSuggestionSegments(repairedState.doc, 'insert-1', 'insert');
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
    'insert-1': {
      kind: 'insert',
      by: 'user:test',
      status: 'pending',
      content: 'This REMOTE is a collab test insertion.',
      quote: 'This REMOTE is a collab test insertion.',
    },
  }, ['insert-1']);

  assert.equal(
    syncedMetadata['insert-1']?.content,
    'This is a collab test insertion.',
    'Expected metadata repair to preserve only the tracked insert text, not the interleaved remote text',
  );
  assert.equal(
    syncedMetadata['insert-1']?.quote,
    'This is a collab test insertion.',
    'Expected metadata repair to keep the serialized insert quote aligned with the repaired live text',
  );

  const growingInsertMetadata = {
    'insert-1': {
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

  const insertLength = getInsertLength(initialState, 'insert-1');
  const appendPos = insertStart + insertLength;
  const appendEchoTr = initialState.tr.insertText('!', appendPos, appendPos);
  const appendEchoMarked = appendEchoTr.addMark(
    appendPos,
    appendPos + 1,
    schema.marks.proofSuggestion.create({
      id: 'insert-1',
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
      'insert-1': {
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

  console.log('suggestion-boundaries-collab-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
