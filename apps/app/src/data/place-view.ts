// Selection helpers for the Marché page: rental bans by energy class, price bands over the years and the
// parent territories a place is compared with. Pure functions over the published place file.
import type { DwellingType, Energy, GeoLevel, PriceBands, ScoreCriterion } from './types.ts';

/** Loi Climat et résilience: lettings banned for G from 2025, F from 2028, E from 2034. */
export const banSchedule = (energy: Energy): { year: number; classes: string; share: number }[] => [
  { year: 2025, classes: 'G', share: energy.share_g },
  { year: 2028, classes: 'F, G', share: energy.share_f + energy.share_g },
  { year: 2034, classes: 'E, F, G', share: energy.share_e + energy.share_f + energy.share_g },
];

/** One series per price band (rows) over the years published for the type (columns). */
export const bandsSeries = (
  bands: PriceBands | undefined,
  type: DwellingType,
): { years: string[]; labels: string[]; shares: number[][] } => {
  const years = Object.keys(bands ?? {})
    .filter((year) => (bands?.[year]?.[type]?.bands.length ?? 0) > 0)
    .sort();
  const labels = years.length ? bands![years.at(-1)!]![type]!.bands.map(([label]) => label) : [];
  const shares = labels.map((label) =>
    years.map((year) => bands![year]![type]!.bands.find(([l]) => l === label)?.[1] ?? 0),
  );
  return { years, labels, shares };
};

/** The territories above a place, nearest first. */
export const parentRefs = (place: {
  level: GeoLevel;
  code: string;
  departement: string | null;
  region: string | null;
}): { level: GeoLevel; code: string }[] => {
  const refs: { level: GeoLevel; code: string }[] = [];
  if ((place.level === 'commune' || place.level === 'arrondissement') && place.departement) {
    refs.push({ level: 'departement', code: place.departement });
  }
  if (place.level !== 'region' && place.level !== 'france' && place.region) {
    refs.push({ level: 'region', code: place.region });
  }
  if (place.level !== 'france') {
    refs.push({ level: 'france', code: 'FR' });
  }
  return refs;
};

export const CRITERION_LABELS: Record<ScoreCriterion, string> = {
  gross_yield: 'Rentabilité brute',
  cagr: 'Évolution des prix',
  population_growth_yearly: 'Croissance de la population',
  jobs_growth_yearly: 'Croissance de l’emploi',
  vacancy_rate: 'Peu de logements vacants',
  share_fg: 'Peu de passoires énergétiques',
  n_sales: 'Volume de ventes',
};
