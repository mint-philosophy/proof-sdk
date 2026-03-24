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
