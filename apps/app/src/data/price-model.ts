// Price estimate in the browser (docs/features/022-full-frontend/spec.md rule 2). Pure: no fetch, no React.
// Ports, line for line, what the model package does in python:
//   features.py (LocationEncoder.transform, build_features), inference.py (PriceCheckModel._rows, estimate),
//   LightGBM's tree evaluation (Tree::NumericalDecision / CategoricalDecision) and its exact TreeSHAP
//   (Tree::TreeSHAP, the values of predict(pred_contrib=True)) for the explanation.
// Files: data/serve/estimate/model.json and <dep>.json, written by `cd ml && uv run rea-ml export-web`.

export type PropertyKind = 'apartment' | 'house';

/** One tree as flat arrays: internal nodes 0..n-1, a child < 0 is the leaf ~child (LightGBM's layout). */
export type Tree = {
  f: number[]; // split feature (column index)
  t: number[]; // threshold, or index into cats for a categorical split
  d: number[]; // bit 0 categorical, bit 1 default left, bits 2-3 missing type (0 None, 1 Zero, 2 NaN)
  l: number[];
  r: number[];
  c: number[]; // training rows through each internal node (TreeSHAP weights)
  v: number[]; // leaf values
  n: number[]; // training rows per leaf
  cats: number[][]; // categories going left, per categorical split
};

export type ModelFile = {
  model_version: string;
  reference_period: string;
  feature_columns: string[];
  feature_groups: Record<string, string[]>;
  encoding: { smoothing: number; global_means: Record<string, number> };
  interval_coverage: number;
  intervals: Record<string, [number, number]>;
  trees: Tree[];
};

type TypePairs = (number | null)[]; // [apartment mean, apartment n, house mean, house n]

export type DepartementFile = {
  departement: string;
  enc: TypePairs;
  commune_fields: string[];
  communes: Record<string, (number | null)[]>; // longitude, latitude, INSEE context…, type pairs
  section_fields: string[];
  sections: (string | number | null)[][]; // section, longitude, latitude, type pairs
};

export type PropertyInput = {
  property_type: PropertyKind;
  surface_m2: number;
  rooms: number | null;
  land_m2: number;
  n_dependencies: number;
  n_lots?: number;
  is_new_build: boolean;
  code_commune: string;
  section: string | null;
  asked_price?: number;
};

export type Effect = { group: string; log_effect: number; effect_pct: number };

export type ModelEstimate = {
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
};

const SOCIO_FIELDS = [
  'population',
  'population_growth_yearly',
  'vacancy_rate',
  'second_home_share',
  'renter_share',
  'median_living_standard',
  'jobs_growth_yearly',
] as const;
const ZERO_THRESHOLD = 1e-35; // LightGBM kZeroThreshold

const num = (value: number | string | null | undefined): number => (typeof value === 'number' ? value : NaN);

export const departementOf = (codeCommune: string): string =>
  codeCommune.startsWith('97') ? codeCommune.slice(0, 3) : codeCommune.slice(0, 2);

// ---------------------------------------------------------------- trees

const goesLeft = (tree: Tree, node: number, input: number): boolean => {
  const flags = tree.d[node];
  const missing = (flags >> 2) & 3;
  let value = input;
  if (flags & 1) {
    if (Number.isNaN(value)) {
      if (missing === 2) return false;
      value = 0;
    }
    const category = Math.trunc(value);
    return category >= 0 && tree.cats[tree.t[node]].includes(category);
  }
  if (Number.isNaN(value) && missing !== 2) value = 0;
  if ((missing === 1 && Math.abs(value) <= ZERO_THRESHOLD) || (missing === 2 && Number.isNaN(value))) {
    return (flags & 2) !== 0;
  }
  return value <= tree.t[node];
};

const nextNode = (tree: Tree, node: number, x: ArrayLike<number>): number =>
  goesLeft(tree, node, x[tree.f[node]]) ? tree.l[node] : tree.r[node];

