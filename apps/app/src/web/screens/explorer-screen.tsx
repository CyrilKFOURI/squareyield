'use dom';

// Investir ① "Trouver une ville" (docs/features/017-guided-levels/spec.md): communes of the whole of France (national
// ranking, ≥ 30 sales) or of one département (≥ 10 sales), the 015 filters on top, an investor ribbon, the yield ×
// price-change quadrant, a top-20 bar chart and the sortable table. A row, a point or a bar opens the commune page.
// Market exploration (départements, maps, curves) lives in the Marché pages.
import { type CSSProperties, useEffect, useState } from 'react';

import { loadRanking, loadTable } from '../../data/api';
import { type ExplorerRow, sortRows, toCsv } from '../../data/explorer';
import { formatCount, formatEuros, formatEurosPerM2, formatPercent, formatRentPerM2, formatSignedPercent } from '../../data/format';
import {
  BAR_METRICS,
  type BarMetricKey,
  fromExplorer,
  fromRanking,
  type InvestRow,
  investorSummary,
  parseDep,
  placeHref,
  type QuadrantAxis,
  type QuadrantKey,
  QUADRANTS,
  quadrantView,
  robustRange,
} from '../../data/invest-view';
import { codeCompare } from '../../data/levels';
import { activeCount, applyScreenFilters, parseScreenFilters } from '../../data/screen-filters';
import { normalize } from '../../data/search';
import { LOW_CONFIDENCE_SALES } from '../../data/select';
import type { DwellingType, RankingRow } from '../../data/types';
import { BarRanking, useBarControls } from '../charts/bar-ranking';
import { axisStyle, Chart, css } from '../charts/chart';
import { FilterBar, FilterField, Segmented, Select } from '../components/controls';
import { type Column, DataTable } from '../components/data-table';
import { EmptyState, ErrorPanel, Panel, ReliabilityBadge, Ribbon } from '../components/panel';
import { ScreenFilterPanel } from '../components/screen-filter-panel';
import { NavLink, Shell } from '../components/shell';
import { InvestSteps } from '../components/steps';
import type { ScreenProps } from '../screen-props';

const PAGE = 200;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const tone = (v: number | null) => (v == null ? undefined : v >= 0 ? 'pos' : 'neg');
const formatScore = (v: number | null | undefined) => (v == null ? '—' : formatCount(Math.round(v)));
const formatCashFlow = (v: number | null | undefined) => (v == null ? '—' : formatEuros(Math.round(v)));
const BAR_FORMAT: Record<(typeof BAR_METRICS)[number]['kind'], (v: number) => string> = {
  score: formatScore,
  percent: formatPercent,
  euros: formatCashFlow,
};
const axisPercent = (v: number) => `${Math.round(v * 100)} %`;

/** Colour of each quadrant, from the theme tokens. */
const QUADRANT_TOKEN: Record<QuadrantKey, string> = { up: '--pos', value: '--accent', growth: '--warn', weak: '--ink-3' };
const QUADRANT_ORDER: QuadrantKey[] = ['value', 'up', 'weak', 'growth'];
const GRID = { left: 56, right: 16, top: 12, bottom: 44 };

const Risks = ({ row }: { row: InvestRow }) => (
  <>
    {row.flag_high_vacancy && <span className="cy-badge warn">vacance élevée</span>}{' '}
    {row.flag_population_decline && <span className="cy-badge warn">population en baisse</span>}
    {!row.flag_high_vacancy && !row.flag_population_decline && <span className="ink-3">—</span>}
  </>
);

