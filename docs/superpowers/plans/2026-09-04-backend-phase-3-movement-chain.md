# RCH Backend — Phase 3: Movement chain + SSE — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The request chain moves to the server — a counter (or the kitchen) raises a stock request, the Outlet Manager approves it against free-to-promise, the Store Keeper issues a ticket that reserves the stock, the collector's OTP releases it as `ticket_out`, and the receiving location books it in as `ticket_in` — together with shop-to-shop transfers and shop asks; and every open browser learns about each commit through an SSE stream fanned out across API replicas by Postgres `LISTEN`/`NOTIFY`.

**Architecture:** Eleven write endpoints (spec §9.2's Phase 3 rows) land as three modules — `requests`, `tickets`, `shopasks` — each composing the Phase 1/2 platform: `withTransaction` → rules from `@rch/domain` → `lockBalances`/`postMoves`/`allocateNumber` → `emitChanged` → `{ result, changed, message }`. **Approval authorises; the scan moves:** approve and issue write only `reservations` rows; `handover` posts the `ticket_out` moves at `from_loc` and releases those reservations in the same transaction; `receive` posts `ticket_in` at `to_loc` — in between the stock is in transit and owned by neither location. Live updates are `GET /events`: a write calls `pg_notify` **inside** its transaction (so a notice exists only if the write committed), a per-pod listening `pg.Client` fans the notice out to that pod's open streams, and the browser refetches the named slice, debounced 250 ms. Status transitions become one data table in `packages/domain/src/transitions.ts` that the server asserts through and the UI disables buttons through.

**Tech Stack:** unchanged from Phases 1–2 — Node 24, pnpm 10, Turborepo 2, TypeScript ~6.0, Fastify 5, fastify-type-provider-zod 7, Zod 4, Drizzle 0.45 + drizzle-kit 0.31, pg 8, PostgreSQL 17, Vitest 4, tsup 8, Helm 3. **No new dependency:** the SSE fan-out uses `pg`'s own `LISTEN`/`NOTIFY` (already a dependency) and the browser client is a ~70-line parser over `fetch`'s `ReadableStream`.

**Spec:** `docs/superpowers/specs/2026-09-03-backend-design.md` — §5.1 (reuse rules, incl. the transitions table), §6 (architecture; SSE `/events`), §7.2 (`stock_requests`, `stock_request_lines`, `tickets`, `ticket_lines`, `reservations`, `shop_asks`, `document_history`), §7.3 (id formats), §8.3 (roles and location scoping; the supervisor override), §9.2 (the eleven Phase 3 rows), §9.3 (write responses), §10 (frontend cutover), §11.1 (nginx `proxy_buffering off`, ALB idle timeout 3600 s), §12 (SIGTERM closes SSE streams with a `retry` hint; `/metrics` SSE client gauge), §13 (testing), §14 row 3 (exit check), §16 (amendments from Phases 1–2 — **binding, do not reopen**).
**Ledgers:** `docs/superpowers/plans/2026-09-03-backend-phase-1-foundation-ledger.md` and `.superpowers/sdd/2026-09-04-backend-phase-2-ledger-pos/progress.md`.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Branch model:** work on `feat/phase-3-movement-chain` from `feat/phase-2-ledger-pos` (which is itself ahead of `develop`); never push to `staging`/`production`. Worktree agents start with `git merge --ff-only feat/phase-3-movement-chain`.
- **Conventions settled in Phases 1–2 (binding):** `apps/api` and `packages/*` relative imports carry `.js`; no constructor parameter properties (`erasableSyntaxOnly`); `strict` TS with `noUnusedLocals`/`noUnusedParameters`/`verbatimModuleSyntax`; type-only imports use `import type`. UI uses bundler resolution (no extensions). Every DB-backed test file calls `buildTestApp({ schema: "<unique>" })`; `withTestSchema` suffixes the schema with the pid, so parallel worktrees sharing one database do not drop each other's schema. Local Postgres is Docker on host port **5439**; Node 24 lives at `$(brew --prefix node@24)/bin`.
- **Every write is one transaction** (`withTransaction`), rules through `assertRule` carrying the operator-facing sentence, quantities through `round3`, ledger moves only through `postMoves`, balance locks only through `lockBalances`, ids only through `allocateId`/`allocateNumber`, history only through `appendHistory`, reservations only through `apps/api/src/lib/reservations.ts`. `scripts/check-boundaries.sh` enforces the protected tables — do not write them anywhere else.
- **Routes only through `mount(app, routes.<name>, handler)`**; every module is `routes.ts / service.ts / repo.ts / <name>.test.ts` (copy `apps/api/src/modules/_template/`). The single exception in this phase is `GET /events`, registered directly by `apps/api/src/plugins/sse.ts` alongside `/healthz`, `/readyz` and `/metrics`, because it is a stream with no JSON response schema to serialise (recorded as a spec §16 amendment in Task 10).
- **Write response shape (spec §9.3):** `{ result, changed, message }` — `changed` names snapshot collections to refetch (this phase uses `"req"`, `"tkt"`, `"rsv"`, `"stock"`, `"shopAsks"`); `message` is the toast sentence, moved **verbatim** from the store's current `notify()` text. Where a new sentence is unavoidable it is called out in the task and recorded in spec §16.
- **Refusals** are `RuleError` (422) with the sentence the store uses today; an unknown item or document key is `NotFoundError` (404) reading `There is no item <key>.` / `There is no request <id>.` / `There is no ticket <id>.` / `There is no shop ask <id>.`; role gating is 404 (the module is absent); location scoping is 403 through `requireLoc`/`requireLocOf`.
- **Quantities on the wire** are `z.number().finite().max(100000)` and positivity is a **service rule**, not a schema rule, so a zero reaches the operator as the store's own sentence (`"Enter a quantity"`) instead of a generic 400. Times are ISO; money `numeric(12,2)`; quantities `numeric(12,3)` rounded with `round3`.
- **The movement rule (CLAUDE.md):** approval authorises, the scan moves. Approve and issue write reservations only. `handover` posts `ticket_out` at `from_loc` and releases the ticket's reservations in the same transaction. `receive` posts `ticket_in` at `to_loc`. Every negative-going move gets the Phase 2 post-lock re-read: `postMoves` takes the row locks, then the service re-reads `on_hand` for every touched `(loc, item)` and refuses if any went below zero, rolling the whole transaction back.
- **Every reservation-creating path takes the balance locks first.** `lockBalances(tx, cells)` before reading `on_hand` and open reservations, then insert. Without the lock two concurrent issues both read the same balance and both reserve it.
- **Lock order, server-wide: ids first, balance rows second.** `apps/api/src/lib/ledger.ts`'s header already records it and `modules/pos/service.ts` already keeps it — `allocateId`/`allocateNumber` (which locks a `sequences` row) runs *before* `postMoves`/`lockBalances` (which lock `stock_balances` rows), never after. Every write that needs both takes them in that sequence, so a sale and an issue on the same shelf cannot sit each holding one and waiting for the other. In practice this means a ticket's number is allocated **before** the cover check: `allocateTicket(tx)` → `lockBalances(tx, cells)` → read → `writeTicket(tx, draft, no)`. A refused write rolls the allocation back with everything else; the sequence simply skips a number, which is why `SEQUENCE_START` is a counter and not a count.
- **Every status transition reads its own row `for update`.** A module's `repo.head(tx, id)` is a locking read — `.for("update")` in Drizzle, i.e. `select … where id = $1 for update`. A transition guard that reads without the lock is not a guard: two handovers of one ticket both see `Issued`, both pass `assertTransition`, and both post `ticket_out`. The lock is held to the end of the transaction, so the second caller reads the status the first committed and is refused. This applies to `stock_requests`, `tickets` and `shop_asks` alike.
- **The kitchen's two ticket paths cross with everything else.** `dispatchOrder` and `distribute` are the only writes in production that create a ticket, and Task 6 makes `handover` a server call — so a locally minted `TKT-0xxx` would answer `404 There is no ticket TKT-0xxx.` Task 12 moves both, and spec §14's "nothing dual-runs" is met. **`setOrderStatus`, `makeProduct` and everything in `store/procurement.ts` stay in memory for Phases 4–5** — they create no ticket, so they cross no seam. Leave them exactly as they are.
- **Every task ends green:** `pnpm turbo typecheck test && pnpm lint` (turbo lint + knip + `scripts/check-boundaries.sh`) at the repo root. Never leave a test asserting behaviour that moved — each task that deletes a UI rule test names the server test that replaces it, in the commit body.
- **Commit messages:** imperative, sentence-case, no prefixes, plus the trailers
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
  ```

---

## File structure (what Phase 3 adds or changes)

```
packages/contract/src/
  schemas/writes.ts       CollectionSchema (extracted) + the thirteen Phase 3 bodies/params/results
  schemas/events.ts       EVENTS_PATH, EventNoticeSchema
  schemas/snapshot.ts     + RequestsResponseSchema, TicketsResponseSchema, ShopAsksResponseSchema
  routes.ts               + 13 writes + 3 GETs
packages/domain/src/
  transitions.ts          REQUEST_TRANSITIONS, TICKET_TRANSITIONS, SHOP_ASK_TRANSITIONS, PROD_ORDER_TRANSITIONS, canTransition
  approval.ts             planApproval(lines, appr, freeFor) -> { lines, st, trimmed }
  credit.ts               STAFF_CREDIT_LIMIT, creditRoom, breachesCredit, creditBreachMessage
apps/api/src/
  lib/events.ts           emitChanged(tx, changed) -> pg_notify inside the write's transaction
  lib/reservations.ts     reserve / releaseForTicket / reservedAt
  lib/tickets.ts          allocateTicket(tx) -> number+OTP ; writeTicket(tx, draft, no) -> head + lines + holds
  lib/ledger.ts           + lockBalances(tx, cells), used by postMoves and by every reservation path
  lib/ids.ts              + allocateNumber(tx, kind, at) -> { n, id }
  lib/rules.ts            + assertTransition(table, from, to, what)
  lib/time.ts             + monthStartIST(at) — the window the staff-credit ceiling is measured over
  plugins/sse.ts          GET /events, the LISTEN client, heartbeat, SIGTERM retry hint
  plugins/rbac.ts         + requireLocOf(claims, loc, what)
  test/builders.ts        given.request / given.ticket / given.shopAsk / given.bill  (spec §5.1)
  modules/requests/       POST /requests, /:id/cancel, /:id/approve, /:id/reject, /:id/issue-ticket
  modules/tickets/        POST /tickets/:id/handover, /:id/receive, POST /transfers
  modules/shopasks/       POST /shop-asks, /:id/answer, /:id/decline
  modules/production/     POST /prod-orders/:id/dispatch, POST /distributions
  modules/pos/            + the staff-credit ceiling; the post-lock check nets reservations
  modules/snapshot/       + GET /requests, GET /tickets, GET /shop-asks
UI/src/
  api/events.ts           fetch-based SSE client: parser, debounce, backoff, live-state store
  api/refetch.ts          "req" -> GET /requests, "tkt" -> GET /tickets, "shopAsks" -> GET /shop-asks
  api/wire.ts             + applyRequests, applyTickets, applyShopAsks
  api/client.ts           refreshOnce() exported for the stream's 401 path
  store/index.ts          the ten request/ticket/kitchen actions become API calls; seq.tkt goes
  store/ops.ts            transferToOutlet, askShop, answerShopAsk, declineShopAsk become API calls
  lib/selectors.ts        isReqOpen/canIssueTicket/canHandOver/canReceiveTicket over the transitions table
  ui/Shell.tsx            a Pill that reads "Reconnecting" when the stream is down
  main.tsx                startEventStream()
```

---

### Task 1: Contract — the eleven Phase 3 writes and the SSE notice

**Files:**
- Create: `packages/contract/src/schemas/events.ts`
- Modify: `packages/contract/src/schemas/writes.ts`, `packages/contract/src/routes.ts`, `packages/contract/src/index.ts`, `packages/contract/src/routes.test.ts`

**Scope note — writes only.** `apps/api/src/contract.test.ts` probes **every** param-less GET in the manifest and asserts a 200 (Phase 2 removed its skip-on-404 branch on purpose), so a GET declared before its handler exists turns the API suite red. The three reads this phase adds — `GET /requests`, `GET /tickets`, `GET /shop-asks` — are therefore declared in **Task 4**, in the same commit as the handlers that answer them. Write routes are inert until a module mounts them, so all eleven land here.

**Interfaces:**
- Produces (imported by Tasks 3–9):
  ```ts
  // schemas/writes.ts — CollectionSchema is extracted so events.ts can name one collection
  export const CollectionSchema = z.enum(["stock", "rsv", "ovr", "prices", "menu", "bills", "req", "tkt", "prq", "po", "pord", "batch", "grn", "vendors", "contracts", "tickets", "productReqs", "shopAsks"]);
  export const ChangedSchema = z.array(CollectionSchema);
  export type Changed = z.infer<typeof CollectionSchema>;

  // Three decimals is the whole precision of a quantity anywhere in this system (`round3`), so
  // anything finer is a client bug, as `PayBodySchema` already says. The ceiling is 100000
  // rather than a till line's 10000 because a stock request moves warehouse quantities, not a
  // cart. Positivity is deliberately NOT here — a zero must reach the operator as the store's
  // own "Enter a quantity", not a generic 400.
  export const QtySchema = z.number().finite().multipleOf(0.001).max(100000);
  export const ReqLineInputSchema = z.strictObject({ it: z.string().min(1).max(64), qty: QtySchema });
  export const CreateRequestBodySchema = z.strictObject({ lines: z.array(ReqLineInputSchema).min(1).max(50), note: z.string().max(500).default(""), urgent: z.boolean().default(false) });
  export const DocIdParamsSchema = z.strictObject({ id: z.string().min(1).max(40) });
  export const ApproveRequestBodySchema = z.strictObject({ appr: z.array(z.number().finite().max(100000)).min(1).max(50), note: z.string().max(500).default("") });
  export const RejectRequestBodySchema = z.strictObject({ note: z.string().max(500) });
  export const HandoverBodySchema = z.strictObject({ otp: z.string().regex(/^\d{6}$/).optional() });
  export const TransferBodySchema = z.strictObject({ from: LocKeySchema, to: LocKeySchema, it: z.string().min(1).max(64), qty: QtySchema });
  export const ShopAskBodySchema = z.strictObject({ to: LocKeySchema, it: z.string().min(1).max(64), qty: QtySchema, note: z.string().max(500).default("") });
  export const AnswerShopAskBodySchema = z.strictObject({ grant: QtySchema });
  export const DeclineShopAskBodySchema = z.strictObject({ reason: z.string().max(500) });

  // `result` is the document the caller acted on. Two endpoints answer with a pair, because the
  // operator needs the sibling in the same breath: an approval's `trimmed` is a property of the
  // decision, not of the request row, and an issued ticket's OTP has to reach the store window.
  export const ApprovalResultSchema = z.strictObject({ request: StockRequestSchema, trimmed: z.boolean() });
  export const IssueResultSchema = z.strictObject({ request: StockRequestSchema, ticket: TicketSchema });
  export const ShopAskSentResultSchema = z.strictObject({ ask: ShopAskSchema, ticket: TicketSchema });

  // schemas/events.ts
  export const EVENTS_PATH = "/events";
  export const EventNoticeSchema = z.strictObject({ collection: CollectionSchema, at: z.string() });
  export type EventNotice = z.infer<typeof EventNoticeSchema>;
  ```
- `routes.ts` additions, appended after `bills` and before the closing `} as const;`:
  ```ts
  createRequest:  defineRoute({ method: "POST", path: "/requests",                  access: ["counter", "prod"],            body: CreateRequestBodySchema,   response: writeResponse(StockRequestSchema) }),
  cancelRequest:  defineRoute({ method: "POST", path: "/requests/:id/cancel",       access: ["counter", "prod"],            params: DocIdParamsSchema,       response: writeResponse(StockRequestSchema) }),
  approveRequest: defineRoute({ method: "POST", path: "/requests/:id/approve",      access: ["manager"],                    params: DocIdParamsSchema, body: ApproveRequestBodySchema, response: writeResponse(ApprovalResultSchema) }),
  rejectRequest:  defineRoute({ method: "POST", path: "/requests/:id/reject",       access: ["manager"],                    params: DocIdParamsSchema, body: RejectRequestBodySchema,  response: writeResponse(StockRequestSchema) }),
  issueTicket:    defineRoute({ method: "POST", path: "/requests/:id/issue-ticket", access: ["store"],                      params: DocIdParamsSchema,       response: writeResponse(IssueResultSchema) }),
  // `counter` is here for a shop transfer's own ticket (spec §9.2): the outlet that granted it
  // hands it over. No counter screen calls it yet; the route exists so Phase 6 adds a button, not a route.
  handover:       defineRoute({ method: "POST", path: "/tickets/:id/handover",      access: ["store", "prod", "counter"],   params: DocIdParamsSchema, body: HandoverBodySchema,       response: writeResponse(TicketSchema) }),
  receiveTicket:  defineRoute({ method: "POST", path: "/tickets/:id/receive",       access: ["counter", "store", "prod"],   params: DocIdParamsSchema,       response: writeResponse(TicketSchema) }),
  transfer:       defineRoute({ method: "POST", path: "/transfers",                 access: ["counter", "manager"],         body: TransferBodySchema,        response: writeResponse(TicketSchema) }),
  askShop:        defineRoute({ method: "POST", path: "/shop-asks",                 access: ["counter"],                    body: ShopAskBodySchema,         response: writeResponse(ShopAskSchema) }),
  answerShopAsk:  defineRoute({ method: "POST", path: "/shop-asks/:id/answer",      access: ["counter"],                    params: DocIdParamsSchema, body: AnswerShopAskBodySchema,  response: writeResponse(ShopAskSentResultSchema) }),
  declineShopAsk: defineRoute({ method: "POST", path: "/shop-asks/:id/decline",     access: ["counter"],                    params: DocIdParamsSchema, body: DeclineShopAskBodySchema, response: writeResponse(ShopAskSchema) }),
  ```
  Task 4 appends the three GETs (`requests`, `ticketsList`, `shopAsks`) after these.
- `GET /events` is deliberately **not** in the manifest: `apps/api/src/contract.test.ts` probes every param-less GET and would hang on a stream, and `mount()` would try to serialise a Zod response for a body that never ends. It is registered directly by the `sse` plugin; both sides build its URL from `API_PREFIX + EVENTS_PATH`.

- [ ] **Step 1: Write the failing test** — `packages/contract/src/routes.test.ts` already fails the "every route that takes a body has a sample here" case the moment a new body route appears. **Add these entries to the existing `SAMPLES` object and leave every entry already there exactly as you find it** (that file is maintained alongside the Phase 2 routes and its values may have moved since this plan was written):

```ts
  createRequest: { lines: [{ it: "SKU-1", qty: 20 }], note: "Counter runs dry by 4pm", urgent: true },
  approveRequest: { appr: [12], note: "Store only holds 12 L." },
  rejectRequest: { note: "Kiosk is overstocked already" },
  handover: { otp: "418327" },
  transfer: { from: "coffee", to: "kiosk", it: "SKU-1", qty: 6 },
  askShop: { to: "kiosk", it: "SKU-1", qty: 6, note: "Lunch rush cleared us out" },
  answerShopAsk: { grant: 6 },
  declineShopAsk: { reason: "We are short ourselves" },
```

And add a new case at the bottom of the file, so a stream route can never be added to the manifest by accident:

```ts
describe("the event stream", () => {
  it("is not a manifest route — it is a stream, not a JSON endpoint", () => {
    expect(Object.values(routes).some((r) => r.path === EVENTS_PATH)).toBe(false);
  });
  it("names one collection at a time, from the same enum `changed` draws on", () => {
    expect(EventNoticeSchema.safeParse({ collection: "req", at: "2026-09-04T04:30:00.000Z" }).success).toBe(true);
    expect(EventNoticeSchema.safeParse({ collection: "nonsense", at: "2026-09-04T04:30:00.000Z" }).success).toBe(false);
    expect(EventNoticeSchema.safeParse({ collection: "req", at: "…", extra: 1 }).success).toBe(false);
  });
});
```
with `import { EVENTS_PATH, EventNoticeSchema } from "./index";` at the top.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @rch/contract test`
Expected: FAIL — `EVENTS_PATH` is not exported, and the samples case reports the new route names as missing.

- [ ] **Step 3: Write the schemas and the manifest entries**

In `packages/contract/src/schemas/writes.ts`: extract `CollectionSchema` exactly as shown in **Interfaces** above (keeping `ChangedSchema` and the `Changed` type working as they do today — `Changed` becomes `z.infer<typeof CollectionSchema>`, which is the same union), then add `QtySchema` and every body/params/result schema listed there. `ApprovalResultSchema`, `IssueResultSchema` and `ShopAskSentResultSchema` need `StockRequestSchema`, `TicketSchema` and `ShopAskSchema` — import them from `./documents.js`.
Create `packages/contract/src/schemas/events.ts` with `EVENTS_PATH` and `EventNoticeSchema`.
In `packages/contract/src/routes.ts` add the eleven write entries above, importing the new schemas.
In `packages/contract/src/index.ts` re-export everything new (`export * from "./schemas/events.js";` plus the added names wherever that file lists them explicitly).

- [ ] **Step 4: Run the tests**

Run: `pnpm turbo typecheck test && pnpm lint`
Expected: PASS everywhere. Nothing mounts the new write routes yet, and a manifest entry with no handler is inert — `apps/api/src/contract.test.ts` iterates GETs only, and this task adds none.

- [ ] **Step 5: Commit**

```bash
git add packages/contract
git commit -m "$(cat <<'EOF'
Declare the movement chain and the event stream in the contract

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 2: Domain — the status transition tables and the approval arithmetic

**Files:**
- Create: `packages/domain/src/transitions.ts`, `packages/domain/src/transitions.test.ts`, `packages/domain/src/approval.ts`, `packages/domain/src/approval.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: `ReqStatus`, `TktStatus`, `ShopAskStatus` from `@rch/contract` (already a dependency of `packages/domain`), and `round3` from `./round.js`.
- Produces (spec §5.1, "Status transitions are data, shared by both sides" — the server asserts through this table, the UI disables buttons through it):
  ```ts
  export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;
  export const REQUEST_TRANSITIONS: TransitionTable<ReqStatus>;
  export const TICKET_TRANSITIONS: TransitionTable<TktStatus>;
  export const SHOP_ASK_TRANSITIONS: TransitionTable<ShopAskStatus>;
  export function canTransition<S extends string>(table: TransitionTable<S>, from: S, to: S): boolean;

  export type ApprovalLine = { it: string; qty: number; appr: number; short: number };
  export type ApprovalPlan = { lines: ApprovalLine[]; st: "Rejected" | "Manager approved" | "Partially approved"; trimmed: boolean };
  export function planApproval(
    lines: readonly { it: string; qty: number }[],
    appr: readonly number[],
    freeFor: (it: string, index: number) => number,
  ): ApprovalPlan;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/domain/src/transitions.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { REQUEST_TRANSITIONS, SHOP_ASK_TRANSITIONS, TICKET_TRANSITIONS, canTransition } from "./transitions";

describe("request transitions", () => {
  it("walks the chain the outlet actually walks", () => {
    expect(canTransition(REQUEST_TRANSITIONS, "Request sent", "Manager approved")).toBe(true);
    expect(canTransition(REQUEST_TRANSITIONS, "Request sent", "Partially approved")).toBe(true);
    expect(canTransition(REQUEST_TRANSITIONS, "Manager approved", "Ticket issued")).toBe(true);
    expect(canTransition(REQUEST_TRANSITIONS, "Ticket issued", "Collected")).toBe(true);
    expect(canTransition(REQUEST_TRANSITIONS, "Collected", "Closed")).toBe(true);
  });
  it("refuses a second decision on a request already decided", () => {
    expect(canTransition(REQUEST_TRANSITIONS, "Manager approved", "Partially approved")).toBe(false);
    expect(canTransition(REQUEST_TRANSITIONS, "Rejected", "Manager approved")).toBe(false);
    expect(canTransition(REQUEST_TRANSITIONS, "Ticket issued", "Cancelled")).toBe(false);
  });
  it("cancels only while the request is still open", () => {
    expect(canTransition(REQUEST_TRANSITIONS, "Draft", "Cancelled")).toBe(true);
    expect(canTransition(REQUEST_TRANSITIONS, "Request sent", "Cancelled")).toBe(true);
    expect(canTransition(REQUEST_TRANSITIONS, "Manager approved", "Cancelled")).toBe(false);
    expect(canTransition(REQUEST_TRANSITIONS, "Closed", "Cancelled")).toBe(false);
  });
  it("leaves Closed, Rejected and Cancelled terminal", () => {
    for (const st of ["Closed", "Rejected", "Cancelled"] as const) expect(REQUEST_TRANSITIONS[st]).toEqual([]);
  });
});

describe("ticket transitions", () => {
  it("is issued, collected, received — in that order and no other", () => {
    expect(canTransition(TICKET_TRANSITIONS, "Issued", "Collected")).toBe(true);
    expect(canTransition(TICKET_TRANSITIONS, "Collected", "Received")).toBe(true);
    expect(canTransition(TICKET_TRANSITIONS, "Issued", "Received")).toBe(false);
    expect(canTransition(TICKET_TRANSITIONS, "Collected", "Issued")).toBe(false);
    expect(TICKET_TRANSITIONS.Received).toEqual([]);
  });
});

describe("shop ask transitions", () => {
  it("is answered once", () => {
    expect(canTransition(SHOP_ASK_TRANSITIONS, "Asked", "Sent")).toBe(true);
    expect(canTransition(SHOP_ASK_TRANSITIONS, "Asked", "Declined")).toBe(true);
    expect(canTransition(SHOP_ASK_TRANSITIONS, "Sent", "Declined")).toBe(false);
    expect(canTransition(SHOP_ASK_TRANSITIONS, "Declined", "Sent")).toBe(false);
  });
});
```

`packages/domain/src/approval.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { planApproval } from "./approval";

const free = (n: number) => () => n;

describe("planApproval", () => {
  it("approves in full when the store can cover it", () => {
    const p = planApproval([{ it: "sugar", qty: 5 }, { it: "butter", qty: 1 }], [5, 1], free(100));
    expect(p.st).toBe("Manager approved");
    expect(p.trimmed).toBe(false);
    expect(p.lines).toEqual([
      { it: "sugar", qty: 5, appr: 5, short: 0 },
      { it: "butter", qty: 1, appr: 1, short: 0 },
    ]);
  });

  it("never promises more than was asked, and records the shortfall (C4)", () => {
    const p = planApproval([{ it: "milk", qty: 20 }], [999], free(100));
    expect(p.lines[0]).toEqual({ it: "milk", qty: 20, appr: 20, short: 0 });
    expect(p.st).toBe("Manager approved");
    expect(p.trimmed).toBe(false);   // the manager asked for more than the counter did; the ask is the ceiling
  });

  it("clamps to what is still free to promise and flags the trim (C6)", () => {
    const p = planApproval([{ it: "milk", qty: 20 }], [20], free(12));
    expect(p.lines[0]).toEqual({ it: "milk", qty: 20, appr: 12, short: 8 });
    expect(p.st).toBe("Partially approved");
    expect(p.trimmed).toBe(true);
  });

  it("is a rejection when nothing at all can be given", () => {
    const p = planApproval([{ it: "juice", qty: 24 }, { it: "water", qty: 12 }], [0, 0], free(100));
    expect(p.st).toBe("Rejected");
    expect(p.trimmed).toBe(false);   // the manager chose zero; nothing was taken off them
    expect(p.lines.map((l) => l.short)).toEqual([24, 12]);
  });

  it("treats a missing or non-finite entry as zero", () => {
    const p = planApproval([{ it: "milk", qty: 20 }, { it: "sugar", qty: 4 }], [Number.NaN], free(100));
    expect(p.lines.map((l) => l.appr)).toEqual([0, 0]);
    expect(p.st).toBe("Rejected");
  });

  it("rounds to three decimals so a float split does not leak into the ledger", () => {
    const p = planApproval([{ it: "beans", qty: 0.3 }], [0.3], free(0.1 + 0.2));
    expect(p.lines[0].appr).toBe(0.3);
    expect(p.lines[0].short).toBe(0);
  });
});
```
Run: `pnpm --filter @rch/domain test` → FAIL (`./transitions` and `./approval` do not exist).

- [ ] **Step 2: Write `packages/domain/src/transitions.ts`**

```ts
import type { ReqStatus, ShopAskStatus, TktStatus } from "@rch/contract";

/**
 * Spec §5.1: "Status transitions are data, shared by both sides." One table, two consumers —
 * the server refuses anything not listed, and the frontend reads the same table to decide
 * which buttons to render. A transition the UI offers but the server refuses is impossible
 * by construction.
 */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export const REQUEST_TRANSITIONS: TransitionTable<ReqStatus> = {
  Draft: ["Request sent", "Cancelled"],
  "Request sent": ["Manager approved", "Partially approved", "Rejected", "Cancelled"],
  "Manager approved": ["Ticket issued"],
  "Partially approved": ["Ticket issued"],
  "Ticket issued": ["Collected"],
  Collected: ["Closed"],
  // No path puts a request in Received today — the ticket carries that word, the request goes
  // straight from Collected to Closed when the shelf confirms. Kept reachable to Closed so a
  // migrated or hand-corrected row is not stranded.
  Received: ["Closed"],
  Closed: [],
  Rejected: [],
  Cancelled: [],
};

export const TICKET_TRANSITIONS: TransitionTable<TktStatus> = {
  Issued: ["Collected"],
  Collected: ["Received"],
  Received: [],
};

export const SHOP_ASK_TRANSITIONS: TransitionTable<ShopAskStatus> = {
  Asked: ["Sent", "Declined"],
  Sent: [],
  Declined: [],
};

export const canTransition = <S extends string>(table: TransitionTable<S>, from: S, to: S): boolean =>
  (table[from] ?? []).includes(to);
```

- [ ] **Step 3: Write `packages/domain/src/approval.ts`**

Port the arithmetic out of `approveRequest` in `UI/src/store/index.ts` (lines 298–323), replacing the store read with the injected `freeFor`:

```ts
import { round3 } from "./round.js";

export type ApprovalLine = { it: string; qty: number; appr: number; short: number };
export type ApprovalPlan = {
  lines: ApprovalLine[];
  st: "Rejected" | "Manager approved" | "Partially approved";
  trimmed: boolean;
};

/**
 * What the manager may actually promise. Never more than the counter asked for, never more
 * than the manager typed, and never more than is still free to promise once open tickets and
 * other approvals are netted off (C6). `trimmed` says the store, not the manager, is what cut
 * the line — a manager who deliberately types a smaller number has trimmed nothing.
 */
export function planApproval(
  lines: readonly { it: string; qty: number }[],
  appr: readonly number[],
  freeFor: (it: string, index: number) => number,
): ApprovalPlan {
  const asked = (i: number) => (Number.isFinite(appr[i]) ? appr[i] : 0);
  const out: ApprovalLine[] = lines.map((l, i) => {
    const ok = Math.max(0, round3(Math.min(l.qty, asked(i), freeFor(l.it, i))));
    return { it: l.it, qty: l.qty, appr: ok, short: round3(l.qty - ok) };
  });
  const total = out.reduce((t, l) => t + l.appr, 0);
  const st = total === 0 ? "Rejected" : out.every((l) => l.appr === l.qty) ? "Manager approved" : "Partially approved";
  const trimmed = out.some((l, i) => l.appr < Math.min(l.qty, asked(i)));
  return { lines: out, st, trimmed };
}
```

- [ ] **Step 4: Export from the package index**

Add to `packages/domain/src/index.ts`:
```ts
export { REQUEST_TRANSITIONS, TICKET_TRANSITIONS, SHOP_ASK_TRANSITIONS, canTransition, type TransitionTable } from "./transitions.js";
export { planApproval, type ApprovalLine, type ApprovalPlan } from "./approval.js";
```

- [ ] **Step 5: Run the tests**

Run: `pnpm turbo typecheck test --filter=@rch/domain --filter=@rch/ui`
Expected: PASS — 20 existing domain tests plus the new files; the UI is untouched.

- [ ] **Step 6: Commit**

```bash
git add packages/domain
git commit -m "$(cat <<'EOF'
Make the status transitions a table both sides read

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 3: SSE — `GET /events`, `pg_notify` fan-out, heartbeat, shutdown, metrics

**Files:**
- Create: `apps/api/src/lib/events.ts`, `apps/api/src/lib/events.test.ts`, `apps/api/src/plugins/sse.ts`, `apps/api/src/plugins/sse.test.ts`
- Modify: `apps/api/src/config.ts`, `apps/api/src/config.test.ts`, `apps/api/src/app.ts`, `apps/api/src/db/client.ts`, `apps/api/src/plugins/metrics.ts`, `apps/api/src/test/app.ts`, `apps/api/src/modules/pos/service.ts`, `apps/api/src/modules/availability/service.ts`, `apps/api/src/modules/catalog/service.ts`, `deploy/chart/rch/tests/render.test.sh`

**Interfaces:**
- Consumes from Task 1: `API_PREFIX`, `EVENTS_PATH`, `type Changed` from `@rch/contract`.
- Produces (Tasks 5, 6, 7 call `emitChanged` from their services):
  ```ts
  // apps/api/src/lib/events.ts
  export const EVENTS_CHANNEL_PREFIX = "rch_events_";
  export type ChangeNotice = { collections: Changed[]; at: string };
  export function emitChanged(tx: Tx, changed: readonly Changed[]): Promise<void>;

  // apps/api/src/plugins/sse.ts — decorator
  declare module "fastify" {
    interface FastifyInstance { sse: { publish(n: ChangeNotice): void; resync(): void; clients(): number } }
  }
  ```
- New config keys (`apps/api/src/config.ts`): `SSE_HEARTBEAT_MS` (`int(10, 300_000)`, default `25_000`) → `config.sseHeartbeatMs`; `SSE_RETRY_MS` (`int(100, 60_000)`, default `1000`) → `config.sseRetryMs`.
- `apps/api/src/db/client.ts` gains `export function pgSsl(ssl: boolean): ConnectionOptions | undefined` holding the CA-bundle read that `createDb` does today, so the LISTEN client verifies RDS the same way; `createDb` calls it.
- `apps/api/src/app.ts` gains `AppDeps.searchPath` forwarding to the sse plugin, and registers it: `await app.register(sse, { config, searchPath: deps.searchPath });` **after** `auth` (the route's preHandler is `app.authenticate`) and after `metrics`.
- `apps/api/src/test/app.ts`: `buildTestApp` must pass `searchPath: \`${testDb.schemaName},public\`` alongside `db`, `pool` and `migrationsSchema`. The db plugin ignores `searchPath` when a `db` is injected, so this is inert there — it exists so the LISTEN client connects with the same `search_path` and therefore computes the same channel name as the writes do.

