import assert from 'node:assert/strict';
import test from 'node:test';

import { type ExplorerRow, filterRows, histogram, sortRows, toCsv } from './explorer.ts';

const row = (over: Partial<ExplorerRow>): ExplorerRow =>
  ({ code: 'x', name: 'X', level: 'commune', type: 'apartment', size: 'all', n_sales: 50, reliability: 'ok',
    median_price_m2: 3000, gross_yield: 0.05, ...over }) as ExplorerRow;

const rows = [
  row({ code: '1', name: 'Angers', median_price_m2: 3100, gross_yield: 0.056 }),
  row({ code: '2', name: 'Avrillé', median_price_m2: 2500, gross_yield: null, n_sales: 12, reliability: 'low' }),
  row({ code: '3', name: 'Angers', type: 'house', median_price_m2: 2400 }),
  row({ code: '4', name: 'Beaucouzé', size: '2', median_price_m2: 2900 }),
];

test('keeps only the comparable segment', () => {
  const kept = filterRows(rows, { type: 'apartment', size: 'all', reliable: false }, {});
  assert.deepEqual(kept.map((r) => r.code), ['1', '2']);
});

test('reliable hides places under 30 sales; ranges drop rows outside or without a value', () => {
  assert.deepEqual(filterRows(rows, { type: 'apartment', size: 'all', reliable: true }, {}).map((r) => r.code), ['1']);
  const ranged = filterRows(rows, { type: 'apartment', size: 'all', reliable: false }, { gross_yield: [0.05, null] });
  assert.deepEqual(ranged.map((r) => r.code), ['1']);
});

test('search matches names without accents', () => {
  const kept = filterRows(rows, { type: 'apartment', size: 'all', reliable: false }, {}, 'avrille');
  assert.deepEqual(kept.map((r) => r.code), ['2']);
});

test('sorts both ways with missing values last', () => {
  const kept = filterRows(rows, { type: 'apartment', size: 'all', reliable: false }, {});
  assert.deepEqual(sortRows(kept, 'gross_yield', 'desc').map((r) => r.code), ['1', '2']);
  assert.deepEqual(sortRows(kept, 'gross_yield', 'asc').map((r) => r.code), ['1', '2']);
  assert.deepEqual(sortRows(kept, 'median_price_m2', 'asc').map((r) => r.code), ['2', '1']);
  assert.deepEqual(sortRows(kept, 'name', 'asc').map((r) => r.name), ['Angers', 'Avrillé']);
});

test('CSV uses semicolons, quotes text that needs it and leaves missing values empty', () => {
  const csv = toCsv([row({ code: '1', name: 'Saint-Jean; "Ouest"', gross_yield: null })], ['code', 'name', 'gross_yield']);
  assert.equal(csv, 'code;name;gross_yield\r\n1;"Saint-Jean; ""Ouest""";\r\n');
});

test('histogram counts values in equal bins and ignores missing ones', () => {
  const h = histogram([1, 2, 2, 3, 4, null, Number.NaN], 3);
  assert.equal(h.counts.reduce((a, b) => a + b, 0), 5);
  assert.equal(h.edges.length, 4);
  assert.equal(h.edges[0], 1);
  assert.equal(h.edges[3], 4);
  assert.deepEqual(histogram([], 3), { edges: [], counts: [] });
  assert.deepEqual(histogram([5, 5], 3).counts, [2]);
});

test('bounds are typed as shown: percent metrics in %, garbage ignored', async () => {
  const { parseBound } = await import('./explorer.ts');
  assert.equal(parseBound('6', 'yield'), 0.06);
  assert.equal(parseBound('5,5', 'vacancy'), 0.055);
  assert.equal(parseBound('3000', 'price'), 3000);
  assert.equal(parseBound('-200', 'cash_flow'), -200);
  assert.equal(parseBound('', 'price'), null);
  assert.equal(parseBound('-', 'price'), null);
  assert.equal(parseBound('abc', 'yield'), null);
});
