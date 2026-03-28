import type { Mark as ProseMirrorMark, Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';

import type { MarkRange, StoredMark } from '../../formats/marks';
import { normalizeQuote } from '../../formats/marks.js';

type SuggestionKind = 'insert' | 'delete' | 'replace';

export type SuggestionSegment = {
  from: number;
  to: number;
  text: string;
};

type SuggestionTextInsertion = {
  fromOffset: number;
  toOffset: number;
};

function normalizeSuggestionKind(kind: unknown): SuggestionKind {
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return kind;
  return 'replace';
}

function hasSuggestionMark(node: ProseMirrorNode, id: string, kind: SuggestionKind): boolean {
  return node.marks.some((mark) =>
    mark.type.name === 'proofSuggestion'
    && mark.attrs.id === id
    && normalizeSuggestionKind(mark.attrs.kind) === kind
  );
}

export function collectSuggestionSegments(
  doc: ProseMirrorNode,
  id: string,
  kind: SuggestionKind,
): SuggestionSegment[] {
  const segments: SuggestionSegment[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText || !hasSuggestionMark(node, id, kind)) return true;

    const segment: SuggestionSegment = {
      from: pos,
      to: pos + node.nodeSize,
      text: node.text ?? '',
    };

    const previous = segments[segments.length - 1];
    if (previous && previous.to === segment.from) {
      previous.to = segment.to;
      previous.text += segment.text;
      return true;
    }

    segments.push(segment);
    return true;
  });

  return segments;
}

export function getSuggestionTextFromSegments(segments: SuggestionSegment[]): string | null {
  if (segments.length === 0) return null;
  return segments.map((segment) => segment.text).join('');
}

export function getSuggestionClusterRangeFromSegments(segments: SuggestionSegment[]): MarkRange | null {
  if (segments.length === 0) return null;
  return {
    from: segments[0]!.from,
    to: segments[segments.length - 1]!.to,
  };
}

export function getSuggestionTextOffsetAtPosition(
  segments: SuggestionSegment[],
  pos: number,
): number | null {
  let offset = 0;

  for (const segment of segments) {
    if (pos < segment.from) return null;
    if (pos <= segment.to) {
      return offset + Math.max(0, Math.min(pos - segment.from, segment.to - segment.from));
    }
    offset += segment.to - segment.from;
  }

  return null;
}

export function mapSuggestionTextOffsetsToDocRanges(
  segments: SuggestionSegment[],
  fromOffset: number,
  toOffset: number,
): MarkRange[] {
  if (segments.length === 0 || toOffset <= fromOffset) return [];

  const ranges: MarkRange[] = [];
  let consumed = 0;

  for (const segment of segments) {
    const segmentLength = segment.to - segment.from;
    const segmentStartOffset = consumed;
    const segmentEndOffset = consumed + segmentLength;
    const overlapFrom = Math.max(fromOffset, segmentStartOffset);
    const overlapTo = Math.min(toOffset, segmentEndOffset);

    if (overlapTo > overlapFrom) {
      ranges.push({
        from: segment.from + (overlapFrom - segmentStartOffset),
        to: segment.from + (overlapTo - segmentStartOffset),
      });
    }

    consumed = segmentEndOffset;
    if (consumed >= toOffset) break;
  }

  return ranges;
}

export function syncInsertSuggestionMetadataFromDoc(
  doc: ProseMirrorNode,
  metadata: Record<string, StoredMark>,
  insertIds: string[],
): Record<string, StoredMark> {
  if (insertIds.length === 0) return metadata;

  let changed = false;
  const next = { ...metadata };

  for (const id of insertIds) {
    const existing = next[id];
    if (!existing || existing.kind !== 'insert') continue;

    const segments = collectSuggestionSegments(doc, id, 'insert');
    const content = getSuggestionTextFromSegments(segments);
    if (!content) {
      delete next[id];
      changed = true;
      continue;
    }

    const range = getSuggestionClusterRangeFromSegments(segments);
    const prevContent = typeof existing.content === 'string' ? existing.content : '';
    const nextQuote = typeof existing.quote === 'string' ? normalizeQuote(content) : undefined;
    if (
      prevContent !== content
      || !range
      || existing.range?.from !== range.from
      || existing.range?.to !== range.to
      || (typeof existing.quote === 'string' && existing.quote !== nextQuote)
    ) {
      const nextEntry: StoredMark = {
        ...existing,
        content,
        ...(range ? { range: { from: range.from, to: range.to } } : {}),
      };
      if (typeof nextQuote === 'string') nextEntry.quote = nextQuote;
      next[id] = nextEntry;
      changed = true;
    }
  }

  return changed ? next : metadata;
}

function collectInsertSuggestionIds(doc: ProseMirrorNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== 'proofSuggestion') continue;
      if (normalizeSuggestionKind(mark.attrs.kind) !== 'insert') continue;
      const id = typeof mark.attrs.id === 'string' ? mark.attrs.id : '';
      if (id) ids.add(id);
    }
    return true;
  });
  return ids;
}

