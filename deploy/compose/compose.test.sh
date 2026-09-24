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
command -v jq >/dev/null || { echo "jq is required to check the rendered compose file" >&2; exit 1; }

render() {
  DOMAIN=example.test \
  POSTGRES_PASSWORD=x \
  APP_DB_PASSWORD=x \
  AUDIT_DB_PASSWORD=x \
  JWT_PRIVATE_KEY=x \
  JWT_PUBLIC_KEY=x \
  SEED_PASSWORD=x \
  IMAGE_BUCKET=x \
  docker compose --env-file /dev/null -f compose.yml config "$@" 2>&1
}

out=$(render --quiet) || { echo "$out" >&2; echo "compose.yml failed to parse" >&2; exit 1; }
json=$(render --format json) || { echo "$json" >&2; echo "compose.yml failed to render" >&2; exit 1; }

check() { jq -e "$1" >/dev/null <<<"$json" || { echo "FAIL: $2" >&2; exit 1; }; }

# The two runtime passwords are required, like every other secret here: a blank one would start
# the API or the audit service as a role with an empty password.
for v in APP_DB_PASSWORD AUDIT_DB_PASSWORD; do
  if missing=$(DOMAIN=example.test POSTGRES_PASSWORD=x APP_DB_PASSWORD=x AUDIT_DB_PASSWORD=x \
      JWT_PRIVATE_KEY=x JWT_PUBLIC_KEY=x SEED_PASSWORD=x IMAGE_BUCKET=x env -u "$v" docker compose --env-file /dev/null -f compose.yml config --quiet 2>&1); then
    echo "FAIL: compose.yml rendered without $v" >&2; exit 1
  fi
  grep -q "$v" <<<"$missing" || { echo "FAIL: a missing $v must be refused by name; got: $missing" >&2; exit 1; }
done

check '.services | has("migrate") and has("audit-migrate") and has("api") and has("audit") and has("ui") and has("caddy")' \
  "compose.yml must run migrate, audit-migrate, api, audit, ui and caddy"
# Least privilege: the long-running API holds rch_app and no superuser URL at all.
check '.services.api.environment | has("MIGRATE_DATABASE_URL") | not' "api must not carry MIGRATE_DATABASE_URL"
check '.services.api.environment.DATABASE_URL | startswith("postgres://rch_app:")' "api must connect as rch_app"
# The API's migrate step and every operator CLI run through `migrate`, as the superuser, and read
# the runtime role's name and password from DATABASE_URL.
check '.services.migrate.environment.MIGRATE_DATABASE_URL | startswith("postgres://rch:")' "migrate must connect as rch"
check '.services.migrate.environment.DATABASE_URL | startswith("postgres://rch_app:")' "migrate must read rch_app from DATABASE_URL"
check '.services["audit-migrate"].environment.MIGRATE_DATABASE_URL | startswith("postgres://rch:")' "audit-migrate must connect as rch"
check '.services["audit-migrate"].environment.AUDIT_DATABASE_URL | startswith("postgres://rch_audit:")' "audit-migrate must read rch_audit from AUDIT_DATABASE_URL"
check '.services.audit.environment.AUDIT_DATABASE_URL | startswith("postgres://rch_audit:")' "audit must connect as rch_audit"
# The audit containers verify tokens and never sign one or seed anything.
for s in audit audit-migrate; do
  for k in JWT_PRIVATE_KEY SEED_PASSWORD DATABASE_URL; do
    check ".services[\"$s\"].environment | has(\"$k\") | not" "$s must not carry $k"
  done
