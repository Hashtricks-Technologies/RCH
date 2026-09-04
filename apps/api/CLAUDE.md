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
/items`), and now the last two modules: `support` (the customer-care desk — raise, reply, set
status, rate, all scoped to the caller's own tickets) and `reports` (the two server-side
queries a snapshot cannot answer: the stock ledger, and a payer's credit for the month). Nothing
is left in the browser's own store.

## Commands

```bash
pnpm --filter @rch/api dev                  # tsx watch, --env-file=../../.env, :3000
pnpm --filter @rch/api test                 # vitest; needs Postgres on 5439 (pnpm db:up from root)
pnpm --filter @rch/api typecheck            # tsc --noEmit
pnpm --filter @rch/api build                # tsup -> dist/server.mjs
pnpm --filter @rch/api db:generate          # drizzle-kit generate + scripts/strip-public-schema.mjs
pnpm --filter @rch/api db:migrate           # cli/migrate.ts, behind pg_advisory_lock(727272)
pnpm --filter @rch/api db:seed [--force]    # cli/seed.ts; refuses a non-empty users table without --force
pnpm --filter @rch/api db:rebuild-balances  # recompute stock_balances from stock_moves
pnpm --filter @rch/api users <create|reset-password|deactivate> --emp E1234 ...
pnpm --filter @rch/api keys:generate        # a fresh Ed25519 JWT_PRIVATE_KEY= / JWT_PUBLIC_KEY= pair
```

From the root, `pnpm lint` also runs `scripts/check-boundaries.sh` (below) and repo-wide `knip`.
`npx vitest run src/modules/tickets/tickets.test.ts` from inside `apps/api` runs one file.

## Layout

```
src/app.ts      buildApp(config, deps): plugins in order, then registerModules
src/server.ts   loadConfig -> buildApp -> listen; SIGTERM drains via readiness.setDraining()
src/config.ts   the Zod env schema — the only place an env var is read
src/routes.ts   mount(): the only way a module registers a route
src/plugins/*   logging, errors, metrics, health, security, db, auth, rbac, sse, idempotency
src/lib/*       the ledger, reservations, tickets, ids, history, rules, events, master, wire,
                claims (a purchase order's hold on a requisition line), credit (a payer's
                bills-charged-this-month sum, shared by `pos` and `reports`)
src/modules/*   one folder per bounded slice; _template is the copy-me skeleton
src/db/*        schema/, client.ts, migrate.ts, seed.ts   ·   src/cli/*  the six CLIs
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
   `requireLocOf(claims, row.loc, …)` in the service when only the document knows it.
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

**Lock order is documents → ids → balances, server-wide.** Two writers taking the same two locks
in opposite order deadlock; `lib/ledger.ts`'s header states the rule and every module keeps it.
Take a ticket number *before* the balance locks, never while holding a shelf.

**A read is composed the same way, minus the locks: one transaction, one connection.** Every
read that makes more than one query runs inside `withReadTransaction(db, …)` (`lib/db.ts`,
`begin … read only`) and awaits its queries **in sequence**. `modules/snapshot/service.ts` is the
worked example: `GET /snapshot` and its thirteen standalone siblings, `reports`' two queries and
`support`'s list all take exactly **one** connection out of the pool per request, and
`snapshot.test.ts`'s "one request, one connection" cases pin that by counting the pool's own
`acquire` event. The reason is measured, not stylistic: `pg` checks a client out per query, so
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
Do not add either one out of symmetry with them.

(c) **A positive move is still only posted for a quantity greater than zero.** `lockBalances`
creates the row it locks, and a stray zero row reads as "carried" on every stock screen (M12).
That is why a clean delivery (nothing rejected) posts no `grn_reject` move at all, and why
`POST /items` posts no `opening` move for a new product with no opening stock.

(d) **The insert is the arbiter for a uniqueness rule, the pre-check only gives the sentence.**
A vendor's name (`vendors_name_ci_uq`), a live rate contract on a vendor and item (the partial
unique index `rate_contracts_live_uq`), and an item's name (`items_name_ci_uq`) are all decided
this way — `addMenuItem`'s pattern from Phase 2. `vendors.create`/`patch` and
`contracts.create` check first and let the insert or update catch the race; `catalog.createItem`
adds a `pg_advisory_xact_lock` on the item's slug ahead of its own check, because the slug scan
itself reads before the insert's own lock.

`"prq"`, `"po"`, `"vendor"` and `"contract"` join the `IdKind`s below. A GRN has none: there is
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
`payers`, split into `patients`/`staff`/`depts`. One query, assembled once in `snapshot()` and
passed through `scope()` untouched — not scoped by role or location, because every counter
bills every kind of payer and the list is names the operator already reads off a wristband.

## The protected tables

`postMoves()` in `src/lib/ledger.ts` is the only thing that writes `stock_moves` or
`stock_balances`; `src/lib/reservations.ts` is the only thing that writes `reservations`
(`reserve`, `releaseForTicket`, `reservedAt`). `sequences`, `document_history` and
`idempotency_keys` are protected the same way. `scripts/check-boundaries.sh` (run by `pnpm lint`
and as its own CI step) enforces it by **grep**, so the literal strings matter: it greps for
`insert(stockMoves)`, `insert|update|delete(stockBalances)`, `insert|update(sequences)`,
`insert(documentHistory)`, `insert|update(idempotencyKeys)`, `insert|update|delete(reservations)`
and the raw-SQL equivalents (`insert into stock_moves`, `update stock_balances`,
`delete from reservations`, …) anywhere outside `src/lib/`, `src/db/`,
`plugins/idempotency.ts` and `*.test.ts`. Do not write one of those phrases in a comment in a
module file — the check cannot tell prose from code. It also asserts `insert(stockMoves)` appears
in exactly one non-test file, and that every module folder has the four skeleton files.

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
means "this location carries the line" (M12).

## Idempotency

Every non-public write needs an `Idempotency-Key` UUID header. The key is **claimed before** the
handler runs (`plugins/idempotency.ts` + the pure decision in `idempotency-claim.ts`): insert
wins → run; row already carries a response → replay it verbatim with `idempotency-replayed: true`;
fresh claim held by someone else → 409 "still being processed"; claim older than `CLAIM_STALE_MS`
(120 s, comfortably above app.ts's 30 s `requestTimeout`) → take it over and run; different
request hash for the same key → 409. A lookup that finds nothing is never a green light — it
retries the insert. `onSend` fills the row in, and deletes it for a 5xx or a 429 so a throttled
write is not permanently replayed as "too many requests".

## The event stream

`lib/events.ts`'s `emitChanged` calls `pg_notify` **inside the write's transaction** — Postgres
holds it until commit, so a refusal announces nothing. The channel carries the schema name
(`rch_events_` + `current_schema()`), because every test file runs in its own schema in one
database. `plugins/sse.ts` holds one `LISTEN` client per pod (backoff on reconnect, a `resync`
frame after a drop), fans notices out to every open stream, heartbeats every `SSE_HEARTBEAT_MS`,
and tears down on `preClose` — not `onClose`, or Fastify's own close would hang on a socket a
stream is holding. `GET /events` is **the one route outside the manifest and `mount()`**: a stream
has no JSON response schema and would hang `contract.test.ts`'s probe.

## Errors and sentences

`lib/errors.ts`: `ValidationError` 400, `UnauthenticatedError` 401, `ForbiddenError` 403,
`NotFoundError` 404, `ConflictError` 409, `RuleError` 422, `RateLimitedError` 429,
`NotReadyError` 503. Everything serialises to `{ error: { code, message, details? } }`. Role
decides whether a route exists for you (**404**, like the sidebar); location decides which rows
(**403**). The `message` is the toast the operator reads: a full sentence in their voice, and
where the browser store already said something (`creditBreachMessage`, the MRP refusal) the
server repeats it **word for word** rather than inventing a second wording.

## Tests

`vitest.config.ts`: node env, `TZ=UTC`, `testTimeout` 30 s / `hookTimeout` 60 s, setup
`src/test/env.ts`, file parallelism on.

- `buildTestApp({ schema: "<name>" })` creates schema `t_<name>_<pid>`, migrates into it, binds
  the app and drops it on `close()`. `schema` is mandatory whenever a database is used — without
  it two files race over one name. `buildTestApp({ withDb: false })` skips Postgres entirely.
- `seedTestDb(db)` seeds the fixtures; `authHeaders(app, "u2")` mints a bearer for a seeded user
  without walking the login flow. `truncateAll` empties business tables but **keeps `sequences`**.
- `resetDocuments(db)` (`src/test/db.ts`) is the cheaper alternative to `truncateAll →
  seedTestDb`: it truncates exactly the 27 document and vendor tables (`db/seed.ts`'s
  `seedDocuments(tx)` re-populates them in one call) and leaves master data, users and payers
  seeded once per file in `beforeAll`. A suite that only opens and closes documents — not one
  that mutates `items`, `locations`, `recipes`, `users` or `payers` — should use it;
  `purchaseorders.test.ts` is the converted example, roughly twice as fast on a quiet host.
- `given.{request,ticket,shopAsk,bill,prodOrder,vendor,requisition,po,contract,productRequest,
  supportTicket}` (`src/test/builders.ts`) are the only sanctioned way to make a document. Their
  id bands sit above both the fixtures and the sequence starts: `REQ-2026-0991+`, `TKT-0801+`,
  `ASK-0101+`, `CF/9001+`, `PRD-2026-901+`, `VN-901+`, `PRQ-2026-901+`, `PO-2026-0901+`,
  `RC-901+`, `NPR-0901+`, `SUP-000101+`.
- Because `sequences` survives truncation, **never assert a literal allocated id** — match the
  shape (`/^REQ-\d{4}-0\d+$/`) and assert the *relative* step (`n(second) === n(first) + 1`).
- A test that opens two concurrent transactions to prove a lock must call `warmPool(t, n)` first
  (`pg` connects lazily, so without it the two run back to back and pass with the lock removed),
  and must be shown to fail once the lock is taken out. A race test that cannot fail is worse
  than none.

## Migrations, config, metrics

Generate with `db:generate` — drizzle-kit writes the SQL and `scripts/strip-public-schema.mjs`
strips the literal `"public".` prefix so migrations resolve through `search_path` (that is what
lets each test file own a schema). Review and commit the SQL. `drizzle/meta/_journal.json` is
hand-maintained alongside it and its length is what `/readyz` compares the applied count against,
so a renamed file or a missing entry makes the pod unready. Names are descriptive
(`0002_stock_moves_append_only`), not drizzle's generated animals.

`config.ts` is the only reader of `process.env`: `NODE_ENV`, `PORT`, `LOG_LEVEL`, `DATABASE_URL`,
`TEST_DATABASE_URL`, `DATABASE_SSL`, `DB_POOL_MAX`, `CORS_ORIGIN`, `JWT_PRIVATE_KEY`,
`JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL_DAYS`,
`COOKIE_SECURE`, `SEED_PASSWORD`, `SEED_FORCE_PASSWORD_CHANGE`, `RATE_LIMIT_PER_MINUTE`,
`LOGIN_RATE_LIMIT_PER_MINUTE`, `LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE`, `SSE_HEARTBEAT_MS`,
`SSE_RETRY_MS`, `TRUST_PROXY`. (`PG_CA_BUNDLE` is read directly by `db/client.ts` for the RDS CA.)
`DB_POOL_MAX` is the pool's `max`, default **10**, set in the chart's `api.env` for both
environments — one pod's share of the instance's connections, not a latency dial: a request takes
exactly one connection, so a pool at its ceiling means that many requests in flight.

`/metrics` publishes `http_request_duration_seconds`, `sse_clients`, `sse_listener_up`,
`sequence_allocations_total{kind}`, `pg_pool_total`, `pg_pool_idle`, `pg_pool_waiting`, plus
prom-client defaults. `/healthz` is liveness; `/readyz` runs every registered check — and a
failing check's own `Error` **message** is appended to the 503's sentence (`Not ready: database
— schema at 0/7 migrations.`) as well as logged, so a check writes a phrase for an operator and
never the driver's own message (a `DrizzleQueryError` carries the failing SQL, and spec §12 keeps
SQL out of responses). `plugins/db.ts` is where that curation happens for the one check that
exists: `unreachable or unmigrated`, or `schema at <n>/<m> migrations`.
