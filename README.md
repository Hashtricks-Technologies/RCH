# Royal Care Hospital — Food & Beverage Inventory and Billing

Frontend for the hospital's kitchen, restaurant and retail-counter operation: one item
master and one stock ledger behind every counter in the building, from purchase
requisition through production to the customer's bill.

**Application source:** [`UI/`](UI) — React 19 + Vite 8 + TypeScript · **Project home:** [`index.html`](index.html)

---

## What this is

Royal Care runs one central kitchen, one restaurant and several floor shops selling
coffee, tea, snacks and packaged goods. Two kinds of product move through it:

| Class | Examples | Price authority |
|---|---|---|
| **Traded (MRP)** | Bottled juice, water, biscuits, chips | Printed MRP is a **hard ceiling** — no floor, price list or approval may exceed it |
| **Made in-house** | Puffs, sandwiches, salad, cappuccino, tea | The hospital sets the price; a costed, approved price list supplies the discipline |

Stock is held per location. A sale deducts from that counter — a traded item by the
unit, a made-to-order drink by its recipe.

## Roles

Five roles, each with its own dashboard, its own screens and its own permissions.
A module a role cannot use is absent from its sidebar entirely.

| Role | Signs in as | Lands on | Owns |
|---|---|---|---|
| Counter Operator | Kavitha Raman | Point of Sale | Billing, counter stock, product on/off, raising requests, collecting tickets |
| Outlet Manager | Ramesh Kumar | Approvals | Approving and **editing** counter requests, prices across all shops, on/off master |
| Store Keeper | Suresh Muthu | Issue Desk | Issuing approved stock against a ticket, central-store stock, requisitions to procurement |
| Kitchen In-charge | Vinoth Prakash | Orders | Accepting orders, making products, distributing to stores and counters |
| Procurement Officer | Latha Narayanan | Requisitions | Acting on store requisitions, raising purchase orders, receiving goods |

Sign in with an employee id and password (see `UI/README.md` for the seeded accounts).

## The request chain

    Counter Operator          Outlet Manager           Store Keeper            Counter Operator
    raises request     →      approves / edits    →    issues ticket      →    collects & receives
    (multi-item)              forwards to store        stock reserved          stock arrives

    Draft → Request sent → Manager approved → Ticket issued → Collected → Received → Closed
                         ↘ Rejected        ↘ Cancelled     ↘ Partially approved

Approval **authorises**; the scan **moves**. Stock leaves the store on the handover scan
and arrives on the receive scan — in between it is in transit, owned by neither location.

## Repository layout

    index.html                     project home
    UI/                            the application — React 19, Vite 8, TypeScript, Zustand
    UI/README.md                   stack, scripts, source layout, domain rules
    docs/ua-spec.html              user-acceptance specification — product classes, 24 UAT scenarios
    docs/system-design.html        platform, building topology, data model
    docs/user-flows.html           role map, day timeline, six end-to-end journeys
    docs/ideation.md               running notes and open questions

## Running it

This is a pnpm + Turborepo monorepo. From the repo root:

    pnpm install
    pnpm db:up          # postgres:17 in Docker, host port 5439
    cp .env.example .env
    pnpm --filter @rch/api keys:generate >> .env
    pnpm --filter @rch/api db:migrate
    pnpm --filter @rch/api db:seed
    pnpm dev             # api on :3000, UI on :5173

    pnpm build           # every package
    pnpm typecheck
    pnpm lint
    pnpm test

Sign in at `http://localhost:5173` with a seeded employee id (see `UI/README.md`) and the seed
password. Full sequence, CLI reference and deployment procedures are in `deploy/RUNBOOK.md`.

## Status

React + Vite frontend, strict TypeScript, light and dark themes, backed by a Fastify + Drizzle
+ PostgreSQL API (`apps/api`) under Phases 1–3 of the backend rollout (spec §14). Real logic
sits behind the screens rather than mock data:

- **One ledger.** Nothing is created or destroyed without a document. Production consumes its
  recipe from the kitchen in the same transaction that books the finished units; a ticket
  reserves stock, the handover scan moves it, and the receipt scan lands it.
- **Free to promise.** On hand, less what open tickets reserve, less what other approvals have
  already committed — so the same stock cannot be promised twice.
- **MRP as a ceiling.** A price above the printed MRP is refused on save and capped at the till.
- **Goods receipt.** Batch or lot number, printed MRP, manufacturing and expiry dates, received
  against ordered within a 2% tolerance, and a quality rejection that goes to quarantine
  rather than the shelf.
- **Costing.** Made items cost what their recipe costs, overhead included, not zero.
- **Role-based access.** A module a role cannot use is absent from its sidebar and refused by
  direct link with a message.

Sign-in is real (employee id + password against the API) and state — the item master,
locations, prices, menus and every open document — is read from the server on load. Counter
billing and the outlet manager's prices and menus are on the server too: a sale is decided by
`POST /bills` (pricing, the payer rule and the stock check all run there, so two counters can
never both sell the last unit), and availability toggles and price/menu edits go through the
same round trip.

The whole stock-request chain is server-side as well: a counter raises a request, the outlet
manager approves or trims it against what the central store can still promise, the store
keeper turns the approval into a pick ticket, the collector hands it over on a six-digit OTP
(or, at the store or the kitchen, a labelled supervisor override), and the receiving counter
scans it in. The same ticket machinery carries a shop-to-shop transfer, a shop directly asking
a peer shop for stock it is holding, and the kitchen pushing a production order or a tray out
the door. Every signed-in browser hears about it as it happens — a request raised in one
window shows up on another's approvals screen without a reload, over one persistent connection
per browser (`GET /events`).

Every other mutation — the rest of production (making a batch, moving a board status) and all
of procurement (requisitions, purchase orders, goods receipt) — is still in-memory in the
browser store until later phases move it server-side (spec §14). The backend design is
`docs/superpowers/specs/2026-09-03-backend-design.md`; operations, including how to read the
event stream's health, are `deploy/RUNBOOK.md`.

---

Prepared for Royal Care Hospital by Hashtricks Technologies.
