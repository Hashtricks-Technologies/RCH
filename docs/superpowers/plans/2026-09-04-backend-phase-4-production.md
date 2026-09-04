# RCH Backend — Phase 4: Production — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Central Kitchen moves to the server — the board walks New → Accepted → In kitchen → Ready through one transition table, and a batch draws its recipe out of the kitchen's raw materials and books the finished units onto the rack in a single transaction, with a best-before stamped from the item's shelf life; nothing in `UI/src/store/index.ts` touches kitchen stock any more. And the movement chain gains the door it has been missing since Phase 3: a ticket that was issued and never collected can be cancelled, which puts its reservation back.

**Architecture:** Three write endpoints land. Two are spec §9.2's remaining Phase 4 rows and extend the module Phase 3 already built — `apps/api/src/modules/production/` gains `POST /prod-orders/:id/status` and `POST /batches` beside `dispatch` and `distribute`, composing the same platform: `withTransaction` → rules from `@rch/domain` through `assertRule` → `allocateNumber`/`lockBalances`/`postMoves` → `appendHistory` → `emitChanged` → `{ result, changed, message }`. **A make is the one write in this system that creates stock**, so it is also the one that must not be able to create it out of nothing: ingredients go against what was *started* and only the yielded units reach the rack, in the same `postMoves` call, under balance locks taken over the ingredients *and* the finished item before anything is read. The third is `POST /tickets/:id/cancel`: Phase 3 built `releaseForTicket` but gave only `handover` a way to call it, so an issued ticket that is never collected strands its reservation for good and the request behind it is frozen at `Ticket issued` — this phase adds `Cancelled` to `TktStatus`, `voidTicket` to `lib/tickets.ts`, and one endpoint that releases the hold and puts the document behind the ticket back where it was. Two reads (`GET /prod-orders`, `GET /batches`) join the snapshot module so a write naming `"pord"` or `"batch"` refetches that slice instead of the whole snapshot. `PROD_ORDER_TRANSITIONS` already exists (Phase 3, Task 12); this phase makes the status endpoint and the board's buttons read it from both ends.

**Tech Stack:** unchanged from Phases 1–3 — Node 24, pnpm 10, Turborepo 2, TypeScript ~6.0, Fastify 5, fastify-type-provider-zod 7, Zod 4, Drizzle 0.45 + drizzle-kit 0.31, pg 8, PostgreSQL 17, Vitest 4, tsup 8, Helm 3. **No new dependency.** One migration, and only one: `ticket_status` gains a `Cancelled` value. `prod_orders`, `prod_order_lines` and `batches` were created by Phase 1's first migration and are unchanged.

**Spec:** `docs/superpowers/specs/2026-09-03-backend-design.md` — §5.1 (reuse rules, incl. "status transitions are data, shared by both sides" and "a business rule is written once, in `packages/domain`"), §7.2 (`prod_orders`, `prod_order_lines`, `batches`, `document_history`), §7.3 (`PRD-<yyyy>-0<n>`, `BAT-<yyyymmdd>-<nn>`), §8.3 (roles: `prod` owns prod-orders, batches, distribute, kitchen stock), §9.1 (`/prod-orders`, `/batches` are named per-collection reads), §9.2 (the `setOrderStatus` and `makeProduct` rows), §9.3 (write responses), §10 (frontend cutover), §12 (the production-readiness bar), §13 (testing), §14 row 4 — *"Make consumes ingredients and yields in one transaction; dispatch all-or-nothing; kitchen stock correct"* — and §16 (amendments from Phases 1–3 — **binding, do not reopen**).
**Ledgers:** `docs/superpowers/plans/2026-09-04-backend-phase-2-ledger-pos-ledger.md`, `.superpowers/sdd/2026-09-04-backend-phase-3-movement-chain/progress.md` and its `task-10-notes.md`.

---

## Global Constraints

Every task's requirements implicitly include this section. The first eleven bullets are Phase 3's, carried forward unchanged because they are what keeps the server correct; the rest are this phase's own.

