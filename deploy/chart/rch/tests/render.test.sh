#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
helm lint . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x
helm lint . -f values-prod.yaml --set image.registry=r,image.tag=t
out=$(helm template rch . -f values-prod.yaml --set image.registry=r,image.tag=t)
grep -q 'kind: ExternalSecret' <<<"$out"
! grep -q 'kind: Secret$' <<<"$out"
grep -q 'readOnlyRootFilesystem: true' <<<"$out"
grep -q 'helm.sh/hook: pre-install,pre-upgrade' <<<"$out"
grep -q 'path: /readyz' <<<"$out"
grep -q 'idle_timeout.timeout_seconds=3600' <<<"$out"
out=$(helm template rch . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x)
grep -q 'kind: Secret' <<<"$out"
echo "chart renders"
