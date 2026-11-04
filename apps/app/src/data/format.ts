const euros = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export const formatEuros = (value: number | null | undefined): string =>
  value == null ? '—' : `${euros.format(value)} €`;

export const formatEurosPerM2 = (value: number | null | undefined): string =>
  value == null ? '—' : `${euros.format(value)} €/m²`;

export const formatRentPerM2 = (value: number | null | undefined): string =>
  value == null ? '—' : `${decimal.format(value)} €/m²`;

export const formatPercent = (value: number | null | undefined): string =>
  value == null ? '—' : `${decimal.format(value * 100)} %`;

export const formatSignedPercent = (value: number | null | undefined): string => {
  if (value == null) {
    return '—';
  }
  const sign = value > 0 ? '+' : '';
  return `${sign}${decimal.format(value * 100)} %`;
};

export const formatDecimal = (value: number | null | undefined): string =>
  value == null ? '—' : decimal.format(value);

/** A difference between two rates, in percentage points: 0.039 -> "+3,9 pts". */
export const formatPoints = (value: number | null | undefined): string => {
  if (value == null) {
    return '—';
  }
  const sign = value > 0 ? '+' : '';
  return `${sign}${decimal.format(value * 100)} pts`;
};

export const formatCount = (value: number | null | undefined): string =>
  value == null ? '—' : euros.format(value);

// "2026-H1" -> "S1 2026"
export const formatPeriod = (period: string): string => {
  const [year, half] = period.split('-H');
  return half ? `S${half} ${year}` : year;
};
