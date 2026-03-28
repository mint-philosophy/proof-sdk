/**
 * Suggestions Plugin for Milkdown
 *
 * Converts edits into proofSuggestion marks + PROOF metadata
 * when suggestions mode is enabled.
 */

import { $ctx, $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { Mark, MarkType, Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
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

// Word-style track changes should keep a contiguous typing run together even when
// the user pauses briefly between keystrokes. A slightly longer window also makes
// browser automation reflect real authoring behavior instead of splitting every key.
const COALESCE_WINDOW_MS = 5000;
const DEBUG_VERBOSE_INSERT_REPAIR = false;
const HANDLED_TEXT_INPUT_ECHO_TTL_MS = 250;
const DUPLICATE_HANDLED_TEXT_INPUT_CALL_TTL_MS = 75;
const PENDING_NATIVE_TEXT_INPUT_TTL_MS = 250;
const HANDLED_TEXT_INPUT_META = 'proof-handled-text-input';

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
    const $pos = state.doc.resolve(from);
    const nodeAfter = $pos.nodeAfter;
    if (nodeAfter?.isText) {
      const deleteMark = nodeAfter.marks.find((m) =>
        m.type.name === 'proofSuggestion'
        && normalizeSuggestionKind(m.attrs.kind) === 'delete'
      );
      if (deleteMark && typeof deleteMark.attrs.id === 'string') {
        const deleteRange = resolveLiveDeleteSuggestionRange(state.doc, deleteMark.attrs.id);
        if (deleteRange && deleteRange.from === from) {
          return { from: deleteRange.to, to: deleteRange.to };
        }
      }
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
  if (node.type === 'paragraph') {
    return Array.isArray(node.content) && node.content.length > 0 && node.content.every((child) => sliceNodeIsWrappedPlainText(child));
  }
  return false;
}

function sliceRepresentsWrappedPlainText(nodes?: SliceNode[]): boolean {
  if (!nodes || nodes.length !== 1) return false;
  return sliceNodeIsWrappedPlainText(nodes[0]);
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
  if (!pendingNativeTextInput) return false;
  const age = Date.now() - pendingNativeTextInput.at;
  if (age > PENDING_NATIVE_TEXT_INPUT_TTL_MS) {
    pendingNativeTextInput = null;
    return false;
  }

  const diff = detectPlainTextInsertionBetweenDocs(oldState.doc, tr.doc);
  if (!diff) return false;

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
    return true;
  }

  pendingNativeTextInput = null;
  return false;
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

export function __debugShouldPassthroughPendingNativeTextInputTransaction(
  oldState: EditorState,
  tr: Transaction,
): boolean {
  return shouldPassthroughPendingNativeTextInputTransaction(oldState, tr);
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
        const hasHistoryChange = trs.some((tr) => tr.getMeta('history$') !== undefined);
        const hasExplicitDisable = trs.some((tr) => {
          const meta = tr.getMeta(suggestionsPluginKey) as { enabled?: unknown } | undefined;
          return Boolean(meta && typeof meta === 'object' && !Array.isArray(meta) && meta.enabled === false);
        });
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
      ) || hasBlockingMarksMeta) {
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
      handleDOMEvents: {
        beforeinput(view, event) {
          const inputEvent = event as InputEvent;

          // Handle insertParagraph (Enter key) regardless of TC state.
          // ProseMirror's default Enter→splitBlock path does not fire for all
          // input methods (CDP dispatchKeyEvent, programmatic input). Catching
          // insertParagraph in beforeinput ensures paragraph breaks work
          // regardless of how Enter arrives.
          if (inputEvent.inputType === 'insertParagraph') {
            const { state } = view;
            const { from } = state.selection;
            const $from = state.doc.resolve(from);

            // Code blocks: insert literal newline
            if ($from.parent.type.name === 'code_block') {
              view.dispatch(state.tr.insertText('\n', from, from));
              event.preventDefault();
              return true;
            }

            const tr = state.tr.split(from);
            if (tr.docChanged) {
              // If TC is on, strip suggestion marks from stored marks so the
              // new paragraph starts clean — handleTextInput adds fresh marks.
              const enabled = isSuggestionsEnabled(state);
              if (enabled) {
                const suggestionType = state.schema.marks.proofSuggestion;
                if (suggestionType) {
                  const currentStored = tr.storedMarks ?? $from.marks();
                  const clean = currentStored.filter((m: Mark) => m.type !== suggestionType);
                  tr.setStoredMarks(clean);
                }
              }
              console.log('[suggestions.beforeinput.insertParagraph.split]', {
                from,
                enabled,
                depth: $from.depth,
              });
              view.dispatch(tr);
              event.preventDefault();
              return true;
            }
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
        rememberPendingNativeTextInput(text, from, to);
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

        if (!isSuggestionsEnabled(view.state)) return false;
        if (event.defaultPrevented || event.isComposing || view.composing) return false;

        // Handle Enter explicitly when TC is on to create paragraph breaks.
        // ProseMirror's default Enter→splitBlock path does not fire reliably
        // under all input methods (CGEvent keystrokes, programmatic input).
        // Handling Enter here guarantees a clean paragraph split with proper
        // mark cleanup — the new paragraph starts without suggestion marks.
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
          const { state } = view;
          const { from } = state.selection;
          const $from = state.doc.resolve(from);

          // Code blocks: insert literal newline, not paragraph split
          if ($from.parent.type.name === 'code_block') {
            view.dispatch(state.tr.insertText('\n', from, from));
            return true;
          }

          // Create the paragraph split
          const tr = state.tr.split(from);
          if (!tr.docChanged) {
            // Split not possible at this position — fall through to default
            return false;
          }

          // Strip suggestion marks from stored marks so the new paragraph
          // starts without them. handleTextInput will add fresh marks when
          // the user types the next character.
          const suggestionType = state.schema.marks.proofSuggestion;
          if (suggestionType) {
            const currentStored = tr.storedMarks ?? $from.marks();
            const clean = currentStored.filter((m: Mark) => m.type !== suggestionType);
            tr.setStoredMarks(clean);
          }
          console.log('[suggestions.handleKeyDown.enter.split]', {
            from,
            depth: $from.depth,
            parentType: $from.parent.type.name,
          });
          view.dispatch(tr);
          return true;
        }

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
