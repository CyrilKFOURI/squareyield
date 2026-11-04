'use dom';

// Carte: France by département → communes (choropleth, green = good end, red = bad end), or points placed
// at their coordinates (communes; cadastral sections when zoomed into a département). Hover shows the key
// figures, click opens the place's mini dashboard in the side panel.
import { useEffect, useState } from 'react';

import { type CommunePoint, loadCommunePoints, loadPointBreaks, loadSectionPoints, type SectionPoint } from '../../data/api';
import { catalogueEntry } from '../../data/catalogue';
import { formatCount, formatEurosPerM2, formatPercent, formatSignedPercent } from '../../data/format';
import { type Breaks, loadBreaks, loadMapLayer, type MapLayer, METRICS, metricKey } from '../../data/map';
import { colorFor, GREY, legendItems, type Palette } from '../../data/scales';
import type { DwellingType, GeoLevel } from '../../data/types';
import { FilterBar, FilterField, Segmented } from '../components/controls';
import { Panel } from '../components/panel';
import { PlaceDetail } from '../components/place-detail';
import { Shell } from '../components/shell';
import { boundsOf, type Feature, type FeatureCollection, MapCanvas, METROPOLE } from '../maps/map-canvas';
import { useDark } from '../hooks/use-dark';
import type { ScreenProps } from '../screen-props';

type Mode = 'choropleth' | 'points';
const SECTION_ZOOM = 10.5;
const RELIABLE = 30;
// the points file carries these figures (cagr-based trend, score… are on polygons only)
const POINT_FIELDS: Record<string, keyof CommunePoint> = {
  price: 'median_price_m2',
  yield: 'gross_yield',
  cash_flow: 'cash_flow_monthly',
};

const OVERSEAS: { label: string; bounds: [[number, number], [number, number]] }[] = [
  { label: 'Guadeloupe', bounds: [[-61.85, 15.8], [-60.95, 16.55]] },
  { label: 'Martinique', bounds: [[-61.25, 14.38], [-60.8, 14.9]] },
  { label: 'Guyane', bounds: [[-54.6, 2.1], [-51.6, 5.8]] },
  { label: 'La Réunion', bounds: [[55.2, -21.4], [55.85, -20.85]] },
  { label: 'Mayotte', bounds: [[44.95, -13.05], [45.35, -12.6]] },
];

const fmt = (base: string) => METRICS.find((m) => m.base === base)?.format ?? ((v: number) => String(v));

