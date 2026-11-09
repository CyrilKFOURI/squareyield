// Price estimate, computed in the browser (docs/features/022-full-frontend/spec.md rule 2): the address goes to the
// public BAN API, the compact model (data/serve/estimate, `cd ml && uv run rea-ml export-web`) runs in
// price-model.ts. Its files are fetched on the first estimate only, so no other page pays for them.
import { cached } from './cache.ts';
import { DATA_URL, fetchRetry } from './config.ts';
import {
  banUrl,
  departementOf,
  type DepartementFile,
  type Effect,
  estimateProperty,
  type ModelEstimate,
  type ModelFile,
  nearestSection,
  readBanAnswer,
} from './price-model.ts';
import type { PropertyType } from './types';

import { addMonths, dayIso, loadPlace, type PlaceSales } from './sales-static.ts';

export type { Effect };

export type PropertyRequest = {
  address: string;
  property_type: Exclude<PropertyType, 'all'>;
  surface_m2: number;
  rooms: number;
  land_m2: number;
  n_dependencies: number;
  is_new_build: boolean;
  asked_price: number;
};

export type Comparable = {
  month: string;
  surface_m2: number;
  rooms: number | null;
  land_m2: number;
  price: number;
  price_m2: number;
  same_section: boolean;
};

export type Estimate = ModelEstimate & {
  location: { label: string; code_commune: string } | null;
  code_commune: string;
  section: string | null;
  comparables: Comparable[];
  model_version: string;
};

const fetchJson = async <T>(url: string, what: string): Promise<T> => {
  let response: Response;
  try {
    response = await fetchRetry(url);
  } catch {
    throw new Error(`${what} : pas de réponse, vérifiez la connexion.`);
  }
  // a dev server or static host answers a missing file with the app page (HTML, status 200)
  if (!response.ok || (response.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`${what} : indisponible (HTTP ${response.ok ? 404 : response.status}).`);
  }
  return response.json() as Promise<T>;
};

const modelFile = cached((path) => fetchJson<ModelFile>(`${DATA_URL}/${path}`, 'Modèle d’estimation'));
const departementFile = cached((dep) => fetchJson<DepartementFile>(`${DATA_URL}/estimate/${dep}.json`, 'Données du département'));

const COMPARABLE_SURFACE_RATIO = 0.25; // ±25 % (ml/src/rea_ml/api.py comparables)
const COMPARABLE_MONTHS = 24;
const COMPARABLES = 10;

/** Recent sales of the same type and similar surface from the commune's static sales file: same section first. */
export const comparablesFrom = (
  place: PlaceSales,
  p: { property_type: Exclude<PropertyType, 'all'>; surface_m2: number; is_new_build?: boolean },
  section: string | null,
): Comparable[] => {
  const since = addMonths(place.latest, -COMPARABLE_MONTHS);
  const low = p.surface_m2 * (1 - COMPARABLE_SURFACE_RATIO);
  const high = p.surface_m2 * (1 + COMPARABLE_SURFACE_RATIO);
  return place.rows
    .filter((r) => r.type === p.property_type && r.isNew === Boolean(p.is_new_build) && r.surface !== null
      && r.surface >= low && r.surface <= high && r.day >= since && r.priceM2 !== null)
    .map((r) => ({ r, same: section !== null && r.parcel?.slice(0, 10) === section }))
    .sort((a, b) => Number(b.same) - Number(a.same)
      || Math.abs((a.r.surface ?? 0) - p.surface_m2) - Math.abs((b.r.surface ?? 0) - p.surface_m2) || b.r.day - a.r.day)
    .slice(0, COMPARABLES)
    .map(({ r, same }) => ({
      month: dayIso(r.day).slice(0, 7), surface_m2: r.surface ?? 0, rooms: r.rooms, land_m2: r.land ?? 0,
      price: r.price, price_m2: r.priceM2 ?? 0, same_section: same,
    }));
};

export const requestEstimate = async (request: PropertyRequest): Promise<Estimate> => {
  const model = modelFile('estimate/model.json'); // in parallel with the address lookup
  model.catch(() => undefined); // its error is reported when awaited below, not as an unhandled rejection
  const location = readBanAnswer(request.address, await fetchJson(banUrl(request.address), 'Recherche d’adresse'));
  const dep = await departementFile(departementOf(location.code_commune));
  const section = nearestSection(dep, location.code_commune, location.longitude, location.latitude);
  const { address: _address, ...property } = request;
  const estimate = estimateProperty(await model, dep, { ...property, code_commune: location.code_commune, section });
  return {
    ...estimate,
    location,
    code_commune: location.code_commune,
    section,
    comparables: await loadPlace(location.code_commune).then((place) => comparablesFrom(place, property, section), () => []),
    model_version: (await model).model_version,
  };
};

// Plain-French names of the model's feature groups (ml/src/rea_ml/features.py FEATURE_GROUPS).
export const EFFECT_LABELS: Record<string, string> = {
  type: 'Appartement ou maison',
  apartment_no_land: 'Appartement (sans terrain)',
  new_build: 'Neuf',
  surface: 'Surface',
  rooms: 'Nombre de pièces',
  land: 'Terrain',
  dependencies: 'Dépendances (parking, cave)',
  lots: 'Nombre de lots',
  carrez: 'Surface Carrez déclarée',
  coordinates: 'Position précise',
  location_precision: 'Précision de l’adresse',
  enc_section: 'Prix du quartier (section cadastrale)',
  enc_commune: 'Prix de la commune',
  enc_departement: 'Prix du département',
  population: 'Démographie',
  housing_market: 'Vacance, résidences secondaires, locataires',
  income: 'Niveau de vie',
  jobs: 'Emploi',
};
