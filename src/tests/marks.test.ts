/**
 * Unit Tests for Unified Marks System
 *
 * Tests:
 * - Mark creation (approval, flag, comment, suggestions)
 * - Quote normalization and resolution
 * - YAML serialization/deserialization
 * - Mark operations (add, remove, update)
 */

import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';
import { ySyncPluginKey } from 'y-prosemirror';
import {
  generateMarkId,
  generateThreadId,
  createApproval,
  createFlag,
  createComment,
  createInsertSuggestion,
  createDeleteSuggestion,
  createReplaceSuggestion,
  normalizeQuote,
  resolveQuote,
  getMarksByKind,
  getMarksByActor,
  getPendingSuggestions,
  getUnresolvedComments,
  getThread,
  findMark,
  addMark,
  removeMark,
  acceptSuggestion,
  rejectSuggestion,
  modifySuggestion,
  resolveComment,
  unresolveComment,
  extractMarks,
  embedMarks,
  removeFinalizedSuggestionMetadata,
  hasMarks,
  isHuman,
  isAI,
  getActorName,
  migrateProvenanceToMarks,
  calculateAuthorshipStats,
  canonicalizeStoredMarks,
  type Mark,
  type CommentData,
  type InsertData,
  type StoredMark,
} from '../formats/marks.js';
import {
  resolveMarks,
  marksPluginKey,
  accept as acceptMark,
  reject as rejectMark,
  acceptAll as acceptAllMarks,
  setEventCallback,
  rangeCrossesTableCellBoundary,
  applyRemoteMarks,
  buildCanonicalShareMarkMetadata,
  getMarks,
  getMarkMetadata,
  getMarkMetadataForDisk,
  getMarkMetadataWithQuotes,
  mergePendingServerMarks,
  __debugDescribeDecorations,
  reply as replyMark,
  resolve as resolveMark,
  deleteMark,
  setComposeAnchorRange,
  getComposeAnchorRange,
  __getMarkAnchorHydrationFailure,
  __getMarkAnchorHydrationFailureCount,
  __resetMarkAnchorHydrationFailures,
  __resetResolvedMarkTombstones,
  tombstoneResolvedMarkIds,
} from '../editor/plugins/marks.js';
import { getTextForRange, resolveQuoteRange } from '../editor/utils/text-range.js';
import { extractEmbeddedProvenance } from '../formats/provenance-sidecar.js';
import { proofMarkHandler, remarkProofMarks } from '../formats/remark-proof-marks.js';
import { dedupeProposals, type SubAgentProposal } from '../agent/proposals.js';

// Simple test runner
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(error as Error).message}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual<T>(actual: T, expected: T, message?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const testSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' },
  },
});

const marksSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' },
  },
  marks: {
    proofSuggestion: {
      attrs: {
        id: { default: null },
        kind: { default: 'replace' },
        by: { default: 'unknown' },
      },
      inclusive: false,
      spanning: true,
    },
    proofComment: {
      attrs: {
        id: { default: null },
        by: { default: 'unknown' },
      },
      inclusive: false,
      spanning: true,
    },
  },
});

function buildDoc(paragraphs: string[]) {
  return testSchema.node(
    'doc',
    null,
    paragraphs.map((text) =>
      testSchema.node('paragraph', null, text ? testSchema.text(text) : undefined)
    )
  );
}

const tableSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    table: { content: 'table_row+', group: 'block' },
    table_row: { content: '(table_header|table_cell)+' },
    table_header: { content: 'paragraph+' },
    table_cell: { content: 'paragraph+' },
    text: { group: 'inline' },
  },
});

function buildTableDoc(rowValues: string[][]) {
  return tableSchema.node(
    'doc',
    null,
    [
      tableSchema.node(
        'table',
        null,
        rowValues.map((row, rowIndex) =>
          tableSchema.node(
            'table_row',
            null,
            row.map((value) =>
              tableSchema.node(
                rowIndex === 0 ? 'table_header' : 'table_cell',
                null,
                [tableSchema.node('paragraph', null, value ? tableSchema.text(value) : undefined)]
              )
            )
          )
        )
      ),
    ]
  );
}

function wrapWithProvenance(markdown: string): string {
  const provenance = {
    version: '2.1.0',
    documentId: 'doc_test',
    created: '1970-01-01T00:00:00.000Z',
    modified: '1970-01-01T00:00:00.000Z',
    spans: [],
    attention: {},
    events: [],
    metadata: {
      humanPercent: 0,
      aiPercent: 100,
      attestationCoverage: { A0: 1, A1: 0, A2: 0, A3: 0, A4: 0 }
    },
    comments: []
  };

  const json = JSON.stringify(provenance);
  let content = markdown;
  if (!content.endsWith('\n')) {
    content += '\n';
  }

  return `${content}\n<!-- PROOF:END -->\n\n<!-- PROVENANCE\n${json}\n-->\n`;
}

// ============================================================================
// ID Generation Tests
// ============================================================================

console.log('\n=== ID Generation ===');

test('generateMarkId creates unique IDs', () => {
  const id1 = generateMarkId();
  const id2 = generateMarkId();
  assert(id1 !== id2, 'IDs should be unique');
  assert(id1.startsWith('m'), 'Mark IDs should start with m');
});

test('generateThreadId creates unique IDs', () => {
  const id1 = generateThreadId();
  const id2 = generateThreadId();
  assert(id1 !== id2, 'IDs should be unique');
  assert(id1.startsWith('t'), 'Thread IDs should start with t');
});

// ============================================================================
// Mark Creation Tests
// ============================================================================

console.log('\n=== Mark Creation ===');

test('createApproval creates approval mark', () => {
  const mark = createApproval('Some content to approve', 'human:dan');
  assertEqual(mark.kind, 'approved');
  assertEqual(mark.quote, 'Some content to approve');
  assertEqual(mark.by, 'human:dan');
  assert(mark.id.startsWith('m'), 'Should have mark ID');
  assert(mark.at.length > 0, 'Should have timestamp');
});

test('createFlag creates flag mark with note', () => {
  const mark = createFlag('Problematic content', 'ai:claude', 'Missing error handling');
  assertEqual(mark.kind, 'flagged');
  assertEqual(mark.quote, 'Problematic content');
  assertEqual(mark.by, 'ai:claude');
  assertEqual((mark.data as any)?.note, 'Missing error handling');
});

test('createComment creates comment mark', () => {
  const mark = createComment('Text to comment on', 'human:dan', 'What about this?');
  assertEqual(mark.kind, 'comment');
  const data = mark.data as CommentData;
  assertEqual(data.text, 'What about this?');
  assertEqual(data.resolved, false);
  assert(data.thread.startsWith('t'), 'Should have thread ID');
});

test('createComment with existing thread', () => {
  const mark = createComment('Text to comment on', 'ai:claude', 'Good point', 't123');
  const data = mark.data as CommentData;
  assertEqual(data.thread, 't123');
});

test('createInsertSuggestion creates insert suggestion', () => {
  const mark = createInsertSuggestion('After this text', 'ai:claude', 'New paragraph');
  assertEqual(mark.kind, 'insert');
  const data = mark.data as InsertData;
  assertEqual(data.content, 'New paragraph');
  assertEqual(data.status, 'pending');
});

test('createDeleteSuggestion creates delete suggestion', () => {
  const mark = createDeleteSuggestion('Text to delete', 'ai:claude');
  assertEqual(mark.kind, 'delete');
  assertEqual((mark.data as any).status, 'pending');
});

test('createReplaceSuggestion creates replace suggestion', () => {
  const mark = createReplaceSuggestion('Old text', 'ai:claude', 'New text');
  assertEqual(mark.kind, 'replace');
  assertEqual((mark.data as any).content, 'New text');
  assertEqual((mark.data as any).status, 'pending');
});

// ============================================================================
// Quote Normalization Tests
// ============================================================================

console.log('\n=== Quote Normalization ===');

test('normalizeQuote trims whitespace', () => {
  const result = normalizeQuote('  hello world  ');
  assertEqual(result, 'hello world');
});

test('normalizeQuote normalizes internal whitespace', () => {
  const result = normalizeQuote('hello   world\n\ntest');
  assertEqual(result, 'hello world test');
});

test('normalizeQuote preserves long quotes', () => {
  const longText = 'a'.repeat(150);
  const result = normalizeQuote(longText);
  assertEqual(result.length, 150);
});

// ============================================================================
// Quote Resolution Tests
// ============================================================================

console.log('\n=== Quote Resolution ===');

test('resolveQuote finds exact match', () => {
  const doc = 'This is some content with a target phrase in it.';
  const result = resolveQuote(doc, 'target phrase');
  assert(result !== null, 'Should find match');
  assertEqual(result!.from, 28);
  assertEqual(result!.to, 41);
});

test('resolveQuote finds prefix match', () => {
  const doc = 'This is a very long paragraph that gets truncated at some point.';
  const quote = 'This is a very long paragraph';
  const result = resolveQuote(doc, quote);
  assert(result !== null, 'Should find match');
  assertEqual(result!.from, 0);
});

test('resolveQuote returns null for no match', () => {
  const doc = 'This is some content.';
  const result = resolveQuote(doc, 'nonexistent text');
  assertEqual(result, null);
});

test('resolveQuote maps collapsed whitespace to original range', () => {
  const doc = 'alpha  beta';
  const result = resolveQuote(doc, 'alpha beta');
  assert(result !== null, 'Should find match');
  const slice = doc.slice(result!.from, result!.to);
  assertEqual(slice, 'alpha  beta');
});

// ============================================================================
// Quote Range Resolution (Document)
// ============================================================================

console.log('\n=== Quote Range Resolution ===');

test('resolveQuoteRange maps text to exact document positions', () => {
  const doc = buildDoc(['hello world']);
  const range = resolveQuoteRange(doc, 'hello');
  assert(range !== null, 'Should resolve quote');
  assertEqual(range!.from, 1);
  assertEqual(range!.to, 6);
});

test('resolveQuoteRange rejects ambiguous quotes', () => {
  const doc = buildDoc(['foo bar foo']);
  const range = resolveQuoteRange(doc, 'foo');
  assertEqual(range, null);
});

test('resolveQuoteRange supports cross-paragraph quotes', () => {
  const doc = buildDoc(['hello', 'world']);
  const range = resolveQuoteRange(doc, 'hello\nworld');
  assert(range !== null, 'Should resolve cross-paragraph quote');
  const text = getTextForRange(doc, range!);
  assertEqual(text, 'hello\nworld');
});

test('getTextForRange output resolves back to the same range', () => {
  const doc = buildDoc(['alpha', 'beta']);
  const range = resolveQuoteRange(doc, 'alpha\nbeta');
  assert(range !== null, 'Should resolve cross-paragraph quote');
  const quote = getTextForRange(doc, range!);
  const resolved = resolveQuoteRange(doc, quote);
  assertDeepEqual(resolved, range);
});

test('resolveQuoteRange prefers exact cross-paragraph match', () => {
  const doc = buildDoc(['hello world', 'hello', 'world']);
  const range = resolveQuoteRange(doc, 'hello\nworld');
  assert(range !== null, 'Should resolve cross-paragraph quote exactly');
  const text = getTextForRange(doc, range!);
  assertEqual(text, 'hello\nworld');
});

test('resolveQuoteRange preserves original whitespace in range', () => {
  const doc = buildDoc(['alpha  beta']);
  const range = resolveQuoteRange(doc, 'alpha beta');
  assert(range !== null, 'Should resolve quote');
  const text = getTextForRange(doc, range!);
  assertEqual(text, 'alpha  beta');
});

test('resolveQuoteRange normalizes smart quotes', () => {
  const doc = buildDoc([`He said \u201Chello\u201D to her`]);
  const range = resolveQuoteRange(doc, 'He said "hello"');
  assert(range !== null, 'Should resolve quote with smart quotes');
  const text = getTextForRange(doc, range!);
  assertEqual(text, 'He said \u201Chello\u201D');
});

test('resolveQuoteRange normalizes em dashes', () => {
  const doc = buildDoc([`impact\u2014on resumes`]);
  const range = resolveQuoteRange(doc, 'impact-on resumes');
  assert(range !== null, 'Should resolve quote with em dash');
  const text = getTextForRange(doc, range!);
  assertEqual(text, `impact\u2014on resumes`);
});

test('rangeCrossesTableCellBoundary detects cross-cell ranges', () => {
  const doc = buildTableDoc([
    ['Fix', 'Stage'],
    ['Rewrite reliability', 'Merged, awaiting release'],
  ]);

  const crossRange = resolveQuoteRange(doc, 'Rewrite reliability Merged, awaiting release');
  assert(crossRange !== null, 'Cross-cell quote should resolve in flattened text view');
  assert(
    rangeCrossesTableCellBoundary(doc, crossRange!),
    'Cross-cell quote should be detected as crossing table cell boundary'
  );
});

test('rangeCrossesTableCellBoundary allows single-cell ranges', () => {
  const doc = buildTableDoc([
    ['Fix', 'Stage'],
    ['Rewrite reliability', 'Merged, awaiting release'],
  ]);

  const singleCellRange = resolveQuoteRange(doc, 'Rewrite reliability');
  assert(singleCellRange !== null, 'Single-cell quote should resolve');
  assertEqual(
    rangeCrossesTableCellBoundary(doc, singleCellRange!),
    false,
    'Single-cell quote should not cross table cell boundary'
  );
});

test('applyRemoteMarks does not resurrect locally rejected mark ids', () => {
  const markId = 'm-remote-resurrect';
  const suggestionMark = marksSchema.marks.proofSuggestion.create({
    id: markId,
    kind: 'replace',
    by: 'ai:test',
  });

  const initialDoc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [
      marksSchema.text('Hello '),
      marksSchema.text('world', [suggestionMark]),
    ]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc: initialDoc,
    plugins: [marksStatePlugin],
  });

  const remoteMetadata = {
    [markId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-02-11T00:00:00.000Z').toISOString(),
      content: 'planet',
      status: 'pending' as const,
      quote: 'world',
    },
  };

  state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata: remoteMetadata }));

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const rejected = rejectMark(view, markId);
  assert(rejected, 'Reject should succeed');

  applyRemoteMarks(view, remoteMetadata);
  const marksAfter = getMarks(state);
  assert(!marksAfter.some((mark) => mark.id === markId), 'Rejected mark id should not be recreated by remote sync');

  const pluginState = marksPluginKey.getState(state) as { metadata: Record<string, unknown> } | undefined;
  assert(pluginState !== undefined, 'Plugin state should exist');
  assert(!(markId in (pluginState?.metadata ?? {})), 'Rejected mark metadata should remain removed after remote sync');
});

