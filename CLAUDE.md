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
server to be a client of — `cart`, `draft`, `prqDraft`, `drawer`, `toast`, `authError`,
`shopFilter`, `theme`, `catalogVersion` — plus the theme and a few UI prefs reaching `localStorage`.

**Five doors were added after Phase 6, in the audit fix wave's fourth block (2026-09-11)**, and
they are the only new capabilities since the six phases closed: a **write-off or a stock count is
a document** (`POST /adjustments`), a **bill can be taken back on the day it was billed**
(`POST /bills/:no/void`), the **item master is editable and retirable** (`PATCH /items/:it`), the
**payer roster is kept from a screen** instead of being seeded once (`POST`/`PATCH /payers`,
`GET /payers`, and a CSV import CLI for a ward list), and an **outlet can ask the kitchen to make
something** (`POST /prod-orders`) rather than only working orders that arrived from nowhere. Each
is a row in the spec's §16 wave-4 table.

## Branches

Three long-lived branches, one environment each. Code moves forward only, by fast-forward
merge, so what reaches production is byte-identical to what passed on staging.

| Branch | Role | Deploys to |
|---|---|---|
| `develop` | **Default.** All work lands here (feature branches by PR, or direct commits while the team is one person). | Nothing automatic today — the dev environment at https://rch.hashtrickstechnologies.com is one EC2 instance under Docker Compose (`deploy/RUNBOOK.md` §16), deployed by hand with `git pull && deploy/compose/deploy.sh`. The EKS path (`rch-dev` namespace, `values-dev.yaml`, one spot node) is prepared and `DEPLOY_ENABLED` is `false` so a push cannot try it against a cluster that no longer exists (§15) |
| `staging` | Release candidate | `rch-staging` namespace, once CI is green on that push |
| `production` | What the hospital runs | `rch` namespace, once CI is green on that push, behind a GitHub environment approval |

Promote with `git checkout staging && git merge --ff-only develop && git push`, then the same
from `staging` into `production`. Never merge the other way except a hotfix: branch from
`production`, PR into `production`, then merge `production` back into `staging` and `develop`.
`main` no longer exists; it was renamed to `develop` on 2026-09-03.

**One thing the fast-forward model does not cover: the workflow file itself.** `deploy.yml` is
triggered by `workflow_run`, and GitHub always executes a `workflow_run` handler as it exists on
the **default branch** (`develop`) — never the copy on `staging` or `production`. So an edit to
`deploy.yml` governs a production deploy the moment it lands on `develop`, not when `production`
is promoted. `deploy/RUNBOOK.md` §2 says what to do about it.

## Commands

