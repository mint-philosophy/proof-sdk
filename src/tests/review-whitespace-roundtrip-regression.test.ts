import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalizeStoredMarks, type StoredMark } from '../formats/marks.js';
import {
  canonicalizeVisibleTextBlockSeparators,
  stripMarkdownVisibleText,
} from '../shared/anchor-target-text.js';
import { stripAllProofSpanTags } from '../../server/proof-span-strip.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  }
}

function canonicalVisible(markdown: string): string {
  return canonicalizeVisibleTextBlockSeparators(stripMarkdownVisibleText(stripAllProofSpanTags(markdown)));
}

function buildDeleteMark(canonicalText: string, quote: string, createdAt: string): StoredMark {
  const start = canonicalText.indexOf(quote);
  if (start < 0) {
    throw new Error(`Quote not found in canonical visible text: ${quote}`);
  }
  return {
    kind: 'delete',
    by: 'human:test',
    createdAt,
    quote,
    status: 'pending',
    startRel: `char:${start}`,
    endRel: `char:${start + quote.length}`,
    range: { from: start, to: start + quote.length },
  };
}

async function run(): Promise<void> {
  const dbName = `proof-review-whitespace-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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
    const createdAt = new Date('2026-03-29T16:00:00.000Z').toISOString();

    const sequentialSlug = `review-trailing-space-${Math.random().toString(36).slice(2, 10)}`;
    const sequentialMarkdown = [
      'Intro paragraph with trailing space ',
      '',
      'Alpha <span data-proof="suggestion" data-id="review-space-1" data-by="human:test" data-kind="delete">beta</span> gamma.',
      '',
      'Delta <span data-proof="suggestion" data-id="review-space-2" data-by="human:test" data-kind="delete">epsilon</span> zeta.',
    ].join('\n');
    const sequentialCanonicalVisible = [
      'Intro paragraph with trailing space ',
      'Alpha beta gamma.',
      'Delta epsilon zeta.',
    ].join('\n');
    const sequentialMarks = canonicalizeStoredMarks({
      'review-space-1': buildDeleteMark(sequentialCanonicalVisible, 'beta', createdAt),
      'review-space-2': buildDeleteMark(sequentialCanonicalVisible, 'epsilon', createdAt),
    });
    db.createDocument(
      sequentialSlug,
      sequentialMarkdown,
      sequentialMarks,
      'Review trailing-space sequential accept regression',
    );

    const firstAccept = await executeDocumentOperationAsync(sequentialSlug, 'POST', '/marks/accept', {
      markId: 'review-space-2',
      by: 'human:reviewer',
    });
    assertEqual(firstAccept.status, 200, `Expected first accept over trailing-space doc to succeed, got ${firstAccept.status}`);

    const secondAccept = await executeDocumentOperationAsync(sequentialSlug, 'POST', '/marks/accept', {
      markId: 'review-space-1',
      by: 'human:reviewer',
    });
    assertEqual(
      secondAccept.status,
      200,
      `Expected second accept after trailing-space roundtrip to succeed, got ${secondAccept.status}: ${JSON.stringify(secondAccept.body)}`,
    );

    const sequentialDoc = db.getDocumentBySlug(sequentialSlug);
    assert(sequentialDoc, 'Expected sequential trailing-space regression doc to exist');
    const sequentialStoredMarks = sequentialDoc?.marks ? JSON.parse(sequentialDoc.marks) as Record<string, StoredMark> : {};
    assertEqual(
      Object.keys(sequentialStoredMarks).length,
      0,
      'Expected sequential accepts to clear all pending suggestion metadata after a trailing-space roundtrip',
    );
    assert(
      !String(sequentialDoc?.markdown ?? '').includes('data-proof="suggestion"'),
      'Expected sequential accepts to remove all suggestion wrappers after a trailing-space roundtrip',
    );
    const sequentialVisible = canonicalVisible(String(sequentialDoc?.markdown ?? ''));
    assert(
      sequentialVisible.includes('Alpha gamma.'),
      `Expected sequential accepts to preserve the first reviewed paragraph, got ${JSON.stringify(sequentialVisible)}`,
    );
    assert(
      /Delta\s+zeta\./.test(sequentialVisible),
      `Expected sequential accepts to preserve the second reviewed paragraph, got ${JSON.stringify(sequentialVisible)}`,
    );
    assert(
      !sequentialVisible.includes('epsilon'),
      `Expected sequential accepts to remove the second pending deletion text, got ${JSON.stringify(sequentialVisible)}`,
    );

    const rejectSequentialSlug = `review-trailing-space-reject-${Math.random().toString(36).slice(2, 10)}`;
    const rejectSequentialMarkdown = [
      'Intro paragraph with trailing space ',
      '',
      'Alpha <span data-proof="suggestion" data-id="review-space-reject-1" data-by="human:test" data-kind="delete">beta</span> gamma.',
      '',
      'Delta <span data-proof="suggestion" data-id="review-space-reject-2" data-by="human:test" data-kind="delete">epsilon</span> zeta.',
    ].join('\n');
    const rejectSequentialCanonicalVisible = [
      'Intro paragraph with trailing space ',
      'Alpha beta gamma.',
      'Delta epsilon zeta.',
    ].join('\n');
    const rejectSequentialMarks = canonicalizeStoredMarks({
      'review-space-reject-1': buildDeleteMark(rejectSequentialCanonicalVisible, 'beta', createdAt),
      'review-space-reject-2': buildDeleteMark(rejectSequentialCanonicalVisible, 'epsilon', createdAt),
    });
    db.createDocument(
      rejectSequentialSlug,
      rejectSequentialMarkdown,
      rejectSequentialMarks,
      'Review trailing-space sequential reject regression',
    );

    const firstReject = await executeDocumentOperationAsync(rejectSequentialSlug, 'POST', '/marks/reject', {
      markId: 'review-space-reject-2',
      by: 'human:reviewer',
    });
    assertEqual(firstReject.status, 200, `Expected first reject over trailing-space doc to succeed, got ${firstReject.status}`);

    const secondReject = await executeDocumentOperationAsync(rejectSequentialSlug, 'POST', '/marks/reject', {
      markId: 'review-space-reject-1',
      by: 'human:reviewer',
    });
    assertEqual(
      secondReject.status,
      200,
      `Expected second reject after trailing-space roundtrip to succeed, got ${secondReject.status}: ${JSON.stringify(secondReject.body)}`,
    );

    const rejectSequentialDoc = db.getDocumentBySlug(rejectSequentialSlug);
    assert(rejectSequentialDoc, 'Expected sequential trailing-space reject regression doc to exist');
    const rejectSequentialStoredMarks = rejectSequentialDoc?.marks
      ? JSON.parse(rejectSequentialDoc.marks) as Record<string, StoredMark>
      : {};
    assertEqual(
      Object.keys(rejectSequentialStoredMarks).length,
      0,
      'Expected sequential rejects to clear all pending suggestion metadata after a trailing-space roundtrip',
    );
    assert(
      !String(rejectSequentialDoc?.markdown ?? '').includes('data-proof="suggestion"'),
      'Expected sequential rejects to remove all suggestion wrappers after a trailing-space roundtrip',
    );
    const rejectSequentialVisible = canonicalVisible(String(rejectSequentialDoc?.markdown ?? ''));
    assert(
      rejectSequentialVisible.includes('Alpha beta gamma.'),
      `Expected sequential rejects to preserve the first reviewed paragraph text, got ${JSON.stringify(rejectSequentialVisible)}`,
    );
    assert(
      rejectSequentialVisible.includes('Delta epsilon zeta.'),
      `Expected sequential rejects to preserve the second reviewed paragraph text, got ${JSON.stringify(rejectSequentialVisible)}`,
    );

    const blankParagraphSlug = `review-empty-paragraph-${Math.random().toString(36).slice(2, 10)}`;
    const blankParagraphMarkdown = [
      'Top intro',
      '',
      '<br />',
      '',
      'Alpha <span data-proof="suggestion" data-id="review-blank-1" data-by="human:test" data-kind="delete">beta</span> gamma.',
      '',
      'Delta <span data-proof="suggestion" data-id="review-blank-2" data-by="human:test" data-kind="delete">epsilon</span> zeta.',
    ].join('\n');
    const blankParagraphCanonicalVisible = [
      'Top intro',
      '',
      'Alpha beta gamma.',
      'Delta epsilon zeta.',
    ].join('\n');
    const blankParagraphMarks = canonicalizeStoredMarks({
      'review-blank-1': buildDeleteMark(blankParagraphCanonicalVisible, 'beta', createdAt),
      'review-blank-2': buildDeleteMark(blankParagraphCanonicalVisible, 'epsilon', createdAt),
    });
    db.createDocument(
      blankParagraphSlug,
      blankParagraphMarkdown,
      blankParagraphMarks,
      'Review empty-paragraph accept-all regression',
    );

    const acceptAll = await executeDocumentOperationAsync(blankParagraphSlug, 'POST', '/marks/accept-all', {
      by: 'human:reviewer',
      markIds: ['review-blank-1', 'review-blank-2'],
    });
    assertEqual(
      acceptAll.status,
      200,
      `Expected accept-all over empty-paragraph doc to succeed, got ${acceptAll.status}: ${JSON.stringify(acceptAll.body)}`,
    );
    assertEqual(
      Number(acceptAll.body.acceptedCount ?? 0),
      2,
      'Expected accept-all over empty-paragraph doc to finalize both pending deletions',
    );

    const blankParagraphDoc = db.getDocumentBySlug(blankParagraphSlug);
    assert(blankParagraphDoc, 'Expected empty-paragraph regression doc to exist');
    const blankParagraphStoredMarks = blankParagraphDoc?.marks
      ? JSON.parse(blankParagraphDoc.marks) as Record<string, StoredMark>
      : {};
    assertEqual(
      Object.keys(blankParagraphStoredMarks).length,
      0,
      'Expected accept-all over empty-paragraph doc to clear all pending suggestion metadata',
    );
    assert(
      !String(blankParagraphDoc?.markdown ?? '').includes('data-proof="suggestion"'),
      'Expected accept-all over empty-paragraph doc to remove all suggestion wrappers',
    );
    const blankParagraphVisible = canonicalVisible(String(blankParagraphDoc?.markdown ?? ''));
    assert(
      blankParagraphVisible.includes('Alpha gamma.'),
      `Expected accept-all over empty-paragraph doc to preserve the first reviewed paragraph, got ${JSON.stringify(blankParagraphVisible)}`,
    );
    assert(
      /Delta\s+zeta\./.test(blankParagraphVisible),
      `Expected accept-all over empty-paragraph doc to preserve the second reviewed paragraph, got ${JSON.stringify(blankParagraphVisible)}`,
    );
    assert(
      !blankParagraphVisible.includes('epsilon'),
      `Expected accept-all over empty-paragraph doc to remove the second pending deletion text, got ${JSON.stringify(blankParagraphVisible)}`,
    );

    console.log('review-whitespace-roundtrip-regression.test.ts passed');
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
