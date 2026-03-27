import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function setMarkdown(doc: Y.Doc, value: string): void {
  const text = doc.getText('markdown');
  const current = text.toString();
  if (current.length > 0) text.delete(0, current.length);
  if (value.length > 0) text.insert(0, value);
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (condition()) return;
  throw new Error(`Timed out waiting for ${label}`);
}

async function run(): Promise<void> {
  const dbName = `proof-collab-onstore-stale-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');
  const { summarizeDocumentIntegrity } = await import('../../server/document-integrity.ts');
  const metrics = await import('../../server/metrics.ts');

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '));
    originalWarn(...args);
  };

  const markdownA = [
    '# Weekly Plan',
    '',
    '## Tuesday',
    '',
    '* Original Tuesday',
    '',
    '## Wednesday',
    '',
    '* Original Wednesday',
  ].join('\n');
  const markdownB = [
    '# Weekly Plan',
    '',
    '## Tuesday',
    '',
    '* Updated Tuesday',
    '',
    '## Wednesday',
    '',
    '* Updated Wednesday',
    '',
    '## Thursday',
    '',
    '* External Thursday',
  ].join('\n');

  const legitimateRepeatedMarkdown = [
    '# Weekly Plan',
    '',
    ...Array.from({ length: 4 }, (_, releaseIndex) => {
      const release = releaseIndex + 1;
      return [
        `## Release ${release}`,
        '',
        '### Status',
        '',
        `Status body ${release}`,
        '',
        `Status detail ${release}`,
        '',
        '### Validation',
        '',
        `Validation body ${release}`,
        '',
        `Validation detail ${release}`,
      ].join('\n');
    }),
  ].join('\n\n');
  const legitimateIntegrity = summarizeDocumentIntegrity(legitimateRepeatedMarkdown);
  assert(
    legitimateIntegrity.repeatedHeadings.includes('3:status'),
    'Expected legitimate repeated-heading local doc to reuse Status headings',
  );
  assert(
    legitimateIntegrity.repeatedSectionSignatures.length === 0,
    'Expected legitimate repeated-heading local doc not to look like replayed identical sections',
  );
  assert(
    collab.__unsafeShouldSuppressProjectionDriftNoiseForTests(legitimateRepeatedMarkdown, markdownB) === false,
    'Expected legitimate repeated-heading projection drift not to suppress repair noise as duplication',
  );

  const duplicatedLocalMarkdown = [
    '# Weekly Plan',
    '',
    ...Array.from({ length: 64 }, () => [
      '## Runbook 001',
      '',
      'Repeated section body for projection drift suppression.',
      '',
      '- [ ] Replayed checklist item',
    ].join('\n')),
  ].join('\n\n');
  const duplicatedIntegrity = summarizeDocumentIntegrity(duplicatedLocalMarkdown);
  assert(
    duplicatedIntegrity.repeatedSectionSignatures.length > 0,
    'Expected replay-like local duplication to produce repeated section signatures',
  );
  assert(
    collab.__unsafeShouldSuppressProjectionDriftNoiseForTests(duplicatedLocalMarkdown, markdownB),
    'Expected replay-like local duplication to suppress projection-drift noise',
  );

  async function runProjectionRepairSuppressedNoiseScenario(): Promise<void> {
    const slug = `onstore-projection-repair-${Math.random().toString(36).slice(2, 10)}`;
    await collab.startCollabRuntimeEmbedded(4000);
    db.createDocument(slug, markdownA, {}, 'onStore projection repair test');

    const ydocA = new Y.Doc();
    setMarkdown(ydocA, markdownA);
    const updateA = Y.encodeStateAsUpdate(ydocA);
    const seqA = db.appendYUpdate(slug, updateA, 'test-seed');
    db.saveYSnapshot(slug, seqA, updateA);

    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as any;
    assert(instance && typeof instance.createDocument === 'function', 'Expected collab runtime to expose hocuspocus test instance');

    const loadedDoc = await instance.createDocument(
      slug,
      {},
      'projection-repair-test-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );

    const ydocExternal = new Y.Doc();
    Y.applyUpdate(ydocExternal, updateA);
    setMarkdown(ydocExternal, markdownB);
    const externalDelta = Y.encodeStateAsUpdate(ydocExternal, Y.encodeStateVector(ydocA));
    assert(externalDelta.byteLength > 0, 'Expected non-empty external Yjs delta');
    db.appendYUpdate(slug, externalDelta, 'external-yjs-only');

    setMarkdown(loadedDoc, duplicatedLocalMarkdown);
    await collab.__unsafePersistOnStoreDocumentForTests(slug, loadedDoc);

    const beforeRepair = db.getProjectedDocumentBySlug(slug);
    assert(
      (beforeRepair?.markdown ?? '').includes('Original Tuesday'),
      'Expected projected read surface to still be stale before async repair runs',
    );

    await waitFor(() => {
      const repaired = db.getProjectedDocumentBySlug(slug);
      return Boolean(repaired?.markdown.includes('Updated Tuesday'));
    }, 10_000, 'queued projection repair to refresh stale canonical projection');

    const repaired = db.getProjectedDocumentBySlug(slug);
    assert(Boolean(repaired), 'Expected repaired projected row after queued projection repair');
    assert(
      (repaired?.markdown ?? '').includes('Updated Tuesday'),
      `Expected queued projection repair to refresh derived projection from persisted Yjs. markdown=${(repaired?.markdown ?? '').slice(0, 160)}`,
    );
    assert(
      !(repaired?.markdown ?? '').includes('Original Tuesday'),
      `Expected queued projection repair to remove stale projected content. markdown=${(repaired?.markdown ?? '').slice(0, 160)}`,
    );
    assert(
      countOccurrences(repaired?.markdown ?? '', '## Tuesday') === 1,
      `Expected queued projection repair not to preserve duplicated local headings. markdown=${(repaired?.markdown ?? '').slice(0, 220)}`,
    );

    await collab.stopCollabRuntime();
  }

  async function runScenario(
    projectionOnlyExternalWrite: boolean,
    localMode: 'none' | 'token' | 'duplicate' = 'none',
  ): Promise<void> {
    const mode = projectionOnlyExternalWrite ? 'projection' : 'revision';
    const slug = `onstore-stale-${mode}-${localMode}-${Math.random().toString(36).slice(2, 10)}`;
    await collab.startCollabRuntimeEmbedded(4000);
    db.createDocument(slug, markdownA, {}, 'onStore stale overwrite test');

    const ydocA = new Y.Doc();
    setMarkdown(ydocA, markdownA);
    const updateA = Y.encodeStateAsUpdate(ydocA);
    const seqA = db.appendYUpdate(slug, updateA, 'test-seed');
    db.saveYSnapshot(slug, seqA, updateA);

    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as any;
    assert(instance && typeof instance.createDocument === 'function', 'Expected collab runtime to expose hocuspocus test instance');

    const loadedDoc = await instance.createDocument(
      slug,
      {},
      'test-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );
    assert(
      String(loadedDoc.getText('markdown').toString()).includes('Original Tuesday'),
      'Expected loaded collab doc to start at the original weekly plan content',
    );

    const beforeExternal = db.getDocumentBySlug(slug);
    assert(Boolean(beforeExternal), 'Expected document row before external write');

    const ydocExternal = new Y.Doc();
    Y.applyUpdate(ydocExternal, updateA);
    setMarkdown(ydocExternal, markdownB);
    const externalDelta = Y.encodeStateAsUpdate(ydocExternal, Y.encodeStateVector(ydocA));
    assert(externalDelta.byteLength > 0, 'Expected non-empty external Yjs delta');
    db.appendYUpdate(slug, externalDelta, 'external-edit');

    if (projectionOnlyExternalWrite) {
      const replaced = db.replaceDocumentProjection(slug, markdownB, {}, db.getLatestYStateVersion(slug));
      assert(replaced, 'Expected projection-only external write to persist');
      const afterProjection = db.getDocumentBySlug(slug);
      assert(
        beforeExternal?.updated_at === afterProjection?.updated_at,
        'Expected projection-only external write to preserve updated_at',
      );
    } else {
      db.updateDocument(slug, markdownB);
    }

    const localDeltaToken = `LOCAL_STALE_${Math.random().toString(36).slice(2, 8)}`;
    if (localMode === 'token') {
      setMarkdown(loadedDoc, `${markdownA}\n\n${localDeltaToken}`);
      assert(String(loadedDoc.getText('markdown').toString()).includes(localDeltaToken), 'Expected stale token delta before shutdown');
    } else if (localMode === 'duplicate') {
      setMarkdown(loadedDoc, `${markdownA}\n\n${markdownA}`);
      assert(
        countOccurrences(String(loadedDoc.getText('markdown').toString()), '## Tuesday') === 2,
        'Expected in-memory stale doc to contain duplicated heading sequence before shutdown',
      );
    } else {
      assert(
        String(loadedDoc.getText('markdown').toString()).includes('Original Tuesday'),
        'Expected in-memory doc to remain stale before shutdown',
      );
    }
    await collab.stopCollabRuntime();

    const after = db.getDocumentBySlug(slug);
    assert(Boolean(after), 'Expected document row to exist after unload');
    assert(
      (after?.markdown ?? '').includes('Updated Tuesday'),
      `Expected external edit to survive onStoreDocument. markdown=${(after?.markdown ?? '').slice(0, 160)}`,
    );
    assert(
      !(after?.markdown ?? '').includes('Original Tuesday'),
      `Expected stale Tuesday content not to be written back. markdown=${(after?.markdown ?? '').slice(0, 160)}`,
    );
    assert(
      countOccurrences(after?.markdown ?? '', '# Weekly Plan') === 1,
      `Expected top-level title once after stale reload. markdown=${(after?.markdown ?? '').slice(0, 220)}`,
    );
    assert(
      countOccurrences(after?.markdown ?? '', '## Tuesday') === 1,
      `Expected Tuesday heading once after stale reload. markdown=${(after?.markdown ?? '').slice(0, 220)}`,
    );
    assert(
      countOccurrences(after?.markdown ?? '', '## Wednesday') === 1,
      `Expected Wednesday heading once after stale reload. markdown=${(after?.markdown ?? '').slice(0, 220)}`,
    );
    if (localMode === 'token') {
      assert(
        !(after?.markdown ?? '').includes(localDeltaToken),
        `Expected stale local unsaved delta not to be merged into canonical markdown. markdown=${(after?.markdown ?? '').slice(0, 160)}`,
      );
    }

    await collab.startCollabRuntimeEmbedded(4000);
    const reloadInstance = collab.__unsafeGetHocuspocusInstanceForTests() as any;
    assert(reloadInstance && typeof reloadInstance.createDocument === 'function', 'Expected reload collab instance for reconnect validation');
    const reloadedDoc = await reloadInstance.createDocument(
      slug,
      {},
      'reconnect-test-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );
    const reloadedMarkdown = String(reloadedDoc.getText('markdown').toString());
    assert(
      reloadedMarkdown.includes('Updated Tuesday'),
      `Expected reconnect runtime to load canonical external state. markdown=${reloadedMarkdown.slice(0, 160)}`,
    );
    assert(
      !reloadedMarkdown.includes('Original Tuesday'),
      `Expected reconnect runtime to avoid stale Tuesday content. markdown=${reloadedMarkdown.slice(0, 160)}`,
    );
    assert(
      countOccurrences(reloadedMarkdown, '# Weekly Plan') === 1,
      `Expected reconnect runtime to have one title. markdown=${reloadedMarkdown.slice(0, 220)}`,
    );
    assert(
      countOccurrences(reloadedMarkdown, '## Tuesday') === 1,
      `Expected reconnect runtime to have one Tuesday heading. markdown=${reloadedMarkdown.slice(0, 220)}`,
    );
    if (localMode === 'token') {
      assert(
        !reloadedMarkdown.includes(localDeltaToken),
        `Expected reconnect runtime to avoid stale local token. markdown=${reloadedMarkdown.slice(0, 160)}`,
      );
    }
    await collab.stopCollabRuntime();

    assert(
      warnings.some((entry) => (
        entry.includes('[collab_stale_onstore_reload]')
        || entry.includes('projection_drift_onstore_skip')
      )),
      'Expected stale onStore reload warning log',
    );
  }

  try {
    await runScenario(false);
    await runScenario(true);
    await runScenario(true, 'token');
    await runScenario(true, 'duplicate');
    await runProjectionRepairSuppressedNoiseScenario();
    const metricsText = metrics.renderMetricsText();
    assert(
      metricsText.includes('projection_drift_total{reason="projection_drift_onstore_skip"'),
      'Expected projection drift metric to record onStore skip events',
    );
    console.log('✓ onStoreDocument preserves canonical state under stale external/projection drift scenarios');
  } finally {
    console.warn = originalWarn;
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

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
