// MapLibre map for DOM screens: a polygon layer (choropleth) and a point layer (communes, sections),
// both coloured by a precomputed `_fill` property, with hover and click callbacks.
// The basemap is OpenFreeMap (free vector tiles); if it cannot load, the data draws on a plain background.
import 'maplibre-gl/dist/maplibre-gl.css';

import * as maplibregl from 'maplibre-gl/dist/maplibre-gl-csp';

import type { ErrorEvent, GeoJSONSource, LngLatBoundsLike, MapMouseEvent, StyleSpecification } from 'maplibre-gl';
import { type CSSProperties, useEffect, useRef } from 'react';

import { assetUrl } from '../../data/config';

// worker served as a static file (scripts/copy-maplibre-worker.js runs after npm install)
maplibregl.setWorkerUrl(assetUrl('vendor/maplibre-gl-csp-worker.js'));

export type FeatureCollection = { type: 'FeatureCollection'; features: Feature[] };
export type Feature = { type: 'Feature'; geometry: unknown; properties: Record<string, unknown> };

export const METROPOLE: LngLatBoundsLike = [
  [-5.3, 41.3],
  [9.7, 51.2],
];

const BASEMAPS = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

const plainStyle = (dark: boolean): StyleSpecification => ({
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': dark ? '#1a1916' : '#f4f2ec' } }],
});

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

type MapCanvasProps = {
  polygons: FeatureCollection | null;
  points: FeatureCollection | null;
  dark: boolean;
  /** Bounds to fit when they change (drill-down). */
  bounds: LngLatBoundsLike | null;
  onHover: (properties: Record<string, unknown> | null, position: { x: number; y: number } | null) => void;
  onClick: (properties: Record<string, unknown>, layer: 'polygons' | 'points') => void;
  onZoom?: (zoom: number) => void;
  style?: CSSProperties;
};

