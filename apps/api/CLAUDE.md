# apps/api — CLAUDE.md

Repo-wide rules, branches and domain invariants are in the root `../../CLAUDE.md`; the design
contract is `docs/superpowers/specs/2026-09-03-backend-design.md` (§2 decisions, §16 amendments,
§14 build order). This file is what is specific to the server.

## What this is

`@rch/api`: Fastify 5 + Drizzle on PostgreSQL 17, ESM TypeScript, one pool per process. It owns
the ledger, the document numbers, the reservations and the change stream. All six phases are
live — auth, `/snapshot` and the master GETs, the counter sale, availability, prices and menus,
the whole request/ticket chain (including cancellation), shop transfers, shop asks, the
kitchen's board and its batches, `GET /events`, the whole of procurement (requisitions and the
buyer's decision in `requisitions`, the purchase-order lifecycle from draft to received or
cancelled in `purchaseorders`, goods receipt with its 2% tolerance and quarantine in `grn`,
vendors and rate contracts in `vendors`/`contracts`, a shop's ask for something not on the
master in `productreqs`, and every screen that adds a new product via `catalog`'s `POST
/items`), and Phase 6's last two modules: `support` (the customer-care desk — raise, reply, set
status, rate, all scoped to the caller's own tickets) and `reports` (the two server-side
queries a snapshot cannot answer: the stock ledger, and a payer's credit for the month). Nothing
is left in the browser's own store.

The audit fix wave added two more, taking `registerModules` to **twenty-one**: `payers` (the
register a non-cash tender is charged to — two writes and the manager's whole-register read) and
`adjustments` (a write-off or a stock count as a numbered document, and the register of them).
Three existing modules each gained a write in the same wave: `catalog` mounts a fifth
(`PATCH /items/:it`, the item master's second door), `pos` its second (`POST /bills/:no/void`) and
`production` its fifth (`POST /prod-orders` — orders are **raised** now, not only worked).

**`recipes` came after `admin` (2026-09-14)**: `PUT /recipes/:it`, `access: ["prod", "manager"]`,
replacing an item's whole recipe. Its lock order is the general rule's first term only — the item
row, `for update`; nothing is numbered and nothing moves, so there is no `lockBalances` (M12, the
`patchItem` reason). The rule is `recipeRefusal` in `@rch/domain`, asked against `loadItems` so a
retired ingredient reads as one the master does not have; a retired *target* is refused before it
(`<item> is retired — restore it before changing its recipe`). It signs `document_history` doc type
`item` with `Recipe added` / `Recipe changed`, beside `patchItem`'s `Updated`/`Retired`/`Restored`,
and names `["recipes"]` in `changed`. `GET /recipes` stays in `master`. The same change gave
`db/seed.ts` its **bare** form (`seedDatabase(..., { bare: true })`, `cli/seed.ts --bare`): the six
locations, `ensureSequences` and the admin-flagged fixture account, nothing else — and
`db/seed-bare.test.ts` proves `--bare --force` over the demo hospital leaves rows only in
`locations`, `users` (one) and `sequences`, iterating every table in the schema.

## Commands

```bash
pnpm --filter @rch/api dev                  # tsx watch, --env-file=../../.env, :3000
pnpm --filter @rch/api test                 # vitest; needs Postgres on 5439 (pnpm db:up from root)
pnpm --filter @rch/api typecheck            # tsc --noEmit
pnpm --filter @rch/api build                # tsup -> dist/server.mjs
pnpm --filter @rch/api db:generate          # drizzle-kit generate + scripts/strip-public-schema.mjs
pnpm --filter @rch/api db:migrate           # cli/migrate.ts, behind pg_advisory_lock(727272)
pnpm --filter @rch/api db:seed [--force] [--bare]   # cli/seed.ts; refuses a non-empty users table without --force; --bare = locations + RC-0001 only
pnpm --filter @rch/api db:rebuild-balances  # recompute stock_balances from stock_moves
pnpm --filter @rch/api users <create|reset-password|deactivate> --emp E1234 ...
pnpm --filter @rch/api payers import --csv <file> [--replace-names]   # kind,id,name — one transaction
pnpm --filter @rch/api keys:generate        # a fresh Ed25519 JWT_PRIVATE_KEY= / JWT_PUBLIC_KEY= pair
```

From the root, `pnpm lint` also runs `scripts/check-boundaries.sh` (below) and repo-wide `knip`.
`npx vitest run src/modules/tickets/tickets.test.ts` from inside `apps/api` runs one file.

## Layout

```
src/app.ts      buildApp(config, deps): plugins in order, then registerModules
src/server.ts   loadConfig -> buildApp -> listen; SIGTERM drains via readiness.setDraining()
                then waits 30s (production only) before app.close(), 25s drain timer — see below
