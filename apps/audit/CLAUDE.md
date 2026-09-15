# apps/audit - CLAUDE.md

Repo-wide rules are in the root `CLAUDE.md`. This file covers what is specific to the audit service.

## What this is

The service that keeps the audit log. The API writes one event per write and per sign-in into
`public.audit_outbox`, inside the write's own transaction for a success. This service drains the outbox into its
own append-only `audit` schema and answers the super admin's two read routes. Nothing it writes is read by the
API.

It imports `@rch/contract` and nothing else from the workspace. The root `.oxlintrc.json` refuses `apps/api`,
`@rch/api`, `@rch/domain` and `UI` here, and refuses this app from `apps/api`. Don't add an
`apps/audit/.oxlintrc.json`: oxlint uses the nearest config whole, so a nested one would switch those bans off.
What it shares with the API (request ids, the refusal envelope, helmet, `/healthz` and `/readyz`, prom-client)
is a slim copy, not an import.

## Commands

```bash
pnpm --filter @rch/audit dev          # PORT=3100 tsx watch, reads ../../.env
pnpm --filter @rch/audit test         # vitest; Postgres on 5439 (pnpm db:up); floor lines 90 / branches 75
pnpm --filter @rch/audit build        # tsup → dist/server.mjs, dist/cli/migrate.mjs
pnpm --filter @rch/audit db:generate  # drizzle-kit generate + strip the "public". prefix; review + commit the SQL
pnpm --filter @rch/audit db:migrate   # after the API's db:migrate; behind pg_advisory_lock(727273)
pnpm --filter @rch/audit exec vitest run src/modules/audit/audit.test.ts   # one file, no coverage gate
```

The `dev` script sets `PORT=3100` itself: the root `.env`'s `PORT=3000` is the API's, and Node's `--env-file`
never overrides a variable already set. The image sets `ENV PORT=3100`.

## Layout

```
src/app.ts               buildApp(config, opts): plugins in order, then the audit module
src/server.ts            listen on PORT (3100); SIGTERM drains
src/config.ts             loadConfig(env) - the only reader of process.env; ConfigError
src/routes.ts             mount(): registers service: "audit" routes and nothing else; mountedRoutes
src/plugins/*             logging, errors, security, metrics, health, db, auth, drainer
src/lib/drain.ts          drainOnce and outboxStats: one pass, outbox → audit.events / audit.dead_letters
src/lib/migrate-run.ts    migrateAudit and waitForOutbox: the migrate CLI's logic, where tests can reach it
src/lib/roles.ts          roleFromUrls, ensureLoginRole, grantAuditRole
src/lib/db.ts             Tx, Reader, withReadTransaction
src/lib/time.ts           istDay, istDayStart, nextIstDay
src/lib/errors.ts         AppError and its 400 / 401 / 403 / 404 / 503 subclasses
src/modules/audit/*       routes.ts, service.ts, repo.ts, audit.test.ts - the two read routes
src/db/*                  client.ts (createDb), migrate.ts, schema.ts (the Drizzle tables)
src/cli/migrate.ts        load the config, run migrateAudit, exit with its code
src/test/*                the per-file schema harness, the test config and token minting
drizzle/*.sql             migrations + meta/_journal.json
```

A module is the same four files as in `apps/api`, and `scripts/check-boundaries.sh` checks `src/modules/*/`
for them.

## The drainer

`plugins/drainer.ts` decorates `app.drainer` with `lastPassAt`, `lastPassOk`, `kick()`, `drainNow()`, `passes()`
and `listening()`.

- **What wakes it.** One dedicated `pg.Client` `LISTEN`s on `rch_audit_outbox`. The API notifies that channel
  after every insert with its outbox's schema name as the payload, and the drainer kicks a pass only for a
  payload equal to its `OUTBOX_SCHEMA`, or an empty one. A tick every `DRAIN_POLL_MS` (5 s) also runs a pass.
  The listener reconnects with the API's SSE backoff, so a lost connection only slows the log to the poll
  interval. Passes never overlap within a process. `drainNow()` runs a pass now (or waits out the one in flight
  and runs another) and resolves once passes stop.