test('reject tombstones stale server suggestions before dispatch-time marks merges', () => {
  const markId = 'm-reject-dispatch-race';
  const suggestionMark = marksSchema.marks.proofSuggestion.create({
    id: markId,
    kind: 'replace',
    by: 'ai:test',
    content: 'planet',
    status: 'pending',
    createdAt: new Date('2026-03-11T00:00:00.000Z').toISOString(),
  });

  const initialDoc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [
      marksSchema.text('Hello '),
      marksSchema.text('world', [suggestionMark]),
    ]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc: initialDoc,
    plugins: [marksStatePlugin],
  });

  const remoteMetadata = {
    [markId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-03-11T00:00:00.000Z').toISOString(),
      content: 'planet',
      status: 'pending' as const,
      quote: 'world',
    },
  };

  state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata: remoteMetadata }));

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
      const merged = mergePendingServerMarks(getMarkMetadataWithQuotes(state), remoteMetadata);
      state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata: merged }));
    },
  } as any;

  const rejected = rejectMark(view, markId);
  assert(rejected, 'Reject should succeed');

  const marksAfter = getMarks(state);
  assert(!marksAfter.some((mark) => mark.id === markId), 'Reject should stay removed even if stale server marks merge during dispatch');

  const pluginState = marksPluginKey.getState(state) as { metadata: Record<string, unknown> } | undefined;
  assert(pluginState !== undefined, 'Plugin state should exist');
  assert(!(markId in (pluginState?.metadata ?? {})), 'Dispatch-time marks merge should not resurrect rejected metadata');
});

test('applyRemoteMarks ignores mismatched relative anchors and falls back to quote', () => {
  const markId = 'm-remote-relative-mismatch';
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, marksSchema.text('alpha beta gamma')),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const remoteMetadata = {
    [markId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-02-16T00:00:00.000Z').toISOString(),
      content: 'beta-updated',
      status: 'pending' as const,
      quote: 'beta',
      startRel: 'char:0',
      endRel: 'char:5',
    },
  };

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, remoteMetadata);

  const marksAfter = getMarks(state);
  const anchored = marksAfter.find(mark => mark.id === markId);
  assert(anchored !== undefined, 'Remote mark should be anchored');
  assert(anchored?.range !== undefined, 'Anchored mark should include a range');
  const anchoredText = getTextForRange(state.doc, anchored!.range!);
  assertEqual(anchoredText, 'beta', 'Quote fallback should anchor to the quoted text');
});

test('applyRemoteMarks repairs fragmented pending insert anchors on collab peers', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'text*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'insert' },
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
      proofAuthored: {
        attrs: {
          by: { default: 'human:unknown' },
          id: { default: null },
        },
        inclusive: true,
        excludes: 'proofAuthored',
        spanning: true,
      },
    },
  });

  const insertId = 'm-collab-fragmented-insert';
  const fullText = 'Collab peer TC with track changes enabled in window B.';
  const insertMark = schema.marks.proofSuggestion.create({ id: insertId, kind: 'insert', by: 'human:test' });
  const authoredMark = schema.marks.proofAuthored.create({ by: 'human:test' });

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({
        metadata: {
          [insertId]: {
            kind: 'insert' as const,
            by: 'human:test',
            createdAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
            status: 'pending' as const,
            content: fullText,
            quote: fullText,
            range: { from: 1, to: fullText.length + 1 },
          },
        },
        activeMarkId: null,
      }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('C', [insertMark]),
        schema.text('ol', [authoredMark]),
        schema.text('lab peer TC with track changes enabled in window B.', [insertMark]),
      ]),
    ]),
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {
    [insertId]: {
      kind: 'insert',
      by: 'human:test',
      createdAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
      status: 'pending',
      content: fullText,
      quote: fullText,
      range: { from: 1, to: fullText.length + 1 },
    },
  }, { hydrateAnchors: true });

  const marksAfter = getMarks(state);
  const repairedInsert = marksAfter.find((mark) => mark.id === insertId);
  assert(repairedInsert, 'Expected fragmented collab insert to remain actionable after remote apply');
  assertDeepEqual(
    repairedInsert!.range,
    { from: 1, to: fullText.length + 1 },
    'Expected remote apply to restore the full pending insert range instead of leaving a suffix-only fragment',
  );
  assertEqual(
    (repairedInsert!.data as InsertData | undefined)?.content,
    fullText,
    'Expected repaired insert metadata to preserve the full tracked text',
  );

  const suggestionNodes: string[] = [];
  const authoredNodes: string[] = [];
  state.doc.descendants((node) => {
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type.name === 'proofSuggestion' && mark.attrs.id === insertId)) {
      suggestionNodes.push(node.text ?? '');
    }
    if (node.marks.some((mark) => mark.type.name === 'proofAuthored')) {
      authoredNodes.push(node.text ?? '');
    }
    return true;
  });

  assertEqual(
    suggestionNodes.join(''),
    fullText,
    'Expected repaired collab insert anchor to cover the full text, including the previously authored prefix fragment',
  );
  assertEqual(
    authoredNodes.join(''),
    '',
    'Expected remote repair to strip authored marks from the repaired pending insert range',
  );
});

test('applyRemoteMarks does not collapse healthy live inserts to a canonical share insertion point', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'text*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'insert' },
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
    },
  });

  const insertId = 'm-collapsed-share-insert';
  const fullText = 'TC paragraph one from window A.';
  const insertMark = schema.marks.proofSuggestion.create({ id: insertId, kind: 'insert', by: 'human:test' });

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({
        metadata: {
          [insertId]: {
            kind: 'insert' as const,
            by: 'human:test',
            createdAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
            status: 'pending' as const,
            content: fullText,
            range: { from: 1, to: 1 },
          },
        },
        activeMarkId: null,
      }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(fullText, [insertMark])]),
    ]),
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {
    [insertId]: {
      kind: 'insert',
      by: 'human:test',
      createdAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
      status: 'pending',
      content: fullText,
      range: { from: 1, to: 1 },
      startRel: undefined,
      endRel: undefined,
      quote: undefined,
    },
  }, { hydrateAnchors: true });

  const suggestionNodes: string[] = [];
  state.doc.descendants((node) => {
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type.name === 'proofSuggestion' && mark.attrs.id === insertId)) {
      suggestionNodes.push(node.text ?? '');
    }
    return true;
  });

  assertEqual(
    suggestionNodes.join(''),
    fullText,
    'Expected canonical collapsed share metadata to leave an already-healthy live insert span intact',
  );
});

test('applyRemoteMarks repairs fragmented live inserts from collapsed share metadata', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'text*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'insert' },
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
    },
  });

  const insertId = 'm-collapsed-fragmented-share-insert';
  const insertedText = ' brave';
  const insertMark = schema.marks.proofSuggestion.create({ id: insertId, kind: 'insert', by: 'human:test' });

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({
        metadata: {
          [insertId]: {
            kind: 'insert' as const,
            by: 'human:test',
            createdAt: new Date('2026-03-28T00:00:00.000Z').toISOString(),
            status: 'pending' as const,
            content: insertedText,
            range: { from: 6, to: 6 },
          },
        },
        activeMarkId: null,
      }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Alpha'),
        schema.text(' b', [insertMark]),
        schema.text('rave beta gamma.'),
      ]),
    ]),
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {
    [insertId]: {
      kind: 'insert',
      by: 'human:test',
      createdAt: new Date('2026-03-28T00:00:00.000Z').toISOString(),
      status: 'pending',
      content: insertedText,
      range: { from: 6, to: 6 },
    },
  }, { hydrateAnchors: true });

  const repairedInsert = getMarks(state).find((mark) => mark.id === insertId);
  assert(repairedInsert, 'Expected fragmented collapsed insert metadata to remain actionable after remote apply');
  assertDeepEqual(
    repairedInsert!.range,
    { from: 6, to: 12 },
    'Expected collapsed share metadata to repair the full inserted span instead of keeping the first-character fragment',
  );

  const suggestionNodes: string[] = [];
  state.doc.descendants((node) => {
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type.name === 'proofSuggestion' && mark.attrs.id === insertId)) {
      suggestionNodes.push(node.text ?? '');
    }
    return true;
  });

  assertEqual(
    suggestionNodes.join(''),
    insertedText,
    'Expected repaired insert anchors to cover the full tracked insertion after reload repair',
  );

  const flushed = getMarkMetadataWithQuotes(state);
  const persisted = buildCanonicalShareMarkMetadata(state, flushed);
  assertDeepEqual(
    persisted[insertId]?.range,
    { from: 6, to: 6 },
    'Expected canonical share persistence to keep collapsing the repaired insert back to its insertion point',
  );
});

test('applyRemoteMarks does not collapse a healthy live insert when stale remote metadata lags behind local growth', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'text*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'insert' },
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
    },
  });

  const insertId = 'm-stale-growth-insert';
  const fullText = 'TC para one from A.';
  const insertMark = schema.marks.proofSuggestion.create({ id: insertId, kind: 'insert', by: 'human:test' });

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(fullText, [insertMark])]),
    ]),
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {
    [insertId]: {
      kind: 'insert',
      by: 'human:test',
      createdAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
      status: 'pending',
      content: 'TC',
      range: { from: 1, to: 1 },
      startRel: undefined,
      endRel: undefined,
      quote: undefined,
    },
  }, { hydrateAnchors: true });

  const suggestionNodes: string[] = [];
  state.doc.descendants((node) => {
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type.name === 'proofSuggestion' && mark.attrs.id === insertId)) {
      suggestionNodes.push(node.text ?? '');
    }
    return true;
  });

  assertEqual(
    suggestionNodes.join(''),
    fullText,
    'Expected stale remote insert metadata to leave the locally grown live insert span intact',
  );
});

test('applyRemoteMarks reanchors authored marks from relative anchors when quote is missing', () => {
  const markId = 'authored:human:michael:stale-range';
  const authoredSchema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'text*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'replace' },
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
      proofComment: {
        attrs: {
          id: { default: null },
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
      proofAuthored: {
        attrs: {
          by: { default: 'human:unknown' },
          id: { default: null },
        },
        inclusive: true,
        spanning: true,
      },
    },
  });

  const doc = authoredSchema.node('doc', null, [
    authoredSchema.node('paragraph', null, authoredSchema.text('alpha beta gamma')),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  const betaRange = resolveQuoteRange(doc, 'beta');
  assert(betaRange, 'Expected to resolve beta range');

  let seededState = EditorState.create({
    schema: authoredSchema,
    doc,
    plugins: [marksStatePlugin],
  });
  seededState = seededState.apply(
    seededState.tr.addMark(
      betaRange!.from,
      betaRange!.to,
      authoredSchema.marks.proofAuthored.create({ by: 'human:michael' }),
    ),
  );
  const seededMetadata = getMarkMetadataForDisk(seededState);
  const seededAuthored = Object.values(seededMetadata).find((entry) => entry.kind === 'authored');
  assert(seededAuthored?.startRel, 'Expected seeded authored mark to produce a startRel anchor');
  assert(seededAuthored?.endRel, 'Expected seeded authored mark to produce an endRel anchor');

  let state = EditorState.create({
    schema: authoredSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const remoteMetadata = {
    [markId]: {
      kind: 'authored' as const,
      by: 'human:michael',
      createdAt: new Date('2026-03-09T00:00:00.000Z').toISOString(),
      range: { from: 999, to: 1000 },
      startRel: seededAuthored!.startRel,
      endRel: seededAuthored!.endRel,
    },
  };

  applyRemoteMarks(view, remoteMetadata);

  const marksAfter = getMarks(state);
  const anchored = marksAfter.find(mark => mark.id === markId);
  assert(anchored !== undefined, 'Expected authored mark to be anchored from relative positions');
  assert(anchored?.range !== undefined, 'Anchored authored mark should include a range');
  assertEqual(getTextForRange(state.doc, anchored!.range!), 'beta', 'Expected relative anchors to resolve the authored text');

  const diskMetadata = getMarkMetadataForDisk(state);
  assert(diskMetadata[markId] !== undefined, 'Expected authored mark to survive disk metadata export after remote apply');
});

test('applyRemoteMarks prunes stale local suggestion anchors when authoritative marks are empty', () => {
  const suggestionId = 's-prune-stale-after-accept';
  const suggestionMark = marksSchema.marks.proofSuggestion.create({
    id: suggestionId,
    kind: 'insert',
    by: 'human:seth',
  });
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [
      marksSchema.text('Alpha '),
      marksSchema.text('ACCEPT TEST', [suggestionMark]),
      marksSchema.text(' gamma.'),
    ]),
  ]);

  const metadata = {
    [suggestionId]: {
      kind: 'insert' as const,
      by: 'human:seth',
      createdAt: '2026-03-24T00:00:00.000Z',
      content: 'ACCEPT TEST',
      quote: 'ACCEPT TEST',
      status: 'pending' as const,
    },
  };

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {}, { pruneMissingSuggestions: true });

  assertEqual(
    state.doc.textBetween(0, state.doc.content.size, '\n', '\n'),
    'Alpha ACCEPT TEST gamma.',
    'Expected stale suggestion pruning to preserve the accepted text once',
  );
  assert(!getMarks(state).some((mark) => mark.id === suggestionId), 'Expected stale suggestion anchors to be removed');
  const pluginState = marksPluginKey.getState(state) as { metadata: Record<string, unknown> } | undefined;
  assert(!pluginState?.metadata?.[suggestionId], 'Expected stale suggestion metadata to be removed');
});

test('API-shaped remote replace suggestion can be accepted after remote apply', () => {
  const markId = 'm-remote-api-accept';
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [marksSchema.text('Dense Marks heading')]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const remoteMetadata = {
    [markId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-03-05T00:00:00.000Z').toISOString(),
      content: 'Dense Marks accepted',
      status: 'pending' as const,
      quote: 'Dense Marks',
    },
  };

  applyRemoteMarks(view, remoteMetadata);

  const anchored = getMarks(state).find((mark) => mark.id === markId);
  assert(anchored !== undefined, 'Remote API suggestion should anchor into the document');

  const accepted = acceptMark(view, markId);
  assert(accepted, 'Accept should succeed for remotely applied API suggestion');

  const docText = state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
  assert(docText.includes('Dense Marks accepted heading'), 'Accepted remote suggestion should update document text');

  const metadata = getMarkMetadata(state);
  assert(!metadata[markId], 'Accepted remote suggestion metadata should be removed');
});

