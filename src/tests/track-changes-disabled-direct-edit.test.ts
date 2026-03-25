import { Schema } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';

import { wrapTransactionForSuggestions } from '../editor/plugins/suggestions.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

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
          content: { default: null },
          createdAt: { default: null },
          updatedAt: { default: null },
        },
        inclusive: false,
        spanning: true,
      },
    },
  });

  const state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Alpha beta gamma.')]),
    ]),
  });

  const directEdit = state.tr.insertText(' brave', 18, 18);
  const wrapped = wrapTransactionForSuggestions(directEdit, state, false);
  assert(
    wrapped === directEdit,
    'Expected Track Changes disabled editing to bypass suggestion wrapping and preserve the original transaction',
  );

  const nextState = state.apply(wrapped);
  assert(
    nextState.doc.textContent === 'Alpha beta gamma. brave',
    'Expected Track Changes disabled editing to insert plain text directly into the document',
  );

  let suggestionCount = 0;
  nextState.doc.descendants((node) => {
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type.name === 'proofSuggestion')) suggestionCount += 1;
    return true;
  });
  assert(suggestionCount === 0, 'Expected Track Changes disabled editing to leave no suggestion marks behind');

  console.log('track-changes-disabled-direct-edit.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
