/**
 * Proof Document Tools
 *
 * Tools for interacting with the Proof document editor.
 * These tools wrap the existing functionality and bridge to the editor.
 */

import type { EditorView } from '@milkdown/kit/prose/view';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import type { AgentTool, DocumentContext } from '../types';
import {
  suggestInsert,
  suggestDelete,
  suggestReplace,
  comment as addCommentMark,
  reply as replyToCommentMark,
  resolve as resolveCommentMark,
  getMarks,
  type CommentData,
} from '../../editor/plugins/marks';
import { resolveSelector, resolveSelectorRange, type SelectorRange } from '../../editor/utils/selectors';
import { buildTextIndex, getTextForRange, mapTextOffsetsToRange, resolveQuoteRange } from '../../editor/utils/text-range';
import { bridge } from '../../bridge/native-bridge';

// ============================================================================
// Editor Bridge Interface
// ============================================================================

// The editor view will be injected at runtime
let editorView: EditorView | null = null;
let statusCallback: ((message: string) => void) | null = null;

export function setEditorView(view: EditorView): void {
  editorView = view;
  console.log('[ProofTools] Editor view set');
}

export function getEditorView(): EditorView | null {
  return editorView;
}

export function setStatusCallback(cb: (message: string) => void): void {
  statusCallback = cb;
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Get the Proof document tools
 */
export function getProofTools(context: DocumentContext): AgentTool[] {
  return [
    // Read document
    {
      name: 'read_document',
      description: 'Read the current document content and structure.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        // Return the context document content
        return {
          content: context.documentContent,
          documentId: context.documentId,
          title: context.documentTitle,
        };
      },
    },

    // Search document
    {
      name: 'search',
      description: 'Search the document for a text pattern. Use type="regex" for regular expressions.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Text or regex pattern to search for',
          },
          type: {
            type: 'string',
            enum: ['text', 'regex'],
            description: 'How to interpret the pattern (default: text)',
          },
        },
        required: ['pattern'],
      },
      handler: async (args) => {
        const { pattern, type } = args as { pattern?: string; type?: SearchMode };
        const patternRaw = typeof pattern === 'string' ? pattern : '';
        if (!patternRaw.trim()) {
          return { success: false, count: 0, matches: [], error: 'pattern is required' };
        }
        if (!editorView) {
          return { success: false, count: 0, matches: [], error: 'Editor not available' };
        }

        const mode: SearchMode = type === 'regex' ? 'regex' : 'text';
        try {
          const matches = findMatchesInDocument(editorView.state.doc, patternRaw, mode);
          if (matches.length === 0) {
            return { success: false, count: 0, matches: [], error: 'No matches' };
          }
          return { success: true, count: matches.length, matches };
        } catch (error) {
          return {
            success: false,
            count: 0,
            matches: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },

    // Insert content
    {
      name: 'insert_content',
      description: 'Insert text at a specific position in the document.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The text to insert',
          },
          position: {
            type: 'string',
            description: 'Where to insert: "cursor", "selection", "start", "end", "range:from-to", "after:Heading", "before:Heading"',
          },
        },
        required: ['text'],
      },
      handler: async (args) => {
        const { text, position = 'cursor' } = args as { text: string; position?: string };

        if (!editorView) {
          return { success: false, error: 'Editor not available' };
        }

        return performInsert(text, position, context);
      },
    },

    // Replace content
    {
      name: 'replace_content',
      description: 'Replace text in a specified range or selection.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The replacement text',
          },
          selector: {
            type: 'string',
            description: 'What to replace: "selection", "section:Heading", "heading:Heading", "range:from-to", or exact quoted text',
          },
        },
        required: ['text'],
      },
      handler: async (args) => {
        const { text, selector = 'selection' } = args as { text: string; selector?: string };

        if (!editorView) {
          return { success: false, error: 'Editor not available' };
        }

        return performReplace(text, selector, context);
      },
    },

    // Delete content
    {
      name: 'delete_content',
      description: 'Delete text at a specified range or selector.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'What to delete: "selection", "section:Heading", "heading:Heading", "range:from-to", or exact quoted text',
          },
        },
        required: ['selector'],
      },
      handler: async (args) => {
        const { selector } = args as { selector: string };

        if (!editorView) {
          return { success: false, error: 'Editor not available' };
        }

        return performDelete(selector, context);
      },
    },

    // Create suggestion (track changes)
    {
      name: 'create_suggestion',
      description: 'Create a track change suggestion. Use this by default instead of direct edits.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['insert', 'replace', 'delete'],
            description: 'Type of suggestion',
          },
          text: {
            type: 'string',
            description: 'The text to insert or replace with (not needed for delete)',
          },
          selector: {
            type: 'string',
            description: 'What to modify: "cursor", "selection", "range:from-to", "section:Heading", "heading:Heading", or exact quoted text',
          },
        },
        required: ['type'],
      },
      handler: async (args) => {
        const { type, text, selector = 'selection' } = args as {
          type: 'insert' | 'replace' | 'delete';
          text?: string;
          selector?: string;
        };

        if (!editorView) {
          return { success: false, error: 'Editor not available' };
        }

        return createSuggestion(type, text, selector, context);
      },
    },

    // Add comment
    {
      name: 'add_comment',
      description: 'Add a new comment to the document.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The comment text',
          },
          selector: {
            type: 'string',
            description: 'What to comment on: "selection", "range:from-to", "section:Heading", "heading:Heading", or exact quoted text',
          },
        },
        required: ['text'],
      },
      handler: async (args) => {
        const { text, selector = 'selection' } = args as { text: string; selector?: string };

        if (!editorView) {
          return { success: false, error: 'Editor not available' };
        }

        return addComment(text, selector, context);
      },
    },

    // Reply to comment
    {
      name: 'reply_to_comment',
      description: 'Reply to an existing comment thread.',
      inputSchema: {
        type: 'object',
        properties: {
          commentId: {
            type: 'string',
            description: 'The ID of the comment to reply to',
          },
          text: {
            type: 'string',
            description: 'The reply text',
          },
        },
        required: ['commentId', 'text'],
      },
      handler: async (args) => {
        const { commentId, text } = args as { commentId: string; text: string };

        if (!editorView) {
          return { success: false, error: 'Editor not available' };
        }

        return replyToComment(commentId, text);
      },
    },

    // Resolve comment
    {
      name: 'resolve_comment',
      description: 'Mark a comment as resolved.',
      inputSchema: {
        type: 'object',
        properties: {
          commentId: {
            type: 'string',
            description: 'The ID of the comment to resolve',
          },
        },
        required: ['commentId'],
      },
      handler: async (args) => {
        const { commentId } = args as { commentId: string };

        if (!editorView) {
          return { success: false, error: 'Editor not available' };
        }

        return resolveComment(commentId);
      },
    },

    // Get comments
    {
      name: 'get_comments',
      description: 'Get all comments in the document.',
      inputSchema: {
        type: 'object',
        properties: {
          includeResolved: {
            type: 'boolean',
            description: 'Include resolved comments (default: false)',
          },
        },
      },
      handler: async (args) => {
        const { includeResolved = false } = args as { includeResolved?: boolean };

        if (!editorView) {
          return { success: false, error: 'Editor not available', comments: [] };
        }

        return getCommentsFromEditor(includeResolved);
      },
    },
    // Show conflict dialog
    {
      name: 'show_conflict_dialog',
      description: 'Show a conflict dialog when external changes overlap with user edits or are too extensive to show as individual suggestions. Use this when you determine that changes cannot be cleanly merged as suggestions.',
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Brief explanation of what changed and why a conflict dialog is needed',
          },
        },
        required: ['message'],
      },
      handler: async (args) => {
        const { message } = args as { message: string };
        bridge.sendMessage('externalChangeDialog', { message });
        return { success: true, message: 'Conflict dialog shown to user' };
      },
    },

    // Set status message
    {
      name: 'set_status',
      description: 'Set sidebar status (3-5 words max, e.g. "Fixing headline"). Never a full sentence.',
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Short status message (max 36 chars) shown in sidebar',
          },
        },
        required: ['message'],
      },
      handler: async (args) => {
        const { message } = args as { message: string };
        if (statusCallback) {
          statusCallback(message);
        }
        return { success: true, message };
      },
    },
  ];
}

