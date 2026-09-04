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
initContainer on every api pod also runs (`dist/cli/migrate.mjs`) — see §2. Seven migrations
exist as of Phase 6 (`apps/api/drizzle/0000`–`0006`): `0000` is the initial schema, `0001` adds
the unique index on `refresh_tokens.token_hash`, `0002` installs the append-only trigger on
`stock_moves` (§7), `0003` adds `bills_staff_credit_idx` — a partial btree index on
`bills (payer_kind, payer_id, at) where payer_kind = 'staff'`, so the staff-credit ceiling's
per-person, per-month sum (`packages/domain/src/credit.ts`) does not scan the whole table on
every sale. The index does **not** carry `tender` — the query that reads it
(`posRepo.staffCreditTaken`) still filters `tender = 'Staff credit'` as a recheck against the
matched rows, so do not "optimise" the predicate by adding `tender` to the index expecting it
to change anything; `payer_kind = 'staff'` already narrows to the rows that matter; `tender`
is a plain row filter on top and adding it to the index buys nothing this table's size makes
worth the extra write cost. `0004` adds the `payers` table (`kind`, `id`, `name`, `active`) the
`pay` payer rule validates against, `0005` is `ALTER TYPE ticket_status ADD VALUE
'Cancelled'` for Phase 4's `POST /tickets/:id/cancel`, and `0006` is
`rate_contracts_live_uq`, Phase 5's partial unique index keeping one live rate contract per
item. Phase 6 wrote no migration. A fresh `db:migrate` against an empty database reports all
seven applied; against an already-current one it reports `migrations applied: 7 / 7`.

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

**Migration `0005` (`ALTER TYPE ticket_status ADD VALUE 'Cancelled'`, Phase 4) is one you cannot
roll back past once it has been used.** Postgres has no `DROP VALUE` for an enum, so the value
stays in the type forever once added — that part is harmless on its own. What is not harmless:
a pre-Phase-4 (Phase 3) API image validates every response against `TicketsResponseSchema` /
`SnapshotSchema`, whose `TktStatusSchema` is a closed union that does not include `Cancelled`.
The moment any ticket row carries `status = 'Cancelled'`, that old image's `GET /snapshot` and
`GET /tickets` fail response validation for **every** signed-in user, not just the one who
touched the cancelled ticket — a 500, not a graceful degrade. So: rolling back the API past the
Phase 4 image is safe only while no ticket has ever been cancelled on that database. Once one
has, either roll forward instead of back, or first take every `Cancelled` ticket out of the
result set the old code will serialise — there is no in-app path for this, and a `Cancelled`
ticket was always `Issued` (never collected, by construction), so the only status the old
schema accepts that is not a lie is putting it back to `Issued` by hand, which re-opens a
ticket the operator was told was withdrawn. That is exactly the kind of manual data surgery a
rollback should not require, so prefer rolling forward with a fix instead.

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

Rehearse this against the local database first — the procedure below needs a scratch RDS
instance, which nobody can run before there is an RDS, and the real drill should not be the
first time anyone has typed these commands:

```bash
# Rehearse the drill against the local database, so the real one is not the first time.
pnpm db:up && pnpm --filter @rch/api db:migrate && pnpm --filter @rch/api db:seed --force
pg_dump "postgres://rch:rch@localhost:5439/rch" -Fc -f /tmp/rch-drill.dump
psql "postgres://rch:rch@localhost:5439/postgres" -c 'create database rch_drill'
pg_restore -d "postgres://rch:rch@localhost:5439/rch_drill" /tmp/rch-drill.dump
DATABASE_URL="postgres://rch:rch@localhost:5439/rch_drill" pnpm --filter @rch/api db:rebuild-balances
# The pass condition is an empty diff: the restored balances must equal the source's.
psql "postgres://rch:rch@localhost:5439/rch"       -c "select loc, item_key, on_hand from stock_balances order by 1,2" > /tmp/src.txt
psql "postgres://rch:rch@localhost:5439/rch_drill" -c "select loc, item_key, on_hand from stock_balances order by 1,2" > /tmp/dst.txt
diff /tmp/src.txt /tmp/dst.txt && echo "restore drill: balances reconcile"
psql "postgres://rch:rch@localhost:5439/postgres" -c 'drop database rch_drill'
```

`pg_dump`/`pg_restore` stand in for "restore the latest snapshot" — a local database has no
automated-snapshot mechanism to restore from, so a logical dump is the nearest equivalent that
proves the same thing: `db:rebuild-balances` run against a restored copy reproduces the
original's balances exactly. This is the rehearsal; the real thing is against RDS, below, and is
run before go-live and quarterly:

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

**Rehearsed: 2026-09-04, PASS.** The local block above was run end to end against the dev
database on `localhost:5439`, carrying that day's exit-walk documents rather than a bare seed —
`pg_dump -Fc` 101 KB in 0.33 s, `createdb rch_restore`, `pg_restore` in 1.03 s,
`db:rebuild-balances` against the restored copy reporting `stock_balances rebuilt: 54 rows`, and
an **empty diff** over all 54 balance rows against the source. Whole drill: 2.9 s; the scratch
database was dropped afterwards. This is the rehearsal, not the drill: it proves the procedure is
right and that `rebuild-balances` reproduces a restored copy's balances exactly. The RDS half
(steps 1–4 above) has never been run, because there is no RDS yet — it is §11 step 5, before
go-live.

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

