# RCH - Operations Runbook

Operational procedures for the Royal Care Hospital F&B backend (`apps/api`, `UI/`,
`deploy/chart/rch`) - how to actually run, deploy and recover it.

## 1. Local development

```bash
pnpm db:up                                    # postgres:17 in Docker, host port 5439 -> container 5432
cp .env.example .env
# then edit .env: SEED_PASSWORD= needs a value of your own, at least 12 characters
pnpm --filter @rch/api keys:generate >> .env   # appends JWT_PRIVATE_KEY= / JWT_PUBLIC_KEY=
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/audit db:migrate            # the audit schema; waits for the API's audit_outbox
pnpm --filter @rch/api db:seed
pnpm dev                                       # turbo run dev --parallel: api on :3000, audit on :3100, UI on :5173
```

**`SEED_PASSWORD` has no default any more** and `apps/api/src/config.ts` requires at least twelve
characters, so a copied `.env.example` will not start the API, `pnpm test`, or any CLI until one
is chosen - the failure is `Invalid environment:` naming the variable. That is deliberate: a
published default password on a host anyone can reach is a real door, and a seed rewrites every
seeded account's password. A database already seeded keeps whatever password it was seeded with;
only a new seed uses the new value.

Local Postgres listens on host port **5439**, not 5432 - a native PostgreSQL install commonly
already owns 5432 on a dev machine. `docker-compose.yml` maps `5439:5432`; `.env.example`'s
`DATABASE_URL` / `TEST_DATABASE_URL` already point at 5439. `pnpm db:down` stops it.

**The audit service runs beside the API**, on :3100, from the same `.env`. `AUDIT_DATABASE_URL`
(already in `.env.example`) is its connection, and it reads `JWT_PUBLIC_KEY` to verify the API's
tokens. Run its migrations after the API's: `pnpm --filter @rch/audit db:migrate` waits up to five
minutes for the API's `audit_outbox` table, then creates the `audit` schema. Vite sends
`/api/v1/admin/audit` to it and the rest of `/api` to the API. Without it running the application
works as before - every write still commits, and its audit event waits in `audit_outbox` - and only
the Audit log tab says it cannot reach the log.

Locally `DATABASE_URL`, `AUDIT_DATABASE_URL` and the unset `MIGRATE_DATABASE_URL` all name the one
`rch` user, so neither migrate step creates a role. To rehearse the deployed roles, set
`MIGRATE_DATABASE_URL` to the `rch` URL and give `DATABASE_URL` and `AUDIT_DATABASE_URL` the users
`rch_app` and `rch_audit` with passwords of your own: the two migrate steps create both roles and
grant them (§5, *The database roles*).

`keys:generate` prints a fresh Ed25519 pair as two `JWT_*=` lines - append them to `.env` (as
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
in-cluster seed - dev, CI's kind cluster, staging - is the `--yes-seed <name>` form (§15.7, and
`deploy/chart/rch/ci/install-test.sh`). Naming the database is the point: a flag typed on every
in-cluster seed is a flag nobody reads, and `--yes-seed rch_dev` cannot be muscle memory for
`rch`. `--allow-production` is still recognised, and on its own is now **refused** with a sentence
naming `--yes-seed`, so an old runbook line fails loudly instead of quietly doing the wrong thing.
Development and test are unchanged. The rules themselves are one pure function,
`apps/api/src/lib/seed-guard.ts`.

**`--bare` is the seed a real deployment starts from.** It writes the six locations, the document
numbering and the one admin account (`RC-0001`, on `SEED_PASSWORD`), and nothing of the demo
hospital - no items, prices, menus, stock, payers, vendors, documents or demo staff.
`deploy/compose/deploy.sh` passes it on a first run; local development, the test suites and CI's
kind install keep the demo seed, because they are written against it. Both production guards apply
to it exactly as to the demo seed, and `--bare --force` over a database that already holds the
demo hospital empties it first - which is how a host seeded with demo data is put back to a
clean start (§16.5):

```bash
pnpm --filter @rch/api db:seed --bare                                      # locally
dist/cli/seed.mjs --bare --force --yes-seed rch --yes-destroy rch          # on the box, through the migrate service (§16.5)
```

