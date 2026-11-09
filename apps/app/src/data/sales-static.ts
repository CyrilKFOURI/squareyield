// Sales map, building panel and sale sheet from the static per-commune files (docs/features/022-full-frontend/spec.md,
// rule 1): data/serve/sales/<code>.json written by `rea sales-static`. A port of the local API
// (ml/src/rea_ml/sales.py, contract in docs/features/019-sales-map/spec.md): same filters, same aggregates, same
// rounding, so the screens show the same numbers without any server. Pure (no React); the last few places stay
// in memory. Sale ids are "<place code>-<12 hex>" so a sheet finds its file from its URL alone.
import { DATA_URL, fetchRetry } from './config.ts';
import type {
  BuildingDetail,
  BuildingSale,
  ComparableSale,
  Position,
  Resale,
  SaleSheet,
  SalesMap,
  SaleType,
  ValueToday,
} from './sales-api.ts';
import type { SalesFilters } from './sales-view.ts';

export const MIN_FIGURE_SALES = 3;
export const SIMILAR_SURFACE_RATIO = 0.2;
export const SIMILAR_ROOMS = 1;
export const SIMILAR_MONTHS = 6;
export const COMPARABLES = 10;
const MIN_YEARS_FOR_RATE = 1;
const CACHED_PLACES = 24; // Paris as a whole is 20 files
const TIMEOUT_MS = 30000;
const DAY_MS = 86400000;

/** Arrondissements of the three split cities. */
const SPLIT: Record<string, string[]> = {
  '75056': Array.from({ length: 20 }, (_, i) => String(75101 + i)),
  '69123': Array.from({ length: 9 }, (_, i) => String(69381 + i)),
  '13055': Array.from({ length: 16 }, (_, i) => String(13201 + i)),
};

export type SalesStaticErrorKind = 'timeout' | 'not_found' | 'server';

/** Raised as a SalesApiError by sales-api.ts; kept separate so this module has no runtime import of it. */
export class SalesStaticError extends Error {
  readonly kind: SalesStaticErrorKind;

  constructor(kind: SalesStaticErrorKind, message: string) {
    super(message);
    this.name = 'SalesStaticError';
    this.kind = kind;
  }
}

// ---- file format (version 1, see pipeline/src/rea_pipeline/sales_static.py)

export type SalesFile = {
  v: number;
  code: string;
  name: string;
  city: string;
  city_name: string;
  dep: string;
  latest: string;
  parcels: { id: string[]; lon: (number | null)[]; lat: (number | null)[]; loc: number[] };
  streets: { key: string[]; name: (string | null)[] };
  postcodes: string[];
  sales: {
    id: string[];
    d: number[];
    p: number[];
    s: (number | null)[];
    c: (number | null)[];
    r: (number | null)[];
    t: number[];
    l: (number | null)[];
    nb: number[];
    pa: number[];
    st: number[];
    no: (string | null)[];
    pc: number[];
    nl: number[];
    nd: number[];
    lk: number[];
    x: number[];
  };
};

export type SaleRow = {
  /** Order in its file: date, then DVF id. */
  idx: number;
  id: string;
  day: number;
  price: number;
  surface: number | null;
  priceM2: number | null;
  carrez: number | null;
  rooms: number | null;
  type: SaleType;
  land: number | null;
  isNew: boolean;
  parcel: string | null;
  lon: number | null;
  lat: number | null;
  precision: number;
  streetKey: string | null;
  street: string | null;
  address: string | null;
  postcode: string | null;
  nLots: number;
  nDependencies: number;
  lot: number;
  excluded: boolean;
  place: string;
};

export type PlaceSales = {
  code: string;
  name: string;
  cityName: string;
  dep: string;
  latest: number;
  rows: SaleRow[];
};

const PRECISIONS = ['', 'commune', 'section', 'parcel'] as const;

