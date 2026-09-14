# apps/api — CLAUDE.md

Repo-wide rules and the domain invariants are in the root `CLAUDE.md`. This file covers what is specific to the
server.

## Commands

```bash
pnpm --filter @rch/api dev                  # tsx watch, reads ../../.env, :3000
pnpm --filter @rch/api test                 # vitest; Postgres on 5439 (pnpm db:up); floor lines 94 / branches 79
pnpm --filter @rch/api build                # tsup → dist/server.mjs
pnpm --filter @rch/api db:generate          # drizzle-kit generate + strip the "public". prefix; review + commit the SQL
pnpm --filter @rch/api db:migrate           # behind pg_advisory_lock
pnpm --filter @rch/api db:seed [--force] [--bare]
pnpm --filter @rch/api db:rebuild-balances  # recompute stock_balances from stock_moves
pnpm --filter @rch/api users <create|reset-password|deactivate|set-admin> --emp RC-1234 ...   # create: --emp optional, next number assigned
pnpm --filter @rch/api payers import --csv <file> [--replace-names]   # kind,id,name — one transaction
pnpm --filter @rch/api keys:generate        # prints a fresh Ed25519 JWT_PRIVATE_KEY= / JWT_PUBLIC_KEY= pair
pnpm --filter @rch/api loadcheck            # latency of /snapshot and /bills against a running API
```

## Layout

