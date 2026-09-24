# apps/api - CLAUDE.md

Repo-wide rules and the domain invariants are in the root `CLAUDE.md`. This file covers what is specific to the
server.

## Commands

```bash
pnpm --filter @rch/api dev                  # tsx watch, reads ../../.env, :3000
pnpm --filter @rch/api test                 # vitest; Postgres on 5439 (pnpm db:up); floor lines 95 / branches 82
pnpm --filter @rch/api build                # tsup → dist/server.mjs
pnpm --filter @rch/api db:generate          # drizzle-kit generate + strip the "public". prefix; review + commit the SQL
pnpm --filter @rch/api db:migrate           # behind pg_advisory_lock(727272); creates rch_app when DATABASE_URL names another user
pnpm --filter @rch/api db:seed [--force] [--bare]
pnpm --filter @rch/api db:rebuild-balances  # recompute stock_balances from stock_moves
pnpm --filter @rch/api users <create|reset-password|deactivate|set-admin> --emp RC-1234 ...   # create: --emp optional, next number assigned;
                                            # --role <desk> takes that desk's first active role, --role-id ROLE-006 names one
pnpm --filter @rch/api payers import --csv <file> [--replace-names]   # kind,id,name - one transaction
                                            # kind is staff|dept|doctor; the register is also on /admin
pnpm --filter @rch/api keys:generate        # prints a fresh Ed25519 JWT_PRIVATE_KEY= / JWT_PUBLIC_KEY= pair
pnpm --filter @rch/api loadcheck            # latency of /snapshot and /bills against a running API
```

Every CLI connects with `MIGRATE_DATABASE_URL` when it is set and `DATABASE_URL` otherwise
(`cliDatabaseUrl(config)` in `src/config.ts`). The server itself only ever uses `DATABASE_URL`.

## Layout

```
src/app.ts        buildApp(): plugins in order, then registerModules
src/server.ts     listen; SIGTERM drains (see Shutdown)
src/config.ts     the Zod env schema - the only reader of process.env
src/routes.ts     mount(): the only way a module registers a route
src/plugins/*     logging, errors, metrics, health, security, db, auth, access, rbac, sse, idempotency, audit, images, payments
src/lib/*         ledger, reservations, tickets, adjustments, ids, history, rules, events, claims, credit, master, audit, access, roles, images,
                  sale, payments, refunds, system-users, …
src/modules/*     one folder per slice, registered in modules/index.ts; _template is the skeleton to copy
src/db/*          schema/, client.ts, migrate.ts, seed.ts
src/cli/*         migrate, seed, rebuild-balances, users, payers, keys, purge
src/test/*        the test harness (below)
drizzle/*.sql     hand-reviewed migrations + meta/_journal.json
```

## Adding a module

A module is exactly four files: `routes.ts`, `service.ts`, `repo.ts` and `<name>.test.ts`.
`scripts/check-boundaries.sh` fails the build if any is missing.

To add one, copy `src/modules/_template/` and add one import and one `app.register` line to
`src/modules/index.ts`.

- `routes.ts` parses the input, calls the service, and replies. Nothing else.
- `service.ts` holds the flow.
- `repo.ts` holds SQL only, and never opens its own transaction.

## How a write is composed

`modules/requests/service.ts` is the worked example. Write the steps in this order:

1. **`mount(app, routes.<name>, handler)`.** Auth, the role gate and the idempotency preHandler are attached
   here, so a handler can't forget them.
