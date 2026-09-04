# Royal Care Hospital — Food & Beverage Inventory and Billing

The system Royal Care's kitchen, restaurant and floor shops run on: one item master and one stock
ledger behind every counter in the building, from purchase requisition through production to the
customer's bill. This repository is the whole thing — a React frontend, a Fastify API, the shared
contract and rules packages, the Helm chart it deploys with, and the specs it was built against.

## What the system does

Royal Care runs one central store, one central kitchen and three retail outlets (Restaurant,
Coffee Shop, Snack Kiosk). Two kinds of product move through them:

| Class | Examples | Price authority |
|---|---|---|
| **Traded (MRP)** | Bottled juice, water, biscuits, chips | The printed MRP is a hard ceiling — no price list or approval may exceed it |
| **Made in-house** | Puffs, sandwiches, salad, cappuccino, tea | The hospital sets the price; a costed, approved price list supplies the discipline |

Stock is held per location, and every quantity in the system is the sum of an append-only ledger
of stock movements — nothing is created or destroyed without a document. A sale deducts from that
counter: a traded item by the unit, a made-to-order drink by its recipe.

Five roles each get their own dashboard, screens and permissions. A module a role cannot use is
absent from its sidebar and refused on a direct link, with a message saying why.

| Role | Signs in as | Lands on | Owns |
|---|---|---|---|
| Counter Operator | Kavitha Raman | Point of Sale | Billing, counter stock, product on/off, raising requests, collecting tickets |
| Outlet Manager | Ramesh Kumar | Approvals | Approving and trimming counter requests, prices across all shops, the on/off master |
| Store Keeper | Suresh Muthu | Issue Desk | Issuing approved stock against a ticket, central-store stock, requisitions to procurement |
| Kitchen In-charge | Vinoth Prakash | Orders | Accepting orders, making products, distributing to the store and counters |
| Procurement Officer | Latha Narayanan | Requisitions | Acting on requisitions, raising purchase orders, receiving goods |

**The request chain.** A counter operator raises a stock request against the central store; the
outlet manager approves, trims or rejects it — never promising more than the store can still
cover once open tickets and other approvals are netted off; the store keeper turns the approval
into a pick ticket, which reserves the stock but moves none of it; the collector quotes a
six-digit OTP at the window and the handover scan moves the stock off the store's shelf; the
receiving counter scans it in and it lands. Between the two scans it is in transit and belongs to
neither location. Approval authorises; the scan moves. The same machinery carries a shop-to-shop
transfer, one shop asking a peer directly for stock it is holding, and the kitchen pushing a
production order or a tray out the door.

**Live updates.** Every signed-in browser holds one connection to the server's change stream, so a
request raised at the Coffee Shop appears on the manager's approvals screen without a reload — and
two tills can never both sell the last unit.

## Architecture at a glance

```
Browser (React 19, Vite) ──HTTPS──▶ API (Fastify 5, Node 24) ──▶ PostgreSQL 17
                         ◀──SSE──── GET /events
```

- **`packages/contract`** — every shape that crosses the wire, as Zod schemas, plus one route
  manifest. The manifest drives both the server's route registration and the browser's single
  generic API client, so the two cannot drift.
- **`packages/domain`** — the business rules as pure functions (the MRP cap, free-to-promise,
  availability, bill planning, costing, the status transition tables). Written once: the server
  enforces them, the browser only previews with them while the operator types.
- **`apps/api`** — Fastify 5 + Drizzle. Owns the ledger, the document numbers, the reservations
  and the change stream. Writes are transactional and idempotent: each carries an
  `Idempotency-Key`, so a retry cannot produce a second bill.
- **`UI`** — React 19 + Zustand. Signs in for real, hydrates from `GET /snapshot`, posts writes
  back, and refetches only the slices a write says it changed.
- **Deployment** — Helm on EKS, PostgreSQL on Amazon RDS in staging and production; locally and
  in CI, a `postgres:17` Docker container.

## Repository layout

```
UI/               the web application (React 19, Vite 8, TypeScript, Zustand)
apps/api/         the HTTP API (Fastify 5, Drizzle, PostgreSQL) and its migrations
packages/contract/  Zod wire schemas, the route manifest, and the demo fixtures
packages/domain/    pure business rules shared by the API and the UI
deploy/           Helm chart, nginx config, and RUNBOOK.md (deploy, rollback, keys, restore)
docs/             the product contract (HTML specs) and the design specs and plans
scripts/          build-site.sh, check-boundaries.sh, pg-init.sql
index.html        the project home page, published at /
```

`CLAUDE.md` at the root and in `apps/api`, `packages/contract`, `packages/domain` and `UI` are
working guides for AI coding agents, and a reasonable orientation for a human meeting a package
for the first time. `UI/README.md` covers the frontend in more detail.

## Quick start

You need **Node 24** (see `.nvmrc`), **pnpm 10.28.2** (`corepack enable`) and **Docker**.

```bash
pnpm install
pnpm db:up                                    # postgres:17 in Docker, host port 5439
cp .env.example .env
pnpm --filter @rch/api keys:generate >> .env  # writes JWT_PRIVATE_KEY / JWT_PUBLIC_KEY
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed
pnpm dev                                      # API on :3000, UI on :5173
```

Open `http://localhost:5173` and sign in with a seeded employee id and the seed password
(`SEED_PASSWORD` in `.env`, `changeme` by default):

| Employee id | Account | Role |
|---|---|---|
| `RC-4471` | Kavitha Raman | Counter Operator · Coffee Shop |
| `RC-3120` | Ramesh Kumar | Outlet Manager |
| `RC-2088` | Suresh Muthu | Store Keeper |
| `RC-1902` | Vinoth Prakash | Kitchen In-charge |
| `RC-1550` | Latha Narayanan | Procurement Officer |
| `RC-4482` | Deepa Selvam | Counter Operator · Snack Kiosk |

