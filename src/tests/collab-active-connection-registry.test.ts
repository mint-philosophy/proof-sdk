import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `proof-active-collab-registry-${Date.now()}-${randomUUID()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const ws = await import('../../server/ws.ts');

  const slug = `active-collab-${Math.random().toString(36).slice(2, 10)}`;

  try {
    db.createDocument(slug, '# Active collab registry\n\nBody.', {}, 'Active collab registry');

    assert(ws.getActiveCollabClientCount(slug) === 0, `Expected no active collab clients for ${slug}`);

    db.upsertActiveCollabConnection({
      connectionId: 'remote-live-1',
      slug,
      role: 'viewer',
      accessEpoch: 0,
      instanceId: 'remote-instance-a',
    });

    assert(
      ws.getActiveCollabClientCount(slug) === 1,
      `Expected shared active collab registry to count remote live client for ${slug}`,
    );

    db.upsertActiveCollabConnection({
      connectionId: 'remote-stale-1',
      slug,
      role: 'viewer',
      accessEpoch: 0,
      instanceId: 'remote-instance-b',
      observedAt: new Date(Date.now() - 120_000).toISOString(),
    });

    assert(
      ws.getActiveCollabClientCount(slug) === 1,
      `Expected stale shared collab lease to be ignored for ${slug}`,
    );

    const nextEpoch = db.bumpDocumentAccessEpoch(slug);
    assert(typeof nextEpoch === 'number' && nextEpoch === 1, `Expected access epoch bump to 1, got ${String(nextEpoch)}`);

    const breakdown = ws.getActiveCollabClientBreakdown(slug);
    assert(breakdown.exactEpochCount === 0, `Expected exactEpochCount=0 after epoch bump, got ${breakdown.exactEpochCount}`);
    assert(breakdown.anyEpochCount === 1, `Expected stale anyEpochCount diagnostics after epoch bump, got ${JSON.stringify(breakdown)}`);
    assert(
      ws.getActiveCollabClientCount(slug) === 0,
      `Expected stale prior-epoch live leases not to block fresh writes for ${slug}`,
    );

    console.log('✓ active collab client count ignores stale prior-epoch leases while preserving diagnostics');
  } finally {
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
