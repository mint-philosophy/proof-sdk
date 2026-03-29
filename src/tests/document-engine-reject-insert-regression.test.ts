import { __buildRejectedSuggestionMarkdownForTests } from '../../server/document-engine';
import type { StoredMark } from '../formats/marks';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual:   ${JSON.stringify(actual)}`);
  }
}

function run(): void {
  const materializedInsert: StoredMark = {
    kind: 'insert',
    by: 'human:test',
    createdAt: new Date().toISOString(),
    status: 'pending',
    quote: ' drone',
    content: ' drone',
    startRel: 'char:19',
    endRel: 'char:25',
    range: { from: 19, to: 25 },
  };
  const materializedMarkdown = 'Baseline sentence. drone imagery remained.';
  const rejectedMaterialized = __buildRejectedSuggestionMarkdownForTests(materializedMarkdown, materializedInsert);
  assertEqual(
    rejectedMaterialized,
    'Baseline sentence. imagery remained.',
    'Rejecting a materialized insert should remove the inserted text instead of leaving it in canonical markdown',
  );

  const anchoredInsert: StoredMark = {
    kind: 'insert',
    by: 'human:test',
    createdAt: new Date().toISOString(),
    status: 'pending',
    quote: 'Alpha',
    content: ' beta',
    startRel: 'char:0',
    endRel: 'char:5',
    range: { from: 0, to: 5 },
  };
  const anchoredMarkdown = 'Alpha beta gamma.';
  const rejectedAnchored = __buildRejectedSuggestionMarkdownForTests(anchoredMarkdown, anchoredInsert);
  assertEqual(
    rejectedAnchored,
    'Alpha gamma.',
    'Rejecting an inline inserted suffix should remove the inserted content while preserving the anchor quote',
  );

  const paragraphBreakInsert: StoredMark = {
    kind: 'insert',
    by: 'human:test',
    createdAt: new Date().toISOString(),
    status: 'pending',
    quote: 'March.',
    content: '\n',
    startRel: 'char:6',
    endRel: 'char:7',
    range: { from: 6, to: 7 },
  };
  const paragraphBreakMarkdown = 'March.\n\nthe';
  const rejectedParagraphBreak = __buildRejectedSuggestionMarkdownForTests(paragraphBreakMarkdown, paragraphBreakInsert);
  assertEqual(
    rejectedParagraphBreak,
    'March.the',
    'Rejecting a paragraph-break insertion should remove the full markdown paragraph separator instead of leaving the paragraphs split',
  );

  const paragraphBreakWithTrailingTextInsert: StoredMark = {
    kind: 'insert',
    by: 'human:test',
    createdAt: new Date().toISOString(),
    status: 'pending',
    quote: 'March.',
    content: '\nthe',
    startRel: 'char:8',
    endRel: 'char:10',
    range: { from: 8, to: 10 },
  };
  const rejectedParagraphBreakWithTrailingText = __buildRejectedSuggestionMarkdownForTests(
    paragraphBreakMarkdown,
    paragraphBreakWithTrailingTextInsert,
  );
  assertEqual(
    rejectedParagraphBreakWithTrailingText,
    'March.the',
    'Rejecting a structural paragraph-break insert should preserve the first character of the following paragraph text',
  );

  const deleteSuggestion: StoredMark = {
    kind: 'delete',
    by: 'human:test',
    createdAt: new Date().toISOString(),
    status: 'pending',
    quote: 'gamma',
    startRel: 'char:11',
    endRel: 'char:16',
    range: { from: 11, to: 16 },
  };
  const deleteMarkdown = 'Alpha beta gamma.';
  const rejectedDelete = __buildRejectedSuggestionMarkdownForTests(deleteMarkdown, deleteSuggestion);
  assert(rejectedDelete === deleteMarkdown, 'Rejecting a delete suggestion should preserve the current markdown');

  console.log('document-engine-reject-insert-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
