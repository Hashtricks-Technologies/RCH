#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# `! command` does NOT trip `set -e` - bash explicitly exempts a command whose exit status is
# inverted with a leading `!` (see `set -e`'s own documentation of what it does not catch), so
# every assertion below that used to read `! grep -q PATTERN <<<"$out"` would silently pass even
# when PATTERN was present: the script kept going instead of failing. `refute` is `set -e`-safe -
# it runs its argument list as a command and exits 1 itself if that command succeeds (a match).
refute() { if "$@"; then echo "FAIL: unexpected match - $*" >&2; exit 1; fi; }

# The six required keys of a values-built Secret (templates/secret.yaml), as dummies for every
# staging and dev render below. JWT_PREVIOUS_PUBLIC_KEY is the seventh and may be empty.
secret_set="secrets.values.DATABASE_URL=x,secrets.values.MIGRATE_DATABASE_URL=x,secrets.values.AUDIT_DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x,secrets.values.SEED_PASSWORD=x"

helm lint . -f values-staging.yaml --set "image.registry=r,image.tag=t,$secret_set"
helm lint . -f values-prod.yaml --set image.registry=r,image.tag=t

out=$(helm template rch . -f values-prod.yaml --set image.registry=r,image.tag=t)
# B1: nothing in this repo installs the Prometheus Operator, so its CRDs may simply not exist in
# the target cluster - and `helm upgrade --atomic` that meets an unknown kind fails and, being
# atomic, rolls the whole release back to nothing. Both monitoring templates are therefore gated
# on the API group actually being present as well as on serviceMonitor.enabled. `helm template`
# without --api-versions is the cluster that has no operator; with it, the cluster that has one.
out_mon=$(helm template rch . -f values-prod.yaml --set image.registry=r,image.tag=t --api-versions monitoring.coreos.com/v1)
refute grep -q 'kind: ServiceMonitor' <<<"$out"
refute grep -q 'kind: PrometheusRule' <<<"$out"
grep -q 'kind: ServiceMonitor' <<<"$out_mon"
grep -q 'kind: PrometheusRule' <<<"$out_mon"
# B2: kube-prometheus-stack's Prometheus picks up ServiceMonitors AND PrometheusRules by a
# `release` label. The ServiceMonitor has always carried it; a PrometheusRule without it is
# applied happily and then loaded by nothing, which looks exactly like an alert that never fires.
# Two ServiceMonitors (api, audit) and the one PrometheusRule.
[ "$(grep -c 'release: kube-prometheus-stack' <<<"$out_mon")" -ge 3 ]
# ...and every runbook link must be a URL somebody woken at three in the morning can open, not
# the chart's own <org>/<repo> placeholder.
refute grep -Eq 'runbook_url: .*<' <<<"$out_mon"
grep -q 'kind: ExternalSecret' <<<"$out"
refute grep -q 'kind: Secret$' <<<"$out"
grep -q 'readOnlyRootFilesystem: true' <<<"$out"
# I12: api Deployment's migrate initContainer and api container, the purge
# CronJob, the ui Deployment and the audit Deployment's audit-migrate initContainer and audit
# container must all run with a read-only root filesystem.
[ "$(grep -c 'readOnlyRootFilesystem: true' <<<"$out")" -ge 6 ]
# N2/N3: secret.yaml and externalsecret.yaml must be plain release resources -
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
# B4: the ALB's own health check must read /readyz too, not /healthz. /healthz answers 200 for as
# long as the process exists - including the whole of a drain - so a pod that has already stopped
# accepting still looks healthy to the load balancer and keeps being sent requests.
grep -qE 'healthcheck-path: "?/readyz"?' <<<"$out"
refute grep -q 'healthcheck-path: "*/healthz' <<<"$out"
# ...and the target group must drain rather than cut: 30s for connections already in flight to
# this pod to finish after it is deregistered.
grep -q 'deregistration_delay.timeout_seconds=30' <<<"$out"
# The grace period has to be longer than the shutdown it is granting. apps/api/src/server.ts waits
# 30s for this pod to leave the Endpoints and the target group, then gives itself 25s to drain -
# 55s - and the kubelet SIGKILLs whatever is left when this elapses. 30s (the old value) killed
# the pod exactly as its own drain timer fired. The wait is 30 and not less because the
# deregistration delay above may never outlast it: a pod that stops accepting while the target
# group is still draining into it cuts the very requests that delay exists to let finish.
grep -q 'terminationGracePeriodSeconds: 60' <<<"$out"
grep -q 'idle_timeout.timeout_seconds=3600' <<<"$out"
# Phase 3 SSE: the ALB must hold a stream open for an hour, and nginx must neither buffer it
# nor time it out at the 60s it uses for ordinary /api calls.
grep -q 'proxy_buffering off' ../../nginx/default.conf.template
grep -q 'proxy_read_timeout 3600s' ../../nginx/default.conf.template
grep -q 'location /api/v1/events' ../../nginx/default.conf.template
# The ALB's healthcheck-path is an INGRESS-level annotation, so the controller applies it to every
# target group the ingress makes - the ui's as well as the api's. nginx must therefore serve
# /readyz itself: without it the check fell through to the SPA catch-all and passed on index.html,
# a 200 that says nothing about nginx.
grep -q 'location = /readyz' ../../nginx/default.conf.template
# The security headers must reach index.html and the assets. nginx inherits add_header only into a
# location that sets none of its own, and `/` and `/assets/` each set Cache-Control - so for a long
# time they served every page with no CSP. Each such block must include the snippet itself.
tpl=../../nginx/default.conf.template
for loc in 'location \/ {' 'location \/assets\/ {'; do
  block=$(sed -n "/$loc/,/^  }/p" "$tpl")
  grep -q '^ *include /etc/nginx/rch/security-headers.conf;' <<<"$block" \
    || { echo "FAIL: nginx '$loc' sets its own add_header but does not include security-headers.conf"; exit 1; }
