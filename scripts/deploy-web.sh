#!/usr/bin/env bash
# Build the web app without its data and deploy it to Vercel (docs/features/022-full-frontend/spec.md).
# The data lives on Hugging Face (scripts/upload-data-hf.sh); Vercel Hobby takes ≤ 100 MB and ≤ 15,000 files.
#   scripts/deploy-web.sh <user>/<repo>            build into data/web-build only
#   scripts/deploy-web.sh <user>/<repo> --deploy   build, then `vercel deploy --prod` (needs `vercel login` once)
set -euo pipefail
repo="${1:?usage: scripts/deploy-web.sh <user>/<repo> [--deploy]}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/data/web-build"
cd "$root/apps/app"
npm run postinstall >/dev/null
find "$out" -mindepth 1 -maxdepth 1 ! -name .vercel -exec rm -rf {} + 2>/dev/null || true  # keep the Vercel project link
EXPO_PUBLIC_DATA_URL="https://huggingface.co/datasets/$repo/resolve/main" \
  MSYS_NO_PATHCONV=1 npx expo export --platform web --output-dir "$(cygpath -w "$out" 2>/dev/null || echo "$out")"
rm -rf "$out/data"  # public/data is the local copy of data/serve: served from Hugging Face instead
cp "$root/scripts/vercel.json" "$out/vercel.json"
echo "Build: $(du -sh "$out" | cut -f1), $(find "$out" -type f | wc -l) files"
if [[ "${2:-}" == "--deploy" ]]; then
  cd "$out" && npx --yes vercel deploy --prod
fi