export const decodeSalesFile = (file: SalesFile): PlaceSales => {
  const { parcels, streets, postcodes, sales } = file;
  const parcelIds = parcels.id.map((id) => (id.length === 14 ? id : file.code + id));
  let day = 0;
  const rows = sales.id.map((short, i): SaleRow => {
    day += sales.d[i];
    const pa = sales.pa[i];
    const st = sales.st[i];
    const street = st >= 0 ? streets.name[st] : null;
    const number = sales.no[i];
    const surface = sales.s[i];
    return {
      idx: i,
      id: `${file.code}-${short}`,
      day,
      price: sales.p[i],
      surface,
      priceM2: surface ? sales.p[i] / surface : null,
      carrez: sales.c[i],
      rooms: sales.r[i],
      type: sales.t[i] === 1 ? 'house' : 'apartment',
      land: sales.l[i] || null,
      isNew: sales.nb[i] === 1,
      parcel: pa >= 0 ? parcelIds[pa] : null,
      lon: pa >= 0 ? parcels.lon[pa] : null,
      lat: pa >= 0 ? parcels.lat[pa] : null,
      precision: pa >= 0 ? parcels.loc[pa] : 0,
      streetKey: st >= 0 ? streets.key[st] : null,
      street,
      address: street == null ? null : number ? `${number} ${street}` : street,
      postcode: sales.pc[i] >= 0 ? postcodes[sales.pc[i]] : null,
      nLots: sales.nl[i],
      nDependencies: sales.nd[i],
      lot: sales.lk[i],
      excluded: sales.x[i] === 1,
      place: file.code,
    };
  });
  return { code: file.code, name: file.name, cityName: file.city_name, dep: file.dep, latest: isoDay(file.latest), rows };
};

// ---- dates and numbers (same rules as the Python API)

export const isoDay = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};

export const dayIso = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Same calendar day `months` later, clamped to the month's last day (Python _add_months). */
export const addMonths = (day: number, months: number): number => {
  const date = new Date(day * DAY_MS);
  const index = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(date.getUTCDate(), last)) / DAY_MS;
};

/** First day of the `months` months ending on `latest` (2026-06-30, 24 → 2024-07-01). */
export const periodStart = (latest: number, months: number): number => addMonths(latest + 1, -months);

/** Python round(): halves to even. */
export const pyRound = (value: number): number => {
  const floor = Math.floor(value);
  return value - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
};

const intOrNull = (value: number | null | undefined): number | null => (value == null ? null : pyRound(value));

/** DuckDB round(): halves away from zero. */
const duckRound = (value: number): number => Math.sign(value) * Math.round(Math.abs(value));

const roundTo = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  return pyRound(value * scale) / scale;
};

const ratio = (value: number | null): number | null => (value == null ? null : roundTo(value, 4));

export const median = (values: number[]): number | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const medianOrNull = (values: number[]): number | null => (values.length >= MIN_FIGURE_SALES ? median(values) : null);

/** Linear interpolation, like DuckDB quantile_cont. */
const quantile = (sorted: number[], q: number): number => {
  const position = q * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.min(low + 1, sorted.length - 1);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};

const km = (lon1: number | null, lat1: number | null, lon2: number | null, lat2: number | null): number | null => {
  if (lon1 == null || lat1 == null || lon2 == null || lat2 == null) {
    return null;
  }
  const rad = Math.PI / 180;
  const p1 = lat1 * rad;
  const p2 = lat2 * rad;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
};

// ---- filters

/** Market sales of the period meeting the filters (`withType` false: every type). */
export const matchesFilters = (row: SaleRow, f: SalesFilters, latest: number, withType = true): boolean => {
  if (row.excluded || row.day < periodStart(latest, f.months) || row.day > latest) {
    return false;
  }
  if (withType && f.type !== 'all' && row.type !== f.type) {
    return false;
  }
  if (f.rooms != null && (row.rooms == null || (f.rooms === 5 ? row.rooms < 5 : row.rooms !== f.rooms))) {
    return false;
  }
  const surface = row.surface;
  if ((f.surfaceMin != null || f.surfaceMax != null) && surface == null) {
    return false;
  }
  if (f.surfaceMin != null && (surface as number) < f.surfaceMin) {
    return false;
  }
  if (f.surfaceMax != null && (surface as number) > f.surfaceMax) {
    return false;
  }
  if (f.priceMin != null && row.price < f.priceMin) {
    return false;
  }
  return !(f.priceMax != null && row.price > f.priceMax);
};

