# RCH — Operations Runbook

Operational procedures for the Royal Care Hospital F&B backend (`apps/api`, `UI/`,
`deploy/chart/rch`). See `docs/superpowers/specs/2026-09-03-backend-design.md` for the design
this implements; this document is the "how to actually do it" companion.

## 1. Local development

```bash
pnpm db:up                                    # postgres:17 in Docker, host port 5439 -> container 5432
cp .env.example .env
# then edit .env: SEED_PASSWORD= needs a value of your own, at least 12 characters
pnpm --filter @rch/api keys:generate >> .env   # appends JWT_PRIVATE_KEY= / JWT_PUBLIC_KEY=
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed
pnpm dev                                       # turbo run dev --parallel: api on :3000, UI on :5173
```

**`SEED_PASSWORD` has no default any more** and `apps/api/src/config.ts` requires at least twelve
characters, so a copied `.env.example` will not start the API, `pnpm test`, or any CLI until one
is chosen — the failure is `Invalid environment:` naming the variable. That is deliberate: a
published default password on a host anyone can reach is a real door, and a seed rewrites every
seeded account's password. A database already seeded keeps whatever password it was seeded with;
only a new seed uses the new value.

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

Two more guards sit on the seed, and both key on `NODE_ENV`:

```bash
pnpm --filter @rch/api db:seed --yes-seed rch                          # required wherever NODE_ENV=production
pnpm --filter @rch/api db:seed --force --yes-seed rch --yes-destroy rch   # and --force there
```

**Both flags name the database, and both must equal `select current_database()`**; naming the
wrong one (or nothing) exits 2 saying which was expected and which was given. `--yes-seed` guards
the passwords a plain seed rewrites, `--yes-destroy` the tables `--force` empties first. **This is
not only about a real hospital: the chart renders `NODE_ENV=production` into every pod**, so any
in-cluster seed — dev, CI's kind cluster, staging — is the `--yes-seed <name>` form (§15.7, and
`deploy/chart/rch/ci/install-test.sh`). Naming the database is the point: a flag typed on every
in-cluster seed is a flag nobody reads, and `--yes-seed rch_dev` cannot be muscle memory for
`rch`. `--allow-production` is still recognised, and on its own is now **refused** with a sentence
naming `--yes-seed`, so an old runbook line fails loudly instead of quietly doing the wrong thing.
Development and test are unchanged. The rules themselves are one pure function,
`apps/api/src/lib/seed-guard.ts`.

### Test users

Seed password is `SEED_PASSWORD` from `.env` — **required, at least twelve characters, no default**
(see above). In staging/prod seeds, `SEED_FORCE_PASSWORD_CHANGE=true` forces a password change at
first sign-in.

| Employee id | Name | Role | Home location |
|---|---|---|---|
| `RC-4471` | Kavitha Raman | Counter Operator | coffee |
| `RC-3120` | Ramesh Kumar | Outlet Manager | rest |
| `RC-2088` | Suresh Muthu | Store Keeper | store |
| `RC-1902` | Vinoth Prakash | Kitchen In-charge | kitchen |
| `RC-1550` | Latha Narayanan | Procurement Officer | store |
| `RC-4482` | Deepa Selvam | Counter Operator | kiosk |

Sign in at `http://localhost:5173` with an employee id and the seed password.

None of the six carries the admin flag — account management (create/reset/deactivate/reassign a
colleague from a page instead of this CLI) is a capability, not a role, and the only door onto it
is:

```bash
pnpm --filter @rch/api users set-admin --emp RC-4471 --on   # --off takes it away again
```

Flip it on whichever seeded account is convenient for local testing; in a real environment, flag
a real account the same way. There is no route or button anywhere in the app that can grant or
revoke this flag — only this command, run with a shell on the box or a `kubectl exec` into the
pod, which is what keeps a compromised or misused admin session from ever minting a second one.

### Auth and rate-limit settings

From `.env` / `apps/api/src/config.ts` (mirrored in `deploy/chart/rch/values.yaml`'s `api.env`
in the cluster):

- `LOGIN_RATE_LIMIT_PER_MINUTE` (default `10`) — `/auth/login` attempts per minute, keyed by
  the caller's IP.
- `LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE` (default `5`) — `/auth/login` attempts per minute,
  keyed by the employee id being signed in as, independently of the per-IP limit above.

  **Both budgets are per pod, not cluster-wide** — and neither line above said so until the audit
  fix wave. `@fastify/rate-limit` keeps its window in the process's own memory, and so does the
  per-employee gate, so the number an attacker actually gets is the configured one **times the
  replica count**. `apps/api/src/modules/auth/service.ts` used to claim the per-IP limit was
  effectively cluster-wide because the load balancer fronted it; that was wrong, and its comment
  now says what is true. A shared store (Redis) is the fix if either ever has to be exact; none is
  deployed and none is planned. Size the numbers against the replica count, not against one pod.

  **The per-employee budget counts failures only, and is spent the moment an attempt starts.**
  Five correct sign-ins in a minute lock nobody out — the slot is given back when the password
  proves right. A wrong one keeps its slot for the window. The attempt is charged *before* the
  password is verified, because Argon2 takes 50–100 ms and a budget charged afterwards let a
  hundred simultaneous guesses at one id all reach the verifier. The consequence to know before
  somebody reports it as a bug: a **sixth simultaneous** sign-in at one employee id is refused
  whether the password is right or wrong, since the server cannot know which until it has
  verified. Six tills signing in on the same id within the same second is the only way to see it,
  and the answer is to wait a minute.
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
- `SEED_PASSWORD` — **required**, minimum twelve characters, no default (above). In the cluster it
  is a `secretKeyRef` like the JWT keys, never a plaintext `value:`.
- `DATABASE_SSL` — **left unset it follows `NODE_ENV`**: TLS on in production, off everywhere
  else. Setting it still wins in both directions (a staging pod pointed at a local proxy can turn
  it off), and `.env.example` ships it commented out for exactly that reason. `db/client.ts`
  strips any `sslmode`/`ssl*` parameter off `DATABASE_URL` first, so a connection string can never
  quietly choose a different trust store than the RDS bundle.

### A sign-in that is refused

The browser shows the refusal on the sign-in form itself — "That employee id and password do
not match." — and that one sentence covers three cases on purpose: no such employee id, a wrong
password, and a deactivated account. The API tells them apart on the request's own log line,
never in the response:

```bash
kubectl logs deploy/rch-api -n <namespace> | grep '"route":"/api/v1/auth/login"' | grep '"status":401'
```

Each such line carries `"refusal":{"code":"unauthenticated","message":"…","cause":"…"}`, and
`cause` is one of `no such employee`, `wrong password for RC-4471` or `RC-4471 is deactivated`.
An id that matched nobody is deliberately not written into the log — what was typed into that
box may well have been the password. Every other 4xx carries the same `refusal` field (its
`code` and the sentence the caller read); a 5xx is logged in full under `"msg":"unhandled"`,
and the sentence the caller read ends with the request id to look it up by.

A forgotten password is reset with `users reset-password` (§5); the account then carries
`must_change_password` and is asked to choose a new one at its next sign-in. A seeded account's
password stops being the seed password the moment somebody signs in as it and goes through that
step — `RC-4471` on `dev` did, on 2026-09-07 — so "the seed password does not work" for one
seeded id and not the others is that, not an outage.

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

**The snapshots are reconciled — `meta/0012_snapshot.json` is what the next `db:generate`
diffs against.** All six of `0007`–`0012` were written by hand, so `drizzle/meta/` sat at
`0000`–`0006` and the next generate would have tried to re-emit everything those six already did.
That reconcile was run once, on 12 September 2026: the emitted SQL restated `0007`–`0012` and
nothing else, which is the proof that `src/db/schema/*.ts` and the applied SQL agree, and **no
schema file needed changing**. The emitted `.sql` and its journal entry were deleted and the
snapshot renamed; nothing was applied to any database by it.

The next hand-written migration will need the same pass, and the procedure is written up in
`apps/api/CLAUDE.md`'s *Migrations* section — including the four drizzle-kit behaviours it rests
on, one of which will bite whoever ignores it: **a hand-written `when` must be in the past**,
because the migrator applies a file only where its `when` is greater than the highest
`created_at` already recorded, and a later migration carrying a smaller one is **silently
skipped** with no error anywhere.

`pnpm --filter @rch/api db:migrate` applies pending migrations; it is what the `migrate`
initContainer on every api pod also runs (`dist/cli/migrate.mjs`) — see §2. It runs with **no
statement timeout and no lock timeout** (`statementTimeoutMs: 0`, then `set lock_timeout = 0`
before `pg_advisory_lock(727272)`), as do `db:seed`, `db:rebuild-balances` and the purge: waiting
on that advisory lock behind another replica is the whole point of the initContainer, and the
API's ordinary 15 s statement timeout was cancelling the wait mid-rollout, which presents as
`Init:CrashLoopBackOff`.

**Thirteen migrations exist** (`apps/api/drizzle/0000`–`0012`): `0000` is the initial schema, `0001` adds
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
item. Phase 6 wrote no migration. The audit fix wave wrote two: `0007_idempotency_committed_at`
adds one nullable column, `idempotency_keys.committed_at`, which is what lets a claim say its
write actually committed; `0008_integrity` adds the index and foreign key on `reservations`, the
`tickets.otp_attempts` column and the `otp` type change with its digits check, eight more named
CHECK constraints, and an append-only trigger on `document_history` (§7 below has the list).

The wave's fourth block wrote four more, one per capability, and all four are small.
`0009_payers_audit` gives `payers` the `created_at`/`updated_at` every other master table already
carried. `0010_adjustments` adds the `adjust_reason` enum, the `adjustments` and
`adjustment_lines` tables, their four foreign keys, an index on `(loc, at)`, and the
`sequences` row `ADJ-` numbers are drawn from — the one migration in the set that inserts data as
well as schema. `0011_prod_orders_need_by` adds one nullable `date`. `0012_bills_void` adds
`bills.voided_at`, `voided_by` and `void_reason` plus the `voided_by` foreign key to `users`.
None of the four validates an existing row, so none of them can refuse the way `0008` can.

A fresh `db:migrate` against an empty database reports all thirteen applied; against an
already-current one it reports `migrations applied: 13 / 13`, which is also what `/readyz`
compares against. Both numbers were proved on a scratch database created and dropped for the
purpose — a first migrate from empty, then a second run on the same database to prove the
migrate is idempotent.

**`0008` validates existing rows, so on any database with data in it, probe before you migrate.**
The five likeliest, and what to do about each — `apps/api/scripts/preflight-0008.sql` probes all ten:

```sql
select * from stock_moves where qty = 0;                                          -- stock_moves_qty_ck
select r.* from reservations r left join tickets t on t.id = r.ticket_id
  where t.id is null;                                                             -- reservations_ticket_fk
select * from tickets where from_loc = to_loc;                                    -- tickets_from_to_ck
select * from po_lines where rejected_qty > received_qty or received_qty < 0;     -- po_lines_receipt_ck
select * from batches where made_qty > started_qty or made_qty < 0;               -- batches_made_ck
```

Each should return nothing; every one of them describes a state no endpoint can produce. If one
does return rows, the fix is a decision, not a delete. A zero-quantity `stock_moves` row is inert
and can be deleted — but `stock_moves` is trigger-protected against DELETE (`0002`), so drop the
trigger, delete, and re-create it from `0002`'s own SQL in one transaction. A `reservations` row
pointing at a ticket that does not exist is a hold nothing can ever release: close it
(`update reservations set released_at = now() where id = …`) and tell the location, because their
free-to-promise is about to rise. A ticket from a location to itself, a `po_lines` row with more
rejected than received, or a batch that yielded more than it started are each data that was never
possible through the API — read `document_history` for the document first and correct it by hand
with somebody watching. Run the probes on a restored copy if the production window is tight; they
are plain reads and cost nothing.

One more thing worth a look on the same pass, and it is not a `0008` constraint. Before the audit
fix wave a purchase order reached `Received` on what **arrived**, so an order whose delivery was
rejected in part or whole could be sitting at `Received` — which is terminal, closing both the
close-short and the cancel doors — with the balance still genuinely owed:

```sql
select p.id, l.line_no, l.qty, l.received_qty, l.rejected_qty
from purchase_orders p join po_lines l on l.po_id = p.id
where p.status = 'Received' and l.rejected_qty > 0
  and round(l.received_qty - l.rejected_qty, 3) < l.qty;
```

