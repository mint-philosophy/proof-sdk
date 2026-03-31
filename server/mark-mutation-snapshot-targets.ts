import { canonicalizeStoredMarks, normalizeQuote, type StoredMark } from '../src/formats/marks.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMarksPayload(raw: unknown): Record<string, StoredMark> {
  if (!isRecord(raw)) return {};
  return canonicalizeStoredMarks(raw as Record<string, StoredMark>);
}

function parseRequestedMarkIds(payload: Record<string, unknown>): string[] {
  const requestedMarkIds = Array.isArray(payload.markIds)
    ? payload.markIds
      .filter((markId): markId is string => typeof markId === 'string' && markId.trim().length > 0)
      .map((markId) => markId.trim())
    : [];
  const uniqueMarkIds: string[] = [];
  const seen = new Set<string>();
  for (const markId of requestedMarkIds) {
    if (seen.has(markId)) continue;
    seen.add(markId);
    uniqueMarkIds.push(markId);
  }
  return uniqueMarkIds;
}

function isPendingSuggestionMark(mark: StoredMark | undefined): boolean {
  if (!mark) return false;
  if (mark.kind !== 'insert' && mark.kind !== 'delete' && mark.kind !== 'replace') return false;
  return mark.status !== 'accepted' && mark.status !== 'rejected';
}

function parseRelativeCharOffset(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^char:(-?\d+)$/.exec(value.trim());
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getMarkStart(mark: StoredMark): number | null {
  const rel = parseRelativeCharOffset(mark.startRel);
  if (rel !== null) return rel;
  if (isRecord(mark.range) && typeof mark.range.from === 'number' && Number.isFinite(mark.range.from)) {
    return mark.range.from;
  }
  return null;
}

function getMarkEnd(mark: StoredMark): number | null {
  const rel = parseRelativeCharOffset(mark.endRel);
  if (rel !== null) return rel;
  if (isRecord(mark.range) && typeof mark.range.to === 'number' && Number.isFinite(mark.range.to)) {
    return mark.range.to;
  }
  return null;
}

function getComparableMarkText(mark: StoredMark): string {
  const quote = typeof mark.quote === 'string' ? normalizeQuote(mark.quote) : '';
  if (quote) return quote;
  const content = typeof mark.content === 'string' ? normalizeQuote(mark.content) : '';
  return content;
}

function scoreEquivalentSnapshotMark(source: StoredMark, candidate: StoredMark): number {
  if (!isPendingSuggestionMark(candidate)) return Number.NEGATIVE_INFINITY;
  if (candidate.kind !== source.kind) return Number.NEGATIVE_INFINITY;
  if (source.by && candidate.by && candidate.by !== source.by) return Number.NEGATIVE_INFINITY;

  const sourceText = getComparableMarkText(source);
  const candidateText = getComparableMarkText(candidate);
  const sourceStart = getMarkStart(source);
  const sourceEnd = getMarkEnd(source);
  const candidateStart = getMarkStart(candidate);
  const candidateEnd = getMarkEnd(candidate);

  let score = 0;
  if (source.by && candidate.by && candidate.by === source.by) score += 40;

  if (sourceText && candidateText) {
    if (candidateText === sourceText) {
      score += 220;
    } else if (candidateText.includes(sourceText)) {
      score += 180;
    } else if (sourceText.includes(candidateText)) {
      score += 120;
    } else {
      return Number.NEGATIVE_INFINITY;
    }
  } else if (sourceText || candidateText) {
    return Number.NEGATIVE_INFINITY;
  }

  if (sourceStart !== null && candidateStart !== null) {
    score += Math.max(0, 80 - Math.abs(candidateStart - sourceStart));
  }
  if (sourceEnd !== null && candidateEnd !== null) {
    score += Math.max(0, 40 - Math.abs(candidateEnd - sourceEnd));
  }

  return score;
}

export function rewriteMarkMutationPayloadSnapshotTargets(
  payload: Record<string, unknown>,
  contextMarksInput: unknown,
): Record<string, unknown> {
  const requestedMarkId = typeof payload.markId === 'string' && payload.markId.trim().length > 0
    ? payload.markId.trim()
    : null;
  if (!requestedMarkId) return payload;

  const snapshotMarks = parseMarksPayload(payload.marks);
  if (Object.prototype.hasOwnProperty.call(snapshotMarks, requestedMarkId)) {
    return payload;
  }

  const contextMarks = parseMarksPayload(contextMarksInput);
  const sourceMark = contextMarks[requestedMarkId];
  if (!isPendingSuggestionMark(sourceMark)) return payload;

  let bestCandidateId: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const [candidateId, candidateMark] of Object.entries(snapshotMarks)) {
    const score = scoreEquivalentSnapshotMark(sourceMark, candidateMark);
    if (score > bestScore) {
      bestScore = score;
      bestCandidateId = candidateId;
    }
  }

  if (!bestCandidateId || bestScore < 180) {
    return payload;
  }

  return {
    ...payload,
    markId: bestCandidateId,
  };
}

export function resolveEquivalentBatchMutationPayloadMarkIds(
  payload: Record<string, unknown>,
  contextMarksInput: unknown,
): string[] {
  const requestedMarkIds = parseRequestedMarkIds(payload);
  if (requestedMarkIds.length === 0) return [];

  const snapshotMarks = parseMarksPayload(payload.marks);
  const contextMarks = parseMarksPayload(contextMarksInput);
  const resolvedMarkIds: string[] = [];
  const usedContextMarkIds = new Set<string>();

  for (const requestedMarkId of requestedMarkIds) {
    if (Object.prototype.hasOwnProperty.call(contextMarks, requestedMarkId)) {
      resolvedMarkIds.push(requestedMarkId);
      usedContextMarkIds.add(requestedMarkId);
      continue;
    }

    const sourceMark = snapshotMarks[requestedMarkId];
    if (!isPendingSuggestionMark(sourceMark)) continue;

    let bestCandidateId: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const [candidateId, candidateMark] of Object.entries(contextMarks)) {
      if (usedContextMarkIds.has(candidateId)) continue;
      const score = scoreEquivalentSnapshotMark(sourceMark, candidateMark);
      if (score > bestScore) {
        bestScore = score;
        bestCandidateId = candidateId;
      }
    }

    if (!bestCandidateId || bestScore < 180) continue;
    resolvedMarkIds.push(bestCandidateId);
    usedContextMarkIds.add(bestCandidateId);
  }

  return resolvedMarkIds;
}

export const __markMutationSnapshotTargetsForTests = {
  resolveEquivalentBatchMutationPayloadMarkIds,
  rewriteMarkMutationPayloadSnapshotTargets,
};