- **Branch model:** work on `feat/phase-4-production`, branched from `develop` once Phase 3 has landed there by fast-forward (if it has not, branch from `feat/phase-3-movement-chain`); never push to `staging`/`production`. Worktree agents start with `git merge --ff-only feat/phase-4-production`.
- **Conventions settled in Phases 1–3 (binding):** `apps/api` and `packages/*` relative imports carry `.js`; no constructor parameter properties (`erasableSyntaxOnly`); `strict` TS with `noUnusedLocals`/`noUnusedParameters`/`verbatimModuleSyntax`; type-only imports use `import type`. UI uses bundler resolution (no extensions). Every DB-backed test file calls `buildTestApp({ schema: "<unique>" })`; `withTestSchema` suffixes the schema with the pid, so parallel worktrees sharing one database do not drop each other's schema. Local Postgres is Docker on host port **5439**; Node 24 lives at `$(brew --prefix node@24)/bin`.
- **Every write is one transaction** (`withTransaction`), rules through `assertRule` carrying the operator-facing sentence, quantities through `round3`, ledger moves only through `postMoves`, balance locks only through `lockBalances`, ids only through `allocateId`/`allocateNumber`, history only through `appendHistory`, reservations only through `apps/api/src/lib/reservations.ts`. `scripts/check-boundaries.sh` enforces the protected tables — do not write them anywhere else. (`batches` is **not** a protected table: it is the production module's own document, written from `modules/production/repo.ts` like `prod_orders`.)
- **Routes only through `mount(app, routes.<name>, handler)`**; every module is `routes.ts / service.ts / repo.ts / <name>.test.ts` (copy `apps/api/src/modules/_template/`). `GET /events` remains the one route outside the manifest; this phase adds none like it.
- **Write response shape (spec §9.3):** `{ result, changed, message }` — `changed` names snapshot collections to refetch (this phase uses `"pord"`, `"batch"`, `"stock"`, `"tkt"`, `"rsv"`, `"req"`); `message` is the toast sentence, moved **verbatim** from the store's current `notify()` text. Where a new sentence is unavoidable it is called out in the task and recorded in spec §16 by Task 7.
- **Refusals** are `RuleError` (422) with the sentence the store uses today; an unknown item or document key is `NotFoundError` (404) reading `There is no item <key>.` / `There is no production order <id>.` / `There is no ticket <id>.`; role gating is 404 (the module is absent for that role); location scoping is 403 through `requireLoc`/`requireLocOf`.
- **Quantities on the wire** are `QtySchema` = `z.number().finite().multipleOf(0.001).max(100000)` and positivity is a **service rule**, not a schema rule, so a zero reaches the operator as the store's own sentence (`"Enter a quantity to make"`) instead of a generic 400. Times are ISO; quantities `numeric(12,3)` rounded with `round3`.
- **Lock order, server-wide: documents → ids → balances.** A write that needs more than one takes them in that sequence and never another: `repo.head(tx, id)` (`for update` on the document row) → `allocateId`/`allocateNumber` (which locks a `sequences` row) → `lockBalances`/`postMoves` (which lock `stock_balances` rows). `apps/api/src/lib/ledger.ts`'s header records it and `modules/{pos,requests,tickets,shopasks,production}` all keep it. A refused write rolls its allocation back with everything else.
- **Every reservation-creating path — and every path that reads a balance in order to promise against it — takes the balance locks first.** `lockBalances(tx, cells)` before reading `on_hand` and open reservations. Without the lock two concurrent writers read the same balance and both spend it.
- **Every status transition reads its own row `for update`.** `productionRepo.head(tx, id)` is already a locking read; a transition guard that reads without the lock is not a guard. Two Accepts of one order both see `New`, both pass `canTransition`, and both write a history row.
- **A test that races two transactions warms the pool first.** `pg` opens connections lazily, so the second of two "concurrent" `withTransaction` calls waits ~5 ms for a socket and begins after the first has committed — the race never happens and the test passes with the lock removed. Call `warmPool(t, n)` (`apps/api/src/test/db.ts`) before racing `n` transactions, and prove each such test fails with the lock or the sort commented out before keeping it.
- **Test builders are the only place default field values are written** (spec §5.1). `given.request`, `given.ticket`, `given.shopAsk`, `given.bill` and `given.prodOrder` already exist in `apps/api/src/test/builders.ts`; a suite that hand-builds a document instead of asking for one is rejected in review. This phase adds no builder — a batch is created by the endpoint under test, never around it.
- **Assertions are relative to what the fixtures hold, not to a number typed into the test.** Read the balance, act, then assert the difference (`expect(after).toBeCloseTo(before - 0.035 * 60, 3)`), and pick the order to act on by filtering the board rather than naming `PRD-2026-029`. The seed moves; a test that hard-codes its arithmetic breaks for a reason that has nothing to do with the code.
- **`emitChanged` is called inside the transaction**, last in the service, with the same array the response's `changed` carries. Postgres withholds a `pg_notify` until the transaction commits, so a refusal announces nothing. There is no after-commit hook — do not go looking for one (spec §16, Phase 3).
- **A make locks every cell it touches in one call.** `lockBalances(tx, [...ingredient cells, the finished-item cell])` **before** reading on-hand and reservations, so the `postMoves` that follows re-takes only locks this transaction already holds and can never need a new one out of (loc, item) order. Locking the ingredients alone would leave `postMoves` reaching for the finished item's row while holding four others — the shape a deadlock is made of.
- **Never widen a status union with `string`.** `PordStatus` and `TktStatus` are closed; let the compiler find the call sites. `TktStatus` gains one member this phase, and it gains it in the same commit as the `ticket_status` pg enum — the two are one change, because `ticketsRepo.setStatus` types its patch against the contract union and writes it into the enum column.
- **Migrations are generated, never hand-numbered.** Run `pnpm --filter @rch/api db:generate`, review the SQL it emits, and commit it with `drizzle/meta/_journal.json`. **The Phase 3 fix wave is landing `0004_payers`** — `payers(kind, id, name, active)` seeded from the fixtures, which `pos` validates a bill's payer against — so this phase's enum migration will be `0005` or later. Do not assume a number, and **do not touch `payers`**: it is Phase 3's, it is the roster, and a Phase 4 read of `bills` by payer joins it rather than building a second one.
- **Every phase ends with its guides refreshed, in one commit with the spec §16 rows.** That is the root `CLAUDE.md`, the root `README.md`'s status-by-phase section, and the four nested guides — `apps/api/CLAUDE.md`, `packages/contract/CLAUDE.md`, `packages/domain/CLAUDE.md`, `UI/CLAUDE.md` (all four created on the Phase 3 branch). A nested guide is what a fresh agent reads before touching that package, so it names what the package now holds and what rule it now enforces; a phase that adds an endpoint, a table, a domain function or a screen and leaves its guide describing the phase before is a defect, not a follow-up. **This carries into Phases 5 and 6.**
- **Every task ends green:** `pnpm turbo typecheck test && pnpm lint` (turbo lint + knip + `scripts/check-boundaries.sh`) at the repo root. Never leave a test asserting behaviour that moved — each task that deletes a UI rule test names the server test that replaces it, in the commit body. If turbo replays a stale green for you, re-run the gate with `--force`.
- **`scripts/check-boundaries.sh` greps for call shape**, including `update reservations` case-insensitively in raw SQL. Do not write a comment or a string containing a phrase like `insert into stock_moves` outside `lib/`, or the boundary script fails on prose.
- **Commit messages:** imperative, sentence-case, no prefixes, and no mention of a task number, plus the trailers
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
  ```

---

## What Phase 4 does **not** build

- **`POST /prod-orders`.** Nothing in the frontend raises a production order today: `UI/src/store/index.ts` has no action that appends to `pord`, `seq.pord` is initialised to 30 and never incremented, and the two orders on the kitchen's board come from `packages/contract/src/fixtures/seed.ts` (`seedPord`, raised by the Snack Kiosk). Spec §9.2 has no row for it either. Nothing to cut over, so nothing is built — inventing a screen and an endpoint together is a product change, not a cutover. Task 7 records it in spec §16 as a parked product question (who raises one: the outlet's counter, or the outlet manager?), one manifest entry and one service function away when the answer exists.
- **Any table change beyond one enum value.** `prod_orders`, `prod_order_lines` and `batches` are Phase 1 tables and no column moves. `batches` carries no cost column, so nothing stamps `costOf`/`recipeCost` onto a batch; the kitchen's value figures stay derived at read time (`UI/src/roles/prod/Dashboard.tsx`). A cancellation's reason has no column either and lives in `document_history`.
- **Cancelling a shop transfer's or a shop ask's ticket.** Both leave from an outlet, and `POST /tickets/:id/cancel` is `["store", "prod"]` scoped by `requireLocOf` on the ticket's `from` — so neither is reachable, by construction rather than by omission. A counter who granted a transfer and wants it back has no door until Phase 6 gives them one; Task 7 records it.
- **Anything in `store/procurement.ts`, `sendRequisition`, or the rest of `store/ops.ts`** (support tickets, rate contracts, new-product requests, catalogue additions). They cross no seam this phase opens. Phases 5 and 6 own them.

---

## File structure (what Phase 4 adds or changes)

```
packages/contract/src/
  schemas/documents.ts    TktStatusSchema gains "Cancelled"
  schemas/writes.ts       + SetOrderStatusBodySchema, MakeBatchBodySchema, CancelTicketBodySchema
  schemas/snapshot.ts     + ProdOrdersResponseSchema, BatchesResponseSchema
  routes.ts               + setOrderStatus, makeBatch, cancelTicket (Task 1) ; + prodOrders, batches GETs (Task 3)
  routes.test.ts          + the three write samples
packages/domain/src/
  transitions.ts          TICKET_TRANSITIONS gains Cancelled; REQUEST_TRANSITIONS and
                          PROD_ORDER_TRANSITIONS gain the way back a cancellation needs
  shelf.ts                DEFAULT_SHELF_LIFE_HOURS, bestBeforeAt, bestBeforeText   (new)
  shelf.test.ts           the H9 wording and the eight-hour default                (new)
  approval.ts             + approvedStatus(lines), which planApproval now uses
  index.ts                + the shelf and approval exports
apps/api/src/
  db/schema/enums.ts      ticketStatusEnum gains "Cancelled"  (+ the generated migration)
  lib/tickets.ts          + voidTicket(tx, id, reason, by, at?)
  modules/production/repo.ts      + overrideAt, insertBatch
  modules/production/service.ts   + setStatus, makeBatch
  modules/production/routes.ts    + two mounts
  modules/production/production.test.ts  + the two endpoints' cases
  modules/tickets/repo.ts         + requestLines, releaseRequest, linkedProdOrder, setProdOrderStatus
  modules/tickets/service.ts      + cancel
  modules/tickets/routes.ts       + one mount
  modules/tickets/tickets.test.ts + the cancellation's cases
  modules/snapshot/scope.ts       + scopeProdOrders, scopeBatches (and `scope()` reads them)
  modules/snapshot/service.ts     + prodOrders(), batches()
  modules/snapshot/routes.ts      + two mounts
  modules/snapshot/snapshot.test.ts  + the two reads, scoped
UI/src/
  lib/fmt.ts              `bestBefore` and `hhmm`/`kolkataYmd` deleted; `fromWireBestBefore` delegates to @rch/domain
  lib/selectors.ts        + canMoveOrder(st, to), canCancelTicket(st)
  api/refetch.ts          "pord" -> GET /prod-orders, "batch" -> GET /batches
  api/wire.ts             + applyProdOrders, applyBatches
  store/index.ts          setOrderStatus, makeProduct and cancelTicket become API calls; Seq loses req/pord/bat
  roles/prod/MakeDistribute.tsx  the Make tile awaits the server behind a per-product busy lock
  roles/prod/Orders.tsx          the board's buttons read the transition table
  roles/prod/OrderDrawer.tsx     the drawer's buttons read the transition table
  roles/prod/Tickets.tsx         a Cancel control on a ticket still at the pass
  roles/store/TicketDrawer.tsx   Cancel, beside the supervisor override it already has
  roles/counter/Tickets.tsx      "Cancelled" in the status filter
  roles/counter/TicketDrawer.tsx a cancelled ticket says so instead of showing a stalled stepper
  __tests__/fixture.ts    the trimmed Seq
  __tests__/writes.test.ts  + the three new wire cases
  __tests__/store.test.ts   the in-memory production case goes
  __tests__/fixes.test.ts   C1 and UA-14 move to the server; H9 re-points at the shared wording
```

---

### Task 1: Contract, transitions and the `ticket_status` enum

*(Wave 1, alongside Task 2. It owns `packages/contract/**`, `packages/domain/src/{transitions.ts,transitions.test.ts}`, `apps/api/src/db/schema/enums.ts` and the migration it generates. Task 2 owns `packages/domain/src/{shelf.ts,shelf.test.ts,index.ts}` and two UI files, and touches none of these.)*

**Why the enum is in this task and not the tickets one.** `TktStatus` is `z.infer<typeof TktStatusSchema>`, and `apps/api/src/modules/tickets/repo.ts` types its update patch as `{ status: TktStatus }` before writing it into the `ticket_status` pg enum column. Add `"Cancelled"` to the contract without adding it to the enum and `apps/api` stops typechecking; add it to the enum without the contract and `TICKET_TRANSITIONS`'s `Record<TktStatus, …>` has a key too many. The three edits are one change and land in one commit.

**Files:**
- Modify: `packages/contract/src/schemas/documents.ts`, `packages/contract/src/schemas/writes.ts`, `packages/contract/src/routes.ts`, `packages/contract/src/routes.test.ts`, `packages/domain/src/transitions.ts`, `packages/domain/src/transitions.test.ts`, `apps/api/src/db/schema/enums.ts`
- Create: the migration `pnpm --filter @rch/api db:generate` emits (plus its `drizzle/meta/` entries) — **whatever number drizzle-kit assigns**; the Phase 3 fix wave is landing `0004_payers`, so expect `0005`.

**Scope note — writes only.** `apps/api/src/contract.test.ts` probes **every** param-less GET in the manifest and asserts a 200 (Phase 2 removed its skip-on-404 branch on purpose), so a GET declared before its handler exists turns the API suite red. The two reads this phase adds — `GET /prod-orders` and `GET /batches` — are therefore declared in **Task 3**, in the same commit as the handlers that answer them. Write routes are inert until a module mounts them, so all three land here.

**Interfaces:**
- Consumes: `QtySchema`, `DocIdParamsSchema`, `writeResponse` (already in `schemas/writes.ts`); `PordStatusSchema`, `ProdOrderSchema`, `BatchSchema`, `TicketSchema` (already in `schemas/documents.ts`).
- Produces (imported by Tasks 3–6):
  ```ts
  // packages/contract/src/schemas/documents.ts
  export const TktStatusSchema = z.enum(["Issued", "Collected", "Received", "Cancelled"]);

  // packages/contract/src/schemas/writes.ts
  export const SetOrderStatusBodySchema = z.strictObject({ st: PordStatusSchema });
  export const MakeBatchBodySchema = z.strictObject({
    it: z.string().min(1).max(64),
    started: QtySchema,
    made: QtySchema.optional(),
    note: z.string().max(500).optional(),
  });
  export const CancelTicketBodySchema = z.strictObject({ reason: z.string().max(500) });

  // packages/domain/src/transitions.ts — three tables gain the way back a cancellation needs
  TICKET_TRANSITIONS.Issued        = ["Collected", "Cancelled"];
  TICKET_TRANSITIONS.Cancelled     = [];
  REQUEST_TRANSITIONS["Ticket issued"] = ["Collected", "Manager approved", "Partially approved"];
  PROD_ORDER_TRANSITIONS.Dispatched    = ["Ready"];
  ```
- `routes.ts` additions, appended immediately after `distribute` and before the three movement GETs:
  ```ts
  setOrderStatus: defineRoute({ method: "POST", path: "/prod-orders/:id/status", access: ["prod"],           params: DocIdParamsSchema, body: SetOrderStatusBodySchema, response: writeResponse(ProdOrderSchema) }),
  makeBatch:      defineRoute({ method: "POST", path: "/batches",                access: ["prod"],           body: MakeBatchBodySchema,                                 response: writeResponse(BatchSchema) }),
  // The store cancels the store's tickets and the kitchen the kitchen's; `requireLocOf` on the
  // ticket's `from` is what draws that line, which also puts a shop transfer's own ticket out
  // of reach of both (its `from` is an outlet). Phase 6 gives the counter that door.
  cancelTicket:   defineRoute({ method: "POST", path: "/tickets/:id/cancel",     access: ["store", "prod"],  params: DocIdParamsSchema, body: CancelTicketBodySchema,   response: writeResponse(TicketSchema) }),
  ```
  `ProdOrderSchema`, `BatchSchema` and `TicketSchema` come from `./schemas/documents.js`; `routes.ts` already imports from that module, so add the missing names to the existing import rather than a new line.
- Why `made` and `note` are `.optional()` and not `.default(...)`: the kitchen leaves the yield box blank when every unit came good, and the store already reads that as "all of them" (`yielded == null ? n : yielded`). A default of `0` would silently turn a blank box into a lost tray. `note` is optional because `BatchSchema.note` is, and `readBatches` strips it when the column is null.
- Why `started` is `QtySchema` and not `.positive()`: a zero must reach the kitchen as the store's own `"Enter a quantity to make"`, not as a generic 400 (spec §16, Phase 3). Likewise `made` admits a negative on the wire and is refused in the service with the store's own sentence. `reason` is `z.string().max(500)` for the same reason — an empty one is refused in the service with a sentence.

**The three transition-table edits, and why each is exactly this shape:**

| Table | Change | Why |
|---|---|---|
| `TICKET_TRANSITIONS` | `Issued: ["Collected", "Cancelled"]`, and a new `Cancelled: []` | Only a ticket that has not been collected may be withdrawn. Once it has been handed over the stock is in transit and the way back is a receipt followed by a movement of its own, not an undo. |
| `REQUEST_TRANSITIONS` | `"Ticket issued": ["Collected", "Manager approved", "Partially approved"]` | Cancelling the store's pick must not discard the manager's approval — the outlet is still waiting on stock somebody decided it could have. The request goes back to whichever approved status its lines amount to and can be issued a fresh ticket. `isReqOpen` and `canIssueTicket` are unaffected: neither asks about a transition *out of* `Ticket issued` to `Cancelled`. |
| `PROD_ORDER_TRANSITIONS` | `Dispatched: ["Ready"]` | The same principle for the kitchen: cancelling a dispatch ticket leaves the order undelivered, and saying it is still `Dispatched` is a lie. **This is the only way back** — `POST /prod-orders/:id/status` refuses `Dispatched` as a source (Task 4) and `canMoveOrder` refuses it as well (Task 6), so no board button offers it and no stale tab can reach it. |

- [ ] **Step 1: Write the failing contract test**

`packages/contract/src/routes.test.ts` already fails the "every route that takes a body has a sample here" case the moment a new body route appears. **Add these three entries to the existing `SAMPLES` object and leave every entry already there exactly as you find it** (that file is maintained alongside the Phase 2 and 3 routes and its values may have moved since this plan was written):

```ts
  setOrderStatus: { st: "Accepted" },
  makeBatch: { it: "SKU-1", started: 60, made: 58, note: "Oven tray dropped" },
  cancelTicket: { reason: "The counter closed before the collector came" },
```

And add a case at the bottom of the file, so the shapes the screens actually send are pinned rather than only the fat one:

```ts
describe("the kitchen's writes and a ticket taken back", () => {
  it("takes a make with no yield and no reason — the blank boxes mean 'all of them, nothing to explain'", () => {
    expect(MakeBatchBodySchema.safeParse({ it: "puff", started: 10 }).success).toBe(true);
  });
  it("refuses a status the board does not have", () => {
    expect(SetOrderStatusBodySchema.safeParse({ st: "Baked" }).success).toBe(false);
  });
  it("knows a ticket can end without ever being collected", () => {
    expect(TktStatusSchema.safeParse("Cancelled").success).toBe(true);
  });
});
```
with `import { MakeBatchBodySchema, SetOrderStatusBodySchema, TktStatusSchema } from "./index";` added to the file's imports.

- [ ] **Step 2: Write the failing domain test**

Append to `packages/domain/src/transitions.test.ts`:
```ts
describe("a ticket that was never collected", () => {
  it("may be taken back while it is still at the window", () => {
    expect(canTransition(TICKET_TRANSITIONS, "Issued", "Cancelled")).toBe(true);
  });
  it("may not be taken back once the stock is in transit or on the shelf", () => {
    expect(canTransition(TICKET_TRANSITIONS, "Collected", "Cancelled")).toBe(false);
    expect(canTransition(TICKET_TRANSITIONS, "Received", "Cancelled")).toBe(false);
  });
  it("is finished once it is cancelled", () => {
    expect(TICKET_TRANSITIONS.Cancelled).toEqual([]);
  });
  it("puts the request behind it back where the manager left it", () => {
    expect(canTransition(REQUEST_TRANSITIONS, "Ticket issued", "Manager approved")).toBe(true);
    expect(canTransition(REQUEST_TRANSITIONS, "Ticket issued", "Partially approved")).toBe(true);
    // And the way forward is untouched.
    expect(canTransition(REQUEST_TRANSITIONS, "Ticket issued", "Collected")).toBe(true);
    expect(canTransition(REQUEST_TRANSITIONS, "Manager approved", "Ticket issued")).toBe(true);
  });
  it("puts the production order behind it back on the board, and nowhere else", () => {
    expect(canTransition(PROD_ORDER_TRANSITIONS, "Dispatched", "Ready")).toBe(true);
    expect(canTransition(PROD_ORDER_TRANSITIONS, "Dispatched", "Accepted")).toBe(false);
    expect(canTransition(PROD_ORDER_TRANSITIONS, "Dispatched", "Dispatched")).toBe(false);
  });
});
```
(`REQUEST_TRANSITIONS`, `TICKET_TRANSITIONS` and `PROD_ORDER_TRANSITIONS` are already imported by that file.)

- [ ] **Step 3: Run both to see them fail**

Run: `pnpm --filter @rch/contract test && pnpm --filter @rch/domain test`
Expected: FAIL — `MakeBatchBodySchema` is not exported, the samples case reports the three route names as missing, and `TICKET_TRANSITIONS` has no `Cancelled`.

- [ ] **Step 4: Write the schemas, the tables, the enum and the manifest entries**

In `packages/contract/src/schemas/documents.ts`, extend one enum:
```ts
// A ticket that was issued and never collected is withdrawn rather than left open: the hold it
// placed has to be released, and "Cancelled" is what the release is recorded as.
export const TktStatusSchema = z.enum(["Issued", "Collected", "Received", "Cancelled"]);
```

In `packages/contract/src/schemas/writes.ts`, after `DispatchResultSchema`, add:
```ts
// The board's own two words: a status the kitchen presses, and a batch it logs. `Dispatched` is
// a member of PordStatusSchema and is accepted by the schema on purpose — it is refused in the
// service with a sentence that says where to go instead, because a stale tab pressing it needs
// an answer it can read, not a 400 (spec §9.2: "Dispatched via its own endpoint").
export const SetOrderStatusBodySchema = z.strictObject({ st: PordStatusSchema });
// `started` is what went into the oven and `made` is what came out of it; the ingredients go
// against the first and only the second reaches the rack (UA-14). A blank yield box means every
// unit came good, so `made` is optional rather than defaulted — a default of 0 would read a
// blank box as a lost tray.
export const MakeBatchBodySchema = z.strictObject({
  it: z.string().min(1).max(64),
  started: QtySchema,
  made: QtySchema.optional(),
  note: z.string().max(500).optional(),
});
/** A cancellation has to say why: the reason is the only record of it, since a ticket's row
 *  carries no prose and it ends up in document_history rather than on the ticket. */
export const CancelTicketBodySchema = z.strictObject({ reason: z.string().max(500) });
```
`PordStatusSchema` comes from `./documents.js` — add it to that file's existing import line in `writes.ts`.

In `packages/contract/src/routes.ts` add the three manifest entries exactly as spelled out in **Interfaces**, importing `CancelTicketBodySchema`, `MakeBatchBodySchema` and `SetOrderStatusBodySchema` from `./schemas/writes.js` and adding `BatchSchema` and `ProdOrderSchema` to the existing `./schemas/documents.js` import (`TicketSchema` is already there).

In `packages/domain/src/transitions.ts` make the three edits from the table above, each with the sentence that explains it:
```ts
export const TICKET_TRANSITIONS: TransitionTable<TktStatus> = {
  // A ticket that was never collected can be withdrawn, which releases the hold it placed.
  // Once it has been handed over the stock is in transit and the way back is a receipt and
  // then a movement of its own — not an undo.
  Issued: ["Collected", "Cancelled"],
  Collected: ["Received"],
  Received: [],
  Cancelled: [],
};
```
and, in `REQUEST_TRANSITIONS`:
```ts
  // Cancelling the store's pick must not discard the manager's decision: the outlet is still
  // waiting on stock somebody said it could have, so the request goes back to whichever
  // approved status its lines amount to (`approvedStatus`) and can be issued a fresh ticket.
  "Ticket issued": ["Collected", "Manager approved", "Partially approved"],
```
and, in `PROD_ORDER_TRANSITIONS`:
```ts
  // The one way back onto the board, and it is not a button: cancelling the ticket a dispatch
  // raised leaves the order undelivered, and calling it Dispatched would be a lie. The status
  // endpoint refuses `Dispatched` as a source and `canMoveOrder` refuses it as a source too,
  // so nothing but a cancellation can take this edge.
  Dispatched: ["Ready"],
```

In `apps/api/src/db/schema/enums.ts`:
```ts
export const ticketStatusEnum = pgEnum("ticket_status", ["Issued", "Collected", "Received", "Cancelled"]);
```

`packages/contract/src/index.ts` re-exports each schema module with `export *`, so nothing there changes.

- [ ] **Step 5: Generate and review the migration**

Run: `pnpm --filter @rch/api db:generate`
It emits a migration whose whole body is one `ALTER TYPE "public"."ticket_status" ADD VALUE 'Cancelled';`. Read it before committing it. Postgres 17 allows `ADD VALUE` inside a transaction as long as the new value is not *used* in the same transaction, and drizzle's runner does exactly that, so no `--no-transaction` marker is needed. Then apply it locally:
```bash
pnpm db:up
pnpm --filter @rch/api db:migrate
```

- [ ] **Step 6: Run the tests**

Run: `pnpm turbo typecheck test && pnpm lint`
Expected: PASS everywhere. Nothing mounts the three new routes yet, and a manifest entry with no handler is inert — `apps/api/src/contract.test.ts` iterates GETs only, and this task adds none. Nothing writes `"Cancelled"` yet either; the value simply exists, in the enum, the schema and the table, ready for Task 5.

- [ ] **Step 7: Commit**

```bash
git add packages/contract packages/domain apps/api/src/db apps/api/drizzle
git commit -m "$(cat <<'EOF'
Declare the kitchen's two writes, and let a ticket be taken back

A status the kitchen presses and a batch it logs. `made` is optional rather than defaulted:
the yield box is left blank when every unit came good, and a default of zero would read that
as a lost tray.

And "Cancelled" — a ticket status, a pg enum value and three transition-table edits in one
commit, because the repo types its update patch against the contract union and writes it into
the enum column, so the three are one change. A cancelled ticket puts the request behind it
back to whichever approved status its lines amount to, and a dispatched order back onto the
board at Ready; that edge exists for the cancellation and for nothing else, which is why both
the status endpoint and the board's own helper refuse Dispatched as a source.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 2: Domain — shelf life, the best-before wording, and the UI's one copy of it

*(Wave 1, alongside Task 1. It owns `packages/domain/src/{shelf.ts,shelf.test.ts,index.ts}`, `UI/src/lib/fmt.ts`, the one `bestBefore` call site in `UI/src/store/index.ts`, and the **H9 block only** of `UI/src/__tests__/fixes.test.ts`. Task 1 owns `packages/contract`, `packages/domain/src/transitions.ts` and `apps/api/src/db/schema/enums.ts` — a different set of files in the same package, and no UI file at all.)*

**Why a domain module for a date sum.** The server has to answer with the *sentence the kitchen reads today* — `"BAT-20260904-01 — 116 Veg puffs made, best before 21:30"` — and "21:30" is not a timestamp, it is H9's three-way wording: a plain time when the batch expires on the day it was made, `"07:30 tomorrow"` when it does not, and `"07:30 31 Aug"` when it is further out than that. The browser has that wording twice already (`bestBefore` for a batch it made itself, `fromWireBestBefore` for one the server sent). Spec §5.1 says a business rule is written once, in `packages/domain`; after this task it is, and both the server's message and the browser's table read the same function.

**Files:**
- Create: `packages/domain/src/shelf.ts`, `packages/domain/src/shelf.test.ts`
- Modify: `packages/domain/src/index.ts`, `UI/src/lib/fmt.ts`, `UI/src/__tests__/fixes.test.ts` (the H9 describe block only)

**Interfaces:**
- Consumes: nothing. `shelf.ts` imports no other domain module — it is arithmetic and `Intl`.
- Produces (used by Task 4's service and Task 5's screens):
  ```ts
  // packages/domain/src/shelf.ts
  export const DEFAULT_SHELF_LIFE_HOURS = 8;
  export function bestBeforeAt(made: Date, hours?: number): Date;
  export function bestBeforeText(due: Date, made?: Date): string;   // `made` defaults to now
  ```
- `packages/domain/src/index.ts` gains one line:
  ```ts
  export { DEFAULT_SHELF_LIFE_HOURS, bestBeforeAt, bestBeforeText } from "./shelf.js";
  ```

**The day boundary is the hospital's, not the host's.** `fromWireBestBefore` already computes its "days apart" from Asia/Kolkata calendar dates, and that is the behaviour to keep: an API pod running in UTC must still call a batch due at 23:30 IST "tonight". The `bestBefore` being deleted computed the difference from host-local dates, which was right only because the browser sits in the hospital. Keep the correct one.

- [ ] **Step 1: Write the failing domain test**

`packages/domain/src/shelf.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_SHELF_LIFE_HOURS, bestBeforeAt, bestBeforeText } from "./shelf.js";

/** Instants are written in IST so the case reads the way the kitchen would say it. */
const ist = (s: string) => new Date(`${s}+05:30`);

describe("bestBeforeAt", () => {
  it("adds the item's shelf life to the moment it was made", () => {
    expect(bestBeforeAt(ist("2026-08-29T06:40:00"), 12).toISOString()).toBe(ist("2026-08-29T18:40:00").toISOString());
  });

  it("keeps an item with no shelf life recorded for the working day", () => {
    expect(DEFAULT_SHELF_LIFE_HOURS).toBe(8);
    expect(bestBeforeAt(ist("2026-08-29T06:40:00")).toISOString()).toBe(ist("2026-08-29T14:40:00").toISOString());
    expect(bestBeforeAt(ist("2026-08-29T06:40:00"), undefined).toISOString()).toBe(ist("2026-08-29T14:40:00").toISOString());
  });
});

describe("bestBeforeText (H9)", () => {
  it("leaves a same-day best-before as a plain time", () => {
    const made = ist("2026-08-29T06:40:00");
    expect(bestBeforeText(bestBeforeAt(made, 12), made)).toBe("18:40");
  });

  it("says so when the best-before lands on the next day", () => {
    const made = ist("2026-08-29T20:34:00");
    expect(bestBeforeText(bestBeforeAt(made, 12), made)).toBe("08:34 tomorrow");
  });

  it("names the date when it is further out than tomorrow", () => {
    const made = ist("2026-08-29T20:34:00");
    expect(bestBeforeText(bestBeforeAt(made, 48), made)).toMatch(/^20:34 31 Aug$/);
  });

  it("measures the day boundary in the hospital's zone, not the host's", () => {
    // 23:30 IST on the 29th, due 00:30 IST on the 30th. A host running in UTC sees both
    // instants on the 29th and would call it "tonight"; the kitchen would not.
    const made = new Date("2026-08-29T18:00:00.000Z");
    const due = new Date("2026-08-29T19:00:00.000Z");
    expect(bestBeforeText(due, made)).toBe("00:30 tomorrow");
  });
});
```
Run: `pnpm --filter @rch/domain test` → FAIL (`./shelf.js` does not exist).

- [ ] **Step 2: Write `shelf.ts`**

```ts
/**
 * How long a made thing keeps, and how to say when it stops keeping.
 *
 * Spec §9.2: a batch's best-before is the item's `shelf_life_hours` after it was made, and an
 * item with none recorded keeps for the working day. The wording is H9's: a best-before that
 * lands on another day must say so, or an evening batch reads as though it expired this
 * morning. One implementation, because the server puts it in the toast and the browser puts
 * it in the batch log (spec §5.1).
 */
const TZ = "Asia/Kolkata";

/** The hospital's calendar date for an instant, so "which day" is not the host's opinion. */
const ymd = (d: Date): string => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
};
const hhmm = (d: Date): string =>
  d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });

/** An item with no shelf life recorded keeps for the working day. */
export const DEFAULT_SHELF_LIFE_HOURS = 8;

export const bestBeforeAt = (made: Date, hours?: number): Date =>
  new Date(made.getTime() + (hours ?? DEFAULT_SHELF_LIFE_HOURS) * 3_600_000);

export function bestBeforeText(due: Date, made: Date = new Date()): string {
  const days = Math.round((Date.parse(`${ymd(due)}T00:00:00Z`) - Date.parse(`${ymd(made)}T00:00:00Z`)) / 86_400_000);
  const time = hhmm(due);
  if (days === 0) return time;
  if (days === 1) return `${time} tomorrow`;
  return `${time} ${due.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: TZ })}`;
}
```
Add the export line to `packages/domain/src/index.ts`, after the `costing` line:
```ts
export { DEFAULT_SHELF_LIFE_HOURS, bestBeforeAt, bestBeforeText } from "./shelf.js";
```
Run: `pnpm --filter @rch/domain test` → PASS.

- [ ] **Step 3: Point the browser at it, and delete its two copies**

`UI/src/lib/fmt.ts`:
1. Delete `hhmm` (module-local, used only by `bestBefore`), the whole `bestBefore` function with its H9 comment, and `kolkataYmd`.
2. Replace `fromWireBestBefore`'s body with a delegate, keeping the doc comment's meaning:
```ts
/**
 * A best-before the server has already worked out, in the kitchen's own words (H9). The day
 * boundary is Asia/Kolkata's, not the host's — a host running in UTC must still call an
 * 11pm-IST due date "tonight" — which is why the wording lives in `@rch/domain` and both the
 * server's toast and this table read the one function.
 */
export const fromWireBestBefore = (isoStr: string): string => bestBeforeText(new Date(isoStr));
```
with `import { bestBeforeText } from "@rch/domain";` at the top of the file. `TZ` stays — `fromWireTime` still uses it. `UI/src/store/index.ts` still imports `bestBefore` at this point, so **typecheck will fail until Step 4**; that is the order the compiler wants, not a mistake.

- [ ] **Step 4: Keep the store compiling until Task 5 cuts it over**

`UI/src/store/index.ts` line 19 currently reads `import { bestBefore, fq, now, U } from "../lib/fmt";`. `makeProduct` is still local until Task 5, so give it the domain function directly rather than resurrecting the deleted one:
- change the import to `import { fq, now, U } from "../lib/fmt";`
- add `import { bestBeforeAt, bestBeforeText } from "@rch/domain";` beside the existing `@rch/contract` imports
- change the one call site (in `makeProduct`) from
  ```ts
  const bb = bestBefore(new Date(), IT[it].sl ?? 8);
  ```
  to
  ```ts
  const at = new Date();
  const bb = bestBeforeText(bestBeforeAt(at, IT[it].sl), at);
  ```
  and leave the rest of `makeProduct` alone — Task 5 deletes the whole body.

- [ ] **Step 5: Re-point the H9 test at the wording that survived**

