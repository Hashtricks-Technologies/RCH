#!/usr/bin/env bash
# `pnpm compose:test` (root package.json) - the compose analogue of `helm:test`. Validates that
# `compose.yml` parses and every required variable is at least declared, without needing Docker
# running or real secrets: dummy values stand in for the ones `.env.example` leaves blank, since
# a structural check should not depend on a real JWT key pair or a real password existing.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is not available on this host - skipping (see CI, which has it)." >&2
  exit 0
fi

out=$(
  DOMAIN=example.test \
  POSTGRES_PASSWORD=x \
  JWT_PRIVATE_KEY=x \
  JWT_PUBLIC_KEY=x \
  SEED_PASSWORD=x \
  docker compose -f compose.yml config --quiet 2>&1
) || { echo "$out" >&2; echo "compose.yml failed to parse" >&2; exit 1; }

echo "compose.yml is well-formed"