/** Filters back from the query string of salesQuery (screens pass the string to keep plain effect deps). */
export const filtersFromQuery = (query: string): SalesFilters => {
  const q = new URLSearchParams(query);
  const num = (key: string) => {
    const value = q.get(key);
    const n = value == null || value === '' ? Number.NaN : Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const type = q.get('type');
  const months = Number(q.get('months'));
  const rooms = num('rooms');
  return {
    type: type === 'house' || type === 'all' ? type : 'apartment',
    months: months === 12 || months === 60 ? months : 24,
    rooms: rooms != null && rooms >= 1 && rooms <= 5 ? (Math.floor(rooms) as SalesFilters['rooms']) : null,
    surfaceMin: num('surface_min'),
    surfaceMax: num('surface_max'),
    priceMin: num('price_min'),
    priceMax: num('price_max'),
  };
};

// ---- loading

type Loader = (code: string) => Promise<PlaceSales>;

const cache = new Map<string, Promise<PlaceSales>>();

const fetchPlace: Loader = async (code) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchRetry(`${DATA_URL}/sales/${code.slice(0, 2)}/${code}.json`, { signal: controller.signal });
  } catch {
    throw controller.signal.aborted
      ? new SalesStaticError('timeout', 'Les ventes mettent trop de temps à arriver.')
      : new SalesStaticError('server', 'Ventes indisponibles : vérifiez la connexion.');
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) {
    throw new SalesStaticError('not_found', 'commune introuvable');
  }
  if (!response.ok) {
    throw new SalesStaticError('server', `Erreur ${response.status}`);
  }
  return decodeSalesFile((await response.json()) as SalesFile);
};

/** One place file, kept among the last CACHED_PLACES (a failed load is forgotten so a retry refetches). */
export const loadPlace = (code: string): Promise<PlaceSales> => {
  const known = cache.get(code);
  if (known) {
    cache.delete(code);
    cache.set(code, known);
    return known;
  }
  const loading = fetchPlace(code);
  cache.set(code, loading);
  loading.catch(() => cache.get(code) === loading && cache.delete(code));
  while (cache.size > CACHED_PLACES) {
    cache.delete(cache.keys().next().value as string);
  }
  return loading;
};

export const clearSalesCache = (): void => cache.clear();

/** Files of a code: the arrondissements of Paris, Lyon or Marseille as a whole, else its own. */
const loadCode = async (code: string): Promise<{ places: PlaceSales[]; name: string }> => {
  const parts = SPLIT[code];
  if (!parts) {
    const place = await loadPlace(code);
    return { places: [place], name: place.name };
  }
  const settled = await Promise.allSettled(parts.map(loadPlace));
  const places = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  if (places.length === 0) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }
  return { places, name: places[0].cityName };
};

// ---- /sales

export const salesMap = async (code: string, filters: SalesFilters): Promise<SalesMap> => {
  const { places, name } = await loadCode(code);
  const latest = places[0].latest;
  const rows = places.flatMap((p) => p.rows.filter((r) => matchesFilters(r, filters, p.latest)));
  const values = rows.map((r) => r.priceM2).filter((v): v is number => v != null);
  const groups = new Map<string, SaleRow[]>();
  for (const r of rows) {
    if (r.parcel != null && r.lon != null) {
      const group = groups.get(r.parcel);
      if (group) {
        group.push(r);
      } else {
        groups.set(r.parcel, [r]);
      }
    }
  }
  const buildings = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, group]) => {
      const point = group.reduce((best, r) => (r.precision > best.precision ? r : best), group[0]);
      const m = median(group.map((r) => r.priceM2).filter((v): v is number => v != null));
      return {
        id,
        lon: point.lon as number,
        lat: point.lat as number,
        addresses: [...new Set(group.map((r) => r.address).filter((a): a is string => a != null))].sort(),
        n: group.length,
        median_m2: group.length >= MIN_FIGURE_SALES && m != null ? duckRound(m) : null,
        m2: m == null ? null : duckRound(m),
        last_date: dayIso(Math.max(...group.map((r) => r.day))),
      };
    });
  return {
    commune: { code, name },
    period: { from: dayIso(periodStart(latest, filters.months)), to: dayIso(latest) },
    reference: { n: rows.length, median_m2: intOrNull(medianOrNull(values)) },
    buildings,
  };
};

// ---- /building/<parcel>

type TypeMedians = Record<'apartment' | 'house' | 'all', { n: number; median: number | null }>;

const typeMedians = (place: PlaceSales, filters: SalesFilters): TypeMedians => {
  const rows = place.rows.filter((r) => matchesFilters(r, filters, place.latest, false));
  const of = (list: SaleRow[]) => {
    const values = list.map((r) => r.priceM2).filter((v): v is number => v != null);
    return { n: list.length, median: list.length >= MIN_FIGURE_SALES ? median(values) : null };
  };
  return {
    apartment: of(rows.filter((r) => r.type === 'apartment')),
    house: of(rows.filter((r) => r.type === 'house')),
    all: of(rows),
  };
};

