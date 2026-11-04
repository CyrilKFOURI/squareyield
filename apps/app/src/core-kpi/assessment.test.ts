import assert from 'node:assert/strict';
import test from 'node:test';

import { assessRisk, cashFlowVerdict, type RiskInput, summary } from './assessment.ts';

const SAFE: RiskInput = {
  highVacancy: false,
  populationDecline: false,
  dataDensity: 'dense',
  coarseLocation: false,
  energyClass: 'C',
  currentYear: 2026,
};

test('cash-flow verdict with a ±50 € balanced band', () => {
  assert.equal(cashFlowVerdict(120), 'positive');
  assert.equal(cashFlowVerdict(-30), 'balanced');
  assert.equal(cashFlowVerdict(-288), 'negative');
});

test('no signal means low risk', () => {
  assert.deepEqual(assessRisk(SAFE), { level: 'low', reasons: [] });
});

test('a G-rated home is already banned from renting: high risk', () => {
  const risk = assessRisk({ ...SAFE, energyClass: 'G' });
  assert.equal(risk.level, 'high');
  assert.match(risk.reasons[0], /2025/);
});

test('an F-rated home (ban in 2028, within 2 years) is high risk; E (2034) is medium', () => {
  assert.equal(assessRisk({ ...SAFE, energyClass: 'F' }).level, 'high');
  assert.equal(assessRisk({ ...SAFE, energyClass: 'E' }).level, 'medium');
});

test('high vacancy alone is high risk; three moderate signals too', () => {
  assert.equal(assessRisk({ ...SAFE, highVacancy: true }).level, 'high');
  assert.equal(assessRisk({ ...SAFE, populationDecline: true }).level, 'medium');
  assert.equal(
    assessRisk({ ...SAFE, populationDecline: true, dataDensity: 'sparse', coarseLocation: true }).level,
    'high',
  );
});

test('summary is descriptive', () => {
  assert.equal(
    summary('consistent', 'negative', 'medium'),
    'Prix cohérent avec les ventes comparables ; il faut compléter chaque mois ; quelques points de vigilance.',
  );
});
