// ② Département page (docs/features/018-speed-and-map/spec.md): the pipeline writes every figure in
// levels/departements/<dep>.json; the page only picks, sorts and filters these small arrays.
import type { DepartementLevel, LevelPlace } from './api.ts';

/** Nothing is shown under this many sales (the pipeline does not publish smaller cells either). */
export const MIN_SALES = 10;

/** Values as an index, 100 at the first known value. */
export const toBase100 = (values: (number | null)[]): (number | null)[] => {
  const first = values.find((v) => v != null);
  return values.map((v) => (v != null && first ? (v / first) * 100 : null));
};

/** Value of a yearly array (aligned on `years`) at one year; null outside the window. */
export const valueAt = (years: string[], values: (number | null)[], year: string | null): number | null => {
  const i = year == null ? -1 : years.indexOf(year);
  return i < 0 ? null : (values[i] ?? null);
};

/** At least one type has published figures (Alsace-Moselle and Mayotte have no DVF sales). */
export const hasPublishedSales = (level: DepartementLevel): boolean =>
  Object.values(level.types ?? {}).some((t) => t?.kpis != null);

export type HeatSort = 'sales' | 'growth';

/** Communes with a median every year of the window (a yearly change in each cell), most sales or biggest rise first. */
export const heatRows = (communes: LevelPlace[], sort: HeatSort): LevelPlace[] =>
  communes
    .filter((r) => r.medians.length >= 2 && r.medians.every((m) => m != null))
    .sort((a, b) => (sort === 'sales' ? b.n - a.n : (b.growth ?? -Infinity) - (a.growth ?? -Infinity)) || a.code.localeCompare(b.code));
