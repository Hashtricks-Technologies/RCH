#!/usr/bin/env bash
#
# Assemble the published site.
#
#   /            project home
#   /docs/       user-acceptance spec, system design, user flows
#   /app/        the React application
#
# Netlify runs this as its build command; CI runs the same script so what is
# verified is exactly what is deployed.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Netlify starts from a clean checkout; a local run usually has the modules already.
if [ ! -d web/node_modules ]; then
  echo "→ installing application dependencies"
  npm --prefix web ci
fi

echo "→ building the application"
npm --prefix web run build

echo "→ assembling the site"
rm -rf dist
mkdir -p dist
cp index.html dist/index.html
cp -R docs dist/docs
cp -R web/dist dist/app

echo "✓ site assembled"
printf '  %s\n' \
  "/            $(du -sh dist/index.html | cut -f1)" \
  "/docs/       $(find dist/docs -type f | wc -l | tr -d ' ') files" \
  "/app/        $(find dist/app -type f | wc -l | tr -d ' ') files"
