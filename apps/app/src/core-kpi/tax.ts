// First-year income tax on rents for the four long-term rental regimes (KPI_SPEC D13).
// Simplifications, stated in the UI: same rent furnished or not, first year only, the
// déficit foncier is reported but not offset against the user's other income.
import { type DealInput, type DealResult, loanPayment } from './deal.ts';
import { TAX_RULES } from './rules.ts';

export type TaxRegime = 'micro_foncier' | 'reel_foncier' | 'lmnp_micro' | 'lmnp_reel';

export type TaxResult = {
  regime: TaxRegime;
  eligible: boolean;
  taxableIncome: number;
  incomeTax: number;
  socialCharges: number;
  totalTax: number;
  cashFlowAfterTaxMonthly: number;
  /** D4: (NOI − tax) / total cost. */
  netNetYield: number | null;
  /** réel foncier only: deficit carried (offsettable up to deficitFoncierCap on other income). */
  deficit: number;
  /** lmnp réel only: depreciation not usable this year, carried forward. */
  carriedDepreciation: number;
};

/** Interest paid during the first 12 months of an annuity loan (insurance excluded). */
export const firstYearInterest = (amount: number, annualRate: number, years: number): number => {
  if (amount <= 0 || years <= 0 || annualRate === 0) {
    return 0;
  }
  const monthlyRate = annualRate / 12;
  const payment = loanPayment(amount, annualRate, years);
  let balance = amount;
  let interest = 0;
  for (let month = 0; month < Math.min(12, years * 12); month += 1) {
    const monthInterest = balance * monthlyRate;
    interest += monthInterest;
    balance -= payment - monthInterest;
  }
  return interest;
};

const result = (
  regime: TaxRegime,
  eligible: boolean,
  taxableIncome: number,
  marginalRate: number,
  deal: DealResult,
  extra: Partial<Pick<TaxResult, 'deficit' | 'carriedDepreciation'>> = {},
): TaxResult => {
  const base = Math.max(taxableIncome, 0);
  const incomeTax = base * marginalRate;
  const socialCharges = base * TAX_RULES.socialRate;
  const totalTax = incomeTax + socialCharges;
  return {
    regime,
    eligible,
    taxableIncome,
    incomeTax,
    socialCharges,
    totalTax,
    cashFlowAfterTaxMonthly: deal.cashFlowMonthly - totalTax / 12,
    netNetYield: deal.totalCost > 0 ? (deal.noiYearly - totalTax) / deal.totalCost : null,
    deficit: extra.deficit ?? 0,
    carriedDepreciation: extra.carriedDepreciation ?? 0,
  };
};

export const compareTaxRegimes = (input: DealInput, deal: DealResult, marginalRate: number): TaxResult[] => {
  const rents = deal.effectiveRentYearly;
  const interest = firstYearInterest(deal.loanAmount, input.loanRate, input.loanYears);
  const borrowerInsurance = deal.loanAmount * input.loanInsuranceRate;
  // operating costs already include taxe foncière, condo charges, PNO, management and maintenance
  const deductible = deal.operatingCostsYearly + interest + borrowerInsurance;

  // réel foncier: only the part of the deficit not caused by interest offsets other income
  const reelFoncier = rents - deductible;
  const deficit = Math.max(-reelFoncier, 0);

  // LMNP réel: depreciation may only bring the result down to zero; the rest is carried forward
  const depreciation =
    (input.price * (1 - TAX_RULES.landShare)) / TAX_RULES.buildingYears +
    input.furniture / TAX_RULES.furnitureYears +
    input.works / TAX_RULES.worksYears;
  const beforeDepreciation = rents - deductible;
  const usedDepreciation = Math.min(depreciation, Math.max(beforeDepreciation, 0));

  return [
    result('micro_foncier', rents <= TAX_RULES.microFoncierCeiling,
      rents * (1 - TAX_RULES.microFoncierAllowance), marginalRate, deal),
    result('reel_foncier', true, reelFoncier, marginalRate, deal, { deficit }),
    result('lmnp_micro', rents <= TAX_RULES.microBicCeiling,
      rents * (1 - TAX_RULES.microBicAllowance), marginalRate, deal),
    result('lmnp_reel', true, beforeDepreciation - usedDepreciation, marginalRate, deal, {
      carriedDepreciation: depreciation - usedDepreciation,
    }),
  ];
};
