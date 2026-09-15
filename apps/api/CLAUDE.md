# apps/api - CLAUDE.md

Repo-wide rules and the domain invariants are in the root `CLAUDE.md`. This file covers what is specific to the
server.

## Commands

```bash
pnpm --filter @rch/api dev                  # tsx watch, reads ../../.env, :3000
pnpm --filter @rch/api test                 # vitest; Postgres on 5439 (pnpm db:up); floor lines 94 / branches 79
pnpm --filter @rch/api build                # tsup → dist/server.mjs
pnpm --filter @rch/api db:generate          # drizzle-kit generate + strip the "public". prefix; review + commit the SQL
pnpm --filter @rch/api db:migrate           # behind pg_advisory_lock(727272); creates rch_app when DATABASE_URL names another user
pnpm --filter @rch/api db:seed [--force] [--bare]
pnpm --filter @rch/api db:rebuild-balances  # recompute stock_balances from stock_moves
pnpm --filter @rch/api users <create|reset-password|deactivate|set-admin> --emp RC-1234 ...   # create: --emp optional, next number assigned
pnpm --filter @rch/api payers import --csv <file> [--replace-names]   # kind,id,name - one transaction
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
src/plugins/*     logging, errors, metrics, health, security, db, auth, rbac, sse, idempotency, audit
src/lib/*         ledger, reservations, tickets, ids, history, rules, events, claims, credit, master, audit, roles, …
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
`catalog.createItem` also takes a `pg_advisory_xact_lock` on the item's slug.

## Price lists

`modules/pricelists/` owns the entity itself - create (cloned from an outlet's current active list),
delete (only once unattached) and switching an outlet's active list. `modules/catalog` keeps `savePrice`,
which edits a list's own item→price rows and never depends on which outlet (if any) it is active for.

None of the three writes touch `stock_moves`, `stock_balances` or a document table, so the lock order above
does not apply: each is a single `withTransaction` taking only `price_lists` and `locations` rows.
`pricelistsRepo.head` locks the target `price_lists` row `FOR UPDATE`, and both `remove` and `activate` take
it before doing anything else - so a delete and a switch of the same list serialise rather than race. The FK
(`locations.price_list_id` `ON DELETE RESTRICT`, `price_list_items.list_id` `ON DELETE CASCADE`) is the
backstop for a future writer that doesn't take that lock, not the primary guard; `catalog.savePrice` is one
such writer today - it reads whether the list exists unlocked, so its own insert is wrapped in a catch for the
same violation.

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
  tables there: a new table that references `users` is covered by its own foreign key. Audit events are not
  history in this sense: `audit.events.actor_id` has no foreign key, so they never block a delete.
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
- **Payers.** `GET /roster` returns live payers for the till. No route writes the `payers` table; the
  `payers import` CLI is the only way onto it.

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
  employee number, name, printed role label (`roleLabelOf`: "Counter Operator", "Outlet Manager", "Store
  Keeper", "Kitchen In-charge", "Procurement Officer" or "Super Admin") and location (`""` for the super admin),
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
  client. It is stored as the audit event's `cause`, which only the super admin reads.
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
  ledger move. There is no `given.payer`: insert into `payers` directly.
- **`sequences` survives truncation**, so never assert a literal allocated id. Match the shape and assert the
  relative step instead.
- **`lib/roles.test.ts` creates role names suffixed with the process id** and drops them afterwards, so files
  running in parallel never share a role. Roles belong to the server, not to a test file's schema.
- **The audit tests read `audit_outbox` directly** to assert what a real route inserted:
  `modules/audit-capture.test.ts` (completeness, done events, atomicity, refusals, masking),
  `modules/audit-before.test.ts` (every `auditBefore` service) and `modules/auth/auth-audit.test.ts` (the
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
  inserts into `sequences` never appear in a diff. That is not drift, so don't "fix" it.
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
- **`db:seed` guards production.** Where `NODE_ENV=production`, it needs `--yes-seed <db name>`, and `--force`
  also needs `--yes-destroy <db name>`, each matching `current_database()`. The chart sets `NODE_ENV=production`
  in every pod, so an in-cluster seed always needs this form. The rules live in `lib/seed-guard.ts`.

## Shutdown

On SIGTERM, `/readyz` answers 503 at once. In production the server then waits 30 s, and after that
`app.close()` gets 25 s to drain. 30 + 25 fits inside the chart's `terminationGracePeriodSeconds: 60`. The ALB's
deregistration delay (30 s) must stay ≤ the pre-drain wait. If you change one of these numbers, change the
others with it.
