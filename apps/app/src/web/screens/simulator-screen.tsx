'use dom';

// Simulateur: inputs on the left, results on the right (ribbon, then tabs Cash-flow / Fiscalité / Long
// terme / BRRRR). Prefilled with the typical property of the place and segment in the URL (median price
// and surface, ANIL rent at that surface minus the charges provision, local taxe foncière); a property
// analysis passes its own price, surface and rent. All maths is core-kpi, unchanged.
import { type ReactNode, useEffect, useState } from 'react';

import { analyzeDeal, type DealInput, type MarketReference } from '../../core-kpi/deal';
import { breakEvenOccupancy, brrrr, leverageEffect, projectDeal } from '../../core-kpi/projection';
import { DEFAULTS, FR_RULES, TAX_RULES } from '../../core-kpi/rules';
import { sensitivity } from '../../core-kpi/sensitivity';
import { compareTaxRegimes, type TaxRegime } from '../../core-kpi/tax';
import { chargesProvisionM2 } from '../../core-kpi/typical-deal';
import { loadPlace } from '../../data/api';
import { formatDecimal, formatEuros, formatEurosPerM2, formatPercent, formatSignedPercent } from '../../data/format';
import { latestCell, yieldFor } from '../../data/select';
import type { DwellingType } from '../../data/types';
import { axisStyle, Chart, css } from '../charts/chart';
import { FilterBar, Segmented, sizeLabel } from '../components/controls';
import { DataTable } from '../components/data-table';
import { InfoTip, Panel, Ribbon } from '../components/panel';
import { NavLink, Shell } from '../components/shell';
import type { ScreenProps } from '../screen-props';

type Form = Record<keyof Omit<DealInput, 'isNewBuild'>, string>;
type Tab = 'cash' | 'tax' | 'long' | 'brrrr';

