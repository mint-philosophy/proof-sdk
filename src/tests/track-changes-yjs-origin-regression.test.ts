import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';

import { getMarks, marksPluginKey } from '../editor/plugins/marks.js';
import { transactionCarriesInsertedSuggestionMarks, wrapTransactionForSuggestions } from '../editor/plugins/suggestions.js';
import { getYjsTransactionOriginInfo, isExplicitYjsChangeOriginTransaction } from '../editor/plugins/transaction-origins.js';

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

function createState(): EditorState {
  return EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Alpha beta gamma.')]),
    ]),
    plugins: [marksStatePlugin],
  });
}

function run(): void {
  let state = createState();

  const localInsert = wrapTransactionForSuggestions(state.tr.insertText('x', 7, 7), state, true);
  state = state.apply(localInsert);
  assert.equal(getMarks(state).filter((mark) => mark.kind === 'insert').length, 1);

  const echoed = state.tr.insertText('y', state.selection.from, state.selection.from);
  const echoedWithRawYjsMeta = echoed as typeof echoed & { meta?: Record<string, unknown> };
  echoedWithRawYjsMeta.meta = {
    ...(echoedWithRawYjsMeta.meta ?? {}),
    'y-sync$': {},
  };

  const origin = getYjsTransactionOriginInfo(echoedWithRawYjsMeta);
  assert.equal(origin.isYjsOrigin, true, 'Expected raw y-sync meta to classify as Yjs-origin even without plugin-key resolution');
  assert.equal(origin.source, 'raw-meta-key', 'Expected raw y-sync key presence to explain the origin classification');
  assert.equal(
    isExplicitYjsChangeOriginTransaction(echoedWithRawYjsMeta),
    false,
    'Expected raw y-sync meta without isChangeOrigin not to bypass Track Changes wrapping',
  );

  const wrappedEcho = wrapTransactionForSuggestions(echoedWithRawYjsMeta, state, true);
  assert.notEqual(wrappedEcho, echoedWithRawYjsMeta, 'Expected raw y-sync meta without isChangeOrigin to still be wrapped for Track Changes');
  assert.equal(wrappedEcho.getMeta('suggestions-wrapped'), true, 'Expected raw y-sync meta without isChangeOrigin to produce suggestions-wrapped output');

  const echoedWithChangeOrigin = state.tr.insertText('z', state.selection.from, state.selection.from) as typeof echoed & {
    meta?: Record<string, unknown>;
  };
  echoedWithChangeOrigin.meta = {
    ...(echoedWithChangeOrigin.meta ?? {}),
    'y-sync$': { isChangeOrigin: true },
  };

  assert.equal(
    isExplicitYjsChangeOriginTransaction(echoedWithChangeOrigin),
    true,
    'Expected explicit isChangeOrigin transactions to keep bypassing Track Changes wrapping',
  );
  const wrappedChangeOriginEcho = wrapTransactionForSuggestions(echoedWithChangeOrigin, state, true);
  assert.equal(wrappedChangeOriginEcho, echoedWithChangeOrigin, 'Expected raw isChangeOrigin Yjs echoes to bypass track-changes wrapping');

  const remoteSuggestionMark = schema.marks.proofSuggestion.create({
    id: 'remote-insert',
    kind: 'insert',
    by: 'human:peer',
    status: 'pending',
  });
  const rawRemoteSuggestionEcho = state.tr.replaceWith(
    state.selection.from,
    state.selection.from,
    schema.text('q', [remoteSuggestionMark]),
  ) as typeof echoed & {
    meta?: Record<string, unknown>;
  };
  rawRemoteSuggestionEcho.meta = {
    ...(rawRemoteSuggestionEcho.meta ?? {}),
    'y-sync$': {},
  };

  assert.equal(
    transactionCarriesInsertedSuggestionMarks(rawRemoteSuggestionEcho),
    true,
    'Expected raw y-sync remote suggestion inserts to advertise their incoming suggestion marks',
  );
  const wrappedRawRemoteSuggestionEcho = wrapTransactionForSuggestions(rawRemoteSuggestionEcho, state, true);
  assert.equal(
    wrappedRawRemoteSuggestionEcho,
    rawRemoteSuggestionEcho,
    'Expected raw y-sync transactions that already carry suggestion marks to bypass local Track Changes wrapping',
  );

  console.log('track-changes-yjs-origin-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
