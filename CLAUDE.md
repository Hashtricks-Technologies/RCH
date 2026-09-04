# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Royal Care Hospital's F&B inventory and billing frontend: one item master and one stock
ledger behind a central store, a kitchen and three retail outlets, covering purchase
requisition → purchase order → goods receipt → production → issue → counter sale.

**The backend is complete: all six phases of `docs/superpowers/specs/2026-09-03-backend-design.md`
§14 are implemented.** It is a Fastify + Drizzle API on PostgreSQL (the contract for all backend
work; see *Backend* below). Sign-in is real (employee id + password), and after signing in the
frontend reads its whole state — the item master, locations, prices, menus, the payer roster and
every open document — from the server (`GET /snapshot`). **Every mutation is a server call.**
Counter billing, availability toggles, prices and menus, the whole stock-request chain (raise →
approve → issue ticket → OTP handover/override → receive, and now cancel), shop-to-shop
transfers, shop asks, the whole of production, the whole of procurement, and now the support
desk (raise → reply → resolve/close → rate) and the two server-side reports — all run against
the server, refetching just what each write changed and picking up another browser's changes
live over SSE. `UI/src/data/seed.ts` is gone, and so is `UI/src/data/ops.ts`; the store is an API
client end to end. The only state that still lives in the browser is what has nothing on the
server to be a client of — `cart`, `draft`, `prqDraft`, `drawer`, `toast`, `shopFilter`, `theme`,
`catalogVersion` — plus the theme and a few UI prefs reaching `localStorage`.

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
pnpm lint         # turbo run lint (oxlint) + knip (unused exports) + check-boundaries.sh (module/reuse rules)
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
pnpm test:e2e                                         # Playwright smoke against a running stack — needs `pnpm dev` up first
pnpm --filter @rch/api loadcheck                      # apps/api/scripts/loadcheck.mjs — needs the API up and reachable
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
e2e/                     the Playwright smoke — six files, eight scenarios, twelve runtime tests
                         (the sign-in loop is five of them), against a real stack
