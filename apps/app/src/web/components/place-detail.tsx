// Mini dashboard of one place (map side panel, explorer selection): key figures of the selected type,
// half-year price curve, size table, links. Everything is read from the published place file.
import { useEffect, useState } from 'react';

import { loadPlace } from '../../data/api';
import { formatCount, formatEuros, formatEurosPerM2, formatPercent, formatRentPerM2, formatSignedPercent } from '../../data/format';
import { bucketsFor, halfYearSeries, latestCell, yieldFor } from '../../data/select';
import type { DwellingType, GeoLevel, Place } from '../../data/types';
import { axisStyle, Chart } from '../charts/chart';
import { sizeLabel } from './controls';
import { DataTable } from './data-table';
import { EmptyState, ErrorPanel, InfoTip } from './panel';
import { NavLink, type Navigate } from './shell';

const LEVEL_LABELS: Record<GeoLevel, string> = {
  france: 'Pays',
  region: 'Région',
  departement: 'Département',
  commune: 'Commune',
  arrondissement: 'Arrondissement',
};

const Row = ({ label, value, info, tone }: { label: string; value: string; info?: string; tone?: string }) => (
  <tr>
    <td className="ink-2">
      {label} {info && <InfoTip k={info} />}
    </td>
    <td className={`num${tone ? ` ${tone}` : ''}`}>{value}</td>
  </tr>
);

