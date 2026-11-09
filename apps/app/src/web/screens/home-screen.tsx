'use dom';

// Marché ① France (docs/features/017-guided-levels/spec.md, 018-speed-and-map): every département side by side for
// flats or houses. One ready file (levels/france.json) holds every figure; this page only sorts and draws: ribbon,
// the general map (zoom into communes), the national curve, a bar of every département on a chosen metric, the
// year-by-year heat map, biggest rises and falls, price × growth scatter and the full table.
import { useEffect, useState } from 'react';

import { type FranceLevel, type LevelPlace, loadFranceLevel } from '../../data/api';
import { BAR_METRICS, type BarMetric, heatOrder, type HeatSort, nextSort, placeLabel, sortPlaces, type TableKey, type TableSort } from '../../data/france-view';
import { formatCount, formatEurosPerM2, formatPercent, formatRentPerM2, formatSignedPercent } from '../../data/format';
import type { DwellingType } from '../../data/types';
import { BarRanking, useBarControls } from '../charts/bar-ranking';
import { axisStyle, Chart, css, SERIES_COLORS } from '../charts/chart';
import { YearHeatmap } from '../charts/year-heatmap';
import { FilterBar, Segmented, Select } from '../components/controls';
import { type Column, DataTable } from '../components/data-table';
import { EmptyState, Panel, ReliabilityBadge, Ribbon } from '../components/panel';
import { NavLink, Shell } from '../components/shell';
import { MarketSteps } from '../components/steps';
import { GeneralMap } from '../maps/general-map';
import type { ScreenProps } from '../screen-props';

const MOVERS = 15;
const TYPE_WORD: Record<DwellingType, string> = { apartment: 'appartements', house: 'maisons' };

type Row = LevelPlace & { region: string | null };
type Curve = FranceLevel['types'][DwellingType]['curve'];

const reliabilityNote = (d: Row) => `${formatCount(d.n)} ventes${d.reliability === 'low' ? ' · fiabilité faible' : ''}`;

/** Value of a half-year curve at a period (the two types may not cover the same halves). */
const curveAt = (curve: Curve | undefined, values: 'median' | 'p25' | 'p75', period: string): number | null => {
  const i = curve ? curve.periods.indexOf(period) : -1;
  return curve && i >= 0 ? curve[values][i] : null;
};

