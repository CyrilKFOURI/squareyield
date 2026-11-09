// Level picker of the Marché steps (docs/features/020-sidebar-filters/spec.md, design item 2): the lists behind the
// Département and Commune dropdowns, their search and keyboard moves. Pure: the component only renders and routes.
import { codeCompare } from './levels.ts';
import { normalize } from './search.ts';
import type { DwellingType, GeoLevel } from './types.ts';

/** One row of a dropdown: price and sales count are those of the page's type (null when it has none). */
export type PickerItem = { code: string; name: string; level: GeoLevel; price: number | null; n: number | null };

type LevelRow = { code: string; name: string; level: GeoLevel; n: number; price: number | null };

/** The level pages read `?type=house` or flats by default. */
export const pickerType = (type: string | undefined): DwellingType => (type === 'house' ? 'house' : 'apartment');

/** Query string kept on every step link: only the type the page was given. */
export const typeQuery = (type: string | undefined): string => (type ? `?type=${type}` : '');

export const areaLabel = (area: { code: string; name: string }): string => `${area.code} · ${area.name}`;

/** Union of both types (a place may only be published for one), figures from the page's type. */
const unionItems = (rows: Record<DwellingType, LevelRow[]>, type: DwellingType): PickerItem[] => {
  const byCode = new Map<string, PickerItem>();
  for (const r of rows[type]) {
    byCode.set(r.code, { code: r.code, name: r.name, level: r.level, price: r.price, n: r.n });
  }
  const other: DwellingType = type === 'house' ? 'apartment' : 'house';
  for (const r of rows[other]) {
    if (!byCode.has(r.code)) {
      byCode.set(r.code, { code: r.code, name: r.name, level: r.level, price: null, n: null });
    }
  }
  return [...byCode.values()];
};

/** Every département in official code order (01…19, 2A, 2B, 21…95, 971…). */
export const departementItems = (rows: Record<DwellingType, LevelRow[]>, type: DwellingType): PickerItem[] =>
  unionItems(rows, type).sort((a, b) => codeCompare(a.code, b.code));

const byName = (a: PickerItem, b: PickerItem): number =>
  a.name.localeCompare(b.name, 'fr', { numeric: true, sensitivity: 'base' }) || codeCompare(a.code, b.code);

/** Communes and arrondissements of one département, by name ("Paris 2e" before "Paris 10e"). */
export const communeItems = (rows: Record<DwellingType, LevelRow[]>, type: DwellingType): PickerItem[] =>
  unionItems(rows, type).sort(byName);

/** Code or name, accents / case / punctuation ignored. Codes and names that start with the query come first,
 *  then names that only contain it; list order is kept inside each group. */
export const filterItems = (items: PickerItem[], query: string): PickerItem[] => {
  const needle = normalize(query);
  if (!needle) {
    return items;
  }
  const first: PickerItem[] = [];
  const then: PickerItem[] = [];
  for (const item of items) {
    const name = normalize(item.name);
    if (item.code.toLowerCase().startsWith(needle) || name.startsWith(needle)) {
      first.push(item);
    } else if (normalize(`${item.code} ${item.name}`).includes(needle)) {
      then.push(item);
    }
  }
  return [...first, ...then];
};

/** Page of a chosen place; `query` is `typeQuery(type)`. */
export const levelHref = (item: { code: string; level: GeoLevel }, query: string): string =>
  item.level === 'departement' ? `/departement/${item.code}${query}` : `/place/${item.level}/${item.code}${query}`;

/** Next highlighted row after an arrow / page key: stops at both ends, -1 for an empty list. */
export const moveActive = (current: number, delta: number, length: number): number =>
  length === 0 ? -1 : Math.min(length - 1, Math.max(0, current + delta));
