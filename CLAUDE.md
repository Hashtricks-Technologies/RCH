# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Royal Care Hospital's F&B inventory and billing system. It runs one item master and one stock ledger behind a
central store, a central kitchen and three retail outlets (Restaurant, Coffee Shop, Snack Kiosk), and covers
purchase requisition → purchase order → goods receipt → production → issue → counter sale.

It is a pnpm + Turborepo monorepo (Node 24, pnpm 10.28.2):

| Package | What it is |
|---|---|
| `packages/contract` (`@rch/contract`) | Zod wire schemas, the one route manifest, the demo-hospital fixtures |
| `packages/domain` (`@rch/domain`) | The business rules as pure functions, shared by server and browser |
| `apps/api` (`@rch/api`) | Fastify 5 + Drizzle on PostgreSQL 17; owns the ledger, document numbers, reservations, change stream |
| `UI` (`@rch/ui`) | React 19 + Vite 8 + Zustand 5; an API client end to end |
| `deploy/` | Helm chart (EKS), Docker Compose (single EC2 box), nginx, and `RUNBOOK.md` for every operational procedure |

Dependencies flow one way only: **contract → domain → api / UI**. Nothing points back, and `apps/api` and `UI`
never import each other. Screens go through the store (`useApp`), never through `api/client` directly. The
oxlint import rules in `.oxlintrc.json` enforce all of this.

Each package has its own `CLAUDE.md` for what is specific to it. Claude Code reads it when working in that
directory. This file holds the repo-wide rules.

## Commands

From the repo root:

```bash
pnpm install
pnpm db:up                      # postgres:17 in Docker, host port 5439 (pnpm db:down to stop)
cp .env.example .env && pnpm --filter @rch/api keys:generate >> .env
                                # then set SEED_PASSWORD: required, ≥ 12 chars, no default — nothing starts without it
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed  # demo hospital; --bare = six locations + RC-0001 admin only; --force re-seeds
pnpm dev                        # API on :3000, UI on :5173 (Vite proxies /api)

pnpm build
pnpm typecheck
pnpm lint                       # oxlint per package + knip (unused exports/files/deps) + scripts/check-boundaries.sh
pnpm test                       # every package; apps/api needs Postgres reachable
pnpm helm:test                  # render the chart and check it
pnpm compose:test               # check the Compose deployment files
```

To run one file or one case without the package's coverage gate:

```bash
pnpm --filter @rch/ui exec vitest run src/__tests__/writes.test.ts
pnpm --filter @rch/api exec vitest run src/modules/tickets/tickets.test.ts -t "handover"
```

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
7. It builds both images, scans them with Trivy at `CRITICAL,HIGH`, and does a real `helm install` into a
   throwaway kind cluster.
8. A separate job renders the chart.

Every change must pass all of it. Four things trip people up:

- **Lint is zero-warning.** Every package's `lint` is `oxlint --max-warnings 0`, so a warning fails the job
  just like an error does.
- **Coverage floors are part of `test`.** The floors are UI lines 73 / branches 51, `apps/api` 94 / 79,
  `packages/domain` 99 / 92, and `packages/contract` lines 96. Raise a floor when the real figure rises. Never
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
- `.github/workflows/deploy.yml` is `workflow_run` on CI's success. GitHub always runs it from the copy on the
  **default branch**, so an edit to it takes effect the moment it lands on `develop`. Values in it come from
  `github.event.workflow_run.head_sha` and `head_branch`, not `github.sha`. `DEPLOY_ENABLED` is `false`: the EKS
  environment was torn down, and staging and production are not provisioned.
