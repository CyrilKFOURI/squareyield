// MapLibre's worker cannot be rebuilt from Metro's bundle: the map uses the CSP build and loads its
// worker as a static file (public/vendor), copied here so it always matches the installed version.
const fs = require('fs');
const path = require('path');

const source = require.resolve('maplibre-gl/dist/maplibre-gl-csp-worker.js');
const target = path.join(__dirname, '..', 'public', 'vendor', 'maplibre-gl-csp-worker.js');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`maplibre worker -> ${path.relative(process.cwd(), target)}`);