const columnsFor = (national: boolean): Column<InvestRow>[] => [
  { key: 'name', label: 'Commune', render: (r) => (national && r.departement ? `${r.name} (${r.departement})` : r.name) },
  { key: 'score', label: 'Score', numeric: true, info: 'score', render: (r) => formatScore(r.score) },
  { key: 'gross_yield', label: 'Rdt brut', numeric: true, info: 'gross_yield', render: (r) => formatPercent(r.gross_yield) },
  { key: 'net_yield', label: 'Rdt net', numeric: true, info: 'net_yield', render: (r) => formatPercent(r.net_yield) },
  { key: 'cash_flow_monthly', label: 'Cash-flow / mois', numeric: true, info: 'cash_flow_monthly', render: (r) =>
    <span className={tone(r.cash_flow_monthly)}>{formatCashFlow(r.cash_flow_monthly)}</span> },
  { key: 'median_price_m2', label: '€/m²', numeric: true, info: 'median_price_m2', render: (r) => formatEurosPerM2(r.median_price_m2) },
  { key: 'median_price', label: 'Prix type', numeric: true, info: 'typical_price', render: (r) => formatEuros(r.median_price) },
  { key: 'rent_m2', label: 'Loyer', numeric: true, info: 'rent_m2', render: (r) => formatRentPerM2(r.rent_m2) },
  { key: 'vacancy_rate', label: 'Vacance', numeric: true, info: 'vacancy_rate', render: (r) => formatPercent(r.vacancy_rate) },
  { key: 'share_fg', label: 'F/G', numeric: true, info: 'share_fg', render: (r) => formatPercent(r.share_fg) },
  { key: 'rent_control', label: 'Encadr.', info: 'rent_control', render: (r) => (r.rent_control == null ? '—' : r.rent_control ? 'Oui' : 'Non') },
  { key: 'risks', label: 'Risques', sortable: false, render: (r) => <Risks row={r} /> },
  { key: 'yoy_change', label: '1 an', numeric: true, info: 'yoy_change', render: (r) =>
    <span className={tone(r.yoy_change)}>{formatSignedPercent(r.yoy_change)}</span> },
  { key: 'cagr', label: 'Moy. / an', numeric: true, info: 'cagr', render: (r) => formatSignedPercent(r.cagr) },
  { key: 'n_sales', label: 'Ventes', numeric: true, info: 'n_sales', render: (r) => <>{formatCount(r.n_sales)} <ReliabilityBadge n={r.n_sales} /></> },
  { key: 'population', label: 'Habitants', numeric: true, render: (r) => formatCount(r.population) },
];

const CSV_FIELDS: (keyof InvestRow & string)[] = [
  'code', 'name', 'level', 'departement', 'region', 'type', 'size', 'n_sales', 'reliability', 'score', 'gross_yield', 'net_yield',
  'cash_flow_monthly', 'cap_rate', 'median_price_m2', 'p25_price_m2', 'p75_price_m2', 'median_price', 'median_surface_m2', 'rent_m2',
  'yoy_change', 'cagr', 'vacancy_rate', 'share_fg', 'rent_control', 'flag_high_vacancy', 'flag_population_decline', 'population',
  'population_growth_yearly', 'tfpb_rate',
];
const SORTABLE = new Set<string>(CSV_FIELDS);

