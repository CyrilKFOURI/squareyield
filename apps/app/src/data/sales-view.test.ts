import assert from 'node:assert/strict';
import test from 'node:test';

import { formatEurosPerM2 } from './format.ts';
import { FIXTURE_BUILDING, FIXTURE_SALES } from './sales-fixture.ts';
import {
  breaksKey,
  buildingFeatures,
  buildingLabel,
  defaultSalesFilters,
  dotRadius,
  formatDate,
  gap,
  gapTone,
  lotsLabel,
  medianLabel,
  parcelParam,
  percentileText,
  placeLevelOf,
  pointsBounds,
  saleDeal,
  saleRent,
  salesCountLabel,
  salesFiltersFromParams,
  salesFiltersToParams,
  salesQuery,
  scatterSeries,
  simulatorHref,
  spread,
  yearsOfRent,
} from './sales-view.ts';
import { PALETTES } from './scales.ts';

test('default sales filters follow the page type, 24 months, nothing else set', () => {
  assert.deepEqual(defaultSalesFilters('house'), {
    type: 'house', months: 24, rooms: null, surfaceMin: null, surfaceMax: null, priceMin: null, priceMax: null,
  });
});

test('API query: type and months always, the other filters only when set', () => {
  assert.equal(salesQuery(defaultSalesFilters('apartment')), 'type=apartment&months=24');
  assert.equal(
    salesQuery({ type: 'all', months: 60, rooms: 5, surfaceMin: 30, surfaceMax: 80, priceMin: null, priceMax: 400000 }),
    'type=all&months=60&rooms=5&surface_min=30&surface_max=80&price_max=400000',
  );
});

test('filters from URL params: invalid values dropped, min and max put back in order', () => {
  assert.deepEqual(salesFiltersFromParams({}, 'apartment'), defaultSalesFilters('apartment'));
  assert.deepEqual(
    salesFiltersFromParams({ s_type: 'all', s_months: '12', s_rooms: '3', s_smin: '90', s_smax: '40', s_pmin: 'abc', s_pmax: '-5' }, 'apartment'),
    { type: 'all', months: 12, rooms: 3, surfaceMin: 40, surfaceMax: 90, priceMin: null, priceMax: null },
  );
  assert.equal(salesFiltersFromParams({ s_months: '36', s_rooms: '9', s_type: 'castle' }, 'house').months, 24);
  assert.equal(salesFiltersFromParams({ s_rooms: '9' }, 'house').rooms, null);
  assert.equal(salesFiltersFromParams({ s_type: 'castle' }, 'house').type, 'house');
});

test('filters to URL params: values back to their default are removed (undefined), round trip holds', () => {
  const page = 'apartment';
  assert.deepEqual(salesFiltersToParams(defaultSalesFilters(page), page), {
    s_type: undefined, s_months: undefined, s_rooms: undefined, s_smin: undefined, s_smax: undefined, s_pmin: undefined, s_pmax: undefined,
  });
  const filters = { type: 'house' as const, months: 60 as const, rooms: 2 as const, surfaceMin: 20, surfaceMax: null, priceMin: 100000, priceMax: 250000 };
  const params = Object.fromEntries(Object.entries(salesFiltersToParams(filters, page)).filter((e): e is [string, string] => e[1] != null));
  assert.deepEqual(salesFiltersFromParams(params, page), filters);
});

test('selected building from the URL: a parcel id or nothing', () => {
  assert.equal(parcelParam({ building: '33063000AB0123' }), '33063000AB0123');
  assert.equal(parcelParam({ building: '2A004000AB0012' }), '2A004000AB0012');
  assert.equal(parcelParam({ building: '../etc' }), null);
  assert.equal(parcelParam({}), null);
});

test('dot radius grows with the number of sales, capped', () => {
  assert.ok(dotRadius(1) >= 4);
  assert.ok(dotRadius(4) > dotRadius(1));
  assert.ok(dotRadius(40) > dotRadius(4));
  assert.equal(dotRadius(10000), dotRadius(500));
  assert.ok(dotRadius(10000) <= 14);
  assert.equal(dotRadius(0), dotRadius(1));
});

