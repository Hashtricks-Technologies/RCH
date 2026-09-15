# Audit log service - design

Date: 2026-09-14 (amended 2026-09-15) · Base: `origin/develop` 609befb · Branch: `feature/audit-log`

## Goal

The super admin gets a third tab, **Audit log**, that answers *who did what, when, where from, and with what
result* for every change anyone makes in the application and for every sign-in. The log is kept by a separate
deployable service, `apps/audit`, and no credential the API holds can alter it.

## Decisions (settled with the user)

| Question | Decision |
|---|---|
| What is an event | Every write, succeeded **or refused**, plus sign-in, failed sign-in, locked-out attempt, sign-out and password change. No reads. Automatic token refreshes are not events. |
| Detail per event | What was sent (secrets masked), the resulting document, the server's sentence, and for edits the **before** values, so the page shows before → after. |
| Capture | Centrally in the API (`mount()` / `withTransaction` for writes, `onResponse` for refusals, the auth module for sign-in events), not DB triggers or per-service calls. |
| Service | A separate deployable `apps/audit`: the API writes events to an outbox in the write's own transaction; the audit service drains them into its own `audit` schema and serves the read routes. |
| Database roles | Least privilege, shipped in the same release: the API runs as `rch_app`, the audit service as `rch_audit`, migrations as `rch`. |
| Delivery | One release: service, roles, UI, deploy wiring and docs together. |
| Retention | Forever. Append-only, enforced by a trigger. |
| Backfill | None. The live box was reset to bare on 2026-09-14; the log starts at the deploy. |

## What exists today, and why it is not enough

`document_history` (status transitions), `stock_moves.by_user`, `admin_actions` (admin account writes) and
`bills.voided_by` each answer part of the question. Master-data edits record no actor. Refusals and failed
sign-ins reach only the process log. `idempotency_keys` holds every write's response but is purged after 24 h.
The API connects to Postgres as the superuser `rch`, so no grant restricts it. All existing tables stay as they
are; the audit log is additive.

---

## 1. Contract (`packages/contract`)

- **`AuditEventSchema`** (Zod), the event the API emits and the audit service stores:

  ```ts
  {
    at: string;                         // ISO instant
    requestId: string;
    actor: { id: string | null; emp: string; name: string; role: string; loc: string };
    action: AuditAction;                // manifest write route name, or "login" | "logout" | "changePassword"
    method: string; path: string;       // "POST", "/bills/:no/void"
    target: string; targetLoc: string;
    outcome: "done" | "refused" | "error";
    status: number;
    message: string;
    cause: string | null;               // a refusal's internal cause
    request: unknown;                   // { params, query, body }, masked
    before: unknown | null;
    result: unknown | null;             // masked
    changed: Collection[];
    ip: string; userAgent: string;
  }
  ```

- **`AUDIT_GROUPS`**: `sales`, `stock`, `purchasing`, `production`, `master`, `accounts`, `support`, printed as
  Sales, Stock movement, Purchasing, Production, Master data, Accounts & sign-in, Support.
- **`AUDIT_LABELS: Record<AuditAction, { label: string; refused?: string; group: AuditGroup }>`**. The type is
  exhaustive over every manifest write route plus the three auth actions, so a new write route without a label
  fails typecheck. Labels are past tense ("Posted a bill", "Changed a price"); `refused` overrides the label for
  a refusal where the meaning changes (`login` → "Failed sign-in").
- **The manifest gains `service?: "api" | "audit"`** (default `api`). `apps/api`'s `mount()` refuses a route
  whose service is not `api`; `apps/audit` mounts only `audit` routes. Each app has a test asserting it mounts
  every route tagged for it.
- **Two routes, `service: "audit"`, `access: "admin"`:**
  - `GET /admin/audit`: query `from`, `to` (IST days `YYYY-MM-DD`, default today), `actor` (user id),
    `role` (label), `loc`, `group`, `action`, `outcome`, `q`, `before` (id cursor), `limit` (1–500, default
    100). Response `{ rows: AuditRow[]; next: number | null; counts: { events; people; refused; failedSignIns } }`.
    `AuditRow` is `id`, `at`, `actor`, `action`, `target`, `targetLoc`, `outcome`, `status`, `message`, `ip`,
    `requestId` (the last two feed the CSV). `loc` matches the actor's location or the target's location.
  - `GET /admin/audit/:id`: one `AuditEntry` = `AuditRow` + `method`, `path`, `cause`, `request`, `before`,
    `result`, `changed`, `userAgent`.
