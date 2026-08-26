# Royal Care Hospital — Food & Beverage Inventory and Billing

Frontend for the hospital's kitchen, restaurant and retail-counter operation: one item
master and one stock ledger behind every counter in the building, from purchase
requisition through production to the customer's bill.

**Application source:** [`web/`](web) — React 19 + Vite 8 + TypeScript · **Project home:** [`index.html`](index.html)

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
| Production In-charge | Vinoth Prakash | Orders | Accepting orders, making products, distributing to stores and counters |
| Procurement Officer | Latha Narayanan | Requisitions | Acting on store requisitions, raising purchase orders, receiving goods |

No password is checked in this build — pick an account on the sign-in screen.

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
    web/                           the application — React 19, Vite 8, TypeScript, Zustand
    web/README.md                  stack, scripts, source layout, domain rules
    docs/ua-spec.html              user-acceptance specification — product classes, 24 UAT scenarios
    docs/system-design.html        platform, building topology, data model
    docs/user-flows.html           role map, day timeline, six end-to-end journeys
    docs/ideation.md               running notes and open questions
    archive/                       earlier single-file iterations, kept for reference

## Running it

    cd web
    npm install
    npm run dev        # http://localhost:5173
    npm run build      # -> web/dist

State lives in memory for the session — a refresh returns to the seeded starting
position.

## Status

React + Vite frontend, strict TypeScript. The stock ledger, reservations, MRP ceiling, recipe
depletion and role-based access are real logic; there is no backend, no database and
no authentication yet. The backend contract is described in `docs/system-design.html`.

---

Prepared for Royal Care Hospital by Hashtricks Technologies.
