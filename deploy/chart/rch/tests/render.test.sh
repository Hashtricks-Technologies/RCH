#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# `! command` does NOT trip `set -e` — bash explicitly exempts a command whose exit status is
# inverted with a leading `!` (see `set -e`'s own documentation of what it does not catch), so
# every assertion below that used to read `! grep -q PATTERN <<<"$out"` would silently pass even
# when PATTERN was present: the script kept going instead of failing. `refute` is `set -e`-safe —
# it runs its argument list as a command and exits 1 itself if that command succeeds (a match).
refute() { if "$@"; then echo "FAIL: unexpected match — $*" >&2; exit 1; fi; }

helm lint . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x
helm lint . -f values-prod.yaml --set image.registry=r,image.tag=t

out=$(helm template rch . -f values-prod.yaml --set image.registry=r,image.tag=t)
grep -q 'kind: ExternalSecret' <<<"$out"
refute grep -q 'kind: Secret$' <<<"$out"
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
refute grep -q 'helm.sh/hook:' <<<"$out"
refute bash -c 'grep -A20 "kind: Secret\$" <<<"$1" | grep -q "helm.sh/hook"' _ "$out"
refute bash -c 'grep -A20 "kind: ExternalSecret" <<<"$1" | grep -q "helm.sh/hook"' _ "$out"
# N2/N3: migrations run as an initContainer on the api Deployment, not a
# pre-upgrade hook Job.
refute grep -q 'kind: Job' <<<"$out"
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
# ...and it must forward the client on, like /api/ does: the API trusts one hop, so a stream
# without X-Forwarded-For is rate-limited and logged as nginx itself.
events_block=$(sed -n '/location \/api\/v1\/events/,/^  }/p' ../../nginx/default.conf.template)
grep -q 'proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for' <<<"$events_block"
grep -q 'proxy_set_header X-Request-Id \$request_id' <<<"$events_block"
# I9: the ServiceMonitor's spec.selector matches Service metadata labels, so
# the api Service itself (not just the ServiceMonitor) must carry
# app.kubernetes.io/component: api or the monitor selects zero Services.
grep -A4 '# Source: rch/templates/api-service.yaml' <<<"$out" | grep -q 'component: api'
grep -A3 'kind: ServiceMonitor' <<<"$out" | grep -q 'component: api'
# C1: secret values must never be inlined as plaintext env `value:` entries —
# always sourced via secretKeyRef, on both the prod (ExternalSecret) and
# staging (Secret) paths.
refute bash -c 'grep -A2 "name: JWT_PRIVATE_KEY" <<<"$1" | grep -q "value:"' _ "$out"
refute bash -c 'grep -A2 "name: DATABASE_URL" <<<"$1" | grep -q "value:"' _ "$out"
grep -q 'secretKeyRef' <<<"$out"
# I: the api Deployment's migrate initContainer and its api container both
# build their env from rch.envList (see _helpers.tpl) so they can never drift.
# Guard the invariant directly: the secretKeyRef lines in each container's env
# block must be identical, in the same order.
init_secrets=$(sed -n '/name: migrate$/,/name: api$/p' <<<"$out" | grep 'secretKeyRef')
api_secrets=$(sed -n '/name: api$/,/readinessProbe:/p' <<<"$out" | grep 'secretKeyRef')
[ -n "$init_secrets" ]
[ "$init_secrets" = "$api_secrets" ]

# Phase 6: the five §12 alerts plus the SSE listener ship with the chart, so the alert text lives
# beside the metric it reads instead of only in the runbook.
grep -q 'kind: PrometheusRule' <<<"$out"
for a in RchApiHigh5xxRate RchApiHighLatencyP95 RchApiDown RchApiPoolSaturated RchSseListenerDown; do
  grep -q "alert: $a" <<<"$out" || { echo "missing alert: $a"; exit 1; }
done
# Every rule must name a metric the API actually publishes. `sse_listener_up` and
# `http_request_duration_seconds` are decorated in apps/api/src/plugins/metrics.ts; an alert on a
# metric that does not exist is an alert that never fires, which is worse than no alert.
grep -q 'http_request_duration_seconds_count' <<<"$out"
grep -q 'sse_listener_up' <<<"$out"
# Every alert carries a runbook link, so whoever is woken has somewhere to go.
[ "$(grep -c 'runbook_url:' <<<"$out")" -ge 5 ]

# TLS must be wired, and must never render as an EMPTY annotation — the ALB controller reads
# `certificate-arn: ""` and fails, where an absent annotation falls back cleanly.
# `templates/ingress.yaml:7-9` already guards it on a non-empty `certificateArn`, so the
# assertion has to hold in BOTH states: nothing rendered with the FILL placeholder in place,
# and the real value rendered once one is supplied.
refute grep -q 'certificate-arn: *$' <<<"$out"
out_tls=$(helm template rch . -f values-prod.yaml --set image.registry=r,image.tag=t,ingress.certificateArn=arn:aws:acm:x)
grep -q 'alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:x' <<<"$out_tls"
grep -q 'name: DB_POOL_MAX' <<<"$out"
# Three replicas that land on one node make the PodDisruptionBudget decorative.
grep -q 'topologySpreadConstraints' <<<"$out"
# Production resources must be its own, not staging's inherited defaults. `-A6` never reaches
# `resources:` (the api container is `- name: api` and resources is nine lines below it), which
# is why the file's existing tests use a sed range — copy that shape, not a fixed window.
sed -n '/name: api$/,/readinessProbe:/p' <<<"$out" | grep -q 'memory: 1Gi'

# The alerts are off wherever the ServiceMonitor is off: a PrometheusRule with no Prometheus
# Operator installed is a CRD apply that fails the whole release.
out_staging_norule=$(helm template rch . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x)
refute grep -q 'kind: PrometheusRule' <<<"$out_staging_norule"

out=$(helm template rch . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x)
grep -q 'kind: Secret' <<<"$out"
refute grep -q 'helm.sh/hook:' <<<"$out"
refute grep -q 'kind: Job' <<<"$out"
grep -q 'initContainers:' <<<"$out"
grep -q 'dist/cli/migrate.mjs' <<<"$out"
refute bash -c 'grep -A2 "name: JWT_PRIVATE_KEY" <<<"$1" | grep -q "value:"' _ "$out"
refute bash -c 'grep -A2 "name: DATABASE_URL" <<<"$1" | grep -q "value:"' _ "$out"
grep -q 'secretKeyRef' <<<"$out"
# Staging carries the same `certificateArn` FILL as production, and must behave the same way with
# it empty: no annotation at all rather than `certificate-arn: ""`, which the ALB controller
# rejects. Staging had no such key until the Phase 6 fix wave, which is why it needs its own line.
refute grep -q 'certificate-arn: *$' <<<"$out"
out_staging_tls=$(helm template rch . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x,ingress.certificateArn=arn:aws:acm:y)
grep -q 'alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:y' <<<"$out_staging_tls"
# The pool size is an env knob now, not a literal in db/client.ts. Both files set it, and the
# api container reads it — a rendered pod without it is one silently back on the code's default.
grep -q 'name: DB_POOL_MAX' <<<"$out"

echo "chart renders"
