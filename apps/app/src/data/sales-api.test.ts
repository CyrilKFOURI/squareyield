// The sales screens' client on the static files (docs/features/022-full-frontend/spec.md, rule 1): the same numbers
// as the local API on the same fixture. Files in sales-static-fixture/ are `rea sales-static` run on the fixture of
// ml/tests/test_sales_api.py (pipeline/tests/test_sales_static.py keeps them in sync); every expected value below
// is the one that Python test asserts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';

import { getBuilding, getSale, getSales, getSalesByQuery, SalesApiError } from './sales-api.ts';
import { addMonths, clearSalesCache, dayIso, isoDay, parseSaleId, periodStart, pyRound } from './sales-static.ts';
import { defaultSalesFilters, type SalesFilters } from './sales-view.ts';

const P1 = '49007000AB0001';
const P2 = '49007000AB0002';
const P3 = '49007000CD0003';
const id = (n: number, place = '49007') => `${place}-${n.toString(16).padStart(12, '0')}`;

const LEVELS_49 = {
  years: ['2022', '2023', '2024', '2025'],
  types: {
    apartment: { curves: { departement: [2500, 2600, 2700, 2800] }, communes: [{ code: '49007', medians: [3000, 3100, 3200, 3300] }] },
    house: { curves: { departement: [2000, 2100, 2200, 2400] }, communes: [] },
  },
};

