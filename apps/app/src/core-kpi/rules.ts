// French rules and market defaults used by the simulator. Check once a year (KPI_SPEC §2):
// they change with finance laws and HCSF decisions. Values as of 2026-10.
export const FR_RULES = {
  checkedOn: '2026-10-20',
  /** Notary fees ("frais de notaire") as a share of the price. */
  notaryRateOld: 0.075,
  notaryRateNew: 0.025,
  /** HCSF: debt service / income must stay ≤ 35 %, loans ≤ 25 years. */
  hcsfMaxDebtRatio: 0.35,
  hcsfMaxYears: 25,
  /** Banks count only 70 % of future rent as income (vacancy, charges). */
  rentCountedByBanks: 0.7,
  /** Delagrandanne's quick test: 70 % of the rent must cover the loan payment. */
  quickTestRentShare: 0.7,
  /** Median global built-property tax rate of French communes (REI 2025), for the taxe foncière estimate. */
  nationalMedianTfpbRate: 0.403,
} as const;

/** Income tax on rents, long-term rental (KPI_SPEC D13). Check each finance law. */
export const TAX_RULES = {
  /** Prélèvements sociaux on property income. To verify each year (LFSS changes). */
  socialRate: 0.172,
  marginalRates: [0, 0.11, 0.3, 0.41, 0.45],
  microFoncierAllowance: 0.3,
  microFoncierCeiling: 15_000,
  /** Long-term furnished rental (non-tourist). */
  microBicAllowance: 0.5,
  microBicCeiling: 77_700,
  /** Real regime, unfurnished: a deficit (excluding interest) offsets other income up to this amount. */
  deficitFoncierCap: 10_700,
  /** LMNP réel: land is not depreciable; building, furniture and works over these durations. */
  landShare: 0.15,
  buildingYears: 30,
  furnitureYears: 7,
  worksYears: 15,
} as const;

/** Capital gains tax on resale of a rental property (not a main residence). Check each finance law. */
export const CAPITAL_GAINS_RULES = {
  incomeTaxRate: 0.19,
  socialRate: 0.172,
  /** Flat allowances added to the purchase price when the real amounts are not documented. */
  acquisitionFeesFlat: 0.075,
  worksFlatAfter5Years: 0.15,
  // Holding-period allowances: income tax exempt after 22 years, social charges after 30.
  incomeTaxAllowance: { from: 6, perYear: 0.06, year22: 0.04 },
  socialAllowance: { from: 6, perYear: 0.0165, year22: 0.016, after22PerYear: 0.09 },
  /** Since the 2025 finance law, LMNP depreciation (except furniture) is added back to the gain. */
  lmnpDepreciationAddedBack: true,
} as const;

/** BRRRR rules of thumb (Greene): offer ≤ 70 % of after-repair value minus works, refinance at 75 %. */
export const BRRRR_RULES = { maxOfferShareOfArv: 0.7, refinanceLtv: 0.75 } as const;

/**
 * Recoverable charges the tenant pays on top of the rent, €/m²/month (KPI_SPEC D18). ANIL asking rents
 * include them; the simulator works on the rent excluding charges. Order of magnitude between the
 * social-housing observatory (USH 2020: ~0.8 €/m²/month without heating) and private flats with
 * collective heating (2.5–4 €/m²/month); houses mostly pay water and waste tax. Editable estimate.
 */
export const CHARGES_RULES = {
  apartmentM2Monthly: 1.5,
  houseM2Monthly: 0.5,
  checkedOn: '2026-10-21',
} as const;

/** Prefill values, all editable in the simulator. */
export const DEFAULTS = {
  downPaymentShare: 0.1,
  loanRate: 0.035,
  loanYears: 20,
  loanInsuranceRate: 0.003,
  vacancyMonths: 1,
  pnoInsuranceYearly: 150,
  managementShare: 0,
  maintenanceShare: 0.05,
} as const;
