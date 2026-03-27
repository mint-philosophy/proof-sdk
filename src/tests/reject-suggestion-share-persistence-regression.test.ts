import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const editorSource = readFileSync(path.resolve(process.cwd(), 'src/editor/index.ts'), 'utf8');
  const engineSource = readFileSync(path.resolve(process.cwd(), 'server/document-engine.ts'), 'utf8');

  const markRejectStart = editorSource.indexOf('markReject(markId: string): boolean {');
  assert(markRejectStart !== -1, 'Expected editor markReject implementation');

  const markRejectEnd = editorSource.indexOf('\n  /**\n   * Accept all pending suggestions', markRejectStart);
  assert(markRejectEnd !== -1, 'Expected to isolate markReject body');

  const markRejectBlock = editorSource.slice(markRejectStart, markRejectEnd);
  const markRejectShareStart = markRejectBlock.indexOf('if (this.isShareMode) {');
  const markRejectShareEnd = markRejectBlock.indexOf('\n    let success = false;');
  assert(markRejectShareStart !== -1 && markRejectShareEnd !== -1, 'Expected to isolate markReject share-mode branch');
  const markRejectShareBlock = markRejectBlock.slice(markRejectShareStart, markRejectShareEnd);

  assert(markRejectBlock.includes('if (this.isShareMode) {'), 'Regression guard: rejecting a suggestion in share mode must avoid local collab-only mutations');
  assert(
    markRejectShareBlock.includes('let rejected = false;')
      && markRejectShareBlock.includes('rejected = rejectMark(view, markId);')
      && markRejectShareBlock.includes('const metadata = getMarkMetadataWithQuotes(view.state);')
      && markRejectShareBlock.includes('this.lastReceivedServerMarks = { ...metadata };')
      && markRejectShareBlock.includes("console.warn('[markReject] Suggestion not pending in share mode:'")
      && markRejectShareBlock.includes('const actor = getCurrentActor();')
      && markRejectShareBlock.includes('void shareClient.rejectSuggestion(markId, actor).then(async (result) => {')
      && markRejectShareBlock.includes('this.applyAuthoritativeShareMarks(serverMarks);'),
    'Expected markReject share mode to optimistically tombstone the local suggestion, snapshot local marks, and then refresh from the authoritative reject mutation response',
  );
  assert(
    !markRejectShareBlock.includes('shareClient.pushUpdate(')
      && !markRejectShareBlock.includes('shareClient.pushMarks('),
    'Expected markReject share mode not to fall back to broad content or marks writes for suggestion rejection',
  );
  assert(
    markRejectBlock.includes("console.error('[markReject] Failed to persist suggestion rejection via share mutation:', error);"),
    'Expected markReject to log share mutation persistence failures for reject actions',
  );
  assert(!markRejectBlock.includes('shareClient.pushUpdate('), 'markReject must not require a content write to persist suggestion rejection');
  assert(!markRejectBlock.includes('shareClient.pushMarks('), 'markReject should not depend on a broad marks PUT when a dedicated reject mutation exists');
  assert(
    engineSource.includes("if (status === 'rejected') {")
      && engineSource.includes('bumpDocumentAccessEpoch(slug);')
      && engineSource.includes('invalidateCollabDocument(slug);')
      && engineSource.includes('return persistMarksAsync(')
      && engineSource.includes("code: 'COLLAB_SYNC_REQUIRED'")
      && engineSource.includes("code: 'COLLAB_SYNC_FAILED'"),
    'Expected server-side suggestion status persistence to stale out collab sessions for rejects and route non-rejected finalizations through the collab-aware persistence path',
  );

  const markRejectAllStart = editorSource.indexOf('markRejectAll(): number {');
  assert(markRejectAllStart !== -1, 'Expected editor markRejectAll implementation');

  const markRejectAllEnd = editorSource.indexOf('\n  /**\n   * Delete a mark by ID', markRejectAllStart);
  assert(markRejectAllEnd !== -1, 'Expected to isolate markRejectAll body');

  const markRejectAllBlock = editorSource.slice(markRejectAllStart, markRejectAllEnd);
  const markRejectAllShareStart = markRejectAllBlock.indexOf('if (this.isShareMode) {');
  const markRejectAllShareEnd = markRejectAllBlock.indexOf('\n    let count = 0;');
  assert(markRejectAllShareStart !== -1 && markRejectAllShareEnd !== -1, 'Expected to isolate markRejectAll share-mode branch');
  const markRejectAllShareBlock = markRejectAllBlock.slice(markRejectAllShareStart, markRejectAllShareEnd);
  assert(markRejectAllBlock.includes('if (this.isShareMode) {'), 'Expected markRejectAll share mode branch');
  assert(
    markRejectAllShareBlock.includes('rejectedIds = getPendingSuggestions(getMarks(view.state)).map((mark) => mark.id);')
      && markRejectAllShareBlock.includes('rejectedCount = rejectAll(view);')
      && markRejectAllShareBlock.includes('const metadata = getMarkMetadataWithQuotes(view.state);')
      && markRejectAllShareBlock.includes('this.lastReceivedServerMarks = { ...metadata };')
      && markRejectAllShareBlock.includes('const actor = getCurrentActor();')
      && markRejectAllShareBlock.includes('const result = await shareClient.rejectSuggestion(suggestionId, actor);')
      && markRejectAllShareBlock.includes('this.applyAuthoritativeShareMarks(latestServerMarks);'),
    'Expected markRejectAll share mode to optimistically reject local suggestions, snapshot local marks, and then apply authoritative server marks',
  );
  assert(
    !markRejectAllShareBlock.includes('shareClient.pushUpdate(')
      && !markRejectAllShareBlock.includes('shareClient.pushMarks('),
    'Expected markRejectAll share mode not to depend on broad content or marks writes for suggestion rejection',
  );

  console.log('✓ rejecting a suggestion persists share marks without content writes');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
