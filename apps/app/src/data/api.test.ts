import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPlace } from './api.ts';

const respond = (body: string, status: number, type: string) => async () =>
  new Response(body, { status, headers: { 'content-type': type } });

test('a missing file served as the app page (dev server, static host) reads as a 404', async () => {
  globalThis.fetch = respond('<!doctype html><html></html>', 200, 'text/html') as typeof fetch;
  await assert.rejects(loadPlace('departement', '976'), /HTTP 404/);
});

test('a real 404 stays a 404', async () => {
  globalThis.fetch = respond('not found', 404, 'text/plain') as typeof fetch;
  await assert.rejects(loadPlace('departement', '976'), /HTTP 404/);
});
