// MapLibre map for DOM screens: a polygon layer (choropleth), an optional detail polygon layer drawn above it
// (communes of one département) and a point layer (communes, sections, buildings), all coloured by a precomputed `_fill`
// property. The map is created once per theme; data changes only call setData.
// Hover is read once per animation frame: the hovered feature is React state here (it changes only when the
// pointer crosses a boundary), the floating card follows the cursor by style, without re-rendering.
// The basemap is OpenFreeMap (free vector tiles); if it cannot load, the data draws on a plain background.
import 'maplibre-gl/dist/maplibre-gl.css';

import * as maplibregl from 'maplibre-gl/dist/maplibre-gl-csp';

import type { ErrorEvent, GeoJSONSource, LngLatBoundsLike, MapMouseEvent, PointLike, StyleSpecification } from 'maplibre-gl';
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { assetUrl } from '../../data/config';
import { basemapStyle, LABELS_FROM } from './basemap';

// worker served as a static file (scripts/copy-maplibre-worker.js runs after npm install)
maplibregl.setWorkerUrl(assetUrl('vendor/maplibre-gl-csp-worker.js'));

export type FeatureCollection = { type: 'FeatureCollection'; features: Feature[] };
export type Feature = { type: 'Feature'; geometry: unknown; properties: Record<string, unknown> };

/** Which layer a hovered or clicked feature belongs to. */
export type MapLayerName = 'polygons' | 'detail' | 'points';
export type MapHit = { properties: Record<string, unknown>; layer: MapLayerName };
/** Camera after a move: zoom and the polygon (base layer) under the centre of the map. */
export type MapView = { zoom: number; centre: Record<string, unknown> | null };

export const METROPOLE: LngLatBoundsLike = [
  [-5.3, 41.3],
  [9.7, 51.2],
];


const plainStyle = (dark: boolean): StyleSpecification => ({
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': dark ? '#1a1916' : '#f4f2ec' } }],
});

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const LAYER_OF: Record<string, MapLayerName> = { 'polygons-fill': 'polygons', 'detail-fill': 'detail', points: 'points' };
const CARD_GAP = 14;
/** Phone (023): no hover, so a first tap shows the card and a second tap on the same shape opens it. */
const TOUCH = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

type MapCanvasProps = {
  polygons: FeatureCollection | null;
  points: FeatureCollection | null;
  /** Finer polygons drawn above `polygons` (communes of one département); the base outlines stay on top. */
  detail?: FeatureCollection | null;
  dark: boolean;
  /** Bounds to fit when they change (drill-down). */
  bounds: LngLatBoundsLike | null;
  /** Called at most once per frame while the pointer moves over the data. */
  onHover?: (properties: Record<string, unknown> | null, position: { x: number; y: number } | null) => void;
  onClick: (properties: Record<string, unknown>, layer: MapLayerName) => void;
  /** Right click on a feature (the browser menu is then suppressed). */
  onContextMenu?: (properties: Record<string, unknown>, layer: MapLayerName) => void;
  onZoom?: (zoom: number) => void;
  /** After every pan or zoom. */
  onMove?: (view: MapView) => void;
  /** Floating card next to the cursor for the hovered feature. */
  renderHover?: (hit: MapHit) => ReactNode;
  style?: CSSProperties;
};