/** Every sale of a parcel in a place, newest first (then DVF id, descending, as the API). */
const parcelRows = (place: PlaceSales, parcel: string): SaleRow[] =>
  place.rows.filter((r) => r.parcel === parcel).sort((a, b) => b.day - a.day || b.idx - a.idx);

const toSale = (row: SaleRow, medians: TypeMedians, matches: boolean): BuildingSale => {
  const reference = medians[row.type].median;
  return {
    id: row.id,
    date: dayIso(row.day),
    address: row.address as string,
    type: row.type,
    rooms: row.rooms,
    surface: row.surface,
    carrez: row.carrez,
    land: row.land,
    price: pyRound(row.price),
    price_m2: intOrNull(row.priceM2),
    lots: [], // lot numbers are not published (decision 022)
    n_lots: row.nLots,
    n_dependencies: row.nDependencies,
    new: row.isNew,
    gap_commune: reference && row.priceM2 != null ? ratio(row.priceM2 / reference - 1) : null,
    matches_filters: matches,
  };
};

const stats = (values: number[]): BuildingDetail['stats'] => {
  if (values.length < MIN_FIGURE_SALES) {
    return { n: values.length, median_m2: null, p25_m2: null, p75_m2: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    median_m2: intOrNull(median(sorted)),
    p25_m2: pyRound(quantile(sorted, 0.25)),
    p75_m2: pyRound(quantile(sorted, 0.75)),
  };
};

const mainStreet = (rows: SaleRow[], place: PlaceSales, filters: SalesFilters): BuildingDetail['street'] => {
  const counts = new Map<string, { key: string; name: string; n: number }>();
  for (const r of rows) {
    if (r.streetKey && r.street) {
      const id = `${r.streetKey}\u0000${r.street}`;
      const entry = counts.get(id) ?? { key: r.streetKey, name: r.street, n: 0 };
      entry.n += 1;
      counts.set(id, entry);
    }
  }
  let best: { key: string; name: string; n: number } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.n > best.n) {
      best = entry;
    }
  }
  if (!best) {
    return null;
  }
  const key = best.key;
  const found = place.rows.filter((r) => r.streetKey === key && matchesFilters(r, filters, place.latest));
  const values = found.map((r) => r.priceM2).filter((v): v is number => v != null);
  return { name: best.name, n: found.length, median_m2: intOrNull(medianOrNull(values)) };
};

/** The place file holding a parcel shown on the map of `code` (a split city: the parcel's arrondissement). */
const placeOfParcel = (code: string, parcel: string): string => (SPLIT[code]?.includes(parcel.slice(0, 5)) ? parcel.slice(0, 5) : code);

export const building = async (code: string, parcel: string, filters: SalesFilters): Promise<BuildingDetail> => {
  if (!/^[0-9A-Z]{14}$/.test(parcel)) {
    throw new SalesStaticError('not_found', 'immeuble introuvable');
  }
  const placeCode = placeOfParcel(code, parcel);
  const { places } = await loadCode(placeCode);
  const place = places.find((p) => p.rows.some((r) => r.parcel === parcel));
  if (!place) {
    throw new SalesStaticError('not_found', 'immeuble introuvable');
  }
  const rows = parcelRows(place, parcel);
  const medians = typeMedians(place, filters);
  const flags = rows.map((r) => matchesFilters(r, filters, place.latest));
  const point = rows.reduce((best, r) => (r.precision > best.precision ? r : best), rows[0]);
  return {
    id: parcel,
    lon: point.lon as number,
    lat: point.lat as number,
    addresses: [...new Set(rows.map((r) => r.address).filter((a): a is string => a != null))].sort(),
    commune: { code: place.code, name: place.name, median_m2: intOrNull(medians[filters.type].median) },
    street: mainStreet(rows, place, filters),
    stats: stats(rows.filter((_, i) => flags[i]).map((r) => r.priceM2).filter((v): v is number => v != null)),
    sales: rows.map((r, i) => toSale(r, medians, flags[i])),
  };
};

// ---- /sale/<id>

