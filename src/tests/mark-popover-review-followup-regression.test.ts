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
    source.includes('let stableFollowupMarkId: string | null = null;')
      && source.includes('if (stableFollowupMarkId === followupMarkId || remainingAttempts <= 0) {')
      && source.includes('stableFollowupMarkId = followupMarkId;')
      && source.includes("const stateActiveMarkId = getActiveMarkId(this.view.state);")
      && source.includes('const followupActive = stateActiveMarkId === followupMarkId;'),
    'Expected review follow-up to require a confirmed stable reopen before it clears the transition guard, and to trust editor state rather than stale controller state when deciding whether the next suggestion is open',
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