const PERCENT = new Set<keyof Form>(['managementShare', 'maintenanceShare', 'loanRate', 'loanInsuranceRate']);
const round = (value: number, step: number) => String(Math.round(value / step) * step);
/** A share as a percent string without float noise (0.035 → '3.5'). */
const pct = (share: number) => String(Math.round(share * 100 * 1000) / 1000);
const parse = (text: string) => {
  const v = Number.parseFloat(String(text).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : 0;
};

const DEFAULT_FORM: Form = {
  price: '200000', surfaceM2: '50', agencyFees: '0', works: '0', furniture: '0', rentMonthly: '800',
  vacancyMonths: String(DEFAULTS.vacancyMonths), taxeFonciereYearly: '800', nonRecoverableChargesYearly: '0',
  pnoInsuranceYearly: String(DEFAULTS.pnoInsuranceYearly), managementShare: pct(DEFAULTS.managementShare),
  maintenanceShare: pct(DEFAULTS.maintenanceShare), downPayment: '21500', loanRate: pct(DEFAULTS.loanRate),
  loanYears: String(DEFAULTS.loanYears), loanInsuranceRate: pct(DEFAULTS.loanInsuranceRate), incomeMonthly: '3000',
  existingDebtMonthly: '0',
};

const FIELDS: { title: string; fields: { key: keyof Form; label: string; unit?: string; info?: string }[] }[] = [
  { title: 'Achat', fields: [
    { key: 'price', label: 'Prix', unit: '€' }, { key: 'surfaceM2', label: 'Surface', unit: 'm²' },
    { key: 'agencyFees', label: 'Frais d’agence', unit: '€' }, { key: 'works', label: 'Travaux', unit: '€' },
    { key: 'furniture', label: 'Meubles', unit: '€' },
  ] },
  { title: 'Location', fields: [
    { key: 'rentMonthly', label: 'Loyer hors charges', unit: '€/mois', info: 'rent_m2' },
    { key: 'vacancyMonths', label: 'Vacance', unit: 'mois/an' },
    { key: 'taxeFonciereYearly', label: 'Taxe foncière', unit: '€/an', info: 'tfpb_rate' },
    { key: 'nonRecoverableChargesYearly', label: 'Charges non récupérables', unit: '€/an' },
    { key: 'pnoInsuranceYearly', label: 'Assurance PNO', unit: '€/an' },
    { key: 'managementShare', label: 'Gestion', unit: '% loyer' }, { key: 'maintenanceShare', label: 'Entretien', unit: '% loyer' },
  ] },
  { title: 'Financement', fields: [
    { key: 'downPayment', label: 'Apport', unit: '€' }, { key: 'loanRate', label: 'Taux', unit: '%' },
    { key: 'loanYears', label: 'Durée', unit: 'ans' }, { key: 'loanInsuranceRate', label: 'Assurance emprunteur', unit: '%' },
    { key: 'incomeMonthly', label: 'Revenus nets', unit: '€/mois' }, { key: 'existingDebtMonthly', label: 'Crédits en cours', unit: '€/mois' },
  ] },
];

const REGIMES: Record<TaxRegime, string> = {
  micro_foncier: 'Nu · micro-foncier', reel_foncier: 'Nu · réel', lmnp_micro: 'Meublé LMNP · micro-BIC', lmnp_reel: 'Meublé LMNP · réel',
};
const tone = (v: number | null | undefined) => (v == null ? undefined : v >= 0 ? 'pos' : 'neg');
const Line = ({ label, value, info, className }: { label: string; value: ReactNode; info?: string; className?: string }) => (
  <tr>
    <td className="ink-2">{label} {info && <InfoTip k={info} />}</td>
    <td className={`num${className ? ` ${className}` : ''}`}>{value}</td>
  </tr>
);

export default function SimulatorScreen({ filters, params, onFilters, onParams, navigate }: ScreenProps) {
  const type: DwellingType = filters.type === 'house' ? 'house' : 'apartment';
  const tab = (['cash', 'tax', 'long', 'brrrr'] as Tab[]).includes(params.tab as Tab) ? (params.tab as Tab) : 'cash';
  const [form, setForm] = useState<Form>(DEFAULT_FORM);
  const [isNew, setIsNew] = useState(false);
  const [prefill, setPrefill] = useState<{ label: string; market?: MarketReference; trend?: { cagr: number; since: number }; note?: string } | null>(null);
  const [marginal, setMarginal] = useState(0.3);
  const [horizon, setHorizon] = useState(15);
  const [growth, setGrowth] = useState({ price: '', rent: '1,5', selling: '0', arv: '' });

  useEffect(() => {
    let current = true;
    const overrides: Partial<Form> = {
      ...(params.price && { price: params.price, downPayment: round(Number(params.price) * (1 + FR_RULES.notaryRateOld) * DEFAULTS.downPaymentShare, 500) }),
      ...(params.surface && { surfaceM2: params.surface }),
      ...(params.rent && { rentMonthly: params.rent }),
    };
    loadPlace(filters.level, filters.code).then((place) => {
      if (!current) {
        return;
      }
      const segment = { propertyType: type, rooms: filters.size };
      const year = latestCell(place.prices, place.latest, segment)?.row;
      const typical = place.typical_deal?.[type]?.[filters.size];
      const rent = year ? yieldFor(place.yields, segment, year.period) : undefined;
      if (!year) {
        setPrefill({ label: `${place.name ?? place.code} : pas assez de ventes pour ce segment` });
        setForm((f) => ({ ...f, ...overrides }));
        return;
      }
      const price = Math.round((typical?.price ?? year.median_price) / 1000) * 1000;
      const surface = typical?.surface_m2 ?? year.median_surface_m2 ?? year.median_price / year.median_price_m2;
      setPrefill({
        label: `${place.name ?? place.code}, ${type === 'house' ? 'maison' : 'appartement'} type ${sizeLabel(type, filters.size)} ${year.period} (prix et surface médians)`,
        market: { medianPriceM2: year.median_price_m2, p25PriceM2: year.p25_price_m2, p75PriceM2: year.p75_price_m2 },
        trend: year.cagr != null && year.cagr_since != null ? { cagr: year.cagr, since: year.cagr_since } : undefined,
        note: rent ? `Loyer ANIL ${formatDecimal(rent.rent_m2)} €/m² charges comprises, moins ${formatDecimal(chargesProvisionM2(type))} €/m² de provision.` : undefined,
      });
      setForm((f) => ({
        ...f,
        price: String(price),
        surfaceM2: String(Math.round(surface)),
        ...(typical && { rentMonthly: round(typical.rent_monthly, 10), taxeFonciereYearly: round(typical.taxe_fonciere_yearly, 10) }),
        downPayment: round(price * (1 + FR_RULES.notaryRateOld) * DEFAULTS.downPaymentShare, 500),
        ...overrides,
      }));
    }, () => {
      // no market data: the property's own figures still apply
      if (current) {
        setPrefill(null);
        setForm((f) => ({ ...f, ...overrides }));
      }
    });
    return () => {
      current = false;
    };
  }, [filters.level, filters.code, type, filters.size, params.price, params.surface, params.rent]);

  const input: DealInput = {
    ...(Object.fromEntries(Object.entries(form).map(([k, t]) => [k, PERCENT.has(k as keyof Form) ? parse(t) / 100 : parse(t)])) as Omit<DealInput, 'isNewBuild'>),
    isNewBuild: isNew,
  };
  const result = analyzeDeal(input, prefill?.market);
  const taxes = compareTaxRegimes(input, result, marginal);
  const best = taxes.filter((t) => t.eligible).reduce((a, b) => (b.cashFlowAfterTaxMonthly > a.cashFlowAfterTaxMonthly ? b : a));
  const trend = prefill?.trend ? Math.max(-0.05, Math.min(0.05, prefill.trend.cagr)) : 0.01;
  const priceGrowth = growth.price === '' ? trend : parse(growth.price) / 100;
  const projection = projectDeal(input, result, {
    horizonYears: horizon, priceGrowth, rentGrowth: parse(growth.rent) / 100, sellingCostShare: parse(growth.selling) / 100,
    regime: best.regime, marginalRate: marginal,
  });
  const leverage = leverageEffect(input, result);
  const occupancy = breakEvenOccupancy(input, result);
  const arv = parse(growth.arv);
  const refi = arv > 0 ? brrrr(arv, result, input.works) : null;
  const rate = input.loanRate;
  const grid = sensitivity(input, [rate - 0.01, rate - 0.005, rate, rate + 0.005, rate + 0.01].filter((r) => r > 0), [-0.1, -0.05, 0, 0.05, 0.1]);
  const value = (y: number) => input.price * (1 + priceGrowth) ** y;

  return (
    <Shell active="simulator" title="Simulateur" navigate={navigate} crumbs={[{ label: prefill?.label ?? 'Valeurs d’exemple' }]}
      filters={<FilterBar filters={filters} onFilters={onFilters} show={['type', 'size']} />}>
      <div className="cy-grid">
        <Panel span={4} title="Hypothèses" flush>
          <div className="cy-sim-form">
            {prefill?.note && <div className="cy-note">{prefill.note}</div>}
            <label className="cy-check"><input type="checkbox" checked={isNew} onChange={(e) => setIsNew(e.target.checked)} /> Neuf (frais de notaire réduits)</label>
            {FIELDS.map((group) => (
              <fieldset key={group.title}>
                <legend>{group.title}</legend>
                {group.fields.map((f) => (
                  <label key={f.key}>
                    <span>{f.label} {f.info && <InfoTip k={f.info} />}</span>
                    <span className="cy-unit">
                      <input className="cy-input num" inputMode="decimal" aria-label={f.label} value={form[f.key]}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
                      <span className="ink-3">{f.unit}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
        </Panel>
        <div style={{ gridColumn: 'span 8', display: 'flex', flexDirection: 'column' }}>
          <Panel span={12} flush>
            <Ribbon items={[
              { label: 'Cash-flow avant impôt', value: `${formatEuros(result.cashFlowMonthly)} / mois`, tone: tone(result.cashFlowMonthly), info: 'cash_flow_monthly' },
              { label: 'Après impôt (meilleur régime)', value: `${formatEuros(best.cashFlowAfterTaxMonthly)} / mois`, tone: tone(best.cashFlowAfterTaxMonthly), detail: REGIMES[best.regime] },
              { label: 'Rentabilité brute / nette', value: `${formatPercent(result.grossYield)} / ${formatPercent(result.netYield)}`, info: 'net_yield' },
              { label: 'Mensualité', value: formatEuros(result.paymentMonthly), detail: `emprunt ${formatEuros(result.loanAmount)}` },
              { label: 'Endettement (HCSF)', value: formatPercent(result.hcsfDebtRatio), tone: result.hcsfOk ? 'pos' : 'neg', detail: `limite ${formatPercent(FR_RULES.hcsfMaxDebtRatio)}` },
              { label: `TRI ${horizon} ans`, value: formatPercent(projection.irr), info: 'irr' },
            ]} />
            <nav className="cy-anchors" aria-label="Onglets">
              {([['cash', 'Cash-flow'], ['tax', 'Fiscalité'], ['long', 'Long terme'], ['brrrr', 'BRRRR']] as [Tab, string][]).map(([id, label]) => (
                <button key={id} type="button" className={tab === id ? 'active' : undefined} onClick={() => onParams({ tab: id === 'cash' ? undefined : id })}>{label}</button>
              ))}
            </nav>
          </Panel>

          {tab === 'cash' && (
            <>
              <Panel span={12} title="Compte annuel, première année">
                <table className="cy-table"><tbody>
                  <Line label="Coût total (notaire inclus)" value={`${formatEuros(result.totalCost)} · notaire ${formatEuros(result.notaryFees)}`} info="total_cost" />
                  <Line label="Loyers encaissés (vacance déduite)" value={formatEuros(result.effectiveRentYearly)} />
                  <Line label="Charges d’exploitation" value={`− ${formatEuros(result.operatingCostsYearly)}`} />
                  <Line label="Revenu net d’exploitation" value={formatEuros(result.noiYearly)} />
                  <Line label="Remboursement du crédit" value={`− ${formatEuros(result.paymentMonthly * 12)}`} />
                  <Line label="Cash-flow annuel avant impôt" value={formatEuros(result.cashFlowMonthly * 12)} className={tone(result.cashFlowMonthly)} />
                  <Line label="Test rapide 70 %" value={`${formatEuros(result.quickTestMonthly)} / mois`} info="quick_test_monthly" className={tone(result.quickTestMonthly)} />
                  <Line label="Cap rate / rendement des fonds propres" value={`${formatPercent(result.capRate)} / ${formatPercent(result.cashOnCash)}`} info="cap_rate" />
                  <Line label="DSCR / occupation minimale" value={`${result.dscr == null ? '—' : formatDecimal(result.dscr)} / ${formatPercent(occupancy)}`} />
                  {result.priceVsMarket != null && <Line label="Prix au m² vs médiane locale" value={`${formatEurosPerM2(result.priceM2)} · ${formatSignedPercent(result.priceVsMarket)}`} />}
                </tbody></table>
              </Panel>
              <Panel span={12} title="Sensibilité : cash-flow mensuel selon le taux et le prix" flush>
                <div className="cy-table-wrap">
                  <table className="cy-table">
                    <thead><tr><th>Taux \ prix</th>{grid[0].cells.map((c) => <th key={c.priceChange} className="num">{formatSignedPercent(c.priceChange)}</th>)}</tr></thead>
                    <tbody>
                      {grid.map((row) => (
                        <tr key={row.rate}>
                          <td className="ink-2">{formatPercent(row.rate)}</td>
                          {row.cells.map((c) => (
                            <td key={c.priceChange} className={`num ${tone(c.cashFlowMonthly) ?? ''}${Math.abs(row.rate - rate) < 1e-9 && c.priceChange === 0 ? ' cy-best' : ''}`}>
                              {Math.round(c.cashFlowMonthly)} €
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </>
          )}

          {tab === 'tax' && (
            <Panel span={12} title="Après impôt, première année" tools={
              <Segmented label="Tranche marginale" options={TAX_RULES.marginalRates.map((r) => ({ value: String(r), label: formatPercent(r) }))} value={String(marginal)} onChange={(v) => setMarginal(Number(v))} />
            } flush>
              <DataTable
                rows={taxes}
                rowKey={(t) => t.regime}
                selected={best.regime}
                columns={[
                  { key: 'regime', label: 'Régime', render: (t) => REGIMES[t.regime] },
                  { key: 'taxable', label: 'Revenu imposable', numeric: true, render: (t) => (t.eligible ? formatEuros(t.taxableIncome) : '—') },
                  { key: 'tax', label: 'Impôt + PS', numeric: true, render: (t) => (t.eligible ? formatEuros(t.totalTax) : '—') },
                  { key: 'cf', label: 'Cash-flow / mois', numeric: true, render: (t) => (t.eligible ? <span className={tone(t.cashFlowAfterTaxMonthly)}>{formatEuros(t.cashFlowAfterTaxMonthly)}</span> : 'non accessible') },
                  { key: 'nn', label: 'Net-net', numeric: true, render: (t) => (t.eligible ? formatPercent(t.netNetYield) : '—') },
                  { key: 'note', label: 'Report', render: (t) => (t.deficit > 0 ? `déficit ${formatEuros(t.deficit)}` : t.carriedDepreciation > 0 ? `amort. ${formatEuros(t.carriedDepreciation)}` : '') },
                ]}
              />
              <div className="cy-note" style={{ padding: '6px 14px' }}>
                Prélèvements sociaux {formatPercent(TAX_RULES.socialRate)}. LMNP réel : bâti amorti sur {TAX_RULES.buildingYears} ans (terrain {formatPercent(TAX_RULES.landShare)} exclu),
                meubles sur {TAX_RULES.furnitureYears} ans ; depuis 2025, amortissements réintégrés dans la plus-value. Ligne surlignée : régime retenu.
              </div>
            </Panel>
          )}

          {tab === 'long' && (
            <>
              <Panel span={12} title={`Sur ${horizon} ans, revente comprise (${REGIMES[best.regime]})`} tools={
                <Segmented label="Horizon" options={[10, 15, 20, 25].map((y) => ({ value: String(y), label: `${y} ans` }))} value={String(horizon)} onChange={(v) => setHorizon(Number(v))} />
              }>
                <div className="cy-filters" style={{ border: 0, padding: 0, marginBottom: 8 }}>
                  {([['price', 'Prix / an (%)', prefill?.trend ? `tendance ${formatSignedPercent(prefill.trend.cagr)} depuis ${prefill.trend.since}` : '+1 % par défaut'],
                    ['rent', 'Loyers et charges / an (%)', ''], ['selling', 'Frais de vente (%)', '']] as const).map(([k, label, hint]) => (
                    <label key={k} className="cy-filter">
                      <span className="cy-filter-label">{label}</span>
                      <input className="cy-input num" style={{ width: 90 }} placeholder={k === 'price' ? formatDecimal(priceGrowth * 100) : ''} value={growth[k]}
                        onChange={(e) => setGrowth({ ...growth, [k]: e.target.value })} aria-label={label} />
                      {hint && <span className="ink-3" style={{ fontSize: 'var(--fs-micro)' }}>{hint}</span>}
                    </label>
                  ))}
                </div>
                <table className="cy-table"><tbody>
                  <Line label="Apport investi" value={formatEuros(projection.equityInvested)} />
                  <Line label={`Revente dans ${horizon} ans`} value={formatEuros(projection.salePrice)} />
                  <Line label="Impôt sur la plus-value" value={formatEuros(projection.capitalGainsTax)} />
                  <Line label="Net de revente (crédit soldé)" value={formatEuros(projection.netSaleProceeds)} />
                  <Line label="TRI / multiple des fonds propres" value={`${formatPercent(projection.irr)} / ${projection.equityMultiple == null ? '—' : `× ${formatDecimal(projection.equityMultiple)}`}`} info="irr" />
                  <Line label="Effet de levier" value={leverage.positive ? `positif (bien ${formatPercent(leverage.propertyReturn)} > crédit ${formatPercent(leverage.debtCost)})` : `négatif (bien ${formatPercent(leverage.propertyReturn)} < crédit ${formatPercent(leverage.debtCost)})`}
                    className={leverage.positive ? 'pos' : 'neg'} />
                </tbody></table>
              </Panel>
              <Panel span={6} title="Cash-flow annuel après impôt">
                <Chart ariaLabel="Cash-flow annuel après impôt" height={220} option={{
                  grid: { left: 56, right: 10, top: 10, bottom: 24 },
                  xAxis: { type: 'category', data: projection.years.map((y) => String(y.year)), ...axisStyle() },
                  yAxis: { type: 'value', ...axisStyle() },
                  series: [{ type: 'bar', data: projection.years.map((y) => ({ value: Math.round(y.cashFlow), itemStyle: { color: y.cashFlow >= 0 ? css('--pos') : css('--neg') } })) }],
                }} />
              </Panel>
              <Panel span={6} title="Patrimoine : valeur du bien et capital restant dû">
                <Chart ariaLabel="Valeur du bien, capital restant dû et patrimoine net" height={220} option={{
                  grid: { left: 64, right: 10, top: 28, bottom: 24 },
                  legend: { top: 0, left: 8 },
                  xAxis: { type: 'category', data: projection.years.map((y) => String(y.year)), ...axisStyle() },
                  yAxis: { type: 'value', ...axisStyle() },
                  series: [
                    { name: 'Valeur', type: 'line', symbol: 'none', color: css('--ink-3'), data: projection.years.map((y) => Math.round(value(y.year))) },
                    { name: 'Capital dû', type: 'line', symbol: 'none', color: css('--neg'), data: projection.years.map((y) => Math.round(y.loanBalance)) },
                    { name: 'Patrimoine net', type: 'line', symbol: 'none', areaStyle: { opacity: 0.12 }, color: css('--accent'),
                      data: projection.years.map((y) => Math.round(value(y.year) - y.loanBalance)) },
                  ],
                }} />
              </Panel>
              <Panel span={12} title="Tableau d’amortissement et flux par année" flush>
                <DataTable rows={projection.years} rowKey={(y) => String(y.year)} maxHeight={320} columns={[
                  { key: 'year', label: 'Année', render: (y) => String(y.year) },
                  { key: 'rent', label: 'Loyers', numeric: true, render: (y) => formatEuros(y.rent) },
                  { key: 'noi', label: 'Revenu net', numeric: true, render: (y) => formatEuros(y.noi) },
                  { key: 'debt', label: 'Crédit payé', numeric: true, render: (y) => formatEuros(y.debtService) },
                  { key: 'interest', label: 'dont intérêts', numeric: true, render: (y) => formatEuros(y.interest) },
                  { key: 'tax', label: 'Impôt', numeric: true, render: (y) => formatEuros(y.tax) },
                  { key: 'cf', label: 'Cash-flow', numeric: true, render: (y) => <span className={tone(y.cashFlow)}>{formatEuros(y.cashFlow)}</span> },
                  { key: 'balance', label: 'Capital dû', numeric: true, render: (y) => formatEuros(y.loanBalance) },
                ]} />
              </Panel>
            </>
          )}

          {tab === 'brrrr' && (
            <Panel span={12} title="BRRRR : acheter, rénover, louer, refinancer">
              <label className="cy-filter" style={{ marginBottom: 8 }}>
                <span className="cy-filter-label">Valeur après travaux</span>
                <span className="cy-unit"><input className="cy-input num" aria-label="Valeur après travaux" value={growth.arv} placeholder={prefill?.market ? String(Math.round(prefill.market.p75PriceM2 * input.surfaceM2)) : ''}
                  onChange={(e) => setGrowth({ ...growth, arv: e.target.value })} /><span className="ink-3">€</span></span>
              </label>
              {!refi ? (
                <div className="cy-note">Saisissez la valeur du bien une fois rénové (repère : P75 de la commune × surface{prefill?.market ? ` ≈ ${formatEuros(prefill.market.p75PriceM2 * input.surfaceM2)}` : ''}).</div>
              ) : (
                <table className="cy-table"><tbody>
                  <Line label="Prix d’achat maximum (règle des 70 %)" value={formatEuros(refi.maxOffer)} className={input.price <= refi.maxOffer ? 'pos' : 'neg'} />
                  <Line label="Refinancement à 75 % de la valeur" value={formatEuros(refi.refinance)} />
                  <Line label="Argent laissé dans l’opération" value={refi.allCashBack ? `aucun (${formatEuros(refi.cashOut)} récupérés)` : formatEuros(refi.cashLeft)} className={refi.allCashBack ? 'pos' : undefined} />
                </tbody></table>
              )}
            </Panel>
          )}
          <Panel span={12} title="Et ensuite">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <NavLink className="cy-button ghost" href={`/place/${filters.level}/${filters.code}?type=${type}&size=${filters.size}`} navigate={navigate}>Voir le marché</NavLink>
              <NavLink className="cy-button ghost" href="/property" navigate={navigate}>Analyser une annonce</NavLink>
            </div>
          </Panel>
        </div>
      </div>
    </Shell>
  );
}
