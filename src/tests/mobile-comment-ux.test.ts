import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  getCommentUiMode,
  shouldUseCommentUiV2,
  COMMENT_UI_MODE_STORAGE_KEY,
} from '../editor/plugins/comment-ui-mode.js';
import {
  getViewportOffset,
  getVisualViewportHeight,
} from '../editor/plugins/mark-popover-viewport.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(error as Error).message}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function withMockWindow<T>(windowLike: any, fn: () => T): T {
  const g = globalThis as { window?: any };
  const prevWindow = g.window;
  g.window = windowLike;
  try {
    return fn();
  } finally {
    if (prevWindow === undefined) {
      delete g.window;
    } else {
      g.window = prevWindow;
    }
  }
}

console.log('\n=== Mobile Comment UX Guards ===');

test('query param commentUi overrides storage', () => {
  withMockWindow({
    location: { search: '?commentUi=v2' },
    localStorage: { getItem: (_key: string) => 'legacy' },
    innerWidth: 1200,
    matchMedia: (_query: string) => ({ matches: false }),
  }, () => {
    assert(getCommentUiMode() === 'v2', 'Expected query mode to win');
    assert(shouldUseCommentUiV2() === true, 'Expected forced v2 mode to enable V2 UI');
  });
});

test('storage commentUi is used when query is absent', () => {
  withMockWindow({
    location: { search: '' },
    localStorage: { getItem: (key: string) => (key === COMMENT_UI_MODE_STORAGE_KEY ? 'legacy' : null) },
    innerWidth: 390,
    matchMedia: (_query: string) => ({ matches: true }),
  }, () => {
    assert(getCommentUiMode() === 'legacy', 'Expected storage mode to be used');
    assert(shouldUseCommentUiV2() === false, 'Legacy mode must disable V2 UI');
  });
});

test('runtime config commentUiDefaultMode is used when query/storage are absent', () => {
  withMockWindow({
    location: { search: '' },
    localStorage: { getItem: (_key: string) => null },
    __PROOF_CONFIG__: { commentUiDefaultMode: 'legacy' },
    innerWidth: 1200,
    matchMedia: (_query: string) => ({ matches: false }),
  }, () => {
    assert(getCommentUiMode() === 'legacy', 'Expected runtime config mode to be used');
    assert(shouldUseCommentUiV2() === false, 'Legacy runtime config should disable V2 UI');
  });
});

test('storage commentUi overrides runtime config', () => {
  withMockWindow({
    location: { search: '' },
    localStorage: { getItem: (key: string) => (key === COMMENT_UI_MODE_STORAGE_KEY ? 'v2' : null) },
    __PROOF_CONFIG__: { commentUiDefaultMode: 'legacy' },
    innerWidth: 390,
    matchMedia: (_query: string) => ({ matches: true }),
  }, () => {
    assert(getCommentUiMode() === 'v2', 'Expected storage mode to override runtime config');
    assert(shouldUseCommentUiV2() === true, 'Storage override should still enable V2 UI');
  });
});

test('defaults to v2 mode when no query/storage/runtime override is provided', () => {
  withMockWindow({
    location: { search: '' },
    localStorage: { getItem: (_key: string) => null },
    innerWidth: 1200,
    matchMedia: (_query: string) => ({ matches: false }),
  }, () => {
    assert(getCommentUiMode() === 'v2', 'Expected v2 mode by default');
    assert(shouldUseCommentUiV2() === true, 'Default mode should enable V2 UI');
  });
});

test('explicit auto mode still enables V2 on <=900px fallback width', () => {
  withMockWindow({
    location: { search: '?commentUi=auto' },
    localStorage: { getItem: (_key: string) => null },
    innerWidth: 900,
    matchMedia: (_query: string) => ({ matches: false }),
  }, () => {
    assert(getCommentUiMode() === 'auto', 'Expected explicit auto query mode');
    assert(shouldUseCommentUiV2() === true, '900px width should enable V2 mode fallback');
  });
});

test('mobile strip uses defensive bounding-rect guards', () => {
  const source = readFileSync(
    path.resolve(process.cwd(), 'src', 'editor', 'plugins', 'mark-popover.ts'),
    'utf8',
  );
  assert(
    source.includes('typeof this.strip.getBoundingClientRect !== \'function\''),
    'Expected defensive bounding rect guards for the mobile comment strip',
  );
});

