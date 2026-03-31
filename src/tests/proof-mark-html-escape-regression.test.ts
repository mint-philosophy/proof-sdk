import { unified } from 'unified';
import remarkParse from 'remark-parse';

import { proofMarkHandler, remarkProofMarks } from '../formats/remark-proof-marks.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function extractSuggestionChildValue(markdown: string): unknown {
  const tree = unified().use(remarkParse).parse(markdown) as {
    children?: Array<{
      children?: Array<{
        type?: string;
        children?: Array<{ type?: string; value?: unknown }>;
      }>;
    }>;
  };
  remarkProofMarks()(tree as any);
  const paragraph = tree.children?.[0];
  const proofMark = paragraph?.children?.find((child) => child?.type === 'proofMark');
  return proofMark?.children?.[0]?.value;
}

function run(): void {
  const serializedLiteralTag = proofMarkHandler({
    type: 'proofMark',
    proof: 'suggestion',
    attrs: { id: 'm-html', by: 'human:test', kind: 'insert' },
    children: [{ type: 'text', value: '<tagged>' }],
  } as any);

  assert(
    serializedLiteralTag.includes('&lt;tagged&gt;'),
    `Expected literal angle brackets to be HTML-escaped inside proof spans, got ${JSON.stringify(serializedLiteralTag)}`,
  );
  assert(
    extractSuggestionChildValue(`Paragraph ${serializedLiteralTag} end`) === '<tagged>',
    'Expected escaped proof-span text to parse back into the original literal tag text',
  );

  const serializedHtmlLikeText = proofMarkHandler({
    type: 'proofMark',
    proof: 'suggestion',
    attrs: { id: 'm-html-2', by: 'human:test', kind: 'insert' },
    children: [{ type: 'text', value: '<b> & stuff' }],
  } as any);

  assert(
    serializedHtmlLikeText.includes('&lt;b&gt; &amp; stuff'),
    `Expected mixed HTML-like text to stay escaped inside proof spans, got ${JSON.stringify(serializedHtmlLikeText)}`,
  );
  assert(
    extractSuggestionChildValue(`Paragraph ${serializedHtmlLikeText} end`) === '<b> & stuff',
    'Expected escaped proof-span text with ampersands to parse back into the original literal text',
  );

  console.log('✓ proof mark serializer escapes literal HTML-like insert text');
}

run();
