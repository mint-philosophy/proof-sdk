/**
 * Suggestions Plugin for Milkdown
 *
 * Converts edits into proofSuggestion marks + PROOF metadata
 * when suggestions mode is enabled.
 */

import { $ctx, $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { Mark, MarkType, Node as ProseMirrorNode, Slice as ProseMirrorSlice } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { undo } from 'prosemirror-history';

import {
  marksPluginKey,
  getMarkMetadata,
  getMarks,
  buildSuggestionMetadata,
  syncSuggestionMetadataTransaction,
  reject as rejectSuggestionMark,
} from './marks';
import {
  collectSuggestionSegments,
  getSuggestionClusterRangeFromSegments,
  getSuggestionTextFromSegments,
  getSuggestionTextOffsetAtPosition,
  syncInsertSuggestionMetadataFromDoc,
} from './suggestion-boundaries';
import { shouldSuppressTrackChangesDeleteIntent, shouldSuppressTrackChangesKeydown } from './track-changes-delete-guard.js';
import { getYjsTransactionOriginInfo, isExplicitYjsChangeOriginTransaction } from './transaction-origins';
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

type SuggestionIdSummary = {
  insertIds: string[];
  deleteIds: string[];
  replaceIds: string[];
};

type DisabledSuggestionStripAnalysis = {
  oldSummary: SuggestionIdSummary;
  newSummary: SuggestionIdSummary;
  introducedSummary: SuggestionIdSummary;
  shouldStrip: boolean;
};

type TextSegmentRange = MarkRange & {
  text: string;
};

// Word-style track changes should keep a contiguous typing run together even when
// the user pauses briefly between keystrokes. A slightly longer window also makes
// browser automation reflect real authoring behavior instead of splitting every key.
const COALESCE_WINDOW_MS = 5000;
const DEBUG_VERBOSE_INSERT_REPAIR = false;
const HANDLED_TEXT_INPUT_ECHO_TTL_MS = 250;
const DUPLICATE_HANDLED_TEXT_INPUT_CALL_TTL_MS = 75;
const PENDING_NATIVE_TEXT_INPUT_TTL_MS = 250;
const HANDLED_TEXT_INPUT_META = 'proof-handled-text-input';
const NATIVE_TEXT_INPUT_MATCH_META = 'proof-native-typed-input-match';

type InsertCoalesceState = { id: string; from: number; to: number; by: string; updatedAt: number };
type TrackedDeleteIntent = { key: 'Backspace' | 'Delete'; modifiers?: { altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } };
type PendingTrackedDeleteIntent = { intent: TrackedDeleteIntent; at: number; handled: boolean };
type PendingHandledTextInputEcho = {
  text: string;
  originalFrom: number;
  originalTo: number;
  expectedFrom: number;
  expectedTo: number;
  at: number;
};
type RecentHandledTextInputCall = {
  text: string;
  from: number;
  to: number;
  at: number;
};
type PendingNativeTextInput = {
  text: string;
  from: number;
  to: number;
  at: number;
};

export type NativeTextInputMatch = {
  text: string;
  from: number;
  to: number;
};

const lastInsertByActor = new Map<string, InsertCoalesceState>();
const pendingModifiedDeleteIntents = new WeakMap<EditorView, PendingTrackedDeleteIntent>();
const PENDING_DELETE_INTENT_TTL_MS = 1500;
let pendingHandledTextInputEcho: PendingHandledTextInputEcho | null = null;
let recentHandledTextInputCall: RecentHandledTextInputCall | null = null;
let pendingNativeTextInput: PendingNativeTextInput | null = null;

function logVerboseInsertRepair(...args: unknown[]): void {
  if (!DEBUG_VERBOSE_INSERT_REPAIR) return;
  console.log(...args);
}

/**
 * Module-level enabled flag — independent of ProseMirror plugin state.
 * This provides a reliable fallback when plugin state reads return stale data
 * (e.g. due to dispatch interceptor timing issues with the DOM observer).
 * Updated synchronously by enableSuggestions/disableSuggestions.
 */
let suggestionsModuleEnabled = false;
let suggestionsDesiredEnabled = false;

/** Check the module-level enabled flag (independent of plugin state). */
export function isSuggestionsModuleEnabled(): boolean {
  return suggestionsModuleEnabled;
}

/** Check the desired TC state latched by the editor runtime. */
export function isSuggestionsDesiredEnabled(): boolean {
  return suggestionsDesiredEnabled;
}

/** Mirror the editor's intended TC mode into plugin-level guards. */
export function setSuggestionsDesiredEnabled(enabled: boolean): void {
  suggestionsDesiredEnabled = enabled;
}

export function resetSuggestionsInsertCoalescing(): void {
  lastInsertByActor.clear();
  pendingHandledTextInputEcho = null;
  recentHandledTextInputCall = null;
  pendingNativeTextInput = null;
}

/** Reset all module-level TC state for fresh document loads.
 *  Prevents stale suggestionsModuleEnabled from a previous document
 *  leaking into a new one during SPA navigation. */
export function resetSuggestionsModuleState(): void {
  suggestionsModuleEnabled = false;
  lastInsertByActor.clear();
  pendingHandledTextInputEcho = null;
  recentHandledTextInputCall = null;
  pendingNativeTextInput = null;
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

function materializeInsertSuggestionAsSingleTextNode(
  tr: Transaction,
  id: string,
  by: string,
  suggestionType: MarkType,
  authoredType: MarkType | null,
): { tr: Transaction; range: MarkRange | null } {
  const range = resolveLiveInsertSuggestionRange(tr.doc, id);
  if (!range || range.to <= range.from) {
    return { tr, range: null };
  }

  const text = getLiveInsertSuggestionText(tr.doc, id);
  if (typeof text !== 'string' || text.length === 0) {
    return { tr, range };
  }

  let nextTr = tr;
  if (authoredType) {
    nextTr = nextTr.removeMark(range.from, range.to, authoredType);
  }
  nextTr = nextTr.replaceWith(
    range.from,
    range.to,
    nextTr.doc.type.schema.text(
      text,
      [suggestionType.create({ id, kind: 'insert', by })],
    ),
  );
  return {
    tr: nextTr,
    range: {
      from: range.from,
      to: range.from + text.length,
    },
  };
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

function collectActualSuggestionIdsInDoc(doc: ProseMirrorNode): Set<string> {
  const ids = new Set<string>();

  doc.descendants((node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== 'proofSuggestion') continue;
      const id = typeof mark.attrs.id === 'string' ? mark.attrs.id : '';
      if (id) ids.add(id);
    }
    return true;
  });

  return ids;
}

type HistoryTransactionMeta = {
  redo?: boolean;
};

export function isUndoHistoryTransaction(tr: Transaction): boolean {
  const historyMeta = tr.getMeta('history$') as HistoryTransactionMeta | undefined;
  return Boolean(historyMeta && historyMeta.redo === false);
}

export function buildHistorySuggestionMetadataReconciliationTransaction(
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  const pluginState = marksPluginKey.getState(newState) as { metadata?: Record<string, StoredMark> } | undefined;
  const currentMetadata = pluginState?.metadata ?? {};
  const oldPluginState = marksPluginKey.getState(oldState) as { metadata?: Record<string, StoredMark> } | undefined;
  const oldMetadata = oldPluginState?.metadata ?? {};
  if (Object.keys(oldMetadata).length === 0 && Object.keys(currentMetadata).length === 0) return null;

  const oldIds = collectActualSuggestionIdsInDoc(oldState.doc);
  if (oldIds.size === 0) return null;
  const newIds = collectActualSuggestionIdsInDoc(newState.doc);
  const removedIds = [...oldIds].filter((id) => !newIds.has(id) && oldMetadata[id]);
  const overwriteDeleteIds = collectOverwriteDeleteIdsForHistoryUndo(
    oldState,
    newState,
    oldMetadata,
    currentMetadata,
    removedIds,
    newIds,
  );
  const overwriteInsertIds = collectOverwriteInsertIdsForHistoryUndo(
    oldState,
    newState,
    oldMetadata,
    currentMetadata,
    removedIds,
    newIds,
  );
  const baseReconciledIds = [...new Set([...removedIds, ...overwriteDeleteIds, ...overwriteInsertIds])];
  if (baseReconciledIds.length === 0) return null;

  let tr = newState.tr;
  const suggestionType = newState.schema.marks.proofSuggestion;
  if (overwriteDeleteIds.length > 0) {
    if (suggestionType) {
      for (const deleteId of overwriteDeleteIds) {
        const deleteRange = resolveLiveDeleteSuggestionRange(newState.doc, deleteId);
        if (!deleteRange || deleteRange.to <= deleteRange.from) continue;
        tr = removeSuggestionIdsFromRange(
          tr,
          newState.doc,
          deleteRange.from,
          deleteRange.to,
          suggestionType,
          [deleteId],
        );
      }
    }
  }
  if (overwriteInsertIds.length > 0) {
    const insertRangesToRemove = overwriteInsertIds
      .map((insertId) => {
        const insertRange = resolveLiveInsertSuggestionRange(newState.doc, insertId);
        if (!insertRange || insertRange.to <= insertRange.from) return null;
        return { insertId, insertRange };
      })
      .filter((entry): entry is { insertId: string; insertRange: MarkRange } => Boolean(entry))
      .sort((a, b) => b.insertRange.from - a.insertRange.from);

    for (const { insertRange } of insertRangesToRemove) {
      tr = tr.delete(insertRange.from, insertRange.to);
    }
  }

  const mismatchedInsertIds = collectMismatchedInsertSuggestionIdsAfterHistoryReconciliation(
    oldState,
    tr.doc,
    oldMetadata,
  );
  if (mismatchedInsertIds.length > 0 && suggestionType) {
    tr = removeSuggestionIdsFromRange(
      tr,
      tr.doc,
      0,
      tr.doc.content.size,
      suggestionType,
      mismatchedInsertIds,
    );
  }

  const reconciledIds = [...new Set([...baseReconciledIds, ...mismatchedInsertIds])];
  const nextMetadata: Record<string, StoredMark> = { ...currentMetadata };
  for (const id of reconciledIds) {
    delete nextMetadata[id];
  }

  tr = syncSuggestionMetadataTransaction(newState, tr, nextMetadata)
    .setMeta('addToHistory', false);
  tr.setMeta('suggestions-wrapped', true);
  console.log('[suggestions.appendTransaction.historyMetadataReconcile]', {
    removedIds,
    overwriteDeleteIds,
    overwriteInsertIds,
    mismatchedInsertIds,
    reconciledIds,
    oldAnchoredIds: [...oldIds].sort(),
    newAnchoredIds: [...newIds].sort(),
  });
  return tr;
}

function collectMismatchedInsertSuggestionIdsAfterHistoryReconciliation(
  oldState: EditorState,
  reconciledDoc: ProseMirrorNode,
  oldMetadata: Record<string, StoredMark>,
): string[] {
  const oldInsertIds = new Set(
    collectSuggestionIdsInRange(oldState.doc, 'insert', 0, oldState.doc.content.size),
  );
  if (oldInsertIds.size === 0) return [];

  const mismatchedIds = new Set<string>();
  const liveInsertIds = collectSuggestionIdsInRange(
    reconciledDoc,
    'insert',
    0,
    reconciledDoc.content.size,
  );

  for (const insertId of liveInsertIds) {
    if (!oldInsertIds.has(insertId)) continue;

    const oldLiveText = getLiveInsertSuggestionText(oldState.doc, insertId);
    if (typeof oldLiveText !== 'string' || oldLiveText.length === 0) continue;

    const oldEntry = oldMetadata[insertId];
    const expectedText = oldEntry?.kind === 'insert'
      && typeof oldEntry.content === 'string'
      && oldEntry.content.length > 0
      ? oldEntry.content
      : oldLiveText;
    if (oldLiveText !== expectedText) continue;

    const liveText = getLiveInsertSuggestionText(reconciledDoc, insertId);
    if (typeof liveText !== 'string' || liveText.length === 0) continue;
    if (liveText !== expectedText) {
      mismatchedIds.add(insertId);
    }
  }

  return [...mismatchedIds];
}

function collectOverwriteDeleteIdsForHistoryUndo(
  oldState: EditorState,
  newState: EditorState,
  oldMetadata: Record<string, StoredMark>,
  currentMetadata: Record<string, StoredMark>,
  removedIds: string[],
  newIds: Set<string>,
): string[] {
  if (removedIds.length === 0) return [];

  const pairedDeleteIds = new Set<string>();

  for (const insertId of removedIds) {
    const insertMeta = oldMetadata[insertId] ?? currentMetadata[insertId];
    if (!insertMeta || insertMeta.kind !== 'insert') continue;
    if (insertMeta.status === 'accepted' || insertMeta.status === 'rejected') continue;

    const insertRange = resolveLiveInsertSuggestionRange(oldState.doc, insertId);
    if (!insertRange || insertRange.to <= insertRange.from) continue;

    const adjacentDeleteIds = collectSuggestionIdsInRange(
      oldState.doc,
      'delete',
      Math.max(0, insertRange.from - 1),
      insertRange.from,
    );
    if (adjacentDeleteIds.length === 0) continue;

    const insertCreatedAt = parseStoredMarkTimestamp(insertMeta.createdAt);
    const insertBy = typeof insertMeta.by === 'string' ? insertMeta.by : null;

    for (const deleteId of adjacentDeleteIds) {
      if (pairedDeleteIds.has(deleteId)) continue;
      if (!newIds.has(deleteId)) continue;

      const deleteMeta = currentMetadata[deleteId] ?? oldMetadata[deleteId];
      if (!deleteMeta || deleteMeta.kind !== 'delete') continue;
      if (deleteMeta.status === 'accepted' || deleteMeta.status === 'rejected') continue;

      const deleteRange = resolveLiveDeleteSuggestionRange(oldState.doc, deleteId);
      if (!deleteRange || deleteRange.to !== insertRange.from) continue;

      const deleteBy = typeof deleteMeta.by === 'string' ? deleteMeta.by : null;
      if (insertBy && deleteBy && insertBy !== deleteBy) continue;

      const deleteCreatedAt = parseStoredMarkTimestamp(deleteMeta.createdAt);
      if (
        insertCreatedAt !== null
        && deleteCreatedAt !== null
        && Math.abs(insertCreatedAt - deleteCreatedAt) > COALESCE_WINDOW_MS
      ) {
        continue;
      }

      const expectedDeletedText = typeof deleteMeta.quote === 'string' && deleteMeta.quote.length > 0
        ? deleteMeta.quote
        : oldState.doc.textBetween(deleteRange.from, deleteRange.to, '\n', '\n');
      const restoredText = newState.doc.textBetween(deleteRange.from, deleteRange.to, '\n', '\n');
      if (expectedDeletedText.length > 0 && restoredText !== expectedDeletedText) continue;

      pairedDeleteIds.add(deleteId);
    }
  }

  return [...pairedDeleteIds];
}

function collectOverwriteInsertIdsForHistoryUndo(
  oldState: EditorState,
  newState: EditorState,
  oldMetadata: Record<string, StoredMark>,
  currentMetadata: Record<string, StoredMark>,
  removedIds: string[],
  newIds: Set<string>,
): string[] {
  if (removedIds.length === 0) return [];

  const pairedInsertIds = new Set<string>();

  for (const deleteId of removedIds) {
    const deleteMeta = oldMetadata[deleteId] ?? currentMetadata[deleteId];
    if (!deleteMeta || deleteMeta.kind !== 'delete') continue;
    if (deleteMeta.status === 'accepted' || deleteMeta.status === 'rejected') continue;

    const deleteRange = resolveLiveDeleteSuggestionRange(oldState.doc, deleteId);
    if (!deleteRange || deleteRange.to <= deleteRange.from) continue;

    const adjacentInsertIds = collectSuggestionIdsInRange(
      oldState.doc,
      'insert',
      deleteRange.to,
      Math.min(oldState.doc.content.size, deleteRange.to + 1),
    );
    if (adjacentInsertIds.length === 0) continue;

    const deleteCreatedAt = parseStoredMarkTimestamp(deleteMeta.createdAt);
    const deleteBy = typeof deleteMeta.by === 'string' ? deleteMeta.by : null;
    const expectedDeletedText = typeof deleteMeta.quote === 'string' && deleteMeta.quote.length > 0
      ? deleteMeta.quote
      : oldState.doc.textBetween(deleteRange.from, deleteRange.to, '\n', '\n');
    const restoredText = newState.doc.textBetween(deleteRange.from, deleteRange.to, '\n', '\n');
    if (expectedDeletedText.length > 0 && restoredText !== expectedDeletedText) continue;

    for (const insertId of adjacentInsertIds) {
      if (pairedInsertIds.has(insertId)) continue;
      if (!newIds.has(insertId)) continue;

      const insertMeta = currentMetadata[insertId] ?? oldMetadata[insertId];
      if (!insertMeta || insertMeta.kind !== 'insert') continue;
      if (insertMeta.status === 'accepted' || insertMeta.status === 'rejected') continue;
      if (typeof insertMeta.content !== 'string' || insertMeta.content.length === 0) continue;

      const insertRange = resolveLiveInsertSuggestionRange(oldState.doc, insertId);
      if (!insertRange || insertRange.from !== deleteRange.to || insertRange.to <= insertRange.from) continue;

      const insertBy = typeof insertMeta.by === 'string' ? insertMeta.by : null;
      if (insertBy && deleteBy && insertBy !== deleteBy) continue;

      const insertCreatedAt = parseStoredMarkTimestamp(insertMeta.createdAt);
      if (
        insertCreatedAt !== null
        && deleteCreatedAt !== null
        && Math.abs(insertCreatedAt - deleteCreatedAt) > COALESCE_WINDOW_MS
      ) {
        continue;
      }

      pairedInsertIds.add(insertId);
    }
  }

  return [...pairedInsertIds];
}

export function __buildHistorySuggestionMetadataReconciliationTransactionForTests(
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  return buildHistorySuggestionMetadataReconciliationTransaction(oldState, newState);
}

type PendingSuggestionUndoCandidate = {
  id: string;
  createdAt: string;
  createdAtMs: number;
  from: number;
  to: number;
};

function isPendingTrackedSuggestionForUndo(mark: Mark, metadata: StoredMark | undefined): boolean {
  if (mark.kind !== 'insert' && mark.kind !== 'delete' && mark.kind !== 'replace') return false;
  const metadataStatus = typeof metadata?.status === 'string' ? metadata.status : null;
  const dataStatus = typeof (mark.data as { status?: unknown } | undefined)?.status === 'string'
    ? (mark.data as { status: string }).status
    : null;
  const status = metadataStatus ?? dataStatus ?? 'pending';
  return status === 'pending';
}

function resolveLatestPendingSuggestionUndoMarkIds(
  state: EditorState,
  actor: string | null = getCurrentActor(),
): string[] {
  const metadata = getMarkMetadata(state);
  const groups = new Map<string, PendingSuggestionUndoCandidate[]>();

  for (const mark of getMarks(state)) {
    const stored = metadata[mark.id];
    if (!isPendingTrackedSuggestionForUndo(mark, stored)) continue;

    const by = typeof stored?.by === 'string' && stored.by.trim().length > 0 ? stored.by : mark.by;
    if (actor && by !== actor) continue;

    const range = mark.range;
    if (!range || range.to < range.from) continue;

    const createdAt = typeof stored?.createdAt === 'string' && stored.createdAt.trim().length > 0
      ? stored.createdAt
      : mark.at;
    const key = createdAt.trim().length > 0 ? createdAt : `fallback:${mark.id}`;
    const createdAtMs = Date.parse(key);
    const bucket = groups.get(key) ?? [];
    bucket.push({
      id: mark.id,
      createdAt: key,
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
      from: range.from,
      to: range.to,
    });
    groups.set(key, bucket);
  }

  const latestGroup = [...groups.values()]
    .sort((left, right) => {
      const leftTime = Math.max(...left.map((candidate) => candidate.createdAtMs));
      const rightTime = Math.max(...right.map((candidate) => candidate.createdAtMs));
      if (leftTime !== rightTime) return rightTime - leftTime;

      const leftPos = Math.max(...left.map((candidate) => candidate.from));
      const rightPos = Math.max(...right.map((candidate) => candidate.from));
      if (leftPos !== rightPos) return rightPos - leftPos;

      const leftKey = left[0]?.createdAt ?? '';
      const rightKey = right[0]?.createdAt ?? '';
      return rightKey.localeCompare(leftKey);
    })[0];

  if (!latestGroup) return [];

  return [...latestGroup]
    .sort((left, right) => {
      if (left.from !== right.from) return right.from - left.from;
      if (left.to !== right.to) return right.to - left.to;
      return left.id.localeCompare(right.id);
    })
    .map((candidate) => candidate.id);
}

function resolveLatestPendingSuggestionUndoFallbackMarkIds(
  state: EditorState,
  actor: string | null = getCurrentActor(),
): string[] {
  const actorScopedIds = resolveLatestPendingSuggestionUndoMarkIds(state, actor);
  if (actorScopedIds.length > 0) return actorScopedIds;
  if (actor === null) return actorScopedIds;
  return resolveLatestPendingSuggestionUndoMarkIds(state, null);
}

function rejectSuggestionGroupWithoutHistory(view: EditorView, markIds: readonly string[]): boolean {
  let handled = false;
  for (const markId of markIds) {
    if (rejectSuggestionMark(view, markId, { addToHistory: false })) {
      handled = true;
    }
  }
  return handled;
}

function undoLatestPendingSuggestionEdit(
  view: EditorView,
  actor: string | null = getCurrentActor(),
): boolean {
  const markIds = resolveLatestPendingSuggestionUndoFallbackMarkIds(view.state, actor);
  if (markIds.length === 0) return false;
  return rejectSuggestionGroupWithoutHistory(view, markIds);
}

function storedMarkMetadataEqual(
  left: Record<string, StoredMark>,
  right: Record<string, StoredMark>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  for (const key of leftKeys) {
    if (!(key in right)) return false;
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) return false;
  }

  return true;
}

