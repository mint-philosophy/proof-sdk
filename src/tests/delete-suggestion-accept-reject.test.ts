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
  const dbName = `proof-delete-suggestion-review-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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

  try {
    const createdAt = new Date('2026-03-26T12:00:00.000Z').toISOString();
    const reviewMarkup = (markId: string) =>
      `Alpha <span data-proof="suggestion" data-id="${markId}" data-by="human:test" data-kind="delete">beta</span> gamma.`;
    const buildDeleteMark = (): StoredMark => ({
      kind: 'delete',
      by: 'human:test',
      createdAt,
      quote: 'beta',
      status: 'pending',
      startRel: 'char:6',
      endRel: 'char:10',
      range: { from: 7, to: 11 },
    });

    const acceptMarkId = 'delete-accept-mark';
    const acceptSlug = `delete-accept-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(
      acceptSlug,
      reviewMarkup(acceptMarkId),
      canonicalizeStoredMarks({ [acceptMarkId]: buildDeleteMark() }),
      'Delete suggestion accept regression',
    );

    const acceptResult = await executeDocumentOperationAsync(acceptSlug, 'POST', '/marks/accept', {
      markId: acceptMarkId,
      by: 'human:reviewer',
    });
    assertEqual(acceptResult.status, 200, `Expected delete accept to succeed, got ${acceptResult.status}`);
    const acceptedDoc = db.getDocumentBySlug(acceptSlug);
    assertEqual(
      stripAllProofSpanTags(acceptedDoc?.markdown ?? '').trim(),
      'Alpha gamma.',
      'Expected accepting a normal delete suggestion to remove the deleted text and wrapper without leaving doubled spacing',
    );
    assert(
      !acceptedDoc?.markdown.includes(`data-id="${acceptMarkId}"`),
      'Expected accepting a normal delete suggestion to remove the suggestion span wrapper',
    );
    const acceptedMarks = acceptedDoc?.marks ? JSON.parse(acceptedDoc.marks) as Record<string, StoredMark> : {};
    assert(!(acceptMarkId in acceptedMarks), 'Expected accepting a normal delete suggestion to remove stored mark metadata');

    const rejectMarkId = 'delete-reject-mark';
    const rejectSlug = `delete-reject-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(
      rejectSlug,
      reviewMarkup(rejectMarkId),
      canonicalizeStoredMarks({ [rejectMarkId]: buildDeleteMark() }),
      'Delete suggestion reject regression',
    );

    const rejectResult = await executeDocumentOperationAsync(rejectSlug, 'POST', '/marks/reject', {
      markId: rejectMarkId,
      by: 'human:reviewer',
    });
    assertEqual(rejectResult.status, 200, `Expected delete reject to succeed, got ${rejectResult.status}`);
    const rejectedDoc = db.getDocumentBySlug(rejectSlug);
    assertEqual(
      stripAllProofSpanTags(rejectedDoc?.markdown ?? '').trim(),
      'Alpha beta gamma.',
      'Expected rejecting a normal delete suggestion to restore the original text and remove the wrapper',
    );
    assert(
      !rejectedDoc?.markdown.includes(`data-id="${rejectMarkId}"`),
      'Expected rejecting a normal delete suggestion to remove the suggestion span wrapper',
    );
    const rejectedMarks = rejectedDoc?.marks ? JSON.parse(rejectedDoc.marks) as Record<string, StoredMark> : {};
    assert(!(rejectMarkId in rejectedMarks), 'Expected rejecting a normal delete suggestion to remove stored mark metadata');

    const acceptAllSlug = `delete-accept-all-${Math.random().toString(36).slice(2, 10)}`;
    const acceptAllMarks: Record<string, StoredMark> = {
      'delete-accept-all-1': {
        kind: 'delete',
        by: 'human:test',
        createdAt,
        quote: 'obsolete',
        status: 'pending',
      },
      'delete-accept-all-2': {
        kind: 'delete',
        by: 'human:test',
        createdAt,
        quote: 'extra',
        status: 'pending',
      },
      'delete-accept-all-3': {
        kind: 'delete',
        by: 'human:test',
        createdAt,
        quote: 'draft',
        status: 'pending',
      },
      'delete-accept-all-4': {
        kind: 'delete',
        by: 'human:test',
        createdAt,
        quote: 'today',
        status: 'pending',
      },
    };
    db.createDocument(
      acceptAllSlug,
      [
        'The ',
        '<span data-proof="suggestion" data-id="delete-accept-all-1" data-by="human:test" data-kind="delete">obsolete</span>',
        ' important and ',
        '<span data-proof="suggestion" data-id="delete-accept-all-2" data-by="human:test" data-kind="delete">extra</span>',
        ' critical ',
        '<span data-proof="suggestion" data-id="delete-accept-all-3" data-by="human:test" data-kind="delete">draft</span>',
        ' analysis ',
        '<span data-proof="suggestion" data-id="delete-accept-all-4" data-by="human:test" data-kind="delete">today</span>',
        '.',
      ].join(''),
      canonicalizeStoredMarks(acceptAllMarks),
      'Delete suggestion accept-all whitespace regression',
    );

    const acceptAllResult = await executeDocumentOperationAsync(acceptAllSlug, 'POST', '/marks/accept-all', {
      by: 'human:reviewer',
      markIds: Object.keys(acceptAllMarks),
    });
    assertEqual(acceptAllResult.status, 200, `Expected delete accept-all to succeed, got ${acceptAllResult.status}`);
    const acceptAllDoc = db.getDocumentBySlug(acceptAllSlug);
    assertEqual(
      stripAllProofSpanTags(acceptAllDoc?.markdown ?? '').trim(),
      'The important and critical analysis.',
      'Expected accepting multiple delete suggestions to collapse doubled word gaps and remove the leftover space before punctuation',
    );
    const acceptAllStoredMarks = acceptAllDoc?.marks ? JSON.parse(acceptAllDoc.marks) as Record<string, StoredMark> : {};
    assertEqual(
      Object.keys(acceptAllStoredMarks).length,
      0,
      'Expected accepting all delete suggestions to remove their stored mark metadata',
    );

    console.log('delete-suggestion-accept-reject.test.ts passed');
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
