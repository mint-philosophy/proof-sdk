import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';

import { __debugShouldSuppressStructuralParagraphSplit } from '../editor/plugins/suggestions.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    code_block: { content: 'text*', group: 'block', code: true },
    text: { group: 'inline' },
  },
});

function createState(doc: ReturnType<typeof schema.node>, from: number, to = from): EditorState {
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, from, to),
  });
}

function run(): void {
  const paragraphDoc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('Alpha beta gamma.')]),
  ]);
  const paragraphMidState = createState(paragraphDoc, 7);
  assert.equal(
    __debugShouldSuppressStructuralParagraphSplit(paragraphMidState),
    true,
    'Expected TC to suppress mid-paragraph Enter because paragraph splits are unsupported structural edits',
  );

  const paragraphEndState = createState(paragraphDoc, paragraphDoc.child(0).nodeSize - 1);
  assert.equal(
    __debugShouldSuppressStructuralParagraphSplit(paragraphEndState),
    true,
    'Expected TC to suppress end-of-paragraph Enter so it cannot create untracked empty paragraphs',
  );

  const selectionState = createState(paragraphDoc, 1, 6);
  assert.equal(
    __debugShouldSuppressStructuralParagraphSplit(selectionState),
    true,
    'Expected TC to suppress Enter across selections too because splitBlock remains unsupported under TC',
  );

  const codeBlockDoc = schema.node('doc', null, [
    schema.node('code_block', null, [schema.text('const value = 1;')]),
  ]);
  const codeBlockState = createState(codeBlockDoc, 8);
  assert.equal(
    __debugShouldSuppressStructuralParagraphSplit(codeBlockState),
    false,
    'Expected code block Enter not to be blocked by the paragraph-split guard',
  );

  console.log('track-changes-enter-block-regression.test.ts passed');
}

run();
