import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';

import {
  buildSuggestionActionTargetPreferredMarkIds,
  buildSuggestionReviewItems,
  resolveAdjacentSuggestionActionTarget,
  resolveSuggestionReviewFollowupTarget,
  resolveSuggestionActionTarget,
} from '../editor/plugins/mark-popover.ts';
import type { Mark } from '../formats/marks.ts';

function buildInsertMark(id: string, at: string, from: number, to: number, content: string): Mark {
  return {
    id,
    kind: 'insert',
    by: 'human:qa',
    at,
    range: { from, to },
    quote: content,
    data: {
      content,
      status: 'pending',
    },
  };
}

function buildDeleteMark(id: string, at: string, from: number, to: number, quote: string): Mark {
  return {
    id,
    kind: 'delete',
    by: 'human:qa',
    at,
    range: { from, to },
    quote,
    data: {
      status: 'pending',
    },
  };
}

function run(): void {
  const deleteFirstItems = buildSuggestionReviewItems([
    buildDeleteMark('delete-1', '2026-03-29T12:00:00.000Z', 8, 13, 'two'),
    buildInsertMark('insert-1', '2026-03-29T12:00:00.650Z', 8, 13, 'TWO'),
  ]);
  assert.equal(deleteFirstItems.length, 1, 'Expected delete+insert overwrite pairs to collapse into one review item even when delete sorts first');
  assert.equal(deleteFirstItems[0]?.kind, 'replace');
  assert.deepEqual(deleteFirstItems[0]?.memberMarkIds, ['delete-1', 'insert-1']);
  assert.equal(deleteFirstItems[0]?.insertMark?.id, 'insert-1');
  assert.equal(deleteFirstItems[0]?.deleteMark?.id, 'delete-1');

  const insertFirstItems = buildSuggestionReviewItems([
    buildInsertMark('insert-2', '2026-03-29T12:00:01.000Z', 18, 23, 'FOUR'),
    buildDeleteMark('delete-2', '2026-03-29T12:00:01.900Z', 18, 23, 'four'),
  ]);
  assert.equal(insertFirstItems.length, 1, 'Expected overwrite pairs to keep grouping when insert sorts first and timestamps differ slightly');
  assert.equal(insertFirstItems[0]?.kind, 'replace');

  const unrelatedItems = buildSuggestionReviewItems([
    buildDeleteMark('delete-3', '2026-03-29T12:00:10.000Z', 28, 33, 'six'),
    buildInsertMark('insert-3', '2026-03-29T12:00:15.500Z', 28, 33, 'SIX'),
  ]);
  assert.equal(unrelatedItems.length, 2, 'Expected replacement grouping to reject distant timestamps so unrelated adjacent suggestions stay separate');

  const wholeDocumentReplacementDoc = {
    textBetween(from: number, to: number): string {
      if (from === 77 && to === 79) return '\n\n';
      return '';
    },
  };
  const wholeDocumentReplacementItems = buildSuggestionReviewItems([
    buildDeleteMark('delete-full', '2026-03-30T17:21:46.489Z', 1, 77, 'Untitled The l implications were significant and required careful analysis.'),
    buildInsertMark('insert-full', '2026-03-30T17:21:46.489Z', 79, 134, 'The entire document has been replaced with new content.'),
  ], wholeDocumentReplacementDoc as any);
  assert.equal(
    wholeDocumentReplacementItems.length,
    1,
    'Expected whole-document replacements separated only by structural paragraph gaps to collapse into one review item',
  );
  assert.equal(wholeDocumentReplacementItems[0]?.kind, 'replace');
  assert.deepEqual(
    wholeDocumentReplacementItems[0]?.memberMarkIds,
    ['delete-full', 'insert-full'],
    'Expected whole-document replacement review items to carry both the delete and insert suggestion ids',
  );

  const navigationItems = buildSuggestionReviewItems([
    buildDeleteMark('delete-red', '2026-03-29T12:01:00.000Z', 0, 3, 'Red'),
    buildInsertMark('insert-red', '2026-03-29T12:01:00.300Z', 0, 7, 'CRIMSON'),
    buildDeleteMark('delete-green', '2026-03-29T12:01:05.000Z', 8, 13, 'green'),
    buildInsertMark('insert-green', '2026-03-29T12:01:05.300Z', 8, 15, 'EMERALD'),
    buildDeleteMark('delete-blue', '2026-03-29T12:01:10.000Z', 16, 20, 'blue'),
    buildInsertMark('insert-blue', '2026-03-29T12:01:10.300Z', 16, 21, 'AZURE'),
    buildDeleteMark('delete-yellow', '2026-03-29T12:01:15.000Z', 22, 28, 'yellow'),
    buildInsertMark('insert-yellow', '2026-03-29T12:01:15.300Z', 22, 26, 'GOLD'),
  ]);
  assert.equal(navigationItems.length, 4, 'Expected four overwrite pairs to remain as four review items');

  const liveTarget = resolveSuggestionActionTarget(navigationItems, ['delete-yellow']);
  assert.deepEqual(
    liveTarget,
    {
      markId: 'insert-yellow',
      nextMarkId: 'delete-red',
      kind: 'replace',
    },
    'Expected live review actions to resolve from the grouped replacement item instead of the raw active delete mark',
  );

  const previousTarget = resolveAdjacentSuggestionActionTarget(navigationItems, ['delete-yellow'], 'prev');
  assert.deepEqual(
    previousTarget,
    {
      markId: 'delete-blue',
      nextMarkId: 'insert-yellow',
      kind: 'replace',
    },
    'Expected previous navigation to move to the adjacent replacement review item instead of staying on the current one',
  );

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
        },
        inclusive: false,
        spanning: true,
      },
    },
  });

  const alphaDelete = schema.marks.proofSuggestion.create({ id: 'delete-alpha', kind: 'delete' });
  const alphaInsert = schema.marks.proofSuggestion.create({ id: 'insert-alpha', kind: 'insert' });
  const betaDelete = schema.marks.proofSuggestion.create({ id: 'delete-beta', kind: 'delete' });
  const betaInsert = schema.marks.proofSuggestion.create({ id: 'insert-beta', kind: 'insert' });
  const gammaDelete = schema.marks.proofSuggestion.create({ id: 'delete-gamma', kind: 'delete' });
  const gammaInsert = schema.marks.proofSuggestion.create({ id: 'insert-gamma', kind: 'insert' });
  const sameParagraphDoc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('Words '),
      schema.text('alpha', [alphaDelete]),
      schema.text('A1', [alphaInsert]),
      schema.text(' '),
      schema.text('beta', [betaDelete]),
      schema.text('B2', [betaInsert]),
      schema.text(' '),
      schema.text('gamma', [gammaDelete]),
      schema.text('C3', [gammaInsert]),
      schema.text(' end.'),
    ]),
  ]);
  const staleRangeItems = buildSuggestionReviewItems([
    buildDeleteMark('delete-alpha', '2026-03-29T12:02:00.000Z', 6, 11, 'alpha'),
    buildInsertMark('insert-alpha', '2026-03-29T12:02:00.300Z', 6, 8, 'A1'),
    buildDeleteMark('delete-beta', '2026-03-29T12:02:05.000Z', 24, 28, 'beta'),
    buildInsertMark('insert-beta', '2026-03-29T12:02:05.300Z', 24, 26, 'B2'),
    buildDeleteMark('delete-gamma', '2026-03-29T12:02:10.000Z', 14, 19, 'gamma'),
    buildInsertMark('insert-gamma', '2026-03-29T12:02:10.300Z', 14, 16, 'C3'),
  ]);
  assert.deepEqual(
    staleRangeItems.map((item) => item.primaryMarkId),
    ['insert-alpha', 'insert-gamma', 'insert-beta'],
    'Expected stale stored ranges to misorder same-paragraph replacements before live re-resolution',
  );

  const sameParagraphTarget = resolveSuggestionActionTarget(
    staleRangeItems,
    ['delete-alpha'],
    sameParagraphDoc,
  );
  assert.deepEqual(
    sameParagraphTarget,
    {
      markId: 'insert-alpha',
      nextMarkId: 'insert-beta',
      kind: 'replace',
    },
    'Expected live action resolution to pick the next same-paragraph replacement by document position even when stored ranges are stale',
  );

  const sameParagraphAdjacentTarget = resolveAdjacentSuggestionActionTarget(
    staleRangeItems,
    ['delete-alpha'],
    'next',
    sameParagraphDoc,
  );
  assert.deepEqual(
    sameParagraphAdjacentTarget,
    {
      markId: 'insert-beta',
      nextMarkId: 'insert-gamma',
      kind: 'replace',
    },
    'Expected adjacent same-paragraph navigation to advance by live resolved position instead of stale stored range order',
  );

  const staleRenderedMarkTarget = resolveSuggestionActionTarget(
    navigationItems,
    buildSuggestionActionTargetPreferredMarkIds(
      'delete-blue',
      'delete-green',
      'delete-green',
      'active-first',
    ),
  );
  assert.deepEqual(
    staleRenderedMarkTarget,
    {
      markId: 'delete-green',
      nextMarkId: 'delete-blue',
      kind: 'replace',
    },
    'Expected active-first action targeting to prefer the live active suggestion over a stale rendered popover mark id',
  );

  const explicitFollowupTarget = resolveSuggestionActionTarget(
    navigationItems,
    buildSuggestionActionTargetPreferredMarkIds(
      'delete-blue',
      'delete-green',
      'delete-green',
      'fallback-first',
    ),
  );
  assert.deepEqual(
    explicitFollowupTarget,
    {
      markId: 'delete-blue',
      nextMarkId: 'insert-yellow',
      kind: 'replace',
    },
    'Expected fallback-first action targeting to keep honoring an explicit review follow-up target when one is provided',
  );

  const temporarilyMissingNextFollowup = resolveSuggestionReviewFollowupTarget(
    [navigationItems[2]!, navigationItems[3]!],
    'delete-green',
    ['delete-red', 'insert-red'],
    null,
  );
  assert.deepEqual(
    temporarilyMissingNextFollowup,
    {
      markId: null,
      waitingForPreferred: true,
    },
    'Expected review follow-up to wait when the intended next replacement is temporarily missing instead of jumping ahead to a later mark',
  );

  const restoredNextFollowup = resolveSuggestionReviewFollowupTarget(
    navigationItems,
    'delete-green',
    ['delete-red', 'insert-red'],
    null,
  );
  assert.deepEqual(
    restoredNextFollowup,
    {
      markId: 'delete-green',
      waitingForPreferred: false,
    },
    'Expected review follow-up to reopen the intended next replacement once it is present in the live document-order list',
  );
  console.log('mark-popover-replacement-pair-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
