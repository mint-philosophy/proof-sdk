import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `proof-collab-session-build-lease-${Date.now()}-${randomUUID()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');
  const ws = await import('../../server/ws.ts');

  const slug = `session-lease-${Math.random().toString(36).slice(2, 10)}`;

  try {
    db.createDocument(slug, '# Session lease\n\nBody.', {}, 'Session lease');

    const session = collab.buildCollabSession(slug, 'editor', {
      tokenId: 'access-token-1',
      wsUrlBase: 'ws://127.0.0.1:4011/ws',
    });
    assert(session, 'Expected collab session to build');

    const breakdown = ws.getActiveCollabClientBreakdown(slug);
    assert(
      breakdown.total > 0,
      'Expected collab-session creation to register an active barrier lease',
    );
    assert(
      breakdown.recentLeaseCount > 0,
      'Expected collab-session creation to register a recent bootstrap lease',
    );

    console.log('✓ buildCollabSession registers a bootstrap lease for hosted safety gates');
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