There is **no backfill migration** for this, on purpose: only a dev database could hold one, and
dev is reseeded. If a real order ever does turn up, the correction is one statement —
`update purchase_orders set status = 'Partially received' where id = '…';` — after which the
buyer's own close-short door works again and hands the shortfall back to the requisition. Do it
with the buyer watching, and write down why.

## 2. Deploy

**A deploy is triggered by CI passing, not by the push.** `.github/workflows/deploy.yml` is
`on: workflow_run: { workflows: ["CI"], types: [completed], branches: [develop, staging,
production] }`, and every job carries `github.event.workflow_run.conclusion == 'success'`. The
old `on: push` fired deploy.yml *alongside* ci.yml, so a red typecheck, a failed test or a
CRITICAL in an image could reach a cluster while CI was still running — the two were racing, not
ordered. **All three jobs** additionally require `github.event.workflow_run.event == 'push'`:
`branches:` matches the CI run's head branch, so a pull request raised **from** `staging`
**into** `production` — the documented hotfix flow — would otherwise satisfy it and deploy an
unmerged PR head. The clause is repeated on `deploy` and `skipped` rather than left to `guard`
alone because `needs: guard` skips a dependent only when guard's *result* is failure or
cancelled — a job skipped by its own `if:` is not a failure, and a dependent still runs.

Everything the workflow uses is pinned to `github.event.workflow_run.head_sha` /
`head_branch`. **`github.sha` and `github.ref_name` are not usable under this event** — they
point at the default branch's tip, not at what CI just passed — so if you add a step, take the
branch and the commit from `head_branch`/`head_sha` like every other step does.

It is still gated by the repository variable `DEPLOY_ENABLED=true` (the `skipped` job runs
instead). It builds and pushes the `api` and `UI` images to ECR, **scans the two tags it is
about to deploy** (see below), then `helm upgrade --install rch deploy/chart/rch -f
values-<env>.yaml --set image.tag=<sha> --namespace <namespace> --create-namespace --wait
--timeout 15m`, with `--atomic` on dev and staging only. `develop` is `values-dev.yaml` /
`rch-dev` — the only one of the three actually deployed today, at
`https://rch.hashtrickstechnologies.com`; §15 records how it was stood up on AWS and what
tripped on the way. `staging`/`production` are `values-staging.yaml`/`values-prod.yaml` and
`rch-staging`/`rch`, prepared but not yet provisioned (§11).

### Two consequences of `workflow_run` worth knowing before you need them

1. **GitHub always runs the DEFAULT branch's copy of `deploy.yml`.** A `workflow_run` handler is
   executed as it exists on `develop`, never as it exists on `staging` or `production`. Under the
   fast-forward promotion model that is usually benign — `develop` is always ahead — but it means
   an edit to `deploy.yml` governs a **production** deploy the moment it lands on `develop`, not
   when `production` is promoted. "Byte-identical to what passed on staging" is true of the
   application; it is not true of the workflow that ships it. Treat a change to `deploy.yml` as
   a production change and review it as one.
2. **A failed production upgrade now leaves the release stuck, on purpose.** Production takes
   `--wait` without `--atomic` (why, below), so a failure leaves helm in `pending-upgrade` —
   and the *next* deploy fails with "another operation (install/upgrade/rollback) is in
   progress" until a person clears it. §3 has the two commands: `helm rollback rch -n rch` after
   a failed **upgrade**, `helm uninstall rch -n rch` after a failed **first install** (which
   leaves `pending-install`, with no earlier revision to roll back to).

### What the workflow checks before it touches a cluster

- **Trivy, on the exact tags helm is about to deploy.** `ci.yml` scans `rch-api:ci` / `rch-ui:ci`
  — images it built itself, which are not the bytes that reach a cluster. Two steps in
  `deploy.yml`, between the push and `helm upgrade`, scan
  `<ECR_REGISTRY>/rch-{api,ui}:<head_sha>` pulled back out of ECR, at
  `severity: CRITICAL,HIGH`, `exit-code: 1`, `ignore-unfixed: true`,
  `trivyignores: .trivyignore.yaml` — the same action version and the same ignore file as
  ci.yml, so the two scans cannot drift apart. They run whether the builds ran or were skipped
  as already-pushed (the repositories refuse to overwrite a tag, so a re-run of a commit whose
  images are already in ECR skips the build rather than failing on the push).
- **Every secret the chart needs is present.** A named step before `helm upgrade` refuses, by
  name, when any of `DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `SEED_PASSWORD` is
  empty — `--set-string` would otherwise write the empty string into the Secret and the api
  container would fail config validation minutes later, with nothing in the log about where the
  blank came from. It collects all four before exiting, so one run names every missing one. It
  is **scoped to non-production** (`head_branch != 'production'`): production reads the same four
  from AWS Secrets Manager through the External Secrets Operator, so those GitHub secrets are
  empty there on purpose and an unconditional guard would refuse every production deploy.

### `--atomic` on dev and staging, `--wait` alone on production

dev and staging keep `--atomic`: they are rebuildable, nobody is mid-shift on them, and an
automatic undo is worth more there than the wreckage of the failed attempt. Production takes
`--wait` alone, for two reasons:

- `--atomic` deletes the failed release's pods the instant it gives up, and takes with it the
  only two things §3's recovery actually reads — the pod events and the `migrate`
  initContainer's log. "The rollout failed" with no way to learn why is worse than a stuck
  release.
- **A migration that already committed is not undone by rolling the Deployment back.**
  `--atomic` would put the previous image in front of a schema it was never written for, which
  is a second, quieter outage on top of the first (§3, *Migrations are forward-only*).

So on production a failure stops, keeps the evidence, and waits for a person to decide whether
the right move is forward or back. Two steps make that workable:

- **`What the cluster saw`** (`if: failure()`, every branch, before any rollback) prints
  `kubectl -n $NS get pods,events --sort-by=.lastTimestamp | tail -80` and `kubectl -n $NS logs
  -l app.kubernetes.io/component=api -c migrate --tail=200` into the job log. Both `|| true`: a
  first install that never made a pod must not turn a missing log into a second failure.
- **`Unstick the release`** (`if: failure()`, **not** production) reads `helm status -o json`
  first and rolls back only from `pending-upgrade`, `pending-install`, `pending-rollback` or
  `failed`, and only when `helm history` shows at least two revisions. A bare `helm rollback`
  run unconditionally would be harmful: `--atomic`'s own rollback creates revision N+1 carrying
  the old content, and `helm rollback` with no revision goes back exactly one — to N, the
  revision that just failed. This step exists for the case `--atomic` could not handle itself
  (the job timed out mid-upgrade, or the automatic rollback hit the same wall the upgrade did).

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

Required repository secrets: `AWS_ROLE_ARN`, `AWS_REGION`, `ECR_REGISTRY`, `EKS_CLUSTER_DEV`,
`EKS_CLUSTER_STAGING`, `EKS_CLUSTER_PROD` (all three cluster secrets name the one cluster, `rch`
— every environment is a namespace on it, not a cluster of its own). Required GitHub
**environment** secrets for `dev` and, later, `staging`: **four** — `DATABASE_URL`,
`JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` and **`SEED_PASSWORD`** (these populate `secrets.values.*`
for the chart's in-cluster `Secret`, since both run with `secrets.create=true`). Production runs
with `secrets.create=false` and `secrets.externalSecret.enabled=true`, pulling **five** —
`DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY` (may be empty) and
`SEED_PASSWORD` — from AWS Secrets Manager (`rch/prod`) via the External Secrets Operator; no
database or key secrets live in GitHub for prod.

**`SEED_PASSWORD` is blocking, not optional.** It has been a required variable with no default
since the audit fix wave (`apps/api/src/config.ts`), and `config.ts` is what the **migrate
initContainer** loads before it opens a connection — so a secret without it produces an
initContainer that exits on `Invalid environment: SEED_PASSWORD: Too small …` and a pod that
never starts. On dev and staging `--atomic` rolls that back; **production deliberately upgrades
without `--atomic`** (§3), so the release is left sitting in `pending-install`/`pending-upgrade`
and has to be cleaned up by hand before the next attempt. The `Every secret the chart needs is
present` step in `deploy.yml` checks the GitHub secrets ahead of a **dev or staging** upgrade —
and **only** those two: it is `if: head_branch != 'production'`, because production's secrets
live in AWS Secrets Manager rather than GitHub, and `values-prod.yaml`'s `secrets.create: false`
means the chart's own `required` guard never sees them either. So the one environment that cannot
roll itself back is also the one with **no automated pre-flight**. Production's check is the
manual one-liner in §11's ExternalSecret bullet; run it before every promotion, not only the
first.

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
# ONE-TIME PER NAMESPACE, before the first upgrade of the release in it:
kubectl label namespace rch-staging elbv2.k8s.aws/pod-readiness-gate-inject=enabled
kubectl label namespace rch         elbv2.k8s.aws/pod-readiness-gate-inject=enabled
```

- **`ng-prod` does not exist, and production's pods can land nowhere else.** The cluster was
  created with one node group, `ng-spot`, and `values-prod.yaml` pins both Deployments to
  `rch.io/tier: prod` — a label nothing carries. Create it **before the first production deploy**
  (§11 step 8 is where it sits in the order):
  ```bash
  eksctl create nodegroup -f deploy/eksctl/cluster.yaml --include=ng-prod
  kubectl get nodes -l rch.io/tier=prod        # expect 3, one per availability zone
  ```
  Three on-demand nodes across `ap-south-1a/b/c`, deliberately untainted: the label is what pins
  production in, and a taint would additionally keep the DaemonSets off. Skip it and both
  Deployments sit `Pending` for ever with no error anywhere — and production upgrades without
  `--atomic` (§3), so nothing rolls that back. `deploy/chart/rch/tests/render.test.sh` asserts
  that the label the prod render asks for is one `deploy/eksctl/cluster.yaml` actually applies.
- **The pod readiness gate is not optional on this chart, and nothing enforces it.** The ingress
  uses `target-type: ip`, so the ALB registers each pod directly. Without the label a new pod
  counts as Ready the moment its own probe passes, while the load balancer is still registering
  it — and the api Deployment's `maxUnavailable: 0` then retires an old pod that was still
  serving in favour of a new one that is not yet receiving anything, which is a gap in the middle
  of a rollout. With the gate, Ready means "registered and healthy in the target group". The
  chart's `NOTES.txt` prints the command after every install, but a Helm NOTES block is easy to
  scroll past, which is why it is also here and in §11's checklist. It is a namespace label, so
  it survives every release; check it with `kubectl get ns <ns> --show-labels`.
- **Cluster add-ons the chart assumes but does not install.** All four are declared in
  `deploy/eksctl/cluster.yaml` except the first, which is a Helm chart of its own:
  - **kube-prometheus-stack** (or any Prometheus Operator). `templates/servicemonitor.yaml` and
    `templates/prometheusrule.yaml` are gated on `.Capabilities.APIVersions.Has
    "monitoring.coreos.com/v1"`, so without it they simply do not render — no alerts, no error,
    and a `helm upgrade --atomic` that would otherwise have failed on an unknown kind goes
    through. Both carry `release: {{ serviceMonitor.releaseLabel }}` (default
    `kube-prometheus-stack`), which is the label that operator's Prometheus selects rules by:
    install it under a different Helm release name and set `serviceMonitor.releaseLabel` to
    match, or the rules load and are never evaluated. §9 lists what ships.
  - **metrics-server.** `values-prod.yaml` turns on an HPA; without a metrics API it reports
    `<unknown>/70%` and never scales.
  - **amazon-cloudwatch-observability**, with `CloudWatchAgentServerPolicy`.
  - **Network policy in the `vpc-cni` add-on.** `templates/networkpolicy.yaml` renders a
    default-deny plus three named doors by default (`networkPolicy.enabled: true`), but a
    NetworkPolicy is enforced by the CNI, and the VPC CNI's policy agent is off unless the
    add-on is configured for it. `deploy/eksctl/cluster.yaml` now sets it —
    `configurationValues: '{"enableNetworkPolicy": "true"}'` on `vpc-cni` — **but a config file
    only reaches a cluster that is asked to read it.** For `rch`, which already exists:

    ```bash
    eksctl update addon -f deploy/eksctl/cluster.yaml --name vpc-cni
    aws eks describe-addon --cluster-name rch --addon-name vpc-cni --region ap-south-1 \
      --query 'addon.configurationValues'     # must show enableNetworkPolicy true
    ```

    Until then the objects are applied and **inert**. Turn it on deliberately, on staging first,
    and watch a rollout: this is the change in the chart with the most blast radius and the
    least local verification. `networkPolicy.enabled=false` stops rendering them. (kind, in CI,
    uses kindnetd, which does not implement NetworkPolicy at all — that, and not the
    `albSourceCidr` rules, is why `ci/install-test.sh` passes.)
