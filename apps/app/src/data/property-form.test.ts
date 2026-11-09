import assert from 'node:assert/strict';
import test from 'node:test';

import { missingForAnalysis, parseAmount } from './property-form.ts';

test('amounts accept French spacing and a decimal comma', () => {
  assert.equal(parseAmount('150 000'), 150000);
  assert.equal(parseAmount('45,5'), 45.5);
  assert.equal(parseAmount(' 1 200'), 1200);
  assert.equal(parseAmount(''), 0);
  assert.equal(parseAmount('abc'), 0);
});

test('a complete form can be analysed', () => {
  assert.deepEqual(missingForAnalysis({ address: '12 rue Lenepveu, Angers', hasCommune: false, surface: '45', price: '150000' }), []);
  assert.deepEqual(missingForAnalysis({ address: '', hasCommune: true, surface: '45', price: '150000' }), []);
});

test('lists what is missing, in form order', () => {
  assert.deepEqual(missingForAnalysis({ address: '  ', hasCommune: false, surface: '0', price: '' }), [
    'une adresse ou une commune',
    'le prix',
    'la surface',
  ]);
  assert.deepEqual(missingForAnalysis({ address: 'x', hasCommune: false, surface: '-3', price: '1' }), ['la surface']);
});
