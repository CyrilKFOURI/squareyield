import { cached } from './cache.ts';
import { DATA_URL, fetchRetry } from './config.ts';
import { checkSchema } from './select.ts';
import type {
  DwellingType,
  GeoLevel,
  IndexPlace,
  Meta,
  Oll,
  OllRow,
  Place,
  PriceRow,
  Ranking,
  RankingRow,
  RoomsBucket,
  YieldRow,
} from './types.ts';

type RawIndex = { fields: string[]; places: unknown[][] };
type RawPlace = Omit<Place, 'prices' | 'yields'> & {
  price_fields: string[];
  prices: unknown[][];
  yield_fields: string[];
  yields: unknown[][];
};

// The pipeline writes rows as compact arrays plus a field list; rebuild objects once here.
const toObjects = <T>(fields: string[], rows: unknown[][]): T[] =>
  rows.map((row) => Object.fromEntries(fields.map((field, i) => [field, row[i]])) as T);

const fetchJson = async <T>(path: string): Promise<T> => {
  const response = await fetchRetry(`${DATA_URL}/${path}`);
  // a dev server or static host answers a missing file with the app page (HTML, status 200)
  const missing = response.ok && (response.headers.get('content-type') ?? '').includes('text/html');
  if (!response.ok || missing) {
    throw new Error(`${path}: HTTP ${missing ? 404 : response.status}`);
  }
  return response.json() as Promise<T>;
};

const indexCache = cached((path) => fetchJson<RawIndex>(path).then((raw) => toObjects<IndexPlace>(raw.fields, raw.places)));

export const loadIndex = (): Promise<IndexPlace[]> => indexCache('index.json');

export const loadPlace = async (level: GeoLevel, code: string): Promise<Place> => {
  const raw = await fetchJson<RawPlace>(`geo/${level}/${code.slice(0, 2)}/${code}.json`);
  if (!checkSchema(raw)) {
    throw new Error('Données en cours de mise à jour : rechargez la page dans quelques minutes.');
  }
  return {
    ...raw,
    prices: toObjects<PriceRow>(raw.price_fields, raw.prices),
    yields: toObjects<YieldRow>(raw.yield_fields, raw.yields),
  };
};

type RawRanking = { period: string; min_sales: number; fields: string[]; rows: unknown[][] };

const rankingCache = cached((slug) =>
  fetchJson<RawRanking>(`ranking/${slug}.json`).then((raw) => ({
    period: raw.period,
    minSales: raw.min_sales,
    rows: toObjects<RankingRow>(raw.fields, raw.rows),
  })),
);

/** One segment of the ranking (ranking/<type>_<size>.json, '5+' written '5p'). */
export const loadRanking = (type: DwellingType, rooms: RoomsBucket): Promise<Ranking> =>
  rankingCache(`${type}_${rooms.replace('+', 'p')}`);

const metaCache = cached((path) => fetchJson<Meta>(path));

/** Source of each block (meta.json), loaded once. */
export const loadMeta = (): Promise<Meta> => metaCache('meta.json');

/** OLL rents in place of one agglomeration. */
export const loadOll = async (aggloCode: string): Promise<Oll> => {
  const raw = await fetchJson<Omit<Oll, 'rows'> & { fields: string[]; rows: unknown[][] }>(`oll/${aggloCode}.json`);
  return { agglomeration: raw.agglomeration, agglo_code: raw.agglo_code, rows: toObjects<OllRow>(raw.fields, raw.rows) };
};

// ---- dashboard files (pipeline/src/rea_pipeline/dashboard.py) --------------------------------------
type RawTable = { period?: string | null; fields: string[]; rows: unknown[][] };

const tableCache = cached((path) =>
  fetchJson<RawTable>(path).then((raw) => ({ period: raw.period ?? null, rows: toObjects<Record<string, unknown>>(raw.fields, raw.rows) })),
);

/** A compact {fields, rows} file as objects, cached per path (a failed fetch is retried next time). */
export const loadTable = <T extends Record<string, unknown>>(path: string): Promise<{ period: string | null; rows: T[] }> =>
  tableCache(path) as Promise<{ period: string | null; rows: T[] }>;

export type CommunePoint = {
  code: string;
  level: 'commune' | 'arrondissement';
  name: string;
  dep: string;
  lon: number;
  lat: number;
  type: DwellingType;
  n: number;
  median_price_m2: number;
  yoy_change: number | null;
  gross_yield: number | null;
  cash_flow_monthly: number | null;
};

export type SectionPoint = {
  section: string;
  commune: string;
  lon: number;
  lat: number;
  type: DwellingType;
  n: number;
  median_price_m2: number;
};

export type SeriesRow = {
  code: string;
  condition: 'existing' | 'new';
  size: RoomsBucket;
  period_type: 'year' | 'half';
  period: string;
  n: number;
  median: number;
  p25: number;
  p75: number;
};

export const loadCommunePoints = () =>loadTable<CommunePoint>('points/communes.json');
export const loadSectionPoints = (dep: string) => loadTable<SectionPoint>(`points/sections/${dep}.json`);
export const loadPointBreaks = (): Promise<Record<string, number[]>> => fetchJson('points/breaks.json');
export const loadSeries = (level: 'france' | 'region' | 'departement', type: PropertyTypeKey) =>
  loadTable<SeriesRow>(`series/${level}_${type}.json`);

type PropertyTypeKey = DwellingType | 'all';

// ---- level pages (docs/features/018-speed-and-map/spec.md): one ready file per page, nothing recomputed here

/** Figures of one place on a level page; yearly arrays align on the file's `years`. */
export type LevelPlace = {
  code: string;
  name: string;
  level: GeoLevel;
  n: number;
  reliability: 'ok' | 'low';
  price: number | null;
  p25: number | null;
  p75: number | null;
  yoy: number | null;
  rent: number | null;
  yield: number | null;
  net_yield: number | null;
  cash_flow: number | null;
  score: number | null;
  /** Price index, France = 100. */
  index: number | null;
  /** m² one year of median living standard buys. */
  m2_income: number | null;
  medians: (number | null)[];
  changes: (number | null)[];
  growth: number | null;
};

export type FranceFigures = {
  price: number | null;
  p25: number | null;
  p75: number | null;
  yoy: number | null;
  n: number | null;
  rent: number | null;
  yield: number | null;
  medians: (number | null)[];
  changes: (number | null)[];
  growth: number | null;
};

export type FranceLevel = {
  period: string | null;
  years: string[];
  types: Record<
    DwellingType,
    {
      france: FranceFigures;
      rows: (LevelPlace & { region: string | null })[];
      curve: { periods: string[]; median: number[]; p25: number[]; p75: number[] };
    }
  >;
};

export type DepartementLevel = {
  code: string;
  name: string;
  period: string | null;
  years: string[];
  region: { code: string | null; name: string | null };
  types: Record<
    DwellingType,
    {
      /** Null when the département has no published cell for this type. */
      kpis: (LevelPlace & { region: string | null; rank: number; ranked: number }) | null;
      curves: { departement: (number | null)[]; region: (number | null)[]; france: (number | null)[] };
      communes: LevelPlace[];
    }
  >;
};

const levelCache = cached((path) => fetchJson<unknown>(path));
export const loadFranceLevel = () => levelCache('levels/france.json') as Promise<FranceLevel>;
export const loadDepartementLevel = (dep: string) => levelCache(`levels/departements/${dep}.json`) as Promise<DepartementLevel>;
