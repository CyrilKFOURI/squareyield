import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { typicalDeal } from './typical-deal.ts';

// Shared with the pipeline (pipeline/tests/test_deals.py): both sides must give the same numbers.
const fixture = JSON.parse(
  readFileSync(new URL('../../../../pipeline/tests/fixtures/typical_deal_cases.json', import.meta.url), 'utf8'),
);

for (const { name, input, expected } of fixture.cases) {
  test(`typical deal matches the shared fixture: ${name}`, () => {
    assert.ok(expected, 'fixture has expected values');
    const result = typicalDeal({
      price: input.price,
      surfaceM2: input.surface_m2,
      rentM2: input.rent_m2,
      propertyType: input.property_type,
      tfpbRate: input.tfpb_rate,
    });
    for (const [key, value] of Object.entries(expected as Record<string, number>)) {
      assert.ok(Math.abs((result as Record<string, number>)[key] - value) < 0.01, `${key}: ${(result as Record<string, number>)[key]} vs ${value}`);
    }
  });
}

test('rent excludes the charges provision of the type', () => {
  const flat = typicalDeal({ price: 100000, surfaceM2: 40, rentM2: 12, propertyType: 'apartment', tfpbRate: null });
  assert.equal(flat.rent_monthly, (12 - 1.5) * 40);
});