function didTrackChangesUndoChangeState(
  oldState: EditorState,
  newState: EditorState,
): boolean {
  if (!oldState.doc.eq(newState.doc)) return true;
  return !storedMarkMetadataEqual(
    getMarkMetadata(oldState),
    getMarkMetadata(newState),
  );
}

function attemptTrackChangesUndo(view: EditorView, source: 'beforeinput' | 'keydown'): boolean {
  const initialState = view.state;
  let historyDispatched = false;

  const historyHandled = undo(initialState, (tr) => {
    historyDispatched = true;
    view.dispatch(tr);
  });

  const historyChangedState = didTrackChangesUndoChangeState(initialState, view.state);
  if (historyHandled && historyChangedState) {
    console.log('[suggestions.undo.dispatch]', {
      source,
      path: 'history',
      historyDispatched,
    });
    return true;
  }

  const markIds = resolveLatestPendingSuggestionUndoFallbackMarkIds(view.state);
  const fallbackHandled = markIds.length > 0
    ? rejectSuggestionGroupWithoutHistory(view, markIds)
    : false;
  if (fallbackHandled) {
    console.log('[suggestions.undo.dispatch]', {
      source,
      path: historyHandled
        ? 'history-noop-fallback-reject-suggestion-group'
        : 'fallback-reject-suggestion-group',
      historyDispatched,
      markIds,
    });
    return true;
  }

  if (historyHandled) {
    console.log('[suggestions.undo.dispatch]', {
      source,
      path: 'history-noop-consumed',
      historyDispatched,
      markIds,
    });
    return true;
  }

  return false;
}

export function __debugResolveLatestPendingSuggestionUndoMarkIds(
  state: EditorState,
  actor: string | null = getCurrentActor(),
): string[] {
  return resolveLatestPendingSuggestionUndoMarkIds(state, actor);
}

export function __debugResolveLatestPendingSuggestionUndoFallbackMarkIds(
  state: EditorState,
  actor: string | null = getCurrentActor(),
): string[] {
  return resolveLatestPendingSuggestionUndoFallbackMarkIds(state, actor);
}

export function __debugUndoLatestPendingSuggestionEdit(
  view: EditorView,
  actor: string | null = getCurrentActor(),
): boolean {
  return undoLatestPendingSuggestionEdit(view, actor);
}

function summarizeTextMarksInRange(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): Array<{ from: number; to: number; text: string; marks: Array<{ type: string; attrs: Record<string, unknown> }> }> {
  const summary: Array<{ from: number; to: number; text: string; marks: Array<{ type: string; attrs: Record<string, unknown> }> }> = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const nodeFrom = Math.max(from, pos);
    const nodeTo = Math.min(to, pos + node.nodeSize);
    if (nodeTo <= nodeFrom) return true;
    const sliceFrom = nodeFrom - pos;
    const sliceTo = nodeTo - pos;
    summary.push({
      from: nodeFrom,
      to: nodeTo,
      text: (node.text ?? '').slice(sliceFrom, sliceTo),
      marks: node.marks.map((mark) => ({
        type: mark.type.name,
        attrs: { ...(mark.attrs as Record<string, unknown>) },
      })),
    });
    return true;
  });
  return summary;
}

function collectSuggestionIdSummaryInRange(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): SuggestionIdSummary {
  return {
    insertIds: collectSuggestionIdsInRange(doc, 'insert', from, to).sort(),
    deleteIds: collectSuggestionIdsInRange(doc, 'delete', from, to).sort(),
    replaceIds: collectSuggestionIdsInRange(doc, 'replace', from, to).sort(),
  };
}

function collectIntroducedSuggestionIds(nextIds: string[], previousIds: string[]): string[] {
  const previous = new Set(previousIds);
  return nextIds.filter((id) => !previous.has(id)).sort();
}

function analyzeDisabledSuggestionStripDecision(
  oldDoc: ProseMirrorNode,
  newDoc: ProseMirrorNode,
  oldRange: MarkRange,
  newRange: MarkRange,
): DisabledSuggestionStripAnalysis {
  const oldSummary = collectSuggestionIdSummaryInRange(oldDoc, oldRange.from, oldRange.to);
  const newSummary = collectSuggestionIdSummaryInRange(newDoc, newRange.from, newRange.to);
  const introducedSummary = {
    insertIds: collectIntroducedSuggestionIds(newSummary.insertIds, oldSummary.insertIds),
    deleteIds: collectIntroducedSuggestionIds(newSummary.deleteIds, oldSummary.deleteIds),
    replaceIds: collectIntroducedSuggestionIds(newSummary.replaceIds, oldSummary.replaceIds),
  };
  const shouldStrip = introducedSummary.insertIds.length > 0
    || introducedSummary.deleteIds.length > 0
    || introducedSummary.replaceIds.length > 0;
  return {
    oldSummary,
    newSummary,
    introducedSummary,
    shouldStrip,
  };
}

function removeSuggestionIdsFromRange(
  tr: Transaction,
  doc: ProseMirrorNode,
  from: number,
  to: number,
  suggestionType: MarkType,
  suggestionIds: string[],
): Transaction {
  if (suggestionIds.length === 0) return tr;
  const targetIds = new Set(suggestionIds);
  let nextTr = tr;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const nodeStart = pos;
    const nodeEnd = pos + node.nodeSize;
    for (const mark of node.marks) {
      if (mark.type !== suggestionType) continue;
      const id = typeof mark.attrs.id === 'string' ? mark.attrs.id : '';
      if (!id || !targetIds.has(id)) continue;
      nextTr = nextTr.removeMark(nodeStart, nodeEnd, mark);
    }
    return true;
  });
  return nextTr;
}

function buildDisabledInsertedSuggestionCleanupTransaction(
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  const diff = detectPlainTextInsertionDiff(oldState, newState);
  if (!diff) return null;

  const suggestionType = newState.schema.marks.proofSuggestion;
  if (!suggestionType) return null;

  let leakedSuggestionMarks = false;
  newState.doc.nodesBetween(diff.from, diff.to, (node) => {
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type === suggestionType)) {
      leakedSuggestionMarks = true;
      return false;
    }
    return true;
  });

  const currentStored = newState.storedMarks ?? newState.selection.$from.marks();
  const leakedStoredMarks = currentStored.some((mark) => mark.type === suggestionType);
  if (!leakedSuggestionMarks && !leakedStoredMarks) return null;

  let tr = newState.tr;
  if (leakedSuggestionMarks) {
    tr = tr.removeMark(diff.from, diff.to, suggestionType);
  }
  if (leakedStoredMarks) {
    tr = tr.setStoredMarks(currentStored.filter((mark) => mark.type !== suggestionType));
  }
  tr.setMeta('suggestions-wrapped', true);
  return tr;
}

export function __debugBuildDisabledInsertedSuggestionCleanupTransaction(
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  return buildDisabledInsertedSuggestionCleanupTransaction(oldState, newState);
}

