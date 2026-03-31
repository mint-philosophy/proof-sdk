import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalizeStoredMarks, type StoredMark } from '../formats/marks.js';
import { stripAllProofSpanTags } from '../../server/proof-span-strip.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function run(): Promise<void> {
  const dbName = `proof-select-all-accept-all-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  delete process.env.PROOF_DB_ENV_INIT;

  const db = await import('../../server/db.ts');
  const { executeDocumentOperationAsync } = await import('../../server/document-engine.ts');
  const { __agentRoutesMarkMutationSnapshotForTests } = await import('../../server/agent-routes.ts');

  try {
    const createdAt = new Date('2026-03-30T12:00:00.000Z').toISOString();

    const deleteOnlySlug = `select-all-delete-${Math.random().toString(36).slice(2, 10)}`;
    const deleteOnlyMarks: Record<string, StoredMark> = canonicalizeStoredMarks({
      'delete-heading': {
        kind: 'delete',
        by: 'human:test',
        createdAt,
        quote: 'Untitled',
        status: 'pending',
      },
      'delete-body': {
        kind: 'delete',
        by: 'human:test',
        createdAt,
        quote: 'Alpha beta gamma delta.',
        status: 'pending',
      },
    });
    db.createDocument(
      deleteOnlySlug,
      [
        '<span data-proof="suggestion" data-id="delete-heading" data-by="human:test" data-kind="delete">Untitled</span>',
        '',
        '<span data-proof="suggestion" data-id="delete-body" data-by="human:test" data-kind="delete">Alpha beta gamma delta.</span>',
        '',
      ].join('\n'),
      deleteOnlyMarks,
      'Select-all delete accept-all regression',
    );

    const deleteOnlyResult = await executeDocumentOperationAsync(deleteOnlySlug, 'POST', '/marks/accept-all', {
      by: 'human:reviewer',
      markIds: ['delete-heading', 'delete-body'],
    });
    assertEqual(deleteOnlyResult.status, 200, `Expected select-all delete accept-all to succeed, got ${deleteOnlyResult.status}`);
    const deleteOnlyDoc = db.getDocumentBySlug(deleteOnlySlug);
    const deleteOnlyStoredMarks = deleteOnlyDoc?.marks
      ? JSON.parse(deleteOnlyDoc.marks) as Record<string, StoredMark>
      : {};
    assertEqual(
      Object.keys(deleteOnlyStoredMarks).length,
      0,
      `Expected select-all delete accept-all to clear all stored marks, got ${JSON.stringify(deleteOnlyStoredMarks)}`,
    );
    assert(
      !String(deleteOnlyDoc?.markdown ?? '').includes('data-proof="suggestion"'),
      `Expected select-all delete accept-all to remove all wrappers, got ${JSON.stringify(deleteOnlyDoc?.markdown)}`,
    );

    const replaceSlug = `select-all-replace-${Math.random().toString(36).slice(2, 10)}`;
    const replaceMarks: Record<string, StoredMark> = canonicalizeStoredMarks({
      'replace-insert': {
        kind: 'insert',
        by: 'human:test',
        createdAt,
        quote: 'Replacement text.',
        content: 'Replacement text.',
        status: 'pending',
      },
      'replace-delete-heading': {
        kind: 'delete',
        by: 'human:test',
        createdAt,
        quote: 'Untitled',
        status: 'pending',
      },
      'replace-delete-body': {
        kind: 'delete',
        by: 'human:test',
        createdAt,
        quote: 'Alpha beta gamma delta.',
        status: 'pending',
      },
    });
    db.createDocument(
      replaceSlug,
      [
        '<span data-proof="suggestion" data-id="replace-delete-heading" data-by="human:test" data-kind="delete">Untitled</span>',
        '',
        '<span data-proof="suggestion" data-id="replace-delete-body" data-by="human:test" data-kind="delete">Alpha beta gamma delta.</span>',
        '<span data-proof="suggestion" data-id="replace-insert" data-by="human:test" data-kind="insert">Replacement text.</span>',
        '',
      ].join('\n'),
      replaceMarks,
      'Select-all paste accept-all regression',
    );

    const replaceResult = await executeDocumentOperationAsync(replaceSlug, 'POST', '/marks/accept-all', {
      by: 'human:reviewer',
      markIds: ['replace-insert', 'replace-delete-heading', 'replace-delete-body'],
    });
    assertEqual(replaceResult.status, 200, `Expected select-all replace accept-all to succeed, got ${replaceResult.status}`);
    const replaceDoc = db.getDocumentBySlug(replaceSlug);
    const replaceStoredMarks = replaceDoc?.marks
      ? JSON.parse(replaceDoc.marks) as Record<string, StoredMark>
      : {};
    assertEqual(
      Object.keys(replaceStoredMarks).length,
      0,
      `Expected select-all replace accept-all to clear all stored marks, got ${JSON.stringify(replaceStoredMarks)}`,
    );
    assert(
      !String(replaceDoc?.markdown ?? '').includes('data-proof="suggestion"'),
      `Expected select-all replace accept-all to remove all wrappers, got ${JSON.stringify(replaceDoc?.markdown)}`,
    );
    assert(
      stripAllProofSpanTags(String(replaceDoc?.markdown ?? '')).includes('Replacement text.'),
      `Expected select-all replace accept-all to preserve replacement text, got ${JSON.stringify(replaceDoc?.markdown)}`,
    );

    const canonicalSnapshotSlug = `select-all-canonical-snapshot-${Math.random().toString(36).slice(2, 10)}`;
    const canonicalSnapshotMarks: Record<string, StoredMark> = canonicalizeStoredMarks({
      'snapshot-delete-all': {
        kind: 'delete',
        by: 'human:user',
        createdAt,
        status: 'pending',
        quote: 'Alpha beta. Gamma delta.',
        range: { from: 1, to: 26 },
        startRel: 'char:0',
        endRel: 'char:24',
      },
      'snapshot-insert-all': {
        kind: 'insert',
        by: 'human:user',
        createdAt,
        status: 'pending',
        content: 'REPLACED',
        quote: 'REPLACED',
        range: { from: 28, to: 28 },
        startRel: 'char:25',
        endRel: 'char:33',
      },
    });
    db.createDocument(
      canonicalSnapshotSlug,
      [
        '<span data-proof="suggestion" data-id="snapshot-delete-all" data-by="human:user" data-kind="delete">Alpha beta.\nGamma delta.</span>',
        '<span data-proof="suggestion" data-id="snapshot-insert-all" data-by="human:user" data-kind="insert">REPLACED</span>',
      ].join('\n'),
      canonicalSnapshotMarks,
      'Select-all canonical snapshot accept-all regression',
    );

    const canonicalSnapshotResult = await executeDocumentOperationAsync(canonicalSnapshotSlug, 'POST', '/marks/accept-all', {
      by: 'human:reviewer',
      markIds: ['snapshot-delete-all', 'snapshot-insert-all'],
    });
    assertEqual(
      canonicalSnapshotResult.status,
      200,
      `Expected select-all canonical snapshot accept-all to succeed, got ${canonicalSnapshotResult.status}`,
    );
    const canonicalSnapshotDoc = db.getDocumentBySlug(canonicalSnapshotSlug);
    const canonicalSnapshotStoredMarks = canonicalSnapshotDoc?.marks
      ? JSON.parse(canonicalSnapshotDoc.marks) as Record<string, StoredMark>
      : {};
    assertEqual(
      Object.keys(canonicalSnapshotStoredMarks).length,
      0,
      `Expected select-all canonical snapshot accept-all to clear all stored marks, got ${JSON.stringify(canonicalSnapshotStoredMarks)}`,
    );
    assert(
      !String(canonicalSnapshotDoc?.markdown ?? '').includes('data-proof="suggestion"'),
      `Expected select-all canonical snapshot accept-all to remove all wrappers, got ${JSON.stringify(canonicalSnapshotDoc?.markdown)}`,
    );
    assert(
      stripAllProofSpanTags(String(canonicalSnapshotDoc?.markdown ?? '')).includes('REPLACED'),
      `Expected select-all canonical snapshot accept-all to preserve replacement text, got ${JSON.stringify(canonicalSnapshotDoc?.markdown)}`,
    );

    const flattenedQuoteSlug = `select-all-flattened-quote-${Math.random().toString(36).slice(2, 10)}`;
    const flattenedPersistedMarkdown = '# Untitled\n\nthe entire document content.\n\nNEW TEXT\n';
    const flattenedDeleteVisible = 'Untitled\nthe entire document content.';
    const flattenedInsertVisible = 'NEW TEXT';
    const flattenedInsertStart = `${flattenedDeleteVisible}\n`.length;
    const flattenedQuoteMarks: Record<string, StoredMark> = canonicalizeStoredMarks({
      'flattened-select-all-delete': {
        kind: 'delete',
        by: 'human:user',
        createdAt,
        status: 'pending',
        quote: 'Untitledthe entire document content.',
        startRel: 'char:0',
        endRel: `char:${flattenedDeleteVisible.length}`,
      },
      'flattened-select-all-insert': {
        kind: 'insert',
        by: 'human:user',
        createdAt,
        status: 'pending',
        content: flattenedInsertVisible,
        quote: flattenedInsertVisible,
        startRel: `char:${flattenedInsertStart}`,
        endRel: `char:${flattenedInsertStart + flattenedInsertVisible.length}`,
      },
    });
    db.createDocument(
      flattenedQuoteSlug,
      flattenedPersistedMarkdown,
      flattenedQuoteMarks,
      'Select-all flattened quote accept-all regression',
    );

    const flattenedQuoteResult = await executeDocumentOperationAsync(flattenedQuoteSlug, 'POST', '/marks/accept-all', {
      by: 'human:reviewer',
      markIds: ['flattened-select-all-delete', 'flattened-select-all-insert'],
    });
    assertEqual(
      flattenedQuoteResult.status,
      200,
      `Expected flattened select-all quote accept-all to succeed, got ${flattenedQuoteResult.status}: ${JSON.stringify(flattenedQuoteResult.body)}`,
    );
    const flattenedQuoteDoc = db.getDocumentBySlug(flattenedQuoteSlug);
    const flattenedQuoteStoredMarks = flattenedQuoteDoc?.marks
      ? JSON.parse(flattenedQuoteDoc.marks) as Record<string, StoredMark>
      : {};
    assertEqual(
      Object.keys(flattenedQuoteStoredMarks).length,
      0,
      `Expected flattened select-all quote accept-all to clear all stored marks, got ${JSON.stringify(flattenedQuoteStoredMarks)}`,
    );
    const flattenedQuoteVisible = stripAllProofSpanTags(String(flattenedQuoteDoc?.markdown ?? ''));
    assert(
      flattenedQuoteVisible.includes('NEW TEXT'),
      `Expected flattened select-all quote accept-all to preserve replacement text, got ${JSON.stringify(flattenedQuoteDoc?.markdown)}`,
    );
    assert(
      !flattenedQuoteVisible.includes('Untitled') && !flattenedQuoteVisible.includes('the entire document content.'),
      `Expected flattened select-all quote accept-all to remove the deleted heading/body text, got ${JSON.stringify(flattenedQuoteDoc?.markdown)}`,
    );

    const routeSnapshotSlug = `select-all-route-snapshot-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(
      routeSnapshotSlug,
      'Alpha beta.\nGamma delta.\n',
      {},
      'Select-all route snapshot accept-all regression',
    );
    const routeSnapshotDoc = db.getDocumentBySlug(routeSnapshotSlug);
    assert(routeSnapshotDoc, 'Expected route snapshot fixture document to exist');
    const routeSnapshotMarkdown = [
      '<span data-proof="suggestion" data-id="route-select-all-delete" data-by="human:user" data-kind="delete">Alpha beta.\nGamma delta.</span>',
      '<span data-proof="suggestion" data-id="route-select-all-insert" data-by="human:user" data-kind="insert">REPLACED</span>',
    ].join('\n');
    const routeSnapshotMarks: Record<string, StoredMark> = canonicalizeStoredMarks({
      'route-select-all-delete': {
        kind: 'delete',
        by: 'human:user',
        createdAt,
        status: 'pending',
        quote: 'Alpha beta. Gamma delta.',
        range: { from: 1, to: 26 },
        startRel: 'char:0',
        endRel: 'char:24',
      },
      'route-select-all-insert': {
        kind: 'insert',
        by: 'human:user',
        createdAt,
        status: 'pending',
        content: 'REPLACED',
        quote: 'REPLACED',
        range: { from: 28, to: 28 },
        startRel: 'char:25',
        endRel: 'char:33',
      },
    });
    const overlaidRouteSnapshotContext = __agentRoutesMarkMutationSnapshotForTests.overlayMarkMutationPayloadSnapshot(
      {
        doc: {
          ...(routeSnapshotDoc as Record<string, unknown>),
          plain_text: routeSnapshotDoc.markdown,
          read_source: 'projection',
        },
        mutationBase: {
          token: 'mt1:select-all-route-snapshot',
          source: 'live_yjs',
          schemaVersion: 'mt1',
          markdown: routeSnapshotDoc.markdown,
          marks: {},
        },
        precondition: {
          mode: 'revision',
          baseRevision: routeSnapshotDoc.revision,
        },
      } as any,
      {
        by: 'human:reviewer',
        markIds: ['route-select-all-delete', 'route-select-all-insert'],
        markdown: routeSnapshotMarkdown,
        marks: routeSnapshotMarks,
      },
    );
    const routeSnapshotResult = await executeDocumentOperationAsync(
      routeSnapshotSlug,
      'POST',
      '/marks/accept-all',
      {
        by: 'human:reviewer',
        markIds: ['route-select-all-delete', 'route-select-all-insert'],
        markdown: routeSnapshotMarkdown,
        marks: routeSnapshotMarks,
      },
      overlaidRouteSnapshotContext as any,
    );
    assertEqual(
      routeSnapshotResult.status,
      200,
      `Expected overlaid select-all route snapshot accept-all to succeed, got ${routeSnapshotResult.status}: ${JSON.stringify(routeSnapshotResult.body)}`,
    );
    const acceptedRouteSnapshotDoc = db.getDocumentBySlug(routeSnapshotSlug);
    const acceptedRouteSnapshotMarks = acceptedRouteSnapshotDoc?.marks
      ? JSON.parse(acceptedRouteSnapshotDoc.marks) as Record<string, StoredMark>
      : {};
    assertEqual(
      Object.keys(acceptedRouteSnapshotMarks).length,
      0,
      `Expected overlaid select-all route snapshot accept-all to clear all stored marks, got ${JSON.stringify(acceptedRouteSnapshotMarks)}`,
    );
    assertEqual(
      stripAllProofSpanTags(String(acceptedRouteSnapshotDoc?.markdown ?? '')).trim(),
      'REPLACED',
      `Expected overlaid select-all route snapshot accept-all to preserve only replacement text, got ${JSON.stringify(acceptedRouteSnapshotDoc?.markdown)}`,
    );

    console.log('select-all-accept-all-engine-regression.test.ts passed');
  } finally {
    try {
      unlinkSync(dbPath);
    } catch {
      // Ignore temp DB cleanup failures.
    }

    process.env.DATABASE_PATH = prevDatabasePath;
    process.env.PROOF_ENV = prevProofEnv;
    process.env.NODE_ENV = prevNodeEnv;
    if (prevDbEnvInit === undefined) {
      delete process.env.PROOF_DB_ENV_INIT;
    } else {
      process.env.PROOF_DB_ENV_INIT = prevDbEnvInit;
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
