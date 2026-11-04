import assert from 'node:assert/strict';
import test from 'node:test';

import { alignPeriods, parsePlaces, rebase, seriesFor } from './evolution.ts';
import type { PriceRow } from './types.ts';

const price = (over: Partial<PriceRow>): PriceRow =>
  ({ period_type: 'half', period: '2024-H1', is_partial: false, condition: 'existing', property_type: 'apartment',
    rooms_bucket: 'all', n_sales: 40, reliability: 'ok', median_price_m2: 3000, p25_price_m2: 2500,
    p75_price_m2: 3500, median_price: 150000, yoy_change: null, median_surface_m2: 50, cagr: null,
    cagr_since: null, new_premium: null, ...over }) as PriceRow;

const prices = [
  price({ period: '2024-H2', median_price_m2: 3300 }),
  price({ period: '2024-H1' }),
  price({ period: '2024-H1', rooms_bucket: '2', median_price_m2: 3600 }),
  price({ period: '2024-H1', condition: 'new', median_price_m2: 4500 }),
  price({ period_type: 'year', period: '2024', median_price_m2: 3150 }),
];

test('a series is one segment, one period type, in time order', () => {
  const s = seriesFor(prices, { type: 'apartment', size: 'all', condition: 'existing', periodType: 'half' });
  assert.deepEqual(s.map((p) => [p.period, p.median]), [['2024-H1', 3000], ['2024-H2', 3300]]);
  assert.equal(s[0].p25, 2500);
  assert.equal(s[0].n, 40);
  const years = seriesFor(prices, { type: 'apartment', size: 'all', condition: 'existing', periodType: 'year' });
  assert.deepEqual(years.map((p) => p.period), ['2024']);
});

test('base 100 divides by the first value; an empty series stays empty', () => {
  assert.deepEqual(rebase([200, 220, null, 180]), [100, 110, null, 90]);
  assert.deepEqual(rebase([null, 50, 75]), [null, 100, 150]);
  assert.deepEqual(rebase([]), []);
});

test('periods of several places are merged and sorted', () => {
  assert.deepEqual(alignPeriods([['2024-H2', '2025-H1'], ['2024-H1', '2024-H2']]), ['2024-H1', '2024-H2', '2025-H1']);
});

test('places come from the URL as level:code, at most six, invalid ones dropped', () => {
  assert.deepEqual(parsePlaces('commune:49007,departement:49,bad,region:'), [
    { level: 'commune', code: '49007' },
    { level: 'departement', code: '49' },
  ]);
  assert.equal(parsePlaces(Array.from({ length: 9 }, (_, i) => `commune:4900${i}`).join(',')).length, 6);
  assert.deepEqual(parsePlaces(undefined), []);
});

test('in years, partial edge years are left out (they compare by half-year only)', () => {
  const rows = [
    price({ period_type: 'year', period: '2021', is_partial: true }),
    price({ period_type: 'year', period: '2022' }),
    price({ period_type: 'year', period: '2026', is_partial: true }),
  ];
  const s = seriesFor(rows, { type: 'apartment', size: 'all', condition: 'existing', periodType: 'year' });
  assert.deepEqual(s.map((p) => p.period), ['2022']);
});
