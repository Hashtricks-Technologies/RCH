# Outlet management - design

Date: 2026-09-14 · Base: `origin/develop` 57256a9 · Branch: `feature/outlets`

## Goal

The super admin gets an **Outlets** tab on `/admin` to view the hospital's retail outlets, add a new one, edit
one, and close or reopen one. Every operational screen and rule then works from the outlets in the database
rather than the three built into the code.

## Decisions (settled with the user)

| Question | Decision |
|---|---|
| What is managed | Retail outlets only. The central store and the central kitchen stay fixed singletons; `quarantine` stays the one non-operable shelf. |
| Delete | **Outlets are closed, never deleted** - the same rule as items. A closed outlet keeps every bill, move and report, and can be reopened. There is no delete route. |
| Where the key comes from | The server, from the name, once. It never changes, even when the outlet is renamed. |
| Bare seed | Still creates Restaurant, Coffee Shop and Snack Kiosk. The live box already has them; nothing moves. |

## What exists today, and why it is not enough

`locations` is an ordinary table with a `text` key and no Postgres enum on it; fourteen tables reference it with
`ON DELETE no action`. But the wire and the code close the set:

- `LocKeySchema = z.enum(["store","kitchen","rest","coffee","kiosk"])`, and every wire schema carrying a location
  (bills, tickets, requests, menus, stock, staff, adjustments) validates against it, responses included.
- `OUTLETS = ["rest","coffee","kiosk"]` is a constant read by 15 UI screens and 4 server checks
  (`adjustments/routes.ts`, `production/service.ts`, `productreqs/service.ts`, `lib/users-admin.ts`).
- The snapshot's `sales` is positional (one column per `OUTLETS` entry) and `scope.ts` cuts a counter to its
  column by index. `readers/stock.ts` drops balances for any key not in its own literal list.
- `PAR_FACTOR` in `@rch/domain` is a `Record` over the five keys.
- `WORKS_AT` (role → allowed locations) is written out twice, in `lib/users-admin.ts` and `AdminUsers.tsx`, and
  both admin pages hardcode `LOC_LABEL`, because an admin session loads no location data at all.
- `apps/api/src/cli/users.ts` validates `--loc` against the enum.

## 1. The model

### 1.1 Contract

- `LocKeySchema` becomes a checked key: `z.string().regex(/^(?!quarantine$)[a-z][a-z0-9-]{0,23}$/)`. A
  negative lookahead rather than a `.refine`, so the key schema stays a plain string schema usable as a record
  key, and quarantine is still a 400, as today. `StockLocSchema` is the same regex without the lookahead.
  `LocKey` and `StockLoc` are both `string` in TypeScript. Both flip in the first task, while `ALL_LOCS`,
  `OUTLETS` and `PAR_FACTOR` stay as literal constants until every reader has moved off them (the last code
  task), so every package stays green between tasks.
- `STORE = "store"` and `KITCHEN = "kitchen"` are exported beside `QUARANTINE`. Code that means the central store
  or kitchen names these constants instead of a literal.
- `ALL_LOCS` and `OUTLETS` are removed from the contract. Nothing may list outlets from a constant again.
- `byLoc` / `byStockLoc` in `schemas/snapshot.ts` become `z.record(LocKeySchema | StockLocSchema, v)`.
- `LocationSchema` gains `active` and `par`. They are optional while readers are migrated, where absent reads
  as open and as a factor of 1 (the way `Item.active` reads), and required once every reader sends them. It
  stays keyed by location in `locations`.
- `sales` becomes `z.array(z.record(LocKeySchema, Money))`: one record per day, keyed by outlet.
- `CollectionSchema` gains `"locations"` and `"outlets"`.
- The root `CLAUDE.md` rule becomes: *`Role` and every status are closed unions; never widen one with `string`.
  A location key is data - store and kitchen are the `STORE` / `KITCHEN` constants, and outlets are read, never
  listed.*

### 1.2 Domain (`@rch/domain`)

