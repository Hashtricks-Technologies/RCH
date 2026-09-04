#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."

# Runs against a kind cluster that already has the `rch-api:ci` / `rch-ui:ci`
# images loaded (`kind load docker-image`, done by the CI workflow before this
# script runs — see the end of the `images` job in .github/workflows/ci.yml).
# It installs the real chart, seeds the DB, exercises both services through a
# port-forward, then upgrades in place to prove the Secret survives and the
# migrate initContainer is a no-op the second time.
#
# JWT_PRIVATE_KEY / JWT_PUBLIC_KEY must already be exported (base64 PKCS8
# private / SPKI public Ed25519 PEMs — the same shape `pnpm --filter @rch/api
# keys:generate` prints). They are threaded through as --set-string so a
# throwaway key never touches values-ci.yaml.
: "${JWT_PRIVATE_KEY:?set JWT_PRIVATE_KEY (base64 PKCS8 Ed25519 private key) before running install-test.sh}"
: "${JWT_PUBLIC_KEY:?set JWT_PUBLIC_KEY (base64 SPKI Ed25519 public key) before running install-test.sh}"

# Every mounted route lives under API_PREFIX (packages/contract/src/routes.ts) — only
# /healthz, /readyz, /metrics on the api, and the UI's own nginx-served /healthz, are not
# prefixed. Keep this in one place so a script edit can't silently drift from the contract.
API=http://localhost:3000
API_PREFIX=/api/v1
UI=http://localhost:8080

BASE_ARGS=(
  --set-string "secrets.values.JWT_PRIVATE_KEY=$JWT_PRIVATE_KEY"
  --set-string "secrets.values.JWT_PUBLIC_KEY=$JWT_PUBLIC_KEY"
)
SET_ARGS=("${BASE_ARGS[@]}")

# E2E=1 adds the Playwright smoke at the end (see the block after the UI health check). Three
# settings have to move for it. They are set here rather than in ci/values-ci.yaml because they
# are properties of how the smoke reaches the cluster — one port-forward, so one client address,
# and six accounts driven back to back — and not of the chart or of this environment. CI sets
# E2E=1 on every run, so the pipeline never installs without them on the first leg; the
# `helm upgrade` at the end drops back to BASE_ARGS, so every run still installs the chart's own
# defaults once and proves they come up.
#
#  * SEED_FORCE_PASSWORD_CHANGE=false. The seed below runs inside the api container and inherits
#    its env; left at the default the six seeded accounts land on "Choose a new password" at
#    first sign-in, and the smoke would have to carry a rotated password between six roles.
#  * The two login rate limits. Everything the smoke does arrives through one port-forward, so
#    the API sees one client address for sixteen sign-ins inside a minute and the per-IP budget
#    of ten refuses the rest. The general RATE_LIMIT_PER_MINUTE is deliberately left at its
#    default: the smoke stays inside it, so every non-login call is still made under the same
#    budget production runs.
if [ "${E2E:-}" = "1" ]; then
  SET_ARGS+=(
    --set-string "api.env.SEED_FORCE_PASSWORD_CHANGE=false"
    --set-string "api.env.LOGIN_RATE_LIMIT_PER_MINUTE=200"
    --set-string "api.env.LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE=100"
  )
fi

API_PF_PID=""
UI_PF_PID=""
kill_pf() {
  [ -n "$API_PF_PID" ] && kill "$API_PF_PID" 2>/dev/null || true
  [ -n "$UI_PF_PID" ] && kill "$UI_PF_PID" 2>/dev/null || true
  API_PF_PID=""
  UI_PF_PID=""
}
trap kill_pf EXIT

on_failure() {
  echo "--- install-test.sh failed: cluster diagnostics ---" >&2
  kubectl get pods -A || true
  kubectl logs deploy/rch-api -c migrate --tail=50 || true
  kubectl logs deploy/rch-api -c api --tail=50 || true
  cat /tmp/pf-api.log 2>/dev/null || true
  cat /tmp/pf-ui.log 2>/dev/null || true
}
trap on_failure ERR

# fail <message>: every explicit status-code assertion below goes through this instead of a
# bare `exit 1` inside a `[ ... ] || { ...; exit 1; }` block — that form runs in the current
# shell but an explicit `exit` there bypasses the `trap ... ERR` above (ERR does not fire for
# a command whose failure is already being handled by `||`), so a login/healthz assertion
# failure would previously print nothing about the cluster before the job died.
fail() {
  echo "$*" >&2
  on_failure
  exit 1
}

# wait_for <url>: retry a plain GET for up to ~30s (port-forward needs a beat
# to come up; the readiness probe needs a beat to pass on a fresh pod).
wait_for() {
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null "$1" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

echo "== throwaway postgres =="
kubectl apply -f deploy/chart/rch/ci/postgres.yaml
kubectl rollout status deploy/postgres --timeout=120s

echo "== helm install =="
helm install rch deploy/chart/rch -f deploy/chart/rch/ci/values-ci.yaml "${SET_ARGS[@]}" --wait --timeout 5m

echo "== seed (RC-3120 / changeme) =="
kubectl exec deploy/rch-api -c api -- /nodejs/bin/node dist/cli/seed.mjs

echo "== api: /readyz and login =="
kubectl port-forward svc/rch-api 3000:3000 >/tmp/pf-api.log 2>&1 &
API_PF_PID=$!
wait_for "$API/readyz"
curl -fsS "$API/readyz"

LOGIN_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"emp":"RC-3120","password":"changeme"}' "$API$API_PREFIX/auth/login")
[ "$LOGIN_CODE" = 200 ] || fail "login: expected 200, got $LOGIN_CODE"

echo "== ui: /healthz =="
kubectl rollout status deploy/rch-ui --timeout=120s
kubectl port-forward svc/rch-ui 8080:8080 >/tmp/pf-ui.log 2>&1 &
UI_PF_PID=$!
wait_for "$UI/healthz"
UI_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$UI/healthz")
[ "$UI_CODE" = 200 ] || fail "ui healthz: expected 200, got $UI_CODE"

if [ "${E2E:-}" = "1" ]; then
  echo "== playwright smoke against the cluster =="
  # Both port-forwards are up: the UI on 8080 and the API on 3000. The UI's nginx proxies /api
  # and /api/v1/events to the API service inside the cluster, so the browser needs only the one.
  E2E_BASE_URL="$UI" pnpm test:e2e
fi

kill_pf

# BASE_ARGS, not SET_ARGS: the smoke has finished, so this leg drops the three settings it
# needed and puts the chart's own defaults back — which is both the upgrade this job has always
# proved (the Secret survives, the migrate initContainer no-ops) and the one install in the run
# that exercises ci/values-ci.yaml as it actually ships.
echo "== helm upgrade (chart defaults: proves the Secret survives and the migrate initContainer no-ops) =="
helm upgrade --install rch deploy/chart/rch -f deploy/chart/rch/ci/values-ci.yaml "${BASE_ARGS[@]}" --wait --timeout 5m

kubectl port-forward svc/rch-api 3000:3000 >/tmp/pf-api.log 2>&1 &
API_PF_PID=$!
wait_for "$API/readyz"
curl -fsS "$API/readyz"

kill_pf
trap - ERR
echo "chart installs, seeds, serves and upgrades cleanly in kind"
