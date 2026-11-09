'use dom';

// Carte (full screen of the general map, docs/features/018-speed-and-map/spec.md): départements, then the communes of
// the département under the centre from zoom 7 (or a right click), coloured by the chosen metric; or points placed at
// their coordinates (communes; cadastral sections when zoomed far into a département). Hover shows the key figures
// and where a click leads; a click opens the département or commune page. The side panel shows the département shown.
import { useEffect, useMemo, useState } from 'react';

import { type CommunePoint, loadCommunePoints, loadPointBreaks, loadSectionPoints, type SectionPoint } from '../../data/api';
import { catalogueEntry } from '../../data/catalogue';
import { type Breaks, loadBreaks, METRICS, metricKey } from '../../data/map';
import { colorFor, GREY, legendItems, type Palette } from '../../data/scales';
import type { DwellingType } from '../../data/types';
import { FilterBar, FilterField, Segmented } from '../components/controls';
import { Panel } from '../components/panel';
import { PlaceDetail } from '../components/place-detail';
import { Shell } from '../components/shell';
import { DETAIL_ZOOM, type FrameRequest, GeneralMap } from '../maps/general-map';
import type { Feature, FeatureCollection } from '../maps/map-canvas';
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

const METROPOLE_BOUNDS: [[number, number], [number, number]] = [[-5.3, 41.3], [9.7, 51.2]];
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
  // old links (/map?level=departement&code=33) open on that département
  const focus = filters.level === 'departement' ? filters.code : null;
  const metric = METRICS.find((m) => m.base === filters.metric) ?? METRICS[0];
  const pointMetric = POINT_FIELDS[metric.base] ? metric : METRICS[0];
  const key = metricKey(metric.base, type);

  const [breaks, setBreaks] = useState<Breaks | null>(null);
  const [points, setPoints] = useState<CommunePoint[] | null>(null);
  const [pointBreaks, setPointBreaks] = useState<Record<string, number[]> | null>(null);
  const [sections, setSections] = useState<{ dep: string; rows: SectionPoint[]; period: string | null } | null>(null);
  // département shown and zoom, reported by the map after each move (never on mouse moves)
  const [view, setView] = useState<{ dep: string | null; zoom: number }>({ dep: null, zoom: 5 });
  const [frame, setFrame] = useState<FrameRequest | null>(null);
  const dep = view.dep;

  useEffect(() => {
    loadBreaks().then(setBreaks, () => undefined); // the map reports its own load errors
  }, []);
  useEffect(() => {
    if (mode !== 'points') {
      return;
    }
    loadCommunePoints().then((t) => setPoints(t.rows), () => setPoints([]));
    loadPointBreaks().then(setPointBreaks, () => setPointBreaks({}));
  }, [mode]);
  const showSections = mode === 'points' && Boolean(dep) && view.zoom >= SECTION_ZOOM;
  useEffect(() => {
    if (!showSections || !dep) {
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
  }, [showSections, dep]);

  // commune points: rebuilt when the data, type, metric or palette change, not when the map moves
  const communeFeatures = useMemo((): Feature[] => {
    if (mode !== 'points' || !points) {
      return [];
    }
    const field = POINT_FIELDS[pointMetric.base];
    const pBreaks = breaks?.communes[metricKey(pointMetric.base, type)] ?? [];
    const pHigher = catalogueEntry(pointMetric.base)?.higherIsBetter ?? null;
    return points
      .filter((p) => p.type === type)
      .map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { ...p, _kind: 'commune', _fill: p.n >= RELIABLE ? colorFor(p[field], pBreaks, palette, pHigher) : GREY, _r: Math.min(2.2 + Math.sqrt(p.n) / 5, 15) },
      }));
  }, [mode, points, pointMetric.base, breaks, type, palette]);
  const sectionRows = showSections && sections?.dep === dep ? sections.rows : null;
  const pointCollection = useMemo((): FeatureCollection | null => {
    if (mode !== 'points') {
      return null;
    }
    const sBreaks = pointBreaks?.[`price_${type}`] ?? [];
    const sectionFeatures: Feature[] = (sectionRows ?? [])
      .filter((r) => r.type === type)
      .map((s) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        properties: { ...s, _kind: 'section', _fill: colorFor(s.median_price_m2, sBreaks, palette, false), _r: 4.5 },
      }));
    return { type: 'FeatureCollection', features: [...communeFeatures, ...sectionFeatures] };
  }, [mode, communeFeatures, sectionRows, pointBreaks, type, palette]);

  // section points are always coloured by price: legend and title follow them
  const legendBreaks = showSections
    ? pointBreaks?.[`price_${type}`] ?? []
    : mode === 'points'
      ? breaks?.communes[metricKey(pointMetric.base, type)] ?? []
      : breaks?.[dep ? 'communes' : 'departements'][key] ?? [];
  const legendMetric = showSections ? METRICS[0] : mode === 'points' ? pointMetric : metric;
  const legend = legendItems(legendBreaks, fmt(legendMetric.base), palette, catalogueEntry(legendMetric.base)?.higherIsBetter ?? null);

  return (
    <Shell
      active="map"
      title="Carte"
      navigate={navigate}
      crumbs={[{ label: 'France', href: '/map' }, ...(dep ? [{ label: `Département ${dep}` }] : [])]}
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
                setFrame({ bounds: METROPOLE_BOUNDS, at: Date.now() });
                if (focus) {
                  onFilters({ level: 'france', code: 'FR' });
                }
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
                  onClick={() => setFrame({ bounds: o.bounds, at: Date.now() })}>
                  {o.label}
                </button>
              ))}
            </>
          }>
          <div style={{ position: 'relative', height: '100%', minHeight: 480 }}>
            <GeneralMap
              type={type}
              palette={palette}
              navigate={navigate}
              metric={metric.base}
              mode={mode}
              points={pointCollection}
              frame={frame}
              focus={focus}
              onView={setView}
              legend={false}
              style={{ position: 'absolute', inset: 0 }}
            />
          </div>
        </Panel>
        <div style={{ gridColumn: 'span 3', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
          <Panel title="Légende" span={12}>
            {legend.length === 0 ? (
              <span className="cy-note">
                {!dep && legendMetric.communesOnly
                  ? `Indicateur calculé par commune : zoomez sur un département (niveau ${DETAIL_ZOOM}) pour le voir.`
                  : 'Pas assez de valeurs pour classer cet indicateur.'}
              </span>
            ) : (
              <div style={{ display: 'grid', gap: 4 }}>
                <div className="ink-2">{mode === 'points' ? 'Points des communes' : dep ? 'Communes' : 'Départements'}</div>
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
                  {mode === 'points' && dep && !showSections && ' Zoomez pour voir les sections cadastrales.'}
                  {showSections && sections?.period && ` Sections : ventes ${sections.period}, au moins 10 ventes.`}
                </div>
              </div>
            )}
          </Panel>
          <Panel title="Département affiché" span={12} flush style={{ flex: 1 }}>
            {dep ? (
              <PlaceDetail level="departement" code={dep} type={type} navigate={navigate} />
            ) : (
              <div className="cy-empty">
                Zoomez sur un département (ou clic droit) pour voir ses communes et sa fiche ici. Un clic sur la carte ouvre la
                page du département ou de la commune.
              </div>
            )}
          </Panel>
        </div>
      </div>
    </Shell>
  );
}
