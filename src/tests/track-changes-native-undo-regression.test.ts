import { history, undo, undoDepth } from 'prosemirror-history';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';
import { Schema } from '@milkdown/kit/prose/model';

import {
  __debugUndoLatestPendingSuggestionEdit,
  suggestionsPlugin,
  resetSuggestionsModuleState,
  setSuggestionsDesiredEnabled,
  wrapTransactionForSuggestions,
} from '../editor/plugins/suggestions';
import {
  accept as acceptMark,
  getMarks,
  marksPluginKey,
} from '../editor/plugins/marks';
import type { StoredMark } from '../formats/marks';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

type TestState = {
  rawSuggestionsPlugin: Plugin;
  schema: Schema;
  marksStatePlugin: Plugin;
};

function buildSchema(): Schema {
  return new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'text*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {
      proofSuggestion: {
        attrs: {
          id: { default: null },
          kind: { default: 'delete' },
          by: { default: 'human:test' },
          quote: { default: null },
          content: { default: null },
          createdAt: { default: null },
          status: { default: 'pending' },
          startRel: { default: null },
          endRel: { default: null },
        },
        inclusive: false,
        parseDOM: [],
        toDOM(mark) {
          return ['span', { 'data-proof': 'suggestion', 'data-id': mark.attrs.id, 'data-kind': mark.attrs.kind }, 0];
        },
      },
    },
  });
}

function buildMarksStatePlugin(): Plugin {
  return new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null, composeAnchorRange: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey) as
          | { type?: string; metadata?: Record<string, StoredMark> }
          | undefined;
        if (meta?.type === 'SET_METADATA') {
          return {
            ...value,
            metadata: meta.metadata ?? {},
          };
        }
        return value;
      },
    },
  });
}

async function initTestState(): Promise<TestState> {
  (globalThis as { window?: unknown }).window = {
    proof: {
      bridge: {
        sendMessage() {},
      },
    },
  };

  const fakeCtx = {
    wait: async () => {},
    update: () => {},
  } as const;

  await (suggestionsPlugin as unknown as (ctx: unknown) => () => Promise<void>)(fakeCtx)();

  return {
    rawSuggestionsPlugin: (suggestionsPlugin as unknown as { plugin: () => Plugin }).plugin(),
    schema: buildSchema(),
    marksStatePlugin: buildMarksStatePlugin(),
  };
}

function createState(
  testState: TestState,
  paragraphs: string[],
): EditorState {
  resetSuggestionsModuleState();
  setSuggestionsDesiredEnabled(true);

  let state = EditorState.create({
    schema: testState.schema,
    doc: testState.schema.node('doc', null, paragraphs.map((text) =>
      testState.schema.node('paragraph', null, text.length > 0 ? [testState.schema.text(text)] : []),
    )),
    plugins: [history(), testState.marksStatePlugin, testState.rawSuggestionsPlugin],
  });

  state = state.applyTransaction(
    state.tr.setMeta(testState.rawSuggestionsPlugin.spec.key, { enabled: true }),
  ).state;

  return state;
}

function applyTrackedTransaction(state: EditorState, tr: Parameters<EditorState['applyTransaction']>[0]): EditorState {
  return state.applyTransaction(tr).state;
}

function docText(state: EditorState): string {
  return state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
}

function findInParagraph(state: EditorState, paragraphIndex: number, text: string): number {
  let currentIndex = 0;
  let found = -1;

  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true;
    if (currentIndex === paragraphIndex) {
      const offset = node.textContent.indexOf(text);
      if (offset >= 0) found = pos + 1 + offset;
      return false;
    }
    currentIndex += 1;
    return true;
  });

  if (found < 0) {
    throw new Error(`Could not find "${text}" in paragraph ${paragraphIndex}`);
  }

  return found;
}

function paragraphStart(state: EditorState, paragraphIndex: number): number {
  let currentIndex = 0;
  let found = -1;

  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true;
    if (currentIndex === paragraphIndex) {
      found = pos + 1;
      return false;
    }
    currentIndex += 1;
    return true;
  });

  if (found < 0) {
    throw new Error(`Could not resolve paragraph ${paragraphIndex}`);
  }

  return found;
}

function applyNativeTypedText(
  state: EditorState,
  text: string,
  from: number,
): EditorState {
  let nextState = state;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    const pos = from + index;
    nextState = nextState.applyTransaction(
      nextState.tr
        .insertText(ch, pos, pos)
        .setMeta('proof-native-typed-input', true)
        .setMeta('proof-native-typed-input-match', { text: ch, from: pos, to: pos + 1 }),
    ).state;
  }
  return nextState;
}

