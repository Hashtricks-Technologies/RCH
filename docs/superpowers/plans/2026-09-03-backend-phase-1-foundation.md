# RCH Backend — Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo, the Fastify API with its production plumbing, the full PostgreSQL schema with seed, real authentication, and the read-only `/snapshot` the frontend renders from — deployed to staging by Helm — so phases 2–6 are pure domain work on a finished platform.

**Architecture:** pnpm + Turborepo workspace with two "just-in-time" packages (`@rch/contract` for types, Zod schemas, the route manifest and fixtures; `@rch/domain` for pure rules) consumed as TypeScript source by both `apps/api` and `UI`. The API is Fastify 5 with `fastify-type-provider-zod`, Drizzle on `pg`, and one module per domain area (`routes.ts` / `service.ts` / `repo.ts` / tests). Every route is declared once in the contract's manifest; the server mounts the manifest, the UI's single generic client calls it. Frontend cutover in this phase is sign-in and reading state from the server; mutations stay local until later phases.

**Tech Stack:** Node 24 LTS · pnpm 10 · Turborepo 2 · TypeScript ~6.0 · Fastify 5.12 · fastify-type-provider-zod 7 · Zod 4 · Drizzle ORM 0.45 + drizzle-kit 0.31 · pg 8 · PostgreSQL 17 · @fastify/jwt 10 (EdDSA) · @node-rs/argon2 2 · prom-client 15 · Vitest 4 · tsup 8 · Docker · Helm 3.

**Spec:** `docs/superpowers/specs/2026-09-03-backend-design.md` — read §5 (layout), §5.1 (reuse rules), §6 (architecture), §7 (data model), §8 (auth), §9.1 (snapshot), §11 (deployment), §12 (production bar) before starting. The plan argues from the spec; where the plan is silent, the spec decides.

## Global Constraints

Copied from the spec. Every task's requirements include these.

- **Branch model:** work lands on `develop`. Never push to `staging` or `production` from a task; promotion is a separate, human step (`git merge --ff-only`).
- **Versions:** Node `24` (`.nvmrc`), pnpm `10.28.2` (`packageManager` field), TypeScript `~6.0.2`, Vitest `^4.1.11`, Zod `^4.5.4`, Fastify `^5.12.1`, `fastify-type-provider-zod ^7.0.0`, `drizzle-orm ^0.45.2`, `drizzle-kit ^0.31.10`, `pg ^8.23.0`, `@fastify/jwt ^10.2.2`, `@node-rs/argon2 ^2.2.0`, `prom-client ^15.1.3`, `tsup ^8.5.1`, `turbo ^2.10.12`, `knip ^6.34.0`, `oxlint ^1.81.0`. PostgreSQL image `postgres:17`.
- **Wire shape is `types.ts` as it stands** — `it`, `qty`, `st`, `n`, `hist`, …. Do not rename fields on the wire. Database columns use full snake_case names; the repo layer maps.
- **Quantities are `numeric(12,3)` and rounded with `round3`; money is `numeric(12,2)`; timestamps are `timestamptz` stored UTC.** `pg` returns `numeric` as a string — every reader converts with `Number()`.
- **Error envelope on every non-2xx:** `{ error: { code, message, details? } }` with codes `validation` 400, `unauthenticated` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `rule` 422, `rate_limited` 429, `internal` 500. `message` is a full sentence in the operator's voice; never a stack trace or SQL.
- **Every write is one transaction.** `stock_moves`, `stock_balances`, `sequences`, `document_history`, `idempotency_keys` are written only through `apps/api/src/lib/*` helpers.
- **Reuse rules (spec §5.1) apply from the first commit:** no business rule outside `packages/domain`; no wire type outside `packages/contract`; no `fetch` outside `UI/src/api/client.ts`; every server module has `routes.ts`, `service.ts`, `repo.ts`, `<name>.test.ts`.
- **`strict` TypeScript everywhere** with `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `erasableSyntaxOnly`. Type-only imports use `import type`.
- **Every task ends green:** `pnpm turbo typecheck lint test` passes at the repo root before its commit. The 294 existing UI tests keep passing throughout; a task that breaks one fixes it in the same task.
- **Commit messages** are one sentence in the imperative describing why, not what, followed by the two trailers used throughout this repo:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
  ```
- **Prerequisites on the machine:** Docker Desktop running; Helm 3 installed (`brew install helm`) for Task 17; Node 24 active (`nvm use` reads `.nvmrc`).

---

## File structure

What exists after Phase 1. Responsibilities are one line each; a file that needs two lines is doing too much.

```
.
├── package.json                      workspace root: turbo scripts, packageManager, engines
├── pnpm-workspace.yaml               packages/*, apps/*, UI
├── turbo.json                        build / typecheck / lint / test pipelines
├── tsconfig.base.json                shared strict compiler options
├── .nvmrc  .npmrc  .env.example      node 24; pnpm settings; documented env
├── docker-compose.yml                postgres:17 for dev and tests
├── knip.json                         dead-export detection config
├── packages/
│   ├── contract/                     @rch/contract
│   │   ├── package.json              exports "." and "./fixtures" as TS source
│   │   └── src/
│   │       ├── index.ts              re-exports types, schemas, routes
│   │       ├── types.ts              UI/src/types.ts, verbatim
│   │       ├── schemas/common.ts     ErrorEnvelope, ids, LocKey/Role enums as Zod
│   │       ├── schemas/auth.ts       login / refresh / change-password / me
│   │       ├── schemas/snapshot.ts   Snapshot and every document schema
│   │       ├── routes.ts             the manifest: method, path, schemas, roles
│   │       └── fixtures/             master.ts seed.ts ops.ts vendors.ts (data only)
│   └── domain/                       @rch/domain
│       └── src/ index.ts round.ts apportion.ts otp.ts ids.ts (+ *.test.ts)
├── apps/api/
│   ├── package.json  tsconfig.json  tsup.config.ts  vitest.config.ts  drizzle.config.ts  Dockerfile
│   ├── drizzle/                      generated SQL migrations + meta/_journal.json (committed)
│   └── src/
│       ├── config.ts                 env → Zod-validated Config
│       ├── app.ts                    buildApp(config): plugins + routes, no listen
│       ├── server.ts                 listen; SIGTERM drain; exit codes
│       ├── routes.ts                 mounts the contract manifest onto handlers
│       ├── db/client.ts              Pool + drizzle; createDb(url)
│       ├── db/migrate.ts             programmatic migrate; used by CLI and tests
│       ├── db/schema/*.ts            master ledger movement production buying sales ops infra
│       ├── db/seed.ts                fixtures → tables, through lib helpers
│       ├── lib/errors.ts             AppError subclasses; toEnvelope()
│       ├── lib/db.ts                 withTransaction(db, fn)
│       ├── lib/ids.ts                allocateId(tx, kind) — the only writer of sequences
│       ├── lib/history.ts            appendHistory(tx, docType, id, status, who)
│       ├── lib/ledger.ts             postMoves(tx, moves) — the only writer of moves/balances
│       ├── lib/rules.ts              assertRule(cond, message) → RuleError
│       ├── lib/time.ts               iso(), todayAt("HH:MM") for seed
│       ├── plugins/security.ts       helmet, cors, rate-limit, under-pressure, body limit
│       ├── plugins/logging.ts        request id, redaction, access log fields
│       ├── plugins/errors.ts         setErrorHandler → envelope; zod → validation
│       ├── plugins/metrics.ts        prom-client registry + http histogram + /metrics
│       ├── plugins/health.ts         /healthz /readyz (db + migration version)
│       ├── plugins/auth.ts           @fastify/jwt EdDSA, cookie, app.authenticate
│       ├── plugins/rbac.ts           roles per route → 404 for absent modules; requireLoc
│       ├── plugins/idempotency.ts    Idempotency-Key store/replay for writes
│       ├── modules/auth/             routes service repo auth.test
│       ├── modules/me/               routes service repo me.test
│       ├── modules/master/           routes service repo master.test  (items, locations, recipes, prices, menus)
│       ├── modules/snapshot/         routes service snapshot.test + readers/*.ts (one per collection)
│       ├── cli/                      users.ts seed.ts keys.ts rebuild-balances.ts
│       └── test/                     db.ts (schema per file) app.ts (build test app) builders.ts
├── UI/
│   ├── package.json                  + @rch/contract, @rch/domain (workspace:*)
│   ├── vite.config.ts                + /api proxy
│   └── src/
│       ├── types.ts                  export type * from "@rch/contract"
│       ├── data/master.ts            registries seeded from fixtures + hydrateMaster()
│       ├── data/{seed,ops,vendors}.ts re-export fixtures (+ vendor helpers stay)
│       ├── lib/selectors.ts          imports round3/apportion from @rch/domain
│       ├── lib/fmt.ts                imports makeOtp from @rch/domain; + fromWireTime, fromWireDate
│       ├── api/client.ts             the one generic call(); token + refresh handling
│       ├── api/wire.ts               snapshot → store shape (ISO → display strings)
│       ├── store/index.ts            + login, logout, loadSnapshot, auth state
│       └── pages/Login.tsx           employee id + password form; change-password step
├── deploy/
│   ├── chart/rch/                    Chart.yaml values*.yaml templates/*
│   ├── nginx/default.conf            SPA + /api proxy + SSE settings
│   └── RUNBOOK.md                    deploy, rollback, keys, passwords, restore drill, rebuild
└── .github/workflows/ci.yml          pnpm/turbo checks, images, trivy, helm lint, staging/prod deploy
```

---

### Task 1: Workspace scaffold — pnpm, Turborepo, shared TypeScript config

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.nvmrc`, `.npmrc`, `knip.json`
- Modify: `.gitignore`, `UI/package.json`, `UI/tsconfig.app.json`, `UI/tsconfig.node.json`, `scripts/build-site.sh`, `.github/workflows/ci.yml` (install step only — the full CI rewrite is Task 18)
- Delete: `UI/package-lock.json`

**Interfaces:**
- Produces: root scripts `pnpm dev`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`; the `@rch/*` package naming; `tsconfig.base.json` that every package extends.

- [ ] **Step 1: Root manifests**

`package.json`:
```json
{
  "name": "rch",
  "private": true,
  "packageManager": "pnpm@10.28.2",
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "dev": "turbo run dev --parallel",
    "build": "turbo run build",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint && knip",
    "test": "turbo run test",
    "db:up": "docker compose up -d postgres",
    "db:down": "docker compose down"
  },
  "devDependencies": {
    "knip": "^6.34.0",
    "oxlint": "^1.81.0",
    "turbo": "^2.10.12",
    "typescript": "~6.0.2"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
  - apps/*
  - UI
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^typecheck"] },
    "lint":      {},
    "test":      { "dependsOn": ["^typecheck"], "env": ["DATABASE_URL", "TEST_DATABASE_URL"] },
    "dev":       { "cache": false, "persistent": true }
  }
}
```

`tsconfig.base.json` — the UI's strict options, hoisted:
```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "erasableSyntaxOnly": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  }
}
```

`.nvmrc`: `24`

`.npmrc`:
```
engine-strict=true
auto-install-peers=true
```

`knip.json`:
```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "workspaces": {
    ".": { "entry": [], "project": [] },
    "packages/*": { "entry": ["src/index.ts", "src/fixtures/index.ts"], "project": ["src/**/*.ts"] },
    "apps/api": { "entry": ["src/server.ts", "src/cli/*.ts", "drizzle.config.ts", "tsup.config.ts"], "project": ["src/**/*.ts"] },
    "UI": { "entry": ["src/main.tsx", "vite.config.ts"], "project": ["src/**/*.{ts,tsx}"] }
  },
  "ignoreDependencies": ["@vitejs/plugin-react"]
}
```

Append to `.gitignore`:
```
# Turborepo
.turbo/
# API build
apps/api/dist/
```

- [ ] **Step 2: Bring `UI` into the workspace**

Delete `UI/package-lock.json`. In `UI/package.json` set the name and drop the devDependencies the root now owns:
```json
{
  "name": "@rch/ui",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "oxlint",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.app.json"
  },
  "dependencies": {
    "react": "^19.2.8",
    "react-dom": "^19.2.8",
    "react-router-dom": "^7.18.2",
    "zustand": "^5.0.15"
  },
  "devDependencies": {
    "@types/node": "^24.13.3",
    "@types/react": "^19.2.18",
    "@types/react-dom": "^19.2.4",
    "@vitejs/plugin-react": "^6.1.0",
    "jsdom": "^30.0.1",
    "vite": "^8.2.2",
    "vitest": "^4.1.11"
  },
  "description": "Royal Care Hospital — F&B inventory and billing frontend"
}
```

`UI/tsconfig.app.json` — extend the base, keep only what differs:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "lib": ["ES2023", "DOM"],
    "types": ["vite/client"],
    "allowArbitraryExtensions": true,
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
```

`UI/tsconfig.node.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "lib": ["ES2023"],
    "types": ["node"],
    "module": "nodenext",
    "moduleResolution": "nodenext"
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 3: Point the site build and CI at pnpm**

`scripts/build-site.sh` — replace the two npm lines:
```bash
# was: if [ ! -d UI/node_modules ]; then npm --prefix UI ci; fi
if [ ! -d node_modules ]; then
  pnpm install --frozen-lockfile
fi
# was: npm --prefix UI run build
pnpm --filter @rch/ui build
```

`.github/workflows/ci.yml` — replace the setup-node + Install + four `working-directory: UI` steps with:
```yaml
      - uses: pnpm/action-setup@v4
        with:
          version: 10.28.2

      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Typecheck, lint, test
        run: pnpm turbo typecheck lint test
```
Keep the "Build the site" and "Upload the built site" steps.

- [ ] **Step 4: Install and verify**

Run:
```bash
nvm use && pnpm install
pnpm turbo typecheck lint test
```
Expected: `pnpm-lock.yaml` created at root; turbo runs `@rch/ui#typecheck`, `#lint`, `#test`; 294 tests pass. `knip` may report unused exports in `UI` — fix any it finds by deleting the export (do not add `ignore` entries without a comment saying why).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Move the repo onto a pnpm + Turborepo workspace

The UI becomes one workspace package so the API and the shared
contract/domain packages can sit beside it; scripts and CI install
from the root lockfile.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 2: `@rch/domain` — the first pure rules, consumed by the UI

**Files:**
- Create: `packages/domain/package.json`, `packages/domain/tsconfig.json`, `packages/domain/vitest.config.ts`, `packages/domain/src/index.ts`, `packages/domain/src/round.ts`, `packages/domain/src/apportion.ts`, `packages/domain/src/otp.ts`, `packages/domain/src/ids.ts`
- Test: `packages/domain/src/round.test.ts`, `packages/domain/src/apportion.test.ts`, `packages/domain/src/otp.test.ts`, `packages/domain/src/ids.test.ts`
- Modify: `UI/package.json` (add dependency), `UI/src/lib/selectors.ts:8-9` (`round3`, `apportion`), `UI/src/lib/fmt.ts:53-54` (`makeOtp`)

**Interfaces:**
- Produces:
  - `round3(v: number): number`
  - `apportion(recv: number, src: { qty: number }[]): number[]`
  - `makeOtp(seed: number): string` — six digits
  - `type IdKind = "req" | "tkt" | "bill" | "prq" | "po" | "prd" | "batch" | "vendor" | "contract" | "support" | "product_req" | "shop_ask"`
  - `formatId(kind: IdKind, n: number, at?: Date): string` — the exact formats of spec §7.3
  - `SEQUENCE_START: Record<IdKind, number>` — first `n` each series continues from (matches the UI seed's `seq` and array lengths)

- [ ] **Step 1: Package manifests**

`packages/domain/package.json`:
```json
{
  "name": "@rch/domain",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "oxlint",
    "test": "vitest run"
  },
  "devDependencies": { "vitest": "^4.1.11" }
}
```
`packages/domain/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "lib": ["ES2023"], "types": [] }, "include": ["src"] }
```
`packages/domain/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"] } });
```

- [ ] **Step 2: Failing tests**

`packages/domain/src/round.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { round3 } from "./round";

describe("round3", () => {
  it("keeps three decimals and kills float noise", () => {
    expect(round3(0.1 + 0.2)).toBe(0.3);
    expect(round3(12 - 0.15 * 3)).toBe(11.55);
    expect(round3(2.0005)).toBe(2.001);
  });
});
```

`packages/domain/src/apportion.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { apportion } from "./apportion";

describe("apportion", () => {
  it("fills sources in order and stops when the receipt runs out", () => {
    expect(apportion(7, [{ qty: 5 }, { qty: 5 }])).toEqual([5, 2]);
  });
  it("never gives a source more than it asked for", () => {
    expect(apportion(20, [{ qty: 5 }, { qty: 5 }])).toEqual([5, 5]);
  });
  it("handles fractional quantities to three decimals", () => {
    expect(apportion(1.5, [{ qty: 1.2 }, { qty: 1.2 }])).toEqual([1.2, 0.3]);
  });
});
```

`packages/domain/src/otp.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { makeOtp } from "./otp";

describe("makeOtp", () => {
  it("is six digits and deterministic for a seed", () => {
    expect(makeOtp(441)).toMatch(/^\d{6}$/);
    expect(makeOtp(441)).toBe(makeOtp(441));
    expect(makeOtp(441)).not.toBe(makeOtp(442));
  });
});
```

`packages/domain/src/ids.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatId, SEQUENCE_START } from "./ids";

const at = new Date("2026-09-03T10:00:00+05:30");

describe("formatId", () => {
  it("matches the formats the frontend already prints", () => {
    expect(formatId("req", 913, at)).toBe("REQ-2026-0913");
    expect(formatId("tkt", 441, at)).toBe("TKT-0441");
    expect(formatId("bill", 1188, at)).toBe("CF/1188");
    expect(formatId("prq", 16, at)).toBe("PRQ-2026-016");
    expect(formatId("po", 143, at)).toBe("PO-2026-0143");
    expect(formatId("prd", 31, at)).toBe("PRD-2026-031");
    expect(formatId("batch", 1, at)).toBe("BAT-20260903-01");
    expect(formatId("vendor", 6, at)).toBe("VN-006");
    expect(formatId("contract", 109, at)).toBe("RC-109");
    expect(formatId("support", 45, at)).toBe("SUP-0045");
    expect(formatId("product_req", 13, at)).toBe("NPR-0013");
    expect(formatId("shop_ask", 62, at)).toBe("ASK-062");
  });
  it("continues each seeded series rather than restarting it", () => {
    expect(SEQUENCE_START.req).toBe(913);
    expect(SEQUENCE_START.tkt).toBe(441);
    expect(SEQUENCE_START.bill).toBe(1188);
  });
});
```

Run: `pnpm --filter @rch/domain test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/domain/src/round.ts`:
```ts
/** Round to three decimals — the tolerance every quantity in this system is kept at. */
export const round3 = (v: number): number => Math.round(v * 1000) / 1000;
```

`packages/domain/src/apportion.ts`:
```ts
import { round3 } from "./round";

/** A receipt fills its source lines in order — deterministic and explainable
 *  when one purchase-order line funds several requisitions. */
export function apportion(recv: number, src: { qty: number }[]): number[] {
  let left = recv;
  return src.map((x) => {
    const take = round3(Math.min(Math.max(left, 0), x.qty));
    left = round3(left - take);
    return take;
  });
}
```

`packages/domain/src/otp.ts`:
```ts
/** Six digits quoted at handover. An operational check that the collector is
 *  the person the ticket was issued to — not a security token. */
export const makeOtp = (seed: number): string =>
  String(((seed * 7919 + 104729) % 900000) + 100000);
```

`packages/domain/src/ids.ts`:
```ts
export type IdKind =
  | "req" | "tkt" | "bill" | "prq" | "po" | "prd" | "batch"
  | "vendor" | "contract" | "support" | "product_req" | "shop_ask";

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const ymd = (d: Date) => {
  // Calendar date in the hospital's zone, so a batch made at 00:30 IST is dated today, not yesterday.
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get("year")}${get("month")}${get("day")}`;
};
const year = (d: Date) => ymd(d).slice(0, 4);

/** Document numbers exactly as the frontend has always printed them (spec §7.3). */
export function formatId(kind: IdKind, n: number, at: Date = new Date()): string {
  switch (kind) {
    case "req":         return `REQ-${year(at)}-0${n}`;
    case "tkt":         return `TKT-0${n}`;
    case "bill":        return `CF/${n}`;
    case "prq":         return `PRQ-${year(at)}-0${n}`;
    case "po":          return `PO-${year(at)}-0${n}`;
    case "prd":         return `PRD-${year(at)}-0${n}`;
    case "batch":       return `BAT-${ymd(at)}-${pad(n, 2)}`;
    case "vendor":      return `VN-${pad(n, 3)}`;
    case "contract":    return `RC-${n}`;
    case "support":     return `SUP-00${n}`;
    case "product_req": return `NPR-00${n}`;
    case "shop_ask":    return `ASK-0${n}`;
  }
}

/** The first number each series issues, continuing the seeded documents.
 *  Mirrors the UI store's `seq` and the lengths the ops slice counts from. */
export const SEQUENCE_START: Record<IdKind, number> = {
  req: 913, tkt: 441, bill: 1188, prq: 16, po: 143, prd: 31, batch: 1,
  vendor: 6, contract: 109, support: 44, product_req: 13, shop_ask: 62,
};
```

`packages/domain/src/index.ts`:
```ts
export { round3 } from "./round";
export { apportion } from "./apportion";
export { makeOtp } from "./otp";
export { formatId, SEQUENCE_START, type IdKind } from "./ids";
```

Run: `pnpm --filter @rch/domain test`
Expected: PASS (4 files).

Note on `SEQUENCE_START`: `support`, `product_req`, `contract`, `shop_ask` are derived from the UI's array-length arithmetic (`SUP-00` + (tickets.length + 41) with 3 seeded tickets → 44; `NPR-00` + (productReqs.length + 12) with 1 seeded → 13; `RC-` + (contracts.length + 101) with 8 → 109; `ASK-0` + (shopAsks.length + 61) with 1 → 62). If the fixture counts differ when you read them, correct these numbers — the invariant is "first server-issued id continues the visible series".

- [ ] **Step 4: Make the UI consume it**

`UI/package.json` — add under `dependencies`: `"@rch/domain": "workspace:*"`.

`UI/src/lib/selectors.ts` — delete the local `round3` definition (line 8-9) and the local `apportion` function; at the top add:
```ts
import { apportion, round3 } from "@rch/domain";
export { apportion, round3 };
```
Keep every other export exactly as it is.

`UI/src/lib/fmt.ts` — delete the local `makeOtp` (last three lines) and add:
```ts
export { makeOtp } from "@rch/domain";
```

Run: `pnpm install && pnpm turbo typecheck lint test`
Expected: PASS — 294 UI tests + 4 domain files.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Extract the first pure rules into @rch/domain

round3, apportion, makeOtp and the document-number formats now have one
home the UI and the coming API both import; the UI re-exports them so
no screen changes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 3: `@rch/contract` — types and fixtures move out of the UI

**Files:**
- Create: `packages/contract/package.json`, `packages/contract/tsconfig.json`, `packages/contract/vitest.config.ts`, `packages/contract/src/index.ts`, `packages/contract/src/types.ts`, `packages/contract/src/fixtures/index.ts`, `packages/contract/src/fixtures/master.ts`, `packages/contract/src/fixtures/seed.ts`, `packages/contract/src/fixtures/ops.ts`, `packages/contract/src/fixtures/vendors.ts`
- Test: `packages/contract/src/fixtures/fixtures.test.ts`
- Modify: `UI/package.json`, `UI/src/types.ts`, `UI/src/data/master.ts`, `UI/src/data/seed.ts`, `UI/src/data/ops.ts`, `UI/src/data/vendors.ts`

**Interfaces:**
- Produces: every type in `UI/src/types.ts` under `@rch/contract`; `@rch/contract/fixtures` exporting `LOC, IT, RCP, PL, MENU, USERS, OUTLETS, ALL_LOCS, PAR_FACTOR, PATIENTS, STAFF, DEPTS, STAFF_CREDIT_LIMIT, PO_APPROVAL_LIMIT, RATE_CONTRACT` (from master), `seedStock, seedReq, seedTkt, seedPrq, seedPo, seedGrn, seedPord, seedBatch, seedBills, seedSales, DAY_LABELS, seedRsv` (from seed), `seedTickets, seedProductRequests, seedContracts, seedShopAsks` (from ops), `seedVendors` (from vendors).
- UI keeps importing from `../types`, `../data/master`, `../data/seed`, `../data/ops`, `../data/vendors` — those files become re-exports, so **no screen file changes**.

- [ ] **Step 1: Package manifests**

`packages/contract/package.json`:
```json
{
  "name": "@rch/contract",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./fixtures": "./src/fixtures/index.ts"
  },
  "scripts": { "typecheck": "tsc --noEmit", "lint": "oxlint", "test": "vitest run" },
  "dependencies": { "zod": "^4.5.4" },
  "devDependencies": { "vitest": "^4.1.11" }
}
```
`packages/contract/tsconfig.json` and `vitest.config.ts`: identical to `@rch/domain`'s (Task 2 Step 1).

- [ ] **Step 2: Move the files**

```bash
git mv UI/src/types.ts packages/contract/src/types.ts
git mv UI/src/data/master.ts packages/contract/src/fixtures/master.ts
git mv UI/src/data/seed.ts packages/contract/src/fixtures/seed.ts
git mv UI/src/data/ops.ts packages/contract/src/fixtures/ops.ts
git mv UI/src/data/vendors.ts packages/contract/src/fixtures/vendors.ts
```
Then in each moved fixture file change `from "../types"` to `from "../types"` — the relative path is unchanged because `fixtures/` sits beside `types.ts` (verify: `packages/contract/src/fixtures/master.ts` imports `../types` → `packages/contract/src/types.ts`).

In `packages/contract/src/fixtures/master.ts`, **remove** the `homeLabel` function (it is UI presentation; it moves back to the UI in Step 4) and the two comment lines above it. Everything else stays verbatim, including `PATIENTS`, `STAFF`, `DEPTS` and the limits.

In `packages/contract/src/fixtures/vendors.ts`, **remove** `suggestVendor` and `vendorName` (helpers, not data); keep `seedVendors`.

`packages/contract/src/fixtures/index.ts`:
```ts
export * from "./master";
export * from "./seed";
export * from "./ops";
export * from "./vendors";
```

`packages/contract/src/index.ts` (schemas and routes are appended in Task 8):
```ts
export type * from "./types";
```

- [ ] **Step 3: A test that the fixtures are internally consistent**

`packages/contract/src/fixtures/fixtures.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { IT, LOC, MENU, PL, RCP, USERS, seedBills, seedPo, seedPrq, seedReq, seedStock, seedTkt } from "./index";

describe("fixtures", () => {
  it("every menu, recipe, price and stock line names a real item", () => {
    const items = new Set(Object.keys(IT));
    for (const keys of Object.values(MENU)) for (const k of keys) expect(items.has(k), k).toBe(true);
    for (const r of Object.values(RCP)) for (const [g] of r.l) expect(items.has(g), g).toBe(true);
    for (const list of Object.values(PL)) for (const k of Object.keys(list)) expect(items.has(k), k).toBe(true);
    for (const loc of Object.values(seedStock)) for (const k of Object.keys(loc)) expect(items.has(k), k).toBe(true);
  });
  it("every document line names a real item and every location is known", () => {
    const items = new Set(Object.keys(IT));
    const locs = new Set(Object.keys(LOC));
    for (const r of seedReq) { expect(locs.has(r.from)).toBe(true); for (const l of r.lines) expect(items.has(l.it)).toBe(true); }
    for (const t of seedTkt) { expect(locs.has(t.from) && locs.has(t.to)).toBe(true); for (const l of t.lines) expect(items.has(l.it)).toBe(true); }
    for (const p of seedPrq) for (const l of p.lines) expect(items.has(l.it)).toBe(true);
    for (const o of seedPo) for (const l of o.lines) expect(items.has(l.it)).toBe(true);
    for (const b of seedBills) { expect(locs.has(b.loc)).toBe(true); for (const l of b.lines) expect(items.has(l.it)).toBe(true); }
  });
  it("users are unique by id and employee number", () => {
    expect(new Set(USERS.map((u) => u.id)).size).toBe(USERS.length);
    expect(new Set(USERS.map((u) => u.emp)).size).toBe(USERS.length);
  });
});
```
Run: `pnpm --filter @rch/contract test` — Expected: PASS. (If a fixture inconsistency surfaces, fix the fixture; it is a real defect the seed would otherwise carry into the database.)

- [ ] **Step 4: Re-export shims in the UI**

`UI/package.json` — add `"@rch/contract": "workspace:*"` to `dependencies`.

`UI/src/types.ts`:
```ts
export type * from "@rch/contract";
```

`UI/src/data/master.ts`:
```ts
import type { User } from "../types";
import * as FX from "@rch/contract/fixtures";

// Registries. Mutable on purpose: the store can add a product, and hydrateMaster()
// replaces the contents with what the server returns. Screens import these directly,
// so they must keep their identity — assign into them, never reassign them.
export const LOC = { ...FX.LOC };
export const IT: Record<string, import("../types").Item> = { ...FX.IT };
export const RCP = { ...FX.RCP };
export const PL = { A: { ...FX.PL.A }, B: { ...FX.PL.B } };
export const MENU: Record<string, string[]> = Object.fromEntries(Object.entries(FX.MENU).map(([k, v]) => [k, [...v]]));
export const USERS: User[] = [...FX.USERS];
export const OUTLETS = [...FX.OUTLETS];
export const ALL_LOCS = [...FX.ALL_LOCS];
export const { PAR_FACTOR, PATIENTS, STAFF, DEPTS, STAFF_CREDIT_LIMIT, PO_APPROVAL_LIMIT, RATE_CONTRACT } = FX;

export type MasterData = {
  items: Record<string, import("../types").Item>;
  locations: typeof FX.LOC;
  recipes: typeof FX.RCP;
  prices: { A: Record<string, number>; B: Record<string, number> };
  menu: Record<string, string[]>;
  users: User[];
};

const replaceKeys = <T extends object>(target: T, next: T) => {
  for (const k of Object.keys(target)) delete (target as Record<string, unknown>)[k];
  Object.assign(target, next);
};

/** Replace every registry's contents with the server's master data (Task 16 calls this). */
export function hydrateMaster(m: MasterData): void {
  replaceKeys(IT, m.items);
  replaceKeys(LOC, m.locations);
  replaceKeys(RCP, m.recipes);
  replaceKeys(PL.A, m.prices.A);
  replaceKeys(PL.B, m.prices.B);
  replaceKeys(MENU, m.menu);
  USERS.splice(0, USERS.length, ...m.users);
}

/**
 * What to show as a person's "base" next to their role. A counter operator,
 * store keeper or kitchen in-charge genuinely works out of one place, so their
 * location is the useful thing to show. An outlet manager oversees every shop
 * at once and a procurement officer is not tied to a single counter either.
 */
export function homeLabel(u: User): string | null {
  if (u.r === "manager") return "All outlets";
  if (u.r === "buyer") return null;
  return LOC[u.loc].n;
}
```

`UI/src/data/seed.ts`:
```ts
export {
  DAY_LABELS, seedBatch, seedBills, seedGrn, seedPo, seedPord, seedPrq, seedReq, seedRsv, seedSales,
  seedStock, seedTkt,
} from "@rch/contract/fixtures";
```
`UI/src/data/ops.ts`:
```ts
export { seedContracts, seedProductRequests, seedShopAsks, seedTickets } from "@rch/contract/fixtures";
```
`UI/src/data/vendors.ts` — keep the two helpers, source the data:
```ts
import type { Vendor } from "../types";
export { seedVendors } from "@rch/contract/fixtures";

export const suggestVendor = (vendors: Vendor[], group: string): Vendor | null =>
  vendors.find((v) => v.active && v.groups.includes(group)) ?? null;

export const vendorName = (vendors: Vendor[], id: string): string =>
  vendors.find((v) => v.id === id)?.n ?? id;
```
(Copy the helper bodies from the file as it was before the move — the two shown here are what `git show HEAD:UI/src/data/vendors.ts` contains; keep them byte-identical.)

Run: `pnpm install && pnpm turbo typecheck lint test`
Expected: PASS everywhere. `knip` must not report `hydrateMaster` unused — add `"ignore": ["UI/src/data/master.ts"]`? No: it is used in Task 16; until then, add a one-line `// knip: used by Task 16 (api/wire.ts)` and an `ignoreExportsUsedInFile` is not the fix. Instead export it and reference it from `UI/src/api/wire.ts` created in Task 16 — so **defer running `knip` on this task** by temporarily excluding `UI` in `knip.json` `workspaces` and re-including it in Task 16.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Move the domain types and seed data into @rch/contract