done
grep -q '^ *include /etc/nginx/rch/security-headers.conf;' <(sed -n '/^server {/,/location = \/healthz/p' "$tpl")
grep -q '^COPY deploy/nginx/snippets/ /etc/nginx/rch/$' ../../../UI/Dockerfile \
  || { echo "FAIL: UI/Dockerfile must copy deploy/nginx/snippets to /etc/nginx/rch/"; exit 1; }
# The QR ordering page: its own CSP, admitting Razorpay Checkout, and index.html served from its own
# block - a trailing `/index.html` fallback would redirect into `location /` and its staff CSP.
order_block=$(sed -n '/location \/order\/ {/,/^  }/p' "$tpl")
grep -q '^ *include /etc/nginx/rch/order-security-headers.conf;' <<<"$order_block"
grep -q 'try_files \$uri /index.html =404;' <<<"$order_block"
grep -q 'script-src .*https://checkout.razorpay.com' ../../nginx/snippets/order-security-headers.conf
grep -q 'frame-src https://api.razorpay.com' ../../nginx/snippets/order-security-headers.conf
grep -q "frame-ancestors 'self'" ../../nginx/snippets/order-security-headers.conf
refute grep -q 'razorpay' ../../nginx/snippets/security-headers.conf
grep -q 'location = /healthz' ../../nginx/default.conf.template
# ...and it must forward the client on, like /api/ does: the API trusts one hop, so a stream
# without X-Forwarded-For is rate-limited and logged as nginx itself.
events_block=$(sed -n '/location \/api\/v1\/events/,/^  }/p' ../../nginx/default.conf.template)
grep -q 'proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for' <<<"$events_block"
grep -q 'proxy_set_header X-Request-Id \$req_id' <<<"$events_block"
# B7: ...and the id it forwards is the browser's own, not one nginx minted over the top of it.
# The map keeps what arrived and mints only for a request that carried nothing.
grep -q 'map \$http_x_request_id \$req_id' ../../nginx/default.conf.template
refute grep -q 'proxy_set_header X-Request-Id \$request_id' ../../nginx/default.conf.template
# I9: the ServiceMonitor's spec.selector matches Service metadata labels, so
# the api Service itself (not just the ServiceMonitor) must carry
# app.kubernetes.io/component: api or the monitor selects zero Services.
grep -A4 '# Source: rch/templates/api-service.yaml' <<<"$out" | grep -q 'component: api'
grep -A3 'kind: ServiceMonitor' <<<"$out_mon" | grep -q 'component: api'
# C1: secret values must never be inlined as plaintext env `value:` entries -
# always sourced via secretKeyRef, on both the prod (ExternalSecret) and
# staging (Secret) paths.
refute bash -c 'grep -A2 "name: JWT_PRIVATE_KEY" <<<"$1" | grep -q "value:"' _ "$out"
refute bash -c 'grep -A2 "name: DATABASE_URL" <<<"$1" | grep -q "value:"' _ "$out"
grep -q 'secretKeyRef' <<<"$out"
# I: the api Deployment's migrate initContainer and its api container build their env from the
# same rch.env helper (see _helpers.tpl), so they can never drift - with exactly two deliberate
# differences. The initContainer carries MIGRATE_DATABASE_URL, the superuser it migrates and
# creates rch_app with; the api container, which serves every request, must not. And only the api
# container reads the three RAZORPAY_* keys: no CLI talks to the payment gateway. Guard both: the
# api's secretKeyRef lines less the Razorpay ones are the initContainer's less MIGRATE_DATABASE_URL,
# in the same order.
init_secrets=$(sed -n '/name: migrate$/,/name: api$/p' <<<"$out" | grep 'secretKeyRef')
api_secrets=$(sed -n '/name: api$/,/readinessProbe:/p' <<<"$out" | grep 'secretKeyRef')
[ -n "$init_secrets" ]
[ "$(grep -c 'key: MIGRATE_DATABASE_URL' <<<"$init_secrets")" = 1 ] || { echo "the api migrate initContainer has no MIGRATE_DATABASE_URL secretKeyRef"; exit 1; }
refute grep -q 'key: MIGRATE_DATABASE_URL' <<<"$api_secrets"
[ "$(grep -v 'key: MIGRATE_DATABASE_URL' <<<"$init_secrets")" = "$(grep -v 'key: RAZORPAY_' <<<"$api_secrets")" ]
grep -q 'key: DATABASE_URL' <<<"$api_secrets"
# The purge CronJob is an operator CLI, so it connects as the superuser like the migrate step.
cronjob_env=$(sed -n '/# Source: rch\/templates\/purge-cronjob.yaml/,/^---$/p' <<<"$out")
grep -q 'key: MIGRATE_DATABASE_URL' <<<"$cronjob_env"
refute grep -q 'RAZORPAY_' <<<"$cronjob_env"

