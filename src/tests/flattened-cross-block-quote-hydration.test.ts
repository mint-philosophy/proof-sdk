import assert from 'node:assert/strict';

import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';

import { applyRemoteMarks, getMarks, marksPluginKey } from '../editor/plugins/marks.js';
import { getTextForRange } from '../editor/utils/text-range.js';

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
          kind: { default: 'insert' },
          by: { default: 'unknown' },
          status: { default: 'pending' },
        },
        inclusive: false,
        spanning: true,
      },
    },
  });

  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, schema.text('Untitled')),
    schema.node('paragraph', null, schema.text('the entire document content.')),
  ]);

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

  let state = EditorState.create({
    schema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {
    'm-flattened-cross-block-delete': {
      kind: 'delete',
      by: 'human:test',
      createdAt: new Date('2026-03-30T00:00:00.000Z').toISOString(),
      status: 'pending',
      quote: 'Untitledthe entire document content.',
      startRel: 'char:0',
      endRel: 'char:37',
    },
  }, { hydrateAnchors: true });

  const hydrated = getMarks(state).find((mark) => mark.id === 'm-flattened-cross-block-delete');
  assert(hydrated, 'Expected flattened cross-block stored quote to hydrate');
  assert(hydrated.range, 'Expected flattened cross-block stored quote to resolve a range');
  assert.equal(
    getTextForRange(state.doc, hydrated.range!),
    'Untitled\nthe entire document content.',
    'Expected flattened cross-block stored quote to resolve onto the live multi-block text',
  );

  console.log('flattened-cross-block-quote-hydration.test.ts passed');
}

run();
