import express, { type Response } from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiRoutes } from './routes.js';
import { agentRoutes } from './agent-routes.js';
import { setupWebSocket } from './ws.js';
import { createBridgeMountRouter } from './bridge.js';
import { getCollabRuntime, startCollabRuntimeEmbedded } from './collab.js';
import { discoveryRoutes } from './discovery-routes.js';
import { shareWebRoutes } from './share-web-routes.js';
import {
  capabilitiesPayload,
  enforceApiClientCompatibility,
  enforceBridgeClientCompatibility,
} from './client-capabilities.js';
import { getBuildInfo } from './build-info.js';
import { createDocument, createDocumentAccessToken } from './db.js';
import { generateSlug } from './slug.js';
import { AGENT_TAB_UI_SCRIPT } from './homepage-script.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number.parseInt(process.env.PORT || '4000', 10);
const HOME_TEMPLATE_PATH = path.join(__dirname, 'resources', 'home.html');
const HOME_HTML = readFileSync(HOME_TEMPLATE_PATH, 'utf8').replace('__AGENT_TAB_UI_SCRIPT__', AGENT_TAB_UI_SCRIPT);
const DEFAULT_ALLOWED_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:4000',
  'http://127.0.0.1:4000',
  'null',
];

function parseAllowedCorsOrigins(): Set<string> {
  const configured = (process.env.PROOF_CORS_ALLOW_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(configured.length > 0 ? configured : DEFAULT_ALLOWED_CORS_ORIGINS);
}

async function main(): Promise<void> {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const allowedCorsOrigins = parseAllowedCorsOrigins();
  const staticAssetOptions = process.env.NODE_ENV !== 'production'
    ? {
      index: false,
      setHeaders: (res: Response) => {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      },
    }
    : { index: false };

  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), staticAssetOptions));
  app.use(express.static(path.join(__dirname, '..', 'dist'), staticAssetOptions));

  app.use((req, res, next) => {
    const originHeader = req.header('origin');
    if (originHeader && allowedCorsOrigins.has(originHeader)) {
      res.setHeader('Access-Control-Allow-Origin', originHeader);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      [
        'Content-Type',
        'Authorization',
        'X-Proof-Client-Version',
        'X-Proof-Client-Build',
        'X-Proof-Client-Protocol',
        'x-share-token',
        'x-bridge-token',
        'x-auth-poll-token',
        'X-Agent-Id',
        'X-Window-Id',
        'X-Document-Id',
        'Idempotency-Key',
        'X-Idempotency-Key',
      ].join(', '),
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/', (_req, res) => {
    res.type('html').send(HOME_HTML);
  });

  app.get('/download', (_req, res) => {
    res.redirect(302, '/');
  });

  app.get('/get-started', (_req, res) => {
    const slug = generateSlug();
    const title = 'Untitled';
    const markdown = '# Untitled\n\n';
    createDocument(slug, markdown, {}, title);
    const access = createDocumentAccessToken(slug, 'editor');
    res.redirect(302, `/d/${encodeURIComponent(slug)}?token=${encodeURIComponent(access.secret)}`);
  });

  app.get('/health', (_req, res) => {
    const buildInfo = getBuildInfo();
    res.json({
      ok: true,
      buildInfo,
      collab: getCollabRuntime(),
    });
  });

  app.get('/api/capabilities', (_req, res) => {
    res.json(capabilitiesPayload());
  });

  app.use(discoveryRoutes);
  app.use('/api', enforceApiClientCompatibility, apiRoutes);
  app.use('/api/agent', agentRoutes);
  app.use(apiRoutes);
  app.use('/d', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', agentRoutes);
  app.use(shareWebRoutes);

  setupWebSocket(wss);
  await startCollabRuntimeEmbedded(PORT);

  server.listen(PORT, () => {
    console.log(`[proof-sdk] listening on http://127.0.0.1:${PORT}`);
  });
}

main().catch((error) => {
  console.error('[proof-sdk] failed to start server', error);
  process.exit(1);
});
