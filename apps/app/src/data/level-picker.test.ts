import assert from 'node:assert/strict';
import test from 'node:test';

import {
  areaLabel,
  communeItems,
  departementItems,
  filterItems,
  levelHref,
  moveActive,
  pickerType,
  typeQuery,
} from './level-picker.ts';

type Row = { code: string; name: string; level: 'departement' | 'commune' | 'arrondissement'; n: number; price: number | null };
const row = (code: string, name: string, price: number | null, n = 10, level: Row['level'] = 'departement'): Row => ({ code, name, level, n, price });

test('the page type defaults to flats; the query keeps the type only when the page had one', () => {
  assert.equal(pickerType(undefined), 'apartment');
  assert.equal(pickerType('house'), 'house');
  assert.equal(pickerType('all'), 'apartment');
  assert.equal(typeQuery(undefined), '');
  assert.equal(typeQuery('house'), '?type=house');
});

test('a label reads "code · name"', () => {
  assert.equal(areaLabel({ code: '33', name: 'Gironde' }), '33 · Gironde');
});

test('every département once, in official code order, with the median of the page type', () => {
  const items = departementItems(
    {
      apartment: [row('971', 'Guadeloupe', 2900), row('21', "Côte-d'Or", 2300), row('2B', 'Haute-Corse', 3100), row('01', 'Ain', 2600), row('2A', 'Corse-du-Sud', 3500), row('19', 'Corrèze', 1400)],
      house: [row('01', 'Ain', 2500), row('976', 'Mayotte', null), row('21', "Côte-d'Or", 2000)],
    },
    'apartment',
  );
  assert.deepEqual(
    items.map((i) => i.code),
    ['01', '19', '2A', '2B', '21', '971', '976'],
  );
  assert.equal(items[0].price, 2600);
  // only in the other type: listed, without a price for this one
  assert.equal(items.at(-1)?.price, null);
  assert.equal(items.at(-1)?.name, 'Mayotte');
  assert.equal(items[0].level, 'departement');
});

test('the house list takes the house medians', () => {
  const items = departementItems({ apartment: [row('01', 'Ain', 2600)], house: [row('01', 'Ain', 2500)] }, 'house');
  assert.equal(items[0].price, 2500);
});

test('communes: union of both types, alphabetical with numbers in order, price and sales of the page type', () => {
  const items = communeItems(
    {
      apartment: [row('75110', 'Paris 10e Arrondissement', 10500, 900, 'arrondissement'), row('75102', 'Paris 2e Arrondissement', 11100, 365, 'arrondissement')],
      house: [row('75116', 'Paris 16e Arrondissement', 17800, 26, 'arrondissement'), row('75102', 'Paris 2e Arrondissement', 15000, 3, 'arrondissement')],
    },
    'apartment',
  );
  assert.deepEqual(
    items.map((i) => i.code),
    ['75102', '75110', '75116'],
  );
  assert.equal(items[0].price, 11100);
  assert.equal(items[0].n, 365);
  assert.equal(items[2].price, null);
  assert.equal(items[2].n, null);
  assert.equal(items[2].level, 'arrondissement');
});

test('communes sort by name ignoring accents (Égletons next to Eygurande)', () => {
  const items = communeItems(
    { apartment: [row('19082', 'Eygurande', 900, 3, 'commune'), row('19073', 'Égletons', 1000, 5, 'commune'), row('19031', 'Brive-la-Gaillarde', 1500, 80, 'commune')], house: [] },
    'apartment',
  );
  assert.deepEqual(
    items.map((i) => i.name),
    ['Brive-la-Gaillarde', 'Égletons', 'Eygurande'],
  );
});

const deps = departementItems(
  {
    apartment: [row('01', 'Ain', 1), row('21', "Côte-d'Or", 1), row('22', "Côtes-d'Armor", 1), row('33', 'Gironde', 1), row('2A', 'Corse-du-Sud', 1), row('13', 'Bouches-du-Rhône', 1)],
    house: [],
  },
  'apartment',
);

test('search by code prefix: "33" finds Gironde, "2a" finds Corse-du-Sud', () => {
  assert.deepEqual(
    filterItems(deps, '33').map((i) => i.code),
    ['33'],
  );
  assert.deepEqual(
    filterItems(deps, '2a').map((i) => i.code),
    ['2A'],
  );
  assert.deepEqual(
    filterItems(deps, '2').map((i) => i.code),
    ['2A', '21', '22'],
  );
});

test('search by name ignores case, accents and punctuation', () => {
  assert.deepEqual(
    filterItems(deps, 'gir').map((i) => i.code),
    ['33'],
  );
  assert.deepEqual(
    filterItems(deps, "cote d'or").map((i) => i.code),
    ['21'],
  );
  assert.deepEqual(
    filterItems(deps, 'COTE').map((i) => i.code),
    ['21', '22'],
  );
  assert.deepEqual(
    filterItems(deps, 'rhone').map((i) => i.code),
    ['13'],
  );
});

test('"33 gironde" (the label as shown) still matches; an empty query keeps everything in order', () => {
  assert.deepEqual(
    filterItems(deps, '33 · Gironde').map((i) => i.code),
    ['33'],
  );
  assert.equal(filterItems(deps, '  ').length, deps.length);
  assert.deepEqual(filterItems(deps, 'zzz'), []);
});

test('names starting with the query come before names that only contain it', () => {
  const communes = communeItems(
    { apartment: [row('33001', 'Arsac', 1, 1, 'commune'), row('33002', 'Saint-Médard-en-Jalles', 1, 1, 'commune'), row('33003', 'Médoc', 1, 1, 'commune')], house: [] },
    'apartment',
  );
  assert.deepEqual(
    filterItems(communes, 'med').map((i) => i.name),
    ['Médoc', 'Saint-Médard-en-Jalles'],
  );
});

test('a choice links to the département page or the place page, keeping the type', () => {
  assert.equal(levelHref({ code: '33', level: 'departement' }, '?type=house'), '/departement/33?type=house');
  assert.equal(levelHref({ code: '33063', level: 'commune' }, ''), '/place/commune/33063');
  assert.equal(levelHref({ code: '75115', level: 'arrondissement' }, '?type=apartment'), '/place/arrondissement/75115?type=apartment');
});

test('arrow keys move inside the list and stop at both ends', () => {
  assert.equal(moveActive(0, 1, 5), 1);
  assert.equal(moveActive(4, 1, 5), 4);
  assert.equal(moveActive(0, -1, 5), 0);
  assert.equal(moveActive(3, -1, 5), 2);
  assert.equal(moveActive(-1, 1, 5), 0);
  assert.equal(moveActive(0, 1, 0), -1);
  // Page Down / Page Up jump and still stop at the ends
  assert.equal(moveActive(2, 10, 5), 4);
  assert.equal(moveActive(2, -10, 5), 0);
});
