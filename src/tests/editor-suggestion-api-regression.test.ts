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
  assert(
    markAcceptAllBlock.includes('acceptedIds = getPendingSuggestions(getMarks(view.state)).map((mark) => mark.id);')
      && markAcceptAllBlock.includes('const result = await shareClient.acceptSuggestion(suggestionId, actor);'),
    'Expected markAcceptAll to persist each accepted suggestion through share mutations',
  );

  const handleMarksChangeBlock = sliceBetween(editorSource, '  private handleMarksChange(', '\n  private serializeMarkdown(');
  assert(
    editorSource.includes('private scheduleShareMarksFlush(): void')
      && handleMarksChangeBlock.includes('if (this.isShareMode) {')
      && handleMarksChangeBlock.includes('this.scheduleShareMarksFlush();')
      && handleMarksChangeBlock.includes('Let content flow through the existing collab binding')
      && handleMarksChangeBlock.includes('} else if (this.collabEnabled && this.collabCanEdit) {')
      && handleMarksChangeBlock.includes('collabClient.setMarksMetadata(metadata);')
      && !handleMarksChangeBlock.includes('this.flushShareMarks();'),
    'Expected share-mode mark updates to defer the share flush until after the dispatch cycle instead of pushing marks immediately during tracked typing',
  );

  assert(
    shareClientSource.includes('async acceptSuggestion(')
      && shareClientSource.includes("path: 'accept' | 'reject';")
      && shareClientSource.includes("/agent/${encodeURIComponent(this.slug as string)}/marks/${args.path}"),
    'Expected ShareClient to expose a dedicated acceptSuggestion mutation',
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
      && acceptRouteBlock.includes('const collabStatus = await notifyCollabMutation(')
      && acceptRouteBlock.includes('verify: true')
      && acceptRouteBlock.includes("source: 'marks.accept'")
      && acceptRouteBlock.includes('fallbackBarrier: true')
      && acceptRouteBlock.includes('responseStatus = 202;')
      && acceptRouteBlock.includes('await invalidateLoadedCollabDocumentAndWait(slug);')
      && !acceptRouteBlock.includes("code: 'COLLAB_SYNC_FAILED'"),
    'Expected /marks/accept to hold the rewrite lock through share review persistence and return canonical success with pending collab status instead of hard-failing post-commit drift',
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
