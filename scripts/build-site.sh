#!/usr/bin/env bash
#
# Assemble the published site.
#
#   /            project home
#   /docs/       user-acceptance spec, system design, user flows
#   /app/        the React application — only when BUILD_APP=1
#
# Netlify runs this as its build command; CI runs the same script so what is
# verified is exactly what is deployed.
#
# /app is behind BUILD_APP because the two callers want different things from it. CI sets
# BUILD_APP=1 and wants the bundle built and assembled, since building it is how CI learns the
# app still builds. Netlify leaves it unset: a static copy there has no /api to talk to, so it
# signed nobody in, and netlify.toml redirects /app to the deployment that does. The UI build
# itself runs either way — a site build that stopped compiling the app would stop noticing when
# the app stopped compiling.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Netlify starts from a clean checkout; a local run usually has the modules already.
if [ ! -d node_modules ]; then
  echo "→ installing application dependencies"
  pnpm install --frozen-lockfile
fi

echo "→ building the application"
pnpm --filter @rch/ui build

echo "→ assembling the site"
rm -rf dist
mkdir -p dist
cp index.html dist/index.html
cp -R docs dist/docs
if [ "${BUILD_APP:-}" = "1" ]; then
  cp -R UI/dist dist/app
fi

echo "✓ site assembled"
printf '  %s\n' \
  "/            $(du -sh dist/index.html | cut -f1)" \
  "/docs/       $(find dist/docs -type f | wc -l | tr -d ' ') files"
if [ -d dist/app ]; then
  printf '  %s\n' "/app/        $(find dist/app -type f | wc -l | tr -d ' ') files"
else
  printf '  %s\n' "/app/        not assembled (BUILD_APP is not 1); netlify.toml redirects it"
fi
