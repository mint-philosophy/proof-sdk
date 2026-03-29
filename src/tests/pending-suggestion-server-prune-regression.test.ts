import { pruneLocallyRemovedPendingSuggestionServerMarks } from '../editor/plugins/marks';
import type { StoredMark } from '../formats/marks';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const previousPendingSuggestionIds = new Set(['delete-1', 'insert-1']);
  const currentMetadata: Record<string, StoredMark> = {
    'insert-1': {
      kind: 'insert',
      by: 'human:test',
      content: 'beta',
      status: 'pending',
      createdAt: new Date().toISOString(),
      quote: 'beta',
      startRel: 'char:6',
      endRel: 'char:10',
    },
  };
  const serverMarks: Record<string, StoredMark> = {
    'delete-1': {
      kind: 'delete',
      by: 'human:test',
      status: 'pending',
      createdAt: new Date().toISOString(),
      quote: 'alpha',
      startRel: 'char:0',
      endRel: 'char:5',
    },
    'insert-1': {
      kind: 'insert',
      by: 'human:test',
      content: 'beta',
      status: 'pending',
      createdAt: new Date().toISOString(),
      quote: 'beta',
      startRel: 'char:6',
      endRel: 'char:10',
    },
    'comment-1': {
      kind: 'comment',
      by: 'human:test',
      text: 'keep this',
      createdAt: new Date().toISOString(),
    },
  };

  const pruned = pruneLocallyRemovedPendingSuggestionServerMarks(
    previousPendingSuggestionIds,
    currentMetadata,
    serverMarks,
  );

  assert(!pruned['delete-1'], 'Expected removed pending delete suggestion to be pruned from stale server marks');
  assert(Boolean(pruned['insert-1']), 'Expected still-live pending insert suggestion to remain in server marks');
  assert(Boolean(pruned['comment-1']), 'Expected non-suggestion marks to remain untouched');

  console.log('pending-suggestion-server-prune-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
