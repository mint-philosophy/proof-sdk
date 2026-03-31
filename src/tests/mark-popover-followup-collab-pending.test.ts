import assert from 'node:assert/strict';

import { isSuggestionReviewFollowupCollabPending } from '../editor/plugins/mark-popover.ts';

function run(): void {
  assert.equal(
    isSuggestionReviewFollowupCollabPending(null),
    false,
    'Expected missing proof state to avoid blocking review follow-up',
  );

  assert.equal(
    isSuggestionReviewFollowupCollabPending({
      collabEnabled: false,
      activeCollabSession: { slug: 'doc' },
    }),
    false,
    'Expected non-collab runtimes to avoid waiting for reconnect follow-up',
  );

  assert.equal(
    isSuggestionReviewFollowupCollabPending({
      collabEnabled: true,
      activeCollabSession: { slug: 'doc' },
      collabConnectionStatus: 'connected',
      collabIsSynced: true,
      collabUnsyncedChanges: 0,
      collabPendingLocalUpdates: 0,
      pendingCollabRebindOnSync: false,
      suppressTrackChangesDuringCollabReconnect: false,
      collabSessionRefreshInFlight: false,
      pendingCollabTemplateMarkdown: null,
      hasCompletedInitialCollabHydration: true,
      isCollabHydratedForEditing: true,
    }),
    false,
    'Expected fully synced collab state to allow immediate review follow-up',
  );

  assert.equal(
    isSuggestionReviewFollowupCollabPending({
      collabEnabled: true,
      activeCollabSession: { slug: 'doc' },
      collabConnectionStatus: 'connecting',
      collabIsSynced: false,
      collabUnsyncedChanges: 0,
      collabPendingLocalUpdates: 0,
    }),
    true,
    'Expected in-flight reconnects to keep review follow-up waiting',
  );

  assert.equal(
    isSuggestionReviewFollowupCollabPending({
      collabEnabled: true,
      activeCollabSession: { slug: 'doc' },
      collabConnectionStatus: 'connected',
      collabIsSynced: true,
      collabUnsyncedChanges: 0,
      collabPendingLocalUpdates: 0,
      pendingCollabRebindOnSync: true,
      suppressTrackChangesDuringCollabReconnect: false,
      collabSessionRefreshInFlight: false,
      pendingCollabTemplateMarkdown: null,
      hasCompletedInitialCollabHydration: true,
      isCollabHydratedForEditing: () => true,
    }),
    true,
    'Expected pending rebinds to keep review follow-up alive until marks are rebound',
  );

  assert.equal(
    isSuggestionReviewFollowupCollabPending({
      collabEnabled: true,
      activeCollabSession: { slug: 'doc' },
      collabConnectionStatus: 'connected',
      collabIsSynced: true,
      collabUnsyncedChanges: 0,
      collabPendingLocalUpdates: 0,
      pendingCollabRebindOnSync: false,
      suppressTrackChangesDuringCollabReconnect: false,
      collabSessionRefreshInFlight: false,
      pendingCollabTemplateMarkdown: '# reconnect seed',
      hasCompletedInitialCollabHydration: true,
      isCollabHydratedForEditing: true,
    }),
    true,
    'Expected pending reconnect template seeding to block follow-up closeout',
  );
  console.log('mark-popover-followup-collab-pending.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
