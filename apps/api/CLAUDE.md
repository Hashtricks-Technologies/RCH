# apps/api — CLAUDE.md

Repo-wide rules, branches and domain invariants are in the root `../../CLAUDE.md`; the design
contract is `docs/superpowers/specs/2026-09-03-backend-design.md` (§2 decisions, §16 amendments,
§14 build order). This file is what is specific to the server.

## What this is

`@rch/api`: Fastify 5 + Drizzle on PostgreSQL 17, ESM TypeScript, one pool per process. It owns
the ledger, the document numbers, the reservations and the change stream. Phases 1–3 are live —
auth, `/snapshot` and the master GETs, the counter sale, availability, prices and menus, the
whole request/ticket chain, shop transfers, shop asks, the kitchen's two ticket-raising writes,
and `GET /events`. Production batches/status and all of procurement are still in the browser
store until phases 4–5.

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
src/lib/*       the ledger, reservations, tickets, ids, history, rules, events, master, wire
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
- `given.{request,ticket,shopAsk,bill,prodOrder}` (`src/test/builders.ts`) are the only sanctioned
  way to make a document. Their id bands sit above both the fixtures and the sequence starts:
  `REQ-2026-0991+`, `TKT-0801+`, `ASK-0101+`, `CF/9001+`, `PRD-2026-901+`.
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
`TEST_DATABASE_URL`, `DATABASE_SSL`, `CORS_ORIGIN`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`,
`JWT_PREVIOUS_PUBLIC_KEY`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL_DAYS`, `COOKIE_SECURE`,
`SEED_PASSWORD`, `SEED_FORCE_PASSWORD_CHANGE`, `RATE_LIMIT_PER_MINUTE`,
`LOGIN_RATE_LIMIT_PER_MINUTE`, `LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE`, `SSE_HEARTBEAT_MS`,
`SSE_RETRY_MS`, `TRUST_PROXY`. (`PG_CA_BUNDLE` is read directly by `db/client.ts` for the RDS CA.)

`/metrics` publishes `http_request_duration_seconds`, `sse_clients`, `sse_listener_up`,
`sequence_allocations_total{kind}`, `pg_pool_total`, `pg_pool_idle`, `pg_pool_waiting`, plus
prom-client defaults. `/healthz` is liveness; `/readyz` runs every registered check.