Tracing a `grn_accept` move back to its paperwork (`select * from stock_moves where ref_type =
'grn' and ref_id = '<id>'`) means reading the id in the shape it was actually written in —
`GRN-<yy><po number>-<nn>` since Phase 6, `GRN-<last 3 of the PO>-<nn>` for anything booked in
before it (§8, below, has the full story and the reason for the change).

## 8. Read a document's history

Every status change on a request, requisition, purchase order or production order is a row in
`document_history`, keyed by `(doc_type, doc_id)`:

```sql
select * from document_history where doc_type = 'request' and doc_id = 'REQ-2026-0913' order by at;
```

`doc_type` is one of `request`, `requisition`, `purchase_order`, `prod_order` or `ticket` — five
types, written by the modules that own each document; `grep -rn "appendHistory(" apps/api/src`
is the authoritative list. A production order's own board walk reads the same way, one row per
press including the dispatch:

```sql
select * from document_history where doc_type = 'prod_order' and doc_id = 'PRD-2026-029' order by at;
```

The board's statuses (`PordStatus`, `packages/contract/src/schemas/common.ts`) are `New`,
`Accepted`, `In kitchen`, `Ready`, `Dispatched`, `Declined` — `POST /prod-orders/:id/status`
walks the first four in order (a skipped stage is refused, naming the one it is actually on),
`Dispatched` only ever comes from its own endpoint (`POST /prod-orders/:id/dispatch`), and the
one way back to `Ready` from `Dispatched` is a ticket cancellation, never a press on the board.

Kitchen make refusals leave no history row and no batch row — a `POST /batches` that comes back
"Kitchen is short of …" wrote nothing, and the batch number it drew is rolled back with it, so
the series skips a number the same way a cancelled sale skips a bill number.

**As of Phase 6, a ticket writes a row for its whole trail, not just the override and the
cancellation** — `Issued` (written by `writeTicket`, `lib/tickets.ts`, the one place any ticket
is created), `Handed over` or `Handed over — supervisor override`, `Received`, and
`Cancelled — <reason>`. The three timestamps on the row itself (`issued_at`, nullable
`collected_at`, nullable `received_at`, `apps/api/src/db/schema/movement.ts`) still exist and
still agree with the trail; the trail is what has a sentence for each step, not only the two
that used to get one:

```sql
select id, status, issued_at, collected_at, received_at from tickets where id = 'TKT-0441';
select * from document_history where doc_type = 'ticket' and doc_id = 'TKT-0441' order by at;
-- a collected ticket reads: Issued, Handed over, Received
-- an overridden one: Issued, Handed over — supervisor override
-- a withdrawn one: Issued, Cancelled — <reason>
```

**Unlike every other document, this trail is on the wire and on screen** — `TicketSchema.hist`
(`packages/contract`) carries it on `GET /snapshot`, `GET /tickets` and every ticket write's own
response, and the store's and counter's ticket drawers render it as a `History` section, the
same way a request's own drawer already rendered its trail. `GET /documents/:type/:id/history`
— a generic endpoint for every document type — is still **not** built; a field on the one
document that needed its history readable back is smaller and complete, and the query above is
still the only way to read a request's, a requisition's, a purchase order's or a production
order's own history, none of which gained a screen this phase.

**No backfill.** A ticket that existed before this phase shipped has no `Issued` row — its trail
starts from whichever Phase 6 write next touched it (a handover, a receipt, a cancellation), and
reads short for the part of its life that predates the trail existing at all. This is expected,
not a data-quality bug to chase.

**The OTP is on the wire only while a ticket is `Issued`, and only for a caller standing at that
ticket's own `to` location** — the desk that issued the ticket reads `""` back, in its own
write's response and in every later read, and so does anyone standing anywhere else. `handover`
never reads the wire value anyway: it compares what the collector says against the row it locks
for itself. The labelled supervisor override (store keeper or kitchen in-charge, OTP field left
blank) is the one door past a collector who genuinely is not there, and it is what the trail
records instead of a code nobody typed.

**The counter's cancel door.** `POST /tickets/:id/cancel` now also admits `counter`, scoped to
the ticket's own `from` — an outlet that raised a shop-to-shop transfer can withdraw it before
anyone collects, the same door the store keeper and the kitchen already had. Withdrawing a
ticket that was answering a shop's ask also puts that ask back to `Asked` on the other shop's
own desk, so nothing is left half-granted.

What a ticket actually moved is the ledger, two lines per handover — a `ticket_out` set posted
at the source when it is handed over, a `ticket_in` set posted at the destination when it is
received:

```sql
select * from stock_moves where ref_type = 'ticket' and ref_id = 'TKT-0441' order by id;
```

A cancelled ticket moves nothing, because nothing had moved — there is no ledger query for a
cancellation; `reservations.released_at` on its holds is the only trace (below).

A bill (Phase 2, `POST /bills`) writes no `document_history` either — it is a single
create-and-settle document, not something that moves through statuses — so read what it did
from the ledger instead, keyed by `ref_type = 'bill'` and `ref_id = <bill number>`:

```sql
select * from stock_moves where ref_type = 'bill' and ref_id = 'CF/1188';
```

A batch (Phase 4, `POST /batches`) writes no `document_history` either — it is created once,
never transitions — so read it from the ledger too, keyed by `ref_type = 'batch'`:

```sql
select * from stock_moves where ref_type = 'batch' and ref_id = 'BAT-20260904-01' order by id;
```

The negative rows are the recipe — one `production_consume` move per ingredient, `qty` = the
recipe's own quantity times what was *started* — and the positive row, if there is one, is the
`production_yield` for what was *made*. A batch that yielded nothing (a tray dropped, `made =
0`) posts no positive row at all: the recipe still came off, but nothing was created to book,
so there is no move for it and no "carried at zero" row on the finished item either (M12). The
batch's own row (`select * from batches where id = 'BAT-20260904-01'`) is what records a lost
tray — `started_qty` and `made_qty` disagree, and `note` usually says why.