const addLayers = (map: maplibregl.Map, dark: boolean) => {
  const line = dark ? '#3d3a33' : '#ffffff';
  if (!map.getSource('polygons')) {
    map.addSource('polygons', { type: 'geojson', data: EMPTY as never, promoteId: 'code' });
    map.addLayer({ id: 'polygons-fill', type: 'fill', source: 'polygons',
      paint: { 'fill-color': ['get', '_fill'], 'fill-opacity': 0.82 } });
    map.addLayer({ id: 'polygons-line', type: 'line', source: 'polygons',
      paint: { 'line-color': line, 'line-width': 0.6 } });
    map.addLayer({ id: 'polygons-hover', type: 'line', source: 'polygons',
      paint: { 'line-color': dark ? '#ece9e2' : '#1d1c1a',
        'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2, 0] } });
  }
  if (!map.getSource('points')) {
    map.addSource('points', { type: 'geojson', data: EMPTY as never });
    map.addLayer({ id: 'points', type: 'circle', source: 'points',
      paint: { 'circle-color': ['get', '_fill'], 'circle-radius': ['get', '_r'], 'circle-opacity': 0.9,
        'circle-stroke-color': dark ? '#131210' : '#ffffff', 'circle-stroke-width': 0.6 } });
  }
};

export const MapCanvas = ({ polygons, points, dark, bounds, onHover, onClick, onZoom, style }: MapCanvasProps) => {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const data = useRef({ polygons, points });
  const handlers = useRef({ onHover, onClick, onZoom });
  const hovered = useRef<string | number | null>(null);

  useEffect(() => {
    handlers.current = { onHover, onClick, onZoom };
  }, [onHover, onClick, onZoom]);

  // one map per mounted canvas; the theme switches its basemap
  useEffect(() => {
    if (!container.current) {
      return;
    }
    const map = new maplibregl.Map({
      container: container.current,
      style: BASEMAPS[dark ? 'dark' : 'light'],
      bounds: METROPOLE,
      fitBoundsOptions: { padding: 12 },
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as { __cyMap?: maplibregl.Map }).__cyMap = map; // browser checks in development
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    let loaded = false;
    const fallback = setTimeout(() => {
      if (!loaded) {
        map.setStyle(plainStyle(dark)); // basemap blocked or slow: keep the data readable
      }
    }, 6000);
    map.on('error', (event: ErrorEvent) => {
      if (!loaded && /style|fetch|Failed/i.test(String(event.error?.message ?? ''))) {
        map.setStyle(plainStyle(dark));
      }
    });
    map.on('style.load', () => {
      loaded = true;
      addLayers(map, dark);
      (map.getSource('polygons') as GeoJSONSource).setData((data.current.polygons ?? EMPTY) as never);
      (map.getSource('points') as GeoJSONSource).setData((data.current.points ?? EMPTY) as never);
      map.resize();
      map.triggerRepaint();
    });
    const hover = (layer: 'polygons' | 'points') => (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      map.getCanvas().style.cursor = feature ? 'pointer' : '';
      if (layer === 'polygons') {
        if (hovered.current != null) {
          map.setFeatureState({ source: 'polygons', id: hovered.current }, { hover: false });
        }
        hovered.current = feature?.id ?? null;
        if (hovered.current != null) {
          map.setFeatureState({ source: 'polygons', id: hovered.current }, { hover: true });
        }
      }
      handlers.current.onHover(feature ? (feature.properties as Record<string, unknown>) : null, {
        x: event.point.x,
        y: event.point.y,
      });
    };
    const leave = () => {
      map.getCanvas().style.cursor = '';
      if (hovered.current != null) {
        map.setFeatureState({ source: 'polygons', id: hovered.current }, { hover: false });
        hovered.current = null;
      }
      handlers.current.onHover(null, null);
    };
    map.on('mousemove', 'polygons-fill', hover('polygons'));
    map.on('mousemove', 'points', hover('points'));
    map.on('mouseleave', 'polygons-fill', leave);
    map.on('mouseleave', 'points', leave);
    // a point above a polygon wins the click
    map.on('click', (event: MapMouseEvent) => {
      const [point] = map.queryRenderedFeatures(event.point, { layers: ['points'] });
      if (point) {
        handlers.current.onClick(point.properties as Record<string, unknown>, 'points');
        return;
      }
      const [polygon] = map.queryRenderedFeatures(event.point, { layers: ['polygons-fill'] });
      if (polygon) {
        handlers.current.onClick(polygon.properties as Record<string, unknown>, 'polygons');
      }
    });
    map.on('zoomend', () => handlers.current.onZoom?.(map.getZoom()));
    // the DOM screen sizes its container after the map is created: resize and redraw when it does
    const observer = new ResizeObserver(() => {
      map.resize();
      map.triggerRepaint();
    });
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      clearTimeout(fallback);
      map.remove();
      mapRef.current = null;
    };
  }, [dark]);

  useEffect(() => {
    data.current = { polygons, points };
    const map = mapRef.current;
    (map?.getSource('polygons') as GeoJSONSource | undefined)?.setData((polygons ?? EMPTY) as never);
    (map?.getSource('points') as GeoJSONSource | undefined)?.setData((points ?? EMPTY) as never);
    map?.triggerRepaint();
  }, [polygons, points]);

  useEffect(() => {
    if (bounds && mapRef.current) {
      mapRef.current.fitBounds(bounds, { padding: 16, duration: 600 });
    }
  }, [bounds]);

  return <div ref={container} style={{ width: '100%', height: '100%', ...style }} />;
};

/** Bounding box of a feature collection (polygons or points). */
export const boundsOf = (collection: FeatureCollection): LngLatBoundsLike | null => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (coords: unknown) => {
    if (Array.isArray(coords) && typeof coords[0] === 'number') {
      const [x, y] = coords as number[];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    } else if (Array.isArray(coords)) {
      coords.forEach(visit);
    }
  };
  collection.features.forEach((f) => visit((f.geometry as { coordinates?: unknown })?.coordinates));
  return Number.isFinite(minX) ? [[minX, minY], [maxX, maxY]] : null;
};
