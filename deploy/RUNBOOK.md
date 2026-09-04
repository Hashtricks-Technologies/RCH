# RCH — Operations Runbook

Operational procedures for the Royal Care Hospital F&B backend (`apps/api`, `UI/`,
`deploy/chart/rch`). See `docs/superpowers/specs/2026-09-03-backend-design.md` for the design
this implements; this document is the "how to actually do it" companion.

## 1. Local development

```bash
pnpm db:up                                    # postgres:17 in Docker, host port 5439 -> container 5432
cp .env.example .env
pnpm --filter @rch/api keys:generate >> .env   # appends JWT_PRIVATE_KEY= / JWT_PUBLIC_KEY=
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed
pnpm dev                                       # turbo run dev --parallel: api on :3000, UI on :5173
```

Local Postgres listens on host port **5439**, not 5432 — a native PostgreSQL install commonly
already owns 5432 on a dev machine. `docker-compose.yml` maps `5439:5432`; `.env.example`'s
`DATABASE_URL` / `TEST_DATABASE_URL` already point at 5439. `pnpm db:down` stops it.

`keys:generate` prints a fresh Ed25519 pair as two `JWT_*=` lines — append them to `.env` (as
above) for local dev, or paste them into the Kubernetes Secret / `values-*.yaml` for a cluster
(§4 below).

Re-seeding an already-seeded database needs `--force`:

```bash
pnpm --filter @rch/api db:seed --force
```

### Test users

Seed password is `SEED_PASSWORD` from `.env` (dev default `changeme`). In staging/prod seeds,
`SEED_FORCE_PASSWORD_CHANGE=true` forces a password change at first sign-in.

| Employee id | Name | Role | Home location |
|---|---|---|---|
| `RC-4471` | Kavitha Raman | Counter Operator | coffee |
| `RC-3120` | Ramesh Kumar | Outlet Manager | rest |
| `RC-2088` | Suresh Muthu | Store Keeper | store |
| `RC-1902` | Vinoth Prakash | Kitchen In-charge | kitchen |
| `RC-1550` | Latha Narayanan | Procurement Officer | store |
| `RC-4482` | Deepa Selvam | Counter Operator | kiosk |

Sign in at `http://localhost:5173` with an employee id and the seed password.

### Auth and rate-limit settings

From `.env` / `apps/api/src/config.ts` (mirrored in `deploy/chart/rch/values.yaml`'s `api.env`
in the cluster):

- `LOGIN_RATE_LIMIT_PER_MINUTE` (default `10`) — `/auth/login` attempts per minute, keyed by
  the caller's IP.
- `LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE` (default `5`) — `/auth/login` attempts per minute,
  keyed by the employee id being signed in as, independently of the per-IP limit above.
- `TRUST_PROXY` (default `"1"`) — how many hops of `X-Forwarded-*` to trust when deriving the
  caller's IP (which both limits above key on). `"1"` trusts exactly the nearest hop — the ALB
  in the cluster, the Vite dev proxy locally — which is correct for both topologies as shipped.
  Set it to a different hop count, or to a CIDR/IP list, if a deployment adds another hop (a
  CDN in front of the ALB, say) or otherwise doesn't match. `values.yaml` does not currently
  override it, so the cluster runs on this default.
- `ACCESS_TOKEN_TTL` (default `15m`) — JWT access-token lifetime.
- `REFRESH_TOKEN_TTL_DAYS` (default `30`) — `rch_refresh` cookie lifetime; the cookie itself
  rotates on every refresh regardless of this setting.
- `COOKIE_SECURE` (default `true`; `.env.example` sets it `false` for local http) — whether the
  `rch_refresh` cookie requires HTTPS.

### Migration workflow

Never hand-edit a migration. To change the schema:

```bash
# edit apps/api/src/db/schema/*.ts, then:
pnpm --filter @rch/api db:generate   # drizzle-kit generate, then strip-public-schema.mjs
```

`db:generate` runs `drizzle-kit generate` and then `scripts/strip-public-schema.mjs`, which
removes the `"public".` qualifiers drizzle-kit writes into the SQL. Without that step, every
generated `CREATE TYPE` / `REFERENCES` would be pinned to the literal `public` schema, which
breaks the per-test-file schemas (`t_<file>`, via `search_path`) that `apps/api/src/test/db.ts`
creates for parallel test runs. Review the generated SQL in `apps/api/drizzle/`, then commit it
— migrations are forward-only (§3) and reviewed like any other change.

