import type { IndexPlace } from './types';

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
export const searchPlaces = (places: IndexPlace[], query: string): IndexPlace[] => {
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
    if (startsWith.length >= MAX_RESULTS) {
      break;
    }
  }
  return [...startsWith, ...contains].slice(0, MAX_RESULTS);
};
