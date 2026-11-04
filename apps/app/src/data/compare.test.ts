import assert from 'node:assert/strict';
import test from 'node:test';

import { bestIndex } from './compare.ts';

test('higher is better: the largest value wins', () => {
  assert.equal(bestIndex([0.05, 0.07, 0.06], true), 1);
});

test('lower is better: the smallest value wins (price, vacancy)', () => {
  assert.equal(bestIndex([3100, 2500, 4000], false), 1);
});

test('missing values never win; no direction or fewer than two values: no winner', () => {
  assert.equal(bestIndex([null, 2, undefined], true), null);
  assert.equal(bestIndex([null, 2, 3], false), 1);
  assert.equal(bestIndex([1, 2], null), null);
  assert.equal(bestIndex([2, 2], true), null);
});
