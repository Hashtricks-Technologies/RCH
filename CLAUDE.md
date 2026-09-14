# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Royal Care Hospital's F&B inventory and billing system. It runs one item master and one stock ledger behind a
central store, a central kitchen and three retail outlets (Restaurant, Coffee Shop, Snack Kiosk) the hospital
opened with - the super admin opens, edits, closes and reopens outlets from `/admin` as the hospital grows - and
covers purchase requisition → purchase order → goods receipt → production → issue → counter sale.

It is a pnpm + Turborepo monorepo (Node 24, pnpm 10.28.2):

| Package | What it is |
|---|---|
| `packages/contract` (`@rch/contract`) | Zod wire schemas, the one route manifest, the demo-hospital fixtures |
| `packages/domain` (`@rch/domain`) | The business rules as pure functions, shared by server and browser |
| `apps/api` (`@rch/api`) | Fastify 5 + Drizzle on PostgreSQL 17; owns the ledger, document numbers, reservations, change stream and the audit outbox |
| `apps/audit` (`@rch/audit`) | Fastify 5 on PostgreSQL 17; drains the API's audit outbox into its own append-only `audit` schema and serves the audit log |
| `UI` (`@rch/ui`) | React 19 + Vite 8 + Zustand 5; an API client end to end |
| `deploy/` | Helm chart (EKS), Docker Compose (single EC2 box), nginx, and `RUNBOOK.md` for every operational procedure |

Dependencies flow one way only: **contract → domain → api / UI**, and **contract → audit**. Nothing points back.
`apps/api`, `apps/audit` and `UI` never import one another, and `apps/audit` imports nothing from the workspace
but `@rch/contract`. Screens go through the store (`useApp`), never through `api/client` directly. The oxlint
import rules in `.oxlintrc.json` enforce all of this.

Each package has its own `CLAUDE.md` for what is specific to it. Claude Code reads it when working in that
directory. This file holds the repo-wide rules.

## Commands

From the repo root:

```bash
pnpm install
pnpm db:up                      # postgres:17 in Docker, host port 5439 (pnpm db:down to stop)
cp .env.example .env && pnpm --filter @rch/api keys:generate >> .env
                                # then set SEED_PASSWORD: required, ≥ 12 chars, no default - nothing starts without it
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/audit db:migrate   # the audit schema; run after the API's, whose audit_outbox it waits for
pnpm --filter @rch/api db:seed  # demo hospital; --bare = six locations + RC-0001 admin only; --force re-seeds
pnpm dev                        # API on :3000, audit service on :3100, UI on :5173 (Vite proxies /api)
                                 # IMAGE_STORE defaults to disk (apps/api/.data/images) locally; set it to s3
                                 # with IMAGE_BUCKET and AWS_REGION to test against a real bucket

pnpm build
pnpm typecheck
pnpm lint                       # oxlint per package + knip (unused exports/files/deps) + scripts/check-boundaries.sh
pnpm test                       # every package; apps/api and apps/audit need Postgres reachable
pnpm helm:test                  # render the chart and check it
pnpm compose:test               # check the Compose deployment files
```

To run one file or one case without the package's coverage gate:

```bash
pnpm --filter @rch/ui exec vitest run src/__tests__/writes.test.ts
pnpm --filter @rch/api exec vitest run src/modules/tickets/tickets.test.ts -t "handover"
pnpm --filter @rch/audit exec vitest run src/modules/audit/audit.test.ts
```

`.env.example` already names the audit service's connection, `AUDIT_DATABASE_URL`. Locally it, `DATABASE_URL` and
the unset `MIGRATE_DATABASE_URL` all name the one `rch` user, so neither migrate step creates a database role
(`deploy/RUNBOOK.md` §5, *The database roles*).

Demo accounts (password is `SEED_PASSWORD`): `RC-4471` counter (Coffee Shop), `RC-4482` counter (Snack Kiosk),
`RC-3120` manager, `RC-2088` store keeper, `RC-1902` kitchen, `RC-1550` buyer, and `RC-0001` admin. The admin is
the only account a `--bare` seed creates. If port 3000 is taken, run the API with `PORT=3001`.

## CI and the gates that fail it

`.github/workflows/ci.yml` runs on Node 24:

