// Pure helpers of the sales map and the sale sheet (docs/features/019-sales-map/spec.md): filters ↔ URL and API
// query, building dots (size by sales, colour by median €/m² with the communes map classes), gaps and labels,
// spread of comparables, and the investment figures of one sale (rent from the commune file + core-kpi).
import { analyzeDeal, type DealResult } from '../core-kpi/deal.ts';
import { estimateTaxeFonciere } from '../core-kpi/estimates.ts';
import { DEFAULTS, FR_RULES } from '../core-kpi/rules.ts';
import { chargesProvisionM2 } from '../core-kpi/typical-deal.ts';
import { formatEurosPerM2 } from './format.ts';
import { type RentCurve, rentAt } from './rent.ts';
import type { Building, BuildingSale, Lot } from './sales-api.ts';
import { colorFor, type Palette } from './scales.ts';

export type SalesType = 'apartment' | 'house' | 'all';
export type SalesMonths = 12 | 24 | 60;
export type SalesRooms = 1 | 2 | 3 | 4 | 5;

export type SalesFilters = {
  type: SalesType;
  months: SalesMonths;
  /** 5 = 5 rooms or more. */
  rooms: SalesRooms | null;
  surfaceMin: number | null;
  surfaceMax: number | null;
  priceMin: number | null;
  priceMax: number | null;
};

export const SALES_MONTHS: SalesMonths[] = [12, 24, 60];
export const MONTHS_LABELS: Record<SalesMonths, string> = { 12: '12 mois', 24: '24 mois', 60: '5 ans' };
export const SALES_ROOMS: SalesRooms[] = [1, 2, 3, 4, 5];
export const SALE_TYPE_LABELS = { apartment: 'Appartement', house: 'Maison' } as const;

/** Under this many sales a building, street or level median is not shown (the sales are). */
export const MIN_MEDIAN_SALES = 3;

export const defaultSalesFilters = (type: SalesType): SalesFilters => ({
  type,
  months: 24,
  rooms: null,
  surfaceMin: null,
  surfaceMax: null,
  priceMin: null,
  priceMax: null,
});

/** Query string of /sales and /building: type and months always, the other filters when set. */
export const salesQuery = (f: SalesFilters): string => {
  const query = new URLSearchParams({ type: f.type, months: String(f.months) });
  const optional: [string, number | null][] = [
    ['rooms', f.rooms],
    ['surface_min', f.surfaceMin],
    ['surface_max', f.surfaceMax],
    ['price_min', f.priceMin],
    ['price_max', f.priceMax],
  ];
  for (const [key, value] of optional) {
    if (value != null) {
      query.set(key, String(value));
    }
  }
  return query.toString();
};

/** URL keys of the sales filters: prefixed so they never clash with the page's own filters (type, size…). */
const URL_KEYS = {
  type: 's_type',
  months: 's_months',
  rooms: 's_rooms',
  surfaceMin: 's_smin',
  surfaceMax: 's_smax',
  priceMin: 's_pmin',
  priceMax: 's_pmax',
} as const;