- **`Changed` / `CollectionSchema` gains `audit`.** It never appears in a write response's `changed`.

## 2. API side (`apps/api`): capture into the outbox

### 2.1 Outbox table

A new API migration (next free journal number at implementation time; `0016_audit_outbox` after develop's
`0015_drop_recipes`):

```sql
create table audit_outbox (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  event jsonb not null
);
```

A trigger on `audit_outbox` refuses every `UPDATE` ("audit_outbox is insert-only"). The drainer needs a column
`update (at)` grant only so that `for update skip locked` can lock rows (§4); the trigger means no role can
change one.

The API inserts only. `audit_outbox` joins the protected tables in `scripts/check-boundaries.sh`: only
`apps/api/src/lib/audit.ts` may insert into it, and nothing in `apps/api` may read, update or delete it (test
files excepted).

Each insert is followed by `pg_notify('rch_audit_outbox', <outbox schema name>)` in the same transaction or
connection, to wake the drainer; a drainer kicks a pass only for its own schema's notices (or an empty payload).

### 2.2 Writes that succeed

`mount()` puts the route (name, method, path) and the request's audit context (params, query, body, claims, ip,
user agent, request id) into the existing `idemStore` context.

In `withTransaction`, straight after `recordIdempotent` returns `ok: true`, the same transaction calls
`recordAudit(tx, ctx, value)`, which:

1. reads the actor's `users` row by `claims.sub` (one PK read) for emp, name, role label (`roleLabelOf`) and
   location;
2. builds the event with `outcome: "done"`, `status: 200`, the response's `message` and `changed`, the masked
   `result` and `request`, `before` from the context, and `target` / `targetLoc` from
   `targetOf(route, params, body, result)`;
3. inserts it into `audit_outbox` and notifies.

The event commits with the write or not at all. The insert is not wrapped in a try/catch: a write that cannot
be audited does not commit, the same stance as the idempotency record. A write that opens several transactions
gets exactly one event, from the transaction that recorded the idempotency outcome. The request is marked
`req.audited = true` once that transaction commits.

**`targetOf`**: `params.id` ?? `params.no` ?? `params.it` ?? `result.id` ?? `result.no` ?? `result.key` ?? `""`,
with composite targets where one field is ambiguous: `savePrice` → `list:it`, menu routes → `loc:it`, PO lines →
`id#n`. `targetLoc`: `params.loc` ?? `body.loc` ?? `body.from` ?? `result.loc` ?? `result.from` ?? `""` (requests,
tickets and transfers carry `from`, not `loc`).

Every event sets `request`, `before` and `result` (null when absent), because a missing key does not survive
jsonb and the drainer would dead-letter the event. A response without a `result` key (`patchMe`) is stored whole
as `result`.

### 2.3 Refusals, errors and the production fallback

`plugins/audit.ts` adds an `onResponse` hook for every route `mount()` flagged as a non-public write. When
`req.audited` is not set, it inserts one event on the pool:

| Reply | Event |
|---|---|
| status < 400 (production's `onSend` fallback: the response was not recorded inside a transaction) | `done`, `message` and `changed` read from the sent payload |
| 400–499, except 401 | `refused`, `message` and `cause` from `req.refusal` |
| ≥ 500 | `error`, the 5xx sentence (which carries the request id) |

Not recorded: a **401** (an expired token; the client refreshes and retries, and the retry is the event) and a
reply carrying `idempotency-replayed: true` (the original is already logged). A refusal is recorded only when a
valid token identified the caller: a request that fails validation before the auth preHandler ran has its token
checked quietly so a signed-in caller is still named, and a refusal nobody can be named for is not recorded - it
would let an unauthenticated client write rows, and failed sign-ins are recorded by the auth module (§2.6).
Tests that read a refusal's event wait for `app.auditSettled()`, because the hook runs after the reply.

A failed insert here is logged at `error` with the request id and does not change the reply. This covers
role-gate 404s, wrong-location 403s, validation 400s, idempotency 409s, rule 422s, 429s, and
`tickets.handover`'s wrong OTP (its `response: "optional"` transaction commits the attempt counter without a
recorded response, so no `done` event is written and the refusal follows).

### 2.4 Before values

`lib/audit.ts` exports `auditBefore(value: Record<string, unknown>)`, which stores the value on the current
`idemStore` context (last call wins). A service calls it right after reading the row it is about to change (after
its lock, where the service locks) and before changing it, passing the wire-shaped fields the edit can alter.

