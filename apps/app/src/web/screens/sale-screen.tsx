'use dom';

// Marché ③ › une vente (docs/features/019-sales-map/spec.md, User flow 2): the sheet of one past DVF sale, reached
// from the building panel of the commune page. Header and ribbon, its position among similar sales (building,
// street, section, commune), the 10 nearest comparables, its value today and the model estimate, the resale of the
// same lot, the other sales of the building, "if it were bought to rent" (rent from the public commune file,
// yield and cash-flow from core-kpi, prefilled simulator) and the commune context. The sale comes from its
// commune's static sales file (feature 022): its id is "<place code>-<12 hex>".
import { type ReactNode, useEffect, useState } from 'react';

import { formatCount, formatDecimal, formatEuros, formatEurosPerM2, formatPercent, formatRentPerM2, formatSignedPercent } from '../../data/format';
import { getSale, type PositionLevel, SalesApiError, type SaleSheet } from '../../data/sales-api';
import {
  dateMs,
  formatDate,
  gap,
  gapTone,
  MIN_MEDIAN_SALES,
  percentileText,
  placeLevelOf,
  pointsBounds,
  SALE_TYPE_LABELS,
  saleDeal,
  saleRent,
  simulatorHref,
  spread,
  yearsOfRent,
} from '../../data/sales-view';
import { latestCell, roomsBucketOf, yieldFor } from '../../data/select';
import { axisStyle, Chart, SERIES_COLORS } from '../charts/chart';
import { EmptyState, ErrorPanel, InfoTip, Panel, Ribbon } from '../components/panel';
import { usePlace } from '../components/place-detail';
import { TOKENS } from '../components/sales-section';
import { NavLink, Shell } from '../components/shell';
import { MarketSteps } from '../components/steps';
import { useDark } from '../hooks/use-dark';
import { MapCanvas } from '../maps/map-canvas';
import type { ScreenProps } from '../screen-props';
import { TableWrap } from '../components/table-wrap';

const POSITION_LABELS: Record<PositionLevel, string> = {
  building: 'Immeuble',
  street: 'Rue',
  section: 'Section cadastrale',
  commune: 'Commune',
};

type Loaded<T> = { key: string; value?: T; error?: unknown };

