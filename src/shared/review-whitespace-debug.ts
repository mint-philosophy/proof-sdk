import type { StoredMark } from '../formats/marks.js';

type MarkRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MarkRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function countLeadingSpaces(line: string): number {
  let count = 0;
  while (count < line.length && line.charCodeAt(count) === 32) count += 1;
  return count;
}

function countTrailingSpaces(line: string): number {
  let count = 0;
  while (count < line.length && line.charCodeAt(line.length - count - 1) === 32) count += 1;
  return count;
}

function sampleText(value: unknown, maxChars: number = 120): string | null {
  if (typeof value !== 'string') return null;
  if (value.length <= maxChars) return JSON.stringify(value);
  return `${JSON.stringify(value.slice(0, maxChars))}...(+${value.length - maxChars} chars)`;
}

export function summarizeReviewWhitespaceMarkdown(
  markdown: string | null | undefined,
  options: { maxLines?: number; maxChars?: number } = {},
): Record<string, unknown> | null {
  if (typeof markdown !== 'string') return null;

  const normalized = markdown.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const maxLines = Math.max(1, options.maxLines ?? 12);
  const maxChars = Math.max(24, options.maxChars ?? 120);
  const trailingSpaceLines: number[] = [];
  const leadingSpaceLines: number[] = [];
  const blankLines: number[] = [];
  const lineIndexes = new Set<number>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const leadingSpaces = countLeadingSpaces(line);
    const trailingSpaces = countTrailingSpaces(line);
    if (leadingSpaces > 0) {
      leadingSpaceLines.push(index + 1);
      lineIndexes.add(index);
    }
    if (trailingSpaces > 0) {
      trailingSpaceLines.push(index + 1);
      lineIndexes.add(index);
    }
    if (line.length === 0) {
      blankLines.push(index + 1);
      lineIndexes.add(index);
    }
  }

  for (let index = 0; index < Math.min(3, lines.length); index += 1) {
    lineIndexes.add(index);
  }
  for (let index = Math.max(0, lines.length - 2); index < lines.length; index += 1) {
    lineIndexes.add(index);
  }

  const sampleLines = [...lineIndexes]
    .sort((left, right) => left - right)
    .slice(0, maxLines)
    .map((index) => {
      const line = lines[index] ?? '';
      return {
        lineNumber: index + 1,
        length: line.length,
        leadingSpaces: countLeadingSpaces(line),
        trailingSpaces: countTrailingSpaces(line),
        blank: line.length === 0,
        text: sampleText(line, maxChars),
      };
    });

  return {
    length: normalized.length,
    lineCount: lines.length,
    endsWithNewline: normalized.endsWith('\n'),
    leadingSpaceLines,
    trailingSpaceLines,
    blankLines,
    excerpt: sampleText(normalized, maxChars),
    sampleLines,
  };
}

export function summarizeReviewWhitespaceMarks(
  marks: Record<string, StoredMark | unknown> | null | undefined,
  options: { maxMarks?: number; maxChars?: number } = {},
): Record<string, unknown> {
  if (!marks || typeof marks !== 'object' || Array.isArray(marks)) {
    return {
      count: 0,
      ids: [],
      sample: [],
    };
  }

  const maxMarks = Math.max(1, options.maxMarks ?? 12);
  const maxChars = Math.max(24, options.maxChars ?? 80);
  const ids = Object.keys(marks);
  const sample = ids.slice(0, maxMarks).map((id) => {
    const value = marks[id];
    const mark = isRecord(value) ? value : {};
    const target = isRecord(mark.target) ? mark.target : null;
    const range = isRecord(mark.range)
      && typeof mark.range.from === 'number'
      && typeof mark.range.to === 'number'
      ? { from: mark.range.from, to: mark.range.to }
      : null;
    return {
      id,
      kind: typeof mark.kind === 'string' ? mark.kind : null,
      status: typeof mark.status === 'string' ? mark.status : null,
      startRel: typeof mark.startRel === 'string' ? mark.startRel : null,
      endRel: typeof mark.endRel === 'string' ? mark.endRel : null,
      range,
      quote: sampleText(mark.quote, maxChars),
      content: sampleText(mark.content, maxChars),
      targetAnchor: target && typeof target.anchor === 'string'
        ? sampleText(target.anchor, maxChars)
        : null,
    };
  });

  return {
    count: ids.length,
    ids,
    sample,
  };
}
