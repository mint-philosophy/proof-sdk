/**
 * Suggestions Plugin for Milkdown
 *
 * Converts edits into proofSuggestion marks + PROOF metadata
 * when suggestions mode is enabled.
 */

import { $ctx, $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { MarkType, Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';

import { marksPluginKey, getMarkMetadata, buildSuggestionMetadata, syncSuggestionMetadataTransaction } from './marks';
import {
  collectSuggestionSegments,
  getSuggestionClusterRangeFromSegments,
  getSuggestionTextFromSegments,
  getSuggestionTextOffsetAtPosition,
  syncInsertSuggestionMetadataFromDoc,
} from './suggestion-boundaries';
import { shouldSuppressTrackChangesDeleteIntent, shouldSuppressTrackChangesKeydown } from './track-changes-delete-guard.js';
import { isExplicitYjsChangeOriginTransaction } from './transaction-origins';
import { generateMarkId, type MarkRange, type StoredMark } from '../../formats/marks';
import { getCurrentActor } from '../actor';

// Suggestion state
export interface SuggestionState {
  enabled: boolean;
}

// Plugin key for accessing state
export const suggestionsPluginKey = new PluginKey<SuggestionState>('suggestions');

// Context to store suggestion state
export const suggestionsCtx = $ctx<SuggestionState, 'suggestions'>({ enabled: false }, 'suggestions');

type SuggestionKind = 'insert' | 'delete' | 'replace';

type SliceNode = {
  type?: string;
  text?: string;
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
  content?: SliceNode[];
};

// Word-style track changes should keep a contiguous typing run together even when
// the user pauses briefly between keystrokes. A slightly longer window also makes
// browser automation reflect real authoring behavior instead of splitting every key.
const COALESCE_WINDOW_MS = 5000;

type InsertCoalesceState = { id: string; from: number; to: number; by: string; updatedAt: number };
type TrackedDeleteIntent = { key: 'Backspace' | 'Delete'; modifiers?: { altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } };
type PendingTrackedDeleteIntent = { intent: TrackedDeleteIntent; at: number; handled: boolean };

const lastInsertByActor = new Map<string, InsertCoalesceState>();
const pendingModifiedDeleteIntents = new WeakMap<EditorView, PendingTrackedDeleteIntent>();
const PENDING_DELETE_INTENT_TTL_MS = 1500;

export function resetSuggestionsInsertCoalescing(): void {
  lastInsertByActor.clear();
}

export function hasRecentSuggestionsInsertCoalescingState(): boolean {
  const actor = getCurrentActor();
  const cached = lastInsertByActor.get(actor);
  if (!cached) return false;
  if ((Date.now() - cached.updatedAt) > COALESCE_WINDOW_MS) {
    lastInsertByActor.delete(actor);
    return false;
  }
  return true;
}

function normalizeSuggestionKind(kind: unknown): SuggestionKind {
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return kind;
  return 'replace';
}

function isWhitespaceOnly(text: string): boolean {
  return /^[\s\u00A0]+$/.test(text);
}

function resolveLiveInsertSuggestionRange(
  doc: ProseMirrorNode,
  id: string
): MarkRange | null {
  const segments = collectSuggestionSegments(doc, id, 'insert');
  return getSuggestionClusterRangeFromSegments(segments);
}

function resolveLiveSuggestionRange(
  doc: ProseMirrorNode,
  id: string,
  kind: SuggestionKind,
): MarkRange | null {
  const segments = collectSuggestionSegments(doc, id, kind);
  return getSuggestionClusterRangeFromSegments(segments);
}

function resolveLiveDeleteSuggestionRange(
  doc: ProseMirrorNode,
  id: string
): MarkRange | null {
  return resolveLiveSuggestionRange(doc, id, 'delete');
}

function getLiveInsertSuggestionText(doc: ProseMirrorNode, id: string): string | null {
  const segments = collectSuggestionSegments(doc, id, 'insert');
  return getSuggestionTextFromSegments(segments);
}

function stripAuthoredMarksFromPendingInsertRanges(
  tr: Transaction,
  authoredType: MarkType | null,
  metadata: Record<string, StoredMark>,
): Transaction {
  if (!authoredType) return tr;

  let nextTr = tr;
  for (const [id, stored] of Object.entries(metadata)) {
    if (stored?.kind !== 'insert' || stored?.status === 'accepted' || stored?.status === 'rejected') continue;
    const range = resolveLiveInsertSuggestionRange(nextTr.doc, id);
    if (!range || range.to <= range.from) continue;
    nextTr = nextTr.removeMark(range.from, range.to, authoredType);
  }
  return nextTr;
}

function collectSuggestionIdsInRange(
  doc: ProseMirrorNode,
  kind: SuggestionKind,
  from: number,
  to: number
): string[] {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const ids = new Set<string>();

  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const nodeStart = pos;
    const nodeEnd = pos + node.nodeSize;
    if (nodeEnd <= start || nodeStart >= end) return true;

    for (const mark of node.marks) {
      if (mark.type.name !== 'proofSuggestion') continue;
      if (normalizeSuggestionKind(mark.attrs.kind) !== kind) continue;
      const id = typeof mark.attrs.id === 'string' ? mark.attrs.id : '';
      if (id) ids.add(id);
    }

    return true;
  });

  return [...ids];
}

function findEditableInsertSuggestionAtPosition(
  doc: ProseMirrorNode,
  pos: number,
  by: string
): { id: string; range: MarkRange; offset: number } | null {
  const matches: Array<{ id: string; range: MarkRange; offset: number; containsPos: boolean }> = [];

  doc.descendants((node, nodePos) => {
    if (!node.isText) return true;
    const start = nodePos;
    const end = nodePos + node.nodeSize;
    if (pos < start || pos > end) return true;

    for (const mark of node.marks) {
      if (mark.type.name !== 'proofSuggestion') continue;
      if (normalizeSuggestionKind(mark.attrs.kind) !== 'insert') continue;
      if ((mark.attrs.by || 'unknown') !== by) continue;
      const id = typeof mark.attrs.id === 'string' ? mark.attrs.id : '';
      if (!id) continue;
      const segments = collectSuggestionSegments(doc, id, 'insert');
      const range = getSuggestionClusterRangeFromSegments(segments);
      const offset = getSuggestionTextOffsetAtPosition(segments, pos);
      if (!range || offset === null) continue;
      const containsPos = segments.some((segment) => pos >= segment.from && pos <= segment.to);
      matches.push({ id, range, offset, containsPos });
    }

    return true;
  });

  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    const aContains = a.containsPos;
    const bContains = b.containsPos;
    if (aContains !== bContains) return aContains ? -1 : 1;
    return (a.range.to - a.range.from) - (b.range.to - b.range.from);
  });

  const match = matches[0];
  return {
    id: match.id,
    range: { from: match.range.from, to: match.range.to },
    offset: match.offset,
  };
}

function resolveTrackedTextInputRange(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number } {
  const selection = state.selection;
  const actor = getCurrentActor();
  const domInsert = from === to
    ? findEditableInsertSuggestionAtPosition(state.doc, from, actor)
    : null;
  const selectionInsert = selection.empty
    ? findEditableInsertSuggestionAtPosition(state.doc, selection.from, actor)
    : null;

  if (
    domInsert
    && selectionInsert
    && domInsert.id === selectionInsert.id
    && (from !== selection.from || to !== selection.to)
  ) {
    return { from: selection.from, to: selection.to };
  }

  return { from, to };
}

export function __debugResolveTrackedTextInputRange(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number } {
  return resolveTrackedTextInputRange(state, from, to);
}

function findTrailingDeleteRangeForInsert(
  doc: ProseMirrorNode,
  insertRange: MarkRange,
  by: string,
  pos: number,
): MarkRange | null {
  if (pos <= insertRange.to) return null;

  const seenDeleteIds = new Set<string>();

  let matchingDeleteRange: MarkRange | null = null;
  doc.descendants((node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== 'proofSuggestion') continue;
      if (normalizeSuggestionKind(mark.attrs.kind) !== 'delete') continue;
      if ((mark.attrs.by || 'unknown') !== by) continue;
      const id = typeof mark.attrs.id === 'string' ? mark.attrs.id : '';
      if (!id || seenDeleteIds.has(id)) continue;
      seenDeleteIds.add(id);

      const deleteRange = resolveLiveDeleteSuggestionRange(doc, id);
      if (!deleteRange) continue;
      if (deleteRange.from === insertRange.to && deleteRange.to === pos) {
        matchingDeleteRange = deleteRange;
        return false;
      }
    }
    return true;
  });

  return matchingDeleteRange;
}

