import assert from 'node:assert/strict';
import test from 'node:test';

import { bucketsFor, checkSchema, latestCell, latestFullYear, roomsBucketOf, yieldFor } from './select.ts';
import type { PriceRow, YieldRow } from './types.ts';

const price = (overrides: Partial<PriceRow>): PriceRow => ({
  period_type: 'year',
  period: '2025',
  is_partial: false,
  condition: 'existing',
  property_type: 'apartment',
  rooms_bucket: 'all',
  n_sales: 100,
  reliability: 'ok',
  median_price_m2: 3000,
  p25_price_m2: 2500,
  p75_price_m2: 3500,
  median_price: 150000,
  yoy_change: 0.01,
  median_surface_m2: 50,
  cagr: 0.01,
  cagr_since: 2022,
  new_premium: null,
  ...overrides,
});

const rent = (overrides: Partial<YieldRow>): YieldRow => ({
  period: '2025',
  property_type: 'house',
  rooms_bucket: '4',
  rent_m2: 10,
  rent_low_m2: 8,
  rent_high_m2: 12,
  rent_surface_m2: 95,
  rent_method: 'house_approx',
  rent_level: 'commune',
  rent_caution: false,
  rent_coverage: 1,
  n_listings: 300,
  gross_yield: 0.05,
  price_to_rent_years: 20,
  status: 'ok',
  reason: null,
  ...overrides,
});

test('size buckets per type: houses are larger', () => {
  assert.deepEqual(bucketsFor('apartment'), ['all', '1', '2', '3', '4', '5+']);
  assert.deepEqual(bucketsFor('house'), ['all', '1-3', '4', '5', '6+']);
});

test('a property maps to its own size bucket', () => {
  assert.equal(roomsBucketOf('house', 3), '1-3');
  assert.equal(roomsBucketOf('house', 7), '6+');
  assert.equal(roomsBucketOf('apartment', 6), '5+');
  assert.equal(roomsBucketOf('apartment', 0), 'all');
});

test('yield of the exact cell, never a broader one', () => {
  const yields = [rent({}), rent({ rooms_bucket: 'all', rent_m2: 9 })];
  assert.equal(yieldFor(yields, { propertyType: 'house', rooms: '4' }, '2025')?.rent_m2, 10);
  assert.equal(yieldFor(yields, { propertyType: 'house', rooms: '5' }, '2025'), undefined);
});

test('new-build rows never stand for the market', () => {
  const rows = [price({}), price({ condition: 'new', period: '2026', median_price_m2: 4500 })];
  assert.equal(latestFullYear(rows, { propertyType: 'apartment', rooms: 'all' })?.median_price_m2, 3000);
});

test('schema check', () => {
  assert.equal(checkSchema({ schema_version: 2 }), true);
  assert.equal(checkSchema({}), false);
});

test('latest cell follows the published block, all sizes labelled when a size has half-years only', () => {
  const prices = [price({}), price({ rooms_bucket: '4', period_type: 'half', period: '2026-H1' })];
  const latest = { apartment: { all: { year: '2025', half: null, basis: 'exact' as const }, '4': { year: '2025', half: '2026-H1', basis: 'all_sizes' as const } } };
  const cell = latestCell(prices, latest, { propertyType: 'apartment', rooms: '4' });
  assert.equal(cell?.row.rooms_bucket, 'all');
  assert.equal(cell?.basis, 'all_sizes');
  assert.equal(latestCell(prices, latest, { propertyType: 'apartment', rooms: 'all' })?.basis, 'exact');
  assert.equal(latestCell(prices, latest, { propertyType: 'apartment', rooms: '2' }), undefined);
});
