import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalizeStoredMarks, type StoredMark } from '../formats/marks.js';
import { stripAllProofSpanTags } from '../../server/proof-span-strip.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  }
}

function buildRelativeAnchors(baseMarkdown: string, quote: string): { startRel: string; endRel: string; range: { from: number; to: number } } {
  const start = baseMarkdown.indexOf(quote);
  if (start < 0) {
    throw new Error(`Quote not found in base markdown: ${quote}`);
  }
  return {
    startRel: `char:${start}`,
    endRel: `char:${start + quote.length}`,
    range: {
      from: start + 1,
      to: start + 1 + Math.min(100, quote.length),
    },
  };
}

function parseStoredMarks(raw: unknown): Record<string, StoredMark> {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return canonicalizeStoredMarks(parsed as Record<string, StoredMark>);
  } catch {
    return {};
  }
}

async function run(): Promise<void> {
  const dbName = `structured-review-rehydration-gate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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
    const createdAt = new Date('2026-03-23T09:00:00.000Z').toISOString();
    const visibleAuthoredPrefix = 'A';
    const visibleAuthoredSuffix = 'A';
    const targetQuote = 'legacy target quote';
    const targetReplacement = 'accepted target text';
    const baseVisibleText = `${visibleAuthoredPrefix} ${targetQuote} ${visibleAuthoredSuffix}`;
    const targetAnchors = buildRelativeAnchors(baseVisibleText, targetQuote);
    const targetMarkId = 'target-suggestion';
    const staleSuggestionId = 'stale-suggestion';

    const authoredWrappedMarkdown = [
      `<span data-proof="authored" data-by="human:Test Editor">${visibleAuthoredPrefix}</span> `,
      `<span data-proof="suggestion" data-id="${targetMarkId}" data-by="ai:test" data-kind="replace">${targetQuote}</span> `,
      `<span data-proof="authored" data-by="human:Test Editor">${visibleAuthoredSuffix}</span>`,
    ].join('');

    const initialMarks = canonicalizeStoredMarks({
      [targetMarkId]: {
        kind: 'replace',
        by: 'ai:test',
        createdAt,
        quote: targetQuote,
        content: targetReplacement,
        status: 'pending',
        startRel: targetAnchors.startRel,
        endRel: targetAnchors.endRel,
        range: targetAnchors.range,
      } satisfies StoredMark,
      [staleSuggestionId]: {
        kind: 'replace',
        by: 'ai:test',
        createdAt,
        quote: 'orphaned suggestion',
        content: 'should be dropped',
        status: 'pending',
        startRel: 'char:999',
        endRel: 'char:1017',
        range: { from: 999, to: 1017 },
      } satisfies StoredMark,
    });

    const acceptSlug = `structured-gate-accept-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(acceptSlug, authoredWrappedMarkdown, initialMarks, 'Ignore authored + stale suggestion gate for accept');

    const acceptResult = await executeDocumentOperationAsync(acceptSlug, 'POST', '/marks/accept', {
      markId: targetMarkId,
      by: 'human:test',
    });
    assertEqual(acceptResult.status, 200, `Expected accept to ignore authored/stale gate failures, got ${acceptResult.status}`);
    const acceptedDoc = db.getDocumentBySlug(acceptSlug);
    assertEqual(
      stripAllProofSpanTags(acceptedDoc?.markdown ?? '').trim(),
      `${visibleAuthoredPrefix} ${targetReplacement} ${visibleAuthoredSuffix}`,
      'Expected accept to apply the target replacement while preserving authored text',
    );
    assertEqual(
      (acceptedDoc?.markdown.match(/data-proof="authored"[^>]*data-by="human:Test Editor"/g) ?? []).length,
      2,
      'Expected accept to preserve both visible authored wrappers',
    );
    const acceptedMarks = parseStoredMarks(acceptedDoc?.marks);
    assert(!(targetMarkId in acceptedMarks), 'Expected accept to remove the finalized target suggestion mark');
    assert(!(staleSuggestionId in acceptedMarks), 'Expected accept to drop unrelated stale suggestions that could not be rehydrated');

    const rejectTargetMarkId = `target-suggestion-reject-${Math.random().toString(36).slice(2, 8)}`;
    const rejectStaleSuggestionId = `stale-suggestion-reject-${Math.random().toString(36).slice(2, 8)}`;
    const rejectBaseVisibleText = `${visibleAuthoredPrefix} ${targetQuote} ${visibleAuthoredSuffix}`;
    const rejectTargetAnchors = buildRelativeAnchors(rejectBaseVisibleText, targetQuote);
    const rejectInitialMarks = canonicalizeStoredMarks({
      [rejectTargetMarkId]: {
        kind: 'replace',
        by: 'ai:test',
        createdAt,
        quote: targetQuote,
        content: targetReplacement,
        status: 'pending',
        startRel: rejectTargetAnchors.startRel,
        endRel: rejectTargetAnchors.endRel,
        range: rejectTargetAnchors.range,
      } satisfies StoredMark,
      [rejectStaleSuggestionId]: {
        kind: 'replace',
        by: 'ai:test',
        createdAt,
        quote: 'orphaned suggestion',
        content: 'should be dropped',
        status: 'pending',
        startRel: 'char:999',
        endRel: 'char:1017',
        range: { from: 999, to: 1017 },
      } satisfies StoredMark,
    });
    const rejectMarkdown = [
      `<span data-proof="authored" data-by="human:Test Editor">${visibleAuthoredPrefix}</span> `,
      `<span data-proof="suggestion" data-id="${rejectTargetMarkId}" data-by="ai:test" data-kind="replace">${targetQuote}</span> `,
      `<span data-proof="authored" data-by="human:Test Editor">${visibleAuthoredSuffix}</span>`,
    ].join('');
    const rejectSlug = `structured-gate-reject-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(rejectSlug, rejectMarkdown, rejectInitialMarks, 'Ignore authored + stale suggestion gate for reject');

    const rejectResult = await executeDocumentOperationAsync(rejectSlug, 'POST', '/marks/reject', {
      markId: rejectTargetMarkId,
      by: 'human:test',
    });
    assertEqual(rejectResult.status, 200, `Expected reject to ignore authored/stale gate failures, got ${rejectResult.status}`);
    const rejectedDoc = db.getDocumentBySlug(rejectSlug);
    assertEqual(
      stripAllProofSpanTags(rejectedDoc?.markdown ?? '').trim(),
      rejectBaseVisibleText,
      'Expected reject to restore the original target text while preserving authored text',
    );
    assertEqual(
      (rejectedDoc?.markdown.match(/data-proof="authored"[^>]*data-by="human:Test Editor"/g) ?? []).length,
      2,
      'Expected reject to preserve both visible authored wrappers',
    );
    const rejectedMarks = parseStoredMarks(rejectedDoc?.marks);
    assert(!(rejectTargetMarkId in rejectedMarks), 'Expected reject to remove the finalized target suggestion mark');
    assert(!(rejectStaleSuggestionId in rejectedMarks), 'Expected reject to drop unrelated stale suggestions that could not be rehydrated');

    console.log('structured-review-rehydration-gate.test.ts passed');
  } finally {
    try {
      unlinkSync(dbPath);
    } catch {
      // Ignore cleanup failures for temp DBs.
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
