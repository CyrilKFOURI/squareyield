'use dom';

// Marché ③ (docs/features/017-guided-levels/spec.md): the full page of one commune or arrondissement (also used
// for a région and France) for one comparable segment. Step header, KPI ribbon and the investor bridge, then
// sections in reading order: Prix, Ventes (each building and its sales, local API only: 019), Évolution (vs the
// département and France), Arrondissements (Paris, Lyon,
// Marseille), Loyers, Demande & population, Parc & DPE, Fiscalité & score, Voisins. Read-only over the published
// place file (neighbours with their figures, own point) plus its parents, its OLL file, levels/france.json (yearly
// medians of the département and France, shared with the France page) and, for Paris / Lyon / Marseille, the
// département level file (docs/features/018-speed-and-map/spec.md: nothing heavy on page load).
import { useEffect, useState } from 'react';

import { type DepartementLevel, type FranceLevel, loadDepartementLevel, loadFranceLevel, loadOll, loadPlace } from '../../data/api';
import {
  arrondissementLabel,
  arrondissementPrefix,
  arrondissementsIn,
  cityOfArrondissement,
  compareYears,
  neighbourRows,
  yearPoints,
} from '../../data/commune-view';
import { alignPeriods, seriesFor } from '../../data/evolution';
import {
  formatCount,
  formatDecimal,
  formatEuros,
  formatEurosPerM2,
  formatPercent,
  formatPoints,
  formatRentPerM2,
  formatSignedPercent,
} from '../../data/format';
import { growth, indexTo } from '../../data/levels';
import { bandsSeries, banSchedule, CRITERION_LABELS, parentRefs } from '../../data/place-view';
import { colorFor, PALETTES } from '../../data/scales';
import { bucketsFor, EXCLUSION_REASONS, halfYearSeries, latestCell, newBuildFor, yieldFor } from '../../data/select';
import type { DwellingType, GeoLevel, Oll, Place, RoomsBucket, ScoreCriterion } from '../../data/types';
import { BarRanking, useBarControls } from '../charts/bar-ranking';
import { axisStyle, Chart, css, SERIES_COLORS } from '../charts/chart';
import { FilterBar, Segmented, sizeLabel } from '../components/controls';
import { DataTable } from '../components/data-table';
import { EmptyState, ErrorPanel, InfoTip, Panel, ReliabilityBadge, Ribbon } from '../components/panel';
import { usePlace } from '../components/place-detail';
import { SalesSection } from '../components/sales-section';
import { NavLink, Shell } from '../components/shell';
import { MarketSteps } from '../components/steps';
import { MapCanvas } from '../maps/map-canvas';
import { useDark } from '../hooks/use-dark';
import type { ScreenProps } from '../screen-props';

const LEVEL_LABELS: Record<GeoLevel, string> = {
  france: 'Pays',
  region: 'Région',
  departement: 'Département',
  commune: 'Commune',
  arrondissement: 'Arrondissement',
};
const RENT_LEVELS = {
  commune: 'commune',
  epci: 'intercommunalité',
  maille: 'maille ANIL',
  aggregate: 'agrégé',
} as const;
type SectionId = 'prix' | 'ventes' | 'evolution' | 'arrondissements' | 'loyers' | 'demande' | 'parc' | 'fiscalite' | 'voisins';
const SECTIONS: [SectionId, string][] = [
  ['prix', 'Prix'],
  ['ventes', 'Ventes'],
  ['evolution', 'Évolution'],
  ['arrondissements', 'Arrondissements'],
  ['loyers', 'Loyers'],
  ['demande', 'Demande & population'],
  ['parc', 'Parc & DPE'],
  ['fiscalite', 'Fiscalité & score'],
  ['voisins', 'Voisins'],
];
const DPE_COLORS = ['#2f8a4f', '#58a35a', '#a7c957', '#e9d758', '#f2b04a', '#e3793b', '#c8412f'];

