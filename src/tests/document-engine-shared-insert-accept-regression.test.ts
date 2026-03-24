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
