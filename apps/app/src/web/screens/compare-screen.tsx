'use dom';

// Comparer: 2 to 4 places side by side for the same comparable segment. Rows grouped like the Marché
// page, the best value of each row marked (direction from the KPI catalogue), price curves overlaid and
// the places on a map.
import { type ReactNode, useEffect, useState } from 'react';

import { type CommunePoint, loadCommunePoints, loadPlace } from '../../data/api';
import { catalogueEntry } from '../../data/catalogue';
import { bestIndex } from '../../data/compare';
import { alignPeriods, parsePlaces, seriesFor } from '../../data/evolution';
import {
  formatCount,
  formatDecimal,
  formatEuros,
  formatEurosPerM2,
  formatPercent,
  formatRentPerM2,
  formatSignedPercent,
} from '../../data/format';
import { latestCell, yieldFor } from '../../data/select';
import type { DwellingType, Place } from '../../data/types';
import { axisStyle, Chart, SERIES_COLORS } from '../charts/chart';
import { FilterBar, sizeLabel } from '../components/controls';
import { EmptyState, InfoTip, Panel } from '../components/panel';
import { PlaceSearch } from '../components/place-search';
import { NavLink, Shell } from '../components/shell';
import { MapCanvas } from '../maps/map-canvas';
import { useDark } from '../hooks/use-dark';
import type { ScreenProps } from '../screen-props';

const MAX = 4;

type Row = { label: string; info?: string; value: (p: Place) => number | null | undefined; format: (v: number | null | undefined) => ReactNode };
type Group = { title: string; rows: Row[] };

