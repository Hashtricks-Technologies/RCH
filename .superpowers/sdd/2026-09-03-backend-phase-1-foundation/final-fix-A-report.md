# Final whole-branch review fixes — deployment area (Helm chart + deploy workflow)

Scope: `deploy/chart/rch/**` and `.github/workflows/deploy.yml` only.

## C1 (Critical) — secrets inlined as plaintext `value:`

`rch.envList` in `deploy/chart/rch/templates/_helpers.tpl` had two branches: `secrets.create`
inlined `.Values.secrets.values` as plaintext `value:` entries; `secrets.externalSecret.enabled`
already used `secretKeyRef`. Rewrote `rch.envList` to drop the branch entirely — the four keys
(`DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY`) are now ALWAYS
emitted as `valueFrom.secretKeyRef` against `{{ include "rch.secretName" . }}` (`<release>-secrets`),
regardless of which template produced the Secret. `secrets.create` now only gates whether
`secret.yaml` renders the Secret object; it no longer affects how containers consume it.

Consumers (api Deployment, migrate Job, purge CronJob) are unaffected structurally — they all
still call `rch.envList` — but now get `secretKeyRef` on every path instead of plaintext values.

**Necessary follow-on fix beyond the literal C1 text**: since secret.yaml previously worked
without needing the Secret to exist before pod start (values were inlined), it had no hook
annotations. Once C1 makes it authoritative via `secretKeyRef`, a first `helm install` with
`secrets.create=true` (staging) would hit the exact same "Secret not yet created when the
pre-install migrate Job runs" ordering bug that I3 describes for the prod ExternalSecret path
— Helm creates plain (non-hook) resources only *after* pre-install hooks finish. Gave
`secret.yaml` the same `pre-install,pre-upgrade` / weight `-5` / `before-hook-creation`
annotations as the ExternalSecret so both secret-producing templates are ordered ahead of the
migrate Job (weight `0`) on both paths. Documented this in `_helpers.tpl`'s `rch.envList` doc
comment.

## I3 (Important) — prod first install ordering + JWT_PREVIOUS_PUBLIC_KEY optionality

`deploy/chart/rch/templates/externalsecret.yaml` now carries:
```
helm.sh/hook: pre-install,pre-upgrade
helm.sh/hook-weight: "-5"
helm.sh/hook-delete-policy: before-hook-creation
```
so it (and the target Secret ESO syncs into it) exists before the migrate Job's weight-`0` hook
runs. Added a comment noting ESO must already be installed cluster-wide.

`JWT_PREVIOUS_PUBLIC_KEY`'s `secretKeyRef` is marked `optional: true` in `rch.envList` (the one
helper used by all three consumers — api Deployment, migrate Job, purge CronJob), since it's
only populated during a key-rotation window.

## I8 (Important) — shell injection / argv exposure in deploy.yml

`.github/workflows/deploy.yml`'s `helm upgrade` step now receives `DATABASE_URL`,
`JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` via the step's `env:` block instead of interpolating
`${{ secrets.* }}` directly into command text. The extra Helm args are built as a bash array
(`EXTRA=(...)`) using `--set-string "secrets.values.KEY=$VAR"` (quoted shell variable
references) rather than a string that gets word-split. Re-validated with:
```
python3 -c 'import yaml,sys;[yaml.safe_load(open(f)) for f in sys.argv[1:]]' .github/workflows/deploy.yml
```
→ `YAML OK`.

## I9 (Important) — ServiceMonitor scraping both api and ui

`deploy/chart/rch/templates/servicemonitor.yaml` selector now includes
`app.kubernetes.io/component: api` alongside `app.kubernetes.io/instance`, so it only matches
the api Service (ui Service shares the instance label and also exposes a port named `http`).

## I12 (Important) — read-only root filesystem / resources gaps

- `migrate-job.yaml` and `purge-cronjob.yaml` containers now have
  `securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }`
  and `resources: { requests: { cpu: 100m, memory: 128Mi }, limits: { cpu: 500m, memory: 256Mi } }`.
- `ui-deployment.yaml` container gets `readOnlyRootFilesystem: true` plus `emptyDir` volumes
  mounted at `/tmp`, `/var/cache/nginx`, `/etc/nginx/conf.d`.