function runUndo(state: EditorState): EditorState {
  let nextState = state;
  const handled = undo(state, (tr) => {
    nextState = nextState.applyTransaction(tr).state;
  });
  assert(handled, 'Expected undo to dispatch');
  return nextState;
}

async function run(): Promise<void> {
  const testState = await initTestState();

  let actorFallbackState = createState(testState, ['Alpha beta']);
  actorFallbackState = applyNativeTypedText(actorFallbackState, 'RE', 1);
  const actorFallbackView = {
    get state() {
      return actorFallbackState;
    },
    dispatch(tr: Parameters<EditorState['applyTransaction']>[0]) {
      actorFallbackState = actorFallbackState.applyTransaction(tr).state;
    },
  };
  const actorFallbackHandled = __debugUndoLatestPendingSuggestionEdit(actorFallbackView as never, 'human:other');
  assert(actorFallbackHandled, 'Expected TC undo fallback to reject the latest pending suggestion even when actor-scoped lookup misses it');
  assert(docText(actorFallbackState) === 'Alpha beta', 'Expected TC undo fallback to remove the latest pending suggestion group when actor lookup misses it');
  assert(getMarks(actorFallbackState).length === 0, 'Expected TC undo fallback to clear the pending suggestion marks when actor lookup misses it');

  let state = createState(testState, ['Alpha beta']);
  state = applyNativeTypedText(state, 'RE', 1);

  assert(undoDepth(state) === 1, 'Expected grouped native typed text to create one undo event');
  assert(docText(state) === 'REAlpha beta', 'Expected native typed text fixture to insert the tracked prefix');
  assert(getMarks(state).some((mark) => mark.kind === 'insert'), 'Expected native typed text fixture to create an insert suggestion');

  state = runUndo(state);

  assert(docText(state) === 'Alpha beta', 'Expected undo to remove the native typed text instead of leaving a no-op history entry');
  assert(getMarks(state).length === 0, 'Expected undo to remove the native typed insert suggestion');
  assert(undoDepth(state) === 0, 'Expected native typed text undo to consume the only history event');

  state = createState(testState, [
    'enrolled alpha',
    'imputation beta',
  ]);

  let from = findInParagraph(state, 0, 'enrolled');
  state = applyTrackedTransaction(
    state,
    wrapTransactionForSuggestions(
      state.tr.insertText('recruited', from, from + 'enrolled'.length),
      state,
      true,
    ),
  );

  from = findInParagraph(state, 1, 'imputation');
  state = applyTrackedTransaction(
    state,
    wrapTransactionForSuggestions(
      state.tr.insertText('interpolation', from, from + 'imputation'.length),
      state,
      true,
    ),
  );

  const acceptTarget = getMarks(state).find((mark) =>
    mark.kind === 'delete'
    && mark.range
    && state.doc.textBetween(mark.range.from, mark.range.to, '', '') === 'enrolled',
  );
  assert(acceptTarget, 'Expected accept fixture to find the earlier delete suggestion');

  const acceptView = {
    get state() {
      return state;
    },
    dispatch(tr: Parameters<EditorState['applyTransaction']>[0]) {
      state = state.applyTransaction(tr).state;
    },
  };
  const acceptHandled = acceptMark(acceptView as never, acceptTarget.id);
  assert(acceptHandled, 'Expected accept to succeed in the native undo fixture');

  state = applyNativeTypedText(state, 'RESULTS: ', paragraphStart(state, 1));
  assert(
    docText(state) === 'recruited alpha\nRESULTS: interpolationimputation beta',
    'Expected native typed prefix fixture to insert tracked text before the remaining replacement',
  );

  state = runUndo(state);
  assert(
    docText(state) === 'recruited alpha\ninterpolationimputation beta',
    'Expected first undo after accept to remove the tracked prefix without text corruption',
  );
  assert(
    getMarks(state).some((mark) => mark.kind === 'insert' && mark.range && state.doc.textBetween(mark.range.from, mark.range.to, '', '') === 'interpolation'),
    'Expected first undo after accept to leave the later replacement suggestion intact',
  );

  state = runUndo(state);
  assert(
    docText(state) === 'recruited alpha\nimputation beta',
    'Expected second undo after accept to remove the later replacement suggestion',
  );
  assert(
    !getMarks(state).some((mark) =>
      mark.kind === 'insert'
      && mark.range
      && state.doc.textBetween(mark.range.from, mark.range.to, '', '') === 'interpolation',
    ),
    'Expected second undo after accept to clear the later replacement insert mark',
  );

  console.log('track-changes-native-undo-regression.test.ts passed');
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
