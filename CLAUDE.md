# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Royal Care Hospital's F&B inventory and billing frontend: one item master and one stock
ledger behind a central store, a kitchen and three retail outlets, covering purchase
requisition → purchase order → goods receipt → production → issue → counter sale.

There is **no backend, no database and no authentication**. State lives in memory for the
session; only the theme and a few UI prefs reach `localStorage`. A refresh returns to the
seeded starting position in `UI/src/data/seed.ts`.

## Commands

All application commands run from `UI/`:

```bash
npm install
npm run dev          # http://localhost:5173
npm run typecheck    # tsc --noEmit -p tsconfig.app.json
npm run lint         # oxlint (config: UI/.oxlintrc.json)
npm test             # vitest run
npm run test:watch
npm run build        # tsc -b && vite build -> UI/dist
```

Run a single test file or case:

```bash
npx vitest run src/__tests__/procurement.test.ts
npx vitest run -t "raises a multi-item request"
```

From the repo root, `bash scripts/build-site.sh` assembles the published site into `dist/`
(`/` = `index.html`, `/docs/` = the HTML specs, `/app/` = the built React app). Netlify and
CI both run this exact script, so a broken assembly fails locally the same way.

CI (`.github/workflows/ci.yml`) runs typecheck → lint → test → build-site on Node 24.
Every change must pass all four.

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

- **MRP is a hard ceiling.** Traded items carry a printed MRP. `savePrice` refuses a price
  above it and `priceOf` caps at the till. No role, list or approval may exceed it.
- **Nothing is created or destroyed without a document.** `makeProduct` deducts the recipe
  from the kitchen in the same `set` that books the finished units; ingredients go against
  what was *started*, only the yielded units reach the rack.
- **Selling deducts by recipe for MTO items**, by the unit otherwise (`pay` in `store/index.ts`).
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

## Docs

`docs/ua-spec.html`, `docs/system-design.html` and `docs/user-flows.html` are the product
contract, and `README.md` / `UI/README.md` describe current behaviour. When a change alters
a rule, a role's screens or the request chain, update the affected docs in the same commit —
recent history shows them drifting and needing a catch-up pass.