const download = (name: string, text: string) => {
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

type Source =
  | { key: string; kind: 'ranking'; period: string | null; rows: RankingRow[] }
  | { key: string; kind: 'departement'; period: string | null; rows: ExplorerRow[] };

type Area = { code: string; name: string; region: string | null };

export default function ExplorerScreen({ filters, params, onFilters, onParams, navigate }: ScreenProps) {
  // `dep` is the URL of 017; old /explorer links carried the département as level + code
  const dep = parseDep(params.dep) ?? (filters.level === 'departement' ? parseDep(filters.code) : null);
  const type: DwellingType = filters.type === 'house' ? 'house' : 'apartment';
  const size = filters.size;
  const sourceKey = dep ? `dep:${dep}` : `fr:${type}:${size}`;
  const sortKey = params.sort && SORTABLE.has(params.sort) ? params.sort : 'score';
  const sort = { key: sortKey, dir: params.dir === 'asc' ? ('asc' as const) : ('desc' as const) };

  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [regions, setRegions] = useState<{ code: string; name: string }[]>([]);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [axis, setAxis] = useState<QuadrantAxis>('yoy_change');
  const [barKey, setBarKey] = useState<BarMetricKey>('score');
  const bars = useBarControls('desc', 20, [10, 20, 50]);
  const [attempt, setAttempt] = useState(0);
  const screen = parseScreenFilters(params);

  useEffect(() => {
    let current = true;
    const fail = (e: Error) => current && setError({ key: sourceKey, message: e.message });
    if (dep) {
      loadTable<ExplorerRow>(`explorer/communes/${dep}.json`).then(
        (table) => current && setSource({ key: sourceKey, kind: 'departement', period: table.period, rows: table.rows }),
        fail,
      );
    } else {
      loadRanking(type, size).then(
        (ranking) => current && setSource({ key: sourceKey, kind: 'ranking', period: ranking.period, rows: ranking.rows }),
        fail,
      );
    }
    return () => {
      current = false;
    };
  }, [sourceKey, dep, type, size, attempt]);

  useEffect(() => {
    loadTable<ExplorerRow>('explorer/departements.json').then((table) => {
      const seen = new Map<string, Area>();
      table.rows.forEach((r) => seen.set(r.code, { code: r.code, name: r.name, region: r.parent }));
      setAreas([...seen.values()].sort((a, b) => codeCompare(a.code, b.code)));
    }, () => undefined);
    loadTable<ExplorerRow>('explorer/regions.json').then((table) => {
      const seen = new Map<string, string>();
      table.rows.forEach((r) => seen.set(r.code, r.name));
      setRegions([...seen].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name, 'fr')));
    }, () => undefined);
  }, []);

  const ready = source?.key === sourceKey ? source : null;
  const failed = error?.key === sourceKey ? error.message : null;
  const area = dep ? areas.find((a) => a.code === dep) ?? null : null;
  const national = !dep;
  const rows: InvestRow[] = !ready
    ? []
    : ready.kind === 'ranking'
      ? fromRanking(ready.rows)
      : fromExplorer(ready.rows, { type, size }, area?.region ?? null);
  const needle = normalize(query);
  const filtered = applyScreenFilters(rows, screen).filter((r) => !filters.reliable || r.n_sales >= LOW_CONFIDENCE_SALES);
  const visible = sortRows(needle ? filtered.filter((r) => normalize(r.name).includes(needle)) : filtered, sort.key as keyof InvestRow, sort.dir);

  const summary = investorSummary(filtered);
  const quadrant = quadrantView(filtered, axis);
  const barMetric = BAR_METRICS.find((m) => m.key === barKey) ?? BAR_METRICS[0];
  const barFormat = BAR_FORMAT[barMetric.kind];
  const scopeLabel = area ? `${area.name} (${area.code})` : dep ? `Département ${dep}` : 'Toute la France';
  const typeLabel = type === 'house' ? 'maisons' : 'appartements';
  const segmentLabel = `${typeLabel}${size === 'all' ? '' : ` · ${type === 'house' ? `${size} p.` : `T${size}`}`}`;
  const open = (row: InvestRow) => navigate(placeHref(row, type));

  const onSort = (key: string) => onParams({ sort: key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : 'desc' });

  const setDep = (next: string) => {
    setLimit(PAGE);
    onParams({ dep: next || undefined });
    if (filters.level !== 'france') {
      onFilters({ level: 'france', code: 'FR' });
    }
  };

  const guide = (
    <>
      Filtrez, puis ouvrez une ville ou passez à{' '}
      <NavLink href="/property" navigate={navigate}>② Analyser un bien</NavLink>
    </>
  );

  return (
    <Shell
      active="invest"
      title="Trouver où investir"
      navigate={navigate}
      steps={<InvestSteps current={1} navigate={navigate} hint={guide} />}
      crumbs={[{ label: 'Investir', href: '/investir' }, { label: scopeLabel }]}
      tools={
        <button type="button" className="cy-button ghost" disabled={visible.length === 0}
          onClick={() => download(`cyfouri_investir_${dep ?? 'france'}_${type}_${size}_${ready?.period ?? ''}.csv`, toCsv(visible, CSV_FIELDS))}>
          Exporter CSV
        </button>
      }
      filters={
        <FilterBar filters={filters} onFilters={onFilters} show={['type', 'size', 'reliable']}>
          <FilterField label="Où investir">
            <Select
              label="Toute la France ou un département"
              options={[{ value: '', label: 'Toute la France' }, ...areas.map((a) => ({ value: a.code, label: `${a.code} · ${a.name}` }))]}
              value={dep ?? ''}
              onChange={setDep}
            />
          </FilterField>
          {/* the 015 screen filters join the sidebar column (020) */}
          <ScreenFilterPanel params={params} onParams={onParams} active={activeCount(screen)} regions={national ? regions : null} />
        </FilterBar>
      }>
      {failed ? (
        <ErrorPanel message={`Communes indisponibles : ${failed}`} onRetry={() => setAttempt((a) => a + 1)} />
      ) : !ready ? (
        <EmptyState>Chargement…</EmptyState>
      ) : (
        <div className="cy-grid">
          <Panel span={12} flush>
            <Ribbon
              items={[
                { label: 'Villes', value: formatCount(summary.count), detail: `${scopeLabel} · ${segmentLabel}` },
                { label: 'Rendement brut médian', value: formatPercent(summary.grossYield), info: 'gross_yield' },
                { label: 'Rendement net médian', value: formatPercent(summary.netYield), info: 'net_yield' },
                {
                  label: 'Cash-flow positif',
                  value: formatPercent(summary.positiveCashFlow),
                  detail: 'part des villes, bien type',
                  info: 'cash_flow_monthly',
                },
                { label: 'Prix type médian', value: formatEuros(summary.price), detail: `année ${ready.period ?? '—'}`, info: 'typical_price' },
                { label: 'Score médian', value: formatScore(summary.score), info: 'score' },
              ]}
            />
            <div className="cy-note" style={{ padding: '8px 14px', borderTop: '1px solid var(--line)' }}>
              {guide}.{' '}
              {national
                ? `France entière : communes d’au moins ${LOW_CONFIDENCE_SALES} ventes. Choisissez un département pour voir aussi les plus petites (dès 10 ventes).`
                : 'Communes d’au moins 10 ventes ; sous 30 ventes, la ligne porte un badge de fiabilité faible.'}{' '}
              {dep && <NavLink href={`/departement/${dep}?type=${type}`} navigate={navigate}>Marché du département →</NavLink>}
            </div>
          </Panel>

          <Panel
            span={12}
            title="Rendement × évolution des prix"
            info="gross_yield"
            tools={
              <Segmented
                label="Évolution des prix"
                options={[
                  { value: 'yoy_change', label: 'Sur 1 an' },
                  { value: 'cagr', label: 'Moyenne / an' },
                ]}
                value={axis}
                onChange={setAxis}
              />
            }>
            {quadrant.points.length === 0 ? (
              <EmptyState>Pas de rendement ni d’évolution publiés pour ces villes.</EmptyState>
            ) : (
              <QuadrantChart view={quadrant} axis={axis} onPick={open} />
            )}
          </Panel>

          <Panel
            span={12}
            title={`Classement · ${barMetric.label}`}
            info={barMetric.key}
            tools={
              <div className="cy-chart-tools">
                <Select
                  label="Mesure"
                  value={barKey}
                  onChange={setBarKey}
                  options={BAR_METRICS.map((m) => ({ value: m.key, label: m.label }))}
                />
                {bars.controls}
              </div>
            }>
            {filtered.length === 0 ? (
              <EmptyState>Aucune ville ne passe ces filtres.</EmptyState>
            ) : (
              <BarRanking
                items={filtered.map((r) => ({
                  code: r.code,
                  label: r.name,
                  value: barMetric.value(r),
                  detail: `${national && r.departement ? `Dép. ${r.departement} · ` : ''}${formatCount(r.n_sales)} ventes`,
                }))}
                metricLabel={barMetric.label}
                format={barFormat}
                signed={barMetric.signed}
                sort={bars.sort}
                top={bars.top}
                height={340}
                onPick={(code) => {
                  const row = filtered.find((r) => r.code === code);
                  if (row) {
                    open(row);
                  }
                }}
              />
            )}
          </Panel>

          <Panel
            span={12}
            flush
            title={`Communes · ${scopeLabel} · ${segmentLabel}`}
            tools={
              <input className="cy-input" type="search" placeholder="Filtrer par nom" aria-label="Filtrer par nom" value={query}
                onChange={(e) => setQuery(e.target.value)} style={{ width: 170 }} />
            }>
            <DataTable
              columns={columnsFor(national)}
              rows={visible.slice(0, limit)}
              rowKey={(r) => r.code}
              sort={sort}
              onSort={onSort}
              onRowClick={open}
              maxHeight={600}
              empty={
                <EmptyState>
                  {rows.length === 0
                    ? 'Pas de commune publiée pour ce segment (hors DVF, ou moins de 10 ventes).'
                    : 'Aucune ville ne passe ces filtres. Élargissez la taille, le budget ou réinitialisez les filtres.'}
                </EmptyState>
              }
            />
            {visible.length > limit && (
              <div style={{ padding: 8, borderTop: '1px solid var(--line)' }}>
                <button type="button" className="cy-button ghost" onClick={() => setLimit((l) => l + PAGE)}>
                  Afficher {Math.min(PAGE, visible.length - limit)} de plus ({formatCount(visible.length - limit)} restantes)
                </button>
              </div>
            )}
          </Panel>
        </div>
      )}
    </Shell>
  );
}

