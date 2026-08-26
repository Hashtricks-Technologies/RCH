# Royal Care — F&B Inventory (React + Vite)

Frontend for the hospital's kitchen, restaurant and retail-counter operation. Five roles,
one shared stock ledger, no backend yet.

## Stack

| | |
|---|---|
| Build | Vite 8 |
| UI | React 19 + TypeScript 6, `strict` |
| State | Zustand 5 |
| Routing | React Router 7 (`HashRouter`, so a static build works from any host) |
| Styling | Plain CSS with design tokens — no framework |

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # → dist/
npm run preview
```

No environment variables, no backend, no database. State lives in memory for the session;
a refresh returns to the seeded starting position.

## Sign in

No password is checked. Pick an account on the sign-in screen — each lands somewhere
different and sees a different sidebar.

| Account | Role | Lands on |
|---|---|---|
| Kavitha Raman | Counter Operator · Coffee Shop | Point of Sale |
| Ramesh Kumar | Outlet Manager · all outlets | Approvals |
| Suresh Muthu | Store Keeper · Central Store | Issue Desk |
| Vinoth Prakash | Production In-charge · Kitchen | Orders |
| Latha Narayanan | Procurement Officer | Requisitions |

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

## Not built yet

Persistence, real authentication, barcode scanning, patient-bill posting, GST output
registers. The backend contract is described in `../docs/system-design.html`.