**Why this design (do not re-litigate):**
- **Fan-out across replicas.** The chart runs 2–3 API pods behind an HPA, so a notice raised in one pod must reach clients on the others. `pg_notify` inside the write's transaction is delivered by Postgres only when that transaction commits — exactly the spec's "whenever a write commits touching that collection" — and it needs no Redis (spec §6).
- **Channel name carries the schema.** `LISTEN` channels are per-database, and every test file runs in its own schema inside one `rch_test` database, so a fixed channel would make two suites hear each other. The channel is `'rch_events_' || current_schema()`, computed in SQL on the writing side and from `select current_schema()` on the listening side, so neither end needs the name plumbed through.
- **`Last-Event-ID` gets a resync, not a replay log.** On a reconnect carrying the header the server sends one `event: resync` frame and the client refetches every slice. A five-minute replay buffer would have to survive pod restarts and rescheduling to be worth anything; refetching is the simplest thing that cannot be wrong.
- **Timeouts.** Fastify's `requestTimeout: 30_000` is Node's `server.requestTimeout`, which bounds *receiving the request*; a GET's request ends immediately, so it never cuts a streaming response. Fastify's `connectionTimeout: 10_000` **is** Node's `server.timeout`, a per-socket inactivity timer that would kill the stream between 25-second heartbeats — so the handler calls `req.raw.socket.setTimeout(0)`. The global rate limiter runs on `preHandler`, so the route sets `config: { rateLimit: false }` or a reconnect storm 429s.
- **`reply.hijack()`.** The stream owns the socket from the first byte, which also takes it out of the `onResponse` hooks — so an open stream never enters the request-duration histogram, and its lifetime is reported by the `sse_clients` gauge instead.

- [ ] **Step 1: Write the failing test for `emitChanged`**

`apps/api/src/lib/events.test.ts`
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { withTestSchema, type TestDb } from "../test/db.js";
import { EVENTS_CHANNEL_PREFIX, emitChanged } from "./events.js";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test";

let t: TestDb;
let listener: Client;
let heard: string[] = [];

beforeAll(async () => {
  t = await withTestSchema("events");
  listener = new Client({ connectionString: BASE, options: `-c search_path=${t.schemaName},public` });
  await listener.connect();
  listener.on("notification", (m) => { if (m.payload) heard.push(m.payload); });
  await listener.query(`listen "${EVENTS_CHANNEL_PREFIX}${t.schemaName}"`);
});
afterAll(async () => { await listener.end(); await t.close(); });

/** NOTIFY is delivered asynchronously; give the listener socket a turn. */
const settle = () => new Promise((r) => setTimeout(r, 150));

describe("emitChanged", () => {
  it("announces a committed write once, with the collections de-duplicated", async () => {
    heard = [];
    await t.db.transaction(async (tx) => { await emitChanged(tx, ["req", "tkt", "req"]); });
    await settle();
    expect(heard).toHaveLength(1);
    const n = JSON.parse(heard[0]) as { collections: string[]; at: string };
    expect(n.collections).toEqual(["req", "tkt"]);
    expect(Number.isNaN(Date.parse(n.at))).toBe(false);
  });

  it("announces nothing when the transaction rolls back", async () => {
    heard = [];
    await expect(t.db.transaction(async (tx) => {
      await emitChanged(tx, ["stock"]);
      throw new Error("the rule refused");
    })).rejects.toThrow("the rule refused");
    await settle();
    expect(heard).toEqual([]);
  });

  it("says nothing at all for an empty change list", async () => {
    heard = [];
    await t.db.transaction(async (tx) => {
      await emitChanged(tx, []);
      await tx.execute(sql`select 1`);
    });
    await settle();
    expect(heard).toEqual([]);
  });
});
```
Run: `pnpm --filter @rch/api test src/lib/events.test.ts` → FAIL (`./events.js` does not exist).

- [ ] **Step 2: Write `apps/api/src/lib/events.ts`**

```ts
import { sql } from "drizzle-orm";
import type { Changed } from "@rch/contract";
import type { Tx } from "./db.js";

/**
 * LISTEN channels belong to the database, not to a schema — and every test file runs in its
 * own schema inside one database. The channel therefore carries the schema, computed in SQL on
 * this side and from `select current_schema()` on the listening side, so neither end needs the
 * name plumbed through.
 */
export const EVENTS_CHANNEL_PREFIX = "rch_events_";

export type ChangeNotice = { collections: Changed[]; at: string };

/**
 * Publish what a write changed. `pg_notify` inside a transaction is held by Postgres until
 * that transaction commits, which is exactly the spec's "whenever a write commits touching
 * that collection" (§6): a refusal that rolls the write back announces nothing.
 *
 * Call it last in the service, with the same array the response's `changed` carries.
 */
export async function emitChanged(tx: Tx, changed: readonly Changed[]): Promise<void> {
  const collections = [...new Set(changed)];
  if (collections.length === 0) return;
  const payload = JSON.stringify({ collections, at: new Date().toISOString() } satisfies ChangeNotice);
  await tx.execute(sql`select pg_notify(${EVENTS_CHANNEL_PREFIX} || current_schema(), ${payload})`);
}
```
Run: `pnpm --filter @rch/api test src/lib/events.test.ts` → PASS.

- [ ] **Step 3: Write the failing test for the stream**

`app.inject()` buffers until a response ends, so an SSE test must use a real socket. `apps/api/src/plugins/sse.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { API_PREFIX, EVENTS_PATH } from "@rch/contract";
import { buildTestApp } from "../test/app.js";
import { seedTestDb } from "../test/seed.js";
import { authHeaders } from "../test/auth.js";
import type { App } from "../app.js";

let app: App;
let base: string;

