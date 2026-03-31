import { canonicalizeStoredMarks, type StoredMark } from '../src/formats/marks.js';
import {
  canonicalizeAnchorTargetText,
  canonicalizeVisibleTextBlockSeparators,
  stripMarkdownVisibleText,
} from '../src/shared/anchor-target-text.js';
import {
  logReviewWhitespace,
  shouldDebugReviewWhitespace,
  summarizeReviewWhitespaceMarkdown,
  summarizeReviewWhitespaceMarks,
} from './review-whitespace-debug.js';

type MarkRange = { from: number; to: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalizeVisibleMarkdown(markdown: string): string {
  return canonicalizeVisibleTextBlockSeparators(
    stripMarkdownVisibleText((markdown ?? '').replace(/\r\n?/g, '\n')),
  );
}

function canonicalizeAnchorText(value: unknown): string {
  return canonicalizeVisibleTextBlockSeparators(stripMarkdownVisibleText(typeof value === 'string' ? value : ''));
}

function parseRelativeCharOffset(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^char:(-?\d+)$/.exec(value.trim());
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getStoredMarkRange(mark: StoredMark): MarkRange | null {
  if (!isRecord(mark.range)) return null;
  const from = mark.range.from;
  const to = mark.range.to;
  if (
    typeof from !== 'number'
    || !Number.isFinite(from)
    || typeof to !== 'number'
    || !Number.isFinite(to)
    || to < from
  ) {
    return null;
  }
  return { from, to };
}

function getMarkAnchorHint(mark: StoredMark): number | null {
  const startRel = parseRelativeCharOffset(mark.startRel);
  if (startRel !== null) return startRel;
  const range = getStoredMarkRange(mark);
  if (range) return range.from;
  const endRel = parseRelativeCharOffset(mark.endRel);
  if (endRel !== null) return endRel;
  return null;
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const positions: number[] = [];
  let fromIndex = 0;
  while (fromIndex <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, fromIndex);
    if (index < 0) break;
    positions.push(index);
    fromIndex = index + 1;
  }
  return positions;
}

function pickOccurrenceNearHint(positions: number[], hint: number | null): number | null {
  if (positions.length === 0) return null;
  if (hint === null) return positions[0] ?? null;

  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const position of positions) {
    const distance = Math.abs(position - hint);
    if (distance < bestDistance || (distance === bestDistance && (best === null || position < best))) {
      best = position;
      bestDistance = distance;
    }
  }
  return best;
}

function getMarkTargetAnchor(mark: StoredMark): string {
  if (!isRecord(mark.target) || typeof mark.target.anchor !== 'string') return '';
  return canonicalizeAnchorTargetText({ anchor: mark.target.anchor }).anchor;
}

function getAnchorCandidates(mark: StoredMark): string[] {
  const candidates: string[] = [];
  const push = (value: string): void => {
    if (!value || candidates.includes(value)) return;
    candidates.push(value);
  };

  const quote = canonicalizeAnchorText(mark.quote);
  if (quote) push(quote);

  if (mark.kind === 'insert') {
    const content = canonicalizeAnchorText(mark.content);
    if (content) push(content);
  }

  const targetAnchor = getMarkTargetAnchor(mark);
  if (targetAnchor) push(targetAnchor);

  return candidates;
}

function resolveMarkAnchor(
  markdown: string,
  mark: StoredMark,
  hint: number | null = getMarkAnchorHint(mark),
  candidates: string[] = getAnchorCandidates(mark),
): { from: number; to: number; quote: string } | null {
  const canonicalVisible = canonicalizeVisibleMarkdown(markdown);

  for (const candidate of candidates) {
    const occurrences = findAllOccurrences(canonicalVisible, candidate);
    const start = pickOccurrenceNearHint(occurrences, hint);
    if (start === null) continue;
    return {
      from: start,
      to: start + candidate.length,
      quote: candidate,
    };
  }

  return null;
}

function markChanged(left: StoredMark, right: StoredMark): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

export function normalizeStoredMarksAgainstMarkdown(
  markdown: string,
  marks: Record<string, StoredMark>,
  debugScope?: string,
): Record<string, StoredMark> {
  const canonicalMarks = canonicalizeStoredMarks(marks);
  const nextMarks: Record<string, StoredMark> = {};
  let changed = false;
  const debugEnabled = shouldDebugReviewWhitespace() && typeof debugScope === 'string' && debugScope.trim().length > 0;

  if (debugEnabled) {
    logReviewWhitespace(debugScope!, 'normalize-start', {
      markdown: summarizeReviewWhitespaceMarkdown(markdown),
      marks: summarizeReviewWhitespaceMarks(canonicalMarks),
    });
  }

  for (const [id, mark] of Object.entries(canonicalMarks)) {
    const hint = getMarkAnchorHint(mark);
    const candidates = getAnchorCandidates(mark);
    const resolved = resolveMarkAnchor(markdown, mark, hint, candidates);
    if (debugEnabled) {
      logReviewWhitespace(debugScope!, 'resolve-mark', {
        markId: id,
        hint,
        candidates,
        inputMark: summarizeReviewWhitespaceMarks({ [id]: mark }),
        resolved: resolved
          ? { from: resolved.from, to: resolved.to, quote: resolved.quote }
          : null,
      });
    }
    if (!resolved) {
      nextMarks[id] = mark;
      continue;
    }

    const nextMark: StoredMark = {
      ...mark,
      quote: resolved.quote,
      range: { from: resolved.from, to: resolved.to },
      startRel: `char:${resolved.from}`,
      endRel: `char:${resolved.to}`,
    };
    nextMarks[id] = nextMark;
    if (!changed && markChanged(mark, nextMark)) {
      changed = true;
    }
  }

  const normalizedMarks = changed ? canonicalizeStoredMarks(nextMarks) : canonicalMarks;
  if (debugEnabled) {
    logReviewWhitespace(debugScope!, 'normalize-complete', {
      changed,
      marks: summarizeReviewWhitespaceMarks(normalizedMarks),
    });
  }
  return normalizedMarks;
}