function getCoalescableInsertCandidate(
  doc: ProseMirrorNode,
  metadata: Record<string, StoredMark>,
  pos: number,
  by: string,
  now: number
): { id: string; range: MarkRange; direction: 'append' | 'prepend'; insertPos: number } | null {
  const cached = lastInsertByActor.get(by);
  if (!cached) return null;
  if (now - cached.updatedAt > COALESCE_WINDOW_MS) {
    lastInsertByActor.delete(by);
    return null;
  }

  const stored = metadata[cached.id];
  if (stored?.kind && stored.kind !== 'insert') {
    lastInsertByActor.delete(by);
    return null;
  }

  const status = stored?.status;
  if (status && status !== 'pending') {
    lastInsertByActor.delete(by);
    return null;
  }

  const range = resolveLiveInsertSuggestionRange(doc, cached.id)
    ?? (stored?.kind === 'insert' && stored.range ? { from: stored.range.from, to: stored.range.to } : null);
  if (!range) {
    lastInsertByActor.delete(by);
    return null;
  }

  if (range.to === pos) {
    return { id: cached.id, range, direction: 'append', insertPos: pos };
  }

  if (range.from === pos) {
    return { id: cached.id, range, direction: 'prepend', insertPos: pos };
  }

  const trailingDeleteRange = findTrailingDeleteRangeForInsert(doc, range, by, pos);
  if (trailingDeleteRange) {
    return {
      id: cached.id,
      range,
      direction: 'append',
      insertPos: range.to,
    };
  }

  return null;
}

function collectSliceText(nodes?: SliceNode[]): { text: string; hasNonText: boolean } {
  let text = '';
  let hasNonText = false;

  if (!nodes) return { text, hasNonText };

  for (const node of nodes) {
    if (node.text) {
      text += node.text;
    }
    if (node.type && node.type !== 'text') {
      hasNonText = true;
    }
    if (node.content) {
      const child = collectSliceText(node.content);
      text += child.text;
      if (child.hasNonText) hasNonText = true;
    }
  }

  return { text, hasNonText };
}

function sliceContainsSuggestionMarks(nodes?: SliceNode[]): boolean {
  if (!nodes) return false;

  for (const node of nodes) {
    if (Array.isArray(node.marks) && node.marks.some((mark) => mark?.type === 'proofSuggestion')) {
      return true;
    }
    if (node.content && sliceContainsSuggestionMarks(node.content)) {
      return true;
    }
  }

  return false;
}

export function transactionCarriesInsertedSuggestionMarks(tr: Transaction): boolean {
  for (const step of tr.steps) {
    const stepJson = step.toJSON() as { stepType?: string; slice?: { content?: SliceNode[] } };
    if (stepJson.stepType !== 'replace') continue;
    if (sliceContainsSuggestionMarks(stepJson.slice?.content)) {
      return true;
    }
  }
  return false;
}

function detectSuggestionKinds(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  suggestionType: MarkType
): { hasInsert: boolean; hasDelete: boolean; hasReplace: boolean } {
  const found = { hasInsert: false, hasDelete: false, hasReplace: false };

  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type !== suggestionType) continue;
      const kind = normalizeSuggestionKind(mark.attrs.kind);
      if (kind === 'insert') found.hasInsert = true;
      if (kind === 'delete') found.hasDelete = true;
      if (kind === 'replace') found.hasReplace = true;
    }
    return !(found.hasInsert && found.hasDelete && found.hasReplace);
  });

  return found;
}

type DeleteRangeSegmentKind = 'plain' | 'insert' | 'delete' | 'replace';

type DeleteRangeSegment = {
  from: number;
  to: number;
  kind: DeleteRangeSegmentKind;
  insertIds: string[];
  text: string;
};

function sameInsertIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function collectDeleteRangeSegments(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  suggestionType: MarkType
): DeleteRangeSegment[] {
  const segments: DeleteRangeSegment[] = [];

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;

    const segmentFrom = Math.max(from, pos);
    const segmentTo = Math.min(to, pos + node.nodeSize);
    if (segmentTo <= segmentFrom) return true;

    let kind: DeleteRangeSegmentKind = 'plain';
    const insertIds = new Set<string>();

    for (const mark of node.marks) {
      if (mark.type !== suggestionType) continue;
      const normalizedKind = normalizeSuggestionKind(mark.attrs.kind);
      if (normalizedKind === 'insert') {
        kind = 'insert';
        const id = typeof mark.attrs.id === 'string' ? mark.attrs.id : '';
        if (id) insertIds.add(id);
        continue;
      }
      if (kind === 'insert') continue;
      if (normalizedKind === 'delete') kind = 'delete';
      if (normalizedKind === 'replace') kind = 'replace';
    }

    const insertIdList = [...insertIds].sort();
    const text = doc.textBetween(segmentFrom, segmentTo, '', '');
    const previous = segments[segments.length - 1];
    if (
      previous
      && previous.to === segmentFrom
      && previous.kind === kind
      && sameInsertIds(previous.insertIds, insertIdList)
    ) {
      previous.to = segmentTo;
      previous.text += text;
      return true;
    }

    segments.push({
      from: segmentFrom,
      to: segmentTo,
      kind,
      insertIds: insertIdList,
      text,
    });
    return true;
  });

  return segments;
}

function applyMixedInsertDeletion(
  newTr: Transaction,
  metadata: Record<string, StoredMark>,
  from: number,
  to: number,
  actor: string,
  suggestionType: MarkType
): { handled: boolean; metadata: Record<string, StoredMark>; metadataChanged: boolean } {
  const segments = collectDeleteRangeSegments(newTr.doc, from, to, suggestionType);
  const hasInsert = segments.some((segment) => segment.kind === 'insert');
  const hasPlain = segments.some((segment) => segment.kind === 'plain');
  if (!hasInsert || !hasPlain) {
    return { handled: false, metadata, metadataChanged: false };
  }

  const touchedInsertIds = new Set<string>();
  const firstPlainSegment = segments.find((segment) => segment.kind === 'plain') ?? null;
  let nextMetadata = metadata;
  let metadataChanged = false;

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment.kind === 'insert') {
      for (const id of segment.insertIds) touchedInsertIds.add(id);
      newTr.delete(segment.from, segment.to);
      continue;
    }
    if (segment.kind !== 'plain') continue;

    const suggestionId = generateMarkId();
    const createdAt = new Date().toISOString();
    newTr.addMark(
      segment.from,
      segment.to,
      suggestionType.create({
        id: suggestionId,
        kind: 'delete',
        by: actor,
      })
    );

    nextMetadata = {
      ...nextMetadata,
      [suggestionId]: {
        ...buildSuggestionMetadata('delete', actor, null, createdAt),
        quote: segment.text,
      },
    };
    metadataChanged = true;
  }

  const syncedMetadata = syncInsertSuggestionMetadataFromDoc(newTr.doc, nextMetadata, [...touchedInsertIds]);
  metadataChanged = metadataChanged || syncedMetadata !== nextMetadata;
  nextMetadata = syncedMetadata;

  if (firstPlainSegment) {
    newTr.setSelection(TextSelection.create(newTr.doc, Math.min(firstPlainSegment.from, newTr.doc.content.size)));
  }

  return { handled: true, metadata: nextMetadata, metadataChanged };
}

function buildCollapsedInsertAnchorMetadata(pos: number): Pick<StoredMark, 'range'> {
  const safePos = Math.max(0, pos);
  return {
    range: { from: safePos, to: safePos },
  };
}

function setSelectionAfterInsertedText(tr: Transaction, pos: number): void {
  tr.setSelection(TextSelection.create(tr.doc, Math.max(0, Math.min(pos, tr.doc.content.size))));
}

function detectTextPreservingSuggestionRewrite(
  oldState: EditorState,
  newState: EditorState,
): { oldFrom: number; oldTo: number; newFrom: number; newTo: number } | null {
  const oldText = oldState.doc.textBetween(0, oldState.doc.content.size, '\n', '\n');
  const newText = newState.doc.textBetween(0, newState.doc.content.size, '\n', '\n');
  if (oldText !== newText) return null;

  const from = oldState.doc.content.findDiffStart(newState.doc.content);
  if (typeof from !== 'number') return null;
  const diffEnd = oldState.doc.content.findDiffEnd(newState.doc.content);
  if (!diffEnd) return null;

  return {
    oldFrom: from,
    oldTo: diffEnd.a,
    newFrom: from,
    newTo: diffEnd.b,
  };
}

function expandChangedRange(doc: ProseMirrorNode, from: number, to: number): MarkRange {
  if (to > from) {
    return { from, to };
  }
  return {
    from: Math.max(0, from - 1),
    to: Math.min(doc.content.size, from + 1),
  };
}

