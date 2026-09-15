# Audit Log Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the super admin an Audit log tab that answers who did what, when, where from and with what result for every write and sign-in, kept by a separate `apps/audit` service under least-privilege database roles.

**Architecture:** The API captures every audited action centrally (`mount()` / `withTransaction` / an `onResponse` hook / the auth module) and inserts a self-contained `AuditEvent` into `public.audit_outbox`, inside the write's own transaction for successes. A new Fastify service, `apps/audit`, drains the outbox exactly-once into its own append-only `audit` schema and serves `GET /admin/audit` and `GET /admin/audit/:id`. Runtime roles are `rch_app` (API, INSERT-only on the outbox) and `rch_audit` (audit service); migrations and operator CLIs run as `rch`.

**Tech Stack:** Node 24, pnpm 10.28.2 + Turborepo, TypeScript 6 strict, Zod 4, Fastify 5, fastify-type-provider-zod 7, Drizzle 0.45 on PostgreSQL 17, pg 8, prom-client 15, fast-jwt 6, Vitest 4, React 19 + Zustand 5 + Vite 8, Docker Compose + Caddy, Helm, GitHub Actions, kind.

**Spec:** `docs/superpowers/specs/2026-09-14-audit-log-design.md` - read it before any task; this plan implements it section by section.

## Global Constraints

- Work only in the worktree `/Users/srimanikandanr/.superset/worktrees/RCH-audit-log` on branch `feature/audit-log`. Never touch the shared checkout `/Users/srimanikandanr/.superset/projects/RCH` (other sessions have uncommitted work there). Use absolute paths; never `cd` in a compound command.
- Dependencies flow contract → domain → api / audit / UI. `apps/api` and `apps/audit` never import each other; `apps/audit` imports only `@rch/contract`.
- Every CI gate must pass: `pnpm turbo typecheck test`, `pnpm lint` (oxlint `--max-warnings 0` per package + knip + `scripts/check-boundaries.sh`), `pnpm audit`, UI build, image builds + Trivy `CRITICAL,HIGH`, kind `helm install`, `pnpm helm:test`, `pnpm compose:test`, `shellcheck deploy/compose/*.sh`, actionlint.
- Coverage floors are never lowered: UI lines 73 / branches 51, `apps/api` 94 / 79, `packages/domain` 99 / 92, `packages/contract` lines 96. `apps/audit` gets a floor equal to its first measured figures (target ≥ 90 / 75).
- API and UI test suites pin `TZ=UTC`; time zone is Asia/Kolkata (IST day bounds, `isToday(iso)`, sort on the stored instant).
- `LocKey`, `Role` and every status/outcome are closed unions; never widen with `string` (the stored `action` of an audit row is the one deliberate `string`, so a removed route's history still reads).
- TypeScript `strict` + `verbatimModuleSyntax` + `erasableSyntaxOnly`: type-only imports use `import type`; no enums, no parameter properties, no namespaces.
- Toast and refusal copy is a full sentence in the operator's voice. Never hand-format a number (`money`, `fq`, …) or a time (`fromWireTime` and friends in the UI).
- Page descriptions (`PageHead sub`) are one short sentence: "Every change and sign-in, with who made it and when."
- Secrets are never stored in an audit event: the value of any key named exactly `password`, `newPassword`, `currentPassword`, `tempPassword`, `otp`, `token`, `accessToken`, `refreshToken` or `secret` is replaced with `"••••"`; the change-password body is recorded as `request: {}`.
- Commit messages follow the repo: a plain imperative sentence describing the outcome (e.g. "Record every write in the audit outbox"), body optional, and end with exactly:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG
  ```
- Never push, never touch the live box, never run a seed against it. Shipping (Task 21) waits for the user's explicit go-ahead.
- If a guide (`CLAUDE.md`, nested `CLAUDE.md`, `README.md`, `UI/README.md`, `deploy/RUNBOOK.md`) states something a task changes, the docs task updates it; every statement must be true at HEAD.

---

## File Structure

### `packages/contract`
| File | Responsibility |
|---|---|
| `src/schemas/audit.ts` (create) | `AuditOutcomeSchema`, `AuditActorSchema`, `AuditEventSchema`, `AuditRowSchema`, `AuditEntrySchema`, `AuditCountsSchema`, `AuditPageSchema`, `AuditQuerySchema`, `AuditIdParamsSchema`, `AuditGroupSchema` |
| `src/audit.ts` (create) | `AUDIT_GROUPS`, `AuditAction`, `AUDIT_LABELS`, `auditLabelOf`, `actionsInGroup`, `AUDIT_PATH` |
| `src/schemas/writes.ts` (modify) | `CollectionSchema` gains `"audit"` |
| `src/routes.ts` (modify) | `Route.service`, routes `auditLog`, `auditEntry` |
| `src/index.ts` (modify) | re-export the two new modules |
| `src/audit.test.ts`, `src/schemas/audit.test.ts` (create) | label exhaustiveness, masking-free schema parsing, query coercion |

### `apps/api`
| File | Responsibility |
|---|---|
| `drizzle/00NN_audit_outbox.sql` + `meta/_journal.json` (create/modify) | `audit_outbox` table |
| `src/db/schema/infra.ts` (modify) | Drizzle `auditOutbox` table |
| `src/lib/audit.ts` (create) | `SECRET_KEYS`, `maskSecrets`, `targetOf`, `actorOf`, `auditContextOf`, `writeOutcomeOf`, `auditEventOf`, `insertAuditEvent`, `recordAudit`, `auditBefore`, `recordAuthEvent`, `AUDIT_OUTBOX_CHANNEL` |
| `src/lib/idempotency-record.ts` (modify) | success outcome carries the parsed `body` |
| `src/lib/audit.test.ts` (create) | unit + DB tests of the above |
| `src/routes.ts` (modify) | `mount()` builds `req.audit`, refuses non-api routes, fills `mountedWrites` |
| `src/lib/db.ts` (modify) | `withTransaction` calls `recordAudit` after `recordIdempotent` |
| `src/plugins/idempotency.ts` (modify) | `IdemContext.audit` |
| `src/plugins/audit.ts` (create) | `onResponse` refusal / error / fallback capture |
| `src/app.ts` (modify) | register `plugins/audit.ts` |
| `src/modules/audit-capture.test.ts` (create) | completeness, done, atomicity, refusals, masking across real routes |
| edit services (modify) | `auditBefore(...)` calls |
| `src/modules/auth/{routes,service}.ts` (modify) | sign-in events |
| `src/plugins/sse.ts` (modify) | `audit` notices to admin streams only |
| `src/config.ts` (modify) | `MIGRATE_DATABASE_URL` → `config.migrateDatabaseUrl` |
| `src/lib/roles.ts` (create) | `roleFromUrls`, `ensureLoginRole`, `grantAppRole` |
| `src/cli/*.ts` (modify) | CLIs connect with `cliDatabaseUrl(config)`; `migrate` runs role setup |

### `apps/audit` (all new)
| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `Dockerfile`, `CLAUDE.md` | package scaffolding (no package-level `.oxlintrc.json`: oxlint replaces rather than merges configs, so one would switch off the root import bans) |
| `drizzle.config.ts`, `drizzle/0000_audit_events.sql`, `drizzle/meta/*` | storage migration |
| `src/config.ts` | `loadConfig(env): AuditConfig` - only reader of `process.env` |
| `src/app.ts`, `src/server.ts` | `buildApp(config, opts)`; listen + SIGTERM drain |
| `src/routes.ts` | `mount()` for `service: "audit"` routes; `mountedRoutes` |
| `src/plugins/{logging,errors,security,metrics,db,auth,health,drainer}.ts` | slim copies + drainer |
| `src/lib/errors.ts` | `AppError`, `ValidationError`, `UnauthenticatedError`, `ForbiddenError`, `NotFoundError`, `NotReadyError` |
| `src/lib/migrate-run.ts` | the migrate CLI's testable logic: `migrateAudit`, `waitForOutbox`, `outboxExists`, lock constants |
| `src/lib/db.ts`, `src/lib/time.ts` | `Tx`, `Reader`, `withReadTransaction`; IST day helpers |
| `src/lib/roles.ts` | `roleFromUrls`, `ensureLoginRole`, `grantAuditRole` |
| `src/lib/drain.ts` | `drainOnce` |
| `src/db/{client,migrate,schema}.ts` | `createDb`, `runMigrations`, `appliedMigrationCount`, `journalLength`, Drizzle tables |
| `src/cli/migrate.ts` | wait for outbox, advisory lock 727273, migrate, role setup |
| `src/modules/audit/{routes,service,repo,audit.test}.ts` | read routes |
| `src/test/{env,config,app,db}.ts` | per-file schema harness, test config and keys, token minting |

### `UI`
| File | Responsibility |
|---|---|
| `src/store/audit.ts` (create) | audit slice |
| `src/lib/audit.ts` (create) | `deviceOf`, `diffFields`, `auditCsv`, `auditDayRange` |
| `src/pages/AdminAudit.tsx` (create) | the tab |
| `src/pages/AuditEntryDrawer.tsx` (create) | the `auditEntry` drawer |
| `src/pages/AdminDashboard.tsx`, `src/api/refetch.ts`, `src/store/index.ts`, `vite.config.ts` (modify) | third tab, `audit` reader, slice merge, dev proxy |
| `src/__tests__/admin-audit.test.tsx`, `src/__tests__/audit-lib.test.ts` (create) | UI tests |

### Deploy, CI, gates, docs
`deploy/compose/{compose.yml,Caddyfile,.env.example,deploy.sh,release.sh,backup.sh,compose.test.sh,README.md}`,
`deploy/chart/rch/{values.yaml,templates/*,tests/render.test.sh,ci/*}`, `deploy/nginx/default.conf.template`,
`UI/Dockerfile`, `.github/workflows/{ci,deploy,deploy-box}.yml`, `deploy/cfn/{rch-env.yaml,dev.import.json}`,
`.trivyignore.yaml`, `turbo.json`, `knip.json`, `.oxlintrc.json`, `scripts/check-boundaries.sh`, `.env.example`,
`CLAUDE.md`, `apps/api/CLAUDE.md`, `UI/CLAUDE.md`, `packages/contract/CLAUDE.md`, `README.md`, `UI/README.md`,
`deploy/RUNBOOK.md`.

---

## Shared Interfaces (every task uses exactly these names)

### Contract - `packages/contract/src/schemas/audit.ts`

```ts
export const AUDIT_OUTCOMES = ["done", "refused", "error"] as const;
export const AuditOutcomeSchema = z.enum(AUDIT_OUTCOMES);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

export const AUDIT_GROUP_KEYS = ["sales", "stock", "purchasing", "production", "master", "accounts", "support"] as const;
export const AuditGroupSchema = z.enum(AUDIT_GROUP_KEYS);
export type AuditGroup = z.infer<typeof AuditGroupSchema>;

export const AuditActorSchema = z.strictObject({
  id: z.string().nullable(), emp: z.string(), name: z.string(), role: z.string(), loc: z.string(),
});
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AuditEventSchema = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  requestId: z.string(),
  actor: AuditActorSchema,
  action: z.string().min(1).max(64),
  method: z.string(), path: z.string(),
  target: z.string(), targetLoc: z.string(),
  outcome: AuditOutcomeSchema,
  status: z.number().int(),
  message: z.string(),
  cause: z.string().nullable(),
  request: z.unknown(),
  before: z.unknown().nullable(),
  result: z.unknown().nullable(),
  changed: z.array(CollectionSchema),
  ip: z.string(), userAgent: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditRowSchema = z.strictObject({
  id: z.number().int(), at: z.string(), actor: AuditActorSchema, action: z.string(),
  target: z.string(), targetLoc: z.string(), outcome: AuditOutcomeSchema, status: z.number().int(), message: z.string(),
  ip: z.string(), requestId: z.string(),
});
export type AuditRow = z.infer<typeof AuditRowSchema>;

export const AuditEntrySchema = AuditRowSchema.extend({
  method: z.string(), path: z.string(), cause: z.string().nullable(),
  request: z.unknown(), before: z.unknown().nullable(), result: z.unknown().nullable(),
  changed: z.array(z.string()), userAgent: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditCountsSchema = z.strictObject({
  events: z.number().int(), people: z.number().int(), refused: z.number().int(), failedSignIns: z.number().int(),
});
export type AuditCounts = z.infer<typeof AuditCountsSchema>;

export const AuditPageSchema = z.strictObject({
  rows: z.array(AuditRowSchema), next: z.number().int().nullable(), counts: AuditCountsSchema,
});
export type AuditPage = z.infer<typeof AuditPageSchema>;

const IstDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const AuditQuerySchema = z.strictObject({
  from: IstDay.optional(), to: IstDay.optional(),
  actor: z.string().max(64).optional(), role: z.string().max(40).optional(), loc: z.string().max(40).optional(),
  group: AuditGroupSchema.optional(), action: z.string().max(64).optional(), outcome: AuditOutcomeSchema.optional(),
  q: z.string().max(100).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
export const AuditIdParamsSchema = z.strictObject({ id: z.coerce.number().int().positive() });
```

### Contract - `packages/contract/src/audit.ts`

```ts
export const AUDIT_GROUPS: Record<AuditGroup, string> = {
  sales: "Sales", stock: "Stock movement", purchasing: "Purchasing", production: "Production",
  master: "Master data", accounts: "Accounts & sign-in", support: "Support",
};
/** Every manifest route that is a write (method !== "GET" unless `write` says otherwise, `write: false` excluded), plus the three auth events. */
export type AuditAction = WriteRouteName | "login" | "logout" | "changePassword";
export type AuditLabel = { label: string; refused?: string; group: AuditGroup };
export const AUDIT_LABELS: Record<AuditAction, AuditLabel>;
export function auditLabelOf(action: string, outcome: AuditOutcome): { label: string; group: AuditGroup | null };
export function actionsInGroup(group: AuditGroup): string[];
export const AUDIT_PATH = "/admin/audit";   // the audit service's path prefix under API_PREFIX
```

`packages/contract/src/routes.ts`:

```ts
export type Service = "api" | "audit";
// Route gains:   service?: Service;   (absent = "api")
auditLog:   defineRoute({ method: "GET", path: "/admin/audit",     access: "admin", service: "audit", query: AuditQuerySchema,     response: AuditPageSchema }),
auditEntry: defineRoute({ method: "GET", path: "/admin/audit/:id", access: "admin", service: "audit", params: AuditIdParamsSchema, response: AuditEntrySchema }),
export const serviceOf = (r: AnyRoute): Service => r.service ?? "api";
```

`CollectionSchema` gains `"audit"`.

### API - `apps/api/src/lib/audit.ts`

```ts
export const AUDIT_OUTBOX_CHANNEL = "rch_audit_outbox";
export const MASK = "••••";
export const SECRET_KEYS: ReadonlySet<string>;   // exact key names, see Global Constraints
export function maskSecrets<T>(value: T): T;
export function targetOf(action: string, params: unknown, body: unknown, result: unknown): { target: string; targetLoc: string };
/** What `mount()` knows about a non-public write before its handler runs; handed to `idemStore` by reference. */
export type AuditRequestContext = {
  action: string; method: string; path: string;
  requestId: string; ip: string; userAgent: string;
  params: unknown; query: unknown; body: unknown;
  actorId: string | null;
  before: unknown | null;
  pending: boolean;    // set inside the transaction that inserted the done event
  recorded: boolean;   // set once that transaction committed
};
export async function actorOf(db: Reader, userId: string | null, typedEmp?: string): Promise<AuditActor>;
export async function insertAuditEvent(db: Db | Tx, event: AuditEvent): Promise<void>;   // insert into audit_outbox + pg_notify(AUDIT_OUTBOX_CHANNEL, '')
export async function recordAudit(tx: Tx, ctx: IdemContext, value: unknown): Promise<void>;  // builds and inserts the "done" event, sets ctx.audit.pending
export function auditBefore(value: Record<string, unknown>): void;                            // stores on idemStore's ctx.audit.before
export type AuthEvent = { action: "login" | "logout" | "changePassword"; outcome: AuditOutcome; status: number; message: string; cause?: string | null; actorId: string | null; typedEmp?: string };
export async function recordAuthEvent(db: Db, req: FastifyRequest, e: AuthEvent): Promise<void>;
```

`apps/api/src/plugins/idempotency.ts`: `IdemContext` gains `audit: AuditRequestContext`.
`declare module "fastify" { interface FastifyRequest { audit?: AuditRequestContext } }` lives in `lib/audit.ts`.
`apps/api/src/routes.ts`: `export const mountedWrites = new Set<string>()` (route names).
`apps/api/src/plugins/audit.ts`: `fp(..., { name: "audit", dependencies: ["errors", "db"] })`.

### API - roles and CLIs

```ts
// apps/api/src/lib/roles.ts
export type LoginRole = { name: string; password: string };
export function roleFromUrls(runtimeUrl: string, migrateUrl: string): LoginRole | null;  // null when both URLs name the same user
export async function ensureLoginRole(db: Db, role: LoginRole): Promise<void>;           // create if missing, then alter password (escaped literal)
export async function grantAppRole(db: Db, role: string, opts: { schema: string; migrationsSchema: string }): Promise<void>;
// apps/api/src/config.ts
config.migrateDatabaseUrl: string | undefined;
export const cliDatabaseUrl = (c: Config): string => c.migrateDatabaseUrl ?? c.databaseUrl;
```

### Audit service - `apps/audit`

```ts
// src/config.ts
export type AuditConfig = {
  env: "development" | "test" | "production"; port: number; logLevel: string;
  databaseUrl: string;            // AUDIT_DATABASE_URL
  migrateDatabaseUrl: string;     // MIGRATE_DATABASE_URL ?? AUDIT_DATABASE_URL
  databaseSsl: boolean; dbPoolMax: number;
  jwtPublicKeyPem: string; jwtPreviousPublicKeyPem?: string;
  trustProxy: boolean | number;
  auditSchema: string; eventsSchema: string; outboxSchema: string;   // defaults "audit", "public", "public"
  drainBatch: number; drainPollMs: number;                            // 500, 5000
};
export function loadConfig(env: NodeJS.ProcessEnv): AuditConfig;

// src/db/client.ts
export type Db = NodePgDatabase<typeof schema>;
export function createDb(url: string, ssl: boolean, opts: { max: number; searchPath?: string }): { db: Db; pool: Pool };
// src/db/migrate.ts
export async function runMigrations(db: Db, auditSchema: string): Promise<void>;          // migrationsSchema `${auditSchema}_drizzle`
export async function appliedMigrationCount(db: Db, auditSchema: string): Promise<number>;
export function journalLength(): number;
// src/lib/drain.ts
export type DrainTarget = { auditSchema: string; outboxSchema: string; eventsSchema: string; batch: number };
export async function drainOnce(db: Db, t: DrainTarget): Promise<{ moved: number; dead: number; issues: Array<{ outboxId: number; issue: string }> }>;
// src/plugins/drainer.ts  →  app.drainer
{ lastPassAt: Date | null; lastPassOk: boolean; kick(): void; passes(): number; listening(): boolean; drainNow(): Promise<void> }
// src/app.ts
export type AuditApp = FastifyInstance;  // decorated with db, pool, config, drainer, metrics
export async function buildApp(config: AuditConfig, opts?: { db?: Db; pool?: Pool; searchPath?: string; logStream?: LogStream; drainer?: boolean }): Promise<AuditApp>;
// src/routes.ts
export const mountedRoutes = new Set<string>();   // "METHOD /path" keys, e.g. "GET /admin/audit/:id"
export function mount<R extends AnyRoute>(app: AuditApp, route: R, handler: Handler<R>): void;   // throws unless serviceOf(route) === "audit"
// src/lib/roles.ts
export function roleFromUrls(runtimeUrl: string, migrateUrl: string): { name: string; password: string } | null;
export async function ensureLoginRole(db: Db, role: { name: string; password: string }): Promise<void>;
export async function grantAuditRole(db: Db, role: string, opts: { auditSchema: string; outboxSchema: string }): Promise<void>;
// src/modules/audit/repo.ts
export type AuditFilter = { fromAt: Date; toAt: Date; actor?: string; role?: string; loc?: string; actions?: string[]; outcome?: AuditOutcome; q?: string; before?: number; limit: number };
export const auditRepo: {
  page(db: Db | Tx, f: AuditFilter): Promise<{ rows: AuditRow[]; next: number | null }>;
  counts(db: Db | Tx, f: AuditFilter): Promise<AuditCounts>;
  entry(db: Db | Tx, id: number): Promise<AuditEntry | null>;
};
// src/test/app.ts
export async function buildTestApp(opts: { schema: string; drainer?: boolean; env?: Partial<NodeJS.ProcessEnv> }): Promise<AuditApp & { testDb: AuditTestDb }>;
export type AuditTestDb = { db: Db; pool: Pool; outboxSchema: string; auditSchema: string; close(): Promise<void> };
export function signToken(app: AuditApp, claims: { sub: string; role: string; loc: string; admin: boolean; mcp?: boolean }, opts?: { previousKey?: boolean }): string;
export async function putOutbox(t: AuditTestDb, events: unknown[]): Promise<void>;
export const sampleEvent: (over?: Partial<AuditEvent>) => AuditEvent;
```

### UI

```ts
// UI/src/lib/audit.ts
export type AuditPeriod = "today" | "7d" | "30d" | "custom";
export function auditDayRange(period: AuditPeriod, custom: { from: string; to: string }, now?: Date): { from: string; to: string };  // IST YYYY-MM-DD
export function deviceOf(userAgent: string): string;                                  // "Chrome on Windows", "Unknown device"
export function diffFields(before: unknown, after: unknown): Array<{ field: string; before: unknown; after: unknown }>;
export function auditCsv(rows: AuditRow[]): string;
// UI/src/store/audit.ts
export type AuditFilter = { period: AuditPeriod; from: string; to: string; actor?: string; role?: string; loc?: string; group?: AuditGroup; outcome?: "done" | "refused"; q?: string };
export type AuditSlice = {
  audit: { rows: AuditRow[]; next: number | null; counts: AuditCounts | null; filter: AuditFilter; fresh: number; status: "idle" | "loading" | "ready" | "failed" };
  loadAudit(filter?: AuditFilter): Promise<AuditPage | null>;
  loadMoreAudit(): Promise<AuditPage | null>;
  readAuditEntry(id: number): Promise<AuditEntry | null>;
  exportAudit(filter: AuditFilter): Promise<{ csv: string; rows: number; capped: boolean } | null>;
  bumpAuditFresh(): void;
};
// drawer key: "auditEntry", opened with openDrawer("auditEntry", String(id))
```


### Interface additions and settled decisions

Each task section below opens with its own **Interface additions** block. Those names are as binding as the ones
above; a later task consumes them exactly as the earlier task defines them. Where a task section's
**Notes** mention a choice, the choice is already made in its code.

The decisions below were settled while writing this plan; the spec was amended to match (commit c48edf1).


The worktree /Users/srimanikandanr/.superset/worktrees/RCH-audit-log is now REBASED onto origin/develop 609befb
(8e6de95 removed recipes and migration 0015_drop_recipes exists; f736565 moved PageHead explanations into
tooltips via UI/src/ui/Tip.tsx; 609befb reworked approval/issue-desk layout). The manifest now has 90 routes.
Re-read every file you quote or anchor on; fix anchors, line refs, route lists and test data that changed.

D1  Outbox migration is `0016_audit_outbox.sql`. No recipe anything: drop `saveRecipe`, `recipesRepo`, recipe
    labels/tests/docs. No payer write routes exist either.
D2  Masking = exact key names only: password, newPassword, currentPassword, tempPassword, otp, token,
    accessToken, refreshToken, secret (`SECRET_KEYS` in apps/api/src/lib/audit.ts). changePassword events are
    recorded with `request: {}`.
D3  Every event sets `request`, `before`, `result` (null when absent). A response without a `result` key
    (patchMe) is stored whole as `result`.
D4  `AuditRowSchema` gains `ip: z.string()` and `requestId: z.string()` (so `AuditEntrySchema` must not
    re-declare them). The audit repo's page query selects them; the UI CSV uses them.
D5  Stored role labels are the full printed ones: "Counter Operator", "Outlet Manager", "Store Keeper",
    "Kitchen In-charge", "Procurement Officer", "Super Admin" (from apps/api/src/lib/wire.ts roleLabelOf).
D6  The fresh pill reads "New events - show" (no number; a notice may carry several events).
D7  API migration 0016 adds a trigger refusing UPDATE on audit_outbox; `grantAuditRole` grants
    `select, delete, update (at)` on it (for `for update skip locked`); `grantAppRole` grants insert only.
D8  A failed sign-in's typed employee id is stored only when it matches /^RC-\d+$/i, else "".
D9  Audit read filter `loc` matches `actor_loc = loc OR target_loc = loc`.
D10 apps/audit dev script sets `PORT=3100` inline; its Dockerfile sets `ENV PORT=3100`.
D11 The audit migrate CLI's role/grant step also holds advisory lock 727272 (API_MIGRATE_LOCK); its own
    migrations hold 727273 (AUDIT_MIGRATE_LOCK).
D12 Drain SQL lives in apps/audit/src/lib/drain.ts, each delete/insert written with the verb and table name on
    one line (the boundary grep depends on it).
D13 A refused write is recorded only when a valid token identified the caller (quiet token check is fine).
    No refusal row with a null actor from a write route; failed sign-ins are recorded by the auth module.
D14 `pg_notify('rch_audit_outbox', <outbox schema name>)`; the drainer kicks a pass only when the payload
    equals its OUTBOX_SCHEMA or is empty.
D15 `targetLoc` = params.loc ?? body.loc ?? body.from ?? result.loc ?? result.from ?? "".
D16 Tests that read a refusal's event `await app.auditSettled()` first.
D17 `auditBefore` is defined in Task 3 (lib/audit.ts) and consumed by Task 5; call it right after the row is
    read (after its lock where the service locks). Task 6 does not add `AuthEvent.request` (Task 2 does).
D18 Audit service readiness hook: `app.readiness.addCheck(name, check)` where check is
    `() => Promise<boolean | void> | boolean | void` (false or throw = not ready).
D19 `mountedRoutes` (apps/audit) holds "METHOD /path" keys; `mountedWrites` (apps/api) holds route names.
D20 UI `diffFields` compares one level into nested plain objects (field path "item.cost") and compares arrays
    by JSON; everything else by strict equality.
D21 Chart api container has no MIGRATE_DATABASE_URL; EKS operator CLIs needing the superuser run from a
    one-off pod built like the migrate initContainer. Box CLIs run via the `migrate` Compose service.
D22 `recordIdempotent` returns `{ ok: true; body }`; `drainOnce` returns `{ moved, dead, issues }`; drainer
    decorator adds `drainNow(): Promise<void>`.
D23 apps/audit has no package-level .oxlintrc.json.
D24 audit-migrate env: MIGRATE_DATABASE_URL, AUDIT_DATABASE_URL, JWT_PUBLIC_KEY, AUDIT_SCHEMA, OUTBOX_SCHEMA,
    LOG_LEVEL. CLI exit codes: 0 ok, 2 bad env, 3 outbox never appeared.
D25 Commit trailers exactly:
    Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG

---

## Tasks

Task order and dependencies:

| # | Task | Depends on |
|---|---|---|
| 0 | Worktree prerequisites | - |
| 1 | Contract: audit schemas, labels, routes, `audit` collection | 0 |
| 2 | API: outbox table and `lib/audit.ts` core | 1 |
| 3 | API: done events from `mount()` / `withTransaction` | 2 |
| 4 | API: refusal, error and fallback events (`plugins/audit.ts`) | 3 |
| 5 | API: before values in edit services | 3 |
| 6 | API: sign-in, sign-out and password events | 2 |
| 7 | API: `audit` notices to admin streams only | 1 |
| 8 | API: runtime role, migrate role setup, CLIs on the migrate URL | 2 |
| 9 | Audit service: scaffold, config, app, health | 1 |
| 10 | Audit service: storage, migrations, migrate CLI, roles | 9 |
| 11 | Audit service: drainer and readiness | 10 |
| 12 | Audit service: auth and read routes | 11 |
| 13 | UI: audit lib and store slice | 1 |
| 14 | UI: Audit log tab and entry drawer | 13 |
| 15 | Repo gates and local dev | 12, 14 |
| 16 | Audit service image and Compose / Caddy / scripts | 15 |
| 17 | Helm chart, UI nginx and render tests | 16 |
| 18 | CI, kind install test, EKS workflow, CloudFormation | 17 |
| 19 | Documentation | 18 |
| 20 | Full verification | 19 |
| 21 | Ship (only on the user's go-ahead) | 20 |

---

### Task 0: Worktree prerequisites

**Files:**
- None created or modified (environment only).

**Interfaces:**
- Consumes: nothing
- Produces: an installed, green baseline in the worktree that every later task's "run it to verify it fails" step can trust

- [ ] **Step 1: Confirm the worktree and branch**

Run: `git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log status --short --branch`
Expected: `## feature/audit-log...origin/develop [ahead N]` and no modified files. If anything is modified, stop and ask - the worktree must be clean before Task 1.

- [ ] **Step 2: Bring the branch up to date with develop**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log fetch origin
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log rebase origin/develop
```
Expected: `Successfully rebased` or `Current branch feature/audit-log is up to date.` Parallel sessions push to `develop` often (the payer write routes were removed on 2026-09-14); re-read `packages/contract/src/routes.ts` after rebasing, because Task 1's `AUDIT_LABELS` must match the manifest exactly.

- [ ] **Step 3: Install dependencies**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log install --frozen-lockfile`
Expected: exits 0. (If the network is unavailable, `--offline` works because the shared checkout populated the pnpm store.)

- [ ] **Step 4: Start Postgres**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log db:up`
Expected: the `postgres` container is running on host port 5439 (it is shared with the main checkout; the per-file `t_<name>_<pid>` schemas keep the two from colliding). Check with `docker ps --filter publish=5439`.

- [ ] **Step 5: Record the green baseline**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log turbo typecheck test`
Expected: every package passes with its coverage floor. Write down the coverage summary lines for `@rch/api`, `@rch/ui` and `@rch/contract` - Task 20 compares against them. If the baseline is red, stop: a failure that predates this work must not be mistaken for one of ours.

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log lint`
Expected: exits 0.

No commit: nothing changed.

---

#### Interface additions

- `packages/contract/src/routes.ts`:
  - `Route` gains three trailing type parameters with wide defaults, so `AnyRoute` is unchanged:
    `Route<P, Q, B, R, M extends Method = Method, W extends boolean | undefined = boolean | undefined, S extends Service | undefined = Service | undefined>`,
    with `method: M; write?: W; service?: S`. `defineRoute` infers `M`, `W` and `S` as literals (defaults `Method`, `undefined`, `undefined`).
  - `export const isWriteRoute = (r: AnyRoute): boolean => r.write ?? r.method !== "GET";` This is the one runtime reading of "is a write". Task 3's completeness test should use it, and `mount()` may switch to it.
- `packages/contract/src/audit.ts`: `export type WriteRouteName` (the skeleton names it in `AuditAction` but never exports it) and `export type AuditLabel` (already in the skeleton, now exported).
- `packages/contract/src/schemas/audit.ts` (D4): `AuditRowSchema` gains `ip: z.string()` and `requestId: z.string()`. `AuditEntrySchema` extends the row and does not re-declare them, so the entry adds only `method`, `path`, `cause`, `request`, `before`, `result`, `changed` and `userAgent`.

#### Notes

1. **Why the `Route` generics change.** `AUDIT_LABELS` has to be exhaustive by type, but `defineRoute` currently returns `Route<P, Q, B, R>`. That widens `method` to `Method` and `write` to `boolean`, so no type can tell a write route from a read. The fix is the literal type parameters listed above. It was checked in a scratch mirror of the rebased worktree (`609befb` + design commit), with the scratch contract path-mapped and the shared tree's `node_modules`. After the change `tsc --noEmit` passes for `packages/contract`, `packages/domain`, `apps/api` and `UI`, oxlint on contract is clean, and contract tests pass at 112 cases with lines at 97.44%, above the floor of 96. Removing any one label fails typecheck with `Property '<name>' is missing`.
2. **Zod 4.5.4 (the pinned version) confirmed:** `z.iso.datetime({ offset: true })` exists and accepts both `Z` and `+05:30`. `.extend()` on a `z.strictObject` stays strict. Missing `z.unknown()` keys are refused at runtime and required in the inferred type.
3. **No existing test breaks from the two new routes or the `audit` collection:**
   - `apps/api/src/contract.test.ts` already skips `access: "admin"` GETs. Task 3 may add `serviceOf(r) === "api"` to that filter so a future non-admin audit route isn't probed against the API.
   - `apps/api/src/routes.test.ts` checks uniqueness of method+path, and both new paths are unique.
   - `UI/src/api/refetch.ts`'s `NARROW` is `Partial<Record<Changed, …>>`, so typecheck still passes. But until Task 13 adds the `audit` reader, an `audit` notice falls back to `loadSnapshot()`. Tasks 7 and 11 must not reach a running UI before Task 13 lands. In one release that's fine.
   - `SAMPLES` in `routes.test.ts` needs nothing new, because neither route has a body.
4. **Docs (Task 19).** `packages/contract/CLAUDE.md` spells out `defineRoute({ method, path, access, params?, query?, body?, response, write?, allowMcp? })`. It needs `service?`, `isWriteRoute`, `serviceOf`, and the rule "a new write route needs an `AUDIT_LABELS` line". Add `src/audit.ts` and `src/schemas/audit.ts` to its Layout block. No recipes appear anywhere (D1).
5. **Worktree setup (Task 0).** The worktree has no `node_modules` yet. Every command below assumes Task 0's `pnpm install --frozen-lockfile` has run.

---

### Task 1: Contract: audit schemas, labels, routes, `audit` collection

**Files:**
- Create: `packages/contract/src/schemas/audit.ts`
- Create: `packages/contract/src/schemas/audit.test.ts`
- Create: `packages/contract/src/audit.ts`
- Create: `packages/contract/src/audit.test.ts`
- Modify: `packages/contract/src/routes.ts`: imports (after the `schemas/admin.js` import, line 7); the `Route` interface, `AnyRoute` and `defineRoute` (lines 17-26); two manifest entries appended after `setDeskTicketStatus` (line 181, the manifest's last entry)
- Modify: `packages/contract/src/schemas/writes.ts`: `CollectionSchema` and the last line of its doc comment (lines 9-10)
- Modify: `packages/contract/src/index.ts`: two re-exports
- Test: `packages/contract/src/routes.test.ts`: the import lines (3-4) and a new `describe` block appended at the end of the file

**Interfaces:**
- Consumes: nothing from earlier tasks (Task 0 only installs the worktree).
- Produces:
  - From `schemas/audit.ts`: `AUDIT_OUTCOMES`, `AuditOutcomeSchema`/`AuditOutcome`, `AUDIT_GROUP_KEYS`, `AuditGroupSchema`/`AuditGroup`, `AuditActorSchema`/`AuditActor`, `AuditEventSchema`/`AuditEvent`, `AuditRowSchema`/`AuditRow` (with `ip`, `requestId`), `AuditEntrySchema`/`AuditEntry`, `AuditCountsSchema`/`AuditCounts`, `AuditPageSchema`/`AuditPage`, `AuditQuerySchema`/`AuditQuery`, `AuditIdParamsSchema`.
  - From `audit.ts`: `AUDIT_GROUPS`, `WriteRouteName`, `AuditAction`, `AuditLabel`, `AUDIT_LABELS` (58 manifest writes + `login`, `logout`, `changePassword`), `auditLabelOf(action, outcome)`, `actionsInGroup(group)`, `AUDIT_PATH`.
  - From `routes.ts`: `Service`, `Route.service`, `serviceOf(r)`, `isWriteRoute(r)`, `routes.auditLog`, `routes.auditEntry`.
  - `CollectionSchema` / `Changed` gains `"audit"`.
  - Everything is re-exported from `@rch/contract`.

- [ ] **Step 1: Write the failing schema test**

Create `packages/contract/src/schemas/audit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AuditEntrySchema, AuditEventSchema, AuditIdParamsSchema, AuditPageSchema, AuditQuerySchema, AuditRowSchema } from "./audit";

/** A price edit, as the API would put it in the outbox. */
const event = {
  at: "2026-09-14T04:30:00.000Z",
  requestId: "req-7f3a",
  actor: { id: "u3", emp: "RC-3120", name: "Priya Nair", role: "Outlet Manager", loc: "rest" },
  action: "savePrice",
  method: "PUT", path: "/prices/:list/:it",
  target: "A:juice", targetLoc: "",
  outcome: "done",
  status: 200,
  message: "Price list A now sells Real Juice 200ml at ₹20.",
  cause: null,
  request: { params: { list: "A", it: "juice" }, query: {}, body: { price: 20 } },
  before: { price: 19 },
  result: { list: "A", it: "juice", price: 20 },
  changed: ["prices"],
  ip: "10.0.4.17", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0",
} as const;

describe("AuditEventSchema", () => {
  it("accepts a whole event, and an instant written in IST as well as in UTC", () => {
    expect(AuditEventSchema.safeParse(event).success).toBe(true);
    expect(AuditEventSchema.safeParse({ ...event, at: "2026-09-14T10:00:00.000+05:30" }).success).toBe(true);
  });

  it("accepts a failed sign-in against an employee number nobody holds", () => {
    const failed = { ...event, action: "login", actor: { id: null, emp: "RC-9999", name: "", role: "", loc: "" },
      outcome: "refused", status: 401, cause: "unknown employee", request: {}, before: null, result: null, changed: [] };
    expect(AuditEventSchema.safeParse(failed).success).toBe(true);
  });

  it("refuses an unknown key, so the drainer dead-letters an event built by a newer API rather than dropping a field", () => {
    expect(AuditEventSchema.safeParse({ ...event, surprise: 1 }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...event, actor: { ...event.actor, admin: true } }).success).toBe(false);
  });

  it("refuses a time that is not an instant, an outcome it does not know and a collection the UI cannot refetch", () => {
    expect(AuditEventSchema.safeParse({ ...event, at: "2026-09-14" }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...event, outcome: "failed" }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...event, changed: ["nonsense"] }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...event, action: "" }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...event, status: 200.5 }).success).toBe(false);
  });
});

describe("AuditQuerySchema", () => {
  it("answers a bare URL with today's first hundred", () => {
    expect(AuditQuerySchema.parse({})).toEqual({ limit: 100 });
  });

  it("takes the cursor and the page size as the strings a URL spells them in", () => {
    expect(AuditQuerySchema.parse({ before: "42", limit: "500" })).toEqual({ before: 42, limit: 500 });
    expect(AuditQuerySchema.parse({ from: "2026-09-01", to: "2026-09-14", group: "sales", outcome: "refused", q: "CF/1188" }))
      .toEqual({ from: "2026-09-01", to: "2026-09-14", group: "sales", outcome: "refused", q: "CF/1188", limit: 100 });
  });

  it("keeps a page between one and five hundred rows, and a cursor a real id", () => {
    for (const limit of ["0", "501", "1.5", ""]) expect(AuditQuerySchema.safeParse({ limit }).success, limit).toBe(false);
    for (const before of ["0", "-3", "abc"]) expect(AuditQuerySchema.safeParse({ before }).success, before).toBe(false);
  });

  it("refuses a day that is not YYYY-MM-DD, an area it does not have and a key it does not know", () => {
    expect(AuditQuerySchema.safeParse({ from: "14-09-2026" }).success).toBe(false);
    expect(AuditQuerySchema.safeParse({ group: "kitchen" }).success).toBe(false);
    expect(AuditQuerySchema.safeParse({ q: "x".repeat(101) }).success).toBe(false);
    expect(AuditQuerySchema.safeParse({ surprise: "1" }).success).toBe(false);
  });
});

describe("what the audit service answers with", () => {
  const { method, path, cause, request, before, result, changed, userAgent, ...rest } = event;
  const row = { id: 7, ...rest };
  const entry = { ...row, method, path, cause, request, before, result, changed, userAgent };

  it("reads a row, a page of rows with its counts, and a whole entry", () => {
    expect(AuditPageSchema.safeParse({ rows: [row], next: 6, counts: { events: 12, people: 3, refused: 2, failedSignIns: 1 } }).success).toBe(true);
    expect(AuditPageSchema.safeParse({ rows: [], next: null, counts: { events: 0, people: 0, refused: 0, failedSignIns: 0 } }).success).toBe(true);
    expect(AuditEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("carries the address and the request id on the row itself, because the CSV pages rows", () => {
    const { ip: _ip, ...withoutIp } = row;
    const { requestId: _requestId, ...withoutRequestId } = row;
    expect(AuditRowSchema.safeParse(withoutIp).success).toBe(false);
    expect(AuditRowSchema.safeParse(withoutRequestId).success).toBe(false);
  });

  it("keeps an entry strict, and reads a stored collection name the enum has since dropped", () => {
    expect(AuditEntrySchema.safeParse({ ...entry, surprise: 1 }).success).toBe(false);
    expect(AuditEntrySchema.safeParse({ ...entry, changed: ["retired"] }).success).toBe(true);
  });

  it("takes an entry id from the path as a positive whole number", () => {
    expect(AuditIdParamsSchema.parse({ id: "7" })).toEqual({ id: 7 });
    for (const id of ["0", "abc", "1.5"]) expect(AuditIdParamsSchema.safeParse({ id }).success, id).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rch/contract exec vitest run src/schemas/audit.test.ts`
Expected: FAIL `src/schemas/audit.test.ts` with `Error: Cannot find module './audit' imported from …/src/schemas/audit.test.ts`

- [ ] **Step 3: Implement the schemas**

Create `packages/contract/src/schemas/audit.ts`:

```ts
import { z } from "zod";
import { CollectionSchema } from "./writes.js";

/**
 * The audit log's wire shapes. The API writes an `AuditEvent` into its outbox inside the write's
 * own transaction; `apps/audit` drains it, stores it and serves it back as rows and entries. Both
 * services parse with these schemas, so an event one side builds is an event the other accepts.
 */
export const AUDIT_OUTCOMES = ["done", "refused", "error"] as const;
export const AuditOutcomeSchema = z.enum(AUDIT_OUTCOMES);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

/** The areas the Audit log's filter offers. Their printed names are `AUDIT_GROUPS` in `../audit.ts`. */
export const AUDIT_GROUP_KEYS = ["sales", "stock", "purchasing", "production", "master", "accounts", "support"] as const;
export const AuditGroupSchema = z.enum(AUDIT_GROUP_KEYS);
export type AuditGroup = z.infer<typeof AuditGroupSchema>;

/** Who acted, as they stood at that moment. `role` is the printed label ("Super Admin" included)
 *  and `id` is null for a sign-in attempt against an employee number nobody holds, where `emp` is
 *  what was typed. Plain strings rather than `RoleSchema`/`LocKeySchema`: the row outlives any
 *  rename, and a deleted account still reads. */
export const AuditActorSchema = z.strictObject({
  id: z.string().nullable(), emp: z.string(), name: z.string(), role: z.string(), loc: z.string(),
});
export type AuditActor = z.infer<typeof AuditActorSchema>;

/** One audited action. `action` is a string and not `AuditAction`, deliberately: a route removed
 *  from the manifest must not turn its history into dead letters. Secrets are masked before an
 *  event is built, so nothing here ever carries a password, an OTP or a token. */
export const AuditEventSchema = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  requestId: z.string(),
  actor: AuditActorSchema,
  action: z.string().min(1).max(64),
  method: z.string(), path: z.string(),
  target: z.string(), targetLoc: z.string(),
  outcome: AuditOutcomeSchema,
  status: z.number().int(),
  message: z.string(),
  cause: z.string().nullable(),
  request: z.unknown(),
  before: z.unknown().nullable(),
  result: z.unknown().nullable(),
  changed: z.array(CollectionSchema),
  ip: z.string(), userAgent: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** One line of the Audit log's table. `ip` and `requestId` ride on the row rather than only on the
 *  entry because the CSV export prints both, and it pages rows, not entries. */
export const AuditRowSchema = z.strictObject({
  id: z.number().int(), at: z.string(), actor: AuditActorSchema, action: z.string(),
  target: z.string(), targetLoc: z.string(), outcome: AuditOutcomeSchema, status: z.number().int(), message: z.string(),
  ip: z.string(), requestId: z.string(),
});
export type AuditRow = z.infer<typeof AuditRowSchema>;

/** What the drawer opens: the row plus everything the table leaves out. `changed` is plain
 *  strings, because a stored collection name outlives the enum it was drawn from. */
export const AuditEntrySchema = AuditRowSchema.extend({
  method: z.string(), path: z.string(), cause: z.string().nullable(),
  request: z.unknown(), before: z.unknown().nullable(), result: z.unknown().nullable(),
  changed: z.array(z.string()), userAgent: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** The four figures above the table, counted over the whole filter and not over the page. */
export const AuditCountsSchema = z.strictObject({
  events: z.number().int(), people: z.number().int(), refused: z.number().int(), failedSignIns: z.number().int(),
});
export type AuditCounts = z.infer<typeof AuditCountsSchema>;

/** `next` is the id to pass back as `before` for the following page, or null on the last one. */
export const AuditPageSchema = z.strictObject({
  rows: z.array(AuditRowSchema), next: z.number().int().nullable(), counts: AuditCountsSchema,
});
export type AuditPage = z.infer<typeof AuditPageSchema>;

/** A hospital day, `YYYY-MM-DD` in Asia/Kolkata. The audit service turns it into instants. */
const IstDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Every filter is optional and `limit` is defaulted, so a bare `GET /admin/audit` is today's
 *  first hundred events. `before` and `limit` arrive as strings in a URL and are coerced. */
export const AuditQuerySchema = z.strictObject({
  from: IstDay.optional(), to: IstDay.optional(),
  actor: z.string().max(64).optional(), role: z.string().max(40).optional(), loc: z.string().max(40).optional(),
  group: AuditGroupSchema.optional(), action: z.string().max(64).optional(), outcome: AuditOutcomeSchema.optional(),
  q: z.string().max(100).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
export const AuditIdParamsSchema = z.strictObject({ id: z.coerce.number().int().positive() });
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @rch/contract exec vitest run src/schemas/audit.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Write the failing manifest test**

In `packages/contract/src/routes.test.ts`, replace the two import lines 3-4:

```ts
import { AdjustReasonSchema, CreateAdjustmentBodySchema, DeskReplyBodySchema, CreatePoBodySchema, CreditParamsSchema, CreditResponseSchema, EVENTS_PATH, EventNoticeSchema, LocKeySchema, MakeBatchBodySchema, PatchContractBodySchema, PatchPoBodySchema, PatchVendorBodySchema, PO_APPROVAL_LIMIT, RaiseTicketBodySchema, RateTicketBodySchema, ReceivePoBodySchema, SetOrderStatusBodySchema, SetTicketStatusBodySchema, StockLedgerQuerySchema, StockLocSchema, TktStatusSchema, TransferBodySchema, ItemSchema, PatchItemBodySchema } from "./index";
import { routes } from "./routes";
```

with:

```ts
import { AdjustReasonSchema, CollectionSchema, CreateAdjustmentBodySchema, DeskReplyBodySchema, CreatePoBodySchema, CreditParamsSchema, CreditResponseSchema, EVENTS_PATH, EventNoticeSchema, LocKeySchema, MakeBatchBodySchema, PatchContractBodySchema, PatchPoBodySchema, PatchVendorBodySchema, PO_APPROVAL_LIMIT, RaiseTicketBodySchema, RateTicketBodySchema, ReceivePoBodySchema, SetOrderStatusBodySchema, SetTicketStatusBodySchema, StockLedgerQuerySchema, StockLocSchema, TktStatusSchema, TransferBodySchema, ItemSchema, PatchItemBodySchema } from "./index";
import { isWriteRoute, routes, serviceOf } from "./routes";
```

Append at the end of the file, after the closing `});` of `describe("what an adjustment puts on the wire", …)`:

```ts

// ---- admin: the audit log
describe("the audit log's routes", () => {
  const audit = Object.entries(routes).filter(([, r]) => serviceOf(r) === "audit");

  it("are answered by the audit service, and every other route by the API", () => {
    expect(audit.map(([name]) => name).sort()).toEqual(["auditEntry", "auditLog"]);
    expect(serviceOf(routes.pay)).toBe("api");
    expect(serviceOf(routes.adminUsers)).toBe("api");
  });

  it("are reads behind the admin flag, so neither carries an Idempotency-Key nor lands in its own log", () => {
    for (const [name, r] of audit) {
      expect(r.access, name).toBe("admin");
      expect(isWriteRoute(r), name).toBe(false);
    }
  });

  it("reads a write the way mount() and call() do: the manifest's flag first, then the method", () => {
    expect(isWriteRoute(routes.pay)).toBe(true);
    expect(isWriteRoute(routes.patchMe)).toBe(true);
    expect(isWriteRoute(routes.login)).toBe(false);
    expect(isWriteRoute(routes.snapshot)).toBe(false);
  });

  it("names `audit` as a collection a change notice can carry", () => {
    expect(CollectionSchema.safeParse("audit").success).toBe(true);
    expect(EventNoticeSchema.safeParse({ collection: "audit", at: "2026-09-14T04:30:00.000Z" }).success).toBe(true);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @rch/contract exec vitest run src/routes.test.ts`
Expected: FAIL `src/routes.test.ts` with `TypeError: serviceOf is not a function` (thrown while the new `describe` collects, so the file reports no tests)

- [ ] **Step 7: Implement `service`, `isWriteRoute`, the two routes and the `audit` collection**

In `packages/contract/src/routes.ts`, add one import directly after line 7 (`import { AdminActionSchema, … } from "./schemas/admin.js";`):

```ts
import { AuditEntrySchema, AuditIdParamsSchema, AuditPageSchema, AuditQuerySchema } from "./schemas/audit.js";
```

Replace lines 17-26:

```ts
export interface Route<P extends z.ZodTypeAny, Q extends z.ZodTypeAny, B extends z.ZodTypeAny, R extends z.ZodTypeAny> {
  method: Method; path: string; access: Access;
  params?: P; query?: Q; body?: B; response: R;
  /** Writes require an Idempotency-Key header (Task 10). Defaults to method !== "GET". */
  write?: boolean;
  /** Reachable while must_change_password is set. Only auth and /me. */
  allowMcp?: boolean;
}
export type AnyRoute = Route<z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny>;
export const defineRoute = <P extends z.ZodTypeAny = z.ZodNever, Q extends z.ZodTypeAny = z.ZodNever, B extends z.ZodTypeAny = z.ZodNever, R extends z.ZodTypeAny = z.ZodTypeAny>(r: Route<P, Q, B, R>) => r;
```

with:

```ts
/** The deployable that answers a route. `apps/api` mounts only `"api"` routes and `apps/audit`
 *  only `"audit"` ones; each refuses the other's at `mount()`. */
export type Service = "api" | "audit";

/** `M`, `W` and `S` default to the wide types, so `AnyRoute` is what it always was. `defineRoute`
 *  infers them as literals, which is what lets `audit.ts` derive the write routes by type and
 *  fail typecheck on a new write that has no audit label. */
export interface Route<P extends z.ZodTypeAny, Q extends z.ZodTypeAny, B extends z.ZodTypeAny, R extends z.ZodTypeAny, M extends Method = Method, W extends boolean | undefined = boolean | undefined, S extends Service | undefined = Service | undefined> {
  method: M; path: string; access: Access;
  params?: P; query?: Q; body?: B; response: R;
  /** Writes require an Idempotency-Key header (Task 10). Defaults to method !== "GET". */
  write?: W;
  /** Reachable while must_change_password is set. Only auth and /me. */
  allowMcp?: boolean;
  /** Which deployable answers the route. Absent means `"api"` (`serviceOf`). */
  service?: S;
}
export type AnyRoute = Route<z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny>;
export const defineRoute = <P extends z.ZodTypeAny = z.ZodNever, Q extends z.ZodTypeAny = z.ZodNever, B extends z.ZodTypeAny = z.ZodNever, R extends z.ZodTypeAny = z.ZodTypeAny, M extends Method = Method, W extends boolean | undefined = undefined, S extends Service | undefined = undefined>(r: Route<P, Q, B, R, M, W, S>) => r;
/** The one reading of "is this a write": `write` when the manifest says, else anything but a GET. */
export const isWriteRoute = (r: AnyRoute): boolean => r.write ?? r.method !== "GET";
export const serviceOf = (r: AnyRoute): Service => r.service ?? "api";
```

At the end of the manifest, replace:

```ts
  setDeskTicketStatus:   defineRoute({ method: "POST",  path: "/admin/support/tickets/:id/status", access: "admin", params: DocIdParamsSchema, body: SetTicketStatusBodySchema, response: writeResponse(SupportTicketSchema) }),
} as const;
```

with:

```ts
  setDeskTicketStatus:   defineRoute({ method: "POST",  path: "/admin/support/tickets/:id/status", access: "admin", params: DocIdParamsSchema, body: SetTicketStatusBodySchema, response: writeResponse(SupportTicketSchema) }),
  // ---- admin: the audit log. Answered by `apps/audit`, not by the API: `service: "audit"` is what
  // keeps these out of the API's `mount()` and in the audit service's. Both live under
  // `AUDIT_PATH`, so every proxy in front of the two services routes them with one prefix rule.
  auditLog:   defineRoute({ method: "GET", path: "/admin/audit",     access: "admin", service: "audit", query: AuditQuerySchema,     response: AuditPageSchema }),
  auditEntry: defineRoute({ method: "GET", path: "/admin/audit/:id", access: "admin", service: "audit", params: AuditIdParamsSchema, response: AuditEntrySchema }),
} as const;
```

In `packages/contract/src/schemas/writes.ts`, replace:

```ts
 *  `changed` a new product could name would be the whole snapshot. */
export const CollectionSchema = z.enum(["stock", "rsv", "ovr", "prices", "menu", "bills", "req", "tkt", "prq", "po", "pord", "batch", "grn", "vendors", "contracts", "tickets", "productReqs", "shopAsks", "items", "roster", "adjustments", "accounts"]);
```

with:

```ts
 *  `changed` a new product could name would be the whole snapshot. `"audit"` is never in a
 *  write's `changed`: it is the audit service's own notice that new events were stored, and the
 *  API's change stream sends it to admin streams only. */
export const CollectionSchema = z.enum(["stock", "rsv", "ovr", "prices", "menu", "bills", "req", "tkt", "prq", "po", "pord", "batch", "grn", "vendors", "contracts", "tickets", "productReqs", "shopAsks", "items", "roster", "adjustments", "accounts", "audit"]);
```

In `packages/contract/src/index.ts`, replace:

```ts
export * from "./schemas/admin.js";
export * from "./routes.js";
```

with:

```ts
export * from "./schemas/admin.js";
export * from "./schemas/audit.js";
export * from "./routes.js";
```

- [ ] **Step 8: Run it to verify it passes, and that the wider `Route` type still typechecks**

Run: `pnpm --filter @rch/contract exec vitest run src/routes.test.ts src/schemas/audit.test.ts`
Expected: PASS (93 tests)

Run: `pnpm --filter @rch/contract typecheck`
Expected: exits 0 with no output

- [ ] **Step 9: Write the failing labels test**

Create `packages/contract/src/audit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AUDIT_GROUP_KEYS } from "./schemas/audit";
import { AUDIT_GROUPS, AUDIT_LABELS, AUDIT_PATH, actionsInGroup, auditLabelOf, type AuditAction, type WriteRouteName } from "./audit";
import { isWriteRoute, routes, serviceOf } from "./routes";

const AUTH_ACTIONS = ["login", "logout", "changePassword"];

describe("AUDIT_LABELS", () => {
  it("labels exactly the writes the API answers, plus sign-in, sign-out and a password change", () => {
    // The runtime twin of `Record<AuditAction, AuditLabel>`: the type catches a missing label at
    // typecheck, this catches a route whose `write` flag and method disagree with the type's reading.
    const writes = Object.entries(routes).filter(([, r]) => isWriteRoute(r) && serviceOf(r) === "api").map(([name]) => name);
    expect(Object.keys(AUDIT_LABELS).sort()).toEqual([...writes, ...AUTH_ACTIONS].sort());
  });

  it("gives every action a label of its own, so the table and the CSV never print two actions alike", () => {
    const labels = Object.values(AUDIT_LABELS).map((l) => l.label);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("keeps reads, the token refresh and the audit service's own routes out of the type", () => {
    const writes: WriteRouteName[] = ["pay", "patchMe", "savePrice", "deleteAdminUser"];
    const actions: AuditAction[] = [...writes, "login", "logout", "changePassword"];
    const notActions: AuditAction[] = [
      // @ts-expect-error - a GET is a read, and reads are not audited
      "snapshot",
      // @ts-expect-error - an automatic token refresh is not an event
      "refresh",
      // @ts-expect-error - reading the log is not an event in it
      "auditLog",
    ];
    expect(actions.every((a) => a in AUDIT_LABELS)).toBe(true);
    expect(notActions.some((a) => a in AUDIT_LABELS)).toBe(false);
  });
});

describe("AUDIT_GROUPS", () => {
  it("prints every area the filter offers, and every area holds at least one action", () => {
    expect(Object.keys(AUDIT_GROUPS).sort()).toEqual([...AUDIT_GROUP_KEYS].sort());
    for (const g of AUDIT_GROUP_KEYS) expect(actionsInGroup(g).length, g).toBeGreaterThan(0);
  });

  it("puts every action in exactly one area", () => {
    const grouped = AUDIT_GROUP_KEYS.flatMap((g) => actionsInGroup(g));
    expect(grouped.sort()).toEqual(Object.keys(AUDIT_LABELS).sort());
  });

  it("files sign-in with accounts and a bill with sales", () => {
    expect(actionsInGroup("accounts")).toEqual(expect.arrayContaining(["login", "logout", "changePassword", "createAdminUser"]));
    expect(actionsInGroup("sales").sort()).toEqual(["pay", "toggleAvail", "voidBill"]);
  });
});

describe("auditLabelOf", () => {
  it("prints an action's label and area", () => {
    expect(auditLabelOf("pay", "done")).toEqual({ label: "Posted a bill", group: "sales" });
    expect(auditLabelOf("savePrice", "error")).toEqual({ label: "Changed a price", group: "master" });
  });

  it("prints a refused sign-in as a failed one, and leaves every other refusal on its own label", () => {
    expect(auditLabelOf("login", "done")).toEqual({ label: "Signed in", group: "accounts" });
    expect(auditLabelOf("login", "refused")).toEqual({ label: "Failed sign-in", group: "accounts" });
    expect(auditLabelOf("pay", "refused")).toEqual({ label: "Posted a bill", group: "sales" });
  });

  it("prints an action nobody labels any more as itself, in no area", () => {
    expect(auditLabelOf("retiredWrite", "done")).toEqual({ label: "retiredWrite", group: null });
    // Not a label inherited from Object.prototype.
    expect(auditLabelOf("constructor", "done")).toEqual({ label: "constructor", group: null });
  });
});

describe("AUDIT_PATH", () => {
  it("holds every route the audit service answers and none the API does, so one proxy rule splits the two", () => {
    const under = Object.entries(routes).filter(([, r]) => r.path.startsWith(AUDIT_PATH));
    expect(under.map(([name]) => name).sort()).toEqual(["auditEntry", "auditLog"]);
    for (const [name, r] of under) expect(serviceOf(r), name).toBe("audit");
  });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm --filter @rch/contract exec vitest run src/audit.test.ts`
Expected: FAIL `src/audit.test.ts` with `Error: Cannot find module './audit' imported from …/src/audit.test.ts`

- [ ] **Step 11: Implement the labels**

Create `packages/contract/src/audit.ts`. It holds one line for each of the 58 write routes in the rebased manifest plus the three auth actions: 61 lines. The manifest has no recipe or payer writes (D1).

```ts
import type { AnyRoute, RouteName, routes } from "./routes.js";
import type { AuditGroup, AuditOutcome } from "./schemas/audit.js";

/** The Audit log's areas, as the filter prints them. */
export const AUDIT_GROUPS: Record<AuditGroup, string> = {
  sales: "Sales", stock: "Stock movement", purchasing: "Purchasing", production: "Production",
  master: "Master data", accounts: "Accounts & sign-in", support: "Support",
};

// `defineRoute` keeps `method`, `write` and `service` as literals, so write-ness is readable off
// the manifest's own type: `write` when the entry says, else anything but a GET - the same
// reading as `isWriteRoute`. The auth routes say `write: false` and fall out here; sign-in,
// sign-out and a password change come back in below as actions of their own.
type WriteFlag<T extends AnyRoute> = Exclude<T["write"], undefined>;
type IsWrite<T extends AnyRoute> = [WriteFlag<T>] extends [never] ? (T["method"] extends "GET" ? false : true) : WriteFlag<T>;
type IsAudit<T extends AnyRoute> = T["service"] extends "audit" ? true : false;
/** Every manifest write the API answers. */
export type WriteRouteName = {
  [K in RouteName]: IsAudit<(typeof routes)[K]> extends true ? never : IsWrite<(typeof routes)[K]> extends true ? K : never;
}[RouteName];

/** Every manifest route that is a write (method !== "GET" unless `write` says otherwise, `write: false` excluded), plus the three auth events. */
export type AuditAction = WriteRouteName | "login" | "logout" | "changePassword";
export type AuditLabel = { label: string; refused?: string; group: AuditGroup };

/**
 * What the Audit log prints for each action, in the past tense of the person who did it.
 * `Record<AuditAction, …>` makes this exhaustive: a new write route with no line here fails
 * typecheck, and `audit.test.ts` checks the same thing against the manifest at runtime.
 * `refused` replaces the label only where a refusal means something else entirely - a refused
 * sign-in is not "Signed in" with a red pill, it is a failed sign-in.
 */
export const AUDIT_LABELS: Record<AuditAction, AuditLabel> = {
  // ---- accounts & sign-in
  login:                  { label: "Signed in", refused: "Failed sign-in", group: "accounts" },
  logout:                 { label: "Signed out", group: "accounts" },
  changePassword:         { label: "Changed their password", group: "accounts" },
  patchMe:                { label: "Changed their own details", group: "accounts" },
  createAdminUser:        { label: "Created a staff account", group: "accounts" },
  resetAdminUserPassword: { label: "Reset a staff account's password", group: "accounts" },
  deactivateAdminUser:    { label: "Deactivated a staff account", group: "accounts" },
  reactivateAdminUser:    { label: "Reactivated a staff account", group: "accounts" },
  updateAdminUser:        { label: "Changed a staff account's role and location", group: "accounts" },
  deleteAdminUser:        { label: "Deleted a staff account", group: "accounts" },
  // ---- sales
  pay:                    { label: "Posted a bill", group: "sales" },
  voidBill:               { label: "Voided a bill", group: "sales" },
  toggleAvail:            { label: "Switched an item's availability", group: "sales" },
  // ---- stock movement
  createRequest:          { label: "Raised a stock request", group: "stock" },
  cancelRequest:          { label: "Cancelled a stock request", group: "stock" },
  approveRequest:         { label: "Approved a stock request", group: "stock" },
  rejectRequest:          { label: "Rejected a stock request", group: "stock" },
  issueTicket:            { label: "Issued a ticket for a stock request", group: "stock" },
  handover:               { label: "Handed over a ticket", group: "stock" },
  receiveTicket:          { label: "Received a ticket", group: "stock" },
  cancelTicket:           { label: "Cancelled a ticket", group: "stock" },
  transfer:               { label: "Transferred stock to another outlet", group: "stock" },
  askShop:                { label: "Asked another outlet for stock", group: "stock" },
  answerShopAsk:          { label: "Sent stock for another outlet's ask", group: "stock" },
  declineShopAsk:         { label: "Declined another outlet's ask", group: "stock" },
  createAdjustment:       { label: "Posted a stock adjustment", group: "stock" },
  // ---- production
  createProdOrder:        { label: "Raised a kitchen order", group: "production" },
  setOrderStatus:         { label: "Moved a kitchen order", group: "production" },
  dispatchProdOrder:      { label: "Dispatched a kitchen order", group: "production" },
  distribute:             { label: "Sent kitchen stock to an outlet", group: "production" },
  makeBatch:              { label: "Made a batch", group: "production" },
  // ---- purchasing
  createRequisition:      { label: "Raised a purchase requisition", group: "purchasing" },
  approveRequisition:     { label: "Approved a purchase requisition", group: "purchasing" },
  declineRequisition:     { label: "Declined a purchase requisition", group: "purchasing" },
  addToProcurementList:   { label: "Added to the procurement list", group: "purchasing" },
  createPo:               { label: "Raised a purchase order", group: "purchasing" },
  updatePoLine:           { label: "Changed a purchase order line", group: "purchasing" },
  removePoLine:           { label: "Removed a purchase order line", group: "purchasing" },
  patchPo:                { label: "Changed a purchase order", group: "purchasing" },
  sendPo:                 { label: "Sent a purchase order", group: "purchasing" },
  cancelPo:               { label: "Cancelled a purchase order", group: "purchasing" },
  receivePo:              { label: "Received goods against a purchase order", group: "purchasing" },
  closePoShort:           { label: "Closed a purchase order short", group: "purchasing" },
  // ---- master data
  createItem:             { label: "Added a product", group: "master" },
  patchItem:              { label: "Changed a product", group: "master" },
  savePrice:              { label: "Changed a price", group: "master" },
  addMenuItem:            { label: "Added an item to a menu", group: "master" },
  removeMenuItem:         { label: "Removed an item from a menu", group: "master" },
  addVendor:              { label: "Added a vendor", group: "master" },
  updateVendor:           { label: "Changed a vendor", group: "master" },
  addContract:            { label: "Added a rate contract", group: "master" },
  updateContract:         { label: "Changed a rate contract", group: "master" },
  removeContract:         { label: "Removed a rate contract", group: "master" },
  createProductRequest:   { label: "Asked for a new product", group: "master" },
  answerProductRequest:   { label: "Answered a new-product request", group: "master" },
  // ---- support
  raiseTicket:            { label: "Raised a support ticket", group: "support" },
  replyToTicket:          { label: "Replied to a support ticket", group: "support" },
  setTicketStatus:        { label: "Changed a support ticket's status", group: "support" },
  rateTicket:             { label: "Rated a support ticket", group: "support" },
  replyAsDesk:            { label: "Replied as the support desk", group: "support" },
  setDeskTicketStatus:    { label: "Changed a support ticket's status at the desk", group: "support" },
};

/** The label and area to print for a stored row. `action` is a plain string because the row
 *  may predate the manifest it is read against: an action nobody labels any more prints as
 *  itself, in no area, rather than breaking the page. */
export function auditLabelOf(action: string, outcome: AuditOutcome): { label: string; group: AuditGroup | null } {
  if (!Object.hasOwn(AUDIT_LABELS, action)) return { label: action, group: null };
  const l = AUDIT_LABELS[action as AuditAction];
  return { label: outcome === "refused" && l.refused ? l.refused : l.label, group: l.group };
}

/** The action names an area filter matches, for the audit service's `action = any(...)`. */
export function actionsInGroup(group: AuditGroup): string[] {
  return Object.entries(AUDIT_LABELS).filter(([, l]) => l.group === group).map(([a]) => a);
}

/** The audit service's path prefix under `API_PREFIX`. Every `service: "audit"` route lives under
 *  it and no API route does, so one proxy rule (Vite, Caddy, nginx, the ingress) routes them all. */
export const AUDIT_PATH = "/admin/audit";
```

In `packages/contract/src/index.ts`, replace:

```ts
export * from "./routes.js";
```

with:

```ts
export * from "./routes.js";
export * from "./audit.js";
```

- [ ] **Step 12: Run it to verify it passes, including the type-level checks**

Run: `pnpm --filter @rch/contract exec vitest run src/audit.test.ts`
Expected: PASS (10 tests)

Run: `pnpm --filter @rch/contract typecheck`
Expected: exits 0. If a manifest write has no label, this fails with `Property '<name>' is missing in type … 'Record<AuditAction, AuditLabel>'`. If one of the three `@ts-expect-error` lines stops being an error, it fails with `Unused '@ts-expect-error' directive`.

- [ ] **Step 13: Run the package gates and the consumers of the widened `Route` type**

Run: `pnpm --filter @rch/contract test`
Expected: PASS for 6 files and 112 tests. The coverage summary shows `Lines : 97.44%`, above the `lines: 96` threshold. The floor stays at 96.

Run: `pnpm --filter @rch/contract lint`
Expected: exits 0 (`oxlint --max-warnings 0`)

Run: `pnpm --filter @rch/api typecheck && pnpm --filter @rch/ui typecheck && pnpm --filter @rch/domain typecheck`
Expected: all three exit 0. `mount()`'s `Req<R>` / `Handler<R>` and the UI's `call<R extends AnyRoute>` infer through the new trailing type parameters unchanged.

Run: `pnpm lint`
Expected: exits 0. The new exports are `@rch/contract` entry exports, so knip doesn't report them. `scripts/check-boundaries.sh` is unaffected.

- [ ] **Step 14: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add packages/contract/src/schemas/audit.ts packages/contract/src/schemas/audit.test.ts packages/contract/src/audit.ts packages/contract/src/audit.test.ts packages/contract/src/routes.ts packages/contract/src/routes.test.ts packages/contract/src/schemas/writes.ts packages/contract/src/index.ts
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Declare the audit log's wire shapes, labels and routes in the contract

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

#### Interface additions

- `apps/api/src/lib/audit.ts`:
  - `export const SECRET_KEYS: ReadonlySet<string>`: the exact key names `maskSecrets` masks (`password`, `newPassword`, `currentPassword`, `tempPassword`, `otp`, `token`, `accessToken`, `refreshToken`, `secret`). It replaces the `/pass(word)?|otp|token|secret/i` pattern. The pattern also hid `mustChangePassword`, which is a real before → after field. `tempPassword` is the field name in `AdminUserWithTempPasswordSchema` (`packages/contract/src/schemas/admin.ts`). `otp` is the key in `HandoverBodySchema` and `TicketSchema`.
  - `export function auditContextOf(req: AuditedRequest, route: { action: string; method: string; path: string }): AuditRequestContext`. One builder of a request's audit context, shared by `mount()` and `plugins/audit.ts`. `AuditedRequest` is a structural type, so both `Req<R>` and `FastifyRequest` fit without a cast.
  - `export function writeOutcomeOf(body: unknown): { result: unknown; changed: Changed[]; message: string }` reads a reply as `{ result, changed, message }`. A body with no `result` key (for example `PATCH /me`'s `{ user, mustChangePassword }`) is stored whole as `result`, with `message: ""` and `changed: []`.
  - `export async function auditEventOf(db: Reader, a: AuditRequestContext, o: { outcome; status; message; cause; result; changed }): Promise<AuditEvent>` is the one place an event is assembled and masked. It always sets `request`, `before` and `result`, using `null` where there is none.
  - `AuthEvent` gains `request?: unknown`. When it is set, `recordAuthEvent` stores `maskSecrets(e.request)` in place of `{ params, query }`. The default never includes the body. Task 6 does not add it (D17).
  - `recordAudit(tx, ctx, body)`: `body` is the response as the route schema parsed it, the same value the idempotency record stored.
  - **`auditBefore` lands in Task 3, not Task 2**, because it writes `ctx.audit`, which Task 3 adds.
- `apps/api/src/lib/idempotency-record.ts`: `RecordOutcome`'s success variant becomes `{ ok: true; body: unknown }`. `body` is the parsed response, which `withTransaction` hands to `recordAudit`.
- `apps/api/src/routes.ts`: `FastifyContextConfig` gains `audit?: { action: string; method: string; path: string }`. `mount()` sets it on every non-public write, and `plugins/audit.ts` reads it. A test-only route that isn't in the manifest is audited under the action `"<METHOD> <path>"` (for example `"POST /__test/audit-boom"`) and is not added to `mountedWrites`.
- `apps/api/src/plugins/audit.ts`: the decorator `app.auditSettled(): Promise<void>` resolves once every event the hook is still storing has been stored or given up on. Tests await it before reading the outbox (D16), and `onClose` awaits it too. The `fp` dependencies are `["errors", "db", "auth"]`. `auth` is there for the quiet token check: Fastify refuses a malformed body before the route's own authentication runs, and the check still names a signed-in caller. A refusal that no valid token names records nothing (D13).
- The migration adds the function `audit_outbox_no_update()` and the trigger `audit_outbox_no_update` (`BEFORE UPDATE`). They refuse every UPDATE with `audit_outbox rows are never updated; the audit service moves each one as it was written`.
- The NOTIFY is `pg_notify('rch_audit_outbox', current_schema())`. The channel is unchanged (`AUDIT_OUTBOX_CHANNEL`); the payload is the outbox's schema name.

#### Notes

1. **The super admin's actor `loc` is `""`**, not its placeholder `store`, for the same reason `lib/wire.ts` prints its role as `Super Admin`. The spec only says "location as they stood".
2. **`seedDatabase --force` now truncates `audit_outbox`** (`allTableNames()` derives from the schema), and `resetDocuments` does too (Task 2 adds it on purpose). A forced reseed drops undrained events. A forced reseed is never run on the box.
3. **`scripts/check-boundaries.sh` section 4 lets test files insert as well as read.** Part 03's `lib/roles.test.ts` inserts into the outbox as `rch_app` with raw SQL. `src/test/` is exempt from the read check only.
4. **Verification.** All three tasks were implemented in a scratch mirror of the rebased worktree (`609befb` plus this plan), using the shared tree's `node_modules`, with Task 1 stubbed exactly as Shared Interfaces declare it.
   - `db:generate --name audit_outbox` produced `0016_audit_outbox.sql` with exactly the `CREATE TABLE` shown in Task 2, and a second run printed "No schema changes".
   - With all three tasks applied, `tsc --noEmit`, `oxlint --max-warnings 0`, `knip --workspace apps/api` and `check-boundaries.sh` are clean. The whole `apps/api` suite passes: 54 files, 790 tests, lines 95.45 and branches 81.87, against floors of 94 and 79.
   - None of the files these tasks anchor on (`routes.ts`, `lib/db.ts`, `lib/idempotency-record.ts`, `plugins/idempotency.ts`, `app.ts`, `test/db.ts`, `db/schema/infra.ts`, `scripts/check-boundaries.sh`) changed in the rebase, so every replacement block below applies as written.

---

### Task 2: API: outbox table and `lib/audit.ts` core

**Files:**
- Create: `apps/api/drizzle/0016_audit_outbox.sql` (generated, then the trigger appended), `apps/api/drizzle/meta/0016_snapshot.json` (generated)
- Create: `apps/api/src/lib/audit.ts`
- Create: `apps/api/src/lib/audit.test.ts`
- Modify: `apps/api/drizzle/meta/_journal.json` (entry appended by `db:generate`)
- Modify: `apps/api/src/db/schema/infra.ts` (append `auditOutbox` after `refreshTokens`, end of file)
- Modify: `apps/api/src/test/db.ts` (`resetDocuments`'s table list, after `"document_history", "idempotency_keys",`)
- Modify: `scripts/check-boundaries.sh` (new section 4, inserted just before the final `if [ "$fail" != "0" ]; then` block)
- Test: `apps/api/src/lib/audit.test.ts`

**Interfaces:**
- Consumes: `AuditEventSchema`, `AuditEvent`, `AuditActor`, `AuditOutcome`, `API_PREFIX` (Task 1, `@rch/contract`); `roleLabelOf` (`lib/wire.ts`); `Reader`, `Tx` (`lib/db.ts`); `Db` (`db/client.ts`); `withTestSchema`, `seedTestDb` (harness).
- Produces: table `audit_outbox` and trigger `audit_outbox_no_update`; Drizzle `auditOutbox`; from `lib/audit.ts`: `AUDIT_OUTBOX_CHANNEL`, `MASK`, `SECRET_KEYS`, `maskSecrets`, `targetOf`, `actorOf`, `insertAuditEvent`, `AuthEvent`, `recordAuthEvent`; the boundary rule for `audit_outbox`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/audit.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { asc, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AuditEvent } from "@rch/contract";
import { auditOutbox } from "../db/schema/index.js";
import { withTestSchema, type TestDb } from "../test/db.js";
import { seedTestDb } from "../test/seed.js";
import { AUDIT_OUTBOX_CHANNEL, MASK, SECRET_KEYS, actorOf, insertAuditEvent, maskSecrets, recordAuthEvent, targetOf } from "./audit.js";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test";

let t: TestDb;
let listener: Client;
/** Payloads of the notices this file's own outbox sent. The channel is database-wide and every
 *  other test file's writes notify on it too; the payload names the schema, so they are left out. */
let heard: string[] = [];

beforeAll(async () => {
  t = await withTestSchema("audit");
  await seedTestDb(t.db);
  listener = new Client({ connectionString: BASE });
  await listener.connect();
  listener.on("notification", (m) => { if (m.channel === AUDIT_OUTBOX_CHANNEL && m.payload === t.schemaName) heard.push(m.payload); });
  await listener.query(`listen "${AUDIT_OUTBOX_CHANNEL}"`);
});
afterAll(async () => { await listener.end(); await t.close(); });

/** NOTIFY is delivered asynchronously; give the listener socket a turn. */
const settle = () => new Promise((r) => setTimeout(r, 150));
const rows = () => t.db.select().from(auditOutbox).orderBy(asc(auditOutbox.id));

/** A complete, valid event - each case overrides only what it is about. */
const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  at: new Date().toISOString(), requestId: "req-audit-1",
  actor: { id: "u1", emp: "RC-4471", name: "Kavitha Raman", role: "Counter Operator", loc: "coffee" },
  action: "pay", method: "POST", path: "/bills", target: "CF/1188", targetLoc: "coffee",
  outcome: "done", status: 200, message: "Bill CF/1188 · ₹20.00 collected at Coffee Shop", cause: null,
  request: { params: {}, query: {}, body: { loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }] } },
  before: null, result: { no: "CF/1188", loc: "coffee" }, changed: ["stock", "bills"],
  ip: "127.0.0.1", userAgent: "vitest", ...over,
});

describe("maskSecrets", () => {
  it("masks every secret key at any depth", () => {
    const sent = {
      body: { password: "hunter2222", newPassword: "n3w-pass-word", currentPassword: "old-pass-word", tempPassword: "Temp-1234", name: "Anitha R" },
      lines: [{ otp: "123456", qty: 2 }],
      session: { token: "t", accessToken: "at", refreshToken: "rt", secret: { nested: "still a secret" } },
    };
    expect(maskSecrets(sent)).toEqual({
      body: { password: MASK, newPassword: MASK, currentPassword: MASK, tempPassword: MASK, name: "Anitha R" },
      lines: [{ otp: MASK, qty: 2 }],
      session: { token: MASK, accessToken: MASK, refreshToken: MASK, secret: MASK },
    });
    // A copy: the request object Fastify still holds is not rewritten under it.
    expect(sent.body.password).toBe("hunter2222");
  });

  it("matches names exactly, so a field that only mentions a secret stays readable", () => {
    expect(maskSecrets({ mustChangePassword: true, OTP: "x", otpAttempts: 2, clientSecret: "y", current: "c", next: "n" }))
      .toEqual({ mustChangePassword: true, OTP: "x", otpAttempts: 2, clientSecret: "y", current: "c", next: "n" });
    expect([...SECRET_KEYS].sort()).toEqual(["accessToken", "currentPassword", "newPassword", "otp", "password", "refreshToken", "secret", "tempPassword", "token"]);
  });

  it("leaves every non-object as it is", () => {
    expect(maskSecrets("otp")).toBe("otp");
    expect(maskSecrets(42)).toBe(42);
    expect(maskSecrets(null)).toBeNull();
    const at = new Date("2026-09-14T04:30:00.000Z");
    expect(maskSecrets({ at })).toEqual({ at });
  });
});

describe("targetOf", () => {
  it("names one document by its id, its number or its key, from the path or the result", () => {
    expect(targetOf("approveRequest", { id: "REQ-2026-0911" }, { appr: [12], note: "" }, { request: {}, trimmed: false })).toEqual({ target: "REQ-2026-0911", targetLoc: "" });
    expect(targetOf("voidBill", { no: "CF/1188" }, { reason: "Wrong item" }, { no: "CF/1188", loc: "coffee" })).toEqual({ target: "CF/1188", targetLoc: "coffee" });
    expect(targetOf("patchItem", { it: "juice" }, { cost: 14 }, { key: "juice", item: {} })).toEqual({ target: "juice", targetLoc: "" });
    expect(targetOf("pay", {}, { loc: "coffee" }, { no: "CF/1189", loc: "coffee" })).toEqual({ target: "CF/1189", targetLoc: "coffee" });
    expect(targetOf("createRequest", {}, { lines: [] }, { id: "REQ-2026-0913", from: "coffee" })).toEqual({ target: "REQ-2026-0913", targetLoc: "coffee" });
    expect(targetOf("createItem", {}, { name: "Masala Tea" }, { key: "tea2", item: {} })).toEqual({ target: "tea2", targetLoc: "" });
    expect(targetOf("transfer", {}, { from: "coffee", to: "kiosk" }, { id: "TKT-0801", from: "coffee", to: "kiosk" })).toEqual({ target: "TKT-0801", targetLoc: "coffee" });
    // What the request named wins over anything the result carries.
    expect(targetOf("createProdOrder", {}, { from: "rest", lines: [] }, { id: "PORD-0101", loc: "kiosk", from: "kiosk" })).toEqual({ target: "PORD-0101", targetLoc: "rest" });
  });

  it("names a cell where one field alone would be ambiguous", () => {
    expect(targetOf("savePrice", { list: "A", it: "juice" }, { price: 19 }, { list: "A", it: "juice", price: 19 })).toEqual({ target: "A:juice", targetLoc: "" });
    expect(targetOf("addMenuItem", { loc: "rest" }, { it: "tea" }, { loc: "rest", items: ["tea"] })).toEqual({ target: "rest:tea", targetLoc: "rest" });
    expect(targetOf("removeMenuItem", { loc: "rest", it: "tea" }, undefined, null)).toEqual({ target: "rest:tea", targetLoc: "rest" });
    expect(targetOf("toggleAvail", {}, { loc: "coffee", it: "juice" }, null)).toEqual({ target: "coffee:juice", targetLoc: "coffee" });
    expect(targetOf("updatePoLine", { id: "PO-2026-0102", n: 0 }, { qty: 4 }, null)).toEqual({ target: "PO-2026-0102#0", targetLoc: "" });
    expect(targetOf("removePoLine", { id: "PO-2026-0102", n: "1" }, undefined, null)).toEqual({ target: "PO-2026-0102#1", targetLoc: "" });
  });

  it("says nothing rather than something wrong when a refusal left only half the request", () => {
    expect(targetOf("addMenuItem", { loc: "rest" }, "not json", null)).toEqual({ target: "rest", targetLoc: "rest" });
    expect(targetOf("createRequest", {}, null, null)).toEqual({ target: "", targetLoc: "" });
    expect(targetOf("cancelTicket", { id: { nested: true } }, null, null)).toEqual({ target: "", targetLoc: "" });
  });
});

describe("actorOf", () => {
  it("keeps the account as it stands: number, name, role label and location", async () => {
    expect(await actorOf(t.db, "u1")).toEqual({ id: "u1", emp: "RC-4471", name: "Kavitha Raman", role: "Counter Operator", loc: "coffee" });
  });
  it("calls the super admin what the wire calls it, and puts it at no desk", async () => {
    expect(await actorOf(t.db, "u7")).toEqual({ id: "u7", emp: "RC-0001", name: "System Administrator", role: "Super Admin", loc: "" });
  });
  it("keeps what the caller typed when there is no account behind it, capped at 64", async () => {
    expect(await actorOf(t.db, null, "RC-9999")).toEqual({ id: null, emp: "RC-9999", name: "", role: "", loc: "" });
    expect((await actorOf(t.db, null, "x".repeat(80))).emp).toHaveLength(64);
    expect(await actorOf(t.db, null)).toEqual({ id: null, emp: "", name: "", role: "", loc: "" });
  });
  it("keeps the id of an account deleted while its token was still live", async () => {
    expect(await actorOf(t.db, "u404")).toEqual({ id: "u404", emp: "", name: "", role: "", loc: "" });
  });
});

describe("insertAuditEvent", () => {
  it("stores the event and wakes the drainer once the transaction commits", async () => {
    heard = [];
    const before = (await rows()).length;
    const e = event();
    await t.db.transaction(async (tx) => { await insertAuditEvent(tx, e); });
    await settle();
    const after = await rows();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)!.event).toEqual(e);
    expect(after.at(-1)!.at.toISOString()).toBe(e.at);
    expect(heard).toEqual([t.schemaName]);
  });

  it("stores nothing and wakes nobody when the transaction rolls back", async () => {
    heard = [];
    const before = (await rows()).length;
    await expect(t.db.transaction(async (tx) => {
      await insertAuditEvent(tx, event({ requestId: "req-rolled-back" }));
      throw new Error("the rule refused");
    })).rejects.toThrow("the rule refused");
    await settle();
    expect(await rows()).toHaveLength(before);
    expect(heard).toEqual([]);
  });

  it("stores on the pool too, for an event no transaction carries", async () => {
    heard = [];
    await insertAuditEvent(t.db, event({ outcome: "refused", status: 422, message: "Refused - printed MRP of ₹20 is a hard ceiling for Real Juice 200ml", result: null, changed: [] }));
    await settle();
    expect((await rows()).at(-1)!.event).toMatchObject({ outcome: "refused", status: 422, result: null });
    expect(heard).toHaveLength(1);
  });

  it("is refused at the database if anything tries to rewrite a stored event", async () => {
    await insertAuditEvent(t.db, event({ requestId: "req-kept-as-written" }));
    const refusal = await t.db.execute(sql`update audit_outbox set event = '{}'::jsonb`).then(
      () => "it was allowed",
      (e: { cause?: Error }) => String(e.cause?.message),
    );
    expect(refusal).toBe("audit_outbox rows are never updated; the audit service moves each one as it was written");
  });

  it("refuses an event the drainer would dead-letter, before anything is written", async () => {
    const before = (await rows()).length;
    await expect(insertAuditEvent(t.db, event({ action: "" }))).rejects.toThrow();
    await expect(insertAuditEvent(t.db, event({ at: "14-Sep-2026 10:30" }))).rejects.toThrow();
    expect(await rows()).toHaveLength(before);
  });
});

describe("recordAuthEvent", () => {
  /** What Fastify hands the auth routes, cut down to what an event reads. */
  const request = (body: unknown): FastifyRequest => ({
    id: "req-auth-1", ip: "10.0.0.7", method: "POST", url: "/api/v1/auth/login", routeOptions: { url: "/api/v1/auth/login" },
    headers: { "user-agent": "vitest" }, params: {}, query: {}, body,
  }) as unknown as FastifyRequest;

  it("stores a refused sign-in with the number that was typed, and never the body it came in", async () => {
    await recordAuthEvent(t.db, request({ emp: "RC-9999", password: "hunter2222" }), {
      action: "login", outcome: "refused", status: 401, message: "That employee id and password do not match.", cause: "no such employee", actorId: null, typedEmp: "RC-9999",
    });
    const stored = (await rows()).at(-1)!.event;
    expect(stored).toEqual({
      at: expect.any(String), requestId: "req-auth-1",
      actor: { id: null, emp: "RC-9999", name: "", role: "", loc: "" },
      action: "login", method: "POST", path: "/auth/login", target: "", targetLoc: "",
      outcome: "refused", status: 401, message: "That employee id and password do not match.", cause: "no such employee",
      request: { params: {}, query: {} }, before: null, result: null, changed: [], ip: "10.0.0.7", userAgent: "vitest",
    });
    expect(JSON.stringify(stored)).not.toContain("hunter2222");
  });

  it("stores the request the auth module names instead, masked, against the account", async () => {
    await recordAuthEvent(t.db, request({}), {
      action: "login", outcome: "done", status: 200, message: "Signed in", actorId: "u1", request: { body: { emp: "RC-4471", password: "changeme" } },
    });
    expect((await rows()).at(-1)!.event).toMatchObject({
      actor: { id: "u1", emp: "RC-4471", name: "Kavitha Raman" }, outcome: "done", cause: null,
      request: { body: { emp: "RC-4471", password: MASK } },
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rch/api exec vitest run src/lib/audit.test.ts`
Expected: FAIL. The file doesn't load, with `Failed to resolve import "./audit.js" from "src/lib/audit.test.ts"`, because `lib/audit.ts` does not exist yet.

- [ ] **Step 3: Add the Drizzle table**

Append to the end of `apps/api/src/db/schema/infra.ts`. `bigint`, `jsonb`, `pgTable` and `ts` are already imported there.

```ts
/**
 * The audit trail's hand-off. The API adds one row per audited action - inside the write's own
 * transaction for a write that succeeded (`lib/audit.ts`) - and the audit service (`apps/audit`)
 * moves each row into its own append-only schema and removes it from here. Nothing in the API
 * reads a row back: in production its database role holds INSERT on this table and nothing else,
 * and `scripts/check-boundaries.sh` holds the insert to `lib/audit.ts`.
 */
export const auditOutbox = pgTable("audit_outbox", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  at: ts("at").notNull().defaultNow(),
  event: jsonb("event").notNull(),
});
```

- [ ] **Step 4: Generate the migration and add the trigger**

Run: `pnpm --filter @rch/api db:generate --name audit_outbox`
Expected: `[✓] Your SQL migration file ➜ drizzle/0016_audit_outbox.sql`, plus a new `drizzle/meta/0016_snapshot.json` and a `_journal.json` entry with `"idx": 16`, `"tag": "0016_audit_outbox"` and a `"when"` of the current `Date.now()`, larger than `0015_drop_recipes`'s. The generated SQL is exactly the `CREATE TABLE` statement below. If anything else appears, that is drift from an earlier migration: stop and report it, and don't commit it.

Append the trigger by hand, so that `apps/api/drizzle/0016_audit_outbox.sql` reads in full:

```sql
CREATE TABLE "audit_outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" jsonb NOT NULL
);
--> statement-breakpoint
-- Hand-written below: drizzle-kit cannot see a trigger. The API only inserts and the audit service
-- only locks and deletes (it holds `update (at)` solely so `for update skip locked` can take a row
-- lock, and a row lock fires no trigger), so nobody ever has a reason to rewrite an event in place.
CREATE OR REPLACE FUNCTION audit_outbox_no_update() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'audit_outbox rows are never updated; the audit service moves each one as it was written';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_outbox_no_update BEFORE UPDATE ON audit_outbox FOR EACH ROW EXECUTE FUNCTION audit_outbox_no_update();
```

Run: `pnpm --filter @rch/api db:generate`
Expected: `No schema changes, nothing to migrate 😴`

- [ ] **Step 5: Implement `lib/audit.ts`**

Create `apps/api/src/lib/audit.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { API_PREFIX, AuditEventSchema, type AuditActor, type AuditEvent, type AuditOutcome } from "@rch/contract";
import type { Db } from "../db/client.js";
import { auditOutbox, users } from "../db/schema/index.js";
import type { Reader, Tx } from "./db.js";
import { roleLabelOf } from "./wire.js";

/**
 * The API's half of the audit trail: every event the API emits is built here and stored here, and
 * `scripts/check-boundaries.sh` holds the insert to this one file.
 *
 * The API only ever adds to `audit_outbox`. The audit service (`apps/audit`) moves each row into its
 * own append-only schema and removes it; nothing in this process reads the outbox back, and in
 * production its database role could not if it tried.
 */

/**
 * The NOTIFY channel that wakes the drainer. Its payload is the schema the outbox row went into
 * (`public` in production): a channel belongs to the database, every test file owns a schema, and
 * the payload is how a listener tells its own outbox's notices from another file's.
 */
export const AUDIT_OUTBOX_CHANNEL = "rch_audit_outbox";

/** What a secret reads as once masked. */
export const MASK = "••••";

/**
 * The keys whose values are never stored, matched by exact name: `password`/`newPassword`/
 * `currentPassword` (any password field), `tempPassword` (the account create and reset responses,
 * `schemas/admin.ts`), `otp` (a handover's body and every ticket), and the token and secret names.
 *
 * A name list rather than a pattern. A pattern that caught every password also caught
 * `mustChangePassword`, the one field a password reset visibly changes, and hid it from the
 * before → after. `current` and `next` - the change-password body - are deliberately absent: they
 * are ordinary words elsewhere, and that request is recorded by the auth module with `request: {}`.
 */
export const SECRET_KEYS: ReadonlySet<string> = new Set(["password", "newPassword", "currentPassword", "tempPassword", "otp", "token", "accessToken", "refreshToken", "secret"]);

/** A copy of any JSON value with the value of every `SECRET_KEYS` key replaced by `MASK`, at any
 *  depth. Applied to what was sent, what came back and what stood before, so a password, a
 *  temporary password or a handover code is never stored - the outcome is. */
export function maskSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v: unknown) => maskSecrets(v)) as T;
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.has(k) ? MASK : maskSecrets(v)])) as T;
}

/** A field of something the request or the response carried, as text when it is text or a number
 *  (`n`, a PO line, arrives coerced). Anything else - absent, nested, a refusal's raw body - is
 *  `undefined`, so a target is never "[object Object]". */
const text = (o: unknown, key: string): string | undefined => {
  if (o === null || typeof o !== "object") return undefined;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
};
const joined = (sep: string, ...parts: Array<string | undefined>): string =>
  parts.filter((p): p is string => p !== undefined && p !== "").join(sep);

/**
 * What an event is about, and where. Most writes name one document - by its id, a bill by its
 * number, an item by its key - in the path or, for a create, in the result. Four kinds name a cell
 * rather than a row, and one field alone would be ambiguous there: a price is a list and an item, a
 * menu listing and an availability switch are a location and an item, and a PO line is an order
 * and a line number.
 *
 * The location is the one the request names - `loc`, or a transfer's `from` - else the one the
 * result carries: `loc`, or the `from` a stock request, a ticket or a shop ask records.
 */
export function targetOf(action: string, params: unknown, body: unknown, result: unknown): { target: string; targetLoc: string } {
  const targetLoc = text(params, "loc") ?? text(body, "loc") ?? text(body, "from") ?? text(result, "loc") ?? text(result, "from") ?? "";
  switch (action) {
    case "savePrice":
      return { target: joined(":", text(params, "list"), text(params, "it")), targetLoc };
    case "addMenuItem":
    case "removeMenuItem":
      return { target: joined(":", text(params, "loc"), text(params, "it") ?? text(body, "it")), targetLoc };
    case "toggleAvail":
      return { target: joined(":", text(body, "loc"), text(body, "it")), targetLoc };
    case "updatePoLine":
    case "removePoLine":
      return { target: joined("#", text(params, "id"), text(params, "n")), targetLoc };
    default:
      return {
        target: text(params, "id") ?? text(params, "no") ?? text(params, "it") ?? text(result, "id") ?? text(result, "no") ?? text(result, "key") ?? "",
        targetLoc,
      };
  }
}

/**
 * Who acted, as they stood at that moment: the event keeps the number, name, role label and
 * location rather than a reference, so it still reads after the account is renamed, moved or
 * deleted. One primary-key read.
 *
 * - No user (a sign-in for a number nobody holds): `id` null and, where one was typed, the employee
 *   number the caller gave, capped at 64.
 * - A user id with no row (deleted while its token was still live): the id alone.
 * - The super admin: `Super Admin` and no location - its `role`/`loc` columns are placeholders
 *   nothing acts on (`lib/wire.ts`), and printing one would put it at a desk it never sits at.
 */
export async function actorOf(db: Reader, userId: string | null, typedEmp = ""): Promise<AuditActor> {
  const emp = typedEmp.slice(0, 64);
  if (userId === null) return { id: null, emp, name: "", role: "", loc: "" };
  const [u] = await db
    .select({ empNo: users.empNo, name: users.name, roleLabel: users.roleLabel, admin: users.admin, loc: users.loc })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) return { id: userId, emp, name: "", role: "", loc: "" };
  return { id: userId, emp: u.empNo, name: u.name, role: roleLabelOf(u), loc: u.admin ? "" : u.loc };
}

/**
 * Store one event and wake the drainer.
 *
 * The event is parsed with the same `AuditEventSchema` the drainer parses it with, in every
 * environment. An event the drainer would dead-letter is a bug in the code that built it, and here
 * it surfaces at its source: inside a write's transaction it takes the write down (a write that
 * cannot be audited does not commit), and on the pool `plugins/audit.ts` logs it. The schema holds
 * the request, result and before values as `unknown`, so the parse walks none of them.
 *
 * On a transaction, Postgres holds the NOTIFY until COMMIT, so a write that rolls back wakes nobody.
 */
export async function insertAuditEvent(db: Db | Tx, event: AuditEvent): Promise<void> {
  const parsed = AuditEventSchema.parse(event);
  await db.insert(auditOutbox).values({ at: new Date(parsed.at), event: parsed });
  await db.execute(sql`select pg_notify(${AUDIT_OUTBOX_CHANNEL}, current_schema())`);
}

/** The browser's own description of itself, capped: it is stored forever and only ever read as a device. */
const userAgentOf = (headers: Record<string, string | string[] | undefined>): string => {
  const ua = headers["user-agent"];
  return (Array.isArray(ua) ? ua[0] ?? "" : ua ?? "").slice(0, 512);
};

/**
 * A sign-in, sign-out or password change. The auth routes are public or `write: false`, so `mount()`
 * never audits them and `modules/auth` records each one itself.
 *
 * No password is ever passed in. `request`, when given, is stored (masked) as what was sent; left
 * out, the event keeps the path's params and query and never the body, because the change-password
 * body's `current` and `next` are not `SECRET_KEYS`.
 */
export type AuthEvent = {
  action: "login" | "logout" | "changePassword"; outcome: AuditOutcome; status: number; message: string;
  cause?: string | null; actorId: string | null; typedEmp?: string; request?: unknown;
};

export async function recordAuthEvent(db: Db, req: FastifyRequest, e: AuthEvent): Promise<void> {
  const url = req.routeOptions.url ?? req.url;
  await insertAuditEvent(db, {
    at: new Date().toISOString(), requestId: req.id,
    actor: await actorOf(db, e.actorId, e.typedEmp),
    action: e.action, method: req.method, path: url.startsWith(API_PREFIX) ? url.slice(API_PREFIX.length) : url,
    target: "", targetLoc: "",
    outcome: e.outcome, status: e.status, message: e.message, cause: e.cause ?? null,
    request: maskSecrets(e.request ?? { params: req.params ?? {}, query: req.query ?? {} }),
    before: null, result: null, changed: [],
    ip: req.ip, userAgent: userAgentOf(req.headers),
  });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @rch/api exec vitest run src/lib/audit.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 7: Empty the outbox with the other document tables between cases**

In `apps/api/src/test/db.ts`, `resetDocuments`, replace

```ts
    "document_history", "idempotency_keys",
    // ---- adjustments
```

with

```ts
    "document_history", "idempotency_keys",
    // ---- audit log: every write now leaves an event, and a case counting them must not see the last case's
    "audit_outbox",
    // ---- adjustments
```

- [ ] **Step 8: Prove the boundary rule is missing, then add it**

Create a throwaway probe, `apps/api/src/plugins/zz-outbox-probe.ts`:

```ts
const rows = await db.select().from(auditOutbox);
await tx.execute(sql`insert into audit_outbox (event) values (${e})`);
```

Run: `pnpm check:boundaries`
Expected: `boundaries OK`. That is the gap: nothing stops the probe yet.

In `scripts/check-boundaries.sh`, insert this block immediately before the final `if [ "$fail" != "0" ]; then`, after the module-skeleton `done`:

```bash
# ---------------------------------------------------------------------------
# 4) The audit outbox. apps/api adds events to audit_outbox and never touches one again: the
#    audit service moves each row into its own append-only schema, and a process that could
#    read, rewrite or remove its own trail would not be leaving one. So outside test files only
#    apps/api/src/lib/audit.ts inserts into it, and nothing outside a test file or src/test/
#    selects, joins, updates, deletes or truncates it (lib/roles.test.ts proves the runtime role
#    can do the first and none of the rest, so it has to spell them out). The runtime role (rch_app, INSERT only) enforces the same in production; this keeps it
#    visible in review. Same shapes as check 1 and the same line-by-line caveat: a comment that
#    says "from audit_outbox" trips it.
# ---------------------------------------------------------------------------
echo "== audit outbox: inserted only from lib/audit.ts, never read back =="

outbox_insert_orm='insert[[:space:]]*\([[:space:]]*'"$qualifier"'auditOutbox[[:space:]]*\)'
# shellcheck disable=SC2016  # the trailing `$` is grep's end-of-line anchor, not a shell expansion
outbox_insert_sql='(insert|merge)[[:space:]]+into[[:space:]]+["`]?([A-Za-z_][A-Za-z0-9_]*["`]?[[:space:]]*\.[[:space:]]*["`]?)?audit_outbox([^A-Za-z0-9_]|$)'
outbox_insert_hits="$(grep -rn -i -E "$outbox_insert_orm|$outbox_insert_sql" apps/api/src --include="*.ts" | grep -v -E '^apps/api/src/lib/audit\.ts:|\.test\.ts:' || true)"
if [ -n "$outbox_insert_hits" ]; then
  fail_with "audit_outbox is inserted into outside apps/api/src/lib/audit.ts or a test file:"
  echo "$outbox_insert_hits" >&2
fi

outbox_touch_orm='(from|update|delete)[[:space:]]*\([[:space:]]*'"$qualifier"'auditOutbox[[:space:]]*\)'
# shellcheck disable=SC2016  # as above: `$` anchors, it does not expand
outbox_touch_sql='(from|join|update|truncate)[[:space:]]+(table[[:space:]]+)?["`]?([A-Za-z_][A-Za-z0-9_]*["`]?[[:space:]]*\.[[:space:]]*["`]?)?audit_outbox([^A-Za-z0-9_]|$)'
outbox_touch_hits="$(grep -rn -i -E "$outbox_touch_orm|$outbox_touch_sql" apps/api/src --include="*.ts" | grep -v -E '\.test\.ts:|^apps/api/src/test/' || true)"
if [ -n "$outbox_touch_hits" ]; then
  fail_with "audit_outbox is read, updated or deleted in apps/api/src outside a test - the API only ever inserts into it:"
  echo "$outbox_touch_hits" >&2
fi
```

Run: `pnpm check:boundaries`
Expected: exit 1, with both lines of the probe reported:
`boundary check failed: audit_outbox is inserted into outside apps/api/src/lib/audit.ts or a test file:` … `zz-outbox-probe.ts:2:` and `boundary check failed: audit_outbox is read, updated or deleted in apps/api/src outside a test - the API only ever inserts into it:` … `zz-outbox-probe.ts:1:`

Delete the probe: `rm /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/plugins/zz-outbox-probe.ts`

Run: `pnpm check:boundaries`
Expected: `boundaries OK`

- [ ] **Step 9: Run the package gates**

Run: `pnpm --filter @rch/api typecheck && pnpm --filter @rch/api lint && pnpm --filter @rch/api test`
Expected: PASS, with coverage at or above lines 94 / branches 79. The migration adds no API behaviour beyond this file, so no other test changes.

- [ ] **Step 10: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add apps/api/drizzle/0016_audit_outbox.sql apps/api/drizzle/meta/0016_snapshot.json apps/api/drizzle/meta/_journal.json apps/api/src/db/schema/infra.ts apps/api/src/lib/audit.ts apps/api/src/lib/audit.test.ts apps/api/src/test/db.ts scripts/check-boundaries.sh
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Add the audit outbox and the code that builds and stores an audit event

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

### Task 3: API: done events from `mount()` / `withTransaction`

**Files:**
- Create: `apps/api/src/modules/audit-capture.test.ts`
- Modify: `apps/api/src/lib/audit.ts` (the import block at the top; new code appended at the end)
- Modify: `apps/api/src/lib/idempotency-record.ts` (`RecordOutcome`, line 20; the final `return` of `recordIdempotent`, line 61)
- Modify: `apps/api/src/plugins/idempotency.ts` (imports, lines 7-8; `IdemContext` and its doc comment, lines 32-35)
- Modify: `apps/api/src/lib/db.ts` (imports, lines 1-3; `withTransaction` and the tail of its doc comment, lines 51-75)
- Modify: `apps/api/src/routes.ts` (imports and the `FastifyContextConfig` declaration, lines 3-9; `mount()`'s doc tail and opening, lines 34-46; the `app.route` config/handler, lines 78-79)
- Test: `apps/api/src/modules/audit-capture.test.ts`

**Interfaces:**
- Consumes: `maskSecrets`, `targetOf`, `actorOf`, `insertAuditEvent` (Task 2); `routes`, `serviceOf`, `AUDIT_LABELS`, `AuditEventSchema`, `CollectionSchema`, `Changed`, `AuditOutcome` (Task 1).
- Produces: `AuditRequestContext`, `req.audit`, `IdemContext.audit`, `auditContextOf`, `writeOutcomeOf`, `auditEventOf`, `recordAudit`, `auditBefore` (`lib/audit.ts`); `RecordOutcome` `{ ok: true; body }`; `mountedWrites` and route config `audit` (`routes.ts`); one committed `done` event per successful non-public write.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/audit-capture.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { asc, desc, eq, gt, sql } from "drizzle-orm";
import { AUDIT_LABELS, AuditEventSchema, defineRoute, OkResponseSchema, routes, serviceOf, type AuditEvent } from "@rch/contract";
import { buildApp, type App } from "../app.js";
import { auditOutbox, bills, stockMoves, users } from "../db/schema/index.js";
import { MASK, auditBefore } from "../lib/audit.js";
import { withTransaction } from "../lib/db.js";
import { RuleError } from "../lib/errors.js";
import type { LogStream } from "../plugins/logging.js";
import { mount, mountedWrites } from "../routes.js";
import { buildTestApp, testConfig } from "../test/app.js";
import { authHeaders } from "../test/auth.js";
import { given } from "../test/builders.js";
import { seedTestDb } from "../test/seed.js";
import { meRepo } from "./me/repo.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "audit_capture" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

/** A browser's own string, so the event's `userAgent` is provably the request's and not inject's default. */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

type Method = "POST" | "PUT" | "PATCH" | "DELETE";
/** A signed-in write with a fresh Idempotency-Key unless the case names one. Two inject calls
 *  rather than a spread payload, for the overload reason `tickets.test.ts` gives. */
const write = async (user: string, method: Method, url: string, payload?: object, key: string = randomUUID(), on: App = app) => {
  const headers = { ...(await authHeaders(on, user)), "idempotency-key": key, "user-agent": UA };
  return payload === undefined
    ? on.inject({ method, url: `/api/v1${url}`, headers })
    : on.inject({ method, url: `/api/v1${url}`, headers, payload });
};

/** The newest outbox id, so a case reads only the events it caused. `sequences` style: never a literal. */
const lastId = async (): Promise<number> =>
  (await app.db.select({ id: auditOutbox.id }).from(auditOutbox).orderBy(desc(auditOutbox.id)).limit(1))[0]?.id ?? 0;
/** Every event stored after `mark`, oldest first, each parsed exactly as the drainer will parse it. */
const eventsSince = async (mark: number): Promise<AuditEvent[]> =>
  (await app.db.select().from(auditOutbox).where(gt(auditOutbox.id, mark)).orderBy(asc(auditOutbox.id))).map((r) => AuditEventSchema.parse(r.event));

const countRows = async (table: typeof bills | typeof stockMoves): Promise<number> => (await app.db.select().from(table)).length;
const phoneOf = async (id: string) => (await app.db.select().from(users).where(eq(users.id, id)))[0].phone;

/** An app of its own carrying a test-only write, mounted through the real `mount()` and sharing
 *  this file's schema - the `plugins/idempotency.test.ts` device. */
async function appWith(register: (a: App) => void, env: Partial<NodeJS.ProcessEnv> = {}, logStream?: LogStream): Promise<App> {
  const a = await buildApp(testConfig(env), { db: app.db, migrationsSchema: app.testDb!.schemaName, logStream });
  register(a);
  await a.ready();
  return a;
}

describe("every write the API serves is audited", () => {
  it("mounts each non-public API write in the manifest, and each has a label", () => {
    const writes = Object.entries(routes)
      .filter(([, r]) => serviceOf(r) === "api" && r.access !== "public" && (r.write ?? r.method !== "GET"))
      .map(([name]) => name)
      .sort();
    expect([...mountedWrites].sort()).toEqual(writes);
    for (const name of writes) expect(AUDIT_LABELS, name).toHaveProperty(name);
  });

  it("refuses to mount a route the audit service serves", () => {
    const audit = Object.values(routes).find((r) => serviceOf(r) === "audit");
    expect(audit).toBeDefined();
    expect(() => mount(app, audit!, async () => ({}) as never)).toThrow(/served by the audit service, not the API/);
  });
});

describe("a write that succeeds leaves exactly one done event", () => {
  it("a counter sale: the operator as they stand, the bill, its outlet and the sentence", async () => {
    const mark = await lastId();
    const body = { loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }] };
    const r = await write("u1", "POST", "/bills", body);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(await eventsSince(mark)).toEqual([{
      at: expect.any(String), requestId: r.headers["x-request-id"],
      actor: { id: "u1", emp: "RC-4471", name: "Kavitha Raman", role: "Counter Operator", loc: "coffee" },
      action: "pay", method: "POST", path: "/bills", target: b.result.no, targetLoc: "coffee",
      outcome: "done", status: 200, message: b.message, cause: null,
      request: { params: {}, query: {}, body },
      before: null, result: b.result, changed: ["stock", "bills"],
      ip: "127.0.0.1", userAgent: UA,
    }]);
  });

  it("a manager's price edit: the list and item as one target", async () => {
    const mark = await lastId();
    const r = await write("u2", "PUT", "/prices/A/juice", { price: 19 });
    expect(r.statusCode, r.body).toBe(200);
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({
      actor: { id: "u2", emp: "RC-3120", name: "Ramesh Kumar", role: "Outlet Manager", loc: "rest" },
      action: "savePrice", method: "PUT", path: "/prices/:list/:it", target: "A:juice", targetLoc: "",
      outcome: "done", status: 200, message: "Real Juice 200ml priced at ₹19 on list A", changed: ["prices"],
      request: { params: { list: "A", it: "juice" }, query: {}, body: { price: 19 } },
      result: { list: "A", it: "juice", price: 19 },
    });
  });

  it("a manager's approval: the request it decided", async () => {
    const mark = await lastId();
    const r = await write("u2", "POST", "/requests/REQ-2026-0911/approve", { appr: [4], note: "Four today" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({
      actor: { id: "u2", role: "Outlet Manager" }, action: "approveRequest", path: "/requests/:id/approve",
      target: "REQ-2026-0911", outcome: "done", message: b.message, changed: b.changed, result: b.result,
    });
  });

  it("an admin's account create: the new account, with its temporary password masked", async () => {
    const mark = await lastId();
    const r = await write("u7", "POST", "/admin/users", { name: "Anitha R", email: "anitha.r@royalcare.in", role: "counter", loc: "rest" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({
      actor: { id: "u7", emp: "RC-0001", name: "System Administrator", role: "Super Admin", loc: "" },
      action: "createAdminUser", target: b.result.id, targetLoc: "rest", outcome: "done", message: b.message, changed: ["accounts"],
    });
    expect(e.result).toEqual({ ...b.result, tempPassword: MASK });
    expect(JSON.stringify(e)).not.toContain(b.result.tempPassword);
  });

  it("an account's own edit: `PATCH /me` answers with no result key, so the whole answer is the result", async () => {
    const mark = await lastId();
    const r = await write("u6", "PATCH", "/me", { ph: "90000 00006" });
    expect(r.statusCode, r.body).toBe(200);
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({ action: "patchMe", target: "", message: "", changed: [], actor: { id: "u6" } });
    expect(e.result).toEqual(r.json());
  });

  it("a handover: the ticket and where it left from, and never the code that was quoted", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "box", qty: 10 }], otp: "123456" });
    const mark = await lastId();
    const r = await write("u3", "POST", `/tickets/${id}/handover`, { otp: "123456" });
    expect(r.statusCode, r.body).toBe(200);
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({ action: "handover", target: id, targetLoc: "store", outcome: "done", request: { body: { otp: MASK } }, result: { otp: MASK } });
    expect(JSON.stringify(e)).not.toContain("123456");
  });
});

describe("an edit's before value", () => {
  it("rides with the done event, masked, the last call winning", async () => {
    const route = defineRoute({ method: "POST", path: "/__test/audit-before", access: "any", response: OkResponseSchema });
    const a = await appWith((x) => mount(x, route, async () => withTransaction(app.db, async (tx) => {
      auditBefore({ ph: "not this one" });
      auditBefore({ ph: await phoneOf("u1"), tempPassword: "Temp-5555" });
      await meRepo.update(tx, "u1", { phone: "74000 00007" });
      return { ok: true as const };
    })));
    try {
      const before = await phoneOf("u1");
      const mark = await lastId();
      const r = await write("u1", "POST", "/__test/audit-before", undefined, randomUUID(), a);
      expect(r.statusCode, r.body).toBe(200);
      const [e, ...more] = await eventsSince(mark);
      expect(more).toEqual([]);
      expect(e.before).toEqual({ ph: before, tempPassword: MASK });
    } finally {
      await a.close();
    }
  });

  it("is nothing to keep outside a write request", () => {
    expect(() => auditBefore({ ph: "12345 67890" })).not.toThrow();
  });
});

describe("the event commits with the write or not at all", () => {
  it("a write whose event cannot be stored does not commit", async () => {
    const mark = await lastId();
    const billsBefore = await countRows(bills);
    const movesBefore = await countRows(stockMoves);
    // NOT VALID: the rows already there stand, and every new one is refused.
    await app.db.execute(sql.raw("alter table audit_outbox add constraint audit_outbox_refuse_ck check (false) not valid"));
    try {
      const r = await write("u1", "POST", "/bills", { loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }] });
      expect(r.statusCode).toBe(500);
      expect(await countRows(bills)).toBe(billsBefore);
      expect(await countRows(stockMoves)).toBe(movesBefore);
    } finally {
      await app.db.execute(sql.raw("alter table audit_outbox drop constraint audit_outbox_refuse_ck"));
    }
    expect(await eventsSince(mark)).toEqual([]);
  });

  it("a write whose transaction throws after its changes leaves no done event", async () => {
    const route = defineRoute({ method: "POST", path: "/__test/audit-late-refusal", access: "any", response: OkResponseSchema });
    const a = await appWith((x) => mount(x, route, async () => withTransaction(app.db, async (tx) => {
      await meRepo.update(tx, "u1", { phone: "70000 00007" });
      throw new RuleError("Refused - staged after the change");
    })));
    try {
      const mark = await lastId();
      const phone = await phoneOf("u1");
      const r = await write("u1", "POST", "/__test/audit-late-refusal", undefined, randomUUID(), a);
      expect(r.statusCode).toBe(422);
      expect(await phoneOf("u1")).toBe(phone);
      expect((await eventsSince(mark)).filter((e) => e.outcome === "done")).toEqual([]);
    } finally {
      await a.close();
    }
  });

  it("a write that opens several transactions leaves one event, from the transaction that recorded its answer", async () => {
    const route = defineRoute({ method: "POST", path: "/__test/audit-multi", access: "any", response: OkResponseSchema });
    const a = await appWith((x) => mount(x, route, async () => {
      // Commits a change and is not the answer - the shape `tickets.handover` takes for a wrong code.
      await withTransaction(app.db, async (tx) => { await meRepo.update(tx, "u1", { phone: "71000 00007" }); return { counted: true }; }, { response: "optional" });
      // The answer: recorded, and audited, here.
      const answer = await withTransaction(app.db, async (tx) => { await meRepo.update(tx, "u1", { phone: "72000 00007" }); return { ok: true as const }; });
      // After the answer: nothing left to record.
      await withTransaction(app.db, async (tx) => { await meRepo.update(tx, "u1", { phone: "73000 00007" }); return null; });
      return answer;
    }));
    try {
      const mark = await lastId();
      const r = await write("u1", "POST", "/__test/audit-multi", undefined, randomUUID(), a);
      expect(r.statusCode, r.body).toBe(200);
      const events = await eventsSince(mark);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: "POST /__test/audit-multi", outcome: "done", status: 200, result: { ok: true }, message: "", changed: [], actor: { id: "u1" } });
    } finally {
      await a.close();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rch/api exec vitest run src/modules/audit-capture.test.ts`
Expected: FAIL. The file doesn't load, with `SyntaxError: The requested module '../routes.js' does not provide an export named 'mountedWrites'` (or the same for `'../lib/audit.js'` and `auditBefore`).

- [ ] **Step 3: Let the idempotency record hand back what it stored**

In `apps/api/src/lib/idempotency-record.ts`, replace

```ts
/** `{ ok: true }`, or why the response is not in the claim row - a sentence a log line or a
 *  thrown error can carry as it stands. */
export type RecordOutcome = { ok: true } | { ok: false; why: string };
```

with

```ts
/** `{ ok: true }` with the response as its schema parsed it (what was stored, and what the audit
 *  event carries), or why the response is not in the claim row - a sentence a log line or a
 *  thrown error can carry as it stands. */
export type RecordOutcome = { ok: true; body: unknown } | { ok: false; why: string };
```

and replace the last lines of `recordIdempotent`

```ts
  return { ok: true };
}
```

with

```ts
  return { ok: true, body };
}
```

- [ ] **Step 4: Give the idempotency context its audit half**

In `apps/api/src/plugins/idempotency.ts`, replace

```ts
import type { Db } from "../db/client.js";
import { idempotencyKeys } from "../db/schema/index.js";
```

with

```ts
import type { Db } from "../db/client.js";
import { idempotencyKeys } from "../db/schema/index.js";
import type { AuditRequestContext } from "../lib/audit.js";
```

and replace

```ts
 * `why` is how the production path stays diagnosable: `withTransaction` leaves the reason the
 * record did not happen here, and `mount()` logs it beside the route and the key.
 */
export type IdemContext = { idem: NonNullable<FastifyRequest["idem"]>; response: z.ZodTypeAny; strict: boolean; why?: string };
```

with

```ts
 * `why` is how the production path stays diagnosable: `withTransaction` leaves the reason the
 * record did not happen here, and `mount()` logs it beside the route and the key.
 *
 * `audit` is the request as the audit trail reads it (`lib/audit.ts`): the transaction that records
 * the outcome stores the write's `done` event from it, in the same COMMIT.
 */
export type IdemContext = { idem: NonNullable<FastifyRequest["idem"]>; response: z.ZodTypeAny; strict: boolean; why?: string; audit: AuditRequestContext };
```

- [ ] **Step 5: Build, mask and record the done event in `lib/audit.ts`**

In `apps/api/src/lib/audit.ts`, replace the import block

```ts
import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { API_PREFIX, AuditEventSchema, type AuditActor, type AuditEvent, type AuditOutcome } from "@rch/contract";
import type { Db } from "../db/client.js";
import { auditOutbox, users } from "../db/schema/index.js";
import type { Reader, Tx } from "./db.js";
import { roleLabelOf } from "./wire.js";
```

with

```ts
import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { API_PREFIX, AuditEventSchema, CollectionSchema, type AuditActor, type AuditEvent, type AuditOutcome, type Changed } from "@rch/contract";
import type { Db } from "../db/client.js";
import { auditOutbox, users } from "../db/schema/index.js";
import { idemStore, type IdemContext } from "../plugins/idempotency.js";
import type { Reader, Tx } from "./db.js";
import { roleLabelOf } from "./wire.js";
```

and append to the end of the file:

```ts
/**
 * What `mount()` knows about a non-public write before its handler runs. The same object is
 * `req.audit` and the write's `IdemContext.audit`, handed to `idemStore` by reference, so the
 * transaction that records the write (`lib/db.ts`) and the hook that records a refusal
 * (`plugins/audit.ts`) read one account of the request.
 *
 * `pending` is set inside the transaction that inserted the write's `done` event and cleared once
 * that transaction settles; `recorded` is set only when it committed. A request whose event was
 * inserted but whose COMMIT then failed is therefore not `recorded`, and the hook stores its error event.
 */
export type AuditRequestContext = {
  action: string; method: string; path: string;
  requestId: string; ip: string; userAgent: string;
  params: unknown; query: unknown; body: unknown;
  actorId: string | null;
  before: unknown | null;
  pending: boolean;
  recorded: boolean;
};
declare module "fastify" { interface FastifyRequest { audit?: AuditRequestContext } }

/** The parts of a request an audit context is read from - a structural type, so `mount()`'s
 *  route-typed `Req<R>` and the hook's plain `FastifyRequest` both fit without a cast. */
type AuditedRequest = {
  id: string; ip: string; headers: Record<string, string | string[] | undefined>;
  params: unknown; query: unknown; body: unknown;
  user?: { sub: string } | null;
};

/** A fresh context for one request. `user` is null until a token has been verified (`@fastify/jwt`
 *  decorates it so), which is what leaves a refusal before sign-in without an actor. */
export function auditContextOf(req: AuditedRequest, route: { action: string; method: string; path: string }): AuditRequestContext {
  return {
    action: route.action, method: route.method, path: route.path,
    requestId: req.id, ip: req.ip, userAgent: userAgentOf(req.headers),
    params: req.params ?? {}, query: req.query ?? {}, body: req.body ?? null,
    actorId: req.user?.sub ?? null,
    before: null, pending: false, recorded: false,
  };
}

/** A reply read as a write's `{ result, changed, message }`. A response of another shape (`PATCH
 *  /me` answers with the account itself) is all result, with no sentence and nothing changed; a
 *  collection this build does not know is dropped, since the fallback path reads bytes nobody
 *  parsed against the manifest. */
export function writeOutcomeOf(body: unknown): { result: unknown; changed: Changed[]; message: string } {
  if (body === null || typeof body !== "object" || !("result" in body) || !("message" in body)) return { result: body ?? null, changed: [], message: "" };
  const w = body as { result: unknown; changed?: unknown; message: unknown };
  const changed = Array.isArray(w.changed) ? w.changed.filter((c): c is Changed => CollectionSchema.safeParse(c).success) : [];
  return { result: w.result ?? null, changed, message: typeof w.message === "string" ? w.message : "" };
}

/** One event from a request's context and how it ended. Masking happens here, once, for every
 *  path that stores an event. */
export async function auditEventOf(
  db: Reader,
  a: AuditRequestContext,
  o: { outcome: AuditOutcome; status: number; message: string; cause: string | null; result: unknown; changed: Changed[] },
): Promise<AuditEvent> {
  const { target, targetLoc } = targetOf(a.action, a.params, a.body, o.result);
  return {
    at: new Date().toISOString(), requestId: a.requestId,
    actor: await actorOf(db, a.actorId),
    action: a.action, method: a.method, path: a.path, target, targetLoc,
    outcome: o.outcome, status: o.status, message: o.message, cause: o.cause,
    request: maskSecrets({ params: a.params, query: a.query, body: a.body }),
    before: maskSecrets(a.before ?? null), result: maskSecrets(o.result ?? null), changed: o.changed,
    ip: a.ip, userAgent: a.userAgent,
  };
}

/**
 * The `done` event of a write that succeeded, stored by the transaction that recorded the write's
 * idempotency outcome, straight after that record (`withTransaction`, `lib/db.ts`). It commits with
 * the write or not at all, and it is deliberately not wrapped in a try/catch: a write that cannot
 * be audited does not commit, the same stance the idempotency record takes.
 *
 * `body` is the response as the route's schema parsed it - exactly what the key will replay.
 */
export async function recordAudit(tx: Tx, ctx: IdemContext, body: unknown): Promise<void> {
  const w = writeOutcomeOf(body);
  await insertAuditEvent(tx, await auditEventOf(tx, ctx.audit, { outcome: "done", status: 200, message: w.message, cause: null, result: w.result, changed: w.changed }));
  ctx.audit.pending = true;
}

/**
 * What an edit is about to change, as it stood: a service calls this once it has read the row it is
 * about to update or remove and before it changes anything, with the wire-shaped fields the edit can
 * alter. The value rides on the request's audit context, so the `done` event shows before → after -
 * and a refused edit's event carries it too. The last call wins. Outside a write request (a CLI, the
 * seed) there is no context, and nothing to keep.
 */
export function auditBefore(value: Record<string, unknown>): void {
  const ctx = idemStore.getStore();
  if (ctx) ctx.audit.before = value;
}
```

- [ ] **Step 6: Record the event in the write's own transaction**

In `apps/api/src/lib/db.ts`, replace

```ts
import type { Db } from "../db/client.js";
import { idemStore } from "../plugins/idempotency.js";
import { recordIdempotent } from "./idempotency-record.js";
```

with

```ts
import type { Db } from "../db/client.js";
import { idemStore } from "../plugins/idempotency.js";
import { recordAudit } from "./audit.js";
import { recordIdempotent } from "./idempotency-record.js";
```

and replace

```ts
 * `"required"` refuses to accept for a bill. Do not reach for `"optional"` to quieten a response
 * that simply does not match its schema; that is the bug `"required"` is there to catch.
 */
export const withTransaction = <T>(db: Db, fn: (tx: Tx) => Promise<T>, opts: { response?: "required" | "optional" } = {}): Promise<T> =>
  db.transaction(async (tx) => {
    const value = await fn(tx);
    const ctx = idemStore.getStore();
    if (ctx && !ctx.idem.recorded) {
      // "not this transaction's answer, and the caller knows it" - see `opts.response` above.
      // Checked here rather than inside `recordIdempotent` so that its *other* `ok: false` (a
      // claim taken over by a retry mid-write) still takes the straggler down, whatever this
      // caller asked for.
      if (opts.response === "optional" && !ctx.response.safeParse(value).success) {
        ctx.why = "a write's response failed its own schema and its caller asked for that to be tolerated";
        return value;
      }
      const outcome = await recordIdempotent(tx, ctx, value);
      ctx.idem.recorded = outcome.ok;
      if (!outcome.ok) {
        ctx.why = outcome.why;
        if (ctx.strict) throw new Error(outcome.why);
      }
    }
    return value;
  });
```

with

```ts
 * `"required"` refuses to accept for a bill. Do not reach for `"optional"` to quieten a response
 * that simply does not match its schema; that is the bug `"required"` is there to catch.
 *
 * The write's audit event is the record's twin: `recordAudit` (`lib/audit.ts`) inserts it straight
 * after a successful record, in the same transaction and unguarded for the same reason, so a write
 * that cannot be audited does not commit either. Only the transaction that records the outcome
 * stores an event, so a write that opens several transactions gets exactly one. `ctx.audit.recorded`
 * is set once that transaction has **committed**, not before, because `plugins/audit.ts` reads it
 * to decide whether the request still needs an event of its own (a refusal, a 5xx, or production's
 * `onSend` fallback).
 */
export const withTransaction = async <T>(db: Db, fn: (tx: Tx) => Promise<T>, opts: { response?: "required" | "optional" } = {}): Promise<T> => {
  const ctx = idemStore.getStore();
  try {
    const value = await db.transaction(async (tx) => {
      const answer = await fn(tx);
      if (ctx && !ctx.idem.recorded) {
        // "not this transaction's answer, and the caller knows it" - see `opts.response` above.
        // Checked here rather than inside `recordIdempotent` so that its *other* `ok: false` (a
        // claim taken over by a retry mid-write) still takes the straggler down, whatever this
        // caller asked for.
        if (opts.response === "optional" && !ctx.response.safeParse(answer).success) {
          ctx.why = "a write's response failed its own schema and its caller asked for that to be tolerated";
          return answer;
        }
        const outcome = await recordIdempotent(tx, ctx, answer);
        if (outcome.ok) await recordAudit(tx, ctx, outcome.body);
        ctx.idem.recorded = outcome.ok;
        if (!outcome.ok) {
          ctx.why = outcome.why;
          if (ctx.strict) throw new Error(outcome.why);
        }
      }
      return answer;
    });
    // Reached only once COMMIT has returned: the event is durable now, and not a moment sooner.
    if (ctx?.audit.pending) ctx.audit.recorded = true;
    return value;
  } finally {
    if (ctx) ctx.audit.pending = false;
  }
};
```

- [ ] **Step 7: Name, wrap and count every audited write in `mount()`**

In `apps/api/src/routes.ts`, replace

```ts
import { API_PREFIX, type AnyRoute, type Route } from "@rch/contract";
import type { App } from "./app.js";
import { NOT_RECORDED } from "./lib/idempotency-record.js";
import { idemStore, type IdemContext } from "./plugins/idempotency.js";

/** So a handler (or a rate-limit override, etc.) can read whether its own route is a write. */
declare module "fastify" { interface FastifyContextConfig { write?: boolean } }
```

with

```ts
import { API_PREFIX, routes, serviceOf, type AnyRoute, type Route } from "@rch/contract";
import type { App } from "./app.js";
import { auditContextOf } from "./lib/audit.js";
import { NOT_RECORDED } from "./lib/idempotency-record.js";
import { idemStore, type IdemContext } from "./plugins/idempotency.js";

/** So a handler (or a rate-limit override, etc.) can read whether its own route is a write - and
 *  so `plugins/audit.ts` can tell, from the request alone, that a route is audited and what the
 *  trail calls it. */
declare module "fastify" { interface FastifyContextConfig { write?: boolean; audit?: { action: string; method: string; path: string } } }

/** Manifest entry → its name. `mount()` is handed the route object, and the audit trail names a
 *  write by its manifest key (`pay`, `savePrice`) - the key `AUDIT_LABELS` is written against. */
const ROUTE_NAMES = new Map<AnyRoute, string>(Object.entries(routes).map(([name, r]) => [r as AnyRoute, name]));

/** Every non-public manifest write `mount()` has wrapped, by name. `modules/audit-capture.test.ts`
 *  holds it equal to the manifest's own list of API writes, so a write that reached the server
 *  some other way - and so escaped the audit trail - fails the suite. */
export const mountedWrites = new Set<string>();
```

then replace

```ts
 * behaviour - because a refused sale is worse than a narrow retry window.
 */
export function mount<R extends AnyRoute>(app: App, route: R, handler: Handler<R>, extra: { config?: Record<string, unknown> } = {}): void {
  const isWrite = route.write ?? route.method !== "GET";
  const pre: Array<(req: FastifyRequest, reply: FastifyReply) => Promise<void>> = [];
  if (route.access !== "public") pre.push(app.authenticate, app.roleGate(route.access, route.allowMcp ?? false));
  if (isWrite && route.access !== "public") pre.push(app.idempotency);
  const strict = app.config.env !== "production";
  const wrapped: Handler<R> = async (req, reply) => {
    const idem = req.idem;
    if (!idem) return handler(req, reply);
    const ctx: IdemContext = { idem, response: route.response, strict };
```

with

```ts
 * behaviour - because a refused sale is worse than a narrow retry window.
 *
 * Every non-public write is audited. The route's config names it for `plugins/audit.ts`, and the
 * handler runs with an audit context (`req.audit`, the same object as the idempotency context's
 * `audit`) from which the write's own transaction stores its `done` event. A route from the audit
 * service's half of the manifest is refused outright: this process holds no audit log to answer it
 * from.
 */
export function mount<R extends AnyRoute>(app: App, route: R, handler: Handler<R>, extra: { config?: Record<string, unknown> } = {}): void {
  if (serviceOf(route) !== "api") throw new Error(`${route.method} ${route.path} is served by the ${serviceOf(route)} service, not the API`);
  const isWrite = route.write ?? route.method !== "GET";
  const audited = isWrite && route.access !== "public";
  const name = ROUTE_NAMES.get(route);
  // A test-only route is not in the manifest. It is audited all the same, under its method and path.
  const audit = { action: (name ?? `${route.method} ${route.path}`).slice(0, 64), method: route.method, path: route.path };
  if (audited && name) mountedWrites.add(name);
  const pre: Array<(req: FastifyRequest, reply: FastifyReply) => Promise<void>> = [];
  if (route.access !== "public") pre.push(app.authenticate, app.roleGate(route.access, route.allowMcp ?? false));
  if (audited) pre.push(app.idempotency);
  const strict = app.config.env !== "production";
  const wrapped: Handler<R> = async (req, reply) => {
    const idem = req.idem;
    if (!idem) return handler(req, reply);
    req.audit = auditContextOf(req, audit);
    const ctx: IdemContext = { idem, response: route.response, strict, audit: req.audit };
```

then replace

```ts
    config: { write: isWrite, ...extra.config },
    handler: (isWrite && route.access !== "public" ? wrapped : handler) as never,
```

with

```ts
    config: { write: isWrite, ...(audited ? { audit } : {}), ...extra.config },
    handler: (audited ? wrapped : handler) as never,
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @rch/api exec vitest run src/modules/audit-capture.test.ts src/lib/audit.test.ts`
Expected: PASS, 30 tests (14 + 16).

- [ ] **Step 9: Run the package gates**

Run: `pnpm --filter @rch/api typecheck && pnpm --filter @rch/api lint && pnpm check:boundaries && pnpm --filter @rch/api test`
Expected: PASS. `plugins/idempotency.test.ts` stays green unchanged: its test-only routes are audited under `"POST /__test/…"`, and a production fallback there simply leaves no `done` event yet. Coverage stays at or above lines 94 / branches 79.

- [ ] **Step 10: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add apps/api/src/lib/audit.ts apps/api/src/lib/idempotency-record.ts apps/api/src/plugins/idempotency.ts apps/api/src/lib/db.ts apps/api/src/routes.ts apps/api/src/modules/audit-capture.test.ts
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Record every successful write in the audit outbox inside its own transaction

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

### Task 4: API: refusal, error and fallback events (`plugins/audit.ts`)

**Files:**
- Create: `apps/api/src/plugins/audit.ts`
- Modify: `apps/api/src/app.ts` (imports, after line 15; registration, between `idempotency` and `registerModules`, lines 57-58)
- Modify: `apps/api/src/modules/audit-capture.test.ts` (imports; the `eventsSince` helper; the atomicity and multi-transaction cases; a new `describe` appended)
- Test: `apps/api/src/modules/audit-capture.test.ts`

**Interfaces:**
- Consumes: `auditContextOf`, `auditEventOf`, `insertAuditEvent`, `writeOutcomeOf`, `req.audit` and its `recorded` flag, route config `audit` (Task 3); `req.refusal` (`plugins/errors.ts`); `app.authenticate` (`plugins/auth.ts`); `AuditOutcome` (Task 1).
- Produces: `plugins/audit.ts` (`fp` name `"audit"`); `app.auditSettled()`; one `refused`/`error` event per non-public write that did not commit its own event, except a 401 or a replay; production's `done` fallback built from the sent payload.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/modules/audit-capture.test.ts`, replace

```ts
import { randomUUID } from "node:crypto";
import { asc, desc, eq, gt, sql } from "drizzle-orm";
import { AUDIT_LABELS, AuditEventSchema, defineRoute, OkResponseSchema, routes, serviceOf, type AuditEvent } from "@rch/contract";
```

with

```ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { asc, desc, eq, gt, sql } from "drizzle-orm";
import { AUDIT_LABELS, AuditEventSchema, defineRoute, OkResponseSchema, routes, serviceOf, writeResponse, type AuditEvent } from "@rch/contract";
```

replace the `eventsSince` helper

```ts
/** Every event stored after `mark`, oldest first, each parsed exactly as the drainer will parse it. */
const eventsSince = async (mark: number): Promise<AuditEvent[]> =>
  (await app.db.select().from(auditOutbox).where(gt(auditOutbox.id, mark)).orderBy(asc(auditOutbox.id))).map((r) => AuditEventSchema.parse(r.event));
```

with

```ts
/** Every event stored after `mark`, oldest first, each parsed exactly as the drainer will parse it.
 *  `auditSettled` first: a refusal's event is stored after its reply, so a read straight after
 *  `inject` could beat it - and a case asserting "no event" would pass for the wrong reason. */
const eventsSince = async (mark: number, on: App = app): Promise<AuditEvent[]> => {
  await on.auditSettled();
  return (await app.db.select().from(auditOutbox).where(gt(auditOutbox.id, mark)).orderBy(asc(auditOutbox.id))).map((r) => AuditEventSchema.parse(r.event));
};
```

in "a write whose event cannot be stored does not commit", replace

```ts
      expect(await countRows(stockMoves)).toBe(movesBefore);
    } finally {
```

with

```ts
      expect(await countRows(stockMoves)).toBe(movesBefore);
      // The 500's own event is refused by the same constraint; wait for that attempt to finish
      // before the constraint goes, or it would land afterwards.
      await app.auditSettled();
    } finally {
```

in "a write whose transaction throws after its changes leaves no done event", replace

```ts
      expect((await eventsSince(mark)).filter((e) => e.outcome === "done")).toEqual([]);
```

with

```ts
      const events = await eventsSince(mark, a);
      expect(events.filter((e) => e.outcome === "done")).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ outcome: "refused", status: 422, message: "Refused - staged after the change", result: null, changed: [] });
```

in "a write that opens several transactions…", replace

```ts
      const events = await eventsSince(mark);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: "POST /__test/audit-multi"
```

with

```ts
      const events = await eventsSince(mark, a);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: "POST /__test/audit-multi"
```

and append to the end of the file:

```ts
describe("a write that does not succeed leaves one event after its reply", () => {
  it("a rule refusal: refused, with the sentence the operator read", async () => {
    const mark = await lastId();
    const r = await write("u2", "PUT", "/prices/A/juice", { price: 25 });
    expect(r.statusCode).toBe(422);
    expect(await eventsSince(mark)).toEqual([{
      at: expect.any(String), requestId: r.headers["x-request-id"],
      actor: { id: "u2", emp: "RC-3120", name: "Ramesh Kumar", role: "Outlet Manager", loc: "rest" },
      action: "savePrice", method: "PUT", path: "/prices/:list/:it", target: "A:juice", targetLoc: "",
      outcome: "refused", status: 422, message: "Refused - printed MRP of ₹20 is a hard ceiling for Real Juice 200ml", cause: null,
      request: { params: { list: "A", it: "juice" }, query: {}, body: { price: 25 } },
      before: null, result: null, changed: [], ip: "127.0.0.1", userAgent: UA,
    }]);
  });

  it("a wrong-location refusal: the counter, and the outlet it reached for", async () => {
    const mark = await lastId();
    const r = await write("u1", "POST", "/bills", { loc: "kiosk", tender: "Cash", lines: [{ it: "chips", qty: 1 }] });
    expect(r.statusCode).toBe(403);
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({ actor: { id: "u1" }, action: "pay", targetLoc: "kiosk", outcome: "refused", status: 403, message: "You can only do this for your own counter." });
  });

  it("a role-gate 404: the route that is not there for that role", async () => {
    const mark = await lastId();
    const r = await write("u1", "PUT", "/prices/A/juice", { price: 18 });
    expect(r.statusCode).toBe(404);
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({ actor: { id: "u1", role: "Counter Operator" }, action: "savePrice", target: "A:juice", outcome: "refused", status: 404 });
  });

  it("a validation 400 from a signed-in caller: still named, though the body was refused before the token was checked", async () => {
    const mark = await lastId();
    const r = await write("u2", "PUT", "/prices/A/juice", { price: 0 });
    expect(r.statusCode).toBe(400);
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({
      actor: { id: "u2", emp: "RC-3120" }, action: "savePrice", outcome: "refused", status: 400,
      message: "The request did not match what this endpoint expects.", request: { body: { price: 0 } },
    });
  });

  it("a refusal nobody can be named for leaves nothing: no token, or one that does not verify", async () => {
    const mark = await lastId();
    const bare = await app.inject({ method: "PUT", url: "/api/v1/prices/A/juice", headers: { "idempotency-key": randomUUID(), "user-agent": UA }, payload: { price: 0, note: "x".repeat(2000) } });
    expect(bare.statusCode).toBe(400);
    const forged = await app.inject({ method: "PUT", url: "/api/v1/prices/A/juice", headers: { authorization: "Bearer not-a-token", "idempotency-key": randomUUID() }, payload: { price: 0 } });
    expect(forged.statusCode).toBe(400);
    expect(await eventsSince(mark)).toEqual([]);
  });

  it("a wrong handover code: one refused event, and never the code that was typed", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "box", qty: 5 }], otp: "123456" });
    const mark = await lastId();
    const r = await write("u3", "POST", `/tickets/${id}/handover`, { otp: "987654" });
    expect(r.statusCode).toBe(422);
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({
      action: "handover", target: id, outcome: "refused", status: 422,
      message: `That OTP does not match ${id}. Ask the collector to read it again.`, request: { body: { otp: MASK } },
    });
    expect(JSON.stringify(e)).not.toContain("987654");
  });

  it("an Idempotency-Key reused for a different request: the first write done, the second refused", async () => {
    const key = randomUUID();
    const mark = await lastId();
    expect((await write("u1", "PATCH", "/me", { ph: "91000 00009" }, key)).statusCode).toBe(200);
    const r = await write("u1", "PATCH", "/me", { ph: "92000 00009" }, key);
    expect(r.statusCode).toBe(409);
    const events = await eventsSince(mark);
    expect(events.map((e) => [e.action, e.outcome, e.status])).toEqual([["patchMe", "done", 200], ["patchMe", "refused", 409]]);
    expect(events[1].message).toBe("That Idempotency-Key was already used for a different request.");
  });

  it("a 401 leaves nothing: the client refreshes and retries, and the retry is the event", async () => {
    const mark = await lastId();
    const r = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: { authorization: "Bearer not-a-token", "idempotency-key": randomUUID() }, payload: { ph: "94000 00009" } });
    expect(r.statusCode).toBe(401);
    expect(await eventsSince(mark)).toEqual([]);
  });

  it("a replay leaves nothing: the original is already logged", async () => {
    const key = randomUUID();
    const mark = await lastId();
    expect((await write("u6", "PATCH", "/me", { ph: "93000 00009" }, key)).statusCode).toBe(200);
    const again = await write("u6", "PATCH", "/me", { ph: "93000 00009" }, key);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    const events = await eventsSince(mark);
    expect(events.map((e) => [e.actor.id, e.outcome])).toEqual([["u6", "done"]]);
  });

  it("a refused edit: the before value the service kept before refusing", async () => {
    const route = defineRoute({ method: "POST", path: "/__test/audit-refused-edit", access: "any", response: OkResponseSchema });
    const a = await appWith((x) => mount(x, route, async () => withTransaction(app.db, async () => {
      auditBefore({ ph: "75000 00007" });
      throw new RuleError("Refused - that number is already someone else's");
    })));
    try {
      const mark = await lastId();
      const r = await write("u1", "POST", "/__test/audit-refused-edit", undefined, randomUUID(), a);
      expect(r.statusCode).toBe(422);
      const [e, ...more] = await eventsSince(mark, a);
      expect(more).toEqual([]);
      expect(e).toMatchObject({ outcome: "refused", status: 422, before: { ph: "75000 00007" }, message: "Refused - that number is already someone else's" });
    } finally {
      await a.close();
    }
  });

  it("a 5xx: an error event carrying the sentence and its reference", async () => {
    const route = defineRoute({ method: "POST", path: "/__test/audit-boom", access: "any", response: OkResponseSchema });
    const a = await appWith((x) => mount(x, route, async () => { throw new Error("the disk is on fire"); }));
    try {
      const mark = await lastId();
      const r = await write("u1", "POST", "/__test/audit-boom", undefined, randomUUID(), a);
      expect(r.statusCode).toBe(500);
      const [e, ...more] = await eventsSince(mark, a);
      expect(more).toEqual([]);
      expect(e).toMatchObject({
        action: "POST /__test/audit-boom", outcome: "error", status: 500, cause: null,
        message: `Something went wrong on our side. Reference ${r.headers["x-request-id"]}.`,
      });
    } finally {
      await a.close();
    }
  });

  it("production's fallback: a write answered outside any transaction is logged done from what it sent", async () => {
    const route = defineRoute({ method: "POST", path: "/__test/audit-outside", access: "any", response: writeResponse(z.strictObject({ id: z.string() })) });
    const a = await appWith((x) => mount(x, route, async () => ({ result: { id: "OUT-1" }, changed: ["items" as const], message: "Staged outside any transaction" })), { NODE_ENV: "production" });
    try {
      const mark = await lastId();
      const r = await write("u2", "POST", "/__test/audit-outside", undefined, randomUUID(), a);
      expect(r.statusCode, r.body).toBe(200);
      const [e, ...more] = await eventsSince(mark, a);
      expect(more).toEqual([]);
      expect(e).toMatchObject({
        actor: { id: "u2" }, action: "POST /__test/audit-outside", target: "OUT-1", outcome: "done", status: 200,
        message: "Staged outside any transaction", changed: ["items"], result: { id: "OUT-1" },
      });
    } finally {
      await a.close();
    }
  });

  it("an event that cannot be stored is logged with its request id, and the reply is untouched", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const log: LogStream = { write: (s: string) => { for (const l of s.split("\n")) if (l) lines.push(JSON.parse(l) as Record<string, unknown>); } };
    const a = await appWith(() => undefined, { LOG_LEVEL: "error" }, log);
    await app.db.execute(sql.raw("alter table audit_outbox add constraint audit_outbox_refuse_ck check (false) not valid"));
    try {
      const r = await write("u1", "PUT", "/prices/A/juice", { price: 18 }, randomUUID(), a);
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe("not_found");
      await a.auditSettled();
      expect(lines.find((l) => l.msg === "audit event not stored")).toMatchObject({ level: 50, action: "savePrice", requestId: r.headers["x-request-id"] });
    } finally {
      await app.db.execute(sql.raw("alter table audit_outbox drop constraint audit_outbox_refuse_ck"));
      await a.close();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rch/api exec vitest run src/modules/audit-capture.test.ts`
Expected: FAIL. Typecheck-free Vitest still runs, and every case that reads events fails with `TypeError: on.auditSettled is not a function`. Only the two completeness cases and "is nothing to keep outside a write request" pass.

- [ ] **Step 3: Implement the hook**

Create `apps/api/src/plugins/audit.ts`:

```ts
import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuditOutcome } from "@rch/contract";
import { auditContextOf, auditEventOf, insertAuditEvent, writeOutcomeOf } from "../lib/audit.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Resolves once every audit event this app is still storing has been stored or given up on.
     *  A test awaits it before reading the outbox; `onClose` awaits it before the pool goes. */
    auditSettled: () => Promise<void>;
  }
}

/** A JSON reply body as sent, or null for anything that is not one. */
const parsed = (payload: unknown): unknown => {
  if (typeof payload !== "string") return null;
  try { return JSON.parse(payload) as unknown; } catch { return null; }
};
/** The sentence an error envelope carried - the 5xx's "Reference <request id>" line included. */
const envelopeMessage = (body: unknown): string => {
  const m = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof m === "string" ? m : "";
};
const outcomeOf = (status: number): AuditOutcome => (status < 400 ? "done" : status < 500 ? "refused" : "error");

/**
 * Every audited request that did not store its own event inside a transaction gets one here, once
 * the reply has gone: a refusal (400–499), an error (≥ 500), and production's fallback - a write
 * whose answer was not recorded in a transaction and went out anyway (status < 400).
 *
 * Audited means `mount()` named the route in its config: every non-public write. A write that
 * committed its own `done` event (`req.audit.recorded`) is skipped, and so are two replies that are
 * not events: a **401**, because the client refreshes its token and retries, and the retry is the
 * event; and a **replay** (`idempotency-replayed`), because the original is already logged.
 *
 * A refusal is recorded only when a valid token names the caller. Fastify validates the body before
 * any preHandler, so a malformed request is refused ahead of the route's own token check; the token
 * is verified here instead, quietly, and a signed-in caller is still named. A request nobody can be
 * named for records nothing: anyone on the internet could otherwise write rows into a trail that is
 * kept forever. A failed sign-in is the exception, and `modules/auth` records it itself.
 *
 * The insert runs on the pool after the response, so it never slows or changes a reply. A failure
 * is logged at `error` with the request id and swallowed.
 */
export default fp(async (app) => {
  const sent = new WeakMap<FastifyRequest, unknown>();
  const inflight = new Set<Promise<void>>();

  // `onResponse` has the status but not the body, and the production fallback reads its sentence
  // out of the body, so the body is kept for exactly the requests that may still need it.
  app.addHook("onSend", async (req, _reply, payload) => {
    if (req.routeOptions.config.audit && !req.audit?.recorded) sent.set(req, payload);
    return payload;
  });

  async function store(req: FastifyRequest, reply: FastifyReply, route: { action: string; method: string; path: string }): Promise<void> {
    const status = reply.statusCode;
    const body = parsed(sent.get(req));
    if (!req.audit && !(req as { user?: unknown }).user) {
      try { await app.authenticate(req, reply); } catch { /* no verifiable token: the event has no actor */ }
    }
    const a = req.audit ?? auditContextOf(req, route);
    if (a.actorId === null) return;
    const outcome = outcomeOf(status);
    const w = outcome === "done" ? writeOutcomeOf(body) : { result: null, changed: [], message: req.refusal?.message ?? envelopeMessage(body) };
    await insertAuditEvent(app.db, await auditEventOf(app.db, a, {
      outcome, status, message: w.message, cause: outcome === "refused" ? req.refusal?.cause ?? null : null, result: w.result, changed: w.changed,
    }));
  }

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.config.audit;
    if (!route || req.audit?.recorded) return;
    if (reply.statusCode === 401 || reply.getHeader("idempotency-replayed")) return;
    const job = store(req, reply, route).catch((err: unknown) => {
      req.log.error({ err, requestId: req.id, action: route.action }, "audit event not stored");
    });
    inflight.add(job);
    try { await job; } finally { inflight.delete(job); }
  });

  // `setImmediate` first: a caller that has just had its reply may be ahead of the hook that
  // starts the insert, and one turn of the loop lets every such hook register its job.
  app.decorate("auditSettled", async () => {
    await new Promise<void>((r) => { setImmediate(r); });
    await Promise.all(inflight);
  });
  app.addHook("onClose", async () => { await Promise.all(inflight); });
}, { name: "audit", dependencies: ["errors", "db", "auth"] });
```

- [ ] **Step 4: Register it**

In `apps/api/src/app.ts`, replace

```ts
import idempotency from "./plugins/idempotency.js";
```

with

```ts
import idempotency from "./plugins/idempotency.js";
import audit from "./plugins/audit.js";
```

and replace

```ts
  await app.register(idempotency);
  await registerModules(app);
```

with

```ts
  await app.register(idempotency);
  // After idempotency, so its `onSend` has run by the time this one keeps the body, and before the
  // modules, so every route `mount()` registers carries the hooks.
  await app.register(audit);
  await registerModules(app);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @rch/api exec vitest run src/modules/audit-capture.test.ts src/lib/audit.test.ts src/plugins/idempotency.test.ts src/routes.test.ts src/contract.test.ts`
Expected: PASS. `audit-capture.test.ts` runs 27 tests.

- [ ] **Step 6: Run the package gates**

Run: `pnpm --filter @rch/api typecheck && pnpm lint && pnpm --filter @rch/api test`
Expected: PASS. `pnpm lint` covers oxlint for every package, knip and the boundaries check. Coverage stays at or above lines 94 / branches 79. If Postgres is shared with another worktree's full suite and lock tests in `auth.test.ts` or `tickets.test.ts` time out at 900 s, rerun those files alone before suspecting this change (note 4).

- [ ] **Step 7: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add apps/api/src/plugins/audit.ts apps/api/src/app.ts apps/api/src/modules/audit-capture.test.ts
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Record every refused or failed write in the audit outbox after its reply

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

#### Interface additions

- `apps/api/src/lib/roles.ts`: `export async function applyAppRole(db: Db, urls: { runtime: string; migrate: string }, opts: { schema: string; migrationsSchema: string }): Promise<string | null>`. This is the whole of the migrate step's role setup. It returns `null` when both URLs name the same user, and otherwise the role name it created or updated and granted. `cli/migrate.ts` calls it, and `lib/roles.test.ts` covers it, including the skipped path.
- `apps/api/src/modules/auth/service.ts`: `export class LoginRefused extends UnauthenticatedError { readonly userId: string | null }`. It is the one refusal a sign-in raises for an unknown id, a wrong password or a deactivated account. It keeps the sentence (`BAD_LOGIN`) and the log `cause` as they are today, and adds the account id the audit event needs.
- `apps/api/src/modules/auth/service.ts`: `logout(raw)` now returns `Promise<string | null>` instead of `Promise<void>`. The value is the id of the account whose live session it revoked, or `null` when it revoked nothing.

#### Notes

1. **Two routes added to the spec's `auditBefore` list.** The spec's rule is "every write that updates or removes an existing master row or account", and two routes meet it that the spec's list omits. `resetAdminUserPassword` updates the account row, flipping `mustChangePassword` and revoking sessions. `deleteAdminUser` removes the row. Both are added here. There is nothing from recipes or payers, per D1.
2. **Spec §7 asks the API role test to prove "cannot read `audit.events`".** The API's test database never has that schema; it belongs to `apps/audit`'s migrations. Task 8 proves the general property instead: no privilege on a schema it was not granted, using a sibling schema it creates. The `audit.events` check belongs in Task 10's roles test.
3. **Operator CLIs still call `loadConfig`**, which requires `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `CORS_ORIGIN` and `SEED_PASSWORD`. The Compose `migrate` service that runs the box's CLIs (D21) must carry all of them, not only the two URLs.
4. **`turbo.json`**: Task 8 adds `MIGRATE_DATABASE_URL` to `test.env`. `AUDIT_DATABASE_URL` is left to Task 15.
5. **The per-IP login refusal is recorded from `onSend`, not `onResponse`.** `@fastify/rate-limit` throws from a `preHandler`, so the login handler never runs. Its route-level `onExceeded` option, merged over the global settings, marks the request, and an `onSend` hook records it. `onSend` is awaited before the reply leaves, so the event is in the outbox by the time `app.inject` resolves.
6. **`logout` records an event only when it revoked a live session.** A second click with the same cookie, or a logout with no cookie, signs nobody out and records nothing.
7. **Anchors checked after the rebase onto `609befb`.** Of the files this part edits, only `availability/service.ts` changed: its kitchen branch now reads `item.t === "FG"`. The `availabilityRepo.find` anchor is unchanged and still at line 65. The fixtures these tests rely on are also unchanged: `PL.A.juice` 18, `MENU.coffee`, `IT.bisc.rl` 30, `VN-005`, `RC-101` moq 40, `RC-102`, and the users `u1` to `u7`.

---

### Task 5: API: before values in edit services

**Files:**
- Create: `apps/api/src/modules/audit-before.test.ts`
- Modify: `apps/api/src/modules/catalog/service.ts`: imports; `patchItem` (after `catalogRepo.head`, line 116); `savePrice` (after the item 404, line 217); `addMenuItem` (before `isListed`, line 237); `removeMenuItem` (before `isListed`, line 257)
- Modify: `apps/api/src/modules/availability/service.ts`: imports; `toggle` (after `availabilityRepo.find`, line 65)
- Modify: `apps/api/src/modules/vendors/service.ts`: imports; `patch` (after the vendor 404, line 64)
- Modify: `apps/api/src/modules/contracts/service.ts`: imports; `patch` (after the 404, line 55); `remove` (after the 404, line 106)
- Modify: `apps/api/src/modules/me/service.ts`: imports; `patch` (line 16)
- Modify: `apps/api/src/modules/purchaseorders/service.ts`: imports; `updateLine` (line 144); `removeLine` (line 193); `patch` (line 217)
- Modify: `apps/api/src/modules/admin/service.ts`: imports; `resetPassword` (line 77); `deactivate` (line 91); `reactivate` (line 101); `updateRoleLoc` (line 112); `remove` (line 130)
- Test: `apps/api/src/modules/audit-before.test.ts`

**Interfaces:**
- Consumes: from Task 3 (`lib/audit.ts`), `auditBefore(value: Record<string, unknown>): void`, and the done event, whose `before` is taken from `ctx.audit.before`. From Task 2 (`lib/audit.ts`), `maskSecrets<T>(value: T): T`, which masks the exact `SECRET_KEYS` names, and the `audit_outbox` table (migration `0016_audit_outbox`). From Task 1 (`@rch/contract`), `AuditEvent`.
- Produces: 17 edit services each leave their pre-edit, wire-shaped value on the request's audit context. The call comes right after the row is read (after its lock where the service locks) and before any rule or change.

- [ ] **Step 1: Write the failing test (prices, menus, the availability switch, the item master)**

Create `apps/api/src/modules/audit-before.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import type { AuditEvent } from "@rch/contract";
import type { App } from "../app.js";
import { maskSecrets } from "../lib/audit.js";
import { buildTestApp } from "../test/app.js";
import { authHeaders } from "../test/auth.js";
import { given } from "../test/builders.js";
import { seedTestDb } from "../test/seed.js";

/**
 * Every write that edits or removes an existing master row or account names what it replaced
 * (`auditBefore`, spec §2.4), so the audit drawer can show before → after. One case per service.
 *
 * Where it can, a case makes the same edit twice: the second edit's `before` must equal the first
 * edit's `result`. That is the property the drawer's diff relies on - a before value is the same
 * wire shape as the answer, field for field. Both sides go through `maskSecrets`, because the
 * outbox stores both masked.
 */
let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "audit_before" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

type Body = { result: Record<string, unknown> } & Record<string, unknown>;
const send = async (user: string, method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>): Promise<Body> => {
  const opts: InjectOptions = { method, url: `/api/v1${url}`, headers: { ...(await authHeaders(app, user)), "idempotency-key": randomUUID() } };
  if (payload !== undefined) opts.payload = payload;
  const r = await app.inject(opts);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Body;
};
const read = async (url: string) => {
  const r = await app.inject({ method: "GET", url: `/api/v1${url}`, headers: await authHeaders(app, "u2") });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
/** The newest outbox event for one route, read straight off the table - a test may; nothing
 *  under src/ may (scripts/check-boundaries.sh). */
const lastEvent = async (action: string): Promise<AuditEvent> => {
  const r = await app.testDb!.pool.query<{ event: AuditEvent }>(
    "select event from audit_outbox where event->>'action' = $1 order by id desc limit 1", [action]);
  expect(r.rows, `no ${action} event in the outbox`).toHaveLength(1);
  return r.rows[0]!.event;
};

describe("before values: prices, menus, the availability switch and the item master", () => {
  it("savePrice keeps the list's old price, and null where that list never priced the item", async () => {
    expect((await read("/prices")).A.juice).toBe(18);
    const first = await send("u2", "PUT", "/prices/A/juice", { price: 19 });
    expect((await lastEvent("savePrice")).before).toEqual({ list: "A", it: "juice", price: 18 });
    await send("u2", "PUT", "/prices/A/juice", { price: 17 });
    expect((await lastEvent("savePrice")).before).toEqual(maskSecrets(first.result));
    await send("u2", "PUT", "/prices/A/box", { price: 3 });
    expect((await lastEvent("savePrice")).before).toEqual({ list: "A", it: "box", price: null });
  });

  it("addMenuItem and removeMenuItem keep the outlet's listing as it stood", async () => {
    const listing = (await read("/menus")).coffee as string[];
    const added = await send("u2", "POST", "/menus/coffee/items", { it: "sand" });
    expect((await lastEvent("addMenuItem")).before).toEqual({ loc: "coffee", items: listing });
    await send("u2", "DELETE", "/menus/coffee/items/sand");
    expect((await lastEvent("removeMenuItem")).before).toEqual(maskSecrets(added.result));
  });

  it("toggleAvail keeps whether the item was on or off at that counter", async () => {
    const first = await send("u1", "POST", "/availability/toggle", { loc: "coffee", it: "juice" });
    expect((await lastEvent("toggleAvail")).before).toMatchObject({ loc: "coffee", it: "juice", off: !first.result.off });
    await send("u1", "POST", "/availability/toggle", { loc: "coffee", it: "juice" });
    expect((await lastEvent("toggleAvail")).before).toEqual(maskSecrets(first.result));
  });

  it("patchItem keeps the line as it was, in the { key, item } shape it answers with", async () => {
    const was = (await read("/items")).bisc;
    const first = await send("u3", "PATCH", "/items/bisc", { rl: 35 });
    expect((await lastEvent("patchItem")).before).toEqual({ key: "bisc", item: was });
    await send("u3", "PATCH", "/items/bisc", { rl: 40 });
    expect((await lastEvent("patchItem")).before).toEqual(maskSecrets(first.result));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rch/api exec vitest run src/modules/audit-before.test.ts`
Expected: FAIL. All four cases fail on `before`, which is still `null` (for example `expected null to deeply equal { list: 'A', it: 'juice', price: 18 }`).

- [ ] **Step 3: Implement (catalog and availability)**

`apps/api/src/modules/catalog/service.ts`: add the import below the `withTransaction` import:

```ts
import { withTransaction } from "../../lib/db.js";
import { auditBefore } from "../../lib/audit.js";
```

In `patchItem`, replace

```ts
        const row = await catalogRepo.head(tx, it);
        // The same sentence `savePrice` gives, word for word: one missing item, one wording.
        if (!row) throw new NotFoundError(`There is no item ${it}.`);
```

with

```ts
        const row = await catalogRepo.head(tx, it);
        // The same sentence `savePrice` gives, word for word: one missing item, one wording.
        if (!row) throw new NotFoundError(`There is no item ${it}.`);
        // The line as the locked row has it, in the `{ key, item }` shape this write answers with,
        // so the audit drawer can set the two side by side.
        auditBefore({ key: it, item: toWireItem(row) });
```

In `savePrice`, replace

```ts
        if (!item) throw new NotFoundError(`There is no item ${it}.`);
        assertRule(!(item.mrp != null && price > item.mrp), `Refused - printed MRP of ₹${item.mrp} is a hard ceiling for ${item.n}`);
```

with

```ts
        if (!item) throw new NotFoundError(`There is no item ${it}.`);
        // `null` where this list has never priced the item: the upsert below inserts rather than changes.
        const prior = (await catalogRepo.pricesOf(tx, it)).find((p) => p.list === list);
        auditBefore({ list, it, price: prior?.price ?? null });
        assertRule(!(item.mrp != null && price > item.mrp), `Refused - printed MRP of ₹${item.mrp} is a hard ceiling for ${item.n}`);
```

In `addMenuItem`, replace

```ts
        const listed = await catalogRepo.isListed(tx, loc, it);
        assertRule(!listed, `${item.n} is already listed at ${location.n}`);
```

with

```ts
        auditBefore({ loc, items: await catalogRepo.menuItems(tx, loc) });
        const listed = await catalogRepo.isListed(tx, loc, it);
        assertRule(!listed, `${item.n} is already listed at ${location.n}`);
```

In `removeMenuItem`, replace

```ts
        const listed = await catalogRepo.isListed(tx, loc, it);
        assertRule(listed, `${item.n} is not listed at ${location.n}`);
```

with

```ts
        auditBefore({ loc, items: await catalogRepo.menuItems(tx, loc) });
        const listed = await catalogRepo.isListed(tx, loc, it);
        assertRule(listed, `${item.n} is not listed at ${location.n}`);
```

`apps/api/src/modules/availability/service.ts`: add the import below the `withTransaction` import:

```ts
import { withTransaction } from "../../lib/db.js";
import { auditBefore } from "../../lib/audit.js";
```

In `toggle`, replace

```ts
        const existing = await availabilityRepo.find(tx, body.loc, body.it);
        if (existing) {
```

with

```ts
        const existing = await availabilityRepo.find(tx, body.loc, body.it);
        // The switch as it stood, in the shape the result gives: on (no override), or off with the
        // reason the override carries.
        auditBefore(existing
          ? { loc: body.loc, it: body.it, off: true, reason: existing.reason }
          : { loc: body.loc, it: body.it, off: false });
        if (existing) {
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @rch/api exec vitest run src/modules/audit-before.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing test (vendors, rate contracts, the caller's own account)**

Append to `apps/api/src/modules/audit-before.test.ts`:

```ts
describe("before values: vendors, rate contracts and the caller's own account", () => {
  it("updateVendor keeps the vendor as it was", async () => {
    const first = await send("u5", "PATCH", "/vendors/VN-005", { contact: "Selvi Murugan" });
    expect((await lastEvent("updateVendor")).before).toMatchObject({ id: "VN-005", contact: "Selvi M" });
    await send("u5", "PATCH", "/vendors/VN-005", { contact: "Selvi M." });
    expect((await lastEvent("updateVendor")).before).toEqual(maskSecrets(first.result));
  });

  it("updateContract and removeContract keep the contract as it was", async () => {
    const first = await send("u3", "PATCH", "/contracts/RC-101", { moq: 45 });
    expect((await lastEvent("updateContract")).before).toMatchObject({ id: "RC-101", moq: 40, active: true });
    await send("u3", "PATCH", "/contracts/RC-101", { moq: 50 });
    expect((await lastEvent("updateContract")).before).toEqual(maskSecrets(first.result));

    const closed = await send("u3", "DELETE", "/contracts/RC-102");
    const ev = await lastEvent("removeContract");
    expect(ev.before).toMatchObject({ id: "RC-102", active: true });
    // A close changes one field; everything else the drawer shows is the same on both sides.
    expect({ ...(ev.before as Record<string, unknown>), active: false }).toEqual(maskSecrets(closed.result));
  });

  it("patchMe keeps the caller's own record as it was", async () => {
    const first = await send("u3", "PATCH", "/me", { ph: "90000 00001" });
    expect((await lastEvent("patchMe")).before).toMatchObject({ user: { id: "u3", ph: "94430 51194" } });
    await send("u3", "PATCH", "/me", { ph: "90000 00002" });
    // `/me` answers without a `result` envelope, so its before is the whole answer's shape - the
    // same value `writeOutcomeOf` (lib/audit.ts) stores whole as its `result`.
    expect((await lastEvent("patchMe")).before).toEqual(maskSecrets(first));
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @rch/api exec vitest run src/modules/audit-before.test.ts`
Expected: FAIL. The three new cases see `before: null`; the first four still pass.

- [ ] **Step 7: Implement (vendors, contracts, me)**

`apps/api/src/modules/vendors/service.ts`: add the import below the `withTransaction` import:

```ts
import { withTransaction } from "../../lib/db.js";
import { auditBefore } from "../../lib/audit.js";
```

In `patch`, replace

```ts
        const existing = await vendorsRepo.head(tx, id);
        if (!existing) throw new NotFoundError(`There is no vendor ${id}.`);
```

with

```ts
        const existing = await vendorsRepo.head(tx, id);
        if (!existing) throw new NotFoundError(`There is no vendor ${id}.`);
        auditBefore(toWire(existing));
```

`apps/api/src/modules/contracts/service.ts`: add the import below the `withTransaction` import:

```ts
import { withTransaction } from "../../lib/db.js";
import { auditBefore } from "../../lib/audit.js";
```

In `patch`, replace

```ts
        if (!existing) throw new NotFoundError(`There is no rate contract ${id}.`);
        assertRule(Object.keys(body).length > 0, `Nothing to change on ${id}`);
```

with

```ts
        if (!existing) throw new NotFoundError(`There is no rate contract ${id}.`);
        auditBefore(await contractsRepo.wire(tx, id));
        assertRule(Object.keys(body).length > 0, `Nothing to change on ${id}`);
```

In `remove`, replace

```ts
        if (!existing) throw new NotFoundError(`There is no rate contract ${id}.`);
        await contractsRepo.update(tx, id, { active: false });
```

with

```ts
        if (!existing) throw new NotFoundError(`There is no rate contract ${id}.`);
        auditBefore(await contractsRepo.wire(tx, id));
        await contractsRepo.update(tx, id, { active: false });
```

`apps/api/src/modules/me/service.ts`: replace

```ts
import { withTransaction, type Reader } from "../../lib/db.js";
```

with

```ts
import { withTransaction, type Reader } from "../../lib/db.js";
import { auditBefore } from "../../lib/audit.js";
```

and in `patch`, replace

```ts
      return withTransaction(db, async (tx) => {
        await meRepo.update(tx, id, { name: p.n, email: p.e, phone: p.ph });
```

with

```ts
      return withTransaction(db, async (tx) => {
        // The same `{ user, mustChangePassword }` this write answers with, read before it changes.
        auditBefore(await load(tx, id));
        await meRepo.update(tx, id, { name: p.n, email: p.e, phone: p.ph });
```

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm --filter @rch/api exec vitest run src/modules/audit-before.test.ts src/modules/vendors/vendors.test.ts src/modules/contracts/contracts.test.ts src/modules/me/me.test.ts`
Expected: PASS: 7 cases in `audit-before.test.ts`, and the vendors, contracts and me suites unchanged.

- [ ] **Step 9: Write the failing test (a draft purchase order)**

Append to `apps/api/src/modules/audit-before.test.ts`:

```ts
describe("before values: a draft purchase order", () => {
  /** A fresh draft on VN-001: one milk line of 60, claimed off an approved requisition - the
   *  purchase-order suite's own set-up. Its create answer is the order as the edit will find it. */
  const draft = async (): Promise<Record<string, unknown>> => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    return (await send("u5", "POST", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 60 }] })).result;
  };

  it("updatePoLine keeps the order as it stood", async () => {
    const po = await draft();
    await send("u5", "PATCH", `/purchase-orders/${String(po.id)}/lines/0`, { rate: 50 });
    expect((await lastEvent("updatePoLine")).before).toEqual(maskSecrets(po));
  });

  it("removePoLine keeps the order as it stood", async () => {
    const po = await draft();
    await send("u5", "DELETE", `/purchase-orders/${String(po.id)}/lines/0`);
    expect((await lastEvent("removePoLine")).before).toEqual(maskSecrets(po));
  });

  it("patchPo keeps the order as it stood", async () => {
    const po = await draft();
    await send("u5", "PATCH", `/purchase-orders/${String(po.id)}`, { eta: "2026-10-15" });
    expect((await lastEvent("patchPo")).before).toEqual(maskSecrets(po));
  });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm --filter @rch/api exec vitest run src/modules/audit-before.test.ts`
Expected: FAIL. The three purchase-order cases see `before: null`.

- [ ] **Step 11: Implement (purchase orders)**

`apps/api/src/modules/purchaseorders/service.ts`: replace

```ts
import { addOrdered, lockRequisitions } from "../../lib/claims.js";
```

with

```ts
import { auditBefore } from "../../lib/audit.js";
import { addOrdered, lockRequisitions } from "../../lib/claims.js";
```

In `updateLine`, replace

```ts
    async updateLine(_claims: AccessClaims, id: string, n: number, body: UpdatePoLineBody): Promise<WriteResponse<PurchaseOrder>> {
      return withTransaction(db, async (tx) => {
        const o = await head(tx, id);
```

with

```ts
    async updateLine(_claims: AccessClaims, id: string, n: number, body: UpdatePoLineBody): Promise<WriteResponse<PurchaseOrder>> {
      return withTransaction(db, async (tx) => {
        const o = await head(tx, id);
        auditBefore(await purchaseOrdersRepo.wire(tx, id));
```

In `removeLine`, replace

```ts
    async removeLine(_claims: AccessClaims, id: string, n: number): Promise<WriteResponse<PurchaseOrder>> {
      return withTransaction(db, async (tx) => {
        const o = await head(tx, id);
```

with

```ts
    async removeLine(_claims: AccessClaims, id: string, n: number): Promise<WriteResponse<PurchaseOrder>> {
      return withTransaction(db, async (tx) => {
        const o = await head(tx, id);
        auditBefore(await purchaseOrdersRepo.wire(tx, id));
```

In `patch`, replace

```ts
        const o = await head(tx, id);
        assertRule(body.vendorId || body.eta, `Nothing to change on ${id}`);
```

with

```ts
        const o = await head(tx, id);
        auditBefore(await purchaseOrdersRepo.wire(tx, id));
        assertRule(body.vendorId || body.eta, `Nothing to change on ${id}`);
```

- [ ] **Step 12: Run it to verify it passes**

Run: `pnpm --filter @rch/api exec vitest run src/modules/audit-before.test.ts src/modules/purchaseorders/purchaseorders.test.ts`
Expected: PASS.

- [ ] **Step 13: Write the failing test (staff accounts)**

Append to `apps/api/src/modules/audit-before.test.ts`:

```ts
describe("before values: staff accounts", () => {
  /** A fresh counter account at the Snack Kiosk, made by the seeded super admin (u7), so no case
   *  moves a colleague another case relies on. Its create answer, less the one-time password, is
   *  the account as the next edit will find it. */
  const account = async (): Promise<Record<string, unknown>> => {
    const tag = randomUUID().slice(0, 8);
    const r = await send("u7", "POST", "/admin/users", { name: `Audit Probe ${tag}`, email: `probe-${tag}@royalcare.in`, role: "counter", loc: "kiosk" });
    return Object.fromEntries(Object.entries(r.result).filter(([k]) => k !== "tempPassword"));
  };

  it("updateAdminUser keeps the account as it was", async () => {
    const u = await account();
    await send("u7", "PATCH", `/admin/users/${String(u.id)}`, { role: "counter", loc: "coffee" });
    expect((await lastEvent("updateAdminUser")).before).toEqual(maskSecrets(u));
  });

  it("deactivateAdminUser and reactivateAdminUser each keep the account as it was", async () => {
    const u = await account();
    const off = await send("u7", "POST", `/admin/users/${String(u.id)}/deactivate`);
    expect((await lastEvent("deactivateAdminUser")).before).toEqual(maskSecrets(u));
    await send("u7", "POST", `/admin/users/${String(u.id)}/reactivate`);
    expect((await lastEvent("reactivateAdminUser")).before).toEqual(maskSecrets(off.result));
  });

  it("resetAdminUserPassword keeps the account as it was", async () => {
    const u = await account();
    await send("u7", "POST", `/admin/users/${String(u.id)}/reset-password`);
    expect((await lastEvent("resetAdminUserPassword")).before).toEqual(maskSecrets(u));
  });

  it("deleteAdminUser keeps the account it removed", async () => {
    const u = await account();
    const off = await send("u7", "POST", `/admin/users/${String(u.id)}/deactivate`);
    await send("u7", "DELETE", `/admin/users/${String(u.id)}`);
    expect((await lastEvent("deleteAdminUser")).before).toEqual(maskSecrets(off.result));
  });
});
```

- [ ] **Step 14: Run it to verify it fails**

Run: `pnpm --filter @rch/api exec vitest run src/modules/audit-before.test.ts`
Expected: FAIL. The five account routes, across four cases, see `before: null`.

- [ ] **Step 15: Implement (staff accounts)**

`apps/api/src/modules/admin/service.ts`: replace

```ts
import { withTransaction, type Tx } from "../../lib/db.js";
```

with

```ts
import { withTransaction, type Tx } from "../../lib/db.js";
import { auditBefore } from "../../lib/audit.js";
```

In `resetPassword`, replace

```ts
        const row = await requireTx(tx, id);
        await resetPasswordTx(tx, row.empNo, tempPassword);
```

with

```ts
        const row = await requireTx(tx, id);
        auditBefore(toAdminUser(row));
        await resetPasswordTx(tx, row.empNo, tempPassword);
```

In `deactivate`, replace

```ts
        const row = await requireTx(tx, id);
        await deactivateUserTx(tx, row.empNo);
```

with

```ts
        const row = await requireTx(tx, id);
        auditBefore(toAdminUser(row));
        await deactivateUserTx(tx, row.empNo);
```

In `reactivate`, replace

```ts
        const row = await requireTx(tx, id);
        await reactivateUserTx(tx, row.empNo);
```

with

```ts
        const row = await requireTx(tx, id);
        auditBefore(toAdminUser(row));
        await reactivateUserTx(tx, row.empNo);
```

In `updateRoleLoc`, replace

```ts
        const row = await requireTx(tx, id);
        if (row.admin) throw new RuleError(`Refused - ${row.name} (${row.empNo}) is a super admin, and a super admin has no role or location to change`);
```

with

```ts
        const row = await requireTx(tx, id);
        auditBefore(toAdminUser(row));
        if (row.admin) throw new RuleError(`Refused - ${row.name} (${row.empNo}) is a super admin, and a super admin has no role or location to change`);
```

In `remove`, replace

```ts
        const row = await adminRepo.byIdForUpdate(tx, id);
        if (!row) throw new NotFoundError(`There is no account ${id}.`);
```

with

```ts
        const row = await adminRepo.byIdForUpdate(tx, id);
        if (!row) throw new NotFoundError(`There is no account ${id}.`);
        // The account as it was - the only record of its fields once the row is gone.
        auditBefore(toAdminUser(row));
```

- [ ] **Step 16: Run it to verify it passes**

Run: `pnpm --filter @rch/api exec vitest run src/modules/audit-before.test.ts src/modules/admin/admin.test.ts`
Expected: PASS (14 cases in `audit-before.test.ts`; the admin suite is unchanged).

- [ ] **Step 17: Run the package gates**

Run: `pnpm --filter @rch/api typecheck && pnpm --filter @rch/api lint && pnpm --filter @rch/api test`
Expected: PASS. Typecheck and zero-warning lint are clean; every suite passes and coverage is at or above lines 94 / branches 79.

- [ ] **Step 18: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add apps/api/src/modules/audit-before.test.ts apps/api/src/modules/catalog/service.ts apps/api/src/modules/availability/service.ts apps/api/src/modules/vendors/service.ts apps/api/src/modules/contracts/service.ts apps/api/src/modules/me/service.ts apps/api/src/modules/purchaseorders/service.ts apps/api/src/modules/admin/service.ts
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Keep the values an edit replaced in its audit event

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

### Task 6: API: sign-in, sign-out and password events

**Files:**
- Create: `apps/api/src/modules/auth/auth-audit.test.ts`
- Modify: `apps/api/src/modules/auth/service.ts`: `LoginRefused` (after `BAD_LOGIN`, line 16); `login` (lines 134-136); `logout` (lines 173-179); `changePassword` (line 194)
- Modify: `apps/api/src/modules/auth/routes.ts`: whole file
- Test: `apps/api/src/modules/auth/auth-audit.test.ts`, `apps/api/src/modules/auth/auth.test.ts` (unchanged, must stay green)

**Interfaces:**
- Consumes: from Task 2, `recordAuthEvent(db: Db, req: FastifyRequest, e: AuthEvent): Promise<void>`, `AuthEvent` with `request?: unknown` (stored as `maskSecrets(e.request)`; left out, the event keeps params and query, never the body), and `audit_outbox`. From Task 4, `app.auditSettled()`. From Task 1, `AuditEvent`.
- Produces: `LoginRefused`; `logout(raw): Promise<string | null>`. It also produces one outbox event for each of these: correct sign-in, wrong password, deactivated account, unknown id, per-employee lockout, per-IP lockout, sign-out, password change done, and password change refused.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/auth/auth-audit.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AuditEvent } from "@rch/contract";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import type { App } from "../../app.js";
import { users } from "../../db/schema/index.js";

/**
 * Sign-in events (spec §2.6). The auth routes are public or `write: false`, so `mount()` never
 * records them; the auth module does, one event per attempt.
 *
 * Two apps, like auth.test.ts. `a` raises the per-IP login budget out of reach, so only the
 * per-employee counter can refuse there; `b` keeps a per-IP budget of two, for the limiter's own
 * refusal. Each case signs in as a different seeded account, so a password changed or an id
 * locked in one case never reaches another.
 */
let a: App;
let b: App;
beforeAll(async () => {
  a = await buildTestApp({ schema: "auth_audit", env: { LOGIN_RATE_LIMIT_PER_MINUTE: "100" } });
  await seedTestDb(a.testDb!.db);
  await a.ready();
  b = await buildTestApp({ schema: "auth_audit_ip", env: { LOGIN_RATE_LIMIT_PER_MINUTE: "2" } });
  await seedTestDb(b.testDb!.db);
  await b.ready();
});
afterAll(async () => {
  await a.close();
  await b.close();
});

const login = (app: App, emp: string, password = "changeme") =>
  app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { emp, password } });
const cookieOf = (r: { cookies: Array<{ name: string; value: string }> }) => r.cookies.find((c) => c.name === "rch_refresh")!.value;
/** Outbox events, oldest first - all of them, or one action's. Read straight off the table, which
 *  only a test may do (scripts/check-boundaries.sh). Every sign-in event here is stored before its
 *  reply leaves, but a read of refusals waits on `auditSettled` all the same (D16), so nothing
 *  `plugins/audit.ts` is still storing can be missed. */
const events = async (app: App, action?: string): Promise<AuditEvent[]> => {
  await app.auditSettled();
  const r = action === undefined
    ? await app.testDb!.pool.query<{ event: AuditEvent }>("select event from audit_outbox order by id")
    : await app.testDb!.pool.query<{ event: AuditEvent }>("select event from audit_outbox where event->>'action' = $1 order by id", [action]);
  return r.rows.map((row) => row.event);
};
const last = async (app: App, action: string): Promise<AuditEvent> => {
  const all = await events(app, action);
  expect(all.length, `no ${action} event in the outbox`).toBeGreaterThan(0);
  return all.at(-1)!;
};

describe("sign-in events", () => {
  it("records a correct sign-in against the account", async () => {
    expect((await login(a, "RC-4471")).statusCode).toBe(200);
    expect(await last(a, "login")).toMatchObject({
      action: "login", outcome: "done", status: 200, message: "Signed in", cause: null,
      actor: { id: "u1", emp: "RC-4471", name: "Kavitha Raman" },
    });
  });

  it("records a wrong password against the account it named, with the cause the log line carries", async () => {
    const r = await login(a, "RC-3120", "nope");
    expect(r.statusCode).toBe(401);
    expect(await last(a, "login")).toMatchObject({
      outcome: "refused", status: 401, message: r.json().error.message, cause: "wrong password for RC-3120",
      actor: { id: "u2", emp: "RC-3120" },
    });
  });

  it("records a deactivated account's attempt against that account", async () => {
    await a.db.update(users).set({ active: false }).where(eq(users.id, "u6"));
    try {
      expect((await login(a, "RC-4482")).statusCode).toBe(401);
      expect(await last(a, "login")).toMatchObject({ outcome: "refused", status: 401, cause: "RC-4482 is deactivated", actor: { id: "u6", emp: "RC-4482" } });
    } finally {
      await a.db.update(users).set({ active: true }).where(eq(users.id, "u6"));
    }
  });

  it("records an unknown employee id with no account and the id that was typed", async () => {
    expect((await login(a, "RC-0000")).statusCode).toBe(401);
    expect(await last(a, "login")).toMatchObject({ outcome: "refused", status: 401, cause: "no such employee", actor: { id: null, emp: "RC-0000", name: "" } });
  });

  it("keeps nothing of a typed id that is not shaped like an employee number - it may have been the password", async () => {
    expect((await login(a, "hunter2 in the wrong box")).statusCode).toBe(401);
    expect(await last(a, "login")).toMatchObject({ outcome: "refused", cause: "no such employee", actor: { id: null, emp: "" } });
    expect(JSON.stringify(await events(a))).not.toContain("hunter2");
  });

  it("records the per-employee lockout", async () => {
    for (let i = 0; i < 5; i++) expect((await login(a, "RC-9998", "guess")).statusCode).toBe(401);
    const r = await login(a, "RC-9998", "guess");
    expect(r.statusCode).toBe(429);
    expect(await last(a, "login")).toMatchObject({
      outcome: "refused", status: 429, message: r.json().error.message,
      cause: "too many attempts for this employee id", actor: { id: null, emp: "RC-9998" },
    });
  });

  it("records the per-IP limiter's refusal, which the login handler never sees", async () => {
    expect((await login(b, "RC-4471", "wrong-1")).statusCode).toBe(401);
    expect((await login(b, "RC-4471", "wrong-2")).statusCode).toBe(401);
    const limited = await login(b, "RC-4471", "wrong-3");
    expect(limited.statusCode).toBe(429);
    const all = await events(b, "login");
    expect(all).toHaveLength(3);
    expect(all[2]).toMatchObject({
      outcome: "refused", status: 429, message: limited.json().error.message,
      cause: "per-IP sign-in limit", actor: { id: null, emp: "RC-4471" },
    });
  });
});

describe("sign-out and password events", () => {
  it("records a sign-out against the session's account, and nothing for a logout that ended no session", async () => {
    const cookie = cookieOf(await login(a, "RC-1902"));
    const before = (await events(a, "logout")).length;
    expect((await a.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { rch_refresh: cookie } })).statusCode).toBe(200);
    // The same cookie again: the family is already revoked, so nobody is signed out.
    expect((await a.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { rch_refresh: cookie } })).statusCode).toBe(200);
    expect((await a.inject({ method: "POST", url: "/api/v1/auth/logout" })).statusCode).toBe(200);
    const after = await events(a, "logout");
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({ outcome: "done", status: 200, message: "Signed out", actor: { id: "u4", emp: "RC-1902" } });
  });

  it("records a password change, and each refusal of one, against the account - one event each", async () => {
    const l = await login(a, "RC-1550");
    const change = (token: string, current: string, next: string) => a.inject({
      method: "POST", url: "/api/v1/auth/change-password", headers: { authorization: `Bearer ${token}` }, payload: { current, next },
    });
    const before = (await events(a, "changePassword")).length;

    expect((await change(l.json().accessToken, "wrong", "a-much-longer-secret-5")).statusCode).toBe(401);
    expect(await last(a, "changePassword")).toMatchObject({ outcome: "refused", status: 401, cause: "wrong current password", actor: { id: "u5" } });

    const ok = await change(l.json().accessToken, "changeme", "a-much-longer-secret-5");
    expect(ok.statusCode).toBe(200);
    expect(await last(a, "changePassword")).toMatchObject({ outcome: "done", status: 200, message: "Password changed - every other session was signed out", actor: { id: "u5", emp: "RC-1550" } });

    const same = await change(ok.json().accessToken, "a-much-longer-secret-5", "a-much-longer-secret-5");
    expect(same.statusCode).toBe(422);
    expect(await last(a, "changePassword")).toMatchObject({ outcome: "refused", status: 422, message: "Choose a different password from your current one.", actor: { id: "u5" } });

    expect(await events(a, "changePassword")).toHaveLength(before + 3);
  });

  it("never stores a password, a new password, a refresh token or an access token", async () => {
    const l = await login(a, "RC-2088");
    const firstCookie = cookieOf(l);
    const firstToken = l.json().accessToken as string;
    expect((await login(a, "RC-2088", "typed-wrong-secret-7")).statusCode).toBe(401);
    const cp = await a.inject({
      method: "POST", url: "/api/v1/auth/change-password", headers: { authorization: `Bearer ${firstToken}` },
      payload: { current: "changeme", next: "brand-new-secret-8" },
    });
    expect(cp.statusCode).toBe(200);
    const freshCookie = cookieOf(cp);
    expect((await a.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { rch_refresh: freshCookie } })).statusCode).toBe(200);

    const stored = JSON.stringify(await events(a));
    for (const secret of ["changeme", "typed-wrong-secret-7", "brand-new-secret-8", firstCookie, freshCookie, firstToken, cp.json().accessToken as string]) {
      expect(stored).not.toContain(secret);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rch/api exec vitest run src/modules/auth/auth-audit.test.ts`
Expected: FAIL. Every recording case fails with `no login event in the outbox` (or `logout` / `changePassword`), because nothing records sign-in events yet. Only the masking case passes, and only trivially, on an empty outbox.

- [ ] **Step 3: Carry the account on a refused sign-in, and the session on a sign-out**

`apps/api/src/modules/auth/service.ts`: replace

```ts
const BAD_LOGIN = "That employee id and password do not match.";
```

with

```ts
const BAD_LOGIN = "That employee id and password do not match.";

/**
 * A refused sign-in - an unknown id, a wrong password or a deactivated account. The caller reads
 * one sentence whichever it was (`BAD_LOGIN`); the reason (`cause`) goes onto the request's log
 * line, and the account the id named, when it named one, goes into the audit trail
 * (`modules/auth/routes.ts`). Neither reaches the wire: `toEnvelope()` carries only code and
 * message.
 */
export class LoginRefused extends UnauthenticatedError {
  readonly userId: string | null;
  constructor(cause: string, userId: string | null) {
    super(BAD_LOGIN, cause);
    this.userId = userId;
  }
}
```

In `login`, replace

```ts
      if (!u) throw new UnauthenticatedError(BAD_LOGIN, "no such employee");
      if (!ok) throw new UnauthenticatedError(BAD_LOGIN, `wrong password for ${u.empNo}`);
      if (!u.active) throw new UnauthenticatedError(BAD_LOGIN, `${u.empNo} is deactivated`);
```

with

```ts
      if (!u) throw new LoginRefused("no such employee", null);
      if (!ok) throw new LoginRefused(`wrong password for ${u.empNo}`, u.id);
      if (!u.active) throw new LoginRefused(`${u.empNo} is deactivated`, u.id);
```

Replace `logout`:

```ts
    async logout(raw: string | undefined): Promise<void> {
      if (!raw) return;
      await withTransaction(db, async (tx) => {
        const t = await authRepo.refreshByHash(tx, sha256(raw));
        if (t) await authRepo.revokeFamily(tx, t.family);
      });
    },
```

with

```ts
    /** Answers whose session this ended - the account, when the cookie's family still had a live
     *  token to revoke; `null` when it ended nothing (no cookie, an unknown one, or a family already
     *  revoked), which is not a sign-out anybody made. */
    async logout(raw: string | undefined): Promise<string | null> {
      if (!raw) return null;
      return withTransaction(db, async (tx) => {
        const t = await authRepo.refreshByHash(tx, sha256(raw));
        if (!t) return null;
        const revoked = await authRepo.revokeFamily(tx, t.family);
        return (revoked.rowCount ?? 0) > 0 ? t.userId : null;
      });
    },
```

In `changePassword`, replace

```ts
      if (!u || !ok || !u.active) throw new UnauthenticatedError("Your current password is not right.");
```

with

```ts
      // One sentence for all three, as at sign-in; the cause is for the log line and the audit trail.
      if (!u || !ok || !u.active) {
        throw new UnauthenticatedError("Your current password is not right.", !u ? "no such account" : !ok ? "wrong current password" : `${u.empNo} is deactivated`);
      }
```

- [ ] **Step 4: Record the events in the auth routes**

Replace `apps/api/src/modules/auth/routes.ts` with:

```ts
import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { recordAuthEvent, type AuthEvent } from "../../lib/audit.js";
import { AppError, RateLimitedError, UnauthenticatedError } from "../../lib/errors.js";
import { createAuthService, LoginRefused } from "./service.js";
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from "./cookies.js";

/** Per client IP, per pod, like the login limit - but kept apart from it and far looser. The
 *  sign-in screen reads the picker once each time it is opened, and a hospital's counters can
 *  all sit behind one address, so a shift change is many honest reads at once; what this stops
 *  is a script walking the page in a loop. The global limit still applies on top. */
const DIRECTORY_RATE_LIMIT_PER_MINUTE = 120;

/** What a sign-in event says when the attempt went through. A refusal carries the sentence the
 *  caller was actually shown instead. */
const SIGNED_IN = "Signed in";
const SIGNED_OUT = "Signed out";
const PASSWORD_CHANGED = "Password changed - every other session was signed out";
/** The two lockouts' causes, for the trail - neither refusal has one of its own. */
const PER_EMP_LIMIT = "too many attempts for this employee id";
const PER_IP_LIMIT = "per-IP sign-in limit";

/**
 * What the audit trail keeps of a typed employee id: the id when it is shaped like one (`RC-` and
 * digits, the only shape `nextEmpNo` hands out), and nothing otherwise. The log line has never kept
 * an unknown id at all (service.ts), because what was typed into that box may have been the
 * password. The trail is kept forever, so it keeps only the shape that cannot be one: "somebody
 * tried RC-0000" still reads, and a password typed into the wrong box never lands in it.
 */
const EMP_SHAPE = /^RC-\d+$/i;
const typedEmpOf = (emp: string | undefined): string => (emp !== undefined && EMP_SHAPE.test(emp) ? emp : "");

/** The refusal sentence out of an error envelope on its way to the socket. */
const sentenceOf = (payload: unknown): string => {
  if (typeof payload !== "string") return "";
  try { return (JSON.parse(payload) as { error?: { message?: string } }).error?.message ?? ""; } catch { return ""; }
};

export default fp(async (app) => {
  const svc = createAuthService(app.db, app.config);
  const meta = (req: { headers: Record<string, unknown>; ip: string }) => ({ userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200), ip: req.ip });
  const respond = async (reply: FastifyReply, s: Awaited<ReturnType<typeof svc.login>>) => {
    setRefreshCookie(reply, app.config, s.refreshToken, s.expiresAt);
    return { accessToken: await app.signAccess(s.claims), user: s.user, mustChangePassword: s.mustChangePassword };
  };
  /**
   * Sign-in events go to the outbox on the pool: there is no write transaction for them to ride
   * in (spec §2.6). One that cannot be stored is logged with the request id and never turns a
   * sign-in, or its refusal, into a 500 - the stance a refusal's event takes (plugins/audit.ts).
   * Every call names `request` itself, so no password, typed or new, is ever handed over.
   */
  const audit = (req: FastifyRequest, e: AuthEvent): Promise<void> =>
    recordAuthEvent(app.db, req, e).catch((err: unknown) => { req.log.error({ err, action: e.action, outcome: e.outcome }, "audit event not stored"); });
  /** Requests the login route's own per-IP limiter turned away. The limiter throws from a
   *  preHandler, so the handler below never runs for them: `onExceeded` marks the request, and the
   *  `onSend` hook at the bottom records it before the 429 leaves. */
  const ipLimited = new WeakSet<FastifyRequest>();

  mount(app, routes.login, async (req, reply) => {
    const typedEmp = typedEmpOf(req.body.emp);
    const request = { body: { emp: typedEmp } };
    try {
      const session = await svc.login(req.body.emp, req.body.password, meta(req));
      const body = await respond(reply, session);
      await audit(req, { action: "login", outcome: "done", status: 200, message: SIGNED_IN, actorId: session.user.id, request });
      return body;
    } catch (e) {
      if (e instanceof AppError) {
        await audit(req, {
          action: "login", outcome: "refused", status: e.status, message: e.message,
          cause: e instanceof RateLimitedError ? PER_EMP_LIMIT : e.cause ?? null,
          actorId: e instanceof LoginRefused ? e.userId : null, typedEmp, request,
        });
      }
      throw e;
    }
  }, { config: { rateLimit: {
    max: app.config.loginRateLimitPerMinute, timeWindow: "1 minute",
    onExceeded: (req: FastifyRequest) => { ipLimited.add(req); },
  } } });
  // Public, and deliberately so: it is read before anybody has signed in. It says who can sign
  // in (a number and a name) and nothing a password could be guessed from.
  mount(app, routes.signInDirectory, async () => svc.directory(),
    { config: { rateLimit: { max: DIRECTORY_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } } });
  mount(app, routes.refresh, async (req, reply) => {
    try {
      return await respond(reply, await svc.refresh(req.cookies[REFRESH_COOKIE], meta(req)));
    } catch (e) {
      // A dead refresh cookie (expired, revoked, or reused) is worth clearing client-side too,
      // so the browser stops presenting it on every subsequent request.
      if (e instanceof UnauthenticatedError) clearRefreshCookie(reply, app.config);
      throw e;
    }
  });
  mount(app, routes.logout, async (req, reply) => {
    const userId = await svc.logout(req.cookies[REFRESH_COOKIE]);
    clearRefreshCookie(reply, app.config);
    if (userId) await audit(req, { action: "logout", outcome: "done", status: 200, message: SIGNED_OUT, actorId: userId, request: {} });
    return { ok: true as const };
  });
  // The reply carries a whole new session: the change revoked every token the caller held.
  mount(app, routes.changePassword, async (req, reply) => {
    try {
      const body = await respond(reply, await svc.changePassword(req.user.sub, req.body.current, req.body.next, meta(req)));
      await audit(req, { action: "changePassword", outcome: "done", status: 200, message: PASSWORD_CHANGED, actorId: req.user.sub, request: {} });
      return body;
    } catch (e) {
      if (e instanceof AppError) {
        await audit(req, { action: "changePassword", outcome: "refused", status: e.status, message: e.message, cause: e.cause ?? null, actorId: req.user.sub, request: {} });
      }
      throw e;
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    if (!ipLimited.has(req)) return payload;
    ipLimited.delete(req);
    const typedEmp = typedEmpOf((req.body as { emp?: string } | undefined)?.emp);
    await audit(req, {
      action: "login", outcome: "refused", status: reply.statusCode, message: sentenceOf(payload),
      cause: PER_IP_LIMIT, actorId: null, typedEmp, request: { body: { emp: typedEmp } },
    });
    return payload;
  });
}, { name: "module:auth", dependencies: ["auth", "rbac", "db"] });
```

- [ ] **Step 5: Run the new tests and the existing auth suite**

Run: `pnpm --filter @rch/api exec vitest run src/modules/auth/auth-audit.test.ts src/modules/auth/auth.test.ts`
Expected: PASS. All cases in `auth-audit.test.ts` pass. `auth.test.ts` is unchanged and green, including "logs why it refused … and never logs an unknown id": the causes are the same strings, now carried by `LoginRefused`.

- [ ] **Step 6: Run the package gates**

Run: `pnpm --filter @rch/api typecheck && pnpm --filter @rch/api lint && pnpm --filter @rch/api test`
Expected: PASS, with coverage at or above lines 94 / branches 79.

- [ ] **Step 7: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add apps/api/src/modules/auth/routes.ts apps/api/src/modules/auth/service.ts apps/api/src/modules/auth/auth-audit.test.ts
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Record sign-ins, failed sign-ins, lockouts, sign-outs and password changes in the audit outbox

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

### Task 7: API: `audit` notices to admin streams only

**Files:**
- Modify: `apps/api/src/plugins/sse.ts`: `Stream` type (line 24); `publish` (lines 60-62); the stream object in the route (lines 204-207)
- Test: `apps/api/src/plugins/sse.test.ts`: one case added after "drops a notice it cannot read, and goes on listening"

**Interfaces:**
- Consumes: `"audit"` in `CollectionSchema` / `Changed` (Task 1); `AccessClaims.admin` (existing)
- Produces: `publish` delivers a `changed` frame for `audit` only to streams opened by an admin token. Every other collection still goes to every stream. The UI's `audit` reader (Task 13) and the drainer's notice (Task 11) rely on this.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/plugins/sse.test.ts`, insert this case directly after the closing `});` of `it("drops a notice it cannot read, and goes on listening", …)`:

```ts
  it("sends an audit notice to a super admin's stream and to nobody else's, while every other collection reaches both", async () => {
    // u7 is the seeded super admin (RC-0001); its token carries `admin: true`, which the stream records.
    const admin = await open("u7");
    const counter = await open("u1");
    await admin.until((x) => x.includes("retry:"));
    await counter.until((x) => x.includes("retry:"));

    // What the audit service's drainer sends once it has stored a batch (spec §3.3), on the
    // channel this pod listens to.
    const notice = JSON.stringify({ collections: ["audit"], at: new Date().toISOString() });
    await app.db.execute(sql`select pg_notify('rch_events_' || current_schema(), ${notice})`);
    const got = await admin.until((x) => x.includes('"collection":"audit"'));
    const frame = got.split("\n\n").find((f) => f.includes('"collection":"audit"'))!;
    expect(frame).toMatch(/^event: changed$/m);
    expect(await counter.drain(500)).not.toContain('"collection":"audit"');

    // The filter is on `audit` alone: an ordinary write still reaches both.
    const adminMark = admin.seen().length;
    const counterMark = counter.seen().length;
    expect((await toggleJuice()).status).toBe(200);
    await admin.until((x) => x.slice(adminMark).includes('"collection":"ovr"'));
    await counter.until((x) => x.slice(counterMark).includes('"collection":"ovr"'));
    admin.close(); counter.close();
    await settle();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rch/api exec vitest run src/plugins/sse.test.ts -t "audit notice"`
Expected: FAIL at `expect(await counter.drain(500)).not.toContain('"collection":"audit"')`, because the counter's stream receives the audit frame today.

- [ ] **Step 3: Implement**

`apps/api/src/plugins/sse.ts`: replace

```ts
type Stream = { write(frame: string): void; end(): void };
```

with

```ts
/** `admin` is whether the token that opened the stream carries the admin claim - `publish` sends
 *  the audit log's notices to those streams only. */
type Stream = { write(frame: string): void; end(): void; admin: boolean };
```

Replace

```ts
  const publish = (n: ChangeNotice) => {
    for (const collection of n.collections) broadcast(frame(nextId(), "changed", JSON.stringify({ collection, at: n.at })));
  };
```

with

```ts
  /**
   * Every collection to every stream, but one: `audit` is the super admin's log, which no other
   * screen reads. Sent anywhere else it would wake every till to refetch nothing, and tell each of
   * them how often somebody's actions are being written down.
   */
  const publish = (n: ChangeNotice) => {
    for (const collection of n.collections) {
      const text = frame(nextId(), "changed", JSON.stringify({ collection, at: n.at }));
      for (const s of streams) if (collection !== "audit" || s.admin) s.write(text);
    }
  };
```

Replace

```ts
    const stream: Stream = {
      write: (text) => { try { res.write(text); } catch { /* the socket went; the close handler below cleans up */ } },
      end: () => { try { res.end(); } catch { /* already gone */ } },
    };
```

with

```ts
    const stream: Stream = {
      write: (text) => { try { res.write(text); } catch { /* the socket went; the close handler below cleans up */ } },
      end: () => { try { res.end(); } catch { /* already gone */ } },
      admin: req.user.admin,
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rch/api exec vitest run src/plugins/sse.test.ts`
Expected: PASS. The whole SSE suite passes, including "counts open streams in /metrics", which relies on the new case closing both streams and settling.

- [ ] **Step 5: Run the package gates**

Run: `pnpm --filter @rch/api typecheck && pnpm --filter @rch/api lint && pnpm --filter @rch/api test`
Expected: PASS, with coverage at or above lines 94 / branches 79.

- [ ] **Step 6: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add apps/api/src/plugins/sse.ts apps/api/src/plugins/sse.test.ts
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Send audit log notices to the super admin's streams only

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

### Task 8: API: runtime role, migrate role setup, CLIs on the migrate URL

**Files:**
- Create: `apps/api/src/lib/roles.ts`
- Create: `apps/api/src/lib/roles.test.ts`
- Modify: `apps/api/src/config.ts`: `Env` (after `DATABASE_URL`, line 10); `Config` (after `databaseUrl`, line 47); `loadConfig` (after `databaseUrl`, line 105); new export `cliDatabaseUrl` at the end
- Modify: `apps/api/src/config.test.ts`: import line 2; one case appended inside `describe("loadConfig")`
- Modify: `apps/api/src/cli/migrate.ts` (whole file), `apps/api/src/cli/seed.ts` (lines 2, 16), `apps/api/src/cli/rebuild-balances.ts` (lines 1, 8), `apps/api/src/cli/users.ts` (lines 2, 34), `apps/api/src/cli/payers.ts` (lines 4, 25), `apps/api/src/cli/purge.ts` (lines 1, 12)
- Modify: `.env.example` (after `DATABASE_URL`), `turbo.json` (`test.env`)
- Test: `apps/api/src/lib/roles.test.ts`, `apps/api/src/config.test.ts`

**Interfaces:**
- Consumes: the `audit_outbox` table with its identity column `id` and its `BEFORE UPDATE` refusal trigger (Task 2, migration `0016_audit_outbox`; a privilege check runs before any trigger, so the runtime role's UPDATE is refused with 42501, not by the trigger); `withTestSchema`, `TestDb` (`src/test/db.ts`); `withTransaction` (`lib/db.ts`)
- Produces (shared): `config.migrateDatabaseUrl: string | undefined`; `cliDatabaseUrl(c: Config): string`; `LoginRole`; `roleFromUrls(runtimeUrl, migrateUrl): LoginRole | null`; `ensureLoginRole(db, role)`; `grantAppRole(db, role, { schema, migrationsSchema })`
- Produces (addition): `applyAppRole(db, { runtime, migrate }, { schema, migrationsSchema }): Promise<string | null>`. Task 16's Compose `migrate` service and Task 17's chart rely on `cli/migrate.ts` creating and granting `rch_app` whenever `DATABASE_URL` names a different user from `MIGRATE_DATABASE_URL`.

- [ ] **Step 1: Write the failing config test**

`apps/api/src/config.test.ts`: replace

```ts
import { ConfigError, loadConfig } from "./config.js";
```

with

```ts
import { cliDatabaseUrl, ConfigError, loadConfig } from "./config.js";
```

and append inside `describe("loadConfig", () => { … })`, after its last case:

```ts
  it("gives the operator CLIs MIGRATE_DATABASE_URL, and DATABASE_URL where there is none", () => {
    const one = loadConfig(good);
    expect(one.migrateDatabaseUrl).toBeUndefined();
    expect(cliDatabaseUrl(one)).toBe("postgres://u:p@h:5432/d");
    const two = loadConfig({ ...good, MIGRATE_DATABASE_URL: "postgres://rch:owner@h:5432/d" });
    expect(two.migrateDatabaseUrl).toBe("postgres://rch:owner@h:5432/d");
    expect(two.databaseUrl).toBe("postgres://u:p@h:5432/d");
    expect(cliDatabaseUrl(two)).toBe("postgres://rch:owner@h:5432/d");
    expect(() => loadConfig({ ...good, MIGRATE_DATABASE_URL: "mysql://rch:owner@h/d" })).toThrow(ConfigError);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rch/api exec vitest run src/config.test.ts`
Expected: FAIL. `cliDatabaseUrl` is not exported (`cliDatabaseUrl is not a function`).

- [ ] **Step 3: Implement the config**

`apps/api/src/config.ts`: replace

```ts
  DATABASE_URL: z.url().startsWith("postgres"),
```

with

```ts
  DATABASE_URL: z.url().startsWith("postgres"),
  /** Who the migrate step and the operator CLIs connect as (`cliDatabaseUrl`). Unset, they use
   *  DATABASE_URL - local development and the tests, where one user does everything. Set to a
   *  different user, `db:migrate` also makes DATABASE_URL's user the API's least-privilege role
   *  (`lib/roles.ts`). The server itself never reads it. */
  MIGRATE_DATABASE_URL: z.url().startsWith("postgres").optional(),
```

Replace

```ts
  databaseUrl: string;
  testDatabaseUrl?: string;
```

with

```ts
  databaseUrl: string;
  migrateDatabaseUrl: string | undefined;
  testDatabaseUrl?: string;
```

Replace

```ts
    databaseUrl: e.DATABASE_URL,
    testDatabaseUrl: e.TEST_DATABASE_URL,
```

with

```ts
    databaseUrl: e.DATABASE_URL,
    migrateDatabaseUrl: e.MIGRATE_DATABASE_URL,
    testDatabaseUrl: e.TEST_DATABASE_URL,
```

Append at the end of the file:

```ts

/** The URL an operator CLI connects with: the migrate user where one is configured, the runtime
 *  URL otherwise. `buildApp` never uses it - the server always connects with `databaseUrl`, which in
 *  a deployment is the runtime role that cannot read or rewrite the audit outbox. */
export const cliDatabaseUrl = (c: Config): string => c.migrateDatabaseUrl ?? c.databaseUrl;
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @rch/api exec vitest run src/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing roles test**

Create `apps/api/src/lib/roles.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { withTestSchema, type TestDb } from "../test/db.js";
import { applyAppRole, ensureLoginRole, grantAppRole, roleFromUrls } from "./roles.js";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test";
/** Roles belong to the cluster, not to a schema, so the name carries the pid for the same reason
 *  test schemas do: two checkouts on one Postgres must not grant or drop each other's. */
const ROLE = `t_app_${process.pid}`;
const FIRST = "t-app-password-1";
const SECOND = "t-app-password-2";
const DENIED = { code: "42501" };
const as = (url: string, user: string, password: string): string => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};

describe("roleFromUrls", () => {
  it("answers null when both URLs name the same user - migrate as the runtime user, and leave roles alone", () => {
    expect(roleFromUrls("postgres://rch:rch@localhost:5439/rch", "postgres://rch:other@db:5432/rch")).toBeNull();
  });
  it("reads the runtime role's name and its decoded password", () => {
    expect(roleFromUrls("postgres://rch_app:p%40ss%3Aw0rd@postgres:5432/rch", "postgres://rch:rch@postgres:5432/rch"))
      .toEqual({ name: "rch_app", password: "p@ss:w0rd" });
  });
  it("refuses a runtime URL that names somebody else without a password, or names nobody", () => {
    expect(() => roleFromUrls("postgres://rch_app@postgres:5432/rch", "postgres://rch:rch@postgres:5432/rch")).toThrow(/carries no password/);
    expect(() => roleFromUrls("postgres://postgres:5432/rch", "postgres://rch:rch@postgres:5432/rch")).toThrow(/names no user/);
  });
});

describe("the API's runtime role", () => {
  let t: TestDb;
  let asApp: Pool;
  const other = `t_roles_other_${process.pid}`;
  const opts = () => ({ schema: t.schemaName, migrationsSchema: t.schemaName });
  const connectAs = (password: string) => new Pool({ connectionString: as(BASE, ROLE, password), max: 1, options: `-c search_path=${t.schemaName}` });
  /** `drop owned by` first: the role holds grants and default privileges, and a role with either
   *  cannot be dropped. Also clears what a crashed earlier run with this pid left behind. */
  const dropRole = async (admin: Pool) => {
    const { rows } = await admin.query("select 1 from pg_roles where rolname = $1", [ROLE]);
    if (rows.length === 0) return;
    await admin.query(`drop owned by "${ROLE}"`);
    await admin.query(`drop role "${ROLE}"`);
  };

  beforeAll(async () => {
    t = await withTestSchema("roles");
    const admin = new Pool({ connectionString: BASE, max: 1 });
    await dropRole(admin);
    // A schema the role is never granted, with a table in it: the stand-in for every schema that
    // is not the API's own (`audit`, `audit_drizzle` in a deployment).
    await admin.query(`drop schema if exists "${other}" cascade`);
    await admin.query(`create schema "${other}"`);
    await admin.query(`create table "${other}".kept (id int)`);
    await admin.end();
    await ensureLoginRole(t.db, { name: ROLE, password: FIRST });
    await grantAppRole(t.db, ROLE, opts());
    asApp = connectAs(FIRST);
  });
  afterAll(async () => {
    await asApp.end();
    const admin = new Pool({ connectionString: BASE, max: 1 });
    await dropRole(admin);
    await admin.query(`drop schema if exists "${other}" cascade`);
    await admin.end();
    await t.close();
  });

  it("reads and writes an ordinary table", async () => {
    await expect(asApp.query("insert into vendors (id, name) values ('VN-ROLE', 'Role probe')")).resolves.toMatchObject({ rowCount: 1 });
    await expect(asApp.query("update vendors set contact = 'probe' where id = 'VN-ROLE'")).resolves.toMatchObject({ rowCount: 1 });
    await expect(asApp.query("select id from vendors where id = 'VN-ROLE'")).resolves.toMatchObject({ rowCount: 1 });
    await expect(asApp.query("delete from vendors where id = 'VN-ROLE'")).resolves.toMatchObject({ rowCount: 1 });
  });

  it("reads the migrations bookkeeping, which /readyz counts", async () => {
    const { rows } = await asApp.query<{ n: number }>(`select count(*)::int as n from "${t.schemaName}"."__drizzle_migrations"`);
    expect(rows[0]!.n).toBeGreaterThan(0);
  });

  it("can add to the audit outbox and can do nothing else with it", async () => {
    await expect(asApp.query("insert into audit_outbox (event) values ('{}'::jsonb)")).resolves.toMatchObject({ rowCount: 1 });
    await expect(asApp.query("select id from audit_outbox")).rejects.toMatchObject(DENIED);
    await expect(asApp.query("update audit_outbox set event = '{}'::jsonb")).rejects.toMatchObject(DENIED);
    await expect(asApp.query("delete from audit_outbox")).rejects.toMatchObject(DENIED);
    await expect(asApp.query("truncate audit_outbox")).rejects.toMatchObject(DENIED);
  });

  it("can neither create a table nor read a schema it was not granted", async () => {
    await expect(asApp.query("create table role_probe (id int)")).rejects.toMatchObject(DENIED);
    await expect(asApp.query(`select id from "${other}".kept`)).rejects.toMatchObject(DENIED);
  });

  it("leaves roles alone when the runtime and migrate URLs name the same user", async () => {
    expect(await applyAppRole(t.db, { runtime: BASE, migrate: BASE }, opts())).toBeNull();
  });

  it("re-runs cleanly on the next deploy: the password follows the URL and the outbox stays insert-only", async () => {
    expect(await applyAppRole(t.db, { runtime: as(BASE, ROLE, SECOND), migrate: BASE }, opts())).toBe(ROLE);
    const again = connectAs(SECOND);
    try {
      await expect(again.query("insert into audit_outbox (event) values ('{}'::jsonb)")).resolves.toMatchObject({ rowCount: 1 });
      await expect(again.query("select id from audit_outbox")).rejects.toMatchObject(DENIED);
    } finally {
      await again.end();
    }
    const stale = connectAs(FIRST);
    try {
      await expect(stale.query("select 1")).rejects.toMatchObject({ code: "28P01" });
    } finally {
      await stale.end();
    }
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @rch/api exec vitest run src/lib/roles.test.ts`
Expected: FAIL with `Failed to load url ./roles.js` (the module does not exist).

- [ ] **Step 7: Implement `lib/roles.ts`**

Create `apps/api/src/lib/roles.ts`:

```ts
// The API's runtime role: created, given its password and granted by the migrate step - never by
// the API, which runs as that role and so could not. Spec §4; deploy/RUNBOOK.md for the operator's
// side of it.
import { sql } from "drizzle-orm";
import { escapeIdentifier, escapeLiteral } from "pg";
import type { Db } from "../db/client.js";
import { withTransaction } from "./db.js";

export type LoginRole = { name: string; password: string };

/** Named once, so the statements below read as what they do, and so a grep for statements
 *  against the table (scripts/check-boundaries.sh) meets the name in one declaration. */
const OUTBOX = "audit_outbox";

const userOf = (url: string): LoginRole => {
  const u = new URL(url);
  return { name: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
};

/**
 * The role the API is to run as, read off the two URLs the migrate step is handed: the runtime
 * `DATABASE_URL` names it and carries its password; `MIGRATE_DATABASE_URL` is who is migrating.
 *
 * `null` when both name the same user. That is local development and every test suite - one `rch`
 * for everything - and it means "migrate, and leave roles alone": there is nobody to create, and
 * granting a superuser what it already holds would only be noise.
 *
 * A runtime URL naming somebody else must say who and with what password, because the password is
 * set from it. Without one the role would exist with no way in, and the API would fail its first
 * query instead of this deploy step failing with a sentence.
 */
export function roleFromUrls(runtimeUrl: string, migrateUrl: string): LoginRole | null {
  const runtime = userOf(runtimeUrl);
  if (runtime.name === userOf(migrateUrl).name) return null;
  if (!runtime.name) throw new Error("DATABASE_URL names no user - the API's runtime role is read from it");
  if (!runtime.password) throw new Error(`DATABASE_URL names ${runtime.name} but carries no password - the migrate step sets the role's password from it`);
  return runtime;
}

/**
 * Create the role if it is missing, then set its password - on every run, so rotating it is
 * editing the URL and redeploying.
 *
 * The migrate CLI runs this inside its advisory lock, so two replicas never race the existence
 * check. `ALTER ROLE` takes no bind parameters, so the password goes in as an escaped literal, and
 * a failure is re-thrown without the statement: Drizzle's own error quotes the SQL it ran, which
 * here would print the password into the deploy log.
 */
export async function ensureLoginRole(db: Db, role: LoginRole): Promise<void> {
  const name = escapeIdentifier(role.name);
  const { rows } = await db.execute(sql`select 1 from pg_roles where rolname = ${role.name}`);
  if (rows.length === 0) await db.execute(sql.raw(`create role ${name} login`));
  try {
    await db.execute(sql.raw(`alter role ${name} with login password ${escapeLiteral(role.password)}`));
  } catch (err) {
    const code = (err as { cause?: { code?: string } } | null)?.cause?.code ?? "unknown";
    throw new Error(`could not set the password of role ${role.name} (Postgres error ${code})`);
  }
}

/**
 * Everything the API needs and nothing more (spec §4), re-granted on every run so a table a new
 * migration adds is covered in the deploy that brings it:
 *
 * - DML on every table in the app schema and use of its sequences - never TRUNCATE, never DDL;
 * - the same, by default, on tables the migrating role creates there later, as a backstop;
 * - read on the migrations bookkeeping, which `/readyz` counts;
 * - on the audit outbox, INSERT and nothing else. The blanket grant hands it SELECT, UPDATE and
 *   DELETE like any other table, so they are revoked straight after, in the same transaction:
 *   there is no committed moment at which the API's credentials could read or rewrite the log.
 *
 * One transaction, so a failure part-way leaves the previous deploy's grants standing.
 */
export async function grantAppRole(db: Db, role: string, opts: { schema: string; migrationsSchema: string }): Promise<void> {
  const r = escapeIdentifier(role);
  const s = escapeIdentifier(opts.schema);
  const m = escapeIdentifier(opts.migrationsSchema);
  const outbox = `${s}.${escapeIdentifier(OUTBOX)}`;
  await withTransaction(db, async (tx) => {
    const { rows } = await tx.execute<{ seq: string | null }>(sql`select pg_get_serial_sequence(${outbox}, 'id') as seq`);
    const seq = rows[0]?.seq;
    if (!seq) throw new Error(`${opts.schema}.${OUTBOX} has no identity sequence - run the migrations before granting`);
    const statements = [
      `grant usage on schema ${s} to ${r}`,
      `grant select, insert, update, delete on all tables in schema ${s} to ${r}`,
      `grant usage, select on all sequences in schema ${s} to ${r}`,
      `alter default privileges in schema ${s} grant select, insert, update, delete on tables to ${r}`,
      `alter default privileges in schema ${s} grant usage, select on sequences to ${r}`,
      `grant usage on schema ${m} to ${r}`,
      `grant select on ${m}."__drizzle_migrations" to ${r}`,
      `revoke all on table ${outbox} from ${r}`,
      `grant insert on table ${outbox} to ${r}`,
      `revoke all on sequence ${seq} from ${r}`,
      `grant usage on sequence ${seq} to ${r}`,
    ];
    for (const statement of statements) await tx.execute(sql.raw(statement));
  });
}

/** The migrate step's whole role setup: nothing when both URLs name the same user; otherwise the
 *  role, its password and its grants. Answers the role it set up, for the CLI's log line. */
export async function applyAppRole(db: Db, urls: { runtime: string; migrate: string }, opts: { schema: string; migrationsSchema: string }): Promise<string | null> {
  const role = roleFromUrls(urls.runtime, urls.migrate);
  if (!role) return null;
  await ensureLoginRole(db, role);
  await grantAppRole(db, role.name, opts);
  return role.name;
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm --filter @rch/api exec vitest run src/lib/roles.test.ts`
Expected: PASS (9 tests). Then confirm nothing was left behind:
Run: `psql "postgres://rch:rch@localhost:5439/rch_test" -Atc "select count(*) from pg_roles where rolname like 't_app_%'"`
Expected: `0`.

- [ ] **Step 9: Point every CLI at the migrate URL, and set the role up in `migrate`**

Replace `apps/api/src/cli/migrate.ts` with:

```ts
import { sql } from "drizzle-orm";
import { cliDatabaseUrl, loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { appliedMigrationCount, expectedMigrationCount, runMigrations } from "../db/migrate.js";
import { applyAppRole } from "../lib/roles.js";

const config = loadConfig(process.env);
// statementTimeoutMs: 0 - a migration, and a replica waiting its turn on the advisory lock
// below, are both allowed to take longer than the 15 s a request may. Connected as the migrate
// user: the runtime role DATABASE_URL names can create nothing, and is what this step sets up.
const { db, pool } = createDb(cliDatabaseUrl(config), config.databaseSsl, { max: 1, statementTimeoutMs: 0 });
// This CLI runs as an initContainer on every api pod, so several replicas can start it at
// once during a rollout; a Postgres advisory lock makes only one of them actually migrate
// while the rest block here, then find nothing left to apply. `max: 1` above pins the pool
// to a single connection, so the lock/unlock pair below runs on the same session as
// runMigrations - advisory locks are session-scoped, not transaction-scoped.
//
// Waiting for that lock is the whole point of this initContainer, so the wait is unbounded on
// purpose: `lock_timeout = 0` says so explicitly rather than relying on the server's default,
// which a role or database setting could have moved. Set on the session, which `max: 1` makes
// the same session every statement below runs on.
await db.execute(sql`set lock_timeout = 0`);
await db.execute(sql`select pg_advisory_lock(727272)`);
await runMigrations(db);
console.log(`migrations applied: ${await appliedMigrationCount(db)} / ${expectedMigrationCount()}`);
// Still inside the lock, and after the migrations, so every table the grants name exists and no
// second replica is creating the role beside this one.
const role = await applyAppRole(db, { runtime: config.databaseUrl, migrate: cliDatabaseUrl(config) }, { schema: "public", migrationsSchema: "drizzle" });
console.log(role
  ? `runtime role ${role}: login, password and grants set (insert-only on the audit outbox)`
  : "runtime role: skipped - DATABASE_URL and MIGRATE_DATABASE_URL name the same user");
await db.execute(sql`select pg_advisory_unlock(727272)`);
await pool.end();
```

`apps/api/src/cli/seed.ts`: replace

```ts
import { loadConfig } from "../config.js";
```

with

```ts
import { cliDatabaseUrl, loadConfig } from "../config.js";
```

and replace

```ts
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 2, statementTimeoutMs: 0 });
```

with

```ts
const { db, pool } = createDb(cliDatabaseUrl(config), config.databaseSsl, { max: 2, statementTimeoutMs: 0 });
```

`apps/api/src/cli/rebuild-balances.ts`: replace

```ts
import { loadConfig } from "../config.js";
```

with

```ts
import { cliDatabaseUrl, loadConfig } from "../config.js";
```

and replace

```ts
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1, statementTimeoutMs: 0 });
```

with

```ts
const { db, pool } = createDb(cliDatabaseUrl(config), config.databaseSsl, { max: 1, statementTimeoutMs: 0 });
```

`apps/api/src/cli/users.ts`: replace

```ts
import { loadConfig } from "../config.js";
```

with

```ts
import { cliDatabaseUrl, loadConfig } from "../config.js";
```

and replace

```ts
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1 });
```

with

```ts
const { db, pool } = createDb(cliDatabaseUrl(config), config.databaseSsl, { max: 1 });
```

`apps/api/src/cli/payers.ts`: replace

```ts
import { loadConfig } from "../config.js";
```

with

```ts
import { cliDatabaseUrl, loadConfig } from "../config.js";
```

and replace

```ts
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1, statementTimeoutMs: 0 });
```

with

```ts
const { db, pool } = createDb(cliDatabaseUrl(config), config.databaseSsl, { max: 1, statementTimeoutMs: 0 });
```

`apps/api/src/cli/purge.ts`: replace

```ts
import { loadConfig } from "../config.js";
```

with

```ts
import { cliDatabaseUrl, loadConfig } from "../config.js";
```

and replace

```ts
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1, statementTimeoutMs: 0 });
```

with

```ts
const { db, pool } = createDb(cliDatabaseUrl(config), config.databaseSsl, { max: 1, statementTimeoutMs: 0 });
```

Then confirm no CLI still connects with the runtime URL:
Run: `grep -n "createDb(config.databaseUrl" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/cli/*.ts`
Expected: no output (grep exits 1).

- [ ] **Step 10: Name the variable for local dev and for turbo**

`.env.example`: replace

```
DATABASE_URL=postgres://rch:rch@localhost:5439/rch
TEST_DATABASE_URL=postgres://rch:rch@localhost:5439/rch_test
```

with

```
DATABASE_URL=postgres://rch:rch@localhost:5439/rch
# Who db:migrate and the operator CLIs (seed, users, payers, purge, rebuild-balances) connect as.
# Unset, they use DATABASE_URL. Set to a different user, db:migrate also creates DATABASE_URL's user
# as a login role, sets its password from that URL, and grants it the API's least privileges
# (insert-only on audit_outbox). Locally one user does everything, so it stays commented out.
# MIGRATE_DATABASE_URL=postgres://rch:rch@localhost:5439/rch
TEST_DATABASE_URL=postgres://rch:rch@localhost:5439/rch_test
```

`turbo.json`: replace

```jsonc
    "test":      { "dependsOn": ["^typecheck"], "cache": false, "env": ["DATABASE_URL", "TEST_DATABASE_URL"] },
```

with

```jsonc
    "test":      { "dependsOn": ["^typecheck"], "cache": false, "env": ["DATABASE_URL", "TEST_DATABASE_URL", "MIGRATE_DATABASE_URL"] },
```

- [ ] **Step 11: Prove the migrate CLI's skipped path against the dev database**

Run: `pnpm --filter @rch/api db:migrate`
Expected: exits 0, and prints `migrations applied: N / N` followed by `runtime role: skipped - DATABASE_URL and MIGRATE_DATABASE_URL name the same user`.

- [ ] **Step 12: Run the package gates**

Run: `pnpm --filter @rch/api typecheck && pnpm --filter @rch/api lint && pnpm --filter @rch/api test`
Expected: PASS. Typecheck and zero-warning lint are clean (knip sees `ensureLoginRole`, `grantAppRole`, `roleFromUrls` and `applyAppRole` used from `roles.test.ts` and `cli/migrate.ts`), and coverage is at or above lines 94 / branches 79.

- [ ] **Step 13: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add apps/api/src/config.ts apps/api/src/config.test.ts apps/api/src/lib/roles.ts apps/api/src/lib/roles.test.ts apps/api/src/cli/migrate.ts apps/api/src/cli/seed.ts apps/api/src/cli/rebuild-balances.ts apps/api/src/cli/users.ts apps/api/src/cli/payers.ts apps/api/src/cli/purge.ts .env.example turbo.json
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Run the API as a least-privilege role and the operator CLIs on the migrate URL

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

<!-- Part 04 of the audit log service plan: Tasks 9 and 10 (apps/audit scaffold and storage). -->

#### Interface additions

Everything below is **in addition to** the Shared Interfaces; no shared name is renamed. Tasks 11 and 12 may rely on all of it.

```ts
// apps/audit/src/config.ts
export class ConfigError extends Error {}                  // loadConfig throws it; server.ts and cli/migrate.ts exit 2 on it
// AuditConfig is Readonly<…>; two field types are narrower/wider than the shared sketch:
//   logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
//   trustProxy: boolean | string | ((address: string, hop: number) => boolean);   // as apps/api: Fastify 5 ignores a bare number
// Defaults beyond the spec: DB_POOL_MAX 5. Limits: AUDIT_SCHEMA ≤ 55 chars (room for "_drizzle"), EVENTS_SCHEMA ≤ 52
// (room for "rch_events_"), OUTBOX_SCHEMA ≤ 63; all /^[a-z_][a-z0-9_]*$/, never "pg_…"; AUDIT_SCHEMA ≠ "public",
// ≠ OUTBOX_SCHEMA, ≠ EVENTS_SCHEMA. JWT keys must decode to a PEM public key; a blank JWT_PREVIOUS_PUBLIC_KEY is none.

// apps/audit/src/app.ts
export type AppDeps = { db?: Db; pool?: Pool; searchPath?: string; logStream?: LogStream; drainer?: boolean; cleanup?: () => Promise<void> };
// `cleanup` runs after every plugin's onClose (it is the first onClose hook added; avvio runs them newest first).
// buildTestApp passes testDb.close there, so a plugin's onClose (the drainer's) still has the pool.
// `drainer` is declared from Task 9 on and read first by Task 11's plugin; Task 10's harness passes opts.drainer through unchanged.

// apps/audit/src/plugins/health.ts - the "pluggable readiness checks" hook-in point (fp name "health")
app.readiness: { addCheck(name: string, check: () => Promise<boolean | void> | boolean | void): void; setDraining(): void };
// Accepts both settled forms: a check fails by returning false (reported as "<name>") or by throwing
// (reported as "<name> - <message>"); returning true or nothing passes. /readyz: 503 "Not ready: a - why, b."
// Task 11 registers app.readiness.addCheck("drainer", async () => { throw new Error("…") }) - that compiles as is.

// apps/audit/src/plugins/metrics.ts
app.metrics: { registry: Registry };   // Task 11 creates its audit_* series with `registers: [app.metrics.registry]`

// apps/audit/src/plugins/db.ts  - fp name "db", dependencies ["health", "metrics"]
app.db: Db; app.pool: Pool;           // plus pg_pool_total / pg_pool_idle / pg_pool_waiting gauges and the "database" readiness check

// apps/audit/src/lib/errors.ts
export type ErrorCode = "validation" | "unauthenticated" | "forbidden" | "not_found" | "not_ready" | "internal";
// exports AppError, ValidationError (400), UnauthenticatedError (401), ForbiddenError (403), NotFoundError (404), NotReadyError (503)

// apps/audit/src/db/client.ts
// No `Tx` here: Task 12's src/lib/db.ts defines Tx / Reader / withReadTransaction.
export function pgSsl(ssl: boolean): ConnectionOptions | undefined;   // for the drainer's LISTEN client
export function withoutSslParams(url: string): string;                // idem
export function createDb(url: string, ssl: boolean, opts: { max: number; searchPath?: string; statementTimeoutMs?: number }): { db: Db; pool: Pool };

// apps/audit/src/db/migrate.ts
export const migrationsSchemaOf: (auditSchema: string) => string;    // `${auditSchema}_drizzle`

// apps/audit/src/db/schema.ts
export const events: PgTable;        // constraint names events_outbox_id_uq (unique outbox_id), events_outcome_ck
export const deadLetters: PgTable;
// drizzle/0000_audit_events.sql also creates function audit_append_only() and statement-level triggers
// events_append_only / dead_letters_append_only (BEFORE UPDATE OR DELETE OR TRUNCATE), message
// "<table> is append-only; the audit log is never edited".

// apps/audit/src/lib/roles.ts
export type LoginRole = { name: string; password: string };

// apps/audit/src/lib/migrate-run.ts (new file: the migrate CLI's logic, so it is testable)
export const AUDIT_MIGRATE_LOCK = 727273;   // held for the whole step
export const API_MIGRATE_LOCK = 727272;     // also held around ensureLoginRole + grantAuditRole (both migrate steps GRANT on audit_outbox)
export const OUTBOX_WAIT: { readonly timeoutMs: 300_000; readonly intervalMs: 2_000 };
export type WaitOptions = { timeoutMs: number; intervalMs: number; now?: () => number; sleep?: (ms: number) => Promise<void>; onWait?: (elapsedMs: number) => void };
export class OutboxMissingError extends Error {}
export async function waitForOutbox(exists: () => Promise<boolean>, opts: WaitOptions): Promise<boolean>;
export async function outboxExists(db: Db, outboxSchema: string): Promise<boolean>;
export async function migrateAudit(db: Db, config: AuditConfig, opts?: { wait?: Partial<WaitOptions>; log?: (line: string) => void }): Promise<{ applied: number; expected: number; role: string | null }>;

// apps/audit/src/test/config.ts (new file)
export function testKeyPair(): { privateKeyPem: string; publicKeyB64: string };
export function testConfig(overrides?: Partial<NodeJS.ProcessEnv>): AuditConfig;

// apps/audit/src/test/db.ts
export const TEST_DATABASE_URL: string;
export type AuditTestDb;                                   // defined here, re-exported (type) from src/test/app.ts
export async function withAuditSchema(name: string): Promise<AuditTestDb>;  // t_audit_<name>_<pid> (outbox) + <that>_a (audit); name ≤ 30 chars
// The harness outbox copies the API's 0016_audit_outbox DDL including its trigger: function audit_outbox_no_update()
// raising 'audit_outbox rows are never updated; the audit service moves each one as it was written',
// trigger audit_outbox_no_update BEFORE UPDATE … FOR EACH ROW.
export async function putOutbox(t: AuditTestDb, events: unknown[]): Promise<void>;          // defined here, re-exported from src/test/app.ts; does NOT pg_notify
export async function resetAudit(t: AuditTestDb): Promise<void>;                            // empties outbox + events + dead_letters (triggers off/on in one transaction)
// buildTestApp always configures JWT_PUBLIC_KEY and JWT_PREVIOUS_PUBLIC_KEY from two fresh pairs, so
// signToken(app, claims, { previousKey: true }) always works; `env` can blank the previous key to test its absence.
```

`sampleEvent()` defaults: the manager `u2` / `RC-3120` / "Ramesh Kumar" / "Outlet Manager" / `rest` voiding bill `B-0001` at `coffee`, `outcome: "done"`, `status: 200`, `requestId: "req-sample-1"`, `changed: ["bills", "stock"]`, `at: "2026-09-14T04:30:00.000Z"`.

#### Notes

1. **The database pieces moved from Task 9 to Task 10.** `createDb` types `Db` over `schema.ts`, so `plugins/db.ts`, `db/client.ts` and `db/migrate.ts` land with the storage in Task 10, and Task 10 modifies `app.ts` to register the db plugin. Task 9's `/readyz` test asserts only `503 not_ready` (true both before and after Task 10); Task 10's `plugins/db.test.ts` pins the database check's three sentences.
2. **Dependencies are added when first used**: Task 9 adds fastify, fastify-plugin, fastify-type-provider-zod, @fastify/helmet, prom-client, zod; Task 10 adds @rch/contract, drizzle-orm, pg, fast-jwt, @types/pg, drizzle-kit and the `db:generate` / `db:migrate` scripts. knip never sees a declared-but-unused dependency between commits.
3. **Root `pnpm dev` before Task 15.** Until Task 15 adds `AUDIT_DATABASE_URL` to `.env.example` (and developers add it to `.env`), the root `pnpm dev` stops at the audit service's `Invalid environment` exit 2.
4. **Coverage** excludes `src/server.ts` and `src/cli/**` (a few lines of wiring over `app.ts` and `lib/migrate-run.ts`, which the tests call directly). A dry run of exactly this part's code measured lines 99.0 / branches 90.5, so the 90 / 75 floor holds with room for Tasks 11-12.
5. **Append-only is statement-level** (`BEFORE UPDATE OR DELETE OR TRUNCATE … FOR EACH STATEMENT`), stricter than the API's row-level ledger triggers: it also refuses TRUNCATE and a zero-row UPDATE/DELETE. Tasks 11-12 reset between cases with `resetAudit(app.testDb)`, never a TRUNCATE.
6. **Task 11 must keep `src/plugins/db.test.ts`'s first case green**: it builds `buildTestApp({ schema: "db", drainer: true })` and expects `/readyz` 200 once the drain check exists (so a drainer started by the app has to complete a pass before `app.ready()` resolves, or Task 11 adds `await app.drainer.drainNow()` before that first request). Its 503 cases assert with `toContain("database - …")`, so an extra failing `drainer` check does not break them.
7. **Harness names Tasks 11-12 should not expect**: no `warmPool` export (Task 11 keeps its local helper), no exported `schemaPair`, no `Tx` in `db/client.ts`. `putOutbox` stores a non-object value such as `"not an event"` as a jsonb string, as Task 11 assumes. The spec §4 row and Task 19's docs should read `select, delete, update (at)` on the outbox (D7).
8. **Dry run.** Every file in this part was typechecked (tsc 6, nodenext), linted (oxlint, root config, zero warnings), built (tsup) and tested (9 files, 64 tests) in a scratch copy linked to the shared checkout's `node_modules`, with `@rch/contract` stubbed by the Shared Interfaces' `AuditEventSchema`, against the local Postgres 17.11; `node dist/cli/migrate.mjs` exited 0 on a migrated pair and 2 without `JWT_PUBLIC_KEY`. drizzle-kit 0.31.10 generated the table SQL shown in Task 10 and a second `db:generate` printed "No schema changes, nothing to migrate". Task 15's four audit boundary patterns (parts/07) find no hit in this part's non-test files. `drizzle/meta/_journal.json`'s `when` and `0000_snapshot.json` are generated in Task 10 Steps 5-6 and committed as generated.

---

### Task 9: Audit service - scaffold, config, app, health

**Files:**
- Create: `apps/audit/package.json`
- Create: `apps/audit/tsconfig.json`
- Create: `apps/audit/tsup.config.ts`
- Create: `apps/audit/vitest.config.ts`
- Create: `apps/audit/src/test/env.ts`
- Create: `apps/audit/src/test/config.ts`
- Create: `apps/audit/src/config.ts`
- Create: `apps/audit/src/lib/errors.ts`
- Create: `apps/audit/src/plugins/logging.ts`
- Create: `apps/audit/src/plugins/errors.ts`
- Create: `apps/audit/src/plugins/security.ts`
- Create: `apps/audit/src/plugins/metrics.ts`
- Create: `apps/audit/src/plugins/health.ts`
- Create: `apps/audit/src/app.ts`
- Create: `apps/audit/src/server.ts`
- Modify: `pnpm-lock.yaml` (new importer, written by `pnpm install`)
- Test: `apps/audit/src/config.test.ts`
- Test: `apps/audit/src/plugins/health.test.ts`
- Test: `apps/audit/src/plugins/errors.test.ts`
- Test: `apps/audit/src/app.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (the package imports no workspace code yet; `@rch/contract` arrives in Task 10).
- Produces: `AuditConfig`, `loadConfig(env)`, `ConfigError`; `buildApp(config, deps?)`, `AuditApp`, `AppDeps` (`logStream`, `drainer`); `app.config`, `app.readiness.addCheck/setDraining`, `app.metrics.registry`; `AppError`, `ValidationError`, `UnauthenticatedError`, `NotFoundError`, `NotReadyError`; `Refusal` / `req.refusal`; `LogStream`; `testKeyPair()`, `testConfig(overrides)`.

- [ ] **Step 1: Scaffold the package and install**

Create the five scaffold files.

`apps/audit/package.json`:

````json
{
  "name": "@rch/audit",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "PORT=3100 tsx watch --env-file=../../.env src/server.ts",
    "build": "tsup",
    "start": "node dist/server.mjs",
    "typecheck": "tsc --noEmit",
    "lint": "oxlint --max-warnings 0",
    "test": "vitest run --coverage"
  },
  "dependencies": {
    "@fastify/helmet": "^13.1.1",
    "fastify": "^5.12.1",
    "fastify-plugin": "^6.0.0",
    "fastify-type-provider-zod": "^7.0.0",
    "prom-client": "^15.1.3",
    "zod": "^4.5.4"
  },
  "devDependencies": {
    "@types/node": "^24.13.3",
    "@vitest/coverage-v8": "^4.1.11",
    "tsup": "^8.5.1",
    "tsx": "^4.23.13",
    "vitest": "^4.1.11"
  }
}
````

`apps/audit/tsconfig.json`:

````json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023"], "types": ["node"], "module": "nodenext", "moduleResolution": "nodenext" },
  "include": ["src", "*.config.ts"]
}
````

`apps/audit/tsup.config.ts` (Task 10 adds the `cli/migrate` entry):

````ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    server: "src/server.ts",
  },
  format: ["esm"],
  target: "node24",
  outExtension: () => ({ js: ".mjs" }),
  sourcemap: true,
  clean: true,
  // Workspace packages are TypeScript source; bundle them. Everything else stays external.
  noExternal: [/^@rch\//],
});
````

`apps/audit/vitest.config.ts`:

````ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    env: { TZ: "UTC" }, // same clock as CI, so the IST day bounds of the read routes prove something on every host
    include: ["src/**/*.test.ts"],
    fileParallelism: true,
    // Each file opens a pool of at most 4 against its own schema pair (src/test/db.ts) plus a
    // one-connection admin pool, and the drainer tests add a LISTEN client. Four files at once
    // is ~25 connections, which leaves apps/api's six files room under Postgres's default 100
    // when turbo runs both suites together.
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    setupFiles: ["./src/test/env.ts"],
    // `enabled` is not set: `package.json`'s `test` passes `--coverage`, so `pnpm test` and CI are
    // gated while a one-file `vitest run` is not. The floor starts at the target the spec sets
    // (lines 90 / branches 75); Task 20 sets it to the measured figures. Raise it when the real
    // figure rises; never lower it to clear a red run.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // `src/test/**` is the harness and `db/schema.ts` a declaration. `server.ts` and `cli/**`
      // are the process entry points: a few lines of wiring over `app.ts` and `lib/`, which the
      // tests call directly, and which the image's kind install exercises for real.
      exclude: ["src/**/*.test.ts", "src/test/**", "src/db/schema.ts", "src/server.ts", "src/cli/**"],
      reporter: ["text-summary"],
      thresholds: { lines: 90, branches: 75 },
    },
  },
});
````

`apps/audit/src/test/env.ts`:

````ts
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.TEST_DATABASE_URL ??= "postgres://rch:rch@localhost:5439/rch_test";
````

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log install`
Expected: exits 0, and `git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log status --short` shows `?? apps/audit/` and ` M pnpm-lock.yaml` (a new `apps/audit` importer).

- [ ] **Step 2: Write the failing config test**

`apps/audit/src/config.test.ts`:

````ts
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";
import { testKeyPair } from "./test/config.js";

const key = testKeyPair().publicKeyB64;
const good = { NODE_ENV: "test", AUDIT_DATABASE_URL: "postgres://rch_audit:pw@db:5432/rch", JWT_PUBLIC_KEY: key } as const;

/** The ConfigError's text for `env`, or "" when it loads. */
function refusal(env: NodeJS.ProcessEnv): string {
  try { loadConfig(env); return ""; } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
}

describe("loadConfig", () => {
  it("applies the service's defaults", () => {
    const c = loadConfig(good);
    expect(c.env).toBe("test");
    expect(c.port).toBe(3100);
    expect(c.logLevel).toBe("info");
    expect(c.databaseUrl).toBe(good.AUDIT_DATABASE_URL);
    // Unset, the migrate CLI connects as the runtime user - which is also what tells it to skip role setup.
    expect(c.migrateDatabaseUrl).toBe(good.AUDIT_DATABASE_URL);
    expect(c.databaseSsl).toBe(false);
    expect(c.dbPoolMax).toBe(5);
    expect(c.jwtPublicKeyPem).toContain("-----BEGIN PUBLIC KEY-----");
    expect(c.jwtPreviousPublicKeyPem).toBeUndefined();
    expect(c.auditSchema).toBe("audit");
    expect(c.eventsSchema).toBe("public");
    expect(c.outboxSchema).toBe("public");
    expect(c.drainBatch).toBe(500);
    expect(c.drainPollMs).toBe(5000);
    const oneHop = c.trustProxy as (address: string, hop: number) => boolean;
    expect(typeof oneHop).toBe("function");
    expect(oneHop("1.2.3.4", 0)).toBe(true);
    expect(oneHop("1.2.3.4", 1)).toBe(false);
  });

  it("takes a separate migrate URL and a previous key, and reads a blank previous key as none", () => {
    const previous = testKeyPair().publicKeyB64;
    const c = loadConfig({ ...good, MIGRATE_DATABASE_URL: "postgres://rch:rch@db:5432/rch", JWT_PREVIOUS_PUBLIC_KEY: previous });
    expect(c.migrateDatabaseUrl).toBe("postgres://rch:rch@db:5432/rch");
    expect(c.jwtPreviousPublicKeyPem).toBe(Buffer.from(previous, "base64").toString("utf8"));
    expect(loadConfig({ ...good, JWT_PREVIOUS_PUBLIC_KEY: "" }).jwtPreviousPublicKeyPem).toBeUndefined();
  });

  it("turns TLS on by default only in production, and lets DATABASE_SSL overrule that both ways", () => {
    expect(loadConfig({ ...good, NODE_ENV: "production" }).databaseSsl).toBe(true);
    expect(loadConfig({ ...good, NODE_ENV: "production", DATABASE_SSL: "false" }).databaseSsl).toBe(false);
    expect(loadConfig({ ...good, DATABASE_SSL: "true" }).databaseSsl).toBe(true);
  });

  it("parses TRUST_PROXY the way the API does", () => {
    expect(loadConfig({ ...good, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ ...good, TRUST_PROXY: "false" }).trustProxy).toBe(false);
    const twoHops = loadConfig({ ...good, TRUST_PROXY: "2" }).trustProxy as (address: string, hop: number) => boolean;
    expect(twoHops("1.2.3.4", 1)).toBe(true);
    expect(twoHops("1.2.3.4", 2)).toBe(false);
    expect(loadConfig({ ...good, TRUST_PROXY: "10.0.0.0/8" }).trustProxy).toBe("10.0.0.0/8");
  });

  it("names every missing or malformed variable at once", () => {
    const msg = refusal({ NODE_ENV: "test", JWT_PUBLIC_KEY: "eA==", PORT: "abc" });
    expect(msg).toContain("AUDIT_DATABASE_URL");
    expect(msg).toContain("JWT_PUBLIC_KEY: must be a base64-encoded PEM public key");
    expect(msg).toContain("PORT");
  });

  it("accepts only plain lower-case schema names that fit beside their suffix", () => {
    for (const bad of ["Audit", 'audit"; drop schema public cascade; --', "1audit", "pg_audit", "audit-log", "a".repeat(56)]) {
      expect(refusal({ ...good, AUDIT_SCHEMA: bad }), bad).toContain("AUDIT_SCHEMA");
    }
    expect(loadConfig({ ...good, AUDIT_SCHEMA: "a".repeat(55) }).auditSchema).toHaveLength(55);
    expect(loadConfig({ ...good, OUTBOX_SCHEMA: "o".repeat(63) }).outboxSchema).toHaveLength(63);
    expect(refusal({ ...good, OUTBOX_SCHEMA: "o".repeat(64) })).toContain("OUTBOX_SCHEMA");
    expect(loadConfig({ ...good, EVENTS_SCHEMA: "e".repeat(52) }).eventsSchema).toHaveLength(52);
    expect(refusal({ ...good, EVENTS_SCHEMA: "e".repeat(53) })).toContain("EVENTS_SCHEMA");
  });

  it("refuses an audit schema that is not a schema of its own", () => {
    expect(refusal({ ...good, AUDIT_SCHEMA: "public" })).toContain("AUDIT_SCHEMA: must be a schema of its own");
    expect(refusal({ ...good, AUDIT_SCHEMA: "t_x", OUTBOX_SCHEMA: "t_x", EVENTS_SCHEMA: "t_y" })).toContain("AUDIT_SCHEMA");
    expect(refusal({ ...good, AUDIT_SCHEMA: "t_x", OUTBOX_SCHEMA: "t_y", EVENTS_SCHEMA: "t_x" })).toContain("AUDIT_SCHEMA");
  });

  it("bounds the pool, the drain batch and the poll interval", () => {
    expect(loadConfig({ ...good, DB_POOL_MAX: "12", DRAIN_BATCH: "100", DRAIN_POLL_MS: "250" })).toMatchObject({ dbPoolMax: 12, drainBatch: 100, drainPollMs: 250 });
    expect(refusal({ ...good, DB_POOL_MAX: "0" })).toContain("DB_POOL_MAX");
    expect(refusal({ ...good, DRAIN_BATCH: "0" })).toContain("DRAIN_BATCH");
    expect(refusal({ ...good, DRAIN_BATCH: "5001" })).toContain("DRAIN_BATCH");
    expect(refusal({ ...good, DRAIN_POLL_MS: "50" })).toContain("DRAIN_POLL_MS");
    expect(refusal({ ...good, DRAIN_POLL_MS: "25001" })).toContain("DRAIN_POLL_MS");
  });
});
````

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/config.test.ts`
Expected: FAIL - vitest cannot load `./config.js` / `./test/config.js` (neither file exists yet); 0 tests run.

- [ ] **Step 4: Implement the config and the test config helper**

`apps/audit/src/config.ts`:

````ts
import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const pem = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

/** The API's JWT_PUBLIC_KEY, verbatim: a PEM public key, base64-encoded so it survives an env
 *  file. Checked here so a mangled key stops the process at start rather than 401-ing every
 *  request after it. */
const publicKey = z.string().min(1).refine((v) => pem(v).includes("-----BEGIN PUBLIC KEY-----"), "must be a base64-encoded PEM public key");

/**
 * A schema name. It is spliced into SQL as a quoted identifier and, for EVENTS_SCHEMA, into a
 * NOTIFY channel, so it is held to lower-case letters, digits and underscores - nothing quoting
 * could be escaped out of - and never `pg_…`, which Postgres reserves. `max` is what is left of
 * Postgres's 63-byte identifier limit after the suffix this service adds: `_drizzle` (8) to
 * AUDIT_SCHEMA, the `rch_events_` prefix (11) to EVENTS_SCHEMA.
 */
const schemaName = (max: number) => z.string()
  .regex(/^[a-z_][a-z0-9_]*$/, "must be lower-case letters, digits and underscores, not starting with a digit")
  .max(max)
  .refine((v) => !v.startsWith("pg_"), "may not start with pg_, which Postgres reserves");

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(0, 65535).default(3100),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** The runtime connection, as `rch_audit` everywhere but a laptop and the test suite. */
  AUDIT_DATABASE_URL: z.url().startsWith("postgres"),
  /** The migrate CLI's connection (as `rch`). Unset, the CLI uses AUDIT_DATABASE_URL and skips
   *  role setup, because the runtime user is then the migrate user (src/lib/roles.ts). */
  MIGRATE_DATABASE_URL: z.url().startsWith("postgres").optional(),
  /** Left unset, production verifies the RDS chain and a laptop does not - as in the API. */
  DATABASE_SSL: bool.optional(),
  /** One drain pass and one read each take a single connection, and the LISTEN client is not a
   *  pool member, so five is room for two admins reading while a pass runs. */
  DB_POOL_MAX: int(1, 200).default(5),
  JWT_PUBLIC_KEY: publicKey,
  /** Empty is the same as unset: `.env.example` ships the line blank. */
  JWT_PREVIOUS_PUBLIC_KEY: z.union([z.literal(""), publicKey]).optional(),
  /** Same grammar as the API's TRUST_PROXY - see `parseTrustProxy`. */
  TRUST_PROXY: z.string().min(1).default("1"),
  AUDIT_SCHEMA: schemaName(55).default("audit"),
  EVENTS_SCHEMA: schemaName(52).default("public"),
  OUTBOX_SCHEMA: schemaName(63).default("public"),
  DRAIN_BATCH: int(1, 5000).default(500),
  DRAIN_POLL_MS: int(100, 25_000).default(5000),   // under the drainer's 30 s readiness window, or /readyz flaps on a quiet pod
}).superRefine((e, ctx) => {
  // The migrate CLI revokes PUBLIC's rights on AUDIT_SCHEMA and the service's role gets no
  // privilege on the API's tables: pointing it at `public`, or at the schema the API's own tables
  // live in, would do both to the API.
  if (e.AUDIT_SCHEMA === "public" || e.AUDIT_SCHEMA === e.OUTBOX_SCHEMA || e.AUDIT_SCHEMA === e.EVENTS_SCHEMA) {
    ctx.addIssue({ code: "custom", path: ["AUDIT_SCHEMA"], message: "must be a schema of its own, not public and not the outbox or events schema" });
  }
});

export class ConfigError extends Error {}

export type AuditConfig = Readonly<{
  env: "development" | "test" | "production";
  port: number;
  logLevel: z.infer<typeof Env>["LOG_LEVEL"];
  databaseUrl: string;
  migrateDatabaseUrl: string;
  databaseSsl: boolean;
  dbPoolMax: number;
  jwtPublicKeyPem: string;
  jwtPreviousPublicKeyPem?: string;
  /** What Fastify's own `trustProxy` accepts. A hop count becomes a function, because Fastify 5
   *  treats a bare number as a no-op (apps/api/src/config.ts explains the whole of it). */
  trustProxy: boolean | string | ((address: string, hop: number) => boolean);
  auditSchema: string;
  eventsSchema: string;
  outboxSchema: string;
  drainBatch: number;
  drainPollMs: number;
}>;

/** "true"/"false" -> boolean; a bare integer -> trust exactly that many nearest hops; anything
 *  else (a CIDR, an IP, a list) -> passed to `proxy-addr` as it is. Identical to the API's. */
function parseTrustProxy(v: string): AuditConfig["trustProxy"] {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_address: string, hop: number) => hop < hops;
  }
  return v;
}

/** The only reader of `process.env` in this package (the test harness aside). */
export function loadConfig(env: NodeJS.ProcessEnv): AuditConfig {
  const r = Env.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`Invalid environment:\n${lines.join("\n")}`);
  }
  const e = r.data;
  return Object.freeze({
    env: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.AUDIT_DATABASE_URL,
    migrateDatabaseUrl: e.MIGRATE_DATABASE_URL ?? e.AUDIT_DATABASE_URL,
    databaseSsl: e.DATABASE_SSL ?? e.NODE_ENV === "production",
    dbPoolMax: e.DB_POOL_MAX,
    jwtPublicKeyPem: pem(e.JWT_PUBLIC_KEY),
    jwtPreviousPublicKeyPem: e.JWT_PREVIOUS_PUBLIC_KEY ? pem(e.JWT_PREVIOUS_PUBLIC_KEY) : undefined,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    auditSchema: e.AUDIT_SCHEMA,
    eventsSchema: e.EVENTS_SCHEMA,
    outboxSchema: e.OUTBOX_SCHEMA,
    drainBatch: e.DRAIN_BATCH,
    drainPollMs: e.DRAIN_POLL_MS,
  });
}
````

`apps/audit/src/test/config.ts`:

````ts
import { generateKeyPairSync } from "node:crypto";
import { loadConfig, type AuditConfig } from "../config.js";

const b64 = (pem: string) => Buffer.from(pem).toString("base64");

/** A fresh Ed25519 pair in the shapes the API's `keys:generate` prints: the private key as PEM,
 *  to sign test tokens with, and the public key base64-encoded, for JWT_PUBLIC_KEY. */
export function testKeyPair(): { privateKeyPem: string; publicKeyB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyB64: b64(publicKey.export({ type: "spki", format: "pem" }).toString()),
  };
}

/** A valid test environment with `overrides` on top. A fresh public key unless one is given. */
export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): AuditConfig {
  return loadConfig({
    NODE_ENV: "test", PORT: "0", LOG_LEVEL: "silent",
    AUDIT_DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test",
    JWT_PUBLIC_KEY: overrides.JWT_PUBLIC_KEY ?? testKeyPair().publicKeyB64,
    ...overrides,
  });
}
````

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/config.test.ts`
Expected: PASS - 8 tests.

- [ ] **Step 6: Write the failing health, error-envelope and plumbing tests**

`apps/audit/src/plugins/health.test.ts`:

````ts
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import errors from "./errors.js";
import health from "./health.js";

/** The health plugin alone: what /readyz says is decided by the checks, whoever registers them. */
let app: FastifyInstance | undefined;
async function bare(): Promise<FastifyInstance> {
  app = Fastify();
  await app.register(errors);
  await app.register(health);
  return app;
}
afterEach(async () => { await app?.close(); app = undefined; });

describe("GET /readyz", () => {
  it("is not ready while nothing has registered a check", async () => {
    const a = await bare();
    const r = await a.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: { code: "not_ready", message: "No readiness checks registered." } });
  });

  it("is ready when every check passes, whether it returns nothing or true", async () => {
    const a = await bare();
    a.readiness.addCheck("database", async () => {});
    a.readiness.addCheck("drainer", async () => true);
    const r = await a.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it("names every failing check, with its reason when it gives one", async () => {
    const a = await bare();
    a.readiness.addCheck("database", async () => { throw new Error("schema at 0/1 migrations"); });
    a.readiness.addCheck("drainer", async () => { throw new Error(""); });
    a.readiness.addCheck("listener", () => false);
    a.readiness.addCheck("cache", () => true);
    const r = await a.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: { code: "not_ready", message: "Not ready: database - schema at 0/1 migrations, drainer, listener." } });
  });

  it("answers 503 once draining, while /healthz stays 200", async () => {
    const a = await bare();
    a.readiness.addCheck("database", async () => {});
    a.readiness.setDraining();
    const r = await a.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: { code: "not_ready", message: "Shutting down." } });
    expect((await a.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});
````

`apps/audit/src/plugins/errors.test.ts`:

````ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { buildApp, type AuditApp } from "../app.js";
import { ForbiddenError, NotFoundError, NotReadyError, UnauthenticatedError } from "../lib/errors.js";
import { testConfig } from "../test/config.js";
import type { LogStream } from "./logging.js";

const lines: Array<Record<string, unknown>> = [];
const logStream: LogStream = { write: (line) => { lines.push(JSON.parse(line) as Record<string, unknown>); } };
const accessLine = (url: string) => lines.find((l) => l.msg === "request" && l.route === url);

let app: AuditApp;
beforeAll(async () => {
  app = await buildApp(testConfig({ LOG_LEVEL: "info", AUDIT_SCHEMA: `t_audit_none_${process.pid}` }), { logStream, drainer: false });
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/t/query", { schema: { querystring: z.object({ n: z.coerce.number().int() }) } }, async (req) => ({ n: req.query.n }));
  r.get("/t/serialize", { schema: { response: { 200: z.object({ n: z.number() }) } } }, async () => ({ n: "seven" }) as unknown as { n: number });
  r.get("/t/unauthenticated", async () => { throw new UnauthenticatedError("Sign in to continue.", "no bearer token"); });
  r.get("/t/forbidden", async () => { throw new ForbiddenError("Only the super admin reads the audit log."); });
  r.get("/t/missing", async () => { throw new NotFoundError("There is no audit entry 9."); });
  r.get("/t/not-ready", async () => { throw new NotReadyError("The audit log is still starting."); });
  r.get("/t/teapot", async () => { throw Object.assign(new Error("This endpoint does not brew."), { statusCode: 418 }); });
  r.get("/t/boom", async () => { throw new Error("connect ECONNREFUSED 10.0.0.9:5432"); });
  await app.ready();
});
afterAll(async () => { await app.close(); });

describe("the error envelope", () => {
  it("answers a request that fails its schema with 400 and the details", async () => {
    const r = await app.inject({ method: "GET", url: "/t/query?n=many" });
    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toBe("The request did not match what this endpoint expects.");
    expect(body.error.details.length).toBeGreaterThan(0);
  });

  it("refuses with an AppError's sentence and logs its cause without sending it", async () => {
    const r = await app.inject({ method: "GET", url: "/t/unauthenticated" });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } });
    expect(r.body).not.toContain("no bearer token");
    await vi.waitFor(() => expect(accessLine("/t/unauthenticated")).toBeDefined());
    expect(accessLine("/t/unauthenticated")!.refusal).toEqual({ code: "unauthenticated", message: "Sign in to continue.", cause: "no bearer token" });
  });

  it("maps a ForbiddenError to 403 and a NotFoundError to 404", async () => {
    const f = await app.inject({ method: "GET", url: "/t/forbidden" });
    expect(f.statusCode).toBe(403);
    expect(f.json()).toEqual({ error: { code: "forbidden", message: "Only the super admin reads the audit log." } });
    const r = await app.inject({ method: "GET", url: "/t/missing" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: { code: "not_found", message: "There is no audit entry 9." } });
  });

  it("sends a 5xx AppError's envelope without recording it as a refusal", async () => {
    const r = await app.inject({ method: "GET", url: "/t/not-ready" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: { code: "not_ready", message: "The audit log is still starting." } });
    await vi.waitFor(() => expect(accessLine("/t/not-ready")).toBeDefined());
    expect(accessLine("/t/not-ready")!.refusal).toBeUndefined();
  });

  it("passes a framework 4xx through as a refusal", async () => {
    const r = await app.inject({ method: "GET", url: "/t/teapot" });
    expect(r.statusCode).toBe(418);
    expect(r.json()).toEqual({ error: { code: "validation", message: "This endpoint does not brew." } });
  });

  it("hides an unhandled error behind a sentence carrying the request id", async () => {
    const r = await app.inject({ method: "GET", url: "/t/boom", headers: { "x-request-id": "req-boom" } });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: { code: "internal", message: "Something went wrong on our side. Reference req-boom." } });
    expect(r.body).not.toContain("ECONNREFUSED");
  });

  it("answers a response that fails its own schema with the same 500", async () => {
    const r = await app.inject({ method: "GET", url: "/t/serialize", headers: { "x-request-id": "req-shape" } });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: { code: "internal", message: "Something went wrong on our side. Reference req-shape." } });
  });
});
````

`apps/audit/src/app.test.ts`:

````ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AuditApp } from "./app.js";
import { testConfig } from "./test/config.js";

let app: AuditApp;
beforeAll(async () => {
  // A schema nobody migrates, so /readyz has no way to pass here whatever this database holds.
  app = await buildApp(testConfig({ AUDIT_SCHEMA: `t_audit_none_${process.pid}` }), { drainer: false });
  await app.ready();
});
afterAll(async () => { await app.close(); });

describe("plumbing", () => {
  it("answers liveness immediately", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });
  it("is not ready until its checks say so", async () => {
    const r = await app.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("not_ready");
  });
  it("returns the API's error envelope for an unknown route", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/admin/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: { code: "not_found", message: "There is nothing at GET /api/v1/admin/nope." } });
  });
  it("echoes a request id, and mints one when it is absent or malformed", async () => {
    const a = await app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "abc-123" } });
    expect(a.headers["x-request-id"]).toBe("abc-123");
    const b = await app.inject({ method: "GET", url: "/healthz" });
    expect(String(b.headers["x-request-id"])).toMatch(/^[0-9a-f-]{36}$/);
    const c = await app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "not a token" } });
    expect(String(c.headers["x-request-id"])).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("serves prometheus metrics", async () => {
    const r = await app.inject({ method: "GET", url: "/metrics" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("http_request_duration_seconds");
    expect(r.body).toContain("process_cpu_user_seconds_total");
  });
  it("sets security headers", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});
````

- [ ] **Step 7: Run them to verify they fail**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/plugins/health.test.ts src/plugins/errors.test.ts src/app.test.ts`
Expected: FAIL - vitest cannot load `./health.js`, `./errors.js` and `./app.js` / `../app.js`.

- [ ] **Step 8: Implement the errors, the plugins and the app**

`apps/audit/src/lib/errors.ts`:

````ts
export type ErrorCode = "validation" | "unauthenticated" | "forbidden" | "not_found" | "not_ready" | "internal";

/** The API's error shape (apps/api/src/lib/errors.ts), cut to the refusals a read-only admin
 *  service can give. The envelope is identical, so the UI's `call()` reads both services alike. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Mirrors `status`: Fastify-adjacent code reads `err.statusCode`. */
  readonly statusCode: number;
  readonly details?: unknown;
  /** Why, for the operator reading the log - never serialised into a response. */
  override readonly cause?: string;
  constructor(code: ErrorCode, status: number, message: string, details?: unknown, cause?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.details = details;
    this.cause = cause;
    this.name = new.target.name;
  }
  toEnvelope() {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
  }
}
export class ValidationError extends AppError { constructor(message: string, details?: unknown) { super("validation", 400, message, details); } }
export class UnauthenticatedError extends AppError { constructor(message = "Sign in to continue.", cause?: string) { super("unauthenticated", 401, message, undefined, cause); } }
export class ForbiddenError extends AppError { constructor(message: string) { super("forbidden", 403, message); } }
export class NotFoundError extends AppError { constructor(message: string) { super("not_found", 404, message); } }
export class NotReadyError extends AppError { constructor(message: string) { super("not_ready", 503, message); } }
````

`apps/audit/src/plugins/logging.ts`:

````ts
import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";

/** Request id in, request id out, and one access line per request - carrying, on a refusal,
 *  what it was refused with (`refusal`, set by `plugins/errors.ts`). A slim copy of the API's. */
export default fp(async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });
  app.addHook("onResponse", async (req, reply) => {
    req.log.info({
      route: req.routeOptions?.url ?? req.url, method: req.method, status: reply.statusCode,
      ms: Math.round(reply.elapsedTime), user: (req as { user?: { sub?: string } }).user?.sub,
      ...(req.refusal ? { refusal: req.refusal } : {}),
    }, "request");
  });
}, { name: "logging" });

/** Anything with a `write(line)` - pino's own destination shape. A test hands one in to read
 *  the lines back; production leaves it out and pino writes to stdout. */
export type LogStream = { write: (line: string) => void };

export const loggerOptions = (level: string, stream?: LogStream) => ({
  level,
  redact: { paths: ["req.headers.authorization", "req.headers.cookie"], censor: "[redacted]" },
  serializers: { req: (r: { method: string; url: string }) => ({ method: r.method, url: r.url }) },
  ...(stream ? { stream } : {}),
});

/** The caller's `x-request-id` when it is a plain token (the API's, forwarded by the UI's proxy),
 *  otherwise a fresh UUID - a header is never trusted into the log unchecked. */
export const genReqId = (req: { headers: Record<string, string | string[] | undefined> }) => {
  const h = req.headers["x-request-id"];
  const v = Array.isArray(h) ? h[0] : h;
  return v && /^[\w.-]{1,128}$/.test(v) ? v : randomUUID();
};
````

`apps/audit/src/plugins/errors.ts`:

````ts
import fp from "fastify-plugin";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { AppError, NotFoundError, ValidationError } from "../lib/errors.js";

/** What a 4xx was refused with, for the request's own log line (`plugins/logging.ts`). `cause`
 *  is the internal reason an `AppError` carried. Never serialised into a response. */
export type Refusal = { code: string; message: string; cause?: string };
declare module "fastify" { interface FastifyRequest { refusal?: Refusal } }

/** The API's envelope, `{ error: { code, message, details? } }`, for every refusal and failure. */
export default fp(async (app) => {
  app.setNotFoundHandler((req, reply) => {
    const e = new NotFoundError(`There is nothing at ${req.method} ${req.url}.`);
    req.refusal = { code: e.code, message: e.message };
    reply.code(404).send(e.toEnvelope());
  });
  app.setErrorHandler((err, req, reply) => {
    const refuse = (status: number, refusal: Refusal, envelope?: unknown) => {
      req.refusal = refusal;
      return reply.code(status).send(envelope ?? { error: { code: refusal.code, message: refusal.message } });
    };
    if (hasZodFastifySchemaValidationErrors(err)) {
      const details = err.validation.map((v) => ({ path: v.instancePath || "/", message: v.message }));
      const e = new ValidationError("The request did not match what this endpoint expects.", details);
      return refuse(400, { code: e.code, message: e.message }, e.toEnvelope());
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err, issues: err.cause.issues }, "response failed its schema");
      return reply.code(500).send({ error: { code: "internal", message: `Something went wrong on our side. Reference ${req.id}.` } });
    }
    if (err instanceof AppError) {
      if (err.status < 500) return refuse(err.status, { code: err.code, message: err.message, ...(err.cause === undefined ? {} : { cause: err.cause }) }, err.toEnvelope());
      return reply.code(err.status).send(err.toEnvelope());
    }
    // Fastify's own 4xx (a body that is not JSON, a payload over bodyLimit): the caller's to fix.
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return refuse(status, { code: "validation", message: (err as Error).message });
    req.log.error({ err }, "unhandled");
    return reply.code(500).send({ error: { code: "internal", message: `Something went wrong on our side. Reference ${req.id}.` } });
  });
}, { name: "errors" });
````

`apps/audit/src/plugins/security.ts`:

````ts
import fp from "fastify-plugin";
import helmet from "@fastify/helmet";

/** Security headers. The service answers JSON to one origin (the UI's proxy sends
 *  `/api/v1/admin/audit` here), so there is no CORS to configure, and CSP belongs to the UI's
 *  nginx. Every route but the probes and /metrics needs an admin token (plugins/auth.ts). */
export default fp(async (app) => {
  await app.register(helmet, { contentSecurityPolicy: false });
}, { name: "security" });
````

`apps/audit/src/plugins/metrics.ts`:

````ts
import fp from "fastify-plugin";
import { Histogram, Registry, collectDefaultMetrics } from "prom-client";

declare module "fastify" {
  interface FastifyInstance { metrics: { registry: Registry } }
}

/** The API's /metrics setup: a registry per app, the process defaults and request durations.
 *  Plugins that publish their own series register them on `app.metrics.registry`. */
export default fp(async (app) => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const duration = new Histogram({
    name: "http_request_duration_seconds", help: "Request duration by route and status",
    labelNames: ["method", "route", "status"], buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry],
  });
  app.decorate("metrics", { registry });
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? "unmatched";
    if (route === "/metrics") return;
    duration.labels(req.method, route, String(reply.statusCode)).observe(reply.elapsedTime / 1000);
  });
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
}, { name: "metrics" });
````

`apps/audit/src/plugins/health.ts`:

````ts
import fp from "fastify-plugin";
import { NotReadyError } from "../lib/errors.js";

/** A check passes by returning (nothing, or `true`) and fails by returning `false` - reported by
 *  name alone - or by throwing, whose message is reported after the name. */
type Check = () => Promise<boolean | void> | boolean | void;
declare module "fastify" {
  interface FastifyInstance {
    readiness: { addCheck(name: string, check: Check): void; setDraining(): void };
  }
}

/**
 * /healthz says the process is up. /readyz says it may receive traffic: every registered check
 * passes and the process is not draining. `plugins/db.ts` registers the database check and
 * `plugins/drainer.ts` the drain check; anything else that gates readiness calls `addCheck`.
 *
 * **A thrown check's `Error` message is operator-facing.** It is appended to the 503's sentence
 * (`Not ready: database - schema at 0/1 migrations.`) and logged whole, so a check throws a
 * phrase a person can act on, never the driver's own message.
 */
export default fp(async (app) => {
  const checks = new Map<string, Check>();
  let draining = false;
  app.decorate("readiness", {
    addCheck: (name: string, check: Check) => { checks.set(name, check); },
    setDraining: () => { draining = true; },
  });
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (req, reply) => {
    if (draining) { reply.code(503); return new NotReadyError("Shutting down.").toEnvelope(); }
    if (checks.size === 0) { reply.code(503); return new NotReadyError("No readiness checks registered.").toEnvelope(); }
    const failed: string[] = [];
    for (const [name, check] of checks) {
      try {
        if ((await check()) === false) failed.push(name);
      } catch (err) {
        req.log.warn({ err, check: name }, "readiness check failed");
        const why = err instanceof Error ? err.message.trim() : "";
        failed.push(why ? `${name} - ${why}` : name);
      }
    }
    if (failed.length) { reply.code(503); return new NotReadyError(`Not ready: ${failed.join(", ")}.`).toEnvelope(); }
    return { ok: true };
  });
}, { name: "health" });
````

`apps/audit/src/app.ts`:

````ts
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { AuditConfig } from "./config.js";
import logging, { genReqId, loggerOptions, type LogStream } from "./plugins/logging.js";
import errors from "./plugins/errors.js";
import metrics from "./plugins/metrics.js";
import health from "./plugins/health.js";
import security from "./plugins/security.js";

declare module "fastify" { interface FastifyInstance { config: AuditConfig } }

export type AuditApp = FastifyInstance;
/** `logStream` is where the log goes when it is not stdout - a test reading its own lines back.
 *  `drainer` says whether `plugins/drainer.ts` (Task 11) starts its LISTEN client and poll timer;
 *  a test that drives a pass by hand passes `false`. Task 10 adds the database handles. */
export type AppDeps = { logStream?: LogStream; drainer?: boolean };

export async function buildApp(config: AuditConfig, deps: AppDeps = {}): Promise<AuditApp> {
  const app = Fastify({
    logger: loggerOptions(config.logLevel, deps.logStream),
    genReqId,
    trustProxy: config.trustProxy,
    // Every route is a GET; nothing this service accepts has a body worth more than a header.
    bodyLimit: 64 * 1024,
    forceCloseConnections: "idle",
    logController: new LogController({ disableRequestLogging: true }),
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
  }).withTypeProvider<ZodTypeProvider>();
  app.decorate("config", config);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(logging);
  await app.register(errors);
  await app.register(metrics);
  await app.register(health);
  await app.register(security);
  return app;
}
````

- [ ] **Step 9: Run them to verify they pass**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/plugins/health.test.ts src/plugins/errors.test.ts src/app.test.ts`
Expected: PASS - 4 + 7 + 6 tests.

- [ ] **Step 10: Add the server entry point**

`apps/audit/src/server.ts`:

````ts
import { buildApp } from "./app.js";
import { ConfigError, loadConfig, type AuditConfig } from "./config.js";

function readConfig(): AuditConfig {
  try { return loadConfig(process.env); }
  catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(2); } throw e; }
}

async function main() {
  const config = readConfig();
  const app = await buildApp(config);
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "draining");
    app.readiness.setDraining();
    // The API's numbers, for the API's reasons (apps/api/src/server.ts has the whole argument):
    // /readyz is 503 from here, the wait lets the pod leave the Service's endpoints and the load
    // balancer's target group before it stops accepting, and 30 s wait + 25 s drain = 55 s fits
    // inside a 60 s terminationGracePeriodSeconds. Change one and change the others with it.
    await new Promise((r) => setTimeout(r, config.env === "production" ? 30_000 : 0));
    const timer = setTimeout(() => { app.log.error("drain timed out"); process.exit(1); }, 25_000);
    await app.close();
    clearTimeout(timer);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  await app.listen({ port: config.port, host: "0.0.0.0" });
}
main().catch((e) => { console.error(e); process.exit(1); });
````

- [ ] **Step 11: Run the package gates**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit test`
Expected: PASS - 4 files, 25 tests, and the coverage summary clears `lines 90 / branches 75` (a dry run measured lines 99.0 / branches 94.3).

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit typecheck`
Expected: exits 0.

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit lint`
Expected: exits 0 with no warnings.

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit build`
Expected: `dist/server.mjs` built. Then remove the output: `rm -rf /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/dist` (git ignores it either way).

- [ ] **Step 12: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add apps/audit/package.json apps/audit/tsconfig.json apps/audit/tsup.config.ts apps/audit/vitest.config.ts apps/audit/src pnpm-lock.yaml
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Scaffold the audit service with its config, error envelope and health probes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

### Task 10: Audit service - storage, migrations, migrate CLI, roles

**Files:**
- Modify: `apps/audit/package.json` (dependencies + `db:generate` / `db:migrate`)
- Modify: `apps/audit/tsup.config.ts` (the `cli/migrate` entry)
- Modify: `apps/audit/src/app.ts` (register the db plugin; `AppDeps` gains `db`, `pool`, `searchPath`, `cleanup`)
- Modify: `pnpm-lock.yaml`
- Create: `apps/audit/src/db/schema.ts`
- Create: `apps/audit/src/db/client.ts`
- Create: `apps/audit/src/db/migrate.ts`
- Create: `apps/audit/drizzle.config.ts`
- Create: `apps/audit/scripts/db-generate.mjs`
- Create: `apps/audit/drizzle/0000_audit_events.sql`
- Create: `apps/audit/drizzle/meta/_journal.json` (generated)
- Create: `apps/audit/drizzle/meta/0000_snapshot.json` (generated)
- Create: `apps/audit/src/plugins/db.ts`
- Create: `apps/audit/src/lib/roles.ts`
- Create: `apps/audit/src/lib/migrate-run.ts`
- Create: `apps/audit/src/cli/migrate.ts`
- Create: `apps/audit/src/test/db.ts`
- Create: `apps/audit/src/test/app.ts`
- Test: `apps/audit/src/db/storage.test.ts`
- Test: `apps/audit/src/plugins/db.test.ts`
- Test: `apps/audit/src/test/harness.test.ts`
- Test: `apps/audit/src/lib/migrate-run.test.ts`
- Test: `apps/audit/src/lib/roles.test.ts`

**Interfaces:**
- Consumes: Task 1's `AuditEvent` / `AuditEventSchema` from `@rch/contract`; Task 9's `AuditConfig`, `loadConfig`, `ConfigError`, `buildApp`, `AuditApp`, `AppDeps`, `app.readiness.addCheck`, `app.metrics.registry`, `testKeyPair`, `testConfig`.
- Produces: `Db`, `Tx`, `createDb`, `pgSsl`, `withoutSslParams`; `runMigrations(db, auditSchema)`, `appliedMigrationCount(db, auditSchema)`, `journalLength()`, `migrationsSchemaOf`; `events`, `deadLetters`; `app.db`, `app.pool`; `roleFromUrls`, `ensureLoginRole`, `grantAuditRole`, `LoginRole`; `migrateAudit`, `waitForOutbox`, `outboxExists`, `OutboxMissingError`, `AUDIT_MIGRATE_LOCK`, `OUTBOX_WAIT`; `buildTestApp`, `AuditTestDb`, `signToken`, `putOutbox`, `sampleEvent`, `withAuditSchema`, `resetAudit`, `warmPool`, `schemaPair`, `TEST_DATABASE_URL`.

Needs Postgres on 5439 (`pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log db:up`) and Task 1 landed (`AuditEventSchema` exported from `@rch/contract`).

- [ ] **Step 1: Add the storage dependencies and the CLI entry**

Replace `apps/audit/package.json` with:

````json
{
  "name": "@rch/audit",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "PORT=3100 tsx watch --env-file=../../.env src/server.ts",
    "build": "tsup",
    "start": "node dist/server.mjs",
    "typecheck": "tsc --noEmit",
    "lint": "oxlint --max-warnings 0",
    "test": "vitest run --coverage",
    "db:generate": "node scripts/db-generate.mjs",
    "db:migrate": "tsx --env-file=../../.env src/cli/migrate.ts"
  },
  "dependencies": {
    "@fastify/helmet": "^13.1.1",
    "@rch/contract": "workspace:*",
    "drizzle-orm": "^0.45.2",
    "fast-jwt": "^6.3.3",
    "fastify": "^5.12.1",
    "fastify-plugin": "^6.0.0",
    "fastify-type-provider-zod": "^7.0.0",
    "pg": "^8.23.0",
    "prom-client": "^15.1.3",
    "zod": "^4.5.4"
  },
  "devDependencies": {
    "@types/node": "^24.13.3",
    "@types/pg": "^8.23.1",
    "@vitest/coverage-v8": "^4.1.11",
    "drizzle-kit": "^0.31.10",
    "tsup": "^8.5.1",
    "tsx": "^4.23.13",
    "vitest": "^4.1.11"
  }
}
````

Replace `apps/audit/tsup.config.ts` with:

````ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    server: "src/server.ts",
    "cli/migrate": "src/cli/migrate.ts",
  },
  format: ["esm"],
  target: "node24",
  outExtension: () => ({ js: ".mjs" }),
  sourcemap: true,
  clean: true,
  // Workspace packages are TypeScript source; bundle them. Everything else stays external.
  noExternal: [/^@rch\//],
});
````

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log install`
Expected: exits 0; `pnpm-lock.yaml` gains the new dependencies under the `apps/audit` importer (`@rch/contract` as `link:../../packages/contract`).

- [ ] **Step 2: Write the failing storage test**

`apps/audit/src/db/storage.test.ts`:

````ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { resetAudit, TEST_DATABASE_URL, withAuditSchema, type AuditTestDb } from "../test/db.js";
import { createDb } from "./client.js";
import { appliedMigrationCount, journalLength, runMigrations } from "./migrate.js";
import { deadLetters, events } from "./schema.js";

const APPEND_ONLY = (table: string) => `${table} is append-only; the audit log is never edited`;

/** The database's own error, from under drizzle's "Failed query: …" wrapper. */
async function dbError(p: Promise<unknown>): Promise<{ message: string; code?: string; constraint?: string }> {
  try { await p; return { message: "<the database allowed it>" }; } catch (e) {
    const cause = (e as { cause?: unknown }).cause;
    const err = (cause instanceof Error ? cause : e) as Error & { code?: string; constraint?: string };
    return { message: err.message, code: err.code, constraint: err.constraint };
  }
}

const row = (outboxId: number) => ({
  outboxId, at: new Date("2026-09-14T04:30:00Z"), requestId: `req-${outboxId}`,
  actorId: "u2", actorEmp: "RC-3120", actorName: "Ramesh Kumar", actorRole: "Outlet Manager", actorLoc: "rest",
  action: "voidBill", method: "POST", path: "/bills/:no/void", outcome: "done" as const, status: 200,
});

let t: AuditTestDb;
beforeAll(async () => { t = await withAuditSchema("storage"); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await resetAudit(t); });

describe("the audit migrations", () => {
  it("apply every journal entry, with the bookkeeping in <audit schema>_drizzle", async () => {
    expect(journalLength()).toBeGreaterThanOrEqual(1);
    expect(await appliedMigrationCount(t.db, t.auditSchema)).toBe(journalLength());
    const r = await t.db.execute(sql`select table_schema as s from information_schema.tables where table_name = '__drizzle_migrations' and table_schema like ${`${t.outboxSchema}%`}`);
    expect(r.rows.map((x) => (x as { s: string }).s)).toEqual([`${t.auditSchema}_drizzle`]);
  });

  it("create the audit tables in the audit schema and leave the outbox where the API put it", async () => {
    const at = async (name: string) => (await t.db.execute(sql`select to_regclass(${name}) as r`)).rows[0] as { r: string | null };
    expect((await at(`"${t.auditSchema}".events`)).r).not.toBeNull();
    expect((await at(`"${t.auditSchema}".dead_letters`)).r).not.toBeNull();
    expect((await at(`"${t.outboxSchema}".audit_outbox`)).r).not.toBeNull();
    expect((await at(`"${t.outboxSchema}".events`)).r).toBeNull();
    expect((await at(`"${t.auditSchema}".audit_outbox`)).r).toBeNull();
  });

  it("run again without applying anything twice", async () => {
    await runMigrations(t.db, t.auditSchema);
    expect(await appliedMigrationCount(t.db, t.auditSchema)).toBe(journalLength());
  });

  it("refuse a connection whose search_path would put the tables somewhere else", async () => {
    const stray = `${t.outboxSchema}_x`;
    const { db, pool } = createDb(TEST_DATABASE_URL, false, { max: 1, searchPath: "public" });
    try {
      await expect(runMigrations(db, stray)).rejects.toThrow(`The connection's search_path starts at public, not ${stray}`);
    } finally {
      await pool.query(`drop schema if exists "${stray}" cascade`);
      await pool.end();
    }
  });
});

describe("events", () => {
  it("stores a row with the defaults the drainer relies on", async () => {
    await t.db.insert(events).values(row(1));
    const [stored] = await t.db.select().from(events);
    expect(stored).toMatchObject({ outboxId: 1, target: "", targetLoc: "", message: "", cause: null, request: {}, before: null, result: null, changed: [], ip: "", userAgent: "" });
    expect(stored.storedAt).toBeInstanceOf(Date);
  });

  it("stores one row per outbox id", async () => {
    await t.db.insert(events).values(row(7));
    const e = await dbError(t.db.insert(events).values(row(7)));
    expect(e.code).toBe("23505");
    expect(e.constraint).toBe("events_outbox_id_uq");
  });

  it("refuses an outcome that is not done, refused or error", async () => {
    const e = await dbError(t.db.execute(sql`insert into events (outbox_id, at, request_id, actor_emp, actor_name, actor_role, actor_loc, action, method, path, outcome, status)
      values (8, now(), 'r', 'RC-1', 'n', 'r', 'l', 'a', 'POST', '/x', 'maybe', 200)`));
    expect(e.constraint).toBe("events_outcome_ck");
  });
});

describe("the audit tables are append-only in the database", () => {
  it("refuses UPDATE, DELETE and TRUNCATE on events, even one that matches no row", async () => {
    await t.db.insert(events).values(row(1));
    expect((await dbError(t.db.execute(sql`update events set message = 'rewritten'`))).message).toBe(APPEND_ONLY("events"));
    expect((await dbError(t.db.execute(sql`delete from events where id < 0`))).message).toBe(APPEND_ONLY("events"));
    expect((await dbError(t.db.execute(sql`truncate events`))).message).toBe(APPEND_ONLY("events"));
    expect(await t.db.select().from(events)).toHaveLength(1);
  });

  it("refuses UPDATE, DELETE and TRUNCATE on dead_letters", async () => {
    await t.db.insert(deadLetters).values({ outboxId: 3, at: new Date(), event: { nope: true }, issue: "actor: Required" });
    expect((await dbError(t.db.execute(sql`update dead_letters set issue = 'fine'`))).message).toBe(APPEND_ONLY("dead_letters"));
    expect((await dbError(t.db.execute(sql`delete from dead_letters`))).message).toBe(APPEND_ONLY("dead_letters"));
    expect((await dbError(t.db.execute(sql`truncate dead_letters`))).message).toBe(APPEND_ONLY("dead_letters"));
    expect(await t.db.select().from(deadLetters)).toHaveLength(1);
  });
});

describe("resetAudit", () => {
  it("empties the outbox and both tables, and turns the triggers back on", async () => {
    await t.pool.query(`insert into "${t.outboxSchema}".audit_outbox (event) values ('{}')`);
    await t.db.insert(events).values(row(1));
    await t.db.insert(deadLetters).values({ outboxId: 2, at: new Date(), event: {}, issue: "actor: Required" });
    await resetAudit(t);
    expect(await t.db.select().from(events)).toHaveLength(0);
    expect(await t.db.select().from(deadLetters)).toHaveLength(0);
    expect((await t.pool.query(`select count(*)::int as n from "${t.outboxSchema}".audit_outbox`)).rows[0].n).toBe(0);
    expect((await dbError(t.db.execute(sql`delete from events`))).message).toBe(APPEND_ONLY("events"));
  });
});
````

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/db/storage.test.ts`
Expected: FAIL - vitest cannot load `../test/db.js`, `./client.js`, `./migrate.js` or `./schema.js`.

- [ ] **Step 4: Write the Drizzle schema, the client and the generate script**

`apps/audit/src/db/schema.ts`:

````ts
import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * One row per audited action, moved here from the API's `audit_outbox` by the drainer. Every
 * column is what the event said at the time - the actor's name, role and location as they stood -
 * so a renamed or deleted account still reads correctly, and nothing references the API's tables.
 *
 * Unqualified: the tables resolve through `search_path = AUDIT_SCHEMA` (spec §3.2). Append-only in
 * the database (drizzle/0000_audit_events.sql's trigger), which drizzle-kit cannot see.
 */
export const events = pgTable("events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  /** The outbox row this came from. Unique: the backstop behind the drain's exactly-once move. */
  outboxId: bigint("outbox_id", { mode: "number" }).notNull().unique("events_outbox_id_uq"),
  at: ts("at").notNull(),
  requestId: text("request_id").notNull(),
  /** No foreign key, on purpose: deleting an account must not touch its history. */
  actorId: text("actor_id"),
  actorEmp: text("actor_emp").notNull(),
  actorName: text("actor_name").notNull(),
  actorRole: text("actor_role").notNull(),
  actorLoc: text("actor_loc").notNull(),
  /** A manifest route name or login/logout/changePassword. A plain string, so a removed route's history still reads. */
  action: text("action").notNull(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  target: text("target").notNull().default(""),
  targetLoc: text("target_loc").notNull().default(""),
  outcome: text("outcome", { enum: ["done", "refused", "error"] }).notNull(),
  status: smallint("status").notNull(),
  message: text("message").notNull().default(""),
  cause: text("cause"),
  request: jsonb("request").notNull().default({}),
  before: jsonb("before"),
  result: jsonb("result"),
  changed: text("changed").array().notNull().default(sql`'{}'::text[]`),
  ip: text("ip").notNull().default(""),
  userAgent: text("user_agent").notNull().default(""),
  storedAt: ts("stored_at").notNull().defaultNow(),
}, (t) => [
  check("events_outcome_ck", sql`${t.outcome} in ('done', 'refused', 'error')`),
  // The page is keyset-paged on id; each filter the read route offers has an index that ends in it.
  index("events_at_idx").on(t.at.desc(), t.id.desc()),
  index("events_actor_idx").on(t.actorId, t.id.desc()),
  index("events_target_idx").on(t.target, t.id.desc()),
  index("events_action_idx").on(t.action, t.id.desc()),
  index("events_outcome_idx").on(t.outcome, t.id.desc()),
]);

/** An outbox row whose event failed `AuditEventSchema`, kept whole with the first issue, so a
 *  malformed event is never silently dropped and never blocks the ones behind it. */
export const deadLetters = pgTable("dead_letters", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  outboxId: bigint("outbox_id", { mode: "number" }).notNull(),
  at: ts("at").notNull(),
  event: jsonb("event").notNull(),
  issue: text("issue").notNull(),
  storedAt: ts("stored_at").notNull().defaultNow(),
});
````

`apps/audit/src/db/client.ts`:

````ts
import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

/** RDS connections verify the AWS CA bundle baked into the image. Shared with the drainer's
 *  dedicated LISTEN client, which is not a pool member. */
export function pgSsl(ssl: boolean): ConnectionOptions | undefined {
  return ssl ? { rejectUnauthorized: true, ca: readFileSync(process.env.PG_CA_BUNDLE ?? "/etc/ssl/rds-global-bundle.pem", "utf8") } : undefined;
}

/** `DATABASE_SSL` alone decides TLS: an `sslmode=` on the URL would make the driver ignore the
 *  `ssl` object and verify against the system store instead (apps/api/src/db/client.ts). */
export function withoutSslParams(url: string): string {
  const u = new URL(url);
  for (const k of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey"]) u.searchParams.delete(k);
  return u.toString();
}

/**
 * One pool per process, on `search_path = searchPath` (AUDIT_SCHEMA) so the unqualified tables in
 * `schema.ts` and the migrations resolve to the audit schema. The outbox is never reached through
 * the path; it is always named with its schema.
 *
 * `statementTimeoutMs` is 15 s for the service. The migrate CLI passes 0: it waits inside a
 * statement for the advisory lock while another replica migrates.
 */
export function createDb(url: string, ssl: boolean, opts: { max: number; searchPath?: string; statementTimeoutMs?: number }): { db: Db; pool: Pool } {
  const pool = new Pool({
    connectionString: withoutSslParams(url),
    max: opts.max,
    ssl: pgSsl(ssl),
    statement_timeout: opts.statementTimeoutMs ?? 15_000,
    idle_in_transaction_session_timeout: 30_000,
    application_name: "rch-audit",
    options: opts.searchPath ? `-c search_path=${opts.searchPath}` : undefined,
  });
  return { db: drizzle({ client: pool, schema }), pool };
}
````

`apps/audit/drizzle.config.ts`:

````ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // `generate` diffs schema.ts against drizzle/meta and never connects; the URL is only here
  // because drizzle-kit's config requires one.
  dbCredentials: { url: process.env.MIGRATE_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch" },
  strict: true,
  verbose: true,
});
````

`apps/audit/scripts/db-generate.mjs`:

````js
// `db:generate`: drizzle-kit generate (arguments such as `--name` are forwarded to it), then strip
// the literal "public". prefix drizzle-kit writes before a type or a reference, so every audit
// migration resolves through search_path - the migrate CLI and the test harness set it to
// AUDIT_SCHEMA. One script rather than an `a && b` chain, so pnpm's trailing arguments reach
// drizzle-kit and not the strip step (apps/api/scripts/db-generate.mjs tells that story).

import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const generate = spawnSync(join(root, "node_modules", ".bin", "drizzle-kit"), ["generate", ...process.argv.slice(2)], { stdio: "inherit", cwd: root });
if (generate.status !== 0) process.exit(generate.status ?? 1);

const drizzleDir = join(root, "drizzle");
const files = (await readdir(drizzleDir)).filter((f) => f.endsWith(".sql"));
let touched = 0;
for (const file of files) {
  const path = join(drizzleDir, file);
  const original = await readFile(path, "utf8");
  const stripped = original.replaceAll('"public".', "");
  if (stripped !== original) {
    await writeFile(path, stripped);
    touched++;
  }
}
console.log(`strip-public-schema: rewrote ${touched} of ${files.length} file(s) in ${drizzleDir}`);
````

- [ ] **Step 5: Generate the migration**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit run db:generate --name audit_events`
Expected: `2 tables`, `events 25 columns 5 indexes 0 fks`, `Your SQL migration file ➜ drizzle/0000_audit_events.sql`, then `strip-public-schema: rewrote 0 of 1 file(s)`. It creates `drizzle/0000_audit_events.sql`, `drizzle/meta/0000_snapshot.json` and `drizzle/meta/_journal.json`, whose shape is:

````json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {
      "idx": 0,
      "version": "7",
      "when": <the Date.now() drizzle-kit wrote>,
      "tag": "0000_audit_events",
      "breakpoints": true
    }
  ]
}
````

- [ ] **Step 6: Replace the generated SQL with the reviewed migration, and reconcile**

drizzle-kit writes the two `CREATE TABLE`s and five indexes (its CHECK comes out table-qualified as `"events"."outcome"`). Replace the whole file with the reviewed version below: the same DDL, the CHECK unqualified, a header comment, and the append-only trigger drizzle-kit cannot express.

`apps/audit/drizzle/0000_audit_events.sql`:

````sql
-- The audit service's own storage. Unqualified on purpose, like every API migration: the migrate
-- CLI and the test harness run it with search_path = AUDIT_SCHEMA, so production lands in `audit`
-- and each test file in its own `t_audit_<name>_<pid>_a`. Nothing here references the API's tables.
CREATE TABLE "dead_letters" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "dead_letters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"outbox_id" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"event" jsonb NOT NULL,
	"issue" text NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"outbox_id" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"request_id" text NOT NULL,
	"actor_id" text,
	"actor_emp" text NOT NULL,
	"actor_name" text NOT NULL,
	"actor_role" text NOT NULL,
	"actor_loc" text NOT NULL,
	"action" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"target_loc" text DEFAULT '' NOT NULL,
	"outcome" text NOT NULL,
	"status" smallint NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"cause" text,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"before" jsonb,
	"result" jsonb,
	"changed" text[] DEFAULT '{}'::text[] NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_outbox_id_uq" UNIQUE("outbox_id"),
	CONSTRAINT "events_outcome_ck" CHECK ("outcome" in ('done', 'refused', 'error'))
);
--> statement-breakpoint
CREATE INDEX "events_at_idx" ON "events" USING btree ("at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_actor_idx" ON "events" USING btree ("actor_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_target_idx" ON "events" USING btree ("target","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_action_idx" ON "events" USING btree ("action","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_outcome_idx" ON "events" USING btree ("outcome","id" DESC NULLS LAST);--> statement-breakpoint

-- Retention is forever and a log that can be edited is not a log. The API's ledger triggers (its
-- 0002 and 0008) refuse UPDATE and DELETE row by row; these are statement-level so they also refuse
-- TRUNCATE, and refuse an UPDATE or DELETE that matches no row, for every role including the owner.
-- Invisible to drizzle-kit, like the API's triggers: that is not drift.
CREATE OR REPLACE FUNCTION audit_append_only() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION '% is append-only; the audit log is never edited', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON "events" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
--> statement-breakpoint
CREATE TRIGGER dead_letters_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON "dead_letters" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
````

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit run db:generate`
Expected: `No schema changes, nothing to migrate 😴` - the snapshot already matches `schema.ts`, and the trigger is invisible to drizzle-kit by design.

- [ ] **Step 7: Implement the migrator and the per-file schema harness**

`apps/audit/src/db/migrate.ts`:

````ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeIdentifier } from "pg";
import type { Db } from "./client.js";

// src/db/ is two levels below apps/audit; dist/cli/ is two below the image's /app. Walk up from
// this file until a drizzle/meta/_journal.json shows up.
function migrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    try { readFileSync(join(dir, "drizzle", "meta", "_journal.json")); return join(dir, "drizzle"); } catch { dir = dirname(dir); }
  }
  throw new Error("drizzle/ migrations folder not found");
}

/** How many migrations this image carries - what /readyz compares the database against. */
export function journalLength(): number {
  const j = JSON.parse(readFileSync(join(migrationsFolder(), "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
  return j.entries.length;
}

/** Drizzle's bookkeeping schema for an audit schema: `audit_drizzle` in production, apart from the
 *  API's `drizzle`, so neither service's /readyz counts the other's migrations. */
export const migrationsSchemaOf = (auditSchema: string): string => `${auditSchema}_drizzle`;

/**
 * Creates `auditSchema` if it is missing and applies the journal into it. The SQL is unqualified,
 * so `db`'s connections must already have `search_path` starting at `auditSchema`
 * (`createDb(…, { searchPath: auditSchema })`); a connection that does not is refused before
 * anything is created in the wrong schema.
 */
export async function runMigrations(db: Db, auditSchema: string): Promise<void> {
  await db.execute(sql.raw(`create schema if not exists ${escapeIdentifier(auditSchema)}`));
  const r = await db.execute(sql`select current_schema() as s`);
  const current = (r.rows[0] as { s: string | null }).s;
  if (current !== auditSchema) {
    throw new Error(`The connection's search_path starts at ${current ?? "no schema"}, not ${auditSchema}; refusing to migrate into the wrong schema.`);
  }
  await migrate(db, { migrationsFolder: migrationsFolder(), migrationsSchema: migrationsSchemaOf(auditSchema) });
}

/** How many audit migrations this database has applied. Throws when none ever ran. */
export async function appliedMigrationCount(db: Db, auditSchema: string): Promise<number> {
  const r = await db.execute(sql.raw(`select count(*)::int as n from ${escapeIdentifier(migrationsSchemaOf(auditSchema))}."__drizzle_migrations"`));
  return Number((r.rows[0] as { n: number }).n);
}
````

`apps/audit/src/test/db.ts`:

````ts
import { escapeIdentifier, Pool } from "pg";
import { createDb, type Db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test";

export type AuditTestDb = { db: Db; pool: Pool; outboxSchema: string; auditSchema: string; close(): Promise<void> };

/** Spec §2.1's outbox and the trigger that refuses every UPDATE on it, as the API's migration
 *  (0016_audit_outbox) creates them. The audit service never imports apps/api, so the harness keeps this copy: change the
 *  API's DDL and change this with it. */
const outboxDdl = (schema: string) => {
  const s = escapeIdentifier(schema);
  return [
    `create table ${s}.audit_outbox (
      id bigint generated always as identity primary key,
      at timestamptz not null default now(),
      event jsonb not null
    )`,
    `create function ${s}.audit_outbox_no_update() returns trigger as $$
    begin
      raise exception 'audit_outbox rows are never updated; the audit service moves each one as it was written';
    end;
    $$ language plpgsql`,
    `create trigger audit_outbox_no_update before update on ${s}.audit_outbox for each row execute function ${s}.audit_outbox_no_update()`,
  ];
};

/** `t_audit_<name>_<pid>` holds the outbox (and stands in for the API's schema); the audit tables
 *  go in `<that>_a` and drizzle's bookkeeping in `<that>_a_drizzle`. The pid keeps two checkouts
 *  sharing port 5439 apart; the 30-character cap keeps `rch_events_<outbox schema>` inside
 *  Postgres's 63-byte channel name. */
function schemaPair(name: string): { outboxSchema: string; auditSchema: string } {
  const slug = name.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  if (slug.length > 30) throw new Error(`Test schema name "${name}" is longer than 30 characters.`);
  const outboxSchema = `t_audit_${slug}_${process.pid}`;
  return { outboxSchema, auditSchema: `${outboxSchema}_a` };
}

async function asAdmin(fn: (admin: Pool) => Promise<void>): Promise<void> {
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try { await fn(admin); } finally { await admin.end(); }
}

/** Creates the schema pair, the outbox and the migrated audit tables, and returns a pool of 4 on
 *  `search_path = <audit schema>` - the service's own shape. `close` ends the pool and drops all three. */
export async function withAuditSchema(name: string): Promise<AuditTestDb> {
  const { outboxSchema, auditSchema } = schemaPair(name);
  const drop = (admin: Pool) => Promise.all(
    [outboxSchema, auditSchema, `${auditSchema}_drizzle`].map((s) => admin.query(`drop schema if exists ${escapeIdentifier(s)} cascade`)),
  ).then(() => undefined);
  await asAdmin(async (admin) => {
    await drop(admin);
    await admin.query(`create schema ${escapeIdentifier(outboxSchema)}`);
    for (const statement of outboxDdl(outboxSchema)) await admin.query(statement);
  });
  const { db, pool } = createDb(TEST_DATABASE_URL, false, { max: 4, searchPath: auditSchema });
  await runMigrations(db, auditSchema);
  return {
    db, pool, outboxSchema, auditSchema,
    close: async () => { await pool.end(); await asAdmin(drop); },
  };
}

/** Inserts `events` into this file's outbox, one row each, in order, the way the API does - but
 *  without the `pg_notify`: a test about wake-ups sends `pg_notify('rch_audit_outbox', '')` itself. */
export async function putOutbox(t: AuditTestDb, events: unknown[]): Promise<void> {
  if (events.length === 0) return;
  const values = events.map((_, i) => `($${i + 1}::jsonb)`).join(", ");
  await t.pool.query(`insert into ${escapeIdentifier(t.outboxSchema)}.audit_outbox (event) values ${values}`, events.map((e) => JSON.stringify(e)));
}

/** Empties the outbox, `events` and `dead_letters` between cases. The append-only triggers refuse
 *  TRUNCATE, so they are switched off and on again inside one transaction, as the owner - which
 *  also proves nothing short of the owner's `alter table` gets past them. */
export async function resetAudit(t: AuditTestDb): Promise<void> {
  const a = escapeIdentifier(t.auditSchema);
  const client = await t.pool.connect();
  try {
    await client.query("begin");
    await client.query(`alter table ${a}.events disable trigger events_append_only`);
    await client.query(`alter table ${a}.dead_letters disable trigger dead_letters_append_only`);
    await client.query(`truncate ${escapeIdentifier(t.outboxSchema)}.audit_outbox, ${a}.events, ${a}.dead_letters restart identity`);
    await client.query(`alter table ${a}.events enable trigger events_append_only`);
    await client.query(`alter table ${a}.dead_letters enable trigger dead_letters_append_only`);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
````

- [ ] **Step 8: Run the storage test to verify it passes**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/db/storage.test.ts`
Expected: PASS - 10 tests (migrations applied into `<audit>_drizzle`, tables placed, idempotent re-run, a wrong search_path refused, row defaults, `events_outbox_id_uq`, `events_outcome_ck`, UPDATE/DELETE/TRUNCATE refused on both tables, `resetAudit`).

- [ ] **Step 9: Write the failing readiness and harness tests**

`apps/audit/src/plugins/db.test.ts`:

````ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { journalLength } from "../db/migrate.js";
import { buildTestApp } from "../test/app.js";
import { testConfig } from "../test/config.js";

/** `journalLength` reads drizzle/meta/_journal.json off the image's disk with no knob to point it
 *  elsewhere, so the "journal unreadable" branch makes that one function throw. Everything else in
 *  the module stays real - the harness migrates with it. */
const journal = vi.hoisted(() => ({ fails: false }));
vi.mock("../db/migrate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/migrate.js")>();
  return {
    ...actual,
    journalLength: () => {
      if (journal.fails) throw new Error("ENOENT: no such file or directory, open '/app/drizzle/meta/_journal.json'");
      return actual.journalLength();
    },
  };
});

let app: Awaited<ReturnType<typeof buildTestApp>>;
// `drainer: true` so that, once plugins/drainer.ts gates readiness too, a ready app here still means ready.
beforeAll(async () => { app = await buildTestApp({ schema: "db", drainer: true }); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("the database readiness check", () => {
  it("is ready on a migrated schema, and publishes the pool's depth", async () => {
    const r = await app.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    const m = await app.inject({ method: "GET", url: "/metrics" });
    expect(m.body).toContain("pg_pool_total");
    expect(m.body).toContain("pg_pool_waiting");
  });

  it("names an unreadable journal without printing the image's paths", async () => {
    journal.fails = true;
    try {
      const r = await app.inject({ method: "GET", url: "/readyz" });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.message).toContain("database - migration journal unreadable");
      expect(r.body).not.toContain("_journal.json");
    } finally {
      journal.fails = false;
    }
  });

  it("names a database it cannot read migrations from, without the SQL", async () => {
    const bare = await buildApp(testConfig({ AUDIT_SCHEMA: `t_audit_none_${process.pid}` }), { drainer: false });
    try {
      const r = await bare.inject({ method: "GET", url: "/readyz" });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.message).toContain("database - unreachable or unmigrated");
      expect(r.body).not.toContain("__drizzle_migrations");
    } finally {
      await bare.close();
    }
  });

  it("refuses a database handle that comes without its pool", async () => {
    await expect(buildApp(testConfig(), { db: app.testDb.db, drainer: false })).rejects.toThrow("A supplied database handle must come with the pool behind it.");
  });

  // Last, and destructive: empties this file's own bookkeeping, which is what a pod started against a
  // database its image has outrun looks like. The schemas are this file's alone and dropped on close.
  it("says how far behind the schema is", async () => {
    await app.testDb.pool.query(`delete from "${app.testDb.auditSchema}_drizzle"."__drizzle_migrations"`);
    const r = await app.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.message).toContain(`database - schema at 0/${journalLength()} migrations`);
  });
});
````

`apps/audit/src/test/harness.test.ts`:

````ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVerifier } from "fast-jwt";
import { AuditEventSchema } from "@rch/contract";
import { buildTestApp, putOutbox, sampleEvent, signToken } from "./app.js";

const verifierFor = (key: string) => createVerifier({ key, algorithms: ["EdDSA"], allowedIss: "rch-api" });

let app: Awaited<ReturnType<typeof buildTestApp>>;
beforeAll(async () => { app = await buildTestApp({ schema: "harness", drainer: false }); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("buildTestApp", () => {
  it("points the app at its own schema pair, with the events channel on the outbox schema", () => {
    expect(app.config.auditSchema).toBe(app.testDb.auditSchema);
    expect(app.config.outboxSchema).toBe(app.testDb.outboxSchema);
    expect(app.config.eventsSchema).toBe(app.testDb.outboxSchema);
    expect(app.testDb.outboxSchema).toBe(`t_audit_harness_${process.pid}`);
    expect(app.db).toBe(app.testDb.db);
  });

  it("signs tokens the way the API does, with the current key or the previous one", () => {
    const claims = { sub: "u9", role: "manager", loc: "rest", admin: true };
    const current = verifierFor(app.config.jwtPublicKeyPem)(signToken(app, claims));
    expect(current).toMatchObject({ sub: "u9", role: "manager", loc: "rest", admin: true, mcp: false, iss: "rch-api" });
    expect(current.exp - current.iat).toBe(15 * 60);
    const previous = signToken(app, claims, { previousKey: true });
    expect(() => verifierFor(app.config.jwtPublicKeyPem)(previous)).toThrow();
    expect(verifierFor(app.config.jwtPreviousPublicKeyPem!)(previous)).toMatchObject({ sub: "u9" });
  });

  it("puts outbox rows in the order given, and sampleEvent is a valid event", async () => {
    expect(AuditEventSchema.safeParse(sampleEvent()).success).toBe(true);
    expect(sampleEvent({ outcome: "refused", status: 422 })).toMatchObject({ outcome: "refused", status: 422, action: "voidBill" });
    await putOutbox(app.testDb, [sampleEvent({ requestId: "a" }), { not: "an event" }, sampleEvent({ requestId: "c" })]);
    const r = await app.testDb.pool.query(`select event from "${app.testDb.outboxSchema}".audit_outbox order by id`);
    expect(r.rows.map((x: { event: { requestId?: string } }) => x.event.requestId)).toEqual(["a", undefined, "c"]);
  });

  it("builds the outbox with the API's refusal of every UPDATE", async () => {
    await putOutbox(app.testDb, [sampleEvent()]);
    await expect(app.testDb.pool.query(`update "${app.testDb.outboxSchema}".audit_outbox set at = now()`)).rejects.toThrow("audit_outbox rows are never updated; the audit service moves each one as it was written");
  });

  it("drops its schemas when the app closes", async () => {
    const other = await buildTestApp({ schema: "harness_close", drainer: false });
    const { outboxSchema, auditSchema } = other.testDb;
    await other.close();
    const r = await app.testDb.pool.query("select nspname from pg_namespace where nspname = any($1)", [[outboxSchema, auditSchema, `${auditSchema}_drizzle`]]);
    expect(r.rows).toEqual([]);
  });
});
````

- [ ] **Step 10: Run them to verify they fail**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/plugins/db.test.ts src/test/harness.test.ts`
Expected: FAIL - vitest cannot load `../test/app.js` / `./app.js` (the test app does not exist yet).

- [ ] **Step 11: Implement the db plugin, wire it into the app, and build the test app**

`apps/audit/src/plugins/db.ts`:

````ts
import fp from "fastify-plugin";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { Gauge } from "prom-client";
import { createDb, type Db } from "../db/client.js";
import { appliedMigrationCount, journalLength } from "../db/migrate.js";

declare module "fastify" { interface FastifyInstance { db: Db; pool: Pool } }

/** `db` and `pool` together are a caller's own handle (the test harness); without them the
 *  plugin opens a pool on `searchPath` and closes it again with the app. */
export type DbPluginOptions = { url: string; ssl: boolean; max: number; searchPath: string; auditSchema: string; db?: Db; pool?: Pool };

export default fp<DbPluginOptions>(async (app, opts) => {
  let db = opts.db;
  let pool = opts.pool;
  let owned: Pool | undefined;
  if (!db || !pool) {
    if (db || pool) throw new Error("A supplied database handle must come with the pool behind it.");
    const c = createDb(opts.url, opts.ssl, { max: opts.max, searchPath: opts.searchPath });
    db = c.db;
    pool = owned = c.pool;
  }
  const handle = db;
  const counts = pool;
  app.decorate("db", handle);
  app.decorate("pool", counts);

  // Read at scrape time, not sampled: a gauge that lags hides the exhaustion it exists to show.
  const gauge = (name: string, help: string, read: () => number) =>
    new Gauge({ name, help, registers: [app.metrics.registry], collect() { this.set(read()); } });
  gauge("pg_pool_total", "Connections the pool holds", () => counts.totalCount);
  gauge("pg_pool_idle", "Connections the pool holds that are idle", () => counts.idleCount);
  gauge("pg_pool_waiting", "Requests queued for a connection", () => counts.waitingCount);

  // Three reasons, each one an operator acts on differently, and none of them the driver's own
  // words (a DrizzleQueryError carries SQL, an fs error the image's paths): the database cannot be
  // reached or was never migrated, the image's journal cannot be read, or the schema is behind it.
  app.readiness.addCheck("database", async () => {
    let applied: number;
    try {
      await handle.execute(sql`select 1`);
      applied = await appliedMigrationCount(handle, opts.auditSchema);
    } catch (cause) {
      throw new Error("unreachable or unmigrated", { cause });
    }
    let expected: number;
    try {
      expected = journalLength();
    } catch (cause) {
      throw new Error("migration journal unreadable", { cause });
    }
    if (applied !== expected) throw new Error(`schema at ${applied}/${expected} migrations`);
  });
  // Only the pool this plugin opened is its to close; a supplied one belongs to the caller.
  app.addHook("onClose", async () => { await owned?.end(); });
}, { name: "db", dependencies: ["health", "metrics"] });
````

Replace `apps/audit/src/app.ts` with:

````ts
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { AuditConfig } from "./config.js";
import type { Db } from "./db/client.js";
import logging, { genReqId, loggerOptions, type LogStream } from "./plugins/logging.js";
import errors from "./plugins/errors.js";
import metrics from "./plugins/metrics.js";
import health from "./plugins/health.js";
import security from "./plugins/security.js";
import db from "./plugins/db.js";

declare module "fastify" { interface FastifyInstance { config: AuditConfig } }

export type AuditApp = FastifyInstance;
/**
 * - `db` + `pool`: a handle the caller owns (the test harness); otherwise the db plugin opens one on
 *   `searchPath`, which defaults to `config.auditSchema`.
 * - `logStream`: where the log goes when it is not stdout - a test reading its own lines back.
 * - `drainer`: whether `plugins/drainer.ts` starts its LISTEN client and poll timer; a test that
 *   drives a pass by hand passes `false`.
 * - `cleanup`: run once the app has closed, after every plugin's own `onClose` - the test harness
 *   drops its schemas there.
 */
export type AppDeps = { db?: Db; pool?: Pool; searchPath?: string; logStream?: LogStream; drainer?: boolean; cleanup?: () => Promise<void> };

export async function buildApp(config: AuditConfig, deps: AppDeps = {}): Promise<AuditApp> {
  const app = Fastify({
    logger: loggerOptions(config.logLevel, deps.logStream),
    genReqId,
    trustProxy: config.trustProxy,
    // Every route is a GET; nothing this service accepts has a body worth more than a header.
    bodyLimit: 64 * 1024,
    forceCloseConnections: "idle",
    logController: new LogController({ disableRequestLogging: true }),
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
  }).withTypeProvider<ZodTypeProvider>();
  // The first onClose hook added is the last to run (avvio runs them newest first), so a caller's
  // cleanup comes after every plugin has let go of the pool.
  const cleanup = deps.cleanup;
  if (cleanup) app.addHook("onClose", async () => { await cleanup(); });
  app.decorate("config", config);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(logging);
  await app.register(errors);
  await app.register(metrics);
  await app.register(health);
  await app.register(security);
  await app.register(db, { url: config.databaseUrl, ssl: config.databaseSsl, max: config.dbPoolMax, searchPath: deps.searchPath ?? config.auditSchema, auditSchema: config.auditSchema, db: deps.db, pool: deps.pool });
  return app;
}
````

`apps/audit/src/test/app.ts`:

````ts
import { createSigner } from "fast-jwt";
import type { AuditEvent } from "@rch/contract";
import { buildApp, type AuditApp } from "../app.js";
import { testConfig, testKeyPair } from "./config.js";
import { withAuditSchema, type AuditTestDb } from "./db.js";

export type { AuditTestDb } from "./db.js";
export { putOutbox } from "./db.js";

/** The private halves of the pairs whose public keys a test app was configured with. */
const signingKeys = new WeakMap<AuditApp, { current: string; previous: string }>();

/**
 * An app on its own schema pair (`src/test/db.ts`), with EVENTS_SCHEMA set to the outbox schema -
 * the schema a test's API would be running in - and two fresh Ed25519 pairs: JWT_PUBLIC_KEY and
 * JWT_PREVIOUS_PUBLIC_KEY, whose private halves `signToken` signs with. `env` overrides any of it.
 * Closing the app drops the schemas.
 */
export async function buildTestApp(opts: { schema: string; drainer?: boolean; env?: Partial<NodeJS.ProcessEnv> }): Promise<AuditApp & { testDb: AuditTestDb }> {
  const current = testKeyPair();
  const previous = testKeyPair();
  const testDb = await withAuditSchema(opts.schema);
  let app: AuditApp;
  try {
    const config = testConfig({
      AUDIT_SCHEMA: testDb.auditSchema,
      OUTBOX_SCHEMA: testDb.outboxSchema,
      EVENTS_SCHEMA: testDb.outboxSchema,
      JWT_PUBLIC_KEY: current.publicKeyB64,
      JWT_PREVIOUS_PUBLIC_KEY: previous.publicKeyB64,
      ...opts.env,
    });
    app = await buildApp(config, { db: testDb.db, pool: testDb.pool, searchPath: testDb.auditSchema, drainer: opts.drainer, cleanup: testDb.close });
  } catch (e) {
    await testDb.close();
    throw e;
  }
  signingKeys.set(app, { current: current.privateKeyPem, previous: previous.privateKeyPem });
  return Object.assign(app, { testDb });
}

/** An access token shaped exactly like the API's `signAccess` (EdDSA, `iss: "rch-api"`, 15 min),
 *  signed with the app's current key or, with `previousKey`, the rotated-out one. */
export function signToken(app: AuditApp, claims: { sub: string; role: string; loc: string; admin: boolean; mcp?: boolean }, opts: { previousKey?: boolean } = {}): string {
  const keys = signingKeys.get(app);
  if (!keys) throw new Error("signToken needs an app built by buildTestApp.");
  const sign = createSigner({ key: opts.previousKey ? keys.previous : keys.current, algorithm: "EdDSA", iss: "rch-api", expiresIn: "15m" });
  return sign({ sub: claims.sub, role: claims.role, loc: claims.loc, mcp: claims.mcp ?? false, admin: claims.admin });
}

/** A valid event: the manager voiding a bill. Override any field; the result is not re-parsed,
 *  so a test after a dead letter builds its own broken object instead. */
export const sampleEvent = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  at: "2026-09-14T04:30:00.000Z",
  requestId: "req-sample-1",
  actor: { id: "u2", emp: "RC-3120", name: "Ramesh Kumar", role: "Outlet Manager", loc: "rest" },
  action: "voidBill",
  method: "POST",
  path: "/bills/:no/void",
  target: "B-0001",
  targetLoc: "coffee",
  outcome: "done",
  status: 200,
  message: "Bill B-0001 voided.",
  cause: null,
  request: { params: { no: "B-0001" }, query: {}, body: { reason: "Billed to the wrong payer" } },
  before: null,
  result: { no: "B-0001", voided: true },
  changed: ["bills", "stock"],
  ip: "10.0.0.7",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  ...over,
});
````

- [ ] **Step 12: Run them to verify they pass**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/plugins/db.test.ts src/test/harness.test.ts src/app.test.ts src/plugins/errors.test.ts`
Expected: PASS - 5 + 5 tests, and Task 9's plumbing and envelope files stay green now that every app registers the db plugin.

- [ ] **Step 13: Write the failing migrate-step and roles tests**

`apps/audit/src/lib/migrate-run.test.ts`:

````ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createDb } from "../db/client.js";
import { journalLength } from "../db/migrate.js";
import { testConfig } from "../test/config.js";
import { TEST_DATABASE_URL, withAuditSchema, type AuditTestDb } from "../test/db.js";
import { AUDIT_MIGRATE_LOCK, migrateAudit, OUTBOX_WAIT, OutboxMissingError, outboxExists, waitForOutbox } from "./migrate-run.js";

/** A clock that only moves when the code under test sleeps. */
function fakeClock() {
  let now = 0;
  const slept: number[] = [];
  return { now: () => now, sleep: async (ms: number) => { slept.push(ms); now += ms; }, slept };
}
/** An `exists` that answers from a script, then keeps giving its last answer. */
function answers(...script: boolean[]) {
  let calls = 0;
  const fn = async () => script[Math.min(calls++, script.length - 1)];
  return { fn, calls: () => calls };
}

describe("waitForOutbox", () => {
  it("returns at once when the outbox is already there", async () => {
    const clock = fakeClock();
    const exists = answers(true);
    expect(await waitForOutbox(exists.fn, { timeoutMs: 10_000, intervalMs: 2_000, ...clock })).toBe(true);
    expect(exists.calls()).toBe(1);
    expect(clock.slept).toEqual([]);
  });

  it("looks again every interval until the outbox appears, saying how long it has waited", async () => {
    const clock = fakeClock();
    const exists = answers(false, false, true);
    const waited: number[] = [];
    expect(await waitForOutbox(exists.fn, { timeoutMs: 10_000, intervalMs: 2_000, ...clock, onWait: (ms) => waited.push(ms) })).toBe(true);
    expect(clock.slept).toEqual([2_000, 2_000]);
    expect(waited).toEqual([0, 2_000]);
  });

  it("gives up once the timeout has passed, with a last look at the deadline", async () => {
    const clock = fakeClock();
    const exists = answers(false);
    expect(await waitForOutbox(exists.fn, { timeoutMs: 5_000, intervalMs: 2_000, ...clock })).toBe(false);
    // Looks at 0, 2 and 4 s, sleeps only the 1 s left, and looks once more at 5 s.
    expect(clock.slept).toEqual([2_000, 2_000, 1_000]);
    expect(exists.calls()).toBe(4);
  });

  it("waits five minutes, every two seconds, by default", () => {
    expect(OUTBOX_WAIT).toEqual({ timeoutMs: 300_000, intervalMs: 2_000 });
  });
});

describe("migrateAudit", () => {
  let t: AuditTestDb;
  beforeAll(async () => { t = await withAuditSchema("migrate_run"); });
  afterAll(async () => { await t.close(); });

  it("finds the outbox by schema", async () => {
    expect(await outboxExists(t.db, t.outboxSchema)).toBe(true);
    expect(await outboxExists(t.db, `${t.outboxSchema}_missing`)).toBe(false);
  });

  it("migrates and skips role setup when the runtime user is the migrate user", async () => {
    const config = testConfig({ AUDIT_SCHEMA: t.auditSchema, OUTBOX_SCHEMA: t.outboxSchema, EVENTS_SCHEMA: t.outboxSchema });
    const m = createDb(TEST_DATABASE_URL, false, { max: 1, searchPath: t.auditSchema, statementTimeoutMs: 0 });
    try {
      expect(await migrateAudit(m.db, config, { log: () => {} })).toEqual({ applied: journalLength(), expected: journalLength(), role: null });
    } finally {
      await m.pool.end();
    }
  });

  it("refuses when the outbox never appears, and lets go of the advisory lock", async () => {
    const missing = `${t.outboxSchema}_missing`;
    const config = testConfig({ AUDIT_SCHEMA: t.auditSchema, OUTBOX_SCHEMA: missing, EVENTS_SCHEMA: t.outboxSchema });
    const m = createDb(TEST_DATABASE_URL, false, { max: 1, searchPath: t.auditSchema, statementTimeoutMs: 0 });
    const other = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const lines: string[] = [];
    const clock = fakeClock();
    try {
      const run = migrateAudit(m.db, config, { wait: { timeoutMs: 4_000, intervalMs: 2_000, ...clock }, log: (l) => lines.push(l) });
      await expect(run).rejects.toBeInstanceOf(OutboxMissingError);
      await expect(run).rejects.toThrow(`There is still no ${missing}.audit_outbox after 4 s. Run the API's migrations against this database first.`);
      expect(lines[0]).toBe(`Waiting for ${missing}.audit_outbox, which the API's migrations create (0 s so far).`);
      // The failed run's session is still open, so only its own unlock can have freed the lock.
      const got = await other.query(`select pg_try_advisory_lock(${AUDIT_MIGRATE_LOCK}) as ok`);
      expect(got.rows[0].ok).toBe(true);
      await other.query(`select pg_advisory_unlock(${AUDIT_MIGRATE_LOCK})`);
    } finally {
      await other.end();
      await m.pool.end();
    }
  });
});
````

`apps/audit/src/lib/roles.test.ts`:

````ts
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { escapeIdentifier, Pool } from "pg";
import { createDb } from "../db/client.js";
import { appliedMigrationCount, journalLength } from "../db/migrate.js";
import { testConfig } from "../test/config.js";
import { TEST_DATABASE_URL, withAuditSchema, type AuditTestDb } from "../test/db.js";
import { API_MIGRATE_LOCK, migrateAudit } from "./migrate-run.js";
import { ensureLoginRole, roleFromUrls } from "./roles.js";

describe("roleFromUrls", () => {
  it("is null when the runtime and migrate URLs name the same user", () => {
    expect(roleFromUrls("postgres://rch:rch@db:5432/rch", "postgres://rch:other@db:5432/rch")).toBeNull();
  });
  it("reads the runtime user and its decoded password otherwise", () => {
    expect(roleFromUrls("postgres://rch_audit:p%40ss%3Aword@db:5432/rch", "postgres://rch:rch@db:5432/rch")).toEqual({ name: "rch_audit", password: "p@ss:word" });
  });
  it("refuses a runtime URL with no user, or a separate user with no password", () => {
    expect(() => roleFromUrls("postgres://db:5432/rch", "postgres://rch:rch@db:5432/rch")).toThrow("AUDIT_DATABASE_URL names no database user.");
    expect(() => roleFromUrls("postgres://rch_audit@db:5432/rch", "postgres://rch:rch@db:5432/rch")).toThrow("AUDIT_DATABASE_URL gives no password for rch_audit");
  });
});

/** The role is cluster-wide, so its name carries the pid like the schemas do; it is dropped after. */
const ROLE = `t_audit_role_${process.pid}`;
/** A quote and a backslash, so a password that was spliced in unescaped would break the statement. */
const passwordOf = () => `it's\\a-${randomBytes(9).toString("hex")}`;
const urlAs = (user: string, password: string) => {
  const u = new URL(TEST_DATABASE_URL);
  u.username = user;
  u.password = encodeURIComponent(password);
  return u.toString();
};

/** The SQLSTATE a statement fails with, or "ok". */
async function sqlstate(p: Promise<unknown>): Promise<string> {
  try { await p; return "ok"; } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause;
    return cause?.code ?? (e as { code?: string }).code ?? "unknown";
  }
}
/** The database's sentence for a refused statement, or "ok". */
async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p; return "ok"; } catch (e) { return (e as Error).message; }
}

async function dropRole(): Promise<void> {
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    const found = await admin.query("select 1 from pg_roles where rolname = $1", [ROLE]);
    if (found.rowCount) {
      await admin.query(`drop owned by ${escapeIdentifier(ROLE)}`);
      await admin.query(`drop role ${escapeIdentifier(ROLE)}`);
    }
  } finally {
    await admin.end();
  }
}

describe("the audit service's database role", () => {
  let t: AuditTestDb;
  let password: string;
  let asRole: Pool;
  let o: string;

  /** The migrate step exactly as the CLI runs it: as the migrate user, one connection, on the audit schema. */
  async function migrateWith(rolePassword: string): Promise<{ applied: number; expected: number; role: string | null }> {
    const config = testConfig({
      AUDIT_DATABASE_URL: urlAs(ROLE, rolePassword), MIGRATE_DATABASE_URL: TEST_DATABASE_URL,
      AUDIT_SCHEMA: t.auditSchema, OUTBOX_SCHEMA: t.outboxSchema, EVENTS_SCHEMA: t.outboxSchema,
    });
    const m = createDb(config.migrateDatabaseUrl, false, { max: 1, searchPath: t.auditSchema, statementTimeoutMs: 0 });
    try { return await migrateAudit(m.db, config, { log: () => {} }); } finally { await m.pool.end(); }
  }

  beforeAll(async () => {
    await dropRole();
    t = await withAuditSchema("roles");
    o = escapeIdentifier(t.outboxSchema);
    // One of the API's own tables, in the schema the outbox shares with them.
    await t.pool.query(`create table ${o}.users (id text primary key, name text not null)`);
    await t.pool.query(`insert into ${o}.users values ('u1', 'Kavitha Raman')`);
    password = passwordOf();
    expect(await migrateWith(password)).toEqual({ applied: journalLength(), expected: journalLength(), role: ROLE });
    asRole = new Pool({ connectionString: urlAs(ROLE, password), max: 1, options: `-c search_path=${t.auditSchema}` });
  });
  afterAll(async () => {
    await asRole?.end();
    await dropRole();
    await t?.close();
  });

  it("logs in with the password from its runtime URL", async () => {
    expect((await asRole.query("select current_user as u")).rows[0].u).toBe(ROLE);
  });

  it("inserts and reads audit events and dead letters", async () => {
    await asRole.query(`insert into events (outbox_id, at, request_id, actor_emp, actor_name, actor_role, actor_loc, action, method, path, outcome, status)
      values (1, now(), 'req-1', 'RC-3120', 'Ramesh Kumar', 'Outlet Manager', 'rest', 'voidBill', 'POST', '/bills/:no/void', 'done', 200)`);
    await asRole.query(`insert into dead_letters (outbox_id, at, event, issue) values (2, now(), '{}', 'actor: Required')`);
    expect((await asRole.query("select count(*)::int as n from events")).rows[0].n).toBe(1);
    expect((await asRole.query("select count(*)::int as n from dead_letters")).rows[0].n).toBe(1);
  });

  it("locks outbox rows with for update skip locked and deletes them, as the drain does", async () => {
    await t.pool.query(`insert into ${o}.audit_outbox (event) values ('{"n":1}'), ('{"n":2}')`);
    const c = await asRole.connect();
    try {
      await c.query("begin");
      const locked = await c.query(`select id from ${o}.audit_outbox order by id limit 500 for update skip locked`);
      expect(locked.rowCount).toBe(2);
      const r = await c.query(`delete from ${o}.audit_outbox where id in (select id from ${o}.audit_outbox order by id limit 500 for update skip locked) returning id, at, event`);
      await c.query("commit");
      expect(r.rowCount).toBe(2);
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  });

  it("cannot edit or empty the audit tables", async () => {
    expect(await sqlstate(asRole.query("update events set message = 'rewritten'"))).toBe("42501");
    expect(await sqlstate(asRole.query("delete from events"))).toBe("42501");
    expect(await sqlstate(asRole.query("truncate events"))).toBe("42501");
    expect(await sqlstate(asRole.query("update dead_letters set issue = 'fine'"))).toBe("42501");
    expect(await sqlstate(asRole.query("delete from dead_letters"))).toBe("42501");
  });

  it("cannot write the outbox or touch any other table in the API's schema", async () => {
    await t.pool.query(`insert into ${o}.audit_outbox (event) values ('{"n":3}')`);
    // The column grant that lets the drain lock a row cannot change one: the API's trigger refuses it.
    expect(await refusal(asRole.query(`update ${o}.audit_outbox set at = now()`))).toBe("audit_outbox rows are never updated; the audit service moves each one as it was written");
    expect(await sqlstate(asRole.query(`select * from ${o}.users`))).toBe("42501");
    expect(await sqlstate(asRole.query(`insert into ${o}.audit_outbox (event) values ('{}')`))).toBe("42501");
    expect(await sqlstate(asRole.query(`update ${o}.audit_outbox set event = '{}'`))).toBe("42501");
    expect(await sqlstate(asRole.query(`truncate ${o}.audit_outbox`))).toBe("42501");
  });

  it("reads the migrations bookkeeping for /readyz, and PUBLIC holds nothing on the audit schemas", async () => {
    const r = createDb(urlAs(ROLE, password), false, { max: 1, searchPath: t.auditSchema });
    try { expect(await appliedMigrationCount(r.db, t.auditSchema)).toBe(journalLength()); } finally { await r.pool.end(); }
    const acl = await t.pool.query("select nspname, coalesce(nspacl::text, '') as acl from pg_namespace where nspname = any($1)", [[t.auditSchema, `${t.auditSchema}_drizzle`]]);
    expect(acl.rows).toHaveLength(2);
    for (const row of acl.rows as Array<{ acl: string }>) expect(row.acl).not.toMatch(/[{,]=/);
  });

  it("re-runs cleanly and takes a new password from the runtime URL", async () => {
    const next = passwordOf();
    expect((await migrateWith(next)).role).toBe(ROLE);
    const fresh = new Pool({ connectionString: urlAs(ROLE, next), max: 1 });
    const stale = new Pool({ connectionString: urlAs(ROLE, password), max: 1 });
    try {
      expect((await fresh.query("select 1 as ok")).rows[0].ok).toBe(1);
      expect(await sqlstate(stale.query("select 1"))).toBe("28P01");
    } finally {
      await fresh.end();
      await stale.end();
    }
    await asRole.end();
    password = next;
    asRole = new Pool({ connectionString: urlAs(ROLE, password), max: 1, options: `-c search_path=${t.auditSchema}` });
  });

  it("waits for the API's migrate lock before it sets up the role and its grants", async () => {
    const api = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const held = await api.connect();
    try {
      await held.query(`select pg_advisory_lock(${API_MIGRATE_LOCK})`);
      let finished = false;
      const run = migrateWith(password).then((r) => { finished = true; return r; });
      await vi.waitFor(async () => {
        const waiting = await t.pool.query(
          `select count(*)::int as n from pg_locks l join pg_stat_activity a using (pid)
           where l.locktype = 'advisory' and l.objid = $1 and not l.granted and a.application_name = 'rch-audit'`,
          [API_MIGRATE_LOCK],
        );
        expect(waiting.rows[0].n).toBe(1);
      }, { timeout: 10_000, interval: 100 });
      expect(finished).toBe(false);
      await held.query(`select pg_advisory_unlock(${API_MIGRATE_LOCK})`);
      expect((await run).role).toBe(ROLE);
    } finally {
      held.release();
      await api.end();
    }
  });

  it("never puts the password in an error", async () => {
    const secret = passwordOf();
    const m = createDb(TEST_DATABASE_URL, false, { max: 1 });
    try {
      // A read-only session lets the lookup through and refuses the ALTER ROLE that carries the password.
      await m.pool.query("set default_transaction_read_only = on");
      const err = await ensureLoginRole(m.db, { name: ROLE, password: secret }).then(() => null, (e: unknown) => e as Error);
      expect(err?.message).toBe(`Could not set up the login role ${ROLE}: cannot execute ALTER ROLE in a read-only transaction (25006).`);
      expect(`${err?.message} ${String(err?.cause)} ${err?.stack}`).not.toContain(secret.slice(-18));
    } finally {
      await m.pool.end();
    }
  });
});
````

- [ ] **Step 14: Run them to verify they fail**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/lib/migrate-run.test.ts src/lib/roles.test.ts`
Expected: FAIL - vitest cannot load `./migrate-run.js` or `./roles.js`.

- [ ] **Step 15: Implement the roles, the migrate step and the CLI**

`apps/audit/src/lib/roles.ts`:

````ts
import { sql } from "drizzle-orm";
import { escapeIdentifier, escapeLiteral } from "pg";
import type { Db } from "../db/client.js";
import { migrationsSchemaOf } from "../db/migrate.js";

export type LoginRole = { name: string; password: string };

/**
 * The role the service runs as, read from its own runtime URL (AUDIT_DATABASE_URL), or `null` when
 * that URL names the same user as the migrate URL - local development and the test suites, where
 * there is no second role to set up and the migrations alone run (spec §4).
 */
export function roleFromUrls(runtimeUrl: string, migrateUrl: string): LoginRole | null {
  const runtime = new URL(runtimeUrl);
  const name = decodeURIComponent(runtime.username);
  if (!name) throw new Error("AUDIT_DATABASE_URL names no database user.");
  if (name === decodeURIComponent(new URL(migrateUrl).username)) return null;
  if (!runtime.password) throw new Error(`AUDIT_DATABASE_URL gives no password for ${name}, so the migrate step cannot set one.`);
  return { name, password: decodeURIComponent(runtime.password) };
}

/**
 * `create role … login` when the role is missing, then `alter role … password` - on every run, so
 * a rotated password in the runtime URL takes effect at the next deploy. The password travels as an
 * escaped literal (DDL takes no bind parameters) and never reaches a log: a failure is rethrown
 * with the driver's own reason, which names no statement, instead of drizzle's "Failed query: …".
 */
export async function ensureLoginRole(db: Db, role: LoginRole): Promise<void> {
  const ident = escapeIdentifier(role.name);
  try {
    const found = await db.execute(sql`select 1 from pg_roles where rolname = ${role.name}`);
    if (found.rows.length === 0) await db.execute(sql.raw(`create role ${ident} login`));
    await db.execute(sql.raw(`alter role ${ident} with login password ${escapeLiteral(role.password)}`));
  } catch (e) {
    const driver = (e as { cause?: { message?: unknown; code?: unknown } }).cause;
    const why = typeof driver?.message === "string" ? driver.message : "the database refused";
    const code = typeof driver?.code === "string" ? ` (${driver.code})` : "";
    throw new Error(`Could not set up the login role ${role.name}: ${why}${code}.`);
  }
}

/**
 * The `rch_audit` row of spec §4, re-granted on every run so a table a later migration adds is
 * covered. `usage` on the three schemas; `select, insert` on the audit tables and nothing more
 * (their triggers refuse edits even to the owner); `select` on the migrations bookkeeping for
 * /readyz; `select, delete` on the outbox, plus `update` on its `at` column alone, because the
 * drain's `for update skip locked` needs UPDATE privilege on at least one column and Postgres
 * offers no narrower grant - the API's trigger on `audit_outbox` refuses every UPDATE, so the grant
 * can lock a row and never change one. Nothing on any other table in the outbox schema.
 */
export async function grantAuditRole(db: Db, role: string, opts: { auditSchema: string; outboxSchema: string }): Promise<void> {
  const r = escapeIdentifier(role);
  const a = escapeIdentifier(opts.auditSchema);
  const d = escapeIdentifier(migrationsSchemaOf(opts.auditSchema));
  const o = escapeIdentifier(opts.outboxSchema);
  for (const statement of [
    `revoke all on schema ${a}, ${d} from public`,
    `grant usage on schema ${a}, ${d}, ${o} to ${r}`,
    `grant select, insert on ${a}."events", ${a}."dead_letters" to ${r}`,
    `grant select on ${d}."__drizzle_migrations" to ${r}`,
    `grant select, delete on ${o}."audit_outbox" to ${r}`,
    `grant update ("at") on ${o}."audit_outbox" to ${r}`,
  ]) {
    await db.execute(sql.raw(statement));
  }
}
````

`apps/audit/src/lib/migrate-run.ts`:

````ts
import { sql } from "drizzle-orm";
import { escapeIdentifier } from "pg";
import type { AuditConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { appliedMigrationCount, journalLength, runMigrations } from "../db/migrate.js";
import { ensureLoginRole, grantAuditRole, roleFromUrls } from "./roles.js";

/** The API's migrate CLI holds 727272; the audit step takes the next number, so the two never
 *  wait on each other and two audit replicas never migrate at once. */
export const AUDIT_MIGRATE_LOCK = 727273;

/** The API's migrate lock. Its migrate step grants on `audit_outbox` too, and two GRANTs on one
 *  relation at the same moment can fail with "tuple concurrently updated" (XX000), so the role and
 *  grant step below runs under this lock as well. The API never takes 727273, so waiting for 727272
 *  while holding 727273 cannot deadlock. */
export const API_MIGRATE_LOCK = 727272;

/** Spec §4: the two migrate steps may start in either order on Kubernetes, so this one waits up to
 *  five minutes, looking every two seconds, for the API's migration to create the outbox. */
export const OUTBOX_WAIT = { timeoutMs: 5 * 60_000, intervalMs: 2_000 } as const;

export type WaitOptions = {
  timeoutMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (elapsedMs: number) => void;
};

/** The outbox never appeared: the API's migrations have not run against this database. */
export class OutboxMissingError extends Error {}

/** Asks `exists` at once and then every `intervalMs` until it says yes (true) or `timeoutMs` has
 *  passed (false). The clock and the sleep are injectable so a test does not wait five minutes. */
export async function waitForOutbox(exists: () => Promise<boolean>, opts: WaitOptions): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const start = now();
  for (;;) {
    if (await exists()) return true;
    const elapsed = now() - start;
    if (elapsed >= opts.timeoutMs) return false;
    opts.onWait?.(elapsed);
    await sleep(Math.min(opts.intervalMs, opts.timeoutMs - elapsed));
  }
}

export async function outboxExists(db: Db, outboxSchema: string): Promise<boolean> {
  const r = await db.execute(sql`select to_regclass(${`${escapeIdentifier(outboxSchema)}.audit_outbox`}) is not null as ok`);
  return (r.rows[0] as { ok: boolean }).ok;
}

/**
 * The whole migrate step: take the advisory lock, wait for the outbox, apply the audit migrations,
 * then - when the runtime URL names its own user - create that login role and grant it, holding the
 * API's lock too for that part.
 *
 * `db` must be a single-connection pool (`max: 1`) on `search_path = config.auditSchema`: an
 * advisory lock belongs to the session that took it, so the lock, the migrations and the unlock
 * have to share one. `lock_timeout = 0` makes the wait for another replica explicit.
 */
export async function migrateAudit(
  db: Db,
  config: AuditConfig,
  opts: { wait?: Partial<WaitOptions>; log?: (line: string) => void } = {},
): Promise<{ applied: number; expected: number; role: string | null }> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const wait: WaitOptions = { ...OUTBOX_WAIT, ...opts.wait };
  const role = roleFromUrls(config.databaseUrl, config.migrateDatabaseUrl);
  await db.execute(sql`set lock_timeout = 0`);
  await db.execute(sql.raw(`select pg_advisory_lock(${AUDIT_MIGRATE_LOCK})`));
  try {
    const found = await waitForOutbox(() => outboxExists(db, config.outboxSchema), {
      ...wait,
      onWait: (ms) => log(`Waiting for ${config.outboxSchema}.audit_outbox, which the API's migrations create (${Math.round(ms / 1000)} s so far).`),
    });
    if (!found) {
      throw new OutboxMissingError(`There is still no ${config.outboxSchema}.audit_outbox after ${Math.round(wait.timeoutMs / 1000)} s. Run the API's migrations against this database first.`);
    }
    await runMigrations(db, config.auditSchema);
    if (role) {
      await db.execute(sql.raw(`select pg_advisory_lock(${API_MIGRATE_LOCK})`));
      try {
        await ensureLoginRole(db, role);
        await grantAuditRole(db, role.name, { auditSchema: config.auditSchema, outboxSchema: config.outboxSchema });
      } finally {
        await db.execute(sql.raw(`select pg_advisory_unlock(${API_MIGRATE_LOCK})`));
      }
    }
    return { applied: await appliedMigrationCount(db, config.auditSchema), expected: journalLength(), role: role?.name ?? null };
  } finally {
    await db.execute(sql.raw(`select pg_advisory_unlock(${AUDIT_MIGRATE_LOCK})`));
  }
}
````

`apps/audit/src/cli/migrate.ts`:

````ts
import { ConfigError, loadConfig, type AuditConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { migrateAudit, OutboxMissingError } from "../lib/migrate-run.js";

// Exit codes: 0 migrated (and the role granted, when there is one); 1 anything unexpected;
// 2 the environment is invalid; 3 the API's outbox never appeared.
function readConfig(): AuditConfig {
  try { return loadConfig(process.env); }
  catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(2); } throw e; }
}

const config = readConfig();
// As `rch` (MIGRATE_DATABASE_URL). One connection, because the advisory lock is the session's;
// no statement timeout, because waiting for that lock is this step's job.
const { db, pool } = createDb(config.migrateDatabaseUrl, config.databaseSsl, { max: 1, searchPath: config.auditSchema, statementTimeoutMs: 0 });
let code = 0;
try {
  const r = await migrateAudit(db, config);
  console.log(`audit migrations applied: ${r.applied} / ${r.expected}; ${r.role ? `role ${r.role} granted` : "role setup skipped (the runtime user is the migrate user)"}`);
} catch (e) {
  if (e instanceof OutboxMissingError) { console.error(e.message); code = 3; } else { console.error(e); code = 1; }
} finally {
  await pool.end();
}
process.exit(code);
````

- [ ] **Step 16: Run them to verify they pass, and that the lock assertion can fail**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/lib/migrate-run.test.ts src/lib/roles.test.ts`
Expected: PASS - 7 + 12 tests.

Prove two of these cases can fail, one at a time, restoring the line after each:

- Delete the line `` await db.execute(sql.raw(`select pg_advisory_unlock(${AUDIT_MIGRATE_LOCK})`)); `` from `src/lib/migrate-run.ts` and run `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/lib/migrate-run.test.ts`. Expected: `× refuses when the outbox never appears, and lets go of the advisory lock` (another session cannot take the lock).
- Delete the line `` `grant update ("at") on ${o}."audit_outbox" to ${r}`, `` from `src/lib/roles.ts` and run `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/lib/roles.test.ts`. Expected: `× locks outbox rows with for update skip locked and deletes them, as the drain does` with `permission denied for table audit_outbox` - the spec's `select, delete` alone cannot run the drain.

Restore both lines and re-run the two files: PASS.

- [ ] **Step 17: Smoke-run the built migrate CLI**

```bash
pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit build
docker exec rch-postgres psql -U rch -d rch_test -c "create schema t_audit_cli_smoke; create table t_audit_cli_smoke.audit_outbox (id bigint generated always as identity primary key, at timestamptz not null default now(), event jsonb not null);"
env -i PATH="$PATH" AUDIT_DATABASE_URL=postgres://rch:rch@localhost:5439/rch_test JWT_PUBLIC_KEY="$(node -e 'const {generateKeyPairSync}=require("node:crypto");const {publicKey}=generateKeyPairSync("ed25519");process.stdout.write(Buffer.from(publicKey.export({type:"spki",format:"pem"})).toString("base64"))')" AUDIT_SCHEMA=t_audit_cli_smoke_a OUTBOX_SCHEMA=t_audit_cli_smoke EVENTS_SCHEMA=t_audit_cli_smoke node /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/dist/cli/migrate.mjs; echo "exit=$?"
env -i PATH="$PATH" AUDIT_DATABASE_URL=postgres://rch:rch@localhost:5439/rch_test node /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/dist/cli/migrate.mjs; echo "exit=$?"
docker exec rch-postgres psql -U rch -d rch_test -c "drop schema t_audit_cli_smoke cascade; drop schema t_audit_cli_smoke_a cascade; drop schema t_audit_cli_smoke_a_drizzle cascade;"
rm -rf /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/dist
```
Expected: the first run prints `audit migrations applied: 1 / 1; role setup skipped (the runtime user is the migrate user)` and `exit=0` (the chunk in `dist/` finds `drizzle/` by walking up); the second prints `Invalid environment:` naming `JWT_PUBLIC_KEY` and `exit=2`.

- [ ] **Step 18: Run the package gates**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit test`
Expected: PASS - 9 files, 64 tests; coverage clears `lines 90 / branches 75` (a dry run measured lines 99.0 / branches 90.5). No `t_audit_*` schema or role is left behind: `docker exec rch-postgres psql -U rch -d rch_test -Atc "select count(*) from pg_namespace where nspname like 't_audit_%'"` prints `0` once no other audit run is in flight.

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit typecheck`
Expected: exits 0.

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit lint`
Expected: exits 0 with no warnings.

- [ ] **Step 19: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add apps/audit/package.json apps/audit/tsup.config.ts apps/audit/drizzle.config.ts apps/audit/scripts apps/audit/drizzle apps/audit/src pnpm-lock.yaml
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Give the audit service its append-only storage, migrate step and database role

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

<!-- Part 05 of the audit log service plan: Tasks 11 and 12 (drainer, readiness, auth, read routes). -->

#### Interface additions

**Added by Tasks 11 and 12.** These are new names; nothing shared is renamed.

- `apps/audit/src/lib/drain.ts`:
  - `export type DrainResult = { moved: number; dead: number; issues: Array<{ outboxId: number; issue: string }> }`. `drainOnce(db, t)` returns it (D22). The plugin logs each issue after the transaction commits.
  - `export async function outboxStats(db: Db, outboxSchema: string): Promise<{ depth: number; lagSeconds: number }>`, which feeds the depth and lag gauges.
  - `export const EVENTS_CHANNEL_PREFIX = "rch_events_"`, restated rather than imported from the API.
  - The `rch_events_<eventsSchema>` notice is sent only when `moved > 0`.
  - Each `delete` and `insert` is one line holding both the verb and the table name (D12).
- `apps/audit/src/plugins/drainer.ts`:
  - `export const AUDIT_OUTBOX_CHANNEL = "rch_audit_outbox"`
  - `export const READY_STALE_MS = 30_000`
  - `export type Drainer`: the shared decorator, with `lastPassAt` / `lastPassOk` as getters, **plus `drainNow(): Promise<void>`** (D22). `drainNow()` runs a pass, or waits out the one in flight and then runs one, and resolves once passes stop. It works with the drainer disabled.
  - Plugin options `{ enabled: boolean }`. fp name `"drainer"`, dependencies `["db", "metrics", "health"]`.
  - LISTEN client `application_name`: `rch-audit-drainer <auditSchema>`.
  - **A notification kicks a pass only when its payload is empty or equals `config.outboxSchema` (D14).**
  - **`app.ready()` waits for the first pass, bounded at 5 s.** Without that, `plugins/db.test.ts`'s first `/readyz` 200 would race it.
  - The readiness check is `app.readiness.addCheck("drainer", …)`. It throws `no drain pass has succeeded yet` or `the last successful drain pass was <n> s ago`.
- `apps/audit/src/lib/db.ts` (Task 12): `export type Tx`, `export type Reader = Db | Tx`, `export const withReadTransaction`. Task 10 defines no `Tx`; this is its home.
- `apps/audit/src/lib/time.ts` (Task 12): `istDay(at: Date): string`, `istDayStart(day: string): Date | null`, `nextIstDay(dayStart: Date): Date`.
- `apps/audit/src/plugins/auth.ts` (Task 12):
  - `export type AccessClaims = { sub; role; loc; mcp?; admin? }`
  - Decorators `app.authenticate` and `app.requireAdmin`, both `(req, reply) => Promise<void>`
  - Request decorator `req.user: AccessClaims | null`, which `plugins/logging.ts`'s `user?.sub` already reads
  - fp name `"auth"`, dependencies `["errors"]`
  - `mount()` attaches both gates as `onRequest` hooks.
- `apps/audit/src/routes.ts`: `mountedRoutes` holds `"<METHOD> <manifest path>"` keys, e.g. `"GET /admin/audit/:id"` (D19). It also exports `Req<R>` and `Handler<R>`.
- `AuditFilter.fromAt` is inclusive; `AuditFilter.toAt` is **exclusive** (the IST midnight after the `to` day).
- `warmPool` stays a local helper in `src/lib/drain.test.ts` (part 04 note 14).

**Consumed from Tasks 9 and 10, exactly as part 04 defines them:**

- `buildApp(config, deps: AppDeps)`, where `deps.drainer` defaults to on. `AppDeps.cleanup` runs after every plugin's `onClose`, so the drainer still has the pool when it shuts down.
- `app.config: AuditConfig`, `app.db`, `app.pool`, `app.metrics.registry`, `app.readiness.addCheck(name, check)` (D18). Plugin names are `errors`, `metrics`, `health` and `db`.
- `src/lib/errors.ts`: `ValidationError(message, details?)`, `UnauthenticatedError(message?, cause?)`, `ForbiddenError(message)`, `NotFoundError(message)`.
- `src/db/client.ts`: `Db`, `pgSsl(ssl)`, `withoutSslParams(url)`. The pool's `search_path` is `auditSchema`.
- Harness, `src/test/app.ts`: `buildTestApp({ schema, drainer?, env? })`, `signToken(app, claims, { previousKey? })`, `sampleEvent(over)`, and the re-exported `putOutbox` / `AuditTestDb`. In the harness, `EVENTS_SCHEMA` equals the outbox schema, and `putOutbox` sends no `pg_notify`.
- Harness, `src/test/db.ts`: `resetAudit(t)`, `TEST_DATABASE_URL`.
- `fast-jwt` is already a dependency (Task 10), so Task 12 adds no package.

#### Notes

1. **Poison rows.** An event can pass `AuditEventSchema` and still be refused by Postgres: `status` is `z.number().int()` but the column is `smallint`. A pass that threw on such a row would roll back and meet the same row forever, and the log would stop.
   - `drainOnce` inserts the batch under a savepoint.
   - On an SQLSTATE class 22 or 23 refusal it retries row by row and sets each refused row aside as `database refused it: <reason>`. The same path is the `events_outbox_id_uq` backstop.
   - Any other error rolls the whole pass back.
   - Spec §3.3 does not mention this.
2. **Which test proves `skip locked`.** Checked on PG 17.11 by running two parallel drains of 100 over 200 rows:
   - With `for update skip locked`, they split 100 / 100.
   - With plain `for update`, they still split 100 / 100 (the second waits, then skips deleted rows).
   - With no locking clause, they split 0 / 100.

   So the parallel test proves a locking clause exists, and only the held-lock test proves `skip locked`. Task 11 Step 5 runs both removals by hand.
3. **Drizzle's `db.execute` returns `timestamptz` as Postgres text** (`"2025-09-13 18:45:00+00"`), not a `Date`. `repo.ts` therefore formats `at` in SQL with `to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`. A raw `pg` client still returns `Date`.
4. **Read-route choices the spec leaves open**, now pinned by tests:
   - `to` defaults to today in IST, and `from` defaults to `to`.
   - A `from` after `to` is a 400. So is a date the calendar does not have (`Date` would roll 2025-02-30 into March).
   - `group` and `action` together intersect.
   - A `q` of only spaces is ignored.
5. **Gates run on `onRequest`, before schema validation.** A non-admin therefore gets a 404 even for a malformed query, where the API's `preHandler` order would give a 400.
6. **There is no wrong-issuer test.** `signToken` always signs `iss: "rch-api"` with a private key only the harness holds. An `issuer` option on `signToken` would make `allowedIss` testable.
7. **`DRAIN_POLL_MS` versus readiness** (settled): Task 9's config caps `DRAIN_POLL_MS` at 25 000, under `READY_STALE_MS` (30 s), so a pod that hears no notifications still passes often enough to stay ready. The live test uses 25 000.
8. **`app.ready()` now includes one drain pass**, of up to 5 s. The probes' startup budgets in Tasks 16-17 should allow for it.

---

### Task 11: Audit service - drainer and readiness

**Files:**
- Create: `apps/audit/src/lib/drain.ts`
- Create: `apps/audit/src/plugins/drainer.ts`
- Modify: `apps/audit/src/app.ts` (register the drainer after the db plugin)
- Test: `apps/audit/src/lib/drain.test.ts`
- Test: `apps/audit/src/plugins/drainer.test.ts`

**Interfaces:**
- Consumes:
  - From Task 1: `AuditEventSchema`, `AuditEvent`.
  - From Tasks 9 and 10: `Db`, `pgSsl`, `withoutSslParams` (`src/db/client.ts`); `buildApp(config, deps)` and `AppDeps`; `app.config`, `app.db`, `app.pool`, `app.metrics.registry`, `app.readiness.addCheck`.
  - From the harness: `buildTestApp`, `putOutbox`, `sampleEvent`, `resetAudit`.
- Produces:
  - `drainOnce(db, t): Promise<DrainResult>`, `DrainTarget`, `DrainResult`, `outboxStats`, `EVENTS_CHANNEL_PREFIX`.
  - `app.drainer: { lastPassAt, lastPassOk, kick(), drainNow(), passes(), listening() }`, plus `AUDIT_OUTBOX_CHANNEL` and `READY_STALE_MS`.
  - Metrics `audit_outbox_depth`, `audit_drain_lag_seconds`, `audit_events_stored_total`, `audit_dead_letters_total`, `audit_listener_up`.
  - Readiness check `"drainer"`.

- [ ] **Step 1: Write the failing drain test**

Create `apps/audit/src/lib/drain.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client, type Pool } from "pg";
import { buildTestApp, putOutbox, sampleEvent } from "../test/app.js";
import { resetAudit } from "../test/db.js";
import { drainOnce, EVENTS_CHANNEL_PREFIX, outboxStats, type DrainTarget } from "./drain.js";

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
let app: TestApp;

beforeAll(async () => {
  app = await buildTestApp({ schema: "drain", drainer: false });
  await app.ready();
});
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetAudit(app.testDb); });

const target = (batch = 500): DrainTarget => ({
  auditSchema: app.testDb.auditSchema, outboxSchema: app.testDb.outboxSchema, eventsSchema: app.config.eventsSchema, batch,
});
const drain = (batch?: number) => drainOnce(app.db, target(batch));
const tag = () => randomUUID();
const events = (t: string, n: number) =>
  Array.from({ length: n }, (_, i) => sampleEvent({ requestId: `${t}-${String(i).padStart(3, "0")}` }));
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function outboxIds(): Promise<string[]> {
  const r = await app.db.execute(sql`select id::text as id from ${sql.identifier(app.testDb.outboxSchema)}.audit_outbox order by id`);
  return (r.rows as Array<{ id: string }>).map((x) => x.id);
}
async function stored(t: string): Promise<Array<{ outbox_id: string; request_id: string }>> {
  const r = await app.db.execute(sql`
    select outbox_id::text as outbox_id, request_id from ${sql.identifier(app.testDb.auditSchema)}.events
    where request_id like ${`${t}-%`} order by id`);
  return r.rows as Array<{ outbox_id: string; request_id: string }>;
}
/** `pg` connects lazily, so two drains started in one tick against a pool that has only ever
 *  needed one client run back to back, and a race test passes whether or not anything is locked.
 *  As `apps/api/src/test/db.ts`'s `warmPool`; n stays within the harness pool's 4. */
async function warmPool(pool: Pool, n: number): Promise<void> {
  const held = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  for (const c of held) c.release();
}

describe("drainOnce", () => {
  it("moves every outbox row into the log once, in outbox order, and leaves the outbox empty", async () => {
    const t = tag();
    const sent = events(t, 10);
    await putOutbox(app.testDb, sent);
    const ids = await outboxIds();

    expect(await drain()).toEqual({ moved: 10, dead: 0, issues: [] });

    const rows = await stored(t);
    expect(rows.map((r) => r.request_id)).toEqual(sent.map((e) => e.requestId));
    expect(rows.map((r) => r.outbox_id)).toEqual(ids);
    expect(await outboxIds()).toEqual([]);
    // Nothing left to take, and nothing taken twice.
    expect(await drain()).toEqual({ moved: 0, dead: 0, issues: [] });
    expect(await stored(t)).toHaveLength(10);
  });

  it("stores each field of the event in its own column", async () => {
    const t = tag();
    const edit = sampleEvent({
      at: "2025-09-13T18:45:00.123Z", requestId: `${t}-000`,
      actor: { id: "u2", emp: "RC-3120", name: "Ramesh Kumar", role: "Outlet Manager", loc: "rest" },
      action: "savePrice", method: "PUT", path: "/prices/:list/:it", target: "staff:muffin", targetLoc: "",
      outcome: "done", status: 200, message: "Price of Muffin saved at ₹45", cause: null,
      request: { params: { list: "staff", it: "muffin" }, query: {}, body: { price: 45 } },
      before: { price: 40 }, result: { list: "staff", it: "muffin", price: 45 }, changed: ["prices"],
      ip: "10.0.0.7", userAgent: "Mozilla/5.0",
    });
    const stranger = sampleEvent({
      requestId: `${t}-001`, actor: { id: null, emp: "RC-9999", name: "", role: "", loc: "" },
      action: "login", outcome: "refused", status: 401, cause: "unknown employee",
      request: null, before: null, result: null, changed: [],
    });
    await putOutbox(app.testDb, [edit, stranger]);
    const ids = await outboxIds();

    expect(await drain()).toEqual({ moved: 2, dead: 0, issues: [] });

    const r = await app.db.execute(sql`
      select outbox_id::text as outbox_id, at = ${edit.at}::timestamptz as same_at, request_id,
             actor_id, actor_emp, actor_name, actor_role, actor_loc, action, method, path, target, target_loc,
             outcome, status, message, cause, request, before, result, changed, ip, user_agent
      from ${sql.identifier(app.testDb.auditSchema)}.events where request_id like ${`${t}-%`} order by id`);
    expect(r.rows[0]).toEqual({
      outbox_id: ids[0], same_at: true, request_id: edit.requestId,
      actor_id: "u2", actor_emp: "RC-3120", actor_name: "Ramesh Kumar", actor_role: "Outlet Manager", actor_loc: "rest",
      action: "savePrice", method: "PUT", path: "/prices/:list/:it", target: "staff:muffin", target_loc: "",
      outcome: "done", status: 200, message: "Price of Muffin saved at ₹45", cause: null,
      request: edit.request, before: { price: 40 }, result: edit.result, changed: ["prices"], ip: "10.0.0.7", user_agent: "Mozilla/5.0",
    });
    // A refused sign-in by an unknown id: no actor id, no before/result, and a null request stored as {}.
    expect(r.rows[1]).toMatchObject({
      outbox_id: ids[1], actor_id: null, actor_emp: "RC-9999", outcome: "refused", status: 401, cause: "unknown employee",
      request: {}, before: null, result: null, changed: [],
    });
  });

  it("takes at most one batch per pass, oldest first", async () => {
    const t = tag();
    const sent = events(t, 7);
    await putOutbox(app.testDb, sent);
    const moved: number[] = [];
    for (let i = 0; i < 4; i++) moved.push((await drain(3)).moved);
    expect(moved).toEqual([3, 3, 1, 0]);
    expect((await stored(t)).map((r) => r.request_id)).toEqual(sent.map((e) => e.requestId));
  });

  it("sets an invalid event aside in dead_letters with its first issue, and still moves its neighbours", async () => {
    const t = tag();
    const [a, b, c] = events(t, 3);
    const wrong = { ...sampleEvent({ requestId: `${t}-bad` }), outcome: "maybe" };
    await putOutbox(app.testDb, [a, wrong, "not an event", b, c]);
    const ids = await outboxIds();

    const r = await drain();

    expect(r.moved).toBe(3);
    expect(r.dead).toBe(2);
    expect(r.issues).toEqual([
      { outboxId: Number(ids[1]), issue: expect.stringMatching(/^outcome: /) },
      { outboxId: Number(ids[2]), issue: expect.stringMatching(/expected object/) },
    ]);
    expect((await stored(t)).map((x) => x.outbox_id)).toEqual([ids[0], ids[3], ids[4]]);
    const dead = await app.db.execute(sql`
      select outbox_id::text as outbox_id, event, issue from ${sql.identifier(app.testDb.auditSchema)}.dead_letters order by id`);
    expect(dead.rows).toEqual([
      { outbox_id: ids[1], event: wrong, issue: r.issues[0].issue },
      { outbox_id: ids[2], event: "not an event", issue: r.issues[1].issue },
    ]);
    expect(await outboxIds()).toEqual([]);
  });

  it("sets aside an event the database refuses, instead of stalling on it, and still moves the rest", async () => {
    const t = tag();
    const [a, b] = events(t, 2);
    // Valid by the schema (`z.number().int()`), out of range for the `smallint` column.
    const huge = sampleEvent({ requestId: `${t}-huge`, status: 70000 });
    await putOutbox(app.testDb, [a, huge, b]);
    const ids = await outboxIds();

    expect(await drain()).toEqual({
      moved: 2, dead: 1,
      issues: [{ outboxId: Number(ids[1]), issue: expect.stringMatching(/^database refused it: .*smallint/) }],
    });
    expect((await stored(t)).map((x) => x.outbox_id)).toEqual([ids[0], ids[2]]);
  });

  it("never stores one outbox row twice: a repeated outbox id is set aside by the unique backstop", async () => {
    const t = tag();
    await putOutbox(app.testDb, events(t, 1));
    const [id] = await outboxIds();
    await drain();
    // An outbox id handed out again, as after a restore that reset the identity.
    await app.pool.query(
      `insert into "${app.testDb.outboxSchema}".audit_outbox (id, event) overriding system value values ($1, $2::jsonb)`,
      [id, JSON.stringify(sampleEvent({ requestId: `${t}-again` }))],
    );

    expect(await drain()).toEqual({
      moved: 0, dead: 1,
      issues: [{ outboxId: Number(id), issue: expect.stringMatching(/^database refused it: duplicate key/) }],
    });
    expect((await stored(t)).map((x) => x.request_id)).toEqual([`${t}-000`]);
  });

  it("announces stored events on the API's change channel, and stays quiet when nothing was stored", async () => {
    const listener = new Client({ connectionString: app.config.databaseUrl });
    await listener.connect();
    const notices: string[] = [];
    listener.on("notification", (m) => { notices.push(m.payload ?? ""); });
    await listener.query(`listen "${EVENTS_CHANNEL_PREFIX}${app.config.eventsSchema}"`);
    try {
      await drain();                                        // nothing waiting
      await putOutbox(app.testDb, ["not an event"]);
      expect((await drain()).dead).toBe(1);                 // only a dead letter: nothing for a screen to show
      await settle(300);
      expect(notices).toEqual([]);

      await putOutbox(app.testDb, events(tag(), 2));
      expect((await drain()).moved).toBe(2);
      const stop = Date.now() + 2000;
      while (notices.length === 0 && Date.now() < stop) await settle(25);
      expect(notices).toHaveLength(1);
      const notice = JSON.parse(notices[0]) as { collections: string[]; at: string };
      expect(notice.collections).toEqual(["audit"]);
      expect(Number.isNaN(Date.parse(notice.at))).toBe(false);
    } finally {
      await listener.end();
    }
  });

  it("samples the outbox's depth and the age of its oldest row", async () => {
    await putOutbox(app.testDb, events(tag(), 3));
    const waiting = await outboxStats(app.db, app.testDb.outboxSchema);
    expect(waiting.depth).toBe(3);
    expect(waiting.lagSeconds).toBeGreaterThan(0);
    await drain();
    expect(await outboxStats(app.db, app.testDb.outboxSchema)).toEqual({ depth: 0, lagSeconds: 0 });
  });

  it("lets two drainers run side by side and stores each event exactly once", async () => {
    const t = tag();
    await putOutbox(app.testDb, events(t, 200));
    await warmPool(app.pool, 2);

    const [a, b] = await Promise.all([drain(100), drain(100)]);

    // Each pass locked its own hundred. Without a locking clause the second reads the same hundred
    // ids, waits for the first to delete them, deletes nothing, and a hundred stay behind.
    expect([a.moved, b.moved]).toEqual([100, 100]);
    expect(await outboxIds()).toEqual([]);
    const rows = await stored(t);
    expect(rows).toHaveLength(200);
    expect(new Set(rows.map((r) => r.outbox_id)).size).toBe(200);
  });

  it("does not wait on rows another drainer is holding", async () => {
    const t = tag();
    await putOutbox(app.testDb, events(t, 200));
    const holder = new Client({ connectionString: app.config.databaseUrl });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query(`select id from "${app.testDb.outboxSchema}".audit_outbox order by id limit 50 for update`);
      const timedOut = Symbol("timed out");
      const first = await Promise.race([drain(500), settle(2000).then(() => timedOut)]);
      if (first === timedOut) throw new Error("a drain waited 2 s on rows another drainer holds instead of skipping them");
      expect(first.moved).toBe(150);
    } finally {
      await holder.query("rollback");
      await holder.end();
    }
    expect((await drain(500)).moved).toBe(50);
    const rows = await stored(t);
    expect(rows).toHaveLength(200);
    expect(new Set(rows.map((r) => r.outbox_id)).size).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/lib/drain.test.ts`
Expected: FAIL. The file does not collect: vitest cannot load `./drain.js`.

- [ ] **Step 3: Implement `drainOnce`**

Create `apps/audit/src/lib/drain.ts`:

```ts
// The one move from the API's outbox into the log. One transaction on the pool: rows are deleted
// from the outbox and inserted into `events` (or `dead_letters`) together, so a row is in exactly
// one place at every instant anyone can see. The outbox and the log share a database; that is what
// makes the move exactly-once rather than at-least-once.
//
// Every delete and insert below is written with its verb and table name on one line:
// scripts/check-boundaries.sh greps for them, and this file is the one it allows.
import { sql, type SQL } from "drizzle-orm";
import { AuditEventSchema, type AuditEvent } from "@rch/contract";
import type { Db } from "../db/client.js";

export type DrainTarget = { auditSchema: string; outboxSchema: string; eventsSchema: string; batch: number };
export type DrainResult = { moved: number; dead: number; issues: Array<{ outboxId: number; issue: string }> };

/** The API's change-stream channel prefix (apps/api/src/lib/events.ts). Restated rather than
 *  imported: apps/audit never imports apps/api. The API listens on `<prefix><its schema>`. */
export const EVENTS_CHANNEL_PREFIX = "rch_events_";

/** What `delete … returning` hands back. `id` is a bigint, which pg gives as a string, and `at` a
 *  timestamptz, which drizzle's driver gives as Postgres's own text. Both go straight back to
 *  Postgres and are never parsed here. */
type Taken = { id: string; at: string; event: unknown };
type Parsed = { row: Taken; event: AuditEvent };
type Refused = { row: Taken; issue: string };

const byOutboxId = (a: string, b: string): number => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

const EVENT_COLUMNS = sql.raw(
  "outbox_id, at, request_id, actor_id, actor_emp, actor_name, actor_role, actor_loc, action, method, path, "
  + "target, target_loc, outcome, status, message, cause, request, before, result, changed, ip, user_agent",
);

/** SQL NULL for an absent value, never the JSON literal `null`: `before` and `result` mean "not
 *  applicable". `request` is `not null` in the table, so a null one is stored as `{}`. */
const jsonb = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

function eventRow(p: Parsed): SQL {
  const e = p.event;
  return sql`(${p.row.id}::bigint, ${e.at}::timestamptz, ${e.requestId},
    ${e.actor.id}, ${e.actor.emp}, ${e.actor.name}, ${e.actor.role}, ${e.actor.loc},
    ${e.action}, ${e.method}, ${e.path}, ${e.target}, ${e.targetLoc},
    ${e.outcome}, ${e.status}::smallint, ${e.message}, ${e.cause},
    ${jsonb(e.request) ?? "{}"}::jsonb, ${jsonb(e.before)}::jsonb, ${jsonb(e.result)}::jsonb,
    ${sql.param(e.changed)}::text[], ${e.ip}, ${e.userAgent})`;
}

const deadLetterRow = (r: Refused): SQL =>
  sql`(${r.row.id}::bigint, ${r.row.at}::timestamptz, ${JSON.stringify(r.row.event)}::jsonb, ${r.issue})`;

/** The operator's line for a refused event: the first issue's path and message, or the message
 *  alone when the whole value is wrong (a string where an object belongs). */
function firstIssue(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  const [first] = issues;
  const path = first.path.map(String).join(".");
  return path ? `${path}: ${first.message}` : first.message;
}

/**
 * Postgres's reason when it refused the *row* - SQLSTATE class 22 (data exception: a status out of
 * `smallint`'s range) or 23 (integrity: `events_outbox_id_uq`, the exactly-once backstop) - and null
 * for any other failure. A row-shaped refusal can never succeed on a retry, so the row is set
 * aside; anything else (a dropped connection, a timeout) is the pass's problem, and rolling the
 * pass back whole loses nothing. Drizzle wraps pg's error and carries it as `.cause`.
 */
function rowRefusal(err: unknown): string | null {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" && /^2[23]/.test(cause.code) ? String(cause.message) : null;
}

export async function drainOnce(db: Db, t: DrainTarget): Promise<DrainResult> {
  // Schema names are quoted through `sql.identifier`; a configured name never becomes syntax.
  const outbox = sql.identifier(t.outboxSchema);
  const audit = sql.identifier(t.auditSchema);
  const insertEvents = (list: Parsed[]): SQL =>
    sql`insert into ${audit}.events (${EVENT_COLUMNS}) values ${sql.join(list.map(eventRow), sql`, `)}`;

  return db.transaction(async (tx) => {
    // `skip locked`: a second replica's pass takes the next rows instead of queueing behind this one.
    // `for update` needs UPDATE on one column, which the audit role's `update (at)` grant is for (D7).
    const taken = (await tx.execute(sql`delete from ${outbox}.audit_outbox where id in (select id from ${outbox}.audit_outbox order by id limit ${t.batch} for update skip locked) returning id, at, event`)).rows as Taken[];
    taken.sort((a, b) => byOutboxId(a.id, b.id));

    let valid: Parsed[] = [];
    const refused: Refused[] = [];
    for (const row of taken) {
      const parsed = AuditEventSchema.safeParse(row.event);
      if (parsed.success) valid.push({ row, event: parsed.data });
      else refused.push({ row, issue: firstIssue(parsed.error.issues) });
    }

    if (valid.length > 0) {
      try {
        await tx.transaction(async (sp) => { await sp.execute(insertEvents(valid)); });
      } catch (err) {
        if (rowRefusal(err) === null) throw err;
        // One row Postgres will never take must not hold the rest of the log up forever: find it
        // row by row, each under its own savepoint, and set it aside.
        const kept: Parsed[] = [];
        for (const p of valid) {
          try {
            await tx.transaction(async (sp) => { await sp.execute(insertEvents([p])); });
            kept.push(p);
          } catch (rowErr) {
            const why = rowRefusal(rowErr);
            if (why === null) throw rowErr;
            refused.push({ row: p.row, issue: `database refused it: ${why}` });
          }
        }
        valid = kept;
      }
    }

    refused.sort((a, b) => byOutboxId(a.row.id, b.row.id));
    if (refused.length > 0) {
      await tx.execute(sql`insert into ${audit}.dead_letters (outbox_id, at, event, issue) values ${sql.join(refused.map(deadLetterRow), sql`, `)}`);
    }

    // Held by Postgres until COMMIT, like the API's own `emitChanged`: a pass that rolls back
    // announces nothing. Only stored events are news; a dead letter shows on no screen.
    if (valid.length > 0) {
      const notice = JSON.stringify({ collections: ["audit"], at: new Date().toISOString() });
      await tx.execute(sql`select pg_notify(${EVENTS_CHANNEL_PREFIX + t.eventsSchema}, ${notice})`);
    }

    return {
      moved: valid.length,
      dead: refused.length,
      issues: refused.map((r) => ({ outboxId: Number(r.row.id), issue: r.issue })),
    };
  });
}

/** How far behind the log is: rows waiting, and the age of the oldest in seconds (0 when none).
 *  Sampled after every pass for `audit_outbox_depth` and `audit_drain_lag_seconds`. */
export async function outboxStats(db: Db, outboxSchema: string): Promise<{ depth: number; lagSeconds: number }> {
  const r = await db.execute(sql`
    select count(*)::int as depth, coalesce(extract(epoch from now() - min(at)), 0)::float8 as lag
    from ${sql.identifier(outboxSchema)}.audit_outbox`);
  const row = r.rows[0] as { depth: number; lag: number };
  return { depth: row.depth, lagSeconds: row.lag };
}
```

- [ ] **Step 4: Run the drain test to verify it passes**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/lib/drain.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Prove the two lock tests can fail**

This is a manual check; commit nothing from it.

1. In `apps/audit/src/lib/drain.ts`, change `for update skip locked` to `for update`.
   Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/lib/drain.test.ts -t "does not wait"`
   Expected: FAIL with `a drain waited 2 s on rows another drainer holds instead of skipping them`.
2. Delete the locking clause entirely, so the subquery reads `(select id from ${outbox}.audit_outbox order by id limit ${t.batch})`.
   Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/lib/drain.test.ts -t "side by side"`
   Expected: FAIL, `expected [ 0, 100 ] to deeply equal [ 100, 100 ]` (or `[ 100, 0 ]`).
3. Restore `for update skip locked`.
   Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/lib/drain.test.ts`
   Expected: PASS

- [ ] **Step 6: Write the failing drainer plugin test**

Create `apps/audit/src/plugins/drainer.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { buildTestApp, putOutbox, sampleEvent } from "../test/app.js";
import { AUDIT_OUTBOX_CHANNEL, READY_STALE_MS } from "./drainer.js";

/** A pass that fails, or one that takes nothing, on demand; otherwise the real thing. Hoisted
 *  because a `vi.mock` factory is lifted above the imports. */
const drain = vi.hoisted(() => ({ mode: "real" as "real" | "fail" | "idle" }));
vi.mock("../lib/drain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/drain.js")>();
  return {
    ...actual,
    drainOnce: async (...args: Parameters<typeof actual.drainOnce>) => {
      if (drain.mode === "fail") throw new Error("Connection terminated unexpectedly");
      if (drain.mode === "idle") return { moved: 0, dead: 0, issues: [] };
      return actual.drainOnce(...args);
    },
  };
});

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
/** Drainer off: a pass happens only when a case asks for one. Batch 5, so a full batch is cheap. */
let app: TestApp;
/** Drainer on, polling once a minute: inside a case, only a notification can wake it. */
let live: TestApp;
let liveClosed = false;

beforeAll(async () => {
  app = await buildTestApp({ schema: "drainer", drainer: false, env: { DRAIN_BATCH: "5" } });
  await app.ready();
  live = await buildTestApp({ schema: "drainer_live", drainer: true, env: { DRAIN_POLL_MS: "25000" } });
  await live.ready();
});
afterAll(async () => {
  await app.close();
  if (!liveClosed) await live.close();
});
beforeEach(() => { drain.mode = "real"; });

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await check()) return true;
    await settle(25);
  }
  return check();
}
async function metric(a: TestApp, name: string): Promise<number> {
  const body = (await a.inject({ method: "GET", url: "/metrics" })).body;
  const m = new RegExp(`^${name} (\\S+)$`, "m").exec(body);
  if (!m) throw new Error(`${name} is not on /metrics`);
  return Number(m[1]);
}
const tagged = (tag: string, n: number) => Array.from({ length: n }, (_, i) => sampleEvent({ requestId: `${tag}-${i}` }));
async function storedCount(a: TestApp, tag: string): Promise<number> {
  const r = await a.db.execute(sql`
    select count(*)::int as n from ${sql.identifier(a.testDb.auditSchema)}.events where request_id like ${`${tag}-%`}`);
  return (r.rows[0] as { n: number }).n;
}
async function outboxDepth(a: TestApp): Promise<number> {
  const r = await a.db.execute(sql`select count(*)::int as n from ${sql.identifier(a.testDb.outboxSchema)}.audit_outbox`);
  return (r.rows[0] as { n: number }).n;
}
const readyz = (a: TestApp) => a.inject({ method: "GET", url: "/readyz" });

describe("readiness", () => {
  it("is 503 until a drain pass has succeeded", async () => {
    expect(app.drainer.passes()).toBe(0);
    expect(app.drainer.lastPassAt).toBeNull();
    expect(app.drainer.lastPassOk).toBe(false);
    expect(app.drainer.listening()).toBe(false);
    const r = await readyz(app);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.message).toContain("drainer - no drain pass has succeeded yet");
  });

  it("is 200 after a pass, and 503 again once the last good pass is more than 30 s old", async () => {
    await app.drainer.drainNow();
    expect(app.drainer.lastPassOk).toBe(true);
    expect((await readyz(app)).statusCode).toBe(200);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + READY_STALE_MS + 1000);
      const r = await readyz(app);
      expect(r.statusCode).toBe(503);
      expect(r.json().error.message).toMatch(/drainer - the last successful drain pass was 3\d s ago/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a failed pass without losing readiness while a good pass is recent", async () => {
    await app.drainer.drainNow();
    drain.mode = "fail";
    const before = app.drainer.passes();
    await app.drainer.drainNow();
    expect(app.drainer.passes()).toBe(before + 1);
    expect(app.drainer.lastPassOk).toBe(false);
    expect(app.drainer.lastPassAt).not.toBeNull();
    expect((await readyz(app)).statusCode).toBe(200);

    drain.mode = "real";
    await app.drainer.drainNow();
    expect(app.drainer.lastPassOk).toBe(true);
  });
});

describe("passes", () => {
  it("passes again at once while a pass fills its batch", async () => {
    const tag = randomUUID();
    await putOutbox(app.testDb, tagged(tag, 12));
    const passes = app.drainer.passes();
    const stored = await metric(app, "audit_events_stored_total");

    await app.drainer.drainNow();

    // 5 (full) → 5 (full) → 2 (short): three passes from one request, and the outbox is empty.
    expect(app.drainer.passes() - passes).toBe(3);
    expect(await outboxDepth(app)).toBe(0);
    expect(await storedCount(app, tag)).toBe(12);
    expect((await metric(app, "audit_events_stored_total")) - stored).toBe(12);
  });

  it("reports outbox depth, drain lag, stored events and dead letters on /metrics", async () => {
    const tag = randomUUID();
    drain.mode = "idle";
    await putOutbox(app.testDb, tagged(tag, 3));
    await app.drainer.drainNow();
    expect(await metric(app, "audit_outbox_depth")).toBe(3);
    expect(await metric(app, "audit_drain_lag_seconds")).toBeGreaterThan(0);

    drain.mode = "real";
    await putOutbox(app.testDb, ["not an event"]);
    const stored = await metric(app, "audit_events_stored_total");
    const dead = await metric(app, "audit_dead_letters_total");
    await app.drainer.drainNow();
    expect((await metric(app, "audit_events_stored_total")) - stored).toBe(3);
    expect((await metric(app, "audit_dead_letters_total")) - dead).toBe(1);
    expect(await metric(app, "audit_outbox_depth")).toBe(0);
    expect(await metric(app, "audit_drain_lag_seconds")).toBe(0);
    expect(await metric(app, "audit_listener_up")).toBe(0);   // this app never listens
  });
});

describe("listener", () => {
  const name = () => `rch-audit-drainer ${live.config.auditSchema}`;
  async function listenerPid(): Promise<number | null> {
    const r = await app.db.execute(sql`select pid from pg_stat_activity where application_name = ${name()}`);
    return (r.rows[0] as { pid: number } | undefined)?.pid ?? null;
  }
  /** What the API sends after an outbox insert: its outbox schema's name as the payload (D14). */
  async function notify(payload: string): Promise<void> {
    await app.db.execute(sql`select pg_notify(${AUDIT_OUTBOX_CHANNEL}, ${payload})`);
  }

  it("has passed once by the time ready() resolves, and drains on a notification naming its outbox", async () => {
    expect(live.drainer.passes()).toBeGreaterThanOrEqual(1);
    expect((await readyz(live)).statusCode).toBe(200);
    expect(await waitFor(() => live.drainer.listening(), 5000)).toBe(true);
    expect(await metric(live, "audit_listener_up")).toBe(1);

    const tag = randomUUID();
    await putOutbox(live.testDb, tagged(tag, 3));
    await notify(live.config.outboxSchema);

    // The poll is a minute away; only the notification can explain this.
    expect(await waitFor(async () => (await storedCount(live, tag)) === 3, 2000)).toBe(true);
  });

  it("ignores a notification naming another outbox, and wakes on an empty one", async () => {
    const tag = randomUUID();
    await putOutbox(live.testDb, tagged(tag, 2));
    await notify("some_other_outbox_schema");
    await settle(700);
    expect(await storedCount(live, tag)).toBe(0);

    await notify("");
    expect(await waitFor(async () => (await storedCount(live, tag)) === 2, 2000)).toBe(true);
  });

  it("comes back from a cut LISTEN connection and still wakes on a notification", async () => {
    expect(await waitFor(() => live.drainer.listening(), 5000)).toBe(true);
    const old = await listenerPid();
    expect(old).not.toBeNull();

    await app.db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${name()}`);

    expect(await waitFor(async () => {
      const pid = await listenerPid();
      return live.drainer.listening() && pid !== null && pid !== old;
    }, 20_000)).toBe(true);
    expect(await metric(live, "audit_listener_up")).toBe(1);

    const tag = randomUUID();
    await putOutbox(live.testDb, tagged(tag, 2));
    await notify(live.config.outboxSchema);
    expect(await waitFor(async () => (await storedCount(live, tag)) === 2, 2000)).toBe(true);
  });

  it("gives its LISTEN connection back on close", async () => {
    expect(await listenerPid()).not.toBeNull();
    await live.close();
    liveClosed = true;
    expect(await waitFor(async () => (await listenerPid()) === null, 2000)).toBe(true);
  });

  it("keeps trying to listen while the database refuses it, still drains through the pool, and closes promptly", async () => {
    // The harness hands the app its own pool, so only the LISTEN client uses this unreachable URL.
    const down = await buildTestApp({ schema: "drainer_down", drainer: true, env: { AUDIT_DATABASE_URL: "postgres://rch:rch@127.0.0.1:1/none" } });
    let closed = false;
    try {
      await down.ready();
      expect(down.drainer.passes()).toBeGreaterThanOrEqual(1);
      expect(down.drainer.lastPassOk).toBe(true);
      await settle(700);                                  // long enough for two retries on the backoff
      expect(down.drainer.listening()).toBe(false);
      expect(await metric(down, "audit_listener_up")).toBe(0);
      const started = Date.now();
      await down.close();
      closed = true;
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      if (!closed) await down.close();
    }
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/plugins/drainer.test.ts`
Expected: FAIL. The file does not collect: vitest cannot load `./drainer.js`.

- [ ] **Step 8: Implement the drainer plugin and register it**

Create `apps/audit/src/plugins/drainer.ts`:

```ts
import fp from "fastify-plugin";
import { Client } from "pg";
import { Counter, Gauge } from "prom-client";
import { pgSsl, withoutSslParams } from "../db/client.js";
import { drainOnce, outboxStats, type DrainTarget } from "../lib/drain.js";

/** The API notifies here after every outbox insert, with its outbox schema's name as the payload. */
export const AUDIT_OUTBOX_CHANNEL = "rch_audit_outbox";
/** `/readyz` answers 503 once the last successful pass is older than this (spec §3.3). */
export const READY_STALE_MS = 30_000;
/** How long `app.ready()` waits for the first pass before letting the server listen anyway. */
const FIRST_PASS_WAIT_MS = 5000;
/** The API's SSE listener backoff (apps/api/src/plugins/sse.ts). */
const BACKOFF_MS = [250, 500, 1000, 2000, 5000, 10_000];
const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

export type Drainer = {
  readonly lastPassAt: Date | null;
  readonly lastPassOk: boolean;
  /** Ask for a pass. One already running absorbs the request and passes once more when done. */
  kick(): void;
  /** Kick, then resolve once no pass is running. Works with the drainer disabled. */
  drainNow(): Promise<void>;
  passes(): number;
  listening(): boolean;
};

declare module "fastify" {
  interface FastifyInstance { drainer: Drainer }
}

type PassOutcome = "full" | "short" | "failed";

/**
 * Moves the API's outbox into the log.
 *
 * - **Wakes on:** a notification on `rch_audit_outbox` naming this outbox (or naming none), a
 *   `DRAIN_POLL_MS` tick, a reconnect (notifications were missed while it was down), or a full batch.
 * - **Passes never overlap** within a process: a request made during a pass becomes one more pass
 *   after it. Across replicas, `skip locked` in `drainOnce` keeps them apart.
 * - **`enabled: false`** (tests that call `drainOnce` themselves) opens no LISTEN connection and sets
 *   no timer; `drainNow()` still runs a pass, so readiness and metrics stay testable.
 */
export default fp<{ enabled: boolean }>(async (app, { enabled }) => {
  const { config } = app;
  const target: DrainTarget = {
    auditSchema: config.auditSchema, outboxSchema: config.outboxSchema, eventsSchema: config.eventsSchema, batch: config.drainBatch,
  };

  const registers = [app.metrics.registry];
  const depth = new Gauge({ name: "audit_outbox_depth", help: "Rows waiting in the audit outbox, sampled after each pass", registers });
  const lag = new Gauge({ name: "audit_drain_lag_seconds", help: "Age of the oldest row waiting in the audit outbox, sampled after each pass", registers });
  const stored = new Counter({ name: "audit_events_stored_total", help: "Audit events moved from the outbox into the log", registers });
  const deadLetters = new Counter({ name: "audit_dead_letters_total", help: "Outbox rows set aside in dead_letters", registers });
  const listenerUp = new Gauge({ name: "audit_listener_up", help: "1 while the LISTEN connection on rch_audit_outbox is live", registers });
  listenerUp.set(0);

  // ---- passes ------------------------------------------------------------------
  let lastPassAt: Date | null = null;
  let lastPassOk = false;
  /** Readiness reads this, not `lastPassAt`: one failed pass between good ones is a blip the next
   *  tick retries, not a reason to pull the pod out of rotation. */
  let lastOkAt: Date | null = null;
  let passCount = 0;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;

  async function pass(): Promise<PassOutcome> {
    try {
      const r = await drainOnce(app.db, target);
      // Logged after the pass committed, so a line never names a row that was rolled back into the outbox.
      for (const d of r.issues) app.log.error({ outboxId: d.outboxId, issue: d.issue }, "audit event set aside in dead_letters");
      stored.inc(r.moved);
      deadLetters.inc(r.dead);
      const s = await outboxStats(app.db, target.outboxSchema);
      depth.set(s.depth);
      lag.set(s.lagSeconds);
      const now = new Date();
      lastPassAt = now;
      lastOkAt = now;
      lastPassOk = true;
      return r.moved + r.dead >= target.batch ? "full" : "short";
    } catch (err) {
      app.log.error({ err }, "audit drain pass failed");
      lastPassAt = new Date();
      lastPassOk = false;
      return "failed";
    } finally {
      passCount++;
    }
  }

  function kick(): void {
    if (stopped) return;
    if (running) { again = true; return; }
    running = (async () => {
      do {
        again = false;
        const outcome = await pass();
        // A failed pass is not retried in a loop: the next tick or notification tries again,
        // rather than hammering a database that just refused.
        if (outcome === "failed") break;
        if (outcome === "full") again = true;
      } while (again && !stopped);
    })().finally(() => { running = null; });
  }

  async function drainNow(): Promise<void> {
    kick();
    while (running) await running;
  }

  app.decorate("drainer", {
    get lastPassAt() { return lastPassAt; },
    get lastPassOk() { return lastPassOk; },
    kick,
    drainNow,
    passes: () => passCount,
    listening: () => client !== null,
  });

  app.readiness.addCheck("drainer", async () => {
    if (!lastOkAt) throw new Error("no drain pass has succeeded yet");
    const age = Date.now() - lastOkAt.getTime();
    if (age > READY_STALE_MS) throw new Error(`the last successful drain pass was ${Math.floor(age / 1000)} s ago`);
  });

  // ---- the one connection that hears the API -------------------------------------
  // The API's SSE listener discipline (apps/api/src/plugins/sse.ts), which explains every guard:
  // one live connection, a set that makes a second visible and closeable, `connecting` so a stale
  // event cannot start a connect beside one in flight, and a retire for a replaced connection.
  const connections = new Set<Client>();
  let client: Client | null = null;
  let connecting = false;
  let attempt = 0;
  let everConnected = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let poll: NodeJS.Timeout | null = null;

  const retire = (c: Client) => { connections.delete(c); void c.end().catch(() => {}); };

  async function connect(): Promise<void> {
    if (stopped || connecting) return;
    connecting = true;
    let opened: Client | null = null;
    let failed = false;
    try {
      const c = new Client({
        connectionString: withoutSslParams(config.databaseUrl),
        ssl: pgSsl(config.databaseSsl),
        // The schema rides along so `pg_stat_activity` tells replicas and test files apart.
        application_name: `rch-audit-drainer ${config.auditSchema}`,
      });
      opened = c;
      connections.add(c);
      c.on("error", (err) => { app.log.warn({ err }, "audit outbox listener errored"); scheduleReconnect(c); });
      c.on("end", () => { connections.delete(c); scheduleReconnect(c); });
      c.on("notification", (m) => {
        if (m.channel !== AUDIT_OUTBOX_CHANNEL) return;
        // The channel is database-wide; the payload names the outbox that was written (D14). Another
        // deployment's outbox sharing this database is not ours to drain. Empty means "anyone's".
        if (!m.payload || m.payload === config.outboxSchema) kick();
      });
      await c.connect();
      await c.query(`listen ${quoteIdent(AUDIT_OUTBOX_CHANNEL)}`);
      if (client && client !== c) retire(client);
      client = c;
      opened = null;
      attempt = 0;
      listenerUp.set(1);
      // A reconnect means notifications were missed while it was down: a pass is the catch-up.
      if (everConnected) kick();
      everConnected = true;
      app.log.info("audit outbox listener connected");
    } catch (err) {
      app.log.warn({ err }, "audit outbox listener could not connect");
      failed = true;
    } finally {
      connecting = false;
    }
    if (failed) scheduleReconnect(opened);
  }

  function scheduleReconnect(dead: Client | null): void {
    if (stopped || connecting || retryTimer) return;
    if (client && dead && client !== dead) return;
    client = null;
    listenerUp.set(0);
    if (dead) retire(dead);
    const wait = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
    retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, wait);
    retryTimer.unref();
  }

  app.addHook("onReady", async () => {
    if (!enabled) return;
    await connect();
    poll = setInterval(kick, config.drainPollMs);
    poll.unref();
    // Whatever piled up while no drainer ran goes now. `ready()` waits for that first pass, so a pod
    // that answers /readyz straight after start has really drained once - bounded, so a large backlog
    // or a slow database never holds the server's listen back.
    await Promise.race([drainNow(), new Promise((r) => { setTimeout(r, FIRST_PASS_WAIT_MS).unref(); })]);
  });

  // ---- shutdown ------------------------------------------------------------------
  async function shutdown(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (poll) clearInterval(poll);
    if (retryTimer) clearTimeout(retryTimer);
    listenerUp.set(0);
    const ends = [...connections].map((c) => c.end().catch(() => {}));
    connections.clear();
    client = null;
    // The pass in flight is a transaction on the pool; let it commit or roll back before anything
    // closes the pool. Bounded, so SIGTERM never waits on a black-holed socket.
    await Promise.race([Promise.all([...ends, running]), new Promise((r) => { setTimeout(r, 5000).unref(); })]);
  }
  // `preClose` runs ahead of the server closing and of every `onClose` (see sse.ts); `onClose` is the
  // belt for an app that never finished booting, and it still runs before `AppDeps.cleanup`.
  app.addHook("preClose", shutdown);
  app.addHook("onClose", shutdown);
}, { name: "drainer", dependencies: ["db", "metrics", "health"] });
```

Replace `apps/audit/src/app.ts` with this: Task 10's version, plus the drainer import and its registration after `db`.

```ts
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { AuditConfig } from "./config.js";
import type { Db } from "./db/client.js";
import logging, { genReqId, loggerOptions, type LogStream } from "./plugins/logging.js";
import errors from "./plugins/errors.js";
import metrics from "./plugins/metrics.js";
import health from "./plugins/health.js";
import security from "./plugins/security.js";
import db from "./plugins/db.js";
import drainer from "./plugins/drainer.js";

declare module "fastify" { interface FastifyInstance { config: AuditConfig } }

export type AuditApp = FastifyInstance;
/**
 * - `db` + `pool`: a handle the caller owns (the test harness); otherwise the db plugin opens one on
 *   `searchPath`, which defaults to `config.auditSchema`.
 * - `logStream`: where the log goes when it is not stdout - a test reading its own lines back.
 * - `drainer`: whether `plugins/drainer.ts` starts its LISTEN client, poll timer and first pass
 *   (default on); a test that drives a pass by hand passes `false`.
 * - `cleanup`: run once the app has closed, after every plugin's own `onClose` - the test harness
 *   drops its schemas there.
 */
export type AppDeps = { db?: Db; pool?: Pool; searchPath?: string; logStream?: LogStream; drainer?: boolean; cleanup?: () => Promise<void> };

export async function buildApp(config: AuditConfig, deps: AppDeps = {}): Promise<AuditApp> {
  const app = Fastify({
    logger: loggerOptions(config.logLevel, deps.logStream),
    genReqId,
    trustProxy: config.trustProxy,
    // Every route is a GET; nothing this service accepts has a body worth more than a header.
    bodyLimit: 64 * 1024,
    forceCloseConnections: "idle",
    logController: new LogController({ disableRequestLogging: true }),
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
  }).withTypeProvider<ZodTypeProvider>();
  // The first onClose hook added is the last to run (avvio runs them newest first), so a caller's
  // cleanup comes after every plugin has let go of the pool.
  const cleanup = deps.cleanup;
  if (cleanup) app.addHook("onClose", async () => { await cleanup(); });
  app.decorate("config", config);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(logging);
  await app.register(errors);
  await app.register(metrics);
  await app.register(health);
  await app.register(security);
  await app.register(db, { url: config.databaseUrl, ssl: config.databaseSsl, max: config.dbPoolMax, searchPath: deps.searchPath ?? config.auditSchema, auditSchema: config.auditSchema, db: deps.db, pool: deps.pool });
  await app.register(drainer, { enabled: deps.drainer ?? true });
  return app;
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/lib/drain.test.ts src/plugins/drainer.test.ts src/plugins/db.test.ts`
Expected: PASS (10 + 10 + 5 tests). `db.test.ts` builds its app with `drainer: true`, and its first case's `/readyz` 200 now depends on the drain check. That check passes because `ready()` waits for the first pass. Its 503 cases assert with `toContain("database - …")`, which the extra `drainer` check does not change.
Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run`
Expected: PASS (the whole audit suite)
Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit typecheck && pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit lint`
Expected: PASS, 0 warnings

- [ ] **Step 10: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add apps/audit/src/lib/drain.ts apps/audit/src/lib/drain.test.ts apps/audit/src/plugins/drainer.ts apps/audit/src/plugins/drainer.test.ts apps/audit/src/app.ts
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Drain the audit outbox into the log exactly once and report readiness

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

### Task 12: Audit service - auth and read routes

**Files:**
- Create: `apps/audit/src/lib/db.ts`
- Create: `apps/audit/src/lib/time.ts`
- Create: `apps/audit/src/plugins/auth.ts`
- Create: `apps/audit/src/routes.ts`
- Create: `apps/audit/src/modules/audit/repo.ts`
- Create: `apps/audit/src/modules/audit/service.ts`
- Create: `apps/audit/src/modules/audit/routes.ts`
- Modify: `apps/audit/src/app.ts` (register `auth` and the audit module)
- Test: `apps/audit/src/lib/time.test.ts`
- Test: `apps/audit/src/modules/audit/audit.test.ts`

**Interfaces:**
- Consumes:
  - From Task 1: `routes.auditLog`, `routes.auditEntry`, `serviceOf`, `defineRoute`, `API_PREFIX`, `AUDIT_PATH`, `AUDIT_GROUP_KEYS`, `actionsInGroup`, and the types `AnyRoute`, `Route`, `AuditQuery`, `AuditPage`, `AuditRow` (with `ip` and `requestId` per D4), `AuditEntry`, `AuditCounts`, `AuditOutcome`, `AuditActor`, `AuditEvent`.
  - From Task 11: `drainOnce`, which loads fixtures into the log the real way.
  - From Tasks 9 and 10: `AuditApp`, `AppDeps`, `Db`; `app.config.jwtPublicKeyPem` / `jwtPreviousPublicKeyPem`; `ValidationError`, `UnauthenticatedError`, `ForbiddenError`, `NotFoundError`; `buildTestApp`, `signToken`, `putOutbox`, `sampleEvent`.
- Produces:
  - `mount()`, `mountedRoutes`, `Req`, `Handler` (`src/routes.ts`).
  - `app.authenticate`, `app.requireAdmin`, `AccessClaims`.
  - `AuditFilter`, `auditRepo.page` / `counts` / `entry`, `createAuditService(db)`.
  - `GET /api/v1/admin/audit` and `GET /api/v1/admin/audit/:id` on the audit service.
  - `Tx`, `Reader`, `withReadTransaction`; `istDay`, `istDayStart`, `nextIstDay`.

- [ ] **Step 1: Write the failing tests**

Create `apps/audit/src/lib/time.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { istDay, istDayStart, nextIstDay } from "./time.js";

describe("IST days", () => {
  it("names the hospital's day an instant falls on, not the host's", () => {
    expect(new Date(0).getTimezoneOffset()).toBe(0);   // the suite runs under TZ=UTC
    expect(istDay(new Date("2025-09-13T18:29:59.999Z"))).toBe("2025-09-13");
    expect(istDay(new Date("2025-09-13T18:30:00.000Z"))).toBe("2025-09-14");
  });

  it("starts a day at IST midnight and the next one 24 hours later", () => {
    const start = istDayStart("2025-09-14");
    expect(start?.toISOString()).toBe("2025-09-13T18:30:00.000Z");
    expect(nextIstDay(start!).toISOString()).toBe("2025-09-14T18:30:00.000Z");
    expect(istDayStart("2024-02-29")?.toISOString()).toBe("2024-02-28T18:30:00.000Z");
  });

  it("has no start for a day the calendar does not have", () => {
    expect(istDayStart("2025-02-30")).toBeNull();   // Date would roll it into March
    expect(istDayStart("2025-13-01")).toBeNull();   // Date cannot read it at all
  });
});
```

Create `apps/audit/src/modules/audit/audit.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { createSigner } from "fast-jwt";
import { z } from "zod";
import {
  API_PREFIX, AUDIT_GROUP_KEYS, AUDIT_PATH, actionsInGroup, defineRoute, routes, serviceOf,
  type AuditActor, type AuditEntry, type AuditEvent, type AuditPage,
} from "@rch/contract";
import { drainOnce } from "../../lib/drain.js";
import { mount, mountedRoutes } from "../../routes.js";
import { buildTestApp, putOutbox, sampleEvent, signToken } from "../../test/app.js";

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
let app: TestApp;

/** Role labels as `roleLabelOf` prints them (D5). */
const who = {
  priya: { id: "u1", emp: "RC-4471", name: "Priya Raman", role: "Counter Operator", loc: "coffee" },
  ramesh: { id: "u2", emp: "RC-3120", name: "Ramesh Kumar", role: "Outlet Manager", loc: "central" },
  arun: { id: "u3", emp: "RC-2088", name: "Arun Das", role: "Store Keeper", loc: "central" },
  ravi: { id: "u5", emp: "RC-1550", name: "Ravi Menon", role: "Procurement Officer", loc: "central" },
  stranger: { id: null, emp: "RC-9999", name: "", role: "", loc: "" },
} satisfies Record<string, AuditActor>;

type Fixture = [key: string, over: Partial<AuditEvent>];
const noDetail = { cause: null, before: null, result: null, changed: [] } satisfies Partial<AuditEvent>;
const signInRefused = { method: "POST", path: "/auth/login", target: "", targetLoc: "", outcome: "refused", status: 401, message: "That employee number and password do not match." } satisfies Partial<AuditEvent>;

/** IST 10 and 11 March 2025. f8 is the last second of the 11th; f9, the first instant of the 12th,
 *  must stay out of that range. The sentences carry the decoys the search cases need: f1's "B-1050"
 *  holds "50" without a "%", and f3's "XJumbo" matches an unescaped "_Jumbo". */
const MARCH: Fixture[] = [
  ["f1", { ...noDetail, at: "2025-03-10T03:30:00.000Z", actor: who.priya, action: "pay", method: "POST", path: "/bills", target: "B-1050", targetLoc: "coffee", outcome: "done", status: 200, message: "Bill B-1050 posted for ₹120" }],
  ["f2", {
    at: "2025-03-10T04:30:00.000Z", actor: who.ramesh, action: "savePrice", method: "PUT", path: "/prices/:list/:it", target: "staff:muffin", targetLoc: "",
    outcome: "done", status: 200, message: "Price of 50% Off Muffin_Jumbo saved at ₹45", cause: null,
    request: { params: { list: "staff", it: "muffin" }, query: {}, body: { price: 45 } },
    before: { price: 40 }, result: { list: "staff", it: "muffin", price: 45 }, changed: ["prices"],
    ip: "10.0.4.21", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0",
  }],
  ["f3", { ...noDetail, at: "2025-03-10T05:30:00.000Z", actor: who.ravi, action: "createPo", method: "POST", path: "/purchase-orders", target: "", targetLoc: "", outcome: "refused", status: 422, message: "Refused - XJumbo Foods is inactive", cause: "vendor inactive" }],
  ["f4", { ...noDetail, ...signInRefused, at: "2025-03-10T06:30:00.000Z", actor: who.stranger, action: "login", cause: "unknown employee" }],
  ["f5", { ...noDetail, ...signInRefused, at: "2025-03-10T07:30:00.000Z", actor: who.priya, action: "login", cause: "wrong password" }],
  ["f6", { ...noDetail, at: "2025-03-11T03:30:00.000Z", actor: who.priya, action: "logout", method: "POST", path: "/auth/logout", target: "", targetLoc: "", outcome: "done", status: 200, message: "Signed out." }],
  ["f7", { ...noDetail, at: "2025-03-11T04:30:00.000Z", actor: who.arun, action: "receivePo", method: "POST", path: "/purchase-orders/:id/receive", target: "PO-0007", targetLoc: "central", outcome: "error", status: 500, message: "Something went wrong on our side. Reference f7." }],
  ["f8", { ...noDetail, at: "2025-03-11T18:29:59.000Z", actor: who.ramesh, action: "toggleAvail", method: "POST", path: "/availability/toggle", target: "juice", targetLoc: "rest", outcome: "done", status: 200, message: "Juice marked unavailable at the Restaurant" }],
  ["f9", { ...noDetail, at: "2025-03-11T18:30:00.000Z", actor: who.ramesh, action: "approveRequest", method: "POST", path: "/requests/:id/approve", target: "REQ-0003", targetLoc: "rest", outcome: "done", status: 200, message: "REQ-0003 approved" }],
];
const MARCH_RANGE = { from: "2025-03-10", to: "2025-03-11" };
const IN_RANGE = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"];

/** The IST day boundary, read under TZ=UTC. */
const SEPT: Fixture[] = [
  ["g1", { at: "2025-09-13T18:29:59.000Z" }],   // 23:59:59 IST on the 13th
  ["g2", { at: "2025-09-13T18:45:00.000Z" }],   // 00:15 IST on the 14th
  ["g3", { at: "2025-09-14T18:29:59.999Z" }],   // the last millisecond of the 14th in IST
  ["g4", { at: "2025-09-14T18:30:00.000Z" }],   // IST midnight: the 15th
];
/** 25 events at 09:30 IST on 1 June 2025, a second apart, for paging. */
const JUNE: Fixture[] = Array.from({ length: 25 }, (_, i): Fixture => [`p${String(i).padStart(2, "0")}`, { at: new Date(Date.UTC(2025, 5, 1, 4, 0, i)).toISOString() }]);

const ids = new Map<string, number>();
const idsOf = (...keys: string[]): number[] => keys.map((k) => {
  const id = ids.get(k);
  if (id === undefined) throw new Error(`no fixture ${k}`);
  return id;
});

beforeAll(async () => {
  app = await buildTestApp({ schema: "reads", drainer: false });
  await app.ready();
  const t = app.testDb;
  const today: Fixture = ["today", { at: new Date().toISOString() }];
  await putOutbox(t, [...MARCH, ...SEPT, ...JUNE, today].map(([key, over]) => sampleEvent({ ...over, requestId: key })));
  const r = await drainOnce(app.db, { auditSchema: t.auditSchema, outboxSchema: t.outboxSchema, eventsSchema: app.config.eventsSchema, batch: 500 });
  if (r.dead > 0) throw new Error(`fixtures refused: ${JSON.stringify(r.issues)}`);
  const rows = await app.db.execute(sql`select id::int as id, request_id from ${sql.identifier(t.auditSchema)}.events`);
  for (const row of rows.rows as Array<{ id: number; request_id: string }>) ids.set(row.request_id, row.id);
});
afterAll(async () => { await app.close(); });

const adminClaims = { sub: "u0", role: "manager", loc: "central", admin: true };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const asAdmin = () => bearer(signToken(app, adminClaims));
const qs = (query: Record<string, string | number>) =>
  Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
const getLog = (query: Record<string, string | number> = {}, headers: Record<string, string> = asAdmin()) =>
  app.inject({ method: "GET", url: `${API_PREFIX}${AUDIT_PATH}?${qs(query)}`, headers });
const getEntry = (id: number | string, headers: Record<string, string> = asAdmin()) =>
  app.inject({ method: "GET", url: `${API_PREFIX}${AUDIT_PATH}/${id}`, headers });
async function readLog(query: Record<string, string | number> = {}): Promise<AuditPage> {
  const res = await getLog(query);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AuditPage;
}
const idsIn = (page: AuditPage) => page.rows.map((r) => r.id);

describe("GET /admin/audit - filters", () => {
  it("answers the period newest first, one row per event, in the row's own shape", async () => {
    const page = await readLog(MARCH_RANGE);
    expect(idsIn(page)).toEqual(idsOf("f8", "f7", "f6", "f5", "f4", "f3", "f2", "f1"));
    expect(page.next).toBeNull();
    expect(page.rows.at(-1)).toEqual({
      id: idsOf("f1")[0], at: "2025-03-10T03:30:00.000Z", actor: who.priya, action: "pay",
      target: "B-1050", targetLoc: "coffee", outcome: "done", status: 200, message: "Bill B-1050 posted for ₹120",
      requestId: "f1", ip: "10.0.0.7",
    });
    expect(page.rows.find((r) => r.requestId === "f2")?.ip).toBe("10.0.4.21");
  });

  it("narrows to one person", async () => {
    expect(idsIn(await readLog({ ...MARCH_RANGE, actor: "u1" }))).toEqual(idsOf("f6", "f5", "f1"));
  });

  it("narrows to a role as it was printed", async () => {
    expect(idsIn(await readLog({ ...MARCH_RANGE, role: "Store Keeper" }))).toEqual(idsOf("f7"));
  });

  it("narrows to a location the person worked at or the target belonged to", async () => {
    expect(idsIn(await readLog({ ...MARCH_RANGE, loc: "central" }))).toEqual(idsOf("f8", "f7", "f3", "f2"));
    expect(idsIn(await readLog({ ...MARCH_RANGE, loc: "rest" }))).toEqual(idsOf("f8"));
  });

  it("narrows to one outcome", async () => {
    expect(idsIn(await readLog({ ...MARCH_RANGE, outcome: "refused" }))).toEqual(idsOf("f5", "f4", "f3"));
    expect(idsIn(await readLog({ ...MARCH_RANGE, outcome: "error" }))).toEqual(idsOf("f7"));
    expect(idsIn(await readLog({ ...MARCH_RANGE, outcome: "done" }))).toEqual(idsOf("f8", "f6", "f2", "f1"));
  });

  it("narrows to one action", async () => {
    expect(idsIn(await readLog({ ...MARCH_RANGE, action: "login" }))).toEqual(idsOf("f5", "f4"));
  });

  it("narrows to an area through AUDIT_LABELS, and an action outside that area to nothing", async () => {
    expect(actionsInGroup("accounts")).toEqual(expect.arrayContaining(["login", "logout"]));
    for (const group of AUDIT_GROUP_KEYS) {
      const inGroup = new Set(actionsInGroup(group));
      const want = MARCH.filter(([key, over]) => IN_RANGE.includes(key) && inGroup.has(over.action!)).map(([key]) => key).reverse();
      const page = await readLog({ ...MARCH_RANGE, group });
      expect(idsIn(page), group).toEqual(idsOf(...want));
      expect(page.counts.events, group).toBe(want.length);
    }
    expect(idsIn(await readLog({ ...MARCH_RANGE, group: "accounts", action: "login" }))).toEqual(idsOf("f5", "f4"));
    const outside = await readLog({ ...MARCH_RANGE, group: "sales", action: "login" });
    expect(outside.rows).toEqual([]);
    expect(outside.counts.events).toBe(0);
  });

  it("searches target, sentence, name and employee number, ignoring case", async () => {
    expect(idsIn(await readLog({ ...MARCH_RANGE, q: "muffin" }))).toEqual(idsOf("f2"));             // target and sentence
    expect(idsIn(await readLog({ ...MARCH_RANGE, q: "PO-0007" }))).toEqual(idsOf("f7"));            // target
    expect(idsIn(await readLog({ ...MARCH_RANGE, q: "priya" }))).toEqual(idsOf("f6", "f5", "f1"));  // name
    expect(idsIn(await readLog({ ...MARCH_RANGE, q: "rc-9999" }))).toEqual(idsOf("f4"));            // employee number
  });

  it("reads % and _ in a search as the characters themselves", async () => {
    expect(idsIn(await readLog({ ...MARCH_RANGE, q: "50%" }))).toEqual(idsOf("f2"));      // not f1's "B-1050"
    expect(idsIn(await readLog({ ...MARCH_RANGE, q: "_Jumbo" }))).toEqual(idsOf("f2"));   // not f3's "XJumbo"
  });

  it("ignores a search of only spaces", async () => {
    expect((await readLog({ ...MARCH_RANGE, q: "   " })).rows).toHaveLength(8);
  });
});

describe("GET /admin/audit - days in Asia/Kolkata", () => {
  it("puts 18:45Z on the 13th on the 14th, and ends the 14th at IST midnight, on a UTC host", async () => {
    expect(new Date(0).getTimezoneOffset()).toBe(0);
    expect(idsIn(await readLog({ from: "2025-09-14", to: "2025-09-14" }))).toEqual(idsOf("g3", "g2"));
    expect(idsIn(await readLog({ from: "2025-09-13", to: "2025-09-13" }))).toEqual(idsOf("g1"));
    expect(idsIn(await readLog({ from: "2025-09-13", to: "2025-09-15" }))).toEqual(idsOf("g4", "g3", "g2", "g1"));
  });

  it("defaults the period to today", async () => {
    expect(idsIn(await readLog())).toEqual(idsOf("today"));
  });

  it("runs a lone from day through today, and takes a lone to day as that day alone", async () => {
    expect(idsIn(await readLog({ from: "2025-09-14" }))).toEqual(idsOf("today", "g4", "g3", "g2"));
    expect(idsIn(await readLog({ to: "2025-09-13" }))).toEqual(idsOf("g1"));
  });

  it("refuses a day the calendar does not have, and a period that ends before it starts", async () => {
    const noSuchFrom = await getLog({ from: "2025-02-30" });
    expect(noSuchFrom.statusCode).toBe(400);
    expect(noSuchFrom.json()).toEqual({ error: { code: "validation", message: "There is no day 2025-02-30 on the calendar." } });
    const noSuchTo = await getLog({ from: "2025-03-10", to: "2025-13-01" });
    expect(noSuchTo.statusCode).toBe(400);
    expect(noSuchTo.json().error.message).toBe("There is no day 2025-13-01 on the calendar.");
    const backwards = await getLog({ from: "2025-03-12", to: "2025-03-10" });
    expect(backwards.statusCode).toBe(400);
    expect(backwards.json().error.message).toBe("The period cannot start on 2025-03-12, after it ends on 2025-03-10.");
  });
});

describe("GET /admin/audit - paging and counts", () => {
  it("pages by id without overlap or gaps, and counts the whole filter on every page", async () => {
    const day = { from: "2025-06-01", to: "2025-06-01", limit: 10 };
    const first = await readLog(day);
    const second = await readLog({ ...day, before: first.next! });
    const third = await readLog({ ...day, before: second.next! });

    expect([first.rows.length, second.rows.length, third.rows.length]).toEqual([10, 10, 5]);
    expect(first.next).toBe(first.rows[9].id);
    expect(second.next).toBe(second.rows[9].id);
    expect(third.next).toBeNull();
    const seen = [...idsIn(first), ...idsIn(second), ...idsIn(third)];
    expect(new Set(seen).size).toBe(25);
    expect(seen).toEqual(idsOf(...JUNE.map(([key]) => key)).sort((a, b) => b - a));
    for (const page of [first, second, third]) expect(page.counts.events).toBe(25);
  });

  it("offers no next page when the last page is exactly full", async () => {
    const page = await readLog({ ...MARCH_RANGE, limit: 8 });
    expect(page.rows).toHaveLength(8);
    expect(page.next).toBeNull();
  });

  it("counts events, people, refusals and failed sign-ins over the whole filter, not the page", async () => {
    const page = await readLog({ ...MARCH_RANGE, limit: 2 });
    expect(idsIn(page)).toEqual(idsOf("f8", "f7"));
    expect(page.next).toBe(idsOf("f7")[0]);
    // People: u1, u2, u3, u5 and the unknown RC-9999, told apart by employee number.
    // Refused: everything not done, errors included (f3, f4, f5, f7).
    expect(page.counts).toEqual({ events: 8, people: 5, refused: 4, failedSignIns: 2 });
    expect((await readLog({ ...MARCH_RANGE, outcome: "refused" })).counts).toEqual({ events: 3, people: 3, refused: 3, failedSignIns: 2 });
  });

  it("refuses a page size outside 1-500", async () => {
    expect((await getLog({ ...MARCH_RANGE, limit: 0 })).statusCode).toBe(400);
    expect((await getLog({ ...MARCH_RANGE, limit: 501 })).statusCode).toBe(400);
  });
});

describe("GET /admin/audit/:id", () => {
  it("answers one entry with what was sent, the before values and the result", async () => {
    const [id] = idsOf("f2");
    const res = await getEntry(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      id, at: "2025-03-10T04:30:00.000Z", actor: who.ramesh, action: "savePrice", target: "staff:muffin", targetLoc: "",
      outcome: "done", status: 200, message: "Price of 50% Off Muffin_Jumbo saved at ₹45", requestId: "f2", ip: "10.0.4.21",
      method: "PUT", path: "/prices/:list/:it", cause: null,
      request: { params: { list: "staff", it: "muffin" }, query: {}, body: { price: 45 } },
      before: { price: 40 }, result: { list: "staff", it: "muffin", price: 45 }, changed: ["prices"],
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0",
    } satisfies AuditEntry);
  });

  it("answers a refused sign-in by an unknown employee with its cause and no actor id", async () => {
    const res = await getEntry(idsOf("f4")[0]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ actor: who.stranger, action: "login", outcome: "refused", cause: "unknown employee", before: null, result: null, changed: [] });
  });

  it("answers an id that is not in the log with a 404 sentence", async () => {
    const res = await getEntry(987654321);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "There is no audit entry 987654321." } });
  });

  it("refuses an id that is not a number", async () => {
    expect((await getEntry("abc")).statusCode).toBe(400);
  });
});

describe("who may read the log", () => {
  it("asks anyone without a token to sign in, on both routes", async () => {
    for (const res of [await getLog(MARCH_RANGE, {}), await getEntry(idsOf("f1")[0], {})]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } });
    }
  });

  it("asks for sign-in again for a token that is not a JWT, or that the API did not sign", async () => {
    expect((await getLog(MARCH_RANGE, bearer("not-a-token"))).statusCode).toBe(401);
    const { privateKey } = generateKeyPairSync("ed25519");
    const forged = createSigner({ key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), algorithm: "EdDSA", iss: "rch-api" })(adminClaims);
    expect((await getLog(MARCH_RANGE, bearer(forged))).statusCode).toBe(401);
  });

  it("accepts a token signed with the previous key", async () => {
    const res = await getLog(MARCH_RANGE, bearer(signToken(app, adminClaims, { previousKey: true })));
    expect(res.statusCode, res.body).toBe(200);
  });

  it("answers a signed-in account without the admin flag with a 404, even for a malformed query", async () => {
    const counter = bearer(signToken(app, { sub: "u1", role: "counter", loc: "coffee", admin: false }));
    for (const res of [await getLog(MARCH_RANGE, counter), await getEntry(idsOf("f1")[0], counter), await getLog({ limit: 0 }, counter)]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
  });

  it("refuses an admin who must still change their password", async () => {
    const res = await getLog(MARCH_RANGE, bearer(signToken(app, { ...adminClaims, mcp: true })));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: "forbidden", message: "Change your password before you carry on." } });
  });
});

describe("mount", () => {
  it("mounts every route the manifest gives the audit service", () => {
    const tagged = Object.values(routes).filter((r) => serviceOf(r) === "audit").map((r) => `${r.method} ${r.path}`);
    expect(tagged.length).toBeGreaterThan(0);
    expect([...mountedRoutes].sort()).toEqual(tagged.sort());
  });

  it("refuses a route that belongs to the API", () => {
    expect(() => mount(app, routes.adminUsers, async () => [])).toThrow("is served by the api service");
  });

  it("refuses an audit route that is not admin-only", () => {
    const probe = defineRoute({ method: "GET", path: "/admin/audit/probe", access: "any", service: "audit", response: z.strictObject({}) });
    expect(() => mount(app, probe, async () => ({}))).toThrow("is not an admin route");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/lib/time.test.ts src/modules/audit/audit.test.ts`
Expected: FAIL. Neither file collects: vitest cannot load `./time.js` or `../../routes.js`.

- [ ] **Step 3: Implement**

Create `apps/audit/src/lib/time.ts`:

```ts
// The hospital's calendar. IST has no daylight saving, so a day is always 24 hours and a fixed
// +05:30 offset is exact; the host's own zone never enters into it (the suite runs under TZ=UTC).
const DAY_MS = 86_400_000;
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });

/** The IST calendar day an instant falls on, as `YYYY-MM-DD`. */
export function istDay(at: Date): string {
  const parts = dayFormat.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Midnight IST at the start of `day`, or null for a day the calendar does not have: `Date` reads
 *  `2025-02-30` as 2 March, so the answer is checked by naming its day back. */
export function istDayStart(day: string): Date | null {
  const at = new Date(`${day}T00:00:00+05:30`);
  if (Number.isNaN(at.getTime())) return null;
  return istDay(at) === day ? at : null;
}

/** Midnight IST at the start of the following day. */
export const nextIstDay = (dayStart: Date): Date => new Date(dayStart.getTime() + DAY_MS);
```

Create `apps/audit/src/lib/db.ts`:

```ts
import type { Db } from "../db/client.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** The pool or an open transaction's client; both answer `select`. */
export type Reader = Db | Tx;

/**
 * A read that makes more than one query runs here, so one request holds one connection, and it
 * awaits its queries in sequence - a transaction is a single client and runs one query at a time
 * (apps/api/src/lib/db.ts, "Reads" in apps/api/CLAUDE.md). `read only` also means a reader that
 * ever tried to write would be refused by Postgres.
 */
export const withReadTransaction = <T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  db.transaction(fn, { accessMode: "read only" });
```

Create `apps/audit/src/plugins/auth.ts`:

```ts
import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createVerifier } from "fast-jwt";
import { ForbiddenError, NotFoundError, UnauthenticatedError } from "../lib/errors.js";

/** The API's access-token claims. This service only verifies them and never signs one. */
export type AccessClaims = { sub: string; role: string; loc: string; mcp?: boolean; admin?: boolean };
type Gate = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module "fastify" {
  interface FastifyRequest { user: AccessClaims | null }
  interface FastifyInstance { authenticate: Gate; requireAdmin: Gate }
}

/**
 * Verify-only auth: the API's tokens, checked against its public key and, during a rotation, the
 * previous one. The same algorithm and issuer checks as `apps/api/src/plugins/auth.ts`, with
 * fast-jwt directly for both keys, for the reason that file gives.
 */
export default fp(async (app) => {
  const keys = [app.config.jwtPublicKeyPem, app.config.jwtPreviousPublicKeyPem].filter((k): k is string => Boolean(k));
  const verifiers = keys.map((key) => createVerifier({ key, algorithms: ["EdDSA"], allowedIss: "rch-api" }));

  app.decorateRequest("user", null);

  app.decorate("authenticate", async (req: FastifyRequest) => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (token) {
      for (const verify of verifiers) {
        try {
          req.user = verify(token) as AccessClaims;
          return;
        } catch { /* the next key, then the refusal below */ }
      }
    }
    throw new UnauthenticatedError("Sign in to continue.");
  });

  /** The answer `rbac.ts` gives: an account without the flag learns nothing about the route, and a
   *  flagged token that must still change its password reaches no data. */
  app.decorate("requireAdmin", async (req: FastifyRequest) => {
    if (!req.user?.admin) throw new NotFoundError(`There is nothing at ${req.method} ${req.url}.`);
    if (req.user.mcp) throw new ForbiddenError("Change your password before you carry on.");
  });
}, { name: "auth", dependencies: ["errors"] });
```

Create `apps/audit/src/routes.ts`:

```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { API_PREFIX, serviceOf, type AnyRoute, type Route } from "@rch/contract";
import type { AuditApp } from "./app.js";

type Infer<T> = T extends z.ZodTypeAny ? z.infer<T> : undefined;
export type Req<R extends AnyRoute> = FastifyRequest<{
  Params: R extends Route<infer P, z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny> ? Infer<P> : never;
  Querystring: R extends Route<z.ZodTypeAny, infer Q, z.ZodTypeAny, z.ZodTypeAny> ? Infer<Q> : never;
}>;
export type Handler<R extends AnyRoute> = (req: Req<R>, reply: FastifyReply) => Promise<z.infer<R["response"]>>;

/** `"<METHOD> <manifest path>"` for every route mounted, so a test can hold it against the
 *  manifest's `service: "audit"` entries. */
export const mountedRoutes = new Set<string>();

/**
 * The only way a module registers a route here. The manifest supplies method, path and schemas; the
 * module supplies the handler.
 *
 * Every route this service serves is `access: "admin"`. A route tagged for another service, or one
 * that is not admin-only, is refused at boot rather than served with the wrong gate. The gates run
 * on `onRequest`, ahead of validation, so an account without the flag gets the same 404 for a
 * malformed query as for a good one and never learns the route exists.
 */
export function mount<R extends AnyRoute>(app: AuditApp, route: R, handler: Handler<R>): void {
  const key = `${route.method} ${route.path}`;
  const service = serviceOf(route);
  if (service !== "audit") throw new Error(`${key} is served by the ${service} service, not the audit service.`);
  if (route.access !== "admin") throw new Error(`${key} is not an admin route, and the audit service serves nothing else.`);
  // A slot the manifest leaves unset is left off entirely (FSTWRN001; see apps/api/src/routes.ts).
  const schema = {
    ...(route.params ? { params: route.params } : {}),
    ...(route.query ? { querystring: route.query } : {}),
    response: { 200: route.response },
  };
  app.route({
    method: route.method,
    url: API_PREFIX + route.path,
    schema,
    onRequest: [app.authenticate, app.requireAdmin],
    handler: handler as never,
  });
  mountedRoutes.add(key);
}
```

Create `apps/audit/src/modules/audit/repo.ts`:

```ts
// repo.ts: SQL only. No rules, no transaction of its own - service.ts opens the read-only
// transaction and passes it in. `events` is unqualified: the pool's search_path is the audit
// schema (spec §3.2), the way the API's repos resolve their own tables.
import { sql, type SQL } from "drizzle-orm";
import type { AuditCounts, AuditEntry, AuditOutcome, AuditRow } from "@rch/contract";
import type { Reader } from "../../lib/db.js";

/** `fromAt` inclusive, `toAt` exclusive (the IST midnight after the last day asked for). */
export type AuditFilter = {
  fromAt: Date; toAt: Date;
  actor?: string; role?: string; loc?: string;
  actions?: string[]; outcome?: AuditOutcome; q?: string;
  before?: number; limit: number;
};

type RowRecord = {
  id: string; at: string; request_id: string; ip: string;
  actor_id: string | null; actor_emp: string; actor_name: string; actor_role: string; actor_loc: string;
  action: string; target: string; target_loc: string; outcome: AuditOutcome; status: number; message: string;
};
type EntryRecord = RowRecord & {
  method: string; path: string; cause: string | null;
  request: unknown; before: unknown; result: unknown; changed: string[]; user_agent: string;
};

/** `at` is formatted here: drizzle's driver hands a timestamptz back as Postgres's own text, and the
 *  wire wants `toISOString()`'s shape. `id` is a bigint, which pg gives as a string. `request_id` and
 *  `ip` are on the row (D4) for the table's CSV export. */
const ROW_COLUMNS = sql.raw(
  `id, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at, request_id, ip, `
  + "actor_id, actor_emp, actor_name, actor_role, actor_loc, action, target, target_loc, outcome, status, message",
);

const toRow = (r: RowRecord): AuditRow => ({
  id: Number(r.id), at: r.at,
  actor: { id: r.actor_id, emp: r.actor_emp, name: r.actor_name, role: r.actor_role, loc: r.actor_loc },
  action: r.action, target: r.target, targetLoc: r.target_loc, outcome: r.outcome, status: r.status, message: r.message,
  requestId: r.request_id, ip: r.ip,
});

/** `%` and `_` in a search are the characters themselves, and so is the escape character. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function matching(f: AuditFilter): SQL {
  const parts: SQL[] = [sql`at >= ${f.fromAt}`, sql`at < ${f.toAt}`];
  if (f.actor !== undefined) parts.push(sql`actor_id = ${f.actor}`);
  if (f.role !== undefined) parts.push(sql`actor_role = ${f.role}`);
  // D9: where the person worked or where the target belongs.
  if (f.loc !== undefined) parts.push(sql`(actor_loc = ${f.loc} or target_loc = ${f.loc})`);
  if (f.actions !== undefined) parts.push(f.actions.length > 0 ? sql`action = any(${sql.param(f.actions)}::text[])` : sql`false`);
  if (f.outcome !== undefined) parts.push(sql`outcome = ${f.outcome}`);
  if (f.q !== undefined) {
    const like = `%${escapeLike(f.q)}%`;
    parts.push(sql`(target ilike ${like} escape '\\' or message ilike ${like} escape '\\' or actor_name ilike ${like} escape '\\' or actor_emp ilike ${like} escape '\\')`);
  }
  return sql.join(parts, sql` and `);
}

export const auditRepo = {
  /** Newest first by id, keyset on `before`. One row past the page says whether there is a next. */
  async page(db: Reader, f: AuditFilter): Promise<{ rows: AuditRow[]; next: number | null }> {
    const cursor = f.before === undefined ? sql`` : sql` and id < ${f.before}`;
    const { rows } = await db.execute(sql`select ${ROW_COLUMNS} from events where ${matching(f)}${cursor} order by id desc limit ${f.limit + 1}`);
    const records = rows as RowRecord[];
    const more = records.length > f.limit;
    const page = (more ? records.slice(0, f.limit) : records).map(toRow);
    return { rows: page, next: more ? page[page.length - 1].id : null };
  },

  /** Over the whole filter, never the page (no `before`, no `limit`). A person is their user id, or
   *  the typed employee number of a sign-in nobody could be matched to. */
  async counts(db: Reader, f: AuditFilter): Promise<AuditCounts> {
    const { rows } = await db.execute(sql`
      select count(*)::int as events,
             count(distinct coalesce(actor_id, actor_emp))::int as people,
             count(*) filter (where outcome <> 'done')::int as refused,
             count(*) filter (where action = 'login' and outcome = 'refused')::int as failed_sign_ins
      from events where ${matching(f)}`);
    const r = rows[0] as { events: number; people: number; refused: number; failed_sign_ins: number };
    return { events: r.events, people: r.people, refused: r.refused, failedSignIns: r.failed_sign_ins };
  },

  async entry(db: Reader, id: number): Promise<AuditEntry | null> {
    const { rows } = await db.execute(sql`
      select ${ROW_COLUMNS}, method, path, cause, request, before, result, changed, user_agent
      from events where id = ${id}`);
    const r = rows[0] as EntryRecord | undefined;
    if (!r) return null;
    return {
      ...toRow(r), method: r.method, path: r.path, cause: r.cause,
      request: r.request, before: r.before, result: r.result, changed: r.changed, userAgent: r.user_agent,
    };
  },
};
```

Create `apps/audit/src/modules/audit/service.ts`:

```ts
// service.ts: the flow. A filter in the operator's terms (IST days, an area of the hospital)
// becomes one in the log's terms (instants, action names) here, and nowhere else.
import { actionsInGroup, type AuditEntry, type AuditPage, type AuditQuery } from "@rch/contract";
import type { Db } from "../../db/client.js";
import { withReadTransaction } from "../../lib/db.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { istDay, istDayStart, nextIstDay } from "../../lib/time.js";
import { auditRepo, type AuditFilter } from "./repo.js";

function dayStart(day: string): Date {
  const start = istDayStart(day);
  if (!start) throw new ValidationError(`There is no day ${day} on the calendar.`);
  return start;
}

/**
 * - `to` defaults to today in Asia/Kolkata, and `from` defaults to `to`: nothing asked for is today,
 *   a lone `to` is that one day, and a lone `from` runs through today.
 * - `to` is inclusive: the filter ends at the IST midnight after it.
 * - `group` is the set of actions `AUDIT_LABELS` files under it; with `action` as well the two
 *   intersect, so an action outside the area finds nothing rather than widening it.
 */
function toFilter(q: AuditQuery): AuditFilter {
  const to = q.to ?? istDay(new Date());
  const from = q.from ?? to;
  const fromAt = dayStart(from);
  const toStart = dayStart(to);
  if (fromAt.getTime() > toStart.getTime()) throw new ValidationError(`The period cannot start on ${from}, after it ends on ${to}.`);
  let actions = q.group ? actionsInGroup(q.group) : undefined;
  if (q.action) actions = actions ? actions.filter((a) => a === q.action) : [q.action];
  const text = q.q?.trim();
  return {
    fromAt, toAt: nextIstDay(toStart),
    actor: q.actor, role: q.role, loc: q.loc, actions, outcome: q.outcome,
    q: text ? text : undefined, before: q.before, limit: q.limit,
  };
}

export function createAuditService(db: Db) {
  return {
    /** The page and the counts over the whole filter, in one read-only transaction: one connection,
     *  queries awaited one after the other. */
    async list(q: AuditQuery): Promise<AuditPage> {
      const f = toFilter(q);
      return withReadTransaction(db, async (tx) => {
        const { rows, next } = await auditRepo.page(tx, f);
        const counts = await auditRepo.counts(tx, f);
        return { rows, next, counts };
      });
    },

    async entry(id: number): Promise<AuditEntry> {
      const entry = await auditRepo.entry(db, id);
      if (!entry) throw new NotFoundError(`There is no audit entry ${id}.`);
      return entry;
    },
  };
}
```

Create `apps/audit/src/modules/audit/routes.ts`:

```ts
// routes.ts: parse, call the service, reply. The admin gate is attached by `mount()`.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createAuditService } from "./service.js";

export default fp(async (app) => {
  const svc = createAuditService(app.db);
  mount(app, routes.auditLog, async (req) => svc.list(req.query));
  mount(app, routes.auditEntry, async (req) => svc.entry(req.params.id));
}, { name: "module:audit", dependencies: ["auth", "db"] });
```

Replace `apps/audit/src/app.ts` with this: Task 11's version, plus the auth plugin and the audit module registered last.

```ts
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { AuditConfig } from "./config.js";
import type { Db } from "./db/client.js";
import logging, { genReqId, loggerOptions, type LogStream } from "./plugins/logging.js";
import errors from "./plugins/errors.js";
import metrics from "./plugins/metrics.js";
import health from "./plugins/health.js";
import security from "./plugins/security.js";
import db from "./plugins/db.js";
import drainer from "./plugins/drainer.js";
import auth from "./plugins/auth.js";
import auditModule from "./modules/audit/routes.js";

declare module "fastify" { interface FastifyInstance { config: AuditConfig } }

export type AuditApp = FastifyInstance;
/**
 * - `db` + `pool`: a handle the caller owns (the test harness); otherwise the db plugin opens one on
 *   `searchPath`, which defaults to `config.auditSchema`.
 * - `logStream`: where the log goes when it is not stdout - a test reading its own lines back.
 * - `drainer`: whether `plugins/drainer.ts` starts its LISTEN client, poll timer and first pass
 *   (default on); a test that drives a pass by hand passes `false`.
 * - `cleanup`: run once the app has closed, after every plugin's own `onClose` - the test harness
 *   drops its schemas there.
 */
export type AppDeps = { db?: Db; pool?: Pool; searchPath?: string; logStream?: LogStream; drainer?: boolean; cleanup?: () => Promise<void> };

export async function buildApp(config: AuditConfig, deps: AppDeps = {}): Promise<AuditApp> {
  const app = Fastify({
    logger: loggerOptions(config.logLevel, deps.logStream),
    genReqId,
    trustProxy: config.trustProxy,
    // Every route is a GET; nothing this service accepts has a body worth more than a header.
    bodyLimit: 64 * 1024,
    forceCloseConnections: "idle",
    logController: new LogController({ disableRequestLogging: true }),
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
  }).withTypeProvider<ZodTypeProvider>();
  // The first onClose hook added is the last to run (avvio runs them newest first), so a caller's
  // cleanup comes after every plugin has let go of the pool.
  const cleanup = deps.cleanup;
  if (cleanup) app.addHook("onClose", async () => { await cleanup(); });
  app.decorate("config", config);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(logging);
  await app.register(errors);
  await app.register(metrics);
  await app.register(health);
  await app.register(security);
  await app.register(db, { url: config.databaseUrl, ssl: config.databaseSsl, max: config.dbPoolMax, searchPath: deps.searchPath ?? config.auditSchema, auditSchema: config.auditSchema, db: deps.db, pool: deps.pool });
  await app.register(drainer, { enabled: deps.drainer ?? true });
  await app.register(auth);
  await app.register(auditModule);
  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run src/lib/time.test.ts src/modules/audit/audit.test.ts`
Expected: PASS (3 + 30 tests)
Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit exec vitest run`
Expected: PASS. This covers the whole audit suite, including Task 9's `app.test.ts` (an unknown `/api/v1/admin/nope` is still the not-found envelope) and `errors.test.ts`.
Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit typecheck && pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log --filter @rch/audit lint`
Expected: PASS, 0 warnings

- [ ] **Step 5: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add apps/audit/src/lib/db.ts apps/audit/src/lib/time.ts apps/audit/src/lib/time.test.ts apps/audit/src/plugins/auth.ts apps/audit/src/routes.ts apps/audit/src/modules/audit/repo.ts apps/audit/src/modules/audit/service.ts apps/audit/src/modules/audit/routes.ts apps/audit/src/modules/audit/audit.test.ts apps/audit/src/app.ts
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Serve the audit log to the super admin with filters, counts and paging

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

## Part 6 - UI (Tasks 13 and 14)

#### Interface additions

These extend the Shared Interfaces. Nothing existing is renamed.

This part relies on decision D4: `AuditRow` carries `ip` and `requestId`, and `AuditEntry` inherits them.
The CSV reads both from list rows, and the tests build `AuditRow` literals with both fields.

- **`UI/src/lib/fmt.ts`:**
  - `fromWireSeconds(iso: string): string` gives the IST `"HH:MM:SS"`.
  - `fromWireStamp(iso: string): string` gives the IST `"YYYY-MM-DD HH:MM:SS"` for the CSV.
  - Both use a formatter built once at module level. Building an `Intl.DateTimeFormat` on every call made
    a 50,000-row export take 6 s in Node, against 0.3 s with a cached one.
- **`UI/src/lib/audit.ts`:**
  - `AUDIT_OUTCOME_LABEL: Record<AuditOutcome, string>`
  - `AUDIT_OUTCOME_TONE: Record<AuditOutcome, Tone>`
  - `AUDIT_ROLE_LABELS` (readonly tuple of the six stored role words)
  - `AUDIT_PLACES: Record<LocKey, string>`
  - `placeOf(loc: string): string`
- **`UI/src/store/audit.ts`:**
  - `initialAudit(): AuditSlice["audit"]`, used by the slice and by `__tests__/fixture.ts`'s `resetStore`.
  - `createAuditSlice(set, get): AuditSlice`, merged in `store/index.ts` like `createAdminSlice`. It takes
    `set` because, unlike the other slices, it has no `wire.ts` mapper to write through.
  - `AuditSlice` is written as an `interface` with arrow-typed members, like the other slices. It has the
    same names and types as the Shared Interfaces block.

#### Notes

The worktree is rebased onto develop 609befb, and every anchor below was re-read there. The recipes slice and
its `refetch` reader are gone. `f736565` moved explanations into `tip` props (`ui/Tip.tsx`), so this tab
follows that convention:

- The page sentence is `PageHead`'s `tip`.
- The KPI captions are `Kpi` tips.
- The export button and two drawer sections carry tips.
- Counts, errors and the outage `Alert` stay visible.

1. **Location list.** An admin session loads no snapshot, so `LOC` is empty on `/admin`. `AdminUsers` and
   `AdminSupport` each already keep a static `LOC_LABEL` display map in production code (not from
   fixtures). This part adds a third copy as `AUDIT_PLACES` in `lib/audit.ts`. Merging the three is a
   follow-up and out of scope here.
2. **Drawer host.** `ui/Drawer.tsx`'s host is mounted only inside `ui/Shell.tsx`, and the admin page never
   gets a `Shell`. Task 14 mounts `<Drawer />` in `AdminDashboard.tsx`, after `.adm-body`.
3. **`bare.test.tsx`** renders no admin page today. Task 14 adds one case for the tab on an empty log.
4. **The new `audit` collection breaks nothing in the UI.** `NARROW` is
   `Partial<Record<Changed, …>>` and no other UI file enumerates `CollectionSchema`. Task 13 still adds
   the reader, so an `audit` notice never falls through to `loadSnapshot`.
5. **`loadMoreAudit` keeps the first page's `counts`.** Otherwise "Load more" would change the KPI figures
   underneath the admin, which breaks "the list never moves by itself".
6. **"Everything by this person" when the account is unknown.** A sign-in attempt with an unknown id has
   `actor.id === null`, so this link searches `q = actor.emp` instead of setting `actor`. Both drawer links
   keep the period and clear every other filter.
7. **D20 edge case.** D20 does not say how to compare a plain object two levels deep. `diffFields` compares
   it by JSON, the same as an array. Strict equality would report every such object as changed, because
   two parsed objects are never `===`.
8. **Docs for Task 19.** These `UI/CLAUDE.md` statements at 609befb become false with this part:
    - "That page has two tabs"
    - the Commands line "proxying /api → http://localhost:3000" (there is now a second proxy entry)
    - "Some reads have no notify and no refetch", whose list gains `loadAudit`, `loadMoreAudit`,
      `readAuditEntry` and `exportAudit`
    - "`tickets` is the one reader that branches" (`audit` branches on admin too)
    - the list of slices merged into the store, which gains `audit.ts`

    `UI/README.md` also needs the Audit log tab and the new test file.

---

### Task 13: Audit lib and store slice

**Files:**
- Create: `UI/src/lib/audit.ts`
- Create: `UI/src/store/audit.ts`
- Modify: `UI/src/lib/fmt.ts`
- Modify: `UI/src/store/index.ts`
- Modify: `UI/src/api/refetch.ts`
- Modify: `UI/vite.config.ts`
- Modify: `UI/src/__tests__/fixture.ts`
- Test: `UI/src/__tests__/audit-lib.test.ts` (create)
- Test: `UI/src/__tests__/writes.test.ts` (modify: append a describe block)

**Interfaces:**
- Consumes, all from Task 1 through `@rch/contract`:
  - values `routes.auditLog`, `routes.auditEntry`, `AUDIT_GROUPS`, `auditLabelOf`
  - types `AuditRow` (with `ip` / `requestId`, per D4), `AuditEntry`, `AuditPage`, `AuditCounts`,
    `AuditGroup`, `AuditOutcome`
  - `"audit"` in `Changed`
- Consumes, from the existing UI:
  - `istDate` from `@rch/domain`, `call` from `api/client`, `useApp`
  - `Tone` and `LocKey` from `UI/src/types.ts`
- Produces (used by Task 14):
  - `UI/src/lib/audit.ts`: `AuditPeriod`, `auditDayRange`, `deviceOf`, `diffFields`, `auditCsv`,
    `AUDIT_OUTCOME_LABEL`, `AUDIT_OUTCOME_TONE`, `AUDIT_ROLE_LABELS`, `AUDIT_PLACES`, `placeOf`
  - `UI/src/lib/fmt.ts`: `fromWireSeconds`, `fromWireStamp`
  - `UI/src/store/audit.ts`: `AuditFilter`, `AuditSlice`, `initialAudit`, `createAuditSlice`
  - store members `audit`, `loadAudit`, `loadMoreAudit`, `readAuditEntry`, `exportAudit`, `bumpAuditFresh`
  - `refetch(["audit"])`: an admin session calls `bumpAuditFresh()`; any other session does nothing
  - Vite dev proxy `/api/v1/admin/audit` → `http://localhost:3100`

- [ ] **Step 1: Write the failing tests**

Create `UI/src/__tests__/audit-lib.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AUDIT_GROUPS, auditLabelOf } from "@rch/contract";
import {
  AUDIT_ROLE_LABELS, auditCsv, auditDayRange, deviceOf, diffFields, placeOf,
} from "../lib/audit";
import { fromWireSeconds, fromWireStamp } from "../lib/fmt";
import type { AuditRow } from "../types";

/**
 * The audit log's pure helpers. This suite runs with TZ=UTC, so every day and clock below is
 * the hospital's (Asia/Kolkata) only because the helpers make it so: 18:30 UTC is IST midnight.
 */

const NOTHING = { from: "", to: "" };
const LAST_SECOND_OF_13TH = new Date("2026-09-13T18:29:59.000Z");   // 23:59:59 on the 13th in IST
const MIDNIGHT_14TH = new Date("2026-09-13T18:30:00.000Z");         // 00:00:00 on the 14th in IST

describe("auditDayRange", () => {
  it("names today by the hospital's midnight, not the host's", () => {
    expect(auditDayRange("today", NOTHING, LAST_SECOND_OF_13TH)).toEqual({ from: "2026-09-13", to: "2026-09-13" });
    expect(auditDayRange("today", NOTHING, MIDNIGHT_14TH)).toEqual({ from: "2026-09-14", to: "2026-09-14" });
  });

  it("counts 7 and 30 days back, today included", () => {
    expect(auditDayRange("7d", NOTHING, MIDNIGHT_14TH)).toEqual({ from: "2026-09-08", to: "2026-09-14" });
    expect(auditDayRange("30d", NOTHING, MIDNIGHT_14TH)).toEqual({ from: "2026-08-16", to: "2026-09-14" });
    expect(auditDayRange("30d", NOTHING, LAST_SECOND_OF_13TH)).toEqual({ from: "2026-08-15", to: "2026-09-13" });
  });

  it("takes a custom range as typed, fills a missing end from the other, and turns a backwards one round", () => {
    expect(auditDayRange("custom", { from: "2026-09-01", to: "2026-09-10" }, MIDNIGHT_14TH)).toEqual({ from: "2026-09-01", to: "2026-09-10" });
    expect(auditDayRange("custom", { from: "2026-09-01", to: "" }, MIDNIGHT_14TH)).toEqual({ from: "2026-09-01", to: "2026-09-01" });
    expect(auditDayRange("custom", { from: "", to: "2026-09-05" }, MIDNIGHT_14TH)).toEqual({ from: "2026-09-05", to: "2026-09-05" });
    expect(auditDayRange("custom", { from: "2026-09-10", to: "2026-09-01" }, MIDNIGHT_14TH)).toEqual({ from: "2026-09-01", to: "2026-09-10" });
    expect(auditDayRange("custom", NOTHING, MIDNIGHT_14TH)).toEqual({ from: "2026-09-14", to: "2026-09-14" });
  });
});

describe("the audit log's clock", () => {
  it("prints an instant to the second in IST, and as one sortable cell for a spreadsheet", () => {
    expect(fromWireSeconds("2026-09-13T18:30:05.000Z")).toBe("00:00:05");
    expect(fromWireSeconds("2026-09-14T04:12:09.000Z")).toBe("09:42:09");
    expect(fromWireStamp("2026-09-13T18:30:05.000Z")).toBe("2026-09-14 00:00:05");
    expect(fromWireStamp("2026-09-13T18:29:59.000Z")).toBe("2026-09-13 23:59:59");
    expect(fromWireStamp("not a time")).toBe("not a time");
  });
});

describe("deviceOf", () => {
  const cases: [ua: string, device: string][] = [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36", "Chrome on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.42", "Edge on Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "Firefox on Linux"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15", "Safari on macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1", "Safari on iOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1", "Chrome on iOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15", "Firefox on iOS"],
    ["Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36", "Samsung Internet on Android"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.2739.60", "Edge on Android"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36", "Chrome on ChromeOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) SomeTool/1.0", "Unknown browser on Windows"],
    ["curl/8.7.1", "Unknown device"],
    ["", "Unknown device"],
  ];
  for (const [ua, device] of cases) {
    it(device + (ua ? "" : " (no user agent)"), () => { expect(deviceOf(ua)).toBe(device); });
  }
});

describe("diffFields", () => {
  it("names only the fields the edit changed, comparing lists by their contents", () => {
    expect(diffFields(
      { mrp: 50, cost: 30, n: "Orange juice", groups: ["a", "b"] },
      { c: "juice", mrp: 45, cost: 30, n: "Orange juice", groups: ["a", "b"], u: "nos" },
    )).toEqual([{ field: "mrp", before: 50, after: 45 }]);
    expect(diffFields({ groups: ["a"] }, { groups: ["a", "b"] })).toEqual([{ field: "groups", before: ["a"], after: ["a", "b"] }]);
  });

  it("looks one level into a nested object and names what changed there by its path", () => {
    expect(diffFields(
      { item: { cost: 30, n: "Juice", tags: ["cold"], unit: { u: "nos" } } },
      { item: { cost: 35, n: "Juice", tags: ["cold"], unit: { u: "nos" } }, extra: 1 },
    )).toEqual([{ field: "item.cost", before: 30, after: 35 }]);
  });

  it("compares everything else strictly, so null against a missing field is a change", () => {
    expect(diffFields({ note: null }, {})).toEqual([{ field: "note", before: null, after: undefined }]);
    expect(diffFields({ item: { cost: 30 } }, { item: null })).toEqual([{ field: "item", before: { cost: 30 }, after: null }]);
  });

  it("has nothing to compare unless both sides are plain objects", () => {
    expect(diffFields(null, { a: 1 })).toEqual([]);
    expect(diffFields({ a: 1 }, null)).toEqual([]);
    expect(diffFields([1], [2])).toEqual([]);
  });
});

describe("places and roles", () => {
  it("prints a stored location by name, an unknown one as stored, and none as a hyphen", () => {
    expect(placeOf("coffee")).toBe("Coffee Shop");
    expect(placeOf("quarantine")).toBe("quarantine");
    expect(placeOf("")).toBe("-");
  });

  it("offers exactly the role words an event is stored with", () => {
    expect(AUDIT_ROLE_LABELS).toEqual(["Counter Operator", "Outlet Manager", "Store Keeper", "Kitchen In-charge", "Procurement Officer", "Super Admin"]);
  });
});

describe("auditCsv", () => {
  const row = (over: Partial<AuditRow> = {}): AuditRow => ({
    id: 1, at: "2026-09-13T18:30:05.000Z",
    actor: { id: "u2", emp: "RC-3120", name: "Ramesh Kumar", role: "Outlet Manager", loc: "rest" },
    action: "savePrice", target: "A:juice", targetLoc: "", outcome: "done", status: 200,
    message: "Price saved", ip: "10.0.0.7", requestId: "req-1", ...over,
  });

  it("writes the header, one line per event with its IST time, and CRLF line ends", () => {
    const lines = auditCsv([row()]).split("\r\n");
    expect(lines[0]).toBe("at (IST),emp,name,role,location,area,action,target,outcome,status,message,ip,request id");
    const { label, group } = auditLabelOf("savePrice", "done");
    expect(lines[1]).toBe(
      `2026-09-14 00:00:05,RC-3120,Ramesh Kumar,Outlet Manager,rest,${group ? AUDIT_GROUPS[group] : ""},${label},A:juice,Done,200,Price saved,10.0.0.7,req-1`,
    );
    expect(lines).toEqual([lines[0], lines[1], ""]);
    expect(auditCsv([])).toBe("at (IST),emp,name,role,location,area,action,target,outcome,status,message,ip,request id\r\n");
  });

  it("quotes commas, quotes and line breaks the RFC 4180 way, and never hands a spreadsheet a formula", () => {
    const csv = auditCsv([row({
      action: "login", outcome: "refused", status: 401,
      actor: { id: null, emp: "RC-9,9", name: "", role: "", loc: "" },
      target: '=HYPERLINK("x")',
      message: 'Refused - the "A" list, above MRP\nsee the note',
    })]);
    const body = csv.slice(csv.indexOf("\r\n") + 2);
    expect(body).toContain('"RC-9,9"');
    expect(body).toContain(`"'=HYPERLINK(""x"")"`);
    expect(body).toContain('"Refused - the ""A"" list, above MRP\nsee the note"');
    expect(body).toContain(",Failed sign-in,");
    expect(body).toContain(",Refused,401,");
  });
});
```

Modify `UI/src/__tests__/fixture.ts`. Replace

```ts
import { basePrices } from "../lib/selectors";
```

with

```ts
import { basePrices } from "../lib/selectors";
import { initialAudit } from "../store/audit";
```

and replace

```ts
    accounts: [], adminActions: [], deskTickets: [],
  });
```

with

```ts
    accounts: [], adminActions: [], deskTickets: [],
    // ---- audit log: the tab's list, filter and pill count, back to a first visit's.
    audit: initialAudit(),
  });
```

Modify `UI/src/__tests__/writes.test.ts`. Replace

```ts
import { creditBreachMessage } from "@rch/domain";
```

with

```ts
import { creditBreachMessage, istDate } from "@rch/domain";
```

replace

```ts
import type { AppState } from "../store";
```

with

```ts
import type { AppState } from "../store";
import type { AuditFilter } from "../store/audit";
import type { AuditCounts, AuditEntry, AuditRow } from "../types";
```

and append at the end of the file:

```ts

// ---- audit log
describe("audit log reads", () => {
  const LOG = "/api/v1/admin/audit";
  const COUNTS: AuditCounts = { events: 3, people: 2, refused: 1, failedSignIns: 1 };
  const TODAY: AuditFilter = { period: "today", from: "", to: "" };
  const auditRow = (id: number): AuditRow => ({
    id, at: "2026-09-14T04:12:09.000Z",
    actor: { id: "u2", emp: "RC-3120", name: "Ramesh Kumar", role: "Outlet Manager", loc: "rest" },
    action: "savePrice", target: "A:juice", targetLoc: "", outcome: "done", status: 200,
    message: "Price saved", ip: "10.0.0.7", requestId: `req-${id}`,
  });
  /** Every query one path was read with, in order, as plain objects. */
  const queried = (path: string) =>
    fetchMock.mock.calls
      .map(([u]) => new URL(String(u), "http://rch.test"))
      .filter((u) => u.pathname === path)
      .map((u) => Object.fromEntries(u.searchParams));
  /** A log of `total` events, newest id first, paged the way the audit service pages it: rows
   *  below `before`, `limit` at a time, and `next` the last id whenever more remain. */
  const pagedLog = (total: number) => (u: string): Response => {
    const params = new URL(u, "http://rch.test").searchParams;
    const top = Math.min(Number(params.get("before") ?? total + 1) - 1, total);
    const size = Math.max(0, Math.min(Number(params.get("limit") ?? 100), top));
    const ids = Array.from({ length: size }, (_, i) => top - i);
    const last = ids.at(-1);
    return json({ rows: ids.map(auditRow), next: last !== undefined && last > 1 ? last : null, counts: COUNTS });
  };

  beforeEach(() => {
    as("manager");
    useApp.setState({ user: { ...S().user!, admin: true } });
  });

  it("sends only the filters that are set, as IST days, and keeps the page without a toast", async () => {
    const PAGE = { rows: [auditRow(43), auditRow(42)], next: 42, counts: COUNTS };
    serve({ "GET /api/v1/admin/audit": () => json(PAGE) });
    const filter: AuditFilter = {
      period: "custom", from: "2026-09-01", to: "2026-09-10",
      actor: "u2", role: "", loc: "coffee", group: "sales", outcome: "refused", q: "  CF/11 ",
    };
    expect(await S().loadAudit(filter)).toEqual(PAGE);
    expect(queried(LOG)).toEqual([{ from: "2026-09-01", to: "2026-09-10", actor: "u2", loc: "coffee", group: "sales", outcome: "refused", q: "CF/11" }]);
    expect(S().audit).toEqual({ rows: PAGE.rows, next: 42, counts: COUNTS, filter, fresh: 0, status: "ready" });
    expect(S().toast).toBeNull();

    await S().loadAudit(TODAY);
    const today = istDate(new Date());
    expect(queried(LOG).at(-1)).toEqual({ from: today, to: today });
  });

  it("reads the next page before the last id it has, and appends it under the first page's counts", async () => {
    fetchMock.mockImplementation((u: string) => Promise.resolve(json(new URL(u, "http://rch.test").searchParams.has("before")
      ? { rows: [auditRow(41)], next: null, counts: { ...COUNTS, events: 99 } }
      : { rows: [auditRow(43), auditRow(42)], next: 42, counts: COUNTS })));
    await S().loadAudit(TODAY);
    await S().loadMoreAudit();
    expect(queried(LOG)[1]).toMatchObject({ before: "42" });
    expect(S().audit.rows.map((r) => r.id)).toEqual([43, 42, 41]);
    expect(S().audit.next).toBeNull();
    expect(S().audit.counts).toEqual(COUNTS);
    // Nothing further to ask for.
    expect(await S().loadMoreAudit()).toBeNull();
    expect(queried(LOG)).toHaveLength(2);
  });

  it("answers null on every failed read with no toast, and never turns an outage into an empty log", async () => {
    serve({ "GET /api/v1/admin/audit": () => json({ rows: [auditRow(43)], next: 43, counts: COUNTS }) });
    await S().loadAudit(TODAY);
    serve({});                                                  // every read now answers 500
    expect(await S().loadMoreAudit()).toBeNull();
    expect(S().audit.rows.map((r) => r.id)).toEqual([43]);      // a failed next page keeps what is shown
    expect(await S().loadAudit()).toBeNull();
    expect(S().audit).toMatchObject({ rows: [], next: null, counts: null, status: "failed" });
    expect(await S().readAuditEntry(43)).toBeNull();
    expect(await S().exportAudit(TODAY)).toBeNull();
    expect(S().toast).toBeNull();
  });

  it("reads one whole entry by id", async () => {
    const entry: AuditEntry = {
      ...auditRow(43), method: "PUT", path: "/prices/A/juice", cause: null,
      request: { params: { list: "A", it: "juice" }, query: {}, body: { price: 45 } },
      before: { price: 50 }, result: { list: "A", it: "juice", price: 45 }, changed: ["prices"], userAgent: "",
    };
    serve({ "GET /api/v1/admin/audit/43": () => json(entry) });
    expect(await S().readAuditEntry(43)).toEqual(entry);
  });

  it("keeps the newest filter's answer when an older read lands after it", async () => {
    const answers: ((r: Response) => void)[] = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { answers.push(resolve); }));
    const older = S().loadAudit(TODAY);
    const newer = S().loadAudit({ period: "7d", from: "", to: "" });
    await vi.waitFor(() => { expect(answers).toHaveLength(2); });
    answers[1](json({ rows: [auditRow(9)], next: null, counts: COUNTS }));
    await newer;
    answers[0](json({ rows: [auditRow(1)], next: null, counts: COUNTS }));
    await older;
    expect(S().audit.rows.map((r) => r.id)).toEqual([9]);
    expect(S().audit.filter.period).toBe("7d");
    expect(S().audit.status).toBe("ready");
  });

  it("exports page by page, 500 at a time, until the log runs out", async () => {
    fetchMock.mockImplementation((u: string) => Promise.resolve(pagedLog(1203)(u)));
    const out = await S().exportAudit(TODAY);
    expect(queried(LOG).map((q) => [q.before, q.limit])).toEqual([[undefined, "500"], ["704", "500"], ["204", "500"]]);
    expect(out).toMatchObject({ rows: 1203, capped: false });
    // The header, 1,203 lines, and the empty string after the last line break.
    expect(out!.csv.split("\r\n")).toHaveLength(1205);
    // An export is not the list on screen.
    expect(S().audit.rows).toEqual([]);
  });

  it("stops at 50,000 rows and says it did, but not when the log is exactly that long", async () => {
    fetchMock.mockImplementation((u: string) => Promise.resolve(pagedLog(60_000)(u)));
    expect(await S().exportAudit(TODAY)).toMatchObject({ rows: 50_000, capped: true });
    expect(queried(LOG)).toHaveLength(100);

    fetchMock.mockReset();
    fetchMock.mockImplementation((u: string) => Promise.resolve(pagedLog(50_000)(u)));
    expect(await S().exportAudit(TODAY)).toMatchObject({ rows: 50_000, capped: false });
    expect(queried(LOG)).toHaveLength(100);
  });

  it("counts an audit notice on an admin session without reading anything, ignores it elsewhere, and a load clears the count", async () => {
    await refetch(["audit"]);
    await refetch(["audit"]);
    expect(S().audit.fresh).toBe(2);

    useApp.setState({ user: { ...S().user!, admin: false } });
    await refetch(["audit"]);
    expect(S().audit.fresh).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(S().toast).toBeNull();

    useApp.setState({ user: { ...S().user!, admin: true } });
    serve({ "GET /api/v1/admin/audit": () => json({ rows: [], next: null, counts: COUNTS }) });
    await S().loadAudit();
    expect(S().audit.fresh).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @rch/ui exec vitest run src/__tests__/audit-lib.test.ts src/__tests__/writes.test.ts`
Expected: FAIL. Both files fail to load with `Failed to resolve import "../lib/audit"` (audit-lib.test.ts) and `Failed to resolve import "../store/audit"` (writes.test.ts through fixture.ts).

- [ ] **Step 3: Implement**

Create `UI/src/lib/audit.ts`:

```ts
import { AUDIT_GROUPS, auditLabelOf } from "@rch/contract";
import { istDate } from "@rch/domain";
import { fromWireStamp } from "./fmt";
import type { AuditOutcome, AuditRow, LocKey, Tone } from "../types";

/**
 * The audit log's browser-side helpers (spec 5.2): the IST days a period stands for, the device a
 * user agent names, what an edit changed, and the CSV an export hands over. All pure, so the
 * suite drives each one without rendering the tab.
 */

export type AuditPeriod = "today" | "7d" | "30d" | "custom";

const DAY_MS = 86_400_000;
const WIRE_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** `n` hospital days before `day`. India keeps no daylight saving, so a day is always 24 hours. */
const daysBefore = (day: string, n: number): string =>
  istDate(new Date(Date.parse(`${day}T00:00:00+05:30`) - n * DAY_MS));

/**
 * The IST days a period covers, as the `from` / `to` the audit service takes. "Today" is the
 * hospital's today (`istDate`), not the host's, and "7 days" is today and the six before it. A
 * custom range takes what was typed: a missing end is the other end, nothing typed is today, and
 * a range typed backwards is turned the right way round rather than refused.
 */
export function auditDayRange(
  period: AuditPeriod, custom: { from: string; to: string }, now: Date = new Date(),
): { from: string; to: string } {
  const today = istDate(now);
  if (period === "today") return { from: today, to: today };
  if (period === "7d") return { from: daysBefore(today, 6), to: today };
  if (period === "30d") return { from: daysBefore(today, 29), to: today };
  const typed = (d: string) => (WIRE_DAY.test(d) ? d : null);
  const from = typed(custom.from) ?? typed(custom.to) ?? today;
  const to = typed(custom.to) ?? from;
  return from <= to ? { from, to } : { from: to, to: from };
}

/* Order matters in both tables: Edge and Samsung Internet also say "Chrome", Chrome and Firefox
   on iOS also say "Safari", an iPad says "like Mac OS X", and Android and ChromeOS say "Linux". */
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|CriOS|Chromium)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];
const SYSTEMS: [RegExp, string][] = [
  [/\bWindows\b/, "Windows"],
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];
const firstMatch = (ua: string, table: [RegExp, string][]): string | null =>
  table.find(([re]) => re.test(ua))?.[1] ?? null;

/** "Chrome on Windows", from the user agent an event was sent with. No dependency: an audit log
 *  needs the family and the platform, not the version. */
export function deviceOf(userAgent: string): string {
  const browser = firstMatch(userAgent, BROWSERS);
  const system = firstMatch(userAgent, SYSTEMS);
  if (browser && system) return `${browser} on ${system}`;
  if (browser) return browser;
  if (system) return `Unknown browser on ${system}`;
  return "Unknown device";
}

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);
/** One stored value against another. A list, or an object below the level `diffFields` opens,
 *  is compared by its JSON, so lines saved unchanged are not reported as an edit. Anything else
 *  is compared strictly: `null` and a missing field are two different values. */
const same = (a: unknown, b: unknown): boolean =>
  a === b
  || (typeof a === "object" && typeof b === "object" && a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));

/**
 * The fields an edit changed: every field `before` holds whose value differs from the same field
 * of `after`. Where both sides of a field are plain objects, it looks one level in and names each
 * changed field by its path ("item.cost"). `before` carries only what the edit could alter
 * (`auditBefore` on the server), so the document's other fields, which `after` also carries, are
 * never reported. Anything that is not a plain object on both sides has nothing to compare.
 */
export function diffFields(before: unknown, after: unknown): Array<{ field: string; before: unknown; after: unknown }> {
  if (!isPlain(before) || !isPlain(after)) return [];
  const changed: Array<{ field: string; before: unknown; after: unknown }> = [];
  for (const [field, was] of Object.entries(before)) {
    const now = after[field];
    if (isPlain(was) && isPlain(now)) {
      for (const [inner, innerWas] of Object.entries(was)) {
        if (!same(innerWas, now[inner])) changed.push({ field: `${field}.${inner}`, before: innerWas, after: now[inner] });
      }
    } else if (!same(was, now)) {
      changed.push({ field, before: was, after: now });
    }
  }
  return changed;
}

/** An outcome's printed word and pill tone: the table, the drawer and the CSV all use these. */
export const AUDIT_OUTCOME_LABEL: Record<AuditOutcome, string> = { done: "Done", refused: "Refused", error: "Error" };
export const AUDIT_OUTCOME_TONE: Record<AuditOutcome, Tone> = { done: "ok", refused: "wn", error: "cr" };

/** The role words an event is stored with: the account's role label, or "Super Admin" for the
 *  flagged account (`roleLabelOf`, apps/api/src/lib/wire.ts). The Role filter sends exactly these. */
export const AUDIT_ROLE_LABELS = [
  "Counter Operator", "Outlet Manager", "Store Keeper", "Kitchen In-charge", "Procurement Officer", "Super Admin",
] as const;

/** Place names for the admin page. It loads no snapshot, so there is no `LOC` registry to read.
 *  This is the same display map `AdminUsers` and `AdminSupport` keep. */
export const AUDIT_PLACES: Record<LocKey, string> = {
  store: "Central Store", kitchen: "Central Kitchen", rest: "Restaurant", coffee: "Coffee Shop", kiosk: "Snack Kiosk",
};
/** A stored location as its name. An unknown one prints as stored, and none at all as "-". */
export const placeOf = (loc: string): string =>
  loc === "" ? "-" : Object.hasOwn(AUDIT_PLACES, loc) ? AUDIT_PLACES[loc as LocKey] : loc;

const CSV_HEADER = ["at (IST)", "emp", "name", "role", "location", "area", "action", "target", "outcome", "status", "message", "ip", "request id"];

/** One RFC 4180 field. Text that a spreadsheet would run as a formula gets a leading apostrophe,
 *  because the log carries what people typed: a vendor name, a note, an employee id. */
const csvCell = (v: string | number): string => {
  if (typeof v === "number") return String(v);
  const text = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** The export: a header, then one CRLF-terminated line per event, time in IST. */
export function auditCsv(rows: AuditRow[]): string {
  const lines = rows.map((r) => {
    const { label, group } = auditLabelOf(r.action, r.outcome);
    return [
      fromWireStamp(r.at), r.actor.emp, r.actor.name, r.actor.role, r.actor.loc,
      group ? AUDIT_GROUPS[group] : "", label, r.target, AUDIT_OUTCOME_LABEL[r.outcome],
      r.status, r.message, r.ip, r.requestId,
    ].map(csvCell).join(",");
  });
  return [CSV_HEADER.join(","), ...lines].map((line) => `${line}\r\n`).join("");
}
```

Modify `UI/src/lib/fmt.ts`. Replace

```ts
export const fromWireTime = (isoStr: string): string =>
  /^\d{2}:\d{2}$/.test(isoStr)
    ? isoStr
    : new Date(isoStr).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });
```

with

```ts
export const fromWireTime = (isoStr: string): string =>
  /^\d{2}:\d{2}$/.test(isoStr)
    ? isoStr
    : new Date(isoStr).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });

/* Each formatter is built once. An audit export formats up to fifty thousand instants, and building an
   `Intl.DateTimeFormat` for every one costs more than all the rest of the row put together. */
const SECONDS = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: TZ });
const STAMP = new Intl.DateTimeFormat("en-CA", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: TZ,
});

/** An ISO instant as the hospital's "HH:MM:SS": the audit log's clock, to the second. */
export const fromWireSeconds = (isoStr: string): string => {
  const d = new Date(isoStr);
  return Number.isNaN(d.getTime()) ? isoStr : SECONDS.format(d);
};

/** An ISO instant as "YYYY-MM-DD HH:MM:SS" in Asia/Kolkata. It is one cell a spreadsheet sorts
 *  correctly, which a display date like "14-Sep-2026" is not. */
export const fromWireStamp = (isoStr: string): string => {
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return isoStr;
  const p = Object.fromEntries(STAMP.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
};
```

Create `UI/src/store/audit.ts`:

```ts
// The audit log (spec 5.1): the super admin's third tab, served by the audit service behind the
// same `API_PREFIX` as everything else. Everything here is a read. No action notifies, because
// an admin opening the log is not told "loaded". Each one answers `null` on a failure rather than
// an empty page, so the screen can tell an outage from a quiet day. `readStockLedger` and
// `loadSignInDirectory` follow the same rule.
import { routes } from "@rch/contract";
import { call } from "../api/client";
import { auditCsv, auditDayRange, type AuditPeriod } from "../lib/audit";
import type { AuditCounts, AuditEntry, AuditGroup, AuditPage, AuditRow } from "../types";
import type { AppState } from "./index";

type Get = () => AppState;
type SetState = (fn: (s: AppState) => Partial<AppState>) => void;

/** What the tab is filtered on. `from` / `to` mean something only for a custom period. */
export type AuditFilter = {
  period: AuditPeriod; from: string; to: string;
  actor?: string; role?: string; loc?: string; group?: AuditGroup; outcome?: "done" | "refused"; q?: string;
};

export interface AuditSlice {
  audit: {
    rows: AuditRow[]; next: number | null; counts: AuditCounts | null; filter: AuditFilter;
    /** `audit` notices received since the last load. The list never moves by itself, so the tab
     *  offers these on a pill instead. */
    fresh: number;
    status: "idle" | "loading" | "ready" | "failed";
  };
  /** Replace the list. Given a filter, that filter becomes the tab's and the old rows are cleared at
   *  once. With no filter, the current one is read again and the rows stay until the answer lands. */
  loadAudit: (filter?: AuditFilter) => Promise<AuditPage | null>;
  /** The page after the last row shown, appended. The counts stay those of the first page, so the
   *  figures above the list do not change underneath the admin. */
  loadMoreAudit: () => Promise<AuditPage | null>;
  /** One whole event, for the drawer. It is not kept in the store. */
  readAuditEntry: (id: number) => Promise<AuditEntry | null>;
  /** Every event the filter matches, newest first, as CSV, up to 50,000 rows. */
  exportAudit: (filter: AuditFilter) => Promise<{ csv: string; rows: number; capped: boolean } | null>;
  /** Called by `refetch`'s `audit` reader, on an admin session only. */
  bumpAuditFresh: () => void;
}

const EXPORT_PAGE = 500;
const EXPORT_CAP = 50_000;

export const initialAudit = (): AuditSlice["audit"] => ({
  rows: [], next: null, counts: null, filter: { period: "today", from: "", to: "" }, fresh: 0, status: "idle",
});

/** The wire query for a filter: IST days for the period, and nothing at all for a filter left empty. */
const queryOf = (f: AuditFilter, page: { before?: number; limit?: number } = {}) => ({
  ...auditDayRange(f.period, { from: f.from, to: f.to }),
  actor: f.actor || undefined,
  role: f.role || undefined,
  loc: f.loc || undefined,
  group: f.group,
  outcome: f.outcome,
  q: f.q?.trim() || undefined,
  before: page.before,
  limit: page.limit,
});

/** Which `loadAudit` call is the latest. If an older call's answer lands later (the filter changed
 *  while it was in flight), it is dropped rather than drawn over the newer list. */
let latest = 0;

export const createAuditSlice = (set: SetState, get: Get): AuditSlice => ({
  audit: initialAudit(),

  loadAudit: async (filter) => {
    const f = filter ?? get().audit.filter;
    const mine = ++latest;
    set((s) => ({
      audit: filter
        ? { ...s.audit, filter, fresh: 0, status: "loading", rows: [], next: null, counts: null }
        : { ...s.audit, fresh: 0, status: "loading" },
    }));
    try {
      const page = await call(routes.auditLog, { query: queryOf(f) });
      if (mine === latest) {
        set((s) => ({ audit: { ...s.audit, rows: page.rows, next: page.next, counts: page.counts, status: "ready" } }));
      }
      return page;
    } catch {
      if (mine === latest) {
        set((s) => ({ audit: { ...s.audit, rows: [], next: null, counts: null, status: "failed" } }));
      }
      return null;
    }
  },

  loadMoreAudit: async () => {
    const { filter, next } = get().audit;
    if (next === null) return null;
    const mine = latest;
    try {
      const page = await call(routes.auditLog, { query: queryOf(filter, { before: next }) });
      // A filter changed while this page was in flight, so it belongs to a list no longer on screen.
      if (mine === latest) set((s) => ({ audit: { ...s.audit, rows: [...s.audit.rows, ...page.rows], next: page.next } }));
      return page;
    } catch { return null; }
  },

  readAuditEntry: async (id) => {
    try { return await call(routes.auditEntry, { params: { id } }); }
    catch { return null; }
  },

  exportAudit: async (filter) => {
    const rows: AuditRow[] = [];
    let before: number | undefined;
    try {
      for (;;) {
        const page = await call(routes.auditLog, { query: queryOf(filter, { before, limit: EXPORT_PAGE }) });
        rows.push(...page.rows);
        if (rows.length >= EXPORT_CAP) {
          const kept = rows.slice(0, EXPORT_CAP);
          return { csv: auditCsv(kept), rows: kept.length, capped: rows.length > EXPORT_CAP || page.next !== null };
        }
        if (page.next === null) return { csv: auditCsv(rows), rows: rows.length, capped: false };
        before = page.next;
      }
    } catch { return null; }
  },

  bumpAuditFresh: () => set((s) => ({ audit: { ...s.audit, fresh: s.audit.fresh + 1 } })),
});
```

Modify `UI/src/store/index.ts`. Replace

```ts
import { createAdminSlice, type AdminSlice } from "./admin";

export interface AppState extends ProcurementSlice, OpsSlice, AdminSlice {
```

with

```ts
import { createAdminSlice, type AdminSlice } from "./admin";
import { createAuditSlice, type AuditSlice } from "./audit";

export interface AppState extends ProcurementSlice, OpsSlice, AdminSlice, AuditSlice {
```

and replace

```ts
  ...createOpsSlice(get),
  ...createAdminSlice(get),
}));
```

with

```ts
  ...createOpsSlice(get),
  ...createAdminSlice(get),
  // ---- audit log: the one slice that takes `set`, because it has no `wire.ts` mapper to write through.
  ...createAuditSlice(set, get),
}));
```

Modify `UI/src/api/refetch.ts`. Replace

```ts
  // ---- admin: account management
  accounts: () => call(routes.adminUsers).then(applyAccounts),
};
```

with

```ts
  // ---- admin: account management
  accounts: () => call(routes.adminUsers).then(applyAccounts),
  // ---- audit log: nothing is read here. The Audit log tab's list never moves by itself (spec
  // 5.2), so a notice only adds to the count behind the tab's "New events - show" pill.
  // The server sends `audit` to admin streams alone; the guard keeps any other session from counting one.
  audit: () => {
    if (useApp.getState().user?.admin) useApp.getState().bumpAuditFresh();
    return Promise.resolve();
  },
};
```

Modify `UI/vite.config.ts`. Replace

```ts
  server: { proxy: { "/api": { target: "http://localhost:3000", changeOrigin: false } } },
```

with

```ts
  server: {
    proxy: {
      // Listed first. Vite uses the first proxy key that matches, and `/api` would otherwise send
      // the audit service's routes to the API, which refuses to mount them (spec 5.3).
      "/api/v1/admin/audit": { target: "http://localhost:3100", changeOrigin: false },
      "/api": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @rch/ui exec vitest run src/__tests__/audit-lib.test.ts src/__tests__/writes.test.ts` Expected: PASS
Run: `pnpm --filter @rch/ui typecheck` Expected: PASS (no output)
Run: `pnpm --filter @rch/ui lint` Expected: PASS, `Found 0 warnings and 0 errors`
Run: `pnpm --filter @rch/ui test` Expected: PASS, with coverage still at or above lines 73 / branches 51. `fixture.ts` feeds every suite, so run the whole suite once here.

- [ ] **Step 5: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add UI/src/lib/audit.ts UI/src/lib/fmt.ts UI/src/store/audit.ts UI/src/store/index.ts UI/src/api/refetch.ts UI/vite.config.ts UI/src/__tests__/audit-lib.test.ts UI/src/__tests__/writes.test.ts UI/src/__tests__/fixture.ts
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Read the audit log into the store and count its change notices

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

### Task 14: Audit log tab and entry drawer

**Files:**
- Create: `UI/src/pages/AdminAudit.tsx`
- Create: `UI/src/pages/AuditEntryDrawer.tsx`
- Modify: `UI/src/pages/AdminDashboard.tsx`
- Modify: `UI/src/styles.css`
- Test: `UI/src/__tests__/admin-audit.test.tsx` (create)
- Test: `UI/src/__tests__/screens.test.tsx` (modify: `OPEN_OVER`)
- Test: `UI/src/__tests__/bare.test.tsx` (modify: one admin case)

**Interfaces:**
- Consumes:
  - From Task 13: `AuditFilter`, the store members `audit`, `loadAudit`, `loadMoreAudit`, `readAuditEntry`
    and `exportAudit`, and from `lib/audit.ts` `auditDayRange`, `deviceOf`, `diffFields`,
    `AUDIT_OUTCOME_LABEL`, `AUDIT_OUTCOME_TONE`, `AUDIT_ROLE_LABELS`, `AUDIT_PLACES`, `placeOf`,
    `AuditPeriod`. From `lib/fmt.ts`: `fromWireSeconds`.
  - From Task 1: `AUDIT_GROUP_KEYS`, `AUDIT_GROUPS`, `auditLabelOf`, `AuditEntry`.
  - Existing: `accounts` / `loadAccounts` (`store/admin.ts`), `openDrawer` / `closeDrawer`, `notify`,
    `registerDrawer`, `DrawerFrame`, the `ui/Drawer.tsx` default host, and the kit components with the
    `tip` props `f736565` added (`PageHead`, `Kpi`, `Section`, `Btn`).
- Produces:
  - `AdminDashboard`'s `Tab = "accounts" | "support" | "audit"`
  - the default export of `pages/AdminAudit.tsx`
  - the drawer key `"auditEntry"`, opened with `openDrawer("auditEntry", String(id))`
  - the CSS classes `aud-two`, `aud-fresh`, `aud-day`, `aud-out`, `aud-head`, `aud-body`, `aud-dl`,
    `aud-lines`, `aud-diff`

- [ ] **Step 1: Write the failing tests**

Create `UI/src/__tests__/admin-audit.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AUDIT_GROUPS, auditLabelOf } from "@rch/contract";
import { istDate } from "@rch/domain";
import AdminDashboard from "../pages/AdminDashboard";
import { refetch } from "../api/refetch";
import { setAccessToken } from "../api/session";
import { auditDayRange } from "../lib/audit";
import { useApp } from "../store";
import type { AdminUser, AuditCounts, AuditEntry, AuditPage, AuditRow } from "../types";
import { as, resetStore, S } from "./fixture";

/**
 * The super admin's third tab, driven against a stubbed audit service. It covers what the tab
 * lists and counts, the query each filter sends, "Load more", the new-events pill a change notice
 * raises, the entry drawer's before -> after and its two links, the export, and the two ways a
 * read comes back with nothing to show.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetchMock = vi.fn();
type Stubs = Record<string, (url: URL) => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const url = new URL(String(u), "http://rch.test");
    const make = stubs[`${init.method} ${url.pathname}`];
    return Promise.resolve(make ? make(url) : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const LOG = "/api/v1/admin/audit";
/** Every query the list path was read with, in order. */
const queries = () =>
  fetchMock.mock.calls
    .map(([u]) => new URL(String(u), "http://rch.test"))
    .filter((u) => u.pathname === LOG)
    .map((u) => Object.fromEntries(u.searchParams));

const KAVITHA: AdminUser = {
  id: "u1", emp: "RC-4471", n: "Kavitha Raman", e: "kavitha.r@royalcare.in", ph: "", r: "counter",
  rl: "Counter Operator", loc: "coffee", col: "#B45309", active: true, mustChangePassword: false, admin: false,
};
const MANAGER = { id: "u2", emp: "RC-3120", name: "Ramesh Kumar", role: "Outlet Manager", loc: "rest" };
const COUNTS: AuditCounts = { events: 3, people: 2, refused: 1, failedSignIns: 1 };
const row = (id: number, over: Partial<AuditRow> = {}): AuditRow => ({
  id, at: "2026-09-14T04:12:09.000Z", actor: MANAGER, action: "savePrice", target: "A:juice", targetLoc: "",
  outcome: "done", status: 200, message: `Price saved (event ${id})`, ip: "10.0.0.7", requestId: `req-${id}`, ...over,
});
const FAILED_SIGN_IN = row(42, {
  at: "2026-09-14T03:00:00.000Z", actor: { id: null, emp: "RC-9999", name: "", role: "", loc: "" },
  action: "login", target: "", outcome: "refused", status: 401, message: "Wrong employee id or password",
});
const page = (rows: AuditRow[], next: number | null = null, counts: AuditCounts = COUNTS): AuditPage => ({ rows, next, counts });
const FIRST = page([row(43), FAILED_SIGN_IN], 42);

/** The reads the page makes as it opens (the accounts tab, the desk count, the Person picker), so
 *  no stray failure toast lands over the audit log. */
const BASE: Stubs = {
  "GET /api/v1/admin/users": () => json([KAVITHA]),
  "GET /api/v1/admin/actions": () => json([]),
  "GET /api/v1/admin/support/tickets": () => json([]),
};

const tick = (ms = 0) => act(async () => { await new Promise((r) => { setTimeout(r, ms); }); });

async function openAuditTab() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(MemoryRouter, null, createElement(AdminDashboard))); });
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "Audit log");
  expect(tab, "no Audit log tab").toBeTruthy();
  await act(async () => { tab!.click(); });
  await tick();
  const body = () => host.querySelector(".adm-body")!;
  return {
    host,
    text: () => body().textContent ?? "",
    /** The table's rows, not the one that carries its empty state. */
    rows: () => [...body().querySelectorAll<HTMLTableRowElement>("tbody tr")].filter((tr) => !tr.querySelector(".empty")),
    drawer: () => host.querySelector<HTMLElement>("aside.drawer"),
    search: () => host.querySelector<HTMLInputElement>(".tbar .sfield input")!,
    button: (label: string, scope: ParentNode = host) =>
      [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim() === label),
    press: async (el: HTMLElement | undefined) => {
      expect(el, "no such control").toBeTruthy();
      await act(async () => { el!.click(); });
      await tick();
    },
    choose: async (label: string, value: string) => {
      const sel = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      await act(async () => { sel.value = value; sel.dispatchEvent(new Event("change", { bubbles: true })); });
      await tick();
    },
    type: async (el: HTMLInputElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
type Ui = Awaited<ReturnType<typeof openAuditTab>>;

let ui: Ui | undefined;
beforeEach(() => {
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  act(() => {
    as("manager");
    setAccessToken("admin-tok");
    useApp.setState({ user: { ...S().user!, admin: true } });
  });
});
afterEach(() => { ui?.unmount(); ui = undefined; vi.unstubAllGlobals(); setAccessToken(null); });

describe("the audit log tab", () => {
  it("lists today's events, newest first, with who, what and the outcome, and counts the whole filter", async () => {
    serve({ ...BASE, "GET /api/v1/admin/audit": () => json(FIRST) });
    ui = await openAuditTab();
    const today = istDate(new Date());
    expect(queries()).toEqual([{ from: today, to: today }]);
    // The page's sentence is PageHead's tip. Its bubble stays in the DOM while closed, so the text is there.
    expect(ui.host.querySelector(".pgh [role=tooltip]")?.textContent).toBe("Every change and sign-in, with who made it and when.");

    const rows = ui.rows();
    expect(rows).toHaveLength(2);
    // 04:12:09 UTC is 09:42:09 at the hospital.
    expect(rows[0].textContent).toContain("14-Sep-2026");
    expect(rows[0].textContent).toContain("09:42:09");
    expect(rows[0].textContent).toContain("RC-3120 · Ramesh Kumar · Outlet Manager");
    expect(rows[0].textContent).toContain("Restaurant");
    expect(rows[0].textContent).toContain(auditLabelOf("savePrice", "done").label);
    expect(rows[0].textContent).toContain("A:juice");
    expect(rows[0].textContent).toContain("Done");
    expect(rows[0].textContent).toContain("Price saved (event 43)");
    expect(rows[1].textContent).toContain("Failed sign-in");
    expect(rows[1].textContent).toContain("Refused");

    const kpis = [...ui.host.querySelectorAll(".kpi")].map((k) => `${k.querySelector(".kl")!.textContent}=${k.querySelector(".kv")!.textContent}`);
    expect(kpis).toEqual(["Events=3", "People=2", "Refused=1", "Failed sign-ins=1"]);
    expect(ui.text()).toContain("Showing 2 of 3");
  });

  it("sends each filter in the query string, and the search only once typing pauses", async () => {
    serve({ ...BASE, "GET /api/v1/admin/audit": () => json(FIRST) });
    ui = await openAuditTab();
    const today = istDate(new Date());
    const last = () => queries().at(-1);

    await ui.choose("Area", AUDIT_GROUPS.sales);
    expect(last()).toEqual({ from: today, to: today, group: "sales" });
    await ui.press(ui.button("Refused"));
    expect(last()).toEqual({ from: today, to: today, group: "sales", outcome: "refused" });
    await ui.choose("Role", "Store Keeper");
    await ui.choose("Location", "Coffee Shop");
    await ui.choose("Person", "RC-4471 · Kavitha Raman");
    expect(last()).toEqual({
      from: today, to: today, group: "sales", outcome: "refused", role: "Store Keeper", loc: "coffee", actor: "u1",
    });

    await ui.press(ui.button("7 days"));
    const week = auditDayRange("7d", { from: "", to: "" });
    expect(last()).toMatchObject(week);

    const reads = queries().length;
    await ui.type(ui.search(), "CF/11");
    expect(queries()).toHaveLength(reads);              // not yet: the box waits for the typing to pause
    await tick(350);
    expect(queries()).toHaveLength(reads + 1);
    expect(last()).toMatchObject({ q: "CF/11", actor: "u1" });

    // Custom opens on the days already shown, and a typed day is sent as it stands.
    await ui.press(ui.button("Custom"));
    const from = ui.host.querySelector<HTMLInputElement>('input[aria-label="From"]')!;
    expect(from.value).toBe(week.from);
    await ui.type(from, "2026-09-01");
    await tick();
    expect(last()).toMatchObject({ from: "2026-09-01", to: week.to });
  });

  it("asks for the next page before the last row it has, and adds it underneath", async () => {
    serve({ ...BASE, "GET /api/v1/admin/audit": (url) => json(url.searchParams.has("before") ? page([row(41)]) : FIRST) });
    ui = await openAuditTab();
    await ui.press(ui.button("Load more"));
    expect(queries().at(-1)).toMatchObject({ before: "42" });
    expect(ui.rows()).toHaveLength(3);
    expect(ui.rows()[2].textContent).toContain("Price saved (event 41)");
    expect(ui.button("Load more")).toBeUndefined();
  });

  it("counts change notices on a pill and leaves the list alone until the pill is pressed", async () => {
    let served = FIRST;
    serve({ ...BASE, "GET /api/v1/admin/audit": () => json(served) });
    ui = await openAuditTab();
    served = page([row(44), ...FIRST.rows], 42, { ...COUNTS, events: 4 });

    const pill = () => ui!.button("New events - show");
    expect(pill()).toBeUndefined();
    await act(async () => { await refetch(["audit"]); await refetch(["audit"]); });
    // No number on it: one notice can carry several events.
    expect(pill()).toBeTruthy();
    expect(S().audit.fresh).toBe(2);
    expect(ui.rows()).toHaveLength(2);
    expect(queries()).toHaveLength(1);

    await ui.press(pill());
    expect(queries()).toHaveLength(2);
    expect(ui.rows()).toHaveLength(3);
    expect(pill()).toBeUndefined();
  });

  it("says the log could not be read on a failure, never that nothing happened, and tries again on request", async () => {
    let up = false;
    serve({ ...BASE, "GET /api/v1/admin/audit": () => (up ? json(FIRST) : json({ error: { code: "internal", message: "boom" } }, 500)) });
    ui = await openAuditTab();
    expect(ui.text()).toContain("Could not read the audit log - check the connection and try again.");
    expect(ui.text()).not.toContain("Nothing recorded");
    expect(S().toast).toBeNull();
    up = true;
    await ui.press(ui.button("Try again"));
    expect(ui.rows()).toHaveLength(2);
  });

  it("calls an empty log nothing recorded, and an empty filtered one nothing matching", async () => {
    serve({ ...BASE, "GET /api/v1/admin/audit": () => json(page([], null, { events: 0, people: 0, refused: 0, failedSignIns: 0 })) });
    ui = await openAuditTab();
    expect(ui.text()).toContain("Nothing recorded in this period");
    await ui.press(ui.button("Refused"));
    expect(ui.text()).toContain("No events match these filters");
  });

  it("exports the filter as a CSV file named for its days", async () => {
    serve({ ...BASE, "GET /api/v1/admin/audit": (url) => json(url.searchParams.get("limit") === "500" ? page(FIRST.rows) : FIRST) });
    const blobs: Blob[] = [];
    const names: string[] = [];
    // jsdom has no object URLs. These stay defined for the rest of this file: the page revokes on a
    // timer that may fire after the test.
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (b: Blob) => { blobs.push(b); return "blob:audit"; } });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      names.push(document.querySelector<HTMLAnchorElement>("a[download]")!.download);
    });
    try {
      ui = await openAuditTab();
      await ui.press(ui.button("Export CSV"));
      for (let i = 0; i < 20 && names.length === 0; i++) await tick(5);
      const today = istDate(new Date());
      expect(queries().at(-1)).toMatchObject({ limit: "500" });
      expect(names).toEqual([`audit-${today}-${today}.csv`]);
      expect(blobs[0].type).toBe("text/csv;charset=utf-8");
      expect(S().toast).toBeNull();
    } finally {
      click.mockRestore();
    }
  });
});

describe("an audit entry", () => {
  const ENTRY: AuditEntry = {
    ...row(43, { action: "patchItem", target: "juice" }),
    method: "PATCH", path: "/items/juice", cause: null,
    request: { params: { it: "juice" }, query: {}, body: { mrp: 45, cost: 30 } },
    before: { mrp: 50, cost: 30, n: "Orange juice" },
    result: { c: "juice", n: "Orange juice", mrp: 45, cost: 30, u: "nos" },
    changed: ["items"],
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  };
  const openEntry = async () => {
    serve({
      ...BASE,
      "GET /api/v1/admin/audit": () => json(page([row(43, { action: "patchItem", target: "juice" })])),
      "GET /api/v1/admin/audit/43": () => json(ENTRY),
    });
    ui = await openAuditTab();
    await ui.press(ui.rows()[0]);
    return ui.drawer()!;
  };

  it("shows where it came from and, before against after, only the fields that changed", async () => {
    const drawer = await openEntry();
    expect(S().drawer).toEqual({ t: "auditEntry", id: "43" });
    expect(drawer.textContent).toContain("Chrome on Windows");
    expect(drawer.textContent).toContain("10.0.0.7");
    expect(drawer.textContent).toContain("req-43");
    expect(drawer.textContent).toContain("PATCH /items/juice");
    const diff = [...drawer.querySelectorAll(".aud-diff tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
    expect(diff).toEqual([["mrp", "₹50.00", "₹45.00"]]);
  });

  it("opens everything by the same person, keeping the period, and closes", async () => {
    const drawer = await openEntry();
    await ui!.press(ui!.button("Everything by this person", drawer));
    const today = istDate(new Date());
    expect(S().drawer).toBeNull();
    expect(queries().at(-1)).toEqual({ from: today, to: today, actor: "u2" });
  });

  it("searches for the event's target, and the search box shows it without searching twice", async () => {
    const drawer = await openEntry();
    await ui!.press(ui!.button("Everything on juice", drawer));
    const today = istDate(new Date());
    expect(S().drawer).toBeNull();
    expect(queries().at(-1)).toEqual({ from: today, to: today, q: "juice" });
    expect(ui!.search().value).toBe("juice");
    const reads = queries().length;
    await tick(350);
    expect(queries()).toHaveLength(reads);
  });
});
```

Modify `UI/src/__tests__/screens.test.tsx`. Replace

```ts
    adjstock: ["coffee", "manager"],
    baddpool: ["new", "buyer"],
```

with

```ts
    adjstock: ["coffee", "manager"],
    // ---- audit log: opens on an event id. The read behind it goes to the audit service, which
    // is not stubbed here, so this renders the drawer's own reading state.
    auditEntry: ["43", "manager"],
    baddpool: ["new", "buyer"],
```

Modify `UI/src/__tests__/bare.test.tsx`. Replace

```ts
import { beforeEach, describe, expect, it } from "vitest";
```

with

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
```

replace

```ts
import Issues from "../pages/Support";
```

with

```ts
import Issues from "../pages/Support";
import AdminAudit from "../pages/AdminAudit";
```

and append at the end of the file:

```tsx

// The super admin's audit log on the first morning: the service has recorded nothing yet, and the
// tab must say so rather than draw a broken table or an outage.
describe("the audit log renders on a database that has recorded nothing", () => {
  it("admin/audit", async () => {
    const empty = { rows: [], next: null, counts: { events: 0, people: 0, refused: 0, failedSignIns: 0 } };
    vi.stubGlobal("fetch", vi.fn(async (u: string) => new Response(
      JSON.stringify(String(u).includes("/admin/audit") ? empty : []),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => { as("manager"); useApp.setState({ user: { ...useApp.getState().user!, admin: true } }); });
      await act(async () => { root.render(createElement(MemoryRouter, null, createElement(AdminAudit))); });
      await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
      expect(host.textContent).toContain("Nothing recorded in this period");
      expect(host.innerHTML.length).toBeGreaterThan(200);
    } finally {
      act(() => { root.unmount(); });
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @rch/ui exec vitest run src/__tests__/admin-audit.test.tsx src/__tests__/bare.test.tsx src/__tests__/screens.test.tsx`
Expected: FAIL.
- `admin-audit.test.tsx`: every case fails with `no Audit log tab: expected undefined to be truthy`.
- `bare.test.tsx`: fails to load with `Failed to resolve import "../pages/AdminAudit"`.
- `screens.test.tsx`: still passes. An `OPEN_OVER` row with no registered drawer is harmless, because the
  loop walks `DRAWERS`.

- [ ] **Step 3: Implement**

Create `UI/src/pages/AdminAudit.tsx`:

```tsx
import { useEffect, useState } from "react";
import { AUDIT_GROUP_KEYS, AUDIT_GROUPS, auditLabelOf } from "@rch/contract";
import { useApp } from "../store";
import type { AuditFilter } from "../store/audit";
import {
  AUDIT_OUTCOME_LABEL, AUDIT_OUTCOME_TONE, AUDIT_PLACES, AUDIT_ROLE_LABELS, auditDayRange, placeOf, type AuditPeriod,
} from "../lib/audit";
import { fromWireDay, fromWireSeconds } from "../lib/fmt";
import type { AdminUser, LocKey } from "../types";
import { Alert, Btn, Card, DataTable, FilterSelect, Kpis, PageHead, Pill, Toolbar, type Col } from "../ui/kit";
import "./AuditEntryDrawer";              // registers "auditEntry" on the drawer registry

const PERIODS: { p: AuditPeriod; label: string }[] = [
  { p: "today", label: "Today" }, { p: "7d", label: "7 days" }, { p: "30d", label: "30 days" }, { p: "custom", label: "Custom" },
];
const OUTCOMES: { o: AuditFilter["outcome"]; label: string }[] = [
  { o: undefined, label: "All" }, { o: "done", label: "Done" }, { o: "refused", label: "Refused" },
];
// Each select holds the words it prints. A choice is turned back into what the wire takes only as it is sent.
const EVERYONE = "Everyone";
const ANY_ROLE = "Every role";
const ANYWHERE = "Everywhere";
const ANY_AREA = "Every area";
const PLACES = Object.entries(AUDIT_PLACES) as [LocKey, string][];
/** How long the search box waits after the last keystroke before it asks. */
const SEARCH_PAUSE_MS = 300;

const COLS: Col[] = [
  { h: "When", w: "13%", cls: "aud-two" }, { h: "Who", w: "22%", cls: "aud-two" },
  { h: "What", w: "22%", cls: "aud-two" }, { h: "Outcome", w: "10%" }, { h: "Sentence" },
];

const personName = (a: AdminUser) => `${a.emp} · ${a.n}`;

/** Hand the browser a file: a Blob behind a temporary link, clicked once and then removed. */
function saveCsv(name: string, csv: string): void {
  // The byte-order mark makes a spreadsheet read the file as UTF-8, so ₹ and non-Latin names survive.
  const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => { URL.revokeObjectURL(url); }, 0);
}

/** The audit log: every write and sign-in, with who made it, when, from where and what came of it. */
export default function AdminAudit() {
  const rows = useApp((s) => s.audit.rows);
  const next = useApp((s) => s.audit.next);
  const counts = useApp((s) => s.audit.counts);
  const filter = useApp((s) => s.audit.filter);
  const fresh = useApp((s) => s.audit.fresh);
  const status = useApp((s) => s.audit.status);
  const accounts = useApp((s) => s.accounts);
  const loadAudit = useApp((s) => s.loadAudit);
  const loadMoreAudit = useApp((s) => s.loadMoreAudit);
  const exportAudit = useApp((s) => s.exportAudit);
  const loadAccounts = useApp((s) => s.loadAccounts);
  const openDrawer = useApp((s) => s.openDrawer);
  const notify = useApp((s) => s.notify);

  // Read on the way in, for the last filter set (today's on a first visit). After that the list
  // moves only when the admin asks: a filter, Load more, or the new-events pill. The account list
  // is for the Person picker; nothing else on an admin session carries it.
  useEffect(() => { void loadAudit(); void loadAccounts(); }, [loadAudit, loadAccounts]);

  const [q, setQ] = useState(filter.q ?? "");
  const [heldQ, setHeldQ] = useState(filter.q ?? "");
  // A search set from outside the box (the drawer's "Everything on ...") replaces what is typed.
  // It is adjusted during render, so the box never shows the old words first. A trailing space the
  // admin is still typing is left alone.
  if ((filter.q ?? "") !== heldQ) {
    setHeldQ(filter.q ?? "");
    if (q.trim() !== (filter.q ?? "")) setQ(filter.q ?? "");
  }
  useEffect(() => {
    const typed = q.trim();
    if (typed === (filter.q ?? "")) return;
    const t = setTimeout(() => { void loadAudit({ ...filter, q: typed || undefined }); }, SEARCH_PAUSE_MS);
    return () => clearTimeout(t);
  }, [q, filter, loadAudit]);

  const [more, setMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [exporting, setExporting] = useState(false);

  const range = auditDayRange(filter.period, filter);
  const narrowed = Boolean(filter.actor || filter.role || filter.loc || filter.group || filter.outcome || filter.q);
  const reading = status === "idle" || status === "loading";

  const reload = (change?: Partial<AuditFilter>) => {
    setMoreFailed(false);
    void loadAudit(change ? { ...filter, ...change } : undefined);
  };
  const pickPeriod = (period: AuditPeriod) => {
    if (period === filter.period) return;
    // Custom opens on the days already on screen, so both boxes start from a real range.
    reload(period === "custom" ? { period, ...range } : { period, from: "", to: "" });
  };
  const showMore = async () => {
    setMore(true);
    try { setMoreFailed((await loadMoreAudit()) === null); } finally { setMore(false); }
  };
  const exportCsv = async () => {
    setExporting(true);
    try {
      const out = await exportAudit(filter);
      if (!out) { notify("Could not export the audit log - check the connection and try again."); return; }
      saveCsv(`audit-${range.from}-${range.to}.csv`, out.csv);
      if (out.capped) notify(`Exported the newest ${out.rows} events only - narrow the period or the filters to export the rest.`);
    } finally { setExporting(false); }
  };

  const people = [...accounts].sort((a, b) => a.emp.localeCompare(b.emp));
  const chosen = filter.actor ? people.find((a) => a.id === filter.actor) : undefined;
  // Someone no longer on the account list (a deleted account, reached from a row's drawer) still
  // narrows the list, and the picker says whose account it is.
  const unlisted = filter.actor && !chosen ? `Account ${filter.actor} (no longer listed)` : null;
  const personOptions = [EVERYONE, ...people.map(personName), ...(unlisted ? [unlisted] : [])];

  return (
    <>
      <PageHead crumbs={["Admin", "Audit log"]} title="Audit log" tip="Every change and sign-in, with who made it and when." />

      {/* Word-only captions are tooltips (UI/CLAUDE.md, "Explanations live in tooltips"); the figures stay visible. */}
      <Kpis items={[
        { l: "Events", v: counts ? String(counts.events) : "-", tip: "Every event in this period that matches the filters, not only the page shown." },
        { l: "People", v: counts ? String(counts.people) : "-", tip: "Everyone who made or attempted one of those events." },
        { l: "Refused", v: counts ? String(counts.refused) : "-", tip: "Events the server refused or failed on." },
        { l: "Failed sign-ins", v: counts ? String(counts.failedSignIns) : "-", tip: "Sign-ins refused for a wrong id or password, an inactive account or a lockout." },
      ]} />

      <Card
        title="Events"
        flush
        right={fresh > 0 ? (
          <button type="button" className="aud-fresh" onClick={() => reload()}>
            {/* No number: `fresh` counts notices, and one notice can carry several events (D6). */}
            <Pill tone="ac">New events - show</Pill>
          </button>
        ) : undefined}
      >
        <Toolbar
          placeholder="Search target, sentence, name or employee id…"
          value={q}
          onSearch={setQ}
          filters={<>
            <div className="seg" role="group" aria-label="Period">
              {PERIODS.map(({ p, label }) => (
                <button key={p} type="button" className={filter.period === p ? "on" : undefined}
                  aria-pressed={filter.period === p} onClick={() => pickPeriod(p)}>{label}</button>
              ))}
            </div>
            {filter.period === "custom" && (
              <>
                <input type="date" className="aud-day" aria-label="From" value={range.from}
                  onChange={(e) => reload({ from: e.target.value })} />
                <input type="date" className="aud-day" aria-label="To" value={range.to}
                  onChange={(e) => reload({ to: e.target.value })} />
              </>
            )}
            <FilterSelect label="Person" value={chosen ? personName(chosen) : unlisted ?? EVERYONE} options={personOptions}
              onChange={(v) => reload({ actor: people.find((a) => personName(a) === v)?.id })} />
            <FilterSelect label="Role" value={filter.role || ANY_ROLE} options={[ANY_ROLE, ...AUDIT_ROLE_LABELS]}
              onChange={(v) => reload({ role: v === ANY_ROLE ? undefined : v })} />
            <FilterSelect label="Location" value={filter.loc ? placeOf(filter.loc) : ANYWHERE}
              options={[ANYWHERE, ...PLACES.map(([, n]) => n)]}
              onChange={(v) => reload({ loc: PLACES.find(([, n]) => n === v)?.[0] })} />
            <FilterSelect label="Area" value={filter.group ? AUDIT_GROUPS[filter.group] : ANY_AREA}
              options={[ANY_AREA, ...AUDIT_GROUP_KEYS.map((g) => AUDIT_GROUPS[g])]}
              onChange={(v) => reload({ group: AUDIT_GROUP_KEYS.find((g) => AUDIT_GROUPS[g] === v) })} />
            <div className="seg" role="group" aria-label="Outcome">
              {OUTCOMES.map(({ o, label }) => (
                <button key={label} type="button" className={filter.outcome === o ? "on" : undefined}
                  aria-pressed={filter.outcome === o} onClick={() => reload({ outcome: o })}>{label}</button>
              ))}
            </div>
          </>}
          right={
            <Btn size="sm" variant="gh" disabled={exporting} onClick={() => void exportCsv()}
              tip="Downloads every event these filters match, newest first, up to 50,000.">
              {exporting ? "Exporting…" : "Export CSV"}
            </Btn>
          }
        />

        {status === "failed" ? (
          // Never "no events": an outage is not a quiet day.
          <div className="aud-out">
            <Alert tone="c" label="OUTAGE" action={<Btn size="xs" variant="gh" onClick={() => reload()}>Try again</Btn>}>
              Could not read the audit log - check the connection and try again.
            </Alert>
          </div>
        ) : (
          <>
            <DataTable
              cols={COLS}
              rows={rows.map((r) => ({
                key: String(r.id),
                onClick: () => openDrawer("auditEntry", String(r.id)),
                cells: [
                  <span className="mono">{fromWireDay(r.at)}<small>{fromWireSeconds(r.at)}</small></span>,
                  <>{[r.actor.emp, r.actor.name, r.actor.role].filter(Boolean).join(" · ")}<small>{placeOf(r.actor.loc)}</small></>,
                  <>
                    {auditLabelOf(r.action, r.outcome).label}
                    {r.target && <small>{r.targetLoc ? `${r.target} · ${placeOf(r.targetLoc)}` : r.target}</small>}
                  </>,
                  <Pill tone={AUDIT_OUTCOME_TONE[r.outcome]}>{AUDIT_OUTCOME_LABEL[r.outcome]}</Pill>,
                  r.message,
                ],
              }))}
              empty={reading
                ? { title: "Reading the audit log…" }
                : narrowed
                  ? { title: "No events match these filters", sub: "Clear the search or a filter, or widen the period." }
                  : { title: "Nothing recorded in this period", sub: "Every change and every sign-in appears here once it is made." }}
            />
            {rows.length > 0 && (
              <div className="tfoot">
                <span>Showing <b className="mono">{rows.length}</b> of <b className="mono">{counts?.events ?? rows.length}</b></span>
                {next !== null && (
                  <Btn size="sm" variant="gh" disabled={more} onClick={() => void showMore()}>
                    {more ? "Loading…" : "Load more"}
                  </Btn>
                )}
                {moreFailed && <span className="mini">Could not read the next page - press Load more again.</span>}
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
```

Create `UI/src/pages/AuditEntryDrawer.tsx`:

```tsx
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { auditLabelOf } from "@rch/contract";
import { useApp } from "../store";
import { registerDrawer, type DrawerProps } from "../drawers";
import { DrawerFrame } from "../ui/Drawer";
import { Btn, DataTable, Pill, Section } from "../ui/kit";
import { AUDIT_OUTCOME_LABEL, AUDIT_OUTCOME_TONE, deviceOf, diffFields, placeOf } from "../lib/audit";
import { fq, fromWireDay, fromWireSeconds, money } from "../lib/fmt";
import type { AuditEntry } from "../types";

/** Fields that hold rupees or quantities in whatever document an event carries. They go through the
 *  app's own formatters, so an edit reads "₹50.00" -> "₹45.00" rather than showing bare numbers. */
const MONEY = new Set(["price", "mrp", "cost", "rate", "tot", "tax"]);
const QTY = new Set(["qty", "appr", "recv", "rej", "rl", "started", "made"]);

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

/** One stored value as the operator reads it. `within` is the object the value sits in, so a
 *  quantity can find its line's item and that item's unit. */
function show(field: string, v: unknown, within: Plain): ReactNode {
  if (v === null || v === undefined || v === "") return <span className="dim">-</span>;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    if (MONEY.has(field)) return money(v);
    if (QTY.has(field)) return fq(v, typeof within.it === "string" ? within.it : "");
    return String(v);
  }
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return <Lines items={v} />;
  if (isPlain(v)) return <Pairs value={v} />;
  return String(v);
}

/** For a field path like "item.cost" (`diffFields` looks one level in): the key a formatter
 *  recognises, and the object the value sits in. */
const leafOf = (path: string, row: Plain): [string, Plain] => {
  const dot = path.indexOf(".");
  if (dot < 0) return [path, row];
  const parent = row[path.slice(0, dot)];
  return [path.slice(dot + 1), isPlain(parent) ? parent : {}];
};

/** An object as label and value rows. */
function Pairs({ value }: { value: Plain }) {
  const keys = Object.keys(value);
  if (keys.length === 0) return <span className="dim">Nothing</span>;
  return (
    <dl className="dl aud-dl">
      {keys.map((k) => (
        <Fragment key={k}><dt>{k}</dt><dd>{show(k, value[k], value)}</dd></Fragment>
      ))}
    </dl>
  );
}

/** A list. A document's lines become a small table; a list of plain values becomes one comma-separated run. */
function Lines({ items }: { items: unknown[] }) {
  if (items.length === 0) return <span className="dim">None</span>;
  if (!items.every(isPlain)) {
    return <>{items.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : String(x))).join(", ")}</>;
  }
  const cols = [...new Set(items.flatMap((r) => Object.keys(r)))];
  return (
    <div className="aud-lines">
      <DataTable
        cols={cols.map((h) => ({ h }))}
        rows={items.map((r, i) => ({ key: String(i), cells: cols.map((c) => show(c, r[c], r)) }))}
      />
    </div>
  );
}

function AuditEntryDrawer({ id }: DrawerProps) {
  const readAuditEntry = useApp((s) => s.readAuditEntry);
  const loadAudit = useApp((s) => s.loadAudit);
  const filter = useApp((s) => s.audit.filter);
  const close = useApp((s) => s.closeDrawer);
  const [got, setGot] = useState<{ id: string; entry: AuditEntry | null } | null>(null);

  // Read each time the drawer points at an event. The list carries only the row, and the whole
  // entry is not kept in the store.
  useEffect(() => {
    let live = true;
    void readAuditEntry(Number(id)).then((entry) => { if (live) setGot({ id, entry }); });
    return () => { live = false; };
  }, [id, readAuditEntry]);

  if (!got || got.id !== id) {
    return <DrawerFrame title={`Event ${id}`} sub="Audit log"><p className="mini">Reading the event…</p></DrawerFrame>;
  }
  const e = got.entry;
  if (!e) {
    return (
      <DrawerFrame title={`Event ${id}`} sub="Audit log">
        <p className="mini">Could not read this event - check the connection, then close this and open it again.</p>
      </DrawerFrame>
    );
  }

  const { label } = auditLabelOf(e.action, e.outcome);
  const changes = e.before != null && e.result != null ? diffFields(e.before, e.result) : [];
  const beforeRow = isPlain(e.before) ? e.before : {};
  const afterRow = isPlain(e.result) ? e.result : {};
  // Both links keep the period and clear every other filter: "everything" means everything.
  const keepPeriod = { period: filter.period, from: filter.from, to: filter.to };
  const byPerson = () => {
    // A sign-in attempt with an unknown id has no account to filter on, so it searches for the id that was typed.
    void loadAudit(e.actor.id ? { ...keepPeriod, actor: e.actor.id } : { ...keepPeriod, q: e.actor.emp });
    close();
  };
  const onTarget = () => { void loadAudit({ ...keepPeriod, q: e.target }); close(); };

  return (
    <DrawerFrame
      title={label}
      sub={`Event ${e.id}`}
      foot={<>
        {(e.actor.id || e.actor.emp) && <Btn variant="gh" onClick={byPerson}>Everything by this person</Btn>}
        {e.target && <Btn variant="gh" onClick={onTarget}>{`Everything on ${e.target}`}</Btn>}
        <Btn variant="gh" onClick={close}>Close</Btn>
      </>}
    >
      <div className="aud-body">
        <div className="aud-head">
          <Pill tone={AUDIT_OUTCOME_TONE[e.outcome]}>{AUDIT_OUTCOME_LABEL[e.outcome]}</Pill>
          <span className="mini">HTTP {e.status}</span>
        </div>

        <Section title="Who">
          <dl className="dl">
            <dt>Employee id</dt><dd className="mono">{e.actor.emp || "-"}</dd>
            <dt>Name</dt><dd>{e.actor.name || "-"}</dd>
            <dt>Role</dt><dd>{e.actor.role || "-"}</dd>
            <dt>Location</dt><dd>{placeOf(e.actor.loc)}</dd>
          </dl>
        </Section>

        <Section title="When">
          <dl className="dl">
            <dt>Date</dt><dd>{fromWireDay(e.at)}</dd>
            <dt>Time (IST)</dt><dd className="mono">{fromWireSeconds(e.at)}</dd>
          </dl>
        </Section>

        <Section title="Where from">
          <dl className="dl">
            <dt>IP address</dt><dd className="mono">{e.ip || "-"}</dd>
            <dt>Device</dt><dd>{deviceOf(e.userAgent)}</dd>
            <dt>Request id</dt><dd className="mono">{e.requestId}</dd>
          </dl>
        </Section>

        <Section title="What">
          <dl className="dl">
            <dt>Action</dt><dd>{label}</dd>
            <dt>Request</dt><dd className="mono">{e.method} {e.path}</dd>
            <dt>Target</dt><dd>{e.target || "-"}{e.targetLoc && ` · ${placeOf(e.targetLoc)}`}</dd>
            <dt>Sentence</dt><dd>{e.message || "-"}</dd>
            {e.cause && <><dt>Cause</dt><dd>{e.cause}</dd></>}
            {e.changed.length > 0 && <><dt>Refreshed</dt><dd className="mono">{e.changed.join(", ")}</dd></>}
          </dl>
        </Section>

        {e.before != null && (
          <Section title="Before → after" tip="Only the fields this edit changed: as they stood before it, and as the server saved them.">
            {changes.length === 0 ? (
              <p className="mini">
                {e.result == null
                  ? "Nothing was changed - the server did not write this edit."
                  : "Nothing changed - every field was saved as it already stood."}
              </p>
            ) : (
              <div className="aud-diff">
                <DataTable
                  cols={[{ h: "Field" }, { h: "Before" }, { h: "After" }]}
                  rows={changes.map((c) => {
                    const [key, was] = leafOf(c.field, beforeRow);
                    const [, now] = leafOf(c.field, afterRow);
                    return { key: c.field, cells: [<span className="mono">{c.field}</span>, show(key, c.before, was), show(key, c.after, now)] };
                  })}
                />
              </div>
            )}
          </Section>
        )}

        <Section title="Sent" tip="What the browser sent. Passwords, one-time codes and tokens are masked before they are stored.">
          <Pairs value={isPlain(e.request) ? e.request : {}} />
        </Section>

        <Section title="Result">
          {e.result == null
            ? <p className="mini">{e.outcome === "done" ? "No document came back." : "No document came back - the server did not take it."}</p>
            : show("result", e.result, {})}
        </Section>
      </div>
    </DrawerFrame>
  );
}

registerDrawer("auditEntry", AuditEntryDrawer);
```

Modify `UI/src/pages/AdminDashboard.tsx`. Replace

```tsx
import { Btn } from "../ui/kit";
import AdminSupport from "./AdminSupport";
import AdminUsers from "./AdminUsers";
import mark from "../assets/eateszy-mark.png";

type Tab = "accounts" | "support";
```

with

```tsx
import { Btn } from "../ui/kit";
import Drawer from "../ui/Drawer";
import AdminAudit from "./AdminAudit";
import AdminSupport from "./AdminSupport";
import AdminUsers from "./AdminUsers";
import mark from "../assets/eateszy-mark.png";

type Tab = "accounts" | "support" | "audit";
```

replace

```tsx
 * Two tabs: staff accounts, and the support desk that answers every role's tickets.
```

with

```tsx
 * Three tabs: staff accounts, the support desk that answers every role's tickets, and the audit
 * log of every change and sign-in.
```

and replace

```tsx
            {waiting > 0 && <span className="adm-count" aria-label={`${waiting} need support`}>{waiting}</span>}
          </button>
        </nav>
        <span className="adm-who">{user.n}</span>
        <Btn variant="gh" size="sm" onClick={() => { void logout().then(() => nav("/login")); }}>Sign out</Btn>
      </header>
      <div className="adm-body" role="tabpanel">
        {tab === "accounts" ? <AdminUsers /> : <AdminSupport />}
      </div>
    </div>
```

with

```tsx
            {waiting > 0 && <span className="adm-count" aria-label={`${waiting} need support`}>{waiting}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === "audit"} className={tab === "audit" ? "on" : undefined}
            onClick={() => setTab("audit")}>Audit log</button>
        </nav>
        <span className="adm-who">{user.n}</span>
        <Btn variant="gh" size="sm" onClick={() => { void logout().then(() => nav("/login")); }}>Sign out</Btn>
      </header>
      <div className="adm-body" role="tabpanel">
        {tab === "accounts" ? <AdminUsers /> : tab === "support" ? <AdminSupport /> : <AdminAudit />}
      </div>
      {/* Every other screen gets its drawer host from `Shell`, which this page never renders, so it
          mounts its own. The audit log opens each of its entries in a drawer. */}
      <Drawer />
    </div>
```

Modify `UI/src/styles.css`. Append at the end of the file:

```css

/* ---------- admin: audit log ---------- */
td.aud-two small{display:block;font-weight:400;font-size:10.5px;color:var(--ink-3);font-family:"IBM Plex Mono",monospace;margin-top:1px}
.aud-fresh{padding:0;border:0;background:none;cursor:pointer;border-radius:20px}
.aud-day{padding:5px 8px;border:1px solid var(--line-strong);border-radius:7px;background:var(--surface);font-size:12px;color:var(--ink-2)}
.aud-out{padding:13px}
.aud-head{display:flex;align-items:center;gap:8px}
.aud-body .dl dd{min-width:0}
.aud-dl{grid-template-columns:minmax(72px,max-content) minmax(0,1fr);gap:5px 12px}
.aud-lines,.aud-diff{border:1px solid var(--line);border-radius:7px;overflow:hidden;min-width:0}
.aud-lines thead th,.aud-lines tbody td{padding:5px 8px}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @rch/ui exec vitest run src/__tests__/admin-audit.test.tsx src/__tests__/bare.test.tsx src/__tests__/screens.test.tsx src/__tests__/app.test.tsx` Expected: PASS
Run: `pnpm --filter @rch/ui typecheck` Expected: PASS (no output)
Run: `pnpm --filter @rch/ui lint` Expected: PASS, `Found 0 warnings and 0 errors`
Run: `pnpm --filter @rch/ui test` Expected: PASS, with coverage at or above lines 73 / branches 51
Run: `pnpm --filter @rch/ui build` Expected: PASS. This is `tsc -b` over both tsconfigs (so it covers `vite.config.ts`) followed by `vite build`.

- [ ] **Step 5: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add UI/src/pages/AdminAudit.tsx UI/src/pages/AuditEntryDrawer.tsx UI/src/pages/AdminDashboard.tsx UI/src/styles.css UI/src/__tests__/admin-audit.test.tsx UI/src/__tests__/screens.test.tsx UI/src/__tests__/bare.test.tsx
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Give the super admin an Audit log tab with an entry drawer

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

# Part 07 - Repo gates, deploy files and CI (Tasks 15-18)

Every block below was prototyped against copies of the files in a scratch tree and checked there:
`pnpm helm:test`'s script passes on the new chart and fails on the old one; `compose.test.sh` passes
on the new Compose files and fails on the old ones (Docker 29, `caddy:2.10-alpine`); the new
`check-boundaries.sh` passes on `origin/develop`'s `apps/api/src` (609befb) plus stand-in audit
files and fires on every probe; the oxlint rules were run with oxlint 1.81.0; `shellcheck` 0.11 and
`actionlint` 1.7.12 are clean on every changed script and workflow. The Replace/with blocks were
generated from those prototypes and verified to reproduce them exactly when applied in order to the
files as they stand in the worktree rebased onto develop 609befb.

#### Notes

1. **`**/apps/audit/**` does not catch a relative import.** From `apps/api/src/x.ts` the sibling is
   `../../audit/src/...`, which never spells `apps/`. The bans therefore also carry
   `**/audit/src/**` (api side) and `**/api/src/**` (audit side); verified that neither flags
   `../lib/audit` or `./audit` inside `apps/api`.
2. **The one door is `apps/audit/src/lib/drain.ts`**, per the Shared Interfaces (`drainOnce`), not
   spec §6.4's `plugins/drainer.ts`.
3. **Task 15 owns every `scripts/check-boundaries.sh` change**, including the API-side
   `audit_outbox` rule of spec §2.1; Task 2 must not edit the script. Test files (`*.test.ts`) and
   `apps/<app>/src/test/**` are exempt from every outbox and store rule in both apps.
4. **Nothing the audit service legitimately does trips a rule.** `lib/roles.ts`'s GRANT statements
   naming `audit_outbox`, the metrics' `select count(*)` on it, the migrate CLI's wait for it, and
   the test harness's reset (`resetAudit`, under `src/test/`, exempt) all pass. **The drainer's
   `for update skip locked` and the `update (at)` grant do not trip any rule either**
   (checked with `select … for update skip locked` in `drain.ts` and `grant select, delete, update
   (at) on "${schema}".audit_outbox` in the audit `roles.ts`). The API migration's
   refuse-UPDATE trigger lives in SQL, which the script never scans.
5. **NetworkPolicy egress.** Spec §6.2 asks for "egress to Postgres and DNS". The chart deliberately
   leaves egress open for every pod (the default-deny policy is `egress: [{}]`, and
   `render.test.sh` asserts it) because RDS is outside the cluster at an address the chart does not
   know. The audit policy is ingress-only, like the api and ui policies.
6. **Operator CLIs on Kubernetes.** The api container no longer holds `MIGRATE_DATABASE_URL`, so
   `kubectl exec deploy/rch-api -c api -- node dist/cli/<x>.mjs` (NOTES.txt, RUNBOOK) connects as
   `rch_app` through `cliDatabaseUrl`'s fallback. A seed, `--force`, or anything else needing the
   superuser runs from a one-off pod built from the api Deployment's own `migrate` initContainer
   spec, which carries the migrate secret - `ci/install-test.sh` does exactly that (Task 18). Task 19
   documents the pattern in RUNBOOK §11 and updates NOTES.txt's `kubectl exec` line.
7. **`SEED_FORCE_PASSWORD_CHANGE` defaults to `true`** in `apps/api/src/config.ts` and the chart does
   not set it, so today's kind seed leaves RC-0001 on a must-change password. The new seed pod sets
   it to `false`, so the admin token the smoke reads the audit log with is a plain admin token.
8. **`ci/values-ci.yaml` moves into Task 17.** `templates/secret.yaml` fails the render on any empty
   required key, so the commit that adds `MIGRATE_DATABASE_URL` / `AUDIT_DATABASE_URL` to
   `secrets.values` must give the CI values both URLs, or `helm template -f ci/values-ci.yaml`
   breaks between commits. `ci/postgres.yaml` (a comment only) and `install-test.sh` stay in Task 18.
9. **Caddy order is by specificity, not by position** (verified with `caddy adapt` on 2.10): the
    routes are tried as `/api/v1/admin/audit*`, `/readyz/audit`, `/readyz`, `/api/*`, then the
    catch-all, however the file is written. `compose.test.sh` now adapts the Caddyfile in the same
    image and asserts that order and each upstream.
10. **An unset `${AUDIT_UPSTREAM}` does not stop nginx.** The image's envsubst leaves it in the
    rendered config as a literal and `nginx -t` still passes (verified); only the audit reads fail,
    at request time. Hence the image's `ENV AUDIT_UPSTREAM` default, Compose's `AUDIT_UPSTREAM`,
    and the render-test assertion on both.
11. **`deploy/cfn/dev.import.json`.** `rch-dev` was imported long ago and an IMPORT change set may
    create nothing. `EcrAudit` is in the import list only to keep a re-import complete (it needs the
    repository created by hand first); on the existing stack the next `aws cloudformation deploy`
    creates it. The resource is named `EcrAudit` to match `EcrApi` / `EcrUi`. Task 18 edits
    `deploy/cfn/README.md`'s repository and export counts, which Task 19's list does not cover.
    There is no `cfn-lint` anywhere in the repo, so Task 18 parses the template instead.
12. **The box is arm64 and builds its own images; CI and EKS build linux/amd64.** Nothing in
    `apps/audit/Dockerfile` is platform-specific (the node and distroless bases are multi-arch), and
    Task 16's local smoke on an Apple-silicon machine builds the same arm64 image the box does.
13. **`.trivyignore.yaml`'s six entries expire 2026-09-30.** The audit image shares the distroless
    base, so it hits the same findings; anything Trivy reports only in the audit image's
    `node_modules` needs its own entry with a statement and an expiry.
14. **Spec §9 still applies**: `APP_DB_PASSWORD` and `AUDIT_DB_PASSWORD` must be in the box's
    `deploy/compose/.env` before the push, or Compose stops at interpolation after the fast-forward
    (`compose.test.sh` now asserts that refusal by name).

#### Interface additions

- **`apps/audit/src/lib/drain.ts`** writes each moving statement with its verb and its table token on
  one line: `delete from ${outbox} …` (or `"${schema}".audit_outbox`), `insert into events (…`,
  `insert into dead_letters (…`. No other non-test file under `apps/audit/src` deletes from the
  outbox or inserts into `events` / `dead_letters`; `plugins/metrics.ts`, `lib/roles.ts` and
  `cli/migrate.ts` only select from or grant on them. Nothing in `apps/audit/src` inserts into,
  updates or truncates the outbox.
- **`apps/api/src/lib/audit.ts`** is the only non-test file in `apps/api/src` that inserts into the
  outbox (`insert(auditOutbox)` or `insert into audit_outbox`), and nothing there selects, updates,
  deletes from or truncates it. Grants such as `grant insert on table audit_outbox to …` and
  `revoke … on table audit_outbox from …` are fine.
- **`apps/audit/package.json`**: `"dev": "PORT=3100 tsx watch --env-file=../../.env src/server.ts"`
  (D10) and a `db:migrate` script.
- **Audit image layout** (`WORKDIR /app`): `dist/server.mjs`, `dist/cli/migrate.mjs`, `drizzle/`
  (journal at `drizzle/meta/_journal.json`), `ENV PORT=3100`, and
  `PG_CA_BUNDLE=/etc/ssl/rds-global-bundle.pem`, read by the audit db client exactly as the API's
  `pgSsl` reads it when `DATABASE_SSL` is on.
- **Audit HTTP surface**: `/healthz`, `/readyz`, `/metrics` at the root; the read routes under
  `API_PREFIX`, i.e. `GET /api/v1/admin/audit` and `/api/v1/admin/audit/:id`. Metrics carry the
  names in spec §3.3, and Prometheus labels them `job="<release>-audit"`.
- **Chart helpers** (`_helpers.tpl`): `rch.env` (generic), `rch.apiEnv`, `rch.apiCliEnv`,
  `rch.auditEnv`, `rch.auditMigrateEnv`. `rch.envList` is removed.
- **Audit migrate locks (D11)**: its migrations hold advisory lock 727273 and its role and grant step
  also holds the API's 727272; the audit-deployment and compose comments say so.
- **Chart values**: `image.audit`, `audit.{replicas,resources,pdb,env,nodeSelector}` (`audit.env`
  sets `AUDIT_SCHEMA`, `EVENTS_SCHEMA`, `OUTBOX_SCHEMA`),
  `secrets.values.MIGRATE_DATABASE_URL`, `secrets.values.AUDIT_DATABASE_URL`.

---

### Task 15: Repo gates and local dev

**Files:**
- Modify: `turbo.json`
- Modify: `knip.json`
- Modify: `.oxlintrc.json`
- Modify: `UI/.oxlintrc.json`
- Modify: `scripts/check-boundaries.sh`
- Modify: `.env.example`

**Interfaces:**
- Consumes: Task 2's `apps/api/src/lib/audit.ts` (the one outbox insert); Task 8's
  `MIGRATE_DATABASE_URL` in `.env.example` (and possibly already in `turbo.json`); Tasks 9-12's
  `apps/audit` package (no `.oxlintrc.json`): `package.json` scripts `dev` (with `PORT=3100`) /
  `test` / `db:migrate`,
  `src/cli/migrate.ts`, `src/lib/drain.ts`, `src/modules/audit/{routes,service,repo,audit.test}.ts`.
- Produces: the import bans, the boundary rules and the dev wiring every later task and CI run
  against; `pnpm dev` starts the API (3000), the audit service (3100) and the UI (5173).

- [ ] **Step 1: Write the failing check**

The gates as one script. It writes probe files that break each new rule, asserts each rule fires,
removes them (on exit too) and asserts the real tree passes.

````bash
cat > "${TMPDIR:-/tmp}/rch-task15-check.sh" <<'CHECK'
#!/usr/bin/env bash
# Task 15's gates, as assertions. One PASS/FAIL line per check; exit 1 if any failed. Every probe
# file it writes is removed again on exit, pass or fail.
set -uo pipefail
W=${W:-/Users/srimanikandanr/.superset/worktrees/RCH-audit-log}
OXLINT="$W/node_modules/.bin/oxlint"
status=0
ok() { echo "PASS: $1"; }
no() { echo "FAIL: $1"; status=1; }

api_probe="$W/apps/api/src/zz-boundary-probe.ts"
audit_probe="$W/apps/audit/src/zz-boundary-probe.ts"
audit_module_probe="$W/apps/audit/src/modules/zz-probe"
cleanup() { rm -rf "$api_probe" "$audit_probe" "$audit_module_probe"; }
trap cleanup EXIT

# 1. turbo hands both new variables to every test task (strict env mode drops anything unnamed).
if pnpm --dir "$W" exec turbo run test --filter=@rch/audit --dry=json 2>/dev/null | sed -n '/^{/,$p' \
  | jq -e '.tasks[] | select(.taskId == "@rch/audit#test") | .environmentVariables.specified.env
           | (index("AUDIT_DATABASE_URL") != null) and (index("MIGRATE_DATABASE_URL") != null)' >/dev/null; then
  ok "turbo passes AUDIT_DATABASE_URL and MIGRATE_DATABASE_URL to test"
else
  no "turbo's test task does not list AUDIT_DATABASE_URL and MIGRATE_DATABASE_URL"
fi

# 2. `pnpm dev` (turbo run dev --parallel) starts the audit service, on its own port.
if pnpm --dir "$W" exec turbo run dev --parallel --dry=json 2>/dev/null | sed -n '/^{/,$p' \
  | jq -e '.tasks[] | select(.taskId == "@rch/audit#dev") | .command | startswith("PORT=3100 ")' >/dev/null; then
  ok "pnpm dev runs @rch/audit#dev on PORT=3100"
else
  no "pnpm dev does not run @rch/audit#dev with PORT=3100 (the root .env's PORT=3000 is the API's)"
fi

# 3. knip knows the new workspace and its CLI entries.
grep -q '"apps/audit": {' "$W/knip.json" && ok "knip.json has the apps/audit workspace" || no "knip.json has no apps/audit workspace"

# 4. The root .env.example carries the audit service's URL.
grep -q '^AUDIT_DATABASE_URL=postgres://rch:rch@localhost:5439/rch$' "$W/.env.example" \
  && ok ".env.example sets AUDIT_DATABASE_URL" || no ".env.example has no AUDIT_DATABASE_URL"

# 5. No nested oxlint config under apps/audit: oxlint uses the nearest config whole, so one there
#    would silently drop the root's apps/audit/** override.
[ ! -e "$W/apps/audit/.oxlintrc.json" ] && ok "apps/audit lints against the root .oxlintrc.json" \
  || no "apps/audit/.oxlintrc.json exists and shadows the root config"

# 6. The import bans fire, both ways, for package names and relative paths alike.
printf 'import "@rch/audit";\nimport "../../audit/src/app";\n' > "$api_probe"
printf 'import "@rch/domain";\nimport "@rch/api";\nimport "../../api/src/app";\n' > "$audit_probe"
api_hits=$(cd "$W/apps/api" && "$OXLINT" --max-warnings 0 src/zz-boundary-probe.ts 2>&1 | grep -c 'import is restricted')
audit_hits=$(cd "$W/apps/audit" && "$OXLINT" --max-warnings 0 src/zz-boundary-probe.ts 2>&1 | grep -c 'import is restricted')
[ "$api_hits" = 2 ] && ok "oxlint refuses apps/api -> apps/audit (2 of 2)" || no "oxlint flagged $api_hits of 2 apps/api -> apps/audit imports"
[ "$audit_hits" = 3 ] && ok "oxlint refuses apps/audit -> @rch/domain, apps/api (3 of 3)" || no "oxlint flagged $audit_hits of 3 forbidden apps/audit imports"

# 7. The new boundary rules fire on deliberately bad code...
mkdir -p "$audit_module_probe"
echo 'export {};' > "$audit_module_probe/routes.ts"
cat >> "$audit_probe" <<'TS'
export const probe = [
  `delete from "public".audit_outbox where id = 1`,
  `insert into events (outbox_id) values (1)`,
  `update events set message = ''`,
];
TS
cat >> "$api_probe" <<'TS'
export const probe = `select id from audit_outbox`;
TS
out=$(bash "$W/scripts/check-boundaries.sh" 2>&1); rc=$?
[ "$rc" != 0 ] && ok "check-boundaries.sh fails on the probes" || no "check-boundaries.sh passed with the probes in place"
for msg in \
  "apps/audit/src/modules/zz-probe is missing service.ts" \
  "apps/api reads, updates, deletes from or truncates audit_outbox" \
  "a delete from the audit outbox must appear in exactly one non-test file, apps/audit/src/lib/drain.ts" \
  "an insert into events or dead_letters must appear in exactly one non-test file, apps/audit/src/lib/drain.ts" \
  "the audit store (events, dead_letters) is append-only"; do
  grep -qF "$msg" <<<"$out" && ok "boundary rule fires: $msg" || no "boundary rule missing: $msg"
done

# 8. ...and pass on the real tree once the probes are gone.
cleanup
out=$(bash "$W/scripts/check-boundaries.sh" 2>&1); rc=$?
[ "$rc" = 0 ] && ok "check-boundaries.sh passes on the tree" || { no "check-boundaries.sh fails on the tree"; echo "$out"; }

exit "$status"
CHECK
````


- [ ] **Step 2: Run it to verify it fails**

Run: `bash "${TMPDIR:-/tmp}/rch-task15-check.sh"`
Expected: FAIL (exit 1) with at least: `FAIL: turbo's test task does not list AUDIT_DATABASE_URL and
MIGRATE_DATABASE_URL`, `FAIL: knip.json has no apps/audit workspace`, `FAIL: .env.example has no
AUDIT_DATABASE_URL`, `FAIL: oxlint flagged 0 of 2 apps/api -> apps/audit imports`, `FAIL: oxlint
flagged 0 of 3 forbidden apps/audit imports`, `FAIL: check-boundaries.sh passed with the probes in
place`, and five `FAIL: boundary rule missing: …` lines. (Checks 2 and 5 already pass - Task 9 set
`PORT=3100` and created no nested oxlint config - and the last line passes on the old script.)

- [ ] **Step 3: Implement**

**`turbo.json`** - replace the whole `"test":` line (whatever its `env` list holds now; Task 8 may
already have appended `"MIGRATE_DATABASE_URL"`) and the comment above it:

````jsonc
    // The suite is minutes; a wrong green is a release.
    "test":      { "dependsOn": ["^typecheck"], "cache": false, "env": ["DATABASE_URL", "TEST_DATABASE_URL"] },
````

with:

````jsonc
    // The suite is minutes; a wrong green is a release.
    //
    // `env` is also the list of variables a test process can see at all: turbo 2 runs tasks in
    // strict env mode, so anything not named here never reaches vitest. AUDIT_DATABASE_URL is the
    // audit service's runtime URL and MIGRATE_DATABASE_URL the one both migrate CLIs connect with.
    "test":      { "dependsOn": ["^typecheck"], "cache": false, "env": ["DATABASE_URL", "TEST_DATABASE_URL", "AUDIT_DATABASE_URL", "MIGRATE_DATABASE_URL"] },
````

The `dev` task needs nothing: `pnpm dev` is `turbo run dev --parallel`, which runs every workspace's
`dev` script, `@rch/audit`'s included.

**`knip.json`**:

Replace (block 1 of 1):
````jsonc
    },
    "apps/api": {
      "entry": [
        "src/cli/*.ts"
````
with:
````jsonc
    },
    "apps/api": {
      "entry": [
        "src/cli/*.ts"
      ],
      "project": [
        "src/**/*.ts"
      ]
    },
    "apps/audit": {
      "entry": [
        "src/cli/*.ts"
````


**`.oxlintrc.json`** (the root config `apps/api`, `apps/audit` and `packages/*` lint against):

Replace (block 1 of 4):
````jsonc
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  // This file is what `apps/api` and `packages/*` lint against - oxlint walks up from the
  // package it is run in, and only `UI` has a config of its own (`UI/.oxlintrc.json`). The set is
  // named rather than left to oxlint's defaults, so a version bump cannot quietly add a plugin
  // under `--max-warnings 0` or drop one the tree has been relying on. `react-hooks` is not a
````
with:
````jsonc
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  // This file is what `apps/api`, `apps/audit` and `packages/*` lint against - oxlint walks up from
  // the package it is run in and uses the nearest config it finds, whole: a nested
  // `.oxlintrc.json` is not merged with this one, it replaces it, so a package that grew its own
  // would silently drop every override below. Only `UI` has one (`UI/.oxlintrc.json`). The set is
  // named rather than left to oxlint's defaults, so a version bump cannot quietly add a plugin
  // under `--max-warnings 0` or drop one the tree has been relying on. `react-hooks` is not a
````

Replace (block 2 of 4):
````jsonc
                "group": ["**/UI/**", "@rch/ui"],
                "message": "apps/api may not import from UI. Share code through @rch/contract or @rch/domain."
              }
            ]
````
with:
````jsonc
                "group": ["**/UI/**", "@rch/ui"],
                "message": "apps/api may not import from UI. Share code through @rch/contract or @rch/domain."
              },
              {
                // `**/audit/src/**` as well as `**/apps/audit/**`: a relative import from apps/api
                // reaches the sibling as `../../audit/src/...`, which never spells `apps/`.
                "group": ["**/apps/audit/**", "**/audit/src/**", "@rch/audit", "@rch/audit/*"],
                "message": "apps/api may not import from apps/audit. The two services share only @rch/contract and the audit_outbox table."
              }
            ]
          }
        ]
      }
    },
    {
      "files": ["apps/audit/**"],
      "rules": {
        "no-restricted-imports": [
          "error",
          {
            "patterns": [
              {
                "group": ["**/apps/api/**", "**/api/src/**", "@rch/api", "@rch/api/*"],
                "message": "apps/audit may not import from apps/api. The two services share only @rch/contract and the audit_outbox table."
              },
              {
                "group": ["**/UI/**", "@rch/ui"],
                "message": "apps/audit may not import from UI."
              },
              {
                "group": ["@rch/domain", "@rch/domain/*", "**/packages/domain/**"],
                "message": "apps/audit depends on @rch/contract alone - it records what the API decided and applies no business rule of its own."
              }
            ]
````

Replace (block 3 of 4):
````jsonc
            "patterns": [
              {
                "group": ["**/apps/**", "@rch/api"],
                "message": "UI may not import from apps/api. Share code through @rch/contract or @rch/domain."
              }
            ]
````
with:
````jsonc
            "patterns": [
              {
                "group": ["**/apps/**", "@rch/api", "@rch/audit"],
                "message": "UI may not import from apps/api or apps/audit. Share code through @rch/contract or @rch/domain."
              }
            ]
````

Replace (block 4 of 4):
````jsonc
            "patterns": [
              {
                "group": ["**/apps/**", "@rch/api", "**/api/client"],
                "message": "Screens read/write through useApp, not api/client directly. UI may not import from apps/api either."
              }
            ]
````
with:
````jsonc
            "patterns": [
              {
                "group": ["**/apps/**", "@rch/api", "@rch/audit", "**/api/client"],
                "message": "Screens read/write through useApp, not api/client directly. UI may not import from apps/api or apps/audit either."
              }
            ]
````


**`UI/.oxlintrc.json`**:

Replace (block 1 of 2):
````jsonc
        "patterns": [
          {
            "group": ["**/apps/**", "@rch/api"],
            "message": "UI may not import from apps/api. Share code through @rch/contract or @rch/domain."
          }
        ]
````
with:
````jsonc
        "patterns": [
          {
            "group": ["**/apps/**", "@rch/api", "@rch/audit"],
            "message": "UI may not import from apps/api or apps/audit. Share code through @rch/contract or @rch/domain."
          }
        ]
````

Replace (block 2 of 2):
````jsonc
            "patterns": [
              {
                "group": ["**/apps/**", "@rch/api", "**/api/client"],
                "message": "Screens read/write through useApp, not api/client directly. UI may not import from apps/api either."
              }
            ]
````
with:
````jsonc
            "patterns": [
              {
                "group": ["**/apps/**", "@rch/api", "@rch/audit", "**/api/client"],
                "message": "Screens read/write through useApp, not api/client directly. UI may not import from apps/api or apps/audit either."
              }
            ]
````


`apps/audit` has no `.oxlintrc.json` of its own (D23) and must not grow one: oxlint uses the
nearest config whole, never merged, so a nested file would silently drop the root's `apps/audit/**`
override (verified with oxlint 1.81.0). Check 5 of the script asserts it. `apps/audit/package.json`'s
`dev` script already reads `"PORT=3100 tsx watch --env-file=../../.env src/server.ts"` (D10; Node's
`--env-file` never overrides a variable already set, so it wins over the root `.env`'s
`PORT=3000`), and check 2 asserts that `pnpm dev` runs it.

**`.env.example`** - insert after `TRUST_PROXY=1`, leaving Task 8's `MIGRATE_DATABASE_URL` lines
wherever Task 8 put them:

Replace (block 1 of 1):
````bash
# 1 = trust exactly one proxy hop (the ALB / the Vite dev proxy); set to the ingress CIDR or hop count if the topology differs
TRUST_PROXY=1
````
with:
````bash
# 1 = trust exactly one proxy hop (the ALB / the Vite dev proxy); set to the ingress CIDR or hop count if the topology differs
TRUST_PROXY=1

# apps/audit - `pnpm dev` starts it beside the API on port 3100 (its dev script sets PORT itself,
# because PORT above is the API's; Node's --env-file never overrides a variable already set).
# It reads JWT_PUBLIC_KEY, JWT_PREVIOUS_PUBLIC_KEY, TRUST_PROXY, LOG_LEVEL, DATABASE_SSL and
# DB_POOL_MAX above too. Locally it connects as the same superuser the API does: when a runtime
# URL's user is the migrate user, neither migrate CLI creates or grants a role, so a local database
# needs no rch_app or rch_audit. `pnpm --filter @rch/audit db:migrate` creates the audit schema.
# Its migrate CLI reads MIGRATE_DATABASE_URL as the API's does, and falls back to this URL.
AUDIT_DATABASE_URL=postgres://rch:rch@localhost:5439/rch
````


**`scripts/check-boundaries.sh`** - sections 1 and 2 are unchanged. Section 3 becomes a function run
over both module roots, and sections 4-6 are new:

Replace (block 1 of 1):
````bash
# ---------------------------------------------------------------------------
# 3) Module skeleton. Every apps/api/src/modules/<name> (except _template, the
#    template itself) has routes.ts, service.ts, repo.ts and at least one *.test.ts.
# ---------------------------------------------------------------------------
echo "== module skeleton: routes.ts, service.ts, repo.ts, *.test.ts =="

for dir in apps/api/src/modules/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  [ "$name" = "_template" ] && continue

  for f in routes.ts service.ts repo.ts; do
    if [ ! -f "${dir}${f}" ]; then
      fail_with "apps/api/src/modules/$name is missing $f (every module needs routes.ts, service.ts, repo.ts and a *.test.ts - see apps/api/src/modules/_template)"
    fi
  done
  # shellcheck disable=SC2086
  if ! ls ${dir}*.test.ts >/dev/null 2>&1; then
    fail_with "apps/api/src/modules/$name has no *.test.ts (every module needs routes.ts, service.ts, repo.ts and a *.test.ts - see apps/api/src/modules/_template)"
  fi
done

if [ "$fail" != "0" ]; then
````
with:
````bash
# ---------------------------------------------------------------------------
# 3) Module skeleton. Every apps/api/src/modules/<name> (except _template, the
#    template itself) and every apps/audit/src/modules/<name> has routes.ts,
#    service.ts, repo.ts and at least one *.test.ts.
# ---------------------------------------------------------------------------
echo "== module skeleton: routes.ts, service.ts, repo.ts, *.test.ts =="

check_skeleton() {
  local modules="$1" dir name f
  for dir in "$modules"/*/; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    [ "$name" = "_template" ] && continue

    for f in routes.ts service.ts repo.ts; do
      if [ ! -f "${dir}${f}" ]; then
        fail_with "$modules/$name is missing $f (every module needs routes.ts, service.ts, repo.ts and a *.test.ts - see apps/api/src/modules/_template)"
      fi
    done
    # shellcheck disable=SC2086
    if ! ls ${dir}*.test.ts >/dev/null 2>&1; then
      fail_with "$modules/$name has no *.test.ts (every module needs routes.ts, service.ts, repo.ts and a *.test.ts - see apps/api/src/modules/_template)"
    fi
  done
}

check_skeleton apps/api/src/modules
check_skeleton apps/audit/src/modules

# ---------------------------------------------------------------------------
# 4) The audit outbox, from the API's side. apps/api appends to audit_outbox from exactly one
#    file, lib/audit.ts - the one place that masks secrets and builds the event - and nothing in
#    apps/api reads it back, updates it, deletes from it or truncates it. The role the API runs as
#    (rch_app) holds INSERT alone on that table; this is the same rule, stated where a reviewer
#    reads code rather than grants. Test files and apps/api/src/test/ are exempt: the suites read
#    the outbox to assert what a write recorded.
# ---------------------------------------------------------------------------
echo "== audit outbox: apps/api appends from lib/audit.ts and never reads it back =="

api_exempt_re='\.test\.ts|^apps/api/src/test/'
# shellcheck disable=SC2016  # `$` anchors, it does not expand
outbox_sql='["`]?([A-Za-z_][A-Za-z0-9_]*["`]?[[:space:]]*\.[[:space:]]*["`]?)?audit_outbox([^A-Za-z0-9_]|$)'
outbox_orm="$qualifier"'auditOutbox[[:space:]]*\)'

outbox_insert='insert[[:space:]]*\([[:space:]]*'"$outbox_orm"'|(insert|merge)[[:space:]]+into[[:space:]]+'"$outbox_sql"
outbox_insert_files="$(grep -rl -i -E "$outbox_insert" apps/api/src --include="*.ts" | grep -v -E "$api_exempt_re" || true)"
if [ "$outbox_insert_files" != "apps/api/src/lib/audit.ts" ]; then
  fail_with "an insert into audit_outbox must appear in exactly one non-test file, apps/api/src/lib/audit.ts. Found in:"
  echo "${outbox_insert_files:-<nowhere>}" >&2
fi

outbox_touch='(update|delete|from)[[:space:]]*\([[:space:]]*'"$outbox_orm"'|(update|delete[[:space:]]+from|from|join|truncate([[:space:]]+table)?)[[:space:]]+'"$outbox_sql"
outbox_touch_hits="$(grep -rn -i -E "$outbox_touch" apps/api/src --include="*.ts" | grep -v -E "$api_exempt_re" || true)"
if [ -n "$outbox_touch_hits" ]; then
  fail_with "apps/api reads, updates, deletes from or truncates audit_outbox - the API only appends to it (lib/audit.ts):"
  echo "$outbox_touch_hits" >&2
fi

# ---------------------------------------------------------------------------
# 5) The audit service's one door. apps/audit moves an event exactly once: lib/drain.ts deletes
#    it from the outbox and inserts it into events (or dead_letters) in one transaction, so that
#    file is the only one that may do either - and nothing in apps/audit inserts into, updates or
#    truncates the outbox, which is the API's to write. The outbox is matched loosely (any token
#    containing `outbox`, any case) because the service names it through OUTBOX_SCHEMA as an
#    interpolated quoted identifier - `delete from ${outbox}` or `"${schema}".audit_outbox` - not a
#    literal the grep could anchor on; the statement's verb and its table still have to share a
#    line. Test files and apps/audit/src/test/ are exempt: the suites fill the outbox themselves.
# ---------------------------------------------------------------------------
echo "== audit service: only lib/drain.ts moves events out of the outbox =="

audit_exempt_re='\.test\.ts|^apps/audit/src/test/'
drain_file="apps/audit/src/lib/drain.ts"
if [ ! -d apps/audit/src ]; then
  fail_with "apps/audit/src is missing - the audit service's boundaries cannot be checked"
else
  drain_delete='delete[[:space:]]+from[[:space:]]+[^[:space:]]*outbox|delete[[:space:]]*\([^)]*outbox'
  drain_delete_files="$(grep -rl -i -E "$drain_delete" apps/audit/src --include="*.ts" | grep -v -E "$audit_exempt_re" || true)"
  if [ "$drain_delete_files" != "$drain_file" ]; then
    fail_with "a delete from the audit outbox must appear in exactly one non-test file, $drain_file. Found in:"
    echo "${drain_delete_files:-<nowhere>}" >&2
  fi

  store_insert='insert[[:space:]]+into[[:space:]]+[^[:space:]]*(events|dead_letters)([^A-Za-z0-9_]|$)|insert[[:space:]]*\([^)]*(events|deadLetters)[[:space:]]*\)'
  store_insert_files="$(grep -rl -i -E "$store_insert" apps/audit/src --include="*.ts" | grep -v -E "$audit_exempt_re" || true)"
  if [ "$store_insert_files" != "$drain_file" ]; then
    fail_with "an insert into events or dead_letters must appear in exactly one non-test file, $drain_file. Found in:"
    echo "${store_insert_files:-<nowhere>}" >&2
  fi

  outbox_write='(insert|merge)[[:space:]]+into[[:space:]]+[^[:space:]]*outbox|update[[:space:]]+[^[:space:]]*outbox|truncate([[:space:]]+table)?[[:space:]]+[^[:space:]]*outbox|(insert|update)[[:space:]]*\([^)]*outbox'
  outbox_write_hits="$(grep -rn -i -E "$outbox_write" apps/audit/src --include="*.ts" | grep -v -E "$audit_exempt_re" || true)"
  if [ -n "$outbox_write_hits" ]; then
    fail_with "apps/audit inserts into, updates or truncates the audit outbox - it only ever deletes what it drained (lib/drain.ts):"
    echo "$outbox_write_hits" >&2
  fi
fi

# ---------------------------------------------------------------------------
# 6) The audit store is append-only. Nothing outside a test updates, deletes from or truncates
#    events or dead_letters, in apps/audit or in apps/api. The triggers refuse it for every role;
#    this refuses it before somebody writes a statement that could only ever fail in production.
# ---------------------------------------------------------------------------
echo "== audit store: events and dead_letters are never updated or deleted =="

store_touch='(update|delete[[:space:]]+from|truncate([[:space:]]+table)?)[[:space:]]+[^[:space:]]*(events|dead_letters)([^A-Za-z0-9_]|$)|(update|delete)[[:space:]]*\([^)]*(events|deadLetters)[[:space:]]*\)'
store_touch_hits="$(grep -rn -i -E "$store_touch" apps/api/src apps/audit/src --include="*.ts" 2>/dev/null | grep -v -E '\.test\.ts|^apps/(api|audit)/src/test/' || true)"
if [ -n "$store_touch_hits" ]; then
  fail_with "the audit store (events, dead_letters) is append-only - nothing may update, delete from or truncate it:"
  echo "$store_touch_hits" >&2
fi

if [ "$fail" != "0" ]; then
````


- [ ] **Step 4: Run to verify it passes**

Run: `bash "${TMPDIR:-/tmp}/rch-task15-check.sh"`
Expected: PASS - every line `PASS:`, exit 0.

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log lint`
Expected: PASS - every package's oxlint at zero warnings, knip clean (the probes are gone, and
knip resolves `apps/audit/src/cli/*.ts` as entries), and `boundaries OK`.

Run: `git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log status --short`
Expected: only the files listed above; no `zz-boundary-probe.ts` and no `modules/zz-probe`.

- [ ] **Step 5: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add turbo.json knip.json .oxlintrc.json UI/.oxlintrc.json scripts/check-boundaries.sh .env.example
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Keep the audit service apart from the API in lint, boundaries and local dev

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

### Task 16: Audit service image, Compose, Caddy and the box scripts

**Files:**
- Create: `apps/audit/Dockerfile`
- Modify: `deploy/compose/compose.yml` (whole file below)
- Modify: `deploy/compose/Caddyfile` (whole file below)
- Modify: `deploy/compose/compose.test.sh` (whole file below)
- Modify: `deploy/compose/.env.example`
- Modify: `deploy/compose/deploy.sh`
- Modify: `deploy/compose/backup.sh`
- Modify: `deploy/compose/release.sh`
- Modify: `deploy/compose/README.md` (whole file below)
- Modify: `.github/workflows/deploy-box.yml`

**Interfaces:**
- Consumes: Task 15. Tasks 8 and 10: the API migrate CLI takes the superuser from
  `MIGRATE_DATABASE_URL` and the `rch_app` name and password from `DATABASE_URL`; the audit migrate
  CLI takes `rch_audit` from `AUDIT_DATABASE_URL`, and both skip role setup when the users match.
  The audit image layout under Interface additions.
- Produces: `rch-audit:local` built by Compose; the `migrate` / `audit-migrate` / `api` / `audit`
  service split; Caddy's `/api/v1/admin/audit*`, `/readyz` and `/readyz/audit` routes, which
  `release.sh` and `deploy-box.yml` poll; operator CLIs running through `migrate`.

No change is needed to `.dockerignore` (it already drops `**/dist`, `docs` and `*.md`, and keeps
`apps/audit/drizzle`) or to the root `docker-compose.yml` (local development uses one database and
one superuser).

- [ ] **Step 1: Write the failing check**

`compose.test.sh` is the check: it renders `compose.yml` with dummy secrets, asserts the service
split, the role each container connects as, the secrets each must not hold and the start order,
proves each new password is refused by name when missing, and adapts the Caddyfile in the box's
Caddy image to assert its route order. Write it first. `deploy/compose/compose.test.sh`:

````bash
#!/usr/bin/env bash
# `pnpm compose:test` (root package.json) - the compose analogue of `helm:test`. Validates that
# `compose.yml` parses and every required variable is at least declared, without needing Docker
# running or real secrets: dummy values stand in for the ones `.env.example` leaves blank, since
# a structural check should not depend on a real JWT key pair or a real password existing.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is not available on this host - skipping (see CI, which has it)." >&2
  exit 0
fi
command -v jq >/dev/null || { echo "jq is required to check the rendered compose file" >&2; exit 1; }

render() {
  DOMAIN=example.test \
  POSTGRES_PASSWORD=x \
  APP_DB_PASSWORD=x \
  AUDIT_DB_PASSWORD=x \
  JWT_PRIVATE_KEY=x \
  JWT_PUBLIC_KEY=x \
  SEED_PASSWORD=x \
  docker compose --env-file /dev/null -f compose.yml config "$@" 2>&1
}

out=$(render --quiet) || { echo "$out" >&2; echo "compose.yml failed to parse" >&2; exit 1; }
json=$(render --format json) || { echo "$json" >&2; echo "compose.yml failed to render" >&2; exit 1; }

check() { jq -e "$1" >/dev/null <<<"$json" || { echo "FAIL: $2" >&2; exit 1; }; }

# The two runtime passwords are required, like every other secret here: a blank one would start
# the API or the audit service as a role with an empty password.
for v in APP_DB_PASSWORD AUDIT_DB_PASSWORD; do
  if missing=$(DOMAIN=example.test POSTGRES_PASSWORD=x APP_DB_PASSWORD=x AUDIT_DB_PASSWORD=x \
      JWT_PRIVATE_KEY=x JWT_PUBLIC_KEY=x SEED_PASSWORD=x env -u "$v" docker compose --env-file /dev/null -f compose.yml config --quiet 2>&1); then
    echo "FAIL: compose.yml rendered without $v" >&2; exit 1
  fi
  grep -q "$v" <<<"$missing" || { echo "FAIL: a missing $v must be refused by name; got: $missing" >&2; exit 1; }
done

check '.services | has("migrate") and has("audit-migrate") and has("api") and has("audit") and has("ui") and has("caddy")' \
  "compose.yml must run migrate, audit-migrate, api, audit, ui and caddy"
# Least privilege: the long-running API holds rch_app and no superuser URL at all.
check '.services.api.environment | has("MIGRATE_DATABASE_URL") | not' "api must not carry MIGRATE_DATABASE_URL"
check '.services.api.environment.DATABASE_URL | startswith("postgres://rch_app:")' "api must connect as rch_app"
# The API's migrate step and every operator CLI run through `migrate`, as the superuser, and read
# the runtime role's name and password from DATABASE_URL.
check '.services.migrate.environment.MIGRATE_DATABASE_URL | startswith("postgres://rch:")' "migrate must connect as rch"
check '.services.migrate.environment.DATABASE_URL | startswith("postgres://rch_app:")' "migrate must read rch_app from DATABASE_URL"
check '.services["audit-migrate"].environment.MIGRATE_DATABASE_URL | startswith("postgres://rch:")' "audit-migrate must connect as rch"
check '.services["audit-migrate"].environment.AUDIT_DATABASE_URL | startswith("postgres://rch_audit:")' "audit-migrate must read rch_audit from AUDIT_DATABASE_URL"
check '.services.audit.environment.AUDIT_DATABASE_URL | startswith("postgres://rch_audit:")' "audit must connect as rch_audit"
# The audit containers verify tokens and never sign one or seed anything.
for s in audit audit-migrate; do
  for k in JWT_PRIVATE_KEY SEED_PASSWORD DATABASE_URL; do
    check ".services[\"$s\"].environment | has(\"$k\") | not" "$s must not carry $k"
  done
done
check '.services.audit.environment | has("MIGRATE_DATABASE_URL") | not' "audit must not carry MIGRATE_DATABASE_URL"
# Start order: postgres → migrate → audit-migrate → audit, and Caddy waits for all three backends.
check '.services["audit-migrate"].depends_on.migrate.condition == "service_completed_successfully"' "audit-migrate must wait for migrate"
check '.services.audit.depends_on["audit-migrate"].condition == "service_completed_successfully"' "audit must wait for audit-migrate"
check '.services.api.depends_on.migrate.condition == "service_completed_successfully"' "api must wait for migrate"
check '.services.caddy.depends_on | has("audit") and has("api") and has("ui")' "caddy must depend on ui, api and audit"
check '.services["audit-migrate"].command == ["dist/cli/migrate.mjs"]' "audit-migrate must run dist/cli/migrate.mjs"

# The Caddyfile, adapted by the same Caddy image the box runs: it must parse, and the routes must be
# tried in the order the site depends on - the audit reads before the API's `/api/*`, and both
# readiness paths reaching a backend instead of falling through to the UI's static `ok`.
caddy_json=$(docker run --rm -e DOMAIN=example.test -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2.10-alpine caddy adapt --config /etc/caddy/Caddyfile --validate 2>/dev/null) \
  || { echo "FAIL: the Caddyfile does not adapt" >&2; exit 1; }
routes='[.apps.http.servers.srv0.routes[0].handle[0].routes[] | select(.match != null)
  | { path: .match[0].path[0], rewrite: ([.handle[].routes[]?.handle[]? | select(.handler == "rewrite") | .uri] | first),
      dial: ([.handle[].routes[]?.handle[]? | select(.handler == "reverse_proxy") | .upstreams[0].dial] | first) }]'
order=$(jq -r "$routes | map(.path) | join(\" \")" <<<"$caddy_json")
[ "$order" = "/api/v1/admin/audit* /readyz/audit /readyz /api/*" ] \
  || { echo "FAIL: Caddy tries its routes in the wrong order: $order" >&2; exit 1; }
caddy_check() { jq -e "$routes | $1" >/dev/null <<<"$caddy_json" || { echo "FAIL: Caddyfile: $2" >&2; exit 1; }; }
caddy_check 'any(.path == "/api/v1/admin/audit*" and .dial == "audit:3100")' "the audit reads must reach audit:3100"
caddy_check 'any(.path == "/readyz" and .dial == "api:3000")' "/readyz must reach the API"
caddy_check 'any(.path == "/readyz/audit" and .rewrite == "/readyz" and .dial == "audit:3100")' "/readyz/audit must reach the audit service's /readyz"

echo "compose.yml and the Caddyfile are well-formed"
````


- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log compose:test`
Expected: FAIL with `FAIL: compose.yml rendered without APP_DB_PASSWORD` (exit 1). With only the
Caddyfile left old it fails with `FAIL: Caddy tries its routes in the wrong order: /api/*`. On a host
without Docker it prints the skip line and exits 0 - run it where Docker is available.

- [ ] **Step 3: Implement**

**`apps/audit/Dockerfile`** (D10: `ENV PORT=3100`; no platform pinned, so the arm64 box and the
amd64 CI both build it natively):

````dockerfile
# syntax=docker/dockerfile:1.7
# The audit service (apps/audit). The same shape as apps/api/Dockerfile, narrowed to what this
# service depends on: @rch/contract and nothing else - no @rch/domain, no apps/api.
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/contract/package.json packages/contract/
COPY apps/audit/package.json apps/audit/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @rch/audit...

FROM deps AS build
COPY packages/contract ./packages/contract
COPY apps/audit ./apps/audit
COPY tsconfig.base.json ./
RUN pnpm --filter @rch/audit build \
 && pnpm --filter @rch/audit deploy --prod --legacy /out \
 && rm -rf /out/src \
 && apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /rds-global-bundle.pem

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime
ENV NODE_ENV=production PORT=3100 PG_CA_BUNDLE=/etc/ssl/rds-global-bundle.pem
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/audit/dist ./dist
COPY --from=build /repo/apps/audit/drizzle ./drizzle
COPY --from=build /rds-global-bundle.pem /etc/ssl/rds-global-bundle.pem
EXPOSE 3100
USER nonroot
CMD ["dist/server.mjs"]
````


**`deploy/compose/compose.yml`** - the whole file. The one environment anchor becomes two: `migrate`
extends the API's with the superuser URL, `api` takes it as it is, and `audit-migrate` / `audit` get
their own, which never holds `JWT_PRIVATE_KEY`, `SEED_PASSWORD` or `DATABASE_URL` and names every
variable the audit migrate CLI reads (D24: `MIGRATE_DATABASE_URL`, `AUDIT_DATABASE_URL`,
`JWT_PUBLIC_KEY`, `AUDIT_SCHEMA`, `OUTBOX_SCHEMA`, `LOG_LEVEL`; the service also reads
`EVENTS_SCHEMA`):

````yaml
name: rch

# A single-instance deploy: one Postgres, the API and the audit service each behind their own
# one-shot migration, one UI, one Caddy in front doing automatic HTTPS. No registry - all three
# application images build from this checkout's own Dockerfiles, the same ones the EKS path uses,
# so there is exactly one Dockerfile per service across both deploy targets. `deploy.sh` in this
# directory is the one entry point that builds, migrates, seeds once and brings the stack up; read
# it before running `docker compose` by hand.
#
# Caddy reaches `api`, `audit` and `ui` directly by service name on the network compose creates -
# there is no second reverse-proxy hop the way the K8s ingress → ui-nginx → api chain has, so
# `TRUST_PROXY=1` (one hop: Caddy) is correct here without change. `ui`'s own nginx still carries
# its `/api/` and `/api/v1/admin/audit` proxy blocks (the same image the EKS build uses); it is
# simply never asked to use them - Caddy's own routes reach the API and audit containers first.
#
# Three database roles. `rch`, the superuser the Postgres image creates, is used only by `migrate`,
# `audit-migrate` and the operator CLIs run through `migrate`; `api` runs as `rch_app` and `audit`
# as `rch_audit`. Each migrate step creates its runtime role from the user and password in the
# runtime URL and re-grants it on every run, so a password changed in .env takes effect on the
# next deploy.

x-api-env: &api_env
  # The API's runtime role. `migrate` creates it from this URL's user and password.
  DATABASE_URL: postgres://rch_app:${APP_DB_PASSWORD:?set APP_DB_PASSWORD in .env}@postgres:5432/rch
  # A container's own Postgres speaks no TLS at all; the image otherwise verifies the RDS
  # chain whenever NODE_ENV=production (config.ts's databaseSsl default), which this
  # Dockerfile always sets, so it has to be turned off explicitly here.
  DATABASE_SSL: "false"
  DB_POOL_MAX: "10"
  CORS_ORIGIN: https://${DOMAIN:?set DOMAIN in .env}
  JWT_PRIVATE_KEY: ${JWT_PRIVATE_KEY:?set JWT_PRIVATE_KEY in .env - pnpm --filter @rch/api keys:generate}
  JWT_PUBLIC_KEY: ${JWT_PUBLIC_KEY:?set JWT_PUBLIC_KEY in .env}
  JWT_PREVIOUS_PUBLIC_KEY: ${JWT_PREVIOUS_PUBLIC_KEY:-}
  ACCESS_TOKEN_TTL: 15m
  REFRESH_TOKEN_TTL_DAYS: "30"
  COOKIE_SECURE: "true"
  SEED_PASSWORD: ${SEED_PASSWORD:?set SEED_PASSWORD in .env - at least 12 characters}
  RATE_LIMIT_PER_MINUTE: "300"
  LOGIN_RATE_LIMIT_PER_MINUTE: "10"
  LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE: "5"
  TRUST_PROXY: "1"
  LOG_LEVEL: info

x-audit-env: &audit_env
  # The audit service's runtime role. `audit-migrate` creates it from this URL's user and password.
  AUDIT_DATABASE_URL: postgres://rch_audit:${AUDIT_DB_PASSWORD:?set AUDIT_DB_PASSWORD in .env}@postgres:5432/rch
  DATABASE_SSL: "false"
  DB_POOL_MAX: "5"
  # Verify only: the audit service never signs a token, so it never sees the private key.
  JWT_PUBLIC_KEY: ${JWT_PUBLIC_KEY:?set JWT_PUBLIC_KEY in .env}
  JWT_PREVIOUS_PUBLIC_KEY: ${JWT_PREVIOUS_PUBLIC_KEY:-}
  TRUST_PROXY: "1"
  LOG_LEVEL: info
  # The audit store's schema, the schema holding the API's audit_outbox, and the schema whose
  # `rch_events_<schema>` channel the API listens on - the API's tables are in `public`.
  AUDIT_SCHEMA: audit
  OUTBOX_SCHEMA: public
  EVENTS_SCHEMA: public

services:
  postgres:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: rch
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: rch
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U rch -d rch"]
      interval: 5s
      timeout: 3s
      retries: 10
    # Not published to the host: only containers on this network reach it.

  # The API's migrations and role setup, and the container every operator CLI runs in
  # (`compose run --rm --no-deps migrate dist/cli/<name>.mjs`): the CLIs connect with
  # MIGRATE_DATABASE_URL, the superuser, where the long-running `api` holds only `rch_app`.
  migrate:
    build: { context: ../.., dockerfile: apps/api/Dockerfile }
    image: rch-api:local
    command: ["dist/cli/migrate.mjs"]
    restart: "no"
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      <<: *api_env
      MIGRATE_DATABASE_URL: postgres://rch:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@postgres:5432/rch

  # The audit schema's migrations and the `rch_audit` role. After `migrate`, because its grants
  # name `audit_outbox`, which the API's migrations create (it exits 3 if that table never appears
  # within 5 minutes, 2 on a bad environment).
  audit-migrate:
    build: { context: ../.., dockerfile: apps/audit/Dockerfile }
    image: rch-audit:local
    command: ["dist/cli/migrate.mjs"]
    restart: "no"
    depends_on:
      migrate: { condition: service_completed_successfully }
    environment:
      <<: *audit_env
      MIGRATE_DATABASE_URL: postgres://rch:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@postgres:5432/rch

  api:
    image: rch-api:local
    restart: unless-stopped
    depends_on:
      migrate: { condition: service_completed_successfully }
      postgres: { condition: service_healthy }
    environment: *api_env
    # The runtime image is distroless (no shell, no curl) - a HEALTHCHECK that shells out cannot
    # run inside the container. `caddy`'s reverse_proxy retries a connection refused start, and
    # `restart: unless-stopped` recovers a crash; that is the health story for this one box.

  # Drains the API's audit outbox into the `audit` schema and serves the admin page's Audit log
  # tab. Distroless like `api`, with the same health story.
  audit:
    image: rch-audit:local
    restart: unless-stopped
    depends_on:
      audit-migrate: { condition: service_completed_successfully }
      postgres: { condition: service_healthy }
    environment: *audit_env

  ui:
    build: { context: ../.., dockerfile: UI/Dockerfile }
    image: rch-ui:local
    restart: unless-stopped
    depends_on: [api]
    environment:
      API_UPSTREAM: http://api:3000
      AUDIT_UPSTREAM: http://audit:3100

  caddy:
    image: caddy:2.10-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    environment:
      DOMAIN: ${DOMAIN:?set DOMAIN in .env}
    depends_on: [ui, api, audit]

volumes:
  pgdata: {}
  caddy_data: {}
  caddy_config: {}
````


**`deploy/compose/Caddyfile`** - the whole file (tab-indented; `caddy fmt` leaves it unchanged):

````caddyfile
{
	# No admin API listening on this box - nothing here needs to reconfigure Caddy live, and an
	# open admin socket is one more thing to firewall for no benefit.
	admin off
}

{$DOMAIN} {
	encode gzip

	# Caddy sorts `handle` blocks that carry a single path matcher by how specific the path is,
	# longest first, and puts a `handle` with no matcher last - so the order below is the order
	# they are tried in whichever way the file is written, and it is written that way on purpose.
	# They are mutually exclusive: the first that matches is the only one that runs.

	# The audit service's two read routes, ahead of the API's catch-all `/api/*`. Nothing else
	# lives under this path, so the API never sees an audit read.
	handle /api/v1/admin/audit* {
		reverse_proxy audit:3100
	}

	# The API, matched on path, so it never falls through to the UI container's own `/api/` proxy
	# block - that block exists only for the image's other deploy target (the K8s ingress routes
	# the same way, API path first). `flush_interval -1` streams every response immediately rather
	# than buffering it, which is what `/api/v1/events` (server-sent events) needs to stay live; it
	# costs nothing on the ordinary JSON responses beside it.
	handle /api/* {
		reverse_proxy api:3000 {
			flush_interval -1
		}
	}

	# Readiness, for release.sh and the deploy workflow. `/readyz` used to fall through to the UI's
	# nginx, which answers a static `ok` - so a release "passed" without the database or a single
	# migration being checked. The API's own `/readyz` checks both; the audit service's checks its
	# database, its migrations and that the drainer has made a pass in the last 30 seconds.
	handle /readyz {
		reverse_proxy api:3000
	}
	handle /readyz/audit {
		rewrite * /readyz
		reverse_proxy audit:3100
	}

	handle {
		reverse_proxy ui:8080
	}
}
````


**`deploy/compose/.env.example`**:

Replace (block 1 of 1):
````bash

# The container Postgres's own password - anything long and random; it is never reachable
# outside this box's Docker network.
POSTGRES_PASSWORD=

# Ed25519 key pair, PEM, base64-encoded - generate with:
````
with:
````bash

# The container Postgres's own password - anything long and random; it is never reachable
# outside this box's Docker network. It is the superuser `rch`'s, used only by `migrate`,
# `audit-migrate` and the operator CLIs run through `migrate`.
POSTGRES_PASSWORD=

# The two runtime roles' passwords: `api` connects as rch_app, `audit` as rch_audit. `migrate`
# and `audit-migrate` create each role with this password (and reset it on every deploy, so a
# change here takes effect on the next one). They sit inside a postgres:// URL, so letters and
# digits only - `openssl rand -hex 24` makes a good one. Both are required.
APP_DB_PASSWORD=
AUDIT_DB_PASSWORD=

# Ed25519 key pair, PEM, base64-encoded - generate with:
````


**`deploy/compose/deploy.sh`** - the bare seed runs through `migrate`:

Replace (block 1 of 3):
````bash
#   deploy/compose/deploy.sh
#
# What it does, in order: builds the api and ui images from this checkout's own Dockerfiles
# (the same two Dockerfiles the EKS path builds - there is one image definition per service,
# not two), brings the stack up (`postgres` → `migrate` → `api`/`ui`/`caddy`, in that order,
# via compose's own `depends_on` conditions - a fresh Postgres or a pending migration is never
# raced), seeds the database only the first time it is empty, and reports the result. It is
# safe to run again on an already-running stack: rebuilding and re-upping a service compose
# finds unchanged is a no-op, and the seed step only ever fires once.
````
with:
````bash
#   deploy/compose/deploy.sh
#
# What it does, in order: builds the api, audit and ui images from this checkout's own
# Dockerfiles (the same three Dockerfiles the EKS path builds - there is one image definition per
# service, not two), brings the stack up (`postgres` → `migrate` → `audit-migrate`, then
# `api`/`audit`/`ui`/`caddy`, via compose's own `depends_on` conditions - a fresh Postgres or a
# pending migration is never raced), seeds the database only the first time it is empty, and
# reports the result. It is
# safe to run again on an already-running stack: rebuilding and re-upping a service compose
# finds unchanged is a no-op, and the seed step only ever fires once.
````

Replace (block 2 of 3):
````bash
compose build

echo "== starting postgres, running the migration, then api / ui / caddy =="
compose up -d

````
with:
````bash
compose build

echo "== starting postgres, running both migrations, then api / audit / ui / caddy =="
compose up -d

````

Replace (block 3 of 3):
````bash
  # `--bare`: the locations, the document numbering and the RC-0001 admin account - never the
  # demo hospital. This box is a real deployment; the demo data is for local dev and CI only.
  echo "   database is empty - seeding the locations and the admin account (no demo data)"
  compose run --rm --no-deps api dist/cli/seed.mjs --bare --yes-seed rch
else
  echo "   database already has ${users:-some} user(s) - not reseeding"
````
with:
````bash
  # `--bare`: the locations, the document numbering and the RC-0001 admin account - never the
  # demo hospital. This box is a real deployment; the demo data is for local dev and CI only.
  # Through `migrate`, not `api`: operator CLIs connect as the superuser (MIGRATE_DATABASE_URL),
  # and the `api` service holds only rch_app.
  echo "   database is empty - seeding the locations and the admin account (no demo data)"
  compose run --rm --no-deps migrate dist/cli/seed.mjs --bare --yes-seed rch
else
  echo "   database already has ${users:-some} user(s) - not reseeding"
````


**`deploy/compose/backup.sh`** - the purge runs through `migrate`:

Replace (block 1 of 1):
````bash

# The nightly sweep of expired refresh tokens and idempotency keys - apps/api/src/cli/purge.ts,
# the same one-off CronJob ran in the EKS deploy.
compose run --rm --no-deps api dist/cli/purge.mjs

echo "backed up rch-$stamp.sql.gz to s3://$bucket/db/ and purged expired rows"
````
with:
````bash

# The nightly sweep of expired refresh tokens and idempotency keys - apps/api/src/cli/purge.ts,
# the same one-off CronJob ran in the EKS deploy. Through `migrate`, like every operator CLI: it
# carries the superuser URL, and `api` holds only rch_app.
compose run --rm --no-deps migrate dist/cli/purge.mjs

echo "backed up rch-$stamp.sql.gz to s3://$bucket/db/ and purged expired rows"
````


**`deploy/compose/release.sh`** - both readiness checks, and every relevant log on failure:

Replace (block 1 of 3):
````bash
# if the box is already past the commit (a newer deploy won the race - never roll it back), dump
# the database to S3 (the way back from a bad migration), fast-forward, run deploy.sh, and fail
# unless /readyz answers - it checks the database and that every migration in the journal is
# applied. A failure after the fast-forward is left for a person: a migration that already
# committed is not undone by putting the previous image back, so nothing here tries to.
set -euo pipefail

````
with:
````bash
# if the box is already past the commit (a newer deploy won the race - never roll it back), dump
# the database to S3 (the way back from a bad migration), fast-forward, run deploy.sh, and fail
# unless both readiness checks answer: /readyz is the API's (the database, and every migration in
# its journal applied) and /readyz/audit the audit service's (the database, its own migrations,
# and a drain pass in the last 30 seconds) - Caddy routes each to its container. A failure after
# the fast-forward is left for a person: a migration that already committed is not undone by
# putting the previous image back, so nothing here tries to.
set -euo pipefail

````

Replace (block 2 of 3):
````bash
deploy/compose/deploy.sh

echo "== checking /readyz =="
domain=$(grep -E '^DOMAIN=' deploy/compose/.env | cut -d= -f2-)
for _ in $(seq 1 60); do
  if curl -fsS -m 5 "https://${domain}/readyz" >/dev/null 2>&1; then
    # Every deploy leaves a build cache behind; a week of it is plenty to keep rebuilds fast.
    docker builder prune -f --filter until=168h >/dev/null
````
with:
````bash
deploy/compose/deploy.sh

echo "== checking /readyz and /readyz/audit =="
domain=$(grep -E '^DOMAIN=' deploy/compose/.env | cut -d= -f2-)
for _ in $(seq 1 60); do
  if curl -fsS -m 5 "https://${domain}/readyz" >/dev/null 2>&1 \
    && curl -fsS -m 5 "https://${domain}/readyz/audit" >/dev/null 2>&1; then
    # Every deploy leaves a build cache behind; a week of it is plenty to keep rebuilds fast.
    docker builder prune -f --filter until=168h >/dev/null
````

Replace (block 3 of 3):
````bash
done

echo "release: https://${domain}/readyz never answered - the stack as it stands:" >&2
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yml ps >&2 || true
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yml logs --tail 60 migrate api >&2 || true
exit 1
````
with:
````bash
done

echo "release: https://${domain}/readyz and /readyz/audit never both answered - the stack as it stands:" >&2
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yml ps -a >&2 || true
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yml logs --tail 60 migrate audit-migrate api audit >&2 || true
exit 1
````


**`deploy/compose/README.md`** - the whole file (based on the rebased copy):

````markdown
# Single-instance deploy

One EC2 instance. Five long-running containers - `postgres`, `api`, `audit`, `ui`, and `caddy` for
automatic HTTPS - and two one-shot ones that run to completion on every deploy before the services
behind them start: `migrate` (the API's migrations and its `rch_app` role) and `audit-migrate` (the
audit schema and its `rch_audit` role). All three application images build from the same
`apps/api/Dockerfile` / `apps/audit/Dockerfile` / `UI/Dockerfile` the EKS path uses - this is a
second place to run them, not a second way to build them.

Caddy sends `/api/v1/admin/audit*` to `audit`, the rest of `/api/*` to `api`, `/readyz` to the API's
readiness check, `/readyz/audit` to the audit service's, and everything else to `ui`.

See `deploy/RUNBOOK.md`'s "Single-instance deploy (EC2 + Compose)" section for how the box
itself, its firewall, its fixed IP, its backup bucket and its DNS record were provisioned, and
for the full day-to-day operator's guide (deploying a new commit, reading logs, rotating keys,
restoring from a backup). This file is the quick version.

## First deploy, on the box

```bash
git clone <repo> rch && cd rch
cp deploy/compose/.env.example deploy/compose/.env
# fill in DOMAIN, POSTGRES_PASSWORD, APP_DB_PASSWORD and AUDIT_DB_PASSWORD (letters and digits:
# `openssl rand -hex 24`), JWT_PRIVATE_KEY/JWT_PUBLIC_KEY (pnpm --filter @rch/api keys:generate
# from any checkout with Node - the box does not need one), SEED_PASSWORD, BACKUP_BUCKET
deploy/compose/deploy.sh
```

## A later deploy

Automatic: when CI goes green on a push to `develop`, `.github/workflows/deploy-box.yml` runs
`release.sh <sha>` on the box through SSM. That script backs up, fast-forwards, runs `deploy.sh` and
checks `/readyz` and `/readyz/audit` (RUNBOOK §16.6). To redeploy or retry, run "Deploy (box)" from
the Actions tab. By hand, only if GitHub is down:

```bash
cd /opt/rch/app && git fetch origin
deploy/compose/release.sh <sha>
```

`deploy.sh` builds, brings the stack up in dependency order (Postgres, then `migrate`, then
`audit-migrate`, then the API, the audit service, the UI and Caddy), seeds only an empty database -
and then only `--bare`: the six locations and the `RC-0001` admin account (password
`SEED_PASSWORD`), never the demo hospital - and waits for the site to answer. Everything else
(staff, items, prices, menus, stock) is entered from the screens, and payers are loaded
from a CSV; `deploy/RUNBOOK.md` §1 has the order.

Operator CLIs run in the `migrate` container, which carries the superuser URL
(`MIGRATE_DATABASE_URL`); `api` connects as `rch_app` and cannot run them:

```bash
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yml run --rm --no-deps migrate dist/cli/<name>.mjs
```

## Nightly backup

`crontab -e` on the box, once:

```
30 21 * * * /opt/rch/app/deploy/compose/backup.sh >> /home/ubuntu/backup.log 2>&1
```

Dumps the database to the bucket named in `.env`'s `BACKUP_BUCKET` and purges expired
refresh tokens and idempotency keys - the same nightly job the EKS deploy ran as a CronJob.
The dump carries the `audit` schema; database roles are not in it, so after restoring one run
`migrate` and `audit-migrate` once to recreate `rch_app` and `rch_audit`. A daily whole-disk
snapshot (kept 7 days) runs independently via the account's DLM policy.
````


**`.github/workflows/deploy-box.yml`**:

Replace (block 1 of 2):
````yaml
      || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push'))
    runs-on: ubuntu-latest
    # The box builds both images itself (a few minutes on a t4g.medium), migrates and restarts.
    timeout-minutes: 45
    environment: { name: dev, url: "https://rch.hashtrickstechnologies.com" }
````
with:
````yaml
      || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push'))
    runs-on: ubuntu-latest
    # The box builds all three images itself (a few minutes on a t4g.medium), migrates and restarts.
    timeout-minutes: 45
    environment: { name: dev, url: "https://rch.hashtrickstechnologies.com" }
````

Replace (block 2 of 2):
````yaml
          [ -z "$err" ] || { echo "--- stderr"; echo "$err"; }
          [ "$status" = Success ] || { echo "::error::the release on the box ended $status"; exit 1; }
      - name: The site answers from outside
        run: |
          curl -fsS -m 10 --retry 5 --retry-delay 3 --retry-all-errors "$SITE/readyz"
          echo
          curl -fsS -m 10 -o /dev/null "$SITE/"
````
with:
````yaml
          [ -z "$err" ] || { echo "--- stderr"; echo "$err"; }
          [ "$status" = Success ] || { echo "::error::the release on the box ended $status"; exit 1; }
      # /readyz reaches the API and /readyz/audit the audit service (deploy/compose/Caddyfile), so
      # this is the database, both sets of migrations and the drainer, seen from the internet.
      - name: The site answers from outside
        run: |
          curl -fsS -m 10 --retry 5 --retry-delay 3 --retry-all-errors "$SITE/readyz"
          echo
          curl -fsS -m 10 --retry 5 --retry-delay 3 --retry-all-errors "$SITE/readyz/audit"
          echo
          curl -fsS -m 10 -o /dev/null "$SITE/"
````


- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log compose:test`
Expected: PASS - `compose.yml and the Caddyfile are well-formed`.

Run: `shellcheck /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/*.sh`
Expected: PASS - no output, exit 0.

Run: `actionlint /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/.github/workflows/deploy-box.yml`
(or, as CI does, `docker run --rm -v /Users/srimanikandanr/.superset/worktrees/RCH-audit-log:/repo -w /repo rhysd/actionlint:1.7.12 -color`)
Expected: PASS - no output.

Then the image and the stack on a real Postgres. The script builds the image, checks its layout,
and brings up `postgres`, `migrate`, `audit-migrate`, `api` and `audit` under the throwaway project
`rch-smoke` (no published ports, removed with its volume on exit). Docker may be absent; the script
then prints `SKIP` and exits 0, and CI's images job plus the kind install (Task 18) cover it.

````bash
cat > "${TMPDIR:-/tmp}/rch-task16-docker.sh" <<'SMOKE'
#!/usr/bin/env bash
# Builds the audit image and brings up the box's stack minus Caddy and the UI under a throwaway
# project name, to prove on a real Postgres what compose.test.sh can only prove on paper: the
# migrate steps create rch_app and rch_audit, the API serves as rch_app, the audit service as
# rch_audit, and an operator CLI runs through `migrate`. Needs a Docker daemon; says SKIP without.
set -euo pipefail
W=/Users/srimanikandanr/.superset/worktrees/RCH-audit-log
if ! docker info >/dev/null 2>&1; then
  echo "SKIP: no Docker daemon on this host - CI's images job builds apps/audit/Dockerfile and the kind install runs the chart"
  exit 0
fi

echo "== the audit image builds and has the runtime layout =="
docker build -f "$W/apps/audit/Dockerfile" -t rch-audit:local "$W"
docker run --rm rch-audit:local -e '
  const fs = require("node:fs");
  for (const p of ["dist/server.mjs", "dist/cli/migrate.mjs", "drizzle/meta/_journal.json", "/etc/ssl/rds-global-bundle.pem"]) fs.accessSync(p);
  console.log("layout ok", process.env.PORT, process.getuid());'

echo "== the compose stack, as the box runs it =="
smoke=$(mktemp -d)
c() { docker compose -p rch-smoke --env-file "$smoke/.env" -f "$W/deploy/compose/compose.yml" "$@"; }
finish() { c down -v >/dev/null 2>&1 || true; rm -rf "$smoke"; }
trap finish EXIT
{
  echo "DOMAIN=localhost"
  echo "POSTGRES_PASSWORD=smokesuper1"
  echo "APP_DB_PASSWORD=smokeapp1"
  echo "AUDIT_DB_PASSWORD=smokeaudit1"
  echo "SEED_PASSWORD=smoke-seed-password"
  pnpm --silent --dir "$W/apps/api" keys:generate
} > "$smoke/.env"
c build migrate audit-migrate
c up -d postgres migrate audit-migrate api audit
c run --rm --no-deps migrate dist/cli/seed.mjs --bare --yes-seed rch
curl_net() { docker run --rm --network rch-smoke_default curlimages/curl:8.11.1 -fsS --retry 30 --retry-delay 2 --retry-all-errors "$1"; }
curl_net http://api:3000/readyz; echo
curl_net http://audit:3100/readyz; echo
roles=$(c exec -T postgres psql -U rch -d rch -tAc "select string_agg(rolname, ',' order by rolname) from pg_roles where rolname in ('rch_app', 'rch_audit')")
[ "$roles" = "rch_app,rch_audit" ] || { echo "FAIL: expected rch_app,rch_audit, got '$roles'"; c logs migrate audit-migrate api audit; exit 1; }
echo "PASS: both roles exist; api and audit are ready on them; the seed ran through migrate"
SMOKE
````


Run: `bash "${TMPDIR:-/tmp}/rch-task16-docker.sh"`
Expected: `layout ok 3100 65532`, two JSON readiness answers, then `PASS: both roles exist; api and
audit are ready on them; the seed ran through migrate` - or `SKIP: no Docker daemon …`.

- [ ] **Step 5: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add apps/audit/Dockerfile deploy/compose/compose.yml deploy/compose/Caddyfile deploy/compose/compose.test.sh deploy/compose/.env.example deploy/compose/deploy.sh deploy/compose/backup.sh deploy/compose/release.sh deploy/compose/README.md .github/workflows/deploy-box.yml
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Run the audit service on the box and check both services are ready after a release

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

### Task 17: Helm chart, UI nginx and render tests

**Files:**
- Modify: `deploy/chart/rch/tests/render.test.sh`
- Modify: `deploy/chart/rch/Chart.yaml`
- Modify: `deploy/chart/rch/values.yaml`
- Modify: `deploy/chart/rch/values-dev.yaml`
- Modify: `deploy/chart/rch/values-staging.yaml`
- Modify: `deploy/chart/rch/values-prod.yaml`
- Modify: `deploy/chart/rch/ci/values-ci.yaml` (Note 8)
- Modify: `deploy/chart/rch/templates/_helpers.tpl` (whole file below)
- Modify: `deploy/chart/rch/templates/api-deployment.yaml`
- Modify: `deploy/chart/rch/templates/purge-cronjob.yaml`
- Create: `deploy/chart/rch/templates/audit-deployment.yaml`
- Create: `deploy/chart/rch/templates/audit-service.yaml`
- Create: `deploy/chart/rch/templates/audit-pdb.yaml`
- Modify: `deploy/chart/rch/templates/networkpolicy.yaml`
- Modify: `deploy/chart/rch/templates/ingress.yaml`
- Modify: `deploy/chart/rch/templates/servicemonitor.yaml`
- Modify: `deploy/chart/rch/templates/prometheusrule.yaml`
- Modify: `deploy/chart/rch/templates/ui-deployment.yaml`
- Modify: `deploy/chart/rch/templates/secret.yaml`
- Modify: `deploy/chart/rch/templates/externalsecret.yaml`
- Modify: `deploy/chart/rch/templates/NOTES.txt`
- Modify: `deploy/nginx/default.conf.template`
- Modify: `UI/Dockerfile`

**Interfaces:**
- Consumes: Task 16's `apps/audit/Dockerfile` (image `rch-audit`); the audit HTTP surface and
  metric names (Interface additions).
- Produces: the chart helpers and values above; the `<release>-audit` Deployment (initContainer
  `audit-migrate`, container `audit`), Service and PDB; `AUDIT_UPSTREAM` in the UI image and pods;
  alerts `AuditDrainLagging` and `AuditDeadLetters`. Task 18's CI install and `deploy.yml` rely on
  all of it.

The exact counts and ranges the render test asserts, and what each becomes:

| Assertion | Old | New | Why |
|---|---|---|---|
| `release: kube-prometheus-stack` in the monitoring render | `-ge 2` | `-ge 3` | a second ServiceMonitor (audit) |
| `readOnlyRootFilesystem: true` | `-ge 4` | `-ge 6` | `audit-migrate` and `audit` |
| migrate vs api `secretKeyRef` lines | identical | api = migrate minus `MIGRATE_DATABASE_URL` | the api container holds no superuser URL |
| `runbook_url:` in the monitoring render | `-ge 5` | `-ge 8` | two audit alerts |
| `automountServiceAccountToken: false` | `= 3` | `= 4` | the audit Deployment |
| `kind: NetworkPolicy` | `= 3` | `= 4` | the audit policy |
| `rch.io/tier: prod` | `= 2` | `= 3` | `audit.nodeSelector` in values-prod.yaml |
| `kind: PodDisruptionBudget` (prod) | `= 2` | `= 3` | `audit-pdb.yaml` at two replicas |
| D-min empty-key loop | 4 keys | 6 keys | `MIGRATE_DATABASE_URL`, `AUDIT_DATABASE_URL` |
| staging / dev `--set` secrets | 4 keys | 6 keys, one `$secret_set` string | the Secret refuses an empty key |
| `API_UPSTREAM` FQDN | asserted | still asserted, plus `AUDIT_UPSTREAM` FQDN | nginx's audit block |

New assertions: the audit Deployment renders with image `r/rch-audit:t`, initContainer
`audit-migrate` running `dist/cli/migrate.mjs`, `containerPort: 3100` and `PORT` `"3100"`; both
audit containers lack `JWT_PRIVATE_KEY`, `SEED_PASSWORD` and `key: DATABASE_URL`; only
`audit-migrate` holds `MIGRATE_DATABASE_URL`; the api container lacks `MIGRATE_DATABASE_URL` while
the migrate initContainer and the purge CronJob hold it; the audit Service carries
`component: audit`; the audit NetworkPolicy admits the ui pods on 3100; the ingress routes
`/api/v1/admin/audit` to `rch-audit:3100` on a line before `/api`; the nginx template has the audit
location with `$audit_upstream` and the forwarding headers; `UI/Dockerfile` sets
`AUDIT_UPSTREAM`; the monitoring render has both alerts, both metric names under
`job="rch-audit"` and the audit ServiceMonitor selecting `component: audit`.

- [ ] **Step 1: Write the failing check**

**`deploy/chart/rch/tests/render.test.sh`**:

Replace (block 1 of 17):
````bash
refute() { if "$@"; then echo "FAIL: unexpected match - $*" >&2; exit 1; fi; }

helm lint . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x,secrets.values.SEED_PASSWORD=x
helm lint . -f values-prod.yaml --set image.registry=r,image.tag=t

````
with:
````bash
refute() { if "$@"; then echo "FAIL: unexpected match - $*" >&2; exit 1; fi; }

# The six required keys of a values-built Secret (templates/secret.yaml), as dummies for every
# staging and dev render below. JWT_PREVIOUS_PUBLIC_KEY is the seventh and may be empty.
secret_set="secrets.values.DATABASE_URL=x,secrets.values.MIGRATE_DATABASE_URL=x,secrets.values.AUDIT_DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x,secrets.values.SEED_PASSWORD=x"

helm lint . -f values-staging.yaml --set "image.registry=r,image.tag=t,$secret_set"
helm lint . -f values-prod.yaml --set image.registry=r,image.tag=t

````

Replace (block 2 of 17):
````bash
# `release` label. The ServiceMonitor has always carried it; a PrometheusRule without it is
# applied happily and then loaded by nothing, which looks exactly like an alert that never fires.
[ "$(grep -c 'release: kube-prometheus-stack' <<<"$out_mon")" -ge 2 ]
# ...and every runbook link must be a URL somebody woken at three in the morning can open, not
# the chart's own <org>/<repo> placeholder.
````
with:
````bash
# `release` label. The ServiceMonitor has always carried it; a PrometheusRule without it is
# applied happily and then loaded by nothing, which looks exactly like an alert that never fires.
# Two ServiceMonitors (api, audit) and the one PrometheusRule.
[ "$(grep -c 'release: kube-prometheus-stack' <<<"$out_mon")" -ge 3 ]
# ...and every runbook link must be a URL somebody woken at three in the morning can open, not
# the chart's own <org>/<repo> placeholder.
````

Replace (block 3 of 17):
````bash
grep -q 'readOnlyRootFilesystem: true' <<<"$out"
# I12: api Deployment's migrate initContainer and api container, the purge
# CronJob and the ui Deployment must all run with a read-only root filesystem.
[ "$(grep -c 'readOnlyRootFilesystem: true' <<<"$out")" -ge 4 ]
# N2/N3: secret.yaml and externalsecret.yaml must be plain release resources -
# no helm.sh/hook annotations. A hook Secret/ExternalSecret is deleted at the
````
with:
````bash
grep -q 'readOnlyRootFilesystem: true' <<<"$out"
# I12: api Deployment's migrate initContainer and api container, the purge
# CronJob, the ui Deployment and the audit Deployment's audit-migrate initContainer and audit
# container must all run with a read-only root filesystem.
[ "$(grep -c 'readOnlyRootFilesystem: true' <<<"$out")" -ge 6 ]
# N2/N3: secret.yaml and externalsecret.yaml must be plain release resources -
# no helm.sh/hook annotations. A hook Secret/ExternalSecret is deleted at the
````

Replace (block 4 of 17):
````bash
refute bash -c 'grep -A2 "name: DATABASE_URL" <<<"$1" | grep -q "value:"' _ "$out"
grep -q 'secretKeyRef' <<<"$out"
# I: the api Deployment's migrate initContainer and its api container both
# build their env from rch.envList (see _helpers.tpl) so they can never drift.
# Guard the invariant directly: the secretKeyRef lines in each container's env
# block must be identical, in the same order.
init_secrets=$(sed -n '/name: migrate$/,/name: api$/p' <<<"$out" | grep 'secretKeyRef')
api_secrets=$(sed -n '/name: api$/,/readinessProbe:/p' <<<"$out" | grep 'secretKeyRef')
[ -n "$init_secrets" ]
[ "$init_secrets" = "$api_secrets" ]

# D1: SEED_PASSWORD is a Secret key, not an api.env entry. apps/api/src/config.ts has no default
````
with:
````bash
refute bash -c 'grep -A2 "name: DATABASE_URL" <<<"$1" | grep -q "value:"' _ "$out"
grep -q 'secretKeyRef' <<<"$out"
# I: the api Deployment's migrate initContainer and its api container build their env from the
# same rch.env helper (see _helpers.tpl), so they can never drift - with exactly one deliberate
# difference. The initContainer carries MIGRATE_DATABASE_URL, the superuser it migrates and
# creates rch_app with; the api container, which serves every request, must not. Guard both
# halves: the api's secretKeyRef lines are the initContainer's minus that one, in the same order.
init_secrets=$(sed -n '/name: migrate$/,/name: api$/p' <<<"$out" | grep 'secretKeyRef')
api_secrets=$(sed -n '/name: api$/,/readinessProbe:/p' <<<"$out" | grep 'secretKeyRef')
[ -n "$init_secrets" ]
[ "$(grep -c 'key: MIGRATE_DATABASE_URL' <<<"$init_secrets")" = 1 ] || { echo "the api migrate initContainer has no MIGRATE_DATABASE_URL secretKeyRef"; exit 1; }
refute grep -q 'key: MIGRATE_DATABASE_URL' <<<"$api_secrets"
[ "$(grep -v 'key: MIGRATE_DATABASE_URL' <<<"$init_secrets")" = "$api_secrets" ]
grep -q 'key: DATABASE_URL' <<<"$api_secrets"
# The purge CronJob is an operator CLI, so it connects as the superuser like the migrate step.
cronjob_env=$(sed -n '/# Source: rch\/templates\/purge-cronjob.yaml/,/^---$/p' <<<"$out")
grep -q 'key: MIGRATE_DATABASE_URL' <<<"$cronjob_env"

# The audit service (apps/audit): its own image, its own migrate initContainer, its own port.
audit_dep=$(sed -n '/# Source: rch\/templates\/audit-deployment.yaml/,/^---$/p' <<<"$out")
[ -n "$audit_dep" ] || { echo "no audit Deployment rendered"; exit 1; }
grep -q 'name: rch-audit,' <<<"$audit_dep"
grep -q 'image: r/rch-audit:t' <<<"$audit_dep"
grep -q 'name: audit-migrate$' <<<"$audit_dep"
sed -n '/name: audit-migrate$/,/name: audit$/p' <<<"$audit_dep" | grep -q 'args: \["dist/cli/migrate.mjs"\]'
grep -q 'containerPort: 3100' <<<"$audit_dep"
grep -q 'automountServiceAccountToken: false' <<<"$audit_dep"
grep -A4 '# Source: rch/templates/audit-service.yaml' <<<"$out" | grep -q 'component: audit'
# ...and least privilege for it: the audit containers verify tokens with the public keys and read
# their own role's URL. Neither ever holds the signing key, the seed password or the API's
# DATABASE_URL, and only the initContainer holds the superuser URL.
audit_init_env=$(sed -n '/name: audit-migrate$/,/name: audit$/p' <<<"$audit_dep")
audit_env=$(sed -n '/name: audit$/,/readinessProbe:/p' <<<"$audit_dep")
for k in MIGRATE_DATABASE_URL AUDIT_DATABASE_URL JWT_PUBLIC_KEY; do
  grep -q "key: $k" <<<"$audit_init_env" || { echo "audit-migrate has no $k secretKeyRef"; exit 1; }
done
for k in AUDIT_DATABASE_URL JWT_PUBLIC_KEY; do
  grep -q "key: $k" <<<"$audit_env" || { echo "the audit container has no $k secretKeyRef"; exit 1; }
done
grep -q 'key: JWT_PREVIOUS_PUBLIC_KEY, optional: true' <<<"$audit_env"
for block in "$audit_init_env" "$audit_env"; do
  refute grep -q 'JWT_PRIVATE_KEY' <<<"$block"
  refute grep -q 'SEED_PASSWORD' <<<"$block"
  refute grep -q 'key: DATABASE_URL' <<<"$block"
done
refute grep -q 'MIGRATE_DATABASE_URL' <<<"$audit_env"
grep -q 'name: PORT' <<<"$audit_env"
grep -A1 'name: PORT' <<<"$audit_env" | grep -q 'value: "3100"'

# D1: SEED_PASSWORD is a Secret key, not an api.env entry. apps/api/src/config.ts has no default
````

Replace (block 5 of 17):
````bash
# the alert text lives beside the metric it reads instead of only in the runbook.
grep -q 'kind: PrometheusRule' <<<"$out_mon"
for a in RchApiHigh5xxRate RchApiHighLatencyP95 RchApiDown RchApiPoolSaturated RchSseListenerDown RchApiCrashLooping; do
  grep -q "alert: $a" <<<"$out_mon" || { echo "missing alert: $a"; exit 1; }
done
````
with:
````bash
# the alert text lives beside the metric it reads instead of only in the runbook.
grep -q 'kind: PrometheusRule' <<<"$out_mon"
for a in RchApiHigh5xxRate RchApiHighLatencyP95 RchApiDown RchApiPoolSaturated RchSseListenerDown RchApiCrashLooping AuditDrainLagging AuditDeadLetters; do
  grep -q "alert: $a" <<<"$out_mon" || { echo "missing alert: $a"; exit 1; }
done
````

Replace (block 6 of 17):
````bash
# itself, so the crash-loop alert reads kube-state-metrics instead of this API's own registry.
grep -q 'kube_pod_container_status_restarts_total' <<<"$out_mon"
# Every alert carries a runbook link, so whoever is woken has somewhere to go.
[ "$(grep -c 'runbook_url:' <<<"$out_mon")" -ge 5 ]

# TLS must be wired, and must never render as an EMPTY annotation - the ALB controller reads
````
with:
````bash
# itself, so the crash-loop alert reads kube-state-metrics instead of this API's own registry.
grep -q 'kube_pod_container_status_restarts_total' <<<"$out_mon"
# The audit alerts read the audit service's own registry (apps/audit/src/plugins/metrics.ts),
# scraped by its own ServiceMonitor under job rch-audit.
grep -q 'audit_drain_lag_seconds{job="rch-audit"}' <<<"$out_mon"
grep -q 'audit_dead_letters_total{job="rch-audit"}' <<<"$out_mon"
grep -A3 'name: rch-audit, labels: { release:' <<<"$out_mon" | grep -q 'component: audit'
# Every alert carries a runbook link, so whoever is woken has somewhere to go.
[ "$(grep -c 'runbook_url:' <<<"$out_mon")" -ge 8 ]

# TLS must be wired, and must never render as an EMPTY annotation - the ALB controller reads
````

Replace (block 7 of 17):
````bash
# kernel OOM-kills the pod before Node ever decides a collection is due. 70% of the limit.
grep -q 'max-old-space-size=716' <<<"$out"
# Nothing in any of these three pods reads the Kubernetes API, so none of them needs a token
# mounted into it: api Deployment, ui Deployment, purge CronJob.
[ "$(grep -c 'automountServiceAccountToken: false' <<<"$out")" = 3 ]
# The nightly purge: bounded history, a deadline on a run that was missed (past 100 missed
# schedules the controller stops firing the CronJob for good), a bounded retry, a hard stop, and
````
with:
````bash
# kernel OOM-kills the pod before Node ever decides a collection is due. 70% of the limit.
grep -q 'max-old-space-size=716' <<<"$out"
# Nothing in any of these four pods reads the Kubernetes API, so none of them needs a token
# mounted into it: api Deployment, audit Deployment, ui Deployment, purge CronJob.
[ "$(grep -c 'automountServiceAccountToken: false' <<<"$out")" = 4 ]
# The nightly purge: bounded history, a deadline on a run that was missed (past 100 missed
# schedules the controller stops firing the CronJob for good), a bounded retry, a hard stop, and
````

Replace (block 8 of 17):
````bash
grep -q 'seccompProfile' <<<"$cronjob"
grep -q 'fsGroup: 65532' <<<"$cronjob"
# B6: default-deny ingress over everything this release runs, plus the two doors the chart needs.
[ "$(grep -c 'kind: NetworkPolicy' <<<"$out")" = 3 ]
np=$(sed -n '/# Source: rch\/templates\/networkpolicy.yaml/,/# Source: rch\/templates\/[^n]/p' <<<"$out")
[ -n "$np" ]
````
with:
````bash
grep -q 'seccompProfile' <<<"$cronjob"
grep -q 'fsGroup: 65532' <<<"$cronjob"
# B6: default-deny ingress over everything this release runs, plus the three doors the chart
# needs (api, audit, ui).
[ "$(grep -c 'kind: NetworkPolicy' <<<"$out")" = 4 ]
np=$(sed -n '/# Source: rch\/templates\/networkpolicy.yaml/,/# Source: rch\/templates\/[^n]/p' <<<"$out")
[ -n "$np" ]
````

Replace (block 9 of 17):
````bash
grep -q 'port: 3000' <<<"$np"
grep -q 'port: 8080' <<<"$np"
grep -q 'kubernetes.io/metadata.name: monitoring' <<<"$np"
# The ui->api hop is allowed by selector, not only by the CIDR that happens to cover it today -
````
with:
````bash
grep -q 'port: 3000' <<<"$np"
grep -q 'port: 8080' <<<"$np"
grep -q 'port: 3100' <<<"$np"
grep -q 'kubernetes.io/metadata.name: monitoring' <<<"$np"
# The ui->api hop is allowed by selector, not only by the CIDR that happens to cover it today -
````

Replace (block 10 of 17):
````bash
# leading `- ` is what distinguishes this `from:` entry from the ui policy's own target selector.
grep -qE '^ +- podSelector: \{ matchLabels: \{ app\.kubernetes\.io/instance: rch, app\.kubernetes\.io/component: ui \} \}' <<<"$np"
# Egress is left open on purpose: RDS is outside the cluster at an address this chart never sees.
grep -q 'egress: \[{}\]' <<<"$np"
````
with:
````bash
# leading `- ` is what distinguishes this `from:` entry from the ui policy's own target selector.
grep -qE '^ +- podSelector: \{ matchLabels: \{ app\.kubernetes\.io/instance: rch, app\.kubernetes\.io/component: ui \} \}' <<<"$np"
# ...and the ui->audit hop the same way: nginx proxies /api/v1/admin/audit to the audit Service.
audit_np=$(sed -n '/name: rch-audit, labels:/,/^---$/p' <<<"$np")
grep -qE '^ +- podSelector: \{ matchLabels: \{ app\.kubernetes\.io/instance: rch, app\.kubernetes\.io/component: ui \} \}' <<<"$audit_np"
grep -q 'port: 3100' <<<"$audit_np"
# Egress is left open on purpose: RDS is outside the cluster at an address this chart never sees.
grep -q 'egress: \[{}\]' <<<"$np"
````

Replace (block 11 of 17):
````bash
grep -q 'topologySpreadConstraints' <<<"$out"
# ...and so is the spread itself unless production's pods can only land on ng-prod, the
# on-demand node group (deploy/eksctl/cluster.yaml). Both Deployments must carry the selector;
# the group is deliberately untainted, so the label is the whole mechanism.
[ "$(grep -c 'rch.io/tier: prod' <<<"$out")" = 2 ]
# ...and the label the render asks for has to exist on a node group somebody can actually create.
# Nothing in this chart creates one: `eksctl create nodegroup -f deploy/eksctl/cluster.yaml
````
with:
````bash
grep -q 'topologySpreadConstraints' <<<"$out"
# ...and so is the spread itself unless production's pods can only land on ng-prod, the
# on-demand node group (deploy/eksctl/cluster.yaml). All three Deployments must carry the selector;
# the group is deliberately untainted, so the label is the whole mechanism.
[ "$(grep -c 'rch.io/tier: prod' <<<"$out")" = 3 ]
# ...and the label the render asks for has to exist on a node group somebody can actually create.
# Nothing in this chart creates one: `eksctl create nodegroup -f deploy/eksctl/cluster.yaml
````

Replace (block 12 of 17):
````bash
  || { echo "no node group's labels: line in deploy/eksctl/cluster.yaml carries $prod_selector - production's pods would stay Pending"; exit 1; }

# B3: both Deployments get a PodDisruptionBudget, and both say maxUnavailable rather than
# minAvailable - `minAvailable: N` at N replicas is a budget a drain can never satisfy, so
# `kubectl drain` waits on it for good, where `maxUnavailable: 1` stays satisfiable at every
# replica count above one.
[ "$(grep -c 'kind: PodDisruptionBudget' <<<"$out")" = 2 ]
grep -A4 '# Source: rch/templates/api-pdb.yaml' <<<"$out" | grep -q 'maxUnavailable: 1'
grep -A4 '# Source: rch/templates/ui-pdb.yaml' <<<"$out" | grep -q 'maxUnavailable: 1'
refute grep -q 'minAvailable' <<<"$out"
````
with:
````bash
  || { echo "no node group's labels: line in deploy/eksctl/cluster.yaml carries $prod_selector - production's pods would stay Pending"; exit 1; }

# B3: all three Deployments get a PodDisruptionBudget, and all say maxUnavailable rather than
# minAvailable - `minAvailable: N` at N replicas is a budget a drain can never satisfy, so
# `kubectl drain` waits on it for good, where `maxUnavailable: 1` stays satisfiable at every
# replica count above one.
[ "$(grep -c 'kind: PodDisruptionBudget' <<<"$out")" = 3 ]
grep -A4 '# Source: rch/templates/api-pdb.yaml' <<<"$out" | grep -q 'maxUnavailable: 1'
grep -A4 '# Source: rch/templates/audit-pdb.yaml' <<<"$out" | grep -q 'maxUnavailable: 1'
grep -A4 '# Source: rch/templates/ui-pdb.yaml' <<<"$out" | grep -q 'maxUnavailable: 1'
refute grep -q 'minAvailable' <<<"$out"
````

Replace (block 13 of 17):
````bash
# The alerts are off wherever the ServiceMonitor is off: a PrometheusRule with no Prometheus
# Operator installed is a CRD apply that fails the whole release.
out_staging_norule=$(helm template rch . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x,secrets.values.SEED_PASSWORD=x)
refute grep -q 'kind: PrometheusRule' <<<"$out_staging_norule"

out=$(helm template rch . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x,secrets.values.SEED_PASSWORD=x)
grep -q 'kind: Secret' <<<"$out"
refute grep -q 'helm.sh/hook:' <<<"$out"
````
with:
````bash
# The alerts are off wherever the ServiceMonitor is off: a PrometheusRule with no Prometheus
# Operator installed is a CRD apply that fails the whole release.
out_staging_norule=$(helm template rch . -f values-staging.yaml --set "image.registry=r,image.tag=t,$secret_set")
refute grep -q 'kind: PrometheusRule' <<<"$out_staging_norule"

out=$(helm template rch . -f values-staging.yaml --set "image.registry=r,image.tag=t,$secret_set")
grep -q 'kind: Secret' <<<"$out"
refute grep -q 'helm.sh/hook:' <<<"$out"
````

Replace (block 14 of 17):
````bash
# rejects. Staging had no such key until the Phase 6 fix wave, which is why it needs its own line.
refute grep -q 'certificate-arn: *$' <<<"$out"
out_staging_tls=$(helm template rch . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x,secrets.values.SEED_PASSWORD=x,ingress.certificateArn=arn:aws:acm:y)
grep -qE 'alb.ingress.kubernetes.io/certificate-arn: "?arn:aws:acm:y"?' <<<"$out_staging_tls"
# The pool size is an env knob now, not a literal in db/client.ts. Both files set it, and the
````
with:
````bash
# rejects. Staging had no such key until the Phase 6 fix wave, which is why it needs its own line.
refute grep -q 'certificate-arn: *$' <<<"$out"
out_staging_tls=$(helm template rch . -f values-staging.yaml --set "image.registry=r,image.tag=t,$secret_set,ingress.certificateArn=arn:aws:acm:y")
grep -qE 'alb.ingress.kubernetes.io/certificate-arn: "?arn:aws:acm:y"?' <<<"$out_staging_tls"
# The pool size is an env knob now, not a literal in db/client.ts. Both files set it, and the
````

Replace (block 15 of 17):
````bash

# D-min: on the `secrets.create=true` path a missing key must fail the render, not produce a
# Secret carrying "". values.yaml declares all five as "" so the shape is documented, and an
# empty string is not a missing key - the pod starts, config.ts refuses it and the migrate
# initContainer crash-loops. Production upgrades without `--atomic` (RUNBOOK §3), so that leaves
# the release in `pending-install`. Four of the five are required; JWT_PREVIOUS_PUBLIC_KEY is
# empty until the first rotation and must still render.
for key in DATABASE_URL JWT_PRIVATE_KEY JWT_PUBLIC_KEY SEED_PASSWORD; do
  args="image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x,secrets.values.SEED_PASSWORD=x"
  missing=$(helm template rch . -f values-staging.yaml --set "${args//secrets.values.$key=x/secrets.values.$key=}" 2>&1) && {
    echo "FAIL: the chart rendered a Secret with an empty $key"; exit 1; }
````
with:
````bash

# D-min: on the `secrets.create=true` path a missing key must fail the render, not produce a
# Secret carrying "". values.yaml declares all seven as "" so the shape is documented, and an
# empty string is not a missing key - the pod starts, config.ts refuses it and the migrate
# initContainer crash-loops. Production upgrades without `--atomic` (RUNBOOK §3), so that leaves
# the release in `pending-install`. Six of the seven are required; JWT_PREVIOUS_PUBLIC_KEY is
# empty until the first rotation and must still render.
for key in DATABASE_URL MIGRATE_DATABASE_URL AUDIT_DATABASE_URL JWT_PRIVATE_KEY JWT_PUBLIC_KEY SEED_PASSWORD; do
  args="image.registry=r,image.tag=t,$secret_set"
  missing=$(helm template rch . -f values-staging.yaml --set "${args//secrets.values.$key=x/secrets.values.$key=}" 2>&1) && {
    echo "FAIL: the chart rendered a Secret with an empty $key"; exit 1; }
````

Replace (block 16 of 17):
````bash
done
# ...and the one that may be empty still renders.
helm template rch . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x,secrets.values.SEED_PASSWORD=x,secrets.values.JWT_PREVIOUS_PUBLIC_KEY= >/dev/null

# ng-prod is production's alone: staging sets no nodeSelector, so its pods keep landing on the
````
with:
````bash
done
# ...and the one that may be empty still renders.
helm template rch . -f values-staging.yaml --set "image.registry=r,image.tag=t,$secret_set,secrets.values.JWT_PREVIOUS_PUBLIC_KEY=" >/dev/null

# ng-prod is production's alone: staging sets no nodeSelector, so its pods keep landing on the
````

Replace (block 17 of 17):
````bash
grep -q 'value: http://rch-api.default.svc.cluster.local:3000' <<<"$out" || { echo "API_UPSTREAM must be the API Service's FQDN (<release>-api.<namespace>.svc.cluster.local)"; exit 1; }
refute grep -qE 'API_UPSTREAM, value: http://rch-api:3000' <<<"$out"

# B6: values-dev.yaml is the one environment that actually runs, and until now nothing linted or
# rendered it. Everything below is the dev leg.
dev_args=(--set image.registry=r --set image.tag=t
  --set-string secrets.values.DATABASE_URL=x --set-string secrets.values.JWT_PRIVATE_KEY=x
  --set-string secrets.values.JWT_PUBLIC_KEY=x --set-string secrets.values.SEED_PASSWORD=x)
helm lint . -f values-dev.yaml "${dev_args[@]}"
out_dev=$(helm template rch . -f values-dev.yaml "${dev_args[@]}")
# B3: one api pod and one ui pod. A PodDisruptionBudget of any shape over a single pod means that
# pod may never be evicted, so the node under it may never be drained - which on a one-node spot
# cluster is every node.
refute grep -q 'kind: PodDisruptionBudget' <<<"$out_dev"
# B6: the heap ceiling is per values file, against that file's own memory limit - dev inherits
````
with:
````bash
grep -q 'value: http://rch-api.default.svc.cluster.local:3000' <<<"$out" || { echo "API_UPSTREAM must be the API Service's FQDN (<release>-api.<namespace>.svc.cluster.local)"; exit 1; }
refute grep -qE 'API_UPSTREAM, value: http://rch-api:3000' <<<"$out"
# ...and the audit Service the same way, for nginx's /api/v1/admin/audit block.
grep -q 'name: AUDIT_UPSTREAM, value: http://rch-audit.default.svc.cluster.local:3100' <<<"$out" \
  || { echo "AUDIT_UPSTREAM must be the audit Service's FQDN (<release>-audit.<namespace>.svc.cluster.local)"; exit 1; }
grep -q 'location /api/v1/admin/audit' ../../nginx/default.conf.template
grep -q 'set \$audit_upstream \${AUDIT_UPSTREAM};' ../../nginx/default.conf.template
audit_block=$(sed -n '/location \/api\/v1\/admin\/audit/,/^  }/p' ../../nginx/default.conf.template)
grep -q 'proxy_set_header X-Request-Id \$req_id' <<<"$audit_block"
grep -q 'proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for' <<<"$audit_block"
# The image's own default. envsubst leaves an unset variable in the rendered config as a literal,
# nginx starts anyway, and every audit read then fails - so the image has to carry one.
grep -q '^ENV AUDIT_UPSTREAM=http://rch-audit:3100$' ../../../UI/Dockerfile
# The ingress sends the audit reads to the audit Service, and lists them BEFORE /api: the load
# balancer controller turns the paths into rules in order, and /api would otherwise win.
ingress=$(helm template rch . -f values-staging.yaml --set "image.registry=r,image.tag=t,$secret_set" --show-only templates/ingress.yaml)
audit_path=$(grep -n 'path: /api/v1/admin/audit, pathType: Prefix, backend: { service: { name: rch-audit, port: { number: 3100 }' <<<"$ingress" | cut -d: -f1)
api_path=$(grep -n 'path: /api, pathType: Prefix' <<<"$ingress" | cut -d: -f1)
if [ -z "$audit_path" ] || [ -z "$api_path" ] || [ "$audit_path" -ge "$api_path" ]; then
  echo "the ingress must route /api/v1/admin/audit to rch-audit:3100 ahead of /api"; exit 1
fi

# B6: values-dev.yaml is the one environment that actually runs, and until now nothing linted or
# rendered it. Everything below is the dev leg.
dev_args=(--set image.registry=r --set image.tag=t
  --set-string secrets.values.DATABASE_URL=x --set-string secrets.values.MIGRATE_DATABASE_URL=x
  --set-string secrets.values.AUDIT_DATABASE_URL=x --set-string secrets.values.JWT_PRIVATE_KEY=x
  --set-string secrets.values.JWT_PUBLIC_KEY=x --set-string secrets.values.SEED_PASSWORD=x)
helm lint . -f values-dev.yaml "${dev_args[@]}"
out_dev=$(helm template rch . -f values-dev.yaml "${dev_args[@]}")
# B3: one api pod, one audit pod and one ui pod. A PodDisruptionBudget of any shape over a single
# pod means that pod may never be evicted, so the node under it may never be drained - which on a
# one-node spot cluster is every node.
refute grep -q 'kind: PodDisruptionBudget' <<<"$out_dev"
# B6: the heap ceiling is per values file, against that file's own memory limit - dev inherits
````


- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log helm:test`
Expected: FAIL - exit 1 with no `chart renders` line. The first assertion to fail (visible with
`bash -x deploy/chart/rch/tests/render.test.sh`) is the release-label count, `[ 2 -ge 3 ]`.

- [ ] **Step 3: Implement**

**`deploy/chart/rch/templates/_helpers.tpl`** - the whole file. `rch.envList` gives way to one
generic `rch.env` and four per-component lists:

````gotemplate
{{- define "rch.name" -}}{{ .Chart.Name }}{{- end -}}
{{- /*
rch.labels renders as a single comma-joined line (not one key per line) because
every call site embeds it inside a flow-style `{ ... }` mapping - YAML flow
mappings need commas between entries, not bare newlines.
*/ -}}
{{- define "rch.labels" -}}
app.kubernetes.io/name: {{ include "rch.name" . }}, app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/version: {{ .Values.image.tag | quote }}, app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "rch.image" -}}{{ if .registry }}{{ .registry }}/{{ end }}{{ .name }}:{{ .tag }}{{- end -}}
{{- define "rch.secretName" -}}{{ .Release.Name }}-secrets{{- end -}}
{{- define "rch.sa" -}}{{ if .Values.serviceAccount.create }}{{ .Release.Name }}{{ else }}default{{ end }}{{- end -}}
{{- /*
rch.env renders an explicit `env:` list: NODE_ENV, PORT, one plain `value:` per entry of a
component's env map, then one secretKeyRef per secret key the container is allowed to read. It
is called only through the four per-component lists below, so each container names exactly the
secrets it uses and nothing else - the long-running api holds no superuser URL, and neither audit
container ever sees JWT_PRIVATE_KEY or SEED_PASSWORD. Non-secret settings are inlined rather than
read from a ConfigMap, so the pod's checksum/config annotation hashes what the container reads.

  rch.apiEnv          the api container                  DATABASE_URL (rch_app), JWT_PRIVATE_KEY,
                                                         JWT_PUBLIC_KEY, JWT_PREVIOUS_PUBLIC_KEY,
                                                         SEED_PASSWORD
  rch.apiCliEnv       the api pod's migrate initContainer MIGRATE_DATABASE_URL (rch) + everything
                      and the purge CronJob              rch.apiEnv names
  rch.auditEnv        the audit container                AUDIT_DATABASE_URL (rch_audit),
                                                         JWT_PUBLIC_KEY, JWT_PREVIOUS_PUBLIC_KEY
  rch.auditMigrateEnv the audit pod's audit-migrate      MIGRATE_DATABASE_URL (rch) + everything
                      initContainer                      rch.auditEnv names

The API's CLIs connect with MIGRATE_DATABASE_URL and read the runtime role's name and password
from DATABASE_URL; the audit migrate CLI reads them from AUDIT_DATABASE_URL.

Every secret is ALWAYS wired via valueFrom.secretKeyRef against the Secret named by
rch.secretName - never inlined as a plaintext `value:`. .Values.secrets.create only decides
whether secret.yaml renders that Secret from values (staging/dev);
.Values.secrets.externalSecret.enabled decides whether externalsecret.yaml renders an
ExternalSecret that has the External Secrets Operator sync the same Secret name from the external
store (prod). Either way the consuming containers read the same secretKeyRef, so which template
produced the Secret is invisible to them. Both secret.yaml and externalsecret.yaml are plain
release resources (no helm.sh/hook annotations) - see those templates for why turning them into
hooks was tried and reverted.

JWT_PREVIOUS_PUBLIC_KEY is the ONE optional: true key, because it is only populated during a
key-rotation window; outside of that window the key legitimately does not exist in the Secret.
Every other key is required, and a pod that cannot find one must fail to start rather than come
up half-configured - so the `if eq` below names exactly one key. Go's `eq` is variadic (`eq $k "a"
"b"` is true for either), so adding a second name there silently makes that key optional too;
render.test.sh asserts SEED_PASSWORD never renders `optional`.

SEED_PASSWORD has no default in apps/api/src/config.ts, so the api container will not start
without it - it is a secret key rather than an api.env entry because it is the password the six
seeded accounts start on, and a published default would be the same password on every host that
ever ran the seed. The seed itself is a CLI run by hand inside the container (RUNBOOK §11), never
part of a rollout; what the env entry buys is that the password is in the Secret rather than in a
shell history.
*/ -}}
{{- define "rch.env" -}}
- name: NODE_ENV
  value: production
- name: PORT
  value: {{ .port | quote }}
{{- range $k, $v := .env }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- range $k := .keys }}
- name: {{ $k }}
  valueFrom:
    secretKeyRef: { name: {{ include "rch.secretName" $.root }}, key: {{ $k }}{{ if eq $k "JWT_PREVIOUS_PUBLIC_KEY" }}, optional: true{{ end }} }
{{- end }}
{{- end -}}
{{- define "rch.apiEnv" -}}
{{ include "rch.env" (dict "root" . "port" 3000 "env" .Values.api.env "keys" (list "DATABASE_URL" "JWT_PRIVATE_KEY" "JWT_PUBLIC_KEY" "JWT_PREVIOUS_PUBLIC_KEY" "SEED_PASSWORD")) }}
{{- end -}}
{{- define "rch.apiCliEnv" -}}
{{ include "rch.env" (dict "root" . "port" 3000 "env" .Values.api.env "keys" (list "MIGRATE_DATABASE_URL" "DATABASE_URL" "JWT_PRIVATE_KEY" "JWT_PUBLIC_KEY" "JWT_PREVIOUS_PUBLIC_KEY" "SEED_PASSWORD")) }}
{{- end -}}
{{- define "rch.auditEnv" -}}
{{ include "rch.env" (dict "root" . "port" 3100 "env" .Values.audit.env "keys" (list "AUDIT_DATABASE_URL" "JWT_PUBLIC_KEY" "JWT_PREVIOUS_PUBLIC_KEY")) }}
{{- end -}}
{{- define "rch.auditMigrateEnv" -}}
{{ include "rch.env" (dict "root" . "port" 3100 "env" .Values.audit.env "keys" (list "MIGRATE_DATABASE_URL" "AUDIT_DATABASE_URL" "JWT_PUBLIC_KEY" "JWT_PREVIOUS_PUBLIC_KEY")) }}
{{- end -}}
````


**`deploy/chart/rch/templates/api-deployment.yaml`**:

Replace (block 1 of 3):
````yaml
      # The configuration the containers actually read, hashed, so changing a value in api.env
      # rolls the pods. It used to hash templates/configmap.yaml - a ConfigMap nothing mounted
      # or referenced, because rch.envList inlines every one of those values into each
      # container's own env list - so the annotation moved when that template's rendering moved
      # and stood still when the configuration changed shape around it.
      annotations: { checksum/config: {{ toYaml .Values.api.env | sha256sum }} }
    spec:
````
with:
````yaml
      # The configuration the containers actually read, hashed, so changing a value in api.env
      # rolls the pods. It used to hash templates/configmap.yaml - a ConfigMap nothing mounted
      # or referenced, because the env helpers in _helpers.tpl inline every one of those values
      # into each container's own env list - so the annotation moved when that template's
      # rendering moved and stood still when the configuration changed shape around it.
      annotations: { checksum/config: {{ toYaml .Values.api.env | sha256sum }} }
    spec:
````

Replace (block 2 of 3):
````yaml
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          args: ["dist/cli/migrate.mjs"]
          env:
            {{- include "rch.envList" . | nindent 12 }}
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
          resources: { requests: { cpu: 100m, memory: 128Mi }, limits: { cpu: 500m, memory: 256Mi } }
````
with:
````yaml
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          args: ["dist/cli/migrate.mjs"]
          # The superuser URL, for the migrations and the rch_app role setup; the runtime role's
          # name and password come from DATABASE_URL beside it (templates/_helpers.tpl).
          env:
            {{- include "rch.apiCliEnv" . | nindent 12 }}
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
          resources: { requests: { cpu: 100m, memory: 128Mi }, limits: { cpu: 500m, memory: 256Mi } }
````

Replace (block 3 of 3):
````yaml
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports: [{ name: http, containerPort: 3000 }]
          env:
            {{- include "rch.envList" . | nindent 12 }}
          resources: {{- toYaml .Values.api.resources | nindent 12 }}
          readinessProbe: { httpGet: { path: /readyz, port: http }, periodSeconds: 5, failureThreshold: 3 }
````
with:
````yaml
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports: [{ name: http, containerPort: 3000 }]
          # rch_app only: no MIGRATE_DATABASE_URL, so nothing the serving process holds can alter
          # a grant, a trigger or the audit log.
          env:
            {{- include "rch.apiEnv" . | nindent 12 }}
          resources: {{- toYaml .Values.api.resources | nindent 12 }}
          readinessProbe: { httpGet: { path: /readyz, port: http }, periodSeconds: 5, failureThreshold: 3 }
````


**`deploy/chart/rch/templates/purge-cronjob.yaml`**:

Replace (block 1 of 1):
````yaml
              image: {{ include "rch.image" (dict "registry" .Values.image.registry "name" .Values.image.api "tag" .Values.image.tag) }}
              args: ["dist/cli/purge.mjs"]
              env:
                {{- include "rch.envList" . | nindent 16 }}
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
              resources: { requests: { cpu: 100m, memory: 128Mi }, limits: { cpu: 500m, memory: 256Mi } }
````
with:
````yaml
              image: {{ include "rch.image" (dict "registry" .Values.image.registry "name" .Values.image.api "tag" .Values.image.tag) }}
              args: ["dist/cli/purge.mjs"]
              # An operator CLI, so it connects with MIGRATE_DATABASE_URL like the migrate step.
              env:
                {{- include "rch.apiCliEnv" . | nindent 16 }}
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
              resources: { requests: { cpu: 100m, memory: 128Mi }, limits: { cpu: 500m, memory: 256Mi } }
````


**`deploy/chart/rch/templates/audit-deployment.yaml`** (new):

````yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: {{ .Release.Name }}-audit, labels: { {{- include "rch.labels" . | nindent 4 }}, app.kubernetes.io/component: audit } }
spec:
  replicas: {{ .Values.audit.replicas }}
  strategy: { type: RollingUpdate, rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } }
  selector: { matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/component: audit } }
  template:
    metadata:
      labels: { {{- include "rch.labels" . | nindent 8 }}, app.kubernetes.io/component: audit }
      # The same reasoning as api-deployment.yaml: hash what the containers read, so changing a
      # value in audit.env rolls the pods.
      annotations: { checksum/config: {{ toYaml .Values.audit.env | sha256sum }} }
    spec:
      serviceAccountName: {{ include "rch.sa" . }}
      # Nothing in this pod reads the Kubernetes API.
      automountServiceAccountToken: false
      # The api pod's number, for the same load balancer: the target group's 30s deregistration
      # delay has to fit inside the grace period with the process's own drain after it.
      terminationGracePeriodSeconds: 60
      securityContext: { runAsNonRoot: true, runAsUser: 65532, fsGroup: 65532, seccompProfile: { type: RuntimeDefault } }
      {{- with .Values.audit.nodeSelector }}
      # values-prod.yaml pins production to the on-demand ng-prod node group, as it does the api.
      nodeSelector: {{- toYaml . | nindent 8 }}
      {{- end }}
      # The audit schema's migrations and the rch_audit role, as an initContainer for the reasons
      # api-deployment.yaml gives. Its migrations hold advisory lock 727273, so replicas serialise;
      # its role and grant step also holds the API migrate step's 727272, so grants on audit_outbox
      # never interleave with the API's. It waits for audit_outbox, which the api pod's own migrate
      # step creates, so the two Deployments may start in either order (exit 3 if it never appears
      # within 5 minutes, 2 on a bad environment).
      initContainers:
        - name: audit-migrate
          image: {{ include "rch.image" (dict "registry" .Values.image.registry "name" .Values.image.audit "tag" .Values.image.tag) }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          args: ["dist/cli/migrate.mjs"]
          env:
            {{- include "rch.auditMigrateEnv" . | nindent 12 }}
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
          resources: { requests: { cpu: 50m, memory: 96Mi }, limits: { cpu: 500m, memory: 256Mi } }
      containers:
        - name: audit
          image: {{ include "rch.image" (dict "registry" .Values.image.registry "name" .Values.image.audit "tag" .Values.image.tag) }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports: [{ name: http, containerPort: 3100 }]
          env:
            {{- include "rch.auditEnv" . | nindent 12 }}
          resources: {{- toYaml .Values.audit.resources | nindent 12 }}
          # /readyz answers 503 unless the database answers, every audit migration is applied and
          # the drainer made a pass in the last 30 seconds.
          readinessProbe: { httpGet: { path: /readyz, port: http }, periodSeconds: 5, failureThreshold: 3 }
          livenessProbe: { httpGet: { path: /healthz, port: http }, periodSeconds: 10, failureThreshold: 3 }
          startupProbe: { httpGet: { path: /healthz, port: http }, periodSeconds: 2, failureThreshold: 30 }
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
````


**`deploy/chart/rch/templates/audit-service.yaml`** (new):

````yaml
apiVersion: v1
kind: Service
metadata: { name: {{ .Release.Name }}-audit, labels: { {{- include "rch.labels" . | nindent 4 }}, app.kubernetes.io/component: audit } }
spec: { selector: { app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/component: audit }, ports: [{ name: http, port: 3100, targetPort: http }] }
````


**`deploy/chart/rch/templates/audit-pdb.yaml`** (new):

````yaml
{{- if gt (int .Values.audit.replicas) 1 }}
{{- /* Same shape and same reasoning as api-pdb.yaml - see the comment there. */ -}}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: {{ .Release.Name }}-audit }
spec: { maxUnavailable: {{ .Values.audit.pdb.maxUnavailable }}, selector: { matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/component: audit } } }
{{- end }}
````


**`deploy/chart/rch/values.yaml`**:

Replace (block 1 of 4):
````yaml
  api: rch-api
  ui: rch-ui
  tag: latest
  pullPolicy: IfNotPresent
````
with:
````yaml
  api: rch-api
  ui: rch-ui
  audit: rch-audit
  tag: latest
  pullPolicy: IfNotPresent
````

Replace (block 2 of 4):
````yaml
  resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { cpu: 200m, memory: 128Mi } }
  pdb: { maxUnavailable: 1 }
ingress:
  enabled: true
````
with:
````yaml
  resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { cpu: 200m, memory: 128Mi } }
  pdb: { maxUnavailable: 1 }
# The audit service (apps/audit): drains the API's audit outbox into the audit schema and serves
# the admin page's Audit log tab. Two replicas drain side by side (`for update skip locked`).
audit:
  replicas: 2
  resources: { requests: { cpu: 50m, memory: 128Mi }, limits: { cpu: 500m, memory: 256Mi } }
  pdb: { maxUnavailable: 1 }
  env:
    LOG_LEVEL: info
    DATABASE_SSL: "true"
    # The drainer holds one pooled connection per pass and a read holds one per request, plus the
    # LISTEN client outside the pool.
    DB_POOL_MAX: "5"
    # One hop: the ALB reaches this pod directly on /api/v1/admin/audit (templates/ingress.yaml).
    TRUST_PROXY: "1"
    # The audit store's own schema; the schema whose `rch_events_<schema>` channel the API listens
    # on, and the schema holding audit_outbox - both `public` wherever the API's tables are.
    AUDIT_SCHEMA: audit
    EVENTS_SCHEMA: public
    OUTBOX_SCHEMA: public
    # 70% of audit.resources.limits.memory above (256Mi → 179); see api.env's NODE_OPTIONS.
    NODE_OPTIONS: "--max-old-space-size=179"
ingress:
  enabled: true
````

Replace (block 3 of 4):
````yaml
secrets:
  create: false           # true: build the Secret from the values below (staging, dev)
  # SEED_PASSWORD is the password the six seeded accounts start on; apps/api/src/config.ts has no
  # default for it, so the api container will not start until it is set.
  values: { DATABASE_URL: "", JWT_PRIVATE_KEY: "", JWT_PUBLIC_KEY: "", JWT_PREVIOUS_PUBLIC_KEY: "", SEED_PASSWORD: "" }
  externalSecret:
    enabled: false        # true: sync from AWS Secrets Manager via External Secrets Operator (prod)
    storeName: aws-secrets-manager
    storeKind: ClusterSecretStore
    remoteKey: rch/prod   # JSON secret with the five keys above
serviceAccount:
  create: true
````
with:
````yaml
secrets:
  create: false           # true: build the Secret from the values below (staging, dev)
  # Three database URLs, one per role (templates/_helpers.tpl names which container reads which):
  #   DATABASE_URL          the API's runtime role, rch_app - postgres://rch_app:<password>@<host>:5432/rch
  #   MIGRATE_DATABASE_URL  the superuser, rch - the migrate initContainers and the purge CronJob only
  #   AUDIT_DATABASE_URL    the audit service's runtime role, rch_audit
  # Each migrate step creates its runtime role from the user and password in that role's URL, so
  # the passwords are chosen here and nowhere else.
  # SEED_PASSWORD is the password the six seeded accounts start on; apps/api/src/config.ts has no
  # default for it, so the api container will not start until it is set.
  values: { DATABASE_URL: "", MIGRATE_DATABASE_URL: "", AUDIT_DATABASE_URL: "", JWT_PRIVATE_KEY: "", JWT_PUBLIC_KEY: "", JWT_PREVIOUS_PUBLIC_KEY: "", SEED_PASSWORD: "" }
  externalSecret:
    enabled: false        # true: sync from AWS Secrets Manager via External Secrets Operator (prod)
    storeName: aws-secrets-manager
    storeKind: ClusterSecretStore
    remoteKey: rch/prod   # JSON secret with the seven keys above
serviceAccount:
  create: true
````

Replace (block 4 of 4):
````yaml
  runbookUrl: https://github.com/Hashtricks-Technologies/RCH/blob/production/deploy/RUNBOOK.md
purge: { enabled: true, schedule: "15 2 * * *" }
# Default-deny ingress for everything this release runs, with the three doors the chart actually
# needs opened by name (templates/networkpolicy.yaml - read its header before narrowing anything).
# Egress stays wide open: RDS is outside the cluster at an address this chart does not know.
````
with:
````yaml
  runbookUrl: https://github.com/Hashtricks-Technologies/RCH/blob/production/deploy/RUNBOOK.md
purge: { enabled: true, schedule: "15 2 * * *" }
# Default-deny ingress for everything this release runs, with the doors the chart actually
# needs opened by name (templates/networkpolicy.yaml - read its header before narrowing anything).
# Egress stays wide open: RDS is outside the cluster at an address this chart does not know.
````


**`deploy/chart/rch/values-dev.yaml`**:

Replace (block 1 of 1):
````yaml
api: { replicas: 1, hpa: { enabled: false }, env: { LOG_LEVEL: debug, CORS_ORIGIN: https://rch.hashtrickstechnologies.com, DB_POOL_MAX: "10" } }
ui: { replicas: 1 }
ingress: { host: rch.hashtrickstechnologies.com, certificateArn: arn:aws:acm:ap-south-1:830283280199:certificate/68a3b4db-2bfe-449a-8b79-8201a30bde0c }
secrets: { create: true }
````
with:
````yaml
api: { replicas: 1, hpa: { enabled: false }, env: { LOG_LEVEL: debug, CORS_ORIGIN: https://rch.hashtrickstechnologies.com, DB_POOL_MAX: "10" } }
ui: { replicas: 1 }
audit: { replicas: 1 }
ingress: { host: rch.hashtrickstechnologies.com, certificateArn: arn:aws:acm:ap-south-1:830283280199:certificate/68a3b4db-2bfe-449a-8b79-8201a30bde0c }
secrets: { create: true }
````


**`deploy/chart/rch/values-staging.yaml`**:

Replace (block 1 of 1):
````yaml
api: { replicas: 2, hpa: { minReplicas: 2, maxReplicas: 3 }, env: { LOG_LEVEL: debug, CORS_ORIGIN: https://rch-staging.hashtrickstechnologies.com, DB_POOL_MAX: "10" } }
ui: { replicas: 1 }
# Staging runs at rch-staging.hashtrickstechnologies.com (Route 53 zone hashtrickstechnologies.com,
# account 830283280199, ap-south-1); the ACM certificate below is DNS-validated in that zone.
````
with:
````yaml
api: { replicas: 2, hpa: { minReplicas: 2, maxReplicas: 3 }, env: { LOG_LEVEL: debug, CORS_ORIGIN: https://rch-staging.hashtrickstechnologies.com, DB_POOL_MAX: "10" } }
ui: { replicas: 1 }
audit: { replicas: 1 }
# Staging runs at rch-staging.hashtrickstechnologies.com (Route 53 zone hashtrickstechnologies.com,
# account 830283280199, ap-south-1); the ACM certificate below is DNS-validated in that zone.
````


**`deploy/chart/rch/values-prod.yaml`**:

Replace (block 1 of 2):
````yaml
  resources: { requests: { cpu: 100m, memory: 128Mi }, limits: { cpu: 500m, memory: 256Mi } }
  pdb: { maxUnavailable: 1 }
ingress:
  enabled: true
````
with:
````yaml
  resources: { requests: { cpu: 100m, memory: 128Mi }, limits: { cpu: 500m, memory: 256Mi } }
  pdb: { maxUnavailable: 1 }
audit:
  replicas: 2
  nodeSelector: { rch.io/tier: prod }
  resources: { requests: { cpu: 100m, memory: 256Mi }, limits: { cpu: "1", memory: 512Mi } }
  pdb: { maxUnavailable: 1 }
  env:
    LOG_LEVEL: info
    DATABASE_SSL: "true"
    DB_POOL_MAX: "5"                              # two replicas × 5 beside the API's 30
    TRUST_PROXY: "1"
    AUDIT_SCHEMA: audit
    EVENTS_SCHEMA: public
    OUTBOX_SCHEMA: public
    NODE_OPTIONS: "--max-old-space-size=358"      # 70% of the 512Mi limit above
ingress:
  enabled: true
````

Replace (block 2 of 2):
````yaml
    storeName: aws-secrets-manager
    storeKind: ClusterSecretStore
    remoteKey: rch/prod                           # a JSON secret with the five keys (SEED_PASSWORD included)
serviceAccount:
  create: true
````
with:
````yaml
    storeName: aws-secrets-manager
    storeKind: ClusterSecretStore
    remoteKey: rch/prod                           # a JSON secret with the seven keys (both role URLs, MIGRATE_DATABASE_URL and SEED_PASSWORD included)
serviceAccount:
  create: true
````


**`deploy/chart/rch/ci/values-ci.yaml`** (fixed CI passwords for the two runtime roles; `rch` is
`ci/postgres.yaml`'s superuser):

Replace (block 1 of 2):
````yaml
ui:
  replicas: 1
ingress:
  enabled: false
````
with:
````yaml
ui:
  replicas: 1
audit:
  replicas: 1
  resources: { requests: { cpu: 50m, memory: 96Mi }, limits: { cpu: 500m, memory: 256Mi } }
  env:
    DATABASE_SSL: "false"
ingress:
  enabled: false
````

Replace (block 2 of 2):
````yaml
  create: true
  values:
    DATABASE_URL: postgres://rch:rch@postgres:5432/rch
    JWT_PREVIOUS_PUBLIC_KEY: ""
serviceMonitor:
````
with:
````yaml
  create: true
  values:
    # Three roles, as in every real environment: the migrate steps connect as the superuser and
    # create rch_app and rch_audit from the users and passwords in the two runtime URLs.
    MIGRATE_DATABASE_URL: postgres://rch:rch@postgres:5432/rch
    DATABASE_URL: postgres://rch_app:ci-app-password@postgres:5432/rch
    AUDIT_DATABASE_URL: postgres://rch_audit:ci-audit-password@postgres:5432/rch
    JWT_PREVIOUS_PUBLIC_KEY: ""
serviceMonitor:
````


**`deploy/chart/rch/templates/networkpolicy.yaml`** (ingress-only, Note 5):

Replace (block 1 of 3):
````yaml
policy that is correct and waiting.

Three policies, because NetworkPolicies are additive: the first closes everything this release
runs, the other two open exactly the doors the chart needs. A pod selected by no policy at all is
wide open, so the deny has to select the release itself rather than name each component.

````
with:
````yaml
policy that is correct and waiting.

Four policies, because NetworkPolicies are additive: the first closes everything this release
runs, the other three (api, audit, ui) open exactly the doors the chart needs. A pod selected by no policy at all is
wide open, so the deny has to select the release itself rather than name each component.

````

Replace (block 2 of 3):
````yaml
defaults to 0.0.0.0/0 and should be narrowed to the VPC CIDR wherever that is known. What is
bought by all this is real but modest: every OTHER port on these pods is shut, a pod of this
release that is not the api or the ui is reachable by nothing, and the two rules that name a
source - the ui talking to the api, and the monitoring namespace scraping it - are the record of
who is supposed to be talking, so the day the ALB is given a security-group source (or /metrics
is moved off port 3000 onto its own) the narrowing is one line.

````
with:
````yaml
defaults to 0.0.0.0/0 and should be narrowed to the VPC CIDR wherever that is known. What is
bought by all this is real but modest: every OTHER port on these pods is shut, a pod of this
release that is not the api, the audit service or the ui is reachable by nothing, and the rules
that name a source - the ui talking to the api and to the audit service, and the monitoring
namespace scraping both - are the record of who is supposed to be talking, so the day the ALB is given a security-group source (or /metrics
is moved off port 3000 onto its own) the narrowing is one line.

````

Replace (block 3 of 3):
````yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: {{ .Release.Name }}-ui, labels: { {{- include "rch.labels" . | nindent 4 }}, app.kubernetes.io/component: ui } }
spec:
````
with:
````yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: {{ .Release.Name }}-audit, labels: { {{- include "rch.labels" . | nindent 4 }}, app.kubernetes.io/component: audit } }
spec:
  podSelector: { matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/component: audit } }
  policyTypes: [Ingress]
  ingress:
    # The UI's nginx proxying /api/v1/admin/audit to the audit Service, in this namespace.
    - from:
        - podSelector: { matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/component: ui } }
      ports: [{ port: 3100, protocol: TCP }]
    # The load balancer (the ingress routes /api/v1/admin/audit here directly) and the kubelet's probes.
    - from:
        - ipBlock: { cidr: {{ .Values.networkPolicy.albSourceCidr | default "0.0.0.0/0" }} }
      ports: [{ port: 3100, protocol: TCP }]
    # Prometheus scraping the audit service's /metrics (drain lag, outbox depth, dead letters).
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: {{ .Values.networkPolicy.monitoringNamespace | default "monitoring" }} } }
      ports: [{ port: 3100, protocol: TCP }]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: {{ .Release.Name }}-ui, labels: { {{- include "rch.labels" . | nindent 4 }}, app.kubernetes.io/component: ui } }
spec:
````


**`deploy/chart/rch/templates/ingress.yaml`**:

Replace (block 1 of 1):
````yaml
    - host: {{ .Values.ingress.host }}
      http:
        paths:
          - { path: /api, pathType: Prefix, backend: { service: { name: {{ .Release.Name }}-api, port: { number: 3000 } } } }
          - { path: /, pathType: Prefix, backend: { service: { name: {{ .Release.Name }}-ui, port: { number: 8080 } } } }
````
with:
````yaml
    - host: {{ .Values.ingress.host }}
      http:
        # First match wins, in the order listed: the AWS Load Balancer Controller turns these into
        # listener rules with ascending priorities. The audit service's two read routes live under
        # /api, so they have to come before it or the API answers them with a 404.
        paths:
          - { path: /api/v1/admin/audit, pathType: Prefix, backend: { service: { name: {{ .Release.Name }}-audit, port: { number: 3100 } } } }
          - { path: /api, pathType: Prefix, backend: { service: { name: {{ .Release.Name }}-api, port: { number: 3000 } } } }
          - { path: /, pathType: Prefix, backend: { service: { name: {{ .Release.Name }}-ui, port: { number: 8080 } } } }
````


**`deploy/chart/rch/templates/servicemonitor.yaml`**:

Replace (block 1 of 1):
````yaml
  selector: { matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/component: api } }
  endpoints: [{ port: http, path: /metrics, interval: {{ .Values.serviceMonitor.interval }} }]
{{- end }}
````
with:
````yaml
  selector: { matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/component: api } }
  endpoints: [{ port: http, path: /metrics, interval: {{ .Values.serviceMonitor.interval }} }]
---
# The audit service publishes its own registry on its own port (apps/audit/src/plugins/metrics.ts):
# audit_outbox_depth, audit_drain_lag_seconds, audit_events_stored_total, audit_dead_letters_total
# and audit_listener_up. The Service's name, {{ .Release.Name }}-audit, becomes the series' `job`.
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata: { name: {{ .Release.Name }}-audit, labels: { release: {{ .Values.serviceMonitor.releaseLabel | default "kube-prometheus-stack" }} } }
spec:
  selector: { matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/component: audit } }
  endpoints: [{ port: http, path: /metrics, interval: {{ .Values.serviceMonitor.interval }} }]
{{- end }}
````


**`deploy/chart/rch/templates/prometheusrule.yaml`**:

Replace (block 1 of 2):
````yaml
  RchApiCrashLooping is a seventh, and the one rule that reads a metric from outside this API -
  see its own comment for why a restarting pod cannot be the thing that reports its restarts.

  Gated on serviceMonitor.enabled AND on the cluster actually serving monitoring.coreos.com/v1:
````
with:
````yaml
  RchApiCrashLooping is a seventh, and the one rule that reads a metric from outside this API -
  see its own comment for why a restarting pod cannot be the thing that reports its restarts.

  A second group holds the audit service's two alerts, read off its own ServiceMonitor (job
  {{ .Release.Name }}-audit): AuditDrainLagging, events waiting in the outbox for more than a
  minute, and AuditDeadLetters, an event the drainer could not parse and stored aside.

  Gated on serviceMonitor.enabled AND on the cluster actually serving monitoring.coreos.com/v1:
````

Replace (block 2 of 2):
````yaml
            summary: "A pod's live-update stream has gone deaf"
            runbook_url: "{{ .Values.alerts.runbookUrl }}#10-server-sent-events-sse"
{{- end }}
````
with:
````yaml
            summary: "A pod's live-update stream has gone deaf"
            runbook_url: "{{ .Values.alerts.runbookUrl }}#10-server-sent-events-sse"
    - name: {{ .Release.Name }}-audit
      rules:
        - alert: AuditDrainLagging
          # The age of the oldest row still in the outbox. Every write that commits adds one and the
          # drainer normally moves it within a second; a minute means no audit pod is draining - the
          # listener is down and the poll is failing too - and the log is falling behind the writes.
          expr: max(audit_drain_lag_seconds{job="{{ .Release.Name }}-audit"}) > 60
          for: 5m
          labels: { severity: warning }
          annotations:
            summary: "Audit events are waiting more than a minute to be stored"
            description: "The outbox holds rows older than 60s. Writes still succeed; the Audit log tab is behind them until a drainer recovers."
            runbook_url: "{{ .Values.alerts.runbookUrl }}#9-alerts"
        - alert: AuditDeadLetters
          # An outbox row that did not parse as an AuditEvent is kept in dead_letters, not dropped -
          # but it is missing from the Audit log tab, so any at all is somebody's to read.
          expr: sum(increase(audit_dead_letters_total{job="{{ .Release.Name }}-audit"}[15m])) > 0
          labels: { severity: critical }
          annotations:
            summary: "An audit event could not be stored and was set aside"
            description: "The drainer wrote to dead_letters in the last 15 minutes; each row carries the event and the first validation issue."
            runbook_url: "{{ .Values.alerts.runbookUrl }}#9-alerts"
{{- end }}
````


**`deploy/chart/rch/templates/ui-deployment.yaml`**:

Replace (block 1 of 1):
````yaml
          # `rch-api` never resolves inside a pod and every /api request answers 502. Docker Compose's
          # embedded DNS resolves short names, which is why the image's own default is short and this
          # bug was invisible until the smoke drove a browser through the cluster.
          env: [{ name: API_UPSTREAM, value: http://{{ .Release.Name }}-api.{{ .Release.Namespace }}.svc.cluster.local:3000 }]
          ports: [{ name: http, containerPort: 8080 }]
          readinessProbe: { httpGet: { path: /healthz, port: http }, periodSeconds: 5 }
````
with:
````yaml
          # `rch-api` never resolves inside a pod and every /api request answers 502. Docker Compose's
          # embedded DNS resolves short names, which is why the image's own default is short and this
          # bug was invisible until the smoke drove a browser through the cluster. AUDIT_UPSTREAM is the
          # audit Service's, for the same reason.
          env:
            - { name: API_UPSTREAM, value: http://{{ .Release.Name }}-api.{{ .Release.Namespace }}.svc.cluster.local:3000 }
            - { name: AUDIT_UPSTREAM, value: http://{{ .Release.Name }}-audit.{{ .Release.Namespace }}.svc.cluster.local:3100 }
          ports: [{ name: http, containerPort: 8080 }]
          readinessProbe: { httpGet: { path: /healthz, port: http }, periodSeconds: 5 }
````


**`deploy/chart/rch/templates/secret.yaml`**:

Replace (block 1 of 2):
````yaml
stringData:
{{- /*
  Four of the five keys are required and are checked here rather than left to fail later.
  `values.yaml` declares every one of them as "" so the shape is documented, which means an
  environment that simply forgot one renders a Secret carrying an empty string - and an empty
````
with:
````yaml
stringData:
{{- /*
  Six of the seven keys are required and are checked here rather than left to fail later.
  `values.yaml` declares every one of them as "" so the shape is documented, which means an
  environment that simply forgot one renders a Secret carrying an empty string - and an empty
````

Replace (block 2 of 2):
````yaml
{{- range $k, $v := .Values.secrets.values }}
{{- if and (ne $k "JWT_PREVIOUS_PUBLIC_KEY") (not $v) }}
{{- fail (printf "secrets.values.%s is empty - the chart cannot build a Secret without it (deploy/RUNBOOK.md §2 lists the four keys dev and staging need)" $k) }}
{{- end }}
  {{ $k }}: {{ $v | quote }}
````
with:
````yaml
{{- range $k, $v := .Values.secrets.values }}
{{- if and (ne $k "JWT_PREVIOUS_PUBLIC_KEY") (not $v) }}
{{- fail (printf "secrets.values.%s is empty - the chart cannot build a Secret without it (deploy/RUNBOOK.md §2 lists the six keys dev and staging need)" $k) }}
{{- end }}
  {{ $k }}: {{ $v | quote }}
````


**`deploy/chart/rch/templates/externalsecret.yaml`**:

Replace (block 1 of 1):
````yaml
#
# `dataFrom: extract` copies EVERY key of the remote JSON into the Secret, so there is no per-key
# list to keep in step here - but the remote secret must carry all five keys rch.envList wires
# (_helpers.tpl): DATABASE_URL, JWT_PRIVATE_KEY, JWT_PUBLIC_KEY, JWT_PREVIOUS_PUBLIC_KEY (only
# during a rotation window; its secretKeyRef is optional) and SEED_PASSWORD. A missing
# SEED_PASSWORD keeps the api container from starting at all - config.ts has no default for it.
apiVersion: external-secrets.io/v1
kind: ExternalSecret
````
with:
````yaml
#
# `dataFrom: extract` copies EVERY key of the remote JSON into the Secret, so there is no per-key
# list to keep in step here - but the remote secret must carry all seven keys the env helpers in
# _helpers.tpl wire: DATABASE_URL (rch_app), MIGRATE_DATABASE_URL (the superuser),
# AUDIT_DATABASE_URL (rch_audit), JWT_PRIVATE_KEY, JWT_PUBLIC_KEY, JWT_PREVIOUS_PUBLIC_KEY (only
# during a rotation window; its secretKeyRef is optional) and SEED_PASSWORD. A missing
# SEED_PASSWORD keeps the api container from starting at all - config.ts has no default for it -
# and a missing MIGRATE_DATABASE_URL or AUDIT_DATABASE_URL keeps a migrate initContainer from
# finding its key, so that pod never starts either.
apiVersion: external-secrets.io/v1
kind: ExternalSecret
````


**`deploy/chart/rch/templates/NOTES.txt`**:

Replace (block 1 of 1):
````text
{{- if .Values.networkPolicy.enabled }}

This release ships NetworkPolicies (default-deny ingress, with the ui->api hop, the load balancer
and the monitoring namespace opened by name). They are enforced only if the CNI enforces them:
on EKS that means the vpc-cni add-on must have `enableNetworkPolicy: true`. deploy/eksctl/cluster.yaml
now configures that, but it only takes effect once the live cluster's add-on is updated to match
````
with:
````text
{{- if .Values.networkPolicy.enabled }}

This release ships NetworkPolicies (default-deny ingress, with the ui->api and ui->audit hops, the
load balancer and the monitoring namespace opened by name). They are enforced only if the CNI enforces them:
on EKS that means the vpc-cni add-on must have `enableNetworkPolicy: true`. deploy/eksctl/cluster.yaml
now configures that, but it only takes effect once the live cluster's add-on is updated to match
````


**`deploy/chart/rch/Chart.yaml`**:

Replace (block 1 of 1):
````yaml
apiVersion: v2
name: rch
description: Royal Care Hospital F&B inventory and billing - API and UI
type: application
version: 0.1.0
````
with:
````yaml
apiVersion: v2
name: rch
description: Royal Care Hospital F&B inventory and billing - API, audit service and UI
type: application
version: 0.1.0
````


**`deploy/nginx/default.conf.template`** (define `$audit_upstream` the way `$api_upstream` is):

Replace (block 1 of 1):
````nginx
    proxy_read_timeout 60s;
  }
  # Server-sent events (Phase 3): no buffering, long read timeout.
  location /api/v1/events {
````
with:
````nginx
    proxy_read_timeout 60s;
  }
  # The audit service's two read routes (GET /api/v1/admin/audit and /api/v1/admin/audit/:id).
  # nginx picks the longest matching prefix, so this wins over /api/ above wherever it is written.
  # The same forwarding headers: the audit service trusts one hop too, and logs the browser's id.
  location /api/v1/admin/audit {
    set $audit_upstream ${AUDIT_UPSTREAM};
    proxy_pass $audit_upstream;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-Id $req_id;
    proxy_read_timeout 60s;
  }
  # Server-sent events (Phase 3): no buffering, long read timeout.
  location /api/v1/events {
````


**`UI/Dockerfile`**:

Replace (block 1 of 1):
````dockerfile
FROM nginxinc/nginx-unprivileged:1.30-alpine-slim AS runtime
ENV API_UPSTREAM=http://rch-api:3000
# Populates $NGINX_LOCAL_RESOLVERS from /etc/resolv.conf before envsubst runs,
# so the nginx template's `resolver` directive works under Docker and Kubernetes
````
with:
````dockerfile
FROM nginxinc/nginx-unprivileged:1.30-alpine-slim AS runtime
ENV API_UPSTREAM=http://rch-api:3000
# The audit service, for /api/v1/admin/audit (deploy/nginx/default.conf.template). Every variable
# the template names needs a value: envsubst leaves an unset one in the rendered config as the
# literal `${AUDIT_UPSTREAM}`, nginx still starts, and every audit read then fails.
ENV AUDIT_UPSTREAM=http://rch-audit:3100
# Populates $NGINX_LOCAL_RESOLVERS from /etc/resolv.conf before envsubst runs,
# so the nginx template's `resolver` directive works under Docker and Kubernetes
````


- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log helm:test`
Expected: PASS - three `1 chart(s) linted, 0 chart(s) failed` and `chart renders`.

Run: `helm template rch /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/chart/rch -f /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/chart/rch/ci/values-ci.yaml --set-string secrets.values.JWT_PRIVATE_KEY=k,secrets.values.JWT_PUBLIC_KEY=p,secrets.values.SEED_PASSWORD=s --show-only templates/audit-deployment.yaml | grep -E 'image: rch-audit:ci|key: (MIGRATE|AUDIT)_DATABASE_URL|value: "false"'`
Expected: PASS - `image: rch-audit:ci` twice, the two URL keys, and `DATABASE_SSL`'s `value: "false"`
(the CI values render; Task 18's kind install uses them).

The nginx template, rendered by the UI's own base image (Docker may be absent - skip it then; the
render test's greps still hold):

```bash
W=/Users/srimanikandanr/.superset/worktrees/RCH-audit-log
if docker info >/dev/null 2>&1; then
  docker run --rm -e API_UPSTREAM=http://rch-api:3000 -e AUDIT_UPSTREAM=http://rch-audit:3100 \
    -e NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    -v "$W/deploy/nginx/default.conf.template:/etc/nginx/templates/default.conf.template:ro" \
    nginxinc/nginx-unprivileged:1.30-alpine-slim nginx -T 2>&1 | grep -E 'test is successful|set \$audit_upstream'
else
  echo "SKIP: no Docker daemon"
fi
```

Expected: `set $audit_upstream http://rch-audit:3100;` and `nginx: configuration file
/etc/nginx/nginx.conf test is successful`, or `SKIP: no Docker daemon`.

- [ ] **Step 5: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add deploy/chart/rch deploy/nginx/default.conf.template UI/Dockerfile
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Deploy the audit service with the chart, each container holding only its own secrets

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

### Task 18: CI, kind install test, EKS workflow and CloudFormation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/deploy.yml`
- Modify: `deploy/chart/rch/ci/install-test.sh` (whole file below)
- Modify: `deploy/chart/rch/ci/postgres.yaml`
- Modify: `deploy/cfn/rch-env.yaml`
- Modify: `deploy/cfn/dev.import.json`
- Modify: `deploy/cfn/README.md`
- Modify: `.trivyignore.yaml`

**Interfaces:**
- Consumes: Task 16's `apps/audit/Dockerfile`; Task 17's chart (`deploy/rch-audit`,
  `svc/rch-audit` on 3100, containers `audit-migrate` / `audit`, the migrate initContainer named
  `migrate`, `ci/values-ci.yaml`'s three URLs); Task 6's `login` event; Task 12's
  `GET /api/v1/admin/audit?action=…&limit=…` answering `{ rows: AuditRow[] }` to an admin token.
  The runner's `jq` (preinstalled on `ubuntu-latest`) and `kubectl run --overrides`.
- Produces: three images built, scanned and loaded in CI; a kind smoke that proves outbox →
  drainer → audit read on a real cluster; the EKS workflow and the ECR repository for `rch-audit`.

- [ ] **Step 1: Write the failing check**

````bash
cat > "${TMPDIR:-/tmp}/rch-task18-check.sh" <<'EOF'
#!/usr/bin/env bash
# Task 18's wiring, as assertions: every place that builds, scans, loads, deploys or provisions an
# image names rch-audit, and the kind smoke reads the audit log back.
set -uo pipefail
W=${W:-/Users/srimanikandanr/.superset/worktrees/RCH-audit-log}
status=0
has() { if grep -qF -- "$2" "$W/$1"; then echo "PASS: $1 has: $2"; else echo "FAIL: $1 lacks: $2"; status=1; fi; }
has .github/workflows/ci.yml 'file: apps/audit/Dockerfile, push: false, load: true, platforms: linux/amd64, tags: rch-audit:ci'
has .github/workflows/ci.yml 'image-ref: rch-audit:ci, severity: "CRITICAL,HIGH"'
has .github/workflows/ci.yml 'kind load docker-image rch-api:ci rch-ui:ci rch-audit:ci --name rch'
has .github/workflows/ci.yml 'shellcheck deploy/compose/*.sh deploy/chart/rch/ci/install-test.sh'
has .github/workflows/deploy.yml 'for repo in rch-api rch-ui rch-audit; do'
has .github/workflows/deploy.yml 'file: apps/audit/Dockerfile, push: true'
has .github/workflows/deploy.yml 'image-ref: "${{ secrets.ECR_REGISTRY }}/rch-audit:${{ github.event.workflow_run.head_sha }}"'
has .github/workflows/deploy.yml 'for v in DATABASE_URL MIGRATE_DATABASE_URL AUDIT_DATABASE_URL JWT_PRIVATE_KEY JWT_PUBLIC_KEY SEED_PASSWORD; do'
has .github/workflows/deploy.yml '--set-string "secrets.values.MIGRATE_DATABASE_URL=$MIGRATE_DATABASE_URL"'
has .github/workflows/deploy.yml '--set-string "secrets.values.AUDIT_DATABASE_URL=$AUDIT_DATABASE_URL"'
has .github/workflows/deploy.yml 'logs -l app.kubernetes.io/component=audit -c audit-migrate'
has .github/workflows/deploy.yml 'rollout status deploy/rch-audit'
has .github/workflows/deploy.yml 'wait --for=condition=Available deploy/rch-audit'
has deploy/chart/rch/ci/install-test.sh 'kubectl port-forward svc/rch-audit 3100:3100'
has deploy/chart/rch/ci/install-test.sh '"$AUDIT$API_PREFIX/admin/audit?action=login&limit=50"'
has deploy/chart/rch/ci/install-test.sh 'kubectl logs deploy/rch-audit -c audit-migrate --tail=50'
has deploy/cfn/rch-env.yaml 'RepositoryName: rch-audit'
has deploy/cfn/rch-env.yaml 'repository/rch-audit"'
has deploy/cfn/rch-env.yaml 'Name: rch-shared-ecr-audit-uri'
has deploy/cfn/dev.import.json '"RepositoryName": "rch-audit"'
has .trivyignore.yaml "ci.yml's three image scans and deploy.yml's three re-scans"
exit "$status"
EOF
````


- [ ] **Step 2: Run it to verify it fails**

Run: `bash "${TMPDIR:-/tmp}/rch-task18-check.sh"`
Expected: FAIL - 21 `FAIL: … lacks: …` lines, exit 1.

- [ ] **Step 3: Implement**

**`.github/workflows/ci.yml`** - build, scan and load the third image; shellcheck the kind script:

Replace (block 1 of 7):
````yaml
    runs-on: ubuntu-latest
    needs: check
    # Build + scan normally finish well inside this, but the kind install at the end of
    # this job (a real `helm install`/`helm upgrade` - see the last few steps) budgets 15m
    # of its own on top of that.
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
````
with:
````yaml
    runs-on: ubuntu-latest
    needs: check
    # Three builds + scans normally finish well inside this, but the kind install at the end of
    # this job (a real `helm install`/`helm upgrade` - see the last few steps) budgets 15m
    # of its own on top of that.
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v7
````

Replace (block 2 of 7):
````yaml
      - name: Build api
        uses: docker/build-push-action@v6
        # load: true (both here and for ui below) puts the image into the local Docker
        # daemon so Trivy and `kind load docker-image` can see it - that requires a single
        # platform, hence pinning it rather than leaving it to buildx's default.
````
with:
````yaml
      - name: Build api
        uses: docker/build-push-action@v6
        # load: true (here and for ui and audit below) puts the image into the local Docker
        # daemon so Trivy and `kind load docker-image` can see it - that requires a single
        # platform, hence pinning it rather than leaving it to buildx's default.
````

Replace (block 3 of 7):
````yaml
        uses: docker/build-push-action@v6
        with: { context: ., file: UI/Dockerfile, push: false, load: true, platforms: linux/amd64, tags: rch-ui:ci, cache-from: type=gha, cache-to: "type=gha,mode=max" }
      # HIGH as well as CRITICAL: a hospital till and its store ledger are not a place to wait
      # for a HIGH to be re-rated before acting on it, and ignore-unfixed already keeps the gate
````
with:
````yaml
        uses: docker/build-push-action@v6
        with: { context: ., file: UI/Dockerfile, push: false, load: true, platforms: linux/amd64, tags: rch-ui:ci, cache-from: type=gha, cache-to: "type=gha,mode=max" }
      - name: Build audit
        uses: docker/build-push-action@v6
        with: { context: ., file: apps/audit/Dockerfile, push: false, load: true, platforms: linux/amd64, tags: rch-audit:ci, cache-from: type=gha, cache-to: "type=gha,mode=max" }
      # HIGH as well as CRITICAL: a hospital till and its store ledger are not a place to wait
      # for a HIGH to be re-rated before acting on it, and ignore-unfixed already keeps the gate
````

Replace (block 4 of 7):
````yaml
        uses: aquasecurity/trivy-action@v0.36.0
        with: { image-ref: rch-ui:ci, severity: "CRITICAL,HIGH", exit-code: "1", ignore-unfixed: true, trivyignores: .trivyignore.yaml }
      # From here on: a real `helm install` against a throwaway kind cluster. Lives at the
      # end of this job, not a separate one that
````
with:
````yaml
        uses: aquasecurity/trivy-action@v0.36.0
        with: { image-ref: rch-ui:ci, severity: "CRITICAL,HIGH", exit-code: "1", ignore-unfixed: true, trivyignores: .trivyignore.yaml }
      - name: Scan audit
        uses: aquasecurity/trivy-action@v0.36.0
        with: { image-ref: rch-audit:ci, severity: "CRITICAL,HIGH", exit-code: "1", ignore-unfixed: true, trivyignores: .trivyignore.yaml }
      # From here on: a real `helm install` against a throwaway kind cluster. Lives at the
      # end of this job, not a separate one that
````

Replace (block 5 of 7):
````yaml
        with: { cluster_name: rch }
      - name: Load images into kind
        run: kind load docker-image rch-api:ci rch-ui:ci --name rch
      - name: Generate a throwaway JWT signing key
        # openssl, not `pnpm --filter @rch/api keys:generate` - this job has no Node toolchain
````
with:
````yaml
        with: { cluster_name: rch }
      - name: Load images into kind
        run: kind load docker-image rch-api:ci rch-ui:ci rch-audit:ci --name rch
      - name: Generate a throwaway JWT signing key
        # openssl, not `pnpm --filter @rch/api keys:generate` - this job has no Node toolchain
````

Replace (block 6 of 7):
````yaml
    name: Deploy files
    runs-on: ubuntu-latest
    # A helm template render, a compose config parse and two linters. Anything past ten minutes
    # is stuck.
    timeout-minutes: 10
    steps:
````
with:
````yaml
    name: Deploy files
    runs-on: ubuntu-latest
    # A helm template render, a compose config parse (plus the Caddyfile, adapted in a caddy
    # container) and two linters. Anything past ten minutes is stuck.
    timeout-minutes: 10
    steps:
````

Replace (block 7 of 7):
````yaml
      # rather than halfway through a release.
      - run: deploy/compose/compose.test.sh
      - run: shellcheck deploy/compose/*.sh
      - name: actionlint
        run: docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12 -color
````
with:
````yaml
      # rather than halfway through a release.
      - run: deploy/compose/compose.test.sh
      - run: shellcheck deploy/compose/*.sh deploy/chart/rch/ci/install-test.sh
      - name: actionlint
        run: docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12 -color
````


**`deploy/chart/rch/ci/postgres.yaml`** (the superuser is already `rch`; this records why nothing
else is needed):

Replace (block 1 of 1):
````yaml
# any real environment - emptyDir storage, single replica, plaintext creds scoped to
# a cluster that is torn down at the end of the job.
apiVersion: apps/v1
kind: Deployment
````
with:
````yaml
# any real environment - emptyDir storage, single replica, plaintext creds scoped to
# a cluster that is torn down at the end of the job.
#
# POSTGRES_USER makes `rch` this cluster's superuser. values-ci.yaml's MIGRATE_DATABASE_URL connects
# as it, and the two migrate initContainers create the runtime roles rch_app and rch_audit from the
# users and passwords in DATABASE_URL and AUDIT_DATABASE_URL - so nothing here creates them.
apiVersion: apps/v1
kind: Deployment
````


**`deploy/chart/rch/ci/install-test.sh`** - the whole file. The seed now runs as a one-off pod made
from the api Deployment's `migrate` initContainer (Notes 6 and 7); the new audit block signs
RC-0001 in through the API and polls the audit service for that sign-in for up to 15 s; the upgrade
leg repeats the audit `/readyz`; diagnostics include both audit containers:

````bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."

# Runs against a kind cluster that already has the `rch-api:ci` / `rch-ui:ci` / `rch-audit:ci`
# images loaded (`kind load docker-image`, done by the CI workflow before this script runs - see
# the end of the `images` job in .github/workflows/ci.yml). It installs the real chart, seeds the
# DB, exercises all three services through a port-forward - including one audit event travelling
# API outbox → drainer → audit read - then upgrades in place to prove the Secret survives and
# both migrate initContainers are no-ops the second time.
#
# JWT_PRIVATE_KEY / JWT_PUBLIC_KEY must already be exported (base64 PKCS8
# private / SPKI public Ed25519 PEMs - the same shape `pnpm --filter @rch/api
# keys:generate` prints). They are threaded through as --set-string so a
# throwaway key never touches values-ci.yaml.
: "${JWT_PRIVATE_KEY:?set JWT_PRIVATE_KEY (base64 PKCS8 Ed25519 private key) before running install-test.sh}"
: "${JWT_PUBLIC_KEY:?set JWT_PUBLIC_KEY (base64 SPKI Ed25519 public key) before running install-test.sh}"
command -v jq >/dev/null || { echo "install-test.sh needs jq to read the audit service's answer" >&2; exit 1; }

# SEED_PASSWORD has no default in apps/api/src/config.ts any more, so the api container will not
# start without it and the seed below would have nothing to hash. It is threaded through the
# chart the same way the keys are, and defaulted here so the script still runs by hand. The login
# checks below sign in with it, so it is the password the seed actually wrote.
SEED_PASSWORD="${SEED_PASSWORD:-ci-seed-password-1}"

# Every mounted route lives under API_PREFIX (packages/contract/src/routes.ts) - only
# /healthz, /readyz, /metrics on the api and the audit service, and the UI's own nginx-served
# /healthz, are not prefixed. Keep this in one place so a script edit can't silently drift from
# the contract.
API=http://localhost:3000
AUDIT=http://localhost:3100
API_PREFIX=/api/v1
UI=http://localhost:8080

SET_ARGS=(
  --set-string "secrets.values.JWT_PRIVATE_KEY=$JWT_PRIVATE_KEY"
  --set-string "secrets.values.JWT_PUBLIC_KEY=$JWT_PUBLIC_KEY"
  --set-string "secrets.values.SEED_PASSWORD=$SEED_PASSWORD"
)

API_PF_PID=""
UI_PF_PID=""
AUDIT_PF_PID=""
kill_pf() {
  [ -n "$API_PF_PID" ] && kill "$API_PF_PID" 2>/dev/null || true
  [ -n "$UI_PF_PID" ] && kill "$UI_PF_PID" 2>/dev/null || true
  [ -n "$AUDIT_PF_PID" ] && kill "$AUDIT_PF_PID" 2>/dev/null || true
  API_PF_PID=""
  UI_PF_PID=""
  AUDIT_PF_PID=""
}
trap kill_pf EXIT

on_failure() {
  echo "--- install-test.sh failed: cluster diagnostics ---" >&2
  kubectl get pods -A || true
  kubectl logs deploy/rch-api -c migrate --tail=50 || true
  kubectl logs deploy/rch-api -c api --tail=50 || true
  kubectl logs deploy/rch-audit -c audit-migrate --tail=50 || true
  kubectl logs deploy/rch-audit -c audit --tail=50 || true
  cat /tmp/pf-api.log 2>/dev/null || true
  cat /tmp/pf-audit.log 2>/dev/null || true
  cat /tmp/pf-ui.log 2>/dev/null || true
}
trap on_failure ERR

# fail <message>: every explicit status-code assertion below goes through this instead of a
# bare `exit 1` inside a `[ ... ] || { ...; exit 1; }` block - that form runs in the current
# shell but an explicit `exit` there bypasses the `trap ... ERR` above (ERR does not fire for
# a command whose failure is already being handled by `||`), so a login/healthz assertion
# failure would previously print nothing about the cluster before the job died.
fail() {
  echo "$*" >&2
  on_failure
  exit 1
}

# wait_for <url>: retry a plain GET for up to ~30s (port-forward needs a beat
# to come up; the readiness probe needs a beat to pass on a fresh pod).
wait_for() {
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null "$1" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# The chart's NetworkPolicies (templates/networkpolicy.yaml) install here with everything else and
# need no CI override. kind's default CNI may not enforce them at all, and where it does they are
# already open enough for this script: each component's serving port is allowed from
# networkPolicy.albSourceCidr, which defaults to 0.0.0.0/0 - that covers both `kubectl
# port-forward` (traffic arrives from the node, not from a pod any selector could name) and the
# kubelet's probes - and the ui pod reaching the api and the audit service is allowed by name on
# top of that. The throwaway Postgres below and the one-off seed pod carry none of the release's
# labels, so the default-deny does not select them.
echo "== throwaway postgres =="
kubectl apply -f deploy/chart/rch/ci/postgres.yaml
kubectl rollout status deploy/postgres --timeout=120s

echo "== helm install =="
helm install rch deploy/chart/rch -f deploy/chart/rch/ci/values-ci.yaml "${SET_ARGS[@]}" --wait --timeout 5m

# The seed is an operator CLI, and operator CLIs connect as the superuser (MIGRATE_DATABASE_URL) -
# which the api container deliberately does not hold, since it serves requests as rch_app. So the
# seed runs the way an operator runs any CLI against this chart: a one-off pod made from the api
# Deployment's own migrate initContainer - same image, same env, same Secret references, nothing
# secret on a command line - with the CLI swapped in for the migration.
# --yes-seed rch because that env sets NODE_ENV=production, and cli/seed.ts refuses to seed there
# unless the database is named back - `rch` is what ci/postgres.yaml's POSTGRES_DB creates. No
# --force: the database underneath is a fresh container, nothing to empty.
# SEED_FORCE_PASSWORD_CHANGE=false (config.ts defaults it to true, and the chart does not set it)
# so RC-0001 signs in below as a plain admin rather than an account held at the password change.
echo "== seed (RC-3120 and RC-0001 / \$SEED_PASSWORD) =="
seed_pod=$(kubectl get deploy/rch-api -o json | jq -c '{ spec: { containers: [
  .spec.template.spec.initContainers[] | select(.name == "migrate")
  | .name = "rch-seed" | .args = ["dist/cli/seed.mjs", "--yes-seed", "rch"]
  | .env += [{ name: "SEED_FORCE_PASSWORD_CHANGE", value: "false" }] ] } }')
kubectl run rch-seed --rm -i --quiet --restart=Never --image=rch-api:ci --overrides="$seed_pod"

echo "== api: /readyz and login =="
kubectl port-forward svc/rch-api 3000:3000 >/tmp/pf-api.log 2>&1 &
API_PF_PID=$!
wait_for "$API/readyz"
curl -fsS "$API/readyz"

LOGIN_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d "{\"emp\":\"RC-3120\",\"password\":\"$SEED_PASSWORD\"}" "$API$API_PREFIX/auth/login")
[ "$LOGIN_CODE" = 200 ] || fail "login: expected 200, got $LOGIN_CODE"

# The audit service end to end on a real cluster: the super admin signs in through the API, which
# writes a `login` event to audit_outbox in the sign-in's own transaction; an audit pod drains it
# into the audit schema; and the same admin token reads it back from the audit service - which
# proves the API's rch_app grant, the drainer, rch_audit's grants, the shared public key and the
# admin gate all at once.
echo "== audit: /readyz, and the sign-in just made reaches the log =="
kubectl rollout status deploy/rch-audit --timeout=120s
kubectl port-forward svc/rch-audit 3100:3100 >/tmp/pf-audit.log 2>&1 &
AUDIT_PF_PID=$!
wait_for "$AUDIT/readyz" || fail "audit /readyz never answered 200"
curl -fsS "$AUDIT/readyz"

ADMIN_LOGIN=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"emp\":\"RC-0001\",\"password\":\"$SEED_PASSWORD\"}" "$API$API_PREFIX/auth/login")
TOKEN=$(jq -r '.accessToken // empty' <<<"$ADMIN_LOGIN" 2>/dev/null || true)
[ -n "$TOKEN" ] || fail "admin login: no accessToken in the answer: $ADMIN_LOGIN"

AUDIT_CODE=""
for _ in $(seq 1 15); do
  AUDIT_CODE=$(curl -s -o /tmp/audit-page.json -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
    "$AUDIT$API_PREFIX/admin/audit?action=login&limit=50" || true)
  if [ "$AUDIT_CODE" = 200 ] && jq -e \
      '[.rows[] | select(.action == "login" and .outcome == "done" and .actor.emp == "RC-0001")] | length > 0' \
      /tmp/audit-page.json >/dev/null; then
    break
  fi
  AUDIT_CODE="missing"
  sleep 1
done
[ "$AUDIT_CODE" = 200 ] || fail "the RC-0001 sign-in never reached GET $API_PREFIX/admin/audit within 15s (last answer: $(cat /tmp/audit-page.json 2>/dev/null))"
echo "   the RC-0001 sign-in is in the audit log"

echo "== ui: /healthz =="
kubectl rollout status deploy/rch-ui --timeout=120s
kubectl port-forward svc/rch-ui 8080:8080 >/tmp/pf-ui.log 2>&1 &
UI_PF_PID=$!
wait_for "$UI/healthz"
UI_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$UI/healthz")
[ "$UI_CODE" = 200 ] || fail "ui healthz: expected 200, got $UI_CODE"

kill_pf

echo "== helm upgrade (proves the Secret survives and both migrate initContainers no-op) =="
helm upgrade --install rch deploy/chart/rch -f deploy/chart/rch/ci/values-ci.yaml "${SET_ARGS[@]}" --wait --timeout 5m

kubectl port-forward svc/rch-api 3000:3000 >/tmp/pf-api.log 2>&1 &
API_PF_PID=$!
wait_for "$API/readyz"
curl -fsS "$API/readyz"

kubectl port-forward svc/rch-audit 3100:3100 >/tmp/pf-audit.log 2>&1 &
AUDIT_PF_PID=$!
wait_for "$AUDIT/readyz" || fail "audit /readyz never answered 200 after the upgrade"
curl -fsS "$AUDIT/readyz"

kill_pf
trap - ERR
echo "chart installs, seeds, serves, audits and upgrades cleanly in kind"
````


**`.github/workflows/deploy.yml`**:

Replace (block 1 of 11):
````yaml
    if: ${{ github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && vars.DEPLOY_ENABLED == 'true' }}
    runs-on: ubuntu-latest
    # Two image builds, a 15m helm timeout and two rollouts. A job that runs past this is stuck,
    # not slow, and holding the concurrency group open costs the next push its deploy.
    timeout-minutes: 45
````
with:
````yaml
    if: ${{ github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && vars.DEPLOY_ENABLED == 'true' }}
    runs-on: ubuntu-latest
    # Three image builds, a 15m helm timeout and three rollouts. A job that runs past this is stuck,
    # not slow, and holding the concurrency group open costs the next push its deploy.
    timeout-minutes: 45
````

Replace (block 2 of 11):
````yaml
        run: |
          have=true
          for repo in rch-api rch-ui; do
            aws ecr describe-images --repository-name "$repo" --image-ids imageTag="$SHA" > /dev/null 2>&1 || have=false
          done
````
with:
````yaml
        run: |
          have=true
          for repo in rch-api rch-ui rch-audit; do
            aws ecr describe-images --repository-name "$repo" --image-ids imageTag="$SHA" > /dev/null 2>&1 || have=false
          done
````

Replace (block 3 of 11):
````yaml
        if: steps.images.outputs.exists != 'true'
        with: { context: ., file: UI/Dockerfile, push: true, platforms: linux/amd64, tags: "${{ secrets.ECR_REGISTRY }}/rch-ui:${{ github.event.workflow_run.head_sha }}", cache-from: type=gha, cache-to: "type=gha,mode=max" }
      # ci.yml scans rch-api:ci / rch-ui:ci - the images it built itself, which are not the
      # bytes that reach a cluster. These two steps scan the exact tags helm is about to
      # deploy, pulled back out of ECR (the ecr-login above left the credentials trivy needs),
      # and they run whether the builds above ran or were skipped as already-pushed. Same
````
with:
````yaml
        if: steps.images.outputs.exists != 'true'
        with: { context: ., file: UI/Dockerfile, push: true, platforms: linux/amd64, tags: "${{ secrets.ECR_REGISTRY }}/rch-ui:${{ github.event.workflow_run.head_sha }}", cache-from: type=gha, cache-to: "type=gha,mode=max" }
      - uses: docker/build-push-action@v6
        if: steps.images.outputs.exists != 'true'
        with: { context: ., file: apps/audit/Dockerfile, push: true, platforms: linux/amd64, tags: "${{ secrets.ECR_REGISTRY }}/rch-audit:${{ github.event.workflow_run.head_sha }}", cache-from: type=gha, cache-to: "type=gha,mode=max" }
      # ci.yml scans rch-api:ci / rch-ui:ci / rch-audit:ci - the images it built itself, which are not the
      # bytes that reach a cluster. These three steps scan the exact tags helm is about to
      # deploy, pulled back out of ECR (the ecr-login above left the credentials trivy needs),
      # and they run whether the builds above ran or were skipped as already-pushed. Same
````

Replace (block 4 of 11):
````yaml
          ignore-unfixed: true
          trivyignores: .trivyignore.yaml
      - uses: azure/setup-helm@v4
      - run: aws eks update-kubeconfig --name "$CLUSTER" --region "${{ secrets.AWS_REGION }}"
      # dev and staging pass their four secrets to helm from the GitHub environment. An unset
      # one is not an error helm reports: --set-string writes the empty string into the
      # Secret, the api container fails config validation minutes later, and the log says
      # nothing about where the blank came from. Refuse here, by name, before anything moves.
      # production is exempt: it reads these four plus JWT_PREVIOUS_PUBLIC_KEY from AWS
      # Secrets Manager through the External Secrets Operator (values-prod.yaml), so these
      # GitHub secrets are empty there on purpose - and production therefore gets NO pre-flight
````
with:
````yaml
          ignore-unfixed: true
          trivyignores: .trivyignore.yaml
      - name: Scan the audit image that is about to be deployed
        uses: aquasecurity/trivy-action@v0.36.0
        with:
          image-ref: "${{ secrets.ECR_REGISTRY }}/rch-audit:${{ github.event.workflow_run.head_sha }}"
          severity: "CRITICAL,HIGH"
          exit-code: "1"
          ignore-unfixed: true
          trivyignores: .trivyignore.yaml
      - uses: azure/setup-helm@v4
      - run: aws eks update-kubeconfig --name "$CLUSTER" --region "${{ secrets.AWS_REGION }}"
      # dev and staging pass their six secrets to helm from the GitHub environment. An unset
      # one is not an error helm reports: --set-string writes the empty string into the
      # Secret, the api container fails config validation minutes later, and the log says
      # nothing about where the blank came from. Refuse here, by name, before anything moves.
      # DATABASE_URL is the API's rch_app URL, MIGRATE_DATABASE_URL the superuser's (the two
      # migrate initContainers and the purge CronJob) and AUDIT_DATABASE_URL the audit service's
      # rch_audit URL; each migrate step creates its role from the password in that role's URL.
      # production is exempt: it reads these six plus JWT_PREVIOUS_PUBLIC_KEY from AWS
      # Secrets Manager through the External Secrets Operator (values-prod.yaml), so these
      # GitHub secrets are empty there on purpose - and production therefore gets NO pre-flight
````

Replace (block 5 of 11):
````yaml
        if: github.event.workflow_run.head_branch != 'production'
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          JWT_PRIVATE_KEY: ${{ secrets.JWT_PRIVATE_KEY }}
          JWT_PUBLIC_KEY: ${{ secrets.JWT_PUBLIC_KEY }}
          SEED_PASSWORD: ${{ secrets.SEED_PASSWORD }}
````
with:
````yaml
        if: github.event.workflow_run.head_branch != 'production'
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          MIGRATE_DATABASE_URL: ${{ secrets.MIGRATE_DATABASE_URL }}
          AUDIT_DATABASE_URL: ${{ secrets.AUDIT_DATABASE_URL }}
          JWT_PRIVATE_KEY: ${{ secrets.JWT_PRIVATE_KEY }}
          JWT_PUBLIC_KEY: ${{ secrets.JWT_PUBLIC_KEY }}
          SEED_PASSWORD: ${{ secrets.SEED_PASSWORD }}
````

Replace (block 6 of 11):
````yaml
        run: |
          missing=0
          for v in DATABASE_URL JWT_PRIVATE_KEY JWT_PUBLIC_KEY SEED_PASSWORD; do
            [ -n "${!v}" ] || { echo "::error::$v is empty"; missing=1; }
          done
````
with:
````yaml
        run: |
          missing=0
          for v in DATABASE_URL MIGRATE_DATABASE_URL AUDIT_DATABASE_URL JWT_PRIVATE_KEY JWT_PUBLIC_KEY SEED_PASSWORD; do
            [ -n "${!v}" ] || { echo "::error::$v is empty"; missing=1; }
          done
````

Replace (block 7 of 11):
````yaml
      - name: helm upgrade
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          JWT_PRIVATE_KEY: ${{ secrets.JWT_PRIVATE_KEY }}
          JWT_PUBLIC_KEY: ${{ secrets.JWT_PUBLIC_KEY }}
          SEED_PASSWORD: ${{ secrets.SEED_PASSWORD }}
````
with:
````yaml
      - name: helm upgrade
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          MIGRATE_DATABASE_URL: ${{ secrets.MIGRATE_DATABASE_URL }}
          AUDIT_DATABASE_URL: ${{ secrets.AUDIT_DATABASE_URL }}
          JWT_PRIVATE_KEY: ${{ secrets.JWT_PRIVATE_KEY }}
          JWT_PUBLIC_KEY: ${{ secrets.JWT_PUBLIC_KEY }}
          SEED_PASSWORD: ${{ secrets.SEED_PASSWORD }}
````

Replace (block 8 of 11):
````yaml
          # SEED_PASSWORD has no default in apps/api/src/config.ts, so the api container will not
          # start without one. It is the password the six seeded accounts start on and is only
          # read by the seed CLI, but every container carries it because rch.envList builds one
          # env list for all of them. The step above refuses an empty one before we get here.
          if [ "$REF_NAME" != production ]; then
            EXTRA=(
              --set-string "secrets.values.DATABASE_URL=$DATABASE_URL"
              --set-string "secrets.values.JWT_PRIVATE_KEY=$JWT_PRIVATE_KEY"
              --set-string "secrets.values.JWT_PUBLIC_KEY=$JWT_PUBLIC_KEY"
````
with:
````yaml
          # SEED_PASSWORD has no default in apps/api/src/config.ts, so the api container will not
          # start without one. It is the password the six seeded accounts start on and is only
          # read by the seed CLI, but the api's containers carry it because config.ts requires it
          # (the audit containers never see it - templates/_helpers.tpl). The step above refuses
          # an empty one before we get here.
          if [ "$REF_NAME" != production ]; then
            EXTRA=(
              --set-string "secrets.values.DATABASE_URL=$DATABASE_URL"
              --set-string "secrets.values.MIGRATE_DATABASE_URL=$MIGRATE_DATABASE_URL"
              --set-string "secrets.values.AUDIT_DATABASE_URL=$AUDIT_DATABASE_URL"
              --set-string "secrets.values.JWT_PRIVATE_KEY=$JWT_PRIVATE_KEY"
              --set-string "secrets.values.JWT_PUBLIC_KEY=$JWT_PUBLIC_KEY"
````

Replace (block 9 of 11):
````yaml
          kubectl -n "$NS" get events --sort-by=.lastTimestamp | tail -80 || true
          kubectl -n "$NS" logs -l app.kubernetes.io/component=api -c migrate --tail=200 || true
      # Only dev and staging, and only when the release is genuinely stuck. --atomic has
      # normally already rolled these back by now, and `helm rollback` with no revision goes
````
with:
````yaml
          kubectl -n "$NS" get events --sort-by=.lastTimestamp | tail -80 || true
          kubectl -n "$NS" logs -l app.kubernetes.io/component=api -c migrate --tail=200 || true
          kubectl -n "$NS" logs -l app.kubernetes.io/component=audit -c audit-migrate --tail=200 || true
          kubectl -n "$NS" logs -l app.kubernetes.io/component=audit -c audit --tail=200 || true
      # Only dev and staging, and only when the release is genuinely stuck. --atomic has
      # normally already rolled these back by now, and `helm rollback` with no revision goes
````

Replace (block 10 of 11):
````yaml
        run: |
          kubectl -n "$NS" rollout status deploy/rch-api --timeout=5m
          kubectl -n "$NS" rollout status deploy/rch-ui --timeout=5m
          # Availability is the readiness probe's own verdict, read from the cluster: the api's
````
with:
````yaml
        run: |
          kubectl -n "$NS" rollout status deploy/rch-api --timeout=5m
          kubectl -n "$NS" rollout status deploy/rch-audit --timeout=5m
          kubectl -n "$NS" rollout status deploy/rch-ui --timeout=5m
          # Availability is the readiness probe's own verdict, read from the cluster: the api's
````

Replace (block 11 of 11):
````yaml
          # matches the journal, so an Available deployment is the same statement the old smoke
          # pod made - without pulling an image from Docker Hub into the cluster to make it, and
          # without a rate limit or an outage there being able to fail a good deploy.
          kubectl -n "$NS" wait --for=condition=Available deploy/rch-api --timeout=300s
          kubectl -n "$NS" wait --for=condition=Available deploy/rch-ui --timeout=300s
      - name: Tag production
````
with:
````yaml
          # matches the journal, so an Available deployment is the same statement the old smoke
          # pod made - without pulling an image from Docker Hub into the cluster to make it, and
          # without a rate limit or an outage there being able to fail a good deploy. The audit
          # service's probe is its own /readyz: the database, its migrations and a recent drain pass.
          kubectl -n "$NS" wait --for=condition=Available deploy/rch-api --timeout=300s
          kubectl -n "$NS" wait --for=condition=Available deploy/rch-audit --timeout=300s
          kubectl -n "$NS" wait --for=condition=Available deploy/rch-ui --timeout=300s
      - name: Tag production
````


**`deploy/cfn/rch-env.yaml`** - `EcrAudit` mirrors `EcrUi` byte for byte except the name, and is
inserted straight after it:

Replace (block 1 of 6):
````yaml
# One template, one stack per environment. The first environment (dev, imported from the
# CLI-built resources) OWNS the resources that are account- or VPC-wide singletons - the DB
# subnet group, both ECR repositories, the OIDC provider and the GitHub deploy role - because
# AWS itself will not let a second stack create a same-named role, repository, subnet group or
# provider. A later environment's stack (staging, prod) does not recreate them; it imports their
````
with:
````yaml
# One template, one stack per environment. The first environment (dev, imported from the
# CLI-built resources) OWNS the resources that are account- or VPC-wide singletons - the DB
# subnet group, the three ECR repositories, the OIDC provider and the GitHub deploy role - because
# AWS itself will not let a second stack create a same-named role, repository, subnet group or
# provider. A later environment's stack (staging, prod) does not recreate them; it imports their
````

Replace (block 2 of 6):
````yaml
  RCH environment resources - everything the account owner created by hand with the AWS CLI
  before this template existed, plus what the audit added: the Postgres instance with its
  parameter group, subnet group and per-environment security group, the two ECR repositories and
  their lifecycle policies, the GitHub Actions OIDC provider and deploy role, the per-environment
  Secrets Manager secret, the ACM certificate and its CAA record, an optional ALB access-log
````
with:
````yaml
  RCH environment resources - everything the account owner created by hand with the AWS CLI
  before this template existed, plus what the audit added: the Postgres instance with its
  parameter group, subnet group and per-environment security group, the three ECR repositories and
  their lifecycle policies, the GitHub Actions OIDC provider and deploy role, the per-environment
  Secrets Manager secret, the ACM certificate and its CAA record, an optional ALB access-log
````

Replace (block 3 of 6):
````yaml
          }

  GithubOidcProvider:
    Type: AWS::IAM::OIDCProvider
````
with:
````yaml
          }

  EcrAudit:
    Type: AWS::ECR::Repository
    Condition: IsDev
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      RepositoryName: rch-audit
      ImageTagMutability: IMMUTABLE
      ImageScanningConfiguration:
        ScanOnPush: true
      EncryptionConfiguration:
        EncryptionType: AES256
      # Nothing ever deleted an image: every push of every branch since the first deploy is still
      # billed for. Untagged layers are orphans of an overwritten manifest and are worth nothing
      # after a week; tagged images are the rollback surface, and 30 of them is far more history
      # than `helm rollback` or deploy.yml's release tag can ever reach back to.
      LifecyclePolicy:
        LifecyclePolicyText: |
          {
            "rules": [
              {
                "rulePriority": 1,
                "description": "Expire untagged images after 7 days",
                "selection": {
                  "tagStatus": "untagged",
                  "countType": "sinceImagePushed",
                  "countUnit": "days",
                  "countNumber": 7
                },
                "action": { "type": "expire" }
              },
              {
                "rulePriority": 2,
                "description": "Keep only the 30 most recent tagged images",
                "selection": {
                  "tagStatus": "tagged",
                  "tagPatternList": ["*"],
                  "countType": "imageCountMoreThan",
                  "countNumber": 30
                },
                "action": { "type": "expire" }
              }
            ]
          }

  GithubOidcProvider:
    Type: AWS::IAM::OIDCProvider
````

Replace (block 4 of 6):
````yaml
                  - !Sub "arn:${AWS::Partition}:ecr:${AWS::Region}:${AWS::AccountId}:repository/rch-api"
                  - !Sub "arn:${AWS::Partition}:ecr:${AWS::Region}:${AWS::AccountId}:repository/rch-ui"
              - Sid: EksRead
                Effect: Allow
````
with:
````yaml
                  - !Sub "arn:${AWS::Partition}:ecr:${AWS::Region}:${AWS::AccountId}:repository/rch-api"
                  - !Sub "arn:${AWS::Partition}:ecr:${AWS::Region}:${AWS::AccountId}:repository/rch-ui"
                  - !Sub "arn:${AWS::Partition}:ecr:${AWS::Region}:${AWS::AccountId}:repository/rch-audit"
              - Sid: EksRead
                Effect: Allow
````

Replace (block 5 of 6):
````yaml
    Value: !If [IsDev, !GetAtt EcrUi.RepositoryUri, !ImportValue rch-shared-ecr-ui-uri]

  GitHubDeployRoleArn:
    Description: IAM role GitHub Actions assumes to deploy - feed to the AWS_ROLE_ARN repository secret.
````
with:
````yaml
    Value: !If [IsDev, !GetAtt EcrUi.RepositoryUri, !ImportValue rch-shared-ecr-ui-uri]

  EcrAuditUri:
    Description: rch-audit repository URI.
    Value: !If [IsDev, !GetAtt EcrAudit.RepositoryUri, !ImportValue rch-shared-ecr-audit-uri]

  GitHubDeployRoleArn:
    Description: IAM role GitHub Actions assumes to deploy - feed to the AWS_ROLE_ARN repository secret.
````

Replace (block 6 of 6):
````yaml
      Name: rch-shared-ecr-ui-uri

  GithubDeployRoleArnExport:
    Condition: IsDev
````
with:
````yaml
      Name: rch-shared-ecr-ui-uri

  EcrAuditUriExport:
    Condition: IsDev
    Value: !GetAtt EcrAudit.RepositoryUri
    Export:
      Name: rch-shared-ecr-audit-uri

  GithubDeployRoleArnExport:
    Condition: IsDev
````


**`deploy/cfn/dev.import.json`** (Note 11):

Replace (block 1 of 1):
````jsonc
  },
  {
    "ResourceType": "AWS::IAM::OIDCProvider",
    "LogicalResourceId": "GithubOidcProvider",
````
with:
````jsonc
  },
  {
    "ResourceType": "AWS::ECR::Repository",
    "LogicalResourceId": "EcrAudit",
    "ResourceIdentifier": {
      "RepositoryName": "rch-audit"
    }
  },
  {
    "ResourceType": "AWS::IAM::OIDCProvider",
    "LogicalResourceId": "GithubOidcProvider",
````


**`deploy/cfn/README.md`**:

Replace (block 1 of 6):
````markdown

`rch-env.yaml` codifies everything the account owner created by hand with the AWS CLI: the
Postgres instance, its parameter group, subnet group and security group, the two ECR
repositories and their lifecycle policies, the GitHub Actions OIDC provider and deploy role, a
per-environment Secrets Manager secret, an ACM certificate and its CAA record, an optional ALB
````
with:
````markdown

`rch-env.yaml` codifies everything the account owner created by hand with the AWS CLI: the
Postgres instance, its parameter group, subnet group and security group, the three ECR
repositories and their lifecycle policies, the GitHub Actions OIDC provider and deploy role, a
per-environment Secrets Manager secret, an ACM certificate and its CAA record, an optional ALB
````

Replace (block 2 of 6):
````markdown

A handful of the CLI-created resources are singletons AWS will not let a second stack recreate:
the DB subnet group (`rch`) is one VPC-wide group serving every environment's database, both ECR
repositories (`rch-api`, `rch-ui`) are one registry for every environment's images, and the
GitHub Actions OIDC provider is account-global outright - the role `rch-github-deploy`'s own
trust policy already admits every environment in one document, so it is shared too.
````
with:
````markdown

A handful of the CLI-created resources are singletons AWS will not let a second stack recreate:
the DB subnet group (`rch`) is one VPC-wide group serving every environment's database, the three
ECR repositories (`rch-api`, `rch-ui`, `rch-audit`) are one registry for every environment's
images, and the
GitHub Actions OIDC provider is account-global outright - the role `rch-github-deploy`'s own
trust policy already admits every environment in one document, so it is shared too.
````

Replace (block 3 of 6):
````markdown
The template's `IsDev` condition (`Env == "dev"`) gates all four: only a stack with `Env=dev`
declares them. A `staging` or `prod` stack skips them and instead reads their identifiers back
with `Fn::ImportValue` from four fixed export names the `dev` stack publishes (`rch-shared-db-
subnet-group-name`, `rch-shared-ecr-api-uri`, `rch-shared-ecr-ui-uri`,
`rch-shared-github-deploy-role-arn`). **This means the `dev` stack must exist before any
`staging` or `prod` stack is created** - the import fails otherwise, plainly, with
````
with:
````markdown
The template's `IsDev` condition (`Env == "dev"`) gates all four: only a stack with `Env=dev`
declares them. A `staging` or `prod` stack skips them and instead reads their identifiers back
with `Fn::ImportValue` from five fixed export names the `dev` stack publishes (`rch-shared-db-
subnet-group-name`, `rch-shared-ecr-api-uri`, `rch-shared-ecr-ui-uri`, `rch-shared-ecr-audit-uri`,
`rch-shared-github-deploy-role-arn`). **This means the `dev` stack must exist before any
`staging` or `prod` stack is created** - the import fails otherwise, plainly, with
````

Replace (block 4 of 6):
````markdown
## ECR does not keep every image any more

Both repositories carry a lifecycle policy: untagged images expire after 7 days (orphaned layers
of an overwritten manifest, worth nothing after a week), and only the 30 most recent tagged
images are kept. Thirty is far more history than `helm rollback` or `deploy.yml`'s release tag
````
with:
````markdown
## ECR does not keep every image any more

All three repositories carry a lifecycle policy: untagged images expire after 7 days (orphaned layers
of an overwritten manifest, worth nothing after a week), and only the 30 most recent tagged
images are kept. Thirty is far more history than `helm rollback` or `deploy.yml`'s release tag
````

Replace (block 5 of 6):
````markdown
aws cloudformation describe-change-set \
  --stack-name rch-dev --change-set-name rch-dev-import --region ap-south-1
# Read every change before executing. Nine resources import; the CAA record for
# rch.hashtrickstechnologies.com does not exist yet (see below) and shows as a plain CREATE
# in the same change set - that is expected, not a mistake in the import file.

aws cloudformation execute-change-set \
````
with:
````markdown
aws cloudformation describe-change-set \
  --stack-name rch-dev --change-set-name rch-dev-import --region ap-south-1
# Read every change before executing. Ten resources import; the CAA record for
# rch.hashtrickstechnologies.com does not exist yet (see below) and shows as a plain CREATE
# in the same change set - that is expected, not a mistake in the import file.
# `rch-audit` (EcrAudit) joined the list with the audit service, after rch-dev was imported. On
# that stack it is not imported at all: the next `aws cloudformation deploy` creates it. It is in
# dev.import.json only so a re-import stays complete - and a re-import needs the repository to
# exist first (`aws ecr create-repository --repository-name rch-audit`).

aws cloudformation execute-change-set \
````

Replace (block 6 of 6):
````markdown
## What's retained on delete

`DeletionPolicy: Retain` on the DB instance, the Secrets Manager secret, both ECR repositories,
the OIDC provider and the ALB access-log bucket - deleting the stack leaves all five in place,
and in the bucket's case that is the point: the logs are the record of what the ALB served, and a
````
with:
````markdown
## What's retained on delete

`DeletionPolicy: Retain` on the DB instance, the Secrets Manager secret, the three ECR repositories,
the OIDC provider and the ALB access-log bucket - deleting the stack leaves all five in place,
and in the bucket's case that is the point: the logs are the record of what the ALB served, and a
````


**`.trivyignore.yaml`** - prose and statements only; ids and expiries unchanged:

Replace (block 1 of 3):
````yaml
vulnerabilities:
  # libssl3 heap buffer overflow when parsing a large X.509 certificate, on 32-bit builds
  # only. Both runtime images are built and deployed as linux/amd64 (ci.yml / deploy.yml pin
  # the platform), so the affected code path is not reachable. Fixed in openssl
  # 3.0.19-1~deb12u2; drop this entry once gcr.io/distroless/nodejs24-debian12:nonroot ships
  # it (`trivy image <ref>` shows the version).
  #
  # EXPIRES 2026-09-30. On that date Trivy starts reporting this CVE again and **all four scans
  # fail closed at once** - ci.yml's two image scans and deploy.yml's two re-scans of the exact
  # ECR tags helm is about to deploy - so a deploy attempted after it lapses is blocked, not
  # warned about. That is the intended behaviour and the date is not to be pushed out to get
````
with:
````yaml
vulnerabilities:
  # libssl3 heap buffer overflow when parsing a large X.509 certificate, on 32-bit builds
  # only. All three runtime images (api, audit, ui) are built and deployed as linux/amd64
  # (ci.yml / deploy.yml pin the platform), so the affected code path is not reachable. Fixed in openssl
  # 3.0.19-1~deb12u2; drop this entry once gcr.io/distroless/nodejs24-debian12:nonroot ships
  # it (`trivy image <ref>` shows the version).
  #
  # EXPIRES 2026-09-30. On that date Trivy starts reporting this CVE again and **all six scans
  # fail closed at once** - ci.yml's three image scans and deploy.yml's three re-scans of the exact
  # ECR tags helm is about to deploy - so a deploy attempted after it lapses is blocked, not
  # warned about. That is the intended behaviour and the date is not to be pushed out to get
````

Replace (block 2 of 3):
````yaml
  # throwaway branch before a promotion, which is the one place a lapse is cheap to find.
  - id: CVE-2026-31789
    statement: 32-bit only; both images are linux/amd64. Awaiting the distroless base bump.
    expired_at: 2026-09-30

  # Five libssl3 findings in the same base image, all fixed in Debian (3.0.19-1~deb12u2 and
  # 3.0.20-1~deb12u2) and not yet in gcr.io/distroless/nodejs24-debian12:nonroot, which still
  # carries 3.0.18-1~deb12u2 (read from /var/lib/dpkg/status.d/libssl3 on 2026-09-12). The
  # api process never loads that library: the Node binary in the image is the official build
  # with OpenSSL linked in statically (OpenSSL 3.5.5 in the binary's own version string, and
  # no `libssl.so.3` or `libcrypto.so.3` among its dynamic dependencies - checked on the
````
with:
````yaml
  # throwaway branch before a promotion, which is the one place a lapse is cheap to find.
  - id: CVE-2026-31789
    statement: 32-bit only; all three images are linux/amd64. Awaiting the distroless base bump.
    expired_at: 2026-09-30

  # Five libssl3 findings in the same base image, all fixed in Debian (3.0.19-1~deb12u2 and
  # 3.0.20-1~deb12u2) and not yet in gcr.io/distroless/nodejs24-debian12:nonroot, which still
  # carries 3.0.18-1~deb12u2 (read from /var/lib/dpkg/status.d/libssl3 on 2026-09-12). That base
  # is shared by the api and audit images, and neither process loads that library: the Node
  # binary in the image is the official build
  # with OpenSSL linked in statically (OpenSSL 3.5.5 in the binary's own version string, and
  # no `libssl.so.3` or `libcrypto.so.3` among its dynamic dependencies - checked on the
````

Replace (block 3 of 3):
````yaml
  # is the same rebuild once the base ships the newer package.
  - id: CVE-2026-28387
    statement: Debian libssl3 is not loaded by the api; Node links its own OpenSSL. Awaiting the distroless base bump.
    expired_at: 2026-09-30
  - id: CVE-2026-28388
    statement: Debian libssl3 is not loaded by the api; Node links its own OpenSSL. Awaiting the distroless base bump.
    expired_at: 2026-09-30
  - id: CVE-2026-28389
    statement: Debian libssl3 is not loaded by the api; Node links its own OpenSSL. Awaiting the distroless base bump.
    expired_at: 2026-09-30
  - id: CVE-2026-28390
    statement: Debian libssl3 is not loaded by the api; Node links its own OpenSSL. Awaiting the distroless base bump.
    expired_at: 2026-09-30
  - id: CVE-2026-45447
    statement: Debian libssl3 is not loaded by the api; Node links its own OpenSSL. Awaiting the distroless base bump.
    expired_at: 2026-09-30
````
with:
````yaml
  # is the same rebuild once the base ships the newer package.
  - id: CVE-2026-28387
    statement: Debian libssl3 is not loaded by the api or the audit service; Node links its own OpenSSL. Awaiting the distroless base bump.
    expired_at: 2026-09-30
  - id: CVE-2026-28388
    statement: Debian libssl3 is not loaded by the api or the audit service; Node links its own OpenSSL. Awaiting the distroless base bump.
    expired_at: 2026-09-30
  - id: CVE-2026-28389
    statement: Debian libssl3 is not loaded by the api or the audit service; Node links its own OpenSSL. Awaiting the distroless base bump.
    expired_at: 2026-09-30
  - id: CVE-2026-28390
    statement: Debian libssl3 is not loaded by the api or the audit service; Node links its own OpenSSL. Awaiting the distroless base bump.
    expired_at: 2026-09-30
  - id: CVE-2026-45447
    statement: Debian libssl3 is not loaded by the api or the audit service; Node links its own OpenSSL. Awaiting the distroless base bump.
    expired_at: 2026-09-30
````


- [ ] **Step 4: Run to verify it passes**

Run: `bash "${TMPDIR:-/tmp}/rch-task18-check.sh"`
Expected: PASS - 21 `PASS:` lines, exit 0.

Run: `shellcheck /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/*.sh /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/chart/rch/ci/install-test.sh`
Expected: PASS - no output (the exact command CI's Deploy files job now runs).

Run, with actionlint installed locally or through Docker as CI does (skip if neither is available;
CI runs it):

```bash
W=/Users/srimanikandanr/.superset/worktrees/RCH-audit-log
if command -v actionlint >/dev/null; then
  actionlint "$W/.github/workflows/ci.yml" "$W/.github/workflows/deploy.yml" "$W/.github/workflows/deploy-box.yml"
elif docker info >/dev/null 2>&1; then
  docker run --rm -v "$W:/repo" -w /repo rhysd/actionlint:1.7.12 -color
else
  echo "SKIP: neither actionlint nor Docker - CI's Deploy files job runs it"
fi
```

Expected: PASS - no output (or the SKIP line).

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log helm:test`
Expected: PASS - `chart renders`.

The template and import list parse, and name what they should (no `cfn-lint` in the repo; PyYAML
may be absent, in which case only the JSON check runs):

```bash
W=/Users/srimanikandanr/.superset/worktrees/RCH-audit-log
jq -e '[.[] | select(.LogicalResourceId == "EcrAudit" and .ResourceIdentifier.RepositoryName == "rch-audit")] | length == 1' "$W/deploy/cfn/dev.import.json"
if python3 -c 'import yaml' 2>/dev/null; then
  python3 - "$W/deploy/cfn/rch-env.yaml" <<'PY'
import sys, yaml
class L(yaml.SafeLoader): pass
L.add_multi_constructor("!", lambda l, s, n: l.construct_scalar(n) if isinstance(n, yaml.ScalarNode) else l.construct_sequence(n) if isinstance(n, yaml.SequenceNode) else l.construct_mapping(n))
t = yaml.load(open(sys.argv[1]), Loader=L)
r = t["Resources"]["EcrAudit"]
assert r["Properties"]["RepositoryName"] == "rch-audit" and r["Condition"] == "IsDev" and r["DeletionPolicy"] == "Retain"
push = [s for s in t["Resources"]["GithubDeployRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"] if s["Sid"] == "EcrPush"][0]
assert any(x.endswith("repository/rch-audit") for x in push["Resource"])
assert t["Outputs"]["EcrAuditUriExport"]["Export"]["Name"] == "rch-shared-ecr-audit-uri" and "EcrAuditUri" in t["Outputs"]
print("rch-env.yaml: EcrAudit, its push grant and its outputs are in place")
PY
else
  echo "SKIP: PyYAML not installed - the template parse runs nowhere else, so read the diff instead"
fi
```

Expected: `true`, then `rch-env.yaml: EcrAudit, its push grant and its outputs are in place` (or
the SKIP line).

The kind install itself (`install-test.sh`) runs only in CI's images job, after the three images
are loaded; it is proven on the first CI run of the branch (Task 20).

- [ ] **Step 5: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add .github/workflows/ci.yml .github/workflows/deploy.yml deploy/chart/rch/ci/install-test.sh deploy/chart/rch/ci/postgres.yaml deploy/cfn/rch-env.yaml deploy/cfn/dev.import.json deploy/cfn/README.md .trivyignore.yaml
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Build, scan and smoke-test the audit image in CI and give it a registry and a deploy path

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```

---

### Task 19: Documentation

**Files:**
- Create: `apps/audit/CLAUDE.md`
- Modify: `CLAUDE.md`
- Modify: `apps/api/CLAUDE.md`
- Modify: `UI/CLAUDE.md`
- Modify: `packages/contract/CLAUDE.md`
- Modify: `README.md`
- Modify: `UI/README.md`
- Modify: `deploy/RUNBOOK.md`
- Modify: `deploy/chart/rch/templates/NOTES.txt` (the `kubectl exec` CLI line only; Task 17 edits its NetworkPolicy paragraph)
- Not modified: `deploy/compose/README.md` (Task 16 rewrote it whole with the audit service in it; Step 8 only checks it)
- Not modified: `packages/domain/CLAUDE.md` (nothing in it changes: domain still imports only `@rch/contract`, and no audit code lives there)

**Interfaces:**
- Consumes: all names from Tasks 1-18 (Shared Interfaces above; spec §1-§7)
- Produces: none

**How to apply this task.** Every edit below is an exact `Edit` call: the "Replace" block is the `old_string` (copied from the file as it stands on develop 609befb, which Tasks 1-18 leave untouched in every document this task edits, including its line breaks and indentation), the "With" block is the `new_string`. Where a step says "Insert after", the `old_string` is the anchor and the `new_string` is the anchor followed by the new text. Write normal hyphens with spaces (" - ") where a dash is meant; never an em dash. Do Steps 1-9b in any order, then Steps 10-12 in order.

---

- [ ] **Step 1: Root `CLAUDE.md`**

**1a. Package table.** Replace:

```markdown
| `apps/api` (`@rch/api`) | Fastify 5 + Drizzle on PostgreSQL 17; owns the ledger, document numbers, reservations, change stream |
| `UI` (`@rch/ui`) | React 19 + Vite 8 + Zustand 5; an API client end to end |
```

With:

```markdown
| `apps/api` (`@rch/api`) | Fastify 5 + Drizzle on PostgreSQL 17; owns the ledger, document numbers, reservations, change stream and the audit outbox |
| `apps/audit` (`@rch/audit`) | Fastify 5 on PostgreSQL 17; drains the API's audit outbox into its own append-only `audit` schema and serves the audit log |
| `UI` (`@rch/ui`) | React 19 + Vite 8 + Zustand 5; an API client end to end |
```

**1b. Dependency rule.** Replace:

```markdown
Dependencies flow one way only: **contract → domain → api / UI**. Nothing points back, and `apps/api` and `UI`
never import each other. Screens go through the store (`useApp`), never through `api/client` directly. The
oxlint import rules in `.oxlintrc.json` enforce all of this.
```

With:

```markdown
Dependencies flow one way only: **contract → domain → api / UI**, and **contract → audit**. Nothing points back.
`apps/api`, `apps/audit` and `UI` never import one another, and `apps/audit` imports nothing from the workspace
but `@rch/contract`. Screens go through the store (`useApp`), never through `api/client` directly. The oxlint
import rules in `.oxlintrc.json` enforce all of this.
```

**1c. Commands.** Replace:

````markdown
cp .env.example .env && pnpm --filter @rch/api keys:generate >> .env
                                # then set SEED_PASSWORD: required, ≥ 12 chars, no default - nothing starts without it
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed  # demo hospital; --bare = six locations + RC-0001 admin only; --force re-seeds
pnpm dev                        # API on :3000, UI on :5173 (Vite proxies /api)

pnpm build
pnpm typecheck
pnpm lint                       # oxlint per package + knip (unused exports/files/deps) + scripts/check-boundaries.sh
pnpm test                       # every package; apps/api needs Postgres reachable
````

With:

````markdown
cp .env.example .env && pnpm --filter @rch/api keys:generate >> .env
                                # then set SEED_PASSWORD: required, ≥ 12 chars, no default - nothing starts without it
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/audit db:migrate   # the audit schema; run after the API's, whose audit_outbox it waits for
pnpm --filter @rch/api db:seed  # demo hospital; --bare = six locations + RC-0001 admin only; --force re-seeds
pnpm dev                        # API on :3000, audit service on :3100, UI on :5173 (Vite proxies /api)

pnpm build
pnpm typecheck
pnpm lint                       # oxlint per package + knip (unused exports/files/deps) + scripts/check-boundaries.sh
pnpm test                       # every package; apps/api and apps/audit need Postgres reachable
````

**1d. One-file runs.** Replace:

````markdown
pnpm --filter @rch/api exec vitest run src/modules/tickets/tickets.test.ts -t "handover"
```
````

With:

````markdown
pnpm --filter @rch/api exec vitest run src/modules/tickets/tickets.test.ts -t "handover"
pnpm --filter @rch/audit exec vitest run src/modules/audit/audit.test.ts
```

`.env.example` already names the audit service's connection, `AUDIT_DATABASE_URL`. Locally it, `DATABASE_URL` and
the unset `MIGRATE_DATABASE_URL` all name the one `rch` user, so neither migrate step creates a database role
(`deploy/RUNBOOK.md` §5, *The database roles*).
````

**1e. CI item 7.** Replace:

```markdown
7. It builds both images, scans them with Trivy at `CRITICAL,HIGH`, and does a real `helm install` into a
   throwaway kind cluster.
```

With:

```markdown
7. It builds all three images (`rch-api`, `rch-ui`, `rch-audit`), scans them with Trivy at `CRITICAL,HIGH`,
   and does a real `helm install` into a throwaway kind cluster. That install signs in and then finds the
   sign-in in the audit log, which proves the outbox, the drainer and the read route on a real cluster.
```

**1f. Coverage floors.** Replace:

```markdown
- **Coverage floors are part of `test`.** The floors are UI lines 73 / branches 51, `apps/api` 94 / 79,
  `packages/domain` 99 / 92, and `packages/contract` lines 96. Raise a floor when the real figure rises. Never
```

With:

```markdown
- **Coverage floors are part of `test`.** The floors are UI lines 73 / branches 51, `apps/api` 94 / 79,
  `apps/audit` 90 / 75, `packages/domain` 99 / 92, and `packages/contract` lines 96. Raise a floor when the real figure rises. Never
```

**1g. `develop` deploys itself.** Replace:

```markdown
  runs `deploy/compose/release.sh <sha>` on the box through SSM. That backs the database up to S3,
  fast-forwards, runs `deploy.sh` and fails unless `/readyz` answers. It never rolls the box back past a
  newer commit.
```

With:

```markdown
  runs `deploy/compose/release.sh <sha>` on the box through SSM. That backs the database up to S3,
  fast-forwards, runs `deploy.sh` and fails unless both `/readyz` (the API: its database and migrations) and
  `/readyz/audit` (the audit service: its migrations and a recent drain pass) answer. It never rolls the box
  back past a newer commit.
```

**1h. One manifest.** Replace:

```markdown
`packages/contract/src/routes.ts` declares every route with `defineRoute({ method, path, access, body?,
response, … })`.

- **Server:** `apps/api/src/routes.ts`'s `mount()` registers each route with its schemas, auth, role gate and
  idempotency preHandler.
- **Browser:** `UI/src/api/client.ts`'s `call(route, input)` builds the URL, mints the `Idempotency-Key`, and
  refreshes the token once on a 401.
```

With:

```markdown
`packages/contract/src/routes.ts` declares every route with `defineRoute({ method, path, access, service?,
body?, response, … })`.

- **Server:** `apps/api/src/routes.ts`'s `mount()` registers each `service: "api"` route (the default) with its
  schemas, auth, role gate and idempotency preHandler. `apps/audit/src/routes.ts`'s `mount()` registers the
  `service: "audit"` routes. Each `mount()` throws on a route tagged for the other service.
- **Browser:** `UI/src/api/client.ts`'s `call(route, input)` builds the URL, mints the `Idempotency-Key`, and
  refreshes the token once on a 401. It doesn't know which service answers: Vite, Caddy, the UI's nginx and the
  ingress each send `/api/v1/admin/audit` to the audit service, ahead of `/api`.
```

**1i. A write, end to end.** Replace:

```markdown
3. The service runs inside `withTransaction`. It locks, applies the rules from `@rch/domain`, posts moves,
   appends history, and calls `emitChanged` (a `pg_notify`, held until commit).
```

With:

```markdown
3. The service runs inside `withTransaction`. It locks, applies the rules from `@rch/domain`, posts moves,
   appends history, and calls `emitChanged` (a `pg_notify`, held until commit). Before COMMIT,
   `withTransaction` records the idempotency outcome and inserts the write's audit event into `audit_outbox`.
```

And replace:

```markdown
A refusal is an error envelope whose `message` is the sentence toasted. Any cart or form is left exactly as it
was.
```

With:

```markdown
A refusal is an error envelope whose `message` is the sentence toasted. Any cart or form is left exactly as it
was. Its audit event is written after the reply, since the write's own transaction rolled back.
```

**1j. Roles and scope.** Replace:

```markdown
  account sees only the standalone `/admin` page, never an operational shell. There it manages staff accounts
  and answers every role's support tickets as the support desk. The flag can only be set with
  `pnpm --filter @rch/api users set-admin`; no route can set it.
```

With:

```markdown
  account sees only the standalone `/admin` page, never an operational shell. The page has three tabs:
  Accounts (staff accounts), Support desk (every role's support tickets) and Audit log (every write and
  sign-in). The flag can only be set with `pnpm --filter @rch/api users set-admin`; no route can set it.
```

And replace:

```markdown
  route (sign-in, password, `/me`). `GET /events` opts back in with `admitAdmin`, for the support desk.
```

With:

```markdown
  route (sign-in, password, `/me`). `GET /events` opts back in with `admitAdmin`, for the support desk and the
  audit log's new-events count. The audit service gives a token without `admin` the same **404**.
```

**1k. Server-side guarantees.** Replace:

```markdown
- Every non-public write carries an `Idempotency-Key`. The outcome is recorded inside the write's own
  transaction, so a retry replays the answer instead of producing a second bill.
```

With:

```markdown
- Every non-public write carries an `Idempotency-Key`. The outcome is recorded inside the write's own
  transaction, so a retry replays the answer instead of producing a second bill.
- **The audit tables have one writer each.** In `apps/api`, only `src/lib/audit.ts` inserts into
  `audit_outbox`, and nothing selects, updates or deletes from it. In `apps/audit`, only `src/lib/drain.ts`
  deletes from the outbox or inserts into `audit.events` and `audit.dead_letters`, and nothing anywhere updates
  `audit.*`. `scripts/check-boundaries.sh` enforces this by grep, and the database roles enforce it again.
- **No long-running service connects as the superuser.** The API runs as `rch_app`: every API table, but only
  `insert` on `audit_outbox`. The audit service runs as `rch_audit`: `select, delete` and a column
  `update (at)` on the outbox, `select, insert` on the audit tables, nothing else. A trigger refuses every
  UPDATE on `audit_outbox`, so that column grant only lets the drainer lock rows. Migrations and the operator
  CLIs connect as `rch` through
  `MIGRATE_DATABASE_URL`. Each migrate step creates its runtime role from the runtime URL and re-grants it on
  every run; where the two URLs name the same user (locally, the test suites) it creates nothing.
```

**1l. New subsection "The audit log".** Insert after the Server-side guarantees block, i.e. replace:

```markdown
### Browser-side state
```

With:

```markdown
### The audit log

**Every write and every sign-in leaves exactly one audit event.** The super admin reads them on `/admin`'s
Audit log tab: who, when, from which IP and device, what was sent, the server's sentence, and for an edit the
values before it.

- **Capture is central, in the API.** `mount()` hands each non-public write's context to `withTransaction`,
  which inserts a `done` event into `audit_outbox` in the write's own transaction. The event commits with the
  write or not at all. `plugins/audit.ts`'s `onResponse` hook records a refusal (any 4xx but a 401), a 5xx, or
  a success no transaction recorded, but only when a valid token identifies the caller: a write refused with no
  verifiable token leaves no event. `modules/auth` records sign-in, failed sign-in, lock-out, sign-out and
  password change itself. A 401, an idempotent replay, a token refresh and every read are not events.
- **An edit records its before values.** A service that updates or removes an existing master row or account
  calls `auditBefore(...)` right after reading that row (after locking it, where the service locks), before any
  rule or change, so a refused edit carries its before too. A document status change doesn't; its trail
  already carries the before.
- **Secrets never reach the log.** `maskSecrets` replaces the value of every key named in `SECRET_KEYS`
  (`password`, `newPassword`, `currentPassword`, `tempPassword`, `otp`, `token`, `accessToken`, `refreshToken`,
  `secret`) with `••••`, in the request, the result and the before values. It matches whole names, so
  `mustChangePassword` stays readable. A password change's event carries no request at all.
- **A separate service keeps it.** `apps/audit` drains the outbox into `audit.events` exactly once (the delete
  and the insert share one transaction, with `for update skip locked`), sets an event it can't store aside in
  `audit.dead_letters`, and serves `GET /admin/audit` and `GET /admin/audit/:id`. A trigger refuses UPDATE,
  DELETE and TRUNCATE on both tables for every role, and nothing is ever purged.
- **Only the super admin reads it.** The audit service verifies the API's tokens with the public keys alone and
  answers 404 to any token without `admin`. After storing events the drainer announces `audit` on the change
  stream, and the API relays that notice to admin streams only.

### Browser-side state
```

**1m. Domain invariants.** Replace:

```markdown
  The buyer's direct add (`POST /requisitions/direct`) is a requisition raised and approved in one step,
  with a required reason, and only for raw, packing and MRP goods (`isPurchased`).
```

With:

```markdown
  The buyer's direct add (`POST /requisitions/direct`) is a requisition raised and approved in one step,
  with a required reason, and only for raw, packing and MRP goods (`isPurchased`).
- **Every write and every sign-in leaves an audit event; nobody can edit or delete one.** A write whose event
  can't be inserted doesn't commit. No password, temporary password, OTP or token is ever stored in one.
```

**1n. Conventions.** Replace:

```markdown
- `LocKey`, `Role` and every status are closed unions. Never widen one with `string`.
```

With:

```markdown
- `LocKey`, `Role` and every status are closed unions. Never widen one with `string`. The one deliberate
  `string` is an audit row's stored `action`, so a removed route's history still reads.
```

---

- [ ] **Step 2: `apps/api/CLAUDE.md`**

**2a. Commands.** Replace:

````markdown
pnpm --filter @rch/api db:migrate           # behind pg_advisory_lock
````

With:

````markdown
pnpm --filter @rch/api db:migrate           # behind pg_advisory_lock(727272); creates rch_app when DATABASE_URL names another user
````

Then insert after the Commands block, i.e. replace:

````markdown
pnpm --filter @rch/api loadcheck            # latency of /snapshot and /bills against a running API
```
````

With:

````markdown
pnpm --filter @rch/api loadcheck            # latency of /snapshot and /bills against a running API
```

Every CLI connects with `MIGRATE_DATABASE_URL` when it is set and `DATABASE_URL` otherwise
(`cliDatabaseUrl(config)` in `src/config.ts`). The server itself only ever uses `DATABASE_URL`.
````

**2b. Layout.** Replace:

```markdown
src/plugins/*     logging, errors, metrics, health, security, db, auth, rbac, sse, idempotency
src/lib/*         ledger, reservations, tickets, ids, history, rules, events, claims, credit, master, …
```

With:

```markdown
src/plugins/*     logging, errors, metrics, health, security, db, auth, rbac, sse, idempotency, audit
src/lib/*         ledger, reservations, tickets, ids, history, rules, events, claims, credit, master, audit, roles, …
```

**2c. How a write is composed.** Replace:

```markdown
8. **Change state:** `postMoves` when stock moves, `writeTicket` / `reserve` for a hold, and the repo's status
   writes.
```

With:

```markdown
8. **Change state:** `postMoves` when stock moves, `writeTicket` / `reserve` for a hold, and the repo's status
   writes. An edit to an existing master row or account calls `auditBefore({ … })` first, with the wire-shaped
   fields it can alter (see *Audit capture*).
```

And replace:

```markdown
10. **Return `{ result, changed, message }` from inside the transaction.** `withTransaction` records the
    idempotency outcome from that value as its last statement before COMMIT. A service that re-reads a row
    after its transaction has closed puts its answer outside the protection.
```

With:

```markdown
10. **Return `{ result, changed, message }` from inside the transaction.** `withTransaction` records the
    idempotency outcome and then the audit event from that value, as its last statements before COMMIT. A
    service that re-reads a row after its transaction has closed puts its answer outside the protection.
```

**2d. Account deletion and the audit log.** Replace:

```markdown
  foreign-key refusal (`isForeignKeyViolation`, 23503) is the rule, and becomes a `RuleError`. Don't enumerate
  tables there: a new table that references `users` is covered by its own foreign key.
```

With:

```markdown
  foreign-key refusal (`isForeignKeyViolation`, 23503) is the rule, and becomes a `RuleError`. Don't enumerate
  tables there: a new table that references `users` is covered by its own foreign key. Audit events are not
  history in this sense: `audit.events.actor_id` has no foreign key, so they never block a delete.
```

**2e. New section "Audit capture".** Insert before `## Events`, i.e. replace:

```markdown
## Events

- **`emitChanged` sends a `pg_notify` inside the transaction**, so a refused write announces nothing. The
```

With:

```markdown
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
```

**2f. Events.** Replace:

```markdown
- **`plugins/sse.ts` fans notices out to every open stream.** It holds one `LISTEN` client per pod and sends
  a `resync` after a reconnect.
```

With:

```markdown
- **`plugins/sse.ts` fans notices out to every open stream**, with one exception: it records whether each
  stream's token is an admin's, and sends an `audit` notice (only the audit service's drainer emits one) to
  admin streams alone. It holds one `LISTEN` client per pod and sends a `resync` after a reconnect.
```

**2g. Protected tables.** Replace:

```markdown
- `stock_moves` and `document_history` are append-only in the database; triggers refuse UPDATE and DELETE. To
  correct a mistake, append a reversing move or a correcting entry.
```

With:

```markdown
- `stock_moves` and `document_history` are append-only in the database; triggers refuse UPDATE and DELETE. To
  correct a mistake, append a reversing move or a correcting entry.
- **`audit_outbox` is narrower still.** Outside test files, only `src/lib/audit.ts` inserts into it, and nothing
  selects, updates or deletes from it. The audit service is its only reader. Migration `0016_audit_outbox` also
  puts a trigger on it (`audit_outbox_no_update`) that refuses every UPDATE, for every role.
```

**2h. Errors.** Replace:

```markdown
  internal reason, for example which of the three login failures it was. It is never serialised to the
  client.
```

With:

```markdown
  internal reason, for example which of the three login failures it was. It is never serialised to the
  client. It is stored as the audit event's `cause`, which only the super admin reads.
```

**2i. Tests.** Replace:

```markdown
- **`sequences` survives truncation**, so never assert a literal allocated id. Match the shape and assert the
  relative step instead.
```

With:

```markdown
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
```

**2j. Migrations and config.** Replace:

```markdown
- **`SEED_PASSWORD` is required** (at least 12 characters, no default). `DATABASE_SSL` defaults to on in
  production. Queries time out after 15 s; the CLIs pass `0`.
```

With:

```markdown
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
```

---

- [ ] **Step 3: Create `apps/audit/CLAUDE.md`**

Write this file in full:

````markdown
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
src/config.ts            loadConfig(env) - the only reader of process.env; ConfigError
src/routes.ts            mount(): registers service: "audit" routes and nothing else; mountedRoutes
src/plugins/*            logging, errors, security, metrics, health, db, auth, drainer
src/lib/drain.ts         drainOnce and outboxStats: one pass, outbox → audit.events / audit.dead_letters
src/lib/migrate-run.ts   migrateAudit and waitForOutbox: the migrate CLI's logic, where tests can reach it
src/lib/roles.ts         roleFromUrls, ensureLoginRole, grantAuditRole
src/lib/db.ts            Tx, Reader, withReadTransaction
src/lib/time.ts          istDay, istDayStart, nextIstDay
src/lib/errors.ts        AppError and its 400 / 401 / 403 / 404 / 503 subclasses
src/modules/audit/*      routes.ts, service.ts, repo.ts, audit.test.ts - the two read routes
src/db/*                 client.ts (createDb), migrate.ts, schema.ts (the Drizzle tables)
src/cli/migrate.ts       load the config, run migrateAudit, exit with its code
src/test/*               the per-file schema harness, the test config and token minting
drizzle/*.sql            migrations + meta/_journal.json
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
````

---

- [ ] **Step 4: `UI/CLAUDE.md`**

**4a. Commands.** Replace:

````markdown
pnpm --filter @rch/ui dev         # vite on :5173, proxying /api → http://localhost:3000
````

With:

````markdown
pnpm --filter @rch/ui dev         # vite on :5173, proxying /api/v1/admin/audit → http://localhost:3100 and the rest of /api → http://localhost:3000
````

**4b. The admin page.** Replace:

```markdown
That page has two tabs: `AdminUsers` (staff accounts) and `AdminSupport` (the support desk: every role's tickets).
```

With:

```markdown
That page has three tabs: `AdminUsers` (staff accounts), `AdminSupport` (the support desk: every role's tickets)
and `AdminAudit` (the audit log: every write and sign-in, newest first, with filters, counts and a CSV export).
With no `Shell` around it, `AdminDashboard.tsx` mounts the `<Drawer />` host itself.
```

**4c. Drawers.** Replace:

```markdown
- `screens.test.tsx`'s `OPEN_OVER` map needs a `key → [id, role]` row for every registered drawer, or the
  suite fails by name.
```

With:

```markdown
- `screens.test.tsx`'s `OPEN_OVER` map needs a `key → [id, role]` row for every registered drawer, or the
  suite fails by name.
- `pages/AuditEntryDrawer.tsx` registers `auditEntry`, opened with `openDrawer("auditEntry", String(id))`. It
  reads its entry through `readAuditEntry` as it opens, because an audit entry is never kept in the store.
```

**4d. Slices.** Replace:

```markdown
`src/store/index.ts` holds the state and most actions. The other slices (`procurement.ts`, `ops.ts`,
`admin.ts`) are merged into the same `create()` and share one `AppState`. Components subscribe
```

With:

```markdown
`src/store/index.ts` holds the state and most actions. The other slices (`procurement.ts`, `ops.ts`,
`admin.ts`, `audit.ts`) are merged into the same `create()` and share one `AppState`. Components subscribe
```

**4e. Audit reads.** Replace:

```markdown
- **An admin-flagged session loads no snapshot.** `loadSnapshot` sets `auth: "ready"` and returns for one,
```

With:

```markdown
- **The audit log's reads (`store/audit.ts`) return `null` on failure**: `loadAudit` (replaces the rows),
  `loadMoreAudit` (appends the page before `next`), `readAuditEntry` (one full entry, not kept in the store)
  and `exportAudit` (pages at 500 rows until `next` is null or 50,000 rows, and says whether it hit the cap).
  `AdminAudit.tsx` shows an outage line on `null`, never "no events". They have no refetch; an `audit` notice
  only bumps `audit.fresh`.
- **An admin-flagged session loads no snapshot.** `loadSnapshot` sets `auth: "ready"` and returns for one,
```

**4f. `refetch.ts`.** Replace:

```markdown
  If a read-back fails, the write's own sentence is kept and qualified, never replaced. `tickets` is the one
  reader that branches: an admin session reads the desk's list (`GET /admin/support/tickets` into
  `deskTickets`), and everyone else reads their own tickets.
```

With:

```markdown
  If a read-back fails, the write's own sentence is kept and qualified, never replaced. Two readers branch on
  an admin session. `tickets`: an admin session reads the desk's list (`GET /admin/support/tickets` into
  `deskTickets`), and everyone else reads their own tickets. `audit`: an admin session calls `bumpAuditFresh()`,
  so the Audit log tab shows "New events - show" without moving its rows, and any other session does
  nothing. No write names `audit` in its `changed`; only the audit service's notice does.
```

**4g. Tests.** Replace:

```markdown
- **`fixes.test.ts`** pins earlier defects by tag (C6, M3, M8, H4, UA-14…). Read the comment before changing
  what one covers.
```

With:

```markdown
- **`admin-audit.test.tsx`** drives the Audit log tab against a stubbed `GET /admin/audit`: rows and counts,
  filters reaching the query string, "Load more" sending `before`, an `audit` notice showing the pill without
  changing the rows, before → after listing only changed fields in the drawer, and the outage line against
  the empty state. **`audit-lib.test.ts`** pins `lib/audit.ts`'s `auditDayRange`, `deviceOf`, `diffFields` (one
  level into a nested object, arrays compared whole) and `auditCsv`. `writes.test.ts` covers the slice's reads
  and `refetch`'s `audit` reader.
- **`fixes.test.ts`** pins earlier defects by tag (C6, M3, M8, H4, UA-14…). Read the comment before changing
  what one covers.
```

---

- [ ] **Step 5: `packages/contract/CLAUDE.md`**

**5a. What this is.** Replace:

```markdown
This package is the wire contract. Every shape that crosses between `UI` and `apps/api` is a Zod schema
declared here and nowhere else, and every route the API serves is one entry in one manifest. It imports nothing
from `@rch/domain` or `apps/api`; its only runtime dependency is `zod`.
```

With:

```markdown
This package is the wire contract. Every shape that crosses between `UI`, `apps/api` and `apps/audit` is a Zod
schema declared here and nowhere else, and every route either service serves is one entry in one manifest. It
imports nothing from `@rch/domain`, `apps/api` or `apps/audit`; its only runtime dependency is `zod`.
```

**5b. Commands.** Replace:

````markdown
pnpm --filter @rch/contract test        # routes.test.ts, schemas/*.test.ts, fixtures.test.ts (floor: lines 96)
````

With:

````markdown
pnpm --filter @rch/contract test        # routes.test.ts, audit.test.ts, schemas/*.test.ts, fixtures.test.ts (floor: lines 96)
````

**5c. Layout.** Replace:

```markdown
src/routes.ts             defineRoute, the `routes` manifest, API_PREFIX (/api/v1)
```

With:

```markdown
src/routes.ts             defineRoute, the `routes` manifest, API_PREFIX (/api/v1), serviceOf, isWriteRoute
src/audit.ts              AUDIT_GROUPS, AUDIT_LABELS, auditLabelOf, actionsInGroup, AUDIT_PATH
```

And replace:

```markdown
src/schemas/{auth,admin,events,reports}.ts
```

With:

```markdown
src/schemas/{auth,admin,events,reports}.ts
src/schemas/audit.ts      AuditEventSchema (the API → audit service event), AuditRow/Entry/Page/Query schemas
```

**5d. The manifest.** Replace:

```markdown
Each route is `defineRoute({ method, path, access, params?, query?, body?, response, write?, allowMcp? })`. The
manifest drives both sides: `mount()` in `apps/api/src/routes.ts` and `call()` in `UI/src/api/client.ts`.
```

With:

```markdown
Each route is `defineRoute({ method, path, access, service?, params?, query?, body?, response, write?,
allowMcp? })`. The manifest drives all three: `mount()` in `apps/api/src/routes.ts`, `mount()` in
`apps/audit/src/routes.ts`, and `call()` in `UI/src/api/client.ts`.

- **`service`** is `"api"` (the default, read through `serviceOf`) or `"audit"`. Each app's `mount()` throws on
  a route tagged for the other, and each app has a test that it mounts every route tagged for it. `auditLog`
  (`GET /admin/audit`) and `auditEntry` (`GET /admin/audit/:id`) are the audit service's two, both
  `access: "admin"`. `call()` needs no change for them: every proxy in front sends `AUDIT_PATH` under
  `API_PREFIX` to the audit service.
```

**5e. Audit labels, the event schema, the `audit` collection.** Replace:

```markdown
- **Add a GET together with the module that answers it.** `apps/api/src/contract.test.ts` probes every
```

With:

```markdown
- **Every write has an audit label.** `AUDIT_LABELS` is a `Record<AuditAction, AuditLabel>`, and `AuditAction`
  is the name of every manifest write route plus `login`, `logout` and `changePassword`. A new write route
  without a label fails `typecheck`. A label is past tense ("Changed a price"), names its `group` (a key of
  `AUDIT_GROUPS`), and carries `refused` only where a refusal means something else (`login` → "Failed
  sign-in"). A route removed from the manifest loses its label; `auditLabelOf` then prints the stored action
  name, so old rows still read.
- **`AuditEventSchema` is the wire between `apps/api` and `apps/audit`**, not a browser shape. The API inserts
  one into `audit_outbox`; the audit service's drainer parses each row with it, and a row that fails lands in
  `audit.dead_letters`. Its `action` is a plain `string` on purpose, so a removed route's history still reads.
  Ship a change to it in both images at once.
- **`audit` is the one collection no write response names.** Only the audit service's drainer announces it,
  and `UI/src/api/refetch.ts`'s reader for it only bumps a counter.
- **Add a GET together with the module that answers it.** `apps/api/src/contract.test.ts` probes every
```

**5f. What makes a write.** Replace:

```markdown
- **`write`** defaults to `method !== "GET"`. A write carries an `Idempotency-Key`. The auth routes set
  `write: false`.
```

With:

```markdown
- **`write`** defaults to `method !== "GET"`. A write carries an `Idempotency-Key`. The auth routes set
  `write: false`. `isWriteRoute(r)` is the one runtime reading of that rule, and `defineRoute` keeps `method`
  and `write` as literal types so `AuditAction` can apply the same rule at the type level.
```

---

- [ ] **Step 6: `README.md`**

**6a. What the system does.** Replace:

```markdown
request raised at the Coffee Shop appears on the manager's approvals screen without a reload - and
two tills can never both sell the last unit.
```

With:

```markdown
request raised at the Coffee Shop appears on the manager's approvals screen without a reload - and
two tills can never both sell the last unit.

**An audit log nobody can edit.** Every change anyone makes, done or refused, and every sign-in
lands in a log kept by a separate service. The super admin reads it on `/admin`: who, when, from
which IP and device, what was sent, the server's sentence, and for an edit what the values were
before. Neither the API's database credential nor anyone signed in can change or delete a line
of it.
```

**6b. Architecture at a glance.** Replace:

````markdown
```
Browser (React 19, Vite) ──HTTPS──▶ API (Fastify 5, Node 24) ──▶ PostgreSQL 17
                         ◀──SSE──── GET /events
```
````

With:

````markdown
```
Browser (React 19, Vite) ──HTTPS──▶ API (Fastify 5, Node 24) ────────▶ PostgreSQL 17
                         ◀──SSE──── GET /events                        ▲
                         ──HTTPS──▶ Audit (Fastify 5, Node 24) ────────┘
                                    GET /admin/audit
```
````

And replace:

```markdown
- **`apps/api`** - Fastify 5 + Drizzle. Owns the ledger, the document numbers, the reservations
  and the change stream. Writes are transactional and idempotent: each carries an
  `Idempotency-Key`, so a retry cannot produce a second bill.
```

With:

```markdown
- **`apps/api`** - Fastify 5 + Drizzle. Owns the ledger, the document numbers, the reservations
  and the change stream. Writes are transactional and idempotent: each carries an
  `Idempotency-Key`, so a retry cannot produce a second bill. Every write and every sign-in also
  leaves an audit event in an outbox table, inside the write's own transaction.
- **`apps/audit`** - a second, small Fastify service. It drains that outbox into its own
  append-only `audit` schema, exactly once, and answers the super admin's audit log. It imports
  only the contract, and runs under a database role that can add to the log but never change it.
```

**6c. Repository layout.** Replace:

````markdown
apps/api/         the HTTP API (Fastify 5, Drizzle, PostgreSQL) and its migrations
````

With:

````markdown
apps/api/         the HTTP API (Fastify 5, Drizzle, PostgreSQL) and its migrations
apps/audit/       the audit log service (Fastify 5, PostgreSQL) and its migrations
````

And replace:

```markdown
`CLAUDE.md` at the root and in `apps/api`, `packages/contract`, `packages/domain` and `UI` are
```

With:

```markdown
`CLAUDE.md` at the root and in `apps/api`, `apps/audit`, `packages/contract`, `packages/domain` and `UI` are
```

**6d. Running it.** Replace:

```markdown
Six commands, clone to signed-in browser. You need **Node 24** (see `.nvmrc`), **pnpm 10.28.2**
```

With:

```markdown
Seven commands, clone to signed-in browser. You need **Node 24** (see `.nvmrc`), **pnpm 10.28.2**
```

And replace:

````markdown
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed
pnpm dev                                                                    # API on :3000, UI on :5173
````

With:

````markdown
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/audit db:migrate                                         # the audit log's schema, after the API's
pnpm --filter @rch/api db:seed
pnpm dev                                                                    # API on :3000, audit service on :3100, UI on :5173
````

**6e. RC-0001 row.** Replace:

```markdown
| `RC-0001` | System Administrator | Super Admin: staff accounts and the support desk, no role or location |
```

With:

```markdown
| `RC-0001` | System Administrator | Super Admin: staff accounts, the support desk and the audit log, no role or location |
```

**6f. Everyday commands.** Replace:

```markdown
| `pnpm dev` | API on :3000 and the UI on :5173, in parallel (Vite proxies `/api`) |
```

With:

```markdown
| `pnpm dev` | API on :3000, the audit service on :3100 and the UI on :5173, in parallel (Vite proxies `/api`, sending the audit log's routes to :3100) |
```

And replace:

```markdown
| `pnpm test` | Every package's test suite, coverage floors included (Postgres must be reachable for `apps/api`) |
```

With:

```markdown
| `pnpm test` | Every package's test suite, coverage floors included (Postgres must be reachable for `apps/api` and `apps/audit`) |
```

And replace:

```markdown
| `pnpm --filter @rch/api db:migrate` | Apply migrations |
```

With:

```markdown
| `pnpm --filter @rch/api db:migrate` | Apply the API's migrations |
| `pnpm --filter @rch/audit db:migrate` | Apply the audit service's migrations (run after the API's: it waits for the API's outbox table) |
```

**6g. Testing.** Replace:

```markdown
Four suites, all run by `pnpm test`: **`packages/domain`** proves the rules against literal
expected values; **`packages/contract`** proves every request body accepts its own shape and
refuses an unknown key; **`apps/api`** tests endpoints against a real PostgreSQL, each file in its
own schema, migrated on setup and dropped on close so files run in parallel without colliding;
**`UI`** covers the store, the screens (every role × every sidebar entry renders), the API-backed
actions against a stubbed `fetch`, and the live-update client.

Run one package with `pnpm --filter @rch/ui test` (or `@rch/api`, `@rch/domain`, `@rch/contract`);
the API suite needs Postgres reachable, so `pnpm db:up` first. The API and UI suites both pin
`TZ=UTC`, so timezone-sensitive assertions prove the same thing on every machine.

Each package's `test` script carries a **coverage floor** - UI lines 73 / branches 51, `apps/api`
94 / 79, `packages/domain` 99 / 92, `packages/contract` lines 96 - set a point or two under what
that suite measures today, so deleting a test or shipping an untested screen fails rather than
```

With:

```markdown
Five suites, all run by `pnpm test`: **`packages/domain`** proves the rules against literal
expected values; **`packages/contract`** proves every request body accepts its own shape and
refuses an unknown key, and that every write route has an audit label; **`apps/api`** tests
endpoints against a real PostgreSQL, each file in its own schema, migrated on setup and dropped
on close so files run in parallel without colliding, and proves every write and sign-in leaves
exactly one audit event with its secrets masked; **`apps/audit`** drains a real outbox into the
audit tables and reads them back, each file with its own outbox and audit schemas, and proves
two drainers never store an event twice; **`UI`** covers the store, the screens (every role ×
every sidebar entry renders), the API-backed actions against a stubbed `fetch`, and the
live-update client.

Run one package with `pnpm --filter @rch/ui test` (or `@rch/api`, `@rch/audit`, `@rch/domain`,
`@rch/contract`); the API and audit suites need Postgres reachable, so `pnpm db:up` first. The API
and UI suites both pin `TZ=UTC`, so timezone-sensitive assertions prove the same thing on every
machine.

Each package's `test` script carries a **coverage floor** - UI lines 73 / branches 51, `apps/api`
94 / 79, `apps/audit` 90 / 75, `packages/domain` 99 / 92, `packages/contract` lines 96 - set at or
a point or two under what that suite measures today, so deleting a test or shipping an untested screen fails rather than
```

**6h. Continuous integration.** Replace:

```markdown
second job builds the API and UI images, scans both with Trivy at **critical and high** severity
against `.trivyignore.yaml`, and does a real `helm install`, seed and sign-in against a
throwaway kind cluster. A third renders the Helm chart on its own. Everything must be green to
```

With:

```markdown
second job builds the API, UI and audit images, scans all three with Trivy at **critical and
high** severity against `.trivyignore.yaml`, and does a real `helm install`, seed and sign-in
against a throwaway kind cluster, then finds that sign-in in the audit log through the audit
service. A third renders the Helm chart on its own. Everything must be green to
```

**6i. Where the documents are.** Replace:

```markdown
- **`deploy/RUNBOOK.md`** - operations: deploy, roll back, keys, accounts, restore.
```

With:

```markdown
- **`deploy/RUNBOOK.md`** - operations: deploy, roll back, keys, accounts and database roles,
  restore, alerts, and reading the audit log from the box.
```

---

- [ ] **Step 7: `UI/README.md`**

**7a. Run.** Replace:

````markdown
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed
pnpm dev                                     # apps/api on :3000, this app on :5173
````

With:

````markdown
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/audit db:migrate          # the audit log's schema, after the API's
pnpm --filter @rch/api db:seed
pnpm dev                                     # apps/api on :3000, apps/audit on :3100, this app on :5173
````

And replace:

```markdown
The dev server proxies `/api` to the Fastify API on `:3000`.
```

With:

```markdown
The dev server proxies `/api/v1/admin/audit` to the audit service on `:3100` and the rest of `/api`
to the Fastify API on `:3000`.
```

**7b. Layout.** Replace:

````markdown
  store/{index,procurement,ops}.ts        Zustand, all server-backed - index.ts holds most actions (billing,
````

With:

````markdown
  store/{index,procurement,ops,audit}.ts  Zustand, all server-backed - index.ts holds most actions (billing,
````

And replace:

````markdown
                                           shop-to-shop transfers, the support desk, the item patch,
                                           adjustments)
````

With:

````markdown
                                           shop-to-shop transfers, the support desk, the item patch,
                                           adjustments); audit.ts (the audit log's reads, its new-events
                                           count and the CSV export)
````

And replace:

````markdown
                                           freeToPromise · availOf · priceOf · procurementList …), theme.ts
````

With:

````markdown
                                           freeToPromise · availOf · priceOf · procurementList …), theme.ts,
                                           audit.ts (deviceOf, diffFields, auditCsv, auditDayRange)
````

And replace:

````markdown
  pages/                                  Login.tsx, ChangePassword.tsx, Settings.tsx, Support.tsx
````

With:

````markdown
  pages/                                  Login.tsx, ChangePassword.tsx, Settings.tsx, Support.tsx, and the
                                           admin page: AdminDashboard.tsx, AdminUsers.tsx, AdminSupport.tsx,
                                           AdminAudit.tsx, AuditEntryDrawer.tsx
````

And replace:

````markdown
                                           login-picker, admin-accounts
````

With:

````markdown
                                           login-picker, admin-accounts, admin-audit, audit-lib
````

**7c. The audit log on `/admin`.** Replace:

```markdown
Support screen over the change stream, and a new ticket or a reporter's reply lands on the desk
the same way.
```

With:

```markdown
Support screen over the change stream, and a new ticket or a reporter's reply lands on the desk
the same way.

**The audit log, on `/admin`.** The admin-flagged account's third tab answers who did what, when,
from where and with what result, for every change anyone makes and every sign-in. "Every change
and sign-in, with who made it and when." Filter by period (today, 7 days, 30 days or a custom
range), person, role, location, area and outcome, or search; four counts over the whole filter
read events, people, refused and failed sign-ins. Location finds the person's location or the
target's. The list is newest first and never moves by itself: while it is open, new events raise a
"New events - show" pill, and pressing it reloads.
A row opens the entry - who (as the account stood then), when to the second, the IP and the device,
the method and path, the server's sentence and a refusal's cause, what was sent, what came back,
and for an edit only the fields that changed, before → after. From there, "Everything by this
person" and "Everything on" the target narrow the list. Export CSV downloads the filtered log, up
to 50,000 rows, and says so when it stops there. Passwords, codes and tokens are never in it. The
log is kept by a separate service, `apps/audit`; when that service cannot be reached the tab says
so rather than showing an empty log.
```

---

- [ ] **Step 8: `deploy/compose/README.md` - check, don't edit**

Task 16 replaced this file whole, already describing the audit service. Confirm it says what Task 19's other
documents say:

Run: `grep -n "audit-migrate\|/readyz/audit\|APP_DB_PASSWORD\|AUDIT_DB_PASSWORD\|run --rm --no-deps migrate\|rch_app\|rch_audit" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/README.md`
Expected: the two one-shot migrations and five long-running containers, the `/readyz/audit` check, both new
passwords in the first-deploy list, operator CLIs through `migrate`, and the note that a restore runs
`migrate` and `audit-migrate` to recreate `rch_app` and `rch_audit`. If any is missing, add that sentence to
this file in Task 16's wording style and include the file in Step 12's `git add`.

---

- [ ] **Step 9: `deploy/RUNBOOK.md`**

**9a. §1 local development: the command block.** Replace:

````markdown
pnpm --filter @rch/api keys:generate >> .env   # appends JWT_PRIVATE_KEY= / JWT_PUBLIC_KEY=
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed
pnpm dev                                       # turbo run dev --parallel: api on :3000, UI on :5173
````

With:

````markdown
pnpm --filter @rch/api keys:generate >> .env   # appends JWT_PRIVATE_KEY= / JWT_PUBLIC_KEY=
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/audit db:migrate            # the audit schema; waits for the API's audit_outbox
pnpm --filter @rch/api db:seed
pnpm dev                                       # turbo run dev --parallel: api on :3000, audit on :3100, UI on :5173
````

**9b. §1: the audit service locally.** Replace:

```markdown
`DATABASE_URL` / `TEST_DATABASE_URL` already point at 5439. `pnpm db:down` stops it.
```

With:

```markdown
`DATABASE_URL` / `TEST_DATABASE_URL` already point at 5439. `pnpm db:down` stops it.

**The audit service runs beside the API**, on :3100, from the same `.env`. `AUDIT_DATABASE_URL`
(already in `.env.example`) is its connection, and it reads `JWT_PUBLIC_KEY` to verify the API's
tokens. Run its migrations after the API's: `pnpm --filter @rch/audit db:migrate` waits up to five
minutes for the API's `audit_outbox` table, then creates the `audit` schema. Vite sends
`/api/v1/admin/audit` to it and the rest of `/api` to the API. Without it running the application
works as before - every write still commits, and its audit event waits in `audit_outbox` - and only
the Audit log tab says it cannot reach the log.

Locally `DATABASE_URL`, `AUDIT_DATABASE_URL` and the unset `MIGRATE_DATABASE_URL` all name the one
`rch` user, so neither migrate step creates a role. To rehearse the deployed roles, set
`MIGRATE_DATABASE_URL` to the `rch` URL and give `DATABASE_URL` and `AUDIT_DATABASE_URL` the users
`rch_app` and `rch_audit` with passwords of your own: the two migrate steps create both roles and
grant them (§5, *The database roles*).
```

**9c. §1: the bare seed on the box.** Replace:

````markdown
dist/cli/seed.mjs --bare --force --yes-seed rch --yes-destroy rch          # in the api container, over a demo-seeded rch
````

With:

````markdown
dist/cli/seed.mjs --bare --force --yes-seed rch --yes-destroy rch          # on the box, through the migrate service (§16.5)
````

**9d. §1 Test users: the admin's capabilities.** Replace:

```markdown
`/admin`) and the support desk are a capability, not a role: signing in as it shows no
```

With:

```markdown
`/admin`), the support desk and the audit log are a capability, not a role: signing in as it shows no
```

**9e. §1 A sign-in that is refused.** Replace:

```markdown
and the sentence the caller read ends with the request id to look it up by.
```

With:

```markdown
and the sentence the caller read ends with the request id to look it up by.

**The audit log keeps these too, for good.** Every refused sign-in is also an audit event
(`login`, `refused`) with the same `cause`, the caller's IP and device. For an id that matched
nobody, the event keeps what was typed only when it has the shape of an employee number (`RC-`
and digits), so a mistyped `RC-0000` shows who tried while a password typed into the id box is
stored as an empty id and never reaches the log either. A locked-out attempt, under either
budget, is an event too. The Audit log's failed sign-ins count reads them all; §16.7 has the same
from `psql`.
```

**9f. §1 Migration workflow: the migrations since `0012`.** Replace:

```markdown
**Thirteen migrations exist** (`apps/api/drizzle/0000`–`0012`): `0000` is the initial schema, `0001` adds
```

With:

```markdown
**The first thirteen migrations** (`apps/api/drizzle/0000`–`0012`): `0000` is the initial schema, `0001` adds
```

And replace:

```markdown
None of the four validates an existing row, so none of them can refuse the way `0008` can.

A fresh `db:migrate` against an empty database reports all thirteen applied; against an
already-current one it reports `migrations applied: 13 / 13`, which is also what `/readyz`
compares against. Both numbers were proved on a scratch database created and dropped for the
purpose - a first migrate from empty, then a second run on the same database to prove the
migrate is idempotent.
```

With:

```markdown
None of the four validates an existing row, so none of them can refuse the way `0008` can.

Four more since. `0013_admin_accounts` adds the `admin_actions` table and the `users.admin` flag;
`0014_admin_actions_target_name` keeps each admin action's target name, so the log still reads
after an account is deleted; `0015_drop_recipes` drops `recipe_lines` and `recipes`; and
`0016_audit_outbox` adds `audit_outbox`, the table every audit event is written into, with a trigger
that refuses every UPDATE on it (§5, *The database roles*). The audit service's own migrations are separate:
`apps/audit/drizzle`, recorded in `audit_drizzle` rather than `drizzle` and applied by
`pnpm --filter @rch/audit db:migrate` (the `audit-migrate` step when deployed) behind
`pg_advisory_lock(727273)`, so they never change the API's count.

A fresh `db:migrate` against an empty database reports every journal entry applied; against an
already-current one it reports `migrations applied: N / N`, N being the number of entries in
`apps/api/drizzle/meta/_journal.json`, which is also what `/readyz` compares against. Both were
proved, at thirteen, on a scratch database created and dropped for the purpose - a first migrate
from empty, then a second run on the same database to prove the migrate is idempotent.
```

**9g. §2 Deploy: images the workflow builds.** Replace:

```markdown
instead). It builds and pushes the `api` and `UI` images to ECR, **scans the two tags it is
about to deploy** (see below), then `helm upgrade --install rch deploy/chart/rch -f
```

With:

```markdown
instead). It builds and pushes the `api`, `UI` and `audit` images to ECR, **scans the three tags it is
about to deploy** (see below), then `helm upgrade --install rch deploy/chart/rch -f
```

**9h. §2 What the workflow checks.** Replace:

```markdown
- **Trivy, on the exact tags helm is about to deploy.** `ci.yml` scans `rch-api:ci` / `rch-ui:ci` -
  images it built itself, which are not the bytes that reach a cluster. Two steps in
  `deploy.yml`, between the push and `helm upgrade`, scan
  `<ECR_REGISTRY>/rch-{api,ui}:<head_sha>` pulled back out of ECR, at
```

With:

```markdown
- **Trivy, on the exact tags helm is about to deploy.** `ci.yml` scans `rch-api:ci` / `rch-ui:ci` /
  `rch-audit:ci` - images it built itself, which are not the bytes that reach a cluster. One step per
  image in `deploy.yml`, between the push and `helm upgrade`, scans
  `<ECR_REGISTRY>/rch-{api,ui,audit}:<head_sha>` pulled back out of ECR, at
```

And replace:

```markdown
- **Every secret the chart needs is present.** A named step before `helm upgrade` refuses, by
  name, when any of `DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `SEED_PASSWORD` is
  empty - `--set-string` would otherwise write the empty string into the Secret and the api
  container would fail config validation minutes later, with nothing in the log about where the
  blank came from. It collects all four before exiting, so one run names every missing one. It
  is **scoped to non-production** (`head_branch != 'production'`): production reads the same four
  from AWS Secrets Manager through the External Secrets Operator, so those GitHub secrets are
  empty there on purpose and an unconditional guard would refuse every production deploy.
```

With:

```markdown
- **Every secret the chart needs is present.** A named step before `helm upgrade` refuses, by
  name, when any of `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `AUDIT_DATABASE_URL`,
  `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `SEED_PASSWORD` is empty - `--set-string` would otherwise
  write the empty string into the Secret and a container would fail config validation minutes
  later, with nothing in the log about where the blank came from. It collects all six before
  exiting, so one run names every missing one. It is **scoped to non-production**
  (`head_branch != 'production'`): production reads the same six from AWS Secrets Manager through
  the External Secrets Operator, so those GitHub secrets are empty there on purpose and an
  unconditional guard would refuse every production deploy.
```

**9i. §2 What the cluster saw.** Replace:

```markdown
  -l app.kubernetes.io/component=api -c migrate --tail=200` into the job log. Both `|| true`: a
  first install that never made a pod must not turn a missing log into a second failure.
```

With:

```markdown
  -l app.kubernetes.io/component=api -c migrate --tail=200` into the job log, and the audit pods'
  `audit-migrate` and `audit` logs the same way. All `|| true`: a first install that never made a
  pod must not turn a missing log into a second failure.
```

**9j. §2 the audit service's migrate initContainer.** Replace:

```markdown
`staging ⊂ develop` and `production ⊂ staging` so the branches can never diverge.
```

With:

```markdown
`staging ⊂ develop` and `production ⊂ staging` so the branches can never diverge.

The audit pods have the same shape: an `audit-migrate` initContainer (`dist/cli/migrate.mjs` from
the `rch-audit` image, `deploy/chart/rch/templates/audit-deployment.yaml`) ahead of the `audit`
container, behind its own `pg_advisory_lock(727273)`. It first waits up to five minutes for the
API's `audit_outbox` table to exist, so the api and audit Deployments may roll out in either
order; if the table never appears it exits 3, which almost always means the API's `migrate`
failed first - read that log before this one. Its role and grant step also takes the API's
727272, because both steps grant on `audit_outbox`. Both migrate steps connect with
`MIGRATE_DATABASE_URL` (`rch`) and create their runtime role - `rch_app` from `DATABASE_URL`,
`rch_audit` from `AUDIT_DATABASE_URL` - and re-grant it on every run (§5, *The database roles*).
```

**9k. §2 CI: a real `helm install`.** Replace:

```markdown
real, not just `helm lint`/`helm template`: the `images` job in `.github/workflows/ci.yml`
builds `rch-api:ci` and `rch-ui:ci`, spins up a throwaway [kind](https://kind.sigs.k8s.io/)
cluster (`helm/kind-action`), loads both images into it, then runs
`deploy/chart/rch/ci/install-test.sh`, which applies the CI-only single-replica Postgres
(`deploy/chart/rch/ci/postgres.yaml`) itself and waits for it before anything else:
`helm install` with `deploy/chart/rch/ci/values-ci.yaml` (a freshly generated Ed25519 pair
passed via `--set-string`, never committed), seed the database, confirm `/readyz` and a login
as `RC-3120` succeed through a port-forward, confirm the UI's `/healthz` succeeds too, then
`helm upgrade --install` with the same values and check `/readyz` again - proving the upgrade
path keeps the rendered Secret in place and the `migrate` initContainer no-ops the second time.
The cluster is deleted with the runner at the end of the job. Run it locally with `kind`
installed: `deploy/chart/rch/ci/install-test.sh` against a cluster that already has
`rch-api:ci`/`rch-ui:ci` loaded (`kind load docker-image`) and `JWT_PRIVATE_KEY`/
```

With:

```markdown
real, not just `helm lint`/`helm template`: the `images` job in `.github/workflows/ci.yml`
builds `rch-api:ci`, `rch-ui:ci` and `rch-audit:ci`, spins up a throwaway
[kind](https://kind.sigs.k8s.io/) cluster (`helm/kind-action`), loads all three images into it,
then runs `deploy/chart/rch/ci/install-test.sh`, which applies the CI-only single-replica Postgres
(`deploy/chart/rch/ci/postgres.yaml`) itself and waits for it before anything else:
`helm install` with `deploy/chart/rch/ci/values-ci.yaml` (a freshly generated Ed25519 pair
passed via `--set-string`, never committed; `MIGRATE_DATABASE_URL` as `rch`, `DATABASE_URL` as
`rch_app` and `AUDIT_DATABASE_URL` as `rch_audit`, so both migrate initContainers create their
roles for real), then seed the database from a one-off pod built from the api Deployment's own
`migrate` initContainer (the api container holds no superuser URL - §5, *Operator CLIs in a
cluster*), with `SEED_FORCE_PASSWORD_CHANGE=false` so `RC-0001` signs in as a plain admin. It
confirms `/readyz` and a login as `RC-3120` through a port-forward, and the UI's `/healthz`. Then
the audit check: wait for `deploy/rch-audit`, require its `/readyz` through a port-forward, sign
in as `RC-0001` through the API, and poll `GET /api/v1/admin/audit` from the audit service with
that token for up to 15 s - the sign-in just made must appear, which proves outbox → drainer →
read on a real cluster. Finally
`helm upgrade --install` with the same values and check `/readyz` on both again - proving the
upgrade path keeps the rendered Secret in place and both migrate initContainers apply nothing
the second time. On a failure the diagnostics print the audit pod's `audit-migrate` and `audit`
logs beside the API's. The cluster is deleted with the runner at the end of the job. Run it
locally with `kind` installed: `deploy/chart/rch/ci/install-test.sh` against a cluster that
already has `rch-api:ci`/`rch-ui:ci`/`rch-audit:ci` loaded (`kind load docker-image`) and `JWT_PRIVATE_KEY`/
```

**9l. §2 required secrets.** Replace:

```markdown
every environment is a namespace on it, not a cluster of its own). Required GitHub
**environment** secrets for `dev` and, later, `staging`: **four** - `DATABASE_URL`,
`JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` and **`SEED_PASSWORD`** (these populate `secrets.values.*`
for the chart's in-cluster `Secret`, since both run with `secrets.create=true`). Production runs
with `secrets.create=false` and `secrets.externalSecret.enabled=true`, pulling **five** -
`DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY` (may be empty) and
`SEED_PASSWORD` - from AWS Secrets Manager (`rch/prod`) via the External Secrets Operator; no
database or key secrets live in GitHub for prod.
```

With:

```markdown
every environment is a namespace on it, not a cluster of its own). Required GitHub
**environment** secrets for `dev` and, later, `staging`: **six** - `DATABASE_URL` (the `rch_app`
URL), `MIGRATE_DATABASE_URL` (the `rch` URL), `AUDIT_DATABASE_URL` (the `rch_audit` URL),
`JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` and **`SEED_PASSWORD`** (these populate `secrets.values.*`
for the chart's in-cluster `Secret`, since both run with `secrets.create=true`). The two role
passwords are whatever those URLs carry: the migrate steps set them on the roles. Production runs
with `secrets.create=false` and `secrets.externalSecret.enabled=true`, pulling **seven** -
`DATABASE_URL`, `MIGRATE_DATABASE_URL`, `AUDIT_DATABASE_URL`, `JWT_PRIVATE_KEY`,
`JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY` (may be empty) and `SEED_PASSWORD` - from AWS Secrets
Manager (`rch/prod`) via the External Secrets Operator; no database or key secrets live in GitHub
for prod.
```

**9m. §2 First-time cluster setup: the ExternalSecret bullet.** Replace:

````markdown
  Create the AWS Secrets Manager secret `rch/prod` as one JSON object with **five** keys -
  `DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY` (may be empty
  until the first key rotation) and **`SEED_PASSWORD`** (may not) - and grant the ESO IRSA role
  read access to it. Then prove the five keys are there, because nothing in `deploy.yml` will
  (its secret pre-flight step is skipped for `production` - §2):

  ```bash
  aws secretsmanager get-secret-value --secret-id rch/prod --query SecretString --output text \
    | jq -e '(.DATABASE_URL|length) > 0 and (.JWT_PRIVATE_KEY|length) > 0
             and (.JWT_PUBLIC_KEY|length) > 0 and has("JWT_PREVIOUS_PUBLIC_KEY")
             and (.SEED_PASSWORD|length) >= 12' >/dev/null && echo "rch/prod: all five keys present"
  ```
````

With:

````markdown
  Create the AWS Secrets Manager secret `rch/prod` as one JSON object with **seven** keys -
  `DATABASE_URL` (the `rch_app` URL), `MIGRATE_DATABASE_URL` (the RDS master user's URL),
  `AUDIT_DATABASE_URL` (the `rch_audit` URL), `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`,
  `JWT_PREVIOUS_PUBLIC_KEY` (may be empty until the first key rotation) and **`SEED_PASSWORD`**
  (may not) - and grant the ESO IRSA role read access to it. Then prove the seven keys are there,
  because nothing in `deploy.yml` will (its secret pre-flight step is skipped for `production` -
  §2):

  ```bash
  aws secretsmanager get-secret-value --secret-id rch/prod --query SecretString --output text \
    | jq -e '(.DATABASE_URL|length) > 0 and (.MIGRATE_DATABASE_URL|length) > 0
             and (.AUDIT_DATABASE_URL|length) > 0
             and (.JWT_PRIVATE_KEY|length) > 0 and (.JWT_PUBLIC_KEY|length) > 0
             and has("JWT_PREVIOUS_PUBLIC_KEY")
             and (.SEED_PASSWORD|length) >= 12' >/dev/null && echo "rch/prod: all seven keys present"
  ```
````

**9n. §4 Rotate JWT keys.** Replace:

````markdown
     in-cluster Secret (`ExternalSecret` updates the Secret object but does not itself restart
     pods that already read it into env vars):
     ```bash
     kubectl rollout restart deployment/rch-api -n rch
     ```
4. The API accepts tokens signed with `JWT_PREVIOUS_PUBLIC_KEY` for 24 hours (`plugins/auth.ts`
   verifies against it when the current key fails). After 24 hours, remove
````

With:

````markdown
     in-cluster Secret (`ExternalSecret` updates the Secret object but does not itself restart
     pods that already read it into env vars). Restart the audit service as well: it verifies
     every token against `JWT_PUBLIC_KEY` / `JWT_PREVIOUS_PUBLIC_KEY`, and a pod still holding
     the old pair turns tokens signed with the new key away, so the Audit log tab stops loading:
     ```bash
     kubectl rollout restart deployment/rch-api -n rch
     kubectl rollout restart deployment/rch-audit -n rch
     ```
   - The box (§16): edit the `JWT_*` lines in `deploy/compose/.env` and run
     `deploy/compose/deploy.sh`. Compose recreates every container whose environment changed,
     `api` and `audit` among them.
4. The API and the audit service accept tokens signed with `JWT_PREVIOUS_PUBLIC_KEY` for 24 hours
   (`apps/api/src/plugins/auth.ts` and `apps/audit/src/plugins/auth.ts` each verify against it
   when the current key fails). After 24 hours, remove
````

**9o. §5 Accounts: CLIs on the box.** Replace:

````markdown
kubectl exec deploy/rch-api -n rch -- /nodejs/bin/node dist/cli/users.mjs deactivate --emp RC-9001
```
````

With:

````markdown
kubectl exec deploy/rch-api -n rch -- /nodejs/bin/node dist/cli/users.mjs deactivate --emp RC-9001
```

Every CLI connects with `MIGRATE_DATABASE_URL` when its environment carries one, and `DATABASE_URL`
otherwise (`cliDatabaseUrl` in `apps/api/src/config.ts`).

**Operator CLIs in a cluster.** The chart's api container carries no `MIGRATE_DATABASE_URL`, so the
`kubectl exec` lines above run as `rch_app`. That is enough for `users`, `payers import` and
`rebuild-balances`, which read and write rows. A CLI that needs the superuser - a seed, or
anything with `--force` - runs in a one-off pod built from the api Deployment's own `migrate`
initContainer, which carries the migrate secret: same image, same environment, nothing secret on a
command line. `deploy/chart/rch/ci/install-test.sh` seeds CI's kind cluster exactly this way.

```bash
NS=rch                                              # or rch-staging / rch-dev
CLI='["dist/cli/seed.mjs", "--yes-seed", "rch"]'    # the CLI and its arguments
pod=$(kubectl -n "$NS" get deploy/rch-api -o json | jq -c --argjson args "$CLI" '{ spec: { containers: [
  .spec.template.spec.initContainers[] | select(.name == "migrate") | .name = "rch-cli" | .args = $args ] } }')
image=$(kubectl -n "$NS" get deploy/rch-api -o jsonpath='{.spec.template.spec.initContainers[?(@.name=="migrate")].image}')
kubectl -n "$NS" run rch-cli --rm -i --quiet --restart=Never --image="$image" --overrides="$pod"
```

On the box (§16), run any CLI through the `migrate` service, which carries both URLs and so connects
as `rch`; `api` connects as `rch_app`:

```bash
cd /opt/rch/app/deploy/compose
docker compose --env-file .env -f compose.yml run --rm --no-deps migrate \
  dist/cli/users.mjs reset-password --emp RC-9001 --password <temporary>
```
````

**9p. §5 new subsection "The database roles".** Insert at the end of §5, i.e. replace:

```markdown
The import does not announce over SSE, so an open browser will not see the new rows until it is
reloaded - the same as `users` and `db:seed`, and fine for a job that runs before anybody is
signed in.
```

With:

```markdown
The import does not announce over SSE, so an open browser will not see the new rows until it is
reloaded - the same as `users` and `db:seed`, and fine for a job that runs before anybody is
signed in.

### The database roles

Three Postgres roles, and no long-running service connects as the superuser:

| Role | Used by | What it can do |
|---|---|---|
| `rch` | Both migrate steps (`migrate`, `audit-migrate`) and every operator CLI, through `MIGRATE_DATABASE_URL` | Everything; it owns every table. The container Postgres's superuser on the box, the master user on RDS. |
| `rch_app` | The API, through `DATABASE_URL` | `select, insert, update, delete` on every API table and `usage, select` on their sequences; `select` on `drizzle.__drizzle_migrations`, for `/readyz`; **`insert` only** on `audit_outbox`. No `truncate`, and nothing in the `audit` or `audit_drizzle` schemas. |
| `rch_audit` | The audit service, through `AUDIT_DATABASE_URL` | `select, delete` and the column `update (at)` on `public.audit_outbox` (the column grant only lets the drainer lock rows: a trigger refuses every UPDATE on the outbox); `select, insert` on `audit.events` and `audit.dead_letters`; `select` on the `audit_drizzle` bookkeeping. No other API table. |

- **The migrate steps create the roles.** `migrate` reads the role name and password out of
  `DATABASE_URL`, `audit-migrate` out of `AUDIT_DATABASE_URL`. Each creates its role if it is
  missing, sets the password (escaped, never logged), and re-grants on every run. Nobody creates a
  role or a grant by hand.
- **Append-only holds for every role, `rch` included.** Triggers refuse UPDATE and DELETE on
  `stock_moves` and `document_history`, UPDATE on `audit_outbox`, and UPDATE, DELETE and TRUNCATE on
  `audit.events` and `audit.dead_letters`.
- **No credential a service holds can alter the audit log.** The API's can add to the outbox and
  read nothing back; the audit service's can add to the log and never change it.
- **Locally and in the test suites there is one user.** `DATABASE_URL`, `AUDIT_DATABASE_URL` and the
  unset `MIGRATE_DATABASE_URL` all name `rch`, so both migrate steps skip role setup (§1).

**Rotating a role's password, on the box.** Change `APP_DB_PASSWORD` or `AUDIT_DB_PASSWORD` in
`deploy/compose/.env` and run `deploy/compose/deploy.sh`. Compose sees the changed URL, reruns
`migrate` (or `audit-migrate`), which applies `alter role … password` with the new value, and only
then recreates `api` (or `audit`) on it. `.env` is gitignored, so `release.sh`'s clean-checkout
check never sees the edit. **In a cluster**, change the password inside `DATABASE_URL` or
`AUDIT_DATABASE_URL` in the Secret (§2) and roll out: each new pod's initContainer applies it. Pods
of the old ReplicaSet still hold the old password, so a new connection one of them opens fails
until the rollout replaces it - rotate off-hours.

`POSTGRES_PASSWORD`, `rch`'s own on the box, is different: the `postgres` image reads it only when
the `pgdata` volume is first created. Change it inside the database first
(`docker compose … exec postgres psql -U rch -d rch -c "alter role rch password '<new>'"`), then in
`.env`, then run `deploy.sh`.
```

**9q. §6 Restore drill: roles after a load.** Replace:

```markdown
original's balances exactly. This is the rehearsal; the real thing is against RDS, below, and is
run before go-live and quarterly:
```

With:

````markdown
original's balances exactly. This is the rehearsal; the real thing is against RDS, below, and is
run before go-live and quarterly.

**Roles are not in a dump.** `pg_dump` carries the `audit` and `audit_drizzle` schemas and every
grant, but not the `rch_app` and `rch_audit` roles those grants name: roles belong to the Postgres
server, not to one database. Loading a dump into a server that has never had them prints
`role "rch_app" does not exist` for each grant and carries on. So after loading a dump as `rch`,
run both migrate steps before starting the services; they create the two roles and re-grant
everything:

```bash
cd /opt/rch/app/deploy/compose
docker compose --env-file .env -f compose.yml run --rm migrate
docker compose --env-file .env -f compose.yml run --rm audit-migrate
```

Running them over roles that already exist is harmless: each step sets the password from `.env`
again and re-grants. The local rehearsal above needs neither, because locally every URL names
`rch`. An RDS snapshot restores the whole instance, roles included, so the RDS drill below needs
neither either.

The RDS drill:
````

**9r. §9 Alerts: counts and metrics.** Replace:

```markdown
The original requirement named five; this build ships eight - the **six** below that the chart's
`PrometheusRule` renders, plus the two RDS rules that stay runbook-only. `/metrics` (Prometheus
format, `apps/api/src/plugins/metrics.ts`) exposes `http_request_duration_seconds` (histogram,
labelled `method`, `route`, `status`), `pg_pool_waiting`/`pg_pool_idle`, `sse_listener_up` and
the default Node process metrics. The first six below ship as a `PrometheusRule`
```

With:

```markdown
The original requirement named five; this build ships ten - the **eight** below that the chart's
`PrometheusRule` renders, plus the two RDS rules that stay runbook-only. The API's `/metrics`
(Prometheus format, `apps/api/src/plugins/metrics.ts`) exposes `http_request_duration_seconds`
(histogram, labelled `method`, `route`, `status`), `pg_pool_waiting`/`pg_pool_idle`,
`sse_listener_up` and the default Node process metrics. The audit service's `/metrics`
(`apps/audit/src/plugins/metrics.ts`, port 3100) exposes `audit_outbox_depth`,
`audit_drain_lag_seconds` (the age of the oldest outbox row), `audit_events_stored_total`,
`audit_dead_letters_total` and `audit_listener_up`. The first eight below ship as a `PrometheusRule`
```

And replace:

```markdown
**Three things have to be true before any of the six fires**, and none of them is the chart's to
```

With:

```markdown
**Three things have to be true before any of the eight fires**, and none of them is the chart's to
```

**9s. §9 item 4's cross-reference.** Replace:

```markdown
   RDS's own connection count - see item 7 below for that. The app pool never exceeds 60
```

With:

```markdown
   RDS's own connection count - see item 9 below for that. The app pool never exceeds 60
```

**9t. §9 items 6-10.** Replace:

````markdown
6. **`RchSseListenerDown` - the sixth chart-shipped alert and this build's eighth overall,
   warning, sustained 5 minutes:**
   ```promql
   min(sse_listener_up{job="rch-api"}) == 0
   ```
   Its rationale - what `sse_listener_up` means, why 5 minutes and not immediately, and why it
   is deliberately *not* wired into `/readyz` - is §10's, below, not repeated here.
7. **DB connections > 80% of max - runbook-only, needs CloudWatch.** RDS CloudWatch
````

With:

````markdown
6. **`RchSseListenerDown` - warning, sustained 5 minutes:**
   ```promql
   min(sse_listener_up{job="rch-api"}) == 0
   ```
   Its rationale - what `sse_listener_up` means, why 5 minutes and not immediately, and why it
   is deliberately *not* wired into `/readyz` - is §10's, below, not repeated here.
7. **`AuditDrainLagging` - the oldest audit event has waited in the outbox over a minute,
   warning, sustained 5 minutes:**
   ```promql
   max(audit_drain_lag_seconds{job="rch-audit"}) > 60
   ```
   Nothing is lost while it fires. The API keeps committing writes, each one's event waits in
   `audit_outbox` until a drain pass moves it, and the Audit log tab simply shows nothing newer.
   What to do, in order:
   - **Are the audit pods running and ready?** `kubectl -n <namespace> get pods -l
     app.kubernetes.io/component=audit`, then `kubectl logs` on one, and `kubectl logs <pod> -c
     audit-migrate` if it never started. On the box: `docker compose … ps audit` and
     `docker compose … logs --tail 100 audit-migrate audit`.
   - **Is a pass failing?** The service logs each failure at `error`. A connection or permission
     refusal for `rch_audit` means the role is missing or has lost its grants - after a restore,
     typically - and running `audit-migrate` recreates and re-grants it (§6).
   - **Is it draining, only slower than the outbox fills?** `audit_outbox_depth` and
     `audit_events_stored_total` both climbing says so. More replicas help: `skip locked` lets them
     drain side by side.

   `audit_listener_up == 0` alone does not cause this alert: the drainer still polls every
   `DRAIN_POLL_MS` (5 s). §16.7 has the outbox query for the box.
8. **`AuditDeadLetters` - an event the audit service set aside, critical:**
   ```promql
   sum(increase(audit_dead_letters_total{job="rch-audit"}[15m])) > 0
   ```
   The event failed `AuditEventSchema`, or Postgres refused it (`database refused it: <reason>`),
   and it was stored in `audit.dead_letters` instead of `audit.events`, with the first issue found;
   the events either side of it moved normally. It is missing from the Audit log tab, so any at all
   is somebody's to read. Read
   it (§16.7 has the connection):
   ```sql
   select id, outbox_id, at, issue from audit.dead_letters order by id desc limit 20;
   select event from audit.dead_letters where id = <id>;
   ```
   The likeliest cause is an API image and an audit image built from different commits, one of
   which changed the event's shape (a new collection in `changed`, say). Deploy both from the same
   commit. Nothing replays a dead letter: the row, with the whole event in `event`, stays where it
   is, append-only like the log itself, so the Audit log has a gap there that `dead_letters`
   explains.
9. **DB connections > 80% of max - runbook-only, needs CloudWatch.** RDS CloudWatch
````

And replace:

````markdown
8. **RDS free storage < 20% - runbook-only, needs CloudWatch.**
   ```promql
   aws_rds_free_storage_space_average{dbinstance_identifier="rch-prod"}
     / <allocated_storage_bytes> < 0.2
   ```
````

With:

````markdown
10. **RDS free storage < 20% - runbook-only, needs CloudWatch.**
    ```promql
    aws_rds_free_storage_space_average{dbinstance_identifier="rch-prod"}
      / <allocated_storage_bytes> < 0.2
    ```
````

**9u. §9 the audit upstream in nginx.** Replace:

```markdown
never inside a pod. `kubectl exec deploy/<release>-ui -- printenv API_UPSTREAM` shows what it got.
```

With:

```markdown
never inside a pod. `kubectl exec deploy/<release>-ui -- printenv API_UPSTREAM` shows what it got.
The same holds for `AUDIT_UPSTREAM`, which nginx's `location /api/v1/admin/audit` proxies to: the
chart sets `http://<release>-audit.<namespace>.svc.cluster.local:3100`, and the image's short
default (`http://rch-audit:3100`) never resolves inside a pod.
```

**9v. §10 Server-sent events: audit notices.** Replace:

```markdown
full outage traded for a live-update delay. The 5-minute alert above is the right response to
this failure, not a readiness probe.
```

With:

```markdown
full outage traded for a live-update delay. The 5-minute alert above is the right response to
this failure, not a readiness probe.

**`audit` notices reach admin streams only.** After a drain pass that stored anything, the audit
service's drainer sends a notice naming the `audit` collection on `rch_events_<schema>`, the
channel the API's own writes use, and every API pod's listener picks it up like any other.
`apps/api/src/plugins/sse.ts` records, per stream, whether its token is an admin's, and writes an
`audit` frame only to those streams; every other collection still goes to every stream. An admin's
browser does not refetch on it: it counts the notice, and the Audit log tab shows "New events -
show" until the admin presses it. A lost `audit` notice costs only the pill - the rows are there on
the next load. The audit service holds a `LISTEN` connection of its own, on `rch_audit_outbox`, to
hear the API's inserts; `audit_listener_up` is its gauge (§9).
```

**9w. §11 checklist: step 1's migration count.** Replace:

```markdown
   **`0008` is still the only migration that can refuse.** `0009`–`0012` - the payer audit
   columns, the adjustment tables, the production order's needed-by date and the bill's three
   void columns - add tables and nullable columns and validate no existing row, so a database
   this script calls clear is one the whole set of thirteen will apply to. Expect
   `migrations applied: 13 / 13`.
```

With:

```markdown
   **`0008` is still the only migration that can refuse.** `0009`–`0012` - the payer audit
   columns, the adjustment tables, the production order's needed-by date and the bill's three
   void columns - add tables and nullable columns and validate no existing row. `0013` adds a
   table and a defaulted column, `0014` fills its new column from `users` before tightening it,
   `0015_drop_recipes` drops two tables, and `0016_audit_outbox` adds an empty one. So a database
   this script calls clear is one every migration will apply to. Expect `migrations applied: N / N`, N being the length of
   `apps/api/drizzle/meta/_journal.json`.
```

**9x. §11 the secrets table.** Replace:

```markdown
| `staging` environment | `DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | Staging reads its secrets from the GitHub environment; production reads `rch/prod` out of AWS Secrets Manager through the `ClusterSecretStore`. |
| AWS Secrets Manager `rch/prod` | `DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY`, **`SEED_PASSWORD`** | **Five keys now, not four.** `JWT_PREVIOUS_PUBLIC_KEY` may start empty; `SEED_PASSWORD` may not. The `ExternalSecret` uses `dataFrom: [{ extract: … }]`, which copies every key of the remote JSON - so there is no template entry to add, but a remote secret missing `SEED_PASSWORD` produces a pod that will not start. Mint the JWT pair with `pnpm --filter @rch/api keys:generate`, which prints two `JWT_*=` lines and never writes them anywhere. |
```

With:

```markdown
| `staging` environment | `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `AUDIT_DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | Staging reads its secrets from the GitHub environment; production reads `rch/prod` out of AWS Secrets Manager through the `ClusterSecretStore`. `DATABASE_URL` is the `rch_app` URL, `MIGRATE_DATABASE_URL` the master user's, `AUDIT_DATABASE_URL` the `rch_audit` URL (§5, *The database roles*). |
| AWS Secrets Manager `rch/prod` | `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `AUDIT_DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY`, **`SEED_PASSWORD`** | **Seven keys.** `JWT_PREVIOUS_PUBLIC_KEY` may start empty; no other may. The `ExternalSecret` uses `dataFrom: [{ extract: … }]`, which copies every key of the remote JSON - so there is no template entry to add, but a remote secret missing one produces a pod that will not start. Mint the JWT pair with `pnpm --filter @rch/api keys:generate`, which prints two `JWT_*=` lines and never writes them anywhere. |
```

**9y. §11 step 3.** Replace:

```markdown
   `JWT_PUBLIC_KEY`, alongside `DATABASE_URL`, an empty `JWT_PREVIOUS_PUBLIC_KEY`, and
   **`SEED_PASSWORD`** - five keys (§2's "First-time cluster setup" and the secrets table above).
```

With:

```markdown
   `JWT_PUBLIC_KEY`, alongside `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `AUDIT_DATABASE_URL`, an
   empty `JWT_PREVIOUS_PUBLIC_KEY`, and **`SEED_PASSWORD`** - seven keys (§2's "First-time cluster
   setup" and the secrets table above).
```

**9z. §11 step 7.** Replace:

```markdown
   blocking**), the `staging` environment's three, and AWS Secrets Manager's `rch/prod` with its
   **five** keys: the table under "The release, prepared and not performed" above lists each one
```

With:

```markdown
   blocking**), the `staging` environment's five, and AWS Secrets Manager's `rch/prod` with its
   **seven** keys: the table under "The release, prepared and not performed" above lists each one
```

And replace:

```markdown
   `helm upgrade` that refuses by name, on dev and staging (production reads the same four
   through External Secrets, so the GitHub secrets are empty there on purpose).
```

With:

```markdown
   `helm upgrade` that refuses by name, on dev and staging (production reads the same six
   through External Secrets, so the GitHub secrets are empty there on purpose).
```

**9aa. §11 step 10: the audit service's checks.** Replace:

````markdown
    then sign in as a real account through the browser, take one real sale, and finally
````

With:

````markdown
    then the audit service's readiness, and its log:
    ```bash
    kubectl -n <namespace> port-forward svc/rch-audit 3100:3100 &
    curl -fsS http://localhost:3100/readyz
    ```
    sign in as the super admin and open the Audit log tab - that sign-in is its newest row, which
    proves the outbox, the drainer and the read on this environment. Then sign in as a real account
    through the browser, take one real sale, and finally
````

**9bb. §11 follow-up list item 2.** Replace:

```markdown
2. **Nothing routes an alert to a person.** The chart renders six `PrometheusRule` alerts (§9)
```

With:

```markdown
2. **Nothing routes an alert to a person.** The chart renders eight `PrometheusRule` alerts (§9)
```

**9cc. §15.2 Database: the roles on RDS.** Replace:

```markdown
deliberately does not carry; §11 step 2 and `deploy/cfn/README.md` have the full production spec.
```

With:

```markdown
deliberately does not carry; §11 step 2 and `deploy/cfn/README.md` have the full production spec.

**On RDS the migrate role is the master user**, which is `rds_superuser` rather than a true
superuser. It holds `CREATEROLE`, which is what the two migrate steps need to create `rch_app` and
`rch_audit` and set their passwords, and it owns every table it migrates, which is what they need
to grant. `MIGRATE_DATABASE_URL` is its URL; `DATABASE_URL` and `AUDIT_DATABASE_URL` name the two
runtime roles (§5, *The database roles*).
```

**9dd. §15.3 Secrets: the two new URLs.** Replace:

```markdown
is variadic, so a second name in that template's `if eq` would silently make the key optional,
which is exactly what "required" is trying to prevent.
```

With:

```markdown
is variadic, so a second name in that template's `if eq` would silently make the key optional,
which is exactly what "required" is trying to prevent.

**The audit service added two more.** The chart now reads `MIGRATE_DATABASE_URL` (the master
user's URL, for both migrate initContainers and the CLIs) and `AUDIT_DATABASE_URL` (the
`rch_audit` URL), and `DATABASE_URL` became the `rch_app` URL. An environment stood back up needs
six secrets in its GitHub environment and seven keys in `rch/prod` (§2, §11's secrets table).
The env helpers in `_helpers.tpl` (`rch.apiEnv`, `rch.apiCliEnv`, `rch.auditEnv`, `rch.auditMigrateEnv`)
name, per container, only the secrets that container uses: the api container holds no
`MIGRATE_DATABASE_URL` (the migrate initContainer and the purge CronJob do), and the audit containers
never see `JWT_PRIVATE_KEY` or `SEED_PASSWORD`.
```

**9ee. §15.7 First deploy: images.** Replace:

```markdown
The workflow builds and pushes both images, then `helm upgrade --install rch deploy/chart/rch -f
```

With:

```markdown
The workflow builds and pushes all three images, then `helm upgrade --install rch deploy/chart/rch -f
```

**9ff. §16.1 What runs.** Replace:

```markdown
Four containers, one instance, one Docker network: `postgres`, a one-shot `migrate` (the same
`dist/cli/migrate.mjs` the EKS `migrate` initContainer runs, ordered ahead of `api` by
compose's own `depends_on: condition: service_completed_successfully`), `api` and `ui` (built
from the identical `apps/api/Dockerfile` / `UI/Dockerfile` the EKS path builds - one image
definition per service, two places to run it), and `caddy` in front for automatic HTTPS.

**Caddy reaches `api` and `ui` directly, with no second reverse-proxy hop.** The EKS path is
ALB → (path routing) → `ui`'s nginx (which itself proxies `/api/` onward) or `api`; on one box,
Caddy's own path routing (`handle /api/*` vs `handle`) reaches each container directly, so
`TRUST_PROXY=1` (one hop) is correct unchanged - `ui`'s nginx still carries its `/api/` block
(it is the same image), it is simply never asked to use it here. `flush_interval -1` on the API
route is what keeps `/api/v1/events` (server-sent events) streaming rather than buffered.

**The API's distroless runtime image has no shell**, so it carries no `HEALTHCHECK` a container
orchestrator could run; `restart: unless-stopped` recovers a crash, and `deploy.sh`'s own final
step - polling `https://<domain>/healthz` through Caddy - is the health check that matters,
since it proves the whole chain rather than one container in isolation.
```

With:

```markdown
Seven services, one instance, one Docker network:

| Service | Image | Connects as | Starts after |
|---|---|---|---|
| `postgres` | `postgres:17` | - | - |
| `migrate` (one-shot) | `rch-api:local`, `dist/cli/migrate.mjs` | `rch`, and creates `rch_app` from `DATABASE_URL` | `postgres` is healthy |
| `audit-migrate` (one-shot) | `rch-audit:local`, `dist/cli/migrate.mjs` | `rch`, and creates `rch_audit` from `AUDIT_DATABASE_URL` | `migrate` completed |
| `api` | `rch-api:local` | `rch_app` | `migrate` completed |
| `audit` | `rch-audit:local` | `rch_audit` | `audit-migrate` completed |
| `ui` | `rch-ui:local` | - | `api` |
| `caddy` | `caddy:2.10-alpine` | - | `ui`, `api`, `audit` |

The two migrate steps are the same `dist/cli/migrate.mjs` files the EKS initContainers run,
ordered by compose's own `depends_on: condition: service_completed_successfully`. The three
application images build from the identical `apps/api/Dockerfile`, `apps/audit/Dockerfile` and
`UI/Dockerfile` the EKS path builds - one image definition per service, two places to run it.
`migrate` is also the door for every operator CLI (`run --rm --no-deps migrate dist/cli/<name>.mjs`),
being the one service that connects as `rch`: `deploy.sh`'s first-run seed and `backup.sh`'s
nightly purge go through it too. `.env` carries `APP_DB_PASSWORD` and `AUDIT_DB_PASSWORD` for the
two runtime roles (§5, *The database roles*).

**Caddy reaches `api`, `audit` and `ui` directly, with no second reverse-proxy hop.** The EKS path
is ALB → (path routing) → `ui`'s nginx (which itself proxies `/api/` onward), `api` or `audit`; on
one box, Caddy's own path routing reaches each container directly, so `TRUST_PROXY=1` (one hop) is
correct unchanged. Caddy orders its routes by specificity, not by their place in the file, so they
are tried as `/api/v1/admin/audit*` → `audit:3100`, `/readyz/audit` → the audit service's own
`/readyz`, `/readyz` → `api:3000`, `/api/*` → `api:3000`, then everything else → `ui`
(`compose.test.sh` asserts that order). `ui`'s nginx still carries its `/api/` and
`/api/v1/admin/audit` blocks (it is the same image, and Compose gives it `AUDIT_UPSTREAM`), it is
simply never asked to use them here. `flush_interval -1` on the API route is what
keeps `/api/v1/events` (server-sent events) streaming rather than buffered.

**Neither Node runtime image has a shell** (both are distroless), so neither carries a
`HEALTHCHECK` a container orchestrator could run; `restart: unless-stopped` recovers a crash.
`deploy.sh`'s final step polls `https://<domain>/healthz` through Caddy, and `release.sh` then
requires `https://<domain>/readyz` (the API: its database and every migration in its journal) and
`https://<domain>/readyz/audit` (the audit service: its database, its migrations and a drain pass
in the last 30 s). Before the audit service shipped, Caddy had no `/readyz` route, so the UI's
nginx answered it with a static `ok` that checked nothing.
```

**9ff2. §16.2 the box's memory.** Replace:

```markdown
  a 2 GB swap file (a t4g.medium's 4 GiB is comfortably enough for four containers, and swap is
```

With:

```markdown
  a 2 GB swap file (a t4g.medium's 4 GiB was comfortably enough for the first four containers -
  check `free -m` on the box before adding another long-running one - and swap is
```

**9ff3. §2 First-time cluster setup: `ng-prod` pins three Deployments.** Replace:

```markdown
  created with one node group, `ng-spot`, and `values-prod.yaml` pins both Deployments to
```

With:

```markdown
  created with one node group, `ng-spot`, and `values-prod.yaml` pins all three Deployments (api, ui, audit) to
```

And replace:

```markdown
  production in, and a taint would additionally keep the DaemonSets off. Skip it and both
  Deployments sit `Pending` for ever with no error anywhere - and production upgrades without
```

With:

```markdown
  production in, and a taint would additionally keep the DaemonSets off. Skip it and all three
  Deployments sit `Pending` for ever with no error anywhere - and production upgrades without
```

**9ff4. §2 NetworkPolicies: ingress only.** Replace:

```markdown
    default-deny plus three named doors by default (`networkPolicy.enabled: true`), but a
    NetworkPolicy is enforced by the CNI, and the VPC CNI's policy agent is off unless the
```

With:

```markdown
    default-deny plus one ingress policy each for the api, the audit service and the ui
    (`networkPolicy.enabled: true`). They restrict ingress only: egress stays open for every pod,
    the audit service's included, because RDS sits outside the cluster at an address the chart
    does not know. A NetworkPolicy is enforced by the CNI, and the VPC CNI's policy agent is off unless the
```

**9ff5. §11 step 8: three Deployments.** Replace:

```markdown
   `api.nodeSelector` and `ui.nodeSelector` to `rch.io/tier: prod` - a label nothing in the
   cluster carries. Promote without this and both Deployments sit `Pending` for ever with no
```

With:

```markdown
   `api.nodeSelector`, `ui.nodeSelector` and `audit.nodeSelector` to `rch.io/tier: prod` - a label
   nothing in the cluster carries. Promote without this and all three Deployments sit `Pending` for ever with no
```

**9ff6. §11 follow-up item 4: both `/metrics` share a serving port.** Replace:

```markdown
4. **`/metrics` shares port 3000 with the API.** A NetworkPolicy decides on ports, not paths, so
   the `monitoring`-namespace rule in the api policy is a record of the intended scraper rather
   than a control, and `networkPolicy.albSourceCidr` cannot be narrowed below what the serving
   port needs. Moving `/metrics` to its own listener port is what would make both real.
```

With:

```markdown
4. **`/metrics` shares the serving port**: 3000 on the API, 3100 on the audit service. A
   NetworkPolicy decides on ports, not paths, so the `monitoring`-namespace rules in the api and
   audit policies are a record of the intended scraper rather than a control, and
   `networkPolicy.albSourceCidr` cannot be narrowed below what each serving port needs. Moving
   each `/metrics` to its own listener port is what would make both real.
```

**9ff7. §15.1 Cluster: three Deployments.** Replace:

```markdown
  first production deploy. `values-prod.yaml` pins both Deployments to it with
```

With:

```markdown
  first production deploy. `values-prod.yaml` pins all three Deployments to it with
```

**9ff8. §15.3: the SEED_PASSWORD reference lives in API containers only.** Replace:

```markdown
(§11's secrets table); `_helpers.tpl` wires it as a `secretKeyRef` in every container and
```

With:

```markdown
(§11's secrets table); `_helpers.tpl` wires it as a `secretKeyRef` in every API container (never an audit one) and
```

**9ff9. §15.7 First deploy and seed: the seed runs from a one-off pod.** Replace:

````markdown
describes for staging and production, with `dev`'s own values file and namespace. After the
first deploy succeeds, seed the database once:

```bash
kubectl -n rch-dev exec deploy/rch-api -- /nodejs/bin/node dist/cli/seed.mjs --yes-seed rch
```

**`--yes-seed <database name>` is not optional here, and dev is not an exception.** `rch.envList`
renders `NODE_ENV=production` into every pod in every namespace, and `cli/seed.ts` refuses to seed
````

With:

````markdown
describes for staging and production, with `dev`'s own values file and namespace. After the
first deploy succeeds, seed the database once. A seed needs the superuser, which the api
container does not hold, so it runs in the one-off pod §5 (*Operator CLIs in a cluster*) builds
from the `migrate` initContainer, with `NS=rch-dev` and
`CLI='["dist/cli/seed.mjs", "--yes-seed", "rch"]'`.

**`--yes-seed <database name>` is not optional here, and dev is not an exception.** The chart
renders `NODE_ENV=production` into every pod in every namespace, and `cli/seed.ts` refuses to seed
````

**9gg. §16.3 First deploy.** Replace:

````markdown
# fill in DOMAIN, POSTGRES_PASSWORD, JWT_PRIVATE_KEY / JWT_PUBLIC_KEY
# (pnpm --filter @rch/api keys:generate, run anywhere with Node - the box itself needs none),
# SEED_PASSWORD (12+ characters), BACKUP_BUCKET
````

With:

````markdown
# fill in DOMAIN, POSTGRES_PASSWORD, APP_DB_PASSWORD and AUDIT_DB_PASSWORD (long and random -
# the migrate steps set them on rch_app and rch_audit), JWT_PRIVATE_KEY / JWT_PUBLIC_KEY
# (pnpm --filter @rch/api keys:generate, run anywhere with Node - the box itself needs none),
# SEED_PASSWORD (12+ characters), BACKUP_BUCKET
````

**9hh. §16.4 trade-offs.** Replace:

```markdown
One instance, so no rolling deploy - `deploy.sh` restarts `api` and `ui` in place, a handful of
```

With:

```markdown
One instance, so no rolling deploy - `deploy.sh` restarts `api`, `audit` and `ui` in place, a handful of
```

**9ii. §16.5 Clean start through `migrate`.** Replace:

````markdown
docker compose --env-file .env -f compose.yml run --rm --no-deps api \
  dist/cli/seed.mjs --bare --force --yes-seed rch --yes-destroy rch
docker compose --env-file .env -f compose.yml run --rm --no-deps api \
  dist/cli/users.mjs reset-password --emp RC-0001 --password '<a temporary one>'
````

With:

````markdown
docker compose --env-file .env -f compose.yml run --rm --no-deps migrate \
  dist/cli/seed.mjs --bare --force --yes-seed rch --yes-destroy rch
docker compose --env-file .env -f compose.yml run --rm --no-deps migrate \
  dist/cli/users.mjs reset-password --emp RC-0001 --password '<a temporary one>'
````

And replace:

```markdown
`gunzip -c rch-<stamp>.sql.gz` into `docker compose … exec -T postgres psql -U rch -d rch` against
a freshly emptied database (§6 has the restore itself).
```

With:

```markdown
`gunzip -c rch-<stamp>.sql.gz` into `docker compose … exec -T postgres psql -U rch -d rch` against
a freshly emptied database, then run `migrate` and `audit-migrate` so `rch_app` and `rch_audit`
exist and hold their grants (§6 has the restore itself and why).
```

**9jj. §16.6 Continuous deploy.** Replace:

```markdown
3. **It checks `/readyz` and `/` from outside**, through Caddy, so the whole chain is proven.
```

With:

```markdown
3. **It checks `/readyz`, `/readyz/audit` and `/` from outside**, through Caddy, so the whole chain
   is proven: the API's readiness, the audit service's, and the page.
```

And replace:

```markdown
- It fails unless `https://<domain>/readyz` answers within two minutes. That check covers the
  database and every migration in the journal.
```

With:

```markdown
- It fails unless both `https://<domain>/readyz` and `https://<domain>/readyz/audit` answer within
  two minutes. The first covers the API's database and every migration in its journal; the second
  the audit service's migrations and a drain pass in the last 30 s. On a failure it prints the logs
  of `migrate`, `audit-migrate`, `api` and `audit`.
```

And replace:

```markdown
Read the log on the box and `docker compose … logs migrate api`, then fix forward with a new
commit.
```

With:

```markdown
Read the log on the box and `docker compose … logs migrate audit-migrate api audit`, then fix
forward with a new commit.
```

**9kk. New §16.7 Reading the audit log from the box.** Append at the very end of the file, i.e. replace:

```markdown
This uses the same script as the automatic deploy, so it has the same guards. Run it only while no
Deploy (box) run is in progress.
```

With:

````markdown
This uses the same script as the automatic deploy, so it has the same guards. Run it only while no
Deploy (box) run is in progress.

### 16.7 Reading the audit log from the box

The Audit log tab on `/admin` is the ordinary way in. This is the way when nobody can sign in as the
super admin, or when the question is about the pipeline behind the tab. Connect as `rch`:

```bash
ssh -i ~/.ssh/rch-box.pem ubuntu@rch.hashtrickstechnologies.com
cd /opt/rch/app/deploy/compose
docker compose --env-file .env -f compose.yml exec postgres psql -U rch -d rch
```

The last fifty events, newest first, in IST:

```sql
select id, at at time zone 'Asia/Kolkata' as at_ist, actor_emp, actor_name, action, target,
       outcome, status, message
from audit.events order by id desc limit 50;
```

Everything one person did today (IST):

```sql
select id, at at time zone 'Asia/Kolkata' as at_ist, action, target, outcome, message
from audit.events
where actor_emp = 'RC-4471'
  and at >= ((now() at time zone 'Asia/Kolkata')::date)::timestamp at time zone 'Asia/Kolkata'
order by id desc;
```

Failed sign-ins:

```sql
select at at time zone 'Asia/Kolkata' as at_ist, actor_emp, ip, cause
from audit.events where action = 'login' and outcome = 'refused' order by id desc limit 50;
```

The outbox - how many events wait for the drainer, and how long the oldest has waited. A healthy box
reads a handful at most and a few seconds:

```sql
select count(*) as waiting, now() - min(at) as oldest from audit_outbox;
```

Dead letters - events the audit service could not read (§9, `AuditDeadLetters`):

```sql
select id, outbox_id, at at time zone 'Asia/Kolkata' as at_ist, issue
from audit.dead_letters order by id desc limit 20;
```

`curl -fsS https://rch.hashtrickstechnologies.com/readyz/audit` is the one-line health check: it
fails once no drain pass has succeeded for 30 s. These are reads. Even as `rch`, a trigger refuses
UPDATE, DELETE and TRUNCATE on `audit.events` and `audit.dead_letters`: there is no way to edit a
line of the log, by design.
````

---

- [ ] **Step 9b: `deploy/chart/rch/templates/NOTES.txt`**

Replace:

```text
To create a user: kubectl exec deploy/{{ .Release.Name }}-api -- /nodejs/bin/node dist/cli/users.mjs create --email <email> --role <role>
```

With:

```text
To create a user: kubectl exec deploy/{{ .Release.Name }}-api -c api -- /nodejs/bin/node dist/cli/users.mjs create --name <name> --email <email> --role <role> --loc <loc> --password <temporary>
That runs as the api container's database role, rch_app, which is enough for users, payers and
rebuild-balances. A seed, or anything with --force, needs the superuser: run it in a one-off pod
built from this Deployment's migrate initContainer (deploy/RUNBOOK.md §5, "Operator CLIs in a cluster").
```

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log helm:test`
Expected: PASS (NOTES.txt renders; nothing asserts on this line).

---

- [ ] **Step 10: Check the style rules**

Run:

```bash
grep -n "—" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/CLAUDE.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/CLAUDE.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/CLAUDE.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/UI/CLAUDE.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/packages/contract/CLAUDE.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/README.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/UI/README.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/README.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/RUNBOOK.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/chart/rch/templates/NOTES.txt
```

Expected: no output (no em dash anywhere).

Run: `git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log diff --check`
Expected: no output (no trailing whitespace, no conflict markers).

Run: `grep -c "^### 16.7 Reading the audit log from the box$" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/RUNBOOK.md` and `grep -c "^### The database roles$" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/RUNBOOK.md`
Expected: `1` each.

Run: `grep -n "^[0-9]*\. \*\*" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/RUNBOOK.md | sed -n '/RchApiHigh5xxRate/,/RDS free storage/p'`
Expected: items numbered 1 to 10 in order, `AuditDrainLagging` at 7, `AuditDeadLetters` at 8, DB connections at 9, RDS free storage at 10.

---

- [ ] **Step 11: Verify every statement against the code**

Every path below is absolute, so each command runs from any directory. Every expectation is what Tasks 1-18 build
(the decisions and the finished parts agree on each). A mismatch means a doc sentence is wrong: fix it in every
file this task touched that repeats it, then re-run the command.

Ports, scripts and local dev:

- **1.** `grep -n "3100" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/config.ts /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/Dockerfile`
  Expected: the `PORT` default is `3100`; the image sets `ENV PORT=3100`
- **2.** `grep -n '"dev"\|"test"\|"build"\|"db:generate"\|"db:migrate"' /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/package.json`
  Expected: `"dev": "PORT=3100 tsx watch --env-file=../../.env src/server.ts"`, `"build": "tsup"`, `"test": "vitest run --coverage"`, `"db:generate": "node scripts/db-generate.mjs"`, `"db:migrate": "tsx --env-file=../../.env src/cli/migrate.ts"`
- **3.** `grep -n "thresholds\|exclude" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/vitest.config.ts`
  Expected: `lines: 90, branches: 75`; `src/server.ts` and `src/cli/**` excluded. If Task 20 set higher measured figures, Task 20 also corrects root `CLAUDE.md` and `apps/audit/CLAUDE.md`; write the same figures in `README.md` (6g)
- **4.** `grep -n "AUDIT_DATABASE_URL\|MIGRATE_DATABASE_URL" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/.env.example`
  Expected: `AUDIT_DATABASE_URL=postgres://rch:rch@localhost:5439/rch` set; `MIGRATE_DATABASE_URL` only as a comment
- **5.** `grep -n "admin/audit\|3100\|\"/api\"" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/UI/vite.config.ts`
  Expected: a `/api/v1/admin/audit` proxy to `http://localhost:3100`, listed before `/api`
- **6.** Run `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log dev` in the background, wait for the servers, then `curl -fsS http://localhost:3100/healthz` and `curl -fsS http://localhost:3000/healthz`; stop the dev process
  Expected: both answer
- **7.** `grep -n '"test"' /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/turbo.json`
  Expected: the `test` task's `env` includes `AUDIT_DATABASE_URL` and `MIGRATE_DATABASE_URL`

Contract and dependency rule:

- **8.** `grep -n "service\|isWriteRoute" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/packages/contract/src/routes.ts`
  Expected: `service?: Service`, `serviceOf`, `isWriteRoute`, and `auditLog` / `auditEntry` with `service: "audit"`, `access: "admin"`
- **9.** `grep -n "export" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/packages/contract/src/audit.ts`
  Expected: `AUDIT_GROUPS`, `WriteRouteName`, `AuditAction`, `AuditLabel`, `AUDIT_LABELS`, `auditLabelOf`, `actionsInGroup`, `AUDIT_PATH`
- **10.** `grep -n "ip\|requestId" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/packages/contract/src/schemas/audit.ts`
  Expected: `AuditRowSchema` carries `ip` and `requestId`; `AuditEntrySchema` does not re-declare them
- **11.** `grep -rn -i "recipe" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/CLAUDE.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/CLAUDE.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/CLAUDE.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/UI/CLAUDE.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/packages/contract/CLAUDE.md`
  Expected: no output
- **12.** `grep -n "apps/audit\|@rch/audit\|@rch/domain\|audit/src\|api/src" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/.oxlintrc.json; ls /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/.oxlintrc.json`
  Expected: `apps/api/**` bans `**/apps/audit/**`, `**/audit/src/**` and `@rch/audit`; `apps/audit/**` bans `apps/api`, `@rch/api`, `UI`, `@rch/ui`, `@rch/domain`; `ls` reports no such file
- **13.** `grep -n "@rch/" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/package.json`
  Expected: `@rch/contract` is the only workspace dependency

API capture:

- **14.** `grep -n "SECRET_KEYS\|MASK\|rch_audit_outbox" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/lib/audit.ts`
  Expected: `SECRET_KEYS` with exactly `password`, `newPassword`, `currentPassword`, `tempPassword`, `otp`, `token`, `accessToken`, `refreshToken`, `secret`; `MASK = "••••"`; `AUDIT_OUTBOX_CHANNEL = "rch_audit_outbox"`; the notify passes `current_schema()`
- **15.** `grep -n "body.from\|result.from\|list:\|#" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/lib/audit.ts`
  Expected: `targetLoc` falls back through `body.from` and `result.from`; composite targets `list:it`, `loc:it`, `id#n`
- **16.** `grep -n "recordAudit" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/lib/db.ts`
  Expected: called with the recorded body right after `recordIdempotent`, inside the transaction
- **17.** `grep -n "onResponse\|401\|idempotency-replayed\|auditSettled\|verify" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/plugins/audit.ts`
  Expected: an `onResponse` hook that skips a 401, a replay, and a request with no verifiable token; `app.auditSettled()` decorated
- **18.** `grep -n "mountedWrites" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/routes.ts /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/modules/audit-capture.test.ts`
  Expected: exported from `routes.ts`, asserted in the capture test
- **19.** `grep -rln "auditBefore" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/modules`
  Expected: `catalog`, `availability`, `vendors`, `contracts`, `me`, `purchaseorders` and `admin` services, and `modules/audit-before.test.ts`
- **20.** `grep -n "recordAuthEvent\|RC-\|onSend" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/modules/auth/service.ts /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/modules/auth/routes.ts`
  Expected: login done/refused, lock-out, logout (only when a live session was revoked), changePassword with `request: {}`; the typed id kept only when it matches `/^RC-\d+$/i`; an `onSend` hook recording the per-IP 429
- **21.** `grep -n "audit\|admin" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/plugins/sse.ts`
  Expected: a per-stream admin flag; `audit` notices sent to admin streams only
- **22.** `grep -n "migrateDatabaseUrl\|cliDatabaseUrl" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/config.ts`
  Expected: both exist; `cliDatabaseUrl` falls back to `databaseUrl`
- **23.** `grep -n "escapeLiteral\|__drizzle_migrations\|audit_outbox\|default privileges" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/lib/roles.ts`
  Expected: escaped password; `select` on the migrations table; default privileges; `insert` alone on the outbox
- **24.** `ls /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/drizzle/ | grep audit_outbox; grep -n "UPDATE\|update" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/drizzle/0016_audit_outbox.sql`
  Expected: `0016_audit_outbox.sql`, containing the `audit_outbox_no_update` trigger
- **25.** `grep -n "audit_outbox\|drain.ts\|test" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/scripts/check-boundaries.sh`
  Expected: in `apps/api/src` only `lib/audit.ts` inserts into `audit_outbox` and nothing selects/updates/deletes it; in `apps/audit/src` only `lib/drain.ts` deletes from the outbox or inserts into `events` / `dead_letters`; test files and `src/test/**` exempt; the four-file module check covers `apps/audit/src/modules/*/`
- **26.** `ls /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/lib/roles.test.ts && grep -n "pid" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/api/src/lib/roles.test.ts`
  Expected: role names carry the process id

Audit service:

- **27.** `grep -rn "727273\|727272\|OUTBOX_WAIT\|300_000\|2_000" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/lib/migrate-run.ts`
  Expected: `AUDIT_MIGRATE_LOCK = 727273`, `API_MIGRATE_LOCK = 727272` around the role step, a 5-minute wait polling every 2 s
- **28.** `grep -n "process.exit\|exit" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/cli/migrate.ts`
  Expected: exit 2 on `ConfigError`, 3 on `OutboxMissingError`, 1 otherwise
- **29.** `grep -n "escapeLiteral\|revoke\|update (at)" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/lib/roles.ts`
  Expected: escaped password; `revoke all on schema … from public`; `select, delete, update (at)` on the outbox
- **30.** `grep -n "skip locked\|delete from\|insert into\|rch_events_\|savepoint\|database refused it" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/lib/drain.ts`
  Expected: each verb with its table on one line; the savepoint retry; the notice on `rch_events_` only when something moved
- **31.** `grep -n "rch_audit_outbox\|payload\|drainNow" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/plugins/drainer.ts`
  Expected: the listener kicks only for a payload equal to `OUTBOX_SCHEMA` or empty; `drainNow` decorated
- **32.** `grep -n "append_only\|TRUNCATE" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/drizzle/0000_audit_events.sql`
  Expected: `events_append_only` and `dead_letters_append_only`, `BEFORE UPDATE OR DELETE OR TRUNCATE … FOR EACH STATEMENT`
- **33.** `grep -n "READY_STALE_MS\|addCheck" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/plugins/drainer.ts /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/plugins/db.ts /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/plugins/health.ts`
  Expected: `READY_STALE_MS = 30_000`; checks `database` and `drainer`
- **34.** `grep -rn "audit_outbox_depth\|audit_drain_lag_seconds\|audit_events_stored_total\|audit_dead_letters_total\|audit_listener_up" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/plugins`
  Expected: all five metric names
- **35.** `grep -n "allowedIss\|onRequest\|admin" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/plugins/auth.ts /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/routes.ts`
  Expected: `allowedIss: "rch-api"`; gates on `onRequest`; a non-admin token answered 404; `mountedRoutes` keyed `"<METHOD> <path>"`
- **36.** `grep -n "actor_loc\|target_loc\|to_char" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/modules/audit/repo.ts`
  Expected: `loc` matches `actor_loc` or `target_loc`; `at` formatted with `to_char`
- **37.** `grep -n "DRAIN_BATCH\|DRAIN_POLL_MS\|AUDIT_SCHEMA\|OUTBOX_SCHEMA\|EVENTS_SCHEMA\|DB_POOL_MAX" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/config.ts`
  Expected: defaults 500, 5000, `audit`, `public`, `public`, 5
- **38.** `grep -n "export" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/test/app.ts /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/apps/audit/src/test/db.ts`
  Expected: `buildTestApp`, `signToken`, `sampleEvent`, `withAuditSchema`, `putOutbox`, `resetAudit`

UI:

- **39.** `grep -n "\"audit\"\|Audit log\|<Drawer" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/UI/src/pages/AdminDashboard.tsx`
  Expected: `Tab` is `"accounts" | "support" | "audit"`, a tab labelled Audit log, the `<Drawer />` host mounted
- **40.** `grep -n "registerDrawer" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/UI/src/pages/AuditEntryDrawer.tsx; grep -n "auditEntry" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/UI/src/__tests__/screens.test.tsx`
  Expected: `registerDrawer("auditEntry", …)` and an `OPEN_OVER` row
- **41.** `grep -n "audit" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/UI/src/api/refetch.ts`
  Expected: an `audit` reader calling `bumpAuditFresh` for an admin session only
- **42.** `grep -n "return null\|50_000\|500" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/UI/src/store/audit.ts`
  Expected: the four reads return `null` on failure; the export pages at 500 and caps at 50,000
- **43.** `grep -n "New events\|Every change and sign-in" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/UI/src/pages/AdminAudit.tsx`
  Expected: the pill "New events - show" and the PageHead sentence
- **44.** `grep -n "^describe" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/UI/src/__tests__/audit-lib.test.ts; ls /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/UI/src/__tests__/admin-audit.test.tsx`
  Expected: `auditDayRange`, `deviceOf`, `diffFields`, `auditCsv`; the file exists

Deploy and CI:

- **45.** `grep -n "^  [a-z-]*:$" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/compose.yml`
  Expected: exactly `postgres`, `migrate`, `audit-migrate`, `api`, `audit`, `ui`, `caddy`
- **46.** `grep -n "rch_app\|rch_audit\|MIGRATE_DATABASE_URL\|AUDIT_UPSTREAM" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/compose.yml`
  Expected: `migrate` and `audit-migrate` carry `MIGRATE_DATABASE_URL` as `rch`; `api` connects as `rch_app`, `audit` as `rch_audit`; `ui` has `AUDIT_UPSTREAM: http://audit:3100`
- **47.** `grep -n "handle" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/Caddyfile; grep -n "order" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/compose.test.sh`
  Expected: `/api/v1/admin/audit*`, `/readyz/audit` (rewritten to `/readyz` on `audit:3100`), `/readyz` (`api:3000`), `/api/*`; the test asserts that order
- **48.** `grep -n "readyz\|logs" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/release.sh /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/.github/workflows/deploy-box.yml`
  Expected: both `/readyz` and `/readyz/audit` in each; `logs … migrate audit-migrate api audit` in `release.sh`
- **49.** `grep -n "run --rm --no-deps migrate" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/deploy.sh /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/backup.sh`
  Expected: the bare seed and the purge
- **50.** `grep -n "rch-audit" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/.github/workflows/ci.yml`
  Expected: build, scan and `kind load docker-image rch-api:ci rch-ui:ci rch-audit:ci`
- **51.** `grep -n "Scan the\|MIGRATE_DATABASE_URL\|AUDIT_DATABASE_URL\|component=audit" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/.github/workflows/deploy.yml`
  Expected: three "Scan the … image that is about to be deployed" steps; both URLs in the secret pre-flight; `audit-migrate` and `audit` logs in "What the cluster saw"
- **52.** `grep -n "rch-seed\|initContainers\|SEED_FORCE_PASSWORD_CHANGE\|RC-3120\|RC-0001\|15" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/chart/rch/ci/install-test.sh`
  Expected: the seed pod built from the `migrate` initContainer with `SEED_FORCE_PASSWORD_CHANGE=false`; the `RC-3120` login; the `RC-0001` sign-in polled in the audit log for up to 15 s
- **53.** `grep -n "AuditDrainLagging\|AuditDeadLetters\|severity\|for:\|expr" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/chart/rch/templates/prometheusrule.yaml`
  Expected: `AuditDrainLagging`: `max(audit_drain_lag_seconds{job="<release>-audit"}) > 60`, `for: 5m`, `severity: warning`; `AuditDeadLetters`: `sum(increase(audit_dead_letters_total{job="<release>-audit"}[15m])) > 0`, `severity: critical`
- **54.** `grep -n -B1 -A1 "rch.io/tier" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/chart/rch/values-prod.yaml`
  Expected: `api`, `ui` and `audit` each pinned
- **55.** `grep -n "audit" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/chart/rch/templates/networkpolicy.yaml`
  Expected: an `<release>-audit` policy with `policyTypes: [Ingress]` (port 3100 from the ui pods, `albSourceCidr` and the monitoring namespace); no egress rule
- **56.** `grep -n "MIGRATE_DATABASE_URL\|define" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/chart/rch/templates/_helpers.tpl`
  Expected: `rch.apiEnv`, `rch.apiCliEnv`, `rch.auditEnv`, `rch.auditMigrateEnv`; no `rch.envList`; `MIGRATE_DATABASE_URL` only in the CLI and audit-migrate helpers
- **57.** `grep -n "args\|name: migrate" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/chart/rch/templates/api-deployment.yaml`
  Expected: an initContainer named `migrate` with `args: ["dist/cli/migrate.mjs"]`, which the RUNBOOK §5 one-off pod overrides
- **58.** `grep -n "AUDIT_UPSTREAM" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/UI/Dockerfile /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/chart/rch/templates/ui-deployment.yaml`
  Expected: `ENV AUDIT_UPSTREAM=http://rch-audit:3100`; the chart sets the `<release>-audit.<namespace>.svc.cluster.local:3100` FQDN
- **59.** `grep -n "admin/audit" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/chart/rch/templates/ingress.yaml /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/nginx/default.conf.template`
  Expected: `/api/v1/admin/audit` before `/api` in the ingress; a `location /api/v1/admin/audit` in nginx

Then check that no sentence in the edited documents still gives an old count:

Run: `grep -n "four containers\|both images\|two tabs\|six .PrometheusRule\|Four suites\|five keys\|all four before\|both Deployments\|envList" /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/CLAUDE.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/README.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/UI/README.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/UI/CLAUDE.md /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/RUNBOOK.md`
Expected: only sentences that describe a past state and say so (§16.2's "the first four containers", §1's "proved, at thirteen"), `packages/contract/CLAUDE.md`'s "both images" (the API's and the audit service's, not in this grep) and `UI/CLAUDE.md`'s "two tabs presenting the same one" (browser tabs).

---

- [ ] **Step 12: Commit**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add CLAUDE.md apps/api/CLAUDE.md apps/audit/CLAUDE.md UI/CLAUDE.md packages/contract/CLAUDE.md README.md UI/README.md deploy/RUNBOOK.md deploy/chart/rch/templates/NOTES.txt
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "$(cat <<'EOF'
Document the audit log service, its roles and its deploy

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG
EOF
)"
```

Expected: one commit touching exactly those nine files (ten if Step 8 had to add a sentence to `deploy/compose/README.md`). `git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log status --short` then shows nothing staged or modified from this task.

---

### Task 20: Full verification

**Files:**
- Modify: `apps/audit/vitest.config.ts` (coverage floor set to the measured figures)
- Modify: `CLAUDE.md` and `apps/audit/CLAUDE.md` (the floor figures, if they differ from `90 / 75`)

**Interfaces:**
- Consumes: everything from Tasks 1-19
- Produces: a branch that passes every CI gate locally, and a recorded end-to-end run

- [ ] **Step 1: Rebase onto develop and re-run the manifest checks**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log fetch origin
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log rebase origin/develop
```
Expected: a clean rebase. On a conflict in `packages/contract/src/routes.ts`, keep develop's routes and re-add `service` and the two audit routes. If develop added a migration, renumber `apps/api/drizzle/00NN_audit_outbox.sql` to the next free number, move its `_journal.json` entry after develop's with a `when` larger than every earlier entry, and run `pnpm --filter @rch/api db:generate` until it prints "No schema changes".

- [ ] **Step 2: The full test and typecheck gate**

Run: `pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log install --frozen-lockfile && pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log turbo typecheck test`
Expected: all five packages pass. A new route added on develop without an `AUDIT_LABELS` entry fails typecheck here by design - add its label.

- [ ] **Step 3: Set the audit service's coverage floor to what it measures**

Run: `pnpm --filter @rch/audit --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log test`
Read the `All files` row. Set `thresholds` in `apps/audit/vitest.config.ts` to the measured lines and branches, rounded **down** to the whole number:

```ts
      thresholds: { lines: <measured lines, floored>, branches: <measured branches, floored> },
```

If either measured figure is below 90 lines / 75 branches, add tests for the uncovered branches the report lists (typically: listener reconnect, a stale `/readyz`, config parse failures) until it reaches them. Never ship a floor under those targets. Update the `apps/audit` figures in `CLAUDE.md` (the coverage floor sentence) and `apps/audit/CLAUDE.md` (Commands) to match. Confirm the API and UI summaries are not below Task 0's baseline figures; raise their floors if they rose past the next whole number.

- [ ] **Step 4: Lint, knip, boundaries, audit**

```bash
pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log lint
pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log check:boundaries
pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log audit
```
Expected: all exit 0 with zero warnings.

- [ ] **Step 5: Builds**

```bash
pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log build
```
Expected: `apps/api/dist/server.mjs`, `apps/audit/dist/server.mjs`, `apps/audit/dist/cli/migrate.mjs` and `UI/dist/index.html` exist.

- [ ] **Step 6: Deploy files**

```bash
pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log helm:test
pnpm --dir /Users/srimanikandanr/.superset/worktrees/RCH-audit-log compose:test
shellcheck /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/*.sh /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/chart/rch/ci/install-test.sh
docker run --rm -v /Users/srimanikandanr/.superset/worktrees/RCH-audit-log:/repo --workdir /repo rhysd/actionlint:1.7.12 -color
```
Expected: all pass. (`compose:test` and actionlint skip or fail loudly without Docker; Docker must be running for this step.)

- [ ] **Step 7: The whole Compose stack, locally, end to end**

This is the one place the three services, the two migrate steps, both roles and Caddy run together before CI's kind cluster does it again.

```bash
cp /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/.env.example /private/tmp/claude-501/-Users-srimanikandanr--superset-projects-RCH/2dbfea34-0e58-4324-89ac-df338e326e3b/scratchpad/compose.env
```
Edit that copy: `DOMAIN=localhost`, `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `AUDIT_DB_PASSWORD` and `SEED_PASSWORD` set to distinct 20-character values, JWT keys from `pnpm --filter @rch/api keys:generate`, `BACKUP_BUCKET=unused`. Then:

```bash
docker compose -p rch-audit-e2e -f /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/compose.yml --env-file /private/tmp/claude-501/-Users-srimanikandanr--superset-projects-RCH/2dbfea34-0e58-4324-89ac-df338e326e3b/scratchpad/compose.env up -d --build
docker compose -p rch-audit-e2e -f /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/compose.yml --env-file /private/tmp/claude-501/-Users-srimanikandanr--superset-projects-RCH/2dbfea34-0e58-4324-89ac-df338e326e3b/scratchpad/compose.env run --rm --no-deps migrate dist/cli/seed.mjs --bare --yes-seed rch
```
Expected: `migrate` and `audit-migrate` exit 0; `api`, `audit`, `ui`, `caddy` are up.

Check, in order (Caddy serves `https://localhost` with its internal CA, hence `-k`):

```bash
curl -sk https://localhost/readyz            # 200 from the API
curl -sk https://localhost/readyz/audit      # 200 from the audit service
TOKEN=$(curl -sk https://localhost/api/v1/auth/login -H 'content-type: application/json' \
  -d "{\"emp\":\"RC-0001\",\"password\":\"$SEED_PASSWORD\"}" | jq -r .accessToken)
curl -sk "https://localhost/api/v1/admin/audit" -H "authorization: Bearer $TOKEN" | jq '.rows[0] | {action, outcome, actor}'
```
Expected: the last command prints `{"action":"login","outcome":"done","actor":{... "emp":"RC-0001" ...}}` within a few seconds of the sign-in. (Check the login response's real token field name in `packages/contract/src/schemas/auth.ts` `AuthResponseSchema` and use it in the `jq` filter.)

Prove the roles hold:

```bash
docker compose -p rch-audit-e2e -f /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/compose.yml --env-file /private/tmp/claude-501/-Users-srimanikandanr--superset-projects-RCH/2dbfea34-0e58-4324-89ac-df338e326e3b/scratchpad/compose.env exec -T -e PGPASSWORD="$APP_DB_PASSWORD" postgres psql -h localhost -U rch_app -d rch -c 'select count(*) from audit.events'
```
Expected: `ERROR:  permission denied for schema audit`.

```bash
docker compose -p rch-audit-e2e -f /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/compose.yml --env-file /private/tmp/claude-501/-Users-srimanikandanr--superset-projects-RCH/2dbfea34-0e58-4324-89ac-df338e326e3b/scratchpad/compose.env exec -T -e PGPASSWORD="$APP_DB_PASSWORD" postgres psql -h localhost -U rch_app -d rch -c 'delete from audit_outbox'
```
Expected: `ERROR:  permission denied for table audit_outbox`.

- [ ] **Step 8: The page in a browser**

With the Compose stack still up, open `https://localhost/login` (use the Playwright browser tools), sign in as the administrator `RC-0001`, open the **Audit log** tab and confirm, taking a screenshot of each:
1. the sign-in from Step 7 is listed with Done, and a deliberately wrong password attempt made just before shows as Refused "Failed sign-in" with the typed id;
2. creating a staff account on the Accounts tab makes the "New events - show" pill appear on the Audit log tab, and pressing it lists "Created a staff account" (whatever label Task 1 gave `createAdminUser`);
3. opening that entry shows Who, When to the second, the device, the request id, and **no** temporary password anywhere (it reads `••••`);
4. changing that account's role on the Accounts tab and opening the new entry shows a before → after row for the role;
5. Export CSV downloads a file whose header is `at (IST),emp,name,role,location,area,action,target,outcome,status,message,ip,request id`.

Then tear the stack down: `docker compose -p rch-audit-e2e -f /Users/srimanikandanr/.superset/worktrees/RCH-audit-log/deploy/compose/compose.yml --env-file /private/tmp/claude-501/-Users-srimanikandanr--superset-projects-RCH/2dbfea34-0e58-4324-89ac-df338e326e3b/scratchpad/compose.env down -v`

- [ ] **Step 9: Commit the floors**

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log add apps/audit/vitest.config.ts apps/audit/CLAUDE.md CLAUDE.md
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log commit -m "Set the audit service's coverage floor to what it measures

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0158qcBKNn1AxNe6BZ2jBRhG"
```
(Skip the commit if nothing changed.)

---

### Task 21: Ship (only on the user's explicit go-ahead)

**Files:**
- None in the repo. Changes `/opt/rch/app/deploy/compose/.env` on the live box.

**Interfaces:**
- Consumes: the verified branch from Task 20
- Produces: `develop` carrying the audit log service, deployed to https://rch.hashtrickstechnologies.com

Every step below is outward-facing. Ask the user before Step 2 and again before Step 4, and stop if the answer is anything but yes.

- [ ] **Step 1: Summarise for the user**

Tell the user: the commit range (`git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log log --oneline origin/develop..HEAD`), the migration number, that the live box's API will restart as `rch_app`, that a new `audit` container starts, and the two prerequisites below.

- [ ] **Step 2: Check the box has room for a fourth Node process** (after the user says yes)

```bash
id=$(aws ssm send-command --region ap-south-1 --instance-ids i-0b581bbf5e55e7a7f --document-name AWS-RunShellScript \
  --parameters 'commands=["free -m","docker stats --no-stream --format \"{{.Name}} {{.MemUsage}}\""]' --query Command.CommandId --output text)
sleep 5
aws ssm get-command-invocation --region ap-south-1 --command-id "$id" --instance-id i-0b581bbf5e55e7a7f --query StandardOutputContent --output text
```
Expected: `available` memory above 400 MiB. If it is lower, stop and report: the audit container needs ~120 MiB and the build needs more.

- [ ] **Step 3: Add the two role passwords to the box's `.env`** (same approval)

Generate both values on the box so neither passes through this session or the command history:

```bash
id=$(aws ssm send-command --region ap-south-1 --instance-ids i-0b581bbf5e55e7a7f --document-name AWS-RunShellScript \
  --parameters 'commands=["cd /opt/rch/app/deploy/compose","grep -q ^APP_DB_PASSWORD= .env || echo APP_DB_PASSWORD=$(openssl rand -hex 24) >> .env","grep -q ^AUDIT_DB_PASSWORD= .env || echo AUDIT_DB_PASSWORD=$(openssl rand -hex 24) >> .env","grep -c -E ^(APP|AUDIT)_DB_PASSWORD= .env"]' \
  --query Command.CommandId --output text)
sleep 5
aws ssm get-command-invocation --region ap-south-1 --command-id "$id" --instance-id i-0b581bbf5e55e7a7f --query StandardOutputContent --output text
```
Expected: `2`. Check the file's owner and mode stayed `ubuntu` and `600` (`stat -c '%U %a' .env` in the same way).

- [ ] **Step 4: Push** (after the user's second yes)

Follow the shipping memory: push from the worktree, never from the shared checkout.

```bash
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log fetch origin
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log rebase origin/develop
git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log push origin HEAD:develop
```
If the rebase brought new commits, re-run Task 20 Steps 2 and 4 before pushing.

- [ ] **Step 5: Watch CI, then the box deploy**

```bash
gh run list --repo "$(git -C /Users/srimanikandanr/.superset/worktrees/RCH-audit-log remote get-url origin)" --branch develop --limit 3
gh run watch <ci run id> --exit-status
gh run list --workflow deploy-box.yml --limit 1
gh run watch <deploy-box run id> --exit-status
```
Expected: CI green on every job (including the kind install's audit check), then `deploy-box.yml` green. Never re-run an older sha's CI: a newer push from a peer cancels ours, and its green run deploys our commit too.

- [ ] **Step 6: Verify live without writing data**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://rch.hashtrickstechnologies.com/readyz
curl -s -o /dev/null -w '%{http_code}\n' https://rch.hashtrickstechnologies.com/readyz/audit
curl -s -o /dev/null -w '%{http_code}\n' https://rch.hashtrickstechnologies.com/api/v1/admin/audit
```
Expected: `200`, `200`, `401`. Then ask the user to sign in as RC-0001 and open the Audit log tab. Their own sign-in should be the newest row. Do not sign in to production yourself.

- [ ] **Step 7: Record it**

Update the memory files `rch-audit-log-service.md` and `rch-aws-deploy.md` with the deployed sha, the migration number, and that the box now runs `api` as `rch_app` and `audit` as `rch_audit`.