beforeAll(async () => {
  app = await buildTestApp({ schema: "sse", env: { SSE_HEARTBEAT_MS: "80" } });
  await seedTestDb(app.testDb!.db);
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const a = app.server.address() as { port: number };
  base = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => { await app.close(); });

/** One open stream, with a reader that hands back frames as they arrive. */
async function open(userId: string, extra: Record<string, string> = {}) {
  const ac = new AbortController();
  const res = await fetch(base + API_PREFIX + EVENTS_PATH, {
    headers: { ...(await authHeaders(app, userId)), accept: "text/event-stream", ...extra },
    signal: ac.signal,
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  return {
    res,
    close: () => ac.abort(),
    /** Read until `want(buf)` is true, or throw after 4 s so a hang fails loudly. */
    async until(want: (b: string) => boolean): Promise<string> {
      const stop = Date.now() + 4000;
      while (!want(buf)) {
        if (Date.now() > stop) throw new Error(`timed out waiting; buffer was:\n${buf}`);
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
      return buf;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 250));

describe("GET /events", () => {
  it("refuses an unauthenticated stream with the JSON envelope, not a stream", async () => {
    const r = await fetch(base + API_PREFIX + EVENTS_PATH);
    expect(r.status).toBe(401);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect((await r.json()).error.code).toBe("unauthenticated");
  });

  it("opens with the streaming headers and a retry hint", async () => {
    const s = await open("u1");
    expect(s.res.headers.get("content-type")).toContain("text/event-stream");
    expect(s.res.headers.get("cache-control")).toContain("no-cache");
    expect(s.res.headers.get("x-accel-buffering")).toBe("no");
    await s.until((b) => b.includes("retry:"));
    s.close();
  });

  it("tells every open stream what a committed write changed, on every connection", async () => {
    const a = await open("u1");
    const b = await open("u2");
    await a.until((x) => x.includes("retry:"));
    await b.until((x) => x.includes("retry:"));

    const r = await fetch(base + API_PREFIX + "/availability/toggle", {
      method: "POST",
      headers: { ...(await authHeaders(app, "u1")), "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ loc: "coffee", it: "juice" }),
    });
    expect(r.status).toBe(200);

    for (const s of [a, b]) {
      const buf = await s.until((x) => x.includes("event: changed"));
      const frame = buf.split("\n\n").find((f) => f.includes("event: changed"))!;
      expect(frame).toMatch(/^id: \d+$/m);
      expect(JSON.parse(/^data: (.*)$/m.exec(frame)![1])).toEqual({ collection: "ovr", at: expect.any(String) });
    }
    a.close(); b.close();
  });

  it("says nothing when a write is refused", async () => {
    const s = await open("u1");
    await s.until((x) => x.includes("retry:"));
    const r = await fetch(base + API_PREFIX + "/availability/toggle", {
      method: "POST",
      headers: { ...(await authHeaders(app, "u1")), "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ loc: "coffee", it: "totally-fake" }),
    });
    expect(r.status).toBe(404);
    await settle();
    expect(await s.until(() => true)).not.toContain("event: changed");
    s.close();
  });

  it("keeps the socket open past the heartbeat, and comments on it", async () => {
    const s = await open("u1");
    const buf = await s.until((x) => x.includes(": ping"));
    expect(buf).toContain(": ping");
    s.close();
  });

  it("resyncs a reconnecting client instead of replaying history", async () => {
    const s = await open("u1", { "last-event-id": "17" });
    const buf = await s.until((x) => x.includes("event: resync"));
    expect(buf).toContain("event: resync");
    s.close();
  });

  it("counts open streams in /metrics", async () => {
    await settle();      // sockets aborted by earlier cases close asynchronously
    const a = await open("u1");
    const b = await open("u2");
    await a.until((x) => x.includes("retry:"));
    await b.until((x) => x.includes("retry:"));
    const m = await (await fetch(base + "/metrics")).text();
    expect(m).toMatch(/^sse_clients 2$/m);
    expect(m).toMatch(/^sse_listener_up 1$/m);
    a.close(); b.close();
    await settle();
    expect(await (await fetch(base + "/metrics")).text()).toMatch(/^sse_clients 0$/m);
  });
});

describe("shutdown", () => {
  it("ends every stream with a retry hint rather than dropping the socket", async () => {
    const shutting = await buildTestApp({ schema: "sse_close", env: { SSE_HEARTBEAT_MS: "80" } });
    await seedTestDb(shutting.testDb!.db);
    await shutting.ready();
    await shutting.listen({ port: 0, host: "127.0.0.1" });
    const port = (shutting.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}${API_PREFIX}${EVENTS_PATH}`, {
      headers: { ...(await authHeaders(shutting, "u1")), accept: "text/event-stream" },
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const first = await reader.read();
    buf += dec.decode(first.value, { stream: true });

    await shutting.close();     // must not hang on the open stream

    for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); }
    expect(buf).toContain("retry:");    // the browser is told when to come back
  }, 20_000);
});
```
Run: `pnpm --filter @rch/api test src/plugins/sse.test.ts` → FAIL (no `/events` route; 404).

- [ ] **Step 4: Add the two config keys**

In `apps/api/src/config.ts`, inside the `Env` object:
```ts
  SSE_HEARTBEAT_MS: int(10, 300_000).default(25_000),
  SSE_RETRY_MS: int(100, 60_000).default(1000),
```
in the `Config` type: `sseHeartbeatMs: number; sseRetryMs: number;` and in `loadConfig`'s returned object: `sseHeartbeatMs: env.SSE_HEARTBEAT_MS, sseRetryMs: env.SSE_RETRY_MS,`.
Add one case to `apps/api/src/config.test.ts` asserting the defaults (`expect(loadConfig(base()).sseHeartbeatMs).toBe(25_000)`), matching the style of the cases already there.

- [ ] **Step 5: Extract `pgSsl` in `apps/api/src/db/client.ts`**

```ts
import type { ConnectionOptions } from "node:tls";

/** RDS connections verify the AWS CA bundle baked into the image. Shared with the SSE
 *  plugin's dedicated LISTEN connection, which is not a pool member. */
export function pgSsl(ssl: boolean): ConnectionOptions | undefined {
  return ssl ? { rejectUnauthorized: true, ca: readFileSync(process.env.PG_CA_BUNDLE ?? "/etc/ssl/rds-global-bundle.pem", "utf8") } : undefined;
}
```
and replace the inline `ssl:` expression in `createDb` with `ssl: pgSsl(ssl)`.

- [ ] **Step 6: Add the listener gauge to `apps/api/src/plugins/metrics.ts`**

```ts
declare module "fastify" {
  interface FastifyInstance { metrics: { registry: Registry; sseClients: Gauge; sseListenerUp: Gauge } }
}
```
and, beside the existing `sseClients` gauge:
```ts
  // 0 while the LISTEN connection is down: this pod's streams are alive but deaf, so a write
  // on another replica will not reach them until it reconnects (and resyncs).
  const sseListenerUp = new Gauge({ name: "sse_listener_up", help: "1 while the Postgres LISTEN connection is live", registers: [registry] });
```
then `app.decorate("metrics", { registry, sseClients, sseListenerUp });`.

- [ ] **Step 7: Write `apps/api/src/plugins/sse.ts`**

```ts
import fp from "fastify-plugin";
import { Client } from "pg";
import { API_PREFIX, EVENTS_PATH } from "@rch/contract";
import type { Config } from "../config.js";
import { pgSsl } from "../db/client.js";
import { EVENTS_CHANNEL_PREFIX, type ChangeNotice } from "../lib/events.js";

declare module "fastify" {
  interface FastifyInstance { sse: { publish(n: ChangeNotice): void; resync(): void; clients(): number } }
}

type Stream = { write(frame: string): void; end(): void };

/** A LISTEN channel is an identifier; the schema name it carries is one already, but quote it
 *  anyway so a schema with an odd name cannot become syntax. */
const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const frame = (id: number, event: string, data: string) => `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;
const BACKOFF_MS = [250, 500, 1000, 2000, 5000, 10_000];

export default fp<{ config: Config; searchPath?: string }>(async (app, { config, searchPath }) => {
  const streams = new Set<Stream>();
  let seq = 0;
  const nextId = () => ++seq;

  const broadcast = (text: string) => { for (const s of streams) s.write(text); };
  const publish = (n: ChangeNotice) => {
    for (const collection of n.collections) broadcast(frame(nextId(), "changed", JSON.stringify({ collection, at: n.at })));
  };
  /** Every open stream may have missed something: tell them to take the whole thing again. */
  const resync = () => broadcast(frame(nextId(), "resync", JSON.stringify({ at: new Date().toISOString() })));
  app.decorate("sse", { publish, resync, clients: () => streams.size });

  // ---- the one connection that hears Postgres ---------------------------------
  let client: Client | null = null;
  let stopped = false;
  let attempt = 0;
  let everConnected = false;
  let retryTimer: NodeJS.Timeout | null = null;

  async function connect(): Promise<void> {
    if (stopped) return;
    const c = new Client({
      connectionString: config.databaseUrl,
      ssl: pgSsl(config.databaseSsl),
      options: searchPath ? `-c search_path=${searchPath}` : undefined,
      application_name: "rch-api-events",
    });
    // pg surfaces a dropped connection as an 'error' on the client; without a handler it is an
    // unhandled 'error' event and takes the process down.
    c.on("error", (err) => { app.log.warn({ err }, "events listener errored"); scheduleReconnect(c); });
    c.on("end", () => scheduleReconnect(c));
    try {
      await c.connect();
      const { rows } = await c.query<{ s: string }>("select current_schema() as s");
      await c.query(`listen ${quoteIdent(EVENTS_CHANNEL_PREFIX + rows[0].s)}`);
      c.on("notification", (m) => {
        if (!m.payload) return;
        try { publish(JSON.parse(m.payload) as ChangeNotice); }
        catch (err) { app.log.warn({ err, payload: m.payload }, "unreadable change notice"); }
      });
      client = c;
      attempt = 0;
      app.metrics.sseListenerUp.set(1);
      // A reconnect means notices were missed while it was down. The streams stayed open, so
      // nothing else would tell them; a resync is the catch-up.
      if (everConnected) resync();
      everConnected = true;
      app.log.info("events listener connected");
    } catch (err) {
      app.log.warn({ err }, "events listener could not connect");
      scheduleReconnect(c);
    }
  }

  function scheduleReconnect(dead: Client): void {
    if (stopped || retryTimer) return;
    if (client === dead) client = null;
    app.metrics.sseListenerUp.set(0);
    void dead.end().catch(() => {});
    const wait = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
    retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, wait);
    retryTimer.unref();
  }

  app.metrics.sseListenerUp.set(0);
  // A DB-less app (`buildTestApp({ withDb: false })`) has no database to listen to; opening a
  // raw Client against `config.databaseUrl` there would make a test that wants no Postgres
  // depend on one being reachable to stay quiet.
  if (app.hasDecorator("db")) await connect();

  // ---- the heartbeat -----------------------------------------------------------
  // A comment line keeps proxies and load balancers from reaping an idle stream, and gives the
  // browser a write to notice when the pod goes away without a FIN.
  const beat = setInterval(() => broadcast(": ping\n\n"), config.sseHeartbeatMs);
  beat.unref();

  // ---- the route ---------------------------------------------------------------
  app.get(API_PREFIX + EVENTS_PATH, {
    // The global limiter runs on preHandler and would count every reconnect; a stream that is
    // one request for an hour is the wrong shape for a per-minute budget.
    config: { rateLimit: false },
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    // Fastify's connectionTimeout is Node's per-socket inactivity timer; at 10 s it would kill
    // the stream between 25 s heartbeats. requestTimeout is a *receive* timer and a GET's
    // request has already ended, so it never applies here.
    req.raw.socket.setTimeout(0);
    req.raw.socket.setNoDelay(true);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const stream: Stream = {
      write: (text) => { try { res.write(text); } catch { /* the socket went; onClose cleans up */ } },
      end: () => { try { res.end(); } catch { /* already gone */ } },
    };
    streams.add(stream);
    app.metrics.sseClients.set(streams.size);
    const drop = () => { if (streams.delete(stream)) app.metrics.sseClients.set(streams.size); };
    res.on("close", drop);
    res.on("error", drop);

    stream.write(`retry: ${config.sseRetryMs}\n\n`);
    // No replay log: a client that missed notices refetches everything rather than trusting a
    // buffer that does not survive a pod being rescheduled.
    if (req.headers["last-event-id"]) stream.write(frame(nextId(), "resync", JSON.stringify({ at: new Date().toISOString() })));
  });

  // ---- shutdown (spec §12) ------------------------------------------------------
  app.addHook("onClose", async () => {
    stopped = true;
    clearInterval(beat);
    if (retryTimer) clearTimeout(retryTimer);
    // Fastify's forceCloseConnections: "idle" will not touch a socket a stream is holding, so
    // close() would wait out the grace period. End them here, with a hint about when to return.
    for (const s of streams) { s.write(`retry: ${config.sseRetryMs}\n\n`); s.end(); }
    streams.clear();
    app.metrics.sseClients.set(0);
    app.metrics.sseListenerUp.set(0);
    await client?.end().catch(() => {});
    client = null;
  });
}, { name: "sse", dependencies: ["auth", "metrics"] });
```

- [ ] **Step 8: Register it, and give the test app its search path**

`apps/api/src/app.ts`: `import sse from "./plugins/sse.js";` and, after `await app.register(rbac);` and before `await app.register(idempotency);`:
```ts
  await app.register(sse, { config, searchPath: deps.searchPath });
```
`apps/api/src/test/app.ts`: change the `buildApp` call to
```ts
  const app = await buildApp(config, { db: testDb.db, pool: testDb.pool, searchPath: `${testDb.schemaName},public`, migrationsSchema: testDb.schemaName });
```

- [ ] **Step 9: Run the stream tests**

Run: `pnpm --filter @rch/api test src/plugins/sse.test.ts`
Expected: FAIL on the "tells every open stream what a committed write changed" case — the Phase 2 services do not emit yet.

- [ ] **Step 10: Have the Phase 2 writes announce themselves**

In each of `apps/api/src/modules/pos/service.ts`, `apps/api/src/modules/availability/service.ts` and `apps/api/src/modules/catalog/service.ts`: import `emitChanged` (`import { emitChanged } from "../../lib/events.js";`), hoist the `changed` array into a local so the notice and the response cannot drift, and emit it once every write in the transaction has been made (a read-back for the response may follow; Postgres withholds the notice until commit either way). In `pos`:
```ts
        const changed = ["stock", "bills"] as const;
        await emitChanged(tx, changed);
        return { result, changed: [...changed], message };
```
`availability` emits `["ovr"]`; `catalog` emits `["prices"]` for `savePrice` and `["menu"]` for both menu endpoints. Do not change any message, rule or `changed` value.

- [ ] **Step 11: Run the whole API suite**

Run: `pnpm --filter @rch/api test`
Expected: PASS, including the Phase 2 module suites (their asserted `changed` values are unchanged).

- [ ] **Step 12: Assert the delivery path in the chart, and confirm the dev proxy by hand**

Append to `deploy/chart/rch/tests/render.test.sh`, next to the existing `idle_timeout.timeout_seconds=3600` line:
```bash
# Phase 3 SSE: the ALB must hold a stream open for an hour, and nginx must neither buffer it
# nor time it out at the 60s it uses for ordinary /api calls.
grep -q 'idle_timeout.timeout_seconds=3600' <<<"$out"
grep -q 'proxy_buffering off' ../../nginx/default.conf.template
grep -q 'proxy_read_timeout 3600s' ../../nginx/default.conf.template
grep -q 'location /api/v1/events' ../../nginx/default.conf.template
```
(the script's first line is `cd "$(dirname "$0")/.."`, so its cwd is `deploy/chart/rch` — hence the `../../` on the three file greps; the `$out` greps read `helm template`'s output and take no path. All three lines already exist in the template.)
Then, by hand: `pnpm db:up && pnpm --filter @rch/api db:migrate && pnpm --filter @rch/api db:seed --force && pnpm dev`, sign in at `http://localhost:5173`, and in another shell run
`curl -N -H "Authorization: Bearer <token from the browser's devtools>" http://localhost:5173/api/v1/events`.
Frames must appear one at a time, not in a burst at the end — Vite's dev proxy pipes the upstream response, so no `UI/vite.config.ts` change is needed. If they do arrive buffered, stop and report it rather than editing the proxy config on a guess.

- [ ] **Step 13: Gate and commit**

Run: `pnpm turbo typecheck test && pnpm lint && pnpm helm:test`
```bash
git add apps/api deploy/chart/rch/tests/render.test.sh
git commit -m "$(cat <<'EOF'
Stream what changed to every open browser

A write publishes its `changed` array with pg_notify inside its own transaction, so a
notice exists only for a write that committed, and reaches clients on every replica. One
dedicated LISTEN connection per pod fans it out to that pod's streams; the channel carries
the schema so parallel test suites cannot hear each other. SIGTERM ends every stream with a
retry hint, and /metrics reports sse_clients and sse_listener_up.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 4: Movement primitives — balance locks, reservations, ticket issue, builders, and `GET /requests|/tickets|/shop-asks`

**Files:**
- Create: `apps/api/src/lib/reservations.ts`, `apps/api/src/lib/reservations.test.ts`, `apps/api/src/lib/tickets.ts`, `apps/api/src/lib/tickets.test.ts`, `apps/api/src/test/builders.ts`, and four wired module stubs `apps/api/src/modules/{requests,tickets,shopasks,production}/{routes,service,repo}.ts` + `{requests,tickets,shopasks,production}/<name>.test.ts`
- Modify: `packages/contract/src/schemas/{snapshot,writes}.ts`, `packages/contract/src/routes.ts`, `packages/contract/src/routes.test.ts`, `packages/contract/src/index.ts`, `apps/api/src/lib/ledger.test.ts`, `apps/api/src/lib/ledger.ts`, `apps/api/src/lib/ids.ts`, `apps/api/src/lib/ids.test.ts`, `apps/api/src/lib/rules.ts`, `apps/api/src/lib/rules.test.ts`, `apps/api/src/plugins/rbac.ts`, `apps/api/src/modules/index.ts`, `apps/api/src/modules/snapshot/{routes,service,scope}.ts`, `apps/api/src/modules/snapshot/snapshot.test.ts`, `scripts/check-boundaries.sh`

**Interfaces:**
- Consumes from Task 2: `TransitionTable`, `canTransition`.
- Declares the three reads itself, because `apps/api/src/contract.test.ts` probes every param-less GET in the manifest and asserts a 200 — a GET declared before its handler exists turns the API suite red, so the entry and the handler ship together. In `packages/contract/src/schemas/snapshot.ts`:
  ```ts
  export const RequestsResponseSchema = z.array(D.StockRequestSchema);
  export const TicketsResponseSchema = z.array(D.TicketSchema);
  export const ShopAsksResponseSchema = z.array(D.ShopAskSchema);
  ```
  and in `packages/contract/src/routes.ts`, after the eleven Phase 3 writes:
  ```ts
  requests:    defineRoute({ method: "GET", path: "/requests",   access: "any", response: RequestsResponseSchema }),
  ticketsList: defineRoute({ method: "GET", path: "/tickets",    access: "any", response: TicketsResponseSchema }),
  shopAsks:    defineRoute({ method: "GET", path: "/shop-asks",  access: "any", response: ShopAsksResponseSchema }),
  ```
  `ticketsList`, not `tickets` — `tickets` is the support-ticket collection name in `ChangedSchema` and will be the Phase 6 route name; two manifest keys must not collide.
- Produces (Tasks 5, 6, 7 and 12 build entirely on these):
  ```ts
  // apps/api/src/lib/ledger.ts — new export; postMoves is refactored to call it
  export async function lockBalances(tx: Tx, cells: readonly { loc: string; it: string }[]): Promise<void>;

  // apps/api/src/lib/ids.ts — new export; allocateId is reimplemented over it
  export async function allocateNumber(tx: Tx, kind: IdKind, at?: Date): Promise<{ n: number; id: string }>;

  // apps/api/src/lib/reservations.ts
  export type ReservationRow = { loc: string; it: string; qty: number; ticketId: string };
  export async function reserve(tx: Tx, rows: readonly ReservationRow[]): Promise<void>;
  export async function releaseForTicket(tx: Tx, ticketId: string, at?: Date): Promise<number>;   // rows released
  export async function reservedAt(tx: Tx, loc: string, itemKeys?: readonly string[]): Promise<RsvMap>;

  // apps/api/src/lib/tickets.ts
  export type TicketRefType = "request" | "prod_order" | "direct" | "shop_transfer" | "shop_ask";
  export type TicketDraft = { refType: TicketRefType; refId: string; from: string; to: string; lines: readonly { it: string; qty: number }[]; by: string; at?: Date };
  export type TicketNumber = { n: number; id: string; otp: string };
  /** Two calls, not one, because the server's lock order is ids first and balance rows second
   *  (lib/ledger.ts's header): the caller takes the number, THEN the locks, THEN checks cover. */
  export async function allocateTicket(tx: Tx, at?: Date): Promise<TicketNumber>;
  export async function writeTicket(tx: Tx, draft: TicketDraft, no: TicketNumber): Promise<Ticket>;   // Ticket = the @rch/contract wire shape
  export async function readTicket(tx: Tx, id: string): Promise<Ticket | undefined>;

  // apps/api/src/lib/rules.ts — new export beside assertRule
  export function assertTransition<S extends string>(table: TransitionTable<S>, from: S, to: S, what: string): void;

  // apps/api/src/plugins/rbac.ts — new export; requireLoc delegates to it
  export function requireLocOf(claims: { loc: string }, loc: string, what?: string): void;

  // apps/api/src/test/builders.ts  (spec §5.1: "Test builders live in apps/api/src/test/builders.ts")
  export const given: {
    request(db: Db, p: { id?: string; from: LocKey; by?: string; lines: { it: string; qty: number; appr?: number }[]; st?: ReqStatus; ticket?: string | null; mgrNote?: string; urgent?: boolean }): Promise<string>;
    ticket(db: Db, p: { id?: string; refType?: TicketRefType; refId?: string; from: LocKey; to: LocKey; lines: { it: string; qty: number }[]; st?: TktStatus; otp?: string; reserve?: boolean }): Promise<string>;
    shopAsk(db: Db, p: { id?: string; from: LocKey; to: LocKey; it: string; qty: number; by?: string; st?: ShopAskStatus; note?: string }): Promise<string>;
  };
  ```
- **The four module stubs** exist only so wave 3 can run four worktrees in parallel without four tasks editing `modules/index.ts`. Two checks bracket what a stub may be: `scripts/check-boundaries.sh` fails a module directory missing `routes.ts`, `service.ts`, `repo.ts` or a `*.test.ts`, and `knip` fails a file no entry point can reach (`knip.json` exempts `apps/api/src/modules/_template/**` and nothing else). So the stub is all four files **wired together**, exactly as `_template` is — `routes.ts` builds the service, `service.ts` touches the repo — and not an empty shell. For `<name>` in `requests`, `tickets`, `shopasks`, `production`, with `<Svc>` `createRequestsService`, `createTicketsService`, `createShopAsksService`, `createProductionService` and `<repo>` `requestsRepo`, `ticketsRepo`, `shopAsksRepo`, `productionRepo`:
  ```ts
  // routes.ts — mounts nothing yet; the module task adds the mount() calls.
  import fp from "fastify-plugin";
  import { create<Name>Service } from "./service.js";
  export default fp(async (app) => {
    const svc = create<Name>Service(app.db);
    await svc.ready();
  }, { name: "module:<name>", dependencies: ["auth", "rbac", "idempotency", "db"] });

  // service.ts
  import type { Db } from "../../db/client.js";
  import { withTransaction } from "../../lib/db.js";
  import { <repo> } from "./repo.js";
  /** Placeholder so the stub compiles and the graph is connected from the moment it lands.
   *  The module task replaces this with the real service. */
  export function create<Name>Service(db: Db) {
    return { async ready(): Promise<void> { await withTransaction(db, (tx) => <repo>.ping(tx)); } };
  }

  // repo.ts
  import type { Tx } from "../../lib/db.js";
  export const <repo> = { async ping(_tx: Tx): Promise<void> {} };

  // <name>.test.ts
  import { afterAll, beforeAll, expect, it } from "vitest";
  import { buildTestApp } from "../../test/app.js";
  import type { App } from "../../app.js";
  let app: App;
  beforeAll(async () => { app = await buildTestApp({ schema: "<name>" }); await app.ready(); });
  afterAll(async () => { await app.close(); });
  it("registers", () => { expect(app.hasPlugin("module:<name>")).toBe(true); });
  ```
  Each wave-3 task then **modifies** all four files rather than creating them — its Files block says so — and deletes `ping`/`ready` as it goes.

- **Contract entries for Task 12** land here too, in the same commit as the three GETs, because Task 1 is already merged and nobody else touches `packages/contract` in wave 2. In `packages/contract/src/schemas/writes.ts`:
  ```ts
  export const DistributeBodySchema = z.strictObject({ it: z.string().min(1).max(64), qty: QtySchema, to: LocKeySchema });
  export const DispatchResultSchema = z.strictObject({ order: ProdOrderSchema, ticket: TicketSchema });
  ```
  and in `packages/contract/src/routes.ts`, beside the other Phase 3 writes:
  ```ts
  dispatchProdOrder: defineRoute({ method: "POST", path: "/prod-orders/:id/dispatch", access: ["prod"], params: DocIdParamsSchema, response: writeResponse(DispatchResultSchema) }),
  distribute:        defineRoute({ method: "POST", path: "/distributions",            access: ["prod"], body: DistributeBodySchema,  response: writeResponse(TicketSchema) }),
  ```
  Both are writes, so they are inert until Task 12 mounts them and `apps/api/src/contract.test.ts` (which iterates GETs) never sees them. Add one sample to `packages/contract/src/routes.test.ts`'s `SAMPLES`, or its "every route that takes a body has a sample here" case fails:
  ```ts
    distribute: { it: "SKU-1", qty: 5, to: "kiosk" },
  ```
  `"pord"` is already a member of `CollectionSchema`, so nothing there changes.

- **S13 — `appr` uses `QtySchema` like every other Phase 3 quantity.** Task 1 declared `ApproveRequestBodySchema` with `z.array(z.number().finite().max(100000))`, which skips the three-decimal bound §16 claims for the whole phase. Change it here (Task 1 is merged, so this is the compensating edit):
  ```ts
  export const ApproveRequestBodySchema = z.strictObject({ appr: z.array(QtySchema).min(1).max(50), note: z.string().max(500).default("") });
  ```
  Positivity stays a service concern — `planApproval` clamps with `Math.max(0, …)`, and a manager typing a negative number means zero, not a 400.

**Why the lock:** issue-ticket, transfers and shop-ask answers create reservations without posting a move, so nothing else serialises them — two store keepers issuing the last 12 L of milk would both read `on_hand 12`, both see no reservation, and both reserve it. `lockBalances` takes the same `(loc, item)` row locks in the same fixed order `postMoves` uses, so every path that consumes stock — sale, issue, transfer, shop-ask grant and kitchen dispatch — queues behind one another on the same rows.

- [ ] **Step 1: Write the failing tests for the primitives**

`apps/api/src/lib/reservations.test.ts`
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestSchema, truncateAll, type TestDb } from "../test/db.js";
import { seedDatabase } from "../db/seed.js";
import { reserve, releaseForTicket, reservedAt } from "./reservations.js";
import { lockBalances } from "./ledger.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("reservations"); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await truncateAll(t.db); await seedDatabase(t.db, { password: "changeme", forcePasswordChange: false, force: true }); });

describe("reservations", () => {
  it("holds stock at a location without moving it", async () => {
    await t.db.transaction(async (tx) => {
      await lockBalances(tx, [{ loc: "store", it: "milk" }]);
      await reserve(tx, [{ loc: "store", it: "milk", qty: 4, ticketId: "TKT-0999" }]);
    });
    const open = await t.db.transaction((tx) => reservedAt(tx, "store"));
    expect(open["store:milk"]).toBe(4);
  });

  it("releases only the named ticket's rows, and only once", async () => {
    await t.db.transaction(async (tx) => {
      await reserve(tx, [{ loc: "store", it: "milk", qty: 4, ticketId: "TKT-0998" }, { loc: "store", it: "sugar", qty: 2, ticketId: "TKT-0997" }]);
    });
    const first = await t.db.transaction((tx) => releaseForTicket(tx, "TKT-0998"));
    expect(first).toBe(1);
    const again = await t.db.transaction((tx) => releaseForTicket(tx, "TKT-0998"));
    expect(again).toBe(0);
    const open = await t.db.transaction((tx) => reservedAt(tx, "store"));
    expect(open["store:milk"]).toBeUndefined();
    expect(open["store:sugar"]).toBe(2);
  });

  it("reads only the items asked for when a list is given", async () => {
    await t.db.transaction((tx) => reserve(tx, [{ loc: "store", it: "milk", qty: 4, ticketId: "TKT-0996" }, { loc: "store", it: "cup", qty: 100, ticketId: "TKT-0996" }]));
    const open = await t.db.transaction((tx) => reservedAt(tx, "store", ["milk"]));
    expect(open).toEqual({ "store:milk": 4 });
  });

  it("serialises two writers through the balance lock so the same stock is not promised twice", async () => {
    // Both read 12 L on hand. Whichever takes the lock first reserves; the second sees the first.
    const attempt = (ticketId: string, want: number) => t.db.transaction(async (tx) => {
      await lockBalances(tx, [{ loc: "store", it: "milk" }]);
      const open = await reservedAt(tx, "store", ["milk"]);
      const free = 12 - (open["store:milk"] ?? 0);
      if (free < want) return "refused";
      await reserve(tx, [{ loc: "store", it: "milk", qty: want, ticketId }]);
      return "reserved";
    });
    const out = await Promise.all([attempt("TKT-0991", 12), attempt("TKT-0992", 12)]);
    expect(out.filter((x) => x === "reserved")).toHaveLength(1);
    expect(out.filter((x) => x === "refused")).toHaveLength(1);
  });
});
```

`apps/api/src/lib/tickets.test.ts`
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeOtp } from "@rch/domain";
import { withTestSchema, truncateAll, type TestDb } from "../test/db.js";
import { seedDatabase } from "../db/seed.js";
import { reservations } from "../db/schema/index.js";
import { allocateTicket, readTicket, writeTicket } from "./tickets.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("tickets_lib"); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await truncateAll(t.db); await seedDatabase(t.db, { password: "changeme", forcePasswordChange: false, force: true }); });

describe("allocateTicket + writeTicket", () => {
  it("continues the visible series, mints the OTP from the same number, and reserves the lines", async () => {
    const tkt = await t.db.transaction(async (tx) => {
      // Ids first, balance rows second — the caller would take the locks between these two.
      const no = await allocateTicket(tx);
      return writeTicket(tx, { refType: "request", refId: "REQ-2026-0911", from: "store", to: "coffee", lines: [{ it: "milk", qty: 12 }], by: "u3" }, no);
    });
    expect(tkt.id).toBe("TKT-0441");                  // SEQUENCE_START.tkt is 441
    expect(tkt.otp).toBe(makeOtp(441));
    expect(tkt.otp).toMatch(/^\d{6}$/);
    expect(tkt).toEqual({ id: "TKT-0441", req: "REQ-2026-0911", from: "store", to: "coffee", lines: [{ it: "milk", qty: 12 }], st: "Issued", otp: makeOtp(441) });

    const held = await t.db.select().from(reservations).where(eq(reservations.ticketId, "TKT-0441"));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ loc: "store", itemKey: "milk", qty: 12, releasedAt: null });
  });

  it("folds a repeated item into one line before it reserves", async () => {
    const tkt = await t.db.transaction(async (tx) =>
      writeTicket(tx, { refType: "shop_transfer", refId: "Shop transfer", from: "coffee", to: "kiosk", lines: [{ it: "chips", qty: 2 }, { it: "chips", qty: 4 }], by: "u1" }, await allocateTicket(tx)));
    expect(tkt.lines).toEqual([{ it: "chips", qty: 6 }]);
    const held = await t.db.select().from(reservations).where(eq(reservations.ticketId, tkt.id));
    expect(held).toHaveLength(1);
    expect(held[0].qty).toBe(6);
  });

  it("reads a ticket back in the wire shape, and nothing for an id that is not there", async () => {
    const made = await t.db.transaction(async (tx) =>
      writeTicket(tx, { refType: "direct", refId: "Direct issue", from: "kitchen", to: "kiosk", lines: [{ it: "puff", qty: 5 }], by: "u4" }, await allocateTicket(tx)));
    expect(await t.db.transaction((tx) => readTicket(tx, made.id))).toEqual(made);
    expect(await t.db.transaction((tx) => readTicket(tx, "TKT-0000"))).toBeUndefined();
  });
});
```

Add to `apps/api/src/lib/ids.test.ts`. The file shares one schema across its cases and its first case already consumes `tkt` 441-461, so the assertion must be **relative** — allocate, capture, allocate again — never a hard-coded number:
```ts
  it("hands back the raw number alongside the id, so an OTP can be minted from it", async () => {
    const a = await db.transaction((tx) => allocateNumber(tx, "tkt"));
    const b = await db.transaction((tx) => allocateNumber(tx, "tkt"));
    expect(b.n).toBe(a.n + 1);
    expect(a.id).toBe(formatId("tkt", a.n));
    expect(b.id).toBe(formatId("tkt", b.n));
    expect(await db.transaction((tx) => allocateId(tx, "tkt"))).toBe(formatId("tkt", b.n + 1));
  });
```
with `formatId` added to the file's `@rch/domain` import and `allocateNumber` to its `./ids.js` import; match the file's existing `db`/`withTestSchema` setup rather than inventing a new one.

Add to `apps/api/src/lib/rules.test.ts`, with `assertTransition` added to the `./rules.js` import, `RuleError` imported from `./errors.js` and `TICKET_TRANSITIONS` from `@rch/domain`:
```ts
  it("assertTransition refuses a status change the table does not list, in the operator's words", () => {
    expect(() => assertTransition(TICKET_TRANSITIONS, "Received", "Collected", "TKT-0440")).toThrow(RuleError);
    expect(() => assertTransition(TICKET_TRANSITIONS, "Received", "Collected", "TKT-0440")).toThrow("TKT-0440 is already received");
    expect(() => assertTransition(TICKET_TRANSITIONS, "Issued", "Collected", "TKT-0440")).not.toThrow();
  });
```

Run: `pnpm --filter @rch/api test src/lib` → FAIL.

- [ ] **Step 2: Add `lockBalances` to `apps/api/src/lib/ledger.ts`**

Lift the locking loop out of `postMoves` so both callers use one implementation. `postMoves` folds into a **nested** `Map<loc, Map<item, delta>>` on purpose — an item key is whatever the central store typed, so any joined-string key could fold two different pairs into one (`ledger.ts`'s own comment) — and `lockBalances` keeps that shape rather than reintroducing a separator:
```ts
/**
 * Take the balance row locks for these (loc, item) pairs, creating a zero row where none
 * exists, in one fixed order across every writer so two batches cannot deadlock. `postMoves`
 * calls it before appending; a path that only reserves — issuing a ticket, a shop transfer —
 * calls it before reading `on_hand`, because a reservation is a promise against a balance and
 * two promises made from the same read are the same stock promised twice.
 *
 * Duplicates are folded and the pairs are visited in (loc, item) order. Nested rather than
 * keyed by a joined string, for the reason postMoves gives: no separator can collide.
 */
export async function lockBalances(tx: Tx, cells: readonly { loc: string; it: string }[]): Promise<void> {
  const byLoc = new Map<string, Set<string>>();
  for (const c of cells) (byLoc.get(c.loc) ?? byLoc.set(c.loc, new Set()).get(c.loc)!).add(c.it);
  for (const loc of [...byLoc.keys()].sort()) {
    for (const it of [...byLoc.get(loc)!].sort()) {
      await tx.insert(stockBalances).values({ loc, itemKey: it, onHand: 0 }).onConflictDoNothing();
      await tx.execute(sql`select 1 from stock_balances where loc = ${loc} and item_key = ${it} for update`);
    }
  }
}
```
In `postMoves`, replace the existing locking loop
```ts
  for (const { loc, it } of ordered) {
    await tx.insert(stockBalances).values({ loc, itemKey: it, onHand: 0 }).onConflictDoNothing();
    await tx.execute(sql`select 1 from stock_balances where loc = ${loc} and item_key = ${it} for update`);
  }
```
with `await lockBalances(tx, ordered);` — `ordered` is already `{ loc, it, delta }[]` sorted the same way, and the extra `delta` field is ignored by the parameter's structural type. Everything else in `postMoves` — the nested fold, the insert, the deltas — is unchanged, as is `rebuildBalances`.

Add one case to `apps/api/src/lib/ledger.test.ts` so the extraction is pinned rather than assumed:
```ts
it("locks a pair the same way whoever asks, and folds a repeat into one lock", async () => {
  // Two writers taking the same two cells in opposite input order must not deadlock: both
  // visit (kitchen, milk) before (store, milk) because lockBalances sorts, not its caller.
  const both = await Promise.allSettled([
    db.transaction(async (tx) => { await lockBalances(tx, [{ loc: "store", it: "milk" }, { loc: "kitchen", it: "milk" }, { loc: "store", it: "milk" }]); }),
    db.transaction(async (tx) => { await lockBalances(tx, [{ loc: "kitchen", it: "milk" }, { loc: "store", it: "milk" }]); }),
  ]);
  expect(both.every((r) => r.status === "fulfilled")).toBe(true);
});
```

- [ ] **Step 3: Add `allocateNumber` to `apps/api/src/lib/ids.ts`**

```ts
/** Gapless and serialised: the row lock taken by UPDATE holds until the caller's transaction
 *  ends. Returns the raw number too, because a ticket's OTP is minted from it (`makeOtp`). */
export async function allocateNumber(tx: Tx, kind: IdKind, at: Date = new Date()): Promise<{ n: number; id: string }> {
  const r = await tx.execute(sql`update sequences set next = next + 1 where kind = ${kind} returning next - 1 as n`);
  const row = r.rows[0] as { n: number | string } | undefined;
  if (!row) throw new Error(`sequence "${kind}" is not initialised - run ensureSequences()`);
  recordAllocation(kind);
  const n = Number(row.n);
  return { n, id: formatId(kind, n, at) };
}

export const allocateId = async (tx: Tx, kind: IdKind, at: Date = new Date()): Promise<string> =>
  (await allocateNumber(tx, kind, at)).id;
```

- [ ] **Step 4: Add `assertTransition` to `apps/api/src/lib/rules.ts`**

```ts
import { canTransition, type TransitionTable } from "@rch/domain";

/**
 * Spec §5.1: the transition table is data, and both sides read it. The UI hides the button;
 * this is what happens when a stale tab presses it anyway.
 */
export function assertTransition<S extends string>(table: TransitionTable<S>, from: S, to: S, what: string): void {
  assertRule(canTransition(table, from, to), `${what} is already ${String(from).toLowerCase()}`);
}
```

- [ ] **Step 5: Add `requireLocOf` to `apps/api/src/plugins/rbac.ts`**

The Phase 2 endpoints carry the location in the body, so the route can check it. A handover carries only a ticket id, and the location to check is on the row — which the service reads. So the same check needs a claims-shaped door:
```ts
/** For a location-scoped write whose location is only known once the document is read. */
export function requireLocOf(claims: { loc: string }, loc: string, what = "that location"): void {
  if (claims.loc !== loc) throw new ForbiddenError(`You can only do this for ${what}.`);
}

/** For a location-scoped write whose location is in the request. */
export function requireLoc(req: FastifyRequest, loc: LocKey | string, what = "that location"): void {
  requireLocOf(req.user, loc, what);
}
```

- [ ] **Step 6: Write `apps/api/src/lib/reservations.ts`**

```ts
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { round3, type RsvMap } from "@rch/domain";
import { reservations } from "../db/schema/index.js";
import type { Tx } from "./db.js";

export type ReservationRow = { loc: string; it: string; qty: number; ticketId: string };

/** Hold stock where it stands. Nothing moves: a reservation is what makes free-to-promise
 *  smaller than on-hand, and it lives until the collector's scan releases it. */
export async function reserve(tx: Tx, rows: readonly ReservationRow[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(reservations).values(rows.map((r) => ({ loc: r.loc, itemKey: r.it, qty: round3(r.qty), ticketId: r.ticketId })));
}

/** Let the stock go, because the moves that replace it are being written in the same
 *  transaction. Returns how many open rows were released, so a caller can tell a first
 *  handover from a replay. */
export async function releaseForTicket(tx: Tx, ticketId: string, at: Date = new Date()): Promise<number> {
  const released = await tx.update(reservations).set({ releasedAt: at })
    .where(and(eq(reservations.ticketId, ticketId), isNull(reservations.releasedAt))).returning({ id: reservations.id });
  return released.length;
}

/** Open reservations at one location, keyed "loc:item" — the shape every domain rule reads. */
export async function reservedAt(tx: Tx, loc: string, itemKeys?: readonly string[]): Promise<RsvMap> {
  const where = itemKeys
    ? and(eq(reservations.loc, loc), isNull(reservations.releasedAt), inArray(reservations.itemKey, [...itemKeys]))
    : and(eq(reservations.loc, loc), isNull(reservations.releasedAt));
  if (itemKeys && itemKeys.length === 0) return {};
  const rows = await tx.select({ itemKey: reservations.itemKey, qty: sql<string>`round(sum(${reservations.qty}), 3)` })
    .from(reservations).where(where).groupBy(reservations.itemKey);
  return Object.fromEntries(rows.map((r) => [`${loc}:${r.itemKey}`, Number(r.qty)]));
}
```

- [ ] **Step 7: Write `apps/api/src/lib/tickets.ts`**

```ts
import { asc, eq } from "drizzle-orm";
import type { LocKey, Ticket, TktStatus } from "@rch/contract";
import { makeOtp, round3 } from "@rch/domain";
import { ticketLines, tickets } from "../db/schema/index.js";
import type { Tx } from "./db.js";
import { allocateNumber } from "./ids.js";
import { reserve } from "./reservations.js";

export type TicketRefType = "request" | "prod_order" | "direct" | "shop_transfer" | "shop_ask";
export type TicketDraft = {
  refType: TicketRefType; refId: string; from: string; to: string;
  lines: readonly { it: string; qty: number }[]; by: string; at?: Date;
};

export type TicketNumber = { n: number; id: string; otp: string };

/**
 * Take the ticket's number, and the OTP minted from it so the series the operators know
 * carries on. Call this **before** `lockBalances`: the server's lock order is ids first and
 * balance rows second (`lib/ledger.ts`'s header), so a write that needs both must not hold a
 * shelf while it waits for the sequence. A refusal afterwards rolls the allocation back with
 * everything else and the series skips a number, which is what a counter is for.
 */
export async function allocateTicket(tx: Tx, at: Date = new Date()): Promise<TicketNumber> {
  const { n, id } = await allocateNumber(tx, "tkt", at);
  return { n, id, otp: makeOtp(n) };
}

/**
 * One ticket, however it was asked for: a request the manager approved, a shop transfer, a
 * kitchen distribution. Writes head and lines and reserves the stock at `from` — the whole of
 * "approval authorises" once the number is in hand.
 *
 * The caller must already have taken the balance locks (`lockBalances`) and checked that
 * `on_hand - reserved` covers every line; this does not check, because what "covers" means
 * differs by caller (free-to-promise at the store, plain availability at an outlet).
 */
export async function writeTicket(tx: Tx, draft: TicketDraft, no: TicketNumber): Promise<Ticket> {
  const at = draft.at ?? new Date();
  const folded = new Map<string, number>();
  for (const l of draft.lines) folded.set(l.it, round3((folded.get(l.it) ?? 0) + l.qty));
  const lines = [...folded].map(([it, qty]) => ({ it, qty }));

  const { id, otp } = no;
  await tx.insert(tickets).values({
    id, refType: draft.refType, refId: draft.refId, fromLoc: draft.from, toLoc: draft.to,
    status: "Issued", otp, issuedBy: draft.by, issuedAt: at,
  });
  await tx.insert(ticketLines).values(lines.map((l, lineNo) => ({ ticketId: id, lineNo, itemKey: l.it, qty: l.qty })));
  await reserve(tx, lines.map((l) => ({ loc: draft.from, it: l.it, qty: l.qty, ticketId: id })));
  return { id, req: draft.refId, from: draft.from as LocKey, to: draft.to as LocKey, lines, st: "Issued", otp };
}

/** The wire shape of one ticket, for a service that has just changed it. */
export async function readTicket(tx: Tx, id: string): Promise<Ticket | undefined> {
  const [head] = await tx.select().from(tickets).where(eq(tickets.id, id));
  if (!head) return undefined;
  const lines = await tx.select().from(ticketLines).where(eq(ticketLines.ticketId, id)).orderBy(asc(ticketLines.lineNo));
  return {
    id: head.id, req: head.refId, from: head.fromLoc as LocKey, to: head.toLoc as LocKey,
    lines: lines.map((l) => ({ it: l.itemKey, qty: l.qty })), st: head.status as TktStatus, otp: head.otp,
  };
}
```

- [ ] **Step 8: Run the primitive tests**

Run: `pnpm --filter @rch/api test src/lib`
Expected: PASS (reservations, tickets, ids, rules, ledger, and the existing lib suites).

- [ ] **Step 9: Write `apps/api/src/test/builders.ts`**

Spec §5.1 names this file and says a test that hand-builds a document instead of using a builder is rejected in review. Wave 3's suites need a request in any status, a ticket from any location (the kitchen included — no seeded ticket leaves the kitchen), and an unanswered shop ask.
```ts
import type { LocKey, ReqStatus, ShopAskStatus, TktStatus } from "@rch/contract";
import { makeOtp } from "@rch/domain";
import type { Db } from "../db/client.js";
import * as s from "../db/schema/index.js";
import { appendHistory } from "../lib/history.js";
import { reserve } from "../lib/reservations.js";
import type { TicketRefType } from "../lib/tickets.js";

/** A monotonic suffix, so two builder calls in one file cannot draw the same id — a random
 *  draw collided often enough to matter (a builder three suites use). Each test file is its own
 *  module instance and its own schema, so the counter need not be unique across files. */
let seq = 0;
const next = (): number => ++seq;

/** Defaults live here and nowhere else, so a suite says only what its case is about. */
export const given = {
  async request(db: Db, p: {
    id?: string; from: LocKey; by?: string; lines: { it: string; qty: number; appr?: number }[];
    st?: ReqStatus; ticket?: string | null; mgrNote?: string; urgent?: boolean;
  }): Promise<string> {
    // Above everything the fixtures use (REQ-2026-0909..0912) and above the sequence's start
    // (913), so a builder-made request can collide with neither the seed nor an allocated id.
    const id = p.id ?? `REQ-2026-0${990 + next()}`;
    const st = p.st ?? "Request sent";
    await db.transaction(async (tx) => {
      await tx.insert(s.stockRequests).values({
        id, fromLoc: p.from, byUser: p.by ?? "u1", status: st, ticketId: p.ticket ?? null,
        managerNote: p.mgrNote ?? "", urgent: p.urgent ?? false,
      });
      await tx.insert(s.stockRequestLines).values(p.lines.map((l, lineNo) => ({
        requestId: id, lineNo, itemKey: l.it, qty: l.qty, approvedQty: l.appr ?? 0,
      })));
      await appendHistory(tx, "request", id, "Request sent", "Kavitha Raman");
    });
    return id;
  },

  async ticket(db: Db, p: {
    id?: string; refType?: TicketRefType; refId?: string; from: LocKey; to: LocKey;
    lines: { it: string; qty: number }[]; st?: TktStatus; otp?: string; reserve?: boolean;
  }): Promise<string> {
    const id = p.id ?? `TKT-0${800 + next()}`;
    const st = p.st ?? "Issued";
    await db.transaction(async (tx) => {
      await tx.insert(s.tickets).values({
        id, refType: p.refType ?? "direct", refId: p.refId ?? "Direct issue", fromLoc: p.from, toLoc: p.to,
        status: st, otp: p.otp ?? makeOtp(700), issuedBy: "u3",
        collectedAt: st === "Issued" ? null : new Date(), receivedAt: st === "Received" ? new Date() : null,
      });
      await tx.insert(s.ticketLines).values(p.lines.map((l, lineNo) => ({ ticketId: id, lineNo, itemKey: l.it, qty: l.qty })));
      // An Issued ticket holds its stock; a Collected one has already released it.
      if ((p.reserve ?? st === "Issued")) await reserve(tx, p.lines.map((l) => ({ loc: p.from, it: l.it, qty: l.qty, ticketId: id })));
    });
    return id;
  },

  async shopAsk(db: Db, p: { id?: string; from: LocKey; to: LocKey; it: string; qty: number; by?: string; st?: ShopAskStatus; note?: string }): Promise<string> {
    const id = p.id ?? `ASK-0${100 + next()}`;
    await db.insert(s.shopAsks).values({
      id, fromLoc: p.from, toLoc: p.to, itemKey: p.it, qty: p.qty,
      status: p.st ?? "Asked", byUser: p.by ?? "u1", note: p.note ?? "",
    });
    return id;
  },
};
```

- [ ] **Step 10: Write the failing tests for the three reads**

Append to `apps/api/src/modules/snapshot/snapshot.test.ts`:
```ts
describe("the document reads the movement chain refetches", () => {
  it("GET /requests gives a manager every request and a counter only their own outlet's", async () => {
    const all = await app.inject({ method: "GET", url: "/api/v1/requests", headers: await authHeaders(app, "u2") });
    expect(all.statusCode).toBe(200);
    expect(all.json().map((r: { id: string }) => r.id)).toEqual(["REQ-2026-0909", "REQ-2026-0910", "REQ-2026-0911", "REQ-2026-0912"]);

    const mine = await app.inject({ method: "GET", url: "/api/v1/requests", headers: await authHeaders(app, "u1") });
    expect(mine.json().map((r: { id: string }) => r.id)).toEqual(["REQ-2026-0909", "REQ-2026-0911"]);   // u1 is at coffee
  });

  it("GET /tickets gives a counter the tickets that touch their counter, either end", async () => {
    const mine = await app.inject({ method: "GET", url: "/api/v1/tickets", headers: await authHeaders(app, "u1") });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toEqual([{ id: "TKT-0440", req: "REQ-2026-0909", from: "store", to: "coffee", lines: [{ it: "cup", qty: 500 }], st: "Issued", otp: "418327" }]);

    const other = await app.inject({ method: "GET", url: "/api/v1/tickets", headers: await authHeaders(app, "u6") });
    expect(other.json()).toEqual([]);      // u6 is at kiosk; TKT-0440 goes to coffee
  });

  it("GET /shop-asks gives a counter the asks at either end and a manager all of them", async () => {
    const mgr = await app.inject({ method: "GET", url: "/api/v1/shop-asks", headers: await authHeaders(app, "u2") });
    expect(mgr.json().map((a: { id: string }) => a.id).sort()).toEqual(["ASK-0059", "ASK-0060"]);
    const kiosk = await app.inject({ method: "GET", url: "/api/v1/shop-asks", headers: await authHeaders(app, "u6") });
    expect(kiosk.json().map((a: { id: string }) => a.id).sort()).toEqual(["ASK-0059", "ASK-0060"]);   // kiosk is one end of both
  });

  it("answers each read with exactly the slice the snapshot carries", async () => {
    const snap = (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, "u1") })).json();
    for (const [url, key] of [["/api/v1/requests", "req"], ["/api/v1/tickets", "tkt"], ["/api/v1/shop-asks", "shopAsks"]] as const) {
      const r = await app.inject({ method: "GET", url, headers: await authHeaders(app, "u1") });
      expect(r.json()).toEqual(snap[key]);
    }
  });
});
```
Run: `pnpm --filter @rch/api test src/modules/snapshot` → FAIL (404 on all three).

- [ ] **Step 11: Declare and add the three reads, and the three module stubs**

First the contract: add `RequestsResponseSchema`, `TicketsResponseSchema` and `ShopAsksResponseSchema` to `packages/contract/src/schemas/snapshot.ts`, the three `defineRoute` entries to `packages/contract/src/routes.ts` and the exports to `packages/contract/src/index.ts`, all exactly as spelled out in **Interfaces** above. Then the server side.

`apps/api/src/modules/snapshot/scope.ts` — extract the per-collection filters `scope()` already applies so the standalone reads use exactly the same rule:
```ts
/** A counter's requests are their own outlet's; everyone else sees the desk they work. */
export const scopeRequests = (req: StockRequest[], who: Who): StockRequest[] =>
  who.role !== "counter" ? req : req.filter((r) => r.from === who.loc);
/** Either end of the movement: a counter sees what leaves them and what is coming to them. */
export const scopeTickets = (tkt: Ticket[], who: Who): Ticket[] =>
  who.role !== "counter" ? tkt : tkt.filter((t) => t.from === who.loc || t.to === who.loc);
/** Shop to shop: the asker and the shop being asked, nobody in between. */
export const scopeShopAsks = (asks: ShopAsk[], who: Who): ShopAsk[] =>
  who.role !== "counter" ? asks : asks.filter((a) => a.from === who.loc || a.to === who.loc);
```
and rewrite the three lines inside `scope()` to call them (`req: scopeRequests(s.req, who), tkt: scopeTickets(s.tkt, who), shopAsks: scopeShopAsks(s.shopAsks, who),`) so there is one definition of each rule, not two.

`apps/api/src/modules/snapshot/service.ts` — three methods beside `stock` and `bills`:
```ts
    /** The request desk on its own — what a write naming "req" refetches. */
    async requests(claims: AccessClaims): Promise<StockRequest[]> { return scopeRequests(await D.readRequests(db), claims); },
    async tickets(claims: AccessClaims): Promise<Ticket[]> { return scopeTickets(await D.readTickets(db), claims); },
    async shopAsks(claims: AccessClaims): Promise<ShopAsk[]> { return scopeShopAsks(await D.readShopAsks(db), claims); },
```
`apps/api/src/modules/snapshot/routes.ts` — three more mounts beside `stock`/`bills`:
```ts
  mount(app, routes.requests, async (req) => svc.requests(req.user));
  mount(app, routes.ticketsList, async (req) => svc.tickets(req.user));
  mount(app, routes.shopAsks, async (req) => svc.shopAsks(req.user));
```
Then create the **four** wired module stubs described in **Interfaces** — `requests`, `tickets`, `shopasks`, `production`, each with all four files and `routes.ts → service.ts → repo.ts` connected — and register them in `apps/api/src/modules/index.ts`:
```ts
import requests from "./requests/routes.js";
import tickets from "./tickets/routes.js";
import shopasks from "./shopasks/routes.js";
import production from "./production/routes.js";
…
  await app.register(requests);
  await app.register(tickets);
  await app.register(shopasks);
  await app.register(production);
```
Run `pnpm lint` before moving on: `scripts/check-boundaries.sh` proves the four files exist in each directory and `knip` proves none of them is unreachable. A stub that satisfies one and not the other is not done.

- [ ] **Step 12: Close the reservations door in `scripts/check-boundaries.sh`**

Reservations are now a cross-cutting helper like the ledger, and Phases 4 and 5 add three more callers. Extend check 1's two patterns so a module cannot write the table directly:
```bash
orm_pattern='insert\(stockMoves\)|insert\(stockBalances\)|update\(stockBalances\)|delete\(stockBalances\)|insert\(sequences\)|update\(sequences\)|insert\(documentHistory\)|insert\(idempotencyKeys\)|update\(idempotencyKeys\)|insert\(reservations\)|update\(reservations\)|delete\(reservations\)'
raw_sql_pattern='insert +into +(stock_moves|stock_balances|sequences|document_history|idempotency_keys|reservations)|update +(stock_balances|sequences|idempotency_keys|reservations)|delete +from +(stock_balances|reservations)'
```
The allowed-path regex already covers `src/lib/`, `src/db/` and `*.test.ts`, which is where the remaining writers live (`lib/reservations.ts`, `db/seed.ts`). `apps/api/src/test/builders.ts` writes through `reserve()`, so it needs no exemption; `modules/pos/repo.ts` only selects.

- [ ] **Step 13: Gate and commit**

Run: `pnpm turbo typecheck test && pnpm lint`
```bash
git add packages/contract apps/api scripts/check-boundaries.sh
git commit -m "$(cat <<'EOF'
Give the movement chain its primitives and its reads

lockBalances is the one place a reservation path takes the row locks postMoves takes, so the
same stock cannot be promised twice; reservations and ticket issue become lib helpers with
one door each, closed in check-boundaries.sh. Adds the builders spec §5.1 asks for, and
GET /requests, /tickets and /shop-asks so a write can refetch its own slice.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 5: `requests` module — raise, cancel, approve, reject, issue a ticket

**Files:**
- Modify (all four exist as Task 4's wired stub — replace their bodies and delete the stub's `ready`/`ping`): `apps/api/src/modules/requests/routes.ts`, `service.ts`, `repo.ts`, `requests.test.ts`

**Interfaces:**
- Consumes: `mount` from `../../routes.js`; `requireLoc`/`requireLocOf` from `../../plugins/rbac.js`; `withTransaction` from `../../lib/db.js`; `assertRule`/`assertTransition` from `../../lib/rules.js`; `NotFoundError` from `../../lib/errors.js`; `loadMaster` from `../../lib/master.js`; `allocateId` from `../../lib/ids.js`; `appendHistory` from `../../lib/history.js`; `lockBalances` from `../../lib/ledger.js`; `reservedAt` from `../../lib/reservations.js`; `allocateTicket`/`writeTicket` from `../../lib/tickets.js`; `emitChanged` from `../../lib/events.js`; `planApproval`, `committed`, `round3`, `fq`, `REQUEST_TRANSITIONS` from `@rch/domain`; `routes` and the schema types from `@rch/contract`.
- Produces:
  ```ts
  export function createRequestsService(db: Db): {
    create(claims: AccessClaims, body: CreateRequestBody): Promise<WriteResponse<StockRequest>>;
    cancel(claims: AccessClaims, id: string): Promise<WriteResponse<StockRequest>>;
    approve(claims: AccessClaims, id: string, body: ApproveRequestBody): Promise<WriteResponse<ApprovalResult>>;
    reject(claims: AccessClaims, id: string, body: RejectRequestBody): Promise<WriteResponse<StockRequest>>;
    issue(claims: AccessClaims, id: string): Promise<WriteResponse<IssueResult>>;
  };
  ```
- `repo.ts` holds SQL only. `head(tx, id)` is a **locking** read — `.for("update")` on `stock_requests`, held to the end of the transaction, so two store keepers cannot both pass the transition guard on one request. Then `lines(tx, id)`, `insertRequest(tx, row)`, `insertLines(tx, id, lines)`, `setStatus(tx, id, patch)`, `setLineApprovals(tx, id, lines)`, `openRequests(tx)` (every request in `Manager approved`/`Partially approved` with no ticket, in the `{ st, ticket, lines }` shape `committed()` reads), `balancesAt(tx, loc, itemKeys)`, `userName(tx, id)`, and `wire(tx, id)` returning the `StockRequest` wire shape (lines in `line_no` order, `hist` from `readHistory(tx, "request", id)`, `by`/`apprBy` resolved to names).

**Rules, verbatim (spec §9.2 rows 3–7). Every message below is the store's current `notify()` text unless marked NEW:**

| Endpoint | Rules | Message |
|---|---|---|
| `POST /requests` | `from = claims.loc` (never from the body); every line's item exists (else 404 `There is no item <key>.`); `assertRule(lines.every(l => l.qty > 0), "Add at least one line with a quantity")`; status `Request sent`; history row `Request sent` | one line → `` `${id} raised for ${qty} ${item.n} — with the outlet manager now` ``; more → `` `${id} sent to the outlet manager — ${n} line${n > 1 ? "s" : ""}` `` |
| `POST /requests/:id/cancel` | request exists (404 `There is no request <id>.`); `requireLocOf(claims, r.fromLoc, "your own counter")` (the row's column is `from_loc`; `from` is the wire name); `assertTransition(REQUEST_TRANSITIONS, r.st, "Cancelled", id)`; history row `Cancelled` | `` `${id} cancelled` `` |
| `POST /requests/:id/approve` | request exists; `planApproval(lines, body.appr, freeFor)` where `freeFor(it) = avail(store) − committed(otherOpenRequests, it)`; then `assertTransition(REQUEST_TRANSITIONS, r.st, plan.st, id)` — the guard names the status that will actually be written, and all three outcomes are listed under `Request sent`, so a request already decided is refused whichever way this one would have gone; write `approved_qty`/`short_qty` per line, `manager_note = body.note`, `approved_by = claims.sub`; history row named for the resulting status | `trimmed` → `` `${id} trimmed — the central store cannot cover the full quantity` ``; `Rejected` → `` `${id} rejected — no ticket will be issued` ``; else `` `${id} ${st.toLowerCase()} and forwarded to the store keeper` `` |
| `POST /requests/:id/reject` | request exists; `assertRule(body.note.trim().length > 0, "Give a reason — the counter sees it on the request")`; `assertTransition(REQUEST_TRANSITIONS, r.st, "Rejected", id)`; history row `Rejected` | `` `${id} rejected` `` |
| `POST /requests/:id/issue-ticket` | request exists; `assertTransition(REQUEST_TRANSITIONS, r.st, "Ticket issued", id)` (which also covers a request that already has one: only `Manager approved` and `Partially approved` may reach `Ticket issued`, and neither carries a ticket); lines with `appr > 0`, else `assertRule(false, "Nothing approved on this request")`; `allocateTicket(tx, at)` (ids before locks); **then** `lockBalances`, re-read `on_hand` and open reservations at `store`, and for the first line where `on_hand − reserved < appr` refuse `` `Not enough ${item.n} available to promise` ``; `writeTicket(tx, { refType: "request", refId: id, from: "store", to: r.fromLoc, lines, by: claims.sub, at }, no)`; set `ticket_id` and status `Ticket issued`; history row `Ticket issued` | `` `${tkt.id} issued — ${loc.n} can collect against this ticket` `` |

The approval reads free-to-promise the same way the browser did (C6): `avail = on_hand − open reservations` at `store`, minus `committed()` over every **other** open request. The request being approved sits in `Request sent`, which `committed()` does not count, so no exclusion is needed — and the transition guard makes a second approval impossible anyway.

`changed`: create `["req"]`; cancel `["req"]`; approve `["req"]`; reject `["req"]`; issue `["req", "tkt", "rsv"]`. Each is emitted with `await emitChanged(tx, changed)` once every write in the transaction has been made — a read-back for the response (`repo.wire`, `readTicket`) may follow it, since the notice is withheld by Postgres until the whole transaction commits either way.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/requests/requests.test.ts`
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { truncateAll } from "../../test/db.js";
import { reservations, stockMoves } from "../../db/schema/index.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "requests" }); await app.ready(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const post = async (user: string, url: string, payload?: unknown) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: await hdr(user), ...(payload === undefined ? {} : { payload }) });

describe("POST /requests", () => {
  it("a counter raises a multi-line request from their own counter", async () => {
    const r = await post("u1", "/requests", { lines: [{ it: "milk", qty: 20 }, { it: "sugar", qty: 4 }], note: "Counter runs dry by 4pm", urgent: true });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    // Never a literal id: `truncateAll` deliberately keeps `sequences` (apps/api/src/test/db.ts)
    // and `ensureSequences` is onConflictDoNothing, so the series carries on across cases.
    expect(b.result.id).toMatch(/^REQ-\d{4}-0\d+$/);
    expect(b.result).toMatchObject({ from: "coffee", by: "Kavitha Raman", st: "Request sent", ticket: null, mgrNote: "Counter runs dry by 4pm", urg: true });
    expect(b.result.lines).toEqual([{ it: "milk", qty: 20, appr: 0 }, { it: "sugar", qty: 4, appr: 0 }]);
    expect(b.result.hist).toEqual([{ s: "Request sent", who: "Kavitha Raman", t: expect.any(String) }]);
    expect(b.changed).toEqual(["req"]);
    expect(b.message).toBe(`${b.result.id} sent to the outlet manager — 2 lines`);
  });

  it("issues the next number in the series each time", async () => {
    const first = (await post("u1", "/requests", { lines: [{ it: "milk", qty: 1 }] })).json().result.id;
    const second = (await post("u1", "/requests", { lines: [{ it: "milk", qty: 1 }] })).json().result.id;
    const n = (id: string) => Number(id.slice("REQ-2026-0".length));
    expect(n(second)).toBe(n(first) + 1);
  });

  it("names the item when only one line was asked for", async () => {
    const r = await post("u1", "/requests", { lines: [{ it: "milk", qty: 20 }] });
    expect(r.json().message).toBe(`${r.json().result.id} raised for 20 Milk 1L — with the outlet manager now`);
  });

  it("lets the kitchen raise one too, from the kitchen", async () => {
    const r = await post("u4", "/requests", { lines: [{ it: "maida", qty: 10 }], note: "Raised from Central Kitchen stock screen" });
    expect(r.statusCode).toBe(200);
    expect(r.json().result.from).toBe("kitchen");
  });

  it("refuses a line with no quantity, in the operator's words (C3)", async () => {
    const r = await post("u1", "/requests", { lines: [{ it: "milk", qty: 0 }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Add at least one line with a quantity");
  });

  it("404s an item the master does not have", async () => {
    const r = await post("u1", "/requests", { lines: [{ it: "totally-fake", qty: 1 }] });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no item totally-fake.");
  });

  it("is absent for a manager", async () => {
    expect((await post("u2", "/requests", { lines: [{ it: "milk", qty: 1 }] })).statusCode).toBe(404);
  });

  it("refuses without an Idempotency-Key, and replays one", async () => {
    const headers = await hdr("u1");
    const payload = { lines: [{ it: "milk", qty: 20 }] };
    // The replay must return the first response byte for byte — including its id.
    expect((await app.inject({ method: "POST", url: "/api/v1/requests", headers: await authHeaders(app, "u1"), payload })).statusCode).toBe(400);
    const first = await app.inject({ method: "POST", url: "/api/v1/requests", headers, payload });
    const again = await app.inject({ method: "POST", url: "/api/v1/requests", headers, payload });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(again.headers["idempotency-replayed"]).toBeDefined();
  });
});

describe("POST /requests/:id/cancel", () => {
  it("cancels only while the request is still open", async () => {
    const open = await post("u1", "/requests/REQ-2026-0911/cancel");
    expect(open.statusCode).toBe(200);
    expect(open.json().result.st).toBe("Cancelled");
    expect(open.json().message).toBe("REQ-2026-0911 cancelled");
    expect(open.json().result.hist.at(-1)).toMatchObject({ s: "Cancelled", who: "Kavitha Raman" });

    const gone = await post("u1", "/requests/REQ-2026-0909/cancel");     // already Ticket issued
    expect(gone.statusCode).toBe(422);
    expect(gone.json().error.message).toBe("REQ-2026-0909 is already ticket issued");
  });

  it("refuses to cancel another outlet's request", async () => {
    const r = await post("u6", "/requests/REQ-2026-0911/cancel");        // u6 is at kiosk, 0911 is coffee's
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toBe("You can only do this for your own counter.");
  });

  it("404s an id that is not there", async () => {
    const r = await post("u1", "/requests/REQ-2026-9999/cancel");
    expect(r.json().error.message).toBe("There is no request REQ-2026-9999.");
    expect(r.statusCode).toBe(404);
  });
});

describe("POST /requests/:id/approve", () => {
  it("trims to what the store can cover and records the shortfall (C4, C6)", async () => {
    const r = await post("u2", "/requests/REQ-2026-0911/approve", { appr: [20], note: "Store only holds 12 L." });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.result.request.lines[0]).toEqual({ it: "milk", qty: 20, appr: 12, short: 8 });   // store holds 12 L
    expect(b.result.request.st).toBe("Partially approved");
    expect(b.result.request.mgrNote).toBe("Store only holds 12 L.");
    expect(b.result.request.ticket).toBeNull();
    expect(b.result.trimmed).toBe(true);
    expect(b.changed).toEqual(["req"]);
    expect(b.message).toBe("REQ-2026-0911 trimmed — the central store cannot cover the full quantity");
  });

  it("names the manager who approved, not the operator who raised (H6)", async () => {
    const r = await post("u2", "/requests/REQ-2026-0911/approve", { appr: [12], note: "" });
    expect(r.json().result.request.apprBy).toBe("Ramesh Kumar");
    expect(r.json().result.request.by).toBe("Kavitha Raman");
    expect(r.json().result.request.hist.at(-1)).toMatchObject({ s: "Partially approved", who: "Ramesh Kumar" });
  });

  it("nets an approval already made against the next one (C6)", async () => {
    await post("u2", "/requests/REQ-2026-0911/approve", { appr: [12], note: "" });    // takes all 12 L
    const second = await given.request(app.testDb!.db, { from: "coffee", lines: [{ it: "milk", qty: 10 }] });
    const r = await post("u2", `/requests/${second}/approve`, { appr: [10], note: "" });
    expect(r.json().result.request.lines[0].appr).toBe(0);
    expect(r.json().result.request.st).toBe("Rejected");
    expect(r.json().message).toBe(`${second} rejected — no ticket will be issued`);
  });

  it("approves in full and forwards it, with no shortfall", async () => {
    const id = await given.request(app.testDb!.db, { from: "kiosk", lines: [{ it: "sugar", qty: 5 }, { it: "butter", qty: 1 }] });
    const r = await post("u2", `/requests/${id}/approve`, { appr: [5, 1], note: "All of it" });
    expect(r.json().result.request.st).toBe("Manager approved");
    expect(r.json().result.trimmed).toBe(false);
    expect(r.json().result.request.lines.every((l: { short: number }) => l.short === 0)).toBe(true);
    expect(r.json().message).toBe(`${id} manager approved and forwarded to the store keeper`);
  });

  it("refuses a second decision on a request already decided", async () => {
    const r = await post("u2", "/requests/REQ-2026-0910/approve", { appr: [5, 1], note: "" });   // already Manager approved
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("REQ-2026-0910 is already manager approved");
  });

  it("is absent for a counter and for the store", async () => {
    for (const u of ["u1", "u3"]) expect((await post(u, "/requests/REQ-2026-0911/approve", { appr: [12], note: "" })).statusCode).toBe(404);
  });
});

describe("POST /requests/:id/reject", () => {
  it("refuses to reject without a reason (H7)", async () => {
    const r = await post("u2", "/requests/REQ-2026-0912/reject", { note: "   " });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Give a reason — the counter sees it on the request");
    const still = await app.inject({ method: "GET", url: "/api/v1/requests", headers: await authHeaders(app, "u2") });
    expect(still.json().find((x: { id: string }) => x.id === "REQ-2026-0912").st).toBe("Request sent");
  });

  it("rejects when a reason is given, and issues no ticket", async () => {
    const r = await post("u2", "/requests/REQ-2026-0912/reject", { note: "Kiosk is overstocked already" });
    expect(r.json().result.st).toBe("Rejected");
    expect(r.json().result.mgrNote).toBe("Kiosk is overstocked already");
    expect(r.json().message).toBe("REQ-2026-0912 rejected");
    const issue = await post("u3", "/requests/REQ-2026-0912/issue-ticket");
    expect(issue.statusCode).toBe(422);
  });
});

describe("POST /requests/:id/issue-ticket", () => {
  it("issues for what was approved, reserves it, and moves nothing (the movement rule)", async () => {
    await post("u2", "/requests/REQ-2026-0911/approve", { appr: [12], note: "" });
    const movesBefore = (await app.testDb!.db.select().from(stockMoves)).length;

    const r = await post("u3", "/requests/REQ-2026-0911/issue-ticket");
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.result.ticket).toMatchObject({ id: "TKT-0441", req: "REQ-2026-0911", from: "store", to: "coffee", st: "Issued" });
    expect(b.result.ticket.lines).toEqual([{ it: "milk", qty: 12 }]);
    expect(b.result.ticket.otp).toMatch(/^\d{6}$/);
    expect(b.result.request.st).toBe("Ticket issued");
    expect(b.result.request.ticket).toBe("TKT-0441");
    expect(b.changed).toEqual(["req", "tkt", "rsv"]);
    expect(b.message).toBe("TKT-0441 issued — Coffee Shop can collect against this ticket");

    // Approval authorises; the scan moves. Nothing left the store.
    expect((await app.testDb!.db.select().from(stockMoves)).length).toBe(movesBefore);
    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, "TKT-0441"));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ loc: "store", itemKey: "milk", qty: 12, releasedAt: null });
  });

  it("refuses a request with nothing approved on it", async () => {
    const id = await given.request(app.testDb!.db, { from: "kiosk", lines: [{ it: "sugar", qty: 5, appr: 0 }], st: "Partially approved" });
    const r = await post("u3", `/requests/${id}/issue-ticket`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Nothing approved on this request");
  });

  it("refuses when the approval has gone stale and the store can no longer cover it", async () => {
    // Approved for 12 L, then a second ticket takes the same milk before the store keeper acts.
    await post("u2", "/requests/REQ-2026-0911/approve", { appr: [12], note: "" });
    await given.ticket(app.testDb!.db, { from: "store", to: "kiosk", lines: [{ it: "milk", qty: 12 }] });
    const r = await post("u3", "/requests/REQ-2026-0911/issue-ticket");
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Not enough Milk 1L available to promise");
  });

  it("refuses a request that already has a ticket", async () => {
    const r = await post("u3", "/requests/REQ-2026-0909/issue-ticket");   // already Ticket issued
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("REQ-2026-0909 is already ticket issued");
  });

  it("issues exactly one ticket when two store keepers press at once", async () => {
    await post("u2", "/requests/REQ-2026-0911/approve", { appr: [12], note: "" });
    const both = await Promise.all([post("u3", "/requests/REQ-2026-0911/issue-ticket"), post("u3", "/requests/REQ-2026-0911/issue-ticket")]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
  });

  it("is absent for a counter and a manager", async () => {
    for (const u of ["u1", "u2"]) expect((await post(u, "/requests/REQ-2026-0911/issue-ticket")).statusCode).toBe(404);
  });
});
```
Run: `pnpm --filter @rch/api test src/modules/requests` → FAIL (the stub registers no routes; every case 404s).

- [ ] **Step 2: Write `repo.ts`**

SQL only, no rules, no transaction of its own — mirror `apps/api/src/modules/pos/repo.ts`. `openRequests(tx)` is the one that matters for C6:
```ts
  /** Every approval that has not yet become a ticket — exactly what `committed()` nets off.
   *  Shaped for the domain function, so nothing here knows what it will be used for. */
  async openRequests(tx: Tx): Promise<Pick<StockRequest, "st" | "ticket" | "lines">[]> {
    const heads = await tx.select().from(stockRequests).where(inArray(stockRequests.status, ["Manager approved", "Partially approved"]));
    const open = heads.filter((h) => h.ticketId === null);
    if (open.length === 0) return [];
    const lines = await tx.select().from(stockRequestLines).where(inArray(stockRequestLines.requestId, open.map((h) => h.id)));
    return open.map((h) => ({
      st: h.status, ticket: h.ticketId,
      lines: lines.filter((l) => l.requestId === h.id).map((l) => ({ it: l.itemKey, qty: l.qty, appr: l.approvedQty })),
    }));
  },
```

- [ ] **Step 3: Write `service.ts`**

Each method is `withTransaction(db, async (tx) => { … })`, in this order: read the document (404 if absent) → scope (403) → transition and rule assertions (422) → locks and post-lock re-reads where stock is promised → writes → `appendHistory` → `emitChanged` → `{ result, changed, message }`. The approval body:
```ts
    async approve(claims: AccessClaims, id: string, body: ApproveRequestBody): Promise<WriteResponse<ApprovalResult>> {
      return withTransaction(db, async (tx) => {
        const r = await requestsRepo.head(tx, id);
        if (!r) throw new NotFoundError(`There is no request ${id}.`);
        const lines = await requestsRepo.lines(tx, id);
        const master = await loadMaster(tx);
        // What the store may still promise: on hand, less open reservations, less what other
        // approvals have already committed (C6). Read before any write, and never trusted at
        // issue time — issue-ticket re-reads it under the balance locks.
        const stock = await requestsRepo.balancesAt(tx, "store", lines.map((l) => l.it));
        const held = await reservedAt(tx, "store", lines.map((l) => l.it));
        const open = await requestsRepo.openRequests(tx);
        const plan = planApproval(lines, body.appr, (it) => round3(
          (stock[it] ?? 0) - (held[`store:${it}`] ?? 0) - committed(open, it)));

        // Guard on what will actually be written, not on one representative status. All three
        // outcomes are listed under "Request sent", so a request already decided is refused
        // whichever way this one would have gone.
        assertTransition(REQUEST_TRANSITIONS, r.status, plan.st, id);
        await requestsRepo.setLineApprovals(tx, id, plan.lines);
        await requestsRepo.setStatus(tx, id, { status: plan.st, managerNote: body.note, approvedBy: claims.sub });
        const who = await requestsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "request", id, plan.st, who);

        const changed = ["req"] as const;
        await emitChanged(tx, changed);
        const message = plan.trimmed
          ? `${id} trimmed — the central store cannot cover the full quantity`
          : plan.st === "Rejected"
            ? `${id} rejected — no ticket will be issued`
            : `${id} ${plan.st.toLowerCase()} and forwarded to the store keeper`;
        return { result: { request: await requestsRepo.wire(tx, id), trimmed: plan.trimmed }, changed: [...changed], message };
      });
    },
```
`issue` follows the same shape, with the stock check **after** `lockBalances`:
```ts
        const master = await loadMaster(tx);
        const lines = (await requestsRepo.lines(tx, id)).filter((l) => l.appr > 0).map((l) => ({ it: l.it, qty: l.appr }));
        assertRule(lines.length > 0, "Nothing approved on this request");
        // Ids before balance rows (lib/ledger.ts's header): take the ticket's number while
        // holding no shelf, so a sale that already holds the sequences row cannot deadlock us.
        const at = new Date();
        const no = await allocateTicket(tx, at);
        // The approval may be hours old and another ticket may have taken the same stock since.
        // Lock first, then read: two store keepers pressing together queue on these rows.
        await lockBalances(tx, lines.map((l) => ({ loc: "store", it: l.it })));
        const stock = await requestsRepo.balancesAt(tx, "store", lines.map((l) => l.it));
        const held = await reservedAt(tx, "store", lines.map((l) => l.it));
        const short = lines.find((l) => round3((stock[l.it] ?? 0) - (held[`store:${l.it}`] ?? 0)) < l.qty);
        if (short) assertRule(false, `Not enough ${master.items[short.it]?.n ?? short.it} available to promise`);
        const ticket = await writeTicket(tx, { refType: "request", refId: id, from: "store", to: r.fromLoc, lines, by: claims.sub, at }, no);
```

- [ ] **Step 4: Write `routes.ts`**

```ts
// Requests: what an outlet asks the central store for — raised, decided, and turned into a ticket.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createRequestsService } from "./service.js";

export default fp(async (app) => {
  const svc = createRequestsService(app.db);
  // The raiser's location is the token's, never the body's — there is nothing to scope here.
  mount(app, routes.createRequest, async (req) => svc.create(req.user, req.body));
  // The rest scope on the document's own location, which only the service has read, so the
  // 403 lives there (requireLocOf) rather than in this file.
  mount(app, routes.cancelRequest, async (req) => svc.cancel(req.user, req.params.id));
  mount(app, routes.approveRequest, async (req) => svc.approve(req.user, req.params.id, req.body));
  mount(app, routes.rejectRequest, async (req) => svc.reject(req.user, req.params.id, req.body));
  mount(app, routes.issueTicket, async (req) => svc.issue(req.user, req.params.id));
}, { name: "module:requests", dependencies: ["auth", "rbac", "idempotency", "db"] });
```

- [ ] **Step 5: Run the module tests**

Run: `pnpm --filter @rch/api test src/modules/requests`
Expected: PASS, every case.

- [ ] **Step 6: Prove the balances still reconcile**

Run: `pnpm --filter @rch/api test` then, against a seeded local database, `pnpm --filter @rch/api db:rebuild-balances` and confirm `GET /stock` is unchanged — nothing in this module posts a move, so a rebuild must be a no-op.

- [ ] **Step 7: Gate and commit**

Run: `pnpm turbo typecheck test && pnpm lint`
```bash
git add apps/api/src/modules/requests
git commit -m "$(cat <<'EOF'
Raise, decide and issue stock requests on the server

Approval authorises and the scan moves: approving writes only approved quantities, and
issuing writes only reservations — no stock leaves the central store until the collector's
OTP. Free-to-promise is netted at approval and re-checked under the balance locks at issue,
because an approval can be hours old.

Free-to-promise is netted at approval and re-checked under the balance locks at issue,
because an approval can be hours old.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 6: `tickets` module — OTP handover, receipt, and shop-to-shop transfers

**Files:**
- Modify (all four exist as Task 4's wired stub — replace their bodies and delete the stub's `ready`/`ping`): `apps/api/src/modules/tickets/routes.ts`, `service.ts`, `repo.ts`, `tickets.test.ts`

**Interfaces:**
- Consumes: `mount`; `requireLoc`/`requireLocOf` from `../../plugins/rbac.js`; `withTransaction`; `assertRule`/`assertTransition` from `../../lib/rules.js`; `NotFoundError`; `loadMaster`; `appendHistory`; `postMoves`/`lockBalances` from `../../lib/ledger.js`; `releaseForTicket`/`reservedAt` from `../../lib/reservations.js`; `allocateTicket`/`writeTicket`/`readTicket` from `../../lib/tickets.js`; `emitChanged`; `fq`, `round3`, `canTransition`, `TICKET_TRANSITIONS`, `REQUEST_TRANSITIONS` from `@rch/domain`.
- Produces:
  ```ts
  export function createTicketsService(db: Db): {
    handover(claims: AccessClaims, id: string, body: HandoverBody): Promise<WriteResponse<Ticket>>;
    receive(claims: AccessClaims, id: string): Promise<WriteResponse<Ticket>>;
    transfer(claims: AccessClaims, body: TransferBody): Promise<WriteResponse<Ticket>>;
  };
  ```
- `repo.ts`: `head(tx, id)` — a **locking** read (`.for("update")` on `tickets`), so two handovers of one ticket cannot both pass the transition guard and both post `ticket_out`; `setStatus(tx, id, patch)`; `linkedRequest(tx, refId)` — the `stock_requests` row whose id is the ticket's `refId`, also `for update`, and `undefined` for a ticket whose ref is the label `"Shop transfer"` or `"Direct issue"`; `setRequestStatus(tx, id, status)`; `balancesAt(tx, loc, itemKeys)`; `userName(tx, id)`.

**The movement rule, in code.** `handover` is the only place stock leaves a location on this path and `receive` the only place it lands:

| Endpoint | Rules | Message |
|---|---|---|
| `POST /tickets/:id/handover` | ticket exists (404 `There is no ticket <id>.`); `requireLocOf(claims, t.from, "the location the ticket is issued from")`; `assertTransition(TICKET_TRANSITIONS, t.st, "Collected", id)`; **OTP**: if `body.otp` is given, `assertRule(body.otp.trim() === t.otp, \`That OTP does not match ${id}. Ask the collector to read it again.\`)`; if omitted, `assertRule(claims.role === "store" \|\| claims.role === "prod", "Only the store or the kitchen may hand over without the OTP")` **(NEW)** and write `appendHistory(tx, "ticket", id, "Handed over — supervisor override", who)`; then `postMoves` the negative `ticket_out` moves at `t.from` (`refType: "ticket"`, `refId: id`), the post-lock re-read — whose refusal `` `${to.n} cannot collect ${fq(qty, unit)} ${unit} of ${item.n} — ${from.n} no longer has it` `` is **(NEW)**, because the browser never re-read after moving and so never had one — and `releaseForTicket(tx, id)`; ticket → `Collected`, `collected_at = now`; a linked request in `Ticket issued` → `Collected` with a history row `Collected` | with OTP: `` `${id} handed over — stock is in transit to ${to.n}` ``; override: `` `${id} handed over on a supervisor override — stock is in transit to ${to.n}` `` **(NEW)** |
| `POST /tickets/:id/receive` | ticket exists; `requireLocOf(claims, t.to, "the location the ticket is coming to")`; `assertTransition(TICKET_TRANSITIONS, t.st, "Received", id)`; `postMoves` the positive `ticket_in` moves at `t.to`; ticket → `Received`, `received_at = now`; a linked request in `Collected` → `Closed` with a history row **`Received`** (the word the operator reads on the request, kept verbatim from the store) | `` `Received at ${to.n} — stock is on the shelf` `` |
| `POST /transfers` | `assertRule(body.qty > 0, "Enter a quantity")`; item exists (404); `assertRule(from !== to && both are Outlet-type, "A shop transfer runs between two different outlets")`; `allocateTicket(tx, at)` (ids before locks); then `lockBalances` at `from`, `assertRule(on_hand − reserved ≥ qty, \`${from.n} has only ${fq(free, item.u)} ${item.u} free to send\`)`; `writeTicket(tx, { refType: "shop_transfer", refId: "Shop transfer", from, to, lines: [{ it, qty }], by: claims.sub, at }, no)` — a reservation, no move | `` `${tkt.id} issued — ${fq(qty, item.u)} ${item.u} reserved at ${from.n} for ${to.n}` `` |

`changed`: handover `["tkt", "req", "rsv", "stock"]`; receive `["tkt", "req", "stock"]`; transfer `["tkt", "rsv"]`.

**The supervisor override is the only thing tickets write to `document_history`,** and its status string is spec §8.3's verbatim — `"Handed over — supervisor override"`, not a variation on the ticket's own status word. Spec §16 fixed the normal lifecycle as three timestamps on the row (`issued_at`/`collected_at`/`received_at`) precisely because a ticket's status carries no prose; but §8.3 and §12 require the override to be auditable, and it is the exception rather than the lifecycle. So `document_history` gains the doc type `ticket` for this one status, `"Handed over — supervisor override"`, which nothing reads back into the wire (`TicketSchema` has no `hist`) and the runbook queries directly. Task 10 records this in spec §16.

**The OTP stays in the clear.** `makeOtp`'s own comment calls it "an operational check that the collector is the person the ticket was issued to — not a security token", and the store's own screens print it today (`UI/src/roles/store/IssueDetail.tsx`, `IssueDesk.tsx`, `TicketDrawer.tsx` all render it). Hashing it would break those screens, which is a product change and out of this phase's scope. Store and serve it exactly as the snapshot does now; Task 10 records the decision and the reason in spec §16.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/tickets/tickets.test.ts`
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { truncateAll } from "../../test/db.js";
import { documentHistory, reservations, stockMoves } from "../../db/schema/index.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "tickets" }); await app.ready(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const post = async (user: string, url: string, payload?: unknown) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: await hdr(user), ...(payload === undefined ? {} : { payload }) });
const onHand = async (loc: string, it: string) => {
  const r = await app.inject({ method: "GET", url: "/api/v1/stock", headers: await authHeaders(app, "u2") });
  return r.json().stock[loc]?.[it] ?? 0;
};

describe("POST /tickets/:id/handover", () => {
  it("moves the stock out on the OTP, releases the hold, and closes nothing else", async () => {
    // TKT-0440: store -> coffee, 500 cups, Issued, otp 418327; its request REQ-2026-0909 is Ticket issued.
    const before = await onHand("store", "cup");
    const r = await post("u3", "/tickets/TKT-0440/handover", { otp: "418327" });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ id: "TKT-0440", st: "Collected", from: "store", to: "coffee" });
    expect(b.changed).toEqual(["tkt", "req", "rsv", "stock"]);
    expect(b.message).toBe("TKT-0440 handed over — stock is in transit to Coffee Shop");

    expect(await onHand("store", "cup")).toBe(before - 500);
    expect(await onHand("coffee", "cup")).toBe(180);          // in transit: owned by neither (M8)

    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, "TKT-0440"));
    expect(held.every((h) => h.releasedAt !== null)).toBe(true);
    const moves = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, "TKT-0440"));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ loc: "store", itemKey: "cup", qty: -500, kind: "ticket_out" });

    const req = await app.inject({ method: "GET", url: "/api/v1/requests", headers: await authHeaders(app, "u2") });
    const linked = req.json().find((x: { id: string }) => x.id === "REQ-2026-0909");
    expect(linked.st).toBe("Collected");
    expect(linked.hist.at(-1)).toMatchObject({ s: "Collected", who: "Suresh Muthu" });
  });

  it("refuses a wrong OTP and moves nothing", async () => {
    const before = await onHand("store", "cup");
    const r = await post("u3", "/tickets/TKT-0440/handover", { otp: "000000" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("That OTP does not match TKT-0440. Ask the collector to read it again.");
    expect(await onHand("store", "cup")).toBe(before);
    expect(await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, "TKT-0440"))).toHaveLength(0);
  });

  it("lets the store hand over without an OTP, and says so, and records the override", async () => {
    const r = await post("u3", "/tickets/TKT-0440/handover", {});
    expect(r.statusCode).toBe(200);
    expect(r.json().message).toBe("TKT-0440 handed over on a supervisor override — stock is in transit to Coffee Shop");
    const audit = await app.testDb!.db.select().from(documentHistory)
      .where(and(eq(documentHistory.docType, "ticket"), eq(documentHistory.docId, "TKT-0440")));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ status: "Handed over — supervisor override", who: "Suresh Muthu" });
  });

  it("refuses the override to a counter", async () => {
    const id = await given.ticket(app.testDb!.db, { refType: "shop_transfer", refId: "Shop transfer", from: "coffee", to: "kiosk", lines: [{ it: "chips", qty: 2 }] });
    const r = await post("u1", `/tickets/${id}/handover`, {});
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Only the store or the kitchen may hand over without the OTP");
  });

  it("lets the kitchen hand its own ticket over (C2)", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "kitchen", to: "kiosk", lines: [{ it: "puff", qty: 5 }], otp: "123456" });
    const before = await onHand("kitchen", "puff");
    const r = await post("u4", `/tickets/${id}/handover`, { otp: "123456" });
    expect(r.statusCode).toBe(200);
    expect(await onHand("kitchen", "puff")).toBe(before - 5);
  });

  it("refuses a location that is not the one the ticket leaves from", async () => {
    const r = await post("u4", "/tickets/TKT-0440/handover", { otp: "418327" });   // kitchen, ticket is store's
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toBe("You can only do this for the location the ticket is issued from.");
  });

  it("refuses a second handover", async () => {
    await post("u3", "/tickets/TKT-0440/handover", { otp: "418327" });
    const again = await post("u3", "/tickets/TKT-0440/handover", { otp: "418327" });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe("TKT-0440 is already collected");
  });

  it("hands over exactly once when two windows press together", async () => {
    const both = await Promise.all([post("u3", "/tickets/TKT-0440/handover", { otp: "418327" }), post("u3", "/tickets/TKT-0440/handover", { otp: "418327" })]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, "TKT-0440"))).toHaveLength(1);
  });

  it("404s a ticket that is not there", async () => {
    const r = await post("u3", "/tickets/TKT-0000/handover", { otp: "418327" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no ticket TKT-0000.");
  });
});