test('colour classes come from the communes price breaks of the type (flats for "all")', () => {
  assert.equal(breaksKey('house'), 'price_house');
  assert.equal(breaksKey('apartment'), 'price_apartment');
  assert.equal(breaksKey('all'), 'price_apartment');
});

test('building features: colour by the €/m² of its sales even under 3 sales, selected one ringed and drawn last', () => {
  const breaks = [2000, 2700, 3400, 4300];
  const fc = buildingFeatures(FIXTURE_SALES.buildings, { breaks, palette: 'rdylgn', selected: '33063000AB0123', ring: '#000' });
  assert.equal(fc.features.length, 3);
  // big dots first, so small ones stay clickable on top; the selected one last
  assert.deepEqual(fc.features.map((f) => f.properties.id), ['33063000KD0042', '33063000AB0124', '33063000AB0123']);
  const byId = new Map(fc.features.map((f) => [f.properties.id, f.properties]));
  // 2 sales: no median in the panel, but the dot is coloured from them (2 500 €/m², 2nd class)
  assert.equal(byId.get('33063000AB0124')?._fill, PALETTES.rdylgn[1]);
  assert.equal(byId.get('33063000AB0124')?.median_m2, null);
  // the most expensive class is the bad end of RdYlGn (red) for a price
  assert.equal(byId.get('33063000KD0042')?._fill, PALETTES.rdylgn[4]);
  assert.equal(byId.get('33063000AB0123')?._stroke, 3);
  assert.equal(byId.get('33063000AB0123')?._strokeColor, '#000');
  assert.equal(byId.get('33063000KD0042')?._stroke, undefined);
  assert.deepEqual(fc.features[0].geometry, { type: 'Point', coordinates: [-0.58, 44.83] });
  assert.equal(byId.get('33063000AB0124')?.label, '110 cours Saint-Louis (+1 adresse)');
});

test('hover labels: first address and the sales count', () => {
  assert.equal(buildingLabel(['1 rue A']), '1 rue A');
  assert.equal(buildingLabel(['1 rue A', '2 rue B', '3 rue C']), '1 rue A (+2 adresses)');
  assert.equal(buildingLabel([]), 'Adresse inconnue');
  assert.equal(salesCountLabel(1), '1 vente');
  assert.equal(salesCountLabel(12), '12 ventes');
});

test('gap and its tone: dearer than the reference reads negative, a few percent is neutral', () => {
  assert.equal(gap(4400, 4000), 0.10000000000000009);
  assert.equal(gap(4000, null), null);
  assert.equal(gap(null, 4000), null);
  assert.equal(gapTone(0.1), 'neg');
  assert.equal(gapTone(-0.1), 'pos');
  assert.equal(gapTone(0.03), undefined);
  assert.equal(gapTone(null), undefined);
});

test('median label hides a median under 3 sales', () => {
  assert.equal(medianLabel(4310, 12), formatEurosPerM2(4310));
  assert.equal(medianLabel(null, 2), 'moins de 3 ventes');
  assert.equal(medianLabel(4000, 2), 'moins de 3 ventes');
  assert.equal(medianLabel(null, 10), '—');
});

test('lots label: numbers, then a count beyond three', () => {
  assert.equal(lotsLabel([]), '—');
  assert.equal(lotsLabel([{ number: '22', carrez: 44.8 }]), '22');
  assert.equal(lotsLabel([{ number: '5', carrez: null }, { number: '41', carrez: null }]), '5, 41');
  assert.equal(lotsLabel(['1', '2', '3', '4', '5'].map((number) => ({ number, carrez: null }))), '1, 2, 3 (+2)');
});

test('dates in French order, percentile in words', () => {
  assert.equal(formatDate('2026-05-12'), '12/05/2026');
  assert.equal(formatDate(null), '—');
  assert.equal(percentileText(0.62), 'plus cher que 62 % des ventes similaires');
  assert.equal(percentileText(null), '—');
});

