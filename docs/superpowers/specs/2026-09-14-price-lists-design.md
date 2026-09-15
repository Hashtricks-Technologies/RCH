# Price lists - design

Date: 2026-09-14 · Base: `origin/develop` f736565 · Branch: `feature/price-lists`

## Goal

Today a manager can only ever have two price lists, `A` and `B`, hardcoded into the wire schema and the
Postgres enum. Each of the three outlets (Restaurant, Coffee Shop, Snack Kiosk) is statically tagged onto one of
the two at seed time, with no route to change it. This design turns "price list" into a real entity: a manager
can create as many named price lists as they want, each one editable at any time, and switch which list is
active for any outlet whenever they choose. The manager's Prices screen gains a price-list management view with
filters, alongside the existing per-outlet editing view.

## Decisions (settled with the user)

| Question | Decision |
|---|---|
| What "outlet" means | One of the three existing retail locations (`rest`, `coffee`, `kiosk`) - no new location concept. |
| Can one outlet have several lists live at once | No - one **active** list per outlet at a time, chosen from however many lists exist. |
| Can a list still be shared across outlets | Yes - unchanged from today. Two outlets can point at the same active list; editing it changes both. |
| Is an active list frozen | No - a list stays editable at any time, active or not, exactly like today's per-item Save. |
| Starting point for a new list | Always cloned from the outlet it's created for, using that outlet's current active list's prices. |
| Does a new list activate immediately | No - it's created inactive; the manager switches the outlet onto it as a separate step. |
| Delete vs retire | A list with no outlet currently pointing at it can be hard-deleted. One that's in use can only be switched away from, then deleted. |
| Filters on the price-list view | Outlet (which lists are active where) and a name search box. Not status or item-containment - YAGNI for now. |

## What exists today, and why it is not enough

- `packages/contract/src/schemas/common.ts`: `export const PriceListSchema = z.enum(["A", "B"]);` - a closed
  two-member discriminator, not an entity. There is no id, name, or metadata anywhere for a "price list."
- `packages/contract/src/schemas/documents.ts`'s `LocationSchema` carries `list: PriceListSchema.optional()` -
  a static tag, and no route in `routes.ts` ever changes it. It is fixed at seed time
  (`packages/contract/src/fixtures/master.ts`): `rest: "A"`, `coffee: "B"`, `kiosk: "A"`.
- `packages/contract/src/schemas/snapshot.ts`: `prices: z.object({ A: z.record(...), B: z.record(...) })` - a
  fixed-shape object, not an open map, so a third list cannot even be represented on the wire.
- `apps/api/src/db/schema/master.ts`: `price_list_items` is keyed by a Postgres enum `price_list_enum` (`"A" |
  "B"`), and `locations.price_list` is that same enum, nullable. Both are closed at the database level.
- `apps/api/src/modules/catalog/service.ts#savePrice` writes to whichever of the two enum values it's given;
  there is no create, no delete, no "which outlets is this active for."
- `UI/src/roles/manager/Prices.tsx` already lets a manager drill into one outlet at a time and edit its list's
  item prices, and is explicit that two outlets sharing a list move together - but the "list" itself is always
  just the letter `A` or `B` with no name, and there is no way to make a third one.
- `@rch/domain`'s `Prices` type is `{ A: Record<string, number>; B: Record<string, number> }`, and `priceOf()`
  reads `m.locations[l]?.list` then `prices[list]?.[it]`, capping at MRP at read time. The logic already
  generalizes cleanly to any list id - only the type is closed.

## 1. The model

### 1.1 Contract

- `PriceListSchema` (the old enum) is renamed `PriceListIdSchema = z.string().min(1).max(32)` and used
  everywhere a list id travels as a key: `SavePriceParamsSchema.list`, `PriceResultSchema.list`,
  `LocationSchema.list` (kept as the field name, still optional - `store`/`kitchen` carry none).
- A new `PriceListSchema` names the entity: `z.strictObject({ id: PriceListIdSchema, name: z.string().min(1).max(80),
  outlets: z.array(LocKeySchema) })`. `outlets` is derived at read time (every location currently pointing at
  this id), never stored on the list row itself.
- `packages/contract/src/schemas/snapshot.ts`: `prices` becomes `z.record(PriceListIdSchema, z.record(z.string(),
  z.number()))` - an open map instead of the fixed `{ A, B }` shape. A new field, `priceLists:
  z.array(PriceListSchema)`, carries the entities themselves (name, outlets) for the management screen.
