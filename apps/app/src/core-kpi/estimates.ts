// Default values derived from public data when the user does not know the real amount.
import { FR_RULES } from './rules.ts';

export type Effect = { group: string; log_effect: number; effect_pct: number };

/**
 * Taxe foncière ≈ one month of rent at the national median rate (rule of thumb), scaled by the
 * commune's own built-property tax rate (REI): Angers (56.7 %) pays ~1.4 months, Paris (21 %) ~0.5.
 * Without a rate, the plain rule of thumb.
 */
export const estimateTaxeFonciere = (rentMonthly: number, tfpbRate?: number | null): number =>
  tfpbRate ? (rentMonthly * tfpbRate) / FR_RULES.nationalMedianTfpbRate : rentMonthly;

/**
 * For a flat, "no land" is part of being a flat: merge the land effect into the type effect so the
 * explanation does not read "land −6 %" for an apartment. Multiplicative effects combine as products.
 */
export const mergeApartmentLand = (effects: Effect[], propertyType: 'apartment' | 'house'): Effect[] => {
  if (propertyType !== 'apartment') {
    return effects;
  }
  const land = effects.find((e) => e.group === 'land');
  const type = effects.find((e) => e.group === 'type');
  if (!land) {
    return effects;
  }
  const log = land.log_effect + (type?.log_effect ?? 0);
  const merged: Effect = { group: 'apartment_no_land', log_effect: log, effect_pct: Math.exp(log) - 1 };
  return [...effects.filter((e) => e.group !== 'land' && e.group !== 'type'), merged].sort(
    (a, b) => Math.abs(b.log_effect) - Math.abs(a.log_effect),
  );
};
