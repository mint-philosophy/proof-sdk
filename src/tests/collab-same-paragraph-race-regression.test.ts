import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocketServer } from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index < haystack.length) {
    const next = haystack.indexOf(needle, index);
    if (next < 0) break;
    count += 1;
    index = next + needle.length;
  }
  return count;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

type ShareCreateResponse = { slug: string; ownerSecret: string };
type CollabSessionResponse = {
  success: boolean;
  session: {
    collabWsUrl: string;
    slug: string;
    token: string;
    role: string;
  };
};
type AgentStateResponse = {
  markdown?: string;
  content?: string;
};

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.2',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

async function mustJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text().catch(() => '');
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

async function run(): Promise<void> {
  const dbName = `proof-collab-same-paragraph-race-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';

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

  const providerADoc = new Y.Doc();
  const providerBDoc = new Y.Doc();
  let providerA: HocuspocusProvider | null = null;
  let providerB: HocuspocusProvider | null = null;
  let providerAConnected = false;
  let providerBConnected = false;
  let providerASynced = false;
  let providerBSynced = false;

  try {
    const initialMarkdown = [
      '# Typing Core',
      '',
      '## Paragraph A',
      '',
      'Alpha paragraph for shared typing collisions.',
      '',
      '## Notes',
      '',
      'Keep this section for append operations.',
      '',
    ].join('\n');

    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Same paragraph race regression',
        markdown: initialMarkdown,
        marks: {},
      }),
    });
    const created = await mustJson<ShareCreateResponse>(createRes, 'create');

    const [sessionARes, sessionBRes] = await Promise.all([
      fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
      }),
      fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
      }),
    ]);
    const sessionA = await mustJson<CollabSessionResponse>(sessionARes, 'collab-session A');
    const sessionB = await mustJson<CollabSessionResponse>(sessionBRes, 'collab-session B');
    assert(sessionA.success === true && sessionB.success === true, 'Expected successful collab sessions');

    providerA = new HocuspocusProvider({
      url: normalizeWsBase(sessionA.session.collabWsUrl),
      name: sessionA.session.slug,
      document: providerADoc,
      parameters: { token: sessionA.session.token, role: sessionA.session.role },
      token: sessionA.session.token,
      preserveConnection: false,
      broadcast: false,
    });
    providerB = new HocuspocusProvider({
      url: normalizeWsBase(sessionB.session.collabWsUrl),
      name: sessionB.session.slug,
      document: providerBDoc,
      parameters: { token: sessionB.session.token, role: sessionB.session.role },
      token: sessionB.session.token,
      preserveConnection: false,
      broadcast: false,
    });

    providerA.on('status', (event: { status: string }) => {
      if (event.status === 'connected') providerAConnected = true;
    });
    providerB.on('status', (event: { status: string }) => {
      if (event.status === 'connected') providerBConnected = true;
    });
    providerA.on('synced', (event: { state?: boolean }) => {
      if (event.state !== false) providerASynced = true;
    });
    providerB.on('synced', (event: { state?: boolean }) => {
      if (event.state !== false) providerBSynced = true;
    });

    await waitFor(() => providerAConnected && providerBConnected, 10_000, 'providers connected');
    await waitFor(() => providerASynced && providerBSynced, 10_000, 'providers synced');

    const baseText = providerADoc.getText('markdown').toString();
    const anchor = 'Alpha paragraph for shared typing collisions.';
    const insertAt = baseText.indexOf(anchor) + anchor.length;
    assert(insertAt > anchor.length, 'Expected shared paragraph anchor in provider doc');

    const markerA = ` A${Date.now()}`;
    const markerB = ` B${Date.now()}`;

    providerADoc.getText('markdown').insert(insertAt, markerA);
    providerBDoc.getText('markdown').insert(insertAt, markerB);

    await waitFor(() => {
      const markdownA = providerADoc.getText('markdown').toString();
      const markdownB = providerBDoc.getText('markdown').toString();
      return markdownA.includes(markerA.trim()) && markdownA.includes(markerB.trim())
        && markdownB.includes(markerA.trim()) && markdownB.includes(markerB.trim());
    }, 10_000, 'providers converge with both markers');

    await waitForAsync(async () => {
      const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
      });
      const state = await mustJson<AgentStateResponse>(stateRes, 'state');
      const markdown = typeof state.markdown === 'string' ? state.markdown : (state.content || '');
      return markdown.includes(markerA.trim()) && markdown.includes(markerB.trim());
    }, 10_000, 'canonical state contains both markers');

    const finalStateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const finalState = await mustJson<AgentStateResponse>(finalStateRes, 'final state');
    const finalMarkdown = typeof finalState.markdown === 'string' ? finalState.markdown : (finalState.content || '');

    assert(countOccurrences(finalMarkdown, markerA.trim()) === 1, `Expected markerA once, got markdown=${finalMarkdown}`);
    assert(countOccurrences(finalMarkdown, markerB.trim()) === 1, `Expected markerB once, got markdown=${finalMarkdown}`);

    console.log('✓ same-paragraph concurrent collab typing persists each marker once');
  } finally {
    try {
      providerA?.disconnect();
      providerA?.destroy();
      (providerA as any)?.configuration?.websocketProvider?.destroy?.();
    } catch {
      // ignore cleanup errors
    }
    try {
      providerB?.disconnect();
      providerB?.destroy();
      (providerB as any)?.configuration?.websocketProvider?.destroy?.();
    } catch {
      // ignore cleanup errors
    }
    await sleep(50);
    providerADoc.destroy();
    providerBDoc.destroy();
    await collab.stopCollabRuntime();
    try {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          // ignore cleanup errors
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    } catch {
      // ignore cleanup errors
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
