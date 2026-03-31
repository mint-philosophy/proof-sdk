import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state';

import { marksPluginKey, getMarks } from '../editor/plugins/marks.js';
import {
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

function createState(text: string, selection: { from: number; to: number }): EditorState {
  return EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(text)]),
    ]),
    plugins: [marksStatePlugin],
    selection: TextSelection.create(
      schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text(text)]),
      ]),
      selection.from,
      selection.to,
    ),
  });
}

function applyTrackedForwardDelete(state: EditorState): { state: EditorState; deletedText: string } {
  const deleteRange = __debugResolveTrackedDeleteRange(state, 'Delete');
  assert(deleteRange, 'Expected Forward Delete to resolve a tracked delete range');
  const deletedText = state.doc.textBetween(deleteRange!.from, deleteRange!.to, '', '');
  const wrappedTr = wrapTransactionForSuggestions(
    state.tr.delete(deleteRange!.from, deleteRange!.to),
    state,
    true,
  );
  return {
    state: state.apply(wrappedTr),
    deletedText,
  };
}

function run(): void {
  let state = createState('Alpha beta gamma.', { from: 7, to: 7 });
  const deletedChars: string[] = [];

  for (let index = 0; index < 4; index += 1) {
    const result = applyTrackedForwardDelete(state);
    state = result.state;
    deletedChars.push(result.deletedText);
  }

  const deleteMarks = getMarks(state).filter((mark) => mark.kind === 'delete');
  assertEqual(
    deletedChars.join(''),
    'beta',
    'Repeated Forward Delete should advance through the next plain characters instead of re-targeting existing delete suggestions',
  );
  assertEqual(
    state.doc.textContent,
    'Alpha beta gamma.',
    'Repeated Forward Delete should keep the deleted word visible under delete suggestions instead of removing characters from the document',
  );
  assertEqual(
    deleteMarks.length,
    4,
    'Repeated Forward Delete should leave one pending delete suggestion per deleted character in this character-by-character scenario',
  );
  assertEqual(
    deleteMarks.map((mark) => mark.quote).join(''),
    'beta',
    'Repeated Forward Delete should preserve the full deleted word across the generated delete suggestions',
  );

  console.log('track-changes-forward-delete-regression.test.ts passed');
}

run();