`pnpm --filter @rch/api db:migrate` applies pending migrations; it is what the `migrate`
initContainer on every api pod also runs (`dist/cli/migrate.mjs`) — see §2. Four migrations
exist as of Phase 3 (`apps/api/drizzle/0000`–`0003`): `0000` is the initial schema, `0001` adds
the unique index on `refresh_tokens.token_hash`, `0002` installs the append-only trigger on
`stock_moves` (§7), and `0003` adds `bills_staff_credit_idx` — a partial btree index on
`bills (payer_kind, payer_id, at) where payer_kind = 'staff'`, so the staff-credit ceiling's
per-person, per-month sum (`packages/domain/src/credit.ts`) does not scan the whole table on
every sale. The index does **not** carry `tender` — the query that reads it
(`posRepo.staffCreditTaken`) still filters `tender = 'Staff credit'` as a recheck against the
matched rows, so do not "optimise" the predicate by adding `tender` to the index expecting it
to change anything; `payer_kind = 'staff'` already narrows to the rows that matter; `tender`
is a plain row filter on top and adding it to the index buys nothing this table's size makes
worth the extra write cost. A fresh `db:migrate` against an empty database reports all four
applied.

## 2. Deploy

Pushing to `staging` or `production` triggers `.github/workflows/deploy.yml`, gated by the
repository variable `DEPLOY_ENABLED=true`. It builds and pushes the `api` and `UI` images to
ECR, then `helm upgrade --install rch deploy/chart/rch -f values-<env>.yaml --set
image.tag=<sha> --namespace <namespace> --create-namespace --wait`.

