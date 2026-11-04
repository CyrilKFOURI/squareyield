import assert from 'node:assert/strict';
import test from 'node:test';

import { hasPlacePage, METRICS, metricKey } from './map.ts';

test('metrics are per property type, never flats and houses together', () => {
  assert.equal(metricKey('price', 'house'), 'price_house');
  assert.equal(metricKey('vacancy', 'house'), 'vacancy');
  assert.ok(METRICS.every((m) => !metricKey(m.base, 'apartment').endsWith('_all')));
});

test('a commune with sales of either type keeps its page link', () => {
  assert.equal(hasPlacePage({ code: '1', nom: 'A', sales_house: 12 }), true);
  assert.equal(hasPlacePage({ code: '1', nom: 'A' }), false);
});