export const predictTree = (tree: Tree, x: ArrayLike<number>): number => {
  if (tree.f.length === 0) return tree.v[0];
  let node = 0;
  while (node >= 0) node = nextNode(tree, node, x);
  return tree.v[~node];
};

export const predict = (trees: Tree[], x: ArrayLike<number>): number => {
  let sum = 0;
  for (const tree of trees) sum += predictTree(tree, x);
  return sum;
};

// ---------------------------------------------------------------- TreeSHAP (LightGBM tree.cpp)

type PathElement = { feature: number; zero: number; one: number; weight: number };

const extendPath = (path: PathElement[], depth: number, zero: number, one: number, feature: number): void => {
  path[depth] = { feature, zero, one, weight: depth === 0 ? 1 : 0 };
  for (let i = depth - 1; i >= 0; i--) {
    path[i + 1].weight += (one * path[i].weight * (i + 1)) / (depth + 1);
    path[i].weight = (zero * path[i].weight * (depth - i)) / (depth + 1);
  }
};

const unwindPath = (path: PathElement[], depth: number, index: number): void => {
  const { one, zero } = path[index];
  let nextOne = path[depth].weight;
  for (let i = depth - 1; i >= 0; i--) {
    if (one !== 0) {
      const tmp = path[i].weight;
      path[i].weight = (nextOne * (depth + 1)) / ((i + 1) * one);
      nextOne = tmp - (path[i].weight * zero * (depth - i)) / (depth + 1);
    } else {
      path[i].weight = (path[i].weight * (depth + 1)) / (zero * (depth - i));
    }
  }
  for (let i = index; i < depth; i++) {
    path[i] = { ...path[i + 1], weight: path[i].weight };
  }
};

const unwoundPathSum = (path: PathElement[], depth: number, index: number): number => {
  const { one, zero } = path[index];
  let nextOne = path[depth].weight;
  let total = 0;
  for (let i = depth - 1; i >= 0; i--) {
    if (one !== 0) {
      const tmp = (nextOne * (depth + 1)) / ((i + 1) * one);
      total += tmp;
      nextOne = path[i].weight - tmp * zero * ((depth - i) / (depth + 1));
    } else if (zero !== 0) {
      total += path[i].weight / zero / ((depth - i) / (depth + 1));
    }
  }
  return total;
};

const rowsAt = (tree: Tree, node: number): number => (node >= 0 ? tree.c[node] : tree.n[~node]);

const treeShap = (
  tree: Tree,
  x: ArrayLike<number>,
  phi: number[],
  node: number,
  depthIn: number,
  parent: PathElement[],
  zero: number,
  one: number,
  feature: number,
): void => {
  const path = parent.slice(0, depthIn).map((e) => ({ ...e }));
  let depth = depthIn;
  extendPath(path, depth, zero, one, feature);
  if (node < 0) {
    for (let i = 1; i <= depth; i++) {
      const w = unwoundPathSum(path, depth, i);
      phi[path[i].feature] += w * (path[i].one - path[i].zero) * tree.v[~node];
    }
    return;
  }
  const hot = nextNode(tree, node, x);
  const cold = hot === tree.l[node] ? tree.r[node] : tree.l[node];
  const w = rowsAt(tree, node);
  const split = tree.f[node];
  let incomingZero = 1;
  let incomingOne = 1;
  let index = 0;
  for (; index <= depth; index++) if (path[index].feature === split) break;
  if (index !== depth + 1) {
    incomingZero = path[index].zero;
    incomingOne = path[index].one;
    unwindPath(path, depth, index);
    depth -= 1;
  }
  treeShap(tree, x, phi, hot, depth + 1, path, (rowsAt(tree, hot) / w) * incomingZero, incomingOne, split);
  treeShap(tree, x, phi, cold, depth + 1, path, (rowsAt(tree, cold) / w) * incomingZero, 0, split);
};

const expectedValue = (tree: Tree): number => {
  if (tree.f.length === 0) return tree.v[0];
  let sum = 0;
  for (let i = 0; i < tree.v.length; i++) sum += (tree.n[i] / tree.c[0]) * tree.v[i];
  return sum;
};