In `UI/src/__tests__/fixes.test.ts`, replace the whole `H9 · best-before says which day it means` describe block with:
```ts
/* ---------------------------------------------------------------- H9 */
describe("H9 · best-before says which day it means", () => {
  // The wording itself is pinned in packages/domain/src/shelf.test.ts, where it now lives
  // (the server puts it in a toast, this table puts it in a column). What is left to check
  // here is that the batch log reads an ISO instant from the wire through that wording.
  it("marks a best-before that lands on the next day", () => {
    const due = new Date(Date.now() + 30 * 3600_000).toISOString();
    expect(fromWireBestBefore(due)).toMatch(/^\d{2}:\d{2} /);
  });

  it("leaves a best-before a few minutes out as a plain time", () => {
    // Five minutes from now is the same IST day unless the run straddles midnight, which the
    // suite's own clock decides; skip that one minute rather than pin a flake.
    const due = new Date(Date.now() + 5 * 60_000);
    if (due.getDate() === new Date().getDate()) expect(fromWireBestBefore(due.toISOString())).toMatch(/^\d{2}:\d{2}$/);
  });
});
```
and change the file's `import { bestBefore, fq, unitTotal } from "../lib/fmt";` to `import { fq, fromWireBestBefore, unitTotal } from "../lib/fmt";`.

- [ ] **Step 6: Run the tests**

Run: `pnpm turbo typecheck test && pnpm lint`
Expected: PASS. `knip` must stay quiet: `bestBefore` was exported and, after the store stops importing it, would have been reachable only from a test — which is why it is deleted here rather than left for later.

- [ ] **Step 7: Commit**

```bash
git add packages/domain UI/src/lib/fmt.ts UI/src/store/index.ts UI/src/__tests__/fixes.test.ts
git commit -m "$(cat <<'EOF'
Write the best-before wording once, where both sides can read it

A batch's best-before is its shelf life after the make, and an item with none recorded keeps
for the working day. Saying when that is — a plain time today, "tomorrow" when it crosses
midnight, a date beyond that (H9) — was written twice in the browser and about to be written a
third time in the server's toast. It is now one function in packages/domain, measuring the day
boundary in Asia/Kolkata so a pod running in UTC still calls an 11pm due date tonight.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 3: Reads — `GET /prod-orders` and `GET /batches`, scoped like the snapshot

*(Wave 2, alongside Tasks 4 and 5. It owns `apps/api/src/modules/snapshot/**` plus `packages/contract/src/{routes.ts,schemas/snapshot.ts}`. Task 4 owns `apps/api/src/modules/production/**`; Task 5 owns `apps/api/src/modules/tickets/**`, `apps/api/src/lib/tickets.ts` and three files in `packages/domain`. No two of the three share a file.)*

**Why this exists.** `UI/src/api/refetch.ts` falls back to a whole snapshot for any collection with no narrow reader, so today a dispatch — which names `["pord", "tkt", "rsv"]` — pulls the entire working set. Phase 4 adds two writes that name `"pord"` and `"batch"`, and Task 5 gives them narrow readers; those readers need routes. Spec §9.1 lists `/prod-orders` and `/batches` among the per-collection GETs, so this is implementing a read the spec already promised, not inventing one.

**Files:**
- Modify: `packages/contract/src/schemas/snapshot.ts`, `packages/contract/src/routes.ts`, `apps/api/src/modules/snapshot/{scope.ts,service.ts,routes.ts,snapshot.test.ts}`

**Interfaces:**
- Consumes: `readProdOrders(db, pre?)` and `readBatches(db)` from `./readers/documents.js` (both already exist and already produce the wire shapes `ProdOrderSchema` / `BatchSchema` accept); `Who` and the `scope*` helpers in `./scope.js`.
- Produces (imported by Task 5):
  ```ts
  // packages/contract/src/schemas/snapshot.ts
  export const ProdOrdersResponseSchema = z.array(D.ProdOrderSchema);
  export const BatchesResponseSchema = z.array(D.BatchSchema);

  // packages/contract/src/routes.ts
  prodOrders: defineRoute({ method: "GET", path: "/prod-orders", access: "any", response: ProdOrdersResponseSchema }),
  batches:    defineRoute({ method: "GET", path: "/batches",     access: "any", response: BatchesResponseSchema }),

  // apps/api/src/modules/snapshot/scope.ts
  export const scopeProdOrders: (pord: ProdOrder[], who: Who) => ProdOrder[];
  export const scopeBatches: (batch: Batch[], who: Who) => Batch[];

  // apps/api/src/modules/snapshot/service.ts — added to the object createSnapshotService returns
  prodOrders(claims: AccessClaims): Promise<ProdOrder[]>;
  batches(claims: AccessClaims): Promise<Batch[]>;
  ```
- Route keys are `prodOrders` and `batches`; neither collides with `dispatchProdOrder`, `distribute`, `setOrderStatus` or `makeBatch`.
- `access: "any"`, like every other snapshot read: the cut is made in the service by role, not by hiding the route. A counter operator asking for `/batches` gets `[]`, which is what their snapshot already contains.

**Scoping, taken from `scope()` so there is one definition and not two:** a counter sees the production orders their own outlet raised (`o.from === who.loc`) and no batches at all; every other role sees everything. `scope()` currently spells both out inline — the `pord: s.pord.filter(...)` line and the `batch: []` in the trailing group. Move them into the two exported helpers and have `scope()` call them, exactly as it already does for `scopeRequests`/`scopeTickets`/`scopeShopAsks`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/modules/snapshot/snapshot.test.ts` (read the top of that file first and reuse its existing `app`, `beforeEach` and helpers rather than adding your own):
```ts
describe("GET /prod-orders and GET /batches", () => {
  it("hand the kitchen its whole board and its whole batch log", async () => {
    const snap = (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, "u4") })).json();

    const orders = await app.inject({ method: "GET", url: "/api/v1/prod-orders", headers: await authHeaders(app, "u4") });
    expect(orders.statusCode, orders.body).toBe(200);
    expect(orders.json().map((o: { id: string }) => o.id)).toEqual(snap.pord.map((o: { id: string }) => o.id));

    const batches = await app.inject({ method: "GET", url: "/api/v1/batches", headers: await authHeaders(app, "u4") });
    expect(batches.statusCode, batches.body).toBe(200);
    expect(batches.json().map((b: { id: string }) => b.id)).toEqual(snap.batch.map((b: { id: string }) => b.id));
    expect(batches.json()[0]).toMatchObject({ it: expect.any(String), qty: expect.any(Number), made: expect.any(Number) });
  });

  it("cut a counter down the same way the snapshot does", async () => {
    // u1 is the Coffee Shop. The seeded orders were raised by the Snack Kiosk, so the coffee
    // counter sees none of them — and no counter sees the kitchen's batch log at all.
    const snap = (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, "u1") })).json();
    const orders = (await app.inject({ method: "GET", url: "/api/v1/prod-orders", headers: await authHeaders(app, "u1") })).json();
    const batches = (await app.inject({ method: "GET", url: "/api/v1/batches", headers: await authHeaders(app, "u1") })).json();

    expect(orders.map((o: { id: string }) => o.id)).toEqual(snap.pord.map((o: { id: string }) => o.id));
    expect(orders.every((o: { from: string }) => o.from === "coffee")).toBe(true);
    expect(batches).toEqual([]);
    expect(snap.batch).toEqual([]);
  });

  it("shows a counter the orders their own outlet raised", async () => {
    // u6 is the Snack Kiosk, which raised both seeded orders.
    const orders = (await app.inject({ method: "GET", url: "/api/v1/prod-orders", headers: await authHeaders(app, "u6") })).json();
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((o: { from: string }) => o.from === "kiosk")).toBe(true);
  });
});
```
Run: `pnpm --filter @rch/api test src/modules/snapshot` → FAIL (404 on both URLs).

- [ ] **Step 2: Declare the two reads**

`packages/contract/src/schemas/snapshot.ts`, beside `RequestsResponseSchema`:
```ts
export const ProdOrdersResponseSchema = z.array(D.ProdOrderSchema);
export const BatchesResponseSchema = z.array(D.BatchSchema);
```
`packages/contract/src/routes.ts`: extend the comment that introduces the movement GETs so it covers five collections rather than three, and add the two entries after `shopAsks`:
```ts
  // The kitchen's two collections, likewise: a make names "batch" and "stock", a status change
  // names "pord", and each refetches its own slice instead of the whole snapshot (spec §9.1).
  prodOrders:  defineRoute({ method: "GET", path: "/prod-orders", access: "any", response: ProdOrdersResponseSchema }),
  batches:     defineRoute({ method: "GET", path: "/batches",     access: "any", response: BatchesResponseSchema }),
```
adding both names to the existing `./schemas/snapshot.js` import at the top of the file.

- [ ] **Step 3: Move the scoping into two helpers, and answer with them**

`apps/api/src/modules/snapshot/scope.ts` — add, beside `scopeShopAsks`:
```ts
/** The kitchen's board belongs to the kitchen; an outlet sees the orders it raised itself. */
export const scopeProdOrders = (pord: ProdOrder[], who: Who): ProdOrder[] =>
  who.role !== "counter" ? pord : pord.filter((o) => o.from === who.loc);
/** The batch log is the kitchen's own record of what it made. A counter sells the output and
 *  has no window on the production behind it — the snapshot has always sent them none. */
export const scopeBatches = (batch: Batch[], who: Who): Batch[] => (who.role !== "counter" ? batch : []);
```
with `Batch` and `ProdOrder` added to the file's `@rch/contract` type import. Then in `scope()` replace the inline `pord: s.pord.filter((o) => o.from === L),` with `pord: scopeProdOrders(s.pord, who),` and take `batch: []` out of the trailing group, adding `batch: scopeBatches(s.batch, who),` beside it — the group line becomes `prq: [], po: [], grn: [], vendors: [], contracts: [],`.

`apps/api/src/modules/snapshot/service.ts` — beside `shopAsks()`:
```ts
    /** The kitchen's board on its own — what a status change naming "pord" refetches. */
    async prodOrders(claims: AccessClaims): Promise<ProdOrder[]> { return scopeProdOrders(await D.readProdOrders(db), claims); },
    /** The batch log on its own — what a make naming "batch" refetches. */
    async batches(claims: AccessClaims): Promise<Batch[]> { return scopeBatches(await D.readBatches(db), claims); },
```
adding `Batch` and `ProdOrder` to the file's `@rch/contract` type import and `scopeBatches`, `scopeProdOrders` to its `./scope.js` import.

`apps/api/src/modules/snapshot/routes.ts` — two more mounts under the existing three:
```ts
  mount(app, routes.prodOrders, async (req) => svc.prodOrders(req.user));
  mount(app, routes.batches, async (req) => svc.batches(req.user));
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @rch/api test src/modules/snapshot src/contract.test.ts` → PASS, including `contract.test.ts`'s two new named cases (`prodOrders`, `batches`), which probe both URLs as the outlet manager and parse the bodies against the declared schemas.
Then the whole gate: `pnpm turbo typecheck test && pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/contract apps/api/src/modules/snapshot
git commit -m "$(cat <<'EOF'
Serve the kitchen's board and batch log on their own

Spec §9.1 promised both as per-collection reads; a write that names "pord" or "batch" can now
refetch that slice instead of dragging the whole working set back. The counter's cut is the
snapshot's cut, moved into two helpers so there is one definition of it rather than two.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 4: `production` — the board's statuses and the batch that consumes its recipe

