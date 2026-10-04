#!/usr/bin/env bash
# Builds granttrail-eb.zip — the Elastic Beanstalk source bundle.
# Run after `npm run build`. Contains only built code + production dependencies
# at the exact versions in package-lock.json (EB skips `npm install` when
# node_modules is present, so the deploy is fast and reproducible).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/deploy-bundle"
ZIP="$ROOT/granttrail-eb.zip"
cd "$ROOT"

if [[ ! -f server/dist/index.js || ! -f client/dist/index.html ]]; then
  echo "Build output missing — run 'npm run build' first." >&2
  exit 1
fi

rm -rf "$OUT" "$ZIP"
mkdir -p "$OUT/server" "$OUT/client"
cp -r server/dist "$OUT/server/dist"
cp server/package.json "$OUT/server/package.json"
cp -r client/dist "$OUT/client/dist"
cp client/package.json "$OUT/client/package.json"
cp -r database "$OUT/database"
cp package.json package-lock.json Procfile "$OUT/"
cp -r .platform .ebextensions "$OUT/"
# Windows checkouts don't keep the executable bit; EB hooks must be executable.
find "$OUT/.platform" -name '*.sh' -exec chmod 755 {} +

# Production dependencies of the server workspace only, from the lockfile.
(cd "$OUT" && npm ci --omit=dev --workspace server --include-workspace-root=false \
  --ignore-scripts --no-audit --no-fund --loglevel=error)
# Workspace symlinks and CLI shims are not needed at runtime.
rm -rf "$OUT/node_modules/@granttrail" "$OUT/node_modules/.bin"

(cd "$OUT" && zip -qr "$ZIP" .)
echo "Created $(basename "$ZIP") ($(du -h "$ZIP" | cut -f1))"