`BAT-<yyyymmdd>-<nn>` takes its date from the make and its `<nn>` from the one `sequences` row
kept for the `"batch"` kind (`SEQUENCE_START.batch`), which never resets — the number is unique
and increasing, not a count of the day's batches, and widens past two digits rather than
wrapping. Do not "fix" a batch id by hand; a gap in the series (a refused make, above) is
correct, the same as a gap in the bill or ticket series.

**A goods receipt is numbered from the order it books in against:
`GRN-<yy><po number>-<nn>`, so the second instalment against `PO-2026-0143` is
`GRN-260143-02`.** It was `GRN-<last three of the PO>-<nn>` until Phase 6, which collided —
`PO-2026-0143` and `PO-2027-0143` share a three-character tail, and so do `PO-2026-0143` and
`PO-2026-1143`. Because `grns.id` is a primary key, the collision surfaced as a failed insert in
the middle of a receipt rather than as a duplicate number a screen could quietly show twice.
**GRNs written before that change keep their old ids** — nothing was renumbered, and a receipt
whose id has a three-character tail is simply an older one, not a corruption to fix.
`packages/domain/src/ids.ts`'s `grnId(poId, n)` is the only place the format lives; see §14,
below, for tracing a `grn_accept` move back to its own paperwork by that id.

**Support tickets keep no `document_history` row at all.** Their history *is* their
conversation: `support_messages` (`SUP-0044/m1`, `.../m2`, …) already holds who said what and
when, and `support_tickets.status` sits beside it as an ordinary column. `GET /support/tickets`
answers a caller's own tickets only, by `by_user` in the JWT — there is no support-agent role in
this system, so "own tickets, every role" is the whole scoping rule, and someone else's ticket
answers `404`, not `403`: it is not that you may not act on it, it is that it is not yours to
know about.

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
somebody hands it over (with the OTP, or the supervisor override) or the ticket is cancelled —
or, for a `Collected` ticket only, the manual procedure below; a location screen reading
`freeToPromise` this low is the first place the shortage shows. It matters more from Phase 4 on
than it did in Phase 3: free-to-promise is what `POST /batches` refuses a make against, so a
stranded hold at the kitchen does not just under-report an outlet's shelf — it stops the
kitchen baking.

### Cancelling a ticket

As of Phase 4 this is an endpoint, not a manual procedure: `POST /tickets/:id/cancel {reason}`
(store keeper, kitchen in-charge, or — since Phase 6 — the counter, each scoped to the ticket's
own `from` location) releases every open hold the ticket placed, sets it to `Cancelled`, and
puts the document behind it — a request back to its approved status, a dispatched production
order back to `Ready`, a shop-ask back to `Asked` — where it stood before the ticket was raised.
Use it for any ticket still `Issued`:

```bash
curl -sS -X POST "$API/tickets/TKT-0441/cancel" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H "Idempotency-Key: $(python3 -c 'import uuid;print(uuid.uuid4())')" \
  -d '{"reason":"Wrong item, request cancelled by phone"}'
```

