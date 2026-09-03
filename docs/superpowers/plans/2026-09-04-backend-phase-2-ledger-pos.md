# RCH Backend — Phase 2: Ledger + POS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Counter Operator sells from the server: `POST /bills` writes the sale through the append-only ledger with the same rules the browser applied locally, availability overrides and price/menu maintenance move to the server, and the Manager's price and menu screens cut over — with the shared rules living once in `packages/domain`.

**Architecture:** Phase 1's platform is complete (Fastify + Drizzle, contract manifest, `mount()`, idempotency, ledger helpers, snapshot). Phase 2 adds three write modules (`pos`, `availability`, `catalog`) that compose `withTransaction` → rules from `@rch/domain` → `postMoves`/`allocateId` → wire result, each returning `{ result, changed, message }` so the UI refetches what moved and shows the server's sentence. Business rules that today live in `UI/src/lib/selectors.ts` become master-data-parameterised functions in `packages/domain`; the UI selectors become one-line adapters over its registries, so no screen changes. Hardening the final Phase 1 review asked for lands first: an append-only trigger on `stock_moves`, pool and sequence metrics, `users(min)` in the snapshot, and a real `helm install` in CI.

**Tech Stack:** unchanged from Phase 1 — Node 24, pnpm 10, Turborepo 2, TypeScript ~6.0, Fastify 5, fastify-type-provider-zod 7, Zod 4, Drizzle 0.45 + drizzle-kit 0.31, pg 8, PostgreSQL 17, Vitest 4, tsup 8, Helm 3; CI adds `kind` for a throwaway cluster.

**Spec:** `docs/superpowers/specs/2026-09-03-backend-design.md` — §5.1 (reuse rules), §6 (architecture, error envelope, idempotency), §7 (ledger), §9.2 (rules per endpoint: `pay`, `toggleAvail`, `savePrice`, `addProduct`/`removeProduct`), §9.3 (write responses), §10 (cutover), §12 (bar), §14 row 2 (exit), §16 (amendments). **Ledger of Phase 1:** `docs/superpowers/plans/2026-09-03-backend-phase-1-foundation-ledger.md` — its "Phase 2" triage items are folded into Task 9 here.

## Global Constraints

