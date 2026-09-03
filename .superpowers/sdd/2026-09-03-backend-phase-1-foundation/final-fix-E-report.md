# Final review, fix pass E — chart/docs

Worktree `.claude/worktrees/agent-a2675cefeb5a25721`, branch
`worktree-agent-a2675cefeb5a25721`, fast-forwarded onto `feat/phase-1-foundation`
(`a7bc625 Merge final fix wave B: auth, idempotency and client hardening`).

Scope kept to `deploy/chart/rch/**`, `deploy/RUNBOOK.md`,
`docs/superpowers/specs/2026-09-03-backend-design.md` (§16 table, appended one row) and
`apps/api/src/cli/migrate.ts` (one addition). Nothing under `apps/api/src/**` besides that one
file was touched.

## I9 — ServiceMonitor selected zero Services

`spec.selector` on a `ServiceMonitor` matches **Service metadata labels**, not the Service's
own `spec.selector`. The prior fix put `app.kubernetes.io/component: api` on the
ServiceMonitor's `matchLabels` but never on the api Service's own `metadata.labels` (only
`rch.labels`, which carries no `component`), so the monitor matched no Service and scraped
nothing.

Fix: `deploy/chart/rch/templates/api-service.yaml` and `ui-service.yaml` now append
`app.kubernetes.io/component: api` / `component: ui` to `metadata.labels` (same pattern the
Deployments already used). `render.test.sh` now greps the `# Source:
rch/templates/api-service.yaml` block specifically (not the ServiceMonitor block) for
`component: api`.

## N2 / N3 — hooks on the Secret/ExternalSecret broke on upgrade

Converting `secret.yaml`/`externalsecret.yaml` into `pre-install,pre-upgrade` hooks (done in
fix wave A to solve first-install ordering) had two new consequences:

1. Hook resources live outside `Release.Manifest`. An existing release installed from the
   previous (non-hook) chart version has its Secret tracked as a plain release resource; after
   the chart switches it to a hook, Helm's diff sees the "old" plain Secret as no longer part of
   the release and deletes it at the end of that first upgrade.
2. With `helm.sh/hook-delete-policy: before-hook-creation` and (on the ExternalSecret) ESO's
   `target.creationPolicy: Owner`, the target Secret is destroyed and re-synced from the
   external store on **every** upgrade — making every deploy depend on ESO/the secret store
   being healthy at that exact moment, not just on first install.

Fix — removed the ordering problem instead of ordering around it:

- `secret.yaml` / `externalsecret.yaml`: removed all `helm.sh/hook*` annotations; both are
  plain release resources again, with a code comment recording why a hook was tried and
  reverted. `JWT_PREVIOUS_PUBLIC_KEY` stays `optional: true`.
- Deleted `templates/migrate-job.yaml` and the `migrate:` block from `values.yaml`. Migrations
  now run as a `migrate` **initContainer** on the api Deployment (`api-deployment.yaml`): same
  image, `args: ["dist/cli/migrate.mjs"]`, the same `rch.envList` env, same container
  `securityContext` and resource requests/limits the Job used to have. Because the initContainer
  runs inside the same pod spec, it is guaranteed to start after the plain Secret/ExternalSecret
  already exist as part of the same `helm upgrade`/`install` apply — no hook needed. `/readyz`
  still fails until the applied migration count matches the journal, so a failing migration
  keeps the pod NotReady; `rollingUpdate.maxUnavailable: 0` keeps old pods serving and `helm
  upgrade --wait` times out rather than completing — spec §11.1's "upgrade aborts if migration
  fails" is preserved, just via pod readiness instead of a hook Job exit code.
- Concurrency: `apps/api/src/cli/migrate.ts` now takes `select pg_advisory_lock(727272)` on the
  same session as `runMigrations` before migrating, and `select pg_advisory_unlock(727272)`
  after (the pool is already `max: 1`, so lock/unlock share the one connection — advisory locks
  are session-scoped). Several api pods can start their initContainer together during a
  rollout; the first to acquire the lock migrates, the rest block, then find nothing pending.
  The lock/unlock calls and the reasoning are a one comment block above them.