- `CollectionSchema` (`packages/contract/src/schemas/writes.ts`) gains `"priceLists"` alongside the existing
  `"prices"`.
- New routes in `packages/contract/src/routes.ts`, all `access: ["manager"]`:

  | Route | Body / params | Result |
  |---|---|---|
  | `GET /price-lists` | - | `{ priceLists: PriceList[] }` |
  | `POST /price-lists` | `{ name: string; cloneFrom: LocKeySchema }` | the new `PriceList` |
  | `DELETE /price-lists/:id` | - | `{ id }` |
  | `PUT /outlets/:loc/price-list` | `{ listId: PriceListIdSchema }` | the outlet's `Location` |

  `PUT /prices/:list/:it` is unchanged in shape; `list` now accepts any existing id, not just `"A"|"B"`.

### 1.2 Domain (`@rch/domain`)

- `Prices` (`packages/domain/src/master.ts`) widens from a two-key object to `Record<string, Record<string,
  number>>`.
- `priceOf()` (`packages/domain/src/pricing.ts`) is unchanged in logic - `m.locations[l]?.list` and
  `prices[list]?.[it]` already work for any string id. Only its type signature loosens with `Prices`.
- `packages/domain/src/ids.ts` gains `"price_list"` to `IdKind`, a `formatId` case (`"PL-006"` - short prefix,
  three-digit padding, no year, matching `"vendor"`'s `"VN-006"` rather than a document series like `req`/`po`
  that resets by year), and `SEQUENCE_START.price_list = 3` (continuing past the two seeded lists, the same way
  `SEQUENCE_START.vendor = 6` continues past five seeded vendors). This is the same allocator every other
  business entity's id already goes through (`nextEmpNo`, vendor ids, document numbers) - a price list gets a
  real id the moment it's created, not a database serial.
- No other domain function touches price lists: dispatch, transitions, credit cap, and the rest are untouched.

### 1.3 Database (one migration)

Numbered as the next free entry in `drizzle/meta/_journal.json` at implementation time (the parallel
`feature/outlets` and `feature/audit-log` branches may take an earlier number first - see Rollout).

Every other addressable entity in this schema (`vendors`, `users`, `admin_actions`, `requisitions`, ...) keys
on `text("id").primaryKey()` with a server-formatted id, never a bare serial - `price_lists` follows the same
rule rather than introducing a new numeric-id style:

- New table `price_lists`: `id text primary key` (formatted `"PL-<n>"` by `allocateId(tx, "price_list")`),
  `name text not null`, `created_at timestamptz not null default now()`.
- `price_list_items.list` (currently `price_list_enum`) is renamed `list_id` and repointed at `price_lists.id`
  (`text not null references price_lists(id)`), keeping the same `(list_id, item_key)` primary key.
- `locations.price_list` (currently the enum, nullable) becomes `locations.price_list_id`, `text references
  price_lists(id) on delete restrict` - `RESTRICT` is what actually stops a list still in use from being
  deleted, closing the race between checking "is this used" and deleting it.
- Migration steps: `ensureSequences` picks up the new `price_list` kind (starting at `SEQUENCE_START.price_list
  = 3`); create `price_lists`; insert two rows with ids `"PL-001"` / `"PL-002"` (named `"List A"` / `"List B"`,
  renameable afterwards - the manager loses nothing), matching exactly what `formatId("price_list", 1 | 2)`
  would produce, the same way seeded vendors carry `"VN-001"`.."VN-005"` ahead of `SEQUENCE_START.vendor = 6`;
  rewrite `price_list_items.list_id` and `locations.price_list_id` from the old enum values (`"A"` → `"PL-001"`,
  `"B"` → `"PL-002"`) to those two ids; drop the old `list` / `price_list` columns and the `price_list_enum`
  Postgres type.
- The demo-hospital fixture (`packages/contract/src/fixtures/master.ts`) and `packages/contract/src/fixtures/
  seed.ts` are updated the same way the vendor fixtures already are: `Location.list` (and any other fixture
  referencing `"A"`/`"B"`) is rewritten to the real `"PL-001"`/`"PL-002"` ids, so fixtures, the bare seed, and a
  freshly migrated database all agree.

## 2. Server

New module `apps/api/src/modules/pricelists/` (`routes.ts`, `service.ts`, `repo.ts`,
`pricelists.test.ts`), matching the shape of every other entity module (`catalog`, `vendors`). `catalog`
keeps owning `savePrice` - it already reads/writes `price_list_items` and doesn't need to know how a list
is named or activated.

### 2.1 Service

- `list(): Promise<PriceList[]>` - reads `price_lists` joined against `locations` to compute `outlets` per id.
- `create(name, cloneFrom): Promise<Write<PriceList>>` - in one transaction: load `cloneFrom`'s
  `locations.price_list_id` (refuse `not_found` if that outlet has no active list yet, or if `cloneFrom` isn't a
  `LocKey`), `allocateId(tx, "price_list")` for the new id, insert the `price_lists` row, copy every
  `price_list_items` row from the source id to the new id. `emitChanged(["priceLists"])`. Message: `"<name>
  created, cloned from <outlet>'s prices."`.
