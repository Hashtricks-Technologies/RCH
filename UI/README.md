# Royal Care — F&B Inventory (React + Vite)

Frontend for the hospital's kitchen, restaurant and retail-counter operation. Five roles,
one shared stock ledger, backed by the `apps/api` Fastify service — all six phases of spec §14
are implemented, and the store is an API client end to end.

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

The dev server proxies `/api` to the Fastify API on `:3000`. Master data, prices, menus, the
payer roster and every open document are hydrated from `GET /snapshot` on load
(`hydrateMaster`/`hydrateRoster`). Every mutation in the store — forty-seven actions, listed in
`../CLAUDE.md`'s *One Zustand store* — is a server call: billing, availability, prices and
menus, the whole stock-request chain, shop transfers and shop asks, the whole of production, the
whole of buying, and now the support desk and the two server-side reports. There is no
in-memory fallback for any of it. `UI/src/api/events.ts` opens one `fetch`-based SSE connection
per session and refetches whatever a write elsewhere changed, so two open tabs stay in sync
without a reload.

Against a real server today, a person can walk a kitchen order across the board, make a batch
that draws its recipe out of the kitchen and stamps a best-before, dispatch it, hand it over on
a six-digit code and receive it at the counter — with another browser following along live — and
cancel a ticket nobody came for, which puts the stock and the document behind it back where it
stood. Buying, the same way: the store keeper raises a requisition at the central store; the
buyer approves or trims it, draws a purchase order off the procurement list priced from a live
rate contract, and sends it to the vendor; the order is received against a delivery note in
instalments, with a rejection at the door landing in a quarantine shelf that never sells and
never issues; and closing an order short hands the undelivered balance straight back onto the
procurement list. And now: raise a support ticket from any role's own Support screen, watch it
move through the desk's states as a reply lands, and rate the fix — every role sees only its own
tickets — and read the two reports the browser could never assemble on its own, a location's
stock ledger and a payer's credit for the month. A second browser watches every one of these
moves happen live, the same as the rest of the system.

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
  store/{index,procurement,ops}.ts        Zustand, all server-backed — index.ts holds most actions (billing,
                                           availability, prices/menus, the request→ticket chain, production,
                                           the two report reads); procurement.ts (vendors, requisition approval,
                                           the PO lifecycle, goods receipt); ops.ts (rate contracts, new-product
                                           requests, shop-to-shop transfers, and the support desk)
  data/                                   master.ts (empty registries, replaced in place by hydrateMaster() and
                                           hydrateRoster()), vendors.ts — no seed.ts, no ops.ts; nothing here
                                           imports the fixtures
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

**Support, for every role, server-backed.** `/issues` — labelled Support in every sidebar — is
customer care for the portal itself: sign-in trouble, a screen that will not load, a number that
looks wrong, printing, slow or frozen, training, or a feature request; a stock or kitchen
problem goes to the screen that owns it instead. Raising one names a topic and a screen and
requires a subject (not a body); it opens a message thread that moves Open → With support →
Waiting on you → Resolved → Closed, and the raiser rates the fix 1–5 once it is resolved. Every
role sees only the tickets it raised — there is no support-agent role, so "own tickets" is the
whole scoping rule, for everyone.

**A six-digit code instead of a scanned one, and it is withheld from the desk that issues it.**
A pick ticket carries a code minted when it is created. The collector reads it aloud to the
store keeper (or the kitchen in-charge), who types it at handover; a wrong code is refused. The
code reaches the wire only for a caller standing at the ticket's own destination while it is
still `Issued` — the issuing desk's own screen, and everyone else's, never shows it. A
supervisor override exists and is labelled as one — restricted to the store and the kitchen —
and is recorded on the ticket's own trail, now visible in the ticket drawer, as
`Handed over — supervisor override`.

**The ticket's own history, on screen.** Every ticket now carries its full trail — `Issued`,
`Handed over` (with the override named when used), `Received`, or `Cancelled — <reason>` — read
back through the same drawer that shows a request's history. A counter can also withdraw a
shop-to-shop transfer it raised, from a "Sent from this counter" card, before anyone collects
it.

**Rate contracts.** Vendor and item, rate, validity window and minimum order quantity, server-
backed since Phase 5. The store keeper maintains them (`POST`/`PATCH`/`DELETE /contracts` all
admit `store`); procurement prices an order from them (`createPo` picks a live contract's rate
over the item's standard cost) and is warned on screen when a rate deviates or a quantity falls
under the minimum. Only one live contract may exist for a given vendor and item at a time.

**New products.** An outlet manager asks for something not on the master; procurement is the
one who sources it, so procurement is the one who adds it — a short form (name, type, unit,
cost, MRP if applicable), with everything else defaulted. Stock arrives the normal way,
through a purchase order, not as an opening balance typed in on the spot. Server-backed since
Phase 5 (`POST /product-requests`, answered by `POST /product-requests/:id/answer`), and the
store keeper and the kitchen can each add a product directly too — the kitchen for its own raw
materials and finished goods, the store keeper at the central store.

**Shop-to-shop transfer.** When one outlet needs an MRP product another is holding, the stock
moves directly between them: reserved at the source, released against an OTP, received at the
destination. The outlet manager sees it happen rather than standing in the middle of it.

## What is still client-side, and why

The store holds no business rule of its own any more — every action is a call to the API, and a
refusal is the server's sentence, not a client-side check. What stays in the browser is only
what has nothing on the server to be a client of: `cart`, `draft`, `prqDraft`, `drawer`, `toast`,
`shopFilter`, `theme`, `catalogVersion` (the signal that repaints a screen pinned to the
catalogue after a live update) — plus the access token, held in memory and never in
`localStorage`, and the theme and a couple of UI preferences, which do reach `localStorage`
because there is nothing for the server to say about which theme a browser prefers.

`@rch/domain`'s functions run client-side too, but as **previews only** — a cart total before
paying, whether an item shows as available, the Dispatch cover check — computed with the same
functions the server enforces with, never a second copy of a rule. The refusal, when one
happens, is always the server's.

## Try it end to end

`pnpm test:e2e` (from the repo root, against a running `pnpm dev` stack) drives six real
scenarios through a real browser — sign in, sell, raise and approve a request, make a kitchen
batch, run a requisition through to a goods receipt, and work a support ticket end to end — and
is the fastest way to see the whole system move. `../e2e/README.md` explains what each spec
proves and the environment it needs. `apps/api/scripts/loadcheck.mjs`
(`../deploy/RUNBOOK.md` §12) measures whether `/snapshot` and `/bills` meet spec §12's latency
targets against a running API.

## Out of scope

Barcode scanning, patient-bill posting and GST output registers remain out of scope, along with
a handful of features this document's original spec proposed and the team declined — a
quarantine ledger with a purchase return, a finance approval role, batch-wise MRP with FEFO
issue, and a shift/day-close/wastage workflow — each recorded with its reason in
`../docs/ua-spec.html` §09 and `../docs/superpowers/specs/2026-09-03-backend-design.md` §16. The
backend design is `../docs/superpowers/specs/2026-09-03-backend-design.md`; the phase-by-phase
status is the table in the root `../README.md`.
