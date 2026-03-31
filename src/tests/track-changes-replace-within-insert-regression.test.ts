import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state';

import { setCurrentActor } from '../editor/actor';
import { getMarks, marksPluginKey } from '../editor/plugins/marks';
import {
  buildNativeTextInputFollowupWrapTransaction,
  wrapTransactionForSuggestions,
} from '../editor/plugins/suggestions';
import type { StoredMark } from '../formats/marks';

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
      const meta = tr.getMeta(marksPluginKey) as
        | { type?: string; metadata?: Record<string, StoredMark> }
        | undefined;
      if (meta?.type === 'SET_METADATA') {
        return { ...value, metadata: meta.metadata ?? {} };
      }
      return value;
    },
  },
});

function run(): void {
  setCurrentActor('human:user');

  const baseText = 'Data were using linear models with treatment assignment as the primary predictor variable.';
  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(baseText)]),
    ]),
    selection: TextSelection.create(
      schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text(baseText)]),
      ]),
      baseText.length + 1,
      baseText.length + 1,
    ),
    plugins: [marksStatePlugin],
  });

  state = state.apply(
    wrapTransactionForSuggestions(
      state.tr.insertText(' Sensitivity analyses confirmed robust findings across demographic subgroups.', state.selection.from, state.selection.to),
      state,
      true,
    ),
  );

  const initialInsert = getMarks(state).find((mark) => mark.kind === 'insert');
  assert.ok(initialInsert?.range, 'Expected seed insert to create one editable insert suggestion');
  const insertText = state.doc.textBetween(initialInsert!.range!.from, initialInsert!.range!.to, '', '');
  const robustOffset = insertText.indexOf('robust');
  assert.ok(robustOffset >= 0, 'Expected the editable insert text to contain the target word');

  const replaceFrom = initialInsert!.range!.from + robustOffset;
  const replaceTo = replaceFrom + 'robust'.length;
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, replaceFrom, replaceTo)),
  );

  const rawReplacementState = state.apply(state.tr.insertText('co', replaceFrom, replaceTo));
  const nativeReplacementWrap = buildNativeTextInputFollowupWrapTransaction(
    state,
    rawReplacementState,
    { text: 'co', from: replaceFrom, to: replaceFrom + 2 },
  );
  assert.ok(nativeReplacementWrap, 'Expected the first native overwrite chunk inside an insert to stay on the native follow-up path');
  state = rawReplacementState.apply(nativeReplacementWrap!);

  const afterFirstChunkText = state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
  assert.ok(
    afterFirstChunkText.includes('confirmed co findings'),
    'Expected the first native overwrite chunk to replace the selected word in place',
  );

  const followupCursor = state.selection.from;
  const rawFollowupState = state.apply(state.tr.insertText('nsistent', followupCursor, followupCursor));
  const nativeFollowupWrap = buildNativeTextInputFollowupWrapTransaction(
    state,
    rawFollowupState,
    { text: 'nsistent', from: followupCursor, to: followupCursor + 'nsistent'.length },
  );
  assert.ok(nativeFollowupWrap, 'Expected the remaining overwrite characters to stay on the native follow-up path');
  state = rawFollowupState.apply(nativeFollowupWrap!);

  const finalText = state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
  assert.ok(
    finalText.includes('confirmed consistent findings across demographic subgroups.'),
    'Expected replacement typing inside an existing insert to keep the full replacement word in the original sentence position',
  );
  assert.ok(
    !finalText.includes('subgroups.nsistent'),
    'Expected replacement typing inside an existing insert not to append the remaining overwrite characters after the sentence',
  );

  const finalInsertMarks = getMarks(state).filter((mark) => mark.kind === 'insert');
  assert.equal(finalInsertMarks.length, 1, 'Expected replacement typing inside an existing insert to keep one logical insert suggestion');
  const finalInsertText = state.doc.textBetween(finalInsertMarks[0]!.range!.from, finalInsertMarks[0]!.range!.to, '', '');
  assert.equal(
    finalInsertText,
    ' Sensitivity analyses confirmed consistent findings across demographic subgroups.',
    'Expected the editable insert text to stay contiguous after the replacement completes',
  );

  console.log('✓ track changes keeps native overwrite replacements inside a pending insert contiguous');
}

run();