# The audit service (apps/audit): its own image, its own migrate initContainer, its own port.
audit_dep=$(sed -n '/# Source: rch\/templates\/audit-deployment.yaml/,/^---$/p' <<<"$out")
[ -n "$audit_dep" ] || { echo "no audit Deployment rendered"; exit 1; }
grep -q 'name: rch-audit,' <<<"$audit_dep"
grep -q 'image: r/rch-audit:t' <<<"$audit_dep"
grep -q 'name: audit-migrate$' <<<"$audit_dep"
sed -n '/name: audit-migrate$/,/name: audit$/p' <<<"$audit_dep" | grep -q 'args: \["dist/cli/migrate.mjs"\]'
grep -q 'containerPort: 3100' <<<"$audit_dep"
grep -q 'automountServiceAccountToken: false' <<<"$audit_dep"
grep -A4 '# Source: rch/templates/audit-service.yaml' <<<"$out" | grep -q 'component: audit'
# ...and least privilege for it: the audit containers verify tokens with the public keys and read
# their own role's URL. Neither ever holds the signing key, the seed password or the API's
# DATABASE_URL, and only the initContainer holds the superuser URL.
audit_init_env=$(sed -n '/name: audit-migrate$/,/name: audit$/p' <<<"$audit_dep")
audit_env=$(sed -n '/name: audit$/,/readinessProbe:/p' <<<"$audit_dep")
for k in MIGRATE_DATABASE_URL AUDIT_DATABASE_URL JWT_PUBLIC_KEY; do
  grep -q "key: $k" <<<"$audit_init_env" || { echo "audit-migrate has no $k secretKeyRef"; exit 1; }
done
for k in AUDIT_DATABASE_URL JWT_PUBLIC_KEY; do
  grep -q "key: $k" <<<"$audit_env" || { echo "the audit container has no $k secretKeyRef"; exit 1; }
done
grep -q 'key: JWT_PREVIOUS_PUBLIC_KEY, optional: true' <<<"$audit_env"
for block in "$audit_init_env" "$audit_env"; do
  refute grep -q 'JWT_PRIVATE_KEY' <<<"$block"
  refute grep -q 'SEED_PASSWORD' <<<"$block"
  refute grep -q 'key: DATABASE_URL' <<<"$block"
done
refute grep -q 'MIGRATE_DATABASE_URL' <<<"$audit_env"
grep -q 'name: PORT' <<<"$audit_env"
grep -A1 'name: PORT' <<<"$audit_env" | grep -q 'value: "3100"'

# D1: SEED_PASSWORD is a Secret key, not an api.env entry. apps/api/src/config.ts has no default
# for it, so a rendered pod that does not carry it cannot start at all - and it must arrive the
# same way every other secret does, never as a plaintext `value:`.
seed_ref() { sed -n "$1" <<<"$out" | grep -c 'key: SEED_PASSWORD' || true; }
[ "$(seed_ref '/name: migrate$/,/name: api$/p')" = 1 ] || { echo "migrate initContainer has no SEED_PASSWORD secretKeyRef"; exit 1; }
[ "$(seed_ref '/name: api$/,/readinessProbe:/p')" = 1 ] || { echo "api container has no SEED_PASSWORD secretKeyRef"; exit 1; }
refute bash -c 'grep -A2 "name: SEED_PASSWORD" <<<"$1" | grep -q "value:"' _ "$out"
# ...and it is NOT optional. `if eq $k "a" "b"` is true for either name (Go's eq is variadic),
# so one careless second argument in _helpers.tpl makes this key optional and lets a pod come up
# with no seed password at all - which is the whole thing this key exists to prevent.
refute grep -q 'key: SEED_PASSWORD, optional' <<<"$out"