test('applyRemoteMarks anchors long replace quotes without truncation', () => {
  const markId = 'm-remote-api-long';
  const longQuote = `Start ${'a'.repeat(140)} end`;
  const docText = `Before ${longQuote} after.`;
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [marksSchema.text(docText)]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const remoteMetadata = {
    [markId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-03-05T00:00:00.000Z').toISOString(),
      content: 'REPLACED',
      status: 'pending' as const,
      quote: longQuote,
    },
  };

  applyRemoteMarks(view, remoteMetadata);

  const anchored = getMarks(state).find((mark) => mark.id === markId);
  assert(anchored !== undefined, 'Remote long quote suggestion should anchor into the document');
  assert(anchored?.range !== undefined, 'Anchored mark should include a range');
  const anchoredText = getTextForRange(state.doc, anchored!.range!);
  assertEqual(anchoredText, longQuote, 'Remote long quote should anchor to full text');

  const accepted = acceptMark(view, markId);
  assert(accepted, 'Accept should succeed for long remote suggestion');

  const updated = state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
  assert(updated.includes('Before REPLACED after.'), 'Accepted long remote suggestion should replace full quote');
});

test('applyRemoteMarks tags remote transactions as y-sync change-origin', () => {
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [marksSchema.text('Hello world from collab')]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });
  let lastTr: any = null;

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      lastTr = tr;
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {
    'remote-comment': {
      kind: 'comment',
      by: 'human:dan',
      text: 'Remote comment',
      quote: 'world',
      threadId: 'remote-comment',
      thread: [],
      replies: [],
      createdAt: new Date('2026-03-02T12:00:00.000Z').toISOString(),
      resolved: false,
    },
  });

  assert(lastTr, 'Expected applyRemoteMarks to dispatch a transaction');
  assertDeepEqual(lastTr.getMeta(ySyncPluginKey), { isChangeOrigin: true }, 'Remote mark transaction should be tagged as y-sync change-origin');
  assertEqual(lastTr.getMeta('addToHistory'), false, 'Remote mark transaction should not enter history');
});

test('applyRemoteMarks can keep read-only remote marks metadata-only while preserving visible anchors', () => {
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [marksSchema.text('Hello world from collab')]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });
  const beforeDoc = state.doc.toJSON();
  let lastTr: any = null;

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      lastTr = tr;
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {
    'remote-comment': {
      kind: 'comment',
      by: 'human:dan',
      text: 'Remote comment',
      quote: 'world',
      threadId: 'remote-comment',
      thread: [],
      replies: [],
      createdAt: new Date('2026-03-02T12:00:00.000Z').toISOString(),
      resolved: false,
    },
  }, { hydrateAnchors: false });

  assert(lastTr, 'Expected metadata-only remote mark transaction to dispatch');
  assertEqual(lastTr.docChanged, false, 'Read-only remote mark hydration must not mutate the document');
  assertDeepEqual(state.doc.toJSON(), beforeDoc, 'Read-only remote mark hydration must preserve document structure');

  const remoteMark = getMarks(state).find((mark) => mark.id === 'remote-comment');
  assert(remoteMark !== undefined, 'Metadata-only remote mark should still resolve for UI rendering');
  assertEqual(remoteMark?.range?.from, 7, 'Resolved virtual anchor should start at the quoted text');
  assertEqual(remoteMark?.range?.to, 12, 'Resolved virtual anchor should end at the quoted text');
});

test('applyRemoteMarks throttles repeated anchor hydration failures on unchanged docs', () => {
  const markId = 'c-remote-repeat-failure';
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, marksSchema.text('alpha beta gamma')),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const remoteMetadata = {
    [markId]: {
      kind: 'comment' as const,
      by: 'human:test',
      text: 'Remote comment',
      quote: 'delta',
      threadId: markId,
      thread: [],
      replies: [],
      createdAt: new Date('2026-03-07T00:00:00.000Z').toISOString(),
      resolved: false,
    },
  };

  __resetMarkAnchorHydrationFailures();
  applyRemoteMarks(view, remoteMetadata);
  const firstFailure = __getMarkAnchorHydrationFailure(markId);
  assert(firstFailure !== null, 'Expected hydration failure to be recorded');

  applyRemoteMarks(view, remoteMetadata);
  const secondFailure = __getMarkAnchorHydrationFailure(markId);
  assert(secondFailure !== null, 'Expected hydration failure to remain recorded');
  assertEqual(
    secondFailure!.lastAttemptAt,
    firstFailure!.lastAttemptAt,
    'Expected repeated hydration failures to be throttled on unchanged docs'
  );

  __resetMarkAnchorHydrationFailures();
  assert(!getMarks(state).some((mark) => mark.id === markId), 'Failed hydration should not create anchors');
});

test('applyRemoteMarks does not throttle hydration across different docs with same mark id', () => {
  const markId = 'c-remote-cross-doc';
  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  const head = 'a'.repeat(128);
  const tail = 'z'.repeat(128);
  const middleOne = 'b'.repeat(44);
  const middleTwo = `${'c'.repeat(19)}delta${'d'.repeat(20)}`;
  const firstDoc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, marksSchema.text(`${head}${middleOne}${tail}`)),
  ]);
  const secondDoc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, marksSchema.text(`${head}${middleTwo}${tail}`)),
  ]);

  const remoteMetadata = {
    [markId]: {
      kind: 'comment' as const,
      by: 'human:test',
      text: 'Remote comment',
      quote: 'delta',
      threadId: markId,
      thread: [],
      replies: [],
      createdAt: new Date('2026-03-07T00:00:00.000Z').toISOString(),
      resolved: false,
    },
  };

  let firstState = EditorState.create({
    schema: marksSchema,
    doc: firstDoc,
    plugins: [marksStatePlugin],
  });
  const firstView = {
    get state() {
      return firstState;
    },
    dispatch(tr: any) {
      firstState = firstState.apply(tr);
    },
  } as any;

  __resetMarkAnchorHydrationFailures();
  applyRemoteMarks(firstView, remoteMetadata);
  assert(__getMarkAnchorHydrationFailure(markId) !== null, 'Expected first doc hydration failure to be tracked');

  let secondState = EditorState.create({
    schema: marksSchema,
    doc: secondDoc,
    plugins: [marksStatePlugin],
  });
  const secondView = {
    get state() {
      return secondState;
    },
    dispatch(tr: any) {
      secondState = secondState.apply(tr);
    },
  } as any;

  applyRemoteMarks(secondView, remoteMetadata);
  const anchored = getMarks(secondState).find((mark) => mark.id === markId);
  assert(anchored !== undefined, 'Expected second doc hydration to run despite first doc failure');
  assertEqual(getTextForRange(secondState.doc, anchored!.range!), 'delta', 'Expected second doc hydration to anchor quote');

  let hasInlineAnchor = false;
  secondState.doc.nodesBetween(0, secondState.doc.content.size, (node) => {
    if (!node.isText) return;
    if (node.marks.some((mark) => mark.type.name === 'proofComment' && mark.attrs?.id === markId)) {
      hasInlineAnchor = true;
    }
  });
  assert(hasInlineAnchor, 'Expected applyRemoteMarks to insert inline anchor mark into second doc');

  __resetMarkAnchorHydrationFailures();
});

test('applyRemoteMarks caps authored anchor hydration failures per pass', () => {
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, marksSchema.text('alpha beta gamma')),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const remoteMetadata: Record<string, any> = {};
  for (let i = 0; i < 120; i += 1) {
    remoteMetadata[`authored-${i}`] = {
      kind: 'authored',
      by: 'human:test',
      quote: `missing-${i}`,
    };
  }

  __resetMarkAnchorHydrationFailures();
  applyRemoteMarks(view, remoteMetadata);
  const failureCount = __getMarkAnchorHydrationFailureCount();
  assert(failureCount > 0, 'Expected at least one authored hydration failure to be recorded');
  assert(
    failureCount < Object.keys(remoteMetadata).length,
    'Expected authored hydration failures to be capped per pass'
  );
});

test('applyRemoteMarks rejects quote-less relative anchors', () => {
  const markId = 'm-remote-relative-no-quote';
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, marksSchema.text('alpha beta gamma')),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {
    [markId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-02-16T00:00:00.000Z').toISOString(),
      content: 'beta-updated',
      status: 'pending' as const,
      startRel: 'char:6',
      endRel: 'char:10',
    },
  });

  const marksAfter = getMarks(state);
  assert(!marksAfter.some(mark => mark.id === markId), 'Quote-less relative anchors should not create remote marks');
});

test('applyRemoteMarks rejects quote-less stored ranges', () => {
  const markId = 'm-remote-range-no-quote';
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, marksSchema.text('alpha beta gamma')),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {
    [markId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-02-16T00:00:00.000Z').toISOString(),
      content: 'beta-updated',
      status: 'pending' as const,
      range: { from: 7, to: 11 },
    },
  });

  const marksAfter = getMarks(state);
  assert(!marksAfter.some(mark => mark.id === markId), 'Quote-less absolute ranges should not create remote marks');
});

test('applyRemoteMarks prefers contextual target metadata over stale relative anchors', () => {
  const markId = 'm-remote-target-context';
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, marksSchema.text('Repeat early')),
    marksSchema.node('paragraph', null, marksSchema.text('Context target Repeat later')),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {
    [markId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-03-03T00:00:00.000Z').toISOString(),
      content: 'Changed',
      status: 'pending' as const,
      quote: 'Repeat',
      startRel: 'char:0',
      endRel: 'char:6',
      target: {
        anchor: 'Repeat',
        mode: 'exact' as const,
        contextBefore: 'Context target',
      },
    },
  });

  const marksAfter = getMarks(state);
  const anchored = marksAfter.find(mark => mark.id === markId);
  assert(anchored !== undefined, 'Remote target-backed mark should be anchored');
  assert(anchored?.range !== undefined, 'Target-backed mark should include a range');
  const anchoredText = getTextForRange(state.doc, anchored!.range!);
  assertEqual(anchoredText, 'Repeat', 'Contextual target should resolve the quoted text');
  const surroundingText = getTextForRange(state.doc, {
    from: Math.max(0, anchored!.range!.from - 15),
    to: Math.min(state.doc.content.size, anchored!.range!.to + 6),
  });
  assert(surroundingText.includes('Context target Repeat'), 'Contextual target should anchor the duplicate after its stored context');
});

test('applyRemoteMarks normalizes markdown-flavored target metadata onto visible text', () => {
  const markId = 'm-remote-target-markdown-visible';
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, marksSchema.text('one bold thing')),
    marksSchema.node('paragraph', null, marksSchema.text('Context marker one bold thing')),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {
    [markId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-03-11T00:00:00.000Z').toISOString(),
      content: 'Changed',
      status: 'pending' as const,
      quote: 'one bold thing',
      startRel: 'char:0',
      endRel: 'char:14',
      target: {
        anchor: 'one **bold** thing',
        mode: 'normalized' as const,
        contextBefore: 'Context marker',
      },
    },
  });

  const marksAfter = getMarks(state);
  const anchored = marksAfter.find(mark => mark.id === markId);
  assert(anchored !== undefined, 'Markdown-flavored target should still rehydrate onto visible text');
  assert(anchored?.range !== undefined, 'Markdown-flavored target should include a range');
  const anchoredText = getTextForRange(state.doc, anchored!.range!);
  assertEqual(anchoredText, 'one bold thing', 'Markdown-flavored target should normalize to visible quote text');
  const surroundingText = getTextForRange(state.doc, {
    from: Math.max(0, anchored!.range!.from - 20),
    to: Math.min(state.doc.content.size, anchored!.range!.to + 6),
  });
  assert(
    surroundingText.includes('Context marker one bold thing'),
    'Markdown-flavored target should anchor the duplicate selected by visible context',
  );
});

test('applyRemoteMarks honors canonical block separators for target-backed cross-paragraph anchors', () => {
  const markId = 'm-remote-target-cross-paragraph';
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, marksSchema.text('Context marker foo')),
    marksSchema.node('paragraph', null, marksSchema.text('bar')),
    marksSchema.node('paragraph', null, marksSchema.text('foo bar')),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {
    [markId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-03-12T00:00:00.000Z').toISOString(),
      content: 'Changed',
      status: 'pending' as const,
      quote: 'foo bar',
      startRel: 'char:0',
      endRel: 'char:7',
      target: {
        anchor: 'foo\nbar',
        mode: 'exact' as const,
        contextBefore: 'Context marker',
      },
    },
  });

  const marksAfter = getMarks(state);
  const anchored = marksAfter.find(mark => mark.id === markId);
  assert(anchored !== undefined, 'Cross-paragraph target-backed mark should be anchored');
  assert(anchored?.range !== undefined, 'Cross-paragraph target-backed mark should include a range');
  const anchoredText = getTextForRange(state.doc, anchored!.range!);
  assertEqual(anchoredText, 'foo\nbar', 'Cross-paragraph target should rehydrate onto the block-spanning visible text');
  const surroundingText = getTextForRange(state.doc, {
    from: Math.max(0, anchored!.range!.from - 16),
    to: Math.min(state.doc.content.size, anchored!.range!.to + 6),
  });
  assert(
    surroundingText.includes('Context marker foo\nbar'),
    'Cross-paragraph target should stay attached to the block-spanning occurrence selected by context',
  );
});

test('applyRemoteMarks preserves existing comment payload when incoming metadata is partial', () => {
  const commentId = 'c-partial-remote';
  const commentMark = marksSchema.marks.proofComment.create({ id: commentId, by: 'human:dan' });
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [
      marksSchema.text('Hello '),
      marksSchema.text('world', [commentMark]),
    ]),
  ]);

  const existingMetadata = {
    [commentId]: {
      kind: 'comment' as const,
      by: 'human:dan',
      createdAt: new Date('2026-02-22T17:19:00.000Z').toISOString(),
      text: 'Original comment payload',
      threadId: commentId,
      thread: [],
      resolved: false,
    },
  };

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: existingMetadata, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const incomingPartialMetadata = {
    [commentId]: {
      kind: 'comment' as const,
      by: 'human:dan',
      resolved: true,
    },
  };

  applyRemoteMarks(view, incomingPartialMetadata);

  const marksAfter = getMarks(state);
  const comment = marksAfter.find(mark => mark.id === commentId);
  assert(comment !== undefined, 'Comment should still be surfaced after partial remote merge');
  assertEqual((comment?.data as CommentData | undefined)?.text, 'Original comment payload');
  assertEqual(Boolean((comment?.data as CommentData | undefined)?.resolved), true, 'Resolved flag should still update');

  const pluginState = marksPluginKey.getState(state) as { metadata: Record<string, any> } | undefined;
  assertEqual(pluginState?.metadata?.[commentId]?.text, 'Original comment payload');
});