2. **Scope by location.** Call `requireLoc(req, body.loc, …)` in `routes.ts` when the request names its
   location, or `requireLocOf(claims, row.loc, …)` in the service when only the document knows it. When the
   scope depends on the role (adjustments, `production`'s `raise`), decide it in `routes.ts`.
3. **Open the transaction** with `withTransaction(db, async (tx) => …)`. Every write does this, no exceptions.
4. **Lock the document row(s)** being decided (`for update`).
5. **Allocate any number** with `allocateId(tx, kind)` / `allocateTicket(tx)`. This locks the `sequences` row.
   Numbers stay gapless even when a write is refused, because a rollback returns the number.
6. **Take the balance locks** with `lockBalances(tx, cells)`, then read on-hand and `reservedAt`. Lock first,
   read second.
7. **Apply the rules** with `assertRule(cond, sentence)`, `assertTransition(TABLE, from, to, id)`, or a
   `NotFoundError`. Any arithmetic belongs in `@rch/domain`.
8. **Change state:** `postMoves` when stock moves, `writeTicket` / `reserve` for a hold, and the repo's status
   writes. An edit to an existing master row or account calls `auditBefore({ … })` first, with the wire-shaped
   fields it can alter (see *Audit capture*).
9. **Record it:** `appendHistory(tx, docType, docId, status, who, at)`, then `emitChanged(tx, changed)`.
10. **Return `{ result, changed, message }` from inside the transaction.** `withTransaction` records the
    idempotency outcome and then the audit event from that value, as its last statements before COMMIT. A
    service that re-reads a row after its transaction has closed puts its answer outside the protection.

### Lock order

Lock order is **documents → ids → balances**. Take a ticket number before the balance locks, never while
holding a shelf.

- **`lib/locations.ts` is the one way a write names a location.** `lockLocation(tx, key)` takes the row `FOR
  SHARE`, in the documents tier - before any id and before any balance - and refuses an unknown key as
  `not_found`. `assertOpen(row, then?)` refuses a closed outlet. The admin's close (`modules/admin`) takes the
  same row `FOR UPDATE`, so a sale already holding the shared lock commits before the close counts its
  blockers, and one that starts after the close has committed reads the outlet closed.
- **Purchase-order claims use a narrower order:** the PO row first, then the requisition rows in ascending
  order (`lib/claims.ts`). `createPo` is the one write that locks requisition rows without holding an order
  lock. That is safe only because it is minting that order.
- **Two writes invert the order on purpose:** the sale (bill number) and `adjustments` (`ADJ-` number) allocate
  after the cover check. Each is the only caller of its own sequence row, so the deadlock a lock order
  prevents can't form. The sale is `postSale` in `lib/sale.ts`, which both the till (`pos.pay`) and a QR
  order's capture call - `allocateId(tx, "bill")` still has exactly one call site.
- **Don't copy the inversion.** An id taken at the head of a transaction serialises everything behind it and
  masks every balance guard. That is how a race test on adjustments once passed with both guards deleted.

### Balances

- **Lock only the cells you will move.** `lockBalances` creates the row it locks, and a stray row shows up as
  a phantom "carried at zero" shelf line (tag M12).
- **Writes that move nothing** (`patchItem`, `production.raise`) take no `lockBalances` at all.
- **Writes whose moves are all positive** (`grn.receive`, `pos.voidBill`, `production.makeBatch`) take neither
  `lockBalances` nor a re-read. Nothing is promised against a balance there. Don't add them for symmetry.
- **Every write that moves stock down re-reads `on_hand − reserved` after `postMoves`**, and refuses if any
  cell went negative. There is deliberately no `on_hand >= 0` CHECK in the database: it would fire before the
  re-read and turn the operator's sentence into a bare 500.
- **`postMoves` drops a move that rounds to zero at three decimals**, row by row, before locking anything.
  `stock_moves_qty_ck` refuses a zero move.

### Uniqueness

For a uniqueness rule, the insert (or update) decides; a pre-check only gives the sentence. `vendors_name_ci_uq`,
`rate_contracts_live_uq`, `items_name_ci_uq` and the `payers` primary key `(kind, id)` all work this way.
`catalog.createItem` also takes a `pg_advisory_xact_lock` on the item's slug, and a second one on its
type's code series (`item-code:<prefix>`) before it reads the highest code there: `items.code` has no
unique index, so that lock is the whole guarantee two new products of one type never share a code.

## The sale

`lib/sale.ts` is the counter sale, for two callers: `modules/pos`'s `pay` (the till: the signed-in operator,
a till tender, `source: "till"`) and a QR order's capture (the system account, tender `Online`, `source:
"qr"` with the order's id). `postSale(tx, input)` runs inside the caller's transaction and takes, in order,
the outlet (`lockLocation`, `FOR SHARE`), its register session (`sessionFor`), the payer's credit lock where
there is a payer, the shelves (`lockBalances`), then the one bill number - and returns `{ result, changed,
message }` **without announcing**: the caller adds what it changed besides and calls `emitChanged` once. A
caller with a document of its own (the capture's `qr_orders` row) locks it `FOR UPDATE` before calling. A
refusal throws; a caller that must commit something else when the sale is refused (a capture that refunds
instead) runs it in a savepoint (`tx.transaction(...)`) and reads the `RuleError`'s sentence.

- **The menu readers are shared too.** `sellableAt(db, loc)` reads the master, the outlet's menu, its shelf,
  its holds, its switches and every price list; `menuOf` turns that into lines at the till's price capped at
  MRP (`priceOf`), with availability, the reason and the free units (`coverOf`; made-to-order is unbounded);
  `assertSellable` is the till's four refusals (unknown item 404, not listed, not available, short, no price
  - and no price list at all, first). The public QR menu reads `menuOf`, so it can never offer what the
  sale would refuse.
- **A bill's source is stored**: `bills.source` (`till` | `qr`) and `bills.qr_order_id` (unique, so one bill
  per order - the insert decides a verify and a webhook racing; `bills_source_ck` keeps the two in step).
  `toWireBill` carries `src` and `qo` on a QR bill only, so a till bill's wire shape is unchanged.

## QR ordering: the gateway, the refunds and the system account

Migration `0027_qr_orders` (schema `db/schema/qr.ts`) holds codes, hours, the pause switch, orders and their
lines, `payment_refunds` and `rzp_webhook_events`. The routes, the webhook and the worker are
`modules/qr/` (Phase 2); what they stand on is here.

- **`lib/payments.ts` is the one door to the payment gateway.** `PaymentGateway` is create an order, fetch
  and capture a payment, refund and list a payment's refunds, and verify the checkout
  (`hmac(order_id|payment_id)`, key secret) and a webhook (`hmac(raw body)`, webhook secret) - HMAC-SHA256
  hex compared with `timingSafeEqual`. `createRazorpayGateway(cfg, fetchImpl)` is Razorpay's REST API over
  `fetch` with basic auth and no SDK, a 10 s timeout, and every field it relies on checked; a failure is a
  `GatewayError` whose `retryable` (network, timeout, 429, 5xx) is what the worker backs off on. **Never call
  it inside a transaction.** `plugins/payments.ts` decorates `app.payments`: the real gateway when all three
  Razorpay keys are set, `null` when none are (QR ordering then answers 503), or `AppDeps.payments` - a test
  injects `createFakeGateway()` (`src/test/fake-gateway.ts`: in-memory orders, payments and refunds, every
  call recorded, `failNext`, signing with fixed secrets) through `buildTestApp({ payments })`.
- **`lib/refunds.ts` is the only writer of `payment_refunds`** (`scripts/check-boundaries.sh`).
  `queueRefund` runs under the order's `FOR UPDATE` and numbers the refund `<order id>-R<n>` - also the
  `notes.rid` the worker sets at the gateway and looks for before sending again. `moveRefund` walks
  `REFUND_TRANSITIONS` (a retry, `Failed → Pending`, resets the attempts); `deferRefund` counts a failed
  send and backs it off 1 min, 5 min, 15 min, 1 h, 6 h, failing it on the sixth or at once when `final`.
- **The system account** (`lib/system-users.ts`): `systemOperator(tx)` gets or creates `sys-qr` (`SYS-QR`,
  "QR Orders", desk `counter` at the store, `system = true`, `role_id` null - `users_role_id_ck` is now
  `admin or system or role_id is not null` - password hash `!`). A race is settled by the primary key. Its id
  and number are outside the `u<n>` and `RC-<n>` series, so neither the user sequence nor `nextEmpNo` sees it.
  Sign-in treats it as an unknown number before any password check; the directory, the admin's account list
  and lookups (edit, delete, reset, deactivate are 404s), the location staff counts (and so the outlet
  close's), the users CLI (`byEmp`) and the snapshot's `users` all leave it out. `roleLabelOf` prints
  `System`, and its audit actor stands at no location. It never signs in, so it never opens a shift: a QR bill
  counts on the X and Z and on nobody's Close Shift.

## What a party is charged, and what they owe

`lib/terms.ts` is the one place a rate is resolved - `termsFor(db, party, payer?)`, the person's exception
over their category's row - and four callers read it: the sale that prices a bill, the till's credit
report, the Credit screen and the receivables list. A screen showing a rate the sale would not apply is
the whole defect it exists to prevent, so nobody else resolves one.

`lib/credit.ts` holds the balance: `outstandingFor` (every account-tender bill less every live settlement),
`openBillsFor` (what a settlement is laid over, oldest first) and `lockPayerCredit`, the advisory lock both
a credit sale and a settlement take before they read. Neither a voided bill nor a voided settlement counts.

`modules/receivables/` owns the rate card's two writes, the two lists and the settlement pair. None of them
touches `stock_moves`, `stock_balances` or a balance, so the server-wide lock order has nothing to order
here: each takes the one lock that matters for what it changes - the rate card row `FOR UPDATE`, or
`lockPayerCredit` on the person whose balance is moving.

**A settlement's allocation is stored, not derived.** It is a decision the server made at one instant
against the bills open then (`allocateSettlement` in `@rch/domain`); re-deriving it a week later against a
different set of open bills would answer differently. What a bill still owes is `settlement_lines`
subtracted from its own total, counting only settlements nobody voided.

## The register: X and Z

`modules/register/` owns the outlet's business day, and `lib/register.ts` owns the session row's
locking, because `pos` and `register` both take it and a second copy of that lock would be a second
chance to take it the wrong way round.

**Lock order here is outlet → session → id.** `pay` and `closeRegister` take the two document-tier
locks in the same order, so no cycle forms. `sessionFor` (the sale) finds or opens the session
`FOR SHARE`; `takeOpenSession` (the close) takes it `FOR UPDATE`; `holdSession` (the void) takes it
`FOR SHARE`, so a void in flight makes a concurrent Z wait and count it rather than printing a Z the
void is about to invalidate.

- **Two concurrent first sales are settled by the database**, not by a read: the partial unique
  index `register_sessions_one_open_per_loc` means one insert wins and the loser re-reads. Same
  principle as every other uniqueness rule here - the insert decides, the pre-check only supplies
  the sentence.
- **A Z's totals are stored on `closed_totals`**, for the reason a settlement's allocation is
  stored: re-deriving next week against a changed set of bills would answer differently.
- **Who reaches which register** is `registerOf` in `routes.ts`: a local caller only its own session's
  outlet (the 403 every location-scoped route gives), a wide one (`all_outlets`) any outlet by name and
  its own when it names none, and the super admin (`admitAdmin` on all three routes) any outlet - but it
  must name one, a 400 otherwise. No seeded role holds `z_report`, so out of the box only the super admin
  reads the Z list or takes a Z.
- **`closeRegister` does not `assertOpen` the outlet.** Refusing a Z at an outlet the admin has
  since closed would strand a day's money with no way to reconcile it. The outlet *close* names an
  open register as a blocker instead.
- **`oldBills` is hospital-wide inside the session's clock window.** `settlements` carries no `loc`
  and no `session_id` - a balance is the hospital's, not one counter's - so a payment keyed at one
  desk also appears on another outlet's Z if both were open. Narrowing it needs a column.

## Shifts

`lib/shifts.ts` owns a counter operator's shift, because two modules move it: `modules/auth`'s `login` calls
`startShift` for a `counter` account (keep the open shift at this counter, else auto-close the one elsewhere
and open one here), and `modules/shifts` serves the live report (`GET /shifts/current`), Close Shift
(`POST /shifts/close`) and the list (`GET /shifts`).

- **Every shift write takes `lockShiftsOf(tx, userId)` first**, an advisory lock on the person, in the
  documents tier before the `shift` id. Two racing sign-ins would otherwise both read "nothing open" and the
  loser would die on `shifts_one_open_per_user` as a 500 at the sign-in screen.
- **The window is a clock, not a foreign key**: that operator's bills at that counter with `at` between
  `opened_at` and the close. A bill carries its register session but no shift, and `pos` takes no shift lock.
- **A closed shift's figures are stored on `closed_totals`** (with `auto`), for the reason a Z's are, and the
  list reads them back rather than re-deriving them.
- **Close takes no `lockLocation`** and refuses (422) with no open shift, or one open at another counter than
  the session's. It announces `shifts`; so does a sign-in that auto-closed one.
- **`GET /shifts` is `access: "any"`**: a role holding `shift_reports` (the seeded Outlet Manager) reads every
  outlet's (`loc` narrows), any other counter-desk role its own, everybody else `[]` without a query - the
  `/receivables` reasoning, since a close announces to every tab.
- **`deleteUserTx` deletes the account's shifts** with its sessions. A shift is a sign-in record, not history;
  one that billed anything is still guarded by `bills.operator_id`'s own foreign key.

## Rate contracts and a purchase order's rate

`lib/contract-rates.ts` is the one place a contract's rate moves on account of an order, and the one writer of
`rate_contract_changes`. `createPo` reads each pick's optional `rate` (the first given per item; zero is refused)
and `updateLine` a `PATCH`'s `rate`; both call `lockLiveContracts` - the vendor's active, in-window contracts for
those items, `for update`, ascending id - then `syncContractRates`, which moves each one whose rate differs and
logs the change against the order. In `createPo` the contract lock is taken after the requisitions and before
`allocateId`; in `updateLine` after the order's row (and, when a quantity moves, the requisitions). A write that
moved a contract adds `contracts` to `changed` and appends `contract RC-… now ₹new (was ₹old)` to its sentence.
`contracts.patch` calls `logRateChange` itself when the rate actually moves (no order id). The vendor move on
`PATCH /purchase-orders/:id` re-prices lines from the new vendor's contracts and moves no contract.
`readRateChanges` puts the trail on each wire contract as `changes`, oldest first, omitted when empty.

## Price lists

`modules/pricelists/` owns the entity itself - create, delete (only once unattached) and switching an
outlet's active list - and the counter price grid, `saveOutletPrices` (`PUT /outlet-prices`). The
grid is the only one of these the UI shows today (`PRICE_LISTS_ENABLED` is off); the other three stay mounted.

**`saveOutletPrices` is copy-on-write.** It locks every outlet it names `FOR UPDATE` (sorted; it may move the
row onto a new list), then every list an outlet it reprices is on (`head`, sorted), then allocates any new
list id - documents before ids. An outlet on no list gets a new one; an outlet on a list another outlet
shares gets a clone of it, and the last one left keeps the original. Prices are then upserted onto each
outlet's own list and menu rows inserted or deleted. It writes one `auditBefore` of every cell as it stood,
and announces `prices`/`menu`, plus `priceLists`/`locations` when a list was made. `modules/catalog` keeps `savePrice`, which edits a list's own item→price rows and
never depends on which outlet (if any) it is active for. Neither refuses a price above the printed MRP, and
`PATCH /items/:it` does not refuse an MRP below a list price: the cap is the till's alone (`priceOf`, applied by
`POST /bills`).

**`cloneFrom` on `POST /price-lists` is optional.** Named, the new list is a copy of that outlet's current
active list and the source has to be an outlet that is actually on one. Absent, it starts empty. That is not
a convenience: while a source was required, the *first* price list on a hospital was the one list nobody could
create, because every outlet a form could offer answered `<outlet> has no price list to clone`.

None of the three writes touch `stock_moves`, `stock_balances` or a document table, so the lock order above
does not apply: each is a single `withTransaction` taking only `price_lists` and `locations` rows.
`pricelistsRepo.head` locks the target `price_lists` row `FOR UPDATE`, and both `remove` and `activate` take
it before doing anything else - so a delete and a switch of the same list serialise rather than race.
`activate` names an outlet, so it reads it through `lockLocation` and refuses a closed one (`assertOpen`) like
every other write that names a location: the list it switched to is what the outlet would sell the day it
reopened. The FK
(`locations.price_list_id` `ON DELETE RESTRICT`, `price_list_items.list_id` `ON DELETE CASCADE`) is the
backstop for a future writer that doesn't take that lock, not the primary guard; `catalog.savePrice` is one
such writer today - it reads whether the list exists unlocked, so its own insert is wrapped in a catch for the
same violation.

## Roles and permissions

A **role** (`roles`, `ROLE-00n`) is the super admin's: a name, a **desk** (the old fixed `role` enum - where the
holder works, its postings, its shift) and `perms` (`Permissions` from `@rch/contract`). Every account but the
super admin holds exactly one (`users.role_id`; `users_role_id_ck` allows null only with `admin`), and the
composite foreign key `(role_id, role) → roles(id, desk)` keeps `users.role` equal to its role's desk.
`users.role_label` is kept equal to the role's name (a rename rewrites it). Migration `0026_roles` seeds
`ROLE-001`…`ROLE-005` from `DESK_DEFAULTS` (one per desk, in `RoleSchema` order) and backfills every account;
`db:seed` (and `--force`, which never truncates `roles`, and so resumes the `role` series one past the highest
`ROLE-nnn` left on the table) puts each seeded account on its desk's lowest active
role; `truncateAll` in the test harness keeps `roles` too.

- **Permissions are read per request, never from the token.** `lib/access.ts`'s `loadAccess` joins the account
  to its role; `plugins/access.ts` decorates `app.access` with a per-pod cache of it (`of(userId)`, `clear()`,
  60 s TTL). `clear()` bumps a generation, so a read in flight across a clear answers its own request but is
  not kept. Three things clear it: a change notice naming `roles` (`plugins/sse.ts`, from any pod), a LISTEN
  reconnect, and - locally, after commit - every role write and every account write that moves a role's
  holders (the services take a `committed` callback).
- **`plugins/rbac.ts`, in order:** public passes; `access: "admin"` wants the admin claim, else 404; an admin
  token anywhere else is a 404 unless the route is `allowMcp` or admits it (`admitAdmin` - the manifest's own,
  which `mount()` passes, or `/events`' by hand), and an admitted admin skips permissions; every other token
  has its role resolved from `app.access`, and a deactivated account, a missing role, a switched-off role or a desk other than the
  token's `role` claim is a **401** "Your account was changed - sign in again." (the browser refreshes into a
  token for the account as it stands). Then `admits` (`@rch/domain`) decides: `{ desk }` reads the desk
  alone; `{ needs }` is 404 with no need met, 403
  with `permissionRefusal`'s sentence where the feature is held at view and edit was needed (or the parent
  of a missing action is held) **and the desk could be given what is missing** - a level or action the desk
  can never hold stays a 404 (the seeded manager on `POST /bills`: Bills at edit is the counter desk's
  alone). Finally the must-change-password 403.
- **`req.actor`** (`Actor` in `plugins/rbac.ts`, declared on `FastifyRequest` the way `req.user` is) is set on
  every non-public route: `{ ...claims, perms, wide }`. `wide` is `admits`' answer - the matched need is a
  hospital-wide feature, or the role holds `all_outlets`; for `"any"` and `{ desk }` it is `all_outlets`. A
  super admin's actor is `{ perms: { f: {}, a: [] }, wide:
  true }`. Read permissions in a service with `can(req.actor.perms, f, l)` / `holds(req.actor.perms, a)`
  from `@rch/domain`, passed down from `routes.ts` like `req.user`; never re-read the role. **A location
  check is `if (!req.actor.wide) requireLoc(...)`**, never a test of the desk: that is how a counter role
  given Approvals approves and withdraws any outlet's request, and a manager-desk role without
  `all_outlets` is held to its own outlet's X. Only desk *mechanics* still read `req.user.role`: which
  shelf `createItem` books to and which shelves `createAdjustment` may touch, the shift a counter's
  sign-in opens, the till `pay` rings on (always the session's), and the word in a location refusal.
- **`modules/roles/`** serves `/admin/roles`. Each write locks the role `FOR UPDATE`, calls `auditBefore`,
  applies the rules (a name clash - `roles_name_uq` decides; `grantRefusal`; no desk change once
  `ever_assigned`; no deactivation while any active account holds it, naming them; no delete once
  `ever_assigned`), bumps `version`, rewrites `role_label` on a rename, writes a `role_*` line in
  `admin_actions` (`target_id` null, the role's name as `target_name`) and announces `roles`. `holders` is
  the count of active, non-admin accounts on the role.
- **An account write takes the role, then the location.** `createUserTx` / `updateUserRoleLocTx` lock the role
  `FOR UPDATE` (by id, or - for the CLI and the seed - the desk's lowest active role), refuse a switched-off
  one, then `checkPairing(role.desk, loc)` through `lockLocation`, write `role`/`role_id`/`role_label` from the
  role and set `ever_assigned`. A move within the same desk and home location keeps the postings and
  sessions (the new permissions reach the next request through the cache); anything else resets the
  postings and revokes the sessions as before. `reactivateUserTx` refuses an account whose role is switched
  off. `set-admin --on` clears `role_id`; `--off` gives the desk's first active role back. Account writes
  that move a role's holders (create, move, deactivate, reactivate) announce `roles` and name `accounts` and
  `roles` in `changed`.
- **`toWireUser(u, role)`** carries `rid` and `perms` on sign-in, refresh, `/me` and `snapshot.user`, from a
  `loadAccess` read in the same transaction (not the cache); both are absent for the super admin.

## Accounts and the super admin

- **A super admin reaches no operational route.** Its `role`/`loc` columns are placeholders the `users` row
  needs, and it holds no role (`role_id` null). `plugins/rbac.ts` answers 404 to an admin-flagged token on
  every route that is not `access: "admin"`, not `allowMcp` (sign-in, password, `/me`) and not `admitAdmin`,
  so the placeholder opens nothing. `/events` passes `{ admitAdmin: true }` to `roleGate` by hand; a manifest
  route says `admitAdmin: true` and `mount()` passes it. `lib/wire.ts`'s `roleLabelOf` prints its role as
  `Super Admin`, and `PATCH /admin/users/:id` refuses to move one.
- **The server assigns employee numbers.** `POST /admin/users` takes no `emp`. `createUserTx` locks the
  `sequences` row of kind `user` (not an `IdKind`; inserted on first use, never by `ensureSequences`), then
  gives the account `nextEmpNo` over every `users.emp_no`. The same row hands out user ids, which only move
  forward (`greatest(next, max(id)+1)`), so a deleted account's id is never reused and its unexpired access
  token can never resolve to someone else. The CLI's `create` still accepts an explicit `--emp`.
- **`DELETE /admin/users/:id` removes only an account with no history.** The service refuses the caller's own
  account, a super admin, and an active account. `deleteUserTx` then drops the account's `refresh_tokens`,
  `idempotency_keys` and `shifts` and deletes the row. Every other reference to `users` has no `ON DELETE`, so Postgres's
  foreign-key refusal (`isForeignKeyViolation`, 23503) is the rule, and becomes a `RuleError`. Don't enumerate
  tables there: a new table that references `users` is covered by its own foreign key. Audit events are not
  history in this sense: `audit.events.actor_id` has no foreign key, so they never block a delete.
- **`admin_actions` stores `target_name` on every line.** `target_id` is `ON DELETE SET NULL`, and
  `recentActions` shows `coalesce(current name, target_name)`, so the log still names a deleted account.
- **`GET /auth/directory` is public**: active, non-admin accounts as `{ emp, n }`, for the sign-in picker. It
  has its own per-IP limit (120/min, `DIRECTORY_RATE_LIMIT_PER_MINUTE` in `modules/auth/routes.ts`), apart from
  the login limit.

## Outlets

The admin module (`modules/admin`) owns outlets - opened, edited, closed and reopened at `/admin`, never
deleted (root `CLAUDE.md`). Its close holds the outlet's row `FOR UPDATE` and counts everything still open
against it in **one statement** (`repo.ts`'s `closeBlockers`), because a dispatch, an answer, a receive or a
cancel moves a commitment from one counted category to another while naming no location at all - counted one
statement at a time, at READ COMMITTED, such a write can be seen by neither count. It refuses in one sentence
naming every blocker at once (`closeRefusal` in `@rch/domain`, over the statuses `HOLDS_OUTLET` marks as
still committing the outlet - a
dispatched kitchen order or a sent shop ask keeps an undo edge in its own transition table, but the ticket it
raised is what holds the outlet from then on).

Every outlet write runs inside one `withTransaction`, writes one `admin_actions` row, and calls
`emitChanged(tx, ["outlets", "locations"])` - unlike an account write, which announces at most `roles` (when it moves a role's holders). Every
operational browser refetches the location master on `locations`; every open admin tab refetches its own list
on `outlets`.

## Reads

A read that makes more than one query runs inside `withReadTransaction` and awaits its queries **in
sequence**, not with `Promise.all`. That way each request takes exactly one pool connection. The fan-out it
replaced exhausted the pool under load. Reader functions take `Reader` (`Db | Tx`), so one function serves a
standalone GET and a write validating inside its own transaction.

Two reads split deliberately:

- **Items.** `loadItems` (`lib/master.ts`) is what rules read, and filters out retired items. `readItems` is
  what the wire carries: the whole master, because old documents still name retired items.
- **Payers.** `GET /roster` returns live payers for the till, scoped empty for a role holding none of
  `billing`, `credit` and `settlements` (of the seeded roles: the store, the kitchen and the buyer). The register itself is the super admin's (`modules/admin`: `GET`/`POST /admin/payers`,
  `PATCH /admin/payers/:kind/:id`), which reads inactive ones too and carries what each still owes; the
  `payers import` CLI stays for a ward list nobody types twice.
- **The rate card and the receivables list are scoped, not gated.** `GET /payer-terms`, `GET /receivables`
  and `GET /settlements` are all `access: "any"`. The rate card answers empty to a role holding none of
  `billing`, `credit` and `settlements`; the last two answer empty, short-circuiting before they query
  anything, to a role without `settlements` - `credit` alone is the rate card, not who owes what (of the
  seeded roles, everybody but the Outlet Manager). That is deliberate: a credit write announces
  `terms`/`receivables` to **every** open browser, and a route another role is forbidden would fail that
  tab's whole refetch with a toast about a screen of theirs that never changed - the trap `UI/CLAUDE.md`
  documents for `priceLists`. `GET /receivables/:kind/:id` is gated (`need(settlements, view)`), because a statement is opened by
  hand from a drawer and is never in a `changed`.

The snapshot and every `access: "any"` GET that carries one of its collections (`/stock`, `/bills`,
`/requests`, `/tickets`, `/shop-asks`, `/prod-orders`, `/batches`, the five buying lists,
`/product-requests`, `/roster`, `/payer-terms`, `/adjustments`, `/adjustment-requests`) cut through
`modules/snapshot/scope.ts`, off `req.actor`: the desk (the token's `role`), the location the token stands at,
and the role's permissions as resolved for this request - never the desk alone. The rules, each of which
gives the five seeded roles exactly what their desks read before roles were configurable
(`scope.test.ts` pins it against a literal copy of the desk-only cuts):

- **The location cut is per collection** (`readsWide(desk, perms, collection)` in @rch/domain). The store,
  kitchen and purchasing desks are never cut. A counter- or manager-desk role reads a collection at its own
  location unless it holds `all_outlets` or a feature that widens that collection:

  | Collection | Widened by (besides `all_outlets`) |
  |---|---|
  | bills and `sales` | nothing |
  | stock, holds, sold-out marks, menus, adjustments | `items_stock`, `stock_ledger`, `inventory`, `prices`, `menu` |
  | requests, shop asks, kitchen orders, adjustment requests | `approvals` |
  | tickets | `approvals`, `items_stock` |
  | product requests | `approvals`, `menu` |

  So a counter role given the stock ledger reads every shelf but still only its own till roll, and a
  manager-desk role without "Works for every outlet" reads its home outlet's bills and takings.
- **The till roll needs Bills** (`readsBills`): a counter- or manager-desk role without `billing` reads no
  bills and empty takings (`sales` keeps a row per day, each empty), whatever else it holds - the Credit
  screen reads `/receivables`, `/settlements` and the statement, not bills. The back-office desks read
  bills whole, as before (less the names): the store's movers report counts what the counters sold.
- **The batch log and buying** (requisitions, orders, goods receipts, vendors, rate contracts) are cut by
  desk and feature, not by the counter cut: the four back-office desks always read them whole; a
  counter-desk role reads buying only with a Purchasing feature, `goods_receipt` or `inventory`, and the
  batch log only with a Kitchen feature or `items_stock`. Reading every outlet's till is no reason to read
  the back office.
- **Names**: a role holding none of `billing`, `credit` and `settlements` gets bills with `payer`, `customerName` and
  `customerPhone` stripped, an empty roster and an empty rate card.
- **The OTP** reaches only a caller at the ticket's `to` location, while the ticket is `Issued`, whose role
  holds `outlet_tickets`, `kitchen_tickets` or `issue_desk` at edit - the doors a collection goes through.
- A write's own response always carries `otp: ""`.
- **The super admin reads none of it.** None of these routes is `admitAdmin` (only the register's X, Z list
  and close are), so an admin token is a 404 on
  every one before a handler runs (`req.actor` for an admin has empty perms and would read nothing of note
  anyway).

## Protected tables

`scripts/check-boundaries.sh` enforces this by grep. Only `src/lib/`, `src/db/`, `plugins/idempotency.ts` and
test files may insert, update or delete these six tables: `stock_moves`, `stock_balances`, `reservations`,
`sequences`, `document_history`, `idempotency_keys`.

- `postMoves` is also checked to be the **only** place `stock_moves` is inserted.
- The check matches Drizzle calls and raw SQL, **line by line**. It can't tell code from comments, so don't
  write "update reservations" in a module comment.
- A **read** of a protected table from a module repo is fine. `posRepo.saleMoves` does one.
- `stock_moves` and `document_history` are append-only in the database; triggers refuse UPDATE and DELETE. To
  correct a mistake, append a reversing move or a correcting entry.
- **`payment_refunds` has one writer**, `src/lib/refunds.ts`; the same check refuses an insert, update or
  delete of it anywhere else outside a test.
- **`audit_outbox` is narrower still.** Outside test files, only `src/lib/audit.ts` inserts into it, and nothing
  selects, updates or deletes from it. The audit service is its only reader. Migration `0016_audit_outbox` also
  puts a trigger on it (`audit_outbox_no_update`) that refuses every UPDATE, for every role.

## Idempotency

- **Every non-public write needs an `Idempotency-Key` UUID.** The key is claimed before the handler runs
  (`plugins/idempotency.ts`, with the decision logic in `idempotency-claim.ts`):

  | Situation | Result |
  |---|---|
  | Fresh key | The handler runs |
  | Same key, response already stored | Replayed verbatim |
  | Same key, claim held by someone else | 409 |
  | Same key, stale uncommitted claim | Taken over and run |
  | Same key, different request body | 409 |

- **The outcome is written inside the write's own transaction**, so there is no moment when the write has
  committed but the key doesn't know it. A committed claim is never taken over or deleted.
- **In dev and test, a response that fails its own schema rolls the write back** and throws. In production it
  stands and is logged.
- **`withTransaction(db, fn, { response: "optional" })` is for a write that must commit something and then
  refuse.** Its only caller is `tickets.handover`, where a wrong OTP is counted, the count commits, and the
  refusal is thrown afterwards. Don't use it to quieten a schema mismatch.

## Audit capture

Every write and every sign-in leaves exactly one event in `audit_outbox`. The audit service (`apps/audit`)
drains it; this app only ever inserts. `lib/audit.ts` holds the code.

| Where | What it records |
|---|---|
| `mount()` | Puts the audit context (route name, method, path, params, query, body, request id, IP, user agent, caller) on the `idemStore` context of every non-public write, and adds the route to `mountedWrites` |
| `withTransaction` | Straight after `recordIdempotent` returns `ok: true`, in the same transaction: `recordAudit(tx, ctx, value)` inserts the `done` event |
| `plugins/audit.ts` (`onResponse`) | A reply no transaction recorded, from a caller a valid token identifies: `refused` for a 4xx (with `req.refusal`'s cause), `error` for a 5xx, `done` for production's `onSend` fallback. Body validation runs before authentication, so the hook verifies the bearer token itself, quietly. Inserted on the pool; a failed insert is logged at `error` and doesn't change the reply |
| `modules/auth` | `recordAuthEvent`: sign-in, failed sign-in (with its cause), lock-out, a sign-out that ended a live session, password change. A per-IP lock-out never reaches the handler (`@fastify/rate-limit` refuses in a `preHandler`), so an `onSend` hook in `modules/auth/routes.ts` records it |
| `recordSystemEvent` | What the system does with nobody signed in: an accepted anonymous QR write (the public routes are not audited by `mount()`), a capture billed or refunded, a refund sent, processed or failed. Always `done`, the QR Orders account as the actor, inside the caller's transaction, masked. A refused anonymous write leaves no event |

- **Not events:** a 401 (the client refreshes and retries, and the retry is the event), a reply carrying
  `idempotency-replayed: true`, a refused write with no verifiable token, a token refresh, `GET /auth/directory`,
  and every read. A failed sign-in is not a refused write: `modules/auth` records it.
- **One event per write.** A write that opens several transactions gets its event from the one that records the
  idempotency outcome, and the hook skips a request whose event already committed. A wrong handover OTP commits
  its attempt counter with no recorded response, so its event is the hook's `refused`.
- **The insert has no try/catch.** A write that can't be audited doesn't commit, the same stance as the
  idempotency record.
- **Every write that updates or removes an existing master row or account calls `auditBefore(value)`**, right
  after the service reads the row it is about to change (after its lock, where the service locks) and checks its
  404, before any rule or change, with
  the wire-shaped fields the edit can alter. A refused edit therefore carries its before too, and the last call
  wins. The Audit log's drawer diffs it against the result. A document state change (approve, dispatch,
  handover, void) doesn't call it; the result's trail carries the before.
- **`maskSecrets`** replaces the value of every key named in `SECRET_KEYS` with `MASK` (`"••••"`), in `request`,
  `result` and `before`: `password`, `newPassword`, `currentPassword`, `tempPassword`, `otp`, `token`,
  `accessToken`, `refreshToken` and `secret`. It matches whole names, not a pattern, so `mustChangePassword`
  stays a readable before → after. A new field that carries a secret joins `SECRET_KEYS`.
- **Every event sets `request`, `before` and `result`**, `null` where there is none; the drainer's schema sets
  aside an event missing one. A response with no `result` key (`PATCH /me`'s `{ user, mustChangePassword }`) is
  stored whole as `result`.
- **`targetOf(action, params, body, result)`** names what a write was about: `params.id`, `params.no` or
  `params.it`, else the result's `id`, `no` or `key`. Where one field is ambiguous the target is composite:
  `savePrice` is `list:it`, `addMenuItem` / `removeMenuItem` / `toggleAvail` are `loc:it`, `updatePoLine` /
  `removePoLine` are `id#n`. `targetLoc` is `params.loc`, `body.loc`, `body.from`, `result.loc` or
  `result.from`, the first that is set: a request, a ticket, a shop ask or a transfer names its location as
  `from`.
