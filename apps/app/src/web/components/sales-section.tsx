// Commune page, section "Ventes" (docs/features/019-sales-map/spec.md, User flow 1): the buildings of the commune on
// a map (one dot per parcel, size = sales, colour = median €/m² in 5 classes of the buildings shown), filters that refetch
// the commune's static sales file (data/sales/<code>.json, feature 022), and a docked right-hand panel for the
// clicked building (figures, chart and the list of its sales, each with its sheet). Filters and the selected building live in the URL, so the back button from a sale sheet reopens it.
import { useEffect, useRef, useState } from 'react';

import { formatCount, formatEuros, formatEurosPerM2, formatSignedPercent } from '../../data/format';
import { type Breaks, loadBreaks } from '../../data/map';
import {
  type Building,
  type BuildingDetail,
  getBuildingByQuery,
  getSalesByQuery,
  type SalesMap,
} from '../../data/sales-api';
import {
  breaksKey,
  localBreaks,
  buildingFeatures,
  formatDate,
  gap,
  gapTone,
  medianLabel,
  MIN_MEDIAN_SALES,
  MONTHS_LABELS,
  parcelParam,
  pointsBounds,
  SALE_TYPE_LABELS,
  SALES_MONTHS,
  SALES_ROOMS,
  salesCountLabel,
  type SalesFilters,
  salesFiltersFromParams,
  salesFiltersToParams,
  salesQuery,
  type SalesType,
  scatterSeries,
} from '../../data/sales-view';
import { legendItems, type Palette } from '../../data/scales';
import { axisStyle, Chart } from '../charts/chart';
import { legendLabel } from '../hooks/phone';
import { useDark } from '../hooks/use-dark';
import { MapCanvas } from '../maps/map-canvas';
import type { ScreenProps } from '../screen-props';
import { FilterField, Segmented } from './controls';
import { EmptyState, ErrorPanel, InfoTip, Panel } from './panel';
import { NavLink } from './shell';
import { TableWrap } from './table-wrap';

type Loaded<T> = { key: string; value?: T; error?: unknown };
type Bounds = [[number, number], [number, number]];

/** Theme tokens (tokens.css) the map and charts need, picked by theme so a theme switch redraws them. */
export const TOKENS = {
  light: { accent: '#2c4a6b', ink1: '#1d1c1a', ink2: '#5d5951', ink3: '#8e887d', lineStrong: '#cbc5b8', bg: '#f4f2ec' },
  dark: { accent: '#93b2d6', ink1: '#ece9e2', ink2: '#a8a297', ink3: '#77726a', lineStrong: '#3d3a33', bg: '#131210' },
} as const;


