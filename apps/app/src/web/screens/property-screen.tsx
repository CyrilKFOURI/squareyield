'use dom';

// Analyser un bien: a listing (form, or prefilled by the browser extension) against its market. Verdict
// ribbon, then docked panels: price (estimate interval vs asked and the market band, explanation waterfall,
// comparable sales and the commune's section prices on a map), market cell, ANIL rent at the property's own
// surface and OLL, money (short simulation) and risks. The estimate comes from the local API; when it is
// down, every panel that only needs the published files still renders from the chosen commune.
import { useEffect, useRef, useState } from 'react';

import { assessRisk, cashFlowVerdict, type EnergyClass, type PriceVerdict, RENTAL_BAN_YEAR, summary } from '../../core-kpi/assessment';
import { analyzeDeal } from '../../core-kpi/deal';
import { estimateTaxeFonciere, mergeApartmentLand } from '../../core-kpi/estimates';
import { DEFAULTS, FR_RULES } from '../../core-kpi/rules';
import { chargesProvisionM2 } from '../../core-kpi/typical-deal';
import { loadOll, loadPlace, loadSectionPoints, type SectionPoint } from '../../data/api';
import { EFFECT_LABELS, type Estimate, requestEstimate } from '../../data/estimate';
import {
  formatCount,
  formatDecimal,
  formatEuros,
  formatEurosPerM2,
  formatPercent,
  formatRentPerM2,
  formatSignedPercent,
} from '../../data/format';
import { rentAt } from '../../data/rent';
import { colorFor } from '../../data/scales';
import { latestCell, roomsBucketOf, yieldFor } from '../../data/select';
import type { GeoLevel, Oll, Place } from '../../data/types';
import { axisStyle, Chart, css } from '../charts/chart';
import { FilterField, Segmented, sizeLabel } from '../components/controls';
import { DataTable } from '../components/data-table';
import { EmptyState, Panel, Ribbon } from '../components/panel';
import { PlaceSearch } from '../components/place-search';
import { NavLink, Shell } from '../components/shell';
import { MapCanvas } from '../maps/map-canvas';
import { useDark } from '../hooks/use-dark';
import type { ScreenProps } from '../screen-props';

