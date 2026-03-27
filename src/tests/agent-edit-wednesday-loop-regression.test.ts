import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function setMarkdown(doc: Y.Doc, value: string): void {
  const text = doc.getText('markdown');
  const current = text.toString();
  if (current.length > 0) text.delete(0, current.length);
  if (value.length > 0) text.insert(0, value);
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

type CreatedDoc = { slug: string; ownerSecret: string };
type StatePayload = { updatedAt: string };
type ReadDocPayload = { markdown: string };

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

const WEDNESDAY_TASK_CLUSTER = [
  '**Pomodoro 1 - 9:13 AM (30 min)**',
  '',
  '* [x] Fix markdown rendering of checkboxes and links -> push to production',
  '',
  '* [x] Review podcast X copy -> respond to Rhea',
  '',
  '* [x] Diagnose and fix Brandon\'s Proof issue from claws-only',
  '',
  '**Done**',
  '',
  '* [x] Check with Natalia about Applecart (9 AM)',
  '',
  '* [x] Finish new share UX',
  '',
  '**Writing**',
  '',
  '* [ ] Write Claw guide, bring Jack in',
  '',
  '* [x] Review Jack\'s intro for my piece for this week',
  '',
  '**EveryClaw Review** - one consolidated session with R2C2',
].join('\n');

const WEDNESDAY_BROKEN_SECTION = [
  '## Wednesday, Feb 25, 2026',
  '',
  '**12:00 PM** - Present at Thumbtack offsite**12:00 PM** - Present at Thumbtack offsite**12:00 PM** - Present at Thumbtack offsite**12:00 PM** - Present at Thumbtack offsite',
  '',
  WEDNESDAY_TASK_CLUSTER,
  '',
  WEDNESDAY_TASK_CLUSTER,
  '',
  WEDNESDAY_TASK_CLUSTER,
  '',
  WEDNESDAY_TASK_CLUSTER,
].join('\n');

const WEDNESDAY_CLEAN_SECTION = [
  '## Wednesday, Feb 25, 2026',
  '',
  '**12:00 PM** - Present at Thumbtack offsite',
  '',
  '**Done**',
  '',
  '* [x] Check with Natalia about Applecart (9 AM)',
  '',
  '* [x] Fix markdown rendering of checkboxes and links -> push to production',
  '',
  '* [x] Review podcast X copy -> respond to Rhea',
  '',
  '* [x] Diagnose and fix Brandon\'s Proof issue from claws-only',
  '',
  '* [x] Finish new share UX',
  '',
  '* [x] Review Jack\'s intro for my piece for this week',
  '',
  '**Writing**',
  '',
  '* [ ] Write Claw guide, bring Jack in',
  '',
  '**EveryClaw Review** - one consolidated session with R2C2',
].join('\n');

const DOC_PREFIX = [
  '# Daily Plan',
  '',
  '## Focus (Feb 21 -- Mar 7)',
  '',
  'Make Proof the best collaborative markdown editor for AI and humans.',
  '',
  '***',
  '',
].join('\n');

const DOC_SUFFIX = [
  '',
  '## Tuesday, Feb 24, 2026',
  '',
  '* [x] Work with Brandon and Willie on Claw / Sheriff strategy',
  '',
  '* [x] Review roadmap',
  '',
  '* [x] Mobile comments PR',
  '',
  '***',
].join('\n');

async function run(): Promise<void> {
  const dbName = `proof-agent-edit-wednesday-loop-${Date.now()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';

  const [{ apiRoutes }, { agentRoutes }, collab] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/collab.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  await collab.startCollabRuntimeEmbedded(address.port);
  try {
    const initialMarkdown = `${DOC_PREFIX}${WEDNESDAY_BROKEN_SECTION}${DOC_SUFFIX}`;
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
      },
      body: JSON.stringify({
        title: 'Wednesday loop regression',
        markdown: initialMarkdown,
        marks: {},
      }),
    });
    const created = await mustJson<CreatedDoc>(createRes, 'create');

    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as {
      createDocument: (
        docName: string,
        requestParameters?: Record<string, any>,
        socketId?: string,
        context?: Record<string, any>,
        socket?: Record<string, any>,
      ) => Promise<Y.Doc>;
    };
    assert(instance && typeof instance.createDocument === 'function', 'Expected hocuspocus test instance');
    const loadedDoc = await instance.createDocument(
      created.slug,
      {},
      'test-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );

    let currentSection = WEDNESDAY_BROKEN_SECTION;
    let targetSection = WEDNESDAY_CLEAN_SECTION;
    for (let i = 0; i < 20; i++) {
      const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
        headers: { 'x-share-token': created.ownerSecret },
      });
      const state = await mustJson<StatePayload>(stateRes, `state[${i}]`);

      // Force in-memory drift by duplicating the current section in the loaded collab doc.
      // Pre-fix behavior applied /edit ops against this drifted base and produced duplicates.
      const driftedMarkdown = `${DOC_PREFIX}${currentSection}\n\n${currentSection}${DOC_SUFFIX}`;
      setMarkdown(loadedDoc, driftedMarkdown);

      const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': created.ownerSecret,
        },
        body: JSON.stringify({
          by: 'ai:test-loop',
          baseUpdatedAt: state.updatedAt,
          operations: [
            {
              op: 'replace',
              search: currentSection,
              content: targetSection,
            },
          ],
        }),
      });
      const editPayload = await mustJson<{ success: boolean }>(editRes, `edit[${i}]`);
      assert(editPayload.success === true, `Expected edit success at iteration ${i}`);

      const docRes = await fetch(`${httpBase}/api/documents/${created.slug}`, {
        headers: { 'x-share-token': created.ownerSecret },
      });
      const doc = await mustJson<ReadDocPayload>(docRes, `read[${i}]`);
      const expectedMarkdown = `${DOC_PREFIX}${targetSection}${DOC_SUFFIX}`;
      assert(
        doc.markdown === expectedMarkdown,
        `Iteration ${i} produced unexpected markdown length=${doc.markdown.length} expected=${expectedMarkdown.length}`,
      );
      assert(
        countOccurrences(doc.markdown, '## Wednesday, Feb 25, 2026') === 1,
        `Expected single Wednesday heading after iteration ${i}`,
      );

      currentSection = targetSection;
      targetSection = currentSection === WEDNESDAY_BROKEN_SECTION ? WEDNESDAY_CLEAN_SECTION : WEDNESDAY_BROKEN_SECTION;
    }

    console.log('✓ agent /edit survives repeated Wednesday broken<->clean rewrites under forced collab drift');
  } finally {
    await collab.stopCollabRuntime();
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

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
