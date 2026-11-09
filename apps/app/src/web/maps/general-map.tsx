// The general map (docs/features/018-speed-and-map/spec.md, Map): départements at low zoom; from zoom 7, or after a
// right click on a département, the communes of the département under the centre of the map, kept while panning
// inside it and switched when the centre crosses into another one. Hover shows a card with the figures and where a
// click leads (département page, commune page, or nothing when a commune has too few sales).
// Fills are derived only when the layer, type, metric or palette change; hover state lives in MapCanvas.
import { type CSSProperties, useEffect, useMemo, useState } from 'react';

import { type DepartementLevel, type FranceLevel, type LevelPlace, loadDepartementLevel, loadFranceLevel } from '../../data/api';
import { catalogueEntry } from '../../data/catalogue';
import { formatCount, formatEurosPerM2, formatSignedPercent } from '../../data/format';
import { type Breaks, hasPlacePage, loadBreaks, loadMapLayer, type MapLayer, type MapProperties, type MetricBase, METRICS, metricKey } from '../../data/map';
import { colorFor, legendItems, type Palette } from '../../data/scales';
import type { DwellingType, GeoLevel } from '../../data/types';
import { legendLabel } from '../hooks/phone';
import { useDark } from '../hooks/use-dark';
import { boundsOf, type Feature, type FeatureCollection, type MapHit, MapCanvas, type MapLayerName, type MapView, METROPOLE } from './map-canvas';

/** Zoom from which the communes of the département under the centre are shown. */
const TOUCH = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

export const DETAIL_ZOOM = 7;

type Bounds = [[number, number], [number, number]];
/** A framing request; the latest one wins (parent buttons or the map's own actions). */
export type FrameRequest = { bounds: Bounds; at: number };

type Active = {
  code: string | null;
  /** Zoom under which the communes are dropped (lower after a right click on a large département). */
  threshold: number;
  /** A right click asked for this département: its fit is under way, the next move sets the threshold. */
  pending: boolean;
};

const NONE: Active = { code: null, threshold: DETAIL_ZOOM, pending: false };

type Target = { href: string; name: string } | null;

