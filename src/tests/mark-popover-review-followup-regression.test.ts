import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const source = readFileSync(
    path.resolve(process.cwd(), 'src/editor/plugins/mark-popover.ts'),
    'utf8',
  );

  assert(
    source.includes("this.navigateToSuggestion(followupMarkId, { preserveReviewTransition: true });"),
    'Expected review follow-up navigation to preserve the transition guard while the next suggestion is reopening',
  );

  assert(
    source.includes('const getActiveSuggestionActionTarget = (): {')
      && source.includes('private getLiveSuggestionActionTarget(')
      && source.includes('private getLiveAdjacentSuggestionTarget(')
      && source.includes('export function resolveSuggestionActionTarget(')
      && source.includes('export function resolveAdjacentSuggestionActionTarget(')
      && source.includes('export function buildSuggestionActionTargetPreferredMarkIds(')
      && source.includes('const stateActiveMarkId = getActiveMarkId(this.view.state);')
      && source.includes('const suggestions = this.getPendingSuggestionReviewItems();')
      && source.includes('const preferredMarkIds = buildSuggestionActionTargetPreferredMarkIds(')
      && source.includes("options?.preference ?? 'fallback-first'")
      && source.includes('return resolveSuggestionActionTarget(suggestions, preferredMarkIds, this.view.state.doc);')
      && source.includes("const getActiveSuggestionActionTarget = (): {")
      && source.includes("} | null => this.getLiveSuggestionActionTarget(mark.id, { preference: 'active-first' });")
      && source.includes("const getPreviousSuggestionNavigationTarget = (): {")
      && source.includes("} | null => this.getLiveAdjacentSuggestionTarget('prev', mark.id, { preference: 'active-first' });")
      && source.includes("const getNextSuggestionNavigationTarget = (): {")
      && source.includes("} | null => this.getLiveAdjacentSuggestionTarget('next', mark.id, { preference: 'active-first' });")
      && source.includes("this.runSuggestionReviewAction(target.markId, 'reject', target.nextMarkId, target.kind, {")
      && source.includes("this.runSuggestionReviewAction(target.markId, 'accept', target.nextMarkId, target.kind, {"),
    'Expected review actions to prefer the live active suggestion target from editor state at click time so an auto-advanced popover cannot keep firing a stale rendered mark id after navigation, while still routing through the shared resolver helpers',
  );

  assert(
    source.includes('const orderedSuggestions = orderSuggestionReviewItemsByDocumentPosition(suggestions, doc);')
      && source.includes('const currentTarget = resolveSuggestionActionTarget(orderedSuggestions, preferredMarkIds);')
      && source.includes('const adjacentMarkId = getAdjacentSuggestionReviewMarkId(orderedSuggestions, currentTarget.markId, direction);')
      && source.includes('const adjacentReviewItem = orderedSuggestions.find((item) => item.memberMarkIds.includes(adjacentMarkId)) ?? null;')
      && source.includes("kind: adjacentReviewItem.kind,")
      && source.includes('return resolveAdjacentSuggestionActionTarget(')
      && !source.includes('if (!target && this.reopenFirstPendingSuggestion()) {'),
    'Expected suggestion navigation to resolve adjacent review targets from live document-position ordering instead of relying on stale stored mark ranges',
  );

  assert(
    source.includes("const stateActiveMarkId = getActiveMarkId(this.view.state);")
      && source.includes('const followupActive = stateActiveMarkId === followupMarkId;')
      && source.includes('const followupDeadlineAt = Date.now() + (')
      && source.includes('this.suggestionReviewPreferredFollowupMarkId = preferredMarkId;')
      && source.includes('this.suggestionReviewPreferredFollowupMarkId = null;')
      && source.includes('const collabPending = isSuggestionReviewFollowupCollabPending(')
      && source.includes('followupRemainingMs')
      && source.includes('if (collabPending && followupRemainingMs > 0) {')
      && source.includes("this.openForMark(followupMarkId, undefined, { source: 'direct' });")
      && source.includes('if (followupPanelOpen && collabStable) {')
      && source.includes('this.suggestionReviewTransitionPending = false;')
      && source.includes('const fallbackMarkId = this.getFirstPendingSuggestionMarkId();')
      && source.includes('const remainingSuggestions = orderSuggestionReviewItemsByDocumentPosition(')
      && source.includes('this.view.state.doc,')
      && !source.includes('REVIEW_FOLLOWUP_MAX_RETRIES_WITH_TARGET')
      && source.includes("this.openForMark(fallbackMarkId, undefined, { source: 'direct' });"),
    'Expected review follow-up to use live document-position ordering and to keep waiting while an accept-triggered collab reconnect is still repopulating marks, instead of exhausting a fixed retry count and closing early',
  );

  assert(
    source.includes('setReviewButtonsBusy(false);')
      && source.includes('private reopenFirstPendingSuggestion(')
      && source.includes('const fallbackMarkId = this.getFirstPendingSuggestionMarkId();')
      && source.includes("this.openForMark(fallbackMarkId, undefined, {")
      && source.includes("preserveReviewTransition: options?.preserveReviewTransition,"),
    'Expected successful persisted review actions to re-enable the current action row before follow-up, while still keeping a generic first-pending reopen path available for non-transition suggestion refreshes',
  );

  assert(
    source.includes('if (this.suggestionReviewTransitionPending) {')
      && source.includes("console.log('[mark-popover.update.waitingForFollowup]');")
      && source.includes('if (this.reopenFirstPendingSuggestion()) {')
      && source.includes("console.log('[mark-popover.update.deferNonPreferredFollowupOpen]', {")
      && source.includes('preferredFollowupMarkId: this.suggestionReviewPreferredFollowupMarkId,')
      && !source.includes('const reboundMarkId = getActiveMarkId(this.view.state) ?? this.activeMarkId;'),
    'Expected stale suggestion popovers to keep waiting for the targeted review follow-up while a review transition is pending, and only fall back to reopening the first remaining pending suggestion once no targeted transition is in flight',
  );

  assert(
    source.includes('private reviewActionInFlight: boolean = false;')
      && source.includes('const expectedFollowupMarkId = this.suggestionReviewPreferredFollowupMarkId;')
      && source.includes('if (this.reviewActionInFlight) {')
      && source.includes("const followupTarget = this.mode === 'suggestion' && this.popover.style.display !== 'none'")
      && source.includes('? this.getLiveSuggestionActionTarget(expectedFollowupMarkId ?? markId)')
      && source.includes('if (expectedFollowupMarkId && followupTarget.markId !== expectedFollowupMarkId) {')
      && source.includes('markId = followupTarget.markId;')
      && source.includes('nextMarkId = followupTarget.nextMarkId;')
      && source.includes('suggestionKind = followupTarget.kind;')
      && source.includes('const liveTarget = this.getLiveSuggestionActionTarget(markId);')
      && source.includes('this.suggestionReviewTransitionPending = false;')
      && source.includes('this.reviewActionInFlight = true;')
      && source.includes('this.reviewActionInFlight = false;'),
    'Expected review actions to block duplicate dispatch while a persisted accept/reject is in flight, but to rebind stale auto-advanced clicks onto the live pending suggestion before running the next mutation',
  );

  assert(
    source.includes("if (!options?.preserveReviewTransition && this.suggestionReviewFollowupTimer !== null) {")
      && source.includes('if (!options?.preserveReviewTransition) {')
      && source.includes("preserveReviewTransition?: boolean;")
      && source.includes('const navigated = proof.navigateToMark(markId);')
      && source.includes('if (navigated) {')
      && source.includes("this.openForMark(markId, undefined, {")
      && !source.includes("if (nextMarkId) {\n        this.navigateToSuggestion(nextMarkId);\n      }\n      this.openSuggestionAfterReview(nextMarkId, reviewedMarkIds);"),
    'Expected openForMark to keep the follow-up timer and transition guard intact during review-driven navigation, and expected review finish to avoid the stale pre-navigation that bound auto-advanced popovers to the wrong mark',
  );

  assert(
    source.includes('private isEventWithinInteractivePopoverChrome(')
      && source.includes('const composedPath = typeof event.composedPath === \'function\' ? event.composedPath() : [];')
      && source.includes("if (targetElement?.closest('.mark-popover, .mark-mobile-strip, .mark-review-context-menu')) {")
      && source.includes('if (composedPath.includes(element)) return true;')
      && source.includes('const rect = element.getBoundingClientRect();')
      && source.includes('event.clientX >= rect.left')
      && source.includes('if (this.isEventWithinInteractivePopoverChrome(event)) return;'),
    'Expected outside-click handling to treat pointer events inside the visible popover chrome as internal interactions even if the DOM target is stale during auto-advance rerenders',
  );

  assert(
    source.includes('destroy(): void {')
      && !source.includes('destroy(): void {\n    this.close();')
      && source.includes("document.removeEventListener('pointerdown', this.handleOutsidePointerDown);")
      && source.includes("document.removeEventListener('mousedown', this.handleOutsideClick);")
      && source.includes("document.removeEventListener('keydown', this.handleKeydown, true);")
      && source.includes("this.popover.style.display = 'none';")
      && source.includes("this.activeMarkId = null;"),
    'Expected plugin-view destroy to tear down old popover chrome and document listeners without calling close(), so auto-advanced review state is not cleared during plugin-view recreation',
  );

  assert(
    source.includes('function canMergeAdjacentInsertReviewItems(')
      && source.includes("const gapText = doc.textBetween(left.range.to, right.range.from, '\\n', '\\n');")
      && source.includes('return isWhitespaceOnlyInlineGap(gapText);')
      && source.includes('const mergedInsertMark = buildMergedInsertReviewMark(fragments, doc);')
      && source.includes('memberMarkIds: fragments.map((fragment) => fragment.id),')
      && source.includes('this.view.state.doc,'),
    'Expected review-item construction to merge adjacent pending insert fragments within the same paragraph so collab-split suggestions stay actionable as one review item',
  );

  console.log('mark-popover-review-followup-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
