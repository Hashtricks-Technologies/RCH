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

# SEED_PASSWORD has no default in apps/api/src/config.ts any more, so the api container will not
# start without it and the seed below would have nothing to hash. It is threaded through the
# chart the same way the keys are, and defaulted here so the script still runs by hand. The login
# check below signs in with it, so it is the password the seed actually wrote.
SEED_PASSWORD="${SEED_PASSWORD:-ci-seed-password-1}"

# Every mounted route lives under API_PREFIX (packages/contract/src/routes.ts) — only
# /healthz, /readyz, /metrics on the api, and the UI's own nginx-served /healthz, are not
# prefixed. Keep this in one place so a script edit can't silently drift from the contract.
API=http://localhost:3000
API_PREFIX=/api/v1
UI=http://localhost:8080

SET_ARGS=(
  --set-string "secrets.values.JWT_PRIVATE_KEY=$JWT_PRIVATE_KEY"
  --set-string "secrets.values.JWT_PUBLIC_KEY=$JWT_PUBLIC_KEY"
  --set-string "secrets.values.SEED_PASSWORD=$SEED_PASSWORD"
)

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

# The chart's NetworkPolicies (templates/networkpolicy.yaml) install here with everything else and
# need no CI override. kind's default CNI may not enforce them at all, and where it does they are
# already open enough for this script: each component's serving port is allowed from
# networkPolicy.albSourceCidr, which defaults to 0.0.0.0/0 — that covers both `kubectl
# port-forward` (traffic arrives from the node, not from a pod any selector could name) and the
# kubelet's probes — and the ui pod reaching the api is allowed by name on top of that. The
# throwaway Postgres below carries none of the release's labels, so the default-deny does not
# select it.
echo "== throwaway postgres =="
kubectl apply -f deploy/chart/rch/ci/postgres.yaml
kubectl rollout status deploy/postgres --timeout=120s

echo "== helm install =="
helm install rch deploy/chart/rch -f deploy/chart/rch/ci/values-ci.yaml "${SET_ARGS[@]}" --wait --timeout 5m

# --yes-seed rch because rch.envList sets NODE_ENV=production in every rendered pod, and
# cli/seed.ts refuses to seed there unless the database is named back — `rch` is what
# ci/postgres.yaml's POSTGRES_DB creates and what values-ci.yaml's DATABASE_URL points at. This
# is a kind cluster deleted at the end of the job, which is exactly the "yes, I mean it" the
# flag is for. No --force: the database underneath is a fresh container, nothing to empty.
echo "== seed (RC-3120 / \$SEED_PASSWORD) =="
kubectl exec deploy/rch-api -c api -- /nodejs/bin/node dist/cli/seed.mjs --yes-seed rch

echo "== api: /readyz and login =="
kubectl port-forward svc/rch-api 3000:3000 >/tmp/pf-api.log 2>&1 &
API_PF_PID=$!
wait_for "$API/readyz"
curl -fsS "$API/readyz"

LOGIN_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d "{\"emp\":\"RC-3120\",\"password\":\"$SEED_PASSWORD\"}" "$API$API_PREFIX/auth/login")
[ "$LOGIN_CODE" = 200 ] || fail "login: expected 200, got $LOGIN_CODE"

echo "== ui: /healthz =="
kubectl rollout status deploy/rch-ui --timeout=120s
kubectl port-forward svc/rch-ui 8080:8080 >/tmp/pf-ui.log 2>&1 &
UI_PF_PID=$!
wait_for "$UI/healthz"
UI_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$UI/healthz")
[ "$UI_CODE" = 200 ] || fail "ui healthz: expected 200, got $UI_CODE"

kill_pf

echo "== helm upgrade (proves the Secret survives and the migrate initContainer no-ops) =="
helm upgrade --install rch deploy/chart/rch -f deploy/chart/rch/ci/values-ci.yaml "${SET_ARGS[@]}" --wait --timeout 5m

kubectl port-forward svc/rch-api 3000:3000 >/tmp/pf-api.log 2>&1 &
API_PF_PID=$!
wait_for "$API/readyz"
curl -fsS "$API/readyz"

kill_pf
trap - ERR
echo "chart installs, seeds, serves and upgrades cleanly in kind"
