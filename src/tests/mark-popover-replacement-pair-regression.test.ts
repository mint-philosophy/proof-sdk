import assert from 'node:assert/strict';

import { buildSuggestionReviewItems } from '../editor/plugins/mark-popover.ts';
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

  console.log('mark-popover-replacement-pair-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
