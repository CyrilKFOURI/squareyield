import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogueEntry, KPI_CATALOGUE } from './catalogue.ts';
import { METRICS } from './map.ts';

test('every KPI of KPI_SPEC has an entry (M1–M17, D1–D18)', () => {
  const ids = new Set(KPI_CATALOGUE.map((k) => k.id));
  for (let i = 1; i <= 17; i++) assert.ok(ids.has(`M${i}`), `M${i}`);
  for (let i = 1; i <= 18; i++) assert.ok(ids.has(`D${i}`), `D${i}`);
});

test('ids are unique and every entry explains itself', () => {
  const ids = KPI_CATALOGUE.map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const k of KPI_CATALOGUE) {
    assert.ok(k.label && k.definition && k.source, k.id);
  }
});

test('every map metric has its catalogue entry', () => {
  for (const m of METRICS) assert.ok(catalogueEntry(m.base), m.base);
});
