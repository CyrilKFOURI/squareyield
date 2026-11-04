// Turns the dashboard's numbers into the 3 verdict badges (docs/features/012-property-dashboard/spec.md §3).
// Pure functions: the wording describes, it never advises to buy.

export type PriceVerdict = 'below' | 'consistent' | 'above' | 'unknown';
export type CashFlowVerdict = 'positive' | 'balanced' | 'negative';
export type RiskLevel = 'low' | 'medium' | 'high';
export type EnergyClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

// Loi Climat et résilience: housing with these classes can no longer be let as main residence.
export const RENTAL_BAN_YEAR: Partial<Record<EnergyClass, number>> = { G: 2025, F: 2028, E: 2034 };

/** Within ±50 €/month the deal is treated as self-financing. */
const BALANCED_CASH_FLOW = 50;

export type RiskInput = {
  highVacancy: boolean;
  populationDecline: boolean;
  dataDensity: 'sparse' | 'medium' | 'dense' | null;
  coarseLocation: boolean;
  energyClass: EnergyClass | null;
  currentYear: number;
};

export type Risk = { level: RiskLevel; reasons: string[] };

export const cashFlowVerdict = (cashFlowMonthly: number): CashFlowVerdict => {
  if (cashFlowMonthly > BALANCED_CASH_FLOW) {
    return 'positive';
  }
  return cashFlowMonthly < -BALANCED_CASH_FLOW ? 'negative' : 'balanced';
};

export const assessRisk = (input: RiskInput): Risk => {
  const severe: string[] = [];
  const moderate: string[] = [];
  const ban = input.energyClass ? RENTAL_BAN_YEAR[input.energyClass] : undefined;
  if (ban != null && input.energyClass) {
    const message = `DPE ${input.energyClass} : location interdite à partir de ${ban}, travaux à prévoir`;
    (ban <= input.currentYear + 2 ? severe : moderate).push(message);
  }
  if (input.highVacancy) {
    severe.push('Beaucoup de logements vides dans la commune');
  }
  if (input.populationDecline) {
    moderate.push('Population en baisse');
  }
  if (input.dataDensity === 'sparse') {
    moderate.push('Peu de ventes comparables : estimation moins sûre');
  }
  if (input.coarseLocation) {
    moderate.push('Adresse localisée seulement à l’échelle de la commune');
  }
  const level: RiskLevel = severe.length > 0 || moderate.length >= 3 ? 'high' : moderate.length > 0 ? 'medium' : 'low';
  return { level, reasons: [...severe, ...moderate] };
};

const PRICE_PHRASES: Record<PriceVerdict, string> = {
  below: 'Prix sous la fourchette des ventes comparables',
  consistent: 'Prix cohérent avec les ventes comparables',
  above: 'Prix au-dessus de la fourchette des ventes comparables',
  unknown: 'Pas assez de données pour juger le prix',
};

const CASH_FLOW_PHRASES: Record<CashFlowVerdict, string> = {
  positive: 'le loyer couvre crédit et charges',
  balanced: 'l’opération s’autofinance à peu près',
  negative: 'il faut compléter chaque mois',
};

const RISK_PHRASES: Record<RiskLevel, string> = {
  low: 'aucun signal de risque majeur',
  medium: 'quelques points de vigilance',
  high: 'des risques importants',
};

export const summary = (price: PriceVerdict, cashFlow: CashFlowVerdict, risk: RiskLevel): string =>
  `${PRICE_PHRASES[price]} ; ${CASH_FLOW_PHRASES[cashFlow]} ; ${RISK_PHRASES[risk]}.`;
