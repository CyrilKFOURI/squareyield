// Small answers of the local sales API, written from the contract (docs/features/019-sales-map/spec.md) for the
// tests only: screens never read this file. Typed with the client's types, so a contract change breaks tsc here.
import type { BuildingDetail, SaleSheet, SalesMap } from './sales-api.ts';

export const FIXTURE_SALES: SalesMap = {
  commune: { code: '33063', name: 'Bordeaux' },
  period: { from: '2024-07-01', to: '2026-06-30' },
  reference: { n: 8123, median_m2: 4129 },
  buildings: [
    { id: '33063000AB0123', lon: -0.57, lat: 44.84, addresses: ['108 cours Saint-Louis'], n: 12, median_m2: 4310, m2: 4310, last_date: '2026-05-12' },
    { id: '33063000AB0124', lon: -0.571, lat: 44.841, addresses: ['110 cours Saint-Louis', '2 rue Lucien Faure'], n: 2, median_m2: null, m2: 2500, last_date: '2025-11-03' },
    { id: '33063000KD0042', lon: -0.58, lat: 44.83, addresses: ['14 rue Judaïque'], n: 40, median_m2: 5200, m2: 5200, last_date: '2026-06-01' },
  ],
};

const sale = (over: Partial<BuildingDetail['sales'][number]>): BuildingDetail['sales'][number] => ({
  id: 'a1',
  date: '2026-05-12',
  address: '108 cours Saint-Louis',
  type: 'apartment',
  rooms: 2,
  surface: 45.2,
  carrez: 44.8,
  land: null,
  price: 189000,
  price_m2: 4181,
  lots: [{ number: '22', carrez: 44.8 }],
  n_lots: 1,
  n_dependencies: 1,
  new: false,
  gap_commune: 0.013,
  matches_filters: true,
  ...over,
});

export const FIXTURE_BUILDING: BuildingDetail = {
  id: '33063000AB0123',
  lon: -0.57,
  lat: 44.84,
  addresses: ['108 cours Saint-Louis'],
  commune: { code: '33063', name: 'Bordeaux', median_m2: 4129 },
  street: { name: 'cours Saint-Louis', n: 210, median_m2: 3990 },
  stats: { n: 12, median_m2: 4310, p25_m2: 4010, p75_m2: 4620 },
  sales: [
    sale({}),
    sale({ id: 'a2', date: '2024-02-10', rooms: 4, surface: 92, carrez: null, price: 300000, price_m2: 3261, lots: [{ number: '5', carrez: null }, { number: '41', carrez: null }], gap_commune: -0.21, matches_filters: false }),
    sale({ id: 'a3', date: '2025-09-01', price_m2: null, gap_commune: null }),
  ],
};

export const FIXTURE_SALE: SaleSheet = {
  sale: {
    ...sale({}),
    postcode: '33800',
    section: '33063000AB',
    parcel: '33063000AB0123',
    lon: -0.57,
    lat: 44.84,
    location_precision: 'parcel',
    commune: { code: '33063', name: 'Bordeaux' },
    departement: '33',
  },
  similar_rule: { surface_ratio: 0.2, rooms: 1, months: 6 },
  position: [
    { level: 'building', n: 2, median_m2: null, gap: null, percentile: null },
    { level: 'street', n: 14, median_m2: 4020, gap: 0.04, percentile: 0.62 },
    { level: 'section', n: 40, median_m2: 4100, gap: 0.02, percentile: 0.55 },
    { level: 'commune', n: 900, median_m2: 4129, gap: 0.013, percentile: 0.52 },
  ],
  comparables: [
    { id: 'c1', date: '2026-03-02', address: '100 cours Saint-Louis', lon: -0.5702, lat: 44.8405, rooms: 2, surface: 47, price: 192000, price_m2: 4085, km: 0.06 },
    { id: 'c2', date: '2025-12-15', address: '3 rue Lucien Faure', lon: -0.571, lat: 44.842, rooms: 3, surface: 50, price: 210000, price_m2: 4200, km: 0.21 },
  ],
  value_today: { level: 'commune', from_year: '2023', to_year: '2025', factor: 0.97, value: 183000, gain: -6000 },
  model: { estimate_m2: 4050, low_m2: 3700, high_m2: 4400, gap: 0.03, as_of: 'today' },
  resale: { previous: { id: 'p0', date: '2022-03-02', price: 150000 }, next: null, holding_years: 4.2, gain: 39000, annual_rate: 0.056 },
  building_sales: [
    { id: 'a1', date: '2026-05-12', type: 'apartment', rooms: 2, surface: 45, price_m2: 4181 },
    { id: 'a2', date: '2024-02-10', type: 'apartment', rooms: 4, surface: 92, price_m2: 3261 },
  ],
};