test('viewport offset helpers account for visual viewport height + offset', () => {
  const layoutHeight = 812;
  const vv = { height: 520, offsetTop: 0 };
  assert(getViewportOffset(layoutHeight, vv) === 292, 'Expected keyboard offset when visual viewport shrinks');
  assert(getVisualViewportHeight(layoutHeight, vv) === 520, 'Expected visual viewport height when available');
  assert(getViewportOffset(layoutHeight, { height: 620, offsetTop: 24 }) === 168, 'Expected offset to include visual viewport top offset');
  assert(getViewportOffset(layoutHeight, null) === 0, 'Expected zero offset when visual viewport is unavailable');
  assert(getVisualViewportHeight(layoutHeight, null) === layoutHeight, 'Expected layout height fallback without visual viewport');
});

test('source includes selection caching + pointer/touch handlers + arrow trigger plugin', () => {
  const selectionBarPath = path.resolve(process.cwd(), 'src', 'editor', 'plugins', 'mark-selection-bar.ts');
  const popoverPath = path.resolve(process.cwd(), 'src', 'editor', 'plugins', 'mark-popover.ts');
  const arrowPath = path.resolve(process.cwd(), 'src', 'editor', 'plugins', 'arrow-comment.ts');
  const viewportPath = path.resolve(process.cwd(), 'src', 'editor', 'plugins', 'mark-popover-viewport.ts');
  const indexPath = path.resolve(process.cwd(), 'src', 'editor', 'index.ts');
  const indexHtmlPath = path.resolve(process.cwd(), 'src', 'index.html');
  const namePromptPath = path.resolve(process.cwd(), 'src', 'ui', 'name-prompt.ts');

  const selectionBar = readFileSync(selectionBarPath, 'utf8');
  const popover = readFileSync(popoverPath, 'utf8');
  const arrow = readFileSync(arrowPath, 'utf8');
  const commentUiMode = readFileSync(path.resolve(process.cwd(), 'src', 'editor', 'plugins', 'comment-ui-mode.ts'), 'utf8');
  const viewport = readFileSync(viewportPath, 'utf8');
  const indexSource = readFileSync(indexPath, 'utf8');
  const indexHtml = readFileSync(indexHtmlPath, 'utf8');
  const namePrompt = readFileSync(namePromptPath, 'utf8');

  assert(selectionBar.includes('private cachedRange: MarkRange | null = null;'), 'Selection bar should cache selection range');
  assert(selectionBar.includes("this.bar.addEventListener('pointerdown'"), 'Selection bar should preserve selection via pointerdown');
  assert(popover.includes("type RenderMode = 'legacy-popover' | 'mobile-sheet';"), 'Popover should support mobile sheet render mode');
  assert(popover.includes('mark-mobile-strip'), 'Popover should render mobile comment strip');
  assert(popover.includes('actor.textContent = getActorName(mark.by);'), 'Popover cards should render actor via textContent');
  assert(!popover.includes('card.innerHTML = `<strong>${getActorName(mark.by)}</strong>'), 'Popover cards should not interpolate untrusted metadata via innerHTML');
  assert(popover.includes('if (!shouldUseCommentUiV2()) return;'), 'Pointerdown-open behavior should be limited to V2 mode');
  assert(popover.includes("this.strip.addEventListener('pointercancel'"), 'Strip swipe interaction should reset on pointercancel');
  assert(popover.includes('function installTouchSafeButton('), 'Popover should define shared touch-safe button helper');
  assert(popover.includes('installTouchSafeButton(replyButton'), 'Thread reply action should use touch-safe button wiring');
  assert(popover.includes('installTouchSafeButton(resolveButton'), 'Thread resolve/reopen action should use touch-safe button wiring');
  assert(popover.includes("type ThreadFocusMode = 'reply-box' | 'sheet' | 'none';"), 'Thread popover should support explicit focus modes for reopen behavior');
  assert(popover.includes("this.threadFocusMode = options?.threadFocusMode ?? 'reply-box';"), 'openForMark should preserve explicit thread focus mode overrides');
  assert(popover.includes('function getProofEditorApi(): Window[\'proof\'] | null {'), 'Popover should be able to reach the share-aware editor API when available');
  assert(popover.includes('proof.markAccept(mark.id);'), 'Suggestion apply action should use the share-aware editor API');
  assert(popover.includes('proof.markReject(mark.id);'), 'Suggestion reject action should use the share-aware editor API');
  assert(popover.includes('proof.markResolve(mark.id);'), 'Thread resolve action should use the share-aware editor API');
  assert(popover.includes('proof.markUnresolve(mark.id);'), 'Thread reopen action should use the share-aware editor API');
  assert(popover.includes("? proof.markReply(mark.id, getCurrentActor(), text)"), 'Thread reply action should use the share-aware editor API');
  assert(popover.includes("replyBox.blur();"), 'Mobile thread reply refresh should blur the reply box before reopening');
  assert(popover.includes("this.openForMark(mark.id, undefined, { threadFocusMode: 'sheet' });"), 'Mobile thread reply refresh should reopen without trapping focus in the reply box');
  assert(popover.includes('proof.markDeleteThread(mark.id);'), 'Thread delete action should use the share-aware editor API');
  assert(popover.includes('installTouchSafeButton(summary'), 'Mobile summary Open control should use touch-safe button wiring');
  assert(popover.includes('installTouchSafeButton(done'), 'Expanded strip Done control should use touch-safe button wiring');
  assert(popover.includes('installTouchSafeButton(undoButton'), 'Undo toast control should use touch-safe button wiring');
  assert(popover.includes('this.scheduleMobileStripRender();'), 'Mobile strip rendering should be scheduled/coalesced');
  assert(popover.includes('private getProseMirrorSelectionRange(): MarkRange | null'), 'Popover should expose a PM selection fallback range helper');
  assert(popover.includes('private hasFreshCachedActionRange(): boolean'), 'Popover should expose a cache freshness helper for iOS selection resilience');
  assert(popover.includes('const MOBILE_SELECTION_POLL_MS = 120;'), 'Popover should poll briefly after touch interactions to catch missed iOS selection events');
  assert(popover.includes('private scheduleSelectionPolling(durationMs: number = MOBILE_SELECTION_POLL_WINDOW_MS): void'), 'Popover should define short-lived mobile selection polling');
  assert(popover.includes('private handleEditorTouchEnd = () => {'), 'Popover should start selection polling from touchend on mobile');
  assert(popover.includes('private getDomSelectionRangeFromRects(range: Range)'), 'Popover should fallback to rect-based range mapping when posAtDOM fails on iOS');
  assert(popover.includes("typeof range.getBoundingClientRect !== 'function'"), 'Selection rect helper should guard non-range selections');
  assert(popover.includes("typeof range.getClientRects !== 'function'"), 'Rect-based selection fallback should guard non-range selections');
  assert(popover.includes('const mobileRange = mobile ? (domRange ?? pmRange) : null;'), 'Selectionchange should fallback to PM selection when DOM selection mapping fails');
  assert(popover.includes('const withinEditor = mobile\n        ? (Boolean(mobileRange) || hasDomSelectionInsideEditor)'), 'Selectionchange should treat in-editor DOM selection as live even before range mapping succeeds');
  assert(popover.includes('if (this.blurPendingTimer && !mobileRange) return;'), 'Blur-pending guard should only bail when no fallback selection exists');
  assert(popover.includes('const effectiveRange = domRange ?? pmRange;'), 'Blur recovery should rehydrate cached selection range after iOS blur races');
  assert(popover.includes('if (this.hasLiveSelection && !hasFreshCache)'), 'Selectionchange should avoid downgrading live selection while cache is fresh');
  assert(popover.includes('const selectedText = selection?.toString().trim() ?? \'\';'), 'Action range resolution should fallback to selected text when PM selection is collapsed');
  assert(popover.includes('const hasDomSelectionText = Boolean(\n        selection && selection.toString().trim().length > 0 && hasDomSelectionInsideEditor\n      );'), 'Render sync should detect in-editor DOM text selection even when range mapping fails');
  assert(popover.includes('} else if (!hasSelection && hasDomSelectionText && !this.hasLiveSelection) {'), 'Render sync should elevate live-selection state from DOM text selection fallback');
  assert(popover.includes('Comments (${data.totalCount})'), 'Mobile strip should render an explicit comments summary count');
  assert(popover.includes('No nearby comments · ${data.totalCount} total'), 'Mobile strip summary should distinguish nearby vs total counts');
  assert(popover.includes("this.renderMobileStripSection('Nearby', nearby);"), 'Expanded mobile strip should include a Nearby section');
  assert(popover.includes("this.renderMobileStripSection('All comments'"), 'Expanded mobile strip should include an All comments section');
  assert(popover.includes("if (this.mode === 'composer' || this.mode === 'thread') {"), 'Mobile sheet should autofocus textarea for compose + thread flows');
  assert(popover.includes("this.popover.classList.toggle('mark-popover-keyboard-open', offset > 0);"), 'Mobile sheet should track keyboard-open viewport state');
  assert(popover.includes("if (!shouldUseCommentUiV2()) return;"), 'Viewport offset handling should still run for v2 mobile strip state');
  assert(popover.includes("if (this.renderMode === 'mobile-sheet' && this.mode) {"), 'Popover-specific viewport offset should be scoped to mobile sheet mode only');
  assert(popover.includes('getViewportOffset(window.innerHeight, vv ?? null);'), 'Mobile sheet offset should use shared viewport calculation');
  assert(popover.includes('getVisualViewportHeight(window.innerHeight, vv ?? null);'), 'Mobile sheet height should use shared viewport calculation');
  assert(popover.includes("view.dom.addEventListener('touchstart', this.handleEditorTouchStart, { passive: true });"), 'Mobile selection polling should start on touchstart inside the editor');
  assert(popover.includes("if (event.pointerType === 'touch') {\n      this.scheduleSelectionPolling();\n    }"), 'Mobile pointerdown should begin selection polling before Safari native selection finishes');
  assert(popover.includes("if (comments.totalCount > 0 && !canShowActionRow) {"), 'Selection state should prioritize action row over the comments summary chip');
  assert(popover.includes('this.positionMobileSelectionActions(canShowActionRow);'), 'Selection state should reposition action row near the selected text');
  assert(popover.includes("if (shouldUseCommentUiV2()) {\n      this.scheduleMobileStripRender();\n    }"), 'Viewport and scroll handlers should request a mobile strip rerender so floating actions stay anchored');
  assert(popover.includes('this.updateSheetViewportOffset();\n      // Keep the floating action row anchored after viewport/scroll updates.\n      this.positionMobileSelectionActions(canShowActionRow);'), 'Signature-fast-path updates should still re-anchor floating selection actions');
  assert(popover.includes("this.strip.classList.contains('mark-mobile-strip-selection')"), 'Floating selection action row should skip bottom padding adjustments');
  assert(popover.includes("this.strip.classList.toggle('mark-mobile-strip-selection', canShowActionRow && !this.mobileStripExpanded);"), 'Selection styling should be reapplied even when the mobile strip render signature is unchanged');
  assert(popover.includes('selectionRect.left + (selectionRect.width / 2) - (stripRect.width / 2)'), 'Floating selection action row should be centered on the selected text');
  assert(commentUiMode.includes('__PROOF_CONFIG__?.commentUiDefaultMode'), 'Comment UI mode should honor the server-provided runtime default');
  assert(viewport.includes('export function getViewportOffset'), 'Expected shared viewport offset helper');
  assert(viewport.includes('layoutHeight - vv.height - vv.offsetTop'), 'Viewport offset should account for visual viewport height + offset');
  assert(popover.includes('this.popover.tabIndex = -1;'), 'Mobile sheet container should be focusable for keyboard-safe focus management');
  assert(popover.includes("replyBox.addEventListener('focus', () => {"), 'Thread reply box should update viewport offset when focused');
  assert(popover.includes('replyBox.focus({ preventScroll: true });'), 'Thread view should autofocus the reply box on mobile sheet open');
  assert(popover.includes("this.popover.classList.remove('mark-popover-keyboard-open');"), 'Mobile thread reopen should clear keyboard-open styling when keeping focus on the sheet');
  assert(popover.includes("this.popover.appendChild(header);\n    this.popover.appendChild(list);\n    if (replyBox) this.popover.appendChild(replyBox);\n    this.popover.appendChild(actions);"), 'Thread reply box should render below the thread list and above the action row');
  assert(popover.includes('textarea.focus({ preventScroll: true });'), 'Composer should autofocus textarea on mobile sheet open');
  assert(indexHtml.includes('.mark-mobile-summary'), 'Expected collapsed mobile summary chip styles');
  assert(indexHtml.includes('.mark-mobile-strip.mark-mobile-strip-expanded'), 'Expected expanded mobile strip container styles');
  assert(indexHtml.includes('.mark-mobile-strip.mark-mobile-strip-selection'), 'Expected dedicated floating-selection mobile strip styles');
  assert(indexHtml.includes('display: inline-flex;'), 'Expected floating selection action row to use a compact inline layout');
  assert(indexHtml.includes('grid-template-columns: repeat(3, minmax(0, 1fr));'), 'Expected collapsed mobile action row to use a visible three-button grid');
  assert(indexHtml.includes('background: rgba(22, 22, 22, 0.96);'), 'Expected collapsed mobile action row to render on a dark card background');
  assert(indexHtml.includes('box-sizing: border-box;'), 'Expected mobile sheet to use border-box sizing to avoid horizontal overflow');
  assert(indexHtml.includes('width: 100vw;'), 'Expected mobile sheet width to be viewport-clamped');
  assert(indexHtml.includes('.mark-popover.mark-popover-sheet .mark-popover-actions {'), 'Expected sheet actions to stay visible with sticky positioning');
  assert(arrow.includes("if (text !== '>') return false;"), 'Arrow trigger plugin should watch for > input');
  assert(arrow.includes("if (previousChar !== '-') return false;"), 'Arrow trigger plugin should detect -> sequence');
  assert(arrow.includes('if (preArrowChar.length > 0 && !/\\s/.test(preArrowChar)) return false;'), 'Arrow trigger should ignore prose arrows in words');
  assert(indexSource.includes('.use(arrowCommentPlugin)'), 'Editor should register arrow comment plugin');
  assert(indexHtml.includes('.mark-popover-actions button {'), 'Expected shared mark-popover button style block');
  assert(indexHtml.includes('min-height: 44px;'), 'Expected popover action buttons to meet 44px touch target minimum');
  assert(indexSource.includes('min-height:44px;min-width:44px'), 'Expected share controls and menu actions to enforce 44px touch targets');
  assert(indexSource.includes('This document was shared with you for viewing.'), 'Expected viewer-specific welcome copy');
  assert(indexSource.includes('This document was shared with you. You can leave comments.'), 'Expected commenter-specific welcome copy');
  assert(indexSource.includes('proof-share-welcome-toast'), 'Expected share welcome toast to use mobile-safe class');
  assert(indexSource.includes('this.positionShareWelcomeToast(toast);'), 'Expected share welcome toast to be positioned against live viewport + banner');
  assert(indexSource.includes('const canActInDocument = Boolean(context?.capabilities?.canComment || context?.capabilities?.canEdit);'), 'Expected share init to gate name prompt on real capabilities');
  assert(indexSource.includes('const existingViewerName = getViewerName();'), 'Expected share init to resolve any stored viewer identity before prompting');
  assert(indexSource.includes('this.shareViewerName = existingViewerName ?? this.shareViewerName ?? this.deriveDefaultShareViewerName();'), 'Expected share init to reuse stored names before falling back to an anonymous identity');
  assert(indexSource.includes('void promptForName()'), 'Expected share init to prompt for a name without blocking initial document load');
  assert(indexSource.includes("console.warn('[share] name prompt failed', error);"), 'Expected share init to tolerate prompt failures without aborting share bootstrap');
  assert(indexSource.includes("const initialMarks = (context?.doc?.marks && typeof context.doc.marks === 'object' && !Array.isArray(context.doc.marks))"), 'Expected share init to seed collab marks from open-context snapshot metadata');
  assert(indexSource.includes('this.lastReceivedServerMarks = initialMarks;'), 'Expected collab share init to preserve snapshot marks before live sync arrives');
  assert(indexSource.includes('this.pendingCollabRebindOnSync = true;'), 'Expected collab share init to defer editor binding until live collab sync is ready');
  assert(indexSource.includes('this.pendingCollabRebindResetDoc = true;'), 'Expected collab share init to request a reset editor bind after the first live sync');
  assert(/if \(this\.collabEnabled && this\.collabCanEdit\) {\n\s*this\.publishProjectionMarkdown\(view, markdown, 'marks-flush'\);\n\s*collabClient\.setMarksMetadata\(metadata\);/.test(indexSource), 'Expected share mark flushes to use collab metadata only for editable sessions');
  assert(indexSource.includes('const shouldPersistMarks = shouldKeepalivePersistShareMarks({'), 'Expected share mark flushes to gate keepalive REST writes when live editable sessions still own authoritative content');
  assert(indexSource.includes('if (!shouldPersistMarks) {'), 'Expected share mark flushes to skip REST keepalive writes when they would race live content persistence');
  assert(indexSource.includes("void shareClient.pushMarks(metadata, getCurrentActor(), { keepalive: Boolean(_options?.keepalive) });"), 'Expected safe mark flushes to continue falling back to REST mark persistence');
  assert(namePrompt.includes('function shouldAutofocusInput(): boolean {'), 'Expected name prompt to centralize autofocus logic');
  assert(namePrompt.includes("window.matchMedia('(pointer: coarse)').matches"), 'Expected name prompt to avoid coarse-pointer keyboard autofocus');
  assert(namePrompt.includes('if (shouldAutofocusInput()) {'), 'Expected name prompt autofocus to be gated');
  assert(namePrompt.includes("input.autocomplete = 'name';"), 'Expected name prompt to opt into name autocomplete');
  assert(namePrompt.includes('min-height: 44px;'), 'Expected name prompt actions to meet 44px touch targets');
  assert(namePrompt.includes('Continue anonymously'), 'Expected explicit anonymous fallback copy');
});

if (failed > 0) {
  console.error(`\n❌ ${failed} mobile comment UX test(s) failed`);
  process.exit(1);
}

console.log(`\n✅ ${passed} mobile comment UX test(s) passed`);