- **ExternalSecret store (prod only):** the `ClusterSecretStore` named `aws-secrets-manager`
  (referenced by `deploy/chart/rch/templates/externalsecret.yaml`) must already exist in the
  cluster — it is provisioned once by the External Secrets Operator install, not by this chart.
  Create the AWS Secrets Manager secret `rch/prod` as one JSON object with **five** keys —
  `DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY` (may be empty
  until the first key rotation) and **`SEED_PASSWORD`** (may not) — and grant the ESO IRSA role
  read access to it. Then prove the five keys are there, because nothing in `deploy.yml` will
  (its secret pre-flight step is skipped for `production` — §2):

  ```bash
  aws secretsmanager get-secret-value --secret-id rch/prod --query SecretString --output text \
    | jq -e '(.DATABASE_URL|length) > 0 and (.JWT_PRIVATE_KEY|length) > 0
             and (.JWT_PUBLIC_KEY|length) > 0 and has("JWT_PREVIOUS_PUBLIC_KEY")
             and (.SEED_PASSWORD|length) >= 12' >/dev/null && echo "rch/prod: all five keys present"
  ```

  `jq -e` exits non-zero on a missing or empty key (or a seed password under twelve characters,
  which `config.ts` refuses too), and prints nothing but the verdict — the values never reach the
  terminal. The `ExternalSecret` uses `dataFrom: [{ extract: … }]`, which copies every
  key of the remote JSON, so there is no template entry to add and no error if one is missing:
  the pod simply never starts, because `SEED_PASSWORD` is required by `config.ts` and the migrate
  initContainer loads it first. Production upgrades **without `--atomic`** (§3), so a remote
  secret short of a key leaves the release in `pending-install` rather than rolling back.
  `templates/externalsecret.yaml` is deliberately **not** capability-gated the way the two
  monitoring templates are: skipping it on a cluster without the operator would leave pods with
  no `DATABASE_URL` and a confusing crash, where failing the install names the missing operator.
  A missing ESO is meant to be loud.
- **ACM certificate ARN:** set `ingress.certificateArn` in `deploy/chart/rch/values-staging.yaml`
  and `values-prod.yaml` to the ACM certificate for `rch-staging.<host>` / `rch.<host>` before
  the first deploy — the ingress template only adds the ALB annotation when it is non-empty.

### Housekeeping

A `CronJob` (`deploy/chart/rch/templates/purge-cronjob.yaml`, `purge.enabled` in `values.yaml`)
runs `dist/cli/purge.mjs` nightly at `15 2 * * *` (02:15). It deletes expired
`idempotency_keys` rows, and `refresh_tokens` rows that can no longer authorise anything —
expired ones, and revoked ones more than seven days old, so a recent "why was I signed out?"
is still answerable from the table. Both sweeps delete in **batches of 10 000** (`ctid in (select
… limit …)`, looping until a batch comes back short) rather than one unbounded `DELETE`, whose
lock and WAL burst would be proportional to however many months of backlog it met; each run takes
one cutoff timestamp and reuses it across its batches. The job is bounded too:
`startingDeadlineSeconds: 600` so a run missed during a node rotation is skipped rather than
counted toward the controller's hundred-missed-schedules wedge, `backoffLimit: 2`,
`activeDeadlineSeconds: 1800`, and three kept runs of each outcome. It prints a count for each and
needs no manual attention; if it's ever suspicious, run it by hand:

```bash
kubectl create job --from=cronjob/rch-purge rch-purge-manual -n rch
```

## 3. Roll back

```bash
helm history rch -n rch              # or -n rch-staging
helm rollback rch <revision> -n rch
```

Or revert the merge commit on `production` and push — CI runs, and the deploy that follows it
redeploys the reverted commit the normal way.

### Unsticking production after a failed deploy

Production upgrades without `--atomic` (§2 says why), so **a failed production deploy leaves the
release stuck and the next one refuses to start** with `another operation (install/upgrade/
rollback) is in progress`. Read `helm status rch -n rch` first — the status word tells you which
of the two you have, and they are not the same escape:

| `helm status` says | What happened | What clears it |
|---|---|---|
| `pending-upgrade` | An upgrade over an existing release failed or timed out | `helm rollback rch -n rch` — with no revision it goes back exactly one, to the last revision that actually deployed |
| `pending-install` | The **first** install of the release failed | `helm uninstall rch -n rch`, then re-run the deploy. There is no earlier revision to roll back to, so `helm rollback` has nothing to do; `helm history` shows a single revision |
| `failed` | helm finished and gave up cleanly | `helm rollback rch -n rch`, or fix forward |

Read the evidence before clearing it. The failed job's log already carries it: the
`What the cluster saw` step prints the namespace's pods and events, newest last, and the
`migrate` initContainer's last 200 lines. That is the whole reason production does not run
`--atomic` — clearing the release throws the pods away.

Decide *forward or back* before running either command, because rolling back does not undo a
migration that has already applied (below).

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

### The payer roster

Unlike user accounts, the roster **is** a screen — the outlet manager's **Payers** — and adding,
renaming, deactivating and reopening a patient, a staff member or a department is an everyday
task done there. The CLI exists for exactly one job the screen is wrong for: loading a ward list
of a few hundred rows at go-live, or after a hospital-side change that produced a file.

```bash
pnpm --filter @rch/api payers import --csv ./wards.csv
pnpm --filter @rch/api payers import --csv ./wards.csv --replace-names
```

The file is three columns, `kind,id,name`, one payer a line. A header row naming those columns is
optional; blank lines and lines starting `#` are skipped; a field may be quoted so a name can
carry a comma; a leading byte-order mark is stripped, so a file Excel saved as "CSV UTF-8" is
read as-is. `kind` is one of `patient|staff|dept`. The `id` is the hospital's own number — there
is no sequence behind a payer — and `(kind, id)` is what makes a row unique.

Three behaviours to know before running it against a live database:

- **One bad row aborts the whole file.** Every error is printed with its own line number and the
  column that caused it, and *nothing* is written. A half-loaded ward list is one nobody can
  reconcile against the list it came from, so the file is fixed and re-run rather than patched up
  afterwards. It is one transaction, with no statement timeout, like every other CLI here.
- **An id already on the roster is skipped, not overwritten** — the run says how many, and says
  to re-run with `--replace-names` if updating them is what was meant. Only that flag ever
  touches an existing name.
- **A rename never reopens a closed account.** `--replace-names` on a deactivated payer updates
  the name and leaves the switch alone; the summary counts those apart (`renamed 3 (1 still
  inactive)`) so "renamed 3" cannot be read as three people back on the till's picker. Reopening
  one is the manager's Payers screen.

The import does not announce over SSE, so an open browser will not see the new rows until it is
reloaded — the same as `users` and `db:seed`, and fine for a job that runs before anybody is
signed in.

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
(steps 1–4 above) has never been run, because there is no RDS yet — it is §11 step 6, before
go-live.

## 7. Rebuild balances

`stock_balances` is a cache derived from the append-only `stock_moves` ledger. "Append-only" is
enforced in the database, not just by convention: migration `0002` installs a trigger that
refuses any `UPDATE` or `DELETE` on `stock_moves` (`TRUNCATE` is still allowed — the test
harness and `db:seed --force` use it to reset between runs). **`document_history` is protected the
same way from migration `0008`** — `document_history_no_update_delete`, raising `document_history
is append-only; append a correcting entry` — so the trail behind a document is as uneditable as
the ledger behind a balance. Correct either by appending, never by an `UPDATE`; if a procedure
somewhere in this document tells you to edit a history row, it is out of date and the database
will say so.