- **Branch model:** work on `feat/phase-2-ledger-pos` from `develop`; never push to `staging`/`production`.
- **Conventions settled in Phase 1 (binding):** `apps/api` and `packages/*` relative imports carry `.js`; no constructor parameter properties (`erasableSyntaxOnly`); `strict` TS; UI uses bundler resolution (no extensions); every DB test file uses its own `withTestSchema("<unique>")`/`buildTestApp({ schema })`; local Postgres is Docker on host port **5439**; Node 24 at `$(brew --prefix node@24)/bin`; Agent-tool worktrees start with `git merge --ff-only feat/phase-2-ledger-pos`.
- **Every write is one transaction** (`withTransaction`), rules via `assertRule` with the operator-facing sentence, quantities via `round3`, moves only via `postMoves`, ids only via `allocateId`, history only via `appendHistory`. `scripts/check-boundaries.sh` enforces the protected tables — do not touch them elsewhere.
- **Routes only via `mount(app, routes.<name>, handler)`**; every module is `routes.ts / service.ts / repo.ts / <name>.test.ts` (copy `apps/api/src/modules/_template/`).
- **Write response shape (spec §9.3):** `{ result: <document in types.ts shape>, changed: string[], message: string }` — `changed` lists snapshot collections to refetch (`"stock"`, `"bills"`, `"ovr"`, `"prices"`, `"menu"`); `message` is the toast sentence the UI shows (moved verbatim from the store's `notify()` texts).
- **Refusals** are `RuleError` (422) with the exact sentences the store uses today; RBAC 404 for absent modules; location scoping 403 via `requireLoc`.
- **Wire shape** is `types.ts`; times ISO; money `numeric(12,2)`; quantities `numeric(12,3)` rounded with `round3`.
- **Every task ends green:** `pnpm turbo typecheck test && pnpm lint` (turbo lint + knip + boundaries) at the root; UI tests keep passing (rewrite the store tests that exercised local rules into API-backed store tests as each task says — never leave a test asserting behaviour that moved).
- **Commit messages:** imperative sentence + trailers
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
  ```

---

## File structure (what Phase 2 adds or changes)

```
packages/domain/src/
  master.ts            type Master = { items, locations, recipes }  (the registries the rules read)
  pricing.ts           priceOf(master, prices, loc, it): Price
  availability.ts      availOf(master, stock, rsv, ovr, loc, it): Availability ; qty/resv/avail helpers
  promise.ts           committed(reqs, loc, it) ; freeToPromise(master?, stock, rsv, reqs, loc, it)
  costing.ts           recipeCost(master, it) ; costOf(master, it)
  billing.ts           billLines(master, prices, loc, cart) → { lines, tot, tax, moves }  (pure)
  transitions.ts       (Phase 3)  — not here
packages/contract/src/schemas/writes.ts     WriteResponse(schema), PayBody, ToggleAvailBody, SavePriceBody/Params, MenuItemBody/Params
packages/contract/src/routes.ts             + pay, toggleAvail, savePrice, addMenuItem, removeMenuItem, stock, bills
apps/api/src/lib/master.ts                  loadMaster(db): Master (items/locations/recipes from the tables, cached per request)
apps/api/src/lib/metrics-db.ts              pool gauges + sequence counter registration
apps/api/src/modules/pos/                   POST /bills
apps/api/src/modules/availability/          POST /availability/toggle
apps/api/src/modules/catalog/               PUT /prices/:list/:it, POST/DELETE /menus/:loc/items[/:it]
apps/api/src/modules/snapshot/readers/      + readStockOnly/readBills exposed as GET /stock, GET /bills
apps/api/drizzle/0002_stock_moves_append_only.sql   trigger
UI/src/lib/selectors.ts                     adapters over @rch/domain (same exported names)
UI/src/store/index.ts                       pay/toggleAvail/savePrice/addProduct/removeProduct → API + refetch(changed)
UI/src/api/refetch.ts                       refetch(changed: string[]) → GET /stock | /bills | /snapshot
.github/workflows/ci.yml                    + chart-install job (kind)
deploy/chart/rch/ci/                        values-ci.yaml + postgres manifest for the kind job
```

---

### Task 1: Move the rules into `@rch/domain`, parameterised by master data

**Files:**
- Create: `packages/domain/src/master.ts`, `pricing.ts`, `availability.ts`, `promise.ts`, `costing.ts`, `billing.ts` and tests `pricing.test.ts`, `availability.test.ts`, `promise.test.ts`, `costing.test.ts`, `billing.test.ts`
- Modify: `packages/domain/src/index.ts`, `packages/domain/package.json` (add `"@rch/contract": "workspace:*"` — types only), `UI/src/lib/selectors.ts` (adapters), `UI/src/__tests__/store.test.ts` (only if an import changes; behaviour unchanged)

**Interfaces:**
- Produces (all pure, no I/O):
  ```ts
  export type Master = { items: Record<string, Item>; locations: Record<string, Location>; recipes: Record<string, Recipe> };
  export type StockMap = Record<string, Record<string, number>>;   // loc → item → on hand
  export type RsvMap = Record<string, number>;                     // "loc:item" → reserved
  export type OvrMap = Record<string, string>;                     // "loc:item" → reason
  export type Prices = { A: Record<string, number>; B: Record<string, number> };
  export const qty = (stock: StockMap, l: string, it: string) => stock[l]?.[it] ?? 0;
  export const resv = (rsv: RsvMap, l: string, it: string) => rsv[`${l}:${it}`] ?? 0;
  export const avail = (stock, rsv, l, it) => qty − resv;
  export function priceOf(m: Master, prices: Prices, l: string, it: string): Price;          // MRP cap at read time
  export function availOf(m: Master, stock: StockMap, rsv: RsvMap, ovr: OvrMap, l: string, it: string): Availability;
  export function committed(reqs: Pick<StockRequest, "st" | "ticket" | "lines">[], l: string, it: string): number;
  export function freeToPromise(stock: StockMap, rsv: RsvMap, reqs: …, l: string, it: string): number;
  export function recipeCost(m: Master, it: string): number;  export function costOf(m: Master, it: string): number;
  export type BillPlan = { lines: BillLine[]; tot: number; tax: number; moves: { loc: string; it: string; qty: number }[]; capped: string[] };
  export function planBill(m: Master, prices: Prices, l: string, cart: Record<string, number>): BillPlan;  // the arithmetic of pay(): prices, tax, recipe explosion → negative moves
  ```
- `planBill` does NOT check availability or payer rules — those are `assertRule`s in the service (Task 4) using `availOf`; it only computes. `capped` lists items whose listed price exceeded MRP (for the message).
- UI adapters keep every current export of `selectors.ts` with the same signatures, delegating: e.g. `export const priceOf = (s: StockShape, l: LocKey, it: string) => D.priceOf({ items: IT, locations: LOC, recipes: RCP }, s.prices, l, it);`. `qty/resv/avail` adapters take `StockShape` as today.

- [ ] **Step 1: Failing tests** — port the arithmetic the UI already pins. Use fixtures from `@rch/contract/fixtures` (`IT, LOC, RCP, PL, seedStock, seedRsv`):

`packages/domain/src/pricing.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { IT, LOC, PL, RCP } from "@rch/contract/fixtures";
import { priceOf } from "./pricing";
const M = { items: IT, locations: LOC, recipes: RCP };
describe("priceOf", () => {
  it("reads the location's list", () => { expect(priceOf(M, PL, "rest", "capp")).toEqual({ p: 60, listed: 60, capped: false }); expect(priceOf(M, PL, "coffee", "capp").p).toBe(75); });
  it("caps a traded item at its printed MRP", () => {
    const prices = { A: { ...PL.A, juice: 25 }, B: PL.B };
    expect(priceOf(M, prices, "rest", "juice")).toEqual({ p: 20, listed: 25, capped: true });
  });
  it("is zero for a location without a list or an unlisted item", () => { expect(priceOf(M, PL, "store", "capp").p).toBe(0); expect(priceOf(M, PL, "rest", "milk").p).toBe(0); });
});
```
`packages/domain/src/availability.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { IT, LOC, RCP, seedStock } from "@rch/contract/fixtures";
import { availOf } from "./availability";
const M = { items: IT, locations: LOC, recipes: RCP };
describe("availOf", () => {
  it("a manual override wins", () => { expect(availOf(M, seedStock, {}, { "coffee:capp": "switched off manually" }, "coffee", "capp")).toEqual({ ok: false, mode: "Manual", why: "switched off manually" }); });
  it("a made-to-order item is off when an ingredient runs out and names it", () => {
    const a = availOf(M, seedStock, {}, {}, "coffee", "capp"); // coffee has milk: 0
    expect(a.ok).toBe(false); expect(a.mode).toBe("Recipe"); expect(a.why).toMatch(/Milk 1L/);
  });
  it("counts portions from the binding ingredient net of reservations", () => {
    const a = availOf(M, seedStock, {}, {}, "rest", "capp"); // rest: milk 14, beans 2, sugar 3, cup 220
    expect(a).toEqual({ ok: true, mode: "Recipe", left: "93 portions" }); // min(14/0.15, 2/0.012, 3/0.006, 220/1) = 93
    expect(availOf(M, seedStock, { "rest:milk": 14 }, {}, "rest", "capp").ok).toBe(false);
  });
  it("a traded item is off at zero", () => { expect(availOf(M, seedStock, {}, {}, "kiosk", "juice")).toEqual({ ok: true, mode: "Stock", left: "14 nos" }); expect(availOf(M, seedStock, {}, {}, "coffee", "milk").ok).toBe(false); });
});
```
`packages/domain/src/promise.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { seedReq, seedRsv, seedStock } from "@rch/contract/fixtures";
import { committed, freeToPromise } from "./promise";
describe("free to promise", () => {
  it("nets on-hand against open tickets and approved-but-unticketed requests", () => {
    const reqs = [{ st: "Manager approved" as const, ticket: null, lines: [{ it: "milk", qty: 5, appr: 4 }] }];
    expect(committed(reqs, "store", "milk")).toBe(4);
    expect(freeToPromise(seedStock, seedRsv(), reqs, "store", "milk")).toBe(12 - (seedRsv()["store:milk"] ?? 0) - 4);
    expect(committed(seedReq, "store", "milk")).toBe(seedReq.filter((r) => (r.st === "Manager approved" || r.st === "Partially approved") && !r.ticket).reduce((t, r) => t + r.lines.filter((l) => l.it === "milk").reduce((n, l) => n + l.appr, 0), 0));
  });
});
```
`packages/domain/src/costing.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { IT, LOC, RCP } from "@rch/contract/fixtures";
import { costOf, recipeCost } from "./costing";
const M = { items: IT, locations: LOC, recipes: RCP };
describe("costing", () => {
  it("a made item costs its recipe plus overhead, never zero", () => {
    const raw = 0.15 * 52 + 0.012 * 640 + 0.006 * 46 + 1 * 0.62;
    expect(recipeCost(M, "capp")).toBeCloseTo(raw * 1.12, 6); expect(costOf(M, "capp")).toBeCloseTo(raw * 1.12, 6);
  });
  it("a traded item costs its cost", () => { expect(costOf(M, "juice")).toBe(14.2); expect(recipeCost(M, "juice")).toBe(0); });
});
```
`packages/domain/src/billing.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { IT, LOC, PL, RCP } from "@rch/contract/fixtures";
import { planBill } from "./billing";
const M = { items: IT, locations: LOC, recipes: RCP };
describe("planBill", () => {
  it("prices each line at the till price, totals, and derives GST from inclusive prices", () => {
    const b = planBill(M, PL, "coffee", { juice: 2, chips: 2, bisc: 1 }); // 20*2 + 20*2 + 30 = 110 (list B)
    expect(b.tot).toBe(110); expect(b.tax).toBeCloseTo(40 - 40 / 1.12 + 40 - 40 / 1.12 + 30 - 30 / 1.18, 6);
    expect(b.lines).toEqual([{ it: "juice", qty: 2, rate: 20 }, { it: "chips", qty: 2, rate: 20 }, { it: "bisc", qty: 1, rate: 30 }]);
    expect(b.moves).toEqual([{ loc: "coffee", it: "juice", qty: -2 }, { loc: "coffee", it: "chips", qty: -2 }, { loc: "coffee", it: "bisc", qty: -1 }]);
  });
  it("explodes a made-to-order line into its recipe, rounded to three decimals", () => {
    const b = planBill(M, PL, "rest", { capp: 2 });
    expect(b.moves).toEqual([{ loc: "rest", it: "milk", qty: -0.3 }, { loc: "rest", it: "beans", qty: -0.024 }, { loc: "rest", it: "sugar", qty: -0.012 }, { loc: "rest", it: "cup", qty: -2 }]);
  });
  it("reports capped items", () => { const b = planBill(M, { A: { ...PL.A, juice: 25 }, B: PL.B }, "rest", { juice: 1 }); expect(b.lines[0].rate).toBe(20); expect(b.capped).toEqual(["juice"]); });
});
```
Run: `pnpm --filter @rch/domain test` → FAIL (modules missing).

- [ ] **Step 2: Implement** — port the bodies from `UI/src/lib/selectors.ts` (`priceOf`, `availOf`, `committed`, `freeToPromise`, `recipeCost`, `costOf`) and from `UI/src/store/index.ts` `pay()` (the pricing/tax/recipe loop) replacing registry reads with the `m: Master` parameter. `availOf` formats `left`/`why` with the same wording as today (`fq`/`U` equivalents: countable units whole, others three decimals; unit from `m.items[it].u`, default `"nos"`). `planBill` iterates `Object.keys(cart)` in insertion order, uses `priceOf`, `tax += amt − amt/(1+gst/100)`, MTO → recipe lines `round3(need × qty)` negative moves at `l`, others one negative move per item; `tot`/`tax` rounded to 2 dp via `Math.round(x*100)/100`.
`packages/domain/src/index.ts` exports everything. `packages/domain/package.json` gains `"@rch/contract": "workspace:*"` under dependencies (type imports only; `packages/domain/tsconfig.json` unchanged).

- [ ] **Step 3: UI adapters** — `UI/src/lib/selectors.ts`: delete the bodies of `priceOf`, `availOf`, `committed`, `freeToPromise`, `recipeCost`, `costOf`; replace with adapters that call `@rch/domain` with `{ items: IT, locations: LOC, recipes: RCP }` and the `StockShape`; keep `qty/resv/avail` exported with their current `(s, l, it)` signatures delegating to domain. Everything else in the file stays. Run `pnpm turbo typecheck test && pnpm lint` — UI 307 tests still pass (their assertions now exercise the domain code through the adapters).

- [ ] **Step 4: Commit** — "Move the pricing, availability and promise rules into the domain package".

---

### Task 2: Contract — write schemas, `WriteResponse`, and the Phase 2 routes

**Files:**
- Create: `packages/contract/src/schemas/writes.ts`
- Modify: `packages/contract/src/routes.ts`, `packages/contract/src/index.ts`, `packages/contract/src/schemas/snapshot.ts` (add `StockResponseSchema`, `BillsResponseSchema`), `packages/contract/src/routes.test.ts` (body samples for the new write routes)

**Interfaces:**
```ts
// writes.ts
export const ChangedSchema = z.array(z.enum(["stock", "rsv", "ovr", "prices", "menu", "bills", "req", "tkt", "prq", "po", "pord", "batch", "grn", "vendors", "contracts", "tickets", "productReqs", "shopAsks"]));
export const writeResponse = <T extends z.ZodTypeAny>(result: T) => z.strictObject({ result, changed: ChangedSchema, message: z.string() });
export const PayBodySchema = z.strictObject({ loc: LocKeySchema, tender: z.string().min(1).max(40), payer: PayerSchema.optional(), lines: z.array(z.strictObject({ it: z.string().min(1).max(64), qty: z.number().positive().max(10000) })).min(1).max(100) });
export const ToggleAvailBodySchema = z.strictObject({ loc: LocKeySchema, it: z.string().min(1).max(64) });
export const SavePriceParamsSchema = z.strictObject({ list: PriceListSchema, it: z.string().min(1).max(64) });
export const SavePriceBodySchema = z.strictObject({ price: z.number().nonnegative().max(100000) });
export const MenuLocParamsSchema = z.strictObject({ loc: LocKeySchema });
export const MenuItemParamsSchema = z.strictObject({ loc: LocKeySchema, it: z.string().min(1).max(64) });
export const MenuItemBodySchema = z.strictObject({ it: z.string().min(1).max(64) });
export const ToggleResultSchema = z.strictObject({ loc: LocKeySchema, it: z.string(), off: z.boolean(), reason: z.string().optional() });
export const PriceResultSchema = z.strictObject({ list: PriceListSchema, it: z.string(), price: z.number() });
export const MenuResultSchema = z.strictObject({ loc: LocKeySchema, items: z.array(z.string()) });
// snapshot.ts additions
export const StockResponseSchema = z.strictObject({ stock: SnapshotSchema.shape.stock, rsv: SnapshotSchema.shape.rsv, ovr: SnapshotSchema.shape.ovr });
export const BillsResponseSchema = z.array(BillSchema);
// routes.ts additions
pay:            defineRoute({ method: "POST",   path: "/bills",                      access: ["counter"],            body: PayBodySchema,        response: writeResponse(BillSchema) }),
toggleAvail:    defineRoute({ method: "POST",   path: "/availability/toggle",        access: ["counter", "manager"], body: ToggleAvailBodySchema, response: writeResponse(ToggleResultSchema) }),
savePrice:      defineRoute({ method: "PUT",    path: "/prices/:list/:it",           access: ["manager"],            params: SavePriceParamsSchema, body: SavePriceBodySchema, response: writeResponse(PriceResultSchema) }),
addMenuItem:    defineRoute({ method: "POST",   path: "/menus/:loc/items",           access: ["manager"],            params: MenuLocParamsSchema, body: MenuItemBodySchema, response: writeResponse(MenuResultSchema) }),
removeMenuItem: defineRoute({ method: "DELETE", path: "/menus/:loc/items/:it",       access: ["manager"],            params: MenuItemParamsSchema, response: writeResponse(MenuResultSchema) }),
stock:          defineRoute({ method: "GET",    path: "/stock",                      access: "any",                  response: StockResponseSchema }),
bills:          defineRoute({ method: "GET",    path: "/bills",                      access: "any",                  query: z.strictObject({ days: z.coerce.number().int().min(1).max(90).default(7) }), response: BillsResponseSchema }),
```
- The contract `routes.test.ts` "every body schema rejects an unknown key" case needs a valid sample per new body route — add them. `apps/api/src/contract.test.ts` iterates GET routes without params/query; `bills` has a query with a default — extend that test to include GET routes whose query schema parses `{}` (call with no query string).

- [ ] Steps: write the schemas and routes; `pnpm turbo typecheck test --filter=@rch/contract --filter=@rch/ui` green (UI unaffected); commit "Declare the Phase 2 write routes in the contract".

---

### Task 3: Ledger hardening, master loader, metrics, `users(min)`, `GET /stock` and `GET /bills`

**Files:**
- Create: `apps/api/src/lib/master.ts`, `apps/api/src/lib/metrics-db.ts`, `apps/api/drizzle/0002_stock_moves_append_only.sql` (+ journal/snapshot via `db:generate`? — see below), `apps/api/src/lib/master.test.ts`, `apps/api/src/lib/ledger-trigger.test.ts`
- Modify: `apps/api/src/lib/ledger.ts` (map key separator), `apps/api/src/lib/ids.ts` (sequence counter), `apps/api/src/plugins/db.ts` (pool gauges), `apps/api/src/lib/wire.ts` (`toWireUserMin`), `apps/api/src/modules/snapshot/readers/master.ts` (`readUsers` → min), `apps/api/src/modules/snapshot/service.ts`, `apps/api/src/modules/snapshot/routes.ts` (mount `stock`, `bills`), `apps/api/src/modules/snapshot/snapshot.test.ts`, `packages/contract/src/schemas/documents.ts` + `snapshot.ts` (`UserMinSchema` for the `users` array), `UI/src/data/master.ts` (`MasterData.users` typed as `UserMin[]`; `USERS` registry becomes `UserMin[]` — check consumers: `homeLabel`, `Shell`, `screens.test` iterate `USERS` for names/roles only; `signIn(id)` in tests uses `USERS.find(u => u.id …)` and sets `user` to that record → the store's `user` must stay a full `User` — keep `signIn` reading from a full-user list: fixtures' `USERS` remain full for tests; the server's `users` array is min. Resolve by giving the registry type `UserMin` and making `signIn(id)` take the record from `FX.USERS` (fixtures) in test mode — simplest: `signIn` stays as is but the `USERS` registry keeps the fixture's FULL users until hydration replaces them with min users; `user: UserMin as User`? No — do it properly: store `user: User` (own record, from login/`/me`), registry `USERS: UserMin[]`; `signIn(id)` (tests only) looks up `FX.USERS` from `@rch/contract/fixtures` directly. Update `UI/src/__tests__/fixture.ts` `as(role)` accordingly.)

**Interfaces:**
- `loadMaster(db: Db | Tx): Promise<Master>` — items (active), locations (all incl. quarantine — rules ignore it), recipes; one query each. Services call it once per request inside the transaction.
- Migration `0002`: `CREATE FUNCTION stock_moves_append_only() RETURNS trigger … RAISE EXCEPTION 'stock_moves is append-only; correct with a reversing move'`; `CREATE TRIGGER stock_moves_no_update_delete BEFORE UPDATE OR DELETE ON stock_moves FOR EACH ROW EXECUTE FUNCTION stock_moves_append_only();`. Written by hand (drizzle-kit does not generate triggers): add the SQL file, append a journal entry with the next idx and tag `0002_stock_moves_append_only`, and copy `meta/0001_snapshot.json` to `meta/0002_snapshot.json` updating `id`/`prevId` (drizzle's migrator only needs the journal + SQL; the snapshot keeps `db:generate` diffs sane). **Exception:** `truncateAll()` in tests and `seedDatabase(force)` truncate `stock_moves` — `TRUNCATE` does not fire row triggers, so they keep working; `rebuildBalances` touches only `stock_balances`. Test: an `UPDATE`/`DELETE` on `stock_moves` rejects with the message; `TRUNCATE` still works.
- `apps/api/src/lib/ledger.ts`: replace the `${loc} ${it}` string key with a ` `-joined key (`const K = (l, i) => \`${l} ${i}\``; split on ` `).
- Metrics (`metrics-db.ts`): `pg_pool_total`, `pg_pool_idle`, `pg_pool_waiting` gauges collected from `pool.totalCount/idleCount/waitingCount` on scrape (`collect()` callback); `sequence_allocations_total{kind}` counter incremented in `allocateId` via a tiny registry hook (`recordAllocation(kind)` exported from `metrics-db.ts`; `ids.ts` imports it — keep `lib/` free of Fastify types by exporting a plain function that the metrics plugin registers into). Test: `/metrics` body contains `pg_pool_total` and, after one `allocateId`, `sequence_allocations_total{kind="tkt"} 1`.
- `UserMinSchema = z.strictObject({ id, n, r, rl, loc, col })`; `SnapshotSchema.users: z.array(UserMinSchema)`; `toWireUserMin(row)`; `readUsers` returns min. The caller's own full record stays in `snapshot.user`.
- Pre-register three module STUBS so Wave 3 can run in parallel without touching a shared file: create `apps/api/src/modules/{pos,availability,catalog}/routes.ts` each as `fp(async () => {}, { name: "module:<name>" })` with the other three skeleton files copied from `_template` (so `check-boundaries.sh`'s skeleton rule passes) and register them in `modules/index.ts`.
- `GET /stock` → `{ stock, rsv, ovr }` (scoped like the snapshot for a counter — reuse `scope()`'s stock/rsv/ovr filtering by extracting `scopeStock(part, claims)`); `GET /bills?days=` → `Bill[]` scoped to the counter's loc. Both mounted in the snapshot module (they are reads of the same collections).

- [ ] Steps: failing tests (`master.test.ts`: `loadMaster` equals fixtures for items/locations/recipes; `ledger-trigger.test.ts`: UPDATE/DELETE refused, TRUNCATE ok; metrics assertions in `app.test.ts` or a new `metrics.test.ts` with `withDb`; snapshot tests for `users` min shape and the two GETs incl. counter scoping) → implement → `pnpm turbo typecheck test && pnpm lint` green (UI: fixture/test adjustments for `UserMin`) → commit "Harden the ledger, expose stock and bills, and meter the pool".

---

### Task 4: `pos` module — `POST /bills`

**Files:**
- Create: `apps/api/src/modules/pos/{routes,service,repo,pos.test}.ts`
- Modify: `apps/api/src/modules/index.ts` (register), `apps/api/src/lib/wire.ts` (`toWireBill(row, lines, operator)` — move the mapping the snapshot reader uses into `wire.ts` and have `readBills` reuse it)

**Interfaces:**
- `createPosService(db).pay(claims: AccessClaims, body: PayBody): Promise<WriteResponse<Bill>>`.
- Rules (spec §9.2 `pay`, sentences verbatim from the store):
  1. `requireLoc(req, body.loc, "your own counter")` (403).
  2. `assertRule(lines.length > 0, "Add at least one item to the bill")` — (schema already enforces min 1; keep the rule for folded duplicates).
  3. Payer: `NEEDS_PAYER = { "Patient bill": "patient", "Staff credit": "staff member", Dept: "department" }`; `assertRule(!(NEEDS_PAYER[tender] && !payer), \`Choose a ${NEEDS_PAYER[tender]} before taking a ${tender.toLowerCase()}\`)`.
  4. Every item exists and is listed at `loc` (`location_items`): `assertRule(listed, \`${item.n} is not listed at ${loc.n}\`)`.
  5. Availability: `availOf(master, stock, rsv, ovr, loc, it)` must be `ok` for each line → `assertRule(a.ok, \`${item.n} is not available at ${loc.n} — ${a.why}\`)`; and the quantity must be coverable: for a traded item `avail ≥ qty`, for MTO every ingredient `avail ≥ need × qty` → `\`Only ${fq(avail)} ${unit} of ${item.n} left at ${loc.n}\`` (new sentence — the browser silently went negative; the server refuses).
  6. `planBill(master, prices, loc, cart)` → lines/tot/tax/moves (cart folds duplicate `it`s by summing qty).
  7. In one transaction: read stock/rsv/ovr for `loc` (`readStock`-style queries restricted to loc), run rules 4–6, `allocateId(tx, "bill")`, insert `bills` + `bill_lines`, `postMoves(tx, moves.map(m => ({ ...m, kind: "sale", refType: "bill", refId: no, by: claims.sub })))`.
  8. Response `{ result: toWireBill(...), changed: ["stock", "bills"], message }` where message = payer ? `\`Bill ${no} · ₹${tot.toFixed(2)} posted to ${payer.name}\`` : `\`Bill ${no} · ₹${tot.toFixed(2)} ${tender === "Cash" ? "collected" : "settled by " + tender.toLowerCase()} at ${loc.n}\``.
- Concurrency: `postMoves` locks balances; two simultaneous sales of the last unit → the second fails rule 5 only if it read stock after the first committed. To make the check race-safe, read the balances **after** taking the locks: call `postMoves` with the negative moves first (it locks rows), then re-read `on_hand` inside the same transaction and `assertRule(on_hand ≥ 0 for every touched (loc,item))` → RuleError rolls the transaction back. Keep the pre-check (rule 5) for the friendly message and add the post-lock check as the guarantee. Test with two concurrent `POST /bills` for the last unit → exactly one 200 and one 422.

- [ ] **Step 1: Failing tests** (`pos.test.ts`, schema `"pos"`, seeded): counter `u1` (coffee) sells `{ juice: 2, chips: 2, bisc: 1 }` → 200, `result.no === "CF/1188"`, `tot 110`, `changed ["stock","bills"]`, message text; balances at coffee reduced (`GET /stock`); MTO sale at `rest` by a counter at rest (there is none — use `u6`? Deepa is kiosk; kiosk lists `puff` (FG) not capp. Make the MTO case: temporarily insert stock for coffee milk via `postMoves` in the test and sell `capp` at coffee → recipe moves); payer required for `Patient bill` → 422 exact message; unlisted item → 422; unavailable (coffee milk 0 → capp) → 422 naming Milk; wrong location (`u1` billing `kiosk`) → 403; manager → 404; missing `Idempotency-Key` → 400; replay same key → identical body + `idempotency-replayed`; concurrent last-unit race → one 200, one 422; balances after all tests equal `rebuildBalances` output; `bills` rows and `bill_lines` counts; history not written (bills have none).
- [ ] **Step 2: Implement** repo (insert bill + lines; read loc balances/reservations/overrides; is-listed), service (rules above), routes (`mount(app, routes.pay, (req) => svc.pay(req.user, req.body))` with `requireLoc` inside the service via a passed `req`? — keep `requireLoc(req, …)` in the route handler (it needs the request), then call the service with `claims` and `body`).
- [ ] **Step 3:** `pnpm turbo typecheck test && pnpm lint` green; commit "Sell from the server through the ledger".

---

### Task 5: `availability` module — `POST /availability/toggle`

**Files:** `apps/api/src/modules/availability/{routes,service,repo,availability.test}.ts`; register in `modules/index.ts`.

- Rules: counter → `requireLoc(req, body.loc)`; manager → any outlet; item must be listed at loc (`assertRule(listed, \`${item.n} is not listed at ${loc.n}\`)`); if an override exists → delete it (`off: false`), else insert `{ loc, itemKey, reason: "switched off manually", byUser }` (`off: true`); message `\`${item.n} ${off ? "switched off" : "switched on"} at ${loc.n}\``; `changed: ["ovr"]`.
- Tests (schema `"availability"`): toggle on/off round trip; counter at coffee toggling kiosk → 403; manager toggling kiosk → 200; store role → 404; unlisted → 422; `GET /stock` shows the override key.
- Commit "Let a counter switch its own products off and on from the server".

---

### Task 6: `catalog` module — prices and menus

**Files:** `apps/api/src/modules/catalog/{routes,service,repo,catalog.test}.ts`; register.

- `PUT /prices/:list/:it` (manager): item exists; `assertRule(!(mrp != null && price > mrp), \`Refused — printed MRP of ₹${mrp} is a hard ceiling for ${item.n}\`)`; upsert `price_list_items`; message `\`${item.n} priced at ₹${price} on list ${list}\``; `changed: ["prices"]`.
- `POST /menus/:loc/items` (manager): loc is an Outlet; item exists; `assertRule(!listed, \`${item.n} is already listed at ${loc.n}\`)`; insert with `seq = max+1`; result `{ loc, items }`; message `\`${item.n} listed at ${loc.n}\``; `changed: ["menu"]`.
- `DELETE /menus/:loc/items/:it` (manager): `assertRule(listed, \`${item.n} is not listed at ${loc.n}\`)`; delete; message `\`${item.n} removed from ${loc.n}\``.
- Tests (schema `"catalog"`): MRP refusal exact text; price saved and visible in `GET /prices`; add/remove menu round trip with ordering preserved; add twice → 422; remove unlisted → 422; counter → 404 on all three; store loc as `:loc` → 422 "is not an outlet".
- Commit "Maintain prices and menus from the server".

---

### Task 7: UI cutover — billing, availability, prices and menus call the server

**Files:**
- Create: `UI/src/api/refetch.ts`, `UI/src/__tests__/writes.test.ts`
- Modify: `UI/src/store/index.ts` (`pay`, `toggleAvail`, `savePrice`, `addProduct`, `removeProduct`; add `refetch(changed)`), `UI/src/api/wire.ts` (export `applyStock(StockResponse)`, `applyBills(Bill[])`), `UI/src/__tests__/store.test.ts` and `fixes.test.ts` (rewrite the billing/availability/price/menu cases), screens that call these actions only if a signature changes (they should not — the actions keep their parameters; they become `async` and callers may ignore the promise).

**Interfaces:**
- `refetch(changed: string[]): Promise<void>` — `"stock"|"rsv"|"ovr"` → `GET /stock` → `applyStock`; `"bills"` → `GET /bills` → `applyBills`; anything else (`"prices"`, `"menu"`, …) → `loadSnapshot()` (full refresh; Phase 3 adds finer GETs as SSE arrives).
- Store actions (same parameters as today):
  ```ts
  pay: async (loc, tender, payer) => {
    const cart = get().cart[loc] ?? {}; const lines = Object.entries(cart).map(([it, qty]) => ({ it, qty }));
    if (!lines.length || !get().user) return;
    try {
      const r = await call(routes.pay, { body: { loc, tender, payer, lines } });
      set((s) => ({ cart: { ...s.cart, [loc]: {} } }));
      get().notify(r.message); await refetch(r.changed);
    } catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not take the bill — check the connection and try again."); }
  },
  toggleAvail / savePrice / addProduct / removeProduct: same pattern (call → notify(r.message) → refetch(r.changed)); no local rule logic remains in these five actions.
  ```
- The store's optimistic client-side checks are gone; the server's sentence is the toast. Keep `clearCart`, `addToCart` local.
- Tests: `writes.test.ts` stubs `fetch` and asserts each action calls the right route with the right body and refetches the right collections; `store.test.ts`/`fixes.test.ts`: delete the cases that asserted local rule outcomes for these five actions (they are now covered by `pos.test.ts`, `availability.test.ts`, `catalog.test.ts` on the server — list each removed test name in the commit body with the server test that replaces it). Any remaining store test that relied on `pay()` mutating `stock` synchronously must be rewritten to stub the API.
- Manual check with the real stack (`pnpm dev`): sign in as `RC-4471`, sell two juices → toast from the server, stock tile drops, bill appears; toggle chips off/on; sign in as `RC-3120`, price capp on list B to 80 → saved; try juice at 25 → server refusal toast; add/remove a menu item.
- Commit "Cut the counter and the manager's price and menu screens over to the server".

---

### Task 8: A real `helm install` in CI (kind)

**Files:**
- Create: `deploy/chart/rch/ci/values-ci.yaml`, `deploy/chart/rch/ci/postgres.yaml`, `deploy/chart/rch/ci/install-test.sh`
- Modify: `.github/workflows/ci.yml` (new job `chart-install`, needs `images`), `deploy/RUNBOOK.md` (one paragraph), `docs/superpowers/specs/2026-09-03-backend-design.md` §16 row update ("Phase 2 adds kind install" → done)

- `postgres.yaml`: a single-replica `postgres:17` Deployment + Service `postgres:5432` with `POSTGRES_USER/PASSWORD/DB = rch` (emptyDir; CI only).
- `values-ci.yaml`: `image.registry: ""`, `image.tag: ci`, `api.replicas: 1`, `api.hpa.enabled: false`, `ui.replicas: 1`, `ingress.enabled: false`, `secrets.create: true`, `secrets.values.DATABASE_URL: postgres://rch:rch@postgres:5432/rch`, `secrets.values.JWT_*` from `keys:generate` output produced in the job, `api.env.DATABASE_SSL: "false"`, `api.env.COOKIE_SECURE: "false"`, `serviceMonitor.enabled: false`.
- `install-test.sh`: `kind create cluster --name rch`, `kind load docker-image rch-api:ci rch-ui:ci`, `kubectl apply -f deploy/chart/rch/ci/postgres.yaml && kubectl rollout status deploy/postgres`, `helm install rch deploy/chart/rch -f deploy/chart/rch/ci/values-ci.yaml --set secrets.values.JWT_PRIVATE_KEY=… --wait --timeout 5m`, `kubectl port-forward svc/rch-api 3000:3000 &`, `curl -fsS localhost:3000/readyz`, login as `RC-3120` (seed the DB first with a one-off `kubectl run seed --image rch-api:ci --restart=Never --env … -- dist/cli/seed.mjs` or exec into the api pod: `kubectl exec deploy/rch-api -- /nodejs/bin/node dist/cli/seed.mjs`), then `helm upgrade` with the same values (proves the upgrade path keeps the Secret and the init-container migration is a no-op), `curl readyz` again; `kubectl get pods` on failure for the log. Also assert the UI pod is Ready and `curl` through `kubectl port-forward svc/rch-ui 8080:8080` returns 200 at `/healthz`.
- CI job: `runs-on: ubuntu-latest`, `needs: images`; `helm/kind-action@v1` to create the cluster; rebuild the two images with `docker/build-push-action` `load: true` (the `images` job's images do not persist across jobs) or move the install into the `images` job as a final step — prefer the latter (one job builds, scans, installs). Timeout 15 min.
- Commit "Install the chart into a throwaway cluster in CI".

---

### Task 9: Phase 2 hygiene (ledger triage items marked "Phase 2")

One dispatch, one commit — each item is a small independent edit:
1. `packages/domain/src/ids.test.ts`: assert `SEQUENCE_START.support === 44`, `product_req === 13`, `contract === 109`, `shop_ask === 63`.
2. `deploy/nginx/default.conf.template`: `resolver ${NGINX_LOCAL_RESOLVERS} valid=10s;`.
3. `deploy/chart/rch/tests/render.test.sh`: assert the api Deployment container env and the initContainer env render identical `secretKeyRef` blocks (drift check).
4. `apps/api/src/lib/ledger.test.ts`: add an overlapping-set concurrency test — 20 writers each moving `(store,milk)+(store,sugar)` in alternating orders → no deadlock error, balances equal the sum.
5. `apps/api/src/lib/{time,rules,history}.test.ts`: small unit tests (`todayAt` IST, `assertRule` throws `RuleError` with the message, `appendHistory`/`readHistory` round trip).
6. `apps/api/src/db/seed.ts`: GRN `poLineNo` — throw a clear error when the item is not on the PO instead of falling back to 0.
7. `apps/api/src/lib/users-admin.test.ts`: unknown-employee path for reset/deactivate; `cli/users.ts`: validate `--role` against the five roles with a friendly message.
8. `packages/contract/src/schemas/snapshot.ts`: `menu: z.partialRecord(LocKeySchema, z.array(z.string()))`.
9. `apps/api/src/modules/auth/service.ts`: `changePassword` refuses an inactive user (401) and `next === current` (422 "Choose a different password").
10. `UI/src/lib/fmt.ts`: `fromWireBestBefore` computes day boundaries in Asia/Kolkata (use `Intl.DateTimeFormat` parts like `fromWireDate`).
11. `apps/api/src/modules/snapshot/readers/documents.ts`: one `userNames(db)` per snapshot — accept an optional pre-fetched map parameter in every reader (`names?: Map<…>`), and have `service.ts` fetch it once and pass it (signatures gain an optional trailing param; Task 3's `GET /bills` passes none).
12. `apps/api/Dockerfile` and `UI/Dockerfile`: `FROM --platform=$BUILDPLATFORM` on build stages only where it helps cross-builds; CI builds set `platforms: linux/amd64` explicitly in `ci.yml`/`deploy.yml`.
13. `apps/api/src/modules/auth/service.ts`: refresh families expire absolutely — a row's `expires_at` never exceeds the family's first `created_at + 30 d` (carry `family_started_at` by selecting the min `created_at` of the family when issuing).
- Tests for each behavioural change; `pnpm turbo typecheck test && pnpm lint` green; commit "Close the Phase 2 hygiene list from the Phase 1 ledger".

---

### Task 10: Docs, runbook, spec §16, exit check

- `CLAUDE.md`: Backend status → "Phases 1–2 implemented; phases 3–6 pending — see spec §14"; the *Architecture → One Zustand store* section: billing/availability/prices/menus actions now call the API; *Domain invariants*: point at `packages/domain` for MRP/selling rules.
- `README.md` Status: counter billing and manager prices/menus are on the server.
- `deploy/RUNBOOK.md`: §8 add `select * from stock_moves where ref_type='bill' and ref_id='CF/1188'`; §7 note the append-only trigger (a correction is a reversing move); kind install paragraph (Task 8).
- Spec §16: add rows for anything Phase 2 changed (e.g. `users(min)` shape, `GET /stock`/`GET /bills`, post-lock stock check on sale).
- **Exit check (spec §14 row 2):** `pnpm turbo typecheck test && pnpm lint`; `pnpm helm:test`; docker builds; `db:migrate` (3/3) + `db:seed --force`; API up: login RC-4471 → `POST /bills` two juices → 200 `CF/1188`; `GET /stock` shows coffee juice 6; `POST /bills` with `Patient bill` and no payer → 422 exact sentence; `PUT /prices/A/juice 25` as RC-3120 → 422 MRP sentence; `db:rebuild-balances` → then `GET /stock` unchanged; `kind` install script runs locally if Docker has resources (optional locally; required in CI).
- Commit "Document Phase 2 and record its exit check".

---

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | **1** (domain) ∥ **2** (contract) | disjoint packages; both in-tree? No — parallel ⇒ worktrees |
| 2 | **3** (hardening + GET stock/bills) | in-tree; depends on 1 (Master type) and 2 (route entries) |
| 3 | **4** (pos) ∥ **5** (availability) ∥ **6** (catalog) ∥ **8** (kind CI) ∥ **9** (hygiene) | worktrees; 4/5/6 each own a module dir + one line in `modules/index.ts` — to avoid that shared line, Task 3 pre-registers the three module stubs (`pos`, `availability`, `catalog`) in `modules/index.ts` with empty plugins, exactly as Phase 1 did. Task 9 touches many small files — none owned by 4/5/6/8. Task 8 touches ci.yml/chart/ci, RUNBOOK (one paragraph — Task 10 owns RUNBOOK later; fine sequentially). |
| 4 | **7** (UI cutover) | in-tree; needs 4/5/6 merged |
| 5 | **10** (docs + exit check) | in-tree |

Worktree agents do not commit to the shared branch; the controller merges each reviewed branch. Parallel tasks never edit the same file; where a shared file is unavoidable it is pre-edited in the preceding wave.