/** Min – max number inputs, committed on blur or Enter (one request per change, not per keystroke). */
const Range = ({
  label,
  unit,
  min,
  max,
  onChange,
}: {
  label: string;
  unit: string;
  min: number | null;
  max: number | null;
  onChange: (min: number | null, max: number | null) => void;
}) => {
  const [text, setText] = useState({ min: min == null ? '' : String(min), max: max == null ? '' : String(max) });
  const read = (value: string) => {
    const n = Number(value.replace(/\s/g, '').replace(',', '.'));
    return value.trim() && Number.isFinite(n) && n > 0 ? n : null;
  };
  const commit = () => {
    const next = { min: read(text.min), max: read(text.max) };
    if (next.min !== min || next.max !== max) {
      onChange(next.min, next.max);
    }
  };
  const input = (key: 'min' | 'max') => (
    <input
      className="cy-input"
      inputMode="numeric"
      aria-label={`${label} ${key === 'min' ? 'minimum' : 'maximum'} (${unit})`}
      placeholder={key}
      value={text[key]}
      onChange={(e) => setText({ ...text, [key]: e.target.value })}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
  return (
    <span className="cy-range">
      {input('min')}
      <span className="ink-3">–</span>
      {input('max')}
      <span className="ink-3">{unit}</span>
    </span>
  );
};

const SalesFilterBar = ({ filters, pageType, onChange }: { filters: SalesFilters; pageType: SalesType; onChange: (next: Partial<SalesFilters>) => void }) => {
  const changed = salesQuery(filters) !== salesQuery({ ...filters, type: pageType, months: 24, rooms: null, surfaceMin: null, surfaceMax: null, priceMin: null, priceMax: null });
  return (
    <div className="cy-filters" style={{ borderTop: '1px solid var(--line)' }}>
      <FilterField label="Type">
        <Segmented
          label="Type de bien vendu"
          options={[
            { value: 'apartment', label: 'Appartements' },
            { value: 'house', label: 'Maisons' },
            { value: 'all', label: 'Tous' },
          ]}
          value={filters.type}
          onChange={(type) => onChange({ type })}
        />
      </FilterField>
      <FilterField label="Période">
        <Segmented
          label="Période des ventes"
          options={SALES_MONTHS.map((m) => ({ value: String(m), label: MONTHS_LABELS[m] }))}
          value={String(filters.months)}
          onChange={(m) => onChange({ months: Number(m) as SalesFilters['months'] })}
        />
      </FilterField>
      <FilterField label="Pièces">
        <Segmented
          label="Nombre de pièces"
          options={[{ value: '', label: 'Toutes' }, ...SALES_ROOMS.map((r) => ({ value: String(r), label: r === 5 ? '5+' : String(r) }))]}
          value={filters.rooms == null ? '' : String(filters.rooms)}
          onChange={(r) => onChange({ rooms: r ? (Number(r) as SalesFilters['rooms']) : null })}
        />
      </FilterField>
      <FilterField label="Surface">
        <Range
          key={`s${filters.surfaceMin}-${filters.surfaceMax}`}
          label="Surface"
          unit="m²"
          min={filters.surfaceMin}
          max={filters.surfaceMax}
          onChange={(surfaceMin, surfaceMax) => onChange({ surfaceMin, surfaceMax })}
        />
      </FilterField>
      <FilterField label="Prix">
        <Range
          key={`p${filters.priceMin}-${filters.priceMax}`}
          label="Prix"
          unit="€"
          min={filters.priceMin}
          max={filters.priceMax}
          onChange={(priceMin, priceMax) => onChange({ priceMin, priceMax })}
        />
      </FilterField>
      {changed && (
        <div className="cy-filter" style={{ justifyContent: 'center' }}>
          <button
            type="button"
            className="cy-button ghost"
            onClick={() => onChange({ type: pageType, months: 24, rooms: null, surfaceMin: null, surfaceMax: null, priceMin: null, priceMax: null })}>
            Réinitialiser
          </button>
        </div>
      )}
    </div>
  );
};

/** Docked panel of one building: its figures over the filters, a chart of every sale, then the list. */
const BuildingPanel = ({
  summary,
  detail,
  filters,
  dark,
  onClose,
  onRetry,
  navigate,
}: {
  summary: Building | undefined;
  detail: Loaded<BuildingDetail> | null;
  filters: SalesFilters;
  dark: boolean;
  onClose: () => void;
  onRetry: () => void;
  navigate: ScreenProps['navigate'];
}) => {
  const tokens = TOKENS[dark ? 'dark' : 'light'];
  const data = detail?.value;
  const addresses = data?.addresses ?? summary?.addresses ?? [];
  // phone (023): the panel opens under the map, out of sight: bring it up when a building is tapped
  const panel = useRef<HTMLElement>(null);
  const buildingId = summary?.id;
  useEffect(() => {
    if (buildingId && window.matchMedia('(max-width: 700px)').matches) {
      panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [buildingId]);
  const stats = data?.stats;
  const shown = stats && stats.n >= MIN_MEDIAN_SALES;
  const vsCommune = shown ? gap(stats.median_m2, data?.commune.median_m2) : null;
  const vsStreet = shown && data?.street && data.street.n >= MIN_MEDIAN_SALES ? gap(stats.median_m2, data.street.median_m2) : null;
  const scatter = data ? scatterSeries(data.sales) : null;
  // the type column only when the building sold both flats and houses
  const mixed = data ? new Set(data.sales.map((s) => s.type)).size > 1 : false;
  const openSale = (id: string) => navigate(`/vente/${encodeURIComponent(id)}`);
  return (
    <aside ref={panel} className="cy-sales-panel" aria-label="Immeuble sélectionné">
      <div className="cy-sales-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="cy-filter-label">Immeuble · parcelle {data?.id ?? summary?.id ?? ''}</div>
          {addresses.map((a) => (
            <div key={a} style={{ fontWeight: 600 }}>
              {a}
            </div>
          ))}
        </div>
        <button type="button" className="cy-button ghost" aria-label="Fermer le panneau" onClick={onClose} style={{ padding: '0 9px' }}>
          ×
        </button>
      </div>
      {detail?.error != null ? (
        <ErrorPanel message={(detail.error as Error).message ?? 'Erreur'} onRetry={onRetry} />
      ) : !data ? (
        <EmptyState>Chargement des ventes de l’immeuble…</EmptyState>
      ) : (
        <>
          <table className="cy-table">
            <tbody>
              <tr>
                <td className="ink-2">Ventes ({MONTHS_LABELS[filters.months]}, filtres)</td>
                <td className="num">
                  {formatCount(stats?.n)} <span className="ink-3">sur {formatCount(data.sales.length)} au total</span>
                </td>
              </tr>
              <tr>
                <td className="ink-2">
                  Médiane <InfoTip k="building_median_m2" />
                </td>
                <td className="num">{medianLabel(stats?.median_m2, stats?.n ?? 0)}</td>
              </tr>
              <tr>
                <td className="ink-2">Fourchette P25 – P75</td>
                <td className="num">{shown && stats.p25_m2 != null ? `${formatCount(stats.p25_m2)} – ${formatEurosPerM2(stats.p75_m2)}` : '—'}</td>
              </tr>
              <tr>
                <td className="ink-2">vs {data.commune.name}</td>
                <td className="num">
                  <span className={gapTone(vsCommune)}>{formatSignedPercent(vsCommune)}</span>{' '}
                  <span className="ink-3">({formatEurosPerM2(data.commune.median_m2)})</span>
                </td>
              </tr>
              <tr>
                <td className="ink-2">vs {data.street ? data.street.name : 'la rue'}</td>
                <td className="num">
                  <span className={gapTone(vsStreet)}>{formatSignedPercent(vsStreet)}</span>{' '}
                  <span className="ink-3">
                    {data.street ? `(${data.street.n >= MIN_MEDIAN_SALES ? formatEurosPerM2(data.street.median_m2) : 'moins de 3 ventes'}, ${salesCountLabel(data.street.n)})` : ''}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
          {scatter && scatter.matching.length + scatter.others.length > 0 && (
            <div style={{ padding: '6px 6px 0', borderBottom: '1px solid var(--line)' }}>
              <Chart
                ariaLabel="Prix au m² de chaque vente de l’immeuble, par date"
                height={170}
                onClick={(p) => Array.isArray(p.data) && openSale(String(p.data[2]))}
                option={{
                  grid: { left: 48, right: 12, top: 22, bottom: 24 },
                  legend: { top: 0, left: 6, icon: 'circle', itemWidth: 8, itemHeight: 8, data: ['Selon les filtres', 'Autres ventes'] },
                  tooltip: {
                    trigger: 'item',
                    formatter: (p: { data: [number, number, string] }) =>
                      `${formatDate(new Date(p.data[0]).toISOString())}<br/>${formatEurosPerM2(p.data[1])}`,
                  },
                  xAxis: { type: 'time', ...axisStyle(), axisLabel: { color: tokens.ink3, fontSize: 10 }, splitLine: { show: false } },
                  yAxis: { type: 'value', scale: true, ...axisStyle() },
                  series: [
                    {
                      name: 'Selon les filtres',
                      type: 'scatter',
                      symbolSize: 8,
                      color: tokens.accent,
                      data: scatter.matching,
                      markLine:
                        data.commune.median_m2 != null
                          ? {
                              silent: true,
                              symbol: 'none',
                              lineStyle: { type: 'dashed', color: tokens.ink3 },
                              label: { formatter: data.commune.name, color: tokens.ink3, fontSize: 10, position: 'insideEndTop' },
                              data: [{ yAxis: data.commune.median_m2 }],
                            }
                          : undefined,
                    },
                    { name: 'Autres ventes', type: 'scatter', symbolSize: 6, color: tokens.lineStrong, data: scatter.others },
                  ],
                }}
              />
            </div>
          )}
          <TableWrap>
            <table className="cy-table cy-sales-list">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="cy-col-minor">Lots</th>
                  {mixed && <th>Type</th>}
                  <th className="num cy-col-minor">Carrez</th>
                  <th className="num">P.</th>
                  <th className="num">Prix</th>
                  <th className="num">€/m²</th>
                  <th className="num">
                    Écart <InfoTip k="gap_commune" />
                  </th>
                  <th aria-label="Fiche" />
                </tr>
              </thead>
              <tbody>
                {data.sales.map((s) => (
                  <tr key={s.id} className={s.matches_filters ? undefined : 'cy-dim'} title={s.matches_filters ? s.address : `${s.address} · hors filtres`}
                    data-href={`/vente/${encodeURIComponent(s.id)}`} onClick={(event) => {
                      // the whole row opens the sale (on a phone the link column is narrow); the link itself handles its own click
                      if (!(event.target as HTMLElement).closest('a')) {
                        openSale(s.id);
                      }
                    }}>
                    <td>{formatDate(s.date)}</td>
                    <td className="cy-col-minor">
                      {s.n_lots || '—'}
                      {s.new ? <span className="ink-3"> · neuf</span> : null}
                    </td>
                    {mixed && <td>{SALE_TYPE_LABELS[s.type]}</td>}
                    <td className="num cy-col-minor">{s.carrez != null ? `${formatCount(Math.round(s.carrez))} m²` : '—'}</td>
                    <td className="num">{s.rooms ?? '—'}</td>
                    <td className="num">{formatEuros(s.price)}</td>
                    <td className="num">{s.price_m2 != null ? formatCount(Math.round(s.price_m2)) : '—'}</td>
                    <td className={`num ${gapTone(s.gap_commune) ?? ''}`}>{formatSignedPercent(s.gap_commune)}</td>
                    <td>
                      <NavLink href={`/vente/${encodeURIComponent(s.id)}`} navigate={navigate} className="cy-more">
                        <span className="cy-more-text">Voir la fiche </span>→
                      </NavLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <div className="cy-note" style={{ padding: '6px 14px' }}>
            {mixed ? '' : `${SALE_TYPE_LABELS[data.sales[0]?.type ?? 'apartment']}s uniquement. `}
            Toutes les ventes de l’immeuble depuis le début de la fenêtre DVF ; en gris, celles hors filtres. Écart : prix au m²
            comparé à la médiane de {data.commune.name} sur la période choisie.
          </div>
        </>
      )}
    </aside>
  );
};

type SalesSectionProps = {
  /** Commune or arrondissement code (75056 = all of Paris). */
  code: string;
  name: string;
  pageType: 'apartment' | 'house';
  palette: Palette;
  params: Record<string, string>;
  onParams: ScreenProps['onParams'];
  navigate: ScreenProps['navigate'];
};

export const SalesSection = ({ code, name, pageType, palette, params, onParams, navigate }: SalesSectionProps) => {
  const filters = salesFiltersFromParams(params, pageType);
  const query = salesQuery(filters);
  const selected = parcelParam(params);
  const dark = useDark();
  const [attempt, setAttempt] = useState(0);
  const [sales, setSales] = useState<Loaded<SalesMap> | null>(null);
  const [detail, setDetail] = useState<Loaded<BuildingDetail> | null>(null);
  const [breaks, setBreaks] = useState<Breaks | null>(null);
  // framing of the commune, set when its first answer arrives: changing a filter keeps the user's view
  const [frame, setFrame] = useState<{ code: string; bounds: Bounds } | null>(null);
  // opened from a sale sheet (back button): bring the section into view once
  const [openedOnBuilding] = useState(() => Boolean(selected));

  const salesKey = `${code}?${query}#${attempt}`;
  useEffect(() => {
    let current = true;
    getSalesByQuery(code, query).then(
      (value) => {
        if (!current) {
          return;
        }
        setSales({ key: salesKey, value });
        const bounds = pointsBounds(value.buildings);
        if (bounds) {
          setFrame((prev) => (prev?.code === code ? prev : { code, bounds }));
        }
      },
      (error: unknown) => current && setSales({ key: salesKey, error }),
    );
    return () => {
      current = false;
    };
  }, [code, query, salesKey]);

  const detailKey = selected ? `${selected}?${query}#${attempt}` : null;
  useEffect(() => {
    if (!selected || !detailKey) {
      return;
    }
    let current = true;
    getBuildingByQuery(code, selected, query).then(
      (value) => current && setDetail({ key: detailKey, value }),
      (error: unknown) => current && setDetail({ key: detailKey, error }),
    );
    return () => {
      current = false;
    };
  }, [code, selected, query, detailKey]);

  useEffect(() => {
    let current = true;
    loadBreaks().then((b) => current && setBreaks(b), () => undefined); // grey dots without breaks
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (openedOnBuilding) {
      document.getElementById('ventes')?.scrollIntoView({ block: 'start' });
    }
  }, [openedOnBuilding]);

  const setFilters = (next: Partial<SalesFilters>) => onParams(salesFiltersToParams({ ...filters, ...next }, pageType));
  const retry = () => setAttempt((a) => a + 1);
  const settled = sales?.key === salesKey ? sales : null;
  // while a new answer loads the previous dots stay on the map
  const shownSales = sales?.value;
  const error = settled?.error;
  // classes relative to the buildings shown; the national commune breaks only when too few medians
  const ownBreaks = shownSales ? localBreaks(shownSales.buildings) : [];
  const typeBreaks = ownBreaks.length ? ownBreaks : breaks?.communes[breaksKey(filters.type)] ?? [];
  // the selected item takes the accent (docs/UI_UX.md: colour for meaning only)
  const ring = TOKENS[dark ? 'dark' : 'light'].accent;
  const points = shownSales ? buildingFeatures(shownSales.buildings, { breaks: typeBreaks, palette, selected, ring }) : null;
  const legend = legendItems(typeBreaks, (v) => formatEurosPerM2(Math.round(v / 10) * 10), palette, false);
  const summary = shownSales?.buildings.find((b) => b.id === selected);
  const shownDetail = detail?.key === detailKey ? detail : null;
  const typeLabel = filters.type === 'house' ? 'maisons' : filters.type === 'all' ? 'logements' : 'appartements';

  return (
    <Panel
      span={12}
      flush
      title={`Ventes une par une · ${typeLabel} · ${MONTHS_LABELS[filters.months]}`}
      info="building_median_m2"
      tools={
        shownSales ? (
          <span className="cy-note">
            {formatCount(shownSales.buildings.length)} immeubles · {formatCount(shownSales.reference.n)} ventes · médiane{' '}
            {formatEurosPerM2(shownSales.reference.median_m2)} · {formatDate(shownSales.period.from)} → {formatDate(shownSales.period.to)}
          </span>
        ) : undefined
      }>
      <SalesFilterBar filters={filters} pageType={pageType} onChange={setFilters} />
      {error != null ? (
        <ErrorPanel message={`Ventes indisponibles : ${(error as Error).message}`} onRetry={retry} />
      ) : (
        <div className={selected ? 'cy-sales open' : 'cy-sales'}>
          <div className="cy-sales-map">
            <MapCanvas
              polygons={null}
              points={points as never}
              dark={dark}
              bounds={frame?.code === code ? frame.bounds : null}
              onClick={(p) => p.id != null && onParams({ building: String(p.id) })}
              renderHover={(hit) => (
                <>
                  <div style={{ fontWeight: 600 }}>{String(hit.properties.label ?? '')}</div>
                  <div className="ink-2">{salesCountLabel(Number(hit.properties.n ?? 0))}</div>
                </>
              )}
              style={{ position: 'absolute', inset: 0 }}
            />
            {(!settled || (shownSales && shownSales.buildings.length === 0)) && (
              <div className="cy-map-status">
                {!settled ? `Chargement des ventes de ${name}…` : 'Aucune vente avec ces filtres.'}
              </div>
            )}
            {legend.length > 0 && (
              <div className="cy-note cy-map-legend">
                <span className="ink-2">€/m² médian des ventes de l’immeuble{ownBreaks.length ? ' (5 classes de la commune)' : ''}</span>
                {legend.map((item) => (
                  <span key={item.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: item.color, display: 'inline-block' }} />
                    {legendLabel(item.label)}
                  </span>
                ))}
              </div>
            )}
          </div>
          {selected && (
            <BuildingPanel
              summary={summary}
              detail={shownDetail}
              filters={filters}
              dark={dark}
              onClose={() => onParams({ building: undefined })}
              onRetry={retry}
              navigate={navigate}
            />
          )}
        </div>
      )}
      <div className="cy-note" style={{ padding: '6px 14px', borderTop: '1px solid var(--line)' }}>
        Un point par immeuble (parcelle cadastrale) : taille selon le nombre de ventes, couleur selon la médiane au m² (5 classes
        d’effectif égal entre les immeubles affichés, dès une vente ; la médiane du panneau, elle, attend 3 ventes). Survol : adresse ; clic : le détail de l’immeuble. Ventes DVF
        (fichier statique de la commune, sans numéros de lot).
      </div>
    </Panel>
  );
};