Migrations are not a separate Helm hook Job — they run as a `migrate` **initContainer** on
every api pod (`dist/cli/migrate.mjs`, `deploy/chart/rch/templates/api-deployment.yaml`), ahead
of the `api` container on that same pod. Several replicas can start together during a rollout,
so the CLI takes a Postgres advisory lock (`pg_advisory_lock(727272)`, `apps/api/src/cli/
migrate.ts`) before running migrations: the first pod to acquire it applies pending migrations
and releases the lock; the rest block on the same lock, then find nothing left to apply. A
failing migration means the initContainer never completes, so that pod never becomes Ready;
with `rollingUpdate.maxUnavailable: 0` on the api Deployment, the old pods keep serving traffic
and `helm upgrade --wait` — the deploy workflow's install/upgrade step — times out rather than
completing, and the previous release stays live. **To recover:** inspect the stuck pod
(`kubectl describe pod`, `kubectl logs <pod> -c migrate -n <namespace>`) to see the migration
error, then either fix it forward with a new migration or `helm rollback rch <revision> -n
<namespace>` (§3) to abandon the attempt — rolling back does not undo an already-applied
migration (§3 explains why that's usually fine). A production push additionally waits for a
GitHub environment approval before the deploy job runs, and a fast-forward guard checks
`staging ⊂ develop` and `production ⊂ staging` so the branches can never diverge.

### CI: a real `helm install`

Every push to `develop`/`staging`/`production` and every pull request exercises the chart for
real, not just `helm lint`/`helm template`: the `images` job in `.github/workflows/ci.yml`
builds `rch-api:ci` and `rch-ui:ci`, spins up a throwaway [kind](https://kind.sigs.k8s.io/)
cluster (`helm/kind-action`), loads both images into it, then runs
`deploy/chart/rch/ci/install-test.sh`, which applies the CI-only single-replica Postgres
(`deploy/chart/rch/ci/postgres.yaml`) itself and waits for it before anything else:
`helm install` with `deploy/chart/rch/ci/values-ci.yaml` (a freshly generated Ed25519 pair
passed via `--set-string`, never committed), seed the database, confirm `/readyz` and a login
as `RC-3120` succeed through a port-forward, confirm the UI's `/healthz` succeeds too, then
`helm upgrade --install` with the same values and check `/readyz` again — proving the upgrade
path keeps the rendered Secret in place and the `migrate` initContainer no-ops the second time.
The cluster is deleted with the runner at the end of the job. Run it locally with `kind`
installed: `deploy/chart/rch/ci/install-test.sh` against a cluster that already has
`rch-api:ci`/`rch-ui:ci` loaded (`kind load docker-image`) and `JWT_PRIVATE_KEY`/
`JWT_PUBLIC_KEY` exported (the two lines `pnpm --filter @rch/api keys:generate` prints, already
base64-encoded — export them as-is).

Required repository secrets: `AWS_ROLE_ARN`, `AWS_REGION`, `ECR_REGISTRY`,
`EKS_CLUSTER_STAGING`, `EKS_CLUSTER_PROD`. Required GitHub **environment** secrets for
`staging`: `DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` (these populate
`secrets.values.*` for the chart's in-cluster `Secret`, since staging runs with
`secrets.create=true`). Production runs with `secrets.create=false` and
`secrets.externalSecret.enabled=true`, pulling `DATABASE_URL`, `JWT_PRIVATE_KEY`,
`JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY` from AWS Secrets Manager (`rch/prod`) via the
External Secrets Operator — no database or key secrets live in GitHub for prod.

### Promote

```bash
git checkout staging && git merge --ff-only develop && git push
git checkout production && git merge --ff-only staging && git push   # after staging is verified
```

Production deploys wait for the GitHub environment approval before rolling out.

### First-time cluster setup (once per cluster)

```bash
kubectl create namespace rch-staging
kubectl create namespace rch
```

- **ExternalSecret store (prod only):** the `ClusterSecretStore` named `aws-secrets-manager`
  (referenced by `deploy/chart/rch/templates/externalsecret.yaml`) must already exist in the
  cluster — it is provisioned once by the External Secrets Operator install, not by this chart.
  Create the AWS Secrets Manager secret `rch/prod` as one JSON object with the keys
  `DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY` (the last may be
  empty until the first key rotation), and grant the ESO IRSA role read access to it.
- **ACM certificate ARN:** set `ingress.certificateArn` in `deploy/chart/rch/values-staging.yaml`
  and `values-prod.yaml` to the ACM certificate for `rch-staging.<host>` / `rch.<host>` before
  the first deploy — the ingress template only adds the ALB annotation when it is non-empty.

### Housekeeping

A `CronJob` (`deploy/chart/rch/templates/purge-cronjob.yaml`, `purge.enabled` in `values.yaml`)
runs `dist/cli/purge.mjs` nightly at `15 2 * * *` (02:15). It deletes expired
`idempotency_keys` rows, and `refresh_tokens` rows that can no longer authorise anything —
expired ones, and revoked ones more than seven days old, so a recent "why was I signed out?"
is still answerable from the table. It prints a count for each and needs no manual attention;
if it's ever suspicious, run it by hand:

```bash
kubectl create job --from=cronjob/rch-purge rch-purge-manual -n rch
```

## 3. Roll back

```bash
helm history rch -n rch              # or -n rch-staging
helm rollback rch <revision> -n rch
```

Or revert the merge commit on `production` and push — CI redeploys the reverted commit the
normal way.

**Migrations are forward-only.** `helm rollback` puts the old application code back in front of
whatever schema is currently applied; it does not undo a migration. If the rollback needs a
schema change (a column the old code doesn't expect, say), write a new forward migration that
makes the schema compatible with the code you are rolling back to — never edit or delete an
already-applied migration file.

## 4. Rotate JWT keys

```bash
pnpm --filter @rch/api keys:generate   # prints new JWT_PRIVATE_KEY= / JWT_PUBLIC_KEY=
```

1. Take the **current** `JWT_PUBLIC_KEY` and set it as `JWT_PREVIOUS_PUBLIC_KEY`.
2. Set `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` to the newly generated pair.
3. Roll the values out:
   - Staging (`secrets.create=true`): update `values-staging.yaml` (or the deploy workflow's
     `--set secrets.values.*`) and let the next `helm upgrade` apply it.
   - Production (`secrets.externalSecret.enabled=true`): update the `rch/prod` secret in AWS
     Secrets Manager with all four keys, then either wait for the `ExternalSecret`'s
     `refreshInterval: 1h` or force a sync, and restart the API pods to pick up the new
     in-cluster Secret (`ExternalSecret` updates the Secret object but does not itself restart
     pods that already read it into env vars):
     ```bash
     kubectl rollout restart deployment/rch-api -n rch
     ```
4. The API accepts tokens signed with `JWT_PREVIOUS_PUBLIC_KEY` for 24 hours (`plugins/auth.ts`
   verifies against it when the current key fails). After 24 hours, remove
   `JWT_PREVIOUS_PUBLIC_KEY` (blank it out / delete the key from the Secrets Manager JSON) and
   roll out again.

## 5. Accounts

No UI for user administration — it is a CLI, run against a live database connection. Locally:

```bash
pnpm --filter @rch/api users create --emp RC-9001 --name "New Hire" --email new.hire@royalcare.in --role counter --loc coffee --password <temporary>
pnpm --filter @rch/api users reset-password --emp RC-9001 --password <temporary>
pnpm --filter @rch/api users deactivate --emp RC-9001
```

In the cluster, run the same CLI inside a running API pod (the image's entrypoint is
distroless Node, so invoke it directly rather than through a shell):

```bash
kubectl exec deploy/rch-api -n rch -- /nodejs/bin/node dist/cli/users.mjs create --emp RC-9001 --name "New Hire" --email new.hire@royalcare.in --role counter --loc coffee --password <temporary>
kubectl exec deploy/rch-api -n rch -- /nodejs/bin/node dist/cli/users.mjs reset-password --emp RC-9001 --password <temporary>
kubectl exec deploy/rch-api -n rch -- /nodejs/bin/node dist/cli/users.mjs deactivate --emp RC-9001
```

`create` accepts `--emp --name --email --role --loc --password` (required) and `--phone`
(optional); the created account has `must_change_password = true`, so the temporary password
must be changed at first sign-in. That change revokes the employee's other sessions and hands
the browser a fresh one in the same reply (a new access token and refresh cookie), so they
land in the app rather than being bounced back to the sign-in screen. `reset-password` and
`deactivate` both revoke every refresh token for that user (all of that employee's active
sessions are signed out immediately).
`--role` is one of `counter|manager|store|prod|buyer`; `--loc` is one of
`store|kitchen|rest|coffee|kiosk`.

## 6. Restore drill

Before go-live and quarterly:

1. Restore the latest RDS automated snapshot to a scratch RDS instance.
2. Point a one-off Job at the scratch instance's `DATABASE_URL` and run
   `dist/cli/rebuild-balances.mjs` against it:
   ```bash
   kubectl run rch-restore-drill --rm -it --restart=Never -n rch \
     --image=<ecr-registry>/rch-api:<tag> \
     --env="DATABASE_URL=<scratch-instance-url>" --env="DATABASE_SSL=true" \
     -- /nodejs/bin/node dist/cli/rebuild-balances.mjs
   ```
3. Diff the scratch instance's `stock_balances` against production's:
   ```bash
   psql "<scratch-url>" -c "select loc, item_key, on_hand from stock_balances order by 1, 2" > scratch.txt
   psql "<production-url>" -c "select loc, item_key, on_hand from stock_balances order by 1, 2" > prod.txt
   diff scratch.txt prod.txt
   ```
4. Record the date of the drill (and the diff result) wherever the team tracks operational
   records — an empty diff, and a successful `rebuild-balances` run, is the pass condition.

## 7. Rebuild balances

`stock_balances` is a cache derived from the append-only `stock_moves` ledger. "Append-only" is
enforced in the database, not just by convention: migration `0002` installs a trigger that
refuses any `UPDATE` or `DELETE` on `stock_moves` (`TRUNCATE` is still allowed — the test
harness and `db:seed --force` use it to reset between runs). There is no in-place correction of
a move; the schema already carries a `reverses_id` column and a `reversal` move kind
(`apps/api/src/db/schema/ledger.ts`, `enums.ts`) for the day a correction posts a new move
pointing back at the one it undoes, the same way a wrong ledger entry is corrected in
accounting rather than edited. Rebuild the cache after a suspected balance drift, after a
restore drill (§6), or any other time the cache is in doubt:

```bash
pnpm --filter @rch/api db:rebuild-balances                                       # local
kubectl exec deploy/rch-api -n rch -- /nodejs/bin/node dist/cli/rebuild-balances.mjs   # cluster
```

`rebuildBalances()` (`apps/api/src/lib/ledger.ts`) takes `LOCK TABLE stock_balances IN EXCLUSIVE
MODE` for the duration of the rebuild. `EXCLUSIVE` conflicts with every lock mode except
`ACCESS SHARE`, so a plain read of `stock_balances` is not blocked, but every writer —
`postMoves()`, and so every sale, handover, receipt or any other move-writing endpoint — blocks
until the rebuild commits. Prefer a quiet period (off-hours) for a production run regardless:
it is a straight `SELECT ... GROUP BY` over `stock_moves` and fast for this dataset's size, but
in-flight writes will queue for however long it takes.

A rebuild zeroes the rows it finds and adds the moves back on top; it never deletes one. A
balance row's presence is itself a fact — it means the location carries that line — so a row
with no moves behind it stays, at zero, and reads as stocked-but-empty afterwards exactly as it
did before. Only the numbers are recomputed, never the shelf list.

The same rule holds outside a rebuild. `lockBalances` (`apps/api/src/lib/ledger.ts`) inserts a
zero `on_hand` row before locking any cell it is about to touch, so a request, ticket or sale
against an item a location has never carried creates the row rather than failing to find one —
but every Phase 3 write locks *only* the cells it actually moves or reserves, never a whole
location's worth speculatively, and a refusal rolls that insert back with everything else. A
stray "carried at zero" cell that nobody ever asked for would be indistinguishable from a real
one on every stock screen (M12), so this is an invariant any new write must keep, not an
implementation detail: lock the cells you touch, nothing wider.

## 8. Read a document's history

Every status change on a request, requisition, purchase order or production order is a row in
`document_history`, keyed by `(doc_type, doc_id)`:

```sql
select * from document_history where doc_type = 'request' and doc_id = 'REQ-2026-0913' order by at;
```

`doc_type` is one of `request`, `requisition`, `purchase_order`, `prod_order` (confirmed by
`grep -rn "appendHistory(" apps/api/src`, which as of Phase 1 turns up exactly these four
calls, all from `apps/api/src/db/seed.ts` — the modules that write these documents outside the
seed, in later phases, call the same helper) — plus, as of Phase 3, `ticket`, but only ever for
one status: a ticket's ordinary lifecycle still carries no prose, just three timestamps on the
row (`issued_at`, nullable `collected_at`, nullable `received_at`,
`apps/api/src/db/schema/movement.ts`), so read those directly:

```sql
select id, status, issued_at, collected_at, received_at from tickets where id = 'TKT-0441';
```

A supervisor override — the collector's OTP skipped, allowed to the store and the kitchen
only (spec §8.3) — is the one ticket event that *does* write `document_history`, so it stays
auditable:

```sql
select * from document_history where doc_type = 'ticket' and doc_id = 'TKT-0441';
-- one row only for an override, status = 'Handed over — supervisor override'; empty otherwise
```

No screen or API route surfaces this today — there is no `GET` for `document_history` at all,
narrow or otherwise — so the query above (or a report built against this table later) is the
only way to see who used the override and when.

What a ticket actually moved is the ledger, two lines per handover — a `ticket_out` set posted
at the source when it is handed over, a `ticket_in` set posted at the destination when it is
received:

```sql
select * from stock_moves where ref_type = 'ticket' and ref_id = 'TKT-0441' order by id;
```

A bill (Phase 2, `POST /bills`) writes no `document_history` either — it is a single
create-and-settle document, not something that moves through statuses — so read what it did
from the ledger instead, keyed by `ref_type = 'bill'` and `ref_id = <bill number>`:

```sql
select * from stock_moves where ref_type = 'bill' and ref_id = 'CF/1188';
```

Connect with `psql` (or any Postgres client) against the target `DATABASE_URL` — locally
that's `postgres://rch:rch@localhost:5439/rch`.

### Finding a stuck hold

A request's approval, an issued ticket, a shop-transfer or a granted shop-ask all reserve
stock in `reservations` (Phase 3) rather than moving it; the hold is released only when the
matching ticket is handed over (`releaseForTicket` in `apps/api/src/lib/reservations.ts`). A
row still open — `released_at is null` — after its ticket should long since have moved is a
hold worth investigating, most often an issued ticket nobody ever collected:

```sql
select r.*, t.status, t.issued_at
from reservations r join tickets t on t.id = r.ticket_id
where r.released_at is null
order by r.id;
```

There is no expiry job on a reservation today — an uncollected ticket holds its stock until
somebody hands it over (with the OTP, or the supervisor override) or the row is corrected by
hand; a location screen reading `freeToPromise` this low is the first place the shortage shows.

### Releasing a stranded reservation

Phase 3 has no way to cancel a ticket — there is no `POST /tickets/:id/cancel` and no
`Cancelled` ticket status (`TktStatusSchema` is `Issued | Collected | Received` only), and
`scripts/check-boundaries.sh` refuses any write to `reservations` from outside `apps/api/src/
lib/` at review time, so there is no route that could release one even by accident. A ticket
raised in error — wrong item, wrong quantity, a request that turns out to be unnecessary — has
no in-app undo; it just sits `Issued`, holding stock out of `freeToPromise`, until this manual
procedure:

```sql
update reservations set released_at = now()
where ticket_id = 'TKT-0441' and released_at is null;
```

That frees the stock. It does **not** change the ticket's own status — it stays `Issued`, and a
collector who later shows up with the right OTP could still hand it over and post a real move
against a shelf the release already assumed was free, so tell the store keeper or the kitchen
out loud that `TKT-0441` is dead and must not be handed over. Leave the linked request's status
alone too (`Ticket issued`) rather than guessing at a status the state machine does not offer —
correcting it cleanly needs Phase 4's `voidTicket` and a proper `Cancelled` ticket state,
which is when this procedure retires.

## 9. Alerts

Five alerts, per spec §12. `/metrics` (Prometheus format, `apps/api/src/plugins/metrics.ts`)
exposes `http_request_duration_seconds` (histogram, labelled `method`, `route`, `status`) and
the default Node process metrics; the `ServiceMonitor` template (enabled by default in
`values-prod.yaml`, off by default elsewhere) has Prometheus Operator scrape it. The two RDS
rules need the CloudWatch metrics exporter (or Grafana's native CloudWatch datasource) pointed
at the RDS instance — not part of this chart, wired at the observability-stack level.

1. **5xx rate > 1% over 5 minutes**
   ```promql
   sum(rate(http_request_duration_seconds_count{status=~"5.."}[5m]))
     / sum(rate(http_request_duration_seconds_count[5m])) > 0.01
   ```
2. **p95 latency > 1s**
   ```promql
   histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le)) > 1
   ```
3. **Readiness failing** — the `up` gauge Prometheus sets per scrape target. Prometheus
   Operator's `ServiceMonitor` discovers targets from the Service's `Endpoints`, which only
   lists pods the readiness probe (`GET /readyz`) currently passes, so a pod stuck failing
   `/readyz` drops out of scrape targets entirely; a whole-deployment outage shows as the
   target(s) reporting `up == 0`:
   ```promql
   up{job="rch-api"} == 0
   ```
   sustained for 2 minutes.
4. **DB connections > 80% of max** — RDS CloudWatch `DatabaseConnections`, exposed as a gauge
   by the CloudWatch exporter (metric name depends on the exporter's naming, e.g.
   `aws_rds_database_connections_average`):
   ```promql
   aws_rds_database_connections_average{dbinstance_identifier="rch-prod"} > 0.8 * <max_connections>
   ```
   `<max_connections>` is fixed for the instance class (`SHOW max_connections;`) — compute it
   once and hardcode the threshold in the alert rule. The app pool itself never exceeds 60
   connections (10 per pod × 6 max pods, per spec §11.2) — plus, as of Phase 3, one dedicated
   `LISTEN` connection per pod for the SSE plugin (`apps/api/src/plugins/sse.ts`, outside the
   pool — see §10), so 66 at max scale-out. Still well under any RDS instance's limit, so this
   alert is a safety net for connections opened outside the app (a psql session left open, a
   burst of migrate initContainers opening a connection each during a large rollout).
5. **RDS free storage < 20%**
   ```promql
   aws_rds_free_storage_space_average{dbinstance_identifier="rch-prod"}
     / <allocated_storage_bytes> < 0.2
   ```

## 10. Server-sent events (SSE)

`GET /events` (Phase 3) is how a browser hears about writes made elsewhere — an approval
raised in one window shows up in another's list without a reload. It is one HTTP request that
never ends: the browser opens it once per signed-in session (`UI/src/api/events.ts`, a
`fetch`-based reader rather than `EventSource`, because `EventSource` cannot send an
`Authorization` header) and the pod holds the response open, writing a frame every time
something changes plus a `: ping` comment every `SSE_HEARTBEAT_MS` (25 s) to keep proxies from
reaping an idle connection.

**Reading the two gauges** (`/metrics`, `apps/api/src/plugins/metrics.ts`):

- `sse_clients` — open streams on this pod. Expect it to sit near the number of browsers
  currently pointed at this pod, not near zero; zero on every pod with users signed in means
  the streams are not opening at all (check the ALB/nginx path below before the app).
- `sse_listener_up` — 1 while this pod holds its one `LISTEN` connection to Postgres, 0
  otherwise. **`sse_listener_up == 0` does not mean the pod is serving stale data** — every
  open stream is still alive, still authenticated, still holding its socket — it means that
  pod's streams have gone deaf: a write elsewhere will not reach *this* pod's browsers until
  the listener reconnects. `apps/api/src/plugins/sse.ts` retries the connection itself with
  backoff (250 ms → 500 ms → 1 s → 2 s → 5 s → 10 s) and sends every open stream an
  `event: resync` frame the moment it reconnects, so a browser that missed notices catches up
  with one `loadSnapshot()` rather than trusting a replay it can't have (there is no replay
  buffer — spec §16 records why: it would not survive a pod being rescheduled). Alert on
  `min(sse_listener_up) == 0 for 5m` — a single pod recovering itself in under five minutes
  needs nobody paged; five minutes deaf on any one pod does.

`sse_listener_up` is deliberately **not** wired into `/readyz` (`apps/api/src/plugins/
health.ts` only ever gates readiness on the database check Task 5 registered). A pod whose
listener is down is still correctly answering every request — sign-in, billing, the whole
request chain — with only its live-update fan-out degraded; taking it out of service over that
would mean a transient Postgres blip on the LISTEN connection pulls every pod out of the
Service's endpoints at once (they all lost the same connection at the same moment), which is a
full outage traded for a live-update delay. The 5-minute alert above is the right response to
this failure, not a readiness probe.

**Infrastructure that must not change without checking this first:**

- The ALB idle timeout is 3600 s (`alb.ingress.kubernetes.io/load-balancer-attributes` in
  `deploy/chart/rch/values.yaml`'s `ingress.annotations`), and nginx's
  `/api/v1/events` location (`deploy/nginx/default.conf.template`) sets `proxy_buffering off`
  and `proxy_read_timeout 3600s` separately from the plain `/api/` location's 60 s. Either
  timeout dropping back toward the default silently caps every stream's lifetime at that
  many seconds — live updates would appear to work in testing (well under the timeout) and
  then degrade in a way that only shows up as a slow climb in reconnect attempts hours into a
  shift.
- A rolling deploy ends every open stream — the pod serving it goes away — with a
  `retry: 1000` frame sent first, so `EventSource`-style reconnect semantics bring every
  browser back about a second later, staggered by each client's own backoff
  (`UI/src/api/events.ts`'s ladder: 1 s → 2 s → 5 s → 10 s → 30 s once the server's hint is
  used up). No action needed; a burst of reconnects across a deploy is expected, not a symptom.
- Fastify's `connectionTimeout` (Node's per-socket inactivity timer) would kill a stream
  between heartbeats at its 10 s default, so the events route calls
  `req.raw.socket.setTimeout(0)` itself rather than relying on a server-wide setting;
  `requestTimeout` bounds *receiving* a request and a GET's request body has already ended by
  the time the stream opens, so it never applies here regardless.

- `SSE_HEARTBEAT_MS` (default 25 s) and `SSE_RETRY_MS` (default 1000 ms), nginx's
  `/api/v1/events` `proxy_read_timeout` (3600 s) and `proxy_buffering off`, and the ALB idle
  timeout (3600 s) all belong to the same chain and move together. The heartbeat must stay
  comfortably under every read timeout on the path (an ALB or nginx timeout shorter than the
  heartbeat kills the stream on schedule, not on failure); `proxy_buffering off` must stay off
  or nginx will hold frames waiting for a buffer that never fills; and `SSE_RETRY_MS` is a
  hint, not a guarantee, so widening a timeout upstream does not need a matching change here.
  Changing any one of the four without checking the others is how "live updates work in dev"
  turns into "live updates stall in staging after an hour."

To watch it locally: `curl -N -H "Authorization: Bearer <token>" http://localhost:3000/api/v1/events`
stays open and prints a `: ping` roughly every 25 s, plus an `event: changed` frame for every
write another session makes while the curl is open.