- `par.ts`: `PAR_FACTOR` is removed. `parFactor(m, loc)` reads `m.locations[loc]?.par ?? 1`.
- New `locations.ts`, pure functions over `Master.locations`:
  - `outletKeys(locations, { open })` - Outlet-type keys, open ones only when asked, ordered by name and then
    key.
  - `operationalKeys(locations)` - `STORE`, `KITCHEN`, then open outlets (replaces `ALL_LOCS`).
  - `worksAt(role, key, location)` - the one pairing rule: `prod` at the kitchen; `store` and `buyer` at the
    store; `counter` and `manager` at an **open** outlet. Replaces both copies of `WORKS_AT`. `placesFor(role,
    locations)` is the picker's list for the same rule.
  - `HOLDS_OUTLET` - for each document an outlet can be party to, a `Record<Status, boolean>` of the statuses
    that still commit the outlet. It is exhaustive over each closed union, so a new status fails typecheck until
    it is classified. `closeRefusal(name, blockers)` builds the close refusal sentence (§2.3).
  - `outletKeyFor(name, takenKeys)` - lower-cases, turns runs of anything outside `[a-z0-9]` into `-`, trims to
    24, and appends `-2`, `-3`, … when the result is empty-after-trim, reserved (`store`, `kitchen`,
    `quarantine`) or taken.

### 1.3 Database (one migration)

Numbered as the next free entry in `drizzle/meta/_journal.json` at implementation time (0015 at the base commit;
the parallel `feature/audit-log` and recipe-removal work may take it first).

- `locations.active boolean not null default true`.
- `locations.par_factor numeric(4,2) not null default 0.18`, backfilled: `store` 1, `kitchen` 0.35, `rest`
  0.22, `coffee` 0.18, `kiosk` 0.15, `quarantine` 1. These are today's `PAR_FACTOR` values, so par levels do not
  move.
- Unique indexes on `upper(code)` and `lower(name)`. The six seeded rows already satisfy both.
- `sellable` stays, so an older image still reads the table after a rollback. Nothing reads it, and a new outlet
  is written with `sellable = true` like the seeded ones. `type = 'Outlet'` remains the rule.

The fixtures (`packages/contract/src/fixtures/master.ts`) gain `active` and `par` on each `LOC` entry. The bare
seed inserts them as today.

## 2. Server

### 2.1 One way to name a location in a write

New `apps/api/src/lib/locations.ts`:

- `lockLocation(tx, key)` - `SELECT … FOR SHARE` on the `locations` row. It refuses an unknown key as
  `not_found` (`There is no location <key>.`, the sentence the services already use). Each caller keeps its own
  type check against the row.
- `assertOpen(row, then?)` - refuses a closed location as `rule`: `Refused - <name> is closed`, optionally
  followed by `; <then>`.

The location row is master data. It is locked in the **documents** tier, before ids and balances, so the
server-wide lock order is unchanged.

Every write that names a location resolves it through `lockLocation`, and calls `assertOpen` on it when it is an
outlet. That is:

- counter sale (`pos`)
- shop transfer (`tickets`)
- shop ask
- kitchen order (`production`, `from`)
- distribute (`to`)
- product request (`forLoc`)
- adjustment at an outlet
- menu add
- availability toggle

It replaces the existing `type === "Outlet"` reads and `OUTLETS.includes` checks.

Voiding a bill at a closed outlet is refused - `Refused - <name> is closed; reopen it before voiding its
bills` - because the void would post stock back onto a closed shelf.

### 2.2 Readers

- **`readers/stock.ts`** keys balances off the `locations` rows rather than a literal list.
- **`readers/documents.ts`** builds `sales` keyed by open and closed outlets alike.
- **`scope.ts`** cuts a counter to `{ [L]: row[L] }`.
- **`loadLocations`** returns every row, closed ones included, so history screens can still name them.

### 2.3 Admin routes (`access: "admin"`)

| Route | Body / result | Message |
|---|---|---|
| `GET /admin/locations` | Every location except quarantine: key, name, code, type, floor, cost centre, list, active, and `staff` (active accounts based there). The Accounts tab labels from this too, so `LOC_LABEL` goes. | - |
| `POST /admin/outlets` | `{ name, code, floor, cc, list }` → the outlet | `Opened <name> (<code>) on price list <list>.` |
| `PATCH /admin/outlets/:key` | any of `{ name, code, floor, cc, list }` → the outlet | `Saved <name>.` |
| `POST /admin/outlets/:key/close` | → the outlet | `Closed <name>. Its bills and reports are kept.` |
| `POST /admin/outlets/:key/reopen` | → the outlet | `Reopened <name>.` |

Validation:

- `name` must be 2-40 characters after trimming.
- `code` must be 2-12 characters of `A-Z0-9-`, stored upper-cased.
- `floor` and `cc` must each be 1-40 characters.
- `list` is `A | B`.

