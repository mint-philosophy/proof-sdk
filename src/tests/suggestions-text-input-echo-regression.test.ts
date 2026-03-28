import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state';

import { marksPluginKey } from '../editor/plugins/marks.js';
import {
  __debugBuildPlainInsertionSuggestionFallbackTransaction,
  __debugRememberHandledTextInputDispatch,
  __debugRememberHandledTextInputCall,
  __debugRememberPendingNativeTextInput,
  __debugResetHandledTextInputEcho,
  __debugShouldPassthroughPendingNativeTextInputTransaction,
  __debugWrapPendingNativeTextInputTransaction,
  __debugShouldSuppressDuplicateHandledTextInputCall,
  __debugShouldSuppressHandledTextInputEcho,
  wrapTransactionForSuggestions,
} from '../editor/plugins/suggestions.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function run(): void {
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
          by: { default: 'human:Anonymous' },
        },
        inclusive: true,
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

  const createState = (from: number, to: number) => EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Alpha beta gamma.')]),
    ]),
    selection: TextSelection.create(
      schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text('Alpha beta gamma.')]),
      ]),
      from,
      to,
    ),
    plugins: [marksStatePlugin],
  });

  __debugResetHandledTextInputEcho();

  let state = createState(18, 18);
  __debugRememberHandledTextInputDispatch('a', 18, 18);
  const handledTr = state.tr
    .insertText('a', 18, 18)
    .setMeta('proof-handled-text-input', { text: 'a', from: 18, to: 18 });
  state = state.apply(wrapTransactionForSuggestions(handledTr, state, true));
  assertEqual(state.doc.textContent, 'Alpha beta gamma.a', 'Expected handled tracked input to insert one character');

  const echoedTr = state.tr.insertText('a', 19, 19);
  assert(
    __debugShouldSuppressHandledTextInputEcho(state, echoedTr),
    'Expected immediate identical plain-text echo after handled input to be suppressed',
  );
  assertEqual(
    __debugShouldSuppressHandledTextInputEcho(state, echoedTr),
    false,
    'Expected handled text-input echo suppression to be one-shot once the echo is consumed',
  );

  __debugResetHandledTextInputEcho();
  __debugRememberHandledTextInputDispatch('a', 18, 18);
  const legitimateNextCharTr = state.tr.insertText('b', 19, 19);
  assertEqual(
    __debugShouldSuppressHandledTextInputEcho(state, legitimateNextCharTr),
    false,
    'Expected a different legitimate next character not to be suppressed as an echo',
  );

  __debugResetHandledTextInputEcho();
  __debugRememberHandledTextInputDispatch('a', 18, 18);
  const handledEchoTr = state.tr
    .insertText('a', 19, 19)
    .setMeta('proof-handled-text-input', { text: 'a', from: 18, to: 18 });
  assert(
    __debugShouldSuppressHandledTextInputEcho(state, handledEchoTr),
    'Expected a second handled-meta insertion echo to be suppressed when it matches the post-insert duplicate position',
  );

  __debugResetHandledTextInputEcho();
  __debugRememberHandledTextInputDispatch('a', 18, 18);
  const originalHandledTr = createState(18, 18).tr
    .insertText('a', 18, 18)
    .setMeta('proof-handled-text-input', { text: 'a', from: 18, to: 18 });
  assertEqual(
    __debugShouldSuppressHandledTextInputEcho(createState(18, 18), originalHandledTr),
    false,
    'Expected the original handled text-input transaction not to be suppressed',
  );

  __debugResetHandledTextInputEcho();
  __debugRememberHandledTextInputDispatch('a', 18, 18);
  const postInsertState = createState(18, 18).apply(
    wrapTransactionForSuggestions(
      createState(18, 18).tr
        .insertText('a', 18, 18)
        .setMeta('proof-handled-text-input', { text: 'a', from: 18, to: 18 }),
      createState(18, 18),
      true,
    ),
  );
  const handledOriginalPositionEchoTr = postInsertState.tr
    .insertText('a', 18, 18)
    .setMeta('proof-handled-text-input', { text: 'a', from: 18, to: 18 });
  assert(
    __debugShouldSuppressHandledTextInputEcho(postInsertState, handledOriginalPositionEchoTr),
    'Expected a second handled-meta insertion at the original position to be suppressed once the first insertion already exists',
  );

  __debugResetHandledTextInputEcho();
  __debugRememberHandledTextInputCall('a', 18, 18);
  assert(
    __debugShouldSuppressDuplicateHandledTextInputCall('a', 18, 18),
    'Expected an immediate duplicate handleTextInput callback with the same text and range to be suppressed at the source',
  );
  assertEqual(
    __debugShouldSuppressDuplicateHandledTextInputCall('a', 19, 19),
    false,
    'Expected a different insertion range not to be suppressed as a duplicate callback',
  );

  const plainInsertBaseState = createState(18, 18);
  const plainInsertedState = plainInsertBaseState.apply(
    plainInsertBaseState.tr.insertText('a', 18, 18),
  );
  const fallbackTr = __debugBuildPlainInsertionSuggestionFallbackTransaction(
    plainInsertBaseState,
    plainInsertedState,
  );
  assert(
    fallbackTr !== null,
    'Expected the appendTransaction plain-insert fallback to wrap an ordinary native text insertion',
  );
  const fallbackWrappedState = plainInsertedState.apply(fallbackTr!);
  assertEqual(
    fallbackWrappedState.doc.textContent,
    'Alpha beta gamma.a',
    'Expected the plain-insert fallback to preserve the typed text exactly once',
  );
  let fallbackSuggestionCount = 0;
  fallbackWrappedState.doc.descendants((node) => {
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type.name === 'proofSuggestion')) fallbackSuggestionCount += 1;
    return true;
  });
  assertEqual(
    fallbackSuggestionCount,
    1,
    'Expected the plain-insert fallback to add exactly one suggestion-marked text span for the typed character',
  );

  __debugResetHandledTextInputEcho();
  __debugRememberPendingNativeTextInput('a', 18, 18);
  const nativeInsertTr = plainInsertBaseState.tr.insertText('a', 18, 18);
  assert(
    __debugShouldPassthroughPendingNativeTextInputTransaction(plainInsertBaseState, nativeInsertTr),
    'Expected the pending native typed insertion transaction to bypass immediate TC wrapping in the dispatch interceptor',
  );
  assertEqual(
    __debugShouldPassthroughPendingNativeTextInputTransaction(plainInsertBaseState, nativeInsertTr),
    false,
    'Expected native typed-insert passthrough to be one-shot once consumed',
  );

  const wrappedNativeTextInputTr = __debugWrapPendingNativeTextInputTransaction(
    plainInsertBaseState,
    plainInsertBaseState.tr.insertText('a', 18, 18),
  );
  assert(
    wrappedNativeTextInputTr !== null,
    'Expected the matched native typed-insert transaction to be wrapped in place with suggestion marks',
  );
  const wrappedNativeState = plainInsertBaseState.apply(wrappedNativeTextInputTr!);
  assertEqual(
    wrappedNativeState.doc.textContent,
    'Alpha beta gamma.a',
    'Expected in-place native typed-insert wrapping to preserve a single inserted character',
  );
  let wrappedNativeSuggestionCount = 0;
  wrappedNativeState.doc.descendants((node) => {
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type.name === 'proofSuggestion')) wrappedNativeSuggestionCount += 1;
    return true;
  });
  assertEqual(
    wrappedNativeSuggestionCount,
    1,
    'Expected in-place native typed-insert wrapping to leave exactly one suggestion-marked text span',
  );

  console.log('suggestions-text-input-echo-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
