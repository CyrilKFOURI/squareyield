'use dom';

// Explorer: every région, département or commune of a département as one row of the selected comparable
// segment (type × size), sortable on every indicator, with a price × yield scatter, the distribution of the
// chosen indicator and a CSV export of the visible rows. Latest complete year (evolution is its own screen).
import { useEffect, useState } from 'react';

import { loadTable } from '../../data/api';
import { catalogueEntry } from '../../data/catalogue';
import { activeCount, applyScreenFilters, parseScreenFilters } from '../../data/screen-filters';
import { EXPLORER_METRIC, type ExplorerRow, filterRows, histogram, parseBound, PERCENT_METRICS, type Ranges, sortRows, toCsv } from '../../data/explorer';
import {
  formatCount,
  formatEuros,
  formatEurosPerM2,
  formatPercent,
  formatRentPerM2,
  formatSignedPercent,
} from '../../data/format';
import { METRICS } from '../../data/map';
import type { DwellingType, GeoLevel } from '../../data/types';
import { axisStyle, Chart, css } from '../charts/chart';
import { FilterBar, FilterField, Segmented, Select } from '../components/controls';
import { type Column, DataTable } from '../components/data-table';
import { EmptyState, ErrorPanel, Panel, ReliabilityBadge, Ribbon } from '../components/panel';
import { PlaceDetail } from '../components/place-detail';
import { ScreenFilterPanel } from '../components/screen-filter-panel';
import { NavLink, Shell } from '../components/shell';
import type { ScreenProps } from '../screen-props';

type Scope = 'regions' | 'departements' | string; // a département code = its communes
const PAGE = 200;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmt = (base: string) => METRICS.find((m) => m.base === base)?.format ?? ((v: number) => String(v));
const tone = (v: number | null) => (v == null ? undefined : v >= 0 ? 'pos' : 'neg');

const COLUMNS: Column<ExplorerRow>[] = [
  { key: 'name', label: 'Lieu', render: (r) => r.name ?? r.code },
  { key: 'n_sales', label: 'Ventes', numeric: true, info: 'n_sales', render: (r) => (
    <>{formatCount(r.n_sales)} <ReliabilityBadge n={r.n_sales} /></>
  ) },
  { key: 'median_price_m2', label: '€/m²', numeric: true, info: 'median_price_m2', render: (r) => formatEurosPerM2(r.median_price_m2) },
  { key: 'p25_price_m2', label: 'P25 – P75', numeric: true, sortable: false, render: (r) =>
    r.p25_price_m2 == null ? '—' : `${Math.round(r.p25_price_m2)} – ${Math.round(r.p75_price_m2 ?? 0)}` },
  { key: 'median_price', label: 'Prix médian', numeric: true, render: (r) => formatEuros(r.median_price) },
  { key: 'yoy_change', label: '1 an', numeric: true, info: 'yoy_change', render: (r) => (
    <span className={tone(r.yoy_change)}>{formatSignedPercent(r.yoy_change)}</span>
  ) },
  { key: 'cagr', label: 'Moy. / an', numeric: true, info: 'cagr', render: (r) => formatSignedPercent(r.cagr) },
  { key: 'rent_m2', label: 'Loyer', numeric: true, info: 'rent_m2', render: (r) => formatRentPerM2(r.rent_m2) },
  { key: 'gross_yield', label: 'Rdt brut', numeric: true, info: 'gross_yield', render: (r) => formatPercent(r.gross_yield) },
  { key: 'net_yield', label: 'Rdt net', numeric: true, info: 'net_yield', render: (r) => formatPercent(r.net_yield) },
  { key: 'cash_flow_monthly', label: 'Cash-flow', numeric: true, info: 'cash_flow_monthly', render: (r) =>
    r.cash_flow_monthly == null ? '—' : <span className={tone(r.cash_flow_monthly)}>{Math.round(r.cash_flow_monthly)} €</span> },
  { key: 'score', label: 'Score', numeric: true, info: 'score', render: (r) => (r.score == null ? '—' : String(Math.round(r.score))) },
  { key: 'share_fg', label: 'F/G', numeric: true, info: 'share_fg', render: (r) => formatPercent(r.share_fg) },
  { key: 'vacancy_rate', label: 'Vacance', numeric: true, info: 'vacancy_rate', render: (r) => formatPercent(r.vacancy_rate) },
  { key: 'population_growth_yearly', label: 'Pop. / an', numeric: true, info: 'population_growth_yearly', render: (r) =>
    formatSignedPercent(r.population_growth_yearly) },
  { key: 'tfpb_rate', label: 'TF', numeric: true, info: 'tfpb_rate', render: (r) => formatPercent(r.tfpb_rate) },
];