// ============================================================================
// Editor Bridge Functions
// ============================================================================

const AGENT_ACTOR = 'ai:Proof';
interface SelectorContext {
  cursor?: number;
  selection?: SelectorRange | null;
  scope?: SelectorRange | null;
}

function buildSelectorContext(context: DocumentContext, view: EditorView): SelectorContext {
  const selection = context.selectionRange ?? {
    from: view.state.selection.from,
    to: view.state.selection.to,
  };
  const cursor = context.cursorPosition ?? view.state.selection.from;
  const scope = context.documentRange
    ? normalizeRange(context.documentRange, view.state.doc)
    : null;

  return { cursor, selection, scope };
}

function normalizeRange(range: SelectorRange, doc: ProseMirrorNode): SelectorRange | null {
  const docSize = doc.content.size;
  if (range.from < 0 || range.to < 0) return null;
  if (range.from > docSize || range.to > docSize) return null;
  if (range.from > range.to) return null;
  return range;
}

function enforceScope(
  range: SelectorRange,
  scope?: SelectorRange | null
): SelectorRange | null {
  if (!scope) return range;
  if (range.from < scope.from || range.to > scope.to) {
    return null;
  }
  return range;
}

function parseRangeSelector(selector: string, docSize: number): SelectorRange | null {
  if (!selector.startsWith('range:')) return null;
  const rangeStr = selector.substring(6);
  const parts = rangeStr.split('-');
  if (parts.length !== 2) return null;
  const from = parseInt(parts[0], 10);
  const to = parseInt(parts[1], 10);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  if (from < 0 || to < 0) return null;
  if (from > docSize || to > docSize) return null;
  if (from > to) return null;
  return { from, to };
}

