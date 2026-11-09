import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSignedPercent } from './format.ts';

test('signed percent: a change that rounds to zero shows no sign', () => {
  assert.equal(formatSignedPercent(-0.00001), '0,0 %');
  assert.equal(formatSignedPercent(0.00001), '0,0 %');
  assert.match(formatSignedPercent(0.025), /^\+2,5 %$/);
  assert.match(formatSignedPercent(-0.025), /^-2,5 %$/);
});
