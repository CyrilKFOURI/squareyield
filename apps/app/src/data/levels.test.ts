import assert from 'node:assert/strict';
import test from 'node:test';

import { codeCompare, completeYears, growth, indexTo, m2PerIncome, rankBars, rankOf, yearMatrix } from './levels.ts';

const deps = [
  { code: '21', v: 2000 },
  { code: '2A', v: 4000 },
  { code: '971', v: 3000 },
  { code: '01', v: 2500 },
  { code: '2B', v: null },
  { code: '19', v: 1500 },
];

test('département codes sort in the official order: Corse between 19 and 21, overseas last', () => {
  assert.deepEqual(['971', '2B', '21', '2A', '01', '19', '95'].sort(codeCompare), ['01', '19', '2A', '2B', '21', '95', '971']);
  assert.deepEqual(['2B033', '21231', '2A004', '19031'].sort(codeCompare), ['19031', '2A004', '2B033', '21231']);
});

test('bars: missing values dropped, sorted by code, highest or lowest, cut to a top N', () => {
  const value = (r: (typeof deps)[number]) => r.v;
  const code = (r: (typeof deps)[number]) => r.code;
  assert.deepEqual(rankBars(deps, value, code, 'code', null).map(code), ['01', '19', '2A', '21', '971']);
  assert.deepEqual(rankBars(deps, value, code, 'desc', 2).map(code), ['2A', '971']);
  assert.deepEqual(rankBars(deps, value, code, 'asc', 3).map(code), ['19', '21', '01']);
});

test('complete years need both halves; an edge year with one half is left out', () => {
  assert.deepEqual(completeYears(['2021-H2', '2022-H1', '2022-H2', '2023-H1', '2023-H2', '2024-H1']), ['2022', '2023']);
});

test('year matrix: medians per complete year and the change on the year before', () => {
  const rows = [
    { code: '01', period: '2022', median: 2000 },
    { code: '01', period: '2023', median: 2200 },
    { code: '01', period: '2021', median: 1000 },
    { code: '02', period: '2023', median: 1500 },
  ];
  const matrix = yearMatrix(rows, ['2022', '2023']);
  assert.deepEqual(matrix.map((r) => r.code), ['01', '02']);
  assert.deepEqual(matrix[0].medians, [2000, 2200]);
  assert.equal(matrix[0].changes[0], null);
  assert.ok(Math.abs((matrix[0].changes[1] as number) - 0.1) < 1e-12);
  assert.deepEqual(matrix[1].medians, [null, 1500]);
  assert.deepEqual(matrix[1].changes, [null, null]);
});

test('growth over the period: last known over first known; needs two values', () => {
  assert.ok(Math.abs((growth([2000, null, 2500]) as number) - 0.25) < 1e-12);
  assert.equal(growth([null, 2000]), null);
  assert.equal(growth([]), null);
});

test('index to France = 100, m² for a year of income, rank', () => {
  assert.equal(indexTo(4500, 3000), 150);
  assert.equal(indexTo(null, 3000), null);
  assert.equal(indexTo(4500, 0), null);
  assert.equal(m2PerIncome(24000, 3000), 8);
  assert.equal(m2PerIncome(null, 3000), null);
  const rows = [{ c: 'a', v: 3 }, { c: 'b', v: 5 }, { c: 'x', v: null }, { c: 'c', v: 4 }];
  assert.equal(rankOf(rows, 'c', (r) => r.c, (r) => r.v, 'desc'), 2);
  assert.equal(rankOf(rows, 'c', (r) => r.c, (r) => r.v, 'asc'), 2);
  assert.equal(rankOf(rows, 'b', (r) => r.c, (r) => r.v, 'asc'), 3);
  assert.equal(rankOf(rows, 'x', (r) => r.c, (r) => r.v, 'desc'), null);
});
