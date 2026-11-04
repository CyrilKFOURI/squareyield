import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { RENT_SURFACE_BOUNDS, rentAt } from './rent.ts';

const fixture = JSON.parse(
  readFileSync(new URL('../../../../pipeline/tests/fixtures/rent_at_cases.json', import.meta.url), 'utf8'),
) as { surface_bounds: [number, number]; cases: { ref_rent_m2: number; ref_surface: number; slope: number; surface_m2: number; rent_m2: number }[] };

test('same surface bounds as the pipeline', () => {
  assert.deepEqual([...RENT_SURFACE_BOUNDS], fixture.surface_bounds);
});

test('rentAt matches the pipeline rent_at on the shared cases', () => {
  for (const c of fixture.cases) {
    const got = rentAt({ ref_rent_m2: c.ref_rent_m2, ref_surface: c.ref_surface, slope: c.slope }, c.surface_m2);
    assert.ok(Math.abs(got - c.rent_m2) < 1e-6, `${c.surface_m2} m²: ${got} vs ${c.rent_m2}`);
  }
});