- The live dev environment (https://rch.hashtrickstechnologies.com) is one EC2 box under Docker Compose,
  deployed by hand with `git pull && deploy/compose/deploy.sh` (`deploy/RUNBOOK.md` §16). It was seeded bare
  and holds real data. **Never run a demo seed against it.**

## Architecture

### One manifest drives both sides

`packages/contract/src/routes.ts` declares every route with `defineRoute({ method, path, access, body?,
response, … })`.

- **Server:** `apps/api/src/routes.ts`'s `mount()` registers each route with its schemas, auth, role gate and
  idempotency preHandler.
- **Browser:** `UI/src/api/client.ts`'s `call(route, input)` builds the URL, mints the `Idempotency-Key`, and
  refreshes the token once on a 401.

There are no hand-written fetch wrappers. A new endpoint is one manifest entry plus a handler, landed in the
same commit.

### A write, end to end

1. A UI store action calls `call(routes.x, …)`.
2. The route handler parses the input and hands it to the service.
3. The service runs inside `withTransaction`. It locks, applies the rules from `@rch/domain`, posts moves,
   appends history, and calls `emitChanged` (a `pg_notify`, held until commit).
4. The route replies `{ result, changed, message }`. `message` is the operator's sentence; the UI toasts it
   verbatim and never writes its own success text.
5. The UI's `refetch(changed)` pulls back only those collections, each through a narrow `GET`.
6. Every other open browser receives the same `changed` over `GET /events` (SSE) and refetches too.

A refusal is an error envelope whose `message` is the sentence toasted. Any cart or form is left exactly as it
was.

### Roles and scope

There are five roles (`counter`, `manager`, `store`, `prod`, `buyer`), each with its own sidebar.

- **Unknown route:** a role without a module gets a **404**, the same as a screen that doesn't exist for it.
- **Wrong location:** a caller outside the location a document belongs to gets a **403**.
- **`manager`** is hospital-wide, so its writes never scope to a location.
- **`counter` and `prod`** are location-scoped. `store` and `buyer` each work one desk.
- **Admin** is a boolean on `users`, not a sixth role. It is checked as `access: "admin"`. An admin-flagged
  account sees only the standalone `/admin` page, never an operational shell. The flag can only be set with
  `pnpm --filter @rch/api users set-admin`; no route can set it.

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
  copy either one; `apps/api/CLAUDE.md` explains why each is safe.
- Status changes go through the tables in `packages/domain/src/transitions.ts`. The server refuses with them,
  and the UI reads the same tables to decide which buttons to draw.
- Every non-public write carries an `Idempotency-Key`. The outcome is recorded inside the write's own
  transaction, so a retry replays the answer instead of producing a second bill.

### Browser-side state

- **Derived state is computed, never stored.** `UI/src/lib/selectors.ts` is the source of truth for on-hand,
  reserved, free-to-promise, availability, price-at-MRP-cap, the procurement list and PO progress. Most of it
  delegates to `@rch/domain`. Don't mirror a derived value into the store.
- **Browser-only state** is `cart`, `draft`, `prqDraft`, `drawer`, `toast`, `authError`, `shopFilter`, `theme`
  and `catalogVersion`. Only the theme and a few UI preferences reach `localStorage`.

## Domain invariants

The code enforces these and tests pin them. Breaking one is a bug.

- **MRP is a hard ceiling.**
  - No price list may exceed an item's printed MRP. `PUT /prices` refuses: `Refused — printed MRP of ₹<mrp> is
    a hard ceiling for <item>`.
  - An item that carries an MRP keeps one; it can't be cleared to zero.
- **Staff credit is capped at ₹3,000 per person per calendar month**, counted hospital-wide in Asia/Kolkata
  time and enforced inside the sale's own transaction.
- **Nothing is created or destroyed without a document.**
  - A batch consumes its recipe's ingredients and books the yield in one `postMoves` call.
  - A write-off or a stock count is an `ADJ-` document with a reason, and it may not take stock a ticket is
    holding.
  - A goods receipt posts accepted goods to the central store and rejected goods to `quarantine`.
    `quarantine` is a location where stock is recorded; no operator can act there.
- **Made-to-order (MTO) items are assembled at the counter.** Selling one deducts its recipe from stock. MTO
  items are never batched, distributed, or ordered from the kitchen.
- **A bill is voided only on the IST day it was billed, and only by the manager.** The void posts reversal
  moves, frees the credit room it used, and badges the bill rather than erasing it.
- **Items are retired, never deleted**, and not while any stock or menu listing remains. **Payers are
  deactivated, never deleted.**
- **Dispatch is all-or-nothing.** An order that is short names every missing line and moves nothing.
- **A delivery counts what the shelf accepted** (`netReceived`), not what arrived. A rejected quantity goes
  back on the procurement list.

## Conventions

- `LocKey`, `Role` and every status are closed unions. Never widen one with `string`.
- Round quantities to three decimals with `round3`.
- Never hand-format a number. Use `money` / `money0` / `lakh` for money, `fq(v, it)` with `U(it)` for
  quantities, and `unitTotal` for mixed-unit totals.
- **Time zone is Asia/Kolkata.**
  - Sort a time column on the stored `iso` instant, never on the printed `"HH:MM"`.
  - Filter anything labelled "today" with `isToday(iso)`.
  - The API and UI test suites pin `TZ=UTC`, so a host-day shortcut goes red.
- **Toast copy is a full sentence in the operator's voice.** A refusal says what was refused and why. Where a
  rule already has a sentence (for example `creditBreachMessage`), both sides print it word for word.
- TypeScript is `strict` with `verbatimModuleSyntax` and `erasableSyntaxOnly`, so type-only imports need
  `import type`.

## Keeping the guides current

If a change alters a rule, a role's screens, a command or a package's conventions, update this file, the
affected nested `CLAUDE.md`, and `README.md` / `UI/README.md` in the same commit. Every statement in them must
be true of the code at HEAD.
