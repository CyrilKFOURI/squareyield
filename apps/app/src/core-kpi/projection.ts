// Multi-year KPIs (KPI_SPEC D14–D17): IRR with resale and capital gains tax, leverage effect,
// break-even occupancy, BRRRR. Pure functions, yearly steps, no inflation of the loan.
import { type DealInput, type DealResult, loanPayment } from './deal.ts';
import { BRRRR_RULES, CAPITAL_GAINS_RULES, TAX_RULES } from './rules.ts';
import type { TaxRegime } from './tax.ts';

export type ProjectionInput = {
  horizonYears: number;
  /** Yearly change of the property value (e.g. the commune's recent trend). */
  priceGrowth: number;
  /** Yearly change of rents and operating costs. */
  rentGrowth: number;
  /** Selling costs at exit (agency), share of the sale price. */
  sellingCostShare: number;
  regime: TaxRegime;
  marginalRate: number;
};

export type ProjectionYear = {
  year: number;
  rent: number;
  noi: number;
  interest: number;
  debtService: number;
  tax: number;
  cashFlow: number;
  loanBalance: number;
};

export type ProjectionResult = {
  years: ProjectionYear[];
  equityInvested: number;
  salePrice: number;
  capitalGainsTax: number;
  netSaleProceeds: number;
  /** Internal rate of return of the equity; null when it does not exist (e.g. never positive). */
  irr: number | null;
  /** Everything received (cash-flows + net sale) over the equity invested. */
  equityMultiple: number | null;
};

/** Yearly interest and end-of-year balance of an annuity loan. */
const amortization = (amount: number, annualRate: number, years: number, horizon: number) => {
  const monthly = loanPayment(amount, annualRate, years);
  const monthlyRate = annualRate / 12;
  let balance = amount;
  const out: { interest: number; balance: number }[] = [];
  for (let year = 1; year <= horizon; year += 1) {
    let interest = 0;
    for (let m = 0; m < 12 && balance > 0.005; m += 1) {
      const monthInterest = balance * monthlyRate;
      interest += monthInterest;
      balance = Math.max(balance - (monthly - monthInterest), 0);
    }
    out.push({ interest, balance });
  }
  return out;
};

/** Share of the gain exempted after `years` of holding, for one allowance schedule. */
const holdingAllowance = (years: number, from: number, perYear: number, year22: number, after22 = 0): number => {
  if (years < from) {
    return 0;
  }
  const regular = Math.min(years, 21) - from + 1; // years 6 to 21
  const allowance = regular * perYear + (years >= 22 ? year22 : 0) + Math.max(years - 22, 0) * after22;
  return Math.min(allowance, 1);
};

export const capitalGainsTax = (
  purchasePrice: number,
  salePrice: number,
  holdingYears: number,
  depreciationAddedBack: number,
): number => {
  const rules = CAPITAL_GAINS_RULES;
  const cost =
    purchasePrice *
    (1 + rules.acquisitionFeesFlat + (holdingYears > 5 ? rules.worksFlatAfter5Years : 0));
  const gain = Math.max(salePrice - cost + depreciationAddedBack, 0);
  const ir = rules.incomeTaxAllowance;
  const ps = rules.socialAllowance;
  const incomeTax = gain * (1 - holdingAllowance(holdingYears, ir.from, ir.perYear, ir.year22)) * rules.incomeTaxRate;
  const social =
    gain * (1 - holdingAllowance(holdingYears, ps.from, ps.perYear, ps.year22, ps.after22PerYear)) * rules.socialRate;
  return incomeTax + social;
};

/** IRR by bisection on [-99 %, +100 %]; null when NPV has no sign change on that range. */
export const internalRateOfReturn = (flows: number[]): number | null => {
  const npv = (rate: number) => flows.reduce((sum, flow, t) => sum + flow / (1 + rate) ** t, 0);
  let low = -0.99;
  let high = 1;
  if (npv(low) * npv(high) > 0) {
    return null;
  }
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (npv(low) * npv(mid) <= 0) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return (low + high) / 2;
};

const yearlyTax = (
  regime: TaxRegime,
  rent: number,
  noi: number,
  deductibleFinance: number,
  depreciationAvailable: number,
  marginalRate: number,
): { tax: number; depreciationUsed: number } => {
  const rate = marginalRate + TAX_RULES.socialRate;
  switch (regime) {
    case 'micro_foncier':
      return { tax: rent * (1 - TAX_RULES.microFoncierAllowance) * rate, depreciationUsed: 0 };
    case 'lmnp_micro':
      return { tax: rent * (1 - TAX_RULES.microBicAllowance) * rate, depreciationUsed: 0 };
    case 'reel_foncier':
      return { tax: Math.max(noi - deductibleFinance, 0) * rate, depreciationUsed: 0 };
    case 'lmnp_reel': {
      const beforeDepreciation = noi - deductibleFinance;
      const used = Math.min(depreciationAvailable, Math.max(beforeDepreciation, 0));
      return { tax: Math.max(beforeDepreciation - used, 0) * rate, depreciationUsed: used };
    }
  }
};

