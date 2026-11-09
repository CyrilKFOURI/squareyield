import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExplorerRow } from './explorer.ts';
import {
  BAR_METRICS,
  fromExplorer,
  fromRanking,
  investorSummary,
  median,
  parseDep,
  placeHref,
  QUADRANTS,
  quadrantOf,
  quadrantView,
  robustRange,
  type InvestRow,
} from './invest-view.ts';
import { applyScreenFilters, parseScreenFilters } from './screen-filters.ts';
import type { RankingRow } from './types.ts';

const near = (actual: number | null, expected: number) => assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

const ranking = (over: Partial<RankingRow>): RankingRow =>
  ({ code: '33063', level: 'commune', name: 'Bordeaux', departement: '33', region: '75', property_type: 'apartment', rooms_bucket: 'all',
    n_sales: 3173, reliability: 'ok', median_price_m2: 4300, typical_price: 202000, median_surface_m2: 47, yoy_change: -0.02,
    cagr: -0.036, rent_m2: 15.6, rent_level: 'commune', gross_yield: 0.047, net_yield: 0.031, cash_flow_monthly: -621, cap_rate: 0.03,
    population: 260000, population_growth_yearly: 0.01, vacancy_rate: 0.08, flag_high_vacancy: false, flag_population_decline: false,
    score: 40.7, share_fg: 0.06, tfpb_rate: 0.49, rent_control: true, ...over }) as RankingRow;

const explorer = (over: Partial<ExplorerRow>): ExplorerRow =>
  ({ code: '33001', name: 'Abzac', level: 'commune', parent: '33', type: 'apartment', size: 'all', n_sales: 21, reliability: 'low',
    median_price_m2: 1700, p25_price_m2: 1400, p75_price_m2: 2000, median_price: 146400, median_surface_m2: 83, yoy_change: 0.09,
    cagr: -0.005, new_premium: null, rent_m2: 10, gross_yield: 0.071, net_yield: 0.045, cash_flow_monthly: -260, cap_rate: 0.049,
    score: null, share_fg: 0.1, vacancy_rate: 0.08, population: 2048, population_growth_yearly: 0.009, median_living_standard: 23470,
    tenant_share: 0.33, tfpb_rate: 0.5, rent_control: false, flag_high_vacancy: false, flag_population_decline: false, ...over }) as ExplorerRow;

test('national ranking rows: typical price becomes the budget price, région and département kept, communes only', () => {
  const rows = fromRanking([
    ranking({}),
    ranking({ code: '75056', name: 'Paris', departement: '75', region: '11' }),
    ranking({ code: '75113', level: 'arrondissement', name: 'Paris 13e', departement: '75', region: '11' }),
  ]);
  assert.deepEqual(rows.map((r) => r.code), ['33063', '75056']);
  const [bordeaux] = rows;
  assert.equal(bordeaux.median_price, 202000);
  assert.equal(bordeaux.departement, '33');
  assert.equal(bordeaux.region, '75');
  assert.equal(bordeaux.p25_price_m2, null);
});

test('département rows: one segment, communes only, nothing under 10 sales, région of the département', () => {
  const rows = fromExplorer(
    [
      explorer({}),
      explorer({ code: '33002', type: 'house' }),
      explorer({ code: '33003', size: '2' }),
      explorer({ code: '33004', n_sales: 9 }),
      explorer({ code: '33', level: 'departement', parent: '75' }),
      explorer({ code: '69381', level: 'arrondissement', parent: '69' }),
    ],
    { type: 'apartment', size: 'all' },
    '75',
  );
  assert.deepEqual(rows.map((r) => r.code), ['33001']);
  assert.equal(rows[0].departement, '33');
  assert.equal(rows[0].region, '75');
  assert.equal(rows[0].median_price, 146400);
});

test('the 015 filters apply the same way to both sources (budget, région)', () => {
  const national = fromRanking([ranking({}), ranking({ code: '13055', name: 'Marseille', departement: '13', region: '93', typical_price: 150000 })]);
  assert.deepEqual(applyScreenFilters(national, parseScreenFilters({ budget: '160000' })).map((r) => r.code), ['13055']);
  assert.deepEqual(applyScreenFilters(national, parseScreenFilters({ region: '75' })).map((r) => r.code), ['33063']);
  const local = fromExplorer([explorer({}), explorer({ code: '33005', median_price: 300000 })], { type: 'apartment', size: 'all' }, '75');
  assert.deepEqual(applyScreenFilters(local, parseScreenFilters({ budget: '200000' })).map((r) => r.code), ['33001']);
});

