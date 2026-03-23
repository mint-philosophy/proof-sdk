import assert from 'node:assert/strict';

import {
  shouldSuppressTrackChangesDeleteIntent,
  shouldSuppressTrackChangesKeydown,
} from '../editor/plugins/track-changes-delete-guard.js';

function run(): void {
  assert.equal(
    shouldSuppressTrackChangesDeleteIntent({ key: 'Backspace', modifiers: { metaKey: true } }),
    true,
    'Cmd+Backspace should remain a no-op in track changes mode',
  );
  assert.equal(
    shouldSuppressTrackChangesDeleteIntent({ key: 'Backspace', modifiers: { altKey: true } }),
    true,
    'Option+Backspace should be intercepted as a no-op in track changes mode',
  );
  assert.equal(
    shouldSuppressTrackChangesDeleteIntent({ key: 'Backspace', modifiers: { altKey: true, ctrlKey: true } }),
    true,
    'beforeinput word-delete intents should also be suppressed when they map to modified Backspace',
  );
  assert.equal(
    shouldSuppressTrackChangesDeleteIntent({ key: 'Delete', modifiers: { altKey: true } }),
    false,
    'forward modified deletes should continue through the normal tracked-delete path',
  );
  assert.equal(
    shouldSuppressTrackChangesKeydown({ key: 'Backspace', altKey: true }),
    true,
    'keydown suppression should match the intent-based guard',
  );

  console.log('track-changes-delete-guard.test.ts passed');
}

run();
