import { readFileSync } from 'node:fs';
import path from 'node:path';

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
  const source = readFileSync(
    path.resolve(process.cwd(), 'src/editor/plugins/mark-popover.ts'),
    'utf8',
  );

  const railBlock = sliceBetween(
    source,
    '  private renderSuggestionRail(): void {',
    '\n  private handleEditorTouchStart = () => {',
  );
  assert(
    railBlock.includes("button.className = 'mark-suggestion-rail-button';")
      && railBlock.includes("button.addEventListener('click', (event) => {")
      && railBlock.includes('const nextMarkId = currentIndex >= 0')
      && railBlock.includes("this.openForMark(nextMarkId, undefined, { source: 'direct' });"),
    'Expected rail bubble clicks to resolve the target suggestion and reopen that mark directly',
  );

  const openForMarkBlock = sliceBetween(
    source,
    '  openForMark(',
    '\n  close(): void {',
  );
  assert(
    openForMarkBlock.includes('this.anchor = resolveAnchorRange(this.view, mark, pos);')
      && openForMarkBlock.includes('this.ensureAnchorVisible();')
      && openForMarkBlock.includes('this.renderSuggestion(mark);')
      && openForMarkBlock.includes('this.open();'),
    'Expected opening a suggestion from the rail to resolve its anchor, scroll it into view, and render the suggestion popover',
  );

  const ensureAnchorVisibleBlock = sliceBetween(
    source,
    '  private ensureAnchorVisible(): void {',
    '\n  private renderComposer(): void {',
  );
  assert(
    ensureAnchorVisibleBlock.includes('window.scrollTo({ top: target, behavior: \'smooth\' });'),
    'Expected suggestion anchor visibility checks to scroll the document toward the active change',
  );

  console.log('mark-popover-rail-navigation-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
