import type { GeoLevel, IndexPlace } from './types';

const MAX_RESULTS = 20;

// "Saint-Étienne" and "saint etienne" must match: drop accents, case and punctuation.
export const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Places whose name starts with the query come first, then those that contain it.
 *  The index is already sorted by population, so big places win ties. */
export const searchPlaces = (places: IndexPlace[], query: string, limit = MAX_RESULTS): IndexPlace[] => {
  const needle = normalize(query);
  if (needle.length < 2) {
    return [];
  }
  const startsWith: IndexPlace[] = [];
  const contains: IndexPlace[] = [];
  for (const place of places) {
    const name = normalize(place.name);
    if (name.startsWith(needle) || place.code === needle) {
      startsWith.push(place);
    } else if (name.includes(needle)) {
      contains.push(place);
    }
    if (startsWith.length >= limit) {
      break;
    }
  }
  return [...startsWith, ...contains].slice(0, limit);
};

export type SearchGroupKey = 'departement' | 'commune';
export type SearchGroup = { key: SearchGroupKey; label: string; places: IndexPlace[] };

/** One level per group (docs/features/017-guided-levels/spec.md, principle 3); arrondissements are communes. */
const GROUPS: { key: SearchGroupKey; label: string; levels: GeoLevel[] }[] = [
  { key: 'departement', label: 'Départements', levels: ['departement'] },
  { key: 'commune', label: 'Communes', levels: ['commune', 'arrondissement'] },
];

/** Search each group on its own so a crowded level (20 Paris arrondissements) cannot push another one out. */
export const searchGrouped = (
  places: IndexPlace[],
  query: string,
  limits: Record<SearchGroupKey, number> = { departement: 4, commune: 8 },
): SearchGroup[] =>
  GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    places: searchPlaces(
      places.filter((p) => group.levels.includes(p.level)),
      query,
      limits[group.key],
    ),
  })).filter((group) => group.places.length > 0);

/** The search index holds communes and arrondissements only: départements come from a level file (France rows,
 *  no population: input order kept) or any table with a population (biggest first). */
export const departementPlaces = (rows: { code: string; name: string; population?: number | null }[]): IndexPlace[] => {
  const byCode = new Map<string, IndexPlace>();
  for (const r of rows) {
    if (!byCode.has(r.code)) {
      byCode.set(r.code, { code: r.code, level: 'departement', name: r.name, departement: r.code, population: r.population ?? null });
    }
  }
  return [...byCode.values()].sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
};