The UI's type file and fixture tables become the shared contract the
API will build its schema and seed from; the UI keeps thin re-export
shims so none of its screens change.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 4: API skeleton — config, app, security, logging, errors, health, metrics

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/vitest.config.ts`, `apps/api/tsup.config.ts`, `apps/api/src/config.ts`, `apps/api/src/app.ts`, `apps/api/src/server.ts`, `apps/api/src/lib/errors.ts`, `apps/api/src/plugins/security.ts`, `apps/api/src/plugins/logging.ts`, `apps/api/src/plugins/errors.ts`, `apps/api/src/plugins/metrics.ts`, `apps/api/src/plugins/health.ts`, `apps/api/src/test/app.ts`, `docker-compose.yml`, `.env.example`
- Test: `apps/api/src/config.test.ts`, `apps/api/src/app.test.ts`

**Interfaces:**
- Produces:
  - `type Config` and `loadConfig(env: NodeJS.ProcessEnv): Config` (throws `ConfigError` listing every invalid variable)
  - `buildApp(config: Config, deps?: { db?: Db }): Promise<FastifyInstance>` — no `listen`
  - `class AppError extends Error { code: ErrorCode; status: number; details?: unknown }` with subclasses `ValidationError(400)`, `UnauthenticatedError(401)`, `ForbiddenError(403)`, `NotFoundError(404)`, `ConflictError(409)`, `RuleError(422)`, `RateLimitedError(429)`
  - `app.readiness: { setReady(ok: boolean): void }` decorator, used by `server.ts` during drain and by the DB plugin (Task 5)
  - `buildTestApp(overrides?: Partial<Config>): Promise<FastifyInstance>` in `src/test/app.ts`
- The DB is **not** wired in this task; `/readyz` returns 503 until Task 5 registers its check.

- [ ] **Step 1: Manifests and tooling**

`apps/api/package.json`:
```json
{
  "name": "@rch/api",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file=../../.env src/server.ts",
    "build": "tsup",
    "start": "node dist/server.mjs",
    "typecheck": "tsc --noEmit",
    "lint": "oxlint",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx --env-file=../../.env src/cli/migrate.ts",
    "db:seed": "tsx --env-file=../../.env src/cli/seed.ts",
    "db:rebuild-balances": "tsx --env-file=../../.env src/cli/rebuild-balances.ts",
    "users": "tsx --env-file=../../.env src/cli/users.ts",
    "keys:generate": "tsx src/cli/keys.ts"
  },
  "dependencies": {
    "@fastify/cookie": "^11.1.2",
    "@fastify/cors": "^11.3.0",
    "@fastify/helmet": "^13.1.1",
    "@fastify/jwt": "^10.2.2",
    "@fastify/rate-limit": "^11.2.0",
    "@fastify/sensible": "^6.0.5",
    "@fastify/under-pressure": "^9.1.0",
    "@node-rs/argon2": "^2.2.0",
    "@rch/contract": "workspace:*",
    "@rch/domain": "workspace:*",
    "drizzle-orm": "^0.45.2",
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
    "drizzle-kit": "^0.31.10",
    "tsup": "^8.5.1",
    "tsx": "^4.23.13",
    "vitest": "^4.1.11"
  }
}
```

`apps/api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023"], "types": ["node"], "module": "nodenext", "moduleResolution": "nodenext" },
  "include": ["src", "drizzle.config.ts", "tsup.config.ts", "vitest.config.ts"]
}
```
`apps/api/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    fileParallelism: true,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    setupFiles: ["./src/test/env.ts"],
  },
});
```
`apps/api/src/test/env.ts` — defaults so tests run with only Docker up:
```ts
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.TEST_DATABASE_URL ??= "postgres://rch:rch@localhost:5432/rch_test";
```
`apps/api/tsup.config.ts`:
```ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: { server: "src/server.ts", "cli/migrate": "src/cli/migrate.ts", "cli/seed": "src/cli/seed.ts", "cli/users": "src/cli/users.ts", "cli/rebuild-balances": "src/cli/rebuild-balances.ts" },
  format: ["esm"],
  target: "node24",
  outExtension: () => ({ js: ".mjs" }),
  sourcemap: true,
  clean: true,
  // Workspace packages are TypeScript source; bundle them. Everything else stays external.
  noExternal: [/^@rch\//],
});
```

`docker-compose.yml` (repo root):
```yaml
services:
  postgres:
    image: postgres:17
    container_name: rch-postgres
    environment:
      POSTGRES_USER: rch
      POSTGRES_PASSWORD: rch
      POSTGRES_DB: rch
    ports: ["5432:5432"]
    volumes:
      - rch-pg:/var/lib/postgresql/data
      - ./scripts/pg-init.sql:/docker-entrypoint-initdb.d/10-test-db.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U rch -d rch"]
      interval: 5s
      timeout: 3s
      retries: 10
volumes:
  rch-pg: {}
```
`scripts/pg-init.sql`:
```sql
CREATE DATABASE rch_test OWNER rch;
```

`.env.example`:
```bash
# apps/api — copy to .env at the repo root for local development
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
DATABASE_URL=postgres://rch:rch@localhost:5432/rch
TEST_DATABASE_URL=postgres://rch:rch@localhost:5432/rch_test
DATABASE_SSL=false                 # true on RDS (verify-full with the bundled CA)
CORS_ORIGIN=http://localhost:5173
# Ed25519 key pair, PEM, base64-encoded so newlines survive env files. Generate: pnpm --filter @rch/api keys:generate
JWT_PRIVATE_KEY=
JWT_PUBLIC_KEY=
JWT_PREVIOUS_PUBLIC_KEY=           # optional, accepted for 24h after a rotation
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=30
COOKIE_SECURE=false                # true everywhere but local http
SEED_PASSWORD=changeme
SEED_FORCE_PASSWORD_CHANGE=false   # true in staging/prod seeds
RATE_LIMIT_PER_MINUTE=300
LOGIN_RATE_LIMIT_PER_MINUTE=10
```

- [ ] **Step 2: Failing tests — config and the app's plumbing**

`apps/api/src/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

const good = {
  NODE_ENV: "test", PORT: "3000", DATABASE_URL: "postgres://u:p@h:5432/d",
  JWT_PRIVATE_KEY: "eA==", JWT_PUBLIC_KEY: "eA==", CORS_ORIGIN: "http://localhost:5173",
};

describe("loadConfig", () => {
  it("parses a complete environment with defaults applied", () => {
    const c = loadConfig(good);
    expect(c.port).toBe(3000);
    expect(c.accessTokenTtl).toBe("15m");
    expect(c.refreshTokenTtlDays).toBe(30);
    expect(c.rateLimitPerMinute).toBe(300);
    expect(c.corsOrigins).toEqual(["http://localhost:5173"]);
  });
  it("names every missing or malformed variable at once", () => {
    const bad = { ...good, DATABASE_URL: "not-a-url", JWT_PUBLIC_KEY: undefined, PORT: "abc" };
    expect(() => loadConfig(bad)).toThrow(ConfigError);
    try { loadConfig(bad); } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).toContain("DATABASE_URL");
      expect(msg).toContain("JWT_PUBLIC_KEY");
      expect(msg).toContain("PORT");
    }
  });
  it("splits a comma-separated CORS list", () => {
    expect(loadConfig({ ...good, CORS_ORIGIN: "https://a.example, https://b.example" }).corsOrigins)
      .toEqual(["https://a.example", "https://b.example"]);
  });
});
```

`apps/api/src/app.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./test/app";

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp({ withDb: false }); });
afterAll(async () => { await app.close(); });

describe("plumbing", () => {
  it("answers liveness immediately", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });
  it("is not ready without a database check registered", async () => {
    const r = await app.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("not_ready");
  });
  it("returns the error envelope for an unknown route", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: { code: "not_found", message: "There is nothing at GET /api/v1/nope." } });
  });
  it("echoes a request id and generates one when absent", async () => {
    const a = await app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "abc-123" } });
    expect(a.headers["x-request-id"]).toBe("abc-123");
    const b = await app.inject({ method: "GET", url: "/healthz" });
    expect(String(b.headers["x-request-id"])).toMatch(/^[0-9a-f-]{36}$/);
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
```

Run: `pnpm --filter @rch/api test` — Expected: FAIL (modules missing).

- [ ] **Step 3: Implement config and errors**

`apps/api/src/config.ts`:
```ts
import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(1, 65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.url().startsWith("postgres"),
  TEST_DATABASE_URL: z.url().startsWith("postgres").optional(),
  DATABASE_SSL: bool.default("false"),
  CORS_ORIGIN: z.string().min(1),
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  JWT_PREVIOUS_PUBLIC_KEY: z.string().optional(),
  ACCESS_TOKEN_TTL: z.string().regex(/^\d+[smhd]$/).default("15m"),
  REFRESH_TOKEN_TTL_DAYS: int(1, 365).default(30),
  COOKIE_SECURE: bool.default("true"),
  SEED_PASSWORD: z.string().min(8).default("changeme"),
  SEED_FORCE_PASSWORD_CHANGE: bool.default("true"),
  RATE_LIMIT_PER_MINUTE: int(10, 100_000).default(300),
  LOGIN_RATE_LIMIT_PER_MINUTE: int(1, 1000).default(10),
});

export class ConfigError extends Error {}

export type Config = Readonly<{
  env: "development" | "test" | "production";
  port: number;
  logLevel: z.infer<typeof Env>["LOG_LEVEL"];
  databaseUrl: string;
  testDatabaseUrl?: string;
  databaseSsl: boolean;
  corsOrigins: string[];
  jwt: { privateKeyPem: string; publicKeyPem: string; previousPublicKeyPem?: string };
  accessTokenTtl: string;
  refreshTokenTtlDays: number;
  cookieSecure: boolean;
  seedPassword: string;
  seedForcePasswordChange: boolean;
  rateLimitPerMinute: number;
  loginRateLimitPerMinute: number;
}>;

const pem = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

export function loadConfig(env: NodeJS.ProcessEnv): Config {
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
    databaseUrl: e.DATABASE_URL,
    testDatabaseUrl: e.TEST_DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    corsOrigins: e.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
    jwt: {
      privateKeyPem: pem(e.JWT_PRIVATE_KEY),
      publicKeyPem: pem(e.JWT_PUBLIC_KEY),
      previousPublicKeyPem: e.JWT_PREVIOUS_PUBLIC_KEY ? pem(e.JWT_PREVIOUS_PUBLIC_KEY) : undefined,
    },
    accessTokenTtl: e.ACCESS_TOKEN_TTL,
    refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    cookieSecure: e.COOKIE_SECURE,
    seedPassword: e.SEED_PASSWORD,
    seedForcePasswordChange: e.SEED_FORCE_PASSWORD_CHANGE,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    loginRateLimitPerMinute: e.LOGIN_RATE_LIMIT_PER_MINUTE,
  });
}
```

`apps/api/src/lib/errors.ts`:
```ts
export type ErrorCode =
  | "validation" | "unauthenticated" | "forbidden" | "not_found" | "conflict"
  | "rule" | "rate_limited" | "not_ready" | "internal";

export class AppError extends Error {
  constructor(public readonly code: ErrorCode, public readonly status: number, message: string, public readonly details?: unknown) {
    super(message);
    this.name = new.target.name;
  }
  toEnvelope() {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
  }
}
export class ValidationError extends AppError { constructor(message: string, details?: unknown) { super("validation", 400, message, details); } }
export class UnauthenticatedError extends AppError { constructor(message = "Sign in to continue.") { super("unauthenticated", 401, message); } }
export class ForbiddenError extends AppError { constructor(message: string) { super("forbidden", 403, message); } }
export class NotFoundError extends AppError { constructor(message: string) { super("not_found", 404, message); } }
export class ConflictError extends AppError { constructor(message: string, details?: unknown) { super("conflict", 409, message, details); } }
/** A domain rule refused the action. The message is what the operator reads. */
export class RuleError extends AppError { constructor(message: string, details?: unknown) { super("rule", 422, message, details); } }
export class RateLimitedError extends AppError { constructor(message = "Too many requests — wait a moment and try again.") { super("rate_limited", 429, message); } }
export class NotReadyError extends AppError { constructor(message: string) { super("not_ready", 503, message); } }
```

- [ ] **Step 4: Implement the plugins**

`apps/api/src/plugins/logging.ts`:
```ts
import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";

/** Request id in, request id out; user id on every access line once auth has run. */
export default fp(async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });
  app.addHook("onResponse", async (req, reply) => {
    req.log.info({
      route: req.routeOptions?.url ?? req.url, method: req.method, status: reply.statusCode,
      ms: Math.round(reply.elapsedTime), user: (req as { user?: { sub?: string } }).user?.sub,
    }, "request");
  });
}, { name: "logging" });

export const loggerOptions = (level: string) => ({
  level,
  redact: { paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"], censor: "[redacted]" },
  serializers: { req: (r: { method: string; url: string }) => ({ method: r.method, url: r.url }) },
});
export const genReqId = (req: { headers: Record<string, string | string[] | undefined> }) => {
  const h = req.headers["x-request-id"];
  const v = Array.isArray(h) ? h[0] : h;
  return v && /^[\w.-]{1,128}$/.test(v) ? v : randomUUID();
};
```

`apps/api/src/plugins/security.ts`:
```ts
import fp from "fastify-plugin";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import underPressure from "@fastify/under-pressure";
import sensible from "@fastify/sensible";
import type { Config } from "../config";
import { RateLimitedError } from "../lib/errors";

export default fp<{ config: Config }>(async (app, { config }) => {
  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: false }); // the API serves JSON; CSP belongs to the UI's nginx
  await app.register(cors, { origin: config.corsOrigins, credentials: true, exposedHeaders: ["x-request-id"] });
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitPerMinute,
    timeWindow: "1 minute",
    keyGenerator: (req) => (req as { user?: { sub?: string } }).user?.sub ?? req.ip,
    errorResponseBuilder: () => new RateLimitedError().toEnvelope(),
  });
  await app.register(underPressure, {
    maxEventLoopDelay: 1000,
    maxHeapUsedBytes: 0,
    maxRssBytes: 0,
    message: "The service is overloaded — try again shortly.",
    retryAfter: 5,
    customError: class extends Error {},
  });
}, { name: "security" });
```

`apps/api/src/plugins/errors.ts`:
```ts
import fp from "fastify-plugin";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";

export default fp(async (app) => {
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(new NotFoundError(`There is nothing at ${req.method} ${req.url}.`).toEnvelope());
  });
  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const details = err.validation.map((v) => ({ path: v.instancePath || "/", message: v.message }));
      return reply.code(400).send(new ValidationError("The request did not match what this endpoint expects.", details).toEnvelope());
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err, issues: err.cause.issues }, "response failed its schema");
      return reply.code(500).send({ error: { code: "internal", message: `Something went wrong on our side. Reference ${req.id}.` } });
    }
    if (err instanceof AppError) {
      return reply.code(err.status).send(err.toEnvelope());
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.code(429).send({ error: { code: "rate_limited", message: "Too many requests — wait a moment and try again." } });
    if (status === 503) return reply.code(503).send({ error: { code: "not_ready", message: (err as Error).message } });
    if (status === 401) return reply.code(401).send({ error: { code: "unauthenticated", message: "Sign in to continue." } });
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: { code: "validation", message: (err as Error).message } });
    req.log.error({ err }, "unhandled");
    return reply.code(500).send({ error: { code: "internal", message: `Something went wrong on our side. Reference ${req.id}.` } });
  });
}, { name: "errors" });
```

`apps/api/src/plugins/metrics.ts`:
```ts
import fp from "fastify-plugin";
import { Registry, collectDefaultMetrics, Histogram, Gauge } from "prom-client";

declare module "fastify" {
  interface FastifyInstance { metrics: { registry: Registry; sseClients: Gauge } }
}

export default fp(async (app) => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const duration = new Histogram({
    name: "http_request_duration_seconds", help: "Request duration by route and status",
    labelNames: ["method", "route", "status"], buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry],
  });
  const sseClients = new Gauge({ name: "sse_clients", help: "Open /events streams", registers: [registry] });
  app.decorate("metrics", { registry, sseClients });
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? "unmatched";
    if (route === "/metrics") return;
    duration.labels(req.method, route, String(reply.statusCode)).observe(reply.elapsedTime / 1000);
  });
  app.get("/metrics", { config: { rateLimit: false } }, async (_req, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
}, { name: "metrics" });
```

`apps/api/src/plugins/health.ts`:
```ts
import fp from "fastify-plugin";
import { NotReadyError } from "../lib/errors";

type Check = () => Promise<void>;
declare module "fastify" {
  interface FastifyInstance {
    readiness: { addCheck(name: string, check: Check): void; setDraining(): void };
  }
}

/** /healthz says the process is up. /readyz says it may receive traffic: every registered
 *  check passes and we are not draining. Task 5 registers the database check. */
export default fp(async (app) => {
  const checks = new Map<string, Check>();
  let draining = false;
  app.decorate("readiness", {
    addCheck: (name: string, check: Check) => { checks.set(name, check); },
    setDraining: () => { draining = true; },
  });
  app.get("/healthz", { config: { rateLimit: false } }, async () => ({ ok: true }));
  app.get("/readyz", { config: { rateLimit: false } }, async (_req, reply) => {
    if (draining) { reply.code(503); return new NotReadyError("Shutting down.").toEnvelope(); }
    if (checks.size === 0) { reply.code(503); return new NotReadyError("No readiness checks registered.").toEnvelope(); }
    const failed: string[] = [];
    for (const [name, check] of checks) { try { await check(); } catch { failed.push(name); } }
    if (failed.length) { reply.code(503); return new NotReadyError(`Not ready: ${failed.join(", ")}.`).toEnvelope(); }
    return { ok: true };
  });
}, { name: "health" });
```

- [ ] **Step 5: `buildApp`, `server.ts`, test harness**

`apps/api/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { Config } from "./config";
import logging, { genReqId, loggerOptions } from "./plugins/logging";
import security from "./plugins/security";
import errors from "./plugins/errors";
import metrics from "./plugins/metrics";
import health from "./plugins/health";

export type App = FastifyInstance;

export async function buildApp(config: Config): Promise<App> {
  const app = Fastify({
    logger: loggerOptions(config.logLevel),
    genReqId,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    forceCloseConnections: "idle",
    disableRequestLogging: true, // the logging plugin writes one structured line per request instead
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(logging);
  await app.register(errors);
  await app.register(metrics);
  await app.register(health);
  await app.register(security, { config });
  // Task 5 adds the database plugin here; Task 8 adds the route mount.
  return app;
}
```

`apps/api/src/server.ts`:
```ts
import { buildApp } from "./app";
import { ConfigError, loadConfig } from "./config";

async function main() {
  let config;
  try { config = loadConfig(process.env); }
  catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(2); } throw e; }

  const app = await buildApp(config);
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "draining");
    app.readiness.setDraining();
    // Give the load balancer one probe interval to notice /readyz is 503 before we stop accepting.
    await new Promise((r) => setTimeout(r, config.env === "production" ? 5000 : 0));
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
```

`apps/api/src/test/app.ts`:
```ts
import { generateKeyPairSync } from "node:crypto";
import { buildApp, type App } from "../app";
import { loadConfig, type Config } from "../config";

const keys = generateKeyPairSync("ed25519");
const b64 = (pem: string) => Buffer.from(pem).toString("base64");
const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test", PORT: "0", LOG_LEVEL: "silent",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5432/rch_test",
  CORS_ORIGIN: "http://localhost:5173",
  JWT_PRIVATE_KEY: b64(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
  JWT_PUBLIC_KEY: b64(keys.publicKey.export({ type: "spki", format: "pem" }).toString()),
  COOKIE_SECURE: "false", SEED_FORCE_PASSWORD_CHANGE: "false",
};

export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({ ...TEST_ENV, ...overrides });
}

/** `withDb: false` builds the app without a database (Task 4 tests). Task 5 adds the `withDb` path. */
export async function buildTestApp(opts: { withDb?: boolean; env?: Partial<NodeJS.ProcessEnv> } = {}): Promise<App> {
  const config = testConfig(opts.env);
  const app = await buildApp(config);
  return app;
}
```

Run: `pnpm install && pnpm --filter @rch/api test`
Expected: PASS — `config.test.ts` (3) and `app.test.ts` (6).

Run: `pnpm --filter @rch/api typecheck && pnpm --filter @rch/api lint`
Expected: clean.

Run (manual smoke): `cp .env.example .env`, fill the two JWT keys with any base64 (e.g. `echo -n x | base64`), `pnpm --filter @rch/api dev` → `curl -i localhost:3000/healthz` → 200 `{"ok":true}`; `curl -i localhost:3000/readyz` → 503 envelope; Ctrl-C exits 0 promptly.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Stand up the Fastify API with its production plumbing

Validated config, request ids, structured logging, the error envelope,
security headers and rate limits, Prometheus metrics and liveness /
readiness probes — all before the first business route, so every later
module inherits them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 5: Database — Drizzle schema for every table, first migration, client, readiness check, test harness

**Files:**
- Create: `apps/api/drizzle.config.ts`, `apps/api/src/db/client.ts`, `apps/api/src/db/migrate.ts`, `apps/api/src/db/schema/index.ts`, `apps/api/src/db/schema/enums.ts`, `apps/api/src/db/schema/master.ts`, `apps/api/src/db/schema/ledger.ts`, `apps/api/src/db/schema/movement.ts`, `apps/api/src/db/schema/production.ts`, `apps/api/src/db/schema/buying.ts`, `apps/api/src/db/schema/sales.ts`, `apps/api/src/db/schema/ops.ts`, `apps/api/src/db/schema/infra.ts`, `apps/api/src/plugins/db.ts`, `apps/api/src/cli/migrate.ts`, `apps/api/src/test/db.ts`, `apps/api/drizzle/0000_*.sql` + `apps/api/drizzle/meta/*` (generated)
- Modify: `apps/api/src/app.ts` (register db plugin), `apps/api/src/test/app.ts` (`withDb`)
- Test: `apps/api/src/db/schema.test.ts`

**Interfaces:**
- Produces:
  - `type Db = NodePgDatabase<typeof schema>`; `createDb(url: string, ssl: boolean): { db: Db; pool: Pool }`
  - `runMigrations(db: Db): Promise<void>`; `expectedMigrationCount(): number` (reads `drizzle/meta/_journal.json`)
  - `app.db: Db` decorator (plugin `db`), readiness check `"database"` registered
  - Test harness: `withTestSchema(name): Promise<{ db: Db; url: string; close(): Promise<void> }>` — creates schema `t_<name>`, sets `search_path`, migrates; `truncateAll(db)`
  - `buildTestApp({ withDb: true, schema: "<file-name>" })` returns an app bound to that schema
- Column naming: snake_case, full words. Table exports are camelCase (`stockRequests`, `stockRequestLines`, …).

- [ ] **Step 1: drizzle-kit config, client, migrate**

`apps/api/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://rch:rch@localhost:5432/rch" },
  strict: true,
  verbose: true,
});
```
`apps/api/src/db/client.ts`:
```ts
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

/** One pool per process. RDS connections verify the AWS CA bundle baked into the image (Task 15). */
export function createDb(url: string, ssl: boolean, opts: { max?: number; searchPath?: string } = {}): { db: Db; pool: Pool } {
  const pool = new Pool({
    connectionString: url,
    max: opts.max ?? 10,
    ssl: ssl ? { rejectUnauthorized: true, ca: readFileSync(process.env.PG_CA_BUNDLE ?? "/etc/ssl/rds-global-bundle.pem", "utf8") } : undefined,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 30_000,
    options: opts.searchPath ? `-c search_path=${opts.searchPath}` : undefined,
  });
  return { db: drizzle({ client: pool, schema }), pool };
}
```
`apps/api/src/db/migrate.ts`:
```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./client";

// Works from src (tsx) and from dist/*.mjs (tsup): both are one level below apps/api… no —
// src/db/ is two levels down, dist/ is one. Walk up until a drizzle/ folder appears.
export function migrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    try { readFileSync(join(dir, "drizzle", "meta", "_journal.json")); return join(dir, "drizzle"); } catch { dir = dirname(dir); }
  }
  throw new Error("drizzle/ migrations folder not found");
}
export function expectedMigrationCount(): number {
  const j = JSON.parse(readFileSync(join(migrationsFolder(), "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
  return j.entries.length;
}
export async function runMigrations(db: Db, schemaName?: string): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder(), migrationsSchema: schemaName ?? "drizzle" });
}
/** How many migrations this database has applied — compared with the journal by /readyz. */
export async function appliedMigrationCount(db: Db, schemaName = "drizzle"): Promise<number> {
  const r = await db.execute(sql.raw(`select count(*)::int as n from "${schemaName}"."__drizzle_migrations"`));
  return Number((r.rows[0] as { n: number }).n);
}
```
`apps/api/src/cli/migrate.ts`:
```ts
import { loadConfig } from "../config";
import { createDb } from "../db/client";
import { appliedMigrationCount, expectedMigrationCount, runMigrations } from "../db/migrate";

const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1 });
await runMigrations(db);
console.log(`migrations applied: ${await appliedMigrationCount(db)} / ${expectedMigrationCount()}`);
await pool.end();
```

- [ ] **Step 2: The schema — enums and master**

`apps/api/src/db/schema/enums.ts`:
```ts
import { pgEnum } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["counter", "manager", "store", "prod", "buyer"]);
export const locationTypeEnum = pgEnum("location_type", ["Store", "Kitchen", "Outlet"]);
export const priceListEnum = pgEnum("price_list", ["A", "B"]);
export const itemTypeEnum = pgEnum("item_type", ["RAW", "PACK", "MRP", "FG", "MTO"]);
export const moveKindEnum = pgEnum("move_kind", [
  "opening", "sale", "ticket_out", "ticket_in", "production_consume", "production_yield",
  "grn_accept", "grn_reject", "adjustment", "reversal",
]);
export const reqStatusEnum = pgEnum("req_status", [
  "Draft", "Request sent", "Manager approved", "Partially approved", "Ticket issued",
  "Collected", "Received", "Closed", "Rejected", "Cancelled",
]);
export const ticketStatusEnum = pgEnum("ticket_status", ["Issued", "Collected", "Received"]);
export const ticketRefEnum = pgEnum("ticket_ref", ["request", "prod_order", "direct", "shop_transfer", "shop_ask"]);
export const shopAskStatusEnum = pgEnum("shop_ask_status", ["Asked", "Sent", "Declined"]);
export const prodOrderStatusEnum = pgEnum("prod_order_status", ["New", "Accepted", "In kitchen", "Ready", "Dispatched", "Declined"]);
export const prqStatusEnum = pgEnum("prq_status", ["Sent", "Approved", "Partially approved", "Declined"]);
export const poStatusEnum = pgEnum("po_status", ["Draft", "Ordered", "Partially received", "Received", "Cancelled"]);
export const payerKindEnum = pgEnum("payer_kind", ["patient", "staff", "dept"]);
export const supportTopicEnum = pgEnum("support_topic", [
  "Sign in & access", "A screen will not load", "A number looks wrong", "Printing & receipts",
  "Slow or freezing", "Training & how do I", "Feature request", "Something else",
]);
export const supportPriorityEnum = pgEnum("support_priority", ["Low", "Normal", "Urgent"]);
export const supportStatusEnum = pgEnum("support_status", ["Open", "With support", "Waiting on you", "Resolved", "Closed"]);
export const messageFromEnum = pgEnum("message_from", ["user", "support"]);
export const productReqStatusEnum = pgEnum("product_req_status", ["Requested", "Created", "Declined"]);
```

`apps/api/src/db/schema/master.ts`:
```ts
import { boolean, date, integer, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { itemTypeEnum, locationTypeEnum, priceListEnum, roleEnum } from "./enums";

const qty = (name: string) => numeric(name, { precision: 12, scale: 3, mode: "number" });
const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export { qty, money, ts };

export const locations = pgTable("locations", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  type: locationTypeEnum("type").notNull(),
  floor: text("floor").notNull(),
  costCentre: text("cost_centre").notNull(),
  priceList: priceListEnum("price_list"),
  sellable: boolean("sellable").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  role: roleEnum("role").notNull(),
  roleLabel: text("role_label").notNull(),
  loc: text("loc").notNull().references(() => locations.key),
  colour: text("colour").notNull(),
  empNo: text("emp_no").notNull(),
  phone: text("phone").notNull(),
  passwordHash: text("password_hash").notNull(),
  mustChangePassword: boolean("must_change_password").notNull().default(true),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("users_emp_no_uq").on(t.empNo)]);

export const items = pgTable("items", {
  key: text("key").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  unit: text("unit").notNull(),
  type: itemTypeEnum("type").notNull(),
  grp: text("grp").notNull(),
  hsn: text("hsn").notNull(),
  gst: numeric("gst", { precision: 5, scale: 2, mode: "number" }).notNull(),
  reorderLevel: qty("reorder_level").notNull().default(0),
  cost: money("cost").notNull().default(0),
  mrp: money("mrp"),
  shelfLifeHours: integer("shelf_life_hours"),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("items_name_ci_uq").on(sql`lower(${t.name})`)]);

export const recipes = pgTable("recipes", {
  itemKey: text("item_key").primaryKey().references(() => items.key),
  overheadPct: numeric("overhead_pct", { precision: 5, scale: 2, mode: "number" }).notNull(),
});
export const recipeLines = pgTable("recipe_lines", {
  itemKey: text("item_key").notNull().references(() => recipes.itemKey),
  ingredientKey: text("ingredient_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  seq: integer("seq").notNull(),
}, (t) => [primaryKey({ columns: [t.itemKey, t.ingredientKey] })]);

export const locationItems = pgTable("location_items", {
  loc: text("loc").notNull().references(() => locations.key),
  itemKey: text("item_key").notNull().references(() => items.key),
  seq: integer("seq").notNull(),
}, (t) => [primaryKey({ columns: [t.loc, t.itemKey] })]);

export const priceListItems = pgTable("price_list_items", {
  list: priceListEnum("list").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  price: money("price").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.list, t.itemKey] })]);

export const vendors = pgTable("vendors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  gstin: text("gstin").notNull().default(""),
  contact: text("contact").notNull().default(""),
  phone: text("phone").notNull().default(""),
  terms: text("terms").notNull().default(""),
  leadDays: integer("lead_days").notNull().default(0),
  groups: text("groups").array().notNull().default(sql`'{}'::text[]`),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("vendors_name_ci_uq").on(sql`lower(${t.name})`)]);

export const rateContracts = pgTable("rate_contracts", {
  id: text("id").primaryKey(),
  vendorId: text("vendor_id").notNull().references(() => vendors.id),
  itemKey: text("item_key").notNull().references(() => items.key),
  rate: money("rate").notNull(),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to").notNull(),
  moq: qty("moq").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
```

- [ ] **Step 3: Ledger, movement, production**

`apps/api/src/db/schema/ledger.ts`:
```ts
import { bigint, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { moveKindEnum } from "./enums";
import { items, locations, qty, ts, users } from "./master";

/** Append-only. The only source of truth for quantity. Never updated, never deleted. */
export const stockMoves = pgTable("stock_moves", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  at: ts("at").notNull().defaultNow(),
  loc: text("loc").notNull().references(() => locations.key),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),             // signed
  kind: moveKindEnum("kind").notNull(),
  refType: text("ref_type").notNull(),
  refId: text("ref_id").notNull(),
  byUser: text("by_user").references(() => users.id),
  reversesId: bigint("reverses_id", { mode: "number" }),
}, (t) => [index("stock_moves_loc_item_at_idx").on(t.loc, t.itemKey, t.at), index("stock_moves_ref_idx").on(t.refType, t.refId)]);

/** Cache of Σ moves per (loc, item). Maintained by postMoves(); rebuildable by db:rebuild-balances. */
export const stockBalances = pgTable("stock_balances", {
  loc: text("loc").notNull().references(() => locations.key),
  itemKey: text("item_key").notNull().references(() => items.key),
  onHand: qty("on_hand").notNull().default(0),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.loc, t.itemKey] })]);

export const reservations = pgTable("reservations", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  loc: text("loc").notNull().references(() => locations.key),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  ticketId: text("ticket_id").notNull(),   // FK added in movement.ts via relation; kept text to avoid an import cycle
  createdAt: ts("created_at").notNull().defaultNow(),
  releasedAt: ts("released_at"),
}, (t) => [index("reservations_open_idx").on(t.loc, t.itemKey).where(sqlOpen())]);

import { sql } from "drizzle-orm";
function sqlOpen() { return sql`released_at is null`; }

