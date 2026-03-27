import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const source = readFileSync(path.resolve(process.cwd(), 'src/editor/index.ts'), 'utf8');
  const connectIdx = source.indexOf('collabClient.connect(collabSession.session);');
  assert(connectIdx >= 0, 'Expected share init to connect the collab client');

  const windowStart = Math.max(0, connectIdx - 500);
  const windowEnd = Math.min(source.length, connectIdx + 200);
  const snippet = source.slice(windowStart, windowEnd);

  assert(
    snippet.includes('this.pendingCollabRebindOnSync = true;'),
    'Expected share init to defer Milkdown binding until the first live collab sync',
  );
  assert(
    snippet.includes('this.pendingCollabRebindResetDoc = true;'),
    'Expected share init to request a reset editor bind after the first live collab sync',
  );
  assert(
    source.includes('const shouldResetDoc = this.shouldResetEditorBeforeCollabBind(')
      && source.includes('this.pendingCollabRebindAllowEquivalentSkip')
      && source.includes('this.pendingCollabRebindAllowEquivalentSkip = true;'),
    'Expected share init to allow reset-skip only for equivalent initial live fragments',
  );
  assert(
    source.includes('editorHydrationMarkdown: this.getEditorHydrationMarkdown()')
      && source.includes('liveYjsHydrationMarkdown: this.getYjsHydrationMarkdown()'),
    'Expected equivalent share hydration checks to require markdown-structure parity, not just plain-text parity',
  );
  assert(
    source.includes('const shouldResetEditorDoc = !shouldPreserveLocalState || !this.collabCanEdit;')
      && source.includes('this.pendingCollabRebindResetDoc = shouldResetEditorDoc;')
      && source.includes('this.pendingCollabRebindAllowEquivalentSkip = false;'),
    'Expected reconnect/read-only recovery binds to preserve explicit reset requests instead of inheriting the initial-load skip optimization',
  );
  assert(
    !snippet.includes('this.connectCollabService(true);'),
    'Did not expect share init to bind Milkdown to Yjs before the first live collab sync',
  );

  console.log('✓ collab initial bind waits for first sync');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