type QuadrantChartProps = {
  view: ReturnType<typeof quadrantView>;
  axis: QuadrantAxis;
  onPick: (row: InvestRow) => void;
};

/** Where each quadrant name sits over the plot (the plot corners are always in their quadrant). */
const CORNER_STYLE: Record<QuadrantKey, CSSProperties> = {
  up: { top: GRID.top + 4, right: GRID.right + 6, textAlign: 'right' },
  value: { top: GRID.top + 4, left: GRID.left + 6 },
  growth: { bottom: GRID.bottom + 6, right: GRID.right + 6, textAlign: 'right' },
  weak: { bottom: GRID.bottom + 6, left: GRID.left + 6 },
};

/** Gross yield (y) against the price change (x), dashed medians as the cross, a name in each corner. */
const QuadrantChart = ({ view, axis, onPick }: QuadrantChartProps) => {
  const { points, xMid, yMid, counts } = view;
  // with many towns, a few extreme changes would squash the others into a line: the frame then holds 96 % of them
  const trim = points.length >= 50 ? 0.02 : 0;
  const [xMin, xMax] = robustRange(points.map((p) => p.x), trim, 1 - trim, xMid);
  const [yLo, yMax] = robustRange(points.map((p) => p.y), trim / 2, 1 - trim / 2, yMid);
  const yMin = Math.max(0, yLo);
  const outside = points.filter((p) => p.x < xMin || p.x > xMax || p.y < yMin || p.y > yMax).length;
  const maxSales = Math.max(1, ...points.map((p) => p.row.n_sales));
  const xLabel = axis === 'yoy_change' ? 'Évolution du prix sur 1 an' : 'Évolution moyenne par an';
  return (
    <>
      <div style={{ position: 'relative' }}>
        <Chart
          ariaLabel={`Rendement brut et ${xLabel.toLowerCase()} de ${points.length} villes`}
          height={360}
          onClick={(p) => {
            const point = p.seriesName === 'villes' ? points[p.dataIndex ?? -1] : undefined;
            if (point) {
              onPick(point.row);
            }
          }}
          option={{
            grid: { ...GRID },
            legend: { show: false },
            tooltip: {
              trigger: 'item',
              formatter: (p: { dataIndex: number; seriesName?: string }) => {
                const point = p.seriesName === 'villes' ? points[p.dataIndex] : undefined;
                if (!point) {
                  return '';
                }
                const r = point.row;
                return `<b>${escapeHtml(r.name)}</b>${r.departement ? ` (${r.departement})` : ''}<br/>Rendement brut : ${formatPercent(r.gross_yield)}`
                  + `<br/>${xLabel} : ${formatSignedPercent(point.x)}<br/>${formatCount(r.n_sales)} ventes · ${QUADRANTS[point.quadrant].label}`;
              },
            },
            xAxis: {
              type: 'value', min: xMin, max: xMax, name: xLabel, nameLocation: 'middle', nameGap: 26, ...axisStyle(),
              axisLabel: { ...axisStyle().axisLabel, formatter: axisPercent, showMinLabel: false, showMaxLabel: false },
            },
            yAxis: {
              type: 'value', min: yMin, max: yMax, name: 'Rendement brut', nameLocation: 'middle', nameGap: 38, ...axisStyle(),
              axisLabel: { ...axisStyle().axisLabel, formatter: axisPercent, showMinLabel: false, showMaxLabel: false },
            },
            series: [
              {
                name: 'villes',
                type: 'scatter',
                cursor: 'pointer',
                clip: true,
                data: points.map((p) => [p.x, p.y]),
                symbolSize: (_: unknown, p: { dataIndex: number }) => 4 + 14 * Math.sqrt(points[p.dataIndex].row.n_sales / maxSales),
                itemStyle: { color: (p: { dataIndex: number }) => css(QUADRANT_TOKEN[points[p.dataIndex].quadrant]), opacity: 0.7 },
                markLine: {
                  symbol: 'none',
                  silent: true,
                  lineStyle: { color: css('--ink-2'), type: 'dashed' },
                  label: { color: css('--ink-3'), fontSize: 10, formatter: (l: { value: number }) => `médiane ${formatPercent(l.value)}` },
                  data: [{ xAxis: xMid }, { yAxis: yMid }],
                },
              },
            ],
          }}
        />
        {(Object.keys(QUADRANTS) as QuadrantKey[]).map((key) => (
          <span key={key} aria-hidden style={{
            position: 'absolute', ...CORNER_STYLE[key], pointerEvents: 'none', fontSize: 'var(--fs-small)', fontWeight: 600,
            color: `var(${QUADRANT_TOKEN[key]})`,
          }}>
            {QUADRANTS[key].label}
          </span>
        ))}
      </div>
      <div className="cy-note" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '4px 16px', marginTop: 6 }}>
        {QUADRANT_ORDER.map((key) => (
          <span key={key}>
            <span aria-hidden style={{ display: 'inline-block', width: 8, height: 8, marginRight: 6, background: `var(${QUADRANT_TOKEN[key]})` }} />
            <b>{QUADRANTS[key].label}</b> · {formatCount(counts[key])} ville{counts[key] > 1 ? 's' : ''} — {QUADRANTS[key].hint}
          </span>
        ))}
      </div>
      <div className="cy-note" style={{ marginTop: 4 }}>
        Croix pointillée : les médianes des villes affichées. Taille du point : nombre de ventes. Cliquez un point pour ouvrir la commune.
        {outside > 0 && ` ${formatCount(outside)} ville${outside > 1 ? 's' : ''} aux valeurs extrêmes hors du cadre (voir le tableau).`}
      </div>
    </>
  );
};