function resolveRangeSelector(
  selector: string,
  view: EditorView,
  selectorContext: SelectorContext
): SelectorRange | null {
  const doc = view.state.doc;
  const docSize = doc.content.size;

  if (selector === 'start' || selector === 'end') {
    return null;
  }
  if (selector.startsWith('after:') || selector.startsWith('before:')) {
    return null;
  }

  const directRange = parseRangeSelector(selector, docSize);
  if (directRange) {
    return enforceScope(directRange, selectorContext.scope);
  }

  const semanticRange = resolveSelectorRange(doc, selector, {
    cursor: selectorContext.cursor,
    selection: selectorContext.selection ?? undefined,
  });
  if (semanticRange) {
    const normalized = normalizeRange(semanticRange, doc);
    return normalized ? enforceScope(normalized, selectorContext.scope) : null;
  }

  if (selector === 'cursor') {
    const cursor = selectorContext.cursor;
    if (typeof cursor === 'number') {
      const range = normalizeRange({ from: cursor, to: cursor }, doc);
      return range ? enforceScope(range, selectorContext.scope) : null;
    }
  }

  const quoteRange = resolveQuoteRange(doc, selector, selectorContext.scope ?? undefined);
  return quoteRange ?? null;
}

function resolveInsertPosition(
  selector: string,
  view: EditorView,
  selectorContext: SelectorContext
): number | null {
  const doc = view.state.doc;
  const pos = resolveSelector(doc, selector, {
    cursor: selectorContext.cursor,
    selection: selectorContext.selection ?? undefined,
  });

  if (typeof pos === 'number') {
    if (pos < 0 || pos > doc.content.size) {
      return null;
    }
    if (selectorContext.scope) {
      if (pos < selectorContext.scope.from || pos > selectorContext.scope.to) {
        return null;
      }
    }
    return pos;
  }

  const range = resolveRangeSelector(selector, view, selectorContext);
  if (range) {
    return range.to;
  }

  return null;
}

// Quote resolution is handled by resolveQuoteRange in editor/utils/text-range.

