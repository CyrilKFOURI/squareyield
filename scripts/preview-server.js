// Serves a production web build the way the published site does: gzip, long cache for hashed files, and
// the app page for any unknown route (deep links). Node built-ins only.
//   node scripts/preview-server.js <build dir> [port]
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(process.argv[2] || 'data/preview-build');
const port = Number(process.argv[3] || 8082);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.geojson': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.txt': 'text/plain',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.json', '.css', '.geojson', '.svg', '.txt']);

const resolve = (urlPath) => {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const file = path.join(root, clean);
  if (!file.startsWith(root)) {
    return null;
  }
  for (const candidate of [file, `${file}.html`, path.join(file, 'index.html')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return path.extname(clean) ? null : path.join(root, 'index.html'); // a route, not a missing file
};

http
  .createServer((req, res) => {
    const file = resolve(req.url || '/');
    if (!file) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = path.extname(file);
    const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream' };
    if (file.includes(`${path.sep}_expo${path.sep}`)) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable'; // content-hashed names
    }
    const gzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (gzip) {
      headers['Content-Encoding'] = 'gzip';
    }
    res.writeHead(200, headers);
    const stream = fs.createReadStream(file);
    (gzip ? stream.pipe(zlib.createGzip({ level: 6 })) : stream).pipe(res);
  })
  .listen(port, () => console.log(`Preview of ${root} on http://localhost:${port}`));
