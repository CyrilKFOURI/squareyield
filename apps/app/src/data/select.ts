import { type Basis, type DwellingType, type LatestCell, type PriceRow, type PropertyType, type RoomsBucket, SCHEMA_VERSION, type YieldRow } from './types.ts';

export type Segment = { propertyType: PropertyType; rooms: RoomsBucket };

// Below this many sales a median moves a lot from one period to the next (KPI_SPEC §3).
export const LOW_CONFIDENCE_SALES = 30;

const BUCKETS: Record<DwellingType, RoomsBucket[]> = {
  apartment: ['all', '1', '2', '3', '4', '5+'],
  house: ['all', '1-3', '4', '5', '6+'],
};

/** Size buckets of a type, as the pipeline publishes them (houses are larger than flats). */
export const bucketsFor = (type: DwellingType): RoomsBucket[] => BUCKETS[type];

/** The size bucket a property of `rooms` main rooms belongs to ('all' when unknown). */
export const roomsBucketOf = (type: DwellingType, rooms: number): RoomsBucket => {
  if (!(rooms >= 1)) {
    return 'all';
  }
  const n = Math.round(rooms);
  if (type === 'house') {
    return n <= 3 ? '1-3' : n >= 6 ? '6+' : (String(n) as RoomsBucket);
  }
  return n >= 5 ? '5+' : (String(n) as RoomsBucket);
};

/** Files of another schema version are not read as if they were this one. */
export const checkSchema = (doc: { schema_version?: number }): boolean => doc.schema_version === SCHEMA_VERSION;

// Market rows describe existing homes; new builds (condition 'new') are shown apart.
const inSegment = (row: PriceRow, s: Segment) =>
  row.condition === 'existing' && row.property_type === s.propertyType && row.rooms_bucket === s.rooms;

/** Latest calendar year with both halves in the DVF release (partial years are skipped). */
export const latestFullYear = (prices: PriceRow[], segment: Segment): PriceRow | undefined =>
  prices
    .filter((row) => inSegment(row, segment) && row.period_type === 'year' && !row.is_partial)
    .sort((a, b) => a.period.localeCompare(b.period))
    .at(-1);

/**
 * The year row to show for a segment, from the pipeline's `latest` block: the size's own latest
 * complete year, or — when that size only has half-years — the all-sizes year, labelled.
 * Falls back to scanning the rows for files without the block.
 */
export const latestCell = (
  prices: PriceRow[],
  latest: Partial<Record<DwellingType, Partial<Record<RoomsBucket, LatestCell>>>> | undefined,
  segment: Segment,
): { row: PriceRow; basis: Basis } | undefined => {
  const entry = segment.propertyType === 'all' ? undefined : latest?.[segment.propertyType]?.[segment.rooms];
  if (!entry) {
    const row = latestFullYear(prices, segment);
    return row && { row, basis: 'exact' };
  }
  const rooms = entry.basis === 'all_sizes' ? 'all' : segment.rooms;
  const row = prices.find(
    (r) =>
      inSegment(r, { ...segment, rooms }) && r.period_type === 'year' && r.period === entry.year,
  );
  return row && { row, basis: entry.basis };
};

export const latestHalf = (prices: PriceRow[], segment: Segment): PriceRow | undefined =>
  halfYearSeries(prices, segment).at(-1);

export const halfYearSeries = (prices: PriceRow[], segment: Segment): PriceRow[] =>
  prices
    .filter((row) => inSegment(row, segment) && row.period_type === 'half')
    .sort((a, b) => a.period.localeCompare(b.period));

/** New-build cell of the same type and period, if published. */
export const newBuildFor = (prices: PriceRow[], segment: Segment, period: string): PriceRow | undefined =>
  prices.find(
    (row) =>
      row.condition === 'new' &&
      row.property_type === segment.propertyType &&
      row.rooms_bucket === 'all' &&
      row.period === period,
  );

/** Rent and yield of exactly the same cell (type × size × period): never a broader one. */
export const yieldFor = (yields: YieldRow[], segment: Segment, period: string): YieldRow | undefined =>
  yields.find(
    (row) => row.property_type === segment.propertyType && row.rooms_bucket === segment.rooms && row.period === period,
  );

export const EXCLUSION_REASONS: Record<NonNullable<YieldRow['reason']>, string> = {
  price_below_floor: 'prix trop bas pour un marché (ventes atypiques)',
  yield_above_ceiling: 'rendement au-delà de 30 %, signe de ventes atypiques',
};

const DEFAULT_SEGMENTS: Segment[] = [
  { propertyType: 'apartment', rooms: 'all' },
  { propertyType: 'house', rooms: 'all' },
];

/** First segment with a full year of prices: apartments, else houses. */
export const defaultSegment = (prices: PriceRow[]): Segment =>
  DEFAULT_SEGMENTS.find((segment) => latestFullYear(prices, segment)) ?? DEFAULT_SEGMENTS[0];