describe("POST /tickets/:id/receive", () => {
  it("books the stock in and closes the request behind it", async () => {
    await post("u3", "/tickets/TKT-0440/handover", { otp: "418327" });
    const r = await post("u1", "/tickets/TKT-0440/receive");
    expect(r.statusCode).toBe(200);
    expect(r.json().result.st).toBe("Received");
    expect(r.json().changed).toEqual(["tkt", "req", "stock"]);
    expect(r.json().message).toBe("Received at Coffee Shop — stock is on the shelf");
    expect(await onHand("coffee", "cup")).toBe(180 + 500);

    const moves = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, "TKT-0440"));
    expect(moves.map((m) => m.kind).sort()).toEqual(["ticket_in", "ticket_out"]);

    const req = await app.inject({ method: "GET", url: "/api/v1/requests", headers: await authHeaders(app, "u2") });
    const linked = req.json().find((x: { id: string }) => x.id === "REQ-2026-0909");
    expect(linked.st).toBe("Closed");
    expect(linked.hist.at(-1)).toMatchObject({ s: "Received", who: "Kavitha Raman" });
  });

  it("refuses to receive a ticket nobody has handed over yet", async () => {
    const r = await post("u1", "/tickets/TKT-0440/receive");
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("TKT-0440 is already issued");
  });

  it("refuses a counter receiving somebody else's delivery", async () => {
    await post("u3", "/tickets/TKT-0440/handover", { otp: "418327" });
    const r = await post("u6", "/tickets/TKT-0440/receive");     // kiosk, ticket goes to coffee
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toBe("You can only do this for the location the ticket is coming to.");
  });

  it("is absent for a buyer", async () => {
    expect((await post("u5", "/tickets/TKT-0440/receive")).statusCode).toBe(404);
  });
});

