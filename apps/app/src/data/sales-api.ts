// Sales map, building panel and sale sheet (docs/features/019-sales-map/spec.md "Local API contract"; since
// docs/features/022-full-frontend: read from the static per-commune files, sales-static.ts, no server). The
// types are the local API's, so the screens did not change; `rea-ml serve` stays for development only.
import { building, filtersFromQuery, salesMap, saleSheet, SalesStaticError, type SalesStaticErrorKind } from './sales-static.ts';
import { type SalesFilters, salesQuery } from './sales-view.ts';

export type SaleType = 'apartment' | 'house';

/** One building (parcel) of the map. `median_m2` is null under 3 sales; `m2` (median of its sales, from 1) colours the dot. */
export type Building = {
  id: string;
  lon: number;
  lat: number;
  addresses: string[];
  n: number;
  median_m2: number | null;
  m2: number | null;
  last_date: string;
};

/** GET /sales: the buildings of a commune (or arrondissement, or all of Paris) over the filters. */
export type SalesMap = {
  commune: { code: string; name: string };
  period: { from: string; to: string };
  reference: { n: number; median_m2: number | null };
  buildings: Building[];
};

export type Lot = { number: string; carrez: number | null };

/** One sale of a building, flagged against the filters. Money in €, surfaces in m², ratios as fractions. */
export type BuildingSale = {
  id: string;
  date: string;
  address: string;
  type: SaleType;
  rooms: number | null;
  surface: number | null;
  carrez: number | null;
  land: number | null;
  price: number;
  price_m2: number | null;
  /** Always empty in the static files: lot numbers are not published (decision 022). */
  lots: Lot[];
  n_lots: number;
  n_dependencies: number;
  new: boolean;
  gap_commune: number | null;
  matches_filters: boolean;
};

/** GET /building/<parcel>: `stats` and `street` use the filtered sales, `sales` lists all of them, newest first. */
export type BuildingDetail = {
  id: string;
  lon: number;
  lat: number;
  addresses: string[];
  commune: { code: string; name: string; median_m2: number | null };
  street: { name: string; n: number; median_m2: number | null } | null;
  stats: { n: number; median_m2: number | null; p25_m2: number | null; p75_m2: number | null };
  sales: BuildingSale[];
};

export type SaleDetail = Omit<BuildingSale, 'gap_commune' | 'matches_filters'> &
  Partial<Pick<BuildingSale, 'gap_commune' | 'matches_filters'>> & {
    postcode: string | null;
    section: string | null;
    parcel: string | null;
    lon: number | null;
    lat: number | null;
    location_precision: 'parcel' | 'section' | null;
    commune: { code: string; name: string };
    departement: string;
  };

export type PositionLevel = 'building' | 'street' | 'section' | 'commune';

/** Median of the similar sales at one level; median, gap and percentile are null under 3 sales. */
export type Position = {
  level: PositionLevel;
  n: number;
  median_m2: number | null;
  gap: number | null;
  percentile: number | null;
};

export type ComparableSale = {
  id: string;
  date: string;
  address: string;
  lon: number | null;
  lat: number | null;
  rooms: number | null;
  surface: number | null;
  price: number;
  price_m2: number | null;
  km: number | null;
};

export type ValueToday = {
  level: 'commune' | 'departement';
  from_year: string;
  to_year: string;
  factor: number;
  value: number;
  gain: number;
};

export type ModelEstimate = {
  estimate_m2: number;
  low_m2: number;
  high_m2: number;
  gap: number | null;
  as_of: string;
};

export type ResaleEnd = { id: string; date: string; price: number };

export type Resale = {
  previous: ResaleEnd | null;
  next: ResaleEnd | null;
  holding_years: number | null;
  gain: number | null;
  annual_rate: number | null;
};

export type BuildingSaleLight = {
  id: string;
  date: string;
  type: SaleType;
  rooms: number | null;
  surface: number | null;
  price_m2: number | null;
};

/** GET /sale/<id>: the sale sheet. Rent, yield and cash-flow are computed by the app (public files + core-kpi). */
export type SaleSheet = {
  sale: SaleDetail;
  similar_rule: { surface_ratio: number; rooms: number; months: number };
  position: Position[];
  comparables: ComparableSale[];
  value_today: ValueToday | null;
  model: ModelEstimate | null;
  resale: Resale | null;
  building_sales: BuildingSaleLight[];
};

export type SalesApiErrorKind = SalesStaticErrorKind;
export { SalesStaticError as SalesApiError };

/** `query` is salesQuery(filters): screens pass the string so their effects depend on plain values. */
export const getSalesByQuery = (commune: string, query: string): Promise<SalesMap> => salesMap(commune, filtersFromQuery(query));

/** `commune`: the place whose map shows the building (Paris as a whole finds the parcel's arrondissement). */
export const getBuildingByQuery = (commune: string, parcel: string, query: string): Promise<BuildingDetail> =>
  building(commune, parcel, filtersFromQuery(query));

export const getSales = (commune: string, filters: SalesFilters): Promise<SalesMap> => getSalesByQuery(commune, salesQuery(filters));

export const getBuilding = (commune: string, parcel: string, filters: SalesFilters): Promise<BuildingDetail> =>
  getBuildingByQuery(commune, parcel, salesQuery(filters));

/** Sale ids are "<place code>-<12 hex>" (the sheet's URL finds its file). */
export const getSale = (id: string): Promise<SaleSheet> => saleSheet(id);