The manual SQL from Phases 1–3 still has exactly one live use: a ticket already `Collected`
(stock in transit, both ends' figures already moved) has no cancel button and no endpoint —
cancelling a movement that has already happened is a correction, not a withdrawal — so freeing
a hold stuck behind one is still by hand:

```sql
update reservations set released_at = now()
where ticket_id = 'TKT-0441' and released_at is null;
```

That frees the stock only; it does not touch the ticket's own status or the document behind
it, so tell the store keeper or the kitchen out loud what was done and why, the same as before
Phase 4.

## 9. Alerts

Spec §12 names five; this build ships seven — the five below that the chart's `PrometheusRule`
renders, plus the two RDS rules that stay runbook-only. `/metrics` (Prometheus format,
`apps/api/src/plugins/metrics.ts`) exposes `http_request_duration_seconds` (histogram, labelled
`method`, `route`, `status`), `pg_pool_waiting`/`pg_pool_idle`, `sse_listener_up` and the default
Node process metrics. **As of Phase 6, the first five below ship as a `PrometheusRule`**
(`deploy/chart/rch/templates/prometheusrule.yaml`), gated on the same
`.Values.serviceMonitor.enabled` flag as the `ServiceMonitor` itself (on by default in
`values-prod.yaml`, off elsewhere) — so a cluster with the Prometheus Operator installed gets
these five the moment the chart is installed, with no separate alert-authoring step. **The two
RDS rules stay runbook-only**, below, because they need the CloudWatch metrics exporter (or
Grafana's native CloudWatch datasource) pointed at the RDS instance, which is not part of this
chart and is wired at the observability-stack level. A Grafana dashboard JSON does **not** ship
with the chart either — a dashboard in a ConfigMap is an unversioned blob nothing renders in CI
and nothing fails when it drifts, so build one from `/metrics` in Grafana directly rather than
looking for one here.

1. **`RchApiHigh5xxRate` — 5xx rate > 1% over 5 minutes, critical**
   ```promql
   sum(rate(http_request_duration_seconds_count{job="rch-api",status=~"5.."}[5m]))
     / sum(rate(http_request_duration_seconds_count{job="rch-api"}[5m])) > 0.01
   ```
2. **`RchApiHighLatencyP95` — p95 latency > 1s over 10 minutes, warning**
   ```promql
   histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{job="rch-api"}[5m])) by (le)) > 1
   ```
3. **`RchApiDown` — readiness failing, critical.** The `up` gauge Prometheus sets per scrape
   target. Prometheus Operator's `ServiceMonitor` discovers targets from the Service's
   `Endpoints`, which only lists pods the readiness probe (`GET /readyz`) currently passes, so a
   pod stuck failing `/readyz` drops out of scrape targets entirely; a whole-deployment outage
   shows as the target(s) reporting `up == 0`:
   ```promql
   up{job="rch-api"} == 0
   ```
   sustained for 2 minutes.
4. **`RchApiPoolSaturated` — the app's own Postgres pool has queuers and nothing idle, warning,
   sustained 5 minutes:**
   ```promql
   max(pg_pool_waiting{job="rch-api"}) > 0 and max(pg_pool_idle{job="rch-api"}) == 0
   ```
   This is the pool the app itself opens (`max: 10` per pod, `apps/api/src/db/client.ts`), not
   RDS's own connection count — see item 6 below for that. The app pool never exceeds 60
   connections at max scale-out (10 per pod × 6 max pods, per spec §11.2) — plus one dedicated
   `LISTEN` connection per pod for the SSE plugin (§10), so 66. Still well under any RDS
   instance's limit; this alert catches the pool running out locally, long before RDS itself is
   under any real pressure.
5. **`RchSseListenerDown` — the fifth chart-shipped alert and this build's sixth overall,
   warning, sustained 5 minutes:**
   ```promql
   min(sse_listener_up{job="rch-api"}) == 0
   ```
   Its rationale — what `sse_listener_up` means, why 5 minutes and not immediately, and why it
   is deliberately *not* wired into `/readyz` — is §10's, below, not repeated here.
6. **DB connections > 80% of max — runbook-only, needs CloudWatch.** RDS CloudWatch
   `DatabaseConnections`, exposed as a gauge by the CloudWatch exporter (metric name depends on
   the exporter's naming, e.g. `aws_rds_database_connections_average`):
   ```promql
   aws_rds_database_connections_average{dbinstance_identifier="rch-prod"} > 0.8 * <max_connections>
   ```
   `<max_connections>` is fixed for the instance class (`SHOW max_connections;`) — compute it
   once and hardcode the threshold in the alert rule. This is a safety net for connections opened
   outside the app (a psql session left open, a burst of migrate initContainers opening a
   connection each during a large rollout) — the app's own pool is item 4, above.
7. **RDS free storage < 20% — runbook-only, needs CloudWatch.**
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

**`GET /events` carries no CORS headers.** Registered outside `mount()` and the route manifest
(`plugins/sse.ts` directly), it never runs through `@fastify/cors`'s hooks the way every
ordinary route does — `curl -D - -H "Origin: http://example.com" .../events` comes back with no
`vary: Origin`, no `access-control-allow-credentials`, nothing, where the same request against
`.../stock` gets both. Every deployed topology today is same-origin (nginx proxies `/api`), so
nothing breaks — but a split-origin deployment would need CORS wired onto this route
specifically before anything else works cross-origin. Still open at the end of Phase 6, unchanged
from Phase 5's note; nothing in this phase touched the route.

**`MAX_STREAMS_PER_USER` is 8** (`apps/api/src/plugins/sse.ts`) — a signed-in employee opening a
ninth simultaneous stream is refused with `You already have 8 screens listening for updates.
Close one and try again.` (a `429`). This is easier to reach than it sounds: five browser
contexts open for one employee inside a single Playwright run (`e2e/tests/*.spec.ts`) is normal,
and the smoke has driven it there without incident — sixteen stream opens and sixteen closes,
zero 429s, across one CI run. If a real shift ever hits this limit it reads as several tabs left
open on one login, not a server problem; ask the operator to close some.

## 11. Go-live checklist

### The release, prepared and not performed (2026-09-04)

Phase 6 ends here. Everything the first production deploy needs is written down; **nothing in
this build pushes `staging` or `production`** — promotion is a release decision and the branch
pushes below are the account owner's to run, not any agent's. The only `git push` anywhere in
`.github/workflows/**` is `deploy.yml:89`, which tags a *release* after a deploy has already
happened; no workflow, script or task in this repository pushes either branch.

**Where the branch stands.** `feat/phase-6-ops-go-live` is **36 commits** ahead of `develop`, and
`origin/staging` is an ancestor of `origin/develop` — so every promotion below is a genuine
fast-forward, as §11.3 of the design spec requires. Confirm both before starting:

```bash
git log --oneline develop..feat/phase-6-ops-go-live | wc -l              # 36
git merge-base --is-ancestor origin/staging origin/develop && echo ok    # ok
```

**1. The five `FILL` values only the account owner can supply**, each marked `# FILL` in
`deploy/chart/rch/values-prod.yaml` at the line given:

| Line | Key | What goes in |
|---|---|---|
| 5 | `image.registry` | `<account>.dkr.ecr.<region>.amazonaws.com`. `deploy.yml` also passes it as `--set image.registry=${{ secrets.ECR_REGISTRY }}`, so the file's own value only matters to a manual `helm template` / `helm upgrade`. |
| 23 | `api.env.CORS_ORIGIN` | The real hostname, no trailing slash (currently `https://rch.example.com`). |
| 41 | `ingress.host` | The real hostname (currently `rch.example.com`). |
| 42 | `ingress.certificateArn` | The ACM certificate ARN for that host. Empty renders **no** TLS annotation — HTTP on `:80`, correct rather than broken, but not what go-live wants. |
| 75 | `alerts.runbookUrl` | The real URL of this document, so a paged engineer's alert links somewhere. |

**And one in the other file**, the same shape and the same decision:

| File | Line | Key | What goes in |
|---|---|---|---|
| `deploy/chart/rch/values-staging.yaml` | 6 | `ingress.certificateArn` | The ACM certificate ARN for `rch-staging.example.com`. Empty renders no TLS annotation — staging on HTTP `:80`, correct rather than broken. Fill it, or decide out loud that staging runs on `:80`. |

The key was absent from that file entirely until the Phase 6 fix wave, while step 1 below had
always said both files need one; it is now present and empty, with production's own `# FILL`
comment beside it, and `render.test.sh` asserts for staging what it asserts for production —
empty renders **no** annotation, a supplied ARN renders one.

Two more carry a `FILL` comment but are conditional, not blocking: `serviceAccount.annotations`
(only for IRSA, if the pod reads Secrets Manager itself) and
`ingress.annotations.'alb.ingress.kubernetes.io/wafv2-acl-arn'`, whose own comment says
"optional; leave empty to skip".

Render the production chart before pushing anything, supplying the values on the command line:

```bash
helm template rch deploy/chart/rch -f deploy/chart/rch/values-prod.yaml \
  --set image.registry=<account>.dkr.ecr.<region>.amazonaws.com,image.tag=<sha> \
  --set ingress.certificateArn=<acm-arn> --set-string secrets.values.DATABASE_URL=x
```

**2. The secrets and the variable the account owner creates.** None of these exist yet; the
deploy workflow is inert without them.

| Where | Name | Notes |
|---|---|---|
| Repository **variable** | `DEPLOY_ENABLED=true` | `deploy.yml:21` gates every deploy job on it; `:93` is the "Deploy skipped" job that runs instead. Until it is `true`, a push to `staging` or `production` deploys nothing. |
| Repository secret | `AWS_ROLE_ARN` | The OIDC role the workflow assumes. |
| Repository secret | `AWS_REGION` | |
| Repository secret | `ECR_REGISTRY` | Passed as `--set image.registry`. |
| Repository secret | `EKS_CLUSTER_STAGING` | |
| Repository secret | `EKS_CLUSTER_PROD` | |
| `staging` environment | `DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | Staging reads its secrets from the GitHub environment; production reads `rch/prod` out of AWS Secrets Manager through the `ClusterSecretStore`. |
| AWS Secrets Manager `rch/prod` | `DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY` | The last may start empty. Mint the pair with `pnpm --filter @rch/api keys:generate`, which prints two `JWT_*=` lines and never writes them anywhere. |

**3. The promotion, in order, run by a person.**

```bash
git checkout develop    && git merge --ff-only feat/phase-6-ops-go-live && git push
git checkout staging    && git merge --ff-only develop && git push        # deploys rch-staging
# verify staging: /readyz, a sign-in, one real sale, rebuild-balances reconciling (step 8 below)
# re-measure the load check against staging and record it against §12's targets (§12 above)
git checkout production && git merge --ff-only staging && git push        # waits for approval
```

Production's deploy waits on the `production` GitHub environment's approval before the job runs.
Work the numbered checklist below alongside these three commands — in particular step 4, which
deactivates the six seeded accounts, and step 5, the real restore drill. **Then, and only then,
is this build in a hospital.**

### The checklist

An ordered list. Each item is a command or a decision, and each decision names who makes it —
the account owner, not the executor of this phase's tasks. Nothing on this list has been run
against a real AWS account; Phase 6 prepared the chart, the workflow and this checklist and
stopped there (spec §16, Phase 6) — running it is a release decision.

1. **Fill in the AWS facts the two values files are still missing** — `values-prod.yaml`'s five
   `# FILL` markers, its two conditional ones, and `values-staging.yaml`'s own
   `ingress.certificateArn`, all tabulated with their line numbers under "The release, prepared
   and not performed" above. Render the chart with the values supplied on the command line
   before pushing anything.
2. **Provision the RDS instance to spec §11.2's own settings**, before anything points at it:
   Multi-AZ, `db.t4g.medium` to start with storage autoscaling, automated backups retained 14
   days, point-in-time recovery, encryption at rest, deletion protection, in private subnets
   with a security group admitting only the EKS node group, and `rds.force_ssl = 1` (the API
   connects with `sslmode=verify-full` and the RDS CA bundle already baked into the image — no
   chart change needed once the instance itself enforces it). Staging's own instance is
   single-AZ, `db.t4g.small`, 7-day backups — smaller on purpose, not a step skipped.
3. **Generate the production JWT key pair and store it, never in git:**
   ```bash
   pnpm --filter @rch/api keys:generate
   ```
   Put both lines into the AWS Secrets Manager secret `rch/prod` as `JWT_PRIVATE_KEY` /
   `JWT_PUBLIC_KEY`, alongside `DATABASE_URL` and an empty `JWT_PREVIOUS_PUBLIC_KEY` (§2's
   "First-time cluster setup" names the same four keys and the `ClusterSecretStore` they need).
4. **Create the real staff accounts, and deactivate every seeded one.**
   ```bash
   kubectl exec deploy/rch-api -n rch -- /nodejs/bin/node dist/cli/users.mjs create \
     --emp RC-9001 --name "Real Name" --email real.name@royalcare.in --role counter --loc coffee --password <temporary>
   ```
   one per real employee (§5 above has the full flag list), then deactivate the six the seed
   ships (`RC-4471`, `RC-3120`, `RC-2088`, `RC-1902`, `RC-1550`, `RC-4482`):
   ```bash
   kubectl exec deploy/rch-api -n rch -- /nodejs/bin/node dist/cli/users.mjs deactivate --emp RC-4471
   ```
   repeated for each of the six. **The seeded accounts must not exist, active, in production** —
   nothing before this checklist has said that plainly, and it is the one item on this list a
   missed step could not later be quietly forgiven for: a seeded id with a published dev password
   is a real door into a real hospital's billing.
5. **Run the restore drill once against the real RDS instance** (§6, the RDS procedure below the
   local rehearsal) — not the rehearsal, the real one, before the first bill is ever posted for
   real.
6. **Create the repository variable and every secret** — `DEPLOY_ENABLED=true`, the five
   repository secrets, the `staging` environment's three, and AWS Secrets Manager's `rch/prod`:
   the table under "The release, prepared and not performed" above lists each one and what it
   populates, and §2 says where the workflow reads it.
7. **Promote** — the three fast-forward merges under "The release, prepared and not performed"
   above, in that order, run by a person. `develop` first, then `staging`, then `production`;
   verify staging between the second and the third (step 8), and production's deploy waits for
   the `production` GitHub environment's approval before the job runs.
8. **First post-deploy checks, on each environment, in order:**
   ```bash
   kubectl -n <namespace> port-forward svc/rch-api 3000:3000 &
   curl -fsS http://localhost:3000/readyz
   # /readyz and /healthz are served at the root, outside API_PREFIX; only /api/v1/* goes
   # through the ingress's /api rule, so https://<host>/api/v1/readyz is not a route at all.
   ```
   then sign in as a real account through the browser, take one real sale, and finally
   ```bash
   kubectl exec deploy/rch-api -n <namespace> -- /nodejs/bin/node dist/cli/rebuild-balances.mjs
   ```
   and confirm it reports success with no unexpected drift. A green `/readyz` alone is not
   enough — it proves the database is reachable and migrated, not that a bill can be posted.

## 12. Load check

`apps/api/scripts/loadcheck.mjs` measures the two latencies spec §12 sets a number for —
`GET /snapshot` p95 ≤ 150 ms, `POST /bills` p95 ≤ 200 ms — by hand, against a port-forwarded
staging pod, not in CI. A shared CI runner measures the runner, not the server; this is
deliberately a by-hand step run once before go-live and recorded, not a gate every push runs.

```bash
kubectl port-forward -n rch-staging svc/rch-api 3000:3000 &
LOADCHECK_PASSWORD=<staging-seed-password> node apps/api/scripts/loadcheck.mjs --base http://localhost:3000 --emp RC-4471
LOADCHECK_PASSWORD=<staging-seed-password> node apps/api/scripts/loadcheck.mjs --base http://localhost:3000 --emp RC-4471 --concurrency 30
```

The password comes from `LOADCHECK_PASSWORD`, not `--password` — a flag is left in the shell
history and in `ps` for as long as the run lasts; the script still honours `--password` and
warns when it is used, but the environment variable is the one to reach for. `--help` prints the
full flag list.

**Never point this at production.** `POST /bills` is a real sale — it moves real stock and
posts a real bill against whichever database `--base` resolves to, exactly as `pnpm test:e2e`'s
smoke does (§13) and for the same reason: there is no dry-run flag, and a stray `--base` pointed
at the production API would sell real stock at the concurrency the run asks for.

Before trusting a number, set up the run correctly — three things the wave-2 baseline run got
wrong before they were understood:

- **Raise `RATE_LIMIT_PER_MINUTE` for the run.** The limiter keys an authenticated request on
  `req.user.sub`, so every concurrent worker sharing the script's one bearer token draws from a
  single per-minute budget — at concurrency 10–30 the run measures 429s in the first second or
  two, not endpoint latency, unless the limit is raised well above what the run will throw at it.
- **Make sure the item the script sells has stock for the whole run.** `pickSellable` reads the
  signed-in user's own menu and shelf; a freshly seeded counter's stock is small by design (the
  seed's own coffee-shop stock is not sized for a load run). Top it up with a direct
  `stock_moves` insert (`kind: 'adjustment'`, mirroring `db/seed.ts`'s own shape) followed by
  `pnpm --filter @rch/api db:rebuild-balances` — never a direct edit to `stock_balances` itself.
  Reseeding and topping up stock is exactly what `loadcheck.mjs`'s own refusal message points at
  if the run runs dry mid-flight.
- **Run it alone, on as quiet a machine as you can get.** A wave-2 baseline taken at a host load
  average of ~19 (six other processes competing for the same CPU) failed §12's targets by 4–15×
  — a real finding about the *measurement*, not the server. Record the machine's `uptime` load
  average beside every number this script prints; a number with no load average beside it is not
  evidence of anything.

**Recorded: 2026-09-04, the first measurement anyone can attribute**, and re-measured the same
day once `GET /snapshot` stopped fanning out across the pool. MacBook Air (Mac14,2, Apple
silicon, 8 cores, 16 GB, macOS 26.6.2), node v24.20.0, **Postgres 17 in Docker on the same
machine** — which production's will not be. The API was the only thing running, started with
`RATE_LIMIT_PER_MINUTE=100000`, against a fresh seed with `coffee`'s `water` topped up to 200,012
by a `stock_moves` adjustment and a rebuild, exactly as the three bullets above prescribe. No run
in either column returned a single non-2xx. (The snapshot-only row also carried a once-a-second
`curl /metrics` beside it, for the pool depths quoted below — one request a second against a run
throwing thirty at a time.)

| Concurrency | Load average at the start | `GET /snapshot` | `POST /bills` |
|---|---|---|---|
| 10 | 3.59 | **PASS** p50 74.8 ms · **p95 102.7 ms** · p99 122.6 ms · max 151.5 ms · n=2601 | **PASS** p50 43.6 ms · **p95 126.1 ms** · p99 194.4 ms · max 362.8 ms · n=3656 |
| 30 | 3.81 | **FAIL** p50 1440.6 ms · **p95 1548.1 ms** · p99 1601.6 ms · n=441 | **FAIL** p50 134.3 ms · **p95 248.0 ms** · p99 1061.7 ms · n=3833 |
| 30, `--no-writes` | 3.00 | **FAIL** p50 2904.0 ms · **p95 3347.3 ms** · p99 3631.9 ms · n=228 | — |

**What changed, and what it bought.** Every read now runs inside one `read only` transaction
(`withReadTransaction`, `apps/api/src/lib/db.ts`), so one request takes **one** connection instead
of the ~40 acquisitions `GET /snapshot`'s `Promise.all` of twenty-four readers used to make. The
queue depth says it plainly: sampled once a second through the c=30 snapshot-only run,
`pg_pool_total` 10, `pg_pool_idle` 0, and `pg_pool_waiting` peaking at **20** — which is exactly
30 concurrent requests minus a pool of 10, where the same sampling before the change read
**771**. c=30 `GET /snapshot` came down from p95 2860.3 ms to 1548.1 ms and throughput from 12
snapshots a second to 22; c=10 is unchanged within noise (104.5 → 102.7 ms), which is the point —
the fan-out never bought latency, it only bought queueing.

**It still misses 150 ms at c=30, and that is now honestly the pool, not the request.** Thirty
concurrent readers against ten connections means two thirds of them wait, and on this laptop a
snapshot holds its one connection for the whole of its ~40 sequential round trips. `DB_POOL_MAX`
is the knob (default 10, deliberately not raised here — see the three things below), and §12
states the target **for the staging instance**, which is where the numbers that count will be
taken. Nothing about correctness is in question: these are latencies under queueing, and
`RchApiPoolSaturated` already alerts on exactly the `pg_pool_waiting > 0 and pg_pool_idle == 0`
condition the table above shows.

**The previous measurement, kept for the comparison** (same machine, load averages 2.72 / 2.56 /
3.34, before the read transaction): c=10 `GET /snapshot` p95 104.5 ms and `POST /bills` p95
141.6 ms, both PASS; c=30 p95 **2860.3 ms** (n=245) and 262.2 ms; c=30 `--no-writes` p95
**4429.7 ms** (n=172), with `pg_pool_waiting` peaking at 771. Note the load averages: the second
measurement was taken on a *busier* machine than the first and still came out ahead.

When a target is missed on a genuinely idle machine, the first three things to look at, in
order:

1. **Connections per request.** This is the one that was actually wrong, and it is fixed: every
   read now runs inside one `read only` transaction (`withReadTransaction`,
   `apps/api/src/lib/db.ts`), so `GET /snapshot` takes **one** connection rather than the ~40 its
   `Promise.all` of twenty-four readers used to ask for. `apps/api/src/modules/snapshot/
   snapshot.test.ts`'s "one request, one connection" cases count the pool's own `acquire` event
   and fail if that ever comes back. If a *new* read is slow under concurrency, check it went
   through `withReadTransaction` before checking anything else.
2. **The pool size**, now the env knob `DB_POOL_MAX` (default **10**, set in the chart's
   `api.env` for both environments). With one connection per request this is "how many requests
   at once", so `pg_pool_waiting > 0` with `pg_pool_idle == 0` — which is exactly what
   `RchApiPoolSaturated` alerts on — means genuinely that many concurrent requests, not one
   request holding forty. Raise it only alongside the instance behind it: three replicas × 10 is
   already 30 of RDS's own connection budget.
3. **The RDS instance class** (`db.t4g.medium` in staging is not sized for a load test's
   concurrency, only for real traffic's).

## 13. The end-to-end smoke

`pnpm test:e2e` (root) runs the Playwright suite in `e2e/` — six files, eight scenarios, twelve
runtime tests (the sign-in loop is five of them) — one real browser driving a real running stack
from sign-in to a settled write. It knows nothing about
the workspace's internals: no import from `packages/contract` or the UI's own source, only
employee numbers, URLs and the sentences the server actually sends. `e2e/README.md` is the fuller
reference — what each spec proves, the local run sequence, and the "Known switches" table for any
environment-gated assertion still landing.

**Locally:** against `pnpm dev`'s stack (API `:3000`, UI `:5173`), seeded with
`SEED_FORCE_PASSWORD_CHANGE=false` (six accounts sign in in one run; a forced password rotation
on the first one strands every account after it on a password nothing else knows) and both login
rate limits raised (`LOGIN_RATE_LIMIT_PER_MINUTE=200`, `LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE=100`
— the run signs in roughly sixteen times through one dev-proxy IP, which the defaults of 10/min
and 5/min-per-employee both refuse partway through).

**Run twice on 2026-09-04, green both times:** 12 passed in **40.2 s**, then a
`SEED_FORCE_PASSWORD_CHANGE=false pnpm --filter @rch/api db:seed --force` and 12 passed again in
**38.5 s**, against `pnpm dev`'s stack with both login limits raised as below. The second run
proves the suite does not depend on the first's leftovers — it reads its ids out of the toasts,
and `sequences` survives a reseed. `kind` is not installed on the machine that ran them, so the
cluster path below was **not** exercised locally; it is proved by CI.

**In CI:** `E2E=1` is set on exactly one step, "helm install into kind"
(`.github/workflows/ci.yml:127-129`), which runs `deploy/chart/rch/ci/install-test.sh` — that
one script does both the `helm install` and the `helm upgrade` internally, and with `E2E=1` in
its environment it appends the same three settings as `--set-string` overrides to both —
`SEED_FORCE_PASSWORD_CHANGE=false`, `LOGIN_RATE_LIMIT_PER_MINUTE=200`,
`LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE=100` — on top of the chart's own defaults, then runs
`pnpm test:e2e` against the kind cluster's UI service once `/healthz` answers.

**It writes real bills, real tickets, real support tickets — real documents against whatever
database it is pointed at.** `pnpm test:e2e` and the CI job both point at a database seeded
(or reseeded) for the purpose: local `pnpm dev`'s `rch` database, or the kind cluster's
CI-only Postgres. **The end-to-end smoke must never be pointed at production, or at any database
whose stock and bills matter.** There is no dry-run flag and no confirmation prompt — a stray
`E2E_BASE_URL` pointed at a real hospital's till would sell six real juices and hand over a real
ticket nobody asked for. `apps/api/scripts/loadcheck.mjs` (§12, above) carries the equivalent
warning for the same reason.

## 14. Procurement and quarantine

Buying (Phase 5) is `requisitions`, `purchaseorders`, `grn`, `vendors`, `contracts` and
`productreqs` — vendors, requisitions, the purchase-order lifecycle and goods receipt, all
server-side. The one thing worth knowing before touching any of it by hand: the procurement
list is a **query**, not a table, and only one number on a requisition line is ever stored.

**Reading a purchase order's claim:**

```sql
select l.line_no, l.item_key, l.qty, l.received_qty, s.requisition_id, s.requisition_line_no, s.qty
from po_lines l left join po_line_sources s on s.po_id = l.po_id and s.line_no = l.line_no
where l.po_id = 'PO-2026-0143' order by l.line_no, s.seq;
```

The sources are in the order the buyer picked them, which is the order a release walks
**backwards**.

**What is still on the procurement list:**

```sql
select r.id, l.line_no, l.item_key, l.approved_qty - l.ordered_qty as pending
from requisitions r join requisition_lines l on l.requisition_id = r.id
where r.status in ('Approved','Partially approved') and l.approved_qty > l.ordered_qty
order by r.id, l.line_no;
```

There is no pool table; this query *is* the list.

**A claim that looks wrong:** `ordered_qty` is only ever moved by `createPo`, `updatePoLine`,
`removePoLine`, `cancelPo` and `closePoShort`, each inside one transaction holding the order's
row and the requisition rows. If a number is off, read `document_history` for that order first
(`select * from document_history where doc_type = 'purchase_order' and doc_id = '…' order by
at;`) — do not correct it with an `UPDATE`.

**Reading a goods receipt's ledger:**

```sql
select * from stock_moves where ref_type = 'grn' and ref_id = 'GRN-260143-01';
```

One positive row at `store` for what was accepted, one positive row at `quarantine` for what
was rejected, and no row at all for a quantity of zero.

**GRN numbering, as of Phase 6:** `GRN-<yy><po number>-<nn>` — the second instalment against
`PO-2026-0143` is `GRN-260143-02` — where `nn` counts that order's own instalments. There is
**no `sequences` row for it**; the count is read under the order's `for update` lock, which is
what stops two receipts drawing the same number. Do not "fix" a gap — there cannot be one.
`packages/domain/src/ids.ts`'s `grnId(poId, n)` is the one place the format lives.

**The format changed because the old one collided.** Before Phase 6 a GRN was
`GRN-<last 3 of the PO>-<nn>`. Two purchase orders whose ids shared the same last three
characters — `PO-2026-0143` and `PO-2027-0143`, both ending `143`, or `PO-2026-0143` and
`PO-2026-1143` — minted the same GRN id for their first receipt; the `grns` primary key refused
the second one outright, an ordinary constraint error in the middle of a receiving desk's day
rather than a store-worded refusal. **GRNs written before the change keep their old,
three-character-tail ids** — nothing was renumbered, and there is no backfill; a receipt whose
id reads `GRN-143-01` is simply an older one, not something to correct by hand.

**Quarantine:** `select * from stock_balances where loc = 'quarantine';` is what the store
keeper's screen shows. Nothing issues, sells or transfers from there and **there is no
endpoint that takes stock back out** — a purchase return or a debit note was considered and
declined (spec §16, Phase 5; `docs/ua-spec.html` §09 records it by name), not deferred to a
later phase. A correction is, and stays, an `adjustment` move written by hand through
`db:rebuild-balances`-safe SQL (the move, never the balance).

**A refused receipt:** a `POST …/receive` that answered 422 has written nothing — no GRN row,
no move, no change to `received_qty` — because every line is validated before the first write.

**Two reactivations of a rate contract at once:** `PATCH /contracts/:id {"active":true}` checks
for an existing live contract on that vendor and item, but the check locks nothing when it finds
none, so two reactivations of two closed contracts for the same pair race and the partial unique
index `rate_contracts_live_uq` decides. The loser reads the ordinary refusal (`<item> already has
a live contract with <vendor>`), not a 500: `contractsRepo.update` catches the violation on that
index by constraint name (`isUniqueViolation` in `lib/db.ts`, the same helper `vendors` uses) and
the service refuses with the sentence it had already composed. Nothing to do; no data is at risk.