```

## Nested guides

Claude Code reads a package's own `CLAUDE.md` when it works inside that directory. Four of them
carry what a fresh agent needs there and would otherwise have to reconstruct; each links back
here for the repo-wide rules rather than repeating them.

| File | What it adds |
|---|---|
| `apps/api/CLAUDE.md` | The module skeleton, the exact order a write is composed in, the documents → ids → balances lock order, the protected tables and the phrases `scripts/check-boundaries.sh` greps for, idempotency-claim semantics, the SSE plugin, the test harness (`buildTestApp`, `given.*` bands, `warmPool`), migrations, CLIs, env knobs and metric names |
| `packages/contract/CLAUDE.md` | Wire types as Zod schemas and nothing else, `defineRoute` and the manifest driving both sides, closed unions, where positivity is a schema rule and where it is a service rule, `EVENTS_PATH`, fixtures as the one seed source |
| `packages/domain/CLAUDE.md` | What purity means here, the rule-per-file table, the transition tables and the `PROD_ORDER_TRANSITIONS` trap, knip's "every export has a caller", and the literal-expected-value test style |
| `UI/CLAUDE.md` | The three-file screen registry, the exact shape of a server-backed store action, `refetch`'s narrow readers, the SSE client and the shell pill, `hydrateMaster` vs the fixtures, and the fetch-stub test pattern |

Every phase's docs task refreshes **the root guide and all four nested guides in the same commit
as the spec §16 rows** it adds. A phase that moves an action to the server, adds a module, or
changes a rule leaves at least one of them wrong until it does.

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

- `src/store/procurement.ts` — vendors, requisition approval, the purchase-order lifecycle,
  goods receipt. All fourteen of its actions are API calls now; the slice holds no rule.
- `src/store/ops.ts` — support tickets, rate contracts, new-product requests, `createItem`,
  shop-to-shop transfers. Every action in it is an API call; the slice holds no rule.

Slices take `(get)` typed against `AppState`, so any action can read the whole store — neither
slice writes state directly any more, so neither takes a `set` parameter. Components subscribe
with narrow selectors: `useApp((s) => s.req)`.

Forty-seven actions are server calls — the whole store is. Phase 2's five (`pay`, `toggleAvail`,
`savePrice`, `addProduct`, `removeProduct`), Phase 3's fourteen movement actions —
`submitRequest`, `requestFromStore`, `cancelRequest`, `approveRequest`, `rejectRequest`,
`issueTicket`, `handover`, `receiveTicket`, `dispatchOrder`, `distribute` in `store/index.ts`,
and `transferToOutlet`, `askShop`, `answerShopAsk`, `declineShopAsk` in `store/ops.ts` — Phase
4's three kitchen actions in `store/index.ts` (`setOrderStatus`, `makeProduct`, `cancelTicket`),
Phase 5's twenty-one: `store/procurement.ts`'s fourteen (`addVendor`, `updateVendor`,
`setVendorActive`, `approveRequisition`, `declineRequisition`, `createPo`, `updatePoLine`,
`removePoLine`, `setPoVendor`, `setPoEta`, `sendPo`, `cancelPo`, `receivePo`, `closePoShort`),
six more in `store/ops.ts` (`requestNewProduct`, `answerProductRequest`, `addContract`,
`updateContract`, `removeContract`, `createItem`), and `store/index.ts`'s own
`sendRequisition` — and now Phase 6's last four, the support desk in `store/ops.ts`
(`raiseTicket`, `replyToTicket`, `setTicketStatus`, `rateTicket`). All forty-seven call the API
(`UI/src/api/client.ts`) instead of mutating `set` directly, then `refetch`
(`UI/src/api/refetch.ts`) pulls back only the slices the write says it changed — `GET /stock`
for `stock`/`rsv`/`ovr`, a narrow reader for every collection with one, and a full
`loadSnapshot` only for `prices` and `menu` (the manager's price/menu writes), the only two
collections left without one. A refusal throws and is toasted; the cart or form is left exactly
as it was. The `Seq` interface (`store/index.ts`) is gone entirely — every document the server
numbers is numbered there instead. `UI/src/api/events.ts` keeps every signed-in tab current with
what other tabs and other browsers do: one `fetch`-based SSE connection per session, debounced
250 ms per collection into one `refetch`, so an approval made in one window shows up in another
without a reload.

### Derived state is computed, never stored

`src/lib/selectors.ts` is the source of truth for everything derived. Do not add mirrored
fields to the store for anything it already computes:

- `qty` / `resv` / `avail` — on hand, reserved, and the difference at a location.
- `freeToPromise` — on hand less ticket reservations less quantities already committed by
  other approvals. Every approval path must go through it (C6) or stock gets double-promised.
  Enforced server-side now: `modules/requests/service.ts`'s `approve` computes it without the
  balance locks (advisory — nothing is reserved yet) and `issue-ticket` re-checks it under
  `lockBalances`, which is the actual guarantee; the UI's own copy of the arithmetic is only
  a preview while the operator types. A batch reads it the same way: `makeBatch` measures an
  ingredient's cover as `on_hand − reserved`, not what is on the shelf, so stock another
  ticket is holding cannot be baked with.
- `availOf` — a traded/finished item is off at zero; a made-to-order item is off when any
  ingredient runs out, and the returned reason names the ingredient that blocked it.
- `procurementList` — approved requisition lines less `ordered`. There is no stored pool: both
  it and the server's own `GET /requisitions` read a snapshot the server fills, and the one
  number that is actually stored is `requisition_lines.ordered_qty` — the claim a purchase
  order puts on a line. Five endpoints move it, each inside one transaction holding the order's
  row and the requisition rows: `createPo`, `updatePoLine`, `removePoLine`, `cancelPo` and
  `closePoShort` (`apps/api/src/lib/claims.ts`'s `addOrdered`). Nothing else touches it — a
  goods receipt moves stock, never a claim.
- `prqProgress`, `onOrder`, `awaitingApproval` — requisition and purchase-order progress.
  `onOrder` covers approved-but-undelivered; `awaitingApproval` covers not-yet-decided.
  A duplicate-order guard needs **both** (M3); read the comments before touching either.
- `priceOf` — applies the MRP cap at read time.

**The exception.** Two figures are **read**, not derived, because the browser holds nothing they
could be computed from: the central store's stock ledger (`readStockLedger(loc, days)`, `GET
/reports/stock-ledger`) and a payer's credit for the month (`readCredit(payer)`, `GET
/reports/credit/:kind/:id`), both in `store/index.ts`, both typed `Promise<… | null>`. Neither
notifies on success or refetches anything — they are reads, not writes — and both answer `null`
on a failed read rather than falling back to an empty array, because `null` is the one answer
never mistaken for a real one: the ledger screen's own three-state `LedgerState` (`loading` /
`failed` / `rows`) tells an outage apart from a store that genuinely carries nothing, and the
till's credit panel reads "Checking what {name} has taken this month…" rather than a false zero
while the request is in flight.

### The movement rule

**Approval authorises; the scan moves.** Approving a request or dispatching a production
order only writes a reservation into `rsv`. Stock leaves a location on `handover` and lands
on `receiveTicket`; in between it is in transit and owned by neither location (`inTransit`).
Any new movement must follow this two-step shape.

Ticket handover is gated by a six-digit code minted at random when the ticket is created
(`allocateTicket`, `apps/api/src/lib/tickets.ts`) that the collector reads aloud. A wrong code
is refused; omitting the argument entirely is the labelled supervisor override, open to `store`
and `prod` only.

There is a way back. A ticket nobody collected can be cancelled (`POST /tickets/:id/cancel`),
which releases its hold and puts the document behind it — the request or the production order
— back where it stood before the ticket was raised. Nothing moves, because nothing had moved.

The server is where this is enforced now: `apps/api/src/modules/tickets/service.ts`'s
`handover` and `receive` are the only places stock actually moves (`postMoves`), and
`modules/{requests,shopasks,production}/service.ts` only ever reserve, through
`lib/reservations.ts`. `packages/domain/src/transitions.ts` is the one table both the server's
guards and the UI's buttons read to decide which status may follow which.

Buying's claim arithmetic is the same shape one layer up. A purchase order **claims** against
a requisition line; the goods receipt **moves** stock onto the shelf. A claim is settled under
document row locks, the purchase-order row first and requisition rows second, ascending
(`apps/api/src/lib/claims.ts`) — `createPo` is the one write that takes the second half of that
order without the first, because it is minting the order the first lock would otherwise be.

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
  caps client-side previews at the till. No role, list or approval may exceed it. A goods
  receipt carries the other half: `checkReceiptLine` in `packages/domain/src/receipt.ts`
  refuses a printed MRP below the item's list-A shelf price, word for word what the store
  keeper has always read: `` `${name} — printed MRP ${money(mrp)} is below the shelf price;
  reprice before selling` ``.
- **The staff-credit ceiling is a hard monthly cap, per person.** `STAFF_CREDIT_LIMIT`
  (`packages/contract/src/schemas/common.ts`, ₹3,000) is enforced server-side inside the
  sale's own transaction by `breachesCredit` in `packages/domain/src/credit.ts`, over every
  bill charged to that staff id hospital-wide since midnight on the first of the current month
  in Asia/Kolkata (`monthStartIST`) — not one till's session. A breach is refused with
  `creditBreachMessage`, word for word what the counter's own screen has always said.
- **Lock order is fixed server-wide: documents, then ids, then balances.** A write locks the
  document row(s) it is deciding first (`for update`), allocates any id or ticket number
  second (`allocateId`/`allocateTicket`, which locks the `sequences` row), and only then takes
  the balance locks (`lockBalances` in `apps/api/src/lib/ledger.ts`). Two writers taking the
  same two locks in opposite order deadlock; every module under `apps/api/src/modules` keeps
  this order and a new one must too.
- **Nothing is created or destroyed without a document.** Enforced server-side now, in
  `apps/api/src/modules/production/service.ts`'s `makeBatch`: one `postMoves` call carries the
  `production_consume` moves and the `production_yield` in the same transaction, so there is no
  instant at which the books show one without the other. Ingredients go against what was
  *started*; only the yielded units reach the rack. The balance locks are taken over exactly
  the cells that write moves — the ingredients, and the finished item only when there is a
  yield to book — before anything is read, so a zero-yield make never creates a "carried at
  zero" row for a shelf it never touched (M12). A goods receipt is the one buying write that
  moves stock (`apps/api/src/modules/grn/service.ts`'s `receive`), and both its moves are
  **positive**: `grn_accept` at the central store for what passed inspection, `grn_reject` at
  `quarantine` for what did not. Nothing here is promised against a balance, so there is no
  `lockBalances` call of its own and no post-lock re-read. A `grn_reject` move is posted only
  when something was actually rejected, so a delivery with nothing turned away leaves
  quarantine with no line for the item at all rather than one carried at zero.
- **A claim comes back the way it went out.** Cutting a purchase-order line, removing it,
  cancelling the order or closing it short all release the claim it put on a requisition —
  **last source first** (`releaseClaim` in `packages/domain/src/claims.ts`) — so a shrink and a
  re-grow land back on the same requisition rather than quietly moving demand between two store
  keepers.
- **Selling deducts by recipe for MTO items**, by the unit otherwise — now decided server-side
  in `apps/api/src/modules/pos` (`POST /bills`) against the same rule in `packages/domain`;
  `pay` in `store/index.ts` just calls it and refetches.
- **Dispatch is all-or-nothing.** A short production order names every missing item and moves
  nothing; a repeated item is folded into one line before the cover check.
- **Costing.** `costOf` prices a made item from its recipe plus overhead — never zero. A batch
  row carries no cost column: its value is derived from `costOf` at read time, not stamped, so
  a later change to an ingredient's price re-prices every past batch's display rather than
  leaving it wrong.
- **The OTP belongs to the collector.** A ticket's six digits are minted at random when the
  ticket is created (`crypto.randomInt(100000, 1000000)` in `allocateTicket`, `apps/api/src/
  lib/tickets.ts`) and reach the wire only while the ticket is `Issued`, for a caller standing at
  the ticket's `to` location, **and** whose role is `counter`, `prod` or `store` — the three
  roles that ever collect against a code, so a manager whose home outlet happens to match the
  ticket's `to` still reads `""`. The issuing desk that printed the ticket never reads the code
  back either, not in its own write's response and not in `GET /snapshot`. `handover` compares
  what the collector says against the row it locks itself, never against a response; the
  labelled supervisor override, open to `store` and `prod` only and recorded in
  `document_history`, is the one door past a collector who is not there. (Landed in the Phase 6
  fix wave, `a8f762b`/`19d486a` — `makeOtp`, a pure function of the ticket number, came out of
  `@rch/domain`'s public surface, because a formula the browser can run is not a redaction, and
  the role check joined the location check for the same reason.)

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
  `src/data/master.ts` — empty registries filled in place by `hydrateMaster()`/`hydrateRoster()`
  from `GET /snapshot`; `src/data/seed.ts` and `src/data/ops.ts` no longer exist, and no
  production file under `UI/src` imports `@rch/contract/fixtures`. Tests reset through
  `src/__tests__/fixture.ts` (`resetStore`, `S`, `as`, `signedOut`).

## Tests

`src/__tests__/` (jsdom, `setupFiles: setup.ts` which installs a working `localStorage` when
the host does not supply one):

- `store.test.ts` — the request/ticket chain, billing, recipe depletion.
- `procurement.test.ts` — requisitions, the pooled list, PO lifecycle, goods receipt.
- `fixes.test.ts` — regression pins for previously-found defects, referenced by their tags
  (C6, M3, M8, H4, UA-14…). Read the surrounding comment before changing behaviour one covers.
- `screens.test.tsx` / `app.test.tsx` — every role × every nav key renders, bare and in-shell.
- `theme.test.ts` — theme resolution and persistence.
- `writes.test.ts` — every server-backed action (Phase 2's `pay`, `toggleAvail`, `savePrice`,
  `addProduct`, `removeProduct`; Phase 3's fourteen movement actions; Phase 4's three kitchen
  actions; Phase 5's twenty-one buying actions; and Phase 6's last four support actions, plus the
  two report reads) against a mocked client: success refetches the right slices, a refusal
  toasts and leaves state untouched.
- `events.test.ts` — the SSE client (`UI/src/api/events.ts`): frame parsing, the 250 ms
  per-collection debounce into `refetch`, `resync` forcing a full `loadSnapshot`, and the
  `live` / `reconnecting` / `off` state the shell's status pill reads.

`apps/api`'s tests give each file its own Postgres schema, `t_<name>_<pid>` (`process.pid`
keeps parallel runs from colliding), migrated once and dropped on close
(`apps/api/src/test/db.ts`). Both `apps/api/vitest.config.ts` and `UI/vite.config.ts` pin
`TZ=UTC` so IST-sensitive assertions (bill numbering across midnight, best-before rendering)
prove something on every host, not just ones already in UTC. `apps/api/src/test/builders.ts`
exports `given.{request,ticket,shopAsk,bill,prodOrder,vendor,requisition,po,contract,
productRequest,supportTicket}` — eleven builders, one row per family, seeded above the
fixture's own ids so a builder-made document can never collide with a seeded one. A test that
opens two concurrent transactions to prove a lock holds must call `warmPool(t, n)`
(`apps/api/src/test/db.ts`) first — `pg` connects lazily, so without it two "concurrent"
transactions run back to back against a single warm connection and the test passes even with
the lock removed.

## Backend

Status: **All six phases are implemented — Foundation, Ledger + POS, Movement chain + SSE,
Production, Procurement, Ops + go-live (spec §14).** Read
`docs/superpowers/specs/2026-09-03-backend-design.md` before touching anything server-side; it
records every decision already taken (§2), plus every amendment recorded during Phases 1–6
(§16), so they are not reopened in chat. `packages/domain/src/shelf.ts` is the one place the
best-before and its wording live (`DEFAULT_SHELF_LIFE_HOURS`, `bestBeforeAt`, `bestBeforeText`),
`packages/domain/src/{claims,receipt,purchasing,format}.ts` are the four places buying's shared
rules live, `voidTicket` in `apps/api/src/lib/tickets.ts` is the one door out of a ticket that
was never collected, and `quarantine` is a `StockLoc` — somewhere stock is reported — never a
`LocKey` an operator can act at.

Phase 2 added three modules to `apps/api/src/modules`, each `routes.ts` / `service.ts` /
`repo.ts` / `<name>.test.ts` like every other: `pos` (`POST /bills`, the ledger sale — pricing,
the payer rule and the cover check all run server-side, then `postMoves()` writes the stock
move and a post-lock re-read asserts `on_hand ≥ 0`), `availability` (`POST
/availability/toggle`, admitting `counter`/`manager`/`prod` each for their own scope), and
`catalog` (`PUT /prices/:list/:it`, menu add/remove — the MRP ceiling and `seq = max+1`
enforced here). `GET /stock` and `GET /bills` are scoped like `/snapshot` for a counter.

Phase 3 added four more: `requests` (raise, cancel, approve, reject, issue-ticket — the
manager's decision and the store's ticket), `tickets` (handover, receive, the shop-to-shop
`transfer`), `shopasks` (one outlet asking another directly — the shop being asked grants or
declines, never the manager) and `production` (`POST /prod-orders/:id/dispatch`, `POST
/distributions` — only the kitchen's two ticket-raising writes; batches and `makeProduct` stay
Phase 4's). Every one of them composes `apps/api/src/lib/reservations.ts` (the one door to the
`reservations` table — `reserve`, `releaseForTicket`, `reservedAt`) and
`apps/api/src/lib/tickets.ts` (`allocateTicket` then `writeTicket`, which is every ticket's
number, OTP and reservation in one place). `apps/api/src/lib/events.ts` publishes what a write
changed with `pg_notify` inside its own transaction, and `apps/api/src/plugins/sse.ts` is the
one connection per pod that `LISTEN`s for it and fans it out to every open browser stream —
`GET /events` is the one route in the whole API registered outside the `routes.ts` manifest
and `mount()`, because a stream has no JSON response schema and would hang the manifest's own
`contract.test.ts` probe.

Phase 4 finished `production` and gave `tickets` a fifth write. `POST /prod-orders/:id/status`
walks the kitchen's board (New → Accepted → In kitchen → Ready) one press at a time, refusing
`Dispatched` as either source or destination — a dispatch is a movement, with its own endpoint,
not a word on this door. `POST /batches` is the one write in the system that creates stock: it
consumes a recipe's ingredients and books the yield in a single `postMoves` call, refusing the
whole batch and naming the ingredient when the kitchen is short. `POST /tickets/:id/cancel`
(`voidTicket` in `lib/tickets.ts`) is the way back for a ticket nobody collected — it releases
the hold `releaseForTicket` placed and puts the request or production order behind the ticket
back where it stood, through an explicit status guard rather than a `REQUEST_TRANSITIONS` edge
(spec §16), so a cancelled ticket cannot re-open `approve` for a request that already has a
live one. `GET /prod-orders` and `GET /batches` are scoped like every other read.

Phase 5 added six modules — `requisitions`, `purchaseorders`, `grn`, `vendors`, `contracts`,
`productreqs` — and one write to `catalog` (`POST /items`), nineteen writes and six reads past
where Phase 4 left the manifest. A purchase order's claim on a requisition line is settled
under a document lock order narrower than the general one: the purchase-order row first, then
requisition rows ascending (`apps/api/src/lib/claims.ts`'s `lockRequisitions`), with `createPo`
the one write that locks requisition rows while holding no order lock, safe only because it is
minting the order and can never afterwards wait for an existing one. A goods receipt
(`grn`'s `receive`) is the phase's only ledger write and, because both its moves are positive,
takes no `lockBalances` of its own and no post-lock re-read — do not add either out of symmetry
with `pay`, `handover` or `makeBatch`. Three uniqueness rules — a vendor's name, a live rate
contract on a vendor and item, an item's name — are decided the way `addMenuItem` always was:
a pre-check gives the operator's sentence, and the insert (or update, against
`vendors_name_ci_uq`, the partial unique index `rate_contracts_live_uq`, and `items_name_ci_uq`)
is the arbiter that catches the race. `"prq"`, `"po"`, `"vendor"` and `"contract"` join
`IdKind`; a GRN does not — `GRN-<yy><po number>-<nn>` (`grnId(poId, n)` in
`packages/domain/src/ids.ts`) has no `sequences` row at all, `nn` counting that order's own
instalments under its `for update` lock.

Phase 6 added two modules, `support` and `reports`, and closed every remaining in-memory path.
`support` mounts the desk's four writes (`raiseTicket`, `replyToTicket`, `setTicketStatus`,
`rateTicket`) and its one read (`GET /support/tickets`), every one of them scoped to the
caller's own tickets by `by_user` — there is no support-agent role, so "own tickets only" is
the whole rule, and a ticket somebody else raised answers 404, not 403, the same shape a role's
missing module has. A support ticket's history *is* its conversation
(`support_messages`); no module here writes `document_history`. `reports` answers exactly two
queries the browser cannot assemble from its own snapshot — `GET /reports/stock-ledger` (a
location's opening/received/issued/closing over a window, `packages/domain/src/reports.ts`'s
`ledgerRow`) and `GET /reports/credit/:kind/:id` (a payer's credit taken this calendar month,
`apps/api/src/lib/credit.ts`'s `creditTakenThisMonth`, the same query `pos`'s sale now shares
rather than keeping its own copy) — and every other report and dashboard stays client-side, as
the rule asks: a report needing more than the caller's own snapshot slice becomes a server
query, and exactly two do. `apps/api/src/modules/tickets/service.ts`'s `handover` and `receive`
also gained a third linked-document branch: a ticket raised to answer a shop's ask now writes
back to `shop_asks` on cancellation the same way a request or a production order already did,
through `SHOP_ASK_TRANSITIONS.Sent → Asked` (`packages/domain`), and `cancelTicket` opened to
`counter` for a ticket the counter's own outlet raised. A ticket's `hist` (`document_history`,
read back through `TicketSchema.hist`) is on the wire for the first time, and its OTP is
withheld from everyone except a caller at the ticket's `to` while it is `Issued` — see the
root guide's OTP invariant, above, for the fix-wave note on where the six digits actually come
from.

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
  thing that writes it or `stock_balances`. `reservations` is protected the same way — only
  `apps/api/src/lib/reservations.ts` writes it, and `scripts/check-boundaries.sh` keeps it
  that way.
- Status transitions are a table in `packages/domain/transitions.ts`, read by both sides.
- `GET /events` is the one route outside the manifest — `plugins/sse.ts` registers it directly
  because a stream never resolves and has no response schema for `mount()` to serialise.

Build order was spec §14 — six phases, each cutting one role's work over to the server and
deleting its in-memory path; nothing dual-ran. "Production ready" is the checklist in spec §12,
which gated every phase and now gates go-live itself. Phase 1's frontend cutover was real
sign-in and `/snapshot` hydration (`hydrateMaster`) in place of `data/master.ts`'s static
registries. Phase 2 cut counter billing, availability toggles and the manager's price/menu
writes over to the server (`pay`, `toggleAvail`, `savePrice`, `addProduct`, `removeProduct`,
above). Phase 3 cut over the whole stock-request chain, shop transfers, shop asks and the
kitchen's two ticket-raising writes and added the live-update stream so every open screen sees
another browser's write. Phase 4 finished production — the kitchen's board and its batches —
and added ticket cancellation. Phase 5 cut over the whole of procurement — requisitions, the
buyer's decision, the purchase-order lifecycle, goods receipt with tolerance and quarantine,
vendors, rate contracts and every screen that adds a product. Phase 6 closed the support desk
and `UI/src/data/seed.ts`, the last two things left in the browser's own store, added the two
server-side reports, wired up the alerts, the load check and the Playwright smoke, and prepared
the chart and the workflow for a first production deploy — it does not perform that deploy
itself (spec §16, Phase 6). **The operational entry points from here are spec §12's checklist**
— what "production ready" means, line by line — **and `deploy/RUNBOOK.md`'s §11 go-live
checklist**, which turns that list into the ordered commands and decisions an account owner
actually runs. Every other operational procedure — deploy, roll back, rotate keys, accounts,
restore drill (locally rehearsable now, §6), SSE operations, the load check (§12), the
end-to-end smoke (§13) — is also `deploy/RUNBOOK.md`.

## Docs

`docs/ua-spec.html`, `docs/system-design.html` and `docs/user-flows.html` are the product
contract, and `README.md` / `UI/README.md` describe current behaviour. When a change alters
a rule, a role's screens or the request chain, update the affected docs in the same commit —
recent history shows them drifting and needing a catch-up pass.
