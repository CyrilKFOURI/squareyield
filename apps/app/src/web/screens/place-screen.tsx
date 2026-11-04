'use dom';

// Marché: the full dashboard of one place (commune, arrondissement, département, région, France) for one
// comparable segment. Header and KPI ribbon, then anchored docked sections: prix, loyers & rendement,
// rentabilité type, demande, parc, énergie, fiscalité, score, territoire, voisins. Read-only over the
// published place file plus its parents, its OLL file and the commune points (neighbours).
import { useEffect, useState } from 'react';

import { type CommunePoint, loadCommunePoints, loadOll, loadPlace } from '../../data/api';
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
import { bandsSeries, banSchedule, CRITERION_LABELS, parentRefs } from '../../data/place-view';
import { colorFor, PALETTES } from '../../data/scales';
import { bucketsFor, EXCLUSION_REASONS, halfYearSeries, latestCell, newBuildFor, yieldFor } from '../../data/select';
import type { DwellingType, GeoLevel, Oll, Place, RoomsBucket, ScoreCriterion } from '../../data/types';
import { axisStyle, Chart, css, SERIES_COLORS } from '../charts/chart';
import { FilterBar, sizeLabel } from '../components/controls';
import { DataTable } from '../components/data-table';
import { EmptyState, ErrorPanel, InfoTip, Panel, ReliabilityBadge, Ribbon } from '../components/panel';
import { usePlace } from '../components/place-detail';
import { NavLink, Shell } from '../components/shell';
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
const SECTIONS = [
  ['prix', 'Prix'],
  ['loyers', 'Loyers & rendement'],
  ['rentabilite', 'Rentabilité type'],
  ['demande', 'Demande'],
  ['parc', 'Parc'],
  ['energie', 'Énergie'],
  ['fiscalite', 'Fiscalité'],
  ['score', 'Score'],
  ['territoire', 'Territoire'],
  ['voisins', 'Voisins'],
] as const;
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

export default function PlaceScreen({ filters, onFilters, navigate }: ScreenProps) {
  const level = filters.level;
  const code = filters.code;
  const { place, error, notFound, loading, retry } = usePlace(level, code);
  if (notFound) {
    return (
      <Shell active="map" title="Marché" navigate={navigate} crumbs={[{ label: 'France', href: '/' }]}>
        <EmptyState>Pas de ventes publiées pour ce lieu : moins de 10 ventes par an, ou territoire hors DVF (Alsace-Moselle, Mayotte).</EmptyState>
      </Shell>
    );
  }
  if (error) {
    return (
      <Shell active="map" title="Marché" navigate={navigate} crumbs={[{ label: 'France', href: '/' }]}>
        <ErrorPanel message={`Fiche indisponible : ${error}`} onRetry={retry} />
      </Shell>
    );
  }
  if (loading || !place) {
    return (
      <Shell active="map" title="Marché" navigate={navigate} crumbs={[{ label: 'France', href: '/' }]}>
        <EmptyState>Chargement…</EmptyState>
      </Shell>
    );
  }
  return <PlaceDashboard place={place} filters={filters} onFilters={onFilters} navigate={navigate} />;
}