function buildTextPreservingInsertPersistenceTransaction(
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  const rewrite = detectTextPreservingSuggestionRewrite(oldState, newState);
  if (!rewrite) return null;

  const suggestionType = newState.schema.marks.proofSuggestion;
  if (!suggestionType) return null;

  const oldChangedRange = expandChangedRange(oldState.doc, rewrite.oldFrom, rewrite.oldTo);
  const newChangedRange = expandChangedRange(newState.doc, rewrite.newFrom, rewrite.newTo);
  const oldInsertIds = collectSuggestionIdsInRange(
    oldState.doc,
    'insert',
    oldChangedRange.from,
    oldChangedRange.to,
  );
  if (oldInsertIds.length === 0) return null;
  const oldInsertIdSet = new Set(oldInsertIds);

  const authoredType = newState.schema.marks.proofAuthored ?? null;
  const oldMetadata = getMarkMetadata(oldState);
  let metadata = getMarkMetadata(newState);
  let metadataChanged = false;
  let tr = newState.tr;

  if (authoredType) {
    tr = tr.removeMark(newChangedRange.from, newChangedRange.to, authoredType);
  }

  const spuriousSuggestionIds = new Set<string>([
    ...collectSuggestionIdsInRange(newState.doc, 'delete', newChangedRange.from, newChangedRange.to),
    ...collectSuggestionIdsInRange(newState.doc, 'replace', newChangedRange.from, newChangedRange.to),
  ]);
  for (const id of spuriousSuggestionIds) {
    const kind = metadata[id]?.kind;
    if (kind !== 'delete' && kind !== 'replace') continue;
    const range = resolveLiveSuggestionRange(newState.doc, id, kind);
    if (range) {
      tr = tr.removeMark(range.from, range.to, suggestionType);
    }
    if (metadata[id]) {
      delete metadata[id];
      metadataChanged = true;
    }
  }

  const spuriousInsertIds = collectSuggestionIdsInRange(
    newState.doc,
    'insert',
    newChangedRange.from,
    newChangedRange.to,
  ).filter((id) => !oldInsertIdSet.has(id));
  for (const id of spuriousInsertIds) {
    const range = resolveLiveSuggestionRange(newState.doc, id, 'insert');
    if (range) {
      tr = tr.removeMark(range.from, range.to, suggestionType);
    }
    if (metadata[id]) {
      delete metadata[id];
      metadataChanged = true;
    }
  }

  const now = Date.now();
  for (const id of oldInsertIds) {
    const oldRange = resolveLiveSuggestionRange(oldState.doc, id, 'insert');
    const oldEntry = oldMetadata[id];
    if (!oldRange || !oldEntry || oldEntry.kind !== 'insert') continue;

    const restoredFrom = Math.max(0, Math.min(oldRange.from, newState.doc.content.size));
    const restoredTo = Math.max(restoredFrom, Math.min(oldRange.to, newState.doc.content.size));
    if (restoredTo <= restoredFrom) continue;

    if (authoredType) {
      tr = tr.removeMark(restoredFrom, restoredTo, authoredType);
    }
    tr = tr.addMark(
      restoredFrom,
      restoredTo,
      suggestionType.create({ id, kind: 'insert', by: oldEntry.by ?? metadata[id]?.by ?? 'unknown' })
    );

    metadata[id] = {
      ...metadata[id],
      ...oldEntry,
      kind: 'insert',
      by: oldEntry.by ?? metadata[id]?.by ?? 'unknown',
      status: 'pending',
    };
    metadataChanged = true;

    if (oldEntry.by) {
      lastInsertByActor.set(oldEntry.by, {
        id,
        from: restoredFrom,
        to: restoredTo,
        by: oldEntry.by,
        updatedAt: now,
      });
    }
  }

  const syncedMetadata = syncInsertSuggestionMetadataFromDoc(tr.doc, metadata, oldInsertIds);
  metadataChanged = metadataChanged || syncedMetadata !== metadata;
  metadata = syncedMetadata;
  tr = stripAuthoredMarksFromPendingInsertRanges(tr, authoredType, metadata);

  if (tr.steps.length === 0 && !metadataChanged) return null;
  const finalTr = metadataChanged ? syncSuggestionMetadataTransaction(newState, tr, metadata) : tr;
  finalTr.setMeta('suggestions-wrapped', true);
  finalTr.setMeta('addToHistory', false);
  return finalTr;
}

type InlineInsertRun =
  | { kind: 'insert'; from: number; to: number; text: string; id: string; by: string }
  | { kind: 'plain'; from: number; to: number; text: string }
  | { kind: 'other'; from: number; to: number; text: string };

function summarizeInlineInsertRuns(runs: InlineInsertRun[]): Array<Record<string, unknown>> {
  return runs.map((run) => {
    if (run.kind === 'insert') {
      return {
        kind: run.kind,
        from: run.from,
        to: run.to,
        id: run.id,
        by: run.by,
        text: run.text,
      };
    }
    return {
      kind: run.kind,
      from: run.from,
      to: run.to,
      text: run.text,
    };
  });
}

function collectInlineInsertRuns(doc: ProseMirrorNode): InlineInsertRun[] {
  const runs: InlineInsertRun[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText) return true;

    const text = node.text ?? '';
    const insertMarks = node.marks.filter((mark) =>
      mark.type.name === 'proofSuggestion'
      && normalizeSuggestionKind(mark.attrs.kind) === 'insert'
      && typeof mark.attrs.id === 'string'
      && mark.attrs.id.length > 0
    );
    const hasOtherMarks = node.marks.some((mark) =>
      mark.type.name !== 'proofSuggestion'
      || normalizeSuggestionKind(mark.attrs.kind) !== 'insert'
    );

    let nextRun: InlineInsertRun;
    if (insertMarks.length === 1 && !hasOtherMarks) {
      nextRun = {
        kind: 'insert',
        from: pos,
        to: pos + node.nodeSize,
        text,
        id: String(insertMarks[0]!.attrs.id),
        by: typeof insertMarks[0]!.attrs.by === 'string' ? insertMarks[0]!.attrs.by : 'unknown',
      };
    } else if (node.marks.length === 0) {
      nextRun = {
        kind: 'plain',
        from: pos,
        to: pos + node.nodeSize,
        text,
      };
    } else {
      nextRun = {
        kind: 'other',
        from: pos,
        to: pos + node.nodeSize,
        text,
      };
    }

    const previous = runs[runs.length - 1];
    if (
      previous
      && previous.kind === nextRun.kind
      && (
        previous.kind !== 'insert'
        || (nextRun.kind === 'insert'
          && previous.id === nextRun.id
          && previous.by === nextRun.by)
      )
      && previous.to === nextRun.from
    ) {
      previous.to = nextRun.to;
      previous.text += nextRun.text;
    } else {
      runs.push(nextRun);
    }

    return true;
  });

  return runs;
}

function parseStoredMarkTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldMergeRecentPendingInsertFragments(
  leftMeta: StoredMark,
  rightMeta: StoredMark,
  leftBy: string,
  rightBy: string,
): boolean {
  if (leftMeta.kind !== 'insert' || rightMeta.kind !== 'insert') return false;
  if ((leftMeta.status && leftMeta.status !== 'pending') || (rightMeta.status && rightMeta.status !== 'pending')) return false;
  if (leftBy !== rightBy) return false;

  const leftCreatedAt = parseStoredMarkTimestamp(leftMeta.createdAt);
  const rightCreatedAt = parseStoredMarkTimestamp(rightMeta.createdAt);
  if (leftCreatedAt === null || rightCreatedAt === null) return false;

  return Math.abs(rightCreatedAt - leftCreatedAt) <= COALESCE_WINDOW_MS;
}

