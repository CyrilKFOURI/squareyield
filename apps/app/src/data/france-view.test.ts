import assert from 'node:assert/strict';
import test from 'node:test';

import type { LevelPlace } from './api.ts';
import { BAR_METRICS, heatOrder, nextSort, placeLabel, sortPlaces } from './france-view.ts';

const place = (code: string, extra: Partial<LevelPlace> = {}): LevelPlace => ({
  code, name: `Dép ${code}`, level: 'departement', n: 100, reliability: 'ok', price: 3000, p25: 2000, p75: 4000,
  yoy: 0.02, rent: 12, yield: 0.05, net_yield: 0.04, cash_flow: -100, score: 50, index: 150, m2_income: 8,
  medians: [2000, 2200], changes: [null, 0.1], growth: 0.1, ...extra,
});

test('label: name then code', () => {
  assert.equal(placeLabel(place('33', { name: 'Gironde' })), 'Gironde (33)');
});

test('heat map order: by code, by the latest yearly change or by growth, missing values last', () => {
  const rows = [
    place('2A', { changes: [null, 0.05], growth: 0.3 }),
    place('01', { changes: [null, -0.02], growth: 0.1 }),
    place('19', { changes: [null, null], growth: null }),
    place('971', { changes: [null, 0.1], growth: -0.1 }),
  ];
  assert.deepEqual(heatOrder(rows, 'code').map((r) => r.code), ['01', '19', '2A', '971']);
  assert.deepEqual(heatOrder(rows, 'latest').map((r) => r.code), ['971', '2A', '01', '19']);
  assert.deepEqual(heatOrder(rows, 'growth').map((r) => r.code), ['2A', '01', '971', '19']);
});

test('table sort: by code in département order, by a figure either way with missing values last', () => {
  const rows = [place('2A', { price: 4000 }), place('01', { price: null }), place('10', { price: 2000 }), place('971', { price: 3000 })];
  assert.deepEqual(sortPlaces(rows, { key: 'code', dir: 'asc' }).map((r) => r.code), ['01', '10', '2A', '971']);
  assert.deepEqual(sortPlaces(rows, { key: 'code', dir: 'desc' }).map((r) => r.code), ['971', '2A', '10', '01']);
  assert.deepEqual(sortPlaces(rows, { key: 'price', dir: 'desc' }).map((r) => r.code), ['2A', '971', '10', '01']);
  assert.deepEqual(sortPlaces(rows, { key: 'price', dir: 'asc' }).map((r) => r.code), ['10', '971', '2A', '01']);
  // the input is left as it was
  assert.deepEqual(rows.map((r) => r.code), ['2A', '01', '10', '971']);
});

test('next sort: same column flips, a new figure starts highest first, code starts ascending', () => {
  assert.deepEqual(nextSort({ key: 'price', dir: 'desc' }, 'price'), { key: 'price', dir: 'asc' });
  assert.deepEqual(nextSort({ key: 'code', dir: 'asc' }, 'yoy'), { key: 'yoy', dir: 'desc' });
  assert.deepEqual(nextSort({ key: 'yoy', dir: 'desc' }, 'code'), { key: 'code', dir: 'asc' });
});

test('bar metrics read the precomputed fields; France references where they make sense', () => {
  const d = place('01');
  const france = { price: 2000, yoy: 0.01, growth: 0.05, rent: 11, yield: 0.06 };
  const byKey = Object.fromEntries(BAR_METRICS.map((m) => [m.key, m]));
  assert.equal(byKey.price.value(d), 3000);
  assert.equal(byKey.yoy.value(d), 0.02);
  assert.equal(byKey.growth.value(d), 0.1);
  assert.equal(byKey.sales.value(d), 100);
  assert.equal(byKey.index.value(d), 150);
  assert.equal(byKey.income.value(d), 8);
  assert.equal(byKey.index.reference(france), 100);
  assert.equal(byKey.price.reference(france), 2000);
  assert.equal(byKey.sales.reference(france), null);
  assert.ok(BAR_METRICS.every((m) => typeof m.format(1) === 'string'));
});
