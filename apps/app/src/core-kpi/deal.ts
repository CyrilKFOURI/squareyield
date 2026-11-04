// Deal KPIs D1–D12 (docs/KPI_SPEC.md §2, docs/features/004-deal-simulator/spec.md).
// Pure functions: no React, no I/O, so the app, the extension and the dashboard share them.
import { FR_RULES } from './rules.ts';

export type DealInput = {
  price: number;
  surfaceM2: number;
  isNewBuild: boolean;
  agencyFees: number;
  works: number;
  furniture: number;
  /** Monthly rent the tenant pays, excluding recoverable charges. */
  rentMonthly: number;
  vacancyMonths: number;
  taxeFonciereYearly: number;
  /** Condo charges the owner cannot pass on to the tenant. */
  nonRecoverableChargesYearly: number;
  pnoInsuranceYearly: number;
  /** Share of collected rent paid to a letting agent (0 when self-managed). */
  managementShare: number;
  /** Repairs budget as a share of collected rent. */
  maintenanceShare: number;
  downPayment: number;
  loanRate: number;
  loanYears: number;
  loanInsuranceRate: number;
  /** Borrower's monthly net income and existing monthly loan payments (for HCSF). */
  incomeMonthly: number;
  existingDebtMonthly: number;
};

export type MarketReference = { medianPriceM2: number; p25PriceM2: number; p75PriceM2: number };

export type DealResult = {
  notaryFees: number;
  totalCost: number;
  loanAmount: number;
  paymentMonthly: number;
  effectiveRentYearly: number;
  operatingCostsYearly: number;
  noiYearly: number;
  grossYield: number | null;
  netYield: number | null;
  capRate: number | null;
  cashFlowMonthly: number;
  quickTestMonthly: number;
  /** null when no cash is put in (return is unbounded). */
  cashOnCash: number | null;
  /** null when there is no loan. */
  dscr: number | null;
  hcsfDebtRatio: number | null;
  hcsfOk: boolean;
  priceM2: number | null;
  priceVsMarket: number | null;
  marketPosition: 'below' | 'within' | 'above' | null;
};

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

/** Monthly payment of a fixed-rate loan (annuity) plus borrower insurance on the initial capital. */
export const loanPayment = (amount: number, annualRate: number, years: number, insuranceRate = 0): number => {
  if (amount <= 0 || years <= 0) {
    return 0;
  }
  const months = years * 12;
  const monthlyRate = annualRate / 12;
  const principalAndInterest =
    monthlyRate === 0 ? amount / months : (amount * monthlyRate) / (1 - (1 + monthlyRate) ** -months);
  return principalAndInterest + (amount * insuranceRate) / 12;
};

const marketPosition = (priceM2: number, market: MarketReference): DealResult['marketPosition'] => {
  if (priceM2 < market.p25PriceM2) {
    return 'below';
  }
  return priceM2 > market.p75PriceM2 ? 'above' : 'within';
};

export const analyzeDeal = (input: DealInput, market?: MarketReference): DealResult => {
  const notaryRate = input.isNewBuild ? FR_RULES.notaryRateNew : FR_RULES.notaryRateOld;
  const notaryFees = input.price * notaryRate;
  const totalCost = input.price + notaryFees + input.agencyFees + input.works + input.furniture;
  const loanAmount = Math.max(totalCost - input.downPayment, 0);
  const paymentMonthly = loanPayment(loanAmount, input.loanRate, input.loanYears, input.loanInsuranceRate);

  const effectiveRentYearly = input.rentMonthly * Math.max(12 - input.vacancyMonths, 0);
  const operatingCostsYearly =
    input.taxeFonciereYearly +
    input.nonRecoverableChargesYearly +
    input.pnoInsuranceYearly +
    (input.managementShare + input.maintenanceShare) * effectiveRentYearly;
  const noiYearly = effectiveRentYearly - operatingCostsYearly;
  const debtServiceYearly = 12 * paymentMonthly;
  const cashFlowMonthly = (noiYearly - debtServiceYearly) / 12;

  const hcsfDebtRatio = ratio(
    input.existingDebtMonthly + paymentMonthly,
    input.incomeMonthly + FR_RULES.rentCountedByBanks * input.rentMonthly,
  );
  const priceM2 = ratio(input.price, input.surfaceM2);

  return {
    notaryFees,
    totalCost,
    loanAmount,
    paymentMonthly,
    effectiveRentYearly,
    operatingCostsYearly,
    noiYearly,
    grossYield: ratio(12 * input.rentMonthly, totalCost),
    netYield: ratio(noiYearly, totalCost),
    capRate: ratio(noiYearly, input.price),
    cashFlowMonthly,
    quickTestMonthly: FR_RULES.quickTestRentShare * input.rentMonthly - paymentMonthly,
    cashOnCash: ratio(12 * cashFlowMonthly, input.downPayment),
    dscr: ratio(noiYearly, debtServiceYearly),
    hcsfDebtRatio,
    hcsfOk:
      (hcsfDebtRatio == null || hcsfDebtRatio <= FR_RULES.hcsfMaxDebtRatio) &&
      input.loanYears <= FR_RULES.hcsfMaxYears,
    priceM2,
    priceVsMarket: market && priceM2 != null ? priceM2 / market.medianPriceM2 - 1 : null,
    marketPosition: market && priceM2 != null ? marketPosition(priceM2, market) : null,
  };
};
