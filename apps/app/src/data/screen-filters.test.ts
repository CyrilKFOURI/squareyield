import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExplorerRow } from './explorer.ts';
import { activeCount, applyScreenFilters, parseScreenFilters } from './screen-filters.ts';

const row = (over: Partial<ExplorerRow>): ExplorerRow =>
  ({ code: 'x', name: 'X', level: 'departement', parent: '52', type: 'apartment', size: 'all', n_sales: 100, reliability: 'ok',
    median_price_m2: 2500, median_price: 140000, gross_yield: 0.06, cash_flow_monthly: 10, population: 50000,
    vacancy_rate: 0.07, share_fg: 0.1, rent_control: false, flag_high_vacancy: false, flag_population_decline: false, ...over }) as ExplorerRow;

test('nothing in the URL: no filter, every row kept', () => {
  const f = parseScreenFilters({});
  assert.equal(activeCount(f), 0);
  assert.equal(applyScreenFilters([row({}), row({ code: 'y' })], f).length, 2);
});

test('budget and positive cash-flow (acceptance)', () => {
  const f = parseScreenFilters({ budget: '150000', cf: 'pos' });
  const rows = [row({ code: 'a' }), row({ code: 'b', median_price: 200000 }), row({ code: 'c', cash_flow_monthly: -50 }),
    row({ code: 'd', cash_flow_monthly: null })];
  assert.deepEqual(applyScreenFilters(rows, f).map((r) => r.code), ['a']);
  assert.equal(activeCount(f), 2);
});

test('percent filters are typed in %', () => {
  const f = parseScreenFilters({ ymin: '6,5', vacmax: '8', fgmax: '12' });
  const rows = [row({ code: 'a', gross_yield: 0.07 }), row({ code: 'b', gross_yield: 0.06 }),
    row({ code: 'c', gross_yield: 0.08, vacancy_rate: 0.09 }), row({ code: 'd', gross_yield: 0.08, share_fg: 0.2 })];
  assert.deepEqual(applyScreenFilters(rows, f).map((r) => r.code), ['a']);
});

test('ranges, rent control, risky places and région', () => {
  const rows = [row({ code: 'a' }), row({ code: 'b', median_price_m2: 5000, rent_control: true }),
    row({ code: 'c', population: 2000, flag_population_decline: true }), row({ code: 'd', parent: '84' })];
  assert.deepEqual(applyScreenFilters(rows, parseScreenFilters({ pmin: '2000', pmax: '3000' })).map((r) => r.code), ['a', 'c', 'd']);
  assert.deepEqual(applyScreenFilters(rows, parseScreenFilters({ rc: 'in' })).map((r) => r.code), ['b']);
  assert.deepEqual(applyScreenFilters(rows, parseScreenFilters({ rc: 'out' })).map((r) => r.code), ['a', 'c', 'd']);
  assert.deepEqual(applyScreenFilters(rows, parseScreenFilters({ risky: 'out' })).map((r) => r.code), ['a', 'b', 'd']);
  assert.deepEqual(applyScreenFilters(rows, parseScreenFilters({ popmin: '10000' })).map((r) => r.code), ['a', 'b', 'd']);
  assert.deepEqual(applyScreenFilters(rows, parseScreenFilters({ region: '84' })).map((r) => r.code), ['d']);
});

test('garbage values are ignored, not applied as zero', () => {
  const f = parseScreenFilters({ budget: 'abc', ymin: '-', rc: 'maybe', region: '../x' });
  assert.equal(activeCount(f), 0);
});
