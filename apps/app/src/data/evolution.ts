// Évolution screen helpers: one curve per place for one comparable segment, read from the place file's
// price rows (half-years or years), optionally rebased to 100.
import type { DwellingType, GeoLevel, PriceRow, RoomsBucket } from './types.ts';

export const MAX_PLACES = 6;

export type CurveSegment = {
  type: DwellingType;
  size: RoomsBucket;
  condition: 'existing' | 'new';
  periodType: 'year' | 'half';
};

export type CurvePoint = { period: string; median: number; p25: number; p75: number; n: number; partial: boolean };

export const seriesFor = (prices: PriceRow[], segment: CurveSegment): CurvePoint[] =>
  prices
    .filter(
      (row) =>
        row.property_type === segment.type &&
        row.rooms_bucket === segment.size &&
        row.condition === segment.condition &&
        row.period_type === segment.periodType &&
        // a partial year (edge of the DVF window) only compares by half-year
        !(segment.periodType === 'year' && row.is_partial),
    )
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((row) => ({
      period: row.period,
      median: row.median_price_m2,
      p25: row.p25_price_m2,
      p75: row.p75_price_m2,
      n: row.n_sales,
      partial: row.is_partial,
    }));

/** Index each value on the first non-missing one (= 100). */
export const rebase = (values: (number | null)[], base = 100): (number | null)[] => {
  const first = values.find((v): v is number => v != null && v !== 0);
  return values.map((v) => (v == null || first == null ? null : Math.round((v / first) * base * 10) / 10));
};

export const alignPeriods = (periods: string[][]): string[] => [...new Set(periods.flat())].sort();

const LEVELS: GeoLevel[] = ['france', 'region', 'departement', 'commune', 'arrondissement'];

/** `places=commune:49007,departement:49` → place refs, at most MAX_PLACES. */
export const parsePlaces = (value: string | undefined): { level: GeoLevel; code: string }[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.split(':'))
    .filter(([level, code]) => LEVELS.includes(level as GeoLevel) && /^[0-9A-Za-z]{1,6}$/.test(code ?? ''))
    .map(([level, code]) => ({ level: level as GeoLevel, code }))
    .slice(0, MAX_PLACES);
