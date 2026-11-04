import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeDeal, type DealInput } from './deal.ts';
import {
  breakEvenOccupancy,
  brrrr,
  capitalGainsTax,
  internalRateOfReturn,
  leverageEffect,
  type ProjectionInput,
  projectDeal,
} from './projection.ts';

const close = (actual: number | null, expected: number, tolerance = 1e-6) =>
  assert.ok(actual != null && Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

const INPUT: DealInput = {
  price: 150_000, surfaceM2: 45, isNewBuild: false, agencyFees: 0, works: 0, furniture: 7_000,
  rentMonthly: 750, vacancyMonths: 1, taxeFonciereYearly: 800, nonRecoverableChargesYearly: 300,
  pnoInsuranceYearly: 150, managementShare: 0, maintenanceShare: 0.05, downPayment: 30_000,
  loanRate: 0.035, loanYears: 20, loanInsuranceRate: 0.003, incomeMonthly: 3_000, existingDebtMonthly: 0,
};

const PROJECTION: ProjectionInput = {
  horizonYears: 15, priceGrowth: 0.01, rentGrowth: 0.015, sellingCostShare: 0, regime: 'micro_foncier', marginalRate: 0.3,
};

test('IRR of a simple one-year investment', () => {
  close(internalRateOfReturn([-100, 110]), 0.1);
  assert.equal(internalRateOfReturn([-100, -10]), null);
});

test('capital gains: 36.2 % before 6 years, income tax exempt at 22, everything exempt at 30', () => {
  // gain = 200 000 − 150 000 × 1.075 (flat acquisition fees) = 38 750
  close(capitalGainsTax(150_000, 200_000, 5, 0), 38_750 * 0.362, 1e-6);
  // at 22 years: income tax 0, social charges keep 72 % (1.65 % × 16 + 1.6 %)
  const gain22 = 200_000 - 150_000 * (1.075 + 0.15);
  close(capitalGainsTax(150_000, 200_000, 22, 0), gain22 * 0.72 * 0.172, 1e-6);
  assert.equal(capitalGainsTax(150_000, 300_000, 30, 0), 0);
});

test('projection: IRR makes the NPV of the equity flows zero', () => {
  const deal = analyzeDeal(INPUT);
  const result = projectDeal(INPUT, deal, PROJECTION);
  assert.equal(result.years.length, 15);
  close(result.equityInvested, deal.totalCost - deal.loanAmount);
  const flows = [-result.equityInvested, ...result.years.map((y) => y.cashFlow)];
  flows[flows.length - 1] += result.netSaleProceeds;
  const npv = flows.reduce((s, f, t) => s + f / (1 + (result.irr ?? 0)) ** t, 0);
  close(npv, 0, 1e-3);
  // the loan is paid down: balance after 15 of 20 years is well below the initial amount
  assert.ok(result.years[14].loanBalance < deal.loanAmount * 0.4);
});

test('LMNP depreciation lowers yearly tax but is added back to the capital gain', () => {
  const deal = analyzeDeal(INPUT);
  const reel = projectDeal(INPUT, deal, { ...PROJECTION, regime: 'reel_foncier', priceGrowth: 0.03 });
  const lmnp = projectDeal(INPUT, deal, { ...PROJECTION, regime: 'lmnp_reel', priceGrowth: 0.03 });
  const tax = (r: typeof reel) => r.years.reduce((s, y) => s + y.tax, 0);
  assert.ok(tax(lmnp) < tax(reel));
  assert.ok(lmnp.capitalGainsTax > reel.capitalGainsTax);
});

test('leverage effect: positive when the property earns more than the loan costs', () => {
  const deal = analyzeDeal(INPUT);
  const lev = leverageEffect(INPUT, deal);
  close(lev.debtCost, 0.038);
  assert.equal(lev.positive, lev.propertyReturn > 0.038);
  close(lev.equityReturn ?? 0, lev.propertyReturn + (lev.propertyReturn - 0.038) * (lev.debtToEquity ?? 0));
});

test('break-even occupancy covers fixed costs and the loan', () => {
  const deal = analyzeDeal(INPUT);
  const expected = (800 + 300 + 150 + 12 * deal.paymentMonthly) / (9_000 * 0.95);
  close(breakEvenOccupancy(INPUT, deal), expected);
});

test('BRRRR: 70 % rule and refinance at 75 % of the after-repair value', () => {
  const deal = analyzeDeal({ ...INPUT, price: 100_000, works: 40_000 });
  const result = brrrr(220_000, deal, 40_000);
  assert.equal(result.maxOffer, 220_000 * 0.7 - 40_000);
  assert.equal(result.refinance, 165_000);
  close(result.cashLeft, deal.totalCost - 165_000);
});
