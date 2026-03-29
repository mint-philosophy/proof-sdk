import assert from 'node:assert/strict';

import {
  buildSuggestionReviewItems,
  resolveAdjacentSuggestionActionTarget,
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

  console.log('mark-popover-replacement-pair-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