What a bare hospital needs before it can sell anything, in the order the screens need it: the
real staff accounts (`RC-0001` at `/admin`), the item master (the store's, buyer's or kitchen's
**Add Product**), shelf
prices and menus (the manager's **Price Lists** and **Items & Stock**), the payer register
(`/admin`'s **Payers** tab, or the CSV in §5), what each party is charged (the manager's **Credit
& Settlements**: every category opens at 0% off, so nothing is given away until somebody sets it),
and stock (a goods receipt, or an adjustment count-up for an opening balance).

### Test users

Seed password is `SEED_PASSWORD` from `.env` - **required, at least twelve characters, no default**
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
| `RC-0001` | System Administrator | Super Admin (a flag, not a role - see below) | - |

`rest`, `coffee` and `kiosk` are what a demo or bare seed opens with, not a closed list: the super admin opens,
edits, closes and reopens outlets from `/admin` (§5 below), and a new one gets its own key, minted from its
name once.

Sign in at `http://localhost:5173`: staff pick themselves from the employee list (read from the
public `GET /auth/directory`, number and name only), then type the seed password. The super admin
is not on that list; use "Sign in as administrator" and type `RC-0001`.

`RC-0001` is the one seeded account carrying the admin flag - account management
(create/reset/deactivate/reassign/delete a colleague from its own standalone dashboard at
`/admin`), outlet management (open, edit, close, reopen - never delete), the support desk and the
audit log are a capability, not a role: signing in as it shows no operational sidebar at all, only
that page, and the API answers its token with a 404 on every operational route (`/events` excepted,
for the desk). Its nominal role and location
(`buyer`/`store` in the fixture) are the schema's own bookkeeping; the wire labels the account
`Super Admin` and the page offers no role or location to change.

A new account's employee number is assigned by the server (one past the highest `RC-<digits>`),
never typed. **Delete** is offered only for a deactivated staff account, and the server refuses it
for any account with history (a bill, an approval, a stock move): such an account can only stay
deactivated. The recent-actions log keeps a deleted account's name.

Granting or revoking the flag on **any** account - including moving it off `RC-0001` onto a real
person's own account once one exists - is the one thing this page cannot do:

```bash
pnpm --filter @rch/api users set-admin --emp RC-4471 --on   # --off takes it away again
```

There is no route or button anywhere in the app that can grant or revoke this flag - only this
command, run with a shell on the box or a `kubectl exec` into the pod, which is what keeps a
compromised or misused admin session from ever minting a second one. Before a real go-live,
deactivate `RC-0001` the same way every other seeded account is deactivated (§11 step 4) and
create a real, named account with the flag instead.

### Auth and rate-limit settings

From `.env` / `apps/api/src/config.ts` (mirrored in `deploy/chart/rch/values.yaml`'s `api.env`
in the cluster):

- `LOGIN_RATE_LIMIT_PER_MINUTE` (default `10`) - `/auth/login` attempts per minute, keyed by
  the caller's IP.
- `LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE` (default `5`) - `/auth/login` attempts per minute,
  keyed by the employee id being signed in as, independently of the per-IP limit above.

  **Both budgets are per pod, not cluster-wide** - and neither line above said so until the audit
  fix wave. `@fastify/rate-limit` keeps its window in the process's own memory, and so does the
  per-employee gate, so the number an attacker actually gets is the configured one **times the
  replica count**. `apps/api/src/modules/auth/service.ts` used to claim the per-IP limit was
  effectively cluster-wide because the load balancer fronted it; that was wrong, and its comment
  now says what is true. A shared store (Redis) is the fix if either ever has to be exact; none is
  deployed and none is planned. Size the numbers against the replica count, not against one pod.

  **The per-employee budget counts failures only, and is spent the moment an attempt starts.**
  Five correct sign-ins in a minute lock nobody out - the slot is given back when the password
  proves right. A wrong one keeps its slot for the window. The attempt is charged *before* the
  password is verified, because Argon2 takes 50–100 ms and a budget charged afterwards let a
  hundred simultaneous guesses at one id all reach the verifier. The consequence to know before
  somebody reports it as a bug: a **sixth simultaneous** sign-in at one employee id is refused
  whether the password is right or wrong, since the server cannot know which until it has
  verified. Six tills signing in on the same id within the same second is the only way to see it,
  and the answer is to wait a minute.
- `TRUST_PROXY` (default `"1"`) - how many hops of `X-Forwarded-*` to trust when deriving the
  caller's IP (which both limits above key on). `"1"` trusts exactly the nearest hop - the ALB
  in the cluster, the Vite dev proxy locally - which is correct for both topologies as shipped.
  Set it to a different hop count, or to a CIDR/IP list, if a deployment adds another hop (a
  CDN in front of the ALB, say) or otherwise doesn't match. `values.yaml` does not currently
  override it, so the cluster runs on this default.
- `ACCESS_TOKEN_TTL` (default `15m`) - JWT access-token lifetime.
- `REFRESH_TOKEN_TTL_DAYS` (default `30`) - `rch_refresh` cookie lifetime; the cookie itself
  rotates on every refresh regardless of this setting.
- `COOKIE_SECURE` (default `true`; `.env.example` sets it `false` for local http) - whether the
  `rch_refresh` cookie requires HTTPS.
- `SEED_PASSWORD` - **required**, minimum twelve characters, no default (above). In the cluster it
  is a `secretKeyRef` like the JWT keys, never a plaintext `value:`.
- `DATABASE_SSL` - **left unset it follows `NODE_ENV`**: TLS on in production, off everywhere
  else. Setting it still wins in both directions (a staging pod pointed at a local proxy can turn
  it off), and `.env.example` ships it commented out for exactly that reason. `db/client.ts`
  strips any `sslmode`/`ssl*` parameter off `DATABASE_URL` first, so a connection string can never
  quietly choose a different trust store than the RDS bundle.

### A sign-in that is refused

The browser shows the refusal on the sign-in form itself - "That employee id and password do
not match." - and that one sentence covers three cases on purpose: no such employee id, a wrong
password, and a deactivated account. The API tells them apart on the request's own log line,
never in the response:

```bash
kubectl logs deploy/rch-api -n <namespace> | grep '"route":"/api/v1/auth/login"' | grep '"status":401'
```

Each such line carries `"refusal":{"code":"unauthenticated","message":"…","cause":"…"}`, and
`cause` is one of `no such employee`, `wrong password for RC-4471` or `RC-4471 is deactivated`.
An id that matched nobody is deliberately not written into the log - what was typed into that
box may well have been the password. Every other 4xx carries the same `refusal` field (its
`code` and the sentence the caller read); a 5xx is logged in full under `"msg":"unhandled"`,
and the sentence the caller read ends with the request id to look it up by.

**The audit log keeps these too, for good.** Every refused sign-in is also an audit event
(`login`, `refused`) with the same `cause`, the caller's IP and device. For an id that matched
nobody, the event keeps what was typed only when it has the shape of an employee number (`RC-`
and digits), so a mistyped `RC-0000` shows who tried while a password typed into the id box is
stored as an empty id and never reaches the log either. A locked-out attempt, under either
budget, is an event too. The Audit log's failed sign-ins count reads them all; §16.7 has the same
from `psql`.

A forgotten password is reset with `users reset-password` (§5); the account then carries
`must_change_password` and is asked to choose a new one at its next sign-in. A seeded account's
password stops being the seed password the moment somebody signs in as it and goes through that
step - `RC-4471` on `dev` did, on 2026-09-07 - so "the seed password does not work" for one
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
creates for parallel test runs. Review the generated SQL in `apps/api/drizzle/`, then commit it -
migrations are forward-only (§3) and reviewed like any other change.

**The snapshots are reconciled - `meta/0012_snapshot.json` is what the next `db:generate`
diffs against.** All six of `0007`–`0012` were written by hand, so `drizzle/meta/` sat at
`0000`–`0006` and the next generate would have tried to re-emit everything those six already did.
That reconcile was run once, on 12 September 2026: the emitted SQL restated `0007`–`0012` and
nothing else, which is the proof that `src/db/schema/*.ts` and the applied SQL agree, and **no
schema file needed changing**. The emitted `.sql` and its journal entry were deleted and the
snapshot renamed; nothing was applied to any database by it.

The next hand-written migration will need the same pass, and the procedure is written up in
`apps/api/CLAUDE.md`'s *Migrations* section - including the four drizzle-kit behaviours it rests
on, one of which will bite whoever ignores it: **a hand-written `when` must be in the past**,
because the migrator applies a file only where its `when` is greater than the highest
`created_at` already recorded, and a later migration carrying a smaller one is **silently
skipped** with no error anywhere.

`pnpm --filter @rch/api db:migrate` applies pending migrations; it is what the `migrate`
initContainer on every api pod also runs (`dist/cli/migrate.mjs`) - see §2. It runs with **no
statement timeout and no lock timeout** (`statementTimeoutMs: 0`, then `set lock_timeout = 0`
before `pg_advisory_lock(727272)`), as do `db:seed`, `db:rebuild-balances` and the purge: waiting
on that advisory lock behind another replica is the whole point of the initContainer, and the
API's ordinary 15 s statement timeout was cancelling the wait mid-rollout, which presents as
`Init:CrashLoopBackOff`.

**The first thirteen migrations** (`apps/api/drizzle/0000`–`0012`): `0000` is the initial schema, `0001` adds
the unique index on `refresh_tokens.token_hash`, `0002` installs the append-only trigger on
`stock_moves` (§7), `0003` adds `bills_staff_credit_idx` - a partial btree index on
`bills (payer_kind, payer_id, at) where payer_kind = 'staff'`, so the staff-credit ceiling's
per-person, per-month sum (`packages/domain/src/credit.ts`) does not scan the whole table on
every sale. The index does **not** carry `tender` - the query that reads it
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
`sequences` row `ADJ-` numbers are drawn from - the one migration in the set that inserts data as
well as schema. `0011_prod_orders_need_by` adds one nullable `date`. `0012_bills_void` adds
`bills.voided_at`, `voided_by` and `void_reason` plus the `voided_by` foreign key to `users`.
None of the four validates an existing row, so none of them can refuse the way `0008` can.

Four more since. `0013_admin_accounts` adds the `admin_actions` table and the `users.admin` flag;
`0014_admin_actions_target_name` keeps each admin action's target name, so the log still reads
after an account is deleted; `0015_drop_recipes` drops `recipe_lines` and `recipes`; and
`0016_audit_outbox` adds `audit_outbox`, the table every audit event is written into, with a trigger
that refuses every UPDATE on it (§5, *The database roles*). The audit service's own migrations are separate:
`apps/audit/drizzle`, recorded in `audit_drizzle` rather than `drizzle` and applied by
`pnpm --filter @rch/audit db:migrate` (the `audit-migrate` step when deployed) behind
`pg_advisory_lock(727273)`, so they never change the API's count.

A fresh `db:migrate` against an empty database reports every journal entry applied; against an
already-current one it reports `migrations applied: N / N`, N being the number of entries in
`apps/api/drizzle/meta/_journal.json`, which is also what `/readyz` compares against. Both were
proved, at thirteen, on a scratch database created and dropped for the purpose - a first migrate
from empty, then a second run on the same database to prove the migrate is idempotent.

**`0008` validates existing rows, so on any database with data in it, probe before you migrate.**
The five likeliest, and what to do about each - `apps/api/scripts/preflight-0008.sql` probes all ten:

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
and can be deleted - but `stock_moves` is trigger-protected against DELETE (`0002`), so drop the
trigger, delete, and re-create it from `0002`'s own SQL in one transaction. A `reservations` row
pointing at a ticket that does not exist is a hold nothing can ever release: close it
(`update reservations set released_at = now() where id = …`) and tell the location, because their
free-to-promise is about to rise. A ticket from a location to itself, a `po_lines` row with more
rejected than received, or a batch that yielded more than it started are each data that was never
possible through the API - read `document_history` for the document first and correct it by hand
with somebody watching. Run the probes on a restored copy if the production window is tight; they
are plain reads and cost nothing.

One more thing worth a look on the same pass, and it is not a `0008` constraint. Before the audit
fix wave a purchase order reached `Received` on what **arrived**, so an order whose delivery was
rejected in part or whole could be sitting at `Received` - which is terminal, closing both the
close-short and the cancel doors - with the balance still genuinely owed:

```sql
select p.id, l.line_no, l.qty, l.received_qty, l.rejected_qty
from purchase_orders p join po_lines l on l.po_id = p.id
where p.status = 'Received' and l.rejected_qty > 0
  and round(l.received_qty - l.rejected_qty, 3) < l.qty;
```

There is **no backfill migration** for this, on purpose: only a dev database could hold one, and
dev is reseeded. If a real order ever does turn up, the correction is one statement -
`update purchase_orders set status = 'Partially received' where id = '…';` - after which the
buyer's own close-short door works again and hands the shortfall back to the requisition. Do it
with the buyer watching, and write down why.

## 2. Deploy

**A deploy is triggered by CI passing, not by the push.** `.github/workflows/deploy.yml` is
`on: workflow_run: { workflows: ["CI"], types: [completed], branches: [develop, staging,
production] }`, and every job carries `github.event.workflow_run.conclusion == 'success'`. The
old `on: push` fired deploy.yml *alongside* ci.yml, so a red typecheck, a failed test or a
CRITICAL in an image could reach a cluster while CI was still running - the two were racing, not
ordered. **All three jobs** additionally require `github.event.workflow_run.event == 'push'`:
`branches:` matches the CI run's head branch, so a pull request raised **from** `staging`
**into** `production` - the documented hotfix flow - would otherwise satisfy it and deploy an
unmerged PR head. The clause is repeated on `deploy` and `skipped` rather than left to `guard`
alone because `needs: guard` skips a dependent only when guard's *result* is failure or
cancelled - a job skipped by its own `if:` is not a failure, and a dependent still runs.

Everything the workflow uses is pinned to `github.event.workflow_run.head_sha` /
`head_branch`. **`github.sha` and `github.ref_name` are not usable under this event** - they
point at the default branch's tip, not at what CI just passed - so if you add a step, take the
branch and the commit from `head_branch`/`head_sha` like every other step does.

It is still gated by the repository variable `DEPLOY_ENABLED=true` (the `skipped` job runs
instead). It builds and pushes the `api`, `UI` and `audit` images to ECR, **scans the three tags it is
about to deploy** (see below), then `helm upgrade --install rch deploy/chart/rch -f
values-<env>.yaml --set image.tag=<sha> --namespace <namespace> --create-namespace --wait
--timeout 15m`, with `--atomic` on dev and staging only. `develop` is `values-dev.yaml` /
`rch-dev` - the only one of the three actually deployed today, at
`https://rch.hashtrickstechnologies.com`; §15 records how it was stood up on AWS and what
tripped on the way. `staging`/`production` are `values-staging.yaml`/`values-prod.yaml` and
`rch-staging`/`rch`, prepared but not yet provisioned (§11).

### Two consequences of `workflow_run` worth knowing before you need them

1. **GitHub always runs the DEFAULT branch's copy of `deploy.yml`.** A `workflow_run` handler is
   executed as it exists on `develop`, never as it exists on `staging` or `production`. Under the
   fast-forward promotion model that is usually benign - `develop` is always ahead - but it means
   an edit to `deploy.yml` governs a **production** deploy the moment it lands on `develop`, not
   when `production` is promoted. "Byte-identical to what passed on staging" is true of the
   application; it is not true of the workflow that ships it. Treat a change to `deploy.yml` as
   a production change and review it as one.
2. **A failed production upgrade now leaves the release stuck, on purpose.** Production takes
   `--wait` without `--atomic` (why, below), so a failure leaves helm in `pending-upgrade` -
   and the *next* deploy fails with "another operation (install/upgrade/rollback) is in
   progress" until a person clears it. §3 has the two commands: `helm rollback rch -n rch` after
   a failed **upgrade**, `helm uninstall rch -n rch` after a failed **first install** (which
   leaves `pending-install`, with no earlier revision to roll back to).

### What the workflow checks before it touches a cluster

- **Trivy, on the exact tags helm is about to deploy.** `ci.yml` scans `rch-api:ci` / `rch-ui:ci` /
  `rch-audit:ci` - images it built itself, which are not the bytes that reach a cluster. One step per
  image in `deploy.yml`, between the push and `helm upgrade`, scans
  `<ECR_REGISTRY>/rch-{api,ui,audit}:<head_sha>` pulled back out of ECR, at
  `severity: CRITICAL,HIGH`, `exit-code: 1`, `ignore-unfixed: true`,
  `trivyignores: .trivyignore.yaml` - the same action version and the same ignore file as
  ci.yml, so the two scans cannot drift apart. They run whether the builds ran or were skipped
  as already-pushed (the repositories refuse to overwrite a tag, so a re-run of a commit whose
  images are already in ECR skips the build rather than failing on the push).
- **Every secret the chart needs is present.** A named step before `helm upgrade` refuses, by
  name, when any of `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `AUDIT_DATABASE_URL`,
  `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `SEED_PASSWORD` is empty - `--set-string` would otherwise
  write the empty string into the Secret and a container would fail config validation minutes
  later, with nothing in the log about where the blank came from. It collects all six before
  exiting, so one run names every missing one. It is **scoped to non-production**
  (`head_branch != 'production'`): production reads the same six from AWS Secrets Manager through
  the External Secrets Operator, so those GitHub secrets are empty there on purpose and an
  unconditional guard would refuse every production deploy.

### `--atomic` on dev and staging, `--wait` alone on production

dev and staging keep `--atomic`: they are rebuildable, nobody is mid-shift on them, and an
automatic undo is worth more there than the wreckage of the failed attempt. Production takes
`--wait` alone, for two reasons:

- `--atomic` deletes the failed release's pods the instant it gives up, and takes with it the
  only two things §3's recovery actually reads - the pod events and the `migrate`
  initContainer's log. "The rollout failed" with no way to learn why is worse than a stuck
  release.
- **A migration that already committed is not undone by rolling the Deployment back.**
  `--atomic` would put the previous image in front of a schema it was never written for, which
  is a second, quieter outage on top of the first (§3, *Migrations are forward-only*).

So on production a failure stops, keeps the evidence, and waits for a person to decide whether
the right move is forward or back. Two steps make that workable:

- **`What the cluster saw`** (`if: failure()`, every branch, before any rollback) prints
  `kubectl -n $NS get pods,events --sort-by=.lastTimestamp | tail -80` and `kubectl -n $NS logs
  -l app.kubernetes.io/component=api -c migrate --tail=200` into the job log, and the audit pods'
  `audit-migrate` and `audit` logs the same way. All `|| true`: a first install that never made a
  pod must not turn a missing log into a second failure.
- **`Unstick the release`** (`if: failure()`, **not** production) reads `helm status -o json`
  first and rolls back only from `pending-upgrade`, `pending-install`, `pending-rollback` or
  `failed`, and only when `helm history` shows at least two revisions. A bare `helm rollback`
  run unconditionally would be harmful: `--atomic`'s own rollback creates revision N+1 carrying
  the old content, and `helm rollback` with no revision goes back exactly one - to N, the
  revision that just failed. This step exists for the case `--atomic` could not handle itself
  (the job timed out mid-upgrade, or the automatic rollback hit the same wall the upgrade did).

Migrations are not a separate Helm hook Job - they run as a `migrate` **initContainer** on
every api pod (`dist/cli/migrate.mjs`, `deploy/chart/rch/templates/api-deployment.yaml`), ahead
of the `api` container on that same pod. Several replicas can start together during a rollout,
so the CLI takes a Postgres advisory lock (`pg_advisory_lock(727272)`, `apps/api/src/cli/
migrate.ts`) before running migrations: the first pod to acquire it applies pending migrations
and releases the lock; the rest block on the same lock, then find nothing left to apply. A
failing migration means the initContainer never completes, so that pod never becomes Ready;
with `rollingUpdate.maxUnavailable: 0` on the api Deployment, the old pods keep serving traffic
and `helm upgrade --wait` - the deploy workflow's install/upgrade step - times out rather than
completing, and the previous release stays live. **To recover:** inspect the stuck pod
(`kubectl describe pod`, `kubectl logs <pod> -c migrate -n <namespace>`) to see the migration
error, then either fix it forward with a new migration or `helm rollback rch <revision> -n
<namespace>` (§3) to abandon the attempt - rolling back does not undo an already-applied
migration (§3 explains why that's usually fine). A production push additionally waits for a
GitHub environment approval before the deploy job runs, and a fast-forward guard checks
`staging ⊂ develop` and `production ⊂ staging` so the branches can never diverge.

The audit pods have the same shape: an `audit-migrate` initContainer (`dist/cli/migrate.mjs` from
the `rch-audit` image, `deploy/chart/rch/templates/audit-deployment.yaml`) ahead of the `audit`
container, behind its own `pg_advisory_lock(727273)`. It first waits up to five minutes for the
API's `audit_outbox` table to exist, so the api and audit Deployments may roll out in either
order; if the table never appears it exits 3, which almost always means the API's `migrate`
failed first - read that log before this one. Its role and grant step also takes the API's
727272, because both steps grant on `audit_outbox`. Both migrate steps connect with
`MIGRATE_DATABASE_URL` (`rch`) and create their runtime role - `rch_app` from `DATABASE_URL`,
`rch_audit` from `AUDIT_DATABASE_URL` - and re-grant it on every run (§5, *The database roles*).

### CI: a real `helm install`

Every push to `develop`/`staging`/`production` and every pull request exercises the chart for
real, not just `helm lint`/`helm template`: the `images` job in `.github/workflows/ci.yml`
builds `rch-api:ci`, `rch-ui:ci` and `rch-audit:ci`, spins up a throwaway
[kind](https://kind.sigs.k8s.io/) cluster (`helm/kind-action`), loads all three images into it,
then runs `deploy/chart/rch/ci/install-test.sh`, which applies the CI-only single-replica Postgres
(`deploy/chart/rch/ci/postgres.yaml`) itself and waits for it before anything else:
`helm install` with `deploy/chart/rch/ci/values-ci.yaml` (a freshly generated Ed25519 pair
passed via `--set-string`, never committed; `MIGRATE_DATABASE_URL` as `rch`, `DATABASE_URL` as
`rch_app` and `AUDIT_DATABASE_URL` as `rch_audit`, so both migrate initContainers create their
roles for real), then seed the database from a one-off pod built from the api Deployment's own
`migrate` initContainer (the api container holds no superuser URL - §5, *Operator CLIs in a
cluster*), with `SEED_FORCE_PASSWORD_CHANGE=false` so `RC-0001` signs in as a plain admin. It
confirms `/readyz` and a login as `RC-3120` through a port-forward, and the UI's `/healthz`. Then
the audit check: wait for `deploy/rch-audit`, require its `/readyz` through a port-forward, sign
in as `RC-0001` through the API, and poll `GET /api/v1/admin/audit` from the audit service with
that token for up to 15 s - the sign-in just made must appear, which proves outbox → drainer →
read on a real cluster. Finally
`helm upgrade --install` with the same values and check `/readyz` on both again - proving the
upgrade path keeps the rendered Secret in place and both migrate initContainers apply nothing
the second time. On a failure the diagnostics print the audit pod's `audit-migrate` and `audit`
logs beside the API's. The cluster is deleted with the runner at the end of the job. Run it
locally with `kind` installed: `deploy/chart/rch/ci/install-test.sh` against a cluster that
already has `rch-api:ci`/`rch-ui:ci`/`rch-audit:ci` loaded (`kind load docker-image`) and `JWT_PRIVATE_KEY`/
`JWT_PUBLIC_KEY` exported (the two lines `pnpm --filter @rch/api keys:generate` prints, already
base64-encoded - export them as-is).

Required repository secrets: `AWS_ROLE_ARN`, `AWS_REGION`, `ECR_REGISTRY`, `EKS_CLUSTER_DEV`,
`EKS_CLUSTER_STAGING`, `EKS_CLUSTER_PROD` (all three cluster secrets name the one cluster, `rch` -
every environment is a namespace on it, not a cluster of its own). Required GitHub
**environment** secrets for `dev` and, later, `staging`: **six** - `DATABASE_URL` (the `rch_app`
URL), `MIGRATE_DATABASE_URL` (the `rch` URL), `AUDIT_DATABASE_URL` (the `rch_audit` URL),
`JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` and **`SEED_PASSWORD`** (these populate `secrets.values.*`
for the chart's in-cluster `Secret`, since both run with `secrets.create=true`). The two role
passwords are whatever those URLs carry: the migrate steps set them on the roles. Production runs
with `secrets.create=false` and `secrets.externalSecret.enabled=true`, pulling **seven** -
`DATABASE_URL`, `MIGRATE_DATABASE_URL`, `AUDIT_DATABASE_URL`, `JWT_PRIVATE_KEY`,
`JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY` (may be empty) and `SEED_PASSWORD` - from AWS Secrets
Manager (`rch/prod`) via the External Secrets Operator; no database or key secrets live in GitHub
for prod.

**`SEED_PASSWORD` is blocking, not optional.** It has been a required variable with no default
since the audit fix wave (`apps/api/src/config.ts`), and `config.ts` is what the **migrate
initContainer** loads before it opens a connection - so a secret without it produces an
initContainer that exits on `Invalid environment: SEED_PASSWORD: Too small …` and a pod that
never starts. On dev and staging `--atomic` rolls that back; **production deliberately upgrades
without `--atomic`** (§3), so the release is left sitting in `pending-install`/`pending-upgrade`
and has to be cleaned up by hand before the next attempt. The `Every secret the chart needs is
present` step in `deploy.yml` checks the GitHub secrets ahead of a **dev or staging** upgrade -
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
  created with one node group, `ng-spot`, and `values-prod.yaml` pins all three Deployments to
  `rch.io/tier: prod` - a label nothing carries. Create it **before the first production deploy**
  (§11 step 8 is where it sits in the order):
  ```bash
  eksctl create nodegroup -f deploy/eksctl/cluster.yaml --include=ng-prod
  kubectl get nodes -l rch.io/tier=prod        # expect 3, one per availability zone
  ```
  Three on-demand nodes across `ap-south-1a/b/c`, deliberately untainted: the label is what pins
  production in, and a taint would additionally keep the DaemonSets off. Skip it and all three
  Deployments sit `Pending` for ever with no error anywhere - and production upgrades without
  `--atomic` (§3), so nothing rolls that back. `deploy/chart/rch/tests/render.test.sh` asserts
  that the label the prod render asks for is one `deploy/eksctl/cluster.yaml` actually applies.
- **The pod readiness gate is not optional on this chart, and nothing enforces it.** The ingress
  uses `target-type: ip`, so the ALB registers each pod directly. Without the label a new pod
  counts as Ready the moment its own probe passes, while the load balancer is still registering
  it - and the api Deployment's `maxUnavailable: 0` then retires an old pod that was still
  serving in favour of a new one that is not yet receiving anything, which is a gap in the middle
  of a rollout. With the gate, Ready means "registered and healthy in the target group". The
  chart's `NOTES.txt` prints the command after every install, but a Helm NOTES block is easy to
  scroll past, which is why it is also here and in §11's checklist. It is a namespace label, so
  it survives every release; check it with `kubectl get ns <ns> --show-labels`.
- **Cluster add-ons the chart assumes but does not install.** All four are declared in
  `deploy/eksctl/cluster.yaml` except the first, which is a Helm chart of its own:
  - **kube-prometheus-stack** (or any Prometheus Operator). `templates/servicemonitor.yaml` and
    `templates/prometheusrule.yaml` are gated on `.Capabilities.APIVersions.Has
    "monitoring.coreos.com/v1"`, so without it they simply do not render - no alerts, no error,
    and a `helm upgrade --atomic` that would otherwise have failed on an unknown kind goes
    through. Both carry `release: {{ serviceMonitor.releaseLabel }}` (default
    `kube-prometheus-stack`), which is the label that operator's Prometheus selects rules by:
    install it under a different Helm release name and set `serviceMonitor.releaseLabel` to
    match, or the rules load and are never evaluated. §9 lists what ships.
  - **metrics-server.** `values-prod.yaml` turns on an HPA; without a metrics API it reports
    `<unknown>/70%` and never scales.
  - **amazon-cloudwatch-observability**, with `CloudWatchAgentServerPolicy`.
  - **Network policy in the `vpc-cni` add-on.** `templates/networkpolicy.yaml` renders a
    default-deny plus one ingress policy each for the api, the audit service and the ui
    (`networkPolicy.enabled: true`). They restrict ingress only: egress stays open for every pod,
    the audit service's included, because RDS sits outside the cluster at an address the chart
    does not know. A NetworkPolicy is enforced by the CNI, and the VPC CNI's policy agent is off unless the
    add-on is configured for it. `deploy/eksctl/cluster.yaml` now sets it -
    `configurationValues: '{"enableNetworkPolicy": "true"}'` on `vpc-cni` - **but a config file
    only reaches a cluster that is asked to read it.** For `rch`, which already exists:

    ```bash
    eksctl update addon -f deploy/eksctl/cluster.yaml --name vpc-cni
    aws eks describe-addon --cluster-name rch --addon-name vpc-cni --region ap-south-1 \
      --query 'addon.configurationValues'     # must show enableNetworkPolicy true
    ```

    Until then the objects are applied and **inert**. Turn it on deliberately, on staging first,
    and watch a rollout: this is the change in the chart with the most blast radius and the
    least local verification. `networkPolicy.enabled=false` stops rendering them. (kind, in CI,
    uses kindnetd, which does not implement NetworkPolicy at all - that, and not the
    `albSourceCidr` rules, is why `ci/install-test.sh` passes.)
- **ExternalSecret store (prod only):** the `ClusterSecretStore` named `aws-secrets-manager`
  (referenced by `deploy/chart/rch/templates/externalsecret.yaml`) must already exist in the
  cluster - it is provisioned once by the External Secrets Operator install, not by this chart.
  Create the AWS Secrets Manager secret `rch/prod` as one JSON object with **seven** keys -
  `DATABASE_URL` (the `rch_app` URL), `MIGRATE_DATABASE_URL` (the RDS master user's URL),
  `AUDIT_DATABASE_URL` (the `rch_audit` URL), `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`,
  `JWT_PREVIOUS_PUBLIC_KEY` (may be empty until the first key rotation) and **`SEED_PASSWORD`**
  (may not) - and grant the ESO IRSA role read access to it. Then prove the seven keys are there,
  because nothing in `deploy.yml` will (its secret pre-flight step is skipped for `production` -
  §2):

  ```bash
  aws secretsmanager get-secret-value --secret-id rch/prod --query SecretString --output text \
    | jq -e '(.DATABASE_URL|length) > 0 and (.MIGRATE_DATABASE_URL|length) > 0
             and (.AUDIT_DATABASE_URL|length) > 0
             and (.JWT_PRIVATE_KEY|length) > 0 and (.JWT_PUBLIC_KEY|length) > 0
             and has("JWT_PREVIOUS_PUBLIC_KEY")
             and (.SEED_PASSWORD|length) >= 12' >/dev/null && echo "rch/prod: all seven keys present"
  ```

  `jq -e` exits non-zero on a missing or empty key (or a seed password under twelve characters,
  which `config.ts` refuses too), and prints nothing but the verdict - the values never reach the
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
  the first deploy - the ingress template only adds the ALB annotation when it is non-empty.

### Housekeeping

A `CronJob` (`deploy/chart/rch/templates/purge-cronjob.yaml`, `purge.enabled` in `values.yaml`)
runs `dist/cli/purge.mjs` nightly at `15 2 * * *` (02:15). It deletes expired
`idempotency_keys` rows, and `refresh_tokens` rows that can no longer authorise anything -
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

Or revert the merge commit on `production` and push - CI runs, and the deploy that follows it
redeploys the reverted commit the normal way.

### Unsticking production after a failed deploy

Production upgrades without `--atomic` (§2 says why), so **a failed production deploy leaves the
release stuck and the next one refuses to start** with `another operation (install/upgrade/
rollback) is in progress`. Read `helm status rch -n rch` first - the status word tells you which
of the two you have, and they are not the same escape:

| `helm status` says | What happened | What clears it |
|---|---|---|
| `pending-upgrade` | An upgrade over an existing release failed or timed out | `helm rollback rch -n rch` - with no revision it goes back exactly one, to the last revision that actually deployed |
| `pending-install` | The **first** install of the release failed | `helm uninstall rch -n rch`, then re-run the deploy. There is no earlier revision to roll back to, so `helm rollback` has nothing to do; `helm history` shows a single revision |
| `failed` | helm finished and gave up cleanly | `helm rollback rch -n rch`, or fix forward |

Read the evidence before clearing it. The failed job's log already carries it: the
`What the cluster saw` step prints the namespace's pods and events, newest last, and the
`migrate` initContainer's last 200 lines. That is the whole reason production does not run
`--atomic` - clearing the release throws the pods away.

Decide *forward or back* before running either command, because rolling back does not undo a
migration that has already applied (below).

**Migrations are forward-only.** `helm rollback` puts the old application code back in front of
whatever schema is currently applied; it does not undo a migration. If the rollback needs a
schema change (a column the old code doesn't expect, say), write a new forward migration that
makes the schema compatible with the code you are rolling back to - never edit or delete an
already-applied migration file.

**Migration `0005` (`ALTER TYPE ticket_status ADD VALUE 'Cancelled'`, Phase 4) is one you cannot
roll back past once it has been used.** Postgres has no `DROP VALUE` for an enum, so the value
stays in the type forever once added - that part is harmless on its own. What is not harmless:
a pre-Phase-4 (Phase 3) API image validates every response against `TicketsResponseSchema` /
`SnapshotSchema`, whose `TktStatusSchema` is a closed union that does not include `Cancelled`.
The moment any ticket row carries `status = 'Cancelled'`, that old image's `GET /snapshot` and
`GET /tickets` fail response validation for **every** signed-in user, not just the one who
touched the cancelled ticket - a 500, not a graceful degrade. So: rolling back the API past the
Phase 4 image is safe only while no ticket has ever been cancelled on that database. Once one
has, either roll forward instead of back, or first take every `Cancelled` ticket out of the
result set the old code will serialise - there is no in-app path for this, and a `Cancelled`
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
     pods that already read it into env vars). Restart the audit service as well: it verifies
     every token against `JWT_PUBLIC_KEY` / `JWT_PREVIOUS_PUBLIC_KEY`, and a pod still holding
     the old pair turns tokens signed with the new key away, so the Audit log tab stops loading:
     ```bash
     kubectl rollout restart deployment/rch-api -n rch
     kubectl rollout restart deployment/rch-audit -n rch
     ```
   - The box (§16): edit the `JWT_*` lines in `deploy/compose/.env` and run
     `deploy/compose/deploy.sh`. Compose recreates every container whose environment changed,
     `api` and `audit` among them.
4. The API and the audit service accept tokens signed with `JWT_PREVIOUS_PUBLIC_KEY` for 24 hours
   (`apps/api/src/plugins/auth.ts` and `apps/audit/src/plugins/auth.ts` each verify against it
   when the current key fails). After 24 hours, remove
   `JWT_PREVIOUS_PUBLIC_KEY` (blank it out / delete the key from the Secrets Manager JSON) and
   roll out again.

## 5. Accounts

Day to day, accounts are managed by the super admin on `/admin` (§1). The same operations, minus
delete, are also a CLI, run against a live database connection - the way in when nobody can sign in
as the admin. Locally:

```bash
pnpm --filter @rch/api users create --name "New Hire" --email new.hire@royalcare.in --role counter --loc coffee --password <temporary>   # prints the assigned number
pnpm --filter @rch/api users create --emp RC-9001 --name "New Hire" --email new.hire@royalcare.in --role counter --loc coffee --password <temporary>   # or name one
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

Every CLI connects with `MIGRATE_DATABASE_URL` when its environment carries one, and `DATABASE_URL`
otherwise (`cliDatabaseUrl` in `apps/api/src/config.ts`).

**Operator CLIs in a cluster.** The chart's api container carries no `MIGRATE_DATABASE_URL`, so the
`kubectl exec` lines above run as `rch_app`. That is enough for `users`, `payers import` and
`rebuild-balances`, which read and write rows. A CLI that needs the superuser - a seed, or
anything with `--force` - runs in a one-off pod built from the api Deployment's own `migrate`
initContainer, which carries the migrate secret: same image, same environment, nothing secret on a
command line. `deploy/chart/rch/ci/install-test.sh` seeds CI's kind cluster exactly this way.

```bash
NS=rch                                              # or rch-staging / rch-dev
CLI='["dist/cli/seed.mjs", "--yes-seed", "rch"]'    # the CLI and its arguments
pod=$(kubectl -n "$NS" get deploy/rch-api -o json | jq -c --argjson args "$CLI" '{ spec: { containers: [
  .spec.template.spec.initContainers[] | select(.name == "migrate") | .name = "rch-cli" | .args = $args ] } }')
image=$(kubectl -n "$NS" get deploy/rch-api -o jsonpath='{.spec.template.spec.initContainers[?(@.name=="migrate")].image}')
kubectl -n "$NS" run rch-cli --rm -i --quiet --restart=Never --image="$image" --overrides="$pod"
```

On the box (§16), run any CLI through the `migrate` service, which carries both URLs and so connects
as `rch`; `api` connects as `rch_app`:

```bash
cd /opt/rch/app/deploy/compose
docker compose --env-file .env -f compose.yml run --rm --no-deps migrate \
  dist/cli/users.mjs reset-password --emp RC-9001 --password <temporary>
```

`create` accepts `--name --email --role --loc --password` (required) and `--emp --phone`
(optional; without `--emp` the next employee number is assigned); the created account has `must_change_password = true`, so the temporary password
must be changed at first sign-in. That change revokes the employee's other sessions and hands
the browser a fresh one in the same reply (a new access token and refresh cookie), so they
land in the app rather than being bounced back to the sign-in screen. `reset-password` and
`deactivate` both revoke every refresh token for that user (all of that employee's active
sessions are signed out immediately).
`--role` is a desk, one of `counter|manager|store|prod|buyer`, and gives the account that desk's lowest-numbered
active role (on an untouched hospital, its seeded `ROLE-001`…`ROLE-005`); `--role-id ROLE-006` instead names a
role the super admin made at `/admin` (pass one or the other, not both; a switched-off role is refused).
`set-admin --on` takes the account's role away with the flag, and `--off` gives it its desk's first active
role back. `--loc` is no longer a closed list - it is checked
against the `locations` table the same way every write that names a location is (`worksAt` in `@rch/domain`):
the central store or the central kitchen for the roles pinned there, and any *open* outlet for `counter` and
`manager`. A key with no row, or a closed outlet's key, is refused by name. Outlets themselves are opened,
edited, closed and reopened only from `/admin` - never by this CLI and never by the seed beyond the three it
starts with (§1's *Test users*). The migration behind that (`0017_outlets`) only adds columns and indexes and
backfills every existing location's par factor to what was hard-coded before, so it is safe to run against the
live box, which holds real data, and an older image still reads the table afterwards.

### The payer roster

The register itself is a screen now - `/admin`'s **Payers** tab, where the super admin opens,
renames and switches one off - so a single consultant or cost centre is added there and reaches
every till over the change stream. This CLI stays for the case a screen is the wrong tool: a ward
list of a few hundred rows at go-live, or whatever a hospital-side export has produced since.

What each of them is *charged* is neither of those: it is the outlet manager's **Credit &
Settlements** screen, and nothing on this page sets it.

```bash
pnpm --filter @rch/api payers import --csv ./wards.csv
pnpm --filter @rch/api payers import --csv ./wards.csv --replace-names
```

The file is three columns, `kind,id,name`, one payer a line. A header row naming those columns is
optional; blank lines and lines starting `#` are skipped; a field may be quoted so a name can
carry a comma; a leading byte-order mark is stripped, so a file Excel saved as "CSV UTF-8" is
read as-is. `kind` is one of `staff|dept|doctor`. The `id` is the hospital's own number -
there is no sequence behind a payer - and `(kind, id)` is what makes a row unique.

Three behaviours to know before running it against a live database:

- **One bad row aborts the whole file.** Every error is printed with its own line number and the
  column that caused it, and *nothing* is written. A half-loaded ward list is one nobody can
  reconcile against the list it came from, so the file is fixed and re-run rather than patched up
  afterwards. It is one transaction, with no statement timeout, like every other CLI here.
- **An id already on the roster is skipped, not overwritten** - the run says how many, and says
  to re-run with `--replace-names` if updating them is what was meant. Only that flag ever
  touches an existing name.
- **A rename never reopens a closed account.** `--replace-names` on a deactivated payer updates
  the name and leaves the switch alone; the summary counts those apart (`renamed 3 (1 still
  inactive)`) so "renamed 3" cannot be read as three people back on the till's picker. The
  admin's own Payers tab is the one door that switches one back on.

The import does not announce over SSE, so an open browser will not see the new rows until it is
reloaded - the same as `users` and `db:seed`, and fine for a job that runs before anybody is
signed in.

### The database roles

Three Postgres roles, and no long-running service connects as the superuser:

| Role | Used by | What it can do |
|---|---|---|
| `rch` | Both migrate steps (`migrate`, `audit-migrate`) and every operator CLI, through `MIGRATE_DATABASE_URL` | Everything; it owns every table. The container Postgres's superuser on the box, the master user on RDS. |
| `rch_app` | The API, through `DATABASE_URL` | `select, insert, update, delete` on every API table and `usage, select` on their sequences; `select` on `drizzle.__drizzle_migrations`, for `/readyz`; **`insert` only** on `audit_outbox`. No `truncate`, and nothing in the `audit` or `audit_drizzle` schemas. |
| `rch_audit` | The audit service, through `AUDIT_DATABASE_URL` | `select, delete` and the column `update (at)` on `public.audit_outbox` (the column grant only lets the drainer lock rows: a trigger refuses every UPDATE on the outbox); `select, insert` on `audit.events` and `audit.dead_letters`; `select` on the `audit_drizzle` bookkeeping. No other API table. |

- **The migrate steps create the roles.** `migrate` reads the role name and password out of
  `DATABASE_URL`, `audit-migrate` out of `AUDIT_DATABASE_URL`. Each creates its role if it is
  missing, sets the password (escaped, never logged), and re-grants on every run. Nobody creates a
  role or a grant by hand.
- **Append-only holds for every role, `rch` included.** Triggers refuse UPDATE and DELETE on
  `stock_moves` and `document_history`, UPDATE on `audit_outbox`, and UPDATE, DELETE and TRUNCATE on
  `audit.events` and `audit.dead_letters`.
- **No credential a service holds can alter the audit log.** The API's can add to the outbox and
  read nothing back; the audit service's can add to the log and never change it.
- **Locally and in the test suites there is one user.** `DATABASE_URL`, `AUDIT_DATABASE_URL` and the
  unset `MIGRATE_DATABASE_URL` all name `rch`, so both migrate steps skip role setup (§1).

**Rotating a role's password, on the box.** Change `APP_DB_PASSWORD` or `AUDIT_DB_PASSWORD` in
`deploy/compose/.env` and run `deploy/compose/deploy.sh`. Compose sees the changed URL, reruns
`migrate` (or `audit-migrate`), which applies `alter role … password` with the new value, and only
then recreates `api` (or `audit`) on it. `.env` is gitignored, so `release.sh`'s clean-checkout
check never sees the edit. **In a cluster**, change the password inside `DATABASE_URL` or
`AUDIT_DATABASE_URL` in the Secret (§2) and roll out: each new pod's initContainer applies it. Pods
of the old ReplicaSet still hold the old password, so a new connection one of them opens fails
until the rollout replaces it - rotate off-hours.

`POSTGRES_PASSWORD`, `rch`'s own on the box, is different: the `postgres` image reads it only when
the `pgdata` volume is first created. Change it inside the database first
(`docker compose … exec postgres psql -U rch -d rch -c "alter role rch password '<new>'"`), then in
`.env`, then run `deploy.sh`.

## 6. Restore drill

Rehearse this against the local database first - the procedure below needs a scratch RDS
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

`pg_dump`/`pg_restore` stand in for "restore the latest snapshot" - a local database has no
automated-snapshot mechanism to restore from, so a logical dump is the nearest equivalent that
proves the same thing: `db:rebuild-balances` run against a restored copy reproduces the
original's balances exactly. This is the rehearsal; the real thing is against RDS, below, and is
run before go-live and quarterly.

**Roles are not in a dump.** `pg_dump` carries the `audit` and `audit_drizzle` schemas and every
grant, but not the `rch_app` and `rch_audit` roles those grants name: roles belong to the Postgres
server, not to one database. Loading a dump into a server that has never had them prints
`role "rch_app" does not exist` for each grant and carries on. So after loading a dump as `rch`,
run both migrate steps before starting the services; they create the two roles and re-grant
everything:

```bash
cd /opt/rch/app/deploy/compose
docker compose --env-file .env -f compose.yml run --rm migrate
docker compose --env-file .env -f compose.yml run --rm audit-migrate
```

Running them over roles that already exist is harmless: each step sets the password from `.env`
again and re-grants. The local rehearsal above needs neither, because locally every URL names
`rch`. An RDS snapshot restores the whole instance, roles included, so the RDS drill below needs
neither either.

The RDS drill:

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
   records - an empty diff, and a successful `rebuild-balances` run, is the pass condition.

**Rehearsed: 2026-09-04, PASS.** The local block above was run end to end against the dev
database on `localhost:5439`, carrying that day's exit-walk documents rather than a bare seed -
`pg_dump -Fc` 101 KB in 0.33 s, `createdb rch_restore`, `pg_restore` in 1.03 s,
`db:rebuild-balances` against the restored copy reporting `stock_balances rebuilt: 54 rows`, and
an **empty diff** over all 54 balance rows against the source. Whole drill: 2.9 s; the scratch
database was dropped afterwards. This is the rehearsal, not the drill: it proves the procedure is
right and that `rebuild-balances` reproduces a restored copy's balances exactly. The RDS half
(steps 1–4 above) has never been run, because there is no RDS yet - it is §11 step 6, before
go-live.

## 7. Rebuild balances

`stock_balances` is a cache derived from the append-only `stock_moves` ledger. "Append-only" is
enforced in the database, not just by convention: migration `0002` installs a trigger that
refuses any `UPDATE` or `DELETE` on `stock_moves` (`TRUNCATE` is still allowed - the test
harness and `db:seed --force` use it to reset between runs). **`document_history` is protected the
same way from migration `0008`** - `document_history_no_update_delete`, raising `document_history
is append-only; append a correcting entry` - so the trail behind a document is as uneditable as
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
sentences into a 500 with no words in it. The negative never survives - the same transaction rolls
it back - and that is the guarantee, not the constraint.

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
`ACCESS SHARE`, so a plain read of `stock_balances` is not blocked, but every writer -
`postMoves()`, and so every sale, handover, receipt or any other move-writing endpoint - blocks
until the rebuild commits. Prefer a quiet period (off-hours) for a production run regardless:
it is a straight `SELECT ... GROUP BY` over `stock_moves` and fast for this dataset's size, but
in-flight writes will queue for however long it takes.

A rebuild zeroes the rows it finds and adds the moves back on top; it never deletes one. A
balance row's presence is itself a fact - it means the location carries that line - so a row
with no moves behind it stays, at zero, and reads as stocked-but-empty afterwards exactly as it
did before. Only the numbers are recomputed, never the shelf list.

The same rule holds outside a rebuild. `lockBalances` (`apps/api/src/lib/ledger.ts`) inserts a
zero `on_hand` row before locking any cell it is about to touch, so a request, ticket or sale
against an item a location has never carried creates the row rather than failing to find one -
but every Phase 3 write locks *only* the cells it actually moves or reserves, never a whole
location's worth speculatively, and a refusal rolls that insert back with everything else. A
stray "carried at zero" cell that nobody ever asked for would be indistinguishable from a real
one on every stock screen (M12), so this is an invariant any new write must keep, not an
implementation detail: lock the cells you touch, nothing wider.

Tracing a `grn_accept` move back to its paperwork (`select * from stock_moves where ref_type =
'grn' and ref_id = '<id>'`) means reading the id in the shape it was actually written in -
`GRN-<yy><po number>-<nn>` since Phase 6, `GRN-<last 3 of the PO>-<nn>` for anything booked in
before it (§8, below, has the full story and the reason for the change).

## 8. Read a document's history

Every status change on a request, requisition, purchase order or production order is a row in
`document_history`, keyed by `(doc_type, doc_id)`:

```sql
select * from document_history where doc_type = 'request' and doc_id = 'REQ-2026-0913' order by at;
```

`doc_type` is one of `request`, `requisition`, `purchase_order`, `prod_order`, `ticket`, and -
since the audit wave - `item`, `adjustment` and `bill`: **eight** types, written by the modules
that own each document; `grep -rn "appendHistory(" apps/api/src` is the authoritative list.

The three newest are each worth one line, because none of them is on the wire - no screen reads
them back, so this query is the only way to see them. `item` carries `Updated`, `Retired` or
`Restored` against an item key, and the last two are written **only when the flag actually
crossed**: a patch that sets a live line live again reads `Updated`, because a trail saying
something happened that did not is worse than no trail. `adjustment` carries the write-off's own
reason as its word (`Wastage`, `Breakage`, `Expired`, `Stock count`, `Returned to vendor`,
`Other`), one row per adjustment, and the document itself is never edited afterwards - a mistake
in one is corrected by raising another. `bill` carries exactly one row, ever, and only for a bill
somebody voided: `Voided - <reason>`, signed by the manager who did it. So:

```sql
select * from document_history where doc_type = 'bill' order by at desc;      -- every void, ever
select * from document_history where doc_type = 'item' and doc_id = 'milk';   -- who changed what
``` A production order's own board walk reads the same way, one row per
press including the dispatch:

```sql
select * from document_history where doc_type = 'prod_order' and doc_id = 'PRD-2026-029' order by at;
```

The board's statuses (`PordStatus`, `packages/contract/src/schemas/common.ts`) are `New`,
`Accepted`, `In kitchen`, `Ready`, `Dispatched`, `Declined` - `POST /prod-orders/:id/status`
walks the first four in order (a skipped stage is refused, naming the one it is actually on),
`Dispatched` only ever comes from its own endpoint (`POST /prod-orders/:id/dispatch`), and the
one way back to `Ready` from `Dispatched` is a ticket cancellation, never a press on the board.

Kitchen make refusals leave no history row and no batch row - a `POST /batches` that comes back
"Kitchen is short of …" wrote nothing, and the batch number it drew is rolled back with it, so
the series skips a number the same way a cancelled sale skips a bill number.

**As of Phase 6, a ticket writes a row for its whole trail, not just the override and the
cancellation** - `Issued` (written by `writeTicket`, `lib/tickets.ts`, the one place any ticket
is created), `Handed over` or `Handed over - supervisor override`, `Received`, and
`Cancelled - <reason>`. The three timestamps on the row itself (`issued_at`, nullable
`collected_at`, nullable `received_at`, `apps/api/src/db/schema/movement.ts`) still exist and
still agree with the trail; the trail is what has a sentence for each step, not only the two
that used to get one:

```sql
select id, status, issued_at, collected_at, received_at from tickets where id = 'TKT-0441';
select * from document_history where doc_type = 'ticket' and doc_id = 'TKT-0441' order by at;
-- a collected ticket reads: Issued, Handed over, Received
-- an overridden one: Issued, Handed over - supervisor override
-- a withdrawn one: Issued, Cancelled - <reason>
```

**Unlike every other document, this trail is on the wire and on screen** - `TicketSchema.hist`
(`packages/contract`) carries it on `GET /snapshot`, `GET /tickets` and every ticket write's own
response, and the store's and counter's ticket drawers render it as a `History` section, the
same way a request's own drawer already rendered its trail. `GET /documents/:type/:id/history` -
a generic endpoint for every document type - is still **not** built; a field on the one
document that needed its history readable back is smaller and complete, and the query above is
still the only way to read a request's, a requisition's, a purchase order's or a production
order's own history, none of which gained a screen this phase.

**No backfill.** A ticket that existed before this phase shipped has no `Issued` row - its trail
starts from whichever Phase 6 write next touched it (a handover, a receipt, a cancellation), and
reads short for the part of its life that predates the trail existing at all. This is expected,
not a data-quality bug to chase.

**The OTP is on the wire only while a ticket is `Issued`, and only for a caller standing at that
ticket's own `to` location** - the desk that issued the ticket reads `""` back, in its own
write's response and in every later read, and so does anyone standing anywhere else. `handover`
never reads the wire value anyway: it compares what the collector says against the row it locks
for itself. The labelled supervisor override (store keeper or kitchen in-charge, OTP field left
blank) is the one door past a collector who genuinely is not there, and it is what the trail
records instead of a code nobody typed.

**The counter's cancel door.** `POST /tickets/:id/cancel` now also admits `counter`, scoped to
the ticket's own `from` - an outlet that raised a shop-to-shop transfer can withdraw it before
anyone collects, the same door the store keeper and the kitchen already had. Withdrawing a
ticket that was answering a shop's ask also puts that ask back to `Asked` on the other shop's
own desk, so nothing is left half-granted.

What a ticket actually moved is the ledger, two lines per handover - a `ticket_out` set posted
at the source when it is handed over, a `ticket_in` set posted at the destination when it is
received:

```sql
select * from stock_moves where ref_type = 'ticket' and ref_id = 'TKT-0441' order by id;
```

A cancelled ticket moves nothing, because nothing had moved - there is no ledger query for a
cancellation; `reservations.released_at` on its holds is the only trace (below).

A bill (Phase 2, `POST /bills`) writes no `document_history` either - it is a single
create-and-settle document, not something that moves through statuses - so read what it did
from the ledger instead, keyed by `ref_type = 'bill'` and `ref_id = <bill number>`:

```sql
select * from stock_moves where ref_type = 'bill' and ref_id = 'CF/1188';
```

A batch (Phase 4, `POST /batches`) writes no `document_history` either - it is created once,
never transitions - so read it from the ledger too, keyed by `ref_type = 'batch'`:

```sql
select * from stock_moves where ref_type = 'batch' and ref_id = 'BAT-20260904-01' order by id;
```

A batch posts one row, the `production_yield` for what was *made*. It draws no raw materials
down; a batch written before recipes were removed may also carry negative `production_consume`
rows, one per ingredient. A batch that yielded nothing (a tray dropped, `made = 0`) posts no row
at all, so there is no move for it and no "carried at zero" row on the finished item either (M12). The
batch's own row (`select * from batches where id = 'BAT-20260904-01'`) is what records a lost
tray - `started_qty` and `made_qty` disagree, and `note` usually says why.

`BAT-<yyyymmdd>-<nn>` takes its date from the make and its `<nn>` from the one `sequences` row
kept for the `"batch"` kind (`SEQUENCE_START.batch`), which never resets - the number is unique
and increasing, not a count of the day's batches, and widens past two digits rather than
wrapping. Do not "fix" a batch id by hand; a gap in the series (a refused make, above) is
correct, the same as a gap in the bill or ticket series.

**A goods receipt is numbered from the order it books in against:
`GRN-<yy><po number>-<nn>`, so the second instalment against `PO-2026-0143` is
`GRN-260143-02`.** It was `GRN-<last three of the PO>-<nn>` until Phase 6, which collided -
`PO-2026-0143` and `PO-2027-0143` share a three-character tail, and so do `PO-2026-0143` and
`PO-2026-1143`. Because `grns.id` is a primary key, the collision surfaced as a failed insert in
the middle of a receipt rather than as a duplicate number a screen could quietly show twice.
**GRNs written before that change keep their old ids** - nothing was renumbered, and a receipt
whose id has a three-character tail is simply an older one, not a corruption to fix.
`packages/domain/src/ids.ts`'s `grnId(poId, n)` is the only place the format lives; see §14,
below, for tracing a `grn_accept` move back to its own paperwork by that id.

**Support tickets keep no `document_history` row at all.** Their history *is* their
conversation: `support_messages` (`SUP-0044/m1`, `.../m2`, …) already holds who said what and
when, and `support_tickets.status` sits beside it as an ordinary column. `GET /support/tickets`
answers a caller's own tickets only, by `by_user` in the JWT, and someone else's ticket answers
`404`, not `403`: it is not that you may not act on it, it is that it is not yours to know about.
The admin-flagged account answers every ticket from `/admin` (`GET /admin/support/tickets` and its
`:id/messages` and `:id/status` doors). A desk reply is a `support_messages` row with
`from = 'support'` and `who` = the admin's name, so the conversation still says who answered; a
status the desk sets without a reply is not attributed to anyone.

Connect with `psql` (or any Postgres client) against the target `DATABASE_URL` - locally
that's `postgres://rch:rch@localhost:5439/rch`.

### Finding a stuck hold

A request's approval, an issued ticket, a shop-transfer or a granted shop-ask all reserve
stock in `reservations` (Phase 3) rather than moving it; the hold is released only when the
matching ticket is handed over (`releaseForTicket` in `apps/api/src/lib/reservations.ts`). A
row still open - `released_at is null` - after its ticket should long since have moved is a
hold worth investigating, most often an issued ticket nobody ever collected:

```sql
select r.*, t.status, t.issued_at
from reservations r join tickets t on t.id = r.ticket_id
where r.released_at is null
order by r.id;
```

There is no expiry job on a reservation today - an uncollected ticket holds its stock until
somebody hands it over (with the OTP, or the supervisor override) or the ticket is cancelled -
or, for a `Collected` ticket only, the manual procedure below; a location screen reading
`freeToPromise` this low is the first place the shortage shows. It matters more from Phase 4 on
than it did in Phase 3: free-to-promise is what `POST /batches` refuses a make against, so a
stranded hold at the kitchen does not just under-report an outlet's shelf - it stops the
kitchen baking.

### Cancelling a ticket

As of Phase 4 this is an endpoint, not a manual procedure: `POST /tickets/:id/cancel {reason}`
(store keeper, kitchen in-charge, or - since Phase 6 - the counter, each scoped to the ticket's
own `from` location) releases every open hold the ticket placed, sets it to `Cancelled`, and
puts the document behind it - a request back to its approved status, a dispatched production
order back to `Ready`, a shop-ask back to `Asked` - where it stood before the ticket was raised.
Use it for any ticket still `Issued`:

```bash
curl -sS -X POST "$API/tickets/TKT-0441/cancel" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H "Idempotency-Key: $(python3 -c 'import uuid;print(uuid.uuid4())')" \
  -d '{"reason":"Wrong item, request cancelled by phone"}'
```

**"The collector has typed the code five times and now it will not take the right one."** That is
working as intended, not a fault. A wrong OTP is counted on the ticket (`tickets.otp_attempts`,
migration `0008`) and the sixth attempt is refused whatever is typed - the digits are what has
been guessed at, so the correct one is refused too:

```sql
select id, status, otp_attempts from tickets where id = 'TKT-0441';
```

The refusal names both ways out, because the one a caller has depends on their role: the store
keeper or the kitchen in-charge can hand it over with the **labelled supervisor override** (the
OTP field left blank - recorded on the ticket's trail), and anyone who may cancel the ticket can
**withdraw it and issue a new one**, which mints new digits. A counter operator has only the
second. The count is never reset - not by a correct code, not by a cancellation - so a ticket
that took four wrong codes carries them for its whole life; if that is the situation, reissue
rather than spending the last attempt.

**A request that should never have been approved** has its own door now, and it is not this one.
An approved request the store has not yet ticketed can be withdrawn - by the counter or kitchen
that raised it, or by the manager who approved it - with `POST /requests/:id/cancel`, no different
from withdrawing one the manager had not yet seen. Nothing is reserved until a ticket is issued,
so nothing moves and nothing is released; the trail reads `Cancelled - never issued`. Once a
ticket exists the request itself is closed to it (`… already has ticket TKT-0441 - cancel the
ticket instead`) and the ticket is what you withdraw, above.

The manual SQL from Phases 1–3 still has exactly one live use: a ticket already `Collected`
(stock in transit, both ends' figures already moved) has no cancel button and no endpoint -
cancelling a movement that has already happened is a correction, not a withdrawal - so freeing
a hold stuck behind one is still by hand:

```sql
update reservations set released_at = now()
where ticket_id = 'TKT-0441' and released_at is null;
```

That frees the stock only; it does not touch the ticket's own status or the document behind
it, so tell the store keeper or the kitchen out loud what was done and why, the same as before
Phase 4.

## 9. Alerts

The original requirement named five; this build ships ten - the **eight** below that the chart's
`PrometheusRule` renders, plus the two RDS rules that stay runbook-only. The API's `/metrics`
(Prometheus format, `apps/api/src/plugins/metrics.ts`) exposes `http_request_duration_seconds`
(histogram, labelled `method`, `route`, `status`), `pg_pool_waiting`/`pg_pool_idle`,
`sse_listener_up` and the default Node process metrics. The audit service's `/metrics`
(`apps/audit/src/plugins/metrics.ts`, port 3100) exposes `audit_outbox_depth`,
`audit_drain_lag_seconds` (the age of the oldest outbox row), `audit_events_stored_total`,
`audit_dead_letters_total` and `audit_listener_up`. The first eight below ship as a `PrometheusRule`
(`deploy/chart/rch/templates/prometheusrule.yaml`). **The two RDS rules stay runbook-only**,
below, because they need the CloudWatch metrics exporter (or Grafana's native CloudWatch
datasource) pointed at the RDS instance, which is not part of this chart and is wired at the
observability-stack level. A Grafana dashboard JSON does **not** ship with the chart either - a
dashboard in a ConfigMap is an unversioned blob nothing renders in CI and nothing fails when it
drifts, so build one from `/metrics` in Grafana directly rather than looking for one here.

**Three things have to be true before any of the eight fires**, and none of them is the chart's to
guarantee (§2, *First-time cluster setup*, has the setup):

1. `serviceMonitor.enabled` - on in `values-prod.yaml`, off elsewhere.
2. **The cluster actually serves `monitoring.coreos.com/v1`.** Both templates are gated on
   `.Capabilities.APIVersions.Has`, because nothing in this repo installs the Prometheus
   Operator and a `helm upgrade --atomic` that meets an unknown kind fails and rolls the whole
   release back. On a cluster without the operator the two files simply do not render - no
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
`values.yaml` and `values-prod.yaml` - it is no longer a `# FILL`.

**Still open: nothing routes these anywhere.** Alertmanager has no receiver configured for this
cluster, so a rule that fires today fires into Prometheus's own UI and pages nobody. Who is
paged, and by what, is a §11 go-live decision, not a chart value.

1. **`RchApiHigh5xxRate` - 5xx rate > 1% over 5 minutes, critical**
   ```promql
   sum(rate(http_request_duration_seconds_count{job="rch-api",status=~"5.."}[5m]))
     / sum(rate(http_request_duration_seconds_count{job="rch-api"}[5m])) > 0.01
   ```
2. **`RchApiHighLatencyP95` - p95 latency > 1s over 10 minutes, warning**
   ```promql
   histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{job="rch-api"}[5m])) by (le)) > 1
   ```
3. **`RchApiDown` - readiness failing, critical.** The `up` gauge Prometheus sets per scrape
   target. Prometheus Operator's `ServiceMonitor` discovers targets from the Service's
   `Endpoints`, which only lists pods the readiness probe (`GET /readyz`) currently passes, so a
   pod stuck failing `/readyz` drops out of scrape targets entirely; a whole-deployment outage
   shows as the target(s) reporting `up == 0`:
   ```promql
   up{job="rch-api"} == 0
   ```
   sustained for 2 minutes.
4. **`RchApiPoolSaturated` - the app's own Postgres pool has queuers and nothing idle, warning,
   sustained 5 minutes:**
   ```promql
   max(pg_pool_waiting{job="rch-api"}) > 0 and max(pg_pool_idle{job="rch-api"}) == 0
   ```
   This is the pool the app itself opens (`max: 10` per pod, `apps/api/src/db/client.ts`), not
   RDS's own connection count - see item 9 below for that. The app pool never exceeds 60
   connections at max scale-out (10 per pod × 6 max pods) - plus one dedicated
   `LISTEN` connection per pod for the SSE plugin (§10), so 66. Still well under any RDS
   instance's limit; this alert catches the pool running out locally, long before RDS itself is
   under any real pressure.
5. **`RchApiCrashLooping` - more than one restart in fifteen minutes, critical, sustained 5
   minutes:**
   ```promql
   increase(kube_pod_container_status_restarts_total{namespace="rch",container="api"}[15m]) > 1
   ```
   The one rule here that does **not** read a metric this API publishes, and it cannot: a pod
   that is restarting is a pod that is not scraping, so every other alert in this list goes quiet
   exactly when this failure is happening. `kube_pod_container_status_restarts_total` comes from
   kube-state-metrics, which ships with the same kube-prometheus-stack whose CRDs gate the whole
   file - if the rule is loaded, the metric is there. The threshold is *more than one* restart
   because a single restart is what an ordinary node eviction leaves behind; two in a quarter of
   an hour is a pod that came up, failed and came up again - a bad migration, a missing secret,
   an OOM kill. **`kubectl logs --previous` on the pod says why, before the next restart wipes
   it.** The `namespace` label is the release's own namespace, so the rendered rule in
   `rch-staging` watches `rch-staging`.
6. **`RchSseListenerDown` - warning, sustained 5 minutes:**
   ```promql
   min(sse_listener_up{job="rch-api"}) == 0
   ```
   Its rationale - what `sse_listener_up` means, why 5 minutes and not immediately, and why it
   is deliberately *not* wired into `/readyz` - is §10's, below, not repeated here.
7. **`AuditDrainLagging` - the oldest audit event has waited in the outbox over a minute,
   warning, sustained 5 minutes:**
   ```promql
   max(audit_drain_lag_seconds{job="rch-audit"}) > 60
   ```
   Nothing is lost while it fires. The API keeps committing writes, each one's event waits in
   `audit_outbox` until a drain pass moves it, and the Audit log tab simply shows nothing newer.
   What to do, in order:
   - **Are the audit pods running and ready?** `kubectl -n <namespace> get pods -l
     app.kubernetes.io/component=audit`, then `kubectl logs` on one, and `kubectl logs <pod> -c
     audit-migrate` if it never started. On the box: `docker compose … ps audit` and
     `docker compose … logs --tail 100 audit-migrate audit`.
   - **Is a pass failing?** The service logs each failure at `error`. A connection or permission
     refusal for `rch_audit` means the role is missing or has lost its grants - after a restore,
     typically - and running `audit-migrate` recreates and re-grants it (§6).
   - **Is it draining, only slower than the outbox fills?** `audit_outbox_depth` and
     `audit_events_stored_total` both climbing says so. More replicas help: `skip locked` lets them
     drain side by side.
   `audit_listener_up == 0` alone does not cause this alert: the drainer still polls every
   `DRAIN_POLL_MS` (5 s). §16.7 has the outbox query for the box.
8. **`AuditDeadLetters` - an event the audit service set aside, critical:**
   ```promql
   sum(increase(audit_dead_letters_total{job="rch-audit"}[15m])) > 0
   ```
   The event failed `AuditEventSchema`, or Postgres refused it (`database refused it: <reason>`),
   and it was stored in `audit.dead_letters` instead of `audit.events`, with the first issue found;
   the events either side of it moved normally. It is missing from the Audit log tab, so any at all
   is somebody's to read. Read
   it (§16.7 has the connection):
   ```sql
   select id, outbox_id, at, issue from audit.dead_letters order by id desc limit 20;
   select event from audit.dead_letters where id = <id>;
   ```
   The likeliest cause is an API image and an audit image built from different commits, one of
   which changed the event's shape (a new collection in `changed`, say). Deploy both from the same
   commit. Nothing replays a dead letter: the row, with the whole event in `event`, stays where it
   is, append-only like the log itself, so the Audit log has a gap there that `dead_letters`
   explains.
9. **DB connections > 80% of max - runbook-only, needs CloudWatch.** RDS CloudWatch
   `DatabaseConnections`, exposed as a gauge by the CloudWatch exporter (metric name depends on
   the exporter's naming, e.g. `aws_rds_database_connections_average`):
   ```promql
   aws_rds_database_connections_average{dbinstance_identifier="rch-prod"} > 0.8 * <max_connections>
   ```
   `<max_connections>` is fixed for the instance class (`SHOW max_connections;`) - compute it
   once and hardcode the threshold in the alert rule. This is a safety net for connections opened
   outside the app (a psql session left open, a burst of migrate initContainers opening a
   connection each during a large rollout) - the app's own pool is item 4, above.
10. **RDS free storage < 20% - runbook-only, needs CloudWatch.**
    ```promql
    aws_rds_free_storage_space_average{dbinstance_identifier="rch-prod"}
      / <allocated_storage_bytes> < 0.2
    ```

**The migrate initContainer dies with `SELF_SIGNED_CERT_IN_CHAIN` although the image ships the
RDS bundle.** The `DATABASE_URL` carried `?sslmode=require`: the driver then builds its own TLS
setting from the string and ignores the bundle the code hands it, so the chain was checked
against the system store. `DATABASE_SSL=true` alone decides TLS - keep the URL free of `sslmode`
(`createDb` now strips it, but a URL that says nothing is clearer). The bundle itself verified the
`rds-ca-rsa2048-g1` chain fine from inside the cluster.

**The site stops resolving after a failed or re-done install.** The ingress owns the ALB, and
`helm --atomic` rolling a first install back deletes the ingress and the ALB with it; the next
install creates a new ALB with a new DNS name, and the Route 53 alias still points at the old one
(Route 53 answers NOERROR with no address). Re-point it: `kubectl -n rch-dev get ingress rch -o
jsonpath='{.status.loadBalancer.ingress[0].hostname}'`, then the UPSERT alias with that name and
the ALB's canonical hosted zone id (`aws elbv2 describe-load-balancers`). The durable fix is
external-dns (IRSA + the `external-dns` chart watching the ingress host) - not installed yet.

**Every `/api` request from the browser answers 502, the API pod logs only probes** - *wherever
nginx is the proxy*, which means CI's kind cluster (`ingress.enabled: false`) and Docker
Compose, not a deployed environment: with the ingress on, the ALB routes `/api` to the api
Service directly and the UI pod serves only the static bundle (§10). The UI's
nginx proxies `/api` to `API_UPSTREAM`, and nginx's `resolver` directive ignores `/etc/resolv.conf`'s
search domains, so the value must be the API Service's full cluster name -
`http://<release>-api.<namespace>.svc.cluster.local:3000`, which the chart sets. A short name
(`http://rch-api:3000`, the image's Compose-only default) resolves under Docker's embedded DNS and
never inside a pod. `kubectl exec deploy/<release>-ui -- printenv API_UPSTREAM` shows what it got.
The same holds for `AUDIT_UPSTREAM`, which nginx's `location /api/v1/admin/audit` proxies to: the
chart sets `http://<release>-audit.<namespace>.svc.cluster.local:3100`, and the image's short
default (`http://rch-audit:3100`) never resolves inside a pod.

## 10. Server-sent events (SSE)

`GET /events` (Phase 3) is how a browser hears about writes made elsewhere - an approval
raised in one window shows up in another's list without a reload. It is one HTTP request that
never ends: the browser opens it once per signed-in session (`UI/src/api/events.ts`, a
`fetch`-based reader rather than `EventSource`, because `EventSource` cannot send an
`Authorization` header) and the pod holds the response open, writing a frame every time
something changes plus a `: ping` comment every `SSE_HEARTBEAT_MS` (25 s) to keep proxies from
reaping an idle connection.

**Reading the two gauges** (`/metrics`, `apps/api/src/plugins/metrics.ts`):

- `sse_clients` - open streams on this pod. Expect it to sit near the number of browsers
  currently pointed at this pod, not near zero; zero on every pod with users signed in means
  the streams are not opening at all (check the ALB/nginx path below before the app).
- `sse_listener_up` - 1 while this pod holds its one `LISTEN` connection to Postgres, 0
  otherwise. **`sse_listener_up == 0` does not mean the pod is serving stale data** - every
  open stream is still alive, still authenticated, still holding its socket - it means that
  pod's streams have gone deaf: a write elsewhere will not reach *this* pod's browsers until
  the listener reconnects. `apps/api/src/plugins/sse.ts` retries the connection itself with
  backoff (250 ms → 500 ms → 1 s → 2 s → 5 s → 10 s) and sends every open stream an
  `event: resync` frame the moment it reconnects, so a browser that missed notices catches up
  with one `loadSnapshot()` rather than trusting a replay it can't have (there is no replay
  buffer - it would not survive a pod being rescheduled). Alert on
  `min(sse_listener_up) == 0 for 5m` - a single pod recovering itself in under five minutes
  needs nobody paged; five minutes deaf on any one pod does.

`sse_listener_up` is deliberately **not** wired into `/readyz` (`apps/api/src/plugins/
health.ts` only ever gates readiness on the database check Task 5 registered). A pod whose
listener is down is still correctly answering every request - sign-in, billing, the whole
request chain - with only its live-update fan-out degraded; taking it out of service over that
would mean a transient Postgres blip on the LISTEN connection pulls every pod out of the
Service's endpoints at once (they all lost the same connection at the same moment), which is a
full outage traded for a live-update delay. The 5-minute alert above is the right response to
this failure, not a readiness probe.

**`audit` notices reach admin streams only.** After a drain pass that stored anything, the audit
service's drainer sends a notice naming the `audit` collection on `rch_events_<schema>`, the
channel the API's own writes use, and every API pod's listener picks it up like any other.
`apps/api/src/plugins/sse.ts` records, per stream, whether its token is an admin's, and writes an
`audit` frame only to those streams; every other collection still goes to every stream. An admin's
browser does not refetch on it: it counts the notice, and the Audit log tab shows "New events -
show" until the admin presses it. A lost `audit` notice costs only the pill - the rows are there on
the next load. The audit service holds a `LISTEN` connection of its own, on `rch_audit_outbox`, to
hear the API's inserts; `audit_listener_up` is its gauge (§9).

**First, which hops are actually on the path.** In a cluster, **nginx is not on the `/api`
path at all.** `templates/ingress.yaml` gives the ALB two rules - `/api` → the `<release>-api`
Service on 3000, `/` → the `<release>-ui` Service on 8080 - so a browser's stream goes
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
  that many seconds - live updates would appear to work in testing (well under the timeout) and
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
  the other four - `apps/api/src/server.ts`'s comment carries the arithmetic beside the code.
- **The ALB health check is `/readyz`, every 15 s** (`healthcheck-path` /
  `healthcheck-interval-seconds`), not `/healthz` - `/healthz` answers 200 for as long as the
  process exists, draining included, so a pod that had already stopped accepting still looked
  healthy to the load balancer. `healthcheck-path` is an **Ingress-level** annotation, so the
  controller applies it to *every* target group the ingress creates - the ui's as well as the
  api's. That is why `deploy/nginx/default.conf.template` serves **both** `location = /healthz`
  and `location = /readyz`: with only `/healthz`, the ui's check fell through to the SPA
  catch-all and passed on `index.html`, a 200 that says nothing about nginx. nginx has no
  draining state of its own, so both return the same `ok`. If you ever move the health-check
  path, move it in the nginx template too.
- A rolling deploy ends every open stream - the pod serving it goes away - with a
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
ordinary route does - `curl -D - -H "Origin: http://example.com" .../events` comes back with no
`vary: Origin`, no `access-control-allow-credentials`, nothing, where the same request against
`.../stock` gets both. Every deployed topology today is same-origin (nginx proxies `/api`), so
nothing breaks - but a split-origin deployment would need CORS wired onto this route
specifically before anything else works cross-origin. Still open at the end of Phase 6, unchanged
from Phase 5's note; nothing in this phase touched the route.

**`MAX_STREAMS_PER_USER` is 8** (`apps/api/src/plugins/sse.ts`) - a signed-in employee opening a
ninth simultaneous stream is refused with `You already have 8 screens listening for updates.
Close one and try again.` (a `429`). If a real shift ever hits this limit it reads as several tabs left
open on one login, not a server problem; ask the operator to close some.

## 11. Go-live checklist

Environment resources are `deploy/cfn/rch-env.yaml`; the cluster is `deploy/eksctl/cluster.yaml`.

**Scope.** This checklist promotes `staging` and `production`, neither of which has an AWS
resource behind it yet. `dev` is already live - `develop` deploys to `rch-dev` on the same
cluster at `https://rch.hashtrickstechnologies.com`, and its resources are already the same
`deploy/cfn/rch-env.yaml` stack (`rch-dev`) that `staging`/`prod` will import from. §15 records
how `dev` was stood up and what tripped on the way; read it before repeating any of this for
staging or production, since two of the four lessons there (the CAA one and the OIDC one) will
recur verbatim for a new host name and are cheaper to avoid than to rediscover.

### The release, prepared and not performed (2026-09-04)

Phase 6 ends here. Everything the first production deploy needs is written down; **nothing in
this build pushes `staging` or `production`** - promotion is a release decision and the branch
pushes below are the account owner's to run, not any agent's. The only `git push` anywhere in
`.github/workflows/**` is the `Tag production` step in `deploy.yml`, which tags a *release* after
a deploy has already happened; no workflow, script or task in this repository pushes either
branch.

**Where the branch stands.** `feat/phase-6-ops-go-live` is **36 commits** ahead of `develop`, and
`origin/staging` is an ancestor of `origin/develop` - so every promotion below is a genuine
fast-forward, as the branch model requires. Confirm both before starting:

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
| `ingress.certificateArn` | The ACM certificate ARN for that host. Empty renders **no** TLS annotation - HTTP on `:80`, correct rather than broken, but not what go-live wants. |

`alerts.runbookUrl` was a fifth row here and is **not a FILL any more**: both `values.yaml` and
`values-prod.yaml` carry the real URL of this document, and `render.test.sh` refuses a rendered
`runbook_url` still containing the chart's `<org>/<repo>` placeholder.

**And one in the other file**, the same shape and the same decision:

| File | Key path | What goes in |
|---|---|---|
| `deploy/chart/rch/values-staging.yaml` | `ingress.certificateArn` | The ACM certificate ARN for `rch-staging.example.com`. Empty renders no TLS annotation - staging on HTTP `:80`, correct rather than broken. Fill it, or decide out loud that staging runs on `:80`. |

The key was absent from that file entirely until the Phase 6 fix wave, while step 1 below had
always said both files need one; it is now present and empty, with production's own `# FILL`
comment beside it, and `render.test.sh` asserts for staging what it asserts for production -
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
| Repository **variable** | `DEPLOY_ENABLED=true` | `deploy.yml`'s `deploy` job is gated on `vars.DEPLOY_ENABLED == 'true'`, and its `skipped` job - named `Deploy skipped (DEPLOY_ENABLED is not true)` - runs instead when it is not. Until it is `true`, a push to `staging` or `production` deploys nothing. |
| Repository secret | `AWS_ROLE_ARN` | The OIDC role the workflow assumes. |
| Repository secret | `AWS_REGION` | |
| Repository secret | `ECR_REGISTRY` | Passed as `--set image.registry`. |
| Repository secret | `EKS_CLUSTER_STAGING` | |
| Repository secret | `EKS_CLUSTER_PROD` | |
| Repository secret | `SEED_PASSWORD` | **New, and blocking.** `deploy.yml` passes it as `--set-string secrets.values.SEED_PASSWORD`; `apps/api/src/config.ts` has no default for it, so an unset secret renders `SEED_PASSWORD: ""`, the api container refuses to start, and `--atomic` rolls the whole release back. At least twelve characters. Needed for **dev and staging** - both read repository/environment secrets - before the next push to either. |
| `staging` environment | `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `AUDIT_DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | Staging reads its secrets from the GitHub environment; production reads `rch/prod` out of AWS Secrets Manager through the `ClusterSecretStore`. `DATABASE_URL` is the `rch_app` URL, `MIGRATE_DATABASE_URL` the master user's, `AUDIT_DATABASE_URL` the `rch_audit` URL (§5, *The database roles*). |
| AWS Secrets Manager `rch/prod` | `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `AUDIT_DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY`, **`SEED_PASSWORD`** | **Seven keys.** `JWT_PREVIOUS_PUBLIC_KEY` may start empty; no other may. The `ExternalSecret` uses `dataFrom: [{ extract: … }]`, which copies every key of the remote JSON - so there is no template entry to add, but a remote secret missing one produces a pod that will not start. Mint the JWT pair with `pnpm --filter @rch/api keys:generate`, which prints two `JWT_*=` lines and never writes them anywhere. |

**3. The promotion, in order, run by a person.**

```bash
git checkout develop    && git merge --ff-only feat/phase-6-ops-go-live && git push
git checkout staging    && git merge --ff-only develop && git push        # deploys rch-staging
# verify staging: /readyz, a sign-in, one real sale, rebuild-balances reconciling (step 9 below)
# re-measure the load check against staging and record it against §12's targets (§12 above)
git checkout production && git merge --ff-only staging && git push        # waits for approval
```

Production's deploy waits on the `production` GitHub environment's approval before the job runs.
Work the numbered checklist below alongside these three commands - in particular step 4, which
deactivates the six seeded accounts, step 5, the payer roster, and step 6, the real restore drill. **Then, and only then,
is this build in a hospital.**

### The checklist

An ordered list. Each item is a command or a decision, and each decision names who makes it -
the account owner, not the executor of this phase's tasks. Nothing on this list has been run
against a real AWS account **for staging or production**; Phase 6 prepared the chart, the
workflow and this checklist and stopped there - running it is a release
decision. The equivalent steps have been run for `dev` (§15), which is exactly why the account
owner should not repeat them from the same starting point:

**Before anything else on this list: get off root.** Every AWS CLI call and CloudFormation
stack behind `dev` was run with the account's **root** credentials, from this laptop - the
fastest way to build something from nothing, and the wrong thing to keep doing into staging and
production. Create an IAM user or role for the operator, scoped to what standing up and running
an environment actually needs (EKS, RDS, ACM, Route 53, Secrets Manager, CloudFormation, and
read access to IAM to check the rest of this list) rather than the account's own unrestricted
root, before touching either. This is about the human running the commands in this section -
`rch-github-deploy`, the role the deploy *workflow* itself assumes, already exists, is already
scoped to what a deploy needs, and needs no change.

1. **Fill in the AWS facts the two values files are still missing** - `values-prod.yaml`'s five
   `# FILL` markers, its two conditional ones, and `values-staging.yaml`'s own
   `ingress.certificateArn`, all tabulated with their line numbers under "The release, prepared
   and not performed" above. Render the chart with the values supplied on the command line
   before pushing anything.

   **And, on the same pass, a pre-flight that is not about AWS at all: probe any database that
   already holds data, before its first `db:migrate` on this build.** Migration `0008` adds
   constraints that validate existing rows, so a database with history in it can *refuse* the
   migration - and a refused migration is an initContainer that never completes, which reads as a
   deploy that hangs rather than as bad data. §1's *Migration workflow* carries the five probe
   queries (`stock_moves` with `qty = 0`; a `reservations` row whose `ticket_id` has no `tickets`
   row; a ticket with `from_loc = to_loc`; `po_lines` with `rejected_qty > received_qty`;
   `batches` with `made_qty > started_qty`) and what to do about each, and
   `apps/api/scripts/preflight-0008.sql` runs all ten as one read-only script that prints `clear`
   or `BLOCKS 0008` per constraint. They are plain reads - run
   them against a restored copy if the window is tight. This applies to **dev too**, which has
   real documents on it; a fresh staging or production database has nothing to reject.

   **`0008` is still the only migration that can refuse.** `0009`–`0012` - the payer audit
   columns, the adjustment tables, the production order's needed-by date and the bill's three
   void columns - add tables and nullable columns and validate no existing row. `0013` adds a
   table and a defaulted column, `0014` fills its new column from `users` before tightening it,
   `0015_drop_recipes` drops two tables, and `0016_audit_outbox` adds an empty one. So a database
   this script calls clear is one every migration will apply to. Expect `migrations applied: N / N`, N being the length of
   `apps/api/drizzle/meta/_journal.json`.
2. **Create the environment's CloudFormation stack** - `deploy/cfn/rch-env.yaml` with
   `deploy/cfn/prod.params.json` (or `staging.params.json`). The template, not this list, is now
   where the RDS settings live, so read **[`deploy/cfn/README.md`](cfn/README.md)**
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
   single-AZ with 7 days - smaller on purpose, not a step skipped.

   **Three things this step does NOT give you, and each one bites differently:**
   - **The database is in public subnets - every environment's, production's included.** The
     stack puts all three in the shared `rch` DB subnet group, which is the default VPC's three
     *public* subnets. Closing it is not a parameter: it needs new subnets, a NAT route, a
     per-environment `DBSubnetGroup` replacing the shared import, and an outage to move an
     existing instance between subnet groups. What limits the exposure meanwhile is
     `PubliclyAccessible: false` plus the node-group-only security group above. **Do not read
     "matches the production RDS settings" as including this** - put it on the follow-up list below and decide it
     deliberately.
   - **`rds.force_ssl` is a STATIC parameter.** Attaching the parameter group leaves it
     `pending-reboot`; a stack update alone does not start enforcing TLS. Reboot the instance
     (off-hours) and re-check. Related: the API decides TLS from **`DATABASE_SSL` alone** -
     `db/client.ts` strips any `sslmode`/`ssl*` parameter off `DATABASE_URL` first, precisely so
     a connection string cannot quietly pick a different trust store - so keep `sslmode` out of
     the URL and leave `DATABASE_SSL=true`, which the chart already sets.
   - **The uptime alarm is not in this stack and cannot be.** Route 53 publishes
     `AWS/Route53 HealthCheckStatus` into `us-east-1` only, whatever region created the health
     check, so an alarm on it in `ap-south-1` sits in `INSUFFICIENT_DATA` for ever. The template
     creates the health check and an in-region `rch-<env>-alerts` topic; the alarm, and the
     `us-east-1` topic it publishes to, are one `put-metric-alarm` run by hand against the
     `UptimeHealthCheckId` output. `deploy/cfn/README.md` has the command.

   **When you do fill in `AlbLogsBucketName`, turning the logs on is a chart edit - and the
   prefix is a trap.** `values-prod.yaml` has no `access_logs.s3.*` today, deliberately: an ALB
   told to write to a bucket that does not exist, or to one without the log-delivery policy,
   reports nothing wrong and simply writes nothing. Once the bucket exists, append
   `,access_logs.s3.enabled=true,access_logs.s3.bucket=<AlbLogsBucketName>` to the
   `load-balancer-attributes` annotation, on one line, with no spaces - **and leave
   `access_logs.s3.prefix` unset.** The bucket policy is scoped to `AWSLogs/<account>/*`, AWS's
   documented path; a prefix relocates every object to `<prefix>/AWSLogs/…`, the policy refuses
   it, and the ALB writes nothing, silently. (The comment beside that annotation in
   `values-prod.yaml` still shows a `prefix=rch` in its example string - it predates the bucket
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
   `JWT_PUBLIC_KEY`, alongside `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `AUDIT_DATABASE_URL`, an
   empty `JWT_PREVIOUS_PUBLIC_KEY`, and **`SEED_PASSWORD`** - seven keys (§2's "First-time cluster
   setup" and the secrets table above).
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
   repeated for each of the six. **The seeded accounts must not exist, active, in production** -
   nothing before this checklist has said that plainly, and it is the one item on this list a
   missed step could not later be quietly forgiven for: a seeded id with a published dev password
   is a real door into a real hospital's billing. A database seeded `--bare` (§1) never had the
   six - only `RC-0001` - so on a bare start this step is creating the real accounts from `/admin`
   and then moving the admin flag onto a named person's own account (§1's *Test users*).

   Two notes on running the seed in a cluster at all. It needs **`--yes-seed <database name>`**
   (§15.7): the chart renders `NODE_ENV=production` into every pod, dev included, and
   `cli/seed.ts` refuses until the database names itself back. And **the seeded accounts on the
   `dev` host need their passwords
   reset now, as a separate job from this checklist** - they were seeded with the published
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
   behaviour you want on go-live morning rather than half a roster. Afterwards a new consultant
   or a new starter goes in the same way, one CSV at a time - decide who runs it and say so in the
   handover, because the ability to add a payer is the ability to open a credit account.
6. **Run the restore drill once against the real RDS instance** (§6, the RDS procedure below the
   local rehearsal) - not the rehearsal, the real one, before the first bill is ever posted for
   real.
7. **Create the repository variable, every secret, and the `production` GitHub environment** -
   `DEPLOY_ENABLED=true`, the six repository secrets (**`SEED_PASSWORD` is the new one, and
   blocking**), the `staging` environment's five, and AWS Secrets Manager's `rch/prod` with its
   **seven** keys: the table under "The release, prepared and not performed" above lists each one
   and what it populates, and §2 says where the workflow reads it - and run the `jq -e` check in
   the ExternalSecret bullet above, since production's secrets get no pre-flight from the
   workflow. Do this **before the next push
   to any environment**, including `dev`: the api container will not start without a seed
   password, and `--atomic` rolls the release back when it doesn't. A missing one is caught
   early now - `deploy.yml` has a named `Every secret the chart needs is present` step before
   `helm upgrade` that refuses by name, on dev and staging (production reads the same six
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
   pass. The failure mode is fail-safe - all four scans (ci.yml's two, deploy.yml's two) go red
   rather than quietly letting something through - but finding that out on the staging promotion
   costs the promotion. If a *fixed* HIGH does turn up in a distroless base, the remedy is an
   entry in `.trivyignore.yaml` with a reason and an `expired_at`, **not** lowering the severity
   back to CRITICAL.

   **On the same throwaway branch: check `.trivyignore.yaml`'s expiries before promoting.**
   `grep expired_at .trivyignore.yaml` and compare each date with today. An entry whose
   `expired_at` has passed stops being honoured, and all four scans go red at once - CI's two and
   the deploy workflow's two - which on the day of a promotion looks like the promotion having
   broken something. Do **not** push the date out to get past it: either the advisory has a fixed
   version in the base image now, in which case rebuild and the entry goes away, or it still does
   not, in which case renewing it is a decision somebody makes with the reason written down.

   **And label the namespaces for the pod readiness gate** (§2, *First-time cluster setup*) -
   `kubectl label namespace rch elbv2.k8s.aws/pod-readiness-gate-inject=enabled`, and the same
   for `rch-staging`, once, before the first upgrade of the release in each. Nothing fails
   without it; what you get instead is a gap in the middle of every rollout.
8. **Create `ng-prod`, the on-demand node group production's pods are pinned to.** It does not
   exist: the cluster has one spot node group, `ng-spot`, and `values-prod.yaml` sets
   `api.nodeSelector`, `ui.nodeSelector` and `audit.nodeSelector` to `rch.io/tier: prod` - a label
   nothing in the cluster carries. Promote without this and all three Deployments sit `Pending` for ever with no
   error anywhere; production upgrades **without `--atomic`** (§3), so nothing rolls it back.
   ```bash
   eksctl create nodegroup -f deploy/eksctl/cluster.yaml --include=ng-prod
   kubectl get nodes -l rch.io/tier=prod        # expect 3, one per availability zone
   ```
   Three on-demand nodes across `ap-south-1a/b/c`, untainted on purpose - the label pins
   production's pods in, and a taint would additionally keep the DaemonSets (vpc-cni,
   kube-proxy, the CloudWatch agent) off. `deploy/eksctl/cluster.yaml` carries the whole argument
   for the shape; `render.test.sh` asserts that whatever label the prod render asks for is a label
   some node group in that file actually applies, so the two cannot drift apart silently.
9. **Promote** - the three fast-forward merges under "The release, prepared and not performed"
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
    then the audit service's readiness, and its log:
    ```bash
    kubectl -n <namespace> port-forward svc/rch-audit 3100:3100 &
    curl -fsS http://localhost:3100/readyz
    ```
    sign in as the super admin and open the Audit log tab - that sign-in is its newest row, which
    proves the outbox, the drainer and the read on this environment. Then sign in as a real account
    through the browser, take one real sale, and finally
    ```bash
    kubectl exec deploy/rch-api -n <namespace> -- /nodejs/bin/node dist/cli/rebuild-balances.mjs
    ```
    and confirm it reports success with no unexpected drift. A green `/readyz` alone is not
    enough - it proves the database is reachable and migrated, not that a bill can be posted.

### The follow-up list

Four things the audit wave named that go-live does **not** close, each a decision rather than a
command. None of them blocks a first deploy; all of them should be decided out loud rather than
discovered later.

1. **Every environment's database sits in public subnets** - production's included (step 2
   above). The exposure is limited by `PubliclyAccessible: false` and a node-group-only security
   group, not by the network. Moving them needs private subnets, a NAT route, a per-environment
   `DBSubnetGroup` and an outage per instance.
2. **Nothing routes an alert to a person.** The chart renders eight `PrometheusRule` alerts (§9)
   and Alertmanager has no receiver configured for this cluster, so a rule that fires pages
   nobody. Who is on call, and by what channel, is the decision; the rules and their
   `runbook_url` anchors are already there.
3. **NetworkPolicy is applied and inert** until the live cluster's `vpc-cni` add-on is updated
   from `deploy/eksctl/cluster.yaml`, which now asks for `enableNetworkPolicy` (§2,
   *First-time cluster setup*, has the `eksctl update addon` command and the check). The file
   being right does not make the running cluster right. Turning it on is a deliberate change
   with real blast radius - do it on staging first, and watch a rollout.
4. **`/metrics` shares the serving port**: 3000 on the API, 3100 on the audit service. A
   NetworkPolicy decides on ports, not paths, so the `monitoring`-namespace rules in the api and
   audit policies are a record of the intended scraper rather than a control, and
   `networkPolicy.albSourceCidr` cannot be narrowed below what each serving port needs. Moving
   each `/metrics` to its own listener port is what would make both real.

## 12. Load check

`apps/api/scripts/loadcheck.mjs` measures the two latencies that have a target -
`GET /snapshot` p95 ≤ 150 ms, `POST /bills` p95 ≤ 200 ms - by hand, against a port-forwarded
staging pod, not in CI. A shared CI runner measures the runner, not the server; this is
deliberately a by-hand step run once before go-live and recorded, not a gate every push runs.

```bash
kubectl port-forward -n rch-staging svc/rch-api 3000:3000 &
LOADCHECK_PASSWORD=<staging-seed-password> node apps/api/scripts/loadcheck.mjs --base http://localhost:3000 --emp RC-4471
LOADCHECK_PASSWORD=<staging-seed-password> node apps/api/scripts/loadcheck.mjs --base http://localhost:3000 --emp RC-4471 --concurrency 30
```

The password comes from `LOADCHECK_PASSWORD`, not `--password` - a flag is left in the shell
history and in `ps` for as long as the run lasts; the script still honours `--password` and
warns when it is used, but the environment variable is the one to reach for. `--help` prints the
full flag list.

**Never point this at production.** `POST /bills` is a real sale - it moves real stock and
posts a real bill against whichever database `--base` resolves to. There is no dry-run flag,
and a stray `--base` pointed
at the production API would sell real stock at the concurrency the run asks for.

Before trusting a number, set up the run correctly - three things the wave-2 baseline run got
wrong before they were understood:

- **Raise `RATE_LIMIT_PER_MINUTE` for the run.** The limiter keys an authenticated request on
  `req.user.sub`, so every concurrent worker sharing the script's one bearer token draws from a
  single per-minute budget - at concurrency 10–30 the run measures 429s in the first second or
  two, not endpoint latency, unless the limit is raised well above what the run will throw at it.
- **Make sure the item the script sells has stock for the whole run.** `pickSellable` reads the
  signed-in user's own menu and shelf; a freshly seeded counter's stock is small by design (the
  seed's own coffee-shop stock is not sized for a load run). Top it up with a direct
  `stock_moves` insert (`kind: 'adjustment'`, mirroring `db/seed.ts`'s own shape) followed by
  `pnpm --filter @rch/api db:rebuild-balances` - never a direct edit to `stock_balances` itself.
  Reseeding and topping up stock is exactly what `loadcheck.mjs`'s own refusal message points at
  if the run runs dry mid-flight.
- **Run it alone, on as quiet a machine as you can get.** A wave-2 baseline taken at a host load
  average of ~19 (six other processes competing for the same CPU) failed §12's targets by 4–15× -
  a real finding about the *measurement*, not the server. Record the machine's `uptime` load
  average beside every number this script prints; a number with no load average beside it is not
  evidence of anything.

**Recorded: 2026-09-04, the first measurement anyone can attribute**, and re-measured the same
day once `GET /snapshot` stopped fanning out across the pool. MacBook Air (Mac14,2, Apple
silicon, 8 cores, 16 GB, macOS 26.6.2), node v24.20.0, **Postgres 17 in Docker on the same
machine** - which production's will not be. The API was the only thing running, started with
`RATE_LIMIT_PER_MINUTE=100000`, against a fresh seed with `coffee`'s `water` topped up to 200,012
by a `stock_moves` adjustment and a rebuild, exactly as the three bullets above prescribe. No run
in either column returned a single non-2xx. (The snapshot-only row also carried a once-a-second
`curl /metrics` beside it, for the pool depths quoted below - one request a second against a run
throwing thirty at a time.)

| Concurrency | Load average at the start | `GET /snapshot` | `POST /bills` |
|---|---|---|---|
| 10 | 3.59 | **PASS** p50 74.8 ms · **p95 102.7 ms** · p99 122.6 ms · max 151.5 ms · n=2601 | **PASS** p50 43.6 ms · **p95 126.1 ms** · p99 194.4 ms · max 362.8 ms · n=3656 |
| 30 | 3.81 | **FAIL** p50 1440.6 ms · **p95 1548.1 ms** · p99 1601.6 ms · n=441 | **FAIL** p50 134.3 ms · **p95 248.0 ms** · p99 1061.7 ms · n=3833 |
| 30, `--no-writes` | 3.00 | **FAIL** p50 2904.0 ms · **p95 3347.3 ms** · p99 3631.9 ms · n=228 | - |

**What changed, and what it bought.** Every read now runs inside one `read only` transaction
(`withReadTransaction`, `apps/api/src/lib/db.ts`), so one request takes **one** connection instead
of the ~40 acquisitions `GET /snapshot`'s `Promise.all` of twenty-four readers used to make. The
queue depth says it plainly: sampled once a second through the c=30 snapshot-only run,
`pg_pool_total` 10, `pg_pool_idle` 0, and `pg_pool_waiting` peaking at **20** - which is exactly
30 concurrent requests minus a pool of 10, where the same sampling before the change read
**771**. c=30 `GET /snapshot` came down from p95 2860.3 ms to 1548.1 ms and throughput from 12
snapshots a second to 22; c=10 is unchanged within noise (104.5 → 102.7 ms), which is the point -
the fan-out never bought latency, it only bought queueing.

**It still misses 150 ms at c=30, and that is now honestly the pool, not the request.** Thirty
concurrent readers against ten connections means two thirds of them wait, and on this laptop a
snapshot holds its one connection for the whole of its ~40 sequential round trips. `DB_POOL_MAX`
is the knob (default 10, deliberately not raised here - see the three things below), and §12
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
   at once", so `pg_pool_waiting > 0` with `pg_pool_idle == 0` - which is exactly what
   `RchApiPoolSaturated` alerts on - means genuinely that many concurrent requests, not one
   request holding forty. Raise it only alongside the instance behind it: three replicas × 10 is
   already 30 of RDS's own connection budget.
3. **The RDS instance class** (`db.t4g.medium` in staging is not sized for a load test's
   concurrency, only for real traffic's).

## 13. The end-to-end smoke

Removed on 2026-09-14, with the `e2e/` package it ran; no test drives the app through a browser
any more. CI's kind install (`deploy/chart/rch/ci/install-test.sh`) still proves the images
install, migrate and seed, that `/readyz` answers, that a seeded account signs in, and that the
UI serves its `/healthz`. The section number is kept so the ones after it do not move.

## 14. Procurement and quarantine

Buying (Phase 5) is `requisitions`, `purchaseorders`, `grn`, `vendors`, `contracts` and
`productreqs` - vendors, requisitions, the purchase-order lifecycle and goods receipt, all
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
at;`) - do not correct it with an `UPDATE`.

**Reading a goods receipt's ledger:**

```sql
select * from stock_moves where ref_type = 'grn' and ref_id = 'GRN-260143-01';
```

One positive row at `store` for what was accepted, one positive row at `quarantine` for what
was rejected, and no row at all for a quantity of zero.

**An order is decided on what the shelf accepted, not on what the lorry carried.** `received_qty`
on a `po_lines` row is the **gross** arrival record - what the delivery notes add up to - and
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
  through the API - §1's migration notes carry the one-statement correction for a pre-audit order
  stranded there.)
- **Closing short gives back the rejected quantity too.** `shortfallClaims` releases
  `qty − accepted`, last source first, so what quality control turned away goes back onto the
  procurement list with the rest of the balance rather than being written off the requisition.
- **The 2% tolerance measures net-prior plus this arrival's gross**, which is what lets a
  replacement delivery in at all: an order for 120 whose first consignment of 120 was rejected
  whole can take a second consignment of up to 122.4, so 242.4 units may pass through the door in
  total against a 120-unit order. That is right - the vendor is replacing goods it took back - but
  it means **gross arrival against an order is not bounded by 102% of what was ordered**, and a
  report that reads `received_qty` as "quantity delivered" will say so. Read `accepted`.

The refusal sentence the store keeper reads on an over-delivery quotes that **net-prior +
gross-arrival** total, not the running gross - so the number in "… exceeds the ordered 120 by more
than 2%" will not match `sum(received_qty)` on an order that has had anything rejected. That is
the arithmetic above, not a miscount.

**GRN numbering, as of Phase 6:** `GRN-<yy><po number>-<nn>` - the second instalment against
`PO-2026-0143` is `GRN-260143-02` - where `nn` counts that order's own instalments. There is
**no `sequences` row for it**; the count is read under the order's `for update` lock, which is
what stops two receipts drawing the same number. Do not "fix" a gap - there cannot be one.
`packages/domain/src/ids.ts`'s `grnId(poId, n)` is the one place the format lives.

**The format changed because the old one collided.** Before Phase 6 a GRN was
`GRN-<last 3 of the PO>-<nn>`. Two purchase orders whose ids shared the same last three
characters - `PO-2026-0143` and `PO-2027-0143`, both ending `143`, or `PO-2026-0143` and
`PO-2026-1143` - minted the same GRN id for their first receipt; the `grns` primary key refused
the second one outright, an ordinary constraint error in the middle of a receiving desk's day
rather than a store-worded refusal. **GRNs written before the change keep their old,
three-character-tail ids** - nothing was renumbered, and there is no backfill; a receipt whose
id reads `GRN-143-01` is simply an older one, not something to correct by hand.

**Quarantine:** `select * from stock_balances where loc = 'quarantine';` is what the store
keeper's screen shows. Nothing issues, sells or transfers from there, and no purchase-return or
debit-note document exists - that was considered and declined, and it stays declined: recovering the money from a
vendor is a conversation, not a screen.

**The shelf itself does have an exit now, and it is not SQL.** Since the audit wave's fourth block the **store keeper** - and only the store keeper, of the five roles - can raise an
adjustment against `quarantine`, typically reason `returned_to_vendor` for a consignment going
back, or `expired` / `breakage` for one that is not going anywhere. It is the one write body in
the whole API that may name `quarantine` at all; a manager there reads *You can only adjust stock
at an outlet - the central store writes off its own shelves*. So the answer to "how do I clear
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

**A refused receipt:** a `POST …/receive` that answered 422 has written nothing - no GRN row,
no move, no change to `received_qty` - because every line is validated before the first write.

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
where Phase 6 left them - the chart, the workflow and the go-live checklist (§11) are ready for
them, but neither has an AWS resource behind it, and `values-staging.yaml`'s
`ingress.certificateArn` is still `# FILL`. What follows either was built once by hand or is a
procedure meant to be repeated the next time an environment needs standing up - staging first,
when that day comes.

### 15.1 Cluster

`eksctl create cluster -f deploy/eksctl/cluster.yaml` built `rch` - EKS **1.31**, `ap-south-1`,
in the account's **default VPC** `vpc-01ca67a181cb36d34`, on its three public subnets
(`subnet-05be7e2c146d6ede8`/`04f03f730a553b579`/`08d892f0f99bd8097`, each tagged
`kubernetes.io/role/elb=1` so the load balancer controller will place an ALB in them) - the
default VPC rather than a purpose-built one because the RDS instances live in it too, reachable
with no peering and no NAT. Two managed node groups are declared:

- **`ng-spot`** - spot-only (`t3.medium`/`t3a.medium`, min 1, max 2, desired 1), what dev and
  staging run on. A two-minute spot-reclaim notice is an acceptable outage for dev's whole
  footprint (one API pod, one UI pod, room to spare on a single 4 GiB node), and spot runs
  roughly 70% off the same instance type on-demand. This is the only group that exists today.
- **`ng-prod`** - on-demand `t3.medium`, min/desired 3, max 6, one node per AZ
  (`ap-south-1a`/`b`/`c`), labelled `rch.io/tier: prod`, 40 GB gp3. **It is declared and not yet
  created**: run `eksctl create nodegroup -f deploy/eksctl/cluster.yaml --include=ng-prod`
  (the `--include` matters - without it eksctl works on every group in the file) before the
  first production deploy. `values-prod.yaml` pins all three Deployments to it with
  `nodeSelector: { rch.io/tier: prod }`, which is what keeps production off the spot node - the
  group carries **no taint**, deliberately, because the DaemonSets (vpc-cni, kube-proxy, the
  CloudWatch agent) have to run on every node and know nothing about this application. Three
  nodes across three AZs is also what makes production's PodDisruptionBudget and topology spread
  mean anything; on one node both are decorative. `maxSize: 6` is a ceiling, not autoscaling -
  the cluster has neither Cluster Autoscaler nor Karpenter.

`deploy/eksctl/cluster.yaml` is the source of truth for the cluster, its node groups and its
add-ons, and its header says so in three lists - including what moved to CloudFormation (RDS,
ECR, the OIDC provider and deploy role, Secrets Manager, ACM, Route 53, the health check, SNS,
the ALB log bucket) and what is managed by neither (the AWS Load Balancer Controller's own Helm
install).

**What tripped: the first cluster came up without CoreDNS.** `eksctl create cluster`'s own run
was cut short after the control plane finished, before it installed the managed add-ons, and
nothing scheduled a pod could resolve a name - not the API's own RDS endpoint lookup, not the
load balancer controller's calls out to AWS - until `vpc-cni`, `coredns` and `kube-proxy` were
installed by hand as EKS add-ons. `deploy/eksctl/cluster.yaml` now declares five under
`addons:` - `vpc-cni`, `coredns`, `kube-proxy`, **`metrics-server`** (without a metrics API the
production HPA reports `<unknown>/70%` and never scales, and `kubectl top` cannot see a pod's
CPU either) and **`amazon-cloudwatch-observability`** (Container Insights: node, pod and
container metrics plus container logs, with `CloudWatchAgentServerPolicy`) - so a fresh `eksctl
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
security group `rch-rds` admitting **5432 from the VPC CIDR (`172.31.0.0/16`) only** - a
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
image - `db/client.ts` strips `sslmode`/`ssl*` off the URL first. The instance's own half,
`rds.force_ssl=1`, arrives with the per-environment parameter group the same template creates,
and is a **static** parameter: it stays `pending-reboot` until the instance is rebooted. Multi-AZ,
point-in-time recovery and deletion protection are the production-only pieces this instance
deliberately does not carry; §11 step 2 and `deploy/cfn/README.md` have the full production spec.

**On RDS the migrate role is the master user**, which is `rds_superuser` rather than a true
superuser. It holds `CREATEROLE`, which is what the two migrate steps need to create `rch_app` and
`rch_audit` and set their passwords, and it owns every table it migrates, which is what they need
to grant. `MIGRATE_DATABASE_URL` is its URL; `DATABASE_URL` and `AUDIT_DATABASE_URL` name the two
runtime roles (§5, *The database roles*).

### 15.3 Secrets, and the GitHub side of the pipeline

AWS Secrets Manager `rch/dev` is the source of truth - RDS master password, `DATABASE_URL`, the
JWT pair. The GitHub **environment** `dev` carries its own copies of `DATABASE_URL`,
`JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` for the workflow to read (`secrets: { create: true }` in
`values-dev.yaml` - the same path staging will use; production is the one that reads Secrets
Manager directly, via External Secrets). Repository secrets `AWS_REGION`, `ECR_REGISTRY`,
`AWS_ROLE_ARN` and `EKS_CLUSTER_DEV=rch` now exist alongside `EKS_CLUSTER_STAGING=rch` and
`EKS_CLUSTER_PROD=rch` (all three name the one cluster - every environment is a namespace on it,
not a cluster of its own), and the repository variable `DEPLOY_ENABLED` is `true`.

**A `SEED_PASSWORD` repository secret must be added before the next deploy of any environment.**
`deploy.yml` reads it into the `--set-string` list beside the three JWT/database values, and
`apps/api/src/config.ts` now requires it with no default - an unset secret renders
`SEED_PASSWORD: ""`, the api container fails config validation on start, and `--atomic` rolls the
release back. Production's `rch/prod` secret in Secrets Manager needs the same key as its fifth
(§11's secrets table); `_helpers.tpl` wires it as a `secretKeyRef` in every container and
`render.test.sh` asserts it is never a plaintext `value:` and never `optional: true` - Go's `eq`
is variadic, so a second name in that template's `if eq` would silently make the key optional,
which is exactly what "required" is trying to prevent.

**The audit service added two more.** The chart now reads `MIGRATE_DATABASE_URL` (the master
user's URL, for both migrate initContainers and the CLIs) and `AUDIT_DATABASE_URL` (the
`rch_audit` URL), and `DATABASE_URL` became the `rch_app` URL. An environment stood back up needs
six secrets in its GitHub environment and seven keys in `rch/prod` (§2, §11's secrets table).
The env helpers in `_helpers.tpl` (`rch.apiEnv`, `rch.apiCliEnv`, `rch.auditEnv`, `rch.auditMigrateEnv`)
name, per container, only the secrets that container uses: the api container holds no
`MIGRATE_DATABASE_URL` (the migrate initContainer and the purge CronJob do), and the audit containers
never see `JWT_PRIVATE_KEY` or `SEED_PASSWORD`.

**What tripped: two failed deploy runs, both at `configure-aws-credentials`, for two unrelated
reasons.** The first failed with "Request ARN is invalid" - `AWS_ROLE_ARN` had been set to the
wrong value; re-setting the secret to the actual role ARN fixed that run. The second failed with
"Not authorized to perform sts:AssumeRoleWithWebIdentity" - a genuinely different problem, and
the one worth reading carefully before it recurs on staging or production: GitHub's OIDC token
presents a **subject** in one of two shapes depending on whether the organisation enforces its
immutable form - `repo:<org>/<repo>:…` (mutable, breaks if either is ever renamed) or
`repo:<org>@<org id>/<repo>@<repo id>:…` (immutable, keyed by ids GitHub never reassigns). This
organisation enforces the immutable form. `rch-github-deploy`'s trust policy was first written
against the mutable pattern, which the token this org issues can never match - no amount of
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
edit - the role is CloudFormation-managed now (§15.5). The trust policy applied by that first
update listed **both** shapes, `ref:refs/heads/{develop,staging,production}` and
`environment:{dev,staging,production}`, in both the named and the numeric-id form. **The audit
wave removed the six `ref:` subjects**; only the `environment:` ones remain. `deploy.yml` sets
an `environment:` on every deploy job, so nothing real loses access - what the `ref:` subjects
admitted was a workflow on `refs/heads/production` declaring *no* environment, which is the
production approval gate going missing. This has not yet been applied: it lands on the next
`rch-dev` stack update, and it takes effect on the dev deploy at that moment (§15.5).

```bash
aws iam get-role --role-name rch-github-deploy --query 'Role.AssumeRolePolicyDocument'
```

is how to re-check what it currently admits.

### 15.4 Certificate and DNS

The zone is `hashtrickstechnologies.com` in Route 53 (`Z066296313TA69I4LDOOI`) - **Route 53
holds the zone's LIVE name servers**, even though the domain is registered at Hostinger, so
every record (the CAA entries below, the app's own A-alias) goes in Route 53 and nothing at
Hostinger.

**The CAA lesson.** The zone's CAA records admitted only `letsencrypt.org`, `pki.goog` and
`sectigo.com` - none of Amazon's own issuers - so three ACM certificate requests for
`rch.hashtrickstechnologies.com` failed `CAA_ERROR` in a row. Adding Amazon's four issuers
(`amazon.com`, `amazontrust.com`, `awstrust.com`, `amazonaws.com`) as CAA records, both on the
host name and at the apex, was necessary but **not sufficient** - a name ACM had already looked
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
trust-policy fix above) - `aws cloudformation describe-stacks --stack-name rch-dev` reads
`UPDATE_COMPLETE` with every resource's identifier published as a stack Output, including the
five it exports for `staging`/`prod` to import. `deploy/cfn/README.md` has the full procedure
and every constraint that shaped it: an import change set may add no Outputs, no stack Tags and
no resources beyond what it lists in `ResourcesToImport`; every resource the template declares
still needs an explicit `DeletionPolicy`; and the one resource that did not exist yet at import
time - the CAA record for the brand-new host name - was created by the plain update that
immediately followed the import, not smuggled into the import itself. `staging` and `prod`
stacks, when they exist, import `dev`'s shared singletons (the OIDC provider, the DB subnet
group and security group, both ECR repositories) by `Fn::ImportValue` rather than declaring
their own, because AWS refuses a second copy of any of the five. Read `deploy/cfn/README.md`
before touching any of it - it is being maintained separately from this document.

**Two changes since that import that matter before the next `rch-dev` stack update.**

- **The next update is not a no-op, and it is an outage window.** The template now creates a
  parameter group, an Enhanced Monitoring role and ECR lifecycle policies, removes six OIDC
  trust-policy subjects, and modifies `Database` (parameter group, `AutoMinorVersionUpgrade`,
  log exports, Performance Insights, Enhanced Monitoring, both windows). None of those replaces
  the instance, but attaching a parameter group containing a **static** parameter is *Some
  interruptions* in the CloudFormation reference, not *No interruption* - CloudFormation may
  satisfy it by rebooting `rch-dev` mid-deploy, at a moment nobody chose. Run it off-hours.
  `deploy/cfn/README.md`'s *"Run this stack update off-hours: it may reboot the database"*
  tabulates which properties can bounce the instance and which cannot.
- **The OIDC trust is narrowed to `environment:*` subjects.** The six
  `ref:refs/heads/{develop,staging,production}` subjects are gone. `deploy.yml` sets an
  `environment:` on every deploy job, so nothing real loses access - but applying this stops any
  workflow that assumes `rch-github-deploy` **without** declaring a GitHub environment, and it
  takes effect on the *dev* deploy the moment the stack is updated. What the removed subjects
  actually admitted was a workflow on `refs/heads/production` declaring no environment at all,
  i.e. the production approval gate going missing.

- **An IMPORT change set can no longer stand up a new environment under this template.** An
  import may create nothing, and every declared resource must be in the import list - which now
  includes a parameter group, a security group, a monitoring role, a health check, and
  conditionally a topic and a bucket. Use `create-stack` for `staging` and `prod`; the import
  path exists only because `rch-dev` predated the template. `deploy/cfn/README.md` says so and
  carries the procedure.

### 15.6 What dev costs

Roughly **$130/month** at AWS list prices, `ap-south-1`: the EKS control plane (~$73), one spot
`t3.medium` (~$10 - the same instance on-demand runs roughly triple), RDS `db.t4g.micro` (~$17),
and the ALB (~$22). Karpenter is not worth adding at this scale: one node group with a 1–2 spot
range already covers the whole footprint, and Karpenter's own value shows up at a scale this
environment neither has nor is expected to reach - the saving here is entirely the spot discount
on the managed group, not autoscaling sophistication.

**That figure is dev only, and `ng-prod` is not in it.** Creating the production node group adds
three on-demand `t3.medium` - roughly **+$90/month** before production's own ALB (~$22) and its
`db.t4g.medium` Multi-AZ instance. The EKS control plane is shared, so it is not paid twice.
Two smaller line items the template adds everywhere and nothing has been paying yet: an SNS
topic and a Route 53 health check (cents, and the health check is gated on `AlertEmail` being
set, so dev creates neither), and Performance Insights at the free 7-day retention, which costs
nothing on any of the three instance classes in use.

### 15.7 First deploy and seed

The workflow builds and pushes all three images, then `helm upgrade --install rch deploy/chart/rch -f
values-dev.yaml --namespace rch-dev --create-namespace --wait --atomic` - the same shape §2
describes for staging and production, with `dev`'s own values file and namespace. After the
first deploy succeeds, seed the database once. A seed needs the superuser, which the api
container does not hold, so it runs in the one-off pod §5 (*Operator CLIs in a cluster*) builds
from the `migrate` initContainer, with `NS=rch-dev` and
`CLI='["dist/cli/seed.mjs", "--yes-seed", "rch"]'`.

**`--yes-seed <database name>` is not optional here, and dev is not an exception.** The chart
renders `NODE_ENV=production` into every pod in every namespace, and `cli/seed.ts` refuses to seed
there until the database is named back, because a seed rewrites every seeded account's password.
`rch` is the name in every environment - `DBName` on the RDS instance is `rch` in `dev`, `staging`
and `prod` alike, the instance being what differs - so check `select current_database()` if you are
anywhere else. Without the flag the command exits 2 with that sentence and nothing is written; with
the old `--allow-production` alone it exits 2 naming `--yes-seed`. A re-seed additionally needs
`--force --yes-destroy rch`; CI's kind install runs the same `--yes-seed rch` form for the same
reason (`deploy/chart/rch/ci/install-test.sh`).

The seed accounts and `SEED_FORCE_PASSWORD_CHANGE` behave exactly as §1 describes for local
dev - this is the same seed CLI, run in the cluster instead of against `localhost:5439` - with one
difference that matters: the password those accounts get is now `SEED_PASSWORD` from the pod's own
environment, which has to exist as a secret before the deploy that precedes this command (§15.3).
**The six accounts seeded on `dev` before that change still carry the published `changeme`** and
need resetting (§11 step 4) - a required variable stops it recurring, it does not undo it.

## 16. Single-instance deploy (EC2 + Compose)

**Why this exists.** On 2026-09-12, with the EKS environment §15 describes costing roughly
$438/month and idle outside active development, the account owner tore it down completely (RDS
instance, the `rch-dev` CloudFormation stack, the cluster and its node group, the load
balancer, the DNS records, the certificate, the two ECR repositories and the deploy role - one
RDS snapshot, `rch-dev-final-20260912`, was kept before the delete). `DEPLOY_ENABLED` is set
`false` so a push to `develop` no longer tries to deploy to a cluster that is gone. In its
place: one EC2 instance running the application under Docker Compose, at roughly a tenth of the
cost, with an ordinary daily EBS snapshot standing in for RDS's automated backups. §15's
cluster, chart and CloudFormation stay exactly as written - reachable again with
`eksctl create cluster` and an `aws cloudformation deploy` the day a second environment (or the
availability a managed control plane buys) is worth the cost again - this section does not
retire them, it is the cheaper thing running meanwhile.

`deploy/compose/` is the whole of it: `compose.yml`, `Caddyfile`, `.env.example`, `deploy.sh`,
`backup.sh`, `compose.test.sh` (`pnpm compose:test`, the compose analogue of `helm:test`) and
its own `README.md` with the day-to-day commands. This section is what provisioned the box
around it and the reasoning behind each piece; `deploy/compose/README.md` is what an operator
runs.

### 16.1 What runs, and why it is shaped this way

Seven services, one instance, one Docker network:

| Service | Image | Connects as | Starts after |
|---|---|---|---|
| `postgres` | `postgres:17` | - | - |
| `migrate` (one-shot) | `rch-api:local`, `dist/cli/migrate.mjs` | `rch`, and creates `rch_app` from `DATABASE_URL` | `postgres` is healthy |
| `audit-migrate` (one-shot) | `rch-audit:local`, `dist/cli/migrate.mjs` | `rch`, and creates `rch_audit` from `AUDIT_DATABASE_URL` | `migrate` completed |
| `api` | `rch-api:local` | `rch_app` | `migrate` completed |
| `audit` | `rch-audit:local` | `rch_audit` | `audit-migrate` completed |
| `ui` | `rch-ui:local` | - | `api` |
| `caddy` | `caddy:2.10-alpine` | - | `ui`, `api`, `audit` |

The two migrate steps are the same `dist/cli/migrate.mjs` files the EKS initContainers run,
ordered by compose's own `depends_on: condition: service_completed_successfully`. The three
application images build from the identical `apps/api/Dockerfile`, `apps/audit/Dockerfile` and
`UI/Dockerfile` the EKS path builds - one image definition per service, two places to run it.
`migrate` is also the door for every operator CLI (`run --rm --no-deps migrate dist/cli/<name>.mjs`),
being the one service that connects as `rch`: `deploy.sh`'s first-run seed and `backup.sh`'s
nightly purge go through it too. `.env` carries `APP_DB_PASSWORD` and `AUDIT_DB_PASSWORD` for the
two runtime roles (§5, *The database roles*).

**Caddy reaches `api`, `audit` and `ui` directly, with no second reverse-proxy hop.** The EKS path
is ALB → (path routing) → `ui`'s nginx (which itself proxies `/api/` onward), `api` or `audit`; on
one box, Caddy's own path routing reaches each container directly, so `TRUST_PROXY=1` (one hop) is
correct unchanged. Caddy orders its routes by specificity, not by their place in the file, so they
are tried as `/api/v1/admin/audit*` → `audit:3100`, `/readyz/audit` → the audit service's own
`/readyz`, `/readyz` → `api:3000`, `/api/*` → `api:3000`, then everything else → `ui`
(`compose.test.sh` asserts that order). `ui`'s nginx still carries its `/api/` and
`/api/v1/admin/audit` blocks (it is the same image, and Compose gives it `AUDIT_UPSTREAM`), it is
simply never asked to use them here. `flush_interval -1` on the API route is what
keeps `/api/v1/events` (server-sent events) streaming rather than buffered.

**A changed Caddyfile reaches Caddy only because `deploy.sh` hands compose its checksum.** The file
is a bind mount, so editing it changes nothing compose can see in the service definition, and this
box runs Caddy with `admin off`, so there is no `caddy reload` either: a deploy that changes only
the routes would otherwise leave a long-running Caddy serving the config it started with. The audit
release hit exactly that - the new `/readyz/audit` and `/api/v1/admin/audit` routes sat on disk
while a three-day-old Caddy went on sending both to the UI. `deploy.sh` now exports
`CADDYFILE_SHA=$(sha256sum Caddyfile)`, `compose.yml` passes it into Caddy's environment, and a
changed checksum is a changed service definition, so `up -d` recreates Caddy when the routes change
and leaves it alone when they do not. `compose.test.sh` asserts both halves. To apply a Caddyfile
edit by hand on the box, recreate rather than restart:
`docker compose --env-file .env -f compose.yml up -d --force-recreate caddy`.

**Neither Node runtime image has a shell** (both are distroless), so neither carries a
`HEALTHCHECK` a container orchestrator could run; `restart: unless-stopped` recovers a crash.
`deploy.sh`'s final step polls `https://<domain>/healthz` through Caddy, and `release.sh` then
requires `https://<domain>/readyz` (the API: its database and every migration in its journal) and
`https://<domain>/readyz/audit` (the audit service: its database, its migrations and a drain pass
in the last 30 s). Before the audit service shipped, Caddy had no `/readyz` route, so the UI's
nginx answered it with a static `ok` that checked nothing.

Both checks read the body and require `{"ok":true}`, in `release.sh` and again in `deploy-box.yml`.
A status code on its own is not evidence here: anything Caddy does not route falls through to the
UI, which answers 200 with the SPA for every path it does not recognise, so a readiness endpoint
that never reached its container still looks healthy. That is not hypothetical - the audit release
passed a status-only check while `/readyz/audit` was being served the SPA.

**`DATABASE_SSL=false` is set explicitly.** The API image always sets `NODE_ENV=production`, and
`config.ts`'s `databaseSsl` defaults to `true` whenever it is unset in production - right for
RDS, wrong for a container Postgres on the same Docker network with no TLS listener at all.

**Seeding is `--bare`, and still needs `--yes-seed rch`,** for the same reason §15.7 gives for
the cluster: the image runs `NODE_ENV=production` here too, and the guard does not treat "just
launched on a new box" as a reason to skip it. `deploy.sh` passes both automatically, and only
the first time the `users` table is empty - a later `deploy.sh` run against a stack that already
has data is a no-op on this step. `--bare` because this box is a real deployment: it starts with
the six locations and `RC-0001`, never the demo hospital (§1). (It was seeded with the demo
hospital on 2026-09-12, before `--bare` existed, and put back to a clean start on 2026-09-14 -
§16.5.)

### 16.2 What was provisioned, once, by hand

Region `ap-south-1`, account `830283280199`, the same default VPC (`vpc-01ca67a181cb36d34`)
§15's cluster used:

- **Instance** `i-0b581bbf5e55e7a7f`, `t4g.medium` (2 vCPU, 4 GiB, Arm - Graviton is why the
  Compose deploy costs roughly half what the same shape costs on `t3`), Ubuntu 24.04 LTS arm64
  (`ami-004fef5ef59c0175f`, read from the `/aws/service/canonical/...` SSM parameter rather than
  pinned, so a rebuild picks up whatever is current), 30 GB gp3 root volume, encrypted,
  `IMDSv2` required (`HttpTokens=required`). User data installs Docker CE, the compose plugin,
  a 2 GB swap file (a t4g.medium's 4 GiB was comfortably enough for the first four containers -
  check `free -m` on the box before adding another long-running one - and swap is
  the difference between a slow moment under `docker compose build` and an OOM-killed one),
  and the AWS CLI - the box needs the last one for its own nightly backup upload.
- **Key pair** `rch-box` (Ed25519), private half at `~/.ssh/rch-box.pem` on the operator's own
  machine - it is not in git and has no other copy.
- **Security group** `sg-0592a55147df5d0a3` (`rch-box`): 22/tcp from the operator's own IP only,
  80/tcp and 443/tcp from anywhere (Caddy needs 80 for the ACME HTTP-01 challenge as well as the
  plain-HTTP → HTTPS redirect). Widen or narrow the SSH rule with
  `aws ec2 authorize-security-group-ingress` / `revoke-security-group-ingress` as the operating
  IP changes; there is no bastion. The CI deploy does not use SSH at all - it reaches the box
  through SSM (§16.6).
- **Elastic IP** `65.2.95.154`, associated with the instance so a stop/start (unlike a
  terminate/relaunch) never changes the address DNS points at.
- **IAM role + instance profile** `rch-box`, trusted by `ec2.amazonaws.com`, carrying one
  inline policy (`rch-backups-write`: `s3:PutObject` and `s3:ListBucket` on the backup bucket
  below) and, since 2026-09-14, the AWS-managed `AmazonSSMManagedInstanceCore`, which lets the
  box's own SSM agent register and take commands (§16.6). It reaches no other AWS resource.
- **S3 bucket** `rch-backups-830283280199`, public access blocked, a 30-day expiration
  lifecycle rule on every object (so the nightly dumps do not accumulate forever) - `backup.sh`
  writes to it under `db/`. **This dump does not carry item photos** - `pg_dump` only ever held
  `items.image`, the sha256 pointing at one, never the bytes. The bytes live in their own bucket,
  `rch-images-830283280199` (§16.8), which is its own backup (versioning, not a nightly dump).
- **DLM lifecycle policy** (`policy-0d0f10f7fc51be10e`): a daily EBS snapshot of every volume
  tagged `project=rch` (the instance's root volume is), at 21:30 UTC, 7 kept. This is the
  whole-box safety net beside `backup.sh`'s logical dump - a bad `apt upgrade` or a full-disk
  Docker mess is a volume restore, not a rebuild from `eksctl create cluster` all over again.
- **Route 53** `rch.hashtrickstechnologies.com` A record (zone `Z066296313TA69I4LDOOI`,
  TTL 60s - short, so a future re-point of the IP propagates quickly), pointed at the Elastic IP
  above rather than at anything ALB-shaped.

None of the above is in Terraform, CloudFormation or a script committed to this repository -
it was five `aws ec2` / `aws iam` / `aws s3api` / `aws dlm` / `aws route53` calls run once by
hand, listed here so the next person (or the next agent) can read what exists without
reconstructing it from the console. A `deploy/cfn/` template for this shape would be reasonable
future work if the box is ever rebuilt from scratch more than once.

### 16.3 First deploy and later ones

```bash
ssh -i ~/.ssh/rch-box.pem ubuntu@rch.hashtrickstechnologies.com
git clone https://github.com/Hashtricks-Technologies/RCH.git rch && cd rch
cp deploy/compose/.env.example deploy/compose/.env
# fill in DOMAIN, POSTGRES_PASSWORD, APP_DB_PASSWORD and AUDIT_DB_PASSWORD (long and random -
# the migrate steps set them on rch_app and rch_audit), JWT_PRIVATE_KEY / JWT_PUBLIC_KEY
# (pnpm --filter @rch/api keys:generate, run anywhere with Node - the box itself needs none),
# SEED_PASSWORD (12+ characters), BACKUP_BUCKET
deploy/compose/deploy.sh
```

Later deploys are automatic (§16.6). `deploy.sh` rebuilds only what changed, brings the stack up
in the same dependency order, and never reseeds a database that already has rows in `users`. Add
the cron line from `deploy/compose/README.md` once, for the nightly backup.

A first run seeds `--bare` (§1): sign in as `RC-0001` with `SEED_PASSWORD`, choose a new
password, create the real staff at `/admin`, enter items, prices and menus from the screens,
and load the payer roster from a CSV (§5) - §1's last paragraph has the order.

### 16.4 What this trades away against the EKS path

One instance, so no rolling deploy - `deploy.sh` restarts `api`, `audit` and `ui` in place, a handful of
seconds of connection refused rather than the EKS path's zero-downtime rollout. No horizontal
scaling - this shape suits the load a single hospital's F&B operation puts on it (§12's load
check), not a multi-tenant deployment. The database's durability is a nightly logical dump plus
a daily disk snapshot, not RDS's continuous point-in-time recovery - restoring means replaying
today's dump against a fresh `postgres:17`, losing whatever changed since the last one ran,
which for this box is at most last night's business. If either trade-off stops being
acceptable, §15's cluster and chart are still the answer; nothing here prevents standing them
back up.

### 16.5 Putting the box back to a clean start

The box was first seeded with the demo hospital (2026-09-12, before `--bare` existed) and put back
to a bare start on 2026-09-14: every demo item, recipe, price, menu, stock line, payer, vendor and
document, and the six demo staff accounts, removed; the six locations and `RC-0001` kept. The
procedure, if it is ever needed again - it empties **every** table, so it is only for a box
nobody has started using for real:

```bash
ssh -i ~/.ssh/rch-box.pem ubuntu@rch.hashtrickstechnologies.com
cd /opt/rch/app && git pull && deploy/compose/deploy.sh      # the running image must know --bare
cd deploy/compose
./backup.sh                                                   # a dump to S3 first - the way back
docker compose --env-file .env -f compose.yml run --rm --no-deps migrate \
  dist/cli/seed.mjs --bare --force --yes-seed rch --yes-destroy rch
docker compose --env-file .env -f compose.yml run --rm --no-deps migrate \
  dist/cli/users.mjs reset-password --emp RC-0001 --password '<a temporary one>'
```

The reset is optional - `RC-0001` already starts on `SEED_PASSWORD`, forced to change it at first
sign-in - but it hands the operator a password that was never written into `.env`. Sign in as
`RC-0001` and follow §16.3's last paragraph. The way back from a mistake is the dump: pipe
`gunzip -c rch-<stamp>.sql.gz` into `docker compose … exec -T postgres psql -U rch -d rch` against
a freshly emptied database, then run `migrate` and `audit-migrate` so `rch_app` and `rch_audit`
exist and hold their grants (§6 has the restore itself and why).

### 16.6 Continuous deploy from develop

Since 2026-09-14, a push to `develop` deploys itself once CI is green on it.
`.github/workflows/deploy-box.yml` does it in three steps:

1. **It picks the commit.** That is `workflow_run.head_sha`, or for a manual run from the Actions tab
   the commit typed in (blank means the tip of `develop`). A manual run is refused unless the commit is
   on `develop` and CI has gone green on it.
2. **It runs the release on the box through SSM.** The job assumes `rch-github-box-deploy` through
   GitHub's OIDC provider. That role's trust policy admits only this repository's `dev` environment, in
   both the immutable and the plain subject form (§15 explains why both). The `dev` environment in turn
   deploys only from `develop`. The role's one inline policy, `box-release`, allows `ssm:SendCommand`
   on the `rch-box` instance with the `AWS-RunShellScript` document, and reading the result back. The
   command runs as root, and everything in it that touches the checkout runs as `ubuntu`. It fetches,
   reads `deploy/compose/release.sh` out of the commit being released, and runs it. The full log is
   kept on the box as `~ubuntu/deploys/<stamp>-<sha>.log`; the job prints its last 20,000 characters.
3. **It checks `/readyz`, `/readyz/audit` and `/` from outside**, through Caddy, so the whole chain
   is proven: the API's readiness, the audit service's, and the page. The two readiness checks
   require `{"ok":true}` in the body, because an unrouted path still answers 200 from the UI.

`release.sh <sha>` works in this order:

- It refuses a commit that is not on `origin/develop`, a checkout that is not on `develop`, and a
  checkout with local edits.
- **If the box is already at a newer commit that contains `<sha>`, it does nothing.** A later deploy
  won the race, and it is never rolled back.
- It runs `backup.sh`: a dump to S3, taken before any migration, and the way back from a bad one.
- It fast-forwards and runs `deploy.sh`.
- It fails unless both `https://<domain>/readyz` and `https://<domain>/readyz/audit` answer within
  two minutes. The first covers the API's database and every migration in its journal; the second
  the audit service's migrations and a drain pass in the last 30 s. On a failure it prints the logs
  of `migrate`, `audit-migrate`, `api` and `audit`.
- It prunes build cache older than a week.

A failure after the fast-forward is left for a person, the same as production's `--wait` without
`--atomic` (§3): a migration that has committed is not undone by putting the previous image back.
Read the log on the box and `docker compose … logs migrate audit-migrate api audit`, then fix
forward with a new commit.

**Concurrency.** The workflow's group is `deploy-box` with `cancel-in-progress: false`, so a
deploy is never cancelled halfway. A commit that goes green while one is running waits. If a third
arrives, the waiting one is dropped in its favour.

**What was provisioned for it** (2026-09-14, by hand, like §16.2):

- `AmazonSSMManagedInstanceCore` attached to the `rch-box` role. The instance's snap
  `amazon-ssm-agent` was already running.
- The IAM role `rch-github-box-deploy`.
- Repository variables `BOX_INSTANCE_ID` and `BOX_DEPLOY_ROLE_ARN`, and `BOX_DEPLOY_ENABLED=true`.
- A deployment branch policy on the `dev` environment: `develop` only.

**Stopping it.** Set `BOX_DEPLOY_ENABLED` to `false`
(`gh variable set BOX_DEPLOY_ENABLED --body false`). The job is then skipped; nothing else
changes.

**A deploy by hand**, if GitHub itself is down:

```bash
ssh -i ~/.ssh/rch-box.pem ubuntu@rch.hashtrickstechnologies.com
cd /opt/rch/app && git fetch origin && deploy/compose/release.sh <sha>
```

This uses the same script as the automatic deploy, so it has the same guards. Run it only while no
Deploy (box) run is in progress.

### 16.7 Reading the audit log from the box

The audit log is the super admin's screen (`/admin`, Audit log). Read it there first. These queries
are for when the screen is not reachable, or when you need a count the screen does not show.

Connect as `rch`, the only role that can read everything:

```bash
ssh -i ~/.ssh/rch-box.pem ubuntu@rch.hashtrickstechnologies.com
cd /opt/rch/app/deploy/compose
docker compose exec -T postgres psql -U rch -d rch
```

The fifty most recent events:

```sql
select id, at at time zone 'Asia/Kolkata' as ist, actor_emp, actor_name, action, target, outcome, message
from audit.events order by id desc limit 50;
```

Everything one person did on one IST day:

```sql
select at at time zone 'Asia/Kolkata' as ist, action, target, outcome, message
from audit.events
where actor_emp = 'RC-3120'
  and at >= timestamptz '2026-09-15 00:00+05:30' and at < timestamptz '2026-09-16 00:00+05:30'
order by id;
```

**Is the drainer keeping up?** The outbox should be empty or nearly so:

```sql
select count(*) as queued, coalesce(extract(epoch from now() - min(at))::int, 0) as oldest_seconds
from audit_outbox;
```

A queue that grows, or an oldest row older than a minute, means the audit container is down or
cannot reach the database - the same thing `AuditDrainLagging` alerts on in the chart. Check it with
`curl -s -o /dev/null -w '%{http_code}\n' https://rch.hashtrickstechnologies.com/readyz/audit` and
`docker compose logs --tail 50 audit`.

**Events the service could not store** are set aside rather than dropped, and `AuditDeadLetters`
alerts on any new one:

```sql
select id, at, issue, event from audit.dead_letters order by id desc limit 20;
```

Each row keeps the event as it arrived and the reason it was refused. They are a bug report, not
routine: read the reason, fix the cause, and leave the row where it is.

**Nothing edits this schema.** `audit.events` and `audit.dead_letters` refuse UPDATE, DELETE and
TRUNCATE by trigger, for every role including `rch`. A mistake is corrected by the document the
event describes, never by rewriting history.

### 16.8 Item photos bucket

**Bucket** `rch-images-830283280199`, `ap-south-1`, account `830283280199` - the same account and
region as everything else in this section. Block Public Access on (all four settings), default
encryption SSE-S3, bucket owner enforced. Versioning **on**, with a lifecycle rule
`expire-old-photos`: noncurrent versions expire after 90 days, incomplete multipart uploads abort
after 1 day. Tagged `project=rch`. Versioning is this bucket's own backup - there is no nightly
dump of it, unlike the database (§16.2 above).

**IAM.** The instance role `rch-box` (§16.2) carries a second inline policy, `rch-images`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Photos", "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::rch-images-830283280199/items/*" },
    { "Sid": "MissingKeyIs404", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::rch-images-830283280199", "Condition": { "StringLike": { "s3:prefix": ["items/*"] } } }
  ]
}
```

The `ListBucket` statement is not decorative: without it, S3 answers a `GetObject` on a missing
key with `AccessDenied` rather than `NoSuchKey`, and `apps/api/src/lib/images.ts`'s S3 driver
could not tell "the object is gone" from "the credentials are wrong" - it would rethrow instead of
answering `null`, and every stale hash would 500 instead of 404. Credentials come from IMDSv2, the
same instance metadata service every other AWS call on this box uses; there is no access key
anywhere. Nothing in this policy reaches outside `items/*` in this one bucket.

**Configuration.** `IMAGE_BUCKET=rch-images-830283280199` in
`/opt/rch/app/deploy/compose/.env`, alongside `IMAGE_STORE: s3` and `AWS_REGION: ap-south-1` in
`compose.yml`'s `api_env` (`deploy/compose/.env.example` documents the one line an operator
fills in). On the Helm path the same three keys are `api.env` in `deploy/chart/rch/values.yaml`,
with `IMAGE_BUCKET` FILLed per environment in `values-<env>.yaml` - not provisioned today, since
EKS is not live (§16 above).

**Recovering a photo an upload replaced.** A photo is content-addressed and versioned, so nothing
is ever truly gone until the 90-day lifecycle rule catches it. Find the noncurrent version and
copy it back over the current object:

```bash
aws s3api list-object-versions --bucket rch-images-830283280199 --prefix items/<key>/
aws s3api copy-object --copy-source "rch-images-830283280199/items/<key>/<hash>?versionId=<id>" \
  --bucket rch-images-830283280199 --key items/<key>/<hash>
```

then set that item's `image` column back to `<hash>` (`update items set image = '<hash>' where
key = '<key>';`) - `GET /items/:it/image/:hash` serves only the hash the row currently points at,
so the row and the object have to agree. **The database dump holds only the hash; the bucket holds
the bytes** - restoring `items` from a `pg_dump` (§6) never needs this, but replacing the wrong
photo by mistake does.

---

## 17. Migration 0023 refused: patient balances still on the books

Migration `0023_drop_patient_payer` removes `patient` as a kind of payer. It deletes the patient
rows from the rate card and the payer register, then rebuilds the `payer_kind` type without the
value - which Postgres can only do once no row anywhere still says `patient`. A payer with a bill
against them is somebody's balance, and **no migration is allowed to delete a bill or re-file it
under a different payer**, so where one is still open the whole migration refuses:

```
Refused - N patient bill(s), settlement(s) or payer(s) are still on the books; settle or void
them before removing the patient category (deploy/RUNBOOK.md 17)
```

The migration runs in one transaction, so a refusal changes nothing: the database is exactly as
it was and the previous release keeps serving (`deploy.sh` never brings the new API up until
`migrate` has exited 0).

**Check before promoting**, against the environment you are about to deploy to:

```sql
select no, payer_id, tender, at, voided_at from bills where payer_kind = 'patient' or tender = 'Patient bill';
select id, payer_id, amount, voided_at from settlements where kind = 'patient';
select id, name, active from payers where kind = 'patient';
```

Three of those outcomes and what each means:

- **All three empty.** Nothing to do - the migration will run clean.
- **Only `payers` has rows.** Also nothing to do: the migration deletes a patient payer that no
  bill and no settlement points at, which is the ordinary case on a hospital that never billed
  one.
- **`bills` or `settlements` has rows.** A decision, not a cleanup. Read what they are first.
  A real balance is settled the ordinary way, from the manager's Credit screen, *before* the
  promotion - settling does not delete the bill, so the guard still refuses afterwards and the
  rows have to go either way. Where they are test data nobody reconciles against anything (the
  usual case on the dev box), delete them deliberately, as the operator, with the database backed
  up first (§2's `backup.sh` runs on every deploy; take one by hand if you are doing this out of
  band):

  ```sql
  begin;
  delete from settlement_lines where settlement_id in (select id from settlements where kind = 'patient');
  delete from settlements where kind = 'patient';
  delete from bill_lines where bill_no in (select no from bills where payer_kind = 'patient' or tender = 'Patient bill');
  delete from bills where payer_kind = 'patient' or tender = 'Patient bill';
  -- read the counts back, then commit or roll back
  commit;
  ```

  Connect as `rch` through `MIGRATE_DATABASE_URL` (§5, *The database roles*); `rch_app` has the
  grants to do this and must not be used for it. Then re-run the deploy from the Actions tab -
  never by hand on the box (§16.6).

**A local database refuses the same way.** A laptop that ran `pnpm --filter @rch/api db:seed`
before this release has the demo hospital's four patients and the one bill posted to one of them,
so `db:migrate` refuses there too. Nothing on a demo database is anybody's balance: run the block
above against `rch` on port 5439, or drop and recreate the database and seed it again.

**The stock ledger is untouched either way.** A bill's `stock_moves` are separate rows that name
no payer, so deleting a patient bill leaves the shelf figures exactly as they are. That is a
reason to prefer the delete over any attempt to re-file the bill, not a reason to be casual about
it: `stock_moves` is append-only, so a deleted bill's movements stay on the ledger with nothing
left to explain them. Say in the handover that you did it.

## 18. Migration 0026: configurable roles, and who takes the Z

Migration `0026_roles` turns the five fixed roles into data. It creates `roles` (`ROLE-00n`: a name,
the **desk** its holders work at - the old `counter|manager|store|prod|buyer` - and its permissions as
JSON), seeds `ROLE-001`…`ROLE-005` (Counter Operator, Outlet Manager, Store Keeper, Kitchen In-charge,
Procurement Officer) with exactly what each desk could reach before, adds `users.role_id` and puts every
account but the super admin onto its desk's seeded role. `users.role_label` is rewritten to the role's
name at the same time, which is what it already said. Two constraints then hold it:
`users_role_id_ck` (only the super admin may have no role) and `users_role_desk_fk` (`(role_id, role)`
must match a role's `(id, desk)`, so an account's desk is always its role's). It runs in one
transaction and needs nothing checked beforehand: every non-admin account has a desk, and every desk
has a seeded role.

The new `role` id series (`ROLE-006` onward) is inserted by `ensureSequences`, which runs at the end
of every `db:migrate` (`src/db/migrate.ts`), so a deploy needs no seed step for it. The `rch_app`
grants are re-issued on every migrate (§5, *The database roles*), which covers the new table.

**When this release is up.** On the live box that is the moment the commit lands on `develop`: a green CI
run on a push to `develop` deploys it through `deploy-box.yml` (§16.6) with nobody pressing anything, so
the Z change below is not waiting for a later promotion to `staging` or `production`. Tell the outlets
*before* the merge, not before a promotion.

**During the deploy itself, don't edit accounts.** For the few seconds between the migration committing
and the new API container answering, the old API is still serving against the new schema. It knows
nothing of `users.role_id`, so creating an account on `/admin` in that window breaks
`users_role_id_ck` and answers a 500, and a role or location change can do the same. Nothing is
half-written - the transaction rolls back - but hold account edits until `/readyz` is answering from
the new release, then make them again.

**What changes for the operators, the moment this release is up:**

- **The seeded Counter Operator and Outlet Manager no longer take the Z.** No seeded role holds
  *Z reports*. Both still see the live X on their Register screen, but not the past Z list and not
  Close register & take Z - a direct request is a 404. Closing an outlet's day is the super admin's:
  **Admin → Registers**, pick the outlet, **Close register & take Z**. To hand it back, the super
  admin gives a role *Z reports* in **Admin → Roles** - at View for the Z list, at Edit to take one -
  and every holder of that role gets it on their next request. Tell the outlets before the merge to
  `develop` (above), or the first evening after it nobody at a counter can close the day.
- Everything else each desk could do, it still does: the parity tests pin every route and every
  sidebar of the five seeded roles to what the desks had before (`permissions.test.ts`,
  `nav-parity.test.ts`, `scope.test.ts`).
- A deactivated account is refused on its very next request (a 401, and the browser signs it out),
  not when its access token runs out.
- Sessions signed in across the deploy keep working. Permissions are not in the token: the API reads
  them per request, through a per-pod cache (60 s at most) that any role or account change clears.

**If a role has been locked out.** A role edited down to nothing leaves its holders with the
dashboard, the support desk and their settings - every other screen gone and every other route a 404
- from their next request. Nothing is lost; nothing about the stock or the bills changed. Recover in
this order:

1. **Put the permissions back from `/admin`.** Sign in as the super admin, **Admin → Roles**, open
   the role, set the features back, **Save**. A seeded role's originals are `DESK_DEFAULTS` in
   `@rch/domain` (the same literal is in `apps/api/drizzle/0026_roles.sql`), and a new role on the
   same desk starts from them - the Roles tab's create card is a quick way to see them. The holders get it on their next click; a page that
   already refused them needs a reload. This is audited like every other write - prefer it.
2. **Or move the accounts.** **Admin → Accounts**, give each account a working role on the same
   desk. A move within the desk and the home location keeps the account's sessions and postings.
3. **A role cannot be switched off while an active account holds it**, and the refusal names them -
   so "every holder lost their role" is not a state the admin page can reach. An account whose role
   was switched off after it was deactivated cannot be reactivated until the role is switched back on
   (**Admin → Roles → Reactivate**) or the account is given another role.
4. **The super admin itself is never locked out by a role**: it holds none, and is checked by its
   own flag. If the super admin cannot sign in, that is §5 (`users reset-password`, `users
   set-admin`), not this section.
5. **Only if the admin page itself is unusable**, as `rch` through `MIGRATE_DATABASE_URL`, restore a
   seeded role's permissions from the migration's literal and restart the API so no pod serves a
   cached copy for the remaining 60 s:

   ```sql
   -- copy the perms literal for the role from apps/api/drizzle/0026_roles.sql
   update roles set perms = '<perms JSON>'::jsonb, version = version + 1, updated_at = now()
    where id = 'ROLE-002';
   ```

   This bypasses the audit log - the one write here nobody will find on the Audit log tab - so say in
   the handover that you did it, and why the admin page could not.

## 19. QR ordering and online payments

A customer scans a QR code placed at an outlet ("Table 4", "Ward 3B waiting area"), orders from
their phone at `/order/…`, and pays online through Razorpay (UPI and cards). The moment the payment
is captured the API makes an ordinary bill at that outlet - stock moves, GST, the outlet's open
register session - with the tender **Online**, and the counter prepares and hands over the order.

Nothing here is on until the three Razorpay keys are set. Without them the order page still shows
the menu, and placing an order answers 503 "Online ordering is not set up yet - order at the
counter." Everything else in the system is unaffected.

### 19.1 What the release adds

**Migration `0027_qr_orders`** creates `qr_codes`, `outlet_order_hours`, `qr_outlet_state`,
`qr_orders`, `qr_order_lines`, `payment_refunds` and `rzp_webhook_events`; adds `bills.source`
(`till|qr`) and `bills.qr_order_id`; adds `users.system` and relaxes `users_role_id_ck` to
*admin, or system, or has a role*. It gives the new feature **QR orders** to the seeded
**Counter Operator** role at Edit and the **Outlet Manager** at View, so the counters see the QR
orders screen from the moment the release is up. A role you created yourself on `/admin` gets it
only when the super admin adds it (**Admin → Roles**). The two new id series (`QO-<year>-<nnnn>`
for orders, `QR-nnn` for codes) are inserted by `ensureSequences` at the end of `db:migrate`, like
every other series (§18), so no seed step is needed.

**The system account "QR Orders"** (user id `sys-qr`, `SYS-QR` where an employee number is shown)
raises every QR bill. It is created the first time an
order is placed, with `system = true` and a password hash no password can match. It never signs in
(sign-in refuses it), never opens a shift - so QR bills are on no Close Shift slip - and is hidden
from the sign-in directory, the Accounts tab, the users CLI and the outlet-close staff count. Do not
try to deactivate, delete or reset it; the admin page and the CLI cannot see it on purpose. On the
Audit log its writes (an order placed, a paid order, a refund sent, processed or failed) carry it as the actor.

**Configuration.** Three secrets and three tunables, all optional:

| Variable | Default | What it is |
|---|---|---|
| `RAZORPAY_KEY_ID` | - | The API key id (`rzp_test_…` or `rzp_live_…`). Public: the order page hands it to Checkout. |
| `RAZORPAY_KEY_SECRET` | - | The API key secret. Signs server calls and verifies the checkout signature. |
| `RAZORPAY_WEBHOOK_SECRET` | - | The secret you type into the webhook in the Razorpay dashboard. Verifies every webhook. |
| `QR_ORDER_MAX_RUPEES` | `5000` | The most one QR order may come to. |
| `QR_ORDER_TTL_MIN` | `30` | Minutes an unpaid order waits for its payment before it expires. |
| `QR_WORKER_INTERVAL_MS` | `30000` | How often the QR worker expires unpaid orders and sends queued refunds. `0` stops it - refunds then sit in Pending. Only the tests do that. |

On the box they go in `/opt/rch/app/deploy/compose/.env` (`deploy/compose/.env.example` lists them);
on the Helm path the three keys go in the Secret (`secrets.values`, or the `rch/prod` remote JSON)
and a tunable, if changed, in `api.env`. The UI's nginx serves `/order/` with its own CSP, which
admits Razorpay Checkout (`deploy/nginx/snippets/order-security-headers.conf`); every staff screen
keeps the strict one.

### 19.2 Test keys first

1. Sign in to the Razorpay dashboard and switch to **Test Mode** (the toggle at the top).
2. **Account & Settings → API Keys → Generate Test Key.** Copy the key id and the secret - the secret
   is shown once. Lost, it is regenerated, and the old one stops working at once.
3. **Account & Settings → Webhooks → Add New Webhook**, still in Test Mode:
   - **Webhook URL:** `https://<host>/api/v1/public/razorpay/webhook` - on the box,
     `https://rch.hashtrickstechnologies.com/api/v1/public/razorpay/webhook`. Caddy's `/api/*` route
     already reaches the API with it, and the K8s ingress sends `/api` to the API the same way.
   - **Secret:** a long random string of your own (`openssl rand -hex 32`). This is
     `RAZORPAY_WEBHOOK_SECRET`. It is not the key secret.
   - **Active events:** `payment.captured`, `order.paid`, `refund.processed`, `refund.failed`.
     Nothing else - the API acknowledges an event it does not use and does nothing with it.
4. Put the three values on the box, then redeploy (§19.3).
5. Prove it end to end: print a code's poster (§19.4), scan it, order one item, pay with Razorpay's
   test UPI id `success@razorpay` or a test card, and check the order reaches the counter's QR
   orders screen as **Paid**, the bill carries **Online**, and **Admin → Audit log** shows the paid
   order. In the dashboard, **Webhooks → the webhook → Deliveries** should show 2xx for each event.
   The API answers a delivery **200** (an event it does not use and a repeated delivery included),
   **401** when the signature does not match - a wrong `RAZORPAY_WEBHOOK_SECRET`, most likely -
   **400** for a body that is not JSON, and **503** while the three keys are not set. It answers a
   5xx otherwise only when its database fails, which is the one case Razorpay should redeliver.

**Locally**, the same test keys go in `.env`. Razorpay cannot reach `localhost`, so no webhook
arrives; the browser's own verify call settles the payment on its own, which is enough to work on
everything but a refund's final status. A tunnel (`cloudflared`, `ngrok`) to the API is the way to
receive webhooks locally, with a separate test-mode webhook pointing at it.

### 19.3 Setting the keys on the box

The box deploys itself (§16.6) - don't run `deploy.sh` or `docker compose up` by hand to pick up a
changed `.env`.

```bash
ssh -i ~/.ssh/rch-box.pem ubuntu@rch.hashtrickstechnologies.com
cd /opt/rch/app/deploy/compose
cp .env .env.bak.$(date +%Y%m%d)      # .env is gitignored; this is its only copy besides the backup
nano .env                             # fill RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
chmod 600 .env
```

Then, from GitHub: **Actions → Deploy (box) → Run workflow**, commit left blank (the tip of
`develop`). `release.sh` on a commit the box already runs does not skip: it backs up, runs
`deploy.sh`, and compose recreates `api` because its environment changed. The job's readiness
checks prove it came back. Placing a test order is the proof the keys are right - a wrong key id or
secret fails at **Pay**, not at start-up.

Set all three together. Two of three is the same as none: ordering stays 503.

### 19.4 Printing QR posters

The super admin makes the codes: **Admin → QR codes**, pick the outlet, set its ordering hours (one
window per weekday, IST; a day with no window is closed), then add a code per spot, *pickup* or
*deliver to this spot*. **Download poster** makes an A5 PDF.

**The link in the poster is built from the address the admin's browser is on.** Print posters only
while signed in at the live domain (`https://rch.hashtrickstechnologies.com/admin`). A poster printed
from a laptop on `localhost`, a staging host or a raw IP points customers at that address, and
nobody will notice until a customer scans it.

**Regenerate** makes a new token for the code and the old printed poster stops working at once (the
page says "This QR code is no longer in use - please order at the counter."). Do it when a poster is
lost or copied somewhere it should not be, and replace the poster the same day. Deactivating a code
does the same without a new poster: its poster gets the same sentence as a regenerated or unknown
one, and switching it back on brings the same poster back to life.

The counter's **Pause** switch on its QR orders screen stops new orders at that outlet only, without
touching the hours; it is the counter's to use when the kitchen is swamped or an item run is out.

### 19.5 Refunds

A refund is queued, never sent inside a sale or a void, in three cases:

- **Unfulfillable** - the payment was captured but the order could not be billed when it was
  settled (an item sold out or switched off, the outlet closed, a price changed, the amount did not
  match). A counter's **Pause** is not one of them: it stops new orders, and an order already placed
  and paid is still billed. No bill is made, the order is **Refunded**, and the whole payment goes back.
- **Void** - the manager voided an Online bill (*Void a bill*, same IST day, register still open, as
  for any bill). The bill is badged voided as always, the order becomes **Voided**, and the full
  amount is queued.
- **Duplicate** - a second payment captured against an order that already had one.

The QR worker sends Pending refunds every pass. Before each send it asks Razorpay for the refunds
already on that payment, matched by an id it wrote into the refund's notes, so a retry after a
timeout never refunds twice. A refund goes **Pending → Sent** when Razorpay accepts it and
**→ Processed** when Razorpay's `refund.processed` webhook arrives (a test key often answers
processed at once, and the worker records both steps then). The worker also runs straight after a
void or a capture queues a refund, so a refund does not wait out the interval. A failed send is retried after 1 min, 5 min, 15 min, 1 h and
6 h; after the sixth failure it is **Failed** and the worker stops trying.

**A Failed refund** means Razorpay refused or never accepted it - most often the merchant balance
could not cover it, the payment is too old to refund, or the keys changed. The customer has *not*
had their money back. The bill drawer shows a red refund pill on that bill. To retry:

1. Read the reason on the pill (Razorpay's last answer, stored on the refund), and fix what it names - top up the
   balance in the dashboard, or put back the keys that made the payment.
2. The manager (anyone holding *Void a bill*) opens the bill and presses **Retry** beside the pill
   (`POST /qr-refunds/:id/retry`). That puts it back to Pending with a fresh set of attempts; the
   next worker pass sends it.
3. If it fails again, refund it by hand in the dashboard (below), and write down the bill number and
   the Razorpay refund id in the handover - the refund row stays Failed in RCH.

A `refund.failed` webhook for a refund already Sent moves it to Failed the same way.

**Refunding a bill from an earlier day.** A void is only allowed on the IST day of the bill, while
its register session is open, so RCH cannot refund a QR bill once its day has closed. Do it in
the dashboard: **Transactions → Payments**, search the payment id (the QR order carries it, and the
bill's receipt shows the order number), **Issue Refund**, full or partial, with the bill number in
the notes. The bill stays a sale in RCH, and that day's Z does not change - a closed Z never does.
Record it in the handover and in the next reconciliation (§19.6) as a refund outside RCH.

### 19.6 Reconciling against the Z

The Z report carries **Online** as its own tender: the gross of every QR bill in that register
session, less voided ones. Sessions run Z-to-Z, not midnight to midnight, so match on the Z's
opening and closing times, not on a calendar day.

Razorpay settles to the bank about two working days after capture, as one amount net of its fee and
the GST on the fee, less refunds processed in the window. Reconcile from **Reports → Settlement
recon** (or the settlement's own breakup) against each Z:

- Every captured payment in the window should be a QR bill in some Z's Online total - except those
  refunded as **unfulfillable** or **duplicate**, which never became bills and appear in Razorpay as
  a payment and its matching refund.
- A **voided** Online bill is in the Z's voids, and its refund is in Razorpay.
- A refund done **by hand** for an earlier day (§19.5) is in Razorpay and in no Z.
- What is left over is the fee and its GST, which Razorpay shows per payment.

A captured payment with no bill and no refund is a settlement that did not happen - most likely
both the browser's verify and the webhook failed. Check **Webhooks → Deliveries** for failed
deliveries and redeliver them (the API drops any event id it has already seen, so a redelivery is
safe), then look for the order on the counter's QR orders screen.

### 19.7 Going live

1. The Razorpay account must be activated (KYC done) before live keys exist.
2. Switch the dashboard to **Live Mode**, generate live API keys, and create a **new** webhook there -
   test-mode and live-mode webhooks are separate, with their own secret. Same URL and events as
   §19.2, a new secret.
3. Replace all three values in the box's `.env` (§19.3) and redeploy through the workflow.
4. Place one real, small order and void it the same day: that proves capture, the bill, the void and
   a real refund arriving at `Processed`.
5. Orders already paid in test mode stay test orders; a test-mode refund still queued after the
   switch fails against the live keys. Let the test-mode queue drain before switching.

Posters do not change: the codes are RCH's, not Razorpay's.
