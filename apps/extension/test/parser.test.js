// Run with `cd apps/extension && node --test "test/*.test.js"` (no dependency).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// browser globals the parser relies on
const context = { URLSearchParams };
vm.createContext(context);
vm.runInContext(readFileSync(new URL('../parser.js', import.meta.url), 'utf8'), context);
const { parseListing, dashboardUrl } = context.reaListing;

test('JSON-LD wins and gives every field', () => {
  const listing = parseListing({
    jsonLd: [JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Apartment',
      name: 'Appartement 2 pièces 45 m²',
      floorSize: { '@type': 'QuantitativeValue', value: 45, unitCode: 'MTK' },
      numberOfRooms: 2,
      address: { '@type': 'PostalAddress', postalCode: '49100', addressLocality: 'Angers' },
      offers: { '@type': 'Offer', price: '150000', priceCurrency: 'EUR' },
    })],
    title: 'Vente appartement 3 pièces 60 m² Paris',
    text: '',
  });
  assert.deepEqual(
    { ...listing, sources: undefined },
    { price: 150000, surface: 45, rooms: 2, type: 'apartment', postcode: '49100', town: 'Angers', sources: undefined },
  );
  assert.equal(listing.sources.price, 'json-ld');
});

test('text patterns with French number formats', () => {
  const listing = parseListing({
    jsonLd: [],
    title: 'Maison à vendre',
    text: 'Maison 5 pièces de 112,5 m² avec jardin\n249 900 €\n49130 Les Ponts-de-Cé\nContactez Jean au 06 12 34 56 78',
  });
  assert.equal(listing.type, 'house');
  assert.equal(listing.surface, 112.5);
  assert.equal(listing.rooms, 5);
  assert.equal(listing.price, 249900);
  assert.equal(listing.postcode, '49130');
  assert.equal(listing.town, 'Les Ponts-de-Cé');
});

test('nothing is invented when the page has no data', () => {
  const listing = parseListing({ jsonLd: ['not json'], title: 'Accueil', text: 'Bienvenue' });
  assert.equal(listing.price, null);
  assert.equal(listing.surface, null);
});

test('the dashboard URL carries only property facts', () => {
  const url = dashboardUrl('http://localhost:8081', {
    price: 150000, surface: 45, rooms: 2, type: 'apartment', postcode: '49100', town: 'Angers',
  });
  assert.equal(url, 'http://localhost:8081/property?address=49100+Angers&type=apartment&surface=45&rooms=2&price=150000');
});

test('manifest asks for no host permission', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'scripting']);
  assert.equal(manifest.host_permissions, undefined);
});