function buildAdjacentSplitInsertMergeTransaction(
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  const suggestionType = newState.schema.marks.proofSuggestion;
  if (!suggestionType) return null;

  const authoredType = newState.schema.marks.proofAuthored ?? null;
  const oldMetadata = getMarkMetadata(oldState);
  let metadata = getMarkMetadata(newState);
  let metadataChanged = false;
  let tr = newState.tr;

  const oldPendingInsertIds = new Set(
    Object.entries(oldMetadata)
      .filter(([, mark]) => mark?.kind === 'insert' && mark?.status !== 'accepted' && mark?.status !== 'rejected')
      .map(([id]) => id),
  );

  if (oldPendingInsertIds.size === 0) return null;

  const runs = collectInlineInsertRuns(newState.doc);
  console.log('[suggestions.mergeCheck.runs]', summarizeInlineInsertRuns(runs));
  const mergedInsertIds = new Set<string>();

  for (let index = 0; index <= runs.length - 3; index += 1) {
    const left = runs[index];
    const gap = runs[index + 1];
    const right = runs[index + 2];
    if (!left || !gap || !right) continue;
    console.log('[suggestions.mergeCheck.window]', {
      index,
      left: left.kind === 'insert'
        ? { kind: left.kind, id: left.id, by: left.by, text: left.text, from: left.from, to: left.to }
        : left,
      gap,
      right: right.kind === 'insert'
        ? { kind: right.kind, id: right.id, by: right.by, text: right.text, from: right.from, to: right.to }
        : right,
    });
    if (left.kind !== 'insert' || gap.kind !== 'plain' || right.kind !== 'insert') continue;
    if (!isWhitespaceOnly(gap.text)) {
      console.log('[suggestions.mergeCheck.skip]', { reason: 'gap-not-whitespace', gapText: gap.text });
      continue;
    }
    if (left.id === right.id) {
      console.log('[suggestions.mergeCheck.skip]', { reason: 'same-id', id: left.id });
      continue;
    }
    const leftMeta = metadata[left.id];
    const rightMeta = metadata[right.id];
    if (!leftMeta || leftMeta.kind !== 'insert' || !rightMeta || rightMeta.kind !== 'insert') {
      console.log('[suggestions.mergeCheck.skip]', { reason: 'missing-insert-metadata', leftId: left.id, rightId: right.id });
      continue;
    }
    if ((leftMeta.status && leftMeta.status !== 'pending') || (rightMeta.status && rightMeta.status !== 'pending')) {
      console.log('[suggestions.mergeCheck.skip]', {
        reason: 'non-pending-status',
        leftId: left.id,
        rightId: right.id,
        leftStatus: leftMeta.status,
        rightStatus: rightMeta.status,
      });
      continue;
    }

    const leftBy = leftMeta.by ?? left.by;
    const rightBy = rightMeta.by ?? right.by;
    const leftWasPending = oldPendingInsertIds.has(left.id);
    const rightWasPending = oldPendingInsertIds.has(right.id);
    const allowRecentPendingPendingMerge = rightWasPending && shouldMergeRecentPendingInsertFragments(
      leftMeta,
      rightMeta,
      leftBy,
      rightBy,
    );
    if (!leftWasPending || (rightWasPending && !allowRecentPendingPendingMerge)) {
      console.log('[suggestions.mergeCheck.skip]', {
        reason: 'old-pending-id-shape',
        leftId: left.id,
        rightId: right.id,
        leftWasPending,
        rightWasPending,
        allowRecentPendingPendingMerge,
      });
      continue;
    }
    if (leftBy !== rightBy) {
      console.log('[suggestions.mergeCheck.skip]', {
        reason: 'different-actors',
        leftId: left.id,
        rightId: right.id,
        leftBy,
        rightBy,
      });
      continue;
    }

    if (authoredType) {
      tr = tr.removeMark(gap.from, gap.to, authoredType);
      tr = tr.removeMark(right.from, right.to, authoredType);
    }
    tr = tr.removeMark(right.from, right.to, suggestionType);
    tr = tr.addMark(
      gap.from,
      right.to,
      suggestionType.create({ id: left.id, kind: 'insert', by: leftBy }),
    );

    delete metadata[right.id];
    metadataChanged = true;
    mergedInsertIds.add(left.id);

    console.log('[suggestions.mergeAdjacentInsertSplit]', {
      leftId: left.id,
      rightId: right.id,
      gapText: gap.text,
    });

    index += 2;
  }

  if (mergedInsertIds.size === 0) return null;

  const syncedMetadata = syncInsertSuggestionMetadataFromDoc(tr.doc, metadata, [...mergedInsertIds]);
  metadataChanged = metadataChanged || syncedMetadata !== metadata;
  metadata = syncedMetadata;
  tr = stripAuthoredMarksFromPendingInsertRanges(tr, authoredType, metadata);

  if (tr.steps.length === 0 && !metadataChanged) return null;
  const finalTr = metadataChanged ? syncSuggestionMetadataTransaction(newState, tr, metadata) : tr;
  finalTr.setMeta('suggestions-wrapped', true);
  finalTr.setMeta('addToHistory', false);
  return finalTr;
}

function detectPlainTextInsertionDiff(
  oldState: EditorState,
  newState: EditorState,
): { from: number; to: number; insertedText: string } | null {
  const from = oldState.doc.content.findDiffStart(newState.doc.content);
  if (typeof from !== 'number') return null;
  const diffEnd = oldState.doc.content.findDiffEnd(newState.doc.content);
  if (!diffEnd) return null;

  const insertedText = newState.doc.textBetween(from, diffEnd.b, '\n', '\n');
  const deletedText = oldState.doc.textBetween(from, diffEnd.a, '\n', '\n');
  if (!insertedText || deletedText.length > 0) return null;

  return { from, to: diffEnd.b, insertedText };
}

function buildPlainInsertionSuggestionFallbackTransaction(
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  const diff = detectPlainTextInsertionDiff(oldState, newState);
  if (!diff) return null;

  const suggestionType = newState.schema.marks.proofSuggestion;
  if (!suggestionType) return null;

  const actor = getCurrentActor();
  const now = Date.now();
  let metadata = getMarkMetadata(newState);
  let metadataChanged = false;
  let tr = newState.tr;

  const authoredType = newState.schema.marks.proofAuthored ?? null;
  if (authoredType) {
    tr = tr.removeMark(diff.from, diff.to, authoredType);
  }

  const existingInsertIds = collectSuggestionIdsInRange(newState.doc, 'insert', diff.from, diff.to);
  if (existingInsertIds.length > 0) {
    const syncedMetadata = syncInsertSuggestionMetadataFromDoc(tr.doc, metadata, existingInsertIds);
    metadataChanged = metadataChanged || syncedMetadata !== metadata;
    metadata = syncedMetadata;
    if (tr.steps.length === 0 && !metadataChanged) return null;
    const finalTr = metadataChanged ? syncSuggestionMetadataTransaction(newState, tr, metadata) : tr;
    finalTr.setMeta('suggestions-wrapped', true);
    return finalTr;
  }

  const candidate = getCoalescableInsertCandidate(newState.doc, metadata, diff.from, actor, now);
  if (candidate) {
    tr = tr.addMark(
      diff.from,
      diff.to,
      suggestionType.create({ id: candidate.id, kind: 'insert', by: actor })
    );
    const syncedMetadata = syncInsertSuggestionMetadataFromDoc(tr.doc, metadata, [candidate.id]);
    metadataChanged = metadataChanged || syncedMetadata !== metadata;
    metadata = syncedMetadata;
    const updatedRange = resolveLiveInsertSuggestionRange(tr.doc, candidate.id) ?? candidate.range;
    lastInsertByActor.set(actor, {
      id: candidate.id,
      from: updatedRange.from,
      to: updatedRange.to,
      by: actor,
      updatedAt: now,
    });
  } else {
    const suggestionId = generateMarkId();
    const createdAt = new Date().toISOString();
    tr = tr.addMark(
      diff.from,
      diff.to,
      suggestionType.create({ id: suggestionId, kind: 'insert', by: actor })
    );
    metadata = {
      ...metadata,
      [suggestionId]: {
        ...buildSuggestionMetadata('insert', actor, diff.insertedText, createdAt),
        ...buildCollapsedInsertAnchorMetadata(diff.from),
      },
    };
    metadataChanged = true;
    lastInsertByActor.set(actor, {
      id: suggestionId,
      from: diff.from,
      to: diff.to,
      by: actor,
      updatedAt: now,
    });
  }

  tr = stripAuthoredMarksFromPendingInsertRanges(tr, authoredType, metadata);
  if (tr.steps.length === 0 && !metadataChanged) return null;
  const finalTr = metadataChanged ? syncSuggestionMetadataTransaction(newState, tr, metadata) : tr;
  finalTr.setMeta('suggestions-wrapped', true);
  return finalTr;
}

export function __debugBuildPlainInsertionSuggestionFallbackTransaction(
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  return buildPlainInsertionSuggestionFallbackTransaction(oldState, newState);
}

export function __debugBuildTextPreservingInsertPersistenceTransaction(
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  return buildTextPreservingInsertPersistenceTransaction(oldState, newState);
}

export function __debugBuildAdjacentSplitInsertMergeTransaction(
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  return buildAdjacentSplitInsertMergeTransaction(oldState, newState);
}

export function hasActiveInsertCoalescingCandidate(
  state: EditorState,
  pos: number,
): boolean {
  const actor = getCurrentActor();
  const metadata = getMarkMetadata(state);
  return getCoalescableInsertCandidate(state.doc, metadata, pos, actor, Date.now()) !== null;
}

export function __debugHasActiveInsertCoalescingCandidate(
  state: EditorState,
  pos: number,
): boolean {
  return hasActiveInsertCoalescingCandidate(state, pos);
}

export function __debugHasRecentSuggestionsInsertCoalescingState(): boolean {
  return hasRecentSuggestionsInsertCoalescingState();
}

