// Explorer table helpers: one row per place and segment (explorer/*.json), filtered to one comparable
// segment, sorted, exported. Everything here is selection over published aggregates, no KPI maths.
import { normalize } from './search.ts';
import { LOW_CONFIDENCE_SALES } from './select.ts';
import type { DwellingType, GeoLevel, Reliability, RoomsBucket } from './types.ts';

export type ExplorerRow = {
  code: string;
  name: string;
  level: GeoLevel;
  parent: string | null;
  type: DwellingType;
  size: RoomsBucket;
  n_sales: number;
  reliability: Reliability;
  median_price_m2: number;
  p25_price_m2: number | null;
  p75_price_m2: number | null;
  median_price: number | null;
  median_surface_m2: number | null;
  yoy_change: number | null;
  cagr: number | null;
  new_premium: number | null;
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
  median_living_standard: number | null;
  tenant_share: number | null;
  tfpb_rate: number | null;
  rent_control: boolean | null;
  flag_high_vacancy: boolean | null;
  flag_population_decline: boolean | null;
};

export type SegmentFilter = { type: DwellingType | 'all'; size: RoomsBucket; reliable: boolean };
/** [min, max] per numeric field; null = open end. */
export type Ranges = Partial<Record<keyof ExplorerRow, [number | null, number | null]>>;

export const filterRows = (rows: ExplorerRow[], segment: SegmentFilter, ranges: Ranges, query = ''): ExplorerRow[] => {
  const needle = normalize(query);
  const bounds = Object.entries(ranges) as [keyof ExplorerRow, [number | null, number | null]][];
  return rows.filter((row) => {
    if (row.type !== segment.type || row.size !== segment.size) {
      return false;
    }
    if (segment.reliable && row.n_sales < LOW_CONFIDENCE_SALES) {
      return false;
    }
    if (needle && !normalize(row.name ?? row.code).includes(needle)) {
      return false;
    }
    return bounds.every(([key, [min, max]]) => {
      const value = row[key];
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return false;
      }
      return (min == null || value >= min) && (max == null || value <= max);
    });
  });
};

const isMissing = (value: unknown) => value == null || (typeof value === 'number' && Number.isNaN(value));

/** Sorted copy; missing values always go last. */
export const sortRows = <T extends Record<string, unknown>>(rows: T[], key: keyof T, dir: 'asc' | 'desc'): T[] => {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (isMissing(x) || isMissing(y)) {
      return Number(isMissing(x)) - Number(isMissing(y));
    }
    if (typeof x === 'number' && typeof y === 'number') {
      return (x - y) * sign;
    }
    return String(x).localeCompare(String(y), 'fr') * sign;
  });
};

const csvCell = (value: unknown): string => {
  if (isMissing(value)) {
    return '';
  }
  const text = String(value);
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** Semicolon CSV (what French spreadsheets open directly), CRLF line ends. */
export const toCsv = <T extends Record<string, unknown>>(rows: T[], fields: (keyof T & string)[]): string =>
  [fields.join(';'), ...rows.map((row) => fields.map((f) => csvCell(row[f])).join(';'))].map((l) => `${l}\r\n`).join('');

/** Equal-width bins between the smallest and largest value. */
export const histogram = (values: (number | null | undefined)[], bins: number): { edges: number[]; counts: number[] } => {
  const clean = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (clean.length === 0) {
    return { edges: [], counts: [] };
  }
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  if (min === max) {
    return { edges: [min, max], counts: [clean.length] };
  }
  const width = (max - min) / bins;
  const edges = Array.from({ length: bins + 1 }, (_, i) => min + i * width);
  edges[bins] = max;
  const counts = new Array<number>(bins).fill(0);
  for (const v of clean) {
    counts[Math.min(bins - 1, Math.floor((v - min) / width))] += 1;
  }
  return { edges, counts };
};

/** Map / filter indicator (METRICS base) → explorer column. */
export const EXPLORER_METRIC: Record<string, keyof ExplorerRow> = {
  price: 'median_price_m2',
  yield: 'gross_yield',
  net_yield: 'net_yield',
  cash_flow: 'cash_flow_monthly',
  trend: 'cagr',
  score: 'score',
  share_fg: 'share_fg',
  vacancy: 'vacancy_rate',
  population_growth: 'population_growth_yearly',
  tfpb_rate: 'tfpb_rate',
};

/** Indicators stored as fractions but read in % on screen. */
export const PERCENT_METRICS = new Set(['yield', 'net_yield', 'trend', 'share_fg', 'vacancy', 'population_growth', 'tfpb_rate']);

/** A min / max typed by the user, in the unit shown on screen; null when empty or not a number. */
export const parseBound = (text: string, metricBase: string): number | null => {
  const value = Number.parseFloat(text.replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(value)) {
    return null;
  }
  return PERCENT_METRICS.has(metricBase) ? value / 100 : value;
};
