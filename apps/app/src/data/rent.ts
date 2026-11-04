// ANIL rent at a property's own surface, from the commune's published curve (place.rent_curve).
// Twin of the pipeline's rents.rent_at; both are tested on pipeline/tests/fixtures/rent_at_cases.json.

export type RentCurve = { ref_rent_m2: number; ref_surface: number; slope: number };

/** Outside this range ANIL has too few listings: the surface is clamped. */
export const RENT_SURFACE_BOUNDS = [25, 110] as const;

export const rentAt = (curve: RentCurve, surfaceM2: number): number => {
  const surface = Math.min(Math.max(surfaceM2, RENT_SURFACE_BOUNDS[0]), RENT_SURFACE_BOUNDS[1]);
  return curve.ref_rent_m2 * (surface / curve.ref_surface) ** curve.slope;
};