A staging or production seed sets `must_change_password`, which routes a first sign-in through a
change-password step. `deploy/RUNBOOK.md` §1 has the full local sequence and what each step does.

## Everyday commands

From the repository root:

| Command | What it does |
|---|---|
| `pnpm dev` | API on :3000 and the UI on :5173, in parallel (Vite proxies `/api`) |
| `pnpm build` | Build every package |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm lint` | oxlint per package, then knip (unused exports) and the module/boundary checks |
| `pnpm test` | Every package's test suite (Postgres must be reachable for `apps/api`) |
| `pnpm db:up` / `pnpm db:down` | Start or stop the local `postgres:17` container |
| `pnpm --filter @rch/api db:migrate` | Apply migrations |
| `pnpm --filter @rch/api db:seed [--force]` | Load the demo hospital; `--force` re-seeds a non-empty database |
| `pnpm --filter @rch/api db:generate` | Generate a migration from the Drizzle schema — review and commit the SQL |
| `pnpm --filter @rch/api db:rebuild-balances` | Recompute cached balances from the movement ledger |
| `pnpm --filter @rch/api users …` | `create`, `reset-password` or `deactivate` an account |
| `pnpm --filter @rch/api keys:generate` | Print a fresh JWT signing key pair |
| `pnpm helm:test` | Render the Helm chart and check the output |
| `bash scripts/build-site.sh` | Assemble the published site into `dist/` (home page, docs, built app) |

## Testing

Four suites, all run by `pnpm test`: **`packages/domain`** proves the rules against literal
expected values; **`packages/contract`** proves every request body accepts its own shape and
refuses an unknown key; **`apps/api`** tests endpoints against a real PostgreSQL, each file in its
own schema, migrated on setup and dropped on close so files run in parallel without colliding;
**`UI`** covers the store, the screens (every role × every sidebar entry renders), the API-backed
actions against a stubbed `fetch`, and the live-update client.

Run one package with `pnpm --filter @rch/ui test` (or `@rch/api`, `@rch/domain`, `@rch/contract`);
the API suite needs Postgres reachable, so `pnpm db:up` first. The API and UI suites both pin
`TZ=UTC`, so timezone-sensitive assertions prove the same thing on every machine.

## Branches and environments

Three long-lived branches, one environment each. Code moves forward only, by fast-forward merge,
so what reaches production is byte-identical to what passed on staging.

| Branch | Role | Deploys to |
|---|---|---|
| `develop` | Default; all work lands here | nothing — CI only |
| `staging` | Release candidate | the `rch-staging` namespace, on push |
| `production` | What the hospital runs | the `rch` namespace, on push, behind an environment approval |

Promote with `git checkout staging && git merge --ff-only develop && git push`, then the same from
`staging` into `production`. The deploy workflow only runs when the repository variable
`DEPLOY_ENABLED` is `true` and the AWS secrets are present; otherwise it reports itself skipped.
Deploy, rollback, key rotation, accounts, the restore drill and the event stream's health are all
in **[`deploy/RUNBOOK.md`](deploy/RUNBOOK.md)**.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to a long-lived branch and every pull request:
`pnpm install --frozen-lockfile`, typecheck and test against a `postgres:17` service container,
`pnpm lint`, the module and boundary checks, `pnpm audit` at high severity, and
`scripts/build-site.sh`. A second job builds the API and UI images, scans both with Trivy for
critical vulnerabilities, and does a real `helm install` against a throwaway kind cluster. A
third renders the Helm chart on its own. Everything must be green to merge.

## Status

The backend is rolling out in six phases (spec §14); each moves one role's work onto the server
and deletes its in-browser path, so nothing runs in two places at once.

| Phase | State | Scope |
|---|---|---|
| 1 · Foundation | **Done** | The monorepo, the contract and domain packages, the API skeleton, the database schema and seed, real sign-in, and `GET /snapshot` — the browser stops inventing its own data |
| 2 · Ledger + POS | **Done** | The movement ledger and balances; counter billing, availability toggles, price lists and menus decided server-side |
| 3 · Movement chain | **Done** | The whole request chain, pick tickets with OTP handover, shop transfers and shop asks, the kitchen's two ticket-raising writes, and the live-update stream |
| 4 · Production | Pending | Production orders and their board statuses, batches consuming their recipe, kitchen stock |
| 5 · Procurement | Pending | Vendors, rate contracts, requisitions, the purchase-order lifecycle, goods receipt with tolerance and quarantine, new products |
| 6 · Ops and go-live | Pending | Support tickets, reports, end-to-end smoke tests, a load check, alerting, and the first production deploy |

Everything phases 4–6 cover still runs in the browser's in-memory store — it works on screen, but
is not yet shared between users or durable across a reload.

## Where the documents are

- **`docs/ua-spec.html`**, **`docs/system-design.html`**, **`docs/user-flows.html`** — the product
  contract, read in a browser: product classes and 24 acceptance scenarios, the building topology
  and data model, and the role map with six end-to-end journeys.
- **`docs/superpowers/specs/2026-09-03-backend-design.md`** — the backend design and the contract
  for all server work. §2 records the decisions already taken, §14 the build order, and §16 every
  amendment made while phases 1–3 were executed.
- **`docs/superpowers/plans/`** — the executed plan for each phase, kept for the record;
  **`deploy/RUNBOOK.md`** — operations; **`docs/ideation.md`** — notes and open questions.

---

Prepared for Royal Care Hospital by Hashtricks Technologies.
