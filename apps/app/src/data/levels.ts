// Level pages (France → département → commune): sorted bar charts, year-by-year matrices and the derived market
// KPIs of docs/features/017-guided-levels/spec.md. Selection and ratios over published aggregates only.

export type BarSort = 'code' | 'desc' | 'asc';

/** Official order of département / commune codes: Corse (2A, 2B) sits between 19 and 21, overseas (97x) last. */
const splitCode = (code: string): [number, string] => {
  const dep = code.length <= 3 ? code : code.slice(0, code.startsWith('97') ? 3 : 2);
  const key = dep === '2A' ? 20.1 : dep === '2B' ? 20.2 : Number.parseInt(dep, 10);
  return [Number.isNaN(key) ? Number.POSITIVE_INFINITY : key, code.slice(dep.length)];
};
export const codeCompare = (a: string, b: string): number => {
  const [depA, restA] = splitCode(a);
  const [depB, restB] = splitCode(b);
  return depA !== depB ? depA - depB : restA.localeCompare(restB, 'fr', { numeric: true });
};

/** Rows with a value, in code order or by value, optionally cut to the first `top`. */
export const rankBars = <T>(
  rows: T[],
  value: (row: T) => number | null | undefined,
  code: (row: T) => string,
  sort: BarSort,
  top: number | null,
): T[] => {
  const known = rows.filter((r) => {
    const v = value(r);
    return typeof v === 'number' && Number.isFinite(v);
  });
  const sorted = [...known].sort((a, b) =>
    sort === 'code' ? codeCompare(code(a), code(b)) : sort === 'desc' ? (value(b) as number) - (value(a) as number) : (value(a) as number) - (value(b) as number),
  );
  return top == null ? sorted : sorted.slice(0, top);
};

/** Years covered by both half-years: the edge years of a DVF release only have one half. */
export const completeYears = (halfPeriods: string[]): string[] => {
  const halves = new Set(halfPeriods);
  const years = [...new Set(halfPeriods.map((p) => p.slice(0, 4)))].sort();
  return years.filter((y) => halves.has(`${y}-H1`) && halves.has(`${y}-H2`));
};

export type YearRow = { code: string; medians: (number | null)[]; changes: (number | null)[] };

/** One row per place: median of each year in `years` and its change on the year before (null when either is missing). */
export const yearMatrix = (rows: { code: string; period: string; median: number }[], years: string[]): YearRow[] => {
  const byCode = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!byCode.has(r.code)) {
      byCode.set(r.code, new Map());
    }
    byCode.get(r.code)?.set(r.period, r.median);
  }
  return [...byCode.keys()].sort(codeCompare).map((code) => {
    const medians = years.map((y) => byCode.get(code)?.get(y) ?? null);
    const changes = medians.map((m, i) => {
      const before = i > 0 ? medians[i - 1] : null;
      return m != null && before ? m / before - 1 : null;
    });
    return { code, medians, changes };
  });
};

/** Change from the first to the last known value. */
export const growth = (values: (number | null)[]): number | null => {
  const known = values.filter((v): v is number => v != null);
  return known.length >= 2 && known[0] > 0 ? known[known.length - 1] / known[0] - 1 : null;
};

/** Price index against a reference (France = 100). */
export const indexTo = (value: number | null | undefined, reference: number | null | undefined): number | null =>
  value != null && reference ? Math.round((value / reference) * 100) : null;

/** Square metres one year of median living standard buys. */
export const m2PerIncome = (livingStandard: number | null | undefined, priceM2: number | null | undefined): number | null =>
  livingStandard != null && priceM2 ? livingStandard / priceM2 : null;

/** 1-based position of a place among the rows with a value; 'desc' = highest first. */
export const rankOf = <T>(
  rows: T[],
  target: string,
  code: (row: T) => string,
  value: (row: T) => number | null | undefined,
  dir: 'asc' | 'desc',
): number | null => {
  const sorted = rankBars(rows, value, code, dir, null);
  const index = sorted.findIndex((r) => code(r) === target);
  return index < 0 ? null : index + 1;
};
