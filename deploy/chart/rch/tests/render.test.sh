#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
helm lint . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x
helm lint . -f values-prod.yaml --set image.registry=r,image.tag=t

out=$(helm template rch . -f values-prod.yaml --set image.registry=r,image.tag=t)
grep -q 'kind: ExternalSecret' <<<"$out"
! grep -q 'kind: Secret$' <<<"$out"
grep -q 'readOnlyRootFilesystem: true' <<<"$out"
# I12: api Deployment's migrate initContainer and api container, the purge
# CronJob and the ui Deployment must all run with a read-only root filesystem.
[ "$(grep -c 'readOnlyRootFilesystem: true' <<<"$out")" -ge 4 ]
# N2/N3: secret.yaml and externalsecret.yaml must be plain release resources —
# no helm.sh/hook annotations. A hook Secret/ExternalSecret is deleted at the
# end of the first upgrade of a release installed from the previous chart
# (hooks live outside Release.Manifest, so Helm's diff drops the "old" plain
# resource), and with before-hook-creation + ESO creationPolicy: Owner it was
# destroyed and re-synced on every upgrade.
! grep -q 'helm.sh/hook' <<<"$out"
! (grep -A20 'kind: Secret$' <<<"$out" | grep -q 'helm.sh/hook')
! (grep -A20 'kind: ExternalSecret' <<<"$out" | grep -q 'helm.sh/hook')
# N2/N3: migrations run as an initContainer on the api Deployment, not a
# pre-upgrade hook Job.
! grep -q 'kind: Job' <<<"$out"
grep -q 'initContainers:' <<<"$out"
grep -q 'dist/cli/migrate.mjs' <<<"$out"
# I3: JWT_PREVIOUS_PUBLIC_KEY is only populated during key rotation, so its
# secretKeyRef must be optional.
grep -q 'key: JWT_PREVIOUS_PUBLIC_KEY, optional: true' <<<"$out"
grep -q 'path: /readyz' <<<"$out"
grep -q 'idle_timeout.timeout_seconds=3600' <<<"$out"
# Phase 3 SSE: the ALB must hold a stream open for an hour, and nginx must neither buffer it
# nor time it out at the 60s it uses for ordinary /api calls.
grep -q 'proxy_buffering off' ../../nginx/default.conf.template
grep -q 'proxy_read_timeout 3600s' ../../nginx/default.conf.template
grep -q 'location /api/v1/events' ../../nginx/default.conf.template
# I9: the ServiceMonitor's spec.selector matches Service metadata labels, so
# the api Service itself (not just the ServiceMonitor) must carry
# app.kubernetes.io/component: api or the monitor selects zero Services.
grep -A4 '# Source: rch/templates/api-service.yaml' <<<"$out" | grep -q 'component: api'
grep -A3 'kind: ServiceMonitor' <<<"$out" | grep -q 'component: api'
# C1: secret values must never be inlined as plaintext env `value:` entries —
# always sourced via secretKeyRef, on both the prod (ExternalSecret) and
# staging (Secret) paths.
! (grep -A2 'name: JWT_PRIVATE_KEY' <<<"$out" | grep -q 'value:')
! (grep -A2 'name: DATABASE_URL' <<<"$out" | grep -q 'value:')
grep -q 'secretKeyRef' <<<"$out"
# I: the api Deployment's migrate initContainer and its api container both
# build their env from rch.envList (see _helpers.tpl) so they can never drift.
# Guard the invariant directly: the secretKeyRef lines in each container's env
# block must be identical, in the same order.
init_secrets=$(sed -n '/name: migrate$/,/name: api$/p' <<<"$out" | grep 'secretKeyRef')
api_secrets=$(sed -n '/name: api$/,/readinessProbe:/p' <<<"$out" | grep 'secretKeyRef')
[ -n "$init_secrets" ]
[ "$init_secrets" = "$api_secrets" ]

out=$(helm template rch . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x)
grep -q 'kind: Secret' <<<"$out"
! grep -q 'helm.sh/hook' <<<"$out"
! grep -q 'kind: Job' <<<"$out"
grep -q 'initContainers:' <<<"$out"
grep -q 'dist/cli/migrate.mjs' <<<"$out"
! (grep -A2 'name: JWT_PRIVATE_KEY' <<<"$out" | grep -q 'value:')
! (grep -A2 'name: DATABASE_URL' <<<"$out" | grep -q 'value:')
grep -q 'secretKeyRef' <<<"$out"

echo "chart renders"
