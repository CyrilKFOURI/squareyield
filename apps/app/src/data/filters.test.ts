import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_FILTERS, parseFilters, toParams } from './filters.ts';

test('defaults when the URL says nothing', () => {
  assert.deepEqual(parseFilters({}), DEFAULT_FILTERS);
  assert.deepEqual(toParams(DEFAULT_FILTERS), {});
});

test('round trip keeps every non-default value', () => {
  const filters = { ...DEFAULT_FILTERS, type: 'house' as const, size: '4' as const, periodType: 'half' as const,
    period: '2026-H1', metric: 'yield', reliable: true, level: 'departement' as const,
    code: '49', palette: 'viridis' as const };
  assert.deepEqual(parseFilters(toParams(filters)), filters);
});

test('invalid values from old links are normalised, never a blank screen', () => {
  // flat sizes on a house, unknown type, unknown metric, malformed period
  const f = parseFilters({ type: 'castle', size: '5+', metric: 'nope', period: '2026-H7', periodType: 'half' });
  assert.equal(f.type, 'apartment');
  assert.equal(f.size, '5+');
  assert.equal(f.metric, DEFAULT_FILTERS.metric);
  assert.equal(f.period, null);
  assert.equal(parseFilters({ type: 'house', size: '5+' }).size, '5');
  assert.equal(parseFilters({ type: 'house', size: '2' }).size, '1-3');
  // new builds exist for all sizes only
  assert.equal(parseFilters({ condition: 'new', size: '3' }).size, 'all');
});

test('a place code that cannot be one, or an unknown level, falls back to France', () => {
  assert.deepEqual([parseFilters({ level: 'commune', code: '../meta' }).level, parseFilters({ level: 'commune', code: '../meta' }).code], ['france', 'FR']);
  assert.equal(parseFilters({ level: 'nowhere', code: '49007' }).code, 'FR');
  assert.deepEqual([parseFilters({ level: 'departement', code: '2A' }).code, parseFilters({ level: 'commune', code: '97411' }).code], ['2A', '97411']);
});