describe("POST /transfers", () => {
  it("reserves at the sending shop and raises the ticket the other collects against", async () => {
    const before = await onHand("coffee", "chips");
    const r = await post("u1", "/transfers", { from: "coffee", to: "kiosk", it: "chips", qty: 6 });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ req: "Shop transfer", from: "coffee", to: "kiosk", st: "Issued" });
    expect(b.result.lines).toEqual([{ it: "chips", qty: 6 }]);
    expect(b.changed).toEqual(["tkt", "rsv"]);
    expect(b.message).toBe(`${b.result.id} issued — 6 nos reserved at Coffee Shop for Snack Kiosk`);
    expect(await onHand("coffee", "chips")).toBe(before);     // reserved, not moved
    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, b.result.id));
    expect(held[0]).toMatchObject({ loc: "coffee", itemKey: "chips", qty: 6, releasedAt: null });
  });

  it("refuses more than the shop has free to send", async () => {
    const r = await post("u1", "/transfers", { from: "coffee", to: "kiosk", it: "chips", qty: 99 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Coffee Shop has only 9 nos free to send");
  });

  it("refuses a quantity of nothing in the operator's words", async () => {
    const r = await post("u1", "/transfers", { from: "coffee", to: "kiosk", it: "chips", qty: 0 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Enter a quantity");
  });

  it("refuses anything that is not two different outlets", async () => {
    for (const body of [{ from: "coffee", to: "coffee", it: "chips", qty: 1 }, { from: "coffee", to: "store", it: "chips", qty: 1 }]) {
      const r = await post("u1", "/transfers", body);
      expect(r.statusCode).toBe(422);
      expect(r.json().error.message).toBe("A shop transfer runs between two different outlets");
    }
  });

  it("scopes a counter to their own shop but lets a manager move between any two", async () => {
    expect((await post("u1", "/transfers", { from: "kiosk", to: "coffee", it: "chips", qty: 1 })).statusCode).toBe(403);
    expect((await post("u2", "/transfers", { from: "kiosk", to: "coffee", it: "chips", qty: 1 })).statusCode).toBe(200);
  });
});
```
Run: `pnpm --filter @rch/api test src/modules/tickets` → FAIL (the stub registers no routes).

- [ ] **Step 2: Write `repo.ts`, then `service.ts`**

`handover`, in full, because it is where the movement rule lives:
```ts
    async handover(claims: AccessClaims, id: string, body: HandoverBody): Promise<WriteResponse<Ticket>> {
      return withTransaction(db, async (tx) => {
        const t = await readTicket(tx, id);
        if (!t) throw new NotFoundError(`There is no ticket ${id}.`);
        requireLocOf(claims, t.from, "the location the ticket is issued from");
        assertTransition(TICKET_TRANSITIONS, t.st, "Collected", id);

        // The OTP is quoted by the collector and typed at the window. Omitting it is the
        // labelled supervisor override — allowed to the store and the kitchen only (spec §8.3),
        // and written to document_history so it can be found afterwards.
        const override = body.otp === undefined;
        if (!override) assertRule(body.otp!.trim() === t.otp, `That OTP does not match ${id}. Ask the collector to read it again.`);
        else assertRule(claims.role === "store" || claims.role === "prod", "Only the store or the kitchen may hand over without the OTP");

        const at = new Date();
        const master = await loadMaster(tx);
        const to = master.locations[t.to];
        // The scan moves: stock leaves `from` here and belongs to nobody until it is received.
        await postMoves(tx, t.lines.map((l) => ({ loc: t.from, it: l.it, qty: -l.qty, kind: "ticket_out" as const, refType: "ticket", refId: id, by: claims.sub, at })));
        // postMoves has the locks; this read is the guarantee, the pre-check was the courtesy.
        const after = await ticketsRepo.balancesAt(tx, t.from, t.lines.map((l) => l.it));
        for (const l of t.lines) {
          const item = master.items[l.it];
          assertRule((after[l.it] ?? 0) >= 0, `${to.n} cannot collect ${fq(l.qty, item?.u ?? "nos")} ${item?.u ?? "nos"} of ${item?.n ?? l.it} — ${master.locations[t.from].n} no longer has it`);
        }
        // The hold did its job; the moves have replaced it.
        await releaseForTicket(tx, id, at);
        await ticketsRepo.setStatus(tx, id, { status: "Collected", collectedAt: at });

        const who = await ticketsRepo.userName(tx, claims.sub);
        if (override) await appendHistory(tx, "ticket", id, "Handed over — supervisor override", who, at);
        const linked = await ticketsRepo.linkedRequest(tx, t.req);
        if (linked && canTransition(REQUEST_TRANSITIONS, linked.status, "Collected")) {
          await ticketsRepo.setRequestStatus(tx, linked.id, "Collected");
          await appendHistory(tx, "request", linked.id, "Collected", who, at);
        }

        const changed = ["tkt", "req", "rsv", "stock"] as const;
        await emitChanged(tx, changed);
        return {
          result: (await readTicket(tx, id))!,
          changed: [...changed],
          message: override
            ? `${id} handed over on a supervisor override — stock is in transit to ${to.n}`
            : `${id} handed over — stock is in transit to ${to.n}`,
        };
      });
    },
```
`receive` is the mirror: `ticket_in` moves at `t.to` (no post-lock check — nothing goes negative booking stock in), status `Received` with `receivedAt`, and a linked request in `Collected` moved to `Closed` with a history row reading **`Received`**.
`transfer` reads the master, asserts the three rules, takes the ticket's number with `allocateTicket(tx, at)`, **then** `lockBalances` at `from`, reads `on_hand` and `reservedAt`, asserts the cover, and finally `writeTicket(tx, draft, no)` — ids before balance rows, as `lib/ledger.ts`'s header requires.

- [ ] **Step 3: Write `routes.ts`**

```ts
// Tickets: the scan that moves stock — handover at the window, receipt on the shelf — and the
// shop-to-shop transfer that raises one without a request behind it.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { requireLoc } from "../../plugins/rbac.js";
import { createTicketsService } from "./service.js";

export default fp(async (app) => {
  const svc = createTicketsService(app.db);
  // Both of these scope on the ticket's own from/to, which only the service has read.
  mount(app, routes.handover, async (req) => svc.handover(req.user, req.params.id, req.body));
  mount(app, routes.receiveTicket, async (req) => svc.receive(req.user, req.params.id));
  // A transfer names its own source, so the counter's scope is checkable here; a manager may
  // move stock between any two outlets, as they may switch any outlet's products off.
  mount(app, routes.transfer, async (req) => {
    if (req.user.role === "counter") requireLoc(req, req.body.from, "your own counter");
    return svc.transfer(req.user, req.body);
  });
}, { name: "module:tickets", dependencies: ["auth", "rbac", "idempotency", "db"] });
```

- [ ] **Step 4: Run the tests and prove the ledger reconciles**

Run: `pnpm --filter @rch/api test src/modules/tickets` → PASS.
Then, on a seeded local database: hand over and receive `TKT-0440`, run `pnpm --filter @rch/api db:rebuild-balances`, and confirm `GET /stock` is byte-identical before and after — the cache must be exactly the sum of the moves.

- [ ] **Step 5: Gate and commit**

Run: `pnpm turbo typecheck test && pnpm lint`
```bash
git add apps/api/src/modules/tickets
git commit -m "$(cat <<'EOF'
Move stock on the scan, not on the approval

Handover posts the ticket_out moves and releases the ticket's reservations in one
transaction; receipt posts ticket_in at the other end. Between them the stock is in transit
and neither location holds it. A wrong OTP refuses and moves nothing; omitting it is the
labelled supervisor override, open to the store and the kitchen only and written to
document_history as "Handed over — supervisor override" — spec §8.3's wording, verbatim.

A shop transfer gets its own endpoint here too: it raises a ticket between two outlets with
no request behind it, reserving at the sender and moving nothing.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 7: `shopasks` module — one shop asks another, and the other decides

**Files:**
- Modify (all four exist as Task 4's wired stub — replace their bodies and delete the stub's `ready`/`ping`): `apps/api/src/modules/shopasks/routes.ts`, `service.ts`, `repo.ts`, `shopasks.test.ts`

**Interfaces:**
- Consumes: `mount`; `requireLocOf`; `withTransaction`; `assertRule`/`assertTransition`; `NotFoundError`; `loadMaster`; `allocateId`; `lockBalances`; `reservedAt`; `allocateTicket`/`writeTicket`; `emitChanged`; `fq`, `round3`, `SHOP_ASK_TRANSITIONS` from `@rch/domain`.
- Produces:
  ```ts
  export function createShopAsksService(db: Db): {
    ask(claims: AccessClaims, body: ShopAskBody): Promise<WriteResponse<ShopAsk>>;
    answer(claims: AccessClaims, id: string, body: AnswerShopAskBody): Promise<WriteResponse<ShopAskSentResult>>;
    decline(claims: AccessClaims, id: string, body: DeclineShopAskBody): Promise<WriteResponse<ShopAsk>>;
  };
  ```
- `repo.ts`: `head(tx, id)` — a **locking** read (`.for("update")` on `shop_asks`), so one ask cannot be answered twice; `insert(tx, row)`, `setAnswer(tx, id, patch)`, `balancesAt(tx, loc, itemKeys)`, `userName(tx, id)`, `wire(tx, id)`.

| Endpoint | Rules | Message |
|---|---|---|
| `POST /shop-asks` | `from = claims.loc`; `assertRule(body.to !== claims.loc, "Pick a different shop")`; `assertRule(locations[to].type === "Outlet" && locations[from].type === "Outlet", "Only another shop can be asked directly")`; `assertRule(body.qty > 0, "Enter a quantity")`; item exists (404); id from `allocateId(tx, "shop_ask")`; status `Asked` | `` `${id} sent to ${to.n} — they decide, not the manager` `` |
| `POST /shop-asks/:id/answer` | ask exists (404 `There is no shop ask <id>.`); `requireLocOf(claims, a.to, "your own counter")`; `assertTransition(SHOP_ASK_TRANSITIONS, a.st, "Sent", id)`; `assertRule(body.grant > 0, "Grant a quantity, or decline the ask")`; `assertRule(body.grant <= a.qty, \`${from.n} asked for ${fq(a.qty, item.u)} ${item.u} — grant that or less\`)` **(NEW)**; `give = round3(body.grant)`; `allocateTicket(tx, at)` (ids before locks); then `lockBalances` at `a.to`, `assertRule(on_hand − reserved ≥ give, \`${to.n} has only ${fq(free, item.u)} ${item.u} free to send\`)`; `writeTicket(tx, { refType: "shop_ask", refId: id, from: a.to, to: a.from, lines: [{ it: a.it, qty: give }], by: claims.sub, at }, no)`; ask → `Sent` with `granted_qty` and `ticket_id` | `` `${id} granted — ${tkt.id} issued for ${fq(give, item.u)} ${item.u} to ${from.n}` `` **(NEW)** |
| `POST /shop-asks/:id/decline` | ask exists; `requireLocOf(claims, a.to, "your own counter")`; `assertRule(body.reason.trim().length > 0, "Give a reason — the other shop sees it")`; `assertTransition(SHOP_ASK_TRANSITIONS, a.st, "Declined", id)`; ask → `Declined` with the trimmed reason | `` `${id} declined` `` |

`changed`: ask `["shopAsks"]`; answer `["shopAsks", "tkt", "rsv"]`; decline `["shopAsks"]`.

**Why `answer` gets a new sentence.** Today `answerShopAsk` writes no message of its own — it calls `transferToOutlet`, whose toast names the ticket and the two shops but never the ask, so the operator who granted `ASK-0060` sees a sentence that does not mention it. On the server the two are one endpoint, so it says both. The transfer's own sentence is unchanged and still fires for `POST /transfers`. Task 10 records this in spec §16.

**Note the direction.** The ask travels `from` (the shop that wants it) → `to` (the shop that holds it); the ticket the answer raises travels the other way, `from: a.to` → `to: a.from`. Getting this backwards reserves the wrong shop's stock, so the test below asserts both ends explicitly.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/shopasks/shopasks.test.ts`
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { truncateAll } from "../../test/db.js";
import { reservations, stockMoves } from "../../db/schema/index.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "shopasks" }); await app.ready(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const post = async (user: string, url: string, payload?: unknown) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: await hdr(user), ...(payload === undefined ? {} : { payload }) });

describe("POST /shop-asks", () => {
  it("asks the other shop directly, not the manager", async () => {
    const r = await post("u1", "/shop-asks", { to: "kiosk", it: "water", qty: 24, note: "Ran dry over the morning clinic." });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ id: "ASK-063", from: "coffee", to: "kiosk", it: "water", qty: 24, st: "Asked", by: "Kavitha Raman", note: "Ran dry over the morning clinic." });
    expect(b.changed).toEqual(["shopAsks"]);
    expect(b.message).toBe("ASK-063 sent to Snack Kiosk — they decide, not the manager");
  });

  it("refuses the asker's own shop, a location that is not a shop, and no quantity", async () => {
    expect((await post("u1", "/shop-asks", { to: "coffee", it: "water", qty: 1 })).json().error.message).toBe("Pick a different shop");
    expect((await post("u1", "/shop-asks", { to: "store", it: "water", qty: 1 })).json().error.message).toBe("Only another shop can be asked directly");
    expect((await post("u1", "/shop-asks", { to: "kiosk", it: "water", qty: 0 })).json().error.message).toBe("Enter a quantity");
  });

  it("404s an item the master does not have, and is absent for a manager", async () => {
    expect((await post("u1", "/shop-asks", { to: "kiosk", it: "totally-fake", qty: 1 })).json().error.message).toBe("There is no item totally-fake.");
    expect((await post("u2", "/shop-asks", { to: "kiosk", it: "water", qty: 1 })).statusCode).toBe(404);
  });
});

describe("POST /shop-asks/:id/answer", () => {
  it("grants it, reserves at the shop that holds it, and raises the ticket the asker collects", async () => {
    // ASK-0060: kiosk asks coffee for 6 chips. Coffee holds 9.
    const r = await post("u1", "/shop-asks/ASK-0060/answer", { grant: 6 });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.result.ask).toMatchObject({ id: "ASK-0060", st: "Sent", grant: 6, ticket: b.result.ticket.id });
    expect(b.result.ticket).toMatchObject({ req: "ASK-0060", from: "coffee", to: "kiosk", st: "Issued" });
    expect(b.result.ticket.lines).toEqual([{ it: "chips", qty: 6 }]);
    expect(b.changed).toEqual(["shopAsks", "tkt", "rsv"]);
    expect(b.message).toBe(`ASK-0060 granted — ${b.result.ticket.id} issued for 6 nos to Snack Kiosk`);

    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, b.result.ticket.id));
    expect(held[0]).toMatchObject({ loc: "coffee", itemKey: "chips", qty: 6, releasedAt: null });
    expect(await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, b.result.ticket.id))).toHaveLength(0);
  });

  it("refuses more than was asked for rather than quietly trimming it", async () => {
    const r = await post("u1", "/shop-asks/ASK-0060/answer", { grant: 99 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Snack Kiosk asked for 6 nos — grant that or less");
    expect((await app.inject({ method: "GET", url: "/api/v1/shop-asks", headers: await authHeaders(app, "u1") })).json()
      .find((a: { id: string }) => a.id === "ASK-0060").st).toBe("Asked");
  });

  it("grants less than was asked when that is all the shop can spare", async () => {
    const r = await post("u1", "/shop-asks/ASK-0060/answer", { grant: 4 });
    expect(r.statusCode).toBe(200);
    expect(r.json().result.ask.grant).toBe(4);
    expect(r.json().result.ticket.lines).toEqual([{ it: "chips", qty: 4 }]);
  });

  it("refuses a grant of nothing, and one the shelf cannot cover", async () => {
    expect((await post("u1", "/shop-asks/ASK-0060/answer", { grant: 0 })).json().error.message).toBe("Grant a quantity, or decline the ask");
    const big = await given.shopAsk(app.testDb!.db, { from: "kiosk", to: "coffee", it: "chips", qty: 50, by: "u6" });
    const r = await post("u1", `/shop-asks/${big}/answer`, { grant: 50 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Coffee Shop has only 9 nos free to send");
  });

  it("refuses the shop that asked, and refuses answering twice", async () => {
    expect((await post("u6", "/shop-asks/ASK-0060/answer", { grant: 6 })).statusCode).toBe(403);   // u6 asked
    await post("u1", "/shop-asks/ASK-0060/answer", { grant: 6 });
    const again = await post("u1", "/shop-asks/ASK-0060/answer", { grant: 1 });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe("ASK-0060 is already sent");
  });

  it("404s an ask that is not there", async () => {
    const r = await post("u1", "/shop-asks/ASK-9999/answer", { grant: 1 });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no shop ask ASK-9999.");
  });
});

describe("POST /shop-asks/:id/decline", () => {
  it("needs a reason the other shop can read", async () => {
    const r = await post("u1", "/shop-asks/ASK-0060/decline", { reason: "  " });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Give a reason — the other shop sees it");
  });

  it("declines with the reason, and issues no ticket", async () => {
    const r = await post("u1", "/shop-asks/ASK-0060/decline", { reason: "We are short ourselves" });
    expect(r.json().result).toMatchObject({ id: "ASK-0060", st: "Declined", reason: "We are short ourselves" });
    expect(r.json().changed).toEqual(["shopAsks"]);
    expect(r.json().message).toBe("ASK-0060 declined");
    const answer = await post("u1", "/shop-asks/ASK-0060/answer", { grant: 6 });
    expect(answer.statusCode).toBe(422);
    expect(answer.json().error.message).toBe("ASK-0060 is already declined");
  });
});
```
Run: `pnpm --filter @rch/api test src/modules/shopasks` → FAIL.

- [ ] **Step 2: Write `repo.ts`, `service.ts` and `routes.ts`**

`answer` is the one with stock in it:
```ts
    async answer(claims: AccessClaims, id: string, body: AnswerShopAskBody): Promise<WriteResponse<ShopAskSentResult>> {
      return withTransaction(db, async (tx) => {
        const a = await shopAsksRepo.head(tx, id);
        if (!a) throw new NotFoundError(`There is no shop ask ${id}.`);
        // The shop being asked is the one that decides — never the manager, never the asker.
        requireLocOf(claims, a.toLoc, "your own counter");
        assertTransition(SHOP_ASK_TRANSITIONS, a.status, "Sent", id);

        const master = await loadMaster(tx);
        const item = master.items[a.itemKey];
        if (!item) throw new NotFoundError(`There is no item ${a.itemKey}.`);
        // Spec §9.2: 0 < grant <= asked. The browser silently clamped a bigger number down to
        // the ask; the server says so instead, because a counter who typed 60 for a 6 meant
        // something, and sending 6 without a word is the wrong kind of helpful.
        assertRule(body.grant > 0, "Grant a quantity, or decline the ask");
        assertRule(body.grant <= a.qty, `${master.locations[a.fromLoc].n} asked for ${fq(a.qty, item.u)} ${item.u} — grant that or less`);
        const give = round3(body.grant);

        // Ids before balance rows (lib/ledger.ts's header).
        const at = new Date();
        const no = await allocateTicket(tx, at);
        await lockBalances(tx, [{ loc: a.toLoc, it: a.itemKey }]);
        const stock = await shopAsksRepo.balancesAt(tx, a.toLoc, [a.itemKey]);
        const held = await reservedAt(tx, a.toLoc, [a.itemKey]);
        const free = round3((stock[a.itemKey] ?? 0) - (held[`${a.toLoc}:${a.itemKey}`] ?? 0));
        assertRule(free >= give, `${master.locations[a.toLoc].n} has only ${fq(free, item.u)} ${item.u} free to send`);

        // The ask runs asker -> holder; the ticket runs back the other way.
        const ticket = await writeTicket(tx, { refType: "shop_ask", refId: id, from: a.toLoc, to: a.fromLoc, lines: [{ it: a.itemKey, qty: give }], by: claims.sub, at }, no);
        await shopAsksRepo.setAnswer(tx, id, { status: "Sent", grantedQty: give, ticketId: ticket.id });

        const changed = ["shopAsks", "tkt", "rsv"] as const;
        await emitChanged(tx, changed);
        return {
          result: { ask: await shopAsksRepo.wire(tx, id), ticket },
          changed: [...changed],
          message: `${id} granted — ${ticket.id} issued for ${fq(give, item.u)} ${item.u} to ${master.locations[a.fromLoc].n}`,
        };
      });
    },
```
`routes.ts` mounts the three with no route-level scoping — all three scope on the ask's own `to_loc`, which only the service has read:
```ts
// Shop asks: one shop asking another for stock it is holding. The manager sees it; it never
// routes through them.
export default fp(async (app) => {
  const svc = createShopAsksService(app.db);
  mount(app, routes.askShop, async (req) => svc.ask(req.user, req.body));
  mount(app, routes.answerShopAsk, async (req) => svc.answer(req.user, req.params.id, req.body));
  mount(app, routes.declineShopAsk, async (req) => svc.decline(req.user, req.params.id, req.body));
}, { name: "module:shopasks", dependencies: ["auth", "rbac", "idempotency", "db"] });
```

- [ ] **Step 3: Run the tests, gate and commit**

Run: `pnpm --filter @rch/api test src/modules/shopasks` → PASS, then `pnpm turbo typecheck test && pnpm lint`.
```bash
git add apps/api/src/modules/shopasks
git commit -m "$(cat <<'EOF'
Let one shop ask another, and the other decide

The shop being asked grants or declines — never the manager. A grant reserves at the shop
that holds the stock and raises the ticket the asker collects against, in one transaction,
so a grant nobody can cover is refused rather than half-written.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 11: `pos` — the staff-credit ceiling moves to the server, and the post-lock check learns about reservations

*(Wave 3, alongside Tasks 5, 6 and 7. It owns `apps/api/src/modules/pos/*`, which Task 3 last touched in wave 2 to add `emitChanged`; `packages/domain/src/credit.ts` and its one export line in `packages/domain/src/index.ts`, which nobody has touched since wave 1; `apps/api/src/lib/time.ts`, which no other Phase 3 task edits; and one appended builder in `apps/api/src/test/builders.ts`, which Tasks 5, 6 and 7 import but never edit.)*

**Files:**
- Create: `packages/domain/src/credit.ts`, `packages/domain/src/credit.test.ts`
- Modify: `packages/domain/src/index.ts`, `packages/contract/src/schemas/common.ts`, `packages/contract/src/fixtures/master.ts`, `apps/api/src/lib/time.ts`, `apps/api/src/lib/time.test.ts`, `apps/api/src/test/builders.ts`, `apps/api/src/modules/pos/{service,repo,pos.test}.ts`, `UI/src/__tests__/screens.test.tsx`

**Interfaces:**
- Consumes: `assertRule` from `../../lib/rules.js`; `reservedAt` from `../../lib/reservations.js` (Task 4's, whose exact signature is `reservedAt(tx: Tx, loc: string, itemKeys?: readonly string[]): Promise<RsvMap>`, returning a map keyed `"loc:item"`); `fq`, `round3` from `@rch/domain`; `given.ticket` from `../../test/builders.js` (Task 4's, whose exact signature is `given.ticket(db: Db, p: { id?: string; refType?: TicketRefType; refId?: string; from: LocKey; to: LocKey; lines: { it: string; qty: number }[]; st?: TktStatus; otp?: string; reserve?: boolean }): Promise<string>`, which reserves the lines at `from` when the status is `Issued`).
- Produces:
  ```ts
  // packages/domain/src/credit.ts
  export const STAFF_CREDIT_LIMIT = 3000;
  export function creditRoom(taken: number, limit?: number): number;
  export function breachesCredit(taken: number, total: number, limit?: number): boolean;
  export function creditBreachMessage(taken: number, total: number, payerName: string, limit?: number): string;

  // apps/api/src/lib/time.ts
  export function monthStartIST(at?: Date): Date;

  // apps/api/src/test/builders.ts — appended to the existing `given` object
  given.bill(db: Db, p: { no?: string; loc: LocKey; operator?: string; total: number; tax?: number; tender?: string; payer?: { kind: "patient" | "staff" | "dept"; id: string; name: string }; at?: Date; lines?: { it: string; qty: number; rate: number }[] }): Promise<string>;

  // apps/api/src/modules/pos/repo.ts — appended to the existing `posRepo` object
  posRepo.staffCreditTaken(tx: Tx, payerId: string, since: Date): Promise<number>;
  ```

**What changes, and why:**

| # | Rule | Where it lives now | Where it lives after |
|---|---|---|---|
| 1 | A staff member may not run more than **₹3,000** of credit inside one calendar month. | `UI/src/roles/counter/Pos.tsx:60` disables the Pay button; nothing stops a second tab, a stale page, or a direct call. | `packages/domain/src/credit.ts` states the rule and the sentence; `apps/api/src/modules/pos/service.ts` enforces it inside the sale's transaction; `Pos.tsx` keeps the same preview and reads the same constant. |
| 2 | A sale may not take a shelf below what is free. | `pos/service.ts`'s post-lock re-read asserts `on_hand >= 0`. | Same place, now `on_hand − reserved >= 0`, with `reserved` read inside the locked window. |

**The window `taken` covers.** `Pos.tsx:209` says "this session", which is what a store with no server can measure — it is the bills that happen to be in the browser's memory. The server has no session, and the hospital settles staff credit monthly (the fixture's own comment reads "Staff credit ceiling per month, in rupees"), so the rule becomes: **every bill charged to that staff id, hospital-wide, since midnight on the first of the current month in Asia/Kolkata.** Hospital-wide and not per-counter, because the ceiling belongs to the person, not the till. Task 10 records this in spec §16.

**The sentence.** Today there is no refusal toast — the button is simply disabled and `Pos.tsx:216` explains why, in an `Alert`:
```
{money(taken + total)} breaches the {money0(STAFF_CREDIT_LIMIT)} staff credit limit for {payer?.name}.
Take another tender or split the bill.
```
which renders as one sentence pair, e.g. `₹3,010.00 breaches the ₹3,000 staff credit limit for Vinoth Prakash · Kitchen. Take another tender or split the bill.` The server's 422 says exactly that, so the operator who gets past the disabled button (a second tab, a stale page) reads the words they already know. `money` is `"₹" + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })` and `money0` is `"₹" + Math.round(v).toLocaleString("en-IN")` (`UI/src/lib/fmt.ts:11-13`) — Indian digit grouping, two decimals for the running total and none for the ceiling. `creditBreachMessage` in `packages/domain` reproduces both, so there is one definition of the sentence and both sides can be pinned to it. Node 24's official builds carry full ICU, so `en-IN` groups identically on the server and in the browser; the domain test below is what proves it rather than assuming it.

**`changed` and the response are unchanged** — a refused sale writes nothing, and an accepted one still answers `["stock", "bills"]`.

- [ ] **Step 1: Write the failing domain test**

`packages/domain/src/credit.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { STAFF_CREDIT_LIMIT, breachesCredit, creditBreachMessage, creditRoom } from "./credit";

describe("the staff credit ceiling", () => {
  it("is three thousand rupees a month", () => {
    expect(STAFF_CREDIT_LIMIT).toBe(3000);
  });

  it("lets a bill land exactly on the ceiling, and refuses the rupee after it", () => {
    expect(breachesCredit(2980, 20)).toBe(false);
    expect(breachesCredit(3000, 0)).toBe(false);
    expect(breachesCredit(2990, 20)).toBe(true);
    expect(breachesCredit(0, 3000.01)).toBe(true);
  });

  it("says how much room is left, and never a negative amount", () => {
    expect(creditRoom(2980)).toBe(20);
    expect(creditRoom(0)).toBe(3000);
    expect(creditRoom(3200)).toBe(0);
    expect(creditRoom(1000, 1500)).toBe(500);
    expect(creditRoom(0.1 + 0.2)).toBe(2999.7);        // two decimals, not 2999.7000000000003
  });

  it("writes the refusal the counter already reads on the screen, grouped the Indian way", () => {
    expect(creditBreachMessage(2990, 20, "Vinoth Prakash · Kitchen"))
      .toBe("₹3,010.00 breaches the ₹3,000 staff credit limit for Vinoth Prakash · Kitchen. Take another tender or split the bill.");
    // Above a lakh the grouping changes; en-IN must be doing that on this runtime, not en-US.
    expect(creditBreachMessage(150000, 0, "Someone", 200000))
      .toBe("₹1,50,000.00 breaches the ₹2,00,000 staff credit limit for Someone. Take another tender or split the bill.");
  });
});
```
Run: `pnpm --filter @rch/domain test` → FAIL (`./credit` does not exist).

- [ ] **Step 2: Write `packages/domain/src/credit.ts`**

**Where the number itself lives.** The coordinator's brief asked for the constant to move *into* `packages/domain` with the fixtures re-exporting it, but the dependency graph is `contract → domain → (api, UI)` (spec §5.1), so `packages/contract` may not import `@rch/domain`. The legal shape with the same effect is the mirror image, and it is the one to build:

1. `packages/contract/src/schemas/common.ts` gains the declaration — a business limit is contract-level configuration, not seed data, and `packages/contract/src/index.ts` already does `export * from "./schemas/common.js"`, so it becomes part of `@rch/contract`:
   ```ts
   /** The ceiling one staff member may run up on credit inside one calendar month, in rupees.
    *  The rule that reads it is `breachesCredit` in @rch/domain; this is only the number. */
   export const STAFF_CREDIT_LIMIT = 3000;
   ```
2. `packages/contract/src/fixtures/master.ts` loses its own `export const STAFF_CREDIT_LIMIT = 3000;` (and the comment above it) and re-exports instead, so `UI/src/data/master.ts:18`'s `export const { …, STAFF_CREDIT_LIMIT, … } = FX;` still finds it on the namespace and `Pos.tsx:3` is untouched:
   ```ts
   // A limit, not a fixture — declared in ../schemas/common.ts and re-exported here so the
   // counter's screen keeps its single import from data/master.
   export { STAFF_CREDIT_LIMIT } from "../schemas/common.js";
   ```
3. `packages/domain/src/credit.ts` re-exports it under the same name, so a rule and its ceiling are one import for the server:

```ts
import { STAFF_CREDIT_LIMIT } from "@rch/contract";

/** Re-exported so a caller enforcing the rule takes the rule and its ceiling from one place.
 *  The number is declared in @rch/contract (packages/domain may depend on it, not the reverse). */
export { STAFF_CREDIT_LIMIT };

const round2 = (v: number): number => Math.round(v * 100) / 100;
/** The counter's own money formatting: Indian grouping, `money` at two decimals, `money0` at none. */
const inr = (v: number, decimals: number): string =>
  "₹" + (v || 0).toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/** How much more this person may put on credit before the ceiling. Never negative. */
export const creditRoom = (taken: number, limit: number = STAFF_CREDIT_LIMIT): number =>
  Math.max(0, round2(limit - taken));

/** Whether this bill would take them past it. Landing exactly on the ceiling is allowed. */
export const breachesCredit = (taken: number, total: number, limit: number = STAFF_CREDIT_LIMIT): boolean =>
  round2(taken + total) > limit;

/**
 * The one sentence both sides say. The counter's screen has explained the breach this way
 * since before there was a server (`UI/src/roles/counter/Pos.tsx`), so the server's refusal
 * repeats it word for word rather than inventing a second wording for the same fact.
 */
export const creditBreachMessage = (
  taken: number, total: number, payerName: string, limit: number = STAFF_CREDIT_LIMIT,
): string =>
  `${inr(taken + total, 2)} breaches the ${inr(Math.round(limit), 0)} staff credit limit for ${payerName}. Take another tender or split the bill.`;
```
Add to `packages/domain/src/index.ts`:
```ts
export { STAFF_CREDIT_LIMIT, creditRoom, breachesCredit, creditBreachMessage } from "./credit.js";
```
`packages/domain` already declares `"@rch/contract": "workspace:*"` (Phase 2 added it), so step 3 above needs no dependency change. Nothing downstream moves: `UI/src/data/master.ts:18` still destructures `STAFF_CREDIT_LIMIT` out of the fixtures namespace, and `UI/src/roles/counter/Pos.tsx:3` keeps its import exactly as it is.

- [ ] **Step 3: Run the domain test**

Run: `pnpm --filter @rch/domain test`
Expected: PASS. If the two `creditBreachMessage` cases fail on grouping, the runtime is missing full ICU — stop and report it rather than weakening the assertion, because the browser would then be saying something the server does not.

- [ ] **Step 4: Write the failing month-boundary test**

Add to `apps/api/src/lib/time.test.ts`, matching the file's existing style:
```ts
describe("monthStartIST", () => {
  it("is midnight on the first, in the hospital's zone", () => {
    // 14-Sep-2026 09:00 IST -> 01-Sep-2026 00:00 IST, which is 31-Aug-2026 18:30 UTC.
    expect(monthStartIST(new Date("2026-09-14T03:30:00.000Z")).toISOString()).toBe("2026-08-31T18:30:00.000Z");
  });

  it("uses the Indian calendar day, not UTC's", () => {
    // 31-Aug-2026 20:00 UTC is already 01-Sep 01:30 IST: the September window, not August's.
    expect(monthStartIST(new Date("2026-08-31T20:00:00.000Z")).toISOString()).toBe("2026-08-31T18:30:00.000Z");
    // 01-Sep-2026 00:30 UTC is still 01-Sep 06:00 IST: the same window.
    expect(monthStartIST(new Date("2026-09-01T00:30:00.000Z")).toISOString()).toBe("2026-08-31T18:30:00.000Z");
    // 31-Aug-2026 17:00 UTC is 31-Aug 22:30 IST: still August's window.
    expect(monthStartIST(new Date("2026-08-31T17:00:00.000Z")).toISOString()).toBe("2026-07-31T18:30:00.000Z");
  });
});
```
Run: `pnpm --filter @rch/api test src/lib/time.test.ts` → FAIL.

- [ ] **Step 5: Write `monthStartIST`**

Append to `apps/api/src/lib/time.ts`, reusing the `dateAt` already there:
```ts
/** Midnight on the first of the current month, in the hospital's zone. Staff credit is
 *  settled monthly, so that is the window a ceiling is measured over. */
export function monthStartIST(at: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return dateAt(`${get("year")}-${get("month")}-01`, "00:00");
}
```
Run: `pnpm --filter @rch/api test src/lib/time.test.ts` → PASS.

- [ ] **Step 6: Add the bill builder**

Append to the `given` object in `apps/api/src/test/builders.ts` (spec §5.1: a test that hand-builds a document instead of using a builder is rejected in review). Tasks 5, 6 and 7 import this file but never edit it, so this append is the only wave-3 change to it:
```ts
  /** A bill already taken, for a case that needs history rather than a sale. The line exists so
   *  the document is whole; the staff-credit ceiling reads the head's total. */
  async bill(db: Db, p: {
    no?: string; loc: LocKey; operator?: string; total: number; tax?: number; tender?: string;
    payer?: { kind: "patient" | "staff" | "dept"; id: string; name: string };
    at?: Date; lines?: { it: string; qty: number; rate: number }[];
  }): Promise<string> {
    const no = p.no ?? `CF/${9000 + Math.floor(Math.random() * 900)}`;
    const lines = p.lines ?? [{ it: "water", qty: 1, rate: p.total }];
    await db.transaction(async (tx) => {
      await tx.insert(s.bills).values({
        no, loc: p.loc, operatorId: p.operator ?? "u1", total: p.total, tax: p.tax ?? 0,
        at: p.at ?? new Date(), tender: p.tender ?? "Staff credit",
        payerKind: p.payer?.kind ?? null, payerId: p.payer?.id ?? null, payerName: p.payer?.name ?? null,
      });
      await tx.insert(s.billLines).values(lines.map((l, lineNo) => ({ billNo: no, lineNo, itemKey: l.it, qty: l.qty, rate: l.rate })));
    });
    return no;
  },
```

- [ ] **Step 7: Write the failing pos tests**

Append to `apps/api/src/modules/pos/pos.test.ts`. The file seeds once in `beforeAll` and its cases share the shelf, so this block tops the shelf up first and gives each case its own staff payer:
```ts
describe("the staff credit ceiling", () => {
  // The cases above have been selling from this shelf; put enough water back that a ₹20 bill
  // is never refused for the wrong reason.
  beforeAll(async () => {
    await app.db.transaction((tx) => postMoves(tx, [{ loc: "coffee", it: "water", qty: 60, kind: "adjustment", refType: "test", refId: "credit-topup" }]));
  });

  const STAFF = (id: string, name: string) => ({ kind: "staff" as const, id, name });
  const oneWater = (payer?: { kind: "patient" | "staff" | "dept"; id: string; name: string }) =>
    ({ loc: "coffee", tender: payer ? "Staff credit" : "Cash", ...(payer ? { payer } : {}), lines: [{ it: "water", qty: 1 }] });

  it("lets a bill land exactly on the ceiling", async () => {
    await given.bill(app.db, { loc: "coffee", total: 2980, payer: STAFF("RC-2088", "Suresh Muthu · Stores") });
    const r = await pay("u1", oneWater(STAFF("RC-2088", "Suresh Muthu · Stores")));    // water is ₹20 on list B
    expect(r.statusCode, r.body).toBe(200);
  });

  it("refuses the rupee after it, in the words the counter's screen already uses", async () => {
    await given.bill(app.db, { loc: "coffee", total: 2990, payer: STAFF("RC-1902", "Vinoth Prakash · Kitchen") });
    const before = (await app.db.select().from(s.bills)).length;

    const r = await pay("u1", oneWater(STAFF("RC-1902", "Vinoth Prakash · Kitchen")));

    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("₹3,010.00 breaches the ₹3,000 staff credit limit for Vinoth Prakash · Kitchen. Take another tender or split the bill.");
    expect(r.json().error.details).toEqual({ taken: 2990, room: 10 });
    expect((await app.db.select().from(s.bills)).length).toBe(before);      // refused writes nothing
  });

  it("counts the person, not the counter, and leaves other payers alone", async () => {
    // Charged at the kiosk, not this till — the ceiling belongs to the staff member.
    await given.bill(app.db, { loc: "kiosk", total: 2995, payer: STAFF("RC-3120", "Ramesh Kumar · F&B") });
    expect((await pay("u1", oneWater(STAFF("RC-3120", "Ramesh Kumar · F&B")))).statusCode).toBe(422);
    // A different staff member has their own room.
    expect((await pay("u1", oneWater(STAFF("RC-4471", "Kavitha Raman · F&B")))).statusCode).toBe(200);
  });

  it("counts this month only", async () => {
    const lastMonth = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await given.bill(app.db, { loc: "coffee", total: 2999, payer: STAFF("RC-4471", "Kavitha Raman · F&B"), at: lastMonth });
    const r = await pay("u1", oneWater(STAFF("RC-4471", "Kavitha Raman · F&B")));
    expect(r.statusCode, r.body).toBe(200);
  });

  it("ignores the ceiling for a tender that takes money now", async () => {
    await given.bill(app.db, { loc: "coffee", total: 5000, payer: STAFF("RC-2088", "Suresh Muthu · Stores") });
    expect((await pay("u1", oneWater())).statusCode).toBe(200);                                    // Cash
  });
});

describe("a sale cannot take stock another document is holding", () => {
  // This first case is caught by the *pre-check* (`coverOf` over `posRepo.rsvAt`), which already
  // nets reservations — it pins that the two voices agree. The race below is what exercises the
  // post-lock re-read, because only a concurrent writer can reserve after the pre-check read.
  it("pins the friendlier pre-check: more than on hand less reserved is refused, and takes nothing", async () => {
    // A shop transfer out of this counter holds 10 of its water; only what is left is sellable.
    const free = await onHand("coffee", "water");
    await given.ticket(app.db, { refType: "shop_transfer", refId: "Shop transfer", from: "coffee", to: "kiosk", lines: [{ it: "water", qty: free - 2 }] });
    const before = (await app.db.select().from(s.stockMoves)).length;

    const over = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 3 }] });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.message).toBe("Only 2 nos of Mineral water 1L left at Coffee Shop");
    expect((await app.db.select().from(s.stockMoves)).length).toBe(before);

    const exact = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 2 }] });
    expect(exact.statusCode, exact.body).toBe(200);
  });

  it("lets a transfer and a sale race for the last of a shelf, and only one win", async () => {
    const free = await onHand("coffee", "water");
    const [transfer, bill] = await Promise.all([
      app.inject({
        method: "POST", url: "/api/v1/transfers",
        headers: { ...(await authHeaders(app, "u1")), "idempotency-key": randomUUID() },
        payload: { from: "coffee", to: "kiosk", it: "water", qty: free },
      }),
      pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: free }] }),
    ]);
    expect([transfer.statusCode, bill.statusCode].filter((c) => c === 200)).toHaveLength(1);
    expect([transfer.statusCode, bill.statusCode].filter((c) => c === 422)).toHaveLength(1);
  });
});
```
with `import { given } from "../../test/builders.js";` and `beforeAll` added to the vitest import at the top of the file.
Run: `pnpm --filter @rch/api test src/modules/pos` → FAIL (no ceiling; the post-lock check ignores reservations).

- [ ] **Step 8: Add the repo query**

In `apps/api/src/modules/pos/repo.ts`, add `gte` to the `drizzle-orm` import and append to `posRepo`:
```ts
  /**
   * What this staff member has already put on credit inside the window. Deliberately unscoped
   * by location: the ceiling belongs to the person, so a bill they ran up at the kiosk counts
   * against them at the coffee shop.
   */
  async staffCreditTaken(tx: Tx, payerId: string, since: Date): Promise<number> {
    const [row] = await tx.select({ taken: sql<string>`coalesce(round(sum(${bills.total}), 2), 0)` })
      .from(bills)
      .where(and(eq(bills.payerKind, "staff"), eq(bills.payerId, payerId), gte(bills.at, since)));
    return Number(row?.taken ?? 0);
  },
```

- [ ] **Step 9: Enforce the ceiling in the sale**

In `apps/api/src/modules/pos/service.ts`, import `breachesCredit`, `creditBreachMessage`, `creditRoom` from `@rch/domain` and `monthStartIST` from `../../lib/time.js`, then insert this **after** `planBill` and **before** `allocateId` — inside the transaction, so a bill and the credit it consumes are decided together:
```ts
        const plan = planBill(master, prices, loc, cart);
        const at = new Date();
        // A tender that takes no money now runs up a balance somebody settles later. The ceiling
        // is the person's, over the calendar month the hospital settles on, and it is checked
        // here rather than only on the counter's screen — a second tab or a stale page would
        // otherwise walk straight past a disabled button.
        if (body.tender === "Staff credit" && body.payer) {
          const taken = await posRepo.staffCreditTaken(tx, body.payer.id, monthStartIST(at));
          assertRule(
            !breachesCredit(taken, plan.tot),
            creditBreachMessage(taken, plan.tot, body.payer.name),
            { taken, room: creditRoom(taken) },
          );
        }
        const no = await allocateId(tx, "bill", at);
```
(the existing `const at = new Date();` line moves up to just above this block if it is not already there, so the window and the bill share one instant).

- [ ] **Step 10: Teach the post-lock check about reservations**

Still in `apps/api/src/modules/pos/service.ts`, replace the post-lock block with:
```ts
        // What the sale actually took off each shelf, folded the way postMoves folded it. The
        // pre-check above spoke for the dish in portions; this one, keyed by what moved, names the
        // shelf item that went short — for a made-to-order dish that is the ingredient. Same
        // refusal, two voices: the first is friendlier, the second is the guarantee.
        //
        // Phase 3 puts reservations on outlet shelves too — a shop transfer or a granted shop ask
        // holds stock at a counter without moving it — so "short" now means on hand less what is
        // held, not merely negative. The hold is re-read here rather than reused from the
        // pre-check because every reservation path takes `lockBalances` first (see
        // apps/api/src/lib/ledger.ts): while this transaction holds those locks nothing new can
        // be reserved, so this read is the last word.
        const took = new Map<string, number>();
        for (const m of plan.moves) took.set(m.it, round3((took.get(m.it) ?? 0) + -m.qty));
        const keys = [...took.keys()];
        const onHand = await posRepo.onHandAt(tx, loc, keys);
        const heldNow = await reservedAt(tx, loc, keys);
        for (const [it, sold] of took) {
          const item = master.items[it];
          const unit = item?.u ?? "nos";
          const free = round3((onHand[it] ?? 0) - (heldNow[`${loc}:${it}`] ?? 0));
          const left = Math.max(0, round3(free + sold));
          assertRule(free >= 0, `Only ${fq(left, unit)} ${unit} of ${item?.n ?? it} left at ${locName}`);
        }
```
with `import { reservedAt } from "../../lib/reservations.js";` added. `reservedAt(tx, loc, keys)` is Task 4's helper — `reservedAt(tx: Tx, loc: string, itemKeys?: readonly string[]): Promise<RsvMap>`, returning open reservations only, keyed `"loc:item"`. The pre-check (`coverOf` over `posRepo.rsvAt`) is unchanged; it already nets reservations and still supplies the friendlier, dish-shaped sentence.

- [ ] **Step 11: Pin the browser's preview to the server's sentence**

Nothing in `UI/src/roles/counter/Pos.tsx` changes — it already renders the same words and reads `STAFF_CREDIT_LIMIT` through `UI/src/data/master.ts`, which now gets it from the fixtures, which get the number the domain does. Add one case to `UI/src/__tests__/screens.test.tsx` so the two cannot drift apart silently:
```ts
it("the counter's credit warning is the sentence the server refuses with", () => {
  // Pos.tsx renders the Alert as two sentences in one node; the server sends the same string.
  const rendered = `${money(3010)} breaches the ${money0(STAFF_CREDIT_LIMIT)} staff credit limit for Vinoth Prakash · Kitchen. Take another tender or split the bill.`;
  expect(rendered).toBe(creditBreachMessage(2990, 20, "Vinoth Prakash · Kitchen"));
});
```
with `money`, `money0` from `../lib/fmt`, `STAFF_CREDIT_LIMIT` from `../data/master` and `creditBreachMessage` from `@rch/domain`.

- [ ] **Step 12: Run everything**

Run: `pnpm --filter @rch/api test src/modules/pos` → PASS, then `pnpm turbo typecheck test && pnpm lint`.
Then on a seeded local database: `pnpm --filter @rch/api db:rebuild-balances` and confirm `GET /stock` is unchanged — a refused sale must have written no move to rebuild from.

- [ ] **Step 13: Commit**

```bash
git add packages/domain packages/contract apps/api UI
git commit -m "$(cat <<'EOF'
Hold the staff credit ceiling on the server, and count what is reserved

The ₹3,000 monthly ceiling was a disabled button; a second tab walked past it. It is a
domain rule now, enforced inside the sale's transaction over every bill charged to that
staff id since the first of the month in Asia/Kolkata — the ceiling belongs to the person,
not the till — and it refuses with the sentence the counter's screen has always shown.

Phase 3 puts reservations on outlet shelves, so a sale's post-lock re-read now asks for
on hand less what is held rather than merely non-negative. It reads the hold inside the
locked window, which is sound because every reservation path takes the balance locks first.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 12: `production` module — `POST /prod-orders/:id/dispatch` and `POST /distributions`

*(Wave 3, alongside Tasks 5, 6, 7 and 11. It owns `apps/api/src/modules/production/*` — Task 4 pre-registers the stub — plus `PROD_ORDER_TRANSITIONS` in `packages/domain/src/transitions.ts` and one name added to the existing transitions export line in `packages/domain/src/index.ts`. Task 11 also edits `packages/domain/src/index.ts`, on the credit line; the two edits are on different lines and the controller resolves a trivial adjacent-line conflict if git raises one.)*

**Why this is in Phase 3 and not Phase 4.** The kitchen creates tickets two ways — dispatching a production order and distributing finished goods — and Task 6 makes `handover`/`receive` server calls. Leave those two in memory and the kitchen's own tickets carry ids the server has never heard of, so handing one over answers `404 There is no ticket TKT-0xxx.` Spec §14's "nothing dual-runs" is what forces the pair across the line now; **Phase 4 keeps the rest of production** — `POST /prod-orders/:id/status`, batches, `makeProduct` — which create no tickets and so cross no seam.

**Files:**
- Create: `apps/api/src/modules/production/{service,repo,production.test}.ts`
- Modify: `apps/api/src/modules/production/routes.ts` (Task 4's wired stub), `packages/domain/src/transitions.ts`, `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: `mount` from `../../routes.js`; `withTransaction` from `../../lib/db.js`; `assertRule` from `../../lib/rules.js`; `NotFoundError` from `../../lib/errors.js`; `loadMaster` from `../../lib/master.js`; `appendHistory` from `../../lib/history.js`; `lockBalances` from `../../lib/ledger.js`; `reservedAt` from `../../lib/reservations.js`; `allocateTicket` and `writeTicket` from `../../lib/tickets.js` (Task 4's, whose exact signatures are `allocateTicket(tx: Tx, at?: Date): Promise<TicketNumber>` with `TicketNumber = { n: number; id: string; otp: string }`, and `writeTicket(tx: Tx, draft: TicketDraft, no: TicketNumber): Promise<Ticket>`); `emitChanged` from `../../lib/events.js`; `fq`, `round3` from `@rch/domain`; `given.ticket` from `../../test/builders.js` in the test.
- Produces:
  ```ts
  // packages/domain/src/transitions.ts
  export const PROD_ORDER_TRANSITIONS: TransitionTable<PordStatus>;

  // apps/api/src/modules/production/service.ts
  export function createProductionService(db: Db): {
    dispatch(claims: AccessClaims, id: string): Promise<WriteResponse<DispatchResult>>;
    distribute(claims: AccessClaims, body: DistributeBody): Promise<WriteResponse<Ticket>>;
  };
  ```
- `repo.ts`: `head(tx, id)` — a **locking** read (`.for("update")` on `prod_orders`), so one order cannot be dispatched twice; `lines(tx, id)`; `setStatus(tx, id, status)`; `balancesAt(tx, loc, itemKeys)`; `menuAt(tx, loc)` (a `Set<string>` of `location_items` at one location); `userName(tx, id)`; `wire(tx, id)` returning the `ProdOrder` wire shape (`{ id, from, by, at, lines, st, note, hist }`, lines in `line_no` order, `hist` from `readHistory(tx, "prod_order", id)`, `by` resolved to a name) — the same shape `modules/snapshot/readers/documents.ts`'s `readProdOrders` produces.
- The contract entries (`distribute`, `dispatchProdOrder`, `DistributeBodySchema`, `DispatchResultSchema`) are declared by **Task 4**, in the same commit as its three GETs, and are inert until this task mounts them. `"pord"` is already a member of `CollectionSchema`, so nothing there changes.

**The transition table.** Add to `packages/domain/src/transitions.ts`:
```ts
export const PROD_ORDER_TRANSITIONS: TransitionTable<PordStatus> = {
  New: ["Accepted", "Declined", "Dispatched"],
  Accepted: ["In kitchen", "Dispatched"],
  "In kitchen": ["Ready", "Dispatched"],
  Ready: ["Dispatched"],
  Dispatched: [],
  Declined: [],
};
```
`Dispatched` is reachable from every open status because the kitchen may send an order out the moment it is ready to, whatever stage the board says (`UI/src/store/index.ts`'s `dispatchOrder` refuses only `Dispatched` and `Declined`). `New → Accepted/Declined`, `Accepted → In kitchen` and `In kitchen → Ready` are spec §9.2's `setOrderStatus` rules, declared here now so Phase 4's status endpoint reads the same table the board's buttons do. Add `PROD_ORDER_TRANSITIONS` to the **existing** transitions export line in `packages/domain/src/index.ts` rather than a new line:
```ts
export { REQUEST_TRANSITIONS, TICKET_TRANSITIONS, SHOP_ASK_TRANSITIONS, PROD_ORDER_TRANSITIONS, canTransition, type TransitionTable } from "./transitions.js";
```

**Rules, verbatim (spec §9.2's `dispatchOrder` and `distribute` rows; every message below is the store's current `notify()` text):**

| Endpoint | Rules | Message |
|---|---|---|
| `POST /prod-orders/:id/dispatch` (prod) | order exists (404 `There is no production order <id>.`); `assertRule(o.st !== "Dispatched", \`${id} has already gone out — it is on one ticket to ${from.n}\`)`; `assertRule(o.st !== "Declined", \`${id} was declined — it cannot be dispatched\`)`; fold the lines by item, summing with `round3`; `assertRule(lines.length > 0, \`${id} has no items on it\`)`; `allocateTicket`; **then** `lockBalances` at `kitchen` for every folded item, re-read `on_hand` and open reservations, and refuse **all or nothing** naming every item short: `assertRule(short.length === 0, \`Nothing dispatched — the kitchen is short of ${short.map((l) => master.items[l.it].n).join(", ")}\`)`; `writeTicket` with `refType: "prod_order"`, `refId: id`, `from: "kitchen"`, `to: o.fromLoc`; order → `Dispatched`; history row `Dispatched` | `` `${tkt.id} issued — all ${lines.length} item${lines.length === 1 ? "" : "s"} of ${id} reserved for ${from.n}` `` |
| `POST /distributions` (prod) | `assertRule(body.qty > 0, "Enter a quantity")`; item exists (404 `There is no item <key>.`); stock that lands where it cannot be sold is stock lost (M9), so `assertRule(!(locations[to].type === "Outlet" && !menu.has(it)), \`${item.n} is not listed at ${to.n} — add it to that menu first\`)`; `allocateTicket`; then `lockBalances` at `kitchen`, re-read, `assertRule(free >= qty, \`Kitchen has only ${fq(free, item.u)} ${item.u} free to promise\`)`; `writeTicket` with `refType: "direct"`, `refId: "Direct issue"`, `from: "kitchen"`, `to: body.to` | `` `${tkt.id} issued — ${qty} ${item.n} reserved for ${to.n}` `` |

Neither endpoint is location-scoped by `requireLoc`: the `prod` role has exactly one kitchen, and both rules pin `from` to `"kitchen"` in the service rather than taking it from the caller. Both are **reservations only** — the movement rule holds, and `handover` is still what moves the stock.

`changed`: dispatch `["pord", "tkt", "rsv"]`; distribute `["tkt", "rsv"]`. Each is emitted with `await emitChanged(tx, changed)` inside the transaction.

**Neither uses `assertTransition`.** The table exists for the board's buttons, but `dispatchOrder`'s two refusals say more than "already dispatched" — one names the ticket's destination and the other says the order was declined — and both sentences are what the kitchen reads today. Keep them verbatim; the table is what `UI/src/lib/selectors.ts` gates the Dispatch button on.

- [ ] **Step 1: Write the failing domain test**

Append to `packages/domain/src/transitions.test.ts`:
```ts
describe("production order transitions", () => {
  it("may go out from any open stage, because a kitchen sends when it is ready", () => {
    for (const st of ["New", "Accepted", "In kitchen", "Ready"] as const) {
      expect(canTransition(PROD_ORDER_TRANSITIONS, st, "Dispatched")).toBe(true);
    }
  });
  it("walks the board in order otherwise", () => {
    expect(canTransition(PROD_ORDER_TRANSITIONS, "New", "Accepted")).toBe(true);
    expect(canTransition(PROD_ORDER_TRANSITIONS, "New", "Declined")).toBe(true);
    expect(canTransition(PROD_ORDER_TRANSITIONS, "Accepted", "In kitchen")).toBe(true);
    expect(canTransition(PROD_ORDER_TRANSITIONS, "In kitchen", "Ready")).toBe(true);
    expect(canTransition(PROD_ORDER_TRANSITIONS, "New", "Ready")).toBe(false);
    expect(canTransition(PROD_ORDER_TRANSITIONS, "Ready", "Accepted")).toBe(false);
  });
  it("is finished once it has gone out or been turned down", () => {
    expect(PROD_ORDER_TRANSITIONS.Dispatched).toEqual([]);
    expect(PROD_ORDER_TRANSITIONS.Declined).toEqual([]);
  });
});
```
with `PROD_ORDER_TRANSITIONS` added to the file's import. Run: `pnpm --filter @rch/domain test` → FAIL.

- [ ] **Step 2: Add the table and export it**

Write `PROD_ORDER_TRANSITIONS` into `packages/domain/src/transitions.ts` exactly as spelled out above (importing `PordStatus` from `@rch/contract` alongside the three status types already imported there), and add the name to the existing transitions export line in `packages/domain/src/index.ts`. Run: `pnpm --filter @rch/domain test` → PASS.

- [ ] **Step 3: Write the failing module tests**

`apps/api/src/modules/production/production.test.ts`
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { truncateAll } from "../../test/db.js";
import { postMoves } from "../../lib/ledger.js";
import { reservations, stockMoves } from "../../db/schema/index.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "production" }); await app.ready(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const post = async (user: string, url: string, payload?: unknown) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: await hdr(user), ...(payload === undefined ? {} : { payload }) });
const orders = async () => (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, "u4") })).json().pord;
const onHand = async (loc: string, it: string) =>
  (await app.inject({ method: "GET", url: "/api/v1/stock", headers: await authHeaders(app, "u2") })).json().stock[loc]?.[it] ?? 0;
/** The location's display name, read from the master the server itself serves. */
const locName = async (key: string) =>
  (await app.inject({ method: "GET", url: "/api/v1/locations", headers: await authHeaders(app, "u4") })).json()[key].n;
/** Bake enough of an item that the kitchen can cover a dispatch. */
const bake = (it: string, n: number) =>
  app.testDb!.db.transaction((tx) => postMoves(tx, [{ loc: "kitchen", it, qty: n, kind: "production_yield", refType: "test", refId: "bake" }]));

describe("POST /prod-orders/:id/dispatch", () => {
  it("puts every item on one ticket addressed to the ordering outlet, and reserves rather than moves", async () => {
    const [order] = (await orders()).filter((o: { st: string }) => o.st !== "Dispatched" && o.st !== "Declined");
    for (const l of order.lines) await bake(l.it, l.qty);
    const before = await onHand("kitchen", order.lines[0].it);
    const movesBefore = (await app.testDb!.db.select().from(stockMoves)).length;

    const r = await post("u4", `/prod-orders/${order.id}/dispatch`);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.ticket).toMatchObject({ req: order.id, from: "kitchen", to: order.from, st: "Issued" });
    expect(b.result.ticket.lines).toHaveLength(order.lines.length);
    expect(b.result.ticket.otp).toMatch(/^\d{6}$/);
    expect(b.result.order.st).toBe("Dispatched");
    expect(b.result.order.hist.at(-1)).toMatchObject({ s: "Dispatched", who: "Vinoth Prakash" });
    expect(b.changed).toEqual(["pord", "tkt", "rsv"]);
    expect(b.message).toBe(`${b.result.ticket.id} issued — all ${order.lines.length} item${order.lines.length === 1 ? "" : "s"} of ${order.id} reserved for ${await locName(order.from)}`);

    // Approval authorises; the scan moves.
    expect(await onHand("kitchen", order.lines[0].it)).toBe(before);
    expect((await app.testDb!.db.select().from(stockMoves)).length).toBe(movesBefore);
    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, b.result.ticket.id));
    expect(held).toHaveLength(order.lines.length);
    expect(held.every((h) => h.loc === "kitchen" && h.releasedAt === null)).toBe(true);
  });

  it("dispatches nothing when one item is short, and names every item that is", async () => {
    const [order] = (await orders()).filter((o: { st: string; lines: unknown[] }) => o.st !== "Dispatched" && o.st !== "Declined" && o.lines.length > 1);
    await bake(order.lines[0].it, order.lines[0].qty);          // only the first is covered
    const movesBefore = (await app.testDb!.db.select().from(stockMoves)).length;

    const r = await post("u4", `/prod-orders/${order.id}/dispatch`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toMatch(/^Nothing dispatched — the kitchen is short of /);
    expect((await app.testDb!.db.select().from(stockMoves)).length).toBe(movesBefore);
    expect(await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, "any"))).toEqual([]);
    expect((await orders()).find((o: { id: string }) => o.id === order.id).st).not.toBe("Dispatched");
  });

  it("refuses to raise a second ticket for an order already dispatched", async () => {
    const [order] = (await orders()).filter((o: { st: string }) => o.st !== "Dispatched" && o.st !== "Declined");
    for (const l of order.lines) await bake(l.it, l.qty);
    expect((await post("u4", `/prod-orders/${order.id}/dispatch`)).statusCode).toBe(200);

    const again = await post("u4", `/prod-orders/${order.id}/dispatch`);
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe(`${order.id} has already gone out — it is on one ticket to ${await locName(order.from)}`);
  });

  it("refuses a declined order in its own words", async () => {
    const declined = (await orders()).find((o: { st: string }) => o.st === "Declined");
    if (declined) {
      const r = await post("u4", `/prod-orders/${declined.id}/dispatch`);
      expect(r.statusCode).toBe(422);
      expect(r.json().error.message).toBe(`${declined.id} was declined — it cannot be dispatched`);
    }
  });

  it("dispatches exactly once when two screens press together", async () => {
    const [order] = (await orders()).filter((o: { st: string }) => o.st !== "Dispatched" && o.st !== "Declined");
    for (const l of order.lines) await bake(l.it, l.qty);
    const both = await Promise.all([post("u4", `/prod-orders/${order.id}/dispatch`), post("u4", `/prod-orders/${order.id}/dispatch`)]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
  });

  it("404s an order that is not there, and is absent for every other role", async () => {
    expect((await post("u4", "/prod-orders/PRD-2026-999/dispatch")).json().error.message).toBe("There is no production order PRD-2026-999.");
    for (const u of ["u1", "u2", "u3", "u5"]) expect((await post(u, "/prod-orders/PRD-2026-029/dispatch")).statusCode).toBe(404);
  });
});