export const availabilityOverrides = pgTable("availability_overrides", {
  loc: text("loc").notNull().references(() => locations.key),
  itemKey: text("item_key").notNull().references(() => items.key),
  reason: text("reason").notNull(),
  byUser: text("by_user").references(() => users.id),
  at: ts("at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.loc, t.itemKey] })]);
```
(Put the `import { sql }` at the top of the file when you write it; it is shown inline here only to explain the partial index.)

`apps/api/src/db/schema/movement.ts`:
```ts
import { boolean, char, index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { reqStatusEnum, shopAskStatusEnum, ticketRefEnum, ticketStatusEnum } from "./enums";
import { items, locations, qty, ts, users } from "./master";

export const stockRequests = pgTable("stock_requests", {
  id: text("id").primaryKey(),
  fromLoc: text("from_loc").notNull().references(() => locations.key),
  byUser: text("by_user").notNull().references(() => users.id),
  at: ts("at").notNull().defaultNow(),
  status: reqStatusEnum("status").notNull(),
  ticketId: text("ticket_id"),
  managerNote: text("manager_note").notNull().default(""),
  urgent: boolean("urgent").notNull().default(false),
  approvedBy: text("approved_by").references(() => users.id),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("stock_requests_status_idx").on(t.status), index("stock_requests_from_idx").on(t.fromLoc)]);

export const stockRequestLines = pgTable("stock_request_lines", {
  requestId: text("request_id").notNull().references(() => stockRequests.id),
  lineNo: integer("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  approvedQty: qty("approved_qty").notNull().default(0),
  shortQty: qty("short_qty"),
}, (t) => [primaryKey({ columns: [t.requestId, t.lineNo] })]);

export const tickets = pgTable("tickets", {
  id: text("id").primaryKey(),
  refType: ticketRefEnum("ref_type").notNull(),
  refId: text("ref_id").notNull(),        // request id, prod order id, shop ask id, or the label "Direct issue"/"Shop transfer"
  fromLoc: text("from_loc").notNull().references(() => locations.key),
  toLoc: text("to_loc").notNull().references(() => locations.key),
  status: ticketStatusEnum("status").notNull(),
  otp: char("otp", { length: 6 }).notNull(),
  issuedBy: text("issued_by").references(() => users.id),
  issuedAt: ts("issued_at").notNull().defaultNow(),
  collectedAt: ts("collected_at"),
  receivedAt: ts("received_at"),
}, (t) => [index("tickets_status_idx").on(t.status), index("tickets_to_idx").on(t.toLoc)]);

export const ticketLines = pgTable("ticket_lines", {
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  lineNo: integer("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
}, (t) => [primaryKey({ columns: [t.ticketId, t.lineNo] })]);

export const shopAsks = pgTable("shop_asks", {
  id: text("id").primaryKey(),
  fromLoc: text("from_loc").notNull().references(() => locations.key),
  toLoc: text("to_loc").notNull().references(() => locations.key),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  status: shopAskStatusEnum("status").notNull(),
  byUser: text("by_user").notNull().references(() => users.id),
  at: ts("at").notNull().defaultNow(),
  note: text("note").notNull().default(""),
  grantedQty: qty("granted_qty"),
  ticketId: text("ticket_id").references(() => tickets.id),
  reason: text("reason"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
```

`apps/api/src/db/schema/production.ts`:
```ts
import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { prodOrderStatusEnum } from "./enums";
import { items, locations, qty, ts, users } from "./master";

export const prodOrders = pgTable("prod_orders", {
  id: text("id").primaryKey(),
  fromLoc: text("from_loc").notNull().references(() => locations.key),
  byUser: text("by_user").notNull().references(() => users.id),
  at: ts("at").notNull().defaultNow(),
  status: prodOrderStatusEnum("status").notNull(),
  note: text("note").notNull().default(""),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export const prodOrderLines = pgTable("prod_order_lines", {
  orderId: text("order_id").notNull().references(() => prodOrders.id),
  lineNo: integer("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
}, (t) => [primaryKey({ columns: [t.orderId, t.lineNo] })]);
export const batches = pgTable("batches", {
  id: text("id").primaryKey(),
  itemKey: text("item_key").notNull().references(() => items.key),
  startedQty: qty("started_qty").notNull(),
  madeQty: qty("made_qty").notNull(),
  at: ts("at").notNull().defaultNow(),
  bestBefore: ts("best_before").notNull(),
  note: text("note"),
  byUser: text("by_user").references(() => users.id),
});
```

- [ ] **Step 4: Buying, sales, ops, infra**

`apps/api/src/db/schema/buying.ts`:
```ts
import { boolean, date, index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { poStatusEnum, prqStatusEnum } from "./enums";
import { items, money, qty, ts, users, vendors } from "./master";

export const requisitions = pgTable("requisitions", {
  id: text("id").primaryKey(),
  byUser: text("by_user").notNull().references(() => users.id),
  at: ts("at").notNull().defaultNow(),
  status: prqStatusEnum("status").notNull(),
  note: text("note").notNull().default(""),
  approvedBy: text("approved_by").references(() => users.id),
  approvalNote: text("approval_note"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export const requisitionLines = pgTable("requisition_lines", {
  requisitionId: text("requisition_id").notNull().references(() => requisitions.id),
  lineNo: integer("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  approvedQty: qty("approved_qty").notNull().default(0),
  orderedQty: qty("ordered_qty").notNull().default(0),
  shortQty: qty("short_qty"),
}, (t) => [primaryKey({ columns: [t.requisitionId, t.lineNo] })]);

export const purchaseOrders = pgTable("purchase_orders", {
  id: text("id").primaryKey(),
  vendorId: text("vendor_id").notNull().references(() => vendors.id),
  at: ts("at").notNull().defaultNow(),
  status: poStatusEnum("status").notNull(),
  eta: date("eta"),
  needsApproval: boolean("needs_approval").notNull().default(false),
  shortNote: text("short_note"),
  receivedAt: ts("received_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("purchase_orders_status_idx").on(t.status)]);
export const poLines = pgTable("po_lines", {
  poId: text("po_id").notNull().references(() => purchaseOrders.id),
  lineNo: integer("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  rate: money("rate").notNull(),
  receivedQty: qty("received_qty").notNull().default(0),
  rejectedQty: qty("rejected_qty").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.poId, t.lineNo] })]);
export const poLineSources = pgTable("po_line_sources", {
  poId: text("po_id").notNull().references(() => purchaseOrders.id),
  lineNo: integer("line_no").notNull(),
  seq: integer("seq").notNull(),
  requisitionId: text("requisition_id").notNull().references(() => requisitions.id),
  requisitionLineNo: integer("requisition_line_no").notNull(),
  qty: qty("qty").notNull(),
}, (t) => [primaryKey({ columns: [t.poId, t.lineNo, t.seq] })]);

export const grns = pgTable("grns", {
  id: text("id").primaryKey(),
  poId: text("po_id").notNull().references(() => purchaseOrders.id),
  poLineNo: integer("po_line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  acceptedQty: qty("accepted_qty").notNull(),
  rejectedQty: qty("rejected_qty").notNull().default(0),
  batchNo: text("batch_no").notNull(),
  mrp: money("mrp").notNull().default(0),
  mfg: date("mfg").notNull(),
  exp: date("exp").notNull(),
  dcNo: text("dc_no").notNull(),
  invoiceNo: text("invoice_no").notNull().default(""),
  invoiceDate: date("invoice_date"),
  at: ts("at").notNull().defaultNow(),
  byUser: text("by_user").references(() => users.id),
}, (t) => [index("grns_po_idx").on(t.poId)]);
```

`apps/api/src/db/schema/sales.ts`:
```ts
import { index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { payerKindEnum } from "./enums";
import { items, locations, money, qty, ts, users } from "./master";

export const bills = pgTable("bills", {
  no: text("no").primaryKey(),
  loc: text("loc").notNull().references(() => locations.key),
  operatorId: text("operator_id").notNull().references(() => users.id),
  total: money("total").notNull(),
  tax: money("tax").notNull(),
  at: ts("at").notNull().defaultNow(),
  tender: text("tender").notNull(),
  payerKind: payerKindEnum("payer_kind"),
  payerId: text("payer_id"),
  payerName: text("payer_name"),
}, (t) => [index("bills_loc_at_idx").on(t.loc, t.at)]);
export const billLines = pgTable("bill_lines", {
  billNo: text("bill_no").notNull().references(() => bills.no),
  lineNo: integer("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  rate: money("rate").notNull(),
}, (t) => [primaryKey({ columns: [t.billNo, t.lineNo] })]);
```

`apps/api/src/db/schema/ops.ts`:
```ts
import { pgTable, smallint, text } from "drizzle-orm/pg-core";
import { messageFromEnum, productReqStatusEnum, roleEnum, supportPriorityEnum, supportStatusEnum, supportTopicEnum } from "./enums";
import { items, locations, ts, users } from "./master";

export const supportTickets = pgTable("support_tickets", {
  id: text("id").primaryKey(),
  topic: supportTopicEnum("topic").notNull(),
  subject: text("subject").notNull(),
  priority: supportPriorityEnum("priority").notNull(),
  status: supportStatusEnum("status").notNull(),
  byUser: text("by_user").notNull().references(() => users.id),
  role: roleEnum("role").notNull(),
  loc: text("loc").notNull().references(() => locations.key),
  at: ts("at").notNull().defaultNow(),
  screen: text("screen").notNull().default(""),
  rating: smallint("rating"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export const supportMessages = pgTable("support_messages", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id").notNull().references(() => supportTickets.id),
  from: messageFromEnum("from").notNull(),
  who: text("who").notNull(),
  at: ts("at").notNull().defaultNow(),
  body: text("body").notNull(),
});
export const productRequests = pgTable("product_requests", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  why: text("why").notNull().default(""),
  forLoc: text("for_loc").notNull().references(() => locations.key),
  byUser: text("by_user").notNull().references(() => users.id),
  at: ts("at").notNull().defaultNow(),
  status: productReqStatusEnum("status").notNull(),
  note: text("note"),
  itemKey: text("item_key").references(() => items.key),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
```

`apps/api/src/db/schema/infra.ts`:
```ts
import { bigint, index, integer, jsonb, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { ts, users } from "./master";

export const documentHistory = pgTable("document_history", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  docType: text("doc_type").notNull(),
  docId: text("doc_id").notNull(),
  status: text("status").notNull(),
  who: text("who").notNull(),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("document_history_doc_idx").on(t.docType, t.docId, t.at)]);

/** Gapless, serialised numbering. Allocated with UPDATE … RETURNING inside the write's transaction. */
export const sequences = pgTable("sequences", {
  kind: text("kind").primaryKey(),
  next: bigint("next", { mode: "number" }).notNull(),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  requestHash: text("request_hash").notNull(),
  statusCode: integer("status_code").notNull(),
  response: jsonb("response").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
}, (t) => [primaryKey({ columns: [t.key, t.userId] }), index("idempotency_expires_idx").on(t.expiresAt)]);

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => users.id),
  family: uuid("family").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  revokedAt: ts("revoked_at"),
  userAgent: text("user_agent"),
  ip: text("ip"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("refresh_tokens_family_idx").on(t.family), index("refresh_tokens_user_idx").on(t.userId)]);
```

`apps/api/src/db/schema/index.ts`:
```ts
export * from "./enums";
export * from "./master";
export * from "./ledger";
export * from "./movement";
export * from "./production";
export * from "./buying";
export * from "./sales";
export * from "./ops";
export * from "./infra";
```

- [ ] **Step 5: Generate the migration, then the db plugin and test harness**

Run: `pnpm db:up && pnpm --filter @rch/api db:generate`
Expected: `apps/api/drizzle/0000_<name>.sql` and `drizzle/meta/_journal.json` + `0000_snapshot.json` created. Open the SQL and confirm: every enum, every table, the two `lower(name)` unique indexes, the partial index `reservations_open_idx … WHERE released_at is null`. Rename the file to `0000_initial.sql` **and** update the `tag` in `_journal.json` to match.

`apps/api/src/plugins/db.ts`:
```ts
import fp from "fastify-plugin";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { createDb } from "../db/client";
import { appliedMigrationCount, expectedMigrationCount } from "../db/migrate";

declare module "fastify" { interface FastifyInstance { db: Db } }

export type DbPluginOptions = { url: string; ssl: boolean; searchPath?: string; migrationsSchema?: string; db?: Db };

export default fp<DbPluginOptions>(async (app, opts) => {
  let db = opts.db;
  let pool: { end(): Promise<void> } | undefined;
  if (!db) { const c = createDb(opts.url, opts.ssl, { searchPath: opts.searchPath }); db = c.db; pool = c.pool; }
  app.decorate("db", db);
  app.readiness.addCheck("database", async () => {
    await db!.execute(sql`select 1`);
    const applied = await appliedMigrationCount(db!, opts.migrationsSchema);
    const expected = expectedMigrationCount();
    if (applied !== expected) throw new Error(`schema at ${applied}/${expected} migrations`);
  });
  app.addHook("onClose", async () => { await pool?.end(); });
}, { name: "db", dependencies: ["health"] });
```

In `apps/api/src/app.ts` add a `deps` parameter and register the plugin after `security`:
```ts
export type AppDeps = { db?: Db; searchPath?: string; migrationsSchema?: string };
export async function buildApp(config: Config, deps: AppDeps = {}): Promise<App> {
  // … as before …
  await app.register(db, { url: config.databaseUrl, ssl: config.databaseSsl, searchPath: deps.searchPath, migrationsSchema: deps.migrationsSchema, db: deps.db });
  return app;
}
```
(import `db from "./plugins/db"` and `type { Db } from "./db/client"`.)

`apps/api/src/test/db.ts` — every test file gets its own schema so files run in parallel:
```ts
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { createDb, type Db } from "../db/client";
import { runMigrations } from "../db/migrate";
import * as schema from "../db/schema";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5432/rch_test";

export type TestDb = { db: Db; schemaName: string; close(): Promise<void> };

/** Creates schema `t_<name>` (dropping any leftover), migrates into it, returns a Db whose search_path is that schema. */
export async function withTestSchema(name: string): Promise<TestDb> {
  const schemaName = `t_${name.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;
  const admin = new Pool({ connectionString: BASE, max: 1 });
  await admin.query(`drop schema if exists "${schemaName}" cascade`);
  await admin.query(`create schema "${schemaName}"`);
  await admin.end();
  const { db, pool } = createDb(BASE, false, { max: 4, searchPath: `${schemaName},public` });
  await runMigrations(db, schemaName);
  return { db, schemaName, close: async () => { await pool.end(); } };
}

/** Empty every business table between tests; keep sequences and migrations. */
export async function truncateAll(db: Db): Promise<void> {
  const names = Object.values(schema)
    .filter((t): t is (typeof schema)["items"] => typeof t === "object" && t !== null && "_" in (t as object))
    .map((t) => (t as unknown as { _: { name: string } })._.name)
    .filter((n) => n !== "sequences");
  await db.execute(sql.raw(`truncate table ${names.map((n) => `"${n}"`).join(", ")} restart identity cascade`));
}
```

Update `apps/api/src/test/app.ts`:
```ts
import { withTestSchema, type TestDb } from "./db";
export async function buildTestApp(opts: { withDb?: boolean; schema?: string; env?: Partial<NodeJS.ProcessEnv> } = {}): Promise<App & { testDb?: TestDb }> {
  const config = testConfig(opts.env);
  if (opts.withDb === false) return buildApp(config);
  const testDb = await withTestSchema(opts.schema ?? "app");
  const app = await buildApp(config, { db: testDb.db, migrationsSchema: testDb.schemaName });
  app.addHook("onClose", async () => { await testDb.close(); });
  return Object.assign(app, { testDb });
}
```

- [ ] **Step 6: Tests**

`apps/api/src/db/schema.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { withTestSchema, type TestDb } from "../test/db";
import { buildTestApp } from "../test/app";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("schema"); });
afterAll(async () => { await t.close(); });

describe("schema", () => {
  it("migrates every table into the test schema", async () => {
    const r = await t.db.execute(sql`select table_name from information_schema.tables where table_schema = ${t.schemaName} order by 1`);
    const names = r.rows.map((x) => (x as { table_name: string }).table_name);
    for (const n of ["stock_moves", "stock_balances", "reservations", "stock_requests", "tickets", "bills", "purchase_orders", "grns", "sequences", "refresh_tokens", "idempotency_keys", "document_history"])
      expect(names).toContain(n);
  });
  it("refuses a second item with the same name in a different case", async () => {
    await t.db.execute(sql`insert into items(key, code, name, unit, type, grp, hsn, gst) values ('a','A','Milk 1L','L','RAW','Dairy','0401',0)`);
    await expect(t.db.execute(sql`insert into items(key, code, name, unit, type, grp, hsn, gst) values ('b','B','milk 1l','L','RAW','Dairy','0401',0)`)).rejects.toThrow();
  });
  it("makes /readyz green once migrated", async () => {
    const app = await buildTestApp({ schema: "schema_ready" });
    const r = await app.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(200);
    await app.close();
  });
});
```
Run: `pnpm --filter @rch/api test` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Lay down the whole schema and the first migration

Every table the frontend's state needs, in Drizzle with snake_case
columns, plus the append-only stock ledger, gapless sequences and the
auth/idempotency tables. Readiness now checks the database and that the
applied migrations match the journal; tests get a schema each.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 6: Ledger and document helpers — the only writers of the protected tables

**Files:**
- Create: `apps/api/src/lib/db.ts`, `apps/api/src/lib/ids.ts`, `apps/api/src/lib/history.ts`, `apps/api/src/lib/ledger.ts`, `apps/api/src/lib/rules.ts`, `apps/api/src/lib/time.ts`, `apps/api/src/cli/rebuild-balances.ts`
- Test: `apps/api/src/lib/ledger.test.ts`, `apps/api/src/lib/ids.test.ts`

**Interfaces:**
- Produces:
  - `type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]` (Drizzle transaction handle); `withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T>`
  - `allocateId(tx: Tx, kind: IdKind, at?: Date): Promise<string>`; `ensureSequences(tx: Tx): Promise<void>` (inserts `SEQUENCE_START` rows where missing)
  - `appendHistory(tx: Tx, docType: string, docId: string, status: string, who: string, at?: Date): Promise<void>`; `readHistory(db, docType, docId): Promise<HistEntry[]>`; `readHistories(db, docType): Promise<Map<string, HistEntry[]>>` where `HistEntry = { s: string; who: string; t: string /* ISO */ }`
  - `type Move = { loc: string; it: string; qty: number; kind: MoveKind; refType: string; refId: string; by?: string; at?: Date }`; `postMoves(tx: Tx, moves: Move[]): Promise<void>` — locks balances in `(loc, it)` order, inserts moves, adds deltas to balances; `rebuildBalances(db: Db): Promise<{ rows: number }>`
  - `assertRule(cond: unknown, message: string, details?: unknown): asserts cond` → throws `RuleError`
  - `iso(d: Date): string`; `todayAt(hhmm: string): Date`; `dateAt(yyyyMmDd: string, hhmm: string): Date` (Asia/Kolkata)

- [ ] **Step 1: Failing tests**

`apps/api/src/lib/ids.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTestSchema, type TestDb } from "../test/db";
import { allocateId, ensureSequences } from "./ids";
import { withTransaction } from "./db";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("ids"); await withTransaction(t.db, (tx) => ensureSequences(tx)); });
afterAll(async () => { await t.close(); });

describe("allocateId", () => {
  it("continues the seeded series and never repeats under concurrency", async () => {
    const first = await withTransaction(t.db, (tx) => allocateId(tx, "tkt"));
    expect(first).toBe("TKT-0441");
    const ids = await Promise.all(Array.from({ length: 20 }, () => withTransaction(t.db, (tx) => allocateId(tx, "tkt"))));
    expect(new Set(ids).size).toBe(20);
    expect(ids).toContain("TKT-0442");
    expect(ids).toContain("TKT-0461");
  });
  it("does not consume a number when the transaction rolls back", async () => {
    await expect(withTransaction(t.db, async (tx) => { await allocateId(tx, "bill"); throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withTransaction(t.db, (tx) => allocateId(tx, "bill"))).toBe("CF/1188");
  });
});
```

`apps/api/src/lib/ledger.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTestSchema, truncateAll, type TestDb } from "../test/db";
import { postMoves, rebuildBalances } from "./ledger";
import { withTransaction } from "./db";
import { items, locations, stockBalances, stockMoves } from "../db/schema";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("ledger"); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await truncateAll(t.db);
  await t.db.insert(locations).values([
    { key: "store", name: "Central Store", code: "WH-CS", type: "Store", floor: "B", costCentre: "CC" },
    { key: "coffee", name: "Coffee Shop", code: "OT-C3", type: "Outlet", floor: "3", costCentre: "CC", priceList: "B", sellable: true },
  ]);
  await t.db.insert(items).values({ key: "milk", code: "RM-1001", name: "Milk 1L", unit: "L", type: "RAW", grp: "Dairy", hsn: "0401", gst: 0 });
});

const onHand = async (loc: string, it: string) =>
  (await t.db.select().from(stockBalances).where(and(eq(stockBalances.loc, loc), eq(stockBalances.itemKey, it))))[0]?.onHand ?? 0;

describe("postMoves", () => {
  it("appends moves and keeps the balance cache in step", async () => {
    await withTransaction(t.db, (tx) => postMoves(tx, [
      { loc: "store", it: "milk", qty: 12, kind: "opening", refType: "seed", refId: "opening" },
      { loc: "store", it: "milk", qty: -2.5, kind: "ticket_out", refType: "ticket", refId: "TKT-0440" },
      { loc: "coffee", it: "milk", qty: 2.5, kind: "ticket_in", refType: "ticket", refId: "TKT-0440" },
    ]));
    expect(await onHand("store", "milk")).toBe(9.5);
    expect(await onHand("coffee", "milk")).toBe(2.5);
    expect((await t.db.select().from(stockMoves)).length).toBe(3);
  });
  it("rounds to three decimals", async () => {
    await withTransaction(t.db, (tx) => postMoves(tx, [
      { loc: "store", it: "milk", qty: 0.1, kind: "opening", refType: "seed", refId: "o" },
      { loc: "store", it: "milk", qty: 0.2, kind: "opening", refType: "seed", refId: "o" },
    ]));
    expect(await onHand("store", "milk")).toBe(0.3);
  });
  it("is atomic: a failing move leaves nothing behind", async () => {
    await expect(withTransaction(t.db, (tx) => postMoves(tx, [
      { loc: "store", it: "milk", qty: 1, kind: "opening", refType: "seed", refId: "o" },
      { loc: "nowhere", it: "milk", qty: 1, kind: "opening", refType: "seed", refId: "o" },
    ]))).rejects.toThrow();
    expect((await t.db.select().from(stockMoves)).length).toBe(0);
    expect(await onHand("store", "milk")).toBe(0);
  });
  it("survives 25 concurrent writers to the same balance without losing an update", async () => {
    await Promise.all(Array.from({ length: 25 }, () =>
      withTransaction(t.db, (tx) => postMoves(tx, [{ loc: "store", it: "milk", qty: 1, kind: "opening", refType: "seed", refId: "c" }]))));
    expect(await onHand("store", "milk")).toBe(25);
  });
  it("rebuildBalances reproduces the cache from the moves", async () => {
    await withTransaction(t.db, (tx) => postMoves(tx, [{ loc: "store", it: "milk", qty: 7, kind: "opening", refType: "seed", refId: "o" }]));
    await t.db.update(stockBalances).set({ onHand: 999 });
    const r = await rebuildBalances(t.db);
    expect(r.rows).toBe(1);
    expect(await onHand("store", "milk")).toBe(7);
  });
});
```
Run: `pnpm --filter @rch/api test src/lib` — Expected: FAIL (modules missing).

- [ ] **Step 2: Implement**

`apps/api/src/lib/db.ts`:
```ts
import type { Db } from "../db/client";
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** All writes go through here so a service cannot forget the transaction. */
export const withTransaction = <T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> => db.transaction(fn);
```

`apps/api/src/lib/rules.ts`:
```ts
import { RuleError } from "./errors";
/** A domain rule. `message` is the sentence the operator reads in the toast. */
export function assertRule(cond: unknown, message: string, details?: unknown): asserts cond {
  if (!cond) throw new RuleError(message, details);
}
```

`apps/api/src/lib/time.ts`:
```ts
export const iso = (d: Date): string => d.toISOString();
/** Today's date in the hospital's zone at HH:MM local — for seeding "06:30"-style fixtures. */
export function todayAt(hhmm: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return dateAt(`${get("year")}-${get("month")}-${get("day")}`, hhmm);
}
/** A calendar date + HH:MM in Asia/Kolkata → the instant. IST has no DST, so a fixed offset is exact. */
export function dateAt(yyyyMmDd: string, hhmm: string): Date {
  return new Date(`${yyyyMmDd}T${hhmm}:00+05:30`);
}
```

`apps/api/src/lib/ids.ts`:
```ts
import { sql } from "drizzle-orm";
import { formatId, SEQUENCE_START, type IdKind } from "@rch/domain";
import { sequences } from "../db/schema";
import type { Tx } from "./db";

/** Insert any series that is missing, starting where the seeded documents leave off. */
export async function ensureSequences(tx: Tx): Promise<void> {
  const rows = (Object.keys(SEQUENCE_START) as IdKind[]).map((kind) => ({ kind, next: SEQUENCE_START[kind] }));
  await tx.insert(sequences).values(rows).onConflictDoNothing();
}

/** Gapless and serialised: the row lock taken by UPDATE holds until the caller's transaction ends. */
export async function allocateId(tx: Tx, kind: IdKind, at: Date = new Date()): Promise<string> {
  const r = await tx.execute(sql`update sequences set next = next + 1 where kind = ${kind} returning next - 1 as n`);
  const row = r.rows[0] as { n: number | string } | undefined;
  if (!row) throw new Error(`sequence "${kind}" is not initialised - run ensureSequences()`);
  return formatId(kind, Number(row.n), at);
}
```

`apps/api/src/lib/history.ts`:
```ts
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { documentHistory } from "../db/schema";
import type { Tx } from "./db";
import { iso } from "./time";

export type HistEntry = { s: string; who: string; t: string };

export async function appendHistory(tx: Tx, docType: string, docId: string, status: string, who: string, at: Date = new Date()): Promise<void> {
  await tx.insert(documentHistory).values({ docType, docId, status, who, at });
}
export async function readHistory(db: Db | Tx, docType: string, docId: string): Promise<HistEntry[]> {
  const rows = await db.select().from(documentHistory)
    .where(and(eq(documentHistory.docType, docType), eq(documentHistory.docId, docId)))
    .orderBy(asc(documentHistory.at), asc(documentHistory.id));
  return rows.map((r) => ({ s: r.status, who: r.who, t: iso(r.at) }));
}
/** One query for many documents — the snapshot readers use this instead of N round trips. */
export async function readHistories(db: Db | Tx, docType: string): Promise<Map<string, HistEntry[]>> {
  const rows = await db.select().from(documentHistory).where(eq(documentHistory.docType, docType))
    .orderBy(asc(documentHistory.at), asc(documentHistory.id));
  const m = new Map<string, HistEntry[]>();
  for (const r of rows) { const a = m.get(r.docId) ?? []; a.push({ s: r.status, who: r.who, t: iso(r.at) }); m.set(r.docId, a); }
  return m;
}
```

`apps/api/src/lib/ledger.ts`:
```ts
import { sql } from "drizzle-orm";
import { round3 } from "@rch/domain";
import type { Db } from "../db/client";
import { stockBalances, stockMoves } from "../db/schema";
import type { Tx } from "./db";

export type MoveKind = (typeof stockMoves.$inferInsert)["kind"];
export type Move = { loc: string; it: string; qty: number; kind: MoveKind; refType: string; refId: string; by?: string; at?: Date };

/**
 * The one door to the ledger. Locks every (loc, item) balance the batch touches, in a fixed
 * order so two writers cannot deadlock, appends the moves, then adds the deltas to the cache.
 */
export async function postMoves(tx: Tx, moves: Move[]): Promise<void> {
  if (moves.length === 0) return;
  const keys = [...new Set(moves.map((m) => `${m.loc} ${m.it}`))].sort();
  for (const k of keys) {
    const [loc, it] = k.split(" ");
    await tx.insert(stockBalances).values({ loc, itemKey: it, onHand: 0 }).onConflictDoNothing();
    await tx.execute(sql`select 1 from stock_balances where loc = ${loc} and item_key = ${it} for update`);
  }
  await tx.insert(stockMoves).values(moves.map((m) => ({
    loc: m.loc, itemKey: m.it, qty: round3(m.qty), kind: m.kind, refType: m.refType, refId: m.refId, byUser: m.by, at: m.at,
  })));
  const delta = new Map<string, number>();
  for (const m of moves) { const k = `${m.loc} ${m.it}`; delta.set(k, round3((delta.get(k) ?? 0) + m.qty)); }
  for (const [k, d] of delta) {
    const [loc, it] = k.split(" ");
    await tx.execute(sql`update stock_balances set on_hand = round(on_hand + ${d}::numeric, 3), updated_at = now() where loc = ${loc} and item_key = ${it}`);
  }
}

/** Recompute every balance from the moves. Proves the cache; also the recovery path. */
export async function rebuildBalances(db: Db): Promise<{ rows: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table stock_balances in exclusive mode`);
    await tx.execute(sql`delete from stock_balances`);
    const r = await tx.execute(sql`
      insert into stock_balances (loc, item_key, on_hand, updated_at)
      select loc, item_key, round(sum(qty), 3), now() from stock_moves group by loc, item_key`);
    return { rows: r.rowCount ?? 0 };
  });
}
```

`apps/api/src/cli/rebuild-balances.ts`:
```ts
import { loadConfig } from "../config";
import { createDb } from "../db/client";
import { rebuildBalances } from "../lib/ledger";
const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1 });
const r = await rebuildBalances(db);
console.log(`stock_balances rebuilt: ${r.rows} rows`);
await pool.end();
```

Run: `pnpm --filter @rch/api test src/lib` — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Give the ledger and document numbering a single door each

postMoves is the only code that writes stock_moves or the balance cache,
and takes its locks in a fixed order; allocateId hands out gapless numbers
inside the caller's transaction; history rows replace the hist[] arrays.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 7: Seed — the fixtures become rows, through the helpers

**Files:**
- Create: `apps/api/src/db/seed.ts`, `apps/api/src/cli/seed.ts`, `apps/api/src/lib/password.ts`, `apps/api/src/test/seed.ts`
- Test: `apps/api/src/db/seed.test.ts`

**Interfaces:**
- Produces:
  - `hashPassword(plain: string): Promise<string>`; `verifyPassword(hash: string, plain: string): Promise<boolean>` (Argon2id, m=65536 KiB, t=3, p=1)
  - `seedDatabase(db: Db, opts: { password: string; forcePasswordChange: boolean; force?: boolean }): Promise<void>` — refuses a non-empty `users` table unless `force`
  - Test helper `seedTestDb(db: Db): Promise<void>` = `seedDatabase(db, { password: "changeme", forcePasswordChange: false, force: true })`
- Every quantity enters through `postMoves` as an `opening` move; every document status through `appendHistory`; open `Issued` tickets create `reservations`. A sixth location `quarantine` is inserted (spec §7.2).
- `at` values: fixture strings `"HH:MM"` → `todayAt(hhmm)`; dates `"YYYY-MM-DD"` pass through; `eta` `"29-Aug-2026"` → `"2026-08-29"`. Any fixture time that is not `HH:MM` maps through `parseFixtureTime()` which falls back to `todayAt("09:00")`.

- [ ] **Step 1: Failing test**

`apps/api/src/db/seed.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import * as FX from "@rch/contract/fixtures";
import { withTestSchema, type TestDb } from "../test/db";
import { seedTestDb } from "../test/seed";
import { seedDatabase } from "./seed";
import { rebuildBalances } from "../lib/ledger";
import { bills, grns, items, locations, purchaseOrders, rateContracts, reservations, sequences, shopAsks, stockBalances, stockRequests, supportTickets, tickets, users } from "./schema";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("seed"); await seedTestDb(t.db); });
afterAll(async () => { await t.close(); });

const count = async (tbl: PgTable) => Number(((await t.db.execute(sql`select count(*)::int as n from ${tbl}`)).rows[0] as { n: number }).n);

describe("seed", () => {
  it("loads every master table", async () => {
    expect(await count(locations)).toBe(Object.keys(FX.LOC).length + 1); // + quarantine
    expect(await count(items)).toBe(Object.keys(FX.IT).length);
    expect(await count(users)).toBe(FX.USERS.length);
  });
  it("opening stock equals the fixture at every location and the cache matches the moves", async () => {
    for (const [loc, byItem] of Object.entries(FX.seedStock)) for (const [it, q] of Object.entries(byItem)) {
      const r = await t.db.select().from(stockBalances).where(sql`loc = ${loc} and item_key = ${it}`);
      expect(r[0]?.onHand ?? 0, `${loc}/${it}`).toBe(q);
    }
    const before = await t.db.select().from(stockBalances);
    await rebuildBalances(t.db);
    const after = await t.db.select().from(stockBalances);
    const norm = (rows: typeof before) => rows.filter((r) => r.onHand !== 0).map((r) => [r.loc, r.itemKey, r.onHand]).sort();
    expect(norm(after)).toEqual(norm(before));
  });
  it("loads the open documents and reserves stock for issued tickets", async () => {
    expect(await count(stockRequests)).toBe(FX.seedReq.length);
    expect(await count(tickets)).toBe(FX.seedTkt.length);
    const issued = FX.seedTkt.filter((x) => x.st === "Issued").flatMap((x) => x.lines).length;
    expect(await count(reservations)).toBe(issued);
    expect(await count(bills)).toBe(FX.seedBills.length);
    expect(await count(purchaseOrders)).toBe(FX.seedPo.length);
    expect(await count(grns)).toBe(FX.seedGrn.length);
    expect(await count(supportTickets)).toBe(FX.seedTickets().length);
    expect(await count(rateContracts)).toBe(FX.seedContracts().length);
    expect(await count(shopAsks)).toBe(FX.seedShopAsks().length);
  });
  it("sequences continue the visible series", async () => {
    const r = await t.db.select().from(sequences).where(eq(sequences.kind, "req"));
    expect(r[0].next).toBe(913);
  });
  it("refuses to run twice without --force", async () => {
    await expect(seedDatabase(t.db, { password: "changeme", forcePasswordChange: false })).rejects.toThrow(/already/);
  });
});
```
Run: `pnpm --filter @rch/api test src/db/seed` — Expected: FAIL.

- [ ] **Step 2: Password helper**

`apps/api/src/lib/password.ts`:
```ts
import { Algorithm, hash, verify } from "@node-rs/argon2";
const OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 };
export const hashPassword = (plain: string): Promise<string> => hash(plain, OPTS);
export const verifyPassword = async (h: string, plain: string): Promise<boolean> => {
  try { return await verify(h, plain); } catch { return false; }
};
```

- [ ] **Step 3: The seed**

`apps/api/src/db/seed.ts`:
```ts
import { sql } from "drizzle-orm";
import * as FX from "@rch/contract/fixtures";
import type { Db } from "./client";
import * as s from "./schema";
import { withTransaction, type Tx } from "../lib/db";
import { ensureSequences } from "../lib/ids";
import { appendHistory } from "../lib/history";
import { postMoves, type Move } from "../lib/ledger";
import { hashPassword } from "../lib/password";
import { todayAt } from "../lib/time";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "29-Aug-2026" -> "2026-08-29" */
const etaDate = (v: string) => { const [d, m, y] = v.split("-"); return `${y}-${String(MONTHS.indexOf(m) + 1).padStart(2, "0")}-${d}`; };
/** Fixture times are "HH:MM" today; anything else falls back to a fixed morning slot. */
const parseFixtureTime = (v: string | undefined) => (v && /^\d{2}:\d{2}$/.test(v) ? todayAt(v) : todayAt("09:00"));
const userIdByName = new Map(FX.USERS.map((u) => [u.n, u.id]));
const who = (name: string) => userIdByName.get(name) ?? FX.USERS[0].id;
const allTables = () => Object.values(s).filter((t): t is s.PgTableLike => typeof t === "object" && t !== null && "_" in (t as object));

export async function seedDatabase(db: Db, opts: { password: string; forcePasswordChange: boolean; force?: boolean }): Promise<void> {
  const existing = Number(((await db.execute(sql`select count(*)::int as n from users`)).rows[0] as { n: number }).n);
  if (existing > 0 && !opts.force) throw new Error(`database already has ${existing} users - pass --force to reseed`);
  const passwordHash = await hashPassword(opts.password);
  await withTransaction(db, async (tx) => {
    if (existing > 0) {
      const names = allTables().map((t) => `"${(t as unknown as { _: { name: string } })._.name}"`).join(", ");
      await tx.execute(sql.raw(`truncate table ${names} restart identity cascade`));
    }
    await seedMaster(tx, passwordHash, opts.forcePasswordChange);
    await ensureSequences(tx);
    await seedOpeningStock(tx);
    await seedRequestsAndTickets(tx);
    await seedProcurement(tx);
    await seedProduction(tx);
    await seedBills(tx);
    await seedOps(tx);
  });
}
```
Add to `apps/api/src/db/schema/index.ts` a helper type so the filter above compiles: `export type PgTableLike = import("drizzle-orm/pg-core").PgTable;` — and use `PgTable` directly if the alias feels redundant.

Continue `seed.ts` with the section functions:
```ts
async function seedMaster(tx: Tx, passwordHash: string, mustChange: boolean) {
  await tx.insert(s.locations).values([
    ...Object.entries(FX.LOC).map(([key, l]) => ({ key, name: l.n, code: l.c, type: l.type, floor: l.floor, costCentre: l.cc, priceList: l.list ?? null, sellable: l.type === "Outlet" })),
    { key: "quarantine", name: "Quarantine", code: "WH-QR", type: "Store" as const, floor: "Basement", costCentre: "CC-STO", priceList: null, sellable: false },
  ]);
  await tx.insert(s.items).values(Object.entries(FX.IT).map(([key, i]) => ({
    key, code: i.c, name: i.n, unit: i.u, type: i.t, grp: i.g, hsn: i.hsn, gst: i.gst, reorderLevel: i.rl, cost: i.cost, mrp: i.mrp ?? null, shelfLifeHours: i.sl ?? null,
  })));
  await tx.insert(s.recipes).values(Object.entries(FX.RCP).map(([itemKey, r]) => ({ itemKey, overheadPct: r.ov })));
  await tx.insert(s.recipeLines).values(Object.entries(FX.RCP).flatMap(([itemKey, r]) => r.l.map(([ingredientKey, qty], seq) => ({ itemKey, ingredientKey, qty, seq }))));
  await tx.insert(s.locationItems).values(Object.entries(FX.MENU).flatMap(([loc, keys]) => keys.map((itemKey, seq) => ({ loc, itemKey, seq }))));
  await tx.insert(s.priceListItems).values((["A", "B"] as const).flatMap((list) => Object.entries(FX.PL[list]).map(([itemKey, price]) => ({ list, itemKey, price }))));
  await tx.insert(s.users).values(FX.USERS.map((u) => ({
    id: u.id, name: u.n, email: u.e, role: u.r, roleLabel: u.rl, loc: u.loc, colour: u.col, empNo: u.emp, phone: u.ph, passwordHash, mustChangePassword: mustChange,
  })));
  await tx.insert(s.vendors).values(FX.seedVendors.map((v) => ({
    id: v.id, name: v.n, gstin: v.gstin, contact: v.contact, phone: v.ph, terms: v.terms, leadDays: v.lead, groups: v.groups, active: v.active,
  })));
}

async function seedOpeningStock(tx: Tx) {
  const moves: Move[] = [];
  for (const [loc, byItem] of Object.entries(FX.seedStock)) for (const [it, qty] of Object.entries(byItem)) {
    if (qty !== 0) moves.push({ loc, it, qty, kind: "opening", refType: "seed", refId: "opening" });
    // A zero fixture (coffee has milk: 0) still gets a balance row so the stock screen lists the item.
    else await tx.insert(s.stockBalances).values({ loc, itemKey: it, onHand: 0 }).onConflictDoNothing();
  }
  await postMoves(tx, moves);
}

async function seedRequestsAndTickets(tx: Tx) {
  for (const r of FX.seedReq) {
    await tx.insert(s.stockRequests).values({
      id: r.id, fromLoc: r.from, byUser: who(r.by), at: parseFixtureTime(r.at), status: r.st, ticketId: r.ticket,
      managerNote: r.mgrNote, urgent: !!r.urg, approvedBy: r.apprBy ? who(r.apprBy) : null,
    });
    await tx.insert(s.stockRequestLines).values(r.lines.map((l, lineNo) => ({ requestId: r.id, lineNo, itemKey: l.it, qty: l.qty, approvedQty: l.appr, shortQty: l.short ?? null })));
    for (const h of r.hist) await appendHistory(tx, "request", r.id, h.s, h.who, parseFixtureTime(h.t));
  }
  for (const t of FX.seedTkt) {
    const refType = t.req.startsWith("REQ-") ? "request" : t.req.startsWith("PRD-") ? "prod_order" : t.req === "Shop transfer" ? "shop_transfer" : "direct";
    await tx.insert(s.tickets).values({
      id: t.id, refType, refId: t.req, fromLoc: t.from, toLoc: t.to, status: t.st, otp: t.otp, issuedAt: todayAt("07:00"),
      collectedAt: t.st !== "Issued" ? todayAt("07:30") : null, receivedAt: t.st === "Received" ? todayAt("08:00") : null,
    });
    await tx.insert(s.ticketLines).values(t.lines.map((l, lineNo) => ({ ticketId: t.id, lineNo, itemKey: l.it, qty: l.qty })));
    if (t.st === "Issued") await tx.insert(s.reservations).values(t.lines.map((l) => ({ loc: t.from, itemKey: l.it, qty: l.qty, ticketId: t.id })));
  }
  for (const a of FX.seedShopAsks()) {
    await tx.insert(s.shopAsks).values({
      id: a.id, fromLoc: a.from, toLoc: a.to, itemKey: a.it, qty: a.qty, status: a.st, byUser: who(a.by), at: parseFixtureTime(a.at),
      note: a.note, grantedQty: a.grant ?? null, ticketId: a.ticket ?? null, reason: a.reason ?? null,
    });
  }
}

async function seedProcurement(tx: Tx) {
  for (const p of FX.seedPrq) {
    await tx.insert(s.requisitions).values({ id: p.id, byUser: who(p.by), at: parseFixtureTime(p.at), status: p.st, note: p.note, approvedBy: p.apprBy ? who(p.apprBy) : null, approvalNote: p.apprNote ?? null });
    await tx.insert(s.requisitionLines).values(p.lines.map((l, lineNo) => ({ requisitionId: p.id, lineNo, itemKey: l.it, qty: l.qty, approvedQty: l.appr, orderedQty: l.ordered, shortQty: l.short ?? null })));
    for (const h of p.hist) await appendHistory(tx, "requisition", p.id, h.s, h.who, parseFixtureTime(h.t));
  }
  for (const o of FX.seedPo) {
    await tx.insert(s.purchaseOrders).values({
      id: o.id, vendorId: o.vendor, at: parseFixtureTime(o.at), status: o.st, eta: o.eta ? etaDate(o.eta) : null,
      needsApproval: !!o.needsApproval, shortNote: o.shortNote ?? null, receivedAt: o.recv ? parseFixtureTime(o.recv) : null,
    });
    await tx.insert(s.poLines).values(o.lines.map((l, lineNo) => ({ poId: o.id, lineNo, itemKey: l.it, qty: l.qty, rate: l.rate, receivedQty: l.recv, rejectedQty: l.rejected })));
    const srcs = o.lines.flatMap((l, lineNo) => l.src.map((x, seq) => ({ poId: o.id, lineNo, seq, requisitionId: x.prq, requisitionLineNo: x.line, qty: x.qty })));
    if (srcs.length) await tx.insert(s.poLineSources).values(srcs);
    for (const h of o.hist) await appendHistory(tx, "purchase_order", o.id, h.s, h.who, parseFixtureTime(h.t));
  }
  for (const g of FX.seedGrn) {
    const po = FX.seedPo.find((o) => o.id === g.po);
    const poLineNo = Math.max(0, po?.lines.findIndex((l) => l.it === g.it) ?? 0);
    await tx.insert(s.grns).values({
      id: g.id, poId: g.po, poLineNo, itemKey: g.it, acceptedQty: g.qty, rejectedQty: g.rejected, batchNo: g.batch, mrp: g.mrp, mfg: g.mfg, exp: g.exp,
      dcNo: g.dc, invoiceNo: g.invoice, invoiceDate: g.invDate || null, at: parseFixtureTime(g.at), byUser: who(g.by),
    });
  }
  for (const c of FX.seedContracts()) {
    await tx.insert(s.rateContracts).values({ id: c.id, vendorId: c.vendor, itemKey: c.it, rate: c.rate, validFrom: c.from, validTo: c.to, moq: c.moq, active: c.active });
  }
}

async function seedProduction(tx: Tx) {
  for (const o of FX.seedPord) {
    await tx.insert(s.prodOrders).values({ id: o.id, fromLoc: o.from, byUser: who(o.by), at: parseFixtureTime(o.at), status: o.st, note: o.note });
    await tx.insert(s.prodOrderLines).values(o.lines.map((l, lineNo) => ({ orderId: o.id, lineNo, itemKey: l.it, qty: l.qty })));
    for (const h of o.hist) await appendHistory(tx, "prod_order", o.id, h.s, h.who, parseFixtureTime(h.t));
  }
  for (const b of FX.seedBatch) {
    const made = parseFixtureTime(b.at);
    const hours = FX.IT[b.it]?.sl ?? 8;
    await tx.insert(s.batches).values({ id: b.id, itemKey: b.it, startedQty: b.qty, madeQty: b.made, at: made, bestBefore: new Date(made.getTime() + hours * 3600_000), note: b.note ?? null });
  }
}

async function seedBills(tx: Tx) {
  for (const b of FX.seedBills) {
    await tx.insert(s.bills).values({
      no: b.no, loc: b.loc, operatorId: who(b.opr), total: b.tot, tax: b.tax, at: parseFixtureTime(b.t), tender: b.pay,
      payerKind: b.payer?.kind ?? null, payerId: b.payer?.id ?? null, payerName: b.payer?.name ?? null,
    });
    await tx.insert(s.billLines).values(b.lines.map((l, lineNo) => ({ billNo: b.no, lineNo, itemKey: l.it, qty: l.qty, rate: l.rate })));
  }
}

async function seedOps(tx: Tx) {
  for (const t of FX.seedTickets()) {
    await tx.insert(s.supportTickets).values({
      id: t.id, topic: t.topic, subject: t.subject, priority: t.priority, status: t.st, byUser: who(t.by), role: t.role, loc: t.loc,
      at: parseFixtureTime(t.at), screen: t.screen, rating: t.rating ?? null,
    });
    // Fixture message ids ("m1", "m2") repeat across tickets; the row id is ticket-qualified and the reader strips it back.
    await tx.insert(s.supportMessages).values(t.messages.map((m) => ({ id: `${t.id}/${m.id}`, ticketId: t.id, from: m.from, who: m.who, at: parseFixtureTime(m.at), body: m.body })));
  }
  for (const p of FX.seedProductRequests()) {
    await tx.insert(s.productRequests).values({ id: p.id, name: p.name, why: p.why, forLoc: p.forLoc, byUser: who(p.by), at: parseFixtureTime(p.at), status: p.st, note: p.note ?? null, itemKey: p.itemKey ?? null });
  }
}
```
**Read the fixture files before writing this** — field names follow `types.ts` (`Vendor.ph`, `Vendor.lead`, `PurchaseOrder.recv`, `Grn.invDate`, `TicketMessage.at`). Where a fixture differs, follow the fixture and keep the table column.

`apps/api/src/test/seed.ts`:
```ts
import type { Db } from "../db/client";
import { seedDatabase } from "../db/seed";
export const seedTestDb = (db: Db) => seedDatabase(db, { password: "changeme", forcePasswordChange: false, force: true });
```

`apps/api/src/cli/seed.ts`:
```ts
import { loadConfig } from "../config";
import { createDb } from "../db/client";
import { seedDatabase } from "../db/seed";
const config = loadConfig(process.env);
const force = process.argv.includes("--force");
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 2 });
try {
  await seedDatabase(db, { password: config.seedPassword, forcePasswordChange: config.seedForcePasswordChange, force });
  console.log("seeded");
} finally { await pool.end(); }
```

Run: `pnpm --filter @rch/api test` — Expected: PASS, including the balance-rebuild equality.
Run: `pnpm --filter @rch/api db:migrate && pnpm --filter @rch/api db:seed` against the dev database — Expected: `seeded`; a second run without `--force` exits non-zero with the "already has 6 users" message.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Seed the database from the shared fixtures

Day one on the server looks exactly like day one in the browser: the same
items, users, opening stock and open documents, written through the
ledger and history helpers so the seed obeys the same rules as live writes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 8: Contract schemas, the route manifest, auth + RBAC plugins, the mount, and module stubs

This task is the hinge for parallel work: after it, Tasks 9–13 each fill in files that already exist and touch nothing shared.

**Files:**
- Create: `packages/contract/src/schemas/common.ts`, `packages/contract/src/schemas/documents.ts`, `packages/contract/src/schemas/auth.ts`, `packages/contract/src/schemas/snapshot.ts`, `packages/contract/src/routes.ts`, `packages/contract/src/schemas/documents.test.ts`
- Modify: `packages/contract/src/types.ts` (becomes `z.infer` aliases), `packages/contract/src/index.ts`
- Create: `apps/api/src/plugins/auth.ts`, `apps/api/src/plugins/rbac.ts`, `apps/api/src/routes.ts`, `apps/api/src/modules/index.ts`, `apps/api/src/modules/{auth,me,master,snapshot}/routes.ts` (stubs), `apps/api/src/test/auth.ts`
- Modify: `apps/api/src/app.ts` (register auth, rbac, modules)
- Test: `apps/api/src/routes.test.ts`

**Interfaces:**
- Produces (contract):
  - Zod schemas for every document type; `types.ts` exports `type X = z.infer<typeof XSchema>` for all of them, so no UI type changes.
  - `UserSchema` = wire user `{ id, n, e, r, rl, loc, col, emp, ph }`
  - `LoginBody { emp: string; password: string }`, `AuthResponse { accessToken: string; user: User; mustChangePassword: boolean }`, `ChangePasswordBody { current: string; next: string }`, `PatchMeBody { n?: string; e?: string; ph?: string }`, `OkResponse { ok: true }`
  - `SnapshotSchema` — exactly the shape in spec §9.1 (Task 11 fills it)
  - `routes` manifest and `type AnyRoute`, `defineRoute()`; Phase-1 entries: `login, refresh, logout, changePassword, me, patchMe, snapshot, items, locations, recipes, prices, menus`
- Produces (api):
  - `app.authenticate` preHandler; `request.user: { sub: string; role: Role; loc: LocKey; mcp: boolean }` after it
  - `app.signAccess(u: { id, role, loc, mcp }): Promise<string>`
  - `requireLoc(req, loc)` → `ForbiddenError`; `roleGate(roles)` → `NotFoundError`
  - `mount(app, route, handler)` — the only way a module registers a route
  - `registerModules(app)` — imports every module plugin; modules are `fastify-plugin`s named `module:<name>`
  - Test helper `authHeaders(app, userId): Promise<{ authorization: string }>`

- [ ] **Step 1: Common and document schemas in the contract**

`packages/contract/src/schemas/common.ts`:
```ts
import { z } from "zod";

export const LocKeySchema = z.enum(["store", "kitchen", "rest", "coffee", "kiosk"]);
export const RoleSchema = z.enum(["counter", "manager", "store", "prod", "buyer"]);
export const ItemTypeSchema = z.enum(["RAW", "PACK", "MRP", "FG", "MTO"]);
export const PriceListSchema = z.enum(["A", "B"]);
export const ErrorCodeSchema = z.enum(["validation", "unauthenticated", "forbidden", "not_found", "conflict", "rule", "rate_limited", "not_ready", "internal"]);
export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: ErrorCodeSchema, message: z.string(), details: z.unknown().optional() }),
});
export const OkResponseSchema = z.object({ ok: z.literal(true) });
/** Quantities and money travel as JSON numbers. */
export const Qty = z.number().finite();
export const Money = z.number().finite();
/** Times on the wire are ISO 8601 strings; the UI formats them (Task 16). */
export const IsoTime = z.string();
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
```

`packages/contract/src/schemas/documents.ts` — one schema per interface in the old `types.ts`, field for field:
```ts
import { z } from "zod";
import { IsoDate, IsoTime, ItemTypeSchema, LocKeySchema, Money, PriceListSchema, Qty, RoleSchema } from "./common";

export const ReqStatusSchema = z.enum(["Draft", "Request sent", "Manager approved", "Partially approved", "Ticket issued", "Collected", "Received", "Closed", "Rejected", "Cancelled"]);
export const TktStatusSchema = z.enum(["Issued", "Collected", "Received"]);
export const PrqStatusSchema = z.enum(["Sent", "Approved", "Partially approved", "Declined"]);
export const PordStatusSchema = z.enum(["New", "Accepted", "In kitchen", "Ready", "Dispatched", "Declined"]);
export const PoStatusSchema = z.enum(["Draft", "Ordered", "Partially received", "Received", "Cancelled"]);
export const ToneSchema = z.enum(["ok", "wn", "cr", "in", "ac", "mu"]);
export const PayerKindSchema = z.enum(["patient", "staff", "dept"]);
export const TicketTopicSchema = z.enum(["Sign in & access", "A screen will not load", "A number looks wrong", "Printing & receipts", "Slow or freezing", "Training & how do I", "Feature request", "Something else"]);
export const TicketPrioritySchema = z.enum(["Low", "Normal", "Urgent"]);
export const TicketStatusSchema = z.enum(["Open", "With support", "Waiting on you", "Resolved", "Closed"]);
export const ProductReqStatusSchema = z.enum(["Requested", "Created", "Declined"]);
export const ShopAskStatusSchema = z.enum(["Asked", "Sent", "Declined"]);

export const ItemSchema = z.object({
  c: z.string(), n: z.string(), u: z.string(), t: ItemTypeSchema, g: z.string(),
  hsn: z.string(), gst: z.number(), rl: Qty, cost: Money, mrp: Money.optional(), sl: z.number().optional(),
});
export const LocationSchema = z.object({
  n: z.string(), c: z.string(), type: z.enum(["Store", "Kitchen", "Outlet"]),
  floor: z.string(), cc: z.string(), list: PriceListSchema.optional(),
});
export const UserSchema = z.object({
  id: z.string(), n: z.string(), e: z.string(), r: RoleSchema, rl: z.string(),
  loc: LocKeySchema, col: z.string(), emp: z.string(), ph: z.string(),
});
export const RecipeSchema = z.object({ ov: z.number(), l: z.array(z.tuple([z.string(), Qty])) });
export const ReqLineSchema = z.object({ it: z.string(), qty: Qty, appr: Qty, short: Qty.optional() });
export const HistEntrySchema = z.object({ s: z.string(), who: z.string(), t: IsoTime });
export const StockRequestSchema = z.object({
  id: z.string(), from: LocKeySchema, by: z.string(), at: IsoTime,
  lines: z.array(ReqLineSchema), st: ReqStatusSchema, ticket: z.string().nullable(),
  mgrNote: z.string(), urg: z.boolean().optional(), hist: z.array(HistEntrySchema), apprBy: z.string().optional(),
});
export const TktLineSchema = z.object({ it: z.string(), qty: Qty });
export const TicketSchema = z.object({
  id: z.string(), req: z.string(), from: LocKeySchema, to: LocKeySchema,
  lines: z.array(TktLineSchema), st: TktStatusSchema, otp: z.string(),
});
export const PrqLineSchema = z.object({ it: z.string(), qty: Qty, appr: Qty, ordered: Qty, short: Qty.optional() });
export const RequisitionSchema = z.object({
  id: z.string(), by: z.string(), at: IsoTime, lines: z.array(PrqLineSchema), st: PrqStatusSchema, note: z.string(),
  apprBy: z.string().optional(), apprNote: z.string().optional(), hist: z.array(HistEntrySchema),
});
export const PoLineSrcSchema = z.object({ prq: z.string(), line: z.number().int(), qty: Qty });
export const PoLineSchema = z.object({ it: z.string(), qty: Qty, rate: Money, src: z.array(PoLineSrcSchema), recv: Qty, rejected: Qty });
export const PurchaseOrderSchema = z.object({
  id: z.string(), vendor: z.string(), at: IsoTime, lines: z.array(PoLineSchema), st: PoStatusSchema, eta: z.string(),
  needsApproval: z.boolean().optional(), shortNote: z.string().optional(), recv: IsoTime.optional(), hist: z.array(HistEntrySchema),
});
export const ProdOrderSchema = z.object({
  id: z.string(), from: LocKeySchema, by: z.string(), at: IsoTime, lines: z.array(TktLineSchema), st: PordStatusSchema, note: z.string(), hist: z.array(HistEntrySchema),
});
export const BatchSchema = z.object({ id: z.string(), it: z.string(), qty: Qty, made: Qty, at: IsoTime, bb: IsoTime, note: z.string().optional() });
export const PayerSchema = z.object({ kind: PayerKindSchema, id: z.string(), name: z.string() });
export const ReceiptLineSchema = z.object({ recv: Qty, batch: z.string(), mrp: Money, mfg: z.string(), exp: z.string(), rejected: Qty });
export const ReceiptDocSchema = z.object({ dc: z.string(), invoice: z.string(), invDate: z.string() });
export const GrnSchema = z.object({
  id: z.string(), po: z.string(), it: z.string(), qty: Qty, rejected: Qty, batch: z.string(), mrp: Money, mfg: IsoDate, exp: IsoDate,
  dc: z.string(), invoice: z.string(), invDate: z.string(), at: IsoTime, by: z.string(),
});
export const BillLineSchema = z.object({ it: z.string(), qty: Qty, rate: Money });
export const BillSchema = z.object({
  no: z.string(), loc: LocKeySchema, opr: z.string(), oprCol: z.string(), tot: Money, tax: Money, t: IsoTime, pay: z.string(),
  lines: z.array(BillLineSchema), payer: PayerSchema.optional(),
});
export const DraftLineSchema = z.object({ it: z.string(), qty: Qty });
export const AvailabilitySchema = z.object({ ok: z.boolean(), mode: z.enum(["Manual", "Recipe", "Stock"]), why: z.string().optional(), left: z.string().optional() });
export const PriceSchema = z.object({ p: Money, listed: Money, capped: z.boolean() });
export const DrawerStateSchema = z.object({ t: z.string(), id: z.string() });
export const VendorSchema = z.object({
  id: z.string(), n: z.string(), gstin: z.string(), contact: z.string(), ph: z.string(), terms: z.string(), lead: z.number(), groups: z.array(z.string()), active: z.boolean(),
});
export const TicketMessageSchema = z.object({ id: z.string(), from: z.enum(["user", "support"]), who: z.string(), at: IsoTime, body: z.string() });
export const SupportTicketSchema = z.object({
  id: z.string(), topic: TicketTopicSchema, subject: z.string(), priority: TicketPrioritySchema, st: TicketStatusSchema,
  by: z.string(), role: RoleSchema, loc: LocKeySchema, at: IsoTime, screen: z.string(), messages: z.array(TicketMessageSchema),
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
});
export const ProductRequestSchema = z.object({
  id: z.string(), name: z.string(), why: z.string(), forLoc: LocKeySchema, by: z.string(), at: IsoTime, st: ProductReqStatusSchema,
  note: z.string().optional(), itemKey: z.string().optional(),
});
export const RateContractSchema = z.object({
  id: z.string(), vendor: z.string(), it: z.string(), rate: Money, from: z.string(), to: z.string(), moq: Qty, active: z.boolean(),
});
export const ShopAskSchema = z.object({
  id: z.string(), from: LocKeySchema, to: LocKeySchema, it: z.string(), qty: Qty, st: ShopAskStatusSchema, by: z.string(), at: IsoTime, note: z.string(),
  grant: Qty.optional(), ticket: z.string().optional(), reason: z.string().optional(),
});
```

`packages/contract/src/types.ts` — replace the whole file with inferred aliases; the names and shapes are unchanged:
```ts
import type { z } from "zod";
import type * as C from "./schemas/common";
import type * as D from "./schemas/documents";

export type ItemType = z.infer<typeof C.ItemTypeSchema>;
export type LocKey = z.infer<typeof C.LocKeySchema>;
export type Role = z.infer<typeof C.RoleSchema>;
export type ReqStatus = z.infer<typeof D.ReqStatusSchema>;
export type TktStatus = z.infer<typeof D.TktStatusSchema>;
export type PrqStatus = z.infer<typeof D.PrqStatusSchema>;
export type PordStatus = z.infer<typeof D.PordStatusSchema>;
export type PoStatus = z.infer<typeof D.PoStatusSchema>;
export type Tone = z.infer<typeof D.ToneSchema>;
export type PayerKind = z.infer<typeof D.PayerKindSchema>;
export type TicketTopic = z.infer<typeof D.TicketTopicSchema>;
export type TicketPriority = z.infer<typeof D.TicketPrioritySchema>;
export type TicketStatus = z.infer<typeof D.TicketStatusSchema>;
export type ProductReqStatus = z.infer<typeof D.ProductReqStatusSchema>;
export type ShopAskStatus = z.infer<typeof D.ShopAskStatusSchema>;
export type Item = z.infer<typeof D.ItemSchema>;
export type Location = z.infer<typeof D.LocationSchema>;
export type User = z.infer<typeof D.UserSchema>;
export type Recipe = z.infer<typeof D.RecipeSchema>;
export type ReqLine = z.infer<typeof D.ReqLineSchema>;
export type HistEntry = z.infer<typeof D.HistEntrySchema>;
export type StockRequest = z.infer<typeof D.StockRequestSchema>;
export type TktLine = z.infer<typeof D.TktLineSchema>;
export type Ticket = z.infer<typeof D.TicketSchema>;
export type PrqLine = z.infer<typeof D.PrqLineSchema>;
export type Requisition = z.infer<typeof D.RequisitionSchema>;
export type PoLineSrc = z.infer<typeof D.PoLineSrcSchema>;
export type PoLine = z.infer<typeof D.PoLineSchema>;
export type PurchaseOrder = z.infer<typeof D.PurchaseOrderSchema>;
export type ProdOrder = z.infer<typeof D.ProdOrderSchema>;
export type Batch = z.infer<typeof D.BatchSchema>;
export type Payer = z.infer<typeof D.PayerSchema>;
export type ReceiptLine = z.infer<typeof D.ReceiptLineSchema>;
export type ReceiptDoc = z.infer<typeof D.ReceiptDocSchema>;
export type Grn = z.infer<typeof D.GrnSchema>;
export type BillLine = z.infer<typeof D.BillLineSchema>;
export type Bill = z.infer<typeof D.BillSchema>;
export type DraftLine = z.infer<typeof D.DraftLineSchema>;
export type Availability = z.infer<typeof D.AvailabilitySchema>;
export type Price = z.infer<typeof D.PriceSchema>;
export type DrawerState = z.infer<typeof D.DrawerStateSchema>;
export type Vendor = z.infer<typeof D.VendorSchema>;
export type TicketMessage = z.infer<typeof D.TicketMessageSchema>;
export type SupportTicket = z.infer<typeof D.SupportTicketSchema>;
export type ProductRequest = z.infer<typeof D.ProductRequestSchema>;
export type RateContract = z.infer<typeof D.RateContractSchema>;
export type ShopAsk = z.infer<typeof D.ShopAskSchema>;
```
Keep the doc comments from the old file on the schemas (`/** Six digits quoted at handover … */` on `otp`, etc.).

`packages/contract/src/schemas/documents.test.ts` — the fixtures must satisfy their schemas:
```ts
import { describe, expect, it } from "vitest";
import * as FX from "../fixtures";
import * as D from "./documents";

const all = <T>(schema: { safeParse(v: unknown): { success: boolean; error?: unknown } }, rows: T[], label: string) => {
  for (const r of rows) { const p = schema.safeParse(r); expect(p.success, `${label}: ${JSON.stringify(p.error ?? "").slice(0, 300)}`).toBe(true); }
};
describe("fixtures satisfy the document schemas", () => {
  it("master", () => {
    all(D.ItemSchema, Object.values(FX.IT), "item"); all(D.LocationSchema, Object.values(FX.LOC), "location");
    all(D.UserSchema, FX.USERS, "user"); all(D.RecipeSchema, Object.values(FX.RCP), "recipe"); all(D.VendorSchema, FX.seedVendors, "vendor");
  });
  it("documents", () => {
    all(D.StockRequestSchema, FX.seedReq, "req"); all(D.TicketSchema, FX.seedTkt, "tkt"); all(D.RequisitionSchema, FX.seedPrq, "prq");
    all(D.PurchaseOrderSchema, FX.seedPo, "po"); all(D.GrnSchema, FX.seedGrn, "grn"); all(D.ProdOrderSchema, FX.seedPord, "pord");
    all(D.BatchSchema, FX.seedBatch, "batch"); all(D.BillSchema, FX.seedBills, "bill"); all(D.SupportTicketSchema, FX.seedTickets(), "support");
    all(D.ProductRequestSchema, FX.seedProductRequests(), "npr"); all(D.RateContractSchema, FX.seedContracts(), "rc"); all(D.ShopAskSchema, FX.seedShopAsks(), "ask");
  });
});
```
Run: `pnpm --filter @rch/contract test` — Expected: PASS. (Fixture `at` fields are `"06:30"` strings and `IsoTime` is a plain `z.string()`, so they pass; the API always sends ISO.)

- [ ] **Step 2: Auth, snapshot and route schemas; the manifest**

`packages/contract/src/schemas/auth.ts`:
```ts
import { z } from "zod";
import { UserSchema } from "./documents";

export const LoginBodySchema = z.object({ emp: z.string().trim().min(1), password: z.string().min(1) });
export const AuthResponseSchema = z.object({ accessToken: z.string(), user: UserSchema, mustChangePassword: z.boolean() });
export const ChangePasswordBodySchema = z.object({ current: z.string().min(1), next: z.string().min(10).max(200) });
export const PatchMeBodySchema = z.object({ n: z.string().trim().min(1).optional(), e: z.email().optional(), ph: z.string().trim().min(5).optional() }).strict();
export const MeResponseSchema = z.object({ user: UserSchema, mustChangePassword: z.boolean() });
```

`packages/contract/src/schemas/snapshot.ts`:
```ts
import { z } from "zod";
import { LocKeySchema, Qty } from "./common";
import * as D from "./documents";

const byLoc = <T extends z.ZodTypeAny>(v: T) => z.record(LocKeySchema, v);
export const SnapshotSchema = z.object({
  user: D.UserSchema,
  items: z.record(z.string(), D.ItemSchema),
  locations: z.record(z.string(), D.LocationSchema),
  recipes: z.record(z.string(), D.RecipeSchema),
  users: z.array(D.UserSchema),
  stock: byLoc(z.record(z.string(), Qty)),
  rsv: z.record(z.string(), Qty),          // "loc:item" -> reserved
  ovr: z.record(z.string(), z.string()),   // "loc:item" -> reason
  prices: z.object({ A: z.record(z.string(), z.number()), B: z.record(z.string(), z.number()) }),
  menu: z.record(z.string(), z.array(z.string())),
  req: z.array(D.StockRequestSchema),
  tkt: z.array(D.TicketSchema),
  prq: z.array(D.RequisitionSchema),
  po: z.array(D.PurchaseOrderSchema),
  pord: z.array(D.ProdOrderSchema),
  batch: z.array(D.BatchSchema),
  bills: z.array(D.BillSchema),
  grn: z.array(D.GrnSchema),
  vendors: z.array(D.VendorSchema),
  contracts: z.array(D.RateContractSchema),
  tickets: z.array(D.SupportTicketSchema),
  productReqs: z.array(D.ProductRequestSchema),
  shopAsks: z.array(D.ShopAskSchema),
  sales: z.array(z.array(z.number())),
  dayLabels: z.array(z.string()),
});
export const ItemsResponseSchema = z.record(z.string(), D.ItemSchema);
export const LocationsResponseSchema = z.record(z.string(), D.LocationSchema);
export const RecipesResponseSchema = z.record(z.string(), D.RecipeSchema);
export const PricesResponseSchema = SnapshotSchema.shape.prices;
export const MenusResponseSchema = SnapshotSchema.shape.menu;
```

`packages/contract/src/routes.ts`:
```ts
import { z } from "zod";
import type { Role } from "./types";
import { OkResponseSchema } from "./schemas/common";
import { AuthResponseSchema, ChangePasswordBodySchema, LoginBodySchema, MeResponseSchema, PatchMeBodySchema } from "./schemas/auth";
import { ItemsResponseSchema, LocationsResponseSchema, MenusResponseSchema, PricesResponseSchema, RecipesResponseSchema, SnapshotSchema } from "./schemas/snapshot";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
/** "public" needs no token; "any" needs a token of any role; a list names the roles whose sidebar has the module. */
export type Access = "public" | "any" | readonly Role[];

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

export const routes = {
  login:          defineRoute({ method: "POST",  path: "/auth/login",           access: "public", body: LoginBodySchema, response: AuthResponseSchema, write: false, allowMcp: true }),
  refresh:        defineRoute({ method: "POST",  path: "/auth/refresh",         access: "public", response: AuthResponseSchema, write: false, allowMcp: true }),
  logout:         defineRoute({ method: "POST",  path: "/auth/logout",          access: "public", response: OkResponseSchema, write: false, allowMcp: true }),
  changePassword: defineRoute({ method: "POST",  path: "/auth/change-password", access: "any",    body: ChangePasswordBodySchema, response: OkResponseSchema, write: false, allowMcp: true }),
  me:             defineRoute({ method: "GET",   path: "/me",                   access: "any",    response: MeResponseSchema, allowMcp: true }),
  patchMe:        defineRoute({ method: "PATCH", path: "/me",                   access: "any",    body: PatchMeBodySchema, response: MeResponseSchema, allowMcp: true }),
  snapshot:       defineRoute({ method: "GET",   path: "/snapshot",             access: "any",    response: SnapshotSchema }),
  items:          defineRoute({ method: "GET",   path: "/items",                access: "any",    response: ItemsResponseSchema }),
  locations:      defineRoute({ method: "GET",   path: "/locations",            access: "any",    response: LocationsResponseSchema }),
  recipes:        defineRoute({ method: "GET",   path: "/recipes",              access: "any",    response: RecipesResponseSchema }),
  prices:         defineRoute({ method: "GET",   path: "/prices",               access: "any",    response: PricesResponseSchema }),
  menus:          defineRoute({ method: "GET",   path: "/menus",                access: "any",    response: MenusResponseSchema }),
} as const;
export type RouteName = keyof typeof routes;
export const API_PREFIX = "/api/v1";
```

`packages/contract/src/index.ts`:
```ts
export type * from "./types";
export * from "./schemas/common";
export * from "./schemas/documents";
export * from "./schemas/auth";
export * from "./schemas/snapshot";
export * from "./routes";
```
Run: `pnpm turbo typecheck test --filter=@rch/contract --filter=@rch/ui` — Expected: PASS; UI types resolve through the new aliases with no screen edits. If TypeScript reports a mismatch in a UI file (e.g. a `rating` literal), fix the **schema** to match the old interface, not the UI.

- [ ] **Step 3: Auth and RBAC plugins**

`apps/api/src/plugins/auth.ts`:
```ts
import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import type { LocKey, Role } from "@rch/contract";
import type { Config } from "../config";
import { UnauthenticatedError } from "../lib/errors";

export type AccessClaims = { sub: string; role: Role; loc: LocKey; mcp: boolean };
declare module "@fastify/jwt" { interface FastifyJWT { payload: AccessClaims; user: AccessClaims } }
declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
    signAccess: (u: { id: string; role: Role; loc: LocKey; mcp: boolean }) => Promise<string>;
  }
}

export default fp<{ config: Config }>(async (app, { config }) => {
  await app.register(cookie);
  await app.register(jwt, {
    secret: { private: config.jwt.privateKeyPem, public: config.jwt.publicKeyPem },
    sign: { algorithm: "EdDSA", expiresIn: config.accessTokenTtl, iss: "rch-api" },
    verify: { algorithms: ["EdDSA"], allowedIss: "rch-api" },
  });
  // A rotated-out key is still accepted for verification for a day (spec §8.2).
  const previous = config.jwt.previousPublicKeyPem;
  app.decorate("authenticate", async (req) => {
    try { await req.jwtVerify(); }
    catch (e) {
      if (previous) {
        try { req.user = app.jwt.verify<AccessClaims>(extractBearer(req.headers.authorization), { key: previous } as never); return; } catch { /* fall through */ }
      }
      const code = (e as { code?: string }).code;
      throw new UnauthenticatedError(code === "FST_JWT_AUTHORIZATION_TOKEN_EXPIRED" ? "Your session has expired - sign in again." : "Sign in to continue.");
    }
  });
  app.decorate("signAccess", (u) => app.jwt.sign({ sub: u.id, role: u.role, loc: u.loc, mcp: u.mcp }));
}, { name: "auth", dependencies: ["errors"] });

function extractBearer(h: string | undefined): string {
  const m = /^Bearer (.+)$/.exec(h ?? "");
  if (!m) throw new UnauthenticatedError();
  return m[1];
}
```
If `@fastify/jwt`'s `verify(token, options)` does not accept a `key` override in v10, implement the previous-key fallback with `fast-jwt`'s `createVerifier({ key: previous, algorithms: ["EdDSA"] })` — `fast-jwt` is a dependency of `@fastify/jwt`; add it explicitly to `apps/api/package.json` if you use it.

`apps/api/src/plugins/rbac.ts`:
```ts
import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Access } from "@rch/contract";
import type { LocKey } from "@rch/contract";
import { ForbiddenError, NotFoundError } from "../lib/errors";

declare module "fastify" {
  interface FastifyInstance { roleGate: (access: Access, allowMcp: boolean) => (req: FastifyRequest, reply: FastifyReply) => Promise<void> }
}

/** Role decides whether the route exists for you (404, like the sidebar); location decides which rows (403). */
export default fp(async (app) => {
  app.decorate("roleGate", (access: Access, allowMcp: boolean) => async (req: FastifyRequest) => {
    if (access === "public") return;
    if (Array.isArray(access) && !access.includes(req.user.role)) throw new NotFoundError(`There is nothing at ${req.method} ${req.url}.`);
    if (req.user.mcp && !allowMcp) throw new ForbiddenError("Change your password before you carry on.");
  });
}, { name: "rbac", dependencies: ["auth"] });

/** For location-scoped writes: the caller's location must be the row's. */
export function requireLoc(req: FastifyRequest, loc: LocKey | string, what = "that location"): void {
  if (req.user.loc !== loc) throw new ForbiddenError(`You can only do this for ${what}.`);
}
```

- [ ] **Step 4: The mount and module stubs**

`apps/api/src/routes.ts`:
```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { API_PREFIX, type AnyRoute, type Route } from "@rch/contract";
import type { App } from "./app";

type Infer<T> = T extends z.ZodTypeAny ? z.infer<T> : undefined;
export type Req<R extends AnyRoute> = FastifyRequest<{
  Params: R extends Route<infer P, z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny> ? Infer<P> : never;
  Querystring: R extends Route<z.ZodTypeAny, infer Q, z.ZodTypeAny, z.ZodTypeAny> ? Infer<Q> : never;
  Body: R extends Route<z.ZodTypeAny, z.ZodTypeAny, infer B, z.ZodTypeAny> ? Infer<B> : never;
}>;
export type Res<R extends AnyRoute> = z.infer<R["response"]>;
export type Handler<R extends AnyRoute> = (req: Req<R>, reply: FastifyReply) => Promise<Res<R>>;

/**
 * The only way a module registers a route. The manifest entry supplies method, path, schemas
 * and access; the module supplies the handler. Auth and role gating are attached here, so a
 * handler cannot forget them. Idempotency (Task 10) is attached here too, for `write` routes.
 */
export function mount<R extends AnyRoute>(app: App, route: R, handler: Handler<R>): void {
  const isWrite = route.write ?? route.method !== "GET";
  const pre: Array<(req: FastifyRequest, reply: FastifyReply) => Promise<void>> = [];
  if (route.access !== "public") pre.push(app.authenticate, app.roleGate(route.access, route.allowMcp ?? false));
  app.route({
    method: route.method,
    url: API_PREFIX + route.path,
    schema: { params: route.params, querystring: route.query, body: route.body, response: { 200: route.response } },
    preHandler: pre,
    config: { write: isWrite },
    handler: handler as never,
  });
}
```

`apps/api/src/modules/index.ts`:
```ts
import type { App } from "../app";
import auth from "./auth/routes";
import me from "./me/routes";
import master from "./master/routes";
import snapshot from "./snapshot/routes";

/** Every module, registered in one place. Adding a module = one import + one line here. */
export async function registerModules(app: App): Promise<void> {
  await app.register(auth);
  await app.register(me);
  await app.register(master);
  await app.register(snapshot);
}
```
Each of `apps/api/src/modules/{auth,me,master,snapshot}/routes.ts` starts as a stub that Tasks 9–13 replace:
```ts
import fp from "fastify-plugin";
export default fp(async () => { /* Task N */ }, { name: "module:<name>" });
```

`apps/api/src/app.ts` — after `db`, register `auth`, `rbac`, then `await registerModules(app)`.

`apps/api/src/lib/wire.ts` — row → wire mappers that more than one module needs (modules never import each other):
```ts
import type { User } from "@rch/contract";
import type { users } from "../db/schema";

export type UserRow = typeof users.$inferSelect;
export const toWireUser = (u: UserRow): User => ({
  id: u.id, n: u.name, e: u.email, r: u.role, rl: u.roleLabel, loc: u.loc as User["loc"], col: u.colour, emp: u.empNo, ph: u.phone,
});
```

`mount()` also accepts route-level Fastify config so a module can tighten a rate limit without touching the plugin:
```ts
export function mount<R extends AnyRoute>(app: App, route: R, handler: Handler<R>, extra: { config?: Record<string, unknown> } = {}): void {
  // … as above, with:  config: { write: isWrite, ...extra.config },
}
```

`apps/api/src/test/auth.ts`:
```ts
import { eq } from "drizzle-orm";
import type { App } from "../app";
import { users } from "../db/schema";
/** A bearer header for a seeded user, minted directly — tests of non-auth modules need not run the login flow. */
export async function authHeaders(app: App, userId: string): Promise<{ authorization: string }> {
  const [u] = await app.db.select().from(users).where(eq(users.id, userId));
  if (!u) throw new Error(`no user ${userId} - did you seed?`);
  const token = await app.signAccess({ id: u.id, role: u.role, loc: u.loc as never, mcp: u.mustChangePassword });
  return { authorization: `Bearer ${token}` };
}
```

- [ ] **Step 5: Tests for the mount and gates**

`apps/api/src/routes.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineRoute, routes } from "@rch/contract";
import { buildTestApp } from "./test/app";
import { seedTestDb } from "./test/seed";
import { authHeaders } from "./test/auth";
import { mount } from "./routes";
import type { App } from "./app";

let app: App;
beforeAll(async () => {
  app = await buildTestApp({ schema: "routes" });
  await seedTestDb(app.testDb!.db);
  mount(app, defineRoute({ method: "GET", path: "/_test/any", access: "any", response: z.object({ who: z.string() }) }), async (req) => ({ who: req.user.sub }));
  mount(app, defineRoute({ method: "GET", path: "/_test/buyer", access: ["buyer"], response: z.object({ ok: z.literal(true) }) }), async () => ({ ok: true as const }));
  mount(app, defineRoute({ method: "GET", path: "/_test/public", access: "public", response: z.object({ ok: z.literal(true) }) }), async () => ({ ok: true as const }));
  await app.ready();
});
afterAll(async () => { await app.close(); });

describe("manifest", () => {
  it("has unique method+path pairs and API_PREFIX-relative paths", () => {
    const seen = new Set<string>();
    for (const r of Object.values(routes)) { const k = `${r.method} ${r.path}`; expect(seen.has(k), k).toBe(false); seen.add(k); expect(r.path.startsWith("/")).toBe(true); }
  });
});
describe("mount", () => {
  it("public routes need no token", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/_test/public" })).statusCode).toBe(200);
  });
  it("'any' routes need a valid token and expose the caller", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/_test/any" })).statusCode).toBe(401);
    const r = await app.inject({ method: "GET", url: "/api/v1/_test/any", headers: await authHeaders(app, "u1") });
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ who: "u1" });
  });
  it("role-scoped routes are 404 for other roles - the module is absent, like the sidebar", async () => {
    const counter = await app.inject({ method: "GET", url: "/api/v1/_test/buyer", headers: await authHeaders(app, "u1") });
    expect(counter.statusCode).toBe(404); expect(counter.json().error.code).toBe("not_found");
    const buyer = await app.inject({ method: "GET", url: "/api/v1/_test/buyer", headers: await authHeaders(app, "u5") });
    expect(buyer.statusCode).toBe(200);
  });
  it("rejects a token signed with a different key", async () => {
    const other = await buildTestApp({ withDb: false });
    const token = await other.signAccess({ id: "u1", role: "counter", loc: "coffee", mcp: false });
    await other.close();
    const r = await app.inject({ method: "GET", url: "/api/v1/_test/any", headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(401);
  });
});
```
The "different key" test needs `buildTestApp` to generate a **fresh** key pair per call: change `apps/api/src/test/app.ts` so the key pair is generated inside `testConfig()` unless `opts.env` supplies keys.

Run: `pnpm turbo typecheck lint test` — Expected: PASS across all packages.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Declare every route once and gate it once

The contract now carries a Zod schema for every document and a manifest
of every endpoint; the server mounts the manifest with auth and role
gating attached, so a module can only add a handler, never a hole.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 9: Auth module — login, refresh rotation, logout, change-password

**Files:**
- Create: `apps/api/src/modules/auth/repo.ts`, `apps/api/src/modules/auth/service.ts`, `apps/api/src/modules/auth/cookies.ts`
- Modify: `apps/api/src/modules/auth/routes.ts` (replace the stub)
- Test: `apps/api/src/modules/auth/auth.test.ts`

**Interfaces:**
- Consumes: `routes.login/refresh/logout/changePassword` (Task 8), `mount`, `app.signAccess`, `verifyPassword`/`hashPassword` (Task 7), `toWireUser` (Task 8), `withTransaction`.
- Produces: `AuthService` with `login(emp, password, meta)`, `refresh(rawToken, meta)`, `logout(rawToken)`, `changePassword(userId, current, next)`; cookie name `rch_refresh`, path `/api/v1/auth`.
- Refresh tokens: 32 random bytes, base64url on the wire, SHA-256 hex in the table. A family is one device's chain; presenting an already-used token revokes the family.

- [ ] **Step 1: Failing tests**

`apps/api/src/modules/auth/auth.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp } from "../../test/app";
import { seedTestDb } from "../../test/seed";
import type { App } from "../../app";
import { refreshTokens, users } from "../../db/schema";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "auth" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

const login = (emp = "RC-4471", password = "changeme") => app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { emp, password } });
const cookieOf = (r: { cookies: Array<{ name: string; value: string }> }) => r.cookies.find((c) => c.name === "rch_refresh")!;