*(Wave 2, alongside Tasks 3 and 5. It owns `apps/api/src/modules/production/**` and nothing else — the module's four files already exist from Phase 3, and `modules/index.ts` already registers it, so there is no shared registration line to edit.)*

**Files:**
- Modify: `apps/api/src/modules/production/repo.ts`, `apps/api/src/modules/production/service.ts`, `apps/api/src/modules/production/routes.ts`, `apps/api/src/modules/production/production.test.ts`

**Interfaces:**
- Consumes, all already exported and all with these exact signatures:
  - `mount` from `../../routes.js`
  - `withTransaction(db, fn)` from `../../lib/db.js`; `type Tx` from the same file
  - `assertRule(cond, message, details?): asserts cond` from `../../lib/rules.js`
  - `NotFoundError` from `../../lib/errors.js`
  - `loadMaster(db | tx): Promise<Master>` from `../../lib/master.js`
  - `appendHistory(tx, docType, docId, status, who, at?)` from `../../lib/history.js`
  - `allocateNumber(tx, kind, at?): Promise<{ n: number; id: string }>` from `../../lib/ids.js` — **the kind for a batch is `"batch"`, not `"bat"`** (`IdKind` in `packages/domain/src/ids.ts`; `formatId` renders `BAT-<yyyymmdd>-<nn>` and `SEQUENCE_START.batch` is 1)
  - `lockBalances(tx, cells)`, `postMoves(tx, moves)`, `type Move` from `../../lib/ledger.js`
  - `reservedAt(tx, loc, itemKeys?): Promise<RsvMap>` from `../../lib/reservations.js` (keys are `"loc:item"`)
  - `iso(d)` from `../../lib/time.js`
  - `bestBeforeAt`, `bestBeforeText`, `canTransition`, `fq(v, unit)`, `PROD_ORDER_TRANSITIONS`, `round3` from `@rch/domain`
  - `given.prodOrder(db, { id?, st?, from?, by?, lines?, note? })` and `given.ticket(db, { from, to, lines, … })` from `../../test/builders.js`, `warmPool(t, n)` and `truncateAll(db)` from `../../test/db.js`, in the test
- Produces:
  ```ts
  // apps/api/src/modules/production/repo.ts — added to the existing productionRepo object
  overrideAt(tx: Tx, loc: string, itemKey: string): Promise<string | undefined>;
  insertBatch(tx: Tx, v: typeof batches.$inferInsert): Promise<typeof batches.$inferSelect>;

  // apps/api/src/modules/production/service.ts — added to what createProductionService returns
  setStatus(claims: AccessClaims, id: string, st: PordStatus): Promise<WriteResponse<ProdOrder>>;
  makeBatch(claims: AccessClaims, body: MakeBatchBody): Promise<WriteResponse<Batch>>;
  export type MakeBatchBody = z.infer<typeof MakeBatchBodySchema>;
  ```
- The contract entries (`setOrderStatus`, `makeBatch`, `SetOrderStatusBodySchema`, `MakeBatchBodySchema`) are Task 1's and are already merged; this task adds no schema.

**Rules, verbatim (spec §9.2's `setOrderStatus` and `makeProduct` rows). Every message below except the three marked NEW is the store's current `notify()` text, character for character:**

| Endpoint | Rules, in this order | Message |
|---|---|---|
| `POST /prod-orders/:id/status` (prod) | order exists, read `for update` (404 `There is no production order <id>.`); **NEW** `assertRule(body.st !== "Dispatched", \`${id} goes out on a pick ticket — dispatch it from the order instead\`)`; **NEW** `assertRule(o.status !== "Dispatched", \`${id} has already gone out — cancel its ticket to bring it back onto the board\`)`; **NEW** `assertRule(canTransition(PROD_ORDER_TRANSITIONS, o.status, body.st), \`${id} is ${o.status.toLowerCase()} — it cannot go straight to ${body.st.toLowerCase()}\`)`; `setStatus`; history row carrying the new status and the kitchen in-charge's name | `` `${id} — ${st.toLowerCase()}` `` |
| `POST /batches` (prod) | `assertRule(started > 0, "Enter a quantity to make")`; `assertRule(made >= 0 && made <= started, \`Yield cannot exceed the ${started} started\`)`; item exists (404 `There is no item <key>.`); `assertRule(!off, \`${item.n} is switched off in the kitchen\`)`; `assertRule(recipe, \`${item.n} has no recipe — it cannot be produced\`)`; `allocateNumber(tx, "batch", at)`; `lockBalances` over every ingredient cell **and** the finished-item cell at the kitchen; read on hand and open reservations; the first ingredient in recipe order whose free-to-promise will not stretch refuses with `` `Kitchen is short of ${ing.n} — ${fq(free, unit)} ${unit} left` ``; `postMoves` — one `production_consume` per ingredient for `need × started` and, when `made > 0`, one `production_yield` for `made`; **NEW (post-lock)** re-read and assert `on_hand − reserved ≥ 0` per ingredient with the same sentence; insert the `batches` row | made === started: `` `${id} — ${started} ${item.n} made, best before ${bb}` ``<br>otherwise: `` `${id} — ${made} of ${started} ${item.n} yielded (${(((made - started) / started) * 100).toFixed(1)}%), best before ${bb}` `` |

`changed`: status `["pord"]`; batch `["batch", "stock"]`. Each is emitted with `await emitChanged(tx, changed)` inside the transaction. **A make names no `"rsv"`** — it reserves nothing and releases nothing; the reservations it reads are other tickets' and it leaves them exactly where they were.

**Four refusals are new, and Task 7 records each in spec §16.** The store's `setOrderStatus` had no rules at all — the board only ever offered a legal button — so a stale tab needs sentences that did not exist. `assertTransition` is deliberately *not* used for the transition guard: its wording is `<id> is already <status>`, which would answer a New order asked to jump to Ready with "PRD-2026-029 is already new". The guard still reads the table (`canTransition`), as Phase 3 ruled; only the sentence is its own. The post-lock re-read is the fourth, which the browser never had because it never re-read anything.

**The `Dispatched` trap, both ways round.** `PROD_ORDER_TRANSITIONS` lists `Dispatched` as reachable from every open stage — because `dispatch` may run whenever the kitchen is ready — and, since Task 1, lists `Ready` as reachable *from* `Dispatched`, because cancelling a dispatch ticket has to put the order back. Neither edge belongs to this endpoint: taking the first would mark an order dispatched with no ticket and no reservation behind it, and taking the second would strand a live ticket on an order the board says is still cooking. Hence two explicit guards ahead of the table check, one on the target and one on the source, each with a test that proves a direct press is refused and the order does not move.

**Two notes the implementer needs before writing the service.**

*The order of the rules is the order of the sentences.* The store checks quantity, then yield, then the switch, then the recipe, then the rack. Keep that order or the same input produces a different sentence than it does today, and the UI test that moves to this suite will say so.

*Which item may be batched.* The rule is the spec's — "recipe exists" — and not "the item is a finished good". `chai` and `capp` have recipes and no `shelf_life_hours`, so a batch of either is legal and stamps the eight-hour default; the kitchen's screen offers only the three FG products, which is a screen decision and not a rule.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/modules/production/production.test.ts`. **Read the top of that file first and reuse its existing `app`, `hdr`, `post`, `orders`, `onHand`, `locName` and `bake` helpers**; the two `describe` blocks below assume them, and add only what is genuinely new (`stockAt`, `moves`, `batches`).

```ts
/** Every batch row the database holds, newest first, for a suite that wants to count them. */
const allBatches = async () => app.testDb!.db.select().from(batchesTable);
/** A move ledger read, for the "nothing was written" half of every refusal. */
const moveCount = async () => (await app.testDb!.db.select().from(stockMoves)).length;

describe("POST /prod-orders/:id/status", () => {
  it("walks the board a stage at a time and signs each step", async () => {
    const id = await given.prodOrder(app.testDb!.db, { st: "New" });

    const accepted = await post("u4", `/prod-orders/${id}/status`, { st: "Accepted" });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const b = accepted.json();
    expect(b.result).toMatchObject({ id, st: "Accepted" });
    expect(b.result.hist.at(-1)).toMatchObject({ s: "Accepted", who: "Vinoth Prakash" });
    expect(b.changed).toEqual(["pord"]);
    expect(b.message).toBe(`${id} — accepted`);

    expect((await post("u4", `/prod-orders/${id}/status`, { st: "In kitchen" })).json().message).toBe(`${id} — in kitchen`);
    expect((await post("u4", `/prod-orders/${id}/status`, { st: "Ready" })).json().message).toBe(`${id} — ready`);
    const board = (await orders()).find((o: { id: string }) => o.id === id);
    expect(board.st).toBe("Ready");
    expect(board.hist.map((h: { s: string }) => h.s)).toEqual(["Accepted", "In kitchen", "Ready"]);
  });

  it("refuses a stage skipped, and says which two it means", async () => {
    const id = await given.prodOrder(app.testDb!.db, { st: "New" });
    const r = await post("u4", `/prod-orders/${id}/status`, { st: "Ready" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${id} is new — it cannot go straight to ready`);
    expect((await orders()).find((o: { id: string }) => o.id === id).st).toBe("New");
  });

  it("turns an order down, and will not take it back afterwards", async () => {
    const id = await given.prodOrder(app.testDb!.db, { st: "New" });
    expect((await post("u4", `/prod-orders/${id}/status`, { st: "Declined" })).json().message).toBe(`${id} — declined`);
    const again = await post("u4", `/prod-orders/${id}/status`, { st: "Accepted" });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe(`${id} is declined — it cannot go straight to accepted`);
  });

  it("sends nobody out through this door — dispatch mints a ticket and has its own", async () => {
    const id = await given.prodOrder(app.testDb!.db, { st: "Ready" });
    const r = await post("u4", `/prod-orders/${id}/status`, { st: "Dispatched" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${id} goes out on a pick ticket — dispatch it from the order instead`);
    expect((await orders()).find((o: { id: string }) => o.id === id).st).toBe("Ready");
  });

  it("will not take a dispatched order back either — that edge belongs to cancelling the ticket", async () => {
    // The table has Dispatched -> Ready so a cancellation can put the order back (Task 1). This
    // door must not take it: doing so would leave a live ticket holding stock for an order the
    // board says is still cooking.
    const id = await given.prodOrder(app.testDb!.db, { st: "Dispatched" });
    const r = await post("u4", `/prod-orders/${id}/status`, { st: "Ready" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${id} has already gone out — cancel its ticket to bring it back onto the board`);
    expect((await orders()).find((o: { id: string }) => o.id === id).st).toBe("Dispatched");
  });

  it("accepts an order once when two screens press together", async () => {
    const id = await given.prodOrder(app.testDb!.db, { st: "New" });
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u4", `/prod-orders/${id}/status`, { st: "Accepted" }),
      post("u4", `/prod-orders/${id}/status`, { st: "Accepted" }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
    const hist = (await orders()).find((o: { id: string }) => o.id === id).hist;
    expect(hist.filter((h: { s: string }) => h.s === "Accepted")).toHaveLength(1);
  });

  it("404s an order that is not there, and is absent for every other role", async () => {
    expect((await post("u4", "/prod-orders/PRD-2026-999/status", { st: "Accepted" })).json().error.message)
      .toBe("There is no production order PRD-2026-999.");
    const id = await given.prodOrder(app.testDb!.db, { st: "New" });
    for (const u of ["u1", "u2", "u3", "u5"]) {
      expect((await post(u, `/prod-orders/${id}/status`, { st: "Accepted" })).statusCode).toBe(404);
    }
  });
});

describe("POST /batches", () => {
  it("consumes the recipe for what was started and books only what came good (C1, UA-14)", async () => {
    const before = {
      maida: await onHand("kitchen", "maida"), fill: await onHand("kitchen", "fill"),
      oil: await onHand("kitchen", "oil"), box: await onHand("kitchen", "box"),
      puff: await onHand("kitchen", "puff"),
    };

    const r = await post("u4", "/batches", { it: "puff", started: 60, made: 58, note: "Oven tray dropped" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ it: "puff", qty: 60, made: 58, note: "Oven tray dropped" });
    expect(b.result.id).toMatch(/^BAT-\d{8}-\d{2}$/);
    expect(b.changed).toEqual(["batch", "stock"]);
    // The variance is the sentence's whole point; the best-before's exact wording is pinned by
    // the next case, against the instant the row actually carries.
    expect(b.message).toMatch(new RegExp(`^${b.result.id} — 58 of 60 Veg puffs yielded \\(-3\\.3%\\), best before \\d{2}:\\d{2}`));

    // Ingredients against what was started; only the yield onto the rack.
    expect(await onHand("kitchen", "maida")).toBeCloseTo(before.maida - 0.035 * 60, 3);
    expect(await onHand("kitchen", "fill")).toBeCloseTo(before.fill - 0.030 * 60, 3);
    expect(await onHand("kitchen", "oil")).toBeCloseTo(before.oil - 0.008 * 60, 3);
    expect(await onHand("kitchen", "box")).toBeCloseTo(before.box - 60, 3);
    expect(await onHand("kitchen", "puff")).toBeCloseTo(before.puff + 58, 3);

    // One document behind every movement: five moves, all pointing at this batch.
    const mine = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, b.result.id));
    expect(mine).toHaveLength(5);
    expect(mine.filter((m) => m.kind === "production_consume")).toHaveLength(4);
    expect(mine.filter((m) => m.kind === "production_yield")).toHaveLength(1);
    expect(mine.every((m) => m.refType === "batch" && m.loc === "kitchen")).toBe(true);
  });

  it("stamps the best-before from the item's shelf life, in the kitchen's own words", async () => {
    const r = await post("u4", "/batches", { it: "puff", started: 10 });
    const b = r.json();
    // Veg puffs keep 12 hours; the batch row carries the instant, the toast carries the wording.
    const row = (await allBatches()).find((x) => x.id === b.result.id)!;
    expect(new Date(row.bestBefore).getTime() - new Date(row.at).getTime()).toBe(12 * 3600_000);
    expect(b.message).toBe(`${b.result.id} — 10 Veg puffs made, best before ${bestBeforeText(new Date(row.bestBefore), new Date(row.at))}`);
  });

  it("keeps a product with no shelf life recorded for the working day", async () => {
    const r = await post("u4", "/batches", { it: "chai", started: 4 });
    expect(r.statusCode, r.body).toBe(200);
    const row = (await allBatches()).find((x) => x.id === r.json().result.id)!;
    expect(new Date(row.bestBefore).getTime() - new Date(row.at).getTime()).toBe(8 * 3600_000);
  });

  it("treats an omitted yield as a full one", async () => {
    const before = await onHand("kitchen", "puff");
    const r = await post("u4", "/batches", { it: "puff", started: 10 });
    expect(r.json().result).toMatchObject({ qty: 10, made: 10 });
    expect(r.json().message).toMatch(/^BAT-\d{8}-\d{2} — 10 Veg puffs made, best before /);
    expect(await onHand("kitchen", "puff")).toBeCloseTo(before + 10, 3);
  });

  it("takes a whole tray lost: the ingredients go, nothing reaches the rack", async () => {
    const before = await onHand("kitchen", "puff");
    const maida = await onHand("kitchen", "maida");
    const r = await post("u4", "/batches", { it: "puff", started: 10, made: 0, note: "Oven failed mid-bake" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result).toMatchObject({ qty: 10, made: 0 });
    expect(await onHand("kitchen", "puff")).toBeCloseTo(before, 3);
    expect(await onHand("kitchen", "maida")).toBeCloseTo(maida - 0.035 * 10, 3);
    // A yield of nothing is not a movement; the batch row is what records it.
    const mine = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, r.json().result.id));
    expect(mine.filter((m) => m.kind === "production_yield")).toHaveLength(0);
  });

  it("refuses a yield greater than the quantity started, and writes nothing at all", async () => {
    const before = await onHand("kitchen", "puff");
    const count = await moveCount();
    const r = await post("u4", "/batches", { it: "puff", started: 10, made: 25 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Yield cannot exceed the 10 started");
    expect(await onHand("kitchen", "puff")).toBe(before);
    expect(await moveCount()).toBe(count);
    expect(await allBatches()).toHaveLength(1);   // the seeded one, and no more
  });

  it("refuses a make of nothing", async () => {
    expect((await post("u4", "/batches", { it: "puff", started: 0 })).json().error.message).toBe("Enter a quantity to make");
  });

  it("refuses a product the kitchen has switched off", async () => {
    await post("u4", "/availability/toggle", { loc: "kitchen", it: "puff" });
    const r = await post("u4", "/batches", { it: "puff", started: 10 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Veg puffs is switched off in the kitchen");
  });

  it("refuses a product with nothing written down to make it by", async () => {
    const r = await post("u4", "/batches", { it: "water", started: 10 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Mineral water 1L has no recipe — it cannot be produced");
  });

  it("names the ingredient that ran out, and moves nothing (C1)", async () => {
    const count = await moveCount();
    const fill = await onHand("kitchen", "fill");
    // 101 puffs need 3.03 kg of filling; the kitchen holds 3.
    const r = await post("u4", "/batches", { it: "puff", started: 101 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`Kitchen is short of Veg filling mix — ${fill.toFixed(3)} kg left`);
    expect(await moveCount()).toBe(count);
  });

  it("counts what another ticket is already holding, not merely what is on the shelf", async () => {
    const fill = await onHand("kitchen", "fill");
    await given.ticket(app.testDb!.db, { from: "kitchen", to: "kiosk", lines: [{ it: "fill", qty: fill }] });
    const r = await post("u4", "/batches", { it: "puff", started: 1 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Kitchen is short of Veg filling mix — 0.000 kg left");
  });

  it("makes one of two races and refuses the other, leaving no ingredient below zero", async () => {
    // The kitchen's filling covers 100 puffs. Two makes of 60 cannot both be right.
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u4", "/batches", { it: "puff", started: 60 }),
      post("u4", "/batches", { it: "puff", started: 60 }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
    expect(await onHand("kitchen", "fill")).toBeGreaterThanOrEqual(0);
    expect(await allBatches()).toHaveLength(2);   // the seeded one plus the winner
  });

  it("404s an unknown item, and is absent for every other role", async () => {
    expect((await post("u4", "/batches", { it: "totally-fake", started: 1 })).json().error.message).toBe("There is no item totally-fake.");
    for (const u of ["u1", "u2", "u3", "u5"]) expect((await post(u, "/batches", { it: "puff", started: 1 })).statusCode).toBe(404);
  });
});
```
Add to the file's imports what these cases need and it does not already have: `bestBeforeText` from `@rch/domain`; `batches as batchesTable` from `../../db/schema/index.js` (aliased because `batches` reads as a helper here); `warmPool` from `../../test/db.js`; `eq` from `drizzle-orm` and `stockMoves`, `given` are already there from Phase 3.

Run: `pnpm --filter @rch/api test src/modules/production` → FAIL (404 on both new URLs).

**Prove the race cases before you keep them.** With `warmPool` commented out, both concurrent calls must still pass (that is the trap this constraint exists for); with `lockBalances` commented out of `makeBatch`, the second make must succeed and drive `fill` negative. Restore both, and only then move on.

- [ ] **Step 2: Write the two repo methods**

`apps/api/src/modules/production/repo.ts`, added to the `productionRepo` object:
```ts
  /** Whether the kitchen has switched this product off, and the reason it recorded.
   *  Read inside the write's transaction, so a switch flipped a moment ago is seen. */
  async overrideAt(tx: Tx, loc: string, itemKey: string): Promise<string | undefined> {
    const [o] = await tx.select({ reason: availabilityOverrides.reason }).from(availabilityOverrides)
      .where(and(eq(availabilityOverrides.loc, loc), eq(availabilityOverrides.itemKey, itemKey)));
    return o?.reason;
  },

  /** The batch document. `.returning()` hands back what the database stored — the defaulted
   *  `at` included — so the wire shape and the ledger's timestamps cannot drift apart. */
  async insertBatch(tx: Tx, v: typeof batches.$inferInsert): Promise<typeof batches.$inferSelect> {
    const [row] = await tx.insert(batches).values(v).returning();
    return row!;
  },
```
with `availabilityOverrides` and `batches` added to the file's `../../db/schema/index.js` import.

- [ ] **Step 3: Write `setStatus`**

Into the object `createProductionService` returns, after `dispatch`:
```ts
    /**
     * One press on the kitchen's board. The order row is read `for update` first, so two
     * screens pressing Accept together cannot both find it New and both sign for it.
     *
     * The table decides and the sentence only explains: PROD_ORDER_TRANSITIONS is the same
     * data the board draws its buttons from (spec §5.1). The sentence is this endpoint's own
     * rather than `assertTransition`'s "is already <status>", which would answer a New order
     * asked to jump to Ready with "is already new" — true of the wrong half of the sentence.
     */
    async setStatus(claims: AccessClaims, id: string, st: PordStatus): Promise<WriteResponse<ProdOrder>> {
      return withTransaction(db, async (tx) => {
        const o = await productionRepo.head(tx, id);
        if (!o) throw new NotFoundError(`There is no production order ${id}.`);
        // Dispatch is a movement, not a word: it mints the ticket the outlet collects against
        // and reserves the stock behind it, so it has its own endpoint (spec §9.2).
        assertRule(st !== "Dispatched", `${id} goes out on a pick ticket — dispatch it from the order instead`);
        // And the way back is a movement too. The table has Dispatched -> Ready so a cancelled
        // ticket can put the order back on the board; taking that edge here would leave the
        // ticket live and holding stock for an order the board says is still cooking.
        assertRule(o.status !== "Dispatched", `${id} has already gone out — cancel its ticket to bring it back onto the board`);
        assertRule(
          canTransition(PROD_ORDER_TRANSITIONS, o.status, st),
          `${id} is ${o.status.toLowerCase()} — it cannot go straight to ${st.toLowerCase()}`,
        );

        const at = new Date();
        await productionRepo.setStatus(tx, id, st);
        const who = await productionRepo.userName(tx, claims.sub);
        await appendHistory(tx, "prod_order", id, st, who, at);

        const changed = ["pord"] as const;
        await emitChanged(tx, changed);
        return { result: await productionRepo.wire(tx, id), changed: [...changed], message: `${id} — ${st.toLowerCase()}` };
      });
    },
```
adding `PordStatus` to the file's `@rch/contract` type import.

- [ ] **Step 4: Write `makeBatch`**

After `setStatus`:
```ts
    /**
     * A batch: the one write in this system that creates stock, and therefore the one that must
     * not be able to create it out of nothing. The recipe comes out of the kitchen's raw
     * materials and the finished units go onto its rack in the same `postMoves` call, so there
     * is no instant at which the hospital's books show one without the other (C1).
     *
     * Ingredients go against what was **started**; only the units that came good reach the rack
     * (UA-14). A tray dropped is stock consumed and nothing produced, and the batch row is what
     * records the difference.
     *
     * Lock order, as everywhere: ids before balances (`lib/ledger.ts`'s header). The cells are
     * locked in one call covering the ingredients *and* the finished item, so the `postMoves`
     * below re-takes only locks this transaction already holds — a make that locked the
     * ingredients alone would reach for the finished item's row while holding four others.
     */
    async makeBatch(claims: AccessClaims, body: MakeBatchBody): Promise<WriteResponse<Batch>> {
      return withTransaction(db, async (tx) => {
        const started = round3(body.started);
        assertRule(started > 0, "Enter a quantity to make");
        const made = round3(body.made ?? started);
        assertRule(made >= 0 && made <= started, `Yield cannot exceed the ${started} started`);

        const master = await loadMaster(tx);
        const item = master.items[body.it];
        if (!item) throw new NotFoundError(`There is no item ${body.it}.`);
        // The kitchen's own switch, in the kitchen's own words. Read before the recipe so the
        // sentences arrive in the order the screen has always produced them.
        const off = await productionRepo.overrideAt(tx, KITCHEN, body.it);
        assertRule(!off, `${item.n} is switched off in the kitchen`);
        const recipe = master.recipes[body.it];
        assertRule(recipe, `${item.n} has no recipe — it cannot be produced`);

        const need = recipe.l.map(([g, per]) => ({ it: g, qty: round3(per * started) }));
        const at = new Date();
        const no = await allocateNumber(tx, "batch", at);
        const cells = [...need.map((n) => ({ loc: KITCHEN, it: n.it })), { loc: KITCHEN, it: body.it }];
        await lockBalances(tx, cells);
        const keys = cells.map((c) => c.it);
        const onHand = await productionRepo.balancesAt(tx, KITCHEN, keys);
        const held = await reservedAt(tx, KITCHEN, keys);
        // What another ticket is holding is not the kitchen's to bake with, so the measure is
        // free to promise and not what is on the shelf.
        const free = (g: string) => round3((onHand[g] ?? 0) - (held[`${KITCHEN}:${g}`] ?? 0));
        /** The kitchen's own sentence for an ingredient that will not stretch. */
        const shortOf = (g: string): string => {
          const ing = master.items[g];
          const unit = ing?.u ?? "nos";
          return `Kitchen is short of ${ing?.n ?? g} — ${fq(free(g), unit)} ${unit} left`;
        };
        // The first in recipe order, which is the one the kitchen's own screen names.
        const short = need.find((n) => free(n.it) < n.qty);
        assertRule(!short, short ? shortOf(short.it) : "");

        const moves: Move[] = need.map((n) => ({
          loc: KITCHEN, it: n.it, qty: -n.qty, kind: "production_consume", refType: "batch", refId: no.id, by: claims.sub, at,
        }));
        // A yield of nothing is not a movement. The batch row records the lost tray; its
        // balance row already exists, because `lockBalances` above created it.
        if (made > 0) {
          moves.push({ loc: KITCHEN, it: body.it, qty: made, kind: "production_yield", refType: "batch", refId: no.id, by: claims.sub, at });
        }
        await postMoves(tx, moves);

        // The cover check above already ran under these locks, so this cannot fire today. It is
        // the invariant §12 asks for on every negative-going move, and it is what catches the
        // next caller that reads a balance before locking it.
        const after = await productionRepo.balancesAt(tx, KITCHEN, need.map((n) => n.it));
        const heldAfter = await reservedAt(tx, KITCHEN, need.map((n) => n.it));
        for (const n of need) {
          const left = round3((after[n.it] ?? 0) - (heldAfter[`${KITCHEN}:${n.it}`] ?? 0));
          const ing = master.items[n.it];
          const unit = ing?.u ?? "nos";
          assertRule(left >= 0, `Kitchen is short of ${ing?.n ?? n.it} — ${fq(Math.max(0, round3(left + n.qty)), unit)} ${unit} left`);
        }

        const bb = bestBeforeAt(at, item.sl);
        const row = await productionRepo.insertBatch(tx, {
          id: no.id, itemKey: body.it, startedQty: started, madeQty: made, at, bestBefore: bb,
          note: body.note ?? null, byUser: claims.sub,
        });
        // The shape readers/documents.ts's readBatches produces, for the one batch just written.
        const result: Batch = {
          id: row.id, it: row.itemKey, qty: row.startedQty, made: row.madeQty,
          at: iso(row.at), bb: iso(row.bestBefore), ...(row.note ? { note: row.note } : {}),
        };

        const text = bestBeforeText(bb, at);
        const changed = ["batch", "stock"] as const;
        await emitChanged(tx, changed);
        return {
          result,
          changed: [...changed],
          message: made === started
            ? `${no.id} — ${started} ${item.n} made, best before ${text}`
            : `${no.id} — ${made} of ${started} ${item.n} yielded (${(((made - started) / started) * 100).toFixed(1)}%), best before ${text}`,
        };
      });
    },
```
and at the top of the file:
```ts
import type { Batch, MakeBatchBodySchema, PordStatus, ProdOrder, Ticket, WriteResponse } from "@rch/contract";
import { bestBeforeAt, bestBeforeText, canTransition, fq, PROD_ORDER_TRANSITIONS, round3 } from "@rch/domain";
import { allocateNumber } from "../../lib/ids.js";
import { lockBalances, postMoves, type Move } from "../../lib/ledger.js";
import { iso } from "../../lib/time.js";
...
export type MakeBatchBody = z.infer<typeof MakeBatchBodySchema>;
```
(merging each into the import line that already exists — `lockBalances` is imported from `lib/ledger.js` today, `canTransition`/`fq`/`round3` from `@rch/domain`.)

- [ ] **Step 5: Mount them**

`apps/api/src/modules/production/routes.ts` — replace the file's opening comment and add two mounts:
```ts
// Production: everything the Central Kitchen does. The two ways it puts stock on a ticket — an
// order it was asked for and a tray it decided to push out — and the two ways it works: the
// board's own statuses, and the batch that turns raw materials into finished units.
...
  // Neither is location-scoped: the prod role has one kitchen, and every rule here pins the
  // location to it rather than taking one from the caller.
  mount(app, routes.setOrderStatus, async (req) => svc.setStatus(req.user, req.params.id, req.body.st));
  mount(app, routes.makeBatch, async (req) => svc.makeBatch(req.user, req.body));
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @rch/api test src/modules/production` → PASS.
Then `pnpm turbo typecheck test && pnpm lint` (which includes `scripts/check-boundaries.sh` — the module writes `batches` and `prod_orders`, neither of which is protected, and every ledger write goes through `postMoves`).

- [ ] **Step 7: Prove the cache against the ledger by hand**

On a seeded local database (`pnpm db:up && pnpm --filter @rch/api db:migrate && pnpm --filter @rch/api db:seed --force`, API running):
```bash
API=http://localhost:3000/api/v1
PROD=$(curl -sS -X POST $API/auth/login -H 'content-type: application/json' -d '{"emp":"RC-1902","password":"changeme"}' | jq -r .accessToken)
curl -sS -X POST $API/batches -H "Authorization: Bearer $PROD" -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"it":"puff","started":60,"made":58,"note":"Oven tray dropped"}' | jq -r .message
curl -sS -H "Authorization: Bearer $PROD" $API/stock > /tmp/rch-before.json
pnpm --filter @rch/api db:rebuild-balances
curl -sS -H "Authorization: Bearer $PROD" $API/stock > /tmp/rch-after.json
diff /tmp/rch-before.json /tmp/rch-after.json && echo "balances reconcile"
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/production
git commit -m "$(cat <<'EOF'
Make the kitchen's board and its batches the server's

A batch is the one write that creates stock, so it is the one that must not create it out of
nothing: the recipe comes off the kitchen's rack and the finished units go onto it in the same
postMoves call, under locks taken over the ingredients and the finished item together.
Ingredients go against what was started and only the yield reaches the rack; a tray lost
consumes its ingredients and posts no yield move at all.

The board's statuses read the transition table the buttons are drawn from. Dispatched is
refused here — it mints a ticket, so it keeps its own endpoint — and a skipped stage is
refused by naming both stages rather than claiming the order is "already" the one it is on.

Replaces the in-memory makeProduct and setOrderStatus rules pinned by UI/src/__tests__:
C1's three cases, UA-14's five, and store.test.ts's "accepts an order and makes what it asks
for", all of which move to production.test.ts in the UI cutover.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 5: `tickets` — a ticket that was never collected, taken back

*(Wave 2, alongside Tasks 3 and 4. It owns `apps/api/src/modules/tickets/**`, `apps/api/src/lib/tickets.ts` and `packages/domain/src/{approval.ts,approval.test.ts,index.ts}`. Task 3 owns the snapshot module and `packages/contract`; Task 4 owns the production module. Nobody has touched `packages/domain/src/index.ts` since wave 1.)*

**Why this is in Phase 4.** Phase 3 built `releaseForTicket` and gave exactly one caller — `handover`. So an issued ticket that is never collected holds its stock for ever: the reservation stays open, free-to-promise at the store stays smaller than the shelf, the request behind it is frozen at `Ticket issued` with no transition out but `Collected`, and the only remedy is a hand-written `update`. Phase 4 is the first phase after the one that created the problem, and a make refuses on free-to-promise — so a stranded hold at the kitchen now stops the kitchen baking. It is fixed here.

**Files:**
- Modify: `apps/api/src/lib/tickets.ts`, `apps/api/src/modules/tickets/{repo,service,routes,tickets.test}.ts`, `packages/domain/src/{approval.ts,approval.test.ts,index.ts}`

**Interfaces:**
- Consumes: everything the module already imports, plus `CancelTicketBodySchema` and the widened `TktStatus` (Task 1), `REQUEST_TRANSITIONS`, `PROD_ORDER_TRANSITIONS`, `TICKET_TRANSITIONS`, `canTransition` from `@rch/domain`, `releaseForTicket` from `../../lib/reservations.js`, `appendHistory` from `../../lib/history.js`, `requireLocOf` from `../../plugins/rbac.js`, and `given.ticket`/`given.request`/`given.prodOrder` from `../../test/builders.js` in the test.
- Produces:
  ```ts
  // packages/domain/src/approval.ts
  export const approvedStatus: (lines: readonly { qty: number; appr: number }[]) => "Manager approved" | "Partially approved";

  // apps/api/src/lib/tickets.ts
  export async function voidTicket(tx: Tx, id: string, reason: string, by: string, at?: Date): Promise<number>;

  // apps/api/src/modules/tickets/repo.ts — added to ticketsRepo; `head` also returns `refType` now
  requestLines(tx: Tx, id: string): Promise<{ qty: number; appr: number }[]>;
  releaseRequest(tx: Tx, id: string, status: ReqStatus): Promise<void>;   // status + ticket_id = null
  linkedProdOrder(tx: Tx, id: string): Promise<{ id: string; status: PordStatus } | undefined>;  // for update
  setProdOrderStatus(tx: Tx, id: string, status: PordStatus): Promise<void>;

  // apps/api/src/modules/tickets/service.ts
  cancel(claims: AccessClaims, id: string, body: CancelTicketBody): Promise<WriteResponse<Ticket>>;
  export type CancelTicketBody = z.infer<typeof CancelTicketBodySchema>;
  ```
- `ticketsRepo.head` gains one selected column, `refType: tickets.refType`, and `LockedTicket` gains `refType: TicketRefType` (imported from `../../lib/tickets.js`). `handover` and `receive` ignore it; the cancellation needs it to know which document is behind the ticket, because a `PRD-` id looked up in `stock_requests` finds nothing and a missing row must not be confused with "there was never one".

**What "putting it back" means, per reference type:**

| `ref_type` | What is behind the ticket | What the cancellation does to it |
|---|---|---|
| `request` | a stock request at `Ticket issued` | back to `approvedStatus(lines)` — `Manager approved` when every line was approved in full, `Partially approved` otherwise — with `ticket_id` cleared, and its own history row. The issue desk can then raise a fresh ticket. |
| `prod_order` | a production order at `Dispatched` | back to `Ready`, with its own history row. The kitchen can dispatch it again. |
| `direct` | nothing (the label "Direct issue") | nothing. The hold is released and that is the whole of it. |
| `shop_transfer`, `shop_ask` | an outlet's own document | unreachable: both leave from an outlet, and `requireLocOf` admits only the store keeper at the store and the kitchen in-charge at the kitchen. Phase 6. |

**Rules (all sentences are new — the browser has no cancellation today — and Task 7 records each in spec §16):**

| Rule | Sentence |
|---|---|
| ticket exists, read `for update` | 404 `There is no ticket <id>.` |
| `requireLocOf(claims, t.from, "the location the ticket is issued from")` | 403, the existing wording |
| a reason was given | `Say why the ticket is being cancelled` |
| `canTransition(TICKET_TRANSITIONS, t.st, "Cancelled")` | already cancelled: `` `${id} is already cancelled` ``; otherwise `` `${id} has already been handed over — the stock is on its way to ${toName}` `` |
| the document behind it can take the step back | `` `${linked.id} is ${linked.status.toLowerCase()} — this ticket cannot be cancelled` `` |

`changed` is built from what actually moved: `["tkt", "rsv"]`, plus `"req"` when a request went back and `"pord"` when an order did. Naming a slice that did not change costs every open browser a refetch, which is the same reason a make does not name `"rsv"`. **`"stock"` is never named**: a cancellation moves nothing, because nothing had moved — that is the whole point of the movement rule.

**No balance locks, on purpose.** Every other reservation path locks the balance rows before reading them, because a promise made from an unlocked read is the same stock promised twice. A release is the opposite: it can only ever make free-to-promise *larger*, so a writer racing it either sees the hold or does not and is correct either way. What must not race is two cancellations of one ticket, and the ticket's own `for update` is what stops that — the second reads `Cancelled` and is refused.

- [ ] **Step 1: Write the failing domain test**

Append to `packages/domain/src/approval.test.ts`:
```ts
describe("approvedStatus", () => {
  it("is a full approval when every line got what it asked for", () => {
    expect(approvedStatus([{ qty: 10, appr: 10 }, { qty: 4, appr: 4 }])).toBe("Manager approved");
  });
  it("is a partial approval when any line was trimmed", () => {
    expect(approvedStatus([{ qty: 10, appr: 10 }, { qty: 4, appr: 1 }])).toBe("Partially approved");
  });
  it("is what planApproval itself decides, so a cancelled ticket puts a request back where it was", () => {
    const plan = planApproval([{ it: "milk", qty: 20 }], [20], () => 12);
    expect(plan.st).toBe(approvedStatus(plan.lines));
  });
});
```
with `approvedStatus` added to the file's import. Run: `pnpm --filter @rch/domain test` → FAIL.

- [ ] **Step 2: Write `approvedStatus`, and have `planApproval` use it**

`packages/domain/src/approval.ts`:
```ts
/**
 * Which approved status a set of decided lines amounts to. Written once because two callers
 * need the same answer: the approval that first reaches it, and a cancelled ticket putting the
 * request back where the manager left it.
 */
export const approvedStatus = (lines: readonly { qty: number; appr: number }[]): "Manager approved" | "Partially approved" =>
  lines.every((l) => l.appr === l.qty) ? "Manager approved" : "Partially approved";
```
and in `planApproval` replace the status expression with `const st = total === 0 ? "Rejected" : approvedStatus(out);`. Export it from `packages/domain/src/index.ts` by adding the name to the **existing** approval export line:
```ts
export { planApproval, approvedStatus, type ApprovalLine, type ApprovalPlan } from "./approval.js";
```
Run: `pnpm --filter @rch/domain test` → PASS.

- [ ] **Step 3: Write the failing module tests**

Append to `apps/api/src/modules/tickets/tickets.test.ts`, reusing that file's existing helpers — `app`, `hdr`, `post(user, url, payload?)`, `onHand(loc, it)`, `trail`, `requestById` — and its existing imports (`given`, `authHeaders`, `warmPool`, `truncateAll`, `documentHistory`, `reservations`, `stockMoves`, `and`, `eq`). **Read the top of the file first** and add only what is missing:
```ts
describe("POST /tickets/:id/cancel", () => {
  it("gives the stock back and puts the request where the manager left it", async () => {
    const req = await given.request(app.testDb!.db, {
      from: "coffee", lines: [{ it: "milk", qty: 20, appr: 20 }], st: "Manager approved",
    });
    const issued = await post("u3", `/requests/${req}/issue-ticket`);
    const tkt = issued.json().result.ticket.id;
    const heldBefore = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, tkt));
    expect(heldBefore.every((h) => h.releasedAt === null)).toBe(true);
    const onShelf = await onHand("store", "milk");
    const movesBefore = (await app.testDb!.db.select().from(stockMoves)).length;

    const r = await post("u3", `/tickets/${tkt}/cancel`, { reason: "The counter closed before the collector came" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ id: tkt, st: "Cancelled" });
    expect(b.changed).toEqual(["tkt", "rsv", "req"]);
    expect(b.message).toBe(`${tkt} cancelled — ${req} is approved again and can be issued a new ticket`);

    // The hold is gone and the shelf never moved: nothing had left it.
    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, tkt));
    expect(held.every((h) => h.releasedAt !== null)).toBe(true);
    expect(await onHand("store", "milk")).toBe(onShelf);
    expect((await app.testDb!.db.select().from(stockMoves)).length).toBe(movesBefore);

    // The reason is the only record there is, so it has to be findable.
    const hist = await readHistory(app.testDb!.db, "ticket", tkt);
    expect(hist.at(-1)).toMatchObject({ s: "Cancelled — The counter closed before the collector came", who: "Suresh Muthu" });
  });

  it("lets the issue desk raise a fresh ticket afterwards", async () => {
    const req = await given.request(app.testDb!.db, {
      from: "coffee", lines: [{ it: "milk", qty: 20, appr: 20 }], st: "Manager approved",
    });
    const first = (await post("u3", `/requests/${req}/issue-ticket`)).json().result.ticket.id;
    await post("u3", `/tickets/${first}/cancel`, { reason: "Wrong outlet" });

    const second = await post("u3", `/requests/${req}/issue-ticket`);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().result.ticket.id).not.toBe(first);
  });

  it("remembers that the approval was only partial", async () => {
    const req = await given.request(app.testDb!.db, {
      from: "coffee", lines: [{ it: "milk", qty: 20, appr: 12 }], st: "Partially approved",
    });
    const tkt = (await post("u3", `/requests/${req}/issue-ticket`)).json().result.ticket.id;
    await post("u3", `/tickets/${tkt}/cancel`, { reason: "Collector never came" });

    const list = (await app.inject({ method: "GET", url: "/api/v1/requests", headers: await authHeaders(app, "u2") })).json();
    expect(list.find((r: { id: string }) => r.id === req)).toMatchObject({ st: "Partially approved", ticket: null });
  });

  it("puts a dispatched order back on the board", async () => {
    const id = await given.prodOrder(app.testDb!.db, { st: "Ready", lines: [{ it: "puff", qty: 5 }] });
    await bake("puff", 5);
    const tkt = (await post("u4", `/prod-orders/${id}/dispatch`)).json().result.ticket.id;

    const r = await post("u4", `/tickets/${tkt}/cancel`, { reason: "Kiosk shut early" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().changed).toEqual(["tkt", "rsv", "pord"]);
    expect(r.json().message).toBe(`${tkt} cancelled — ${id} is back on the board, ready to dispatch again`);

    const board = (await app.inject({ method: "GET", url: "/api/v1/prod-orders", headers: await authHeaders(app, "u4") })).json();
    expect(board.find((o: { id: string }) => o.id === id).st).toBe("Ready");
    // And it can go out again.
    expect((await post("u4", `/prod-orders/${id}/dispatch`)).statusCode).toBe(200);
  });

  it("takes back a direct issue with nothing behind it", async () => {
    await bake("puff", 10);
    const tkt = (await post("u4", "/distributions", { it: "puff", qty: 5, to: "kiosk" })).json().result.id;
    const r = await post("u4", `/tickets/${tkt}/cancel`, { reason: "Sent to the wrong counter" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().changed).toEqual(["tkt", "rsv"]);
    expect(r.json().message).toBe(`${tkt} cancelled — the stock is free again at Central Kitchen`);
  });

  it("refuses a ticket already handed over, and one already cancelled", async () => {
    const tkt = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }] });
    const otp = (await app.testDb!.db.select().from(tickets).where(eq(tickets.id, tkt)))[0]!.otp;
    await post("u3", `/tickets/${tkt}/handover`, { otp });
    const gone = await post("u3", `/tickets/${tkt}/cancel`, { reason: "Changed our minds" });
    expect(gone.statusCode).toBe(422);
    expect(gone.json().error.message).toBe(`${tkt} has already been handed over — the stock is on its way to Floor 3 Coffee Bar`);

    const other = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }] });
    expect((await post("u3", `/tickets/${other}/cancel`, { reason: "Not needed" })).statusCode).toBe(200);
    const again = await post("u3", `/tickets/${other}/cancel`, { reason: "Not needed" });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe(`${other} is already cancelled`);
  });

  it("refuses a cancellation with nothing said about it", async () => {
    const tkt = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }] });
    const r = await post("u3", `/tickets/${tkt}/cancel`, { reason: "   " });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Say why the ticket is being cancelled");
  });

  it("keeps each side to its own tickets", async () => {
    const store = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }] });
    const kitchen = await given.ticket(app.testDb!.db, { from: "kitchen", to: "kiosk", lines: [{ it: "puff", qty: 2 }] });
    // The kitchen may not cancel the store's ticket, nor the store the kitchen's.
    expect((await post("u4", `/tickets/${store}/cancel`, { reason: "no" })).statusCode).toBe(403);
    expect((await post("u3", `/tickets/${kitchen}/cancel`, { reason: "no" })).statusCode).toBe(403);
    // And nobody else has the door at all.
    for (const u of ["u1", "u2", "u5"]) expect((await post(u, `/tickets/${store}/cancel`, { reason: "no" })).statusCode).toBe(404);
  });

  it("404s a ticket that is not there", async () => {
    expect((await post("u3", "/tickets/TKT-9999/cancel", { reason: "no" })).json().error.message).toBe("There is no ticket TKT-9999.");
  });

  it("cancels once when two windows press together", async () => {
    const tkt = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }] });
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u3", `/tickets/${tkt}/cancel`, { reason: "Not needed" }),
      post("u3", `/tickets/${tkt}/cancel`, { reason: "Not needed" }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, tkt));
    expect(held.every((h) => h.releasedAt !== null)).toBe(true);
  });
});
```
**One read this suite uses is Task 3's.** `GET /prod-orders` lands in the same wave, so if it 404s in your worktree the board assertion reads the snapshot instead — `(await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, "u4") })).json().pord` — which has carried production orders since Phase 1. Change that one line and nothing else; the controller's merge brings the route.

The kitchen cases need a `bake` helper — the same one `production.test.ts` uses; if `tickets.test.ts` has none, add it beside the other helpers at the top of the file:
```ts
/** Bake enough of an item that the kitchen can cover a dispatch. */
const bake = (it: string, n: number) =>
  app.testDb!.db.transaction((tx) => postMoves(tx, [{ loc: "kitchen", it, qty: n, kind: "production_yield", refType: "test", refId: "bake" }]));
