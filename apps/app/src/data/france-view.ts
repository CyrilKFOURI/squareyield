// Level ① France (docs/features/018-speed-and-map/spec.md): the pipeline writes every figure of the page
// (levels/france.json); here only labels, orderings and the bar metric accessors over those ready rows.
import type { FranceFigures, LevelPlace } from './api.ts';
import { formatCount, formatDecimal, formatEurosPerM2, formatPercent, formatRentPerM2, formatSignedPercent } from './format.ts';
import { codeCompare } from './levels.ts';

/** "Gironde (33)" */
export const placeLabel = (p: { name: string; code: string }): string => `${p.name} (${p.code})`;

type Ordered = { code: string; changes: (number | null)[]; growth: number | null };

export type HeatSort = 'code' | 'latest' | 'growth';

/** Heat-map rows by code, by the latest yearly change or by growth over the period (highest first, missing last). */
export const heatOrder = <T extends Ordered>(rows: T[], sort: HeatSort): T[] => {
  if (sort === 'code') {
    return [...rows].sort((a, b) => codeCompare(a.code, b.code));
  }
  const value = (r: T) => (sort === 'latest' ? r.changes.at(-1) : r.growth) ?? null;
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x == null || y == null) {
      return Number(x == null) - Number(y == null) || codeCompare(a.code, b.code);
    }
    return y - x;
  });
};

export type TableKey = 'code' | 'price' | 'yoy' | 'growth' | 'index' | 'n' | 'rent' | 'yield';
export type TableSort = { key: TableKey; dir: 'asc' | 'desc' };

/** Table rows by code (département order) or by one figure, places without that figure last either way. */
export const sortPlaces = <T extends LevelPlace>(rows: T[], { key, dir }: TableSort): T[] => {
  const sign = dir === 'asc' ? 1 : -1;
  if (key === 'code') {
    return [...rows].sort((a, b) => codeCompare(a.code, b.code) * sign);
  }
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    return x == null || y == null ? Number(x == null) - Number(y == null) : (x - y) * sign;
  });
};

/** Clicking a column header: the same column flips, a figure starts highest first, the code ascending. */
export const nextSort = (current: TableSort, key: TableKey): TableSort =>
  current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'code' ? 'asc' : 'desc' };

export type FranceRef = Partial<Pick<FranceFigures, 'price' | 'yoy' | 'growth' | 'rent' | 'yield'>>;

export type BarMetric = {
  key: 'price' | 'yoy' | 'growth' | 'sales' | 'rent' | 'yield' | 'index' | 'income';
  label: string;
  /** Catalogue key for the ⓘ. */
  info: string;
  value: (d: LevelPlace) => number | null;
  format: (v: number) => string;
  /** Bars above / below zero in two tones. */
  signed?: boolean;
  /** France value drawn as a reference line, when it means something for this metric. */
  reference: (france: FranceRef) => number | null;
};

const none = () => null;

export const BAR_METRICS: BarMetric[] = [
  { key: 'price', label: 'Prix médian au m²', info: 'median_price_m2', value: (d) => d.price, format: formatEurosPerM2, reference: (f) => f.price ?? null },
  { key: 'yoy', label: 'Évolution sur un an', info: 'yoy_change', value: (d) => d.yoy, format: formatSignedPercent, signed: true, reference: (f) => f.yoy ?? null },
  { key: 'growth', label: 'Évolution sur la période', info: 'growth_5y', value: (d) => d.growth, format: formatSignedPercent, signed: true, reference: (f) => f.growth ?? null },
  { key: 'sales', label: 'Nombre de ventes', info: 'n_sales', value: (d) => d.n, format: formatCount, reference: none },
  { key: 'rent', label: 'Loyer d’annonce au m²', info: 'rent_m2', value: (d) => d.rent, format: formatRentPerM2, reference: (f) => f.rent ?? null },
  { key: 'yield', label: 'Rentabilité brute', info: 'gross_yield', value: (d) => d.yield, format: formatPercent, reference: (f) => f.yield ?? null },
  { key: 'index', label: 'Indice France = 100', info: 'france_index', value: (d) => d.index, format: (v) => formatCount(v), reference: () => 100 },
  { key: 'income', label: 'm² pour un an de revenu', info: 'm2_per_income', value: (d) => d.m2_income, format: (v) => `${formatDecimal(v)} m²`, reference: none },
];