# Phase 6: the five service alerts, the SSE listener and (B6) the crash loop ship with the chart, so
# the alert text lives beside the metric it reads instead of only in the runbook.
grep -q 'kind: PrometheusRule' <<<"$out_mon"
for a in RchApiHigh5xxRate RchApiHighLatencyP95 RchApiDown RchApiPoolSaturated RchSseListenerDown RchApiCrashLooping AuditDrainLagging AuditDeadLetters; do
  grep -q "alert: $a" <<<"$out_mon" || { echo "missing alert: $a"; exit 1; }
done
# Every rule must name a metric the API actually publishes. `sse_listener_up` and
# `http_request_duration_seconds` are decorated in apps/api/src/plugins/metrics.ts; an alert on a
# metric that does not exist is an alert that never fires, which is worse than no alert.
grep -q 'http_request_duration_seconds_count' <<<"$out_mon"
grep -q 'sse_listener_up' <<<"$out_mon"
# ...with one deliberate exception, named as such: a pod that is restarting cannot report on
# itself, so the crash-loop alert reads kube-state-metrics instead of this API's own registry.
grep -q 'kube_pod_container_status_restarts_total' <<<"$out_mon"
# The audit alerts read the audit service's own registry (apps/audit/src/plugins/metrics.ts),
# scraped by its own ServiceMonitor under job rch-audit.
grep -q 'audit_drain_lag_seconds{job="rch-audit"}' <<<"$out_mon"
grep -q 'audit_dead_letters_total{job="rch-audit"}' <<<"$out_mon"
grep -A3 'name: rch-audit, labels: { release:' <<<"$out_mon" | grep -q 'component: audit'
# Every alert carries a runbook link, so whoever is woken has somewhere to go.
[ "$(grep -c 'runbook_url:' <<<"$out_mon")" -ge 8 ]

