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

type AgentStateResponse = {
  success: boolean;
  updatedAt: string;
  revision: number;
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
  const dbName = `proof-agent-presence-${Date.now()}-${randomUUID()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.AGENT_PRESENCE_TTL_MS = '500';
  process.env.AGENT_CURSOR_TTL_MS = '120';
  process.env.AGENT_EDIT_V2_ENABLED = '1';
  process.env.COLLAB_PERSIST_DEBOUNCE_MS = '80';

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
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  await collab.startCollabRuntimeEmbedded(address.port);

  let provider: HocuspocusProvider | null = null;
  const ydoc = new Y.Doc();
  let connected = false;
  let synced = false;

  try {
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: '# Title\n\n## Notes\n\nOriginal.\n',
        marks: {},
        title: 'Agent presence coupling',
      }),
    });
    const created = await mustJson<ShareCreateResponse>(createRes);
    assert(created.slug.length > 0, 'Expected create response slug');
    assert(created.ownerSecret.length > 0, 'Expected create response ownerSecret');
    const baselineYStateVersion = db.getDocumentBySlug(created.slug)?.y_state_version ?? 0;

    const sessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const sessionPayload = await mustJson<CollabSessionPayload>(sessionRes);
    assert(sessionPayload.success === true, 'Expected collab-session success');

    const wsUrl = (() => {
      const raw = sessionPayload.session.collabWsUrl.replace(/\\?slug=.*$/, '');
      try {
        const url = new URL(raw);
        if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
        return url.toString();
      } catch {
        return raw.replace('ws://localhost:', 'ws://127.0.0.1:');
      }
    })();

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

    const presenceMap: any = ydoc.getMap('agentPresence');
    const cursorMap: any = ydoc.getMap('agentCursors');
    const hasPresenceWithName = (name: string): boolean => {
      let found = false;
      presenceMap.forEach((entry: any) => {
        if (entry?.name === name) found = true;
      });
      return found;
    };
    const assertNoAgentLeak = (id: string, label: string): void => {
      assert(!presenceMap.get(id), `Expected no leaked presence for ${label}`);
      assert(!cursorMap.get(id), `Expected no leaked cursor for ${label}`);
    };

    assert(presenceMap.size === 0, 'Expected agentPresence to start empty');

    const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
        'x-agent-id': 'state-probe',
      },
    });
    const statePayload = await mustJson<AgentStateResponse>(stateRes);
    assert(typeof statePayload.updatedAt === 'string' && statePayload.updatedAt.length > 0, 'Expected updatedAt');

    await waitFor(() => Boolean(presenceMap.get('ai:state-probe')), DEFAULT_TIMEOUT_MS, 'state auto-presence appears');
    const statePresence = presenceMap.get('ai:state-probe') as any;
    assert(statePresence?.name === 'State Probe', 'Expected state auto-presence to derive title-cased name');
    assert(statePresence?.status === 'active', 'Expected state auto-presence status to be active');
    const persistQuietDeadline = Date.now() + 240;
    await waitFor(
      () => Date.now() >= persistQuietDeadline
        && (db.getDocumentBySlug(created.slug)?.y_state_version ?? 0) === baselineYStateVersion,
      DEFAULT_TIMEOUT_MS,
      'state auto-presence avoids bumping persisted Yjs version',
    );

    const claudeStateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
        'user-agent': 'Claude-Test-Agent/1.0',
      },
    });
    assert(claudeStateRes.ok, `Expected Claude state probe to succeed, got HTTP ${claudeStateRes.status}`);
    await sleep(100);
    assert(!hasPresenceWithName('Claude'), 'Expected state read without explicit identity to avoid auto-presence');

    const clawStateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
        'user-agent': 'Claw-Test-Agent/1.0',
      },
    });
    assert(clawStateRes.ok, `Expected Claw state probe to succeed, got HTTP ${clawStateRes.status}`);
    await waitFor(() => {
      let found = false;
      presenceMap.forEach((entry: any) => {
        if (typeof entry?.id === 'string' && entry.id.startsWith('ai:auto-') && entry?.name === 'AI collaborator') {
          found = true;
        }
      });
      return found;
    }, DEFAULT_TIMEOUT_MS, 'provisional auto presence appears');

    let provisionalAutoId: string | null = null;
    presenceMap.forEach((entry: any, key: string) => {
      if (typeof key === 'string' && key.startsWith('ai:auto-') && entry?.name === 'AI collaborator') {
        provisionalAutoId = key;
      }
    });
    assert(typeof provisionalAutoId === 'string' && provisionalAutoId.length > 0, 'Expected provisional auto agent id');

    const appendText = `APPENDED-${randomUUID()}`;
    const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
        'x-agent-id': 'r2c2',
        'user-agent': 'Claw-Test-Agent/1.0',
      },
      body: JSON.stringify({
        by: 'ai:r2c2',
        name: 'R2C2',
        color: '#38bdf8',
        baseRevision: statePayload.revision,
        operations: [
          { op: 'insert_after', ref: 'b3', blocks: [{ markdown: appendText }] },
        ],
      }),
    });
    assert(editRes.ok, `Expected agent edit v2 to succeed, got HTTP ${editRes.status}`);

    await waitFor(() => Boolean(presenceMap.get('ai:r2c2')), DEFAULT_TIMEOUT_MS, 'presence appears');
    const presence = presenceMap.get('ai:r2c2') as any;
    assert(presence?.name === 'R2C2', 'Expected presence name to be R2C2');
    assert(presence?.status === 'editing', 'Expected presence status to be editing');
    assert(!presenceMap.get(provisionalAutoId!), 'Expected provisional auto presence to be removed after named agent joins');
    let r2c2Count = 0;
    presenceMap.forEach((entry: any) => {
      if (entry?.name === 'R2C2') r2c2Count += 1;
    });
    assert(r2c2Count === 1, `Expected exactly one R2C2 presence entry, got ${r2c2Count}`);

    const agentCommentRes = await fetch(`${httpBase}/api/agent/${created.slug}/ops`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
        'x-agent-id': 'r2c2',
      },
      body: JSON.stringify({
        type: 'comment.add',
        by: 'ai:r2c2',
        quote: appendText,
        text: 'Track the appended note',
      }),
    });
    assert(agentCommentRes.ok, `Expected agent comment to succeed, got HTTP ${agentCommentRes.status}`);

    await waitFor(() => Boolean(cursorMap.get('ai:r2c2')), DEFAULT_TIMEOUT_MS, 'cursor hint appears');
    const hint = cursorMap.get('ai:r2c2') as any;
    assert(typeof hint?.quote === 'string' && hint.quote.includes(appendText), 'Expected cursor hint quote to include appended text');
    assert(!cursorMap.get(provisionalAutoId!), 'Expected provisional auto cursor to stay removed');

    const disconnectRes = await fetch(`${httpBase}/api/agent/${created.slug}/presence/disconnect`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({ agentId: 'ai:r2c2' }),
    });
    const disconnectPayload = await mustJson<{ success: boolean; disconnected: boolean }>(disconnectRes);
    assert(disconnectPayload.success === true, 'Expected disconnect success');
    assert(disconnectPayload.disconnected === true, 'Expected disconnected=true');

    await waitFor(() => !cursorMap.get('ai:r2c2'), DEFAULT_TIMEOUT_MS, 'cursor hint removed via disconnect');
    await waitFor(() => !presenceMap.get('ai:r2c2'), DEFAULT_TIMEOUT_MS, 'presence removed via disconnect');

    // Ensure disconnected presence/cursor does not reappear before normal TTL expiry windows.
    await sleep(250);
    assert(!cursorMap.get('ai:r2c2'), 'Expected disconnected cursor to stay removed');
    assert(!presenceMap.get('ai:r2c2'), 'Expected disconnected presence to stay removed');

    const humanCommentRes = await fetch(`${httpBase}/api/agent/${created.slug}/marks/comment`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'human:Dan',
        quote: 'Original.',
        text: 'Human comment should not create agent presence',
      }),
    });
    const humanCommentPayload = await mustJson<{ marks?: Record<string, unknown> }>(humanCommentRes);
    const humanCommentMarks = humanCommentPayload.marks ?? {};
    const humanCommentId = Object.keys(humanCommentMarks)[Object.keys(humanCommentMarks).length - 1] ?? '';
    assert(humanCommentId.length > 0, 'Expected human comment mark id');
    assertNoAgentLeak('human:Dan', 'human comment');

    const humanResolveRes = await fetch(`${httpBase}/api/agent/${created.slug}/marks/resolve`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'human:Dan',
        markId: humanCommentId,
      }),
    });
    assert(humanResolveRes.ok, `Expected human resolve to succeed, got HTTP ${humanResolveRes.status}`);
    assertNoAgentLeak('human:Dan', 'human resolve');

    const humanSuggestionRes = await fetch(`${httpBase}/api/agent/${created.slug}/marks/suggest-replace`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'human:Dan',
        quote: appendText,
        content: `${appendText}-updated`,
      }),
    });
    const humanSuggestionPayload = await mustJson<{ marks?: Record<string, unknown> }>(humanSuggestionRes);
    const humanSuggestionMarks = humanSuggestionPayload.marks ?? {};
    const humanSuggestionId = Object.keys(humanSuggestionMarks)[Object.keys(humanSuggestionMarks).length - 1] ?? '';
    assert(humanSuggestionId.length > 0, 'Expected human suggestion mark id');
    assertNoAgentLeak('human:Dan', 'human suggestion');

    const humanRejectRes = await fetch(`${httpBase}/api/agent/${created.slug}/marks/reject`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'human:Dan',
        markId: humanSuggestionId,
      }),
    });
    assert(humanRejectRes.ok, `Expected human reject to succeed, got HTTP ${humanRejectRes.status}`);
    assertNoAgentLeak('human:Dan', 'human reject');

    const humanOpsRes = await fetch(`${httpBase}/api/agent/${created.slug}/ops`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        type: 'comment.add',
        by: 'human:Dan',
        quote: appendText,
        text: 'Human ops comment should not create agent presence',
      }),
    });
    assert(humanOpsRes.ok, `Expected human ops mutation to succeed, got HTTP ${humanOpsRes.status}`);
    assertNoAgentLeak('human:Dan', 'human ops');

    await waitFor(() => !cursorMap.get('ai:r2c2'), DEFAULT_TIMEOUT_MS, 'cursor hint expires');
    await waitFor(() => !presenceMap.get('ai:r2c2'), DEFAULT_TIMEOUT_MS, 'presence expires');

    provider.disconnect();
    provider.destroy();
    provider = null;
    await sleep(50);
    await collab.stopCollabRuntime();
    await collab.invalidateLoadedCollabDocumentAndWait(created.slug);

    const persistedHandle = collab.loadCanonicalYDocSync(created.slug);
    assert(persistedHandle?.source === 'persisted', `Expected persisted canonical handle, got ${String(persistedHandle?.source)}`);
    const persistedPresenceMap: any = persistedHandle?.ydoc.getMap('agentPresence');
    const persistedCursorMap: any = persistedHandle?.ydoc.getMap('agentCursors');
    const persistedActivityArr: any = persistedHandle?.ydoc.getArray('agentActivity');
    const persistedMarkdown = persistedHandle?.ydoc.getText('markdown').toString() ?? '';
    assert(persistedMarkdown.includes(appendText), 'Expected persisted canonical Yjs state to keep the content edit');
    assert((persistedPresenceMap?.size ?? 0) === 0, 'Expected persisted Yjs state to exclude agentPresence');
    assert((persistedCursorMap?.size ?? 0) === 0, 'Expected persisted Yjs state to exclude agentCursors');
    assert((persistedActivityArr?.length ?? 0) === 0, 'Expected persisted Yjs state to exclude agentActivity');

    console.log('✓ agent mutations imply live presence without persisting agent ephemera');
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
    await sleep(50);
    ydoc.destroy();
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
      /* ignore */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await collab.stopCollabRuntime();
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
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
