import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const source = readFileSync(path.resolve(process.cwd(), 'server/collab.ts'), 'utf8');

  const applyStart = source.indexOf('async function applyCanonicalDocumentToCollabInner(');
  assert(applyStart >= 0, 'Expected applyCanonicalDocumentToCollabInner');
  const applyEnd = source.indexOf('export async function applyCanonicalDocumentToCollab(', applyStart);
  assert(applyEnd > applyStart, 'Expected applyCanonicalDocumentToCollab export after inner helper');

  const applyBody = source.slice(applyStart, applyEnd);
  const rememberIndex = applyBody.indexOf('rememberLoadedDoc(slug, ydoc);');
  const metaIndex = applyBody.indexOf('refreshLoadedDocDbMeta(');
  const skipIndex = applyBody.indexOf('await markSkipNextOnStorePersistFromAuthoritativeState(slug, ydoc, {');

  assert(rememberIndex >= 0, 'Expected external apply path to remember loaded doc');
  assert(metaIndex >= 0, 'Expected external apply path to refresh loaded DB metadata');
  assert(skipIndex >= 0, 'Expected external apply path to mark skip-next onStore persist');
  assert(
    rememberIndex < metaIndex && metaIndex < skipIndex,
    'Expected external apply path to refresh loaded DB metadata before skip-next onStore guard',
  );

  assert(
    applyBody.includes('getDocumentBySlug(slug)'),
    'Expected external apply path to read current canonical row before reseeding loaded metadata',
  );

  const syncStart = source.indexOf('async function syncCanonicalDocumentStateToCollabInner(');
  assert(syncStart >= 0, 'Expected syncCanonicalDocumentStateToCollabInner');
  const syncEnd = source.indexOf('export async function syncCanonicalDocumentStateToCollab(', syncStart);
  assert(syncEnd > syncStart, 'Expected syncCanonicalDocumentStateToCollab export after inner helper');

  const syncBody = source.slice(syncStart, syncEnd);
  const syncRememberIndex = syncBody.indexOf('rememberLoadedDoc(slug, ydoc);');
  const syncMetaIndex = syncBody.indexOf('refreshLoadedDocDbMeta(');
  const syncSkipIndex = syncBody.indexOf('await markSkipNextOnStorePersistFromAuthoritativeState(slug, ydoc, {');
  const syncContentBranchStart = syncBody.indexOf('if (parsedDoc && sanitizedMarkdown !== null) {');
  const syncContentBranchEnd = syncBody.indexOf('} else if (sanitizedMarkdown !== null) {');
  const syncPreviewIndex = syncBody.indexOf('const previewDoc = cloneAuthoritativeDocState(ydoc);');

  assert(syncRememberIndex >= 0, 'Expected canonical sync path to remember loaded doc');
  assert(syncMetaIndex >= 0, 'Expected canonical sync path to refresh loaded DB metadata');
  assert(syncSkipIndex >= 0, 'Expected canonical sync path to mark skip-next onStore persist');
  assert(syncContentBranchStart >= 0 && syncContentBranchEnd > syncContentBranchStart, 'Expected canonical sync content-write branch');
  assert(syncPreviewIndex >= 0, 'Expected canonical sync content-write path to preflight fragment authority on a preview doc');
  assert(
    syncRememberIndex < syncMetaIndex && syncMetaIndex < syncSkipIndex,
    'Expected canonical sync path to refresh loaded DB metadata before skip-next onStore guard',
  );
  const syncContentBranch = syncBody.slice(syncContentBranchStart, syncContentBranchEnd);

  assert(
    !syncContentBranch.includes("applyYTextDiff(ydoc.getText('markdown'), fragmentAuthorityMarkdown);")
      && syncContentBranch.includes("ensureFragmentEditTracking(ydoc).dirty = true;"),
    'Expected canonical sync content-write branch to replace the fragment, mark it dirty, and let persistDoc refresh the markdown cache',
  );
  assert(
    syncBody.includes('const previewDoc = cloneAuthoritativeDocState(ydoc);')
      && syncBody.includes('const previewResolved = await resolveLoadedDocFragmentMarkdown(slug, previewDoc, {')
      && syncBody.includes('const suspiciousCollapse = evaluateNonDirtyFragmentRefreshCollapse('),
    'Expected canonical sync path to preflight fragment-derived markdown and suspicious collapse on a preview doc before mutating the live doc',
  );

  const syncFallbackMatches = syncBody.match(/reconcileCanonicalDocumentToYjs\(slug, 'canonical-reconcile', \{ forcePersistOnly: true \}\)/g) ?? [];
  assert(
    syncFallbackMatches.length >= 2,
    'Expected canonical sync path to preserve explicit DB-only fallback branches when no live room can safely absorb the update',
  );

  const skipFingerprintHelperStart = source.indexOf('async function markSkipNextOnStorePersistFromAuthoritativeState(');
  assert(skipFingerprintHelperStart >= 0, 'Expected authoritative skip-next onStore fingerprint helper');
  const skipFingerprintHelperEnd = source.indexOf('function shouldSkipOnStorePersistAfterExternalApply(', skipFingerprintHelperStart);
  assert(skipFingerprintHelperEnd > skipFingerprintHelperStart, 'Expected end of authoritative skip-next helper');
  const skipFingerprintHelperBody = source.slice(skipFingerprintHelperStart, skipFingerprintHelperEnd);
  assert(
    skipFingerprintHelperBody.includes('const fingerprintDoc = cloneAuthoritativeDocState(ydoc);')
      && skipFingerprintHelperBody.includes('resolveLoadedDocFragmentMarkdown(slug, fingerprintDoc, {')
      && skipFingerprintHelperBody.includes('syncAuthoritativeMarkdownCache('),
    'Expected skip-next onStore helper to fingerprint the fragment-derived authoritative state before explicit server persists',
  );

  console.log('✓ collab external apply baseline refresh wiring checks');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