```
and import the three names the file does not already have: `readHistory` from `../../lib/history.js`, `postMoves` from `../../lib/ledger.js`, and `tickets` added to the existing `../../db/schema/index.js` import (which already brings `documentHistory`, `reservations` and `stockMoves`).

Run: `pnpm --filter @rch/api test src/modules/tickets` → FAIL (404 on the cancel URL).

- [ ] **Step 4: Write `voidTicket`**

`apps/api/src/lib/tickets.ts`, after `writeTicket`:
```ts
/**
 * Put a ticket back. The hold it placed is released and the stock is free again exactly where
 * it stands — nothing moves, because nothing ever moved: a ticket that has not been handed
 * over is a promise, and this is the promise being withdrawn.
 *
 * The reason is written to `document_history` because the ticket's row has nowhere to put it.
 * That makes a cancellation the second thing a ticket records there, after the supervisor
 * override (spec §16, Phase 3) — and for the same reason: an action that cannot be read back
 * afterwards cannot be audited. `by` is the operator's display name, as `appendHistory` wants.
 *
 * The caller has already locked the ticket's row and checked the transition; this is the write.
 * Returns how many open holds were released, so a caller can tell a first cancellation from a
 * replay.
 */
export async function voidTicket(tx: Tx, id: string, reason: string, by: string, at: Date = new Date()): Promise<number> {
  const released = await releaseForTicket(tx, id, at);
  await tx.update(tickets).set({ status: "Cancelled" }).where(eq(tickets.id, id));
  await appendHistory(tx, "ticket", id, `Cancelled — ${reason}`, by, at);
  return released;
}
```
with `releaseForTicket` added to the file's `./reservations.js` import and `appendHistory` imported from `./history.js`.

- [ ] **Step 5: Write the repo methods**

`apps/api/src/modules/tickets/repo.ts` — add `refType: tickets.refType` to `head`'s select list, add `refType: TicketRefType` to `LockedTicket` (importing the type from `../../lib/tickets.js`), and add:
```ts
  /** The decided lines of the request behind a ticket, for `approvedStatus`. */
  async requestLines(tx: Tx, id: string): Promise<{ qty: number; appr: number }[]> {
    const rows = await tx.select({ qty: stockRequestLines.qty, appr: stockRequestLines.approvedQty })
      .from(stockRequestLines).where(eq(stockRequestLines.requestId, id)).orderBy(asc(stockRequestLines.lineNo));
    return rows;
  },

  /** Back to an approved status with no ticket against it, so the issue desk can raise another.
   *  Separate from `setRequestStatus` because clearing `ticket_id` is exactly what makes this
   *  different from every other status write on a request. */
  async releaseRequest(tx: Tx, id: string, status: ReqStatus): Promise<void> {
    await tx.update(stockRequests).set({ status, ticketId: null, updatedAt: new Date() }).where(eq(stockRequests.id, id));
  },

  /** The production order behind a dispatch ticket, locked like every other document a write
   *  moves. Only called when the ticket's ref_type says there is one. */
  async linkedProdOrder(tx: Tx, id: string): Promise<{ id: string; status: PordStatus } | undefined> {
    const [o] = await tx.select({ id: prodOrders.id, status: prodOrders.status })
      .from(prodOrders).where(eq(prodOrders.id, id)).for("update");
    return o;
  },

  async setProdOrderStatus(tx: Tx, id: string, status: PordStatus): Promise<void> {
    await tx.update(prodOrders).set({ status, updatedAt: new Date() }).where(eq(prodOrders.id, id));
  },
