#!/usr/bin/env bash
# Build the web app with the published KPI files for GitHub Pages (docs/features/016-publication/spec.md).
#   scripts/publish-site.sh            build into data/site-build (check it locally first)
#   scripts/publish-site.sh --push     also commit the build to the gh-pages branch and push it
# SITE_BASE_PATH defaults to /<repository name>, the sub-path of a GitHub Pages project site.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
repo_name="$(basename "$(git -C "$root" remote get-url origin 2>/dev/null || echo cyfouri)" .git)"
export SITE_BASE_PATH="${SITE_BASE_PATH:-/$repo_name}"

(cd "$root/pipeline" && uv run rea sync-app)           # aggregates only: every figure rests on >= 10 sales
cd "$root/apps/app"
npm run postinstall >/dev/null                          # MapLibre worker into public/vendor
# outside apps/app: the dev server watches that folder and can lock files in it
out="$root/data/site-build"
rm -rf "$out"
# Git Bash on Windows would rewrite SITE_BASE_PATH ("/x" into "C:/Program Files/Git/x") for node: not here
MSYS2_ENV_CONV_EXCL=SITE_BASE_PATH MSYS_NO_PATHCONV=1 npx expo export --platform web --output-dir "$(cygpath -w "$out" 2>/dev/null || echo "$out")"
cp "$out/index.html" "$out/404.html"                  # deep links on GitHub Pages fall back to the app
touch "$out/.nojekyll"                                  # serve files whose names start with _
echo "Built $out for $SITE_BASE_PATH ($(du -sh "$out" | cut -f1))."

if [[ "${1:-}" == "--push" ]]; then
  # a fresh one-commit branch: the site never carries the code history
  origin="$(git -C "$root" remote get-url origin)"
  work="$(mktemp -d)"
  cp -r "$out/." "$work/"
  git -C "$work" init -q -b gh-pages
  git -C "$work" add -A
  git -C "$work" commit -q -m "Publish site $(date -u +%Y-%m-%dT%H:%MZ)"
  git -C "$work" push -f "$origin" gh-pages
  rm -rf "$work"
fi