describe("login", () => {
  it("returns an access token and the wire user, and sets the refresh cookie", async () => {
    const r = await login();
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.user).toMatchObject({ id: "u1", n: "Kavitha Raman", r: "counter", loc: "coffee", emp: "RC-4471" });
    expect(body.mustChangePassword).toBe(false);
    expect(typeof body.accessToken).toBe("string");
    const c = cookieOf(r);
    expect(c).toBeDefined();
    expect(r.headers["set-cookie"]).toMatch(/HttpOnly/);
    expect(r.headers["set-cookie"]).toMatch(/SameSite=Strict/);
    expect(r.headers["set-cookie"]).toMatch(/Path=\/api\/v1\/auth/);
  });
  it("refuses a wrong password and an unknown employee with the same message", async () => {
    const a = await login("RC-4471", "nope"); const b = await login("RC-0000", "changeme");
    expect(a.statusCode).toBe(401); expect(b.statusCode).toBe(401);
    expect(a.json().error.message).toBe(b.json().error.message);
  });
  it("refuses a deactivated user", async () => {
    await app.db.update(users).set({ active: false }).where(eq(users.id, "u6"));
    expect((await login("RC-4482")).statusCode).toBe(401);
  });
  it("rate-limits repeated failures per employee id", async () => {
    for (let i = 0; i < 5; i++) await login("RC-3120", "wrong");
    const r = await login("RC-3120", "changeme");
    expect(r.statusCode).toBe(429);
  });
});