export const projectDeal = (input: DealInput, deal: DealResult, projection: ProjectionInput): ProjectionResult => {
  const { horizonYears, priceGrowth, rentGrowth, regime, marginalRate } = projection;
  const loan = amortization(deal.loanAmount, input.loanRate, input.loanYears, horizonYears);
  const monthlyPayment = deal.paymentMonthly;
  const insuranceYearly = deal.loanAmount * input.loanInsuranceRate;
  // depreciation: building over 30 years, furniture over 7, works over 15 (LMNP réel only)
  const buildingDepreciation = (input.price * (1 - TAX_RULES.landShare)) / TAX_RULES.buildingYears;
  let carried = 0;
  let buildingDepreciationTaken = 0;

  const years: ProjectionYear[] = [];
  for (let year = 1; year <= horizonYears; year += 1) {
    const growth = (1 + rentGrowth) ** (year - 1);
    const rent = deal.effectiveRentYearly * growth;
    const noi = deal.noiYearly * growth;
    const { interest, balance } = loan[year - 1];
    const loanRunning = year <= input.loanYears;
    const debtService = loanRunning ? 12 * monthlyPayment : 0;
    const available =
      carried +
      buildingDepreciation +
      (year <= TAX_RULES.furnitureYears ? input.furniture / TAX_RULES.furnitureYears : 0) +
      (year <= TAX_RULES.worksYears ? input.works / TAX_RULES.worksYears : 0);
    const { tax, depreciationUsed } = yearlyTax(
      regime, rent, noi, interest + (loanRunning ? insuranceYearly : 0), available, marginalRate,
    );
    carried = available - depreciationUsed;
    // building depreciation is used first (it is the part added back to the capital gain)
    buildingDepreciationTaken += Math.min(depreciationUsed, buildingDepreciation);
    years.push({ year, rent, noi, interest, debtService, tax, cashFlow: noi - debtService - tax, loanBalance: balance });
  }

  const salePrice = input.price * (1 + priceGrowth) ** horizonYears;
  const addedBack =
    regime === 'lmnp_reel' && CAPITAL_GAINS_RULES.lmnpDepreciationAddedBack ? buildingDepreciationTaken : 0;
  const gainsTax = capitalGainsTax(input.price, salePrice, horizonYears, addedBack);
  const remainingLoan = years.at(-1)?.loanBalance ?? 0;
  const netSaleProceeds = salePrice * (1 - projection.sellingCostShare) - remainingLoan - gainsTax;
  const equityInvested = deal.totalCost - deal.loanAmount;

  const flows = [-equityInvested, ...years.map((y) => y.cashFlow)];
  flows[flows.length - 1] += netSaleProceeds;
  const received = years.reduce((sum, y) => sum + y.cashFlow, 0) + netSaleProceeds;

  return {
    years,
    equityInvested,
    salePrice,
    capitalGainsTax: gainsTax,
    netSaleProceeds,
    irr: equityInvested > 0 ? internalRateOfReturn(flows) : null,
    equityMultiple: equityInvested > 0 ? received / equityInvested : null,
  };
};

/** D15 — return on equity re = rp + (rp − rd) × D/E: debt helps only while the property earns
 *  more (rp) than the loan costs (rd). */
export const leverageEffect = (input: DealInput, deal: DealResult) => {
  const propertyReturn = deal.totalCost > 0 ? deal.noiYearly / deal.totalCost : 0;
  const debtCost = input.loanRate + input.loanInsuranceRate;
  const equity = deal.totalCost - deal.loanAmount;
  const debtToEquity = equity > 0 ? deal.loanAmount / equity : null;
  return {
    propertyReturn,
    debtCost,
    debtToEquity,
    equityReturn: debtToEquity == null ? null : propertyReturn + (propertyReturn - debtCost) * debtToEquity,
    positive: propertyReturn > debtCost,
  };
};

/** D17 — occupancy below which collected rent no longer covers fixed costs and the loan. */
export const breakEvenOccupancy = (input: DealInput, deal: DealResult): number | null => {
  const potentialRent = 12 * input.rentMonthly;
  const variableShare = input.managementShare + input.maintenanceShare;
  const fixed =
    input.taxeFonciereYearly + input.nonRecoverableChargesYearly + input.pnoInsuranceYearly + 12 * deal.paymentMonthly;
  const net = potentialRent * (1 - variableShare);
  return net > 0 ? fixed / net : null;
};

/** D16 — BRRRR: max offer, refinance, cash left in the deal after refinancing. */
export const brrrr = (afterRepairValue: number, deal: DealResult, works: number) => {
  const maxOffer = afterRepairValue * BRRRR_RULES.maxOfferShareOfArv - works;
  const refinance = afterRepairValue * BRRRR_RULES.refinanceLtv;
  const cashLeft = deal.totalCost - refinance;
  return { maxOffer, refinance, cashLeft, cashOut: Math.max(-cashLeft, 0), allCashBack: cashLeft <= 0 };
};
