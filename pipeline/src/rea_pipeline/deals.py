"""Typical deal of a market cell: the median property of a town and segment, bought with the
default financing (docs/features/013-comparable-segments/spec.md §2.7).

The app's simulator does the same maths on the device for the user's own figures
(apps/app/src/core-kpi/typical-deal.ts, deal.ts). Precomputing the typical case here lets town
pages, the ranking and the map show a net yield and a cash-flow without computing anything.
Both sides are checked against pipeline/tests/fixtures/typical_deal_cases.json: when a rule
changes in core-kpi/rules.ts, change it here too.
"""

# core-kpi/rules.ts FR_RULES, DEFAULTS, CHARGES_RULES (values as of 2026-10)
NOTARY_RATE_OLD = 0.075
NATIONAL_MEDIAN_TFPB_RATE = 0.403
QUICK_TEST_RENT_SHARE = 0.7
DOWN_PAYMENT_SHARE = 0.1
LOAN_RATE = 0.035
LOAN_YEARS = 20
LOAN_INSURANCE_RATE = 0.003
VACANCY_MONTHS = 1
PNO_INSURANCE_YEARLY = 150
MANAGEMENT_SHARE = 0.0
MAINTENANCE_SHARE = 0.05
CHARGES_M2_MONTHLY = {"apartment": 1.5, "house": 0.5}


def loan_payment(amount: float, annual_rate: float, years: int, insurance_rate: float = 0) -> float:
    """Monthly payment of a fixed-rate loan plus borrower insurance on the initial capital."""
    if amount <= 0 or years <= 0:
        return 0.0
    months = years * 12
    monthly_rate = annual_rate / 12
    principal_and_interest = (amount / months if monthly_rate == 0
                              else amount * monthly_rate / (1 - (1 + monthly_rate) ** -months))
    return principal_and_interest + amount * insurance_rate / 12


def _ratio(numerator: float, denominator: float) -> float | None:
    return numerator / denominator if denominator > 0 else None


def typical_deal(price: float, surface_m2: float, rent_m2: float, property_type: str,
                 tfpb_rate: float | None) -> dict:
    """Same outputs as core-kpi typicalDeal (snake_case keys)."""
    rent_monthly = max(rent_m2 - CHARGES_M2_MONTHLY[property_type], 0) * surface_m2
    taxe_fonciere = rent_monthly * tfpb_rate / NATIONAL_MEDIAN_TFPB_RATE if tfpb_rate else rent_monthly
    notary = price * NOTARY_RATE_OLD
    total_cost = price + notary
    down_payment = price * (1 + NOTARY_RATE_OLD) * DOWN_PAYMENT_SHARE
    payment = loan_payment(max(total_cost - down_payment, 0), LOAN_RATE, LOAN_YEARS, LOAN_INSURANCE_RATE)
    effective_rent = rent_monthly * max(12 - VACANCY_MONTHS, 0)
    operating = (taxe_fonciere + PNO_INSURANCE_YEARLY
                 + (MANAGEMENT_SHARE + MAINTENANCE_SHARE) * effective_rent)
    noi = effective_rent - operating
    return {
        "price": price,
        "surface_m2": surface_m2,
        "rent_monthly": rent_monthly,
        "taxe_fonciere_yearly": taxe_fonciere,
        "total_cost": total_cost,
        "gross_yield": _ratio(12 * rent_monthly, total_cost),
        "net_yield": _ratio(noi, total_cost),
        "cap_rate": _ratio(noi, price),
        "payment_monthly": payment,
        "cash_flow_monthly": (noi - 12 * payment) / 12,
        "quick_test_monthly": QUICK_TEST_RENT_SHARE * rent_monthly - payment,
    }