test('reply normalizes thread/replies when metadata shapes diverge', () => {
  const commentId = 'c-reply-normalize';
  const commentMark = marksSchema.marks.proofComment.create({ id: commentId, by: 'human:dan' });
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [
      marksSchema.text('Hello '),
      marksSchema.text('world', [commentMark]),
    ]),
  ]);

  const existingReply = { by: 'ai:test', text: 'Existing reply', at: '2026-03-02T00:00:00.000Z' };
  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({
        metadata: {
          [commentId]: {
            kind: 'comment' as const,
            by: 'human:dan',
            createdAt: new Date('2026-03-02T00:00:00.000Z').toISOString(),
            text: 'Original comment',
            threadId: commentId,
            thread: [],
            replies: [existingReply],
            resolved: false,
          },
        },
        activeMarkId: null,
      }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const result = replyMark(view, commentId, 'human:dan', 'New reply');
  assert(result !== null, 'Reply should return mark anchor');

  const metadata = getMarkMetadata(view.state);
  const stored = metadata[commentId] as any;
  assert(Array.isArray(stored.thread), 'Thread array should be present after reply');
  assert(Array.isArray(stored.replies), 'Replies array should be present after reply');
  assertEqual(stored.thread.length, 2, 'Thread array should preserve existing reply and append new reply');
  assertEqual(stored.replies.length, 2, 'Replies array should preserve existing reply and append new reply');
  assertEqual(stored.threadId, commentId, 'Reply should preserve normalized threadId');
});

test('comment hydration race: remote metadata becomes visible once content hydrates', () => {
  const commentId = 'c-refresh-race';

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  const emptyDoc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, []),
  ]);

  let state = EditorState.create({
    schema: marksSchema,
    doc: emptyDoc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const remoteMetadata = {
    [commentId]: {
      kind: 'comment' as const,
      by: 'human:dan',
      createdAt: new Date('2026-02-26T10:00:00.000Z').toISOString(),
      text: 'This should show after refresh',
      threadId: commentId,
      thread: [],
      resolved: false,
      quote: 'world',
    },
  };

  // Race step 1: metadata arrives before the collab doc content has hydrated.
  applyRemoteMarks(view, remoteMetadata);
  assert(!getMarks(state).some((mark) => mark.id === commentId), 'Comment should not anchor before content exists');

  // Race step 2: document content hydrates later; metadata-only remote marks should
  // become visible immediately without needing a replay mutation.
  const hydratedDoc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [marksSchema.text('Hello world from collab')]),
  ]);
  state = state.apply(state.tr.replaceWith(0, state.doc.content.size, hydratedDoc.content));
  const marksAfterHydration = getMarks(state);
  const comment = marksAfterHydration.find((mark) => mark.id === commentId);
  assert(comment !== undefined, 'Expected hydrated content to surface the existing remote comment');
  const range = comment?.range;
  assert(range !== undefined, 'Expected hydrated comment to include a range');
  assertEqual(getTextForRange(state.doc, range!), 'world');
});

test('applyRemoteMarks ignores finalized suggestion metadata on reload', () => {
  const suggestionId = 's-rejected';
  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc: marksSchema.node('doc', null, [
      marksSchema.node('paragraph', null, [marksSchema.text('Hello world')]),
    ]),
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {
    [suggestionId]: {
      kind: 'replace',
      by: 'ai:test',
      createdAt: new Date('2026-03-04T12:00:00.000Z').toISOString(),
      quote: 'world',
      content: 'Proof',
      status: 'rejected',
    },
  });

  assert(!getMarks(state).some((mark) => mark.id === suggestionId), 'Rejected suggestions should not render on reload');
  const pluginState = marksPluginKey.getState(state) as { metadata: Record<string, unknown> } | undefined;
  assert(!pluginState?.metadata?.[suggestionId], 'Rejected suggestions should not remain in editor metadata snapshots');
});

test('applyRemoteMarks removes existing suggestion anchors when server finalizes them', () => {
  const suggestionId = 's-finalized';
  const suggestionMark = marksSchema.marks.proofSuggestion.create({
    id: suggestionId,
    kind: 'replace',
    by: 'ai:test',
  });

  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [
      marksSchema.text('Hello '),
      marksSchema.text('world', [suggestionMark]),
    ]),
  ]);

  const metadata = {
    [suggestionId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-03-04T12:00:00.000Z').toISOString(),
      content: 'Proof',
      status: 'pending' as const,
    },
  };

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {
    [suggestionId]: {
      kind: 'replace',
      by: 'ai:test',
      createdAt: new Date('2026-03-05T12:00:00.000Z').toISOString(),
      quote: 'world',
      content: 'Proof',
      status: 'accepted',
    },
  });

  assert(!getMarks(state).some((mark) => mark.id === suggestionId), 'Finalized suggestion should be removed from anchors');
  const pluginState = marksPluginKey.getState(state) as { metadata: Record<string, unknown> } | undefined;
  assert(!pluginState?.metadata?.[suggestionId], 'Finalized suggestion should be removed from metadata');
});

test('mergePendingServerMarks keeps critical local fields when server metadata is partial', () => {
  const localMetadata = {
    s1: {
      kind: 'replace' as const,
      by: 'ai:r2c2',
      createdAt: '2026-02-22T17:19:06.487Z',
      content: 'Hello wave',
      status: 'pending' as const,
    },
    c1: {
      kind: 'comment' as const,
      by: 'human:dan',
      createdAt: '2026-02-22T17:21:00.000Z',
      text: 'Thread body',
      threadId: 'c1',
      thread: [],
      resolved: false,
    },
  };

  const serverMetadata = {
    s1: {
      kind: 'replace' as const,
      by: 'ai:r2c2',
      status: 'pending' as const,
    },
    c1: {
      kind: 'comment' as const,
      by: 'human:dan',
      resolved: true,
    },
  };

  const merged = mergePendingServerMarks(localMetadata, serverMetadata);
  assertEqual(merged.s1.content, 'Hello wave', 'Suggestion content should not be dropped by partial server payload');
  assertEqual(merged.s1.createdAt, '2026-02-22T17:19:06.487Z', 'Suggestion createdAt should remain stable');
  assertEqual(merged.c1.text, 'Thread body', 'Comment text should not be dropped by partial server payload');
  assertEqual(Boolean(merged.c1.resolved), true, 'Server-provided resolved flag should still apply');
});

test('canonicalizeStoredMarks collapses equivalent authored duplicates to one canonical id', () => {
  const metadata: Record<string, StoredMark> = {
    'authored:human:Dan:3253-3298': {
      kind: 'authored',
      by: 'human:Dan',
      range: { from: 3302, to: 3347 },
      startRel: 'char:3203',
      endRel: 'char:3248',
      quote: 'Review the Vibe Check, rewrite intro possibly',
    },
    'authored:human:Dan:3302-3347': {
      kind: 'authored',
      by: 'human:Dan',
      range: { from: 3302, to: 3347 },
      startRel: 'char:3203',
      endRel: 'char:3248',
      quote: 'Review the Vibe Check, rewrite intro possibly',
    },
    c1: {
      kind: 'comment',
      by: 'human:dan',
      text: 'keep me',
      threadId: 'c1',
      thread: [],
      resolved: false,
    },
  };

  const canonical = canonicalizeStoredMarks(metadata);
  assertEqual(Object.keys(canonical).length, 2, 'Expected equivalent authored duplicates to collapse');
  const authoredIds = Object.keys(canonical).filter((id) => canonical[id]?.kind === 'authored');
  assertEqual(authoredIds.length, 1, 'Expected one authored entry after canonicalization');
  assert(
    authoredIds[0] === 'authored:human:Dan:3253-3298' || authoredIds[0] === 'authored:human:Dan:3302-3347',
    'Expected one of the equivalent authored ids to survive'
  );
  assert(canonical.c1, 'Expected non-authored marks to be preserved');
});

test('mergePendingServerMarks does not resurrect equivalent authored duplicates', () => {
  const localMetadata: Record<string, StoredMark> = {
    'authored:human:Dan:3302-3347': {
      kind: 'authored',
      by: 'human:Dan',
      range: { from: 3302, to: 3347 },
      startRel: 'char:3203',
      endRel: 'char:3248',
      quote: 'Review the Vibe Check, rewrite intro possibly',
    },
  };

  const serverMetadata: Record<string, StoredMark> = {
    'authored:human:Dan:3253-3298': {
      kind: 'authored',
      by: 'human:Dan',
      range: { from: 3302, to: 3347 },
      startRel: 'char:3203',
      endRel: 'char:3248',
      quote: 'Review the Vibe Check, rewrite intro possibly',
    },
  };

  const merged = mergePendingServerMarks(localMetadata, serverMetadata);
  assertEqual(Object.keys(merged).length, 1, 'Expected merge to keep one authored entry for the same span');
  assert(merged['authored:human:Dan:3302-3347'], 'Expected canonical authored id to win');
  assert(!merged['authored:human:Dan:3253-3298'], 'Expected stale authored duplicate id not to be re-added');
});

test('mergePendingServerMarks drops stale local suggestion metadata when server finalized the mark', () => {
  const merged = mergePendingServerMarks({
    s1: {
      kind: 'replace',
      by: 'ai:r2c2',
      createdAt: '2026-03-04T12:00:00.000Z',
      content: 'delta',
      status: 'pending',
    },
  }, {
    s1: {
      kind: 'replace',
      by: 'ai:r2c2',
      createdAt: '2026-03-04T12:00:00.000Z',
      content: 'delta',
      status: 'rejected',
    },
  });

  assert(!merged.s1, 'Finalized server suggestions should evict stale local pending metadata');
});

test('mergePendingServerMarks preserves locally resolved comments when tombstoned', () => {
  const commentId = 'c-tombstoned';
  const commentMark = marksSchema.marks.proofComment.create({ id: commentId, by: 'human:dan' });
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [
      marksSchema.text('Hello '),
      marksSchema.text('world', [commentMark]),
    ]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const metadata = {
    [commentId]: {
      kind: 'comment' as const,
      by: 'human:dan',
      createdAt: new Date('2026-02-27T12:00:00.000Z').toISOString(),
      text: 'Please resolve this',
      threadId: commentId,
      thread: [],
      resolved: false,
    },
  };

  state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }));

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const resolved = resolveMark(view, commentId);
  assert(resolved, 'Resolve should succeed');

  const localMetadata = getMarkMetadata(view.state);
  const serverMetadata = {
    [commentId]: {
      kind: 'comment' as const,
      by: 'human:dan',
      resolved: false,
    },
  };

  const merged = mergePendingServerMarks(localMetadata, serverMetadata);
  assertEqual(Boolean(merged[commentId]?.resolved), true, 'Tombstoned resolved comments should win over stale server data');
});

test('mergePendingServerMarks expires resolved tombstones after TTL', () => {
  const commentId = 'c-tombstone-expire';
  const commentMark = marksSchema.marks.proofComment.create({ id: commentId, by: 'human:dan' });
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [
      marksSchema.text('Hello '),
      marksSchema.text('world', [commentMark]),
    ]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const metadata = {
    [commentId]: {
      kind: 'comment' as const,
      by: 'human:dan',
      createdAt: new Date('2026-02-27T12:00:00.000Z').toISOString(),
      text: 'Please resolve this',
      threadId: commentId,
      thread: [],
      resolved: false,
    },
  };

  state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }));

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const originalNow = Date.now;
  const baseTime = new Date('2026-02-27T12:30:00.000Z').getTime();
  try {
    Date.now = () => baseTime;
    const resolved = resolveMark(view, commentId);
    assert(resolved, 'Resolve should succeed');

    const localMetadata = getMarkMetadata(view.state);

    Date.now = () => baseTime + (30 * 60 * 1000) + 1000;
    const merged = mergePendingServerMarks(localMetadata, {
      [commentId]: {
        kind: 'comment' as const,
        by: 'human:dan',
        resolved: false,
      },
    });

    assertEqual(Boolean(merged[commentId]?.resolved), false, 'Expired tombstone should allow server resolved=false to win');
  } finally {
    Date.now = originalNow;
  }
});

test('mergePendingServerMarks skips tombstoned deleted comments', () => {
  const commentId = 'c-deleted';
  const commentMark = marksSchema.marks.proofComment.create({ id: commentId, by: 'human:dan' });
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [
      marksSchema.text('Hello '),
      marksSchema.text('world', [commentMark]),
    ]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const metadata = {
    [commentId]: {
      kind: 'comment' as const,
      by: 'human:dan',
      createdAt: new Date('2026-02-27T13:00:00.000Z').toISOString(),
      text: 'Please delete this',
      threadId: commentId,
      thread: [],
      resolved: false,
    },
  };

  state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }));

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const deleted = deleteMark(view, commentId);
  assert(deleted, 'Delete should succeed');

  const localMetadata = getMarkMetadata(view.state);
  assert(!localMetadata[commentId], 'Deleted mark should be removed from local metadata');

  const serverMetadata = {
    [commentId]: {
      kind: 'comment' as const,
      by: 'human:dan',
      resolved: false,
    },
  };

  const merged = mergePendingServerMarks(localMetadata, serverMetadata);
  assert(!merged[commentId], 'Tombstoned deleted comments should not be re-added from server');
});

test('mergePendingServerMarks skips tombstoned resolved suggestions after persisted accept', () => {
  const suggestionId = 's-persisted-accept';
  __resetResolvedMarkTombstones();
  try {
    tombstoneResolvedMarkIds([suggestionId], { reason: 'deleted' });

    const merged = mergePendingServerMarks({}, {
      [suggestionId]: {
        kind: 'insert' as const,
        by: 'human:seth',
        content: ' ACCEPT TEST',
        status: 'pending' as const,
      },
    });

    assert(!merged[suggestionId], 'Tombstoned resolved suggestions should not be re-added from stale collab marks');
  } finally {
    __resetResolvedMarkTombstones();
  }
});

test('mergePendingServerMarks drops tombstoned local-only suggestions after persisted accept', () => {
  const suggestionId = 's-local-stale-after-accept';
  __resetResolvedMarkTombstones();
  try {
    tombstoneResolvedMarkIds([suggestionId], { reason: 'deleted' });

    const merged = mergePendingServerMarks({
      [suggestionId]: {
        kind: 'insert' as const,
        by: 'human:seth',
        content: ' ACCEPT TEST',
        status: 'pending' as const,
      },
    }, {});

    assert(!merged[suggestionId], 'Tombstoned local-only suggestions should be dropped during server merge');
  } finally {
    __resetResolvedMarkTombstones();
  }
});

