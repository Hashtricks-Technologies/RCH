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

**Against a real server today:** walk a kitchen order across the board (accepted → in kitchen →
ready), make a batch that draws its recipe out of the kitchen and stamps a best-before, dispatch
it, hand it over on an OTP and receive it at the counter — with a second browser watching every
step happen live — and cancel a ticket nobody came for, which puts the stock and the document
behind it (the request or the production order) back where they stood. And now the whole of
buying: the store keeper raises a requisition, the buyer approves or trims it, draws a purchase
order off the procurement list priced from a live rate contract, sends it to the vendor, and
receives it against a delivery note — a rejection at the door lands in a quarantine shelf that
never sells and never issues, and closing an order short hands the undelivered balance straight
back onto the procurement list. A second browser follows every step of it live, the same as the
rest of the system. And the last two pieces: raise a support ticket from any role's own
Support screen, watch it move Open → With support → Waiting on you → Resolved → Closed as a
reply lands or a status changes, and rate the fix once it is resolved — every role sees only
its own tickets, because there is no support-agent role in this system, only five that ask.
Read the two figures the browser could never assemble on its own: a location's stock ledger
over a window, and a payer's credit taken so far this month. Nothing runs in the browser's own
store any more — every mutation in the app is a server call, and `UI/src/data/seed.ts` is gone.

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

## Running it

Six commands, clone to signed-in browser. You need **Node 24** (see `.nvmrc`), **pnpm 10.28.2**
(`corepack enable`) and **Docker**.

```bash
pnpm install
pnpm db:up                                                                  # postgres:17 in Docker, host port 5439
cp .env.example .env && pnpm --filter @rch/api keys:generate >> .env       # writes JWT_PRIVATE_KEY / JWT_PUBLIC_KEY
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed
pnpm dev                                                                    # API on :3000, UI on :5173
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

Once it's up, `pnpm test:e2e` drives the running stack through a real browser — six files, eight
scenarios, twelve runtime tests (the sign-in loop is five of them), sign-in to a settled bill —
and `e2e/README.md` explains what each one proves and the environment variables the stack needs
first.

**Going live.** Promotion to production is a release decision, not something this repository
does on its own — `deploy/RUNBOOK.md` §11 is the ordered go-live checklist: the AWS values still
marked `FILL`, generating and storing the production JWT keys, creating real staff accounts and
deactivating the seeded ones (which must not exist in production), the restore drill, and the
promotion commands themselves.

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
| `pnpm test:e2e` | Playwright smoke against a running stack (`pnpm dev` first) — see `e2e/README.md` |
| `pnpm --filter @rch/api loadcheck` | Measure `/snapshot` and `/bills` latency against a running API — see `deploy/RUNBOOK.md` §12 |
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

The backend rolled out in six phases (spec §14); every one is **done** — each moved one role's
work onto the server and deleted its in-browser path, so nothing ever ran in two places at once.

| Phase | Scope | Exit check it was gated on |
|---|---|---|
| 1 · Foundation | The monorepo, the contract and domain packages, the API skeleton, the database schema and seed, real sign-in, and `GET /snapshot` — the browser stops inventing its own data | Sign in and see the seeded data, `helm upgrade` runs migrations, `/readyz` green, a real `helm install` against a throwaway kind cluster in CI |
| 2 · Ledger + POS | The movement ledger and balances; counter billing, availability toggles, price lists and menus decided server-side | Sell against the server, balances move, `db:rebuild-balances` matches, the MRP cap refuses and caps, payer rules enforced |
| 3 · Movement chain | The whole request chain, pick tickets with OTP handover, shop transfers and shop asks, the kitchen's two ticket-raising writes, and the live-update stream | The full request chain across two browsers with live updates and no reload; free-to-promise trims what a manager over-approves; a handover releases the reservation it authorised |
| 4 · Production | The kitchen's board and its statuses, batches that consume a recipe and yield finished stock, and a ticket nobody collected can now be cancelled | A make consumes ingredients and yields stock in one transaction; a short dispatch is all-or-nothing; a cancelled ticket returns its stock and its document to where they stood |
| 5 · Procurement | Vendors, rate contracts, requisitions, the purchase-order lifecycle, goods receipt with tolerance and quarantine, new products | A full requisition → PO → GRN → shelf run; the 2% tolerance and the expiry rules both refuse correctly; a cancelled or short-closed order gives its claim back to the requisition |
| 6 · Ops and go-live | The support desk, the two server-side reports, the ticket's audit trail and its withheld OTP, the Playwright smoke, the load check, the chart's alerts, and the go-live checklist | §12's checklist verified against a local stack and the kind cluster CI installs — six items marked **when promoted**, because they need a production cluster that does not exist yet (spec §16); the smoke runs against `pnpm dev` locally and the kind cluster in CI, and is never pointed at production |

Every mutation in the app is a server call now; nothing is left in the browser's own store.
Phase 6 prepared the chart, the workflow and the go-live checklist for the first production
deploy — it did not perform that deploy. Promotion to production is a release decision for the
account owner, made by following `deploy/RUNBOOK.md` §11.

## Where the documents are

- **`docs/ua-spec.html`**, **`docs/system-design.html`**, **`docs/user-flows.html`** — the product
  contract, read in a browser: product classes and 24 acceptance scenarios, the building topology
  and data model, and the role map with six end-to-end journeys.
- **`docs/superpowers/specs/2026-09-03-backend-design.md`** — the backend design and the contract
  for all server work. §2 records the decisions already taken, §14 the build order, and §16 every
  amendment made while phases 1–5 were executed.
- **`docs/superpowers/plans/`** — the executed plan for each phase, kept for the record;
  **`deploy/RUNBOOK.md`** — operations; **`docs/ideation.md`** — notes and open questions.

---

Prepared for Royal Care Hospital by Hashtricks Technologies.
