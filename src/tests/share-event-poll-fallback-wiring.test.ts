import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shareClientSource = readFileSync(path.join(repoRoot, 'src', 'bridge', 'share-client.ts'), 'utf8');
const editorSource = readFileSync(path.join(repoRoot, 'src', 'editor', 'index.ts'), 'utf8');

assert(
  shareClientSource.includes('async fetchPendingEvents(')
    && shareClientSource.includes('/agent/${this.slug}/events/pending?'),
  'Expected ShareClient to expose a pending-events fetch helper for cross-instance share refresh fallback',
);

assert(
  editorSource.includes('private startShareEventPoll(): void')
    && editorSource.includes('if (this.shareEventPollTimer) return;')
    && editorSource.includes('if (this.shareEventPollInFlight) {')
    && editorSource.includes('const payload = await shareClient.fetchPendingEvents(this.shareEventCursor, { limit: 100 });')
    && editorSource.includes('this.handlePendingShareEvent(event);')
    && editorSource.includes('this.shareEventPollTimer = setTimeout(() => { void tick(); }, this.shareEventPollMs);'),
  'Expected share-mode editor startup to maintain a debounced pending-events poll fallback that drains events through handlePendingShareEvent',
);

assert(
  editorSource.includes("event.type === 'agent.edit.v2'")
    && editorSource.includes('private shouldSkipForcedCollabRefreshFromPendingEvent(): boolean')
    && editorSource.includes("this.collabConnectionStatus !== 'disconnected'")
    && editorSource.includes("action: 'skip-forced-refresh'")
    && editorSource.includes('this.scheduleShareDocumentUpdatedRefresh(true);'),
  'Expected pending event handler to skip forced collab refresh whenever the live room is still connected or reconnecting, so local edits cannot trigger a self-refresh fallback mid-sync',
);

assert(
  editorSource.includes("return event.type.startsWith('comment.')")
    && editorSource.includes("|| event.type.startsWith('suggestion.');")
    && editorSource.includes('this.scheduleShareMarksRefresh();')
    && editorSource.includes('this.pendingShareMarksRefresh = true;')
    && editorSource.includes('clearTimeout(this.shareMarksRefreshTimer);')
    && editorSource.includes('void shareClient.fetchOpenContext()')
    && editorSource.includes('this.applyAuthoritativeShareMarks(serverMarks);'),
  'Expected pending comment/suggestion events to refresh authoritative marks for healthy share sessions',
);

assert(
  editorSource.includes('private stopShareEventPoll(): void')
    && editorSource.includes('private scheduleShareMarksRefresh(): void')
    && editorSource.includes('private shareMarksRefreshTimer: ReturnType<typeof setTimeout> | null = null;')
    && editorSource.includes('private pendingShareMarksRefresh: boolean = false;')
    && editorSource.includes('if (this.shareMarksRefreshTimer) {')
    && editorSource.includes('this.stopShareEventPoll();'),
  'Expected share event poller and marks refresh timer to be cleaned up during share/editor teardown',
);

assert(
  shareClientSource.includes('socket.onclose = () => {')
    && shareClientSource.includes('if (this.ws !== socket) return;')
    && shareClientSource.includes("this.setConnectionState('disconnected');")
    && shareClientSource.includes('this.scheduleReconnect();'),
  'Expected ShareClient to ignore stale socket closes so a superseded socket cannot downgrade connection state or schedule reconnects',
);

console.log('✓ share event poll fallback wiring checks');