test('scatter of a building: sales outside the filters apart, no €/m² skipped', () => {
  const { matching, others } = scatterSeries(FIXTURE_BUILDING.sales);
  assert.deepEqual(matching, [[Date.UTC(2026, 4, 12), 4181, 'a1']]);
  assert.deepEqual(others, [[Date.UTC(2024, 1, 10), 3261, 'a2']]);
});

test('spread of comparables: median and quartiles, null when empty', () => {
  assert.equal(spread([]), null);
  assert.deepEqual(spread([4000]), { n: 1, median: 4000, p25: 4000, p75: 4000 });
  assert.deepEqual(spread([1, 2, 3, 4, 5]), { n: 5, median: 3, p25: 2, p75: 4 });
  assert.deepEqual(spread([4, 1, 3, 2]), { n: 4, median: 2.5, p25: 1.75, p75: 3.25 });
});

test('arrondissements of Paris, Lyon and Marseille have their own level; whole cities are communes', () => {
  assert.equal(placeLevelOf('75115'), 'arrondissement');
  assert.equal(placeLevelOf('69383'), 'arrondissement');
  assert.equal(placeLevelOf('13208'), 'arrondissement');
  assert.equal(placeLevelOf('75056'), 'commune');
  assert.equal(placeLevelOf('33063'), 'commune');
});

test('bounds of points with a margin, null when empty', () => {
  assert.equal(pointsBounds([]), null);
  assert.deepEqual(pointsBounds([{ lon: 1, lat: 2 }, { lon: 3, lat: 1 }], 0.5), [[0.5, 0.5], [3.5, 2.5]]);
});

test('rent of a sale: the commune curve at its surface, else the cell rent; charges provision removed', () => {
  const curve = { ref_rent_m2: 14, ref_surface: 45, slope: 0 };
  assert.deepEqual(saleRent({ type: 'apartment', surface: 40, curve, cellRentM2: 20 }), { rentM2: 14, rentMonthly: 500 });
  assert.deepEqual(saleRent({ type: 'apartment', surface: 40, curve: undefined, cellRentM2: 12 }), { rentM2: 12, rentMonthly: 420 });
  assert.deepEqual(saleRent({ type: 'house', surface: 100, curve: undefined, cellRentM2: null }), { rentM2: null, rentMonthly: 0 });
});

test('deal of a sale at its price with default financing (core-kpi)', () => {
  const deal = saleDeal({ price: 150000, surface: 40, isNew: false, rentMonthly: 600, tfpbRate: 0.4 });
  assert.ok(deal.totalCost > 150000);
  assert.ok(Math.abs((deal.grossYield ?? 0) - (12 * 600) / deal.totalCost) < 1e-9);
  assert.ok(deal.paymentMonthly > 0);
  assert.equal(yearsOfRent(150000, 625), 20);
  assert.equal(yearsOfRent(150000, 0), null);
});

test('simulator link carries the place, type, price, surface and monthly rent', () => {
  assert.equal(
    simulatorHref({ level: 'arrondissement', code: '75115', type: 'apartment', price: 189000, surface: 44.8, rentMonthly: 620 }),
    '/simulator?level=arrondissement&code=75115&type=apartment&price=189000&surface=45&rent=620',
  );
  assert.equal(
    simulatorHref({ level: 'commune', code: '33063', type: 'house', price: 300000, surface: null, rentMonthly: 0 }),
    '/simulator?level=commune&code=33063&type=house&price=300000',
  );
});

test('localBreaks: quintile cuts of the buildings shown, so a dear city is not all one colour', async () => {
  const { localBreaks } = await import('./sales-view.ts');
  const medians = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
  const buildings = [...medians, null, null].map((m, i) => ({ m2: m, n: 3, id: String(i) }));
  const cuts = localBreaks(buildings);
  assert.deepEqual(cuts, [2000, 4000, 6000, 8000]);
  assert.deepEqual(cuts, [...cuts].sort((a, b) => a - b));
  // two buildings per class out of ten
  for (const cut of cuts) assert.equal(medians.filter((m) => m <= cut).length % 2, 0);
  // too few buildings with a median to cut into five classes
  assert.deepEqual(localBreaks(buildings.slice(0, 4)), []);
});
