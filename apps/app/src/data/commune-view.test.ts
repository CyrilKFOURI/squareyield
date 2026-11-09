import assert from 'node:assert/strict';
import test from 'node:test';

import type { LevelPlace } from './api.ts';
import {
  arrondissementLabel,
  arrondissementPrefix,
  arrondissementsIn,
  cityOfArrondissement,
  compareYears,
  neighbourRows,
  yearPoints,
} from './commune-view.ts';
import type { Place } from './types.ts';

test('Paris, Lyon and Marseille have arrondissements, other communes none', () => {
  assert.equal(arrondissementPrefix('75056'), '751');
  assert.equal(arrondissementPrefix('69123'), '6938');
  assert.equal(arrondissementPrefix('13055'), '132');
  assert.equal(arrondissementPrefix('33063'), null);
});

test('an arrondissement belongs to its city', () => {
  assert.deepEqual(cityOfArrondissement('75115'), { code: '75056', name: 'Paris' });
  assert.deepEqual(cityOfArrondissement('69383'), { code: '69123', name: 'Lyon' });
  assert.deepEqual(cityOfArrondissement('13208'), { code: '13055', name: 'Marseille' });
  assert.equal(cityOfArrondissement('33063'), null);
  assert.equal(cityOfArrondissement('75056'), null);
});

test('short arrondissement label', () => {
  assert.equal(arrondissementLabel('Paris 15e Arrondissement'), '15e');
  assert.equal(arrondissementLabel('Lyon 1er Arrondissement'), '1er');
  assert.equal(arrondissementLabel('Ailleurs'), 'Ailleurs');
});

const row = (over: Partial<LevelPlace>): LevelPlace =>
  ({ code: '75101', name: 'Paris 1er Arrondissement', level: 'arrondissement', n: 100, price: 12000, ...over }) as LevelPlace;

test('arrondissements of a city from the département level rows: in code order, communes and other cities dropped', () => {
  const rows = [
    row({ code: '75115' }),
    row({ code: '75102' }),
    row({ code: '75056', level: 'commune' }),
    row({ code: '69381' }),
  ];
  assert.deepEqual(
    arrondissementsIn(rows, '75056').map((r) => r.code),
    ['75102', '75115'],
  );
  assert.deepEqual(arrondissementsIn(rows, '33063'), []);
});

test('year points from medians aligned on the years: missing years dropped', () => {
  assert.deepEqual(yearPoints(['2022', '2023', '2024'], [null, 3100, 3200]), [
    { period: '2023', median: 3100 },
    { period: '2024', median: 3200 },
  ]);
  assert.deepEqual(yearPoints(['2022'], []), []);
});

type Neighbour = NonNullable<Place['neighbours']>[number];

test('neighbour rows read the figures of one type; a type without figures keeps the row with nulls', () => {
  const neighbours: Neighbour[] = [
    ['33069', 'Le Bouscat', 3.2, 'commune', -0.6, 44.86, { apartment: [120, 4100, 0.02, 0.045], house: [80, 5000, null, null] }],
    ['33522', 'Talence', 3.4, 'commune', -0.59, 44.8, { house: [60, 4300, -0.01, 0.04] }],
  ];
  assert.deepEqual(neighbourRows(neighbours, 'apartment'), [
    { code: '33069', name: 'Le Bouscat', km: 3.2, level: 'commune', lon: -0.6, lat: 44.86, n: 120, price: 4100, yoy: 0.02, gross: 0.045 },
    { code: '33522', name: 'Talence', km: 3.4, level: 'commune', lon: -0.59, lat: 44.8, n: null, price: null, yoy: null, gross: null },
  ]);
  assert.equal(neighbourRows(neighbours, 'house')[0].yoy, null);
});

test('neighbour rows of an older place file (code, name, km only): no level, point or figures', () => {
  const old = [['33069', 'Le Bouscat', 3.2]] as unknown as Neighbour[];
  assert.deepEqual(neighbourRows(old, 'apartment'), [
    { code: '33069', name: 'Le Bouscat', km: 3.2, level: null, lon: null, lat: null, n: null, price: null, yoy: null, gross: null },
  ]);
  assert.deepEqual(neighbourRows(undefined, 'apartment'), []);
});

test('compareYears aligns lines on the years and rebases on the first year all lines share', () => {
  const lines = [
    { name: 'Commune', points: [{ period: '2023', median: 4000 }, { period: '2024', median: 4400 }] },
    { name: 'France', points: [{ period: '2022', median: 1000 }, { period: '2023', median: 2000 }, { period: '2024', median: 2100 }] },
  ];
  const years = ['2022', '2023', '2024'];
  assert.deepEqual(compareYears(lines, years, false), [
    { name: 'Commune', values: [null, 4000, 4400] },
    { name: 'France', values: [1000, 2000, 2100] },
  ]);
  assert.deepEqual(compareYears(lines, years, true), [
    { name: 'Commune', values: [null, 100, 110] },
    { name: 'France', values: [50, 100, 105] },
  ]);
});

test('compareYears without a common year rebases each line on its own first value', () => {
  const lines = [
    { name: 'A', points: [{ period: '2022', median: 200 }] },
    { name: 'B', points: [{ period: '2023', median: 50 }, { period: '2024', median: 60 }] },
  ];
  assert.deepEqual(compareYears(lines, ['2022', '2023', '2024'], true), [
    { name: 'A', values: [100, null, null] },
    { name: 'B', values: [null, 100, 120] },
  ]);
});
