'use dom';

// ② Département (docs/features/017-guided-levels/spec.md, 018-speed-and-map/spec.md): key figures and rank of the
// département, map of its communes zoomed on it, its yearly curve against its région and France, every commune as a
// bar, a heat map communes × years, price vs 1-year change, and the table of communes. Every figure comes ready from
// levels/departements/<dep>.json; the page only sorts and filters those rows. Every commune opens its own page (③).
import { useEffect, useRef, useState } from 'react';

import { type DepartementLevel, type LevelPlace, loadDepartementLevel } from '../../data/api';
import { catalogueEntry } from '../../data/catalogue';
import { hasPublishedSales, type HeatSort, heatRows, MIN_SALES, toBase100, valueAt } from '../../data/departement-view';
import { sortRows } from '../../data/explorer';
import {
  formatCount,
  formatEurosPerM2,
  formatPercent,
  formatRentPerM2,
  formatSignedPercent,
} from '../../data/format';
import { type Breaks, hasPlacePage, loadBreaks, loadMapLayer, type MapLayer, type MapProperties, METRICS, metricKey } from '../../data/map';
import { colorFor, GREY, legendItems, type Palette } from '../../data/scales';
import type { DwellingType } from '../../data/types';
import { BarRanking, changeFormat, useBarControls } from '../charts/bar-ranking';
import { axisStyle, Chart, css, SERIES_COLORS } from '../charts/chart';
import { YearHeatmap } from '../charts/year-heatmap';
import { FilterBar, Segmented, Select } from '../components/controls';
import { type Column, DataTable } from '../components/data-table';
import { EmptyState, ErrorPanel, Panel, ReliabilityBadge, Ribbon } from '../components/panel';
import { type Navigate, NavLink, Shell } from '../components/shell';
import { MarketSteps } from '../components/steps';
import { useDark } from '../hooks/use-dark';
import { boundsOf, type Feature, type FeatureCollection, MapCanvas } from '../maps/map-canvas';
import type { ScreenProps } from '../screen-props';

/** Métropole (01–95, 2A, 2B) and overseas (971–976). */
const DEP_CODE = /^(\d{2}|2A|2B|97\d)$/;
const PAGE = 200;

type TypeLevel = DepartementLevel['types'][DwellingType];
type Kpis = NonNullable<TypeLevel['kpis']>;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const tone = (v: number | null | undefined) => (v == null ? undefined : v >= 0 ? ('pos' as const) : ('neg' as const));
const ordinal = (n: number) => (n === 1 ? '1er' : `${n}e`);
/** Arrondissements of Paris, Lyon and Marseille have their own page level (fallback when a map feature has none). */
const levelOf = (code: string) => (/^(751|6938|132[01])/.test(code) ? 'arrondissement' : 'commune');
const placeHref = (code: string, type: DwellingType, level: string = levelOf(code)) => `/place/${level}/${code}?type=${type}`;
const typeLabelOf = (type: DwellingType) => (type === 'house' ? 'maisons' : 'appartements');
/** "ventes d’appartements", "ventes de maisons". */
const salesOf = (type: DwellingType) => (type === 'house' ? 'de maisons' : 'd’appartements');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

type PlaceKey = 'price' | 'yoy' | 'rent' | 'yield' | 'cash_flow' | 'n' | 'score';
type BarMetric = {
  key: PlaceKey;
  label: string;
  format: (v: number) => string;
  info: string;
  signed?: boolean;
  /** A département total is not comparable to a commune (sales): no reference line. */
  noReference?: boolean;
};

const BAR_METRICS: BarMetric[] = [
  { key: 'price', label: 'Prix au m²', format: (v) => formatEurosPerM2(v), info: 'median_price_m2' },
  { key: 'yoy', label: 'Évolution sur un an', format: changeFormat, info: 'yoy_change', signed: true },
  { key: 'rent', label: 'Loyer d’annonce', format: (v) => formatRentPerM2(v), info: 'rent_m2' },
  { key: 'yield', label: 'Rentabilité brute', format: (v) => formatPercent(v), info: 'gross_yield' },
  { key: 'cash_flow', label: 'Cash-flow bien type', format: (v) => `${Math.round(v)} €/mois`, info: 'cash_flow_monthly', signed: true },
  { key: 'n', label: 'Ventes', format: (v) => formatCount(v), info: 'n_sales', noReference: true },
  { key: 'score', label: 'Score de marché', format: (v) => `${Math.round(v)} / 100`, info: 'score' },
];

