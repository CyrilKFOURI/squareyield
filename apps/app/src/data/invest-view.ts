// Investir ① "Trouver une ville" (docs/features/017-guided-levels/spec.md): the national commune ranking and the
// communes of one département brought to one row shape, so the 015 filters, the investor ribbon, the yield ×
// price-change quadrant and the bar chart read the same fields whatever the scope. Selection over published rows.
import type { ExplorerRow } from './explorer.ts';
import type { DwellingType, GeoLevel, Reliability, RankingRow, RoomsBucket } from './types.ts';

/** Nothing is shown under this many sales (spec 017); under 30 a row carries a low-reliability badge. */
export const MIN_SALES = 10;

export type InvestRow = {
  code: string;
  name: string;
  level: GeoLevel;
  departement: string | null;
  region: string | null;
  type: DwellingType;
  size: RoomsBucket;
  n_sales: number;
  reliability: Reliability;
  median_price_m2: number;
  p25_price_m2: number | null;
  p75_price_m2: number | null;
  /** Typical price of the segment: `median_price` in explorer files, `typical_price` in the ranking. */
  median_price: number | null;
  median_surface_m2: number | null;
  yoy_change: number | null;
  cagr: number | null;
  rent_m2: number | null;
  gross_yield: number | null;
  net_yield: number | null;
  cash_flow_monthly: number | null;
  cap_rate: number | null;
  score: number | null;
  share_fg: number | null;
  vacancy_rate: number | null;
  population: number | null;
  population_growth_yearly: number | null;
  tfpb_rate: number | null;
  rent_control: boolean | null;
  flag_high_vacancy: boolean | null;
  flag_population_decline: boolean | null;
};

/** National ranking (ranking/<type>_<size>.json): communes only, arrondissements stay on their commune page. */
export const fromRanking = (rows: RankingRow[]): InvestRow[] =>
  rows
    .filter((r) => r.level === 'commune' && r.n_sales >= MIN_SALES)
    .map((r) => ({
      code: r.code,
      name: r.name,
      level: r.level,
      departement: r.departement,
      region: r.region,
      type: r.property_type,
      size: r.rooms_bucket,
      n_sales: r.n_sales,
      reliability: r.reliability,
      median_price_m2: r.median_price_m2,
      p25_price_m2: null,
      p75_price_m2: null,
      median_price: r.typical_price,
      median_surface_m2: r.median_surface_m2,
      yoy_change: r.yoy_change,
      cagr: r.cagr,
      rent_m2: r.rent_m2,
      gross_yield: r.gross_yield,
      net_yield: r.net_yield,
      cash_flow_monthly: r.cash_flow_monthly,
      cap_rate: r.cap_rate,
      score: r.score,
      share_fg: r.share_fg,
      vacancy_rate: r.vacancy_rate,
      population: r.population,
      population_growth_yearly: r.population_growth_yearly,
      tfpb_rate: r.tfpb_rate,
      rent_control: r.rent_control,
      flag_high_vacancy: r.flag_high_vacancy,
      flag_population_decline: r.flag_population_decline,
    }));

/** Communes of one département (explorer/communes/<dep>.json) for one segment; `region` = the département's région. */
export const fromExplorer = (rows: ExplorerRow[], segment: { type: DwellingType; size: RoomsBucket }, region: string | null): InvestRow[] =>
  rows
    .filter((r) => r.level === 'commune' && r.type === segment.type && r.size === segment.size && r.n_sales >= MIN_SALES)
    .map((r) => ({
      code: r.code,
      name: r.name,
      level: r.level,
      departement: r.parent,
      region,
      type: r.type,
      size: r.size,
      n_sales: r.n_sales,
      reliability: r.reliability,
      median_price_m2: r.median_price_m2,
      p25_price_m2: r.p25_price_m2,
      p75_price_m2: r.p75_price_m2,
      median_price: r.median_price,
      median_surface_m2: r.median_surface_m2,
      yoy_change: r.yoy_change,
      cagr: r.cagr,
      rent_m2: r.rent_m2,
      gross_yield: r.gross_yield,
      net_yield: r.net_yield,
      cash_flow_monthly: r.cash_flow_monthly,
      cap_rate: r.cap_rate,
      score: r.score,
      share_fg: r.share_fg,
      vacancy_rate: r.vacancy_rate,
      population: r.population,
      population_growth_yearly: r.population_growth_yearly,
      tfpb_rate: r.tfpb_rate,
      rent_control: r.rent_control,
      flag_high_vacancy: r.flag_high_vacancy,
      flag_population_decline: r.flag_population_decline,
    }));

const known = (values: (number | null | undefined)[]): number[] =>
  values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

