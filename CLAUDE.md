# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Royal Care Hospital's F&B inventory and billing frontend: one item master and one stock
ledger behind a central store, a kitchen and three retail outlets, covering purchase
requisition → purchase order → goods receipt → production → issue → counter sale.

**Phases 1–2 of the backend are implemented** — a Fastify + Drizzle API on PostgreSQL, per the
design in `docs/superpowers/specs/2026-09-03-backend-design.md` (the contract for all backend
work; see *Backend* below). Sign-in is real (employee id + password), and after signing in the
frontend reads its state — the item master, locations, prices, menus and every open document
— from the server (`GET /snapshot`) instead of `UI/src/data/seed.ts`. Counter billing
(`POST /bills`), availability toggles and the manager's price/menu writes run against the
server too, refetching just what changed; every other mutation (approvals, tickets, purchase
orders, …) still runs against the in-memory Zustand store, and only the theme and a few UI
prefs reach `localStorage`. Later phases (spec §14) move the rest to the server one role at a
time.

## Branches

Three long-lived branches, one environment each. Code moves forward only, by fast-forward
merge, so what reaches production is byte-identical to what passed on staging.

| Branch | Role | Deploys to |
|---|---|---|
| `develop` | **Default.** All work lands here (feature branches by PR, or direct commits while the team is one person). | nothing — CI only |
| `staging` | Release candidate | `rch-staging` namespace, on push |
| `production` | What the hospital runs | `rch` namespace, on push, behind a GitHub environment approval |

Promote with `git checkout staging && git merge --ff-only develop && git push`, then the same
from `staging` into `production`. Never merge the other way except a hotfix: branch from
`production`, PR into `production`, then merge `production` back into `staging` and `develop`.
`main` no longer exists; it was renamed to `develop` on 2026-09-03.

## Commands

This is a pnpm + Turborepo monorepo (`pnpm-workspace.yaml`: `apps/*`, `packages/*`, `UI`).
Run everything from the repo root:

```bash
pnpm install
pnpm dev          # turbo run dev --parallel: apps/api on :3000, UI on :5173 (Vite proxying /api)
pnpm build        # turbo run build, every package
pnpm typecheck    # turbo run typecheck, every package
pnpm lint         # turbo run lint (oxlint per package) + knip (repo-wide unused-export check)
pnpm test         # turbo run test, every package (Postgres must be reachable for apps/api)
```

Database and API commands (see `deploy/RUNBOOK.md` for the full local-dev sequence and what
each one does):

```bash
pnpm db:up                                            # postgres:17 in Docker, host port 5439
pnpm db:down
pnpm --filter @rch/api db:generate                    # drizzle-kit generate; review + commit the SQL
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed [--force]
pnpm --filter @rch/api db:rebuild-balances
pnpm --filter @rch/api users <create|reset-password|deactivate> --emp E1234 ...
pnpm --filter @rch/api keys:generate                  # prints a new JWT_PRIVATE_KEY= / JWT_PUBLIC_KEY= pair
pnpm helm:test                                        # deploy/chart/rch/tests/render.test.sh
```

