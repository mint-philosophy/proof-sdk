import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const source = readFileSync(
    path.resolve(process.cwd(), 'src/editor/schema/proof-marks.ts'),
    'utf8',
  );

  assert(
    !source.includes("...buildCommonDomAttrs(mark),\n      ...attrs,")
      && !source.includes("'data-proof-id': mark.attrs.id ?? null,\n        ...attrs,"),
    'Expected proof mark toDOM serializers to stop spreading raw attr-helper objects into DOM attrs',
  );

  assert(
    source.includes("'data-proof': 'suggestion'")
      && source.includes("'data-id'")
      && source.includes("'data-by'")
      && source.includes("'data-kind'"),
    'Expected suggestion serializer to keep the data-* attrs used by the DOM and markdown roundtrip paths',
  );

  assert(
    source.includes("'data-proof': 'authored'")
      && source.includes("'data-proof-id': mark.attrs.id ?? null"),
    'Expected authored serializer to keep the authored data-* identity attrs without reintroducing raw id/by DOM attrs',
  );

  console.log('proof-marks-dom-regression.test.ts passed');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
