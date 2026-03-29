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
      && source.includes('const preferredMarkId = this.activeMarkId ?? mark.id;')
      && source.includes('const fallbackMarkId = this.getFirstPendingSuggestionMarkId();')
      && source.includes("nextMarkId: this.getAdjacentSuggestionMarkId(activeMark.id, 'next'),")
      && source.includes("this.runSuggestionReviewAction(target.markId, 'reject', target.nextMarkId, target.kind, {")
      && source.includes("this.runSuggestionReviewAction(target.markId, 'accept', target.nextMarkId, target.kind, {"),
    'Expected review action buttons to resolve the active mark and next target at click time so a stale popover cannot keep firing the previous mark id after navigation',
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
      && source.includes('const reboundMarkId = this.activeMarkId;'),
    'Expected stale suggestion popovers to rebind to the first remaining pending suggestion after collab reseeds, and to keep the review transition alive instead of closing during transient mixed-mark gaps',
  );

  assert(
    source.includes('private reviewActionInFlight: boolean = false;')
      && source.includes('if (this.reviewActionInFlight) {')
      && source.includes('const followupReady = this.mode === \'suggestion\'')
      && source.includes('this.activeMarkId === markId')
      && source.includes('this.suggestionReviewTransitionPending = false;')
      && source.includes('this.reviewActionInFlight = true;')
      && source.includes('this.reviewActionInFlight = false;'),
    'Expected review actions to block duplicate dispatch while a persisted accept/reject is in flight, but to let a visible auto-advanced follow-up mark cancel the stale transition guard and accept the next click',
  );

  assert(
    source.includes("if (!options?.preserveReviewTransition && this.suggestionReviewFollowupTimer !== null) {")
      && source.includes('if (!options?.preserveReviewTransition) {')
      && source.includes("preserveReviewTransition?: boolean;"),
    'Expected openForMark to keep the follow-up timer and transition guard intact during review-driven navigation',
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