done
check '.services.audit.environment | has("MIGRATE_DATABASE_URL") | not' "audit must not carry MIGRATE_DATABASE_URL"
# Start order: postgres → migrate → audit-migrate → audit, and Caddy waits for all three backends.
check '.services["audit-migrate"].depends_on.migrate.condition == "service_completed_successfully"' "audit-migrate must wait for migrate"
check '.services.audit.depends_on["audit-migrate"].condition == "service_completed_successfully"' "audit must wait for audit-migrate"
check '.services.api.depends_on.migrate.condition == "service_completed_successfully"' "api must wait for migrate"
check '.services.caddy.depends_on | has("audit") and has("api") and has("ui")' "caddy must depend on ui, api and audit"
check '.services["audit-migrate"].command == ["dist/cli/migrate.mjs"]' "audit-migrate must run dist/cli/migrate.mjs"
# QR ordering's Razorpay keys are optional: the render above sets none of them and must still pass,
# the API must carry all three (empty) so .env alone switches online ordering on, and no other
# container - not `migrate`, which the operator CLIs run through, nor either audit container - may
# see a payment secret. The worker interval defaults to a running worker, never 0.
for k in RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET; do
  check ".services.api.environment | has(\"$k\")" "api must carry $k"
  for s in migrate audit audit-migrate; do
    check ".services[\"$s\"].environment | has(\"$k\") | not" "$s must not carry $k"
  done
done
check '.services.api.environment.RAZORPAY_KEY_SECRET == ""' "an unset RAZORPAY_KEY_SECRET must render empty, not fail"
check '.services.api.environment.QR_WORKER_INTERVAL_MS == "30000"' "an unset QR_WORKER_INTERVAL_MS must default to 30000"
check '.services.api.environment.QR_PENDING_PER_IP == "20"' "an unset QR_PENDING_PER_IP must default to 20"

# The Caddyfile, adapted by the same Caddy image the box runs: it must parse, and the routes must be
# tried in the order the site depends on - the audit reads before the API's `/api/*`, and both
# readiness paths reaching a backend instead of falling through to the UI's static `ok`.
caddy_json=$(docker run --rm -e DOMAIN=example.test -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2.10-alpine caddy adapt --config /etc/caddy/Caddyfile --validate 2>/dev/null) \
  || { echo "FAIL: the Caddyfile does not adapt" >&2; exit 1; }
routes='[.apps.http.servers.srv0.routes[0].handle[0].routes[] | select(.match != null)
  | { path: .match[0].path[0], rewrite: ([.handle[].routes[]?.handle[]? | select(.handler == "rewrite") | .uri] | first),
      dial: ([.handle[].routes[]?.handle[]? | select(.handler == "reverse_proxy") | .upstreams[0].dial] | first) }]'
order=$(jq -r "$routes | map(.path) | join(\" \")" <<<"$caddy_json")
[ "$order" = "/api/v1/admin/audit* /readyz/audit /readyz /api/*" ] \
  || { echo "FAIL: Caddy tries its routes in the wrong order: $order" >&2; exit 1; }
caddy_check() { jq -e "$routes | $1" >/dev/null <<<"$caddy_json" || { echo "FAIL: Caddyfile: $2" >&2; exit 1; }; }
caddy_check 'any(.path == "/api/v1/admin/audit*" and .dial == "audit:3100")' "the audit reads must reach audit:3100"
caddy_check 'any(.path == "/readyz" and .dial == "api:3000")' "/readyz must reach the API"
caddy_check 'any(.path == "/readyz/audit" and .rewrite == "/readyz" and .dial == "audit:3100")' "/readyz/audit must reach the audit service's /readyz"

# A correct Caddyfile is worth nothing if the running Caddy never reads it. The file is a bind
# mount and the box runs Caddy with `admin off`, so neither compose nor a reload notices an edit:
# `deploy.sh` passes the file's checksum in Caddy's environment, and that is what makes compose
# recreate the container when the routes change. A deploy once left new audit routes on disk while
# Caddy went on serving a three-day-old config; these two checks are that bug's fence.
check '.services.caddy.environment | has("CADDYFILE_SHA")' \
  "caddy must carry CADDYFILE_SHA, or a changed Caddyfile never reaches the running container"
grep -q '^export CADDYFILE_SHA$' deploy.sh \
  || { echo "FAIL: deploy.sh must export CADDYFILE_SHA from the Caddyfile's checksum" >&2; exit 1; }

echo "compose.yml and the Caddyfile are well-formed"
