import { readFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const engineSource = readFileSync(path.resolve(process.cwd(), 'server/document-engine.ts'), 'utf8');
  assert(
    engineSource.includes("if (status === 'accepted' || status === 'rejected') {")
      && engineSource.includes('await invalidateCollabDocumentAndWait(slug);'),
    'Expected async accepted suggestion finalization to wait for full collab invalidation before returning',
  );
  assert(
    engineSource.includes('const originalMark = marks[markId];')
      && engineSource.includes('const stabilizedOriginalMark = originalMark')
      && engineSource.includes('stabilizeCollapsedMaterializedInsertMark(baseMarkdown, originalMark)')
      && engineSource.includes("&& isMaterializedInsertMark(baseMarkdown, stabilizedOriginalMark)")
      && engineSource.includes("nextMarkdown = applyMutationCleanup('POST /marks/accept', stripAllProofSpanTags(nextMarkdown));"),
    'Expected accept-all batch loop to preserve originally materialized insert marks instead of replaying them as fresh inserts',
  );

  const dbName = `proof-shared-insert-accept-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  delete process.env.PROOF_DB_ENV_INIT;

  const db = await import('../../server/db.ts');
  const { executeDocumentOperationAsync } = await import('../../server/document-engine.ts');

  try {
    const slug = `shared-insert-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(slug, 'Alpha gamma.\n', {}, 'Shared insert accept regression');

    const suggest = await executeDocumentOperationAsync(slug, 'POST', '/marks/suggest-insert', {
      quote: 'Alpha',
      content: ' beta',
      by: 'ai:test',
    });
    assert(suggest.status === 200, `Expected insert suggestion status 200, got ${suggest.status}`);

    const marks = (suggest.body.marks ?? {}) as Record<string, { kind?: string }>;
    const markId = Object.entries(marks).find(([, mark]) => mark?.kind === 'insert')?.[0] ?? '';
    assert(markId.length > 0, 'Expected insert suggestion mark id');

    const accepted = await executeDocumentOperationAsync(slug, 'POST', '/marks/accept', {
      markId,
      by: 'human:test',
    });
    assert(accepted.status === 200, `Expected insert accept status 200, got ${accepted.status}`);
    assert(
      String(accepted.body.markdown ?? '') === 'Alpha beta gamma.\n',
      `Expected accepted markdown to include inserted text, got ${JSON.stringify(accepted.body.markdown)}`,
    );
    const acceptedMarks = (accepted.body.marks ?? {}) as Record<string, { kind?: string }>;
    assert(!acceptedMarks[markId], 'Expected accepted insert to be removed from the mutation response marks payload');

    const stored = db.getDocumentBySlug(slug);
    assert(stored?.markdown === 'Alpha beta gamma.\n', `Expected stored markdown to include inserted text, got ${JSON.stringify(stored?.markdown)}`);

    const batchSlug = `shared-insert-batch-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(batchSlug, 'Alpha.\nGamma.\n', {}, 'Shared insert batch accept regression');

    const firstSuggest = await executeDocumentOperationAsync(batchSlug, 'POST', '/marks/suggest-insert', {
      quote: 'Alpha',
      content: ' beta',
      by: 'ai:test',
    });
    assert(firstSuggest.status === 200, `Expected first batch insert suggestion status 200, got ${firstSuggest.status}`);

    const firstMarks = (firstSuggest.body.marks ?? {}) as Record<string, { kind?: string }>;
    const firstMarkId = Object.entries(firstMarks).find(([, mark]) => mark?.kind === 'insert')?.[0] ?? '';
    assert(firstMarkId.length > 0, 'Expected first batch insert suggestion mark id');

    const secondSuggest = await executeDocumentOperationAsync(batchSlug, 'POST', '/marks/suggest-insert', {
      quote: 'Gamma',
      content: ' delta',
      by: 'ai:test',
    });
    assert(secondSuggest.status === 200, `Expected second batch insert suggestion status 200, got ${secondSuggest.status}`);

    const secondMarks = (secondSuggest.body.marks ?? {}) as Record<string, { kind?: string }>;
    const secondMarkId = Object.keys(secondMarks).find((markId) => markId !== firstMarkId) ?? '';
    assert(secondMarkId.length > 0, 'Expected second batch insert suggestion mark id');

    const acceptedAll = await executeDocumentOperationAsync(batchSlug, 'POST', '/marks/accept-all', {
      markIds: [firstMarkId, secondMarkId],
      by: 'human:test',
    });
    assert(acceptedAll.status === 200, `Expected batch accept status 200, got ${acceptedAll.status}`);
    const acceptedAllMarkdown = String(acceptedAll.body.markdown ?? '');
    assert(
      acceptedAllMarkdown.includes('Alpha beta.'),
      `Expected batch accepted markdown to keep the first insert once, got ${JSON.stringify(acceptedAll.body.markdown)}`,
    );
    assert(
      (acceptedAllMarkdown.match(/beta/g) ?? []).length === 1,
      `Expected batch accepted markdown not to duplicate the first insert, got ${JSON.stringify(acceptedAll.body.markdown)}`,
    );
    assert(
      (acceptedAllMarkdown.match(/delta/g) ?? []).length === 1,
      `Expected batch accepted markdown not to duplicate the second insert, got ${JSON.stringify(acceptedAll.body.markdown)}`,
    );
    assert(
      (acceptedAllMarkdown.match(/Alpha\./g) ?? []).length <= 1
        && (acceptedAllMarkdown.match(/Gamma\./g) ?? []).length <= 1,
      `Expected batch accepted markdown not to duplicate the original paragraphs, got ${JSON.stringify(acceptedAll.body.markdown)}`,
    );
    const acceptedAllMarks = (acceptedAll.body.marks ?? {}) as Record<string, { kind?: string }>;
    assert(Object.keys(acceptedAllMarks).length === 0, 'Expected batch accept to clear the accepted insert marks');

    const storedBatch = db.getDocumentBySlug(batchSlug);
    const storedBatchMarkdown = String(storedBatch?.markdown ?? '');
    assert(
      (storedBatchMarkdown.match(/beta/g) ?? []).length === 1
        && (storedBatchMarkdown.match(/delta/g) ?? []).length === 1,
      `Expected stored batch markdown without duplicated accepted inserts, got ${JSON.stringify(storedBatch?.markdown)}`,
    );

    const inlineBatchSlug = `shared-inline-batch-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(
      inlineBatchSlug,
      'Hello world one two three.\n',
      {
        'inline-1': {
          kind: 'insert',
          status: 'pending',
          by: 'human:test',
          quote: ' one',
          content: ' one',
          range: { from: 12, to: 16 },
        },
        'inline-2': {
          kind: 'insert',
          status: 'pending',
          by: 'human:test',
          quote: ' two',
          content: ' two',
          range: { from: 16, to: 20 },
        },
        'inline-3': {
          kind: 'insert',
          status: 'pending',
          by: 'human:test',
          quote: ' three.',
          content: ' three.',
          range: { from: 20, to: 27 },
        },
      },
      'Shared inline insert batch accept regression',
    );

    const acceptedInlineBatch = await executeDocumentOperationAsync(inlineBatchSlug, 'POST', '/marks/accept-all', {
      markIds: ['inline-1', 'inline-2', 'inline-3'],
      by: 'human:test',
    });
    assert(acceptedInlineBatch.status === 200, `Expected inline batch accept status 200, got ${acceptedInlineBatch.status}`);
    assert(
      String(acceptedInlineBatch.body.markdown ?? '') === 'Hello world one two three.\n',
      `Expected inline batch accept not to duplicate already materialized inserts, got ${JSON.stringify(acceptedInlineBatch.body.markdown)}`,
    );
    const acceptedInlineMarks = (acceptedInlineBatch.body.marks ?? {}) as Record<string, { kind?: string }>;
    assert(Object.keys(acceptedInlineMarks).length === 0, 'Expected inline batch accept to clear all accepted insert marks');

    const storedInlineBatch = db.getDocumentBySlug(inlineBatchSlug);
    assert(
      storedInlineBatch?.markdown === 'Hello world one two three.\n',
      `Expected stored inline batch markdown without duplicated inserts, got ${JSON.stringify(storedInlineBatch?.markdown)}`,
    );

    const multiBlockBatchSlug = `shared-multiblock-batch-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(
      multiBlockBatchSlug,
      '# Untitled Tracked insertion at end.\n\nHello baseline text. Paragraph insertion.\n\nSecond paragraph baseline. Third tracked insertion here.\n',
      {
        'heading-insert': {
          kind: 'insert',
          status: 'pending',
          by: 'human:test',
          quote: 'Tracked insertion at end.',
          content: 'Tracked insertion at end.',
          range: { from: 11, to: 35 },
        },
        'paragraph-one-insert': {
          kind: 'insert',
          status: 'pending',
          by: 'human:test',
          quote: 'Paragraph insertion.',
          content: ' Paragraph insertion.',
          range: { from: 59, to: 79 },
        },
        'paragraph-two-insert': {
          kind: 'insert',
          status: 'pending',
          by: 'human:test',
          quote: 'Third tracked insertion here.',
          content: ' Third tracked insertion here.',
          range: { from: 108, to: 137 },
        },
      },
      'Shared multi-block insert batch accept regression',
    );

    const acceptedMultiBlockBatch = await executeDocumentOperationAsync(multiBlockBatchSlug, 'POST', '/marks/accept-all', {
      markIds: ['heading-insert', 'paragraph-one-insert', 'paragraph-two-insert'],
      by: 'human:test',
    });
    assert(acceptedMultiBlockBatch.status === 200, `Expected multi-block batch accept status 200, got ${acceptedMultiBlockBatch.status}`);
    assert(
      String(acceptedMultiBlockBatch.body.markdown ?? '')
        === '# Untitled Tracked insertion at end.\n\nHello baseline text. Paragraph insertion.\n\nSecond paragraph baseline. Third tracked insertion here.\n',
      `Expected multi-block batch accept not to duplicate heading inserts or bleed paragraph text, got ${JSON.stringify(acceptedMultiBlockBatch.body.markdown)}`,
    );
    const acceptedMultiBlockMarks = (acceptedMultiBlockBatch.body.marks ?? {}) as Record<string, { kind?: string }>;
    assert(Object.keys(acceptedMultiBlockMarks).length === 0, 'Expected multi-block batch accept to clear all accepted insert marks');

    const storedMultiBlockBatch = db.getDocumentBySlug(multiBlockBatchSlug);
    assert(
      storedMultiBlockBatch?.markdown === '# Untitled Tracked insertion at end.\n\nHello baseline text. Paragraph insertion.\n\nSecond paragraph baseline. Third tracked insertion here.\n',
      `Expected stored multi-block batch markdown without duplicated or garbled accepted inserts, got ${JSON.stringify(storedMultiBlockBatch?.markdown)}`,
    );

    const malformedInlineBatchSlug = `shared-malformed-inline-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(
      malformedInlineBatchSlug,
      '# Untitled\n\n Tracked insertion one.Baseline text for accept all test on build eafea47.\n\nSecond paragraph with more content here. Tracked insertion two.\n',
      {
        'paragraph-wide-insert': {
          kind: 'insert',
          status: 'pending',
          by: 'human:test',
          quote: ' Tracked insertion one.Baseline text for accept all test on build eafea47.',
          content: 'Tracked insertion one.',
          range: { from: 12, to: 84 },
        },
        'second-paragraph-insert': {
          kind: 'insert',
          status: 'pending',
          by: 'human:test',
          quote: ' Tracked insertion two.',
          content: ' Tracked insertion two.',
          range: { from: 125, to: 147 },
        },
      },
      'Shared malformed inline insert batch accept regression',
    );

    const acceptedMalformedInlineBatch = await executeDocumentOperationAsync(malformedInlineBatchSlug, 'POST', '/marks/accept-all', {
      markIds: ['paragraph-wide-insert', 'second-paragraph-insert'],
      by: 'human:test',
    });
    assert(acceptedMalformedInlineBatch.status === 200, `Expected malformed inline batch accept status 200, got ${acceptedMalformedInlineBatch.status}`);
    const acceptedMalformedInlineMarkdown = String(acceptedMalformedInlineBatch.body.markdown ?? '');
    assert(
      (acceptedMalformedInlineMarkdown.match(/Tracked insertion one\./g) ?? []).length === 1
        && (acceptedMalformedInlineMarkdown.match(/Tracked insertion two\./g) ?? []).length === 1
        && acceptedMalformedInlineMarkdown.includes('Baseline text for accept all test on build eafea47.')
        && acceptedMalformedInlineMarkdown.includes('Second paragraph with more content here.')
        && !acceptedMalformedInlineMarkdown.includes('Tracked insertion two.t')
        && !acceptedMalformedInlineMarkdown.includes('accep Tracked insertion two.'),
      `Expected malformed inline batch accept not to duplicate or bleed inline inserts, got ${JSON.stringify(acceptedMalformedInlineBatch.body.markdown)}`,
    );
    const acceptedMalformedInlineMarks = (acceptedMalformedInlineBatch.body.marks ?? {}) as Record<string, { kind?: string }>;
    assert(Object.keys(acceptedMalformedInlineMarks).length === 0, 'Expected malformed inline batch accept to clear all accepted insert marks');

    const storedMalformedInlineBatch = db.getDocumentBySlug(malformedInlineBatchSlug);
    const storedMalformedInlineMarkdown = String(storedMalformedInlineBatch?.markdown ?? '');
    assert(
      (storedMalformedInlineMarkdown.match(/Tracked insertion one\./g) ?? []).length === 1
        && (storedMalformedInlineMarkdown.match(/Tracked insertion two\./g) ?? []).length === 1
        && storedMalformedInlineMarkdown.includes('Baseline text for accept all test on build eafea47.')
        && storedMalformedInlineMarkdown.includes('Second paragraph with more content here.')
        && !storedMalformedInlineMarkdown.includes('Tracked insertion two.t')
        && !storedMalformedInlineMarkdown.includes('accep Tracked insertion two.'),
      `Expected stored malformed inline batch markdown without duplication or bleed, got ${JSON.stringify(storedMalformedInlineBatch?.markdown)}`,
    );

    const crossBlockAnchorBatchSlug = `shared-cross-block-anchor-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(
      crossBlockAnchorBatchSlug,
      '# Untitled\n\nThis is baseline paragraph one for the accept all test. It contains multiple sentences to create a realistic document.\n\nSecond paragraph with additional content for testing the batch accept functionality across multiple blocks.\n\nThird paragraph provides more content for the multi-block accept all test scenario.\n',
      {},
      'Shared cross-block anchor insert batch accept regression',
    );

    const headingSuggest = await executeDocumentOperationAsync(crossBlockAnchorBatchSlug, 'POST', '/marks/suggest-insert', {
      quote: 'Untitled',
      content: ' TC heading insertion',
      by: 'human:test',
    });
    assert(headingSuggest.status === 200, `Expected heading suggest status 200, got ${headingSuggest.status}`);

    const paragraphOneSuggest = await executeDocumentOperationAsync(crossBlockAnchorBatchSlug, 'POST', '/marks/suggest-insert', {
      quote: 'across multiple blocks.',
      content: ' TC insertion in paragraph one.',
      by: 'human:test',
    });
    assert(paragraphOneSuggest.status === 200, `Expected paragraph one suggest status 200, got ${paragraphOneSuggest.status}`);

    const paragraphTwoSuggest = await executeDocumentOperationAsync(crossBlockAnchorBatchSlug, 'POST', '/marks/suggest-insert', {
      quote: 'test scenario.',
      content: ' TC insertion in paragraph two.',
      by: 'human:test',
    });
    assert(paragraphTwoSuggest.status === 200, `Expected paragraph two suggest status 200, got ${paragraphTwoSuggest.status}`);

    const crossBlockMarks = JSON.parse(String(db.getDocumentBySlug(crossBlockAnchorBatchSlug)?.marks ?? '{}')) as Record<string, { kind?: string }>;
    const crossBlockMarkIds = Object.keys(crossBlockMarks);
    assert(crossBlockMarkIds.length === 3, `Expected three pending anchor-based insert marks, got ${crossBlockMarkIds.length}`);

    const acceptedCrossBlockBatch = await executeDocumentOperationAsync(crossBlockAnchorBatchSlug, 'POST', '/marks/accept-all', {
      markIds: crossBlockMarkIds,
      by: 'human:test',
    });
    assert(acceptedCrossBlockBatch.status === 200, `Expected cross-block anchor batch accept status 200, got ${acceptedCrossBlockBatch.status}`);
    assert(
      String(acceptedCrossBlockBatch.body.markdown ?? '')
        === '# Untitled TC heading insertion\n\nThis is baseline paragraph one for the accept all test. It contains multiple sentences to create a realistic document.\n\nSecond paragraph with additional content for testing the batch accept functionality across multiple blocks. TC insertion in paragraph one.\n\nThird paragraph provides more content for the multi-block accept all test scenario. TC insertion in paragraph two.\n',
      `Expected cross-block anchor batch accept to place each insert after its own anchor, got ${JSON.stringify(acceptedCrossBlockBatch.body.markdown)}`,
    );

    const storedCrossBlockBatch = db.getDocumentBySlug(crossBlockAnchorBatchSlug);
    assert(
      storedCrossBlockBatch?.markdown
        === '# Untitled TC heading insertion\n\nThis is baseline paragraph one for the accept all test. It contains multiple sentences to create a realistic document.\n\nSecond paragraph with additional content for testing the batch accept functionality across multiple blocks. TC insertion in paragraph one.\n\nThird paragraph provides more content for the multi-block accept all test scenario. TC insertion in paragraph two.\n',
      `Expected stored cross-block anchor batch markdown without offset drift, got ${JSON.stringify(storedCrossBlockBatch?.markdown)}`,
    );

    const materializedAnchorSeedSlug = `shared-materialized-anchor-seed-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(
      materializedAnchorSeedSlug,
      '# Run 35c Test\n\nFirst baseline paragraph for offset testing.\n\nSecond baseline for multi-block verification.\n',
      {},
      'Materialized anchor insert seed document',
    );

    const materializedHeadingSuggest = await executeDocumentOperationAsync(materializedAnchorSeedSlug, 'POST', '/marks/suggest-insert', {
      quote: 'Run 35c Test',
      content: ' TC heading edit',
      by: 'human:test',
    });
    assert(materializedHeadingSuggest.status === 200, `Expected materialized heading suggest status 200, got ${materializedHeadingSuggest.status}`);

    const materializedParagraphOneSuggest = await executeDocumentOperationAsync(materializedAnchorSeedSlug, 'POST', '/marks/suggest-insert', {
      quote: 'offset testing.',
      content: ' TC insertion in paragraph one.',
      by: 'human:test',
    });
    assert(materializedParagraphOneSuggest.status === 200, `Expected materialized paragraph one suggest status 200, got ${materializedParagraphOneSuggest.status}`);

    const materializedParagraphTwoSuggest = await executeDocumentOperationAsync(materializedAnchorSeedSlug, 'POST', '/marks/suggest-insert', {
      quote: 'verification.',
      content: ' TC insertion in paragraph two.',
      by: 'human:test',
    });
    assert(materializedParagraphTwoSuggest.status === 200, `Expected materialized paragraph two suggest status 200, got ${materializedParagraphTwoSuggest.status}`);

    const materializedAnchorMarks = JSON.parse(String(db.getDocumentBySlug(materializedAnchorSeedSlug)?.marks ?? '{}')) as Record<string, unknown>;
    const materializedAnchorSlug = `shared-materialized-anchor-${Math.random().toString(36).slice(2, 10)}`;
    const materializedAnchorMarkdown = '# Run 35c Test TC heading edit\n\nFirst baseline paragraph for offset testing. TC insertion in paragraph one.\n\nSecond baseline for multi-block verification. TC insertion in paragraph two.\n';
    db.createDocument(
      materializedAnchorSlug,
      materializedAnchorMarkdown,
      materializedAnchorMarks,
      'Shared materialized anchor insert batch accept regression',
    );

    const acceptedMaterializedAnchorBatch = await executeDocumentOperationAsync(materializedAnchorSlug, 'POST', '/marks/accept-all', {
      markIds: Object.keys(materializedAnchorMarks),
      by: 'human:test',
    });
    assert(acceptedMaterializedAnchorBatch.status === 200, `Expected materialized anchor batch accept status 200, got ${acceptedMaterializedAnchorBatch.status}`);
    assert(
      String(acceptedMaterializedAnchorBatch.body.markdown ?? '') === materializedAnchorMarkdown,
      `Expected materialized anchor batch accept not to duplicate or drift already-materialized inserts, got ${JSON.stringify(acceptedMaterializedAnchorBatch.body.markdown)}`,
    );

    const storedMaterializedAnchorBatch = db.getDocumentBySlug(materializedAnchorSlug);
    assert(
      storedMaterializedAnchorBatch?.markdown === materializedAnchorMarkdown,
      `Expected stored materialized anchor batch markdown without duplication or cross-block bleed, got ${JSON.stringify(storedMaterializedAnchorBatch?.markdown)}`,
    );

    const materializedTargetSpanSlug = `shared-materialized-target-span-${Math.random().toString(36).slice(2, 10)}`;
    const materializedTargetSpanMarkdown = [
      '# Run 36 Accept Test<span data-proof="suggestion" data-id="target-heading" data-by="human:test" data-kind="insert"> TC heading edit</span>',
      '',
      'First baseline paragraph with calculations for offset testing.<span data-proof="suggestion" data-id="target-p1" data-by="human:test" data-kind="insert"> TC insertion in paragraph one.</span>',
      '',
      'Second baseline for multi-block accept all verification.<span data-proof="suggestion" data-id="target-p2" data-by="human:test" data-kind="insert"> TC insertion in paragraph two.</span>',
      '',
    ].join('\n');
    db.createDocument(
      materializedTargetSpanSlug,
      materializedTargetSpanMarkdown,
      {
        'target-heading': {
          kind: 'insert',
          status: 'pending',
          by: 'human:test',
          quote: 'Run 36 Accept Test',
          content: ' TC heading edit',
          startRel: 'char:0',
          endRel: 'char:18',
          range: { from: 18, to: 18 },
          target: { anchor: 'Run 36 Accept Test', mode: 'normalized', occurrence: 'first' },
        },
        'target-p1': {
          kind: 'insert',
          status: 'pending',
          by: 'human:test',
          quote: 'offset testing.',
          content: ' TC insertion in paragraph one.',
          startRel: 'char:67',
          endRel: 'char:82',
          range: { from: 82, to: 82 },
          target: { anchor: 'offset testing.', mode: 'normalized', occurrence: 'first' },
        },
        'target-p2': {
          kind: 'insert',
          status: 'pending',
          by: 'human:test',
          quote: 'verification.',
          content: ' TC insertion in paragraph two.',
          startRel: 'char:127',
          endRel: 'char:140',
          range: { from: 140, to: 140 },
          target: { anchor: 'verification.', mode: 'normalized', occurrence: 'first' },
        },
      },
      'Shared materialized target insert batch accept regression',
    );

    const acceptedMaterializedTargetSpanBatch = await executeDocumentOperationAsync(materializedTargetSpanSlug, 'POST', '/marks/accept-all', {
      markIds: ['target-heading', 'target-p1', 'target-p2'],
      by: 'human:test',
    });
    assert(acceptedMaterializedTargetSpanBatch.status === 200, `Expected materialized target span batch accept status 200, got ${acceptedMaterializedTargetSpanBatch.status}`);
    assert(
      String(acceptedMaterializedTargetSpanBatch.body.markdown ?? '')
        === '# Run 36 Accept Test TC heading edit\n\nFirst baseline paragraph with calculations for offset testing. TC insertion in paragraph one.\n\nSecond baseline for multi-block accept all verification. TC insertion in paragraph two.\n',
      `Expected target-bearing materialized span batch accept not to duplicate or drift already-materialized inserts, got ${JSON.stringify(acceptedMaterializedTargetSpanBatch.body.markdown)}`,
    );

    const storedMaterializedTargetSpanBatch = db.getDocumentBySlug(materializedTargetSpanSlug);
    assert(
      storedMaterializedTargetSpanBatch?.markdown
        === '# Run 36 Accept Test TC heading edit\n\nFirst baseline paragraph with calculations for offset testing. TC insertion in paragraph one.\n\nSecond baseline for multi-block accept all verification. TC insertion in paragraph two.\n',
      `Expected stored target-bearing materialized span batch markdown without duplication or cross-block bleed, got ${JSON.stringify(storedMaterializedTargetSpanBatch?.markdown)}`,
    );

    const capturedMutationBaseSlug = `shared-captured-mutation-base-${Math.random().toString(36).slice(2, 10)}`;
    const capturedVisibleMarkdown = '# Metadata Capture TC edit\n\nBaseline paragraph one.TC p1 insert&#x20;\n\nBaseline paragraph two.TC p2 insert&#x20;\n';
    const capturedPersistedMarkdown = '# Metadata Capture<span data-proof="suggestion" data-id="m1774374800876_1" data-by="human:Test Editor" data-kind="insert"> TC edit</span>\n\nBaseline paragraph one.<span data-proof="suggestion" data-id="m1774374816542_2" data-by="human:Test Editor" data-kind="insert">TC p1 insert</span>&#x20;\n\nBaseline paragraph two.<span data-proof="suggestion" data-id="m1774374829974_3" data-by="human:Test Editor" data-kind="insert">TC p2 insert</span>&#x20;\n';
    const capturedMarks = {
      'authored:human:Test Editor:1-17': {
        kind: 'authored',
        by: 'human:Test Editor',
        createdAt: '1970-01-01T00:00:00.000Z',
        range: { from: 1, to: 17 },
        quote: 'Metadata Capture',
        startRel: 'char:0',
        endRel: 'char:16',
      },
      'authored:human:Test Editor:19-42': {
        kind: 'authored',
        by: 'human:Test Editor',
        createdAt: '1970-01-01T00:00:00.000Z',
        range: { from: 48, to: 49 },
        quote: 'e',
        startRel: 'char:46',
        endRel: 'char:47',
      },
      'authored:human:Test Editor:44-67': {
        kind: 'authored',
        by: 'human:Test Editor',
        createdAt: '1970-01-01T00:00:00.000Z',
        range: { from: 86, to: 87 },
        quote: 'o',
        startRel: 'char:83',
        endRel: 'char:84',
      },
      m1774374800876_1: {
        kind: 'insert',
        by: 'human:Test Editor',
        createdAt: '2026-03-24T17:53:20.876Z',
        status: 'pending',
        content: ' TC edit',
        range: { from: 17, to: 25 },
        startRel: 'char:16',
        endRel: 'char:24',
        quote: 'TC edit',
      },
      'authored:human:Test Editor:17-18': {
        kind: 'authored',
        by: 'human:Test Editor',
        createdAt: '1970-01-01T00:00:00.000Z',
        range: { from: 17, to: 18 },
        startRel: 'char:16',
        endRel: 'char:17',
      },
      'authored:human:Test Editor:42-43': {
        kind: 'authored',
        by: 'human:Test Editor',
        createdAt: '1970-01-01T00:00:00.000Z',
        range: { from: 47, to: 48 },
        quote: 'n',
        startRel: 'char:45',
        endRel: 'char:46',
      },
      'authored:human:Test Editor:67-68': {
        kind: 'authored',
        by: 'human:Test Editor',
        createdAt: '1970-01-01T00:00:00.000Z',
        range: { from: 85, to: 86 },
        quote: 'w',
        startRel: 'char:82',
        endRel: 'char:83',
      },
      'authored:human:Test Editor:17-19': {
        kind: 'authored',
        by: 'human:Test Editor',
        createdAt: '1970-01-01T00:00:00.000Z',
        range: { from: 18, to: 19 },
        quote: 'T',
        startRel: 'char:17',
        endRel: 'char:18',
      },
      'authored:human:Test Editor:43-44': {
        kind: 'authored',
        by: 'human:Test Editor',
        createdAt: '1970-01-01T00:00:00.000Z',
        range: { from: 46, to: 47 },
        quote: 'o',
        startRel: 'char:44',
        endRel: 'char:45',
      },
      'authored:human:Test Editor:68-69': {
        kind: 'authored',
        by: 'human:Test Editor',
        createdAt: '1970-01-01T00:00:00.000Z',
        range: { from: 84, to: 85 },
        quote: 't',
        startRel: 'char:81',
        endRel: 'char:82',
      },
      'authored:human:Test Editor:20-43': {
        kind: 'authored',
        by: 'human:Test Editor',
        createdAt: '1970-01-01T00:00:00.000Z',
        range: { from: 27, to: 46 },
        quote: 'Baseline paragraph',
        startRel: 'char:25',
        endRel: 'char:44',
      },
      'authored:human:Test Editor:45-68': {
        kind: 'authored',
        by: 'human:Test Editor',
        createdAt: '1970-01-01T00:00:00.000Z',
        range: { from: 65, to: 84 },
        quote: 'Baseline paragraph',
        startRel: 'char:62',
        endRel: 'char:81',
      },
      'authored:human:Test Editor:44-45': {
        kind: 'authored',
        by: 'human:Test Editor',
        createdAt: '1970-01-01T00:00:00.000Z',
        range: { from: 50, to: 63 },
        quote: 'TC p1 insert',
        startRel: 'char:48',
        endRel: 'char:61',
      },
      'authored:human:Test Editor:69-70': {
        kind: 'authored',
        by: 'human:Test Editor',
        createdAt: '1970-01-01T00:00:00.000Z',
        range: { from: 88, to: 101 },
        quote: 'TC p2 insert',
        startRel: 'char:85',
        endRel: 'char:98',
      },
      'authored:human:Test Editor:19-24': {
        kind: 'authored',
        by: 'human:Test Editor',
        createdAt: '1970-01-01T00:00:00.000Z',
        range: { from: 19, to: 24 },
        quote: 'C edi',
        startRel: 'char:18',
        endRel: 'char:23',
      },
      m1774374816542_2: {
        kind: 'insert',
        by: 'human:Test Editor',
        createdAt: '2026-03-24T17:53:36.542Z',
        status: 'pending',
        content: ' TC p1 insert',
        range: { from: 50, to: 63 },
        startRel: 'char:48',
        endRel: 'char:61',
        quote: 'TC p1 insert',
      },
      'authored:human:Test Editor:24-25': {
        kind: 'authored',
        by: 'human:Test Editor',
        createdAt: '1970-01-01T00:00:00.000Z',
        range: { from: 24, to: 25 },
        quote: 't',
        startRel: 'char:23',
        endRel: 'char:24',
      },
      m1774374829974_3: {
        kind: 'insert',
        by: 'human:Test Editor',
        createdAt: '2026-03-24T17:53:49.974Z',
        status: 'pending',
        content: ' TC p2 insert',
        range: { from: 88, to: 101 },
        startRel: 'char:85',
        endRel: 'char:98',
        quote: 'TC p2 insert',
      },
    } as const;

    db.createDocument(
      capturedMutationBaseSlug,
      capturedPersistedMarkdown,
      capturedMarks as unknown as Record<string, unknown>,
      'Captured mutation-base accept-all regression',
    );
    const capturedDoc = db.getDocumentBySlug(capturedMutationBaseSlug);
    assert(Boolean(capturedDoc), 'Expected captured mutation-base doc to exist');
    const acceptedCapturedMutationBase = await executeDocumentOperationAsync(
      capturedMutationBaseSlug,
      'POST',
      '/marks/accept-all',
      {
        markIds: ['m1774374800876_1', 'm1774374816542_2', 'm1774374829974_3'],
        by: 'human:test',
      },
      {
        doc: capturedDoc!,
        mutationBase: {
          token: 'mt1:captured-test',
          source: 'live_yjs',
          schemaVersion: 'mt1',
          markdown: capturedVisibleMarkdown,
          marks: capturedMarks as unknown as Record<string, unknown>,
          accessEpoch: 1,
        },
        precondition: { mode: 'revision', baseRevision: capturedDoc!.revision },
      },
    );
    assert(acceptedCapturedMutationBase.status === 200, `Expected captured mutation-base batch accept status 200, got ${acceptedCapturedMutationBase.status}`);
    assert(
      String(acceptedCapturedMutationBase.body.markdown ?? '') === capturedVisibleMarkdown,
      `Expected captured mutation-base batch accept not to duplicate already-materialized insert text, got ${JSON.stringify(acceptedCapturedMutationBase.body.markdown)}`,
    );
    const storedCapturedMutationBase = db.getDocumentBySlug(capturedMutationBaseSlug);
    assert(
      storedCapturedMutationBase?.markdown === capturedVisibleMarkdown,
      `Expected stored captured mutation-base markdown to stay identical to the authoritative visible snapshot, got ${JSON.stringify(storedCapturedMutationBase?.markdown)}`,
    );

    const capturedParagraphVisibleMarkdown = '# Mark Capture Test\n\nBaseline paragraph one for testing.TC edit one.&#x20;\n\nBaseline paragraph two for testing. TC edit two.\n';
    const capturedParagraphPersistedMarkdown = '# Mark Capture Test\n\nBaseline paragraph one for testing<span data-proof="suggestion" data-kind="insert" data-id="m1774381382005_1">TC edit one.</span>&#x20;\n\nBaseline paragraph two for testing<span data-proof="suggestion" data-kind="insert" data-id="m1774381384411_2"> TC edit two.</span>\n';
    const capturedParagraphMarks = {
      m1774381382005_1: {
        kind: 'insert',
        by: 'human:Test Editor',
        createdAt: '2026-03-24T19:43:02.006Z',
        status: 'pending',
        content: ' TC edit one.',
        range: { from: 55, to: 68 },
        startRel: 'char:53',
        endRel: 'char:66',
        quote: 'TC edit one.',
      },
      m1774381384411_2: {
        kind: 'insert',
        by: 'human:Test Editor',
        createdAt: '2026-03-24T19:43:04.411Z',
        status: 'pending',
        content: ' TC edit two.',
        range: { from: 105, to: 118 },
        startRel: 'char:102',
        endRel: 'char:115',
        quote: 'TC edit two.',
      },
    } as const;
    const capturedParagraphSlug = `captured-p1p2-${Date.now()}`;
    db.createDocument(
      capturedParagraphSlug,
      capturedParagraphPersistedMarkdown,
      capturedParagraphMarks as unknown as Record<string, unknown>,
      'Captured paragraph mutation-base accept-all regression',
    );
    const capturedParagraphDoc = db.getDocumentBySlug(capturedParagraphSlug);
    assert(Boolean(capturedParagraphDoc), 'Expected captured paragraph mutation-base doc to exist');
    const acceptedCapturedParagraph = await executeDocumentOperationAsync(
      capturedParagraphSlug,
      'POST',
      '/marks/accept-all',
      {
        markIds: ['m1774381382005_1', 'm1774381384411_2'],
        by: 'human:test',
      },
      {
        doc: capturedParagraphDoc!,
        mutationBase: {
          token: 'mt1:captured-p1p2-test',
          source: 'live_yjs',
          schemaVersion: 'mt1',
          markdown: capturedParagraphVisibleMarkdown,
          marks: capturedParagraphMarks as unknown as Record<string, unknown>,
          accessEpoch: 1,
        },
        precondition: { mode: 'revision', baseRevision: capturedParagraphDoc!.revision },
      },
    );
    assert(acceptedCapturedParagraph.status === 200, `Expected captured paragraph batch accept status 200, got ${acceptedCapturedParagraph.status}`);
    assert(
      String(acceptedCapturedParagraph.body.markdown ?? '') === capturedParagraphVisibleMarkdown,
      `Expected captured paragraph batch accept not to duplicate already-materialized insert text with mismatched content/quote whitespace, got ${JSON.stringify(acceptedCapturedParagraph.body.markdown)}`,
    );

    const run43VisibleMarkdown = '# Run 43 P1P2 Accept All Test\n\nBaseline paragraph one for testing accept all operations.TC edit one. \n\nBaseline paragraph two for multi-block verification. TC edit two.\n\n';
    const run43PersistedMarkdown = '# Run 43 P1P2 Accept All Test\n\nBaseline paragraph one for testing accept all operations<span data-proof="suggestion" data-kind="insert" data-id="m1774383326491_1">TC edit one.</span>&#x20;\n\nBaseline paragraph two for multi-block verification.<span data-proof="suggestion" data-kind="insert" data-id="m1774383335441_2"> TC edit two.</span>\n\n';
    const run43Marks = {
      m1774383326491_1: {
        kind: 'insert',
        by: 'human:Test Editor',
        status: 'pending',
        content: ' TC edit one.',
        range: { from: 87, to: 87 },
      },
      m1774383335441_2: {
        kind: 'insert',
        by: 'human:Test Editor',
        status: 'pending',
        content: ' TC edit two.',
        range: { from: 141, to: 141 },
      },
    } as const;
    const run43Slug = `captured-run43-${Date.now()}`;
    db.createDocument(
      run43Slug,
      run43PersistedMarkdown,
      run43Marks as unknown as Record<string, unknown>,
      'Captured run 43 collapsed-range accept-all regression',
    );
    const run43Doc = db.getDocumentBySlug(run43Slug);
    assert(Boolean(run43Doc), 'Expected captured run 43 doc to exist');
    const acceptedRun43 = await executeDocumentOperationAsync(
      run43Slug,
      'POST',
      '/marks/accept-all',
      {
        markIds: ['m1774383335441_2', 'm1774383326491_1'],
        by: 'human:test',
      },
      {
        doc: run43Doc!,
        mutationBase: {
          token: 'mt1:captured-run43-test',
          source: 'live_yjs',
          schemaVersion: 'mt1',
          markdown: run43VisibleMarkdown,
          marks: run43Marks as unknown as Record<string, unknown>,
          accessEpoch: 1,
        },
        precondition: { mode: 'revision', baseRevision: run43Doc!.revision },
      },
    );
    assert(acceptedRun43.status === 200, `Expected run 43 collapsed-range batch accept status 200, got ${acceptedRun43.status}`);
    assert(
      !String(acceptedRun43.body.markdown ?? '').includes('TC edit one.TC edit one.'),
      `Expected run 43 collapsed-range batch accept not to duplicate paragraph-one insert text, got ${JSON.stringify(acceptedRun43.body.markdown)}`,
    );
    assert(
      String(acceptedRun43.body.markdown ?? '').includes('Baseline paragraph one for testing accept all operations.TC edit one.'),
      `Expected run 43 collapsed-range batch accept to preserve the paragraph-one insertion text once, got ${JSON.stringify(acceptedRun43.body.markdown)}`,
    );

    console.log('document-engine-shared-insert-accept-regression.test.ts passed');
  } finally {
    if (prevDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDatabasePath;

    if (prevProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = prevProofEnv;

    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;

    if (prevDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = prevDbEnvInit;

    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