type Loaded = { code: string; data: DepartementLevel | null; error: string | null; missing: boolean };

export default function DepartementScreen({ filters, onFilters, navigate }: ScreenProps) {
  const code = filters.level === 'departement' ? filters.code : '';
  const validCode = DEP_CODE.test(code);
  const type: DwellingType = filters.type === 'house' ? 'house' : 'apartment';
  const typeLabel = typeLabelOf(type);

  // the page file, the département's commune polygons and the national map classes: nothing else
  const [level, setLevel] = useState<Loaded | null>(null);
  const [layer, setLayer] = useState<{ code: string; layer: MapLayer; bounds: unknown } | null>(null);
  const [breaks, setBreaks] = useState<Breaks | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    loadBreaks().then(setBreaks, () => setBreaks({ departements: {}, communes: {} }));
  }, [attempt]);
  useEffect(() => {
    if (!validCode) {
      return;
    }
    let current = true;
    loadDepartementLevel(code).then(
      (data) => current && setLevel({ code, data, error: null, missing: false }),
      (e: Error) => current && setLevel({ code, data: null, error: e.message, missing: /HTTP 404$/.test(e.message) }),
    );
    loadMapLayer(`communes/${code}.geojson`).then(
      (l) => current && setLayer({ code, layer: l, bounds: boundsOf(l as unknown as FeatureCollection) }),
      () => undefined, // the map panel says it is unavailable; the figures still show
    );
    return () => {
      current = false;
    };
  }, [code, validCode, attempt]);

  const loaded = level?.code === code ? level : null;
  const data = loaded?.data ?? null;
  const unknown = !validCode || loaded?.missing === true;
  const name = data?.name ?? null;
  const title = name ? `${name} (${code})` : unknown ? 'Département inconnu' : `Département ${code}`;
  const steps = <MarketSteps departement={unknown ? null : { code, name: String(name ?? code) }} type={type} navigate={navigate} />;

  if (unknown) {
    return (
      <Shell active="market" title={title} navigate={navigate} steps={steps}>
        <EmptyState>
          Ce département n’existe pas{validCode ? ` (code ${code})` : ''}.{' '}
          <NavLink href="/" navigate={navigate}>Revenir à la France et choisir un département →</NavLink>
        </EmptyState>
      </Shell>
    );
  }

  const noSales = data != null && !hasPublishedSales(data);
  const failed = loaded?.error ?? null;
  const typed: TypeLevel | null = data?.types?.[type] ?? null;
  const kpis = typed?.kpis ?? null;
  const communes = typed?.communes ?? null;
  const years = data?.years ?? [];
  const period = data?.period ?? null;
  const knownYears = kpis ? years.filter((_, i) => kpis.medians[i] != null) : [];
  const franceMedian = typed ? valueAt(years, typed.curves.france, period) : null;

  return (
    <Shell
      active="market"
      title={title}
      navigate={navigate}
      steps={steps}
      tools={!noSales ? (
        <NavLink className="cy-button ghost" href={`/compare?places=departement:${code}&type=${type}`} navigate={navigate}>
          + Comparer
        </NavLink>
      ) : undefined}
      filters={<FilterBar filters={filters} onFilters={onFilters} show={['type', 'metric']} />}>
      {noSales ? (
        <EmptyState>
          Pas de ventes publiées dans ce département : les ventes DVF ne couvrent ni l’Alsace-Moselle ni Mayotte.{' '}
          <NavLink href="/" navigate={navigate}>Revenir à la France →</NavLink>
        </EmptyState>
      ) : failed ? (
        <ErrorPanel message={`Données indisponibles : ${failed}`} onRetry={() => setAttempt((a) => a + 1)} />
      ) : (
        // keyed on the code: sorts, filters and limits of the panels start fresh in another département
        <div className="cy-grid" key={code}>
          <Panel span={12} flush>
            <Ribbon
              items={[
                { label: `Prix ${typeLabel}`, value: formatEurosPerM2(kpis?.price), info: 'median_price_m2',
                  detail: kpis?.p25 != null
                    ? `P25–P75 : ${formatEurosPerM2(kpis.p25)} – ${formatEurosPerM2(kpis.p75)}`
                    : period ?? undefined },
                { label: 'Rang', value: kpis ? `${ordinal(kpis.rank)} / ${kpis.ranked}` : '—', info: 'rank',
                  detail: 'parmi les départements, 1er = le plus cher' },
                { label: 'Sur un an', value: formatSignedPercent(kpis?.yoy), info: 'yoy_change',
                  tone: tone(kpis?.yoy), detail: period ? `${Number(period) - 1} → ${period}` : undefined },
                { label: 'Sur la période', value: formatSignedPercent(kpis?.growth), info: 'growth_5y', tone: tone(kpis?.growth),
                  detail: knownYears.length >= 2 ? `${knownYears[0]} → ${knownYears[knownYears.length - 1]}` : undefined },
                { label: 'Indice France = 100', value: kpis?.index != null ? String(kpis.index) : '—', info: 'france_index',
                  detail: franceMedian != null ? `France ${formatEurosPerM2(franceMedian)}` : undefined },
                { label: 'Ventes', value: formatCount(kpis?.n), info: 'n_sales', detail: period ? `année ${period}` : undefined },
                { label: 'Loyer d’annonce', value: formatRentPerM2(kpis?.rent), info: 'rent_m2' },
                { label: 'Rentabilité brute', value: formatPercent(kpis?.yield), info: 'gross_yield' },
              ]}
            />
          </Panel>
          <CommuneMap code={code} type={type} metricBase={filters.metric} palette={filters.palette}
            layer={layer?.code === code ? layer : null} communes={communes} breaks={breaks} navigate={navigate} />
          <YearCurve
            years={years}
            lines={typed ? [
              { label: String(name ?? code), values: typed.curves.departement },
              ...(data?.region.code ? [{ label: data.region.name ?? `Région ${data.region.code}`, values: typed.curves.region }] : []),
              { label: 'France', values: typed.curves.france },
            ] : null}
            typeLabel={typeLabel}
          />
          <CommuneBars rows={communes} reference={kpis} depName={String(name ?? code)} type={type} navigate={navigate} />
          <CommuneHeat rows={communes} years={data ? years : null} type={type} navigate={navigate} />
          <CommuneScatter rows={communes} reference={kpis} type={type} navigate={navigate} />
          <CommuneTable rows={communes} code={code} type={type} navigate={navigate} />
        </div>
      )}
    </Shell>
  );
}