/** Same values as LightGBM predict(pred_contrib=True): one per feature, then the expected value. */
export const contributions = (trees: Tree[], x: ArrayLike<number>): number[] => {
  const phi = new Array<number>(x.length + 1).fill(0);
  for (const tree of trees) {
    phi[x.length] += expectedValue(tree);
    if (tree.f.length > 0) treeShap(tree, x, phi, 0, 0, [], 1, 1, -1);
  }
  return phi;
};

// ---------------------------------------------------------------- features (features.py, inference.py)

const pair = (values: TypePairs, type: PropertyKind, offset: number): { mean: number; n: number } => {
  const i = offset + (type === 'house' ? 2 : 0);
  return { mean: values[i] ?? 0, n: values[i + 1] ?? 0 };
};

/** Nearest section point of the commune (api.py nearest_section): the location rule of training. */
export const nearestSection = (dep: DepartementFile, codeCommune: string, lon: number, lat: number): string | null => {
  let best: string | null = null;
  let bestDistance = Infinity;
  const scale = Math.cos((lat * Math.PI) / 180);
  for (const row of dep.sections) {
    const [section, sLon, sLat] = row;
    if (typeof section !== 'string' || !section.startsWith(codeCommune) || typeof sLon !== 'number' || typeof sLat !== 'number') {
      continue;
    }
    const dx = (sLon - lon) * scale;
    const dy = sLat - lat;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = section;
    }
  }
  return best;
};

export type Features = { values: Record<string, number>; nSection: number; locationPrecision: 'section' | 'commune' };

export const buildFeatures = (model: ModelFile, dep: DepartementFile, p: PropertyInput): Features => {
  const commune = dep.communes[p.code_commune] ?? null;
  const sectionRow = p.section ? dep.sections.find((row) => row[0] === p.section) ?? null : null;
  const onSection = sectionRow !== null && typeof sectionRow[1] === 'number';
  const longitude = onSection ? num(sectionRow[1]) : num(commune?.[0]);
  const latitude = onSection ? num(sectionRow[2]) : num(commune?.[1]);
  if (Number.isNaN(longitude) || Number.isNaN(latitude)) {
    throw new Error(`Aucune position connue pour la commune ${p.code_commune} (Alsace-Moselle et Mayotte ne sont pas dans DVF).`);
  }

  // LocationEncoder.transform: département ← commune ← section, each shrunk towards the level above
  const m = model.encoding.smoothing;
  const means = Object.values(model.encoding.global_means);
  let parent = model.encoding.global_means[p.property_type] ?? means.reduce((a, b) => a + b, 0) / means.length;
  const encoded: number[] = [];
  const counts: number[] = [];
  const levels: TypePairs[] = [dep.enc, commune ? commune.slice(2 + SOCIO_FIELDS.length) : [], sectionRow ? (sectionRow.slice(3) as TypePairs) : []];
  for (const level of levels) {
    const { mean, n } = pair(level, p.property_type, 0);
    parent = (n * mean + m * parent) / (n + m);
    encoded.push(parent);
    counts.push(n);
  }
  const [encDepartement, encCommune, encSection] = encoded;
  const [, nCommune, nSection] = counts;

  const socio = (field: (typeof SOCIO_FIELDS)[number]): number => num(commune?.[2 + SOCIO_FIELDS.indexOf(field)]);
  const rooms = p.rooms ?? NaN;
  const latScale = Math.cos((latitude * Math.PI) / 180);
  const values: Record<string, number> = {
    is_house: p.property_type === 'house' ? 1 : 0,
    is_new_build: p.is_new_build ? 1 : 0,
    log_surface: Math.log(p.surface_m2),
    rooms,
    surface_per_room: rooms > 0 ? p.surface_m2 / rooms : NaN,
    log_land: Math.log1p(p.land_m2),
    has_land: p.land_m2 > 0 ? 1 : 0,
    n_dependencies: p.n_dependencies,
    n_lots: p.n_lots ?? 1,
    has_carrez: p.property_type === 'apartment' ? 1 : 0,
    longitude,
    latitude,
    diag_a: longitude * latScale + latitude,
    diag_b: longitude * latScale - latitude,
    coarse_location: onSection ? 0 : 1,
    log_population: Math.log1p(socio('population')),
    population_growth_yearly: socio('population_growth_yearly'),
    vacancy_rate: socio('vacancy_rate'),
    second_home_share: socio('second_home_share'),
    renter_share: socio('renter_share'),
    median_living_standard: socio('median_living_standard'),
    jobs_growth_yearly: socio('jobs_growth_yearly'),
    enc_section: encSection,
    enc_commune: encCommune,
    enc_departement: encDepartement,
    log_n_section: Math.log1p(nSection),
    log_n_commune: Math.log1p(nCommune),
  };
  return { values, nSection, locationPrecision: onSection ? 'section' : 'commune' };
};