export const median = (values: (number | null | undefined)[]): number | null => {
  const sorted = known(values).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export type InvestorSummary = {
  count: number;
  grossYield: number | null;
  netYield: number | null;
  /** Share of the towns with a cash-flow whose cash-flow is ≥ 0. */
  positiveCashFlow: number | null;
  price: number | null;
  score: number | null;
};

export const investorSummary = (rows: InvestRow[]): InvestorSummary => {
  const flows = known(rows.map((r) => r.cash_flow_monthly));
  return {
    count: rows.length,
    grossYield: median(rows.map((r) => r.gross_yield)),
    netYield: median(rows.map((r) => r.net_yield)),
    positiveCashFlow: flows.length ? flows.filter((v) => v >= 0).length / flows.length : null,
    price: median(rows.map((r) => r.median_price)),
    score: median(rows.map((r) => r.score)),
  };
};

export type QuadrantKey = 'up' | 'value' | 'growth' | 'weak';
export type QuadrantAxis = 'yoy_change' | 'cagr';

/** The four corners of the yield × price-change chart, in plain words; `corner` places the label. */
export const QUADRANTS: Record<QuadrantKey, { label: string; hint: string; corner: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' }> = {
  up: { label: 'Rentable et en hausse', hint: 'rendement et évolution au-dessus de la médiane', corner: 'top-right' },
  value: { label: 'Rentable, prix à la traîne', hint: 'bon rendement, prix qui montent moins (ou baissent)', corner: 'top-left' },
  growth: { label: 'Peu rentable, en hausse', hint: 'on paie la hausse des prix par un rendement faible', corner: 'bottom-right' },
  weak: { label: 'Peu rentable et à la traîne', hint: 'rendement et évolution sous la médiane', corner: 'bottom-left' },
};

/** Quadrant of a point; a value on the median counts as above. */
export const quadrantOf = (x: number, y: number, xMid: number, yMid: number): QuadrantKey =>
  y >= yMid ? (x >= xMid ? 'up' : 'value') : x >= xMid ? 'growth' : 'weak';

export const quadrantView = (rows: InvestRow[], axis: QuadrantAxis) => {
  const usable = rows.filter((r) => r.gross_yield != null && r[axis] != null);
  const xMid = median(usable.map((r) => r[axis])) ?? 0;
  const yMid = median(usable.map((r) => r.gross_yield)) ?? 0;
  const points = usable.map((row) => {
    const x = row[axis] as number;
    const y = row.gross_yield as number;
    return { row, x, y, quadrant: quadrantOf(x, y, xMid, yMid) };
  });
  const counts: Record<QuadrantKey, number> = { up: 0, value: 0, growth: 0, weak: 0 };
  points.forEach((p) => {
    counts[p.quadrant] += 1;
  });
  return { xMid, yMid, points, counts };
};

/** Value at quantile q (0…1) of a sorted list, linear between neighbours. */
const quantile = (sorted: number[], q: number): number => {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const next = sorted[Math.min(base + 1, sorted.length - 1)];
  return sorted[base] + (next - sorted[base]) * (pos - base);
};

/**
 * Axis frame of a scatter: the quantiles [low, high] of the values (a few towns with extreme changes would squash
 * the rest), widened to keep `mid` (the median cross) inside, plus a small margin.
 */
export const robustRange = (values: number[], low: number, high: number, mid: number): [number, number] => {
  const sorted = known(values).sort((a, b) => a - b);
  const lo = Math.min(sorted.length ? quantile(sorted, low) : mid, mid);
  const hi = Math.max(sorted.length ? quantile(sorted, high) : mid, mid);
  const margin = Math.max((hi - lo) * 0.04, 0.001);
  return [lo - margin, hi + margin];
};

export type BarMetricKey = 'score' | 'gross_yield' | 'net_yield' | 'cash_flow_monthly';

/** Measures of the top-20 bar chart; `kind` picks the number format on screen. */
export const BAR_METRICS: { key: BarMetricKey; label: string; kind: 'score' | 'percent' | 'euros'; signed: boolean; value: (row: InvestRow) => number | null }[] = [
  { key: 'score', label: 'Score', kind: 'score', signed: false, value: (r) => r.score },
  { key: 'gross_yield', label: 'Rendement brut', kind: 'percent', signed: false, value: (r) => r.gross_yield },
  { key: 'net_yield', label: 'Rendement net', kind: 'percent', signed: false, value: (r) => r.net_yield },
  { key: 'cash_flow_monthly', label: 'Cash-flow mensuel', kind: 'euros', signed: true, value: (r) => r.cash_flow_monthly },
];

/** Commune (or arrondissement) page of a row, for the chosen type of home. */
export const placeHref = (row: Pick<InvestRow, 'level' | 'code'>, type: DwellingType): string => `/place/${row.level}/${row.code}?type=${type}`;

/** A département code from the URL (01…95, 2A, 2B, 971…976); anything else means the whole of France. */
export const parseDep = (value: string | undefined): string | null =>
  value && /^([0-9]{2}|2[AB]|97[0-9])$/.test(value) ? value : null;
