import assert from 'node:assert/strict';

import {
  mergeResyncedPendingInsertServerMarks,
  preservePendingRemoteInsertMetadata,
} from '../editor/share-collab-insert-metadata.js';
import { mergePendingServerMarks } from '../editor/plugins/marks.js';

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

  const staleServerInsertMetadata = mergePendingServerMarks(
    {
      'insert-edited': {
        kind: 'insert' as const,
        by: 'human:editor',
        createdAt: '2026-03-30T00:00:00.000Z',
        status: 'pending' as const,
        content: 'Inserted paragraph with edited word.',
        quote: 'Inserted paragraph with edited word.',
        range: { from: 25, to: 58 },
        startRel: 'char:24',
        endRel: 'char:57',
      },
    },
    {
      'insert-edited': {
        kind: 'insert' as const,
        by: 'human:editor',
        createdAt: '2026-03-30T00:00:00.000Z',
        status: 'pending' as const,
        content: 'Inserted paragraph with original word.',
        quote: 'Inserted paragraph with original word.',
        range: { from: 25, to: 60 },
        startRel: 'char:24',
        endRel: 'char:59',
      },
    },
  );
  assert.deepEqual(
    staleServerInsertMetadata['insert-edited'],
    {
      kind: 'insert',
      by: 'human:editor',
      createdAt: '2026-03-30T00:00:00.000Z',
      status: 'pending',
      content: 'Inserted paragraph with edited word.',
      quote: 'Inserted paragraph with edited word.',
      range: { from: 25, to: 58 },
      startRel: 'char:24',
      endRel: 'char:57',
    },
    'Expected live local pending insert metadata to win over stale authoritative cache entries for the same insert id',
  );

  console.log('share-collab-insert-metadata.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