This is a pnpm + Turborepo monorepo (`pnpm-workspace.yaml`: `packages/*`, `apps/*`, `UI`, `e2e`).
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
pnpm --filter @rch/api payers import --csv <file> [--replace-names]   # a ward list, kind,id,name
pnpm --filter @rch/api keys:generate                  # prints a new JWT_PRIVATE_KEY= / JWT_PUBLIC_KEY= pair
pnpm helm:test                                        # deploy/chart/rch/tests/render.test.sh
pnpm test:e2e                                         # Playwright smoke against a running stack — needs `pnpm dev` up first
pnpm --filter @rch/api loadcheck                      # apps/api/scripts/loadcheck.mjs — needs the API up and reachable
```

`pnpm --filter @rch/ui test` runs just the UI's vitest suite (`npx vitest run
src/__tests__/procurement.test.ts` etc. still works from inside `UI/` for a single file).

`SEED_PASSWORD` is **required** and at least twelve characters (`apps/api/src/config.ts`) — there
is no default any more, so a fresh `.env` will not start the API, the tests or any CLI until one
is chosen. `db:seed` refuses outright where `NODE_ENV` is `production` unless it is passed
`--yes-seed <database name>` matching `select current_database()`, and `--force` there
additionally needs `--yes-destroy <database name>` (`apps/api/src/cli/seed.ts`, whose rules are
the pure `seedGuard` in `apps/api/src/lib/seed-guard.ts`). That matters in the cluster, not only
on a real hospital: the chart renders `NODE_ENV=production` into every pod, so an in-cluster seed
is always the `--yes-seed` form (`deploy/RUNBOOK.md` §15.7). The older `--allow-production` is
kept only so a copied command fails loudly — on its own it is refused, naming `--yes-seed`,
because a flag every in-cluster seed carries is one nobody reads.

From the repo root, `bash scripts/build-site.sh` assembles the published site into `dist/`
(`/` = `index.html`, `/docs/` = the HTML specs). Netlify and CI both run this exact script, so a
broken assembly fails locally the same way. `/app/` — the built React app, from `UI/dist` — is
assembled **only when `BUILD_APP=1`**, which CI sets and Netlify deliberately does not: a static
copy of the app with no `/api` behind it could sign nobody in, so `netlify.toml` redirects
`/app` and `/app/*` (302, `force = true`) to the deployment that has an API. The script still
runs `pnpm --filter @rch/ui build` either way — a site build that stopped compiling the app
would otherwise stop noticing when the app stopped compiling — and prints which of the two it
did.

CI (`.github/workflows/ci.yml`) runs `pnpm install --frozen-lockfile` → `pnpm turbo typecheck
test` → `pnpm lint` (oxlint per package plus knip, which turbo never runs) → `pnpm
check:boundaries` → `pnpm audit` → `bash scripts/build-site.sh` on Node 24, then builds both
images, scans them with Trivy at `CRITICAL,HIGH` and does a real `helm install` against a
throwaway kind cluster. Every change must pass all of it. Four details worth knowing before you
debug a red run:

- **`test` is `"cache": false` in `turbo.json`** — turbo hashes source files, not the database the
  API suite runs against, so a cache hit would replay a green from before a migration.
- **Lint is a zero-warning gate.** Every package's `lint` script is `oxlint --max-warnings 0`, so
  a warning fails the job exactly as an error does; there is no tier for warnings to pile up in.
  `react/rules-of-hooks` and `react/exhaustive-deps` are at **error**, and `react/jsx-key` and
  `react/only-export-components` are **off for `UI/src/**` with the argument written out** in
  `UI/.oxlintrc.json` — the first because all 252 findings were `DataTable`'s positional cell
  arrays, the second because the drawer registry is an architecture of side-effect modules that
  export nothing.
- **Coverage floors are part of `vitest run`, per package** — UI lines 73 / branches 51,
  `apps/api` 94 / 79, `packages/domain` 99 / 92, `packages/contract` lines 96 (no branch floor;
  the package has two branch points and neither is exercised). Each sits a point or two under
  what that suite measures today. Raise one when the real figure rises; never lower one to make a
  red run green. `--coverage` is on the `test` script rather than `enabled` in the config, so a
  single-file run is not judged against the whole package's figure.
- **`pnpm audit` now fails** the job when the registry is unreachable on all three attempts
  rather than warning — "we did not look" is not "no advisories". An accepted CVE goes in
  `.trivyignore.yaml` (YAML, with a `statement` and a real `expired_at`; the plain-text
  `.trivyignore` it replaced had no expiry field at all, so its dates were decorative). **An
  expiry that lapses fails all four scans closed** — CI's two and `deploy.yml`'s two — so check
  them before a promotion (`deploy/RUNBOOK.md` §11 step 7) rather than on the day.

**`deploy.yml` no longer runs `on: push`.** It is `workflow_run` on CI's completion, gated on
`conclusion == 'success'` **and** `event == 'push'`, and every value it uses comes from
`github.event.workflow_run.head_sha` / `head_branch` — `github.sha` and `github.ref_name` point
at the default branch's tip under this event and are unusable. It re-scans the exact ECR tags
helm is about to deploy before upgrading, and production upgrades with `--wait` but deliberately
**without** `--atomic`. See `deploy/RUNBOOK.md` §2 and §3.

## Repository layout

```
index.html               project home page (published at /)
docs/*.html              UA spec, system design, user flows — the product contract
docs/superpowers/        plans and specs from prior agent-driven work
scripts/build-site.sh    assembles index.html + docs/ into dist/ (+ UI/dist when BUILD_APP=1)
netlify.toml             the published site's build, headers and the /app → EKS redirect
UI/                      the application (React 19, TS 6 strict, Vite 8, Zustand 5)
e2e/                     the Playwright smoke — seven files, twelve scenarios, seventeen runtime tests
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

Five roles: `counter` · `manager` · `store` · `prod` · `buyer` (see `UI/src/types.ts`) — still
five. Account management (create a colleague's account, reset a password, deactivate one, move
somebody to a different role or location) is `admin`, a boolean on `users`, orthogonal to `role`
and checked as its own `Access` value (`"admin"`, `apps/api/src/plugins/rbac.ts`) — not a sixth
role, no sidebar entry, no `roles/admin/` folder. An admin-flagged account gets no operational
Shell at all: `App.tsx` sends it to `/admin` — a standalone page with its own header, not one of
the five roles' screens — whatever key it asks for, so its nominal `role`/`loc` (required by the
schema, meaningless otherwise) is never shown. There is exactly one such account, seeded rather
than granted after the fact (`RC-0001`, `packages/contract/src/fixtures/master.ts`), so every
environment that runs `db:seed` starts with one ready to sign in; the flag itself is granted or
revoked only by `pnpm --filter @rch/api users set-admin` — there is no route for it, so a
compromised admin session can create or reset ordinary accounts but never mint a second admin.

**`manager` is hospital-wide.** One outlet manager supervises every outlet, so a manager's writes
take **no** location: approve, reject, the price lists and the menus all decide for any outlet and
call no `requireLoc`. The one manager write that touches a location at all is `cancelRequest`, and
it scopes for `counter`/`prod` — the raiser's own outlet — and deliberately not for the manager
(`apps/api/src/modules/requests/service.ts`'s `cancel`, and the comment above `approve` beside it).
`counter` and `prod` are the location-scoped roles; `store` and `buyer` work one desk each.

**The wave-4 capabilities landed as three new sidebar keys and four new drawers.** The manager
gained **Bills** (`bills` — every outlet's, seven days, with the Void button on a bill still on
today's date) and **Payers** (`roster` — the register a non-cash tender is charged to, closed
accounts included); the store keeper gained **Adjustments** (`adjust` — the write-off register and
the form over every `StockLoc`, quarantine among them). The rest are drawers rather than screens,
because they hang off a table that already exists: `"item"` (`roles/manager/ItemDrawer.tsx`, the
first drawer four role indexes import, greying its own boxes off `@rch/domain`'s
`mayEditItemField`), `"adjstock"` (`ui/AdjustmentForm.tsx`, registered in the shared form because
the manager and the kitchen both open it), `"korder"` and `"cpord"` (the manager's kitchen-order
drawer and the counter's read-only view of an order it raised). The counter's own way in is a
card, not a key — **Ask the kitchen**, on the existing `requests` screen — so no nav entry moved
for it.

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

Routing is `BrowserRouter` — plain paths (`/pos`, `/admin`), not `#/pos`. Every place this app
is actually served already falls an unmatched path back to `index.html` (Vite's dev proxy, the
`try_files $uri /index.html` both the single-EC2 box's and the EKS ingress's nginx carry), so the
SPA-rewrite problem `HashRouter` used to dodge does not arise for a host this app runs on.

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

Fifty-three actions are server calls — the whole store is. Phase 2's five (`pay`, `toggleAvail`,
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
`sendRequisition` — Phase 6's four, the support desk in `store/ops.ts` (`raiseTicket`,
`replyToTicket`, `setTicketStatus`, `rateTicket`) — and the audit fix wave's own six:
`voidBill` and `raiseProdOrder` in `store/index.ts`, and `updateItem`, `addPayer`, `updatePayer`
and `createAdjustment` in `store/ops.ts`. All fifty-three call the API
(`UI/src/api/client.ts`) instead of mutating `set` directly, then `refetch`
(`UI/src/api/refetch.ts`) pulls back only the slices the write says it changed — `GET /stock`
for `stock`/`rsv`/`ovr`, and a **narrow reader for every other collection**, `prices` and `menu`
(the manager's writes) included since the audit fix wave, and `roster`, `payers` and
`adjustments` arriving with a reader of their own rather than a fallback. No write costs a `loadSnapshot` any
more: taking one pulled the whole hospital back down, and put every screen behind the loading
splash while it did, so a one-field price edit blanked the till. The snapshot fallback stays in
`refetch` as the guard for the next collection added to `CollectionSchema` and not to `NARROW`,
which is now the only thing that can reach it. A refusal throws and is toasted; the cart or form is left exactly
as it was, and **every one of the fifty-three answers whether the server took the write** —
`pay`, `savePrice`, `addProduct` and `removeProduct` became `Promise<boolean>` in the audit fix
wave, so none of them is `Promise<void>` where a caller might need to know. The `Seq` interface
(`store/index.ts`) is gone entirely — every document the server
numbers is numbered there instead. `UI/src/api/events.ts` keeps every signed-in tab current with
what other tabs and other browsers do: one `fetch`-based SSE connection per session, debounced
250 ms per collection into one `refetch`, so an approval made in one window shows up in another
without a reload; the shell's header dot reads `live` / `reconnecting` / `off` off that same
state, and `App.tsx` puts a banner over everything when `navigator.onLine` is false.

**A document in the store carries the instant, not only the printed time.** `UI/src/types.ts`'s
`Dated<T>` / `Trailed<T>` / `DatedDoc<T>` put `iso` — the server's own stamp, verbatim — beside
the `"HH:MM"` `api/wire.ts` formats, on every document and every history entry, in the snapshot
and in each narrow reader. Sort a time column on `iso`, never on the printed string, and filter
anything labelled "today" with `isToday(iso)` (`UI/src/lib/fmt.ts`), whose day boundary is
Asia/Kolkata's midnight rather than the host's. Before it, "is this today?" was really "is this
in the last seven days?" (`GET /bills` returns seven and nothing filtered them) and "which is
latest?" compared `"22:00"` against `"09:00"` across different days.

**Two tabs of one operator no longer sign each other out.** Refresh tokens rotate, so a
simultaneous 401 in two tabs presented the same rotated token and the server's reuse detection
revoked the whole family. `UI/src/api/client.ts` now refreshes inside
`navigator.locks.request("rch-refresh", …)`, broadcasts the new token on
`BroadcastChannel("rch-session")` — which only ever *replaces* a token a tab already holds,
never hands one to a signed-out tab on a shared terminal — and checks the token generation
inside the lock, so a tab that waited answers "retry", not "refresh again".

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
- `activeItems()` / `isRetired(it)` — what a picker may still offer. `hydrateMaster` fills `IT`
  with the **whole** master, retired lines included, because a bill or a purchase order raised
  months ago still names one and a screen that dropped it would print a raw key where a product
  name belongs. Every picker reads `activeItems()` instead of `Object.keys(IT)`; a stock screen
  keeps a retired line that still has stock on it, greyed, because that stock is exactly the work
  the retirement is waiting on.

**The exception.** Two figures are **read**, not derived, because the browser holds nothing they
could be computed from: the central store's stock ledger (`readStockLedger(loc, days)`, `GET
/reports/stock-ledger`) and a payer's credit for the month (`readCredit(payer)`, `GET
/reports/credit/:kind/:id`), both in `store/index.ts`, both typed `Promise<… | null>`. Neither
notifies on success or refetches anything — they are reads, not writes — and both answer `null`
on a failed read rather than falling back to an empty array, because `null` is the one answer
never mistaken for a real one: the ledger screen's own three-state `LedgerState` (`loading` /
`failed` / `rows`) tells an outage apart from a store that genuinely carries nothing, and the
till's credit panel reads "Checking what {name} has taken this month…" rather than a false zero
while the request is in flight. **`loadPayers` (`store/ops.ts`) is the third of that family** —
the manager's Payers screen calls it on mount because nothing on the snapshot carries the closed
accounts, and it calls `applyPayers` directly rather than going through `refetch`, whose failure
sentence ("Saved — but the screen could not be refreshed") is about a write that already landed.
It is a read, so it is not one of the fifty-three.

### The movement rule

**Approval authorises; the scan moves.** Approving a request or dispatching a production
order only writes a reservation into `rsv`. Stock leaves a location on `handover` and lands
on `receiveTicket`; in between it is in transit and owned by neither location (`inTransit`).
Any new movement must follow this two-step shape.

Ticket handover is gated by a six-digit code minted at random when the ticket is created
(`allocateTicket`, `apps/api/src/lib/tickets.ts`) that the collector reads aloud. A wrong code
is refused **and counted**: `tickets.otp_attempts` (migration `0008`) holds the guesses, and the
sixth attempt reads `<id> is locked after five wrong codes — the store or the kitchen can hand it
over with a supervisor override, or cancel it and issue a new one`. Omitting the argument entirely
is that labelled supervisor override, open to `store` and `prod` only.

There is a way back, at two stages. A ticket nobody collected can be cancelled
(`POST /tickets/:id/cancel`), which releases its hold and puts the document behind it — the
request, the production order or the shop ask — back where it stood before the ticket was raised.
Nothing moves, because nothing had moved. And **an approved request can be withdrawn before a
ticket exists at all**: `REQUEST_TRANSITIONS` reaches `Cancelled` from `Manager approved` and
`Partially approved` as well as from `Draft` and `Request sent`, and `cancelRequest` is open to
`manager` alongside `counter` and `prod` — the manager withdrawing their own approval. The door is
shut the moment the store issues a ticket: `cancel` refuses a request at `Ticket issued` with
`<id> already has ticket <tkt> — cancel the ticket instead`, and every later status falls through
to `assertTransition`'s own `is already <status>` rather than naming a ticket nobody can withdraw.
A withdrawal after an approval writes `Cancelled — never issued` to the trail, so the paperwork
says which of the two it was.

The server is where this is enforced now: `apps/api/src/modules/tickets/service.ts`'s
`handover` and `receive` are the only places stock actually moves (`postMoves`), and
`modules/{requests,shopasks,production}/service.ts` only ever reserve, through
`lib/reservations.ts`. `packages/domain/src/transitions.ts` is the one table both the server's
guards and the UI's buttons read to decide which status may follow which.

**Two writes change a shelf without a movement, and both are corrections rather than exceptions.**
An adjustment (`POST /adjustments`) has no two ends — a write-off or a count is one shelf being
put right — so it posts `adjustment` moves against one location under the same balance locks, and
a write-off may take no more than `on_hand − reserved`, because what a ticket is holding is
somebody else's promise and not this shelf's to destroy. A bill void (`POST /bills/:no/void`)
posts one **positive** `reversal` move per move the sale wrote, each carrying `reverses_id`, at
that move's own location — which is what makes a made-to-order bill explode back into the
ingredients the sale actually took rather than into a portion of a dish no shelf ever carried.

**And one write promises nothing at all.** `POST /prod-orders` raises a production order without
reserving a gram: `dispatch` is still what reserves and `handover` still what moves, so `raise`
takes no `lockBalances` — the `grn` rule read the other way round, because `lockBalances` creates
the row it locks and a write with no cell to move must not mint one (M12).

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
`Alert`, `Section`, `Field`, `FormRow`, `Toolbar`, `TableFoot`, `Kpis`, `Grid`, `Otp`,
`DraftLineInput`, `EtaInput`, `useLineKeys`, …). Use them instead of bespoke markup. Styling is plain CSS in `src/styles.css` —
one token set on `:root`, redefined under `@media (prefers-color-scheme: dark)` guarded by
`:root:not([data-theme="light"])`, and again under `[data-theme="dark"]` so an explicit
choice wins in both directions. No CSS framework.

## Domain invariants

These are enforced in code and pinned by tests. Breaking one is a bug, not a style choice.

- **MRP is a hard ceiling.** Traded items carry a printed MRP. `packages/domain` holds the
  rule; the server enforces it (`PUT /prices/:list/:it` refuses above it, verbatim: `Refused —
  printed MRP of ₹<mrp> is a hard ceiling for <item>`) and `priceOf` in `selectors.ts` still
  caps client-side previews at the till. No role, list or approval may exceed it. A goods
  receipt carries the other half: the floor sentence is produced once, by `mrpBelowShelfPrice`
  in `packages/domain/src/receipt.ts`, word for word what the store keeper has always read
  — `` `${name} — printed MRP ${money(mrp)} is below the shelf price; reprice before selling` ``
  — and it has **two** callers now: `checkReceiptLine`, which judges a delivery against the
  item's list-A price, and `PATCH /items/:it`, which judges an edited MRP against the **highest**
  list the item sits on, because a ceiling that clears one counter and not the other is still a
  counter that cannot sell. **And there is no clearing door.** An item that carries a printed MRP
  keeps one: `patchItem` refuses `mrp: 0` with `Give the printed MRP a value — an item that
  carries one keeps it`, `ItemPatch.mrp` is typed `number` rather than `number | null` so the
  type itself says so, and the manager's drawer omits the field entirely when the box is emptied.
  A ceiling removed in a keystroke, with `Updated` in the trail and nothing on the record saying
  a ceiling had gone, is what that refusal exists to prevent (`Ruling:` in the wave's own
  progress log reverses the first implementation, which read a zero the way `createItem` reads a
  blank box).
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
  this order and a new one must too. **There are exactly two documented exceptions, and neither
  can be copied without the argument that makes it safe:** the counter sale takes its bill number
  *after* the balance locks and the cover check (`allocateId(tx, "bill", at)` in
  `apps/api/src/modules/pos/service.ts`), and an adjustment takes its `ADJ-` number in the same
  place (`apps/api/src/modules/adjustments/service.ts`), because each call site is the **only**
  caller of its own sequence row in the tree — no second writer ever
  takes it, so the two-writers-opposite-orders cycle a lock order exists to prevent cannot form.
  The adjustment's inversion was a review finding, not a design: with the id taken first, the
  module's own two-writers race case passed with **both** balance guards deleted, because the
  second writer blocked on the `adj` sequence row before it ever read a balance. An id taken at
  the head of a transaction masks every balance guard behind it, and a race test that cannot fail
  is worse than none.
  What taking it earlier cost was real: a till queued behind a shelf sat on the one row every
  till in the hospital draws its bill number from, so one slow sale froze the rest. Numbers stay
  **gapless through a refusal** either way — `allocateId` is an UPDATE inside the write's own
  transaction, so a rollback hands the next writer the number the refused one was standing on
  (`apps/api/src/lib/ids.ts`, and `allocateTicket` beside it).
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
  quarantine with no line for the item at all rather than one carried at zero. The same rule
  runs one level down, in `postMoves` itself (`apps/api/src/lib/ledger.ts`): **a move whose
  quantity rounds away to nothing at three decimals is dropped before anything is locked or
  inserted**, row by row rather than by cell, so a crumb cannot take the real move beside it
  down. A move of zero is not a movement — `stock_moves_qty_ck` (migration `0008`) says so — and
  a recipe measured in millilitres against a single cup is how one turns up; dropping it is what
  keeps that sale from reading as a 500 with no words in it, and what stops `lockBalances`
  minting a "carried at zero" shelf line for a cell nothing touched (M12). **A bill void is the
  second write whose moves are all positive**, and it takes no `lockBalances` of its own and no
  post-lock re-read for exactly the reason `grn`'s `receive` takes neither: a reversal is a sale's
  negative move negated, so nothing here is promised against a balance. Do not add either out of
  symmetry with `pay`, `handover` or `makeBatch`.
- **A write-off is a document.** `POST /adjustments` (`apps/api/src/modules/adjustments`) is the
  one door that corrects a shelf, and it writes a numbered document with a reason, a note and a
  signature before it writes a move: `ADJ-<year>-<nnnn>`, a closed six-value reason
  (`wastage`, `breakage`, `expired`, `count`, `returned_to_vendor`, `other`, worded once by
  `REASON_LABEL` in `packages/domain/src/adjustments.ts` and read by both sides), and
  `postMoves` with `kind` and `refType` both `"adjustment"`. Four rules hold it together.
  Lines are folded on the **signed** sum before anything is checked, so two lines naming one item
  are two halves of one correction. A negative line may not exceed `on_hand − reserved`, checked
  under `lockBalances` and re-checked after `postMoves`. **`stock_moves.reverses_id` stays null
  for every adjustment, `count` included** — a reversing move undoes one named move, and a count
  corrects a *sum*; pointing it at the most recent move would read as "this undid that", which is
  not what a physical count found. And the scope is decided per role in `routes.ts`: the store
  keeper corrects any `StockLoc` including `quarantine`, a manager only an outlet
  (`You can only adjust stock at an outlet — the central store writes off its own shelves`), the
  kitchen only the kitchen. That last cut is why `CreateAdjustmentBodySchema.loc` is the one write
  body in the contract typed `StockLocSchema` rather than `LocKeySchema`: an adjustment is not a
  movement, and the rejected-goods shelf has to be correctable or it only ever grows.
- **A bill is voided on the day it was billed, and no later.** `POST /bills/:no/void` is the
  manager's door and only the manager's — a till that could unsell its own takings is not a till
  anybody reconciles — and the window is the hospital's own calendar day (`istDate(bill.at) ===
  istDate(at)`, `@rch/domain`'s `istDate`), so a bill taken at 23:59 IST is still voidable at
  00:05 the same IST day only if that is still the same day, and one from yesterday reads
  `<no> was taken on <DD-MMM-YYYY> — a bill can only be voided on the day it was billed; write the
  stock back on with an adjustment instead`. **A void mints no document**: no `allocateId`, no new
  `IdKind` — it is a stamp on the bill that exists (`voided_at`, `voided_by`, `void_reason`,
  migration `0012`) plus reversals of the moves that exist, and the bill is never erased. A voided
  bill is out of the staff-credit ceiling (`lib/credit.ts`'s `creditTakenThisMonth` filters
  `voided_at is null`, so voiding one gives that person their room back for the month) and out of
  the dashboard's sales columns (`readSales`), while `readBills` still lists it, badged. Every
  client-side figure that counts money or quantity sold skips it too — the counter's Bills and
  Dashboard, the manager's Dashboard, the store's movers report — while the activity feed, the
  command palette and the bill lists still show it with `VOIDED` beside it. A credit note after
  the day is out stays declined; the refusal names the adjustment as the door that is open.
- **The item master is editable, and editable by desk.** `PATCH /items/:it` is the second door
  the master has, and `ITEM_FIELD_ROLES` (`packages/domain/src/items.ts`) is the whole of the
  permission: the manager owns `mrp`/`cost`/`gst`, the store keeper, buyer and kitchen own
  `n`/`hsn`/`rl`/`grp`, all four own `active`, the counter owns none — a till sells the master, it
  does not edit it. One table, two enforcers: the server refuses with it and the drawer disables
  the same boxes with it, which is exactly the §5.1 test for a rule belonging in `@rch/domain`.
  **A line is retired, never deleted**, and the retirement is refused while stock sits anywhere
  (named) or any outlet still lists it (named), stock asked about first. `Retired`/`Restored`
  are written to the trail only when the flag actually **crosses** — setting `active: true` on a
  line that was already live writes `Updated`, because a trail saying something happened that did
  not is a false record. And the master splits in two on the way out: `loadItems`
  (`apps/api/src/lib/master.ts`, what every *rule* reads) still filters `active`, so nothing may
  price, promise or bill a line the hospital stopped carrying, while `readItems`
  (`modules/snapshot/readers/master.ts`) carries the whole master with `active` on every line,
  because a past document still names a retired item and its screen needs the name.
- **A production order is for finished goods only, and promises nothing until it is dispatched.**
  `POST /prod-orders` admits `counter` and `manager`: a counter never names the outlet (the route
  pins `from` to the token, and a body naming another shop is a 403, not a silent rewrite) and a
  manager must, because one manager supervises every outlet and the server cannot guess which one
  is short. An MTO item is refused with its own sentence — `<item> is made to order at the counter
  — it is not ordered from the kitchen` — ahead of the general `<item> is not made in the kitchen
  — raise a stock request for it instead`, because an MTO order is unfillable end to end:
  `makeBatch` refuses to stock a phantom shelf of one and `distribute` refuses to send one, so
  `dispatch` would have had nothing to cover the line with and the order would have sat on the
  board until somebody declined it. (The brief said `FG || MTO`; the ruling that reversed it is
  spec §16's wave-4 row.) The line must also be on that outlet's own menu, refused in
  `distribute`'s own words. `need_by` is nullable on purpose — most orders carry no deadline, and
  a defaulted date would print one on every order nobody set — and the raise writes `"Raised"` to
  the trail while `"New"` stays the *status* on the board.
- **A payer is deactivated, never deleted.** The roster is master data with no `IdKind` and no
  `sequences` row — the id is the hospital's own number — and the composite primary key
  `(kind, id)` is the arbiter of `<id> is already on the <label> roster`, the third member of the
  insert-is-the-arbiter family after `vendors_name_ci_uq` and `rate_contracts_live_uq` and the
  first whose arbiter is a primary key. Switching one off takes it off every till's picker
  (`posRepo.payer` filters `active`) and leaves every bill already charged to it untouched, which
  is why `PayerSchema` — the shape a bill embeds — carries no `active` at all and
  `PayerRecordSchema` does. **Two reads sit over one table**: `GET /roster` is the till's, live
  rows only, scoped by `scopeRoster` like everything else a non-billing role must not see; `GET
  /payers` is the manager's, every row regardless of `active`, because a payer switched off last
  week is one nobody could otherwise reopen.
- **A claim comes back the way it went out.** Cutting a purchase-order line, removing it,
  cancelling the order or closing it short all release the claim it put on a requisition —
  **last source first** (`releaseClaim` in `packages/domain/src/claims.ts`) — so a shrink and a
  re-grow land back on the same requisition rather than quietly moving demand between two store
  keepers.
- **A delivery counts for what the shelf accepted, not for what the lorry carried.**
  `netReceived({ recv, rejected })` (`packages/domain/src/receipt.ts`) is the one place that
  difference is taken, and every question about whether the vendor has *delivered* is asked of
  it: `receiptStatus` covers a line at `netReceived >= qty`, so a wholly rejected consignment
  leaves the order `Partially received` rather than stranding it at the terminal `Received` with
  nothing on the shelf; `shortfallClaims` releases `qty − netReceived`, so a rejected quantity
  goes back on the procurement list with the rest of the balance; and the 2% tolerance measures
  **net prior plus this arrival's gross**, which is what lets a replacement delivery for goods
  already turned away get in at all. `po_lines.received_qty` stays the **gross** arrival record
  and `rejected_qty` the running total quarantined — the paper trail of what came through the
  door — and `po_lines_receipt_ck` (migration `0008`) holds `0 ≤ rejected ≤ received`. One
  consequence worth knowing before reading a report: because the tolerance nets the prior
  instalments but not this one, gross arrival against an order is no longer bounded by 102% of
  what was ordered.
- **Selling deducts by recipe for MTO items**, by the unit otherwise — now decided server-side
  in `apps/api/src/modules/pos` (`POST /bills`) against the same rule in `packages/domain`;
  `pay` in `store/index.ts` just calls it and refetches.
- **A made-to-order item is never ordered, batched or distributed.** It is assembled at the
  counter when it is sold, and it carries no stock line of its own — so a batch of one would
  book yield onto a shelf nothing ever reads, and distributing one would move units that do not
  exist. `makeBatch`, `distribute` and now `raise`
  (`apps/api/src/modules/production/service.ts`) each refuse
  it outright, each in its own words — `<item> is made to order at the counter — it is not
  batched` / `… it is not distributed` / `… it is not ordered from the kitchen` — the batch guard
  sitting between the kitchen-override check and the recipe
  check, so an MTO item with a perfectly good recipe is still refused. The browser's pickers
  agree: `kitchenItemsAt` (`UI/src/ui/KitchenOrderForm.tsx`) offers `t === "FG"` only, and a menu
  with nothing the kitchen makes renders a sentence saying so instead of an empty picker and a
  Send button that could never be pressed.
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
  what the collector says against the row it locks itself, never against a response, and in
  **constant time** (`timingSafeEqual`, on equal-length buffers). **Five wrong codes and the
  ticket is shut for good**: `tickets.otp_attempts` counts them, the sixth attempt reads the
  locked sentence even when the code offered is right — the digits are what has been guessed at
  — and the count is never reset, not by a correct code and not by a cancellation. The counting
  is why `handover` is the one write in the server that does not simply `return
  withTransaction(...)`: the increment has to survive the refusal that caused it, so the
  transaction commits the count and hands back a `{ refuse }` marker, and the sentence is raised
  outside it (`{ response: "optional" }` — see `apps/api/CLAUDE.md`). Both doors past a locked
  ticket are named in the sentence itself: the labelled supervisor override, open to `store` and
  `prod` only and recorded in `document_history`, or cancelling the ticket and issuing a new one
  with new digits — which is the door a counter, who may not override, actually has.
  (Landed in the Phase 6 fix wave,
  `a8f762b`/`19d486a` — `makeOtp`, a pure function of the ticket number, came out of
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
  why, and the action does not happen. The toast is drawn once, by `UI/src/ui/Toast.tsx` in
  `App.tsx` above the routes — on every page, the sign-in screen included — never by the shell.
  The two forms outside the shell (sign-in, change-password) do not toast a refusal at all:
  `login` and `changePassword` write `authError`, and the form shows it inline, where it stays
  until the next attempt. A toast stays up for as long as its sentence takes to read, and a click
  puts it away.
- A refused request's log line says why. Every 4xx lands on the API's per-request log line as
  `refusal: { code, message, cause? }` (`apps/api/src/plugins/errors.ts` →
  `plugins/logging.ts`); `cause` is `AppError`'s internal reason — the login's `no such
  employee` / `wrong password for RC-4471` / `RC-4471 is deactivated` behind its one sentence —
  and is never serialised into a response.
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
  `screens.test.tsx` is **143** cases, two of them the manager's Withdraw-approval door against the
  seeded fixtures (REQ-2026-0910, approved with no ticket; REQ-2026-0909, already ticketed). Its
  drawer loop iterates `Object.keys(DRAWERS)` against a `key → [id, role]` map, so a drawer
  registered with no row there fails the suite by name — the same coupling `NAV` × screens has.
- `audit-screens.test.tsx` — the store, kitchen and buyer screens the audit wave rebuilt: the
  kitchen's makeable list read off the master rather than three literals, decimal quantities
  committed on blur, the goods receipt refusing in a sentence rather than by greying its button.
- `time.test.tsx` — every place a date or an instant is read: the two dashboards sorting on `iso`,
  a received purchase order sorting on its trail's last entry, and the bill slip printing the
  hospital's own day across an IST midnight.
- `theme.test.ts` — theme resolution and persistence.
- `writes.test.ts` — **159** cases: every server-backed action (Phase 2's `pay`, `toggleAvail`,
  `savePrice`, `addProduct`, `removeProduct`; Phase 3's fourteen movement actions; Phase 4's three
  kitchen actions; Phase 5's twenty-one buying actions; Phase 6's last four support actions, the
  two report reads, and the audit wave's own six — `voidBill`, `raiseProdOrder`, `updateItem`,
  `addPayer`, `updatePayer`, `createAdjustment` — plus `loadPayers`) against a mocked client:
  success refetches the right slices, a
  refusal toasts and leaves state untouched. **The "known flake" this file used to carry is gone,
  and it was a real defect.** `leaves the requisition card and its note alone when procurement
  refuses it` polls on `S().toast !== null`; `notify` used to leave the *previous* toast's timer
  running and have it clear by comparing the message, so where two cases refuse in the same words
  the first toast's stale timer took the second toast down partway through — which an operator
  saw as a sentence that vanished early because the one before it took it away. `notify` cancels
  the timer it replaces now, and `refusals.test.tsx` pins it.
- `drawer.test.tsx` — **11** cases, the whole of `aria-modal="true"` being true: the keyboard
  goes in on open, Tab wraps both ways, a `focusin` guard catches it being moved out, a
  `MutationObserver` catches it being dropped (a focused control that unmounts, and one that
  merely becomes `disabled`), and it goes back where it came from on close.
- `refusals.test.tsx` — where a refusal is shown: inline on the sign-in and change-password forms
  (and not as a toast), the toast drawn once in `App.tsx`, a repeated sentence getting its own
  full stay rather than the remains of the last one, and a screen that throws caught inside
  the shell.
- `events.test.ts` — the SSE client (`UI/src/api/events.ts`): frame parsing, the 250 ms
  per-collection debounce into `refetch`, `resync` forcing a full `loadSnapshot`, and the
  `live` / `reconnecting` / `off` state the shell's status pill reads.

`apps/api`'s tests give each file its own Postgres schema, `t_<name>_<pid>` (`process.pid`
keeps parallel runs from colliding), migrated once and dropped on close
(`apps/api/src/test/db.ts`). Both `apps/api/vitest.config.ts` and `UI/vite.config.ts` pin
`TZ=UTC` so IST-sensitive assertions (bill numbering across midnight, best-before rendering)
prove something on every host, not just ones already in UTC. A seed run takes **one** decision
about its `document_history` stamps and applies it to every one of them: `historyShiftMs`
(`apps/api/src/db/seed.ts`) rolls the lot back an IST day when the *latest* fixture time (09:26)
would resolve into the future on today's calendar, and leaves them alone otherwise — the
documents' own `at`/`issuedAt`/`receivedAt` are untouched either way, so the sales report's
"every seeded bill is timed today" still holds. Without any shift the whole `apps/api` suite went
red between IST midnight and the last fixture time, because a live-appended trail entry sorted
*below* the seeded rows it came after; with a shift decided **per row** — which is what
`pastFixtureTime` did — a document's own trail inverted between two of its own stamps, and
`documents.test.ts` was red every morning from about 08:05 to 08:44.
`apps/api/src/test/builders.ts`
exports `given.{request,ticket,shopAsk,bill,prodOrder,vendor,requisition,po,contract,
productRequest,supportTicket,adjustment}` — **twelve** builders, one row per family, seeded above the
fixture's own ids so a builder-made document can never collide with a seeded one
(`given.adjustment`'s band is `ADJ-2026-9001+`, and it writes the document only, never a ledger
move: `postMoves` is the one door, and a builder reaching through it would be standing in for the
write under test). `resetDocuments` (`src/test/db.ts`) truncates **29** tables. There is
deliberately no `given.payer` — `payers` is master data, seeded once per file, and `POST /payers`
is how a test makes one. A test that
opens two concurrent transactions to prove a lock holds must call `warmPool(t, n)`
(`apps/api/src/test/db.ts`) first — `pg` connects lazily, so without it two "concurrent"
transactions run back to back against a single warm connection and the test passes even with
the lock removed. `n` must never exceed the test pool's own `max` of **4**: asking for more
hangs `warmPool`'s `Promise.all` for ever without releasing the connections it did get, and
every later test in that file times out at 30 s.

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

**The audit fix wave (2026-09-11)** is not a seventh phase. Its first three blocks add no module
and no screen: they harden what the six phases built, and they change rules this guide states —
goods receipt is decided
on what was **accepted**, an approved request can be **withdrawn**, an MTO item is never batched or
distributed, a wrong OTP is **counted** and five of them lock the ticket, a bill's payer and the
payer roster are withheld from the three roles that never bill anybody, the idempotency record is
written **inside** the write's own transaction, and migration `0008` puts the ledger's own
promises into the database as constraints and a trigger. Every one of them is a row in the spec's
§16 table *Amendments recorded during the audit fix wave (2026-09-11)*; read it before reopening
any of them.

**Its fourth block is different, and it is the only thing since Phase 6 that adds capability.**
Two modules join `apps/api/src/modules`, taking the registered count to **twenty-one**: `payers`
(`POST /payers`, `PATCH /payers/:kind/:id`, `GET /payers` — the register a non-cash tender is
charged to, with `GET /roster` still mounted in `snapshot` for the till's live rows) and
`adjustments` (`POST /adjustments`, `GET /adjustments` — the write-off and stock-count register).
Three existing modules gained a write each: `catalog` mounts a fifth (`PATCH /items/:it`), `pos`
its second (`POST /bills/:no/void`) and `production` its fifth (`POST /prod-orders`, the only
route in that module open to a role other than `prod` and the only location-scoped one). Four
migrations carry them — `0009_payers_audit` (the `created_at`/`updated_at` every other master
table already had), `0010_adjustments` (the `adjust_reason` enum, the document pair and the
`sequences` row its ids are drawn from), `0011_prod_orders_need_by` (one nullable `date`) and
`0012_bills_void` (three nullable columns and the `voided_by` foreign key) — taking the journal to
thirteen entries, `0000`–`0012`. `"adj"` joins `IdKind` (`ADJ-<year>-<nnnn>`, padded to four so a
text sort holds past ten, starting at 1 because nothing was ever written off through a document
before), `"prd"` finally has a writer, `"roster"`, `"payers"` and `"adjustments"` join
`CollectionSchema`, and `"reversal"` and `"adjustment"` — the two `move_kind` values that had
existed since `0000` with nothing writing them — are written for the first time. `document_history`
gains three doc types with them: `item`, `adjustment` and `bill`.

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
