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
      && applyLatestCollabMarksBlock.includes("this.applyExternalMarks(this.lastReceivedServerMarks, { pruneMissingSuggestions: true });"),
    'Expected collab mark application to treat an empty authoritative mark set as a real signal and prune stale suggestion anchors',
  );

  const acceptPersistedBlock = sliceBetween(
    editorSource,
    '  async markAcceptPersisted(markId: string): Promise<boolean> {',
    '\n  /**\n   * Reject a suggestion without changing the document\n   */',
  );
  assert(
    acceptPersistedBlock.includes("tombstoneResolvedMarkIds([markId], { reason: 'deleted' });")
      && acceptPersistedBlock.indexOf("tombstoneResolvedMarkIds([markId], { reason: 'deleted' });")
        < acceptPersistedBlock.indexOf("const success = this.tryResolveShareReviewMutationLocally(markId, 'accept', result)")
      && acceptPersistedBlock.includes("const success = this.tryResolveShareReviewMutationLocally(markId, 'accept', result)")
      && acceptPersistedBlock.includes('|| await this.applyShareMutationDocumentResult(result);')
      && acceptPersistedBlock.includes('await this.waitForStableShareReviewMutationState();')
      && !acceptPersistedBlock.includes('acceptMark(view, markId, parser);'),
    'Expected markAcceptPersisted to tombstone the resolved suggestion, reconcile the mutation, and wait for collab reconnect to settle before returning success',
  );

  const rejectPersistedBlock = sliceBetween(
    editorSource,
    '  async markRejectPersisted(markId: string): Promise<boolean> {',
    '\n  /**\n   * Accept all pending suggestions\n   */',
  );
  assert(
    rejectPersistedBlock.includes("tombstoneResolvedMarkIds([markId], { reason: 'deleted' });")
      && rejectPersistedBlock.indexOf("tombstoneResolvedMarkIds([markId], { reason: 'deleted' });")
        < rejectPersistedBlock.indexOf("const success = this.tryResolveShareReviewMutationLocally(markId, 'reject', result)")
      && rejectPersistedBlock.includes("const success = this.tryResolveShareReviewMutationLocally(markId, 'reject', result)")
      && rejectPersistedBlock.includes('|| await this.applyShareMutationDocumentResult(result);')
      && rejectPersistedBlock.includes('await this.waitForStableShareReviewMutationState();')
      && !rejectPersistedBlock.includes('rejectMark(view, markId);'),
    'Expected markRejectPersisted to tombstone the resolved suggestion, reconcile the mutation, and wait for collab reconnect to settle before returning success',
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
      && localResolveBlock.includes('this.disconnectCollabService();')
      && localResolveBlock.includes('collabClient.disconnect();')
      && localResolveBlock.includes('void this.refreshCollabSessionAndReconnect(false);'),
    'Expected persisted review mutations to use the direct local accept/reject path when it matches the authoritative pending-collab server response, then tear down the old collab room before reconnecting',
  );

  console.log('share-review-persisted-canonical-sync-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
