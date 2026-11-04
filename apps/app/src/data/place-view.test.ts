import assert from 'node:assert/strict';
import test from 'node:test';

import { bandsSeries, banSchedule, parentRefs } from './place-view.ts';
import type { Energy, PriceBands } from './types.ts';

const energy: Energy = {
  n_dpe: 1000, share_a: 0.01, share_b: 0.05, share_c: 0.45, share_d: 0.29, share_e: 0.13, share_f: 0.04, share_g: 0.03, share_fg: 0.07,
};

test('rental bans accumulate: G in 2025, F and G in 2028, E to G in 2034', () => {
  const schedule = banSchedule(energy);
  assert.deepEqual(schedule.map((s) => [s.year, s.classes]), [[2025, 'G'], [2028, 'F, G'], [2034, 'E, F, G']]);
  assert.equal(schedule[0].share, 0.03);
  assert.ok(Math.abs(schedule[1].share - 0.07) < 1e-9);
  assert.ok(Math.abs(schedule[2].share - 0.2) < 1e-9);
});

test('price bands become one series per band over the years of the type', () => {
  const bands: PriceBands = {
    '2025': { apartment: { n_sales: 100, bands: [['0-100k', 0.2], ['100-200k', 0.8]] } },
    '2024': { apartment: { n_sales: 90, bands: [['0-100k', 0.3], ['100-200k', 0.7]] }, house: { n_sales: 5, bands: [] } },
    '2023': { house: { n_sales: 50, bands: [['0-100k', 1]] } },
  };
  const s = bandsSeries(bands, 'apartment');
  assert.deepEqual(s.years, ['2024', '2025']);
  assert.deepEqual(s.labels, ['0-100k', '100-200k']);
  assert.deepEqual(s.shares, [[0.3, 0.2], [0.7, 0.8]]);
  assert.deepEqual(bandsSeries(undefined, 'house'), { years: [], labels: [], shares: [] });
});

test('a commune is compared with its département, région and France', () => {
  assert.deepEqual(parentRefs({ level: 'commune', code: '49007', departement: '49', region: '52' }), [
    { level: 'departement', code: '49' },
    { level: 'region', code: '52' },
    { level: 'france', code: 'FR' },
  ]);
  assert.deepEqual(parentRefs({ level: 'departement', code: '49', departement: null, region: '52' }), [
    { level: 'region', code: '52' },
    { level: 'france', code: 'FR' },
  ]);
  assert.deepEqual(parentRefs({ level: 'france', code: 'FR', departement: null, region: null }), []);
});
