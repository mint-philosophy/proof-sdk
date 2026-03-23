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
      && applyResultBlock.includes("this.pendingCollabReconnectTemplateOverride = this.normalizeMarkdownForCollab(markdown);")
      && applyResultBlock.includes("this.collabConnectionStatus = 'connecting';")
      && applyResultBlock.includes('this.collabIsSynced = false;'),
    'Expected share review mutation results with pending collab status to clear tracked-insert coalescing, seed the next reconnect from canonical server markdown, and mark collab as unstable before the reconnect finishes',
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
      && !acceptPersistedBlock.includes('acceptMark(view, markId, parser);'),
    'Expected markAcceptPersisted to tombstone the resolved suggestion, then try the in-place local reconcile path before falling back to canonical reload',
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
      && !rejectPersistedBlock.includes('rejectMark(view, markId);'),
    'Expected markRejectPersisted to tombstone the resolved suggestion, then try the in-place local reconcile path before falling back to canonical reload',
  );

  const localResolveBlock = sliceBetween(
    editorSource,
    '  private tryResolveShareReviewMutationLocally(',
    '\n  private async runSerializedShareReviewMutation<T>(run: () => Promise<T>): Promise<T> {',
  );
  assert(
    localResolveBlock.includes("if (markdown === null || collabStatus !== 'pending') return false;")
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
