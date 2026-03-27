import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { AddressInfo } from 'node:net';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const next = haystack.indexOf(needle, idx);
    if (next === -1) return count;
    count += 1;
    idx = next + needle.length;
  }
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

const DEFAULT_TIMEOUT_MS = 10_000;

type ShareCreateResponse = {
  slug: string;
  ownerSecret: string;
};

type CollabSessionPayload = {
  success: boolean;
  session: {
    slug: string;
    collabWsUrl: string;
    token: string;
    role: 'viewer' | 'commenter' | 'editor' | 'owner_bot';
  };
};

type ShareDocumentResponse = {
  slug: string;
  markdown: string;
};

type AgentStateResponse = {
  success: boolean;
  updatedAt: string;
  revision: number;
};

type EditResponse = {
  success?: boolean;
  revision?: number;
  collab?: {
    status?: string;
    yStateVersion?: number;
  };
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

async function run(): Promise<void> {
  const dbName = `proof-agent-edit-collab-propagates-${Date.now()}-${randomUUID()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.AGENT_EDIT_V2_ENABLED = '1';

  const [{ apiRoutes }, { agentRoutes }, { setupWebSocket }, collab] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  await collab.startCollabRuntimeEmbedded(address.port);

  let provider: HocuspocusProvider | null = null;
  let reconnectProvider: HocuspocusProvider | null = null;
  const ydoc = new Y.Doc();
  let reconnectDoc: Y.Doc | null = null;
  let connected = false;
  let synced = false;

  try {
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: '# Title\n\n## Notes\n\nOriginal.\n',
        marks: {},
        title: 'Agent edit propagation',
      }),
    });
    const created = await mustJson<ShareCreateResponse>(createRes);
    assert(typeof created.slug === 'string' && created.slug.length > 0, 'Expected create response slug');
    assert(typeof created.ownerSecret === 'string' && created.ownerSecret.length > 0, 'Expected create response ownerSecret');

    const sessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const sessionPayload = await mustJson<CollabSessionPayload>(sessionRes);
    assert(sessionPayload.success === true, 'Expected collab-session success');

    const wsUrl = (() => {
      const raw = sessionPayload.session.collabWsUrl.replace(/\?slug=.*$/, '');
      try {
        const url = new URL(raw);
        if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
        return url.toString();
      } catch {
        return raw.replace('ws://localhost:', 'ws://127.0.0.1:');
      }
    })();
    assert(wsUrl.includes('/ws'), `Expected collab wsUrl to include /ws, got ${wsUrl}`);

    provider = new HocuspocusProvider({
      url: wsUrl,
      name: created.slug,
      document: ydoc,
      parameters: { token: sessionPayload.session.token, role: sessionPayload.session.role },
      token: sessionPayload.session.token,
      preserveConnection: false,
      broadcast: false,
    });

    provider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') connected = true;
    });
    provider.on('synced', (event: { state?: boolean }) => {
      const state = event?.state;
      if (state !== false) synced = true;
    });

    await waitFor(() => connected, DEFAULT_TIMEOUT_MS, 'provider connected');
    await waitFor(() => synced, DEFAULT_TIMEOUT_MS, 'provider synced');

    const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const statePayload = await mustJson<AgentStateResponse>(stateRes);
    assert(typeof statePayload.updatedAt === 'string' && statePayload.updatedAt.length > 0, 'Expected updatedAt');
    assert(Number.isInteger(statePayload.revision) && statePayload.revision > 0, 'Expected revision');

    const appendText = `APPENDED-${randomUUID()}`;
    const idempotencyKey = `agent-edit-collab-propagates-${Date.now()}`;
    const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
        'x-idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        by: 'ai:test',
        baseRevision: statePayload.revision,
        operations: [
          { op: 'insert_after', ref: 'b3', blocks: [{ markdown: appendText }] },
        ],
      }),
    });
    const editPayload = await mustJson<EditResponse>(editRes);
    assert(editPayload.success === true, `Expected agent edit v2 success, got HTTP ${editRes.status}`);
    assert(Number.isInteger(editPayload.revision) && (editPayload.revision as number) > statePayload.revision, 'Expected revision to advance');
    assert(editPayload.collab?.status === 'confirmed', `Expected confirmed collab status, got ${String(editPayload.collab?.status)}`);
    assert(Number.isInteger(editPayload.collab?.yStateVersion) && (editPayload.collab?.yStateVersion as number) > 0, 'Expected collab yStateVersion');

    await waitFor(() => ydoc.getText('markdown').toString().includes(appendText), DEFAULT_TIMEOUT_MS, 'collab ydoc includes appended text');

    // Ensure the projection is stable (not overwritten by stale collab persistence).
    await sleep(500);

    const docRes = await fetch(`${httpBase}/api/documents/${created.slug}`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const docJson = await mustJson<ShareDocumentResponse>(docRes);
    assert(docJson.markdown.includes(appendText), 'Expected DB markdown projection to include appended text');

    assert(countOccurrences(docJson.markdown, appendText) === 1, 'Expected appended text to appear exactly once in DB projection');
    assert(countOccurrences(ydoc.getText('markdown').toString(), appendText) === 1, 'Expected appended text to appear exactly once in collab ydoc');

    const stabilityDeadline = Date.now() + 3_000;
    while (Date.now() < stabilityDeadline) {
      await sleep(100);
      const stateResStable = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
      });
      const stable = await mustJson<{ markdown?: string; content?: string }>(stateResStable);
      const stableMarkdown = typeof stable.markdown === 'string' ? stable.markdown : (stable.content || '');
      assert(stableMarkdown.includes(appendText), 'Expected append text to remain stable in canonical markdown');
      assert(!stableMarkdown.includes(`${appendText}${appendText}`), 'Expected no duplicated append text in canonical markdown');
    }

    const reconnectSessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const reconnectSession = await mustJson<CollabSessionPayload>(reconnectSessionRes);
    reconnectDoc = new Y.Doc();
    reconnectProvider = new HocuspocusProvider({
      url: normalizeWsBase(reconnectSession.session.collabWsUrl),
      name: reconnectSession.session.slug,
      document: reconnectDoc,
      parameters: { token: reconnectSession.session.token, role: reconnectSession.session.role },
      token: reconnectSession.session.token,
      preserveConnection: false,
      broadcast: false,
    });

    let reconnectConnected = false;
    let reconnectSynced = false;
    reconnectProvider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') reconnectConnected = true;
    });
    reconnectProvider.on('synced', (event: { state?: boolean }) => {
      if (event.state !== false) reconnectSynced = true;
    });

    await waitFor(() => reconnectConnected, DEFAULT_TIMEOUT_MS, 'reconnect provider connected');
    await waitFor(() => reconnectSynced, DEFAULT_TIMEOUT_MS, 'reconnect provider synced');
    await waitFor(
      () => reconnectDoc?.getText('markdown').toString().includes(appendText) === true,
      DEFAULT_TIMEOUT_MS,
      'reconnect collab doc includes appended text',
    );

    console.log('✓ agent /edit/v2 mutations propagate to active collab sessions and persist');
  } finally {
    try {
      provider?.disconnect();
      provider?.destroy();
      try {
        (provider as any)?.configuration?.websocketProvider?.destroy?.();
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
    try {
      reconnectProvider?.disconnect();
      reconnectProvider?.destroy();
      try {
        (reconnectProvider as any)?.configuration?.websocketProvider?.destroy?.();
      } catch {
        // ignore
      }
    } catch {
      // ignore provider shutdown errors
    }
    ydoc.destroy();
    reconnectDoc?.destroy();
    try {
      wss.close();
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
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