const addLayers = (map: maplibregl.Map, dark: boolean) => {
  const line = dark ? '#3d3a33' : '#ffffff';
  const ink = dark ? '#ece9e2' : '#1d1c1a';
  const hoverWidth = ['case', ['boolean', ['feature-state', 'hover'], false], 2, 0] as never;
  if (map.getSource('polygons')) {
    return;
  }
  // outlines simplified to 100 m–1 km already: no need to tile them past zoom 12, the worker does less on each zoom
  map.addSource('polygons', { type: 'geojson', data: EMPTY as never, promoteId: 'code', maxzoom: 12, tolerance: 0.5 });
  map.addSource('detail', { type: 'geojson', data: EMPTY as never, promoteId: 'code', maxzoom: 12, tolerance: 0.5 });
  map.addSource('points', { type: 'geojson', data: EMPTY as never, maxzoom: 14 });
  // under the basemap labels, so place and street names stay readable over the colours
  const before = map.getLayer(LABELS_FROM) ? LABELS_FROM : undefined;
  const addLayer = (layer: Parameters<maplibregl.Map['addLayer']>[0]) => map.addLayer(layer, before);
  addLayer({ id: 'polygons-fill', type: 'fill', source: 'polygons', paint: { 'fill-color': ['get', '_fill'], 'fill-opacity': 0.82 } });
  addLayer({ id: 'detail-fill', type: 'fill', source: 'detail', paint: { 'fill-color': ['get', '_fill'], 'fill-opacity': 0.86 } });
  addLayer({ id: 'detail-line', type: 'line', source: 'detail', paint: { 'line-color': line, 'line-width': 0.4 } });
  addLayer({ id: 'polygons-line', type: 'line', source: 'polygons', paint: { 'line-color': line, 'line-width': 0.6 } });
  addLayer({ id: 'detail-hover', type: 'line', source: 'detail', paint: { 'line-color': ink, 'line-width': hoverWidth } });
  addLayer({ id: 'polygons-hover', type: 'line', source: 'polygons', paint: { 'line-color': ink, 'line-width': hoverWidth } });
  addLayer({ id: 'points', type: 'circle', source: 'points',
    paint: { 'circle-color': ['get', '_fill'], 'circle-radius': ['get', '_r'], 'circle-opacity': 0.9,
      // a point may carry its own ring (_stroke, _strokeColor): the selected building of the sales map
      'circle-stroke-color': ['coalesce', ['get', '_strokeColor'], dark ? '#131210' : '#ffffff'] as never,
      'circle-stroke-width': ['coalesce', ['get', '_stroke'], 0.6] as never } });
};

/** With communes shown, the département outlines turn dark so the two levels read apart. */
const styleOutlines = (map: maplibregl.Map, dark: boolean, detail: boolean) => {
  if (!map.getLayer('polygons-line')) {
    return;
  }
  map.setPaintProperty('polygons-line', 'line-color', detail ? (dark ? '#ece9e2' : '#1d1c1a') : dark ? '#3d3a33' : '#ffffff');
  map.setPaintProperty('polygons-line', 'line-width', detail ? 1.1 : 0.6);
};

const setSources = (map: maplibregl.Map, data: { polygons: FeatureCollection | null; points: FeatureCollection | null; detail: FeatureCollection | null }) => {
  (map.getSource('polygons') as GeoJSONSource | undefined)?.setData((data.polygons ?? EMPTY) as never);
  (map.getSource('detail') as GeoJSONSource | undefined)?.setData((data.detail ?? EMPTY) as never);
  (map.getSource('points') as GeoJSONSource | undefined)?.setData((data.points ?? EMPTY) as never);
};