A duplicate name or code is a `conflict`, caught from the unique index so that a race is covered too: `Refused -
a location named <name> already exists` or `Refused - code <code> is already in use`. "Location" rather than
"outlet", because the store and the kitchen hold names and codes as well. Creates serialise on a `SHARE ROW
EXCLUSIVE` lock on `locations`, which does not block the `FOR SHARE` row locks that sales take, so two outlets
cannot be given the same key. An edit that changes nothing is refused: `Nothing to save - <name> already reads
that way`. PATCH and close/reopen on a key that is not an Outlet-type row are `not_found`, so
store and kitchen cannot be edited or closed through these routes.

**Close** takes the row `FOR UPDATE`, then refuses while anything still depends on the outlet, naming every
blocker in one sentence (the dispatch rule's shape): `Refused - <name> still has <list>`, where the list is
drawn from:

- `stock on hand (N items)`
- `N open tickets`
- `N open stock requests`
- `N open kitchen orders`
- `N open shop asks`
- `N open product requests`
- `N active staff (<emp numbers>)`

Counts are singular for one ("1 open ticket", "1 item"), and the last two entries are joined with "and".

"Open" is `HOLDS_OUTLET` (§1.2). The transition tables can't answer it, because a dispatched kitchen order and a
sent shop ask each keep an undo edge, yet the ticket they raised is what still holds the outlet. Reservations are
not listed separately, since one exists only under an open ticket. Once none remain, the close sets `active =
false`. Closing an outlet that is already closed, or reopening one that is already open, is refused: `<name> is
already closed` / `<name> is already open`.

A closed outlet:

- keeps its menu, availability overrides and price list, so a reopen restores it as it was;
- can't take a sale, transfer, ask, kitchen order, adjustment, menu add or bill void (§2.1);
- can't have staff created at it, moved to it or reactivated at it (`worksAt`).

Each write runs in one `withTransaction`, writes one `admin_actions` row, and calls
`emitChanged(tx, ["outlets", "locations"])`, the same array its response names. Every open operational browser
refetches `locations`, and every open admin tab refetches `outlets`.

### 2.4 Audit rows

- `AdminActionSchema.action` gains `outlet_create`, `outlet_update`, `outlet_close` and `outlet_reopen`.
- An outlet row has `target_id` null. `target_name` is the outlet's name, and `details` holds `{ key }` plus,
  for an update, the changed fields as `{ field: [before, after] }`.
- `GET /admin/actions` gains `?kind=accounts|outlets` (default `accounts`, so today's feed is unchanged).

### 2.5 Accounts and the CLI

- `createUserTx`, `updateUserRoleLocTx` and reactivate check `worksAt` against the locked location row.
- `cli/users.ts` validates `--loc` the same way, and its help text stops naming `rest|coffee|kiosk`.

## 3. UI

### 3.1 Data

- `data/master.ts` stops re-exporting `ALL_LOCS` / `OUTLETS`. Selectors in `lib/selectors.ts` delegate to the
  domain:
  - `openOutlets()` - pickers that **start** something: counter peers, the kitchen-order drawer, the manager's
    Items & Stock menu picker, Prices, dashboard outlet cards, availability columns.
  - `allOutlets()` - filters over **history**: Bills, Approvals, Orders. A closed outlet prints as
    `<name> (closed)`.
  - `operationalLocs()` - replaces `ALL_LOCS` in MakeDistribute, IssueDesk, buyer Inventory and ItemsStock.
- `Record<StockLoc, …>` built from `StockLocSchema.options` (`wire.ts`, `store/index.ts` `EMPTY_STOCK`,
  `store/Adjustments.tsx`, `selectors.ts`) becomes a string-keyed record, read with `?? {}`.
- `refetch.ts` `NARROW`:
  - `locations` - for a non-admin session, `GET /locations`, then `hydrateMaster`, then a `catalogVersion` bump
    so screens re-render. For an admin session, nothing.
  - `outlets` - for an admin session, `GET /admin/locations`. For anyone else, nothing.

### 3.2 Store: `store/admin.ts`

It gains `adminLocations`, `loadAdminLocations`, `createOutlet`, `updateOutlet`, `closeOutlet` and
`reopenOutlet`. The actions follow the existing pattern: call, `notify(r.message)`, `refetch(r.changed)`. A
refusal leaves the form exactly as it was.

### 3.3 Screen: `pages/AdminOutlets.tsx`

`AdminDashboard`'s `Tab` becomes `"accounts" | "outlets" | "support"`.

- **PageHead** sub (one line): "The hospital's retail outlets, and whether each one is open."
- **Add card**:
  - name, code, floor, cost centre, and a price list select (A/B)
  - **Open outlet** button
  - a preview line of the key the server will assign, from `outletKeyFor`
- **Table** (`DataTable`):
  - Columns: name, code, floor, cost centre, list, staff, status (`Pill`: Open / Closed).
  - Open outlets are listed first, then by name.
  - Each row has **Edit**, which turns the row's fields into inputs with Save and Cancel, plus **Close** (with a
    second press, like Delete on Accounts) or **Reopen**.
  - Store and kitchen are not listed.
- **Recent actions**: the `kind=outlets` feed, in the same form as the Accounts tab's.
- **Empty state**: "No outlets yet - open the first one above."
- **Accounts tab**: the location select reads `adminLocations` filtered by `worksAt`, so a new outlet appears
  there the moment it is opened.

## 4. Testing

Tests are written first, per package.

- **Contract:**
  - `LocKeySchema` accepts a new slug and refuses `quarantine`, upper case and over-length keys.
  - A snapshot with a fourth outlet parses.
- **Domain (99 / 92 floor):**
  - `outletKeyFor`: collision, reserved word, empty result, trimming.
  - `worksAt`: every role, and a closed outlet.
  - `outletKeys` ordering and open filter; `parFactor` fallback.
- **API:**
  - create, including a duplicate name and a duplicate code;
  - edit, including a rename that keeps the key, and a PATCH on `store` → 404;
  - close refused for each blocker, with every blocker named at once;
  - close succeeds once clear;
  - reopen;
  - a sale, transfer, kitchen order, adjustment, menu add and void at a closed outlet each refused;
  - a new outlet sells end to end: menu add → price → sale → snapshot `sales` keyed by it → counter scope;
  - staff pairing to a new outlet, and refused to a closed one;
  - `admin_actions` rows and `kind` filter;
  - `emitChanged` with `["outlets", "locations"]` on each write;
  - a non-admin token gets 404 on every new route;
  - the migration backfill keeps today's par factors.
- **UI:**
  - `admin-outlets.test.tsx`: renders, add, edit, close refusal toast verbatim, reopen.
  - the Accounts location select picks up a new outlet;
  - a `locations` change re-renders a manager screen with the new outlet column;
  - `bare.test.tsx` / `procurement.test.ts` stop pinning five keys.
- **Floors:** existing tests that pin the fixed set are rewritten against fixtures, not deleted. No coverage
  floor is lowered.

## 5. Docs (same commit as the code)

- **Root `CLAUDE.md`:**
  - the closed-union rule (§1.1)
  - the admin page's tabs
  - "Outlets are closed, never deleted" among the invariants
  - the location-lock tier in lock order
- **`apps/api/CLAUDE.md`:** `lockLocation`, the close blockers.
- **`packages/contract/CLAUDE.md`:** location keys are data.
- **`packages/domain/CLAUDE.md`:** `locations.ts`.
- **`UI/CLAUDE.md`:** the selectors, the tab, the two readers.
- **Also:** `README.md`, `UI/README.md`, and `deploy/RUNBOOK.md`, where it lists
  `store|kitchen|rest|coffee|kiosk` for the users CLI.

## 6. Rollout

- Built in the worktree `feature/outlets` off `origin/develop`, with its own Postgres on a separate port, so the
  shared tree's sessions and their database on 5439 are untouched.
- Rebased on `origin/develop` before shipping. Two parallel changes overlap:
  - The recipe removal touches the same contract, snapshot, seed and selector files.
  - `feature/audit-log` adds a third admin tab and requires an `AUDIT_LABELS` entry for every write route. If it
    lands first, the four outlet writes get labels ("Opened an outlet", "Edited an outlet", "Closed an outlet",
    "Reopened an outlet").
  - The migration is renumbered at rebase if needed.
- Every CI gate must pass: typecheck, tests with coverage floors, zero-warning lint, knip, boundaries, audit, UI
  build, image scan and kind install.
- The migration only adds columns and indexes and backfills par factors. It is safe on the live box, which
  holds real data, and an older image still runs against it.
- Pushing to `develop` deploys the live box automatically, so the push waits for the user's go-ahead.

## Out of scope

- Deleting an outlet.
- Adding or closing stores and kitchens.
- Per-outlet bill number prefixes (every bill stays `CF/…`).
- Moving an outlet's stock automatically on close.
- Editing par factors from the page.
- Building a new outlet's menu from the admin page (the manager's existing screens do that).
