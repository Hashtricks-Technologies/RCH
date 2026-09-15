#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."

# Runs against a kind cluster that already has the `rch-api:ci` / `rch-ui:ci` / `rch-audit:ci`
# images loaded (`kind load docker-image`, done by the CI workflow before this script runs - see
# the end of the `images` job in .github/workflows/ci.yml). It installs the real chart, seeds the
# DB, exercises all three services through a port-forward - including one audit event travelling
# API outbox → drainer → audit read - then upgrades in place to prove the Secret survives and
# both migrate initContainers are no-ops the second time.
#
# JWT_PRIVATE_KEY / JWT_PUBLIC_KEY must already be exported (base64 PKCS8
# private / SPKI public Ed25519 PEMs - the same shape `pnpm --filter @rch/api
# keys:generate` prints). They are threaded through as --set-string so a
# throwaway key never touches values-ci.yaml.
: "${JWT_PRIVATE_KEY:?set JWT_PRIVATE_KEY (base64 PKCS8 Ed25519 private key) before running install-test.sh}"
: "${JWT_PUBLIC_KEY:?set JWT_PUBLIC_KEY (base64 SPKI Ed25519 public key) before running install-test.sh}"
command -v jq >/dev/null || { echo "install-test.sh needs jq to read the audit service's answer" >&2; exit 1; }

# SEED_PASSWORD has no default in apps/api/src/config.ts any more, so the api container will not
# start without it and the seed below would have nothing to hash. It is threaded through the
# chart the same way the keys are, and defaulted here so the script still runs by hand. The login
# checks below sign in with it, so it is the password the seed actually wrote.
SEED_PASSWORD="${SEED_PASSWORD:-ci-seed-password-1}"

# Every mounted route lives under API_PREFIX (packages/contract/src/routes.ts) - only
# /healthz, /readyz, /metrics on the api and the audit service, and the UI's own nginx-served
# /healthz, are not prefixed. Keep this in one place so a script edit can't silently drift from
# the contract.
API=http://localhost:3000
AUDIT=http://localhost:3100
API_PREFIX=/api/v1
UI=http://localhost:8080

SET_ARGS=(
  --set-string "secrets.values.JWT_PRIVATE_KEY=$JWT_PRIVATE_KEY"
  --set-string "secrets.values.JWT_PUBLIC_KEY=$JWT_PUBLIC_KEY"
  --set-string "secrets.values.SEED_PASSWORD=$SEED_PASSWORD"
)

API_PF_PID=""
UI_PF_PID=""
AUDIT_PF_PID=""
kill_pf() {
  [ -n "$API_PF_PID" ] && kill "$API_PF_PID" 2>/dev/null || true
  [ -n "$UI_PF_PID" ] && kill "$UI_PF_PID" 2>/dev/null || true
  [ -n "$AUDIT_PF_PID" ] && kill "$AUDIT_PF_PID" 2>/dev/null || true
  API_PF_PID=""
  UI_PF_PID=""
  AUDIT_PF_PID=""
}
trap kill_pf EXIT

on_failure() {
  echo "--- install-test.sh failed: cluster diagnostics ---" >&2
  kubectl get pods -A || true
  kubectl logs deploy/rch-api -c migrate --tail=50 || true
  kubectl logs deploy/rch-api -c api --tail=50 || true
  kubectl logs deploy/rch-audit -c audit-migrate --tail=50 || true
  kubectl logs deploy/rch-audit -c audit --tail=50 || true
  cat /tmp/pf-api.log 2>/dev/null || true
  cat /tmp/pf-audit.log 2>/dev/null || true
  cat /tmp/pf-ui.log 2>/dev/null || true
}
trap on_failure ERR

# fail <message>: every explicit status-code assertion below goes through this instead of a
# bare `exit 1` inside a `[ ... ] || { ...; exit 1; }` block - that form runs in the current
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
# networkPolicy.albSourceCidr, which defaults to 0.0.0.0/0 - that covers both `kubectl
# port-forward` (traffic arrives from the node, not from a pod any selector could name) and the
# kubelet's probes - and the ui pod reaching the api and the audit service is allowed by name on
# top of that. The throwaway Postgres below and the one-off seed pod carry none of the release's
# labels, so the default-deny does not select them.
echo "== throwaway postgres =="
kubectl apply -f deploy/chart/rch/ci/postgres.yaml
kubectl rollout status deploy/postgres --timeout=120s

echo "== helm install =="
helm install rch deploy/chart/rch -f deploy/chart/rch/ci/values-ci.yaml "${SET_ARGS[@]}" --wait --timeout 5m