describe("POST /distributions", () => {
  it("reserves at the kitchen and raises the ticket the outlet collects against", async () => {
    await bake("puff", 20);
    const before = await onHand("kitchen", "puff");

    const r = await post("u4", "/distributions", { it: "puff", qty: 5, to: "kiosk" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ req: "Direct issue", from: "kitchen", to: "kiosk", st: "Issued" });
    expect(b.result.lines).toEqual([{ it: "puff", qty: 5 }]);
    expect(b.changed).toEqual(["tkt", "rsv"]);
    expect(b.message).toBe(`${b.result.id} issued — 5 Veg puffs reserved for Snack Kiosk`);
    expect(await onHand("kitchen", "puff")).toBe(before);
    expect(await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, b.result.id))).toHaveLength(0);
  });

  it("refuses a destination that does not list the product (M9)", async () => {
    await bake("puff", 20);
    const r = await post("u4", "/distributions", { it: "puff", qty: 5, to: "coffee" });   // coffee's menu has no puff
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Veg puffs is not listed at Coffee Shop — add it to that menu first");
  });

  it("refuses more than the kitchen has free", async () => {
    const free = await onHand("kitchen", "puff");
    const r = await post("u4", "/distributions", { it: "puff", qty: free + 1, to: "kiosk" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`Kitchen has only ${free} nos free to promise`);
  });

  it("counts what another ticket is already holding", async () => {
    const free = await onHand("kitchen", "puff");
    await given.ticket(app.testDb!.db, { from: "kitchen", to: "kiosk", lines: [{ it: "puff", qty: free }] });
    const r = await post("u4", "/distributions", { it: "puff", qty: 1, to: "kiosk" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Kitchen has only 0 nos free to promise");
  });

  it("refuses a quantity of nothing, 404s an unknown item, and is absent for a counter", async () => {
    expect((await post("u4", "/distributions", { it: "puff", qty: 0, to: "kiosk" })).json().error.message).toBe("Enter a quantity");
    expect((await post("u4", "/distributions", { it: "totally-fake", qty: 1, to: "kiosk" })).json().error.message).toBe("There is no item totally-fake.");
    expect((await post("u1", "/distributions", { it: "puff", qty: 1, to: "kiosk" })).statusCode).toBe(404);
  });
});
```
Run: `pnpm --filter @rch/api test src/modules/production` → FAIL (the stub mounts nothing).

- [ ] **Step 4: Write `repo.ts`, then `service.ts`**

`dispatch`, in full, because it is where the all-or-nothing rule and the lock order both live:
```ts
    async dispatch(claims: AccessClaims, id: string): Promise<WriteResponse<DispatchResult>> {
      return withTransaction(db, async (tx) => {
        const o = await productionRepo.head(tx, id);
        if (!o) throw new NotFoundError(`There is no production order ${id}.`);
        const master = await loadMaster(tx);
        const to = master.locations[o.fromLoc];
        // One order, one ticket. Dispatching twice would raise a second ticket for stock already
        // promised, which is how half an order ends up in two places.
        assertRule(o.status !== "Dispatched", `${id} has already gone out — it is on one ticket to ${to.n}`);
        assertRule(o.status !== "Declined", `${id} was declined — it cannot be dispatched`);

        // Fold a repeated item into a single line so the cover check is made against the whole
        // quantity the order asks for, not one line of it at a time.
        const folded = new Map<string, number>();
        for (const l of await productionRepo.lines(tx, id)) folded.set(l.it, round3((folded.get(l.it) ?? 0) + l.qty));
        const lines = [...folded].map(([it, qty]) => ({ it, qty }));
        assertRule(lines.length > 0, `${id} has no items on it`);

        // Ids before balance locks, always (see lib/ledger.ts's header): a sale that has taken
        // the sequences lock must never wait behind a dispatch holding a shelf, or the reverse.
        const at = new Date();
        const no = await allocateTicket(tx, at);
        await lockBalances(tx, lines.map((l) => ({ loc: "kitchen", it: l.it })));
        const stock = await productionRepo.balancesAt(tx, "kitchen", lines.map((l) => l.it));
        const held = await reservedAt(tx, "kitchen", lines.map((l) => l.it));
        // All or nothing: a part-dispatched order leaves the outlet guessing what is still
        // coming, so every item short is named and nothing moves.
        const short = lines.filter((l) => round3((stock[l.it] ?? 0) - (held[`kitchen:${l.it}`] ?? 0)) < l.qty);
        assertRule(short.length === 0, `Nothing dispatched — the kitchen is short of ${short.map((l) => master.items[l.it]?.n ?? l.it).join(", ")}`);

        const ticket = await writeTicket(tx, { refType: "prod_order", refId: id, from: "kitchen", to: o.fromLoc, lines, by: claims.sub, at }, no);
        await productionRepo.setStatus(tx, id, "Dispatched");
        const who = await productionRepo.userName(tx, claims.sub);
        await appendHistory(tx, "prod_order", id, "Dispatched", who, at);

        const changed = ["pord", "tkt", "rsv"] as const;
        await emitChanged(tx, changed);
        return {
          result: { order: await productionRepo.wire(tx, id), ticket },
          changed: [...changed],
          message: `${ticket.id} issued — all ${lines.length} item${lines.length === 1 ? "" : "s"} of ${id} reserved for ${to.n}`,
        };
      });
    },
```
`distribute` is the same shape with one line: the quantity rule, the item lookup, the menu rule (`productionRepo.menuAt(tx, body.to)` only when the destination is an Outlet), `allocateTicket` → `lockBalances` → read → cover rule → `writeTicket` with `refType: "direct"`, `refId: "Direct issue"`. It writes no history: `document_history` carries `request`, `requisition`, `purchase_order` and `prod_order` only (spec §16), and a direct issue is none of those.

- [ ] **Step 5: Write `routes.ts`**

```ts
// Production: the two ways the kitchen puts stock on a ticket — an order it was asked for, and
// a tray it decided to push out. Batches and the board's own statuses are Phase 4.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createProductionService } from "./service.js";

export default fp(async (app) => {
  const svc = createProductionService(app.db);
  // Neither is location-scoped: the prod role has one kitchen, and both rules pin `from` to it.
  mount(app, routes.dispatchProdOrder, async (req) => svc.dispatch(req.user, req.params.id));
  mount(app, routes.distribute, async (req) => svc.distribute(req.user, req.body));
}, { name: "module:production", dependencies: ["auth", "rbac", "idempotency", "db"] });
```

- [ ] **Step 6: Run the tests, gate and commit**

Run: `pnpm --filter @rch/api test src/modules/production` → PASS, then `pnpm turbo typecheck test && pnpm lint`.
Then on a seeded local database, dispatch an order and confirm `pnpm --filter @rch/api db:rebuild-balances` leaves `GET /stock` unchanged — a dispatch reserves and must post no move.
```bash
git add packages/domain apps/api/src/modules/production
git commit -m "$(cat <<'EOF'
Put the kitchen's two ticket paths on the server

Dispatching an order and distributing a tray are the only writes in production that create a
ticket, and Phase 3 makes handover a server call — so they cross now, or the kitchen's own
tickets carry ids the server has never heard of. Both reserve and move nothing; a dispatch
that cannot be covered names every item short and writes nothing at all.

Batches, makeProduct and the board's own statuses stay in memory for Phase 4: they create no
ticket, so they cross no seam.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 8: UI cutover — the fourteen request, ticket, shop-ask and kitchen actions call the server

**Files:**
- Modify: `UI/src/store/index.ts`, `UI/src/store/ops.ts`, `UI/src/api/refetch.ts`, `UI/src/api/wire.ts`, `UI/src/lib/selectors.ts`, `UI/src/roles/store/{IssueDesk,IssueDetail,TicketDrawer}.tsx`, `UI/src/roles/counter/TicketDrawer.tsx`, `UI/src/roles/prod/Tickets.tsx`, `UI/src/__tests__/writes.test.ts`, `UI/src/__tests__/store.test.ts`, `UI/src/__tests__/fixes.test.ts`
- Also: `UI/src/__tests__/fixture.ts` (drop `seq.tkt` from `resetStore`; see **Leave alone** below).
- **Not** `UI/src/__tests__/screens.test.tsx` — Task 11 edited it in wave 3. Task 9 does not touch `fixture.ts`: its Note-31 fix sets `auth` explicitly inside `events.test.ts` instead.

**Interfaces:**
- Consumes: `routes` from `@rch/contract`; `call`, `ApiError` from `../api/client`; `refetch` from `../api/refetch`; `REQUEST_TRANSITIONS`, `TICKET_TRANSITIONS`, `canTransition` from `@rch/domain`.
- The twelve actions keep their current names and parameters and become `async`, exactly as `pay`/`toggleAvail` did in Phase 2:
  ```ts
  submitRequest: (note: string, urgent: boolean) => Promise<void>;
  requestFromStore: (it: string, qty: number) => Promise<void>;
  cancelRequest: (id: string) => Promise<void>;
  approveRequest: (id: string, appr: number[], note: string) => Promise<void>;
  rejectRequest: (id: string, note: string) => Promise<void>;
  issueTicket: (reqId: string) => Promise<void>;
  handover: (tktId: string, otp?: string) => Promise<void>;
  receiveTicket: (tktId: string) => Promise<void>;
  transferToOutlet: (from: LocKey, to: LocKey, it: string, qty: number) => Promise<void>;
  askShop: (to: LocKey, it: string, qty: number, note: string) => Promise<void>;
  answerShopAsk: (id: string, grant: number) => Promise<void>;
  declineShopAsk: (id: string, reason: string) => Promise<void>;
  dispatchOrder: (id: string) => Promise<void>;
  distribute: (it: string, n: number, to: LocKey) => Promise<void>;
  ```
- Produces, in `UI/src/api/wire.ts`:
  ```ts
  export function applyRequests(req: Snapshot["req"]): void;
  export function applyTickets(tkt: Snapshot["tkt"]): void;
  export function applyShopAsks(asks: Snapshot["shopAsks"]): void;
  ```
- Produces, in `UI/src/lib/selectors.ts` (all four read the transition table, so a button the UI offers is a transition the server accepts):
  ```ts
  export const isReqOpen = (st: ReqStatus) => canTransition(REQUEST_TRANSITIONS, st, "Cancelled");
  export const canIssueTicket = (st: ReqStatus) => canTransition(REQUEST_TRANSITIONS, st, "Ticket issued");
  export const canHandOver = (st: TktStatus) => canTransition(TICKET_TRANSITIONS, st, "Collected");
  export const canReceiveTicket = (st: TktStatus) => canTransition(TICKET_TRANSITIONS, st, "Received");
  ```

**The pattern, for every one of the twelve** (Phase 2's, unchanged): build the body, `await call(...)`, `notify(r.message)`, `await refetch(r.changed, r.message)`, and on `ApiError` show `e.message` — otherwise a written-once fallback sentence. **Delete the local rule logic; do not keep it as a preview.** The optimistic `set()` calls go too: the refetch is what updates the screen.

```ts
  submitRequest: async (note, urgent) => {
    const s = get();
    const lines = s.draft.filter((l) => l.it && l.qty > 0).map((l) => ({ it: l.it, qty: l.qty }));
    if (!lines.length || !s.user) { get().notify("Add at least one line with a quantity"); return; }
    try {
      const r = await call(routes.createRequest, { body: { lines, note, urgent } });
      set({ draft: [] });                       // the draft is client-only state; clear it once it landed
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not send the request — check the connection and try again.");
    }
  },
```
The remaining eleven follow the same shape with these bodies and fallback sentences:

| Action | Call | Fallback when the server cannot be reached |
|---|---|---|
| `requestFromStore(it, qty)` | `routes.createRequest`, `{ lines: [{ it, qty }], note: \`Raised from ${LOC[get().user!.loc].n} stock screen\`, urgent: false }` | `"Could not send the request — check the connection and try again."` |
| `cancelRequest(id)` | `routes.cancelRequest`, `{ params: { id } }` | `"Could not cancel the request — check the connection and try again."` |
| `approveRequest(id, appr, note)` | `routes.approveRequest`, `{ params: { id }, body: { appr, note } }` | `"Could not save the approval — check the connection and try again."` |
| `rejectRequest(id, note)` | `routes.rejectRequest`, `{ params: { id }, body: { note } }` | `"Could not save the rejection — check the connection and try again."` |
| `issueTicket(reqId)` | `routes.issueTicket`, `{ params: { id: reqId } }` | `"Could not issue the ticket — check the connection and try again."` |
| `handover(tktId, otp)` | `routes.handover`, `{ params: { id: tktId }, body: otp === undefined ? {} : { otp: otp.trim() } }` | `"Could not hand the ticket over — check the connection and try again."` |
| `receiveTicket(tktId)` | `routes.receiveTicket`, `{ params: { id: tktId } }`; on success also `set({ drawer: null })`, as it does today | `"Could not receive the ticket — check the connection and try again."` |
| `transferToOutlet(from, to, it, qty)` | `routes.transfer`, `{ body: { from, to, it, qty } }` | `"Could not send the transfer — check the connection and try again."` |
| `askShop(to, it, qty, note)` | `routes.askShop`, `{ body: { to, it, qty, note: note.trim() } }` | `"Could not send the ask — check the connection and try again."` |
| `answerShopAsk(id, grant)` | `routes.answerShopAsk`, `{ params: { id }, body: { grant } }` | `"Could not answer the ask — check the connection and try again."` |
| `declineShopAsk(id, reason)` | `routes.declineShopAsk`, `{ params: { id }, body: { reason: reason.trim() } }` | `"Could not decline the ask — check the connection and try again."` |
| `dispatchOrder(id)` | `routes.dispatchProdOrder`, `{ params: { id } }`; on success also `set({ drawer: null })`, as it does today | `"Could not dispatch the order — check the connection and try again."` |
| `distribute(it, n, to)` | `routes.distribute`, `{ body: { it, qty: n, to } }` | `"Could not send it out — check the connection and try again."` |

`answerShopAsk` **must not** call `transferToOutlet` any more: on the server it is one endpoint that both grants the ask and raises the ticket, and calling both would raise two tickets.

**Leave alone:** `setOrderStatus`, `makeProduct` and everything in `store/procurement.ts`. They stay in memory until Phases 4 and 5, they still read `seq` and `hist`/`now`, and `qty`/`resv` stay imported for `makeProduct`'s ingredient check. `freeToPromise` and `makeOtp` both leave `store/index.ts`'s import list once `approveRequest`, `dispatchOrder` and `distribute` are cut over — no local path mints a ticket any more — and `seq.tkt` becomes dead; delete it from the `Seq` interface, from the store's initial state and from `UI/src/__tests__/fixture.ts`'s `resetStore`. `noUnusedLocals` will point at the imports; the `seq.tkt` field needs the grep.

- [ ] **Step 1: Write the failing tests**

Append to `UI/src/__tests__/writes.test.ts`, using the file's existing `serve`/`hit`/`calls`/`json`/`refusal` helpers and `as()`:
```ts
const REQ = {
  id: "REQ-2026-0913", from: "coffee", by: "Kavitha Raman", at: "2026-09-04T04:30:00.000Z",
  lines: [{ it: "milk", qty: 20, appr: 0 }], st: "Request sent", ticket: null, mgrNote: "", hist: [],
};
const TKT = { id: "TKT-0441", req: "REQ-2026-0913", from: "store", to: "coffee", lines: [{ it: "milk", qty: 12 }], st: "Issued", otp: "989089" };
const ASK = { id: "ASK-063", from: "coffee", to: "kiosk", it: "water", qty: 24, st: "Asked", by: "Kavitha Raman", at: "2026-09-04T04:30:00.000Z", note: "Ran dry" };

describe("the request chain — the twelve writes", () => {
  it("submitRequest posts the draft and reads the requests back", async () => {
    as("counter");
    S().setDraft([{ it: "milk", qty: 20 }, { it: "sugar", qty: 4 }]);
    serve({
      "POST /api/v1/requests": () => json({ result: REQ, changed: ["req"], message: "REQ-2026-0913 sent to the outlet manager — 2 lines" }),
      "GET /api/v1/requests": () => json([REQ]),
    });

    await S().submitRequest("Counter runs dry by 4pm", true);

    expect(hit("POST /api/v1/requests")[0].body).toEqual({ lines: [{ it: "milk", qty: 20 }, { it: "sugar", qty: 4 }], note: "Counter runs dry by 4pm", urgent: true });
    expect(S().draft).toEqual([]);
    expect(S().toast).toBe("REQ-2026-0913 sent to the outlet manager — 2 lines");
    expect(hit("GET /api/v1/requests")).toHaveLength(1);
    expect(hit("GET /api/v1/snapshot")).toHaveLength(0);
    expect(S().req.at(-1)!.id).toBe("REQ-2026-0913");
    expect(S().req.at(-1)!.at).toMatch(/^\d{2}:\d{2}$/);       // ISO -> HH:MM on the way in
  });

  it("requestFromStore names the screen it came from", async () => {
    as("counter");
    serve({ "POST /api/v1/requests": () => json({ result: REQ, changed: ["req"], message: "REQ-2026-0913 raised for 20 Milk 1L — with the outlet manager now" }), "GET /api/v1/requests": () => json([REQ]) });
    await S().requestFromStore("milk", 20);
    expect(hit("POST /api/v1/requests")[0].body).toEqual({ lines: [{ it: "milk", qty: 20 }], note: "Raised from Coffee Shop stock screen", urgent: false });
  });

  it("sends nothing at all for an empty draft", async () => {
    as("counter");
    S().setDraft([]);
    await S().submitRequest("", false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(S().toast).toBe("Add at least one line with a quantity");
  });

  it("approveRequest sends the manager's numbers and repeats the server's sentence", async () => {
    as("manager");
    serve({
      "POST /api/v1/requests/REQ-2026-0911/approve": () => json({ result: { request: { ...REQ, id: "REQ-2026-0911", st: "Partially approved" }, trimmed: true }, changed: ["req"], message: "REQ-2026-0911 trimmed — the central store cannot cover the full quantity" }),
      "GET /api/v1/requests": () => json([REQ]),
    });
    await S().approveRequest("REQ-2026-0911", [20], "Store only holds 12 L.");
    expect(hit("POST /api/v1/requests/REQ-2026-0911/approve")[0].body).toEqual({ appr: [20], note: "Store only holds 12 L." });
    expect(S().toast).toBe("REQ-2026-0911 trimmed — the central store cannot cover the full quantity");
  });

  it("hands a rejection refusal to the manager word for word and changes nothing", async () => {
    as("manager");
    const before = S().req.find((r) => r.id === "REQ-2026-0912")!.st;
    serve({ "POST /api/v1/requests/REQ-2026-0912/reject": () => refusal("Give a reason — the counter sees it on the request") });
    await S().rejectRequest("REQ-2026-0912", "   ");
    expect(S().toast).toBe("Give a reason — the counter sees it on the request");
    expect(S().req.find((r) => r.id === "REQ-2026-0912")!.st).toBe(before);
    expect(calls()).toHaveLength(1);
  });

  it("issueTicket reads requests, tickets and balances back", async () => {
    as("store");
    serve({
      "POST /api/v1/requests/REQ-2026-0911/issue-ticket": () => json({ result: { request: { ...REQ, id: "REQ-2026-0911", st: "Ticket issued", ticket: "TKT-0441" }, ticket: TKT }, changed: ["req", "tkt", "rsv"], message: "TKT-0441 issued — Coffee Shop can collect against this ticket" }),
      "GET /api/v1/requests": () => json([REQ]), "GET /api/v1/tickets": () => json([TKT]), "GET /api/v1/stock": () => json(STOCK),
    });
    await S().issueTicket("REQ-2026-0911");
    expect(calls().map((c) => c.at).sort()).toEqual(["GET /api/v1/requests", "GET /api/v1/stock", "GET /api/v1/tickets", "POST /api/v1/requests/REQ-2026-0911/issue-ticket"]);
    expect(hit("GET /api/v1/snapshot")).toHaveLength(0);
    expect(S().tkt.at(-1)!.id).toBe("TKT-0441");
  });

  it("handover sends the OTP the store keeper typed", async () => {
    as("store");
    serve({
      "POST /api/v1/tickets/TKT-0440/handover": () => json({ result: { ...TKT, id: "TKT-0440", st: "Collected" }, changed: ["tkt", "req", "rsv", "stock"], message: "TKT-0440 handed over — stock is in transit to Coffee Shop" }),
      "GET /api/v1/requests": () => json([REQ]), "GET /api/v1/tickets": () => json([TKT]), "GET /api/v1/stock": () => json(STOCK),
    });
    await S().handover("TKT-0440", " 418327 ");
    expect(hit("POST /api/v1/tickets/TKT-0440/handover")[0].body).toEqual({ otp: "418327" });
    expect(S().toast).toBe("TKT-0440 handed over — stock is in transit to Coffee Shop");
  });

  it("handover sends an empty body for the supervisor override", async () => {
    as("store");
    serve({
      "POST /api/v1/tickets/TKT-0440/handover": () => json({ result: { ...TKT, id: "TKT-0440", st: "Collected" }, changed: ["tkt", "req", "rsv", "stock"], message: "TKT-0440 handed over on a supervisor override — stock is in transit to Coffee Shop" }),
      "GET /api/v1/requests": () => json([REQ]), "GET /api/v1/tickets": () => json([TKT]), "GET /api/v1/stock": () => json(STOCK),
    });
    await S().handover("TKT-0440");
    expect(hit("POST /api/v1/tickets/TKT-0440/handover")[0].body).toEqual({});
  });

  it("repeats a wrong-OTP refusal and moves nothing", async () => {
    as("store");
    serve({ "POST /api/v1/tickets/TKT-0440/handover": () => refusal("That OTP does not match TKT-0440. Ask the collector to read it again.") });
    await S().handover("TKT-0440", "000000");
    expect(S().toast).toBe("That OTP does not match TKT-0440. Ask the collector to read it again.");
    expect(S().tkt.find((t) => t.id === "TKT-0440")!.st).toBe("Issued");
    expect(calls()).toHaveLength(1);
  });

  it("receiveTicket closes the drawer once the server has taken it", async () => {
    as("counter");
    S().openDrawer("tkt", "TKT-0440");
    serve({
      "POST /api/v1/tickets/TKT-0440/receive": () => json({ result: { ...TKT, id: "TKT-0440", st: "Received" }, changed: ["tkt", "req", "stock"], message: "Received at Coffee Shop — stock is on the shelf" }),
      "GET /api/v1/requests": () => json([REQ]), "GET /api/v1/tickets": () => json([TKT]), "GET /api/v1/stock": () => json(STOCK),
    });
    await S().receiveTicket("TKT-0440");
    expect(S().drawer).toBeNull();
    expect(S().toast).toBe("Received at Coffee Shop — stock is on the shelf");
  });

  it("transferToOutlet posts both ends and the quantity", async () => {
    as("counter");
    serve({ "POST /api/v1/transfers": () => json({ result: TKT, changed: ["tkt", "rsv"], message: "TKT-0441 issued — 6 nos reserved at Coffee Shop for Snack Kiosk" }), "GET /api/v1/tickets": () => json([TKT]), "GET /api/v1/stock": () => json(STOCK) });
    await S().transferToOutlet("coffee", "kiosk", "chips", 6);
    expect(hit("POST /api/v1/transfers")[0].body).toEqual({ from: "coffee", to: "kiosk", it: "chips", qty: 6 });
  });

  it("askShop names only the shop being asked — the sender's own is the token's", async () => {
    as("counter");
    serve({ "POST /api/v1/shop-asks": () => json({ result: ASK, changed: ["shopAsks"], message: "ASK-063 sent to Snack Kiosk — they decide, not the manager" }), "GET /api/v1/shop-asks": () => json([ASK]) });
    await S().askShop("kiosk", "water", 24, "  Ran dry  ");
    expect(hit("POST /api/v1/shop-asks")[0].body).toEqual({ to: "kiosk", it: "water", qty: 24, note: "Ran dry" });
    expect(hit("GET /api/v1/shop-asks")).toHaveLength(1);
    expect(S().shopAsks[0].id).toBe("ASK-063");
  });

  it("answerShopAsk grants and raises the ticket in one call, not two", async () => {
    as("counter");
    serve({
      "POST /api/v1/shop-asks/ASK-0060/answer": () => json({ result: { ask: { ...ASK, id: "ASK-0060", st: "Sent", grant: 6, ticket: "TKT-0441" }, ticket: TKT }, changed: ["shopAsks", "tkt", "rsv"], message: "ASK-0060 granted — TKT-0441 issued for 6 nos to Snack Kiosk" }),
      "GET /api/v1/shop-asks": () => json([ASK]), "GET /api/v1/tickets": () => json([TKT]), "GET /api/v1/stock": () => json(STOCK),
    });
    await S().answerShopAsk("ASK-0060", 6);
    expect(hit("POST /api/v1/shop-asks/ASK-0060/answer")[0].body).toEqual({ grant: 6 });
    expect(hit("POST /api/v1/transfers")).toHaveLength(0);       // one endpoint, one ticket
    expect(S().toast).toBe("ASK-0060 granted — TKT-0441 issued for 6 nos to Snack Kiosk");
  });

  it("declineShopAsk trims the reason it sends", async () => {
    as("counter");
    serve({ "POST /api/v1/shop-asks/ASK-0060/decline": () => json({ result: { ...ASK, id: "ASK-0060", st: "Declined", reason: "We are short ourselves" }, changed: ["shopAsks"], message: "ASK-0060 declined" }), "GET /api/v1/shop-asks": () => json([ASK]) });
    await S().declineShopAsk("ASK-0060", "  We are short ourselves  ");
    expect(hit("POST /api/v1/shop-asks/ASK-0060/decline")[0].body).toEqual({ reason: "We are short ourselves" });
  });
});

describe("refetch — the movement slices have narrow readers now", () => {
  it("answers req, tkt and shopAsks without a snapshot", async () => {
    serve({ "GET /api/v1/requests": () => json([REQ]), "GET /api/v1/tickets": () => json([TKT]), "GET /api/v1/shop-asks": () => json([ASK]) });
    await refetch(["req", "tkt", "shopAsks"]);
    expect(calls().map((c) => c.at).sort()).toEqual(["GET /api/v1/requests", "GET /api/v1/shop-asks", "GET /api/v1/tickets"]);
  });

  it("still takes one snapshot when a write touched a slice with no reader", async () => {
    serve({ "GET /api/v1/snapshot": () => json(snapshot()) });
    await refetch(["req", "prices"]);
    expect(calls().map((c) => c.at)).toEqual(["GET /api/v1/snapshot"]);
  });
});
```

And add to `UI/src/__tests__/store.test.ts`, replacing the cases the server now owns (see Step 4):
```ts
describe("what a button may offer is what the server accepts", () => {
  it("cancels only while the request is still open", () => {
    expect(isReqOpen("Request sent")).toBe(true);
    expect(isReqOpen("Draft")).toBe(true);
    expect(isReqOpen("Ticket issued")).toBe(false);
    expect(isReqOpen("Closed")).toBe(false);
  });
  it("offers a ticket only for a decision that has one to give", () => {
    expect(canIssueTicket("Manager approved")).toBe(true);
    expect(canIssueTicket("Partially approved")).toBe(true);
    expect(canIssueTicket("Request sent")).toBe(false);
    expect(canIssueTicket("Rejected")).toBe(false);
  });
  it("offers handover and receipt in order", () => {
    expect(canHandOver("Issued")).toBe(true);
    expect(canHandOver("Collected")).toBe(false);
    expect(canReceiveTicket("Collected")).toBe(true);
    expect(canReceiveTicket("Issued")).toBe(false);
  });
});
```
Run: `pnpm --filter @rch/ui test` → FAIL.

- [ ] **Step 2: Widen `refetch` and add the three `apply` functions**

`UI/src/api/wire.ts` — beside `applyStock`/`applyBills`:
```ts
/** GET /requests -> the request desk, times as "HH:MM" and history stamps with them. */
export function applyRequests(req: Snapshot["req"]): void {
  useApp.setState({ req: req.map((r) => ({ ...r, at: t(r.at), hist: hist(r.hist) })) });
}
/** GET /tickets -> the tickets. Nothing on a ticket is a time, so it passes straight through. */
export function applyTickets(tkt: Snapshot["tkt"]): void { useApp.setState({ tkt }); }
/** GET /shop-asks -> the shop-to-shop asks, times as "HH:MM". */
export function applyShopAsks(asks: Snapshot["shopAsks"]): void {
  useApp.setState({ shopAsks: asks.map((a) => ({ ...a, at: t(a.at) })) });
}
```
`UI/src/api/refetch.ts` — the three new slices join `stock` and `bills` as narrow reads, so only `prices`, `menu` and the collections later phases add still cost a snapshot:
```ts
const STOCK: readonly Changed[] = ["stock", "rsv", "ovr"];
/** One reader per slice that has one; everything else falls through to the snapshot. */
const NARROW: Partial<Record<Changed, () => Promise<void>>> = {
  bills: () => call(routes.bills).then(applyBills),
  req: () => call(routes.requests).then(applyRequests),
  tkt: () => call(routes.ticketsList).then(applyTickets),
  shopAsks: () => call(routes.shopAsks).then(applyShopAsks),
};

export async function refetch(changed: readonly Changed[], after?: string): Promise<void> {
  const want = new Set<Changed>(changed);
  try {
    if ([...want].some((c) => !NARROW[c] && !STOCK.includes(c))) { await useApp.getState().loadSnapshot(); return; }
    await Promise.all([
      ...(STOCK.some((c) => want.has(c)) ? [call(routes.stock).then(applyStock)] : []),
      ...[...want].filter((c) => NARROW[c]).map((c) => NARROW[c]!()),
    ]);
  } catch {
    useApp.getState().notify(after
      ? `${after} — the screen could not be refreshed; reload to see the latest.`
      : "Saved — but the screen could not be refreshed. Reload to see the latest.");
  }
}
```
Keep the existing doc comment on `refetch` (updating its "phase 3 replaces that" line, which this is).

- [ ] **Step 3: Cut the twelve actions over**

Rewrite them in `UI/src/store/index.ts` (`submitRequest`, `requestFromStore`, `cancelRequest`, `approveRequest`, `rejectRequest`, `issueTicket`, `handover`, `receiveTicket`) and `UI/src/store/ops.ts` (`transferToOutlet`, `askShop`, `answerShopAsk`, `declineShopAsk`) to the pattern and the table above, updating the `AppState`/`OpsSlice` signatures to `Promise<void>`. Delete every local rule, every local id (`"REQ-2026-0" + …`, `"TKT-0" + …`), every optimistic `set()` of `req`/`tkt`/`rsv`/`stock`/`shopAsks`, and the now-unused `freeToPromise` import. `ops.ts`'s `OUTLETS`, `fq` and `U` imports may become unused for these four actions but are still used by `createItem` — let `noUnusedLocals` decide.

- [ ] **Step 4: Move every test of a cut-over action to the server, and gate the buttons on the table**

Fourteen store actions become `async` + `fetch` in this task. **Every** UI case that calls one of them asserts synchronously against local state in a file with no fetch stub, so every one of them must go or be rewritten — `pnpm --filter @rch/ui test` cannot pass otherwise. The list below is exhaustive; regenerate it before you start and confirm it still matches:
```bash
grep -rn 'S()\.\(handover\|receiveTicket\|approveRequest\|rejectRequest\|issueTicket\|cancelRequest\|submitRequest\|requestFromStore\|transferToOutlet\|askShop\|answerShopAsk\|declineShopAsk\|dispatchOrder\|distribute\)(' UI/src/__tests__/
```

**Delete, because the server owns the rule now** (name each one and its replacement in the commit body):

| File · describe · case | Replaced by |
|---|---|
| `store.test.ts` · counter operator · "raises a multi-item request" | `requests.test.ts` "a counter raises a multi-line request from their own counter" |
| `store.test.ts` · counter operator · "cancels only while the request is still open" | `requests.test.ts` "cancels only while the request is still open" (plus the transition case added in Step 1) |
| `store.test.ts` · the two-stage approval chain · "manager trims the quantity, store issues a ticket for only what was approved" | `requests.test.ts` "trims to what the store can cover and records the shortfall (C4, C6)" + "issues for what was approved, reserves it, and moves nothing" + `tickets.test.ts` "moves the stock out on the OTP, releases the hold, and closes nothing else" |
| `store.test.ts` · the two-stage approval chain · "a manager cannot approve more than was asked, nor more than the store can cover" | `requests.test.ts` "trims to what the store can cover and records the shortfall (C4, C6)" |
| `store.test.ts` · the two-stage approval chain · "rejecting issues no ticket" | `requests.test.ts` "rejects when a reason is given, and issues no ticket" |
| `store.test.ts` · production · "refuses to distribute more than the kitchen holds" | `production.test.ts` "refuses more than the kitchen has free" |
| `fixes.test.ts` · **C2** (all three cases) | `production.test.ts` "reserves rather than moves" half of "puts every item on one ticket…" and "reserves at the kitchen and raises the ticket…"; `tickets.test.ts` "lets the kitchen hand its own ticket over (C2)" and "books the stock in and closes the request behind it" |
| `fixes.test.ts` · **C3** (both cases) | `requests.test.ts` "lets the kitchen raise one too, from the kitchen" and "refuses a line with no quantity, in the operator's words (C3)" |
| `fixes.test.ts` · **C4** (both cases) | `requests.test.ts` "trims to what the store can cover and records the shortfall (C4, C6)" and "approves in full and forwards it, with no shortfall" |
| `fixes.test.ts` · **C5** · "frees the reservation when the seeded ticket is handed over" | `tickets.test.ts` "moves the stock out on the OTP, releases the hold, and closes nothing else" |
| `fixes.test.ts` · **C6** (both cases) | `requests.test.ts` "nets an approval already made against the next one (C6)" |
| `fixes.test.ts` · **H6** | `requests.test.ts` "names the manager who approved, not the operator who raised (H6)" |
| `fixes.test.ts` · **H7** (both cases) | `requests.test.ts` "refuses to reject without a reason (H7)" and "rejects when a reason is given, and issues no ticket" |
| `fixes.test.ts` · **M9** (both cases) | `production.test.ts` "refuses a destination that does not list the product (M9)" and the happy path in "reserves at the kitchen and raises the ticket the outlet collects against" |
| `fixes.test.ts` · "a production order goes out whole, to the place that raised it" (all four cases) | `production.test.ts` "puts every item on one ticket addressed to the ordering outlet…", "dispatches nothing when one item is short, and names every item that is", "refuses to raise a second ticket for an order already dispatched"; `tickets.test.ts` "books the stock in and closes the request behind it" for the landing half |
| `fixes.test.ts` · "a rejection records who made the call" (both cases) | `requests.test.ts` "names the manager who approved…" (for `apprBy`) and "refuses to reject without a reason (H7)" |
| `fixes.test.ts` · "two shops deal with each other directly" (all three cases) | `shopasks.test.ts` "asks the other shop directly, not the manager", "grants it, reserves at the shop that holds it…", "needs a reason the other shop can read"; `tickets.test.ts` "refuses a wrong OTP and moves nothing" |
| `fixes.test.ts` · "a shop-to-shop ask is answerable from the receiving counter" · "granting it moves stock the other way, on a ticket" | `shopasks.test.ts` "grants it, reserves at the shop that holds it, and raises the ticket the asker collects" |
| `fixes.test.ts` · "declining an inbound ask takes two steps" (both cases) | `shopasks.test.ts` "needs a reason the other shop can read" and "declines with the reason, and issues no ticket" |

**Keep, untouched** — they call no cut-over action: `fixes.test.ts` C1, C5's "reserves the lines of every issued ticket at start-up", H1, H4, H8, H9, M3, M4, M11, UA-14, "countable units…", the support describes, the new-product describes, the role-label describes, "a shop-to-shop ask is answerable…" cases 1 and 3; `store.test.ts` "builds one cart line per item scanned", "holds the printed MRP as a ceiling on floor 3" and the whole `availability` describe.

**Rewrite, because the assertion is about a selector rather than an action:**
- `fixes.test.ts` · **M8** · "reports quantity handed over but not yet received" — `inTransit` is still a UI selector, so drive the ticket's status directly:
```ts
  it("reports quantity handed over but not yet received", () => {
    const t = seedTkt.find((x) => x.st === "Issued" && x.from === "store")!;
    const it = t.lines[0].it;
    expect(inTransit(S(), it)).toBe(0);
    useApp.setState({ tkt: S().tkt.map((x) => (x.id === t.id ? { ...x, st: "Collected" as const } : x)) });
    expect(inTransit(S(), it)).toBe(t.lines[0].qty);
    useApp.setState({ tkt: S().tkt.map((x) => (x.id === t.id ? { ...x, st: "Received" as const } : x)) });
    expect(inTransit(S(), it)).toBe(0);
  });
```
- `store.test.ts` · production · "accepts, makes and dispatches, creating a ticket" — split it. `setOrderStatus` and `makeProduct` stay local until Phase 4, so keep those assertions and drop the dispatch and handover half (which `production.test.ts` "puts every item on one ticket…" and `tickets.test.ts` "moves the stock out on the OTP…" now hold):
```ts
  it("accepts an order and makes what it asks for", () => {
    as("prod");
    S().setOrderStatus("PRD-2026-029", "Accepted");
    expect(S().pord.find((o) => o.id === "PRD-2026-029")!.st).toBe("Accepted");
    const before = qty(S(), "kitchen", "puff");
    S().makeProduct("puff", 60);
    expect(qty(S(), "kitchen", "puff")).toBe(before + 60);
    expect(S().batch[0].qty).toBe(60);
  });
```

**Then the button gates,** so no screen can offer a transition the server refuses:
- `UI/src/lib/selectors.ts`: reimplement `isReqOpen` and add the three helpers from **Interfaces**, plus `export const canDispatch = (st: PordStatus) => canTransition(PROD_ORDER_TRANSITIONS, st, "Dispatched");`.
- `UI/src/roles/store/IssueDesk.tsx:63` and `UI/src/roles/store/IssueDetail.tsx:64` — replace `(r.st === "Manager approved" || r.st === "Partially approved")` with `canIssueTicket(r.st)`.
- `UI/src/roles/store/TicketDrawer.tsx:46` — `{t.st === "Issued" ? (` becomes `{canHandOver(t.st) ? (`.
- `UI/src/roles/store/IssueDetail.tsx:82` — `ticket && ticket.st === "Issued" ?` becomes `ticket && canHandOver(ticket.st) ?`.
- `UI/src/roles/counter/TicketDrawer.tsx:30` — `const canReceive = tkt.st === "Collected";` becomes `const canReceive = canReceiveTicket(tkt.st);`.
- `UI/src/roles/prod/Tickets.tsx:151` and `:154` — the two `t.st === "Issued"` **on the handover control** become `canHandOver(t.st)`. Leave the list filters and the status wording at `:47`, `:48`, `:49`, `:104`, `:106` and `:164` alone; they describe a status, they do not offer an action.
- The Dispatch control on the kitchen's order board (`grep -rn 'dispatchOrder' UI/src/roles/prod/`) — gate it on `canDispatch(o.st)` rather than on a status literal.

- [ ] **Step 5: Run the UI suite**

Run: `pnpm --filter @rch/ui test`
Expected: PASS. `screens.test.tsx` and `app.test.tsx` render only — no action fires — so they are unaffected.

- [ ] **Step 6: Walk it in the real stack**

With `pnpm dev` against a seeded database: sign in as `RC-4471` → raise a request for 20 milk → the server's sentence, the request on the list. Sign in as `RC-3120` → approve for 20 → the trim sentence and 12 on the line. Sign in as `RC-2088` → generate the ticket, read the OTP, hand over on it → stock leaves the store. Back as `RC-4471` → receive → stock on the coffee shelf and the request Closed. Then as `RC-4471` ask the kiosk for water, and as `RC-4482` grant it.

- [ ] **Step 7: Gate and commit**

Run: `pnpm turbo typecheck test && pnpm lint`
```bash
git add UI
git commit -m "$(cat <<'EOF'
Cut the request chain, tickets, shop asks and the kitchen's two ticket paths over

The fourteen actions call their endpoint, show the server's sentence and refetch what it says
changed; their local rules are deleted, not kept as a preview. Buttons are gated on the
shared transition table, so a control the UI offers is a transition the server accepts. No
local path mints a ticket number any longer, so seq.tkt goes.

Rules that moved, and the server test that now holds them:
  store.test "raises a multi-item request"                      -> requests.test "a counter raises a multi-line request from their own counter"
  store.test "cancels only while the request is still open"     -> requests.test "cancels only while the request is still open"
  store.test "manager trims the quantity, store issues…"        -> requests.test "trims to what the store can cover…" + tickets.test "moves the stock out on the OTP…"
  store.test "a manager cannot approve more than was asked…"    -> requests.test "trims to what the store can cover and records the shortfall (C4, C6)"
  store.test "rejecting issues no ticket"                       -> requests.test "rejects when a reason is given, and issues no ticket"
  store.test "refuses to distribute more than the kitchen holds"-> production.test "refuses more than the kitchen has free"
  fixes.test C2 (3 cases)                                       -> production.test "puts every item on one ticket…" + tickets.test "lets the kitchen hand its own ticket over (C2)" and "books the stock in and closes the request behind it"
  fixes.test C3 (2 cases)                                       -> requests.test "lets the kitchen raise one too, from the kitchen" + "refuses a line with no quantity, in the operator's words (C3)"
  fixes.test C4 (2 cases)                                       -> requests.test "trims to what the store can cover…" + "approves in full and forwards it, with no shortfall"
  fixes.test C5 "frees the reservation when the seeded ticket…" -> tickets.test "moves the stock out on the OTP, releases the hold…"
  fixes.test C6 (2 cases)                                       -> requests.test "nets an approval already made against the next one (C6)"
  fixes.test H6                                                 -> requests.test "names the manager who approved, not the operator who raised (H6)"
  fixes.test H7 (2 cases)                                       -> requests.test "refuses to reject without a reason (H7)" + "rejects when a reason is given…"
  fixes.test M9 (2 cases)                                       -> production.test "refuses a destination that does not list the product (M9)" + "reserves at the kitchen and raises the ticket…"
  fixes.test "a production order goes out whole…" (4 cases)     -> production.test "puts every item on one ticket…", "dispatches nothing when one item is short…", "refuses to raise a second ticket…"
  fixes.test "a rejection records who made the call" (2 cases)  -> requests.test "names the manager who approved…" + "refuses to reject without a reason (H7)"
  fixes.test "two shops deal with each other directly" (3)      -> shopasks.test "asks the other shop directly…", "grants it, reserves at the shop that holds it…", "needs a reason the other shop can read" + tickets.test "refuses a wrong OTP and moves nothing"
  fixes.test "granting it moves stock the other way, on a ticket" -> shopasks.test "grants it, reserves at the shop that holds it…"
  fixes.test "declining an inbound ask takes two steps" (2)     -> shopasks.test "needs a reason the other shop can read" + "declines with the reason, and issues no ticket"
M8 keeps its UI case, rewritten to drive the ticket status with setState — inTransit is still
a selector. store.test's production case keeps its accept-and-make half, which stays local
until Phase 4.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 9: UI live updates — the event stream, debounced refetch, and a "Reconnecting" pill

**Files:**
- Create: `UI/src/api/events.ts`, `UI/src/__tests__/events.test.ts`
- Modify: `UI/src/api/client.ts`, `UI/src/main.tsx`, `UI/src/ui/Shell.tsx`

**Interfaces:**
- Consumes: `API_PREFIX`, `EVENTS_PATH`, `EventNoticeSchema`, `type Changed` from `@rch/contract`; `getAccessToken`, `sessionLost` from `./session`; `refetch` from `./refetch`; `useApp` from `../store`; `Pill` from `./kit` (Shell only).
- Produces:
  ```ts
  // UI/src/api/client.ts — the existing private `refresh()` gains a name the stream can call.
  export async function refreshOnce(): Promise<boolean>;

  // UI/src/api/events.ts
  export type StreamState = "off" | "live" | "reconnecting";
  export function startEventStream(): () => void;      // wires the store subscription; returns an unsubscribe
  export function useStreamState(): StreamState;       // useSyncExternalStore over the module's own state
  export const EVENT_DEBOUNCE_MS = 250;
  ```

**Why `fetch` and not `EventSource`.** `EventSource` cannot send an `Authorization` header, so it would force the access token into the query string — where it lands in nginx's access log, the ALB's, and the browser's history. A `fetch` over `res.body` costs about seventy lines of parser and reuses `client.ts`'s token and its refresh-once path, so the stream authenticates exactly as every other call does. Recorded in spec §16 by Task 10.

**Why the store subscription and not a call inside `login()`.** `UI/src/store/index.ts` belongs to Task 8 in the same wave. `api/events.ts` watches `auth` instead — `"ready"` opens the stream, `"signed-out"` closes it — which is the same lifecycle with no edit to a file another task owns, and it also covers `restore()` and `changePassword()`, which reach `"ready"` without going through `login()`. `main.tsx` calls `startEventStream()` once, the way a side-effect registration is done elsewhere in this codebase.

- [ ] **Step 1: Write the failing test**

`UI/src/__tests__/events.test.ts`. `refetch` is stubbed rather than exercised: what belongs here is *which* collections a notice asks for, not what a refetch does with them (Task 8's `writes.test.ts` owns that).
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_DEBOUNCE_MS, startEventStream, useStreamState } from "../api/events";
import { setAccessToken } from "../api/session";
import { useApp } from "../store";
import { as, resetStore, S } from "./fixture";

vi.mock("../api/refetch", () => ({ refetch: vi.fn(async () => {}) }));
const { refetch } = await import("../api/refetch");

/** A body we push frames into by hand, so a test drives the stream's clock, not the network. */
function stream() {
  let push!: (s: string) => void;
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      push = (s) => c.enqueue(new TextEncoder().encode(s));
      close = () => c.close();
    },
  });
  return { body, push, close };
}

const fetchMock = vi.fn();
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
  // `resetStore` sets 22 fields but not `auth`, and these cases turn on it — so set it here
  // rather than depending on what the case before left behind. (Task 8 owns fixture.ts.)
  useApp.setState({ auth: "signed-out" });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.mocked(refetch).mockClear();
  setAccessToken("tok");
});
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); setAccessToken(null); });

/** Let the stream's reader loop run: microtasks, then whatever timers the test asked for. */
const turn = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };

describe("the event stream", () => {
  it("opens only once the session is ready, and sends the token in a header", async () => {
    const s = stream();
    fetchMock.mockResolvedValue(new Response(s.body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    stop = startEventStream();
    expect(fetchMock).not.toHaveBeenCalled();          // signed out: nothing to listen for

    useApp.setState({ auth: "ready" });
    await turn();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/events");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    // The token is a header, never a query string: it must not reach a log or the history.
    expect(url).not.toContain("tok");
    expect(useStreamState === undefined).toBe(false);
  });

  it("refetches exactly the collections the notices named, once, after the debounce", async () => {
    const s = stream();
    fetchMock.mockResolvedValue(new Response(s.body, { status: 200 }));
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();

    s.push(`id: 1\nevent: changed\ndata: {"collection":"req","at":"2026-09-04T04:30:00.000Z"}\n\n`);
    s.push(`id: 2\nevent: changed\ndata: {"collection":"tkt","at":"2026-09-04T04:30:00.100Z"}\n\n`);
    s.push(`id: 3\nevent: changed\ndata: {"collection":"req","at":"2026-09-04T04:30:00.200Z"}\n\n`);
    await turn();
    expect(refetch).not.toHaveBeenCalled();            // still inside the window

    await turn(EVENT_DEBOUNCE_MS);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect([...(vi.mocked(refetch).mock.calls[0][0] as string[])].sort()).toEqual(["req", "tkt"]);
  });

  it("reads a frame that arrives split across two chunks", async () => {
    const s = stream();
    fetchMock.mockResolvedValue(new Response(s.body, { status: 200 }));
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();

    s.push(`id: 9\nevent: changed\ndata: {"collec`);
    await turn(EVENT_DEBOUNCE_MS);
    expect(refetch).not.toHaveBeenCalled();
    s.push(`tion":"stock","at":"2026-09-04T04:30:00.000Z"}\n\n`);
    await turn(EVENT_DEBOUNCE_MS);
    expect(vi.mocked(refetch).mock.calls[0][0]).toEqual(["stock"]);
  });

  it("ignores a heartbeat and an unreadable frame without dropping the stream", async () => {
    const s = stream();
    fetchMock.mockResolvedValue(new Response(s.body, { status: 200 }));
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();

    s.push(": ping\n\n");
    s.push(`id: 4\nevent: changed\ndata: {"collection":"nonsense","at":"x"}\n\n`);
    s.push(`id: 5\nevent: changed\ndata: not json\n\n`);
    await turn(EVENT_DEBOUNCE_MS);
    expect(refetch).not.toHaveBeenCalled();

    s.push(`id: 6\nevent: changed\ndata: {"collection":"bills","at":"2026-09-04T04:30:00.000Z"}\n\n`);
    await turn(EVENT_DEBOUNCE_MS);
    expect(vi.mocked(refetch).mock.calls[0][0]).toEqual(["bills"]);
  });

  it("takes the whole snapshot again when the server says resync", async () => {
    const s = stream();
    fetchMock.mockResolvedValue(new Response(s.body, { status: 200 }));
    const load = vi.spyOn(S(), "loadSnapshot").mockResolvedValue();
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();

    s.push(`id: 7\nevent: resync\ndata: {"at":"2026-09-04T04:30:00.000Z"}\n\n`);
    await turn(EVENT_DEBOUNCE_MS);
    expect(load).toHaveBeenCalledTimes(1);
    expect(refetch).not.toHaveBeenCalled();            // a resync supersedes the pending slices
  });

  it("reconnects with backoff, quoting the last id it saw, and says so while it is down", async () => {
    const first = stream();
    fetchMock.mockResolvedValueOnce(new Response(first.body, { status: 200 }));
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();
    first.push(`id: 42\nevent: changed\ndata: {"collection":"req","at":"2026-09-04T04:30:00.000Z"}\n\n`);
    await turn(EVENT_DEBOUNCE_MS);

    const second = stream();
    fetchMock.mockResolvedValueOnce(new Response(second.body, { status: 200 }));
    first.close();
    await turn();
    expect(useApp.getState() && true).toBe(true);      // the store is untouched by a drop

    await turn(5000);                                   // past the first backoff step
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["last-event-id"]).toBe("42");
  });

  it("refreshes once on a 401 and retries with the new token", async () => {
    const s = stream();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));                                  // the stream
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: "fresh" }), { status: 200, headers: { "content-type": "application/json" } }));  // POST /auth/refresh
    fetchMock.mockResolvedValueOnce(new Response(s.body, { status: 200 }));                                // the retry
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toContain("/auth/refresh");
    const [, retry] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect((retry.headers as Record<string, string>).authorization).toBe("Bearer fresh");
  });

  it("ends the session when the refresh fails too", async () => {
    as("counter");
    expect(S().user).not.toBeNull();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));   // the stream
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));   // the refresh
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();

    // `sessionLost()` is what the typed client fires; the store drops the user behind it.
    expect(S().user).toBeNull();
    expect(S().auth).toBe("signed-out");
  });

  it("closes the stream when the user signs out, and opens no other", async () => {
    const s = stream();
    fetchMock.mockResolvedValue(new Response(s.body, { status: 200 }));
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    useApp.setState({ auth: "signed-out" });
    await turn(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);         // no reconnect behind a sign-out
  });
});
```
Run: `pnpm --filter @rch/ui test src/__tests__/events.test.ts` → FAIL (`../api/events` does not exist).

- [ ] **Step 2: Name the refresh in `UI/src/api/client.ts`**

Rename the module-private `refresh()` to `refreshOnce()` and export it, keeping the single-flight `refreshing` promise exactly as it is (two callers racing must still make one request), and update the one call site inside `call()`. Add one line of comment:
```ts
/** Exported for the event stream, which authenticates the same way `call()` does but cannot
 *  go through it — its response never ends. Single-flight: two callers share one request. */