function detectSingleInsertion(oldText: string, nextText: string): SuggestionTextInsertion | null {
  if (nextText.length <= oldText.length) return null;

  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, nextText.length);
  while (prefix < maxPrefix && oldText.charCodeAt(prefix) === nextText.charCodeAt(prefix)) {
    prefix += 1;
  }

  let oldSuffix = oldText.length;
  let nextSuffix = nextText.length;
  while (
    oldSuffix > prefix
    && nextSuffix > prefix
    && oldText.charCodeAt(oldSuffix - 1) === nextText.charCodeAt(nextSuffix - 1)
  ) {
    oldSuffix -= 1;
    nextSuffix -= 1;
  }

  if (oldSuffix !== prefix) return null;

  return {
    fromOffset: prefix,
    toOffset: nextSuffix,
  };
}

function detectSingleDeletion(oldText: string, nextText: string): SuggestionTextInsertion | null {
  if (oldText.length <= nextText.length) return null;

  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, nextText.length);
  while (prefix < maxPrefix && oldText.charCodeAt(prefix) === nextText.charCodeAt(prefix)) {
    prefix += 1;
  }

  let oldSuffix = oldText.length;
  let nextSuffix = nextText.length;
  while (
    oldSuffix > prefix
    && nextSuffix > prefix
    && oldText.charCodeAt(oldSuffix - 1) === nextText.charCodeAt(nextSuffix - 1)
  ) {
    oldSuffix -= 1;
    nextSuffix -= 1;
  }

  if (nextSuffix !== prefix) return null;

  return {
    fromOffset: prefix,
    toOffset: oldSuffix,
  };
}

function mapTextOffsetsToDocRanges(
  doc: ProseMirrorNode,
  range: MarkRange,
  fromOffset: number,
  toOffset: number,
): MarkRange[] {
  if (toOffset <= fromOffset) return [];

  const ranges: MarkRange[] = [];
  let consumed = 0;

  doc.nodesBetween(range.from, range.to, (node, pos) => {
    if (!node.isText) return true;

    const overlapFrom = Math.max(range.from, pos);
    const overlapTo = Math.min(range.to, pos + node.nodeSize);
    if (overlapTo <= overlapFrom) return true;

    const segmentLength = overlapTo - overlapFrom;
    const segmentStartOffset = consumed;
    const segmentEndOffset = consumed + segmentLength;
    const mappedFrom = Math.max(fromOffset, segmentStartOffset);
    const mappedTo = Math.min(toOffset, segmentEndOffset);
    if (mappedTo > mappedFrom) {
      ranges.push({
        from: overlapFrom + (mappedFrom - segmentStartOffset),
        to: overlapFrom + (mappedTo - segmentStartOffset),
      });
    }
    consumed = segmentEndOffset;
    return consumed < toOffset;
  });

  return ranges;
}

function collectNonSuggestionTextRanges(
  doc: ProseMirrorNode,
  range: MarkRange,
  id: string,
): MarkRange[] {
  const ranges: MarkRange[] = [];

  doc.nodesBetween(range.from, range.to, (node, pos) => {
    if (!node.isText) return true;

    const overlapFrom = Math.max(range.from, pos);
    const overlapTo = Math.min(range.to, pos + node.nodeSize);
    if (overlapTo <= overlapFrom) return true;

    const hasInsertSuggestion = node.marks.some((mark) =>
      mark.type.name === 'proofSuggestion'
      && mark.attrs.id === id
      && normalizeSuggestionKind(mark.attrs.kind) === 'insert'
    );
    if (hasInsertSuggestion) return true;

    const previous = ranges[ranges.length - 1];
    if (previous && previous.to === overlapFrom) {
      previous.to = overlapTo;
    } else {
      ranges.push({ from: overlapFrom, to: overlapTo });
    }
    return true;
  });

  return ranges;
}