test('comment anchors without metadata are not surfaced or flushed as empty comments', () => {
  const commentMark = marksSchema.marks.proofComment.create({ id: 'c1', by: 'human:dan' });
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [
      marksSchema.text('Hello '),
      marksSchema.text('world', [commentMark]),
    ]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const marks = getMarks(state);
  assertEqual(marks.filter(m => m.kind === 'comment').length, 0, 'Should not surface comment with missing metadata');
  const flushed = getMarkMetadataWithQuotes(state);
  assert(!('c1' in flushed), 'Should not flush comment metadata when text is missing');

  // Now hydrate metadata; the comment should appear and be flushable.
  const hydrated = {
    c1: {
      kind: 'comment' as const,
      by: 'human:dan',
      createdAt: new Date('2026-02-15T00:00:00.000Z').toISOString(),
      text: 'Hi there',
      threadId: 'c1',
      thread: [],
      resolved: false,
    },
  };
  state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata: hydrated }));
  const hydratedMarks = getMarks(state);
  const comment = hydratedMarks.find(m => m.id === 'c1') as Mark | undefined;
  assert(comment?.kind === 'comment', 'Hydrated comment should be surfaced');
  assertEqual((comment?.data as CommentData | undefined)?.text, 'Hi there');
  const flushedHydrated = getMarkMetadataWithQuotes(state);
  assertEqual((flushedHydrated.c1 as any)?.text, 'Hi there');
});

test('comment anchors with empty text metadata are treated as invalid (not surfaced or flushed)', () => {
  const commentMark = marksSchema.marks.proofComment.create({ id: 'c2', by: 'human:dan' });
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [
      marksSchema.text('Hello '),
      marksSchema.text('world', [commentMark]),
    ]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({
        metadata: {
          c2: {
            kind: 'comment' as const,
            by: 'human:dan',
            createdAt: new Date('2026-02-15T00:00:00.000Z').toISOString(),
            text: '   ',
            threadId: 'c2',
            thread: [],
            resolved: false,
          },
        },
        activeMarkId: null,
      }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  const state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const marks = getMarks(state);
  assert(!marks.some(m => m.id === 'c2'), 'Should not surface empty comment');
  const flushed = getMarkMetadataWithQuotes(state);
  assert(!('c2' in flushed), 'Should not flush empty comment');
});

test('applyRemoteMarks preserves unresolved remote comments in metadata snapshots', () => {
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [marksSchema.text('Hello world from collab')]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const remoteMetadata = {
    'c-unresolved': {
      kind: 'comment' as const,
      by: 'human:dan',
      createdAt: new Date('2026-03-02T12:00:00.000Z').toISOString(),
      text: 'Please resolve this orphaned comment',
      threadId: 'c-unresolved',
      thread: [],
      replies: [],
      resolved: false,
      quote: 'This quote no longer exists in the document',
    },
  };

  applyRemoteMarks(view, remoteMetadata);
  assert(!getMarks(state).some((mark) => mark.id === 'c-unresolved'), 'Unresolvable remote comment should not surface as an anchor');

  const flushed = getMarkMetadataWithQuotes(state);
  assertEqual(flushed['c-unresolved']?.text, 'Please resolve this orphaned comment', 'Metadata snapshot should retain unresolved remote comments');
  assertEqual(flushed['c-unresolved']?.quote, 'This quote no longer exists in the document', 'Snapshot should preserve remote quote for later retries');

  const resolved = resolveMark(view, 'c-unresolved');
  assert(resolved, 'Metadata-only remote comment should still be resolvable locally');

  const afterResolve = getMarkMetadataWithQuotes(state);
  assertEqual(Boolean(afterResolve['c-unresolved']?.resolved), true, 'Resolved flag should persist on unresolved remote comments');
});

test('applyRemoteMarks prunes detached non-comment metadata but keeps detached comments', () => {
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [marksSchema.text('Hello world from collab')]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const remoteMetadata = {
    'c-unresolved': {
      kind: 'comment' as const,
      by: 'human:dan',
      createdAt: new Date('2026-03-02T12:00:00.000Z').toISOString(),
      text: 'Please resolve this orphaned comment',
      threadId: 'c-unresolved',
      thread: [],
      replies: [],
      resolved: false,
      quote: 'This quote no longer exists in the document',
    },
    's-detached': {
      kind: 'insert' as const,
      by: 'ai:test',
      createdAt: new Date('2026-03-02T12:00:00.000Z').toISOString(),
      content: 'orphaned suggestion',
      status: 'pending' as const,
      quote: 'This quote also no longer exists',
    },
  };

  applyRemoteMarks(view, remoteMetadata);

  assert(!getMarks(state).some((mark) => mark.id === 's-detached'), 'Detached suggestion should not surface as an anchor');
  assert(!getMarks(state).some((mark) => mark.id === 'c-unresolved'), 'Detached comment should not surface as an anchor');

  const flushed = getMarkMetadataWithQuotes(state);
  assert(!('s-detached' in flushed), 'Detached non-comment metadata should be pruned from snapshots');
  assertEqual(flushed['c-unresolved']?.text, 'Please resolve this orphaned comment', 'Detached comments should remain in snapshots for later retries');
});

test('metadata snapshots drop detached suggestions after anchor deletion', () => {
  const markId = 's-after-delete';
  const detachedDoc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [marksSchema.text('Anchor text deleted from the document')]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc: detachedDoc,
    plugins: [marksStatePlugin],
  });

  const metadata = {
    [markId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-03-02T12:00:00.000Z').toISOString(),
      content: 'replacement text',
      status: 'pending' as const,
      quote: 'Anchor text that used to exist',
    },
  };

  state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }));

  const flushed = getMarkMetadataWithQuotes(state);
  assert(!flushed[markId], 'Detached suggestion metadata should not flush after its anchor text is deleted');

  const merged = mergePendingServerMarks(flushed, metadata);
  assertEqual(merged[markId]?.content, 'replacement text', 'Server merge may still carry the detached entry before applyRemoteMarks');

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, merged);
  const afterRemoteApply = getMarkMetadataWithQuotes(state);
  assert(!afterRemoteApply[markId], 'Detached suggestion metadata should stay pruned after remote apply and normalization');
});

test('compose anchor range is transient UI state and is not persisted into metadata', () => {
  const commentId = 'c-compose-anchor';
  const commentMark = marksSchema.marks.proofComment.create({ id: commentId, by: 'human:dan' });
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, [
      marksSchema.text('Hello '),
      marksSchema.text('world', [commentMark]),
    ]),
  ]);

  const metadata = {
    [commentId]: {
      kind: 'comment' as const,
      by: 'human:dan',
      createdAt: new Date('2026-02-24T12:00:00.000Z').toISOString(),
      text: 'Anchor this',
      threadId: commentId,
      thread: [],
      resolved: false,
    },
  };

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata, activeMarkId: null, composeAnchorRange: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        if (meta?.type === 'SET_COMPOSE_ANCHOR') {
          return { ...value, composeAnchorRange: meta.range ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema: marksSchema,
    doc,
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const composeRange = { from: 7, to: 12 };
  setComposeAnchorRange(view, composeRange);
  assertDeepEqual(getComposeAnchorRange(state), composeRange, 'Compose anchor range should be set in plugin state');

  const flushed = getMarkMetadataWithQuotes(state);
  assert(Object.keys(flushed).length === 1 && Boolean(flushed[commentId]), 'Metadata flush should only contain mark entries');
  assert(!('composeAnchorRange' in (flushed as Record<string, unknown>)), 'Compose anchor should not be flushed to metadata');

  setComposeAnchorRange(view, null);
  assertEqual(getComposeAnchorRange(state), null, 'Compose anchor range should clear');
});

test('resolveMarks returns multiple ranges for split marks', () => {
  const markType = marksSchema.marks.proofSuggestion;
  const mark = markType.create({ id: 'm1', kind: 'replace', by: 'ai:test' });
  const doc = marksSchema.node('doc', null, [
    marksSchema.node('paragraph', null, marksSchema.text('hello', [mark])),
    marksSchema.node('paragraph', null, marksSchema.text('world', [mark])),
  ]);

  const resolved = resolveMarks(doc, [{
    id: 'm1',
    kind: 'replace',
    by: 'ai:test',
    at: '2025-01-01T00:00:00.000Z',
    quote: 'hello world',
    data: { content: 'x', status: 'pending' },
  }]);

  assert(resolved.length === 1, 'Should resolve one mark');
  assertEqual(resolved[0].resolvedRanges?.length, 2);
});

// ============================================================================
// Mark Query Tests
// ============================================================================

console.log('\n=== Mark Queries ===');

test('getMarksByKind filters by kind', () => {
  const marks: Mark[] = [
    createApproval('text1', 'human:dan'),
    createFlag('text2', 'ai:claude'),
    createApproval('text3', 'ai:claude'),
  ];
  const approvals = getMarksByKind(marks, 'approved');
  assertEqual(approvals.length, 2);
});

test('getMarksByActor filters by actor', () => {
  const marks: Mark[] = [
    createApproval('text1', 'human:dan'),
    createFlag('text2', 'ai:claude'),
    createApproval('text3', 'ai:claude'),
  ];
  const claudeMarks = getMarksByActor(marks, 'ai:claude');
  assertEqual(claudeMarks.length, 2);
});

test('getPendingSuggestions returns only pending', () => {
  const insert = createInsertSuggestion('text', 'ai:claude', 'content');
  const del = createDeleteSuggestion('text2', 'ai:claude');
  const approval = createApproval('text3', 'human:dan');

  const marks = [insert, del, approval];
  const pending = getPendingSuggestions(marks);
  assertEqual(pending.length, 2);
});

test('getUnresolvedComments returns unresolved only', () => {
  const comment1 = createComment('text1', 'human:dan', 'Question?');
  const comment2 = createComment('text2', 'ai:claude', 'Another question');

  const marks = [comment1, comment2];
  const unresolved = getUnresolvedComments(marks);
  assertEqual(unresolved.length, 2);
});

test('findMark finds by ID', () => {
  const mark = createApproval('text', 'human:dan');
  const marks = [mark];
  const found = findMark(marks, mark.id);
  assert(found !== undefined, 'Should find mark');
  assertEqual(found!.id, mark.id);
});

// ============================================================================
// Mark Operations Tests
// ============================================================================

console.log('\n=== Mark Operations ===');

test('addMark adds mark to array', () => {
  const marks: Mark[] = [];
  const mark = createApproval('text', 'human:dan');
  const result = addMark(marks, mark);
  assertEqual(result.length, 1);
  assertEqual(result[0].id, mark.id);
});

test('removeMark removes mark by ID', () => {
  const mark = createApproval('text', 'human:dan');
  const marks = [mark];
  const result = removeMark(marks, mark.id);
  assertEqual(result.length, 0);
});

test('acceptSuggestion updates status', () => {
  const mark = createInsertSuggestion('text', 'ai:claude', 'content');
  const marks = [mark];
  const result = acceptSuggestion(marks, mark.id);
  assertEqual((result[0].data as any).status, 'accepted');
});

test('rejectSuggestion updates status', () => {
  const mark = createDeleteSuggestion('text', 'ai:claude');
  const marks = [mark];
  const result = rejectSuggestion(marks, mark.id);
  assertEqual((result[0].data as any).status, 'rejected');
});

test('modifySuggestion updates content', () => {
  const mark = createInsertSuggestion('text', 'ai:claude', 'original');
  const marks = [mark];
  const result = modifySuggestion(marks, mark.id, 'modified');
  assertEqual((result[0].data as any).content, 'modified');
});

test('resolveComment resolves thread', () => {
  const comment = createComment('text', 'human:dan', 'Question?');
  const marks = [comment];
  const result = resolveComment(marks, comment.id);
  assertEqual((result[0].data as CommentData).resolved, true);
});

test('unresolveComment unresolves thread', () => {
  const comment = createComment('text', 'human:dan', 'Question?');
  let marks = [comment];
  marks = resolveComment(marks, comment.id);
  marks = unresolveComment(marks, comment.id);
  assertEqual((marks[0].data as CommentData).resolved, false);
});

test('getThread expands replies stored on comment', () => {
  const comment = createComment('text', 'human:dan', 'Question?');
  const data = comment.data as CommentData;
  data.replies = [
    { by: 'ai:test', text: 'Reply here', at: '2025-01-01T00:00:00Z' },
  ];
  const thread = getThread([comment], data.thread);
  assertEqual(thread.length, 2);
  assertEqual((thread[1].data as CommentData).text, 'Reply here');
});

// ============================================================================
// Metadata Serialization Tests
// ============================================================================

console.log('\n=== Metadata Serialization ===');

test('embedMarks adds marks block to markdown', () => {
  const markdown = '# Title\n\nSome content.';
  const mark = createApproval('Some content', 'human:dan');
  const metadata = {
    [mark.id]: { kind: mark.kind, by: mark.by, createdAt: mark.at },
  };
  const result = embedMarks(markdown, metadata);
  assert(result.includes('<!-- PROOF'), 'Should have marks block');
  assert(result.includes(mark.id), 'Should contain mark ID');
});

test('extractMarks extracts metadata from markdown', () => {
  const markdown = '# Title\n\nSome content.';
  const mark = createApproval('Some content', 'human:dan');
  const metadata = {
    [mark.id]: { kind: mark.kind, by: mark.by, createdAt: mark.at },
  };
  const embedded = embedMarks(markdown, metadata);
  const { content, marks } = extractMarks(embedded);
  assertEqual(Object.keys(marks).length, 1);
  assertEqual(marks[mark.id].kind, mark.kind);
  assert(!content.includes('<!-- PROOF'), 'Content should not have marks block');
});

test('extractMarks handles no marks', () => {
  const markdown = '# Title\n\nSome content.';
  const { content, marks } = extractMarks(markdown);
  assertEqual(content, markdown);
  assertEqual(Object.keys(marks).length, 0);
});

test('extractMarks drops finalized suggestion metadata', () => {
  const markdown = embedMarks('Hello world', {
    rejected: {
      kind: 'replace',
      by: 'ai:test',
      createdAt: '2026-03-04T12:00:00.000Z',
      quote: 'world',
      content: 'Proof',
      status: 'rejected',
    },
    comment: {
      kind: 'comment',
      by: 'human:test',
      createdAt: '2026-03-04T12:00:00.000Z',
      text: 'Keep me',
      threadId: 'comment',
      thread: [],
      resolved: false,
    },
  });

  const result = extractMarks(markdown);
  assert(!result.marks.rejected, 'Rejected suggestions should not be rehydrated from embedded metadata');
  assert(result.marks.comment?.kind === 'comment', 'Non-finalized non-suggestion metadata should remain');
});

