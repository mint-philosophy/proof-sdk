import {
  shouldIgnoreIncomingEmptyServerMarks,
  shouldPreserveMissingLocalMark,
} from '../bridge/marks-preservation';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  assert(
    shouldPreserveMissingLocalMark({
      kind: 'replace',
      by: 'ai:test',
      status: 'pending',
      quote: 'old',
      content: 'new',
    }) === false,
    'Expected pending replace suggestions not to be preserved when missing from server metadata',
  );

  assert(
    shouldPreserveMissingLocalMark({
      kind: 'insert',
      by: 'ai:test',
      status: 'pending',
      quote: 'old',
      content: 'new',
    }) === false,
    'Expected pending insert suggestions not to be preserved when missing from server metadata',
  );

  assert(
    shouldPreserveMissingLocalMark({
      kind: 'delete',
      by: 'ai:test',
      status: 'pending',
      quote: 'old',
    }) === false,
    'Expected pending delete suggestions not to be preserved when missing from server metadata',
  );

  assert(
    shouldPreserveMissingLocalMark({
      kind: 'comment',
      by: 'ai:test',
      text: 'keep this',
      resolved: false,
    }) === true,
    'Expected comment marks to remain preservable for partial payload safety',
  );

  assert(
    shouldPreserveMissingLocalMark({
      kind: 'authored',
      by: 'human:test',
    }) === false,
    'Expected authored marks never to be preserved',
  );

  assert(
    shouldIgnoreIncomingEmptyServerMarks({
      incomingMarks: {},
      cachedServerMarks: {
        comment1: {
          kind: 'comment',
          by: 'human:test',
          text: 'keep this',
        },
      },
      localMetadata: {},
      isSynced: true,
      unsyncedChanges: 0,
    }) === true,
    'Expected empty post-sync payloads not to clear cached comment marks before local hydration',
  );

  assert(
    shouldIgnoreIncomingEmptyServerMarks({
      incomingMarks: {},
      cachedServerMarks: {
        comment1: {
          kind: 'comment',
          by: 'human:test',
          text: 'keep this',
        },
      },
      localMetadata: {
        authored1: {
          kind: 'authored',
          by: 'human:test',
        },
      },
      isSynced: true,
      unsyncedChanges: 0,
    }) === true,
    'Expected authored-only local metadata not to clear cached comment marks on empty payloads',
  );

  assert(
    shouldIgnoreIncomingEmptyServerMarks({
      incomingMarks: {},
      cachedServerMarks: {
        comment1: {
          kind: 'comment',
          by: 'human:test',
          text: 'keep this',
        },
      },
      localMetadata: {
        comment1: {
          kind: 'comment',
          by: 'human:test',
          text: 'keep this',
        },
      },
      isSynced: true,
      unsyncedChanges: 0,
    }) === false,
    'Expected hydrated local comment metadata to allow legitimate empty server clears',
  );

  assert(
    shouldIgnoreIncomingEmptyServerMarks({
      incomingMarks: {
        comment1: {
          kind: 'comment',
          by: 'human:test',
          text: 'fresh',
        },
      },
      cachedServerMarks: {
        comment1: {
          kind: 'comment',
          by: 'human:test',
          text: 'stale',
        },
      },
      localMetadata: {},
      isSynced: true,
      unsyncedChanges: 0,
    }) === false,
    'Expected non-empty incoming server metadata never to be ignored',
  );

  assert(
    shouldIgnoreIncomingEmptyServerMarks({
      incomingMarks: {},
      cachedServerMarks: {
        comment1: {
          kind: 'comment',
          by: 'human:test',
          text: 'keep this',
        },
      },
      localMetadata: {},
      isSynced: false,
      unsyncedChanges: 0,
    }) === true,
    'Expected pre-sync empty payloads to preserve cached marks',
  );

  console.log('✓ collab client mark preservation rules avoid suggestion resurrection');
}

run();
