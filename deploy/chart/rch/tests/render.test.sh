#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
helm lint . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x
helm lint . -f values-prod.yaml --set image.registry=r,image.tag=t

out=$(helm template rch . -f values-prod.yaml --set image.registry=r,image.tag=t)
grep -q 'kind: ExternalSecret' <<<"$out"
! grep -q 'kind: Secret$' <<<"$out"
grep -q 'readOnlyRootFilesystem: true' <<<"$out"
# I12: api Deployment, migrate Job, purge CronJob and ui Deployment containers
# must all run with a read-only root filesystem.
[ "$(grep -c 'readOnlyRootFilesystem: true' <<<"$out")" -ge 4 ]
grep -q 'helm.sh/hook: pre-install,pre-upgrade' <<<"$out"
# I3: the ExternalSecret itself (not just the migrate Job) must carry the
# pre-install hook, ordered ahead of the migrate Job's hook-weight "0".
grep -A15 'kind: ExternalSecret' <<<"$out" | grep -q 'helm.sh/hook: pre-install,pre-upgrade'
grep -A15 'kind: ExternalSecret' <<<"$out" | grep -q 'hook-weight: "-5"'
# I3: JWT_PREVIOUS_PUBLIC_KEY is only populated during key rotation, so its
# secretKeyRef must be optional.
grep -q 'key: JWT_PREVIOUS_PUBLIC_KEY, optional: true' <<<"$out"
grep -q 'path: /readyz' <<<"$out"
grep -q 'idle_timeout.timeout_seconds=3600' <<<"$out"
# I9: the ServiceMonitor must select only the api Service, not the ui Service
# (both share app.kubernetes.io/instance and expose a port named "http").
grep -A3 'kind: ServiceMonitor' <<<"$out" | grep -q 'component: api'
# C1: secret values must never be inlined as plaintext env `value:` entries —
# always sourced via secretKeyRef, on both the prod (ExternalSecret) and
# staging (Secret) paths.
! (grep -A2 'name: JWT_PRIVATE_KEY' <<<"$out" | grep -q 'value:')
! (grep -A2 'name: DATABASE_URL' <<<"$out" | grep -q 'value:')
grep -q 'secretKeyRef' <<<"$out"

out=$(helm template rch . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x)
grep -q 'kind: Secret' <<<"$out"
# The staging Secret is also a pre-install hook, ordered ahead of the migrate
# Job, for the same first-install ordering reason as the prod ExternalSecret.
grep -A15 'kind: Secret$' <<<"$out" | grep -q 'helm.sh/hook: pre-install,pre-upgrade'
! (grep -A2 'name: JWT_PRIVATE_KEY' <<<"$out" | grep -q 'value:')
! (grep -A2 'name: DATABASE_URL' <<<"$out" | grep -q 'value:')
grep -q 'secretKeyRef' <<<"$out"

echo "chart renders"