**Rule: every write that updates or removes an existing master row or account calls `auditBefore`.** On develop
609befb that is `savePrice`, `patchItem`, `addMenuItem` / `removeMenuItem` (the listing), `toggleAvail`,
`updateVendor`, `updateContract`, `removeContract`, `patchMe`, `patchPo`, `updatePoLine`, `removePoLine`,
`updateAdminUser`, `deactivateAdminUser`, `reactivateAdminUser`, `resetAdminUserPassword` and `deleteAdminUser`
(payer writes and recipes no longer exist). The list follows the code at implementation time: a route removed
in the meantime is dropped, and any route that edits an existing row is added.

Document state changes (approve, dispatch, handover, void, …) do not call it; the result's trail carries their
before.

### 2.5 Masking

`maskSecrets(value)` walks any JSON value and replaces the value of every key whose name is exactly one of
`SECRET_KEYS` - `password`, `newPassword`, `currentPassword`, `tempPassword`, `otp`, `token`, `accessToken`,
`refreshToken`, `secret` - with `"••••"`. Exact names, not a pattern: a pattern would also hide
`mustChangePassword`, which a before → after row legitimately shows. Applied to `request`, `result` and `before`
before the insert. The change-password body (`{ current, next }`) is recorded as `request: {}`. A handover's OTP is
never stored; its outcome is.

### 2.6 Sign-in events

The auth routes are `access: "public"` or `write: false`, so `modules/auth` records them explicitly with
`recordAuthEvent(db, req, { action, outcome, status, message, cause, actor })`:

| Event | `action` | `outcome` | Actor |
|---|---|---|---|
| Correct sign-in | `login` | `done` | the account |
| Wrong password, inactive account | `login` | `refused`, with `cause` | the account |
| Unknown employee id | `login` | `refused`, with `cause` | `id` null, `emp` = the typed id when it matches `/^RC-\d+$/i`, else `""` (a mistyped password in the id box must not be stored), `name` `""` |
| Locked out (per-employee budget or per-IP 429) | `login` | `refused` | as above |
| Sign-out | `logout` | `done` | the session's account |
| Password change | `changePassword` | `done` / `refused` | the account |

`refresh` and `GET /auth/directory` are not recorded. No password is ever passed in.

### 2.7 Change stream

`plugins/sse.ts` records on each stream whether its token is an admin's. `publish` sends an `audit` notice only
to admin streams; every other collection goes to every stream as today. `ChangeNoticeSchema` accepts `audit`
because `CollectionSchema` does.

## 3. The audit service (`apps/audit`, `@rch/audit`)

### 3.1 Shape

- Fastify 5, port **3100**, depends only on `@rch/contract`. oxlint forbids `apps/api` ↔ `apps/audit` imports
  in both directions, and both from `UI`.
- `src/app.ts`, `src/server.ts`, `src/config.ts`, `src/routes.ts` (its own `mount()` for `audit` routes),
  `src/plugins/{logging,errors,security,health,metrics,db,auth,drainer}.ts`, `src/modules/audit/{routes,service,repo,audit.test}.ts`,
  `src/db/{client,migrate,schema}.ts`, `src/cli/migrate.ts`, `drizzle/`. Logging, errors, security and health
  are slim copies of the API's (request id, refusal envelope, helmet, `/healthz`, `/readyz`), not imports.
- **Auth verifies only**: EdDSA, `allowedIss: "rch-api"`, `JWT_PUBLIC_KEY` plus optional
  `JWT_PREVIOUS_PUBLIC_KEY`. A token without `admin: true` gets a 404 on every route, the same answer
  `rbac.ts` gives.
- **Config** (`src/config.ts`, the only reader of `process.env`): `NODE_ENV`, `PORT` (3100), `LOG_LEVEL`,
  `AUDIT_DATABASE_URL`, `MIGRATE_DATABASE_URL` (migrate CLI only; defaults to `AUDIT_DATABASE_URL`),
  `DATABASE_SSL`, `DB_POOL_MAX`, `JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY`, `TRUST_PROXY`, `AUDIT_SCHEMA`
  (default `audit`), `EVENTS_SCHEMA` (default `public`; the schema whose `rch_events_<schema>` channel the API
  listens on), `OUTBOX_SCHEMA` (default `public`), `DRAIN_BATCH` (500), `DRAIN_POLL_MS` (5000). The test
  harness sets all three schemas per file.
