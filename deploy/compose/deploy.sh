#!/usr/bin/env bash
# Build and bring up the single-instance stack from this checkout, in place.
#
# Run this from the box, inside a checkout of this repository, after `git pull` has it on the
# commit you want live:
#
#   deploy/compose/deploy.sh
#
# What it does, in order: builds the api and ui images from this checkout's own Dockerfiles
# (the same two Dockerfiles the EKS path builds — there is one image definition per service,
# not two), brings the stack up (`postgres` → `migrate` → `api`/`ui`/`caddy`, in that order,
# via compose's own `depends_on` conditions — a fresh Postgres or a pending migration is never
# raced), seeds the database only the first time it is empty, and reports the result. It is
# safe to run again on an already-running stack: rebuilding and re-upping a service compose
# finds unchanged is a no-op, and the seed step only ever fires once.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -f .env ]; then
  echo "Missing deploy/compose/.env — copy .env.example, fill it in, then run this again." >&2
  exit 1
fi

compose() { docker compose --env-file .env -f compose.yml "$@"; }

echo "== building images =="
compose build

echo "== starting postgres, running the migration, then api / ui / caddy =="
compose up -d

echo "== seeding, if this is a first run =="
# `migrate` has already run to completion by the time `up -d` returns (api's `depends_on:
# migrate: condition: service_completed_successfully` blocks it), so `users` exists whether
# or not this is a first deploy.
users=$(compose exec -T postgres psql -U rch -d rch -tAc "select count(*) from users" 2>/dev/null || echo "")
if [ "$users" = "0" ]; then
  echo "   database is empty — seeding the six accounts"
  compose run --rm --no-deps api dist/cli/seed.mjs --yes-seed rch
else
  echo "   database already has ${users:-some} user(s) — not reseeding"
fi

echo "== waiting for the site to answer =="
domain=$(grep -E '^DOMAIN=' .env | cut -d= -f2-)
for _ in $(seq 1 30); do
  if curl -fsS -m 5 "https://${domain}/healthz" >/dev/null 2>&1; then
    echo "   https://${domain}/healthz is answering"
    break
  fi
  sleep 2
done

docker image prune -f >/dev/null

echo "== status =="
compose ps
echo
echo "Deployed. https://${domain}"