# TLS must be wired, and must never render as an EMPTY annotation - the ALB controller reads
# `certificate-arn: ""` and fails, where an absent annotation falls back cleanly. B5 merged the
# certificate into the annotations map so the general empty-value rule covers it, and the
# assertion still has to hold in BOTH states: nothing rendered with the FILL placeholder in
# place, and the real value rendered once one is supplied.
refute grep -q 'certificate-arn: *$' <<<"$out"
out_tls=$(helm template rch . -f values-prod.yaml --set image.registry=r,image.tag=t,ingress.certificateArn=arn:aws:acm:x)
grep -qE 'alb.ingress.kubernetes.io/certificate-arn: "?arn:aws:acm:x"?' <<<"$out_tls"
# B5: the rule above is now the general one - every annotation is ranged and an empty value is
# skipped, certificateArn included. NOTHING under the Ingress may render with an empty value:
# the ALB controller reads `wafv2-acl-arn: ""` as a WAF ARN it cannot resolve rather than as
# "no WAF", and leaves the ingress in a failed state, where an absent annotation falls back.
ing_ann=$(sed -n '/# Source: rch\/templates\/ingress.yaml/,/^spec:/p' <<<"$out" | sed -n '/^  annotations:/,/^spec:/p' | grep -E '^    [^ ]')
[ -n "$ing_ann" ]
refute grep -Eq ':[[:space:]]*("")?[[:space:]]*$' <<<"$ing_ann"
refute grep -q 'wafv2-acl-arn' <<<"$out"
# The access-log bucket is not created by anything yet (deploy/cfn's AlbLogsBucketName will), and
# an ALB told to write to a bucket that is not there fails to provision at all.
refute grep -q 'access_logs.s3' <<<"$out"
# A folded `>-` block joins its lines with a space, so the controller parsed the second attribute
# onwards as a name beginning with a space. One line.
refute grep -Eq 'load-balancer-attributes: .*, ' <<<"$out"
grep -q 'deletion_protection.enabled=true' <<<"$out"
grep -q 'name: DB_POOL_MAX' <<<"$out"
# B6: the ConfigMap had no reader at all - rch.envList inlines every one of these values into
# each container's own env list - so the pod annotation that claimed to checksum it was hashing
# a template nothing consumed. Hash what the pods actually read, and drop the ConfigMap.
refute grep -q 'kind: ConfigMap' <<<"$out"
grep -q 'checksum/config:' <<<"$out"
# OTEL_EXPORTER_OTLP_ENDPOINT is read by no code in this repo.
refute grep -q 'OTEL_EXPORTER_OTLP_ENDPOINT' <<<"$out"
# V8 sizes its old space from the machine's memory, not the cgroup's, so without a ceiling the
# kernel OOM-kills the pod before Node ever decides a collection is due. 70% of the limit.
grep -q 'max-old-space-size=716' <<<"$out"
# Nothing in any of these four pods reads the Kubernetes API, so none of them needs a token
# mounted into it: api Deployment, audit Deployment, ui Deployment, purge CronJob.
[ "$(grep -c 'automountServiceAccountToken: false' <<<"$out")" = 4 ]
# The nightly purge: bounded history, a deadline on a run that was missed (past 100 missed
# schedules the controller stops firing the CronJob for good), a bounded retry, a hard stop, and
# the same pod securityContext the api pod runs under.
grep -q 'successfulJobsHistoryLimit: 3' <<<"$out"
grep -q 'failedJobsHistoryLimit: 3' <<<"$out"
grep -q 'startingDeadlineSeconds: 600' <<<"$out"
grep -q 'backoffLimit: 2' <<<"$out"
grep -q 'activeDeadlineSeconds: 1800' <<<"$out"
cronjob=$(sed -n '/# Source: rch\/templates\/purge-cronjob.yaml/,/^---$/p' <<<"$out")
[ -n "$cronjob" ]
grep -q 'seccompProfile' <<<"$cronjob"
grep -q 'fsGroup: 65532' <<<"$cronjob"
# B6: default-deny ingress over everything this release runs, plus the three doors the chart
# needs (api, audit, ui).
[ "$(grep -c 'kind: NetworkPolicy' <<<"$out")" = 4 ]
np=$(sed -n '/# Source: rch\/templates\/networkpolicy.yaml/,/# Source: rch\/templates\/[^n]/p' <<<"$out")
[ -n "$np" ]
# The deny is a deny: policyTypes names Ingress and the rule list is empty, which is how "nothing
# reaches these pods" is spelled. Without the empty list the policy selects the release and allows
# everything, which reads the same in a diff and is the opposite.
grep -q 'ingress: \[\]' <<<"$np"
# The ALB reaches pod IPs directly (target-type: ip) and the kubelet probes from the node, so the
# serving port of each component is open to a CIDR rather than to a selector - and to NOTHING
# else. Closing the ui's 8080 closes the site. The CIDR itself is NOT pinned here: narrowing
# networkPolicy.albSourceCidr to a VPC range is the intended change and must not fail this test.
grep -qE 'cidr: [0-9]' <<<"$np"
grep -q 'port: 3000' <<<"$np"
grep -q 'port: 8080' <<<"$np"
grep -q 'port: 3100' <<<"$np"
grep -q 'kubernetes.io/metadata.name: monitoring' <<<"$np"
# The ui->api hop is allowed by selector, not only by the CIDR that happens to cover it today -
# so the day albSourceCidr stops covering the pod network, nginx can still reach the API. The
# leading `- ` is what distinguishes this `from:` entry from the ui policy's own target selector.
grep -qE '^ +- podSelector: \{ matchLabels: \{ app\.kubernetes\.io/instance: rch, app\.kubernetes\.io/component: ui \} \}' <<<"$np"
# ...and the ui->audit hop the same way: nginx proxies /api/v1/admin/audit to the audit Service.
audit_np=$(sed -n '/name: rch-audit, labels:/,/^---$/p' <<<"$np")
grep -qE '^ +- podSelector: \{ matchLabels: \{ app\.kubernetes\.io/instance: rch, app\.kubernetes\.io/component: ui \} \}' <<<"$audit_np"
grep -q 'port: 3100' <<<"$audit_np"
# Egress is left open on purpose: RDS is outside the cluster at an address this chart never sees.
grep -q 'egress: \[{}\]' <<<"$np"
out_nonp=$(helm template rch . -f values-prod.yaml --set image.registry=r,image.tag=t,networkPolicy.enabled=false)
refute grep -q 'kind: NetworkPolicy' <<<"$out_nonp"
# Three replicas that land on one node make the PodDisruptionBudget decorative.
grep -q 'topologySpreadConstraints' <<<"$out"
# ...and so is the spread itself unless production's pods can only land on ng-prod, the
# on-demand node group (deploy/eksctl/cluster.yaml). All three Deployments must carry the selector;
# the group is deliberately untainted, so the label is the whole mechanism.
[ "$(grep -c 'rch.io/tier: prod' <<<"$out")" = 3 ]
# ...and the label the render asks for has to exist on a node group somebody can actually create.
# Nothing in this chart creates one: `eksctl create nodegroup -f deploy/eksctl/cluster.yaml
# --include=ng-prod` does, and RUNBOOK §11 has it as a numbered step before the promotion. The
# failure this closes is silent on both sides - a label renamed here or there leaves three
# replicas Pending for ever, and production upgrades without `--atomic`, so nothing rolls back.
prod_selector=$(sed -n 's/^ *\(rch\.io\/tier: [a-z0-9.-]*\) *$/\1/p' <<<"$out" | sort -u)
# `grep -c .`, not `wc -l`: BSD wc pads its answer with spaces, so `[ "$(wc -l …)" = 1 ]` is
# false on macOS for a one-line answer and this whole check would fail on every developer's box.
[ "$(grep -c . <<<"$prod_selector")" = 1 ] || { echo "values-prod.yaml renders more than one node selector: $prod_selector"; exit 1; }
# The `labels:` anchor matters: cluster.yaml's prose also quotes the label, and a comment is not
# a node group. Only a `labels:` line carrying the selector proves the pods have somewhere to go.
grep -qE "^[[:space:]]*labels:.*${prod_selector}" ../../eksctl/cluster.yaml \
  || { echo "no node group's labels: line in deploy/eksctl/cluster.yaml carries $prod_selector - production's pods would stay Pending"; exit 1; }