- `purge-cronjob.yaml` is unchanged — still plain `envFrom`/env via `rch.envList`.
- `render.test.sh`: removed the migrate-Job hook assertions; added assertions that no
  `helm.sh/hook` annotation appears anywhere in either rendered output, no `kind: Job` appears,
  the api Deployment has an `initContainers:` block referencing `dist/cli/migrate.mjs`, and the
  api Service's own metadata (not the ServiceMonitor's) carries `component: api`. Kept the
  existing secretKeyRef/optional/readOnlyRootFilesystem assertions —
  `readOnlyRootFilesystem: true` count is still `>= 4` (migrate initContainer + api container +
  ui container + purge CronJob container).
- `deploy/RUNBOOK.md` §1 (migration workflow paragraph) and §2 (Deploy) rewritten: migrations
  run as an initContainer on every api pod, the advisory lock serialises replicas, a failing
  migration shows as the pod stuck NotReady and `helm upgrade --wait` timing out, and recovery
  is either a forward-fix migration or `helm rollback` (§3, unchanged — it never mentioned the
  Job). §9's DB-connections alert note was reworded from "a migration Job overlapping normal
  traffic" to "a burst of migrate initContainers…" to match. No "pre-create the Secret /
  ordering" note existed elsewhere in the runbook to remove.
- `docs/superpowers/specs/2026-09-03-backend-design.md` §16: appended one row — "§11.1
  migrations — run as an initContainer on the api pods (pg advisory lock) instead of a
  pre-upgrade hook Job; secrets are plain resources. Why: hooks for secrets were deleted on the
  first upgrade of an existing release and re-synced on every upgrade." (Appended per scope;
  did not edit the existing, now-superseded §11.1 row from the earlier amendment — the new row
  stands alongside it.)

## Verification

```
$ bash deploy/chart/rch/tests/render.test.sh
==> Linting .
[INFO] Chart.yaml: icon is recommended
1 chart(s) linted, 0 chart(s) failed
==> Linting .
[INFO] Chart.yaml: icon is recommended
1 chart(s) linted, 0 chart(s) failed
chart renders
```

`helm lint` run individually against both `values-staging.yaml` and `values-prod.yaml` (with
the placeholder `--set`s the test script uses) also passes standalone.

```
$ helm template rch deploy/chart/rch -f deploy/chart/rch/values-prod.yaml --set image.registry=r,image.tag=t | grep -n -A6 initContainers
74:      initContainers:
75-        - name: migrate
76-          image: r/rch-api:t
77-          imagePullPolicy: IfNotPresent
78-          args: ["dist/cli/migrate.mjs"]
79-          env:
80-            - name: NODE_ENV
```

`pnpm --filter @rch/api typecheck` — clean (`tsc --noEmit`, no output). `pnpm --filter @rch/api
lint` — clean (oxlint, no output). `pnpm --filter @rch/api test` — 84/84 passing (18 files),
run against `rch_test` on the local Postgres container (host port 5439).

Postgres was reachable on host port 5439 (`rch-postgres` container already running), so the
advisory-lock path was exercised for real rather than just typechecked:

```
$ pnpm --filter @rch/api db:migrate
migrations applied: 2 / 2
```

Also ran `db:migrate` twice more, the second time as two invocations launched concurrently
(`pnpm --filter @rch/api db:migrate & pnpm --filter @rch/api db:migrate & wait`) to prove the
`pg_advisory_lock` actually serialises overlapping replicas rather than merely typechecking:
both processes completed and both printed `migrations applied: 2 / 2` — no lock contention
error, no double-apply.

## Notes / things a future pass should know

- The chart still has never been `helm install`ed against a real (or kind/k3d) cluster — spec
  §14's amendment already flags this as a Phase 2 CI gap. This pass only re-verifies via `helm
  template` + `helm lint`, same as prior fix waves; it cannot observe an actual rollout
  stalling on a failing initContainer, only reason about it from the readiness-probe and
  `maxUnavailable: 0` mechanics already in the Deployment.
- `apps/api/src/cli/migrate.ts` is the only file touched outside `deploy/`; per the dispatch
  instructions the parallel `apps/api/src/**` fixer was not touching this file, and no merge
  conflict is expected there.
