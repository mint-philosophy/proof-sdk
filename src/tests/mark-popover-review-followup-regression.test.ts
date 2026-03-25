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
    source.includes("if (!options?.preserveReviewTransition && this.suggestionReviewFollowupTimer !== null) {")
      && source.includes('if (!options?.preserveReviewTransition) {')
      && source.includes("preserveReviewTransition?: boolean;"),
    'Expected openForMark to keep the follow-up timer and transition guard intact during review-driven navigation',
  );

  console.log('mark-popover-review-followup-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