`0008` also writes eight CHECK constraints the services already enforced (`stock_moves_qty_ck`
`qty <> 0`, `reservations_qty_ck` `> 0`, `batches_made_ck` `0 ≤ made ≤ started`,
`po_lines_receipt_ck` `0 ≤ rejected ≤ received`, `requisition_lines_ordered_ck`
`0 ≤ ordered ≤ approved`, `support_tickets_rating_ck`, `tickets_from_to_ck`,
`sequences_next_ck`) plus `tickets_otp_digits_ck`. **`stock_balances.on_hand >= 0` is deliberately
not one of them:** the friendly refusal an operator reads ("Only 2 nos of Mineral water 1L left at
Coffee Shop") is produced by a re-read that runs *after* `postMoves` has already driven the
balance down under the locks it holds, so a CHECK would fire first and turn every one of those
sentences into a 500 with no words in it. The negative never survives — the same transaction rolls
it back — and that is the guarantee, not the constraint.

There is no in-place correction of
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

`doc_type` is one of `request`, `requisition`, `purchase_order`, `prod_order`, `ticket`, and —
since the audit wave — `item`, `adjustment` and `bill`: **eight** types, written by the modules
that own each document; `grep -rn "appendHistory(" apps/api/src` is the authoritative list.

The three newest are each worth one line, because none of them is on the wire — no screen reads
them back, so this query is the only way to see them. `item` carries `Updated`, `Retired` or
`Restored` against an item key, and the last two are written **only when the flag actually
crossed**: a patch that sets a live line live again reads `Updated`, because a trail saying
something happened that did not is worse than no trail. `adjustment` carries the write-off's own
reason as its word (`Wastage`, `Breakage`, `Expired`, `Stock count`, `Returned to vendor`,
`Other`), one row per adjustment, and the document itself is never edited afterwards — a mistake
in one is corrected by raising another. `bill` carries exactly one row, ever, and only for a bill
somebody voided: `Voided — <reason>`, signed by the manager who did it. So:

```sql
select * from document_history where doc_type = 'bill' order by at desc;      -- every void, ever
select * from document_history where doc_type = 'item' and doc_id = 'milk';   -- who changed what
``` A production order's own board walk reads the same way, one row per
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

**"The collector has typed the code five times and now it will not take the right one."** That is
working as intended, not a fault. A wrong OTP is counted on the ticket (`tickets.otp_attempts`,
migration `0008`) and the sixth attempt is refused whatever is typed — the digits are what has
been guessed at, so the correct one is refused too:

```sql
select id, status, otp_attempts from tickets where id = 'TKT-0441';
```

The refusal names both ways out, because the one a caller has depends on their role: the store
keeper or the kitchen in-charge can hand it over with the **labelled supervisor override** (the
OTP field left blank — recorded on the ticket's trail), and anyone who may cancel the ticket can
**withdraw it and issue a new one**, which mints new digits. A counter operator has only the
second. The count is never reset — not by a correct code, not by a cancellation — so a ticket
that took four wrong codes carries them for its whole life; if that is the situation, reissue
rather than spending the last attempt.

**A request that should never have been approved** has its own door now, and it is not this one.
An approved request the store has not yet ticketed can be withdrawn — by the counter or kitchen
that raised it, or by the manager who approved it — with `POST /requests/:id/cancel`, no different
from withdrawing one the manager had not yet seen. Nothing is reserved until a ticket is issued,
so nothing moves and nothing is released; the trail reads `Cancelled — never issued`. Once a
ticket exists the request itself is closed to it (`… already has ticket TKT-0441 — cancel the
ticket instead`) and the ticket is what you withdraw, above.

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

Spec §12 names five; this build ships eight — the **six** below that the chart's
`PrometheusRule` renders, plus the two RDS rules that stay runbook-only. `/metrics` (Prometheus
format, `apps/api/src/plugins/metrics.ts`) exposes `http_request_duration_seconds` (histogram,
labelled `method`, `route`, `status`), `pg_pool_waiting`/`pg_pool_idle`, `sse_listener_up` and
the default Node process metrics. The first six below ship as a `PrometheusRule`
(`deploy/chart/rch/templates/prometheusrule.yaml`). **The two RDS rules stay runbook-only**,
below, because they need the CloudWatch metrics exporter (or Grafana's native CloudWatch
datasource) pointed at the RDS instance, which is not part of this chart and is wired at the
observability-stack level. A Grafana dashboard JSON does **not** ship with the chart either — a
dashboard in a ConfigMap is an unversioned blob nothing renders in CI and nothing fails when it
drifts, so build one from `/metrics` in Grafana directly rather than looking for one here.

**Three things have to be true before any of the six fires**, and none of them is the chart's to
guarantee (§2, *First-time cluster setup*, has the setup):

1. `serviceMonitor.enabled` — on in `values-prod.yaml`, off elsewhere.
2. **The cluster actually serves `monitoring.coreos.com/v1`.** Both templates are gated on
   `.Capabilities.APIVersions.Has`, because nothing in this repo installs the Prometheus
   Operator and a `helm upgrade --atomic` that meets an unknown kind fails and rolls the whole
   release back. On a cluster without the operator the two files simply do not render — no
   alerts, and no error saying so. `helm template --api-versions monitoring.coreos.com/v1` is how
   `render.test.sh` proves they still render when it is there.
3. **The `release:` label matches the operator's own Helm release name.** Both templates carry
   `release: {{ .Values.serviceMonitor.releaseLabel }}` (default `kube-prometheus-stack`), which
   is the label kube-prometheus-stack's Prometheus selects `ServiceMonitor`s and
   `PrometheusRule`s by. Install the operator under another release name and set this to match,
   or the rule object exists, looks right in `kubectl get prometheusrules`, and is never
   evaluated.

Each rule's `runbook_url` annotation is `alerts.runbookUrl` plus an anchor into this document
(`#3-roll-back`, `#9-alerts`, `#10-server-sent-events-sse`). `alerts.runbookUrl` is set in both
`values.yaml` and `values-prod.yaml` — it is no longer a `# FILL`.

**Still open: nothing routes these anywhere.** Alertmanager has no receiver configured for this
cluster, so a rule that fires today fires into Prometheus's own UI and pages nobody. Who is
paged, and by what, is a §11 go-live decision, not a chart value.

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
   RDS's own connection count — see item 7 below for that. The app pool never exceeds 60
   connections at max scale-out (10 per pod × 6 max pods, per spec §11.2) — plus one dedicated
   `LISTEN` connection per pod for the SSE plugin (§10), so 66. Still well under any RDS
   instance's limit; this alert catches the pool running out locally, long before RDS itself is
   under any real pressure.
5. **`RchApiCrashLooping` — more than one restart in fifteen minutes, critical, sustained 5
   minutes:**
   ```promql
   increase(kube_pod_container_status_restarts_total{namespace="rch",container="api"}[15m]) > 1
   ```
   The one rule here that does **not** read a metric this API publishes, and it cannot: a pod
   that is restarting is a pod that is not scraping, so every other alert in this list goes quiet
   exactly when this failure is happening. `kube_pod_container_status_restarts_total` comes from
   kube-state-metrics, which ships with the same kube-prometheus-stack whose CRDs gate the whole
   file — if the rule is loaded, the metric is there. The threshold is *more than one* restart
   because a single restart is what an ordinary node eviction leaves behind; two in a quarter of
   an hour is a pod that came up, failed and came up again — a bad migration, a missing secret,
   an OOM kill. **`kubectl logs --previous` on the pod says why, before the next restart wipes
   it.** The `namespace` label is the release's own namespace, so the rendered rule in
   `rch-staging` watches `rch-staging`.
6. **`RchSseListenerDown` — the sixth chart-shipped alert and this build's eighth overall,
   warning, sustained 5 minutes:**
   ```promql
   min(sse_listener_up{job="rch-api"}) == 0
   ```
   Its rationale — what `sse_listener_up` means, why 5 minutes and not immediately, and why it
   is deliberately *not* wired into `/readyz` — is §10's, below, not repeated here.
7. **DB connections > 80% of max — runbook-only, needs CloudWatch.** RDS CloudWatch
   `DatabaseConnections`, exposed as a gauge by the CloudWatch exporter (metric name depends on
   the exporter's naming, e.g. `aws_rds_database_connections_average`):
   ```promql
   aws_rds_database_connections_average{dbinstance_identifier="rch-prod"} > 0.8 * <max_connections>
   ```
   `<max_connections>` is fixed for the instance class (`SHOW max_connections;`) — compute it
   once and hardcode the threshold in the alert rule. This is a safety net for connections opened
   outside the app (a psql session left open, a burst of migrate initContainers opening a
   connection each during a large rollout) — the app's own pool is item 4, above.
8. **RDS free storage < 20% — runbook-only, needs CloudWatch.**
   ```promql
   aws_rds_free_storage_space_average{dbinstance_identifier="rch-prod"}
     / <allocated_storage_bytes> < 0.2
   ```

**The migrate initContainer dies with `SELF_SIGNED_CERT_IN_CHAIN` although the image ships the
RDS bundle.** The `DATABASE_URL` carried `?sslmode=require`: the driver then builds its own TLS
setting from the string and ignores the bundle the code hands it, so the chain was checked
against the system store. `DATABASE_SSL=true` alone decides TLS — keep the URL free of `sslmode`
(`createDb` now strips it, but a URL that says nothing is clearer). The bundle itself verified the
`rds-ca-rsa2048-g1` chain fine from inside the cluster.

**The site stops resolving after a failed or re-done install.** The ingress owns the ALB, and
`helm --atomic` rolling a first install back deletes the ingress and the ALB with it; the next
install creates a new ALB with a new DNS name, and the Route 53 alias still points at the old one
(Route 53 answers NOERROR with no address). Re-point it: `kubectl -n rch-dev get ingress rch -o
jsonpath='{.status.loadBalancer.ingress[0].hostname}'`, then the UPSERT alias with that name and
the ALB's canonical hosted zone id (`aws elbv2 describe-load-balancers`). The durable fix is
external-dns (IRSA + the `external-dns` chart watching the ingress host) — not installed yet.

**Every `/api` request from the browser answers 502, the API pod logs only probes** — *wherever
nginx is the proxy*, which means CI's kind cluster (`ingress.enabled: false`) and Docker
Compose, not a deployed environment: with the ingress on, the ALB routes `/api` to the api
Service directly and the UI pod serves only the static bundle (§10). The UI's
nginx proxies `/api` to `API_UPSTREAM`, and nginx's `resolver` directive ignores `/etc/resolv.conf`'s
search domains, so the value must be the API Service's full cluster name —
`http://<release>-api.<namespace>.svc.cluster.local:3000`, which the chart sets. A short name
(`http://rch-api:3000`, the image's Compose-only default) resolves under Docker's embedded DNS and
never inside a pod. `kubectl exec deploy/<release>-ui -- printenv API_UPSTREAM` shows what it got.

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

**First, which hops are actually on the path.** In a cluster, **nginx is not on the `/api`
path at all.** `templates/ingress.yaml` gives the ALB two rules — `/api` → the `<release>-api`
Service on 3000, `/` → the `<release>-ui` Service on 8080 — so a browser's stream goes
browser → ALB → api pod, and the UI pod serves only the static bundle. nginx's own
`/api/v1/events` block (`deploy/nginx/default.conf.template`) is on the path for **Docker
Compose and local runs**, where the UI container is the only thing listening. Keep both correct:
the Compose path is what most people develop against, and a deployed regression that only shows
up in Compose is the worst kind. But when a stream dies in staging or production, the hop to
look at is the ALB, not nginx.

**Infrastructure that must not change without checking this first:**

- The ALB idle timeout is 3600 s (`alb.ingress.kubernetes.io/load-balancer-attributes` in
  `deploy/chart/rch/values.yaml` and `values-prod.yaml`), and it is the only read timeout on the
  deployed path. nginx's `/api/v1/events` location sets `proxy_buffering off` and
  `proxy_read_timeout 3600s` separately from the plain `/api/` location's 60 s, for the Compose
  path. Either timeout dropping back toward the default silently caps every stream's lifetime at
  that many seconds — live updates would appear to work in testing (well under the timeout) and
  then degrade in a way that only shows up as a slow climb in reconnect attempts hours into a
  shift.
- **The five numbers a rolling deploy is timed against**, none of which is in this section's own
  files, all of which end a stream when they are wrong:

  | Number | Where | Value |
  |---|---|---|
  | ALB idle timeout | `ingress.annotations` → `load-balancer-attributes` | 3600 s |
  | Target deregistration delay | `ingress.annotations` → `target-group-attributes` | 30 s |
  | API pre-drain wait (production only) | `apps/api/src/server.ts` | 30 s |
  | API drain timer | `apps/api/src/server.ts` | 25 s |
  | Pod termination grace | `templates/api-deployment.yaml` | 60 s |

  The rule binding them: **deregistration delay ≤ pre-drain wait**, and pre-drain + drain < grace
  (30 + 25 = 55 < 60). A pod that stops accepting while the target group is still draining
  connections into it cuts exactly the requests the delay exists to let finish; a pod whose
  pre-drain plus drain exceeds the grace is SIGKILLed mid-request. Move one of the five and check
  the other four — `apps/api/src/server.ts`'s comment carries the arithmetic beside the code.
- **The ALB health check is `/readyz`, every 15 s** (`healthcheck-path` /
  `healthcheck-interval-seconds`), not `/healthz` — `/healthz` answers 200 for as long as the
  process exists, draining included, so a pod that had already stopped accepting still looked
  healthy to the load balancer. `healthcheck-path` is an **Ingress-level** annotation, so the
  controller applies it to *every* target group the ingress creates — the ui's as well as the
  api's. That is why `deploy/nginx/default.conf.template` serves **both** `location = /healthz`
  and `location = /readyz`: with only `/healthz`, the ui's check fell through to the SPA
  catch-all and passed on `index.html`, a 200 that says nothing about nginx. nginx has no
  draining state of its own, so both return the same `ok`. If you ever move the health-check
  path, move it in the nginx template too.
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
  `/api/v1/events` `proxy_read_timeout` (3600 s) and `proxy_buffering off` (the Compose path),
  and the ALB idle timeout (3600 s, the deployed path) all belong to the same chain and move
  together. The heartbeat must stay
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

Environment resources are `deploy/cfn/rch-env.yaml`; the cluster is `deploy/eksctl/cluster.yaml`.

**Scope.** This checklist promotes `staging` and `production`, neither of which has an AWS
resource behind it yet. `dev` is already live — `develop` deploys to `rch-dev` on the same
cluster at `https://rch.hashtrickstechnologies.com`, and its resources are already the same
`deploy/cfn/rch-env.yaml` stack (`rch-dev`) that `staging`/`prod` will import from. §15 records
how `dev` was stood up and what tripped on the way; read it before repeating any of this for
staging or production, since two of the four lessons there (the CAA one and the OIDC one) will
recur verbatim for a new host name and are cheaper to avoid than to rediscover.

### The release, prepared and not performed (2026-09-04)

Phase 6 ends here. Everything the first production deploy needs is written down; **nothing in
this build pushes `staging` or `production`** — promotion is a release decision and the branch
pushes below are the account owner's to run, not any agent's. The only `git push` anywhere in
`.github/workflows/**` is the `Tag production` step in `deploy.yml`, which tags a *release* after
a deploy has already happened; no workflow, script or task in this repository pushes either
branch.

**Where the branch stands.** `feat/phase-6-ops-go-live` is **36 commits** ahead of `develop`, and
`origin/staging` is an ancestor of `origin/develop` — so every promotion below is a genuine
fast-forward, as §11.3 of the design spec requires. Confirm both before starting:

```bash
git log --oneline develop..feat/phase-6-ops-go-live | wc -l              # 36
git merge-base --is-ancestor origin/staging origin/develop && echo ok    # ok
```

**1. The four blocking `FILL` values only the account owner can supply.** They are marked
`# FILL` in `deploy/chart/rch/values-prod.yaml`; find them with
`grep -n '# FILL' deploy/chart/rch/values-*.yaml` rather than by line number, which is what this
table used to give and what drifted the first time a comment was added above one of them:

| Key path | What goes in |
|---|---|
| `image.registry` | `<account>.dkr.ecr.<region>.amazonaws.com`. `deploy.yml` also passes it as `--set image.registry=${{ secrets.ECR_REGISTRY }}`, so the file's own value only matters to a manual `helm template` / `helm upgrade`. |
| `api.env.CORS_ORIGIN` | The real hostname, no trailing slash (currently `https://rch.example.com`). |
| `ingress.host` | The real hostname (currently `rch.example.com`). |
| `ingress.certificateArn` | The ACM certificate ARN for that host. Empty renders **no** TLS annotation — HTTP on `:80`, correct rather than broken, but not what go-live wants. |

`alerts.runbookUrl` was a fifth row here and is **not a FILL any more**: both `values.yaml` and
`values-prod.yaml` carry the real URL of this document, and `render.test.sh` refuses a rendered
`runbook_url` still containing the chart's `<org>/<repo>` placeholder.

**And one in the other file**, the same shape and the same decision:

| File | Key path | What goes in |
|---|---|---|
| `deploy/chart/rch/values-staging.yaml` | `ingress.certificateArn` | The ACM certificate ARN for `rch-staging.example.com`. Empty renders no TLS annotation — staging on HTTP `:80`, correct rather than broken. Fill it, or decide out loud that staging runs on `:80`. |

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
| Repository **variable** | `DEPLOY_ENABLED=true` | `deploy.yml`'s `deploy` job is gated on `vars.DEPLOY_ENABLED == 'true'`, and its `skipped` job — named `Deploy skipped (DEPLOY_ENABLED is not true)` — runs instead when it is not. Until it is `true`, a push to `staging` or `production` deploys nothing. |
| Repository secret | `AWS_ROLE_ARN` | The OIDC role the workflow assumes. |
| Repository secret | `AWS_REGION` | |
| Repository secret | `ECR_REGISTRY` | Passed as `--set image.registry`. |
| Repository secret | `EKS_CLUSTER_STAGING` | |
| Repository secret | `EKS_CLUSTER_PROD` | |
| Repository secret | `SEED_PASSWORD` | **New, and blocking.** `deploy.yml` passes it as `--set-string secrets.values.SEED_PASSWORD`; `apps/api/src/config.ts` has no default for it, so an unset secret renders `SEED_PASSWORD: ""`, the api container refuses to start, and `--atomic` rolls the whole release back. At least twelve characters. Needed for **dev and staging** — both read repository/environment secrets — before the next push to either. |
| `staging` environment | `DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | Staging reads its secrets from the GitHub environment; production reads `rch/prod` out of AWS Secrets Manager through the `ClusterSecretStore`. |
| AWS Secrets Manager `rch/prod` | `DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY`, **`SEED_PASSWORD`** | **Five keys now, not four.** `JWT_PREVIOUS_PUBLIC_KEY` may start empty; `SEED_PASSWORD` may not. The `ExternalSecret` uses `dataFrom: [{ extract: … }]`, which copies every key of the remote JSON — so there is no template entry to add, but a remote secret missing `SEED_PASSWORD` produces a pod that will not start. Mint the JWT pair with `pnpm --filter @rch/api keys:generate`, which prints two `JWT_*=` lines and never writes them anywhere. |

**3. The promotion, in order, run by a person.**

```bash
git checkout develop    && git merge --ff-only feat/phase-6-ops-go-live && git push
git checkout staging    && git merge --ff-only develop && git push        # deploys rch-staging
# verify staging: /readyz, a sign-in, one real sale, rebuild-balances reconciling (step 9 below)
# re-measure the load check against staging and record it against §12's targets (§12 above)
git checkout production && git merge --ff-only staging && git push        # waits for approval
```

Production's deploy waits on the `production` GitHub environment's approval before the job runs.
Work the numbered checklist below alongside these three commands — in particular step 4, which
deactivates the six seeded accounts, step 5, the payer roster, and step 6, the real restore drill. **Then, and only then,
is this build in a hospital.**

### The checklist

An ordered list. Each item is a command or a decision, and each decision names who makes it —
the account owner, not the executor of this phase's tasks. Nothing on this list has been run
against a real AWS account **for staging or production**; Phase 6 prepared the chart, the
workflow and this checklist and stopped there (spec §16, Phase 6) — running it is a release
decision. The equivalent steps have been run for `dev` (§15), which is exactly why the account
owner should not repeat them from the same starting point:

**Before anything else on this list: get off root.** Every AWS CLI call and CloudFormation
stack behind `dev` was run with the account's **root** credentials, from this laptop — the
fastest way to build something from nothing, and the wrong thing to keep doing into staging and
production. Create an IAM user or role for the operator, scoped to what standing up and running
an environment actually needs (EKS, RDS, ACM, Route 53, Secrets Manager, CloudFormation, and
read access to IAM to check the rest of this list) rather than the account's own unrestricted
root, before touching either. This is about the human running the commands in this section —
`rch-github-deploy`, the role the deploy *workflow* itself assumes, already exists, is already
scoped to what a deploy needs, and needs no change.

1. **Fill in the AWS facts the two values files are still missing** — `values-prod.yaml`'s five
   `# FILL` markers, its two conditional ones, and `values-staging.yaml`'s own
   `ingress.certificateArn`, all tabulated with their line numbers under "The release, prepared
   and not performed" above. Render the chart with the values supplied on the command line
   before pushing anything.

   **And, on the same pass, a pre-flight that is not about AWS at all: probe any database that
   already holds data, before its first `db:migrate` on this build.** Migration `0008` adds
   constraints that validate existing rows, so a database with history in it can *refuse* the
   migration — and a refused migration is an initContainer that never completes, which reads as a
   deploy that hangs rather than as bad data. §1's *Migration workflow* carries the five probe
   queries (`stock_moves` with `qty = 0`; a `reservations` row whose `ticket_id` has no `tickets`
   row; a ticket with `from_loc = to_loc`; `po_lines` with `rejected_qty > received_qty`;
   `batches` with `made_qty > started_qty`) and what to do about each, and
   `apps/api/scripts/preflight-0008.sql` runs all ten as one read-only script that prints `clear`
   or `BLOCKS 0008` per constraint. They are plain reads — run
   them against a restored copy if the window is tight. This applies to **dev too**, which has
   real documents on it; a fresh staging or production database has nothing to reject.

   **`0008` is still the only migration that can refuse.** `0009`–`0012` — the payer audit
   columns, the adjustment tables, the production order's needed-by date and the bill's three
   void columns — add tables and nullable columns and validate no existing row, so a database
   this script calls clear is one the whole set of thirteen will apply to. Expect
   `migrations applied: 13 / 13`.
2. **Create the environment's CloudFormation stack** — `deploy/cfn/rch-env.yaml` with
   `deploy/cfn/prod.params.json` (or `staging.params.json`). The template, not this list, is now
   where spec §11.2's RDS settings live, so read **[`deploy/cfn/README.md`](cfn/README.md)**
   before running anything: it carries the procedure, the `FILL` table, what an IMPORT change set
   will and will not accept, and why `staging`/`prod` must be a plain `create-stack` rather than
   the import `dev` went through. What the template delivers per environment, without a command
   of your own: a **per-environment DB parameter group** (`rds.force_ssl=1`,
   `log_min_duration_statement=1000`, `idle_in_transaction_session_timeout=60000`), a
   **per-environment DB security group** admitting 5432 from `NodeSecurityGroupId` only (dev
   keeps its wide `DbIngressCidr`, deliberately), `MaxAllocatedStorage` (prod 100, staging 40,
   dev 0), `AutoMinorVersionUpgrade: false` against the pinned `EngineVersion`, CloudWatch
   `postgresql` log export, Performance Insights at the free 7-day retention everywhere, Enhanced
   Monitoring, and backup/maintenance windows that do not overlap and are both off-hours IST
   (`20:30-21:30` UTC = 02:00–03:00 IST; `sun:22:00-sun:23:00` UTC = Monday 03:30–04:30 IST). It
   also carries the ECR lifecycle policies, an optional ALB access-log bucket, a Route 53 uptime
   health check and an SNS topic. Instance classes are prod `db.t4g.medium` / staging
   `db.t4g.small`; prod is Multi-AZ with 14-day backups and deletion protection, staging
   single-AZ with 7 days — smaller on purpose, not a step skipped.

   **Three things this step does NOT give you, and each one bites differently:**
   - **The database is in public subnets — every environment's, production's included.** The
     stack puts all three in the shared `rch` DB subnet group, which is the default VPC's three
     *public* subnets. Closing it is not a parameter: it needs new subnets, a NAT route, a
     per-environment `DBSubnetGroup` replacing the shared import, and an outage to move an
     existing instance between subnet groups. What limits the exposure meanwhile is
     `PubliclyAccessible: false` plus the node-group-only security group above. **Do not read
     "matches spec §11.2" as including this** — put it on the follow-up list below and decide it
     deliberately.
   - **`rds.force_ssl` is a STATIC parameter.** Attaching the parameter group leaves it
     `pending-reboot`; a stack update alone does not start enforcing TLS. Reboot the instance
     (off-hours) and re-check. Related: the API decides TLS from **`DATABASE_SSL` alone** —
     `db/client.ts` strips any `sslmode`/`ssl*` parameter off `DATABASE_URL` first, precisely so
     a connection string cannot quietly pick a different trust store — so keep `sslmode` out of
     the URL and leave `DATABASE_SSL=true`, which the chart already sets.
   - **The uptime alarm is not in this stack and cannot be.** Route 53 publishes
     `AWS/Route53 HealthCheckStatus` into `us-east-1` only, whatever region created the health
     check, so an alarm on it in `ap-south-1` sits in `INSUFFICIENT_DATA` for ever. The template
     creates the health check and an in-region `rch-<env>-alerts` topic; the alarm, and the
     `us-east-1` topic it publishes to, are one `put-metric-alarm` run by hand against the
     `UptimeHealthCheckId` output. `deploy/cfn/README.md` has the command.

   **When you do fill in `AlbLogsBucketName`, turning the logs on is a chart edit — and the
   prefix is a trap.** `values-prod.yaml` has no `access_logs.s3.*` today, deliberately: an ALB
   told to write to a bucket that does not exist, or to one without the log-delivery policy,
   reports nothing wrong and simply writes nothing. Once the bucket exists, append
   `,access_logs.s3.enabled=true,access_logs.s3.bucket=<AlbLogsBucketName>` to the
   `load-balancer-attributes` annotation, on one line, with no spaces — **and leave
   `access_logs.s3.prefix` unset.** The bucket policy is scoped to `AWSLogs/<account>/*`, AWS's
   documented path; a prefix relocates every object to `<prefix>/AWSLogs/…`, the policy refuses
   it, and the ALB writes nothing, silently. (The comment beside that annotation in
   `values-prod.yaml` still shows a `prefix=rch` in its example string — it predates the bucket
   policy and is wrong; `deploy/cfn/README.md`'s *ALB access logs* section is the authority, and
   says to add the prefix to both `Resource` lines at the same time if you really want one.)

   One more thing to decide before creating a **prod** stack, not after: `prod.params.json`'s
   `HostName` is `rch.hashtrickstechnologies.com`, **which is the host dev is live on today**.
   Creating the stack unchanged mints a second ACM certificate and a second health check against
   the running dev application, and the go-live A-alias becomes a fight between two environments
   for one name. Either move dev to `rch-dev.…` and let prod take the name, or give prod its own.
3. **Generate the production JWT key pair and store it, never in git:**
   ```bash
   pnpm --filter @rch/api keys:generate
   ```
   Put both lines into the AWS Secrets Manager secret `rch/prod` as `JWT_PRIVATE_KEY` /
   `JWT_PUBLIC_KEY`, alongside `DATABASE_URL`, an empty `JWT_PREVIOUS_PUBLIC_KEY`, and
   **`SEED_PASSWORD`** — five keys (§2's "First-time cluster setup" and the secrets table above).
   Choose the seed password here and never reuse it between environments: it is the password the
   six seeded accounts start on, and step 4 deactivates all six anyway.
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

   Two notes on running the seed in a cluster at all. It needs **`--yes-seed <database name>`**
   (§15.7): the chart renders `NODE_ENV=production` into every pod, dev included, and
   `cli/seed.ts` refuses until the database names itself back. And **the seeded accounts on the
   `dev` host need their passwords
   reset now, as a separate job from this checklist** — they were seeded with the published
   `changeme` before `SEED_PASSWORD` became a required value, and every one of them that has not
   since been through a change-password step (§1 records that `RC-4471` has) is still open on it:
   ```bash
   kubectl -n rch-dev exec deploy/rch-api -- /nodejs/bin/node dist/cli/users.mjs \
     reset-password --emp RC-4471 --password <new>
   ```
   for each of the six, or a re-seed with a real `SEED_PASSWORD`. `changePassword` is `allowMcp`,
   so a takeover through one of those accounts is permanent; making the variable required stops it
   happening again, it does not undo what is already there.
5. **Load the payer roster, and decide who keeps it.** The six seeded payers are demo data on
   the same footing as the seeded accounts, and a till cannot take a non-cash tender against
   somebody who is not on the register. Get the ward, staff and department lists as a
   `kind,id,name` CSV and load them in one go (§5's *The payer roster* has the file rules and the
   three behaviours to know):
   ```bash
   kubectl exec deploy/rch-api -n rch -- /nodejs/bin/node dist/cli/payers.mjs import --csv /tmp/payers.csv
   ```
   `kubectl cp` the file in first, or run the CLI from a laptop against the same
   `DATABASE_URL`. One bad row aborts the whole file and names every one it found, which is the
   behaviour you want on go-live morning rather than half a roster. Afterwards the **outlet
   manager's Payers screen** is where a new patient or a new starter is added, one at a time,
   with no CLI and no deploy — decide who that is and say so in the handover, because the ability
   to add a payer is the ability to open a credit account.
6. **Run the restore drill once against the real RDS instance** (§6, the RDS procedure below the
   local rehearsal) — not the rehearsal, the real one, before the first bill is ever posted for
   real.
7. **Create the repository variable, every secret, and the `production` GitHub environment** —
   `DEPLOY_ENABLED=true`, the six repository secrets (**`SEED_PASSWORD` is the new one, and
   blocking**), the `staging` environment's three, and AWS Secrets Manager's `rch/prod` with its
   **five** keys: the table under "The release, prepared and not performed" above lists each one
   and what it populates, and §2 says where the workflow reads it — and run the `jq -e` check in
   the ExternalSecret bullet above, since production's secrets get no pre-flight from the
   workflow. Do this **before the next push
   to any environment**, including `dev`: the api container will not start without a seed
   password, and `--atomic` rolls the release back when it doesn't. A missing one is caught
   early now — `deploy.yml` has a named `Every secret the chart needs is present` step before
   `helm upgrade` that refuses by name, on dev and staging (production reads the same four
   through External Secrets, so the GitHub secrets are empty there on purpose).

   **The `production` environment itself is the approval gate, and it is a GitHub setting, not a
   line in the workflow.** `deploy.yml` names `environment: production` for a production
   deploy; what makes that *wait* is the environment's own protection rules. Create it with
   **required reviewers** and a **deployment-branch restriction** naming only `production`, so
   the environment (and the AWS role trust that is scoped to `environment:production`, §15.3)
   cannot be claimed from another branch. Verify, do not assume:

   ```bash
   gh api repos/:owner/:repo/environments/production
   # protection_rules: a "required_reviewers" entry; deployment_branch_policy: custom, with
   # a branch policy naming `production` and nothing else
   ```

   **And, once, before staging: prove Trivy honours the YAML ignore file.** `.trivyignore.yaml`
   replaced a plain-text `.trivyignore` whose expiry syntax was invented. The replacement is
   correct against the documented schema but has never been run against a live registry from
   here. Push a throwaway branch, let `ci.yml` run its two image scans once, and confirm they
   pass. The failure mode is fail-safe — all four scans (ci.yml's two, deploy.yml's two) go red
   rather than quietly letting something through — but finding that out on the staging promotion
   costs the promotion. If a *fixed* HIGH does turn up in a distroless base, the remedy is an
   entry in `.trivyignore.yaml` with a reason and an `expired_at`, **not** lowering the severity
   back to CRITICAL.

   **On the same throwaway branch: check `.trivyignore.yaml`'s expiries before promoting.**
   `grep expired_at .trivyignore.yaml` and compare each date with today. An entry whose
   `expired_at` has passed stops being honoured, and all four scans go red at once — CI's two and
   the deploy workflow's two — which on the day of a promotion looks like the promotion having
   broken something. Do **not** push the date out to get past it: either the advisory has a fixed
   version in the base image now, in which case rebuild and the entry goes away, or it still does
   not, in which case renewing it is a decision somebody makes with the reason written down.

   **And label the namespaces for the pod readiness gate** (§2, *First-time cluster setup*) —
   `kubectl label namespace rch elbv2.k8s.aws/pod-readiness-gate-inject=enabled`, and the same
   for `rch-staging`, once, before the first upgrade of the release in each. Nothing fails
   without it; what you get instead is a gap in the middle of every rollout.
8. **Create `ng-prod`, the on-demand node group production's pods are pinned to.** It does not
   exist: the cluster has one spot node group, `ng-spot`, and `values-prod.yaml` sets
   `api.nodeSelector` and `ui.nodeSelector` to `rch.io/tier: prod` — a label nothing in the
   cluster carries. Promote without this and both Deployments sit `Pending` for ever with no
   error anywhere; production upgrades **without `--atomic`** (§3), so nothing rolls it back.
   ```bash
   eksctl create nodegroup -f deploy/eksctl/cluster.yaml --include=ng-prod
   kubectl get nodes -l rch.io/tier=prod        # expect 3, one per availability zone
   ```
   Three on-demand nodes across `ap-south-1a/b/c`, untainted on purpose — the label pins
   production's pods in, and a taint would additionally keep the DaemonSets (vpc-cni,
   kube-proxy, the CloudWatch agent) off. `deploy/eksctl/cluster.yaml` carries the whole argument
   for the shape; `render.test.sh` asserts that whatever label the prod render asks for is a label
   some node group in that file actually applies, so the two cannot drift apart silently.
9. **Promote** — the three fast-forward merges under "The release, prepared and not performed"
   above, in that order, run by a person. `develop` first, then `staging`, then `production`;
   verify staging between the second and the third (step 10), and production's deploy waits for
   the `production` GitHub environment's approval before the job runs.
10. **First post-deploy checks, on each environment, in order:**
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

### The follow-up list

Four things the audit wave named that go-live does **not** close, each a decision rather than a
command. None of them blocks a first deploy; all of them should be decided out loud rather than
discovered later.

1. **Every environment's database sits in public subnets** — production's included (step 2
   above). The exposure is limited by `PubliclyAccessible: false` and a node-group-only security
   group, not by the network. Moving them needs private subnets, a NAT route, a per-environment
   `DBSubnetGroup` and an outage per instance.
2. **Nothing routes an alert to a person.** The chart renders six `PrometheusRule` alerts (§9)
   and Alertmanager has no receiver configured for this cluster, so a rule that fires pages
   nobody. Who is on call, and by what channel, is the decision; the rules and their
   `runbook_url` anchors are already there.
3. **NetworkPolicy is applied and inert** until the live cluster's `vpc-cni` add-on is updated
   from `deploy/eksctl/cluster.yaml`, which now asks for `enableNetworkPolicy` (§2,
   *First-time cluster setup*, has the `eksctl update addon` command and the check). The file
   being right does not make the running cluster right. Turning it on is a deliberate change
   with real blast radius — do it on staging first, and watch a rollout.
4. **`/metrics` shares port 3000 with the API.** A NetworkPolicy decides on ports, not paths, so
   the `monitoring`-namespace rule in the api policy is a record of the intended scraper rather
   than a control, and `networkPolicy.albSourceCidr` cannot be narrowed below what the serving
   port needs. Moving `/metrics` to its own listener port is what would make both real.

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

**An order is decided on what the shelf accepted, not on what the lorry carried.** `received_qty`
on a `po_lines` row is the **gross** arrival record — what the delivery notes add up to — and
`rejected_qty` the running total sent to quarantine. Every question about whether the vendor has
*delivered* is asked of the difference (`netReceived` in `packages/domain/src/receipt.ts`), so
when reading a line by hand, read `received_qty - rejected_qty`:

```sql
select line_no, item_key, qty, received_qty, rejected_qty,
       round(received_qty - rejected_qty, 3) as accepted
from po_lines where po_id = 'PO-2026-0143' order by line_no;
```

Three consequences an operator meets:

- **A delivery rejected whole leaves the order `Partially received`**, not `Received`. Nothing
  reached the shelf, so nothing was delivered; the order stays open and the buyer can still close
  it short or wait for the replacement. (An order that *did* reach `Received` cannot be reopened
  through the API — §1's migration notes carry the one-statement correction for a pre-audit order
  stranded there.)
- **Closing short gives back the rejected quantity too.** `shortfallClaims` releases
  `qty − accepted`, last source first, so what quality control turned away goes back onto the
  procurement list with the rest of the balance rather than being written off the requisition.
- **The 2% tolerance measures net-prior plus this arrival's gross**, which is what lets a
  replacement delivery in at all: an order for 120 whose first consignment of 120 was rejected
  whole can take a second consignment of up to 122.4, so 242.4 units may pass through the door in
  total against a 120-unit order. That is right — the vendor is replacing goods it took back — but
  it means **gross arrival against an order is not bounded by 102% of what was ordered**, and a
  report that reads `received_qty` as "quantity delivered" will say so. Read `accepted`.

The refusal sentence the store keeper reads on an over-delivery quotes that **net-prior +
gross-arrival** total, not the running gross — so the number in "… exceeds the ordered 120 by more
than 2%" will not match `sum(received_qty)` on an order that has had anything rejected. That is
the arithmetic above, not a miscount.

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
keeper's screen shows. Nothing issues, sells or transfers from there, and no purchase-return or
debit-note document exists — that was considered and declined (spec §16, Phase 5;
`docs/ua-spec.html` §09 records it by name), and it stays declined: recovering the money from a
vendor is a conversation, not a screen.

**The shelf itself does have an exit now, and it is not SQL.** Since the audit wave (spec §16,
wave 4) the **store keeper** — and only the store keeper, of the five roles — can raise an
adjustment against `quarantine`, typically reason `returned_to_vendor` for a consignment going
back, or `expired` / `breakage` for one that is not going anywhere. It is the one write body in
the whole API that may name `quarantine` at all; a manager there reads *You can only adjust stock
at an outlet — the central store writes off its own shelves*. So the answer to "how do I clear
quarantine" is the store keeper's **Adjustments** screen, with a reason and a note against their
own name, and no hand-written move at all. Anything this section used to say about correcting a
shelf with SQL is now the wrong advice: use the endpoint, which leaves a document behind.

```sql
-- what is sitting there, and what took it off, per item
select * from stock_balances where loc = 'quarantine' and on_hand <> 0;
select m.at, m.kind, m.item_key, m.qty, m.ref_id, u.name
from stock_moves m left join users u on u.id = m.by_user
where m.loc = 'quarantine' order by m.at desc limit 50;
```

**A refused receipt:** a `POST …/receive` that answered 422 has written nothing — no GRN row,
no move, no change to `received_qty` — because every line is validated before the first write.

**Two reactivations of a rate contract at once:** `PATCH /contracts/:id {"active":true}` checks
for an existing live contract on that vendor and item, but the check locks nothing when it finds
none, so two reactivations of two closed contracts for the same pair race and the partial unique
index `rate_contracts_live_uq` decides. The loser reads the ordinary refusal (`<item> already has
a live contract with <vendor>`), not a 500: `contractsRepo.update` catches the violation on that
index by constraint name (`isUniqueViolation` in `lib/db.ts`, the same helper `vendors` uses) and
the service refuses with the sentence it had already composed. Nothing to do; no data is at risk.

## 15. The dev environment on AWS (2026-09-04)

One environment stood up, minimal on purpose: `develop` deploys to namespace `rch-dev` on every
push, reachable at `https://rch.hashtrickstechnologies.com`. Staging and production stay exactly
where Phase 6 left them — the chart, the workflow and the go-live checklist (§11) are ready for
them, but neither has an AWS resource behind it, and `values-staging.yaml`'s
`ingress.certificateArn` is still `# FILL`. What follows either was built once by hand or is a
procedure meant to be repeated the next time an environment needs standing up — staging first,
when that day comes.

### 15.1 Cluster

`eksctl create cluster -f deploy/eksctl/cluster.yaml` built `rch` — EKS **1.31**, `ap-south-1`,
in the account's **default VPC** `vpc-01ca67a181cb36d34`, on its three public subnets
(`subnet-05be7e2c146d6ede8`/`04f03f730a553b579`/`08d892f0f99bd8097`, each tagged
`kubernetes.io/role/elb=1` so the load balancer controller will place an ALB in them) — the
default VPC rather than a purpose-built one because the RDS instances live in it too, reachable
with no peering and no NAT. Two managed node groups are declared:

- **`ng-spot`** — spot-only (`t3.medium`/`t3a.medium`, min 1, max 2, desired 1), what dev and
  staging run on. A two-minute spot-reclaim notice is an acceptable outage for dev's whole
  footprint (one API pod, one UI pod, room to spare on a single 4 GiB node), and spot runs
  roughly 70% off the same instance type on-demand. This is the only group that exists today.
- **`ng-prod`** — on-demand `t3.medium`, min/desired 3, max 6, one node per AZ
  (`ap-south-1a`/`b`/`c`), labelled `rch.io/tier: prod`, 40 GB gp3. **It is declared and not yet
  created**: run `eksctl create nodegroup -f deploy/eksctl/cluster.yaml --include=ng-prod`
  (the `--include` matters — without it eksctl works on every group in the file) before the
  first production deploy. `values-prod.yaml` pins both Deployments to it with
  `nodeSelector: { rch.io/tier: prod }`, which is what keeps production off the spot node — the
  group carries **no taint**, deliberately, because the DaemonSets (vpc-cni, kube-proxy, the
  CloudWatch agent) have to run on every node and know nothing about this application. Three
  nodes across three AZs is also what makes production's PodDisruptionBudget and topology spread
  mean anything; on one node both are decorative. `maxSize: 6` is a ceiling, not autoscaling —
  the cluster has neither Cluster Autoscaler nor Karpenter.

`deploy/eksctl/cluster.yaml` is the source of truth for the cluster, its node groups and its
add-ons, and its header says so in three lists — including what moved to CloudFormation (RDS,
ECR, the OIDC provider and deploy role, Secrets Manager, ACM, Route 53, the health check, SNS,
the ALB log bucket) and what is managed by neither (the AWS Load Balancer Controller's own Helm
install).

**What tripped: the first cluster came up without CoreDNS.** `eksctl create cluster`'s own run
was cut short after the control plane finished, before it installed the managed add-ons, and
nothing scheduled a pod could resolve a name — not the API's own RDS endpoint lookup, not the
load balancer controller's calls out to AWS — until `vpc-cni`, `coredns` and `kube-proxy` were
installed by hand as EKS add-ons. `deploy/eksctl/cluster.yaml` now declares five under
`addons:` — `vpc-cni`, `coredns`, `kube-proxy`, **`metrics-server`** (without a metrics API the
production HPA reports `<unknown>/70%` and never scales, and `kubectl top` cannot see a pod's
CPU either) and **`amazon-cloudwatch-observability`** (Container Insights: node, pod and
container metrics plus container logs, with `CloudWatchAgentServerPolicy`) — so a fresh `eksctl
create cluster` installs them itself. **A cluster that already exists does not pick up a new
add-on or a changed add-on setting from a re-run of `create cluster`**: that is `eksctl create
addon` / `eksctl update addon -f deploy/eksctl/cluster.yaml`. Confirm what is actually there
with `eksctl get addons --cluster rch --region ap-south-1` rather than assuming a cluster this
age matches the file.

The AWS Load Balancer Controller is the `eks/aws-load-balancer-controller` Helm chart, running under its own
IRSA role (`eksctl create iamserviceaccount`, policy `AWSLoadBalancerControllerIAMPolicy`, one
attachment). The deploy role, `rch-github-deploy`, holds an EKS **access entry** with
`AmazonEKSClusterAdminPolicy`, cluster-scoped:

```bash
aws eks list-associated-access-policies --cluster-name rch --region ap-south-1 \
  --principal-arn arn:aws:iam::830283280199:role/rch-github-deploy
```

### 15.2 Database

RDS `rch-dev`: Postgres **17** (17.9 as provisioned), `db.t4g.micro`, single-AZ, 20 GB gp3,
encrypted at rest, not publicly accessible, 7-day automated backups, subnet group `rch`,
security group `rch-rds` admitting **5432 from the VPC CIDR (`172.31.0.0/16`) only** — a
VPC-wide rule, not narrowed to the node group's own security group, so anything else in the VPC
can also reach it.

**That has now been acted on for staging and production, and dev keeps the wide rule on
purpose.** `deploy/cfn/rch-env.yaml` creates a **per-environment** security group
(`rch-rds-<env>`, `Condition: IsNotDev`) admitting 5432 from `NodeSecurityGroupId` and nothing
else; the shared `Fn::ImportValue` that fed every environment one group is gone, and so is the
export behind it. dev's wide rule survives as an explicit `DbIngressCidr` parameter whose own
description says out loud that it is wide and why dev gets it. What has **not** changed for any
environment is the subnet group: all three are in the default VPC's public subnets (§11 step 2's
follow-up).

The API decides TLS from **`DATABASE_SSL=true` alone**, with the RDS CA bundle baked into the
image — `db/client.ts` strips `sslmode`/`ssl*` off the URL first. The instance's own half,
`rds.force_ssl=1`, arrives with the per-environment parameter group the same template creates,
and is a **static** parameter: it stays `pending-reboot` until the instance is rebooted. Multi-AZ,
point-in-time recovery and deletion protection are the production-only pieces this instance
deliberately does not carry; §11 step 2 and `deploy/cfn/README.md` have the full production spec.

### 15.3 Secrets, and the GitHub side of the pipeline

AWS Secrets Manager `rch/dev` is the source of truth — RDS master password, `DATABASE_URL`, the
JWT pair. The GitHub **environment** `dev` carries its own copies of `DATABASE_URL`,
`JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` for the workflow to read (`secrets: { create: true }` in
`values-dev.yaml` — the same path staging will use; production is the one that reads Secrets
Manager directly, via External Secrets). Repository secrets `AWS_REGION`, `ECR_REGISTRY`,
`AWS_ROLE_ARN` and `EKS_CLUSTER_DEV=rch` now exist alongside `EKS_CLUSTER_STAGING=rch` and
`EKS_CLUSTER_PROD=rch` (all three name the one cluster — every environment is a namespace on it,
not a cluster of its own), and the repository variable `DEPLOY_ENABLED` is `true`.

**A `SEED_PASSWORD` repository secret must be added before the next deploy of any environment.**
`deploy.yml` reads it into the `--set-string` list beside the three JWT/database values, and
`apps/api/src/config.ts` now requires it with no default — an unset secret renders
`SEED_PASSWORD: ""`, the api container fails config validation on start, and `--atomic` rolls the
release back. Production's `rch/prod` secret in Secrets Manager needs the same key as its fifth
(§11's secrets table); `_helpers.tpl` wires it as a `secretKeyRef` in every container and
`render.test.sh` asserts it is never a plaintext `value:` and never `optional: true` — Go's `eq`
is variadic, so a second name in that template's `if eq` would silently make the key optional,
which is exactly what "required" is trying to prevent.

**What tripped: two failed deploy runs, both at `configure-aws-credentials`, for two unrelated
reasons.** The first failed with "Request ARN is invalid" — `AWS_ROLE_ARN` had been set to the
wrong value; re-setting the secret to the actual role ARN fixed that run. The second failed with
"Not authorized to perform sts:AssumeRoleWithWebIdentity" — a genuinely different problem, and
the one worth reading carefully before it recurs on staging or production: GitHub's OIDC token
presents a **subject** in one of two shapes depending on whether the organisation enforces its
immutable form — `repo:<org>/<repo>:…` (mutable, breaks if either is ever renamed) or
`repo:<org>@<org id>/<repo>@<repo id>:…` (immutable, keyed by ids GitHub never reassigns). This
organisation enforces the immutable form. `rch-github-deploy`'s trust policy was first written
against the mutable pattern, which the token this org issues can never match — no amount of
re-checking the mutable string would have found it, because nothing was wrong with it. What
found it was reading the subject a token actually presented, from CloudTrail rather than from
guessing at GitHub's docs:

```bash
aws cloudtrail lookup-events --region ap-south-1 \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
  --query 'Events[].{Time:EventTime,Sub:Username}'
# Sub: repo:Hashtricks-Technologies@276870206/RCH@1346139433:environment:dev
```

The repo's numeric ids come from `gh api repos/<org>/<repo> --jq '[.owner.id,.id]'`. The fix
lives in `deploy/cfn/rch-env.yaml` (parameter `GitHubRepoImmutable`) rather than a manual IAM
edit — the role is CloudFormation-managed now (§15.5). The trust policy applied by that first
update listed **both** shapes, `ref:refs/heads/{develop,staging,production}` and
`environment:{dev,staging,production}`, in both the named and the numeric-id form. **The audit
wave removed the six `ref:` subjects**; only the `environment:` ones remain. `deploy.yml` sets
an `environment:` on every deploy job, so nothing real loses access — what the `ref:` subjects
admitted was a workflow on `refs/heads/production` declaring *no* environment, which is the
production approval gate going missing. This has not yet been applied: it lands on the next
`rch-dev` stack update, and it takes effect on the dev deploy at that moment (§15.5).

```bash
aws iam get-role --role-name rch-github-deploy --query 'Role.AssumeRolePolicyDocument'
```

is how to re-check what it currently admits.

### 15.4 Certificate and DNS

The zone is `hashtrickstechnologies.com` in Route 53 (`Z066296313TA69I4LDOOI`) — **Route 53
holds the zone's LIVE name servers**, even though the domain is registered at Hostinger, so
every record (the CAA entries below, the app's own A-alias) goes in Route 53 and nothing at
Hostinger.

**The CAA lesson.** The zone's CAA records admitted only `letsencrypt.org`, `pki.goog` and
`sectigo.com` — none of Amazon's own issuers — so three ACM certificate requests for
`rch.hashtrickstechnologies.com` failed `CAA_ERROR` in a row. Adding Amazon's four issuers
(`amazon.com`, `amazontrust.com`, `awstrust.com`, `amazonaws.com`) as CAA records, both on the
host name and at the apex, was necessary but **not sufficient** — a name ACM had already looked
up and cached as refused stayed negative-cached even after the CAA record allowing it existed,
so the request that finally issued had to be for a name ACM had never seen before. **The rule:
create the CAA record before the *first* request for a name, not before the request meant to
succeed.** The dev certificate, issued, is
`arn:aws:acm:ap-south-1:830283280199:certificate/68a3b4db-2bfe-449a-8b79-8201a30bde0c`:

```bash
aws acm describe-certificate --region ap-south-1 \
  --certificate-arn arn:aws:acm:ap-south-1:830283280199:certificate/68a3b4db-2bfe-449a-8b79-8201a30bde0c \
  --query 'Certificate.Status'   # ISSUED
```

`rch.hashtrickstechnologies.com` is an **A-alias** to the ALB the ingress creates, which does
not exist until after the first deploy:

```bash
kubectl -n rch-dev get ingress rch -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

then a Route 53 **UPSERT** alias record pointed at that ALB's own DNS name and canonical hosted
zone id (`aws elbv2 describe-load-balancers` gives both). This is the step to repeat for staging
and production, once each has an ingress of its own to point at.

### 15.5 Environment resources are CloudFormation now

Everything above that used to be a CLI command typed by hand is now `deploy/cfn/rch-env.yaml`,
one template, one stack per environment. `rch-dev` was brought under it by an **IMPORT** change
set, not a plain create, and has since taken a further **update** (the CAA record, then the OIDC
trust-policy fix above) — `aws cloudformation describe-stacks --stack-name rch-dev` reads
`UPDATE_COMPLETE` with every resource's identifier published as a stack Output, including the
five it exports for `staging`/`prod` to import. `deploy/cfn/README.md` has the full procedure
and every constraint that shaped it: an import change set may add no Outputs, no stack Tags and
no resources beyond what it lists in `ResourcesToImport`; every resource the template declares
still needs an explicit `DeletionPolicy`; and the one resource that did not exist yet at import
time — the CAA record for the brand-new host name — was created by the plain update that
immediately followed the import, not smuggled into the import itself. `staging` and `prod`
stacks, when they exist, import `dev`'s shared singletons (the OIDC provider, the DB subnet
group and security group, both ECR repositories) by `Fn::ImportValue` rather than declaring
their own, because AWS refuses a second copy of any of the five. Read `deploy/cfn/README.md`
before touching any of it — it is being maintained separately from this document.

**Two changes since that import that matter before the next `rch-dev` stack update.**

- **The next update is not a no-op, and it is an outage window.** The template now creates a
  parameter group, an Enhanced Monitoring role and ECR lifecycle policies, removes six OIDC
  trust-policy subjects, and modifies `Database` (parameter group, `AutoMinorVersionUpgrade`,
  log exports, Performance Insights, Enhanced Monitoring, both windows). None of those replaces
  the instance, but attaching a parameter group containing a **static** parameter is *Some
  interruptions* in the CloudFormation reference, not *No interruption* — CloudFormation may
  satisfy it by rebooting `rch-dev` mid-deploy, at a moment nobody chose. Run it off-hours.
  `deploy/cfn/README.md`'s *"Run this stack update off-hours: it may reboot the database"*
  tabulates which properties can bounce the instance and which cannot.
- **The OIDC trust is narrowed to `environment:*` subjects.** The six
  `ref:refs/heads/{develop,staging,production}` subjects are gone. `deploy.yml` sets an
  `environment:` on every deploy job, so nothing real loses access — but applying this stops any
  workflow that assumes `rch-github-deploy` **without** declaring a GitHub environment, and it
  takes effect on the *dev* deploy the moment the stack is updated. What the removed subjects
  actually admitted was a workflow on `refs/heads/production` declaring no environment at all,
  i.e. the production approval gate going missing.

- **An IMPORT change set can no longer stand up a new environment under this template.** An
  import may create nothing, and every declared resource must be in the import list — which now
  includes a parameter group, a security group, a monitoring role, a health check, and
  conditionally a topic and a bucket. Use `create-stack` for `staging` and `prod`; the import
  path exists only because `rch-dev` predated the template. `deploy/cfn/README.md` says so and
  carries the procedure.

### 15.6 What dev costs

Roughly **$130/month** at AWS list prices, `ap-south-1`: the EKS control plane (~$73), one spot
`t3.medium` (~$10 — the same instance on-demand runs roughly triple), RDS `db.t4g.micro` (~$17),
and the ALB (~$22). Karpenter is not worth adding at this scale: one node group with a 1–2 spot
range already covers the whole footprint, and Karpenter's own value shows up at a scale this
environment neither has nor is expected to reach — the saving here is entirely the spot discount
on the managed group, not autoscaling sophistication.

**That figure is dev only, and `ng-prod` is not in it.** Creating the production node group adds
three on-demand `t3.medium` — roughly **+$90/month** before production's own ALB (~$22) and its
`db.t4g.medium` Multi-AZ instance. The EKS control plane is shared, so it is not paid twice.
Two smaller line items the template adds everywhere and nothing has been paying yet: an SNS
topic and a Route 53 health check (cents, and the health check is gated on `AlertEmail` being
set, so dev creates neither), and Performance Insights at the free 7-day retention, which costs
nothing on any of the three instance classes in use.

### 15.7 First deploy and seed

The workflow builds and pushes both images, then `helm upgrade --install rch deploy/chart/rch -f
values-dev.yaml --namespace rch-dev --create-namespace --wait --atomic` — the same shape §2
describes for staging and production, with `dev`'s own values file and namespace. After the
first deploy succeeds, seed the database once:

```bash
kubectl -n rch-dev exec deploy/rch-api -- /nodejs/bin/node dist/cli/seed.mjs --yes-seed rch
```

**`--yes-seed <database name>` is not optional here, and dev is not an exception.** `rch.envList`
renders `NODE_ENV=production` into every pod in every namespace, and `cli/seed.ts` refuses to seed
there until the database is named back, because a seed rewrites every seeded account's password.
`rch` is the name in every environment — `DBName` on the RDS instance is `rch` in `dev`, `staging`
and `prod` alike, the instance being what differs — so check `select current_database()` if you are
anywhere else. Without the flag the command exits 2 with that sentence and nothing is written; with
the old `--allow-production` alone it exits 2 naming `--yes-seed`. A re-seed additionally needs
`--force --yes-destroy rch`; CI's kind install runs the same `--yes-seed rch` form for the same
reason (`deploy/chart/rch/ci/install-test.sh`).

The seed accounts and `SEED_FORCE_PASSWORD_CHANGE` behave exactly as §1 describes for local
dev — this is the same seed CLI, run in the cluster instead of against `localhost:5439` — with one
difference that matters: the password those accounts get is now `SEED_PASSWORD` from the pod's own
environment, which has to exist as a secret before the deploy that precedes this command (§15.3).
**The six accounts seeded on `dev` before that change still carry the published `changeme`** and
need resetting (§11 step 4) — a required variable stops it recurring, it does not undo it.

## 16. Single-instance deploy (EC2 + Compose)

**Why this exists.** On 2026-09-12, with the EKS environment §15 describes costing roughly
$438/month and idle outside active development, the account owner tore it down completely (RDS
instance, the `rch-dev` CloudFormation stack, the cluster and its node group, the load
balancer, the DNS records, the certificate, the two ECR repositories and the deploy role — one
RDS snapshot, `rch-dev-final-20260912`, was kept before the delete). `DEPLOY_ENABLED` is set
`false` so a push to `develop` no longer tries to deploy to a cluster that is gone. In its
place: one EC2 instance running the application under Docker Compose, at roughly a tenth of the
cost, with an ordinary daily EBS snapshot standing in for RDS's automated backups. §15's
cluster, chart and CloudFormation stay exactly as written — reachable again with
`eksctl create cluster` and an `aws cloudformation deploy` the day a second environment (or the
availability a managed control plane buys) is worth the cost again — this section does not
retire them, it is the cheaper thing running meanwhile.

`deploy/compose/` is the whole of it: `compose.yml`, `Caddyfile`, `.env.example`, `deploy.sh`,
`backup.sh`, `compose.test.sh` (`pnpm compose:test`, the compose analogue of `helm:test`) and
its own `README.md` with the day-to-day commands. This section is what provisioned the box
around it and the reasoning behind each piece; `deploy/compose/README.md` is what an operator
runs.

### 16.1 What runs, and why it is shaped this way

Four containers, one instance, one Docker network: `postgres`, a one-shot `migrate` (the same
`dist/cli/migrate.mjs` the EKS `migrate` initContainer runs, ordered ahead of `api` by
compose's own `depends_on: condition: service_completed_successfully`), `api` and `ui` (built
from the identical `apps/api/Dockerfile` / `UI/Dockerfile` the EKS path builds — one image
definition per service, two places to run it), and `caddy` in front for automatic HTTPS.

**Caddy reaches `api` and `ui` directly, with no second reverse-proxy hop.** The EKS path is
ALB → (path routing) → `ui`'s nginx (which itself proxies `/api/` onward) or `api`; on one box,
Caddy's own path routing (`handle /api/*` vs `handle`) reaches each container directly, so
`TRUST_PROXY=1` (one hop) is correct unchanged — `ui`'s nginx still carries its `/api/` block
(it is the same image), it is simply never asked to use it here. `flush_interval -1` on the API
route is what keeps `/api/v1/events` (server-sent events) streaming rather than buffered.

**The API's distroless runtime image has no shell**, so it carries no `HEALTHCHECK` a container
orchestrator could run; `restart: unless-stopped` recovers a crash, and `deploy.sh`'s own final
step — polling `https://<domain>/healthz` through Caddy — is the health check that matters,
since it proves the whole chain rather than one container in isolation.

**`DATABASE_SSL=false` is set explicitly.** The API image always sets `NODE_ENV=production`, and
`config.ts`'s `databaseSsl` defaults to `true` whenever it is unset in production — right for
RDS, wrong for a container Postgres on the same Docker network with no TLS listener at all.

**Seeding still needs `--yes-seed rch`,** for the same reason §15.7 gives for the cluster: the
image runs `NODE_ENV=production` here too, and the guard does not treat "just launched on a new
box" as a reason to skip it. `deploy.sh` passes it automatically, and only the first time the
`users` table is empty — a later `deploy.sh` run against a stack that already has data is a
no-op on this step.

### 16.2 What was provisioned, once, by hand

Region `ap-south-1`, account `830283280199`, the same default VPC (`vpc-01ca67a181cb36d34`)
§15's cluster used:

- **Instance** `i-0b581bbf5e55e7a7f`, `t4g.medium` (2 vCPU, 4 GiB, Arm — Graviton is why the
  Compose deploy costs roughly half what the same shape costs on `t3`), Ubuntu 24.04 LTS arm64
  (`ami-004fef5ef59c0175f`, read from the `/aws/service/canonical/...` SSM parameter rather than
  pinned, so a rebuild picks up whatever is current), 30 GB gp3 root volume, encrypted,
  `IMDSv2` required (`HttpTokens=required`). User data installs Docker CE, the compose plugin,
  a 2 GB swap file (a t4g.medium's 4 GiB is comfortably enough for four containers, and swap is
  the difference between a slow moment under `docker compose build` and an OOM-killed one),
  and the AWS CLI — the box needs the last one for its own nightly backup upload.
- **Key pair** `rch-box` (Ed25519), private half at `~/.ssh/rch-box.pem` on the operator's own
  machine — it is not in git and has no other copy.
- **Security group** `sg-0592a55147df5d0a3` (`rch-box`): 22/tcp from the operator's own IP only,
  80/tcp and 443/tcp from anywhere (Caddy needs 80 for the ACME HTTP-01 challenge as well as the
  plain-HTTP → HTTPS redirect). Widen or narrow the SSH rule with
  `aws ec2 authorize-security-group-ingress` / `revoke-security-group-ingress` as the operating
  IP changes; there is no bastion and no SSM Session Manager wired up for this box.
- **Elastic IP** `65.2.95.154`, associated with the instance so a stop/start (unlike a
  terminate/relaunch) never changes the address DNS points at.
- **IAM role + instance profile** `rch-box`, trusted by `ec2.amazonaws.com`, carrying exactly
  one inline policy (`rch-backups-write`): `s3:PutObject` and `s3:ListBucket` on the backup
  bucket below and nothing else — the box cannot reach any other AWS resource, including the
  torn-down EKS account's own leftovers, with this role.
- **S3 bucket** `rch-backups-830283280199`, public access blocked, a 30-day expiration
  lifecycle rule on every object (so the nightly dumps do not accumulate forever) — `backup.sh`
  writes to it under `db/`.
- **DLM lifecycle policy** (`policy-0d0f10f7fc51be10e`): a daily EBS snapshot of every volume
  tagged `project=rch` (the instance's root volume is), at 21:30 UTC, 7 kept. This is the
  whole-box safety net beside `backup.sh`'s logical dump — a bad `apt upgrade` or a full-disk
  Docker mess is a volume restore, not a rebuild from `eksctl create cluster` all over again.
- **Route 53** `rch.hashtrickstechnologies.com` A record (zone `Z066296313TA69I4LDOOI`,
  TTL 60s — short, so a future re-point of the IP propagates quickly), pointed at the Elastic IP
  above rather than at anything ALB-shaped.

None of the above is in Terraform, CloudFormation or a script committed to this repository —
it was five `aws ec2` / `aws iam` / `aws s3api` / `aws dlm` / `aws route53` calls run once by
hand, listed here so the next person (or the next agent) can read what exists without
reconstructing it from the console. A `deploy/cfn/` template for this shape would be reasonable
future work if the box is ever rebuilt from scratch more than once.

### 16.3 First deploy and later ones

```bash
ssh -i ~/.ssh/rch-box.pem ubuntu@rch.hashtrickstechnologies.com
git clone https://github.com/Hashtricks-Technologies/RCH.git rch && cd rch
cp deploy/compose/.env.example deploy/compose/.env
# fill in DOMAIN, POSTGRES_PASSWORD, JWT_PRIVATE_KEY / JWT_PUBLIC_KEY
# (pnpm --filter @rch/api keys:generate, run anywhere with Node — the box itself needs none),
# SEED_PASSWORD (12+ characters), BACKUP_BUCKET
deploy/compose/deploy.sh
```

A later deploy is `git pull && deploy/compose/deploy.sh` — it rebuilds only what changed, brings
the stack up in the same dependency order, and never reseeds a database that already has rows
in `users`. Add the cron line from `deploy/compose/README.md` once, for the nightly backup.

### 16.4 What this trades away against the EKS path

One instance, so no rolling deploy — `deploy.sh` restarts `api` and `ui` in place, a handful of
seconds of connection refused rather than the EKS path's zero-downtime rollout. No horizontal
scaling — this shape suits the load a single hospital's F&B operation puts on it (§12's load
check), not a multi-tenant deployment. The database's durability is a nightly logical dump plus
a daily disk snapshot, not RDS's continuous point-in-time recovery — restoring means replaying
today's dump against a fresh `postgres:17`, losing whatever changed since the last one ran,
which for this box is at most last night's business. If either trade-off stops being
acceptable, §15's cluster and chart are still the answer; nothing here prevents standing them
back up.