export const featureVector = (model: ModelFile, features: Features): number[] =>
  model.feature_columns.map((column) => features.values[column]);

// ---------------------------------------------------------------- estimate (inference.py estimate)

const densityOf = (n: number): ModelEstimate['data_density'] => (n <= 9 ? 'sparse' : n <= 99 ? 'medium' : 'dense');

export const estimateProperty = (model: ModelFile, dep: DepartementFile, p: PropertyInput): ModelEstimate => {
  const features = buildFeatures(model, dep, p);
  const x = featureVector(model, features);
  const logPred = predict(model.trees, x);
  const phi = contributions(model.trees, x);
  const density = densityOf(features.nSection);
  const [low, high] = model.intervals[`${p.property_type}/${density}`] ?? model.intervals['*'];
  const surface = p.surface_m2;

  const byColumn = new Map(model.feature_columns.map((column, i) => [column, phi[i]]));
  const effects = Object.entries(model.feature_groups)
    .filter(([, columns]) => columns.some((c) => byColumn.has(c)))
    .map(([group, columns]) => {
      const logEffect = columns.reduce((sum, c) => sum + (byColumn.get(c) ?? 0), 0);
      return { group, log_effect: logEffect, effect_pct: Math.exp(logEffect) - 1 };
    })
    .sort((a, b) => Math.abs(b.log_effect) - Math.abs(a.log_effect));

  const result: ModelEstimate = {
    price_m2: Math.exp(logPred),
    price: Math.exp(logPred) * surface,
    price_low: Math.exp(logPred + low) * surface,
    price_high: Math.exp(logPred + high) * surface,
    interval_coverage: model.interval_coverage,
    location_precision: features.locationPrecision,
    data_density: density,
    reference_period: model.reference_period,
    explanation: { base_price_m2: Math.exp(phi[phi.length - 1]), effects },
  };
  if (p.asked_price) {
    const gap = Math.log(p.asked_price / surface) - logPred;
    result.asked_vs_estimate = Math.exp(gap) - 1;
    result.verdict = gap < low ? 'below' : gap > high ? 'above' : 'consistent';
  }
  return result;
};

// ---------------------------------------------------------------- address (api.py geocode)

export const BAN_URL = 'https://api-adresse.data.gouv.fr/search/';
const MIN_ADDRESS_SCORE = 0.5;

export type Location = { label: string; code_commune: string; longitude: number; latitude: number };

type BanAnswer = {
  features: { geometry: { coordinates: [number, number] }; properties: { label: string; citycode: string; score: number } }[];
};

export const banUrl = (address: string): string => `${BAN_URL}?${new URLSearchParams({ q: address, limit: '1' })}`;

/** BAN answer -> point + INSEE code (arrondissement code in Paris, Lyon, Marseille). */
export const readBanAnswer = (address: string, answer: BanAnswer): Location => {
  const [feature] = answer.features ?? [];
  if (!feature || feature.properties.score < MIN_ADDRESS_SCORE) {
    throw new Error(`Adresse introuvable : ${address}`);
  }
  const [longitude, latitude] = feature.geometry.coordinates;
  return { label: feature.properties.label, code_commune: feature.properties.citycode, longitude, latitude };
};
