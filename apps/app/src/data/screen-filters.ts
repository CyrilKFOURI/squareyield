// Explorer screen filters (docs/features/015-advanced-filters/spec.md): parsed from the URL, applied to the
// published explorer rows. Selection only; a row missing a filtered value is dropped while that filter is on.
import type { ExplorerRow } from './explorer.ts';

export type ScreenFilters = {
  budget: number | null;
  pmin: number | null;
  pmax: number | null;
  ymin: number | null;
  ymax: number | null;
  cashFlowPositive: boolean;
  popmin: number | null;
  popmax: number | null;
  vacmax: number | null;
  fgmax: number | null;
  rentControl: 'in' | 'out' | null;
  riskyOut: boolean;
  region: string | null;
};

/** URL keys of the screen filters, so a screen can clear them all at once. */
export const SCREEN_FILTER_KEYS = ['budget', 'pmin', 'pmax', 'ymin', 'ymax', 'cf', 'popmin', 'popmax', 'vacmax', 'fgmax', 'rc', 'risky', 'region'] as const;

const number = (text: string | undefined): number | null => {
  const value = Number.parseFloat((text ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
};
const percent = (text: string | undefined): number | null => {
  const value = number(text);
  return value == null ? null : value / 100;
};

export const parseScreenFilters = (params: Record<string, string | undefined>): ScreenFilters => ({
  budget: number(params.budget),
  pmin: number(params.pmin),
  pmax: number(params.pmax),
  ymin: percent(params.ymin),
  ymax: percent(params.ymax),
  cashFlowPositive: params.cf === 'pos',
  popmin: number(params.popmin),
  popmax: number(params.popmax),
  vacmax: percent(params.vacmax),
  fgmax: percent(params.fgmax),
  rentControl: params.rc === 'in' || params.rc === 'out' ? params.rc : null,
  riskyOut: params.risky === 'out',
  region: params.region && /^[0-9]{2}$/.test(params.region) ? params.region : null,
});

export const activeCount = (f: ScreenFilters): number =>
  Object.values(f).filter((v) => v !== null && v !== false).length;

const within = (value: number | null | undefined, min: number | null, max: number | null) =>
  (min == null && max == null) || (value != null && (min == null || value >= min) && (max == null || value <= max));

export const applyScreenFilters = (rows: ExplorerRow[], f: ScreenFilters): ExplorerRow[] =>
  rows.filter(
    (r) =>
      within(r.median_price, null, f.budget) &&
      within(r.median_price_m2, f.pmin, f.pmax) &&
      within(r.gross_yield, f.ymin, f.ymax) &&
      (!f.cashFlowPositive || (r.cash_flow_monthly != null && r.cash_flow_monthly >= 0)) &&
      within(r.population, f.popmin, f.popmax) &&
      within(r.vacancy_rate, null, f.vacmax) &&
      within(r.share_fg, null, f.fgmax) &&
      (f.rentControl == null || Boolean(r.rent_control) === (f.rentControl === 'in')) &&
      (!f.riskyOut || (!r.flag_high_vacancy && !r.flag_population_decline)) &&
      (f.region == null || r.parent === f.region),
  );
