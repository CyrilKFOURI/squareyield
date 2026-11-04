import assert from 'node:assert/strict';
import test from 'node:test';

import { cached } from './cache.ts';

test('a successful load is fetched once', async () => {
  let calls = 0;
  const load = cached(async (key: string) => {
    calls += 1;
    return key.length;
  });
  assert.equal(await load('abc'), 3);
  assert.equal(await load('abc'), 3);
  assert.equal(calls, 1);
});

test('a failed load is forgotten so a retry fetches again', async () => {
  let calls = 0;
  const load = cached(async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error('HTTP 503');
    }
    return 'ok';
  });
  await assert.rejects(load('x'), /503/);
  assert.equal(await load('x'), 'ok');
  assert.equal(calls, 2);
});
