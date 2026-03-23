import fs from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src/editor/plugins/mark-popover.ts'),
    'utf8',
  );

  assert(
    source.includes('private shouldSuppressEditorSuggestionInteraction(')
      && source.includes('private suppressEditorSuggestionAutoOpen(markId: string): void {'),
    'Expected mark-popover to define track-changes editor-body click suppression helpers',
  );

  assert(
    source.includes('this.suppressEditorSuggestionAutoOpen(markId);')
      && source.includes('this.shouldSuppressEditorSuggestionInteraction(mark?.kind)')
      && source.includes('this.shouldSuppressEditorSuggestionInteraction(markKind)'),
    'Expected mark-popover editor-body pointer/click/hover paths to suppress suggestion popovers in track changes mode',
  );

  assert(
    source.includes('if (this.shouldSuppressEditorSuggestionAutoOpen(activeMark)) {'),
    'Expected mark-popover state-sync auto-open path to honor suppressed editor-body suggestion clicks',
  );

  console.log('mark-popover-track-changes-editor-click-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
