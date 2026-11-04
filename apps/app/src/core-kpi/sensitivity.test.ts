import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeDeal, type DealInput } from './deal.ts';
import { sensitivity } from './sensitivity.ts';

const INPUT: DealInput = {
  price: 200_000, surfaceM2: 50, isNewBuild: false, agencyFees: 0, works: 0, furniture: 0, rentMonthly: 900,
  vacancyMonths: 1, taxeFonciereYearly: 900, nonRecoverableChargesYearly: 300, pnoInsuranceYearly: 120,
  managementShare: 0, maintenanceShare: 0.05, downPayment: 20_000, loanRate: 0.035, loanYears: 20,
  loanInsuranceRate: 0.003, incomeMonthly: 3_000, existingDebtMonthly: 0,
};

test('the grid has one row per rate and one column per price change', () => {
  const grid = sensitivity(INPUT, [0.03, 0.035, 0.04], [-0.1, 0, 0.1]);
  assert.equal(grid.length, 3);
  assert.equal(grid[0].cells.length, 3);
  assert.equal(grid[1].rate, 0.035);
  assert.equal(grid[0].cells[2].priceChange, 0.1);
});

test('the unchanged cell is the deal itself; dearer money or a dearer price lowers cash-flow', () => {
  const grid = sensitivity(INPUT, [0.03, 0.035, 0.04], [-0.1, 0, 0.1]);
  assert.equal(grid[1].cells[1].cashFlowMonthly, analyzeDeal(INPUT).cashFlowMonthly);
  assert.ok(grid[2].cells[1].cashFlowMonthly < grid[0].cells[1].cashFlowMonthly);
  assert.ok(grid[1].cells[2].cashFlowMonthly < grid[1].cells[0].cashFlowMonthly);
});

test('the down payment follows the price at the same share', () => {
  const grid = sensitivity(INPUT, [0.035], [0.1]);
  const expected = analyzeDeal({ ...INPUT, price: 220_000, downPayment: 22_000 }).cashFlowMonthly;
  assert.equal(grid[0].cells[0].cashFlowMonthly, expected);
});
