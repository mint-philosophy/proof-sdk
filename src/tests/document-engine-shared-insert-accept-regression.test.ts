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