async function performInsert(
  text: string,
  position: string,
  context: DocumentContext
): Promise<unknown> {
  if (!editorView) {
    return { success: false, error: 'Editor not available' };
  }

  const selectorContext = buildSelectorContext(context, editorView);
  const pos = resolveInsertPosition(position, editorView, selectorContext);
  if (typeof pos !== 'number') {
    return { success: false, error: `Could not resolve position: ${position}` };
  }

  const tr = editorView.state.tr.insertText(text, pos);
  editorView.dispatch(tr);

  console.log('[ProofTools] Inserted text at position', pos);
  return {
    success: true,
    position: { from: pos, to: pos },
    text,
    insertedChars: text.length,
  };
}

async function performReplace(
  text: string,
  selector: string,
  context: DocumentContext
): Promise<unknown> {
  if (!editorView) {
    return { success: false, error: 'Editor not available' };
  }

  const selectorContext = buildSelectorContext(context, editorView);
  const range = resolveRangeSelector(selector, editorView, selectorContext);
  if (!range || range.from === range.to) {
    return { success: false, error: `Could not resolve selector or empty range: ${selector}` };
  }

  const originalText = getTextForRange(editorView.state.doc, range);
  const tr = editorView.state.tr.replaceWith(
    range.from,
    range.to,
    editorView.state.schema.text(text)
  );
  editorView.dispatch(tr);

  console.log('[ProofTools] Replaced text at range', range);
  return {
    success: true,
    selector,
    position: range,
    text,
    originalText,
  };
}

async function performDelete(selector: string, context: DocumentContext): Promise<unknown> {
  if (!editorView) {
    return { success: false, error: 'Editor not available' };
  }

  const selectorContext = buildSelectorContext(context, editorView);
  const range = resolveRangeSelector(selector, editorView, selectorContext);
  if (!range || range.from === range.to) {
    return { success: false, error: `Could not resolve selector or empty range: ${selector}` };
  }

  const originalText = getTextForRange(editorView.state.doc, range);
  const tr = editorView.state.tr.delete(range.from, range.to);
  editorView.dispatch(tr);

  console.log('[ProofTools] Deleted text at range', range);
  return {
    success: true,
    selector,
    position: range,
    originalText,
  };
}

async function createSuggestion(
  type: 'insert' | 'replace' | 'delete',
  text: string | undefined,
  selector: string | undefined,
  context: DocumentContext
): Promise<unknown> {
  console.log('[ProofTools] createSuggestion called:', { type, text: text?.substring(0, 50), selector });

  if (!editorView) {
    console.error('[ProofTools] Editor view is null!');
    return { success: false, error: 'Editor not available' };
  }

  const selectorStr = selector || 'selection';
  const selectorContext = buildSelectorContext(context, editorView);

  let range: SelectorRange | null = null;
  if (type === 'insert') {
    const pos = resolveInsertPosition(selectorStr, editorView, selectorContext);
    if (typeof pos !== 'number') {
      return { success: false, error: `Could not resolve selector: ${selectorStr}` };
    }
    range = { from: pos, to: pos };
  } else {
    range = resolveRangeSelector(selectorStr, editorView, selectorContext);
  }

  if (!range || range.from === range.to && type !== 'insert') {
    return { success: false, error: `Could not resolve selector: ${selectorStr}` };
  }

  const quote = getTextForRange(editorView.state.doc, range);

  let mark;
  switch (type) {
    case 'insert':
      if (!text) {
        return { success: false, error: 'Insert requires text' };
      }
      mark = suggestInsert(editorView, quote, AGENT_ACTOR, text, range);
      console.log('[ProofTools] Created insert suggestion', mark?.id);
      break;

    case 'delete':
      mark = suggestDelete(editorView, quote, AGENT_ACTOR, range);
      console.log('[ProofTools] Created delete suggestion', mark?.id);
      break;

    case 'replace':
      if (!text) {
        return { success: false, error: 'Replace requires text' };
      }
      mark = suggestReplace(editorView, quote, AGENT_ACTOR, text, range);
      console.log('[ProofTools] Created replace suggestion', mark?.id);
      break;
  }

  if (!mark) {
    return {
      success: false,
      error: 'Suggestion was rejected by safety checks',
      type,
      selector: selectorStr,
      text,
      position: range,
      originalText: quote,
    };
  }

  return {
    success: true,
    type,
    selector: selectorStr,
    text,
    position: range,
    originalText: quote,
    markId: mark?.id,
  };
}

