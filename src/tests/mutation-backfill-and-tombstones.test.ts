import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `proof-mutation-backfill-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  process.env.PROOF_DB_ENV_INIT = 'development';

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');

  try {
    const slug = `backfill-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(slug, '# Backfill\n\nCheck', {}, 'Backfill test');

    const sqlite = db.getDb();
    const now = new Date().toISOString();

    sqlite.prepare(`
      INSERT INTO idempotency_keys (idempotency_key, document_slug, route, response_json, request_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('legacy-only-key', slug, 'POST /rewrite', JSON.stringify({ success: true }), 'legacy-hash', now);

    const eventResult = sqlite.prepare(`
      INSERT INTO document_events (
        document_slug, document_revision, event_type, event_data, actor, idempotency_key, tombstone_revision, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(slug, 1, 'comment.added', JSON.stringify({ text: 'legacy-only-event' }), 'agent:test', null, now);
    const eventId = Number(eventResult.lastInsertRowid);

    const beforeIdempotency = sqlite.prepare(`
      SELECT COUNT(*) AS c
      FROM mutation_idempotency
      WHERE idempotency_key = ?
    `).get('legacy-only-key') as { c?: number } | undefined;
    assert(Number(beforeIdempotency?.c ?? 0) === 0, 'Expected legacy-only idempotency row before backfill');

    const beforeOutbox = sqlite.prepare(`
      SELECT COUNT(*) AS c
      FROM mutation_outbox
      WHERE event_id = ?
    `).get(eventId) as { c?: number } | undefined;
    assert(Number(beforeOutbox?.c ?? 0) === 0, 'Expected legacy-only event row before backfill');

    const idempotencyBackfill = db.backfillMutationIdempotencyBatch(100);
    const outboxBackfill = db.backfillMutationOutboxBatch(100);
    assert(idempotencyBackfill.inserted >= 1, 'Expected idempotency backfill to insert at least one row');
    assert(outboxBackfill.inserted >= 1, 'Expected outbox backfill to insert at least one row');

    const afterIdempotency = sqlite.prepare(`
      SELECT request_hash
      FROM mutation_idempotency
      WHERE idempotency_key = ? AND document_slug = ? AND route = ?
      LIMIT 1
    `).get('legacy-only-key', slug, 'POST /rewrite') as { request_hash?: string } | undefined;
    assert(afterIdempotency?.request_hash === 'legacy-hash', 'Expected backfilled mutation_idempotency row');

    const afterOutbox = sqlite.prepare(`
      SELECT event_id, event_type, document_revision
      FROM mutation_outbox
      WHERE event_id = ?
      LIMIT 1
    `).get(eventId) as { event_id?: number; event_type?: string; document_revision?: number | null } | undefined;
    assert(afterOutbox?.event_id === eventId, 'Expected backfilled mutation_outbox row');
    assert(afterOutbox?.event_type === 'comment.added', 'Expected outbox event type to match');
    assert(afterOutbox?.document_revision === 1, 'Expected outbox document revision to backfill');

    const idempotencyBackfillSecond = db.backfillMutationIdempotencyBatch(100);
    const outboxBackfillSecond = db.backfillMutationOutboxBatch(100);
    assert(idempotencyBackfillSecond.inserted === 0, 'Expected idempotency backfill to be resumable/idempotent');
    assert(outboxBackfillSecond.inserted === 0, 'Expected outbox backfill to be resumable/idempotent');

    const tombstone = db.upsertMarkTombstone(slug, 'm-1', 'rejected', 5);
    assert(tombstone.mark_id === 'm-1', 'Expected tombstone insert');
    assert(db.shouldRejectMarkMutationByResolvedRevision(slug, 'm-1', 4) === true, 'Expected replay fence to reject old revision');
    assert(db.shouldRejectMarkMutationByResolvedRevision(slug, 'm-1', 6) === false, 'Expected replay fence to allow newer revision');

    const scrubbed = db.removeResurrectedMarksFromPayload(slug, {
      'm-1': { status: 'pending', quote: 'stale' },
      'm-2': { status: 'pending', quote: 'fresh' },
      'm-3': { status: 'rejected', quote: 'terminal' },
    });
    assert(scrubbed.removed.includes('m-1'), 'Expected tombstoned pending mark to be removed');
    assert(!scrubbed.removed.includes('m-3'), 'Expected terminal mark to be retained');
    assert(scrubbed.marks['m-2'] !== undefined, 'Expected non-tombstoned mark to remain');

    const mergedFallbackMarks = collab.mergePreservedActionMarks(slug, {
      'm-1': { status: 'pending', kind: 'insert', content: ' resurrected' },
      'm-2': { status: 'pending', kind: 'insert', content: ' fresh' },
    }, { includeSuggestions: true });
    assert(mergedFallbackMarks['m-1'] === undefined, 'Expected collab fallback merge to suppress tombstoned pending suggestions');
    assert(mergedFallbackMarks['m-2'] !== undefined, 'Expected collab fallback merge to keep non-tombstoned suggestions');

    sqlite.prepare(`
      INSERT OR REPLACE INTO mark_tombstones
        (document_slug, mark_id, status, resolved_revision, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(slug, 'm-expired', 'resolved', 1, now, '2000-01-01T00:00:00.000Z');
    const cleaned = db.cleanupExpiredMarkTombstones('2001-01-01T00:00:00.000Z');
    assert(cleaned >= 1, 'Expected cleanupExpiredMarkTombstones to remove expired rows');

    console.log('✓ mutation backfill checkpoints + mark tombstone replay fencing');
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
