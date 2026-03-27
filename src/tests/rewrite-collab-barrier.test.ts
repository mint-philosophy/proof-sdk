import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

type ShareCreateResponse = {
  slug: string;
  ownerSecret: string;
};

type AgentSnapshotResponse = {
  success: boolean;
  revision: number;
  blocks?: Array<{ ref?: string; markdown?: string }>;
};

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

async function mustJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  return JSON.parse(text) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const dbName = `proof-rewrite-collab-barrier-${Date.now()}-${randomUUID()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';

  const [{ apiRoutes }, { agentRoutes }, { bridgeRouter }, { setupWebSocket }, collab, db] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/bridge.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
    import('../../server/db.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);
  app.use('/d/:slug/bridge', bridgeRouter);

  const server = createServer(app);
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;
  await collab.startCollabRuntimeEmbedded(address.port);

  try {
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: '# Rewrite barrier\n\nInitial.',
        marks: {},
        title: 'Rewrite barrier',
      }),
    });
    const created = await mustJson<ShareCreateResponse>(createRes);
    assert(typeof created.slug === 'string' && created.slug.length > 0, 'Expected slug');
    assert(typeof created.ownerSecret === 'string' && created.ownerSecret.length > 0, 'Expected owner secret');

    const getAccessEpoch = (): number => {
      const auth = db.getDocumentAuthStateBySlug(created.slug);
      const accessEpoch = auth?.access_epoch;
      assert(typeof accessEpoch === 'number' && Number.isFinite(accessEpoch), 'Expected numeric accessEpoch in document auth state');
      return accessEpoch;
    };

    const getBaseRevision = async (): Promise<number> => {
      const snapshotRes = await fetch(`${httpBase}/api/agent/${created.slug}/snapshot`, {
        headers: {
          ...CLIENT_HEADERS,
          'x-share-token': created.ownerSecret,
        },
      });
      const snapshot = await mustJson<AgentSnapshotResponse>(snapshotRes);
      assert(
        typeof snapshot.revision === 'number' && Number.isFinite(snapshot.revision),
        'Expected numeric revision from /api/agent/:slug/snapshot',
      );
      return snapshot.revision;
    };

    const rewriteViaDocumentsOps = await fetch(`${httpBase}/api/documents/${created.slug}/ops`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        type: 'rewrite.apply',
        baseRevision: await getBaseRevision(),
        content: '# Rewrite barrier\n\nAfter documents ops.',
      }),
    });
    await mustJson<{ success: boolean }>(rewriteViaDocumentsOps);

    const epochAfterDocumentsOps = getAccessEpoch();
    assert(
      epochAfterDocumentsOps >= 1,
      `Expected /documents ops rewrite to bump accessEpoch above the initial epoch, got ${epochAfterDocumentsOps}`,
    );

    const rewriteViaAgentOps = await fetch(`${httpBase}/api/agent/${created.slug}/ops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        op: 'rewrite.apply',
        baseRevision: await getBaseRevision(),
        content: '# Rewrite barrier\n\nAfter agent ops.',
      }),
    });
    await mustJson<{ success: boolean }>(rewriteViaAgentOps);

    const epochAfterAgentOps = getAccessEpoch();
    assert(
      epochAfterAgentOps > epochAfterDocumentsOps,
      `Expected accessEpoch bump after /agent ops rewrite (${epochAfterDocumentsOps} -> ${epochAfterAgentOps})`,
    );

    const rewriteViaAgentRoute = await fetch(`${httpBase}/api/agent/${created.slug}/rewrite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        baseRevision: await getBaseRevision(),
        content: '# Rewrite barrier\n\nAfter agent rewrite route.',
      }),
    });
    await mustJson<{ success: boolean }>(rewriteViaAgentRoute);

    const epochAfterAgentRewriteRoute = getAccessEpoch();
    assert(
      epochAfterAgentRewriteRoute > epochAfterAgentOps,
      `Expected accessEpoch bump after /agent rewrite (${epochAfterAgentOps} -> ${epochAfterAgentRewriteRoute})`,
    );

    const snapshotBeforeEditV2Res = await fetch(`${httpBase}/api/agent/${created.slug}/snapshot`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const snapshotBeforeEditV2 = await mustJson<AgentSnapshotResponse>(snapshotBeforeEditV2Res);
    assert(snapshotBeforeEditV2.success === true, 'Expected edit v2 snapshot success');
    assert(
      typeof snapshotBeforeEditV2.revision === 'number' && Number.isFinite(snapshotBeforeEditV2.revision),
      'Expected numeric snapshot revision for edit v2 request',
    );

    const editV2Res = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:test',
        baseRevision: snapshotBeforeEditV2.revision,
        operations: [
          { op: 'replace_block', ref: 'b2', block: { markdown: 'After edit v2 barrier.' } },
        ],
      }),
    });
    const editV2Body = await mustJson<{
      success: boolean;
      snapshot?: AgentSnapshotResponse;
    }>(editV2Res);
    const editV2Snapshot = editV2Body.snapshot;
    assert(editV2Snapshot?.revision === snapshotBeforeEditV2.revision + 1, 'Expected edit/v2 to increment revision by exactly 1');
    assert((editV2Snapshot?.blocks?.length ?? 0) === 2, 'Expected edit/v2 structural edit to preserve block count');

    const epochAfterAgentEditV2 = getAccessEpoch();
    assert(
      epochAfterAgentEditV2 > epochAfterAgentRewriteRoute,
      `Expected /agent edit v2 strict live-doc mutation to bump accessEpoch (${epochAfterAgentRewriteRoute} -> ${epochAfterAgentEditV2})`,
    );

    const putRes = await fetch(`${httpBase}/api/documents/${created.slug}`, {
      method: 'PUT',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        markdown: '# Rewrite barrier\n\nAfter PUT markdown barrier.',
      }),
    });
    await mustJson<{ success: boolean }>(putRes);

    const epochAfterPut = getAccessEpoch();
    assert(
      epochAfterPut > epochAfterAgentEditV2,
      `Expected accessEpoch bump after PUT /documents/:slug (${epochAfterAgentEditV2} -> ${epochAfterPut})`,
    );

    const bridgeRewriteRes = await fetch(`${httpBase}/d/${created.slug}/bridge/rewrite`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-bridge-token': created.ownerSecret,
      },
      body: JSON.stringify({
        baseRevision: await getBaseRevision(),
        content: '# Rewrite barrier\n\nAfter bridge rewrite barrier.',
      }),
    });
    await mustJson<{ success: boolean }>(bridgeRewriteRes);

    const epochAfterBridgeRewrite = getAccessEpoch();
    assert(
      epochAfterBridgeRewrite > epochAfterPut,
      `Expected accessEpoch bump after bridge rewrite (${epochAfterPut} -> ${epochAfterBridgeRewrite})`,
    );

    console.log('✓ rewrite routes and strict live-doc mutations enforce collab epoch barriers consistently');
  } finally {
    await sleep(50);
    try {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await collab.stopCollabRuntime();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