```
with `PordStatus` added to the `@rch/contract` type import and `prodOrders`, `stockRequestLines` to the schema import.

- [ ] **Step 6: Write `cancel`**

Into the object `createTicketsService` returns, after `receive`:
```ts
    /**
     * A ticket withdrawn before anyone collected against it.
     *
     * Phase 3 gave `releaseForTicket` one caller — the handover — so a ticket nobody came for
     * held its stock for ever: free-to-promise stayed smaller than the shelf and the request
     * behind it had nowhere to go. This is the way back. Nothing moves, because nothing had
     * moved; what changes is that the promise is withdrawn and the document behind the ticket
     * goes back to where it was before the ticket was raised.
     *
     * No balance locks: a release only ever makes free-to-promise larger, so a writer racing it
     * is right either way. What must not race is two cancellations of one ticket, and the
     * ticket's own `for update` above is what stops that.
     */
    async cancel(claims: AccessClaims, id: string, body: CancelTicketBody): Promise<WriteResponse<Ticket>> {
      return withTransaction(db, async (tx) => {
        const t = await ticketsRepo.head(tx, id);
        if (!t) throw new NotFoundError(`There is no ticket ${id}.`);
        requireLocOf(claims, t.from, "the location the ticket is issued from");
        const reason = body.reason.trim();
        assertRule(reason.length > 0, "Say why the ticket is being cancelled");

        const locations = await loadLocations(tx);
        const fromName = locations[t.from]?.n ?? t.from;
        const toName = locations[t.to]?.n ?? t.to;
        assertRule(
          canTransition(TICKET_TRANSITIONS, t.st, "Cancelled"),
          t.st === "Cancelled"
            ? `${id} is already cancelled`
            : `${id} has already been handed over — the stock is on its way to ${toName}`,
        );

        // Documents before ids before balances, and this write needs no id and no balance: the
        // ticket's row is locked above and the document behind it right here.
        const at = new Date();
        const request = t.refType === "request" ? await ticketsRepo.linkedRequest(tx, t.req) : undefined;
        const order = t.refType === "prod_order" ? await ticketsRepo.linkedProdOrder(tx, t.req) : undefined;

        const who = await ticketsRepo.userName(tx, claims.sub);
        await voidTicket(tx, id, reason, who, at);

        const changed: Changed[] = ["tkt", "rsv"];
        let tail = `the stock is free again at ${fromName}`;
        if (request) {
          // The store's pick is not the manager's decision. Back to whatever the approval
          // amounted to, with the ticket reference cleared so a fresh one can be issued.
          const back = approvedStatus(await ticketsRepo.requestLines(tx, request.id));
          assertRule(canTransition(REQUEST_TRANSITIONS, request.status, back), `${request.id} is ${request.status.toLowerCase()} — this ticket cannot be cancelled`);
          await ticketsRepo.releaseRequest(tx, request.id, back);
          await appendHistory(tx, "request", request.id, back, who, at);
          changed.push("req");
          tail = `${request.id} is approved again and can be issued a new ticket`;
        }
        if (order) {
          // Same principle for the kitchen: the order was not delivered, so the board must not
          // keep saying it was. `Dispatched -> Ready` exists in the table for this and nothing else.
          assertRule(canTransition(PROD_ORDER_TRANSITIONS, order.status, "Ready"), `${order.id} is ${order.status.toLowerCase()} — this ticket cannot be cancelled`);
          await ticketsRepo.setProdOrderStatus(tx, order.id, "Ready");
          await appendHistory(tx, "prod_order", order.id, "Ready", who, at);
          changed.push("pord");
          tail = `${order.id} is back on the board, ready to dispatch again`;
        }

        await emitChanged(tx, changed);
        return { result: await reread(tx, id), changed, message: `${id} cancelled — ${tail}` };
      });
    },
```
with `approvedStatus`, `PROD_ORDER_TRANSITIONS` added to the `@rch/domain` import, `Changed` and `CancelTicketBodySchema` to the `@rch/contract` type import, `voidTicket` to the `../../lib/tickets.js` import, and `export type CancelTicketBody = z.infer<typeof CancelTicketBodySchema>;` beside the other body types.

- [ ] **Step 7: Mount it**

`apps/api/src/modules/tickets/routes.ts`, beside the existing mounts:
```ts
  // Scoped by the ticket's own `from`, in the service: the store cancels what the store issued
  // and the kitchen what the kitchen dispatched.
  mount(app, routes.cancelTicket, async (req) => svc.cancel(req.user, req.params.id, req.body));
```

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @rch/api test src/modules/tickets` → PASS. Prove the race case before keeping it: with `.for("update")` commented out of `ticketsRepo.head`, both cancellations must succeed.
Then `pnpm turbo typecheck test && pnpm lint`.

- [ ] **Step 9: Commit**

```bash
git add packages/domain apps/api/src/lib/tickets.ts apps/api/src/modules/tickets
git commit -m "$(cat <<'EOF'
Let a ticket nobody collected be taken back

Phase 3 gave releaseForTicket exactly one caller, the handover — so a ticket nobody came for
held its stock for ever: free to promise stayed smaller than the shelf, the request behind it
was frozen at Ticket issued with no way out but Collected, and the only remedy was an UPDATE
typed by hand. It matters more now that a make refuses on free to promise, because a stranded
hold at the kitchen stops the kitchen baking.

Nothing moves, because nothing had moved. The hold is released, the reason is written to the
document history where a ticket's only other prose already lives, and the document behind the
ticket goes back: a request to whatever its lines amount to with its ticket reference cleared,
a production order to Ready. Which status a request goes back to is approvedStatus, now shared
with planApproval rather than restated.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 6: UI cutover — the kitchen's screens call the server, and a ticket can be taken back

*(Wave 3, alone. It owns every file under `UI/src/` that Phase 4 touches. Nothing else is in flight.)*

**Files:**
- Modify: `UI/src/store/index.ts`, `UI/src/api/refetch.ts`, `UI/src/api/wire.ts`, `UI/src/lib/selectors.ts`, `UI/src/roles/prod/{MakeDistribute,Orders,OrderDrawer,Tickets}.tsx`, `UI/src/roles/store/TicketDrawer.tsx`, `UI/src/roles/counter/{Tickets,TicketDrawer}.tsx`, `UI/src/__tests__/{fixture.ts,writes.test.ts,store.test.ts,fixes.test.ts}`

**Interfaces:**
- Consumes: `routes.setOrderStatus`, `routes.makeBatch`, `routes.cancelTicket`, `routes.prodOrders`, `routes.batches` (Tasks 1 and 3); `call`, `ApiError` from `../api/client`; `refetch` from `../api/refetch`; `canTransition`, `PROD_ORDER_TRANSITIONS`, `TICKET_TRANSITIONS` from `@rch/domain` (via `selectors.ts`'s `D` namespace import).
- Produces:
  ```ts
  // UI/src/store/index.ts — two action types change, one is new
  setOrderStatus: (id: string, st: PordStatus) => Promise<void>;
  makeProduct: (it: string, started: number, made?: number, note?: string) => Promise<boolean>;
  cancelTicket: (id: string, reason: string) => Promise<boolean>;

  // UI/src/lib/selectors.ts
  export const canMoveOrder: (st: PordStatus, to: PordStatus) => boolean;
  export const canCancelTicket: (st: TktStatus) => boolean;

  // UI/src/api/wire.ts
  export function applyProdOrders(pord: Snapshot["pord"]): void;
  export function applyBatches(batch: Snapshot["batch"]): void;
  ```

**Which actions carry a form, and what that means.** Phase 3's fix round settled the rule: an action that a screen resets a form for answers `Promise<boolean>` and the screen awaits it behind a busy lock, so a refusal lands on the operator's own typing rather than on an empty box. `makeProduct` is that shape — the Make tile clears three inputs — and so is `cancelTicket`, which clears a reason. `setOrderStatus` is not: it is a button on a card, like `handover` and `dispatchOrder`, and returns `Promise<void>` with no lock, exactly as they do.

**Which rules are deleted.** All of them. `makeProduct`'s five refusals, its recipe arithmetic, its batch id and its best-before are the server's; `setOrderStatus`'s history stamping is the server's. What stays in the browser is the *preview*: `MakeDistribute`'s `ceiling(k)` still greys the Make button when the rack cannot cover a unit, and `Orders`/`OrderDrawer` still disable Dispatch when an item is short — previews computed with the same `@rch/domain` functions the server enforces with (spec §5.1).

- [ ] **Step 1: Write the failing wire tests**

Append to `UI/src/__tests__/writes.test.ts` (reuse its `serve`, `json`, `refusal`, `hit`, `calls`, `STOCK` and `snapshot` helpers exactly as they are):
```ts
const ORDER = { ...FX.seedPord[0], st: "Accepted", hist: [...FX.seedPord[0].hist, { s: "Accepted", who: "Vinoth Prakash", t: "07:41" }] };
const BATCH = {
  id: "BAT-20260904-01", it: "puff", qty: 60, made: 58,
  at: "2026-09-04T01:10:00.000Z", bb: "2026-09-04T13:10:00.000Z", note: "Oven tray dropped",
};

describe("setOrderStatus — POST /prod-orders/:id/status", () => {
  it("names the status in the body and pulls the board back", async () => {
    as("prod");
    serve({
      [`POST /api/v1/prod-orders/${ORDER.id}/status`]: () => json({ result: ORDER, changed: ["pord"], message: `${ORDER.id} — accepted` }),
      "GET /api/v1/prod-orders": () => json([ORDER]),
    });

    await S().setOrderStatus(ORDER.id, "Accepted");

    expect(hit(`POST /api/v1/prod-orders/${ORDER.id}/status`)[0].body).toEqual({ st: "Accepted" });
    expect(hit("GET /api/v1/prod-orders")).toHaveLength(1);
    expect(S().pord.find((o) => o.id === ORDER.id)!.st).toBe("Accepted");
    expect(S().toast).toBe(`${ORDER.id} — accepted`);
  });

  it("keeps a refusal's words and leaves the board where it was", async () => {
    as("prod");
    const before = S().pord.find((o) => o.id === ORDER.id)!.st;
    serve({ [`POST /api/v1/prod-orders/${ORDER.id}/status`]: () => refusal(`${ORDER.id} is new — it cannot go straight to ready`) });

    await S().setOrderStatus(ORDER.id, "Ready");

    expect(S().toast).toBe(`${ORDER.id} is new — it cannot go straight to ready`);
    expect(S().pord.find((o) => o.id === ORDER.id)!.st).toBe(before);
  });
});

describe("makeProduct — POST /batches", () => {
  it("sends what was started and what came good, and reads the batch log and stock back", async () => {
    as("prod");
    serve({
      "POST /api/v1/batches": () => json({ result: BATCH, changed: ["batch", "stock"], message: "BAT-20260904-01 — 58 of 60 Veg puffs yielded (-3.3%), best before 18:40" }),
      "GET /api/v1/batches": () => json([BATCH]),
      "GET /api/v1/stock": () => json(STOCK),
    });

    expect(await S().makeProduct("puff", 60, 58, "Oven tray dropped")).toBe(true);

    expect(hit("POST /api/v1/batches")[0].body).toEqual({ it: "puff", started: 60, made: 58, note: "Oven tray dropped" });
    expect(hit("GET /api/v1/batches")).toHaveLength(1);
    expect(hit("GET /api/v1/stock")).toHaveLength(1);
    expect(S().batch[0].id).toBe("BAT-20260904-01");
    // The wire's instant, in the kitchen's words.
    expect(S().batch[0].bb).toMatch(/^\d{2}:\d{2}/);
    expect(S().toast).toMatch(/yielded/);
  });

  it("leaves the blank boxes out of the body", async () => {
    as("prod");
    serve({
      "POST /api/v1/batches": () => json({ result: { ...BATCH, qty: 10, made: 10, note: undefined }, changed: ["batch", "stock"], message: "BAT-20260904-01 — 10 Veg puffs made, best before 18:40" }),
      "GET /api/v1/batches": () => json([]),
      "GET /api/v1/stock": () => json(STOCK),
    });

    await S().makeProduct("puff", 10);

    expect(hit("POST /api/v1/batches")[0].body).toEqual({ it: "puff", started: 10 });
  });

  it("answers false on a refusal, so the tile can keep what was typed", async () => {
    as("prod");
    const before = S().batch.length;
    serve({ "POST /api/v1/batches": () => refusal("Kitchen is short of Veg filling mix — 1.200 kg left") });

    expect(await S().makeProduct("puff", 200)).toBe(false);

    expect(S().toast).toBe("Kitchen is short of Veg filling mix — 1.200 kg left");
    expect(S().batch).toHaveLength(before);
  });
});

describe("cancelTicket — POST /tickets/:id/cancel", () => {
  const TKT = { ...FX.seedTkt[0], st: "Cancelled" };

  it("sends the reason and pulls the tickets, the holds and the request back", async () => {
    as("store");
    serve({
      [`POST /api/v1/tickets/${TKT.id}/cancel`]: () => json({ result: TKT, changed: ["tkt", "rsv", "req"], message: `${TKT.id} cancelled — ${TKT.req} is approved again and can be issued a new ticket` }),
      "GET /api/v1/tickets": () => json([TKT]),
      "GET /api/v1/stock": () => json(STOCK),
      "GET /api/v1/requests": () => json([]),
    });

    expect(await S().cancelTicket(TKT.id, "The counter closed before the collector came")).toBe(true);

    expect(hit(`POST /api/v1/tickets/${TKT.id}/cancel`)[0].body).toEqual({ reason: "The counter closed before the collector came" });
    expect(S().tkt.find((t) => t.id === TKT.id)!.st).toBe("Cancelled");
    expect(S().toast).toMatch(/cancelled/);
  });

  it("answers false on a refusal, so the drawer can keep the reason", async () => {
    as("store");
    serve({ [`POST /api/v1/tickets/${TKT.id}/cancel`]: () => refusal(`${TKT.id} has already been handed over — the stock is on its way to Floor 3 Coffee Bar`) });

    expect(await S().cancelTicket(TKT.id, "Changed our minds")).toBe(false);

    expect(S().toast).toBe(`${TKT.id} has already been handed over — the stock is on its way to Floor 3 Coffee Bar`);
  });
});
```
Run: `pnpm --filter @rch/ui test src/__tests__/writes.test.ts` → FAIL (the store still writes locally, and `cancelTicket` does not exist).

- [ ] **Step 2: Give the two collections narrow readers**

`UI/src/api/wire.ts`, after `applyShopAsks`:
```ts
/** GET /prod-orders -> the kitchen's board, times as "HH:MM" and history stamps with them. */
export function applyProdOrders(pord: Snapshot["pord"]): void {
  useApp.setState({ pord: pord.map((o) => ({ ...o, at: t(o.at), hist: hist(o.hist) })) });
}

/** GET /batches -> the batch log. `bb` is an instant on the wire and a best-before on screen. */
export function applyBatches(batch: Snapshot["batch"]): void {
  useApp.setState({ batch: batch.map((b) => ({ ...b, at: t(b.at), bb: fromWireBestBefore(b.bb) })) });
}
```
(`fromWireBestBefore` is already imported by this file.)

`UI/src/api/refetch.ts` — two entries in `NARROW`, and the doc comment's list extended:
```ts
  pord: () => call(routes.prodOrders).then(applyProdOrders),
  batch: () => call(routes.batches).then(applyBatches),
```
with `applyBatches, applyProdOrders` added to the `./wire` import. This also stops `dispatchOrder` — which names `["pord", "tkt", "rsv"]` — from pulling a whole snapshot back.

- [ ] **Step 3: Cut the two actions over**

`UI/src/store/index.ts`:

Types (lines 94–96 today), and one new line beside `receiveTicket`:
```ts
  setOrderStatus: (id: string, st: PordStatus) => Promise<void>;
  dispatchOrder: (id: string) => Promise<void>;
  /** Answers `true` only once the batch is on the server, so the tile can keep the kitchen's
   *  typing in front of them when it is refused. */
  makeProduct: (it: string, started: number, made?: number, note?: string) => Promise<boolean>;

  /** Withdraw a ticket nobody collected: the hold goes back and so does the document behind it.
   *  Answers `true` only once the server has taken it, so the drawer can keep the reason. */
  cancelTicket: (tktId: string, reason: string) => Promise<boolean>;
