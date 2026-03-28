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
  const authoredTrackerSource = readFileSync(path.resolve(process.cwd(), 'src/editor/plugins/authored-tracker.ts'), 'utf8');

  assert(
    agentRoutesSource.includes('preserveMutationBaseDocument: true,')
      && documentEngineSource.includes('context?.mutationBase')
      && documentEngineSource.includes('|| context.preserveMutationBaseDocument')
      && documentEngineSource.includes('if (context?.mutationBase && !context.preserveMutationBaseDocument) {'),
    'Expected snapshot-overlaid mark mutations to preserve the client markdown through async hydration, including through temporary projection-readiness gates, instead of swapping back to persisted proof-span markdown',
  );

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
    '\n  private buildShareBatchSuggestionSnapshot(): { markdown: string; marks: Record<string, unknown> } | null {',
  );
  assert(
    sortedServerPendingIdsBlock.includes("return (kind === 'insert' || kind === 'delete' || kind === 'replace') && mark.status === 'pending';")
      && sortedServerPendingIdsBlock.includes("const aMax = a.range?.to ?? a.range?.from ?? -1;")
      && sortedServerPendingIdsBlock.includes('return bMax - aMax;'),
    'Expected share Accept All to recompute pending suggestion order from the latest server marks after each persisted accept',
  );
  assert(
    sortedServerPendingIdsBlock.includes('private getCurrentShareReviewStoredMark(markId: string): StoredMark | null {')
      && sortedServerPendingIdsBlock.includes('private getAuthoritativePendingSuggestionIdsForShareReview(): string[] {')
      && sortedServerPendingIdsBlock.includes('private resolveAuthoritativeShareReviewMarkId(markId: string, sourceMark: StoredMark | null): string {')
      && sortedServerPendingIdsBlock.includes('const authoritativeMark = this.lastReceivedServerMarks[markId];')
      && sortedServerPendingIdsBlock.includes('const score = this.scoreEquivalentShareReviewMark(sourceMark, candidateMark);'),
    'Expected persisted share review actions to remap stale UI suggestion ids onto the latest authoritative pending marks before sending accept/reject mutations',
  );
  assert(
    flushShareReviewMutationStateBlock.includes('if (this.shareMarksFlushTimer !== null) {')
      && flushShareReviewMutationStateBlock.includes('clearTimeout(this.shareMarksFlushTimer);')
      && !flushShareReviewMutationStateBlock.includes('this.flushShareMarks({ persistContent: false, forcePersistMarks: true });')
      && flushShareReviewMutationStateBlock.includes('await this.waitForAuthoritativeShareReviewMarks(expectedPendingIds)')
      && flushShareReviewMutationStateBlock.includes('await this.forcePersistCurrentShareReviewState(expectedPendingIds)')
      && flushShareReviewMutationStateBlock.includes("this.traceShareReview('mutation.preflush-failed'")
      && flushShareReviewMutationStateBlock.includes('return false;'),
    'Expected persisted review mutations to cancel any pending async marks-only flush, verify that pending marks are present in authoritative share state, and fall back to a full pushUpdate before accept/reject proceeds',
  );
  assert(
    markAcceptAllBlock.includes('const initialIds = this.getSortedPendingSuggestionIdsForShareReview();')
      && markAcceptAllBlock.includes('void this.runSerializedShareReviewMutation(async () => {')
      && markAcceptAllBlock.includes('const ready = await this.flushShareReviewMutationState(initialIds);')
      && markAcceptAllBlock.includes('if (!ready) {')
      && markAcceptAllBlock.includes('const snapshot = this.buildShareBatchSuggestionSnapshot();')
      && markAcceptAllBlock.includes('const authoritativeIds = this.getAuthoritativePendingSuggestionIdsForShareReview();')
      && markAcceptAllBlock.includes('const requestedIds = authoritativeIds.length > 0 ? authoritativeIds : initialIds;')
      && markAcceptAllBlock.includes('const result = await shareClient.acceptSuggestions(requestedIds, actor, undefined, snapshot ?? undefined);')
      && markAcceptAllBlock.includes('const success = await this.applyShareMutationDocumentResult(result, {')
      && markAcceptAllBlock.includes('skipReconnectTemplateSeed: true,')
      && markAcceptAllBlock.includes('preserveEditorStateDuringReconnect: true,')
      && markAcceptAllBlock.includes("tombstoneResolvedMarkIds(requestedIds, { reason: 'deleted' });")
      && !markAcceptAllBlock.includes('await this.markAcceptPersisted(suggestionId);')
      && !markAcceptAllBlock.includes('await shareClient.acceptSuggestion(suggestionId, actor);'),
    'Expected share-mode markAcceptAll to resolve stale batch targets against the post-flush authoritative mark set and perform a single final authoritative apply/reconnect without replaying the reconnect template over accepted content',
  );
  const markRejectAllBlock = sliceBetween(editorSource, '  markRejectAll(): number {', '\n  /**\n   * Delete a mark by ID\n   */');
  assert(
    markRejectAllBlock.includes('const initialIds = this.getSortedPendingSuggestionIdsForShareReview();')
      && markRejectAllBlock.includes('void this.runSerializedShareReviewMutation(async () => {')
      && markRejectAllBlock.includes('const ready = await this.flushShareReviewMutationState(initialIds);')
      && markRejectAllBlock.includes('if (!ready) {')
      && markRejectAllBlock.includes('let pendingIds = this.getAuthoritativePendingSuggestionIdsForShareReview();')
      && markRejectAllBlock.includes('if (pendingIds.length === 0) pendingIds = [...initialIds];')
      && markRejectAllBlock.includes('const snapshot = this.buildShareBatchSuggestionSnapshot();')
      && markRejectAllBlock.includes('const result = await shareClient.rejectSuggestion(suggestionId, actor, undefined, snapshot ?? undefined);')
      && markRejectAllBlock.includes('pendingIds = this.getSortedPendingSuggestionIdsFromStoredMarks(serverMarks)')
      && markRejectAllBlock.includes('const success = await this.applyShareMutationDocumentResult(latestSuccessfulResult);')
      && markRejectAllBlock.includes("tombstoneResolvedMarkIds(rejectedIds, { reason: 'deleted' });")
      && !markRejectAllBlock.includes('await this.markRejectPersisted(suggestionId);'),
    'Expected share-mode markRejectAll to batch persisted rejects server-side and perform a single final authoritative apply/reconnect',
  );

  const markAcceptPersistedBlock = sliceBetween(editorSource, '  async markAcceptPersisted(markId: string): Promise<boolean> {', '\n  /**\n   * Reject a suggestion without changing the document\n   */');
  assert(
    markAcceptPersistedBlock.includes('const sourceMark = this.getCurrentShareReviewStoredMark(markId);')
      && markAcceptPersistedBlock.includes('const effectiveMarkId = this.resolveAuthoritativeShareReviewMarkId(markId, sourceMark);')
      && markAcceptPersistedBlock.includes('const result = await shareClient.acceptSuggestion(effectiveMarkId, actor, undefined, snapshot ?? undefined);')
      && markAcceptPersistedBlock.includes("tombstoneResolvedMarkIds(Array.from(new Set([markId, effectiveMarkId])), { reason: 'deleted' });"),
    'Expected persisted single-mark accept to remap stale UI ids onto the latest authoritative mark id before calling the share mutation route',
  );

  const markRejectPersistedBlock = sliceBetween(editorSource, '  async markRejectPersisted(markId: string): Promise<boolean> {', '\n  private getSortedPendingSuggestionIdsForShareReview(): string[] {');
  assert(
    markRejectPersistedBlock.includes('const sourceMark = this.getCurrentShareReviewStoredMark(markId);')
      && markRejectPersistedBlock.includes('const effectiveMarkId = this.resolveAuthoritativeShareReviewMarkId(markId, sourceMark);')
      && markRejectPersistedBlock.includes('const result = await shareClient.rejectSuggestion(effectiveMarkId, actor, undefined, snapshot ?? undefined);')
      && markRejectPersistedBlock.includes("tombstoneResolvedMarkIds(Array.from(new Set([markId, effectiveMarkId])), { reason: 'deleted' });"),
    'Expected persisted single-mark reject to remap stale UI ids onto the latest authoritative mark id before calling the share mutation route',
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

  const scheduleDesiredSuggestionsReapplyBlock = sliceBetween(
    editorSource,
    '  private scheduleDesiredSuggestionsReapply(reason: string): void {',
    '\n  private setSuggestionsEnabled(',
  );
  const setSuggestionsEnabledBlock = sliceBetween(
    editorSource,
    '  private setSuggestionsEnabled(',
    '\n  /**\n   * Toggle suggestion mode\n   */',
  );
  assert(
    editorSource.includes('private desiredSuggestionsEnabled: boolean = false;')
      && editorSource.includes('setSuggestionsDesiredEnabled,')
      && scheduleDesiredSuggestionsReapplyBlock.includes('if (!this.desiredSuggestionsEnabled || !this.editor) return;')
      && scheduleDesiredSuggestionsReapplyBlock.includes('if (this.isShareMode && !this.shareAllowLocalEdits) return;')
      && scheduleDesiredSuggestionsReapplyBlock.includes('if (this.isSuggestionsPluginEnabled()) return;')
      && scheduleDesiredSuggestionsReapplyBlock.includes("const restored = this.setSuggestionsEnabled(true, { updateDesiredState: false });")
      && setSuggestionsEnabledBlock.includes('if (options?.updateDesiredState !== false) {')
      && setSuggestionsEnabledBlock.includes('this.desiredSuggestionsEnabled = enabled;')
      && setSuggestionsEnabledBlock.includes('setSuggestionsDesiredEnabled(this.desiredSuggestionsEnabled);')
      && setSuggestionsEnabledBlock.includes('const pluginEnabled = pluginState?.enabled ?? false;')
      && setSuggestionsEnabledBlock.includes('if (pluginEnabled !== enabled) {')
      && setSuggestionsEnabledBlock.includes('enableSuggestionsPlugin(view);')
      && setSuggestionsEnabledBlock.includes('disableSuggestionsPlugin(view);')
      && setSuggestionsEnabledBlock.includes('currentEnabled = isSuggestionsPluginEnabledState(view.state);')
      && editorSource.includes('private isSuggestionsPluginEnabled(): boolean {')
      && editorSource.includes('enabled = isSuggestionsPluginEnabledState(view.state);')
      && setSuggestionsEnabledBlock.includes("console.log('[setSuggestionsEnabled.result]', currentEnabled ? 'enabled' : 'disabled');"),
    'Expected Track Changes reapply and verification to distinguish the real plugin-enabled state from the desired fallback state across reload/reconnect resets',
  );

  assert(
    editorSource.includes('isSuggestionsEnabled: () => window.proof.isSuggestionsEnabled(),'),
    'Expected __PROOF_EDITOR__ to expose isSuggestionsEnabled so QA can verify the actual suggestions plugin state',
  );

  const updateShareEditGateBlock = sliceBetween(
    editorSource,
    '  private updateShareEditGate(): void {',
    '\n  private ensureShareWebSocketConnection(): void {',
  );
  assert(
    editorSource.includes('resetSuggestionsModuleState();')
      && editorSource.includes('setSuggestionsDesiredEnabled(this.desiredSuggestionsEnabled);')
      && suggestionsSource.includes('export function resetSuggestionsModuleState(): void {')
      && suggestionsSource.includes('suggestionsModuleEnabled = false;')
      && suggestionsSource.includes('let suggestionsDesiredEnabled = false;')
      && suggestionsSource.includes('export function setSuggestionsDesiredEnabled(enabled: boolean): void {')
      && suggestionsSource.includes('return pluginEnabled || suggestionsModuleEnabled || suggestionsDesiredEnabled;')
      && suggestionsSource.includes('export function isSuggestionsPluginEnabled(state: EditorState): boolean {')
      && suggestionsSource.includes('suggestionsDesiredEnabled = true;')
      && suggestionsSource.includes('suggestionsDesiredEnabled = false;')
      && authoredTrackerSource.includes("import { isSuggestionsEnabled } from './suggestions';")
      && authoredTrackerSource.includes('return !isSuggestionsEnabled(state as never);')
      && editorSource.includes("this.scheduleDesiredSuggestionsReapply('load-document');")
      && updateShareEditGateBlock.includes('if (allowLocalEdits && this.desiredSuggestionsEnabled) {')
      && updateShareEditGateBlock.includes("this.scheduleDesiredSuggestionsReapply('share-edit-gate');"),
    'Expected loadDocument to reset the module-level TC flag while preserving the latched desired Track Changes state across plugin-side guards, including authored tracking, until share editing is live again',
  );

  assert(
    editorSource.includes('const pmMetadata = getMarkMetadataWithQuotes(view.state);')
      && editorSource.includes('mergedIncomingMarks = mergePendingServerMarks(')
      && editorSource.includes('{ ...this.lastReceivedServerMarks, ...pmMetadata },')
      && editorSource.includes('incomingMarks,'),
    'Expected collab.onMarks to merge incoming metadata against the quote-aware local snapshot while retaining pre-hydration server marks as fallback',
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
      && editorSource.includes('preservePendingRemoteInsertMetadata,')
      && editorSource.includes('mergeResyncedPendingInsertServerMarks,')
      && resyncPendingInsertMetadataBlock.includes('const preservedMetadata = preservePendingRemoteInsertMetadata(sourceMarks, syncedMetadata, insertIds);')
      && resyncPendingInsertMetadataBlock.includes('setMarkMetadata(view, preservedMetadata);')
      && resyncPendingInsertMetadataBlock.includes('this.lastReceivedServerMarks = mergeResyncedPendingInsertServerMarks(')
      && applyLatestCollabMarksBlock.includes('this.applyExternalMarks(this.lastReceivedServerMarks);')
      && !applyLatestCollabMarksBlock.includes('this.applyExternalMarks(this.lastReceivedServerMarks, { pruneMissingSuggestions: true });')
      && applyLatestCollabMarksBlock.includes('this.resyncPendingInsertMetadataAfterRemoteApply(this.lastReceivedServerMarks);'),
    'Expected live collab mark application to avoid pruning missing pending insert ids when the live doc lags behind remote metadata, while still resyncing the insert ids that are visible in the document',
  );

  const handleTextInputBlock = sliceBetween(
    suggestionsSource,
    '      handleTextInput(view, from, to, text) {',
    '\n\n      handleKeyDown(view, event) {',
  );
  assert(
    suggestionsSource.includes('export function enableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {')
      && suggestionsSource.includes('export function disableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {')
      && suggestionsSource.includes('resetSuggestionsInsertCoalescing();')
      && suggestionsSource.includes("const HANDLED_TEXT_INPUT_META = 'proof-handled-text-input';")
      && suggestionsSource.includes("const NATIVE_TEXT_INPUT_MATCH_META = 'proof-native-typed-input-match';")
      && suggestionsSource.includes('export function buildTextPreservingInsertPersistenceTransaction(')
      && handleTextInputBlock.includes('handleTextInput(view, from, to, text) {')
      && handleTextInputBlock.includes('return false;')
      && !handleTextInputBlock.includes('view.dispatch(')
      && !handleTextInputBlock.includes('rememberHandledTextInputDispatch(')
      && !handleTextInputBlock.includes("deflt().setMeta(HANDLED_TEXT_INPUT_META")
      && !suggestionsSource.includes("console.log('[suggestions.beforeinput.preventNativeInsertText]', {")
      && !suggestionsSource.includes('rememberPendingBeforeinputNativeInsertBlock(text, insertFrom, insertTo);'),
    'Expected toggling track changes on or off to clear stale insert coalescing state, define handled text-input suppression keys, and let ordinary typing flow through ProseMirror native transactions instead of dispatching tracked inserts directly from handleTextInput',
  );
  const suggestionsAppendTransactionBlock = sliceBetween(
    suggestionsSource,
    '    appendTransaction(trs, oldState, newState) {',
    '\n\n    props: {',
  );
  assert(
    suggestionsAppendTransactionBlock.includes('const hasBlockingMarksMeta = trs.some((tr) => {')
      && suggestionsAppendTransactionBlock.includes("const hasWrappedSuggestionTransaction = trs.some((tr) => tr.getMeta('suggestions-wrapped'));")
      && suggestionsAppendTransactionBlock.includes("const hasNativeTypedInputPassthrough = trs.some((tr) => tr.getMeta('proof-native-typed-input') === true);")
      && suggestionsAppendTransactionBlock.includes('const nativeTypedInputMatch = trs')
      && suggestionsAppendTransactionBlock.includes("if (metaType === 'INTERNAL') return false;")
      && suggestionsAppendTransactionBlock.includes("if (metaType === 'SET_METADATA' && tr.getMeta('suggestions-wrapped')) return false;")
      && suggestionsAppendTransactionBlock.includes('const effectivelyDisabled = !isEnabled && !suggestionsModuleEnabled && !suggestionsDesiredEnabled;')
      && suggestionsAppendTransactionBlock.includes("const hasHistoryChange = trs.some((tr) => tr.getMeta('history$') !== undefined);")
      && suggestionsAppendTransactionBlock.includes("console.log('[suggestions.appendTransaction.historyRestoreEnable]', {")
      && suggestionsAppendTransactionBlock.includes('suggestionsModuleEnabled = true;')
      && suggestionsAppendTransactionBlock.includes(".setMeta(suggestionsPluginKey, { enabled: true })")
      && suggestionsAppendTransactionBlock.includes(".setMeta('addToHistory', false);")
      && suggestionsAppendTransactionBlock.includes('const hasRemoteSuggestionInsert = trs.some((tr) =>')
      && suggestionsAppendTransactionBlock.includes('transactionCarriesInsertedSuggestionMarks(tr)')
      && suggestionsAppendTransactionBlock.includes('const nativeWrapTr = buildNativeTextInputFollowupWrapTransaction(')
      && suggestionsAppendTransactionBlock.includes("console.log('[suggestions.appendTransactionNativeTextInputWrap]', {")
      && suggestionsAppendTransactionBlock.includes('const splitMergeTr = buildAdjacentSplitInsertMergeTransaction(oldState, newState);')
      && suggestionsAppendTransactionBlock.includes('if (hasWrappedSuggestionTransaction || hasRemoteSuggestionInsert) {')
      && suggestionsAppendTransactionBlock.includes('if (hasNativeTypedInputPassthrough) {')
      && suggestionsAppendTransactionBlock.includes('|| isExplicitYjsChangeOriginTransaction(tr)')
      && !suggestionsAppendTransactionBlock.includes("|| tr.getMeta(marksPluginKey) !== undefined"),
    'Expected suggestions appendTransaction to ignore authored-tracker INTERNAL mark transactions, convert matched native typed-input passthroughs into immediate mark-only wrap transactions, still allow split-insert healing after wrapped local typing, and skip explicit Yjs change-origin echoes plus raw y-sync transactions that already carry incoming suggestion marks',
  );

  const setupSuggestionsInterceptorBlock = sliceBetween(editorSource, '  private setupSuggestionsInterceptor(): void {', '\n  private getDomSelectionRange(');
  assert(
    editorSource.includes('consumePendingNativeTextInputTransactionMatch,')
      && editorSource.includes('buildTextPreservingInsertPersistenceTransaction,')
      && setupSuggestionsInterceptorBlock.includes('const nativeTextInputMatch = consumePendingNativeTextInputTransactionMatch(beforeState, tr);')
      && setupSuggestionsInterceptorBlock.includes('if (nativeTextInputMatch) {')
      && setupSuggestionsInterceptorBlock.includes("console.log('[tc.dispatch.passthroughNativeTextInput]', {")
      && setupSuggestionsInterceptorBlock.includes("tr.setMeta('proof-native-typed-input', true);")
      && setupSuggestionsInterceptorBlock.includes("tr.setMeta('proof-native-typed-input-match', nativeTextInputMatch);")
      && setupSuggestionsInterceptorBlock.includes("console.log('[tc.dispatch.nativeTextInputResult]', {")
      && setupSuggestionsInterceptorBlock.includes('const finalHasSuggestionMark = finalNodes.some((node) =>')
      && setupSuggestionsInterceptorBlock.includes('const settledRepairTr = buildNativeTextInputFollowupWrapTransaction(')
      && setupSuggestionsInterceptorBlock.includes("console.log('[tc.dispatch.nativeTextInputSettledRepair]', {")
      && !setupSuggestionsInterceptorBlock.includes('queueMicrotask(() => {'),
    'Expected the suggestions interceptor to annotate the matched native typed-insert transaction directly, inspect the settled post-dispatch state, and immediately rewrap the exact native insert range if the full dispatch cycle strips the live suggestion mark',
  );
  const preserveInsertCoalescingBlock = sliceBetween(
    editorSource,
    '  private shouldPreserveSuggestionsInsertCoalescingAfterRemoteContentChange(',
    '\n  /**\n   * Set up the suggestions interceptor to convert edits to tracked changes',
  );
  const repairRemoteSuggestionBoundaryInheritanceBlock = sliceBetween(
    editorSource,
    '  private repairRemoteSuggestionBoundaryInheritance(',
    '\n  private shouldPreserveSuggestionsInsertCoalescingAfterRemoteContentChange(',
  );
  assert(
    setupSuggestionsInterceptorBlock.includes('const isSystemTrackChangesSuppressed = Boolean(tr?.docChanged) && (')
      && setupSuggestionsInterceptorBlock.includes('this.suppressTrackChangesSystemTransactionsDepth > 0')
      && setupSuggestionsInterceptorBlock.includes('this.suppressTrackChangesDuringCollabReconnect')
      && setupSuggestionsInterceptorBlock.includes('const marksMeta = tr?.getMeta?.(marksPluginKey);')
      && setupSuggestionsInterceptorBlock.includes('const marksMetaType = (marksMeta && typeof marksMeta === \'object\' && !Array.isArray(marksMeta))')
      && setupSuggestionsInterceptorBlock.includes('const hasReplaceStep = Boolean(tr?.steps?.some((step: any) => {')
      && setupSuggestionsInterceptorBlock.includes('const carriesIncomingSuggestionMarks = Boolean(tr?.docChanged) && transactionCarriesInsertedSuggestionMarks(tr);')
      && setupSuggestionsInterceptorBlock.includes('const shouldTreatYjsPlainTextEchoAsRemote = Boolean(tr?.docChanged)')
      && setupSuggestionsInterceptorBlock.includes('&& yjsOrigin.isYjsOrigin')
      && setupSuggestionsInterceptorBlock.includes('&& !isExplicitYjsChangeOriginTransaction(tr)')
      && setupSuggestionsInterceptorBlock.includes('&& !carriesIncomingSuggestionMarks')
      && setupSuggestionsInterceptorBlock.includes('&& this.shouldPreserveSuggestionsInsertCoalescingAfterRemoteContentChange(')
      && setupSuggestionsInterceptorBlock.includes("const isRemoteContentChange = Boolean(tr?.docChanged) && (")
      && setupSuggestionsInterceptorBlock.includes('|| (yjsOrigin.isYjsOrigin && carriesIncomingSuggestionMarks)')
      && setupSuggestionsInterceptorBlock.includes('|| shouldTreatYjsPlainTextEchoAsRemote')
      && setupSuggestionsInterceptorBlock.includes('const suggestionsEnabled = this.desiredSuggestionsEnabled')
      && setupSuggestionsInterceptorBlock.includes('|| isSuggestionsEnabledPlugin(view.state);')
      && !setupSuggestionsInterceptorBlock.includes('const suggestionsEnabled = pluginEnabled && isSuggestionsModuleEnabled();')
      && setupSuggestionsInterceptorBlock.includes('const isMarksOnlyChange = marksMeta !== undefined && !hasReplaceStep;')
      && setupSuggestionsInterceptorBlock.includes('if (isRemoteContentChange) {')
      && setupSuggestionsInterceptorBlock.includes('const preserveInsertCoalescing = shouldTreatYjsPlainTextEchoAsRemote')
      && setupSuggestionsInterceptorBlock.includes('|| this.shouldPreserveSuggestionsInsertCoalescingAfterRemoteContentChange(')
      && setupSuggestionsInterceptorBlock.includes('if (!preserveInsertCoalescing) {')
      && setupSuggestionsInterceptorBlock.includes('resetSuggestionsInsertCoalescing();')
      && setupSuggestionsInterceptorBlock.includes("if (marksMeta !== undefined && (marksMetaType !== 'INTERNAL' || !hasReplaceStep)) {")
      && setupSuggestionsInterceptorBlock.includes('const originalUpdateState = view.updateState.bind(view);')
      && setupSuggestionsInterceptorBlock.includes("(view as any).updateState = (nextState: any) => {")
      && setupSuggestionsInterceptorBlock.includes("console.log('[tc.view.dispatch.apply]', {")
      && setupSuggestionsInterceptorBlock.includes("console.log('[tc.view.updateState]', {")
      && setupSuggestionsInterceptorBlock.includes('dispatchWithoutRevision(tr, \'remoteContentPassthrough\');')
      && setupSuggestionsInterceptorBlock.includes('this.repairRemoteSuggestionBoundaryInheritance(')
      && setupSuggestionsInterceptorBlock.includes("(transaction) => dispatchWithRevision(transaction, 'repairRemoteSuggestionBoundaryInheritance')")
      && setupSuggestionsInterceptorBlock.includes("const isHistoryChange = tr?.getMeta?.('history$') !== undefined;")
      && !setupSuggestionsInterceptorBlock.includes("const isHistoryChange = tr?.getMeta?.('history$') !== undefined || tr?.getMeta?.('addToHistory') === false;")
      && setupSuggestionsInterceptorBlock.includes('if (isSystemTrackChangesSuppressed) {')
      && setupSuggestionsInterceptorBlock.includes("dispatchWithRevision(tr, 'systemTrackChangesSuppressedPassthrough');")
      && setupSuggestionsInterceptorBlock.includes('if (Boolean(tr?.docChanged) && shouldSuppressHandledTextInputEcho(beforeState, tr)) {')
      && setupSuggestionsInterceptorBlock.includes("console.log('[tc.dispatch.suppressHandledTextInputEcho]', {"),
    'Expected the suggestions interceptor to pass through collab/template system transactions, treat recent raw Yjs plain-text self-echoes as remote for repair, honor the latched desired Track Changes state through share/collab resets, suppress immediate handled-input duplicate echoes, and now instrument the live dispatch/updateState runtime around the native typed-input lane',
  );
  assert(
    repairRemoteSuggestionBoundaryInheritanceBlock.includes('const textPreservingRepair = buildTextPreservingInsertPersistenceTransaction(beforeState, view.state);')
      && repairRemoteSuggestionBoundaryInheritanceBlock.includes('if (textPreservingRepair) {')
      && repairRemoteSuggestionBoundaryInheritanceBlock.includes("console.log('[tc.remoteInsertPersistenceRepair]', {")
      && repairRemoteSuggestionBoundaryInheritanceBlock.includes('dispatchBase(textPreservingRepair);')
      && repairRemoteSuggestionBoundaryInheritanceBlock.includes('const currentMetadata = getMarkMetadata(view.state);')
      && repairRemoteSuggestionBoundaryInheritanceBlock.includes('const repair = buildRemoteInsertSuggestionBoundaryRepair(beforeState, view.state, currentMetadata, {'),
    'Expected remote Yjs/content echoes that preserve text but strip local insert marks to run the existing text-preserving insert repair before boundary inheritance fallback',
  );
  assert(
    suggestionsSource.includes('function sliceRepresentsWrappedPlainText(nodes?: SliceNode[]): boolean {')
      && suggestionsSource.includes("if (hasNonText && !sliceRepresentsWrappedPlainText(stepJson.slice.content)) {"),
    'Expected wrapped plain-text paste slices to stay on the tracked insertion path instead of being misclassified as structural passthroughs',
  );
  assert(
    preserveInsertCoalescingBlock.includes('if (!this.collabEnabled) return false;')
      && preserveInsertCoalescingBlock.includes('if (!view.hasFocus()) return false;')
      && preserveInsertCoalescingBlock.includes('if (!beforeState.selection.empty) return false;')
      && preserveInsertCoalescingBlock.includes('if (hasRecentSuggestionsInsertCoalescingState()) return true;')
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
      && shareClientSource.includes('snapshot?: ShareMarkMutationSnapshot;')
      && shareClientSource.includes('markdown: args.snapshot.markdown,')
      && shareClientSource.includes('marks: args.snapshot.marks,')
      && shareClientSource.includes("/agent/${encodeURIComponent(this.slug as string)}/marks/${args.path}"),
    'Expected ShareClient to expose dedicated single-mark and batch accept mutations, including caller-provided mark snapshots for single-mark persistence',
  );

  const acceptRouteBlock = sliceBetween(
    agentRoutesSource,
    "agentRoutes.post('/:slug/marks/accept', async (req: Request, res: Response) => {",
    "\nagentRoutes.post('/:slug/marks/reject',",
  );
  assert(
    acceptRouteBlock.includes('acquireRewriteLock(slug);')
      && acceptRouteBlock.includes('const effectivePayload = rewriteMarkMutationPayloadSnapshotTargets(payload, parseCanonicalMarks(mutationContext.doc.marks));')
      && acceptRouteBlock.includes('const effectiveMutationContext = overlayMarkMutationPayloadSnapshot(mutationContext, effectivePayload);')
      && acceptRouteBlock.includes("executeDocumentOperationAsync(slug, 'POST', '/marks/accept', effectivePayload, effectiveMutationContext)")
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
    'Expected /marks/accept to remap stale single-mark targets onto the current snapshot, return canonical success immediately with pending collab status, then verify/invalidate in the background instead of blocking on post-commit drift checks',
  );

  const rejectRouteBlock = sliceBetween(
    agentRoutesSource,
    "agentRoutes.post('/:slug/marks/reject', async (req: Request, res: Response) => {",
    "\nagentRoutes.post('/:slug/marks/reply',",
  );
  assert(
    rejectRouteBlock.includes('acquireRewriteLock(slug);')
      && rejectRouteBlock.includes('const effectivePayload = rewriteMarkMutationPayloadSnapshotTargets(payload, parseCanonicalMarks(mutationContext.doc.marks));')
      && rejectRouteBlock.includes('const effectiveMutationContext = overlayMarkMutationPayloadSnapshot(mutationContext, effectivePayload);')
      && rejectRouteBlock.includes("executeDocumentOperationAsync(slug, 'POST', '/marks/reject', effectivePayload, effectiveMutationContext)")
      && rejectRouteBlock.includes('if (!keepRewriteLockCooldown) {')
      && rejectRouteBlock.includes('releaseRewriteLockImmediately(slug);')
      && rejectRouteBlock.includes("details: 'suggestion.reject'"),
    'Expected /marks/reject to remap stale single-mark targets onto the current snapshot before overlaying it, and to hold the rewrite lock long enough to block stale collab writes during share review rejection',
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