function detectSelectionReplacement(
  tr: Transaction,
  state: EditorState
): { from: number; to: number; deletedText: string; insertedText: string } | null {
  const domSelectionRange = tr.getMeta('proof-dom-selection-range') as MarkRange | null | undefined;
  const from = domSelectionRange?.from ?? state.selection.from;
  const to = domSelectionRange?.to ?? state.selection.to;
  if (from === to) return null;

  let hasTextReplaceStep = false;
  for (const step of tr.steps) {
    const stepJson = step.toJSON() as {
      stepType?: string;
      from?: number;
      to?: number;
      slice?: { content?: SliceNode[] };
    };

    if (stepJson.stepType === 'replace') {
      const { text: insertedText, hasNonText } = collectSliceText(stepJson.slice?.content);
      if (hasNonText) return null;
      if ((stepJson.from ?? 0) !== (stepJson.to ?? 0) || insertedText.length > 0) {
        hasTextReplaceStep = true;
      }
      continue;
    }

    if (stepJson.stepType === 'addMark' || stepJson.stepType === 'removeMark') {
      continue;
    }

    return null;
  }

  if (!hasTextReplaceStep) return null;

  const docSize = tr.doc.content.size;
  const mappedFrom = Math.max(0, Math.min(tr.mapping.map(from, -1), docSize));
  const mappedTo = Math.max(mappedFrom, Math.min(tr.mapping.map(to, 1), docSize));
  const deletedText = state.doc.textBetween(from, to, '');
  const insertedText = tr.doc.textBetween(mappedFrom, mappedTo, '');

  if (!deletedText && !insertedText) return null;

  return { from, to, deletedText, insertedText };
}

function resolveContainingTextblockRange(
  state: EditorState,
  pos: number,
): MarkRange | null {
  const docSize = state.doc.content.size;
  const clampedPos = Math.max(0, Math.min(pos, docSize));
  const $pos = state.doc.resolve(clampedPos);

  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    const node = $pos.node(depth);
    if (!node.isTextblock) continue;
    const from = $pos.start(depth);
    const to = $pos.end(depth);
    if (to <= from) return null;
    return { from, to };
  }

  return null;
}

function resolveBackwardWordOffset(text: string): number {
  let index = text.length;
  while (index > 0 && /\s/.test(text[index - 1] ?? '')) index -= 1;
  while (index > 0 && !/\s/.test(text[index - 1] ?? '')) index -= 1;
  return index;
}

function resolveForwardWordOffset(text: string): number {
  let index = 0;
  while (index < text.length && /\s/.test(text[index] ?? '')) index += 1;
  while (index < text.length && !/\s/.test(text[index] ?? '')) index += 1;
  return index;
}

export function __debugResolveTrackedDeleteIntentFromBeforeInput(
  inputType: string
): TrackedDeleteIntent | null {
  switch (inputType) {
    case 'deleteContentBackward':
      return { key: 'Backspace' };
    case 'deleteWordBackward':
      return { key: 'Backspace', modifiers: { altKey: true, ctrlKey: true } };
    case 'deleteSoftLineBackward':
    case 'deleteHardLineBackward':
      return { key: 'Backspace', modifiers: { metaKey: true } };
    case 'deleteContentForward':
      return { key: 'Delete' };
    case 'deleteWordForward':
      return { key: 'Delete', modifiers: { altKey: true, ctrlKey: true } };
    case 'deleteSoftLineForward':
    case 'deleteHardLineForward':
      return { key: 'Delete', modifiers: { metaKey: true } };
    default:
      return null;
  }
}

function rememberModifiedDeleteIntent(
  view: EditorView,
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'metaKey' | 'ctrlKey'>,
  options?: { handled?: boolean },
): void {
  if (event.key !== 'Backspace' && event.key !== 'Delete') return;
  if (!event.altKey && !event.metaKey && !event.ctrlKey) return;
  pendingModifiedDeleteIntents.set(view, {
    intent: {
      key: event.key,
      modifiers: {
        altKey: event.altKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
      },
    },
    at: Date.now(),
    handled: options?.handled === true,
  });
}

function takePendingModifiedDeleteIntent(view: EditorView): PendingTrackedDeleteIntent | null {
  const entry = pendingModifiedDeleteIntents.get(view);
  if (!entry) return null;
  pendingModifiedDeleteIntents.delete(view);
  if (Date.now() - entry.at > PENDING_DELETE_INTENT_TTL_MS) return null;
  return entry;
}

export function __debugResolveTrackedDeleteIntentForBeforeInput(
  inputType: string,
  pendingIntent: TrackedDeleteIntent | null,
): TrackedDeleteIntent | null {
  const mappedIntent = __debugResolveTrackedDeleteIntentFromBeforeInput(inputType);
  if (!pendingIntent) return mappedIntent;
  if (!mappedIntent) {
    return inputType.startsWith('delete') ? pendingIntent : null;
  }
  if (mappedIntent && mappedIntent.key !== pendingIntent.key) return mappedIntent;
  return pendingIntent;
}

export function __debugResolveTrackedDeleteRange(
  state: EditorState,
  key: 'Backspace' | 'Delete',
  modifiers?: { altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean },
): MarkRange | null {
  const selection = state.selection;
  if (!selection.empty) {
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    return to > from ? { from, to } : null;
  }

  const cursor = selection.from;
  const textblock = resolveContainingTextblockRange(state, cursor);

  if (key === 'Backspace') {
    if (modifiers?.metaKey && textblock) {
      return cursor > textblock.from ? { from: textblock.from, to: cursor } : null;
    }
    if ((modifiers?.altKey || modifiers?.ctrlKey) && textblock) {
      const prefix = state.doc.textBetween(textblock.from, cursor, '', '');
      const startOffset = resolveBackwardWordOffset(prefix);
      const from = textblock.from + startOffset;
      return cursor > from ? { from, to: cursor } : null;
    }
    return cursor > 0 ? { from: cursor - 1, to: cursor } : null;
  }

  if (modifiers?.metaKey && textblock) {
    return cursor < textblock.to ? { from: cursor, to: textblock.to } : null;
  }
  if ((modifiers?.altKey || modifiers?.ctrlKey) && textblock) {
    const suffix = state.doc.textBetween(cursor, textblock.to, '', '');
    const endOffset = resolveForwardWordOffset(suffix);
    const to = cursor + endOffset;
    return to > cursor ? { from: cursor, to } : null;
  }
  return cursor < state.doc.content.size ? { from: cursor, to: cursor + 1 } : null;
}

/**
 * Wrap a transaction to convert edits to suggestions when enabled.
 * This intercepts the transaction and converts direct edits into tracked changes:
 * - Insertions get marked with proofSuggestion kind=insert
 * - Deletions get marked with proofSuggestion kind=delete instead of being removed
 * - Replacements become proofSuggestion kind=replace with content stored in metadata
 */