type GeneralMapProps = {
  type: DwellingType;
  palette: Palette;
  navigate: (href: string) => void;
  metric?: MetricBase;
  /** Light to dark whatever the metric's good end (the France page's price map). */
  neutral?: boolean;
  mode?: 'choropleth' | 'points';
  /** Points mode: commune / section points, built by the page. */
  points?: FeatureCollection | null;
  /** Fit these bounds (overseas buttons, "France entière"). */
  frame?: FrameRequest | null;
  /** Département to open on load (old /map links). */
  focus?: string | null;
  /** Département whose communes are shown, and the zoom, after each move. */
  onView?: (view: { dep: string | null; zoom: number }) => void;
  /** Status bar (département shown, links) inside the map. */
  overlay?: boolean;
  /** Legend inside the map (off when the page draws its own). */
  legend?: boolean;
  style?: CSSProperties;
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const SPLIT = /^(751|6938|132[01])/;

/** Where a click on a hovered feature leads. */
const targetOf = (hit: MapHit, type: DwellingType): Target => {
  const p = hit.properties;
  const query = `?type=${type}`;
  if (hit.layer === 'polygons') {
    return { href: `/departement/${String(p.code)}${query}`, name: String(p.nom ?? p.code) };
  }
  if (hit.layer === 'detail') {
    return hasPlacePage(p as MapProperties)
      ? { href: `/place/${String(p.level ?? 'commune')}/${String(p.code)}${query}`, name: String(p.nom ?? p.code) }
      : null;
  }
  if (p._kind === 'section') {
    const commune = String(p.commune);
    const level: GeoLevel = SPLIT.test(commune) ? 'arrondissement' : 'commune';
    return { href: `/place/${level}/${commune}${query}`, name: `la commune ${commune}` };
  }
  return { href: `/place/${String(p.level ?? 'commune')}/${String(p.code)}${query}`, name: String(p.name ?? p.code) };
};

const HoverCard = ({ hit, type, metric, deps, communes, detailDep }: {
  hit: MapHit;
  type: DwellingType;
  metric: MetricBase;
  deps: Map<string, LevelPlace> | null;
  communes: Map<string, LevelPlace> | null;
  detailDep: string | null;
}) => {
  const p = hit.properties;
  const code = String(p.code ?? '');
  const target = targetOf(hit, type);
  const section = p._kind === 'section';
  let kind = 'Département';
  let name = String(p.nom ?? p.name ?? code);
  let price: number | null;
  let yoy: number | null = null;
  let sales: number | null;
  if (hit.layer === 'points') {
    kind = section ? 'Section cadastrale' : p.level === 'arrondissement' ? 'Arrondissement' : 'Commune';
    name = section ? `Section ${String(p.section).slice(8)} · ${String(p.commune)}` : name;
    price = num(p.median_price_m2);
    yoy = num(p.yoy_change);
    sales = num(p.n);
  } else {
    const row = (hit.layer === 'polygons' ? deps : communes)?.get(code);
    kind = hit.layer === 'polygons' ? 'Département' : p.level === 'arrondissement' ? 'Arrondissement' : 'Commune';
    price = row?.price ?? num(p[`price_${type}`]);
    yoy = row?.yoy ?? null;
    sales = row?.n ?? num(p[`sales_${type}`]);
  }
  const focus = metric !== 'price' && hit.layer !== 'points' ? METRICS.find((m) => m.base === metric) : undefined;
  const focusValue = focus ? num(p[metricKey(focus.base, type)]) : null;
  const rows: [string, string][] = [
    ['Prix médian', formatEurosPerM2(price)],
    ...(section ? [] : [['Sur un an', formatSignedPercent(yoy)] as [string, string]]),
    [section ? 'Ventes (2 ans)' : 'Ventes', formatCount(sales)],
  ];
  return (
    <>
      <div className="ink-3" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {kind} · {section ? String(p.commune) : code}
      </div>
      <div style={{ fontWeight: 600, margin: '1px 0 4px' }}>{name}</div>
      {focus && focusValue != null && (
        <div style={{ marginBottom: 4 }}>
          <span className="ink-2">{focus.label} : </span>
          <b>{focus.format(focusValue)}</b>
        </div>
      )}
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td className="ink-2" style={{ padding: '1px 8px 1px 0' }}>{label}</td>
              <td className="num" style={{ textAlign: 'right', padding: '1px 0' }}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 6, paddingTop: 5, borderTop: '1px solid var(--line)', fontWeight: 500, color: target ? 'var(--accent)' : 'var(--ink-3)' }}>
        {target ? `Clic : explorer ${target.name} en détail` : 'Pas assez de ventes pour une fiche'}
      </div>
      {hit.layer === 'polygons' && detailDep !== code && (
        <div className="ink-3" style={{ fontSize: 11 }}>Clic droit ou zoom : voir ses communes</div>
      )}
    </>
  );
};

const withFill = (layer: MapLayer, key: string, breaks: number[], palette: Palette, higher: boolean | null, transparent: boolean): FeatureCollection => ({
  type: 'FeatureCollection',
  features: (layer.features as unknown as Feature[]).map((f) => ({
    ...f,
    properties: { ...f.properties, _fill: transparent ? 'rgba(0,0,0,0)' : colorFor(f.properties[key], breaks, palette, higher) },
  })),
});