async function addComment(
  text: string,
  selector: string,
  context: DocumentContext
): Promise<unknown> {
  if (!editorView) {
    return { success: false, error: 'Editor not available' };
  }

  const selectorContext = buildSelectorContext(context, editorView);
  const range = resolveRangeSelector(selector, editorView, selectorContext);
  if (!range || range.from === range.to) {
    return { success: false, error: `Could not resolve selector: ${selector}` };
  }

  const quote = getTextForRange(editorView.state.doc, range);
  const mark = addCommentMark(editorView, quote, AGENT_ACTOR, text, range);

  console.log('[ProofTools] Added comment', mark.id);
  return {
    success: true,
    commentId: mark.id,
    text,
    position: range,
    quote,
  };
}

async function replyToComment(commentId: string, text: string): Promise<unknown> {
  if (!editorView) {
    return { success: false, error: 'Editor not available' };
  }

  const mark = replyToCommentMark(editorView, commentId, AGENT_ACTOR, text);
  if (!mark) {
    return { success: false, error: `Comment not found: ${commentId}` };
  }

  console.log('[ProofTools] Replied to comment', commentId, 'with', mark.id);
  return {
    success: true,
    commentId,
    replyId: mark.id,
    text,
  };
}

async function resolveComment(commentId: string): Promise<unknown> {
  if (!editorView) {
    return { success: false, error: 'Editor not available' };
  }

  const success = resolveCommentMark(editorView, commentId);
  if (!success) {
    return { success: false, error: `Comment not found: ${commentId}` };
  }

  console.log('[ProofTools] Resolved comment', commentId);
  return { success: true, commentId, resolved: true };
}

async function getCommentsFromEditor(includeResolved: boolean): Promise<unknown> {
  if (!editorView) {
    return { success: false, error: 'Editor not available', comments: [] };
  }

  const marks = getMarks(editorView.state);
  const comments = marks
    .filter(m => m.kind === 'comment')
    .filter(m => {
      if (includeResolved) return true;
      const data = m.data as CommentData;
      return !data?.resolved;
    })
    .map(m => {
      const data = m.data as CommentData;
      return {
        id: m.id,
        author: m.by,
        text: data?.text || '',
        quote: m.quote,
        resolved: data?.resolved || false,
        thread: data?.thread,
      };
    });

  return { success: true, comments };
}

// ============================================================================
// Search Helpers
// ============================================================================

const MAX_SEARCH_MATCHES = 50;

type SearchMode = 'text' | 'regex';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchRegex(pattern: string, mode: SearchMode): RegExp {
  const source = mode === 'regex'
    ? pattern
    : pattern
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(escapeRegExp)
        .join('\\s+');

  if (!source) {
    throw new Error('pattern is required');
  }

  try {
    return new RegExp(source, 'gi');
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Invalid regex');
  }
}

function findMatchesInDocument(
  doc: ProseMirrorNode,
  pattern: string,
  mode: SearchMode
): Array<{ text: string; position: number; context: string; from: number; to: number }> {
  const index = buildTextIndex(doc);
  if (!index) return [];

  const regex = buildSearchRegex(pattern, mode);
  const matches: Array<{ text: string; position: number; context: string; from: number; to: number }> = [];
  const docSize = doc.content.size;

  let result: RegExpExecArray | null;
  while ((result = regex.exec(index.text)) !== null) {
    if (matches.length >= MAX_SEARCH_MATCHES) {
      break;
    }

    const matchText = result[0];
    if (!matchText) {
      regex.lastIndex += 1;
      continue;
    }

    const startOffset = result.index;
    const endOffset = startOffset + matchText.length;
    const mapped = mapTextOffsetsToRange(index, startOffset, endOffset);
    if (!mapped) {
      continue;
    }

    const contextFrom = Math.max(0, mapped.from - 60);
    const contextTo = Math.min(docSize, mapped.to + 60);
    const context = doc.textBetween(contextFrom, contextTo, '\n', '\n');

    matches.push({
      text: matchText,
      position: mapped.from,
      context,
      from: mapped.from,
      to: mapped.to,
    });
  }

  return matches;
}