- **The actor is stored as it stood.** `actorOf` reads the caller's `users` row (one primary-key read) for the
  employee number, name, printed role label (`roleLabelOf`: the account's role name as it stood - "Counter Operator", "Outlet
  Manager" and the rest for the seeded roles, whatever the super admin named any other - or "Super Admin") and location (`""` for the super admin),
  so an event still reads after the account is renamed or deleted. A sign-in with an unknown employee id has
  `actor.id` null, and keeps the typed id as `emp` only when it matches `/^RC-\d+$/i`; anything else is stored
  as `""`, so a password typed into the id box never reaches the log.
- **The insert wakes the drainer.** `insertAuditEvent` follows each insert with
  `pg_notify('rch_audit_outbox', current_schema())`. The payload names the outbox's schema, so a drainer wakes
  only for its own outbox.
- **Sign-in events pass their `request` explicitly**: `{ body: { emp } }` for `login`, `{}` for `logout` and
  `changePassword`. The change-password body's keys (`current`, `next`) don't match the mask, so its body is
  never handed to the event.
- **Nothing in this app reads the outbox.** Not a module, not a lib; only tests. `rch_app` holds `insert` on it
  and nothing else, so a `select` would fail in production anyway.
- **A new write route needs its `AUDIT_LABELS` entry** (typecheck asks for it) and, if it edits an existing
  row, an `auditBefore` call. `modules/audit-capture.test.ts` asserts `mountedWrites` equals every
  `service: "api"` write in the manifest.

## Events

- **`emitChanged` sends a `pg_notify` inside the transaction**, so a refused write announces nothing. The
  channel name includes `current_schema()`, because each test file runs in its own schema.
- **`plugins/sse.ts` fans notices out to every open stream**, with one exception: it records whether each
  stream's token is an admin's, and sends an `audit` notice (only the audit service's drainer emits one) to
  admin streams alone. It holds one `LISTEN` client per pod and sends a `resync` after a reconnect.
- **`GET /events` is the one route outside the manifest and `mount()`**, so its auth and role gates are
  attached by hand. Its gate is `roleGate("any", false, { admitAdmin: true })`: with the register's X, Z list
  and close (`admitAdmin` in the manifest), the only routes that admit a super admin without being
  `access: "admin"`.

## Item photos

- **`src/lib/images.ts` is the one module that touches photo bytes at rest.** Two drivers behind one
  `ImageStore` interface (`put`/`get`/`delete`, content-addressed by `imageKey(itemKey, hash)`):
  `createS3Store` for every deployed process, `createDiskStore` for a laptop and the test suite - `config.ts`
  refuses anything but `s3` in production (above). `get` answers `null` for "no such object", never a throw; a
  throw is a real failure.
- **`src/plugins/images.ts` decorates `app.images`** from `config.images`, or from an injected store
  (`AppDeps.images`) when a test wants to own it. The S3 client takes its credentials from the default chain -
  the instance role over IMDSv2 on the box, the pod's IRSA role on EKS - so no key is ever configured.
- **The bytes go to the store before the transaction opens, in `catalog.setItemImage`.** The key is the
  photo's own sha256, so a retry or two identical uploads write the same object, and a transaction that then
  refuses leaves at most a few KB nobody points at. Only after commit, once the row points at the new hash, is
  the previous object deleted - best effort (a failed delete is swallowed), since the bucket's versioning keeps
  it another 90 days regardless (`deploy/RUNBOOK.md` §16.8).
- **`GET /items/:it/image/:hash`** is registered directly in the catalog module's `routes.ts`, outside the
  manifest the way `/events` is: an `<img>` sends no bearer token, and the answer is bytes, not JSON. It serves
  only the hash `items.image` currently holds, so a replaced or removed photo stops being served the moment the
  write commits.

## Errors

| Class | Status |
|---|---|
| `ValidationError` | 400 |
| `UnauthenticatedError` | 401 |
| `ForbiddenError` | 403 (wrong location) |
| `NotFoundError` | 404 (also "no such module for your role") |
| `ConflictError` | 409 |
| `RuleError` | 422 |
| `RateLimitedError` | 429 |
| `NotReadyError` | 503 |

- The wire shape is `{ error: { code, message, details? } }`. `message` is the toast the operator reads.
- Every 4xx also lands on the request's log line as `refusal: { code, message, cause? }`. `cause` is an
  internal reason, for example which of the three login failures it was. It is never serialised to the
  client. It is stored as the audit event's `cause`, which only the super admin reads.
- A 5xx sentence ends with the request id.

## Tests

The config pins `TZ=UTC`, a 30 s test timeout, and runs files in parallel.

- **`buildTestApp({ schema: "<name>" })`** migrates into its own schema, `t_<name>_<pid>`, and drops it on
  `close()`. `schema` is mandatory whenever the database is used. `buildTestApp({ withDb: false })` skips
  Postgres. It also gives every built app its own temp folder for `IMAGE_DIR`, so two test files' disk stores
  never collide.
- **Seeding and auth helpers:**
  - `seedTestDb(db)` seeds the fixtures.
  - `authHeaders(app, "u2")` mints a bearer token for a seeded user.
  - `resetDocuments(db)` truncates just the document tables. It's cheaper than a full reseed for suites that
    don't touch master data.
- **`given.*` in `src/test/builders.ts` is the only sanctioned way to make a document.** It allocates ids in
  bands above both the fixtures and the sequence starts. `given.adjustment` writes the document only, never a
  ledger move; `given.adjustmentRequest` likewise writes only the request, whatever status you hand it - it
  never calls `writeAdjustment`, so a case about the queue does not accidentally exercise the write path too.
  `given.qrCode` and `given.qrOrder` write a code and an order (its lines at the rates the case names, the
  secret `BUILDER_QR_SECRET` stored as its sha256 hex - export it once a case reads it; knip refuses an
  export nothing imports) and nothing else - no bill, no refund.
  `given.settlement` writes the payment and its allocation and nothing else, for the same reason: a case about
  the *ceiling* needs a balance brought down, and going through `POST /settlements` to get one would exercise
  the oldest-first allocation on the way past. There is no `given.payer`: insert into `payers` directly.
- **`sequences` survives truncation**, so never assert a literal allocated id. Match the shape and assert the
  relative step instead.
- **`lib/roles.test.ts` creates role names suffixed with the process id** and drops them afterwards, so files
  running in parallel never share a role. Roles belong to the server, not to a test file's schema.
- **The audit tests read `audit_outbox` directly** to assert what a real route inserted:
  `modules/audit-capture.test.ts` (completeness, done events, atomicity, refusals, masking),
  `modules/audit-before.test.ts` (every `auditBefore` service, the rate card and the payer register included) and `modules/auth/auth-audit.test.ts` (the
  sign-in events). Test files are the only place in this app a read of the outbox is allowed.
- **A test that reads a refusal's event awaits `app.auditSettled()` first.** The `onResponse` insert runs
  after `inject` resolves; `done` events commit inside the write and need no wait, and neither do the sign-in
  events.
- **A test that proves a lock holds must call `warmPool(t, n)` first**, with **n ≤ 4** (the test pool's
  `max`). Without it, `pg` connects lazily and the two "concurrent" transactions run back to back. Asking for
  more than 4 hangs the file. Show the test fails with the lock removed; a race test that can't fail is worse
  than none.

## Migrations and config

- **`db:generate`** wraps drizzle-kit and strips the `"public".` prefix, so migrations resolve through
  `search_path`. That is what lets each test file own a schema. Name migrations descriptively
  (`0010_adjustments`) and review the SQL.
- **`/readyz` compares applied migrations against the length of `drizzle/meta/_journal.json`.** A missing or
  renamed entry makes the pod unready.
- **A hand-written journal entry needs a real `Date.now()` as its `when`**, larger than every earlier entry.
  The migrator silently skips a migration whose `when` is smaller.
- **Some SQL is invisible to drizzle-kit.** Triggers, the `reservations_ticket_fk` foreign key and data
  inserts into `sequences` never appear in a diff. That is not drift, so don't "fix" it. Neither is the
  `payer_class_terms` seed in `0022`: the rate card has to have a row per category before a bare database
  can price a bill.
- **`runMigrations` ends by calling `ensureSequences`**, so a new `IdKind` needs no migration of its own and
  a database that is migrated but never re-seeded still has its row. It used to live in the seed alone, and a
  database is migrated on every deploy and seeded once, if ever - so `settlement`, `adj_req` and `price_list`,
  each introduced after the live box was seeded, had no row at all, and the first write of each kind died on
  `sequence "<kind>" is not initialised`: a bare 500 the operator read as "Record the payment does not work".
  `src/lib/ids.test.ts` migrates a schema, seeds nothing, and allocates every kind.
- **Dropping a value from a pg enum rebuilds the type.** Postgres has no `alter type ... drop value`, so
  `0023` deletes every row that still says `patient`, refuses in one sentence if a bill or settlement does
  (`deploy/RUNBOOK.md` §17), drops both composite foreign keys into `payers`, swaps all four columns through
  `text` and back, and puts the keys on again. A key joining two columns cannot be left in place while one
  side changes type.
- **A new value on a pg enum goes in a migration of its own.** Postgres runs `alter type ... add value`
  inside a transaction but refuses any statement in that same transaction that *uses* the value it added,
  so `0021` adds `doctor` and `0022` is everything that names one.
- **After writing a migration by hand**, run `db:generate` once to reconcile the snapshots in `meta/`. The
  emitted SQL must be empty, or only restate what you wrote. A second run must say "No schema changes".
- **`SEED_PASSWORD` is required** (at least 12 characters, no default). `DATABASE_SSL` defaults to on in
  production. Queries time out after 15 s; the CLIs pass `0`.
- **`DATABASE_URL` is the server's role; `MIGRATE_DATABASE_URL` (optional, `config.migrateDatabaseUrl`) is
  what `db:migrate` and every CLI connect with.** When the two name different users, `db:migrate` takes the
  role name and password from `DATABASE_URL`, creates the role if it is missing, sets its password (the literal
  escaped with `pg`'s `escapeLiteral`, never logged), and runs `grantAppRole`: `usage` on the schema,
  `select, insert, update, delete` on every API table and `usage, select` on their sequences (plus default
  privileges for what `rch` creates later), `select` on `drizzle.__drizzle_migrations` for `/readyz`, and on
  `audit_outbox` `insert` alone. No `truncate`, and nothing in `audit` or `audit_drizzle`. The grants are
  re-applied on every run. When the two URLs name the same user, as locally and in the tests, the migrations
  run and nothing else does.
- **QR ordering's config is optional.** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`
  are all or nothing (`config.razorpay`, null with none; some without the others is a `ConfigError` naming
  each one missing). `QR_ORDER_MAX_RUPEES` (5000), `QR_ORDER_TTL_MIN` (30) and `QR_WORKER_INTERVAL_MS`
  (30000; `0` switches the worker off) are `config.qr`. For all six an empty string - what Compose passes for
  an unset variable - means unset: no key, and the default for a number, never `0`.
- **Four config variables decide where photo bytes live**: `IMAGE_STORE` (`"disk" | "s3"`, default `disk`),
  `IMAGE_DIR` (default `.data/images`, used by `disk`), `IMAGE_BUCKET` and `AWS_REGION` (both required when
  `IMAGE_STORE=s3`). `NODE_ENV=production` with `IMAGE_STORE=disk` is a `ConfigError`: a second replica would
  never see the first one's folder, so production must be `s3`.
- **`db:seed` guards production.** Where `NODE_ENV=production`, it needs `--yes-seed <db name>`, and `--force`
  also needs `--yes-destroy <db name>`, each matching `current_database()`. The chart sets `NODE_ENV=production`
  in every pod, so an in-cluster seed always needs this form. The rules live in `lib/seed-guard.ts`.

## Shutdown

On SIGTERM, `/readyz` answers 503 at once. In production the server then waits 30 s, and after that
`app.close()` gets 25 s to drain. 30 + 25 fits inside the chart's `terminationGracePeriodSeconds: 60`. The ALB's
deregistration delay (30 s) must stay ≤ the pre-drain wait. If you change one of these numbers, change the
others with it.
