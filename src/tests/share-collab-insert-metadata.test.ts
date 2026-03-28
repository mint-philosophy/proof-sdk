import assert from 'node:assert/strict';

import {
  mergeResyncedPendingInsertServerMarks,
  preservePendingRemoteInsertMetadata,
} from '../editor/share-collab-insert-metadata.js';

function run(): void {
  const sourceMarks = {
    'insert-keep': {
      kind: 'insert' as const,
      by: 'human:editor',
      status: 'pending' as const,
      content: 'Alpha beta gamma',
      quote: 'Alpha beta gamma',
      range: { from: 7, to: 23 },
    },
    'insert-live': {
      kind: 'insert' as const,
      by: 'human:editor',
      status: 'pending' as const,
      content: 'Delta',
      quote: 'Delta',
      range: { from: 30, to: 35 },
    },
  };

  const syncedMetadata = {
    'insert-live': {
      kind: 'insert' as const,
      by: 'human:editor',
      status: 'pending' as const,
      content: 'Delta updated',
      quote: 'Delta updated',
      range: { from: 30, to: 43 },
    },
  };

  const preserved = preservePendingRemoteInsertMetadata(sourceMarks, syncedMetadata, ['insert-keep', 'insert-live']);
  assert.deepEqual(
    preserved['insert-keep'],
    sourceMarks['insert-keep'],
    'Expected remote resync to preserve authoritative insert metadata when the live doc does not yet surface the insert id',
  );
  assert.deepEqual(
    preserved['insert-live'],
    syncedMetadata['insert-live'],
    'Expected remote resync to keep the live-doc-updated insert metadata when the insert id is present',
  );

  const mergedServerMarks = mergeResyncedPendingInsertServerMarks(
    {},
    sourceMarks,
    preserved,
    ['insert-keep', 'insert-live'],
  );
  assert.deepEqual(
    mergedServerMarks['insert-keep'],
    sourceMarks['insert-keep'],
    'Expected remote server mark cache to retain missing pending inserts instead of deleting them',
  );
  assert.deepEqual(
    mergedServerMarks['insert-live'],
    {
      ...sourceMarks['insert-live'],
      ...syncedMetadata['insert-live'],
    },
    'Expected remote server mark cache to merge updated live insert metadata back onto the authoritative source mark',
  );

  console.log('share-collab-insert-metadata.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