function collectSuggestionMarkRemovals(
  doc: ProseMirrorNode,
  id: string,
  kind: SuggestionKind,
  ranges: MarkRange[],
): Array<{ from: number; to: number; mark: ProseMirrorMark }> {
  const removals: Array<{ from: number; to: number; mark: ProseMirrorMark }> = [];
  const seen = new Set<string>();

  for (const range of ranges) {
    doc.nodesBetween(range.from, range.to, (node, pos) => {
      if (!node.isText) return true;

      const overlapFrom = Math.max(range.from, pos);
      const overlapTo = Math.min(range.to, pos + node.nodeSize);
      if (overlapTo <= overlapFrom) return true;

      for (const mark of node.marks) {
        if (mark.type.name !== 'proofSuggestion') continue;
        if (mark.attrs.id !== id) continue;
        if (normalizeSuggestionKind(mark.attrs.kind) !== kind) continue;
        const key = `${overlapFrom}:${overlapTo}:${id}:${String(mark.attrs.kind)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        removals.push({ from: overlapFrom, to: overlapTo, mark });
      }

      return true;
    });
  }

  return removals;
}

export function buildRemoteInsertSuggestionBoundaryRepair(
  oldState: EditorState,
  newState: EditorState,
  metadata?: Record<string, StoredMark>,
  options?: {
    preferLocalInsertGrowthAtSelection?: boolean;
    localSelectionFrom?: number | null;
    localSelectionEmpty?: boolean;
  },
): { transaction: Transaction; affectedInsertIds: string[] } | null {
  const suggestionMarkType = newState.schema.marks.proofSuggestion;
  if (!suggestionMarkType) return null;
  const authoredMarkType = newState.schema.marks.proofAuthored ?? null;

  const existingInsertIds = collectInsertSuggestionIds(oldState.doc);
  if (existingInsertIds.size === 0) return null;

  let tr = newState.tr;
  const affectedInsertIds = new Set<string>();

  for (const id of existingInsertIds) {
    const oldSegments = collectSuggestionSegments(oldState.doc, id, 'insert');
    const newSegments = collectSuggestionSegments(newState.doc, id, 'insert');
    if (oldSegments.length === 0) continue;

    const stored = metadata?.[id];
    const oldText = getSuggestionTextFromSegments(oldSegments) ?? '';
    const oldRange = getSuggestionClusterRangeFromSegments(oldSegments);

    if (newSegments.length === 0) {
      const canRestoreMissingLocalInsert = (
        stored?.kind === 'insert'
        && stored.status !== 'accepted'
        && stored.status !== 'rejected'
        && options?.preferLocalInsertGrowthAtSelection === true
        && options.localSelectionEmpty !== false
      );
      const fullRangeText = oldRange
        ? normalizeQuote(newState.doc.textBetween(oldRange.from, oldRange.to, '\n', '\n'))
        : '';
      if (canRestoreMissingLocalInsert && oldRange && fullRangeText === normalizeQuote(oldText)) {
        const restoredRanges = collectNonSuggestionTextRanges(newState.doc, oldRange, id);
        if (restoredRanges.length > 0) {
          for (const restoredRange of restoredRanges) {
            if (authoredMarkType) {
              tr = tr.removeMark(restoredRange.from, restoredRange.to, authoredMarkType);
            }
            tr = tr.addMark(
              restoredRange.from,
              restoredRange.to,
              suggestionMarkType.create({ id, kind: 'insert', by: stored.by ?? 'unknown' }),
            );
          }
          affectedInsertIds.add(id);
        }
      }
      continue;
    }

    const newText = getSuggestionTextFromSegments(newSegments) ?? '';
    if (oldText === newText) continue;

    if (stored?.kind === 'insert' && stored.status !== 'accepted' && stored.status !== 'rejected') {
      const normalizedNewText = normalizeQuote(newText);
      const normalizedStoredContent = typeof stored.content === 'string' ? normalizeQuote(stored.content) : '';
      const normalizedStoredQuote = typeof stored.quote === 'string' ? normalizeQuote(stored.quote) : '';
      if (
        normalizedNewText.length > 0
        && (normalizedStoredContent === normalizedNewText || normalizedStoredQuote === normalizedNewText)
      ) {
        continue;
      }
    }

    const insertion = detectSingleInsertion(oldText, newText);
    if (!insertion) {
      if (
        options?.preferLocalInsertGrowthAtSelection === true
        && options.localSelectionEmpty !== false
      ) {
        const fullRangeText = oldRange
          ? normalizeQuote(newState.doc.textBetween(oldRange.from, oldRange.to, '\n', '\n'))
          : '';
        if (oldRange && fullRangeText === normalizeQuote(oldText)) {
          const restoredRanges = collectNonSuggestionTextRanges(newState.doc, oldRange, id);
          if (restoredRanges.length > 0) {
            for (const restoredRange of restoredRanges) {
              if (authoredMarkType) {
                tr = tr.removeMark(restoredRange.from, restoredRange.to, authoredMarkType);
              }
              tr = tr.addMark(
                restoredRange.from,
                restoredRange.to,
                suggestionMarkType.create({ id, kind: 'insert', by: stored?.by ?? 'unknown' }),
              );
            }
            affectedInsertIds.add(id);
          }
        }
      }
      continue;
    }

    if (
      options?.preferLocalInsertGrowthAtSelection === true
      && options.localSelectionEmpty !== false
      && typeof options.localSelectionFrom === 'number'
    ) {
      const selectionOffset = getSuggestionTextOffsetAtPosition(oldSegments, options.localSelectionFrom);
      if (selectionOffset !== null && selectionOffset === insertion.fromOffset) {
        continue;
      }
    }

    const insertedRanges = mapSuggestionTextOffsetsToDocRanges(
      newSegments,
      insertion.fromOffset,
      insertion.toOffset,
    );
    if (insertedRanges.length === 0) continue;

    const removals = collectSuggestionMarkRemovals(newState.doc, id, 'insert', insertedRanges);
    if (removals.length === 0) continue;

    for (const removal of removals) {
      tr = tr.removeMark(removal.from, removal.to, removal.mark);
    }
    affectedInsertIds.add(id);
  }

  if (affectedInsertIds.size === 0) return null;

  tr = tr.setMeta('addToHistory', false);
  return {
    transaction: tr,
    affectedInsertIds: [...affectedInsertIds],
  };
}