describe("refresh", () => {
  it("rotates: new access + new cookie, old cookie is dead, reuse revokes the family", async () => {
    const first = await login("RC-2088");
    const c1 = cookieOf(first).value;
    const r2 = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: c1 } });
    expect(r2.statusCode).toBe(200);
    const c2 = cookieOf(r2).value;
    expect(c2).not.toBe(c1);
    // replaying the used token is reuse: family revoked, and the fresh token dies with it
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: c1 } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: c2 } })).statusCode).toBe(401);
    const rows = await app.db.select().from(refreshTokens).where(eq(refreshTokens.userId, "u3"));
    expect(rows.every((t) => t.revokedAt !== null)).toBe(true);
  });
  it("refuses without a cookie", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/refresh" })).statusCode).toBe(401);
  });
});

describe("logout and change-password", () => {
  it("logout revokes the family and clears the cookie", async () => {
    const l = await login("RC-1902");
    const c = cookieOf(l).value;
    const out = await app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { rch_refresh: c } });
    expect(out.statusCode).toBe(200);
    expect(out.headers["set-cookie"]).toMatch(/rch_refresh=;/);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: c } })).statusCode).toBe(401);
  });
  it("change-password needs the current password, then the old one stops working", async () => {
    const l = await login("RC-1550");
    const h = { authorization: `Bearer ${l.json().accessToken}` };
    const bad = await app.inject({ method: "POST", url: "/api/v1/auth/change-password", headers: h, payload: { current: "wrong", next: "a-much-longer-secret" } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/api/v1/auth/change-password", headers: h, payload: { current: "changeme", next: "a-much-longer-secret" } });
    expect(ok.statusCode).toBe(200);
    expect((await login("RC-1550", "changeme")).statusCode).toBe(401);
    expect((await login("RC-1550", "a-much-longer-secret")).statusCode).toBe(200);
  });
  it("a must-change user can reach /me and change-password but not /snapshot", async () => {
    await app.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, "u2"));
    const l = await login("RC-3120");
    expect(l.json().mustChangePassword).toBe(true);
    const h = { authorization: `Bearer ${l.json().accessToken}` };
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: h })).statusCode).toBe(200);
    const snap = await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: h });
    expect(snap.statusCode).toBe(403);
    expect(snap.json().error.message).toMatch(/password/i);
  });
});
```
Note: the rate-limit test for `RC-3120` and the must-change test both use `u2`; run the must-change test in its own `describe` **before** the rate-limit one, or use `RC-4482`/`u6` for must-change and move the deactivation test to use a fresh login of a different user. Keep each user touched by only one test that mutates it.

Run: `pnpm --filter @rch/api test src/modules/auth` — Expected: FAIL (`/me` and `/snapshot` return 404 until Tasks 10/11 land — those two assertions are the only ones allowed to stay red until then; everything else must be green in this task).

- [ ] **Step 2: Repo, cookies, service**

`apps/api/src/modules/auth/repo.ts`:
```ts
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import type { Tx } from "../../lib/db";
import { refreshTokens, users } from "../../db/schema";

export const authRepo = {
  userByEmp: async (db: Db | Tx, emp: string) => (await db.select().from(users).where(eq(users.empNo, emp)))[0],
  userById: async (db: Db | Tx, id: string) => (await db.select().from(users).where(eq(users.id, id)))[0],
  insertRefresh: (tx: Tx, v: { userId: string; family: string; tokenHash: string; expiresAt: Date; userAgent?: string; ip?: string }) => tx.insert(refreshTokens).values(v),
  refreshByHash: async (db: Db | Tx, tokenHash: string) => (await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)))[0],
  markUsed: (tx: Tx, id: string) => tx.update(refreshTokens).set({ usedAt: new Date() }).where(eq(refreshTokens.id, id)),
  revokeFamily: (tx: Tx, family: string) => tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.family, family), isNull(refreshTokens.revokedAt))),
  revokeAllForUser: (tx: Tx, userId: string) => tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt))),
  setPassword: (tx: Tx, userId: string, passwordHash: string) => tx.update(users).set({ passwordHash, mustChangePassword: false, updatedAt: new Date() }).where(eq(users.id, userId)),
};
```

`apps/api/src/modules/auth/cookies.ts`:
```ts
import type { FastifyReply } from "fastify";
import type { Config } from "../../config";
export const REFRESH_COOKIE = "rch_refresh";
const PATH = "/api/v1/auth";
export const setRefreshCookie = (reply: FastifyReply, config: Config, value: string) =>
  reply.setCookie(REFRESH_COOKIE, value, { httpOnly: true, secure: config.cookieSecure, sameSite: "strict", path: PATH, maxAge: config.refreshTokenTtlDays * 86400 });
export const clearRefreshCookie = (reply: FastifyReply, config: Config) =>
  reply.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: config.cookieSecure, sameSite: "strict", path: PATH });
```

`apps/api/src/modules/auth/service.ts`:
```ts
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { User } from "@rch/contract";
import type { Db } from "../../db/client";
import type { Config } from "../../config";
import { withTransaction } from "../../lib/db";
import { RateLimitedError, UnauthenticatedError } from "../../lib/errors";
import { hashPassword, verifyPassword } from "../../lib/password";
import { toWireUser } from "../../lib/wire";
import { authRepo } from "./repo";

export type Meta = { userAgent?: string; ip?: string };
export type Session = { user: User; mustChangePassword: boolean; refreshToken: string; claims: { id: string; role: User["r"]; loc: User["loc"]; mcp: boolean } };

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const newRaw = () => randomBytes(32).toString("base64url");
const BAD_LOGIN = "That employee id and password do not match.";

/** Per-employee sliding window, in memory. Per pod, which is fine: the per-IP limit is cluster-wide via the LB. */
class Attempts {
  private m = new Map<string, number[]>();
  constructor(private max: number, private windowMs = 60_000) {}
  hit(key: string): boolean {
    const now = Date.now(); const a = (this.m.get(key) ?? []).filter((t) => now - t < this.windowMs);
    a.push(now); this.m.set(key, a); return a.length > this.max;
  }
  clear(key: string) { this.m.delete(key); }
}

export function createAuthService(db: Db, config: Config) {
  const attempts = new Attempts(Math.max(1, Math.floor(config.loginRateLimitPerMinute / 2)));
  const expiry = () => new Date(Date.now() + config.refreshTokenTtlDays * 86400_000);

  async function issue(tx: Parameters<Parameters<typeof withTransaction>[1]>[0], u: NonNullable<Awaited<ReturnType<typeof authRepo.userById>>>, family: string, meta: Meta): Promise<Session> {
    const raw = newRaw();
    await authRepo.insertRefresh(tx, { userId: u.id, family, tokenHash: sha256(raw), expiresAt: expiry(), userAgent: meta.userAgent, ip: meta.ip });
    return { user: toWireUser(u), mustChangePassword: u.mustChangePassword, refreshToken: raw, claims: { id: u.id, role: u.role, loc: u.loc as User["loc"], mcp: u.mustChangePassword } };
  }

  return {
    async login(emp: string, password: string, meta: Meta): Promise<Session> {
      if (attempts.hit(emp)) throw new RateLimitedError("Too many attempts for that employee id - wait a minute and try again.");
      const u = await authRepo.userByEmp(db, emp);
      const ok = u ? await verifyPassword(u.passwordHash, password) : (await verifyPassword("$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", password), false);
      if (!u || !ok || !u.active) throw new UnauthenticatedError(BAD_LOGIN);
      attempts.clear(emp);
      return withTransaction(db, (tx) => issue(tx, u, randomUUID(), meta));
    },
    async refresh(raw: string | undefined, meta: Meta): Promise<Session> {
      if (!raw) throw new UnauthenticatedError("Your session has ended - sign in again.");
      return withTransaction(db, async (tx) => {
        const t = await authRepo.refreshByHash(tx, sha256(raw));
        if (!t || t.revokedAt) throw new UnauthenticatedError("Your session has ended - sign in again.");
        if (t.usedAt) { await authRepo.revokeFamily(tx, t.family); throw new UnauthenticatedError("Your session was used from somewhere else and has been closed - sign in again."); }
        if (t.expiresAt < new Date()) throw new UnauthenticatedError("Your session has expired - sign in again.");
        const u = await authRepo.userById(tx, t.userId);
        if (!u || !u.active) throw new UnauthenticatedError("Your session has ended - sign in again.");
        await authRepo.markUsed(tx, t.id);
        return issue(tx, u, t.family, meta);
      });
    },
    async logout(raw: string | undefined): Promise<void> {
      if (!raw) return;
      await withTransaction(db, async (tx) => { const t = await authRepo.refreshByHash(tx, sha256(raw)); if (t) await authRepo.revokeFamily(tx, t.family); });
    },
    async changePassword(userId: string, current: string, next: string): Promise<void> {
      const u = await authRepo.userById(db, userId);
      if (!u || !(await verifyPassword(u.passwordHash, current))) throw new UnauthenticatedError("Your current password is not right.");
      const hash = await hashPassword(next);
      await withTransaction(db, async (tx) => { await authRepo.setPassword(tx, userId, hash); await authRepo.revokeAllForUser(tx, userId); });
    },
  };
}
export type AuthService = ReturnType<typeof createAuthService>;
```
(The dummy Argon2 verify on an unknown employee keeps the timing of "no such user" close to "wrong password"; the constant is any valid Argon2id string — copy one produced by `hashPassword("x")` once and paste it.)

- [ ] **Step 3: Routes**

`apps/api/src/modules/auth/routes.ts`:
```ts
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes";
import { createAuthService } from "./service";
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from "./cookies";
import type { Config } from "../../config";

declare module "fastify" { interface FastifyInstance { config: Config } }

export default fp(async (app) => {
  const svc = createAuthService(app.db, app.config);
  const meta = (req: { headers: Record<string, unknown>; ip: string }) => ({ userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200), ip: req.ip });
  const respond = async (reply: import("fastify").FastifyReply, s: Awaited<ReturnType<typeof svc.login>>) => {
    setRefreshCookie(reply, app.config, s.refreshToken);
    return { accessToken: await app.signAccess(s.claims), user: s.user, mustChangePassword: s.mustChangePassword };
  };
  mount(app, routes.login, async (req, reply) => respond(reply, await svc.login(req.body.emp, req.body.password, meta(req))),
    { config: { rateLimit: { max: app.config.loginRateLimitPerMinute, timeWindow: "1 minute" } } });
  mount(app, routes.refresh, async (req, reply) => respond(reply, await svc.refresh(req.cookies[REFRESH_COOKIE], meta(req))));
  mount(app, routes.logout, async (req, reply) => { await svc.logout(req.cookies[REFRESH_COOKIE]); clearRefreshCookie(reply, app.config); return { ok: true as const }; });
  mount(app, routes.changePassword, async (req) => { await svc.changePassword(req.user.sub, req.body.current, req.body.next); return { ok: true as const }; });
}, { name: "module:auth", dependencies: ["auth", "rbac", "db"] });
```
`app.config` must exist: in `apps/api/src/app.ts`, `app.decorate("config", config)` right after creating the instance (before plugins).

Run: `pnpm --filter @rch/api test src/modules/auth` — Expected: PASS except the two `/me` + `/snapshot` assertions if Tasks 10/11 have not landed yet; `pnpm turbo typecheck lint` clean.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Sign staff in for real

Employee id and Argon2id password, a short-lived EdDSA access token, and a
rotating refresh cookie whose reuse closes the whole device session.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 10: `/me` module and the idempotency plugin

**Files:**
- Create: `apps/api/src/plugins/idempotency.ts`, `apps/api/src/modules/me/repo.ts`, `apps/api/src/modules/me/service.ts`, `apps/api/src/cli/purge.ts`
- Modify: `apps/api/src/modules/me/routes.ts` (replace the stub), `apps/api/src/routes.ts` (attach idempotency to write routes), `apps/api/src/app.ts` (register plugin), `apps/api/tsup.config.ts` (add `cli/purge` entry)
- Test: `apps/api/src/modules/me/me.test.ts`, `apps/api/src/plugins/idempotency.test.ts`

**Interfaces:**
- Consumes: `routes.me/patchMe`, `mount`, `authHeaders`, `toWireUser`, `idempotencyKeys` table.
- Produces: `app.idempotency` preHandler (attached by `mount` when `write`); header `Idempotency-Key` (UUID v4) required on writes; replay returns the stored status/body with `Idempotency-Replayed: true`; same key + different body → 409 `conflict`. `purgeIdempotencyKeys(db): Promise<number>` and CLI `cli/purge.ts`.
- `PATCH /me` is the first write route and proves the plugin end to end.

- [ ] **Step 1: Failing tests**

`apps/api/src/modules/me/me.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildTestApp } from "../../test/app";
import { seedTestDb } from "../../test/seed";
import { authHeaders } from "../../test/auth";
import type { App } from "../../app";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "me" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("/me", () => {
  it("returns the caller in wire shape", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/me", headers: await authHeaders(app, "u3") });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ user: { id: "u3", n: "Suresh Muthu", e: "suresh.m@royalcare.in", r: "store", rl: "Store Keeper", loc: "store", col: "#0F766E", emp: "RC-2088", ph: "94430 51194" }, mustChangePassword: false });
  });
  it("PATCH updates display fields only and refuses unknown keys", async () => {
    const h = { ...(await authHeaders(app, "u3")), "idempotency-key": randomUUID() };
    const ok = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "90000 00000" } });
    expect(ok.statusCode).toBe(200); expect(ok.json().user.ph).toBe("90000 00000");
    const bad = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: { ...h, "idempotency-key": randomUUID() }, payload: { r: "buyer" } });
    expect(bad.statusCode).toBe(400); expect(bad.json().error.code).toBe("validation");
  });
});
```

`apps/api/src/plugins/idempotency.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildTestApp } from "../test/app";
import { seedTestDb } from "../test/seed";
import { authHeaders } from "../test/auth";
import type { App } from "../app";
import { purgeIdempotencyKeys } from "./idempotency";
import { idempotencyKeys } from "../db/schema";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "idem" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("Idempotency-Key", () => {
  it("is required on writes", async () => {
    const r = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: await authHeaders(app, "u1"), payload: { ph: "1" } });
    expect(r.statusCode).toBe(400); expect(r.json().error.message).toMatch(/Idempotency-Key/);
  });
  it("replays the stored response for the same key and body", async () => {
    const key = randomUUID(); const h = { ...(await authHeaders(app, "u1")), "idempotency-key": key };
    const a = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "11111 11111" } });
    const b = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "11111 11111" } });
    expect(b.statusCode).toBe(a.statusCode); expect(b.body).toBe(a.body); expect(b.headers["idempotency-replayed"]).toBe("true");
    expect(a.headers["idempotency-replayed"]).toBeUndefined();
  });
  it("refuses the same key with a different body", async () => {
    const key = randomUUID(); const h = { ...(await authHeaders(app, "u1")), "idempotency-key": key };
    await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "22222 22222" } });
    const r = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "33333 33333" } });
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe("conflict");
  });
  it("keys are per user", async () => {
    const key = randomUUID();
    const a = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: { ...(await authHeaders(app, "u1")), "idempotency-key": key }, payload: { ph: "4" } });
    const b = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: { ...(await authHeaders(app, "u2")), "idempotency-key": key }, payload: { ph: "4" } });
    expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200); expect(b.headers["idempotency-replayed"]).toBeUndefined();
  });
  it("purge removes expired rows only", async () => {
    await app.db.update(idempotencyKeys).set({ expiresAt: new Date(Date.now() - 1000) });
    const n = await purgeIdempotencyKeys(app.db);
    expect(n).toBeGreaterThan(0);
    expect((await app.db.select().from(idempotencyKeys)).length).toBe(0);
  });
});
```
Run: `pnpm --filter @rch/api test src/modules/me src/plugins/idempotency` — Expected: FAIL.

- [ ] **Step 2: The plugin**

`apps/api/src/plugins/idempotency.ts`:
```ts
import fp from "fastify-plugin";
import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client";
import { idempotencyKeys } from "../db/schema";
import { ConflictError, ValidationError } from "../lib/errors";

declare module "fastify" {
  interface FastifyInstance { idempotency: (req: FastifyRequest, reply: FastifyReply) => Promise<void> }
  interface FastifyRequest { idem?: { key: string; userId: string; hash: string } }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TTL_MS = 24 * 3600_000;
const hashOf = (req: FastifyRequest) => createHash("sha256").update(`${req.method} ${req.url}\n${JSON.stringify(req.body ?? null)}`).digest("hex");

export default fp(async (app) => {
  app.decorate("idempotency", async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.headers["idempotency-key"];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key || !UUID.test(key)) throw new ValidationError("Every write needs an Idempotency-Key header holding a UUID.");
    const userId = req.user.sub; const hash = hashOf(req);
    const [hit] = await app.db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.userId, userId)));
    if (hit) {
      if (hit.requestHash !== hash) throw new ConflictError("That Idempotency-Key was already used for a different request.");
      reply.header("idempotency-replayed", "true").code(hit.statusCode).send(hit.response);
      return;
    }
    req.idem = { key, userId, hash };
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (!req.idem || reply.statusCode >= 500 || reply.getHeader("idempotency-replayed")) return payload;
    const body = typeof payload === "string" ? JSON.parse(payload) : payload;
    await app.db.insert(idempotencyKeys).values({ key: req.idem.key, userId: req.idem.userId, requestHash: req.idem.hash, statusCode: reply.statusCode, response: body, expiresAt: new Date(Date.now() + TTL_MS) }).onConflictDoNothing();
    return payload;
  });
}, { name: "idempotency", dependencies: ["auth", "db"] });

