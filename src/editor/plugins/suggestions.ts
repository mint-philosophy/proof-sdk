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
import { isYjsChangeOriginTransaction } from './transaction-origins';
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
  content?: SliceNode[];
};

// Word-style track changes should keep a contiguous typing run together even when
// the user pauses briefly between keystrokes. A slightly longer window also makes
// browser automation reflect real authoring behavior instead of splitting every key.
const COALESCE_WINDOW_MS = 5000;

type InsertCoalesceState = { id: string; from: number; to: number; by: string; updatedAt: number };
type TrackedDeleteIntent = { key: 'Backspace' | 'Delete'; modifiers?: { altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } };

const lastInsertByActor = new Map<string, InsertCoalesceState>();
const pendingModifiedDeleteIntents = new WeakMap<EditorView, { intent: TrackedDeleteIntent; at: number }>();
const PENDING_DELETE_INTENT_TTL_MS = 1500;

function normalizeSuggestionKind(kind: unknown): SuggestionKind {
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return kind;
  return 'replace';
}

function isWhitespaceOnly(text: string): boolean {
  return /^[\s\u00A0]+$/.test(text);
}

function resolveLiveSuggestionRange(
  doc: ProseMirrorNode,
  id: string,
  kind: 'insert' | 'delete'
): MarkRange | null {
  let from: number | null = null;
  let to: number | null = null;

  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const hasSuggestionMark = node.marks.some((mark) =>
      mark.type.name === 'proofSuggestion'
      && mark.attrs.id === id
      && normalizeSuggestionKind(mark.attrs.kind) === kind
    );
    if (!hasSuggestionMark) return true;
    if (from === null || pos < from) from = pos;
    const end = pos + node.nodeSize;
    if (to === null || end > to) to = end;
    return true;
  });

  if (from === null || to === null) return null;
  return { from, to };
}

function resolveLiveInsertSuggestionRange(
  doc: ProseMirrorNode,
  id: string
): MarkRange | null {
  return resolveLiveSuggestionRange(doc, id, 'insert');
}

function getLiveInsertSuggestionText(doc: ProseMirrorNode, id: string): string | null {
  const range = resolveLiveInsertSuggestionRange(doc, id);
  if (!range || range.to <= range.from) return null;
  return doc.textBetween(range.from, range.to, '', '');
}

function collectSuggestionIdsInRange(
  doc: ProseMirrorNode,
  kind: 'insert' | 'delete',
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
  const matches: Array<{ id: string; from: number; to: number }> = [];

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
      const range = resolveLiveInsertSuggestionRange(doc, id);
      if (!range) continue;
      matches.push({ id, from: range.from, to: range.to });
    }

    return true;
  });

  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    const aContains = pos >= a.from && pos <= a.to;
    const bContains = pos >= b.from && pos <= b.to;
    if (aContains !== bContains) return aContains ? -1 : 1;
    return (a.to - a.from) - (b.to - b.from);
  });

  const match = matches[0];
  const offset = Math.max(0, Math.min(pos - match.from, match.to - match.from));
  return {
    id: match.id,
    range: { from: match.from, to: match.to },
    offset,
  };
}

function syncInsertSuggestionMetadataFromDoc(
  doc: ProseMirrorNode,
  metadata: Record<string, StoredMark>,
  insertIds: string[]
): Record<string, StoredMark> {
  if (insertIds.length === 0) return metadata;

  let changed = false;
  const next = { ...metadata };

  for (const id of insertIds) {
    const existing = next[id];
    if (!existing || existing.kind !== 'insert') continue;

    const content = getLiveInsertSuggestionText(doc, id);
    if (!content) {
      delete next[id];
      changed = true;
      continue;
    }

    const range = resolveLiveInsertSuggestionRange(doc, id);
    const prevContent = typeof existing.content === 'string' ? existing.content : '';
    if (prevContent !== content || !range || existing.range?.from !== range.from || existing.range?.to !== range.to) {
      next[id] = {
        ...existing,
        content,
        ...(range ? { range: { from: range.from, to: range.to } } : {}),
      };
      changed = true;
    }
  }

  return changed ? next : metadata;
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

      const deleteRange = resolveLiveSuggestionRange(doc, id, 'delete');
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
  });
}