function summarizeAppendTransactionsForDebug(trs: readonly Transaction[]): Array<Record<string, unknown>> {
  return trs.map((tr, index) => {
    const suggestionsMeta = tr.getMeta(suggestionsPluginKey) as { enabled?: unknown } | undefined;
    const marksMeta = tr.getMeta(marksPluginKey) as { type?: unknown } | undefined;
    return {
      index,
      docChanged: tr.docChanged,
      history: tr.getMeta('history$') !== undefined,
      documentLoad: tr.getMeta('document-load') !== undefined,
      wrapped: tr.getMeta('suggestions-wrapped') === true,
      suggestionMetaEnabled: typeof suggestionsMeta?.enabled === 'boolean' ? suggestionsMeta.enabled : null,
      marksMetaType: typeof marksMeta?.type === 'string' ? marksMeta.type : null,
      yjsOrigin: getYjsTransactionOriginInfo(tr),
    };
  });
}

export function __debugAnalyzeDisabledSuggestionStripDecision(
  oldDoc: ProseMirrorNode,
  newDoc: ProseMirrorNode,
  oldRange: MarkRange,
  newRange: MarkRange,
): DisabledSuggestionStripAnalysis {
  return analyzeDisabledSuggestionStripDecision(oldDoc, newDoc, oldRange, newRange);
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

  // Skip past delete marks at cursor position so new text appears after
  // the deletion rather than being trapped before it.
  if (from === to) {
    const skipTo = resolveLeadingDeleteSuggestionRunEnd(state.doc, from);
    if (skipTo !== from) {
      return { from: skipTo, to: skipTo };
    }
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

function resolveLeadingDeleteSuggestionRunEnd(
  doc: ProseMirrorNode,
  pos: number,
): number {
  let cursor = Math.max(0, Math.min(pos, doc.content.size));
  let hops = 0;

  while (cursor < doc.content.size && hops < 1000) {
    hops += 1;
    const $pos = doc.resolve(cursor);
    const nodeAfter = $pos.nodeAfter;
    if (!nodeAfter?.isText) break;

    const deleteMark = nodeAfter.marks.find((mark) =>
      mark.type.name === 'proofSuggestion'
      && normalizeSuggestionKind(mark.attrs.kind) === 'delete'
    );
    if (!deleteMark || typeof deleteMark.attrs.id !== 'string') break;

    const deleteRange = resolveLiveDeleteSuggestionRange(doc, deleteMark.attrs.id);
    if (!deleteRange || deleteRange.from !== cursor || deleteRange.to <= cursor) break;
    cursor = deleteRange.to;
  }

  return cursor;
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
      // Tolerate a gap of non-suggestion text between the delete mark end
      // and the cursor. Yjs collaborative sync can move the DOM cursor past
      // authored characters adjacent to the delete boundary. In multi-mark
      // documents the cursor can jump much further (past entire paragraphs
      // of authored text), so the limit must be generous. The no-suggestion
      // check below is the real safety condition — it prevents bridging
      // across other tracked edits.
      const MAX_GAP = 200;
      if (
        deleteRange.from === insertRange.to
        && deleteRange.to < pos
        && pos - deleteRange.to <= MAX_GAP
      ) {
        const gapText = doc.textBetween(deleteRange.to, pos, '');
        let gapHasSuggestion = false;
        doc.nodesBetween(deleteRange.to, pos, (gapNode) => {
          if (!gapNode.isText) return true;
          for (const gapMark of gapNode.marks) {
            if (gapMark.type.name === 'proofSuggestion') {
              gapHasSuggestion = true;
            }
          }
          return true;
        });
        if (!gapHasSuggestion && gapText.length > 0) {
          console.log('[suggestions.trailingDeleteGapBridge]', {
            deleteRange,
            insertRange,
            pos,
            gapText,
          });
          matchingDeleteRange = deleteRange;
          return false;
        }
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
  if (!cached) {
    logVerboseInsertRepair('[coalesce.debug] no cached entry for actor', by);
    return null;
  }
  const elapsed = now - cached.updatedAt;
  if (elapsed > COALESCE_WINDOW_MS) {
    logVerboseInsertRepair('[coalesce.debug] expired', { elapsed, COALESCE_WINDOW_MS, cachedId: cached.id });
    lastInsertByActor.delete(by);
    return null;
  }

  const stored = metadata[cached.id];
  if (stored?.kind && stored.kind !== 'insert') {
    logVerboseInsertRepair('[coalesce.debug] wrong kind', { cachedId: cached.id, kind: stored.kind });
    lastInsertByActor.delete(by);
    return null;
  }

  const status = stored?.status;
  if (status && status !== 'pending') {
    logVerboseInsertRepair('[coalesce.debug] wrong status', { cachedId: cached.id, status });
    lastInsertByActor.delete(by);
    return null;
  }

  const range = resolveLiveInsertSuggestionRange(doc, cached.id)
    ?? (stored?.kind === 'insert' && stored.range ? { from: stored.range.from, to: stored.range.to } : null);
  if (!range) {
    logVerboseInsertRepair('[coalesce.debug] range not found', { cachedId: cached.id, storedKind: stored?.kind, storedRange: stored?.range });
    lastInsertByActor.delete(by);
    return null;
  }

  logVerboseInsertRepair('[coalesce.debug] range resolved', { cachedId: cached.id, range, pos, elapsed });

  if (range.to === pos) {
    return { id: cached.id, range, direction: 'append', insertPos: pos };
  }

  if (range.from === pos) {
    return { id: cached.id, range, direction: 'prepend', insertPos: pos };
  }

  logVerboseInsertRepair('[coalesce.debug] position mismatch', { cachedId: cached.id, rangeFrom: range.from, rangeTo: range.to, pos });

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

function sliceNodeIsWrappedPlainText(node: SliceNode | undefined): boolean {
  if (!node) return false;
  if (node.type === 'text') return true;
  if (typeof node.text === 'string') return true;
  if (node.type === 'hard_break') return true;
  if (node.type === 'paragraph') {
    if (!Array.isArray(node.content) || node.content.length === 0) return true;
    return node.content.every((child) => sliceNodeIsWrappedPlainText(child));
  }
  return false;
}

function sliceRepresentsWrappedPlainText(nodes?: SliceNode[]): boolean {
  if (!nodes || nodes.length === 0) return false;
  return nodes.every((node) => sliceNodeIsWrappedPlainText(node));
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
  const hasDelete = segments.some((segment) => segment.kind === 'delete');
  const hasReplace = segments.some((segment) => segment.kind === 'replace');
  const hasPlain = segments.some((segment) => segment.kind === 'plain');
  if (!hasPlain || (!hasInsert && !hasDelete && !hasReplace)) {
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
    if (segment.kind === 'delete' || segment.kind === 'replace') {
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

function applyMixedSuggestionReplacement(
  newTr: Transaction,
  metadata: Record<string, StoredMark>,
  from: number,
  to: number,
  actor: string,
  suggestionType: MarkType,
  insertedText: string,
): { handled: boolean; metadata: Record<string, StoredMark>; metadataChanged: boolean } {
  const segments = collectDeleteRangeSegments(newTr.doc, from, to, suggestionType);
  const hasInsert = segments.some((segment) => segment.kind === 'insert');
  const hasDelete = segments.some((segment) => segment.kind === 'delete');
  const hasReplace = segments.some((segment) => segment.kind === 'replace');
  const hasPlain = segments.some((segment) => segment.kind === 'plain');
  if (!hasPlain || (!hasInsert && !hasDelete && !hasReplace)) {
    return { handled: false, metadata, metadataChanged: false };
  }

  const createdAt = new Date().toISOString();
  const touchedInsertIds = new Set<string>();
  let nextMetadata = metadata;
  let metadataChanged = false;

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment.kind === 'insert') {
      for (const id of segment.insertIds) touchedInsertIds.add(id);
      newTr.delete(segment.from, segment.to);
      continue;
    }
    if (segment.kind === 'delete' || segment.kind === 'replace') {
      continue;
    }
    if (segment.kind !== 'plain') continue;

    const suggestionId = generateMarkId();
    newTr.addMark(
      segment.from,
      segment.to,
      suggestionType.create({
        id: suggestionId,
        kind: 'delete',
        by: actor,
      }),
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

  const insertPos = Math.max(0, Math.min(newTr.mapping.map(to, -1), newTr.doc.content.size));
  const insertSuggestionId = generateMarkId();
  newTr.insertText(insertedText, insertPos);
  newTr.addMark(
    insertPos,
    insertPos + insertedText.length,
    suggestionType.create({ id: insertSuggestionId, kind: 'insert', by: actor }),
  );

  nextMetadata = {
    ...nextMetadata,
    [insertSuggestionId]: {
      ...buildSuggestionMetadata('insert', actor, insertedText, createdAt),
      ...buildCollapsedInsertAnchorMetadata(insertPos),
    },
  };
  metadataChanged = true;

  lastInsertByActor.set(actor, {
    id: insertSuggestionId,
    from: insertPos,
    to: insertPos + insertedText.length,
    by: actor,
    updatedAt: Date.now(),
  });
  setSelectionAfterInsertedText(newTr, insertPos + insertedText.length);

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

function collectTextSegmentsInRange(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): TextSegmentRange[] {
  if (to <= from) return [];

  const segments: TextSegmentRange[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;

    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    if (end <= start) return true;

    const sourceText = node.text ?? '';
    const text = sourceText.slice(start - pos, end - pos);
    if (!text) return true;

    segments.push({ from: start, to: end, text });
    return true;
  });

  return segments;
}

function applyStructuredPlainTextSuggestion(
  newTr: Transaction,
  metadata: Record<string, StoredMark>,
  from: number,
  to: number,
  actor: string,
  suggestionType: MarkType,
  slice: unknown,
): {
  handled: boolean;
  metadata: Record<string, StoredMark>;
  metadataChanged: boolean;
  writeOffsetDelta: number;
} {
  if (!slice) {
    return { handled: false, metadata, metadataChanged: false, writeOffsetDelta: 0 };
  }

  const existing = detectSuggestionKinds(newTr.doc, from, to, suggestionType);
  if (existing.hasDelete || existing.hasInsert || existing.hasReplace) {
    return { handled: false, metadata, metadataChanged: false, writeOffsetDelta: 0 };
  }

  let nextMetadata = metadata;
  let metadataChanged = false;
  const createdAt = new Date().toISOString();
  const deletedText = newTr.doc.textBetween(from, to, '');

  if (deletedText) {
    const deleteSuggestionId = generateMarkId();
    newTr.addMark(
      from,
      to,
      suggestionType.create({
        id: deleteSuggestionId,
        kind: 'delete',
        by: actor,
      }),
    );

    nextMetadata = {
      ...nextMetadata,
      [deleteSuggestionId]: {
        ...buildSuggestionMetadata('delete', actor, null, createdAt),
        quote: deletedText,
      },
    };
    metadataChanged = true;
  }

  const docBeforeInsert = newTr.doc;
  const sizeBeforeInsert = docBeforeInsert.content.size;

  try {
    (newTr as Transaction & { replace: (fromPos: number, toPos: number, replacement: unknown) => Transaction })
      .replace(to, to, slice);
  } catch (error) {
    console.warn('[suggestions] Could not apply structured plain-text paste as tracked suggestion:', error);
    return { handled: false, metadata, metadataChanged: false, writeOffsetDelta: 0 };
  }

  const writeOffsetDelta = newTr.doc.content.size - sizeBeforeInsert;
  const insertionDiff = detectPlainTextInsertionBetweenDocs(docBeforeInsert, newTr.doc);
  if (!insertionDiff) {
    return {
      handled: true,
      metadata: nextMetadata,
      metadataChanged,
      writeOffsetDelta,
    };
  }

  const insertedSegments = collectTextSegmentsInRange(newTr.doc, insertionDiff.from, insertionDiff.to);
  const insertSuggestionIds: string[] = [];

  for (const segment of insertedSegments) {
    const insertSuggestionId = generateMarkId();
    newTr.addMark(
      segment.from,
      segment.to,
      suggestionType.create({
        id: insertSuggestionId,
        kind: 'insert',
        by: actor,
      }),
    );
    nextMetadata = {
      ...nextMetadata,
      [insertSuggestionId]: buildSuggestionMetadata('insert', actor, segment.text, createdAt),
    };
    metadataChanged = true;
    insertSuggestionIds.push(insertSuggestionId);
  }

  if (insertSuggestionIds.length > 0) {
    const syncedMetadata = syncInsertSuggestionMetadataFromDoc(newTr.doc, nextMetadata, insertSuggestionIds);
    metadataChanged = metadataChanged || syncedMetadata !== nextMetadata;
    nextMetadata = syncedMetadata;

    const lastInsertId = insertSuggestionIds[insertSuggestionIds.length - 1];
    const lastInsertRange = resolveLiveInsertSuggestionRange(newTr.doc, lastInsertId);
    if (lastInsertRange) {
      lastInsertByActor.set(actor, {
        id: lastInsertId,
        from: lastInsertRange.from,
        to: lastInsertRange.to,
        by: actor,
        updatedAt: Date.now(),
      });
    }
  }

  setSelectionAfterInsertedText(newTr, insertionDiff.to);

  return {
    handled: true,
    metadata: nextMetadata,
    metadataChanged,
    writeOffsetDelta,
  };
}

function buildTrackedSuggestionPasteTransaction(
  state: EditorState,
  slice: ProseMirrorSlice,
  domSelectionRange: MarkRange | null,
): Transaction | null {
  const sliceJson = slice.toJSON() as { content?: SliceNode[] };
  if (!sliceRepresentsWrappedPlainText(sliceJson.content)) return null;
  if (sliceContainsSuggestionMarks(sliceJson.content)) return null;

  let baseTr = state.tr;
  if (domSelectionRange && domSelectionRange.from < domSelectionRange.to) {
    try {
      baseTr = baseTr.setSelection(
        TextSelection.create(
          state.doc,
          domSelectionRange.from,
          domSelectionRange.to,
        ),
      );
    } catch (error) {
      console.warn('[suggestions] Could not align paste transaction selection to live DOM range:', error);
    }
  }

  const rawTr = baseTr.replaceSelection(slice);
  if (!rawTr.docChanged) return null;

  if (domSelectionRange && domSelectionRange.from < domSelectionRange.to) {
    rawTr.setMeta('proof-dom-selection-range', domSelectionRange);
  }
  rawTr.setMeta('proof-track-changes-paste', true);
  return rawTr;
}

export function __debugBuildTrackedSuggestionPasteTransaction(
  state: EditorState,
  slice: ProseMirrorSlice,
  domSelectionRange: MarkRange | null,
): Transaction | null {
  return buildTrackedSuggestionPasteTransaction(state, slice, domSelectionRange);
}

function dispatchTrackedSuggestionPaste(
  view: EditorView,
  event: ClipboardEvent,
  slice: ProseMirrorSlice,
): boolean {
  if (!isSuggestionsEnabled(view.state)) return false;
  if (event.defaultPrevented || view.composing) return false;

  const domSelectionRange = getLiveDomSelectionRange(view);
  const trackedPasteTr = buildTrackedSuggestionPasteTransaction(
    view.state,
    slice,
    domSelectionRange,
  );
  console.log('[suggestions.handlePaste]', {
    enabled: true,
    domSelectionRange,
    stateSelection: {
      from: view.state.selection.from,
      to: view.state.selection.to,
      empty: view.state.selection.empty,
    },
    plainTextSlice: trackedPasteTr !== null,
    slice: slice.toJSON(),
  });
  if (!trackedPasteTr) return false;

  view.dispatch(trackedPasteTr);
  return true;
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

export function buildTextPreservingInsertPersistenceTransaction(
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

function isRecentPendingInsertFragment(
  meta: StoredMark,
): boolean {
  if (meta.kind !== 'insert') return false;
  if (meta.status && meta.status !== 'pending') return false;
  const createdAt = parseStoredMarkTimestamp(meta.createdAt);
  if (createdAt === null) return false;
  return Math.abs(Date.now() - createdAt) <= COALESCE_WINDOW_MS;
}

function areInlineRunsAdjacent(
  left: Pick<InlineInsertRun, 'to'>,
  right: Pick<InlineInsertRun, 'from'>,
): boolean {
  return left.to === right.from;
}

function startsAtTextblockBoundary(
  doc: ProseMirrorNode,
  position: number,
): boolean {
  const resolved = doc.resolve(position);
  return resolved.parent.isTextblock && resolved.parentOffset === 0;
}

/**
 * Check whether the text at [from, to) in newState already existed as plain
 * (non-suggestion) content in oldState.  If it did, the text was authored
 * content typed with TC off and must NOT be absorbed into an adjacent
 * insert suggestion by the merge logic.
 *
 * Uses findDiffStart/findDiffEnd to avoid position-shift bugs:
 * content outside the diff range is definitely unchanged (pre-existing).
 * Content inside the diff range falls back to a full-text search in oldDoc.
 */
function isPreExistingPlainText(
  oldState: EditorState,
  newState: EditorState,
  from: number,
  to: number,
  text: string,
): boolean {
  if (text.length === 0) return false;

  const diffStart = oldState.doc.content.findDiffStart(newState.doc.content);
  if (typeof diffStart !== 'number') return true; // docs identical

  const diffEnd = oldState.doc.content.findDiffEnd(newState.doc.content);
  if (!diffEnd) return true; // docs identical

  // Content entirely before or after the changed range is unchanged
  if (to <= diffStart || from >= diffEnd.b) return true;

  // The plain run overlaps the diff range — it might be newly inserted.
  // Conservative fallback: search oldDoc's full text for the string.
  // False positives (text found elsewhere) are safe — we just skip the merge.
  try {
    const oldFullText = oldState.doc.textBetween(0, oldState.doc.content.size, '\0', '\0');
    if (oldFullText.includes(text)) return true;
  } catch { /* fall through */ }

  return false;
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
  logVerboseInsertRepair('[suggestions.mergeCheck.runs]', summarizeInlineInsertRuns(runs));
  const mergedInsertIds = new Set<string>();

  for (let index = 0; index < runs.length; index += 1) {
    const left = runs[index];
    const gap = runs[index + 1];
    const right = runs[index + 2];
    if (!left) continue;
    logVerboseInsertRepair('[suggestions.mergeCheck.window]', {
      index,
      left: left.kind === 'insert'
        ? { kind: left.kind, id: left.id, by: left.by, text: left.text, from: left.from, to: left.to }
        : left,
      gap,
      right: right?.kind === 'insert'
        ? { kind: right.kind, id: right.id, by: right.by, text: right.text, from: right.from, to: right.to }
        : right,
    });

    if (left.kind === 'plain' && gap?.kind === 'insert') {
      if (!areInlineRunsAdjacent(left, gap)) {
        continue;
      }
      const rightMeta = metadata[gap.id];
      if (!rightMeta || rightMeta.kind !== 'insert') {
        continue;
      }
      if (rightMeta.status && rightMeta.status !== 'pending') {
        continue;
      }
      if (!startsAtTextblockBoundary(newState.doc, left.from)) {
        continue;
      }
      if (left.text.length === 0 || left.text.length > 16) {
        continue;
      }
      if (!isRecentPendingInsertFragment(rightMeta)) {
        continue;
      }
      if (isPreExistingPlainText(oldState, newState, left.from, left.to, left.text)) {
        continue;
      }

      const rightBy = rightMeta.by ?? gap.by;
      if (authoredType) {
        tr = tr.removeMark(left.from, left.to, authoredType);
      }
      tr = tr.addMark(
        left.from,
        left.to,
        suggestionType.create({ id: gap.id, kind: 'insert', by: rightBy }),
      );

      metadataChanged = true;
      mergedInsertIds.add(gap.id);
      console.log('[suggestions.mergeAdjacentInsertSplit]', {
        leftId: null,
        rightId: gap.id,
        gapText: left.text,
      });
      index += 1;
      continue;
    }

    if (left.kind !== 'insert') continue;
    const leftMeta = metadata[left.id];
    if (!leftMeta || leftMeta.kind !== 'insert') continue;

    const leftBy = leftMeta.by ?? left.by;
    const leftWasPending = oldPendingInsertIds.has(left.id);
    if (!leftWasPending) continue;

    if (gap?.kind === 'plain' && right?.kind === 'insert') {
      if (!areInlineRunsAdjacent(left, gap) || !areInlineRunsAdjacent(gap, right)) {
        logVerboseInsertRepair('[suggestions.mergeCheck.skip]', {
          reason: 'non-adjacent-runs',
          leftId: left.id,
          rightId: right.id,
          leftTo: left.to,
          gapFrom: gap.from,
          gapTo: gap.to,
          rightFrom: right.from,
        });
        continue;
      }
      if (left.id === right.id) {
        logVerboseInsertRepair('[suggestions.mergeCheck.skip]', { reason: 'same-id', id: left.id });
        continue;
      }
      const rightMeta = metadata[right.id];
      if (!rightMeta || rightMeta.kind !== 'insert') {
        logVerboseInsertRepair('[suggestions.mergeCheck.skip]', { reason: 'missing-insert-metadata', leftId: left.id, rightId: right.id });
        continue;
      }
      if ((rightMeta.status && rightMeta.status !== 'pending')) {
        logVerboseInsertRepair('[suggestions.mergeCheck.skip]', {
          reason: 'non-pending-status',
          leftId: left.id,
          rightId: right.id,
          leftStatus: leftMeta.status,
          rightStatus: rightMeta.status,
        });
        continue;
      }

      const rightBy = rightMeta.by ?? right.by;
      const rightWasPending = oldPendingInsertIds.has(right.id);
      const allowRecentPendingPendingMerge = rightWasPending && shouldMergeRecentPendingInsertFragments(
        leftMeta,
        rightMeta,
        leftBy,
        rightBy,
      );
      if (rightWasPending && !allowRecentPendingPendingMerge) {
        logVerboseInsertRepair('[suggestions.mergeCheck.skip]', {
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
        logVerboseInsertRepair('[suggestions.mergeCheck.skip]', {
          reason: 'different-actors',
          leftId: left.id,
          rightId: right.id,
          leftBy,
          rightBy,
        });
        continue;
      }
      if (isPreExistingPlainText(oldState, newState, gap.from, gap.to, gap.text)) {
        logVerboseInsertRepair('[suggestions.mergeCheck.skip]', {
          reason: 'gap-is-pre-existing-authored-text',
          leftId: left.id,
          rightId: right.id,
          gapText: gap.text,
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
      continue;
    }

    if (gap?.kind === 'insert') {
      if (!areInlineRunsAdjacent(left, gap)) {
        continue;
      }
      if (left.id === gap.id) continue;
      const rightMeta = metadata[gap.id];
      if (!rightMeta || rightMeta.kind !== 'insert') continue;
      const rightBy = rightMeta.by ?? gap.by;
      const rightWasPending = oldPendingInsertIds.has(gap.id);
      const allowRecentPendingPendingMerge = rightWasPending && shouldMergeRecentPendingInsertFragments(
        leftMeta,
        rightMeta,
        leftBy,
        rightBy,
      );
      if (rightWasPending && !allowRecentPendingPendingMerge) continue;
      if (leftBy !== rightBy) continue;

      if (authoredType) {
        tr = tr.removeMark(gap.from, gap.to, authoredType);
      }
      tr = tr.removeMark(gap.from, gap.to, suggestionType);
      tr = tr.addMark(
        gap.from,
        gap.to,
        suggestionType.create({ id: left.id, kind: 'insert', by: leftBy }),
      );
      if (
        right?.kind === 'plain'
        && areInlineRunsAdjacent(gap, right)
        && isRecentPendingInsertFragment(leftMeta)
        && right.text.length <= 4
        && !isPreExistingPlainText(oldState, newState, right.from, right.to, right.text)
      ) {
        if (authoredType) {
          tr = tr.removeMark(right.from, right.to, authoredType);
        }
        tr = tr.addMark(
          right.from,
          right.to,
          suggestionType.create({ id: left.id, kind: 'insert', by: leftBy }),
        );
      }

      delete metadata[gap.id];
      metadataChanged = true;
      mergedInsertIds.add(left.id);
      console.log('[suggestions.mergeAdjacentInsertSplit]', {
        leftId: left.id,
        rightId: gap.id,
        gapText: '',
      });
      index += 1;
      continue;
    }

    if (gap?.kind === 'plain' && !right && isRecentPendingInsertFragment(leftMeta) && gap.text.length <= 4) {
      if (!areInlineRunsAdjacent(left, gap)) {
        continue;
      }
      if (isPreExistingPlainText(oldState, newState, gap.from, gap.to, gap.text)) {
        continue;
      }
      if (authoredType) {
        tr = tr.removeMark(gap.from, gap.to, authoredType);
      }
      tr = tr.addMark(
        gap.from,
        gap.to,
        suggestionType.create({ id: left.id, kind: 'insert', by: leftBy }),
      );
      metadataChanged = true;
      mergedInsertIds.add(left.id);
      console.log('[suggestions.mergeAdjacentInsertSplit]', {
        leftId: left.id,
        rightId: null,
        gapText: gap.text,
      });
      index += 1;
    }
  }

  if (mergedInsertIds.size === 0) return null;

  metadata = Object.fromEntries(
    Object.entries(metadata).filter(([, stored]) => Boolean(stored)),
  ) as Record<string, StoredMark>;
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
  return detectPlainTextInsertionBetweenDocs(oldState.doc, newState.doc);
}

function detectPlainTextInsertionBetweenDocs(
  oldDoc: ProseMirrorNode,
  newDoc: ProseMirrorNode,
): { from: number; to: number; insertedText: string } | null {
  const from = oldDoc.content.findDiffStart(newDoc.content);
  if (typeof from !== 'number') return null;
  const diffEnd = oldDoc.content.findDiffEnd(newDoc.content);
  if (!diffEnd) return null;

  const insertedText = newDoc.textBetween(from, diffEnd.b, '\n', '\n');
  const deletedText = oldDoc.textBetween(from, diffEnd.a, '\n', '\n');
  if (!insertedText || deletedText.length > 0) return null;

  return { from, to: diffEnd.b, insertedText };
}

function rememberHandledTextInputDispatch(text: string, from: number, to: number): void {
  const insertFrom = Math.min(from, to);
  const expectedFrom = insertFrom + text.length;
  pendingHandledTextInputEcho = {
    text,
    originalFrom: insertFrom,
    originalTo: insertFrom + text.length,
    expectedFrom,
    expectedTo: expectedFrom + text.length,
    at: Date.now(),
  };
  console.log('[suggestions.handleTextInput.rememberEcho]', {
    text,
    from,
    to,
    originalFrom: insertFrom,
    originalTo: insertFrom + text.length,
    expectedFrom,
    expectedTo: expectedFrom + text.length,
  });
}

function shouldSuppressDuplicateHandledTextInputCall(text: string, from: number, to: number): boolean {
  if (!recentHandledTextInputCall) return false;
  const age = Date.now() - recentHandledTextInputCall.at;
  if (age > DUPLICATE_HANDLED_TEXT_INPUT_CALL_TTL_MS) {
    recentHandledTextInputCall = null;
    return false;
  }
  return recentHandledTextInputCall.text === text
    && recentHandledTextInputCall.from === from
    && recentHandledTextInputCall.to === to;
}

function rememberHandledTextInputCall(text: string, from: number, to: number): void {
  recentHandledTextInputCall = {
    text,
    from,
    to,
    at: Date.now(),
  };
}

function rememberPendingNativeTextInput(text: string, from: number, to: number): void {
  pendingNativeTextInput = {
    text,
    from,
    to,
    at: Date.now(),
  };
}

export function shouldPassthroughPendingNativeTextInputTransaction(
  oldState: EditorState,
  tr: Transaction,
): boolean {
  return consumePendingNativeTextInputTransactionMatch(oldState, tr) !== null;
}

export function consumePendingNativeTextInputTransactionMatch(
  oldState: EditorState,
  tr: Transaction,
): NativeTextInputMatch | null {
  if (!pendingNativeTextInput) return null;
  const age = Date.now() - pendingNativeTextInput.at;
  if (age > PENDING_NATIVE_TEXT_INPUT_TTL_MS) {
    pendingNativeTextInput = null;
    return null;
  }

  const diff = detectPlainTextInsertionBetweenDocs(oldState.doc, tr.doc);
  if (!diff) return null;

  const matches = (
    diff.insertedText === pendingNativeTextInput.text
    && diff.from === pendingNativeTextInput.from
    && diff.to === pendingNativeTextInput.from + pendingNativeTextInput.text.length
  );

  console.log('[suggestions.handleTextInput.nativePassthroughCheck]', {
    pending: pendingNativeTextInput,
    diff,
    matches,
    stepTypes: tr.steps.map((step) => {
      const stepJson = step.toJSON() as { stepType?: string };
      return stepJson.stepType ?? step.constructor.name;
    }),
  });

  if (matches) {
    pendingNativeTextInput = null;
    return {
      text: diff.insertedText,
      from: diff.from,
      to: diff.to,
    };
  }

  pendingNativeTextInput = null;
  return null;
}

export function shouldSuppressHandledTextInputEcho(
  oldState: EditorState,
  tr: Transaction,
): boolean {
  if (!pendingHandledTextInputEcho) return false;
  const handledMeta = tr.getMeta(HANDLED_TEXT_INPUT_META) as { text?: unknown; from?: unknown; to?: unknown } | undefined;

  const age = Date.now() - pendingHandledTextInputEcho.at;
  if (age > HANDLED_TEXT_INPUT_ECHO_TTL_MS) {
    console.log('[suggestions.handleTextInput.echoCheck.expired]', {
      pending: pendingHandledTextInputEcho,
      age,
      ttlMs: HANDLED_TEXT_INPUT_ECHO_TTL_MS,
    });
    pendingHandledTextInputEcho = null;
    return false;
  }

  if (!tr.docChanged) {
    console.log('[suggestions.handleTextInput.echoCheck.noDocChange]', {
      pending: pendingHandledTextInputEcho,
      handledMeta: handledMeta ?? null,
      selectionFrom: tr.selection?.from ?? null,
      selectionTo: tr.selection?.to ?? null,
    });
    return false;
  }
  const diff = detectPlainTextInsertionBetweenDocs(oldState.doc, tr.doc);
  if (!diff) {
    console.log('[suggestions.handleTextInput.echoCheck.noPlainInsertDiff]', {
      pending: pendingHandledTextInputEcho,
      handledMeta: handledMeta ?? null,
      selectionFrom: tr.selection?.from ?? null,
      selectionTo: tr.selection?.to ?? null,
      stepTypes: tr.steps.map((step) => (step?.toJSON?.() as { stepType?: string } | undefined)?.stepType ?? 'unknown'),
    });
    return false;
  }

  const matchesExpectedEcho = diff.insertedText === pendingHandledTextInputEcho.text
    && diff.from === pendingHandledTextInputEcho.expectedFrom
    && diff.to === pendingHandledTextInputEcho.expectedTo;
  const oldHasOriginalText = oldState.doc.textBetween(
    pendingHandledTextInputEcho.originalFrom,
    pendingHandledTextInputEcho.originalTo,
    '',
    '',
  ) === pendingHandledTextInputEcho.text;
  const matchesOriginalDuplicate = diff.insertedText === pendingHandledTextInputEcho.text
    && diff.from === pendingHandledTextInputEcho.originalFrom
    && diff.to === pendingHandledTextInputEcho.originalTo
    && oldHasOriginalText;
  const shouldSuppress = matchesExpectedEcho || matchesOriginalDuplicate;

  console.log('[suggestions.handleTextInput.echoCheck]', {
    pending: pendingHandledTextInputEcho,
    handledMeta: handledMeta ?? null,
    diff,
    matchesExpectedEcho,
    matchesOriginalDuplicate,
    oldHasOriginalText,
    shouldSuppress,
    selectionFrom: tr.selection?.from ?? null,
    selectionTo: tr.selection?.to ?? null,
    stepTypes: tr.steps.map((step) => (step?.toJSON?.() as { stepType?: string } | undefined)?.stepType ?? 'unknown'),
  });

  if (shouldSuppress) {
    pendingHandledTextInputEcho = null;
  }

  return shouldSuppress;
}

export function __debugRememberHandledTextInputDispatch(text: string, from: number, to: number): void {
  rememberHandledTextInputDispatch(text, from, to);
}

export function __debugResetHandledTextInputEcho(): void {
  pendingHandledTextInputEcho = null;
  recentHandledTextInputCall = null;
  pendingNativeTextInput = null;
}

export function __debugShouldSuppressHandledTextInputEcho(oldState: EditorState, tr: Transaction): boolean {
  return shouldSuppressHandledTextInputEcho(oldState, tr);
}

export function __debugRememberHandledTextInputCall(text: string, from: number, to: number): void {
  rememberHandledTextInputCall(text, from, to);
}

export function __debugShouldSuppressDuplicateHandledTextInputCall(text: string, from: number, to: number): boolean {
  return shouldSuppressDuplicateHandledTextInputCall(text, from, to);
}

export function __debugRememberPendingNativeTextInput(text: string, from: number, to: number): void {
  rememberPendingNativeTextInput(text, from, to);
}

export function __debugRememberResolvedPendingNativeTextInput(
  state: EditorState,
  text: string,
  from: number,
  to: number,
): { from: number; to: number } {
  const resolved = resolveTrackedTextInputRange(state, from, to);
  rememberPendingNativeTextInput(text, resolved.from, resolved.to);
  return resolved;
}

export function __debugShouldPassthroughPendingNativeTextInputTransaction(
  oldState: EditorState,
  tr: Transaction,
): boolean {
  return shouldPassthroughPendingNativeTextInputTransaction(oldState, tr);
}

function getNativeTextInputMatchMeta(tr: Transaction): NativeTextInputMatch | null {
  const meta = tr.getMeta(NATIVE_TEXT_INPUT_MATCH_META) as Partial<NativeTextInputMatch> | null | undefined;
  if (!meta) return null;
  if (typeof meta.text !== 'string') return null;
  if (typeof meta.from !== 'number' || typeof meta.to !== 'number') return null;
  if (!Number.isFinite(meta.from) || !Number.isFinite(meta.to)) return null;
  return {
    text: meta.text,
    from: meta.from,
    to: meta.to,
  };
}

export function wrapPendingNativeTextInputTransaction(
  oldState: EditorState,
  tr: Transaction,
): Transaction | null {
  const diff = detectPlainTextInsertionBetweenDocs(oldState.doc, tr.doc);
  if (!diff) return null;

  const suggestionType = oldState.schema.marks.proofSuggestion;
  if (!suggestionType) return null;

  const actor = getCurrentActor();
  const now = Date.now();
  let metadata = getMarkMetadata(oldState);
  let metadataChanged = false;
  let nextTr = tr;

  const authoredType = oldState.schema.marks.proofAuthored ?? null;
  if (authoredType) {
    nextTr = nextTr.removeMark(diff.from, diff.to, authoredType);
  }

  const existingInsertIds = collectSuggestionIdsInRange(nextTr.doc, 'insert', diff.from, diff.to);
  if (existingInsertIds.length > 0) {
    if (existingInsertIds.length === 1) {
      const insertId = existingInsertIds[0]!;
      const insertBy = metadata[insertId]?.by ?? actor;
      const existingRange = resolveLiveInsertSuggestionRange(nextTr.doc, insertId);
      const cursorOffsetWithinInsert = existingRange
        ? Math.max(0, diff.from - existingRange.from) + diff.insertedText.length
        : diff.insertedText.length;
      nextTr = nextTr.addMark(
        diff.from,
        diff.to,
        suggestionType.create({ id: insertId, kind: 'insert', by: insertBy }),
      );
      const updatedRange = resolveLiveInsertSuggestionRange(nextTr.doc, insertId) ?? existingRange;
      if (updatedRange) {
        lastInsertByActor.set(actor, {
          id: insertId,
          from: updatedRange.from,
          to: updatedRange.to,
          by: insertBy,
          updatedAt: now,
        });
        const cursorPos = Math.max(
          updatedRange.from,
          Math.min(updatedRange.from + cursorOffsetWithinInsert, updatedRange.to),
        );
        setSelectionAfterInsertedText(nextTr, cursorPos);
      }
    }
    const syncedMetadata = syncInsertSuggestionMetadataFromDoc(nextTr.doc, metadata, existingInsertIds);
    metadataChanged = metadataChanged || syncedMetadata !== metadata;
    metadata = syncedMetadata;
  } else {
    let candidate = getCoalescableInsertCandidate(nextTr.doc, metadata, diff.from, actor, now);

    if (!candidate) {
      const cached = lastInsertByActor.get(actor);
      if (cached && cached.to === diff.from && (now - cached.updatedAt) <= COALESCE_WINDOW_MS) {
        const liveRange = resolveLiveInsertSuggestionRange(nextTr.doc, cached.id);
        if (liveRange && liveRange.to < diff.from) {
          const gapText = nextTr.doc.textBetween(liveRange.to, diff.from, '');
          if (gapText.length > 0 && isWhitespaceOnly(gapText)) {
            nextTr = nextTr.addMark(
              liveRange.to,
              diff.from,
              suggestionType.create({ id: cached.id, kind: 'insert', by: actor }),
            );
            candidate = getCoalescableInsertCandidate(nextTr.doc, metadata, diff.from, actor, now);
          }
        }
      }
    }

    if (candidate) {
      nextTr = nextTr.addMark(
        diff.from,
        diff.to,
        suggestionType.create({ id: candidate.id, kind: 'insert', by: actor }),
      );
      const syncedMetadata = syncInsertSuggestionMetadataFromDoc(nextTr.doc, metadata, [candidate.id]);
      metadataChanged = metadataChanged || syncedMetadata !== metadata;
      metadata = syncedMetadata;
      const updatedRange = resolveLiveInsertSuggestionRange(nextTr.doc, candidate.id)
        ?? candidate.range;
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
      nextTr = nextTr.addMark(
        diff.from,
        diff.to,
        suggestionType.create({ id: suggestionId, kind: 'insert', by: actor }),
      );
      metadata = {
        ...metadata,
        [suggestionId]: {
          ...buildSuggestionMetadata('insert', actor, diff.insertedText, createdAt),
          ...buildCollapsedInsertAnchorMetadata(diff.from),
        },
      };
      const syncedMetadata = syncInsertSuggestionMetadataFromDoc(nextTr.doc, metadata, [suggestionId]);
      metadataChanged = true;
      metadata = syncedMetadata;
      const updatedRange = resolveLiveInsertSuggestionRange(nextTr.doc, suggestionId) ?? {
        from: diff.from,
        to: diff.to,
      };
      lastInsertByActor.set(actor, {
        id: suggestionId,
        from: updatedRange.from,
        to: updatedRange.to,
        by: actor,
        updatedAt: now,
      });
    }
  }

  nextTr = stripAuthoredMarksFromPendingInsertRanges(nextTr, authoredType, metadata);
  if (nextTr.steps.length === 0 && !metadataChanged) return null;
  const finalTr = metadataChanged ? syncSuggestionMetadataTransaction(oldState, nextTr, metadata) : nextTr;
  finalTr.setMeta('suggestions-wrapped', true);
  return finalTr;
}

export function __debugWrapPendingNativeTextInputTransaction(
  oldState: EditorState,
  tr: Transaction,
): Transaction | null {
  return wrapPendingNativeTextInputTransaction(oldState, tr);
}

export function buildNativeTextInputFollowupWrapTransaction(
  oldState: EditorState,
  newState: EditorState,
  nativeTextInputMatch?: NativeTextInputMatch | null,
): Transaction | null {
  const explicitDiff = nativeTextInputMatch
    ? resolveNativeTextInputFollowupDiff(newState, nativeTextInputMatch)
    : null;
  return buildPlainInsertionSuggestionFallbackTransaction(oldState, newState, explicitDiff);
}

function resolveNativeTextInputFollowupDiff(
  newState: EditorState,
  nativeTextInputMatch: NativeTextInputMatch,
): { from: number; to: number; insertedText: string } | null {
  if (nativeTextInputMatch.to <= nativeTextInputMatch.from) return null;
  if (nativeTextInputMatch.from < 0 || nativeTextInputMatch.to > newState.doc.content.size) return null;
  const liveText = newState.doc.textBetween(
    nativeTextInputMatch.from,
    nativeTextInputMatch.to,
    '\n',
    '\n',
  );
  if (liveText !== nativeTextInputMatch.text) return null;
  return {
    from: nativeTextInputMatch.from,
    to: nativeTextInputMatch.to,
    insertedText: nativeTextInputMatch.text,
  };
}

function buildPlainInsertionSuggestionFallbackTransaction(
  oldState: EditorState,
  newState: EditorState,
  explicitDiff?: { from: number; to: number; insertedText: string } | null,
): Transaction | null {
  const diff = explicitDiff ?? detectPlainTextInsertionDiff(oldState, newState);
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
    if (existingInsertIds.length === 1) {
      const insertId = existingInsertIds[0]!;
      const insertBy = metadata[insertId]?.by ?? actor;
      const existingRange = resolveLiveInsertSuggestionRange(newState.doc, insertId);
      const cursorOffsetWithinInsert = existingRange
        ? Math.max(0, diff.from - existingRange.from) + diff.insertedText.length
        : diff.insertedText.length;
      tr = tr.addMark(
        diff.from,
        diff.to,
        suggestionType.create({ id: insertId, kind: 'insert', by: insertBy }),
      );
      const updatedRange = resolveLiveInsertSuggestionRange(tr.doc, insertId) ?? existingRange;
      if (updatedRange) {
        lastInsertByActor.set(actor, {
          id: insertId,
          from: updatedRange.from,
          to: updatedRange.to,
          by: insertBy,
          updatedAt: now,
        });
        const cursorPos = Math.max(
          updatedRange.from,
          Math.min(updatedRange.from + cursorOffsetWithinInsert, updatedRange.to),
        );
        setSelectionAfterInsertedText(tr, cursorPos);
      }
    }
    const syncedMetadata = syncInsertSuggestionMetadataFromDoc(tr.doc, metadata, existingInsertIds);
    metadataChanged = metadataChanged || syncedMetadata !== metadata;
    metadata = syncedMetadata;
    if (tr.steps.length === 0 && !metadataChanged) return null;
    const finalTr = metadataChanged ? syncSuggestionMetadataTransaction(newState, tr, metadata) : tr;
    finalTr.setMeta('suggestions-wrapped', true);
    return finalTr;
  }

  let candidate = getCoalescableInsertCandidate(newState.doc, metadata, diff.from, actor, now);

  // Whitespace gap repair (same as step-loop path)
  if (!candidate) {
    const cached = lastInsertByActor.get(actor);
    if (cached && cached.to === diff.from && (now - cached.updatedAt) <= COALESCE_WINDOW_MS) {
      const liveRange = resolveLiveInsertSuggestionRange(newState.doc, cached.id);
      if (liveRange && liveRange.to < diff.from) {
        const gapText = newState.doc.textBetween(liveRange.to, diff.from, '');
        if (gapText.length > 0 && isWhitespaceOnly(gapText)) {
          logVerboseInsertRepair('[suggestions.whitespaceGapRepair.fallback]', {
            cachedId: cached.id,
            liveRange,
            gapFrom: liveRange.to,
            gapTo: diff.from,
          });
          tr = tr.addMark(
            liveRange.to,
            diff.from,
            suggestionType.create({ id: cached.id, kind: 'insert', by: actor }),
          );
          candidate = getCoalescableInsertCandidate(tr.doc, metadata, diff.from, actor, now);
        }
      }
    }
  }

  if (candidate) {
    tr = tr.addMark(
      diff.from,
      diff.to,
      suggestionType.create({ id: candidate.id, kind: 'insert', by: actor })
    );
    const syncedMetadata = syncInsertSuggestionMetadataFromDoc(tr.doc, metadata, [candidate.id]);
    metadataChanged = metadataChanged || syncedMetadata !== metadata;
    metadata = syncedMetadata;
    const updatedRange = resolveLiveInsertSuggestionRange(tr.doc, candidate.id)
      ?? candidate.range;
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

function shouldRunTextPreservingInsertPersistenceFallback(
  trs: readonly Transaction[],
  options?: { hasRemoteSuggestionInsert?: boolean },
): boolean {
  const hasWrappedSuggestionTransaction = trs.some((tr) => tr.getMeta('suggestions-wrapped'));
  if (hasWrappedSuggestionTransaction) return false;
  if (options?.hasRemoteSuggestionInsert) return false;
  return true;
}

export function __debugShouldRunTextPreservingInsertPersistenceFallback(
  trs: readonly Transaction[],
  options?: { hasRemoteSuggestionInsert?: boolean },
): boolean {
  return shouldRunTextPreservingInsertPersistenceFallback(trs, options);
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

type BlockedTrackChangesMarkMutation = {
  reason: 'mark-step' | 'stored-mark-toggle';
  markNames: string[];
  stepTypes: string[];
};

function isProofTrackChangesMarkName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.startsWith('proof');
}

function summarizeNonProofMarkNames(marks: readonly Mark[] | null | undefined): string[] {
  if (!marks || marks.length === 0) return [];

  const names = new Set<string>();
  for (const mark of marks) {
    const name = mark.type?.name;
    if (!isProofTrackChangesMarkName(name)) {
      names.add(name || 'unknown');
    }
  }

  return [...names].sort();
}

function summarizeNonProofMarkKeys(marks: readonly Mark[] | null | undefined): string[] {
  if (!marks || marks.length === 0) return [];

  const keys = new Set<string>();
  for (const mark of marks) {
    const name = mark.type?.name;
    if (isProofTrackChangesMarkName(name)) continue;
    keys.add(`${name || 'unknown'}:${JSON.stringify(mark.attrs ?? {})}`);
  }

  return [...keys].sort();
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

export function getBlockedTrackChangesMarkMutation(
  tr: Transaction,
  state: EditorState,
): BlockedTrackChangesMarkMutation | null {
  let sawMarkStep = false;
  let sawNonMarkStep = false;
  const stepTypes: string[] = [];
  const markNames = new Set<string>();

  for (const step of tr.steps) {
    const stepJson = step.toJSON() as { stepType?: string; mark?: { type?: string } };
    const stepType = stepJson.stepType ?? step.constructor?.name ?? 'unknown';
    stepTypes.push(stepType);

    if (stepType === 'addMark' || stepType === 'removeMark') {
      sawMarkStep = true;
      const markName = (step as { mark?: Mark }).mark?.type?.name ?? stepJson.mark?.type ?? 'unknown';
      if (!isProofTrackChangesMarkName(markName)) {
        markNames.add(markName);
      }
      continue;
    }

    sawNonMarkStep = true;
  }

  if (sawMarkStep && !sawNonMarkStep && markNames.size > 0) {
    return {
      reason: 'mark-step',
      markNames: [...markNames].sort(),
      stepTypes,
    };
  }

  if (!tr.docChanged && tr.storedMarksSet) {
    const currentMarks = state.storedMarks ?? state.selection.$from.marks();
    const nextMarks = tr.storedMarks ?? [];
    const currentNonProofKeys = summarizeNonProofMarkKeys(currentMarks);
    const nextNonProofKeys = summarizeNonProofMarkKeys(nextMarks);
    if (!sameStringArray(currentNonProofKeys, nextNonProofKeys)) {
      const currentNames = summarizeNonProofMarkNames(currentMarks);
      const nextNames = summarizeNonProofMarkNames(nextMarks);
      const changedNames = [...new Set([...currentNames, ...nextNames])].sort();
      if (changedNames.length > 0) {
        return {
          reason: 'stored-mark-toggle',
          markNames: changedNames,
          stepTypes,
        };
      }
    }
  }

  return null;
}

export function __debugDetectBlockedTrackChangesMarkMutation(
  tr: Transaction,
  state: EditorState,
): BlockedTrackChangesMarkMutation | null {
  return getBlockedTrackChangesMarkMutation(tr, state);
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

function shouldSuppressStructuralParagraphSplit(state: EditorState): boolean {
  const { selection } = state;
  const { $from } = selection;
  if ($from.parent.type.name === 'code_block') return false;
  if (!selection.empty) return true;

  // Allow Enter at the end of a non-empty textblock so authors can continue
  // on the next line without having to toggle out of TC. Mid-paragraph splits
  // still stay blocked because they remain structurally unsafe to represent as
  // tracked suggestions.
  if ($from.parent.content.size === 0) return true;
  return selection.from !== $from.end();
}

export function __debugShouldSuppressStructuralParagraphSplit(state: EditorState): boolean {
  return shouldSuppressStructuralParagraphSplit(state);
}

function shouldSuppressStructuralBoundaryDelete(
  state: EditorState,
  key: 'Backspace' | 'Delete',
  modifiers?: { altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean },
  selectionOverride?: MarkRange | null,
): boolean {
  const overriddenSelection = selectionOverride && selectionOverride.to > selectionOverride.from
    ? {
        from: Math.min(selectionOverride.from, selectionOverride.to),
        to: Math.max(selectionOverride.from, selectionOverride.to),
      }
    : null;
  if (overriddenSelection) return false;

  const selection = state.selection;
  if (!selection.empty) return false;
  if (modifiers?.altKey || modifiers?.metaKey || modifiers?.ctrlKey) return false;

  const textblock = resolveContainingTextblockRange(state, selection.from);
  if (!textblock) return false;

  if (key === 'Backspace') {
    return selection.from <= textblock.from;
  }

  return selection.from >= textblock.to;
}

export function __debugShouldSuppressStructuralBoundaryDelete(
  state: EditorState,
  key: 'Backspace' | 'Delete',
  modifiers?: { altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean },
  selectionOverride?: MarkRange | null,
): boolean {
  return shouldSuppressStructuralBoundaryDelete(state, key, modifiers, selectionOverride);
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
  selectionOverride?: MarkRange | null,
): MarkRange | null {
  const finish = (reason: string, range: MarkRange | null): MarkRange | null => {
    console.log('[suggestions.resolveTrackedDeleteRange]', {
      key,
      modifiers: modifiers ?? null,
      selectionOverride,
      stateSelection: {
        from: state.selection.from,
        to: state.selection.to,
        empty: state.selection.empty,
      },
      reason,
      range,
      rangeText: range ? state.doc.textBetween(range.from, range.to, '', '') : '',
    });
    return range;
  };

  const overriddenSelection = selectionOverride && selectionOverride.to > selectionOverride.from
    ? {
        from: Math.min(selectionOverride.from, selectionOverride.to),
        to: Math.max(selectionOverride.from, selectionOverride.to),
      }
    : null;
  if (overriddenSelection) {
    return finish('selection-override', overriddenSelection);
  }

  const selection = state.selection;
  if (!selection.empty) {
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    return finish('state-selection', to > from ? { from, to } : null);
  }

  const cursor = selection.from;
  const textblock = resolveContainingTextblockRange(state, cursor);

  if (key === 'Backspace') {
    if (modifiers?.metaKey && textblock) {
      return finish('backspace-line', cursor > textblock.from ? { from: textblock.from, to: cursor } : null);
    }
    if ((modifiers?.altKey || modifiers?.ctrlKey) && textblock) {
      const prefix = state.doc.textBetween(textblock.from, cursor, '', '');
      const startOffset = resolveBackwardWordOffset(prefix);
      const from = textblock.from + startOffset;
      return finish('backspace-word', cursor > from ? { from, to: cursor } : null);
    }
    return finish('backspace-char', cursor > 0 ? { from: cursor - 1, to: cursor } : null);
  }

  const deleteCursor = resolveLeadingDeleteSuggestionRunEnd(state.doc, cursor);
  const deleteTextblock = deleteCursor === cursor
    ? textblock
    : resolveContainingTextblockRange(state, deleteCursor);

  if (modifiers?.metaKey && deleteTextblock) {
    return finish(
      deleteCursor !== cursor ? 'delete-line-skip-delete-suggestion' : 'delete-line',
      deleteCursor < deleteTextblock.to ? { from: deleteCursor, to: deleteTextblock.to } : null,
    );
  }
  if ((modifiers?.altKey || modifiers?.ctrlKey) && deleteTextblock) {
    const suffix = state.doc.textBetween(deleteCursor, deleteTextblock.to, '', '');
    const endOffset = resolveForwardWordOffset(suffix);
    const to = deleteCursor + endOffset;
    return finish(
      deleteCursor !== cursor ? 'delete-word-skip-delete-suggestion' : 'delete-word',
      to > deleteCursor ? { from: deleteCursor, to } : null,
    );
  }
  return finish(
    deleteCursor !== cursor ? 'delete-char-skip-delete-suggestion' : 'delete-char',
    deleteCursor < state.doc.content.size ? { from: deleteCursor, to: deleteCursor + 1 } : null,
  );
}

function getLiveDomSelectionRange(view: EditorView): MarkRange | null {
  const ownerDocument = view.dom.ownerDocument;
  const selection = ownerDocument?.getSelection?.()
    ?? (typeof document !== 'undefined' ? document.getSelection() : null);
  const selectionText = selection?.toString() ?? '';
  if (!selection || selection.rangeCount === 0) {
    console.log('[suggestions.getLiveDomSelectionRange.none]', {
      hasSelection: Boolean(selection),
      rangeCount: selection?.rangeCount ?? 0,
      selectionText,
    });
    return null;
  }

  const range = selection.getRangeAt(0);
  const elementNodeType = ownerDocument?.defaultView?.Node?.ELEMENT_NODE ?? 1;
  const getElement = (node: Node | null): Element | null => {
    if (!node) return null;
    return node.nodeType === elementNodeType ? node as Element : node.parentElement;
  };

  const startElement = getElement(range.startContainer);
  const endElement = getElement(range.endContainer);
  if (!startElement || !endElement) {
    console.log('[suggestions.getLiveDomSelectionRange.no-elements]', {
      selectionText,
      startNodeName: range.startContainer?.nodeName ?? null,
      endNodeName: range.endContainer?.nodeName ?? null,
    });
    return null;
  }
  if (!view.dom.contains(startElement) || !view.dom.contains(endElement)) {
    console.log('[suggestions.getLiveDomSelectionRange.outside-view]', {
      selectionText,
      startTag: startElement.tagName,
      endTag: endElement.tagName,
    });
    return null;
  }

  try {
    const startPos = view.posAtDOM(range.startContainer, range.startOffset);
    const endPos = view.posAtDOM(range.endContainer, range.endOffset);
    const from = Math.min(startPos, endPos);
    const to = Math.max(startPos, endPos);
    const resolved = from < to ? { from, to } : null;
    console.log('[suggestions.getLiveDomSelectionRange.result]', {
      selectionText,
      startPos,
      endPos,
      from,
      to,
      resolved,
      resolvedText: resolved ? view.state.doc.textBetween(resolved.from, resolved.to, '', '') : '',
      stateSelection: {
        from: view.state.selection.from,
        to: view.state.selection.to,
        empty: view.state.selection.empty,
      },
    });
    return resolved;
  } catch (error) {
    console.log('[suggestions.getLiveDomSelectionRange.error]', {
      selectionText,
      startNodeName: range.startContainer?.nodeName ?? null,
      startOffset: range.startOffset,
      endNodeName: range.endContainer?.nodeName ?? null,
      endOffset: range.endOffset,
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : String(error),
    });
    return null;
  }
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

  const blockedMarkMutation = getBlockedTrackChangesMarkMutation(tr, state);
  if (blockedMarkMutation?.reason === 'mark-step') {
    console.log('[suggestions.wrapForSuggestions.blockUnsupportedMarkMutation]', {
      reason: blockedMarkMutation.reason,
      markNames: blockedMarkMutation.markNames,
      stepTypes: blockedMarkMutation.stepTypes,
    });
    return state.tr.setMeta('addToHistory', false);
  }

  // Check for structural changes (paragraph splits, etc). Pass through unchanged.
  for (const step of tr.steps) {
    const stepJson = step.toJSON() as { stepType?: string; slice?: { content?: SliceNode[] } };
    if (stepJson.stepType === 'replace' && stepJson.slice?.content) {
      const { hasNonText } = collectSliceText(stepJson.slice.content);
      if (hasNonText && !sliceRepresentsWrappedPlainText(stepJson.slice.content)) {
        console.log('[suggestions.wrapForSuggestions.structuralPassthrough]', {
          stepType: stepJson.stepType,
          sliceContentTypes: stepJson.slice.content.map((n: SliceNode) => n.type),
        });
        return tr;
      }
    }
  }

  const actor = getCurrentActor();
  let metadata = getMarkMetadata(state);
  let metadataChanged = false;

  // Build a new transaction that converts edits to tracked changes.
  let newTr = state.tr;
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

      const mixedReplacementResult = applyMixedSuggestionReplacement(
        newTr,
        metadata,
        safeFrom,
        safeTo,
        actor,
        suggestionType,
        insertedText,
      );
      if (mixedReplacementResult.handled) {
        metadataChanged = metadataChanged || mixedReplacementResult.metadataChanged;
        metadata = mixedReplacementResult.metadata;
      } else if (existing.hasDelete) {
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
          const existingRange = resolveLiveInsertSuggestionRange(newTr.doc, suggestionId);
          const cursorOffsetWithinInsert = existingRange
            ? Math.max(0, safeFrom - existingRange.from) + insertedText.length
            : insertedText.length;

          newTr.replaceWith(
            safeFrom,
            safeTo,
            state.schema.text(insertedText, [
              suggestionType.create({ id: suggestionId, kind: 'insert', by: insertBy }),
            ]),
          );
          const materialized = materializeInsertSuggestionAsSingleTextNode(
            newTr,
            suggestionId,
            insertBy,
            suggestionType,
            authoredType,
          );
          newTr = materialized.tr;

          const syncedMetadata = syncInsertSuggestionMetadataFromDoc(newTr.doc, metadata, touchedInsertIds);
          metadataChanged = metadataChanged || syncedMetadata !== metadata;
          metadata = syncedMetadata;
          const updatedRange = materialized.range
            ?? resolveLiveInsertSuggestionRange(newTr.doc, suggestionId)
            ?? existingRange;
          if (updatedRange) {
            lastInsertByActor.set(actor, {
              id: suggestionId,
              from: updatedRange.from,
              to: updatedRange.to,
              by: insertBy,
              updatedAt: Date.now(),
            });
            const cursorPos = Math.max(
              updatedRange.from,
              Math.min(updatedRange.from + cursorOffsetWithinInsert, updatedRange.to),
            );
            setSelectionAfterInsertedText(newTr, cursorPos);
          }
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

        // FIX17: Place delete mark FIRST, then insert AFTER the deleted range.
        // With [insert][delete] order, y-prosemirror's simpleDiff inserts
        // coalesced characters at the item boundary between insert and delete
        // items in Y.Text. With inclusive:false, boundary items don't inherit
        // the insert mark, causing canonical markdown interleaving.
        // With [delete][insert] order, coalesced characters always append at
        // the END of the Y.Text, away from any mark boundary.
        newTr.addMark(
          safeFrom,
          safeTo,
          suggestionType.create({
            id: deleteSuggestionId,
            kind: 'delete',
            by: actor,
          })
        );
        newTr.insertText(insertedText, safeTo);
        newTr.addMark(
          safeTo,
          safeTo + insertedText.length,
          suggestionType.create({ id: insertSuggestionId, kind: 'insert', by: actor })
        );

        metadata = {
          ...metadata,
          [deleteSuggestionId]: {
            ...buildSuggestionMetadata('delete', actor, null, createdAt),
            quote: deletedText,
          },
          [insertSuggestionId]: {
            ...buildSuggestionMetadata('insert', actor, insertedText, createdAt),
            ...buildCollapsedInsertAnchorMetadata(safeTo),
          },
        };
        metadataChanged = true;

        lastInsertByActor.set(actor, {
          id: insertSuggestionId,
          from: safeTo,
          to: safeTo + insertedText.length,
          by: actor,
          updatedAt: Date.now(),
        });

        newTr.setSelection(TextSelection.create(newTr.doc, safeTo + insertedText.length));
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
      const rawSlice = (step as { slice?: unknown }).slice;

      const docSize = newTr.doc.content.size;
      const safeFrom = Math.max(0, Math.min(from, docSize));
      const safeTo = Math.max(safeFrom, Math.min(to, docSize));

      if (sliceRepresentsWrappedPlainText(slice?.content) && rawSlice && slice?.content?.some((node) => node.type === 'paragraph' || node.type === 'hard_break')) {
        const structuredPlainTextResult = applyStructuredPlainTextSuggestion(
          newTr,
          metadata,
          safeFrom,
          safeTo,
          actor,
          suggestionType,
          rawSlice,
        );
        if (structuredPlainTextResult.handled) {
          metadataChanged = metadataChanged || structuredPlainTextResult.metadataChanged;
          metadata = structuredPlainTextResult.metadata;
          writeOffset += structuredPlainTextResult.writeOffsetDelta;
          continue;
        }
      }

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

        // Check for coalesce candidate BEFORE the delete mark cursor skip.
        // When the cursor is at a delete mark boundary during an active
        // replacement coalesce (e.g. typing "Changed alpha." over selected
        // text), the coalesce path must take priority. The delete mark cursor
        // skip would create a NEW insert mark past the delete, breaking
        // mark continuity in the Y.XmlFragment and causing interleaved
        // markdown serialization (Bug 2: "Changed Alpha normal.alpha."
        // instead of "Changed alpha.Alpha normal.").
        let candidate = getCoalescableInsertCandidate(newTr.doc, metadata, safeFrom, actor, now);

        // Delete mark cursor skip: if the insertion position is at the left
        // boundary of a delete suggestion AND there's no active coalesce,
        // move it past the delete so new text appears after the deletion
        // rather than being trapped before it.
        // This runs in wrapTransactionForSuggestions (not just handleTextInput)
        // so it also catches DOM-observer-driven input from CGEvent keystrokes.
        if (!candidate && safeFrom === safeTo) {
          try {
            const $insPos = newTr.doc.resolve(safeFrom);
            const afterNode = $insPos.nodeAfter;
            if (afterNode?.isText) {
              const delMark = afterNode.marks.find((m: any) =>
                m.type.name === 'proofSuggestion'
                && normalizeSuggestionKind(m.attrs.kind) === 'delete'
              );
              if (delMark && typeof delMark.attrs.id === 'string') {
                const delRange = resolveLiveDeleteSuggestionRange(newTr.doc, delMark.attrs.id);
                if (delRange && delRange.from === safeFrom) {
                  console.log('[suggestions.deleteMarkCursorSkip]', {
                    from: safeFrom,
                    skipTo: delRange.to,
                    deleteId: delMark.attrs.id,
                  });
                  // Adjust insertion: insert text, then move it past the delete mark.
                  // We do this by changing the insertion position in the newTr.
                  const skipTo = Math.min(delRange.to, newTr.doc.content.size);
                  newTr.insertText(insertedText, skipTo);
                  const suggestionId = generateMarkId();
                  const createdAt = new Date().toISOString();
                  newTr.addMark(
                    skipTo,
                    skipTo + insertedText.length,
                    suggestionType.create({ id: suggestionId, kind: 'insert', by: actor }),
                  );
                  writeOffset += insertedText.length;
                  metadata = {
                    ...metadata,
                    [suggestionId]: {
                      ...buildSuggestionMetadata('insert', actor, insertedText, createdAt),
                      ...buildCollapsedInsertAnchorMetadata(skipTo),
                    },
                  };
                  metadataChanged = true;
                  lastInsertByActor.set(actor, {
                    id: suggestionId,
                    from: skipTo,
                    to: skipTo + insertedText.length,
                    by: actor,
                    updatedAt: Date.now(),
                  });
                  setSelectionAfterInsertedText(newTr, skipTo + insertedText.length);
                  // Skip to next step — this insertion is handled
                  continue;
                }
              }
            }
          } catch { /* fall through to normal insertion logic */ }
        }

        // Whitespace gap repair: if the candidate lookup failed but the cache
        // says the mark should extend to the cursor, and the gap between the
        // live mark end and the cursor is whitespace, re-apply the mark to the
        // gap. This fixes mark fragmentation caused by non-inclusive marks
        // losing their whitespace boundary between dispatch cycles.
        if (!candidate) {
          const cached = lastInsertByActor.get(actor);
          if (cached && cached.to === safeFrom && (now - cached.updatedAt) <= COALESCE_WINDOW_MS) {
            const liveRange = resolveLiveInsertSuggestionRange(newTr.doc, cached.id);
            if (liveRange && liveRange.to < safeFrom) {
              const gapText = newTr.doc.textBetween(liveRange.to, safeFrom, '');
              if (gapText.length > 0 && isWhitespaceOnly(gapText)) {
                logVerboseInsertRepair('[suggestions.whitespaceGapRepair]', {
                  cachedId: cached.id,
                  liveRange,
                  gapFrom: liveRange.to,
                  gapTo: safeFrom,
                  gapText,
                });
                // Re-apply the suggestion mark to the whitespace gap
                newTr.addMark(
                  liveRange.to,
                  safeFrom,
                  suggestionType.create({ id: cached.id, kind: 'insert', by: actor }),
                );
                // Retry candidate lookup against repaired document
                candidate = getCoalescableInsertCandidate(newTr.doc, metadata, safeFrom, actor, now);
              }
            }
          }
        }

        if (candidate && whitespaceOnly) {
          // Whitespace with active candidate: extend the mark to include it.
          // This keeps "Proof is" as one suggestion instead of splitting at the space.
          logVerboseInsertRepair('[suggestions.insertDecision]', {
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

          // FIX16: Replace entire insert range with a single text node.
          // insertText+addMark creates a new Y.Text CRDT item at the mark
          // boundary (inclusive:false) that never merges with adjacent items,
          // even after format(). replaceWith deletes old fragmented items and
          // inserts one contiguous item, preventing canonical interleaving.
          {
            const rangeText = newTr.doc.textBetween(candidate.range.from, candidate.range.to);
            const fullText = candidate.direction === 'append'
              ? rangeText + insertedText
              : insertedText + rangeText;
            const mark = suggestionType.create({ id: candidate.id, kind: 'insert', by: actor });
            newTr.replaceWith(
              candidate.range.from,
              candidate.range.to,
              newTr.doc.type.schema.text(fullText, [mark])
            );
          }
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
          logVerboseInsertRepair('[suggestions.insertDecision]', {
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

          // FIX16: Same replaceWith approach — see coalesce-whitespace comment.
          {
            const rangeText = newTr.doc.textBetween(candidate.range.from, candidate.range.to);
            const fullText = candidate.direction === 'append'
              ? rangeText + insertedText
              : insertedText + rangeText;
            const mark = suggestionType.create({ id: candidate.id, kind: 'insert', by: actor });
            newTr.replaceWith(
              candidate.range.from,
              candidate.range.to,
              newTr.doc.type.schema.text(fullText, [mark])
            );
          }
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
            logVerboseInsertRepair('[suggestions.insertDecision]', {
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
            const materialized = materializeInsertSuggestionAsSingleTextNode(
              newTr,
              editableInsert.id,
              actor,
              suggestionType,
              authoredType,
            );
            newTr = materialized.tr;
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

            const updatedRange = materialized.range ?? {
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
            logVerboseInsertRepair('[suggestions.insertDecision]', {
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
            logVerboseInsertRepair('[suggestions.insertDecision]', {
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
  const pluginEnabled = pluginState?.enabled ?? false;
  return pluginEnabled || suggestionsModuleEnabled || suggestionsDesiredEnabled;
}

/** Check the underlying ProseMirror suggestions plugin state only. */
export function isSuggestionsPluginEnabled(state: EditorState): boolean {
  const pluginState = suggestionsPluginKey.getState(state);
  return pluginState?.enabled ?? false;
}

/**
 * Enable suggestions
 */
export function enableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {
  suggestionsDesiredEnabled = true;
  suggestionsModuleEnabled = true;
  resetSuggestionsInsertCoalescing();
  const tr = view.state.tr.setMeta(suggestionsPluginKey, { enabled: true });
  view.dispatch(tr);
}

/**
 * Disable suggestions
 */
export function disableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {
  suggestionsDesiredEnabled = false;
  suggestionsModuleEnabled = false;
  resetSuggestionsInsertCoalescing();
  const tr = view.state.tr.setMeta(suggestionsPluginKey, { enabled: false });
  // Clear stored marks containing proofSuggestion to prevent mark leakage
  // into the next character typed with TC off
  const suggestionType = view.state.schema.marks.proofSuggestion;
  if (suggestionType) {
    const storedMarks = view.state.storedMarks ?? view.state.selection.$from.marks();
    if (storedMarks.some((m) => m.type === suggestionType)) {
      tr.setStoredMarks(storedMarks.filter((m) => m.type !== suggestionType));
    }
  }
  view.dispatch(tr);
}

/**
 * Toggle suggestions
 */
export function toggleSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): boolean {
  const pluginEnabled = isSuggestionsPluginEnabled(view.state);
  const enabled = pluginEnabled || suggestionsModuleEnabled || suggestionsDesiredEnabled;
  console.log('[suggestions.toggleSuggestions]', {
    pluginEnabled,
    suggestionsModuleEnabled,
    suggestionsDesiredEnabled,
    willDisable: enabled,
  });
  if (enabled) {
    disableSuggestions(view);
  } else {
    enableSuggestions(view);
  }
  return !enabled;
}

export const suggestionsPasteBridgePlugin = $prose(() => {
  return new Plugin({
    props: {
      handlePaste(view, event, slice) {
        return dispatchTrackedSuggestionPaste(view, event, slice);
      },
    },
  });
});

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
          const next = { ...value, ...meta };
          if (next.enabled !== value.enabled) {
            console.log('[suggestions.pluginState.transition]', {
              from: value.enabled,
              to: next.enabled,
              docChanged: tr.docChanged,
            });
          }
          return next;
        }
        return value;
      },
    },

    appendTransaction(trs, oldState, newState) {
      const wasEnabled = suggestionsPluginKey.getState(oldState)?.enabled ?? false;
      const isEnabled = suggestionsPluginKey.getState(newState)?.enabled ?? false;
      const hasHistoryChange = trs.some((tr) => tr.getMeta('history$') !== undefined);
      const hasUndoHistoryChange = trs.some((tr) => isUndoHistoryTransaction(tr));
      if (wasEnabled !== isEnabled) {
        // Emit bridge message on next microtask to avoid dispatch-in-dispatch
        queueMicrotask(() => {
          (window as any).proof?.bridge?.sendMessage('suggestionsChanged', { enabled: isEnabled });
        });
      }

      // Use module flag as fallback — catches cases where plugin state
      // reads return stale data in the dispatch interceptor
      const effectivelyDisabled = !isEnabled && !suggestionsModuleEnabled && !suggestionsDesiredEnabled;
      if (effectivelyDisabled) {
        const hasExplicitDisable = trs.some((tr) => {
          const meta = tr.getMeta(suggestionsPluginKey) as { enabled?: unknown } | undefined;
          return Boolean(meta && typeof meta === 'object' && !Array.isArray(meta) && meta.enabled === false);
        });
        const disabledInsertedCleanupTr = buildDisabledInsertedSuggestionCleanupTransaction(oldState, newState);
        if (disabledInsertedCleanupTr) {
          console.log('[suggestions.appendTransaction.tcOffInsertedCleanup]', {
            from: disabledInsertedCleanupTr.selection.from,
            to: disabledInsertedCleanupTr.selection.to,
            transactions: summarizeAppendTransactionsForDebug(trs),
          });
          return disabledInsertedCleanupTr;
        }
        // When TC is off, strip any suggestion marks that leaked onto new content.
        // We check ALL doc-changing transactions, including those marked as
        // 'suggestions-wrapped' — if TC is off, wrapped marks are leaks too.
        if (trs.some((tr) => tr.docChanged && !tr.getMeta('document-load'))) {
          const suggestionType = newState.schema.marks.proofSuggestion;
          if (suggestionType) {
            const diff = oldState.doc.content.findDiffStart(newState.doc.content);
            if (typeof diff === 'number') {
              const diffEnd = oldState.doc.content.findDiffEnd(newState.doc.content);
              if (diffEnd && diffEnd.b > diff) {
                let hasLeakedMark = false;
                newState.doc.nodesBetween(diff, diffEnd.b, (node) => {
                  if (!node.isText) return true;
                  if (node.marks.some((m) => m.type === suggestionType)) hasLeakedMark = true;
                  return !hasLeakedMark;
                });
                if (hasLeakedMark) {
                  const stripAnalysis = analyzeDisabledSuggestionStripDecision(
                    oldState.doc,
                    newState.doc,
                    { from: diff, to: diffEnd.a },
                    { from: diff, to: diffEnd.b },
                  );
                  if (hasHistoryChange) {
                    console.log('[suggestions.appendTransaction.historyRestoreEnable]', {
                      diff,
                      diffEndA: diffEnd.a,
                      diffEndB: diffEnd.b,
                      isEnabled,
                      suggestionsModuleEnabled,
                      suggestionsDesiredEnabled,
                      hasExplicitDisable,
                      stripAnalysis,
                      transactions: summarizeAppendTransactionsForDebug(trs),
                    });
                    suggestionsModuleEnabled = true;
                    const tr = newState.tr
                      .setMeta(suggestionsPluginKey, { enabled: true })
                      .setMeta('addToHistory', false);
                    tr.setMeta('suggestions-wrapped', true);
                    return tr;
                  }
                  if (!stripAnalysis.shouldStrip) {
                    console.log('[suggestions.appendTransaction.tcOffStripSkip]', {
                      diff,
                      diffEndA: diffEnd.a,
                      diffEndB: diffEnd.b,
                      isEnabled,
                      suggestionsModuleEnabled,
                      suggestionsDesiredEnabled,
                      hasExplicitDisable,
                      stripAnalysis,
                      hadWrappedTr: trs.some((tr) => tr.getMeta('suggestions-wrapped')),
                      transactions: summarizeAppendTransactionsForDebug(trs),
                    });
                    return null;
                  }
                  console.log('[suggestions.appendTransaction.tcOffStrip]', {
                    diff,
                    diffEndA: diffEnd.a,
                    diffEndB: diffEnd.b,
                    isEnabled,
                    suggestionsModuleEnabled,
                    suggestionsDesiredEnabled,
                    hasExplicitDisable,
                    stripAnalysis,
                    hadWrappedTr: trs.some((tr) => tr.getMeta('suggestions-wrapped')),
                    transactions: summarizeAppendTransactionsForDebug(trs),
                  });
                  const introducedIds = [
                    ...stripAnalysis.introducedSummary.insertIds,
                    ...stripAnalysis.introducedSummary.deleteIds,
                    ...stripAnalysis.introducedSummary.replaceIds,
                  ];
                  const tr = removeSuggestionIdsFromRange(
                    newState.tr,
                    newState.doc,
                    diff,
                    diffEnd.b,
                    suggestionType,
                    introducedIds,
                  );
                  if (tr.steps.length === 0) return null;
                  tr.setMeta('suggestions-wrapped', true);
                  return tr;
                }
              }
            }
          }
        }
        // Also clear stored marks when TC is off — prevents proofSuggestion from
        // leaking onto the next typed character via ProseMirror's stored marks
        const storedMarks = newState.storedMarks;
        if (storedMarks?.some((m) => m.type.name === 'proofSuggestion')) {
          console.log('[suggestions.appendTransaction.clearStoredMarks]', {
            storedMarkTypes: storedMarks.map((m) => m.type.name),
            suggestionsModuleEnabled,
          });
          const tr = newState.tr.setStoredMarks(
            storedMarks.filter((m) => m.type.name !== 'proofSuggestion'),
          );
          tr.setMeta('suggestions-wrapped', true);
          return tr;
        }
        return null;
      }
      if (!trs.some((tr) => tr.docChanged)) return null;
      const hasWrappedSuggestionTransaction = trs.some((tr) => tr.getMeta('suggestions-wrapped'));
      const hasNativeTypedInputPassthrough = trs.some((tr) => tr.getMeta('proof-native-typed-input') === true);
      const nativeTypedInputMatch = trs
        .map((tr) => getNativeTextInputMatchMeta(tr))
        .find((match): match is NativeTextInputMatch => match !== null)
        ?? null;
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
      if (hasNativeTypedInputPassthrough) {
        if (nativeTypedInputMatch) {
          const nativeWrapTr = buildNativeTextInputFollowupWrapTransaction(
            oldState,
            newState,
            nativeTypedInputMatch,
          );
          if (nativeWrapTr) {
            nativeWrapTr.setMeta('addToHistory', false);
            console.log('[suggestions.appendTransactionNativeTextInputWrap]', {
              from: nativeTypedInputMatch.from,
              to: nativeTypedInputMatch.to,
              text: nativeTypedInputMatch.text,
              beforeRangeText: newState.doc.textBetween(
                nativeTypedInputMatch.from,
                nativeTypedInputMatch.to,
                '\n',
                '\n',
              ),
              afterRangeText: nativeWrapTr.doc.textBetween(
                nativeTypedInputMatch.from,
                nativeTypedInputMatch.to,
                '\n',
                '\n',
              ),
              beforeRangeMarks: summarizeTextMarksInRange(
                newState.doc,
                nativeTypedInputMatch.from,
                nativeTypedInputMatch.to,
              ),
              afterRangeMarks: summarizeTextMarksInRange(
                nativeWrapTr.doc,
                nativeTypedInputMatch.from,
                nativeTypedInputMatch.to,
              ),
              stepTypes: nativeWrapTr.steps.map((step) => {
                const stepJson = step.toJSON() as { stepType?: string };
                return stepJson.stepType ?? step.constructor.name;
              }),
            });
            return nativeWrapTr;
          }
        }
        return null;
      }
      if (hasUndoHistoryChange) {
        const historyMetadataReconcileTr = buildHistorySuggestionMetadataReconciliationTransaction(
          oldState,
          newState,
        );
        if (historyMetadataReconcileTr) {
          return historyMetadataReconcileTr;
        }
      }
      if (trs.some((tr) =>
        tr.getMeta('document-load') !== undefined
        || tr.getMeta('history$') !== undefined
        || isExplicitYjsChangeOriginTransaction(tr)
      ) || hasBlockingMarksMeta) {
        return null;
      }

      if (shouldRunTextPreservingInsertPersistenceFallback(trs, { hasRemoteSuggestionInsert })) {
        const persistenceFallbackTr = buildTextPreservingInsertPersistenceTransaction(oldState, newState);
        if (persistenceFallbackTr) {
          console.log('[suggestions.appendTransactionPersistenceFallback]', {
            from: persistenceFallbackTr.selection.from,
            to: persistenceFallbackTr.selection.to,
          });
          return persistenceFallbackTr;
        }
      }

      const splitMergeTr = buildAdjacentSplitInsertMergeTransaction(oldState, newState);
      if (splitMergeTr) {
        console.log('[suggestions.appendTransactionSplitMerge]', {
          from: splitMergeTr.selection.from,
          to: splitMergeTr.selection.to,
        });
        return splitMergeTr;
      }

      if (hasWrappedSuggestionTransaction || hasRemoteSuggestionInsert) {
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
      handlePaste(view, event, slice) {
        return dispatchTrackedSuggestionPaste(view, event, slice);
      },

      handleDOMEvents: {
        beforeinput(view, event) {
          const inputEvent = event as InputEvent;

          if (inputEvent.inputType === 'historyUndo') {
            if (!isSuggestionsEnabled(view.state)) return false;
            if (attemptTrackChangesUndo(view, 'beforeinput')) {
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
            return false;
          }

          // Handle insertParagraph (Enter key) regardless of TC state so the
          // track changes guard can block unsupported structural splits before
          // ProseMirror's default splitBlock path runs.
          if (inputEvent.inputType === 'insertParagraph') {
            const { state } = view;
            const { from } = state.selection;
            const $from = state.doc.resolve(from);
            const enabled = isSuggestionsEnabled(state);

            // Code blocks: insert literal newline
            if ($from.parent.type.name === 'code_block') {
              view.dispatch(state.tr.insertText('\n', from, from));
              event.preventDefault();
              return true;
            }

            if (enabled && shouldSuppressStructuralParagraphSplit(state)) {
              console.log('[suggestions.beforeinput.insertParagraph.suppressed]', {
                from,
                enabled,
                depth: $from.depth,
                reason: 'structural-paragraph-split',
              });
              event.preventDefault();
              event.stopPropagation();
              return true;
            }

            const tr = state.tr.split(from);
            if (!tr.docChanged) return false;

            console.log('[suggestions.beforeinput.insertParagraph.split]', {
              from,
              enabled,
              depth: $from.depth,
            });
            view.dispatch(tr);
            event.preventDefault();
            return true;
          }

          if (!isSuggestionsEnabled(view.state)) return false;
          if (view.composing) return false;
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

          const domSelectionRange = getLiveDomSelectionRange(view);
          if (shouldSuppressStructuralBoundaryDelete(view.state, intent.key, intent.modifiers, domSelectionRange)) {
            console.log('[suggestions.beforeinput.delete.suppressed]', {
              inputType: inputEvent.inputType ?? null,
              intent,
              reason: 'structural-boundary-delete',
              stateSelection: {
                from: view.state.selection.from,
                to: view.state.selection.to,
                empty: view.state.selection.empty,
              },
            });
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
          console.log('[suggestions.beforeinput.delete]', {
            inputType: inputEvent.inputType ?? null,
            pendingIntent: pendingIntent?.intent ?? null,
            intent,
            domSelectionText: view.dom.ownerDocument?.getSelection?.()?.toString() ?? '',
            domSelectionRange,
            stateSelection: {
              from: view.state.selection.from,
              to: view.state.selection.to,
              empty: view.state.selection.empty,
            },
          });
          const range = __debugResolveTrackedDeleteRange(
            view.state,
            intent.key,
            intent.modifiers,
            domSelectionRange,
          );
          if (!range || range.to <= range.from) {
            console.log('[suggestions.beforeinput.delete.no-range]', {
              inputType: inputEvent.inputType ?? null,
              intent,
              domSelectionRange,
            });
            return false;
          }

          event.preventDefault();
          const deleteTr = view.state.tr.delete(range.from, range.to);
          if (domSelectionRange && domSelectionRange.from < domSelectionRange.to) {
            deleteTr.setMeta('proof-dom-selection-range', domSelectionRange);
          }
          console.log('[suggestions.beforeinput.delete.dispatch]', {
            range,
            rangeText: view.state.doc.textBetween(range.from, range.to, '', ''),
            carriesDomSelectionMeta: Boolean(domSelectionRange && domSelectionRange.from < domSelectionRange.to),
          });
          view.dispatch(deleteTr);
          return true;
        },
      },

      handleTextInput(view, from, to, text) {
        const enabled = isSuggestionsEnabled(view.state);
        const resolvedRange = resolveTrackedTextInputRange(view.state, from, to);
        console.log('[suggestions.handleTextInput]', {
          enabled,
          from,
          to,
          resolvedFrom: resolvedRange.from,
          resolvedTo: resolvedRange.to,
          text,
          trackChangesView: view.dom?.dataset?.trackChangesView ?? null,
        });
        if (!enabled) return false;
        if (!text) return false;
        rememberPendingNativeTextInput(text, resolvedRange.from, resolvedRange.to);
        // Do not dispatch tracked inserts from handleTextInput.
        // In the live browser/runtime, this hook fires after the native
        // contenteditable insertion is already in motion, so dispatching here
        // produces a second character. Let ProseMirror emit its default
        // transaction and let the suggestions interceptor / appendTransaction
        // wrap that plain insertion into a tracked insert suggestion.
        return false;
      },

      handleKeyDown(view, event) {
        // Diagnostic: log Enter key events regardless of TC state
        if (event.key === 'Enter') {
          const enabled = isSuggestionsEnabled(view.state);
          console.log('[suggestions.handleKeyDown.enter]', {
            enabled,
            from: view.state.selection.from,
            defaultPrevented: event.defaultPrevented,
            composing: event.isComposing || view.composing,
          });
        }

        if (event.key === 'Backspace' || event.key === 'Delete') {
          console.log('[suggestions.handleKeyDown.delete]', {
            key: event.key,
            enabled: isSuggestionsEnabled(view.state),
            defaultPrevented: event.defaultPrevented,
            composing: event.isComposing || view.composing,
            modifiers: {
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey,
            },
            domSelectionText: view.dom.ownerDocument?.getSelection?.()?.toString() ?? '',
            stateSelection: {
              from: view.state.selection.from,
              to: view.state.selection.to,
              empty: view.state.selection.empty,
            },
          });
        }

        if (!isSuggestionsEnabled(view.state)) return false;
        if (event.defaultPrevented || event.isComposing || view.composing) return false;

        const normalizedKey = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && normalizedKey === 'z') {
          if (attemptTrackChangesUndo(view, 'keydown')) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
          return false;
        }

        // Block unsupported paragraph splits while TC is enabled. Code blocks
        // still receive literal newline insertion.
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
          const { state } = view;
          const { from } = state.selection;
          const $from = state.doc.resolve(from);

          // Code blocks: insert literal newline, not paragraph split
          if ($from.parent.type.name === 'code_block') {
            view.dispatch(state.tr.insertText('\n', from, from));
            return true;
          }

          if (shouldSuppressStructuralParagraphSplit(state)) {
            console.log('[suggestions.handleKeyDown.enter.suppressed]', {
              from,
              depth: $from.depth,
              parentType: $from.parent.type.name,
              reason: 'structural-paragraph-split',
            });
            event.preventDefault();
            event.stopPropagation();
            return true;
          }

          console.log('[suggestions.handleKeyDown.enter.split]', {
            from,
            depth: $from.depth,
            parentType: $from.parent.type.name,
          });
          return false;
        }

        if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
        if (shouldSuppressTrackChangesKeydown(event)) {
          console.log('[suggestions.handleKeyDown.delete.suppressed]', {
            key: event.key,
            reason: 'guarded-modifier-delete',
          });
          rememberModifiedDeleteIntent(view, event, { handled: true });
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
        if (shouldSuppressStructuralBoundaryDelete(view.state, event.key, {
          altKey: event.altKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
        })) {
          console.log('[suggestions.handleKeyDown.delete.suppressed]', {
            key: event.key,
            reason: 'structural-boundary-delete',
          });
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
          if (!range || range.to <= range.from) {
            console.log('[suggestions.handleKeyDown.delete.no-range]', {
              key: event.key,
              branch: 'modified',
            });
            return false;
          }

          rememberModifiedDeleteIntent(view, event, { handled: true });
          event.preventDefault();
          event.stopPropagation();
          console.log('[suggestions.handleKeyDown.delete.dispatch]', {
            key: event.key,
            branch: 'modified',
            range,
            rangeText: view.state.doc.textBetween(range.from, range.to, '', ''),
          });
          view.dispatch(view.state.tr.delete(range.from, range.to));
          return true;
        }
        if (event.metaKey) return false;

        const range = __debugResolveTrackedDeleteRange(view.state, event.key, {
          altKey: event.altKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
        });
        if (!range || range.to <= range.from) {
          console.log('[suggestions.handleKeyDown.delete.no-range]', {
            key: event.key,
            branch: 'plain',
          });
          return false;
        }

        event.preventDefault();
        console.log('[suggestions.handleKeyDown.delete.dispatch]', {
          key: event.key,
          branch: 'plain',
          range,
          rangeText: view.state.doc.textBetween(range.from, range.to, '', ''),
        });
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
