// Listing parser (docs/features/008-browser-extension/spec.md).
// Classic script (no modules) so it can be injected with chrome.scripting.executeScript; it
// publishes two functions on globalThis. Only property facts are read: never names, phones, photos.
(() => {
  /** Collects raw text from the current page. The only part that touches the DOM. */
  const collectPage = (doc) => ({
    jsonLd: [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent || ''),
    title: doc.title || '',
    ogTitle: doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || '',
    // visible text only, capped: enough for the price/surface/rooms lines
    text: (doc.body?.innerText || '').slice(0, 20000),
    url: doc.location?.href || '',
  });

  const toNumber = (text) => {
    if (text == null) return null;
    const value = Number(String(text).replace(/[\s  ]/g, '').replace(',', '.'));
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  const flatten = (node) => {
    if (Array.isArray(node)) return node.flatMap(flatten);
    if (node && typeof node === 'object') {
      return [node, ...(node['@graph'] ? flatten(node['@graph']) : [])];
    }
    return [];
  };

  const typeFrom = (text) => {
    const lower = (text || '').toLowerCase();
    if (/\b(appartement|studio|duplex|loft|t\d\b|f\d\b)/.test(lower)) return 'apartment';
    if (/\b(maison|villa|pavillon|longère|ferme|chalet)\b/.test(lower)) return 'house';
    return null;
  };

  const fromJsonLd = (blocks) => {
    const found = {};
    for (const block of blocks) {
      let data;
      try {
        data = JSON.parse(block);
      } catch {
        continue;
      }
      for (const node of flatten(data)) {
        const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        const price = toNumber(offer?.price ?? node.price);
        if (price && !found.price) found.price = price;
        const floor = node.floorSize?.value ?? node.floorSize;
        const surface = toNumber(typeof floor === 'object' ? null : floor);
        if (surface && !found.surface) found.surface = surface;
        const rooms = toNumber(node.numberOfRooms?.value ?? node.numberOfRooms);
        if (rooms && !found.rooms) found.rooms = rooms;
        const address = node.address ?? node.itemOffered?.address;
        if (address && typeof address === 'object' && !found.postcode) {
          found.postcode = address.postalCode || null;
          found.town = address.addressLocality || null;
        }
        const type = typeFrom(`${node['@type'] || ''} ${node.name || ''}`);
        if (type && !found.type) found.type = type;
      }
    }
    return found;
  };

  const PATTERNS = {
    // "m²" ends with a non-word character, so \b cannot follow it: refuse a trailing letter instead
    surface: /(\d{1,4}(?:[.,]\d{1,2})?)\s?m(?:²|2)(?![a-z])/i,
    rooms: /(\d{1,2})\s?pi[eè]ces?\b/i,
    price: /(\d{1,3}(?:[\s  .]\d{3})+|\d{4,9})\s?€/,
    place: /\b((?:0[1-9]|[1-8]\d|9[0-5]|2[AB]|97[1-6])\d{3})\s+([A-ZÀ-Ÿ][\wÀ-ÿ' -]{1,40})/,
  };

  const fromText = (text) => {
    const found = {};
    const surface = text.match(PATTERNS.surface);
    if (surface) found.surface = toNumber(surface[1]);
    const rooms = text.match(PATTERNS.rooms);
    if (rooms) found.rooms = toNumber(rooms[1]);
    const price = text.match(PATTERNS.price);
    if (price) found.price = toNumber(price[1].replace(/\./g, ''));
    const place = text.match(PATTERNS.place);
    if (place) {
      found.postcode = place[1];
      found.town = place[2].trim().replace(/\s+\d.*$/, '');
    }
    const type = typeFrom(text);
    if (type) found.type = type;
    return found;
  };

  /** Merges sources by reliability: JSON-LD, then the title, then the page text. */
  const parseListing = (page) => {
    const sources = [
      ['json-ld', fromJsonLd(page.jsonLd || [])],
      ['title', fromText(`${page.ogTitle || ''} ${page.title || ''}`)],
      ['text', fromText(page.text || '')],
    ];
    const listing = { price: null, surface: null, rooms: null, type: null, postcode: null, town: null, sources: {} };
    for (const [source, values] of sources) {
      for (const [field, value] of Object.entries(values)) {
        if (value != null && listing[field] == null) {
          listing[field] = value;
          listing.sources[field] = source;
        }
      }
    }
    return listing;
  };

  /** URL of the app's property dashboard prefilled with the listing (the user confirms there). */
  const dashboardUrl = (appUrl, listing) => {
    const params = new URLSearchParams();
    const address = [listing.postcode, listing.town].filter(Boolean).join(' ');
    if (address) params.set('address', address);
    if (listing.type) params.set('type', listing.type);
    if (listing.surface) params.set('surface', String(listing.surface));
    if (listing.rooms) params.set('rooms', String(listing.rooms));
    if (listing.price) params.set('price', String(listing.price));
    return `${appUrl}/property?${params.toString()}`;
  };

  globalThis.reaListing = { collectPage, parseListing, dashboardUrl };
})();