- `remove(id): Promise<Write<{ id }>>` - in one transaction, `SELECT` the row `FOR UPDATE`, refuse `not_found`
  if it doesn't exist, refuse as a rule violation naming every outlet still on it if any do (`"Refused - <name>
  is still used by <outlet, outlet> - switch them to another list first"`), else delete. The `ON DELETE
  RESTRICT` foreign key is the backstop if a location is attached between the check and the delete inside the
  same transaction; that case surfaces as a Postgres constraint violation, caught and turned into the same
  refusal sentence. `emitChanged(["priceLists"])`.
- `activate(loc, listId): Promise<Write<Location>>` - refuse `not_found` if `listId` doesn't exist or `loc`
  isn't an outlet; else update `locations.price_list_id`. `emitChanged(["priceLists", "prices", "locations"])` -
  `locations` too, since the outlet's `Location.list` field itself changes. Message: `"<outlet> switched to
  <list name>."`. Refuse `"Nothing to save - <outlet> is already on <list name>"` if it's already there,
  matching the "nothing changed" refusal style used elsewhere (e.g. outlet edits).

### 2.2 Locking

Price lists never touch stock, reservations, or documents, so none of the server's ledger lock-order rules
apply. Each write is a single `withTransaction`, taking only the rows it needs (`price_lists`, `locations`,
`price_list_items`) with ordinary row locks. There is no interaction with the `stock_balances` /
`stock_moves` tier.

### 2.3 Readers

`apps/api/src/modules/snapshot/readers/master.ts`'s `readPrices` generalizes from two hardcoded keys to a
`GROUP BY list_id` fold over every row. A new `readPriceLists` joins `price_lists` to `locations` to build the
`outlets[]` array per list, for the snapshot's new `priceLists` field.

## 3. UI

### 3.1 Data (`UI/src/data/master.ts`)

- `PL` widens from `{ A: {}, B: {} }` to `Record<string, Record<string, number>>`, starting `{}`. Because
  `replaceKeys` is already generic over any plain object, `hydratePrices` collapses from two calls
  (`replaceKeys(PL.A, ...)`, `replaceKeys(PL.B, ...)`) to one: `replaceKeys(PL, prices)`.
- A new registry, `PRICE_LISTS: Record<string, { id: string; name: string; outlets: string[] }>`, starting
  `{}`, filled by a new `hydratePriceLists(priceLists)` (keyed by `id`, same `replaceKeys` pattern as `IT`),
  called from both `hydrateMaster` and the narrow `priceLists` refetch.

### 3.2 Wire (`UI/src/api/wire.ts`) and refetch (`UI/src/api/refetch.ts`)

- `applyPriceLists(priceLists)` mirrors `applyPrices`, calling `hydratePriceLists`.
- `NARROW.priceLists = () => call(routes.priceLists).then(applyPriceLists)`.

### 3.3 Store (`UI/src/store/index.ts`)

Three new actions beside `savePrice`, following its exact pattern (call the route, `notify(r.message)`,
`refetch(r.changed)`, return the boolean the screen needs to know whether to reset its own draft state):

- `createPriceList(name, cloneFrom): Promise<PriceList | null>`
- `deletePriceList(id): Promise<boolean>`
- `setActivePriceList(loc, listId): Promise<boolean>`

### 3.4 Screen (`UI/src/roles/manager/Prices.tsx`)

- The landing view (today: one card per outlet) gains a second tab or section: **Price lists**, a `DataTable`
  over `PRICE_LISTS` - columns name, outlets (badges, or "unattached"), item count. Filters above it: an outlet
  `<select>` (narrows to lists active at the chosen outlet, plus an "unattached" option) and a name search
  input - both client-side over the already-hydrated `PRICE_LISTS`/`PL`, no new route needed for filtering.
