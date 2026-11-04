import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateTaxeFonciere, mergeApartmentLand } from './estimates.ts';

test('taxe foncière scales the one-month rule by the commune rate', () => {
  assert.equal(estimateTaxeFonciere(750, null), 750);
  assert.ok(Math.abs(estimateTaxeFonciere(750, 0.5665) - (750 * 0.5665) / 0.403) < 1e-9);
  assert.ok(estimateTaxeFonciere(750, 0.21) < estimateTaxeFonciere(750, 0.5665));
});

test('apartment: land and type effects become one line whose product is unchanged', () => {
  const effects = [
    { group: 'enc_section', log_effect: 0.338, effect_pct: Math.exp(0.338) - 1 },
    { group: 'land', log_effect: -0.067, effect_pct: Math.exp(-0.067) - 1 },
    { group: 'type', log_effect: 0.02, effect_pct: Math.exp(0.02) - 1 },
  ];
  const merged = mergeApartmentLand(effects, 'apartment');
  assert.deepEqual(merged.map((e) => e.group), ['enc_section', 'apartment_no_land']);
  const product = (list: typeof effects) => list.reduce((p, e) => p * (1 + e.effect_pct), 1);
  assert.ok(Math.abs(product(merged) - product(effects)) < 1e-12);
  assert.equal(mergeApartmentLand(effects, 'house'), effects);
});