- **Extra fix required to make this actually work**: the pod-level securityContext also now
  sets `fsGroup: 101` and `runAsUser: 101` (nginx-unprivileged's built-in `nginx` uid/gid).
  Verified empirically (see below) that Docker's plain `--tmpfs` mounts on non-`/tmp` paths
  default to `mode=775` owned by `root:root`, which the non-root nginx user (uid 101) cannot
  write into — `20-envsubst-on-templates.sh` fails with "not writable" and nginx starts with
  no server block, so `/healthz` connection-resets. Kubernetes `emptyDir` volumes have the
  analogous problem (default root ownership); the standard fix is pod-level `fsGroup`, which
  makes kubelet chown the volumes to that group. This is why `api-deployment.yaml` already sets
  `fsGroup: 65532` for its own non-root user — `ui-deployment.yaml` was missing the equivalent.

### nginx entrypoint / image investigation
```
$ docker run --rm nginxinc/nginx-unprivileged:1.27-alpine sh -c \
    'cat /docker-entrypoint.d/20-envsubst-on-templates.sh | head -40; grep -n "pid\|_temp_path" /etc/nginx/nginx.conf'
```
Confirms: envsubst writes rendered templates into `/etc/nginx/conf.d` (`NGINX_ENVSUBST_OUTPUT_DIR`
default), and `nginx.conf` sets `pid /tmp/nginx.pid;` plus `proxy_temp_path` / `client_body_temp_path`
/ `fastcgi_temp_path` / `uwsgi_temp_path` / `scgi_temp_path` all under `/tmp`.

### Read-only proof (first attempt — failed, diagnosed the fsGroup gap)
```
$ docker run --rm -d --read-only --tmpfs /tmp --tmpfs /var/cache/nginx --tmpfs /etc/nginx/conf.d -p 8082:8080 rch-ui:x
$ curl -fsS localhost:8082/healthz
curl: (56) Recv failure: Connection reset by peer
```
`docker logs` showed: `20-envsubst-on-templates.sh: ERROR: /etc/nginx/templates exists, but
/etc/nginx/conf.d is not writable`. `docker exec ... ls -la /etc/nginx/conf.d` showed
`drwxrwxr-x root root` (mode 775, no world-write) vs. `/tmp`'s `drwxrwxrwt root root` (mode
1777) — Docker's default tmpfs mode differs by target path. `id` inside the container is
`uid=101(nginx) gid=101(nginx)`, which isn't in the `root` group, so it can't write.

### Read-only proof (corrected — passed)
```
$ docker run --rm -d --read-only \
    --tmpfs /tmp:mode=1777 --tmpfs /var/cache/nginx:mode=1777 --tmpfs /etc/nginx/conf.d:mode=1777 \
    -p 8082:8080 rch-ui:x
$ curl -fsS localhost:8082/healthz
ok
```
Container stopped after the check. This validates the mechanism (writable `/tmp`,
`/var/cache/nginx`, `/etc/nginx/conf.d` are sufficient and necessary); the chart achieves the
same writability via `fsGroup: 101` on Kubernetes `emptyDir` volumes rather than Docker's
`mode=` tmpfs option, since `emptyDir` has no direct mode knob.

## Render-test extensions (`deploy/chart/rch/tests/render.test.sh`)

Added, for the prod render:
- `readOnlyRootFilesystem: true` appears ≥ 4 times.
- The `ExternalSecret` block itself (via `grep -A15 'kind: ExternalSecret'`) carries
  `helm.sh/hook: pre-install,pre-upgrade` and `hook-weight: "-5"`.
- `key: JWT_PREVIOUS_PUBLIC_KEY, optional: true` is present.
- The `ServiceMonitor` block carries `component: api`.
- No `value:` line within 2 lines after `name: JWT_PRIVATE_KEY` or `name: DATABASE_URL`, and
  `secretKeyRef` is present.

Added, for the staging render:
- The (plain, `kind: Secret$`) block itself carries `helm.sh/hook: pre-install,pre-upgrade`.
- Same no-plaintext-`value:` / `secretKeyRef`-present checks as prod.

## Verification

```
$ helm version
version.BuildInfo{Version:"v3.21.4", ...}

$ ./deploy/chart/rch/tests/render.test.sh
==> Linting .
[INFO] Chart.yaml: icon is recommended
1 chart(s) linted, 0 chart(s) failed
==> Linting .
[INFO] Chart.yaml: icon is recommended
1 chart(s) linted, 0 chart(s) failed
chart renders

$ helm lint . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x
1 chart(s) linted, 0 chart(s) failed

$ helm lint . -f values-prod.yaml --set image.registry=r,image.tag=t
1 chart(s) linted, 0 chart(s) failed

$ python3 -c 'import yaml,sys;[yaml.safe_load(open(f)) for f in sys.argv[1:]]' .github/workflows/deploy.yml
(no output — valid YAML)
```

## Files touched

- `deploy/chart/rch/templates/_helpers.tpl`
- `deploy/chart/rch/templates/secret.yaml`
- `deploy/chart/rch/templates/externalsecret.yaml`
- `deploy/chart/rch/templates/servicemonitor.yaml`
- `deploy/chart/rch/templates/migrate-job.yaml`
- `deploy/chart/rch/templates/purge-cronjob.yaml`
- `deploy/chart/rch/templates/ui-deployment.yaml`
- `deploy/chart/rch/tests/render.test.sh`
- `.github/workflows/deploy.yml`

## Concerns / notes for reviewers

- Making `secret.yaml` a Helm hook (necessary follow-on to C1, see above) means an existing
  staging release's Secret goes from being a normally-tracked release resource to a hook
  resource: `helm uninstall` will no longer delete it (consistent with how the ExternalSecret
  already behaves per I3 — hook resources persist unless a `hook-succeeded`/`hook-failed`
  delete policy is added, which isn't appropriate here since the Secret must survive between
  deploys). Flagging this as an intentional, symmetric extension of the review's own reasoning,
  not something explicitly requested in the C1/I3 text.
- `docker`/`helm` were run locally against the already-built `rch-ui:x` image in this
  environment; no images were built or pushed as part of this fix.