// ---- map ---------------------------------------------------------------------------------------------

type Hover = { props: MapProperties; x: number; y: number; flip: boolean };
const NO_BREAKS: number[] = [];

/** Holds the hover state itself: moving over the map re-renders this panel only, never the charts. */
const CommuneMap = ({
  code,
  type,
  metricBase,
  palette,
  layer,
  communes,
  breaks,
  navigate,
}: {
  code: string;
  type: DwellingType;
  metricBase: string;
  palette: Palette;
  layer: { layer: MapLayer; bounds: unknown } | null;
  communes: LevelPlace[] | null;
  breaks: Breaks | null;
  navigate: Navigate;
}) => {
  const metric = METRICS.find((m) => m.base === metricBase) ?? METRICS[0];
  const key = metricKey(metric.base, type);
  const higher = catalogueEntry(metric.base)?.higherIsBetter ?? null;
  const layerBreaks = breaks?.communes[key] ?? NO_BREAKS;
  const polygons: FeatureCollection | null = layer
    ? {
        type: 'FeatureCollection',
        features: (layer.layer.features as unknown as Feature[]).map((f) => ({
          ...f,
          properties: { ...f.properties, _fill: colorFor(f.properties[key], layerBreaks, palette, higher) },
        })),
      }
    : null;
  const legend = legendItems(layerBreaks, metric.format, palette, higher);

  return (
    <Panel span={7} flush title={`${metric.label} · ${typeLabelOf(type)}`} info={metric.base}>
      <div className="cy-map-box" style={{ position: 'relative', height: 460 }}>
        <HoverMap polygons={polygons} bounds={layer?.bounds ?? null} communes={communes} type={type} navigate={navigate}
          metric={metric.base === 'price' ? null : { label: metric.label, key, format: metric.format }} />
        {!layer && <div className="cy-empty" style={{ position: 'absolute', inset: 0 }}>Chargement de la carte…</div>}
        <div style={{
          position: 'absolute', left: 8, bottom: 8, zIndex: 4, background: 'var(--surface)', border: '1px solid var(--line)',
          padding: '6px 8px', fontSize: 11, display: 'grid', gap: 3,
        }}>
          {legend.length === 0 ? (
            <span className="ink-3">Pas assez de communes pour classer cet indicateur.</span>
          ) : (
            [...legend, { label: 'Pas de donnée', color: GREY }].map((item) => (
              <div key={item.label} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ width: 18, height: 9, background: item.color, border: '1px solid var(--line)' }} />
                <span className="num">{item.label}</span>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="cy-note" style={{ padding: '6px 14px' }}>
        Communes et arrondissements du département {code}, 5 classes de même effectif sur toute la France. Survolez pour les
        chiffres, cliquez pour la page de la commune.
      </div>
    </Panel>
  );
};

/** The map and its hover card. It owns the hover state: moving the mouse re-renders this component only (the
 * coloured polygons arrive ready as a prop, the charts never re-render). */
const HoverMap = ({ polygons, bounds, communes, type, metric, navigate }: {
  polygons: FeatureCollection | null;
  bounds: unknown;
  communes: LevelPlace[] | null;
  type: DwellingType;
  /** The mapped metric when it is not the price. */
  metric: { label: string; key: string; format: (v: number) => string } | null;
  navigate: Navigate;
}) => {
  const dark = useDark();
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const row = hover ? (communes?.find((r) => r.code === String(hover.props.code)) ?? null) : null;
  return (
    <div ref={box} style={{ position: 'absolute', inset: 0 }}>
      <MapCanvas
        polygons={polygons}
        points={null}
        dark={dark}
        bounds={bounds as never}
        onHover={(props, position) => {
          if (!props || !position) {
            setHover(null);
            return;
          }
          const width = box.current?.clientWidth ?? 0;
          setHover({ props: props as MapProperties, ...position, flip: position.x > width - 240 });
        }}
        onClick={(props) => {
          setHover(null);
          const p = props as MapProperties;
          if (hasPlacePage(p)) {
            navigate(placeHref(String(p.code), type, String(p.level ?? levelOf(String(p.code)))));
          }
        }}
        style={{ position: 'absolute', inset: 0 }}
      />
      {hover && (
        <HoverCard hover={hover} row={row} type={type}
          metric={metric ? { label: metric.label, value: num(hover.props[metric.key]), format: metric.format } : null} />
      )}
    </div>
  );
};

const HoverCard = ({ hover, row, type, metric }: {
  hover: Hover;
  /** The commune's figures for this type; null under the publication minimum. */
  row: LevelPlace | null;
  type: DwellingType;
  /** The mapped metric when it is not the price. */
  metric: { label: string; value: number | null; format: (v: number) => string } | null;
}) => {
  const name = row?.name ?? String(hover.props.nom ?? hover.props.code);
  const page = hasPlacePage(hover.props);
  return (
    <div role="tooltip" style={{
      position: 'absolute', top: hover.y + 14, zIndex: 5, pointerEvents: 'none', background: 'var(--surface)',
      border: '1px solid var(--line-strong)', borderRadius: 3, padding: '7px 10px', fontSize: 12, width: 220,
      boxShadow: '0 2px 8px rgba(0,0,0,0.12)', display: 'grid', gap: 2,
      ...(hover.flip ? { left: hover.x - 234 } : { left: hover.x + 14 }),
    }}>
      <div style={{ fontWeight: 600 }}>{name}</div>
      {row ? (
        <>
          <div><span className="ink-2">Prix au m² : </span><b className="num">{formatEurosPerM2(row.price)}</b></div>
          <div>
            <span className="ink-2">Sur un an : </span>
            <b className={`num ${tone(row.yoy) ?? ''}`}>{formatSignedPercent(row.yoy)}</b>
          </div>
          <div className="ink-2">{formatCount(row.n)} ventes {salesOf(type)}</div>
        </>
      ) : (
        <div className="ink-2">Moins de {MIN_SALES} ventes {salesOf(type)} sur l’année</div>
      )}
      {metric && (
        <div><span className="ink-2">{metric.label} : </span><b className="num">{metric.value == null ? '—' : metric.format(metric.value)}</b></div>
      )}
      <div className="ink-3" style={{ marginTop: 3 }}>{page ? `Clic : explorer ${name} en détail` : 'Pas assez de ventes pour une page'}</div>
    </div>
  );
};

// ---- yearly curve ------------------------------------------------------------------------------------

const YearCurve = ({ years, lines, typeLabel }: { years: string[]; lines: { label: string; values: (number | null)[] }[] | null; typeLabel: string }) => {
  const [mode, setMode] = useState<'price' | 'base'>('price');
  const shown = (lines ?? []).map((l) => ({ ...l, values: mode === 'base' ? toBase100(l.values) : l.values }));
  return (
    <Panel span={5} title={`Prix au m² par année · ${typeLabel}`} info="median_price_m2"
      tools={<Segmented label="Unité" options={[{ value: 'price', label: '€/m²' }, { value: 'base', label: 'Base 100' }]} value={mode} onChange={setMode} />}>
      {!lines ? (
        <EmptyState>Chargement…</EmptyState>
      ) : years.length < 2 ? (
        <EmptyState>Moins de deux années complètes publiées.</EmptyState>
      ) : (
        <Chart
          ariaLabel={`Prix médian au m² par année : ${shown.map((l) => l.label).join(', ')}`}
          height={400}
          option={{
            grid: { left: 56, right: 16, top: 34, bottom: 28 },
            legend: { top: 0, left: 8, data: shown.map((l) => l.label) },
            tooltip: { trigger: 'axis', valueFormatter: (v: unknown) =>
              typeof v !== 'number' ? '—' : mode === 'base' ? String(Math.round(v * 10) / 10).replace('.', ',') : formatEurosPerM2(v) },
            xAxis: { type: 'category', data: years, boundaryGap: false, ...axisStyle() },
            yAxis: { type: 'value', scale: true, ...axisStyle() },
            series: shown.map((l, i) => ({
              name: l.label, type: 'line', symbolSize: 5, color: SERIES_COLORS[i], data: l.values,
              lineStyle: { width: i === 0 ? 2.5 : 1.5 },
            })),
          }}
        />
      )}
      <div className="cy-note">
        Années complètes seulement (les deux semestres), logements anciens, toutes tailles.
        {mode === 'base' ? ` Base 100 = ${years[0] ?? 'première année'} pour chaque courbe : compare les hausses, pas les niveaux.` : ''}
      </div>
    </Panel>
  );
};

// ---- communes bar chart ------------------------------------------------------------------------------

const CommuneBars = ({ rows, reference, depName, type, navigate }: {
  rows: LevelPlace[] | null;
  reference: Kpis | null;
  depName: string;
  type: DwellingType;
  navigate: Navigate;
}) => {
  const [metricKeyName, setMetricKeyName] = useState<string>(BAR_METRICS[0].key);
  const metric = BAR_METRICS.find((m) => m.key === metricKeyName) ?? BAR_METRICS[0];
  const { sort, top, controls } = useBarControls('desc', 20, [10, 20, 50]);
  const items = (rows ?? []).map((r) => ({
    code: r.code,
    label: r.name ?? r.code,
    value: r[metric.key],
    detail: `${formatCount(r.n)} ventes`,
  }));
  const refValue = reference && !metric.noReference ? reference[metric.key] : null;
  return (
    <Panel span={12} flush title={`Toutes les communes · ${metric.label}`} info={metric.info}
      tools={
        <>
          <Select label="Indicateur des barres" value={metric.key} onChange={setMetricKeyName}
            options={BAR_METRICS.map((m) => ({ value: m.key, label: m.label }))} />
          {controls}
        </>
      }>
      {!rows ? (
        <EmptyState>Chargement…</EmptyState>
      ) : items.every((i) => i.value == null) ? (
        <EmptyState>Pas de valeur publiée pour cet indicateur dans ce département.</EmptyState>
      ) : (
        <BarRanking
          items={items}
          metricLabel={metric.label}
          format={metric.format}
          signed={metric.signed}
          sort={sort}
          top={top}
          height={340}
          reference={refValue != null ? { label: depName, value: refValue } : undefined}
          onPick={(c) => navigate(placeHref(c, type, rows.find((r) => r.code === c)?.level))}
        />
      )}
      <div className="cy-note" style={{ padding: '6px 14px' }}>
        Communes d’au moins {MIN_SALES} ventes {salesOf(type)} sur la dernière année complète, toutes tailles. Paris, Lyon et
        Marseille par arrondissement. Ligne pointillée : le département. Cliquez une barre pour ouvrir la commune.
      </div>
    </Panel>
  );
};

// ---- heat map ----------------------------------------------------------------------------------------

const CommuneHeat = ({ rows, years, type, navigate }: {
  rows: LevelPlace[] | null;
  /** Complete years of the publication; null while the page file loads. */
  years: string[] | null;
  type: DwellingType;
  navigate: Navigate;
}) => {
  const [sort, setSort] = useState<HeatSort>('sales');
  const [limit, setLimit] = useState('30');
  const lines = rows ? heatRows(rows, sort) : [];
  const shown = limit === 'all' ? lines : lines.slice(0, Number(limit));
  return (
    <Panel span={7} flush hideOnPhone title="Variation annuelle du prix par commune" info="yearly_change"
      tools={
        <div className="cy-chart-tools">
          <Segmented label="Tri des communes" value={sort} onChange={setSort}
            options={[{ value: 'sales', label: 'Plus de ventes' }, { value: 'growth', label: 'Plus forte hausse' }]} />
          <Select label="Nombre de communes" value={limit} onChange={setLimit}
            options={[{ value: '30', label: '30' }, { value: '60', label: '60' }, { value: 'all', label: 'Toutes' }]} />
        </div>
      }>
      {!rows || !years ? (
        <EmptyState>Chargement…</EmptyState>
      ) : years.length < 2 ? (
        <EmptyState>Moins de deux années complètes : pas de variation annuelle.</EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState>Aucune commune n’a au moins {MIN_SALES} ventes {salesOf(type)} chaque année.</EmptyState>
      ) : (
        <YearHeatmap
          years={years}
          rows={shown.map((r) => ({ code: r.code, label: r.name ?? r.code, changes: r.changes, medians: r.medians }))}
          onPick={(c) => navigate(placeHref(c, type, rows.find((r) => r.code === c)?.level))}
        />
      )}
      <div className="cy-note" style={{ padding: '6px 14px' }}>
        {years && years.length >= 2 ? `${lines.length} communes ont au moins ${MIN_SALES} ventes chaque année de ${years[0]} à ${years[years.length - 1]}. ` : ''}
        Chaque case : prix médian de l’année comparé à l’année précédente. Cliquez une ligne pour ouvrir la commune.
      </div>
    </Panel>
  );
};

// ---- scatter -----------------------------------------------------------------------------------------

const CommuneScatter = ({ rows, reference, type, navigate }: {
  rows: LevelPlace[] | null;
  reference: Kpis | null;
  type: DwellingType;
  navigate: Navigate;
}) => {
  const points = (rows ?? []).filter((r) => r.price != null && r.yoy != null);
  const maxSales = Math.max(1, ...points.map((r) => r.n));
  const marks = [
    ...(reference?.price != null ? [{ xAxis: reference.price }] : []),
    ...(reference?.yoy != null ? [{ yAxis: reference.yoy }] : []),
  ];
  return (
    <Panel span={5} title="Prix au m² et évolution sur un an" info="yoy_change">
      {!rows ? (
        <EmptyState>Chargement…</EmptyState>
      ) : points.length === 0 ? (
        <EmptyState>Pas d’évolution sur un an publiée pour ces communes.</EmptyState>
      ) : (
        <Chart
          ariaLabel="Nuage des communes : prix au m² et évolution sur un an"
          height={400}
          onClick={(p) => {
            const row = points[p.dataIndex ?? -1];
            if (row && p.seriesName === 'communes') {
              navigate(placeHref(row.code, type, row.level));
            }
          }}
          option={{
            grid: { left: 52, right: 16, top: 16, bottom: 40 },
            tooltip: {
              trigger: 'item',
              formatter: (p: { dataIndex: number; seriesName: string }) => {
                const r = points[p.dataIndex];
                return p.seriesName !== 'communes' || !r ? '' : `<b>${escapeHtml(r.name ?? r.code)}</b><br/>${formatEurosPerM2(r.price)} · ${
                  formatSignedPercent(r.yoy)} sur un an<br/>${formatCount(r.n)} ventes`;
              },
            },
            xAxis: { type: 'value', name: '€/m²', nameLocation: 'middle', nameGap: 24, scale: true, ...axisStyle() },
            yAxis: { type: 'value', scale: true, ...axisStyle(), axisLabel: { ...axisStyle().axisLabel, formatter: (v: number) => changeFormat(v) } },
            series: [
              {
                name: 'communes',
                type: 'scatter',
                cursor: 'pointer',
                data: points.map((r) => [r.price, r.yoy]),
                symbolSize: (_: unknown, p: { dataIndex: number }) => 5 + 16 * Math.sqrt(points[p.dataIndex].n / maxSales),
                itemStyle: { color: (p: { dataIndex: number }) => ((points[p.dataIndex].yoy ?? 0) >= 0 ? css('--accent') : css('--neg')), opacity: 0.7 },
                markLine: marks.length ? { symbol: 'none', silent: true, lineStyle: { color: css('--ink-3'), type: 'dashed' }, label: { show: false }, data: marks } : undefined,
              },
            ],
          }}
        />
      )}
      <div className="cy-note">Taille du point : nombre de ventes. Pointillés : le département. En haut à droite : cher et en hausse.</div>
    </Panel>
  );
};

// ---- table -------------------------------------------------------------------------------------------

const COLUMNS: Column<LevelPlace>[] = [
  { key: 'name', label: 'Commune', render: (r) => r.name ?? r.code },
  { key: 'price', label: '€/m²', numeric: true, info: 'median_price_m2', render: (r) => formatEurosPerM2(r.price) },
  { key: 'p25', label: 'P25 – P75', numeric: true, sortable: false, render: (r) =>
    r.p25 == null ? '—' : `${formatCount(r.p25)} – ${formatCount(r.p75)}` },
  { key: 'yoy', label: '1 an', numeric: true, info: 'yoy_change', render: (r) => (
    <span className={tone(r.yoy)}>{formatSignedPercent(r.yoy)}</span>
  ) },
  { key: 'rent', label: 'Loyer', numeric: true, info: 'rent_m2', render: (r) => formatRentPerM2(r.rent) },
  { key: 'yield', label: 'Rdt brut', numeric: true, info: 'gross_yield', render: (r) => formatPercent(r.yield) },
  { key: 'cash_flow', label: 'Cash-flow', numeric: true, info: 'cash_flow_monthly', render: (r) =>
    r.cash_flow == null ? '—' : <span className={tone(r.cash_flow)}>{Math.round(r.cash_flow)} €</span> },
  { key: 'n', label: 'Ventes', numeric: true, info: 'n_sales', render: (r) => (
    <>{formatCount(r.n)} <ReliabilityBadge n={r.n} /></>
  ) },
];

const CommuneTable = ({ rows, code, type, navigate }: { rows: LevelPlace[] | null; code: string; type: DwellingType; navigate: Navigate }) => {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'price', dir: 'desc' });
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const needle = query.trim().toLocaleLowerCase('fr');
  const visible = sortRows((rows ?? []).filter((r) => !needle || (r.name ?? r.code).toLocaleLowerCase('fr').includes(needle)),
    sort.key as keyof LevelPlace, sort.dir);
  return (
    <Panel span={12} flush title={`Communes · ${typeLabelOf(type)} · ${formatCount(rows?.length ?? 0)}`}
      tools={
        <>
          <input className="cy-input" type="search" placeholder="Filtrer par nom" aria-label="Filtrer les communes par nom" value={query}
            onChange={(e) => setQuery(e.target.value)} style={{ width: 160 }} />
          <NavLink href={`/investir?dep=${code}`} navigate={navigate}>Trouver où investir dans ce département →</NavLink>
        </>
      }>
      {!rows ? (
        <EmptyState>Chargement…</EmptyState>
      ) : (
        <>
          <DataTable
            columns={COLUMNS}
            rows={visible.slice(0, limit)}
            rowKey={(r) => `${r.level}:${r.code}`}
            sort={sort}
            onSort={(key) => setSort({ key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : 'desc' })}
            onRowClick={(r) => navigate(placeHref(r.code, type, r.level))}
            maxHeight={520}
            empty={<EmptyState>{rows.length === 0 ? `Aucune commune n’a ${MIN_SALES} ventes ${salesOf(type)} sur l’année.` : 'Aucun nom ne correspond.'}</EmptyState>}
          />
          {visible.length > limit && (
            <div style={{ padding: 8, borderTop: '1px solid var(--line)' }}>
              <button type="button" className="cy-button ghost" onClick={() => setLimit(limit + PAGE)}>
                Afficher {Math.min(PAGE, visible.length - limit)} de plus ({formatCount(visible.length - limit)} restantes)
              </button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
};