# B3: all three Deployments get a PodDisruptionBudget, and all say maxUnavailable rather than
# minAvailable - `minAvailable: N` at N replicas is a budget a drain can never satisfy, so
# `kubectl drain` waits on it for good, where `maxUnavailable: 1` stays satisfiable at every
# replica count above one.
[ "$(grep -c 'kind: PodDisruptionBudget' <<<"$out")" = 3 ]
grep -A4 '# Source: rch/templates/api-pdb.yaml' <<<"$out" | grep -q 'maxUnavailable: 1'
grep -A4 '# Source: rch/templates/audit-pdb.yaml' <<<"$out" | grep -q 'maxUnavailable: 1'
grep -A4 '# Source: rch/templates/ui-pdb.yaml' <<<"$out" | grep -q 'maxUnavailable: 1'
refute grep -q 'minAvailable' <<<"$out"
# Production resources must be its own, not staging's inherited defaults. `-A6` never reaches
# `resources:` (the api container is `- name: api` and resources is nine lines below it), which
# is why the file's existing tests use a sed range - copy that shape, not a fixed window.
sed -n '/name: api$/,/readinessProbe:/p' <<<"$out" | grep -q 'memory: 1Gi'

# The alerts are off wherever the ServiceMonitor is off: a PrometheusRule with no Prometheus
# Operator installed is a CRD apply that fails the whole release.
out_staging_norule=$(helm template rch . -f values-staging.yaml --set "image.registry=r,image.tag=t,$secret_set")
refute grep -q 'kind: PrometheusRule' <<<"$out_staging_norule"

out=$(helm template rch . -f values-staging.yaml --set "image.registry=r,image.tag=t,$secret_set")
grep -q 'kind: Secret' <<<"$out"
refute grep -q 'helm.sh/hook:' <<<"$out"
refute grep -q 'kind: Job' <<<"$out"
grep -q 'initContainers:' <<<"$out"
grep -q 'dist/cli/migrate.mjs' <<<"$out"
refute bash -c 'grep -A2 "name: JWT_PRIVATE_KEY" <<<"$1" | grep -q "value:"' _ "$out"
refute bash -c 'grep -A2 "name: DATABASE_URL" <<<"$1" | grep -q "value:"' _ "$out"
grep -q 'secretKeyRef' <<<"$out"
# D1 again, on the staging path: the Secret is built from values here rather than synced, but
# both containers still read the seed password out of it and never as a plaintext value.
[ "$(seed_ref '/name: migrate$/,/name: api$/p')" = 1 ] || { echo "staging migrate initContainer has no SEED_PASSWORD secretKeyRef"; exit 1; }
[ "$(seed_ref '/name: api$/,/readinessProbe:/p')" = 1 ] || { echo "staging api container has no SEED_PASSWORD secretKeyRef"; exit 1; }
refute bash -c 'grep -A2 "name: SEED_PASSWORD" <<<"$1" | grep -q "value:"' _ "$out"
refute grep -q 'key: SEED_PASSWORD, optional' <<<"$out"
# Staging carries the same `certificateArn` FILL as production, and must behave the same way with
# it empty: no annotation at all rather than `certificate-arn: ""`, which the ALB controller
# rejects. Staging had no such key until the Phase 6 fix wave, which is why it needs its own line.
refute grep -q 'certificate-arn: *$' <<<"$out"
out_staging_tls=$(helm template rch . -f values-staging.yaml --set "image.registry=r,image.tag=t,$secret_set,ingress.certificateArn=arn:aws:acm:y")
grep -qE 'alb.ingress.kubernetes.io/certificate-arn: "?arn:aws:acm:y"?' <<<"$out_staging_tls"
# The pool size is an env knob now, not a literal in db/client.ts. Both files set it, and the
# api container reads it - a rendered pod without it is one silently back on the code's default.
grep -q 'name: DB_POOL_MAX' <<<"$out"