export const GeneralMap = ({
  type, palette, navigate, metric = 'price', neutral = false, mode = 'choropleth', points = null, frame = null, focus = null,
  onView, overlay = true, legend: showLegend = true, style,
}: GeneralMapProps) => {
  const dark = useDark();
  const [departements, setDepartements] = useState<MapLayer | null>(null);
  const [breaks, setBreaks] = useState<Breaks | null>(null);
  const [level, setLevel] = useState<FranceLevel | null>(null);
  const [active, setActive] = useState<Active>(NONE);
  const [communes, setCommunes] = useState<{ dep: string; layer: MapLayer } | null>(null);
  const [depLevel, setDepLevel] = useState<{ dep: string; data: DepartementLevel } | null>(null);
  const [fit, setFit] = useState<FrameRequest>({ bounds: METROPOLE as Bounds, at: 0 });
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // the département layer and breaks are shared with every page through the loaders' caches
  useEffect(() => {
    let current = true;
    const fail = (e: Error) => current && setError(e.message);
    loadMapLayer('departements.geojson').then((layer) => {
      if (!current) {
        return;
      }
      setDepartements(layer);
      const feature = focus ? layer.features.find((f) => f.properties.code === focus) : undefined;
      const bounds = feature ? boundsOf({ type: 'FeatureCollection', features: [feature as unknown as Feature] }) : null;
      if (focus && bounds) {
        setActive({ code: focus, threshold: -Infinity, pending: true });
        setFit({ bounds: bounds as Bounds, at: Date.now() });
      }
    }, fail);
    loadBreaks().then((b) => current && setBreaks(b), fail);
    loadFranceLevel().then((l) => current && setLevel(l), () => undefined); // figures of the card only
    return () => {
      current = false;
    };
  }, [focus, attempt]);

  useEffect(() => {
    const dep = active.code;
    if (!dep) {
      return;
    }
    let current = true;
    loadMapLayer(`communes/${dep}.geojson`).then((layer) => current && setCommunes({ dep, layer }), (e: Error) => current && setError(e.message));
    // the card's 1-year changes; it is also the département page's file, ready if the user clicks
    loadDepartementLevel(dep).then((data) => current && setDepLevel({ dep, data }), () => undefined);
    return () => {
      current = false;
    };
  }, [active.code, attempt]);

  const key = metricKey(metric, type);
  const higher = neutral ? null : catalogueEntry(metric)?.higherIsBetter ?? null;
  const transparent = mode === 'points';
  const depBreaks = breaks?.departements[key];
  const communeBreaks = breaks?.communes[key];
  const shownCommunes = active.code && communes?.dep === active.code ? communes.layer : null;

  const polygons = useMemo(
    () => (departements ? withFill(departements, key, depBreaks ?? [], palette, higher, transparent) : null),
    [departements, key, depBreaks, palette, higher, transparent],
  );
  const detail = useMemo(
    () => (shownCommunes ? withFill(shownCommunes, key, communeBreaks ?? [], palette, higher, transparent) : null),
    [shownCommunes, key, communeBreaks, palette, higher, transparent],
  );
  const depRows = useMemo(() => (level ? new Map(level.types[type].rows.map((r) => [r.code, r])) : null), [level, type]);
  const communeRows = useMemo(
    () => (depLevel && depLevel.dep === active.code ? new Map(depLevel.data.types[type].communes.map((r) => [r.code, r])) : null),
    [depLevel, active.code, type],
  );

  const onMove = ({ zoom, centre }: MapView) => {
    const centreCode = centre?.code == null ? null : String(centre.code);
    setActive((prev) => {
      if (prev.pending) {
        return { ...prev, threshold: Math.min(DETAIL_ZOOM, zoom - 0.5), pending: false };
      }
      if (zoom < prev.threshold) {
        return prev.code == null && prev.threshold === DETAIL_ZOOM ? prev : NONE;
      }
      const code = centreCode ?? prev.code;
      return code === prev.code ? prev : { ...prev, code };
    });
  };

  // report the département actually shown (the centre may be over the sea, or a right click may have pinned one);
  // onView must be stable (a state setter): it is called after each move, not on every render
  const [lastZoom, setLastZoom] = useState(5);
  const report = (view: MapView) => {
    setLastZoom(view.zoom);
    onMove(view);
  };
  useEffect(() => {
    onView?.({ dep: active.code, zoom: lastZoom });
  }, [active.code, lastZoom, onView]);

  const zoomInto = (code: string) => {
    const feature = departements?.features.find((f) => f.properties.code === code);
    const bounds = feature ? boundsOf({ type: 'FeatureCollection', features: [feature as unknown as Feature] }) : null;
    if (bounds) {
      setActive({ code, threshold: -Infinity, pending: true });
      setFit({ bounds: bounds as Bounds, at: Date.now() });
    }
  };
  const reset = () => {
    setActive(NONE);
    setFit({ bounds: METROPOLE as Bounds, at: Date.now() });
  };

  const bounds = frame && frame.at > fit.at ? frame.bounds : fit.bounds;
  const activeName = active.code ? String(departements?.features.find((f) => f.properties.code === active.code)?.properties.nom ?? active.code) : null;
  const legendBreaks = (active.code ? communeBreaks : depBreaks) ?? [];
  const metricInfo = METRICS.find((m) => m.base === metric) ?? METRICS[0];
  const legend = showLegend && !transparent ? legendItems(legendBreaks, metricInfo.format, palette, higher) : [];

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', ...style }}>
      <MapCanvas
        polygons={polygons}
        detail={detail}
        points={points}
        dark={dark}
        bounds={bounds as never}
        style={{ position: 'absolute', inset: 0 }}
        onMove={report}
        onClick={(p, layer: MapLayerName) => {
          const target = targetOf({ properties: p, layer }, type);
          if (target) {
            navigate(target.href);
          }
        }}
        onContextMenu={(p, layer) => {
          if (layer === 'polygons') {
            zoomInto(String(p.code));
          }
        }}
        renderHover={(hit) => (
          <HoverCard hit={hit} type={type} metric={metric} deps={depRows} communes={communeRows} detailDep={shownCommunes ? active.code : null} />
        )}
      />
      {overlay && (
        <div className="cy-note cy-gmap-hint" style={{ position: 'absolute', left: 8, top: 8, zIndex: 4, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
          background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 3, padding: '3px 8px', maxWidth: 'calc(100% - 60px)' }}>
          {active.code ? (
            <>
              <b>{activeName} ({active.code})</b>
              <span>· {shownCommunes ? 'communes' : 'chargement des communes…'}</span>
              <button type="button" className="cy-button ghost" style={{ height: 20, padding: '0 6px' }}
                onClick={() => navigate(`/departement/${active.code}?type=${type}`)}>
                Explorer le département →
              </button>
              <button type="button" className="cy-button ghost" style={{ height: 20, padding: '0 6px' }} onClick={reset}>
                France entière
              </button>
            </>
          ) : (
            <span>{TOUCH ? 'Deux doigts pour zoomer · touchez un département' : 'Zoomez (ou clic droit sur un département) pour voir ses communes'}</span>
          )}
        </div>
      )}
      {legend.length > 0 && (
        <div className="cy-note cy-gmap-legend" style={{ position: 'absolute', left: 8, bottom: 8, zIndex: 4, display: 'flex', flexWrap: 'wrap', gap: '2px 10px',
          background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 3, padding: '3px 8px', maxWidth: 'calc(100% - 120px)' }}>
          <span className="ink-2">{metricInfo.label} · {active.code ? 'communes' : 'départements'}</span>
          {legend.map((item) => (
            <span key={item.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span aria-hidden style={{ width: 10, height: 10, background: item.color, display: 'inline-block' }} />
              {legendLabel(item.label)}
            </span>
          ))}
        </div>
      )}
      {error && (
        <div className="cy-banner" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
          Données de carte indisponibles ({error}).
          <button type="button" className="cy-button ghost" onClick={() => { setError(null); setAttempt((a) => a + 1); }}>Réessayer</button>
        </div>
      )}
    </div>
  );
};