```

`setOrderStatus`, replacing the whole local body:
```ts
  /** One press on the board (POST /prod-orders/:id/status); the transition table is the
   *  server's to enforce and `canMoveOrder` is what decides which button was drawn. */
  setOrderStatus: async (id, st) => {
    try {
      const r = await call(routes.setOrderStatus, { params: { id }, body: { st } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not move the order on — check the connection and try again.");
    }
  },
```

`makeProduct`, replacing the whole local body (all 38 lines of it):
```ts
  /**
   * A batch (POST /batches). Every rule that used to live here is the server's: the quantity,
   * the yield, the kitchen's switch, the recipe, and whether the rack can cover it. The
   * ingredients come off and the finished units go on inside one transaction there (C1), so
   * there is nothing left to do here but ask and report.
   */
  makeProduct: async (it, started, made, note) => {
    try {
      const r = await call(routes.makeBatch, {
        body: { it, started, ...(made == null ? {} : { made }), ...(note ? { note } : {}) },
      });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not record the batch — check the connection and try again.");
      return false;
    }
  },
```

`cancelTicket`, new, beside `receiveTicket`:
```ts
  /** A ticket withdrawn before anyone collected against it (POST /tickets/:id/cancel). The
   *  hold comes back and so does the document behind it; nothing moves, because nothing had. */
  cancelTicket: async (tktId, reason) => {
    try {
      const r = await call(routes.cancelTicket, { params: { id: tktId }, body: { reason } });
      set({ drawer: null });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not cancel the ticket — check the connection and try again.");
      return false;
    }
  },
```

Then the imports the deleted `makeProduct` body leaves behind — `noUnusedLocals` will name each of these if you miss one:
- line 8 becomes `import { LOC, MENU } from "../data/master";` (`IT` and `RCP` were used only by `makeProduct`)
- line 18 becomes `import { basePrices } from "../lib/selectors";` (`qty` and `resv` likewise)
- line 19 becomes `import { now } from "../lib/fmt";` (`fq` and `U` likewise)
- drop the `bestBeforeAt, bestBeforeText` import Task 2 added — the server stamps the best-before now

And the sequence counters. `Seq` has carried three dead fields since Phase 3: `req` and `pord` were never read, and `bat` dies with this task. Only the procurement counters are still live, and Phase 5 takes those:
```ts
interface Seq { prq: number; po: number; vn: number }
```
with the initial state on line 130 becoming `seq: { prq: 15, po: 142, vn: 5 },` and the same edit in `UI/src/__tests__/fixture.ts`'s `resetStore`.

- [ ] **Step 4: Draw the board's buttons from the table**

`UI/src/lib/selectors.ts`, beside `canDispatch`:
```ts
/**
 * Whether the board may move an order from one word to another — the same table the server
 * refuses through, so a button the kitchen can see is a press the server will take.
 *
 * A dispatched order is excluded as a *source* even though the table has `Dispatched -> Ready`:
 * that edge exists so cancelling the ticket a dispatch raised can put the order back, and it is
 * not a button. `modules/production/service.ts` keeps the same guard on its side.
 */
export const canMoveOrder = (st: PordStatus, to: PordStatus) =>
  st !== "Dispatched" && D.canTransition(D.PROD_ORDER_TRANSITIONS, st, to);

/** Whether a ticket can still be withdrawn: only one nobody has collected against. */
export const canCancelTicket = (st: TktStatus) => D.canTransition(D.TICKET_TRANSITIONS, st, "Cancelled");
```

`UI/src/roles/prod/Orders.tsx` — `advance()` and the Decline button stop testing status literals:
```ts
  const advance = (o: ProdOrder) => {
    if (canMoveOrder(o.st, "Accepted")) return <Btn size="xs" onClick={() => setOrderStatus(o.id, "Accepted")}>Accept</Btn>;
    if (canMoveOrder(o.st, "In kitchen")) return <Btn size="xs" onClick={() => setOrderStatus(o.id, "In kitchen")}>Start making</Btn>;
    if (canMoveOrder(o.st, "Ready")) return <Btn size="xs" onClick={() => setOrderStatus(o.id, "Ready")}>Mark ready</Btn>;
    if (canDispatch(o.st)) {
```
(the Dispatch branch below is unchanged), and in the card's foot:
```tsx
          {canMoveOrder(o.st, "Declined") && <Btn size="xs" variant="dg" onClick={() => setOrderStatus(o.id, "Declined")}>Decline</Btn>}
```
with `canMoveOrder` added to the `../../lib/selectors` import. The chain of `if`s is ordered so the board behaves exactly as it does today: a New order offers Accept (and Decline), an Accepted one offers Start making, an In kitchen one offers Mark ready, and everything still open offers Dispatch.

`UI/src/roles/prod/OrderDrawer.tsx` — the same edit in `foot`:
```tsx
      {canMoveOrder(o.st, "Accepted") && <>
        <Btn variant="dg" onClick={() => setOrderStatus(o.id, "Declined")}>Decline</Btn>
        <Btn onClick={() => setOrderStatus(o.id, "Accepted")}>Accept order</Btn>
      </>}
      {canMoveOrder(o.st, "In kitchen") && <Btn onClick={() => setOrderStatus(o.id, "In kitchen")}>Start making</Btn>}
      {canMoveOrder(o.st, "Ready") && <Btn onClick={() => setOrderStatus(o.id, "Ready")}>Mark ready</Btn>}
```
with `canMoveOrder` added to its `../../lib/selectors` import. Decline stays paired with Accept, because the two are one decision made at one moment and `New` is the only status that offers either.

- [ ] **Step 5: Hold the kitchen's typing until the batch has landed**

`UI/src/roles/prod/MakeDistribute.tsx`:
```ts
  const [making, setMaking] = useState<Record<string, boolean>>({});

  // The quantity, the yield and the reason stay in the boxes until the batch is on the server.
  const make = async (k: string) => {
    const started = Number(mk[k]) || 0;
    const got = yld[k] === "" || yld[k] == null ? undefined : Number(yld[k]);
    setMaking((m) => ({ ...m, [k]: true }));
    const ok = await makeProduct(k, started, got, why[k]?.trim() || undefined);
    setMaking((m) => ({ ...m, [k]: false }));
    if (!ok) return;
    setMk((m) => ({ ...m, [k]: "" }));
    setYld((y) => ({ ...y, [k]: "" }));
    setWhy((w) => ({ ...w, [k]: "" }));
  };
```
and the tile's button:
```tsx
                  <Btn size="sm" wide
                    disabled={off || max <= 0 || (got != null && got > want) || Boolean(making[k])}
                    onClick={() => make(k)}>
                    {making[k] ? "Making…" : off ? "Switched off" : max <= 0 ? "No ingredients"
                      : got != null && got > want ? "Yield exceeds started" : "Make"}
                  </Btn>
```
Nothing else on that screen changes: `ceiling(k)` stays as the preview it always was, and the "Made today" table already renders whatever `batch` holds.

- [ ] **Step 6: Put a Cancel control where a stranded ticket is looked at**

Four screens, and the pattern is the same one the store's drawer already uses for the supervisor override: a control that reveals a small confirm rather than acting on the first click, because a cancellation cannot be undone.

`UI/src/roles/store/TicketDrawer.tsx` — beside the override block in `foot`, and only while the ticket is still at the window:
```tsx
  const cancelTicket = useApp((s) => s.cancelTicket);
  const [why, setWhy] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const withdraw = async () => {
    setBusy(true);
    const ok = await cancelTicket(t.id, why.trim());
    setBusy(false);
    if (ok) setWhy("");
  };
```
and, inside the body under the override section:
```tsx
      {canCancelTicket(t.st) && (
        <Section title="Cancel this ticket" sub="Nobody collected against it, and the stock should go back">
          {cancelling ? (
            <>
              <Field label="Reason" hint="Written to the ticket's history — it is the only record of the cancellation.">
                <input
                  placeholder="Counter closed, wrong outlet…"
                  aria-label={`Why ${t.id} is being cancelled`}
                  value={why}
                  onChange={(e) => setWhy(e.target.value)}
                />
              </Field>
              <Btn size="xs" variant="dg" disabled={!why.trim() || busy} onClick={withdraw}>
                {busy ? "Cancelling…" : "Confirm cancellation"}
              </Btn>{" "}
              <Btn size="xs" variant="gh" onClick={() => setCancelling(false)}>Keep the ticket</Btn>
            </>
          ) : (
            <Btn size="xs" variant="gh" onClick={() => setCancelling(true)}>Cancel ticket</Btn>
          )}
        </Section>
      )}
```
with `Section` added to the `../../ui/kit` import and `canCancelTicket` to the `../../lib/selectors` import. The store action closes the drawer on success, so nothing here has to.

`UI/src/roles/prod/Tickets.tsx` — the kitchen looks at its own tickets in a table, so the confirm lives in the row's action cell. Beside the existing `handover` hook add `cancelTicket`, and one piece of state for which row is open:
```tsx
  const cancelTicket = useApp((x) => x.cancelTicket);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const withdraw = async (id: string) => {
    setBusy(true);
    const ok = await cancelTicket(id, why.trim());
    setBusy(false);
    if (ok) { setCancelId(null); setWhy(""); }
  };
```
and in the out-table's action cell, after the "Hand over" button:
```tsx
                    {cancelId === t.id ? (
                      <>
                        <input
                          placeholder="Why is it being cancelled?"
                          aria-label={`Why ${t.id} is being cancelled`}
                          value={why}
                          onChange={(e) => setWhy(e.target.value)}
                        />
                        <Btn size="xs" variant="dg" disabled={!why.trim() || busy} onClick={() => withdraw(t.id)}>
                          {busy ? "Cancelling…" : "Confirm"}
                        </Btn>
                        <Btn size="xs" variant="gh" onClick={() => { setCancelId(null); setWhy(""); }}>Keep</Btn>
                      </>
                    ) : (
                      canCancelTicket(t.st) && <Btn size="xs" variant="gh" onClick={() => { setCancelId(t.id); setWhy(""); }}>Cancel</Btn>
                    )}
```
with `canCancelTicket` added to that file's `../../lib/selectors` import.

`UI/src/roles/counter/Tickets.tsx` — a counter cannot cancel anything, but a ticket addressed to them can be cancelled at the other end, so the status filter has to be able to name it:
```ts
const STATUSES: TktStatus[] = ["Issued", "Collected", "Received", "Cancelled"];
```

`UI/src/roles/counter/TicketDrawer.tsx` — the drawer walks a ticket through `ORDER: TktStatus[] = ["Issued", "Collected", "Received"]`, and a cancelled ticket matches no step, so the stepper would sit at nothing with no explanation. Above the stepper:
```tsx
      {t.st === "Cancelled" && (
        <Alert tone="w" label="CANCELLED">
          This ticket was withdrawn before it was collected — nothing was sent. Raise a new request
          if the stock is still needed.
        </Alert>
      )}
```
and render the stepper only when it is not (`{t.st !== "Cancelled" && ( … )}`), with `Alert` added to the kit import if it is not there already. `ORDER` and `STEPS` are unchanged: a cancellation is not a step on the way to anywhere.

- [ ] **Step 7: Move the rule tests to the server, and say where they went**

`UI/src/__tests__/fixes.test.ts` — replace the whole `C1 · production consumes its ingredients` describe block with a pointer in the shape C2 already uses:
```ts
/* ---------------------------------------------------------------- C1
 * C1 · production consumes its ingredients. The server's since Phase 4:
 * apps/api/src/modules/production/production.test.ts pins all three halves — "consumes the
 * recipe for what was started and books only what came good (C1, UA-14)" for the depletion,
 * "names the ingredient that ran out, and moves nothing (C1)" for the refusal, and the batch
 * row's `qty`/`made` in the same first case. The store call that reaches that route is in
 * writes.test.ts, "sends what was started and what came good". */
```
and the whole `UA-14 · a batch records the yield it actually got` block with:
```ts
/* ------------------------------------------------- UA-14 · yield capture
 * The server's since Phase 4: production.test.ts's "consumes the recipe for what was started
 * and books only what came good (C1, UA-14)", "treats an omitted yield as a full one", "takes
 * a whole tray lost: the ingredients go, nothing reaches the rack" and "refuses a yield
 * greater than the quantity started, and writes nothing at all". */
```
Then delete from the file's imports whatever those two blocks were the last users of — `RCP` and `qty` at minimum; `noUnusedLocals` names the rest.

`UI/src/__tests__/store.test.ts` — replace the `production` describe block's body with a pointer, keeping the file's existing note about dispatch and handover:
```ts
describe("production", () => {
  // The whole of the kitchen is the server's from Phase 4: production.test.ts covers the
  // board ("walks the board a stage at a time and signs each step") and the batch ("consumes
  // the recipe for what was started and books only what came good"); the two store calls that
  // reach those routes are in writes.test.ts. Dispatch and handover moved in Phase 3.
  it.todo("nothing left in memory — see apps/api/src/modules/production/production.test.ts");
});
```
If `it.todo` leaves the file with no imports it still uses, remove those too rather than leaving them.

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @rch/ui test` → PASS, `screens.test.tsx` and `app.test.tsx` included (neither calls any of these actions; both only render).
Then `pnpm turbo typecheck test && pnpm lint`.

- [ ] **Step 9: Watch it work in a browser**

With `pnpm dev`, the API running and the database seeded: sign in as `RC-1902`. On **Orders**, take a New order through Accept → Start making → Mark ready and watch the history grow in the drawer; on a second browser signed in as `RC-4482` (the Snack Kiosk, which raised it) the same order must move on its own, because the write names `"pord"` and the stream tells the other window to refetch it. On **Make & Distribute**, make 60 puffs with a yield of 58 and a reason: the toast reads the variance and the best-before, the batch appears in "Made today", and the kitchen's stock line for Maida drops by 2.1 kg. Then type a quantity larger than the rack allows and press Make: the refusal names the ingredient and **the boxes still hold what you typed**.

Then the cancellation, as `RC-2088`: on the **Issue Desk**, issue a ticket against an approved request, note that the store's free-to-promise for that item has dropped, open the ticket, cancel it with a reason — the free-to-promise comes back, the request is on the desk again as approved, and it can be issued a second ticket. Open the same ticket as the counter it was addressed to: it says it was cancelled instead of showing a stepper stuck at the first step.

- [ ] **Step 10: Commit**

```bash
git add UI
git commit -m "$(cat <<'EOF'
Hand the kitchen's screens over to the server, and let a ticket be taken back

makeProduct and setOrderStatus are API calls; the recipe arithmetic, the batch id, the
best-before and every refusal go with them. What is left in the browser is the preview the
kitchen reads before it presses: the ingredient ceiling on a tile, the cover check on a
Dispatch button — computed with the same @rch/domain functions the server enforces with.

The Make tile now waits for the batch to land before it clears, so a refusal arrives on the
kitchen's own typing, and so does the cancellation's reason. The board's buttons are drawn
from PROD_ORDER_TRANSITIONS rather than from status literals, so a control that exists is a
press the server will take — with the one exception the table cannot express, a dispatched
order, whose only way back is cancelling its ticket.

The store's ticket drawer and the kitchen's ticket list can now withdraw a ticket nobody
collected; the counter's list can name a cancelled one and its drawer says what happened
instead of showing a stepper stuck at the first step.

The board and the batch log each have a narrow reader, so a status change or a make refetches
one slice instead of the whole working set — a dispatch too, which has named "pord" since
Phase 3 and has been paying for a snapshot ever since.

C1's three cases, UA-14's five and store.test.ts's production case now live in
apps/api/src/modules/production/production.test.ts; the calls that reach those routes are
pinned in writes.test.ts. Seq keeps only the procurement counters Phase 5 will take.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 7: Docs, spec §16, runbook, and the exit check

*(Wave 4, alone and last. It is the only task that edits `docs/`, `README.md`, `CLAUDE.md` and `deploy/RUNBOOK.md`.)*

**Files:**
- Modify: `CLAUDE.md`, `apps/api/CLAUDE.md`, `packages/contract/CLAUDE.md`, `packages/domain/CLAUDE.md`, `UI/CLAUDE.md`, `README.md`, `UI/README.md`, `docs/ua-spec.html`, `docs/system-design.html`, `docs/user-flows.html`, `deploy/RUNBOOK.md`, `docs/superpowers/specs/2026-09-03-backend-design.md`

**All of it lands in one commit**, the spec §16 rows included. The five guides are what a fresh agent reads before touching a package; one that still describes Phase 3 sends the next phase's implementer down a path that no longer exists.

- [ ] **Step 1: The root `CLAUDE.md`**

- *What this is*: "**Phases 1–3 of the backend are implemented**" → "**Phases 1–4**", and rewrite the sentence that follows: the last in-memory paths are procurement (`store/procurement.ts` and `sendRequisition`) and the rest of `store/ops.ts` — support tickets, rate contracts, new-product requests and catalogue additions — which Phases 5 and 6 close.
- *Domain invariants → "Nothing is created or destroyed without a document"*: the rule is now enforced in `apps/api/src/modules/production/service.ts` — one `postMoves` call carries the `production_consume` moves and the `production_yield`, ingredients against what was started and only the yielded units onto the rack — and the balance locks are taken over the ingredients and the finished item together before anything is read.
- *Domain invariants → "Costing"*: unchanged, but add that `batches` carries no cost column: a batch's value is derived from `costOf` at read time, not stamped.
- *Derived state is computed, never stored*: add one line — a make measures free-to-promise (`on_hand − reserved`) and not what is on the shelf, so stock another ticket is holding cannot be baked with.
- *The movement rule*: add the way back — a ticket nobody collected can be cancelled (`POST /tickets/:id/cancel`), which releases its hold and puts the document behind it back where it was; nothing moves, because nothing had moved.
- *Architecture → One Zustand store*: the kitchen's actions are API calls; `Seq` now holds only the procurement counters.
- *Backend*: status line → "Phases 1–4 (Foundation, Ledger + POS, Movement chain + SSE, Production) implemented; phases 5–6 pending — see spec §14"; note `packages/domain/src/shelf.ts` as the one place the best-before and its wording live, and `voidTicket` in `lib/tickets.ts` as the one door out of a ticket that was never collected.

- [ ] **Step 2: The four nested guides**

Read each one first — they are being written on the Phase 3 branch and their shape is theirs, not this plan's. Each gains what Phase 4 put in *that* package, in that guide's own voice, and nothing that belongs in another. **If one of the four is not there when you get here**, Phase 3 did not land it: create it, short, following the root `CLAUDE.md`'s tone — what the package is, its file layout, the rules that bind anyone editing it, how to run its tests — and then add this phase's material below. Do not skip it and do not write a placeholder.

- **`apps/api/CLAUDE.md`** — the `production` module now answers four endpoints, not two: `POST /prod-orders/:id/status` and `POST /batches` beside `dispatch` and `distribute`; `tickets` answers a fifth, `POST /tickets/:id/cancel`. Three rules to state where the guide states rules: (a) **every negative-going move takes the post-lock re-read** — `postMoves` holds the balance locks, and a service that moved stock down re-reads `on_hand − reserved` and refuses if any cell went below zero, which now covers `production_consume` as it already covered `sale` and `ticket_out`; (b) a write that both reads a balance and promises against it takes `lockBalances` over **every** cell it will touch in one call before reading, ingredients and finished item together, so `postMoves` never reaches for a new lock out of order; (c) `voidTicket` in `lib/tickets.ts` is the one door out of a ticket that was never collected, and `releaseForTicket` now has two callers rather than one. Add `batch` to whatever list of id kinds the guide keeps, and note that `batches` is written from `modules/production/repo.ts` and is not a protected table.
- **`packages/contract/CLAUDE.md`** — three new write routes (`setOrderStatus`, `makeBatch`, `cancelTicket`) and two new reads (`prodOrders`, `batches`); `TktStatusSchema` gained `Cancelled`, which is the one place to say that a status union and its pg enum in `apps/api/src/db/schema/enums.ts` are edited together or neither.
- **`packages/domain/CLAUDE.md`** — `shelf.ts` (`DEFAULT_SHELF_LIFE_HOURS`, `bestBeforeAt`, `bestBeforeText`) is new and is the only place the best-before or its H9 wording is computed; `approvedStatus` joins `planApproval` in `approval.ts`; and the transition tables gained three edges whose doors are not what the table says — `TICKET_TRANSITIONS.Issued → Cancelled` (the cancel endpoint), `REQUEST_TRANSITIONS["Ticket issued"] → the approved statuses` (a cancellation, not a screen) and `PROD_ORDER_TRANSITIONS.Dispatched → Ready` (a cancellation only, which is why `setStatus` and `canMoveOrder` both refuse `Dispatched` as a source). State that rule as a rule: **when a table's edge is reachable through one door only, both sides carry the same explicit guard** — the server in its service and the UI in its selector — rather than one side quietly offering a button the other refuses.
- **`UI/CLAUDE.md`** — `makeProduct`, `setOrderStatus` and the new `cancelTicket` are API calls; the kitchen's screens keep only previews (`ceiling`, the Dispatch cover check), computed with the same `@rch/domain` functions the server enforces with. `Seq` is down to the procurement counters. Restate the two settled patterns with their new members: an action that a screen resets a form for answers `Promise<boolean>` and the screen awaits it behind a busy lock (`makeProduct`, `cancelTicket`); a button with no form is fire-and-forget (`setOrderStatus`, `handover`, `dispatchOrder`). And `refetch` now has narrow readers for `pord` and `batch`, so only the collections with no reader still cost a snapshot.

- [ ] **Step 3: `README.md` and `UI/README.md`**

`README.md`'s status-by-phase section moves Phase 4 to done and says what that means in one line — the kitchen's board, its batches and a ticket that can be taken back. Then, in both files, state what a person can now do against a real server: walk a kitchen order across the board, make a batch that draws its recipe out of the kitchen and stamps a best-before, dispatch it, hand it over on an OTP, and receive it at the counter — with the other browser following along — and cancel a ticket nobody came for, which puts the stock and the document behind it back. Say plainly that procurement (requisitions, purchase orders, goods receipt, vendors, rate contracts) and the support desk are still in-memory.

- [ ] **Step 4: `docs/*.html` — the product contract**

Read each file and change only what this phase changed:
- `docs/user-flows.html`: the kitchen's flow — order accepted → in kitchen → ready → dispatched — is the server's, and so is the make; add that a make is refused whole when an ingredient is short, naming that ingredient, and that the units reaching the rack are the ones that came good rather than the ones that were started. Add "Cancelled" as an end state on the ticket flow, with what it does to the request or order behind it, and who may press it.
- `docs/ua-spec.html`: the UAT scenarios covering production (the batch screen and its yield capture) now name their server tests; where the spec described a rule the browser enforced, say the server enforces it and the browser shows its sentence. Leave the `PRD-…` batch identifiers in the UAT prose alone — they are the hospital's own wording from before the code chose `BAT-` for a batch and `PRD-` for an order — but add one line to the identity table saying which prefix the system actually issues for which document.
- `docs/system-design.html`: the production module's two new endpoints in the API surface, and the note that a make is one transaction over the ledger.
Run `bash scripts/build-site.sh` afterwards and confirm `dist/` assembles.

- [ ] **Step 5: `deploy/RUNBOOK.md`**

Add a short production section:
- Reading a batch's ledger: `select * from stock_moves where ref_type = 'batch' and ref_id = 'BAT-20260904-01' order by id;` — the negative rows are the recipe, the positive one is the yield, and a batch that yielded nothing has no positive row at all.
- Reading an order's audit trail: `select * from document_history where doc_type = 'prod_order' and doc_id = 'PRD-2026-029' order by at;` — one row per press of the board, including the dispatch.
- Batch numbering: `BAT-<yyyymmdd>-<nn>` takes its date from the make and its number from the single `sequences` row for `batch`, which never resets. The number is unique and increasing, not a count of the day's batches; do not "fix" it by hand.
- What a stuck make looks like: a `POST /batches` that refuses with "Kitchen is short of …" has written nothing — no batch row, no moves — and the number it drew is rolled back with it, so the series skips.
- A hold that will not go away: `select * from reservations where released_at is null;` shows what is promised and against which ticket. Every open row belongs to a ticket at `Issued`; the remedy is `POST /tickets/:id/cancel`, not an `UPDATE`. Why it matters more from this phase on: free-to-promise is what a make is refused against, so a stranded hold at the kitchen stops the kitchen baking.
- Reading a cancellation: `select * from document_history where doc_type = 'ticket' order by at desc;` — a ticket writes history for exactly two things, a supervisor override and a cancellation, and the cancellation's row carries the reason after an em dash because the ticket's own row has nowhere to put it.

- [ ] **Step 6: Spec §16 — record every decision this phase took**

Retitle the section "Amendments recorded during Phases 1–4" and append:

| Section | Amendment | Why |
|---|---|---|
| §9.2 raising a production order | **No `POST /prod-orders` is built.** Nothing in the frontend creates one: the store has no action that appends to `pord`, `seq.pord` was never incremented, and both orders on the board come from `packages/contract/src/fixtures/seed.ts`. §9.2 has no row for it either. Parked with the product question it depends on — who raises one, the outlet's counter or the outlet manager — and one manifest entry plus one service function away when that is answered. | Phase 4 is a cutover; there is nothing to cut over. Inventing the screen and the endpoint together would be a product change made in an implementation phase. |
| §9.2 `setOrderStatus` | `Dispatched` is refused here with `<id> goes out on a pick ticket — dispatch it from the order instead`, and an illegal transition reads `<id> is <from> — it cannot go straight to <to>` rather than `assertTransition`'s `<id> is already <status>`. The guard still reads `PROD_ORDER_TRANSITIONS`. | Both sentences are new: the browser's board only ever offered a legal button, so it had none. "Is already new" is the wrong half of the sentence for a New order asked to jump to Ready — the §16 (Phase 3) note about that wording is what made this the place to fix it. |
| §9.2 `makeProduct` | Every refusal is the store's own sentence in the store's own order — quantity, then yield, then the kitchen's switch, then the recipe, then the rack — and the cover measure is free to promise (`on_hand − reserved`), not on hand. | A different order produces a different sentence for the same input, and the tests that moved from `fixes.test.ts` assert the sentence. |
| §9.2 `makeProduct` | A make with `made = 0` posts its `production_consume` moves and **no** `production_yield` move; the `batches` row (started N, made 0) is what records the lost tray. Its balance row exists regardless, because `lockBalances` creates one for every cell the write touches. | A move of zero is not a movement, and the ledger reads better without rows that mean nothing. |
| §9.2 `makeProduct` | The rule is the spec's — a recipe exists — and not "the item is a finished good". `chai` and `capp` are batchable server-side; the kitchen's screen offers only the three FG products, which is a screen decision. | Narrowing the rule to `t === "FG"` would be a new rule, not the one §9.2 wrote down. |
| §9.3 `changed` | A batch names `["batch", "stock"]` and a status change names `["pord"]`. A make reserves nothing and releases nothing, so it does not name `"rsv"`. | `changed` is what the other browsers refetch; naming a slice that did not move costs every open window a request. |
| §5.1 lock order | A batch takes `allocateNumber(tx, "batch", at)` → `lockBalances` over the ingredient cells **and the finished-item cell in one call** → read → rules → `postMoves`. The id kind is `"batch"`, not `"bat"`. | Locking the ingredients alone would leave `postMoves` reaching for the finished item's row while already holding four others — a lock taken out of (loc, item) order, which is the shape a deadlock is made of. |
| §12 correctness | The post-lock re-read in `makeBatch` cannot fire, because the cover check above it already runs under the locks. It is kept as the invariant §12 asks for on every negative-going move, at the cost of two queries. | The same belt-and-braces as `reserve()` re-taking `lockBalances`: it is there for the next caller that reads a balance before locking it. |
| §5.1 domain | The best-before and its wording are `packages/domain/src/shelf.ts` — `DEFAULT_SHELF_LIFE_HOURS` (8), `bestBeforeAt(made, hours?)`, `bestBeforeText(due, made?)`. `UI/src/lib/fmt.ts`'s `bestBefore` and its private `hhmm`/`kolkataYmd` are deleted and `fromWireBestBefore` delegates. The day boundary is Asia/Kolkata's on both sides. | The server has to put H9's wording in a toast, and the browser had two copies of it — one of which measured the day in the host's zone, which is right only while the host sits in the hospital. |
| §7.3 batch ids | `BAT-<yyyymmdd>-<nn>` takes its date from the make and its number from one global `sequences` row (`SEQUENCE_START.batch`), which does not reset daily; `<nn>` widens past two digits rather than wrapping. | The number has to be unique and increasing, which it is. A per-day series would need a second table and a reset, for a number nobody counts. |
| §9.1 reads | `GET /prod-orders` and `GET /batches` are served by the snapshot module and scoped by `scopeProdOrders`/`scopeBatches`, which `scope()` now calls too: a counter sees the orders their own outlet raised and no batches at all. | §9.1 already listed both; moving the cut into two helpers keeps the standalone read and the snapshot from ever disagreeing. |
| §14 Phase 4 | `batches` carries no cost column, so nothing stamps `costOf`/`recipeCost` onto a batch; the kitchen's value figures stay derived at read time. The `UI` `Seq` interface loses `req`, `pord` and `bat`, leaving only the procurement counters Phase 5 removes. | Adding a column to record a number that is computed from master data would be a second source of truth for it. |
| §7.2 `tickets` / §9.2 (new row) | **`POST /tickets/:id/cancel {reason}`**, `["store", "prod"]`, scoped by `requireLocOf` on the ticket's `from`. `TktStatus` and the `ticket_status` enum gain `Cancelled`; `voidTicket` in `lib/tickets.ts` releases the ticket's open holds, sets the status and writes the reason to `document_history`. Nothing moves and `"stock"` is never in `changed`. | Phase 3 gave `releaseForTicket` one caller. A ticket nobody collected therefore held its stock for ever, and the request behind it was frozen at `Ticket issued` with no transition out but `Collected` — a correctness gap that only became visible when a make started refusing on free-to-promise. |
| §7.2 `document_history` | A ticket now writes history for two things: the supervisor override and a cancellation, the latter as `Cancelled — <reason>`. | The reason is the only record a cancellation leaves, and `tickets` has no column for prose. |
| §9.2 cancellation, the document behind it | A `request` ticket puts its request back to `approvedStatus(lines)` with `ticket_id` cleared; a `prod_order` ticket puts its order back to `Ready`; a `direct` ticket has nothing behind it. `approvedStatus` moves into `packages/domain/src/approval.ts` and `planApproval` now uses it. | Cancelling the store's pick must not discard the manager's approval, and a dispatched order that was never delivered must not keep saying it was. The status a request returns to is the same computation the approval made, so it is written once. |
| §5.1 transitions | `TICKET_TRANSITIONS.Issued` gains `Cancelled`; `REQUEST_TRANSITIONS["Ticket issued"]` gains both approved statuses; `PROD_ORDER_TRANSITIONS.Dispatched` gains `Ready`. The last edge is reachable **only** through a cancellation: `POST /prod-orders/:id/status` refuses `Dispatched` as a source and `canMoveOrder` excludes it too. | The table says what may follow what; it cannot say by which door. Where those differ, both sides carry the same explicit guard rather than one side silently offering a button the other refuses. |
| §9.2 cancellation, scope | A shop transfer's and a shop ask's ticket cannot be cancelled: both leave from an outlet, and the route admits only the store keeper at the store and the kitchen in-charge at the kitchen. Phase 6 gives the counter that door. | Keeping the role list honest was better than adding a counter path this phase has no screen for and no test budget to cover. |
| §9.3 `changed` | A cancellation names `["tkt", "rsv"]` plus `"req"` or `"pord"` only when one of those actually moved. | Naming a slice that did not change costs every open browser a refetch — the same reason a make does not name `"rsv"`. |
| §5.1 locks | A cancellation takes no balance locks. The ticket's own `for update` serialises two cancellations; a release can only make free-to-promise larger, so a writer racing it is correct either way. | The lock-before-read rule exists to stop the same stock being promised twice. Giving stock back is not a promise. |

- [ ] **Step 7: Run the exit check (spec §14 row 4)**

From a clean tree on `feat/phase-4-production`:
```bash
pnpm install
pnpm turbo typecheck test && pnpm lint          # every package green
pnpm helm:test                                  # chart renders
bash scripts/build-site.sh                      # docs and app assemble
pnpm db:up
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed --force
pnpm dev                                        # api :3000, UI :5173
```
Then, in a second shell, the kitchen end to end:
```bash
API=http://localhost:3000/api/v1
login() { curl -sS -X POST $API/auth/login -H 'content-type: application/json' -d "{\"emp\":\"$1\",\"password\":\"changeme\"}" | jq -r .accessToken; }
PROD=$(login RC-1902); K() { python3 -c 'import uuid;print(uuid.uuid4())'; }
P() { curl -sS -X POST "$API$1" -H "Authorization: Bearer $PROD" -H 'content-type: application/json' -H "Idempotency-Key: $(K)" ${2:+-d "$2"}; }

# 1. The board walks, a stage at a time, and signs each step.
P /prod-orders/PRD-2026-029/status '{"st":"Accepted"}'   | jq -r .message   # "PRD-2026-029 — accepted"
P /prod-orders/PRD-2026-029/status '{"st":"In kitchen"}' | jq -r .message
P /prod-orders/PRD-2026-029/status '{"st":"Ready"}'      | jq -r '.message, (.result.hist | map(.s) | join(" -> "))'
#    a skipped stage is refused, and the order does not move
P /prod-orders/PRD-2026-030/status '{"st":"Ready"}'      | jq -r .error.message
#    expect "PRD-2026-030 is accepted — it cannot go straight to ready"
#    and dispatch is not a word this door takes
P /prod-orders/PRD-2026-029/status '{"st":"Dispatched"}' | jq -r .error.message

# 2. Make: the recipe comes off, the yield goes on, the best-before is stamped.
curl -sS -H "Authorization: Bearer $PROD" $API/stock | jq '.stock.kitchen | {maida, fill, oil, box, puff}'
#    expect maida 8, fill 3, oil 4, box 120, puff 24
P /batches '{"it":"puff","started":60,"made":58,"note":"Oven tray dropped"}' | jq -r '.message, .changed[]'
#    expect "BAT-<today>-01 — 58 of 60 Veg puffs yielded (-3.3%), best before <hh:mm>", then batch, stock
curl -sS -H "Authorization: Bearer $PROD" $API/stock | jq '.stock.kitchen | {maida, fill, oil, box, puff}'
#    expect maida 5.9, fill 1.2, oil 3.52, box 60, puff 82 — recipe x 60 off, 58 on
curl -sS -H "Authorization: Bearer $PROD" $API/batches | jq '.[0] | {id, qty, made, bb, note}'
#    12 hours after the make: `bb` is an instant, and the browser prints it as "hh:mm" or "hh:mm tomorrow"

# 3. A short kitchen refuses whole, and names the ingredient.
P /batches '{"it":"puff","started":100000}' | jq -r .error.message
#    expect "Kitchen is short of Maida — 5.900 kg left"
curl -sS -H "Authorization: Bearer $PROD" $API/stock | jq '.stock.kitchen.maida'   # still 5.9 — nothing was written

# 4. Dispatch after the make: 40 puffs against 82 on the rack, all on one ticket.
DISP=$(P /prod-orders/PRD-2026-029/dispatch); jq -r '.message, .result.order.st, .result.ticket.otp' <<<"$DISP"
TKT=$(jq -r .result.ticket.id <<<"$DISP")
curl -sS -H "Authorization: Bearer $PROD" $API/stock | jq '.rsv["kitchen:puff"]'   # 40 held, 82 still on the rack

# 5. And taken back: the hold goes, the order returns to the board, nothing ever moved.
P /tickets/$TKT/cancel '{"reason":"Kiosk shut early"}' | jq -r '.message, (.changed | join(","))'
#    expect "TKT-0xxx cancelled — PRD-2026-029 is back on the board, ready to dispatch again" and tkt,rsv,pord
curl -sS -H "Authorization: Bearer $PROD" $API/stock | jq '.rsv["kitchen:puff"], .stock.kitchen.puff'   # null, 82
curl -sS -H "Authorization: Bearer $PROD" $API/prod-orders | jq -r '.[] | select(.id=="PRD-2026-029") | .st'   # Ready
#    a cancelled ticket cannot be cancelled twice
P /tickets/$TKT/cancel '{"reason":"again"}' | jq -r .error.message      # "… is already cancelled"
#    and the board still walks forwards only: Ready goes out, it does not go back to the oven
P /prod-orders/PRD-2026-029/status '{"st":"In kitchen"}' | jq -r .error.message
#    expect "PRD-2026-029 is ready — it cannot go straight to in kitchen"

# 6. The same door at the store, where a request is behind the ticket.
STORE=$(login RC-2088); MANAGER=$(login RC-3120)
S() { curl -sS -X POST "$API$1" -H "Authorization: Bearer $STORE" -H 'content-type: application/json' -H "Idempotency-Key: $(K)" ${2:+-d "$2"}; }
REQ=$(curl -sS -H "Authorization: Bearer $MANAGER" $API/requests | jq -r '[.[] | select(.st=="Manager approved" or .st=="Partially approved")][0].id')
TK2=$(S /requests/$REQ/issue-ticket | jq -r .result.ticket.id)
curl -sS -H "Authorization: Bearer $STORE" $API/stock | jq '.rsv | to_entries | map(select(.key|startswith("store:")))'
S /tickets/$TK2/cancel '{"reason":"The counter closed before the collector came"}' | jq -r '.message, (.changed | join(","))'
curl -sS -H "Authorization: Bearer $STORE" $API/requests | jq -r ".[] | select(.id==\"$REQ\") | \"\(.st) ticket=\(.ticket)\""
#    expect the approved status back, with ticket=null — and a fresh ticket can be issued
S /requests/$REQ/issue-ticket | jq -r .result.ticket.id

# 7. The cache is exactly the sum of the moves.
curl -sS -H "Authorization: Bearer $PROD" $API/stock > /tmp/rch-before.json
pnpm --filter @rch/api db:rebuild-balances
curl -sS -H "Authorization: Bearer $PROD" $API/stock > /tmp/rch-after.json
diff /tmp/rch-before.json /tmp/rch-after.json && echo "balances reconcile"
```
Then the browser walk (Task 6's Step 9) — one window as `RC-1902` and one as `RC-4482`, the board moving in both without a reload, a refusal leaving the Make tile's boxes full, and a cancelled ticket giving its stock and its request back on the store's issue desk.
**Staging** is a release decision made outside this plan: the local run above is what gates the phase. Record both facts in the ledger.

- [ ] **Step 8: Commit**

One commit, everything in it — the five guides, both READMEs, the product contract, the runbook and the spec's amendments:
```bash
git add CLAUDE.md apps/api/CLAUDE.md packages/contract/CLAUDE.md packages/domain/CLAUDE.md UI/CLAUDE.md \
        README.md UI/README.md docs deploy/RUNBOOK.md
git status --short   # nothing under docs/ or CLAUDE.md left unstaged
git commit -m "$(cat <<'EOF'
Document the kitchen's move to the server and record its exit check

The root guide, the four package guides and the README's status-by-phase section all say what
the code says now: the kitchen's board and its batches are the server's, a ticket nobody
collected can be taken back, and the best-before is computed in one place. Spec §16 carries
the twenty decisions this phase took, including the two it declined to take — no endpoint for
raising a production order, and no counter-side cancellation.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | **1** (contract writes, the transition tables, the `ticket_status` enum) ∥ **2** (domain shelf life + the UI's copy of the wording) | Worktrees. Disjoint: Task 1 owns `packages/contract/**`, `packages/domain/src/{transitions.ts,transitions.test.ts}`, `apps/api/src/db/schema/enums.ts` and the migration it generates; Task 2 owns `packages/domain/src/{shelf.ts,shelf.test.ts,index.ts}`, `UI/src/lib/fmt.ts`, `UI/src/store/index.ts`'s one `bestBefore` call site, and the **H9 block only** of `UI/src/__tests__/fixes.test.ts`. Different files in the same two packages, and neither reads the other's. Task 1 declares **writes only** — a manifest GET without a handler fails `apps/api/src/contract.test.ts`, which no longer skips a 404 — and it carries the enum because the contract union, the pg enum and the transition table are one change (`ticketsRepo.setStatus` types its patch against the union and writes it into the column). |
| 2 | **3** (the two reads + their manifest entries) ∥ **4** (`production` — statuses and batches) ∥ **5** (`tickets` — cancellation) | Worktrees, all three from the merge of wave 1. Disjoint: Task 3 owns `apps/api/src/modules/snapshot/**` and `packages/contract/src/{routes.ts,schemas/snapshot.ts}`; Task 4 owns `apps/api/src/modules/production/**`; Task 5 owns `apps/api/src/modules/tickets/**`, `apps/api/src/lib/tickets.ts` and `packages/domain/src/{approval.ts,approval.test.ts,index.ts}` — and nobody has touched `packages/domain/src/index.ts` since wave 1. `apps/api/src/modules/index.ts` already registers all three modules from Phase 3, so there is no shared registration line to edit. None of the three needs anything from the others: Task 4's tests read `GET /snapshot` and `GET /stock`, which have existed since Phase 1, and Task 5's read `GET /requests` and `GET /prod-orders` — the second of which is Task 3's, so **Task 5's board assertion reads the snapshot instead if it is running before Task 3 has merged**. |
| 3 | **6** (UI cutover) | In-tree or one worktree; it is alone. It needs all three wave-2 tasks merged — the write routes it calls (Tasks 4 and 5) and the read routes its `refetch` entries name (Task 3) — and it is one coherent change: the store's three actions, their narrow readers, the two selectors the buttons read, seven screens and four test files. Splitting the store from the screens would fail typecheck in whichever half went first. |
| 4 | **7** (guides, docs, spec §16, runbook, exit check) | In-tree, after everything is merged. The only task that edits `docs/`, the two READMEs, the root `CLAUDE.md`, the four package `CLAUDE.md` guides and `deploy/RUNBOOK.md` — all in one commit. |

Worktree agents do not commit to the shared branch; the controller reviews and merges each branch, then dispatches the next wave from the merge commit. **Parallel tasks never edit the same file.** Where a file is needed by more than one task it is written by the earlier wave: `packages/contract/src/routes.ts` by Task 1 in wave 1 and Task 3 in wave 2, never by two at once; `packages/domain/src/index.ts` by Task 2 in wave 1 and Task 5 in wave 2; `UI/src/store/index.ts` by Task 2 in wave 1 (one call site, so the tree compiles) and rewritten by Task 6 in wave 3. The two tables Task 1 edits — `TICKET_TRANSITIONS` and `PROD_ORDER_TRANSITIONS` — are read by Tasks 4, 5 and 6 and written by none of them.
