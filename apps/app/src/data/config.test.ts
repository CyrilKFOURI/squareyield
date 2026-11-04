import assert from 'node:assert/strict';
import test from 'node:test';

import { siteUrl } from './config.ts';

test('web: unset site keeps paths relative', () => {
  assert.equal(siteUrl('', 'data'), '/data');
  assert.equal(siteUrl(undefined, 'vendor/w.js'), '/vendor/w.js');
});

test('native: the published site makes them absolute, with or without a trailing slash', () => {
  assert.equal(siteUrl('https://me.github.io/cyfouri', 'data'), 'https://me.github.io/cyfouri/data');
  assert.equal(siteUrl('https://me.github.io/cyfouri/', 'data'), 'https://me.github.io/cyfouri/data');
});
