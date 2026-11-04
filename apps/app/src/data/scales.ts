// Map colour scales (docs/features/014-web-dashboard/spec.md §5.3): five quintile classes from the breaks
// the pipeline publishes. Palettes are ordered from the good end to the bad end, so "good" is always
// green (RdYlGn) or bright (viridis, colour-blind safe) whatever the metric's direction.

export type Palette = 'rdylgn' | 'viridis';

export const GREY = '#c9c5bc';

export const PALETTES = {
  rdylgn: ['#1a9641', '#a6d96a', '#ffffbf', '#fdae61', '#d7191c'],
  viridis: ['#fde725', '#5ec962', '#21918c', '#3b528b', '#440154'],
  /** Metrics with no good or bad end (e.g. price trend): light to dark. */
  sequential: ['#f1eef6', '#bdc9e1', '#74a9cf', '#2b8cbe', '#045a8d'],
} as const;

/** Class 0–4 of a value: 0 = lowest fifth. */
export const classOf = (value: number, breaks: number[]): number => {
  const index = breaks.findIndex((b) => value <= b);
  return index === -1 ? breaks.length : index;
};

const colorsFor = (palette: Palette, higherIsBetter: boolean | null): readonly string[] => {
  if (higherIsBetter == null) {
    return PALETTES.sequential;
  }
  // palettes run good → bad; classes run low → high
  return higherIsBetter ? [...PALETTES[palette]].reverse() : PALETTES[palette];
};

export const colorFor = (
  value: unknown,
  breaks: number[],
  palette: Palette,
  higherIsBetter: boolean | null,
): string =>
  typeof value === 'number' && Number.isFinite(value) && breaks.length === 4
    ? colorsFor(palette, higherIsBetter)[classOf(value, breaks)]
    : GREY;

export const legendItems = (
  breaks: number[],
  format: (value: number) => string,
  palette: Palette,
  higherIsBetter: boolean | null,
): { label: string; color: string }[] => {
  if (breaks.length !== 4) {
    return [];
  }
  const colors = colorsFor(palette, higherIsBetter);
  return colors.map((color, i) => ({
    color,
    label:
      i === 0
        ? `≤ ${format(breaks[0])}`
        : i === 4
          ? `> ${format(breaks[3])}`
          : `${format(breaks[i - 1])} – ${format(breaks[i])}`,
  }));
};