`pnpm --filter @rch/ui test` runs just the UI's vitest suite (`npx vitest run
src/__tests__/procurement.test.ts` etc. still works from inside `UI/` for a single file).

From the repo root, `bash scripts/build-site.sh` assembles the published site into `dist/`
(`/` = `index.html`, `/docs/` = the HTML specs, `/app/` = the built React app, from
`UI/dist`). Netlify and CI both run this exact script, so a broken assembly fails locally the
same way.

CI (`.github/workflows/ci.yml`) runs `pnpm install --frozen-lockfile` → `pnpm turbo typecheck
test` → `pnpm lint` (oxlint per package plus knip, which turbo never runs) →
`bash scripts/build-site.sh` on Node 24. Every change must pass all of it.
`deploy.yml` builds and deploys the API and UI containers on push to `staging`/`production` —
see `deploy/RUNBOOK.md` §2.

## Repository layout

```
index.html               project home page (published at /)
docs/*.html              UA spec, system design, user flows — the product contract
docs/superpowers/        plans and specs from prior agent-driven work
scripts/build-site.sh    assembles index.html + docs/ + UI/dist into dist/
UI/                      the application (React 19, TS 6 strict, Vite 8, Zustand 5)
```

## Architecture

### Role-partitioned screens, one registry

Five roles: `counter` · `manager` · `store` · `prod` · `buyer` (see `UI/src/types.ts`).
Three files must agree for a screen to exist:

1. `src/nav.ts` — `NAV[role]` lists the sidebar groups and route keys; `HOME[role]` is the
   landing key; `canSee(role, key)` is the route guard.
2. `src/roles/<role>/index.tsx` — exports `screens: Record<string, ComponentType>` keyed by
   the same route key, and imports its drawer modules for their side effects.
3. `src/App.tsx` — one route, `/:key`, resolves `REGISTRY[user.r][key]`. A key the role
   cannot see redirects home **with a toast explaining why** (UA-01) rather than silently.

`src/__tests__/screens.test.tsx` and `app.test.tsx` iterate `NAV` × `USERS` and assert every
advertised key renders. Adding a nav entry without a component fails the suite; that coupling
is deliberate.

Routing is `HashRouter` (`#/pos`) so the static build works from any host with no SPA rewrite.

### One Zustand store, three slices

`src/store/index.ts` is the whole state and most actions. Two slices are merged in at the
bottom of the same `create()` call and share one `AppState`:

- `src/store/procurement.ts` — vendors, requisition approval, PO lifecycle, goods receipt.
- `src/store/ops.ts` — support tickets, rate contracts, new-product requests, shop-to-shop
  transfers, catalogue additions.

Slices take `(set, get)` typed against `AppState`, so any action can read the whole store.
Components subscribe with narrow selectors: `useApp((s) => s.req)`.

Five actions are no longer local: `pay`, `toggleAvail`, `savePrice`, `addProduct` and
`removeProduct` call the API (`UI/src/api/client.ts`) instead of mutating `set` directly, then
`refetch` (`UI/src/api/refetch.ts`) pulls back only the slices the write says it changed —
`GET /stock` for `stock`/`rsv`/`ovr`, `GET /bills` for `bills`, a full `loadSnapshot` for
anything else. A refusal (wrong tender, MRP breach, short stock) throws and is toasted; the
cart or price form is left exactly as it was.

### Derived state is computed, never stored

`src/lib/selectors.ts` is the source of truth for everything derived. Do not add mirrored
fields to the store for anything it already computes:

- `qty` / `resv` / `avail` — on hand, reserved, and the difference at a location.
- `freeToPromise` — on hand less ticket reservations less quantities already committed by
  other approvals. Every approval path must go through it (C6) or stock gets double-promised.
- `availOf` — a traded/finished item is off at zero; a made-to-order item is off when any
  ingredient runs out, and the returned reason names the ingredient that blocked it.
- `procurementList` — approved requisition lines less `ordered`. There is no stored pool.
- `prqProgress`, `onOrder`, `awaitingApproval` — requisition and purchase-order progress.
  `onOrder` covers approved-but-undelivered; `awaitingApproval` covers not-yet-decided.
  A duplicate-order guard needs **both** (M3); read the comments before touching either.
- `priceOf` — applies the MRP cap at read time.

### The movement rule

**Approval authorises; the scan moves.** Approving a request or dispatching a production
order only writes a reservation into `rsv`. Stock leaves a location on `handover` and lands
on `receiveTicket`; in between it is in transit and owned by neither location (`inTransit`).
Any new movement must follow this two-step shape.

Ticket handover is gated by a six-digit OTP (`makeOtp`) that the collector reads aloud. A
wrong OTP is refused; omitting the argument entirely is the labelled supervisor override.

### Drawers

`src/drawers.ts` is a bare registry. A drawer module calls `registerDrawer("key", Component)`
at the bottom of its file and is pulled in by a side-effect import in the role's `index.tsx`.
Open one with `openDrawer(t, id)`; `ui/Drawer.tsx` hosts it and `DrawerFrame` supplies the
header/body/footer chrome.

### UI

`src/ui/kit.tsx` holds ~25 typed components (`Card`, `DataTable`, `PageHead`, `Btn`, `Pill`,
`Alert`, `Section`, `Field`, `FormRow`, `Toolbar`, `TableFoot`, `Kpis`, `Grid`, `LineChart`,
`Otp`, …). Use them instead of bespoke markup. Styling is plain CSS in `src/styles.css` —
one token set on `:root`, redefined under `@media (prefers-color-scheme: dark)` guarded by
`:root:not([data-theme="light"])`, and again under `[data-theme="dark"]` so an explicit
choice wins in both directions. No CSS framework.

## Domain invariants

These are enforced in code and pinned by tests. Breaking one is a bug, not a style choice.

- **MRP is a hard ceiling.** Traded items carry a printed MRP. `packages/domain` holds the
  rule; the server enforces it (`PUT /prices/:list/:it` refuses above it, verbatim: `Refused —
  printed MRP of ₹<mrp> is a hard ceiling for <item>`) and `priceOf` in `selectors.ts` still
  caps client-side previews at the till. No role, list or approval may exceed it.
- **Nothing is created or destroyed without a document.** `makeProduct` deducts the recipe
  from the kitchen in the same `set` that books the finished units; ingredients go against
  what was *started*, only the yielded units reach the rack.
- **Selling deducts by recipe for MTO items**, by the unit otherwise — now decided server-side
  in `apps/api/src/modules/pos` (`POST /bills`) against the same rule in `packages/domain`;
  `pay` in `store/index.ts` just calls it and refetches.
- **Dispatch is all-or-nothing.** A short production order names every missing item and moves
  nothing; a repeated item is folded into one line before the cover check.
- **Costing.** `costOf` prices a made item from its recipe plus overhead — never zero.

## Conventions

- `LocKey`, `Role` and every status type are closed unions in `src/types.ts`. Never widen one
  with `string`; let the compiler find the call sites.
- Round quantities with `Math.round(v * 1000) / 1000` (or `round3` from selectors). Float-safe
  comparisons in `prqProgress` use `>=` on purpose — that is not a typo.
- Never hand-format a number. Money goes through `money` / `money0` / `lakh`, quantities
  through `fq(v, it)` with `U(it)` for the unit, and mixed-unit totals through `unitTotal`
  (adding litres to cups is how a request reads "510 units").
- Toast copy is a full sentence in the operator's voice — `"PO-2026-0143 raised on Aavin Dairy
  Depot — expected 31-Aug-2026"`, not a bare status word. A refusal says what was refused and
  why, and the action does not happen.
- `strict` TypeScript with `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` and
  `erasableSyntaxOnly`. Type-only imports need `import type`.
- Master data (items, locations, recipes, price lists, users, limits) lives in
  `src/data/master.ts`; opening balances and in-flight documents in `src/data/seed.ts` and
  `src/data/ops.ts`. Tests reset through `src/__tests__/fixture.ts` (`resetStore`, `S`, `as`).

## Tests

`src/__tests__/` (jsdom, `setupFiles: setup.ts` which installs a working `localStorage` when
the host does not supply one):

- `store.test.ts` — the request/ticket chain, billing, recipe depletion.
- `procurement.test.ts` — requisitions, the pooled list, PO lifecycle, goods receipt.
- `fixes.test.ts` — regression pins for previously-found defects, referenced by their tags
  (C6, M3, M8, H4, UA-14…). Read the surrounding comment before changing behaviour one covers.
- `screens.test.tsx` / `app.test.tsx` — every role × every nav key renders, bare and in-shell.
- `theme.test.ts` — theme resolution and persistence.
- `writes.test.ts` — the five API-backed actions (`pay`, `toggleAvail`, `savePrice`,
  `addProduct`, `removeProduct`) against a mocked client: success refetches the right slices,
  a refusal toasts and leaves state untouched.

`apps/api`'s tests give each file its own Postgres schema, `t_<name>_<pid>` (`process.pid`
keeps parallel runs from colliding), migrated once and dropped on close
(`apps/api/src/test/db.ts`). Both `apps/api/vitest.config.ts` and `UI/vite.config.ts` pin
`TZ=UTC` so IST-sensitive assertions (bill numbering across midnight, best-before rendering)
prove something on every host, not just ones already in UTC.

## Backend

Status: **Phases 1–2 implemented; phases 3–6 pending — see spec §14.** Read
`docs/superpowers/specs/2026-09-03-backend-design.md` before touching anything server-side;
it records every decision already taken (§2), plus every amendment recorded during Phases 1–2
(§16), so they are not reopened in chat.

Phase 2 added three modules to `apps/api/src/modules`, each `routes.ts` / `service.ts` /
`repo.ts` / `<name>.test.ts` like every other: `pos` (`POST /bills`, the ledger sale — pricing,
the payer rule and the cover check all run server-side, then `postMoves()` writes the stock
move and a post-lock re-read asserts `on_hand ≥ 0`), `availability` (`POST
/availability/toggle`, admitting `counter`/`manager`/`prod` each for their own scope), and
`catalog` (`PUT /prices/:list/:it`, menu add/remove — the MRP ceiling and `seq = max+1`
enforced here). `GET /stock` and `GET /bills` are scoped like `/snapshot` for a counter.

What it commits to, in one breath: a standalone TypeScript backend in a pnpm + Turborepo
monorepo — `packages/contract` (Zod schemas; `types.ts` moves here), `packages/domain` (pure
rules shared by UI and server), `apps/api` (Fastify 5 + Drizzle on PostgreSQL 17), `UI/`
(this app, its store becoming an API client), `deploy/chart/rch` (Helm, for EKS). Database is
Amazon RDS in staging/production and a `postgres:17` Docker container locally and in CI.
Auth is employee id + password with rotating refresh tokens. Offline mode is out of scope.

Rules that bind once code exists — spec §5.1 has the enforcement mechanism for each:

- A business rule is written once, in `packages/domain`; the server enforces it, the UI only
  previews with it. A rule inlined in a route handler or a component is a defect.
- Wire types are Zod schemas in `packages/contract`; nothing else declares them.
- One route manifest in `packages/contract/routes.ts` drives both the server's registration
  and the single generic API client in `UI/src/api/client.ts`. No hand-written fetch wrappers.
- Every server module is `routes.ts` / `service.ts` / `repo.ts` / `<name>.test.ts`.
- `stock_moves` is append-only and `postMoves()` in `apps/api/src/lib/ledger.ts` is the only
  thing that writes it or `stock_balances`.
- Status transitions are a table in `packages/domain/transitions.ts`, read by both sides.

Build order is spec §14 — six phases, each cutting one role over to the server and deleting
its in-memory path; nothing dual-runs. "Production ready" is the checklist in spec §12 and
gates every phase. Phase 1's frontend cutover is real sign-in and `/snapshot` hydration
(`hydrateMaster`) in place of `data/master.ts`'s static registries. Phase 2 cuts counter
billing, availability toggles and the manager's price/menu writes over to the server (`pay`,
`toggleAvail`, `savePrice`, `addProduct`, `removeProduct`, above); everything else stays local
to the store until phase 3 lands. Operational procedures — deploy, roll back, rotate keys,
accounts, restore drill — are `deploy/RUNBOOK.md`.

## Docs

`docs/ua-spec.html`, `docs/system-design.html` and `docs/user-flows.html` are the product
contract, and `README.md` / `UI/README.md` describe current behaviour. When a change alters
a rule, a role's screens or the request chain, update the affected docs in the same commit —
recent history shows them drifting and needing a catch-up pass.