export const usePlace = (level: GeoLevel | null, code: string | null) => {
  const [state, setState] = useState<{ key: string; place?: Place; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = level && code ? `${level}/${code}/${attempt}` : null;
  useEffect(() => {
    if (!level || !code || !key) {
      return;
    }
    let current = true;
    loadPlace(level, code).then(
      (place) => current && setState({ key, place }),
      (e: Error) => current && setState({ key, error: e.message }),
    );
    return () => {
      current = false;
    };
  }, [level, code, key]);
  const settled = state?.key === key ? state : null;
  // no file = no published sales here (too few, or outside DVF): an empty state, not an error
  const notFound = Boolean(settled?.error?.includes('HTTP 404'));
  return {
    place: settled?.place,
    error: notFound ? undefined : settled?.error,
    notFound,
    loading: Boolean(key) && !settled,
    retry: () => setAttempt((a) => a + 1),
  };
};

type PlaceDetailProps = {
  level: GeoLevel;
  code: string;
  type: DwellingType;
  navigate: Navigate;
};

export const PlaceDetail = ({ level, code, type, navigate }: PlaceDetailProps) => {
  const { place, error, notFound, loading, retry } = usePlace(level, code);
  if (notFound) {
    return <EmptyState>Pas de ventes publiées ici : moins de 10 ventes par an, ou territoire hors DVF (Alsace-Moselle, Mayotte).</EmptyState>;
  }
  if (error) {
    return <ErrorPanel message={`Fiche indisponible : ${error}`} onRetry={retry} />;
  }
  if (loading || !place) {
    return <EmptyState>Chargement…</EmptyState>;
  }
  const segment = { propertyType: type, rooms: 'all' as const };
  const cell = latestCell(place.prices, place.latest, segment);
  const year = cell?.row;
  const rent = year ? yieldFor(place.yields, segment, year.period) : undefined;
  const deal = place.typical_deal?.[type]?.all;
  const series = halfYearSeries(place.prices, segment);
  const typeLabel = type === 'house' ? 'maisons' : 'appartements';
  const sizes = bucketsFor(type)
    .filter((b) => b !== 'all')
    .map((bucket) => {
      const row = latestCell(place.prices, place.latest, { propertyType: type, rooms: bucket });
      const y = row ? yieldFor(place.yields, { propertyType: type, rooms: bucket }, row.row.period) : undefined;
      return { bucket, row: row?.basis === 'exact' ? row.row : undefined, rent: y };
    })
    .filter((s) => s.row);
  return (
    <div>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
        <div className="ink-3" style={{ fontSize: 'var(--fs-micro)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          {LEVEL_LABELS[place.level]} · {place.code}
          {place.rent_control ? ' · loyers encadrés' : ''}
        </div>
        <div style={{ fontSize: 'var(--fs-title)', fontWeight: 600 }}>{place.name ?? code}</div>
      </div>
      {!year ? (
        <EmptyState>Pas assez de ventes de {typeLabel} pour publier un prix.</EmptyState>
      ) : (
        <>
          <table className="cy-table">
            <tbody>
              <Row label={`Prix médian ${typeLabel} ${year.period}`} value={formatEurosPerM2(year.median_price_m2)} info="median_price_m2" />
              <Row label="Fourchette P25 – P75" value={`${formatEurosPerM2(year.p25_price_m2)} – ${formatEurosPerM2(year.p75_price_m2)}`} />
              <Row label="Évolution sur un an" value={formatSignedPercent(year.yoy_change)} info="yoy_change"
                tone={year.yoy_change == null ? undefined : year.yoy_change >= 0 ? 'pos' : 'neg'} />
              <Row label="Ventes" value={`${formatCount(year.n_sales)}${year.reliability === 'low' ? ' (fiabilité faible)' : ''}`} info="n_sales" />
              <Row label="Loyer d’annonce" value={formatRentPerM2(rent?.rent_m2)} info="rent_m2" />
              <Row label="Rentabilité brute" value={rent?.status === 'excluded' ? 'exclue' : formatPercent(rent?.gross_yield)} info="gross_yield" />
              {deal && (
                <>
                  <Row label="Bien type : prix" value={formatEuros(deal.price)} info="median_price" />
                  <Row label="Bien type : rentabilité nette" value={formatPercent(deal.net_yield)} info="net_yield" />
                  <Row label="Bien type : cash-flow" value={`${Math.round(deal.cash_flow_monthly)} € / mois`} info="cash_flow_monthly"
                    tone={deal.cash_flow_monthly >= 0 ? 'pos' : 'neg'} />
                </>
              )}
              {place.score?.[type] && <Row label="Score de marché" value={`${Math.round(place.score[type]!.score)} / 100`} info="score" />}
              {place.socio && <Row label="Vacance" value={formatPercent(place.socio.vacancy_rate)} info="vacancy_rate" />}
              {place.socio && <Row label="Population / an" value={formatSignedPercent(place.socio.population_growth_yearly)} info="population_growth_yearly" />}
            </tbody>
          </table>
          {series.length > 1 && (
            <div style={{ borderTop: '1px solid var(--line)', padding: '8px 4px 0' }}>
              <div className="cy-panel-title" style={{ padding: '0 10px' }}>Prix au m² par semestre</div>
              <Chart
                ariaLabel={`Évolution du prix au m² des ${typeLabel}`}
                height={130}
                option={{
                  grid: { left: 44, right: 10, top: 10, bottom: 22 },
                  xAxis: { type: 'category', data: series.map((r) => r.period), ...axisStyle() },
                  yAxis: { type: 'value', scale: true, ...axisStyle() },
                  series: [{ type: 'line', data: series.map((r) => Math.round(r.median_price_m2)), symbol: 'none', lineStyle: { width: 1.6 } }],
                }}
              />
            </div>
          )}
          {sizes.length > 0 && (
            <DataTable
              rows={sizes}
              rowKey={(s) => s.bucket}
              columns={[
                { key: 'size', label: 'Taille', render: (s) => sizeLabel(type, s.bucket) },
                { key: 'price', label: '€/m²', numeric: true, render: (s) => formatEurosPerM2(s.row!.median_price_m2) },
                { key: 'n', label: 'Ventes', numeric: true, render: (s) => formatCount(s.row!.n_sales) },
                { key: 'yield', label: 'Rdt brut', numeric: true, render: (s) => formatPercent(s.rent?.gross_yield) },
              ]}
            />
          )}
        </>
      )}
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
        <NavLink className="cy-button" href={`/place/${place.level}/${place.code}?type=${type}`} navigate={navigate}>
          Ouvrir la fiche
        </NavLink>
        <NavLink className="cy-button ghost" href={`/evolution?places=${place.level}:${place.code}&type=${type}`} navigate={navigate}>
          Évolution
        </NavLink>
        <NavLink className="cy-button ghost" href={`/compare?places=${place.level}:${place.code}&type=${type}`} navigate={navigate}>
          Comparer
        </NavLink>
      </div>
    </div>
  );
};
