import { history, undo, undoDepth } from 'prosemirror-history';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function findTextNodeRange(state: EditorState, text: string): { from: number; to: number } | null {
  let match: { from: number; to: number } | null = null;
  state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    if (node.text === text) {
      match = { from: pos, to: pos + node.nodeSize };
      return false;
    }
    return true;
  });
  return match;
}

function run(): void {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'text*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {},
  });

  const emptyDoc = schema.node('doc', null, [schema.node('paragraph')]);
  const loadedDoc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('Title line')]),
    schema.node('paragraph', null, [schema.text('Body paragraph')]),
  ]);

  let state = EditorState.create({
    schema,
    doc: emptyDoc,
    plugins: [history()],
  });

  const loadTr = state.tr
    .replaceWith(0, state.doc.content.size, loadedDoc.content)
    .setMeta('document-load', true)
    .setMeta('addToHistory', false);
  state = state.apply(loadTr);

  assert(
    state.doc.childCount === 2
      && state.doc.textContent === 'Title lineBody paragraph',
    'Expected document-load transaction to replace the initial empty document',
  );
  assert(undoDepth(state) === 0, 'Expected document-load transaction to stay out of undo history');

  const bodyRange = findTextNodeRange(state, 'Body paragraph');
  assert(bodyRange !== null, 'Expected body text to exist after load');

  // Delete one character as a stand-in for a user edit after document load.
  state = state.apply(state.tr.delete(bodyRange!.from, bodyRange!.from + 1));

  assert(undoDepth(state) === 1, 'Expected only the post-load user edit to be undoable');

  let undoApplied = false;
  const firstUndoHandled = undo(state, (tr) => {
    state = state.apply(tr);
    undoApplied = true;
  });
  assert(firstUndoHandled, 'Expected first undo to revert the post-load user edit');
  assert(undoApplied, 'Expected first undo to dispatch a history transaction');
  assert(
    state.doc.childCount === 2
      && state.doc.textContent === 'Title lineBody paragraph',
    'Expected first undo to restore the loaded document content',
  );
  assert(undoDepth(state) === 0, 'Expected no remaining undo depth after reverting the user edit');

  const secondUndoHandled = undo(state, () => {
    throw new Error('Unexpected second undo dispatch');
  });
  assert(!secondUndoHandled, 'Expected undo not to walk back into the document-load transaction');

  console.log('document-load-history-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
