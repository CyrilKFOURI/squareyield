// Commune page (Marché ③, docs/features/017-guided-levels/spec.md): the arrondissements of Paris, Lyon and
// Marseille as a sub-level, the yearly curve of the commune against its département and France, and the
// neighbours. Pure shaping over published files (place file, levels/*.json: docs/features/018-speed-and-map).
import type { LevelPlace } from './api.ts';
import { codeCompare } from './levels.ts';
import type { DwellingType, GeoLevel, Place } from './types.ts';

/** The three communes split into municipal arrondissements (DVF codes 751xx, 6938x, 132xx). */
const CITIES = [
  { code: '75056', name: 'Paris', prefix: '751' },
  { code: '69123', name: 'Lyon', prefix: '6938' },
  { code: '13055', name: 'Marseille', prefix: '132' },
] as const;

/** Code prefix of a city's arrondissements, null for any other commune. */
export const arrondissementPrefix = (communeCode: string): string | null =>
  CITIES.find((c) => c.code === communeCode)?.prefix ?? null;

/** The city an arrondissement code belongs to. */
export const cityOfArrondissement = (code: string): { code: string; name: string } | null => {
  const city = CITIES.find((c) => code.length === 5 && code !== c.code && code.startsWith(c.prefix));
  return city ? { code: city.code, name: city.name } : null;
};

/** "Paris 15e Arrondissement" → "15e" (bar labels). */
export const arrondissementLabel = (name: string): string =>
  name.replace(/^(Paris|Lyon|Marseille) (.+) Arrondissement$/, '$2');

/** Rows of a city's arrondissements in a département level file (size all), in code order. */
export const arrondissementsIn = (communes: LevelPlace[], communeCode: string): LevelPlace[] => {
  const prefix = arrondissementPrefix(communeCode);
  if (!prefix) {
    return [];
  }
  return communes.filter((r) => r.level === 'arrondissement' && r.code.startsWith(prefix)).sort((a, b) => codeCompare(a.code, b.code));
};

export type YearPoint = { period: string; median: number };

/** Medians aligned on a level file's `years` as points, missing years dropped. */
export const yearPoints = (years: string[], medians: (number | null)[]): YearPoint[] =>
  years.flatMap((period, i) => {
    const median = medians[i];
    return median == null ? [] : [{ period, median }];
  });

export type NeighbourRow = {
  code: string;
  name: string;
  km: number;
  level: GeoLevel | null;
  lon: number | null;
  lat: number | null;
  n: number | null;
  price: number | null;
  yoy: number | null;
  gross: number | null;
};

/** Neighbours of a place with their figures for one type (latest year, all sizes); null when not published. */
export const neighbourRows = (neighbours: Place['neighbours'], type: DwellingType): NeighbourRow[] =>
  (neighbours ?? []).map(([code, name, km, level, lon, lat, figures]) => {
    const own = figures?.[type];
    return {
      code,
      name,
      km,
      level: level ?? null,
      lon: lon ?? null,
      lat: lat ?? null,
      n: own?.[0] ?? null,
      price: own?.[1] ?? null,
      yoy: own?.[2] ?? null,
      gross: own?.[3] ?? null,
    };
  });

/** One value per year for each line; indexed = base 100 on the first year every line has (else its own first). */
export const compareYears = (
  lines: { name: string; points: YearPoint[] }[],
  years: string[],
  indexed: boolean,
): { name: string; values: (number | null)[] }[] => {
  const aligned = lines.map((l) => ({
    name: l.name,
    values: years.map((y) => l.points.find((p) => p.period === y)?.median ?? null),
  }));
  if (!indexed) {
    return aligned;
  }
  const common = years.findIndex((_, i) => aligned.every((l) => l.values[i] != null));
  return aligned.map((l) => {
    const baseIndex = common >= 0 ? common : l.values.findIndex((v) => v != null);
    const base = baseIndex >= 0 ? l.values[baseIndex] : null;
    return {
      name: l.name,
      values: l.values.map((v) => (v == null || !base ? null : Math.round((v / base) * 1000) / 10)),
    };
  });
};