# Item photos: the api container must read where its image store is and which bucket to use -
# without either the process refuses to start in production (config.ts).
grep -q 'name: IMAGE_STORE' <<<"$out"
grep -q 'name: IMAGE_BUCKET' <<<"$out"

# D-min: on the `secrets.create=true` path a missing key must fail the render, not produce a
# Secret carrying "". values.yaml declares all seven as "" so the shape is documented, and an
# empty string is not a missing key - the pod starts, config.ts refuses it and the migrate
# initContainer crash-loops. Production upgrades without `--atomic` (RUNBOOK §3), so that leaves
# the release in `pending-install`. Six of the seven are required; JWT_PREVIOUS_PUBLIC_KEY is
# empty until the first rotation and must still render.
for key in DATABASE_URL MIGRATE_DATABASE_URL AUDIT_DATABASE_URL JWT_PRIVATE_KEY JWT_PUBLIC_KEY SEED_PASSWORD; do
  args="image.registry=r,image.tag=t,$secret_set"
  missing=$(helm template rch . -f values-staging.yaml --set "${args//secrets.values.$key=x/secrets.values.$key=}" 2>&1) && {
    echo "FAIL: the chart rendered a Secret with an empty $key"; exit 1; }
  grep -q "secrets.values.$key is empty" <<<"$missing" \
    || { echo "FAIL: an empty $key must be refused by name; got: $missing"; exit 1; }
done
# ...and the one that may be empty still renders.
helm template rch . -f values-staging.yaml --set "image.registry=r,image.tag=t,$secret_set,secrets.values.JWT_PREVIOUS_PUBLIC_KEY=" >/dev/null
# QR ordering's three Razorpay keys are optional (RUNBOOK §19). Left empty the render passes and
# keeps them out of the Secret, so their optional secretKeyRefs leave the variable unset rather
# than an empty string; set, each is in the Secret. Only the api container reads them - not its
# migrate initContainer, not the purge CronJob, and neither audit container.
rzp_secret=$(helm template rch . -f values-staging.yaml --set "image.registry=r,image.tag=t,$secret_set" --show-only templates/secret.yaml)
refute grep -q 'RAZORPAY_' <<<"$rzp_secret"
rzp_secret=$(helm template rch . -f values-staging.yaml --set "image.registry=r,image.tag=t,$secret_set,secrets.values.RAZORPAY_KEY_ID=k,secrets.values.RAZORPAY_KEY_SECRET=s,secrets.values.RAZORPAY_WEBHOOK_SECRET=w" --show-only templates/secret.yaml)
for k in RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET; do
  grep -q "^  $k: " <<<"$rzp_secret" || { echo "FAIL: a filled $k must reach the Secret"; exit 1; }
  grep -q "key: $k, optional: true" <<<"$api_secrets" \
    || { echo "FAIL: the api container must read $k, optionally"; exit 1; }
  refute grep -q "key: $k" <<<"$init_secrets"
done
refute bash -c 'sed -n "/# Source: rch\/templates\/audit-deployment.yaml/,/^---/p" <<<"$1" | grep -q RAZORPAY_' _ "$out"
# ...and one or two of the three is refused at render time, naming what was set: the API refuses a
# partial set at start-up (config.ts), so rendering it would only make a crash-looping pod.
for partial in "RAZORPAY_KEY_ID=k" "RAZORPAY_KEY_ID=k,secrets.values.RAZORPAY_KEY_SECRET=s" "RAZORPAY_WEBHOOK_SECRET=w"; do
  bad=$(helm template rch . -f values-staging.yaml --set "image.registry=r,image.tag=t,$secret_set,secrets.values.$partial" 2>&1) && {
    echo "FAIL: the chart rendered a partial Razorpay key set ($partial)"; exit 1; }
  grep -q "but not all three Razorpay keys" <<<"$bad" \
    || { echo "FAIL: a partial Razorpay key set must be refused by name; got: $bad"; exit 1; }