export function wrapTransactionForSuggestions(
  tr: Transaction,
  state: EditorState,
  enabled: boolean
): Transaction {
  if (!enabled || !tr.docChanged) {
    return tr;
  }
  if (isExplicitYjsChangeOriginTransaction(tr)) {
    return tr;
  }
  if (transactionCarriesInsertedSuggestionMarks(tr)) {
    return tr;
  }

  const suggestionType = state.schema.marks.proofSuggestion;
  const authoredType = state.schema.marks.proofAuthored ?? null;

  if (!suggestionType) {
    console.warn('[suggestions] Missing proofSuggestion mark type');
    return tr;
  }

  // Check for structural changes (paragraph splits, etc). Pass through unchanged.
  for (const step of tr.steps) {
    const stepJson = step.toJSON() as { stepType?: string; slice?: { content?: SliceNode[] } };
    if (stepJson.stepType === 'replace' && stepJson.slice?.content) {
      const { hasNonText } = collectSliceText(stepJson.slice.content);
      if (hasNonText) {
        return tr;
      }
    }
  }

  const actor = getCurrentActor();
  let metadata = getMarkMetadata(state);
  let metadataChanged = false;

  // Build a new transaction that converts edits to tracked changes.
  const newTr = state.tr;
  let writeOffset = 0;

  const selectionReplacement = detectSelectionReplacement(tr, state);
  if (selectionReplacement) {
    const { from, to, deletedText, insertedText } = selectionReplacement;
    const docSize = newTr.doc.content.size;
    const safeFrom = Math.max(0, Math.min(from, docSize));
    const safeTo = Math.max(safeFrom, Math.min(to, docSize));
    const existing = detectSuggestionKinds(newTr.doc, safeFrom, safeTo, suggestionType);

    if (deletedText && !insertedText) {
      lastInsertByActor.delete(actor);

      if (existing.hasDelete || existing.hasInsert) {
        const mixedDeleteResult = applyMixedInsertDeletion(newTr, metadata, safeFrom, safeTo, actor, suggestionType);
        if (mixedDeleteResult.handled) {
          metadataChanged = metadataChanged || mixedDeleteResult.metadataChanged;
          metadata = mixedDeleteResult.metadata;
        } else {
          const touchedInsertIds = existing.hasInsert
            ? collectSuggestionIdsInRange(newTr.doc, 'insert', safeFrom, safeTo)
            : [];
          newTr.delete(safeFrom, safeTo);
          if (touchedInsertIds.length > 0) {
            const syncedMetadata = syncInsertSuggestionMetadataFromDoc(newTr.doc, metadata, touchedInsertIds);
            metadataChanged = metadataChanged || syncedMetadata !== metadata;
            metadata = syncedMetadata;
          }
        }
      } else if (existing.hasReplace) {
        newTr.removeMark(safeFrom, safeTo, suggestionType);
      } else {
        const suggestionId = generateMarkId();
        const createdAt = new Date().toISOString();

        newTr.addMark(safeFrom, safeTo, suggestionType.create({
          id: suggestionId,
          kind: 'delete',
          by: actor,
        }));

        metadata = {
          ...metadata,
          [suggestionId]: buildSuggestionMetadata('delete', actor, null, createdAt),
        };
        metadataChanged = true;
        newTr.setSelection(TextSelection.create(newTr.doc, safeFrom));
      }
    } else if (deletedText && insertedText) {
      lastInsertByActor.delete(actor);

      if (existing.hasDelete) {
        newTr.delete(safeFrom, safeTo);

        const suggestionId = generateMarkId();
        const createdAt = new Date().toISOString();
        newTr.insertText(insertedText, safeFrom);
        newTr.addMark(
          safeFrom,
          safeFrom + insertedText.length,
          suggestionType.create({ id: suggestionId, kind: 'insert', by: actor })
        );

        metadata = {
          ...metadata,
          [suggestionId]: {
            ...buildSuggestionMetadata('insert', actor, insertedText, createdAt),
            ...buildCollapsedInsertAnchorMetadata(safeFrom),
          },
        };
        metadataChanged = true;
      } else if (existing.hasInsert) {
        const touchedInsertIds = collectSuggestionIdsInRange(newTr.doc, 'insert', safeFrom, safeTo);
        if (touchedInsertIds.length === 1) {
          const suggestionId = touchedInsertIds[0];
          const existingMeta = metadata[suggestionId];
          const insertBy = existingMeta?.by ?? actor;

          newTr.replaceWith(safeFrom, safeTo, state.schema.text(insertedText));
          newTr.addMark(
            safeFrom,
            safeFrom + insertedText.length,
            suggestionType.create({ id: suggestionId, kind: 'insert', by: insertBy })
          );

          const syncedMetadata = syncInsertSuggestionMetadataFromDoc(newTr.doc, metadata, touchedInsertIds);
          metadataChanged = metadataChanged || syncedMetadata !== metadata;
          metadata = syncedMetadata;
        } else {
          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();

          newTr.replaceWith(safeFrom, safeTo, state.schema.text(insertedText));
          newTr.addMark(
            safeFrom,
            safeFrom + insertedText.length,
            suggestionType.create({ id: suggestionId, kind: 'insert', by: actor })
          );

          metadata = {
            ...metadata,
            [suggestionId]: {
              ...buildSuggestionMetadata('insert', actor, insertedText, createdAt),
              ...buildCollapsedInsertAnchorMetadata(safeFrom),
            },
          };
          metadataChanged = true;
        }
      } else {
        const deleteSuggestionId = generateMarkId();
        const insertSuggestionId = generateMarkId();
        const createdAt = new Date().toISOString();

        newTr.insertText(insertedText, safeFrom);
        newTr.addMark(
          safeFrom,
          safeFrom + insertedText.length,
          suggestionType.create({ id: insertSuggestionId, kind: 'insert', by: actor })
        );
        newTr.addMark(
          safeFrom + insertedText.length,
          safeTo + insertedText.length,
          suggestionType.create({
            id: deleteSuggestionId,
            kind: 'delete',
            by: actor,
          })
        );

        metadata = {
          ...metadata,
          [deleteSuggestionId]: {
            ...buildSuggestionMetadata('delete', actor, null, createdAt),
            quote: deletedText,
          },
          [insertSuggestionId]: {
            ...buildSuggestionMetadata('insert', actor, insertedText, createdAt),
            ...buildCollapsedInsertAnchorMetadata(safeFrom),
          },
        };
        metadataChanged = true;

        lastInsertByActor.set(actor, {
          id: insertSuggestionId,
          from: safeFrom,
          to: safeFrom + insertedText.length,
          by: actor,
          updatedAt: Date.now(),
        });

        newTr.setSelection(TextSelection.create(newTr.doc, safeFrom + insertedText.length));
      }
    }

    let finalTr = newTr;
    finalTr = stripAuthoredMarksFromPendingInsertRanges(finalTr, authoredType, metadata);
    if (metadataChanged) {
      finalTr = syncSuggestionMetadataTransaction(state, finalTr, metadata);
    }
    finalTr.setMeta('suggestions-wrapped', true);
    return finalTr;
  }

  for (const step of tr.steps) {
    const stepJson = step.toJSON() as {
      stepType?: string;
      from?: number;
      to?: number;
      slice?: { content?: SliceNode[] };
    };

    if (stepJson.stepType === 'replace') {
      const origFrom = stepJson.from ?? 0;
      const origTo = stepJson.to ?? 0;
      const from = origFrom + writeOffset;
      const to = origTo + writeOffset;
      const slice = stepJson.slice;

      const { text: insertedText } = collectSliceText(slice?.content);
      const deletedText = state.doc.textBetween(origFrom, origTo, '');

      const docSize = newTr.doc.content.size;
      const safeFrom = Math.max(0, Math.min(from, docSize));
      const safeTo = Math.max(safeFrom, Math.min(to, docSize));

      // CASE 1: Pure deletion (no insertion)
      if (deletedText && !insertedText) {
        lastInsertByActor.delete(actor);
        const existing = detectSuggestionKinds(newTr.doc, safeFrom, safeTo, suggestionType);

        if (existing.hasDelete || existing.hasInsert) {
          const mixedDeleteResult = applyMixedInsertDeletion(newTr, metadata, safeFrom, safeTo, actor, suggestionType);
          if (mixedDeleteResult.handled) {
            metadataChanged = metadataChanged || mixedDeleteResult.metadataChanged;
            metadata = mixedDeleteResult.metadata;
            const removedInsertChars = collectDeleteRangeSegments(state.doc, origFrom, origTo, suggestionType)
              .filter((segment) => segment.kind === 'insert')
              .reduce((total, segment) => total + (segment.to - segment.from), 0);
            writeOffset -= removedInsertChars;
          } else {
            // Already tracked: accept deletion or reject insertion
            const touchedInsertIds = existing.hasInsert
              ? collectSuggestionIdsInRange(newTr.doc, 'insert', safeFrom, safeTo)
              : [];
            newTr.delete(safeFrom, safeTo);
            writeOffset -= deletedText.length;
            if (touchedInsertIds.length > 0) {
              const syncedMetadata = syncInsertSuggestionMetadataFromDoc(newTr.doc, metadata, touchedInsertIds);
              metadataChanged = metadataChanged || syncedMetadata !== metadata;
              metadata = syncedMetadata;
            }
          }
        } else if (existing.hasReplace) {
          // Remove replace suggestion and keep content
          newTr.removeMark(safeFrom, safeTo, suggestionType);
        } else {
          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();

          newTr.addMark(safeFrom, safeTo, suggestionType.create({
            id: suggestionId,
            kind: 'delete',
            by: actor,
          }));

          metadata = {
            ...metadata,
            [suggestionId]: buildSuggestionMetadata('delete', actor, null, createdAt),
          };
          metadataChanged = true;

          // Move cursor to start of deletion (don't leave it inside deleted text)
          newTr.setSelection(TextSelection.create(newTr.doc, safeFrom));
        }
      }
      // CASE 2: Pure insertion (no deletion)
      else if (insertedText && !deletedText) {
        const now = Date.now();
        const whitespaceOnly = isWhitespaceOnly(insertedText);
        const candidate = getCoalescableInsertCandidate(newTr.doc, metadata, safeFrom, actor, now);

        if (candidate && whitespaceOnly) {
          // Whitespace with active candidate: extend the mark to include it.
          // This keeps "Proof is" as one suggestion instead of splitting at the space.
          console.log('[suggestions.insertDecision]', {
            case: 'coalesce-whitespace',
            insertedText,
            from: safeFrom,
            candidateId: candidate.id,
            candidateRange: candidate.range,
            direction: candidate.direction,
          });
          const existingMeta = metadata[candidate.id];
          const existingContent = typeof existingMeta?.content === 'string' ? existingMeta.content : '';
          const updatedContent = candidate.direction === 'append'
            ? `${existingContent}${insertedText}`
            : `${insertedText}${existingContent}`;

          newTr.insertText(insertedText, candidate.insertPos);
          newTr.addMark(
            candidate.insertPos,
            candidate.insertPos + insertedText.length,
            suggestionType.create({ id: candidate.id, kind: 'insert', by: actor })
          );
          writeOffset += insertedText.length;

          metadata = {
            ...metadata,
            [candidate.id]: {
              ...existingMeta,
              content: updatedContent,
            },
          };
          metadataChanged = true;

          lastInsertByActor.set(actor, {
            id: candidate.id,
            from: candidate.range.from,
            to: candidate.range.to + insertedText.length,
            by: actor,
            updatedAt: now,
          });
          setSelectionAfterInsertedText(newTr, candidate.insertPos + insertedText.length);
        } else if (candidate) {
          // Non-whitespace with active candidate: coalesce into existing mark
          console.log('[suggestions.insertDecision]', {
            case: 'coalesce-text',
            insertedText,
            from: safeFrom,
            candidateId: candidate.id,
            candidateRange: candidate.range,
            direction: candidate.direction,
          });
          const existingMeta = metadata[candidate.id];
          const existingContent = typeof existingMeta?.content === 'string' ? existingMeta.content : '';
          const updatedContent = candidate.direction === 'append'
            ? `${existingContent}${insertedText}`
            : `${insertedText}${existingContent}`;

          newTr.insertText(insertedText, candidate.insertPos);
          newTr.addMark(
            candidate.insertPos,
            candidate.insertPos + insertedText.length,
            suggestionType.create({ id: candidate.id, kind: 'insert', by: actor })
          );
          writeOffset += insertedText.length;

          metadata = {
            ...metadata,
            [candidate.id]: {
              ...existingMeta,
              kind: 'insert',
              by: actor,
              content: updatedContent,
              status: existingMeta?.status ?? 'pending',
              createdAt: existingMeta?.createdAt ?? new Date().toISOString(),
            },
          };
          metadataChanged = true;

          lastInsertByActor.set(actor, {
            id: candidate.id,
            from: candidate.range.from,
            to: candidate.range.to + insertedText.length,
            by: actor,
            updatedAt: now,
          });
          setSelectionAfterInsertedText(newTr, candidate.insertPos + insertedText.length);
        } else {
          const editableInsert = findEditableInsertSuggestionAtPosition(newTr.doc, safeFrom, actor);
          if (editableInsert) {
            console.log('[suggestions.insertDecision]', {
              case: 'editable-insert',
              insertedText,
              from: safeFrom,
              suggestionId: editableInsert.id,
              range: editableInsert.range,
              offset: editableInsert.offset,
            });
            const existingMeta = metadata[editableInsert.id];
            const liveContent = getLiveInsertSuggestionText(newTr.doc, editableInsert.id) ?? '';
            const insertOffset = Math.max(0, Math.min(editableInsert.offset, liveContent.length));
            const updatedContent = `${liveContent.slice(0, insertOffset)}${insertedText}${liveContent.slice(insertOffset)}`;

            newTr.insertText(insertedText, safeFrom);
            newTr.addMark(
              safeFrom,
              safeFrom + insertedText.length,
              suggestionType.create({ id: editableInsert.id, kind: 'insert', by: actor })
            );
            writeOffset += insertedText.length;

            metadata = {
              ...metadata,
              [editableInsert.id]: {
                ...existingMeta,
                kind: 'insert',
                by: actor,
                content: updatedContent,
                status: existingMeta?.status ?? 'pending',
                createdAt: existingMeta?.createdAt ?? new Date().toISOString(),
              },
            };
            metadataChanged = true;

            const updatedRange = resolveLiveInsertSuggestionRange(newTr.doc, editableInsert.id) ?? {
              from: editableInsert.range.from,
              to: editableInsert.range.to + insertedText.length,
            };
            lastInsertByActor.set(actor, {
              id: editableInsert.id,
              from: updatedRange.from,
              to: updatedRange.to,
              by: actor,
              updatedAt: now,
            });
            setSelectionAfterInsertedText(newTr, safeFrom + insertedText.length);
          } else if (whitespaceOnly) {
            // Standalone whitespace, no active candidate: create a tracked suggestion mark.
            console.log('[suggestions.insertDecision]', {
              case: 'new-whitespace-mark',
              insertedText,
              from: safeFrom,
              actor,
              cachedCandidate: null,
            });
            const suggestionId = generateMarkId();
            const createdAt = new Date().toISOString();

            newTr.insertText(insertedText, safeFrom);
            newTr.addMark(
              safeFrom,
              safeFrom + insertedText.length,
              suggestionType.create({ id: suggestionId, kind: 'insert', by: actor })
            );
            writeOffset += insertedText.length;

            metadata = {
              ...metadata,
              [suggestionId]: {
                ...buildSuggestionMetadata('insert', actor, insertedText, createdAt),
                ...buildCollapsedInsertAnchorMetadata(safeFrom),
              },
            };
            metadataChanged = true;

            lastInsertByActor.set(actor, {
              id: suggestionId,
              from: safeFrom,
              to: safeFrom + insertedText.length,
              by: actor,
              updatedAt: now,
            });
            setSelectionAfterInsertedText(newTr, safeFrom + insertedText.length);
          } else {
            // New non-whitespace text, no candidate: create fresh suggestion mark
            console.log('[suggestions.insertDecision]', {
              case: 'new-text-mark',
              insertedText,
              from: safeFrom,
              actor,
              cachedCandidate: null,
            });
            const suggestionId = generateMarkId();
            const createdAt = new Date().toISOString();

            newTr.insertText(insertedText, safeFrom);
            newTr.addMark(
              safeFrom,
              safeFrom + insertedText.length,
              suggestionType.create({ id: suggestionId, kind: 'insert', by: actor })
            );
            writeOffset += insertedText.length;

            metadata = {
              ...metadata,
              [suggestionId]: {
                ...buildSuggestionMetadata('insert', actor, insertedText, createdAt),
                ...buildCollapsedInsertAnchorMetadata(safeFrom),
              },
            };
            metadataChanged = true;

            lastInsertByActor.set(actor, {
              id: suggestionId,
              from: safeFrom,
              to: safeFrom + insertedText.length,
              by: actor,
              updatedAt: now,
            });
            setSelectionAfterInsertedText(newTr, safeFrom + insertedText.length);
          }
        }
      }
      // CASE 3: Replacement (deletion + insertion)
      else if (deletedText && insertedText) {
        lastInsertByActor.delete(actor);
        const existing = detectSuggestionKinds(newTr.doc, safeFrom, safeTo, suggestionType);

        if (existing.hasDelete) {
          // Accept deletion and re-insert as an insertion suggestion.
          newTr.delete(safeFrom, safeTo);
          writeOffset -= deletedText.length;

          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();
          newTr.insertText(insertedText, safeFrom);
          newTr.addMark(
            safeFrom,
            safeFrom + insertedText.length,
            suggestionType.create({ id: suggestionId, kind: 'insert', by: actor })
          );
          writeOffset += insertedText.length;

          metadata = {
            ...metadata,
            [suggestionId]: {
              ...buildSuggestionMetadata('insert', actor, insertedText, createdAt),
              ...buildCollapsedInsertAnchorMetadata(safeFrom),
            },
          };
          metadataChanged = true;
        } else if (existing.hasInsert) {
          // Replace inside a pending insertion - keep it as an insertion suggestion.
          const touchedInsertIds = collectSuggestionIdsInRange(newTr.doc, 'insert', safeFrom, safeTo);
          if (touchedInsertIds.length === 1) {
            const suggestionId = touchedInsertIds[0];
            const existingMeta = metadata[suggestionId];
            const insertBy = existingMeta?.by ?? actor;

            newTr.replaceWith(safeFrom, safeTo, state.schema.text(insertedText));
            newTr.addMark(
              safeFrom,
              safeFrom + insertedText.length,
              suggestionType.create({ id: suggestionId, kind: 'insert', by: insertBy })
            );
            writeOffset += insertedText.length - deletedText.length;

            const syncedMetadata = syncInsertSuggestionMetadataFromDoc(newTr.doc, metadata, touchedInsertIds);
            metadataChanged = metadataChanged || syncedMetadata !== metadata;
            metadata = syncedMetadata;
          } else {
            const suggestionId = generateMarkId();
            const createdAt = new Date().toISOString();

            newTr.replaceWith(safeFrom, safeTo, state.schema.text(insertedText));
            newTr.addMark(
              safeFrom,
              safeFrom + insertedText.length,
              suggestionType.create({ id: suggestionId, kind: 'insert', by: actor })
            );
            writeOffset += insertedText.length - deletedText.length;

            metadata = {
              ...metadata,
              [suggestionId]: {
                ...buildSuggestionMetadata('insert', actor, insertedText, createdAt),
                ...buildCollapsedInsertAnchorMetadata(safeFrom),
              },
            };
            metadataChanged = true;
          }
        } else {
          const deleteSuggestionId = generateMarkId();
          const insertSuggestionId = generateMarkId();
          const createdAt = new Date().toISOString();

          newTr.insertText(insertedText, safeFrom);
          newTr.addMark(
            safeFrom,
            safeFrom + insertedText.length,
            suggestionType.create({ id: insertSuggestionId, kind: 'insert', by: actor })
          );
          newTr.addMark(
            safeFrom + insertedText.length,
            safeTo + insertedText.length,
            suggestionType.create({
              id: deleteSuggestionId,
              kind: 'delete',
              by: actor,
            })
          );

          metadata = {
            ...metadata,
            [deleteSuggestionId]: buildSuggestionMetadata('delete', actor, null, createdAt),
            [insertSuggestionId]: {
              ...buildSuggestionMetadata('insert', actor, insertedText, createdAt),
              ...buildCollapsedInsertAnchorMetadata(safeFrom),
            },
          };
          metadataChanged = true;

          lastInsertByActor.set(actor, {
            id: insertSuggestionId,
            from: safeFrom,
            to: safeFrom + insertedText.length,
            by: actor,
            updatedAt: Date.now(),
          });

          newTr.setSelection(TextSelection.create(newTr.doc, safeFrom + insertedText.length));
        }
      }
      // CASE 4: Structural-only change (e.g., paragraph join/split with no text content).
      // Both deletedText and insertedText are empty — this isn't a text edit.
      // Pass through directly and adjust writeOffset for any doc size change.
      else {
        try {
          const sizeBefore = newTr.doc.content.size;
          newTr.step(step);
          writeOffset += newTr.doc.content.size - sizeBefore;
        } catch (e) {
          console.warn('[suggestions] Could not apply structural step:', e);
        }
      }
    } else if (stepJson.stepType === 'replaceAround' || stepJson.stepType === 'addMark' || stepJson.stepType === 'removeMark') {
      // Pass through structural and mark changes directly
      try {
        newTr.step(step);
      } catch (e) {
        console.warn('[suggestions] Could not apply step:', stepJson.stepType, e);
      }
    } else {
      // For other step types, try to apply them directly
      try {
        const result = step.apply(newTr.doc);
        if (result.doc && result.doc !== newTr.doc) {
          const sizeDiff = result.doc.content.size - newTr.doc.content.size;
          newTr.step(step);
          writeOffset += sizeDiff;
        }
      } catch (e) {
        console.warn('[suggestions] Could not apply step:', stepJson.stepType, e);
      }
    }
  }

  let finalTr = newTr;
  finalTr = stripAuthoredMarksFromPendingInsertRanges(finalTr, authoredType, metadata);
  if (metadataChanged) {
    finalTr = syncSuggestionMetadataTransaction(state, finalTr, metadata);
  }

  // Mark this transaction so authorship tracking skips it
  finalTr.setMeta('suggestions-wrapped', true);

  return finalTr;
}

