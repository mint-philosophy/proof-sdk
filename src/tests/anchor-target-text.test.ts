import assert from 'node:assert/strict';

import { canonicalizeVisibleTextBlockSeparators } from '../shared/anchor-target-text.js';

function run(): void {
  assert.equal(
    canonicalizeVisibleTextBlockSeparators('Untitled\nEdit targetCHANGED word. '),
    'Untitled\nEdit targetCHANGED word.',
    'Expected trailing whitespace on the final line to be stripped during visible-text canonicalization',
  );

  assert.equal(
    canonicalizeVisibleTextBlockSeparators('Line one   \n  Line two   \n'),
    'Line one\nLine two',
    'Expected paragraph-edge whitespace to be stripped on every line during visible-text canonicalization',
  );

  assert.equal(
    canonicalizeVisibleTextBlockSeparators('Keep  internal spaces'),
    'Keep  internal spaces',
    'Expected internal spaces inside a line to remain intact',
  );

  console.log('anchor-target-text.test.ts passed');
}

run();
