// Light basemap on the OpenFreeMap vector tiles (docs/features/021-speed-weak-computers/spec.md): ~12 layers
// instead of their 47–55 + a hillshade raster, because a weak computer redraws every layer on each zoom, pan and
// hover. Water, main roads by zoom, buildings and street names only close up, place names; labels last so the
// data layers can sit just under them.
import type { StyleSpecification } from 'maplibre-gl';

/** First label layer: data layers are inserted before it. */
export const LABELS_FROM = 'label-road';

const NAME = ['coalesce', ['get', 'name:latin'], ['get', 'name']];
const FONT = ['Noto Sans Regular'];

export const basemapStyle = (dark: boolean): StyleSpecification => {
  const c = dark
    ? { bg: '#131210', water: '#1d1f22', road: '#2c2a26', major: '#3a3731', building: '#1f1d1a', border: '#5a564d', text: '#b8b2a6', halo: '#131210' }
    : { bg: '#f1eee8', water: '#c9d3d8', road: '#ffffff', major: '#fbf7ee', building: '#e2ddd3', border: '#9b958a', text: '#4a463f', halo: '#f1eee8' };
  const width = (base: number) => ['interpolate', ['exponential', 1.5], ['zoom'], 6, base * 0.3, 12, base, 17, base * 6];
  const road = (id: string, classes: string[], minzoom: number, color: string, base: number) => ({
    id, type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom,
    filter: ['in', ['get', 'class'], ['literal', classes]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': color, 'line-width': width(base) },
  });
  const place = (id: string, classes: string[], minzoom: number, size: number) => ({
    id, type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', minzoom,
    filter: ['in', ['get', 'class'], ['literal', classes]],
    layout: { 'text-field': NAME, 'text-font': FONT, 'text-size': size, 'text-max-width': 8 },
    paint: { 'text-color': c.text, 'text-halo-color': c.halo, 'text-halo-width': 1.4 },
  });
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': c.bg } },
      { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', paint: { 'fill-color': c.water, 'fill-antialias': false } },
      { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building', minzoom: 15, paint: { 'fill-color': c.building } },
      road('road-minor', ['minor', 'service'], 14, c.road, 1),
      road('road-secondary', ['secondary', 'tertiary'], 11, c.road, 1.4),
      road('road-primary', ['primary', 'trunk'], 8, c.major, 1.8),
      road('road-motorway', ['motorway'], 5, c.major, 2.2),
      { id: 'border', type: 'line', source: 'openmaptiles', 'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': c.border, 'line-width': 1, 'line-dasharray': [3, 2] } },
      // labels: keep LABELS_FROM first
      { id: LABELS_FROM, type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name', minzoom: 15,
        layout: { 'symbol-placement': 'line', 'text-field': NAME, 'text-font': FONT, 'text-size': 11 },
        paint: { 'text-color': c.text, 'text-halo-color': c.halo, 'text-halo-width': 1.2 } },
      place('label-suburb', ['suburb', 'neighbourhood', 'quarter'], 12, 11),
      place('label-village', ['village', 'hamlet'], 11, 11),
      place('label-town', ['town'], 8, 12),
      place('label-city', ['city'], 4, 13),
    ],
  } as StyleSpecification;
};
