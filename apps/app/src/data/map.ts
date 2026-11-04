// Choropleth map data (docs/features/005-map/spec.md): GeoJSON layers written by the pipeline's
// mapdata stage, metrics, quintile classes and colours.
import { cached } from './cache.ts';
import { DATA_URL } from './config.ts';
import { formatEurosPerM2, formatPercent, formatSignedPercent } from './format.ts';

// a dev server or static host answers a missing file with the app page (HTML, status 200)
const isHtml = (response: Response) => (response.headers.get('content-type') ?? '').includes('text/html');

export type MapProperties = {
  code: string;
  nom: string;
  level?: 'commune' | 'arrondissement';
  rent_control?: boolean;
  [metric: string]: string | number | boolean | undefined;
};

/** A place has a page when it has published sales of either type (flats or houses). */
export const hasPlacePage = (properties: MapProperties): boolean =>
  typeof properties.sales_apartment === 'number' || typeof properties.sales_house === 'number';

export type MapFeature = { type: 'Feature'; geometry: unknown; properties: MapProperties };
export type MapLayer = { type: 'FeatureCollection'; features: MapFeature[] };

/** Metrics published per property type get the type as suffix (price_apartment); area metrics do not. */
export type MetricBase =
  | 'price'
  | 'yield'
  | 'net_yield'
  | 'cash_flow'
  | 'trend'
  | 'score'
  | 'share_fg'
  | 'vacancy'
  | 'population_growth'
  | 'tfpb_rate';

export type Metric = {
  base: MetricBase;
  label: string;
  format: (value: number) => string;
  /** Wording of the dark end of the scale, for the legend. */
  higherIs: string;
  /** Same value for flats and houses (area statistics). */
  areaWide?: boolean;
  /** Not computed for départements (score and tax rate are per commune). */
  communesOnly?: boolean;
};

export const METRICS: Metric[] = [
  { base: 'price', label: 'Prix au m²', format: formatEurosPerM2, higherIs: 'plus cher' },
  { base: 'yield', label: 'Rentabilité brute', format: formatPercent, higherIs: 'plus rentable' },
  { base: 'net_yield', label: 'Rentabilité nette (bien type)', format: formatPercent, higherIs: 'plus rentable' },
  {
    base: 'cash_flow',
    label: 'Cash-flow mensuel (bien type)',
    format: (v) => `${Math.round(v)} €`,
    higherIs: 'meilleur cash-flow',
  },
  { base: 'trend', label: 'Évolution moyenne / an (5 ans)', format: formatSignedPercent, higherIs: 'plus de hausse' },
  {
    base: 'score',
    label: 'Score de marché',
    format: (v) => `${Math.round(v)} / 100`,
    higherIs: 'meilleur',
    communesOnly: true,
  },
  { base: 'share_fg', label: 'Passoires F/G', format: formatPercent, higherIs: 'plus de passoires' },
  { base: 'vacancy', label: 'Logements vacants', format: formatPercent, higherIs: 'plus de vacance', areaWide: true },
  {
    base: 'population_growth',
    label: 'Population / an',
    format: formatSignedPercent,
    higherIs: 'plus de croissance',
    areaWide: true,
  },
  { base: 'tfpb_rate', label: 'Taux de taxe foncière', format: formatPercent, higherIs: 'plus taxé', areaWide: true, communesOnly: true },
];

export const metricKey = (base: MetricBase, type: 'apartment' | 'house'): string =>
  METRICS.find((m) => m.base === base)?.areaWide ? base : `${base}_${type}`;

/** Quintile breaks published by the pipeline (map/breaks.json), per layer and metric key. */
export type Breaks = { departements: Record<string, number[]>; communes: Record<string, number[]> };

const breaksCache = cached((path) =>
  fetch(`${DATA_URL}/map/${path}`).then((response) => {
    if (!response.ok || isHtml(response)) {
      throw new Error(`carte ${path} : HTTP ${response.ok ? 404 : response.status}`);
    }
    return response.json() as Promise<Breaks>;
  }),
);

export const loadBreaks = (): Promise<Breaks> => breaksCache('breaks.json');

const fetchLayer = async (path: string): Promise<MapLayer> => {
  const response = await fetch(`${DATA_URL}/map/${path}`);
  if (!response.ok || isHtml(response)) {
    throw new Error(`carte ${path} : HTTP ${response.ok ? 404 : response.status}`);
  }
  return response.json() as Promise<MapLayer>;
};

const layerCache = cached(fetchLayer);

export const loadMapLayer = (path: 'departements.geojson' | `communes/${string}.geojson`): Promise<MapLayer> => layerCache(path);