- **Build**: tsup → `dist/server.mjs`, `dist/cli/migrate.mjs`. Dockerfile mirrors `apps/api/Dockerfile`
  (filtered frozen install `--filter @rch/audit...`, `pnpm deploy --prod`, distroless nodejs24 nonroot, copies
  `drizzle/`).

### 3.2 Storage

Migrations in `apps/audit/drizzle`, bookkeeping in schema **`<AUDIT_SCHEMA>_drizzle`** (`audit_drizzle` in
production, so the API's `/readyz` migration count is untouched), advisory lock **727273** for its own
migrations; its role and grant step also holds the API's **727272**, because both migrate steps grant on
`audit_outbox` and must not interleave. The migration SQL is unqualified, like the API's: the migrate CLI creates `AUDIT_SCHEMA` if missing and
runs with `search_path = <AUDIT_SCHEMA>`, and the service's pool uses the same `search_path`. The outbox is
always named through `OUTBOX_SCHEMA` as a quoted identifier. Below, `audit.` stands for `AUDIT_SCHEMA`.

```sql
create table events (
  id bigint generated always as identity primary key,
  outbox_id bigint not null unique,          -- the outbox row it came from
  at timestamptz not null, request_id text not null,
  actor_id text, actor_emp text not null, actor_name text not null, actor_role text not null, actor_loc text not null,
  action text not null, method text not null, path text not null,
  target text not null default '', target_loc text not null default '',
  outcome text not null check (outcome in ('done','refused','error')),
  status smallint not null, message text not null default '', cause text,
  request jsonb not null default '{}', before jsonb, result jsonb,
  changed text[] not null default '{}', ip text not null default '', user_agent text not null default '',
  stored_at timestamptz not null default now()
);
create table dead_letters (
  id bigint generated always as identity primary key,
  outbox_id bigint not null, at timestamptz not null, event jsonb not null, issue text not null,
  stored_at timestamptz not null default now()
);
```

Indexes on `audit.events`: `(at desc, id desc)`, `(actor_id, id desc)`, `(target, id desc)`, `(action, id desc)`,
`(outcome, id desc)`. A trigger on both tables refuses `UPDATE`, `DELETE` and `TRUNCATE`. `actor_id` has no
foreign key: the audit schema does not reference the API's tables, and account deletion is unaffected.

### 3.3 Drainer (`plugins/drainer.ts` schedules, `lib/drain.ts` moves)

- One dedicated `pg.Client` `LISTEN`s on `rch_audit_outbox`, reconnecting with the API's SSE backoff; a
  notification whose payload is this service's `OUTBOX_SCHEMA` (or empty), or a `DRAIN_POLL_MS` tick, triggers a
  pass. Passes never overlap within a process.
- An event that passes `AuditEventSchema` but that Postgres still refuses (a value out of a column's range) makes
  the pass retry row by row and set that row aside in `dead_letters`, so one bad row can never stall the queue.
- **A pass** (`drainOnce`) is one transaction on the pool:
  1. `delete from <outbox> where id in (select id from <outbox> order by id limit $batch for update skip locked) returning id, at, event`
  2. each event is parsed with `AuditEventSchema`; a valid one is inserted into `audit.events` with its
     `outbox_id`; an invalid one into `audit.dead_letters` with the first issue, logged at `error`;
  3. if anything was stored, `pg_notify('rch_events_' || $EVENTS_SCHEMA, '{"collections":["audit"],"at":…}')`;
  4. commit. A full batch schedules another pass at once.
- The outbox and `audit.events` share a database, so the move is exactly-once; `skip locked` lets replicas
  drain side by side; `outbox_id unique` is the backstop.
- **Health**: `lastPassAt` and `lastPassOk`. `/readyz` answers 503 unless the database answers, the audit
  migrations are all applied (`audit_drizzle` count against the journal), and a pass succeeded within 30 s.
- **Metrics** (`/metrics`, same prom-client setup as the API): `audit_outbox_depth`,
  `audit_drain_lag_seconds` (age of the oldest outbox row), `audit_events_stored_total`,
  `audit_dead_letters_total`, `audit_listener_up`.

### 3.4 Read routes (`modules/audit`)

- `GET /admin/audit` runs in one read-only transaction, queries awaited in sequence: the page (`id < before`,
  ordered `id desc`, `limit + 1` to derive `next`), then counts over the whole filter (`count(*)`,
  `count(distinct coalesce(actor_id, actor_emp))`, `count(*) filter (where outcome <> 'done')`,
  `count(*) filter (where action = 'login' and outcome = 'refused')`). IST day bounds are converted to instants
  server-side. `group` resolves to action names through `AUDIT_LABELS`. `q` is a case-insensitive substring over
  `target`, `message`, `actor_name`, `actor_emp`.
- `GET /admin/audit/:id` → the full entry, `NotFoundError` for an unknown id.
- Errors use the same envelope `{ error: { code, message } }`, so the UI's `call()` handles both services alike.

## 4. Database roles

| Role | Created by | Privileges |
|---|---|---|
| `rch` (superuser, existing) | Postgres image | Runs both migrate steps and the operator CLIs. No long-running service uses it. |
| `rch_app` (API) | API migrate | `usage` on `public`; `select, insert, update, delete` on all API tables and `usage, select` on their sequences (re-granted every run, plus `alter default privileges for role rch in schema public`); `select` on `drizzle.__drizzle_migrations`; on `audit_outbox` **`insert` only** (and `usage` on its identity sequence). No `truncate`. No privilege on schemas `audit` or `audit_drizzle`. |
| `rch_audit` (audit service) | audit migrate | `usage` on `audit`, `audit_drizzle` and `public`; `select, insert` on `audit.events` and `audit.dead_letters`; `select` on `audit_drizzle` bookkeeping; `select, delete, update (at)` on `public.audit_outbox` (`update (at)` only because `for update skip locked` requires it; the outbox trigger refuses every UPDATE). No privilege on any other API table. |

Also: `revoke all on schema audit, audit_drizzle from public`. Append-only triggers still refuse update and
delete on `stock_moves`, `document_history` and `audit.*` for every role.

**Role name and password are read from the runtime URL.** The API's migrate CLI connects with
`MIGRATE_DATABASE_URL` and takes the role name and password from `DATABASE_URL`; the audit migrate CLI takes them
from `AUDIT_DATABASE_URL`. Each runs `create role … login` when missing, then `alter role … password` (the
literal escaped with `pg`'s `escapeLiteral`, never logged), then its grants. **When the runtime user equals the
migrate user** (local dev, the test suites), role setup is skipped and the migrations alone run. The audit
migrate CLI waits (up to 5 min, polling every 2 s) for `audit_outbox` to exist, so the two migrate steps may
start in either order on Kubernetes.

## 5. UI

### 5.1 Store: `store/audit.ts`

State `audit: { rows, next, counts, filter, fresh }`, where `fresh` counts `audit` notices received since the
last load. Actions:

- `loadAudit(filter)`: replaces rows; returns `null` on failure (the screen shows an outage line, never
  "no events").
- `loadMoreAudit()`: appends the next page with `before: next`.
- `readAuditEntry(id)`: the full entry, `null` on failure; not kept in the store.
- `exportAudit(filter)`: pages at `limit: 500` until `next` is null or 50,000 rows; returns CSV text and whether
  the cap was hit.

`refetch.ts`'s `NARROW` gets an `audit` reader: an admin session increments `fresh`; any other session does
nothing.

### 5.2 Screen: `pages/AdminAudit.tsx`

`AdminDashboard`'s `Tab` becomes `"accounts" | "support" | "audit"`.

- **Filter bar** (`Toolbar`): period (Today / 7 days / 30 days / Custom from–to), Person (from `adminUsers`; a
  deleted person is reached through search or a row's "Everything by this person"), Role, Location, Area
  (`AUDIT_GROUPS`), Outcome (All / Done / Refused), search, **Export CSV**.
- **Counts** (`Kpis`): events · people · refused · failed sign-ins, over the whole filter.
- **Pill**: "New events - show" when `fresh > 0` (no number: one notice can carry several events); pressing it
  reloads. The list never moves by itself.
- **Table** (`DataTable`): When (IST date and `HH:MM:SS`, newest first), Who (emp · name · role, location
  beneath), What (label, target beneath), Outcome (`Pill`: Done / Refused / Error), Sentence. "Load more" while
  `next` is set.
- **Row → drawer** (`DrawerFrame`, registered as `auditEntry`):
  - Who: emp, name, role and location as they stood.
  - When: IST date and time to the second.
  - Where from: IP, device (`deviceOf(userAgent)`, e.g. "Chrome on Windows", a small parser in `lib/`, no
    dependency), request id.
  - What: label, `METHOD path`, the sentence, the cause of a refusal.
  - **Before → after**: when `before` is set, one row per field whose value differs from the same field of
    `result`, formatted with the existing formatters where the field is known (money, quantity).
  - Sent: `request` as key/value rows. Result: `result` as key/value rows (nested lines as a small table).
  - Links: "Everything by this person" (sets `actor`), "Everything on <target>" (sets `q`).
- **CSV**: `at (IST), emp, name, role, location, area, action, target, outcome, status, message, ip, request id`,
  downloaded as `audit-<from>-<to>.csv`; a toast when the 50,000 cap was hit.

PageHead description (one line): "Every change and sign-in, with who made it and when."

### 5.3 Dev

Vite's proxy sends `/api/v1/admin/audit` to `http://localhost:3100`, listed before `/api`. `pnpm dev` starts
the API, the audit service and the UI.

## 6. Deployment

### 6.1 Live box (`deploy/compose`)

| Service | Image | Connects as | Depends on |
|---|---|---|---|
| `postgres` | postgres:17 | - | - |
| `migrate` | rch-api:local | `rch` (`MIGRATE_DATABASE_URL`) + reads `rch_app` from `DATABASE_URL` | postgres healthy |
| `audit-migrate` | rch-audit:local, `dist/cli/migrate.mjs` | `rch` + reads `rch_audit` from `AUDIT_DATABASE_URL` | migrate completed |
| `api` | rch-api:local | `rch_app` | migrate completed |
| `audit` | rch-audit:local | `rch_audit` | audit-migrate completed |
| `ui` | rch-ui:local | - | api |
| `caddy` | caddy:2.10-alpine | - | ui, api, audit |

- `.env` gains **`APP_DB_PASSWORD`** and **`AUDIT_DB_PASSWORD`** (required, `:?`); `.env.example` and
  `compose.test.sh` gain them too.
- **Operator CLIs run through `migrate`** (`compose run --rm --no-deps migrate dist/cli/<x>.mjs`), which
  connects as `rch`: `deploy.sh`'s bare seed, `backup.sh`'s purge, and every RUNBOOK command that used `api`.
- **Caddyfile**:
  - `handle /api/v1/admin/audit*` → `reverse_proxy audit:3100`, ahead of `handle /api/*`.
  - `handle /readyz` → `reverse_proxy api:3000`.
  - `handle /readyz/audit` → `rewrite * /readyz` then `reverse_proxy audit:3100`.

  This fixes an existing defect: `/readyz` was answered by the UI's nginx with a static `ok`, so `release.sh`
  and `deploy-box.yml` never checked the database or migrations.
- **`release.sh`** polls both `/readyz` and `/readyz/audit`; on failure it prints logs for `migrate`,
  `audit-migrate`, `api` and `audit`. **`deploy-box.yml`**'s post-deploy check curls both.
- **Backup / restore**: `pg_dump` already includes `audit` and `audit_drizzle`. Roles are not dumped, so a
  restore is: load the dump as `rch`, then `compose run --rm migrate` and `compose run --rm audit-migrate`,
  which recreate `rch_app` / `rch_audit` and re-grant.

### 6.2 Helm chart (`deploy/chart/rch`; EKS is dormant, CI's kind install is not)

- `values.yaml`: `image.audit: rch-audit`; `audit: { replicas: 2, resources, env: { EVENTS_SCHEMA, OUTBOX_SCHEMA, LOG_LEVEL, TRUST_PROXY } }`;
  `secrets.values` gains `MIGRATE_DATABASE_URL` and `AUDIT_DATABASE_URL`; `DATABASE_URL` becomes the `rch_app`
  URL.
- `rch.envList` is split per component, so the API, its migrate initContainer, the audit container and its
  migrate initContainer each name exactly the secrets they use (the audit containers never see
  `JWT_PRIVATE_KEY` or `SEED_PASSWORD`).
- New templates: `audit-deployment.yaml` (initContainer `audit-migrate`; probes `/readyz`, `/healthz`, startup;
  same security context as the API), `audit-service.yaml`, `audit-pdb.yaml`; `networkpolicy.yaml` gains an audit
  policy (ingress from the ingress controller and the UI on 3100; egress to Postgres and DNS).
- `ingress.yaml`: `/api/v1/admin/audit` Prefix → `<release>-audit:3100`, listed before `/api`.
- UI: `default.conf.template` gains `location /api/v1/admin/audit` → `$audit_upstream`; `UI/Dockerfile` sets a
  default `AUDIT_UPSTREAM=http://rch-audit:3100`; `ui-deployment.yaml` sets the FQDN.
- `servicemonitor.yaml` gains the audit component; `prometheusrule.yaml` gains `AuditDrainLagging`
  (`audit_drain_lag_seconds > 60` for 5 m) and `AuditDeadLetters` (`increase(audit_dead_letters_total[15m]) > 0`).
- `tests/render.test.sh`: the exact counts it asserts (NetworkPolicy, PodDisruptionBudget,
  `automountServiceAccountToken: false`, `rch.io/tier`, the migrate/api secret-ref ranges, `API_UPSTREAM`) are
  updated, and new assertions cover the audit deployment, its initContainer, its secrets and the ingress order.

### 6.3 CI and workflows

- `ci.yml` `images`: build `rch-audit:ci` from `apps/audit/Dockerfile`, Trivy at `CRITICAL,HIGH`,
  `kind load docker-image rch-api:ci rch-ui:ci rch-audit:ci`.
- `ci/values-ci.yaml` and `ci/postgres.yaml`: `MIGRATE_DATABASE_URL` as `rch`, `DATABASE_URL` as `rch_app`,
  `AUDIT_DATABASE_URL` as `rch_audit`.
- `ci/install-test.sh`:
  1. wait for `deploy/rch-audit`;
  2. port-forward it and require `/readyz`;
  3. sign in as `RC-0001` through the API;
  4. read `GET /api/v1/admin/audit` through the audit service with that token;
  5. require the sign-in just made to be there, which proves outbox → drainer → read on a real cluster;
  6. repeat the audit `/readyz` after `helm upgrade`.

  Failure diagnostics include `rch-audit` `audit-migrate` and `audit`.
- `deploy.yml`: `rch-audit` in the ECR loop, build, both Trivy re-scans, secret preflight
  (`MIGRATE_DATABASE_URL`, `AUDIT_DATABASE_URL`), `--set-string` list, failure logs, rollout status.
- `deploy/cfn/rch-env.yaml` and `cfn/dev.import.json`: the `rch-audit` ECR repository, the deploy role's ECR ARN,
  outputs.
- `.trivyignore.yaml` prose updated from "both images" to all three.

### 6.4 Repo gates

- `turbo.json`: `test` env gains `AUDIT_DATABASE_URL` and `MIGRATE_DATABASE_URL`.
- `knip.json`: workspace `apps/audit` with `entry: ["src/cli/*.ts"]`.
- `.oxlintrc.json`: `apps/api/**` forbids `**/apps/audit/**` and `@rch/audit`; `apps/audit/**` forbids
  `**/apps/api/**`, `@rch/api`, `**/UI/**`, `@rch/ui`, `@rch/domain`.
- `scripts/check-boundaries.sh`:
  - in `apps/api/src`, only `lib/audit.ts` inserts into `audit_outbox`, and nothing selects, updates or deletes
    from it;
  - in `apps/audit/src`, only `lib/drain.ts` deletes from `audit_outbox` or inserts into `audit.*` (test files
    exempt in both apps);
  - nothing anywhere updates `audit.*`;
  - `apps/audit/src/modules/*/` must have the four-file skeleton.
- Coverage floor for `apps/audit`: set in its `vitest.config.ts` at the lines/branches figures first measured
  (target ≥ 90 / 75), raised later, never lowered. The API and UI floors are not lowered.

## 7. Testing

**`apps/api`**

- **Completeness**: `mount()` records each non-public write it wraps into an exported set; a test asserts that
  set equals every `service: "api"` manifest write route, and that `AUDIT_LABELS` has each.
- **Done events**: a sale, a price edit, an approval and an admin account create each leave exactly one outbox
  row whose event parses with `AuditEventSchema` and carries actor, target, target location, message, changed,
  result.
- **Atomicity**: a write whose transaction throws after its changes leaves no outbox row; a multi-transaction
  write leaves exactly one.
- **Refusals**: a 422, a wrong-location 403, a role-gate 404, a validation 400 and a wrong handover OTP each
  leave one `refused` event; a 401 and an idempotent replay leave none.
- **Sign-in**: each row of §2.6.
- **Masking**: after login, change-password, create-account (temp password) and handover, no outbox row
  contains the password, temp password, OTP or token.
- **Before**: every `auditBefore` service stores its pre-edit values.
- **SSE**: an admin stream receives an `audit` notice; a counter's stream does not.
- **Roles** (`lib/roles.test.ts`, per-pid role names, dropped after): after the grant step, the app role can
  insert into `audit_outbox` but not select, update or delete it; cannot read `audit.events`; can run a normal
  write. Skipped-role path: runtime user = migrate user runs migrations only.
- Account deletion still works for an account with audit events.

**`apps/audit`** (own `buildTestApp({ schema })` harness, each file its own `t_<name>_<pid>` outbox schema and
audit schema pair)

- **Drain**: inserted outbox rows are moved exactly once, in order; the outbox ends empty; `outbox_id` unique
  holds; an invalid event lands in `dead_letters` and the valid ones around it still move; a notice reaches
  `rch_events_<EVENTS_SCHEMA>`.
- **Concurrency**: two drainers over one outbox (`warmPool`, ≤ 4 connections) store each event once; shown to
  fail with `skip locked` removed.
- **Wake-up**: a `pg_notify('rch_audit_outbox')` triggers a pass before the poll interval.
- **Append-only**: update, delete and truncate on `audit.events` and `dead_letters` are refused.
- **Reads**: each filter, `group`, `q`, keyset paging without overlap, counts over the whole filter, IST day
  bounds under `TZ=UTC`, 404 for a non-admin token, a missing token → 401, unknown id → 404, a token signed by
  the previous key accepted.
- **Health**: `/readyz` 503 before migrations and when the last pass is stale; 200 otherwise.
- **Roles**: the audit role can select/delete the outbox and insert/select `audit.events`, and cannot read
  `users` or any other API table.
- **Manifest**: every `service: "audit"` route is mounted.

**`UI`** (`__tests__/admin-audit.test.tsx`, `bare.test.tsx`, `screens.test.tsx` `OPEN_OVER`)

- The tab renders rows and counts from a stubbed `GET /admin/audit`.
- Filters reach the query string; "Load more" sends `before`.
- An `audit` notice shows the pill without changing the rows; pressing it reloads.
- The drawer shows only changed fields in before → after.
- A failed read shows the outage line; an empty log shows the empty state.
- `deviceOf` and the CSV builder have unit tests.

**Deploy files**: `pnpm helm:test`, `pnpm compose:test`, `shellcheck`, `actionlint`, and the kind install
of §6.3.

## 8. Docs (same commit as the code)

- New `apps/audit/CLAUDE.md`: commands, layout, drainer, storage, roles, tests.
- Root `CLAUDE.md`: package table, dependency rule (api ↮ audit), coverage floors, the admin page's three tabs,
  protected tables, "every write and sign-in is audited", the roles.
- `apps/api/CLAUDE.md`: capture points, `auditBefore` rule, masking, outbox, runtime role and operator CLIs.
- `UI/CLAUDE.md`, `packages/contract/CLAUDE.md` (`service` on routes, `AUDIT_LABELS`, `AuditEventSchema`).
- `README.md`, `UI/README.md`, `deploy/compose/README.md`.
- `deploy/RUNBOOK.md`: §1 local dev, §2 CI (three images, kind audit check), §4 JWT rotation (audit reads the
  public keys), §6 restore drill (roles after load), §9 alerts, §10 server-sent events (`audit` to admin
  streams only), §11 checklist, §15 secrets, §16.1 what runs, §16.3 deploys, §16.5 restore, §16.6 continuous
  deploy.

## 9. Rollout

1. Build in the worktree `feature/audit-log` off `origin/develop`, isolated from the parallel sessions' work in
   the shared tree. Rebase on `origin/develop` before shipping; renumber the API migration if needed.
2. Every CI gate passes: typecheck, tests with floors, zero-warning lint, knip, boundaries, `pnpm audit`, UI
   build, three images scanned, kind install with the audit check, deploy files.
3. **Before the push** (with the user's go-ahead): add `APP_DB_PASSWORD` and `AUDIT_DB_PASSWORD` (generated) to
   `/opt/rch/app/deploy/compose/.env` on the box over SSM, and check memory headroom (`free -m`) for a fourth
   Node container. Without the passwords, Compose stops at interpolation after the fast-forward.
4. Push to `develop` (with the user's go-ahead). CI green → `deploy-box.yml` → `release.sh`: backup,
   fast-forward, `migrate` (outbox + `rch_app`), `audit-migrate` (`audit` schema + `rch_audit`), `api` restarts
   as `rch_app`, `audit` starts, both `/readyz` must pass.
5. Rollback: revert the commit on `develop`; it redeploys the previous shape. The roles and the empty `audit`
   schema left behind are harmless.

## Out of scope

Logging reads or page views; backfilling from `document_history`, `stock_moves` or `admin_actions`; retention
or purging; alerting on suspicious activity; changing `admin_actions` or the Accounts tab's recent-actions list;
moving the API's tables to a different owner.