export async function purgeIdempotencyKeys(db: Db): Promise<number> {
  const r = await db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, new Date()));
  return r.rowCount ?? 0;
}
```
In `apps/api/src/routes.ts` `mount()`: after the auth/role preHandlers, `if (isWrite && route.access !== "public") pre.push(app.idempotency);`. In `app.ts`, register `idempotency` after `rbac`. In `tsup.config.ts` add `"cli/purge": "src/cli/purge.ts"`.

`apps/api/src/cli/purge.ts`:
```ts
import { loadConfig } from "../config";
import { createDb } from "../db/client";
import { purgeIdempotencyKeys } from "../plugins/idempotency";
const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1 });
console.log(`idempotency keys purged: ${await purgeIdempotencyKeys(db)}`);
await pool.end();
```

- [ ] **Step 3: The module**

`apps/api/src/modules/me/repo.ts`:
```ts
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import type { Tx } from "../../lib/db";
import { users } from "../../db/schema";
export const meRepo = {
  byId: async (db: Db | Tx, id: string) => (await db.select().from(users).where(eq(users.id, id)))[0],
  update: (tx: Tx, id: string, patch: { name?: string; email?: string; phone?: string }) => tx.update(users).set({ ...patch, updatedAt: new Date() }).where(eq(users.id, id)),
};
```
`apps/api/src/modules/me/service.ts`:
```ts
import type { Db } from "../../db/client";
import { withTransaction } from "../../lib/db";
import { NotFoundError } from "../../lib/errors";
import { toWireUser } from "../../lib/wire";
import { meRepo } from "./repo";
export function createMeService(db: Db) {
  const load = async (id: string) => { const u = await meRepo.byId(db, id); if (!u) throw new NotFoundError("That account no longer exists."); return { user: toWireUser(u), mustChangePassword: u.mustChangePassword }; };
  return {
    get: load,
    async patch(id: string, p: { n?: string; e?: string; ph?: string }) {
      await withTransaction(db, (tx) => meRepo.update(tx, id, { name: p.n, email: p.e, phone: p.ph }));
      return load(id);
    },
  };
}
```
`apps/api/src/modules/me/routes.ts`:
```ts
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes";
import { createMeService } from "./service";
export default fp(async (app) => {
  const svc = createMeService(app.db);
  mount(app, routes.me, async (req) => svc.get(req.user.sub));
  mount(app, routes.patchMe, async (req) => svc.patch(req.user.sub, req.body));
}, { name: "module:me", dependencies: ["auth", "rbac", "idempotency", "db"] });
```
Run: `pnpm --filter @rch/api test` — Expected: PASS (the auth test's `/me` assertion turns green too).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Make every write safe to retry

An Idempotency-Key on each write is stored with its response for a day, so
a flaky connection replays instead of repeating; /me is the first route to
carry it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 11: Snapshot module — service, role scoping, master and stock readers, document-reader stubs

**Files:**
- Create: `apps/api/src/modules/snapshot/service.ts`, `apps/api/src/modules/snapshot/scope.ts`, `apps/api/src/modules/snapshot/readers/master.ts`, `apps/api/src/modules/snapshot/readers/stock.ts`, `apps/api/src/modules/snapshot/readers/documents.ts` (stubs — Task 12 replaces the file), `apps/api/src/modules/snapshot/repo.ts`
- Modify: `apps/api/src/modules/snapshot/routes.ts` (replace the stub)
- Test: `apps/api/src/modules/snapshot/snapshot.test.ts`

**Interfaces:**
- Consumes: `routes.snapshot`, `mount`, `SnapshotSchema`, `toWireUser`, `readHistories`, `authHeaders`, `seedTestDb`.
- Produces:
  - `type Snapshot = z.infer<typeof SnapshotSchema>`
  - `createSnapshotService(db).snapshot(claims: AccessClaims): Promise<Snapshot>`
  - `readers/master.ts`: `readItems(db): Promise<Snapshot["items"]>`, `readLocations`, `readRecipes`, `readUsers`, `readPrices`, `readMenu` — Task 13 reuses these for the master GETs.
  - `readers/stock.ts`: `readStock(db)`, `readRsv(db)`, `readOvr(db)`
  - `readers/documents.ts`: `readRequests`, `readTickets`, `readRequisitions`, `readPurchaseOrders`, `readGrns`, `readProdOrders`, `readBatches`, `readBills(db, sinceDays)`, `readVendors`, `readContracts`, `readSupportTickets`, `readProductRequests`, `readShopAsks`, `readSales(db, days)` → `{ sales: number[][]; dayLabels: string[] }` — **all stubs returning empty in this task**, exact signatures fixed here so Task 12 only fills bodies.
  - `scope(snapshot, claims): Snapshot` — pure; a `counter` sees only their location's stock, menu, bills, requests, tickets addressed to/from them, shop-asks involving them, and their own support tickets; other roles see everything.
- `stock` is keyed by the five `LocKey`s; `quarantine` is excluded until `LocKey` gains it (Phase 5).

- [ ] **Step 1: Failing test**

`apps/api/src/modules/snapshot/snapshot.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as FX from "@rch/contract/fixtures";
import { SnapshotSchema } from "@rch/contract";
import { buildTestApp } from "../../test/app";
import { seedTestDb } from "../../test/seed";
import { authHeaders } from "../../test/auth";
import type { App } from "../../app";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "snapshot" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });
const get = async (userId: string) => { const r = await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, userId) }); expect(r.statusCode).toBe(200); return r.json(); };

describe("GET /snapshot", () => {
  it("validates against the contract and carries the caller", async () => {
    const s = await get("u2");
    expect(SnapshotSchema.safeParse(s).success).toBe(true);
    expect(s.user.id).toBe("u2");
  });
  it("master data equals the fixtures", async () => {
    const s = await get("u2");
    expect(s.items).toEqual(FX.IT);
    expect(s.locations).toEqual(FX.LOC);
    expect(s.recipes).toEqual(FX.RCP);
    expect(s.prices).toEqual(FX.PL);
    expect(s.menu).toEqual(FX.MENU);
    expect(s.users.map((u: { id: string }) => u.id).sort()).toEqual(FX.USERS.map((u) => u.id).sort());
  });
  it("stock, reservations and overrides come from the ledger", async () => {
    const s = await get("u3");
    for (const [loc, byItem] of Object.entries(FX.seedStock)) for (const [it, q] of Object.entries(byItem)) expect(s.stock[loc][it], `${loc}/${it}`).toBe(q);
    expect(s.rsv).toEqual(FX.seedRsv());
    expect(s.ovr).toEqual({});
  });
  it("a counter operator sees only their own location", async () => {
    const s = await get("u1"); // Kavitha, coffee
    expect(Object.keys(s.stock)).toEqual(["coffee"]);
    expect(Object.keys(s.menu)).toEqual(["coffee"]);
    expect(s.req.every((r: { from: string }) => r.from === "coffee")).toBe(true);
    expect(s.tkt.every((t: { from: string; to: string }) => t.from === "coffee" || t.to === "coffee")).toBe(true);
    expect(s.bills.every((b: { loc: string }) => b.loc === "coffee")).toBe(true);
    // master data is never scoped: prices for both lists, every item, every location
    expect(Object.keys(s.items).length).toBe(Object.keys(FX.IT).length);
  });
  it("is fast enough on the seed", async () => {
    const h = await authHeaders(app, "u2");
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: h });
    expect((performance.now() - t0) / 5).toBeLessThan(150);
  });
});
```
Run: `pnpm --filter @rch/api test src/modules/snapshot/snapshot` — Expected: FAIL.

- [ ] **Step 2: Master and stock readers**

`apps/api/src/modules/snapshot/readers/master.ts`:
```ts
import { asc } from "drizzle-orm";
import type { Item, Location, Recipe, User } from "@rch/contract";
import type { Db } from "../../../db/client";
import { items, locationItems, locations, priceListItems, recipeLines, recipes, users } from "../../../db/schema";
import { toWireUser } from "../../../lib/wire";

const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export async function readItems(db: Db): Promise<Record<string, Item>> {
  const rows = await db.select().from(items).orderBy(asc(items.key));
  return Object.fromEntries(rows.filter((r) => r.active).map((r) => [r.key, strip({
    c: r.code, n: r.name, u: r.unit, t: r.type, g: r.grp, hsn: r.hsn, gst: r.gst, rl: r.reorderLevel, cost: r.cost,
    mrp: r.mrp ?? undefined, sl: r.shelfLifeHours ?? undefined,
  })]));
}
/** The five UI locations only; quarantine joins the contract in Phase 5. */
export async function readLocations(db: Db): Promise<Record<string, Location>> {
  const rows = await db.select().from(locations);
  return Object.fromEntries(rows.filter((r) => r.key !== "quarantine").map((r) => [r.key, strip({
    n: r.name, c: r.code, type: r.type, floor: r.floor, cc: r.costCentre, list: r.priceList ?? undefined,
  })]));
}
export async function readRecipes(db: Db): Promise<Record<string, Recipe>> {
  const heads = await db.select().from(recipes);
  const lines = await db.select().from(recipeLines).orderBy(asc(recipeLines.itemKey), asc(recipeLines.seq));
  return Object.fromEntries(heads.map((h) => [h.itemKey, { ov: h.overheadPct, l: lines.filter((l) => l.itemKey === h.itemKey).map((l) => [l.ingredientKey, l.qty] as [string, number]) }]));
}
export async function readUsers(db: Db): Promise<User[]> {
  return (await db.select().from(users).orderBy(asc(users.id))).filter((u) => u.active).map(toWireUser);
}
export async function readPrices(db: Db): Promise<{ A: Record<string, number>; B: Record<string, number> }> {
  const rows = await db.select().from(priceListItems);
  const out = { A: {} as Record<string, number>, B: {} as Record<string, number> };
  for (const r of rows) out[r.list][r.itemKey] = r.price;
  return out;
}
export async function readMenu(db: Db): Promise<Record<string, string[]>> {
  const rows = await db.select().from(locationItems).orderBy(asc(locationItems.loc), asc(locationItems.seq));
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.loc] ??= []).push(r.itemKey);
  return out;
}
```

`apps/api/src/modules/snapshot/readers/stock.ts`:
```ts
import { isNull, sql } from "drizzle-orm";
import type { LocKey } from "@rch/contract";
import type { Db } from "../../../db/client";
import { availabilityOverrides, reservations, stockBalances } from "../../../db/schema";

const UI_LOCS: LocKey[] = ["store", "kitchen", "rest", "coffee", "kiosk"];

export async function readStock(db: Db): Promise<Record<LocKey, Record<string, number>>> {
  const rows = await db.select().from(stockBalances);
  const out = Object.fromEntries(UI_LOCS.map((l) => [l, {} as Record<string, number>])) as Record<LocKey, Record<string, number>>;
  for (const r of rows) if ((UI_LOCS as string[]).includes(r.loc)) out[r.loc as LocKey][r.itemKey] = r.onHand;
  return out;
}
/** "loc:item" -> quantity held by open tickets, the UI's `rsv` map. */
export async function readRsv(db: Db): Promise<Record<string, number>> {
  const rows = await db.select({ loc: reservations.loc, itemKey: reservations.itemKey, qty: sql<string>`round(sum(${reservations.qty}), 3)` })
    .from(reservations).where(isNull(reservations.releasedAt)).groupBy(reservations.loc, reservations.itemKey);
  return Object.fromEntries(rows.map((r) => [`${r.loc}:${r.itemKey}`, Number(r.qty)]));
}
export async function readOvr(db: Db): Promise<Record<string, string>> {
  const rows = await db.select().from(availabilityOverrides);
  return Object.fromEntries(rows.map((r) => [`${r.loc}:${r.itemKey}`, r.reason]));
}
```

`apps/api/src/modules/snapshot/readers/documents.ts` — **stubs with the final signatures**:
```ts
import type { Batch, Bill, Grn, ProdOrder, ProductRequest, PurchaseOrder, RateContract, Requisition, ShopAsk, StockRequest, SupportTicket, Ticket, Vendor } from "@rch/contract";
import type { Db } from "../../../db/client";

// Task 12 implements every function in this file. Signatures are final.
export async function readRequests(_db: Db): Promise<StockRequest[]> { return []; }
export async function readTickets(_db: Db): Promise<Ticket[]> { return []; }
export async function readRequisitions(_db: Db): Promise<Requisition[]> { return []; }
export async function readPurchaseOrders(_db: Db): Promise<PurchaseOrder[]> { return []; }
export async function readGrns(_db: Db): Promise<Grn[]> { return []; }
export async function readProdOrders(_db: Db): Promise<ProdOrder[]> { return []; }
export async function readBatches(_db: Db): Promise<Batch[]> { return []; }
export async function readBills(_db: Db, _sinceDays: number): Promise<Bill[]> { return []; }
export async function readVendors(_db: Db): Promise<Vendor[]> { return []; }
export async function readContracts(_db: Db): Promise<RateContract[]> { return []; }
export async function readSupportTickets(_db: Db): Promise<SupportTicket[]> { return []; }
export async function readProductRequests(_db: Db): Promise<ProductRequest[]> { return []; }
export async function readShopAsks(_db: Db): Promise<ShopAsk[]> { return []; }
export async function readSales(_db: Db, _days: number): Promise<{ sales: number[][]; dayLabels: string[] }> { return { sales: [], dayLabels: [] }; }
```
(`noUnusedParameters` accepts `_`-prefixed names.)

- [ ] **Step 3: Scope, service, routes**

`apps/api/src/modules/snapshot/scope.ts`:
```ts
import type { LocKey, Role } from "@rch/contract";
import type { Snapshot } from "./service";

/** A counter operator's world is their counter. Master data is never cut down; documents and stock are. */
export function scope(s: Snapshot, who: { role: Role; loc: LocKey; sub: string }): Snapshot {
  if (who.role !== "counter") return s;
  const L = who.loc;
  const mine = (x: { by: string }) => x.by === s.user.n;
  return {
    ...s,
    stock: { [L]: s.stock[L] ?? {} } as Snapshot["stock"],
    rsv: Object.fromEntries(Object.entries(s.rsv).filter(([k]) => k.startsWith(`${L}:`))),
    ovr: Object.fromEntries(Object.entries(s.ovr).filter(([k]) => k.startsWith(`${L}:`))),
    menu: { [L]: s.menu[L] ?? [] },
    req: s.req.filter((r) => r.from === L),
    tkt: s.tkt.filter((t) => t.from === L || t.to === L),
    bills: s.bills.filter((b) => b.loc === L),
    shopAsks: s.shopAsks.filter((a) => a.from === L || a.to === L),
    tickets: s.tickets.filter(mine),
    productReqs: s.productReqs.filter((p) => p.forLoc === L),
    pord: s.pord.filter((o) => o.from === L),
    prq: [], po: [], grn: [], batch: [], vendors: [], contracts: [],
  };
}
```

`apps/api/src/modules/snapshot/repo.ts` — the module skeleton requires one; it holds the single lookup the service needs directly:
```ts
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { users } from "../../db/schema";
export const snapshotRepo = { userById: async (db: Db, id: string) => (await db.select().from(users).where(eq(users.id, id)))[0] };
```

`apps/api/src/modules/snapshot/service.ts`:
```ts
import type { z } from "zod";
import type { SnapshotSchema } from "@rch/contract";
import type { Db } from "../../db/client";
import { NotFoundError } from "../../lib/errors";
import { toWireUser } from "../../lib/wire";
import type { AccessClaims } from "../../plugins/auth";
import { snapshotRepo } from "./repo";
import { scope } from "./scope";
import * as M from "./readers/master";
import * as S from "./readers/stock";
import * as D from "./readers/documents";

export type Snapshot = z.infer<typeof SnapshotSchema>;
const BILL_DAYS = 7;
const SALES_DAYS = 14;

export function createSnapshotService(db: Db) {
  return {
    async snapshot(claims: AccessClaims): Promise<Snapshot> {
      const u = await snapshotRepo.userById(db, claims.sub);
      if (!u) throw new NotFoundError("That account no longer exists.");
      // Independent reads run together; the pool serialises what it must.
      const [items, locations, recipes, users, prices, menu, stock, rsv, ovr, req, tkt, prq, po, grn, pord, batch, bills, vendors, contracts, tickets, productReqs, shopAsks, salesBlock] = await Promise.all([
        M.readItems(db), M.readLocations(db), M.readRecipes(db), M.readUsers(db), M.readPrices(db), M.readMenu(db),
        S.readStock(db), S.readRsv(db), S.readOvr(db),
        D.readRequests(db), D.readTickets(db), D.readRequisitions(db), D.readPurchaseOrders(db), D.readGrns(db), D.readProdOrders(db), D.readBatches(db),
        D.readBills(db, BILL_DAYS), D.readVendors(db), D.readContracts(db), D.readSupportTickets(db), D.readProductRequests(db), D.readShopAsks(db), D.readSales(db, SALES_DAYS),
      ]);
      const full: Snapshot = { user: toWireUser(u), items, locations, recipes, users, prices, menu, stock, rsv, ovr, req, tkt, prq, po, pord, batch, bills, grn, vendors, contracts, tickets, productReqs, shopAsks, sales: salesBlock.sales, dayLabels: salesBlock.dayLabels };
      return scope(full, { role: claims.role, loc: claims.loc, sub: claims.sub });
    },
  };
}
```

`apps/api/src/modules/snapshot/routes.ts`:
```ts
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes";
import { createSnapshotService } from "./service";
export default fp(async (app) => {
  const svc = createSnapshotService(app.db);
  mount(app, routes.snapshot, async (req) => svc.snapshot(req.user));
}, { name: "module:snapshot", dependencies: ["auth", "rbac", "db"] });
```
Run: `pnpm --filter @rch/api test src/modules/snapshot/snapshot` — Expected: PASS (document arrays are empty until Task 12, which the tests in this file do not assert on beyond scoping predicates that hold trivially for empty arrays).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Serve the working set the screens render from

GET /snapshot returns master data, ledger balances, reservations and
overrides in the store's own shape, scoped to a counter operator's
location; document readers are wired with their final signatures.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 12: Snapshot document readers — every collection, in wire shape

**Files:**
- Modify: `apps/api/src/modules/snapshot/readers/documents.ts` (replace every stub body)
- Test: `apps/api/src/modules/snapshot/documents.test.ts`

**Interfaces:**
- Consumes: the signatures fixed in Task 11; `readHistories(db, docType)`; `iso()`; the schema tables.
- Produces: the same functions, real. Wire conventions: every `at`/`t`/`recv`/`bb` is ISO 8601; `eta` is `YYYY-MM-DD` (the UI formats it — Task 16); `Bill.opr` is the operator's name and `oprCol` their colour (join `users`); `Ticket.req` is `ref_id`; support message ids are the fixture ids (row id `SUP-0043/m1` → `m1`).
- Lines are grouped in memory after one `select` per table (two queries per collection, never N+1).

- [ ] **Step 1: Failing test**

`apps/api/src/modules/snapshot/documents.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as FX from "@rch/contract/fixtures";
import { withTestSchema, type TestDb } from "../../test/db";
import { seedTestDb } from "../../test/seed";
import * as D from "./readers/documents";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("documents"); await seedTestDb(t.db); });
afterAll(async () => { await t.close(); });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Fixtures hold "HH:MM"; the wire holds ISO. Compare everything except the time fields, then check those are ISO. */
const strip = <T extends Record<string, unknown>>(o: T, keys: string[]): Partial<T> => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))) as Partial<T>;
const noTimes = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (k, v) => (["at", "t", "recv", "bb"].includes(k) ? undefined : v)));

describe("document readers", () => {
  it("stock requests match the fixtures, with ISO times and history", async () => {
    const got = await D.readRequests(t.db);
    expect(got.map((r) => r.id).sort()).toEqual(FX.seedReq.map((r) => r.id).sort());
    for (const r of got) {
      const fx = FX.seedReq.find((x) => x.id === r.id)!;
      expect(noTimes(strip(r, ["hist"]))).toEqual(noTimes(strip(fx, ["hist"])));
      expect(r.at).toMatch(ISO);
      expect(r.hist.map((h) => h.s)).toEqual(fx.hist.map((h) => h.s));
      for (const h of r.hist) expect(h.t).toMatch(ISO);
    }
  });
  it("tickets, requisitions, purchase orders, GRNs, production, batches", async () => {
    expect(noTimes(await D.readTickets(t.db))).toEqual(noTimes(FX.seedTkt));
    const prq = await D.readRequisitions(t.db); expect(noTimes(prq.map((p) => strip(p, ["hist"])))).toEqual(noTimes(FX.seedPrq.map((p) => strip(p, ["hist"]))));
    const po = await D.readPurchaseOrders(t.db);
    for (const o of po) { const fx = FX.seedPo.find((x) => x.id === o.id)!; expect(noTimes(strip(o, ["hist", "eta"]))).toEqual(noTimes(strip(fx, ["hist", "eta"]))); expect(o.eta).toMatch(/^\d{4}-\d{2}-\d{2}$|^$/); }
    expect(noTimes(await D.readGrns(t.db))).toEqual(noTimes(FX.seedGrn));
    expect(noTimes((await D.readProdOrders(t.db)).map((o) => strip(o, ["hist"])))).toEqual(noTimes(FX.seedPord.map((o) => strip(o, ["hist"]))));
    const b = await D.readBatches(t.db); expect(noTimes(b)).toEqual(noTimes(FX.seedBatch)); expect(b[0].bb).toMatch(ISO);
  });
  it("bills carry the operator's colour and only the last N days", async () => {
    const bills = await D.readBills(t.db, 7);
    expect(noTimes(bills)).toEqual(noTimes(FX.seedBills));
    expect((await D.readBills(t.db, 0)).length).toBe(0);
  });
  it("vendors, contracts, support tickets, product requests, shop asks", async () => {
    expect(await D.readVendors(t.db)).toEqual(FX.seedVendors);
    expect(await D.readContracts(t.db)).toEqual(FX.seedContracts());
    const sup = await D.readSupportTickets(t.db);
    expect(noTimes(sup)).toEqual(noTimes(FX.seedTickets()));
    expect(sup[0].messages[0].id).toBe(FX.seedTickets()[0].messages[0].id);
    expect(noTimes(await D.readProductRequests(t.db))).toEqual(noTimes(FX.seedProductRequests()));
    expect(noTimes(await D.readShopAsks(t.db))).toEqual(noTimes(FX.seedShopAsks()));
  });
  it("sales are 14 day-rows of 3 outlet columns from bills, with day-of-month labels", async () => {
    const { sales, dayLabels } = await D.readSales(t.db, 14);
    expect(sales.length).toBe(14); expect(dayLabels.length).toBe(14);
    expect(sales.every((row) => row.length === 3)).toBe(true);
    const today = sales[13];
    const fxToday = (loc: string) => FX.seedBills.filter((b) => b.loc === loc).reduce((s, b) => s + b.tot, 0);
    expect(today).toEqual([fxToday("rest"), fxToday("coffee"), fxToday("kiosk")]);
  });
});
```
Run: `pnpm --filter @rch/api test src/modules/snapshot/documents` — Expected: FAIL.

- [ ] **Step 2: Implement the readers**

Replace `apps/api/src/modules/snapshot/readers/documents.ts`:
```ts
import { asc, desc, eq, gte, sql } from "drizzle-orm";
import type { Batch, Bill, Grn, HistEntry, LocKey, ProdOrder, ProductRequest, PurchaseOrder, RateContract, Requisition, ShopAsk, StockRequest, SupportTicket, Ticket, Vendor } from "@rch/contract";
import type { Db } from "../../../db/client";
import * as s from "../../../db/schema";
import { readHistories } from "../../../lib/history";
import { iso } from "../../../lib/time";

const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const groupBy = <T, K extends string>(rows: T[], key: (r: T) => K): Map<K, T[]> => { const m = new Map<K, T[]>(); for (const r of rows) { const k = key(r); (m.get(k) ?? m.set(k, []).get(k)!).push(r); } return m; };
const hist = (m: Map<string, HistEntry[]>, id: string) => m.get(id) ?? [];
const userNames = async (db: Db) => new Map((await db.select({ id: s.users.id, name: s.users.name, colour: s.users.colour }).from(s.users)).map((u) => [u.id, u]));

export async function readRequests(db: Db): Promise<StockRequest[]> {
  const [heads, lines, h, names] = await Promise.all([
    db.select().from(s.stockRequests).orderBy(asc(s.stockRequests.at), asc(s.stockRequests.id)),
    db.select().from(s.stockRequestLines).orderBy(asc(s.stockRequestLines.lineNo)),
    readHistories(db, "request"), userNames(db),
  ]);
  const byReq = groupBy(lines, (l) => l.requestId);
  return heads.map((r) => strip({
    id: r.id, from: r.fromLoc as LocKey, by: names.get(r.byUser)?.name ?? r.byUser, at: iso(r.at),
    lines: (byReq.get(r.id) ?? []).map((l) => strip({ it: l.itemKey, qty: l.qty, appr: l.approvedQty, short: l.shortQty ?? undefined })),
    st: r.status, ticket: r.ticketId, mgrNote: r.managerNote, urg: r.urgent || undefined, hist: hist(h, r.id),
    apprBy: r.approvedBy ? names.get(r.approvedBy)?.name ?? r.approvedBy : undefined,
  }));
}

export async function readTickets(db: Db): Promise<Ticket[]> {
  const [heads, lines] = await Promise.all([db.select().from(s.tickets).orderBy(asc(s.tickets.issuedAt), asc(s.tickets.id)), db.select().from(s.ticketLines).orderBy(asc(s.ticketLines.lineNo))]);
  const byTkt = groupBy(lines, (l) => l.ticketId);
  return heads.map((t) => ({ id: t.id, req: t.refId, from: t.fromLoc as LocKey, to: t.toLoc as LocKey, lines: (byTkt.get(t.id) ?? []).map((l) => ({ it: l.itemKey, qty: l.qty })), st: t.status, otp: t.otp }));
}

export async function readRequisitions(db: Db): Promise<Requisition[]> {
  const [heads, lines, h, names] = await Promise.all([
    db.select().from(s.requisitions).orderBy(desc(s.requisitions.at), desc(s.requisitions.id)),
    db.select().from(s.requisitionLines).orderBy(asc(s.requisitionLines.lineNo)), readHistories(db, "requisition"), userNames(db),
  ]);
  const byPrq = groupBy(lines, (l) => l.requisitionId);
  return heads.map((p) => strip({
    id: p.id, by: names.get(p.byUser)?.name ?? p.byUser, at: iso(p.at),
    lines: (byPrq.get(p.id) ?? []).map((l) => strip({ it: l.itemKey, qty: l.qty, appr: l.approvedQty, ordered: l.orderedQty, short: l.shortQty ?? undefined })),
    st: p.status, note: p.note, apprBy: p.approvedBy ? names.get(p.approvedBy)?.name ?? p.approvedBy : undefined, apprNote: p.approvalNote ?? undefined, hist: hist(h, p.id),
  }));
}

export async function readPurchaseOrders(db: Db): Promise<PurchaseOrder[]> {
  const [heads, lines, srcs, h] = await Promise.all([
    db.select().from(s.purchaseOrders).orderBy(desc(s.purchaseOrders.at), desc(s.purchaseOrders.id)),
    db.select().from(s.poLines).orderBy(asc(s.poLines.lineNo)),
    db.select().from(s.poLineSources).orderBy(asc(s.poLineSources.seq)), readHistories(db, "purchase_order"),
  ]);
  const byPo = groupBy(lines, (l) => l.poId);
  const bySrc = groupBy(srcs, (x) => `${x.poId}#${x.lineNo}`);
  return heads.map((o) => strip({
    id: o.id, vendor: o.vendorId, at: iso(o.at),
    lines: (byPo.get(o.id) ?? []).map((l) => ({ it: l.itemKey, qty: l.qty, rate: l.rate, src: (bySrc.get(`${o.id}#${l.lineNo}`) ?? []).map((x) => ({ prq: x.requisitionId, line: x.requisitionLineNo, qty: x.qty })), recv: l.receivedQty, rejected: l.rejectedQty })),
    st: o.status, eta: o.eta ?? "", needsApproval: o.needsApproval || undefined, shortNote: o.shortNote ?? undefined, recv: o.receivedAt ? iso(o.receivedAt) : undefined, hist: hist(h, o.id),
  }));
}

export async function readGrns(db: Db): Promise<Grn[]> {
  const [rows, names] = await Promise.all([db.select().from(s.grns).orderBy(desc(s.grns.at), desc(s.grns.id)), userNames(db)]);
  return rows.map((g) => ({
    id: g.id, po: g.poId, it: g.itemKey, qty: g.acceptedQty, rejected: g.rejectedQty, batch: g.batchNo, mrp: g.mrp, mfg: g.mfg, exp: g.exp,
    dc: g.dcNo, invoice: g.invoiceNo, invDate: g.invoiceDate ?? "", at: iso(g.at), by: g.byUser ? names.get(g.byUser)?.name ?? g.byUser : "",
  }));
}

export async function readProdOrders(db: Db): Promise<ProdOrder[]> {
  const [heads, lines, h, names] = await Promise.all([
    db.select().from(s.prodOrders).orderBy(asc(s.prodOrders.at), asc(s.prodOrders.id)), db.select().from(s.prodOrderLines).orderBy(asc(s.prodOrderLines.lineNo)), readHistories(db, "prod_order"), userNames(db),
  ]);
  const by = groupBy(lines, (l) => l.orderId);
  return heads.map((o) => ({ id: o.id, from: o.fromLoc as LocKey, by: names.get(o.byUser)?.name ?? o.byUser, at: iso(o.at), lines: (by.get(o.id) ?? []).map((l) => ({ it: l.itemKey, qty: l.qty })), st: o.status, note: o.note, hist: hist(h, o.id) }));
}

export async function readBatches(db: Db): Promise<Batch[]> {
  const rows = await db.select().from(s.batches).orderBy(desc(s.batches.at), desc(s.batches.id));
  return rows.map((b) => strip({ id: b.id, it: b.itemKey, qty: b.startedQty, made: b.madeQty, at: iso(b.at), bb: iso(b.bestBefore), note: b.note ?? undefined }));
}

export async function readBills(db: Db, sinceDays: number): Promise<Bill[]> {
  const since = new Date(Date.now() - sinceDays * 86400_000);
  const [heads, lines, names] = await Promise.all([
    db.select().from(s.bills).where(gte(s.bills.at, since)).orderBy(desc(s.bills.at), desc(s.bills.no)), db.select().from(s.billLines).orderBy(asc(s.billLines.lineNo)), userNames(db),
  ]);
  const by = groupBy(lines, (l) => l.billNo);
  return heads.map((b) => strip({
    no: b.no, loc: b.loc as LocKey, opr: names.get(b.operatorId)?.name ?? b.operatorId, oprCol: names.get(b.operatorId)?.colour ?? "#64748B", tot: b.total, tax: b.tax, t: iso(b.at), pay: b.tender,
    lines: (by.get(b.no) ?? []).map((l) => ({ it: l.itemKey, qty: l.qty, rate: l.rate })),
    payer: b.payerKind ? { kind: b.payerKind, id: b.payerId ?? "", name: b.payerName ?? "" } : undefined,
  }));
}

export async function readVendors(db: Db): Promise<Vendor[]> {
  return (await db.select().from(s.vendors).orderBy(asc(s.vendors.id))).map((v) => ({ id: v.id, n: v.name, gstin: v.gstin, contact: v.contact, ph: v.phone, terms: v.terms, lead: v.leadDays, groups: v.groups, active: v.active }));
}
export async function readContracts(db: Db): Promise<RateContract[]> {
  return (await db.select().from(s.rateContracts).orderBy(asc(s.rateContracts.id))).map((c) => ({ id: c.id, vendor: c.vendorId, it: c.itemKey, rate: c.rate, from: c.validFrom, to: c.validTo, moq: c.moq, active: c.active }));
}
export async function readSupportTickets(db: Db): Promise<SupportTicket[]> {
  const [heads, msgs, names] = await Promise.all([
    db.select().from(s.supportTickets).orderBy(desc(s.supportTickets.at), desc(s.supportTickets.id)), db.select().from(s.supportMessages).orderBy(asc(s.supportMessages.at), asc(s.supportMessages.id)), userNames(db),
  ]);
  const by = groupBy(msgs, (m) => m.ticketId);
  return heads.map((t) => strip({
    id: t.id, topic: t.topic, subject: t.subject, priority: t.priority, st: t.status, by: names.get(t.byUser)?.name ?? t.byUser, role: t.role, loc: t.loc as LocKey, at: iso(t.at), screen: t.screen,
    messages: (by.get(t.id) ?? []).map((m) => ({ id: m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id, from: m.from, who: m.who, at: iso(m.at), body: m.body })),
    rating: (t.rating ?? undefined) as SupportTicket["rating"],
  }));
}
export async function readProductRequests(db: Db): Promise<ProductRequest[]> {
  const [rows, names] = await Promise.all([db.select().from(s.productRequests).orderBy(desc(s.productRequests.at)), userNames(db)]);
  return rows.map((p) => strip({ id: p.id, name: p.name, why: p.why, forLoc: p.forLoc as LocKey, by: names.get(p.byUser)?.name ?? p.byUser, at: iso(p.at), st: p.status, note: p.note ?? undefined, itemKey: p.itemKey ?? undefined }));
}
export async function readShopAsks(db: Db): Promise<ShopAsk[]> {
  const [rows, names] = await Promise.all([db.select().from(s.shopAsks).orderBy(asc(s.shopAsks.at)), userNames(db)]);
  return rows.map((a) => strip({ id: a.id, from: a.fromLoc as LocKey, to: a.toLoc as LocKey, it: a.itemKey, qty: a.qty, st: a.status, by: names.get(a.byUser)?.name ?? a.byUser, at: iso(a.at), note: a.note, grant: a.grantedQty ?? undefined, ticket: a.ticketId ?? undefined, reason: a.reason ?? undefined }));
}

