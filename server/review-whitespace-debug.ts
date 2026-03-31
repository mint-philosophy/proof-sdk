import {
  summarizeReviewWhitespaceMarkdown,
  summarizeReviewWhitespaceMarks,
} from '../src/shared/review-whitespace-debug.js';

function parseDebugFlag(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function shouldDebugReviewWhitespace(): boolean {
  return parseDebugFlag(process.env.PROOF_DEBUG_REVIEW_WHITESPACE);
}

export function logReviewWhitespace(
  scope: string,
  event: string,
  payload: Record<string, unknown> = {},
): void {
  if (!shouldDebugReviewWhitespace()) return;
  console.info(`[review-whitespace] ${scope}.${event}`, payload);
}

export {
  summarizeReviewWhitespaceMarkdown,
  summarizeReviewWhitespaceMarks,
};
