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

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\s+$/, '');
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
  const dbName = `proof-collab-stale-epoch-${Date.now()}-${randomUUID()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '));
    originalWarn(...args);
  };

  const [{ apiRoutes }, { setupWebSocket }, collab, db] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
    import('../../server/db.js'),
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
        markdown: '# Epoch Guard\n\nOriginal content.',
        marks: {},
        title: 'stale epoch write guard',
      }),
    });
    const created = await mustJson<ShareCreateResponse>(createRes);
    assert(typeof created.slug === 'string' && created.slug.length > 0, 'Expected slug');
    assert(typeof created.ownerSecret === 'string' && created.ownerSecret.length > 0, 'Expected owner secret');

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
    await waitFor(
      () => ydoc.getText('markdown').toString().includes('Original content.'),
      DEFAULT_TIMEOUT_MS,
      'provider markdown initial sync',
    );

    const nextEpoch = db.bumpDocumentAccessEpoch(created.slug);
    assert(typeof nextEpoch === 'number' && nextEpoch > 0, 'Expected access epoch bump');

    const canonicalMarkdown = '# Epoch Guard\n\nCanonical after epoch bump.';
    const rewritePersisted = db.updateDocument(created.slug, canonicalMarkdown);
    assert(rewritePersisted, 'Expected canonical markdown update to succeed');
    await collab.applyCanonicalDocumentToCollab(created.slug, {
      markdown: canonicalMarkdown,
      source: 'epoch-guard-test',
    });

    await waitFor(
      () => normalizeMarkdown(ydoc.getText('markdown').toString()) === normalizeMarkdown(canonicalMarkdown),
      DEFAULT_TIMEOUT_MS,
      'stale session received canonical markdown',
    );
    const baselineUpdatedAt = db.getDocumentBySlug(created.slug)?.updated_at ?? null;
    assert(Boolean(baselineUpdatedAt), 'Expected baseline updatedAt after canonical apply');

    const staleMarker = '\n\nSTALE_EPOCH_WRITE';
    ydoc.getText('markdown').insert(ydoc.getText('markdown').length, staleMarker);
    await sleep(1200);

    const after = db.getDocumentBySlug(created.slug);
    assert(Boolean(after), 'Expected document row after stale write attempt');
    assert(
      !(after?.markdown ?? '').includes('STALE_EPOCH_WRITE'),
      `Expected stale-epoch write to be dropped; markdown=${(after?.markdown ?? '').slice(0, 200)}`,
    );
    assert(
      after?.updated_at === baselineUpdatedAt,
      `Expected stale-epoch write not to advance updated_at (${baselineUpdatedAt} -> ${after?.updated_at})`,
    );
    assert(
      warnings.some((entry) => entry.includes('stale-epoch write dropped')),
      'Expected stale-epoch write warning log',
    );

    console.log('✓ stale access-epoch collab writes are dropped');
  } finally {
    console.warn = originalWarn;
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
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