const Kv = ({ rows }: { rows: [string, ReactNode, string?][] }) => (
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

const m2 = (value: number | null | undefined) => (value == null ? '—' : `${formatDecimal(value)} m²`);
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

export default function SaleScreen({ params, navigate }: ScreenProps) {
  const id = params.id ?? '';
  const [attempt, setAttempt] = useState(0);
  const [sheet, setSheet] = useState<Loaded<SaleSheet> | null>(null);
  const key = `${id}#${attempt}`;
  useEffect(() => {
    if (!id) {
      return;
    }
    let current = true;
    getSale(id).then(
      (value) => current && setSheet({ key, value }),
      (error: unknown) => current && setSheet({ key, error }),
    );
    return () => {
      current = false;
    };
  }, [id, key]);

  const settled = sheet?.key === key ? sheet : null;
  const retry = () => setAttempt((a) => a + 1);
  const frame = (body: ReactNode) => (
    <Shell active="market" title="Vente" navigate={navigate} crumbs={[{ label: 'France', href: '/' }]} steps={<MarketSteps navigate={navigate} />}>
      {body}
    </Shell>
  );
  if (!id) {
    return frame(<EmptyState>Vente introuvable.</EmptyState>);
  }
  const error = settled?.error;
  if (error != null) {
    if (error instanceof SalesApiError && error.kind === 'not_found') {
      return frame(<EmptyState>Vente introuvable : elle a pu sortir de la fenêtre DVF (5 ans) à la dernière mise à jour.</EmptyState>);
    }
    return frame(<ErrorPanel message={`Fiche indisponible : ${(error as Error).message}`} onRetry={retry} />);
  }
  if (!settled?.value) {
    return frame(<EmptyState>Chargement de la vente…</EmptyState>);
  }
  // a new sale is a new sheet (map framing, place files)
  return <SaleSheetView key={settled.value.sale.id} sheet={settled.value} navigate={navigate} />;
}

const SaleSheetView = ({ sheet, navigate }: { sheet: SaleSheet; navigate: ScreenProps['navigate'] }) => {
  const { sale } = sheet;
  const type = sale.type;
  const level = placeLevelOf(sale.commune.code);
  const { place, notFound: noPlace } = usePlace(level, sale.commune.code);
  const { place: depPlace } = usePlace('departement', sale.departement || null);
  const dark = useDark();
  const tokens = TOKENS[dark ? 'dark' : 'light'];
  const query = `?type=${type}`;
  const communeHref = `/place/${level}/${sale.commune.code}${query}`;
  const buildingHref = sale.parcel ? `/place/${level}/${sale.commune.code}${query}&building=${sale.parcel}` : communeHref;
  const surface = sale.carrez ?? sale.surface;
  const typeWord = type === 'house' ? 'maison' : 'appartement';
  const depName = depPlace?.name ?? `Département ${sale.departement}`;

  // ---- position
  const rule = sheet.similar_rule;
  const ruleText = `même type, surface à ±${Math.round(rule.surface_ratio * 100)} %, ±${plural(rule.rooms, 'pièce')}, signées à ±${rule.months} mois`;
  const positioned = sheet.position.filter((p) => p.n >= MIN_MEDIAN_SALES && p.median_m2 != null);

  // ---- comparables
  const compSpread = spread(sheet.comparables.map((c) => c.price_m2).filter((v): v is number => v != null));
  const compPoints = {
    type: 'FeatureCollection' as const,
    features: [
      ...sheet.comparables
        .filter((c) => c.lon != null && c.lat != null)
        .map((c) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point', coordinates: [c.lon as number, c.lat as number] },
          properties: { id: c.id, code: c.id, label: c.address, date: c.date, price_m2: c.price_m2, _fill: SERIES_COLORS[1], _r: 6 },
        })),
      ...(sale.lon != null && sale.lat != null
        ? [
            {
              type: 'Feature' as const,
              geometry: { type: 'Point', coordinates: [sale.lon, sale.lat] },
              properties: { id: sale.id, code: sale.id, label: sale.address, date: sale.date, price_m2: sale.price_m2, self: true,
                _fill: tokens.ink1, _r: 8, _stroke: 2, _strokeColor: tokens.bg },
            },
          ]
        : []),
    ],
  };
  const [compBounds] = useState(() =>
    pointsBounds([...sheet.comparables, { lon: sale.lon, lat: sale.lat }], 0.003),
  );

  // ---- if bought to rent (public commune file + core-kpi)
  const bucket = roomsBucketOf(type, sale.rooms ?? 0);
  const cell = place ? latestCell(place.prices, place.latest, { propertyType: type, rooms: bucket }) : undefined;
  const year = cell?.row;
  const yieldRow =
    place && year ? yieldFor(place.yields, { propertyType: type, rooms: cell?.basis === 'all_sizes' ? 'all' : bucket }, year.period) : undefined;
  const rent = surface ? saleRent({ type, surface, curve: place?.rent_curve?.[type], cellRentM2: yieldRow?.rent_m2 }) : { rentM2: null, rentMonthly: 0 };
  const deal = surface && rent.rentMonthly > 0
    ? saleDeal({ price: sale.price, surface, isNew: sale.new, rentMonthly: rent.rentMonthly, tfpbRate: place?.local_tax?.tfpb_rate })
    : null;
  const payback = yearsOfRent(sale.price, rent.rentMonthly);
  const simulator = simulatorHref({ level, code: sale.commune.code, type, price: sale.price, surface, rentMonthly: rent.rentMonthly });

  // ---- context
  const allSizes = place ? latestCell(place.prices, place.latest, { propertyType: type, rooms: 'all' })?.row : undefined;
  const energy = place?.energy?.[type] ?? place?.energy?.all;

  // ---- building: the other sales (the data may or may not list this one), and this sale in the list
  const others = sheet.building_sales.filter((s) => s.id !== sale.id);
  const buildingList = [
    { id: sale.id, date: sale.date, type: sale.type, rooms: sale.rooms, surface: sale.carrez ?? sale.surface, price_m2: sale.price_m2 },
    ...others,
  ].sort((a, b) => b.date.localeCompare(a.date));

  const crumbs = [
    { label: 'France', href: `/${query}` },
    ...(sale.departement ? [{ label: `${depName} (${sale.departement})`, href: `/departement/${sale.departement}${query}` }] : []),
    { label: sale.commune.name, href: communeHref },
    { label: `Vente du ${formatDate(sale.date)}` },
  ];

  return (
    <Shell
      active="market"
      title={sale.address}
      navigate={navigate}
      crumbs={crumbs}
      steps={
        <MarketSteps
          navigate={navigate}
          type={type}
          departement={sale.departement ? { code: sale.departement, name: depName } : null}
          commune={{ code: sale.commune.code, name: sale.commune.name, level }}
          sub={{ label: 'Vente', value: `${formatDate(sale.date)} · ${sale.address}` }}
        />
      }
      tools={
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <NavLink className="cy-button ghost" href={buildingHref} navigate={navigate}>
            ← Immeuble sur la carte
          </NavLink>
          <NavLink className="cy-button" href={simulator} navigate={navigate}>
            Simuler ce bien
          </NavLink>
        </div>
      }>
      <div className="cy-grid">
        {/* ================ header */}
        <Panel span={12} flush>
          <div className="cy-sale-head">
            <h2>{sale.address}</h2>
            <span className="ink-3">
              {[sale.postcode, sale.commune.name].filter(Boolean).join(' ')}
              {sale.parcel && ` · parcelle ${sale.parcel}`}
            </span>
            <span className="cy-tag">{SALE_TYPE_LABELS[type]}</span>
            <span className="cy-tag">{sale.new ? 'Neuf (VEFA)' : 'Ancien'}</span>
            {sale.location_precision === 'section' && <span className="cy-tag warn">Position approchée (section)</span>}
          </div>
          <Ribbon
            items={[
              { label: 'Prix', value: formatEuros(sale.price), detail: `signé le ${formatDate(sale.date)}` },
              {
                label: 'Prix au m²',
                value: formatEurosPerM2(sale.price_m2),
                info: 'gap_commune',
                detail: sale.gap_commune != null ? `${formatSignedPercent(sale.gap_commune)} vs ${sale.commune.name}` : undefined,
                tone: gapTone(sale.gap_commune),
              },
              { label: 'Surface Carrez', value: m2(sale.carrez), detail: `bâtie ${m2(sale.surface)}` },
              { label: 'Pièces', value: sale.rooms == null ? '—' : String(sale.rooms) },
              {
                // a count: lot numbers are not published (decision 022)
                label: 'Lots',
                value: sale.n_lots ? String(sale.n_lots) : '—',
              },
              { label: 'Dépendances', value: String(sale.n_dependencies), detail: 'caves, parkings' },
              { label: 'Terrain', value: sale.land ? `${formatCount(Math.round(sale.land))} m²` : '—' },
            ]}
          />
        </Panel>

        {/* ================ position on its market */}
        <Panel span={7} flush title="Position sur son marché" info="similar_sales">
          <table className="cy-table">
            <thead>
              <tr>
                <th>Niveau</th>
                <th className="num">Ventes similaires</th>
                <th className="num">Médiane</th>
                <th className="num">
                  Écart <InfoTip k="sale_gap" />
                </th>
                <th className="num">
                  Moins chères <InfoTip k="sale_percentile" />
                </th>
              </tr>
            </thead>
            <tbody>
              {sheet.position.map((p) => (
                <tr key={p.level}>
                  <td>{POSITION_LABELS[p.level]}</td>
                  <td className="num">{formatCount(p.n)}</td>
                  {p.n < MIN_MEDIAN_SALES || p.median_m2 == null ? (
                    <td className="num ink-3" colSpan={3}>
                      moins de 3 ventes similaires
                    </td>
                  ) : (
                    <>
                      <td className="num">{formatEurosPerM2(p.median_m2)}</td>
                      <td className={`num ${gapTone(p.gap) ?? ''}`}>{formatSignedPercent(p.gap)}</td>
                      <td className="num" title={percentileText(p.percentile)}>
                        {p.percentile == null ? '—' : `${Math.round(p.percentile * 100)} %`}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="cy-note" style={{ padding: '6px 14px' }}>
            Ventes similaires : {ruleText} autour de la vente (elle-même exclue). Écart : prix au m² de la vente / médiane des
            similaires − 1. Moins chères : part des similaires vendues moins cher au m².
          </div>
        </Panel>
        <Panel span={5} title="Prix au m² comparé">
          {positioned.length === 0 ? (
            <EmptyState>Trop peu de ventes similaires pour situer cette vente.</EmptyState>
          ) : (
            <Chart
              ariaLabel="Médiane des ventes similaires par niveau, et prix de la vente"
              height={Math.max(140, positioned.length * 40 + 40)}
              option={{
                grid: { left: 120, right: 56, top: 22, bottom: 22 },
                legend: { show: false },
                tooltip: { trigger: 'axis', valueFormatter: (v: number) => formatEurosPerM2(v) },
                // bars start at zero: a cut axis would exaggerate the gaps
                xAxis: { type: 'value', ...axisStyle() },
                yAxis: { type: 'category', inverse: true, data: positioned.map((p) => POSITION_LABELS[p.level]), ...axisStyle() },
                series: [
                  {
                    type: 'bar',
                    name: 'Médiane des similaires',
                    barWidth: '50%',
                    color: tokens.lineStrong,
                    label: { show: true, position: 'right', fontSize: 11, color: tokens.ink2, formatter: (p: { value: number }) => formatCount(Math.round(p.value)) },
                    data: positioned.map((p) => p.median_m2),
                    markLine:
                      sale.price_m2 != null
                        ? {
                            silent: true,
                            symbol: 'none',
                            lineStyle: { color: tokens.accent, width: 2, type: 'solid' },
                            label: { formatter: 'cette vente', color: tokens.accent, fontSize: 10, position: 'start' },
                            data: [{ xAxis: sale.price_m2 }],
                          }
                        : undefined,
                  },
                ],
              }}
            />
          )}
        </Panel>

        {/* ================ comparables */}
        <Panel span={5} flush title="Comparables sur la carte" info="comparables">
          {compBounds ? (
            <div className="cy-map-box" style={{ position: 'relative', height: 320 }}>
              <MapCanvas
                polygons={null}
                points={compPoints as never}
                dark={dark}
                bounds={compBounds}
                onClick={(p) => !p.self && p.id != null && navigate(`/vente/${encodeURIComponent(String(p.id))}`)}
                renderHover={(hit) => (
                  <>
                    <div style={{ fontWeight: 600 }}>{String(hit.properties.label ?? '')}</div>
                    <div className="ink-2">
                      {hit.properties.self ? 'Cette vente · ' : ''}
                      {formatDate(String(hit.properties.date ?? ''))} · {formatEurosPerM2(hit.properties.price_m2 as number | null)}
                    </div>
                  </>
                )}
                style={{ position: 'absolute', inset: 0 }}
              />
            </div>
          ) : (
            <EmptyState>Pas de position connue pour ces ventes.</EmptyState>
          )}
          <div className="cy-note" style={{ padding: '6px 14px' }}>
            Point foncé : cette vente ; orange : les comparables (clic : leur fiche).
          </div>
        </Panel>
        <Panel
          span={7}
          flush
          title={`Les ${sheet.comparables.length || ''} ventes similaires les plus proches`}
          tools={
            compSpread ? (
              <span className="cy-note">
                médiane {formatEurosPerM2(compSpread.median)} · {formatCount(Math.round(compSpread.p25))} – {formatCount(Math.round(compSpread.p75))} ·
                cette vente{' '}
                <span className={gapTone(gap(sale.price_m2, compSpread.median))}>{formatSignedPercent(gap(sale.price_m2, compSpread.median))}</span>
              </span>
            ) : undefined
          }>
          {sheet.comparables.length === 0 ? (
            <EmptyState>Aucune vente similaire dans la commune ({ruleText}).</EmptyState>
          ) : (
            <TableWrap>
              <table className="cy-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Adresse</th>
                    <th className="num">P.</th>
                    <th className="num">Surface</th>
                    <th className="num">Prix</th>
                    <th className="num">€/m²</th>
                    <th className="num">Distance</th>
                    <th aria-label="Fiche" />
                  </tr>
                </thead>
                <tbody>
                  {sheet.comparables.map((c) => (
                    <tr key={c.id}>
                      <td>{formatDate(c.date)}</td>
                      <td style={{ whiteSpace: 'normal', minWidth: 140 }}>{c.address}</td>
                      <td className="num">{c.rooms ?? '—'}</td>
                      <td className="num">{c.surface == null ? '—' : `${formatCount(Math.round(c.surface))} m²`}</td>
                      <td className="num">{formatEuros(c.price)}</td>
                      <td className="num">{c.price_m2 == null ? '—' : formatCount(Math.round(c.price_m2))}</td>
                      <td className="num">{c.km == null ? '—' : c.km < 1 ? `${formatCount(Math.round(c.km * 1000))} m` : `${formatDecimal(c.km)} km`}</td>
                      <td>
                        <NavLink href={`/vente/${encodeURIComponent(c.id)}`} navigate={navigate} className="cy-more">
                          Voir la fiche →
                        </NavLink>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Panel>

        {/* ================ value today, model, resale */}
        <Panel span={sheet.resale ? 4 : 6} title="Valeur aujourd’hui" info="value_today">
          {!sheet.value_today ? (
            <EmptyState>Pas de série de prix annuelle pour indexer cette vente.</EmptyState>
          ) : (
            <Kv
              rows={[
                ['Prix payé', `${formatEuros(sale.price)} (${sale.date.slice(0, 4)})`],
                [
                  `Marché ${sheet.value_today.level === 'commune' ? 'de la commune' : 'du département'}`,
                  `× ${formatDecimal(sheet.value_today.factor)} · ${sheet.value_today.from_year} → ${sheet.value_today.to_year}`,
                ],
                ['Valeur estimée aujourd’hui', <b key="v">{formatEuros(sheet.value_today.value)}</b>],
                [
                  'Plus-value latente',
                  <span key="g" className={sheet.value_today.gain >= 0 ? 'pos' : 'neg'}>
                    {sheet.value_today.gain > 0 ? '+' : ''}
                    {formatEuros(sheet.value_today.gain)}
                  </span>,
                ],
              ]}
            />
          )}
          <div className="cy-note" style={{ marginTop: 6 }}>
            Prix indexé sur la médiane annuelle au m² ({typeWord}s), années complètes ; avant frais et impôts.
          </div>
        </Panel>
        <Panel span={sheet.resale ? 4 : 6} title="Estimation du modèle" info="model_estimate">
          {!sheet.model ? (
            <EmptyState>Pas d’estimation du modèle sur une vente passée : utilisez « Analyser un bien ».</EmptyState>
          ) : (
            <Kv
              rows={[
                ['Prix au m² estimé', formatEurosPerM2(sheet.model.estimate_m2)],
                ['Fourchette', `${formatCount(Math.round(sheet.model.low_m2))} – ${formatEurosPerM2(sheet.model.high_m2)}`],
                ['Prix réel', formatEurosPerM2(sale.price_m2)],
                [
                  'Prix réel vs modèle',
                  <span key="m" className={gapTone(sheet.model.gap)}>
                    {formatSignedPercent(sheet.model.gap)}
                  </span>,
                ],
                ['Estimé', sheet.model.as_of === 'today' ? 'aux prix d’aujourd’hui' : `au ${formatDate(sheet.model.as_of)}`],
              ]}
            />
          )}
        </Panel>
        {sheet.resale && (
          <Panel span={4} title="Revente du même lot" info="resale_annual_rate">
            <Kv
              rows={[
                ...(sheet.resale.previous
                  ? ([
                      [
                        'Achat précédent',
                        <NavLink key="p" href={`/vente/${encodeURIComponent(sheet.resale.previous.id)}`} navigate={navigate} className="cy-more">
                          {formatDate(sheet.resale.previous.date)} · {formatEuros(sheet.resale.previous.price)}
                        </NavLink>,
                      ],
                    ] as [string, ReactNode][])
                  : []),
                ['Cette vente', `${formatDate(sale.date)} · ${formatEuros(sale.price)}`],
                ...(sheet.resale.next
                  ? ([
                      [
                        'Revente suivante',
                        <NavLink key="n" href={`/vente/${encodeURIComponent(sheet.resale.next.id)}`} navigate={navigate} className="cy-more">
                          {formatDate(sheet.resale.next.date)} · {formatEuros(sheet.resale.next.price)}
                        </NavLink>,
                      ],
                    ] as [string, ReactNode][])
                  : []),
                ['Détention', sheet.resale.holding_years == null ? '—' : `${formatDecimal(sheet.resale.holding_years)} ans`],
                [
                  'Plus-value',
                  <span key="g" className={(sheet.resale.gain ?? 0) >= 0 ? 'pos' : 'neg'}>
                    {sheet.resale.gain == null ? '—' : `${sheet.resale.gain > 0 ? '+' : ''}${formatEuros(sheet.resale.gain)}`}
                  </span>,
                ],
                [
                  'Par an',
                  <span key="r" className={(sheet.resale.annual_rate ?? 0) >= 0 ? 'pos' : 'neg'}>
                    {formatSignedPercent(sheet.resale.annual_rate)}
                  </span>,
                  'resale_annual_rate',
                ],
              ]}
            />
            <div className="cy-note" style={{ marginTop: 6 }}>
              Prix bruts : sans frais de notaire, travaux ni impôt sur la plus-value.
            </div>
          </Panel>
        )}

        {/* ================ the building */}
        <Panel span={6} title={`Autres ventes de l’immeuble · ${others.length}`} info="building_sales">
          {others.length === 0 ? (
            <EmptyState>Seule vente connue de cet immeuble dans la fenêtre DVF.</EmptyState>
          ) : (
            <Chart
              ariaLabel="Prix au m² des ventes de l’immeuble par date ; cette vente en couleur"
              height={220}
              onClick={(p) => Array.isArray(p.data) && p.data[2] !== sale.id && navigate(`/vente/${encodeURIComponent(String(p.data[2]))}`)}
              option={{
                grid: { left: 52, right: 12, top: 22, bottom: 24 },
                legend: { top: 0, left: 6, icon: 'circle', itemWidth: 8, itemHeight: 8, data: ['Cette vente', 'Autres ventes'] },
                tooltip: {
                  trigger: 'item',
                  formatter: (p: { data: [number, number, string] }) =>
                    `${formatDate(new Date(p.data[0]).toISOString())}<br/>${formatEurosPerM2(p.data[1])}`,
                },
                xAxis: { type: 'time', ...axisStyle(), axisLabel: { color: tokens.ink3, fontSize: 10 }, splitLine: { show: false } },
                yAxis: { type: 'value', scale: true, ...axisStyle() },
                series: [
                  {
                    name: 'Autres ventes',
                    type: 'scatter',
                    symbolSize: 7,
                    color: tokens.ink3,
                    data: others.filter((s) => s.price_m2 != null).map((s) => [dateMs(s.date), s.price_m2, s.id]),
                  },
                  {
                    name: 'Cette vente',
                    type: 'scatter',
                    symbolSize: 11,
                    color: SERIES_COLORS[1],
                    data: sale.price_m2 != null ? [[dateMs(sale.date), sale.price_m2, sale.id]] : [],
                  },
                ],
              }}
            />
          )}
        </Panel>
        <Panel span={6} flush title="Liste des ventes de l’immeuble">
          <TableWrap maxHeight={260}>
            <table className="cy-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th className="num">P.</th>
                  <th className="num">Surface</th>
                  <th className="num">€/m²</th>
                  <th aria-label="Fiche" />
                </tr>
              </thead>
              <tbody>
                {buildingList.map((s) => (
                  <tr key={s.id} className={s.id === sale.id ? 'selected' : undefined}>
                    <td>{formatDate(s.date)}</td>
                    <td>{SALE_TYPE_LABELS[s.type]}</td>
                    <td className="num">{s.rooms ?? '—'}</td>
                    <td className="num">{s.surface == null ? '—' : `${formatCount(Math.round(s.surface))} m²`}</td>
                    <td className="num">{s.price_m2 == null ? '—' : formatCount(Math.round(s.price_m2))}</td>
                    <td>
                      {s.id === sale.id ? (
                        <span className="ink-3">cette vente</span>
                      ) : (
                        <NavLink href={`/vente/${encodeURIComponent(s.id)}`} navigate={navigate} className="cy-more">
                          Voir la fiche →
                        </NavLink>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Panel>

        {/* ================ if bought to rent */}
        <Panel span={7} title="Si c’était pour louer" info="gross_yield" tools={
          <NavLink className="cy-button ghost" href={simulator} navigate={navigate}>
            Simuler ce bien →
          </NavLink>
        }>
          {noPlace ? (
            <EmptyState>Pas de fichier de marché publié pour {sale.commune.name} : loyer inconnu.</EmptyState>
          ) : !place ? (
            <EmptyState>Chargement du marché de {sale.commune.name}…</EmptyState>
          ) : !surface || !deal ? (
            <EmptyState>Pas de loyer ANIL publié pour ce bien ici, ou surface inconnue.</EmptyState>
          ) : (
            <>
              <Ribbon
                items={[
                  { label: 'Loyer d’annonce', value: formatRentPerM2(rent.rentM2), info: 'rent_m2', detail: `CC, à ${Math.round(surface)} m²` },
                  { label: 'Loyer / mois', value: formatEuros(rent.rentMonthly), detail: 'hors charges' },
                  { label: 'Rdt brut', value: formatPercent(deal.grossYield), info: 'deal_gross_yield' },
                  { label: 'Rdt net', value: formatPercent(deal.netYield), info: 'net_yield' },
                  { label: 'Cash-flow', value: `${formatEuros(Math.round(deal.cashFlowMonthly))} / mois`, info: 'cash_flow_monthly', tone: deal.cashFlowMonthly >= 0 ? 'pos' : 'neg' },
                ]}
              />
              <Kv
                rows={[
                  ['Coût total (notaire compris)', formatEuros(Math.round(deal.totalCost)), 'total_cost'],
                  ['Mensualité du crédit', `${formatEuros(Math.round(deal.paymentMonthly))} / mois`, 'payment_monthly'],
                  ['Années de loyer pour le prix', payback == null ? '—' : `${formatDecimal(payback)} ans`, 'price_to_rent_years'],
                ]}
              />
              <div className="cy-note" style={{ marginTop: 6 }}>
                Au prix de cette vente, loyer d’annonce ANIL de {sale.commune.name} à sa surface moins la provision de charges,
                financement par défaut (10 % d’apport, 20 ans, taux du simulateur), un mois de vacance par an. Loyers actuels,
                prix passé : un ordre de grandeur, pas une offre.
              </div>
            </>
          )}
        </Panel>

        {/* ================ context */}
        <Panel span={5} title={`Contexte · ${sale.commune.name}`}>
          {!place ? (
            <EmptyState>{noPlace ? 'Pas de fichier de marché publié pour cette commune.' : 'Chargement…'}</EmptyState>
          ) : (
            <Kv
              rows={[
                [`Prix médian (${typeWord}s, ${allSizes?.period ?? '—'})`, formatEurosPerM2(allSizes?.median_price_m2), 'median_price_m2'],
                ['Sur un an', formatSignedPercent(allSizes?.yoy_change), 'yoy_change'],
                ['Logements vacants', formatPercent(place.socio?.vacancy_rate), 'vacancy_rate'],
                ['Locataires', formatPercent(place.socio?.renter_share), 'tenant_share'],
                ['Encadrement des loyers', place.rent_control ? 'oui' : 'non', 'rent_control'],
                ['Passoires F/G', formatPercent(energy?.share_fg), 'share_fg'],
                [
                  'Taux de taxe foncière',
                  place.local_tax ? `${formatPercent(place.local_tax.tfpb_rate)} (${place.local_tax.tax_year})` : '—',
                  'tfpb_rate',
                ],
              ]}
            />
          )}
          <div className="cy-chips" style={{ marginTop: 8 }}>
            <NavLink className="cy-button ghost" href={communeHref} navigate={navigate}>
              Marché de {sale.commune.name}
            </NavLink>
            <NavLink className="cy-button ghost" href={`/property?commune=${sale.commune.code}`} navigate={navigate}>
              Analyser un bien ici
            </NavLink>
          </div>
        </Panel>
      </div>
    </Shell>
  );
};