function takePendingModifiedDeleteIntent(view: EditorView): TrackedDeleteIntent | null {
  const entry = pendingModifiedDeleteIntents.get(view);
  if (!entry) return null;
  pendingModifiedDeleteIntents.delete(view);
  if (Date.now() - entry.at > PENDING_DELETE_INTENT_TTL_MS) return null;
  return entry.intent;
}

export function __debugResolveTrackedDeleteIntentForBeforeInput(
  inputType: string,
  pendingIntent: TrackedDeleteIntent | null,
): TrackedDeleteIntent | null {
  const mappedIntent = __debugResolveTrackedDeleteIntentFromBeforeInput(inputType);
  if (!pendingIntent) return mappedIntent;
  if (mappedIntent && mappedIntent.key !== pendingIntent.key) return mappedIntent;
  return pendingIntent;
}

function shouldIgnoreTrackedDeleteIntent(
  intent: TrackedDeleteIntent | null,
): boolean {
  return Boolean(
    intent
      && intent.key === 'Backspace'
      && intent.modifiers?.metaKey
      && !intent.modifiers?.altKey
      && !intent.modifiers?.ctrlKey,
  );
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
  if (isYjsChangeOriginTransaction(tr)) {
    return tr;
  }

  const suggestionType = state.schema.marks.proofSuggestion;

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
        } else if (candidate) {
          // Non-whitespace with active candidate: coalesce into existing mark
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
        } else {
          const editableInsert = findEditableInsertSuggestionAtPosition(newTr.doc, safeFrom, actor);
          if (editableInsert) {
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
          } else if (whitespaceOnly) {
            // Standalone whitespace, no active candidate: create a tracked suggestion mark.
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
          } else {
            // New non-whitespace text, no candidate: create fresh suggestion mark
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
  const tr = view.state.tr.setMeta(suggestionsPluginKey, { enabled: true });
  view.dispatch(tr);
}

/**
 * Disable suggestions
 */
export function disableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {
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

    appendTransaction(_trs, oldState, newState) {
      const wasEnabled = suggestionsPluginKey.getState(oldState)?.enabled ?? false;
      const isEnabled = suggestionsPluginKey.getState(newState)?.enabled ?? false;
      if (wasEnabled !== isEnabled) {
        // Emit bridge message on next microtask to avoid dispatch-in-dispatch
        queueMicrotask(() => {
          (window as any).proof?.bridge?.sendMessage('suggestionsChanged', { enabled: isEnabled });
        });
      }
      return null;
    },

    props: {
      handleDOMEvents: {
        beforeinput(view, event) {
          if (!isSuggestionsEnabled(view.state)) return false;
          if (view.composing) return false;
          const inputEvent = event as InputEvent;
          const intent = __debugResolveTrackedDeleteIntentForBeforeInput(
            inputEvent.inputType ?? '',
            takePendingModifiedDeleteIntent(view),
          );
          if (!intent) return false;
          if (shouldIgnoreTrackedDeleteIntent(intent)) {
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
        if (!isSuggestionsEnabled(view.state)) return false;
        if (!text || view.composing) return false;
        view.dispatch(view.state.tr.insertText(text, from, to));
        return true;
      },

      handleKeyDown(view, event) {
        if (!isSuggestionsEnabled(view.state)) return false;
        if (event.defaultPrevented || event.isComposing || view.composing) return false;
        if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
        rememberModifiedDeleteIntent(view, event);
        if (event.key === 'Backspace' && event.metaKey && !event.altKey && !event.ctrlKey) {
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
        if (event.altKey || event.metaKey || event.ctrlKey) return false;

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