const ENERGY: EnergyClass[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const MAX_EFFECTS = 7;

type Form = {
  address: string;
  type: 'apartment' | 'house';
  surface: string;
  rooms: string;
  land: string;
  dependencies: string;
  price: string;
  isNew: boolean;
  energy: EnergyClass | null;
  commune: { level: GeoLevel; code: string; name: string } | null;
};

const num = (text: string) => {
  const value = Number.parseFloat(text.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : 0;
};

// Paris, Lyon and Marseille: the address resolves to an arrondissement code.
const levelOf = (code: string): GeoLevel => (/^(751|6938|132[01])/.test(code) ? 'arrondissement' : 'commune');

const formFrom = (params: Record<string, string>): Form => ({
  address: params.address ?? '',
  type: params.type === 'house' ? 'house' : 'apartment',
  surface: params.surface ?? '45',
  rooms: params.rooms ?? '2',
  land: params.land ?? '0',
  dependencies: '0',
  price: params.price ?? '150000',
  isNew: false,
  energy: null,
  commune: params.commune ? { level: levelOf(params.commune), code: params.commune, name: params.commune } : null,
});

const NumberInput = ({ label, unit, value, onChange }: { label: string; unit?: string; value: string; onChange: (v: string) => void }) => (
  <FilterField label={label}>
    <span className="cy-unit">
      <input className="cy-input num" inputMode="decimal" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
      {unit && <span className="ink-3">{unit}</span>}
    </span>
  </FilterField>
);

export default function PropertyScreen({ params, navigate }: ScreenProps) {
  const [form, setForm] = useState<Form>(() => formFrom(params));
  const [submitted, setSubmitted] = useState<Form | null>(null);
  const [estimate, setEstimate] = useState<{ value?: Estimate; error?: string; loading: boolean }>({ loading: false });
  const [place, setPlace] = useState<{ key: string; value: Place | null } | null>(null);
  const [oll, setOll] = useState<Oll | null>(null);
  const lastRequest = useRef(0);
  const [sections, setSections] = useState<SectionPoint[] | null>(null);
  const dark = useDark();
  const set = <K extends keyof Form>(key: K) => (value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const code = estimate.value?.code_commune ?? submitted?.commune?.code ?? null;
  const placeKey = code ? `${levelOf(code)}:${code}` : null;

  useEffect(() => {
    if (!code || !placeKey) {
      return;
    }
    let current = true;
    loadPlace(levelOf(code), code).then(
      (value) => current && setPlace({ key: placeKey, value }),
      () => current && setPlace({ key: placeKey, value: null }),
    );
    loadSectionPoints(code.slice(0, code.startsWith('97') ? 3 : 2)).then(
      (table) => current && setSections(table.rows.filter((s) => s.commune === code)),
      () => current && setSections([]),
    );
    return () => {
      current = false;
    };
  }, [code, placeKey]);
  const market = place?.key === placeKey ? place.value : null;
  useEffect(() => {
    if (!market?.oll) {
      return;
    }
    let current = true;
    loadOll(market.oll.agglo_code).then((data) => current && setOll(data), () => undefined);
    return () => {
      current = false;
    };
  }, [market]);

  const analyze = () => {
    const snapshot = form;
    // a late answer to an earlier click must not overwrite the latest one
    const request = ++lastRequest.current;
    setSubmitted(snapshot);
    setEstimate({ loading: true });
    requestEstimate({
      address: snapshot.address,
      property_type: snapshot.type,
      surface_m2: num(snapshot.surface),
      rooms: num(snapshot.rooms),
      land_m2: snapshot.type === 'house' ? num(snapshot.land) : 0,
      n_dependencies: num(snapshot.dependencies),
      is_new_build: snapshot.isNew,
      asked_price: num(snapshot.price),
    }).then(
      (value) => request === lastRequest.current && setEstimate({ value, loading: false }),
      (e: Error) => request === lastRequest.current && setEstimate({ error: e.message, loading: false }),
    );
  };

  const formPanel = (
    <Panel span={12} title="Le bien" tools={params.price ? <span className="cy-tag">pré-rempli depuis l’annonce</span> : undefined}>
      <div className="cy-filters" style={{ border: 0, padding: 0 }}>
        <FilterField label="Adresse (pour l’estimation)">
          <input className="cy-input" style={{ width: 260 }} aria-label="Adresse du bien" placeholder="12 rue Lenepveu, Angers" value={form.address}
            onChange={(e) => set('address')(e.target.value)} />
        </FilterField>
        <FilterField label="Commune (marché, loyers)">
          {form.commune ? (
            <span className="cy-chip">{market?.code === form.commune.code ? market.name : form.commune.name}<button type="button" aria-label="Changer de commune" onClick={() => set('commune')(null)}>×</button></span>
          ) : (
            <PlaceSearch placeholder="Commune…" onPick={(p) => (p.level === 'commune' || p.level === 'arrondissement') && set('commune')({ level: p.level, code: p.code, name: p.name })} />
          )}
        </FilterField>
        <FilterField label="Type">
          <Segmented label="Type" options={[{ value: 'apartment', label: 'Appartement' }, { value: 'house', label: 'Maison' }]} value={form.type} onChange={set('type')} />
        </FilterField>
        <FilterField label="État">
          <Segmented label="Ancien ou neuf" options={[{ value: 'old', label: 'Ancien' }, { value: 'new', label: 'Neuf (VEFA)' }]} value={form.isNew ? 'new' : 'old'}
            onChange={(v) => set('isNew')(v === 'new')} />
        </FilterField>
        <NumberInput label="Prix demandé" unit="€" value={form.price} onChange={set('price')} />
        <NumberInput label="Surface" unit="m²" value={form.surface} onChange={set('surface')} />
        <NumberInput label="Pièces" value={form.rooms} onChange={set('rooms')} />
        {form.type === 'house' && <NumberInput label="Terrain" unit="m²" value={form.land} onChange={set('land')} />}
        <NumberInput label="Parking / cave" value={form.dependencies} onChange={set('dependencies')} />
        <FilterField label="DPE (si connu)">
          <Segmented label="Classe énergie" options={[{ value: '', label: '?' }, ...ENERGY.map((e) => ({ value: e, label: e }))]} value={form.energy ?? ''}
            onChange={(v) => set('energy')((v || null) as EnergyClass | null)} />
        </FilterField>
        <FilterField label=" ">
          <button type="button" className="cy-button" onClick={analyze} disabled={(!form.address && !form.commune) || !(num(form.surface) > 0) || !(num(form.price) > 0)}>
            {estimate.loading ? 'Analyse…' : 'Analyser'}
          </button>
        </FilterField>
      </div>
    </Panel>
  );

  return (
    <Shell active="property" title="Analyser un bien" navigate={navigate} crumbs={[{ label: 'Annonce → marché' }]}>
      <div className="cy-grid">
        {formPanel}
        {!submitted ? (
          <Panel span={12} title="Comment ça marche">
            <div className="cy-note">
              Saisissez l’adresse et la commune, le prix et la surface, puis « Analyser ». L’estimation de prix vient du serveur
              local (<code>cd ml &amp;&amp; uv run rea-ml serve</code>) ; le marché, les loyers et le calcul de rentabilité viennent
              des données publiées et s’affichent même sans lui. L’extension navigateur pré-remplit ce formulaire depuis une annonce.
            </div>
          </Panel>
        ) : (
          <Analysis form={submitted} estimate={estimate} market={market} oll={oll && market?.oll?.agglo_code === oll.agglo_code ? oll : null} sections={sections} dark={dark} navigate={navigate} />
        )}
      </div>
    </Shell>
  );
}

const Analysis = ({
  form,
  estimate,
  market,
  oll,
  sections,
  dark,
  navigate,
}: {
  form: Form;
  estimate: { value?: Estimate; error?: string; loading: boolean };
  market: Place | null;
  oll: Oll | null;
  sections: SectionPoint[] | null;
  dark: boolean;
  navigate: ScreenProps['navigate'];
}) => {
  const est = estimate.value;
  const surface = num(form.surface);
  const rooms = num(form.rooms);
  const asked = num(form.price);
  const bucket = roomsBucketOf(form.type, rooms);
  const cell = market ? latestCell(market.prices, market.latest, { propertyType: form.type, rooms: bucket }) : undefined;
  const year = cell?.row;
  const fallback = cell?.basis === 'all_sizes';
  const yieldRow = market && year ? yieldFor(market.yields, { propertyType: form.type, rooms: fallback ? 'all' : bucket }, year.period) : undefined;
  const curve = market?.rent_curve?.[form.type];
  // rent at the property's own surface when the commune's curve is published, else the size cell's rent
  const rentM2 = curve ? rentAt(curve, surface) : yieldRow?.rent_m2;
  const rentMonthly = rentM2 ? Math.round((Math.max(rentM2 - chargesProvisionM2(form.type), 0) * surface) / 10) * 10 : 0;
  const deal = analyzeDeal(
    {
      price: asked, surfaceM2: surface, isNewBuild: form.isNew, agencyFees: 0, works: 0, furniture: 0, rentMonthly,
      vacancyMonths: DEFAULTS.vacancyMonths, taxeFonciereYearly: estimateTaxeFonciere(rentMonthly, market?.local_tax?.tfpb_rate),
      nonRecoverableChargesYearly: 0, pnoInsuranceYearly: DEFAULTS.pnoInsuranceYearly, managementShare: DEFAULTS.managementShare,
      maintenanceShare: DEFAULTS.maintenanceShare, downPayment: Math.round(asked * (1 + (form.isNew ? FR_RULES.notaryRateNew : FR_RULES.notaryRateOld)) * DEFAULTS.downPaymentShare),
      loanRate: DEFAULTS.loanRate, loanYears: DEFAULTS.loanYears, loanInsuranceRate: DEFAULTS.loanInsuranceRate, incomeMonthly: 0, existingDebtMonthly: 0,
    },
    year ? { medianPriceM2: year.median_price_m2, p25PriceM2: year.p25_price_m2, p75PriceM2: year.p75_price_m2 } : undefined,
  );
  const priceVerdict: PriceVerdict = !est || est.data_density === 'sparse' || !est.verdict ? 'unknown' : est.verdict;
  const risk = assessRisk({
    highVacancy: Boolean(market?.socio?.flag_high_vacancy),
    populationDecline: Boolean(market?.socio?.flag_population_decline),
    dataDensity: est?.data_density ?? 'medium',
    coarseLocation: est?.location_precision === 'commune',
    energyClass: form.energy,
    currentYear: new Date().getFullYear(),
  });
  const cashFlow = cashFlowVerdict(deal.cashFlowMonthly);
  const typeLabel = form.type === 'house' ? 'maisons' : 'appartements';

  // waterfall: base €/m², then each effect as a step (multiplicative effects applied in order)
  const effects = est ? mergeApartmentLand(est.explanation.effects, form.type) : [];
  const shown = effects.slice(0, MAX_EFFECTS);
  const rest = effects.slice(MAX_EFFECTS).reduce((p, e) => p * (1 + e.effect_pct), 1) - 1;
  const steps = est
    ? (() => {
        let level = est.explanation.base_price_m2;
        const out: { label: string; start: number; end: number }[] = [];
        for (const e of [...shown, ...(effects.length > MAX_EFFECTS ? [{ group: 'autres', effect_pct: rest, log_effect: 0 }] : [])]) {
          const next = level * (1 + e.effect_pct);
          out.push({ label: e.group === 'autres' ? 'Autres facteurs' : (EFFECT_LABELS[e.group] ?? e.group), start: level, end: next });
          level = next;
        }
        return out;
      })()
    : [];

  // sections of the commune, the property's own one dark
  const sectionPrices = (sections ?? []).filter((s) => s.type === form.type).map((s) => s.median_price_m2).sort((a, b) => a - b);
  const quint = sectionPrices.length >= 5 ? [0.2, 0.4, 0.6, 0.8].map((q) => sectionPrices[Math.floor(q * sectionPrices.length)]) : [];
  const sectionFeatures = (sections ?? []).filter((s) => s.type === form.type).map((s) => ({
    type: 'Feature' as const,
    geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    properties: { ...s, _fill: s.section === est?.section ? css('--ink-1') : colorFor(s.median_price_m2, quint, 'rdylgn', false),
      _r: s.section === est?.section ? 9 : 5 },
  }));
  const bounds = sectionFeatures.length
    ? ([[Math.min(...sectionFeatures.map((f) => f.geometry.coordinates[0])) - 0.01, Math.min(...sectionFeatures.map((f) => f.geometry.coordinates[1])) - 0.01],
        [Math.max(...sectionFeatures.map((f) => f.geometry.coordinates[0])) + 0.01, Math.max(...sectionFeatures.map((f) => f.geometry.coordinates[1])) + 0.01]] as [[number, number], [number, number]])
    : null;
  const ownSection = (sections ?? []).find((s) => s.section === est?.section && s.type === form.type);

  const ollRows = (oll?.rows ?? []).filter((r) => r.property_type === form.type && r.period_built === 'all' && r.tenancy === 'all');
  const ollYear = ollRows.reduce((m, r) => Math.max(m, r.year), 0);
  const ollRooms = rooms >= 4 ? '4+' : String(Math.max(1, Math.round(rooms)));
  const ollCell = ollRows.find((r) => r.year === ollYear && r.rooms === ollRooms) ?? ollRows.find((r) => r.year === ollYear && r.rooms === 'all');

  const simulatorHref = market
    ? `/simulator?level=${market.level}&code=${market.code}&type=${form.type}&size=${bucket}&price=${asked}&surface=${surface}&rent=${rentMonthly}`
    : '/simulator';

  return (
    <>
      <Panel span={12} flush>
        <div className="cy-place-head">
          <b>{est?.location?.label ?? market?.name ?? form.commune?.name ?? '—'}</b>
          <span className="ink-3">{summary(priceVerdict, cashFlow, risk.level)}</span>
        </div>
        <Ribbon
          items={[
            { label: 'Prix demandé', value: formatEuros(asked), detail: `${formatEurosPerM2(asked / surface)} · ${formatDecimal(surface)} m²` },
            { label: 'Estimation', value: est ? formatEuros(est.price) : estimate.loading ? '…' : 'indisponible',
              detail: est ? `${formatEuros(est.price_low)} – ${formatEuros(est.price_high)}` : undefined, info: 'estimate' },
            { label: 'Écart', value: formatSignedPercent(est?.asked_vs_estimate),
              tone: priceVerdict === 'above' ? 'neg' : priceVerdict === 'below' ? 'pos' : undefined,
              detail: { below: 'sous la fourchette', consistent: 'dans la fourchette', above: 'au-dessus', unknown: 'non jugé' }[priceVerdict] },
            { label: 'Marché local', value: formatEurosPerM2(year?.median_price_m2), info: 'median_price_m2',
              detail: year ? `${typeLabel} ${fallback ? 'toutes tailles' : sizeLabel(form.type, bucket)} · ${year.period}` : 'pas de cellule publiée' },
            { label: 'Loyer hors charges', value: rentMonthly ? `${formatEuros(rentMonthly)} / mois` : '—', info: 'rent_m2',
              detail: rentM2 ? `${formatRentPerM2(rentM2)} CC à ${Math.round(surface)} m²` : undefined },
            { label: 'Rentabilité brute / nette', value: `${formatPercent(deal.grossYield)} / ${formatPercent(deal.netYield)}`, info: 'net_yield' },
            { label: 'Cash-flow', value: `${formatEuros(deal.cashFlowMonthly)} / mois`, tone: deal.cashFlowMonthly >= 0 ? 'pos' : 'neg', info: 'cash_flow_monthly' },
            { label: 'Risque', value: { low: 'faible', medium: 'moyen', high: 'élevé' }[risk.level], tone: risk.level === 'high' ? 'neg' : risk.level === 'medium' ? 'warn' : 'pos' },
          ]}
        />
      </Panel>
      {estimate.error && (
        <Panel span={12} title="Estimation de prix indisponible">
          <div className="cy-banner">{estimate.error} Les autres panneaux utilisent la commune choisie.</div>
        </Panel>
      )}

      <Panel span={6} title="Le prix est-il juste ?" info="estimate">
        {!est ? (
          <EmptyState>{estimate.loading ? 'Estimation en cours…' : 'Pas d’estimation : seule la fourchette du marché local est montrée.'}</EmptyState>
        ) : null}
        <Chart
          ariaLabel="Prix demandé face à la fourchette estimée et au marché local"
          height={150}
          option={{
            grid: { left: 120, right: 24, top: 10, bottom: 26 },
            tooltip: { trigger: 'item' },
            xAxis: { type: 'value', scale: true, ...axisStyle(), axisLabel: { ...axisStyle().axisLabel, formatter: (v: number) => `${Math.round(v)}` } },
            yAxis: { type: 'category', data: ['Marché P25 – P75', 'Estimation'], ...axisStyle() },
            series: [
              { type: 'bar', stack: 'r', silent: true, itemStyle: { color: 'transparent' },
                data: [year?.p25_price_m2 ?? null, est?.price_low ? est.price_low / surface : null] },
              { type: 'bar', stack: 'r', barWidth: 14, name: 'Fourchette €/m²', itemStyle: { color: css('--accent'), opacity: 0.35 },
                markLine: { symbol: 'none', silent: true, lineStyle: { color: css('--neg'), width: 2, type: 'solid' },
                  label: { formatter: 'demandé', color: css('--neg'), fontSize: 10 }, data: [{ xAxis: asked / surface }] },
                data: [year ? year.p75_price_m2 - year.p25_price_m2 : null, est ? (est.price_high - est.price_low) / surface : null] },
              { type: 'scatter', name: 'Médiane / estimation', symbol: 'rect', symbolSize: [3, 18], itemStyle: { color: css('--ink-1') },
                data: [[year?.median_price_m2 ?? null, 0], [est?.price_m2 ?? null, 1]] },
            ],
          }}
        />
        <div className="cy-note">
          Prix demandé : <b>{formatEurosPerM2(asked / surface)}</b>.
          {est && ` Le modèle ne voit ni l’état, ni l’étage, ni la vue ; ${formatPercent(est.interval_coverage)} des ventes réelles tombent dans sa fourchette.`}
        </div>
      </Panel>
      <Panel span={6} title="Pourquoi ce prix (€/m²)">
        {steps.length === 0 ? (
          <EmptyState>L’explication vient avec l’estimation.</EmptyState>
        ) : (
          <Chart
            ariaLabel="Décomposition de l’estimation en effets successifs"
            height={Math.max(180, (steps.length + 2) * 26)}
            option={{
              grid: { left: 190, right: 50, top: 6, bottom: 22 },
              tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' },
                formatter: (ps: { dataIndex: number }[]) => {
                  const i = ps[0].dataIndex;
                  if (i === 0) return `Prix de départ : ${formatEurosPerM2(est!.explanation.base_price_m2)}`;
                  if (i === steps.length + 1) return `Estimation : ${formatEurosPerM2(est!.price_m2)}`;
                  const s = steps[i - 1];
                  return `${s.label} : ${formatSignedPercent(s.end / s.start - 1)} (${Math.round(s.end - s.start)} €/m²)`;
                } },
              xAxis: { type: 'value', ...axisStyle() },
              yAxis: { type: 'category', inverse: true, data: ['Prix de départ (France)', ...steps.map((s) => s.label), 'Estimation'], ...axisStyle() },
              series: [
                { type: 'bar', stack: 'w', silent: true, itemStyle: { color: 'transparent' },
                  data: [0, ...steps.map((s) => Math.min(s.start, s.end)), 0] },
                { type: 'bar', stack: 'w', barWidth: 12,
                  label: { show: true, position: 'right', fontSize: 10, color: css('--ink-2'),
                    formatter: (p: { dataIndex: number }) => (p.dataIndex === 0 || p.dataIndex === steps.length + 1 ? ''
                      : formatSignedPercent(steps[p.dataIndex - 1].end / steps[p.dataIndex - 1].start - 1)) },
                  data: [
                    { value: est!.explanation.base_price_m2, itemStyle: { color: css('--ink-3') } },
                    ...steps.map((s) => ({ value: Math.abs(s.end - s.start), itemStyle: { color: s.end >= s.start ? css('--pos') : css('--neg') } })),
                    { value: est!.price_m2, itemStyle: { color: css('--accent') } },
                  ] },
              ],
            }}
          />
        )}
      </Panel>
      <Panel span={7} title={`Ventes comparables${est ? ` · ${est.comparables.length}` : ''}`} flush>
        {!est || est.comparables.length === 0 ? (
          <EmptyState>{est ? 'Aucune vente comparable (même type, surface ±25 %) sur 24 mois.' : 'Les ventes comparables viennent du serveur local.'}</EmptyState>
        ) : (
          <DataTable
            rows={est.comparables}
            rowKey={(r) => `${r.month}-${r.price}-${r.surface_m2}`}
            maxHeight={300}
            columns={[
              { key: 'month', label: 'Mois', render: (r) => r.month },
              { key: 'where', label: 'Où', render: (r) => (r.same_section ? 'même quartier' : 'même commune') },
              { key: 'surface', label: 'Surface', numeric: true, render: (r) => `${formatDecimal(r.surface_m2)} m²` },
              { key: 'rooms', label: 'Pièces', numeric: true, render: (r) => (r.rooms ? String(r.rooms) : '—') },
              ...(form.type === 'house' ? [{ key: 'land', label: 'Terrain', numeric: true, render: (r: Estimate['comparables'][number]) => `${formatCount(r.land_m2)} m²` }] : []),
              { key: 'price', label: 'Prix', numeric: true, render: (r) => formatEuros(r.price) },
              { key: 'm2', label: '€/m²', numeric: true, render: (r) => (
                <span className={r.price_m2 > asked / surface ? 'pos' : 'neg'}>{formatEurosPerM2(r.price_m2)}</span>
              ) },
            ]}
          />
        )}
        <div className="cy-note" style={{ padding: '6px 14px' }}>
          Vert : vendu plus cher au m² que le prix demandé. Ventes individuelles visibles ici seulement (serveur local), jamais publiées.
        </div>
      </Panel>
      <Panel span={5} title="Prix des quartiers de la commune" flush>
        {bounds ? (
          <div style={{ position: 'relative', height: 300 }}>
            <MapCanvas polygons={null} points={{ type: 'FeatureCollection', features: sectionFeatures as never }} dark={dark} bounds={bounds}
              onHover={() => undefined} onClick={() => undefined} style={{ position: 'absolute', inset: 0 }} />
          </div>
        ) : (
          <EmptyState>{sections ? 'Pas assez de ventes par section dans cette commune.' : 'Chargement…'}</EmptyState>
        )}
        <div className="cy-note" style={{ padding: '6px 14px' }}>
          Sections cadastrales (≥ 10 ventes, 2 ans), vert = moins cher.
          {ownSection && ` Section du bien (point foncé) : ${formatEurosPerM2(ownSection.median_price_m2)} sur ${ownSection.n} ventes.`}
        </div>
      </Panel>

      <Panel span={4} title="Marché du bien" info="median_price_m2">
        {!year ? (
          <EmptyState>Pas assez de ventes publiées pour cette commune.</EmptyState>
        ) : (
          <table className="cy-table">
            <tbody>
              <tr><td className="ink-2">Cellule</td><td className="num">{typeLabel} {fallback ? 'toutes tailles' : sizeLabel(form.type, bucket)} · {year.period}</td></tr>
              <tr><td className="ink-2">Médiane</td><td className="num">{formatEurosPerM2(year.median_price_m2)}</td></tr>
              <tr><td className="ink-2">P25 – P75</td><td className="num">{formatEurosPerM2(year.p25_price_m2)} – {formatEurosPerM2(year.p75_price_m2)}</td></tr>
              <tr><td className="ink-2">Sur un an</td><td className="num">{formatSignedPercent(year.yoy_change)}</td></tr>
              <tr><td className="ink-2">Ventes</td><td className="num">{formatCount(year.n_sales)}</td></tr>
              <tr><td className="ink-2">Position du prix demandé</td><td className="num">
                {asked / surface < year.p25_price_m2 ? 'sous le P25' : asked / surface > year.p75_price_m2 ? 'au-dessus du P75' : 'entre P25 et P75'}
              </td></tr>
            </tbody>
          </table>
        )}
        {market && (
          <div style={{ padding: '8px 0 0' }}>
            <NavLink href={`/place/${market.level}/${market.code}?type=${form.type}`} navigate={navigate}>Voir toute la page {market.name} →</NavLink>
          </div>
        )}
      </Panel>
      <Panel span={4} title="Loyer à cette surface" info="rent_m2">
        <table className="cy-table">
          <tbody>
            <tr><td className="ink-2">ANIL, charges comprises</td><td className="num">{formatRentPerM2(rentM2)}</td></tr>
            <tr><td className="ink-2">Méthode</td><td className="num">{curve ? `courbe de la commune à ${Math.round(surface)} m²` : yieldRow ? `cellule ${fallback ? 'toutes tailles' : sizeLabel(form.type, bucket)}` : '—'}</td></tr>
            <tr><td className="ink-2">Provision de charges</td><td className="num">− {formatRentPerM2(chargesProvisionM2(form.type))}</td></tr>
            <tr><td className="ink-2">Loyer hors charges</td><td className="num">{rentMonthly ? `${formatEuros(rentMonthly)} / mois` : '—'}</td></tr>
            {ollCell && <tr><td className="ink-2">OLL en place ({ollCell.rooms === 'all' ? 'toutes tailles' : `${ollCell.rooms} p.`}, {ollCell.year})</td><td className="num">{formatRentPerM2(ollCell.rent_m2_median)}</td></tr>}
            {market?.rent_control && <tr><td className="ink-2">Encadrement des loyers</td><td className="num warn">oui : vérifier le plafond</td></tr>}
          </tbody>
        </table>
      </Panel>
      <Panel span={4} title="L’argent" info="cash_flow_monthly">
        <table className="cy-table">
          <tbody>
            <tr><td className="ink-2">Coût total (frais de notaire inclus)</td><td className="num">{formatEuros(deal.totalCost)}</td></tr>
            <tr><td className="ink-2">Apport ({formatPercent(DEFAULTS.downPaymentShare)})</td><td className="num">{formatEuros(Math.round(asked * (1 + (form.isNew ? FR_RULES.notaryRateNew : FR_RULES.notaryRateOld)) * DEFAULTS.downPaymentShare))}</td></tr>
            <tr><td className="ink-2">Mensualité ({formatPercent(DEFAULTS.loanRate)}, {DEFAULTS.loanYears} ans)</td><td className="num">{formatEuros(deal.paymentMonthly)}</td></tr>
            <tr><td className="ink-2">Cash-flow avant impôt</td><td className={`num ${deal.cashFlowMonthly >= 0 ? 'pos' : 'neg'}`}>{formatEuros(deal.cashFlowMonthly)} / mois</td></tr>
            <tr><td className="ink-2">Rentabilité brute / nette</td><td className="num">{formatPercent(deal.grossYield)} / {formatPercent(deal.netYield)}</td></tr>
          </tbody>
        </table>
        <div style={{ paddingTop: 8 }}>
          <NavLink className="cy-button ghost" href={simulatorHref} navigate={navigate}>Ajuster dans le simulateur →</NavLink>
        </div>
      </Panel>
      <Panel span={12} title="Risques">
        {risk.reasons.length === 0 ? (
          <div className="cy-note">Aucun signal de risque majeur dans les données disponibles.</div>
        ) : (
          <ul className="cy-list">{risk.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        )}
        {!form.energy && (
          <div className="cy-note">
            DPE inconnu : les logements G ne peuvent plus être loués depuis {RENTAL_BAN_YEAR.G}, les F à partir de {RENTAL_BAN_YEAR.F}, les E en {RENTAL_BAN_YEAR.E}.
            {market?.energy?.[form.type] && ` Ici, ${formatPercent(market.energy[form.type]!.share_fg)} des ${typeLabel} diagnostiqués sont F ou G.`}
          </div>
        )}
      </Panel>
    </>
  );
};
