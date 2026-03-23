import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';

import { getMarks, marksPluginKey } from '../editor/plugins/marks.js';
import { wrapTransactionForSuggestions } from '../editor/plugins/suggestions.js';
import { getYjsTransactionOriginInfo } from '../editor/plugins/transaction-origins.js';

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

  const wrappedEcho = wrapTransactionForSuggestions(echoedWithRawYjsMeta, state, true);
  assert.equal(wrappedEcho, echoedWithRawYjsMeta, 'Expected Yjs-origin transactions to bypass track-changes wrapping');
  assert.equal(wrappedEcho.getMeta('suggestions-wrapped'), undefined, 'Expected raw Yjs echo transactions to skip suggestions-wrapped metadata');

  const echoedWithChangeOrigin = state.tr.insertText('z', state.selection.from, state.selection.from) as typeof echoed & {
    meta?: Record<string, unknown>;
  };
  echoedWithChangeOrigin.meta = {
    ...(echoedWithChangeOrigin.meta ?? {}),
    'y-sync$': { isChangeOrigin: true },
  };

  const wrappedChangeOriginEcho = wrapTransactionForSuggestions(echoedWithChangeOrigin, state, true);
  assert.equal(wrappedChangeOriginEcho, echoedWithChangeOrigin, 'Expected raw isChangeOrigin Yjs echoes to bypass track-changes wrapping');

  console.log('track-changes-yjs-origin-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
