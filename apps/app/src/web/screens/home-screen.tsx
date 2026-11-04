'use dom';

// Vue nationale: France for the selected segment. KPI ribbon, compact choropleth by département, national
// price curve (flats and houses, P25–P75 band of the selected type), top / bottom 10 départements and
// communes for the chosen indicator, and three entry paths for a newcomer (dismissible).
import { useEffect, useState } from 'react';

import { type CommunePoint, loadCommunePoints, loadPlace, loadTable } from '../../data/api';
import { catalogueEntry } from '../../data/catalogue';
import { EXPLORER_METRIC, type ExplorerRow } from '../../data/explorer';
import { formatCount, formatEurosPerM2, formatPercent, formatRentPerM2, formatSignedPercent } from '../../data/format';
import { type Breaks, loadBreaks, loadMapLayer, type MapLayer, METRICS, metricKey } from '../../data/map';
import { colorFor } from '../../data/scales';
import { halfYearSeries, latestCell, yieldFor } from '../../data/select';
import type { DwellingType, Place } from '../../data/types';
import { axisStyle, Chart, css, SERIES_COLORS } from '../charts/chart';
import { FilterBar } from '../components/controls';
import { DataTable } from '../components/data-table';
import { EmptyState, Panel, Ribbon } from '../components/panel';
import { PlaceSearch } from '../components/place-search';
import { NavLink, Shell } from '../components/shell';
import { type Feature, MapCanvas, METROPOLE } from '../maps/map-canvas';
import { useDark } from '../hooks/use-dark';
import type { ScreenProps } from '../screen-props';

const INTRO_KEY = 'cy-intro-dismissed';
const RELIABLE = 30;
const POINT_FIELD: Record<string, keyof CommunePoint> = { price: 'median_price_m2', yield: 'gross_yield', cash_flow: 'cash_flow_monthly' };

