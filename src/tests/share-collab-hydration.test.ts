import assert from 'node:assert/strict';

import {
  normalizeShareCollabHydrationText,
  shouldTreatShareCollabAsHydrated,
} from '../editor/share-collab-hydration.js';

assert.equal(
  normalizeShareCollabHydrationText(' Alpha \n\n Beta  '),
  'Alpha Beta',
  'Expected collab hydration text normalization to collapse whitespace consistently',
);

assert.equal(
  shouldTreatShareCollabAsHydrated({
    fragmentIsStructurallyEmpty: true,
    editorIsStructurallyEmpty: true,
    fragmentText: null,
    editorText: '',
    yTextMarkdown: 'Persisted tracked content',
  }),
  false,
  'Expected empty editor state not to count as hydrated when Y.Text still carries persisted content',
);

assert.equal(
  shouldTreatShareCollabAsHydrated({
    fragmentIsStructurallyEmpty: true,
    editorIsStructurallyEmpty: true,
    fragmentText: null,
    editorText: '',
    yTextMarkdown: '',
  }),
  true,
  'Expected truly empty shared docs to count as hydrated immediately',
);

assert.equal(
  shouldTreatShareCollabAsHydrated({
    fragmentIsStructurallyEmpty: false,
    editorIsStructurallyEmpty: false,
    fragmentText: 'Alpha Beta',
    editorText: 'Alpha Beta',
    yTextMarkdown: 'Alpha Beta',
  }),
  true,
  'Expected matching editor and fragment text to count as hydrated',
);

assert.equal(
  shouldTreatShareCollabAsHydrated({
    fragmentIsStructurallyEmpty: false,
    editorIsStructurallyEmpty: false,
    fragmentText: 'Alpha Beta',
    editorText: 'Alpha',
    yTextMarkdown: 'Alpha Beta',
  }),
  false,
  'Expected mismatched editor and fragment text to keep hydration pending',
);

console.log('✓ share collab hydration gate keeps pending marks alive until content arrives');