- The outlet drill-down's header replaces the static "this outlet is on list A, shared with Kiosk" text with a
  **price list picker** (`<select>` of every `PRICE_LISTS` entry) plus a "Create a new list for this outlet"
  action. Switching the select calls `setActivePriceList`; creating calls `createPriceList(name, thisOutlet)`
  and, per the decision above, does **not** switch the outlet onto it - the manager reviews/edits the new list
  (reachable from the Price lists tab, or by picking it in the same select once created) and switches
  explicitly when ready.
  - The existing shared-list `Alert` (today: "list **A** is shared by Restaurant, Snack Kiosk") is unchanged in
    behavior, just prints the list's `name` instead of its letter.
- Item-level editing (search box, Type/Price filters, inline Save) is untouched - it already operates on
  "whichever list this outlet's view currently shows," which generalizes to any list id, including a draft one
  not yet active anywhere.
- The Price lists tab's own "Delete" action is refused client-side with the same sentence the server would give
  if `outlets.length > 0` (mirroring how the till pre-validates a positive price) - though the server call is
  still what enforces it.

## 4. Testing

Tests are written first, per package.

- **Contract:** `PriceListIdSchema` accepts an arbitrary id (not just `"A"`/`"B"`); a snapshot with three price
  lists parses; `CollectionSchema` accepts `"priceLists"`.
- **Domain (99 / 92 floor):** `priceOf()` against a `Prices` map with three or more keys; unchanged MRP-cap
  behavior.
- **API:**
  - create clones every item/price row from the source outlet's active list, and is refused when that outlet
    has no active list;
  - delete succeeds on an unattached list, is refused (naming every outlet) on one still active somewhere, and
    the same-transaction race (attach-then-delete) still ends in a refusal via the FK;
  - activate switches `locations.price_list_id`, refuses an unknown list id, refuses "nothing to save" when
    already on it;
  - `savePrice` still enforces the MRP ceiling per list, unchanged;
  - `emitChanged` payloads for each of the three writes;
  - a non-manager token gets 403/404 as appropriate on all four new routes;
  - the migration backfill: existing `A`/`B` data reads back identically under its new ids.
- **UI:** `prices.test.tsx` (or extending the existing Prices tests) - the Price lists tab renders, filters by
  outlet and by name, create clones the source outlet's prices into a new inactive entry, switching the picker
  calls `setActivePriceList` and re-renders the shared-list alert, delete is blocked in the UI for an attached
  list and works for an unattached one.
- **Floors:** existing tests that pin literal `"A"`/`"B"` list assertions are rewritten against the fixture's
  `"PL-001"`/`"PL-002"` ids, not deleted. No coverage floor is lowered.

## 5. Docs (same commit as the code)

- **Root `CLAUDE.md`:** the MRP-ceiling invariant's wording already says "no price list," unchanged; add a line
  under Architecture noting price lists are a managed entity (name + per-outlet activation), not a fixed pair.
- **`apps/api/CLAUDE.md`:** the new `pricelists` module, and that it never touches the ledger lock tiers.
- **`packages/contract/CLAUDE.md`:** `PriceListIdSchema` is an open string id, not a closed union - it does not
  fall under "every status is a closed union."
- **`packages/domain/CLAUDE.md`:** `Prices` is now an open map.
- **`UI/CLAUDE.md`:** the Price lists tab, its filters, and the `PRICE_LISTS` registry.

## 6. Rollout

- Built in the worktree `feature/price-lists` off `origin/develop`, with its own Postgres on a separate port,
  so the shared tree's other sessions and their database on 5439 are untouched.
- Rebased on `origin/develop` before shipping. One overlap to watch: `feature/outlets` (in progress in a
  sibling worktree) also changes `LocationSchema` and adds `POST /admin/outlets` / `PATCH /admin/outlets/:key`
  bodies that carry `list: "A" | "B"` directly. If it lands first, those bodies' `list` field needs to become
  `PriceListIdSchema` and its admin form needs the same list picker this design gives the manager's Prices
  screen, rather than a fixed A/B select. If price-lists lands first, `feature/outlets` picks up
  `PriceListIdSchema` instead of the enum when it rebases. Either order is fine; whichever lands second adapts.
  The migration number is renumbered at rebase if another branch has taken it first.
- Every CI gate must pass: typecheck, tests with coverage floors, zero-warning lint, knip, boundaries, audit,
  the UI build, and the Trivy/kind/Compose jobs (this feature touches no Dockerfile, Helm chart, or Compose
  file, so those should be unaffected).
