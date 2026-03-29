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
      && shareClientSource.includes('private unwrapMutationSuccessPayload(')
      && shareClientSource.includes('private unwrapMutationErrorDetails(')
      && shareClientSource.includes('const body = this.unwrapMutationSuccessPayload(payload);')
      && shareClientSource.includes("markdown: typeof body?.markdown === 'string'")
      && shareClientSource.includes("status: typeof collab.status === 'string' ? collab.status : undefined")
      && shareClientSource.includes('const recovered = this.parseShareMarkMutationResponse(this.unwrapMutationErrorDetails(payload));')
      && shareClientSource.includes("markdown: typeof context.doc?.markdown === 'string' ? context.doc.markdown : undefined"),
    'Expected share mark mutations to unwrap coordinator success and recoverable error payloads so canonical markdown survives persisted review actions',
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
      && applyResultBlock.includes("const resetEditorDocOnReconnect = options?.resetEditorDocOnReconnect === true;")
      && applyResultBlock.includes("if (markdown !== null && collabStatus === 'pending' && preserveEditorStateDuringReconnect) {")
      && applyResultBlock.includes('this.armShareReviewRefreshCooldown();')
      && applyResultBlock.includes('this.pendingCollabReconnectTemplateOverride = null;')
      && applyResultBlock.includes('this.skipNextCollabTemplateSeed = true;')
      && applyResultBlock.includes('this.preserveEditorStateOnNextCollabReconnect = true;')
      && applyResultBlock.includes('this.loadCanonicalShareDocument(markdown, marks);')
      && applyResultBlock.includes("this.setSuggestionsEnabled(true, { updateDesiredState: false });")
      && applyResultBlock.includes('this.suppressTrackChangesDuringCollabReconnect = false;')
      && applyResultBlock.includes('this.releaseDeferredShareMarksFlush();')
      && applyResultBlock.includes('void this.refreshCollabSessionAndReconnect(false);')
      && applyResultBlock.includes('this.pendingCollabReconnectTemplateOverride = skipReconnectTemplateSeed')
      && applyResultBlock.includes(': this.normalizeMarkdownForCollab(markdown);')
      && applyResultBlock.includes('this.skipNextCollabTemplateSeed = skipReconnectTemplateSeed;')
      && applyResultBlock.includes('this.preserveEditorStateOnNextCollabReconnect = preserveEditorStateDuringReconnect;')
      && applyResultBlock.includes('this.resetEditorDocOnNextCollabReconnect = resetEditorDocOnReconnect;')
      && applyResultBlock.includes("this.collabConnectionStatus = 'connecting';")
      && applyResultBlock.includes('this.collabIsSynced = false;')
      && applyResultBlock.includes('this.updateShareEditGate();')
      && applyResultBlock.includes('this.disconnectCollabService();')
      && applyResultBlock.includes('collabClient.disconnect();')
      && applyResultBlock.lastIndexOf('this.updateShareEditGate();') > applyResultBlock.indexOf("this.collabConnectionStatus = 'connecting';"),
    'Expected share review mutation results to keep preserved reconnects on the canonical local editor state path, while still distinguishing optional hard editor-doc resets for the fallback disconnect/reconnect branch',
  );

  const loadCanonicalShareDocumentBlock = sliceBetween(
    editorSource,
    '  private loadCanonicalShareDocument(markdown: string, marks: Record<string, StoredMark>): void {',
    '\n  private async applyShareMutationDocumentResult(',
  );
  assert(
    loadCanonicalShareDocumentBlock.includes('this.loadDocument(embedMarks(markdown, marks), {')
      && loadCanonicalShareDocumentBlock.includes("allowShareContentMutation: true,")
      && loadCanonicalShareDocumentBlock.includes('preserveHistory: true,')
      && loadCanonicalShareDocumentBlock.includes("if (!this.editor || Object.keys(marks).length === 0 || this.isEditorDocStructurallyEmpty()) {")
      && loadCanonicalShareDocumentBlock.includes('this.applyingCollabRemote = true;')
      && loadCanonicalShareDocumentBlock.includes('this.suppressMarksSync = true;')
      && loadCanonicalShareDocumentBlock.includes('this.applyExternalMarks(marks, { pruneMissingSuggestions: true });')
      && loadCanonicalShareDocumentBlock.includes('this.resyncPendingInsertMetadataAfterRemoteApply(marks);'),
    'Expected canonical share review reloads to immediately re-anchor authoritative pending marks after loadDocument so surviving suggestions do not disappear until the next collab sync pulse',
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
      && reconnectBlock.includes('const forceResetEditorDoc = this.resetEditorDocOnNextCollabReconnect;')
      && reconnectBlock.includes('this.resetEditorDocOnNextCollabReconnect = false;')
      && reconnectBlock.includes('const shouldPreserveLocalState = forcePreserveEditorState')
      && reconnectBlock.includes('const canUseSoftRefresh = shouldPreserveLocalState && !collabClient.requiresHardReconnect(refreshed.session);')
      && reconnectBlock.includes('if (canUseSoftRefresh) {')
      && reconnectBlock.includes('this.pendingCollabRebindOnSync = forceResetEditorDoc;')
      && reconnectBlock.includes('this.pendingCollabRebindResetDoc = forceResetEditorDoc;')
      && reconnectBlock.includes('this.resetPendingCollabTemplateState(true);')
      && reconnectBlock.includes('this.collabHydrationSatisfiedByPreservedState = !forceResetEditorDoc && this.collabCanEdit;')
      && reconnectBlock.includes('} else {')
      && reconnectBlock.includes('this.resetProjectionPublishState();')
      && reconnectBlock.includes('this.pendingCollabRebindResetDoc = forceResetEditorDoc || !shouldPreserveLocalState || !this.collabCanEdit;')
      && reconnectBlock.includes('this.collabHydrationSatisfiedByPreservedState = !this.pendingCollabRebindResetDoc && shouldPreserveLocalState && this.collabCanEdit;')
      && reconnectBlock.includes('if (this.collabHydrationSatisfiedByPreservedState) {')
      && reconnectBlock.includes('this.markInitialCollabHydrationComplete();')
      && reconnectBlock.includes('if (this.skipNextCollabTemplateSeed) {')
      && reconnectBlock.includes('reconnectTemplate = null;')
      && reconnectBlock.includes('this.skipNextCollabTemplateSeed = false;')
      && reconnectBlock.includes('if (!canUseSoftRefresh) {')
      && reconnectBlock.includes('this.pendingCollabTemplateMarkdown = this.shouldAllowCollabTemplateSeed(refreshed.session)'),
    'Expected collab reconnect to treat access-epoch token refreshes as a soft same-room reconnect while still allowing persisted review reconnects to force a clean editor-doc reset from the synced Y.Doc before editing resumes',
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
      && editGateBlock.includes('const hydratedForEditing = this.hasCompletedInitialCollabHydration')
      && editGateBlock.includes('const allowTransientRecoveryEdits = shouldAllowShareLocalEditsDuringTransientCollabRecovery({')
      && editGateBlock.includes("&& (this.collabConnectionStatus === 'connected' || allowTransientRecoveryEdits)")
      && editGateBlock.includes('this.hasCompletedInitialCollabHydration')
      && editGateBlock.includes(': hydratedForEditing;')
      && !editGateBlock.includes('&& this.collabIsSynced')
      && editGateBlock.includes('const allowLocalEdits = baseAllowLocalEdits && collabReconnectStable && hydrated;'),
    'Expected share edit gating to keep the editor locked until post-review collab reconnect is stable, while allowing hydrated preserved-state sessions with pending local collab updates to stay editable through transient reconnect churn',
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

  const rehydrateMarksBlock = sliceBetween(
    editorSource,
    '  private rehydrateServerMarksAfterCollabHydration(): void {',
    '\n  private runWithTrackChangesSystemTransactionsSuppressed<T>(run: () => T): T {',
  );
  assert(
    rehydrateMarksBlock.includes('const shouldRestoreTrackChanges = hasPendingSuggestions || this.desiredSuggestionsEnabled;')
      && rehydrateMarksBlock.includes('this.suppressTrackChangesDuringCollabReconnect = false;')
      && rehydrateMarksBlock.includes('this.updateShareEditGate();')
      && rehydrateMarksBlock.indexOf('this.suppressTrackChangesDuringCollabReconnect = false;')
        < rehydrateMarksBlock.indexOf('const shouldRestoreTrackChanges = hasPendingSuggestions || this.desiredSuggestionsEnabled;')
      && rehydrateMarksBlock.includes("this.setSuggestionsEnabled(true, { updateDesiredState: hasPendingSuggestions });")
      && !rehydrateMarksBlock.includes("this.setSuggestionsEnabled(true, { updateDesiredState: hasPendingSuggestions });\n      this.suppressTrackChangesDuringCollabReconnect = false;"),
    'Expected collab rehydration to restore track changes after the final persisted reject removes every pending mark, so the next edit still creates fresh suggestions when TC was already enabled',
  );

  const localResolveEditGateBlock = sliceBetween(
    editorSource,
    '  private tryResolveShareReviewMutationLocally(',
    '\n  private async runSerializedShareReviewMutation<T>(run: () => Promise<T>): Promise<T> {',
  );
  assert(
    localResolveEditGateBlock.includes('this.suppressTrackChangesDuringCollabReconnect = true;')
      && localResolveEditGateBlock.includes("this.collabConnectionStatus = 'connecting';")
      && localResolveEditGateBlock.includes('this.collabIsSynced = false;')
      && localResolveEditGateBlock.includes('this.updateShareEditGate();'),
    'Expected the local accept/reject fast path to lock local editing immediately while the post-mutation collab reconnect is still suppressing track changes',
  );
  assert(
    editorSource.includes("if (!this.pendingCollabTemplateMarkdown && !this.pendingCollabRebindOnSync) {")
      && editorSource.includes('this.suppressTrackChangesDuringCollabReconnect = false;')
      && editorSource.includes('this.updateShareEditGate();')
      && editorSource.includes('this.releaseDeferredShareMarksFlush();'),
    'Expected reconnect completion to reopen the share edit gate as soon as reconnect suppression clears, so users can immediately re-edit accepted text while other pending suggestions still remain',
  );

  const acceptPersistedBlock = sliceBetween(
    editorSource,
    '  async markAcceptPersisted(markId: string): Promise<boolean> {',
    '\n  /**\n   * Reject a suggestion without changing the document\n   */',
  );
  assert(
    acceptPersistedBlock.includes("const effectiveMarkId = this.resolveShareReviewMutationRequestMarkId(markId, sourceMark);")
      && editorSource.includes('private resolveShareReviewMutationRequestMarkId(markId: string, sourceMark: StoredMark | null): string {')
      && editorSource.includes('return this.resolveAuthoritativeShareReviewMarkId(markId, sourceMark);')
      && editorSource.includes('private async ensureShareReviewMutationAppliedLocally(')
      && editorSource.includes('private getMissingPendingShareReviewMarkIds(expectedIds: string[]): string[] {')
      && editorSource.includes('private shouldAwaitShareReviewMutationSettle(): boolean {')
      && editorSource.includes('private getEquivalentPendingShareReviewMarkIds(sourceMark: StoredMark | null): string[] {')
      && acceptPersistedBlock.includes('const resolvedMarkIds = Array.from(new Set([markId, effectiveMarkId]));')
      && acceptPersistedBlock.includes("tombstoneResolvedMarkIds(resolvedMarkIds, { reason: 'deleted' });")
      && acceptPersistedBlock.indexOf("tombstoneResolvedMarkIds(resolvedMarkIds, { reason: 'deleted' });")
        < acceptPersistedBlock.indexOf("let success = !shouldPreferCanonicalDeleteResult")
      && acceptPersistedBlock.includes('const sourceMark = this.getCurrentShareReviewStoredMark(markId);')
      && acceptPersistedBlock.includes('const resolvedSourceMark = this.getAuthoritativeServerMarksForReview()[effectiveMarkId] ?? sourceMark;')
      && acceptPersistedBlock.includes("let success = !shouldPreferCanonicalDeleteResult")
      && acceptPersistedBlock.includes('success = await this.applyShareMutationDocumentResult(result);')
      && acceptPersistedBlock.includes('success = await this.ensureShareReviewMutationAppliedLocally(')
      && acceptPersistedBlock.includes('const shouldAwaitStableState = this.shouldAwaitShareReviewMutationSettle();')
      && acceptPersistedBlock.includes('if (shouldAwaitStableState) {')
      && acceptPersistedBlock.includes('await this.waitForStableShareReviewMutationState();')
      && editorSource.includes('const authoritativePendingIds = (result?.marks && typeof result.marks === \'object\' && !Array.isArray(result.marks))')
      && editorSource.includes('const missingAuthoritativePendingIds = this.getMissingPendingShareReviewMarkIds(authoritativePendingIds);')
      && editorSource.includes('|| missingAuthoritativePendingIds.length > 0')
      && !acceptPersistedBlock.includes('acceptMark(view, markId, parser);'),
    'Expected markAcceptPersisted to resolve the request id against the authoritative pending server marks, tombstone both local and remote ids, verify that the accepted mark or any equivalent pending suggestion is actually gone locally, reconcile the mutation, and re-verify after any pending collab reconnect before treating the persisted accept as settled',
  );

  const rejectPersistedBlock = sliceBetween(
    editorSource,
    '  async markRejectPersisted(markId: string): Promise<boolean> {',
    '\n  /**\n   * Accept all pending suggestions\n   */',
  );
  assert(
    rejectPersistedBlock.includes('const sourceMark = this.getCurrentShareReviewStoredMark(markId);')
      && rejectPersistedBlock.includes("const effectiveMarkId = this.resolveShareReviewMutationRequestMarkId(markId, sourceMark);")
      && rejectPersistedBlock.includes("tombstoneResolvedMarkIds(Array.from(new Set([markId, effectiveMarkId])), { reason: 'deleted' });")
      && rejectPersistedBlock.indexOf("tombstoneResolvedMarkIds(Array.from(new Set([markId, effectiveMarkId])), { reason: 'deleted' });")
        < rejectPersistedBlock.indexOf("const success = (")
      && rejectPersistedBlock.includes('const preserveRejectResultAcrossReconnect = this.hasActiveRemoteCollabPeer();')
      && rejectPersistedBlock.includes('const resolvedSourceMark = this.getAuthoritativeServerMarksForReview()[effectiveMarkId] ?? sourceMark;')
      && rejectPersistedBlock.includes("const success = (")
      && rejectPersistedBlock.includes("!shouldPreferCanonicalDeleteResult")
      && rejectPersistedBlock.includes('|| await this.applyShareMutationDocumentResult(')
      && rejectPersistedBlock.includes('preserveRejectResultAcrossReconnect')
      && rejectPersistedBlock.includes('preserveRejectResultAcrossReconnect')
      && rejectPersistedBlock.includes('skipReconnectTemplateSeed: true,')
      && rejectPersistedBlock.includes('preserveEditorStateDuringReconnect: true,')
      && rejectPersistedBlock.includes('if (this.hasActiveRemoteCollabPeer()) {')
      && rejectPersistedBlock.includes('await this.waitForStableShareReviewMutationState();')
      && !rejectPersistedBlock.includes('rejectMark(view, markId);'),
    'Expected markRejectPersisted to preserve the current local pending mark id when it is still valid, tombstone the resolved suggestion, preserve the authoritative reject result through collab reconnect only when a remote peer is present, and only block on collab settle when a remote peer is actually connected',
  );

  const settleBlock = sliceBetween(
    editorSource,
    '  private async waitForStableShareReviewMutationState(): Promise<void> {',
    '\n  private getCurrentShareReviewPersistSnapshot(): {',
  );
  assert(
    settleBlock.includes("const deadline = Date.now() + 10_000;")
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
    editorSource.includes('private shareReviewMutationDepth: number = 0;')
      && editorSource.includes('private deferredShareMarksFlush: boolean = false;')
      && editorSource.includes('private pendingSharePersistPromise: Promise<boolean> | null = null;')
      && editorSource.includes('private doShareReviewMutationMarkdownsMatch(')
      && editorSource.includes('private shouldDeferShareMarksFlush(): boolean {')
      && editorSource.includes('return this.shareReviewMutationDepth > 0 || this.suppressTrackChangesDuringCollabReconnect;')
      && editorSource.includes('private deferShareMarksFlush(): void {')
      && editorSource.includes('this.deferredShareMarksFlush = true;')
      && editorSource.includes('private releaseDeferredShareMarksFlush(): void {')
      && editorSource.includes('this.deferredShareMarksFlush = false;')
      && editorSource.includes('this.scheduleShareMarksFlush();')
      && flushReviewMutationStateBlock.includes('if (this.shareMarksFlushTimer !== null) {')
      && flushReviewMutationStateBlock.includes('clearTimeout(this.shareMarksFlushTimer);')
      && !flushReviewMutationStateBlock.includes("this.flushShareMarks({ persistContent: false, forcePersistMarks: true });")
      && flushReviewMutationStateBlock.includes('const pendingPersist = this.pendingSharePersistPromise;')
      && flushReviewMutationStateBlock.includes('await pendingPersist.catch(() => false);')
      && flushReviewMutationStateBlock.includes('const expectedMarkdown = currentSnapshot?.markdown ?? null;')
      && flushReviewMutationStateBlock.includes('await this.waitForAuthoritativeShareReviewMarks(expectedPendingIds, {')
      && flushReviewMutationStateBlock.includes('expectedMarkdown,'),
    'Expected persisted review mutations to defer queued share mark flushes while a review mutation or post-mutation reconnect is active, and to wait for authoritative pending marks plus matching markdown before issuing share accept/reject mutations',
  );

  const serializedMutationBlock = sliceBetween(
    editorSource,
    '  private async runSerializedShareReviewMutation<T>(run: () => Promise<T>): Promise<T> {',
    '\n  private shouldAwaitShareReviewMutationSettle(): boolean {',
  );
  assert(
    serializedMutationBlock.includes('this.shareReviewMutationDepth += 1;')
      && serializedMutationBlock.includes('this.shareReviewMutationDepth = Math.max(0, this.shareReviewMutationDepth - 1);')
      && serializedMutationBlock.includes('this.releaseDeferredShareMarksFlush();'),
    'Expected serialized share review mutations to hold a dedicated in-flight depth guard and only release deferred marks flushes after the mutation fully unwinds',
  );

  const localResolveBlock = sliceBetween(
    editorSource,
    '  private tryResolveShareReviewMutationLocally(',
    '\n  private async runSerializedShareReviewMutation<T>(run: () => Promise<T>): Promise<T> {',
  );
  assert(
    localResolveBlock.includes("if (markdown === null || collabStatus !== 'pending') return false;")
      && localResolveBlock.includes('this.resetEditorDocOnNextCollabReconnect = true;')
      && localResolveBlock.includes("this.traceShareReview('mutation.local-resolve.disconnect-old-room'")
      && localResolveBlock.indexOf('this.disconnectCollabService();') < localResolveBlock.indexOf("acceptMark(view, markId, parser)")
      && localResolveBlock.includes("resolved = action === 'accept'")
      && localResolveBlock.includes("acceptMark(view, markId, parser)")
      && localResolveBlock.includes(': rejectMark(view, markId);')
      && localResolveBlock.includes('const liveMarkdown = this.normalizeMarkdownForCollab(serializer(view.state.doc));')
      && localResolveBlock.includes("matchedServerResult = liveMarkdown === expectedMarkdown && !Object.prototype.hasOwnProperty.call(liveMetadata, markId);")
      && localResolveBlock.includes('this.applyAuthoritativeShareMarks(serverMarks);')
      && localResolveBlock.includes('this.pendingCollabReconnectTemplateOverride = expectedMarkdown;')
      && localResolveBlock.includes("const shouldPreserveMatchedResultAcrossReconnect = action === 'accept'")
      && localResolveBlock.includes("|| (action === 'reject' && this.hasActiveRemoteCollabPeer());")
      && localResolveBlock.includes('if (shouldPreserveMatchedResultAcrossReconnect) {')
      && localResolveBlock.includes('this.skipNextCollabTemplateSeed = true;')
      && localResolveBlock.includes('this.preserveEditorStateOnNextCollabReconnect = true;')
      && localResolveBlock.includes('this.disconnectCollabService();')
      && localResolveBlock.includes('collabClient.disconnect();')
      && localResolveBlock.includes('void this.refreshCollabSessionAndReconnect(false);'),
    'Expected persisted review mutations to use the direct local accept/reject path when it matches the authoritative pending-collab server response, immediately reapply authoritative remaining marks, and force the next collab bind to reset from the synced Y.Doc so editor mappings stay fresh after review',
  );

  console.log('share-review-persisted-canonical-sync-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
