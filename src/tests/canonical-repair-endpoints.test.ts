import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import { getHeadlessMilkdownParser } from '../../server/milkdown-headless.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

type CreateResponse = { slug: string; ownerSecret: string };
type RepairResponse = { success: boolean; slug: string; health: string; healthReason?: string };
type CloneResponse = { success: boolean; cloneSlug: string; ownerSecret?: string };
type StateResponse = { success: boolean; markdown?: string; content?: string };

async function run(): Promise<void> {
  const dbName = `proof-canonical-repair-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const previousMutationStage = process.env.PROOF_MUTATION_CONTRACT_STAGE;
  const previousOnDemandRepairEnabled = process.env.COLLAB_ON_DEMAND_PROJECTION_REPAIR_ENABLED;
  process.env.COLLAB_ON_DEMAND_PROJECTION_REPAIR_ENABLED = '1';

  const [{ apiRoutes }, { agentRoutes }, db, collab] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/db.js'),
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

  try {
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
      },
      body: JSON.stringify({
        markdown: '# Canonical repair\n\nOriginal projection.',
        marks: {},
        title: 'Canonical repair',
      }),
    });
    const created = await mustJson<CreateResponse>(createRes, 'create');

    const parser = await getHeadlessMilkdownParser();
    const canonicalMarkdown = '# Canonical repair\n\nRecovered from canonical Yjs.';
    const ydoc = new Y.Doc();
    ydoc.getText('markdown').insert(0, canonicalMarkdown);
    prosemirrorToYXmlFragment(parser.parseMarkdown(canonicalMarkdown) as any, ydoc.getXmlFragment('prosemirror') as any);
    db.saveYSnapshot(created.slug, 1, Y.encodeStateAsUpdate(ydoc));
    db.getDb().prepare(`
      UPDATE documents
      SET y_state_version = 1
      WHERE slug = ?
    `).run(created.slug);

    const corrupted = db.replaceDocumentProjection(created.slug, '# Broken projection\n\nWrong text.', {}, 1);
    assert(corrupted === true, 'Expected corrupted projection write to succeed');
    assert(
      db.getProjectedDocumentBySlug(created.slug)?.markdown.includes('Broken projection') === true,
      'Expected projection row to be corrupted before repair',
    );
    const canonicalBeforeRepair = db.getDocumentBySlug(created.slug);
    assert(Boolean(canonicalBeforeRepair), 'Expected canonical row before repair');

    const repairRes = await fetch(`${httpBase}/api/agent/${created.slug}/repair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({ by: 'owner:test' }),
    });
    const repaired = await mustJson<RepairResponse>(repairRes, 'repair');
    assert(repaired.success === true, 'Expected repair success');
    assert(repaired.health === 'healthy', `Expected repaired document health=healthy, got ${repaired.health}`);
    const canonicalAfterRepair = db.getDocumentBySlug(created.slug);
    assert(
      canonicalAfterRepair?.markdown === canonicalBeforeRepair?.markdown,
      'Expected /repair to heal projection without mutating canonical markdown',
    );
    assert(
      canonicalAfterRepair?.revision === canonicalBeforeRepair?.revision,
      'Expected /repair not to bump canonical revision',
    );
    assert(
      canonicalAfterRepair?.updated_at === canonicalBeforeRepair?.updated_at,
      'Expected /repair not to change canonical updated_at',
    );
    assert(
      db.getProjectedDocumentBySlug(created.slug)?.markdown.includes('Recovered from canonical Yjs.') === true,
      'Expected repair to rebuild projection from canonical Yjs state',
    );

    const cloneRes = await fetch(`${httpBase}/api/agent/${created.slug}/clone-from-canonical`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({ by: 'owner:test' }),
    });
    const clone = await mustJson<CloneResponse>(cloneRes, 'clone-from-canonical');
    assert(clone.success === true, 'Expected clone-from-canonical success');
    assert(typeof clone.cloneSlug === 'string' && clone.cloneSlug.length > 0, 'Expected clone slug');
    assert(typeof clone.ownerSecret === 'string' && clone.ownerSecret.length > 0, 'Expected clone owner secret');

    const cloneStateRes = await fetch(`${httpBase}/api/agent/${clone.cloneSlug}/state`, {
      headers: {
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
        'x-share-token': clone.ownerSecret as string,
      },
    });
    const cloneState = await mustJson<StateResponse>(cloneStateRes, 'clone state');
    const cloneMarkdown = typeof cloneState.markdown === 'string' ? cloneState.markdown : (cloneState.content ?? '');
    assert(cloneMarkdown.includes('Recovered from canonical Yjs.'), 'Expected cloned doc to preserve canonical content');
    const canonicalAfterClone = db.getDocumentBySlug(created.slug);
    assert(
      canonicalAfterClone?.markdown === canonicalBeforeRepair?.markdown,
      'Expected /clone-from-canonical not to mutate the source canonical markdown',
    );
    assert(
      canonicalAfterClone?.revision === canonicalBeforeRepair?.revision,
      'Expected /clone-from-canonical not to bump the source canonical revision',
    );
    assert(
      canonicalAfterClone?.updated_at === canonicalBeforeRepair?.updated_at,
      'Expected /clone-from-canonical not to change the source canonical updated_at',
    );

    const shortRowMarkdown = [
      '# Stale row',
      '',
      'This row is intentionally short and stale.',
      '',
      'It should still recover from the authoritative Yjs snapshot.',
    ].join('\n');
    const largeCanonicalSections = Array.from({ length: 1200 }, (_, index) => [
      `## Recovered section ${index + 1}`,
      '',
      `- canonical recovery line ${index + 1} alpha beta gamma delta epsilon zeta eta theta`,
      `- canonical recovery line ${index + 1} iota kappa lambda mu nu xi omicron pi rho sigma`,
      `- canonical recovery line ${index + 1} tau upsilon phi chi psi omega replay-safe payload`,
      '',
    ].join('\n'));
    const largeCanonicalMarkdown = [
      '# Large canonical recovery',
      '',
      ...largeCanonicalSections,
      'Recovered from canonical Yjs authority.',
    ].join('\n');
    assert(
      largeCanonicalMarkdown.length > 70_000,
      `Expected large recovery fixture to exceed guardrail scale, got ${largeCanonicalMarkdown.length} chars`,
    );

    const shortRowRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
      },
      body: JSON.stringify({
        markdown: shortRowMarkdown,
        marks: {},
        title: 'Short row repair regression',
      }),
    });
    const shortRowCreated = await mustJson<CreateResponse>(shortRowRes, 'create short row');

    const largeYdoc = new Y.Doc();
    largeYdoc.getText('markdown').insert(0, largeCanonicalMarkdown);
    prosemirrorToYXmlFragment(parser.parseMarkdown(largeCanonicalMarkdown) as any, largeYdoc.getXmlFragment('prosemirror') as any);
    db.saveYSnapshot(shortRowCreated.slug, 1, Y.encodeStateAsUpdate(largeYdoc));
    db.getDb().prepare(`
      UPDATE documents
      SET y_state_version = 1
      WHERE slug = ?
    `).run(shortRowCreated.slug);
    db.setDocumentProjectionHealth(shortRowCreated.slug, 'quarantined');

    const shortRowRepairRes = await fetch(`${httpBase}/api/agent/${shortRowCreated.slug}/repair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
        'x-share-token': shortRowCreated.ownerSecret,
      },
      body: JSON.stringify({ by: 'owner:test' }),
    });
    const shortRowRepair = await mustJson<RepairResponse>(shortRowRepairRes, 'repair short row');
    assert(shortRowRepair.success === true, 'Expected owner repair to bypass stale-row growth guard for authoritative Yjs recovery');
    assert(
      db.getProjectedDocumentBySlug(shortRowCreated.slug)?.markdown.includes('Recovered from canonical Yjs authority.') === true,
      'Expected owner repair to rebuild a large projection from authoritative Yjs state even when the row is short',
    );

    const shortRowCloneRes = await fetch(`${httpBase}/api/agent/${shortRowCreated.slug}/clone-from-canonical`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
        'x-share-token': shortRowCreated.ownerSecret,
      },
      body: JSON.stringify({ by: 'owner:test' }),
    });
    const shortRowClone = await mustJson<CloneResponse>(shortRowCloneRes, 'clone short row');
    assert(shortRowClone.success === true, 'Expected clone-from-canonical to inherit large authoritative repair success');

    const shortRowCloneStateRes = await fetch(`${httpBase}/api/agent/${shortRowClone.cloneSlug}/state`, {
      headers: {
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
        'x-share-token': shortRowClone.ownerSecret as string,
      },
    });
    const shortRowCloneState = await mustJson<StateResponse>(shortRowCloneStateRes, 'clone short row state');
    const shortRowCloneMarkdown = typeof shortRowCloneState.markdown === 'string'
      ? shortRowCloneState.markdown
      : (shortRowCloneState.content ?? '');
    assert(
      shortRowCloneMarkdown.includes('Recovered from canonical Yjs authority.'),
      'Expected clone-from-canonical to preserve large authoritative content recovered from Yjs',
    );
    const shortRowCloneDoc = db.getDocumentBySlug(shortRowClone.cloneSlug);
    assert(
      (shortRowCloneDoc?.y_state_version ?? 0) > 0,
      `Expected clone-from-canonical to persist nonzero Yjs state, got ${String(shortRowCloneDoc?.y_state_version)}`,
    );
    const shortRowCloneSnapshot = db.getLatestYSnapshot(shortRowClone.cloneSlug);
    assert(shortRowCloneSnapshot !== null, 'Expected clone-from-canonical to persist an authoritative Yjs snapshot');
    const cloneHandle = await collab.loadCanonicalYDoc(shortRowClone.cloneSlug, { liveRequired: false });
    assert(cloneHandle !== null, 'Expected to load canonical Yjs for the recovered clone');
    try {
      const cloneYdocMarkdown = cloneHandle!.ydoc.getText('markdown').toString();
      assert(
        cloneYdocMarkdown.includes('Recovered from canonical Yjs authority.'),
        'Expected recovered clone canonical Yjs markdown to preserve the repaired authoritative content',
      );
      assert(
        cloneHandle!.ydoc.getXmlFragment('prosemirror').length > 0,
        'Expected recovered clone canonical Yjs state to include a non-empty fragment',
      );
    } finally {
      await cloneHandle?.cleanup?.();
    }

    const integrityRepairCreateRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
      },
      body: JSON.stringify({
        markdown: '# Integrity specimen\n\nCanonical row must stay fenced.',
        marks: {},
        title: 'Integrity repair specimen',
      }),
    });
    const integrityRepairCreated = await mustJson<CreateResponse>(integrityRepairCreateRes, 'create integrity repair specimen');
    const integrityProjectionMarkdown = '# Integrity specimen\n\nRecovered projection content.';
    const integrityRepairYdoc = new Y.Doc();
    integrityRepairYdoc.getText('markdown').insert(0, integrityProjectionMarkdown);
    prosemirrorToYXmlFragment(parser.parseMarkdown(integrityProjectionMarkdown) as any, integrityRepairYdoc.getXmlFragment('prosemirror') as any);
    db.saveYSnapshot(integrityRepairCreated.slug, 1, Y.encodeStateAsUpdate(integrityRepairYdoc));
    db.getDb().prepare(`
      UPDATE documents
      SET y_state_version = 1
      WHERE slug = ?
    `).run(integrityRepairCreated.slug);
    db.setDocumentProjectionHealth(integrityRepairCreated.slug, 'quarantined', 'integrity_warning_repeated_heading_loop');

    const integrityRepairRunRes = await fetch(`${httpBase}/api/agent/${integrityRepairCreated.slug}/repair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
        'x-share-token': integrityRepairCreated.ownerSecret,
      },
      body: JSON.stringify({ by: 'owner:test' }),
    });
    const integrityRepair = await mustJson<RepairResponse>(integrityRepairRunRes, 'repair integrity specimen');
    assert(integrityRepair.success === true, 'Expected integrity specimen repair success');
    assert(integrityRepair.health === 'quarantined', `Expected integrity specimen repair to preserve quarantine, got ${String(integrityRepair.health)}`);
    assert(
      integrityRepair.healthReason === 'integrity_warning_repeated_heading_loop',
      `Expected integrity specimen repair to preserve healthReason, got ${String(integrityRepair.healthReason)}`,
    );
    assert(
      db.getDocumentProjectionBySlug(integrityRepairCreated.slug)?.health_reason === 'integrity_warning_repeated_heading_loop',
      'Expected integrity specimen repair to keep the durable integrity quarantine reason',
    );

    const failedRepairSlug = `failed-repair-${Math.random().toString(36).slice(2, 10)}`;
    const failedRepairMarkdown = '# Failed repair\n\nThis document keeps its rollback state.';
    const failedRepairRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
      },
      body: JSON.stringify({
        markdown: failedRepairMarkdown,
        marks: {},
        title: 'Failed repair regression',
      }),
    });
    const failedRepairCreated = await mustJson<CreateResponse>(failedRepairRes, 'create failed repair doc');
    db.saveYSnapshot(failedRepairCreated.slug, 1, new Uint8Array([255, 0, 255, 0]));
    db.getDb().prepare(`
      UPDATE documents
      SET y_state_version = 1
      WHERE slug = ?
    `).run(failedRepairCreated.slug);

    const repairFailureResponse = await fetch(`${httpBase}/api/agent/${failedRepairCreated.slug}/repair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
        'x-share-token': failedRepairCreated.ownerSecret,
      },
      body: JSON.stringify({ by: 'owner:test' }),
    });
    assert(repairFailureResponse.status === 409, `Expected failed repair to return 409, got ${repairFailureResponse.status}`);
    const failedRepairBody = await repairFailureResponse.json() as { code?: string };
    assert(
      failedRepairBody.code === 'CANONICAL_DOC_INVALID',
      `Expected failed repair to report CANONICAL_DOC_INVALID, got ${String(failedRepairBody.code)}`,
    );
    const preservedSnapshot = db.getLatestYSnapshot(failedRepairCreated.slug);
    assert(preservedSnapshot !== null, 'Expected failed repair to preserve the original Yjs snapshot for later recovery');
    assert(
      preservedSnapshot?.snapshot.byteLength === 4,
      `Expected failed repair to preserve the original rollback snapshot bytes, got ${String(preservedSnapshot?.snapshot.byteLength)}`,
    );

    const replayGuardSlug = `replay-guard-${Math.random().toString(36).slice(2, 10)}`;
    const replayCanonicalMarkdown = [
      '# Stable Collab Roadmap',
      '',
      '## The Simple Story',
      '',
      'This roadmap should exist once in canonical storage.',
      '',
      '## What We Need To Do Next',
      '',
      '* Turn on repair flags carefully',
      '* Define recovery policy clearly',
      '* Root-cause pathological docs',
    ].join('\n');
    const replayCreateRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
      },
      body: JSON.stringify({
        markdown: replayCanonicalMarkdown,
        marks: {},
        title: 'Replay guard regression',
      }),
    });
    const replayCreated = await mustJson<CreateResponse>(replayCreateRes, 'create replay guard doc');
    const replayYdoc = new Y.Doc();
    const replayedMarkdown = [
      replayCanonicalMarkdown,
      replayCanonicalMarkdown,
      replayCanonicalMarkdown,
      replayCanonicalMarkdown,
    ].join('\n\n');
    replayYdoc.getText('markdown').insert(0, replayedMarkdown);
    prosemirrorToYXmlFragment(parser.parseMarkdown(replayedMarkdown) as any, replayYdoc.getXmlFragment('prosemirror') as any);
    db.saveYSnapshot(replayCreated.slug, 1, Y.encodeStateAsUpdate(replayYdoc));
    db.getDb().prepare(`
      UPDATE documents
      SET y_state_version = 1
      WHERE slug = ?
    `).run(replayCreated.slug);
    db.replaceDocumentProjection(replayCreated.slug, replayCanonicalMarkdown, {}, 1);
    db.getDb().prepare(`
      UPDATE document_projections
      SET health = 'projection_stale'
      WHERE document_slug = ?
    `).run(replayCreated.slug);

    const replayBefore = db.getDocumentBySlug(replayCreated.slug);
    const replayStateRes = await fetch(`${httpBase}/api/agent/${replayCreated.slug}/state`, {
      headers: {
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
        'x-share-token': replayCreated.ownerSecret,
      },
    });
    const replayState = await mustJson<StateResponse>(replayStateRes, 'state replay guard');
    const replayStateMarkdown = typeof replayState.markdown === 'string' ? replayState.markdown : (replayState.content ?? '');
    assert(
      replayStateMarkdown.includes('This roadmap should exist once in canonical storage.'),
      'Expected /state replay guard fallback to preserve last-known-safe source content',
    );
    const replayRepairRes = await fetch(`${httpBase}/api/agent/${replayCreated.slug}/repair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
        'x-share-token': replayCreated.ownerSecret,
      },
      body: JSON.stringify({ by: 'owner:test' }),
    });
    assert(replayRepairRes.status === 409, `Expected pathological replay /repair to fail closed, got ${replayRepairRes.status}`);
    const replayRepairBody = await replayRepairRes.json() as { code?: string };
    assert(
      replayRepairBody.code === 'REPAIR_GUARD_BLOCKED',
      `Expected pathological replay /repair to report REPAIR_GUARD_BLOCKED, got ${String(replayRepairBody.code)}`,
    );
    const replayCloneRes = await fetch(`${httpBase}/api/agent/${replayCreated.slug}/clone-from-canonical`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
        'x-share-token': replayCreated.ownerSecret,
      },
      body: JSON.stringify({ by: 'owner:test' }),
    });
    assert(replayCloneRes.status === 409, `Expected pathological replay /clone-from-canonical to fail closed, got ${replayCloneRes.status}`);
    const replayCloneBody = await replayCloneRes.json() as { code?: string };
    assert(
      replayCloneBody.code === 'REPAIR_GUARD_BLOCKED',
      `Expected pathological replay /clone-from-canonical to report REPAIR_GUARD_BLOCKED, got ${String(replayCloneBody.code)}`,
    );
    const replayAfter = db.getDocumentBySlug(replayCreated.slug);
    assert(
      replayAfter?.markdown === replayBefore?.markdown,
      'Expected replay-guarded /state,/repair,/clone flows to preserve the last-known-safe canonical row',
    );
    assert(
      replayAfter?.revision === replayBefore?.revision,
      'Expected replay-guarded flows not to bump canonical revision',
    );
    assert(
      replayAfter?.updated_at === replayBefore?.updated_at,
      'Expected replay-guarded flows not to change canonical updated_at',
    );

    process.env.PROOF_MUTATION_CONTRACT_STAGE = 'B';

    const repairIdempotencyKey = `repair-${Math.random().toString(36).slice(2)}`;
    const repairReplayA = await fetch(`${httpBase}/api/agent/${shortRowCreated.slug}/repair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': repairIdempotencyKey,
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
        'x-share-token': shortRowCreated.ownerSecret,
      },
      body: JSON.stringify({ by: 'owner:test' }),
    });
    const repairReplayBodyA = await mustJson<RepairResponse>(repairReplayA, 'repair replay A');
    const repairReplayB = await fetch(`${httpBase}/api/agent/${shortRowCreated.slug}/repair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': repairIdempotencyKey,
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
        'x-share-token': shortRowCreated.ownerSecret,
      },
      body: JSON.stringify({ by: 'owner:test' }),
    });
    const repairReplayBodyB = await mustJson<RepairResponse>(repairReplayB, 'repair replay B');
    assert(
      JSON.stringify(repairReplayBodyA) === JSON.stringify(repairReplayBodyB),
      'Expected repeated /repair requests with the same idempotency key to replay the first response body exactly',
    );

    const cloneIdempotencyKey = `clone-${Math.random().toString(36).slice(2)}`;
    const cloneReplayARes = await fetch(`${httpBase}/api/agent/${created.slug}/clone-from-canonical`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': cloneIdempotencyKey,
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({ by: 'owner:test' }),
    });
    const cloneReplayA = await mustJson<CloneResponse>(cloneReplayARes, 'clone replay A');
    const cloneReplayBRes = await fetch(`${httpBase}/api/agent/${created.slug}/clone-from-canonical`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': cloneIdempotencyKey,
        'X-Proof-Client-Version': '0.31.2',
        'X-Proof-Client-Build': 'tests',
        'X-Proof-Client-Protocol': '3',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({ by: 'owner:test' }),
    });
    const cloneReplayB = await mustJson<CloneResponse>(cloneReplayBRes, 'clone replay B');
    assert(
      JSON.stringify(cloneReplayA) === JSON.stringify(cloneReplayB),
      'Expected repeated /clone-from-canonical requests with the same idempotency key to replay the first response body exactly',
    );
    assert(
      cloneReplayA.cloneSlug === cloneReplayB.cloneSlug,
      'Expected /clone-from-canonical idempotency replay to preserve the original clone slug',
    );

    console.log('✓ canonical repair, on-demand read, and clone-from-canonical stay projection-only and fail closed on replayed Yjs repairs');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousMutationStage === undefined) {
      delete process.env.PROOF_MUTATION_CONTRACT_STAGE;
    } else {
      process.env.PROOF_MUTATION_CONTRACT_STAGE = previousMutationStage;
    }
    if (previousOnDemandRepairEnabled === undefined) {
      delete process.env.COLLAB_ON_DEMAND_PROJECTION_REPAIR_ENABLED;
    } else {
      process.env.COLLAB_ON_DEMAND_PROJECTION_REPAIR_ENABLED = previousOnDemandRepairEnabled;
    }
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
