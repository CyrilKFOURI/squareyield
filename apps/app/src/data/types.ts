// Shapes of the files written by the pipeline's S5 publish stage, schema v2
// (pipeline/src/rea_pipeline/publish.py, docs/features/013-comparable-segments/spec.md).

export const SCHEMA_VERSION = 2;

export type GeoLevel = 'commune' | 'arrondissement' | 'departement' | 'region' | 'france';
/** 'all' = flats and houses together: market context only, never compared or ranked. */
export type PropertyType = 'apartment' | 'house' | 'all';
export type DwellingType = Exclude<PropertyType, 'all'>;
/** Flats T1…T4, 5+; houses ≤3 rooms, 4, 5, 6+. */
export type RoomsBucket = '1' | '2' | '3' | '4' | '5+' | '1-3' | '5' | '6+' | 'all';
export type Reliability = 'ok' | 'low';

export type IndexPlace = {
  code: string;
  level: GeoLevel;
  name: string;
  departement: string | null;
  population: number | null;
};

export type PriceRow = {
  period_type: 'year' | 'half';
  period: string;
  is_partial: boolean;
  /** 'new' = new builds (VEFA), published for all sizes only. */
  condition: 'existing' | 'new';
  property_type: PropertyType;
  rooms_bucket: RoomsBucket;
  n_sales: number;
  reliability: Reliability;
  median_price_m2: number;
  p25_price_m2: number;
  p75_price_m2: number;
  median_price: number;
  yoy_change: number | null;
  median_surface_m2: number | null;
  /** Houses: median land area (m²). */
  median_land_m2?: number | null;
  /** Houses: share of sales with an outbuilding. */
  share_with_outbuilding?: number | null;
  /** Annualised change since the first complete year (cagr_since), on complete-year rows. */
  cagr: number | null;
  cagr_since: number | null;
  /** New-build median €/m² over this existing cell's, − 1 (all-sizes rows only). */
  new_premium: number | null;
};

export type RentLevel = 'commune' | 'epci' | 'maille' | 'aggregate';

export type YieldRow = {
  period: string;
  property_type: DwellingType;
  rooms_bucket: RoomsBucket;
  /** ANIL asking rent, charges included, read at rent_surface_m2. */
  rent_m2: number;
  rent_low_m2: number;
  rent_high_m2: number;
  rent_surface_m2: number;
  rent_method: 'surface_adjusted' | 'house_approx';
  rent_level: RentLevel;
  /** ANIL's own caution: few listings in the commune or a poor model fit. */
  rent_caution: boolean;
  /** Share of the area's rental homes covered by a rent (aggregated levels). */
  rent_coverage: number | null;
  n_listings: number;
  /** null when status is 'excluded'. */
  gross_yield: number | null;
  price_to_rent_years: number | null;
  status: 'ok' | 'excluded';
  reason: 'price_below_floor' | 'yield_above_ceiling' | null;
};

export type Socio = {
  census_year: number;
  population: number | null;
  population_growth_yearly: number | null;
  dwellings: number | null;
  vacancy_rate: number | null;
  vacancy_change_pts: number | null;
  second_home_share: number | null;
  renter_share: number | null;
  median_living_standard: number | null;
  poverty_rate: number | null;
  jobs: number | null;
  jobs_growth_yearly: number | null;
  flag_high_vacancy: boolean | null;
  flag_population_decline: boolean | null;
};

export type Stock = Partial<{
  dwellings_2022: number;
  share_houses: number;
  share_apartments: number;
  main_homes_1p_share: number;
  main_homes_2p_share: number;
  main_homes_3p_share: number;
  main_homes_4p_share: number;
  main_homes_5p_share: number;
  avg_rooms_apartment: number;
  avg_rooms_house: number;
  apartments_before_1946_share: number;
  apartments_after_2005_share: number;
  houses_before_1946_share: number;
  houses_after_2005_share: number;
  tenant_share: number;
  social_tenant_share: number;
}>;

export type ScoreCriterion =
  | 'gross_yield'
  | 'cagr'
  | 'population_growth_yearly'
  | 'jobs_growth_yearly'
  | 'vacancy_rate'
  | 'share_fg'
  | 'n_sales';