const positive = (value: string | undefined): number | null => {
  const n = value == null || value === '' ? Number.NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const ordered = (min: number | null, max: number | null): [number | null, number | null] =>
  min != null && max != null && min > max ? [max, min] : [min, max];

/** Sales filters read from the route params; the type defaults to the page's type. */
export const salesFiltersFromParams = (params: Record<string, string | undefined>, pageType: SalesType): SalesFilters => {
  const type = (['apartment', 'house', 'all'] as const).find((t) => t === params[URL_KEYS.type]) ?? pageType;
  const months = SALES_MONTHS.find((m) => String(m) === params[URL_KEYS.months]) ?? 24;
  const rooms = SALES_ROOMS.find((r) => String(r) === params[URL_KEYS.rooms]) ?? null;
  const [surfaceMin, surfaceMax] = ordered(positive(params[URL_KEYS.surfaceMin]), positive(params[URL_KEYS.surfaceMax]));
  const [priceMin, priceMax] = ordered(positive(params[URL_KEYS.priceMin]), positive(params[URL_KEYS.priceMax]));
  return { type, months, rooms, surfaceMin, surfaceMax, priceMin, priceMax };
};

/** Route params of the sales filters; a value back to its default is undefined (removed from the URL). */
export const salesFiltersToParams = (f: SalesFilters, pageType: SalesType): Record<string, string | undefined> => {
  const text = (value: number | null) => (value == null ? undefined : String(value));
  return {
    [URL_KEYS.type]: f.type === pageType ? undefined : f.type,
    [URL_KEYS.months]: f.months === 24 ? undefined : String(f.months),
    [URL_KEYS.rooms]: text(f.rooms),
    [URL_KEYS.surfaceMin]: text(f.surfaceMin),
    [URL_KEYS.surfaceMax]: text(f.surfaceMax),
    [URL_KEYS.priceMin]: text(f.priceMin),
    [URL_KEYS.priceMax]: text(f.priceMax),
  };
};

/** Selected building (parcel id: commune, prefix, section, number) from the route params. */
export const parcelParam = (params: Record<string, string | undefined>): string | null => {
  const value = params.building;
  return value && /^[0-9][0-9AB][0-9A-Z]{8,14}$/.test(value) ? value : null;
};

// ---- map

/** Radius in px of a building dot: grows with the square root of its sales, capped. */
export const dotRadius = (n: number): number => Math.min(14, 3 + 1.5 * Math.sqrt(Math.min(Math.max(n, 1), 49)));

/** Quintile cuts of the medians of the buildings shown: classes relative to the commune, so a dear city (Paris,
 * Bordeaux) is not all in the top national class. Empty under 5 medians: fall back to the national breaks. */
export const localBreaks = (buildings: { m2: number | null }[]): number[] => {
  const values = buildings.map((b) => b.m2).filter((m): m is number => m !== null).sort((x, y) => x - y);
  if (values.length < 5) {
    return [];
  }
  return [1, 2, 3, 4].map((k) => values[Math.ceil((values.length * k) / 5) - 1]);
};

/** Key of the communes price breaks (map/breaks.json) used for the dots: flats when both types are shown. */
export const breaksKey = (type: SalesType): string => `price_${type === 'house' ? 'house' : 'apartment'}`;

export const buildingLabel = (addresses: string[]): string => {
  if (addresses.length === 0) {
    return 'Adresse inconnue';
  }
  const more = addresses.length - 1;
  return more === 0 ? addresses[0] : `${addresses[0]} (+${more} adresse${more > 1 ? 's' : ''})`;
};

export const salesCountLabel = (n: number): string => `${n} vente${n > 1 ? 's' : ''}`;

export type BuildingFeature = {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    id: string;
    /** Same as id: the map tells features apart by `code`. */
    code: string;
    label: string;
    n: number;
    median_m2: number | null;
    _fill: string;
    _r: number;
    _stroke?: number;
    _strokeColor?: string;
  };
};

/**
 * One dot per building for the map: big dots first so small ones stay on top and clickable, the selected one
 * last with a ring. Colour = class of the median €/m² of its sales, from 1 sale (a price: dear = bad end); the
 * panel still shows a « médiane » only from 3 sales.
 */
export const buildingFeatures = (
  buildings: Building[],
  { breaks, palette, selected, ring }: { breaks: number[]; palette: Palette; selected: string | null; ring: string },
): { type: 'FeatureCollection'; features: BuildingFeature[] } => ({
  type: 'FeatureCollection',
  features: [...buildings]
    .sort((a, b) => Number(a.id === selected) - Number(b.id === selected) || b.n - a.n)
    .map((b) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
      properties: {
        id: b.id,
        code: b.id,
        label: buildingLabel(b.addresses),
        n: b.n,
        median_m2: b.median_m2,
        _fill: colorFor(b.m2, breaks, palette, false),
        _r: dotRadius(b.n) + (b.id === selected ? 2 : 0),
        ...(b.id === selected ? { _stroke: 3, _strokeColor: ring } : {}),
      },
    })),
});

export const pointsBounds = (
  points: { lon: number | null; lat: number | null }[],
  margin = 0.002,
): [[number, number], [number, number]] | null => {
  const placed = points.filter((p): p is { lon: number; lat: number } => p.lon != null && p.lat != null);
  if (placed.length === 0) {
    return null;
  }
  const xs = placed.map((p) => p.lon);
  const ys = placed.map((p) => p.lat);
  return [
    [Math.min(...xs) - margin, Math.min(...ys) - margin],
    [Math.max(...xs) + margin, Math.max(...ys) + margin],
  ];
};

// ---- figures and labels

/** value / reference − 1, null when either is missing. */
export const gap = (value: number | null | undefined, reference: number | null | undefined): number | null =>
  value != null && reference ? value / reference - 1 : null;

/** A price above its market reads as negative for a buyer; within ±5 % it is neutral. */
export const gapTone = (value: number | null | undefined): 'pos' | 'neg' | undefined =>
  value == null || Math.abs(value) < 0.05 ? undefined : value > 0 ? 'neg' : 'pos';

export const medianLabel = (median: number | null | undefined, n: number): string =>
  n < MIN_MEDIAN_SALES ? 'moins de 3 ventes' : formatEurosPerM2(median);

export const lotsLabel = (lots: Lot[]): string => {
  if (lots.length === 0) {
    return '—';
  }
  const shown = lots.slice(0, 3).map((l) => l.number).join(', ');
  return lots.length > 3 ? `${shown} (+${lots.length - 3})` : shown;
};