# The seed is an operator CLI, and operator CLIs connect as the superuser (MIGRATE_DATABASE_URL) -
# which the api container deliberately does not hold, since it serves requests as rch_app. So the
# seed runs the way an operator runs any CLI against this chart: a one-off pod made from the api
# Deployment's own migrate initContainer - same image, same env, same Secret references, nothing
# secret on a command line - with the CLI swapped in for the migration.
# --yes-seed rch because that env sets NODE_ENV=production, and cli/seed.ts refuses to seed there
# unless the database is named back - `rch` is what ci/postgres.yaml's POSTGRES_DB creates. No
# --force: the database underneath is a fresh container, nothing to empty.
# SEED_FORCE_PASSWORD_CHANGE=false (config.ts defaults it to true, and the chart does not set it)
# so RC-0001 signs in below as a plain admin rather than an account held at the password change.
echo "== seed (RC-3120 and RC-0001 / \$SEED_PASSWORD) =="
seed_pod=$(kubectl get deploy/rch-api -o json | jq -c '{ spec: { containers: [
  .spec.template.spec.initContainers[] | select(.name == "migrate")
  | .name = "rch-seed" | .args = ["dist/cli/seed.mjs", "--yes-seed", "rch"]
  | .env += [{ name: "SEED_FORCE_PASSWORD_CHANGE", value: "false" }] ] } }')
kubectl run rch-seed --rm -i --quiet --restart=Never --image=rch-api:ci --overrides="$seed_pod"

echo "== api: /readyz and login =="
kubectl port-forward svc/rch-api 3000:3000 >/tmp/pf-api.log 2>&1 &
API_PF_PID=$!
wait_for "$API/readyz"
curl -fsS "$API/readyz"

LOGIN_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d "{\"emp\":\"RC-3120\",\"password\":\"$SEED_PASSWORD\"}" "$API$API_PREFIX/auth/login")
[ "$LOGIN_CODE" = 200 ] || fail "login: expected 200, got $LOGIN_CODE"

# The audit service end to end on a real cluster: the super admin signs in through the API, which
# writes a `login` event to audit_outbox in the sign-in's own transaction; an audit pod drains it
# into the audit schema; and the same admin token reads it back from the audit service - which
# proves the API's rch_app grant, the drainer, rch_audit's grants, the shared public key and the
# admin gate all at once.
echo "== audit: /readyz, and the sign-in just made reaches the log =="
kubectl rollout status deploy/rch-audit --timeout=120s
kubectl port-forward svc/rch-audit 3100:3100 >/tmp/pf-audit.log 2>&1 &
AUDIT_PF_PID=$!
wait_for "$AUDIT/readyz" || fail "audit /readyz never answered 200"
curl -fsS "$AUDIT/readyz"

ADMIN_LOGIN=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"emp\":\"RC-0001\",\"password\":\"$SEED_PASSWORD\"}" "$API$API_PREFIX/auth/login")
TOKEN=$(jq -r '.accessToken // empty' <<<"$ADMIN_LOGIN" 2>/dev/null || true)
[ -n "$TOKEN" ] || fail "admin login: no accessToken in the answer: $ADMIN_LOGIN"

AUDIT_CODE=""
for _ in $(seq 1 15); do
  AUDIT_CODE=$(curl -s -o /tmp/audit-page.json -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
    "$AUDIT$API_PREFIX/admin/audit?action=login&limit=50" || true)
  if [ "$AUDIT_CODE" = 200 ] && jq -e \
      '[.rows[] | select(.action == "login" and .outcome == "done" and .actor.emp == "RC-0001")] | length > 0' \
      /tmp/audit-page.json >/dev/null; then
    break
  fi
  AUDIT_CODE="missing"
  sleep 1
done
[ "$AUDIT_CODE" = 200 ] || fail "the RC-0001 sign-in never reached GET $API_PREFIX/admin/audit within 15s (last answer: $(cat /tmp/audit-page.json 2>/dev/null))"
echo "   the RC-0001 sign-in is in the audit log"

echo "== ui: /healthz =="
kubectl rollout status deploy/rch-ui --timeout=120s
kubectl port-forward svc/rch-ui 8080:8080 >/tmp/pf-ui.log 2>&1 &
UI_PF_PID=$!
wait_for "$UI/healthz"
UI_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$UI/healthz")
[ "$UI_CODE" = 200 ] || fail "ui healthz: expected 200, got $UI_CODE"

kill_pf

echo "== helm upgrade (proves the Secret survives and both migrate initContainers no-op) =="
helm upgrade --install rch deploy/chart/rch -f deploy/chart/rch/ci/values-ci.yaml "${SET_ARGS[@]}" --wait --timeout 5m

kubectl port-forward svc/rch-api 3000:3000 >/tmp/pf-api.log 2>&1 &
API_PF_PID=$!
wait_for "$API/readyz"
curl -fsS "$API/readyz"

kubectl port-forward svc/rch-audit 3100:3100 >/tmp/pf-audit.log 2>&1 &
AUDIT_PF_PID=$!
wait_for "$AUDIT/readyz" || fail "audit /readyz never answered 200 after the upgrade"
curl -fsS "$AUDIT/readyz"

kill_pf
trap - ERR
echo "chart installs, seeds, serves, audits and upgrades cleanly in kind"