const PlaceDashboard = ({
  place,
  filters,
  onFilters,
  navigate,
}: Pick<ScreenProps, 'filters' | 'onFilters' | 'navigate'> & {
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

  const [parents, setParents] = useState<Place[]>([]);
  const [oll, setOll] = useState<Oll | null>(null);
  const [points, setPoints] = useState<CommunePoint[] | null>(null);
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
    if (place.neighbours?.length) {
      loadCommunePoints().then(
        (table) => current && setPoints(table.rows),
        () => current && setPoints([]),
      );
    }
    return () => {
      current = false;
    };
  }, [place]);

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

  // ---- territoire
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

  // ---- voisins
  const neighbours = (place.neighbours ?? []).map(([nCode, nName, km]) => {
    const pt = points?.find((p) => p.code === nCode && p.type === type);
    return { code: nCode, name: nName, km, pt };
  });
  const self = points?.find((p) => p.code === place.code && p.type === type);
  const neighbourPrices = neighbours
    .map((n) => n.pt?.median_price_m2)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const quint =
    neighbourPrices.length >= 5 ? [0.2, 0.4, 0.6, 0.8].map((q) => neighbourPrices[Math.floor(q * neighbourPrices.length)]) : [];
  const miniPoints =
    self || neighbours.some((n) => n.pt)
      ? {
          type: 'FeatureCollection' as const,
          features: [...neighbours.filter((n) => n.pt).map((n) => n.pt!), ...(self ? [self] : [])].map((p) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
            properties: {
              ...p,
              _fill: p.code === place.code ? css('--ink-1') : colorFor(p.median_price_m2, quint, 'rdylgn', false),
              _r: p.code === place.code ? 8 : 5 + Math.min(6, Math.sqrt(p.n) / 6),
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
  const crumbs = [{ label: 'France', href: '/' }, ...(place.level !== 'france' ? [{ label: name }] : [])];
  const href = (path: string) => `${path}${path.includes('?') ? '&' : '?'}type=${type}`;

  return (
    <Shell
      active="map"
      title={name}
      navigate={navigate}
      crumbs={crumbs}
      tools={
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <NavLink className="cy-button" href={href(`/simulator?level=${place.level}&code=${place.code}`)} navigate={navigate}>
            Simuler
          </NavLink>
          <NavLink className="cy-button ghost" href={href(`/compare?places=${place.level}:${place.code}`)} navigate={navigate}>
            Comparer
          </NavLink>
          <NavLink className="cy-button ghost" href={href(`/evolution?places=${place.level}:${place.code}`)} navigate={navigate}>
            Évolution
          </NavLink>
          {commune && (
            <NavLink className="cy-button ghost" href={`/property?commune=${place.code}`} navigate={navigate}>
              Analyser un bien ici
            </NavLink>
          )}
          {place.departement && (
            <NavLink
              className="cy-button ghost"
              href={href(`/map?level=departement&code=${place.departement}`)}
              navigate={navigate}>
              Carte
            </NavLink>
          )}
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
          <nav className="cy-anchors" aria-label="Sections">
            {SECTIONS.filter(([id]) => id !== 'voisins' || neighbours.length > 0).map(([id, label]) => (
              <a key={id} href={`#${id}`}>
                {label}
              </a>
            ))}
          </nav>
        </Panel>

        {/* ---------------- Prix */}
        <Panel id="prix" span={8} title={`Prix au m² par semestre · ${segLabel}`} info="median_price_m2">
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

        {/* ---------------- Loyers & rendement */}
        <Panel id="loyers" span={8} title={`Loyers d’annonce et rentabilité · ${typeLabel}`} info="rent_m2" flush>
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

        {/* ---------------- Rentabilité type */}
        <Panel id="rentabilite" span={12} title={`Rentabilité d’un bien type · ${typeLabel}`} info="cash_flow_monthly" flush>
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

        {/* ---------------- Demande / Parc */}
        <Panel
          id="demande"
          span={6}
          title={`Demande${place.socio ? ` · recensement ${place.socio.census_year}` : ''}`}
          info="population_growth_yearly">
          {!place.socio ? (
            <EmptyState>Pas de données INSEE à ce niveau.</EmptyState>
          ) : (
            <Kv
              rows={[
                ['Population', formatCount(place.socio.population)],
                ['Évolution / an', formatSignedPercent(place.socio.population_growth_yearly), 'population_growth_yearly'],
                ['Emplois', formatCount(place.socio.jobs)],
                ['Emplois / an', formatSignedPercent(place.socio.jobs_growth_yearly), 'jobs_growth_yearly'],
                ['Logements vacants', formatPercent(place.socio.vacancy_rate), 'vacancy_rate'],
                ['Vacance, évolution', formatPoints(place.socio.vacancy_change_pts)],
                ['Résidences secondaires', formatPercent(place.socio.second_home_share)],
                ['Locataires', formatPercent(place.socio.renter_share), 'tenant_share'],
                [
                  'Niveau de vie médian',
                  place.socio.median_living_standard ? `${formatEuros(place.socio.median_living_standard)} / an` : '—',
                  'median_living_standard',
                ],
                ['Taux de pauvreté', formatPercent(place.socio.poverty_rate)],
                ...(score?.rent_to_income != null
                  ? ([['Loyer / revenu (bien type)', formatPercent(score.rent_to_income), 'rent_to_income']] as [
                      string,
                      string,
                      string,
                    ][])
                  : []),
              ]}
            />
          )}
        </Panel>
        <Panel id="parc" span={6} title="Parc de logements" info="share_apartments">
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

        {/* ---------------- Énergie / Fiscalité / Score */}
        <Panel
          id="energie"
          span={4}
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
        <Panel id="fiscalite" span={4} title="Fiscalité & règles" info="tfpb_rate">
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
        <Panel id="score" span={4} title={`Score de marché · ${typeLabel}`} info="score">
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

        {/* ---------------- Territoire */}
        <Panel id="territoire" span={7} title={`Territoire · même segment (${segLabel})`} flush>
          <DataTable
            rows={chain}
            rowKey={(r) => r.key}
            selected={`${place.level}:${place.code}`}
            onRowClick={(r) =>
              r.key !== `${place.level}:${place.code}` && navigate(`/place/${r.level}/${r.code}?type=${type}&size=${size}`)
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

        {/* ---------------- Voisins (communes and arrondissements only) */}
        {neighbours.length > 0 && (
          <>
            <Panel id="voisins" span={7} title={`Communes voisines · ${typeLabel} toutes tailles`} flush>
              <DataTable
                rows={neighbours}
                rowKey={(r) => r.code}
                onRowClick={(r) => navigate(`/place/${r.pt?.level ?? place.level}/${r.code}?type=${type}&size=${size}`)}
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
                    render: (r) => formatEurosPerM2(r.pt?.median_price_m2),
                  },
                  {
                    key: 'vs',
                    label: 'vs ici',
                    numeric: true,
                    render: (r) => (r.pt && self ? formatSignedPercent(r.pt.median_price_m2 / self.median_price_m2 - 1) : '—'),
                  },
                  {
                    key: 'gross',
                    label: 'Rdt brut',
                    numeric: true,
                    render: (r) => formatPercent(r.pt?.gross_yield),
                  },
                  {
                    key: 'cf',
                    label: 'Cash-flow',
                    numeric: true,
                    render: (r) => (r.pt?.cash_flow_monthly == null ? '—' : `${Math.round(r.pt.cash_flow_monthly)} €`),
                  },
                  {
                    key: 'n',
                    label: 'Ventes',
                    numeric: true,
                    render: (r) => formatCount(r.pt?.n),
                  },
                ]}
              />
            </Panel>
            <Panel span={5} title="Carte des voisins" flush>
              {miniPoints && miniBounds ? (
                <div style={{ position: 'relative', height: 300 }}>
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
                <EmptyState>{points ? 'Pas de point publié pour ces communes.' : 'Chargement…'}</EmptyState>
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