export const MapCanvas = ({ polygons, points, detail = null, dark, bounds, onHover, onClick, onContextMenu, onZoom, onMove, renderHover, style }: MapCanvasProps) => {
  const container = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const data = useRef({ polygons, points, detail });
  const handlers = useRef({ onHover, onClick, onContextMenu, onZoom, onMove, hasCard: Boolean(renderHover) });
  const pointer = useRef<{ x: number; y: number } | null>(null);
  // last framing asked for, and whether the user moved the map since (then a resize keeps their view)
  const framing = useRef<{ bounds: LngLatBoundsLike; userMoved: boolean }>({ bounds: bounds ?? METROPOLE, userMoved: false });
  const [hit, setHit] = useState<MapHit | null>(null);

  useEffect(() => {
    handlers.current = { onHover, onClick, onContextMenu, onZoom, onMove, hasCard: Boolean(renderHover) };
  }, [onHover, onClick, onContextMenu, onZoom, onMove, renderHover]);

  // one map per mounted canvas; the theme switches its basemap
  useEffect(() => {
    const element = container.current;
    if (!element) {
      return;
    }
    const map = new maplibregl.Map({
      container: element,
      style: basemapStyle(dark),
      fadeDuration: 0, // no label fade-in: every fade frame is a full redraw
      bounds: METROPOLE,
      fitBoundsOptions: { padding: 12 },
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      // phone: one finger scrolls the page, two fingers move the map (else the map traps the page scroll)
      cooperativeGestures: TOUCH,
      locale: {
        'CooperativeGesturesHandler.WindowsHelpText': 'Ctrl + molette pour zoomer la carte',
        'CooperativeGesturesHandler.MacHelpText': '⌘ + molette pour zoomer la carte',
        'CooperativeGesturesHandler.MobileHelpText': 'Deux doigts pour déplacer la carte',
      },
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
    const refit = () => {
      if (!framing.current.userMoved && element.clientWidth > 0 && element.clientHeight > 0) {
        map.fitBounds(framing.current.bounds, { padding: 16, duration: 0 });
      }
    };
    map.on('movestart', (event: { originalEvent?: Event }) => {
      if (event.originalEvent) {
        framing.current.userMoved = true;
      }
    });
    map.on('style.load', () => {
      if (!loaded) {
        refit();
      }
      loaded = true;
      addLayers(map, dark);
      setSources(map, data.current);
      styleOutlines(map, dark, Boolean(data.current.detail?.features.length));
      map.resize();
      map.triggerRepaint();
    });

    // topmost feature under a pixel: point, then commune, then département
    const hitAt = (point: PointLike): (MapHit & { id: string }) | null => {
      const layers = Object.keys(LAYER_OF).filter((id) => map.getLayer(id));
      const [feature] = layers.length ? map.queryRenderedFeatures(point, { layers }) : [];
      if (!feature) {
        return null;
      }
      const properties = feature.properties as Record<string, unknown>;
      const layer = LAYER_OF[feature.layer.id];
      return { properties, layer, id: `${layer}:${String(feature.id ?? properties.section ?? properties.code)}:${String(properties.type ?? '')}` };
    };

    const hoverState = { id: null as string | null, source: null as 'polygons' | 'detail' | null, feature: null as string | number | null };
    const setFeatureHover = (next: MapHit | null) => {
      if (hoverState.source && hoverState.feature != null) {
        map.setFeatureState({ source: hoverState.source, id: hoverState.feature }, { hover: false });
      }
      hoverState.source = next && next.layer !== 'points' ? next.layer : null;
      hoverState.feature = hoverState.source ? (next?.properties.code as string | number) ?? null : null;
      if (hoverState.source && hoverState.feature != null) {
        map.setFeatureState({ source: hoverState.source, id: hoverState.feature }, { hover: true });
      }
    };

    let frame = 0;
    let lastPoint: { x: number; y: number } | null = null;
    const readHover = () => {
      frame = 0;
      if (!lastPoint) {
        return;
      }
      const found = hitAt([lastPoint.x, lastPoint.y]);
      pointer.current = lastPoint;
      map.getCanvas().style.cursor = found ? 'pointer' : '';
      if ((found?.id ?? null) !== hoverState.id) {
        hoverState.id = found?.id ?? null;
        setFeatureHover(found);
        if (handlers.current.hasCard) {
          setHit(found ? { properties: found.properties, layer: found.layer } : null);
        }
      }
      placeCard(card.current, element, lastPoint);
      handlers.current.onHover?.(found ? found.properties : null, found ? lastPoint : null);
    };
    const clear = () => {
      lastPoint = null;
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      map.getCanvas().style.cursor = '';
      if (hoverState.id != null) {
        hoverState.id = null;
        setFeatureHover(null);
        setHit(null);
        handlers.current.onHover?.(null, null);
      }
    };
    map.on('mousemove', (event: MapMouseEvent) => {
      lastPoint = { x: event.point.x, y: event.point.y };
      if (!frame) {
        frame = requestAnimationFrame(readHover);
      }
    });
    map.on('mouseout', clear);
    map.on('movestart', () => {
      if (hoverState.id != null) {
        clear();
      }
    });
    map.on('click', (event: MapMouseEvent) => {
      const found = hitAt(event.point);
      if (found && TOUCH && handlers.current.hasCard && found.id !== hoverState.id) {
        lastPoint = { x: event.point.x, y: event.point.y };
        readHover();
        return;
      }
      if (found) {
        clear();
        handlers.current.onClick(found.properties, found.layer);
      }
    });
    map.on('contextmenu', (event: MapMouseEvent) => {
      const found = hitAt(event.point);
      if (found && handlers.current.onContextMenu) {
        event.originalEvent.preventDefault();
        clear();
        handlers.current.onContextMenu(found.properties, found.layer);
      }
    });
    if (TOUCH) {
      // phone: the credits start folded into their (i) button instead of covering the map
      map.once('load', () => element.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
    }
    map.on('zoomend', () => handlers.current.onZoom?.(map.getZoom()));
    map.on('moveend', () => {
      const move = handlers.current.onMove;
      if (!move) {
        return;
      }
      const { clientWidth, clientHeight } = map.getCanvas();
      const [centre] = map.getLayer('polygons-fill')
        ? map.queryRenderedFeatures([clientWidth / 2, clientHeight / 2], { layers: ['polygons-fill'] })
        : [];
      move({ zoom: map.getZoom(), centre: centre ? (centre.properties as Record<string, unknown>) : null });
    });
    // the DOM screen sizes its container after the map is created: resize and redraw when it does
    const observer = new ResizeObserver(() => {
      map.resize();
      refit(); // a framing asked for before the container had its size
      map.triggerRepaint();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      clearTimeout(fallback);
      if (frame) {
        cancelAnimationFrame(frame);
      }
      map.remove();
      mapRef.current = null;
    };
  }, [dark]);

  useEffect(() => {
    data.current = { polygons, points, detail };
    const map = mapRef.current;
    if (!map) {
      return;
    }
    setSources(map, data.current);
    styleOutlines(map, dark, Boolean(detail?.features.length));
    map.triggerRepaint();
  }, [polygons, points, detail, dark]);

  useEffect(() => {
    if (!bounds) {
      return;
    }
    framing.current = { bounds, userMoved: false };
    mapRef.current?.fitBounds(bounds, { padding: 16, duration: 600 });
  }, [bounds]);

  // a card that just mounted takes the last pointer position before paint
  useLayoutEffect(() => {
    placeCard(card.current, container.current, pointer.current);
  }, [hit]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', ...style }}>
      <div ref={container} style={{ position: 'absolute', inset: 0 }} />
      {renderHover && hit && (
        <div ref={card} role="tooltip" className={TOUCH ? 'cy-map-card touch' : 'cy-map-card'}
          style={{ position: 'absolute', left: 0, top: 0, zIndex: 5, pointerEvents: 'none', willChange: 'transform',
            background: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: 3, padding: '8px 10px',
            minWidth: 200, maxWidth: 280, fontSize: 12, boxShadow: '0 2px 10px rgba(0,0,0,0.12)' }}>
          {renderHover(hit)}
        </div>
      )}
    </div>
  );
};

/** Card beside the cursor, flipped left / up near the right / bottom edge so it stays inside the map. */
const placeCard = (element: HTMLDivElement | null, frame: HTMLDivElement | null, point: { x: number; y: number } | null) => {
  if (!element || !frame || !point) {
    return;
  }
  const { offsetWidth: w, offsetHeight: h } = element;
  const x = point.x + CARD_GAP + w > frame.clientWidth ? Math.max(0, point.x - CARD_GAP - w) : point.x + CARD_GAP;
  const y = point.y + CARD_GAP + h > frame.clientHeight ? Math.max(0, point.y - CARD_GAP - h) : point.y + CARD_GAP;
  element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
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
