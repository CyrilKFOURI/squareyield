import assert from 'node:assert/strict';
import test from 'node:test';

import { departementPlaces, searchGrouped, searchPlaces } from './search.ts';
import type { IndexPlace } from './types.ts';

const p = (code: string, level: IndexPlace['level'], name: string, departement: string | null = code.slice(0, 2)): IndexPlace => ({
  code,
  level,
  name,
  departement,
  population: null,
});

// index order: biggest places first; the 20 Paris arrondissements fill a flat result list on their own
const arrondissements = Array.from({ length: 20 }, (_, i) => p(String(75101 + i), 'arrondissement', `Paris ${i + 1}e Arrondissement`));
const index = [p('75056', 'commune', 'Paris'), ...arrondissements, p('81202', 'commune', 'Parisot', '81'), p('33063', 'commune', 'Bordeaux')];
const deps = [p('75', 'departement', 'Paris', '75'), p('33', 'departement', 'Gironde', '33')];

test('a flat search is capped: the département would be lost behind the arrondissements', () => {
  assert.equal(searchPlaces([...index, ...deps], 'paris').some((r) => r.level === 'departement'), false);
});

test('grouped search: Départements and Communes never mixed, arrondissements with the communes', () => {
  const groups = searchGrouped([...index, ...deps], 'Paris', { departement: 3, commune: 5 });
  assert.deepEqual(
    groups.map((g) => g.label),
    ['Départements', 'Communes'],
  );
  assert.deepEqual(groups[0].places.map((r) => r.code), ['75']);
  assert.deepEqual(groups[1].places.map((r) => r.code), ['75056', '75101', '75102', '75103', '75104']);
  assert.ok(groups[1].places.every((r) => r.level === 'commune' || r.level === 'arrondissement'));
});

test('grouped search drops empty groups and other levels; a code matches a département', () => {
  const regions = [p('75', 'region', 'Nouvelle-Aquitaine', null)];
  assert.deepEqual(
    searchGrouped([...index, ...deps, ...regions], '33').map((g) => [g.key, g.places.map((r) => r.code)]),
    [['departement', ['33']]],
  );
  assert.deepEqual(
    searchGrouped([...index, ...deps], 'bordeaux').map((g) => g.key),
    ['commune'],
  );
  assert.deepEqual(searchGrouped([...index, ...deps], 'p'), []);
});

test('département places from the explorer rows: one per code, biggest first', () => {
  const rows = [
    { code: '33', name: 'Gironde', population: 1_650_000 },
    { code: '33', name: 'Gironde', population: 1_650_000 },
    { code: '75', name: 'Paris', population: 2_100_000 },
    { code: '48', name: 'Lozère', population: null },
  ];
  assert.deepEqual(departementPlaces(rows), [
    { code: '75', level: 'departement', name: 'Paris', departement: '75', population: 2_100_000 },
    { code: '33', level: 'departement', name: 'Gironde', departement: '33', population: 1_650_000 },
    { code: '48', level: 'departement', name: 'Lozère', departement: '48', population: null },
  ]);
});

test('département places from the France level rows (both types, no population): one per code, code order kept', () => {
  const apartment = [
    { code: '01', name: 'Ain' },
    { code: '2A', name: 'Corse-du-Sud' },
  ];
  const house = [
    { code: '01', name: 'Ain' },
    { code: '02', name: 'Aisne' },
  ];
  assert.deepEqual(
    departementPlaces([...apartment, ...house]).map((r) => [r.code, r.name, r.population]),
    [
      ['01', 'Ain', null],
      ['2A', 'Corse-du-Sud', null],
      ['02', 'Aisne', null],
    ],
  );
});