const DEFAULT_FILTERS: SalesFilters = {
  type: 'apartment',
  months: 24,
  rooms: null,
  surfaceMin: null,
  surfaceMax: null,
  priceMin: null,
  priceMax: null,
};

const similarSales = (row: SaleRow, place: PlaceSales): SaleRow[] => {
  const surface = row.surface ?? 0;
  const low = surface * (1 - SIMILAR_SURFACE_RATIO);
  const high = surface * (1 + SIMILAR_SURFACE_RATIO);
  const from = addMonths(row.day, -SIMILAR_MONTHS);
  const to = addMonths(row.day, SIMILAR_MONTHS);
  return place.rows.filter(
    (s) =>
      !s.excluded &&
      s.type === row.type &&
      s.surface != null &&
      s.surface >= low &&
      s.surface <= high &&
      s.day >= from &&
      s.day <= to &&
      s.id !== row.id &&
      (!row.rooms || (s.rooms != null && s.rooms >= row.rooms - SIMILAR_ROOMS && s.rooms <= row.rooms + SIMILAR_ROOMS)),
  );
};

const positions = (row: SaleRow, similar: SaleRow[]): Position[] => {
  const prefix = (row.parcel ?? '').slice(0, 5);
  const section = row.parcel ? row.parcel.slice(0, 10) : null;
  const levels: [Position['level'], (s: SaleRow) => boolean][] = [
    ['building', (s) => row.parcel != null && s.parcel === row.parcel],
    ['street', (s) => row.streetKey != null && s.streetKey === row.streetKey && (s.parcel ?? '').slice(0, 5) === prefix],
    ['section', (s) => section != null && s.parcel != null && s.parcel.slice(0, 10) === section],
    ['commune', () => true],
  ];
  const own = row.priceM2 ?? 0;
  return levels.map(([level, keep]) => {
    const values = similar.filter(keep).map((s) => s.priceM2).filter((v): v is number => v != null);
    const reference = medianOrNull(values);
    return {
      level,
      n: values.length,
      median_m2: intOrNull(reference),
      gap: reference ? ratio(own / reference - 1) : null,
      percentile: reference ? ratio(values.filter((v) => v < own).length / values.length) : null,
    };
  });
};

const comparables = (row: SaleRow, similar: SaleRow[]): ComparableSale[] =>
  similar
    .map((s) => ({ s, km: km(row.lon, row.lat, s.lon, s.lat) }))
    .sort(
      (a, b) =>
        (a.km ?? Infinity) - (b.km ?? Infinity) ||
        Math.abs(a.s.day - row.day) - Math.abs(b.s.day - row.day) ||
        a.s.idx - b.s.idx,
    )
    .slice(0, COMPARABLES)
    .map(({ s, km: distance }) => ({
      id: s.id,
      date: dayIso(s.day),
      address: s.address as string,
      lon: s.lon,
      lat: s.lat,
      rooms: s.rooms,
      surface: s.surface,
      price: pyRound(s.price),
      price_m2: intOrNull(s.priceM2),
      km: distance == null ? null : roundTo(distance, 3),
    }));

type LevelsDoc = {
  years?: string[];
  types?: Record<string, { communes?: { code: string; medians?: (number | null)[] }[]; curves?: { departement?: (number | null)[] } }>;
};

const levelsCache = new Map<string, Promise<LevelsDoc | null>>();

/** levels/departements/<dep>.json (already published), null when missing. */
const loadLevels = (dep: string): Promise<LevelsDoc | null> => {
  const known = levelsCache.get(dep);
  if (known) {
    return known;
  }
  const loading = fetchRetry(`${DATA_URL}/levels/departements/${dep}.json`)
    .then((r) => (r.ok ? (r.json() as Promise<LevelsDoc>) : null))
    .catch(() => null);
  levelsCache.set(dep, loading);
  return loading;
};