test('removeFinalizedSuggestionMetadata drops accepted/rejected suggestions only', () => {
  const filtered = removeFinalizedSuggestionMetadata({
    accepted: {
      kind: 'insert',
      by: 'ai:test',
      createdAt: '2026-03-04T12:00:00.000Z',
      content: 'Proof',
      status: 'accepted',
    },
    rejected: {
      kind: 'delete',
      by: 'ai:test',
      createdAt: '2026-03-04T12:00:00.000Z',
      status: 'rejected',
    },
    pending: {
      kind: 'replace',
      by: 'ai:test',
      createdAt: '2026-03-04T12:00:00.000Z',
      content: 'Proof',
      status: 'pending',
    },
    comment: {
      kind: 'comment',
      by: 'human:test',
      createdAt: '2026-03-04T12:00:00.000Z',
      text: 'Keep me',
      threadId: 'comment',
      thread: [],
      resolved: false,
    },
  });

  assert(!filtered.accepted, 'Accepted suggestions should be removed');
  assert(!filtered.rejected, 'Rejected suggestions should be removed');
  assert(filtered.pending?.status === 'pending', 'Pending suggestions should remain');
  assert(filtered.comment?.kind === 'comment', 'Comments should remain');
});

test('hasMarks detects marks block', () => {
  const markdown = '# Title\n\nSome content.';
  const mark = createApproval('Some content', 'human:dan');
  const embedded = embedMarks(markdown, {
    [mark.id]: { kind: mark.kind, by: mark.by, createdAt: mark.at },
  });
  assert(hasMarks(embedded), 'Should detect marks');
  assert(!hasMarks(markdown), 'Should not detect marks in plain markdown');
});

test('round-trip preserves metadata', () => {
  const markdown = '# Title\n\nSome content.';
  const marks = [
    createApproval('Some content', 'human:dan'),
    createFlag('Title', 'ai:claude', 'Review needed'),
    createInsertSuggestion('content', 'ai:claude', ' additional'),
  ];
  const metadata = Object.fromEntries(
    marks.map(mark => [mark.id, { kind: mark.kind, by: mark.by, createdAt: mark.at }])
  );

  const embedded = embedMarks(markdown, metadata);
  const extracted = extractMarks(embedded);

  assertEqual(Object.keys(extracted.marks).length, marks.length);
  for (const mark of marks) {
    assertEqual(extracted.marks[mark.id].kind, mark.kind);
  }
});

// ============================================================================
// Actor Helper Tests
// ============================================================================

console.log('\n=== Actor Helpers ===');

test('isHuman detects human actors', () => {
  assert(isHuman('human:dan'), 'Should detect human');
  assert(!isHuman('ai:claude'), 'Should not detect AI as human');
});

test('isAI detects AI actors', () => {
  assert(isAI('ai:claude'), 'Should detect AI');
  assert(!isAI('human:dan'), 'Should not detect human as AI');
});

test('getActorName extracts name', () => {
  assertEqual(getActorName('human:dan'), 'dan');
  assertEqual(getActorName('ai:claude'), 'claude');
});

// ============================================================================
// Provenance Serialization Guard Tests
// ============================================================================

console.log('\n=== Embedded Provenance Guard ===');

test('extractEmbeddedProvenance strips trailing serialization artifacts', () => {
  const artifact = `# ${'='.repeat(20)}`;
  const input = [
    'Intro line',
    '',
    '# This approach embraces the reality that documents are living artifacts.',
    '',
    artifact,
    '',
    artifact,
    '',
    artifact,
    '',
  ].join('\n');
  const output = wrapWithProvenance(input);
  const { content } = extractEmbeddedProvenance(output);

  assert(!content.includes(artifact), 'Artifact headings should be stripped');
  assert(!content.includes('# This approach embraces'), 'Heading should be demoted');
  assert(content.includes('This approach embraces'), 'Paragraph should remain');
});

test('extractEmbeddedProvenance preserves single separator line', () => {
  const separator = `# ${'='.repeat(20)}`;
  const input = ['Intro line', '', separator].join('\n');
  const output = wrapWithProvenance(input);
  const { content } = extractEmbeddedProvenance(output);

  assert(content.includes(separator), 'Single separator line should remain');
});

test('proofMarkHandler renders inline formatting as markdown', () => {
  const node = {
    type: 'proofMark',
    proof: 'comment',
    attrs: { id: 'm1', by: 'human:dan' },
    children: [
      {
        type: 'strong',
        children: [{ type: 'text', value: 'Hello' }],
      },
    ],
  };
  const md = proofMarkHandler(node as any);
  assert(md.includes('data-proof="comment"'), 'Should include proof attribute');
  assert(md.includes('**Hello**'), 'Should render strong as markdown');
  assert(!md.includes('<strong>'), 'Should not emit HTML strong tags');
});

test('proofMarkHandler renders suggestion spans with kind', () => {
  const node = {
    type: 'proofMark',
    proof: 'suggestion',
    attrs: { id: 'm2', by: 'ai:test', kind: 'replace' },
    children: [{ type: 'text', value: 'Hello' }],
  };
  const html = proofMarkHandler(node as any);
  assert(html.includes('data-proof="suggestion"'), 'Should include suggestion proof attribute');
  assert(html.includes('data-kind="replace"'), 'Should include suggestion kind');
  assert(html.includes('data-id="m2"'), 'Should include suggestion id');
  assert(html.includes('data-by="ai:test"'), 'Should include suggestion actor');
});

test('remarkProofMarks converts split proof spans into nodes', () => {
  const tree = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          {
            type: 'html',
            value: '<span data-proof="comment" data-id="m1" data-by="human:dan">',
          },
          {
            type: 'text',
            value: 'Hello',
          },
          {
            type: 'html',
            value: '</span>',
          },
        ],
      },
    ],
  };

  remarkProofMarks()(tree as any);
  const paragraph = (tree.children as any[])[0];
  const children = paragraph.children as any[];
  assertEqual(children.length, 1, 'Expected a single proofMark node');
  const mark = children[0];
  assertEqual(mark.type, 'proofMark');
  assertEqual(mark.proof, 'comment');
  assertEqual(mark.attrs?.id, 'm1');
  assertEqual(mark.attrs?.by, 'human:dan');
  assertEqual(mark.children?.[0]?.value, 'Hello');
});

test('remarkProofMarks preserves suggestion kind attrs', () => {
  const tree = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          {
            type: 'html',
            value: '<span data-proof="suggestion" data-id="m3" data-by="ai:test" data-kind="insert">',
          },
          {
            type: 'text',
            value: 'Hi',
          },
          {
            type: 'html',
            value: '</span>',
          },
        ],
      },
    ],
  };

  remarkProofMarks()(tree as any);
  const paragraph = (tree.children as any[])[0];
  const children = paragraph.children as any[];
  assertEqual(children.length, 1, 'Expected a single proofMark node');
  const mark = children[0];
  assertEqual(mark.type, 'proofMark');
  assertEqual(mark.proof, 'suggestion');
  assertEqual(mark.attrs?.id, 'm3');
  assertEqual(mark.attrs?.by, 'ai:test');
  assertEqual(mark.attrs?.kind, 'insert');
});

test('remarkProofMarks converts legacy <code> html nodes to inlineCode (split path)', () => {
  // Simulates remark parsing: <span data-proof="authored" data-by="ai:claude">Use the <code>Write</code> tool</span>
  const tree = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'html', value: '<span data-proof="authored" data-by="ai:claude">' },
          { type: 'text', value: 'Use the ' },
          { type: 'html', value: '<code>' },
          { type: 'text', value: 'Write' },
          { type: 'html', value: '</code>' },
          { type: 'text', value: ' tool' },
          { type: 'html', value: '</span>' },
        ],
      },
    ],
  };

  remarkProofMarks()(tree as any);
  const paragraph = (tree.children as any[])[0];
  const mark = paragraph.children[0];
  assertEqual(mark.type, 'proofMark');
  assertEqual(mark.children.length, 3, 'Expected 3 children: text, inlineCode, text');
  assertEqual(mark.children[0].type, 'text');
  assertEqual(mark.children[0].value, 'Use the ');
  assertEqual(mark.children[1].type, 'inlineCode');
  assertEqual(mark.children[1].value, 'Write');
  assertEqual(mark.children[2].type, 'text');
  assertEqual(mark.children[2].value, ' tool');
});

test('parseProofHtml handles <code> in inline proof spans', () => {
  // Simulates a single html node containing the entire span with <code>
  const tree = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          {
            type: 'html',
            value: '<span data-proof="authored" data-by="ai:claude">Use <code>Write</code></span>',
          },
        ],
      },
    ],
  };

  remarkProofMarks()(tree as any);
  const paragraph = (tree.children as any[])[0];
  const mark = paragraph.children[0];
  assertEqual(mark.type, 'proofMark');
  assertEqual(mark.children.length, 2, 'Expected 2 children: text, inlineCode');
  assertEqual(mark.children[0].type, 'text');
  assertEqual(mark.children[0].value, 'Use ');
  assertEqual(mark.children[1].type, 'inlineCode');
  assertEqual(mark.children[1].value, 'Write');
});

test('proofMarkHandler renders authored spans with markdown formatting', () => {
  const node = {
    type: 'proofMark',
    proof: 'authored',
    attrs: { by: 'human:dan' },
    children: [
      {
        type: 'text',
        value: 'Hello ',
      },
      {
        type: 'strong',
        children: [{ type: 'text', value: 'bold' }],
      },
      {
        type: 'text',
        value: ' and ',
      },
      {
        type: 'emphasis',
        children: [{ type: 'text', value: 'italic' }],
      },
      {
        type: 'text',
        value: ' with ',
      },
      {
        type: 'inlineCode',
        value: 'code',
      },
    ],
  };
  const md = proofMarkHandler(node as any);
  assert(md.includes('data-proof="authored"'), 'Should include authored proof attribute');
  assert(md.includes('**bold**'), 'Should render strong as markdown');
  assert(md.includes('*italic*'), 'Should render emphasis as markdown');
  assert(md.includes('`code`'), 'Should render inlineCode as backticks');
  assert(!md.includes('<strong>'), 'Should not emit HTML strong tags');
  assert(!md.includes('<em>'), 'Should not emit HTML em tags');
  assert(!md.includes('<code>'), 'Should not emit HTML code tags');
});

test('extractEmbeddedProvenance preserves authored proof spans', () => {
  const input = '<span data-proof="authored" data-by="ai:unknown">Hello</span>';
  const { content } = extractEmbeddedProvenance(input);
  assertEqual(content, input);
});

test('extractEmbeddedProvenance preserves non-authored proof spans', () => {
  const input = '<span data-proof="comment" data-id="m1" data-by="human:dan">Hello</span>';
  const { content } = extractEmbeddedProvenance(input);
  assertEqual(content, input);
});

test('migrateProvenanceToMarks keeps human spans and drops AI spans', () => {
  const legacy = {
    spans: [
      { spanId: 's1', startOffset: 0, endOffset: 5, origin: 'human.written' },
      { spanId: 's2', startOffset: 6, endOffset: 10, origin: 'ai.generated' },
      { spanId: 's3', startOffset: 12, endOffset: 17, origin: 'human.edited' },
    ],
  };

  const docText = 'Hello AIish Human';
  const marks = migrateProvenanceToMarks(legacy, docText);

  assertEqual(marks.length, 2);
  assertEqual(marks[0].by, 'human:migrated');
  assertEqual(marks[0].range?.from, 0);
  assertEqual(marks[0].range?.to, 5);
  assertEqual(marks[1].by, 'human:migrated');
  assertEqual(marks[1].range?.from, 12);
  assertEqual(marks[1].range?.to, 17);
});

test('unmarked text counts as AI in authorship stats', () => {
  const marks: Mark[] = [
    {
      id: 'authored:human:dan:0-4',
      kind: 'authored',
      by: 'human:dan',
      at: '1970-01-01T00:00:00.000Z',
      range: { from: 0, to: 4 },
      quote: 'Test',
      data: {},
    },
  ];

  const stats = calculateAuthorshipStats(marks, 10);
  assertEqual(stats.humanChars, 4);
  assertEqual(stats.aiChars, 6);
  assertEqual(stats.humanPercent, 40);
  assertEqual(stats.aiPercent, 60);
});

test('accept parses markdown replacements into inline marks when parser is provided', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'replace' },
          by: { default: 'unknown' },
          status: { default: 'pending' },
          content: { default: null },
          createdAt: { default: null },
          updatedAt: { default: null },
        },
        inclusive: false,
        spanning: true,
      },
      proofAuthored: {
        attrs: {
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
      em: {
        inclusive: true,
      },
    },
  });

  const markId = 'm-markdown-accept';
  const suggestionMark = schema.marks.proofSuggestion.create({
    id: markId,
    kind: 'replace',
    by: 'ai:test',
  });

  const initialDoc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('This is '),
      schema.text('italic.', [suggestionMark]),
    ]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema,
    doc: initialDoc,
    plugins: [marksStatePlugin],
  });

  const metadata = {
    [markId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-01-28T00:00:00.000Z').toISOString(),
      content: '*italic*.',
      status: 'pending' as const,
    },
  };

  state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }));

  const parser = (_markdown: string) =>
    schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('italic', [schema.marks.em.create()]),
        schema.text('.'),
      ]),
    ]);

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const accepted = acceptMark(view, markId, parser);
  assert(accepted, 'Accept should succeed');

  const docText = state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
  assert(!docText.includes('*'), 'Accepted document should not contain raw markdown tokens');

  let hasEmphasis = false;
  let hasSuggestion = false;
  state.doc.descendants((node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name === 'em') hasEmphasis = true;
      if (mark.type.name === 'proofSuggestion') hasSuggestion = true;
    }
    return true;
  });

  assert(hasEmphasis, 'Accepted document should include emphasis marks from parsed markdown');
  assert(!hasSuggestion, 'Suggestion mark should be removed after accept');
});

