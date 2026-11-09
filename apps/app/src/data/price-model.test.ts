import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildFeatures,
  contributions,
  departementOf,
  type DepartementFile,
  estimateProperty,
  featureVector,
  type ModelFile,
  nearestSection,
  predict,
  type PropertyInput,
  readBanAnswer,
  type Tree,
} from './price-model.ts';

// Written by python (ml/tests/test_web_export.py): a LightGBM model with NaN, zero and categorical splits,
// and the synthetic packaged model with python's features, predictions, SHAP values and estimates.
type Fixture = {
  walker: { trees: Tree[]; x: (number | null)[][]; predictions: number[]; contributions: number[][] };
  model: ModelFile;
  departements: Record<string, DepartementFile>;
  golden: {
    properties: PropertyInput[];
    feature_names: string[];
    all_features: (number | null)[][];
    features: (number | null)[][];
    predictions: number[];
    contributions: number[][];
    estimates: Record<string, unknown>[];
  };
};
const fixture = JSON.parse(readFileSync(new URL('./price-model.fixture.json', import.meta.url), 'utf8')) as Fixture;
const nan = (row: (number | null)[]): number[] => row.map((v) => (v === null ? NaN : v));
const close = (actual: number, expected: number, what: string, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} vs ${expected}`);
const sameFeature = (actual: number, expected: number | null, what: string) =>
  expected === null ? assert.ok(Number.isNaN(actual), `${what} should be missing, got ${actual}`) : close(actual, expected, what, 1e-9);

test('tree walker reproduces LightGBM predictions (NaN, zero-as-missing and categorical splits)', () => {
  const { trees, x, predictions } = fixture.walker;
  assert.ok(trees.some((t) => t.cats.length > 0));
  x.forEach((row, i) => close(predict(trees, nan(row)), predictions[i], `row ${i}`));
});

test('TreeSHAP reproduces LightGBM pred_contrib', () => {
  const { trees, x, contributions: expected } = fixture.walker;
  x.forEach((row, i) => contributions(trees, nan(row)).forEach((v, j) => close(v, expected[i][j], `row ${i} feature ${j}`)));
});

const depOf = (p: PropertyInput) => fixture.departements[departementOf(p.code_commune)];

test('features match python features.py, missing rooms and coarse location included', () => {
  const { properties, feature_names, all_features } = fixture.golden;
  assert.ok(properties.some((p) => p.rooms === null) && properties.some((p) => p.section === null));
  properties.forEach((p, i) => {
    const { values } = buildFeatures(fixture.model, depOf(p), p);
    feature_names.forEach((name, j) => sameFeature(values[name], all_features[i][j], `property ${i} ${name}`));
  });
});

test('model predictions and estimates match python on the packaged test model', () => {
  const { properties, predictions, estimates, contributions: expected } = fixture.golden;
  properties.forEach((p, i) => {
    const x = featureVector(fixture.model, buildFeatures(fixture.model, depOf(p), p));
    close(predict(fixture.model.trees, x), predictions[i], `prediction ${i}`);
    contributions(fixture.model.trees, x).forEach((v, j) => close(v, expected[i][j], `shap ${i}/${j}`));
    const ours = estimateProperty(fixture.model, depOf(p), p);
    const theirs = estimates[i] as unknown as typeof ours;
    close(ours.price, theirs.price, `price ${i}`, 1e-6 * theirs.price);
    close(ours.price_low, theirs.price_low, `low ${i}`, 1e-6 * theirs.price);
    assert.equal(ours.data_density, theirs.data_density);
    assert.equal(ours.location_precision, theirs.location_precision);
    close(ours.explanation.base_price_m2, theirs.explanation.base_price_m2, `base ${i}`);
    assert.deepEqual(ours.explanation.effects.map((e) => e.group), theirs.explanation.effects.map((e) => e.group));
  });
});

test('asked price gives a verdict; nearest section of the commune; département codes', () => {
  const p = { ...fixture.golden.properties[0], asked_price: 1 };
  assert.equal(estimateProperty(fixture.model, depOf(p), p).verdict, 'below');
  assert.equal(nearestSection(fixture.departements['49'], '49007', 4.009, 47.009), '49007000CD');
  assert.equal(nearestSection(fixture.departements['49'], '49099', 4.0, 47.0), null);
  assert.deepEqual([departementOf('97102'), departementOf('2A004'), departementOf('75101')], ['971', '2A', '75']);
});

test('BAN answer: point and INSEE code, low score refused', () => {
  const answer = (score: number) => ({
    features: [{ geometry: { coordinates: [-0.55, 47.47] as [number, number] }, properties: { label: '12 Rue Lenepveu 49100 Angers', citycode: '49007', score } }],
  });
  assert.deepEqual(readBanAnswer('x', answer(0.9)), { label: '12 Rue Lenepveu 49100 Angers', code_commune: '49007', longitude: -0.55, latitude: 47.47 });
  assert.throws(() => readBanAnswer('nowhere', answer(0.2)), /Adresse introuvable/);
  assert.throws(() => readBanAnswer('nowhere', { features: [] }), /Adresse introuvable/);
});
