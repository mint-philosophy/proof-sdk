import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  shouldResetShareCollabYDocBeforeCollabBind,
  shouldResetShareEditorBeforeCollabBind,
} from '../editor/share-collab-bind-reset.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  assert(start !== -1, `Missing block start: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert(end !== -1, `Missing block end after: ${startNeedle}`);
  return source.slice(start, end);
}

function run(): void {
  const editorSource = readFileSync(path.resolve(process.cwd(), 'src/editor/index.ts'), 'utf8');
  const connectBlock = sliceBetween(
    editorSource,
    '  private connectCollabService(resetEditorDoc = false): void {',
    '\n  private ensureCollabCursorsInstalled(): void {',
  );

  assert(
    shouldResetShareEditorBeforeCollabBind({
      requestedReset: false,
      allowEquivalentSkip: true,
      fragmentIsStructurallyEmpty: true,
      editorMatchesLiveFragment: false,
    }) === false,
    'Expected explicit reset opt-out to stay false even when the fragment is empty',
  );

  assert(
    shouldResetShareEditorBeforeCollabBind({
      requestedReset: true,
      allowEquivalentSkip: true,
      fragmentIsStructurallyEmpty: true,
      editorMatchesLiveFragment: false,
    }) === true,
    'Expected empty live fragments to keep the reset-before-bind path enabled',
  );

  assert(
    shouldResetShareEditorBeforeCollabBind({
      requestedReset: true,
      allowEquivalentSkip: true,
      fragmentIsStructurallyEmpty: false,
      editorMatchesLiveFragment: true,
    }) === false,
    'Expected equivalent initial live fragments to skip reset-before-bind so share reloads do not duplicate remote content',
  );

  assert(
    shouldResetShareEditorBeforeCollabBind({
      requestedReset: true,
      allowEquivalentSkip: true,
      fragmentIsStructurallyEmpty: false,
      editorMatchesLiveFragment: false,
    }) === true,
    'Expected non-equivalent initial live fragments to keep reset-before-bind enabled so stale local content cannot overwrite live state',
  );

  assert(
    shouldResetShareEditorBeforeCollabBind({
      requestedReset: true,
      allowEquivalentSkip: false,
      fragmentIsStructurallyEmpty: false,
      editorMatchesLiveFragment: true,
    }) === true,
    'Expected explicit reconnect/read-only resets to remain enabled even when the fragment already has content',
  );

  assert(
    shouldResetShareCollabYDocBeforeCollabBind({
      requestedReset: false,
      allowEquivalentSkip: true,
      fragmentIsStructurallyEmpty: true,
    }) === false,
    'Expected collab Y.Doc reseeding to stay disabled when the reset request is off',
  );

  assert(
    shouldResetShareCollabYDocBeforeCollabBind({
      requestedReset: true,
      allowEquivalentSkip: true,
      fragmentIsStructurallyEmpty: true,
    }) === true,
    'Expected empty live fragments to keep the Y.Doc reseed path enabled during reset binds',
  );

  assert(
    shouldResetShareCollabYDocBeforeCollabBind({
      requestedReset: true,
      allowEquivalentSkip: true,
      fragmentIsStructurallyEmpty: false,
    }) === false,
    'Expected non-empty live fragments to skip Y.Doc reseeding so initial viewer binds cannot overwrite synced live state',
  );

  assert(
    shouldResetShareCollabYDocBeforeCollabBind({
      requestedReset: true,
      allowEquivalentSkip: false,
      fragmentIsStructurallyEmpty: false,
    }) === true,
    'Expected explicit reconnect/read-only resets to reseed the bound Y.Doc even when the synced fragment is non-empty',
  );

  assert(
    editorSource.includes("import { shouldResetShareEditorBeforeCollabBind } from './share-collab-bind-reset';")
      && connectBlock.includes('const fragmentIsStructurallyEmpty = this.isYjsFragmentStructurallyEmpty(fragment);')
      && connectBlock.includes('let editorMatchesLiveFragment = false;')
      && connectBlock.includes('editorMatchesLiveFragment = fragmentText === editorText;')
      && connectBlock.includes('shouldResetShareEditorBeforeCollabBind({')
      && connectBlock.includes('allowEquivalentSkip: true,')
      && connectBlock.includes('if (shouldResetEditorDocBeforeBind) {'),
    'Expected collab rebinds to consult the shared reset helper and skip reset-before-bind when the live fragment already matches the canonical editor content',
  );

  console.log('✓ share collab bind reset distinguishes initial empty-room seeding from explicit reconnect reseeds');
}

run();
