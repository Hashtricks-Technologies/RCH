# Royal Care — F&B Inventory (React + Vite)

Frontend for the hospital's kitchen, restaurant and retail-counter operation. Five roles,
one shared stock ledger, backed by the `apps/api` Fastify service (Phase 1 — spec §14).

## Stack

| | |
|---|---|
| Build | Vite 8 |
| UI | React 19 + TypeScript 6, `strict` |
| State | Zustand 5 |
| Routing | React Router 7 (`HashRouter`, so a static build works from any host) |
| Styling | Plain CSS with design tokens — no framework |

## Run

This app is part of the root pnpm + Turborepo workspace — run it from the repo root, not from
inside `UI/` (the API and a local Postgres need to be up too; see `deploy/RUNBOOK.md` for the
full sequence):

```bash
pnpm install
pnpm db:up                                   # postgres:17 in Docker, host port 5439
cp .env.example .env
pnpm --filter @rch/api keys:generate >> .env
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed
pnpm dev                                     # apps/api on :3000, this app on :5173
```

Just this package, once the API is already running elsewhere:

```bash
pnpm --filter @rch/ui dev        # http://localhost:5173
pnpm --filter @rch/ui build      # → dist/
pnpm --filter @rch/ui test
```

The dev server proxies `/api` to the Fastify API on `:3000`. Master data, prices, menus and
every open document are hydrated from `GET /snapshot` on load (`hydrateMaster`); every
mutation (billing, approvals, tickets, …) still runs against the in-memory Zustand store until
later phases move it server-side (spec §14).

## Sign in

Real authentication — employee id and password, checked against the API. Each account lands
somewhere different and sees a different sidebar. The seed password is `SEED_PASSWORD` from
`.env` (dev default `changeme`); a staging/prod seed sets `must_change_password`, which routes
first sign-in through a change-password step before anything else.

| Employee id | Account | Role | Lands on |
|---|---|---|---|
| `RC-4471` | Kavitha Raman | Counter Operator · Coffee Shop | Point of Sale |
| `RC-3120` | Ramesh Kumar | Outlet Manager · All outlets | Approvals |
| `RC-2088` | Suresh Muthu | Store Keeper · Central Store | Issue Desk |
| `RC-1902` | Vinoth Prakash | Kitchen In-charge · Central Kitchen | Orders |
| `RC-1550` | Latha Narayanan | Procurement Officer (not tied to one counter) | Requisitions |
| `RC-4482` | Deepa Selvam | Counter Operator · Kiosk | Point of Sale |

## Layout

```
src/
  types.ts              every domain entity
  nav.ts                per-role sidebar and route guard
  store.ts              Zustand — all state and actions
  drawers.ts            drawer registry (roles self-register)
  App.tsx               router + role guard
  data/
    master.ts           items, locations, recipes, price lists, users
    seed.ts             opening balances and in-flight documents
  lib/
    fmt.ts              money, quantity, initials, time
    selectors.ts        qty · resv · avail · priceOf · availOf · daysCover
  ui/
    kit.tsx             25 typed components
    Shell.tsx           sidebar, topbar, badges
    Drawer.tsx          drawer host + DrawerFrame
  pages/
    Login.tsx  Settings.tsx
  roles/
    counter/ manager/ store/ prod/ buyer/
```

Each role folder exports `screens: Record<string, ComponentType>`; `App.tsx` resolves the
route key against the signed-in role. A route the role cannot reach redirects — it is not
merely hidden from the sidebar.

## Domain rules worth knowing

**Two approval stages.** A counter raises a request → the **outlet manager** approves and may
trim quantities → the **store keeper** issues a pick ticket → the counter collects and
receives. Approval reserves stock; the handover scan is what actually moves it.

**MRP is a hard ceiling.** Traded goods carry a printed MRP. No price list, floor or role may
sell above it — `savePrice` refuses and says so.

**Recipe depletion.** Selling a made-to-order drink deducts its ingredients from that
counter, not a finished unit. Finished goods made in the kitchen deduct by the unit.

**Availability is computed.** Traded and finished goods switch off at zero; made-to-order
items switch off when any ingredient runs out, naming the one that blocked it. The toggle is
a manual override on top.

## Recent capabilities

**Issues, for every role.** Anyone can raise an operational issue — a jammed grinder, stock
that never arrived, a screen behaving oddly — from `/issues`, which sits on every sidebar.
Kind, priority, and an Open → Acknowledged → Resolved → Closed lifecycle with history.

**OTP instead of a scanned code.** A pick ticket carries six digits. The collector reads them
to the store keeper, who types them at handover; a wrong OTP is refused. A supervisor override
exists and is labelled as one.

**Rate contracts.** Vendor and item, rate, validity window and minimum order quantity. The
store keeper maintains them; procurement prices an order from them and is warned when a rate
deviates or a quantity falls under the minimum.

**New products.** An outlet manager asks for something not on the master; procurement is the
one who sources it, so procurement is the one who adds it — a short form (name, type, unit,
cost, MRP if applicable), with everything else defaulted. Stock arrives the normal way,
through a purchase order, not as an opening balance typed in on the spot. The kitchen can
still add its own raw materials and finished goods directly, for its own use.

**Shop-to-shop transfer.** When one outlet needs an MRP product another is holding, the stock
moves directly between them: reserved at the source, released against an OTP, received at the
destination. The outlet manager sees it happen rather than standing in the middle of it.

## Not built yet

Mutations are still in-memory (billing, approvals, tickets, purchase orders, …) — Phase 1
delivered persistence and real authentication for reads only (spec §14 has the phase-by-phase
cutover). Barcode scanning, patient-bill posting and GST output registers remain out of scope.
The backend design is `../docs/superpowers/specs/2026-09-03-backend-design.md`.