1. `pnpm install --frozen-lockfile`
2. `pnpm turbo typecheck test`
3. `pnpm lint`
4. `pnpm check:boundaries`
5. `pnpm audit`
6. the UI build
7. It builds all three images (`rch-api`, `rch-ui`, `rch-audit`), scans them with Trivy at `CRITICAL,HIGH`,
   and does a real `helm install` into a throwaway kind cluster. That install signs in and then finds the
   sign-in in the audit log, which proves the outbox, the drainer and the read route on a real cluster.
8. A separate job (Deploy files) renders the chart, parses `deploy/compose/compose.yml`, and runs
   `shellcheck` on `deploy/compose/*.sh` and `actionlint` on the workflows.

Every change must pass all of it. Four things trip people up:

- **Lint is zero-warning.** Every package's `lint` is `oxlint --max-warnings 0`, so a warning fails the job
  just like an error does.
- **Coverage floors are part of `test`.** The floors are UI lines 79 / branches 60, `apps/api` 94 / 80,
  `apps/audit` 90 / 75, `packages/domain` 99 / 93, and `packages/contract` lines 96. Raise a floor when the real figure rises. Never
  lower one to turn a run green. The `--coverage` flag lives on each `test` script, which is why a single-file
  run isn't judged against the floor.
- **`test` is uncached in `turbo.json`.** Turbo hashes source files, not the database, so a cache hit could
  replay a pass from before a migration.
- **`pnpm audit` fails closed** if the registry is unreachable on all three attempts. Accepted CVEs go in
  `.trivyignore.yaml` with a `statement` and a real `expired_at`. An expiry that lapses fails every scan, so
  check the expiries before a promotion.

## Branches and environments

- `develop` is the default branch, and all work lands there.
- `staging` and `production` are promoted by fast-forward only:
  `git checkout staging && git merge --ff-only develop && git push`, then the same from `staging` into
  `production`.
- A hotfix branches from `production` and is merged back into `staging` and `develop`.
- Both deploy workflows are `workflow_run` on CI's success. GitHub always runs them from the copy on the
  **default branch**, so an edit to one takes effect the moment it lands on `develop`. Values in them come from
  `github.event.workflow_run.head_sha` and `head_branch`, not `github.sha`.
