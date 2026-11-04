'use dom';

// Évolution: up to six places on one chart for one comparable segment (type × size × ancien/neuf), per
// half-year or year, in €/m² or as an index (base 100). Below: sales per period (liquidity), OLL rents in
// place where the agglomeration is covered, and the table of every plotted value.
import { useEffect, useState } from 'react';

import { loadOll, loadPlace } from '../../data/api';
import { alignPeriods, type CurvePoint, MAX_PLACES, parsePlaces, rebase, seriesFor } from '../../data/evolution';
import { formatCount, formatEurosPerM2, formatSignedPercent } from '../../data/format';
import type { DwellingType, GeoLevel, Oll, Place } from '../../data/types';
import { axisStyle, Chart, css, SERIES_COLORS } from '../charts/chart';
import { FilterBar, FilterField, Segmented } from '../components/controls';
import { DataTable } from '../components/data-table';
import { EmptyState, Panel, Ribbon } from '../components/panel';
import { PlaceSearch } from '../components/place-search';
import { Shell } from '../components/shell';
import type { ScreenProps } from '../screen-props';

type Ref = { level: GeoLevel; code: string };
type Loaded = Record<string, { place?: Place; error?: string }>;

const keyOf = (ref: Ref) => `${ref.level}:${ref.code}`;
const DEFAULT_PLACES = 'france:FR';

