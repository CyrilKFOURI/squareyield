import assert from 'node:assert/strict';
import test from 'node:test';

import { colorFor, GREY, legendItems, PALETTES } from './scales.ts';

const breaks = [2000, 2500, 3000, 4000];

test('prices: cheap is green, expensive is red', () => {
  assert.equal(colorFor(1500, breaks, 'rdylgn', false), PALETTES.rdylgn[0]);
  assert.equal(colorFor(9000, breaks, 'rdylgn', false), PALETTES.rdylgn[4]);
});

test('yields: high is green', () => {
  assert.equal(colorFor(9000, breaks, 'rdylgn', true), PALETTES.rdylgn[0]);
  assert.equal(colorFor(1500, breaks, 'rdylgn', true), PALETTES.rdylgn[4]);
});

test('neutral metrics use a sequential scale; missing values are grey', () => {
  assert.equal(colorFor(1500, breaks, 'rdylgn', null), PALETTES.sequential[0]);
  assert.equal(colorFor(undefined, breaks, 'rdylgn', false), GREY);
  assert.equal(colorFor(Number.NaN, breaks, 'viridis', true), GREY);
  assert.equal(colorFor(2600, [], 'rdylgn', false), GREY);
});

test('colour-blind palette keeps the direction', () => {
  assert.equal(colorFor(1500, breaks, 'viridis', false), PALETTES.viridis[0]);
});

test('legend lists five classes low to high with their colours', () => {
  const items = legendItems(breaks, (v) => `${v}`, 'rdylgn', false);
  assert.equal(items.length, 5);
  assert.equal(items[0].label, '≤ 2000');
  assert.equal(items[4].label, '> 4000');
  assert.equal(items[0].color, PALETTES.rdylgn[0]);
});