- **`develop` deploys itself.** The live dev environment (https://rch.hashtrickstechnologies.com) is one EC2
  box under Docker Compose. When CI goes green on a push to `develop`, `.github/workflows/deploy-box.yml`
  runs `deploy/compose/release.sh <sha>` on the box through SSM. That backs the database up to S3,
  fast-forwards, runs `deploy.sh` and fails unless both `/readyz` (the API: its database and migrations) and
  `/readyz/audit` (the audit service: its migrations and a recent drain pass) answer. It never rolls the box
  back past a newer commit. Don't deploy by hand as well; to redeploy or retry, run the workflow from the Actions tab.
  Setting the repository variable `BOX_DEPLOY_ENABLED` to anything but `true` stops it (`deploy/RUNBOOK.md`
  §16.6). The box was seeded bare and holds real data. **Never run a demo seed against it.**
- `.github/workflows/deploy.yml` is the EKS path for `staging` and `production`. `DEPLOY_ENABLED` is `false`:
  the EKS environment was torn down, and neither is provisioned.

## Architecture

### One manifest drives both sides

`packages/contract/src/routes.ts` declares every route with `defineRoute({ method, path, access, service?,
body?, response, … })`.

- **Server:** `apps/api/src/routes.ts`'s `mount()` registers each `service: "api"` route (the default) with its
  schemas, auth, role gate and idempotency preHandler. `apps/audit/src/routes.ts`'s `mount()` registers the
  `service: "audit"` routes. Each `mount()` throws on a route tagged for the other service.
- **Browser:** `UI/src/api/client.ts`'s `call(route, input)` builds the URL, mints the `Idempotency-Key`, and
  refreshes the token once on a 401. It doesn't know which service answers: Vite, Caddy, the UI's nginx and the
  ingress each send `/api/v1/admin/audit` to the audit service, ahead of `/api`.

There are no hand-written fetch wrappers. A new endpoint is one manifest entry plus a handler, landed in the
same commit.

### A write, end to end

1. A UI store action calls `call(routes.x, …)`.
2. The route handler parses the input and hands it to the service.
3. The service runs inside `withTransaction`. It locks, applies the rules from `@rch/domain`, posts moves,
   appends history, and calls `emitChanged` (a `pg_notify`, held until commit). Before COMMIT,
   `withTransaction` records the idempotency outcome and inserts the write's audit event into `audit_outbox`.
4. The route replies `{ result, changed, message }`. `message` is the operator's sentence; the UI toasts it
   verbatim and never writes its own success text.
5. The UI's `refetch(changed)` pulls back only those collections, each through a narrow `GET`.
6. Every other open browser receives the same `changed` over `GET /events` (SSE) and refetches too.

A refusal is an error envelope whose `message` is the sentence toasted. Any cart or form is left exactly as it
was. Its audit event is written after the reply, since the write's own transaction rolled back.

### Roles and scope

There are five roles (`counter`, `manager`, `store`, `prod`, `buyer`), each with its own sidebar.

- **Unknown route:** a role without a module gets a **404**, the same as a screen that doesn't exist for it.
- **Wrong location:** a caller outside the location a document belongs to gets a **403**.
- **`manager`** is hospital-wide, so its writes never scope to a location.
- **`counter` and `prod`** are location-scoped. `store` and `buyer` each work one desk.
- **Admin** is a boolean on `users`, not a sixth role. It is checked as `access: "admin"`. An admin-flagged
  account sees only the standalone `/admin` page, never an operational shell. The page has four tabs: Accounts
  (staff accounts), Outlets (opens, edits, closes and reopens them), Support desk (every role's support
  tickets) and Audit log (every write and sign-in). The flag can only be set with
  `pnpm --filter @rch/api users set-admin`; no route can set it.
- **The super admin has no role in practice.** The `users` row still carries a placeholder role and location,
  but the wire labels it `Super Admin`, the account page offers no role or location for it, and `rbac.ts`
  answers an admin token with a **404** on every route that is not `access: "admin"` or a must-change-password
  route (sign-in, password, `/me`). `GET /events` opts back in with `admitAdmin`, for the support desk and the
  audit log's new-events count. The audit service gives a token without `admin` the same **404**.
- **Staff pick themselves at sign-in.** `GET /auth/directory` is public and lists active, non-admin accounts
  as number and name only. The super admin signs in through a typed id instead.
- **`counter` sets a product photo only for items on its own outlet's menu** (403 otherwise); `manager` sets
  any item's.

### The movement rule

**Approval authorises; the scan moves.**

1. Approving a request, or dispatching a production order, only writes a reservation.
2. On `handover`, stock leaves its location. The collector must quote the ticket's six-digit OTP; five wrong
   codes lock the ticket.
3. On `receive`, the stock lands.

In between, the stock is in transit and belongs to neither location. Any new movement must keep this two-step
shape. A ticket nobody collected can be cancelled, which releases its hold and puts the document behind it
back where it stood.

### Server-side guarantees

- `stock_moves` is append-only; a database trigger refuses UPDATE and DELETE. `postMoves()` in
  `apps/api/src/lib/ledger.ts` is the only writer of `stock_moves` and `stock_balances`, and
  `lib/reservations.ts` is the only writer of `reservations`. `scripts/check-boundaries.sh` enforces this by
  grep.
- **Lock order is documents → ids → balances**, server-wide. There are exactly two deliberate exceptions: the
  counter sale's bill number and the adjustment's `ADJ-` number are allocated after the balance locks. Don't
  copy either one; `apps/api/CLAUDE.md` explains why each is safe. A write naming a location takes its row `FOR
  SHARE` through `lockLocation` in `apps/api/src/lib/locations.ts`, in the documents tier; a close takes it `FOR
  UPDATE`.
- Status changes go through the tables in `packages/domain/src/transitions.ts`. The server refuses with them,
  and the UI reads the same tables to decide which buttons to draw.
- Every non-public write carries an `Idempotency-Key`. The outcome is recorded inside the write's own
  transaction, so a retry replays the answer instead of producing a second bill.
- **A price list is a managed entity** (`price_lists`, id + name), not a fixed pair. A manager creates one
  cloned from an outlet's current active list, edits any list at any time whether or not it is active, and
  switches an outlet onto any list explicitly (`PUT /outlets/:loc/price-list`). Two outlets may still share one
  active list, exactly as before. A list can be deleted only once no outlet is active on it. A newly opened
  outlet is on none: the super admin's form has no price list, and the manager attaches one from Prices.
- `lib/images.ts` is the only code that touches photo bytes (S3 in production, a folder in dev/test).
  `items.image` holds the sha256; `GET /items/:it/image/:hash` is public, outside the manifest like `/events`,
  and serves only the current hash.
- **The audit tables have one writer each.** In `apps/api`, only `src/lib/audit.ts` inserts into
  `audit_outbox`, and nothing selects, updates or deletes from it. In `apps/audit`, only `src/lib/drain.ts`
  deletes from the outbox or inserts into `audit.events` and `audit.dead_letters`, and nothing anywhere updates
  `audit.*`. `scripts/check-boundaries.sh` enforces this by grep, and the database roles enforce it again.
- **No long-running service connects as the superuser.** The API runs as `rch_app`: every API table, but only
  `insert` on `audit_outbox`. The audit service runs as `rch_audit`: `select, delete` and a column
  `update (at)` on the outbox, `select, insert` on the audit tables, nothing else. A trigger refuses every
  UPDATE on `audit_outbox`, so that column grant only lets the drainer lock rows. Migrations and the operator
  CLIs connect as `rch` through
  `MIGRATE_DATABASE_URL`. Each migrate step creates its runtime role from the runtime URL and re-grants it on
  every run; where the two URLs name the same user (locally, the test suites) it creates nothing.

### The audit log

**Every write and every sign-in leaves exactly one audit event.** The super admin reads them on `/admin`'s
Audit log tab: who, when, from which IP and device, what was sent, the server's sentence, and for an edit the
values before it.

- **Capture is central, in the API.** `mount()` hands each non-public write's context to `withTransaction`,
  which inserts a `done` event into `audit_outbox` in the write's own transaction. The event commits with the
  write or not at all. `plugins/audit.ts`'s `onResponse` hook records a refusal (any 4xx but a 401), a 5xx, or
  a success no transaction recorded, but only when a valid token identifies the caller: a write refused with no
  verifiable token leaves no event. `modules/auth` records sign-in, failed sign-in, lock-out, sign-out and
  password change itself. A 401, an idempotent replay, a token refresh and every read are not events.
- **An edit records its before values.** A service that updates or removes an existing master row or account
  calls `auditBefore(...)` right after reading that row (after locking it, where the service locks), before any
  rule or change, so a refused edit carries its before too. A document status change doesn't; its trail
  already carries the before.
- **Secrets never reach the log.** `maskSecrets` replaces the value of every key named in `SECRET_KEYS`
  (`password`, `newPassword`, `currentPassword`, `tempPassword`, `otp`, `token`, `accessToken`, `refreshToken`,
  `secret`) with `••••`, in the request, the result and the before values. It matches whole names, so
  `mustChangePassword` stays readable. A password change's event carries no request at all.
- **A separate service keeps it.** `apps/audit` drains the outbox into `audit.events` exactly once (the delete
  and the insert share one transaction, with `for update skip locked`), sets an event it can't store aside in
  `audit.dead_letters`, and serves `GET /admin/audit` and `GET /admin/audit/:id`. A trigger refuses UPDATE,
  DELETE and TRUNCATE on both tables for every role, and nothing is ever purged.
- **Only the super admin reads it.** The audit service verifies the API's tokens with the public keys alone and
  answers 404 to any token without `admin`. After storing events the drainer announces `audit` on the change
  stream, and the API relays that notice to admin streams only.

### Browser-side state

- **Derived state is computed, never stored.** `UI/src/lib/selectors.ts` is the source of truth for on-hand,
  reserved, free-to-promise, availability, price-at-MRP-cap, the procurement list and PO progress. Most of it
  delegates to `@rch/domain`. Don't mirror a derived value into the store.
- **Browser-only state** is `cart`, `draft`, `prqDraft`, `poolVendor` (the buyer's vendor pick per
  procurement-list item), `drawer`, `toast`, `authError`, `shopFilter`, `theme` and `catalogVersion`. Only the
  theme, a few UI preferences and the bell's read record reach `localStorage`.

## Domain invariants

The code enforces these and tests pin them. Breaking one is a bug.

- **MRP is a hard ceiling.**
  - No price list may exceed an item's printed MRP. `PUT /prices` refuses: `Refused - printed MRP of ₹<mrp> is
    a hard ceiling for <item>`.
  - An item that carries an MRP keeps one; it can't be cleared to zero.
- **Staff credit is capped at ₹3,000 per person per calendar month**, counted hospital-wide in Asia/Kolkata
  time and enforced inside the sale's own transaction.
- **Nothing is created or destroyed without a document.**
  - A batch books what the kitchen made onto its rack. It draws nothing down; kitchen raw stock is cleared
    with an `ADJ-` document.
  - A write-off or a stock count is an `ADJ-` document with a reason, and it may not take stock a ticket is
    holding.
  - A goods receipt posts accepted goods to the central store and rejected goods to `quarantine`.
    `quarantine` is a location where stock is recorded; no operator can act there.
- **Made-to-order (MTO) items are made at the counter and hold no stock.** Selling one moves no stock, and
  only the manual switch turns one off. MTO items are never batched, distributed, or ordered from the kitchen.
- **A bill is voided only on the IST day it was billed, and only by the manager.** The void posts reversal
  moves, frees the credit room it used, and badges the bill rather than erasing it.
- **Items are retired, never deleted**, and not while any stock or menu listing remains. **Payers are
  deactivated, never deleted.**
- **Outlets are closed, never deleted.** A close is refused while the outlet holds stock, an open ticket, stock
  request, kitchen order, shop ask or product request, or an active staff member, and the refusal names every
  one. A closed outlet takes no sale, transfer, ask, stock request, kitchen order, adjustment, menu listing,
  price-list switch or void, and no staff can be posted to it. A reopen restores it as it was.
- **An item carries at most one photo**: JPEG, PNG or WebP, at most 700 KB, checked by `checkPhoto` on both
  sides. A retired item takes no new photo.
- **Employee numbers are assigned by the server**: `nextEmpNo` in `@rch/domain`, one past the highest
  `RC-<digits>`, under the `user` row of `sequences`, which also hands out user ids that are never reused.
- **A staff account is deleted only if it never did anything.** It must be deactivated first, and it can't be
  the caller's own or a super admin. Anything that still references the user (a bill, an approval, a stock
  move) makes the delete a refusal: an account with history can only be deactivated. `admin_actions` keeps the
  target's name, so the log still reads after a delete.
- **Dispatch is all-or-nothing.** An order that is short names every missing line and moves nothing.
- **A delivery counts what the shelf accepted** (`netReceived`), not what arrived. A rejected quantity goes
  back on the procurement list.
- **Everything on the procurement list is an approved requisition line.** The list is derived, never stored.
  The buyer's direct add (`POST /requisitions/direct`) is a requisition raised and approved in one step,
  with a required reason, and only for raw, packing and MRP goods (`isPurchased`).
- **Every write and every sign-in leaves an audit event; nobody can edit or delete one.** A write whose event
  can't be inserted doesn't commit. No password, temporary password, OTP or token is ever stored in one.

## Conventions

- `Role` and every status are closed unions. Never widen one with `string`. A location key is data: the central
  store and kitchen are `STORE` / `KITCHEN` from `@rch/contract`, and outlets are read from the location master
  (`outletKeys` in `@rch/domain`, `openOutlets()` / `allOutlets()` in the UI), never listed. The one deliberate
  `string` is an audit row's stored `action`, so a removed route's history still reads.
- Round quantities to three decimals with `round3`.
- Never hand-format a number. Use `money` / `money0` / `lakh` for money, `fq(v, it)` with `U(it)` for
  quantities, and `unitTotal` for mixed-unit totals.
- **Time zone is Asia/Kolkata.**
  - Sort a time column on the stored `iso` instant, never on the printed `"HH:MM"`.
  - Filter anything labelled "today" with `isToday(iso)`.
  - The API and UI test suites pin `TZ=UTC`, so a host-day shortcut goes red.
- **Toast copy is a full sentence in the operator's voice.** A refusal says what was refused and why. Where a
  rule already has a sentence (for example `creditBreachMessage`), both sides print it word for word.
- **Screen explanations are tooltips.** A sentence that explains a page, a card, a field or a figure goes
  in the kit's `tip` prop (`Tip` in `UI/src/ui/Tip.tsx`), shown on hover, focus or tap. Counts, errors,
  warnings and `Alert`s stay visible. `UI/CLAUDE.md` has the details.
- TypeScript is `strict` with `verbatimModuleSyntax` and `erasableSyntaxOnly`, so type-only imports need
  `import type`.

## Keeping the guides current

If a change alters a rule, a role's screens, a command or a package's conventions, update this file, the
affected nested `CLAUDE.md`, and `README.md` / `UI/README.md` in the same commit. Every statement in them must
be true of the code at HEAD.
