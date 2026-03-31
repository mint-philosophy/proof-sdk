import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mustJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text().catch(() => '');
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 500)}`);
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

async function waitForProviderReady(
  provider: HocuspocusProvider,
  label: string,
): Promise<void> {
  let connected = false;
  let synced = false;
  let authFailureReason: string | null = null;

  provider.on('status', (event: { status: string }) => {
    if (event.status === 'connected') connected = true;
  });
  provider.on('synced', (event: { state?: boolean }) => {
    if (event.state !== false) synced = true;
  });
  provider.on('authenticationFailed', (event: { reason?: string }) => {
    authFailureReason = typeof event?.reason === 'string' && event.reason.trim().length > 0
      ? event.reason
      : 'authentication-failed';
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() <= deadline) {
    if (authFailureReason) {
      throw new Error(`${label}: authentication failed: ${authFailureReason}`);
    }
    if (connected && synced) return;
    await sleep(25);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

type CreateResponse = {
  slug: string;
  ownerSecret: string;
};

type SuggestResponse = {
  marks?: Record<string, { kind?: string; content?: string }>;
};

type CollabSessionResponse = {
  success: boolean;
  session: {
    collabWsUrl: string;
    slug: string;
    token: string;
    role: string;
    accessEpoch: number;
  };
};

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.2',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

async function run(): Promise<void> {
  const dbName = `proof-collab-refresh-repeated-review-accept-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.AGENT_EDIT_COLLAB_STABILITY_MS = '500';
  process.env.AGENT_EDIT_COLLAB_STABILITY_SAMPLE_MS = '50';

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
      title: 'Repeated review accept collab refresh regression',
      markdown: 'The researcher studied the phenomenon carefully.',
      marks: {},
    }),
  });
  const created = await mustJson<CreateResponse>(createRes, 'create');

  let provider: HocuspocusProvider | null = null;
  let ydoc: Y.Doc | null = null;

  const connectWithSession = async (
    session: CollabSessionResponse['session'],
    label: string,
  ): Promise<void> => {
    ydoc = new Y.Doc();
    provider = new HocuspocusProvider({
      url: normalizeWsBase(session.collabWsUrl),
      name: session.slug,
      document: ydoc,
      parameters: {
        token: session.token,
        role: session.role,
      },
      token: session.token,
      preserveConnection: false,
      broadcast: false,
    });
    await waitForProviderReady(provider, label);
  };

  const disconnectProvider = (): void => {
    if (provider) {
      try {
        provider.disconnect();
        provider.destroy();
      } catch {
        // ignore
      }
      provider = null;
    }
    if (ydoc) {
      ydoc.destroy();
      ydoc = null;
    }
  };

  try {
    const initialSessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const initialSession = await mustJson<CollabSessionResponse>(initialSessionRes, 'initial collab-session');
    assert(initialSession.success === true, 'Expected initial collab session');
    await connectWithSession(initialSession.session, 'initial collab session');

    const reviewCycles = [
      { from: 'phenomenon', to: 'behavior' },
      { from: 'behavior', to: 'pattern' },
      { from: 'pattern', to: 'trend' },
      { from: 'trend', to: 'signal' },
    ];

    for (let index = 0; index < reviewCycles.length; index += 1) {
      const cycle = reviewCycles[index];
      const cycleLabel = `cycle ${index + 1}`;

      const suggestRes = await fetch(`${httpBase}/api/agent/${created.slug}/marks/suggest-replace`, {
        method: 'POST',
        headers: {
          ...CLIENT_HEADERS,
          'Content-Type': 'application/json',
          'x-share-token': created.ownerSecret,
        },
        body: JSON.stringify({
          quote: cycle.from,
          content: cycle.to,
          by: 'ai:test',
        }),
      });
      assert(suggestRes.ok, `${cycleLabel}: expected suggest-replace ok, got HTTP ${suggestRes.status}`);
      const suggestPayload = await mustJson<SuggestResponse>(suggestRes, `${cycleLabel} suggest`);
      const suggestionId = Object.entries(suggestPayload.marks ?? {}).find(([, mark]) => mark?.kind === 'replace')?.[0] ?? '';
      assert(suggestionId.length > 0, `${cycleLabel}: expected replace suggestion id`);

      const acceptRes = await fetch(`${httpBase}/api/agent/${created.slug}/marks/accept`, {
        method: 'POST',
        headers: {
          ...CLIENT_HEADERS,
          'Content-Type': 'application/json',
          'x-share-token': created.ownerSecret,
        },
        body: JSON.stringify({
          markId: suggestionId,
          by: 'human:editor',
        }),
      });
      const acceptPayload = await mustJson<{ success?: boolean }>(acceptRes, `${cycleLabel} accept`);
      assert(acceptPayload.success === true, `${cycleLabel}: expected accept success`);

      const refreshPromise = fetch(`${httpBase}/api/documents/${created.slug}/collab-refresh`, {
        method: 'POST',
        headers: {
          ...CLIENT_HEADERS,
          'x-share-token': created.ownerSecret,
        },
      });

      disconnectProvider();

      const refreshRes = await refreshPromise;
      const refreshedSession = await mustJson<CollabSessionResponse>(refreshRes, `${cycleLabel} collab-refresh`);
      assert(refreshedSession.success === true, `${cycleLabel}: expected refreshed collab session`);

      await sleep(1_400);
      await connectWithSession(refreshedSession.session, `${cycleLabel} refreshed collab session`);

      const liveMarkdown = ydoc?.getText('markdown').toString() ?? '';
      assert(
        liveMarkdown.includes(cycle.to),
        `${cycleLabel}: expected refreshed collab session to contain ${JSON.stringify(cycle.to)}, got ${JSON.stringify(liveMarkdown)}`,
      );
      assert(
        !liveMarkdown.includes(cycle.from),
        `${cycleLabel}: expected refreshed collab session to drop ${JSON.stringify(cycle.from)}, got ${JSON.stringify(liveMarkdown)}`,
      );
    }

    const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const state = await mustJson<{ markdown?: string; content?: string }>(stateRes, 'final state');
    const markdown = typeof state.markdown === 'string' ? state.markdown : (state.content ?? '');
    assert(markdown.includes('signal'), `Expected final canonical markdown to include "signal", got ${JSON.stringify(markdown)}`);
    assert(!markdown.includes('phenomenon'), `Expected final canonical markdown to drop the original word, got ${JSON.stringify(markdown)}`);

    console.log('✓ repeated review accepts keep collab-refresh session tokens valid across four reconnect cycles');
  } finally {
    disconnectProvider();
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

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
