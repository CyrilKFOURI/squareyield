import assert from 'node:assert/strict';
import test from 'node:test';

import { basemapStyle, LABELS_FROM } from './basemap.ts';

test('the basemap stays small: a weak computer redraws every layer on each zoom and hover', () => {
  for (const dark of [false, true]) {
    const style = basemapStyle(dark);
    assert.ok(style.layers.length <= 14, `${style.layers.length} layers`);
    // no hillshade raster: one vector source only
    assert.deepEqual(Object.keys(style.sources), ['openmaptiles']);
  }
});

test('labels are the last layers, so the data layers go just under them and names stay readable', () => {
  const { layers } = basemapStyle(false);
  const first = layers.findIndex((l) => l.type === 'symbol');
  assert.equal(layers[first].id, LABELS_FROM);
  assert.ok(layers.slice(first).every((l) => l.type === 'symbol'));
});

test('details only appear when zoomed in close enough to read them', () => {
  const byId = new Map(basemapStyle(true).layers.map((l) => [l.id, l]));
  assert.ok((byId.get('building')?.minzoom ?? 0) >= 14);
  assert.ok((byId.get('road-minor')?.minzoom ?? 0) >= 13);
  assert.ok((byId.get('label-road')?.minzoom ?? 0) >= 14);
});