const realFetch = globalThis.fetch;
let urls: string[] = [];
beforeEach(() => {
  clearSalesCache();
  urls = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    const sales = /\/sales\/\w+\/(\w+)\.json$/.exec(String(url));
    if (sales) {
      try {
        const text = readFileSync(new URL(`./sales-static-fixture/${sales[1]}.json`, import.meta.url), 'utf8');
        return new Response(text, { status: 200 });
      } catch {
        return new Response('not found', { status: 404 });
      }
    }
    if (String(url).endsWith('/levels/departements/49.json')) {
      return new Response(JSON.stringify(LEVELS_49), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flats = defaultSalesFilters('apartment');
const byId = (buildings: { id: string; n: number }[]) => Object.fromEntries(buildings.map((b) => [b.id, b]));

test('dates and rounding follow the Python API', () => {
  assert.equal(dayIso(periodStart(isoDay('2026-06-30'), 24)), '2024-07-01');
  assert.equal(dayIso(periodStart(isoDay('2026-06-30'), 12)), '2025-07-01');
  assert.equal(dayIso(periodStart(isoDay('2026-03-31'), 1)), '2026-03-01');
  assert.equal(dayIso(periodStart(isoDay('2026-05-15'), 60)), '2021-05-16');
  assert.equal(dayIso(addMonths(isoDay('2025-08-31'), 6)), '2026-02-28');
  assert.deepEqual([pyRound(4100.5), pyRound(4101.5), pyRound(-2.5), pyRound(2.4)], [4100, 4102, -2, 2]);
  assert.deepEqual(parseSaleId('75115-0123456789ab'), { place: '75115', short: '0123456789ab' });
  assert.equal(parseSaleId('0'.repeat(32)), null);
});

test('sales map with the default filters reads one static file', async () => {
  const body = await getSales('49007', flats);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].endsWith('/sales/49/49007.json'));
  assert.deepEqual(body.commune, { code: '49007', name: 'Angers' });
  assert.deepEqual(body.period, { from: '2024-07-01', to: '2026-06-30' });
  assert.deepEqual(body.reference, { n: 8, median_m2: 4000 });
  const found = byId(body.buildings);
  assert.deepEqual(Object.keys(found).sort(), [P1, P2, P3]);
  assert.deepEqual(found[P1], { id: P1, lon: 4, lat: 47, addresses: ['1 rue Test'], n: 4, median_m2: 4100, m2: 4100, last_date: '2026-05-12' });
  assert.equal(body.buildings.find((b) => b.id === P2)?.median_m2, null);
  assert.equal(body.buildings.find((b) => b.id === P2)?.m2, 3850);
});

const cases: [string, Record<string, number>][] = [
  ['rooms=2', { [P1]: 3, [P2]: 2, [P3]: 1 }],
  ['rooms=5&type=house', { [P1]: 1 }],
  ['type=all', { [P1]: 5, [P2]: 2, [P3]: 2 }],
  ['months=60', { [P1]: 5, [P2]: 2, [P3]: 3 }],
  ['months=12', { [P1]: 4, [P2]: 2, [P3]: 2 }],
  ['surface_min=45&surface_max=46', { [P1]: 2, [P3]: 1 }],
  ['price_min=170000&price_max=180000', { [P1]: 1, [P3]: 1 }],
];
for (const [query, expected] of cases) {
  test(`sales map filter ${query}`, async () => {
    const full = new URLSearchParams({ type: 'apartment', months: '24' });
    for (const [k, v] of new URLSearchParams(query)) {
      full.set(k, v);
    }
    const body = await getSalesByQuery('49007', full.toString());
    assert.deepEqual(Object.fromEntries(body.buildings.map((b) => [b.id, b.n])), expected);
  });
}

test('Paris as a whole merges its arrondissements; an arrondissement alone', async () => {
  const whole = await getSales('75056', flats);
  assert.deepEqual(whole.commune, { code: '75056', name: 'Paris' });
  assert.equal(whole.buildings.length, 2);
  const first = await getSales('75101', flats);
  assert.deepEqual(first.commune, { code: '75101', name: 'Paris 1er Arrondissement' });
  assert.deepEqual(first.buildings.map((b) => b.id), ['75101000AA0001']);
  assert.deepEqual(first.reference, { n: 1, median_m2: null });
  const building = await getBuilding('75056', '75102000AA0001', flats);
  assert.equal(building.commune.code, '75102');
});

test('unknown commune: not found', async () => {
  await assert.rejects(getSales('99999', flats), (e: unknown) => e instanceof SalesApiError && e.kind === 'not_found');
});

test('building panel', async () => {
  const body = await getBuilding('49007', P1, flats);
  assert.deepEqual([body.id, body.lon, body.lat, body.addresses], [P1, 4, 47, ['1 rue Test']]);
  assert.deepEqual(body.commune, { code: '49007', name: 'Angers', median_m2: 4000 });
  assert.deepEqual(body.street, { name: 'rue Test', n: 6, median_m2: 4000 });
  assert.deepEqual(body.stats, { n: 4, median_m2: 4100, p25_m2: 3950, p75_m2: 4250 });
  assert.deepEqual(body.sales.map((s) => s.id), [1, 6, 2, 5, 3, 4, 0].map((n) => id(n)));
  assert.deepEqual(body.sales.map((s) => s.matches_filters), [true, false, true, false, true, true, false]);
  assert.deepEqual(body.sales[0], {
    id: id(1), date: '2026-05-12', address: '1 rue Test', type: 'apartment', rooms: 2, surface: 45, carrez: 44.5, land: null,
    price: 189000, price_m2: 4200, lots: [], n_lots: 1, n_dependencies: 1, new: false, gap_commune: 0.05, matches_filters: true,
  });
  assert.equal(body.sales[3].land, 200);
  assert.equal(body.sales[3].gap_commune, null);
});

test('building filters and errors', async () => {
  const two: SalesFilters = { ...flats, rooms: 2 };
  const body = await getBuilding('49007', P1, two);
  assert.equal(body.stats.n, 3);
  assert.equal(body.stats.median_m2, 4200);
  await assert.rejects(getBuilding('49007', '49007000ZZ9999', flats), (e: unknown) => e instanceof SalesApiError && e.kind === 'not_found');
});

test('sale sheet', async () => {
  const body = await getSale(id(1));
  const { sale } = body;
  assert.equal(sale.id, id(1));
  assert.equal(sale.price_m2, 4200);
  assert.equal(sale.gap_commune, 0.05);
  assert.deepEqual(
    [sale.postcode, sale.section, sale.parcel, sale.lon, sale.lat, sale.location_precision, sale.departement],
    ['49100', '49007000AB', P1, 4, 47, 'parcel', '49'],
  );
  assert.deepEqual(sale.commune, { code: '49007', name: 'Angers' });
  assert.deepEqual(body.similar_rule, { surface_ratio: 0.2, rooms: 1, months: 6 });
  assert.deepEqual(body.position.map((p) => p.level), ['building', 'street', 'section', 'commune']);
  assert.deepEqual(body.position[0], { level: 'building', n: 2, median_m2: null, gap: null, percentile: null });
  assert.deepEqual(body.position[1], { level: 'street', n: 3, median_m2: 4000, gap: 0.05, percentile: 1 });
  assert.equal(body.position[3].n, 4);
  assert.equal(body.position[3].median_m2, 4000);
  assert.deepEqual(body.comparables.map((c) => c.id), [2, 3, 7, 11].map((n) => id(n)));
  assert.equal(body.comparables[0].km, 0);
  assert.ok((body.comparables[2].km as number) > 0 && (body.comparables[2].km as number) < (body.comparables[3].km as number));
  assert.deepEqual(Object.keys(body.comparables[0]).sort(), ['address', 'date', 'id', 'km', 'lat', 'lon', 'price', 'price_m2', 'rooms', 'surface']);
  assert.deepEqual(body.value_today, { level: 'commune', from_year: '2025', to_year: '2025', factor: 1, value: 189000, gain: 0 });
  assert.equal(body.model, null);
  assert.deepEqual(body.resale?.previous, { id: id(0), date: '2022-03-02', price: 150000 });
  assert.equal(body.resale?.next, null);
  assert.equal(body.resale?.holding_years, 4.2);
  assert.equal(body.resale?.gain, 39000);
  assert.ok(Math.abs((body.resale?.annual_rate as number) - ((189000 / 150000) ** (365.25 / 1532) - 1)) < 1e-4);
  assert.deepEqual(body.building_sales.map((s) => s.id), [6, 2, 5, 3, 4, 0].map((n) => id(n)));
  assert.deepEqual(Object.keys(body.building_sales[0]).sort(), ['date', 'id', 'price_m2', 'rooms', 'surface', 'type']);
});

test('value today over years, next resale, a house and a flat alone', async () => {
  const s0 = await getSale(id(0));
  assert.deepEqual(s0.value_today, { level: 'commune', from_year: '2022', to_year: '2025', factor: 1.1, value: 165000, gain: 15000 });
  assert.equal(s0.resale?.previous, null);
  assert.equal(s0.resale?.next?.id, id(1));
  assert.equal(s0.resale?.gain, 39000);
  const house = await getSale(id(5));
  assert.equal(house.value_today?.level, 'departement');
  assert.equal(house.resale, null);
  const alone = await getSale(id(2));
  assert.equal(alone.resale, null);
});

test('a Paris sale by its arrondissement; unknown and old ids are not found', async () => {
  const sheet = await getSale(id(12, '75101'));
  assert.deepEqual(sheet.sale.commune, { code: '75101', name: 'Paris 1er Arrondissement' });
  for (const bad of [id(99), 'f'.repeat(32), 'not-an-id', id(1, '99999')]) {
    await assert.rejects(getSale(bad), (e: unknown) => e instanceof SalesApiError && e.kind === 'not_found' && e.message === 'vente introuvable');
  }
});
