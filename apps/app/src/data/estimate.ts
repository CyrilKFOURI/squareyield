// Client of the local price-check API (ml/src/rea_ml/api.py, `uv run rea-ml serve`).
import type { PropertyType } from './types';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787';

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

export type Effect = { group: string; log_effect: number; effect_pct: number };

export type Comparable = {
  month: string;
  surface_m2: number;
  rooms: number | null;
  land_m2: number;
  price: number;
  price_m2: number;
  same_section: boolean;
};

export type Estimate = {
  price_m2: number;
  price: number;
  price_low: number;
  price_high: number;
  interval_coverage: number;
  location_precision: 'section' | 'commune';
  data_density: 'sparse' | 'medium' | 'dense';
  reference_period: string;
  explanation: { base_price_m2: number; effects: Effect[] };
  asked_vs_estimate?: number;
  verdict?: 'below' | 'consistent' | 'above';
  location: { label: string; code_commune: string } | null;
  code_commune: string;
  section: string | null;
  comparables: Comparable[];
  model_version: string;
};

export const requestEstimate = async (request: PropertyRequest): Promise<Estimate> => {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    throw new Error('Le serveur d’estimation ne répond pas. Lancez `cd ml && uv run rea-ml serve`.');
  }
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error ?? `Erreur ${response.status}`);
  }
  return body as Estimate;
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
