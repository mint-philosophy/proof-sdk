import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { WebSocketServer } from 'ws';
import { getHeadlessMilkdownParser } from '../../server/milkdown-headless.js';
import { replaceLiveMarkdown } from '../shared/live-markdown.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

function normalizeWsBase(collabWsUrl: string): string {
  const raw = collabWsUrl.replace(/\?slug=.*$/, '');
  try {
    const url = new URL(raw);
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return url.toString();
  } catch {
    return raw.replace('ws://localhost:', 'ws://127.0.0.1:');
  }
}

type CreateResponse = { slug: string; ownerSecret: string };
type StateResponse = { updatedAt: string; markdown?: string; content?: string };
type EditResponse = {
  success?: boolean;
  collab?: {
    status?: string;
    reason?: string;
    markdownStatus?: string;
    fragmentStatus?: string;
    canonicalStatus?: string;
    canonicalExpectedHash?: string | null;
    canonicalObservedHash?: string | null;
  };
};
type CollabSessionResponse = {
  success: boolean;
  session: {
    collabWsUrl: string;
    slug: string;
    token: string;
    role: string;
  };
};

type SnapshotResponse = {
  revision: number;
  blocks?: Array<{ ref?: string; markdown?: string }>;
};

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.2',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

async function withHarness(
  runScenario: (ctx: {
    httpBase: string;
    created: CreateResponse;
    ydoc: Y.Doc;
    disconnectCurrentProvider: () => void;
    getLoadedDoc: (slug: string) => Y.Doc | null;
    updateDocument: (slug: string, markdown: string, marks?: Record<string, unknown>, yStateVersion?: number) => boolean;
  }) => Promise<void>,
): Promise<void> {
  const dbName = `proof-agent-edit-canonical-stability-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.AGENT_EDIT_COLLAB_STABILITY_MS = '700';
  process.env.AGENT_EDIT_COLLAB_STABILITY_SAMPLE_MS = '50';
  process.env.COLLAB_PERSIST_DEBOUNCE_MS = '5000';

  const [{ apiRoutes }, { agentRoutes }, { setupWebSocket }, collab, db] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
    import('../../server/db.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  await collab.startCollabRuntimeEmbedded(address.port);

  const createRes = await fetch(`${httpBase}/api/documents`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Agent edit canonical stability regression',
      markdown: [
        '# Canonical Stability',
        '',
        '## Notes',
        '',
        'Base paragraph',
        '',
      ].join('\n'),
      marks: {},
    }),
  });
  const created = await mustJson<CreateResponse>(createRes, 'create');

  const collabSessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
    headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
  });
  const collabSession = await mustJson<CollabSessionResponse>(collabSessionRes, 'collab-session');
  assert(collabSession.success === true, 'Expected successful collab session');

  const ydoc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: normalizeWsBase(collabSession.session.collabWsUrl),
    name: collabSession.session.slug,
    document: ydoc,
    parameters: {
      token: collabSession.session.token,
      role: collabSession.session.role,
    },
    token: collabSession.session.token,
    preserveConnection: false,
    broadcast: false,
  });
  let connected = false;
  let synced = false;
  provider.on('status', (event: { status: string }) => {
    if (event.status === 'connected') connected = true;
  });
  provider.on('synced', (event: { state?: boolean }) => {
    if (event.state !== false) synced = true;
  });
  await waitFor(() => connected && synced, 10_000, 'provider connected+synced');

  try {
    await runScenario({
      httpBase,
      created,
      ydoc,
      disconnectCurrentProvider: () => {
        try {
          provider.disconnect();
          provider.destroy();
        } catch {
          // ignore disconnect errors during scenario setup
        }
      },
      getLoadedDoc: collab.__unsafeGetLoadedDocForTests,
      updateDocument: db.updateDocument,
    });
  } finally {
    try {
      provider.disconnect();
      provider.destroy();
    } catch {
      // ignore
    }
    ydoc.destroy();
    await collab.stopCollabRuntime();
    try {
      wss.close();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore
      }
    }
  }
}

async function fetchState(httpBase: string, slug: string, secret: string): Promise<StateResponse> {
  const stateRes = await fetch(`${httpBase}/api/agent/${slug}/state`, {
    headers: { ...CLIENT_HEADERS, 'x-share-token': secret },
  });
  return mustJson<StateResponse>(stateRes, 'state');
}

async function fetchSnapshot(httpBase: string, slug: string, secret: string): Promise<SnapshotResponse> {
  const snapshotRes = await fetch(`${httpBase}/api/agent/${slug}/snapshot`, {
    headers: { ...CLIENT_HEADERS, 'x-share-token': secret },
  });
  return mustJson<SnapshotResponse>(snapshotRes, 'snapshot');
}

async function testBarrierRepairRestoresCanonicalState(): Promise<void> {
  await withHarness(async ({ httpBase, created, disconnectCurrentProvider, getLoadedDoc }) => {
    const stateBefore = await fetchState(httpBase, created.slug, created.ownerSecret);
    const snapshotBefore = await fetchSnapshot(httpBase, created.slug, created.ownerSecret);
    const baseMarkdown = typeof stateBefore.markdown === 'string' ? stateBefore.markdown : (stateBefore.content || '');
    const baseBlock = snapshotBefore.blocks?.find((block) => (block.markdown ?? '').includes('Base paragraph'));
    assert(baseBlock?.ref, 'Expected Base paragraph block ref for edit/v2 repair test');
    const marker = `API_REPAIR_${Date.now()}`;
    const parser = await getHeadlessMilkdownParser();

    disconnectCurrentProvider();
    await new Promise((resolve) => setTimeout(resolve, 120));

    let driftInterval: ReturnType<typeof setInterval> | null = null;
    const driftStarter = setTimeout(() => {
      driftInterval = setInterval(() => {
        const loadedDoc = getLoadedDoc(created.slug);
        if (!loadedDoc) return;
        replaceLiveMarkdown(loadedDoc, baseMarkdown, parser, 'canonical-stability-transient-drift');
      }, 60);
      setTimeout(() => {
        if (driftInterval) {
          clearInterval(driftInterval);
          driftInterval = null;
        }
      }, 320);
    }, 140);

    try {
      const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
        method: 'POST',
        headers: {
          ...CLIENT_HEADERS,
          'Content-Type': 'application/json',
          'x-share-token': created.ownerSecret,
        },
        body: JSON.stringify({
          by: 'ai:canonical-stability-repair-v2',
          baseRevision: snapshotBefore.revision,
          operations: [
            {
              op: 'replace_block',
              ref: baseBlock.ref,
              block: { markdown: `Base paragraph ${marker}` },
            },
          ],
        }),
      });
      assert(editRes.status === 202, `Expected fallback repair to stay pending, got HTTP ${editRes.status}`);
      const edit = await mustJson<EditResponse>(editRes, 'edit/v2');
      assert(edit.success === true, 'Expected /edit/v2 success');
      assert(edit.collab?.status === 'pending', `Expected pending collab status after unretrievable fallback, got ${String(edit.collab?.status)}`);
      assert(edit.collab?.canonicalStatus === 'confirmed', `Expected canonicalStatus=confirmed, got ${String(edit.collab?.canonicalStatus)}`);
      assert(
        edit.collab?.reason === 'live_doc_unretrievable',
        `Expected unretrievable fallback reason, got ${String(edit.collab?.reason)}`,
      );
    } finally {
      clearTimeout(driftStarter);
      if (driftInterval) clearInterval(driftInterval);
    }
  });
}

async function run(): Promise<void> {
  await testBarrierRepairRestoresCanonicalState();
  console.log('✓ agent /edit/v2 keeps unretrievable fallback repairs pending while preserving canonical success');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
