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
      && source.includes('const stateActiveMarkId = getActiveMarkId(this.view.state);')
      && source.includes('stateActiveMarkId,')
      && source.includes('this.activeMarkId,')
      && source.includes('fallbackMarkId ?? null,')
      && source.includes('const fallbackPendingMarkId = this.getFirstPendingSuggestionMarkId();')
      && source.includes("const getActiveSuggestionActionTarget = (): {")
      && source.includes('} | null => this.getLiveSuggestionActionTarget(mark.id);')
      && source.includes("this.runSuggestionReviewAction(target.markId, 'reject', target.nextMarkId, target.kind, {")
      && source.includes("this.runSuggestionReviewAction(target.markId, 'accept', target.nextMarkId, target.kind, {"),
    'Expected review actions to resolve the live active suggestion target from editor state at click time so an auto-advanced popover cannot keep firing a stale mark id after navigation',
  );

  assert(
    source.includes('let stableFollowupMarkId: string | null = null;')
      && source.includes('if (stableFollowupMarkId === followupMarkId || remainingAttempts <= 0) {')
      && source.includes('stableFollowupMarkId = followupMarkId;')
      && source.includes("const stateActiveMarkId = getActiveMarkId(this.view.state);")
      && source.includes('const followupActive = stateActiveMarkId === followupMarkId;')
      && source.includes("this.openForMark(followupMarkId, undefined, { source: 'direct' });")
      && source.includes('const fallbackMarkId = this.getFirstPendingSuggestionMarkId();')
      && source.includes("this.openForMark(fallbackMarkId, undefined, { source: 'direct' });"),
    'Expected review follow-up to require a confirmed stable reopen before it clears the transition guard, and to force-open the remaining pending suggestion if the timed follow-up never stabilizes',
  );

  assert(
    source.includes('setReviewButtonsBusy(false);')
      && source.includes('private reopenFirstPendingSuggestion(')
      && source.includes('const fallbackMarkId = this.getFirstPendingSuggestionMarkId();')
      && source.includes("this.openForMark(fallbackMarkId, undefined, {")
      && source.includes("preserveReviewTransition: options?.preserveReviewTransition,"),
    'Expected successful persisted review actions to re-enable the current action row before follow-up, and expected suggestion updates to immediately reopen the remaining pending suggestion if the active mark disappears mid-transition',
  );

  assert(
    source.includes('if (this.reopenFirstPendingSuggestion({')
      && source.includes('preserveReviewTransition: this.suggestionReviewTransitionPending,')
      && source.includes('if (this.suggestionReviewTransitionPending) {')
      && source.includes('if (!activeMark && this.reopenFirstPendingSuggestion()) {')
      && source.includes('const reboundMarkId = getActiveMarkId(this.view.state) ?? this.activeMarkId;'),
    'Expected stale suggestion popovers to rebind to the first remaining pending suggestion after collab reseeds, and to keep the review transition alive instead of closing during transient mixed-mark gaps',
  );

  assert(
    source.includes('private reviewActionInFlight: boolean = false;')
      && source.includes('if (this.reviewActionInFlight) {')
      && source.includes("const followupTarget = this.mode === 'suggestion' && this.popover.style.display !== 'none'")
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
      && !source.includes("if (nextMarkId) {\n        this.navigateToSuggestion(nextMarkId);\n      }\n      this.openSuggestionAfterReview(nextMarkId, reviewedMarkIds);"),
    'Expected openForMark to keep the follow-up timer and transition guard intact during review-driven navigation, and expected review finish to avoid the stale pre-navigation that bound auto-advanced popovers to the wrong mark',
  );

  assert(
    source.includes('private isEventWithinInteractivePopoverChrome(')
      && source.includes('const composedPath = typeof event.composedPath === \'function\' ? event.composedPath() : [];')
      && source.includes('if (composedPath.includes(element)) return true;')
      && source.includes('const rect = element.getBoundingClientRect();')
      && source.includes('event.clientX >= rect.left')
      && source.includes('if (this.isEventWithinInteractivePopoverChrome(event)) return;'),
    'Expected outside-click handling to treat pointer events inside the visible popover chrome as internal interactions even if the DOM target is stale during auto-advance rerenders',
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
