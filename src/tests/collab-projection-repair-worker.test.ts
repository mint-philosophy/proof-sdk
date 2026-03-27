import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  label: string,
  fn: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await fn().catch(() => false)) return;
    await sleep(50);
  }
  throw new Error(`${label}: timeout after ${timeoutMs}ms`);
}

function readMetricValue(metricsText: string, metricName: string, filters: Array<[string, string]>): number {
  const lines = metricsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const line = lines.find((entry) => (
    entry.startsWith(`${metricName}{`)
    && filters.every(([key, value]) => entry.includes(`${key}="${value}"`))
  ));
  if (!line) return 0;
  const value = Number.parseFloat(line.slice(line.lastIndexOf(' ') + 1));
  return Number.isFinite(value) ? value : 0;
}

async function run(): Promise<void> {
  const dbName = `proof-collab-projection-repair-worker-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const previousEnv = {
    DATABASE_PATH: process.env.DATABASE_PATH,
    COLLAB_EMBEDDED_WS: process.env.COLLAB_EMBEDDED_WS,
    COLLAB_STARTUP_RECONCILE_ENABLED: process.env.COLLAB_STARTUP_RECONCILE_ENABLED,
    COLLAB_PROJECTION_REPAIR_WORKER_ENABLED: process.env.COLLAB_PROJECTION_REPAIR_WORKER_ENABLED,
    COLLAB_PROJECTION_REPAIR_WORKER_DELAY_MS: process.env.COLLAB_PROJECTION_REPAIR_WORKER_DELAY_MS,
    COLLAB_PROJECTION_REPAIR_WORKER_INTERVAL_MS: process.env.COLLAB_PROJECTION_REPAIR_WORKER_INTERVAL_MS,
    COLLAB_PROJECTION_REPAIR_WORKER_LIMIT: process.env.COLLAB_PROJECTION_REPAIR_WORKER_LIMIT,
    COLLAB_PROJECTION_REPAIR_WORKER_MIN_CHARS: process.env.COLLAB_PROJECTION_REPAIR_WORKER_MIN_CHARS,
    COLLAB_PROJECTION_REPAIR_WORKER_OVERSIZED_COOLDOWN_MS: process.env.COLLAB_PROJECTION_REPAIR_WORKER_OVERSIZED_COOLDOWN_MS,
    COLLAB_PROJECTION_REPAIR_WORKER_SCAN_DELAY_MS: process.env.COLLAB_PROJECTION_REPAIR_WORKER_SCAN_DELAY_MS,
    COLLAB_PROJECTION_REPAIR_RETRY_SCHEDULE_MS: process.env.COLLAB_PROJECTION_REPAIR_RETRY_SCHEDULE_MS,
    COLLAB_PROJECTION_GUARD_MAX_CHARS: process.env.COLLAB_PROJECTION_GUARD_MAX_CHARS,
  };

  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.COLLAB_STARTUP_RECONCILE_ENABLED = '0';
  process.env.COLLAB_PROJECTION_REPAIR_WORKER_ENABLED = '1';
  process.env.COLLAB_PROJECTION_REPAIR_WORKER_DELAY_MS = '20';
  process.env.COLLAB_PROJECTION_REPAIR_WORKER_INTERVAL_MS = '100';
  process.env.COLLAB_PROJECTION_REPAIR_WORKER_LIMIT = '100';
  process.env.COLLAB_PROJECTION_REPAIR_WORKER_MIN_CHARS = '1000';
  process.env.COLLAB_PROJECTION_REPAIR_WORKER_OVERSIZED_COOLDOWN_MS = '60000';
  process.env.COLLAB_PROJECTION_REPAIR_WORKER_SCAN_DELAY_MS = '0';
  process.env.COLLAB_PROJECTION_REPAIR_RETRY_SCHEDULE_MS = '0,25,100';
  process.env.COLLAB_PROJECTION_GUARD_MAX_CHARS = '2000';

  const docsToDestroy: Y.Doc[] = [];
  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');
  const metrics = await import('../../server/metrics.ts');

  try {
    const { getHeadlessMilkdownParser, parseMarkdownWithHtmlFallback } = await import('../../server/milkdown-headless.ts');
    const parser = await getHeadlessMilkdownParser();

    const seedDoc = (slug: string, rowMarkdown: string, fragmentMarkdown: string, options?: { alignYStateVersion?: boolean }) => {
      db.createDocument(slug, rowMarkdown, {}, 'projection repair worker');
      const parsed = parseMarkdownWithHtmlFallback(parser, fragmentMarkdown);
      assert(Boolean(parsed.doc), `Expected parser output for seed slug=${slug}`);

      const seedYdoc = new Y.Doc();
      seedYdoc.getText('markdown').insert(0, fragmentMarkdown);
      prosemirrorToYXmlFragment(parsed.doc as any, seedYdoc.getXmlFragment('prosemirror') as any);
      const seedUpdate = Y.encodeStateAsUpdate(seedYdoc);
      const seedSeq = db.appendYUpdate(slug, seedUpdate, 'seed-repair-worker');
      db.saveYSnapshot(slug, seedSeq, seedUpdate);
      docsToDestroy.push(seedYdoc);

      if (options?.alignYStateVersion) {
        const latest = db.getLatestYStateVersion(slug);
        const replaced = db.replaceDocumentProjection(slug, rowMarkdown, {}, latest);
        assert(replaced, `Expected alignYStateVersion replace for slug=${slug}`);
      }
    };

    const repairSlug = `projection-worker-repair-${Math.random().toString(36).slice(2, 10)}`;
    const oversizedMarkdown = `# Oversized\n\n${'X'.repeat(4000)}`;
    const repairedMarkdown = '# Repaired\n\nShort fragment-derived text.';
    seedDoc(repairSlug, oversizedMarkdown, repairedMarkdown);
    const repairRowBefore = db.getDocumentBySlug(repairSlug);
    assert(Boolean(repairRowBefore), 'Expected repair fixture row');

    const healthyOversizedSlug = `projection-worker-healthy-${Math.random().toString(36).slice(2, 10)}`;
    const healthyOversizedMarkdown = `# Healthy Oversized\n\n${'healthy text '.repeat(320)}`;
    seedDoc(healthyOversizedSlug, healthyOversizedMarkdown, healthyOversizedMarkdown, { alignYStateVersion: true });

    const staleHealthSlug = `projection-worker-stale-health-${Math.random().toString(36).slice(2, 10)}`;
    const staleHealthMarkdown = '# Stale Health\n\nAlready matches canonical Yjs.';
    seedDoc(staleHealthSlug, staleHealthMarkdown, staleHealthMarkdown, { alignYStateVersion: true });
    db.getDb().prepare(`
      UPDATE document_projections
      SET health = 'projection_stale'
      WHERE document_slug = ?
    `).run(staleHealthSlug);

    const driftRepairSlug = `projection-worker-drift-${Math.random().toString(36).slice(2, 10)}`;
    const driftRowMarkdown = "# Welcome to Proof\n\nLet's go.";
    const driftFragmentMarkdown = '# Ideas\n\nShip an agent-native editor repair flow.\n\nProtect first-write activation on tiny docs.';
    seedDoc(driftRepairSlug, driftRowMarkdown, driftFragmentMarkdown, { alignYStateVersion: true });
    db.getDb().prepare(`
      UPDATE document_projections
      SET health = 'projection_stale'
      WHERE document_slug = ?
    `).run(driftRepairSlug);

    const guardBlockedSlug = `projection-worker-guard-${Math.random().toString(36).slice(2, 10)}`;
    const guardBase = '# Guarded\n\nshort baseline';
    const guardCandidate = `# Guarded\n\n${'pathological candidate '.repeat(140)}`;
    seedDoc(guardBlockedSlug, guardBase, guardCandidate, { alignYStateVersion: true });

    await collab.startCollabRuntimeEmbedded(4000);

    await pollUntil(
      'repair worker should refresh stale projection from fragment without mutating canonical markdown',
      async () => {
        const projection = db.getDocumentProjectionBySlug(repairSlug);
        return (projection?.markdown ?? '').includes('Short fragment-derived text.');
      },
      8_000,
    );

    const repairedRow = db.getDocumentBySlug(repairSlug);
    const repairedProjection = db.getDocumentProjectionBySlug(repairSlug);
    assert(
      (repairedProjection?.markdown ?? '').includes('Short fragment-derived text.'),
      'Expected repaired projection markdown content to persist',
    );
    assert(
      (repairedRow?.markdown ?? '') === oversizedMarkdown,
      'Expected projection repair not to overwrite canonical markdown',
    );
    assert(
      (repairedRow?.revision ?? null) === (repairRowBefore?.revision ?? null),
      'Expected projection-only repair not to bump canonical revision',
    );
    assert(
      (repairedRow?.updated_at ?? null) === (repairRowBefore?.updated_at ?? null),
      'Expected projection-only repair not to change canonical updated_at',
    );

    await pollUntil(
      'repair worker should allow fragment drift repairs derived from authoritative Yjs state without mutating canonical markdown',
      async () => {
        const projection = db.getDocumentProjectionBySlug(driftRepairSlug);
        return (projection?.markdown ?? '').includes('agent-native editor repair flow');
      },
      8_000,
    );
    const driftRow = db.getDocumentBySlug(driftRepairSlug);
    assert(
      (driftRow?.markdown ?? '') === driftRowMarkdown,
      'Expected fragment drift repair to leave canonical markdown unchanged',
    );

    await pollUntil(
      'repair worker should clear stale projection health even when markdown is already current',
      async () => db.getDocumentProjectionBySlug(staleHealthSlug)?.health === 'healthy',
      8_000,
    );

    await sleep(250);
    const queuedAfterFirstWindow = readMetricValue(
      metrics.renderMetricsText(),
      'projection_repair_total',
      [['result', 'queued'], ['reason', 'oversized_projection']],
    );
    assert(
      queuedAfterFirstWindow >= 2,
      `Expected oversized queue metrics to register for repair+healthy docs; current=${queuedAfterFirstWindow}`,
    );

    await sleep(450);
    const queuedAfterSecondWindow = readMetricValue(
      metrics.renderMetricsText(),
      'projection_repair_total',
      [['result', 'queued'], ['reason', 'oversized_projection']],
    );
    assert(
      queuedAfterSecondWindow === queuedAfterFirstWindow,
      `Expected oversized healthy doc to avoid repeated queueing; first=${queuedAfterFirstWindow} second=${queuedAfterSecondWindow}`,
    );

    await sleep(250);
    const guardFailuresAfterFirstWindow = readMetricValue(
      metrics.renderMetricsText(),
      'projection_repair_total',
      [['result', 'failure'], ['reason', 'max_chars_exceeded']],
    );
    assert(
      guardFailuresAfterFirstWindow >= 1,
      `Expected guard-blocked repair failure metric for max_chars_exceeded; current=${guardFailuresAfterFirstWindow}`,
    );

    await sleep(450);
    const guardFailuresAfterSecondWindow = readMetricValue(
      metrics.renderMetricsText(),
      'projection_repair_total',
      [['result', 'failure'], ['reason', 'max_chars_exceeded']],
    );
    assert(
      guardFailuresAfterSecondWindow === guardFailuresAfterFirstWindow,
      `Expected guard-blocked repair not to keep retrying; first=${guardFailuresAfterFirstWindow} second=${guardFailuresAfterSecondWindow}`,
    );

    const staleOversizedQueuedBaseline = readMetricValue(
      metrics.renderMetricsText(),
      'projection_repair_total',
      [['result', 'queued'], ['reason', 'stale_projection']],
    );
    const staleOversizedSlug = `projection-worker-stale-oversized-${Math.random().toString(36).slice(2, 10)}`;
    const staleOversizedRowMarkdown = '# Stale Oversized\n\nshort row baseline';
    const staleOversizedFragmentMarkdown = `# Stale Oversized\n\n${'fragment candidate '.repeat(180)}`;
    seedDoc(staleOversizedSlug, staleOversizedRowMarkdown, staleOversizedFragmentMarkdown);

    await sleep(250);
    const staleOversizedQueuedAfterFirstWindow = readMetricValue(
      metrics.renderMetricsText(),
      'projection_repair_total',
      [['result', 'queued'], ['reason', 'stale_projection']],
    );
    assert(
      staleOversizedQueuedAfterFirstWindow > staleOversizedQueuedBaseline,
      `Expected stale oversized doc to queue stale_projection once; baseline=${staleOversizedQueuedBaseline} current=${staleOversizedQueuedAfterFirstWindow}`,
    );

    await sleep(450);
    const staleOversizedQueuedAfterSecondWindow = readMetricValue(
      metrics.renderMetricsText(),
      'projection_repair_total',
      [['result', 'queued'], ['reason', 'stale_projection']],
    );
    assert(
      staleOversizedQueuedAfterSecondWindow === staleOversizedQueuedAfterFirstWindow,
      `Expected stale oversized doc to honor oversized cooldown; first=${staleOversizedQueuedAfterFirstWindow} second=${staleOversizedQueuedAfterSecondWindow}`,
    );

    // Reproduce stop race window by forcing a long scan; stop should invalidate callback reschedule.
    process.env.COLLAB_PROJECTION_REPAIR_WORKER_SCAN_DELAY_MS = '180';
    const raceSlug = `projection-worker-race-${Math.random().toString(36).slice(2, 10)}`;
    seedDoc(raceSlug, `# Race\n\n${'R'.repeat(5000)}`, '# Race\n\nfixed');
    await sleep(40);
    await collab.stopCollabRuntime();

    const postStopSlug = `projection-worker-post-stop-${Math.random().toString(36).slice(2, 10)}`;
    const postStopMarkdown = `# Post Stop\n\n${'Z'.repeat(5000)}`;
    const postStopFragmentMarkdown = '# Post Stop\n\nfixed after stop';
    seedDoc(postStopSlug, postStopMarkdown, postStopFragmentMarkdown);

    await sleep(450);
    const postStopRow = db.getDocumentBySlug(postStopSlug);
    assert(
      (postStopRow?.markdown ?? '') === postStopMarkdown,
      'Expected no projection repair writes after stopCollabRuntime',
    );

    console.log('✓ collab projection repair worker repairs stale projection, throttles oversized healthy docs, and does not restart after stop');
  } finally {
    for (const doc of docsToDestroy) {
      try {
        doc.destroy();
      } catch {
        // ignore
      }
    }
    await collab.stopCollabRuntime();
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