export default function MapScreen({ filters, params, onFilters, onParams, navigate }: ScreenProps) {
  const type: DwellingType = filters.type === 'house' ? 'house' : 'apartment';
  const mode: Mode = params.mode === 'points' ? 'points' : 'choropleth';
  const palette: Palette = filters.palette;
  const dep = filters.level === 'departement' ? filters.code : null;
  const metric = METRICS.find((m) => m.base === filters.metric) ?? METRICS[0];
  const pointMetric = POINT_FIELDS[metric.base] ? metric : METRICS[0];
  const key = metricKey(metric.base, type);
  const higher = catalogueEntry(metric.base)?.higherIsBetter ?? null;

  const [departements, setDepartements] = useState<MapLayer | null>(null);
  const [communes, setCommunes] = useState<{ dep: string; layer: MapLayer } | null>(null);
  const [breaks, setBreaks] = useState<Breaks | null>(null);
  const [points, setPoints] = useState<CommunePoint[] | null>(null);
  const [pointBreaks, setPointBreaks] = useState<Record<string, number[]> | null>(null);
  const [sections, setSections] = useState<{ dep: string; rows: SectionPoint[]; period: string | null } | null>(null);
  const [zoom, setZoom] = useState(5);
  const [hover, setHover] = useState<{ props: Record<string, unknown>; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<{ level: GeoLevel; code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // a framing belongs to the territory it was set for: going back to France (button or browser) reframes France
  const [framing, setFraming] = useState<{ dep: string | null; bounds: [[number, number], [number, number]] } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const dark = useDark();

  useEffect(() => {
    loadMapLayer('departements.geojson').then(setDepartements, (e: Error) => setError(e.message));
    loadBreaks().then(setBreaks, (e: Error) => setError(e.message));
  }, [attempt]);
  useEffect(() => {
    if (!dep) {
      return;
    }
    let current = true;
    loadMapLayer(`communes/${dep}.geojson`).then(
      (layer) => {
        if (current) {
          setCommunes({ dep, layer });
          setFraming({ dep, bounds: boundsOf(layer as FeatureCollection) as never });
        }
      },
      (e: Error) => current && setError(e.message),
    );
    return () => {
      current = false;
    };
  }, [dep, attempt]);
  useEffect(() => {
    if (mode !== 'points') {
      return;
    }
    loadCommunePoints().then((t) => setPoints(t.rows), (e: Error) => setError(e.message));
    loadPointBreaks().then(setPointBreaks, () => setPointBreaks({}));
  }, [mode, attempt]);
  useEffect(() => {
    if (mode !== 'points' || !dep) {
      return;
    }
    let current = true;
    loadSectionPoints(dep).then(
      (t) => current && setSections({ dep, rows: t.rows, period: t.period }),
      () => current && setSections({ dep, rows: [], period: null }),
    );
    return () => {
      current = false;
    };
  }, [mode, dep]);

  const layer = dep ? (communes?.dep === dep ? communes.layer : null) : departements;
  const layerBreaks = breaks?.[dep ? 'communes' : 'departements'][key] ?? [];

  // memoised by the React Compiler
  const polygons: FeatureCollection | null = !layer
    ? null
    : {
      type: 'FeatureCollection',
      features: (layer.features as unknown as Feature[]).map((f) => ({
        ...f,
        properties: {
          ...f.properties,
          // points mode keeps the boundaries readable without competing colours
          _fill: mode === 'points' ? 'rgba(0,0,0,0)' : colorFor(f.properties[key], layerBreaks, palette, higher),
        },
      })),
    };

  const buildPoints = (): FeatureCollection | null => {
    if (mode !== 'points' || !points) {
      return null;
    }
    const field = POINT_FIELDS[pointMetric.base];
    const pBreaks = breaks?.communes[metricKey(pointMetric.base, type)] ?? [];
    const pHigher = catalogueEntry(pointMetric.base)?.higherIsBetter ?? null;
    const features: Feature[] = points
      .filter((p) => p.type === type && (!dep || p.dep === dep))
      .map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: {
          ...p,
          _kind: 'commune',
          _fill: p.n >= RELIABLE ? colorFor(p[field], pBreaks, palette, pHigher) : GREY,
          _r: Math.min(2.2 + Math.sqrt(p.n) / 5, 15),
        },
      }));
    if (dep && sections?.dep === dep && zoom >= SECTION_ZOOM) {
      const sBreaks = pointBreaks?.[`price_${type}`] ?? [];
      for (const s of sections.rows.filter((r) => r.type === type)) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
          properties: { ...s, _kind: 'section', _fill: colorFor(s.median_price_m2, sBreaks, palette, false), _r: 4.5 },
        });
      }
    }
    return { type: 'FeatureCollection', features };
  };
  const pointCollection = buildPoints();

  // section points are always coloured by price: legend and title follow them
  const showSections = mode === 'points' && Boolean(dep) && zoom >= SECTION_ZOOM;
  const legendBreaks = showSections
    ? pointBreaks?.[`price_${type}`] ?? []
    : mode === 'points'
      ? breaks?.communes[metricKey(pointMetric.base, type)] ?? []
      : layerBreaks;
  const legendMetric = showSections ? METRICS[0] : mode === 'points' ? pointMetric : metric;
  const legend = legendItems(legendBreaks, fmt(legendMetric.base), palette, catalogueEntry(legendMetric.base)?.higherIsBetter ?? null);

  const onClick = (props: Record<string, unknown>, from: 'polygons' | 'points') => {
    setHover(null);
    if (from === 'points') {
      const code = String(props._kind === 'section' ? props.commune : props.code);
      // a section's commune is an arrondissement code in Paris, Lyon and Marseille
      const sectionLevel: GeoLevel = /^(751|6938|132[01])/.test(code) ? 'arrondissement' : 'commune';
      setSelected({ level: props._kind === 'section' ? sectionLevel : (props.level as GeoLevel), code });
      return;
    }
    if (!dep) {
      setSelected({ level: 'departement', code: String(props.code) });
      onFilters({ level: 'departement', code: String(props.code) });
    } else {
      setSelected({ level: (props.level as GeoLevel) ?? 'commune', code: String(props.code) });
    }
  };

  const depName = dep ? String(departements?.features.find((f) => f.properties.code === dep)?.properties.nom ?? dep) : null;

  return (
    <Shell
      active="map"
      title="Carte"
      navigate={navigate}
      crumbs={[{ label: 'France', href: '/map' }, ...(depName ? [{ label: depName }] : [])]}
      filters={
        <FilterBar filters={filters} onFilters={onFilters} show={['type', 'metric']}>
          <FilterField label="Représentation">
            <Segmented
              label="Représentation"
              options={[
                { value: 'choropleth', label: 'Aplats' },
                { value: 'points', label: 'Points' },
              ]}
              value={mode}
              onChange={(next) => onParams({ mode: next === 'points' ? 'points' : undefined })}
            />
          </FilterField>
          <FilterField label="Couleurs">
            <Segmented
              label="Palette"
              options={[
                { value: 'rdylgn', label: 'Vert → rouge' },
                { value: 'viridis', label: 'Daltonien' },
              ]}
              value={palette}
              onChange={(p) => onFilters({ palette: p })}
            />
          </FilterField>
          {dep && (
            <FilterField label="Territoire">
              <button type="button" className="cy-button ghost" onClick={() => {
                setSelected(null);
                setFraming(null);
                onFilters({ level: 'france', code: 'FR' });
              }}>
                ← France entière
              </button>
            </FilterField>
          )}
        </FilterBar>
      }>
      <div className="cy-grid" style={{ height: '100%', gridTemplateRows: '1fr' }}>
        <Panel
          span={9}
          flush
          title={`${legendMetric.label} · ${type === 'house' ? 'maisons' : 'appartements'}${showSections ? ' · sections cadastrales' : ''}`}
          info={legendMetric.base}
          style={{ minHeight: 520 }}
          tools={
            <>
              {OVERSEAS.map((o) => (
                <button key={o.label} type="button" className="cy-button ghost" style={{ height: 22, padding: '0 6px' }}
                  onClick={() => setFraming({ dep, bounds: o.bounds })}>
                  {o.label}
                </button>
              ))}
            </>
          }>
          <div style={{ position: 'relative', height: '100%', minHeight: 480 }}>
            <MapCanvas
              polygons={polygons}
              points={pointCollection}
              dark={dark}
              bounds={(framing?.dep === dep ? framing.bounds : dep ? null : METROPOLE) as never}
              onHover={(props, position) => setHover(props && position ? { props, ...position } : null)}
              onClick={onClick}
              onZoom={setZoom}
              style={{ position: 'absolute', inset: 0 }}
            />
            {hover && <Tooltip hover={hover} type={type} metricBase={mode === 'points' ? pointMetric.base : metric.base} />}
            {error && (
              <div className="cy-banner" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, display: 'flex', gap: 8, alignItems: 'center' }}>
                Données de carte indisponibles ({error}).
                <button type="button" className="cy-button ghost" onClick={() => { setError(null); setAttempt((a) => a + 1); }}>Réessayer</button>
              </div>
            )}
          </div>
        </Panel>
        <div style={{ gridColumn: 'span 3', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
          <Panel title="Légende" span={12}>
            {legend.length === 0 ? (
              <span className="cy-note">
                {!dep && legendMetric.communesOnly
                  ? 'Indicateur calculé par commune : cliquez un département pour le voir.'
                  : 'Pas assez de valeurs pour classer cet indicateur.'}
              </span>
            ) : (
              <div style={{ display: 'grid', gap: 4 }}>
                {legend.map((item) => (
                  <div key={item.label} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ width: 22, height: 10, background: item.color, border: '1px solid var(--line)' }} />
                    <span className="num">{item.label}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ width: 22, height: 10, background: GREY, border: '1px solid var(--line)' }} />
                  <span className="ink-3">Moins de 30 ventes ou pas de donnée</span>
                </div>
                <div className="cy-note" style={{ marginTop: 4 }}>
                  5 classes de même effectif (quintiles).{' '}
                  {catalogueEntry(legendMetric.base)?.higherIsBetter == null
                    ? 'Plus foncé = plus élevé.'
                    : palette === 'rdylgn'
                      ? 'Vert = favorable à l’investisseur, rouge = défavorable.'
                      : 'Clair = favorable, foncé = défavorable.'}
                  {mode === 'points' && !POINT_FIELDS[metric.base] && ' En mode points : prix, rentabilité ou cash-flow seulement.'}
                  {mode === 'points' && dep && zoom < SECTION_ZOOM && ' Zoomez pour voir les sections cadastrales.'}
                  {mode === 'points' && dep && zoom >= SECTION_ZOOM && sections?.period && ` Sections : ventes ${sections.period}, au moins 10 ventes.`}
                </div>
              </div>
            )}
          </Panel>
          <Panel title="Détail" span={12} flush style={{ flex: 1 }}>
            {selected ? (
              <PlaceDetail level={selected.level} code={selected.code} type={type} navigate={navigate} />
            ) : (
              <div className="cy-empty">
                {dep ? 'Cliquez une commune ou un point pour afficher sa fiche.' : 'Cliquez un département pour voir ses communes.'}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </Shell>
  );
}

const Tooltip = ({ hover, type, metricBase }: { hover: { props: Record<string, unknown>; x: number; y: number }; type: DwellingType; metricBase: string }) => {
  const p = hover.props;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const section = p._kind === 'section';
  const commune = p._kind === 'commune';
  const name = section ? `Section ${String(p.section).slice(8)} · ${p.commune}` : String(p.nom ?? p.name ?? p.code);
  const rows: [string, string][] = section
    ? [['Prix médian', formatEurosPerM2(num(p.median_price_m2))], ['Ventes (2 ans)', formatCount(num(p.n))]]
    : commune
      ? [
          ['Prix médian', formatEurosPerM2(num(p.median_price_m2))],
          ['Sur un an', formatSignedPercent(num(p.yoy_change))],
          ['Rentabilité brute', formatPercent(num(p.gross_yield))],
          ['Cash-flow bien type', num(p.cash_flow_monthly) == null ? '—' : `${Math.round(num(p.cash_flow_monthly)!)} €/mois`],
          ['Ventes', formatCount(num(p.n))],
        ]
      : [
          ['Prix médian', formatEurosPerM2(num(p[`price_${type}`]))],
          ['Évol. moy. / an (5 ans)', formatSignedPercent(num(p[`trend_${type}`]))],
          ['Rentabilité brute', formatPercent(num(p[`yield_${type}`]))],
          ['Cash-flow bien type', num(p[`cash_flow_${type}`]) == null ? '—' : `${Math.round(num(p[`cash_flow_${type}`])!)} €/mois`],
          ['Score', num(p[`score_${type}`]) == null ? '—' : `${Math.round(num(p[`score_${type}`])!)} / 100`],
          ['Ventes', formatCount(num(p[`sales_${type}`]))],
        ];
  const focus = METRICS.find((m) => m.base === metricBase);
  const value = focus && !section && !commune ? num(p[metricKey(focus.base, type)]) : null;
  return (
    <div
      role="tooltip"
      style={{
        position: 'absolute', left: Math.min(hover.x + 14, 9999), top: hover.y + 14, zIndex: 5, pointerEvents: 'none',
        background: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: 3, padding: '8px 10px',
        minWidth: 210, fontSize: 12,
      }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{name}</div>
      {value != null && focus && (
        <div style={{ marginBottom: 4 }}>
          <span className="ink-2">{focus.label} : </span>
          <b>{focus.format(value)}</b>
        </div>
      )}
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {rows.map(([label, v]) => (
            <tr key={label}>
              <td className="ink-2" style={{ padding: '1px 8px 1px 0' }}>{label}</td>
              <td style={{ textAlign: 'right', padding: '1px 0' }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
