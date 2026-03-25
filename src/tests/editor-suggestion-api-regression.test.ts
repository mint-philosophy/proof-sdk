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
  const agentRoutesSource = readFileSync(path.resolve(process.cwd(), 'server/agent-routes.ts'), 'utf8');
  const documentEngineSource = readFileSync(path.resolve(process.cwd(), 'server/document-engine.ts'), 'utf8');
  const suggestionsSource = readFileSync(path.resolve(process.cwd(), 'src/editor/plugins/suggestions.ts'), 'utf8');

  const acceptSuggestionBlock = sliceBetween(editorSource, '  acceptSuggestion(id: string): boolean {', '\n  /**');
  assert(acceptSuggestionBlock.includes('return this.markAccept(String(id));'), 'Expected acceptSuggestion to delegate to markAccept');

  const rejectSuggestionBlock = sliceBetween(editorSource, '  rejectSuggestion(id: string): boolean {', '\n  /**');
  assert(rejectSuggestionBlock.includes('return this.markReject(String(id));'), 'Expected rejectSuggestion to delegate to markReject');

  const acceptAllBlock = sliceBetween(editorSource, '  acceptAllSuggestions(): number {', '\n  /**');
  assert(acceptAllBlock.includes('return this.markAcceptAll();'), 'Expected acceptAllSuggestions to delegate to markAcceptAll');

  const rejectAllBlock = sliceBetween(editorSource, '  rejectAllSuggestions(): number {', '\n  /**');
  assert(rejectAllBlock.includes('return this.markRejectAll();'), 'Expected rejectAllSuggestions to delegate to markRejectAll');

  const markAcceptBlock = sliceBetween(editorSource, '  markAccept(markId: string): boolean {', '\n  /**\n   * Reject a suggestion without changing the document\n   */');
  assert(
    markAcceptBlock.includes('void shareClient.acceptSuggestion(markId, actor).then((result) => {')
      && markAcceptBlock.includes("console.error('[markAccept] Failed to persist suggestion acceptance via share mutation:', error);"),
    'Expected markAccept to persist accepted suggestions through the share mutation route',
  );

  const markAcceptAllBlock = sliceBetween(editorSource, '  markAcceptAll(): number {', '\n  /**\n   * Reject all pending suggestions\n   */');
  const flushShareReviewMutationStateBlock = sliceBetween(
    editorSource,
    '  private async flushShareReviewMutationState(expectedMarkIds: string[] = []): Promise<boolean> {',
    '\n  markAccept(markId: string): boolean {',
  );
  const sortedPendingIdsBlock = sliceBetween(
    editorSource,
    '  private getSortedPendingSuggestionIdsForShareReview(): string[] {',
    '\n  /**\n   * Accept all pending suggestions\n   */',
  );
  assert(
    sortedPendingIdsBlock.includes('sortedIds = [...getPendingSuggestions(getMarks(view.state))]')
      && sortedPendingIdsBlock.includes("const aMax = a.range?.to ?? a.range?.from ?? -1;")
      && sortedPendingIdsBlock.includes('return bMax - aMax;'),
    'Expected share review batch actions to sort pending suggestions from the live document by descending position before each mutation pass',
  );
  const sortedServerPendingIdsBlock = sliceBetween(
    editorSource,
    '  private getSortedPendingSuggestionIdsFromStoredMarks(marks: Record<string, StoredMark>): string[] {',
    '\n  /**\n   * Accept all pending suggestions\n   */',
  );
  assert(
    sortedServerPendingIdsBlock.includes("return (kind === 'insert' || kind === 'delete' || kind === 'replace') && mark.status === 'pending';")
      && sortedServerPendingIdsBlock.includes("const aMax = a.range?.to ?? a.range?.from ?? -1;")
      && sortedServerPendingIdsBlock.includes('return bMax - aMax;'),
    'Expected share Accept All to recompute pending suggestion order from the latest server marks after each persisted accept',
  );
  assert(
    flushShareReviewMutationStateBlock.includes('this.flushShareMarks({ persistContent: false, forcePersistMarks: true });')
      && flushShareReviewMutationStateBlock.includes('await this.waitForAuthoritativeShareReviewMarks(expectedPendingIds)')
      && flushShareReviewMutationStateBlock.includes('await this.forcePersistCurrentShareReviewState(expectedPendingIds)')
      && flushShareReviewMutationStateBlock.includes("this.traceShareReview('mutation.preflush-failed'")
      && flushShareReviewMutationStateBlock.includes('return false;'),
    'Expected persisted review mutations to verify that pending marks are present in authoritative share state and to fall back to a full pushUpdate before accept/reject proceeds',
  );
  assert(
    markAcceptAllBlock.includes('const initialIds = this.getSortedPendingSuggestionIdsForShareReview();')
      && markAcceptAllBlock.includes('void this.runSerializedShareReviewMutation(async () => {')
      && markAcceptAllBlock.includes('const ready = await this.flushShareReviewMutationState(initialIds);')
      && markAcceptAllBlock.includes('if (!ready) {')
      && markAcceptAllBlock.includes('const snapshot = this.buildShareBatchSuggestionSnapshot();')
      && markAcceptAllBlock.includes('const result = await shareClient.acceptSuggestions(initialIds, actor, undefined, snapshot ?? undefined);')
      && markAcceptAllBlock.includes('const success = await this.applyShareMutationDocumentResult(result, {')
      && markAcceptAllBlock.includes('skipReconnectTemplateSeed: true,')
      && markAcceptAllBlock.includes('preserveEditorStateDuringReconnect: true,')
      && markAcceptAllBlock.includes("tombstoneResolvedMarkIds(initialIds, { reason: 'deleted' });")
      && !markAcceptAllBlock.includes('await this.markAcceptPersisted(suggestionId);')
      && !markAcceptAllBlock.includes('await shareClient.acceptSuggestion(suggestionId, actor);'),
    'Expected share-mode markAcceptAll to use the server-side batch accept mutation and perform a single final authoritative apply/reconnect without replaying the reconnect template over accepted content',
  );
  const markRejectAllBlock = sliceBetween(editorSource, '  markRejectAll(): number {', '\n  /**\n   * Delete a mark by ID\n   */');
  assert(
    markRejectAllBlock.includes('const initialIds = this.getSortedPendingSuggestionIdsForShareReview();')
      && markRejectAllBlock.includes('void this.runSerializedShareReviewMutation(async () => {')
      && markRejectAllBlock.includes('const ready = await this.flushShareReviewMutationState(initialIds);')
      && markRejectAllBlock.includes('if (!ready) {')
      && markRejectAllBlock.includes('const result = await shareClient.rejectSuggestion(suggestionId, actor);')
      && markRejectAllBlock.includes('pendingIds = this.getSortedPendingSuggestionIdsFromStoredMarks(serverMarks)')
      && markRejectAllBlock.includes('const success = await this.applyShareMutationDocumentResult(latestSuccessfulResult);')
      && markRejectAllBlock.includes("tombstoneResolvedMarkIds(rejectedIds, { reason: 'deleted' });")
      && !markRejectAllBlock.includes('await this.markRejectPersisted(suggestionId);'),
    'Expected share-mode markRejectAll to batch persisted rejects server-side and perform a single final authoritative apply/reconnect',
  );

  const handleMarksChangeBlock = sliceBetween(editorSource, '  private handleMarksChange(', '\n  private serializeMarkdown(');
  assert(
    editorSource.includes('private scheduleShareMarksFlush(): void')
      && handleMarksChangeBlock.includes('if (this.isShareMode) {')
      && handleMarksChangeBlock.includes("const liveInsertIds = actionMarks")
      && handleMarksChangeBlock.includes("syncInsertSuggestionMetadataFromDoc(view.state.doc, liveMetadata, liveInsertIds)")
      && handleMarksChangeBlock.includes('this.scheduleShareMarksFlush();')
      && handleMarksChangeBlock.includes('Let content flow through the existing collab binding')
      && handleMarksChangeBlock.includes('} else if (this.collabEnabled && this.collabCanEdit) {')
      && handleMarksChangeBlock.includes('collabClient.setMarksMetadata(metadata);')
      && !handleMarksChangeBlock.includes('this.flushShareMarks();'),
    'Expected share-mode mark updates to resync live insert metadata from the document, then defer the share flush until after the dispatch cycle instead of pushing marks immediately during tracked typing',
  );

  const createTrackChangesToggleBlock = sliceBetween(
    editorSource,
    '  private createTrackChangesToggle(): HTMLElement {',
    '\n  private renderShareBannerContent(',
  );
  assert(
    createTrackChangesToggleBlock.includes('let pointerActivated = false;')
      && createTrackChangesToggleBlock.includes('button.onpointerdown = (event) => {')
      && createTrackChangesToggleBlock.includes('pointerActivated = true;')
      && createTrackChangesToggleBlock.includes('button.onclick = (event) => {')
      && createTrackChangesToggleBlock.includes('if (pointerActivated) {')
      && createTrackChangesToggleBlock.includes('button.onblur = () => {')
      && createTrackChangesToggleBlock.includes('this.setSuggestionsEnabled(false);')
      && createTrackChangesToggleBlock.includes('this.setSuggestionsEnabled(true);'),
    'Expected the Track Changes pill to activate on pointerdown and route through the canonical suggestions state setter',
  );

  const setSuggestionsEnabledBlock = sliceBetween(
    editorSource,
    '  private setSuggestionsEnabled(enabled: boolean): boolean {',
    '\n  /**\n   * Toggle suggestion mode\n   */',
  );
  assert(
    setSuggestionsEnabledBlock.includes('currentEnabled = isSuggestionsEnabledPlugin(view.state);')
      && setSuggestionsEnabledBlock.includes('if (currentEnabled !== enabled) {')
      && setSuggestionsEnabledBlock.includes('enableSuggestionsPlugin(view);')
      && setSuggestionsEnabledBlock.includes('disableSuggestionsPlugin(view);')
      && setSuggestionsEnabledBlock.includes("console.log('[setSuggestionsEnabled]', currentEnabled ? 'enabled' : 'disabled');"),
    'Expected the shared suggestions setter to dispatch the plugin enable/disable transaction and verify the resulting state',
  );

  assert(
    editorSource.includes('isSuggestionsEnabled: () => window.proof.isSuggestionsEnabled(),'),
    'Expected __PROOF_EDITOR__ to expose isSuggestionsEnabled so QA can verify the actual suggestions plugin state',
  );

  assert(
    editorSource.includes('mergedIncomingMarks = mergePendingServerMarks(getMarkMetadataWithQuotes(view.state), incomingMarks);'),
    'Expected collab.onMarks to merge incoming metadata against the quote-aware local snapshot',
  );

  const applyAuthoritativeShareMarksBlock = sliceBetween(
    editorSource,
    '  private applyAuthoritativeShareMarks(serverMarks: Record<string, StoredMark>): void {',
    '\n  private applyLatestCollabMarksToEditor(): void {',
  );
  const resyncPendingInsertMetadataBlock = sliceBetween(
    editorSource,
    '  private resyncPendingInsertMetadataAfterRemoteApply(sourceMarks: Record<string, StoredMark>): void {',
    '\n  private applyLatestCollabMarksToEditor(): void {',
  );
  const applyLatestCollabMarksBlock = sliceBetween(
    editorSource,
    '  private applyLatestCollabMarksToEditor(): void {',
    '\n  private runWithTrackChangesSystemTransactionsSuppressed<T>(run: () => T): T {',
  );
  assert(
    applyAuthoritativeShareMarksBlock.includes('this.resyncPendingInsertMetadataAfterRemoteApply(serverMarks);')
      && applyAuthoritativeShareMarksBlock.includes('this.applyExternalMarks(serverMarks, { pruneMissingSuggestions: true });')
      && resyncPendingInsertMetadataBlock.includes("filter(([, mark]) => mark?.kind === 'insert' && mark?.status === 'pending')")
      && resyncPendingInsertMetadataBlock.includes('const localMetadata = getMarkMetadataWithQuotes(view.state);')
      && resyncPendingInsertMetadataBlock.includes('const syncedMetadata = syncInsertSuggestionMetadataFromDoc(view.state.doc, localMetadata, insertIds);')
      && resyncPendingInsertMetadataBlock.includes('setMarkMetadata(view, syncedMetadata);')
      && applyLatestCollabMarksBlock.includes('this.applyExternalMarks(this.lastReceivedServerMarks);')
      && !applyLatestCollabMarksBlock.includes('this.applyExternalMarks(this.lastReceivedServerMarks, { pruneMissingSuggestions: true });')
      && applyLatestCollabMarksBlock.includes('this.resyncPendingInsertMetadataAfterRemoteApply(this.lastReceivedServerMarks);'),
    'Expected live collab mark application to avoid pruning missing pending suggestions while still resyncing pending insert metadata from the live doc',
  );

  assert(
    suggestionsSource.includes('export function enableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {')
      && suggestionsSource.includes('export function disableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {')
      && suggestionsSource.includes('resetSuggestionsInsertCoalescing();'),
    'Expected toggling track changes on or off to clear stale insert coalescing state',
  );
  const suggestionsAppendTransactionBlock = sliceBetween(
    suggestionsSource,
    '    appendTransaction(trs, oldState, newState) {',
    '\n\n    props: {',
  );
  assert(
    suggestionsAppendTransactionBlock.includes('const hasBlockingMarksMeta = trs.some((tr) => {')
      && suggestionsAppendTransactionBlock.includes("const hasWrappedSuggestionTransaction = trs.some((tr) => tr.getMeta('suggestions-wrapped'));")
      && suggestionsAppendTransactionBlock.includes("return (meta as { type?: unknown }).type !== 'INTERNAL';")
      && suggestionsAppendTransactionBlock.includes('const hasRemoteSuggestionInsert = trs.some((tr) =>')
      && suggestionsAppendTransactionBlock.includes('transactionCarriesInsertedSuggestionMarks(tr)')
      && suggestionsAppendTransactionBlock.includes('const splitMergeTr = buildAdjacentSplitInsertMergeTransaction(oldState, newState);')
      && suggestionsAppendTransactionBlock.includes('if (hasWrappedSuggestionTransaction) {')
      && suggestionsAppendTransactionBlock.includes('|| isExplicitYjsChangeOriginTransaction(tr)')
      && !suggestionsAppendTransactionBlock.includes("|| tr.getMeta(marksPluginKey) !== undefined"),
    'Expected suggestions appendTransaction to ignore authored-tracker INTERNAL mark transactions, still allow split-insert healing after wrapped local typing, and skip explicit Yjs change-origin echoes plus raw y-sync transactions that already carry incoming suggestion marks',
  );

  const setupSuggestionsInterceptorBlock = sliceBetween(editorSource, '  private setupSuggestionsInterceptor(): void {', '\n  private getDomSelectionRange(');
  const preserveInsertCoalescingBlock = sliceBetween(
    editorSource,
    '  private shouldPreserveSuggestionsInsertCoalescingAfterRemoteContentChange(',
    '\n  /**\n   * Set up the suggestions interceptor to convert edits to tracked changes',
  );
  assert(
    setupSuggestionsInterceptorBlock.includes('const isSystemTrackChangesSuppressed = Boolean(tr?.docChanged) && (')
      && setupSuggestionsInterceptorBlock.includes('this.suppressTrackChangesSystemTransactionsDepth > 0')
      && setupSuggestionsInterceptorBlock.includes('this.suppressTrackChangesDuringCollabReconnect')
      && setupSuggestionsInterceptorBlock.includes('const carriesIncomingSuggestionMarks = Boolean(tr?.docChanged) && transactionCarriesInsertedSuggestionMarks(tr);')
      && setupSuggestionsInterceptorBlock.includes("const isRemoteContentChange = Boolean(tr?.docChanged) && (")
      && setupSuggestionsInterceptorBlock.includes('|| (yjsOrigin.isYjsOrigin && carriesIncomingSuggestionMarks)')
      && setupSuggestionsInterceptorBlock.includes('if (isRemoteContentChange) {')
      && setupSuggestionsInterceptorBlock.includes('const preserveInsertCoalescing = this.shouldPreserveSuggestionsInsertCoalescingAfterRemoteContentChange(')
      && setupSuggestionsInterceptorBlock.includes('if (!preserveInsertCoalescing) {')
      && setupSuggestionsInterceptorBlock.includes('resetSuggestionsInsertCoalescing();')
      && setupSuggestionsInterceptorBlock.includes("const isHistoryChange = tr?.getMeta?.('history$') !== undefined;")
      && !setupSuggestionsInterceptorBlock.includes("const isHistoryChange = tr?.getMeta?.('history$') !== undefined || tr?.getMeta?.('addToHistory') === false;")
      && setupSuggestionsInterceptorBlock.includes('if (isSystemTrackChangesSuppressed) {')
      && setupSuggestionsInterceptorBlock.includes('dispatchWithRevision(tr);'),
    'Expected the suggestions interceptor to pass through collab/template system transactions, while skipping TC wrapping for explicit Yjs echoes and raw y-sync transactions that already carry incoming suggestion-marked content',
  );
  assert(
    preserveInsertCoalescingBlock.includes('if (!this.collabEnabled) return false;')
      && preserveInsertCoalescingBlock.includes('if (!view.hasFocus()) return false;')
      && preserveInsertCoalescingBlock.includes('if (!beforeState.selection.empty) return false;')
      && preserveInsertCoalescingBlock.includes('if (hasActiveInsertCoalescingCandidate(beforeState, beforeState.selection.from)) return true;')
      && preserveInsertCoalescingBlock.includes("return carriesIncomingSuggestionMarks || isExplicitYjsChangeOriginTransaction(transaction);"),
    'Expected remote self-echo handling to preserve tracked-insert coalescing only for focused recent local typing in collab mode',
  );

  const applyPendingCollabTemplateBlock = sliceBetween(editorSource, '  private applyPendingCollabTemplate(): void {', '\n  private disconnectCollabService(): void {');
  assert(
    editorSource.includes('private runWithTrackChangesSystemTransactionsSuppressed<T>(run: () => T): T {')
      && editorSource.includes('private suppressTrackChangesDuringCollabReconnect: boolean = false;')
      && applyPendingCollabTemplateBlock.includes('this.runWithTrackChangesSystemTransactionsSuppressed(() => {')
      && applyPendingCollabTemplateBlock.includes("const currentFragment = currentDoc.getXmlFragment('prosemirror');")
      && applyPendingCollabTemplateBlock.includes('|| !this.isYjsFragmentStructurallyEmpty(currentFragment)')
      && applyPendingCollabTemplateBlock.includes('collabService.applyTemplate(latestTemplate'),
    'Expected pending collab template application to suppress track-changes wrapping while it seeds canonical content back into Yjs, and to abort if the room fragment hydrates before the delayed seed runs',
  );

  assert(
    shareClientSource.includes('async acceptSuggestion(')
      && shareClientSource.includes('async acceptSuggestions(')
      && shareClientSource.includes("path: 'accept' | 'reject';")
      && shareClientSource.includes("/agent/${encodeURIComponent(this.slug as string)}/marks/${args.path}"),
    'Expected ShareClient to expose dedicated single-mark and batch accept mutations',
  );

  const acceptRouteBlock = sliceBetween(
    agentRoutesSource,
    "agentRoutes.post('/:slug/marks/accept', async (req: Request, res: Response) => {",
    "\nagentRoutes.post('/:slug/marks/reject',",
  );
  assert(
    acceptRouteBlock.includes('acquireRewriteLock(slug);')
      && acceptRouteBlock.includes('if (!keepRewriteLockCooldown) {')
      && acceptRouteBlock.includes('releaseRewriteLockImmediately(slug);')
      && acceptRouteBlock.includes('void notifyCollabMutation(')
      && acceptRouteBlock.includes('verify: true')
      && acceptRouteBlock.includes("source: 'marks.accept'")
      && acceptRouteBlock.includes('fallbackBarrier: true')
      && acceptRouteBlock.includes("status: 'pending'")
      && acceptRouteBlock.includes('storeIdempotentMutationResult(replay, mutationRoute, slug, 202, result.body);')
      && acceptRouteBlock.includes('sendMutationResponse(res, 202, result.body, { route: mutationRoute, slug });')
      && acceptRouteBlock.includes('await invalidateLoadedCollabDocumentAndWait(slug);')
      && !acceptRouteBlock.includes("code: 'COLLAB_SYNC_FAILED'"),
    'Expected /marks/accept to return canonical success immediately with pending collab status, then verify/invalidate in the background instead of blocking on post-commit drift checks',
  );

  const rejectRouteBlock = sliceBetween(
    agentRoutesSource,
    "agentRoutes.post('/:slug/marks/reject', async (req: Request, res: Response) => {",
    "\nagentRoutes.post('/:slug/marks/reply',",
  );
  assert(
    rejectRouteBlock.includes('acquireRewriteLock(slug);')
      && rejectRouteBlock.includes('if (!keepRewriteLockCooldown) {')
      && rejectRouteBlock.includes('releaseRewriteLockImmediately(slug);')
      && rejectRouteBlock.includes("details: 'suggestion.reject'"),
    'Expected /marks/reject to hold the rewrite lock long enough to block stale collab writes during share review rejection',
  );

  const asyncFallbackAcceptBlock = sliceBetween(
    documentEngineSource,
    "      && canAcceptDeleteSuggestionWithoutHydration(doc.markdown, fallbackMark)",
    "\n    if (\n      status === 'rejected'",
  );
  assert(
    asyncFallbackAcceptBlock.includes('const deleteCleanupOffsets = getDeleteSuggestionCleanupOffsets(doc.markdown, fallbackMark);')
      && asyncFallbackAcceptBlock.includes("nextMarkdown: applyMutationCleanup('POST /marks/accept', acceptedMarkdown, deleteCleanupOffsets),"),
    'Expected async delete-accept fallback to run the same empty-span cleanup as the canonical sync path',
  );

  console.log('✓ suggestion API actions route through share-aware accept/reject persistence');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