const CSV_FIELDS: (keyof ExplorerRow & string)[] = [
  'code', 'name', 'level', 'type', 'size', 'n_sales', 'reliability', 'median_price_m2', 'p25_price_m2', 'p75_price_m2',
  'median_price', 'median_surface_m2', 'yoy_change', 'cagr', 'rent_m2', 'gross_yield', 'net_yield', 'cash_flow_monthly',
  'cap_rate', 'score', 'share_fg', 'vacancy_rate', 'population', 'population_growth_yearly', 'tfpb_rate',
];

const pathOf = (scope: Scope) =>
  scope === 'regions' ? 'explorer/regions.json' : scope === 'departements' ? 'explorer/departements.json' : `explorer/communes/${scope}.json`;

const download = (name: string, text: string) => {
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export default function ExplorerScreen({ filters, params, onFilters, onParams, navigate }: ScreenProps) {
  const scope: Scope = filters.level === 'departement' ? filters.code : params.scope === 'regions' ? 'regions' : 'departements';
  const type: DwellingType = filters.type === 'house' ? 'house' : 'apartment';
  const metric = METRICS.find((m) => m.base === filters.metric) ?? METRICS[0];
  const metricField = EXPLORER_METRIC[metric.base] ?? 'median_price_m2';
  const sort = { key: params.sort ?? metricField, dir: params.dir === 'asc' ? ('asc' as const) : ('desc' as const) };

  const [data, setData] = useState<{ scope: Scope; rows: ExplorerRow[]; period: string | null } | null>(null);
  const [error, setError] = useState<{ scope: Scope; message: string } | null>(null);
  const [departements, setDepartements] = useState<{ code: string; name: string }[]>([]);
  const [regions, setRegions] = useState<{ code: string; name: string }[]>([]);
  const screen = parseScreenFilters(params);
  const [query, setQuery] = useState('');
  // a selection belongs to the table it was made in (the back button can change the table)
  const [selection, setSelection] = useState<{ scope: Scope; row: ExplorerRow } | null>(null);
  const selected = selection?.scope === scope ? selection.row : null;
  const setSelected = (row: ExplorerRow | null) => setSelection(row ? { scope, row } : null);
  const [limit, setLimit] = useState(PAGE);
  // bounds belong to one indicator: switching indicator starts with none
  const [bounds, setBounds] = useState({ metric: '', min: '', max: '' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    loadTable<ExplorerRow>(pathOf(scope)).then(
      (table) => current && setData({ scope, rows: table.rows, period: table.period }),
      (e: Error) => current && setError({ scope, message: e.message }),
    );
    return () => {
      current = false;
    };
  }, [scope, attempt]);
  useEffect(() => {
    loadTable<ExplorerRow>('explorer/departements.json').then((table) => {
      const seen = new Map<string, string>();
      table.rows.forEach((r) => seen.set(r.code, r.name));
      setDepartements([...seen].map(([code, name]) => ({ code, name })).sort((a, b) => a.code.localeCompare(b.code)));
    }, () => undefined);
    loadTable<ExplorerRow>('explorer/regions.json').then((table) => {
      const seen = new Map<string, string>();
      table.rows.forEach((r) => seen.set(r.code, r.name));
      setRegions([...seen].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name, 'fr')));
    }, () => undefined);
  }, []);

  const ready = data?.scope === scope ? data : null;
  const failed = error?.scope === scope ? error.message : null;
  const min = bounds.metric === metric.base ? bounds.min : '';
  const max = bounds.metric === metric.base ? bounds.max : '';
  const low = parseBound(min, metric.base);
  const high = parseBound(max, metric.base);
  const ranges: Ranges = low != null || high != null ? { [metricField]: [low, high] } : {};
  const visible = ready
    ? sortRows(applyScreenFilters(filterRows(ready.rows, { type, size: filters.size, reliable: filters.reliable }, ranges, query), screen), sort.key as keyof ExplorerRow, sort.dir)
    : [];
  const values = visible.map((r) => num(r[metricField]));
  const known = values.filter((v): v is number => v != null).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : null;
  const totalSales = visible.reduce((sum, r) => sum + (r.n_sales ?? 0), 0);
  const hist = histogram(values, 24);
  const selectedValue = selected ? num(selected[metricField]) : null;
  const scopeLabel = scope === 'regions' ? 'Régions' : scope === 'departements' ? 'Départements' : `Communes · ${departements.find((d) => d.code === scope)?.name ?? scope}`;
  const typeLabel = type === 'house' ? 'maisons' : 'appartements';
  const format = fmt(metric.base);

  const onSort = (key: string) =>
    onParams({ sort: key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : 'desc' });

  const setScope = (next: string) => {
    setSelected(null);
    setLimit(PAGE);
    if (next === 'regions' || next === 'departements') {
      onFilters({ level: 'france', code: 'FR' });
      onParams({ scope: next === 'regions' ? 'regions' : undefined });
    } else {
      onFilters({ level: 'departement', code: next });
    }
  };

  const scatter = visible.filter((r) => r.gross_yield != null);
  const maxSales = Math.max(1, ...scatter.map((r) => r.n_sales));

  return (
    <Shell
      active="explorer"
      title="Explorer"
      navigate={navigate}
      crumbs={[{ label: 'France', href: '/explorer' }, ...(scope.length <= 3 ? [{ label: scopeLabel }] : [])]}
      tools={
        <button type="button" className="cy-button ghost" disabled={visible.length === 0}
          onClick={() => download(`cyfouri_${scope}_${type}_${filters.size}_${ready?.period ?? ''}.csv`, toCsv(visible, CSV_FIELDS))}>
          Exporter CSV
        </button>
      }
      filters={
        <FilterBar filters={filters} onFilters={onFilters} show={['type', 'size', 'metric', 'reliable']}>
          <FilterField label="Territoire">
            <div style={{ display: 'flex', gap: 6 }}>
              <Segmented
                label="Niveau"
                options={[
                  { value: 'regions', label: 'Régions' },
                  { value: 'departements', label: 'Départements' },
                ]}
                value={scope === 'regions' ? 'regions' : 'departements'}
                onChange={setScope}
              />
              <Select
                label="Communes d’un département"
                options={[{ value: '', label: 'Communes de…' }, ...departements.map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))]}
                value={scope.length <= 3 ? scope : ''}
                onChange={(code) => code && setScope(code)}
              />
            </div>
          </FilterField>
        </FilterBar>
      }>
      {failed ? (
        <ErrorPanel message={`Tableau indisponible : ${failed}`} onRetry={() => setAttempt((a) => a + 1)} />
      ) : !ready ? (
        <EmptyState>Chargement…</EmptyState>
      ) : (
        <div className="cy-grid">
          <ScreenFilterPanel params={params} onParams={onParams} active={activeCount(screen)} regions={scope === 'departements' ? regions : null} />
          <Panel span={12} flush>
            <Ribbon
              items={[
                { label: 'Lieux affichés', value: formatCount(visible.length), detail: `${scopeLabel} · ${typeLabel}` },
                { label: 'Ventes', value: formatCount(totalSales), detail: `année ${ready.period ?? '—'}`, info: 'n_sales' },
                { label: 'Médiane des lieux', value: median == null ? '—' : format(median), detail: metric.label, info: metric.base },
                { label: 'Plus bas', value: known.length ? format(known[0]) : '—' },
                { label: 'Plus haut', value: known.length ? format(known[known.length - 1]) : '—' },
              ]}
            />
          </Panel>
          <Panel
            span={8}
            flush
            title={`${scopeLabel} · ${typeLabel}${filters.size === 'all' ? '' : ` · ${type === 'house' ? `${filters.size} p.` : `T${filters.size}`}`}`}
            tools={
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input className="cy-input" type="search" placeholder="Filtrer par nom" aria-label="Filtrer par nom" value={query}
                  onChange={(e) => setQuery(e.target.value)} style={{ width: 150 }} />
                <span className="ink-3" style={{ fontSize: 'var(--fs-small)' }}>{metric.label}{PERCENT_METRICS.has(metric.base) ? ' (%)' : ''}</span>
                <input className="cy-input num" inputMode="decimal" placeholder="min" aria-label={`${metric.label} minimum`} value={min}
                  onChange={(e) => setBounds({ metric: metric.base, min: e.target.value, max })} style={{ width: 70 }} />
                <input className="cy-input num" inputMode="decimal" placeholder="max" aria-label={`${metric.label} maximum`} value={max}
                  onChange={(e) => setBounds({ metric: metric.base, min, max: e.target.value })} style={{ width: 70 }} />
              </div>
            }>
            <DataTable
              columns={COLUMNS}
              rows={visible.slice(0, limit)}
              rowKey={(r) => `${r.level}:${r.code}`}
              sort={sort}
              onSort={onSort}
              selected={selected ? `${selected.level}:${selected.code}` : null}
              onRowClick={setSelected}
              maxHeight={560}
              empty={
                <EmptyState>
                  {ready.rows.length === 0
                    ? 'Pas de ventes publiées pour ce territoire (hors DVF ou trop peu de ventes).'
                    : 'Aucun lieu ne passe ces filtres. Élargissez la taille, décochez « fiables » ou videz min / max.'}
                </EmptyState>
              }
            />
            {visible.length > limit && (
              <div style={{ padding: 8, borderTop: '1px solid var(--line)' }}>
                <button type="button" className="cy-button ghost" onClick={() => setLimit((l) => l + PAGE)}>
                  Afficher {Math.min(PAGE, visible.length - limit)} de plus ({formatCount(visible.length - limit)} restants)
                </button>
              </div>
            )}
          </Panel>
          <div style={{ gridColumn: 'span 4', display: 'flex', flexDirection: 'column' }}>
            <Panel span={12} title="Prix × rentabilité brute" info="gross_yield">
              {scatter.length === 0 ? (
                <EmptyState>Pas de rentabilité publiée pour ce segment.</EmptyState>
              ) : (
                <Chart
                  ariaLabel="Nuage prix au m² et rentabilité brute"
                  height={260}
                  onClick={(p) => {
                    const row = scatter[p.dataIndex ?? -1];
                    if (row) {
                      setSelected(row);
                    }
                  }}
                  option={{
                    grid: { left: 48, right: 12, top: 12, bottom: 36 },
                    tooltip: {
                      trigger: 'item',
                      formatter: (p: { dataIndex: number }) => {
                        const r = scatter[p.dataIndex];
                        return `<b>${escapeHtml(r.name ?? r.code)}</b><br/>${formatEurosPerM2(r.median_price_m2)} · ${formatPercent(r.gross_yield)}<br/>${formatCount(r.n_sales)} ventes`;
                      },
                    },
                    xAxis: { type: 'value', name: '€/m²', nameLocation: 'middle', nameGap: 22, scale: true, ...axisStyle() },
                    yAxis: { type: 'value', scale: true, ...axisStyle(), axisLabel: { ...axisStyle().axisLabel, formatter: (v: number) => `${(v * 100).toFixed(0)} %` } },
                    series: [
                      {
                        type: 'scatter',
                        data: scatter.map((r) => [r.median_price_m2, r.gross_yield]),
                        symbolSize: (_: unknown, p: { dataIndex: number }) => 4 + 14 * Math.sqrt(scatter[p.dataIndex].n_sales / maxSales),
                        itemStyle: {
                          color: (p: { dataIndex: number }) =>
                            selected && scatter[p.dataIndex].code === selected.code ? css('--neg') : css('--accent'),
                          opacity: 0.7,
                        },
                      },
                    ],
                  }}
                />
              )}
            </Panel>
            <Panel span={12} title={`Distribution · ${metric.label}`} info={metric.base}>
              {hist.counts.length === 0 ? (
                <EmptyState>Pas de valeur pour cet indicateur.</EmptyState>
              ) : (
                <Chart
                  ariaLabel={`Distribution de l’indicateur ${metric.label}`}
                  height={170}
                  option={{
                    grid: { left: 36, right: 12, top: 12, bottom: 28 },
                    tooltip: { trigger: 'axis' },
                    xAxis: {
                      type: 'category',
                      data: hist.counts.map((_, i) => format(hist.edges[i])),
                      ...axisStyle(),
                      axisLabel: { ...axisStyle().axisLabel, interval: 5 },
                    },
                    yAxis: { type: 'value', minInterval: 1, ...axisStyle() },
                    series: [
                      {
                        type: 'bar',
                        barCategoryGap: 1,
                        data: hist.counts.map((count, i) => ({
                          value: count,
                          itemStyle: {
                            color:
                              selectedValue != null && selectedValue >= hist.edges[i] && selectedValue <= hist.edges[i + 1]
                                ? css('--neg')
                                : css('--accent'),
                          },
                        })),
                      },
                    ],
                  }}
                />
              )}
              <div className="cy-note">
                {catalogueEntry(metric.base)?.howToRead ?? ''}
                {selected && selectedValue != null && ` En rouge : ${selected.name} (${format(selectedValue)}).`}
              </div>
            </Panel>
            <Panel span={12} title="Sélection" flush>
              {selected ? (
                <>
                  <PlaceDetail level={selected.level as GeoLevel} code={selected.code} type={type} navigate={navigate} />
                  {selected.level === 'departement' && (
                    <div style={{ padding: '0 14px 12px' }}>
                      <button type="button" className="cy-button" onClick={() => setScope(selected.code)}>
                        Voir ses communes →
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <EmptyState>
                  Cliquez une ligne ou un point pour voir sa fiche. Les lignes comparent des biens du même type et de la
                  même taille, sur la dernière année complète. <NavLink href="/method" navigate={navigate}>Méthode</NavLink>
                </EmptyState>
              )}
            </Panel>
          </div>
        </div>
      )}
    </Shell>
  );
}
