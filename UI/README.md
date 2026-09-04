# Royal Care — F&B Inventory (React + Vite)

Frontend for the hospital's kitchen, restaurant and retail-counter operation. Five roles,
one shared stock ledger, backed by the `apps/api` Fastify service (Phases 1–4 — spec §14).

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
every open document are hydrated from `GET /snapshot` on load (`hydrateMaster`). Billing,
availability, prices and menus (Phase 2), the whole stock-request chain, shop transfers, shop
asks and the kitchen's two ticket-raising writes (Phase 3), and the rest of production — the
kitchen's board, its batches and ticket cancellation (Phase 4) — all run against the server —
twenty-two store actions in total, listed in `../CLAUDE.md`'s *One Zustand store*. `UI/src/api/
events.ts` opens one `fetch`-based SSE connection per session and refetches whatever a write
elsewhere changed, so two open tabs stay in sync without a reload. Against a real server today
a person can walk a kitchen order across the board, make a batch that draws its recipe out of
the kitchen and stamps a best-before, dispatch it, hand it over on an OTP and receive it at the
counter — with another browser following along live — and cancel a ticket nobody came for,
which puts the stock and the document behind it back where it stood. All of procurement, and
the ops slice's support tickets, rate contracts and new-product requests, still run against the
in-memory Zustand store until later phases move them server-side (spec §14).

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
  types.ts, nav.ts, drawers.ts, App.tsx   entities · sidebar & route guard · drawer registry · router
  api/                                    client.ts (the one generic client — routes, idempotency, 401-refresh
                                           retry), session.ts (in-memory token), events.ts (SSE change stream),
                                           refetch.ts (pulls back what a write changed), wire.ts (mappers)
  store/{index,procurement,ops}.ts        Zustand — index.ts holds the server-backed actions (billing,
                                           availability, prices/menus, the request→ticket chain, production);
                                           procurement.ts and ops.ts's tickets/contracts/new-products/createItem
                                           are still local (see Not built yet)
  data/                                   master.ts (replaced in place by hydrateMaster()), seed.ts, ops.ts,
                                           vendors.ts — opening balances and seeds for the still-local slices
  lib/                                    fmt.ts (money, quantity, time), selectors.ts (qty · resv · avail ·
                                           freeToPromise · availOf · priceOf · procurementList …), theme.ts
  ui/                                     kit.tsx (~30 typed components), Shell.tsx, Drawer.tsx,
                                           ErrorBoundary.tsx, prefs.ts
  pages/                                  Login.tsx, ChangePassword.tsx, Settings.tsx, Support.tsx
  roles/<role>/                           counter/ manager/ store/ prod/ buyer/
  __tests__/                              store, procurement, fixes, screens/app, api, session, events,
                                           writes, theme
```

Each role folder exports `screens: Record<string, ComponentType>`; `App.tsx` resolves the
route key against the signed-in role. A route the role cannot reach redirects — it is not
merely hidden from the sidebar.

## Domain rules worth knowing

**Two approval stages.** A counter raises a request → the **outlet manager** approves and may
trim quantities → the **store keeper** issues a pick ticket → the counter collects and
receives. Approval reserves stock; the handover scan is what actually moves it. The whole
chain is server-side (`apps/api/src/modules/{requests,tickets}`); a trim beyond what the
central store can still promise is the server's own decision, not the browser's.

**MRP is a hard ceiling.** Traded goods carry a printed MRP. No price list, floor or role may
sell above it — `savePrice` refuses and says so.

**Recipe depletion.** Selling a made-to-order drink deducts its ingredients from that
counter, not a finished unit. Finished goods made in the kitchen deduct by the unit.

**Availability is computed.** Traded and finished goods switch off at zero; made-to-order
items switch off when any ingredient runs out, naming the one that blocked it. The toggle is
a manual override on top.

## Recent capabilities

**Support, for every role.** `/issues` — labelled Support in every sidebar — is customer
care for the portal itself: sign-in trouble, a screen that will not load, a number that looks
wrong, printing, slow or frozen, training, or a feature request; a stock or kitchen problem
goes to the screen that owns it instead. Raising one names a topic, priority and the screen it
concerns, and opens a message thread that moves Open → With support → Waiting on you →
Resolved → Closed; the raiser rates the fix 1–5 once it is marked resolved. Still local to
`store/ops.ts`.

**OTP instead of a scanned code.** A pick ticket carries six digits. The collector reads them
to the store keeper, who types them at handover; a wrong OTP is refused. A supervisor override
exists and is labelled as one — restricted to the store and the kitchen, and recorded as
`Handed over — supervisor override` in `document_history` so it stays traceable to who did it
and when.

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

Still local to the store until their phase lands (spec §14, and the phase table in the root
`README.md`): all of `store/procurement.ts` — vendors, requisitions, the PO lifecycle, goods
receipt; and the ops slice's support tickets, rate contracts, new-product requests and
`createItem`. Phase 1 delivered persistence and real authentication for reads, Phase 2 cut
billing, availability and prices/menus over to the server, Phase 3 cut over the request chain,
tickets, shop-to-shop transfers, shop asks and the kitchen's two ticket-raising writes, adding
live updates over SSE, and Phase 4 finished production — the board's statuses, batches with
recipe consumption, and a way to cancel a ticket nobody collected. Barcode scanning,
patient-bill posting and GST output registers remain out of scope. The backend design is
`../docs/superpowers/specs/2026-09-03-backend-design.md`.