const readIntro = () => {
  try {
    return window.localStorage.getItem(INTRO_KEY) !== '1';
  } catch {
    return true;
  }
};
export default function HomeScreen({ filters, onFilters, navigate }: ScreenProps) {
  const type: DwellingType = filters.type === 'house' ? 'house' : 'apartment';
  const metric = METRICS.find((m) => m.base === filters.metric) ?? METRICS[0];
  const higher = catalogueEntry(metric.base)?.higherIsBetter ?? null;
  const [france, setFrance] = useState<Place | null>(null);
  const [layer, setLayer] = useState<MapLayer | null>(null);
  const [breaks, setBreaks] = useState<Breaks | null>(null);
  const [deps, setDeps] = useState<ExplorerRow[] | null>(null);
  const [communes, setCommunes] = useState<CommunePoint[] | null>(null);
  const [intro, setIntro] = useState(readIntro);
  const dark = useDark();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fail = (e: Error) => setError(e.message);
    loadPlace('france', 'FR').then(setFrance, fail);
    loadMapLayer('departements.geojson').then(setLayer, fail);
    loadBreaks().then(setBreaks, fail);
    loadTable<ExplorerRow>('explorer/departements.json').then((t) => setDeps(t.rows), fail);
    loadCommunePoints().then((t) => setCommunes(t.rows), () => setCommunes([]));
  }, []);

  const segment = { propertyType: type, rooms: filters.size };
  const year = france ? latestCell(france.prices, france.latest, segment)?.row : undefined;
  const rent = france && year ? yieldFor(france.yields, segment, year.period) : undefined;
  const deal = france?.typical_deal?.[type]?.[filters.size];
  const key = metricKey(metric.base, type);
  const polygons = layer
    ? { type: 'FeatureCollection' as const, features: (layer.features as unknown as Feature[]).map((f) => ({
        ...f, properties: { ...f.properties, _fill: colorFor(f.properties[key] as number, breaks?.departements[key] ?? [], filters.palette, higher) } })) }
    : null;

  const field = EXPLORER_METRIC[metric.base] ?? 'median_price_m2';
  const depRows = (deps ?? []).filter((r) => r.type === type && r.size === filters.size && r.n_sales >= RELIABLE && r[field] != null);
  const sortBy = <T,>(rows: T[], value: (r: T) => number, best: boolean) =>
    [...rows].sort((a, b) => ((higher ?? true) === best ? value(b) - value(a) : value(a) - value(b))).slice(0, 10);
  const pField = POINT_FIELD[metric.base];
  const comRows = pField ? (communes ?? []).filter((c) => c.type === type && c.n >= RELIABLE && c[pField] != null) : [];
  const fmt = metric.format;
  // commune points are published for all sizes only
  const allSizesNote = filters.size === 'all' ? '' : ' (toutes tailles)';
  const comLabel = communes === null ? 'Chargement…' : 'Pas de communes classées.';
  const curve = (t: DwellingType) => (france ? halfYearSeries(france.prices, { propertyType: t, rooms: 'all' }) : []);
  const flats = curve('apartment');
  const houses = curve('house');
  const periods = [...new Set([...flats, ...houses].map((r) => r.period))].sort();
  const band = curve(type);

  const dismiss = () => {
    setIntro(false);
    try {
      window.localStorage.setItem(INTRO_KEY, '1');
    } catch {
      // private window: the intro simply comes back next time
    }
  };

  const top = (rows: { name: string; href: string; value: number; n: number }[], title: string) => (
    <DataTable
      rows={rows}
      rowKey={(r) => r.href}
      onRowClick={(r) => navigate(r.href)}
      columns={[
        { key: 'name', label: title, render: (r) => r.name },
        { key: 'value', label: metric.label, numeric: true, render: (r) => fmt(r.value) },
        { key: 'n', label: 'Ventes', numeric: true, render: (r) => formatCount(r.n) },
      ]}
    />
  );
  const depList = (best: boolean) => sortBy(depRows, (r) => r[field] as number, best)
    .map((r) => ({ name: `${r.name} (${r.code})`, href: `/place/departement/${r.code}?type=${type}`, value: r[field] as number, n: r.n_sales }));
  const comList = (best: boolean) => sortBy(comRows, (r) => r[pField] as number, best)
    .map((r) => ({ name: `${r.name} (${r.dep})`, href: `/place/${r.level}/${r.code}?type=${type}`, value: r[pField] as number, n: r.n }));
  // départements are masculine, communes feminine
  const bestWord = (f: boolean) => (higher === false ? `moins ${f ? 'chères' : 'chers'}` : higher === true ? (f ? 'meilleures' : 'meilleurs') : `plus ${f ? 'hautes' : 'hauts'}`);
  const worstWord = (f: boolean) => (higher === false ? `plus ${f ? 'chères' : 'chers'}` : higher === true ? `moins ${f ? 'bonnes' : 'bons'}` : 'plus bas');

  return (
    <Shell active="home" title="Vue nationale" navigate={navigate} crumbs={[{ label: 'France' }]}
      tools={<PlaceSearch onPick={(p) => navigate(`/place/${p.level}/${p.code}?type=${type}`)} />}
      filters={<FilterBar filters={filters} onFilters={onFilters} show={['type', 'size', 'metric']} />}>
      <div className="cy-grid">
        {intro && (
          <Panel span={12} title="Par où commencer ?" tools={<button type="button" className="cy-button ghost" onClick={dismiss}>Masquer</button>}>
            <div className="cy-paths">
              <NavLink href="/map" navigate={navigate}><b>J’ai une ville en tête</b><span>Carte, puis la page complète du marché : prix, loyers, rentabilité, risques.</span></NavLink>
              <NavLink href="/property" navigate={navigate}><b>J’ai une annonce</b><span>Prix juste, loyer à cette surface, cash-flow et risques du bien.</span></NavLink>
              <NavLink href="/simulator" navigate={navigate}><b>Je prépare le financement</b><span>Crédit, fiscalité, revente : le simulateur complet.</span></NavLink>
              <NavLink href="/explorer" navigate={navigate}><b>Je cherche où investir</b><span>Toutes les villes classées sur l’indicateur de votre choix.</span></NavLink>
            </div>
          </Panel>
        )}
        {error && <Panel span={12} title="Données"><div className="cy-banner">{error}</div></Panel>}
        <Panel span={12} flush>
          <Ribbon items={[
            { label: `Prix ${type === 'house' ? 'maisons' : 'appartements'} · France`, value: formatEurosPerM2(year?.median_price_m2), info: 'median_price_m2',
              detail: year ? `${formatEurosPerM2(year.p25_price_m2)} – ${formatEurosPerM2(year.p75_price_m2)}` : undefined },
            { label: 'Sur un an', value: formatSignedPercent(year?.yoy_change), info: 'yoy_change', detail: year?.period },
            { label: 'Ventes', value: formatCount(year?.n_sales), info: 'n_sales' },
            { label: 'Loyer d’annonce', value: formatRentPerM2(rent?.rent_m2), info: 'rent_m2' },
            { label: 'Rentabilité brute', value: formatPercent(rent?.gross_yield), info: 'gross_yield' },
            { label: 'Cash-flow bien type', value: deal ? `${Math.round(deal.cash_flow_monthly)} €/mois` : '—', info: 'cash_flow_monthly',
              tone: deal ? (deal.cash_flow_monthly >= 0 ? 'pos' : 'neg') : undefined },
          ]} />
        </Panel>
        <Panel span={5} title={`${metric.label} par département`} info={metric.base} flush
          tools={<NavLink href={`/map?type=${type}&metric=${metric.base}`} navigate={navigate}>Carte complète →</NavLink>}>
          {metric.communesOnly && <div className="cy-note" style={{ padding: '6px 14px' }}>Indicateur calculé par commune : ouvrez la carte complète et cliquez un département.</div>}
          <div style={{ position: 'relative', height: 380 }}>
            {polygons ? (
              <MapCanvas polygons={polygons as never} points={null} dark={dark} bounds={METROPOLE as never} style={{ position: 'absolute', inset: 0 }}
                onHover={() => undefined} onClick={(p) => navigate(`/map?level=departement&code=${String(p.code)}&type=${type}&metric=${metric.base}`)} />
            ) : (
              <EmptyState>Chargement…</EmptyState>
            )}
          </div>
        </Panel>
        <Panel span={7} title="Prix au m² en France par semestre" info="median_price_m2">
          {periods.length === 0 ? (
            <EmptyState>Chargement…</EmptyState>
          ) : (
            <Chart ariaLabel="Prix médian au m² en France, appartements et maisons" height={340} option={{
              grid: { left: 56, right: 16, top: 30, bottom: 28 },
              legend: { top: 0, left: 8, data: ['Appartements', 'Maisons', 'P25 – P75'] },
              xAxis: { type: 'category', data: periods, boundaryGap: false, ...axisStyle() },
              yAxis: { type: 'value', scale: true, ...axisStyle() },
              series: [
                { name: 'P25', type: 'line', stack: 'b', symbol: 'none', lineStyle: { opacity: 0 }, tooltip: { show: false },
                  data: periods.map((p) => band.find((r) => r.period === p)?.p25_price_m2 ?? null) },
                { name: 'P25 – P75', tooltip: { show: false }, type: 'line', stack: 'b', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: css('--accent'), opacity: 0.1 },
                  data: periods.map((p) => { const r = band.find((x) => x.period === p); return r ? r.p75_price_m2 - r.p25_price_m2 : null; }) },
                { name: 'Appartements', type: 'line', symbolSize: 4, color: SERIES_COLORS[0], data: periods.map((p) => flats.find((r) => r.period === p)?.median_price_m2 ?? null) },
                { name: 'Maisons', type: 'line', symbolSize: 4, color: SERIES_COLORS[1], data: periods.map((p) => houses.find((r) => r.period === p)?.median_price_m2 ?? null) },
              ],
            }} />
          )}
          <div className="cy-note">Bande : moitié centrale des ventes du type choisi.</div>
        </Panel>
        <Panel span={3} title={`Départements ${bestWord(false)}`} flush>{depRows.length ? top(depList(true), 'Département') : <EmptyState>—</EmptyState>}</Panel>
        <Panel span={3} title={`Départements ${worstWord(false)}`} flush>{depRows.length ? top(depList(false), 'Département') : <EmptyState>—</EmptyState>}</Panel>
        <Panel span={3} title={`Communes ${bestWord(true)}${allSizesNote}`} flush>
          {pField ? (comRows.length ? top(comList(true), 'Commune') : <EmptyState>{comLabel}</EmptyState>) : <EmptyState>Classement des communes : prix, rentabilité ou cash-flow.</EmptyState>}
        </Panel>
        <Panel span={3} title={`Communes ${worstWord(true)}${allSizesNote}`} flush>
          {pField ? (comRows.length ? top(comList(false), 'Commune') : <EmptyState>{comLabel}</EmptyState>) : <EmptyState>—</EmptyState>}
        </Panel>
        <Panel span={12} title="À propos des chiffres">
          <div className="cy-note">
            Ventes signées DVF (hors Alsace-Moselle et Mayotte), loyers d’annonce ANIL, INSEE, DPE ADEME. Classements sur les lieux
            d’au moins {RELIABLE} ventes, même type et même taille. <NavLink href="/method" navigate={navigate}>Méthode et glossaire</NavLink>
          </div>
        </Panel>
      </div>
    </Shell>
  );
}
