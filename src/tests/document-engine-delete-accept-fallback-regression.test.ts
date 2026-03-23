import { __buildAcceptedSuggestionMarkdownForTests } from '../../server/document-engine.js';
import type { StoredMark } from '../formats/marks.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  }
}

function run(): void {
  const markId = 'delete-fallback-regression-1234567890abcdef1234567890abcdef';
  const markdown = `Alpha <span data-proof="suggestion" data-id="${markId}" data-by="ai:browser-qa" data-kind="delete">beta</span> gamma.`;
  const mark: StoredMark = {
    kind: 'delete',
    by: 'ai:browser-qa',
    createdAt: '2026-03-22T00:00:00.000Z',
    quote: 'beta',
    status: 'pending',
  };

  const accepted = __buildAcceptedSuggestionMarkdownForTests(markdown, mark);
  assert(accepted !== null, 'Expected delete accept helper to produce markdown');
  assertEqual(
    accepted,
    'Alpha  gamma.',
    'Expected delete accept helper to remove the entire suggestion wrapper, not leave an empty proof span',
  );

  console.log('✓ delete accept helper removes long suggestion wrappers instead of leaving empty spans');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
