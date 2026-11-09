import assert from 'node:assert/strict';
import test from 'node:test';

import type { DepartementLevel, LevelPlace } from './api.ts';
import { hasPublishedSales, heatRows, toBase100, valueAt } from './departement-view.ts';

const place = (code: string, n: number, medians: (number | null)[], growth: number | null): LevelPlace =>
  ({ code, name: code, level: 'commune', n, medians, changes: [], growth }) as unknown as LevelPlace;

test('base 100 at the first known value', () => {
  assert.deepEqual(toBase100([null, 2000, 2500, null]), [null, 100, 125, null]);
  assert.deepEqual(toBase100([null, null]), [null, null]);
});

test('value of a yearly array at one year, null when the year is not in the window', () => {
  assert.equal(valueAt(['2022', '2023', '2024'], [3100, 3000, null], '2023'), 3000);
  assert.equal(valueAt(['2022', '2023', '2024'], [3100, 3000, null], '2024'), null);
  assert.equal(valueAt(['2022', '2023'], [3100, 3000], null), null);
  assert.equal(valueAt(['2022', '2023'], [3100, 3000], '2019'), null);
});

test('heat rows: communes with a median every year, most sales or biggest rise first', () => {
  const rows = [
    place('33281', 200, [3000, 3300, 3600], 0.2),
    place('33063', 900, [5000, 5200, 5500], 0.1),
    place('33318', 950, [2500, null, 2600], 0.04), // a year missing: left out
    place('33999', 50, [2000, 2100, 2000], null),
  ];
  assert.deepEqual(heatRows(rows, 'sales').map((r) => r.code), ['33063', '33281', '33999']);
  assert.deepEqual(heatRows(rows, 'growth').map((r) => r.code), ['33281', '33063', '33999']);
  // the input order is left alone (React state)
  assert.deepEqual(rows.map((r) => r.code), ['33281', '33063', '33318', '33999']);
  // fewer than two years: no yearly change to draw
  assert.deepEqual(heatRows([place('33063', 900, [5000], null)], 'sales'), []);
});

test('a département has published sales when one type at least has figures', () => {
  const level = (apartment: unknown, house: unknown) =>
    ({ types: { apartment: { kpis: apartment }, house: { kpis: house } } }) as unknown as DepartementLevel;
  assert.equal(hasPublishedSales(level(null, null)), false);
  assert.equal(hasPublishedSales(level(null, { price: 2000 })), true);
  assert.equal(hasPublishedSales({ types: {} } as unknown as DepartementLevel), false);
});