src/config.ts   the Zod env schema — the only place an env var is read
src/routes.ts   mount(): the only way a module registers a route
src/plugins/*   logging, errors, metrics, health, security, db, auth, rbac, sse, idempotency
src/lib/*       the ledger, reservations, tickets, ids, history, rules, events, master, wire
                (which also holds PAYER_LABEL, read by `pos` and `payers` so the till's refusal
                and the register's 404 carry one wording), claims (a purchase order's hold on a
                requisition line), credit (a payer's bills-charged-this-month sum, shared by
                `pos` and `reports`), payers-admin (the CSV import's parsing and its rules)
src/modules/*   one folder per bounded slice; _template is the copy-me skeleton
src/db/*        schema/, client.ts, migrate.ts, seed.ts   ·   src/cli/*  the seven CLIs
src/test/*      app.ts, db.ts, seed.ts, auth.ts, builders.ts, env.ts
drizzle/*.sql   hand-reviewed migrations + meta/_journal.json
```

## A module, and how a write is composed

Every module is `routes.ts` / `service.ts` / `repo.ts` / `<name>.test.ts` — copy
`src/modules/_template/` and add one import plus one line to `src/modules/index.ts`. `routes.ts`
is parse → service → reply and nothing else; `service.ts` is the flow; `repo.ts` is SQL only and
never opens its own transaction.

A write, in the order it must be written (`modules/requests/service.ts` is the worked example):

1. `mount(app, routes.<name>, handler)` — auth, the role gate and (for a write) the idempotency
   preHandler are attached there, so a handler cannot forget them.
2. `requireLoc(req, body.loc, …)` in `routes.ts` when the request names its location;
   `requireLocOf(claims, row.loc, …)` in the service when only the document knows it. **A body
   that names the caller's own location is checked against the token, always** — `pos/routes.ts`
   and, since the audit wave, `productreqs/routes.ts` (`forLoc`, for a `counter`); a `manager`
   there reaches any outlet but no further, and asks for somewhere that is not one reads
   `<Location> is not an outlet`. A role that works one desk (`store`, `buyer`, `prod`) is
   scoped by `requireLoc` all the same; only `manager` is hospital-wide (root guide).
3. `withTransaction(db, async (tx) => …)` — `lib/db.ts`. Every write, no exceptions.
4. Lock the document row(s) being decided (`for update`, in the repo).
5. `allocateId(tx, kind)` / `allocateTicket(tx)` — locks the `sequences` row, gapless.
6. `lockBalances(tx, cells)` — then read on-hand and `reservedAt`. Lock first, read second.
7. Rules: `assertRule(cond, sentence)`, `assertTransition(TABLE, from, to, id)`, or a
   `NotFoundError` with a sentence. The arithmetic itself belongs in `@rch/domain`.
8. `postMoves` (stock actually moving), `writeTicket` / `reserve` (a hold), repo status writes.
9. `appendHistory(tx, docType, docId, status, who, at)`.
10. `emitChanged(tx, changed)` — last, with the same array the response carries.
11. Return `{ result, changed: [...], message }` — `writeResponse(...)` in the contract.
12. There is no step 12 you write. `withTransaction` writes the idempotency record itself, from
    the value you returned, as the **last statement before COMMIT** — see *Idempotency*, below.
    What that asks of you is only this: **return the write's answer from inside the transaction.**
    A service that closes its transaction and then re-reads the row to build its response has put
    the answer outside the COMMIT that protects it (`modules/me/service.ts`'s `patch` was the one
    that did, and no longer does).

**Lock order is documents → ids → balances, server-wide.** Two writers taking the same two locks
in opposite order deadlock; `lib/ledger.ts`'s header states the rule and every module keeps it.
Take a ticket number *before* the balance locks, never while holding a shelf.

**Two writes invert it, on purpose, and you may not copy either without the argument behind it.**
`modules/pos/service.ts` takes its
bill number *after* `lockBalances` and after the cover check has passed, and
`modules/adjustments/service.ts` takes its `ADJ-` number in the same place — immediately after the
cover check and immediately before `postMoves`, which is the latest reachable spot because
`postMoves` needs the `refId` to write its moves at all. Both are safe for a reason
no other write can borrow: `allocateId(tx, "bill"` and `allocateId(tx, "adj"` each have exactly
**one** caller in the tree, so
nobody else ever takes those `sequences` rows, and the cycle a lock order exists to prevent needs
two writers taking the same two locks in opposite orders. What the old ordering cost the sale was
a lock
convoy, not a deadlock — a sale queued behind a shelf held the one row every till in the hospital
draws its number from. What it cost the adjustment was worse and only a review caught it: with the
id taken at the head of the transaction, the module's own "two write-offs of the last unit" race
case **passed with `lockBalances` and the post-lock re-read both deleted**, because the second
writer blocked on the `adj` sequence row before it read any balance. A statement that serialises
first masks every guard behind it, and a race test that cannot fail is worse than none — measured,
not argued, by deleting each guard in turn and re-running. Note what neither inversion
cost: an allocation is an UPDATE inside the write's
own transaction, so a rollback gives the number back and the series is gapless through a refusal
(`lib/ids.ts` and `lib/tickets.ts` both say so; neither "burns" a number).

**A read is composed the same way, minus the locks: one transaction, one connection.** Every
read that makes more than one query runs inside `withReadTransaction(db, …)` (`lib/db.ts`,
`begin … read only`) and awaits its queries **in sequence**. `modules/snapshot/service.ts` is the
worked example: `GET /snapshot` and its thirteen standalone siblings, `reports`' two queries,
`support`'s list and `master`'s `GET /recipes` (heads and lines, the one outside this module) all
take exactly **one** connection out of the pool per request, and `snapshot.test.ts`'s "one
request, one connection" cases pin that by counting the pool's own `acquire` event. The reason is measured, not stylistic: `pg` checks a client out per query, so
the `Promise.all` fan-out this replaced asked for ~40 connections per snapshot against a pool of
10 — thirty concurrent readers queued hundreds of acquisitions, `pg_pool_idle` 0,
`pg_pool_waiting` peaking at 771, p95 2.9 s (RUNBOOK §12). Sequential rather than `Promise.all`
*inside* the transaction because a transaction is a single pg client and a client runs one query
at a time: concurrency there buys nothing, `pg` queues it today and will refuse it in pg 9. Every
reader and read-side repo therefore takes `Reader` (`Db | Tx`, `lib/db.ts`) rather than `Db`, so
one function serves a standalone GET and a write validating against its own transaction.

Three more rules the write order above encodes, stated here because Phase 4's `production`
module (`POST /prod-orders/:id/status`, `POST /batches`, beside `dispatch` and `distribute`)
and `tickets`' fifth write (`POST /tickets/:id/cancel`) are where they show up most sharply:

(a) **Every negative-going move takes the post-lock re-read.** `postMoves` holds the balance
locks; a service that moved stock down re-reads `on_hand − reserved` and refuses if any cell
went below zero. `sale` and `ticket_out` already did this — `makeBatch`'s
`production_consume` moves now do too, even though its own cover check already ran under the
same locks and so this second read can never fire today. Kept anyway: it is the invariant
spec §12 asks for on every negative-going move, and it is what catches the next caller that
reads a balance before locking it.

(b) **A write that both reads a balance and promises against it takes `lockBalances` in one
call before reading, over every cell it will move and no others.** `lockBalances` creates the
row it locks, so a speculative cell becomes a phantom "carried at zero" shelf line (M12) —
which is why `makeBatch` locks the finished item's cell only when a yield is coming — while a
missing one leaves `postMoves` reaching for a lock out of `(loc, item)` order.

(c) **`voidTicket` in `lib/tickets.ts` is the one door out of a ticket that was never
collected.** It releases the ticket's open holds, sets its status to `Cancelled`, and writes
the reason to `document_history` — and `releaseForTicket` (`lib/reservations.ts`) now has two
callers, `handover` and `voidTicket`, rather than one.

Four more rules Phase 5's buying modules (`requisitions`, `purchaseorders`, `grn`, `vendors`,
`contracts`, `productreqs`, and `catalog`'s `POST /items`) add:

(a) **The document lock order is narrower than the general one wherever a claim moves.** A
purchase order's claim on a requisition line is settled with the purchase-order row locked
before any requisition row, and requisition rows locked in one ascending sweep
(`lib/claims.ts`'s `lockRequisitions`). `createPo` is the one write that locks requisition rows
while holding no purchase-order lock — safe only because it is minting the order and can never
afterwards wait for an existing one. `lib/ledger.ts`'s header states the rule; `updateLine`,
`removeLine`, `cancel` (`purchaseorders/service.ts`) and `closeShort` (`grn/service.ts`) all
keep it.

(b) **A goods receipt takes no `lockBalances` of its own and no post-lock re-read.** `grn`'s
`receive` is the phase's only ledger write, and both its moves — `grn_accept` at the central
store, `grn_reject` at quarantine — are positive. Nothing here is promised against a balance,
so there is nothing for the belt-and-braces check `pay`/`handover`/`makeBatch` need to catch.
Do not add either one out of symmetry with them. **The rule has three more members since the
audit wave, and they split two ways.** `pos`'s `voidBill` is the second write whose moves are all
positive — a `reversal` is a sale's negative move negated — so it takes neither, for `receive`'s
exact reason. `catalog`'s `patchItem` and `production`'s `raise` take neither for the neighbouring
reason: they move **nothing at all**, and `lockBalances` creates the row it locks, so a write with
no cell to move must not lock one or it mints a "carried at zero" shelf line (M12). The one write
in the wave that does take both is `adjustments`' `create` — its moves can be negative.

(c) **A positive move is still only posted for a quantity greater than zero.** `lockBalances`
creates the row it locks, and a stray zero row reads as "carried" on every stock screen (M12).
That is why a clean delivery (nothing rejected) posts no `grn_reject` move at all, and why
`POST /items` posts no `opening` move for a new product with no opening stock.

(d) **The insert — or the update — is the arbiter for a uniqueness rule, the pre-check only gives
the sentence.**
A vendor's name (`vendors_name_ci_uq`), a live rate contract on a vendor and item (the partial
unique index `rate_contracts_live_uq`), and an item's name (`items_name_ci_uq`) are all decided
this way — `addMenuItem`'s pattern from Phase 2. `vendors.create`/`patch` and
`contracts.create` check first and let the insert or update catch the race; `catalog.createItem`
adds a `pg_advisory_xact_lock` on the item's slug ahead of its own check, because the slug scan
itself reads before the insert's own lock. **`catalog.patchItem` is the family's first *update*
arbiter** — `catalogRepo.update` catches `items_name_ci_uq` on a rename exactly as
`vendorsRepo.update` does, and the two patches in a rename race lock **different** document rows,
so the index really is what decides. **And `payers.create` is its first primary-key arbiter**:
`(kind, id)` is the composite PK, `insertIfNew` is `onConflictDoNothing().returning()`, and the
pre-check's `<id> is already on the <label> roster` is repeated verbatim when the insert returns
nothing.

`"prq"`, `"po"`, `"vendor"` and `"contract"` join the `IdKind`s below, and `"adj"` joined them in
the audit wave — `ADJ-<year>-<nnnn>`, padded to four rather than carrying the literal-zero prefix
`req`/`prq`/`po` use, because the series starts at **1** and a bare `ADJ-2026-1` beside
`ADJ-2026-10` sorts wrongly on every screen that sorts a document list as text. `"prd"` has been
in `IdKind` since Phase 1 and had no writer until `production`'s `raise`; it does now. A payer has
none at all — the id is the hospital's own number, so there is no `sequences` row for it, the same
shape the GRN note below describes. A GRN has none: there is
no `"grn"` in `IdKind` and no `sequences` row for it — `GRN-<yy><po number>-<nn>` (`grnId(poId,
n)` in `packages/domain/src/ids.ts`) is `count(*)` of that order's own GRN rows, read under the
order's own `for update` lock, which is what serialises two receipts drawing a number rather
than a sequence row.

Two more rules Phase 6's `support` and `reports` modules add, and one change to a Phase 3 read:

(a) **A support ticket writes no `document_history` row, on purpose.** Its history *is* its
conversation: `support_messages` already holds who said what and when, with the status sitting
beside it as a column, so a second trail in `document_history` would give the drawer two lists
to render and two to keep in step. `supportRepo.head`'s `.for("update")` is the module's one
lock, and every write takes only it — no support write ever touches `stock_balances`,
`stock_moves`, `reservations` or `sequences` beyond the one `allocateId` call `raise` makes.
`reports` takes no lock at all: both of its reads are queries, not writes, so neither opens a
transaction.

(b) **`readTickets` (`src/modules/snapshot/readers/documents.ts`) reads every ticket's
`document_history` alongside its heads and lines** — one query for every
ticket's trail, not one per ticket — and `scope.ts`'s `redactOtps` withholds the `otp` column
unless the ticket is `Issued`, the caller's `loc` is that ticket's `to`, **and** the caller's
role is `counter`, `prod` or `store` — the three roles that ever stand at a receiving location
and collect against a code. Applied to both `GET /snapshot` and the standalone `GET /tickets`,
so a refetch after a handover cannot put the digits back on a screen the snapshot had just taken
them off. **A write's own response is redacted too, and harder:** `writeTicket` and `readTicket`
(`apps/api/src/lib/tickets.ts`) return `otp: ""` unconditionally, because both are handed an id
and no `who` and so have nothing to check a reader's location or role against. The six digits
are read only from `GET /snapshot` or `GET /tickets`, by the receiving location. (The role check
on `redactOtps` landed in the Phase 6 fix wave, `19d486a` — without it, a manager whose `loc`
happened to match a ticket's `to` could read the code too, which is exactly the leak the
location check alone was meant to close.)

(c) **`GET /snapshot` gains `roster`** (`readers/master.ts`'s `readRoster`): every active row of
`payers`, split into `patients`/`staff`/`depts`. One query, assembled once in `snapshot()` — and
**scoped**, by role, along with the payer on every bill.

**Patient data is a role cut, not a location cut, and it is the fourth cut `scope()`'s `base`
makes for every role.** `READS_PAYERS` (`modules/snapshot/scope.ts`) is `{counter, manager}` —
the same two roles `creditReport` is gated to in `packages/contract/src/routes.ts`, so the two
now agree. For `store`, `prod` and `buyer`: `scopePayers` hands the bills over **whole minus the
name** (`{...b, payer: undefined}`) and `scopeRoster` hands back `{patients: [], staff: [],
depts: []}`. Who a bill was charged to is the one field on it that names a person, and for a
patient bill that is a name, a ward and an in-patient number — hospital data before it is F&B
data. The counter reads it back off its own till roll and the manager settles credit accounts
across the outlets; the kitchen, the store and the buyer do neither.

Two details that are decisions, not accidents. It is a **redaction, not a filter**: the store's
stock reports count bills as well as read their `lines`, so a filtered list would quietly stop
their totals matching the till's, which is worse than not seeing whose account a sale went to.
And it is applied in `scope()`'s `base` **and** in the standalone `bills()` reader, so a refetch
cannot put back what the snapshot just took off. `BillSchema.payer` was already `.optional()`, so
nothing in the contract changed.

Four more rules the audit wave's `payers`, `adjustments`, `patchItem`, `voidBill` and `raise` add:

(a) **`readItems` and `loadItems` deliberately part company.** `lib/master.ts`'s `loadItems` is
what every *rule* reads, and it still filters `active`: nothing may price, promise or bill a line
the master no longer sells, so a document naming a retired item answers `There is no item <key>.`
`modules/snapshot/readers/master.ts`'s `readItems` is what the *wire* reads, and it carries the
whole master, every line with `active` on it (`toWireItem` emits the field unconditionally),
because a bill, a ticket or a purchase order raised months ago still names a retired product and a
reader that dropped it would leave a raw key where a name belongs. The browser filters instead,
with `activeItems()`. The consequence to know before adding a screen: anything client-side that
iterates the item master as "what we sell" now needs that filter, and the failure mode of
forgetting it is a server refusal the screen could have prevented, not corruption.

(b) **The roster is two reads over one table, and the split is not an `active` flag on one read.**
`GET /roster` (mounted in `snapshot`, `access: "any"`) is the till's: live rows only, split into
`patients`/`staff`/`depts`, and cut by `scopeRoster` so `store`/`prod`/`buyer` read three empty
lists. `GET /payers` (mounted in `payers`, `access: ["manager"]`) is the register: every row
regardless of `active`, ordered by kind then name. Without the second, a payer deactivated in an
earlier session is one nobody can reopen — the browser never learns the account exists. Both payer
writes name **both** collections in `changed`, and `CHANGED = ["roster", "payers"]` is the single
array they emit and return.

(c) **A write whose scope depends on the role decides it in `routes.ts`, not in the service.**
`adjustments`' handler is the worked example: `store` reaches any `StockLoc` with no check at all,
`manager` is held to `OUTLETS` membership (`You can only adjust stock at an outlet — the central
store writes off its own shelves`), and `prod` goes through the ordinary
`requireLoc(req, body.loc, "the Central Kitchen")`. `production`'s `raise` is the same shape read
the other way: a `counter` with a `from` in the body is checked against the token
(`requireLoc(req, body.from, "your own counter")` — a 403 naming another shop, never a silent
rewrite) and then has `from` pinned to its own location, while a manager's body goes straight
through because one manager supervises every outlet. `voidBill` calls **no** `requireLoc`: a
manager is hospital-wide, and the counter that took the bill is exactly the party that must not be
able to unsell its own takings.

(d) **`document_history` now has eight doc types, and three of them are the wave's.** The
authoritative list is still `grep -rn 'appendHistory(' apps/api/src`: `request`, `requisition`,
`purchase_order`, `prod_order`, `ticket`, and now `item` (`Updated` / `Retired` / `Restored`, the
last two written only when the flag actually crosses), `adjustment` (signed with the reason's own
word from `@rch/domain`'s `REASON_LABEL`) and `bill` (exactly one row per bill, ever:
`Voided — <reason>`). None of the three is on the wire — `ItemSchema`, `AdjustmentSchema` and
`BillSchema` carry no `hist` — so the rows are for `deploy/RUNBOOK.md` §8 and for whoever is
asking what happened, not for a drawer.

## The protected tables

`postMoves()` in `src/lib/ledger.ts` is the only thing that writes `stock_moves` or
`stock_balances`; `src/lib/reservations.ts` is the only thing that writes `reservations`
(`reserve`, `releaseForTicket`, `reservedAt`). `sequences`, `document_history` and
`idempotency_keys` are protected the same way. `scripts/check-boundaries.sh` (run by `pnpm lint`
and as its own CI step) enforces it by **grep**, anywhere outside `src/lib/`, `src/db/`,
`plugins/idempotency.ts` and `*.test.ts`.

The greps used to be a literal list — `insert\(stockMoves\)` and five friends — matching exactly
the spelling `lib/ledger.ts` happens to use, so `insert(schema.stockMoves)`, `insert( stockMoves
)`, `insert into "stock_moves"` and `merge into stock_moves` all walked straight past the check
whose whole job was to stop them. They are **shapes** now, and all six tables take all three
verbs:

- Drizzle: `(insert|update|delete)` `(` any qualifier chain `)` one of `stockMoves`,
  `stockBalances`, `sequences`, `documentHistory`, `idempotencyKeys`, `reservations` `)`, with
  any spacing inside the parentheses.
- Raw SQL: `insert into` / `merge into` / `update` / `delete from` followed by the snake_case
  name, optionally quoted (`"stock_moves"`, backticks) and optionally schema-prefixed
  (`public.stock_balances`).

`stock_moves` and `document_history` take `update`/`delete` too — the first is append-only even
inside `lib/`, and a trail somebody can edit is not a trail. POSIX character classes rather than
`\s`/`\b`, because this runs on macOS as well as on CI's GNU grep. Two consequences: **do not
write one of those phrases in a comment in a module file** — the check still cannot tell prose
from code, and the widened pattern now catches ordinary English like "update reservations" — and
the checks are **line-oriented**, so a write split across lines by a formatter (`db\n  .insert(
stockMoves)`) is still invisible to them. It also asserts `insert(stockMoves)` appears in exactly
one non-test file, and that every module folder has the four skeleton files.

**A *read* of a protected table from a module repo is allowed, and one exists.** The greps match
`insert`/`update`/`delete` shapes only; a `select` is not a write, and `posRepo.saleMoves` — which
reads back the `kind = 'sale'` moves a bill posted, ordered by id, so `voidBill` can negate each
one — is the first module repo to do it. Do not "fix" it into `lib/ledger.ts`: the moves it reads
belong to `pos`'s own document, and the door that writes them is still the one `postMoves` call.
That read is also what gives `Move.reverses` its first writer — `reverses?: number`, mapped to
`stock_moves.reverses_id`, a column that has existed since `0000` with nothing setting it. A
reversal is the one move kind that carries it, and it carries the id of the exact move it undoes.

`batches` is not one of the protected tables — it is written directly from
`src/modules/production/repo.ts`, the ordinary way any module writes its own document row. What
is protected is the ledger a batch posts to (`production_consume`, `production_yield` — two
more `Move["kind"]` values alongside `sale`, `ticket_out`, `ticket_in`, …) and the `sequences`
row its number is drawn from: `"batch"` joins `"req"`, `"tkt"`, `"prq"`, `"po"`, `"vendor"` and
`"contract"` as an `IdKind` (`@rch/domain/src/ids.ts`), and `allocateNumber(tx, "batch", at)` is
what a batch id costs. `"grn"` is deliberately not among them — see *A module, and how a write
is composed*, above.

`stock_moves` is append-only in the database too: migration `0002` installs a trigger that raises
`stock_moves is append-only; correct with a reversing move` on any UPDATE or DELETE. Correct a
mistake with a reversing move, then `db:rebuild-balances` if the cache needs proving —
`rebuildBalances` zeroes rows and re-adds the moves, it never deletes rows, because a zero row
means "this location carries the line" (M12). **`document_history` is protected the same way from
migration `0008`**: `document_history_no_update_delete` (BEFORE UPDATE OR DELETE, the 0002
pattern) raises `document_history is append-only; append a correcting entry`. A trail that can be
edited afterwards is not a trail — correct one by appending, never by an `UPDATE`, and that now
holds against a bug and an ad-hoc `psql` session alike, not just against convention.

**`postMoves` drops a move whose quantity rounds away to nothing at three decimals**, before
anything is locked or inserted, **row by row** rather than by folded cell. A move of zero is not a
movement — `stock_moves_qty_ck` (0008) refuses one — and a recipe measured in millilitres against
a single cup is how one turns up; without the drop an ordinary sale answers 500 with no words in
it. Row-wise because the folded-cell version leaves two holes: a crumb riding along with a real
move on the same cell would still hit the constraint, and a genuine `+1`/`−1` pair on one cell
would lose both real ledger rows. The fold then runs over what survives, so a cell no surviving
move touches is never locked — and `lockBalances` creates the row it locks, which is how a
"carried at zero" phantom shelf line would otherwise appear (M12).

## Idempotency

Every non-public write needs an `Idempotency-Key` UUID header. The key is **claimed before** the
handler runs (`plugins/idempotency.ts` + the pure decision in `idempotency-claim.ts`): insert
wins → run; row already carries a response → replay it verbatim with `idempotency-replayed: true`;
fresh claim held by someone else → 409 "still being processed"; claim older than `CLAIM_STALE_MS`
(120 s, comfortably above app.ts's 30 s `requestTimeout`) **and not committed** → take it over and
run; different request hash for the same key → 409. A lookup that finds nothing is never a green
light — it retries the insert.

**The outcome is recorded inside the write's own transaction, as the last statement before
COMMIT.** `lib/db.ts`'s `withTransaction` reads the request's claim out of `idemStore` (an
`AsyncLocalStorage` that `mount()` fills for every non-public write) and calls
`recordIdempotent(tx, ctx, value)` (`lib/idempotency-record.ts`) on the value the transaction
returned: it `safeParse`s that value against the route's own response schema, stores the **parsed**
value so a replay serialises byte for byte, and stamps `committed_at` (column added by migration
`0007`) with a 24 h `expires_at`. The placement is the whole point — the row is committed by the
same COMMIT that commits the bill, so there is no instant at which the write has happened and the
key does not know it. Everything that used to sit between the two (the pod staying alive, the pool
handing out a second connection, the response surviving its own serializer) is out of the picture,
and the retry that used to become a second bill replays instead.

Five consequences, each load-bearing:

(a) **A committed claim is never deleted and never taken over.** `tryTakeover` and both `onSend`
branches carry `committed_at is null`; `recordIdempotent`'s own UPDATE carries it too, so a
straggler whose claim was taken over mid-write cannot overwrite the winner's answer — zero rows
updated is exactly that race, and it takes the straggler down rather than the record.

(b) **The record's UPDATE is deliberately not wrapped in a try/catch.** If writing the claim row
throws, the business write rolls back with it. That is the opposite of the `onSend` hook, which
warns and lets the response through, and it is the right way round: a write that commits without
its record is the duplicate-charge hole this closes. Atomicity over availability, on purpose.

(c) **In development and test a response that fails its own schema rolls the write back and
throws; in production it stands.** `strict` is `config.env !== "production"` (set by `mount()`).
Strict turns "this transaction's answer cannot be recorded" into a red bench rather than an
un-replayable sale; production carries the reason out on `ctx.why`, logs it at `warn` with the
route and key, and falls back to `onSend`. `NOT_RECORDED` is `mount()`'s own narrower cause — a
write that opened no transaction at all — and both paths carry a sentence a `grep` finds.

(d) **`withTransaction(db, fn, { response: "optional" })` is for a write that must commit
something and then refuse** — a counter, an audit row, something that has to survive the refusal
that follows it. Under it, a returned value the schema refuses records nothing, leaves
`ctx.idem.recorded` false and throws nothing, and `onSend` stores the 4xx as it always has
(`committed_at` stays null, because a refusal is not an outcome to protect). A value that *does*
match is still recorded, so the success path is untouched — and if a success value ever stops
matching its schema under `"optional"`, the write commits and then 500s through `mount()`'s own
assertion in dev/test; it is not silent. **`modules/tickets/service.ts`'s `handover` is the one
caller** (a wrong OTP is counted, the count commits, the sentence is thrown outside), and what it
costs is a pod dying between that commit and `onSend`: the retry waits out `CLAIM_STALE_MS` and
then counts a second guess. Acceptable for a counter; exactly what `"required"` refuses to accept
for a bill. Do not reach for it to quieten a response that simply does not match its schema.

(e) **`onSend` is now the fallback, not the mechanism.** `idemHooks.recordAfterSend` returns
untouched when the transaction already recorded a 2xx; deletes an *uncommitted* claim on a 5xx or
a 429 (so a throttled write is not permanently replayed as "too many requests"); and otherwise —
a 4xx, or a 2xx nothing recorded — writes the row the way it always did.

`POST /auth/change-password` is the one non-public write the whole mechanism does not cover: it is
declared `write: false` in the manifest (it carries no `Idempotency-Key`) and so gets no claim row
at all. Pre-existing, and named here so the next reader does not conclude the coverage is total.

## The event stream

`lib/events.ts`'s `emitChanged` calls `pg_notify` **inside the write's transaction** — Postgres
holds it until commit, so a refusal announces nothing. The channel carries the schema name
(`rch_events_` + `current_schema()`), because every test file runs in its own schema in one
database. `plugins/sse.ts` holds one `LISTEN` client per pod (backoff on reconnect, a `resync`
frame after a drop), fans notices out to every open stream, heartbeats every `SSE_HEARTBEAT_MS`,
and tears down on `preClose` — not `onClose`, or Fastify's own close would hang on a socket a
stream is holding. `GET /events` is **the one route outside the manifest and `mount()`**: a stream
has no JSON response schema and would hang `contract.test.ts`'s probe. Being outside `mount()`
means its gates are attached by hand, and they are: `preHandler: [app.authenticate,
app.roleGate("any", false)]`, with `rbac` declared as a plugin dependency. The `false` is
`allowMcp` — the stream was the one authenticated route a must-change-password token could still
reach, and it now answers a 403 JSON envelope rather than opening.

## Errors and sentences

`lib/errors.ts`: `ValidationError` 400, `UnauthenticatedError` 401, `ForbiddenError` 403,
`NotFoundError` 404, `ConflictError` 409, `RuleError` 422, `RateLimitedError` 429,
`NotReadyError` 503. Everything serialises to `{ error: { code, message, details? } }`. Role
decides whether a route exists for you (**404**, like the sidebar); location decides which rows
(**403**). The `message` is the toast the operator reads: a full sentence in their voice, and
where the browser store already said something (`creditBreachMessage`, the MRP refusal) the
server repeats it **word for word** rather than inventing a second wording.

`Access` (`packages/contract/src/routes.ts`) gains a third special value alongside `"public"` and
`"any"`: `"admin"`, checked in `roleGate` (`plugins/rbac.ts`) against the JWT's own `admin` claim
rather than `role` — a capability, not a role (root CLAUDE.md), so `AccessClaims` and
`signAccess` both carry it beside `mcp`. A caller without the flag gets the same 404 a role
without a module gets, never a 403 that would confirm the route exists. `modules/admin/` is the
one module gated this way today — account management (create/reset/deactivate/reassign), built
entirely on `lib/users-admin.ts`'s `*Tx` cores composed inside its own single `withTransaction`
alongside the `admin_actions` row that records the write, rather than restating any of that
module's rules. Granting or revoking the flag itself has no route at all — `pnpm --filter
@rch/api users set-admin` is the only door, deliberately outside the HTTP surface it protects.

A 4xx also lands on the request's own log line as `refusal: { code, message, cause? }`:
`plugins/errors.ts` sets `req.refusal` on every branch that answers 4xx (the not-found handler
too) and `plugins/logging.ts`'s `onResponse` writes it beside `route`, `status` and `ms`. `cause`
is `AppError`'s optional fifth argument — `UnauthenticatedError(message, cause)` is the one
subclass that takes it so far — and is the internal reason for the operator reading the log,
**never serialised**: `toEnvelope()` does not know it exists. The login is the worked example:
one sentence on the wire for all three cases, and `no such employee` / `wrong password for
RC-4471` / `RC-4471 is deactivated` in the log — with the id left out of the first, because what
was typed into that box may have been the password. A 5xx is logged as `unhandled` with the
error itself, and its sentence ends with the request id.

## Tests

`vitest.config.ts`: node env, `TZ=UTC`, `testTimeout` 30 s / `hookTimeout` 60 s, setup
`src/test/env.ts`, file parallelism on.

- `buildTestApp({ schema: "<name>" })` creates schema `t_<name>_<pid>`, migrates into it, binds
  the app and drops it on `close()`. `schema` is mandatory whenever a database is used — without
  it two files race over one name. `buildTestApp({ withDb: false })` skips Postgres entirely.
  `logStream: { write }` (with `env: { LOG_LEVEL: "info" }`, since the harness default is
  `silent`) hands the app a pino destination so a test can read its own log lines back —
  `errors.test.ts`'s refusal-line cases and `auth.test.ts`'s login causes are the two that do.
- `seedTestDb(db)` seeds the fixtures; `authHeaders(app, "u2")` mints a bearer for a seeded user
  without walking the login flow. `truncateAll` empties business tables but **keeps `sequences`**.
- `resetDocuments(db)` (`src/test/db.ts`) is the cheaper alternative to `truncateAll →
  seedTestDb`: it truncates exactly the 29 document and vendor tables (`db/seed.ts`'s
  `seedDocuments(tx)` re-populates them in one call) and leaves master data, users and payers
  seeded once per file in `beforeAll`. A suite that only opens and closes documents — not one
  that mutates `items`, `locations`, `recipes`, `users` or `payers` — should use it;
  `purchaseorders.test.ts` is the converted example, roughly twice as fast on a quiet host.
- `given.{request,ticket,shopAsk,bill,prodOrder,vendor,requisition,po,contract,productRequest,
  supportTicket,adjustment}` (`src/test/builders.ts`) are the only sanctioned way to make a
  document — **twelve** of them since the audit wave. Their
  id bands sit above both the fixtures and the sequence starts: `REQ-2026-0991+`, `TKT-0801+`,
  `ASK-0101+`, `CF/9001+`, `PRD-2026-901+`, `VN-901+`, `PRQ-2026-901+`, `PO-2026-0901+`,
  `RC-901+`, `NPR-0901+`, `SUP-000101+`, `ADJ-2026-9001+`. `given.adjustment` writes the document
  and its history row and **no ledger move**: `postMoves` is the one door, and a builder reaching
  through it would be standing in for the write under test. There is deliberately **no**
  `given.payer` — `payers` is master data, seeded once per file and not in `resetDocuments`'s
  list, so `POST /payers` is how a test makes one.
- Because `sequences` survives truncation, **never assert a literal allocated id** — match the
  shape (`/^REQ-\d{4}-0\d+$/`) and assert the *relative* step (`n(second) === n(first) + 1`).
- A test that opens two concurrent transactions to prove a lock must call `warmPool(t, n)` first
  (`pg` connects lazily, so without it the two run back to back and pass with the lock removed),
  and must be shown to fail once the lock is taken out. A race test that cannot fail is worse
  than none. **`n` must not exceed the test pool's `max`, which is 4** (`src/test/db.ts`):
  `warmPool` awaits a `Promise.all` of `pool.connect()` calls and releases nothing until they all
  resolve, so asking for five hangs for ever holding four connections and every later test in the
  file times out at 30 s. Every call site in the tree is 2, 3 or 4. A test that wants more
  concurrency than the pool has connections usually does not need it — `auth.test.ts`'s gate
  cases hold to the budget before their first `await`, whether or not each request got a
  connection.

## Migrations, config, metrics

Generate with `db:generate` — drizzle-kit writes the SQL and `scripts/strip-public-schema.mjs`
strips the literal `"public".` prefix so migrations resolve through `search_path` (that is what
lets each test file own a schema). Review and commit the SQL. `drizzle/meta/_journal.json` is
hand-maintained alongside it and its length is what `/readyz` compares the applied count against,
so a renamed file or a missing entry makes the pod unready. Names are descriptive
(`0002_stock_moves_append_only`), not drizzle's generated animals.

**The journal is at thirteen entries, `0000`–`0012`**, so `/readyz` reads `13 / 13` on a current
database; the audit fix wave wrote the last six of them by hand.
`0007_idempotency_committed_at` adds one nullable column; `0008_integrity` writes the
promises this file already made into the database — `reservations_ticket_idx` (partial, on
`released_at is null`) and `reservations_ticket_fk` → `tickets(id)`; `tickets.otp_attempts integer
not null default 0`, `otp` from `char(6)` to `varchar(6)` with `tickets_otp_digits_ck`
(`~ '^[0-9]{6}$'`) and `tickets_from_to_ck` (`from_loc <> to_loc`); the CHECKs
`stock_moves_qty_ck` (`qty <> 0`), `reservations_qty_ck` (`> 0`), `batches_made_ck`
(`0 ≤ made ≤ started`), `po_lines_receipt_ck` (`0 ≤ rejected ≤ received`),
`requisition_lines_ordered_ck` (`0 ≤ ordered ≤ approved`), `support_tickets_rating_ck` (null or
1–5) and `sequences_next_ck` (`> 0`); and the `document_history` append-only trigger. Everything
but the FK and the column-type change is mirrored in `src/db/schema/*.ts` with Drizzle's
`check()`; the FK is SQL-only because importing `tickets` (`schema/movement.ts`) into
`schema/ledger.ts` closes a TypeScript import cycle, and the reason is a comment on
`reservations.ticketId`.

`0009`–`0012` are the wave's four smaller ones: `0009_payers_audit` gives `payers` the
`created_at`/`updated_at` every other master table already carried, `0010_adjustments` adds the
`adjust_reason` enum and the `adjustments`/`adjustment_lines` document pair (and the `sequences`
row their ids are drawn from), `0011_prod_orders_need_by` one nullable `date`, and
`0012_bills_void` the three nullable columns and the `voided_by` foreign key behind a same-day
void.

**`stock_balances.on_hand >= 0` is deliberately absent**, and the reason is written at the top of
`0008`: the friendly refusal an operator reads ("Only 2 nos of Mineral water 1L left at Coffee
Shop") comes from the re-read that runs *after* `postMoves` has already driven the balance down
under the locks it holds, so a CHECK would fire first and turn every one of those sentences into a
500 with no words in it. The negative never survives — the same transaction rolls it back.

**The snapshots are reconciled: `meta/0012_snapshot.json` is what the next `db:generate` diffs
against.** All six hand-written migrations skipped `drizzle-kit generate`, so `meta/` sat at
`0000`–`0006` and the next generate would have re-emitted everything `0007`–`0012` already did.
The reconcile ran once, and the procedure is written down here because the next hand-written
migration will need it again:

1. `pnpm --filter @rch/api db:generate --name reconcile` — `db:generate` is
   `scripts/db-generate.mjs`, a wrapper that forwards its argv to `drizzle-kit generate` before
   running the strip step, so `--name` reaches drizzle-kit rather than landing on the strip
   script the way it did when `db:generate` was a bare `&&` chain of the two.
2. Read the emitted `.sql`. It must be **empty, or restate only what the hand-written migrations
   already did** — that is the proof the applied SQL and `src/db/schema/*.ts` agree. Anything else
   is real drift, and the fix goes in the schema file, never in SQL a database has run.
3. Delete the emitted `.sql` and its `_journal.json` entry, and rename the emitted
   `meta/00NN_snapshot.json` to the journal's latest idx. Nothing is applied to any database by
   this; it is bookkeeping so the *following* schema change generates a correct diff.
4. Prove it: a second generate must print `No schema changes, nothing to migrate` and leave no
   file behind.

Four things about drizzle-kit the procedure rests on, none of them obvious from the outside:

- **The snapshot it diffs against is the lexically last file in `meta/`**, not the journal's last
  entry — `prepareOutFolder` reads the directory, sorts it, and takes the end. `0012_snapshot.json`
  sorts after `0006_snapshot.json`, which is the whole reason the rename works.
- **The chain is by UUID, not by filename**: each snapshot's `prevId` is the previous one's `id`,
  so renaming the file leaves it intact. But drizzle-kit *aborts* where two snapshots share a
  `prevId`, so never keep both the emitted name and the renamed copy.
- **Three things in the applied SQL are invisible to drizzle-kit in both directions.** They are
  not drift and must not be "fixed": `reservations_ticket_fk` (SQL-only, because the import would
  close a cycle — above), the `document_history` trigger and its function (drizzle-kit models no
  triggers, and `0002`'s `stock_moves` trigger is in the same position), and `0010`'s `insert into
  sequences`, which is data. Generate will never emit them and never drop them.
- **A hand-written `when` must be in the past.** `drizzle-orm`'s migrator (`pg-core/dialect.ts`)
  applies a file only where its `when` is **greater** than the highest `created_at` already in
  `__drizzle_migrations`, so a later migration carrying a smaller `when` is **silently skipped** —
  no error anywhere, and `/readyz` reading `n/m` is what eventually says so. `0007`–`0012`'s are
  strictly increasing, which is what matters, but `0012`'s (`1789160000000`, 2026-09-11T20:53 UTC)
  was written a couple of hours ahead of the clock: a generate before that instant would have
  emitted a smaller one. Put a real `Date.now()` in an entry you write by hand.

`scripts/preflight-0008.sql` is the read-only companion to all of this — ten SELECTs, one per
row-validating constraint `0008` adds, printing `clear` or `BLOCKS 0008` for each. Run it before
`db:migrate` against any database that already holds documents (`RUNBOOK.md` §1 and §11.1 say what
to do about each): `0008` validates existing rows, and a refused migration is an initContainer
that never completes, which presents as a deploy that hangs rather than as bad data.

`config.ts` is the only reader of `process.env`: `NODE_ENV`, `PORT`, `LOG_LEVEL`, `DATABASE_URL`,
`TEST_DATABASE_URL`, `DATABASE_SSL`, `DB_POOL_MAX`, `CORS_ORIGIN`, `JWT_PRIVATE_KEY`,
`JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL_DAYS`,
`COOKIE_SECURE`, `SEED_PASSWORD`, `SEED_FORCE_PASSWORD_CHANGE`, `RATE_LIMIT_PER_MINUTE`,
`LOGIN_RATE_LIMIT_PER_MINUTE`, `LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE`, `SSE_HEARTBEAT_MS`,
`SSE_RETRY_MS`, `TRUST_PROXY`. (`PG_CA_BUNDLE` is read directly by `db/client.ts` for the RDS CA.)
`DB_POOL_MAX` is the pool's `max`, default **10**, set in the chart's `api.env` for both
environments — one pod's share of the instance's connections, not a latency dial: a request takes
exactly one connection, so a pool at its ceiling means that many requests in flight.

Three of those knobs changed in the audit fix wave and bite on first run:

- **`SEED_PASSWORD` is `z.string().min(12)`, required, with no default.** The API, the test
  harness and every CLI refuse to start without one — `Invalid environment: SEED_PASSWORD: Too
  small …`. `src/test/app.ts`'s `BASE_ENV` supplies its own; a developer's `.env` has to.
- **`DATABASE_SSL` is optional and defaults to `NODE_ENV === "production"`** (`databaseSsl` in
  `config.ts`). Setting it still wins in both directions — a staging pod pointed at a local proxy
  can turn it off — and `db/client.ts` strips any `sslmode`/`ssl*` parameter off `DATABASE_URL`
  first, so the URL can never quietly pick a different trust store.
- **`createDb(url, ssl, { statementTimeoutMs })` defaults to 15 s and every CLI passes `0`.**
  `cli/{migrate,seed,rebuild-balances,purge}.ts` are allowed to run longer than a request is;
  `cli/migrate.ts` also runs `set lock_timeout = 0` before `pg_advisory_lock(727272)`, because
  waiting for that lock is the whole point of the initContainer and the 15 s statement timeout
  was cancelling the wait mid-rollout (`Init:CrashLoopBackOff`).

`cli/seed.ts` carries two guards of its own, and **both make the operator name the database back**
(exit 2, with the reason): where `NODE_ENV === "production"` a plain seed needs `--yes-seed <name>`
and `--force` additionally needs `--yes-destroy <name>`, `<name>` in each case equal to `select
current_database()`. The chart renders `NODE_ENV=production` into every pod, so an in-cluster seed
— dev, CI's kind cluster, anywhere — is always the `--yes-seed` form. That is the whole reason the
older `--allow-production` was replaced: a flag typed on *every* in-cluster seed carries no
decision, so it was routine rather than a stop, and `--yes-seed rch_dev` cannot be muscle memory
for `rch`. It is still recognised and, on its own, **refused** with a sentence naming `--yes-seed`,
so a copied runbook line fails loudly. The CLI itself is argv in / sentence out: the decisions are
a pure `seedGuard({ env, argv, dbName })` in `lib/seed-guard.ts`, tested without a database, and
the CLI only opens the connection (`select current_database()`), prints and exits.
`lib/users-admin.ts` enforces `MIN_PASSWORD_LENGTH`
(10, declared once in `packages/contract/src/schemas/auth.ts` and read by
`ChangePasswordBodySchema` too) on `createUser` and `resetPassword`, and `WORKS_AT` refuses a role
at a location that role never works at — `Kitchen In-charge works at kitchen, not at coffee`.

`modules/auth/service.ts`'s per-employee sign-in budget (`LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE`,
default 5) is spent by `begin()` when an attempt **starts** and given back by `release()` only
when the password turns out to be correct, so it holds under concurrency: Argon2 takes 50–100 ms,
and a budget read before the verifier and charged after it let N simultaneous guesses all reach
the verifier. It counts **failures** — five correct sign-ins in a minute lock nobody out — and,
like `@fastify/rate-limit`'s own window, it is **per pod**: the effective number is the configured
one times the replica count, and a shared store is the fix if it ever has to be exact.

`/metrics` publishes `http_request_duration_seconds`, `sse_clients`, `sse_listener_up`,
`sequence_allocations_total{kind}`, `pg_pool_total`, `pg_pool_idle`, `pg_pool_waiting`, plus
prom-client defaults. `/healthz` is liveness; `/readyz` runs every registered check — and a
failing check's own `Error` **message** is appended to the 503's sentence (`Not ready: database
— schema at 0/7 migrations.`) as well as logged, so a check writes a phrase for an operator and
never the driver's own message (a `DrizzleQueryError` carries the failing SQL, and spec §12 keeps
SQL out of responses). `plugins/db.ts` is where that curation happens for the one check that
exists, and nothing that can throw is left outside a `try` there — `unreachable or unmigrated`,
`migration journal unreadable` (`expectedMigrationCount` reads `drizzle/meta/_journal.json` off
disk, and an `ENOENT` names paths inside the image), or `schema at <n>/<m> migrations`.

## Shutting down, and the nightly sweep

**`server.ts`'s SIGTERM handler is four numbers that have to agree with the chart.** It sets
`readiness.setDraining()` (so `/readyz` answers 503 at once), then in production *waits 30 s
doing nothing* before calling `app.close()` behind a 25 s drain timer. What the wait buys is not
the ALB's health check: it is this pod leaving the Service's `Endpoints` (readiness probe every
5 s × `failureThreshold: 3` = 15 s) **and** the AWS Load Balancer Controller reconciling that
removal into the target group. The ALB's own 15 s check is the backstop behind those two, not
the driver.

The constraint, written as one: **deregistration delay ≤ pre-drain wait**. The target group's
`deregistration_delay.timeout_seconds` is 30 (`alb.ingress.kubernetes.io/target-group-attributes`
in `values.yaml` and `values-prod.yaml`), and a pod that stops accepting while the target group
is still draining connections into it cuts exactly the requests that delay exists to let finish.
30 + 25 = 55, inside `terminationGracePeriodSeconds: 60` on `templates/api-deployment.yaml`,
after which the kubelet sends SIGKILL. Move one of the four and move the others. Outside
production the wait is `0`, so a local Ctrl-C still exits immediately — but note the chart
renders `NODE_ENV=production` into **every** pod, CI's kind cluster included, so the 30 s is felt
there too.

**The nightly purge deletes in batches, not in one statement.** `purgeIdempotencyKeys`
(`plugins/idempotency.ts`) and `purgeRefreshTokens` (`modules/auth/repo.ts`) each loop
`delete … where ctid in (select ctid from <t> where <predicate> limit <batch>)` until a batch
comes back short of `PURGE_BATCH` (10 000, declared in both files). One unbounded `DELETE` over a
table that has grown for months takes a lock and a WAL burst proportional to the whole backlog;
a bounded loop takes neither. Both take an optional `batch` argument purely so a test can make it
smaller than the work — nothing in production passes one, and the two tests count `db.delete`
**statements** rather than rows, because an unbatched implementation returns the same row total.
The cutoff `Date` is taken **once per sweep** and reused across batches, so "what this run
deleted" is not a moving target; the revoked-token half of `purgeRefreshTokens` deliberately
leaves `now()` inside the statement, since against a seven-day grace no sweep runs long enough to
carry a row across that line. Neither query has an index on its predicate (`schema/infra.ts`
indexes `token_hash`, `family` and `user_id`, and nothing on `expires_at`/`revoked_at`), so each
batch is a LIMIT-bounded sequential scan — fine for a job that runs once a night and stops as
soon as it has its ten thousand. The CronJob that runs them
(`deploy/chart/rch/templates/purge-cronjob.yaml`) is bounded too: `startingDeadlineSeconds: 600`,
`backoffLimit: 2`, `activeDeadlineSeconds: 1800`, three kept runs of each outcome.
