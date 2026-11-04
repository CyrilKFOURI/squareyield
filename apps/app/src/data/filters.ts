// Global dashboard filters, kept in the URL so every view can be shared and the back button works
// (docs/features/014-web-dashboard/spec.md §4). Unknown or stale values are normalised, never fatal.
import { METRICS } from './map.ts';
import { bucketsFor, roomsBucketOf } from './select.ts';
import type { DwellingType, GeoLevel, RoomsBucket } from './types.ts';

export type Filters = {
  level: GeoLevel;
  code: string;
  /** 'all' = flats and houses mixed: overview only. */
  type: DwellingType | 'all';
  size: RoomsBucket;
  condition: 'existing' | 'new';
  periodType: 'year' | 'half';
  /** null = latest published period. */
  period: string | null;
  /** Map / explorer indicator (a METRICS base). */
  metric: string;
  /** Hide places under 30 sales. */
  reliable: boolean;
  palette: 'rdylgn' | 'viridis';
};

export const DEFAULT_FILTERS: Filters = {
  level: 'france',
  code: 'FR',
  type: 'apartment',
  size: 'all',
  condition: 'existing',
  periodType: 'year',
  period: null,
  metric: 'price',
  reliable: false,
  palette: 'rdylgn',
};

const LEVELS: GeoLevel[] = ['france', 'region', 'departement', 'commune', 'arrondissement'];
/** FR, a région (2 digits), a département (2A, 971…) or a commune / arrondissement (5 characters). */
const PLACE_CODE = /^(FR|[0-9][0-9AB][0-9]{0,3})$/;
const PERIOD = { year: /^\d{4}$/, half: /^\d{4}-H[12]$/ } as const;

const pick = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** A size of the other type maps to the nearest bucket of this one (old links, type switch). */
const normaliseSize = (type: Filters['type'], size: string | undefined): RoomsBucket => {
  if (!size || type === 'all') {
    return 'all';
  }
  const buckets = bucketsFor(type);
  if (buckets.includes(size as RoomsBucket)) {
    return size as RoomsBucket;
  }
  const rooms = Number.parseInt(size, 10);
  return Number.isNaN(rooms) ? 'all' : roomsBucketOf(type, rooms);
};

export const parseFilters = (params: Record<string, string | string[] | undefined>): Filters => {
  const get = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const type = pick(get('type'), ['apartment', 'house', 'all'] as const, DEFAULT_FILTERS.type);
  const condition = pick(get('condition'), ['existing', 'new'] as const, DEFAULT_FILTERS.condition);
  const periodType = pick(get('periodType'), ['year', 'half'] as const, DEFAULT_FILTERS.periodType);
  const period = get('period');
  const size = normaliseSize(type, get('size'));
  // a level and code pair goes into a file path: anything else than a real place code means France
  const level = LEVELS.includes(get('level') as GeoLevel) ? (get('level') as GeoLevel) : null;
  const code = get('code');
  const place = level && code && PLACE_CODE.test(code) ? { level, code } : { level: DEFAULT_FILTERS.level, code: DEFAULT_FILTERS.code };
  return {
    level: place.level,
    code: place.code,
    type,
    // new builds are published for all sizes only
    size: condition === 'new' ? 'all' : size,
    condition,
    periodType,
    period: period && PERIOD[periodType].test(period) ? period : null,
    metric: pick(get('metric'), METRICS.map((m) => m.base), DEFAULT_FILTERS.metric as never),
    reliable: get('reliable') === '1',
    palette: pick(get('palette'), ['rdylgn', 'viridis'] as const, DEFAULT_FILTERS.palette),
  };
};

/** URL params of a filter state; defaults are left out so links stay short. */
export const toParams = (filters: Filters): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const key of Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]) {
    const value = filters[key];
    if (value === DEFAULT_FILTERS[key] || value == null) {
      continue;
    }
    params[key] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
  }
  return params;
};
