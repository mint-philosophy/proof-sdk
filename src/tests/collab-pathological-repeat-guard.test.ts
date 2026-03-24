import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function createFragmentDoc(text: string): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('prosemirror');
  const paragraph = new Y.XmlElement('paragraph');
  const xmlText = new Y.XmlText();
  xmlText.insert(0, text);
  paragraph.insert(0, [xmlText]);
  fragment.insert(0, [paragraph]);
  return doc;
}

function buildRichSuggestionProjection(text: string): string {
  return text
    .split('')
    .map((char, index) => (
      `<span data-proof="suggestion" data-id="m-rich-${index}" data-by="human:Test Editor" data-kind="insert">${char}</span>`
    ))
    .join('');
}

async function run(): Promise<void> {
  const {
    detectPathologicalProjectionRepeat,
    evaluateProjectionSafety,
    registerProjectionPathologyCooldown,
  } = await import('../../server/collab.ts');

  const base = '# Heading\n\nParagraph with enough content to exceed the minimum base length threshold. '.repeat(8);
  const repeated3 = base.repeat(3);
  const repeated2 = base.repeat(2);
  const slightlyDifferent = `${base}${base.slice(0, base.length - 3)}xyz`;

  assert(detectPathologicalProjectionRepeat(base, repeated3) === 3, 'Expected repeat=3 to be detected');
  assert(detectPathologicalProjectionRepeat(base, repeated2) === 0, 'Expected repeat=2 to be ignored');
  assert(detectPathologicalProjectionRepeat(base, base) === 0, 'Expected identical markdown to be ignored');
  assert(detectPathologicalProjectionRepeat(base, slightlyDifferent) === 0, 'Expected non-exact repetition to be ignored');

  const shortBase = 'short text';
  assert(detectPathologicalProjectionRepeat(shortBase, shortBase.repeat(10)) === 0, 'Expected short baseline to be ignored');

  const fragmentDoc = createFragmentDoc('alpha beta gamma');
  const maxCharsCandidate = 'x'.repeat(1_500_001);
  const maxCharsSafety = evaluateProjectionSafety(base, maxCharsCandidate, fragmentDoc);
  assert(maxCharsSafety.safe === false, 'Expected max chars guard to block oversized projection');
  assert(maxCharsSafety.reason === 'max_chars_exceeded', `Expected max chars reason, got ${String(maxCharsSafety.reason)}`);

  const explosiveGrowthCandidate = `${base}${'x'.repeat(base.length * 8)}`;
  const growthSafety = evaluateProjectionSafety(base, explosiveGrowthCandidate, fragmentDoc);
  assert(growthSafety.safe === false, 'Expected growth multiplier guard to block explosive projection');
  assert(growthSafety.reason === 'growth_multiplier_exceeded', `Expected growth reason, got ${String(growthSafety.reason)}`);

  const repeatSafety = evaluateProjectionSafety(base, repeated3, fragmentDoc);
  assert(repeatSafety.safe === false, 'Expected pathological repeat guard to block repeated projection');
  assert(repeatSafety.reason === 'pathological_repeat', `Expected pathological repeat reason, got ${String(repeatSafety.reason)}`);

  const driftCandidate = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(80);
  const driftBaseline = 'baseline filler '.repeat(600);
  const driftSafety = evaluateProjectionSafety(driftBaseline, driftCandidate, fragmentDoc);
  assert(driftSafety.safe === false, 'Expected fragment-markdown drift guard to block diverged projection');
  assert(driftSafety.reason === 'fragment_markdown_drift', `Expected fragment drift reason, got ${String(driftSafety.reason)}`);

  const safeCandidate = 'alpha beta gamma';
  const safeSafety = evaluateProjectionSafety('alpha beta gamma', safeCandidate, fragmentDoc);
  assert(safeSafety.safe === true, `Expected matching fragment/markdown to be safe, got ${String(safeSafety.reason)}`);

  const richVisibleText = 'Baseline paragraph one for testing accept all operations. TC edit one.';
  const richCandidate = buildRichSuggestionProjection(richVisibleText);
  assert(
    richCandidate.length > (richVisibleText.length * 8),
    'Expected rich candidate to exceed the raw growth multiplier threshold',
  );
  const richFragmentDoc = createFragmentDoc(richVisibleText);
  const richSafety = evaluateProjectionSafety(richVisibleText, richCandidate, richFragmentDoc);
  assert(
    richSafety.safe === true,
    `Expected rich projection with identical visible text to be safe, got ${String(richSafety.reason)}`,
  );
  richFragmentDoc.destroy();

  const cooldownState = new Map<string, {
    fingerprint: string;
    reason: string;
    untilMs: number;
    suppressedCount: number;
  }>();
  const firstCooldown = registerProjectionPathologyCooldown(
    cooldownState,
    'slug-a',
    'pathological_repeat',
    'pathological_repeat:repeat3',
    10_000,
    60_000,
  );
  assert(firstCooldown.suppressed === false, 'Expected first pathology registration not to be suppressed');
  const secondCooldown = registerProjectionPathologyCooldown(
    cooldownState,
    'slug-a',
    'pathological_repeat',
    'pathological_repeat:repeat3',
    10_100,
    60_000,
  );
  assert(secondCooldown.suppressed === true, 'Expected repeated pathology fingerprint to be suppressed within cooldown');
  assert(secondCooldown.suppressedCount === 1, `Expected suppressed count=1, got ${secondCooldown.suppressedCount}`);
  const changedFingerprint = registerProjectionPathologyCooldown(
    cooldownState,
    'slug-a',
    'pathological_repeat',
    'pathological_repeat:repeat4',
    10_200,
    60_000,
  );
  assert(changedFingerprint.suppressed === false, 'Expected changed pathology fingerprint not to be suppressed');
  const afterCooldown = registerProjectionPathologyCooldown(
    cooldownState,
    'slug-a',
    'pathological_repeat',
    'pathological_repeat:repeat4',
    80_500,
    60_000,
  );
  assert(afterCooldown.suppressed === false, 'Expected pathology cooldown to expire and allow re-registration');

  fragmentDoc.destroy();

  console.log('✓ collab pathological projection repeat guard');
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
