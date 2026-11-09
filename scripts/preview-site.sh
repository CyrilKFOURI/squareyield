#!/usr/bin/env bash
# Production build served locally (docs/features/018-speed-and-map/spec.md): what users get, minified and gzipped.
# The dev server (`npx expo start --web`) compiles on demand and is much slower: use it to edit code, not to judge speed.
#   scripts/preview-site.sh          build into data/preview-build and serve it on http://localhost:8082
#   scripts/preview-site.sh --serve  serve the last build without rebuilding
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/data/preview-build"
if [[ "${1:-}" != "--serve" ]]; then
  (cd "$root/pipeline" && uv run rea sync-app)
  cd "$root/apps/app"
  npm run postinstall >/dev/null
  rm -rf "$out"
  # outside apps/app: the dev server watches that folder and can lock files in it
  MSYS_NO_PATHCONV=1 npx expo export --platform web --output-dir "$(cygpath -w "$out" 2>/dev/null || echo "$out")"
fi
node "$root/scripts/preview-server.js" "$out" "${PORT:-8082}"
