// Run with `npm test` (Node's built-in runner, no dependency).
import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeDeal, type DealInput, loanPayment } from './deal.ts';

const close = (actual: number | null, expected: number, tolerance = 0.01) =>
  assert.ok(actual != null && Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

const BASE: DealInput = {
  price: 200_000,
  surfaceM2: 50,
  isNewBuild: false,
  agencyFees: 0,
  works: 0,
  furniture: 0,
  rentMonthly: 1_000,
  vacancyMonths: 0,
  taxeFonciereYearly: 1_000,
  nonRecoverableChargesYearly: 500,
  pnoInsuranceYearly: 100,
  managementShare: 0,
  maintenanceShare: 0,
  downPayment: 215_000, // everything paid cash: no loan
  loanRate: 0.035,
  loanYears: 20,
  loanInsuranceRate: 0,
  incomeMonthly: 3_000,
  existingDebtMonthly: 0,
};

test('annuity: 160 000 € at 3.5 % over 20 years', () => {
  // reference: 160000 × 0.0029167 / (1 − 1.0029167^−240) = 927.94 €
  close(loanPayment(160_000, 0.035, 20), 927.94);
});

test('annuity: zero rate and borrower insurance', () => {
  close(loanPayment(120_000, 0, 10), 1_000);
  close(loanPayment(120_000, 0, 10, 0.003), 1_030);
});

test('total cost includes 7.5 % notary fees on old property, 2.5 % on new', () => {
  assert.equal(analyzeDeal(BASE).totalCost, 215_000);
  assert.equal(analyzeDeal({ ...BASE, isNewBuild: true }).totalCost, 205_000);
});

test('yields and NOI without a loan', () => {
  const result = analyzeDeal(BASE);
  assert.equal(result.loanAmount, 0);
  assert.equal(result.noiYearly, 12_000 - 1_600);
  close(result.grossYield, 12_000 / 215_000, 1e-9);
  close(result.netYield, 10_400 / 215_000, 1e-9);
  close(result.capRate, 10_400 / 200_000, 1e-9);
  close(result.cashFlowMonthly, 10_400 / 12);
  assert.equal(result.dscr, null);
});

test('vacancy and rent-based costs apply to collected rent only', () => {
  const result = analyzeDeal({ ...BASE, vacancyMonths: 1, managementShare: 0.07, maintenanceShare: 0.05 });
  assert.equal(result.effectiveRentYearly, 11_000);
  close(result.operatingCostsYearly, 1_600 + 0.12 * 11_000);
});

test('leveraged deal: cash-flow, cash-on-cash, DSCR, quick test', () => {
  const result = analyzeDeal({ ...BASE, downPayment: 55_000 });
  close(result.loanAmount, 160_000);
  close(result.paymentMonthly, 927.94);
  close(result.cashFlowMonthly, (10_400 - 12 * 927.94) / 12, 0.05);
  close(result.cashOnCash, (12 * result.cashFlowMonthly) / 55_000, 1e-9);
  close(result.dscr, 10_400 / (12 * 927.94), 1e-4);
  close(result.quickTestMonthly, 700 - 927.94);
});

test('zero down payment: cash-on-cash is null, not Infinity', () => {
  assert.equal(analyzeDeal({ ...BASE, downPayment: 0 }).cashOnCash, null);
});

test('HCSF: 70 % of rent counted as income, 35 % limit, 25-year limit', () => {
  const result = analyzeDeal({ ...BASE, downPayment: 55_000, existingDebtMonthly: 400 });
  close(result.hcsfDebtRatio, (400 + 927.94) / (3_000 + 700), 1e-4);
  assert.equal(result.hcsfOk, false); // 35.9 %
  assert.equal(analyzeDeal({ ...BASE, loanYears: 27 }).hcsfOk, false);
  assert.equal(analyzeDeal(BASE).hcsfOk, true);
});

test('price vs market', () => {
  const market = { medianPriceM2: 3_200, p25PriceM2: 2_700, p75PriceM2: 3_700 };
  const result = analyzeDeal(BASE, market); // 4 000 €/m²
  close(result.priceVsMarket, 0.25, 1e-9);
  assert.equal(result.marketPosition, 'above');
  assert.equal(analyzeDeal({ ...BASE, price: 130_000 }, market).marketPosition, 'below');
});