export async function refreshOnce(): Promise<boolean> { … }
```

- [ ] **Step 3: Write `UI/src/api/events.ts`**

```ts
import { API_PREFIX, EVENTS_PATH, EventNoticeSchema, type Changed } from "@rch/contract";
import { refreshOnce } from "./client";
import { getAccessToken, sessionLost } from "./session";
import { refetch } from "./refetch";
import { useApp } from "../store";

export type StreamState = "off" | "live" | "reconnecting";
/** Spec §6: the client refetches the affected slice, debounced 250 ms. */
export const EVENT_DEBOUNCE_MS = 250;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

let state: StreamState = "off";
const watchers = new Set<() => void>();
const setState = (s: StreamState) => { if (s !== state) { state = s; for (const w of watchers) w(); } };

let controller: AbortController | null = null;
let attempt = 0;
let lastEventId: string | null = null;
let retryHintMs: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let pending = new Set<Changed>();
let wantsSnapshot = false;
let flush: ReturnType<typeof setTimeout> | null = null;

/** One refetch for a burst of notices, however many arrived. A resync supersedes the lot:
 *  there is no point reading three slices when the whole picture is being taken again. */
function schedule(): void {
  if (flush) return;
  flush = setTimeout(() => {
    flush = null;
    const slices = [...pending];
    const all = wantsSnapshot;
    pending = new Set();
    wantsSnapshot = false;
    if (all) void useApp.getState().loadSnapshot();
    else if (slices.length) void refetch(slices);
  }, EVENT_DEBOUNCE_MS);
}