export default function CompareScreen({ filters, params, onFilters, onParams, navigate }: ScreenProps) {
  const refs = parsePlaces(params.places).slice(0, MAX);
  const keys = refs.map((r) => `${r.level}:${r.code}`);
  const type: DwellingType = filters.type === 'house' ? 'house' : 'apartment';
  const segment = { propertyType: type, rooms: filters.size };
  const [loaded, setLoaded] = useState<Record<string, Place | null>>({});
  const [points, setPoints] = useState<CommunePoint[] | null>(null);
  const dark = useDark();

  useEffect(() => {
    let current = true;
    for (const ref of parsePlaces(keys.join(','))) {
      loadPlace(ref.level, ref.code).then(
        (place) => current && setLoaded((prev) => ({ ...prev, [`${ref.level}:${ref.code}`]: place })),
        () => current && setLoaded((prev) => ({ ...prev, [`${ref.level}:${ref.code}`]: null })),
      );
    }
    return () => {
      current = false;
    };
  }, [keys.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    loadCommunePoints().then((t) => setPoints(t.rows), () => undefined);
  }, []);

  const places = keys.map((k) => loaded[k]).filter((p): p is Place => Boolean(p));
  // one colour per place in the URL list, whatever is still loading or failed
  const colorOf = (p: Place) => SERIES_COLORS[keys.indexOf(`${p.level}:${p.code}`) % SERIES_COLORS.length];
  const setPlaces = (next: string[]) => onParams({ places: next.length ? next.join(',') : undefined });

  const year = (p: Place) => {
    const c = latestCell(p.prices, p.latest, segment);
    return c?.basis === 'exact' ? c.row : undefined;
  };
  const rent = (p: Place) => {
    const y = year(p);
    return y ? yieldFor(p.yields, segment, y.period) : undefined;
  };
  const deal = (p: Place) => p.typical_deal?.[type]?.[filters.size];
  const eur = (v: number | null | undefined) => formatEuros(v);
  const groups: Group[] = [
    { title: 'Prix', rows: [
      { label: 'Prix médian au m²', info: 'median_price_m2', value: (p) => year(p)?.median_price_m2, format: formatEurosPerM2 },
      { label: 'Prix médian d’un bien', value: (p) => year(p)?.median_price, format: eur },
      { label: 'Sur un an', info: 'yoy_change', value: (p) => year(p)?.yoy_change, format: formatSignedPercent },
      { label: 'Moyenne / an', info: 'cagr', value: (p) => year(p)?.cagr, format: formatSignedPercent },
      { label: 'Ventes', info: 'n_sales', value: (p) => year(p)?.n_sales, format: formatCount },
    ] },
    { title: 'Loyers & rendement', rows: [
      { label: 'Loyer d’annonce', info: 'rent_m2', value: (p) => rent(p)?.rent_m2, format: formatRentPerM2 },
      { label: 'Rentabilité brute', info: 'gross_yield', value: (p) => rent(p)?.gross_yield, format: formatPercent },
      { label: 'Prix / loyer annuel', info: 'price_to_rent_years', value: (p) => rent(p)?.price_to_rent_years, format: (v) => (v == null ? '—' : `${formatDecimal(v)} ans`) },
    ] },
    { title: 'Bien type', rows: [
      { label: 'Rentabilité nette', info: 'net_yield', value: (p) => deal(p)?.net_yield, format: formatPercent },
      { label: 'Cap rate', info: 'cap_rate', value: (p) => deal(p)?.cap_rate, format: formatPercent },
      { label: 'Cash-flow mensuel', info: 'cash_flow_monthly', value: (p) => deal(p)?.cash_flow_monthly, format: (v) => (v == null ? '—' : `${Math.round(v)} €`) },
    ] },
    { title: 'Demande', rows: [
      { label: 'Population', value: (p) => p.socio?.population, format: formatCount },
      { label: 'Population / an', info: 'population_growth_yearly', value: (p) => p.socio?.population_growth_yearly, format: formatSignedPercent },
      { label: 'Emplois / an', info: 'jobs_growth_yearly', value: (p) => p.socio?.jobs_growth_yearly, format: formatSignedPercent },
      { label: 'Logements vacants', info: 'vacancy_rate', value: (p) => p.socio?.vacancy_rate, format: formatPercent },
      { label: 'Niveau de vie médian', info: 'median_living_standard', value: (p) => p.socio?.median_living_standard, format: eur },
      { label: 'Locataires', info: 'tenant_share', value: (p) => p.socio?.renter_share, format: formatPercent },
    ] },
    { title: 'Énergie, fiscalité, score', rows: [
      { label: 'Passoires F/G', info: 'share_fg', value: (p) => (p.energy?.[type] ?? p.energy?.all)?.share_fg, format: formatPercent },
      { label: 'Taux de taxe foncière', info: 'tfpb_rate', value: (p) => p.local_tax?.tfpb_rate, format: formatPercent },
      { label: 'Score de marché', info: 'score', value: (p) => p.score?.[type]?.score, format: (v) => (v == null ? '—' : `${Math.round(v)} / 100`) },
    ] },
  ];

  const curves = places.map((p) => ({ name: p.name ?? p.code, points: seriesFor(p.prices, { type, size: filters.size, condition: 'existing', periodType: 'half' }) }));
  const periods = alignPeriods(curves.map((c) => c.points.map((p) => p.period)));
  const pts = places
    .map((p, i) => ({ p, i, pt: points?.find((x) => x.code === p.code && x.type === type) }))
    .filter((x) => x.pt);
  const mapPoints = pts.length
    ? { type: 'FeatureCollection' as const, features: pts.map(({ p, i, pt }) => ({
        type: 'Feature' as const, geometry: { type: 'Point', coordinates: [pt!.lon, pt!.lat] },
        properties: { code: p.code, level: p.level, name: p.name, _fill: colorOf(p), _r: 9 } })) }
    : null;
  const bounds = pts.length
    ? ([[Math.min(...pts.map((x) => x.pt!.lon)) - 0.3, Math.min(...pts.map((x) => x.pt!.lat)) - 0.3],
        [Math.max(...pts.map((x) => x.pt!.lon)) + 0.3, Math.max(...pts.map((x) => x.pt!.lat)) + 0.3]] as [[number, number], [number, number]])
    : null;

  return (
    <Shell active="compare" title="Comparer" navigate={navigate} crumbs={[{ label: `${type === 'house' ? 'Maisons' : 'Appartements'} ${filters.size === 'all' ? '' : sizeLabel(type, filters.size)}` }]}
      filters={<FilterBar filters={filters} onFilters={onFilters} show={['type', 'size']} />}>
      <div className="cy-grid">
        <Panel span={12} title={`Lieux (${keys.length} / ${MAX})`}>
          <div className="cy-chips">
            {keys.map((k, i) => (
              <span className="cy-chip" key={k}>
                <i style={{ background: SERIES_COLORS[i] }} />
                {loaded[k]?.name ?? k}
                {loaded[k] === null && <span className="neg"> indisponible</span>}
                <button type="button" aria-label="Retirer" onClick={() => setPlaces(keys.filter((x) => x !== k))}>×</button>
              </span>
            ))}
            {keys.length < MAX && <PlaceSearch exclude={keys} placeholder="Ajouter un lieu…" onPick={(p) => setPlaces([...keys, `${p.level}:${p.code}`])} />}
          </div>
        </Panel>
        {places.length < 2 ? (
          <Panel span={12} title="Comparer des villes">
            <EmptyState>Ajoutez au moins deux lieux. Les chiffres comparent toujours le même type de bien et la même taille.</EmptyState>
          </Panel>
        ) : (
          <>
            <Panel span={12} flush>
              <div className="cy-table-wrap">
                <table className="cy-table cy-compare">
                  <thead>
                    <tr>
                      <th>Indicateur</th>
                      {places.map((p, i) => (
                        <th key={`${p.level}:${p.code}`} className="num">
                          <i style={{ background: colorOf(p) }} />
                          <NavLink href={`/place/${p.level}/${p.code}?type=${type}&size=${filters.size}`} navigate={navigate}>{p.name ?? p.code}</NavLink>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  {groups.map((g) => (
                    <tbody key={g.title}>
                      <tr className="cy-group"><td colSpan={places.length + 1}>{g.title}</td></tr>
                      {g.rows.map((row) => {
                        const values = places.map(row.value);
                        const best = bestIndex(values, row.info ? (catalogueEntry(row.info)?.higherIsBetter ?? null) : null);
                        return (
                          <tr key={row.label}>
                            <td className="ink-2">{row.label} {row.info && <InfoTip k={row.info} />}</td>
                            {values.map((v, i) => (
                              <td key={`${places[i].level}:${places[i].code}`} className={`num${best === i ? ' cy-best' : ''}`}>{row.format(v)}</td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  ))}
                </table>
              </div>
              <div className="cy-note" style={{ padding: '6px 14px' }}>Valeur soulignée : la plus favorable à l’investisseur sur la ligne (quand le sens est clair).</div>
            </Panel>
            <Panel span={8} title="Prix au m² par semestre" info="median_price_m2">
              <Chart ariaLabel="Courbes de prix des lieux comparés" height={280}
                option={{
                  grid: { left: 56, right: 16, top: 30, bottom: 28 },
                  legend: { top: 0, left: 8 },
                  xAxis: { type: 'category', data: periods, boundaryGap: false, ...axisStyle() },
                  yAxis: { type: 'value', scale: true, ...axisStyle() },
                  series: curves.map((c, i) => ({ name: c.name, type: 'line', connectNulls: true, symbolSize: 4, color: colorOf(places[i]),
                    data: periods.map((per) => c.points.find((x) => x.period === per)?.median ?? null) })),
                }} />
            </Panel>
            <Panel span={4} title="Carte" flush>
              {mapPoints && bounds ? (
                <div style={{ position: 'relative', height: 300 }}>
                  <MapCanvas polygons={null} points={mapPoints as never} dark={dark} bounds={bounds} onHover={() => undefined}
                    onClick={(p) => navigate(`/place/${String(p.level)}/${String(p.code)}?type=${type}`)} style={{ position: 'absolute', inset: 0 }} />
                </div>
              ) : (
                <EmptyState>Carte disponible pour les communes.</EmptyState>
              )}
            </Panel>
          </>
        )}
      </div>
    </Shell>
  );
}