test('median of an even and an odd list, nulls ignored', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, null, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('investor ribbon: count, median yields, share with a positive cash-flow, median price and score', () => {
  const rows = fromRanking([
    ranking({ code: 'a', gross_yield: 0.04, net_yield: 0.03, cash_flow_monthly: -100, typical_price: 100000, score: 40 }),
    ranking({ code: 'b', gross_yield: 0.06, net_yield: 0.04, cash_flow_monthly: 20, typical_price: 200000, score: 60 }),
    ranking({ code: 'c', gross_yield: 0.08, net_yield: null, cash_flow_monthly: null, typical_price: 300000, score: null }),
  ]);
  const s = investorSummary(rows);
  assert.equal(s.count, 3);
  assert.equal(s.grossYield, 0.06);
  near(s.netYield, 0.035);
  assert.equal(s.positiveCashFlow, 0.5); // 1 of the 2 rows with a cash-flow
  assert.equal(s.price, 200000);
  assert.equal(s.score, 50);
  assert.equal(investorSummary([]).positiveCashFlow, null);
});

test('quadrants: medians as the cross, rows without both values left out', () => {
  const rows = fromRanking([
    ranking({ code: 'hi-up', gross_yield: 0.08, yoy_change: 0.05 }),
    ranking({ code: 'hi-down', gross_yield: 0.07, yoy_change: -0.04 }),
    ranking({ code: 'lo-up', gross_yield: 0.03, yoy_change: 0.04 }),
    ranking({ code: 'lo-down', gross_yield: 0.04, yoy_change: -0.03 }),
    ranking({ code: 'none', gross_yield: 0.05, yoy_change: null }),
  ]);
  const view = quadrantView(rows, 'yoy_change');
  assert.equal(view.points.length, 4);
  near(view.yMid, 0.055);
  near(view.xMid, 0.005);
  assert.deepEqual(
    view.points.map((p) => [p.row.code, QUADRANTS[p.quadrant].label]),
    [
      ['hi-up', 'Rentable et en hausse'],
      ['hi-down', 'Rentable, prix à la traîne'],
      ['lo-up', 'Peu rentable, en hausse'],
      ['lo-down', 'Peu rentable et à la traîne'],
    ],
  );
  assert.deepEqual(view.counts, { up: 1, value: 1, growth: 1, weak: 1 });
  assert.equal(quadrantOf(0.055, 0.005, 0.055, 0.005), 'up');
  assert.deepEqual(quadrantView([], 'cagr').points, []);
});

test('chart frame: extreme values left out of the frame, the median cross always inside', () => {
  const values = [-0.6, ...Array.from({ length: 98 }, (_, i) => i / 1000), 0.9];
  const [lo, hi] = robustRange(values, 0.02, 0.98, 0.5);
  assert.ok(lo > -0.6 && lo <= 0.001, `lo ${lo}`);
  assert.ok(hi < 0.9 && hi >= 0.096, `hi ${hi}`);
  assert.deepEqual(robustRange([0.05, 0.05], 0, 1, 0.05).map((v) => Math.round(v * 1000)), [49, 51]);
  assert.deepEqual(robustRange([0.01, 0.02], 0, 1, 0.3)[1] >= 0.3, true);
});

test('bar metrics: score, yields and a signed cash-flow, each read from the row', () => {
  assert.deepEqual(BAR_METRICS.map((m) => m.key), ['score', 'gross_yield', 'net_yield', 'cash_flow_monthly']);
  const row = fromRanking([ranking({})])[0] as InvestRow;
  assert.equal(BAR_METRICS.find((m) => m.key === 'cash_flow_monthly')?.signed, true);
  assert.equal(BAR_METRICS.find((m) => m.key === 'gross_yield')?.value(row), 0.047);
});

test('links: the commune page of the row, with the type; département codes checked', () => {
  assert.equal(placeHref(fromRanking([ranking({})])[0], 'house'), '/place/commune/33063?type=house');
  assert.equal(parseDep('33'), '33');
  assert.equal(parseDep('2A'), '2A');
  assert.equal(parseDep('971'), '971');
  assert.equal(parseDep('../x'), null);
  assert.equal(parseDep(undefined), null);
});