/**
 * Check if suggestions are enabled
 */
export function isSuggestionsEnabled(state: EditorState): boolean {
  const pluginState = suggestionsPluginKey.getState(state);
  return pluginState?.enabled ?? false;
}

/**
 * Enable suggestions
 */
export function enableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {
  resetSuggestionsInsertCoalescing();
  const tr = view.state.tr.setMeta(suggestionsPluginKey, { enabled: true });
  view.dispatch(tr);
}

/**
 * Disable suggestions
 */
export function disableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {
  resetSuggestionsInsertCoalescing();
  const tr = view.state.tr.setMeta(suggestionsPluginKey, { enabled: false });
  view.dispatch(tr);
}

/**
 * Toggle suggestions
 */
export function toggleSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): boolean {
  const enabled = isSuggestionsEnabled(view.state);
  if (enabled) {
    disableSuggestions(view);
  } else {
    enableSuggestions(view);
  }
  return !enabled;
}

/**
 * Create the suggestions plugin
 */
export const suggestionsPlugin = $prose(() => {
  return new Plugin<SuggestionState>({
    key: suggestionsPluginKey,

    state: {
      init(): SuggestionState {
        return { enabled: false };
      },

      apply(tr, value): SuggestionState {
        const meta = tr.getMeta(suggestionsPluginKey);
        if (meta !== undefined) {
          return { ...value, ...meta };
        }
        return value;
      },
    },

    appendTransaction(trs, oldState, newState) {
      const wasEnabled = suggestionsPluginKey.getState(oldState)?.enabled ?? false;
      const isEnabled = suggestionsPluginKey.getState(newState)?.enabled ?? false;
      if (wasEnabled !== isEnabled) {
        // Emit bridge message on next microtask to avoid dispatch-in-dispatch
        queueMicrotask(() => {
          (window as any).proof?.bridge?.sendMessage('suggestionsChanged', { enabled: isEnabled });
        });
      }

      if (!isEnabled || !trs.some((tr) => tr.docChanged)) return null;
      const hasWrappedSuggestionTransaction = trs.some((tr) => tr.getMeta('suggestions-wrapped'));
      const hasBlockingMarksMeta = trs.some((tr) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta === undefined) return false;
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return true;
        const metaType = (meta as { type?: unknown }).type;
        if (metaType === 'INTERNAL') return false;
        if (metaType === 'SET_METADATA' && tr.getMeta('suggestions-wrapped')) return false;
        return true;
      });
      const hasRemoteSuggestionInsert = trs.some((tr) =>
        !isExplicitYjsChangeOriginTransaction(tr)
        && transactionCarriesInsertedSuggestionMarks(tr)
      );
      if (trs.some((tr) =>
        tr.getMeta('document-load') !== undefined
        || tr.getMeta('history$') !== undefined
        || isExplicitYjsChangeOriginTransaction(tr)
      ) || hasBlockingMarksMeta || hasRemoteSuggestionInsert) {
        return null;
      }

      const persistenceFallbackTr = buildTextPreservingInsertPersistenceTransaction(oldState, newState);
      if (persistenceFallbackTr) {
        console.log('[suggestions.appendTransactionPersistenceFallback]', {
          from: persistenceFallbackTr.selection.from,
          to: persistenceFallbackTr.selection.to,
        });
        return persistenceFallbackTr;
      }

      const splitMergeTr = buildAdjacentSplitInsertMergeTransaction(oldState, newState);
      if (splitMergeTr) {
        console.log('[suggestions.appendTransactionSplitMerge]', {
          from: splitMergeTr.selection.from,
          to: splitMergeTr.selection.to,
        });
        return splitMergeTr;
      }

      if (hasWrappedSuggestionTransaction) {
        return null;
      }

      const fallbackTr = buildPlainInsertionSuggestionFallbackTransaction(oldState, newState);
      if (fallbackTr) {
        console.log('[suggestions.appendTransactionFallback]', {
          from: fallbackTr.selection.from,
          to: fallbackTr.selection.to,
        });
        return fallbackTr;
      }
      return null;
    },

    props: {
      handleDOMEvents: {
        beforeinput(view, event) {
          if (!isSuggestionsEnabled(view.state)) return false;
          if (view.composing) return false;
          const inputEvent = event as InputEvent;
          const pendingIntent = takePendingModifiedDeleteIntent(view);
          const intent = __debugResolveTrackedDeleteIntentForBeforeInput(
            inputEvent.inputType ?? '',
            pendingIntent?.intent ?? null,
          );
          if (!intent) return false;
          if (pendingIntent?.handled) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
          if (shouldSuppressTrackChangesDeleteIntent(intent)) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }

          const range = __debugResolveTrackedDeleteRange(view.state, intent.key, intent.modifiers);
          if (!range || range.to <= range.from) return false;

          event.preventDefault();
          view.dispatch(view.state.tr.delete(range.from, range.to));
          return true;
        },
      },

      handleTextInput(view, from, to, text) {
        const enabled = isSuggestionsEnabled(view.state);
        console.log('[suggestions.handleTextInput]', {
          enabled,
          from,
          to,
          text,
          trackChangesView: view.dom?.dataset?.trackChangesView ?? null,
        });
        if (!enabled) return false;
        if (!text) return false;
        // Let composition-driven text updates use the same tracked-insert path
        // as ordinary typing. If we opt out here, ProseMirror's DOM observer
        // emits intermediate composition transactions that get tracked as
        // separate char-level edits in shared docs.
        const range = resolveTrackedTextInputRange(view.state, from, to);
        view.dispatch(view.state.tr.insertText(text, range.from, range.to));
        return true;
      },

      handleKeyDown(view, event) {
        if (!isSuggestionsEnabled(view.state)) return false;
        if (event.defaultPrevented || event.isComposing || view.composing) return false;
        if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
        if (shouldSuppressTrackChangesKeydown(event)) {
          rememberModifiedDeleteIntent(view, event, { handled: true });
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
        if (event.altKey || event.ctrlKey) {
          const range = __debugResolveTrackedDeleteRange(view.state, event.key, {
            altKey: event.altKey,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
          });
          if (!range || range.to <= range.from) return false;

          rememberModifiedDeleteIntent(view, event, { handled: true });
          event.preventDefault();
          event.stopPropagation();
          view.dispatch(view.state.tr.delete(range.from, range.to));
          return true;
        }
        if (event.metaKey) return false;

        const range = __debugResolveTrackedDeleteRange(view.state, event.key, {
          altKey: event.altKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
        });
        if (!range || range.to <= range.from) return false;

        event.preventDefault();
        view.dispatch(view.state.tr.delete(range.from, range.to));
        return true;
      },
    },
  });
});

/**
 * Export all for use in editor
 */
export const suggestionsPlugins = [suggestionsCtx, suggestionsPlugin];