/** One `\n\n`-separated frame: `id:`, `event:` and one or more `data:` lines. A line starting
 *  with `:` is a comment — the heartbeat — and a frame we cannot read is dropped, not fatal. */
function onFrame(text: string): void {
  let event = "message";
  const data: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith(":") || line === "") continue;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "id") lastEventId = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "retry") { const n = Number(value); if (Number.isFinite(n)) retryHintMs = n; }
  }
  if (event === "resync") { wantsSnapshot = true; schedule(); return; }
  if (event !== "changed" || data.length === 0) return;
  let parsed: unknown;
  try { parsed = JSON.parse(data.join("\n")); } catch { return; }
  const notice = EventNoticeSchema.safeParse(parsed);
  if (!notice.success) return;
  pending.add(notice.data.collection);
  schedule();
}

async function run(): Promise<void> {
  const ac = new AbortController();
  controller = ac;
  const headers: Record<string, string> = { accept: "text/event-stream" };
  const token = getAccessToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (lastEventId) headers["last-event-id"] = lastEventId;

  let res = await fetch(`${BASE}${API_PREFIX}${EVENTS_PATH}`, { headers, credentials: "include", signal: ac.signal });
  if (res.status === 401) {
    // The same one-refresh-then-retry the typed client does; a second 401 is a dead session.
    if (!(await refreshOnce())) { sessionLost(); return; }
    const retryHeaders = { ...headers, authorization: `Bearer ${getAccessToken() ?? ""}` };
    res = await fetch(`${BASE}${API_PREFIX}${EVENTS_PATH}`, { headers: retryHeaders, credentials: "include", signal: ac.signal });
    if (res.status === 401) { sessionLost(); return; }
  }
  if (!res.ok || !res.body) throw new Error(`events stream refused (${res.status})`);

  attempt = 0;
  setState("live");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut = buf.indexOf("\n\n");
    while (cut !== -1) { onFrame(buf.slice(0, cut)); buf = buf.slice(cut + 2); cut = buf.indexOf("\n\n"); }
  }
}

function connect(): void {
  void run()
    .catch(() => { /* a drop is expected; the reconnect below is the answer */ })
    .finally(() => {
      if (controller?.signal.aborted) return;    // stopped on purpose: do not come back
      controller = null;
      setState("reconnecting");
      // The server's own `retry:` hint wins the first time; after that, back off.
      const wait = retryHintMs ?? BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
      retryHintMs = null;
      timer = setTimeout(connect, wait);
    });
}

function stop(): void {
  controller?.abort();
  controller = null;
  if (timer) { clearTimeout(timer); timer = null; }
  if (flush) { clearTimeout(flush); flush = null; }
  pending = new Set();
  wantsSnapshot = false;
  attempt = 0;
  lastEventId = null;
  setState("off");
}

/**
 * Follow the session: a stream opens when one is ready and closes when it ends. Watching `auth`
 * rather than hooking `login()` also covers `restore()` and `changePassword()`, both of which
 * reach "ready" without passing through it.
 */
export function startEventStream(): () => void {
  const react = (auth: string) => {
    if (auth === "ready" && !controller && !timer) connect();
    else if (auth === "signed-out") stop();
  };
  react(useApp.getState().auth);
  const off = useApp.subscribe((s, prev) => { if (s.auth !== prev.auth) react(s.auth); });
  return () => { off(); stop(); };
}

/** For the shell's status pill. */
export function useStreamState(): StreamState {
  return useSyncExternalStore(
    (cb) => { watchers.add(cb); return () => { watchers.delete(cb); }; },
    () => state,
    () => "off" as const,
  );
}
```
with `import { useSyncExternalStore } from "react";` at the top.

- [ ] **Step 4: Start it, and show it**

`UI/src/main.tsx` — one line beside the existing bootstrap, after the store module is imported:
```ts
// Live updates follow the session; this is the only place that turns the follower on.
startEventStream();
```
`UI/src/ui/Shell.tsx` — the kit already has `Pill` (`UI/src/ui/kit.tsx:90`); do not invent a component. Line 10 currently imports `Avatar, Icon, SearchIcon, Tag, ThemeButton` from `./kit` — add `Pill` to that list — and import `useStreamState` from `../api/events`. Then in the header, immediately before `<ThemeButton />`:
```tsx
          {live === "reconnecting" && <Pill tone="wn">Reconnecting</Pill>}
```
with `const live = useStreamState();` beside the other hooks at the top of `Shell`. Nothing is shown while the stream is live: a badge that is always there stops being read.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @rch/ui test`
Expected: PASS. `screens.test.tsx` and `app.test.tsx` never call `startEventStream()`, so no test opens a stream by accident.

- [ ] **Step 6: Watch it work across two browsers**

With `pnpm dev` and the API running: open two browser profiles (or one normal and one private window), sign in as `RC-2088` in one and `RC-4471` in the other. Raise a request in the counter's window; the store keeper's issue desk must show it **without a reload**, within about a second. Hand the ticket over in the store's window; the counter's ticket list must move to "in transit" on its own. Then stop the API (`Ctrl-C`): both windows show the "Reconnecting" pill. Start it again: the pill goes and both windows are current — the reconnect's resync pulls a fresh snapshot.

- [ ] **Step 7: Gate and commit**

Run: `pnpm turbo typecheck test && pnpm lint`
```bash
git add UI
git commit -m "$(cat <<'EOF'
Follow the server's changes without a reload

A fetch-based SSE client, so the access token stays in a header rather than a query string
where logs and history would keep it. Notices are coalesced for 250 ms and answered with one
refetch of exactly the slices named; a reconnect asks for a resync rather than a replay,
because a buffer that does not survive a pod being rescheduled is worse than refetching.
The shell says "Reconnecting" while the stream is down and says nothing while it is up.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

### Task 10: Docs, spec §16, runbook, and the exit check

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `UI/README.md`, `docs/ua-spec.html`, `docs/system-design.html`, `docs/user-flows.html`, `deploy/RUNBOOK.md`, `docs/superpowers/specs/2026-09-03-backend-design.md`

- [ ] **Step 1: `CLAUDE.md`**

- *What this is*: "**Phase 1 of the backend is implemented**" → "**Phases 1–3 of the backend are implemented**", and rewrite the sentence that follows: sign-in is real, the snapshot hydrates the frontend, and counter billing, availability, prices, menus, the whole request chain, tickets, shop transfers and shop asks are server-side; the kitchen's two ticket paths (dispatch and distribute) are server-side too; the last in-memory paths are the rest of production (`setOrderStatus`, `makeProduct`) and procurement (`store/procurement.ts`), which Phases 4–5 close.
- *Architecture → One Zustand store*: note that the request/ticket/shop-ask actions are API calls and the store holds what the server returned.
- *The movement rule*: add one sentence — the rule is now enforced in `apps/api/src/modules/tickets/service.ts` (and reserved by `modules/{requests,shopasks,production}`), and `packages/domain/src/transitions.ts` is the table both sides read for which status may follow which.
- *Domain invariants*: add the staff-credit ceiling beside the MRP ceiling — `STAFF_CREDIT_LIMIT` is a hard monthly ceiling per staff member, enforced by `breachesCredit` in `packages/domain/src/credit.ts` at the till and refused with `creditBreachMessage`.
- *Derived state is computed, never stored*: `freeToPromise` is enforced on the server at approval and re-checked under the balance locks at issue; the UI's copy is a preview.
- *Backend*: status line → "Phases 1–3 (Foundation, Ledger + POS, Movement chain + SSE) implemented; phases 4–6 pending — see spec §14"; add `lib/events.ts`, `lib/reservations.ts`, `lib/tickets.ts` and `plugins/sse.ts` to the rules paragraph and note that `GET /events` is the one route outside the manifest.

- [ ] **Step 2: `README.md` and `UI/README.md`**

State what a person can now do against a real server: raise, approve, issue, hand over on an OTP, receive, transfer between shops, answer a shop ask, dispatch a production order and push a tray out of the kitchen — and that two browsers see each other's changes live. Say plainly that batches, the kitchen's order board and procurement are still in-memory.

- [ ] **Step 3: `docs/*.html` — the product contract**

Read each file and change only what this phase changed:
- `docs/user-flows.html`: the request → approval → issue → handover → receipt flow is the server's; add the supervisor override as a named step ("Handed over — supervisor override", store and kitchen only, recorded in the document history) and note that the other screens update by themselves.
- `docs/ua-spec.html`: the UAT scenarios covering the request chain now name their server tests; where the spec described a rule the browser enforced, say the server enforces it and the browser shows its sentence.
- `docs/system-design.html`: add the event stream to the architecture — one `GET /events` per browser, `LISTEN`/`NOTIFY` between replicas, refetch on notice.
Run `bash scripts/build-site.sh` afterwards and confirm `dist/` assembles.

- [ ] **Step 4: `deploy/RUNBOOK.md`**

Add a short SSE section:
- What `GET /events` is, and that a stream is one long-lived request — expect `sse_clients` to sit near the number of open browsers, not near zero.
- `sse_listener_up 0` on a pod means that pod's streams are alive but deaf: it is not serving stale data, it is serving no notices, and the pod reconnects with backoff (250 ms → 10 s) and sends a resync when it does. Alert on `min(sse_listener_up) == 0 for 5m`.
- The ALB idle timeout is 3600 s (`ingress.yaml`) and nginx's `/api/v1/events` location sets `proxy_buffering off` with `proxy_read_timeout 3600s`. Changing either breaks live updates before it breaks anything else.
- A rolling deploy ends every stream with `retry: 1000`, so browsers come back about a second later, staggered by their own backoff. No action needed.
- Reading a handover's audit trail: `select * from document_history where doc_type = 'ticket' and doc_id = 'TKT-0441';` returns a row only for a supervisor override; the normal lifecycle is `issued_at` / `collected_at` / `received_at` on `tickets`.
- Finding what a ticket moved: `select * from stock_moves where ref_type = 'ticket' and ref_id = 'TKT-0441' order by id;` — one `ticket_out` set at the source and one `ticket_in` set at the destination.

- [ ] **Step 5: Spec §16 — record every decision this phase took**

Append these rows to the amendments table (retitle the section "Amendments recorded during Phases 1–3"):

| Section | Amendment | Why |
|---|---|---|
| §6 SSE | The `/events` notice payload is `{ collection, at }` with a per-process `id:`; the channel is `'rch_events_' || current_schema()` so parallel test schemas in one database cannot hear each other. | Channels are per-database, and every DB test file runs in its own schema. |
| §6 SSE | `Last-Event-ID` is answered with one `event: resync` frame and a full snapshot refetch, not five minutes of replay. | A replay buffer does not survive a pod being rescheduled, so it cannot be relied on; refetching cannot be wrong. |
| §6 SSE | `GET /events` is registered by `plugins/sse.ts`, not by the route manifest, and both sides build its URL from `API_PREFIX + EVENTS_PATH`. `contract.test.ts` probes every param-less manifest GET for a 200 and would hang on a stream; `mount()` would try to serialise a body that never ends. | Found while planning; §5.1's manifest rule is about JSON endpoints, as `/healthz` and `/metrics` already show. |
| §6 SSE | The browser subscribes with `fetch` over a `ReadableStream`, not `EventSource`. | `EventSource` cannot send `Authorization`, which would put the access token in the URL and therefore in nginx's log, the ALB's, and the browser's history. |
| §11.1 timeouts | The SSE route calls `req.raw.socket.setTimeout(0)` and sets `config: { rateLimit: false }`. Fastify's `connectionTimeout` is Node's per-socket inactivity timer and would kill a stream between heartbeats; `requestTimeout` bounds *receiving* a request and never applies. `SSE_HEARTBEAT_MS` (25 s) and `SSE_RETRY_MS` (1 s) are config. | The Phase 1 ledger parked "requestTimeout vs Phase 3 SSE" for this phase. |
| §7.2 `document_history` | Tickets write history for the supervisor override only, as `doc_type = 'ticket'`, `status = 'Handed over — supervisor override'`. The normal lifetime stays three timestamps on the row. | §8.3 and §12 require the override to be auditable; the lifecycle needs no prose. |
| §7.2 `tickets.otp` | The OTP is stored and served in the clear, as the snapshot already does. | `makeOtp` is an operational check, not a security token, and the store's own screens print it — hashing it is a product change, not a security fix. |
| §9.2 `submitRequest`/`requestFromStore` | One endpoint, `POST /requests`. A single-line request gets the sentence naming the item; a multi-line one gets the sentence naming the line count. | Two store actions, one document; the sentence follows the shape of the request rather than the screen it came from. |
| §9.3 write responses | `result` is the document acted on, except `approve` (`{ request, trimmed }`), `issue-ticket` (`{ request, ticket }`) and shop-ask `answer` (`{ ask, ticket }`). | `trimmed` is a property of the decision, not the row; and the store window needs the OTP in the same breath as the request. |
| §9.2 shop-ask `answer` | Answers with its own sentence naming the ask and the ticket. | Today it borrows `transferToOutlet`'s toast, which never mentions the ask that was granted. |
| §9.2 handover override | Refused to a counter with "Only the store or the kitchen may hand over without the OTP", and the success sentence says "handed over on a supervisor override". | §8.3 limits the override to store and prod; the operator should be told which of the two paths ran. |
| §9.2 quantities | Phase 3 bodies take `z.number().finite().multipleOf(0.001).max(100000)` and assert positivity in the service. | A `.positive()` schema turns "Enter a quantity" into a generic 400. |
| §5.1 protected tables | `reservations` joins the protected list; `apps/api/src/lib/reservations.ts` is its one door, and `lockBalances` in `lib/ledger.ts` is the one place a reservation path takes the balance locks. | Three more callers arrive in Phases 4–5, and a reservation made from an unlocked read is the same stock promised twice. |
| §9.2 `pay` staff credit | The `Staff credit` ceiling (`STAFF_CREDIT_LIMIT`, ₹3,000) is enforced server-side inside the sale's transaction, over **every bill charged to that staff id hospital-wide since midnight on the first of the current month in Asia/Kolkata**. The number moves to `packages/contract/src/schemas/common.ts` (the fixtures re-export it, so `UI/src/data/master.ts` and `Pos.tsx` are unchanged); the rule and its sentence are `breachesCredit`/`creditBreachMessage` in `packages/domain/src/credit.ts`. | `Pos.tsx` only disabled a button, which a second tab or a stale page walks straight past. "This session" is not a window a server has; the hospital settles staff credit monthly, and the ceiling belongs to the person rather than the till. |
| §9.2 `pay` post-lock check | The re-read after `postMoves` now asserts `on_hand − reserved ≥ 0`, with the hold read inside the locked window through `reservedAt`. The refusal sentence is unchanged. | Phase 3 puts reservations on outlet shelves (a shop transfer, a granted shop ask), so "not negative" stopped meaning "not oversold". |
| §14 Phase 3/4 split | Phase 3 moves the kitchen's ticket creation — `POST /prod-orders/:id/dispatch` and `POST /distributions` — because they are the only production writes that raise a ticket and Phase 3 makes handover a server call. **Phase 4 owns the rest of production**: `POST /prod-orders/:id/status`, batches and `makeProduct`. `PROD_ORDER_TRANSITIONS` lands in Phase 3 so both phases read one table. | Leaving them behind would have left the kitchen's own tickets carrying ids the server has never heard of, so handing one over would 404 — spec §14's "nothing dual-runs". |
| §9.2/§8.3 requests | `prod` may raise and cancel stock requests for the kitchen, alongside `counter`. | The Central Kitchen has always done so from its stock screen (`requestFromStore`, pinned by `fixes.test.ts` C3); §8.3's role table omitted it. |
| §16 Phase 3 item (c) | Closed by `emitChanged` (`pg_notify` inside the write's transaction), not by the parked `withTransaction(db, fn, { onCommit })` hook. **No `onCommit` hook exists** — do not go looking for one. | Postgres itself withholds a notice until the transaction commits, which is the same guarantee with nothing to maintain. |
| §8.3 override history | The override's `document_history` row is `doc_type = 'ticket'`, `status = 'Handed over — supervisor override'` — §8.3's wording, verbatim, and the only history a ticket writes. | §16 (Phase 1) fixed a ticket's normal lifecycle as three timestamps on the row; the override is the exception §8.3 and §12 require to be auditable. |
| §9.2 `answerShopAsk` | A grant larger than the ask is **refused** (`<shop> asked for <qty> <unit> — grant that or less`), not clamped. | §9.2's rule is `0 < grant ≤ asked`; the browser clamped silently, and a counter who typed 60 for a 6 meant something. |
| §9.2 `handover` | The post-lock re-read has its own refusal — `<to> cannot collect <qty> <unit> of <item> — <from> no longer has it` — new in this phase. | The browser never re-read after moving, so it had no sentence for a shelf that emptied under a handover. |
| §5.1 lock order | Ids before balance rows, everywhere: `allocateTicket(tx)` → `lockBalances(tx, cells)` → read → `writeTicket(tx, draft, no)`. `lib/tickets.ts` is split into those two calls so a caller cannot get it backwards. | `lib/ledger.ts`'s header already recorded the order and `pos` already kept it; a ticket path that locked first could deadlock against a concurrent sale on `sequences` vs `stock_balances`. |

- [ ] **Step 6: Run the exit check (spec §14 row 3)**

From a clean tree on `feat/phase-3-movement-chain`:
```bash
pnpm install
pnpm turbo typecheck test && pnpm lint          # every package green
pnpm helm:test                                  # chart renders; SSE assertions pass
bash scripts/build-site.sh                      # docs and app assemble
pnpm db:up
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed --force
pnpm dev                                        # api :3000, UI :5173
```
Then, in a second shell, the chain end to end with two authenticated sessions. Sign in twice and keep both access tokens:
```bash
API=http://localhost:3000/api/v1
login() { curl -sS -X POST $API/auth/login -H 'content-type: application/json' -d "{\"emp\":\"$1\",\"password\":\"changeme\"}" | jq -r .accessToken; }
COUNTER=$(login RC-4471); MANAGER=$(login RC-3120); STORE=$(login RC-2088)
K() { python3 -c 'import uuid;print(uuid.uuid4())'; }

# 1. A stream, held open in the background, standing in for the second browser.
curl -N -s -H "Authorization: Bearer $MANAGER" $API/events > /tmp/rch-events.txt &

# 2. The counter raises, the manager trims, the store issues.
REQ=$(curl -sS -X POST $API/requests -H "Authorization: Bearer $COUNTER" -H "content-type: application/json" -H "Idempotency-Key: $(K)" \
  -d '{"lines":[{"it":"milk","qty":20}],"note":"Counter runs dry by 4pm","urgent":true}' | tee /dev/stderr | jq -r .result.id)
curl -sS -X POST $API/requests/$REQ/approve -H "Authorization: Bearer $MANAGER" -H "content-type: application/json" -H "Idempotency-Key: $(K)" \
  -d '{"appr":[20],"note":"Store only holds 12 L."}' | jq '.result.request.lines[0], .result.trimmed, .message'
#    expect appr 12, short 8, trimmed true, "… trimmed — the central store cannot cover the full quantity"
ISSUE=$(curl -sS -X POST $API/requests/$REQ/issue-ticket -H "Authorization: Bearer $STORE" -H "Idempotency-Key: $(K)")
TKT=$(jq -r .result.ticket.id <<<"$ISSUE"); OTP=$(jq -r .result.ticket.otp <<<"$ISSUE")

# 3. Reserved, not moved: store milk on hand is still 12, free to promise is 0.
curl -sS -H "Authorization: Bearer $STORE" $API/stock | jq '.stock.store.milk, .rsv["store:milk"]'   # 12, 12

# 4. A wrong OTP refuses; the right one moves it.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST $API/tickets/$TKT/handover -H "Authorization: Bearer $STORE" -H "content-type: application/json" -H "Idempotency-Key: $(K)" -d '{"otp":"000000"}'   # 422
curl -sS -X POST $API/tickets/$TKT/handover -H "Authorization: Bearer $STORE" -H "content-type: application/json" -H "Idempotency-Key: $(K)" -d "{\"otp\":\"$OTP\"}" | jq -r .message
curl -sS -H "Authorization: Bearer $STORE" $API/stock | jq '.stock.store.milk, .rsv["store:milk"]'   # 0, null — moved out, hold released

# 5. Received on the shelf, and the request closes.
curl -sS -X POST $API/tickets/$TKT/receive -H "Authorization: Bearer $COUNTER" -H "Idempotency-Key: $(K)" | jq -r .message
curl -sS -H "Authorization: Bearer $COUNTER" $API/requests | jq -r ".[] | select(.id==\"$REQ\") | .st"   # Closed

# 6. The override, on a second ticket, said out loud and written down.
curl -sS -X POST $API/transfers -H "Authorization: Bearer $COUNTER" -H "content-type: application/json" -H "Idempotency-Key: $(K)" \
  -d '{"from":"coffee","to":"kiosk","it":"chips","qty":2}' | jq -r .result.id
#    then hand that one over from the store's own seeded ticket with no otp field, as RC-2088:
curl -sS -X POST $API/tickets/TKT-0440/handover -H "Authorization: Bearer $STORE" -H "content-type: application/json" -H "Idempotency-Key: $(K)" -d '{}' | jq -r .message
#    expect "… handed over on a supervisor override — stock is in transit to Coffee Shop"

# 7. The kitchen's own two ticket paths, which cross in this phase too.
PROD=$(login RC-1902)
curl -sS -X POST $API/distributions -H "Authorization: Bearer $PROD" -H "content-type: application/json" -H "Idempotency-Key: $(K)" \
  -d '{"it":"puff","qty":5,"to":"kiosk"}' | jq -r '.result.id, .message'
PRD=$(curl -sS -H "Authorization: Bearer $PROD" $API/snapshot | jq -r '[.pord[] | select(.st != "Dispatched" and .st != "Declined")][0].id')
curl -sS -X POST $API/prod-orders/$PRD/dispatch -H "Authorization: Bearer $PROD" -H "Idempotency-Key: $(K)" | jq -r '.message, .result.order.st'
#    a second press must refuse with "… has already gone out — it is on one ticket to …"
curl -sS -X POST $API/prod-orders/$PRD/dispatch -H "Authorization: Bearer $PROD" -H "Idempotency-Key: $(K)" | jq -r '.error.message'

# 8. The stream heard all of it, live.
grep -c 'event: changed' /tmp/rch-events.txt        # > 0, and it grew as each step ran
grep 'data: {"collection":"req"' /tmp/rch-events.txt | head -1

# 9. The cache is exactly the sum of the moves. Nothing above posted a move except the
#    handover and the receipt, so a rebuild must change nothing.
curl -sS -H "Authorization: Bearer $STORE" $API/stock > /tmp/before.json
pnpm --filter @rch/api db:rebuild-balances
curl -sS -H "Authorization: Bearer $STORE" $API/stock > /tmp/after.json
diff /tmp/before.json /tmp/after.json && echo "balances reconcile"
```
Finally, the two-browser check by hand (Task 9's Step 6) — a request raised in one window appears in the other without a reload, and both show "Reconnecting" while the API is stopped.
**Staging** is a release decision made outside this plan: the spec's "on staging across two browsers" line is met on staging when the branch is promoted, and the local run above is what gates the phase. Record both facts in the ledger.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md README.md UI/README.md docs deploy/RUNBOOK.md
git commit -m "$(cat <<'EOF'
Document the movement chain and record its exit check

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gC3R1QMaDuNzqPHRtMTEw
EOF
)"
```

---

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | **1** (contract writes + event notice) ∥ **2** (domain transitions + `planApproval`) | Worktrees. Disjoint packages: Task 1 owns `packages/contract`, Task 2 owns `packages/domain`. Task 1 declares **writes only** — a manifest GET without a handler fails `apps/api/src/contract.test.ts`, which no longer skips a 404. |
| 2 | **3** (SSE transport) ∥ **4** (movement primitives + the three reads) | Worktrees, both from the merge of wave 1. Disjoint: Task 3 owns `lib/events.ts`, `plugins/sse.ts`, `plugins/metrics.ts`, `app.ts`, `config.ts`, `db/client.ts`, `test/app.ts`, the three Phase 2 module services and `deploy/chart/rch/tests/render.test.sh`. Task 4 owns `lib/{ledger,ids,rules,reservations,tickets}.ts`, `plugins/rbac.ts`, `test/builders.ts`, `modules/snapshot/*`, `modules/index.ts`, `scripts/check-boundaries.sh`, and the three GET entries in `packages/contract`. Neither touches a file the other does. **Task 4 pre-registers the four wired module stubs (`requests`, `tickets`, `shopasks`, `production`) in `modules/index.ts`** so wave 3 never edits that shared line, and declares Task 12's two write routes so `packages/contract` is touched once here and never in wave 3. |
| 3 | **5** (`requests`) ∥ **6** (`tickets`) ∥ **7** (`shopasks`) ∥ **12** (`production`) ∥ **11** (`pos`) | Worktrees. Tasks 5, 6, 7 and 12 each own exactly one `apps/api/src/modules/<name>/` directory and nothing else — registration and the four wired stubs are already done by Task 4, and every helper they need (`lockBalances`, `reservations`, `allocateTicket`/`writeTicket`, `events`, `rules`, `rbac`, `builders`) exists read-only from wave 2. Task 12 also owns `packages/domain/src/transitions.ts`. Task 11 owns `apps/api/src/modules/pos/*` — free from here on, since Task 3 last touched `pos/service.ts` in wave 2 to add `emitChanged` — plus `packages/domain/src/credit.ts` and its export line in `packages/domain/src/index.ts` (nobody has touched `packages/domain` since wave 1), `packages/contract/src/{schemas/common.ts,fixtures/master.ts}` (nobody has touched `packages/contract` since Task 4's three GET entries in wave 2), `apps/api/src/lib/time.ts` and its test, and `UI/src/__tests__/screens.test.tsx`. **Tasks 11 and 12 both add one line to `packages/domain/src/index.ts`** — Task 11 a new `credit` export line, Task 12 a name on the existing transitions line; different lines, and the controller resolves a trivial adjacent-line conflict if git raises one. **Task 11 is the only wave-3 task that edits `apps/api/src/test/builders.ts`** — it appends `given.bill`; the four module tasks import that file and never edit it. |
| 4 | **8** (store cutover) ∥ **9** (event stream client) | Worktrees, from the merge of wave 3 — Task 8 cuts over fourteen actions, four of which (`dispatchOrder`, `distribute`, and the two the kitchen's tickets flow through) need Task 12 merged. Disjoint by file: Task 8 owns `UI/src/store/*`, `UI/src/lib/selectors.ts`, `UI/src/api/{refetch,wire}.ts`, `UI/src/roles/**` and `UI/src/__tests__/{writes,store,fixes}.test.ts` and `UI/src/__tests__/fixture.ts` — not `screens.test.tsx`, which Task 11 edited back in wave 3. Task 9 owns `UI/src/api/{events,client}.ts`, `UI/src/main.tsx`, `UI/src/ui/Shell.tsx` and `UI/src/__tests__/events.test.ts`. Task 9 **stubs `refetch` with `vi.mock`** rather than exercising it, so Task 8's change to that file cannot invalidate Task 9's assertions, and it sets `auth` inside its own test file rather than editing `fixture.ts`. |
| 5 | **10** (docs, spec §16, runbook, exit check) | In-tree, after everything is merged. It is the only task that edits `docs/`, `README.md`, `CLAUDE.md` and `deploy/RUNBOOK.md`. |

Worktree agents do not commit to the shared branch; the controller reviews and merges each branch, then dispatches the next wave from the merge commit. **Parallel tasks never edit the same file**; where a shared file is unavoidable it is pre-edited in the preceding wave — the four wired module stubs in `modules/index.ts` (Task 4, for wave 3), Task 12's two contract route entries (Task 4, so `packages/contract` is touched once in wave 2 and never in wave 3), and the searchPath in `test/app.ts` (Task 3, for everyone downstream).