export default function HomeScreen({ filters, onFilters, navigate }: ScreenProps) {
  const type: DwellingType = filters.type === 'house' ? 'house' : 'apartment';
  const query = `?type=${type}`;
  const [level, setLevel] = useState<FranceLevel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metricKeyName, setMetricKeyName] = useState<BarMetric['key']>('price');
  const [heatSort, setHeatSort] = useState<HeatSort>('code');
  const [tableSort, setTableSort] = useState<TableSort>({ key: 'code', dir: 'asc' });
  const bars = useBarControls('code', null);

  useEffect(() => {
    loadFranceLevel().then(setLevel, (e: Error) => setError(e.message));
  }, []);

  // ---- national figures (precomputed) ------------------------------------------------------------------
  const view = level?.types[type];
  const fr = view?.france;
  const period = level?.period ?? null;
  const years = level?.years ?? [];
  const span = years.length >= 2 ? `${years[0]} → ${years[years.length - 1]}` : '';
  const frGrowth = fr?.growth ?? null;
  const tone = (v: number | null | undefined) => (v == null ? undefined : v >= 0 ? 'pos' : 'neg');

  // ---- départements --------------------------------------------------------------------------------------
  const deps: Row[] = view ? view.rows.filter((d) => d.price != null) : [];
  const open = (code: string) => navigate(`/departement/${code}${query}`);
  const loading = <EmptyState>{error ? 'Données indisponibles.' : 'Chargement…'}</EmptyState>;

  const metric = BAR_METRICS.find((m) => m.key === metricKeyName) ?? BAR_METRICS[0];
  const barItems = deps.map((d) => ({ code: d.code, label: placeLabel(d), value: metric.value(d), detail: reliabilityNote(d) }));
  const metricLabel = metric.key === 'growth' && span ? `${metric.label} (${span})` : metric.label;

  const growthItems = deps.map((d) => ({ code: d.code, label: placeLabel(d), value: d.growth, detail: reliabilityNote(d) }));
  const heatRows = heatOrder(deps.filter((d) => d.changes.some((c) => c != null)), heatSort)
    .map((d) => ({ code: d.code, label: placeLabel(d), changes: d.changes, medians: d.medians }));
  const scatter = deps.filter((d) => d.growth != null);

  // ---- national curve: flats and houses, band of the chosen type ----------------------------------------
  const flats = level?.types.apartment.curve;
  const houses = level?.types.house.curve;
  const periods = [...new Set([...(flats?.periods ?? []), ...(houses?.periods ?? [])])].sort();
  const band = view?.curve;

  // ---- table ---------------------------------------------------------------------------------------------
  const tableRows = sortPlaces(deps, tableSort);
  const onSort = (k: string) => setTableSort(nextSort(tableSort, k as TableKey));
  const columns: Column<Row>[] = [
    { key: 'code', label: 'Département', render: (d) => <>{placeLabel(d)} <ReliabilityBadge n={d.n} /></> },
    { key: 'price', label: 'Prix médian', numeric: true, info: 'median_price_m2', render: (d) => formatEurosPerM2(d.price) },
    { key: 'band', label: 'P25 – P75', numeric: true, sortable: false, render: (d) => (d.p25 != null && d.p75 != null ? `${formatCount(d.p25)} – ${formatCount(d.p75)}` : '—') },
    { key: 'yoy', label: 'Sur un an', numeric: true, info: 'yoy_change', render: (d) => formatSignedPercent(d.yoy) },
    { key: 'growth', label: span ? `Depuis ${years[0]}` : 'Sur la période', numeric: true, info: 'growth_5y', render: (d) => formatSignedPercent(d.growth) },
    { key: 'index', label: 'Indice France', numeric: true, info: 'france_index', render: (d) => formatCount(d.index) },
    { key: 'n', label: 'Ventes', numeric: true, info: 'n_sales', render: (d) => formatCount(d.n) },
    { key: 'rent', label: 'Loyer', numeric: true, info: 'rent_m2', render: (d) => formatRentPerM2(d.rent) },
    { key: 'yield', label: 'Rentab. brute', numeric: true, info: 'gross_yield', render: (d) => formatPercent(d.yield) },
  ];


  return (
    <Shell
      active="market"
      title="France"
      navigate={navigate}
      steps={<MarketSteps navigate={navigate} type={type} />}
      filters={<FilterBar filters={filters} onFilters={onFilters} show={['type']} />}>
      <div className="cy-grid">
        {error && (
          <Panel span={12} title="Données">
            <div className="cy-banner">{error}</div>
          </Panel>
        )}

        <Panel span={12} flush>
          <Ribbon
            items={[
              { label: `Prix ${TYPE_WORD[type]} · France`, value: formatEurosPerM2(fr?.price), info: 'median_price_m2',
                detail: fr?.p25 != null && fr.p75 != null ? `P25 – P75 : ${formatCount(fr.p25)} – ${formatCount(fr.p75)} €/m² · ${period}` : undefined },
              { label: 'Sur un an', value: formatSignedPercent(fr?.yoy), info: 'yoy_change',
                detail: period ? `${period} contre ${Number(period) - 1}` : undefined, tone: tone(fr?.yoy) },
              { label: 'Sur la période', value: formatSignedPercent(frGrowth), info: 'growth_5y', detail: span || undefined, tone: tone(frGrowth) },
              { label: 'Ventes', value: formatCount(fr?.n), info: 'n_sales', detail: period ?? undefined },
              { label: 'Loyer d’annonce', value: formatRentPerM2(fr?.rent), info: 'rent_m2' },
              { label: 'Rentabilité brute', value: formatPercent(fr?.yield), info: 'gross_yield' },
            ]}
          />
        </Panel>

        <Panel span={7} title={`Prix au m² des ${TYPE_WORD[type]} : départements, puis communes en zoomant`} info="median_price_m2" flush
          tools={<NavLink href={`/map${query}`} navigate={navigate}>Plein écran →</NavLink>}>
          <div className="cy-map-box" style={{ position: 'relative', height: 560 }}>
            <GeneralMap type={type} palette={filters.palette} navigate={navigate} neutral style={{ position: 'absolute', inset: 0 }} />
          </div>
        </Panel>

        <Panel span={5} title="Prix médian au m² en France, semestre par semestre" info="median_price_m2">
          {periods.length === 0 ? (
            loading
          ) : (
            <Chart
              ariaLabel="Prix médian au m² en France, appartements et maisons"
              height={480}
              option={{
                grid: { left: 56, right: 16, top: 30, bottom: 28 },
                legend: { top: 0, left: 8, data: ['Appartements', 'Maisons', 'P25 – P75'] },
                xAxis: { type: 'category', data: periods, boundaryGap: false, ...axisStyle() },
                yAxis: { type: 'value', scale: true, ...axisStyle() },
                series: [
                  { name: 'P25', type: 'line', stack: 'b', symbol: 'none', lineStyle: { opacity: 0 }, tooltip: { show: false },
                    data: periods.map((p) => curveAt(band, 'p25', p)) },
                  { name: 'P25 – P75', tooltip: { show: false }, type: 'line', stack: 'b', symbol: 'none', lineStyle: { opacity: 0 },
                    areaStyle: { color: css('--accent'), opacity: 0.1 },
                    data: periods.map((p) => {
                      const low = curveAt(band, 'p25', p);
                      const high = curveAt(band, 'p75', p);
                      return low != null && high != null ? high - low : null;
                    }) },
                  { name: 'Appartements', type: 'line', symbolSize: 4, color: SERIES_COLORS[0], data: periods.map((p) => curveAt(flats, 'median', p)) },
                  { name: 'Maisons', type: 'line', symbolSize: 4, color: SERIES_COLORS[1], data: periods.map((p) => curveAt(houses, 'median', p)) },
                ],
              }}
            />
          )}
          <div className="cy-note">Bande : moitié centrale des ventes de {TYPE_WORD[type]} (entre le 1er et le 3e quart des prix).</div>
        </Panel>

        <Panel
          span={12}
          title={`Tous les départements · ${metricLabel} des ${TYPE_WORD[type]}`}
          info={metric.info}
          tools={
            <div className="cy-chart-tools">
              <Select label="Indicateur" value={metric.key} onChange={setMetricKeyName}
                options={BAR_METRICS.map((m) => ({ value: m.key, label: m.label }))} />
              {bars.controls}
            </div>
          }>
          {deps.length === 0 ? (
            loading
          ) : (
            <BarRanking
              items={barItems}
              sort={bars.sort}
              top={bars.top}
              metricLabel={metricLabel}
              format={metric.format}
              signed={metric.signed}
              reference={{ label: 'France', value: fr ? metric.reference(fr) : null }}
              onPick={open}
              height={340}
            />
          )}
          <div className="cy-note">
            Une barre par département ({formatCount(barItems.filter((b) => b.value != null).length)}), au moins 10 ventes en {period ?? 'dernière année'}.
            Ligne pointillée : la France. Cliquez une barre pour ouvrir le département.
          </div>
        </Panel>

        <Panel
          span={12}
          hideOnPhone
          title={`Variation du prix au m² d’une année sur l’autre, par département${span ? ` (${span})` : ''}`}
          info="yearly_change"
          tools={
            <Segmented label="Ordre des lignes" value={heatSort} onChange={setHeatSort}
              options={[
                { value: 'code', label: 'N°' },
                { value: 'latest', label: `Hausse ${years.at(-1) ?? 'récente'}` },
                { value: 'growth', label: 'Hausse sur la période' },
              ]} />
          }>
          {heatRows.length === 0 || years.length < 2 ? (
            loading
          ) : (
            <YearHeatmap years={years} rows={heatRows} onPick={open} />
          )}
          <div className="cy-note">
            Chaque case compare le prix médian d’une année à l’année précédente (vert : hausse, rouge : baisse). Années complètes
            seulement ; case vide : moins de 10 ventes. Cliquez une ligne pour ouvrir le département.
          </div>
        </Panel>

        <Panel span={6} title={`Plus fortes hausses des prix${span ? ` ${span}` : ''}${frGrowth != null ? ` (France : ${formatSignedPercent(frGrowth)})` : ''}`} info="growth_5y">
          {deps.length === 0 ? (
            loading
          ) : (
            <BarRanking items={growthItems} sort="desc" top={MOVERS} metricLabel="Évolution sur la période" format={formatSignedPercent}
              signed onPick={open} height={300} />
          )}
        </Panel>
        <Panel span={6} title={`Plus fortes baisses des prix${span ? ` ${span}` : ''}${frGrowth != null ? ` (France : ${formatSignedPercent(frGrowth)})` : ''}`} info="growth_5y">
          {deps.length === 0 ? (
            loading
          ) : (
            <BarRanking items={growthItems} sort="asc" top={MOVERS} metricLabel="Évolution sur la période" format={formatSignedPercent}
              signed onPick={open} height={300} />
          )}
        </Panel>

        <Panel span={12} title={`Prix au m² et évolution sur la période${span ? ` (${span})` : ''} : où les prix sont hauts et montent`} info="growth_5y">
          {scatter.length === 0 ? (
            loading
          ) : (
            <Chart
              ariaLabel="Nuage des départements : prix médian au m² et évolution sur la période"
              height={380}
              onClick={(p) => {
                const d = scatter[p.dataIndex ?? -1];
                if (d) {
                  open(d.code);
                }
              }}
              option={{
                grid: { left: 56, right: 24, top: 16, bottom: 40 },
                tooltip: {
                  trigger: 'item',
                  formatter: (p: { dataIndex: number }) => {
                    const d = scatter[p.dataIndex];
                    return `<b>${placeLabel(d)}</b><br/>${formatEurosPerM2(d.price)} · ${formatSignedPercent(d.growth)}<br/>${reliabilityNote(d)}`;
                  },
                },
                xAxis: { type: 'value', name: '€/m²', nameLocation: 'middle', nameGap: 24, scale: true, ...axisStyle() },
                yAxis: { type: 'value', scale: true, ...axisStyle(),
                  axisLabel: { ...axisStyle().axisLabel, formatter: (v: number) => formatSignedPercent(v) } },
                series: [
                  {
                    type: 'scatter',
                    cursor: 'pointer',
                    symbolSize: 8,
                    data: scatter.map((d) => [d.price, d.growth]),
                    itemStyle: { color: (p: { dataIndex: number }) => (scatter[p.dataIndex].reliability === 'low' ? css('--ink-3') : css('--accent')), opacity: 0.8 },
                    label: { show: true, position: 'right', fontSize: 9, color: css('--ink-2'), formatter: (p: { dataIndex: number }) => scatter[p.dataIndex].code },
                    markLine: {
                      symbol: 'none',
                      silent: true,
                      lineStyle: { color: css('--ink-3'), type: 'dashed' },
                      label: { color: css('--ink-2'), fontSize: 10 },
                      data: [
                        ...(fr?.price != null ? [{ xAxis: fr.price, label: { formatter: 'France' } }] : []),
                        ...(frGrowth != null ? [{ yAxis: frGrowth, label: { formatter: 'France', position: 'insideEndTop' } }] : []),
                      ],
                    },
                  },
                ],
              }}
            />
          )}
          <div className="cy-note">
            À droite : plus cher que la France ; en haut : plus forte hausse. Points gris : moins de 30 ventes. Cliquez un point
            pour ouvrir le département.
          </div>
        </Panel>

        <Panel span={12} title={`Tableau des départements · ${TYPE_WORD[type]}, ${period ?? 'dernière année'}`} flush>
          {deps.length === 0 ? (
            loading
          ) : (
            <DataTable rows={tableRows} rowKey={(d) => d.code} columns={columns} sort={tableSort} onSort={onSort}
              onRowClick={(d) => open(d.code)} maxHeight={520} />
          )}
        </Panel>

        <Panel span={12} title="Comment lire cette page">
          <div className="cy-note">
            Ici, la France entière, département par département. Cliquez un département (carte, barre, case de la carte de chaleur,
            point ou ligne du tableau) pour passer à l’étape ② : ses communes. Sur la carte, zoomez (ou clic droit sur un département)
            pour voir ses communes ; un clic sur une commune ouvre sa fiche. Prix des ventes signées DVF de logements anciens
            (hors Alsace-Moselle et Mayotte), loyers d’annonce ANIL, revenus INSEE. Rien n’est affiché sous 10 ventes ; sous 30,
            le chiffre est marqué « fiabilité faible ». <NavLink href="/method" navigate={navigate}>Méthode et glossaire</NavLink>
          </div>
        </Panel>
      </div>
    </Shell>
  );
}
