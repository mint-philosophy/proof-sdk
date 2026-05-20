/**
 * Suggestions Plugin for Milkdown
 *
 * Converts edits into proofSuggestion marks + PROOF metadata
 * when suggestions mode is enabled.
 */

import { $ctx, $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { MarkType, Node as ProseMirrorNode } from '@milkdown/kit/prose/model';

import { marksPluginKey, getMarkMetadata, buildSuggestionMetadata, getMarks } from './marks';
import { generateMarkId, type InsertData, type MarkRange } from '../../formats/marks';
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

const COALESCE_WINDOW_MS = 750;

type InsertCoalesceState = { id: string; from: number; to: number; by: string; updatedAt: number };

const lastInsertByActor = new Map<string, InsertCoalesceState>();

function normalizeSuggestionKind(kind: unknown): SuggestionKind {
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return kind;
  return 'replace';
}

function isWhitespaceOnly(text: string): boolean {
  return /^[\s\u00A0]+$/.test(text);
}

function getCoalescableInsertCandidate(
  state: EditorState,
  pos: number,
  by: string,
  now: number
): { id: string; range: MarkRange; direction: 'append' | 'prepend' } | null {
  const cached = lastInsertByActor.get(by);
  if (!cached) return null;
  if (now - cached.updatedAt > COALESCE_WINDOW_MS) {
    lastInsertByActor.delete(by);
    return null;
  }

  const marks = getMarks(state);
  const match = marks.find(mark => mark.id === cached.id && mark.kind === 'insert' && mark.by === by);
  if (!match || !match.range) {
    lastInsertByActor.delete(by);
    return null;
  }

  const data = match.data as InsertData | undefined;
  if (data?.status && data.status !== 'pending') {
    lastInsertByActor.delete(by);
    return null;
  }

  if (match.range.to === pos) {
    return { id: match.id, range: match.range, direction: 'append' };
  }

  if (match.range.from === pos) {
    return { id: match.id, range: match.range, direction: 'prepend' };
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
  const __dbg = (window as any).__suggestionDebug !== false;
  const __log = (...args: any[]) => {
    if (__dbg) {
      try {
        (window as any).__suggestionTrace = (window as any).__suggestionTrace || [];
        (window as any).__suggestionTrace.push({ t: Date.now(), args: args.map(a => {
          if (typeof a === 'object') {
            try { return JSON.parse(JSON.stringify(a)); } catch { return String(a); }
          }
          return a;
        }) });
        if ((window as any).__suggestionTrace.length > 200) (window as any).__suggestionTrace.shift();
      } catch {}
    }
  };
  __log('wrap.enter', {
    enabled,
    docChanged: tr.docChanged,
    selBefore: { from: state.selection.from, to: state.selection.to },
    selAfter: { from: tr.selection.from, to: tr.selection.to },
    stepsCount: tr.steps.length,
    stepTypes: tr.steps.map(s => (s.toJSON() as any).stepType),
  });
  if (!enabled || !tr.docChanged) {
    return tr;
  }
  if (tr.getMeta('y-sync$')) {
    return tr;
  }

  // SANITY DEBUG: pass through to confirm the wrap mechanism itself is the problem.
  if ((window as any).__suggestionsPassthrough) {
    __log('wrap.passthrough', { reason: 'window.__suggestionsPassthrough is set' });
    return tr;
  }

  // Pure-insert and structural-change paths are now handled by passing the
  // user's original transaction through unchanged. The plugin's view.update
  // (below) detects text inserts and adds a suggestion mark in a deferred
  // dispatch, which keeps ProseMirror's caret/focus bookkeeping intact.
  // Rebuilding the input transaction via `state.tr.step(...)` causes PM to
  // silently drop the dispatch (focus loss verified against
  // window.__suggestionsPassthrough), so we only rebuild for transactions we
  // truly need to transform (delete/replace tracking, handled further down).
  const isSimpleUserInput = (() => {
    if (state.selection.from !== state.selection.to) return false;
    if (tr.selection.from !== tr.selection.to) return false;
    // Every step must be either a structural replace (paragraph split,
    // join, etc.) or a pure-insert replace at a collapsed cursor.
    for (const step of tr.steps) {
      const sj = step.toJSON() as { stepType?: string; from?: number; to?: number; slice?: { content?: SliceNode[] } };
      if (sj.stepType === 'replace') {
        if (sj.from !== sj.to) return false; // any selection-replace is not "simple"
        // collapsed cursor — pure insert. Text or structural is both OK.
        continue;
      }
      if (sj.stepType === 'replaceAround') {
        // paragraph splits, list wraps, etc. — let PM apply them as-is.
        continue;
      }
      return false;
    }
    return true;
  })();
  if (isSimpleUserInput) {
    __log('wrap.passthrough.simpleInput', {
      stepTypes: tr.steps.map(s => (s.toJSON() as any).stepType),
    });
    return tr;
  }

  const suggestionType = state.schema.marks.proofSuggestion;

  if (!suggestionType) {
    console.warn('[suggestions] Missing proofSuggestion mark type');
    return tr;
  }

  // (Insert fast-path was removed; pure inserts are now handled by the
  // plugin's appendTransaction so PM keeps owning the caret.)

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
          // Already tracked: accept deletion or reject insertion
          newTr.delete(safeFrom, safeTo);
          writeOffset -= deletedText.length;
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
        const candidate = getCoalescableInsertCandidate(state, safeFrom, actor, now);

        if (candidate && whitespaceOnly) {
          // Whitespace with active candidate: extend the mark to include it.
          // This keeps "Proof is" as one suggestion instead of splitting at the space.
          const existingMeta = metadata[candidate.id];
          const existingContent = typeof existingMeta?.content === 'string' ? existingMeta.content : '';
          const updatedContent = candidate.direction === 'append'
            ? `${existingContent}${insertedText}`
            : `${insertedText}${existingContent}`;

          newTr.insertText(insertedText, safeFrom);
          newTr.addMark(
            safeFrom,
            safeFrom + insertedText.length,
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

          newTr.insertText(insertedText, safeFrom);
          newTr.addMark(
            safeFrom,
            safeFrom + insertedText.length,
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
            [suggestionId]: buildSuggestionMetadata('insert', actor, insertedText, createdAt),
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
            [suggestionId]: buildSuggestionMetadata('insert', actor, insertedText, createdAt),
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
            [suggestionId]: buildSuggestionMetadata('insert', actor, insertedText, createdAt),
          };
          metadataChanged = true;
        } else if (existing.hasInsert) {
          // Replace inside a pending insertion - keep it as an insertion suggestion.
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
            [suggestionId]: buildSuggestionMetadata('insert', actor, insertedText, createdAt),
          };
          metadataChanged = true;
        } else {
          // Replace: keep original text, store replacement content in metadata.
          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();

          newTr.removeMark(safeFrom, safeTo, suggestionType);
          newTr.addMark(safeFrom, safeTo, suggestionType.create({
            id: suggestionId,
            kind: 'replace',
            by: actor,
          }));

          metadata = {
            ...metadata,
            [suggestionId]: buildSuggestionMetadata('replace', actor, insertedText, createdAt),
          };
          metadataChanged = true;

          newTr.setSelection(TextSelection.create(newTr.doc, safeTo));
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

  if (metadataChanged) {
    newTr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata });
  }

  // Mark this transaction so authorship tracking skips it
  newTr.setMeta('suggestions-wrapped', true);

  // Carry over the post-edit selection from the original transaction. Without
  // this the editor's DOM caret (advanced by the browser's beforeinput) and
  // ProseMirror's model selection can disagree on the first keystroke under
  // Track Changes, which causes the editor to drop focus and silently swallow
  // every subsequent character. The original transaction already places the
  // selection in the right spot after its own steps; the wrapped transaction
  // produces an equivalent doc, so the positions line up.
  try {
    const desired = tr.selection;
    const docSize = newTr.doc.content.size;
    const from = Math.max(0, Math.min(desired.from, docSize));
    const to = Math.max(from, Math.min(desired.to, docSize));
    newTr.setSelection(TextSelection.create(newTr.doc, from, to));
  } catch (e) {
    // Selection no longer valid in the wrapped doc (rare): fall back to default.
    console.warn('[suggestions] could not carry selection to wrapped transaction', e);
  }

  __log('wrap.exit', {
    newDocSize: newTr.doc.content.size,
    oldDocSize: state.doc.content.size,
    newSel: { from: newTr.selection.from, to: newTr.selection.to },
    writeOffset,
    metadataChanged,
    newStepsCount: newTr.steps.length,
  });
  return newTr;
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
        queueMicrotask(() => {
          (window as any).proof?.bridge?.sendMessage('suggestionsChanged', { enabled: isEnabled });
        });
      }
      return null;
    },

    view(view) {
      // Track-changes mark application is performed OUTSIDE the input dispatch
      // cycle. Folding an addMark step into the user's input transaction (or
      // appending one in appendTransaction) makes ProseMirror's view drop
      // keyboard focus mid-keystroke under the embedded collab runtime, so we
      // schedule the mark on the next macrotask, after PM has finished its
      // input bookkeeping for the just-typed character.
      const pendingInserts: Array<{ from: number; to: number; text: string }> = [];
      let scheduled = false;

      const flush = () => {
        scheduled = false;
        if (pendingInserts.length === 0) return;
        const items = pendingInserts.splice(0, pendingInserts.length);
        const state = view.state;
        const enabled = suggestionsPluginKey.getState(state)?.enabled ?? false;
        if (!enabled) return;
        const suggestionType = state.schema.marks.proofSuggestion;
        if (!suggestionType) return;
        const actor = getCurrentActor();
        const tr = state.tr;
        let metadata = getMarkMetadata(state);
        const now = Date.now();
        let touched = false;
        for (const item of items) {
          const docSize = tr.doc.content.size;
          const from = Math.max(0, Math.min(item.from, docSize));
          const to = Math.max(from, Math.min(item.to, docSize));
          if (to <= from) continue;
          const candidate = getCoalescableInsertCandidate(state, from, actor, now);
          if (candidate) {
            tr.addMark(
              from,
              to,
              suggestionType.create({ id: candidate.id, kind: 'insert', by: actor }),
            );
            const existingMeta = metadata[candidate.id];
            const existingContent = typeof existingMeta?.content === 'string' ? existingMeta.content : '';
            const updatedContent = candidate.direction === 'append'
              ? `${existingContent}${item.text}`
              : `${item.text}${existingContent}`;
            metadata = {
              ...metadata,
              [candidate.id]: {
                ...existingMeta,
                kind: 'insert' as const,
                by: actor,
                content: updatedContent,
                status: existingMeta?.status ?? 'pending',
                createdAt: existingMeta?.createdAt ?? new Date().toISOString(),
              },
            };
            lastInsertByActor.set(actor, {
              id: candidate.id,
              from: candidate.range.from,
              to: candidate.range.to + item.text.length,
              by: actor,
              updatedAt: now,
            });
          } else {
            const suggestionId = generateMarkId();
            const createdAt = new Date().toISOString();
            tr.addMark(
              from,
              to,
              suggestionType.create({ id: suggestionId, kind: 'insert', by: actor }),
            );
            metadata = {
              ...metadata,
              [suggestionId]: buildSuggestionMetadata('insert', actor, item.text, createdAt),
            };
            lastInsertByActor.set(actor, {
              id: suggestionId,
              from,
              to,
              by: actor,
              updatedAt: now,
            });
          }
          touched = true;
        }
        if (!touched) return;
        tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata });
        tr.setMeta('suggestions-follow-up', true);
        tr.setMeta('addToHistory', false);
        view.dispatch(tr);
      };

      return {
        update(newView, prevState) {
          if (!(suggestionsPluginKey.getState(newView.state)?.enabled ?? false)) return;
          const prevSize = prevState.doc.content.size;
          const newSize = newView.state.doc.content.size;
          if (newSize <= prevSize) return; // no insert
          // Use the cursor positions to bound the inserted range. The browser's
          // input handling advances the selection past the inserted text, so
          // the inserted range is [prevSel.from, newSel.from).
          const prevFrom = prevState.selection.from;
          const newFrom = newView.state.selection.from;
          const growth = newSize - prevSize;
          // The new caret should be growth-positions past the previous one
          // when the insert happened at the cursor.
          if (newFrom !== prevFrom + growth) {
            try {
              (window as any).__suggestionTrace = (window as any).__suggestionTrace || [];
              (window as any).__suggestionTrace.push({
                t: Date.now(),
                args: ['view.update.skip', { prevFrom, newFrom, growth, reason: 'cursor delta != growth' }],
              });
            } catch {}
            return;
          }
          const from = prevFrom;
          const to = newFrom;
          const text = newView.state.doc.textBetween(from, to, '\n', '\n');
          try {
            (window as any).__suggestionTrace = (window as any).__suggestionTrace || [];
            (window as any).__suggestionTrace.push({
              t: Date.now(),
              args: ['view.update.queueInsert', { from, to, text, prevSize, newSize }],
            });
          } catch {}
          pendingInserts.push({ from, to, text });
          if (!scheduled) {
            scheduled = true;
            setTimeout(flush, 0);
          }
        },
        destroy() {
          pendingInserts.length = 0;
        },
      };
    },
  });
});

/**
 * Export all for use in editor
 */
export const suggestionsPlugins = [suggestionsCtx, suggestionsPlugin];
