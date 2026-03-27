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
  const dbName = `proof-collab-put-propagates-${Date.now()}-${randomUUID()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';

  const [{ apiRoutes }, { setupWebSocket }, collab] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);

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
        markdown: '# Content A\n\nOriginal content.',
        marks: {},
        title: 'Collab PUT propagation',
      }),
    });
    const created = await mustJson<ShareCreateResponse>(createRes);
    assert(typeof created.slug === 'string' && created.slug.length > 0, 'Expected create response slug');
    assert(typeof created.ownerSecret === 'string' && created.ownerSecret.length > 0, 'Expected create response ownerSecret');

    const fetchSession = async (): Promise<CollabSessionPayload['session']> => {
      const sessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
        headers: {
          ...CLIENT_HEADERS,
          'x-share-token': created.ownerSecret,
        },
      });
      const sessionPayload = await mustJson<CollabSessionPayload>(sessionRes);
      assert(sessionPayload.success === true, 'Expected collab-session success');
      return sessionPayload.session;
    };

    const reconnectWithFreshSession = async (): Promise<void> => {
      connected = false;
      synced = false;
      const session = await fetchSession();
      const wsUrl = (() => {
        const raw = session.collabWsUrl.replace(/\?slug=.*$/, '');
        try {
          const url = new URL(raw);
          // Avoid IPv6 localhost resolution differences in CI/dev; bind consistently.
          if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
          return url.toString();
        } catch {
          return raw.replace('ws://localhost:', 'ws://127.0.0.1:');
        }
      })();
      assert(wsUrl.includes('/ws'), `Expected collab wsUrl to include /ws, got ${wsUrl}`);

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

      provider = new HocuspocusProvider({
        url: wsUrl,
        name: created.slug,
        document: ydoc,
        parameters: { token: session.token, role: session.role },
        token: session.token,
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
    };

    await reconnectWithFreshSession();

    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as any;
    const loadedKeys = (() => {
      try {
        return Array.from(instance?.documents?.keys?.() ?? []);
      } catch {
        return [];
      }
    })();
    assert(
      loadedKeys.includes(created.slug),
      `Expected hocuspocus to have document loaded for slug=${created.slug}, keys=${loadedKeys.join(',')}`,
    );

    const initialMarkdown = ydoc.getText('markdown').toString();
    assert(initialMarkdown.includes('Content A'), `Expected initial collab markdown to include Content A, got: ${initialMarkdown.slice(0, 120)}`);

    const putRes = await fetch(`${httpBase}/api/documents/${created.slug}`, {
      method: 'PUT',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: '# Content B\n\nUpdated content.',
        ownerSecret: created.ownerSecret,
      }),
    });
    assert(putRes.ok, `Expected PUT to succeed, got HTTP ${putRes.status}`);

    // Structural writes now rotate collab access epoch, so reconnect with a fresh session token.
    await reconnectWithFreshSession();

    await waitFor(() => ydoc.getText('markdown').toString().includes('Content B'), DEFAULT_TIMEOUT_MS, 'ydoc markdown updated to Content B');

    const fragmentStr = String(ydoc.getXmlFragment('prosemirror').toString());
    assert(
      fragmentStr.includes('Content B') || ydoc.getText('markdown').toString().includes('Content B'),
      'Expected ProseMirror Y.XmlFragment or markdown channel to reflect PUT update',
    );

    const pollutedMarkdown = '# Content C\n\nBefore <span class="ProseMirror-yjs-cursor proof-collab-cursor">\u2060cursor\u2060</span> After.';
    const pollutedPutRes = await fetch(`${httpBase}/api/documents/${created.slug}`, {
      method: 'PUT',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: pollutedMarkdown,
        ownerSecret: created.ownerSecret,
      }),
    });
    assert(pollutedPutRes.ok, `Expected polluted PUT to succeed, got HTTP ${pollutedPutRes.status}`);

    await reconnectWithFreshSession();

    await waitFor(
      () => ydoc.getText('markdown').toString().includes('Content C'),
      DEFAULT_TIMEOUT_MS,
      'ydoc markdown updated to Content C',
    );

    const sanitizedMarkdown = ydoc.getText('markdown').toString();
    assert(!sanitizedMarkdown.includes('ProseMirror-yjs-cursor'), 'Expected collab markdown to strip ephemeral cursor span');
    assert(!sanitizedMarkdown.includes('proof-collab-cursor'), 'Expected collab markdown to strip proof collab cursor span');
    assert(!sanitizedMarkdown.includes('\u2060'), 'Expected collab markdown to strip cursor separators');
    assert(sanitizedMarkdown.includes('Before  After.'), 'Expected surrounding content to be preserved after sanitization');

    console.log('✓ REST PUT markdown updates propagate to active collab sessions');
  } finally {
    try {
      provider?.disconnect();
      provider?.destroy();
      try {
        // HocuspocusProvider keeps a per-provider websocketProvider with a connection checker
        // interval. provider.destroy() intentionally does not tear it down when
        // preserveConnection=true (default), but for Node tests we must stop it.
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
