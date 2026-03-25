import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  assert(start !== -1, `Missing block start: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert(end !== -1, `Missing block end after: ${startNeedle}`);
  return source.slice(start, end);
}

function run(): void {
  const editorSource = readFileSync(path.resolve(process.cwd(), 'src/editor/index.ts'), 'utf8');
  const shareClientSource = readFileSync(path.resolve(process.cwd(), 'src/bridge/share-client.ts'), 'utf8');
  const collabClientSource = readFileSync(path.resolve(process.cwd(), 'src/bridge/collab-client.ts'), 'utf8');

  assert(
    shareClientSource.includes('markdown?: string;')
      && shareClientSource.includes('collab?: {')
      && shareClientSource.includes("markdown: typeof payload?.markdown === 'string'")
      && shareClientSource.includes("status: typeof collab.status === 'string' ? collab.status : undefined")
      && shareClientSource.includes("markdown: typeof context.doc?.markdown === 'string' ? context.doc.markdown : undefined"),
    'Expected share mark mutations to carry canonical markdown through direct and recovered responses',
  );

  const applyResultBlock = sliceBetween(
    editorSource,
    '  private async applyShareMutationDocumentResult(',
    '\n  private async reloadCanonicalShareDocument(): Promise<boolean> {',
  );
  assert(
    applyResultBlock.includes("const collabStatus = typeof result?.collab?.status === 'string' ? result.collab.status : '';")
      && applyResultBlock.includes('resetSuggestionsInsertCoalescing();')
      && applyResultBlock.includes("const skipReconnectTemplateSeed = options?.skipReconnectTemplateSeed === true;")
      && applyResultBlock.includes("const preserveEditorStateDuringReconnect = options?.preserveEditorStateDuringReconnect === true;")
      && applyResultBlock.includes('this.pendingCollabReconnectTemplateOverride = skipReconnectTemplateSeed')
      && applyResultBlock.includes(': this.normalizeMarkdownForCollab(markdown);')
      && applyResultBlock.includes('this.skipNextCollabTemplateSeed = skipReconnectTemplateSeed;')
      && applyResultBlock.includes('this.preserveEditorStateOnNextCollabReconnect = preserveEditorStateDuringReconnect;')
      && applyResultBlock.includes("this.collabConnectionStatus = 'connecting';")
      && applyResultBlock.includes('this.collabIsSynced = false;'),
    'Expected share review mutation results with pending collab status to clear tracked-insert coalescing, mark collab as unstable, and optionally skip reconnect template replay when the canonical result is already loaded in the editor',
  );

  const reconnectBlock = sliceBetween(
    editorSource,
    '  private async refreshCollabSessionAndReconnect(preserveLocalState: boolean): Promise<void> {',
    '\n  private installShareContentFilter(): void {',
  );
  assert(
    reconnectBlock.includes('if (this.pendingCollabReconnectTemplateOverride && this.pendingCollabReconnectTemplateOverride.trim().length > 0) {')
      && reconnectBlock.includes('reconnectTemplate = this.pendingCollabReconnectTemplateOverride;')
      && reconnectBlock.includes('this.pendingCollabReconnectTemplateOverride = null;'),
    'Expected collab reconnect to prefer the authoritative share mutation template over a stale fetchDocument fallback',
  );
  assert(
    reconnectBlock.includes('const forcePreserveEditorState = this.preserveEditorStateOnNextCollabReconnect;')
      && reconnectBlock.includes('const shouldPreserveLocalState = forcePreserveEditorState')
      && reconnectBlock.includes('if (this.skipNextCollabTemplateSeed) {')
      && reconnectBlock.includes('reconnectTemplate = null;')
      && reconnectBlock.includes('this.skipNextCollabTemplateSeed = false;'),
    'Expected collab reconnect to support preserving the current canonical editor state while skipping a redundant reconnect template replay',
  );

  const refreshLoopBlock = sliceBetween(
    editorSource,
    '  private startCollabRefreshLoop(): void {',
    '\n  private shouldPreservePendingLocalCollabState(): boolean {',
  );
  assert(
    refreshLoopBlock.includes('if ((expiresAtMs - now) > 60_000) return;')
      && refreshLoopBlock.includes('if (this.shouldDeferExpiringCollabRefresh(now)) return;')
      && refreshLoopBlock.includes('await this.refreshCollabSessionAndReconnect(this.shouldPreservePendingLocalCollabState());')
      && !refreshLoopBlock.includes("if (this.collabConnectionStatus === 'connected' && this.collabIsSynced) return;"),
    'Expected the collab refresh loop to proactively refresh near-expiry sessions even when the room is currently healthy',
  );

  assert(
    editorSource.includes("const authFailed = collabClient.lastAuthenticationFailureReason !== null;")
      && editorSource.includes("collabClient.terminalCloseReason === 'permission-denied'")
      && editorSource.includes('|| authFailed')
      && editorSource.includes('void this.refreshCollabSessionAndReconnect(this.shouldPreservePendingLocalCollabState());'),
    'Expected collab auth-failure disconnects to trigger a session refresh/reconnect instead of leaving persisted review actions stuck offline',
  );

  assert(
    collabClientSource.includes('function classifyAuthenticationFailureReason(reason: string): CollabTerminalCloseReason {')
      && collabClientSource.includes("if (normalized === 'document-not-found') return 'unshared';")
      && collabClientSource.includes("normalized === 'document-revoked'")
      && collabClientSource.includes("normalized === 'document-paused'")
      && collabClientSource.includes("normalized === 'permission-denied'")
      && collabClientSource.includes('this.terminalCloseReason = classifyAuthenticationFailureReason(reason);'),
    'Expected collab-client authentication failures to classify terminal close reasons so the editor can distinguish refreshable auth expiry from permanent unshare/revoke cases',
  );

  const editGateBlock = sliceBetween(
    editorSource,
    '  private updateShareEditGate(): void {',
    '\n  private ensureShareWebSocketConnection(): void {',
  );
  assert(
    editGateBlock.includes('const collabReconnectStable = !this.pendingCollabRebindOnSync')
      && editGateBlock.includes('&& !this.suppressTrackChangesDuringCollabReconnect;')
      && editGateBlock.includes('this.hasCompletedInitialCollabHydration && this.isCollabHydratedForEditing();')
      && editGateBlock.includes('const allowLocalEdits = baseAllowLocalEdits && collabReconnectStable && hydrated;'),
    'Expected share edit gating to keep the editor locked until post-review collab reconnect and hydration are fully stable',
  );

  const remotePeerBlock = sliceBetween(
    editorSource,
    '  private hasActiveRemoteCollabPeer(): boolean {',
    '\n  private ensureShareAgentPresenceIcons(agentIds: Iterable<string>): void {',
  );
  assert(
    remotePeerBlock.includes('const awareness = collabClient.getAwareness();')
      && remotePeerBlock.includes('const myClientId = awareness.clientID;')
      && remotePeerBlock.includes('if (clientId !== myClientId) hasRemotePeer = true;'),
    'Expected shared review reconnect preservation to distinguish real remote peers from single-window shared editing',
  );

  const authoritativeMarksBlock = sliceBetween(
    editorSource,
    '  private applyAuthoritativeShareMarks(serverMarks: Record<string, StoredMark>): void {',
    '\n  private applyLatestCollabMarksToEditor(): void {',
  );
  assert(
    authoritativeMarksBlock.includes("this.applyExternalMarks(serverMarks, { pruneMissingSuggestions: true });"),
    'Expected authoritative share mark refreshes to prune stale local suggestion anchors when the server says they are gone',
  );

  const applyLatestCollabMarksBlock = sliceBetween(
    editorSource,
    '  private applyLatestCollabMarksToEditor(): void {',
    '\n  private runWithTrackChangesSystemTransactionsSuppressed<T>(run: () => T): T {',
  );
  assert(
    !applyLatestCollabMarksBlock.includes('if (Object.keys(this.lastReceivedServerMarks).length === 0) return;')
      && applyLatestCollabMarksBlock.includes('this.applyExternalMarks(this.lastReceivedServerMarks);')
      && !applyLatestCollabMarksBlock.includes("this.applyExternalMarks(this.lastReceivedServerMarks, { pruneMissingSuggestions: true });")
      && applyLatestCollabMarksBlock.includes('this.resyncPendingInsertMetadataAfterRemoteApply(this.lastReceivedServerMarks);'),
    'Expected live collab mark application to avoid pruning missing pending suggestions while still resyncing pending insert metadata from the current document',
  );

  const acceptPersistedBlock = sliceBetween(
    editorSource,
    '  async markAcceptPersisted(markId: string): Promise<boolean> {',
    '\n  /**\n   * Reject a suggestion without changing the document\n   */',
  );
  assert(
    acceptPersistedBlock.includes("const effectiveMarkId = this.resolveAuthoritativeShareReviewMarkId(markId, sourceMark);")
      && acceptPersistedBlock.includes("tombstoneResolvedMarkIds(Array.from(new Set([markId, effectiveMarkId])), { reason: 'deleted' });")
      && acceptPersistedBlock.indexOf("tombstoneResolvedMarkIds(Array.from(new Set([markId, effectiveMarkId])), { reason: 'deleted' });")
        < acceptPersistedBlock.indexOf("const success = this.tryResolveShareReviewMutationLocally(markId, 'accept', result)")
      && acceptPersistedBlock.includes('const sourceMark = this.getCurrentShareReviewStoredMark(markId);')
      && acceptPersistedBlock.includes("const success = this.tryResolveShareReviewMutationLocally(markId, 'accept', result)")
      && acceptPersistedBlock.includes('|| await this.applyShareMutationDocumentResult(result);')
      && acceptPersistedBlock.includes('await this.waitForStableShareReviewMutationState();')
      && !acceptPersistedBlock.includes('acceptMark(view, markId, parser);'),
    'Expected markAcceptPersisted to remap stale UI ids to the authoritative pending mark, tombstone both local and remote ids, reconcile the mutation, and wait for collab reconnect to settle before returning success',
  );

  const rejectPersistedBlock = sliceBetween(
    editorSource,
    '  async markRejectPersisted(markId: string): Promise<boolean> {',
    '\n  /**\n   * Accept all pending suggestions\n   */',
  );
  assert(
    rejectPersistedBlock.includes('const sourceMark = this.getCurrentShareReviewStoredMark(markId);')
      && rejectPersistedBlock.includes("const effectiveMarkId = this.resolveAuthoritativeShareReviewMarkId(markId, sourceMark);")
      && rejectPersistedBlock.includes("tombstoneResolvedMarkIds(Array.from(new Set([markId, effectiveMarkId])), { reason: 'deleted' });")
      && rejectPersistedBlock.indexOf("tombstoneResolvedMarkIds(Array.from(new Set([markId, effectiveMarkId])), { reason: 'deleted' });")
        < rejectPersistedBlock.indexOf("const success = this.tryResolveShareReviewMutationLocally(markId, 'reject', result)")
      && rejectPersistedBlock.includes('const preserveRejectResultAcrossReconnect = this.hasActiveRemoteCollabPeer();')
      && rejectPersistedBlock.includes("const success = this.tryResolveShareReviewMutationLocally(markId, 'reject', result)")
      && rejectPersistedBlock.includes('|| await this.applyShareMutationDocumentResult(')
      && rejectPersistedBlock.includes('preserveRejectResultAcrossReconnect')
      && rejectPersistedBlock.includes('preserveRejectResultAcrossReconnect')
      && rejectPersistedBlock.includes('skipReconnectTemplateSeed: true,')
      && rejectPersistedBlock.includes('preserveEditorStateDuringReconnect: true,')
      && rejectPersistedBlock.includes('await this.waitForStableShareReviewMutationState();')
      && !rejectPersistedBlock.includes('rejectMark(view, markId);'),
    'Expected markRejectPersisted to tombstone the resolved suggestion, preserve the authoritative reject result through collab reconnect only when a remote peer is present, and wait for reconnect to settle before returning success',
  );

  const settleBlock = sliceBetween(
    editorSource,
    '  private async waitForStableShareReviewMutationState(): Promise<void> {',
    '\n  private getCurrentShareReviewPersistSnapshot(): {',
  );
  assert(
    settleBlock.includes("const deadline = Date.now() + 2500;")
      && settleBlock.includes("const awaitingTemplateSeed = Boolean(this.pendingCollabTemplateMarkdown && this.pendingCollabTemplateMarkdown.length > 0);")
      && settleBlock.includes("const collabReconnectStable = !this.pendingCollabRebindOnSync")
      && settleBlock.includes("&& !this.suppressTrackChangesDuringCollabReconnect")
      && settleBlock.includes("&& !this.collabSessionRefreshInFlight;")
      && settleBlock.includes("const synced = this.collabConnectionStatus === 'connected'")
      && settleBlock.includes("this.traceShareReview('mutation.settle-timeout'"),
    'Expected persisted review mutations to wait for the post-mutation collab reconnect to become stable before another accept/reject can start',
  );

  const flushReviewMutationStateBlock = sliceBetween(
    editorSource,
    '  private async flushShareReviewMutationState(expectedMarkIds: string[] = []): Promise<boolean> {',
    '\n  async markAcceptPersisted(markId: string): Promise<boolean> {',
  );
  assert(
    editorSource.includes('private pendingSharePersistPromise: Promise<boolean> | null = null;')
      && flushReviewMutationStateBlock.includes("this.flushShareMarks({ persistContent: false, forcePersistMarks: true });")
      && flushReviewMutationStateBlock.includes('const pendingPersist = this.pendingSharePersistPromise;')
      && flushReviewMutationStateBlock.includes('await pendingPersist.catch(() => false);'),
    'Expected persisted review mutations to force a canonical mark persist and wait for it before issuing share accept/reject mutations',
  );

  const localResolveBlock = sliceBetween(
    editorSource,
    '  private tryResolveShareReviewMutationLocally(',
    '\n  private async runSerializedShareReviewMutation<T>(run: () => Promise<T>): Promise<T> {',
  );
  assert(
    localResolveBlock.includes("if (markdown === null || collabStatus !== 'pending') return false;")
      && localResolveBlock.indexOf('this.disconnectCollabService();') < localResolveBlock.indexOf("acceptMark(view, markId, parser)")
      && localResolveBlock.includes("resolved = action === 'accept'")
      && localResolveBlock.includes("acceptMark(view, markId, parser)")
      && localResolveBlock.includes(': rejectMark(view, markId);')
      && localResolveBlock.includes('const liveMarkdown = this.normalizeMarkdownForCollab(serializer(view.state.doc));')
      && localResolveBlock.includes("matchedServerResult = liveMarkdown === expectedMarkdown && !Object.prototype.hasOwnProperty.call(liveMetadata, markId);")
      && localResolveBlock.includes('this.pendingCollabReconnectTemplateOverride = expectedMarkdown;')
      && localResolveBlock.includes("const shouldPreserveRejectResultAcrossReconnect = action === 'reject' && this.hasActiveRemoteCollabPeer();")
      && localResolveBlock.includes('if (shouldPreserveRejectResultAcrossReconnect) {')
      && localResolveBlock.includes('this.skipNextCollabTemplateSeed = true;')
      && localResolveBlock.includes('this.preserveEditorStateOnNextCollabReconnect = true;')
      && localResolveBlock.includes('this.disconnectCollabService();')
      && localResolveBlock.includes('collabClient.disconnect();')
      && localResolveBlock.includes('void this.refreshCollabSessionAndReconnect(false);'),
    'Expected persisted review mutations to use the direct local accept/reject path when it matches the authoritative pending-collab server response, and to preserve authoritative reject results through the subsequent collab reconnect only when a remote peer is actually connected',
  );

  console.log('share-review-persisted-canonical-sync-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
