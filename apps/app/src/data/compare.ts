// Comparer: which column holds the best value of a row, given the indicator's direction.

/** Index of the best value; null when there is no direction, fewer than two values, or a tie. */
export const bestIndex = (values: (number | null | undefined)[], higherIsBetter: boolean | null): number | null => {
  if (higherIsBetter == null) {
    return null;
  }
  const known = values.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => typeof x.v === 'number' && Number.isFinite(x.v));
  if (known.length < 2) {
    return null;
  }
  const sorted = [...known].sort((a, b) => (higherIsBetter ? b.v - a.v : a.v - b.v));
  return sorted[0].v === sorted[1].v ? null : sorted[0].i;
};
