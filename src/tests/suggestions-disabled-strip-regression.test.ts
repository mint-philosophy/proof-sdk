import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';

import { __debugAnalyzeDisabledSuggestionStripDecision } from '../editor/plugins/suggestions.js';

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

function run(): void {
  const existingInsertId = 'existing-insert';
  const existingInsertMark = schema.marks.proofSuggestion.create({
    id: existingInsertId,
    kind: 'insert',
    by: 'human:editor',
  });

  const oldDocWithExistingInsert = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('Alpha '),
      schema.text('beta', [existingInsertMark]),
      schema.text(' gamma'),
    ]),
  ]);

  const newDocWithExistingInsert = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('Alpha '),
      schema.text('beta', [existingInsertMark]),
      schema.text(' gamma!'),
    ]),
  ]);

  const preservedAnalysis = __debugAnalyzeDisabledSuggestionStripDecision(
    oldDocWithExistingInsert,
    newDocWithExistingInsert,
    { from: 1, to: oldDocWithExistingInsert.content.size },
    { from: 1, to: newDocWithExistingInsert.content.size },
  );

  assert.deepEqual(
    preservedAnalysis.oldSummary.insertIds,
    [existingInsertId],
    'Expected the old diff range to include the pre-existing insert suggestion id',
  );
  assert.deepEqual(
    preservedAnalysis.newSummary.insertIds,
    [existingInsertId],
    'Expected the new diff range to still include the same pre-existing insert suggestion id',
  );
  assert.deepEqual(
    preservedAnalysis.introducedSummary.insertIds,
    [],
    'Expected no newly introduced insert suggestion ids when the diff only carries an existing insert forward',
  );
  assert.equal(
    preservedAnalysis.shouldStrip,
    false,
    'Expected TC-off cleanup not to strip pre-existing insert ids carried through a later diff',
  );

  const introducedInsertId = 'introduced-insert';
  const introducedInsertMark = schema.marks.proofSuggestion.create({
    id: introducedInsertId,
    kind: 'insert',
    by: 'human:editor',
  });

  const oldPlainDoc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('Alpha beta')]),
  ]);

  const newDocWithIntroducedInsert = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('Alpha '),
      schema.text('beta', [introducedInsertMark]),
    ]),
  ]);

  const introducedAnalysis = __debugAnalyzeDisabledSuggestionStripDecision(
    oldPlainDoc,
    newDocWithIntroducedInsert,
    { from: 1, to: oldPlainDoc.content.size },
    { from: 1, to: newDocWithIntroducedInsert.content.size },
  );

  assert.deepEqual(
    introducedAnalysis.oldSummary.insertIds,
    [],
    'Expected no insert suggestion ids in the old diff range before the leak',
  );
  assert.deepEqual(
    introducedAnalysis.newSummary.insertIds,
    [introducedInsertId],
    'Expected the new diff range to include the introduced insert suggestion id',
  );
  assert.deepEqual(
    introducedAnalysis.introducedSummary.insertIds,
    [introducedInsertId],
    'Expected TC-off cleanup to identify the newly introduced insert suggestion id',
  );
  assert.equal(
    introducedAnalysis.shouldStrip,
    true,
    'Expected TC-off cleanup to strip newly introduced suggestion ids',
  );

  console.log('suggestions-disabled-strip-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