const OUTLET_COLS = ["rest", "coffee", "kiosk"] as const;
/** Day rows (oldest first, today last) × outlet columns, in the hospital's calendar. */
export async function readSales(db: Db, days: number): Promise<{ sales: number[][]; dayLabels: string[] }> {
  const rows = await db.select({
    day: sql<string>`to_char(${s.bills.at} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`, loc: s.bills.loc, total: sql<string>`sum(${s.bills.total})`,
  }).from(s.bills).where(gte(s.bills.at, new Date(Date.now() - days * 86400_000))).groupBy(sql`1`, s.bills.loc);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  const dayKeys = Array.from({ length: days }, (_, i) => fmt.format(new Date(Date.now() - (days - 1 - i) * 86400_000)));
  const sales = dayKeys.map((d) => OUTLET_COLS.map((loc) => Number(rows.find((r) => r.day === d && r.loc === loc)?.total ?? 0)));
  return { sales, dayLabels: dayKeys.map((d) => d.slice(8)) };
}
```
Run: `pnpm --filter @rch/api test` — Expected: PASS. If a fixture/DB mismatch appears (e.g. `Bill.oprCol` for an operator not in `USERS`), the fixture is the reference: fix the seed mapping, not the test.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Read every document collection back in wire shape

Requests, tickets, requisitions, purchase orders, GRNs, production
orders, batches, bills, vendors, contracts, support tickets, product
requests and shop-asks come off the tables two queries each and match
the fixtures they were seeded from, times now ISO.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 13: Master-data GETs and the contract conformance test

**Files:**
- Create: `apps/api/src/modules/master/service.ts`, `apps/api/src/modules/master/repo.ts`
- Modify: `apps/api/src/modules/master/routes.ts` (replace the stub)
- Test: `apps/api/src/modules/master/master.test.ts`, `apps/api/src/contract.test.ts`

**Interfaces:**
- Consumes: `routes.items/locations/recipes/prices/menus`, readers from `modules/snapshot/readers/master.ts` (re-exported through `master/repo.ts` so the module skeleton holds and the dependency is explicit).
- Produces: five GET routes; a conformance test that walks every GET in the manifest, calls it as a manager, and validates the body with the manifest's own `response` schema. Later phases extend this test by adding nothing — new manifest entries are picked up automatically.

- [ ] **Step 1: Failing tests**

`apps/api/src/modules/master/master.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as FX from "@rch/contract/fixtures";
import { buildTestApp } from "../../test/app";
import { seedTestDb } from "../../test/seed";
import { authHeaders } from "../../test/auth";
import type { App } from "../../app";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "master" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });
const get = async (url: string) => { const r = await app.inject({ method: "GET", url: `/api/v1${url}`, headers: await authHeaders(app, "u1") }); expect(r.statusCode).toBe(200); return r.json(); };

describe("master GETs", () => {
  it("items, locations, recipes, prices and menus equal the fixtures", async () => {
    expect(await get("/items")).toEqual(FX.IT);
    expect(await get("/locations")).toEqual(FX.LOC);
    expect(await get("/recipes")).toEqual(FX.RCP);
    expect(await get("/prices")).toEqual(FX.PL);
    expect(await get("/menus")).toEqual(FX.MENU);
  });
  it("are not location-scoped even for a counter operator", async () => {
    expect(Object.keys(await get("/menus")).sort()).toEqual(Object.keys(FX.MENU).sort());
  });
});
```

`apps/api/src/contract.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX, routes } from "@rch/contract";
import { buildTestApp } from "./test/app";
import { seedTestDb } from "./test/seed";
import { authHeaders } from "./test/auth";
import type { App } from "./app";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "contract" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("every GET in the manifest answers with a body its own schema accepts", () => {
  const gets = Object.entries(routes).filter(([, r]) => r.method === "GET" && !r.params && !r.query);
  it.each(gets.map(([name, r]) => [name, r] as const))("%s", async (_name, r) => {
    const headers = r.access === "public" ? {} : await authHeaders(app, "u2");
    const res = await app.inject({ method: "GET", url: API_PREFIX + r.path, headers });
    expect(res.statusCode).toBe(200);
    const parsed = r.response.safeParse(res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues.slice(0, 3))).toBe(true);
  });
});
```
Run: `pnpm --filter @rch/api test src/modules/master src/contract` — Expected: FAIL (404s).

- [ ] **Step 2: Implement**

`apps/api/src/modules/master/repo.ts`:
```ts
export { readItems, readLocations, readMenu, readPrices, readRecipes } from "../snapshot/readers/master";
```
`apps/api/src/modules/master/service.ts`:
```ts
import type { Db } from "../../db/client";
import * as R from "./repo";
export const createMasterService = (db: Db) => ({
  items: () => R.readItems(db), locations: () => R.readLocations(db), recipes: () => R.readRecipes(db), prices: () => R.readPrices(db), menus: () => R.readMenu(db),
});
```
`apps/api/src/modules/master/routes.ts`:
```ts
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes";
import { createMasterService } from "./service";
export default fp(async (app) => {
  const svc = createMasterService(app.db);
  mount(app, routes.items, async () => svc.items());
  mount(app, routes.locations, async () => svc.locations());
  mount(app, routes.recipes, async () => svc.recipes());
  mount(app, routes.prices, async () => svc.prices());
  mount(app, routes.menus, async () => svc.menus());
}, { name: "module:master", dependencies: ["auth", "rbac", "db"] });
```
Run: `pnpm turbo typecheck lint test` — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Expose master data on its own and prove every GET against the contract

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 14: Operator CLI — users and signing keys

**Files:**
- Create: `apps/api/src/lib/users-admin.ts`, `apps/api/src/cli/users.ts`, `apps/api/src/cli/keys.ts`
- Test: `apps/api/src/lib/users-admin.test.ts`

**Interfaces:**
- Produces:
  - `createUser(db, input: { emp, name, email, role, loc, phone?, colour?, password }): Promise<{ id: string }>` — id is `u<n>` continuing the seeded series; `must_change_password = true`
  - `resetPassword(db, emp, temporaryPassword): Promise<void>` — sets the hash, `must_change_password = true`, revokes every refresh token
  - `deactivateUser(db, emp): Promise<void>` — `active = false`, revokes every refresh token
  - CLI: `pnpm --filter @rch/api users create --emp RC-9001 --name "Anitha R" --email a@royalcare.in --role counter --loc rest --password <tmp>`; `users reset-password --emp RC-9001 --password <tmp>`; `users deactivate --emp RC-9001`
  - CLI: `pnpm --filter @rch/api keys:generate` prints `JWT_PRIVATE_KEY=<b64>` and `JWT_PUBLIC_KEY=<b64>` lines ready for an env file or a Kubernetes Secret.

- [ ] **Step 1: Failing test**

`apps/api/src/lib/users-admin.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestSchema, type TestDb } from "../test/db";
import { seedTestDb } from "../test/seed";
import { createUser, deactivateUser, resetPassword } from "./users-admin";
import { verifyPassword } from "./password";
import { refreshTokens, users } from "../db/schema";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("users_admin"); await seedTestDb(t.db); });
afterAll(async () => { await t.close(); });

describe("users-admin", () => {
  it("creates a user who must change their password, with the next id in the series", async () => {
    const { id } = await createUser(t.db, { emp: "RC-9001", name: "Anitha R", email: "anitha.r@royalcare.in", role: "counter", loc: "rest", password: "temporary-pass-1" });
    expect(id).toBe("u7");
    const [u] = await t.db.select().from(users).where(eq(users.id, id));
    expect(u.mustChangePassword).toBe(true); expect(u.roleLabel).toBe("Counter Operator"); expect(await verifyPassword(u.passwordHash, "temporary-pass-1")).toBe(true);
  });
  it("refuses a duplicate employee number and an unknown location", async () => {
    await expect(createUser(t.db, { emp: "RC-4471", name: "X", email: "x@x", role: "counter", loc: "rest", password: "temporary-pass-1" })).rejects.toThrow(/RC-4471/);
    await expect(createUser(t.db, { emp: "RC-9002", name: "X", email: "x@x", role: "counter", loc: "attic" as never, password: "temporary-pass-1" })).rejects.toThrow(/location/);
  });
  it("reset-password sets a temporary password and revokes sessions", async () => {
    await t.db.insert(refreshTokens).values({ userId: "u1", family: "00000000-0000-4000-8000-000000000001", tokenHash: "h", expiresAt: new Date(Date.now() + 1000) });
    await resetPassword(t.db, "RC-4471", "another-temp-pass");
    const [u] = await t.db.select().from(users).where(eq(users.id, "u1"));
    expect(u.mustChangePassword).toBe(true); expect(await verifyPassword(u.passwordHash, "another-temp-pass")).toBe(true);
    expect((await t.db.select().from(refreshTokens).where(eq(refreshTokens.userId, "u1"))).every((r) => r.revokedAt)).toBe(true);
  });
  it("deactivate flips active and revokes sessions", async () => {
    await deactivateUser(t.db, "RC-4482");
    const [u] = await t.db.select().from(users).where(eq(users.id, "u6"));
    expect(u.active).toBe(false);
  });
});
```
Run: `pnpm --filter @rch/api test src/lib/users-admin` — Expected: FAIL.

- [ ] **Step 2: Implement**

`apps/api/src/lib/users-admin.ts`:
```ts
import { and, eq, isNull, sql } from "drizzle-orm";
import type { LocKey, Role } from "@rch/contract";
import type { Db } from "../db/client";
import { locations, refreshTokens, users } from "../db/schema";
import { withTransaction } from "./db";
import { hashPassword } from "./password";

const ROLE_LABEL: Record<Role, string> = { counter: "Counter Operator", manager: "Outlet Manager", store: "Store Keeper", prod: "Kitchen In-charge", buyer: "Procurement Officer" };
const PALETTE = ["#B45309", "#7C3AED", "#0F766E", "#15803D", "#BE123C", "#475569", "#1D4ED8", "#9333EA", "#0E7490", "#C2410C"];

export async function createUser(db: Db, i: { emp: string; name: string; email: string; role: Role; loc: LocKey; phone?: string; colour?: string; password: string }): Promise<{ id: string }> {
  return withTransaction(db, async (tx) => {
    if (await tx.select().from(users).where(eq(users.empNo, i.emp)).then((r) => r[0])) throw new Error(`employee ${i.emp} already exists`);
    if (!(await tx.select().from(locations).where(eq(locations.key, i.loc)).then((r) => r[0]))) throw new Error(`unknown location "${i.loc}"`);
    const [{ n }] = (await tx.execute(sql`select coalesce(max(substring(id from 2)::int), 0) + 1 as n from users where id ~ '^u[0-9]+$'`)).rows as [{ n: number }];
    const id = `u${n}`;
    await tx.insert(users).values({
      id, name: i.name, email: i.email, role: i.role, roleLabel: ROLE_LABEL[i.role], loc: i.loc, colour: i.colour ?? PALETTE[Number(n) % PALETTE.length],
      empNo: i.emp, phone: i.phone ?? "", passwordHash: await hashPassword(i.password), mustChangePassword: true,
    });
    return { id };
  });
}
async function byEmp(tx: Parameters<Parameters<typeof withTransaction>[1]>[0], emp: string) {
  const [u] = await tx.select().from(users).where(eq(users.empNo, emp));
  if (!u) throw new Error(`no user with employee number ${emp}`);
  return u;
}
const revokeAll = (tx: Parameters<Parameters<typeof withTransaction>[1]>[0], userId: string) =>
  tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));

export async function resetPassword(db: Db, emp: string, temporary: string): Promise<void> {
  const hash = await hashPassword(temporary);
  await withTransaction(db, async (tx) => { const u = await byEmp(tx, emp); await tx.update(users).set({ passwordHash: hash, mustChangePassword: true, updatedAt: new Date() }).where(eq(users.id, u.id)); await revokeAll(tx, u.id); });
}
export async function deactivateUser(db: Db, emp: string): Promise<void> {
  await withTransaction(db, async (tx) => { const u = await byEmp(tx, emp); await tx.update(users).set({ active: false, updatedAt: new Date() }).where(eq(users.id, u.id)); await revokeAll(tx, u.id); });
}
```

`apps/api/src/cli/users.ts`:
```ts
import { parseArgs } from "node:util";
import { loadConfig } from "../config";
import { createDb } from "../db/client";
import { createUser, deactivateUser, resetPassword } from "../lib/users-admin";
import type { LocKey, Role } from "@rch/contract";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { emp: { type: "string" }, name: { type: "string" }, email: { type: "string" }, role: { type: "string" }, loc: { type: "string" }, phone: { type: "string" }, password: { type: "string" } },
});
const need = (k: keyof typeof values) => { const v = values[k]; if (!v) { console.error(`--${k} is required`); process.exit(2); } return v; };
const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1 });
try {
  switch (positionals[0]) {
    case "create": {
      const { id } = await createUser(db, { emp: need("emp"), name: need("name"), email: need("email"), role: need("role") as Role, loc: need("loc") as LocKey, phone: values.phone, password: need("password") });
      console.log(`created ${id} (${values.emp}) - must change password at first sign-in`); break;
    }
    case "reset-password": await resetPassword(db, need("emp"), need("password")); console.log(`password reset for ${values.emp}; sessions revoked`); break;
    case "deactivate": await deactivateUser(db, need("emp")); console.log(`${values.emp} deactivated; sessions revoked`); break;
    default: console.error("usage: users <create|reset-password|deactivate> --emp ... [--name --email --role --loc --phone --password]"); process.exit(2);
  }
} finally { await pool.end(); }
```

`apps/api/src/cli/keys.ts`:
```ts
import { generateKeyPairSync } from "node:crypto";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const b64 = (pem: string | Buffer) => Buffer.from(pem).toString("base64");
console.log(`JWT_PRIVATE_KEY=${b64(privateKey.export({ type: "pkcs8", format: "pem" }))}`);
console.log(`JWT_PUBLIC_KEY=${b64(publicKey.export({ type: "spki", format: "pem" }))}`);
```
Add `"cli/keys": "src/cli/keys.ts"` to `tsup.config.ts` entries.

Run: `pnpm --filter @rch/api test src/lib/users-admin && pnpm --filter @rch/api keys:generate` — Expected: PASS; two `JWT_*=` lines printed.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Give operators a CLI for accounts and signing keys

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 15: Container images — API (distroless) and UI (nginx)

**Files:**
- Create: `apps/api/Dockerfile`, `UI/Dockerfile`, `deploy/nginx/default.conf.template`, `.dockerignore`
- Modify: `UI/vite.config.ts` (dev proxy), `apps/api/package.json` (`build` already `tsup`; add `"start"` if missing)

**Interfaces:**
- Produces: image `rch-api` listening on `3000`, entry `node /app/dist/server.mjs`, CLIs at `/app/dist/cli/*.mjs`, migrations at `/app/drizzle`, RDS CA at `/etc/ssl/rds-global-bundle.pem`; runs as non-root, read-only root FS OK (writes nothing).
- Image `rch-ui` on `8080` (unprivileged nginx) serving the SPA with `/api/` and `/events` proxied to `$API_UPSTREAM` (default `http://rch-api:3000`); `/healthz` returns 200 from nginx itself.

- [ ] **Step 1: `.dockerignore`**

```
node_modules
**/node_modules
**/dist
.git
.turbo
docs
archive
*.md
.env
.env.*
```

- [ ] **Step 2: API image**

`apps/api/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/contract/package.json packages/contract/
COPY packages/domain/package.json packages/domain/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @rch/api...

FROM deps AS build
COPY packages ./packages
COPY apps/api ./apps/api
COPY tsconfig.base.json ./
RUN pnpm --filter @rch/api build \
 && pnpm --filter @rch/api deploy --prod --legacy /out \
 && rm -rf /out/src \
 && apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /rds-global-bundle.pem

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime
ENV NODE_ENV=production PORT=3000 PG_CA_BUNDLE=/etc/ssl/rds-global-bundle.pem
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/drizzle ./drizzle
COPY --from=build /rds-global-bundle.pem /etc/ssl/rds-global-bundle.pem
EXPOSE 3000
USER nonroot
CMD ["dist/server.mjs"]
```
`migrationsFolder()` (Task 5) walks up from `dist/` and finds `/app/drizzle` — verify with `docker run --rm --entrypoint /nodejs/bin/node rch-api dist/cli/migrate.mjs` against a reachable DB later; here it is enough that the image builds and `/healthz` answers.

If `pnpm deploy --legacy` is rejected by pnpm 10.28, add `inject-workspace-packages=true` to `.npmrc` and drop `--legacy`; the bundled API does not import `@rch/*` at runtime (tsup inlined them), so either mode works.

Run:
```bash
docker build -f apps/api/Dockerfile -t rch-api:dev .
docker run --rm -d --name rch-api-smoke -p 3001:3000 \
  -e DATABASE_URL=postgres://rch:rch@host.docker.internal:5432/rch -e CORS_ORIGIN=http://localhost:5173 \
  -e JWT_PRIVATE_KEY=$(echo -n x | base64) -e JWT_PUBLIC_KEY=$(echo -n x | base64) -e COOKIE_SECURE=false rch-api:dev
sleep 2 && curl -fsS localhost:3001/healthz && docker rm -f rch-api-smoke
```
Expected: `{"ok":true}`. (Readiness will be 503 until the DB is migrated — that is correct.) Note the JWT placeholders are not valid keys; the process starts because keys are only used on sign/verify. Use real ones from `keys:generate` when testing login through the container.

- [ ] **Step 3: UI image and nginx**

`deploy/nginx/default.conf.template`:
```nginx
server {
  listen 8080;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  add_header X-Content-Type-Options nosniff always;
  add_header X-Frame-Options SAMEORIGIN always;
  add_header Referrer-Policy strict-origin-when-cross-origin always;
  add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'" always;

  location = /healthz { return 200 'ok'; add_header Content-Type text/plain; }

  location /api/ {
    proxy_pass ${API_UPSTREAM};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-Id $request_id;
    proxy_read_timeout 60s;
  }
  # Server-sent events (Phase 3): no buffering, long read timeout.
  location /api/v1/events {
    proxy_pass ${API_UPSTREAM};
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    chunked_transfer_encoding off;
  }

  location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; try_files $uri =404; }
  location / { add_header Cache-Control "no-cache"; try_files $uri /index.html; }
}
```
`UI/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY UI ./UI
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @rch/ui... \
 && pnpm --filter @rch/ui build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
ENV API_UPSTREAM=http://rch-api:3000
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/UI/dist /usr/share/nginx/html
EXPOSE 8080
```
(The nginx image's entrypoint runs `envsubst` on `/etc/nginx/templates/*.template` into `conf.d/`, substituting `${API_UPSTREAM}` and leaving nginx's own `$host`-style variables alone because they use single-dollar without braces.)

`UI/vite.config.ts` — add the dev proxy so `pnpm dev` talks to the local API without CORS games:
```ts
server: { proxy: { "/api": { target: "http://localhost:3000", changeOrigin: false } } },
```
`UI/vite.config.ts` `base` stays `"./"` — the docs-site build publishes the app under `/app/`; the container serves it at `/`. Both work with a relative base.

Run: `docker build -f UI/Dockerfile -t rch-ui:dev . && docker run --rm -d --name rch-ui-smoke -p 8081:8080 rch-ui:dev && sleep 1 && curl -fsS localhost:8081/healthz && curl -fsS -o /dev/null -w '%{http_code}\n' localhost:8081/ && docker rm -f rch-ui-smoke`
Expected: `ok` then `200`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Package the API and the UI as containers

Distroless Node for the API with the RDS CA bundle baked in and the CLIs
alongside; unprivileged nginx for the UI, proxying /api to the API
service with SSE-safe settings ready for Phase 3.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 16: Frontend cutover — real sign-in, snapshot hydration, one API client

**Files:**
- Create: `UI/src/api/session.ts`, `UI/src/api/client.ts`, `UI/src/api/wire.ts`, `UI/src/pages/ChangePassword.tsx`
- Modify: `UI/src/store/index.ts`, `UI/src/pages/Login.tsx`, `UI/src/pages/Settings.tsx:29,98`, `UI/src/ui/Shell.tsx:21,64`, `UI/src/App.tsx`, `UI/src/lib/fmt.ts`, `UI/src/__tests__/screens.test.tsx:133-139`, `knip.json` (re-include `UI`)
- Test: `UI/src/__tests__/api.test.ts`

**Interfaces:**
- Consumes: `routes`, `API_PREFIX`, `AnyRoute`, `Snapshot` type (`z.infer<typeof SnapshotSchema>`), `hydrateMaster` (Task 3).
- Produces:
  - `session.ts`: `getAccessToken()`, `setAccessToken(t | null)`, `onSessionLost(fn)`
  - `client.ts`: `call<R extends AnyRoute>(route: R, input?: { params?, query?, body? }): Promise<z.infer<R["response"]>>`; throws `ApiError { code, message, status, details? }`; one automatic refresh-and-retry on 401 for non-auth routes; `Idempotency-Key` on writes; `credentials: "include"`.
  - `wire.ts`: `applySnapshot(s: Snapshot): void` — calls `hydrateMaster`, converts wire times/dates to the store's display strings, and `useApp.setState(...)`s every collection.
  - `fmt.ts`: `fromWireTime(iso: string): string` (`"HH:MM"` in Asia/Kolkata), `fromWireDate(yyyyMmDd: string): string` (`"DD-MMM-YYYY"`), `fromWireBestBefore(iso: string): string` (same rule as `bestBefore`)
  - Store: `auth: "signed-out" | "signing-in" | "loading" | "ready"`, `mustChangePassword: boolean`, `login(emp, password): Promise<boolean>`, `logout(): Promise<void>`, `loadSnapshot(): Promise<void>`, `changePassword(current, next): Promise<boolean>`; `saveProfile` now calls `PATCH /me`; `signIn(id)` stays for tests.
- Screens are untouched. The store's business logic (mutations) stays local in this phase.

- [ ] **Step 1: Failing tests**

`UI/src/__tests__/api.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes, defineRoute } from "@rch/contract";
import { z } from "zod";
import { ApiError, call } from "../api/client";
import { setAccessToken, getAccessToken } from "../api/session";
import { fromWireBestBefore, fromWireDate, fromWireTime } from "../lib/fmt";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("api client", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); setAccessToken(null); });
  afterEach(() => vi.unstubAllGlobals());

  it("builds the url, sends the token and cookies, and parses the body", async () => {
    setAccessToken("tok");
    fetchMock.mockResolvedValueOnce(ok({ user: { id: "u1" }, mustChangePassword: false }));
    const r = await call(routes.me);
    expect(r.user.id).toBe("u1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/me");
    expect(init.credentials).toBe("include");
    expect(init.headers.authorization).toBe("Bearer tok");
  });
  it("substitutes path params and sends an Idempotency-Key on writes", async () => {
    setAccessToken("tok");
    const r = defineRoute({ method: "POST", path: "/things/:id/do", access: "any", params: z.object({ id: z.string() }), body: z.object({ n: z.number() }), response: z.object({ ok: z.literal(true) }) });
    fetchMock.mockResolvedValueOnce(ok({ ok: true }));
    await call(r, { params: { id: "X-1" }, body: { n: 2 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/things/X-1/do");
    expect(init.method).toBe("POST");
    expect(init.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.body).toBe(JSON.stringify({ n: 2 }));
  });
  it("refreshes once on 401 and retries with the new token", async () => {
    setAccessToken("old");
    fetchMock
      .mockResolvedValueOnce(ok({ error: { code: "unauthenticated", message: "expired" } }, 401))
      .mockResolvedValueOnce(ok({ accessToken: "new", user: { id: "u1" }, mustChangePassword: false }))
      .mockResolvedValueOnce(ok({ user: { id: "u1" }, mustChangePassword: false }));
    await call(routes.me);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/auth/refresh");
    expect(fetchMock.mock.calls[2][1].headers.authorization).toBe("Bearer new");
    expect(getAccessToken()).toBe("new");
  });
  it("surfaces the server's message as an ApiError", async () => {
    setAccessToken("tok");
    fetchMock.mockResolvedValueOnce(ok({ error: { code: "rule", message: "Not enough Milk 1L free to promise." } }, 422));
    await expect(call(routes.me)).rejects.toMatchObject(new ApiError("rule", "Not enough Milk 1L free to promise.", 422));
  });
});

describe("wire formats", () => {
  it("renders ISO instants as HH:MM in the hospital's zone", () => { expect(fromWireTime("2026-09-03T01:02:00.000Z")).toBe("06:32"); });
  it("renders dates as DD-MMM-YYYY", () => { expect(fromWireDate("2026-08-31")).toBe("31-Aug-2026"); });
  it("renders a best-before like bestBefore()", () => { expect(fromWireBestBefore(new Date(Date.now() + 3600_000).toISOString())).toMatch(/^\d{2}:\d{2}/); });
});
```
In `UI/src/__tests__/screens.test.tsx`, replace the `sign-in` block:
```ts
describe("sign-in", () => {
  it("asks for an employee id and a password", () => {
    act(() => { useApp.setState({ user: null, auth: "signed-out" }); });
    const html = render(createElement(Login));
    expect(html).toContain("Employee id");
    expect(html).toContain("Password");
    for (const u of USERS) expect(html).not.toContain(u.n);
  });
});
```
Run: `pnpm --filter @rch/ui test` — Expected: FAIL (modules missing / old Login).

- [ ] **Step 2: Session, client, wire, fmt**

`UI/src/api/session.ts`:
```ts
let token: string | null = null;
const lost = new Set<() => void>();
export const getAccessToken = () => token;
export const setAccessToken = (t: string | null) => { token = t; };
/** Fires when a refresh fails: the store signs the user out. */
export const onSessionLost = (fn: () => void) => { lost.add(fn); return () => lost.delete(fn); };
export const sessionLost = () => { token = null; for (const f of lost) f(); };
```

`UI/src/api/client.ts` — the only `fetch` in the application:
```ts
import type { z } from "zod";
import { API_PREFIX, routes, type AnyRoute } from "@rch/contract";
import { getAccessToken, sessionLost, setAccessToken } from "./session";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: unknown) { super(message); this.name = "ApiError"; }
}
type Input = { params?: Record<string, string | number>; query?: Record<string, string | number | undefined>; body?: unknown };
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

function url(route: AnyRoute, input: Input): string {
  let p = route.path.replace(/:(\w+)/g, (_, k) => encodeURIComponent(String(input.params?.[k] ?? "")));
  const q = Object.entries(input.query ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  if (q) p += `?${q}`;
  return `${BASE}${API_PREFIX}${p}`;
}

async function raw(route: AnyRoute, input: Input, token: string | null): Promise<Response> {
  const isWrite = route.write ?? route.method !== "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (isWrite && route.access !== "public") headers["idempotency-key"] = crypto.randomUUID();
  return fetch(url(route, input), { method: route.method, headers, credentials: "include", body: input.body === undefined ? undefined : JSON.stringify(input.body) });
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (res.ok) return body;
  const e = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  throw new ApiError(e?.code ?? "internal", e?.message ?? `Request failed (${res.status}).`, res.status, e?.details);
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await raw(routes.refresh, {}, null);
      if (!r.ok) return false;
      const b = (await r.json()) as { accessToken: string };
      setAccessToken(b.accessToken);
      return true;
    } catch { return false; } finally { refreshing = null; }
  })();
  return refreshing;
}

/** Call a manifest route. Adding an endpoint is one manifest entry - never a new function here. */
export async function call<R extends AnyRoute>(route: R, input: Input = {}): Promise<z.infer<R["response"]>> {
  let res = await raw(route, input, getAccessToken());
  if (res.status === 401 && !route.path.startsWith("/auth/")) {
    if (await refresh()) res = await raw(route, input, getAccessToken());
    else { sessionLost(); }
  }
  return parse(res) as Promise<z.infer<R["response"]>>;
}
```

`UI/src/lib/fmt.ts` — add:
```ts
const TZ = "Asia/Kolkata";
/** An ISO instant from the API as the "HH:MM" the screens have always shown. */
export const fromWireTime = (isoStr: string): string =>
  /^\d{2}:\d{2}$/.test(isoStr) ? isoStr : new Date(isoStr).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });
/** "2026-08-31" -> "31-Aug-2026"; anything else passes through. */
export const fromWireDate = (d: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  const dt = new Date(`${d}T00:00:00+05:30`);
  return `${m[3]}-${dt.toLocaleDateString("en-IN", { month: "short", timeZone: TZ })}-${m[1]}`;
};
export const fromWireBestBefore = (isoStr: string): string => {
  const due = new Date(isoStr);
  return bestBefore(new Date(due.getTime() - 1), 1 / 3600000); // reuse the same day-boundary wording
};
```
If `bestBefore` cannot be reused cleanly for an absolute instant, write `fromWireBestBefore` by copying `bestBefore`'s body with `due = new Date(isoStr)` and `made = new Date()` — keep the three-way "today / tomorrow / dd-MMM" wording identical.

`UI/src/api/wire.ts`:
```ts
import type { z } from "zod";
import type { SnapshotSchema } from "@rch/contract";
import { hydrateMaster } from "../data/master";
import { fromWireBestBefore, fromWireDate, fromWireTime } from "../lib/fmt";
import { useApp } from "../store";
import { basePrices } from "../lib/selectors";

export type Snapshot = z.infer<typeof SnapshotSchema>;
const t = fromWireTime;
const hist = (h: { s: string; who: string; t: string }[]) => h.map((x) => ({ ...x, t: t(x.t) }));

/** Server shape -> the store's shape. Times become "HH:MM", dates "DD-MMM-YYYY"; nothing else changes. */
export function applySnapshot(s: Snapshot): void {
  hydrateMaster({ items: s.items, locations: s.locations as never, recipes: s.recipes, prices: s.prices, menu: s.menu, users: s.users });
  useApp.setState({
    user: s.user,
    stock: s.stock, rsv: s.rsv, ovr: s.ovr, prices: basePrices(), menu: s.menu,
    req: s.req.map((r) => ({ ...r, at: t(r.at), hist: hist(r.hist) })),
    tkt: s.tkt,
    prq: s.prq.map((p) => ({ ...p, at: t(p.at), hist: hist(p.hist) })),
    po: s.po.map((o) => ({ ...o, at: t(o.at), eta: fromWireDate(o.eta), recv: o.recv ? t(o.recv) : undefined, hist: hist(o.hist) })),
    pord: s.pord.map((o) => ({ ...o, at: t(o.at), hist: hist(o.hist) })),
    batch: s.batch.map((b) => ({ ...b, at: t(b.at), bb: fromWireBestBefore(b.bb) })),
    bills: s.bills.map((b) => ({ ...b, t: t(b.t) })),
    grn: s.grn.map((g) => ({ ...g, at: t(g.at) })),
    vendors: s.vendors, contracts: s.contracts,
    tickets: s.tickets.map((x) => ({ ...x, at: t(x.at), messages: x.messages.map((m) => ({ ...m, at: t(m.at) })) })),
    productReqs: s.productReqs.map((p) => ({ ...p, at: t(p.at) })),
    shopAsks: s.shopAsks.map((a) => ({ ...a, at: t(a.at) })),
    sales: s.sales, dayLabels: s.dayLabels,
  });
}
```
(`basePrices()` reads the freshly hydrated `PL`, so the store's `prices` follow the server.)

- [ ] **Step 3: Store**

In `UI/src/store/index.ts`:
- Add to `AppState`: `auth: "signed-out" | "signing-in" | "loading" | "ready"; mustChangePassword: boolean; login(emp: string, password: string): Promise<boolean>; logout(): Promise<void>; loadSnapshot(): Promise<void>; changePassword(current: string, next: string): Promise<boolean>;`
- Initial values: `auth: "signed-out", mustChangePassword: false`.
- Implementations (imports: `call`, `ApiError` from `../api/client`; `routes` from `@rch/contract`; `setAccessToken`, `onSessionLost` from `../api/session`; `applySnapshot` from `../api/wire`):
```ts
  login: async (emp, password) => {
    set({ auth: "signing-in" });
    try {
      const r = await call(routes.login, { body: { emp, password } });
      setAccessToken(r.accessToken);
      set({ user: r.user, mustChangePassword: r.mustChangePassword, auth: r.mustChangePassword ? "ready" : "loading" });
      if (!r.mustChangePassword) await get().loadSnapshot();
      return true;
    } catch (e) {
      set({ auth: "signed-out", user: null });
      get().notify(e instanceof ApiError ? e.message : "Could not reach the server - check the connection and try again.");
      return false;
    }
  },
  loadSnapshot: async () => {
    set({ auth: "loading" });
    try { applySnapshot(await call(routes.snapshot)); set({ auth: "ready" }); }
    catch (e) { set({ auth: "ready" }); get().notify(e instanceof ApiError ? e.message : "Could not load the latest data - showing what is in memory."); }
  },
  logout: async () => {
    try { await call(routes.logout); } catch { /* the cookie is gone either way */ }
    setAccessToken(null);
    set({ user: null, auth: "signed-out", drawer: null, mustChangePassword: false });
  },
  changePassword: async (current, next) => {
    try {
      await call(routes.changePassword, { body: { current, next } });
      set({ mustChangePassword: false, auth: "loading" });
      await get().loadSnapshot();
      get().notify("Password changed - you are signed in.");
      return true;
    } catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not change the password."); return false; }
  },
  saveProfile: async (p) => {
    try {
      const r = await call(routes.patchMe, { body: { n: p.n, e: p.e, ph: p.ph } });
      set({ user: r.user });
      get().notify("Profile saved");
    } catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not save the profile."); }
  },