export default function EvolutionScreen({ filters, params, onFilters, onParams, navigate }: ScreenProps) {
  const refs = parsePlaces(params.places ?? DEFAULT_PLACES);
  const keys = refs.map(keyOf);
  const type: DwellingType = filters.type === 'house' ? 'house' : 'apartment';
  const indexed = params.base === '100';
  const segment = { type, size: filters.condition === 'new' ? ('all' as const) : filters.size, condition: filters.condition, periodType: filters.periodType };

  const [loaded, setLoaded] = useState<Loaded>({});
  const [oll, setOll] = useState<{ code: string; data: Oll } | null>(null);

  useEffect(() => {
    let current = true;
    for (const ref of parsePlaces(keys.join(','))) {
      const key = keyOf(ref);
      loadPlace(ref.level, ref.code).then(
        (place) => current && setLoaded((prev) => ({ ...prev, [key]: { place } })),
        (e: Error) => current && setLoaded((prev) => ({ ...prev, [key]: { error: e.message } })),
      );
    }
    return () => {
      current = false;
    };
    // keys.join(',') is the identity of the list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.join(',')]);

  const places = keys.map((key) => ({ key, ...loaded[key] }));
  const series = places.map((p) => ({ key: p.key, name: p.place?.name ?? p.key, points: p.place ? seriesFor(p.place.prices, segment) : [] }));
  const periods = alignPeriods(series.map((s) => s.points.map((p) => p.period)));
  const valueAt = (points: CurvePoint[], period: string) => points.find((p) => p.period === period);
  const ollRef = places.find((p) => p.place?.oll)?.place?.oll;

  useEffect(() => {
    if (!ollRef) {
      return;
    }
    let current = true;
    loadOll(ollRef.agglo_code).then((data) => current && setOll({ code: ollRef.agglo_code, data }), () => undefined);
    return () => {
      current = false;
    };
  }, [ollRef?.agglo_code]); // eslint-disable-line react-hooks/exhaustive-deps

  const setPlaces = (next: string[]) => onParams({ places: next.length ? next.join(',') : undefined });
  const lines = series.map((s) => {
    const raw = periods.map((period) => valueAt(s.points, period)?.median ?? null);
    return { ...s, values: indexed ? rebase(raw) : raw };
  });
  const single = series.length === 1 ? series[0] : null;
  // a country next to a town: a log axis keeps every place's sales readable
  const lastSales = series.map((s) => s.points.at(-1)?.n ?? 0).filter((n) => n > 0);
  const logSales = lastSales.length > 1 && Math.max(...lastSales) / Math.min(...lastSales) > 20;
  const first = series[0]?.points;
  const change = (points: CurvePoint[] | undefined) =>
    points && points.length > 1 ? points[points.length - 1].median / points[0].median - 1 : null;

  const ollRows = oll && ollRef && oll.code === ollRef.agglo_code
    ? oll.data.rows
        .filter((r) => r.property_type === type && r.rooms === 'all' && r.period_built === 'all' && r.tenancy === 'all')
        .sort((a, b) => a.year - b.year)
    : [];

  return (
    <Shell
      active="evolution"
      title="Évolution"
      navigate={navigate}
      crumbs={[{ label: 'Courbes de prix' }]}
      filters={
        <FilterBar filters={filters} onFilters={onFilters} show={['type', 'size', 'condition']}>
          <FilterField label="Pas de temps">
            <Segmented
              label="Pas de temps"
              options={[
                { value: 'half', label: 'Semestre' },
                { value: 'year', label: 'Année' },
              ]}
              value={filters.periodType}
              onChange={(periodType) => onFilters({ periodType, period: null })}
            />
          </FilterField>
          <FilterField label="Échelle">
            <Segmented
              label="Échelle"
              options={[
                { value: 'eur', label: '€/m²' },
                { value: '100', label: 'Base 100' },
              ]}
              value={indexed ? '100' : 'eur'}
              onChange={(v) => onParams({ base: v === '100' ? '100' : undefined })}
            />
          </FilterField>
        </FilterBar>
      }>
      <div className="cy-grid">
        <Panel span={12} title={`Lieux comparés (${keys.length} / ${MAX_PLACES})`}>
          <div className="cy-chips">
            {series.map((s, i) => (
              <span className="cy-chip" key={s.key}>
                <i style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
                {s.name}
                {loaded[s.key]?.error && <span className="neg"> indisponible</span>}
                <button type="button" aria-label={`Retirer ${s.name}`} onClick={() => setPlaces(keys.filter((k) => k !== s.key))}>×</button>
              </span>
            ))}
            {keys.length < MAX_PLACES && (
              <PlaceSearch exclude={keys} placeholder="Ajouter un lieu…" onPick={(p) => setPlaces([...keys, `${p.level}:${p.code}`])} />
            )}
          </div>
        </Panel>
        <Panel span={12} flush>
          <Ribbon
            items={series.slice(0, 6).map((s) => {
              const last = s.points.at(-1);
              const delta = change(s.points);
              return {
                label: s.name,
                value: last ? formatEurosPerM2(last.median) : '—',
                detail: last ? `${last.period} · ${formatSignedPercent(delta)} depuis ${s.points[0].period}` : 'pas de série publiée',
              };
            })}
          />
        </Panel>
        <Panel span={12} title={`Prix médian au m² · ${type === 'house' ? 'maisons' : 'appartements'}${indexed ? ' · indice base 100' : ''}`} info="median_price_m2">
          {periods.length === 0 ? (
            <EmptyState>Aucune série publiée pour ce segment. Essayez « Toutes » tailles ou l’ancien.</EmptyState>
          ) : (
            <Chart
              ariaLabel="Courbes du prix médian au m²"
              height={340}
              option={{
                grid: { left: 56, right: 16, top: 30, bottom: 30 },
                legend: { top: 0, left: 8, data: lines.map((l) => l.name) },
                xAxis: { type: 'category', data: periods, boundaryGap: false, ...axisStyle() },
                yAxis: { type: 'value', scale: true, ...axisStyle() },
                series: [
                  ...(single && !indexed
                    ? [
                        { name: 'P25', type: 'line', stack: 'band', symbol: 'none', lineStyle: { opacity: 0 },
                          data: periods.map((p) => valueAt(single.points, p)?.p25 ?? null), tooltip: { show: false } },
                        { name: 'P25 – P75', tooltip: { show: false }, type: 'line', stack: 'band', symbol: 'none', lineStyle: { opacity: 0 },
                          areaStyle: { color: css('--accent'), opacity: 0.12 },
                          data: periods.map((p) => {
                            const v = valueAt(single.points, p);
                            return v ? v.p75 - v.p25 : null;
                          }) },
                      ]
                    : []),
                  ...lines.map((l, i) => ({
                    name: l.name,
                    type: 'line',
                    data: l.values,
                    connectNulls: true,
                    symbolSize: 4,
                    lineStyle: { width: 2 },
                    color: SERIES_COLORS[i % SERIES_COLORS.length],
                  })),
                ],
              }}
            />
          )}
          {single && !indexed && <div className="cy-note">Bande : moitié centrale des ventes (P25 – P75).</div>}
        </Panel>
        <Panel span={6} title={`Ventes par période (liquidité)${logSales ? ' · échelle log' : ''}`} info="n_sales">
          {periods.length === 0 ? (
            <EmptyState>—</EmptyState>
          ) : (
            <Chart
              ariaLabel="Nombre de ventes par période"
              height={220}
              option={{
                grid: { left: 56, right: 12, top: 26, bottom: 28 },
                legend: { top: 0, left: 8 },
                xAxis: { type: 'category', data: periods, ...axisStyle() },
                yAxis: { type: logSales ? 'log' : 'value', ...axisStyle() },
                series: series.map((s, i) => ({
                  name: s.name,
                  type: 'bar',
                  data: periods.map((p) => valueAt(s.points, p)?.n ?? null),
                  color: SERIES_COLORS[i % SERIES_COLORS.length],
                })),
              }}
            />
          )}
        </Panel>
        <Panel span={6} title={`Loyers en place (OLL)${ollRef ? ` · ${ollRef.agglomeration}` : ''}`} info="oll">
          {!ollRef ? (
            <EmptyState>Aucun lieu choisi n’est couvert par un observatoire local des loyers.</EmptyState>
          ) : ollRows.length === 0 ? (
            <EmptyState>Chargement ou pas de série pour ce type.</EmptyState>
          ) : (
            <Chart
              ariaLabel="Loyers médians en place"
              height={220}
              option={{
                grid: { left: 48, right: 12, top: 16, bottom: 28 },
                xAxis: { type: 'category', data: ollRows.map((r) => String(r.year)), ...axisStyle() },
                yAxis: { type: 'value', scale: true, ...axisStyle() },
                series: [
                  { name: 'Loyer médian €/m²', type: 'line', data: ollRows.map((r) => r.rent_m2_median), color: SERIES_COLORS[1] },
                  { name: 'D1', type: 'line', symbol: 'none', lineStyle: { type: 'dashed', width: 1 }, data: ollRows.map((r) => r.rent_m2_d1), color: css('--ink-3') },
                  { name: 'D9', type: 'line', symbol: 'none', lineStyle: { type: 'dashed', width: 1 }, data: ollRows.map((r) => r.rent_m2_d9), color: css('--ink-3') },
                ],
              }}
            />
          )}
        </Panel>
        <Panel span={12} title="Valeurs tracées" flush>
          <DataTable
            rows={periods.map((period) => ({ period }))}
            rowKey={(r) => r.period}
            maxHeight={320}
            columns={[
              { key: 'period', label: 'Période', render: (r) => r.period },
              ...series.flatMap((s) => [
                { key: `${s.key}-m`, label: `${s.name} €/m²`, numeric: true, render: (r: { period: string }) => {
                  const v = valueAt(s.points, r.period);
                  return v ? `${formatEurosPerM2(v.median)}${v.partial ? ' *' : ''}` : '—';
                } },
                { key: `${s.key}-n`, label: 'ventes', numeric: true, render: (r: { period: string }) => formatCount(valueAt(s.points, r.period)?.n) },
              ]),
            ]}
          />
          <div className="cy-note" style={{ padding: '6px 14px' }}>
            * année incomplète (fenêtre DVF glissante) : comparez-la par semestre.{' '}
            {first && first.length === 0 && 'Le premier lieu n’a pas de série pour ce segment.'}
          </div>
        </Panel>
      </div>
    </Shell>
  );
}