test('accept preserves leading whitespace for insert suggestions', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'insert' },
          by: { default: 'unknown' },
          status: { default: 'pending' },
          content: { default: null },
          createdAt: { default: null },
          updatedAt: { default: null },
        },
        inclusive: false,
        spanning: true,
      },
      proofAuthored: {
        attrs: {
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
    },
  });

  const markId = 'm-insert-leading-space';
  const insertText = ' [ACCEPT_TEST]';
  const suggestionMark = schema.marks.proofSuggestion.create({
    id: markId,
    kind: 'insert',
    by: 'ai:test',
  });

  const initialDoc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('Hello'),
      schema.text(insertText, [suggestionMark]),
    ]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema,
    doc: initialDoc,
    plugins: [marksStatePlugin],
  });

  const metadata = {
    [markId]: {
      kind: 'insert' as const,
      by: 'ai:test',
      createdAt: new Date('2026-02-11T00:00:00.000Z').toISOString(),
      content: insertText,
      status: 'pending' as const,
    },
  };

  state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }));

  // Simulate a markdown parser that drops edge whitespace around inline content.
  const parser = (_markdown: string) =>
    schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('[ACCEPT_TEST]')]),
    ]);

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const accepted = acceptMark(view, markId, parser);
  assert(accepted, 'Accept should succeed');

  const docText = state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
  assertEqual(
    docText,
    'Hello [ACCEPT_TEST]',
    `Leading whitespace should be preserved after accept (actual: "${docText}")`
  );
});

test('shared insert suggestions preserve metadata content and accept/reject operate at the anchor point', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'insert' },
          by: { default: 'unknown' },
          status: { default: 'pending' },
          content: { default: null },
          createdAt: { default: null },
          updatedAt: { default: null },
        },
        inclusive: false,
        spanning: true,
      },
      proofAuthored: {
        attrs: {
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
    },
  });

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  const createView = (markId: string) => {
    const metadata: Record<string, StoredMark> = {
      [markId]: {
        kind: 'insert',
        by: 'ai:test',
        createdAt: new Date('2026-02-11T00:00:00.000Z').toISOString(),
        quote: 'Alpha',
        content: ' beta',
        status: 'pending',
        startRel: 'char:0',
        endRel: 'char:5',
      },
    };
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text('Alpha gamma.')]),
      ]),
      plugins: [marksStatePlugin],
    });
    const view = {
      get state() {
        return state;
      },
      dispatch(tr: any) {
        state = state.apply(tr);
      },
    } as any;
    applyRemoteMarks(view, metadata, { hydrateAnchors: true });
    return { view, getText: () => state.doc.textBetween(0, state.doc.content.size, '\n', '\n') };
  };

  const acceptMarkId = 'm-shared-insert-anchor-accept';
  const acceptCase = createView(acceptMarkId);
  const hydratedInsert = getMarks(acceptCase.view.state).find((mark) => mark.id === acceptMarkId);
  assert(hydratedInsert, 'Hydrated insert mark should exist');
  assertEqual(
    (hydratedInsert!.data as InsertData | undefined)?.content,
    ' beta',
    'Hydrated insert mark should preserve metadata content instead of substituting the anchor quote',
  );
  const parser = (_markdown: string) =>
    schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(' beta')]),
    ]);
  const accepted = acceptMark(acceptCase.view, acceptMarkId, parser as any);
  assert(accepted, 'Accept should succeed for a shared anchor-based insert suggestion');
  assertEqual(
    acceptCase.getText(),
    'Alpha beta gamma.',
    'Accept should insert shared suggestion content after the anchor quote',
  );

  const rejectMarkId = 'm-shared-insert-anchor-reject';
  const rejectCase = createView(rejectMarkId);
  const rejected = rejectMark(rejectCase.view, rejectMarkId);
  assert(rejected, 'Reject should succeed for a shared anchor-based insert suggestion');
  assertEqual(
    rejectCase.getText(),
    'Alpha gamma.',
    'Reject should preserve the anchor quote instead of deleting it',
  );
});

test('metadata-only insert suggestions with collapsed ranges rehydrate at the insertion point', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'insert' },
          by: { default: 'unknown' },
          status: { default: 'pending' },
          content: { default: null },
          createdAt: { default: null },
          updatedAt: { default: null },
        },
        inclusive: false,
        spanning: true,
      },
      proofAuthored: {
        attrs: {
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
    },
  });

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  const markId = 'm-collapsed-insert-anchor';
  const metadata: Record<string, StoredMark> = {
    [markId]: {
      kind: 'insert',
      by: 'human:test',
      createdAt: new Date('2026-03-22T12:00:00.000Z').toISOString(),
      content: ' brave',
      status: 'pending',
      range: { from: 18, to: 18 },
    },
  };

  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Alpha beta gamma.')]),
    ]),
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, metadata, { hydrateAnchors: true });
  const hydratedInsert = getMarks(view.state).find((mark) => mark.id === markId);
  assert(hydratedInsert, 'Collapsed-range insert metadata should hydrate into an actionable mark');
  assertDeepEqual(
    hydratedInsert!.range,
    { from: 18, to: 18 },
    'Hydrated insert should preserve the collapsed insertion point',
  );
  assertEqual(
    (hydratedInsert!.data as InsertData | undefined)?.content,
    ' brave',
    'Hydrated collapsed insert should preserve its pending content',
  );
  const flushed = getMarkMetadataWithQuotes(view.state);
  assertEqual(
    flushed[markId]?.content,
    ' brave',
    'Collapsed-range insert metadata should remain flushable after normalization',
  );
  const decorations = __debugDescribeDecorations(
    view.state,
    getMarks(view.state),
    null,
    null,
    'simple',
  );
  assert(
    decorations.some((decoration) =>
      decoration.markId === markId
      && decoration.decorationRole === 'replace-preview'
      && decoration.text === ' brave'
    ),
    'Collapsed-range insert should render a simple-markup preview widget',
  );

  const parser = (_markdown: string) =>
    schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(' brave')]),
    ]);
  const accepted = acceptMark(view, markId, parser as any);
  assert(accepted, 'Accept should succeed for a collapsed-range insert suggestion');
  assertEqual(
    view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n'),
    'Alpha beta gamma. brave',
    'Accept should insert collapsed-range suggestion content at the stored insertion point',
  );
});

test('applyRemoteMarks materializes collapsed insert metadata onto existing plain text instead of rendering a widget duplicate', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'insert' },
          by: { default: 'unknown' },
          status: { default: 'pending' },
          content: { default: null },
          createdAt: { default: null },
          updatedAt: { default: null },
        },
        inclusive: false,
        spanning: true,
      },
      proofAuthored: {
        attrs: {
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
    },
  });

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        return value;
      },
    },
  });

  const markId = 'm-materialized-collapsed-insert';
  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Alpha brave beta gamma.')]),
    ]),
    plugins: [marksStatePlugin],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  applyRemoteMarks(view, {
    [markId]: {
      kind: 'insert',
      by: 'human:test',
      createdAt: new Date('2026-03-28T12:00:00.000Z').toISOString(),
      content: ' brave',
      status: 'pending',
      range: { from: 6, to: 6 },
    },
  }, { hydrateAnchors: true });

  const materializedInsert = getMarks(view.state).find((mark) => mark.id === markId);
  assert(materializedInsert, 'Collapsed insert metadata should remain actionable when its text is already materialized in the document');
  assertDeepEqual(
    materializedInsert!.range,
    { from: 6, to: 12 },
    'Materialized plain insert text should resolve to the live inserted span instead of staying collapsed',
  );

  const decorations = __debugDescribeDecorations(
    view.state,
    getMarks(view.state),
    null,
    null,
    'simple',
  );
  assert(
    !decorations.some((decoration) =>
      decoration.markId === markId
      && decoration.decorationRole === 'replace-preview'
      && decoration.text === ' brave'
    ),
    'Materialized collapsed inserts should not render a preview widget duplicate once the inserted text already exists',
  );
  assert(
    decorations.some((decoration) =>
      decoration.markId === markId
      && decoration.to > decoration.from
      && decoration.className.includes('mark-insert')
      && decoration.decorationRole === 'inline-mark'
    ),
    'Materialized collapsed inserts should render as a single inline insert decoration over the existing text',
  );
});

test('accept does not duplicate split insert suggestions that already exist in the document', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'insert' },
          by: { default: 'unknown' },
          status: { default: 'pending' },
          content: { default: null },
          createdAt: { default: null },
          updatedAt: { default: null },
        },
        inclusive: false,
        spanning: true,
      },
      proofAuthored: {
        attrs: {
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
    },
  });

  const markId = 'm-split-insert-accept';
  const suggestionMark = schema.marks.proofSuggestion.create({
    id: markId,
    kind: 'insert',
    by: 'ai:test',
  });

  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Baseline '),
        schema.text('TRACE ', [suggestionMark]),
        schema.text('FIX '),
        schema.text('TEST', [suggestionMark]),
      ]),
    ]),
    plugins: [new Plugin({
      key: marksPluginKey,
      state: {
        init: () => ({
          metadata: {
            [markId]: {
              kind: 'insert',
              by: 'ai:test',
              createdAt: new Date('2026-03-24T00:00:00.000Z').toISOString(),
              content: 'TRACE FIX TEST',
              status: 'pending',
              quote: 'TRACE FIX TEST',
            },
          },
          activeMarkId: null,
        }),
        apply: (tr, value) => {
          const meta = tr.getMeta(marksPluginKey);
          if (meta?.type === 'SET_METADATA') {
            return { ...value, metadata: meta.metadata };
          }
          if (meta?.type === 'SET_ACTIVE') {
            return { ...value, activeMarkId: meta.markId ?? null };
          }
          return value;
        },
      },
    })],
  });

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const accepted = acceptMark(view, markId);
  assert(accepted, 'Accept should succeed for split insert suggestions');
  assertEqual(
    state.doc.textBetween(0, state.doc.content.size, '\n', '\n'),
    'Baseline TRACE FIX TEST',
    'Accept should preserve the existing inserted text once instead of materializing a duplicate copy',
  );
  const remaining = getMarks(state).find((mark) => mark.id === markId);
  assert(!remaining, 'Accept should remove the split insert suggestion mark');
});

test('accept preserves heading style for non-structural full-block replacements', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      heading: {
        attrs: { level: { default: 2 } },
        content: 'inline*',
        group: 'block',
      },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'replace' },
          by: { default: 'unknown' },
          status: { default: 'pending' },
          content: { default: null },
          createdAt: { default: null },
          updatedAt: { default: null },
        },
        inclusive: false,
        spanning: true,
      },
      proofAuthored: {
        attrs: {
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
      em: {
        inclusive: true,
      },
    },
  });

  const markId = 'm-heading-style-preserve';
  const suggestionMark = schema.marks.proofSuggestion.create({
    id: markId,
    kind: 'replace',
    by: 'ai:test',
  });

  const initialDoc = schema.node('doc', null, [
    schema.node('heading', { level: 2 }, [
      schema.text('Feature 1: Always-On Agent Mode (Double-Click Sidebar)', [suggestionMark]),
    ]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema,
    doc: initialDoc,
    plugins: [marksStatePlugin],
  });

  const replacement = 'Feature 1: Always-On Proof Agent (Double-Click Sidebar)';
  const metadata = {
    [markId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-02-09T00:00:00.000Z').toISOString(),
      content: replacement,
      status: 'pending' as const,
    },
  };

  state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }));

  const parser = (_markdown: string) =>
    schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(replacement)]),
    ]);

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const accepted = acceptMark(view, markId, parser);
  assert(accepted, 'Accept should succeed');

  const firstBlock = state.doc.firstChild;
  assert(firstBlock !== null, 'Document should have content');
  assertEqual(firstBlock!.type.name, 'heading', 'Heading block type should be preserved');
  assertEqual(firstBlock!.attrs.level, 2, 'Heading level should be preserved');
  assertEqual(firstBlock!.textContent, replacement, 'Heading text should be updated');

  let hasSuggestion = false;
  state.doc.descendants((node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name === 'proofSuggestion') hasSuggestion = true;
    }
    return true;
  });
  assert(!hasSuggestion, 'Suggestion mark should be removed after accept');
});

test('accept preserves non-paragraph textblock type for non-structural replacements', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      callout: {
        content: 'inline*',
        group: 'block',
      },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'replace' },
          by: { default: 'unknown' },
          status: { default: 'pending' },
          content: { default: null },
          createdAt: { default: null },
          updatedAt: { default: null },
        },
        inclusive: false,
        spanning: true,
      },
      proofAuthored: {
        attrs: {
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
    },
  });

  const markId = 'm-callout-style-preserve';
  const suggestionMark = schema.marks.proofSuggestion.create({
    id: markId,
    kind: 'replace',
    by: 'ai:test',
  });

  const initialDoc = schema.node('doc', null, [
    schema.node('callout', null, [
      schema.text('Original callout copy', [suggestionMark]),
    ]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema,
    doc: initialDoc,
    plugins: [marksStatePlugin],
  });

  const replacement = 'Updated callout copy';
  const metadata = {
    [markId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-02-09T00:00:00.000Z').toISOString(),
      content: replacement,
      status: 'pending' as const,
    },
  };

  state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }));

  const parser = (_markdown: string) =>
    schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(replacement)]),
    ]);

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const accepted = acceptMark(view, markId, parser);
  assert(accepted, 'Accept should succeed');

  const firstBlock = state.doc.firstChild;
  assert(firstBlock !== null, 'Document should have content');
  assertEqual(firstBlock!.type.name, 'callout', 'Custom textblock type should be preserved');
  assertEqual(firstBlock!.textContent, replacement, 'Textblock content should be updated');
});

test('accept converts structural insert markdown into block nodes instead of raw markdown text', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      heading: {
        attrs: { level: { default: 2 } },
        content: 'inline*',
        group: 'block',
      },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'insert' },
          by: { default: 'unknown' },
          status: { default: 'pending' },
          content: { default: null },
          createdAt: { default: null },
          updatedAt: { default: null },
        },
        inclusive: false,
        spanning: true,
      },
      proofAuthored: {
        attrs: {
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
    },
  });

  const markId = 'm-structural-insert';
  const insertMarkdown = '## Launch Ready\n\nShipped content.';
  const suggestionMark = schema.marks.proofSuggestion.create({
    id: markId,
    kind: 'insert',
    by: 'ai:test',
  });

  const initialDoc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('Intro '),
      schema.text(insertMarkdown, [suggestionMark]),
    ]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema,
    doc: initialDoc,
    plugins: [marksStatePlugin],
  });

  const metadata = {
    [markId]: {
      kind: 'insert' as const,
      by: 'ai:test',
      createdAt: new Date('2026-02-10T00:00:00.000Z').toISOString(),
      content: insertMarkdown,
      status: 'pending' as const,
    },
  };

  state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }));

  const parser = (_markdown: string) =>
    schema.node('doc', null, [
      schema.node('heading', { level: 2 }, [schema.text('Launch Ready')]),
      schema.node('paragraph', null, [schema.text('Shipped content.')]),
    ]);

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const accepted = acceptMark(view, markId, parser);
  assert(accepted, 'Accept should succeed for structural insert');

  const firstBlock = state.doc.child(0);
  const secondBlock = state.doc.child(1);
  const thirdBlock = state.doc.child(2);
  assertEqual(firstBlock.type.name, 'paragraph', 'Intro paragraph should be preserved');
  assertEqual(firstBlock.textContent, 'Intro ', 'Intro text should remain');
  assertEqual(secondBlock.type.name, 'heading', 'Inserted heading should be materialized as a heading node');
  assertEqual(secondBlock.textContent, 'Launch Ready', 'Heading text should be parsed');
  assertEqual(thirdBlock.type.name, 'paragraph', 'Inserted body should be materialized as a paragraph');
  assertEqual(thirdBlock.textContent, 'Shipped content.', 'Body text should be parsed');

  const docText = state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
  assert(!docText.includes('## Launch Ready'), 'Raw markdown heading tokens should not remain in accepted content');

  let hasSuggestion = false;
  state.doc.descendants((node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name === 'proofSuggestion') hasSuggestion = true;
    }
    return true;
  });
  assert(!hasSuggestion, 'Suggestion mark should be removed after accept');
});

