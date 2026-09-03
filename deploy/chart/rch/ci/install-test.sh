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

SET_ARGS=(
  --set-string "secrets.values.JWT_PRIVATE_KEY=$JWT_PRIVATE_KEY"
  --set-string "secrets.values.JWT_PUBLIC_KEY=$JWT_PUBLIC_KEY"
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
}
trap on_failure ERR

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
wait_for http://localhost:3000/readyz
curl -fsS http://localhost:3000/readyz

LOGIN_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"emp":"RC-3120","password":"changeme"}' http://localhost:3000/auth/login)
[ "$LOGIN_CODE" = 200 ] || { echo "login: expected 200, got $LOGIN_CODE" >&2; exit 1; }

echo "== ui: /healthz =="
kubectl rollout status deploy/rch-ui --timeout=120s
kubectl port-forward svc/rch-ui 8080:8080 >/tmp/pf-ui.log 2>&1 &
UI_PF_PID=$!
wait_for http://localhost:8080/healthz
UI_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/healthz)
[ "$UI_CODE" = 200 ] || { echo "ui healthz: expected 200, got $UI_CODE" >&2; exit 1; }

kill_pf

echo "== helm upgrade (same values: proves the Secret survives and the migrate initContainer no-ops) =="
helm upgrade --install rch deploy/chart/rch -f deploy/chart/rch/ci/values-ci.yaml "${SET_ARGS[@]}" --wait --timeout 5m

kubectl port-forward svc/rch-api 3000:3000 >/tmp/pf-api.log 2>&1 &
API_PF_PID=$!
wait_for http://localhost:3000/readyz
curl -fsS http://localhost:3000/readyz

kill_pf
trap - ERR
echo "chart installs, seeds, serves and upgrades cleanly in kind"
