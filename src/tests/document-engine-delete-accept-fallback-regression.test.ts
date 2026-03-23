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

  const insertMarkId = 'insert-materialized-regression-1234567890abcdef';
  const insertMarkdown = `Alpha <span data-proof="suggestion" data-id="${insertMarkId}" data-by="human:editor" data-kind="insert">SERVER FIX TEST</span> gamma.`;
  const insertMark: StoredMark = {
    kind: 'insert',
    by: 'human:editor',
    createdAt: '2026-03-24T00:00:00.000Z',
    quote: 'SERVER FIX TEST',
    content: 'SERVER FIX TEST',
    status: 'pending',
    range: { from: 7, to: 22 },
  };

  const acceptedInsert = __buildAcceptedSuggestionMarkdownForTests(insertMarkdown, insertMark);
  assert(acceptedInsert !== null, 'Expected insert accept helper to produce markdown');
  assertEqual(
    acceptedInsert,
    insertMarkdown,
    'Expected materialized tracked inserts to accept in-place without duplicating their content',
  );

  console.log('✓ accept helper preserves materialized inserts and removes wrapped deletes correctly');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