- **A pass is one transaction** (`lib/drain.ts`'s `drainOnce`, which returns `{ moved, dead, issues }`):
  1. `delete from <outbox> where id in (select id from <outbox> order by id limit $batch for update skip locked) returning id, at, event`;
  2. each event is parsed with `AuditEventSchema`: a valid one is inserted into `audit.events` with its
     `outbox_id`, an invalid one into `audit.dead_letters` with its first issue;
  3. if any event moved, a notice naming the `audit` collection goes out on `rch_events_<EVENTS_SCHEMA>`, the
     channel the API's SSE listener already hears;
  4. commit. The plugin then logs each dead letter at `error`.

  A full batch (`DRAIN_BATCH`, 500) schedules the next pass at once.
- **A row Postgres refuses is set aside, never retried for ever.** The batch insert runs under a savepoint. If
  Postgres refuses it with a data exception or an integrity violation (SQLSTATE class 22 or 23: a `status` too
  big for `smallint`, an `outbox_id` already stored), the pass inserts row by row and sets each refused row
  aside in `dead_letters` as `database refused it: <reason>`. Any other error (a lost connection, a timeout)
  rolls the whole pass back, so nothing is lost.
- **Exactly once.** The outbox and `audit.events` share a database, so the delete and the insert commit
  together or not at all. `skip locked` keeps a drain from stalling on rows another replica holds, and
  `outbox_id unique` is the backstop. Don't split a pass into two transactions and don't drop `skip locked`.
- **`rch_audit`'s column grant `update (at)` on the outbox exists for one reason**: `for update skip locked`
  needs UPDATE privilege on some column. The API's migration puts a trigger on `audit_outbox` that refuses
  every UPDATE, so the grant lets the drainer lock rows and nothing more.
- **Only `lib/drain.ts` deletes from the outbox or inserts into `events` and `dead_letters`**, and nothing in
  `apps/audit/src` inserts into, updates or truncates the outbox. `scripts/check-boundaries.sh` checks it line
  by line, so write each `delete from` and `insert into` with its table name on the same line.

## Storage

- **Where it lives.** Migrations run in `AUDIT_SCHEMA` (`audit` in production). Their SQL is unqualified, like
  the API's: the migrate step creates the schema if it is missing and runs with `search_path = <AUDIT_SCHEMA>`,
  and the service's pool uses the same `search_path`. The outbox is always named through `OUTBOX_SCHEMA`, as a
  quoted identifier.
- **Bookkeeping is `<AUDIT_SCHEMA>_drizzle`** (`audit_drizzle`), not `drizzle`. The API's `/readyz` migration
  count never sees these migrations, and this service's `/readyz` compares the `audit_drizzle` count against
  `drizzle/meta/_journal.json`.
- **`events`** holds one row per stored event: `outbox_id` (unique), `at`, `request_id`, the actor as it stood
  (`actor_id`, `actor_emp`, `actor_name`, `actor_role`, `actor_loc`), `action`, `method`, `path`, `target`,
  `target_loc`, `outcome` (`done`, `refused` or `error`), `status`, `message`, `cause`, `request`, `before`,
  `result`, `changed`, `ip`, `user_agent` and `stored_at`. It is indexed on `(at desc, id desc)`,
  `(actor_id, id desc)`, `(target, id desc)`, `(action, id desc)` and `(outcome, id desc)`.
- **`dead_letters`** holds what was set aside: `outbox_id`, `at`, the raw `event`, the `issue` and `stored_at`.
- **Append-only, forever.** Statement-level triggers (`events_append_only`, `dead_letters_append_only`) refuse
  UPDATE, DELETE and TRUNCATE on both tables, for every role, even a statement that touches no row. There is no
  retention and no purge.
- **`actor_id` has no foreign key.** This schema references nothing of the API's, so deleting an account never
  trips on its events, and each row keeps the name and number the person had.
- **`action` is stored as a plain `string`**, the one deliberate open type: a route removed from the manifest
  still has history that must read.
- **A timestamp read through `db.execute` comes back as text**, so `repo.ts` formats `at` in SQL with
  `to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`. Do the same for any new timestamp read.
- **A new migration** comes from `db:generate` and is reviewed like the API's. The append-only triggers were
  appended to `0000_audit_events.sql` by hand, because drizzle-kit can't see triggers; a second `db:generate`
  must print "No schema changes".

## Roles

The service runs as `rch_audit`; its migrations run as `rch`.

- **`cli/migrate.ts`** runs `lib/migrate-run.ts`'s `migrateAudit`, connected with `MIGRATE_DATABASE_URL`
  (defaulting to `AUDIT_DATABASE_URL`). In order, it:
  1. waits up to five minutes, polling every 2 s (`OUTBOX_WAIT`), for `<OUTBOX_SCHEMA>.audit_outbox` to exist,
     so it may start before or after the API's migrate;
  2. takes `pg_advisory_lock(727273)` (`AUDIT_MIGRATE_LOCK`) for the rest of the step and runs the migrations;
  3. when `AUDIT_DATABASE_URL` names a different user, also takes the API's `727272` (`API_MIGRATE_LOCK`),
     then from that URL creates the role if it is missing, sets its password (escaped with `pg`'s
     `escapeLiteral`, never logged), and runs `grantAuditRole`. Both migrate steps grant on `audit_outbox`,
     and two concurrent GRANTs on one table can fail with `tuple concurrently updated`; the API's step never
     takes 727273, so the two can't deadlock.
- **Exit codes:** 0 migrated, 2 an invalid environment (`ConfigError`), 3 the outbox never appeared
  (`OutboxMissingError` - read the API's migrate log first), 1 anything else. Its environment is
  `MIGRATE_DATABASE_URL`, `AUDIT_DATABASE_URL`, `JWT_PUBLIC_KEY` (the config requires it even for the CLI),
  `AUDIT_SCHEMA`, `OUTBOX_SCHEMA` and `LOG_LEVEL`.
- **`grantAuditRole`** grants `usage` on `audit`, `audit_drizzle` and `public`; `select, insert` on
  `audit.events` and `audit.dead_letters`; `select` on the `audit_drizzle` bookkeeping; `select, delete` and
  the column `update (at)` on `audit_outbox`. No other API table. `revoke all on schema audit, audit_drizzle
  from public` keeps every other role out, `rch_app` included.
- **Same user, no role.** Locally and in the tests the migrate URL and `AUDIT_DATABASE_URL` name one user, and
  the step runs the migrations alone.

## Auth

- **Verify only.** `plugins/auth.ts` checks the API's access tokens: EdDSA, `allowedIss: "rch-api"`, against
  `JWT_PUBLIC_KEY` and, when set, `JWT_PREVIOUS_PUBLIC_KEY`. It holds no private key and mints nothing. A key
  rotation (`deploy/RUNBOOK.md` §4) restarts this service beside the API.
- **A missing or invalid token is a 401.** The UI's `call()` refreshes through the API and retries, as for any
  route.
- **A token without `admin: true` gets a 404 on every route**, the same answer the API's `rbac.ts` gives.
  `mount()` attaches both gates as `onRequest` hooks, ahead of schema validation, so a non-admin's malformed
  query is a 404 too and never confirms the route exists.

## Read routes

Both are manifest routes with `service: "audit"` and `access: "admin"`. `src/routes.ts`'s `mount()` throws on
any other route, and a test asserts `mountedRoutes` holds every `service: "audit"` route, keyed
`"<METHOD> <manifest path>"` (`"GET /admin/audit/:id"`).

- **`GET /admin/audit`** takes `from` and `to` (IST days, `YYYY-MM-DD`), `actor`, `role`, `loc`, `group`,
  `action`, `outcome`, `q`, `before` and `limit` (1-500, default 100). It runs in one read-only transaction and
  awaits its queries in sequence: the page first (`id < before`, `order by id desc`, `limit + 1` to derive
  `next`), then the counts over the whole filter (events, people counted by `coalesce(actor_id, actor_emp)`,
  anything not `done`, and refused sign-ins). A row carries `ip` and `requestId` besides who, what and when.
  - `to` defaults to today in IST and `from` to `to`. The server turns them into instants: `from`'s midnight,
    inclusive, to the midnight after `to`, exclusive. The tests prove it under `TZ=UTC`. A `from` after `to`, or
    a day the calendar doesn't have, is a 400 with its own sentence.
  - `loc` matches the actor's location or the target's.
  - `group` resolves to action names through `actionsInGroup`; with `action` as well, the two intersect.
  - `q` is a case-insensitive substring over `target`, `message`, `actor_name` and `actor_emp`. A `q` of only
    spaces is ignored.
  - Paging is keyset on `id`, never an offset.
- **`GET /admin/audit/:id`** returns the full entry, or a `NotFoundError` for an unknown id.
- **Errors use the API's envelope**, `{ error: { code, message } }`, so the UI handles both services alike.

## Health and metrics

- `/healthz` answers while the process runs.
- `/readyz` answers 503 unless every check registered with `app.readiness.addCheck(name, check)` passes. A check
  fails by returning `false` or throwing; the 503 names it. The db plugin registers `database` (the database
  answers and every audit migration is applied) and the drainer registers `drainer` (a pass succeeded in the
  last 30 s). On the box, Caddy serves it as `/readyz/audit`.
- `/metrics` exposes `audit_outbox_depth`, `audit_drain_lag_seconds` (the age of the oldest outbox row),
  `audit_events_stored_total`, `audit_dead_letters_total` and `audit_listener_up`, plus the pool gauges. The
  chart's `AuditDrainLagging` and `AuditDeadLetters` alerts read them (`deploy/RUNBOOK.md` §9).

## Config

`src/config.ts` is the only reader of `process.env`, and throws `ConfigError` on a bad value.

- `AUDIT_DATABASE_URL`: the service's own connection, the `rch_audit` URL in a deployment.
- `MIGRATE_DATABASE_URL`: read by the migrate CLI only; defaults to `AUDIT_DATABASE_URL`.
- `JWT_PUBLIC_KEY` (required) and `JWT_PREVIOUS_PUBLIC_KEY`: the same values the API holds. A blank previous key
  is none.
- `PORT` (3100), `NODE_ENV`, `LOG_LEVEL`, `DATABASE_SSL`, `DB_POOL_MAX` (5) and `TRUST_PROXY`.
- `AUDIT_SCHEMA` (`audit`), `OUTBOX_SCHEMA` (`public`) and `EVENTS_SCHEMA` (`public`, the schema whose
  `rch_events_<schema>` channel the API listens on). Each is a lowercase identifier, and `AUDIT_SCHEMA` differs
  from `public` and from the other two.
- `DRAIN_BATCH` (500) and `DRAIN_POLL_MS` (5000, at most 25000 so a quiet pod still passes inside the 30 s readiness window).

## Tests

- **`buildTestApp({ schema: "<name>", drainer?, env? })`** (`src/test/app.ts`) builds on `withAuditSchema(name)`
  (`src/test/db.ts`): an outbox schema `t_audit_<name>_<pid>`, carrying the API's refuse-UPDATE trigger, and an
  audit schema `<that>_a`, migrated, with the config pointed at both and a per-file events schema. They are
  dropped on `close()`. `name` is at most 30 characters.
- **`drainer: false`** builds an app with no listener, no timer and no pass. `app.drainer.drainNow()` runs a pass
  deterministically either way.
- **`putOutbox(testDb, events)`** inserts in array order and does not notify; `sampleEvent(over)` builds a valid
  `AuditEvent`. **`resetAudit(testDb)`** empties the outbox, `events` and `dead_letters` between cases; never
  TRUNCATE them, which the triggers refuse.
- **`signToken(app, claims, { previousKey })`** mints a token the way the API does. The harness always configures
  both keys, so `previousKey: true` always works. `testConfig(overrides)` and `testKeyPair()` build a config
  without a database.
- **Two drainers over one outbox** proves the locking clause exists; **the test that proves `skip locked`** holds
  rows in another transaction and requires a drain not to stall on them. Open the pool's connections first (at
  most 4), or the two passes run back to back and prove nothing.
- **A roles test creates role names unique to its process** and drops them afterwards. `lib/roles.test.ts`
  drains as the audit role and shows `update … set at` refused by the trigger.
- **Coverage excludes `src/server.ts` and `src/cli/**`**, the few lines of wiring over `app.ts` and
  `lib/migrate-run.ts`, which the tests call directly.