done
# ...and those four are the only optional keys anywhere: a fifth would be a secret a pod may start
# without, and every other one is required.
[ "$(grep -o 'key: [A-Z_]*, optional: true' <<<"$out" | sort -u | sed 's/key: //; s/, optional: true//' | tr '\n' ' ')" \
  = "JWT_PREVIOUS_PUBLIC_KEY RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET " ] \
  || { echo "FAIL: the optional secret keys must be exactly JWT_PREVIOUS_PUBLIC_KEY and the three RAZORPAY_* keys"; exit 1; }

# ng-prod is production's alone: staging sets no nodeSelector, so its pods keep landing on the
# spot node they share with dev, and `with` must render nothing rather than an empty map.
refute grep -q 'nodeSelector' <<<"$out"

# The UI's nginx proxies /api to the API Service by its FULL cluster name (nginx's resolver
# ignores search domains; a short name 502s inside the cluster - found by the Phase 6 smoke).
grep -q 'API_UPSTREAM' <<<"$out" || { echo "ui deployment lost API_UPSTREAM"; exit 1; }
grep -q 'value: http://rch-api.default.svc.cluster.local:3000' <<<"$out" || { echo "API_UPSTREAM must be the API Service's FQDN (<release>-api.<namespace>.svc.cluster.local)"; exit 1; }
refute grep -qE 'API_UPSTREAM, value: http://rch-api:3000' <<<"$out"
# ...and the audit Service the same way, for nginx's /api/v1/admin/audit block.
grep -q 'name: AUDIT_UPSTREAM, value: http://rch-audit.default.svc.cluster.local:3100' <<<"$out" \
  || { echo "AUDIT_UPSTREAM must be the audit Service's FQDN (<release>-audit.<namespace>.svc.cluster.local)"; exit 1; }
grep -q 'location /api/v1/admin/audit' ../../nginx/default.conf.template
grep -q 'set \$audit_upstream \${AUDIT_UPSTREAM};' ../../nginx/default.conf.template
audit_block=$(sed -n '/location \/api\/v1\/admin\/audit/,/^  }/p' ../../nginx/default.conf.template)
grep -q 'proxy_set_header X-Request-Id \$req_id' <<<"$audit_block"
grep -q 'proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for' <<<"$audit_block"
# The image's own default. envsubst leaves an unset variable in the rendered config as a literal,
# nginx starts anyway, and every audit read then fails - so the image has to carry one.
grep -q '^ENV AUDIT_UPSTREAM=http://rch-audit:3100$' ../../../UI/Dockerfile
# The ingress sends the audit reads to the audit Service, and lists them BEFORE /api: the load
# balancer controller turns the paths into rules in order, and /api would otherwise win.
ingress=$(helm template rch . -f values-staging.yaml --set "image.registry=r,image.tag=t,$secret_set" --show-only templates/ingress.yaml)
audit_path=$(grep -n 'path: /api/v1/admin/audit, pathType: Prefix, backend: { service: { name: rch-audit, port: { number: 3100 }' <<<"$ingress" | cut -d: -f1)
api_path=$(grep -n 'path: /api, pathType: Prefix' <<<"$ingress" | cut -d: -f1)
if [ -z "$audit_path" ] || [ -z "$api_path" ] || [ "$audit_path" -ge "$api_path" ]; then
  echo "the ingress must route /api/v1/admin/audit to rch-audit:3100 ahead of /api"; exit 1
fi

# B6: values-dev.yaml is the one environment that actually runs, and until now nothing linted or
# rendered it. Everything below is the dev leg.
dev_args=(--set image.registry=r --set image.tag=t
  --set-string secrets.values.DATABASE_URL=x --set-string secrets.values.MIGRATE_DATABASE_URL=x
  --set-string secrets.values.AUDIT_DATABASE_URL=x --set-string secrets.values.JWT_PRIVATE_KEY=x
  --set-string secrets.values.JWT_PUBLIC_KEY=x --set-string secrets.values.SEED_PASSWORD=x)
helm lint . -f values-dev.yaml "${dev_args[@]}"
out_dev=$(helm template rch . -f values-dev.yaml "${dev_args[@]}")
# B3: one api pod, one audit pod and one ui pod. A PodDisruptionBudget of any shape over a single
# pod means that pod may never be evicted, so the node under it may never be drained - which on a
# one-node spot cluster is every node.
refute grep -q 'kind: PodDisruptionBudget' <<<"$out_dev"
# B6: the heap ceiling is per values file, against that file's own memory limit - dev inherits
# values.yaml's 512Mi, so 358.
grep -q 'max-old-space-size=358' <<<"$out_dev"
refute grep -q 'kind: ConfigMap' <<<"$out_dev"

echo "chart renders"
