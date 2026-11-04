import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeDeal, type DealInput } from './deal.ts';
import { compareTaxRegimes, firstYearInterest } from './tax.ts';

const close = (actual: number, expected: number, tolerance = 0.5) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

const INPUT: DealInput = {
  price: 150_000,
  surfaceM2: 45,
  isNewBuild: false,
  agencyFees: 0,
  works: 0,
  furniture: 7_000,
  rentMonthly: 750,
  vacancyMonths: 0,
  taxeFonciereYearly: 750,
  nonRecoverableChargesYearly: 300,
  pnoInsuranceYearly: 150,
  managementShare: 0,
  maintenanceShare: 0,
  downPayment: 0,
  loanRate: 0.035,
  loanYears: 20,
  loanInsuranceRate: 0,
  incomeMonthly: 3_000,
  existingDebtMonthly: 0,
};

const byRegime = (input: DealInput, rate: number) =>
  Object.fromEntries(compareTaxRegimes(input, analyzeDeal(input), rate).map((r) => [r.regime, r]));

test('first-year interest of 160 000 € at 3.5 % over 20 years', () => {
  // amortisation table: month 1 interest = 466.67 €, decreasing; 12-month sum = 5 510.34 € (independent amortisation loop)
  close(firstYearInterest(160_000, 0.035, 20), 5_510.34, 0.01);
  assert.equal(firstYearInterest(160_000, 0, 20), 0);
});

test('micro-foncier taxes 70 % of rents at TMI + social charges', () => {
  const micro = byRegime(INPUT, 0.3).micro_foncier;
  assert.equal(micro.taxableIncome, 9_000 * 0.7);
  close(micro.totalTax, 6_300 * (0.3 + 0.172));
  assert.equal(micro.eligible, true);
});

test('micro-BIC taxes 50 % of rents', () => {
  assert.equal(byRegime(INPUT, 0.3).lmnp_micro.taxableIncome, 4_500);
});

test('réel foncier deducts charges and interest; a deficit means no tax', () => {
  const reel = byRegime(INPUT, 0.3).reel_foncier;
  const interest = firstYearInterest(analyzeDeal(INPUT).loanAmount, 0.035, 20);
  close(reel.taxableIncome, 9_000 - 1_200 - interest);
  const loss = byRegime({ ...INPUT, rentMonthly: 400, taxeFonciereYearly: 400 }, 0.3).reel_foncier;
  assert.equal(loss.totalTax, 0);
  assert.ok(loss.deficit > 0);
});

test('LMNP réel: depreciation brings the result to zero at most and the rest is carried', () => {
  const lmnp = byRegime(INPUT, 0.3).lmnp_reel;
  assert.equal(lmnp.taxableIncome, 0);
  assert.equal(lmnp.totalTax, 0);
  // depreciation 150 000 × 85 % / 30 + 7 000 / 7 = 5 250 €; part of it is carried
  assert.ok(lmnp.carriedDepreciation > 0 && lmnp.carriedDepreciation < 5_250);
});

test('ceilings: micro regimes become ineligible above their rent limits', () => {
  const big = byRegime({ ...INPUT, rentMonthly: 1_500 }, 0.3);
  assert.equal(big.micro_foncier.eligible, false); // 18 000 € > 15 000 €
  assert.equal(big.lmnp_micro.eligible, true);
});

test('after-tax cash-flow subtracts the monthly tax', () => {
  const deal = analyzeDeal(INPUT);
  const micro = compareTaxRegimes(INPUT, deal, 0.11)[0];
  close(micro.cashFlowAfterTaxMonthly, deal.cashFlowMonthly - micro.totalTax / 12, 0.01);
});

test('net-net yield is NOI minus tax over total cost', () => {
  const deal = analyzeDeal(INPUT);
  const micro = compareTaxRegimes(INPUT, deal, 0.3)[0];
  close(micro.netNetYield ?? 0, (deal.noiYearly - micro.totalTax) / deal.totalCost, 1e-9);
});
