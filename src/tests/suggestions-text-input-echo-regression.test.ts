import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state';

import { marksPluginKey } from '../editor/plugins/marks.js';
import {
  __debugRememberHandledTextInputDispatch,
  __debugResetHandledTextInputEcho,
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

  console.log('suggestions-text-input-echo-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