test('accept refuses unsafe structural replace when markdown parsing fails', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'replace' },
          by: { default: 'unknown' },
          status: { default: 'pending' },
          content: { default: null },
          createdAt: { default: null },
          updatedAt: { default: null },
        },
        inclusive: false,
        spanning: true,
      },
      proofAuthored: {
        attrs: {
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
      em: {
        inclusive: true,
      },
    },
  });

  const markId = 'm-unsafe-fallback';
  const suggestionMark = schema.marks.proofSuggestion.create({
    id: markId,
    kind: 'replace',
    by: 'ai:test',
  });

  const initialDoc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('This is '),
      schema.text('original text', [suggestionMark]),
    ]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema,
    doc: initialDoc,
    plugins: [marksStatePlugin],
  });

  const metadata = {
    [markId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-02-10T00:00:00.000Z').toISOString(),
      content: '- new list item',
      status: 'pending' as const,
    },
  };

  state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }));

  const parser = (_markdown: string) => {
    throw new Error('parser failed');
  };

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const accepted = acceptMark(view, markId, parser as any);
  assert(!accepted, 'Accept should fail safely when structural markdown cannot be parsed');

  const docText = state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
  assertEqual(docText, 'This is original text', 'Document content should remain unchanged after failed accept');

  let hasSuggestion = false;
  state.doc.descendants((node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name === 'proofSuggestion') hasSuggestion = true;
    }
    return true;
  });
  assert(hasSuggestion, 'Suggestion mark should remain pending after failed accept');

  const pluginState = marksPluginKey.getState(state) as { metadata: Record<string, unknown> } | undefined;
  assert(Boolean(pluginState?.metadata?.[markId]), 'Metadata should remain intact after failed accept');
});

test('acceptAll leaves suggestions untouched when structural insert parsing fails', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'insert' },
          by: { default: 'unknown' },
          status: { default: 'pending' },
          content: { default: null },
          createdAt: { default: null },
          updatedAt: { default: null },
        },
        inclusive: false,
        spanning: true,
      },
      proofAuthored: {
        attrs: {
          by: { default: 'unknown' },
        },
        inclusive: false,
        spanning: true,
      },
    },
  });

  const markId = 'm-accept-all-rollback';
  const insertMarkdown = '## Break Me';
  const suggestionMark = schema.marks.proofSuggestion.create({
    id: markId,
    kind: 'insert',
    by: 'ai:test',
  });

  const initialDoc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('Start '),
      schema.text(insertMarkdown, [suggestionMark]),
    ]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema,
    doc: initialDoc,
    plugins: [marksStatePlugin],
  });

  const metadata = {
    [markId]: {
      kind: 'insert' as const,
      by: 'ai:test',
      createdAt: new Date('2026-02-10T00:00:00.000Z').toISOString(),
      content: insertMarkdown,
      status: 'pending' as const,
    },
  };

  state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }));

  const parser = (_markdown: string) => {
    throw new Error('parser failed');
  };

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const acceptedCount = acceptAllMarks(view, parser as any);
  assertEqual(acceptedCount, 0, 'acceptAll should skip unsafe structural inserts');

  const docText = state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
  assertEqual(docText, `Start ${insertMarkdown}`, 'Content should remain unchanged when acceptAll skips the suggestion');

  let hasSuggestion = false;
  state.doc.descendants((node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name === 'proofSuggestion') hasSuggestion = true;
    }
    return true;
  });
  assert(hasSuggestion, 'Suggestion mark should remain when acceptAll skips an unsafe conversion');
});

test('acceptAll applies multiple replacements without duplicating characters', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'replace' },
          by: { default: 'unknown' },
          status: { default: 'pending' },
          content: { default: null },
          createdAt: { default: null },
          updatedAt: { default: null },
        },
        inclusive: false,
        spanning: true,
      },
    },
  });

  const firstId = 'm-accept-all-first';
  const secondId = 'm-accept-all-second';
  const thirdId = 'm-accept-all-third';
  const firstMark = schema.marks.proofSuggestion.create({ id: firstId, kind: 'replace', by: 'ai:test' });
  const secondMark = schema.marks.proofSuggestion.create({ id: secondId, kind: 'replace', by: 'ai:test' });
  const thirdMark = schema.marks.proofSuggestion.create({ id: thirdId, kind: 'replace', by: 'ai:test' });

  const initialDoc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('How a', [firstMark]),
      schema.text(' '),
      schema.text('chatbot', [secondMark]),
      schema.text(" did what years of performance reviews "),
      schema.text("couldn't", [thirdMark]),
    ]),
  ]);

  const marksStatePlugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        if (meta?.type === 'SET_METADATA') {
          return { ...value, metadata: meta.metadata };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return { ...value, activeMarkId: meta.markId ?? null };
        }
        return value;
      },
    },
  });

  let state = EditorState.create({
    schema,
    doc: initialDoc,
    plugins: [marksStatePlugin],
  });

  const metadata = {
    [firstId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-02-10T00:00:00.000Z').toISOString(),
      content: 'How an',
      status: 'pending' as const,
    },
    [secondId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-02-10T00:00:00.000Z').toISOString(),
      content: 'bot',
      status: 'pending' as const,
    },
    [thirdId]: {
      kind: 'replace' as const,
      by: 'ai:test',
      createdAt: new Date('2026-02-10T00:00:00.000Z').toISOString(),
      content: 'could not',
      status: 'pending' as const,
    },
  };

  state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }));

  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;

  const acceptedCount = acceptAllMarks(view);
  assertEqual(acceptedCount, 3, 'acceptAll should accept all pending replacements');

  const docText = state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
  assertEqual(
    docText,
    'How an bot did what years of performance reviews could not',
    'acceptAll should not duplicate or corrupt surrounding characters',
  );
});

// ============================================================================
// Proposal Validation
// ============================================================================

function makeProposal(change: SubAgentProposal['change'], suffix: string): SubAgentProposal {
  return {
    id: `proposal-test-${suffix}`,
    createdAt: Date.now(),
    agentId: 'agent:test',
    focusAreaId: 'focus:test',
    focusAreaName: 'Focus Test',
    change,
  };
}

const proposalDocument = [
  'Hello world',
  'Here is a medium-length sentence that should not be rewritten into a large block.',
  'Every way I sliced it',
  'point blank',
  '*Italic caption.*',
  'Step one of my revolutionary AI analysis: Manually exporting data from Every\'s CMS into Google Sheets',
  '## The receipts I\'d never had',
  '## I Asked AI the Question I Could Never Ask My Boss',
  'The exchange where ChatGPT gave me the answer I was craving: yes, you are good at your job.',
].join('\n');

test('dedupeProposals rejects no-op replacements', () => {
  const proposals = [
    makeProposal(
      {
        kind: 'suggestion',
        suggestionType: 'replace',
        quote: 'Hello world',
        content: 'Hello world',
      },
      'noop'
    ),
  ];

  const result = dedupeProposals(proposals, proposalDocument, 10);
  assertEqual(result.proposals.length, 0);
  assertEqual(result.invalidRemoved, 1);
  assertEqual(result.invalidReasons.noop_replace, 1);
});

test('dedupeProposals rejects large rewrites', () => {
  const quote = 'Here is a medium-length sentence that should not be rewritten into a large block.';
  const content = `${quote} ` + 'Extra rewrite. '.repeat(20);
  const proposals = [
    makeProposal(
      {
        kind: 'suggestion',
        suggestionType: 'replace',
        quote,
        content,
      },
      'large-rewrite'
    ),
  ];

  const result = dedupeProposals(proposals, proposalDocument, 10);
  assertEqual(result.proposals.length, 0);
  assertEqual(result.invalidRemoved, 1);
  assertEqual(result.invalidReasons.large_rewrite, 1);
});

test('dedupeProposals rejects over-scoped replacements that change the opening words', () => {
  const proposals = [
    makeProposal(
      {
        kind: 'suggestion',
        suggestionType: 'replace',
        quote: "of my revolutionary AI analysis: Manually exporting data from Every's CMS into Google Sheets",
        content: "Step one of my revolutionary AI analysis: manually exporting data from Every's CMS into Google Sheets",
      },
      'prefix-mismatch'
    ),
  ];

  const result = dedupeProposals(proposals, proposalDocument, 10);
  assertEqual(result.proposals.length, 0);
  assertEqual(result.invalidRemoved, 1);
  assertEqual(result.invalidReasons.replace_prefix_mismatch, 1);
});

test('dedupeProposals rejects capitalizing yes/no after a colon', () => {
  const proposals = [
    makeProposal(
      {
        kind: 'suggestion',
        suggestionType: 'replace',
        quote: 'The exchange where ChatGPT gave me the answer I was craving: yes, you are good at your job.',
        content: 'The exchange where ChatGPT gave me the answer I was craving: Yes, you are good at your job.',
      },
      'colon-yes-cap'
    ),
  ];

  const result = dedupeProposals(proposals, proposalDocument, 10);
  assertEqual(result.proposals.length, 0);
  assertEqual(result.invalidRemoved, 1);
  assertEqual(result.invalidReasons.colon_yes_no_capitalization, 1);
});

test('dedupeProposals rejects lowercasing an existing title-case heading', () => {
  const proposals = [
    makeProposal(
      {
        kind: 'suggestion',
        suggestionType: 'replace',
        quote: 'I Asked AI the Question I Could Never Ask My Boss',
        content: 'I asked AI the question I could never ask my boss',
      },
      'heading-case-lower'
    ),
  ];

  const result = dedupeProposals(proposals, proposalDocument, 10);
  assertEqual(result.proposals.length, 0);
  assertEqual(result.invalidRemoved, 1);
  assertEqual(result.invalidReasons.heading_case_lowering, 1);
});

test('dedupeProposals rejects case-lowering at sentence start', () => {
  const proposals = [
    makeProposal(
      {
        kind: 'suggestion',
        suggestionType: 'replace',
        quote: 'Every way I sliced it',
        content: 'every way I sliced it',
      },
      'case-lower'
    ),
  ];

  const result = dedupeProposals(proposals, proposalDocument, 10);
  assertEqual(result.proposals.length, 0);
  assertEqual(result.invalidRemoved, 1);
  assertEqual(result.invalidReasons.case_lowering_sentence_start, 1);
});

test('dedupeProposals rejects quotes not found in document', () => {
  const proposals = [
    makeProposal(
      {
        kind: 'suggestion',
        suggestionType: 'replace',
        quote: 'missing quote',
        content: 'replacement',
      },
      'quote-missing'
    ),
  ];

  const result = dedupeProposals(proposals, proposalDocument, 10);
  assertEqual(result.proposals.length, 0);
  assertEqual(result.invalidRemoved, 1);
  assertEqual(result.invalidReasons.quote_not_found, 1);
});

test('dedupeProposals rejects heading conversions when the heading already exists', () => {
  const proposals = [
    makeProposal(
      {
        kind: 'suggestion',
        suggestionType: 'replace',
        quote: "The receipts I'd never had",
        content: "## The receipts I'd never had",
      },
      'heading-duplicate'
    ),
  ];

  const result = dedupeProposals(proposals, proposalDocument, 10);
  assertEqual(result.proposals.length, 0);
  assertEqual(result.invalidRemoved, 1);
  assertEqual(result.invalidReasons.heading_already_present, 1);
});

test('dedupeProposals normalizes punctuation outside italics', () => {
  const proposals = [
    makeProposal(
      {
        kind: 'suggestion',
        suggestionType: 'replace',
        quote: '*Italic caption.*',
        content: '*Italic caption.*',
      },
      'italics-punct'
    ),
  ];

  const result = dedupeProposals(proposals, proposalDocument, 10);
  assertEqual(result.proposals.length, 1);
  assertEqual(result.invalidRemoved, 0);
  assertEqual(result.proposals[0]?.change.kind, 'suggestion');
  if (result.proposals[0]?.change.kind === 'suggestion') {
    assertEqual(result.proposals[0].change.content, '*Italic caption*.');
  }
});

test('dedupeProposals keeps valid proposals and still dedupes', () => {
  const valid = makeProposal(
    {
      kind: 'suggestion',
      suggestionType: 'replace',
      quote: 'point blank',
      content: 'point-blank',
    },
    'valid-1'
  );
  const duplicate = { ...valid, id: 'proposal-test-valid-2' };

  const result = dedupeProposals([valid, duplicate], proposalDocument, 10);
  assertEqual(result.proposals.length, 1);
  assertEqual(result.duplicatesRemoved, 1);
  assertEqual(result.invalidRemoved, 0);
});

// ============================================================================
// Event Callback
// ============================================================================

console.log('\n=== Event Callback ===');

test('setEventCallback registers a callback', () => {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  setEventCallback((event, data) => {
    events.push({ event, data });
  });
  // Callback is registered — no events fire just from registering
  assert(events.length === 0, 'No events should fire just from registering');
});

// Note: Self-event filtering is handled server-side in handleEventsPending
// (AgentBridgeServer.swift). Events always fire in JS — the Swift endpoint
// filters out events where data.by matches the requesting agent's X-Agent-Id.
// This allows multi-agent scenarios where Agent A's events are visible to Agent B.

// Clean up the event callback
setEventCallback(() => {});

// ============================================================================
// Summary
// ============================================================================

console.log('\n=== Summary ===');
console.log(`Total: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