```
src/app.ts        buildApp(): plugins in order, then registerModules
src/server.ts     listen; SIGTERM drains (see Shutdown)
src/config.ts     the Zod env schema — the only reader of process.env
src/routes.ts     mount(): the only way a module registers a route
src/plugins/*     logging, errors, metrics, health, security, db, auth, rbac, sse, idempotency
src/lib/*         ledger, reservations, tickets, ids, history, rules, events, claims, credit, master, …
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
   writes.
9. **Record it:** `appendHistory(tx, docType, docId, status, who, at)`, then `emitChanged(tx, changed)`.
10. **Return `{ result, changed, message }` from inside the transaction.** `withTransaction` records the
    idempotency outcome from that value as its last statement before COMMIT. A service that re-reads a row
    after its transaction has closed puts its answer outside the protection.

### Lock order

Lock order is **documents → ids → balances**. Take a ticket number before the balance locks, never while
holding a shelf.

- **Purchase-order claims use a narrower order:** the PO row first, then the requisition rows in ascending
  order (`lib/claims.ts`). `createPo` is the one write that locks requisition rows without holding an order
  lock. That is safe only because it is minting that order.
- **Two writes invert the order on purpose:** `pos` (bill number) and `adjustments` (`ADJ-` number) allocate
  after the cover check. Each is the only caller of its own sequence row, so the deadlock a lock order
  prevents can't form.
- **Don't copy the inversion.** An id taken at the head of a transaction serialises everything behind it and
  masks every balance guard. That is how a race test on adjustments once passed with both guards deleted.

### Balances

- **Lock only the cells you will move.** `lockBalances` creates the row it locks, and a stray row shows up as
  a phantom "carried at zero" shelf line (tag M12).
- **Writes that move nothing** (`patchItem`, `production.raise`, the recipe editor) take no `lockBalances` at
  all.
- **Writes whose moves are all positive** (`grn.receive`, `pos.voidBill`) take neither `lockBalances` nor a
  re-read. Nothing is promised against a balance there. Don't add them for symmetry.
- **Every write that moves stock down re-reads `on_hand − reserved` after `postMoves`**, and refuses if any
  cell went negative. There is deliberately no `on_hand >= 0` CHECK in the database: it would fire before the
  re-read and turn the operator's sentence into a bare 500.
- **`postMoves` drops a move that rounds to zero at three decimals**, row by row, before locking anything.
  `stock_moves_qty_ck` refuses a zero move.

### Uniqueness

For a uniqueness rule, the insert (or update) decides; a pre-check only gives the sentence. `vendors_name_ci_uq`,
`rate_contracts_live_uq`, `items_name_ci_uq` and the `payers` primary key `(kind, id)` all work this way.
`catalog.createItem` also takes a `pg_advisory_xact_lock` on the item's slug.

## Accounts and the super admin

- **A super admin reaches no operational route.** Its `role`/`loc` columns are placeholders the `users` row
  needs. `plugins/rbac.ts` answers 404 to an admin-flagged token on every route that is not `access: "admin"`
  and not `allowMcp` (sign-in, password, `/me`), so the placeholder role opens nothing. A hand-mounted route the
  admin's page needs passes `{ admitAdmin: true }` to `roleGate`; `/events` is the only one. `lib/wire.ts`'s
  `roleLabelOf` prints its role as `Super Admin`, and `PATCH /admin/users/:id` refuses to move one.
- **The server assigns employee numbers.** `POST /admin/users` takes no `emp`. `createUserTx` locks the
  `sequences` row of kind `user` (not an `IdKind`; inserted on first use, never by `ensureSequences`), then
  gives the account `nextEmpNo` over every `users.emp_no`. The same row hands out user ids, which only move
  forward (`greatest(next, max(id)+1)`), so a deleted account's id is never reused and its unexpired access
  token can never resolve to someone else. The CLI's `create` still accepts an explicit `--emp`.
- **`DELETE /admin/users/:id` removes only an account with no history.** The service refuses the caller's own
  account, a super admin, and an active account. `deleteUserTx` then drops the account's `refresh_tokens` and
  `idempotency_keys` and deletes the row. Every other reference to `users` has no `ON DELETE`, so Postgres's
  foreign-key refusal (`isForeignKeyViolation`, 23503) is the rule, and becomes a `RuleError`. Don't enumerate
  tables there: a new table that references `users` is covered by its own foreign key.
- **`admin_actions` stores `target_name` on every line.** `target_id` is `ON DELETE SET NULL`, and
  `recentActions` shows `coalesce(current name, target_name)`, so the log still names a deleted account.
- **`GET /auth/directory` is public**: active, non-admin accounts as `{ emp, n }`, for the sign-in picker. It
  has its own per-IP limit (120/min, `DIRECTORY_RATE_LIMIT_PER_MINUTE` in `modules/auth/routes.ts`), apart from
  the login limit.

## Reads

A read that makes more than one query runs inside `withReadTransaction` and awaits its queries **in
sequence**, not with `Promise.all`. That way each request takes exactly one pool connection. The fan-out it
replaced exhausted the pool under load. Reader functions take `Reader` (`Db | Tx`), so one function serves a
standalone GET and a write validating inside its own transaction.

Two reads split deliberately:

- **Items.** `loadItems` (`lib/master.ts`) is what rules read, and filters out retired items. `readItems` is
  what the wire carries: the whole master, because old documents still name retired items.
- **Payers.** `GET /roster` returns live payers for the till. `GET /payers` returns every payer for the
  manager's register.

The snapshot redacts by role:

- `store`, `prod` and `buyer` get bills with `payer` stripped and an empty roster.
- A ticket's OTP reaches only a caller at the ticket's `to` location, while the ticket is `Issued`, whose role
  is `counter`, `prod` or `store`.
- A write's own response always carries `otp: ""`.

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

## Events

- **`emitChanged` sends a `pg_notify` inside the transaction**, so a refused write announces nothing. The
  channel name includes `current_schema()`, because each test file runs in its own schema.
- **`plugins/sse.ts` fans notices out to every open stream.** It holds one `LISTEN` client per pod and sends
  a `resync` after a reconnect.
- **`GET /events` is the one route outside the manifest and `mount()`**, so its auth and role gates are
  attached by hand. Its gate is `roleGate("any", false, { admitAdmin: true })`, the only route that admits a
  super admin without being `access: "admin"`.

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
  client.
- A 5xx sentence ends with the request id.

## Tests

The config pins `TZ=UTC`, a 30 s test timeout, and runs files in parallel.

- **`buildTestApp({ schema: "<name>" })`** migrates into its own schema, `t_<name>_<pid>`, and drops it on
  `close()`. `schema` is mandatory whenever the database is used. `buildTestApp({ withDb: false })` skips
  Postgres.
- **Seeding and auth helpers:**
  - `seedTestDb(db)` seeds the fixtures.
  - `authHeaders(app, "u2")` mints a bearer token for a seeded user.
  - `resetDocuments(db)` truncates just the document tables. It's cheaper than a full reseed for suites that
    don't touch master data.
- **`given.*` in `src/test/builders.ts` is the only sanctioned way to make a document.** It allocates ids in
  bands above both the fixtures and the sequence starts. `given.adjustment` writes the document only, never a
  ledger move. There is no `given.payer`: use `POST /payers`.
- **`sequences` survives truncation**, so never assert a literal allocated id. Match the shape and assert the
  relative step instead.
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
  inserts into `sequences` never appear in a diff. That is not drift, so don't "fix" it.
- **After writing a migration by hand**, run `db:generate` once to reconcile the snapshots in `meta/`. The
  emitted SQL must be empty, or only restate what you wrote. A second run must say "No schema changes".
- **`SEED_PASSWORD` is required** (at least 12 characters, no default). `DATABASE_SSL` defaults to on in
  production. Queries time out after 15 s; the CLIs pass `0`.
- **`db:seed` guards production.** Where `NODE_ENV=production`, it needs `--yes-seed <db name>`, and `--force`
  also needs `--yes-destroy <db name>`, each matching `current_database()`. The chart sets `NODE_ENV=production`
  in every pod, so an in-cluster seed always needs this form. The rules live in `lib/seed-guard.ts`.

## Shutdown

On SIGTERM, `/readyz` answers 503 at once. In production the server then waits 30 s, and after that
`app.close()` gets 25 s to drain. 30 + 25 fits inside the chart's `terminationGracePeriodSeconds: 60`. The ALB's
deregistration delay (30 s) must stay ≤ the pre-drain wait. If you change one of these numbers, change the
others with it.
