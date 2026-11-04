// Typical deal of a market cell (median property, default financing): the same numbers are
// precomputed by the pipeline (pipeline/src/rea_pipeline/deals.py) for every town page, and
// checked against each other through pipeline/tests/fixtures/typical_deal_cases.json.
import { analyzeDeal } from './deal.ts';
import { estimateTaxeFonciere } from './estimates.ts';
import { CHARGES_RULES, DEFAULTS, FR_RULES } from './rules.ts';

export type TypicalDealInput = {
  price: number;
  surfaceM2: number;
  /** ANIL asking rent, charges included. */
  rentM2: number;
  propertyType: 'apartment' | 'house';
  tfpbRate: number | null;
};

export type TypicalDeal = {
  price: number;
  surface_m2: number;
  rent_monthly: number;
  taxe_fonciere_yearly: number;
  total_cost: number;
  gross_yield: number | null;
  net_yield: number | null;
  cap_rate: number | null;
  payment_monthly: number;
  cash_flow_monthly: number;
  quick_test_monthly: number;
};

export const chargesProvisionM2 = (propertyType: 'apartment' | 'house'): number =>
  propertyType === 'house' ? CHARGES_RULES.houseM2Monthly : CHARGES_RULES.apartmentM2Monthly;

export const typicalDeal = (input: TypicalDealInput): TypicalDeal => {
  const rentMonthly = Math.max(input.rentM2 - chargesProvisionM2(input.propertyType), 0) * input.surfaceM2;
  const taxeFonciereYearly = estimateTaxeFonciere(rentMonthly, input.tfpbRate);
  const result = analyzeDeal({
    price: input.price,
    surfaceM2: input.surfaceM2,
    isNewBuild: false,
    agencyFees: 0,
    works: 0,
    furniture: 0,
    rentMonthly,
    vacancyMonths: DEFAULTS.vacancyMonths,
    taxeFonciereYearly,
    nonRecoverableChargesYearly: 0,
    pnoInsuranceYearly: DEFAULTS.pnoInsuranceYearly,
    managementShare: DEFAULTS.managementShare,
    maintenanceShare: DEFAULTS.maintenanceShare,
    downPayment: input.price * (1 + FR_RULES.notaryRateOld) * DEFAULTS.downPaymentShare,
    loanRate: DEFAULTS.loanRate,
    loanYears: DEFAULTS.loanYears,
    loanInsuranceRate: DEFAULTS.loanInsuranceRate,
    incomeMonthly: 0,
    existingDebtMonthly: 0,
  });
  return {
    price: input.price,
    surface_m2: input.surfaceM2,
    rent_monthly: rentMonthly,
    taxe_fonciere_yearly: taxeFonciereYearly,
    total_cost: result.totalCost,
    gross_yield: result.grossYield,
    net_yield: result.netYield,
    cap_rate: result.capRate,
    payment_monthly: result.paymentMonthly,
    cash_flow_monthly: result.cashFlowMonthly,
    quick_test_monthly: result.quickTestMonthly,
  };
};