export type MarketScore = {
  period: string;
  score: number;
  n_criteria: number;
  strengths: ScoreCriterion[];
  weaknesses: ScoreCriterion[];
  /** Yearly rent of a typical home of the type (flat 45 m², house 90 m²) over the median living standard. */
  rent_to_income: number | null;
};

export type Energy = {
  n_dpe: number;
  share_a: number;
  share_b: number;
  share_c: number;
  share_d: number;
  share_e: number;
  share_f: number;
  share_g: number;
  share_fg: number;
};

/** Year → type → share of sales per price band. */
export type PriceBands = Record<string, Partial<Record<DwellingType, { n_sales: number; bands: [string, number][] }>>>;

export type Basis = 'exact' | 'all_sizes' | 'parent_area';

export type LatestCell = { year: string | null; half: string | null; basis: Basis };

export type TypicalDeal = {
  price: number;
  surface_m2: number;
  rent_monthly: number;
  taxe_fonciere_yearly: number;
  total_cost: number;
  gross_yield: number | null;
  net_yield: number | null;
  cap_rate: number | null;
  payment_monthly: number;
  cash_flow_monthly: number;
  quick_test_monthly: number;
  period: string;
  basis: Basis;
};

export type OllRow = {
  year: number;
  property_type: PropertyType;
  rooms: string;
  period_built: string;
  tenancy: 'all' | 'new' | 'long';
  rent_m2_median: number;
  rent_m2_d1: number | null;
  rent_m2_d9: number | null;
  rent_monthly_median: number | null;
  surface_mean: number | null;
  n_obs: number | null;
};

/** OLL rents of one agglomeration (oll/<agglo_code>.json); places carry a pointer to it. */
export type Oll = { agglomeration: string; agglo_code: string; rows: OllRow[] };
export type OllRef = { agglomeration: string; agglo_code: string };

export type SourceMeta = { source: string; [detail: string]: string | number | undefined };

/** meta.json: the source of each block, the same for every place. */
export type Meta = Partial<Record<'prices' | 'rents' | 'oll' | 'socio' | 'stock' | 'dpe' | 'tax', SourceMeta>>;

export type Place = {
  schema_version: number;
  code: string;
  level: GeoLevel;
  name: string | null;
  departement: string | null;
  region: string | null;
  run_id: string;
  prices: PriceRow[];
  yields: YieldRow[];
  socio: Socio | null;
  stock?: Stock;
  latest?: Partial<Record<DwellingType, Partial<Record<RoomsBucket, LatestCell>>>>;
  typical_deal?: Partial<Record<DwellingType, Partial<Record<RoomsBucket, TypicalDeal>>>>;
  /** [code, name, distance km], nearest first. */
  neighbours?: [string, string, number][];
  local_tax?: { tax_year: number; tfpb_rate: number };
  energy?: Partial<Record<PropertyType, Energy>>;
  rent_control?: boolean;
  score?: Partial<Record<DwellingType, MarketScore>>;
  price_bands?: PriceBands;
  oll?: OllRef;
  /** ANIL rent curve per type (communes and arrondissements with one ANIL code). */
  rent_curve?: Partial<Record<DwellingType, { ref_rent_m2: number; ref_surface: number; slope: number }>>;
};

export type RankingRow = {
  code: string;
  level: GeoLevel;
  name: string;
  departement: string;
  region: string;
  property_type: DwellingType;
  rooms_bucket: RoomsBucket;
  n_sales: number;
  reliability: Reliability;
  median_price_m2: number;
  typical_price: number;
  median_surface_m2: number;
  yoy_change: number | null;
  cagr: number | null;
  rent_m2: number;
  rent_level: RentLevel;
  gross_yield: number;
  net_yield: number | null;
  cash_flow_monthly: number | null;
  cap_rate: number | null;
  population: number | null;
  population_growth_yearly: number | null;
  vacancy_rate: number | null;
  flag_high_vacancy: boolean | null;
  flag_population_decline: boolean | null;
  score: number | null;
  share_fg: number | null;
  tfpb_rate: number | null;
  rent_control: boolean | null;
};

export type Ranking = { period: string; minSales: number; rows: RankingRow[] };