```
Change `saveProfile`'s type to `(p: Partial<User>) => Promise<void>`; in `Settings.tsx:98` drop the local `notify("Profile saved")` (the store notifies). Keep `signIn` and `signOut` as they are (tests and the `Denied` flow use them); `Shell.tsx:64` calls `logout()` instead of `signOut()` and then `nav("/login")`.
After `create()`, register the session-lost hook:
```ts
onSessionLost(() => { useApp.setState({ user: null, auth: "signed-out" }); useApp.getState().notify("Your session ended - sign in again."); });
```

- [ ] **Step 4: Login and change-password screens; loading gate**

`UI/src/pages/Login.tsx` — replace the account list with a form. Keep the left-hand `lgb` panel exactly as it is; the right panel becomes:
```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { HOME } from "../nav";
import { useApp } from "../store";

export default function Login() {
  const [emp, setEmp] = useState("");
  const [pw, setPw] = useState("");
  const login = useApp((s) => s.login);
  const auth = useApp((s) => s.auth);
  const nav = useNavigate();
  const busy = auth === "signing-in" || auth === "loading";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emp.trim() || !pw) return;
    const ok = await login(emp.trim(), pw);
    if (!ok) return;
    const s = useApp.getState();
    nav(s.mustChangePassword ? "/change-password" : "/" + HOME[s.user!.r]);
  };
  return (
    <div id="login" style={{ display: "grid" }}>
      {/* …left panel unchanged… */}
      <div className="lgf"><form className="lgi" onSubmit={submit}>
        <h2>Sign in</h2>
        <p className="sub">Use your employee id and the password you were given. Each role has its own workspace, screens and permissions.</p>
        <div className="fg"><label htmlFor="emp">Employee id</label>
          <input className="inp mono" id="emp" autoComplete="username" autoFocus value={emp} onChange={(e) => setEmp(e.target.value)} placeholder="RC-0000" /></div>
        <div className="fg"><label htmlFor="pw">Password</label>
          <input className="inp mono" id="pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
        <button className="btn wide" disabled={busy || !emp.trim() || !pw} type="submit">{busy ? "Signing in…" : "Sign in"}</button>
        <p className="lgn">Forgotten your password? Ask the store keeper to reset it - you will be asked to choose a new one when you next sign in.</p>
      </form></div>
    </div>
  );
}
```
Remove the now-unused `USERS`, `homeLabel`, `Avatar` imports from `Login.tsx`.

`UI/src/pages/ChangePassword.tsx`:
```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { HOME } from "../nav";
import { useApp } from "../store";

export default function ChangePassword() {
  const [cur, setCur] = useState(""); const [next, setNext] = useState(""); const [again, setAgain] = useState("");
  const changePassword = useApp((s) => s.changePassword);
  const user = useApp((s) => s.user);
  const notify = useApp((s) => s.notify);
  const nav = useNavigate();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== again) { notify("The two new passwords do not match."); return; }
    if (next.length < 10) { notify("Choose at least ten characters."); return; }
    if (await changePassword(cur, next) && user) nav("/" + HOME[user.r]);
  };
  return (
    <div id="login" style={{ display: "grid" }}>
      <div className="lgf"><form className="lgi" onSubmit={submit}>
        <h2>Choose a new password</h2>
        <p className="sub">You are using a temporary password. Pick your own before you carry on.</p>
        <div className="fg"><label htmlFor="cur">Current password</label><input className="inp mono" id="cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></div>
        <div className="fg"><label htmlFor="new">New password</label><input className="inp mono" id="new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></div>
        <div className="fg"><label htmlFor="again">New password again</label><input className="inp mono" id="again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></div>
        <button className="btn wide" type="submit" disabled={!cur || !next || !again}>Save and continue</button>
      </form></div>
    </div>
  );
}
```

`UI/src/App.tsx` — add the route and the gate:
```tsx
import ChangePassword from "./pages/ChangePassword";
// inside App():
const auth = useApp((s) => s.auth);
const mcp = useApp((s) => s.mustChangePassword);
if (auth === "loading") return <div className="lgi" style={{ margin: "20vh auto" }}><h2>Loading…</h2><p className="sub">Fetching today's stock, requests and bills.</p></div>;
return (
  <Routes>
    <Route path="/login" element={user ? <Navigate to={mcp ? "/change-password" : "/" + HOME[user.r]} replace /> : <Login />} />
    <Route path="/change-password" element={user ? <ChangePassword /> : <Navigate to="/login" replace />} />
    <Route path="/:key" element={user ? (mcp ? <Navigate to="/change-password" replace /> : <Shell><Screen /></Shell>) : <Navigate to="/login" replace />} />
    <Route path="*" element={<Navigate to={user ? "/" + HOME[user.r] : "/login"} replace />} />
  </Routes>
);
```

`knip.json`: re-include `UI` in `workspaces` (it was excluded in Task 3); `hydrateMaster` is now used by `api/wire.ts`.

Run: `pnpm turbo typecheck lint test` — Expected: PASS (all UI suites, including `api.test.ts` and the changed sign-in test).

Run the whole thing locally: `pnpm db:up && pnpm --filter @rch/api db:migrate && pnpm --filter @rch/api db:seed && pnpm dev` → open `http://localhost:5173`, sign in as `RC-4471` / `changeme` → the POS renders with the seeded coffee-shop stock; open DevTools → Network shows `POST /api/v1/auth/login` and `GET /api/v1/snapshot`; refresh the page → still signed in after one `/auth/refresh`; sign out → `POST /auth/logout`. Sign in as `RC-3120` and confirm the manager sees all outlets.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Sign in against the server and render from its snapshot

One generic API client driven by the contract's manifest, a real
employee-id and password form with a forced first-time password change,
and the store hydrated from GET /snapshot; mutations stay local for now.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 17: Helm chart

**Files:**
- Create: `deploy/chart/rch/Chart.yaml`, `deploy/chart/rch/values.yaml`, `deploy/chart/rch/values-staging.yaml`, `deploy/chart/rch/values-prod.yaml`, `deploy/chart/rch/templates/_helpers.tpl`, `deploy/chart/rch/templates/api-deployment.yaml`, `api-service.yaml`, `api-hpa.yaml`, `api-pdb.yaml`, `ui-deployment.yaml`, `ui-service.yaml`, `ingress.yaml`, `migrate-job.yaml`, `purge-cronjob.yaml`, `configmap.yaml`, `secret.yaml`, `externalsecret.yaml`, `serviceaccount.yaml`, `servicemonitor.yaml`, `deploy/chart/rch/templates/NOTES.txt`
- Test: `deploy/chart/rch/tests/render.test.sh` (helm lint + template + assertions with `yq`/grep)

**Interfaces:**
- Consumes: image contracts from Task 15 (api `:3000`, `/healthz`, `/readyz`; ui `:8080`, `/healthz`), env names from `.env.example`.
- Produces: release `rch` in a namespace; Services `rch-api:3000`, `rch-ui:8080`; Ingress (ALB) routing `/api/*` and `/events` → api, `/` → ui; a `pre-install,pre-upgrade` migration Job; a nightly purge CronJob; Secret either created from values (`secrets.create=true`, for staging/dev) or synced from AWS Secrets Manager via ExternalSecret (`secrets.externalSecret.enabled=true`, for prod).

- [ ] **Step 1: Chart and values**

`Chart.yaml`:
```yaml
apiVersion: v2
name: rch
description: Royal Care Hospital F&B inventory and billing - API and UI
type: application
version: 0.1.0
appVersion: "0.1.0"
```
`values.yaml`:
```yaml
image:
  registry: ""            # e.g. 123456789012.dkr.ecr.ap-south-1.amazonaws.com
  api: rch-api
  ui: rch-ui
  tag: latest
  pullPolicy: IfNotPresent
api:
  replicas: 2
  resources: { requests: { cpu: 200m, memory: 256Mi }, limits: { cpu: "1", memory: 512Mi } }
  hpa: { enabled: true, minReplicas: 2, maxReplicas: 6, cpu: 70 }
  pdb: { minAvailable: 1 }
  env:
    LOG_LEVEL: info
    CORS_ORIGIN: https://rch.example.com
    RATE_LIMIT_PER_MINUTE: "300"
    LOGIN_RATE_LIMIT_PER_MINUTE: "10"
    DATABASE_SSL: "true"
    COOKIE_SECURE: "true"
    ACCESS_TOKEN_TTL: 15m
    REFRESH_TOKEN_TTL_DAYS: "30"
    OTEL_EXPORTER_OTLP_ENDPOINT: ""
ui:
  replicas: 2
  resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { cpu: 200m, memory: 128Mi } }
ingress:
  enabled: true
  className: alb
  host: rch.example.com
  certificateArn: ""
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443},{"HTTP":80}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=3600
    alb.ingress.kubernetes.io/healthcheck-path: /healthz
secrets:
  create: false           # true: build the Secret from the values below (staging, dev)
  values: { DATABASE_URL: "", JWT_PRIVATE_KEY: "", JWT_PUBLIC_KEY: "", JWT_PREVIOUS_PUBLIC_KEY: "" }
  externalSecret:
    enabled: false        # true: sync from AWS Secrets Manager via External Secrets Operator (prod)
    storeName: aws-secrets-manager
    storeKind: ClusterSecretStore
    remoteKey: rch/prod   # JSON secret with the four keys above
serviceAccount:
  create: true
  annotations: {}         # eks.amazonaws.com/role-arn for IRSA when the pod itself reads AWS
serviceMonitor: { enabled: false, interval: 30s }
migrate: { enabled: true, backoffLimit: 1, activeDeadlineSeconds: 600 }
purge: { enabled: true, schedule: "15 2 * * *" }
```
`values-staging.yaml`:
```yaml
api: { replicas: 2, hpa: { minReplicas: 2, maxReplicas: 3 }, env: { LOG_LEVEL: debug, CORS_ORIGIN: https://rch-staging.example.com } }
ui: { replicas: 1 }
ingress: { host: rch-staging.example.com }
secrets: { create: true }
```
`values-prod.yaml`:
```yaml
api: { replicas: 3, hpa: { minReplicas: 3, maxReplicas: 6 }, env: { CORS_ORIGIN: https://rch.example.com } }
ingress: { host: rch.example.com }
secrets: { create: false, externalSecret: { enabled: true, remoteKey: rch/prod } }
serviceMonitor: { enabled: true }
```

- [ ] **Step 2: Templates**

`templates/_helpers.tpl`:
```
{{- define "rch.name" -}}{{ .Chart.Name }}{{- end -}}
{{- define "rch.labels" -}}
app.kubernetes.io/name: {{ include "rch.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "rch.image" -}}{{ if .registry }}{{ .registry }}/{{ end }}{{ .name }}:{{ .tag }}{{- end -}}
{{- define "rch.secretName" -}}{{ .Release.Name }}-secrets{{- end -}}
{{- define "rch.sa" -}}{{ if .Values.serviceAccount.create }}{{ .Release.Name }}{{ else }}default{{ end }}{{- end -}}
```
`templates/api-deployment.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: {{ .Release.Name }}-api, labels: { {{- include "rch.labels" . | nindent 4 }}, app.kubernetes.io/component: api } }
spec:
  replicas: {{ .Values.api.replicas }}
  strategy: { type: RollingUpdate, rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } }
  selector: { matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/component: api } }
  template:
    metadata:
      labels: { {{- include "rch.labels" . | nindent 8 }}, app.kubernetes.io/component: api }
      annotations: { checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }} }
    spec:
      serviceAccountName: {{ include "rch.sa" . }}
      terminationGracePeriodSeconds: 30
      securityContext: { runAsNonRoot: true, runAsUser: 65532, fsGroup: 65532, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: api
          image: {{ include "rch.image" (dict "registry" .Values.image.registry "name" .Values.image.api "tag" .Values.image.tag) }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports: [{ name: http, containerPort: 3000 }]
          envFrom:
            - configMapRef: { name: {{ .Release.Name }}-config }
            - secretRef: { name: {{ include "rch.secretName" . }} }
          readinessProbe: { httpGet: { path: /readyz, port: http }, periodSeconds: 5, failureThreshold: 3 }
          livenessProbe: { httpGet: { path: /healthz, port: http }, periodSeconds: 10, failureThreshold: 3 }
          startupProbe: { httpGet: { path: /healthz, port: http }, periodSeconds: 2, failureThreshold: 30 }
          resources: {{- toYaml .Values.api.resources | nindent 12 }}
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
```
`templates/api-service.yaml`:
```yaml
apiVersion: v1
kind: Service
metadata: { name: {{ .Release.Name }}-api, labels: { {{- include "rch.labels" . | nindent 4 }} } }
spec: { selector: { app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/component: api }, ports: [{ name: http, port: 3000, targetPort: http }] }
```
`templates/api-hpa.yaml`:
```yaml
{{- if .Values.api.hpa.enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: {{ .Release.Name }}-api }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: {{ .Release.Name }}-api }
  minReplicas: {{ .Values.api.hpa.minReplicas }}
  maxReplicas: {{ .Values.api.hpa.maxReplicas }}
  metrics: [{ type: Resource, resource: { name: cpu, target: { type: Utilization, averageUtilization: {{ .Values.api.hpa.cpu }} } } }]
{{- end }}
```
`templates/api-pdb.yaml`:
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: {{ .Release.Name }}-api }
spec: { minAvailable: {{ .Values.api.pdb.minAvailable }}, selector: { matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/component: api } } }
```
`templates/ui-deployment.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: {{ .Release.Name }}-ui, labels: { {{- include "rch.labels" . | nindent 4 }}, app.kubernetes.io/component: ui } }
spec:
  replicas: {{ .Values.ui.replicas }}
  selector: { matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/component: ui } }
  template:
    metadata: { labels: { {{- include "rch.labels" . | nindent 8 }}, app.kubernetes.io/component: ui } }
    spec:
      securityContext: { runAsNonRoot: true, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: ui
          image: {{ include "rch.image" (dict "registry" .Values.image.registry "name" .Values.image.ui "tag" .Values.image.tag) }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          env: [{ name: API_UPSTREAM, value: http://{{ .Release.Name }}-api:3000 }]
          ports: [{ name: http, containerPort: 8080 }]
          readinessProbe: { httpGet: { path: /healthz, port: http }, periodSeconds: 5 }
          livenessProbe: { httpGet: { path: /healthz, port: http }, periodSeconds: 10 }
          resources: {{- toYaml .Values.ui.resources | nindent 12 }}
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
```
`templates/ui-service.yaml` — as `api-service.yaml` with `ui`, port `8080`.

`templates/ingress.yaml`:
```yaml
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .Release.Name }}
  annotations:
    {{- toYaml .Values.ingress.annotations | nindent 4 }}
    {{- if .Values.ingress.certificateArn }}
    alb.ingress.kubernetes.io/certificate-arn: {{ .Values.ingress.certificateArn }}
    {{- end }}
spec:
  ingressClassName: {{ .Values.ingress.className }}
  rules:
    - host: {{ .Values.ingress.host }}
      http:
        paths:
          - { path: /api, pathType: Prefix, backend: { service: { name: {{ .Release.Name }}-api, port: { number: 3000 } } } }
          - { path: /, pathType: Prefix, backend: { service: { name: {{ .Release.Name }}-ui, port: { number: 8080 } } } }
{{- end }}
```
`templates/migrate-job.yaml`:
```yaml
{{- if .Values.migrate.enabled }}
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ .Release.Name }}-migrate-{{ .Release.Revision }}
  annotations: { "helm.sh/hook": pre-install,pre-upgrade, "helm.sh/hook-weight": "0", "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded }
spec:
  backoffLimit: {{ .Values.migrate.backoffLimit }}
  activeDeadlineSeconds: {{ .Values.migrate.activeDeadlineSeconds }}
  template:
    spec:
      restartPolicy: Never
      serviceAccountName: {{ include "rch.sa" . }}
      securityContext: { runAsNonRoot: true, runAsUser: 65532 }
      containers:
        - name: migrate
          image: {{ include "rch.image" (dict "registry" .Values.image.registry "name" .Values.image.api "tag" .Values.image.tag) }}
          args: ["dist/cli/migrate.mjs"]
          envFrom: [{ configMapRef: { name: {{ .Release.Name }}-config } }, { secretRef: { name: {{ include "rch.secretName" . }} } }]
{{- end }}
```
Because the Job is a `pre-upgrade` hook that references the ConfigMap and Secret, those two templates carry `"helm.sh/hook": pre-install,pre-upgrade` with `hook-weight: "-5"` and `hook-delete-policy: before-hook-creation` **only if** you want them created before the Job — simpler: give the ConfigMap and Secret no hook annotations and add `"helm.sh/hook-weight": "5"` to the Job; Helm installs hooks after non-hook resources are rendered but the *first* install creates the ConfigMap after hooks. To avoid the chicken-and-egg on first install, the Job mounts the same values directly: replace `envFrom` in the Job with an explicit `env:` list built from `.Values.api.env` and, when `secrets.create`, from `.Values.secrets.values`; when using ExternalSecret, the Job's `secretRef` works because ESO syncs the Secret independently of Helm hooks. Encode this with a small helper `rch.envList` in `_helpers.tpl` and reuse it in the Deployment so the two never drift.

`templates/purge-cronjob.yaml`:
```yaml
{{- if .Values.purge.enabled }}
apiVersion: batch/v1
kind: CronJob
metadata: { name: {{ .Release.Name }}-purge }
spec:
  schedule: {{ .Values.purge.schedule | quote }}
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          securityContext: { runAsNonRoot: true, runAsUser: 65532 }
          containers:
            - name: purge
              image: {{ include "rch.image" (dict "registry" .Values.image.registry "name" .Values.image.api "tag" .Values.image.tag) }}
              args: ["dist/cli/purge.mjs"]
              envFrom: [{ configMapRef: { name: {{ .Release.Name }}-config } }, { secretRef: { name: {{ include "rch.secretName" . }} } }]
{{- end }}
```
`templates/configmap.yaml`:
```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: {{ .Release.Name }}-config }
data:
  NODE_ENV: production
  PORT: "3000"
{{- range $k, $v := .Values.api.env }}
  {{ $k }}: {{ $v | quote }}
{{- end }}
```
`templates/secret.yaml`:
```yaml
{{- if .Values.secrets.create }}
apiVersion: v1
kind: Secret
metadata: { name: {{ include "rch.secretName" . }} }
type: Opaque
stringData:
{{- range $k, $v := .Values.secrets.values }}
  {{ $k }}: {{ $v | quote }}
{{- end }}
{{- end }}
```
`templates/externalsecret.yaml`:
```yaml
{{- if .Values.secrets.externalSecret.enabled }}
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata: { name: {{ include "rch.secretName" . }} }
spec:
  refreshInterval: 1h
  secretStoreRef: { name: {{ .Values.secrets.externalSecret.storeName }}, kind: {{ .Values.secrets.externalSecret.storeKind }} }
  target: { name: {{ include "rch.secretName" . }}, creationPolicy: Owner }
  dataFrom: [{ extract: { key: {{ .Values.secrets.externalSecret.remoteKey }} } }]
{{- end }}
```
`templates/serviceaccount.yaml`:
```yaml
{{- if .Values.serviceAccount.create }}
apiVersion: v1
kind: ServiceAccount
metadata: { name: {{ .Release.Name }}, annotations: {{- toYaml .Values.serviceAccount.annotations | nindent 4 }} }
{{- end }}
```
`templates/servicemonitor.yaml`:
```yaml
{{- if .Values.serviceMonitor.enabled }}
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata: { name: {{ .Release.Name }}-api, labels: { release: kube-prometheus-stack } }
spec:
  selector: { matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }} } }
  endpoints: [{ port: http, path: /metrics, interval: {{ .Values.serviceMonitor.interval }} }]
{{- end }}
```
`templates/NOTES.txt`: three lines — the ingress host, how to run `users create` via `kubectl exec deploy/{{ .Release.Name }}-api -- /nodejs/bin/node dist/cli/users.mjs create …`, and how to roll back (`helm rollback {{ .Release.Name }}`).

- [ ] **Step 3: Render test**

`deploy/chart/rch/tests/render.test.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
helm lint . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x
helm lint . -f values-prod.yaml --set image.registry=r,image.tag=t
out=$(helm template rch . -f values-prod.yaml --set image.registry=r,image.tag=t)
grep -q 'kind: ExternalSecret' <<<"$out"
! grep -q 'kind: Secret$' <<<"$out"
grep -q 'readOnlyRootFilesystem: true' <<<"$out"
grep -q 'helm.sh/hook: pre-install,pre-upgrade' <<<"$out"
grep -q 'path: /readyz' <<<"$out"
grep -q 'idle_timeout.timeout_seconds=3600' <<<"$out"
out=$(helm template rch . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x)
grep -q 'kind: Secret' <<<"$out"
echo "chart renders"
```
Run: `chmod +x deploy/chart/rch/tests/render.test.sh && deploy/chart/rch/tests/render.test.sh` — Expected: `chart renders`. Add `"helm:test": "deploy/chart/rch/tests/render.test.sh"` to the root `package.json` scripts.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Describe the deployment as a Helm chart

API and UI deployments with probes and budgets, an ALB ingress, a
pre-upgrade migration job, a nightly purge, and secrets either inline for
staging or synced from Secrets Manager for production.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 18: CI/CD — checks, images, chart, and branch-bound deploys

**Files:**
- Modify: `.github/workflows/ci.yml` (rewrite)
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- `ci.yml` runs on every push to `develop`/`staging`/`production` and every PR: install → `turbo typecheck lint test` (Postgres service) → `pnpm audit --audit-level=high` → build-site → docker build both images (no push) → Trivy → `helm:test`.
- `deploy.yml` runs on push to `staging` and `production`: fast-forward guard, OIDC to AWS, push images to ECR tagged with the SHA, `helm upgrade --install`. Production job uses the GitHub environment `production` (reviewer approval). Both deploy jobs are skipped with a notice when the repository variable `DEPLOY_ENABLED` is not `"true"`, so the workflow is green before AWS exists.
- Required repository secrets/variables (documented in `deploy/RUNBOOK.md`): `AWS_ROLE_ARN`, `AWS_REGION`, `ECR_REGISTRY`, `EKS_CLUSTER_STAGING`, `EKS_CLUSTER_PROD`, staging `DATABASE_URL`/`JWT_*` as environment secrets; variable `DEPLOY_ENABLED`.

- [ ] **Step 1: `ci.yml`**

```yaml
name: CI
on:
  push: { branches: [develop, staging, production] }
  pull_request:
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
jobs:
  check:
    name: Typecheck, lint, test, build
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env: { POSTGRES_USER: rch, POSTGRES_PASSWORD: rch, POSTGRES_DB: rch_test }
        ports: ["5432:5432"]
        options: --health-cmd "pg_isready -U rch" --health-interval 5s --health-timeout 3s --health-retries 10
    env:
      TEST_DATABASE_URL: postgres://rch:rch@localhost:5432/rch_test
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v4
        with: { version: 10.28.2 }
      - uses: actions/setup-node@v7
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo typecheck lint test
      - run: pnpm audit --audit-level=high
      - name: Build the site
        run: bash scripts/build-site.sh
      - uses: actions/upload-artifact@v7
        with: { name: site, path: dist, retention-days: 7 }
  images:
    name: Container images
    runs-on: ubuntu-latest
    needs: check
    steps:
      - uses: actions/checkout@v7
      - uses: docker/setup-buildx-action@v3
      - name: Build api
        uses: docker/build-push-action@v6
        with: { context: ., file: apps/api/Dockerfile, push: false, load: true, tags: rch-api:ci, cache-from: type=gha, cache-to: type=gha,mode=max }
      - name: Build ui
        uses: docker/build-push-action@v6
        with: { context: ., file: UI/Dockerfile, push: false, load: true, tags: rch-ui:ci, cache-from: type=gha, cache-to: type=gha,mode=max }
      - name: Scan api
        uses: aquasecurity/trivy-action@0.28.0
        with: { image-ref: rch-api:ci, severity: CRITICAL, exit-code: "1", ignore-unfixed: true }
      - name: Scan ui
        uses: aquasecurity/trivy-action@0.28.0
        with: { image-ref: rch-ui:ci, severity: CRITICAL, exit-code: "1", ignore-unfixed: true }
  chart:
    name: Helm chart
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: azure/setup-helm@v4
      - run: deploy/chart/rch/tests/render.test.sh
```

- [ ] **Step 2: `deploy.yml`**

```yaml
name: Deploy
on:
  push: { branches: [staging, production] }
permissions: { id-token: write, contents: read }
concurrency: { group: deploy-${{ github.ref }}, cancel-in-progress: false }
jobs:
  guard:
    name: Fast-forward guard
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - name: staging must be an ancestor of develop; production of staging
        run: |
          set -e
          if [ "${GITHUB_REF_NAME}" = staging ]; then git merge-base --is-ancestor HEAD origin/develop; fi
          if [ "${GITHUB_REF_NAME}" = production ]; then git merge-base --is-ancestor HEAD origin/staging; fi
  deploy:
    name: Deploy ${{ github.ref_name }}
    needs: guard
    if: ${{ vars.DEPLOY_ENABLED == 'true' }}
    runs-on: ubuntu-latest
    environment: ${{ github.ref_name == 'production' && 'production' || 'staging' }}
    env:
      NS: ${{ github.ref_name == 'production' && 'rch' || 'rch-staging' }}
      VALUES: ${{ github.ref_name == 'production' && 'values-prod.yaml' || 'values-staging.yaml' }}
      CLUSTER: ${{ github.ref_name == 'production' && secrets.EKS_CLUSTER_PROD || secrets.EKS_CLUSTER_STAGING }}
    steps:
      - uses: actions/checkout@v7
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: ${{ secrets.AWS_ROLE_ARN }}, aws-region: ${{ secrets.AWS_REGION }} }
      - uses: aws-actions/amazon-ecr-login@v2
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with: { context: ., file: apps/api/Dockerfile, push: true, tags: "${{ secrets.ECR_REGISTRY }}/rch-api:${{ github.sha }}", cache-from: type=gha, cache-to: type=gha,mode=max }
      - uses: docker/build-push-action@v6
        with: { context: ., file: UI/Dockerfile, push: true, tags: "${{ secrets.ECR_REGISTRY }}/rch-ui:${{ github.sha }}", cache-from: type=gha, cache-to: type=gha,mode=max }
      - uses: azure/setup-helm@v4
      - run: aws eks update-kubeconfig --name "$CLUSTER" --region "${{ secrets.AWS_REGION }}"
      - name: helm upgrade
        run: |
          EXTRA=""
          if [ "${{ github.ref_name }}" = staging ]; then
            EXTRA="--set secrets.values.DATABASE_URL=${{ secrets.DATABASE_URL }} --set secrets.values.JWT_PRIVATE_KEY=${{ secrets.JWT_PRIVATE_KEY }} --set secrets.values.JWT_PUBLIC_KEY=${{ secrets.JWT_PUBLIC_KEY }}"
          fi
          helm upgrade --install rch deploy/chart/rch -n "$NS" --create-namespace -f "deploy/chart/rch/$VALUES" \
            --set image.registry="${{ secrets.ECR_REGISTRY }}" --set image.tag="${{ github.sha }}" $EXTRA --wait --timeout 10m
      - name: Tag production
        if: github.ref_name == 'production'
        run: |
          git config user.name ci && git config user.email ci@users.noreply.github.com
          TAG="v$(date -u +%Y.%m.%d)-${GITHUB_RUN_NUMBER}"; git tag "$TAG" && git push origin "$TAG"
  skipped:
    name: Deploy skipped (DEPLOY_ENABLED is not true)
    needs: guard
    if: ${{ vars.DEPLOY_ENABLED != 'true' }}
    runs-on: ubuntu-latest
    steps:
      - run: echo "Set repository variable DEPLOY_ENABLED=true and the AWS secrets to enable deploys. See deploy/RUNBOOK.md."
```
Run: `act` is not required; validate YAML with `pnpm dlx yaml-lint .github/workflows/*.yml` or `python3 -c 'import yaml,sys;[yaml.safe_load(open(f)) for f in sys.argv[1:]]' .github/workflows/*.yml`. Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Run the whole pipeline in CI and bind deploys to branches

Checks, images and the chart on every push; staging and production
deploy from their own branches through OIDC, with a fast-forward guard
so nothing reaches production that did not pass through staging.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

### Task 19: Docs, runbook, and the Phase 1 exit check

**Files:**
- Create: `deploy/RUNBOOK.md`
- Modify: `CLAUDE.md` (Commands section; Backend status), `README.md` (Running it; Status), `UI/README.md` (Run; Sign in), `.env.example` (already complete - verify), `docs/superpowers/specs/2026-09-03-backend-design.md` (no change unless a decision moved - record any deviation in §2)

- [ ] **Step 1: Runbook**

`deploy/RUNBOOK.md` sections, each with the exact commands:
1. **Local development** - `pnpm db:up`, `cp .env.example .env`, `pnpm --filter @rch/api keys:generate >> .env`, `db:migrate`, `db:seed`, `pnpm dev`; test users and the seed password.
2. **Deploy** - what a push to `staging`/`production` does; how to promote (`git merge --ff-only`); required secrets and variables (list from Task 18); first-time steps (namespace, ExternalSecret store, ACM certificate ARN into values).
3. **Roll back** - `helm history rch -n rch`, `helm rollback rch <rev> -n rch`; or revert the merge on `production`. Note that migrations are forward-only: a rollback that needs a schema change is a new migration.
4. **Rotate JWT keys** - generate a pair, set `JWT_PREVIOUS_PUBLIC_KEY` to the old public key, roll out, remove after 24h.
5. **Accounts** - `kubectl exec deploy/rch-api -n rch -- /nodejs/bin/node dist/cli/users.mjs create|reset-password|deactivate …`.
6. **Restore drill** - restore the latest RDS snapshot to a scratch instance; point a one-off Job at it with `dist/cli/rebuild-balances.mjs`; diff `stock_balances` against production; record the date. Before go-live and quarterly.
7. **Rebuild balances** - when and how (`dist/cli/rebuild-balances.mjs`); it locks the table for the duration.
8. **Read a document's history** - `select * from document_history where doc_type='request' and doc_id='REQ-2026-0913' order by at`.
9. **Alerts** - the five from spec §12 with the PromQL each is built on (`http_request_duration_seconds`, `up`, pg connection gauge from RDS CloudWatch).

- [ ] **Step 2: Docs**

`CLAUDE.md`: replace the *Commands* section with the pnpm/turbo commands (root `pnpm dev|typecheck|lint|test|build`, `pnpm db:up`, `pnpm --filter @rch/api db:migrate|db:seed|users|keys:generate`, `pnpm --filter @rch/ui test`), and change the *Backend* status line to "Phase 1 (Foundation) shipped; phases 2-6 pending - see spec §14". Keep every other section.
`README.md` *Running it*: the same commands; *Status*: sign-in is real, state is read from the server, mutations are still in-memory until Phase 2+.
`UI/README.md`: *Run* via pnpm from the root; *Sign in*: employee ids (`RC-4471` etc.) with the seed password, temporary-password flow.

- [ ] **Step 3: Phase 1 exit check (spec §14, row 1) - run every line, paste the output into the commit message body**

```bash
pnpm turbo typecheck lint test                  # all green, all packages
docker build -f apps/api/Dockerfile -t rch-api:x . && docker build -f UI/Dockerfile -t rch-ui:x .
pnpm helm:test                                  # chart renders
pnpm db:up && pnpm --filter @rch/api db:migrate && pnpm --filter @rch/api db:seed --force
pnpm --filter @rch/api dev &                    # then:
curl -fsS localhost:3000/readyz                 # {"ok":true}
curl -fsS -X POST localhost:3000/api/v1/auth/login -H 'content-type: application/json' -d '{"emp":"RC-3120","password":"changeme"}' | head -c 200
```
Staging deploy itself needs the AWS account (out of this plan's scope - spec §3); when `DEPLOY_ENABLED` is turned on, the push to `staging` performs it and the exit check's last line becomes `curl https://rch-staging.<host>/readyz`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Document how to run, deploy, roll back and recover Phase 1

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw"
```

---

## Execution order

Tasks in the same wave touch disjoint files and can run in parallel. A wave starts when every task in the previous wave is green (`pnpm turbo typecheck lint test`) and committed.

| Wave | Tasks | Why together |
|---|---|---|
| 1 | **1** → **2** → **3** (sequential) | Each edits `UI/package.json` and the lockfile |
| 2 | **4** ∥ **17** ∥ **15** (UI image + nginx only; the API image half waits for wave 6) | API skeleton; chart; nginx - no shared files |
| 3 | **5** ∥ **8** | Schema needs Task 4's app; contract schemas need only Task 3; both are independent of each other |
| 4 | **6** → **7** → **11** (sequential) | Seed uses the helpers; snapshot core uses the seed in its test |
| 5 | **9** ∥ **10** ∥ **12** ∥ **13** ∥ **14** | Each fills files the stubs of Tasks 8/11 created; no shared edits |
| 6 | **16** ∥ **15** (API image half) ∥ **18** ∥ **19** | UI cutover; Dockerfile; CI; docs |
| 7 | Exit check (Task 19 Step 3) | One person, one run, one commit |

Parallel tasks in the same working tree: agents do **not** run `pnpm install` unless their task adds a dependency (only Tasks 1, 2, 3 and 4 do, and they are never parallel with another installer), do **not** `git commit` (the coordinator commits per task after review, using each task's file list), and run tests with `pnpm --filter <pkg> test <path>` scoped to their own files to avoid contention on the shared Postgres. Each API test file already uses its own schema, so concurrent test runs do not collide.