const tone = (v: number | null | undefined) => (v == null ? undefined : v >= 0 ? 'pos' : 'neg');
const Kv = ({ rows }: { rows: [string, string, string?][] }) => (
  <table className="cy-table">
    <tbody>
      {rows.map(([label, value, info]) => (
        <tr key={label}>
          <td className="ink-2">
            {label} {info && <InfoTip k={info} />}
          </td>
          <td className="num">{value}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

/** Full-width band that opens a section of the page (anchor target). */
const SectionTitle = ({ id, children }: { id: SectionId; children: string }) => (
  <h2 id={id} className="cy-search-group" style={{ gridColumn: 'span 12', margin: 0, padding: '10px 14px 6px', scrollMarginTop: 8 }}>
    {children}
  </h2>
);

/** Market link of a territory: départements and France have their own level pages. */
const placeHref = (level: GeoLevel, code: string, query: string) =>
  level === 'france' ? `/?${query}` : level === 'departement' ? `/departement/${code}?${query}` : `/place/${level}/${code}?${query}`;

export default function PlaceScreen({ filters, params, onFilters, onParams, navigate }: ScreenProps) {
  const level = filters.level;
  const code = filters.code;
  const { place, error, notFound, loading, retry } = usePlace(level, code);
  if (notFound) {
    return (
      <Shell active="market" title="Marché" navigate={navigate} crumbs={[{ label: 'France', href: '/' }]}>
        <EmptyState>Pas de ventes publiées pour ce lieu : moins de 10 ventes par an, ou territoire hors DVF (Alsace-Moselle, Mayotte).</EmptyState>
      </Shell>
    );
  }
  if (error) {
    return (
      <Shell active="market" title="Marché" navigate={navigate} crumbs={[{ label: 'France', href: '/' }]}>
        <ErrorPanel message={`Fiche indisponible : ${error}`} onRetry={retry} />
      </Shell>
    );
  }
  if (loading || !place) {
    return (
      <Shell active="market" title="Marché" navigate={navigate} crumbs={[{ label: 'France', href: '/' }]}>
        <EmptyState>Chargement…</EmptyState>
      </Shell>
    );
  }
  return <PlaceDashboard place={place} filters={filters} params={params} onFilters={onFilters} onParams={onParams} navigate={navigate} />;
}

const PlaceDashboard = ({
  place,
  filters,
  params,
  onFilters,
  onParams,
  navigate,
}: Pick<ScreenProps, 'filters' | 'params' | 'onFilters' | 'onParams' | 'navigate'> & {
  place: Place;
}) => {
  const type: DwellingType = filters.type === 'house' ? 'house' : 'apartment';
  const size: RoomsBucket = filters.size;
  const segment = { propertyType: type, rooms: size };
  const cell = latestCell(place.prices, place.latest, segment);
  const year = cell?.row;
  const rent = year && cell?.basis === 'exact' ? yieldFor(place.yields, segment, year.period) : undefined;
  const deal = place.typical_deal?.[type]?.[size];
  const score = place.score?.[type];
  const typeLabel = type === 'house' ? 'maisons' : 'appartements';
  const segLabel = `${typeLabel}${size === 'all' ? '' : ` ${sizeLabel(type, size)}`}`;
  const name = place.name ?? place.code;
  const pop = place.socio?.population;
  const commune = place.level === 'commune' || place.level === 'arrondissement';
  const city = place.level === 'arrondissement' ? cityOfArrondissement(place.code) : null;
  const arrPrefix = place.level === 'commune' ? arrondissementPrefix(place.code) : null;

  const [parents, setParents] = useState<Place[]>([]);
  const [oll, setOll] = useState<Oll | null>(null);
  // undefined = loading, null = unavailable
  const [franceLevel, setFranceLevel] = useState<FranceLevel | null | undefined>(undefined);
  const [depLevel, setDepLevel] = useState<DepartementLevel | null | undefined>(undefined);
  const [indexed, setIndexed] = useState(false);
  const bars = useBarControls('code', null, [5, 10]);
  const dark = useDark();

  useEffect(() => {
    let current = true;
    Promise.all(parentRefs(place).map((ref) => loadPlace(ref.level, ref.code).catch(() => null))).then(
      (list) => current && setParents(list.filter((p): p is Place => p != null)),
    );
    if (place.oll) {
      loadOll(place.oll.agglo_code).then(
        (data) => current && setOll(data),
        () => undefined,
      );
    }
    // yearly medians of the département and France for the comparison curve (≈ 100 KB, cached across pages)
    loadFranceLevel().then(
      (data) => current && setFranceLevel(data),
      () => current && setFranceLevel(null),
    );
    if (place.level === 'commune' && arrondissementPrefix(place.code) && place.departement) {
      loadDepartementLevel(place.departement).then(
        (data) => current && setDepLevel(data),
        () => current && setDepLevel(null),
      );
    }
    return () => {
      current = false;
    };
  }, [place]);

  const depPlace = parents.find((p) => p.level === 'departement');
  const depName = depPlace?.name ?? (place.departement ? `Département ${place.departement}` : null);
  const query = `type=${type}&size=${size}`;

  // ---- prix
  const halves = halfYearSeries(place.prices, segment);
  const buckets = bucketsFor(type);
  const sizeRows = buckets.map((bucket) => {
    const c = latestCell(place.prices, place.latest, {
      propertyType: type,
      rooms: bucket,
    });
    const row = c?.basis === 'exact' ? c.row : undefined;
    return {
      bucket,
      row,
      rent: row ? yieldFor(place.yields, { propertyType: type, rooms: bucket }, row.period) : undefined,
      deal: place.typical_deal?.[type]?.[bucket],
    };
  });
  // new builds are published for all sizes only: compare them with the all-sizes existing row
  const allSizes = latestCell(place.prices, place.latest, { propertyType: type, rooms: 'all' })?.row;
  const newRow = allSizes ? newBuildFor(place.prices, { propertyType: type, rooms: 'all' }, allSizes.period) : undefined;
  const bands = bandsSeries(place.price_bands, type);

  // ---- territoire (same segment, latest complete year)
  const chain = [place, ...parents].map((p) => {
    const c = latestCell(p.prices, p.latest, segment);
    const y = c?.basis === 'exact' ? c.row : undefined;
    return {
      key: `${p.level}:${p.code}`,
      name: p.name ?? p.code,
      level: p.level,
      code: p.code,
      price: y?.median_price_m2 ?? null,
      yoy: y?.yoy_change ?? null,
      cagr: y?.cagr ?? null,
      gross: y ? (yieldFor(p.yields, segment, y.period)?.gross_yield ?? null) : null,
      cash: p.typical_deal?.[type]?.[size]?.cash_flow_monthly ?? null,
      n: y?.n_sales ?? null,
    };
  });
  const francePrice = chain.find((r) => r.level === 'france')?.price ?? null;
  const franceIndex = place.level === 'france' ? null : indexTo(year?.median_price_m2, francePrice);

  // ---- évolution: yearly medians, existing dwellings, all sizes, complete years only
  const ownPoints = seriesFor(place.prices, { type, size: 'all', condition: 'existing', periodType: 'year' }).map((p) => ({
    period: p.period,
    median: p.median,
  }));
  const levelType = franceLevel?.types[type];
  const refs = parentRefs(place);
  const depRef = refs.find((ref) => ref.level === 'departement');
  const depMedians = depRef ? levelType?.rows.find((r) => r.code === depRef.code)?.medians : undefined;
  const parentCurves = [
    ...(depRef && depMedians ? [{ level: 'departement' as const, code: depRef.code, medians: depMedians }] : []),
    ...(refs.some((ref) => ref.level === 'france') && levelType
      ? [{ level: 'france' as const, code: 'FR', medians: levelType.france.medians }]
      : []),
  ].map((c) => ({ ...c, points: yearPoints(franceLevel?.years ?? [], c.medians) }));
  const curveLines = [
    { name, points: ownPoints },
    ...parentCurves
      .filter((c) => c.points.length > 0)
      // Paris is both a commune and a département: names must stay distinct (legend, keys)
      .map((c) => ({ name: c.level === 'france' ? 'France' : `${depName ?? 'Département'} (${c.code})`, points: c.points })),
  ];
  const curveYears = alignPeriods(curveLines.map((l) => l.points.map((p) => p.period)));
  const curveValues = compareYears(curveLines, curveYears, indexed);
  const curveRaw = compareYears(curveLines, curveYears, false);

  // ---- arrondissements (Paris, Lyon, Marseille)
  // the département level file is size 'all' only
  const arrList = arrPrefix && depLevel ? arrondissementsIn(depLevel.types[type]?.communes ?? [], place.code) : [];
  const openArr = (arrCode: string) => navigate(`/place/arrondissement/${arrCode}?${query}`);

  // ---- voisins
  // figures of the neighbours ride in the place file (latest year, all sizes); "vs ici" compares with the same cell here
  const neighbours = neighbourRows(place.neighbours, type);
  const selfPrice = allSizes?.median_price_m2 ?? null;
  const neighbourPrices = neighbours
    .map((n) => n.price)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const quint =
    neighbourPrices.length >= 5 ? [0.2, 0.4, 0.6, 0.8].map((q) => neighbourPrices[Math.floor(q * neighbourPrices.length)]) : [];
  const mapped = [
    ...neighbours.filter((n) => n.lon != null && n.lat != null),
    ...(place.point
      ? [{ code: place.code, name, level: place.level, lon: place.point[0], lat: place.point[1], n: allSizes?.n_sales ?? null, price: selfPrice }]
      : []),
  ];
  const miniPoints =
    mapped.length > 0
      ? {
          type: 'FeatureCollection' as const,
          features: mapped.map((p) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point', coordinates: [p.lon as number, p.lat as number] },
            properties: {
              code: p.code,
              name: p.name,
              level: p.level ?? place.level,
              type,
              n: p.n,
              median_price_m2: p.price,
              _fill:
                p.code === place.code
                  ? css('--ink-1')
                  : p.price == null
                    ? css('--line-strong')
                    : colorFor(p.price, quint, 'rdylgn', false),
              _r: p.code === place.code ? 8 : 5 + Math.min(6, Math.sqrt(p.n ?? 0) / 6),
            },
          })),
        }
      : null;
  const miniBounds =
    miniPoints && miniPoints.features.length
      ? (() => {
          const xs = miniPoints.features.map((f) => f.geometry.coordinates[0] as number);
          const ys = miniPoints.features.map((f) => f.geometry.coordinates[1] as number);
          return [
            [Math.min(...xs) - 0.02, Math.min(...ys) - 0.02],
            [Math.max(...xs) + 0.02, Math.max(...ys) + 0.02],
          ] as [[number, number], [number, number]];
        })()
      : null;

  // ---- OLL
  const ollRows = (oll?.rows ?? []).filter((r) => r.property_type === type && r.period_built === 'all' && r.tenancy === 'all');
  const ollYear = ollRows.reduce((max, r) => Math.max(max, r.year), 0);
  const ollLatest = ollRows.filter((r) => r.year === ollYear).sort((a, b) => a.rooms.localeCompare(b.rooms));
  const ollTrend = ollRows.filter((r) => r.rooms === 'all').sort((a, b) => a.year - b.year);

  const energy = place.energy?.[type] ?? place.energy?.all;
  const crumbs = [
    { label: 'France', href: `/?type=${type}` },
    ...(place.departement && depName ? [{ label: `${depName} (${place.departement})`, href: `/departement/${place.departement}?type=${type}` }] : []),
    ...(city ? [{ label: city.name, href: `/place/commune/${city.code}?${query}` }] : []),
    ...(place.level !== 'france' ? [{ label: name }] : []),
  ];
  const href = (path: string) => `${path}${path.includes('?') ? '&' : '?'}type=${type}`;
  const simulatorHref = href(`/simulator?level=${place.level}&code=${place.code}`);
  const sections = SECTIONS.filter(
    ([id]) => (id !== 'voisins' || neighbours.length > 0) && (id !== 'arrondissements' || arrPrefix) && (id !== 'ventes' || commune),
  );

  return (
    <Shell
      active="market"
      title={name}
      navigate={navigate}
      crumbs={crumbs}
      steps={
        <MarketSteps
          navigate={navigate}
          type={type}
          departement={place.departement ? { code: place.departement, name: depPlace?.name ?? place.departement } : null}
          commune={commune ? { code: place.code, name, level: place.level as 'commune' | 'arrondissement' } : null}
        />
      }
      tools={
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <NavLink className="cy-button ghost" href={href(`/compare?places=${place.level}:${place.code}`)} navigate={navigate}>
            Comparer
          </NavLink>
          <NavLink className="cy-button ghost" href={href(`/evolution?places=${place.level}:${place.code}`)} navigate={navigate}>
            Courbes
          </NavLink>
        </div>
      }
      filters={<FilterBar filters={filters} onFilters={onFilters} show={['type', 'size']} />}>
      <div className="cy-grid">
        <Panel span={12} flush>
          <div className="cy-place-head">
            <span className="ink-3">
              {LEVEL_LABELS[place.level]} · {place.code}
              {pop != null && ` · ${formatCount(pop)} habitants`}
              {year && ` · ventes ${year.period}`}
            </span>
            {city && (
              <NavLink className="cy-tag" href={`/place/commune/${city.code}?${query}`} navigate={navigate}>
                ← Toute la ville : {city.name}
              </NavLink>
            )}
            {place.rent_control && <span className="cy-tag warn">Loyers encadrés</span>}
            {place.socio?.flag_high_vacancy && <span className="cy-tag warn">Vacance élevée</span>}
            {place.socio?.flag_population_decline && <span className="cy-tag warn">Population en baisse</span>}
            {cell?.basis === 'all_sizes' && <span className="cy-tag">Taille peu vendue : chiffres toutes tailles</span>}
          </div>
          <Ribbon
            items={[
              {
                label: `Prix ${segLabel}`,
                value: formatEurosPerM2(year?.median_price_m2),
                info: 'median_price_m2',
                detail: year
                  ? `${formatEurosPerM2(year.p25_price_m2)} – ${formatEurosPerM2(year.p75_price_m2)}`
                  : 'pas assez de ventes',
              },
              ...(place.level !== 'france'
                ? [
                    {
                      label: 'Indice France = 100',
                      value: franceIndex == null ? '—' : formatCount(franceIndex),
                      info: 'france_index',
                      detail: francePrice != null ? `France ${formatEurosPerM2(francePrice)}` : undefined,
                    },
                  ]
                : []),
              {
                label: 'Sur un an',
                value: formatSignedPercent(year?.yoy_change),
                info: 'yoy_change',
              },
              {
                label: 'Moyenne / an',
                value: formatSignedPercent(year?.cagr),
                info: 'cagr',
                detail: year?.cagr_since ? `depuis ${year.cagr_since}` : undefined,
              },
              {
                label: 'Loyer d’annonce',
                value: formatRentPerM2(rent?.rent_m2),
                info: 'rent_m2',
                detail: rent ? `pour ${Math.round(rent.rent_surface_m2)} m²` : undefined,
              },
              {
                label: 'Rentabilité brute',
                value: rent?.status === 'excluded' ? 'exclue' : formatPercent(rent?.gross_yield),
                info: 'gross_yield',
              },
              {
                label: 'Rdt net (bien type)',
                value: formatPercent(deal?.net_yield),
                info: 'net_yield',
              },
              {
                label: 'Cash-flow (bien type)',
                value: deal ? `${Math.round(deal.cash_flow_monthly)} €/mois` : '—',
                info: 'cash_flow_monthly',
                tone: deal ? tone(deal.cash_flow_monthly) : undefined,
              },
              {
                label: 'Score',
                value: score ? `${Math.round(score.score)} / 100` : '—',
                info: 'score',
              },
              {
                label: 'Ventes',
                value: formatCount(year?.n_sales),
                info: 'n_sales',
                detail: year?.reliability === 'low' ? 'fiabilité faible' : undefined,
                tone: year?.reliability === 'low' ? 'warn' : undefined,
              },
            ]}
          />
          {/* the one bridge to the Investir path (spec principle 5) */}
          <div className="cy-filter-label" style={{ padding: '8px 14px 6px', borderTop: '1px solid var(--line)' }}>
            Voir sous l’angle investisseur
          </div>
          <div className="cy-paths" style={{ borderWidth: '1px 0 0' }}>
            <NavLink href={href(place.departement ? `/investir?dep=${place.departement}` : '/investir')} navigate={navigate}>
              <b>{place.departement ? 'Trouver où investir dans ce département' : 'Trouver où investir'}</b>
              <span>
                {place.departement && depName ? `Communes de ${depName}` : 'Communes'} classées par rendement, cash-flow et risques
              </span>
            </NavLink>
            <NavLink href={simulatorHref} navigate={navigate}>
              <b>Simuler un achat ici</b>
              <span>Crédit, fiscalité et revente au prix médian {commune ? `de ${name}` : 'du territoire'}</span>
            </NavLink>
            {commune && (
              <NavLink href={`/property?commune=${place.code}`} navigate={navigate}>
                <b>Analyser un bien ici</b>
                <span>Prix juste, loyer et risques d’une annonce</span>
              </NavLink>
            )}
          </div>
          <nav className="cy-anchors" aria-label="Sections">
            {sections.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                onClick={(e) => {
                  // a bare #anchor does not scroll .cy-content inside the DOM component: scroll to the section ourselves
                  e.preventDefault();
                  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                {label}
              </a>
            ))}
          </nav>
        </Panel>

        {/* ================ Prix */}
        <SectionTitle id="prix">Prix</SectionTitle>
        <Panel span={8} title={`Prix au m² par semestre · ${segLabel}`} info="median_price_m2">
          {halves.length < 2 ? (
            <EmptyState>Pas de série semestrielle publiée pour ce segment.</EmptyState>
          ) : (
            <Chart
              ariaLabel="Évolution du prix médian au m² par semestre"
              height={260}
              option={{
                grid: { left: 56, right: 16, top: 24, bottom: 28 },
                legend: { top: 0, right: 8, data: ['Médiane', 'P25 – P75'] },
                xAxis: {
                  type: 'category',
                  data: halves.map((r) => r.period),
                  boundaryGap: false,
                  ...axisStyle(),
                },
                yAxis: { type: 'value', scale: true, ...axisStyle() },
                series: [
                  {
                    name: 'P25',
                    type: 'line',
                    stack: 'b',
                    symbol: 'none',
                    lineStyle: { opacity: 0 },
                    data: halves.map((r) => r.p25_price_m2),
                    tooltip: { show: false },
                  },
                  {
                    name: 'P25 – P75', tooltip: { show: false },
                    type: 'line',
                    stack: 'b',
                    symbol: 'none',
                    lineStyle: { opacity: 0 },
                    areaStyle: { color: css('--accent'), opacity: 0.12 },
                    data: halves.map((r) => r.p75_price_m2 - r.p25_price_m2),
                  },
                  {
                    name: 'Médiane',
                    type: 'line',
                    data: halves.map((r) => Math.round(r.median_price_m2)),
                    symbolSize: 4,
                    color: SERIES_COLORS[0],
                  },
                ],
              }}
            />
          )}
          <div className="cy-note">Bande : moitié centrale des ventes (P25 – P75).</div>
        </Panel>
        <Panel span={4} title={`Ancien et neuf · ${typeLabel} toutes tailles`} info="new_premium">
          <Kv
            rows={[
              ['Ancien · médiane', formatEurosPerM2(allSizes?.median_price_m2)],
              ['Neuf (VEFA) · médiane', formatEurosPerM2(newRow?.median_price_m2)],
              ['Ventes dans le neuf', newRow ? formatCount(newRow.n_sales) : 'moins de 10'],
              ['Surcoût du neuf', formatSignedPercent(allSizes?.new_premium), 'new_premium'],
              ['Prix médian d’un bien', formatEuros(allSizes?.median_price)],
              ['Surface médiane', allSizes?.median_surface_m2 ? `${Math.round(allSizes.median_surface_m2)} m²` : '—'],
              ...(type === 'house'
                ? ([
                    ['Terrain médian', allSizes?.median_land_m2 ? `${formatCount(Math.round(allSizes.median_land_m2))} m²` : '—'],
                    ['Avec dépendance', formatPercent(allSizes?.share_with_outbuilding)],
                  ] as [string, string][])
                : []),
            ]}
          />
        </Panel>
        <Panel span={7} title={`Par taille · ${typeLabel} · ${year?.period ?? ''}`} flush>
          <DataTable
            rows={sizeRows}
            rowKey={(r) => r.bucket}
            selected={size}
            onRowClick={(r) => onFilters({ size: r.bucket })}
            columns={[
              {
                key: 'size',
                label: 'Taille',
                render: (r) => sizeLabel(type, r.bucket),
              },
              {
                key: 'm2',
                label: '€/m²',
                numeric: true,
                render: (r) => formatEurosPerM2(r.row?.median_price_m2),
              },
              {
                key: 'band',
                label: 'P25 – P75',
                numeric: true,
                render: (r) => (r.row ? `${Math.round(r.row.p25_price_m2)} – ${Math.round(r.row.p75_price_m2)}` : '—'),
              },
              {
                key: 'price',
                label: 'Prix médian',
                numeric: true,
                render: (r) => formatEuros(r.row?.median_price),
              },
              {
                key: 'surface',
                label: 'Surface',
                numeric: true,
                render: (r) => (r.row?.median_surface_m2 ? `${Math.round(r.row.median_surface_m2)} m²` : '—'),
              },
              ...(type === 'house'
                ? [
                    {
                      key: 'land',
                      label: 'Terrain',
                      numeric: true,
                      render: (r: (typeof sizeRows)[number]) =>
                        r.row?.median_land_m2 ? `${formatCount(Math.round(r.row.median_land_m2))} m²` : '—',
                    },
                    {
                      key: 'out',
                      label: 'Dépend.',
                      numeric: true,
                      render: (r: (typeof sizeRows)[number]) => formatPercent(r.row?.share_with_outbuilding),
                    },
                  ]
                : []),
              {
                key: 'yoy',
                label: '1 an',
                numeric: true,
                render: (r) => <span className={tone(r.row?.yoy_change)}>{formatSignedPercent(r.row?.yoy_change)}</span>,
              },
              {
                key: 'n',
                label: 'Ventes',
                numeric: true,
                render: (r) =>
                  r.row ? (
                    <>
                      {formatCount(r.row.n_sales)} <ReliabilityBadge n={r.row.n_sales} />
                    </>
                  ) : (
                    'moins de 10'
                  ),
              },
            ]}
          />
        </Panel>
        <Panel span={5} title="Tranches de prix des ventes" info="price_bands">
          {bands.years.length === 0 ? (
            <EmptyState>Pas de tranches publiées.</EmptyState>
          ) : (
            <Chart
              ariaLabel="Répartition des ventes par tranche de prix et par année"
              height={230}
              option={{
                grid: { left: 40, right: 8, top: 30, bottom: 24 },
                legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 8 },
                tooltip: {
                  trigger: 'axis',
                  valueFormatter: (v: number) => formatPercent(v),
                },
                xAxis: { type: 'category', data: bands.years, ...axisStyle() },
                yAxis: {
                  type: 'value',
                  max: 1,
                  ...axisStyle(),
                  axisLabel: {
                    ...axisStyle().axisLabel,
                    formatter: (v: number) => `${Math.round(v * 100)} %`,
                  },
                },
                series: bands.labels.map((label, i) => ({
                  name: label,
                  type: 'bar',
                  stack: 'bands',
                  data: bands.shares[i],
                  barWidth: '55%',
                  color: PALETTES.sequential[Math.min(i, PALETTES.sequential.length - 1)],
                })),
              }}
            />
          )}
        </Panel>

        {/* ================ Ventes (communes and arrondissements; local API) */}
        {commune && (
          <>
            <SectionTitle id="ventes">Ventes</SectionTitle>
            <SalesSection
              code={place.code}
              name={name}
              pageType={type}
              palette={filters.palette}
              params={params}
              onParams={onParams}
              navigate={navigate}
            />
          </>
        )}

        {/* ================ Évolution */}
        <SectionTitle id="evolution">Évolution</SectionTitle>
        <Panel
          span={8}
          title={`Prix médian par année · ${typeLabel} toutes tailles${indexed ? ' · base 100' : ''}`}
          info="median_price_m2"
          tools={
            <Segmented
              label="Échelle"
              options={[
                { value: 'eur', label: '€/m²' },
                { value: '100', label: 'Base 100' },
              ]}
              value={indexed ? '100' : 'eur'}
              onChange={(v) => setIndexed(v === '100')}
            />
          }>
          {curveYears.length < 2 ? (
            <EmptyState>
              {franceLevel === undefined ? 'Chargement…' : 'Pas assez d’années complètes publiées pour ce segment.'}
            </EmptyState>
          ) : (
            <Chart
              ariaLabel={`Prix médian au m² par année : ${curveLines.map((l) => l.name).join(', ')}`}
              height={260}
              option={{
                grid: { left: 56, right: 16, top: 28, bottom: 28 },
                legend: { top: 0, left: 8, data: curveValues.map((l) => l.name) },
                tooltip: {
                  trigger: 'axis',
                  valueFormatter: (v: number) => (indexed ? formatDecimal(v) : formatEurosPerM2(v)),
                },
                xAxis: { type: 'category', data: curveYears, boundaryGap: false, ...axisStyle() },
                yAxis: { type: 'value', scale: true, ...axisStyle() },
                series: curveValues.map((l, i) => ({
                  name: l.name,
                  type: 'line',
                  data: l.values,
                  connectNulls: true,
                  symbolSize: 5,
                  lineStyle: { width: i === 0 ? 2.5 : 1.5, type: i === 0 ? 'solid' : 'dashed' },
                  color: SERIES_COLORS[i % SERIES_COLORS.length],
                })),
              }}
            />
          )}
          <div className="cy-note">
            Ventes de logements anciens, toutes tailles ; années complètes seulement (les années à un seul semestre sont
            écartées). Base 100 : première année commune aux courbes.
          </div>
        </Panel>
        <Panel span={4} title="Sur la période" info="growth_5y">
          <Kv
            rows={curveRaw.map((l) => {
              const known = l.values.filter((v): v is number => v != null);
              const first = curveYears[l.values.findIndex((v) => v != null)];
              return [
                l.name,
                known.length >= 2 ? `${formatSignedPercent(growth(l.values))} depuis ${first}` : '—',
              ] as [string, string];
            })}
          />
          <div className="cy-note" style={{ marginTop: 6 }}>
            Indice France = 100 (dernière année, {segLabel}) : {franceIndex == null ? '—' : formatCount(franceIndex)}.
          </div>
        </Panel>
        <Panel span={7} title={`Comparé aux territoires · ${segLabel}`} flush>
          <DataTable
            rows={chain}
            rowKey={(r) => r.key}
            selected={`${place.level}:${place.code}`}
            onRowClick={(r) =>
              r.key !== `${place.level}:${place.code}` && navigate(placeHref(r.level, r.code, query))
            }
            columns={[
              {
                key: 'name',
                label: 'Territoire',
                render: (r) => `${r.name} (${LEVEL_LABELS[r.level].toLowerCase()})`,
              },
              {
                key: 'price',
                label: '€/m²',
                numeric: true,
                render: (r) => formatEurosPerM2(r.price),
              },
              {
                key: 'yoy',
                label: '1 an',
                numeric: true,
                render: (r) => formatSignedPercent(r.yoy),
              },
              {
                key: 'cagr',
                label: 'Moy. / an',
                numeric: true,
                render: (r) => formatSignedPercent(r.cagr),
              },
              {
                key: 'gross',
                label: 'Rdt brut',
                numeric: true,
                render: (r) => formatPercent(r.gross),
              },
              {
                key: 'cash',
                label: 'Cash-flow type',
                numeric: true,
                render: (r) => (r.cash == null ? '—' : `${Math.round(r.cash)} €`),
              },
              {
                key: 'n',
                label: 'Ventes',
                numeric: true,
                render: (r) => formatCount(r.n),
              },
            ]}
          />
        </Panel>
        <Panel span={5} title="Prix au m² comparé">
          <Chart
            ariaLabel="Prix au m² du lieu et de ses territoires"
            height={Math.max(120, chain.length * 38)}
            option={{
              grid: { left: 110, right: 40, top: 8, bottom: 20 },
              tooltip: {
                trigger: 'axis',
                valueFormatter: (v: number) => formatEurosPerM2(v),
              },
              xAxis: { type: 'value', ...axisStyle() },
              yAxis: {
                type: 'category',
                inverse: true,
                data: chain.map((r) => r.name),
                ...axisStyle(),
              },
              series: [
                {
                  type: 'bar',
                  barWidth: '50%',
                  label: {
                    show: true,
                    position: 'right',
                    fontSize: 11,
                    color: css('--ink-2'),
                    formatter: (p: { value: number }) => (p.value ? `${Math.round(p.value)}` : ''),
                  },
                  data: chain.map((r, i) => ({
                    value: r.price,
                    itemStyle: {
                      color: i === 0 ? css('--accent') : css('--line-strong'),
                    },
                  })),
                },
              ],
            }}
          />
        </Panel>


        {/* ================ Arrondissements (Paris, Lyon, Marseille) */}
        {arrPrefix && (
          <>
            <SectionTitle id="arrondissements">{`Arrondissements de ${name}`}</SectionTitle>
            <Panel
              span={7}
              title={`Prix médian par arrondissement · ${typeLabel} toutes tailles`}
              info="median_price_m2"
              tools={bars.controls}>
              {depLevel === undefined ? (
                <EmptyState>Chargement…</EmptyState>
              ) : arrList.length === 0 ? (
                <EmptyState>Pas d’arrondissement publié pour ce segment (moins de 10 ventes).</EmptyState>
              ) : (
                <BarRanking
                  items={arrList.map((r) => ({
                    code: r.code,
                    label: arrondissementLabel(r.name),
                    value: r.price,
                    detail: `${formatCount(r.n)} ventes · ${formatSignedPercent(r.yoy)} sur un an`,
                  }))}
                  metricLabel="Prix médian au m²"
                  format={(v) => formatEurosPerM2(v)}
                  onPick={openArr}
                  reference={{ label: name, value: allSizes?.median_price_m2 ?? null }}
                  sort={bars.sort}
                  top={bars.top}
                  height={280}
                />
              )}
              <div className="cy-note">
                Cliquez une barre pour ouvrir l’arrondissement. Pointillés : {name} entière.
                {size !== 'all' && ` Chiffres toutes tailles : la taille ${sizeLabel(type, size)} n’est pas détaillée par arrondissement ici.`}
              </div>
            </Panel>
            <Panel span={5} title={`Les ${arrList.length || ''} arrondissements`} flush>
              <DataTable
                rows={arrList}
                rowKey={(r) => r.code}
                onRowClick={(r) => openArr(r.code)}
                maxHeight={330}
                empty={<EmptyState>—</EmptyState>}
                columns={[
                  { key: 'name', label: 'Arrondissement', render: (r) => arrondissementLabel(r.name) },
                  { key: 'm2', label: '€/m²', numeric: true, render: (r) => formatEurosPerM2(r.price) },
                  {
                    key: 'yoy',
                    label: '1 an',
                    numeric: true,
                    render: (r) => <span className={tone(r.yoy)}>{formatSignedPercent(r.yoy)}</span>,
                  },
                  { key: 'gross', label: 'Rdt brut', numeric: true, render: (r) => formatPercent(r.yield) },
                  { key: 'n', label: 'Ventes', numeric: true, render: (r) => formatCount(r.n) },
                ]}
              />
            </Panel>
          </>
        )}

        {/* ================ Loyers */}
        <SectionTitle id="loyers">Loyers</SectionTitle>
        <Panel span={8} title={`Loyers d’annonce et rentabilité · ${typeLabel}`} info="rent_m2" flush>
          <DataTable
            rows={sizeRows}
            rowKey={(r) => r.bucket}
            selected={size}
            columns={[
              {
                key: 'size',
                label: 'Taille',
                render: (r) => sizeLabel(type, r.bucket),
              },
              {
                key: 'rent',
                label: 'Loyer €/m²',
                numeric: true,
                render: (r) => formatRentPerM2(r.rent?.rent_m2),
              },
              {
                key: 'interval',
                label: 'Intervalle',
                numeric: true,
                render: (r) => (r.rent ? `${formatDecimal(r.rent.rent_low_m2)} – ${formatDecimal(r.rent.rent_high_m2)}` : '—'),
              },
              {
                key: 'surface',
                label: 'Pour',
                numeric: true,
                render: (r) => (r.rent ? `${Math.round(r.rent.rent_surface_m2)} m²` : '—'),
              },
              {
                key: 'level',
                label: 'Niveau',
                render: (r) => (r.rent ? `${RENT_LEVELS[r.rent.rent_level]}${r.rent.rent_caution ? ' · prudence' : ''}` : '—'),
              },
              {
                key: 'gross',
                label: 'Rdt brut',
                numeric: true,
                render: (r) =>
                  r.rent?.status === 'excluded' ? (
                    <span className="ink-3" title={EXCLUSION_REASONS[r.rent.reason!]}>
                      exclu
                    </span>
                  ) : (
                    formatPercent(r.rent?.gross_yield)
                  ),
              },
              {
                key: 'ptr',
                label: 'Prix / loyer',
                numeric: true,
                render: (r) => (r.rent?.price_to_rent_years ? `${formatDecimal(r.rent.price_to_rent_years)} ans` : '—'),
              },
            ]}
          />
          {sizeRows.some((r) => r.rent?.status === 'excluded') && (
            <div className="cy-note" style={{ padding: '6px 14px' }}>
              Exclu :{' '}
              {[
                ...new Set(sizeRows.filter((r) => r.rent?.status === 'excluded').map((r) => EXCLUSION_REASONS[r.rent!.reason!])),
              ].join(' ; ')}
              .
            </div>
          )}
          <div className="cy-note" style={{ padding: '6px 14px' }}>
            Loyers d’annonce ANIL charges comprises, lus à la surface médiane des ventes de la taille
            {type === 'house' ? ' (maisons : approximation à partir de la courbe des appartements)' : ''}.
          </div>
        </Panel>
        <Panel span={4} title={`Loyers en place (OLL)${oll ? ` · ${oll.agglomeration}` : ''}`} info="oll">
          {!place.oll ? (
            <EmptyState>Pas d’observatoire local des loyers ici.</EmptyState>
          ) : ollLatest.length === 0 ? (
            <EmptyState>Chargement…</EmptyState>
          ) : (
            <>
              <Kv
                rows={ollLatest.map((r) => [
                  `${r.rooms === 'all' ? 'Toutes tailles' : r.rooms === '1' ? '1 pièce' : `${r.rooms} pièces`} · ${r.year}`,
                  formatRentPerM2(r.rent_m2_median),
                ])}
              />
              {ollTrend.length > 1 && (
                <Chart
                  ariaLabel="Loyer médian en place par année"
                  height={120}
                  option={{
                    grid: { left: 36, right: 8, top: 8, bottom: 20 },
                    xAxis: {
                      type: 'category',
                      data: ollTrend.map((r) => String(r.year)),
                      ...axisStyle(),
                    },
                    yAxis: { type: 'value', scale: true, ...axisStyle() },
                    series: [
                      {
                        type: 'line',
                        data: ollTrend.map((r) => r.rent_m2_median),
                        symbol: 'none',
                        color: SERIES_COLORS[1],
                      },
                    ],
                  }}
                />
              )}
            </>
          )}
        </Panel>

        <Panel span={12} title={`Rentabilité d’un bien type · ${typeLabel}`} info="cash_flow_monthly" flush>
          <DataTable
            rows={sizeRows.filter((r) => r.deal)}
            rowKey={(r) => r.bucket}
            selected={size}
            empty={<EmptyState>Pas de bien type publié (prix ou loyer manquant).</EmptyState>}
            columns={[
              {
                key: 'size',
                label: 'Taille',
                render: (r) => sizeLabel(type, r.bucket),
              },
              {
                key: 'price',
                label: 'Prix',
                numeric: true,
                render: (r) => formatEuros(r.deal!.price),
              },
              {
                key: 'surface',
                label: 'Surface',
                numeric: true,
                render: (r) => `${Math.round(r.deal!.surface_m2)} m²`,
              },
              {
                key: 'cost',
                label: 'Coût total',
                numeric: true,
                info: 'total_cost',
                render: (r) => formatEuros(r.deal!.total_cost),
              },
              {
                key: 'rent',
                label: 'Loyer / mois',
                numeric: true,
                render: (r) => formatEuros(r.deal!.rent_monthly),
              },
              {
                key: 'gross',
                label: 'Brut',
                numeric: true,
                render: (r) => formatPercent(r.deal!.gross_yield),
              },
              {
                key: 'net',
                label: 'Net',
                numeric: true,
                info: 'net_yield',
                render: (r) => formatPercent(r.deal!.net_yield),
              },
              {
                key: 'cap',
                label: 'Cap rate',
                numeric: true,
                info: 'cap_rate',
                render: (r) => formatPercent(r.deal!.cap_rate),
              },
              {
                key: 'pay',
                label: 'Mensualité',
                numeric: true,
                render: (r) => formatEuros(r.deal!.payment_monthly),
              },
              {
                key: 'cf',
                label: 'Cash-flow',
                numeric: true,
                render: (r) => <span className={tone(r.deal!.cash_flow_monthly)}>{Math.round(r.deal!.cash_flow_monthly)} €</span>,
              },
              {
                key: 'q',
                label: 'Test 70 %',
                numeric: true,
                info: 'quick_test_monthly',
                render: (r) => (
                  <span className={tone(r.deal!.quick_test_monthly)}>{Math.round(r.deal!.quick_test_monthly)} €</span>
                ),
              },
              {
                key: 'tf',
                label: 'Taxe foncière',
                numeric: true,
                render: (r) => `${formatEuros(r.deal!.taxe_fonciere_yearly)} / an`,
              },
            ]}
          />
          <div className="cy-note" style={{ padding: '6px 14px' }}>
            Hypothèses : achat au prix médian, frais de notaire, crédit 20 ans sans apport, provision de charges et taxe foncière
            locale.{' '}
            <NavLink href={href(`/simulator?level=${place.level}&code=${place.code}`)} navigate={navigate}>
              Changer les hypothèses
            </NavLink>
          </div>
        </Panel>


        {/* ================ Demande & population */}
        <SectionTitle id="demande">{`Demande & population${place.socio ? ` · recensement ${place.socio.census_year}` : ''}`}</SectionTitle>
        {!place.socio ? (
          <Panel span={12}>
            <EmptyState>Pas de données INSEE à ce niveau.</EmptyState>
          </Panel>
        ) : (
          <>
            <Panel span={6} title="Population et emploi" info="population_growth_yearly">
              <Kv
                rows={[
                  ['Population', formatCount(place.socio.population)],
                  ['Évolution / an', formatSignedPercent(place.socio.population_growth_yearly), 'population_growth_yearly'],
                  ['Emplois', formatCount(place.socio.jobs)],
                  ['Emplois / an', formatSignedPercent(place.socio.jobs_growth_yearly), 'jobs_growth_yearly'],
                  [
                    'Niveau de vie médian',
                    place.socio.median_living_standard ? `${formatEuros(place.socio.median_living_standard)} / an` : '—',
                    'median_living_standard',
                  ],
                  ['Taux de pauvreté', formatPercent(place.socio.poverty_rate)],
                ]}
              />
            </Panel>
            <Panel span={6} title="Logements occupés" info="vacancy_rate">
              <Kv
                rows={[
                  ['Logements vacants', formatPercent(place.socio.vacancy_rate), 'vacancy_rate'],
                  ['Vacance, évolution', formatPoints(place.socio.vacancy_change_pts)],
                  ['Résidences secondaires', formatPercent(place.socio.second_home_share)],
                  ['Locataires', formatPercent(place.socio.renter_share), 'tenant_share'],
                  ...(score?.rent_to_income != null
                    ? ([['Loyer / revenu (bien type)', formatPercent(score.rent_to_income), 'rent_to_income']] as [
                        string,
                        string,
                        string,
                      ][])
                    : []),
                ]}
              />
            </Panel>
          </>
        )}

        {/* ================ Parc & DPE */}
        <SectionTitle id="parc">Parc & DPE</SectionTitle>
        <Panel span={6} title="Parc de logements" info="share_apartments">
          {!place.stock ? (
            <EmptyState>Pas de données de parc à ce niveau.</EmptyState>
          ) : (
            <>
              <Kv
                rows={[
                  ['Logements (2022)', formatCount(place.stock.dwellings_2022 ? Math.round(place.stock.dwellings_2022) : null)],
                  [
                    'Appartements / maisons',
                    `${formatPercent(place.stock.share_apartments)} / ${formatPercent(place.stock.share_houses)}`,
                  ],
                  [
                    'Pièces moy. appart. / maison',
                    `${formatDecimal(place.stock.avg_rooms_apartment)} / ${formatDecimal(place.stock.avg_rooms_house)}`,
                  ],
                  [
                    'Appart. avant 1946 / après 2005',
                    `${formatPercent(place.stock.apartments_before_1946_share)} / ${formatPercent(place.stock.apartments_after_2005_share)}`,
                  ],
                  [
                    'Maisons avant 1946 / après 2005',
                    `${formatPercent(place.stock.houses_before_1946_share)} / ${formatPercent(place.stock.houses_after_2005_share)}`,
                  ],
                  ['Locataires HLM', formatPercent(place.stock.social_tenant_share)],
                ]}
              />
              <Chart
                ariaLabel="Résidences principales par nombre de pièces"
                height={120}
                option={{
                  grid: { left: 36, right: 8, top: 8, bottom: 20 },
                  tooltip: {
                    trigger: 'axis',
                    valueFormatter: (v: number) => formatPercent(v),
                  },
                  xAxis: {
                    type: 'category',
                    data: ['1 p.', '2 p.', '3 p.', '4 p.', '5 p. +'],
                    ...axisStyle(),
                  },
                  yAxis: {
                    type: 'value',
                    ...axisStyle(),
                    axisLabel: {
                      ...axisStyle().axisLabel,
                      formatter: (v: number) => `${Math.round(v * 100)} %`,
                    },
                  },
                  series: [
                    {
                      type: 'bar',
                      barWidth: '50%',
                      color: css('--accent'),
                      data: [
                        place.stock.main_homes_1p_share,
                        place.stock.main_homes_2p_share,
                        place.stock.main_homes_3p_share,
                        place.stock.main_homes_4p_share,
                        place.stock.main_homes_5p_share,
                      ].map((v) => v ?? null),
                    },
                  ],
                }}
              />
            </>
          )}
        </Panel>

        <Panel
          span={6}
          title={`Énergie (DPE) · ${place.energy?.[type] ? typeLabel : 'tous logements'}`}
          info="share_fg">
          {!energy ? (
            <EmptyState>Pas de DPE publiés ici.</EmptyState>
          ) : (
            <>
              <div className="cy-dpe" role="img" aria-label="Répartition des DPE de A à G">
                {(['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const).map((k, i) => {
                  const share = energy[`share_${k}`];
                  return (
                    <span
                      key={k}
                      style={{ flex: share, background: DPE_COLORS[i] }}
                      title={`${k.toUpperCase()} : ${formatPercent(share)}`}>
                      {share > 0.06 ? k.toUpperCase() : ''}
                    </span>
                  );
                })}
              </div>
              <div className="cy-note">{formatCount(energy.n_dpe)} diagnostics.</div>
              <Kv
                rows={banSchedule(energy).map((b) => [
                  `Interdits à la location en ${b.year} (${b.classes})`,
                  formatPercent(b.share),
                ])}
              />
            </>
          )}
        </Panel>

        {/* ================ Fiscalité & score */}
        <SectionTitle id="fiscalite">Fiscalité & score</SectionTitle>
        <Panel span={6} title="Fiscalité & règles" info="tfpb_rate">
          <Kv
            rows={[
              [
                'Taux de taxe foncière',
                place.local_tax ? `${formatPercent(place.local_tax.tfpb_rate)} (${place.local_tax.tax_year})` : '—',
                'tfpb_rate',
              ],
              ['Taxe foncière du bien type', deal ? `${formatEuros(deal.taxe_fonciere_yearly)} / an` : '—'],
              ['Encadrement des loyers', place.rent_control ? 'oui' : 'non'],
            ]}
          />
        </Panel>
        <Panel span={6} title={`Score de marché · ${typeLabel}`} info="score">
          {!score ? (
            <EmptyState>Pas de score (trop peu de critères disponibles).</EmptyState>
          ) : (
            <>
              <div className="cy-score">
                <b className="num">{Math.round(score.score)}</b>
                <span className="ink-3">
                  {' '}
                  / 100 · {score.n_criteria} critères · {score.period}
                </span>
              </div>
              <table className="cy-table">
                <tbody>
                  {(Object.keys(CRITERION_LABELS) as ScoreCriterion[]).map((c) => (
                    <tr key={c}>
                      <td className="ink-2">
                        {CRITERION_LABELS[c]} <InfoTip k={c} />
                      </td>
                      <td className="num">
                        {score.strengths.includes(c) ? (
                          <span className="pos">point fort</span>
                        ) : score.weaknesses.includes(c) ? (
                          <span className="neg">point faible</span>
                        ) : (
                          <span className="ink-3">dans la moyenne</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Panel>


        {/* ================ Voisins (communes and arrondissements only) */}
        {neighbours.length > 0 && (
          <>
            <SectionTitle id="voisins">Voisins</SectionTitle>
            <Panel span={7} title={`Communes voisines · ${typeLabel} toutes tailles`} flush>
              <DataTable
                rows={neighbours}
                rowKey={(r) => r.code}
                onRowClick={(r) => navigate(`/place/${r.level ?? place.level}/${r.code}?type=${type}&size=${size}`)}
                columns={[
                  { key: 'name', label: 'Commune', render: (r) => r.name },
                  {
                    key: 'km',
                    label: 'Distance',
                    numeric: true,
                    render: (r) => `${formatDecimal(r.km)} km`,
                  },
                  {
                    key: 'price',
                    label: '€/m²',
                    numeric: true,
                    render: (r) => formatEurosPerM2(r.price),
                  },
                  {
                    key: 'vs',
                    label: 'vs ici',
                    numeric: true,
                    render: (r) => (r.price != null && selfPrice ? formatSignedPercent(r.price / selfPrice - 1) : '—'),
                  },
                  {
                    key: 'yoy',
                    label: '1 an',
                    numeric: true,
                    render: (r) => <span className={tone(r.yoy)}>{formatSignedPercent(r.yoy)}</span>,
                  },
                  {
                    key: 'gross',
                    label: 'Rdt brut',
                    numeric: true,
                    render: (r) => formatPercent(r.gross),
                  },
                  {
                    key: 'n',
                    label: 'Ventes',
                    numeric: true,
                    render: (r) => formatCount(r.n),
                  },
                ]}
              />
            </Panel>
            <Panel span={5} title="Carte des voisins" flush>
              {miniPoints && miniBounds ? (
                <div className="cy-map-box" style={{ position: 'relative', height: 300 }}>
                  <MapCanvas
                    polygons={null}
                    points={miniPoints as never}
                    dark={dark}
                    bounds={miniBounds}
                    onHover={() => undefined}
                    onClick={(p) => p.code !== place.code && navigate(`/place/${String(p.level ?? place.level)}/${String(p.code)}?type=${type}&size=${size}`)}
                    style={{ position: 'absolute', inset: 0 }}
                  />
                </div>
              ) : (
                <EmptyState>Pas de point publié pour ces communes.</EmptyState>
              )}
              <div className="cy-note" style={{ padding: '6px 14px' }}>
                Point foncé : {name}. Couleur des voisins : prix au m² (vert = moins cher).
              </div>
            </Panel>
          </>
        )}
      </div>
    </Shell>
  );
};