export const valueToday = (row: SaleRow, doc: LevelsDoc | null): ValueToday | null => {
  const block = doc?.types?.[row.type];
  const years = doc?.years ?? [];
  if (!block || years.length === 0) {
    return null;
  }
  const saleYear = new Date(row.day * DAY_MS).getUTCFullYear();
  let fromIndex = 0;
  years.forEach((y, i) => {
    if (Math.abs(Number(y) - saleYear) <= Math.abs(Number(years[fromIndex]) - saleYear)) {
      fromIndex = i;
    }
  });
  const commune = block.communes?.find((c) => c.code === row.place);
  const series: ['commune' | 'departement', (number | null)[] | undefined][] = [
    ['commune', commune?.medians],
    ['departement', block.curves?.departement],
  ];
  for (const [level, medians] of series) {
    const start = medians?.[fromIndex];
    if (!medians || start == null) {
      continue;
    }
    let toIndex = -1;
    medians.forEach((m, i) => {
      if (m != null) {
        toIndex = i;
      }
    });
    if (toIndex < fromIndex) {
      continue;
    }
    const factor = (medians[toIndex] as number) / start;
    const value = pyRound(row.price * factor);
    return {
      level,
      from_year: years[fromIndex],
      to_year: years[toIndex],
      factor: roundTo(factor, 4),
      value,
      gain: value - pyRound(row.price),
    };
  }
  return null;
};

const resale = (row: SaleRow, buildingRows: SaleRow[]): Resale | null => {
  if (row.type === 'apartment' && !row.lot) {
    return null;
  }
  const others = buildingRows.filter(
    (o) => o.id !== row.id && o.type === row.type && (row.type === 'house' || o.lot === row.lot),
  );
  let before: SaleRow | null = null;
  let after: SaleRow | null = null;
  for (const o of others) {
    if (o.day < row.day && (!before || o.day > before.day)) {
      before = o;
    }
    if (o.day > row.day && (!after || o.day < after.day)) {
      after = o;
    }
  }
  if (!before && !after) {
    return null;
  }
  const [first, last] = before ? [before, row] : [row, after as SaleRow];
  const years = (last.day - first.day) / 365.25;
  const rate = years >= MIN_YEARS_FOR_RATE ? (last.price / first.price) ** (1 / years) - 1 : null;
  const brief = (o: SaleRow | null) => (o ? { id: o.id, date: dayIso(o.day), price: pyRound(o.price) } : null);
  return {
    previous: brief(before),
    next: brief(after),
    holding_years: roundTo(years, 1),
    gain: pyRound(last.price - first.price),
    annual_rate: ratio(rate),
  };
};

/** "<place>-<12 hex>" → its place and row. Old 32-hex ids (local API) carry no place: not found. */
export const parseSaleId = (id: string): { place: string; short: string } | null => {
  const match = /^([0-9][0-9AB][0-9]{3})-([0-9a-f]{12})$/.exec(id);
  return match ? { place: match[1], short: match[2] } : null;
};

export const saleSheet = async (id: string): Promise<SaleSheet> => {
  const parsed = parseSaleId(id);
  if (!parsed) {
    throw new SalesStaticError('not_found', 'vente introuvable');
  }
  let place: PlaceSales;
  try {
    place = await loadPlace(parsed.place);
  } catch (error) {
    throw error instanceof SalesStaticError && error.kind === 'not_found' ? new SalesStaticError('not_found', 'vente introuvable') : error;
  }
  const row = place.rows.find((r) => r.id === id);
  if (!row) {
    throw new SalesStaticError('not_found', 'vente introuvable');
  }
  const filters = DEFAULT_FILTERS;
  const buildingRows = row.parcel ? parcelRows(place, row.parcel) : [row];
  const medians = typeMedians(place, filters);
  const similar = similarSales(row, place);
  const precision = PRECISIONS[row.precision] || null;
  return {
    sale: {
      ...toSale(row, medians, matchesFilters(row, filters, place.latest)),
      postcode: row.postcode,
      section: row.parcel ? row.parcel.slice(0, 10) : null,
      parcel: row.parcel,
      lon: row.lon,
      lat: row.lat,
      location_precision: precision as 'parcel' | 'section' | null,
      commune: { code: place.code, name: place.name },
      departement: place.dep,
    },
    similar_rule: { surface_ratio: SIMILAR_SURFACE_RATIO, rooms: SIMILAR_ROOMS, months: SIMILAR_MONTHS },
    position: positions(row, similar),
    comparables: comparables(row, similar),
    value_today: valueToday(row, await loadLevels(place.dep)),
    model: null, // the price model runs in the "Analyser un bien" page, not on past sales
    resale: resale(row, buildingRows),
    building_sales: buildingRows
      .filter((r) => r.id !== row.id)
      .map((r) => ({ id: r.id, date: dayIso(r.day), type: r.type, rooms: r.rooms, surface: r.surface, price_m2: intOrNull(r.priceM2) })),
  };
};