/** "2026-05-12" → "12/05/2026". */
export const formatDate = (iso: string | null | undefined): string => {
  const match = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '—';
};

export const dateMs = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
};

/** Share of similar sales cheaper per m², in words. */
export const percentileText = (percentile: number | null | undefined): string =>
  percentile == null ? '—' : `plus cher que ${Math.round(percentile * 100)} % des ventes similaires`;

/** [date ms, €/m², sale id] of a building's sales: those matching the filters apart from the others. */
export const scatterSeries = (sales: BuildingSale[]) => {
  const points = sales
    .filter((s) => s.price_m2 != null)
    .map((s) => ({ match: s.matches_filters, point: [dateMs(s.date), s.price_m2 as number, s.id] as [number, number, string] }));
  return {
    matching: points.filter((p) => p.match).map((p) => p.point),
    others: points.filter((p) => !p.match).map((p) => p.point),
  };
};

const quantile = (sorted: number[], q: number): number => {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};

/** Median and quartiles (linear interpolation), null for an empty list. */
export const spread = (values: number[]): { n: number; median: number; p25: number; p75: number } | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, median: quantile(sorted, 0.5), p25: quantile(sorted, 0.25), p75: quantile(sorted, 0.75) };
};

/** Paris, Lyon and Marseille arrondissements have their own place pages. */
export const placeLevelOf = (code: string): 'commune' | 'arrondissement' =>
  /^(751(0[1-9]|1\d|20)|6938[1-9]|132(0[1-9]|1[0-6]))$/.test(code) ? 'arrondissement' : 'commune';

// ---- if bought to rent

/**
 * ANIL asking rent of a sale: the commune curve at its own surface when published, else the cell rent; the
 * monthly rent excludes the charges provision of the type (as the simulator), rounded to 10 €.
 */
export const saleRent = ({
  type,
  surface,
  curve,
  cellRentM2,
}: {
  type: 'apartment' | 'house';
  surface: number;
  curve: RentCurve | undefined;
  cellRentM2: number | null | undefined;
}): { rentM2: number | null; rentMonthly: number } => {
  const rentM2 = curve ? rentAt(curve, surface) : (cellRentM2 ?? null);
  const rentMonthly = rentM2 ? Math.round((Math.max(rentM2 - chargesProvisionM2(type), 0) * surface) / 10) * 10 : 0;
  return { rentM2, rentMonthly };
};

/** The sale bought at its price with the default financing and charges (same defaults as the typical deal). */
export const saleDeal = ({
  price,
  surface,
  isNew,
  rentMonthly,
  tfpbRate,
}: {
  price: number;
  surface: number;
  isNew: boolean;
  rentMonthly: number;
  tfpbRate: number | null | undefined;
}): DealResult =>
  analyzeDeal({
    price,
    surfaceM2: surface,
    isNewBuild: isNew,
    agencyFees: 0,
    works: 0,
    furniture: 0,
    rentMonthly,
    vacancyMonths: DEFAULTS.vacancyMonths,
    taxeFonciereYearly: estimateTaxeFonciere(rentMonthly, tfpbRate),
    nonRecoverableChargesYearly: 0,
    pnoInsuranceYearly: DEFAULTS.pnoInsuranceYearly,
    managementShare: DEFAULTS.managementShare,
    maintenanceShare: DEFAULTS.maintenanceShare,
    downPayment: Math.round(price * (1 + (isNew ? FR_RULES.notaryRateNew : FR_RULES.notaryRateOld)) * DEFAULTS.downPaymentShare),
    loanRate: DEFAULTS.loanRate,
    loanYears: DEFAULTS.loanYears,
    loanInsuranceRate: DEFAULTS.loanInsuranceRate,
    incomeMonthly: 0,
    existingDebtMonthly: 0,
  });

/** Years of rent to pay the price back (price / yearly rent). */
export const yearsOfRent = (price: number, rentMonthly: number): number | null => (rentMonthly > 0 ? price / (12 * rentMonthly) : null);

/** Simulator prefilled with the sale (simulator-screen reads price, surface and rent). */
export const simulatorHref = ({
  level,
  code,
  type,
  price,
  surface,
  rentMonthly,
}: {
  level: 'commune' | 'arrondissement';
  code: string;
  type: 'apartment' | 'house';
  price: number;
  surface: number | null;
  rentMonthly: number;
}): string => {
  const query = new URLSearchParams({ level, code, type, price: String(Math.round(price)) });
  if (surface) {
    query.set('surface', String(Math.round(surface)));
  }
  if (rentMonthly > 0) {
    query.set('rent', String(Math.round(rentMonthly)));
  }
  return `/simulator?${query.toString()}`;
};
