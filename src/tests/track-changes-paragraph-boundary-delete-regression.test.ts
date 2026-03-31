import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';

import {
  __debugResolveTrackedDeleteRange,
  __debugShouldSuppressStructuralBoundaryDelete,
} from '../editor/plugins/suggestions.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
  },
});

function createDoc() {
  return schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('The research methodology was carefully designed to capture longitudinal trends across multiple intervention sites.'),
    ]),
    schema.node('paragraph', null, [
      schema.text('The follow-up survey targeted the same population.'),
    ]),
  ]);
}

function createState(doc: ReturnType<typeof createDoc>, from: number, to = from): EditorState {
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, from, to),
  });
}

function run(): void {
  const doc = createDoc();
  const firstParagraph = doc.child(0);
  const firstParagraphEnd = firstParagraph.nodeSize - 1;
  const secondParagraphStart = firstParagraph.nodeSize + 1;

  const backspaceBoundaryState = createState(doc, secondParagraphStart);
  const backspaceBoundaryRange = __debugResolveTrackedDeleteRange(backspaceBoundaryState, 'Backspace');
  assert.equal(
    __debugShouldSuppressStructuralBoundaryDelete(backspaceBoundaryState, 'Backspace'),
    true,
    'Expected TC Backspace at the start of a paragraph to be suppressed instead of attempting a structural join',
  );
  assert.ok(backspaceBoundaryRange, 'Expected paragraph-boundary Backspace to otherwise resolve a structural delete range');
  assert.equal(
    backspaceBoundaryState.doc.textBetween(backspaceBoundaryRange!.from, backspaceBoundaryRange!.to, '', ''),
    '',
    'Expected paragraph-boundary Backspace to target an empty structural range, confirming it must be suppressed',
  );

  const deleteBoundaryState = createState(doc, firstParagraphEnd);
  const deleteBoundaryRange = __debugResolveTrackedDeleteRange(deleteBoundaryState, 'Delete');
  assert.equal(
    __debugShouldSuppressStructuralBoundaryDelete(deleteBoundaryState, 'Delete'),
    true,
    'Expected TC Delete at the end of a paragraph to be suppressed instead of attempting a structural join',
  );
  assert.ok(deleteBoundaryRange, 'Expected paragraph-boundary Delete to otherwise resolve a structural delete range');
  assert.equal(
    deleteBoundaryState.doc.textBetween(deleteBoundaryRange!.from, deleteBoundaryRange!.to, '', ''),
    '',
    'Expected paragraph-boundary Delete to target an empty structural range, confirming it must be suppressed',
  );

  const inlineBackspaceState = createState(doc, 12);
  const inlineBackspaceRange = __debugResolveTrackedDeleteRange(inlineBackspaceState, 'Backspace');
  assert.equal(
    __debugShouldSuppressStructuralBoundaryDelete(inlineBackspaceState, 'Backspace'),
    false,
    'Expected in-paragraph Backspace to remain tracked normally',
  );
  assert.ok(inlineBackspaceRange, 'Expected in-paragraph Backspace to resolve a tracked delete range');
  assert.notEqual(
    inlineBackspaceState.doc.textBetween(inlineBackspaceRange!.from, inlineBackspaceRange!.to, '', ''),
    '',
    'Expected in-paragraph Backspace to target visible text instead of a structural boundary',
  );

  const inlineDeleteState = createState(doc, 12);
  const inlineDeleteRange = __debugResolveTrackedDeleteRange(inlineDeleteState, 'Delete');
  assert.equal(
    __debugShouldSuppressStructuralBoundaryDelete(inlineDeleteState, 'Delete'),
    false,
    'Expected in-paragraph Delete to remain tracked normally',
  );
  assert.ok(inlineDeleteRange, 'Expected in-paragraph Delete to resolve a tracked delete range');
  assert.notEqual(
    inlineDeleteState.doc.textBetween(inlineDeleteRange!.from, inlineDeleteRange!.to, '', ''),
    '',
    'Expected in-paragraph Delete to target visible text instead of a structural boundary',
  );

  console.log('track-changes-paragraph-boundary-delete-regression.test.ts passed');
}

run();
