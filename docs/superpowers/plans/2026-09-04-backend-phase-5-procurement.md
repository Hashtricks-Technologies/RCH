# RCH Backend — Phase 5: Procurement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Buying moves to the server, end to end. The store keeper raises a requisition; the buyer approves it, draws purchase-order lines out of the derived procurement list, prices them off a live rate contract, sends the order and receives the goods against a delivery note — accepted stock onto the central store's shelf, rejected stock into `quarantine` — and when an order is cancelled or closed short the claim it held goes back onto the list it came from. Vendors, rate contracts, new catalogue items and the store's answer to a shop's new-product request go with it. Nothing in `UI/src/store/procurement.ts` decides anything after this phase; it posts bodies and repeats the server's sentences.

**Architecture:** Six new modules (`requisitions`, `purchaseorders`, `grn`, `vendors`, `contracts`, `productreqs`) plus one endpoint added to `catalog`, all composing the platform Phases 1–4 built: `withTransaction` → rules from `@rch/domain` through `assertRule` → `allocateNumber`/`lockBalances`/`postMoves` → `appendHistory` → `emitChanged` → `{ result, changed, message }`. Two things are new in kind. **The first is document arithmetic without stock:** a purchase-order line holds a *claim* on a requisition line (`requisition_lines.ordered_qty`), and creating, shrinking, removing, cancelling or closing-short an order moves that claim. It is settled under document row locks, not balance locks, so this phase writes down the order those locks are taken in and never varies it. **The second is the phase's one ledger write:** a goods receipt posts `grn_accept` at `store` for what was accepted and `grn_reject` at `quarantine` for what was rejected — both positive, so nothing here can drive a balance below zero and nothing needs a post-lock re-read. `quarantine` becomes visible to the store's screens for the first time, through a new `StockLoc` key that widens where stock is *reported* without widening where an operator may *act*.

**Tech Stack:** unchanged from Phases 1–4 — Node 24, pnpm 10, Turborepo 2, TypeScript ~6.0, Fastify 5, fastify-type-provider-zod 7, Zod 4, Drizzle 0.45 + drizzle-kit 0.31, pg 8, PostgreSQL 17, Vitest 4, tsup 8, Helm 3. **No new dependency.** One migration, and only one: a partial unique index on `rate_contracts`. Every procurement table — `requisitions`, `requisition_lines`, `purchase_orders`, `po_lines`, `po_line_sources`, `grns`, `vendors`, `rate_contracts`, `product_requests` — was created by Phase 1's first migration and no column moves.

**Spec:** `docs/superpowers/specs/2026-09-03-backend-design.md` — §5.1 (reuse rules), §7.2 (the buying tables, the `quarantine` location, `items`), §7.3 (`PRQ-`, `PO-`, `GRN-`, `VN-`, `RC-`, `NPR-`), §8.3 (buyer, store), §9.1 (the per-collection reads), §9.2 (**every Phase 5 row**, listed verbatim in the task that implements it), §9.3 (write responses), §10 (frontend cutover), §12 (the production-readiness bar), §13 (testing), §14 row 5 — *"End-to-end requisition → PO → GRN → store stock on staging; 2 % tolerance and expiry rules refused; claims returned on cancel/close-short"* — and §16 (amendments from Phases 1–4 — **binding, do not reopen**).
**Ledgers:** `docs/superpowers/plans/2026-09-04-backend-phase-3-movement-chain-ledger.md`, `.superpowers/sdd/2026-09-04-backend-phase-4-production/progress.md`.

---

## Global Constraints

Every task's requirements implicitly include this section. The first fourteen bullets are Phases 3–4's, carried forward unchanged because they are what keeps the server correct; the rest are this phase's own.

- **Branch model:** work on `feat/phase-5-procurement`, branched from `develop` once Phase 4 has landed there by fast-forward (if it has not, branch from `feat/phase-4-production` **head**); never push to `staging`/`production`. Worktree agents start with `git merge --ff-only feat/phase-5-procurement`.
- **Conventions settled in Phases 1–4 (binding):** `apps/api` and `packages/*` relative imports carry `.js`; no constructor parameter properties (`erasableSyntaxOnly`); `strict` TS with `noUnusedLocals`/`noUnusedParameters`/`verbatimModuleSyntax`; type-only imports use `import type`. UI uses bundler resolution (no extensions). Every DB-backed test file calls `buildTestApp({ schema: "<unique>" })`; `withTestSchema` suffixes the schema with the pid, so parallel worktrees sharing one database do not drop each other's schema. Local Postgres is Docker on host port **5439**; Node 24 lives at `$(brew --prefix node@24)/bin`.
- **Every write is one transaction** (`withTransaction`), rules through `assertRule` carrying the operator-facing sentence, quantities through `round3`, ledger moves only through `postMoves`, balance locks only through `lockBalances`, ids only through `allocateId`/`allocateNumber`, history only through `appendHistory`, reservations only through `apps/api/src/lib/reservations.ts`. `scripts/check-boundaries.sh` enforces the protected tables — do not write them anywhere else. (`requisitions`, `requisition_lines`, `purchase_orders`, `po_lines`, `po_line_sources`, `grns`, `vendors`, `rate_contracts`, `product_requests` and `items` are **not** protected tables: each is written from its own module's `repo.ts`.)
- **Routes only through `mount(app, routes.<name>, handler)`**; every module is `routes.ts / service.ts / repo.ts / <name>.test.ts` (copy `apps/api/src/modules/_template/`). `GET /events` remains the one route outside the manifest; this phase adds none like it.
- **Write response shape (spec §9.3):** `{ result, changed, message }` — `changed` names snapshot collections to refetch (this phase uses `"prq"`, `"po"`, `"grn"`, `"vendors"`, `"contracts"`, `"productReqs"`, `"items"`, `"stock"`); `message` is the toast sentence, moved **verbatim** from the store's current `notify()` text. Where a new sentence is unavoidable it is called out in the task's rules table as **NEW** and recorded in spec §16 by Task 11.
- **Refusals** are `RuleError` (422) with the sentence the store uses today; an unknown item or document key is `NotFoundError` (404) reading `There is no item <key>.` / `There is no requisition <id>.` / `There is no purchase order <id>.` / `There is no vendor <id>.` / `There is no rate contract <id>.` / `There is no product request <id>.`; role gating is 404 (the module is absent for that role); location scoping is 403 through `requireLoc`/`requireLocOf`.
- **Quantities on the wire** are `QtySchema` = `z.number().finite().multipleOf(0.001).max(100000)` and positivity is a **service rule**, not a schema rule, so a zero reaches the operator as the store's own sentence instead of a generic 400. Times are ISO; dates are `IsoDate` (`YYYY-MM-DD`); quantities `numeric(12,3)` rounded with `round3`; money `numeric(12,2)`, rounded to two decimals only at the point of persisting.
- **Lock order, server-wide: documents → ids → balances.** A write that needs more than one takes them in that sequence and never another: `repo.head(tx, id)` (`for update` on the document row) → `allocateId`/`allocateNumber` (which locks a `sequences` row) → `lockBalances`/`postMoves` (which lock `stock_balances` rows). `apps/api/src/lib/ledger.ts`'s header records it. A refused write rolls its allocation back with everything else.
- **Within the documents step, Phase 5 adds one refinement, and Task 3 writes it into `lib/ledger.ts`'s header: the purchase-order row is locked before any requisition row, and requisition rows are locked in ascending `requisition_id` order.** `createPo` is the one write that locks requisition rows while holding no purchase-order lock — safe precisely because it is *creating* the order and will never reach for an existing one — so no cycle exists. Every other claim-moving write (`updatePoLine`, `removePoLine`, `cancelPo`, `closePoShort`) takes `purchaseOrdersRepo.head(tx, id)` first and the requisition rows second, sorted.
- **Every reservation-creating path — and every path that reads a balance in order to promise against it — takes the balance locks first.** No Phase 5 write promises against a balance: a receipt only adds. `postMoves` takes the locks it needs itself; no Phase 5 service calls `lockBalances` directly.
- **Every status transition reads its own row `for update`.** A transition guard that reads without the lock is not a guard: two Sends of one draft both see `Draft`, both pass `canTransition`, and both write a history row.
- **A test that races two transactions warms the pool first.** `pg` opens connections lazily, so the second of two "concurrent" `withTransaction` calls waits ~5 ms for a socket and begins after the first has committed — the race never happens and the test passes with the lock removed. Call `warmPool(t, n)` (`apps/api/src/test/db.ts`) before racing `n` transactions, and **prove each such test fails with the lock (or the sort) commented out before keeping it.**
- **Test builders are the only place default field values are written** (spec §5.1). `given.request`, `given.ticket`, `given.shopAsk`, `given.bill` and `given.prodOrder` already exist; Task 3 adds `given.vendor`, `given.requisition`, `given.po`, `given.contract` and `given.productRequest`. A suite that hand-builds a document instead of asking for one is rejected in review.
- **Assertions are relative to what the fixtures hold, not to a number typed into the test.** Read the balance or the pending quantity, act, then assert the difference, and pick the document to act on by filtering rather than by naming `PRQ-2026-013`. The seed moves; a test that hard-codes its arithmetic breaks for a reason that has nothing to do with the code.
- **`emitChanged` is called inside the transaction**, last in the service, with the same array the response's `changed` carries. Postgres withholds a `pg_notify` until the transaction commits, so a refusal announces nothing. There is no after-commit hook — do not go looking for one (spec §16, Phase 3).
- **A writer locks only the cells it moves.** `lockBalances` (called by `postMoves`) creates the row it locks, and a stray zero row reads as "this location carries the line" on every stock screen (M12, spec §16). A receipt therefore posts a `grn_reject` move **only when `rejected > 0`**, and `POST /items` posts an `opening` move **only when `opening > 0`** — otherwise `quarantine` grows a phantom line for every clean delivery and every new item is "carried at zero" everywhere.
- **Never widen a status union with `string`.** `PrqStatus` and `PoStatus` are closed and unchanged this phase; both gain a transition table, not a member.
- **A widening is swept with a grep, not with a file list.** Phase 4's final review found `Cancelled` handled in the two screens its task named and missed in three it did not — a badge in `ui/Shell.tsx`, a column in `roles/store/Reports.tsx`, a manager dashboard tile. When a phase adds a location key, a document state or a member to a closed union, the sweep is `grep -rn` over **all of `UI/src`** for every place that enumerates the old set, and the task's Files block is corrected from what the grep finds. This phase's widening is `StockLoc`: grep `ALL_LOCS`, `Object.keys(LOC)`, `Object.keys(s.stock)`, `stock\.` and `LocKey` before claiming a screen list is complete.
- **Dates in the store are display strings, everywhere, and ISO on the wire.** `applySnapshot` has rendered `eta`, `from` and `to` through `fromWireDate` since Phase 1 (`"2026-09-11"` → `"11-Sep-2026"`), and the six appliers Phase 5 adds do the same — one convention, or one collection ends up holding raw ISO while another holds display text and every comparison between them is silently wrong. A control that needs `<input type="date">` converts **at the edge**, through `toInputDate` / `fromInputDate` in `UI/src/lib/fmt.ts` (Task 2). No applier and no store field is exempted.
- **Migrations are generated, never hand-numbered.** Run `pnpm --filter @rch/api db:generate`, review the SQL it emits, and commit it with `drizzle/meta/_journal.json`. The journal ends at **idx 5 (`0005_ticket_status_cancelled`, Phase 4)**, so this phase's one migration is `0006`.
- **Before dispatching a wave, the controller verifies the journal.** `apps/api/drizzle/meta/_journal.json`'s last entry must be what this plan says it is (`0005_ticket_status_cancelled` for wave 1, `0006_rate_contracts_live_uq` for waves 2–4), and every worktree forks from the phase branch **head**, never from an older commit. Two branches that each emit the same idx produce a journal conflict no merge strategy can resolve — the loser has to regenerate, and a hand-renumbered migration is worse than either.
- **Every phase ends with its guides refreshed, in one commit with the spec §16 rows.** That is the root `CLAUDE.md`, the root `README.md`'s status-by-phase section, and the four nested guides — `apps/api/CLAUDE.md`, `packages/contract/CLAUDE.md`, `packages/domain/CLAUDE.md`, `UI/CLAUDE.md`. A nested guide is what a fresh agent reads before touching that package, so it names what the package now holds and what rule it now enforces; a phase that adds an endpoint, a table, a domain function or a screen and leaves its guide describing the phase before is a defect, not a follow-up. **This carries into Phase 6.**
- **Every task ends green:** `pnpm turbo typecheck test && pnpm lint` (turbo lint + knip + `scripts/check-boundaries.sh`) at the repo root. Never leave a test asserting behaviour that moved — each task that deletes a UI rule test names the server test that replaces it, in the commit body. If turbo replays a stale green for you, re-run the gate with `--force`.
- **`scripts/check-boundaries.sh` greps for call shape**, including `update reservations` case-insensitively in raw SQL. Do not write a comment or a string containing a phrase like `insert into stock_moves` outside `lib/`, or the boundary script fails on prose.
- **Commit messages:** imperative, sentence-case, no prefixes, and no mention of a task number, plus **exactly one trailer** — the session trailer Phases 1–4 carried is gone:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

---

## What Phase 5 does **not** build

- **A `LocKey` that includes `quarantine`.** Spec §7.2 says "`LocKey` in the contract gains the value"; this plan gives quarantine a **`StockLoc`** key instead — the five operating locations plus `quarantine` — used only where stock is *reported* (`SnapshotSchema.stock`, `StockResponseSchema.stock`, the fixtures' `LOC` and `seedStock`, the store's `stock` map). `LocKeySchema` stays at five, which is what every write body, `user.loc`, a ticket's `from`/`to` and a request's `from` are typed against. Widening `LocKey` would let `quarantine` through `PayBodySchema`, `ToggleAvailBodySchema`, `TransferBodySchema`, `ShopAskBodySchema`, `DistributeBodySchema` and `MenuLocParamsSchema`, each of which would then need a new guard and a new refusal sentence for a location no operator can reach. `StockLoc` gives the store screens the shelf without opening a single door. Task 11 records it in §16.
- **A quarantine ledger, a debit note, or a way back out of quarantine.** Rejected stock lands at `quarantine` and stays there; there is no return-to-vendor document in `types.ts`, no screen for one, and §9.2 has no row for one. `docs/superpowers/specs/2026-08-29-procurement-redesign-design.md` already recorded that decision for the frontend and it stands. Task 11 parks it.
- **A finance approval workflow.** `needsApproval` is a flag computed from the order's value against `PO_APPROVAL_LIMIT` and stamped on `sendPo`, exactly as the browser does today. Nothing consumes it but a badge. §9.2 asks for the flag, not for an approver.
- **Support tickets.** `raiseTicket`, `replyToTicket`, `setTicketStatus`, `rateTicket` and the whole `support_tickets`/`support_messages` half of `store/ops.ts` are Phase 6's. This phase takes `requestNewProduct` and `answerProductRequest` out of that file because the store's answer needs something to answer and `POST /items` is a Phase 5 row; the four support actions are untouched.
- **`GET /documents/:type/:id/history`.** Still nothing reads `document_history` back (spec §16, Phase 3). Phase 5 writes requisition and purchase-order history rows; surfacing them is unchanged and still deferred.
- **Deleting `UI/src/data/seed.ts`.** Spec §14 gives that to Phase 6. The store still initialises from the local seeds before `/snapshot` lands.

---

## File structure (what Phase 5 adds or changes)

```
packages/contract/src/
  schemas/common.ts        + StockLocSchema, QUARANTINE, PO_APPROVAL_LIMIT (moved from fixtures)
  schemas/writes.ts        + CollectionSchema gains "items"; 17 body schemas + 2 result schemas
  schemas/snapshot.ts      stock keyed by StockLoc; + Requisitions/PurchaseOrders/Grns/
                           Vendors/Contracts/ProductRequests response schemas   (Task 4)
  routes.ts                + 19 write entries (Task 1) ; + 6 GETs (Task 4)
  routes.test.ts           + the write samples
  types.ts                 + StockLoc
  fixtures/master.ts       LOC gains quarantine; PO_APPROVAL_LIMIT re-exported
  fixtures/seed.ts         seedStock gains an empty quarantine shelf
packages/domain/src/
  claims.ts                releaseClaim, foldClaims, shortfallClaims               (new)
  receipt.ts               RECEIPT_TOLERANCE, checkReceiptLine, receiptStatus      (new)
  purchasing.ts            poValue, needsApproval, rateFor, etaFrom                 (new)
  format.ts                money, money0, dmy, istDate, unitTotal                  (new)
  transitions.ts           + REQUISITION_TRANSITIONS, PO_TRANSITIONS
  approval.ts              + planPrqApproval, prqStatus
  credit.ts                its private `inr` deleted; uses format.ts
  shelf.ts                 its private `ymd` deleted; uses format.ts's istDate
  index.ts                 the new exports
apps/api/src/
  lib/ledger.ts            header records the document lock order              (Task 3)
  db/schema/master.ts      rate_contracts gains a partial unique index (+ migration 0006)
  test/builders.ts         + given.vendor / requisition / po / contract / productRequest
  modules/index.ts         + six registrations
  modules/requisitions/**  POST /requisitions, approve, decline                (new)
  modules/purchaseorders/**  create, patch line, delete line, patch, send, cancel (new)
  modules/grn/**           receive, close-short                                (new)
  modules/vendors/**       create, patch                                       (new)
  modules/contracts/**     create, patch, delete                               (new)
  modules/productreqs/**   create, answer                                      (new)
  modules/catalog/**       + POST /items
  modules/snapshot/**      six GETs; quarantine in stock and locations
UI/src/
  api/refetch.ts           narrow readers for prq, po, grn, vendors, contracts,
                           productReqs, items
  api/wire.ts              + applyRequisitions, applyPos, applyGrns, applyVendors,
                           applyContracts, applyProductRequests, applyItems
  data/master.ts           + hydrateItems
  lib/fmt.ts               money/money0/fromWireDate/unitTotal delegate to @rch/domain;
                           + toInputDate / fromInputDate for the two date controls
  lib/selectors.ts         + canSendPo, canCancelPo, canCloseShort
  store/procurement.ts     every action becomes an API call; `claim` and `inDays` deleted
  store/ops.ts             contracts, product requests and createItem become API calls
  store/index.ts           sendRequisition becomes an API call; the `Seq` interface goes
  roles/buyer/*            busy locks on the four form screens; createPo returns the id;
                           PurchaseOrders.tsx reads the transition predicates
  roles/store/Contracts.tsx  vendor select by id, dates as type=date
  roles/store/NewProductDrawer.tsx   the "sitem" drawer the Add product button opens  (new)
  roles/store/Stock.tsx    a quarantine panel
  roles/manager/ItemsStock.tsx, roles/prod/Stock.tsx   awaited writes
  __tests__/*              procurement.test.ts loses its rule cases (its LOC assertion moved
                           in wave 1); writes.test.ts gains the wire cases; fixture.ts loses
                           `seq` and gains the three ops collections
```

---

### Task 1: Contract — every Phase 5 write, the shared constants, and `StockLoc`

*(Wave 1, alongside Tasks 2 and 3. It owns `packages/contract/**` **and one assertion in `UI/src/__tests__/procurement.test.ts`** — see F1 below. Task 2 owns `packages/domain/**` and `UI/src/lib/fmt.ts`; Task 3 owns `apps/api/**`. No file is shared.)*

**Scope note — writes only.** `apps/api/src/contract.test.ts` probes **every** param-less GET in the manifest and asserts a 200 (Phase 2 removed its skip-on-404 branch on purpose), so a GET declared before its handler exists turns the API suite red. The six reads this phase adds are therefore declared in **Task 4**, in the same commit as the handlers that answer them. Write routes are inert until a module mounts them, so all nineteen land here.

**Files:**
- Modify: `packages/contract/src/schemas/common.ts`, `packages/contract/src/schemas/writes.ts`, `packages/contract/src/schemas/snapshot.ts`, `packages/contract/src/routes.ts`, `packages/contract/src/routes.test.ts`, `packages/contract/src/types.ts`, `packages/contract/src/fixtures/master.ts`, `packages/contract/src/fixtures/seed.ts`, **`UI/src/__tests__/procurement.test.ts` (one assertion, Step 6)**

**Why this task reaches into a UI test.** `procurement.test.ts`'s first case asserts `Object.keys(LOC).sort()` equals `[...ALL_LOCS].sort()` — the repo's only place that enumerates `LOC`'s keys, and the pin that says the store has no phantom sixth location. Adding `LOC.quarantine` breaks it, in wave 1, in the same commit. A task whose own gate goes red is not a task, so the one line moves here rather than waiting for Task 10; the constraint above ("a widening is swept with a grep") is what found it, and the grep found nothing else.

**Interfaces:**
- Consumes: `QtySchema`, `DocIdParamsSchema`, `writeResponse`, `LocKeySchema`, `IsoDate`, `Money`, `ItemTypeSchema` (all already exported).
- Produces (imported by every later task):
  ```ts
  // packages/contract/src/schemas/common.ts
  /** The rejected-goods shelf. A Store-type location that never sells and never issues; it is
   *  where a goods receipt puts what quality control turned away (spec §7.2). */
  export const QUARANTINE = "quarantine";
  /** Where stock is REPORTED. LocKeySchema — the five an operator may act on — stays as it is:
   *  no write body, no user's home, no ticket end may ever name quarantine. */
  export const StockLocSchema = z.enum(["store", "kitchen", "rest", "coffee", "kiosk", "quarantine"]);
  /** The order value above which finance has to sign. The rule that reads it is `needsApproval`
   *  in @rch/domain; this is only the number. */
  export const PO_APPROVAL_LIMIT = 25000;

  // packages/contract/src/types.ts
  export type StockLoc = z.infer<typeof C.StockLocSchema>;

  // packages/contract/src/schemas/writes.ts — bodies
  export const CreateRequisitionBodySchema, ApproveRequisitionBodySchema, DeclineRequisitionBodySchema,
    CreatePoBodySchema, PoLineParamsSchema, UpdatePoLineBodySchema, PatchPoBodySchema,
    CancelPoBodySchema, ReceivePoBodySchema, CloseShortBodySchema,
    VendorBodySchema, PatchVendorBodySchema, ContractBodySchema, PatchContractBodySchema,
    CreateItemBodySchema, CreateProductRequestBodySchema, AnswerProductRequestBodySchema;
  // and results
  export const ReceiptResultSchema, NewItemResultSchema;
  ```

**Why `PO_APPROVAL_LIMIT` moves.** It sits in `packages/contract/src/fixtures/master.ts` today, which makes it seed data. `sendPo` enforces it on the server and `PoDrawer.tsx` previews with it, so it is a rule's constant, not a fixture — exactly the argument §16 recorded for `STAFF_CREDIT_LIMIT`, which already lives in `schemas/common.ts` with `fixtures/master.ts` re-exporting it (`export { STAFF_CREDIT_LIMIT } from "../schemas/common.js";`). Do the same, so `UI/src/data/master.ts`'s destructuring line is untouched.

- [ ] **Step 1: Write the failing contract test**

`packages/contract/src/routes.test.ts` already fails the "every route that takes a body has a sample here" case the moment a new body route appears. **Add these entries to the existing `SAMPLES` object and leave every entry already there exactly as you find it** (that file is maintained alongside the Phase 2–4 routes and its values may have moved since this plan was written):

```ts
  createRequisition:    { lines: [{ it: "milk", qty: 60 }], note: "Milk at zero in the coffee shop" },
  approveRequisition:   { appr: [60, 6], note: "Approved in full." },
  declineRequisition:   { note: "Last lot is still moving." },
  createPo:             { vendorId: "VN-001", picks: [{ prq: "PRQ-2026-013", line: 0, qty: 60 }] },
  updatePoLine:         { qty: 40 },
  patchPo:              { eta: "2026-09-11" },
  cancelPo:             { reason: "Vendor cannot supply this week" },
  receivePo:            { dc: "DC-88214", invoice: "INV/AAV/4472", invDate: "2026-09-04",
                          lines: [{ recv: 60, rejected: 0, batch: "AAV-8893", mrp: 0, mfg: "2026-09-01", exp: "2026-09-08" }] },
  closePoShort:         { reason: "Vendor cannot deliver the balance" },
  addVendor:            { n: "Kumaran Traders", gstin: "33AAACA1234F1Z5", contact: "Kumar S", ph: "98430 11220", terms: "30 days", lead: 2, groups: ["Grocery"] },
  updateVendor:         { active: false },
  addContract:          { vendorId: "VN-001", it: "milk", rate: 52, from: "2026-04-01", to: "2027-03-31", moq: 40 },
  updateContract:       { rate: 54 },
  createItem:           { name: "Cold coffee premix 1kg", unit: "kg", type: "RAW", cost: 320, loc: "store", opening: 0 },
  createProductRequest: { name: "Sugar-free lemon iced tea 250ml", why: "Diabetic attenders ask daily", forLoc: "coffee" },
  answerProductRequest: { st: "Declined", note: "Vendor cannot supply reliably" },
```

And add a case at the bottom of the file:

```ts
describe("what buying puts on the wire", () => {
  it("takes a receipt line with a rejection, and refuses a rejection larger than the schema's own bound", () => {
    const line = { recv: 60, rejected: 12, batch: "AAV-8893", mrp: 20, mfg: "2026-09-01", exp: "2026-09-08" };
    expect(ReceivePoBodySchema.safeParse({ dc: "DC-1", invoice: "", invDate: "", lines: [line] }).success).toBe(true);
    expect(ReceivePoBodySchema.safeParse({ dc: "DC-1", invoice: "", invDate: "", lines: [{ ...line, exp: "08-09-2026" }] }).success).toBe(false);
  });
  it("leaves a zero quantity to the service, so the operator reads a sentence and not a 400", () => {
    expect(CreatePoBodySchema.safeParse({ vendorId: "VN-001", picks: [{ prq: "PRQ-2026-013", line: 0, qty: 0 }] }).success).toBe(true);
  });
  it("takes a patch that names only one field, and adds nothing to an empty one", () => {
    expect(PatchPoBodySchema.safeParse({ vendorId: "VN-002" }).success).toBe(true);
    expect(PatchPoBodySchema.parse({})).toEqual({});               // refused in the service, with a sentence
    expect(PatchVendorBodySchema.safeParse({ active: true }).success).toBe(true);
    // No patch schema may carry a default: `.parse({})` must stay empty, or "Nothing to change"
    // is unreachable and a patch of one field silently resets every other one.
    expect(PatchVendorBodySchema.parse({})).toEqual({});
    expect(PatchContractBodySchema.parse({})).toEqual({});
    expect(PatchVendorBodySchema.parse({ terms: "45 days" })).toEqual({ terms: "45 days" });
  });
  it("knows quarantine is somewhere stock can be, and nowhere an operator can act", () => {
    expect(StockLocSchema.safeParse("quarantine").success).toBe(true);
    expect(LocKeySchema.safeParse("quarantine").success).toBe(false);
    expect(TransferBodySchema.safeParse({ from: "rest", to: "quarantine", it: "water", qty: 1 }).success).toBe(false);
  });
  it("carries the finance slab as a rule's constant, not as seed data", () => {
    expect(PO_APPROVAL_LIMIT).toBe(25000);
  });
});
```
with the named schemas added to the file's existing `./index` import.

Run: `pnpm --filter @rch/contract test` → FAIL (`ReceivePoBodySchema` is not exported; the samples case reports nineteen route names as missing).

- [ ] **Step 2: `schemas/common.ts`**

```ts
/** The rejected-goods shelf: a Store-type location that never sells and never issues, holding
 *  what quality control turned away at a goods receipt (spec §7.2). */
export const QUARANTINE = "quarantine";
/**
 * Where stock is *reported*. `LocKeySchema` above — the five places an operator works — stays
 * exactly as it is: no write body, no user's home location and neither end of a ticket may ever
 * name quarantine, so widening `LocKey` would have opened six doors to a location nobody can
 * reach and needed a refusal sentence at each. Stock has to be shown there; nothing else does.
 */
export const StockLocSchema = z.enum([...LocKeySchema.options, QUARANTINE]);
/** The order value above which a purchase order needs finance approval, in rupees. The rule
 *  that reads it is `needsApproval` in @rch/domain; this is only the number. */
export const PO_APPROVAL_LIMIT = 25000;
```
and in `types.ts`, beside `LocKey`: `export type StockLoc = z.infer<typeof C.StockLocSchema>;`

- [ ] **Step 3: `schemas/snapshot.ts` — stock is reported per `StockLoc`**

Change the one helper's key type, leaving `menu` on `LocKeySchema`:
```ts
// Not every caller sees every location - a counter operator's snapshot is scoped down to their
// own (`scope()`), so this can't require all keys the way an exhaustive z.record(enum, ...) would.
const byLoc = <T extends z.ZodTypeAny>(v: T) => z.partialRecord(LocKeySchema, v);
/** Stock is reported for quarantine too — the store keeper has to see what was rejected — while
 *  `menu` and every write body stay on the five an operator may act on. */
const byStockLoc = <T extends z.ZodTypeAny>(v: T) => z.partialRecord(StockLocSchema, v);
```
and use `byStockLoc` for `SnapshotSchema.stock` only. `StockResponseSchema` reads `SnapshotSchema.shape.stock`, so it follows automatically. Add `StockLocSchema` to the file's `./common.js` import.

- [ ] **Step 4: `schemas/writes.ts` — the collection and the bodies**

First, one collection:
```ts
export const CollectionSchema = z.enum(["stock", "rsv", "ovr", "prices", "menu", "bills", "req", "tkt", "prq", "po", "pord", "batch", "grn", "vendors", "contracts", "tickets", "productReqs", "shopAsks", "items"]);
```
`"items"` is new: `POST /items` changes the item master, which every screen reads out of `UI/src/data/master.ts`'s registry. Without it the only honest `changed` would be a whole snapshot.

Then, after `CancelTicketBodySchema`, the bodies. Money on the wire is bounded like a quantity is:
```ts
/** A rate, an MRP or a price on the wire. Non-negative — a free-of-charge line is legal, a
 *  negative one is a client bug — and bounded, for the same reason `QtySchema` is. */
export const RateSchema = z.number().finite().min(0).max(1_000_000).multipleOf(0.01);

// ---- requisitions (spec §9.2: sendRequisition, approveRequisition, declineRequisition)
export const CreateRequisitionBodySchema = z.strictObject({
  lines: z.array(ReqLineInputSchema).min(1).max(50),
  note: z.string().max(500).default(""),
});
export const ApproveRequisitionBodySchema = z.strictObject({ appr: z.array(QtySchema).min(1).max(50), note: z.string().max(500).default("") });
export const DeclineRequisitionBodySchema = z.strictObject({ note: z.string().max(500) });

// ---- purchase orders
/** One pick off the procurement list: a requisition, one of its lines by index, a quantity.
 *  Two picks of the same line are legal on the wire and summed by the service before the
 *  pending check — checking them one at a time would let their total overrun the line. */
export const PickSchema = z.strictObject({ prq: z.string().min(1).max(40), line: z.number().int().min(0).max(49), qty: QtySchema });
export const CreatePoBodySchema = z.strictObject({ vendorId: z.string().min(1).max(40), picks: z.array(PickSchema).max(100) });
export const PoLineParamsSchema = z.strictObject({ id: z.string().min(1).max(40), n: z.coerce.number().int().min(0).max(99) });
export const UpdatePoLineBodySchema = z.strictObject({ qty: QtySchema.optional(), rate: RateSchema.optional() });
/** The vendor may move only while the order is a draft; the expected date may move at any open
 *  status. One PATCH, because the drawer offers both in the same panel. */
export const PatchPoBodySchema = z.strictObject({ vendorId: z.string().min(1).max(40).optional(), eta: IsoDate.optional() });
export const CancelPoBodySchema = z.strictObject({ reason: z.string().max(500) });
/** One instalment against one order. `lines` is positional against the order's own lines — the
 *  same shape `approve` takes for a request — and a length that does not match is refused with a
 *  sentence rather than read as "nothing arrived on the lines you left out". */
export const ReceiptLineInputSchema = z.strictObject({
  recv: QtySchema, rejected: QtySchema.default(0), batch: z.string().max(60).default(""),
  mrp: RateSchema.default(0),
  // A wire date or nothing at all — the shape `invDate` already uses. `GrnSchema.mfg`/`exp` are
  // `IsoDate` and the columns behind them are `date NOT NULL`, so a loose `z.string()` would let
  // "08-09-2026" through two string comparisons that happen not to catch it and reach Postgres
  // as a 500. Empty is the not-supplied case, which the service refuses with the store's own
  // "needs a manufacturing and an expiry date".
  mfg: z.union([IsoDate, z.literal("")]).default(""),
  exp: z.union([IsoDate, z.literal("")]).default(""),
});
export const ReceivePoBodySchema = z.strictObject({
  dc: z.string().max(60), invoice: z.string().max(60).default(""), invDate: z.union([IsoDate, z.literal("")]).default(""),
  lines: z.array(ReceiptLineInputSchema).min(1).max(100),
});
export const CloseShortBodySchema = z.strictObject({ reason: z.string().max(500) });

// ---- vendors
export const VendorBodySchema = z.strictObject({
  n: z.string().max(120), gstin: z.string().max(20).default(""), contact: z.string().max(120).default(""),
  ph: z.string().max(40).default(""), terms: z.string().max(60).default(""),
  lead: z.number().int().min(0).max(365).default(0), groups: z.array(z.string().max(40)).max(20).default([]),
});
/** Declared field by field rather than as `VendorBodySchema.partial()`: Zod carries a
 *  `.default()` through `.partial()`, so the partial of a defaulted schema parses `{}` into
 *  `{ lead: 0, groups: [] }` — which would make "Nothing to change" unreachable and would reset
 *  a vendor's lead time and groups on every patch of any other field. Optional, never defaulted. */
export const PatchVendorBodySchema = z.strictObject({
  n: z.string().max(120).optional(), gstin: z.string().max(20).optional(),
  contact: z.string().max(120).optional(), ph: z.string().max(40).optional(),
  terms: z.string().max(60).optional(), lead: z.number().int().min(0).max(365).optional(),
  groups: z.array(z.string().max(40)).max(20).optional(), active: z.boolean().optional(),
});

// ---- rate contracts
export const ContractBodySchema = z.strictObject({
  vendorId: z.string().min(1).max(40), it: z.string().min(1).max(64), rate: RateSchema,
  from: IsoDate, to: IsoDate, moq: QtySchema.default(0),
});
export const PatchContractBodySchema = z.strictObject({
  rate: RateSchema.optional(), from: IsoDate.optional(), to: IsoDate.optional(),
  moq: QtySchema.optional(), active: z.boolean().optional(),
});

// ---- the item master
/** What the three new-product drawers send. `key`, `code`, `grp`, `hsn` and `gst` are optional
 *  because the buyer's drawer leaves all five blank and the server applies the same defaults the
 *  store has always applied (unit nos, hsn 2106, gst 5). */
export const CreateItemBodySchema = z.strictObject({
  key: z.string().max(64).default(""), name: z.string().max(120), code: z.string().max(40).default(""),
  unit: z.string().max(12).default("nos"), type: ItemTypeSchema, grp: z.string().max(40).default(""),
  hsn: z.string().max(12).default(""), gst: z.number().min(0).max(100).default(5),
  reorder: QtySchema.default(0), cost: RateSchema, mrp: RateSchema.optional(), sl: z.number().int().min(0).max(100000).optional(),
  loc: LocKeySchema, opening: QtySchema.default(0),
});

// ---- new-product requests
export const CreateProductRequestBodySchema = z.strictObject({ name: z.string().max(120), why: z.string().max(1000).default(""), forLoc: LocKeySchema });
export const AnswerProductRequestBodySchema = z.strictObject({
  st: z.enum(["Created", "Declined"]), note: z.string().max(500).default(""), itemKey: z.string().max(64).optional(),
});

// `result` is the document acted on, except two. A receipt answers with the GRNs it wrote
// beside the order, because the store keeper wants to read the batch numbers back in the same
// breath (the precedent is `issue-ticket` handing over the OTP); and a new item answers with
// the key the server chose, which is the one thing the caller cannot work out for itself. A
// claim-moving write answers with the order alone and names "prq" in `changed` — the buyer's
// procurement list repaints from that refetch, so returning the requisitions too would be a
// second channel for a fact one read already carries.
export const ReceiptResultSchema = z.strictObject({ po: PurchaseOrderSchema, grns: z.array(GrnSchema) });
export const NewItemResultSchema = z.strictObject({ key: z.string(), item: ItemSchema });
```
Add `GrnSchema`, `ItemSchema`, `PurchaseOrderSchema` to the file's existing `./documents.js` import, and `IsoDate`, `ItemTypeSchema` to its `./common.js` import.

- [ ] **Step 5: `routes.ts` — nineteen write entries**

Append after `cancelTicket` and before the movement GETs, importing every name above from `./schemas/writes.js`:
```ts
  // ---- Buying (spec §9.2, Phase 5). The store keeper asks, the buyer decides and orders, and
  // either of them books the goods in. Reads are declared beside their handlers, further down.
  createRequisition:    defineRoute({ method: "POST",   path: "/requisitions",                  access: ["store"],            body: CreateRequisitionBodySchema,  response: writeResponse(RequisitionSchema) }),
  approveRequisition:   defineRoute({ method: "POST",   path: "/requisitions/:id/approve",      access: ["buyer"],            params: DocIdParamsSchema, body: ApproveRequisitionBodySchema, response: writeResponse(RequisitionSchema) }),
  declineRequisition:   defineRoute({ method: "POST",   path: "/requisitions/:id/decline",      access: ["buyer"],            params: DocIdParamsSchema, body: DeclineRequisitionBodySchema, response: writeResponse(RequisitionSchema) }),
  createPo:             defineRoute({ method: "POST",   path: "/purchase-orders",               access: ["buyer"],            body: CreatePoBodySchema,           response: writeResponse(PurchaseOrderSchema) }),
  updatePoLine:         defineRoute({ method: "PATCH",  path: "/purchase-orders/:id/lines/:n",  access: ["buyer"],            params: PoLineParamsSchema, body: UpdatePoLineBodySchema, response: writeResponse(PurchaseOrderSchema) }),
  removePoLine:         defineRoute({ method: "DELETE", path: "/purchase-orders/:id/lines/:n",  access: ["buyer"],            params: PoLineParamsSchema,         response: writeResponse(PurchaseOrderSchema) }),
  patchPo:              defineRoute({ method: "PATCH",  path: "/purchase-orders/:id",           access: ["buyer"],            params: DocIdParamsSchema, body: PatchPoBodySchema, response: writeResponse(PurchaseOrderSchema) }),
  sendPo:               defineRoute({ method: "POST",   path: "/purchase-orders/:id/send",      access: ["buyer"],            params: DocIdParamsSchema,          response: writeResponse(PurchaseOrderSchema) }),
  cancelPo:             defineRoute({ method: "POST",   path: "/purchase-orders/:id/cancel",    access: ["buyer"],            params: DocIdParamsSchema, body: CancelPoBodySchema, response: writeResponse(PurchaseOrderSchema) }),
  // The buyer receives against the order they raised; the store keeper receives at the door.
  receivePo:            defineRoute({ method: "POST",   path: "/purchase-orders/:id/receive",   access: ["buyer", "store"],   params: DocIdParamsSchema, body: ReceivePoBodySchema, response: writeResponse(ReceiptResultSchema) }),
  closePoShort:         defineRoute({ method: "POST",   path: "/purchase-orders/:id/close-short", access: ["buyer"],          params: DocIdParamsSchema, body: CloseShortBodySchema, response: writeResponse(PurchaseOrderSchema) }),
  addVendor:            defineRoute({ method: "POST",   path: "/vendors",                       access: ["buyer"],            body: VendorBodySchema,             response: writeResponse(VendorSchema) }),
  // One PATCH for both the edit and the on/off switch: `setVendorActive` is a patch of one field.
  updateVendor:         defineRoute({ method: "PATCH",  path: "/vendors/:id",                   access: ["buyer"],            params: DocIdParamsSchema, body: PatchVendorBodySchema, response: writeResponse(VendorSchema) }),
  addContract:          defineRoute({ method: "POST",   path: "/contracts",                     access: ["store"],            body: ContractBodySchema,           response: writeResponse(RateContractSchema) }),
  updateContract:       defineRoute({ method: "PATCH",  path: "/contracts/:id",                 access: ["store"],            params: DocIdParamsSchema, body: PatchContractBodySchema, response: writeResponse(RateContractSchema) }),
  removeContract:       defineRoute({ method: "DELETE", path: "/contracts/:id",                 access: ["store"],            params: DocIdParamsSchema,          response: writeResponse(RateContractSchema) }),
  // Three screens add a product: the kitchen's own (FG and RAW, at the kitchen), the store's,
  // and the buyer's answer to a shop's request. §8.3 named only the store keeper; §16 records it.
  createItem:           defineRoute({ method: "POST",   path: "/items",                         access: ["store", "prod", "buyer"], body: CreateItemBodySchema,   response: writeResponse(NewItemResultSchema) }),
  createProductRequest: defineRoute({ method: "POST",   path: "/product-requests",              access: ["counter", "manager"], body: CreateProductRequestBodySchema, response: writeResponse(ProductRequestSchema) }),
  answerProductRequest: defineRoute({ method: "POST",   path: "/product-requests/:id/answer",   access: ["store", "buyer"],   params: DocIdParamsSchema, body: AnswerProductRequestBodySchema, response: writeResponse(ProductRequestSchema) }),
```
Add `GrnSchema`, `ItemSchema`, `ProductRequestSchema`, `PurchaseOrderSchema`, `RateContractSchema`, `RequisitionSchema`, `VendorSchema` to the existing `./schemas/documents.js` import.

- [ ] **Step 6: The fixtures gain a quarantine shelf**

`packages/contract/src/fixtures/master.ts`:
```ts
export const LOC: Record<StockLoc, Location> = {
  …the five, unchanged…
  // The rejected-goods shelf. Not in OUTLETS and not in ALL_LOCS: nothing is sold, issued,
  // transferred or distributed from here, so no screen that iterates the working locations
  // should grow a sixth column. The store's own stock screen reads it by name.
  quarantine: { n: "Quarantine", c: "WH-QR", type: "Store", floor: "Basement", cc: "CC-STO" },
};
```
(the row is `apps/api/src/db/seed.ts`'s, verbatim), `import type { StockLoc } from "../types.js";`, and replace line 94's declaration with `export { PO_APPROVAL_LIMIT } from "../schemas/common.js";` beside the `STAFF_CREDIT_LIMIT` line. `OUTLETS` and `ALL_LOCS` are **unchanged** — both stay `LocKey[]` and both stay five long.

`packages/contract/src/fixtures/seed.ts`: retype `seedStock` as `Record<StockLoc, Record<string, number>>` and add a last line `quarantine: {},` — an empty shelf, because the seed rejects nothing.

- [ ] **Step 6: Move the one assertion the sixth location breaks (F1)**

`UI/src/__tests__/procurement.test.ts` opens with the repo's only enumeration of `LOC`'s keys:
```ts
describe("stock locations", () => {
  it("carries exactly the five real locations — there is no transit room", () => {
    expect(Object.keys(LOC).sort()).toEqual([...ALL_LOCS].sort());
```
Rewrite that one case, and nothing else in the file:
```ts
describe("stock locations", () => {
  it("carries the five working locations and the rejected-goods shelf, and no transit room", () => {
    // `ALL_LOCS` is deliberately still five: quarantine is somewhere stock can *be*, never
    // somewhere an operator works, so no screen that iterates the working locations grows a
    // sixth column. It has a name and a shelf, and that is all.
    expect(Object.keys(LOC).sort()).toEqual([...ALL_LOCS, "quarantine"].sort());
    expect(ALL_LOCS).toHaveLength(5);
    expect(ALL_LOCS).not.toContain("quarantine");
  });
```
Confirm with a grep that this is the only place in `UI/src` that enumerates the set — `grep -rn "Object.keys(LOC)\|ALL_LOCS" UI/src` — and if the grep finds a screen this plan has not named, add it here and say so in the commit body.

- [ ] **Step 7: Run the tests**

Run: `pnpm turbo typecheck test && pnpm lint`
Expected: PASS everywhere, `UI` included — Step 6 is what keeps it green. Nothing mounts the nineteen new routes yet, and a manifest entry with no handler is inert — `apps/api/src/contract.test.ts` iterates GETs only, and this task adds none. `apps/api`'s `readStock` returns `Record<LocKey, …>`, which is still assignable to the widened `Partial<Record<StockLoc, …>>`, and the UI's `stock: Record<LocKey, …>` still accepts `clone(seedStock)` because a `Record<StockLoc, …>` has every `LocKey` key. Nothing else moves until Task 4.
If `knip` reports `QUARANTINE`, `StockLocSchema`, `RateSchema`, `PickSchema` or `ReceiptLineInputSchema` as unused, leave them: `knip.json` covers `packages/*` with `ignoreExportsUsedInFile: true`, and each is used inside its own file. If it reports a body schema nothing imports, that is real — check you added it to `routes.ts`.

- [ ] **Step 8: Commit**

```bash
git add packages/contract UI/src/__tests__/procurement.test.ts
git commit -m "$(cat <<'EOF'
Declare what buying puts on the wire

Nineteen writes: a requisition and its decision, a purchase order from draft to received or
cancelled, vendors, rate contracts, a new catalogue item and the answer to a shop that asked
for one. Reads follow with their handlers, because contract.test.ts probes every manifest GET.

Quarantine gets a key of its own, StockLoc, rather than joining LocKey. Stock has to be
reported there; nothing else does. Widening LocKey would have let a rejected-goods shelf
through six write bodies that name a location, each needing a guard and a refusal sentence for
somewhere no operator can reach.

The finance slab moves out of the fixtures and into the contract beside the staff credit
limit: it is a rule's constant, enforced by the server and previewed by the buyer's drawer,
not seed data.

One UI assertion moves with the fixtures rather than waiting for the cutover: procurement.test.ts
holds the repo's only enumeration of LOC's keys, and a commit that leaves its own gate red is
not a commit. A grep over UI/src found nothing else that counts the locations.

Every patch body is declared field by field with no defaults. Zod carries a default through
.partial(), so a partial of a defaulted schema parses an empty patch into a full one — which
would have made "nothing to change" unreachable and reset a vendor's lead time on every edit.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Domain — claims, the receipt rules, the money words, and two transition tables

*(Wave 1, alongside Tasks 1 and 3. It owns `packages/domain/**` and `UI/src/lib/fmt.ts`. Task 1 owns `packages/contract/**`; Task 3 owns `apps/api/**`. `UI/src/lib/fmt.ts` is touched by nobody else until wave 3, and wave 3's UI task is told not to touch it.)*

**Why these five files.** Spec §5.1: a business rule is written once, in `packages/domain`; the server enforces it and the client previews with it. Four Phase 5 rule families are written twice today — the claim walk (`store/procurement.ts`'s `claim()` and the reverse-source loops in `updatePoLine`, `closePoShort`), the receipt checks (`receivePo`'s eight-line validation loop), the value slab (`poValue` in `lib/selectors.ts` plus `PO_APPROVAL_LIMIT` in two screens), and the money/date/unit words the server's toasts have to speak (`money`, `money0`, `fromWireDate`, `unitTotal` in `UI/src/lib/fmt.ts`). After this task each is one function that both sides call.

**Files:**
- Create: `packages/domain/src/{claims.ts,claims.test.ts,receipt.ts,receipt.test.ts,purchasing.ts,purchasing.test.ts,format.ts,format.test.ts}`
- Modify: `packages/domain/src/{transitions.ts,transitions.test.ts,approval.ts,approval.test.ts,credit.ts,shelf.ts,index.ts}`, `UI/src/lib/fmt.ts`, `UI/src/__tests__/api.test.ts` (the two date-converter cases only)

**Interfaces:**
- Consumes: `round3` from `./round.js`, `fq` from `./availability.js`, `STAFF_CREDIT_LIMIT` from `@rch/contract` (already imported by `credit.ts`). **It does not import `PO_APPROVAL_LIMIT`.** Task 1 declares that constant in the contract in the same wave, and a domain module importing a name its sibling task has not merged yet would leave this worktree red for no reason: `needsApproval(value, limit)` takes the limit as an explicit parameter with no default, and `modules/purchaseorders/service.ts` (Task 6) is what passes `PO_APPROVAL_LIMIT` in. `purchasing.ts` re-exports no constant.
- Produces:
  ```ts
  // packages/domain/src/format.ts
  export const money: (v: number) => string;          // "₹1,234.50"
  export const money0: (v: number) => string;         // "₹1,235"
  export const istDate: (d: Date) => string;          // "2026-09-04", Asia/Kolkata
  export const dmy: (isoDate: string) => string;      // "2026-08-31" -> "31-Aug-2026"
  export const unitTotal: (lines: readonly { it: string; qty: number }[], unitOf: (it: string) => string) => string;

  // UI/src/lib/fmt.ts — the two edge converters a date control needs (F5)
  export const toInputDate: (display: string) => string;    // "31-Aug-2026" -> "2026-08-31"
  export const fromInputDate: (iso: string) => string;      // "2026-08-31" -> "31-Aug-2026"

  // packages/domain/src/claims.ts
  export type ClaimSrc = { prq: string; line: number; qty: number };
  export const foldClaims: (src: readonly ClaimSrc[]) => ClaimSrc[];
  export const releaseClaim: (src: readonly ClaimSrc[], give: number) => { released: ClaimSrc[]; left: ClaimSrc[] };
  export const shortfallClaims: (lines: readonly { qty: number; recv: number; src: readonly ClaimSrc[] }[]) => ClaimSrc[];

  // packages/domain/src/receipt.ts
  export const RECEIPT_TOLERANCE = 1.02;
  export type ReceiptCheckLine = { name: string; unit: string; ordered: number; received: number; mrp: number | null; listA: number };
  export type ReceiptCheckInput = { recv: number; rejected: number; batch: string; mrp: number; mfg: string; exp: string };
  export const checkReceiptLine: (l: ReceiptCheckLine, r: ReceiptCheckInput, today: string) => string | null;
  export const receiptStatus: (lines: readonly { qty: number; recv: number }[]) => "Received" | "Partially received";

  // packages/domain/src/purchasing.ts
  export const poValue: (lines: readonly { qty: number; rate: number }[]) => number;
  export const needsApproval: (value: number, limit: number) => boolean;
  export const rateFor: (contract: { rate: number } | undefined, itemCost: number) => number;
  export const etaFrom: (at: Date, leadDays: number) => string;   // IsoDate

  // packages/domain/src/transitions.ts
  export const REQUISITION_TRANSITIONS: TransitionTable<PrqStatus>;
  export const PO_TRANSITIONS: TransitionTable<PoStatus>;

  // packages/domain/src/approval.ts
  export const prqStatus: (lines: readonly { qty: number; appr: number }[]) => "Declined" | "Approved" | "Partially approved";
  export const planPrqApproval: (lines: readonly { it: string; qty: number }[], appr: readonly number[]) => { lines: ApprovalLine[]; st: "Declined" | "Approved" | "Partially approved" };
  ```
- `packages/domain/src/index.ts` gains exactly the names above (`ClaimSrc` and the two `Receipt*` types as `export type`). `RECEIPT_TOLERANCE` is **not** re-exported — only `receipt.ts` and its own test read the number; knip reports a re-export nobody imports.

**The two transition tables, and why each is exactly this shape:**

| Table | Rows | Why |
|---|---|---|
| `REQUISITION_TRANSITIONS` | `Sent: ["Approved", "Partially approved", "Declined"]`, and `Approved`, `"Partially approved"`, `Declined` all `[]` | A requisition is decided once. Everything after the decision happens on the *purchase orders* that claim against it — `ordered_qty` moves, the status does not. §12 wants every unlisted `PrqStatus` transition tested as refused, and this is the whole graph. |
| `PO_TRANSITIONS` | `Draft: ["Ordered", "Cancelled"]`, `Ordered: ["Partially received", "Received", "Cancelled"]`, `"Partially received": ["Partially received", "Received"]`, `Received: []`, `Cancelled: []` | The self-edge on `Partially received` is deliberate and is the one edge a reader will stop at: a **second instalment that still does not complete the order genuinely re-enters the same status**, and `receiptStatus` computes the target from the totals without knowing where it started. `Ordered → Cancelled` is in the table but is *further* guarded at its door — an order with anything received is refused with its own sentence before the table is consulted, so a partly-received order can only be closed short. `Partially received` has no `Cancelled`: the claim on what already arrived cannot be given back. |

- [ ] **Step 1: Write the failing tests**

`packages/domain/src/format.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { dmy, istDate, money, money0, unitTotal } from "./format.js";

describe("money", () => {
  it("prints rupees the way every screen already prints them", () => {
    expect(money(1234.5)).toBe("₹1,234.50");
    expect(money(0)).toBe("₹0.00");
    expect(money0(1234.5)).toBe("₹1,235");
    expect(money0(25000)).toBe("₹25,000");
  });
});

describe("dmy", () => {
  it("turns a wire date into the one the paperwork carries", () => {
    expect(dmy("2026-08-31")).toBe("31-Aug-2026");
    expect(dmy("2026-01-01")).toBe("01-Jan-2026");
  });
  it("passes anything that is not a wire date straight through", () => {
    expect(dmy("31-Aug-2026")).toBe("31-Aug-2026");
    expect(dmy("")).toBe("");
  });
});

describe("istDate", () => {
  it("reads the calendar date in the hospital's zone, not the host's", () => {
    // 23:30 IST on the 4th is 18:00Z on the 4th; a host in UTC agrees. 00:30 IST on the 5th is
    // 19:00Z on the 4th, and a host in UTC would call that the 4th. The hospital would not.
    expect(istDate(new Date("2026-09-04T18:00:00.000Z"))).toBe("2026-09-04");
    expect(istDate(new Date("2026-09-04T19:00:00.000Z"))).toBe("2026-09-05");
  });
});

describe("unitTotal (M4)", () => {
  const unitOf = (it: string) => (it === "milk" ? "L" : "nos");
  it("groups by unit rather than summing litres into cups", () => {
    expect(unitTotal([{ it: "milk", qty: 10 }, { it: "cup", qty: 500 }], unitOf)).toBe("10.000 L · 500 nos");
  });
  it("is empty for nothing", () => {
    expect(unitTotal([], unitOf)).toBe("");
  });
});
```

`packages/domain/src/claims.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { foldClaims, releaseClaim, shortfallClaims } from "./claims.js";

const src = [
  { prq: "PRQ-2026-011", line: 0, qty: 25 },
  { prq: "PRQ-2026-012", line: 0, qty: 80 },
];

describe("releaseClaim", () => {
  it("gives back the last source first, so the newest claim is the first to go", () => {
    const { released, left } = releaseClaim(src, 30);
    expect(released).toEqual([{ prq: "PRQ-2026-012", line: 0, qty: 30 }]);
    expect(left).toEqual([{ prq: "PRQ-2026-011", line: 0, qty: 25 }, { prq: "PRQ-2026-012", line: 0, qty: 50 }]);
  });

  it("walks past an exhausted source into the one before it", () => {
    const { released, left } = releaseClaim(src, 95);
    expect(released).toEqual([
      { prq: "PRQ-2026-012", line: 0, qty: 80 },
      { prq: "PRQ-2026-011", line: 0, qty: 15 },
    ]);
    expect(left).toEqual([{ prq: "PRQ-2026-011", line: 0, qty: 10 }]);
  });

  it("returns everything and leaves nothing when the whole line goes", () => {
    const { released, left } = releaseClaim(src, 105);
    expect(released.reduce((t, x) => t + x.qty, 0)).toBe(105);
    expect(left).toEqual([]);
  });

  it("gives nothing back for nothing, and never more than it holds", () => {
    expect(releaseClaim(src, 0).released).toEqual([]);
    expect(releaseClaim(src, 0).left).toEqual([...src]);
    expect(releaseClaim(src, 999).released.reduce((t, x) => t + x.qty, 0)).toBe(105);
  });

  it("keeps three decimals, so a kilo split three ways adds back up", () => {
    const thirds = [{ prq: "P", line: 0, qty: 0.333 }, { prq: "P", line: 1, qty: 0.334 }];
    expect(releaseClaim(thirds, 0.5).released.reduce((t, x) => t + x.qty, 0)).toBeCloseTo(0.5, 3);
  });
});

describe("foldClaims", () => {
  it("adds up every delta against the same requisition line", () => {
    expect(foldClaims([
      { prq: "A", line: 0, qty: 5 }, { prq: "A", line: 0, qty: 7 }, { prq: "A", line: 1, qty: 2 },
    ])).toEqual([{ prq: "A", line: 0, qty: 12 }, { prq: "A", line: 1, qty: 2 }]);
  });
  it("sorts by requisition id, then line — the order every writer takes its locks in", () => {
    expect(foldClaims([{ prq: "B", line: 0, qty: 1 }, { prq: "A", line: 1, qty: 1 }, { prq: "A", line: 0, qty: 1 }])
      .map((x) => `${x.prq}#${x.line}`)).toEqual(["A#0", "A#1", "B#0"]);
  });
});

describe("shortfallClaims", () => {
  it("gives back only what never arrived, last source first", () => {
    expect(shortfallClaims([{ qty: 105, recv: 60, src }])).toEqual([
      { prq: "PRQ-2026-012", line: 0, qty: 45 },
    ]);
  });
  it("gives nothing back on a line that was delivered in full or over", () => {
    expect(shortfallClaims([{ qty: 80, recv: 80, src: [src[1]] }])).toEqual([]);
    expect(shortfallClaims([{ qty: 80, recv: 81, src: [src[1]] }])).toEqual([]);
  });
});
```

`packages/domain/src/receipt.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { RECEIPT_TOLERANCE, checkReceiptLine, receiptStatus } from "./receipt.js";

const line = { name: "Real Juice 200ml", unit: "nos", ordered: 120, received: 0, mrp: 20, listA: 18 };
const ok = { recv: 120, rejected: 0, batch: "SBD-771", mrp: 20, mfg: "2026-09-01", exp: "2026-12-01" };
const TODAY = "2026-09-04";

describe("checkReceiptLine", () => {
  it("passes a clean instalment", () => {
    expect(checkReceiptLine(line, ok, TODAY)).toBeNull();
  });

  it("allows the 2% over-delivery the hospital accepts without a second thought", () => {
    expect(RECEIPT_TOLERANCE).toBe(1.02);
    expect(checkReceiptLine(line, { ...ok, recv: 122 }, TODAY)).toBeNull();          // 122 <= 122.4
    expect(checkReceiptLine(line, { ...ok, recv: 123 }, TODAY))
      .toBe("Real Juice 200ml — 123 exceeds the ordered 120 by more than 2%; hold it for purchase approval");
  });

  it("counts what earlier instalments already booked in", () => {
    expect(checkReceiptLine({ ...line, received: 100 }, { ...ok, recv: 23 }, TODAY))
      .toBe("Real Juice 200ml — 123 exceeds the ordered 120 by more than 2%; hold it for purchase approval");
  });

  it("refuses a rejection bigger than the delivery, and a negative one", () => {
    expect(checkReceiptLine(line, { ...ok, rejected: 130 }, TODAY)).toBe("Real Juice 200ml — rejected quantity cannot exceed what arrived");
    expect(checkReceiptLine(line, { ...ok, rejected: -1 }, TODAY)).toBe("Real Juice 200ml — rejected quantity cannot exceed what arrived");
  });

  it("will not book stock in without a batch behind it", () => {
    expect(checkReceiptLine(line, { ...ok, batch: "  " }, TODAY)).toBe("Real Juice 200ml needs its batch or lot number");
  });

  it("wants both dates, and them the right way round", () => {
    expect(checkReceiptLine(line, { ...ok, exp: "" }, TODAY)).toBe("Real Juice 200ml needs a manufacturing and an expiry date");
    expect(checkReceiptLine(line, { ...ok, mfg: "" }, TODAY)).toBe("Real Juice 200ml needs a manufacturing and an expiry date");
    expect(checkReceiptLine(line, { ...ok, mfg: "2026-12-01", exp: "2026-12-01" }, TODAY))
      .toBe("Real Juice 200ml — expiry cannot fall on or before the manufacturing date");
  });

  it("refuses stock that has already expired, and takes one expiring today", () => {
    expect(checkReceiptLine(line, { ...ok, exp: "2026-09-03" }, TODAY))
      .toBe("Real Juice 200ml — batch SBD-771 has already expired; do not book it in");
    expect(checkReceiptLine(line, { ...ok, exp: TODAY }, TODAY)).toBeNull();
  });

  it("refuses a printed MRP below the shelf price, and ignores MRP on an item that has none", () => {
    expect(checkReceiptLine(line, { ...ok, mrp: 15 }, TODAY))
      .toBe("Real Juice 200ml — printed MRP ₹15.00 is below the shelf price; reprice before selling");
    expect(checkReceiptLine({ ...line, mrp: null }, { ...ok, mrp: 15 }, TODAY)).toBeNull();
    expect(checkReceiptLine(line, { ...ok, mrp: 0 }, TODAY)).toBeNull();   // not printed on the pack
  });

  it("checks in the order the store keeper reads: tolerance, rejection, batch, dates, MRP", () => {
    // Everything wrong at once must still name the tolerance, which is the one that stops the
    // delivery at the door. The order is what the browser has always produced.
    expect(checkReceiptLine(line, { recv: 200, rejected: 300, batch: "", mrp: 1, mfg: "", exp: "" }, TODAY))
      .toBe("Real Juice 200ml — 200 exceeds the ordered 120 by more than 2%; hold it for purchase approval");
  });
});

describe("receiptStatus", () => {
  it("is Received only when every line is covered", () => {
    expect(receiptStatus([{ qty: 80, recv: 80 }, { qty: 6, recv: 6 }])).toBe("Received");
    expect(receiptStatus([{ qty: 80, recv: 60 }, { qty: 6, recv: 6 }])).toBe("Partially received");
    expect(receiptStatus([{ qty: 80, recv: 81 }])).toBe("Received");
  });
});
```

`packages/domain/src/purchasing.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { etaFrom, needsApproval, poValue, rateFor } from "./purchasing.js";

describe("poValue and needsApproval", () => {
  it("values an order at quantity times rate", () => {
    expect(poValue([{ qty: 120, rate: 14.2 }, { qty: 90, rate: 11.5 }])).toBeCloseTo(2739, 2);
  });
  it("is over the slab strictly, so landing exactly on it does not need finance", () => {
    expect(needsApproval(25000, 25000)).toBe(false);
    expect(needsApproval(25000.01, 25000)).toBe(true);
  });
});

describe("rateFor", () => {
  it("prices off the live contract when there is one", () => {
    expect(rateFor({ rate: 52 }, 54)).toBe(52);
  });
  it("falls back to the item's own cost when there is not", () => {
    expect(rateFor(undefined, 54)).toBe(54);
  });
  it("ignores a contract with no rate on it", () => {
    expect(rateFor({ rate: 0 }, 54)).toBe(54);
  });
});

describe("etaFrom", () => {
  it("is the vendor's lead time from today, in the hospital's calendar", () => {
    expect(etaFrom(new Date("2026-08-29T18:00:00.000Z"), 2)).toBe("2026-08-31");
    expect(etaFrom(new Date("2026-08-29T19:00:00.000Z"), 2)).toBe("2026-09-01");  // already the 30th in IST
    expect(etaFrom(new Date("2026-08-29T06:00:00.000Z"), 0)).toBe("2026-08-29");
  });
});
```

Append to `packages/domain/src/transitions.test.ts`:
```ts
describe("a requisition is decided once", () => {
  it("goes from Sent to any of the three decisions", () => {
    expect(canTransition(REQUISITION_TRANSITIONS, "Sent", "Approved")).toBe(true);
    expect(canTransition(REQUISITION_TRANSITIONS, "Sent", "Partially approved")).toBe(true);
    expect(canTransition(REQUISITION_TRANSITIONS, "Sent", "Declined")).toBe(true);
  });
  it("is finished the moment it is decided — what happens next happens on the orders", () => {
    for (const st of ["Approved", "Partially approved", "Declined"] as const) {
      expect(REQUISITION_TRANSITIONS[st]).toEqual([]);
    }
  });
});

describe("a purchase order's life", () => {
  it("goes out or is dropped while it is a draft", () => {
    expect(PO_TRANSITIONS.Draft).toEqual(["Ordered", "Cancelled"]);
  });
  it("takes goods once it is ordered, in one delivery or several", () => {
    expect(canTransition(PO_TRANSITIONS, "Ordered", "Received")).toBe(true);
    expect(canTransition(PO_TRANSITIONS, "Ordered", "Partially received")).toBe(true);
  });
  it("re-enters Partially received on a second instalment that still does not finish it", () => {
    expect(canTransition(PO_TRANSITIONS, "Partially received", "Partially received")).toBe(true);
  });
  it("cannot be cancelled once anything has arrived", () => {
    expect(canTransition(PO_TRANSITIONS, "Partially received", "Cancelled")).toBe(false);
    expect(canTransition(PO_TRANSITIONS, "Received", "Cancelled")).toBe(false);
  });
  it("is finished when it is received or cancelled", () => {
    expect(PO_TRANSITIONS.Received).toEqual([]);
    expect(PO_TRANSITIONS.Cancelled).toEqual([]);
  });
  it("never goes back to a draft", () => {
    for (const st of ["Ordered", "Partially received", "Received", "Cancelled"] as const) {
      expect(canTransition(PO_TRANSITIONS, st, "Draft")).toBe(false);
    }
  });
});
```
with `PO_TRANSITIONS` and `REQUISITION_TRANSITIONS` added to that file's import.

Append to `packages/domain/src/approval.test.ts`:
```ts
describe("planPrqApproval", () => {
  const lines = [{ it: "milk", qty: 60 }, { it: "butter", qty: 6 }];
  it("never approves more than the store keeper asked for", () => {
    const p = planPrqApproval(lines, [999, 6]);
    expect(p.lines.map((l) => l.appr)).toEqual([60, 6]);
    expect(p.st).toBe("Approved");
  });
  it("records the shortfall on a trimmed line", () => {
    const p = planPrqApproval(lines, [40, 6]);
    expect(p.lines[0]).toEqual({ it: "milk", qty: 60, appr: 40, short: 20 });
    expect(p.st).toBe("Partially approved");
  });
  it("is a decline when nothing is approved, and every line's shortfall is the whole ask", () => {
    const p = planPrqApproval(lines, [0, 0]);
    expect(p.st).toBe("Declined");
    expect(p.lines.map((l) => l.short)).toEqual([60, 6]);
  });
  it("reads a missing or negative entry as nothing approved", () => {
    expect(planPrqApproval(lines, [Number.NaN, -5]).st).toBe("Declined");
  });
  it("does not consult free-to-promise — the store's shelf has nothing to do with what a vendor can supply", () => {
    // planApproval takes a freeFor callback; this one deliberately does not have one.
    expect(planPrqApproval.length).toBe(2);
  });
});
```
with `planPrqApproval` added to that file's import.

Run: `pnpm --filter @rch/domain test` → FAIL (`./claims.js`, `./receipt.js`, `./purchasing.js`, `./format.js` do not exist; `PO_TRANSITIONS` and `planPrqApproval` are not exported).

- [ ] **Step 2: Write `format.ts`, and point `credit.ts` and `shelf.ts` at it**

```ts
/**
 * The words and numbers both sides print.
 *
 * A refusal sentence and the screen showing the same figure must round and group it the same
 * way; a second formatter drifts from the first the moment either changes (spec §5.1, and the
 * §16 row that moved `fq` here for exactly this reason). Every function below is the browser's
 * own implementation, moved rather than rewritten — `UI/src/lib/fmt.ts` now delegates.
 */
const TZ = "Asia/Kolkata";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Rupees at two decimals, Indian grouping. */
export const money = (v: number): string =>
  "₹" + (v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Rupees to the nearest whole one — what a slab or a day's takings is quoted in. */
export const money0 = (v: number): string => "₹" + Math.round(v || 0).toLocaleString("en-IN");

/** The hospital's calendar date for an instant, so "today" is not the host's opinion. */
export const istDate = (d: Date): string => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
};

/** "2026-08-31" -> "31-Aug-2026", the form every purchase order and contract is read in.
 *  Anything that is not a wire date passes straight through, so a value already in this form
 *  survives a second pass. */
export const dmy = (d: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1]}` : d;
};

/**
 * Quantities in different units cannot be added. Group by unit and show each, so a receipt
 * never reads "510 units" for 10 L of milk and 500 cups (M4). `unitOf` is passed in because the
 * item master is a parameter of every rule in this package, never a registry it reads.
 */
export function unitTotal(lines: readonly { it: string; qty: number }[], unitOf: (it: string) => string): string {
  const byUnit = new Map<string, number>();
  for (const l of lines) byUnit.set(unitOf(l.it), (byUnit.get(unitOf(l.it)) ?? 0) + l.qty);
  return [...byUnit.entries()]
    .map(([u, v]) => `${u === "nos" ? String(Math.round(v)) : v.toFixed(3)} ${u}`)
    .join(" · ");
}
```
`dmy` uses a month table rather than `toLocaleDateString`, because the only caller that mattered — `fromWireDate` — needed a fixed three-letter English month and an ICU that spelled it differently would silently change every purchase order on screen.

In `credit.ts`, delete the private `inr` **only** — `round2` stays, because `creditRoom` and `breachesCredit` both still call it — and use `money`/`money0` for the sentence:
```ts
import { money, money0 } from "./format.js";
…
export const creditBreachMessage = (
  taken: number, total: number, payerName: string, limit: number = STAFF_CREDIT_LIMIT,
): string =>
  `${money(taken + total)} breaches the ${money0(limit)} staff credit limit for ${payerName}. Take another tender or split the bill.`;
```
`credit.test.ts` already pins that sentence character for character — **do not change it**; if it goes red, `money`/`money0` are not byte-identical to the `inr` they replaced and the formatter is wrong, not the test.

In `shelf.ts`, delete the private `ymd` and `import { istDate } from "./format.js";`, using `istDate` where `ymd` was. `shelf.test.ts` pins the H9 wording and the Asia/Kolkata day boundary — it must stay green untouched.

- [ ] **Step 3: Write `claims.ts`**

```ts
import { round3 } from "./round.js";

/**
 * A purchase-order line's claim on the requisition lines that funded it.
 *
 * The procurement list is derived — approved less ordered, `procurementList` in the frontend —
 * so there is no pool to keep in sync: moving `requisition_lines.ordered_qty` is the only thing
 * that adds to it or takes from it. These three functions are the whole of that arithmetic, and
 * both sides read them: the server settles the claim, the buyer's screen previews what a change
 * would give back.
 */
export type ClaimSrc = { prq: string; line: number; qty: number };

/**
 * Give `give` back off a line's sources, **last source first**.
 *
 * A line can be funded by several requisitions, added in the order the buyer picked them. The
 * newest claim is the one to release first: it is the one the buyer is most likely undoing, and
 * a fixed direction is what makes a shrink-then-grow round trip land back where it started
 * rather than quietly moving demand between two store keepers' requisitions.
 */
export function releaseClaim(src: readonly ClaimSrc[], give: number): { released: ClaimSrc[]; left: ClaimSrc[] } {
  let owed = round3(Math.max(0, give));
  const released: ClaimSrc[] = [];
  const left: ClaimSrc[] = [];
  for (const x of [...src].reverse()) {
    const take = Math.min(owed, x.qty);
    owed = round3(owed - take);
    if (take > 0) released.push({ ...x, qty: round3(take) });
    const keep = round3(x.qty - take);
    if (keep > 0) left.unshift({ ...x, qty: keep });
  }
  return { released, left };
}

/** Every delta against the same requisition line, added up and sorted by (requisition, line) —
 *  which is also the order a writer takes its row locks in. */
export function foldClaims(src: readonly ClaimSrc[]): ClaimSrc[] {
  const by = new Map<string, ClaimSrc>();
  for (const x of src) {
    const key = `${x.prq}␟${x.line}`;
    const at = by.get(key);
    if (at) at.qty = round3(at.qty + x.qty);
    else by.set(key, { prq: x.prq, line: x.line, qty: round3(x.qty) });
  }
  return [...by.values()].sort((a, b) => a.prq.localeCompare(b.prq) || a.line - b.line);
}

/** What never arrived, per line, released last source first — a close-short's whole answer. */
export function shortfallClaims(lines: readonly { qty: number; recv: number; src: readonly ClaimSrc[] }[]): ClaimSrc[] {
  return lines.flatMap((l) => releaseClaim(l.src, round3(Math.max(0, l.qty - l.recv))).released);
}
```

- [ ] **Step 4: Write `receipt.ts`**

```ts
import { money } from "./format.js";
import { fq } from "./availability.js";
import { round3 } from "./round.js";

/**
 * What a store keeper may book in, and what they may not.
 *
 * Nothing enters stock without a batch behind it, and no batch is accepted that is already
 * expired or mis-dated. Every sentence here is the browser's own, character for character, and
 * so is their order: the same delivery must produce the same refusal whichever side checks it.
 */
/** Vendors over-deliver by a packet or two; more than this is a purchase decision, not a receipt. */
export const RECEIPT_TOLERANCE = 1.02;

export type ReceiptCheckLine = {
  name: string; unit: string;
  /** What the order asked for, and what earlier instalments already booked in. */
  ordered: number; received: number;
  /** The item's own printed MRP, or null when it does not carry one, and its list-A shelf price. */
  mrp: number | null; listA: number;
};
export type ReceiptCheckInput = { recv: number; rejected: number; batch: string; mrp: number; mfg: string; exp: string };

/**
 * The refusal this line earns, or null. `today` is an `IsoDate` in the hospital's calendar
 * (`istDate`), and both date comparisons are string comparisons on `YYYY-MM-DD` — which is
 * exactly right for a date with no time in it, and avoids the trap the browser had to work
 * around, where a bare date parses as UTC midnight and a "today" built from the host's clock
 * sits behind it in every zone west of UTC.
 */
export function checkReceiptLine(l: ReceiptCheckLine, r: ReceiptCheckInput, today: string): string | null {
  const total = round3(l.received + r.recv);
  if (total > round3(l.ordered * RECEIPT_TOLERANCE)) {
    return `${l.name} — ${fq(total, l.unit)} exceeds the ordered ${fq(l.ordered, l.unit)} by more than 2%; hold it for purchase approval`;
  }
  if (r.rejected < 0 || r.rejected > r.recv) return `${l.name} — rejected quantity cannot exceed what arrived`;
  if (!r.batch.trim()) return `${l.name} needs its batch or lot number`;
  if (!r.mfg || !r.exp) return `${l.name} needs a manufacturing and an expiry date`;
  if (r.exp <= r.mfg) return `${l.name} — expiry cannot fall on or before the manufacturing date`;
  if (r.exp < today) return `${l.name} — batch ${r.batch.trim()} has already expired; do not book it in`;
  if (l.mrp != null && r.mrp > 0 && r.mrp < l.listA) {
    return `${l.name} — printed MRP ${money(r.mrp)} is below the shelf price; reprice before selling`;
  }
  return null;
}

/** Where the order stands once an instalment is booked: covered on every line, or not yet. */
export const receiptStatus = (lines: readonly { qty: number; recv: number }[]): "Received" | "Partially received" =>
  lines.every((l) => l.recv >= l.qty) ? "Received" : "Partially received";
```

- [ ] **Step 5: Write `purchasing.ts`, the two tables and `planPrqApproval`**

```ts
import { istDate } from "./format.js";
import { round3 } from "./round.js";

/** What an order is worth, before tax and before anything is delivered. */
export const poValue = (lines: readonly { qty: number; rate: number }[]): number =>
  Math.round(lines.reduce((t, l) => t + l.qty * l.rate, 0) * 100) / 100;

/** Strictly over the slab. An order landing exactly on the limit goes out without finance. */
export const needsApproval = (value: number, limit: number): boolean => value > limit;

/** A line is priced off the live rate contract wherever there is one, and off the item's own
 *  standard cost where there is not (spec §9.2, `createPo`). A contract with no rate on it is
 *  not a price. */
export const rateFor = (contract: { rate: number } | undefined, itemCost: number): number =>
  contract && contract.rate > 0 ? contract.rate : itemCost;

/** The expected date a vendor's lead time implies, counted in the hospital's calendar. */
export const etaFrom = (at: Date, leadDays: number): string =>
  istDate(new Date(Date.parse(`${istDate(at)}T00:00:00+05:30`) + Math.max(0, Math.round(leadDays)) * 86_400_000));
```
In `transitions.ts`, after `SHOP_ASK_TRANSITIONS`:
```ts
/** A requisition is decided once, and everything after the decision happens on the purchase
 *  orders that claim against it — `ordered_qty` moves, the status does not. */
export const REQUISITION_TRANSITIONS: TransitionTable<PrqStatus> = {
  Sent: ["Approved", "Partially approved", "Declined"],
  Approved: [],
  "Partially approved": [],
  Declined: [],
};

/**
 * A purchase order's life. Two rows read oddly and are deliberate:
 *
 * `Partially received -> Partially received` is a real edge — a second instalment that still
 * does not complete the order re-enters the status it was already in, and the status is computed
 * from the totals rather than from where it started.
 *
 * `Ordered -> Cancelled` is listed, but an order with anything received is refused before the
 * table is ever consulted, with its own sentence telling the buyer to close it short instead.
 * `Partially received` has no `Cancelled` at all: the claim on goods that arrived cannot be
 * given back. An edge reachable through one door is guarded at that door.
 */
export const PO_TRANSITIONS: TransitionTable<PoStatus> = {
  Draft: ["Ordered", "Cancelled"],
  Ordered: ["Partially received", "Received", "Cancelled"],
  "Partially received": ["Partially received", "Received"],
  Received: [],
  Cancelled: [],
};
```
with `PoStatus` and `PrqStatus` added to the file's `@rch/contract` type import.

In `approval.ts`, after `approvedStatus`:
```ts
/** Which decision a set of requisition lines amounts to. A requisition that approves nothing is
 *  a decline in all but name, and the store keeper reads it as one. */
export const prqStatus = (lines: readonly { qty: number; appr: number }[]): "Declined" | "Approved" | "Partially approved" =>
  lines.every((l) => l.appr === 0) ? "Declined"
    : lines.every((l) => l.appr === l.qty) ? "Approved" : "Partially approved";

/**
 * The buyer's decision on a requisition. Never more than the store keeper asked for and never
 * more than the buyer typed — and, unlike a stock request's approval, **never netted against
 * free to promise**: what the central store is holding has nothing to do with what a vendor can
 * supply. That is why this takes no `freeFor` callback and `planApproval` does.
 */
export function planPrqApproval(
  lines: readonly { it: string; qty: number }[], appr: readonly number[],
): { lines: ApprovalLine[]; st: "Declined" | "Approved" | "Partially approved" } {
  const out: ApprovalLine[] = lines.map((l, i) => {
    const want = Number.isFinite(appr[i]) ? appr[i] : 0;
    const ok = round3(Math.max(0, Math.min(l.qty, want)));
    return { it: l.it, qty: l.qty, appr: ok, short: round3(l.qty - ok) };
  });
  return { lines: out, st: prqStatus(out) };
}
```

Add to `packages/domain/src/index.ts`:
```ts
export { money, money0, dmy, istDate, unitTotal } from "./format.js";
export { foldClaims, releaseClaim, shortfallClaims, type ClaimSrc } from "./claims.js";
export { checkReceiptLine, receiptStatus, type ReceiptCheckInput, type ReceiptCheckLine } from "./receipt.js";
export { etaFrom, needsApproval, poValue, rateFor } from "./purchasing.js";
export { planPrqApproval, prqStatus } from "./approval.js";
export { PO_TRANSITIONS, REQUISITION_TRANSITIONS } from "./transitions.js";
```
(`PO_TRANSITIONS` and `REQUISITION_TRANSITIONS` go on the existing `./transitions.js` line; `planPrqApproval`/`prqStatus` on the existing `./approval.js` line.)

- [ ] **Step 6: Point the browser at the four words it no longer owns**

**And two converters the browser needs and the server does not.** Global Constraints settle the convention: the store holds dates as display strings, because `applySnapshot` has since Phase 1 and one convention beats two. A `<input type="date">` speaks `YYYY-MM-DD` only, so the buyer's ETA field and the store's contract-validity fields convert at the edge. Both live in `UI/src/lib/fmt.ts` — they are a control's concern, not a rule two sides enforce, so they do not go in `packages/domain`:
```ts
/** "31-Aug-2026" -> "2026-08-31", for an <input type="date">, which speaks nothing else.
 *  Anything already in wire form, or unparseable, comes back unchanged so a blank field
 *  stays blank rather than becoming "NaN-NaN-NaN". */
export const toInputDate = (display: string): string => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(display)) return display;
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(display.trim());
  if (!m) return "";
  const i = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  return i < 0 ? "" : `${m[3]}-${String(i + 1).padStart(2, "0")}-${m[1]}`;
};
/** The way back, for the value a date input hands to a store action. */
export const fromInputDate = (iso: string): string => fromWireDate(iso);
```
with `const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];` local to `fmt.ts`. Add a case to `UI/src/__tests__/api.test.ts` (which already pins `fromWireDate`) — read that file first and follow its shape:
```ts
describe("date controls", () => {
  it("round-trips a display date through an <input type=date> and back", () => {
    expect(toInputDate("31-Aug-2026")).toBe("2026-08-31");
    expect(fromInputDate("2026-08-31")).toBe("31-Aug-2026");
    expect(toInputDate(fromInputDate("2026-01-01"))).toBe("2026-01-01");
  });
  it("leaves a wire date alone and answers empty for anything it cannot read", () => {
    expect(toInputDate("2026-08-31")).toBe("2026-08-31");
    expect(toInputDate("")).toBe("");
    expect(toInputDate("tomorrow")).toBe("");
  });
});
```

`UI/src/lib/fmt.ts`:
1. Replace `money`, `money0` and `fromWireDate`'s bodies with delegates, and `unitTotal` with a delegate that supplies `U`:
```ts
import { bestBeforeText, dmy, money as inr, money0 as inr0, unitTotal as byUnit } from "@rch/domain";
…
export const money = inr;
export const money0 = inr0;
…
/** "2026-08-31" -> "31-Aug-2026". The wording lives in `@rch/domain` because a purchase order's
 *  expected date is printed in the server's toast as well as in this table. */
export const fromWireDate = dmy;
/** Quantities in different units cannot be added (M4). The rule is shared; only the item
 *  master's unit lookup is the browser's. */
export const unitTotal = (lines: { it: string; qty: number }[]): string => byUnit(lines, U);
```
2. Delete the now-unused local `TZ` **only if** `fromWireTime` no longer needs it — it does, so `TZ` stays.
`lakh` still calls `money0` and is unchanged.

- [ ] **Step 7: Run the tests**

Run: `pnpm turbo typecheck test && pnpm lint`
Expected: PASS. `credit.test.ts`, `shelf.test.ts` and `UI/src/__tests__/fixes.test.ts`'s M4 block must all stay green **without being edited** — they are what proves the moved formatters are byte-identical.

- [ ] **Step 8: Commit**

```bash
git add packages/domain UI/src/lib/fmt.ts
git commit -m "$(cat <<'EOF'
Write buying's shared rules once, where both sides can read them

The claim walk a purchase order takes against the requisitions that funded it — last source
first, so a shrink and a re-grow land back where they started. The eight checks a goods receipt
runs, in the order the store keeper reads them, with the 2% tolerance and a date comparison
that is a string comparison because a date with no time in it has no timezone to lose. The
order value and the finance slab. And the money, date and mixed-unit words the server's toasts
now have to speak, moved out of the browser rather than written a second time.

Two transition tables join the three already there. A requisition is decided once; a purchase
order may re-enter Partially received on a second instalment, and may not be cancelled once
anything has arrived.

credit.ts and shelf.ts lose their private formatters to the shared ones (round2 stays — the
credit room still needs it); their own tests pin the sentences and stayed green untouched,
which is the proof the move changed nothing.

And two converters that are a control's concern rather than a rule: the store keeps dates as
display strings, as it has since the first snapshot, so the two date inputs buying adds convert
at the edge instead of a second date convention growing beside the first.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Server scaffolding — six module skeletons, the lock order, the builders, one migration

*(Wave 1, alongside Tasks 1 and 2. It owns `apps/api/**` and nothing else. Task 1 owns `packages/contract/**`; Task 2 owns `packages/domain/**` and `UI/src/lib/fmt.ts`.)*

**Why this is its own task.** Six wave-2 tasks each want a private module directory, and `apps/api/src/modules/index.ts` is one file all six would otherwise edit. `scripts/check-boundaries.sh` fails a module directory missing any of its four files, so the skeletons have to be whole and green before they are useful. The builders and the migration ride along because they are the other two files every wave-2 task reads and none of them may write.

**Files:**
- Create: `apps/api/src/modules/{vendors,requisitions,purchaseorders,grn,contracts,productreqs}/{routes.ts,service.ts,repo.ts,<name>.test.ts}` — 24 files
- Modify: `apps/api/src/modules/index.ts`, `apps/api/src/lib/ledger.ts` (header comment only), `apps/api/src/test/builders.ts`, `apps/api/src/db/schema/master.ts`
- Create: the migration `pnpm --filter @rch/api db:generate` emits — `0006_*`, because the journal ends at `0005_ticket_status_cancelled`

**Interfaces:**
- Produces (consumed by every wave-2 task):
  ```ts
  // apps/api/src/test/builders.ts — added to `given`
  vendor(db, p: { id?; n?; gstin?; groups?; lead?; active? }): Promise<string>;
  requisition(db, p: { id?; by?; st?; note?; lines: { it; qty; appr?; ordered? }[] }): Promise<string>;
  po(db, p: { id?; vendor?; st?; eta?; needsApproval?; lines: { it; qty; rate?; recv?; rejected?; src?: { prq; line; qty }[] }[] }): Promise<string>;
  contract(db, p: { id?; vendorId?; it; rate; from?; to?; moq?; active? }): Promise<string>;
  productRequest(db, p: { id?; name; why?; forLoc?; by?; st? }): Promise<string>;
  ```
- Each module's stub exports `create<Name>Service(db)` and a `<name>Repo` object, registers **no routes**, and its test asserts the factory exists. Wave 2 replaces all four files in its own directory.

- [ ] **Step 1: Write the six skeletons**

For each of `vendors`, `requisitions`, `purchaseorders`, `grn`, `contracts`, `productreqs`, copy `apps/api/src/modules/_template/` and rename. Take `requisitions` as the pattern; the other five are the same with the name changed.

`apps/api/src/modules/requisitions/repo.ts`
```ts
// Requisitions: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import type { Tx } from "../../lib/db.js";

export const requisitionsRepo = {
  /** Placeholder so the skeleton compiles; the module's real reads and writes land next. */
  async ping(_tx: Tx): Promise<void> {},
};
```
`apps/api/src/modules/requisitions/service.ts`
```ts
// Requisitions: the flow — transaction, rules, ids, history. Composes the helpers in
// apps/api/src/lib/; the arithmetic of a decision is `planPrqApproval` in packages/domain.
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { requisitionsRepo } from "./repo.js";

export function createRequisitionsService(db: Db) {
  return {
    /** Placeholder so the skeleton compiles and has something for its test to call. */
    async noop(): Promise<void> {
      await withTransaction(db, (tx) => requisitionsRepo.ping(tx));
    },
  };
}
```
`apps/api/src/modules/requisitions/routes.ts`
```ts
import fp from "fastify-plugin";
import { createRequisitionsService } from "./service.js";

// The store keeper's ask. No route is mounted yet — the manifest entries exist (they are inert
// without a handler) and the endpoints land with their tests in this module's own task.
export default fp(async (app) => {
  createRequisitionsService(app.db);
}, { name: "module:requisitions", dependencies: ["auth", "rbac", "idempotency", "db"] });
```
`apps/api/src/modules/requisitions/requisitions.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { createRequisitionsService } from "./service.js";

describe("requisitions", () => {
  it("compiles and exports a service factory", () => {
    expect(typeof createRequisitionsService).toBe("function");
  });
});
```
Names for the other five: `vendorsRepo`/`createVendorsService`/`module:vendors`, `purchaseOrdersRepo`/`createPurchaseOrdersService`/`module:purchaseorders`, `grnRepo`/`createGrnService`/`module:grn`, `contractsRepo`/`createContractsService`/`module:contracts`, `productReqsRepo`/`createProductReqsService`/`module:productreqs`. Each test file is named after its directory (`vendors.test.ts`, `purchaseorders.test.ts`, `grn.test.ts`, `contracts.test.ts`, `productreqs.test.ts`).

Then `apps/api/src/modules/index.ts` — six imports and six lines, after `production`:
```ts
import requisitions from "./requisitions/routes.js";
import purchaseorders from "./purchaseorders/routes.js";
import grn from "./grn/routes.js";
import vendors from "./vendors/routes.js";
import contracts from "./contracts/routes.js";
import productreqs from "./productreqs/routes.js";
…
  await app.register(requisitions);
  await app.register(purchaseorders);
  await app.register(grn);
  await app.register(vendors);
  await app.register(contracts);
  await app.register(productreqs);
```

- [ ] **Step 2: Write the document lock order into `lib/ledger.ts`'s header**

Extend the file's opening comment — it is where the server-wide order already lives, so the refinement belongs beside it and not in six module comments:
```ts
// The ledger, and the lock order every write in this server keeps.
//
// A write allocates its document id first (`allocateId`, which locks the `sequences` row) and
// posts its moves second (`postMoves`, which locks balance rows) — never the other way round.
// Two writes that need both therefore take those locks in the same sequence, so neither can sit
// holding one while it waits for the other. `modules/pos/service.ts` is written that way; every
// write added after it must be too.
//
// Document rows come before both, and from Phase 5 they have an order of their own: **the
// purchase-order row is locked before any requisition row, and requisition rows are locked in
// ascending requisition_id order** (`foldClaims` in @rch/domain sorts them for you). A purchase
// order and the requisitions it claims against are locked together whenever a claim moves —
// creating, shrinking, removing, cancelling or closing short — and `createPo` is the single
// exception that proves the rule: it locks requisition rows while holding no purchase-order
// lock, which is safe only because it is creating the order and can never afterwards reach for
// an existing one. No cycle exists as long as nothing else does that.
```

- [ ] **Step 3: Write the five builders**

In `apps/api/src/test/builders.ts`, extend the `counters` object to `{ req: 0, tkt: 0, ask: 0, bill: 0, pord: 0, prq: 0, po: 0, vendor: 0, contract: 0, npr: 0 }` and add to `given`:
```ts
  /** A vendor, active unless told otherwise. Ids sit at VN-9NN, above the fixtures' 001–005
   *  and above the sequence's start (6), so a builder-made vendor can collide with neither. */
  async vendor(db: Db, p: { id?: string; n?: string; gstin?: string; groups?: string[]; lead?: number; active?: boolean } = {}): Promise<string> {
    const n = ++counters.vendor;
    const id = p.id ?? `VN-${String(900 + n).padStart(3, "0")}`;
    await db.insert(s.vendors).values({
      id, name: p.n ?? `Test Vendor ${900 + n}`, gstin: p.gstin ?? "33AAACA1234F1Z5",
      contact: "", phone: "", terms: "30 days", leadDays: p.lead ?? 2,
      groups: p.groups ?? ["Grocery"], active: p.active ?? true,
    });
    return id;
  },

  /** A requisition and its lines. `appr` and `ordered` default to nothing decided and nothing
   *  claimed, which is what a freshly sent one looks like. Ids sit at PRQ-2026-9NN. */
  async requisition(db: Db, p: {
    id?: string; by?: string; st?: PrqStatus; note?: string;
    lines: { it: string; qty: number; appr?: number; ordered?: number }[];
  }): Promise<string> {
    const id = p.id ?? `PRQ-2026-${String(900 + ++counters.prq)}`;
    const st = p.st ?? "Sent";
    await db.transaction(async (tx) => {
      await tx.insert(s.requisitions).values({ id, byUser: p.by ?? "u3", status: st, note: p.note ?? "" });
      await tx.insert(s.requisitionLines).values(p.lines.map((l, lineNo) => ({
        requisitionId: id, lineNo, itemKey: l.it, qty: l.qty,
        approvedQty: l.appr ?? 0, orderedQty: l.ordered ?? 0,
        shortQty: l.appr === undefined ? null : round3(l.qty - l.appr),
      })));
      const [author] = await tx.select({ name: s.users.name }).from(s.users).where(eq(s.users.id, p.by ?? "u3"));
      await appendHistory(tx, "requisition", id, "Sent", author?.name ?? p.by ?? "u3");
    });
    return id;
  },

  /** A purchase order, its lines and the sources each line claims against. Ids sit at
   *  PO-2026-09NN, above the fixtures' 0140–0142 and the sequence's start (143). */
  async po(db: Db, p: {
    id?: string; vendor?: string; st?: PoStatus; eta?: string; needsApproval?: boolean;
    lines: { it: string; qty: number; rate?: number; recv?: number; rejected?: number; src?: { prq: string; line: number; qty: number }[] }[];
  }): Promise<string> {
    const id = p.id ?? `PO-2026-${String(900 + ++counters.po).padStart(4, "0")}`;
    const st = p.st ?? "Draft";
    await db.transaction(async (tx) => {
      await tx.insert(s.purchaseOrders).values({
        id, vendorId: p.vendor ?? "VN-001", status: st, eta: p.eta ?? "2026-09-30",
        needsApproval: p.needsApproval ?? false,
      });
      await tx.insert(s.poLines).values(p.lines.map((l, lineNo) => ({
        poId: id, lineNo, itemKey: l.it, qty: l.qty, rate: l.rate ?? 10,
        receivedQty: l.recv ?? 0, rejectedQty: l.rejected ?? 0,
      })));
      const srcs = p.lines.flatMap((l, lineNo) => (l.src ?? []).map((x, seq) => ({
        poId: id, lineNo, seq, requisitionId: x.prq, requisitionLineNo: x.line, qty: x.qty,
      })));
      if (srcs.length) await tx.insert(s.poLineSources).values(srcs);
      await appendHistory(tx, "purchase_order", id, st, "Latha Narayanan");
    });
    return id;
  },

  /** A rate contract, live unless told otherwise. Ids sit at RC-9NN. */
  async contract(db: Db, p: { id?: string; vendorId?: string; it: string; rate: number; from?: string; to?: string; moq?: number; active?: boolean }): Promise<string> {
    const id = p.id ?? `RC-${900 + ++counters.contract}`;
    await db.insert(s.rateContracts).values({
      id, vendorId: p.vendorId ?? "VN-001", itemKey: p.it, rate: p.rate,
      validFrom: p.from ?? "2026-04-01", validTo: p.to ?? "2027-03-31",
      moq: p.moq ?? 0, active: p.active ?? true,
    });
    return id;
  },

  /** A shop's ask for something that is not on the master yet. Ids sit at NPR-09NN. */
  async productRequest(db: Db, p: { id?: string; name: string; why?: string; forLoc?: LocKey; by?: string; st?: ProductReqStatus }): Promise<string> {
    const id = p.id ?? `NPR-${String(900 + ++counters.npr).padStart(4, "0")}`;
    await db.insert(s.productRequests).values({
      id, name: p.name, why: p.why ?? "", forLoc: p.forLoc ?? "coffee",
      byUser: p.by ?? "u2", status: p.st ?? "Requested",
    });
    return id;
  },
```
Add `PoStatus`, `PrqStatus` and `ProductReqStatus` to the file's `@rch/contract` type import and `round3` to its `@rch/domain` import.

Extend `apps/api/src/test/builders.test.ts` with one case per builder asserting the row lands and the id sits in its band — read that file first and follow the shape it already uses for `given.prodOrder`.

- [ ] **Step 4: The one migration**

`apps/api/src/db/schema/master.ts` — `rateContracts` gains an index:
```ts
export const rateContracts = pgTable("rate_contracts", {
  …unchanged columns…
}, (t) => [
  // One live contract per vendor and item. The store's screen checks before it inserts, but a
  // check reads before the insert takes its lock, so two store keepers adding the same contract
  // at once would both pass it. The index is the arbiter: `on conflict do nothing … returning`
  // hands the loser no row, and it reads the same refusal the check would have given it a
  // moment later — the pattern `addMenuItem` already uses (spec §16, Phase 2).
  uniqueIndex("rate_contracts_live_uq").on(t.vendorId, t.itemKey).where(sql`${t.active}`),
]);
```
Run: `pnpm --filter @rch/api db:generate`
It emits **`0006_*`** — the journal ends at idx 5, `0005_ticket_status_cancelled` (Phase 4, merged) — and its whole body is one `CREATE UNIQUE INDEX "rate_contracts_live_uq" ON "rate_contracts" ("vendor_id","item_key") WHERE "rate_contracts"."active";`. Read it before committing it, and check the seed still applies: `seedContracts()` has eight rows, no two of them live for the same vendor and item (RC-108 is `active: false`), so the index takes.

**If what comes out is `0005_*`, stop:** `0005_ticket_status_cancelled` is not in your base. Delete the emitted `.sql`, its `meta/*_snapshot.json` and its journal entry, tell the controller, re-merge the phase branch and run `db:generate` again. **Never renumber a migration by hand.**

Then apply it locally:
```bash
pnpm db:up
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed --force
```

- [ ] **Step 5: Run the tests**

Run: `pnpm turbo typecheck test && pnpm lint`
Expected: PASS, `scripts/check-boundaries.sh` included — each of the six new directories has its four files, and none of them writes a protected table. `knip` must stay quiet: every skeleton's factory is imported by its own `routes.ts` and its own test.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "$(cat <<'EOF'
Stand up buying's six modules, and write down the order their locks are taken in

Six skeletons and six registrations, so each endpoint's own task gets a private directory and
nobody edits modules/index.ts twice. Five builders — a vendor, a requisition, a purchase order
with its sources, a rate contract and a new-product request — each numbered into a band above
the fixtures and above its sequence's start.

The ledger's header gains the document lock order buying needs: the purchase-order row before
any requisition row, requisition rows in ascending id order, and createPo the single exception
that is safe only because it is creating the order it will never afterwards wait for.

One migration: a partial unique index on rate_contracts, so two store keepers adding the same
live contract at once resolve to one deterministic winner instead of a race the pre-check
cannot see.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Reads — six per-collection GETs, and quarantine on the stock screens

*(Wave 2, alongside Tasks 5–9. It owns `apps/api/src/modules/snapshot/**` plus `packages/contract/src/{routes.ts,schemas/snapshot.ts}`. Tasks 5–9 each own their own module directory and touch neither. `packages/contract/src/routes.ts` was last written by Task 1 in wave 1 and is written by nobody else in wave 2.)*

**Why this exists.** `UI/src/api/refetch.ts` falls back to a whole snapshot for any collection with no narrow reader, so every buying write this phase adds would drag the entire working set back. Spec §9.1 already lists `/requisitions`, `/purchase-orders`, `/grns`, `/vendors`, `/contracts` and `/product-requests` among the per-collection GETs, so this implements reads the spec promised. The same task carries quarantine into the snapshot because both changes are `modules/snapshot/**`, and because a store keeper who can receive goods into quarantine but cannot see them there has been sold half a feature.

**Files:**
- Modify: `packages/contract/src/schemas/snapshot.ts`, `packages/contract/src/routes.ts`, `apps/api/src/modules/snapshot/{scope.ts,service.ts,routes.ts,snapshot.test.ts}`, `apps/api/src/modules/snapshot/readers/{master.ts,stock.ts}`, `apps/api/src/lib/master.ts` (one stale comment)

**Interfaces:**
- Consumes: `readRequisitions(db, pre?)`, `readPurchaseOrders(db)`, `readGrns(db, pre?)`, `readVendors(db)`, `readContracts(db)`, `readProductRequests(db, pre?)` from `./readers/documents.js` — **all six already exist and already produce the wire shapes their schemas accept**; `Who` and the `scope*` helpers in `./scope.js`; `StockLocSchema` from `@rch/contract` (Task 1).
- Produces (imported by Task 10):
  ```ts
  // packages/contract/src/schemas/snapshot.ts
  export const RequisitionsResponseSchema    = z.array(D.RequisitionSchema);
  export const PurchaseOrdersResponseSchema  = z.array(D.PurchaseOrderSchema);
  export const GrnsResponseSchema            = z.array(D.GrnSchema);
  export const VendorsResponseSchema         = z.array(D.VendorSchema);
  export const ContractsResponseSchema       = z.array(D.RateContractSchema);
  export const ProductRequestsResponseSchema = z.array(D.ProductRequestSchema);

  // packages/contract/src/routes.ts
  requisitions:    defineRoute({ method: "GET", path: "/requisitions",     access: "any", response: RequisitionsResponseSchema }),
  purchaseOrders:  defineRoute({ method: "GET", path: "/purchase-orders",  access: "any", response: PurchaseOrdersResponseSchema }),
  grns:            defineRoute({ method: "GET", path: "/grns",             access: "any", response: GrnsResponseSchema }),
  vendors:         defineRoute({ method: "GET", path: "/vendors",          access: "any", response: VendorsResponseSchema }),
  contracts:       defineRoute({ method: "GET", path: "/contracts",        access: "any", response: ContractsResponseSchema }),
  productRequests: defineRoute({ method: "GET", path: "/product-requests", access: "any", response: ProductRequestsResponseSchema }),

  // apps/api/src/modules/snapshot/scope.ts
  export const scopeBuying: <T>(rows: T[], who: Who) => T[];
  export const scopeProductRequests: (rows: ProductRequest[], who: Who) => ProductRequest[];

  // apps/api/src/modules/snapshot/service.ts — added to what createSnapshotService returns
  requisitions(claims): Promise<Requisition[]>;   purchaseOrders(claims): Promise<PurchaseOrder[]>;
  grns(claims): Promise<Grn[]>;                   vendors(claims): Promise<Vendor[]>;
  contracts(claims): Promise<RateContract[]>;     productRequests(claims): Promise<ProductRequest[]>;
  ```
- Route keys are `requisitions`, `purchaseOrders`, `grns`, `vendors`, `contracts`, `productRequests`. None collides: the write keys Task 1 added are `createRequisition`, `addVendor`, `addContract`, `createProductRequest` and so on, precisely so these six plain nouns stay free for the reads.
- `access: "any"`, like every other snapshot read: the cut is made in the service by role, not by hiding the route. A counter operator asking for `/vendors` gets `[]`, which is what their snapshot already contains.

**Scoping, taken from `scope()` so there is one definition and not two.** `scope()` currently ends with `prq: [], po: [], grn: [], vendors: [], contracts: [],` — five collections a counter operator simply does not have — and scopes `productReqs` by `p.forLoc === L`. Move both into the two exported helpers and have `scope()` call them, exactly as it already does for `scopeRequests`/`scopeTickets`/`scopeProdOrders`.

**Quarantine, in three lines.** `readers/stock.ts`'s `UI_LOCS` becomes `STOCK_LOCS` and gains `quarantine`; `readers/master.ts`'s `readLocations` stops filtering it out (its comment says "quarantine joins the contract in Phase 5" — this is Phase 5); `scopeStock` is unchanged, because a counter operator is already cut to their own location and quarantine is not it.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/modules/snapshot/snapshot.test.ts`. **Read the top of that file first:** it seeds **once**, in `beforeAll`, and has no `beforeEach` and no truncate — so reuse its `app` and its `getAs(userId, url)` helper and keep every new case a **read**. A case here that wrote something would leak into every case after it.

```ts
describe("the six buying reads", () => {
  const READS = [
    ["requisitions", "prq"], ["purchase-orders", "po"], ["grns", "grn"],
    ["vendors", "vendors"], ["contracts", "contracts"], ["product-requests", "productReqs"],
  ] as const;

  it("hand the buyer exactly what the buyer's snapshot carries", async () => {
    const snap = await getAs("u5", "/api/v1/snapshot");
    for (const [path, slice] of READS) {
      const rows = await getAs("u5", `/api/v1/${path}`);
      expect(rows.map((r: { id: string }) => r.id), path).toEqual(snap[slice].map((r: { id: string }) => r.id));
      expect(rows.length, path).toBeGreaterThan(0);
    }
  });

  it("give a counter operator nothing of buying but the requests their own shop raised", async () => {
    // u1 is the Coffee Shop. The seeded product request was raised for the Coffee Shop, so it
    // is the one buying collection a counter sees anything in.
    for (const [path] of READS.filter(([, s]) => s !== "productReqs")) {
      expect(await getAs("u1", `/api/v1/${path}`), path).toEqual([]);
    }
    const mine = await getAs("u1", "/api/v1/product-requests");
    expect(mine.every((p: { forLoc: string }) => p.forLoc === "coffee")).toBe(true);
    expect(await getAs("u6", "/api/v1/product-requests")).toEqual([]);   // u6 is the Snack Kiosk
  });
});

describe("quarantine", () => {
  it("is a location the store keeper can see, with a shelf of its own", async () => {
    const snap = await getAs("u3", "/api/v1/snapshot");
    expect(snap.locations.quarantine).toMatchObject({ n: "Quarantine", type: "Store" });
    // Empty on the seed — nothing has been rejected — but present, so a screen can read it.
    expect(snap.stock.quarantine).toEqual({});
    expect((await getAs("u3", "/api/v1/stock")).stock.quarantine).toEqual({});
  });

  it("is nowhere in a counter operator's world", async () => {
    const snap = await getAs("u1", "/api/v1/snapshot");
    expect(Object.keys(snap.stock)).toEqual(["coffee"]);
    // Locations are master data and are never cut down — the counter sees the name, and has no
    // route that would let them name it.
    expect(snap.locations.quarantine).toBeDefined();
  });
});
```
Run: `pnpm --filter @rch/api test src/modules/snapshot` → FAIL (404 on all six URLs; `snap.locations.quarantine` is undefined).

- [ ] **Step 2: Declare the six reads**

`packages/contract/src/schemas/snapshot.ts`, beside `ProdOrdersResponseSchema`:
```ts
/** The six buying collections on their own, so a write that names "prq", "po", "grn",
 *  "vendors", "contracts" or "productReqs" refetches its own slice (spec §9.1). */
export const RequisitionsResponseSchema = z.array(D.RequisitionSchema);
export const PurchaseOrdersResponseSchema = z.array(D.PurchaseOrderSchema);
export const GrnsResponseSchema = z.array(D.GrnSchema);
export const VendorsResponseSchema = z.array(D.VendorSchema);
export const ContractsResponseSchema = z.array(D.RateContractSchema);
export const ProductRequestsResponseSchema = z.array(D.ProductRequestSchema);
```
`packages/contract/src/routes.ts`: add the six entries after `batches`, exactly as spelled out in **Interfaces**, adding the six names to the existing `./schemas/snapshot.js` import.

- [ ] **Step 3: Move the scoping into two helpers, and answer with them**

`apps/api/src/modules/snapshot/scope.ts` — add beside `scopeBatches`:
```ts
/** Buying is not a counter operator's business. A requisition, an order, a goods receipt, a
 *  vendor and a rate contract are all read by the store, the kitchen, the manager and the
 *  buyer; a counter sees none of them, which is what their snapshot has always contained. */
export const scopeBuying = <T>(rows: T[], who: Who): T[] => (who.role !== "counter" ? rows : []);
/** The exception: a shop sees what it asked the central store to stock, and only that. */
export const scopeProductRequests = (rows: ProductRequest[], who: Who): ProductRequest[] =>
  who.role !== "counter" ? rows : rows.filter((p) => p.forLoc === who.loc);
```
with `ProductRequest` added to the file's `@rch/contract` type import. Then in `scope()`, replace `productReqs: s.productReqs.filter((p) => p.forLoc === L),` with `productReqs: scopeProductRequests(s.productReqs, who),` and the trailing group line with:
```ts
    prq: scopeBuying(s.prq, who), po: scopeBuying(s.po, who), grn: scopeBuying(s.grn, who),
    vendors: scopeBuying(s.vendors, who), contracts: scopeBuying(s.contracts, who),
```

`apps/api/src/modules/snapshot/service.ts` — beside `batches()`:
```ts
    /** The requisition desk on its own — what a write naming "prq" refetches. */
    async requisitions(claims: AccessClaims): Promise<Requisition[]> { return scopeBuying(await D.readRequisitions(db), claims); },
    async purchaseOrders(claims: AccessClaims): Promise<PurchaseOrder[]> { return scopeBuying(await D.readPurchaseOrders(db), claims); },
    async grns(claims: AccessClaims): Promise<Grn[]> { return scopeBuying(await D.readGrns(db), claims); },
    async vendors(claims: AccessClaims): Promise<Vendor[]> { return scopeBuying(await D.readVendors(db), claims); },
    async contracts(claims: AccessClaims): Promise<RateContract[]> { return scopeBuying(await D.readContracts(db), claims); },
    /** A shop sees the new-product asks it raised itself; everyone else sees the queue. */
    async productRequests(claims: AccessClaims): Promise<ProductRequest[]> { return scopeProductRequests(await D.readProductRequests(db), claims); },
```
adding the six document types to the file's `@rch/contract` type import and `scopeBuying`, `scopeProductRequests` to its `./scope.js` import.

`apps/api/src/modules/snapshot/routes.ts` — six more mounts under the existing seven:
```ts
  // Buying's six, each answering for one slice a write can name in `changed` (spec §9.1).
  mount(app, routes.requisitions, async (req) => svc.requisitions(req.user));
  mount(app, routes.purchaseOrders, async (req) => svc.purchaseOrders(req.user));
  mount(app, routes.grns, async (req) => svc.grns(req.user));
  mount(app, routes.vendors, async (req) => svc.vendors(req.user));
  mount(app, routes.contracts, async (req) => svc.contracts(req.user));
  mount(app, routes.productRequests, async (req) => svc.productRequests(req.user));
```

- [ ] **Step 4: Let quarantine through**

`apps/api/src/modules/snapshot/readers/stock.ts`:
```ts
import type { StockLoc } from "@rch/contract";
…
/** Every location stock is reported for, quarantine included: a store keeper has to see what a
 *  goods receipt rejected. Nothing is sold, issued or transferred from there — `LocKey`, which
 *  every write body is typed against, still has five members. */
const STOCK_LOCS: StockLoc[] = ["store", "kitchen", "rest", "coffee", "kiosk", "quarantine"];

export async function readStock(db: Db): Promise<Record<StockLoc, Record<string, number>>> {
  const rows = await db.select().from(stockBalances);
  const out = Object.fromEntries(STOCK_LOCS.map((l) => [l, {} as Record<string, number>])) as Record<StockLoc, Record<string, number>>;
  for (const r of rows) if ((STOCK_LOCS as string[]).includes(r.loc)) out[r.loc as StockLoc][r.itemKey] = r.onHand;
  return out;
}
```
`apps/api/src/modules/snapshot/readers/master.ts` — delete the filter and the comment that promised it, keeping the import (the assignment below is what needs it):
```ts
/** Every location the hospital has, quarantine included: the store's screens name it, and
 *  `LocationSchema` is keyed by a plain string, so nothing about the wire shape changes. */
export const readLocations = loadLocations;
```
`loadLocations` stays on the `../../../lib/master.js` import line — it is now this file's only use of it, but it is a use.

And one comment two files away goes stale with this change: `apps/api/src/lib/master.ts`'s header says the reader that feeds the UI is the one that cuts quarantine out. It no longer does. Correct that sentence in the same commit — one line, and the only edit this task makes outside `modules/snapshot/**`; add `apps/api/src/lib/master.ts` to the Files block.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @rch/api test src/modules/snapshot src/contract.test.ts` → PASS, including `contract.test.ts`'s six new named cases, which probe all six URLs as the outlet manager and parse the bodies against the declared schemas.
Then the whole gate: `pnpm turbo typecheck test && pnpm lint`.

- [ ] **Step 6: Commit**

```bash
git add packages/contract apps/api/src/modules/snapshot
git commit -m "$(cat <<'EOF'
Serve buying's six collections on their own, and put quarantine on the shelf

Spec §9.1 promised all six as per-collection reads; a write that names prq, po, grn, vendors,
contracts or productReqs can now refetch that slice instead of dragging the whole working set
back. The counter's cut moves into two helpers so the standalone read and the snapshot cannot
disagree about it.

And quarantine stops being invisible: the stock reader carries it, the locations reader stops
filtering it out, and a store keeper can see what a goods receipt turned away. A counter
operator's snapshot is unchanged — it was already cut to their own location.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `requisitions` — the store keeper asks, the buyer decides

*(Wave 2, alongside Tasks 4 and 6–9. It owns `apps/api/src/modules/requisitions/**` and nothing else — the skeleton's four files exist from Task 3 and `modules/index.ts` already registers it, so there is no shared registration line to edit.)*

**Files:**
- Modify: `apps/api/src/modules/requisitions/{repo.ts,service.ts,routes.ts,requisitions.test.ts}`

**Interfaces:**
- Consumes, all already exported and all with these exact signatures:
  - `mount` from `../../routes.js`; `withTransaction(db, fn)` and `type Tx` from `../../lib/db.js`
  - `assertRule(cond, message, details?): asserts cond` and `assertTransition(table, from, to, what)` from `../../lib/rules.js`
  - `NotFoundError` from `../../lib/errors.js`; `emitChanged(tx, changed)` from `../../lib/events.js`
  - `appendHistory(tx, docType, docId, status, who, at?)` from `../../lib/history.js`; `allocateId(tx, kind, at?)` from `../../lib/ids.js` — **the kind is `"prq"`** (`SEQUENCE_START.prq` is 16, `formatId` renders `PRQ-<yyyy>-0<n>`)
  - `loadMaster(db | tx)` from `../../lib/master.js`; `iso(d)` from `../../lib/time.js`
  - `planPrqApproval`, `round3` from `@rch/domain`; `REQUISITION_TRANSITIONS` from `@rch/domain` (Task 2)
  - `given.requisition(db, {...})` from `../../test/builders.js`, `warmPool(t, n)` from `../../test/db.js`, in the test
- Produces:
  ```ts
  // apps/api/src/modules/requisitions/repo.ts
  export const requisitionsRepo = {
    head(tx, id): Promise<RequisitionRow | undefined>;                 // for update
    lines(tx, id): Promise<{ it: string; qty: number; appr: number; ordered: number }[]>;
    insert(tx, row: NewRequisition): Promise<void>;
    insertLines(tx, id, lines: readonly { it: string; qty: number }[]): Promise<void>;
    setDecision(tx, id, patch: { status: PrqStatus; approvalNote: string; approvedBy: string }): Promise<void>;
    setLineApprovals(tx, id, lines: readonly { appr: number; short: number }[]): Promise<void>;
    userName(tx, id): Promise<string>;
    wire(tx, id): Promise<Requisition>;
  };
  // apps/api/src/modules/requisitions/service.ts
  createRequisitionsService(db) => { create, approve, decline }
  ```

**Read documents back through `GET /snapshot`, not through the six new GETs.** `GET /requisitions`, `/purchase-orders`, `/grns`, `/vendors`, `/contracts` and `/product-requests` are **Task 4's, and Task 4 is in this same wave** — none of them exists when this worktree runs its gate, so a helper that calls one 404s and takes the whole suite with it. Read `GET /snapshot` (Phase 1, always there) and pick the slice: `.prq`, `.po`, `.grn`, `.vendors`, `.contracts`, `.productReqs`. The six standalone reads are asserted in Task 4's own suite and nowhere else.

**Rules, verbatim (spec §9.2's `sendRequisition`, `approveRequisition` and `declineRequisition` rows). Every message below except the four marked NEW is the store's current `notify()` text, character for character:**

| Endpoint | Rules, in this order | Message |
|---|---|---|
| `POST /requisitions` (store) | every item exists (404 `There is no item <key>.`); `assertRule(lines.every(l => l.qty > 0), "Add at least one line before sending")`; **NEW** a repeated item is refused — `` `Combine the ${item.n} lines into one` ``; `allocateId(tx, "prq", at)`; insert with status `Sent`; history row `Sent` | `` `${id} sent to procurement` `` |
| `POST /requisitions/:id/approve` (buyer) | requisition exists, read `for update` (404 `There is no requisition <id>.`); **NEW** `assertRule(body.appr.length === lines.length, \`Give a quantity for each of the ${lines.length} lines\`)`; `planPrqApproval(lines, appr)`; when the plan is `Declined` and the note is blank, `"Give a reason — the store keeper sees it on the requisition"`; `assertTransition(REQUISITION_TRANSITIONS, r.status, plan.st, id)`; write the line approvals with `ordered_qty` **left exactly as it is**; set the decision | declined: `` `${id} declined — nothing goes on the procurement list` ``<br>otherwise: `` `${id} ${st.toLowerCase()} — ${n} line(s) on the procurement list` `` where `n` counts lines with `appr > 0` |
| `POST /requisitions/:id/decline` (buyer) | requisition exists, read `for update`; `assertRule(body.note.trim().length > 0, "Give a reason — the store keeper sees it on the requisition")`; `assertTransition(…, "Declined", id)`; every line `appr = 0`, `short = qty`; set the decision | `` `${id} declined` `` |

`changed` is `["prq"]` for all three, emitted with `await emitChanged(tx, changed)` inside the transaction.

**Two notes the implementer needs.**

*`ordered_qty` is never touched here.* A decision writes `approved_qty` and `short_qty`; the claim is the purchase order's business (Task 6) and the procurement list is `approved − ordered`, derived. A decision that reset `ordered_qty` would hand a claimed quantity back to the pool while a live order still held it.

*Why `assertTransition` and not a hand-written guard.* Unlike the kitchen's board, `<id> is already <status>` reads correctly here for every case the table refuses — a second decision on a requisition already `Approved`, `Partially approved` or `Declined`. The Phase 4 objection (a `New` order asked to jump to `Ready`) has no analogue: `Sent` is the only source.

- [ ] **Step 1: Write the failing tests**

Replace `apps/api/src/modules/requisitions/requisitions.test.ts` (Task 3's skeleton test goes with it — the real endpoints prove the factory exists far better):
```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { truncateAll, warmPool } from "../../test/db.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "requisitions" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const post = async (u: string, url: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: await hdr(u), payload });
/** The requisition desk, off `GET /snapshot` — `GET /requisitions` is Task 4's and lands in
 *  this same wave, so nothing here may depend on it. */
const list = async (u = "u5") => (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, u) })).json().prq;
const one = async (id: string) => (await list()).find((p: { id: string }) => p.id === id);

describe("POST /requisitions", () => {
  it("sends the store keeper's ask to procurement and signs it", async () => {
    const r = await post("u3", "/requisitions", { lines: [{ it: "milk", qty: 60 }, { it: "butter", qty: 6 }], note: "Weekly dairy" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ st: "Sent", note: "Weekly dairy", by: "Suresh Muthu" });
    expect(b.result.id).toMatch(/^PRQ-\d{4}-0\d+$/);
    expect(b.result.lines).toEqual([
      { it: "milk", qty: 60, appr: 0, ordered: 0 },
      { it: "butter", qty: 6, appr: 0, ordered: 0 },
    ]);
    expect(b.result.hist.at(-1)).toMatchObject({ s: "Sent", who: "Suresh Muthu" });
    expect(b.changed).toEqual(["prq"]);
    expect(b.message).toBe(`${b.result.id} sent to procurement`);
  });

  it("refuses an empty ask, and one with a zero on it", async () => {
    expect((await post("u3", "/requisitions", { lines: [{ it: "milk", qty: 0 }] })).json().error.message)
      .toBe("Add at least one line before sending");
    expect((await post("u3", "/requisitions", { lines: [] })).statusCode).toBe(400);   // the schema's own floor
  });

  it("refuses the same item twice rather than deciding it twice", async () => {
    const r = await post("u3", "/requisitions", { lines: [{ it: "milk", qty: 20 }, { it: "milk", qty: 40 }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Combine the Milk 1L (toned) lines into one");
  });

  it("404s an unknown item, and is absent for every other role", async () => {
    expect((await post("u3", "/requisitions", { lines: [{ it: "totally-fake", qty: 1 }] })).json().error.message)
      .toBe("There is no item totally-fake.");
    for (const u of ["u1", "u2", "u4", "u5"]) {
      expect((await post(u, "/requisitions", { lines: [{ it: "milk", qty: 1 }] })).statusCode).toBe(404);
    }
  });
});

describe("POST /requisitions/:id/approve", () => {
  it("approves every line in full and puts them on the procurement list", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }, { it: "butter", qty: 6 }] });
    const r = await post("u5", `/requisitions/${id}/approve`, { appr: [60, 6], note: "Approved in full." });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.st).toBe("Approved");
    expect(b.result.lines.map((l: { appr: number; ordered: number }) => [l.appr, l.ordered])).toEqual([[60, 0], [6, 0]]);
    expect(b.result.apprBy).toBe("Latha Narayanan");
    expect(b.message).toBe(`${id} approved — 2 line(s) on the procurement list`);
  });

  it("never approves more than was asked, and records the shortfall", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }, { it: "butter", qty: 6 }] });
    const b = (await post("u5", `/requisitions/${id}/approve`, { appr: [999, 4], note: "" })).json();
    expect(b.result.st).toBe("Partially approved");
    expect(b.result.lines[0]).toMatchObject({ appr: 60, short: 0 });
    expect(b.result.lines[1]).toMatchObject({ appr: 4, short: 2 });
    expect(b.message).toBe(`${id} partially approved — 2 line(s) on the procurement list`);
  });

  it("leaves a claim a live order already holds exactly where it is", async () => {
    // A requisition can be re-decided only once, so this is about the write, not a second pass:
    // approving must not touch ordered_qty, or a claimed quantity would reappear on the list.
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60, ordered: 25 }] });
    const b = (await post("u5", `/requisitions/${id}/approve`, { appr: [60], note: "" })).json();
    expect(b.result.lines[0]).toMatchObject({ appr: 60, ordered: 25 });
  });

  it("treats an all-zero approval as a decline, and wants a reason for it", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }] });
    const bare = await post("u5", `/requisitions/${id}/approve`, { appr: [0], note: "  " });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().error.message).toBe("Give a reason — the store keeper sees it on the requisition");
    expect((await one(id)).st).toBe("Sent");

    const b = (await post("u5", `/requisitions/${id}/approve`, { appr: [0], note: "Vendor cannot supply" })).json();
    expect(b.result.st).toBe("Declined");
    expect(b.result.lines[0]).toMatchObject({ appr: 0, short: 60 });
    expect(b.message).toBe(`${id} declined — nothing goes on the procurement list`);
  });

  it("refuses a decision that does not cover every line", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }, { it: "butter", qty: 6 }] });
    const r = await post("u5", `/requisitions/${id}/approve`, { appr: [60], note: "" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Give a quantity for each of the 2 lines");
  });

  it("decides once, however many screens press together", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }] });
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u5", `/requisitions/${id}/approve`, { appr: [60], note: "" }),
      post("u5", `/requisitions/${id}/approve`, { appr: [30], note: "" }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
    expect((await one(id)).hist.filter((h: { s: string }) => h.s !== "Sent")).toHaveLength(1);
  });

  it("404s a requisition that is not there, and is absent for every other role", async () => {
    expect((await post("u5", "/requisitions/PRQ-2026-999/approve", { appr: [1], note: "" })).json().error.message)
      .toBe("There is no requisition PRQ-2026-999.");
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 1 }] });
    for (const u of ["u1", "u2", "u3", "u4"]) {
      expect((await post(u, `/requisitions/${id}/approve`, { appr: [1], note: "" })).statusCode).toBe(404);
    }
  });
});

describe("POST /requisitions/:id/decline", () => {
  it("declines with a reason, and every line's shortfall is the whole ask", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }, { it: "butter", qty: 6 }] });
    const b = (await post("u5", `/requisitions/${id}/decline`, { note: "Vendor cannot supply this week" })).json();
    expect(b.result.st).toBe("Declined");
    expect(b.result.lines.map((l: { appr: number; short: number }) => [l.appr, l.short])).toEqual([[0, 60], [0, 6]]);
    expect(b.result.apprNote).toBe("Vendor cannot supply this week");
    expect(b.message).toBe(`${id} declined`);
  });

  it("will not decline without one, and will not decide twice", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }] });
    expect((await post("u5", `/requisitions/${id}/decline`, { note: "   " })).json().error.message)
      .toBe("Give a reason — the store keeper sees it on the requisition");
    await post("u5", `/requisitions/${id}/decline`, { note: "No" });
    const again = await post("u5", `/requisitions/${id}/decline`, { note: "No" });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe(`${id} is already declined`);
  });
});
```
**Do not add `truncateAll` or an `afterEach` between cases** — the suite seeds once in `beforeAll` and each case builds its own requisition with `given.requisition`, exactly like `requests.test.ts`. Drop `afterEach` from the vitest import.

Run: `pnpm --filter @rch/api test src/modules/requisitions` → FAIL (404 on all three URLs).

**Prove the race case before you keep it.** With `warmPool` commented out, the two approvals must still resolve 1/1 (that is the trap the constraint exists for — if they do, the pool was already warm and the case is honest either way). With the `.for("update")` removed from `requisitionsRepo.head`, both must return 200 and the requisition must carry two decision history rows. Restore both, and only then move on.

- [ ] **Step 2: Write the repo**

`apps/api/src/modules/requisitions/repo.ts` — replace the skeleton wholesale. Model it on `apps/api/src/modules/requests/repo.ts`, which is the same document one layer up:
```ts
// Requisitions: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { PrqStatus, Requisition } from "@rch/contract";
import type { Tx } from "../../lib/db.js";
import { readHistory } from "../../lib/history.js";
import { iso } from "../../lib/time.js";
import { requisitionLines, requisitions, users } from "../../db/schema/index.js";

export type RequisitionRow = typeof requisitions.$inferSelect;
export type NewRequisition = typeof requisitions.$inferInsert;
export type RequisitionLine = { it: string; qty: number; appr: number; ordered: number };

const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export const requisitionsRepo = {
  /** The head, read **for update**: two buyers deciding the same requisition queue on this line
   *  and the second reads the status the first committed, not the one they both started from. */
  async head(tx: Tx, id: string): Promise<RequisitionRow | undefined> {
    const [r] = await tx.select().from(requisitions).where(eq(requisitions.id, id)).for("update");
    return r;
  },

  async lines(tx: Tx, id: string): Promise<RequisitionLine[]> {
    const rows = await tx.select().from(requisitionLines)
      .where(eq(requisitionLines.requisitionId, id)).orderBy(asc(requisitionLines.lineNo));
    return rows.map((l) => ({ it: l.itemKey, qty: l.qty, appr: l.approvedQty, ordered: l.orderedQty }));
  },

  async insert(tx: Tx, row: NewRequisition): Promise<void> { await tx.insert(requisitions).values(row); },

  /** Line numbers are the order the store keeper typed them, and every reader sorts on them. */
  async insertLines(tx: Tx, id: string, lines: readonly { it: string; qty: number }[]): Promise<void> {
    if (lines.length === 0) return;
    await tx.insert(requisitionLines).values(lines.map((l, lineNo) => ({ requisitionId: id, lineNo, itemKey: l.it, qty: l.qty })));
  },

  async setDecision(tx: Tx, id: string, patch: { status: PrqStatus; approvalNote: string; approvedBy: string }): Promise<void> {
    await tx.update(requisitions).set({ ...patch, updatedAt: new Date() }).where(eq(requisitions.id, id));
  },

  /** The decision, line by line, in the order `lines()` handed them out. `ordered_qty` is not in
   *  the patch on purpose: the claim belongs to the purchase orders, not to the decision. */
  async setLineApprovals(tx: Tx, id: string, lines: readonly { appr: number; short: number }[]): Promise<void> {
    for (const [lineNo, l] of lines.entries()) {
      await tx.update(requisitionLines).set({ approvedQty: l.appr, shortQty: l.short })
        .where(and(eq(requisitionLines.requisitionId, id), eq(requisitionLines.lineNo, lineNo)));
    }
  },

  /** History is signed with a name, not an id: it is read on a screen. */
  async userName(tx: Tx, id: string): Promise<string> {
    const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name ?? id;
  },

  /** One requisition in the shape the snapshot hands out, for a service that just changed it. */
  async wire(tx: Tx, id: string): Promise<Requisition> {
    const [r] = await tx.select().from(requisitions).where(eq(requisitions.id, id));
    if (!r) throw new Error(`requisition ${id} disappeared inside its own transaction`);
    const lines = await tx.select().from(requisitionLines)
      .where(eq(requisitionLines.requisitionId, id)).orderBy(asc(requisitionLines.lineNo));
    const hist = await readHistory(tx, "requisition", id);
    const who = [r.byUser, ...(r.approvedBy ? [r.approvedBy] : [])];
    const names = new Map((await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, who))).map((u) => [u.id, u.name]));
    return strip({
      id: r.id, by: names.get(r.byUser) ?? r.byUser, at: iso(r.at),
      lines: lines.map((l) => strip({ it: l.itemKey, qty: l.qty, appr: l.approvedQty, ordered: l.orderedQty, short: l.shortQty ?? undefined })),
      st: r.status, note: r.note,
      apprBy: r.approvedBy ? names.get(r.approvedBy) ?? r.approvedBy : undefined,
      apprNote: r.approvalNote ?? undefined, hist,
    });
  },
};
```

- [ ] **Step 3: Write the service**

`apps/api/src/modules/requisitions/service.ts`:
```ts
// Requisitions: the flow — transaction, rules, ids, history. Composes the helpers in
// apps/api/src/lib/; the arithmetic of a decision is `planPrqApproval` in packages/domain.
//
// Nothing here touches stock or `ordered_qty`. A requisition records what the central store
// wants bought; the claim a purchase order puts on it, and the goods that eventually arrive,
// are the purchase-order and goods-receipt modules' business.
import type { z } from "zod";
import type {
  ApproveRequisitionBodySchema, CreateRequisitionBodySchema, DeclineRequisitionBodySchema,
  Requisition, WriteResponse,
} from "@rch/contract";
import { planPrqApproval, REQUISITION_TRANSITIONS, round3 } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { allocateId } from "../../lib/ids.js";
import { loadMaster } from "../../lib/master.js";
import { assertRule, assertTransition } from "../../lib/rules.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { requisitionsRepo } from "./repo.js";

export type CreateRequisitionBody = z.infer<typeof CreateRequisitionBodySchema>;
export type ApproveRequisitionBody = z.infer<typeof ApproveRequisitionBodySchema>;
export type DeclineRequisitionBody = z.infer<typeof DeclineRequisitionBodySchema>;

const REASON = "Give a reason — the store keeper sees it on the requisition";

export function createRequisitionsService(db: Db) {
  return {
    /** The central store's ask, in one transaction. */
    async create(claims: AccessClaims, body: CreateRequisitionBody): Promise<WriteResponse<Requisition>> {
      return withTransaction(db, async (tx) => {
        const master = await loadMaster(tx);
        for (const l of body.lines) if (!master.items[l.it]) throw new NotFoundError(`There is no item ${l.it}.`);
        assertRule(body.lines.every((l) => l.qty > 0), "Add at least one line before sending");
        // One item, one line — the same rule `POST /requests` keeps, and for the same reason:
        // two lines of one item would be decided twice, claimed twice and received twice, and
        // the store keeper can still fix it on the draft screen.
        const repeated = body.lines.find((l, i) => body.lines.findIndex((x) => x.it === l.it) !== i);
        if (repeated) assertRule(false, `Combine the ${master.items[repeated.it]!.n} lines into one`);

        const at = new Date();
        const id = await allocateId(tx, "prq", at);
        await requisitionsRepo.insert(tx, { id, byUser: claims.sub, at, status: "Sent", note: body.note });
        await requisitionsRepo.insertLines(tx, id, body.lines.map((l) => ({ it: l.it, qty: round3(l.qty) })));
        const who = await requisitionsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "requisition", id, "Sent", who, at);

        const changed = ["prq"] as const;
        await emitChanged(tx, changed);
        return { result: await requisitionsRepo.wire(tx, id), changed: [...changed], message: `${id} sent to procurement` };
      });
    },

    /**
     * The buyer's decision. Never more than the store keeper asked for and never more than the
     * buyer typed — and never netted against the central store's own shelf, which has nothing to
     * do with what a vendor can supply. `ordered_qty` is untouched: the procurement list is
     * approved less ordered, and a decision that reset the claim would hand a live order's
     * quantity back to the list.
     */
    async approve(claims: AccessClaims, id: string, body: ApproveRequisitionBody): Promise<WriteResponse<Requisition>> {
      return withTransaction(db, async (tx) => {
        const p = await requisitionsRepo.head(tx, id);
        if (!p) throw new NotFoundError(`There is no requisition ${id}.`);
        const lines = await requisitionsRepo.lines(tx, id);
        // One decision per line, positionally: a short array silently declines the lines it does
        // not reach, which is not a decision the buyer necessarily meant to make (spec §16).
        assertRule(body.appr.length === lines.length, `Give a quantity for each of the ${lines.length} lines`);
        const plan = planPrqApproval(lines, body.appr);
        // Zeroing every line is a decline in all but name, and a decline always carries a reason.
        if (plan.st === "Declined") assertRule(body.note.trim().length > 0, REASON);
        // Guard on what will actually be written: all three outcomes hang off "Sent", so a
        // requisition already decided is refused whichever way this one would have gone.
        assertTransition(REQUISITION_TRANSITIONS, p.status, plan.st, id);

        await requisitionsRepo.setLineApprovals(tx, id, plan.lines);
        await requisitionsRepo.setDecision(tx, id, { status: plan.st, approvalNote: body.note, approvedBy: claims.sub });
        const who = await requisitionsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "requisition", id, plan.st, who);

        const changed = ["prq"] as const;
        await emitChanged(tx, changed);
        const n = plan.lines.filter((l) => l.appr > 0).length;
        const message = plan.st === "Declined"
          ? `${id} declined — nothing goes on the procurement list`
          : `${id} ${plan.st.toLowerCase()} — ${n} line(s) on the procurement list`;
        return { result: await requisitionsRepo.wire(tx, id), changed: [...changed], message };
      });
    },

    /** A plain refusal. It approves nothing, so every line's shortfall is the full ask — the
     *  same rows an all-zero approval writes. */
    async decline(claims: AccessClaims, id: string, body: DeclineRequisitionBody): Promise<WriteResponse<Requisition>> {
      return withTransaction(db, async (tx) => {
        const p = await requisitionsRepo.head(tx, id);
        if (!p) throw new NotFoundError(`There is no requisition ${id}.`);
        assertRule(body.note.trim().length > 0, REASON);
        assertTransition(REQUISITION_TRANSITIONS, p.status, "Declined", id);
        const lines = await requisitionsRepo.lines(tx, id);
        await requisitionsRepo.setLineApprovals(tx, id, lines.map((l) => ({ appr: 0, short: l.qty })));
        await requisitionsRepo.setDecision(tx, id, { status: "Declined", approvalNote: body.note, approvedBy: claims.sub });
        const who = await requisitionsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "requisition", id, "Declined", who);

        const changed = ["prq"] as const;
        await emitChanged(tx, changed);
        return { result: await requisitionsRepo.wire(tx, id), changed: [...changed], message: `${id} declined` };
      });
    },
  };
}
```

- [ ] **Step 4: Mount them**

`apps/api/src/modules/requisitions/routes.ts`:
```ts
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createRequisitionsService } from "./service.js";

// The central store asks and procurement decides. Neither is location-scoped: there is one
// central store and one buyer, and every requisition is raised against the same shelf.
export default fp(async (app) => {
  const svc = createRequisitionsService(app.db);
  mount(app, routes.createRequisition, async (req) => svc.create(req.user, req.body));
  mount(app, routes.approveRequisition, async (req) => svc.approve(req.user, req.params.id, req.body));
  mount(app, routes.declineRequisition, async (req) => svc.decline(req.user, req.params.id, req.body));
}, { name: "module:requisitions", dependencies: ["auth", "rbac", "idempotency", "db"] });
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @rch/api test src/modules/requisitions` → PASS.
Then `pnpm turbo typecheck test && pnpm lint`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/requisitions
git commit -m "$(cat <<'EOF'
Put the requisition and its decision on the server

The store keeper's ask, numbered from the sequence and signed into document history, and the
buyer's answer to it: never more than was asked for, never more than was typed, and — unlike a
stock request — never netted against the central store's own shelf, because what the store is
holding has nothing to do with what a vendor can supply.

A decision writes approved and short and leaves ordered exactly as it found it. The procurement
list is approved less ordered, so a decision that reset the claim would put a live purchase
order's quantity back on the list for someone to order a second time.

Replaces the in-memory approveRequisition, declineRequisition and sendRequisition rules pinned
by UI/src/__tests__/procurement.test.ts's "requisition approval" and "sending a requisition"
blocks, which move here in the UI cutover.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `purchaseorders` — a draft, its claim, and the order that goes out

*(Wave 2, alongside Tasks 4, 5 and 7–9. It owns `apps/api/src/modules/purchaseorders/**` and nothing else. Task 7 owns `apps/api/src/modules/grn/**`, which writes the same two tables through **different columns** — see the note below.)*

**Why receipt is not in this module.** `grn` (Task 7) owns `POST /purchase-orders/:id/receive` and `/close-short` because it is this phase's only ledger-writing path, it carries a different role list (`buyer, store` against this module's `buyer`), and it owns the `grns` table and GRN numbering. The two modules split `po_lines` by column: **this module writes `qty`, `rate` and the line's sources and never `received_qty`/`rejected_qty`; `grn` writes `received_qty`/`rejected_qty` and never `qty`, `rate` or a source.** Each writes the PO's `status`, under the same `head(tx, id)` lock. Both also give claims back to `requisition_lines.ordered_qty` — `cancel` here, `close-short` there — so each carries its own `lockRequisitions`/`addOrdered` pair, about fifteen lines of SQL written twice. That duplication is deliberate and is the smaller cost: the *arithmetic* is written once, in `@rch/domain`'s `claims.ts`, and cross-importing another module's repo is the boundary Phase 4 declined to cross when `tickets/repo.ts` grew `setProdOrderStatus` rather than reaching into the production module's.

**Files:**
- Modify: `apps/api/src/modules/purchaseorders/{repo.ts,service.ts,routes.ts,purchaseorders.test.ts}`

**Interfaces:**
- Consumes: `mount`; `withTransaction`, `type Tx`; `assertRule`, `assertTransition`; `NotFoundError`; `emitChanged`; `appendHistory`; `allocateId` (**kind `"po"`** — `SEQUENCE_START.po` is 143, `formatId` renders `PO-<yyyy>-0<n>`); `loadMaster`; `iso`; and from `@rch/domain`: `dmy`, `etaFrom`, `foldClaims`, `fq`, `money0`, `needsApproval`, `poValue`, `PO_TRANSITIONS`, `rateFor`, `releaseClaim`, `round3`, `type ClaimSrc`. `PO_APPROVAL_LIMIT` comes from `@rch/contract`.
- Produces:
  ```ts
  // apps/api/src/modules/purchaseorders/repo.ts
  export const purchaseOrdersRepo = {
    head(tx, id): Promise<PoRow | undefined>;                     // for update
    lines(tx, id): Promise<PoLineRow[]>;                          // ordered by line_no
    sources(tx, id): Promise<Map<number, ClaimSrc[]>>;            // line_no -> sources, by seq
    vendor(tx, id): Promise<VendorRow | undefined>;
    /** `for update` on the named requisitions, ascending id — the phase's document lock order. */
    lockRequisitions(tx, ids: readonly string[]): Promise<void>;
    prqLines(tx, ids: readonly string[]): Promise<Map<string, { status: PrqStatus; lines: { it: string; appr: number; ordered: number }[] }>>;
    addOrdered(tx, deltas: readonly ClaimSrc[], sign: 1 | -1): Promise<void>;
    insert(tx, row: NewPo): Promise<void>;
    writeLines(tx, id, lines: readonly { it: string; qty: number; rate: number; src: ClaimSrc[] }[]): Promise<void>;
    setStatus(tx, id, patch: { status?: PoStatus; shortNote?: string; needsApproval?: boolean; eta?: string; vendorId?: string; at?: Date }): Promise<void>;
    userName(tx, id): Promise<string>;
    activeContractRates(tx, vendorId: string, itemKeys: readonly string[], on: string): Promise<Record<string, number>>;
    wire(tx, id): Promise<PurchaseOrder>;
  };
  // apps/api/src/modules/purchaseorders/service.ts
  createPurchaseOrdersService(db) => { create, updateLine, removeLine, patch, send, cancel }
  ```

**`writeLines` replaces, it does not patch.** A draft's lines and their sources are rewritten wholesale on every structural change — `delete from po_lines where po_id = ?`, the same for `po_line_sources`, then one insert of each. It keeps `line_no` equal to the array index the wire shape carries (`readPurchaseOrders` builds `lines` by ordering on `line_no`), which is what `PATCH /purchase-orders/:id/lines/:n` addresses and what `grns.po_line_no` points at. Shifting numbers in place with `line_no = line_no - 1` would need a deferrable unique constraint to be safe; a delete-and-reinsert under the order's own row lock needs nothing. Only a `Draft` ever reaches it, and a Draft has no goods receipts pointing at its lines.

**Rules, verbatim. Every message except the eight marked NEW is the store's current `notify()` text, character for character:**

| Endpoint | Rules, in this order | Message |
|---|---|---|
| `POST /purchase-orders` (buyer) | `assertRule(picks.length > 0, "Pick at least one line before raising an order")`; vendor exists → `assertRule(v, "Choose a vendor for this order")`; `assertRule(v.active, \`${v.n} is inactive — reactivate it or choose another vendor\`)`; `assertRule(picks.every(p => p.qty > 0), "Enter a quantity on every line you pick")`; **lock** every named requisition, ascending id; each named requisition and line exists (404 `There is no line <n> on <prq>.`); picks folded per `(prq, line)` and the total checked against pending — `` `${name} — only ${fq(pending, unit)} still pending on ${prq}` ``; `allocateId(tx, "po", at)`; picks merged by item into lines, rate `rateFor(contract, item.cost)`, eta `etaFrom(at, v.leadDays)`, status `Draft`; `addOrdered(+1)`; history `Draft` | `` `${id} drafted on ${v.n} — ${n} line(s), review the rates before sending` `` |
| `PATCH …/:id/lines/:n` (buyer) | order exists, `for update` (404); **NEW** `assertRule(o.status === "Draft", \`${id} is ${st.toLowerCase()} — only a draft can be changed\`)`; line exists (404 `There is no line <n> on <id>.`); **NEW** `assertRule(body.qty !== undefined \|\| body.rate !== undefined, "Nothing to change on this line")`; a rate-only patch writes the rate and stops; **NEW** `assertRule(qty > 0, "Enter a quantity, or remove the line")`; `assertRule(qty <= line.qty, "Add another pick from the procurement list to increase this line")`; `releaseClaim(line.src, line.qty − qty)` → lock those requisitions, `addOrdered(−1)`, rewrite the line | rate only: **NEW** `` `${item.n} at ${money(rate)}` ``<br>quantity: **NEW** `` `${item.n} cut to ${fq(qty, unit)} — ${fq(given, unit)} back on the procurement list` `` |
| `DELETE …/:id/lines/:n` (buyer) | order exists, `for update`; the same Draft guard; line exists; `releaseClaim(line.src, line.qty)` → lock, `addOrdered(−1)`, rewrite without the line | `` `${item.n} returned to the procurement list` `` |
| `PATCH /purchase-orders/:id` (buyer) | order exists, `for update`; **NEW** `assertRule(body.vendorId \|\| body.eta, \`Nothing to change on ${id}\`)`; for a vendor: **NEW** `assertRule(o.status === "Draft", \`${id} is ${st.toLowerCase()} — its vendor cannot change\`)`, vendor exists and is active (the two `createPo` sentences), re-price and re-date; for an eta: **NEW** `assertRule(o.status !== "Received" && o.status !== "Cancelled", \`${id} is ${st.toLowerCase()} — nothing more is expected\`)` | vendor moved: **NEW** `` `${id} moved to ${v.n} — expected ${dmy(eta)}` ``<br>eta only: **NEW** `` `${id} expected ${dmy(eta)}` `` |
| `POST …/:id/send` (buyer) | order exists, `for update`; `assertRule(lines.length > 0, \`${id} has no lines — add some from the procurement list\`)`; vendor exists → `assertRule(v, "Choose a vendor before sending")`; `assertRule(v.active, \`${v.n} is inactive — reactivate it or move this order to another vendor\`)`; `assertTransition(PO_TRANSITIONS, o.status, "Ordered", id)`; `needsApproval(poValue(lines), PO_APPROVAL_LIMIT)`; status `Ordered`, `at` restamped, history | over slab: `` `${id} raised on ${v.n} — ${money0(value)} is over the ${money0(PO_APPROVAL_LIMIT)} slab and needs finance approval` ``<br>otherwise: `` `${id} raised on ${v.n} — expected ${dmy(eta)}` `` |
| `POST …/:id/cancel` (buyer) | order exists, `for update`; `assertRule(lines.every(l => l.recv === 0), \`${id} already received against — close it short instead of cancelling\`)` — **before** the transition guard, so a partly-received order reads the sentence that tells it what to do instead; `assertTransition(PO_TRANSITIONS, o.status, "Cancelled", id)`; `assertRule(reason.trim(), "Give a reason for cancelling this order")`; every source released, requisitions locked, `addOrdered(−1)`; status `Cancelled`, `short_note = reason`, history | `` `${id} cancelled — ${n} line(s) back on the procurement list` `` |

`changed`: `create`, `updateLine` (quantity), `removeLine`, `cancel` → `["po", "prq"]`; `updateLine` (rate only), `patch`, `send` → `["po"]`. **A claim that did not move is not announced** — naming `"prq"` on a rate change costs every open browser a refetch of a list that did not change.

**Read documents back through `GET /snapshot`, not through the six new GETs.** `GET /requisitions`, `/purchase-orders`, `/grns`, `/vendors`, `/contracts` and `/product-requests` are **Task 4's, and Task 4 is in this same wave** — none of them exists when this worktree runs its gate, so a helper that calls one 404s and takes the whole suite with it. Read `GET /snapshot` (Phase 1, always there) and pick the slice: `.prq`, `.po`, `.grn`, `.vendors`, `.contracts`, `.productReqs`. The six standalone reads are asserted in Task 4's own suite and nowhere else.

**Two notes the implementer needs before writing the service.**

*The lock order is the whole correctness argument.* Every write above except `create` opens with `purchaseOrdersRepo.head(tx, id)` — `for update` — and reaches for requisition rows only afterwards, sorted ascending by `foldClaims`. `create` locks requisition rows while holding no purchase-order lock, which is safe **only** because it is minting the order and can never afterwards wait for an existing one. Do not add a read of another purchase order to `create`.

*Why the pending check folds first.* Two picks against the same `(prq, line)` must not each pass individually while their sum overruns what is still pending. `foldClaims` is what folds them, and the check runs on the folded totals — the comment in `store/procurement.ts`'s `createPo` says exactly this and the rule moves with it.

- [ ] **Step 1: Write the failing tests**

Replace `apps/api/src/modules/purchaseorders/purchaseorders.test.ts`. Reuse the header shape from Task 5's suite (`buildTestApp({ schema: "purchaseorders" })`, `hdr`, `post`, plus `patch` and `del`), and read `apps/api/src/modules/requests/requests.test.ts` first for the idioms.

```ts
const patch = async (u: string, url: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: `/api/v1${url}`, headers: await hdr(u), payload });
const del = async (u: string, url: string) =>
  app.inject({ method: "DELETE", url: `/api/v1${url}`, headers: await hdr(u) });
/** The two document collections, off `GET /snapshot` — the six standalone reads are Task 4's,
 *  in this same wave, so this suite must not touch them. */
const snap = async (u = "u5") => (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, u) })).json();
const prqs = async () => (await snap()).prq;
const pos = async () => (await snap()).po;
/** What is still claimable on one requisition line — the procurement list's own arithmetic. */
const pending = async (prq: string, line: number) => {
  const l = (await prqs()).find((p: { id: string }) => p.id === prq).lines[line];
  return Math.round((l.appr - l.ordered) * 1000) / 1000;
};

describe("POST /purchase-orders", () => {
  it("drafts an order, claims the quantity off the list, and prices off the live contract", async () => {
    // RC-101 is Aavin's live milk contract and its seeded rate is 52 — which is also
    // `IT.milk.cost`, so a case left at the seed's numbers would pass on the cost fallback and
    // prove nothing. Move the contract first, so only contract pricing can produce the answer.
    await app.testDb!.db.update(rateContracts).set({ rate: 49.5 }).where(eq(rateContracts.id, "RC-101"));
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    const before = await pending(prq, 0);
    const r = await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 60 }] });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ vendor: "VN-001", st: "Draft" });
    expect(b.result.id).toMatch(/^PO-\d{4}-0\d+$/);
    expect(b.result.lines).toEqual([{ it: "milk", qty: 60, rate: 49.5, recv: 0, rejected: 0, src: [{ prq, line: 0, qty: 60 }] }]);
    expect(b.result.hist.at(-1)).toMatchObject({ s: "Draft", who: "Latha Narayanan" });
    expect(b.changed).toEqual(["po", "prq"]);
    expect(b.message).toBe(`${b.result.id} drafted on Aavin Dairy Depot — 1 line(s), review the rates before sending`);
    expect(await pending(prq, 0)).toBe(before - 60);
  });

  it("prices off the item's own cost when the vendor has no contract for it", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "bisc", qty: 40, appr: 40 }] });
    const b = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 40 }] })).json();
    const items = await getItems();          // GET /items, for the standard cost
    expect(b.result.lines[0].rate).toBe(items.bisc.cost);
  });

  it("dates the order from the vendor's lead time", async () => {
    const v = await given.vendor(app.testDb!.db, { n: "Lead Time Traders", lead: 5, groups: ["Grocery"] });
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "sugar", qty: 10, appr: 10 }] });
    const b = (await post("u5", "/purchase-orders", { vendorId: v, picks: [{ prq, line: 0, qty: 10 }] })).json();
    expect(b.result.eta).toBe(etaFrom(new Date(), 5));
  });

  it("merges two requisitions' worth of the same item into one line carrying both sources", async () => {
    const a = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 25, appr: 25 }] });
    const c = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    const b = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [
      { prq: a, line: 0, qty: 25 }, { prq: c, line: 0, qty: 80 },
    ] })).json();
    expect(b.result.lines).toHaveLength(1);
    expect(b.result.lines[0].qty).toBe(105);
    expect(b.result.lines[0].src).toEqual([{ prq: a, line: 0, qty: 25 }, { prq: c, line: 0, qty: 80 }]);
    expect(await pending(a, 0)).toBe(0);
    expect(await pending(c, 0)).toBe(0);
  });

  it("refuses two picks against one source line whose total overruns what is pending", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    const r = await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [
      { prq, line: 0, qty: 50 }, { prq, line: 0, qty: 50 },
    ] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`Milk 1L (toned) — only 80.000 still pending on ${prq}`);
    expect(await pending(prq, 0)).toBe(80);
  });

  it("refuses a pick against a requisition nobody has approved", async () => {
    const prq = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 80 }] });   // still Sent
    expect((await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 1 }] })).json().error.message)
      .toBe(`Milk 1L (toned) — only 0.000 still pending on ${prq}`);
  });

  it("refuses an empty order, a zero pick, an unknown vendor and an inactive one", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    expect((await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [] })).json().error.message)
      .toBe("Pick at least one line before raising an order");
    expect((await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 0 }] })).json().error.message)
      .toBe("Enter a quantity on every line you pick");
    expect((await post("u5", "/purchase-orders", { vendorId: "VN-999", picks: [{ prq, line: 0, qty: 1 }] })).json().error.message)
      .toBe("Choose a vendor for this order");
    const off = await given.vendor(app.testDb!.db, { n: "Closed Traders", active: false });
    expect((await post("u5", "/purchase-orders", { vendorId: off, picks: [{ prq, line: 0, qty: 1 }] })).json().error.message)
      .toBe("Closed Traders is inactive — reactivate it or choose another vendor");
    expect(await pending(prq, 0)).toBe(80);
  });

  it("404s a requisition line that is not there, and is absent for every other role", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    expect((await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 7, qty: 1 }] })).json().error.message)
      .toBe(`There is no line 7 on ${prq}.`);
    for (const u of ["u1", "u2", "u3", "u4"]) {
      expect((await post(u, "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 1 }] })).statusCode).toBe(404);
    }
  });

  it("lets only one of two drafts claim the last of a line", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 80 }] }),
      post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 80 }] }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
    expect(await pending(prq, 0)).toBe(0);
  });
});

describe("PATCH and DELETE on a draft's lines", () => {
  const draft = async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    const id = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 60 }] })).json().result.id;
    return { prq, id };
  };

  it("gives the difference back when a line is cut", async () => {
    const { prq, id } = await draft();
    const b = (await patch("u5", `/purchase-orders/${id}/lines/0`, { qty: 40 })).json();
    expect(b.result.lines[0]).toMatchObject({ qty: 40, src: [{ prq, line: 0, qty: 40 }] });
    expect(b.changed).toEqual(["po", "prq"]);
    expect(b.message).toBe("Milk 1L (toned) cut to 40.000 — 20.000 back on the procurement list");
    expect(await pending(prq, 0)).toBe(40);
  });

  it("releases the last source first when a line is funded by several", async () => {
    const a = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 25, appr: 25 }] });
    const c = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    const id = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [
      { prq: a, line: 0, qty: 25 }, { prq: c, line: 0, qty: 80 },
    ] })).json().result.id;
    const b = (await patch("u5", `/purchase-orders/${id}/lines/0`, { qty: 75 })).json();
    expect(b.result.lines[0].src).toEqual([{ prq: a, line: 0, qty: 25 }, { prq: c, line: 0, qty: 50 }]);
    expect(await pending(a, 0)).toBe(0);
    expect(await pending(c, 0)).toBe(30);
  });

  it("refuses a quantity larger than the line, one of nothing, and a patch that says nothing", async () => {
    const { prq, id } = await draft();
    expect((await patch("u5", `/purchase-orders/${id}/lines/0`, { qty: 80 })).json().error.message)
      .toBe("Add another pick from the procurement list to increase this line");
    expect((await patch("u5", `/purchase-orders/${id}/lines/0`, { qty: 0 })).json().error.message)
      .toBe("Enter a quantity, or remove the line");
    const empty = await patch("u5", `/purchase-orders/${id}/lines/0`, {});
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error.message).toBe("Nothing to change on this line");
    expect(await pending(prq, 0)).toBe(20);
  });

  it("edits a rate without touching the claim, and does not tell the list to refetch", async () => {
    const { prq, id } = await draft();
    const b = (await patch("u5", `/purchase-orders/${id}/lines/0`, { rate: 58 })).json();
    expect(b.result.lines[0]).toMatchObject({ qty: 60, rate: 58 });
    expect(b.changed).toEqual(["po"]);
    expect(b.message).toBe("Milk 1L (toned) at ₹58.00");
    expect(await pending(prq, 0)).toBe(20);
  });

  it("removes a line, gives its whole claim back, and closes the gap in the numbering", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [
      { it: "milk", qty: 80, appr: 80 }, { it: "butter", qty: 6, appr: 6 },
    ] });
    const id = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [
      { prq, line: 0, qty: 60 }, { prq, line: 1, qty: 6 },
    ] })).json().result.id;
    const b = (await del("u5", `/purchase-orders/${id}/lines/0`)).json();
    expect(b.result.lines).toHaveLength(1);
    expect(b.result.lines[0]).toMatchObject({ it: "butter", qty: 6 });   // now line 0
    expect(b.message).toBe("Milk 1L (toned) returned to the procurement list");
    expect(await pending(prq, 0)).toBe(80);
    // and the surviving line is still addressable at its new index
    expect((await patch("u5", `/purchase-orders/${id}/lines/0`, { rate: 260 })).statusCode).toBe(200);
  });

  it("will not touch a line once the order has gone out", async () => {
    const id = await given.po(app.testDb!.db, { st: "Ordered", lines: [{ it: "milk", qty: 80 }] });
    expect((await patch("u5", `/purchase-orders/${id}/lines/0`, { qty: 40 })).json().error.message)
      .toBe(`${id} is ordered — only a draft can be changed`);
    expect((await del("u5", `/purchase-orders/${id}/lines/0`)).json().error.message)
      .toBe(`${id} is ordered — only a draft can be changed`);
  });

  it("404s a line that is not there", async () => {
    const { id } = await draft();
    expect((await patch("u5", `/purchase-orders/${id}/lines/9`, { qty: 1 })).json().error.message)
      .toBe(`There is no line 9 on ${id}.`);
  });
});

describe("PATCH /purchase-orders/:id", () => {
  it("moves a draft to another vendor, re-prices it off that vendor's contracts and re-dates it", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "juice", qty: 120, appr: 120 }] });
    // VN-001 has no juice contract, so the line starts on the item's own cost of 14.2.
    const id = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 120 }] })).json().result.id;
    // VN-002 does: RC-103, juice at 14.2 — pick a rate the contract genuinely moves.
    await app.testDb!.db.update(rateContracts).set({ rate: 13.8 }).where(eq(rateContracts.id, "RC-103"));
    const b = (await patch("u5", `/purchase-orders/${id}`, { vendorId: "VN-002" })).json();
    expect(b.result.vendor).toBe("VN-002");
    expect(b.result.lines[0].rate).toBe(13.8);
    expect(b.result.eta).toBe(etaFrom(new Date(), 3));       // VN-002's lead time
    expect(b.changed).toEqual(["po"]);
    expect(b.message).toBe(`${id} moved to Sri Balaji Distributors — expected ${dmy(b.result.eta)}`);
  });

  it("leaves a rate the buyer negotiated alone when the vendor moves", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "juice", qty: 120, appr: 120 }] });
    const id = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 120 }] })).json().result.id;
    await patch("u5", `/purchase-orders/${id}/lines/0`, { rate: 12 });
    const b = (await patch("u5", `/purchase-orders/${id}`, { vendorId: "VN-002" })).json();
    expect(b.result.lines[0].rate).toBe(12);
  });

  it("moves the expected date at any open status, and nowhere else", async () => {
    const ordered = await given.po(app.testDb!.db, { st: "Ordered", lines: [{ it: "milk", qty: 80 }] });
    const b = (await patch("u5", `/purchase-orders/${ordered}`, { eta: "2026-09-30" })).json();
    expect(b.result.eta).toBe("2026-09-30");
    expect(b.message).toBe(`${ordered} expected 30-Sep-2026`);

    expect((await patch("u5", `/purchase-orders/${ordered}`, { vendorId: "VN-002" })).json().error.message)
      .toBe(`${ordered} is ordered — its vendor cannot change`);

    const done = await given.po(app.testDb!.db, { st: "Received", lines: [{ it: "milk", qty: 80, recv: 80 }] });
    expect((await patch("u5", `/purchase-orders/${done}`, { eta: "2026-09-30" })).json().error.message)
      .toBe(`${done} is received — nothing more is expected`);
  });

  it("refuses a patch that says nothing", async () => {
    const id = await given.po(app.testDb!.db, { lines: [{ it: "milk", qty: 80 }] });
    expect((await patch("u5", `/purchase-orders/${id}`, {})).json().error.message).toBe(`Nothing to change on ${id}`);
  });
});

describe("POST /purchase-orders/:id/send", () => {
  it("sends a draft, stamps the slab and names the expected date", async () => {
    const id = await given.po(app.testDb!.db, { eta: "2026-09-11", lines: [{ it: "milk", qty: 80, rate: 54 }] });
    const b = (await post("u5", `/purchase-orders/${id}/send`)).json();
    expect(b.result).toMatchObject({ st: "Ordered", needsApproval: false });
    expect(b.result.hist.at(-1)).toMatchObject({ s: "Ordered", who: "Latha Narayanan" });
    expect(b.changed).toEqual(["po"]);
    expect(b.message).toBe(`${id} raised on Aavin Dairy Depot — expected 11-Sep-2026`);
  });

  it("flags an order over the finance slab but still sends it", async () => {
    const id = await given.po(app.testDb!.db, { lines: [{ it: "milk", qty: 1000, rate: 54 }] });   // ₹54,000
    const b = (await post("u5", `/purchase-orders/${id}/send`)).json();
    expect(b.result).toMatchObject({ st: "Ordered", needsApproval: true });
    expect(b.message).toBe(`${id} raised on Aavin Dairy Depot — ₹54,000 is over the ₹25,000 slab and needs finance approval`);
  });

  it("refuses an empty order, an inactive vendor and a second send", async () => {
    const empty = await given.po(app.testDb!.db, { lines: [] });
    expect((await post("u5", `/purchase-orders/${empty}/send`)).json().error.message)
      .toBe(`${empty} has no lines — add some from the procurement list`);

    const off = await given.vendor(app.testDb!.db, { n: "Closed Traders", active: false });
    const bad = await given.po(app.testDb!.db, { vendor: off, lines: [{ it: "milk", qty: 1 }] });
    expect((await post("u5", `/purchase-orders/${bad}/send`)).json().error.message)
      .toBe("Closed Traders is inactive — reactivate it or move this order to another vendor");

    const id = await given.po(app.testDb!.db, { lines: [{ it: "milk", qty: 1 }] });
    await post("u5", `/purchase-orders/${id}/send`);
    expect((await post("u5", `/purchase-orders/${id}/send`)).json().error.message).toBe(`${id} is already ordered`);
  });

  it("sends once when two screens press together", async () => {
    const id = await given.po(app.testDb!.db, { lines: [{ it: "milk", qty: 1 }] });
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([post("u5", `/purchase-orders/${id}/send`), post("u5", `/purchase-orders/${id}/send`)]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const hist = (await pos()).find((o: { id: string }) => o.id === id).hist;
    expect(hist.filter((h: { s: string }) => h.s === "Ordered")).toHaveLength(1);
  });
});

describe("POST /purchase-orders/:id/cancel", () => {
  it("cancels an order and puts every claim back on the list", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    const id = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 60 }] })).json().result.id;
    await post("u5", `/purchase-orders/${id}/send`);
    const b = (await post("u5", `/purchase-orders/${id}/cancel`, { reason: "Vendor cannot supply this week" })).json();
    expect(b.result).toMatchObject({ st: "Cancelled", shortNote: "Vendor cannot supply this week" });
    expect(b.changed).toEqual(["po", "prq"]);
    expect(b.message).toBe(`${id} cancelled — 1 line(s) back on the procurement list`);
    expect(await pending(prq, 0)).toBe(80);
  });

  it("will not cancel once anything has arrived, and says what to do instead", async () => {
    const id = await given.po(app.testDb!.db, { st: "Partially received", lines: [{ it: "milk", qty: 80, recv: 60 }] });
    const r = await post("u5", `/purchase-orders/${id}/cancel`, { reason: "Changed my mind" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${id} already received against — close it short instead of cancelling`);
  });

  it("wants a reason, and will not cancel twice", async () => {
    const id = await given.po(app.testDb!.db, { lines: [{ it: "milk", qty: 80 }] });
    expect((await post("u5", `/purchase-orders/${id}/cancel`, { reason: "  " })).json().error.message)
      .toBe("Give a reason for cancelling this order");
    await post("u5", `/purchase-orders/${id}/cancel`, { reason: "No" });
    expect((await post("u5", `/purchase-orders/${id}/cancel`, { reason: "No" })).json().error.message)
      .toBe(`${id} is already cancelled`);
  });

  it("gives a claim back exactly once when two screens cancel together", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    const id = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 60 }] })).json().result.id;
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u5", `/purchase-orders/${id}/cancel`, { reason: "a" }),
      post("u5", `/purchase-orders/${id}/cancel`, { reason: "b" }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await pending(prq, 0)).toBe(80);        // 80, not 140
  });
});
```
Add to the file's imports: `dmy`, `etaFrom` from `@rch/domain`; `eq` from `drizzle-orm`; `rateContracts` from `../../db/schema/index.js`; `given`, `warmPool`; and a `getItems()` helper reading `GET /items` as `u5` (a Phase 1 route, unlike the six this wave adds).

Run: `pnpm --filter @rch/api test src/modules/purchaseorders` → FAIL (404 on every URL).

**Prove the two race cases.** With `warmPool` commented out both must still resolve 1/1. With the `.for("update")` removed from `lockRequisitions`, the two concurrent `create` calls must both return 200 and leave `pending` at −60. With the `.for("update")` removed from `head`, the two cancels must both return 200 and push `pending` to 140. Restore all three.

- [ ] **Step 2: Write the repo**

Key methods, in full; the rest follow `requisitions/repo.ts`'s shapes exactly.
```ts
  /** `for update` on the named requisitions, ascending id — the document lock order this phase
   *  wrote into lib/ledger.ts's header. One statement, ordered, so two writers holding two
   *  requisitions between them cannot each hold the one the other wants. */
  async lockRequisitions(tx: Tx, ids: readonly string[]): Promise<void> {
    const unique = [...new Set(ids)].sort();
    if (unique.length === 0) return;
    await tx.select({ id: requisitions.id }).from(requisitions)
      .where(inArray(requisitions.id, unique)).orderBy(asc(requisitions.id)).for("update");
  },

  /** Each named requisition with its status and its lines, for the pending check. */
  async prqLines(tx: Tx, ids: readonly string[]): Promise<Map<string, { status: PrqStatus; lines: { it: string; appr: number; ordered: number }[] }>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const heads = await tx.select().from(requisitions).where(inArray(requisitions.id, unique));
    const lines = await tx.select().from(requisitionLines)
      .where(inArray(requisitionLines.requisitionId, unique)).orderBy(asc(requisitionLines.lineNo));
    return new Map(heads.map((h) => [h.id, {
      status: h.status,
      lines: lines.filter((l) => l.requisitionId === h.id).map((l) => ({ it: l.itemKey, appr: l.approvedQty, ordered: l.orderedQty })),
    }]));
  },

  /** Move `ordered_qty` on the named requisition lines. This is the only thing that adds to or
   *  takes from the procurement list, which is derived (approved less ordered) and stored
   *  nowhere. Call it under `lockRequisitions`, never without. */
  async addOrdered(tx: Tx, deltas: readonly ClaimSrc[], sign: 1 | -1): Promise<void> {
    for (const d of deltas) {
      await tx.update(requisitionLines)
        .set({ orderedQty: sql`round(${requisitionLines.orderedQty} + ${sign * d.qty}::numeric, 3)` })
        .where(and(eq(requisitionLines.requisitionId, d.prq), eq(requisitionLines.lineNo, d.line)));
    }
  },

  /**
   * A draft's lines and their sources, rewritten wholesale.
   *
   * Deleting and re-inserting keeps `line_no` equal to the array index the wire shape carries,
   * which is what PATCH/DELETE address and what `grns.po_line_no` points at. Shifting numbers in
   * place (`line_no = line_no - 1`) would transiently collide with the primary key unless it
   * were deferrable; a rewrite under the order's own row lock needs nothing. Only a Draft ever
   * reaches here, and a Draft has no goods receipt pointing at a line.
   */
  async writeLines(tx: Tx, id: string, lines: readonly { it: string; qty: number; rate: number; src: ClaimSrc[] }[]): Promise<void> {
    await tx.delete(poLineSources).where(eq(poLineSources.poId, id));
    await tx.delete(poLines).where(eq(poLines.poId, id));
    if (lines.length === 0) return;
    await tx.insert(poLines).values(lines.map((l, lineNo) => ({
      poId: id, lineNo, itemKey: l.it, qty: round3(l.qty), rate: Math.round(l.rate * 100) / 100,
    })));
    const srcs = lines.flatMap((l, lineNo) => l.src.map((x, seq) => ({
      poId: id, lineNo, seq, requisitionId: x.prq, requisitionLineNo: x.line, qty: round3(x.qty),
    })));
    if (srcs.length) await tx.insert(poLineSources).values(srcs);
  },

  /** Every live rate this vendor has for these items, on the given date. A contract whose window
   *  has closed does not price an order, however active its flag says it is. */
  async activeContractRates(tx: Tx, vendorId: string, itemKeys: readonly string[], on: string): Promise<Record<string, number>> {
    if (itemKeys.length === 0) return {};
    const rows = await tx.select({ itemKey: rateContracts.itemKey, rate: rateContracts.rate })
      .from(rateContracts)
      .where(and(eq(rateContracts.vendorId, vendorId), eq(rateContracts.active, true),
        inArray(rateContracts.itemKey, [...itemKeys]),
        lte(rateContracts.validFrom, on), gte(rateContracts.validTo, on)));
    return Object.fromEntries(rows.map((r) => [r.itemKey, r.rate]));
  },
```
`head`, `lines`, `sources`, `vendor`, `insert`, `setStatus`, `userName` and `wire` follow the `requisitions/repo.ts` patterns; `wire` produces exactly what `readers/documents.ts`'s `readPurchaseOrders` produces for one order (`strip` on `needsApproval`/`shortNote`/`recv`, `eta: o.eta ?? ""`, sources grouped by `lineNo` and ordered by `seq`).

- [ ] **Step 3: Write the service**

The five that move a claim share one helper; write it once at the top of the factory:
```ts
    /**
     * Give a set of claims back to the requisition lines that granted them.
     *
     * The order's own row is already locked by every caller (`head`), so this only has to take
     * the requisition rows — ascending, which `foldClaims` guarantees — before it writes. Both
     * halves of the phase's document lock order are then held, in the order the header records.
     */
    const returnClaims = async (tx: Tx, released: readonly ClaimSrc[]): Promise<void> => {
      const folded = foldClaims(released);
      if (folded.length === 0) return;
      await purchaseOrdersRepo.lockRequisitions(tx, folded.map((x) => x.prq));
      await purchaseOrdersRepo.addOrdered(tx, folded, -1);
    };
```
`create`, in outline, with the parts that carry a rule in full:
```ts
    async create(claims: AccessClaims, body: CreatePoBody): Promise<WriteResponse<PurchaseOrder>> {
      return withTransaction(db, async (tx) => {
        assertRule(body.picks.length > 0, "Pick at least one line before raising an order");
        const v = await purchaseOrdersRepo.vendor(tx, body.vendorId);
        assertRule(v, "Choose a vendor for this order");
        assertRule(v.active, `${v.name} is inactive — reactivate it or choose another vendor`);
        assertRule(body.picks.every((p) => p.qty > 0), "Enter a quantity on every line you pick");

        const master = await loadMaster(tx);
        // Documents first, in ascending id order, and before the sequence row: this is the one
        // write that locks requisitions while holding no purchase-order lock, and it is safe
        // only because it is minting the order and never waits for an existing one.
        const picks = body.picks.map((p) => ({ prq: p.prq, line: p.line, qty: round3(p.qty) }));
        await purchaseOrdersRepo.lockRequisitions(tx, picks.map((p) => p.prq));
        const prq = await purchaseOrdersRepo.prqLines(tx, picks.map((p) => p.prq));

        // Fold before checking. Two picks against the same source line must not each pass on
        // their own while their sum overruns what is still pending on it.
        for (const f of foldClaims(picks)) {
          const p = prq.get(f.prq);
          if (!p) throw new NotFoundError(`There is no requisition ${f.prq}.`);
          const l = p.lines[f.line];
          if (!l) throw new NotFoundError(`There is no line ${f.line} on ${f.prq}.`);
          // Only an approved requisition has anything to give; anything else has nothing pending,
          // which is exactly what the buyer's own derived list shows them.
          const pending = p.status === "Approved" || p.status === "Partially approved"
            ? round3(l.appr - l.ordered) : 0;
          const item = master.items[l.it];
          assertRule(f.qty <= pending, `${item?.n ?? "That line"} — only ${fq(pending, item?.u ?? "nos")} still pending on ${f.prq}`);
        }

        const at = new Date();
        const id = await allocateId(tx, "po", at);
        // Merge picks of the same item into one line carrying several sources, in the order the
        // buyer picked them — which is the order `releaseClaim` later walks backwards.
        const merged: { it: string; qty: number; rate: number; src: ClaimSrc[] }[] = [];
        for (const p of picks) {
          const it = prq.get(p.prq)!.lines[p.line]!.it;
          const at_ = merged.find((l) => l.it === it);
          if (at_) { at_.qty = round3(at_.qty + p.qty); at_.src.push({ ...p }); }
          else merged.push({ it, qty: p.qty, rate: 0, src: [{ ...p }] });
        }
        const rates = await purchaseOrdersRepo.activeContractRates(tx, v.id, merged.map((l) => l.it), istDate(at));
        for (const l of merged) l.rate = rateFor(rates[l.it] === undefined ? undefined : { rate: rates[l.it]! }, master.items[l.it]?.cost ?? 0);

        await purchaseOrdersRepo.insert(tx, {
          id, vendorId: v.id, at, status: "Draft", eta: etaFrom(at, v.leadDays), needsApproval: false,
        });
        await purchaseOrdersRepo.writeLines(tx, id, merged);
        await purchaseOrdersRepo.addOrdered(tx, foldClaims(picks), 1);
        const who = await purchaseOrdersRepo.userName(tx, claims.sub);
        await appendHistory(tx, "purchase_order", id, "Draft", who, at);

        const changed = ["po", "prq"] as const;
        await emitChanged(tx, changed);
        return {
          result: await purchaseOrdersRepo.wire(tx, id), changed: [...changed],
          message: `${id} drafted on ${v.name} — ${merged.length} line(s), review the rates before sending`,
        };
      });
    },
```
`updateLine` (the quantity branch), which is where `releaseClaim` earns its keep:
```ts
        const line = lines[n];
        if (!line) throw new NotFoundError(`There is no line ${n} on ${id}.`);
        assertRule(body.qty !== undefined || body.rate !== undefined, "Nothing to change on this line");
        const item = master.items[line.it];
        if (body.qty === undefined) {
          // A rate is a negotiation, not a claim: nothing moves on the procurement list, so
          // nothing tells the buyer's list to refetch.
          const next = lines.map((l, i) => (i === n ? { ...l, rate: body.rate! } : l));
          await purchaseOrdersRepo.writeLines(tx, id, next);
          const changed = ["po"] as const;
          await emitChanged(tx, changed);
          return { result: await purchaseOrdersRepo.wire(tx, id), changed: [...changed], message: `${item?.n ?? line.it} at ${money(body.rate!)}` };
        }
        const want = round3(body.qty);
        // A quantity of zero is not a delete: DELETE is the one explicit, toasted path for
        // dropping a line, and it is the one that says what went back on the list.
        assertRule(want > 0, "Enter a quantity, or remove the line");
        assertRule(want <= line.qty, "Add another pick from the procurement list to increase this line");
        const { released, left } = releaseClaim(line.src, round3(line.qty - want));
        await returnClaims(tx, released);
        await purchaseOrdersRepo.writeLines(tx, id, lines.map((l, i) => (i === n ? { ...l, qty: want, src: left } : l)));
        const given_ = round3(line.qty - want);
        const unit = item?.u ?? "nos";
        const changed = ["po", "prq"] as const;
        await emitChanged(tx, changed);
        return {
          result: await purchaseOrdersRepo.wire(tx, id), changed: [...changed],
          message: `${item?.n ?? line.it} cut to ${fq(want, unit)} — ${fq(given_, unit)} back on the procurement list`,
        };
```
`removeLine`, `patch`, `send` and `cancel` follow the rules table exactly. Two details worth spelling out:

*`patch`'s re-pricing.* When the vendor moves, re-price a line **only** when its rate still sits on the item's standard cost or on the previous vendor's contract rate for it — a rate the buyer typed is never overwritten. That is `PoDrawer.tsx`'s effect, moved verbatim and deleted from the browser (Task 10):
```ts
          const before = await purchaseOrdersRepo.activeContractRates(tx, o.vendorId, keys, on);
          const after = await purchaseOrdersRepo.activeContractRates(tx, v.id, keys, on);
          const next = lines.map((l) => {
            const to = after[l.it];
            if (to === undefined || to <= 0 || l.rate === to) return l;
            const standard = master.items[l.it]?.cost ?? 0;
            // Only a line still on the standard cost, or on the vendor we are leaving, re-prices.
            return l.rate === standard || l.rate === before[l.it] ? { ...l, rate: to } : l;
          });
```
*`cancel`'s guard order.* The `recv > 0` check comes **before** `assertTransition`, because a partly-received order would otherwise fail the status check with `<id> is already partially received` — true, and useless. The store's own comment says so and the order moves with it.

- [ ] **Step 4: Mount them**

```ts
  const svc = createPurchaseOrdersService(app.db);
  mount(app, routes.createPo, async (req) => svc.create(req.user, req.body));
  mount(app, routes.updatePoLine, async (req) => svc.updateLine(req.user, req.params.id, req.params.n, req.body));
  mount(app, routes.removePoLine, async (req) => svc.removeLine(req.user, req.params.id, req.params.n));
  mount(app, routes.patchPo, async (req) => svc.patch(req.user, req.params.id, req.body));
  mount(app, routes.sendPo, async (req) => svc.send(req.user, req.params.id));
  mount(app, routes.cancelPo, async (req) => svc.cancel(req.user, req.params.id, req.body));
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @rch/api test src/modules/purchaseorders` → PASS.
Then `pnpm turbo typecheck test && pnpm lint` — `scripts/check-boundaries.sh` included: this module writes `purchase_orders`, `po_lines`, `po_line_sources` and `requisition_lines`, none of them protected, and it posts no stock move at all.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/purchaseorders
git commit -m "$(cat <<'EOF'
Put the purchase order's life on the server, claim and all

A draft is picked off a procurement list that is derived, not stored: the only thing that adds
to it or takes from it is ordered_qty on the requisition lines a purchase-order line claims
against. Creating, cutting, removing and cancelling all move that claim, and a cut gives it
back last source first, so a shrink and a re-grow land where they started.

Two picks against the same source line are folded before the pending check, or their total
could overrun a line each of them passed on its own.

The locks are the correctness argument. Every write here takes the order's own row first and
the requisitions second, ascending — except create, which locks requisitions while holding no
order lock and is safe only because it is minting the order it will never wait for. The rule
is in lib/ledger.ts's header and the races that prove it are in this suite.

Rates come off the live rate contract and fall back to the item's own cost, here and when the
vendor moves — which retires the browser effect that fired a write per line on drawer open.

Replaces the in-memory createPo, updatePoLine, removePoLine, setPoVendor, setPoEta, sendPo and
cancelPo rules pinned by UI/src/__tests__/procurement.test.ts's "draft purchase orders" and
"sending a purchase order" blocks, which move here in the UI cutover.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `grn` — the goods arrive, and what does not arrive goes back

*(Wave 2, alongside Tasks 4–6, 8 and 9. It owns `apps/api/src/modules/grn/**` and nothing else. Task 6 owns `apps/api/src/modules/purchaseorders/**`; the two write different columns of `po_lines` and each has its own claim-returning pair — see Task 6's note.)*

**This is the phase's only ledger write, and the only one that puts stock somewhere new.** Both moves are **positive**: `grn_accept` at `store` for what was accepted, `grn_reject` at `quarantine` for what was turned away. Nothing here reads a balance in order to promise against it and nothing can drive one below zero, so — unlike `pay`, `handover` and `makeBatch` — there is **no `lockBalances` call of its own and no post-lock re-read**. `postMoves` takes the locks it needs, in `(loc, item)` order, and that is the whole of it. Do not add either out of symmetry; a re-read that cannot fire is noise, and a speculative lock creates the balance row it locks (M12).

**Files:**
- Modify: `apps/api/src/modules/grn/{repo.ts,service.ts,routes.ts,grn.test.ts}`

**Interfaces:**
- Consumes: `mount`; `withTransaction`, `type Tx`; `assertRule`, `assertTransition`; `NotFoundError`; `emitChanged`; `appendHistory`; `postMoves`, `type Move` from `../../lib/ledger.js`; `loadMaster`; `iso`; and from `@rch/domain`: `checkReceiptLine`, `foldClaims`, `istDate`, `receiptStatus`, `round3`, `shortfallClaims`, `unitTotal`, `PO_TRANSITIONS`, `type ClaimSrc`.
- Produces:
  ```ts
  // apps/api/src/modules/grn/repo.ts
  export const grnRepo = {
    head(tx, id): Promise<PoRow | undefined>;                          // for update
    lines(tx, id): Promise<{ it: string; qty: number; rate: number; recv: number; rejected: number }[]>;
    sources(tx, id): Promise<Map<number, ClaimSrc[]>>;
    grnCount(tx, poId): Promise<number>;
    insertGrns(tx, rows: readonly NewGrn[]): Promise<GrnRow[]>;
    setLineReceipt(tx, poId, lineNo, patch: { receivedQty: number; rejectedQty: number }): Promise<void>;
    setStatus(tx, id, patch: { status: PoStatus; receivedAt?: Date; shortNote?: string }): Promise<void>;
    listAPrices(tx, itemKeys): Promise<Record<string, number>>;
    lockRequisitions(tx, ids): Promise<void>;
    addOrdered(tx, deltas: readonly ClaimSrc[], sign: 1 | -1): Promise<void>;
    userName(tx, id): Promise<string>;
    wire(tx, id): Promise<PurchaseOrder>;
    wireGrns(tx, ids: readonly string[]): Promise<Grn[]>;
  };
  // apps/api/src/modules/grn/service.ts
  createGrnService(db) => { receive, closeShort }
  ```

**GRN numbering has no sequence row.** Spec §7.3: `GRN-<last 3 of PO>-<nn>`, *nn = instalment count for that PO* — and `IdKind` has no `"grn"`, deliberately. The number is `grnCount(tx, poId)` plus the position of this accepted line within the instalment, computed **under the order's own `for update` lock**, which is what serialises two receipts against one order. One GRN row per received line, exactly as the browser writes them.

**Rules, verbatim (spec §9.2's `receivePo` and `closePoShort` rows). Every message except the two marked NEW is the store's current `notify()` text, character for character:**

| Endpoint | Rules, in this order | Message |
|---|---|---|
| `POST …/:id/receive` (buyer, store) | order exists, `for update` (404 `There is no purchase order <id>.`); **NEW** `assertRule(o.status === "Ordered" \|\| o.status === "Partially received", \`${id} is ${st.toLowerCase()} — nothing can be booked against it\`)`; `assertRule(dc.trim(), "Record the vendor's delivery note number before booking goods in")`; **NEW** `assertRule(body.lines.length === lines.length, \`Give a line for each of the ${lines.length} lines on this order\`)`; `assertRule(body.lines.some(r => r.recv > 0), "Enter what arrived on at least one line")`; **every line with `recv > 0` checked in full through `checkReceiptLine(..., istDate(new Date()))` before anything is written** — a rejected receipt leaves no trace; then per accepted line: a `grns` row, `received_qty += recv`, `rejected_qty += rejected`; `postMoves` — one `grn_accept` at `store` for `recv − rejected` **when that is > 0**, one `grn_reject` at `quarantine` **when `rejected > 0`**; status from `receiptStatus(lines)` through `assertTransition`; `received_at`; history | rejected anything: `` `Booked into ${LOC.store.n} — ${unitTotal(accepted)} accepted, ${unitTotal(rejected)} rejected` ``<br>otherwise: `` `Booked into ${LOC.store.n} — ${n} batch(es) against ${dc.trim()}` `` |
| `POST …/:id/close-short` (buyer) | order exists, `for update`; `assertRule(o.status === "Partially received", \`${id} is ${st.toLowerCase()} — only a partly received order can be closed short\`)` — **NEW** wording, replacing a silent return; `assertRule(reason.trim(), "Give a reason for closing this order short")`; `shortfallClaims(lines)` → lock those requisitions, `addOrdered(−1)`; status `Received` with `short_note = reason`; history row **`Closed short`** | `` `${id} closed short — the undelivered balance is back on the procurement list` `` |

`changed`: `receive` → `["po", "grn", "stock"]`; `closeShort` → `["po", "prq"]`. A receipt names no `"prq"`: it changes `received_qty` on the order, not `ordered_qty` on any requisition.

**Read documents back through `GET /snapshot`, not through the six new GETs.** `GET /requisitions`, `/purchase-orders`, `/grns`, `/vendors`, `/contracts` and `/product-requests` are **Task 4's, and Task 4 is in this same wave** — none of them exists when this worktree runs its gate, so a helper that calls one 404s and takes the whole suite with it. Read `GET /snapshot` (Phase 1, always there) and pick the slice: `.prq`, `.po`, `.grn`, `.vendors`, `.contracts`, `.productReqs`. The six standalone reads are asserted in Task 4's own suite and nowhere else.

**Three notes the implementer needs.**

*Validate everything, then write.* The loop that checks and the loop that writes are two loops, not one. `store/procurement.ts`'s comment says it — *"Every line is checked in full before anything is written — a rejected receipt must leave no trace"* — and while the transaction would roll a half-write back anyway, keeping the two apart is what makes the *first* failing line the one the operator is told about, which is the sentence the tests pin.

*A history row that is not a status.* `closePoShort` writes `Closed short` into `document_history` while setting the status to `Received`. That is the browser's own behaviour and it is right: the trail has to say the order was closed rather than filled. The status column carries `Received` because that is the `PoStatus` the order is in.

*`accepted` and `rejected` are `{it, qty}` lists, not running numbers.* An instalment can span items in different units — litres of milk and kilos of butter — and a bare sum across units is meaningless (M4). `unitTotal` groups them.

- [ ] **Step 1: Write the failing tests**

Replace `apps/api/src/modules/grn/grn.test.ts`. Reuse Task 5's header shape with `schema: "grn"`, plus an `onHand(loc, it)` helper reading `GET /stock` as `u5` and a `moveCount()` reading `stock_moves`.

```ts
/** An order ready to receive against, with a live requisition claim behind it. */
const ordered = async (lines: { it: string; qty: number; recv?: number }[], st: "Ordered" | "Partially received" = "Ordered") => {
  const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: lines.map((l) => ({ it: l.it, qty: l.qty, appr: l.qty, ordered: l.qty })) });
  const id = await given.po(app.testDb!.db, { st, lines: lines.map((l, i) => ({ ...l, src: [{ prq, line: i, qty: l.qty }] })) });
  return { prq, id };
};
const doc = { dc: "DC-88214", invoice: "INV/AAV/4472", invDate: "2026-09-04" };
const good = (recv: number, over: Partial<{ rejected: number; batch: string; mrp: number; mfg: string; exp: string }> = {}) => ({
  recv, rejected: 0, batch: "AAV-8893", mrp: 0, mfg: "2026-09-01", exp: "2027-09-01", ...over,
});

describe("POST /purchase-orders/:id/receive", () => {
  it("books accepted stock straight onto the central store's shelf, one GRN per line", async () => {
    const { id } = await ordered([{ it: "milk", qty: 80 }, { it: "butter", qty: 6 }]);
    const before = { milk: await onHand("store", "milk"), butter: await onHand("store", "butter") };

    const r = await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(80), good(6)] });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.po.st).toBe("Received");
    expect(b.result.po.lines.map((l: { recv: number }) => l.recv)).toEqual([80, 6]);
    expect(b.result.grns).toHaveLength(2);
    expect(b.result.grns[0].id).toBe(`GRN-${id.slice(-3)}-01`);
    expect(b.result.grns[1].id).toBe(`GRN-${id.slice(-3)}-02`);
    expect(b.result.grns[0]).toMatchObject({ po: id, it: "milk", qty: 80, rejected: 0, batch: "AAV-8893", dc: "DC-88214", by: "Suresh Muthu" });
    expect(b.changed).toEqual(["po", "grn", "stock"]);
    expect(b.message).toBe("Booked into Central Store — 2 batch(es) against DC-88214");

    expect(await onHand("store", "milk")).toBeCloseTo(before.milk + 80, 3);
    expect(await onHand("store", "butter")).toBeCloseTo(before.butter + 6, 3);
    const mine = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refType, "grn"));
    expect(mine.filter((m) => m.kind === "grn_accept" && m.loc === "store")).toHaveLength(2);
  });

  it("puts what quality control turned away into quarantine, and nothing else", async () => {
    const { id } = await ordered([{ it: "water", qty: 120 }]);
    const store0 = await onHand("store", "water");
    const q0 = await onHand("quarantine", "water");

    const b = (await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(120, { rejected: 12, mrp: 20 })] })).json();
    expect(b.result.grns[0]).toMatchObject({ qty: 108, rejected: 12 });
    expect(b.result.po.lines[0]).toMatchObject({ recv: 120, rejected: 12 });
    expect(b.message).toBe("Booked into Central Store — 108 nos accepted, 12 nos rejected");

    expect(await onHand("store", "water")).toBeCloseTo(store0 + 108, 3);
    expect(await onHand("quarantine", "water")).toBeCloseTo(q0 + 12, 3);
    const mine = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, b.result.grns[0].id));
    expect(mine.map((m) => [m.kind, m.loc, m.qty])).toEqual([["grn_accept", "store", 108], ["grn_reject", "quarantine", 12]]);
  });

  it("leaves no phantom quarantine line on a clean delivery", async () => {
    // lockBalances creates the row it locks, and a zero row reads as "this location carries the
    // line" on every stock screen (M12). A clean delivery must post no reject move at all.
    const { id } = await ordered([{ it: "bisc", qty: 40 }]);
    await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(40)] });
    expect(await app.testDb!.db.select().from(stockBalances)
      .where(and(eq(stockBalances.loc, "quarantine"), eq(stockBalances.itemKey, "bisc")))).toHaveLength(0);
  });

  it("accumulates instalments, stays partially received in between, and numbers the GRNs on", async () => {
    const { id } = await ordered([{ it: "milk", qty: 80 }]);
    const first = (await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(60)] })).json();
    expect(first.result.po.st).toBe("Partially received");
    expect(first.result.grns[0].id).toBe(`GRN-${id.slice(-3)}-01`);

    const second = (await post("u3", `/purchase-orders/${id}/receive`, { ...doc, dc: "DC-88999", lines: [good(20)] })).json();
    expect(second.result.po.st).toBe("Received");
    expect(second.result.po.lines[0].recv).toBe(80);
    expect(second.result.grns[0].id).toBe(`GRN-${id.slice(-3)}-02`);
  });

  it("takes an over-delivery inside 2% and refuses one beyond it, writing nothing", async () => {
    const { id } = await ordered([{ it: "juice", qty: 120 }]);
    const count = await moveCount();
    const r = await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(123, { mrp: 20 })] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Real Juice 200ml — 123 exceeds the ordered 120 by more than 2%; hold it for purchase approval");
    expect(await moveCount()).toBe(count);
    expect(await app.testDb!.db.select().from(grns).where(eq(grns.poId, id))).toHaveLength(0);

    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(122, { mrp: 20 })] })).statusCode).toBe(200);
  });

  it("counts what earlier instalments already booked in when it measures the tolerance", async () => {
    const { id } = await ordered([{ it: "juice", qty: 120 }]);
    await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(100, { mrp: 20 })] });
    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(23, { mrp: 20 })] })).json().error.message)
      .toBe("Real Juice 200ml — 123 exceeds the ordered 120 by more than 2%; hold it for purchase approval");
  });

  it("refuses a line without a batch, without dates, with them the wrong way round, or already expired", async () => {
    const { id } = await ordered([{ it: "milk", qty: 80 }]);
    const say = async (over: Record<string, unknown>) => (await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(10, over)] })).json().error.message;
    expect(await say({ batch: "  " })).toBe("Milk 1L (toned) needs its batch or lot number");
    expect(await say({ exp: "" })).toBe("Milk 1L (toned) needs a manufacturing and an expiry date");
    expect(await say({ mfg: "2027-01-01", exp: "2026-12-01" })).toBe("Milk 1L (toned) — expiry cannot fall on or before the manufacturing date");
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    expect(await say({ mfg: "2020-01-01", exp: yesterday })).toBe(`Milk 1L (toned) — batch AAV-8893 has already expired; do not book it in`);
    // and a batch expiring today is still fit to sell
    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(10, { mfg: "2020-01-01", exp: new Date().toISOString().slice(0, 10) })] })).statusCode).toBe(200);
  });

  it("refuses a printed MRP below the shelf price, and a rejection larger than the delivery", async () => {
    const { id } = await ordered([{ it: "juice", qty: 120 }]);
    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(120, { mrp: 15 })] })).json().error.message)
      .toBe("Real Juice 200ml — printed MRP ₹15.00 is below the shelf price; reprice before selling");
    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(120, { mrp: 20, rejected: 130 })] })).json().error.message)
      .toBe("Real Juice 200ml — rejected quantity cannot exceed what arrived");
  });

  it("refuses a receipt with no delivery note, with nothing on it, or against a closed order", async () => {
    const { id } = await ordered([{ it: "milk", qty: 80 }]);
    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, dc: "  ", lines: [good(10)] })).json().error.message)
      .toBe("Record the vendor's delivery note number before booking goods in");
    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(0)] })).json().error.message)
      .toBe("Enter what arrived on at least one line");
    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(10), good(10)] })).json().error.message)
      .toBe("Give a line for each of the 1 lines on this order");
    const draft = await given.po(app.testDb!.db, { lines: [{ it: "milk", qty: 80 }] });
    expect((await post("u3", `/purchase-orders/${draft}/receive`, { ...doc, lines: [good(10)] })).json().error.message)
      .toBe(`${draft} is draft — nothing can be booked against it`);
  });

  it("is open to the buyer as well as the store keeper, and to nobody else", async () => {
    const { id } = await ordered([{ it: "milk", qty: 80 }]);
    expect((await post("u5", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(10)] })).statusCode).toBe(200);
    for (const u of ["u1", "u2", "u4"]) {
      expect((await post(u, `/purchase-orders/${id}/receive`, { ...doc, lines: [good(10)] })).statusCode).toBe(404);
    }
    expect((await post("u3", "/purchase-orders/PO-2026-9999/receive", { ...doc, lines: [good(1)] })).json().error.message)
      .toBe("There is no purchase order PO-2026-9999.");
  });

  it("books one delivery, not two, when the door and the desk press together", async () => {
    const { id } = await ordered([{ it: "milk", qty: 80 }]);
    const before = await onHand("store", "milk");
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(80)] }),
      post("u5", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(80)] }),
    ]);
    // The second sees 80 already received and 160 over the 2% tolerance.
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
    expect(await onHand("store", "milk")).toBeCloseTo(before + 80, 3);
    expect(await app.testDb!.db.select().from(grns).where(eq(grns.poId, id))).toHaveLength(1);
  });
});

describe("POST /purchase-orders/:id/close-short", () => {
  it("returns the undelivered balance to the list and closes the order as received", async () => {
    const { prq, id } = await ordered([{ it: "milk", qty: 80 }]);
    await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(60)] });
    expect(await pending(prq, 0)).toBe(0);

    const b = (await post("u5", `/purchase-orders/${id}/close-short`, { reason: "Vendor cannot deliver the balance" })).json();
    expect(b.result).toMatchObject({ st: "Received", shortNote: "Vendor cannot deliver the balance" });
    expect(b.result.hist.at(-1)).toMatchObject({ s: "Closed short", who: "Latha Narayanan" });
    expect(b.changed).toEqual(["po", "prq"]);
    expect(b.message).toBe(`${id} closed short — the undelivered balance is back on the procurement list`);
    expect(await pending(prq, 0)).toBe(20);
  });

  it("splits a shortfall across several source requisitions, releasing the last one first", async () => {
    const a = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 25, appr: 25, ordered: 25 }] });
    const c = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80, ordered: 80 }] });
    const id = await given.po(app.testDb!.db, { st: "Partially received", lines: [
      { it: "milk", qty: 105, recv: 60, src: [{ prq: a, line: 0, qty: 25 }, { prq: c, line: 0, qty: 80 }] },
    ] });
    await post("u5", `/purchase-orders/${id}/close-short`, { reason: "Balance not coming" });
    expect(await pending(c, 0)).toBe(45);
    expect(await pending(a, 0)).toBe(0);
  });

  it("wants a reason, refuses an order that is not partly received, and will not run twice", async () => {
    const { id } = await ordered([{ it: "milk", qty: 80 }], "Partially received");
    expect((await post("u5", `/purchase-orders/${id}/close-short`, { reason: "  " })).json().error.message)
      .toBe("Give a reason for closing this order short");
    const draft = await given.po(app.testDb!.db, { lines: [{ it: "milk", qty: 80 }] });
    expect((await post("u5", `/purchase-orders/${draft}/close-short`, { reason: "x" })).json().error.message)
      .toBe(`${draft} is draft — only a partly received order can be closed short`);
    await post("u5", `/purchase-orders/${id}/close-short`, { reason: "x" });
    expect((await post("u5", `/purchase-orders/${id}/close-short`, { reason: "x" })).json().error.message)
      .toBe(`${id} is received — only a partly received order can be closed short`);
  });

  it("gives the balance back exactly once when two screens close together", async () => {
    const { prq, id } = await ordered([{ it: "milk", qty: 80 }]);
    await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(60)] });
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u5", `/purchase-orders/${id}/close-short`, { reason: "a" }),
      post("u5", `/purchase-orders/${id}/close-short`, { reason: "b" }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await pending(prq, 0)).toBe(20);       // 20, not 40
  });
});
```
Add to the file's imports: `and`, `eq` from `drizzle-orm`; `grns`, `stockBalances`, `stockMoves` from `../../db/schema/index.js`; `given`, `warmPool`; and Task 6's `snap()`/`prqs()`/`pending(prq, line)` helpers, **copied** — the two suites are independent files, each carries its own helpers, and `pending` reads `GET /snapshot`'s `.prq` slice for the reason above, not `GET /requisitions`.

*A sentence that reads badly at one.* `Give a line for each of the 1 lines on this order` is what a single-line order produces. It is pinned by a test either way; it is called out here only so a later pass does not "improve" it into a regression against the pinned string.

Run: `pnpm --filter @rch/api test src/modules/grn` → FAIL (404 on both URLs).

**Prove the two race cases.** With the `.for("update")` removed from `grnRepo.head`, the two concurrent receipts must both return 200 and push `store.milk` up by 160 with two GRN rows; the two concurrent close-shorts must both return 200 and push `pending` to 40. Restore it.

- [ ] **Step 2: Write the repo**

The three methods that carry a decision, in full; the rest follow the patterns in `requisitions/repo.ts` and Task 6's:
```ts
  /** How many GRN rows this order already carries. Spec §7.3 numbers a goods receipt by the
   *  instalment count for its own order, not from a sequence — which is why `IdKind` has no
   *  "grn". Read under the order's `for update` lock, which is what serialises two receipts. */
  async grnCount(tx: Tx, poId: string): Promise<number> {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(grns).where(eq(grns.poId, poId));
    return row?.n ?? 0;
  },

  /** The list-A shelf price for these items, for the printed-MRP check. */
  async listAPrices(tx: Tx, itemKeys: readonly string[]): Promise<Record<string, number>> {
    if (itemKeys.length === 0) return {};
    const rows = await tx.select({ itemKey: priceListItems.itemKey, price: priceListItems.price })
      .from(priceListItems).where(and(eq(priceListItems.list, "A"), inArray(priceListItems.itemKey, [...itemKeys])));
    return Object.fromEntries(rows.map((r) => [r.itemKey, r.price]));
  },

  /** `for update` on the named requisitions, ascending id — the document lock order. The order's
   *  own row is already held by the caller. (The purchaseorders module has its own copy of this
   *  pair; the arithmetic they both drive is one implementation, in @rch/domain's claims.ts.) */
  async lockRequisitions(tx: Tx, ids: readonly string[]): Promise<void> { /* as Task 6's */ },
  async addOrdered(tx: Tx, deltas: readonly ClaimSrc[], sign: 1 | -1): Promise<void> { /* as Task 6's */ },
```

- [ ] **Step 3: Write `receive`**

```ts
    /**
     * One instalment of a delivery.
     *
     * The one write in this phase that moves stock, and it only ever adds: `grn_accept` at the
     * central store for what passed inspection, `grn_reject` at quarantine for what did not.
     * Nothing is promised against a balance here, so there is no `lockBalances` call and no
     * post-lock re-read — `postMoves` takes what it needs, in (loc, item) order.
     *
     * Every line is checked in full before anything is written. The transaction would roll a
     * half-write back anyway; checking first is what makes the **first** bad line the one the
     * store keeper is told about, which is the sentence they have always read.
     */
    async receive(claims: AccessClaims, id: string, body: ReceivePoBody): Promise<WriteResponse<ReceiptResult>> {
      return withTransaction(db, async (tx) => {
        const o = await grnRepo.head(tx, id);
        if (!o) throw new NotFoundError(`There is no purchase order ${id}.`);
        assertRule(o.status === "Ordered" || o.status === "Partially received",
          `${id} is ${o.status.toLowerCase()} — nothing can be booked against it`);
        const dc = body.dc.trim();
        assertRule(dc.length > 0, "Record the vendor's delivery note number before booking goods in");
        const lines = await grnRepo.lines(tx, id);
        // Positional, like an approval's `appr`: a short array would read as "nothing arrived on
        // the lines you left out", which is not what a stale screen means to say (spec §16).
        assertRule(body.lines.length === lines.length, `Give a line for each of the ${lines.length} lines on this order`);
        assertRule(body.lines.some((r) => r.recv > 0), "Enter what arrived on at least one line");

        const master = await loadMaster(tx);
        const listA = await grnRepo.listAPrices(tx, lines.map((l) => l.it));
        const today = istDate(new Date());
        for (const [i, l] of lines.entries()) {
          const r = body.lines[i]!;
          if (!(r.recv > 0)) continue;
          const item = master.items[l.it];
          const bad = checkReceiptLine({
            name: item?.n ?? l.it, unit: item?.u ?? "nos", ordered: l.qty, received: l.recv,
            mrp: item?.mrp ?? null, listA: listA[l.it] ?? 0,
          }, r, today);
          if (bad) assertRule(false, bad);
        }

        const at = new Date();
        let n = await grnRepo.grnCount(tx, id);
        const accepted: { it: string; qty: number }[] = [];
        const rejected: { it: string; qty: number }[] = [];
        const moves: Move[] = [];
        const rows: (typeof grns.$inferInsert)[] = [];
        for (const [i, l] of lines.entries()) {
          const r = body.lines[i]!;
          if (!(r.recv > 0)) continue;
          const good = round3(r.recv - r.rejected);
          const grnId = `GRN-${id.slice(-3)}-${String(++n).padStart(2, "0")}`;
          rows.push({
            id: grnId, poId: id, poLineNo: i, itemKey: l.it, acceptedQty: good, rejectedQty: round3(r.rejected),
            batchNo: r.batch.trim(), mrp: r.mrp, mfg: r.mfg, exp: r.exp,
            dcNo: dc, invoiceNo: body.invoice.trim(), invoiceDate: body.invDate || null, at, byUser: claims.sub,
          });
          // Accepted goods go straight onto the central store's shelf; rejected goods go to
          // quarantine, which never sells and never issues. A move of zero is not a movement —
          // and a lock on a cell nothing moves would create a phantom shelf line (M12).
          if (good > 0) { accepted.push({ it: l.it, qty: good }); moves.push({ loc: STORE, it: l.it, qty: good, kind: "grn_accept", refType: "grn", refId: grnId, by: claims.sub, at }); }
          if (r.rejected > 0) { rejected.push({ it: l.it, qty: round3(r.rejected) }); moves.push({ loc: QUARANTINE, it: l.it, qty: round3(r.rejected), kind: "grn_reject", refType: "grn", refId: grnId, by: claims.sub, at }); }
          await grnRepo.setLineReceipt(tx, id, i, { receivedQty: round3(l.recv + r.recv), rejectedQty: round3(l.rejected + r.rejected) });
        }
        const written = await grnRepo.insertGrns(tx, rows);
        await postMoves(tx, moves);

        const after = lines.map((l, i) => ({ qty: l.qty, recv: round3(l.recv + (body.lines[i]!.recv > 0 ? body.lines[i]!.recv : 0)) }));
        const st = receiptStatus(after);
        assertTransition(PO_TRANSITIONS, o.status, st, id);
        await grnRepo.setStatus(tx, id, { status: st, receivedAt: at });
        const who = await grnRepo.userName(tx, claims.sub);
        await appendHistory(tx, "purchase_order", id, st, who, at);

        const unitOf = (it: string) => master.items[it]?.u ?? "nos";
        const changed = ["po", "grn", "stock"] as const;
        await emitChanged(tx, changed);
        return {
          result: { po: await grnRepo.wire(tx, id), grns: await grnRepo.wireGrns(tx, written.map((g) => g.id)) },
          changed: [...changed],
          message: rejected.length > 0
            ? `Booked into ${master.locations[STORE]?.n ?? STORE} — ${unitTotal(accepted, unitOf)} accepted, ${unitTotal(rejected, unitOf)} rejected`
            : `Booked into ${master.locations[STORE]?.n ?? STORE} — ${written.length} batch(es) against ${dc}`,
        };
      });
    },
```
with `const STORE = "store";` and `const QUARANTINE = "quarantine";` at the top of the file (the second imported from `@rch/contract`, which declares it — do not retype the literal).

`closeShort` follows its row of the rules table:
```ts
        const o = await grnRepo.head(tx, id);
        if (!o) throw new NotFoundError(`There is no purchase order ${id}.`);
        assertRule(o.status === "Partially received", `${id} is ${o.status.toLowerCase()} — only a partly received order can be closed short`);
        assertRule(body.reason.trim().length > 0, "Give a reason for closing this order short");
        const lines = await grnRepo.lines(tx, id);
        const src = await grnRepo.sources(tx, id);
        // The balance never arrived, so give the demand back to the store keeper rather than
        // letting it vanish — last source first, the same direction a cut line releases in.
        const back = foldClaims(shortfallClaims(lines.map((l, i) => ({ qty: l.qty, recv: l.recv, src: src.get(i) ?? [] }))));
        await grnRepo.lockRequisitions(tx, back.map((x) => x.prq));
        await grnRepo.addOrdered(tx, back, -1);
        await grnRepo.setStatus(tx, id, { status: "Received", shortNote: body.reason });
        const who = await grnRepo.userName(tx, claims.sub);
        // The status is Received because that is the PoStatus it lands in; the trail has to say
        // it was closed rather than filled, so the history row carries the other word.
        await appendHistory(tx, "purchase_order", id, "Closed short", who);
```

- [ ] **Step 4: Mount them**

```ts
  // Buying's one ledger write, and the door that gives an undelivered balance back. The store
  // keeper receives at the door and the buyer receives against the order they raised.
  mount(app, routes.receivePo, async (req) => svc.receive(req.user, req.params.id, req.body));
  mount(app, routes.closePoShort, async (req) => svc.closeShort(req.user, req.params.id, req.body));
```

- [ ] **Step 5: Prove the cache against the ledger by hand**

On a seeded local database (`pnpm db:up && pnpm --filter @rch/api db:migrate && pnpm --filter @rch/api db:seed --force`, API running):
```bash
API=http://localhost:3000/api/v1
STORE=$(curl -sS -X POST $API/auth/login -H 'content-type: application/json' -d '{"emp":"RC-2088","password":"changeme"}' | jq -r .accessToken)
curl -sS -X POST $API/purchase-orders/PO-2026-0141/receive -H "Authorization: Bearer $STORE" -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"dc":"DC-99001","invoice":"INV/SBD/771","invDate":"2026-09-04","lines":[{"recv":120,"rejected":12,"batch":"SBD-771","mrp":20,"mfg":"2026-08-01","exp":"2027-08-01"},{"recv":0}]}' | jq -r .message
curl -sS -H "Authorization: Bearer $STORE" $API/stock > /tmp/rch-before.json
pnpm --filter @rch/api db:rebuild-balances
curl -sS -H "Authorization: Bearer $STORE" $API/stock > /tmp/rch-after.json
diff /tmp/rch-before.json /tmp/rch-after.json && echo "balances reconcile"
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @rch/api test src/modules/grn` → PASS.
Then `pnpm turbo typecheck test && pnpm lint` — `scripts/check-boundaries.sh` included: the module writes `grns`, `po_lines`, `purchase_orders` and `requisition_lines`, none protected, and every ledger write goes through `postMoves`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/grn
git commit -m "$(cat <<'EOF'
Book the goods in, and give back what never came

A goods receipt is the only write in buying that touches stock, and it only ever adds: accepted
quantity onto the central store's shelf, rejected quantity into quarantine, both in one
postMoves call. Nothing is promised against a balance, so there is no lock of its own and no
post-lock re-read — and a clean delivery posts no reject move at all, because a lock on a cell
nothing moves would leave quarantine carrying a phantom line at zero.

Every line is checked before anything is written. The transaction would roll a half-write back
anyway; checking first is what makes the first bad line the one the store keeper is told about.
The 2% tolerance counts what earlier instalments already booked, and both date checks are string
comparisons on a date that has no time in it to lose.

GRN numbers come from the instalment count for their own order, under that order's row lock —
there is no sequence for them, which is why IdKind has none.

Closing short gives the undelivered balance back to the requisitions that funded it, last source
first, and writes "Closed short" into the trail while the order lands on Received.

Replaces the in-memory receivePo and closePoShort rules pinned by
UI/src/__tests__/procurement.test.ts's "receiving against a purchase order" block, which moves
here in the UI cutover.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `vendors` and `contracts` — the two masters buying is priced off

*(Wave 2, alongside Tasks 4–7 and 9. It owns `apps/api/src/modules/vendors/**` and `apps/api/src/modules/contracts/**` — two directories, no file shared with anyone.)*

**Why one task for two modules.** Both are small master-data CRUD over a table Phase 1 created, neither writes a ledger move or a claim, and both are read by the same screens. Splitting them would give a reviewer two gates over one kind of change.

**Files:**
- Modify: `apps/api/src/modules/vendors/{repo.ts,service.ts,routes.ts,vendors.test.ts}`, `apps/api/src/modules/contracts/{repo.ts,service.ts,routes.ts,contracts.test.ts}`

**Interfaces:**
- Produces:
  ```ts
  // vendors
  createVendorsService(db) => { create, patch }        // POST /vendors, PATCH /vendors/:id
  export const GSTIN_RE: RegExp;                       // module-local, not exported from the package
  // contracts
  createContractsService(db) => { create, patch, remove }
  ```

**Rules, verbatim. Every message except the four marked NEW is the store's current `notify()` text:**

| Endpoint | Rules, in this order | Message |
|---|---|---|
| `POST /vendors` (buyer) | `assertRule(n.trim(), "Give the vendor a name before saving")`; **NEW** `assertRule(!gstin.trim() \|\| GSTIN_RE.test(gstin.trim().toUpperCase()), "That is not a GSTIN — 15 characters, like 33AAACA1234F1Z5")`; `allocateId(tx, "vendor", at)`; insert with `active: true` and `on conflict do nothing … returning` on `vendors_name_ci_uq`; **NEW** `assertRule(inserted, \`${name} is already on the vendor list\`)` | `` `${name} added as ${id}` `` |
| `PATCH /vendors/:id` (buyer) | vendor exists, `for update` (404 `There is no vendor <id>.`); **NEW** `assertRule(Object.keys(body).length > 0, \`Nothing to change on ${id}\`)`; the same name and GSTIN rules for the fields present; update | `active` alone, true: `` `${n} is active again and can be picked on new orders` ``<br>`active` alone, false: `` `${n} deactivated — existing orders keep it, new drafts cannot pick it` ``<br>otherwise: `` `${n} updated` `` |
| `POST /contracts` (store) | vendor exists (404 `There is no vendor <id>.`); item exists (404 `There is no item <key>.`); **NEW** `assertRule(body.to >= body.from, "A contract cannot end before it starts")`; `assertRule(rate > 0, "A contract rate must be more than zero")`; `allocateId(tx, "contract", at)`; insert with `on conflict do nothing … returning` on `rate_contracts_live_uq`; `assertRule(inserted, \`${item.n} already has a live contract with ${vendor.name}\`)` | `` `${id} — ${item.n} at ₹${rate} with ${vendor.name}` `` |
| `PATCH /contracts/:id` (store) | contract exists, `for update` (404 `There is no rate contract <id>.`); the window rule against the merged values; the rate rule when a rate is present; reactivating one is refused when another live contract already covers that vendor and item (the index is the arbiter) with the same "already has a live contract" sentence | `` `${id} updated` `` |
| `DELETE /contracts/:id` (store) | contract exists, `for update`; `active = false` — a soft delete, spec §9.2 | `` `${id} closed — it stays on record but no longer prices an order` `` |

`changed`: `["vendors"]` and `["contracts"]` respectively.

**Read documents back through `GET /snapshot`, not through the six new GETs.** `GET /requisitions`, `/purchase-orders`, `/grns`, `/vendors`, `/contracts` and `/product-requests` are **Task 4's, and Task 4 is in this same wave** — none of them exists when this worktree runs its gate, so a helper that calls one 404s and takes the whole suite with it. Read `GET /snapshot` (Phase 1, always there) and pick the slice: `.prq`, `.po`, `.grn`, `.vendors`, `.contracts`, `.productReqs`. The six standalone reads are asserted in Task 4's own suite and nowhere else.

**The GSTIN pattern, and why it is here rather than in the domain.**
```ts
/** Two state digits, a ten-character PAN, an entity number, a literal Z, and a check character.
 *  Format only: this is not a checksum and does not prove the number is registered. */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
```
It is a validation of one field on one endpoint, with no second consumer: `VendorDrawer.tsx` gains a hint, not a rule (Task 10). A regex nobody else reads does not earn a `packages/domain` module, and §5.1's rule is about rules two sides enforce.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/vendors/vendors.test.ts` — the header shape of Task 5's suite with `schema: "vendors"`, plus `patch(u, url, payload)` and `del(u, url)` alongside `post`, `given`/`warmPool` imported, and a `vendorsList()` that reads **`GET /snapshot`'s `.vendors` slice** as `u5` — `GET /vendors` is Task 4's and lands in this same wave. `contracts.test.ts` is the same with `schema: "contracts"`, a `contractsList()` reading `GET /snapshot`'s `.contracts` as `u3`, and a `getItems()` reading `GET /items` (a Phase 1 route, so that one is safe; the item names in its assertions come from the master, not from this file):
```ts
describe("POST /vendors", () => {
  it("adds a vendor with the next id, active by default", async () => {
    const r = await post("u5", "/vendors", { n: "Kumaran Traders", gstin: "33AAACA1234F1Z5", contact: "Kumar S", ph: "98430 11220", terms: "30 days", lead: 2, groups: ["Grocery"] });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ n: "Kumaran Traders", active: true, lead: 2, groups: ["Grocery"] });
    expect(b.result.id).toMatch(/^VN-\d{3}$/);
    expect(b.changed).toEqual(["vendors"]);
    expect(b.message).toBe(`Kumaran Traders added as ${b.result.id}`);
  });

  it("refuses a vendor with no name, a malformed GSTIN, and a name already on the list", async () => {
    expect((await post("u5", "/vendors", { n: "   " })).json().error.message).toBe("Give the vendor a name before saving");
    expect((await post("u5", "/vendors", { n: "Bad GST Co", gstin: "33AAACA1234" })).json().error.message)
      .toBe("That is not a GSTIN — 15 characters, like 33AAACA1234F1Z5");
    expect((await post("u5", "/vendors", { n: "aavin dairy depot" })).json().error.message)
      .toBe("aavin dairy depot is already on the vendor list");
    // and an empty GSTIN is fine — the store has always allowed one
    expect((await post("u5", "/vendors", { n: "No GST Traders" })).statusCode).toBe(200);
  });

  it("adds one vendor, not two, when the same name is submitted twice at once", async () => {
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u5", "/vendors", { n: "Twice Traders" }), post("u5", "/vendors", { n: "twice traders" }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
  });
});

describe("PATCH /vendors/:id", () => {
  it("edits in place, and deactivates rather than deletes", async () => {
    const id = await given.vendor(app.testDb!.db, { n: "Editable Traders" });
    expect((await patch("u5", `/vendors/${id}`, { terms: "45 days", lead: 7 })).json())
      .toMatchObject({ result: { terms: "45 days", lead: 7 }, message: "Editable Traders updated" });

    const off = (await patch("u5", `/vendors/${id}`, { active: false })).json();
    expect(off.result.active).toBe(false);
    expect(off.message).toBe("Editable Traders deactivated — existing orders keep it, new drafts cannot pick it");
    const on = (await patch("u5", `/vendors/${id}`, { active: true })).json();
    expect(on.message).toBe("Editable Traders is active again and can be picked on new orders");
    // The record survives: history has to stay readable on the orders it already carries.
    expect((await vendorsList()).some((v: { id: string }) => v.id === id)).toBe(true);
  });

  it("refuses an empty patch, and 404s a vendor that is not there", async () => {
    const id = await given.vendor(app.testDb!.db, {});
    expect((await patch("u5", `/vendors/${id}`, {})).json().error.message).toBe(`Nothing to change on ${id}`);
    expect((await patch("u5", "/vendors/VN-777", { lead: 1 })).json().error.message).toBe("There is no vendor VN-777.");
  });

  it("changes only the field it names — a patch of one does not reset the rest", async () => {
    // The trap `PatchVendorBodySchema` is declared field-by-field to avoid: a partial of a
    // defaulted schema parses {} into { lead: 0, groups: [] }, and every edit would have
    // quietly wiped a vendor's lead time and the groups the procurement list suggests from.
    const id = await given.vendor(app.testDb!.db, { n: "Untouched Traders", lead: 7, groups: ["Dairy", "Bakery"] });
    const b = (await patch("u5", `/vendors/${id}`, { terms: "45 days" })).json();
    expect(b.result).toMatchObject({ terms: "45 days", lead: 7, groups: ["Dairy", "Bakery"] });
  });

  it("is absent for every role but the buyer", async () => {
    const id = await given.vendor(app.testDb!.db, {});
    for (const u of ["u1", "u2", "u3", "u4"]) {
      expect((await patch(u, `/vendors/${id}`, { lead: 1 })).statusCode).toBe(404);
      expect((await post(u, "/vendors", { n: "Nope" })).statusCode).toBe(404);
    }
  });
});
```
`apps/api/src/modules/contracts/contracts.test.ts` — `schema: "contracts"`:
```ts
describe("POST /contracts", () => {
  it("records a rate against a vendor and an item", async () => {
    const b = (await post("u3", "/contracts", { vendorId: "VN-003", it: "bread", rate: 38, from: "2026-04-01", to: "2027-03-31", moq: 20 })).json();
    expect(b.result).toMatchObject({ vendor: "Anandha Provisions", it: "bread", rate: 38, from: "2026-04-01", to: "2027-03-31", moq: 20, active: true });
    expect(b.result.id).toMatch(/^RC-\d+$/);
    expect(b.changed).toEqual(["contracts"]);
    // The item's name comes from the master, so read it rather than typing it — the seed moves.
    const items = await getItems();
    expect(b.message).toBe(`${b.result.id} — ${items.bread.n} at ₹38 with Anandha Provisions`);
  });

  it("refuses a second live contract for the same vendor and item", async () => {
    // RC-101 is Aavin's live milk contract, from the seed.
    const r = await post("u3", "/contracts", { vendorId: "VN-001", it: "milk", rate: 55, from: "2026-04-01", to: "2027-03-31" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${(await getItems()).milk.n} already has a live contract with Aavin Dairy Depot`);
  });

  it("refuses a window that ends before it starts, and a rate of nothing", async () => {
    expect((await post("u3", "/contracts", { vendorId: "VN-003", it: "oil", rate: 120, from: "2027-03-31", to: "2026-04-01" })).json().error.message)
      .toBe("A contract cannot end before it starts");
    expect((await post("u3", "/contracts", { vendorId: "VN-003", it: "oil", rate: 0, from: "2026-04-01", to: "2027-03-31" })).json().error.message)
      .toBe("A contract rate must be more than zero");
  });

  it("404s an unknown vendor or item, and is absent for every role but the store keeper", async () => {
    expect((await post("u3", "/contracts", { vendorId: "VN-777", it: "oil", rate: 1, from: "2026-04-01", to: "2027-03-31" })).json().error.message)
      .toBe("There is no vendor VN-777.");
    expect((await post("u3", "/contracts", { vendorId: "VN-003", it: "nope", rate: 1, from: "2026-04-01", to: "2027-03-31" })).json().error.message)
      .toBe("There is no item nope.");
    for (const u of ["u1", "u2", "u4", "u5"]) {
      expect((await post(u, "/contracts", { vendorId: "VN-003", it: "oil", rate: 1, from: "2026-04-01", to: "2027-03-31" })).statusCode).toBe(404);
    }
  });

  it("records one contract, not two, when the same pair is added twice at once", async () => {
    await warmPool(app.testDb!, 2);
    const body = { vendorId: "VN-004", it: "box", rate: 3, from: "2026-04-01", to: "2027-03-31" };
    const both = await Promise.all([post("u3", "/contracts", body), post("u3", "/contracts", body)]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
  });
});

describe("PATCH and DELETE /contracts/:id", () => {
  it("edits a rate and its window", async () => {
    const id = await given.contract(app.testDb!.db, { vendorId: "VN-005", it: "leaf", rate: 400 });
    const b = (await patch("u3", `/contracts/${id}`, { rate: 420, to: "2026-12-31" })).json();
    expect(b.result).toMatchObject({ rate: 420, to: "2026-12-31" });
    expect(b.message).toBe(`${id} updated`);
  });

  it("closes a contract without deleting it, and lets it be reopened", async () => {
    const id = await given.contract(app.testDb!.db, { vendorId: "VN-005", it: "beans", rate: 900 });
    const b = (await del("u3", `/contracts/${id}`)).json();
    expect(b.result.active).toBe(false);
    expect(b.message).toBe(`${id} closed — it stays on record but no longer prices an order`);
    expect((await contractsList()).some((c: { id: string }) => c.id === id)).toBe(true);
    expect((await patch("u3", `/contracts/${id}`, { active: true })).json().result.active).toBe(true);
  });

  it("will not reopen one into a pair that already has a live contract", async () => {
    const id = await given.contract(app.testDb!.db, { vendorId: "VN-001", it: "milk", rate: 60, active: false });
    const r = await patch("u3", `/contracts/${id}`, { active: true });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${(await getItems()).milk.n} already has a live contract with Aavin Dairy Depot`);
  });

  it("refuses a window that ends before it starts on a patch too, and 404s an unknown id", async () => {
    const id = await given.contract(app.testDb!.db, { vendorId: "VN-005", it: "oil", rate: 120, from: "2026-04-01", to: "2027-03-31" });
    expect((await patch("u3", `/contracts/${id}`, { to: "2026-01-01" })).json().error.message).toBe("A contract cannot end before it starts");
    expect((await patch("u3", "/contracts/RC-777", { rate: 1 })).json().error.message).toBe("There is no rate contract RC-777.");
  });
});
```
Run: `pnpm --filter @rch/api test src/modules/vendors src/modules/contracts` → FAIL (404 everywhere).

**Prove the two race cases.** With the partial unique index dropped by hand (`drop index rate_contracts_live_uq` inside the test schema) the two concurrent contract adds must both return 200. With `vendors_name_ci_uq` dropped, the two concurrent vendor adds must both return 200. Restore the schema (`pnpm --filter @rch/api db:migrate` against a fresh schema) and re-run.

- [ ] **Step 2: Write both modules**

Each follows the `catalog` module exactly: `repo.ts` is SQL only, `service.ts` composes `withTransaction` → `assertRule`/`NotFoundError` → `allocateId` → repo → `emitChanged`. Two implementation details are worth writing out.

*The insert is the arbiter.* Both `POST /vendors` and `POST /contracts` pre-check and then insert with `on conflict do nothing … returning`, asserting on the empty result — `addMenuItem`'s pattern (spec §16, Phase 2). The pre-check reads before the insert takes its lock, so two callers can both pass it; the index decides, and the loser reads the sentence the check would have given it a moment later.
```ts
  async insertIfNew(tx: Tx, row: NewVendor): Promise<VendorRow | undefined> {
    const [v] = await tx.insert(vendors).values(row).onConflictDoNothing().returning();
    return v;
  },
```
For the contract's reactivation (`PATCH { active: true }`), the same conflict target catches it: `onConflictDoNothing` on an `update` is not available, so read the pair under `for update` on the *existing* live contract and refuse before writing —
```ts
  /** Is another live contract already covering this vendor and item? Read `for update` so two
   *  reactivations of two closed contracts for one pair cannot both find the coast clear. */
  async liveFor(tx: Tx, vendorId: string, itemKey: string, exceptId: string): Promise<boolean> {
    const rows = await tx.select({ id: rateContracts.id }).from(rateContracts)
      .where(and(eq(rateContracts.vendorId, vendorId), eq(rateContracts.itemKey, itemKey),
        eq(rateContracts.active, true), ne(rateContracts.id, exceptId))).for("update");
    return rows.length > 0;
  },
```
and let the partial unique index be the backstop that turns a lost race into a 500 nobody has ever seen rather than two live contracts. (If it does fire, the operator's retry reads the ordinary refusal — the row is committed by then.)

*The vendor's message depends on the patch.* `setVendorActive` and `updateVendor` are one endpoint, so the sentence is chosen from the body: a patch whose only key is `active` gets one of the two on/off sentences, anything else gets `<name> updated`.

- [ ] **Step 3: Mount them**

```ts
// vendors/routes.ts — the buyer's own master. One PATCH covers both the edit and the on/off
// switch, because `setVendorActive` was only ever a patch of one field.
  mount(app, routes.addVendor, async (req) => svc.create(req.user, req.body));
  mount(app, routes.updateVendor, async (req) => svc.patch(req.user, req.params.id, req.body));

// contracts/routes.ts — the store keeper records what each vendor has agreed to; the buyer's
// drafts are priced off it. A delete is soft: history has to stay readable.
  mount(app, routes.addContract, async (req) => svc.create(req.user, req.body));
  mount(app, routes.updateContract, async (req) => svc.patch(req.user, req.params.id, req.body));
  mount(app, routes.removeContract, async (req) => svc.remove(req.user, req.params.id));
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @rch/api test src/modules/vendors src/modules/contracts` → PASS, then `pnpm turbo typecheck test && pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/vendors apps/api/src/modules/contracts
git commit -m "$(cat <<'EOF'
Move the vendor list and the rate contracts to the server

Two masters, both written the way the menu already is: the pre-check reads before the insert
takes its lock, so the unique index is the arbiter and the loser of a race reads the ordinary
refusal instead of a primary-key error. A vendor's name is unique case-insensitively and a
vendor and item may hold one live contract at a time, which is what the new partial index says.

A GSTIN is checked for its format when one is given — fifteen characters, two state digits, a
PAN, an entity number, a Z and a check character — and an empty one is still allowed, because
the store has always allowed it.

Neither is ever deleted. A vendor is deactivated and a contract is closed, both staying on
record, because a purchase order raised months ago has to stay readable.

Replaces the in-memory addVendor, updateVendor, setVendorActive, addContract, updateContract
and removeContract rules pinned by UI/src/__tests__/procurement.test.ts's "vendor maintenance"
block, which moves here in the UI cutover.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: A new product, and the shop that asked for it

*(Wave 2, alongside Tasks 4–8. It owns `apps/api/src/modules/catalog/**` and `apps/api/src/modules/productreqs/**` — two directories, no file shared with anyone. `catalog` is otherwise untouched this phase.)*

**Why `POST /items` goes in `catalog` and not a module of its own.** `catalog` is already the item master's own module: it is where a price is set and where an item is listed or delisted at a location. Creating one is the same family, it reuses `loadItems`/`loadLocations` and the module's existing test app, and a seventh module for one endpoint would be a directory with three near-empty files. `master` stays what it is — the master-data **reads** — and `POST /items` mounts beside `savePrice`.

**Why the two are one task.** `answerProductRequest` with `st: "Created"` requires an existing `itemKey`, and the only way to get one is `POST /items`. The buyer's `NewProductDrawer` calls both in a row. A reviewer looking at one wants the other on screen.

**Files:**
- Modify: `apps/api/src/modules/catalog/{repo.ts,service.ts,routes.ts,catalog.test.ts}`, `apps/api/src/modules/productreqs/{repo.ts,service.ts,routes.ts,productreqs.test.ts}`

**Interfaces:**
- Produces:
  ```ts
  // catalog/service.ts — added to what createCatalogService returns
  createItem(claims: AccessClaims, body: CreateItemBody): Promise<WriteResponse<{ key: string; item: Item }>>;
  // productreqs/service.ts
  createProductReqsService(db) => { create, answer }
  ```

**Rules, verbatim. Every message except the five marked NEW is the store's current `notify()` text:**

| Endpoint | Rules, in this order | Message |
|---|---|---|
| `POST /items` (store, prod, buyer) | `assertRule(name.trim(), "Give the product a name")`; **NEW** `assertRule(cost > 0, "Cost must be more than zero")`; **NEW** the location is the caller's to book at — `prod` may name `kitchen` only, `store` and `buyer` may name `store` only, refused with `` `A new product's opening stock is booked at ${LOC[allowed].n}` ``; take `pg_advisory_xact_lock` on the slug; de-duplicate the key with a numeric suffix; insert with `on conflict do nothing … returning` on `items_name_ci_uq`; `assertRule(inserted, \`${name} is already in the catalogue\`)`; when `opening > 0`, one `opening` move at `loc` | opening: `` `${name} added to the catalogue with ${fq(opening, unit)} ${unit} at ${LOC[loc].n}` ``<br>otherwise: `` `${name} added to the catalogue` `` |
| `POST /product-requests` (counter, manager) | `assertRule(name.trim(), "Name the product you want added")`; `allocateId(tx, "product_req", at)`; insert with status `Requested` | `` `${id} sent to the central store — they add it to the master` `` |
| `POST /product-requests/:id/answer` (store, buyer) | request exists, `for update` (404 `There is no product request <id>.`); **NEW** `assertRule(p.status === "Requested", \`${id} has already been answered\`)`; for `Created`: `assertRule(body.itemKey, "Pick the catalogue item this request became")` **NEW**, and the item must exist (404 `There is no item <key>.`); update status, note and `item_key` | created: `` `${id} — product created on the master` ``<br>declined: `` `${id} declined` `` |

`changed`: `POST /items` → `["items"]`, plus `"stock"` when `opening > 0`; the two product-request routes → `["productReqs"]`.

**Three notes the implementer needs.**

*The key, and the advisory lock.* The store slugs the name (`name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12) || "item"`) and, if that key is taken, appends `2`, `3`, … until it is free. Two creates of *different* names can slug the same way (`Cold coffee 1kg` and `Cold coffee 500g` both give `coldcoffee`), and the suffix scan reads before the insert locks — so both would compute `coldcoffee2` and one would die on the primary key with a message about a *name* that is not the problem. Take `pg_advisory_xact_lock(hashtext('item:' || <slug>))` before the scan, exactly as `staffCreditTaken` takes one per payer (spec §16, Phase 3). The **name** clash is still decided by `items_name_ci_uq` and reads the store's own sentence.
```ts
  /** Serialise the suffix scan for one slug, so two different names that slug alike cannot both
   *  compute the same key. Transaction-scoped: it is released with the commit or the rollback. */
  async lockSlug(tx: Tx, slug: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"item:" + slug}))`);
  },
```

*The defaults are the store's, not new ones.* `unit` "nos", `hsn` "2106", `gst` 5, `grp` "Other", `code` `key.toUpperCase()`, `reorder` 0, `mrp` and `sl` omitted when zero or absent. Read `createItem` in `UI/src/store/ops.ts` and copy them; a default invented here is a product change.

*The location rule, and what it is derived from.* `prod`'s new-product drawer books at the kitchen (`UI/src/roles/prod/Stock.tsx`) and the buyer's books at the store with no opening quantity (`UI/src/roles/buyer/NewProductDrawer.tsx`); the store's own drawer (Task 10 builds it) books at the store. That is what the rule encodes — it is §8.3's "location decides which rows", not a new restriction. Note that `allowed` is derived from **`claims.role`, not `claims.loc`**: the buyer's own `loc` is `store` and the kitchen in-charge's is `kitchen`, so the two agree today, but if §8.3's location scoping is ever applied here the derivation is the line to change.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/modules/catalog/catalog.test.ts` (reuse its `hdr`, `post`, `get` helpers exactly as they are):
```ts
describe("catalog: a new product on the master", () => {
  const base = { name: "Cold coffee premix 1kg", unit: "kg", type: "RAW" as const, cost: 320, loc: "store" as const, opening: 0 };

  it("adds an item, chooses its key, and applies the store's own defaults", async () => {
    const r = await post("/items", await hdr("u3"), base);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.key).toBe("coldcoffeepr");                // the name, slugged and cut to 12
    expect(b.result.item).toMatchObject({ n: base.name, u: "kg", t: "RAW", g: "Other", hsn: "2106", gst: 5, cost: 320, c: "COLDCOFFEEPR" });
    expect(b.result.item.mrp).toBeUndefined();
    expect(b.changed).toEqual(["items"]);
    expect(b.message).toBe("Cold coffee premix 1kg added to the catalogue");
    expect((await get("/items"))[b.result.key]).toMatchObject({ n: base.name });
  });

  it("books opening stock as an opening move, and says where", async () => {
    const r = await post("/items", await hdr("u4"), { ...base, name: "Kitchen premix 2kg", loc: "kitchen", opening: 12 });
    const b = r.json();
    expect(b.changed).toEqual(["items", "stock"]);
    expect(b.message).toBe("Kitchen premix 2kg added to the catalogue with 12.000 kg at Central Kitchen");
    const moves = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.itemKey, b.result.key));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ kind: "opening", loc: "kitchen", qty: 12, refType: "item" });
  });

  it("leaves no balance row at all when nothing is booked in", async () => {
    // A row's presence means "this location carries the line" (M12); a new item nobody has
    // bought yet carries nowhere, and the store's list shows it because it unions the catalogue.
    const b = (await post("/items", await hdr("u3"), { ...base, name: "Nothing yet 1kg" })).json();
    expect(await app.testDb!.db.select().from(stockBalances).where(eq(stockBalances.itemKey, b.result.key))).toHaveLength(0);
  });

  it("de-duplicates a key with a numeric suffix, and still refuses a duplicate name", async () => {
    // Two different names that slug the same way inside twelve characters — which is exactly
    // the case the advisory lock on the slug exists for.
    const one = (await post("/items", await hdr("u3"), { ...base, name: "Masala tea premix A" })).json();
    const two = (await post("/items", await hdr("u3"), { ...base, name: "Masala tea premix B" })).json();
    expect(one.result.key).toBe("masalateapre");
    expect(two.result.key).toBe("masalateapre2");             // the slug is taken, so a suffix
    const dup = await post("/items", await hdr("u3"), { ...base, name: "masala TEA premix a" });
    expect(dup.statusCode).toBe(422);
    expect(dup.json().error.message).toBe("masala TEA premix a is already in the catalogue");
  });

  it("refuses a nameless product and one that costs nothing", async () => {
    expect((await post("/items", await hdr("u3"), { ...base, name: "  " })).json().error.message).toBe("Give the product a name");
    expect((await post("/items", await hdr("u3"), { ...base, name: "Free stuff", cost: 0 })).json().error.message).toBe("Cost must be more than zero");
  });

  it("books at the caller's own shelf and nowhere else", async () => {
    expect((await post("/items", await hdr("u4"), { ...base, name: "Wrong shelf 1", loc: "store" })).json().error.message)
      .toBe("A new product's opening stock is booked at Central Kitchen");
    expect((await post("/items", await hdr("u3"), { ...base, name: "Wrong shelf 2", loc: "kitchen" })).json().error.message)
      .toBe("A new product's opening stock is booked at Central Store");
    expect((await post("/items", await hdr("u5"), { ...base, name: "Buyer's own" })).statusCode).toBe(200);
    for (const u of ["u1", "u2"]) {
      expect((await post("/items", await hdr(u), { ...base, name: "Not yours" })).statusCode).toBe(404);
    }
  });

  it("adds one item, not two, when the same name is submitted twice at once", async () => {
    await warmPool(app.testDb!, 2);
    const body = { ...base, name: "Twice premix 1kg" };
    const both = await Promise.all([post("/items", await hdr("u3"), body), post("/items", await hdr("u3"), body)]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
  });
});
```
`apps/api/src/modules/productreqs/productreqs.test.ts` — `schema: "productreqs"`:
```ts
describe("POST /product-requests", () => {
  it("sends a shop's ask to the central store", async () => {
    const b = (await post("u2", "/product-requests", { name: "Sugar-free lemon iced tea 250ml", why: "Diabetic attenders ask daily", forLoc: "coffee" })).json();
    expect(b.result).toMatchObject({ name: "Sugar-free lemon iced tea 250ml", forLoc: "coffee", st: "Requested", by: "Ramesh Kumar" });
    expect(b.result.id).toMatch(/^NPR-00\d+$/);
    expect(b.changed).toEqual(["productReqs"]);
    expect(b.message).toBe(`${b.result.id} sent to the central store — they add it to the master`);
  });

  it("wants a name, and is open to a counter as well as a manager", async () => {
    expect((await post("u2", "/product-requests", { name: "  ", forLoc: "coffee" })).json().error.message)
      .toBe("Name the product you want added");
    expect((await post("u1", "/product-requests", { name: "Something", forLoc: "coffee" })).statusCode).toBe(200);
    for (const u of ["u3", "u4", "u5"]) {
      expect((await post(u, "/product-requests", { name: "Something", forLoc: "coffee" })).statusCode).toBe(404);
    }
  });
});

describe("POST /product-requests/:id/answer", () => {
  it("links a request to the item it became", async () => {
    const id = await given.productRequest(app.testDb!.db, { name: "Iced lemon tea 300ml" });
    const b = (await post("u5", `/product-requests/${id}/answer`, { st: "Created", note: "Added as MR-3005", itemKey: "bisc" })).json();
    expect(b.result).toMatchObject({ st: "Created", note: "Added as MR-3005", itemKey: "bisc" });
    expect(b.changed).toEqual(["productReqs"]);
    expect(b.message).toBe(`${id} — product created on the master`);
  });

  it("declines with a note", async () => {
    const id = await given.productRequest(app.testDb!.db, { name: "Unobtainable 1kg" });
    const b = (await post("u3", `/product-requests/${id}/answer`, { st: "Declined", note: "Vendor cannot supply reliably" })).json();
    expect(b.result).toMatchObject({ st: "Declined", note: "Vendor cannot supply reliably" });
    expect(b.message).toBe(`${id} declined`);
  });

  it("will not mark one created without the item it became", async () => {
    const id = await given.productRequest(app.testDb!.db, { name: "Ghost 1kg" });
    expect((await post("u5", `/product-requests/${id}/answer`, { st: "Created", note: "" })).json().error.message)
      .toBe("Pick the catalogue item this request became");
    expect((await post("u5", `/product-requests/${id}/answer`, { st: "Created", note: "", itemKey: "nope" })).json().error.message)
      .toBe("There is no item nope.");
  });

  it("answers once, 404s an unknown id, and is absent for a counter or the kitchen", async () => {
    const id = await given.productRequest(app.testDb!.db, { name: "Once only 1kg" });
    await post("u3", `/product-requests/${id}/answer`, { st: "Declined", note: "no" });
    expect((await post("u3", `/product-requests/${id}/answer`, { st: "Declined", note: "no" })).json().error.message)
      .toBe(`${id} has already been answered`);
    expect((await post("u3", "/product-requests/NPR-7777/answer", { st: "Declined", note: "no" })).json().error.message)
      .toBe("There is no product request NPR-7777.");
    for (const u of ["u1", "u2", "u4"]) {
      expect((await post(u, `/product-requests/${id}/answer`, { st: "Declined", note: "no" })).statusCode).toBe(404);
    }
  });
});
```
Run: `pnpm --filter @rch/api test src/modules/catalog src/modules/productreqs` → FAIL.

**Prove the race case.** With `items_name_ci_uq` dropped inside the test schema the two concurrent creates must both return 200; with `lockSlug` commented out, two creates of `Masala tea premix A` and `Masala tea premix B` fired together must fail on the primary key rather than answering `masalateapre`/`masalateapre2`.

- [ ] **Step 2: Write `createItem` in `catalog`**

```ts
    /**
     * A new line on the item master.
     *
     * The key is slugged from the name and de-duplicated with a numeric suffix, exactly as the
     * store keeper's screen has always done it. Two different names can slug the same way, and
     * the suffix scan reads before the insert takes its lock, so the scan runs under an advisory
     * lock on the slug — the device the staff-credit sum already uses. The **name** clash is a
     * different question and is decided by `items_name_ci_uq`: the pre-check reads, the insert
     * arbitrates, and the loser reads the store's own sentence.
     */
    async createItem(claims: AccessClaims, body: CreateItemBody): Promise<WriteResponse<{ key: string; item: Item }>> {
      return withTransaction(db, async (tx) => {
        const name = body.name.trim();
        assertRule(name.length > 0, "Give the product a name");
        assertRule(body.cost > 0, "Cost must be more than zero");
        // §8.3: location decides which rows. The kitchen books what it makes at the kitchen;
        // the store keeper and the buyer book at the central store.
        const allowed = claims.role === "prod" ? "kitchen" : "store";
        const locations = await loadLocations(tx);
        assertRule(body.loc === allowed, `A new product's opening stock is booked at ${locations[allowed]?.n ?? allowed}`);

        const slug = (body.key.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12) || "item");
        await catalogRepo.lockSlug(tx, slug);
        const taken = await catalogRepo.keysLike(tx, slug);
        let key = slug;
        for (let n = 2; taken.has(key); n += 1) key = `${slug}${n}`;

        const at = new Date();
        const row = await catalogRepo.insertItem(tx, {
          key, code: body.code.trim() || key.toUpperCase(), name, unit: body.unit || "nos",
          type: body.type, grp: body.grp.trim() || "Other", hsn: body.hsn.trim() || "2106",
          gst: body.gst, reorderLevel: round3(body.reorder), cost: body.cost,
          mrp: body.mrp && body.mrp > 0 ? body.mrp : null,
          shelfLifeHours: body.sl && body.sl > 0 ? body.sl : null, active: true, createdAt: at, updatedAt: at,
        });
        assertRule(row, `${name} is already in the catalogue`);

        const opening = round3(body.opening);
        // A move of zero is not a movement, and a balance row's presence means "this location
        // carries the line" (M12) — a product nobody has bought yet carries nowhere.
        if (opening > 0) {
          await postMoves(tx, [{ loc: body.loc, it: key, qty: opening, kind: "opening", refType: "item", refId: key, by: claims.sub, at }]);
        }
        const changed = (opening > 0 ? ["items", "stock"] : ["items"]) as Changed[];
        await emitChanged(tx, changed);
        const item = toWireItem(row);
        return {
          result: { key, item }, changed,
          message: opening > 0
            ? `${name} added to the catalogue with ${fq(opening, item.u)} ${item.u} at ${locations[body.loc]?.n ?? body.loc}`
            : `${name} added to the catalogue`,
        };
      });
    },
```
with `catalogRepo.keysLike(tx, slug)` returning `Set<string>` of every item key equal to the slug or the slug plus digits (`like ${slug} || '%'` is enough — the caller only tests membership), `catalogRepo.insertItem` doing `onConflictDoNothing().returning()`, and `toWireItem` from `../../lib/wire.js`.

Mount it in `catalog/routes.ts`:
```ts
  // The item master's own module: a price, a menu line, and — from Phase 5 — a new line on it.
  mount(app, routes.createItem, async (req) => svc.createItem(req.user, req.body));
```

- [ ] **Step 3: Write `productreqs`**

Straightforward: `create` allocates `product_req` and inserts with status `Requested`; `answer` reads `for update`, guards `Requested`, resolves the item when `Created`, updates and answers. Neither writes stock or history — `product_requests` is not one of the four document types that write `document_history` (spec §16, Phase 1), and nothing about this phase changes that.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @rch/api test src/modules/catalog src/modules/productreqs` → PASS, then `pnpm turbo typecheck test && pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/catalog apps/api/src/modules/productreqs
git commit -m "$(cat <<'EOF'
Add a product to the master on the server, and answer the shop that asked for one

A new item joins the catalogue with the key the store keeper's screen would have chosen — the
name slugged, de-duplicated with a numeric suffix — and the defaults it has always applied.
The suffix scan runs under an advisory lock on the slug, because two different names can slug
the same way and the scan reads before the insert locks; the name clash itself is decided by
the unique index and reads the store's own refusal.

Opening stock, when there is any, is an opening move at the caller's own shelf: the kitchen
books what it makes at the kitchen, the store keeper and the buyer at the central store. None
at all writes no move and no balance row, so a product nobody has bought yet is carried
nowhere rather than carried at zero.

A shop's ask for something not on the master, and the central store's answer to it. Marking one
created needs the catalogue item it became, which is the whole point of the link.

Replaces the in-memory createItem, requestNewProduct and answerProductRequest rules pinned by
UI/src/__tests__/fixes.test.ts's "a new product a shop wants goes to procurement" block, which
moves here in the UI cutover.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: UI cutover — buying's screens call the server

*(Wave 3, alone. It owns every file under `UI/src/` that Phase 5 touches. Nothing else is in flight. **It does not touch `UI/src/lib/fmt.ts`** — Task 2 finished that file in wave 1.)*

**Files:**
- Create: `UI/src/roles/store/NewProductDrawer.tsx`
- Modify: `UI/src/store/{procurement.ts,ops.ts,index.ts}`, `UI/src/api/{refetch.ts,wire.ts}`, `UI/src/data/master.ts`, `UI/src/lib/selectors.ts`, `UI/src/roles/buyer/{VendorDrawer,RequisitionDrawer,ProcurementList,PoDrawer,PoReceiptDrawer,NewProductDrawer,NewProducts,PurchaseOrders}.tsx`, `UI/src/roles/store/{Requisitions,Contracts,Stock,index}.tsx`, `UI/src/roles/manager/ItemsStock.tsx`, `UI/src/roles/prod/Stock.tsx`, `UI/src/__tests__/{fixture.ts,writes.test.ts,procurement.test.ts,fixes.test.ts}`

**Interfaces:**
- Consumes: every write route from Task 1, every read route from Task 4; `call`, `ApiError` from `../api/client`; `refetch` from `../api/refetch`; `PO_TRANSITIONS`, `canTransition`, `poValue`, `needsApproval` from `@rch/domain`; `PO_APPROVAL_LIMIT` from `@rch/contract` (re-exported by `UI/src/data/master.ts` as it already is); `toInputDate`, `fromInputDate` from `../lib/fmt` (Task 2 — **this task does not edit `fmt.ts`**).
- Produces:
  ```ts
  // UI/src/store/procurement.ts — every action's type changes
  addVendor:           (v: Omit<Vendor, "id" | "active">) => Promise<boolean>;
  updateVendor:        (id: string, patch: Partial<Vendor>) => Promise<boolean>;
  setVendorActive:     (id: string, active: boolean) => Promise<void>;
  approveRequisition:  (prqId: string, appr: number[], note: string) => Promise<boolean>;
  declineRequisition:  (prqId: string, note: string) => Promise<boolean>;
  /** The new draft's id, or null when the server refused — the list needs it to navigate. */
  createPo:            (vendorId: string, picks: { prq: string; line: number; qty: number }[]) => Promise<string | null>;
  updatePoLine:        (poId: string, lineIdx: number, patch: { qty?: number; rate?: number }) => Promise<boolean>;
  removePoLine:        (poId: string, lineIdx: number) => Promise<void>;
  setPoVendor:         (poId: string, vendorId: string) => Promise<void>;
  setPoEta:            (poId: string, eta: string) => Promise<boolean>;
  sendPo:              (poId: string) => Promise<void>;
  cancelPo:            (poId: string, reason: string) => Promise<boolean>;
  receivePo:           (poId: string, doc: ReceiptDoc, lines: ReceiptLine[]) => Promise<boolean>;
  closePoShort:        (poId: string, reason: string) => Promise<boolean>;

  // UI/src/store/ops.ts
  requestNewProduct:   (p: { name: string; why: string; forLoc: LocKey }) => Promise<boolean>;
  answerProductRequest:(id: string, st: "Created" | "Declined", note: string, itemKey?: string) => Promise<boolean>;
  addContract:         (c: Omit<RateContract, "id"> & { vendorId: string }) => Promise<boolean>;
  updateContract:      (id: string, patch: { rate?: number; from?: string; to?: string; moq?: number; active?: boolean }) => Promise<boolean>;
  removeContract:      (id: string) => Promise<void>;
  /** The key the server chose, or null — the drawers need it to link a product request. */
  createItem:          (input: NewItemInput, loc: LocKey, opening: number) => Promise<string | null>;

  // UI/src/store/index.ts
  sendRequisition:     (note: string) => Promise<boolean>;
  // and the `Seq` interface and the `seq` field are deleted outright

  // UI/src/api/wire.ts
  export function applyRequisitions(prq: Snapshot["prq"]): void;
  export function applyPos(po: Snapshot["po"]): void;
  export function applyGrns(grn: Snapshot["grn"]): void;
  export function applyVendors(vendors: Snapshot["vendors"]): void;
  export function applyContracts(contracts: Snapshot["contracts"]): void;
  export function applyProductRequests(rows: Snapshot["productReqs"]): void;
  export function applyItems(items: Snapshot["items"]): void;

  // UI/src/data/master.ts
  export function hydrateItems(items: MasterData["items"]): void;

  // UI/src/lib/selectors.ts
  export const poValue:        (o: PurchaseOrder) => number;   // now a delegate to @rch/domain
  export const canSendPo:      (st: PoStatus) => boolean;
  export const canCancelPo:    (st: PoStatus, anyReceived: boolean) => boolean;
  export const canCloseShort:  (st: PoStatus) => boolean;
  ```

**Which actions carry a form, and what that means.** Phase 3's fix round settled the rule and Phase 4 kept it: an action a screen resets a form for answers `Promise<boolean>` (or `Promise<string | null>` where the screen needs the new id) and the screen awaits it behind a busy lock, so a refusal lands on the operator's own typing rather than on an empty box. A button on a card is `Promise<void>` with no lock. The split is in the Interfaces block above; `setVendorActive`, `removePoLine`, `setPoVendor`, `sendPo` and `removeContract` are the five buttons.

**Which rules are deleted.** All of them, plus two helpers that only existed to serve them: `claim()` and `inDays()` in `store/procurement.ts`, and `slug()` in `store/ops.ts`. What stays in the browser is the *preview*: `procurementList`, `prqProgress`, `onOrder` and `awaitingApproval` in `lib/selectors.ts` are derived from the snapshot and keep working exactly as they do — the M3 duplicate-order guard still needs **both** `onOrder` and `awaitingApproval`, and nothing about that changes. `PoDrawer`'s "off contract" and "deviating rate" badges still read `contractFor`; `ProcurementList`'s `suggestVendor` still suggests.

**One effect is deleted rather than awaited.** `PoDrawer.tsx`'s `useEffect` that re-priced a draft's lines off the rate contract now fires a network write per line on every drawer open. It is gone: `createPo` prices the draft when it is raised and `PATCH /purchase-orders/:id` re-prices it when the vendor moves, both server-side, both with the rule that a hand-negotiated rate is never overwritten (Task 6). Delete the effect, its `priced` ref and the `useEffect`/`useRef` imports if nothing else in the file needs them.

- [ ] **Step 1: Write the failing wire tests**

Append to `UI/src/__tests__/writes.test.ts` (reuse its `serve`, `json`, `refusal`, `hit`, `calls`, `STOCK` and `snapshot` helpers exactly as they are). These pin **which route each action calls, what it puts in the body, and which reads it pulls back** — nothing here re-asserts a rule, which is the server's suites' job.
```ts
const PRQ = { ...FX.seedPrq[3], st: "Approved" };            // PRQ-2026-013, decided
const PO = { ...FX.seedPo[2], st: "Ordered" };               // PO-2026-0140, sent
const GRN = { ...FX.seedGrn[0], id: "GRN-140-01", po: PO.id };

describe("sendRequisition — POST /requisitions", () => {
  it("sends the draft's lines and the note, clears the draft, and pulls the desk back", async () => {
    as("store");
    S().setPrqDraft([{ it: "milk", qty: 60 }, { it: "butter", qty: 0 }]);
    serve({
      "POST /api/v1/requisitions": () => json({ result: PRQ, changed: ["prq"], message: `${PRQ.id} sent to procurement` }),
      "GET /api/v1/requisitions": () => json([PRQ]),
    });

    expect(await S().sendRequisition("Weekly dairy")).toBe(true);

    // A zero line is client-side noise, not something to send and have refused.
    expect(hit("POST /api/v1/requisitions")[0].body).toEqual({ lines: [{ it: "milk", qty: 60 }], note: "Weekly dairy" });
    expect(hit("GET /api/v1/requisitions")).toHaveLength(1);
    expect(S().prqDraft).toEqual([]);
    expect(S().toast).toBe(`${PRQ.id} sent to procurement`);
  });

  it("keeps the draft when the server refuses", async () => {
    as("store");
    S().setPrqDraft([{ it: "milk", qty: 60 }]);
    serve({ "POST /api/v1/requisitions": () => refusal("Combine the Milk 1L (toned) lines into one") });
    expect(await S().sendRequisition("")).toBe(false);
    expect(S().prqDraft).toHaveLength(1);
    expect(S().toast).toBe("Combine the Milk 1L (toned) lines into one");
  });
});

describe("createPo — POST /purchase-orders", () => {
  it("sends the vendor and the picks, and answers with the new draft's id", async () => {
    as("buyer");
    serve({
      "POST /api/v1/purchase-orders": () => json({ result: PO, changed: ["po", "prq"], message: `${PO.id} drafted on Anandha Provisions — 1 line(s), review the rates before sending` }),
      "GET /api/v1/purchase-orders": () => json([PO]),
      "GET /api/v1/requisitions": () => json([PRQ]),
    });

    const picks = [{ prq: PRQ.id, line: 0, qty: 30 }];
    expect(await S().createPo("VN-003", picks)).toBe(PO.id);

    expect(hit("POST /api/v1/purchase-orders")[0].body).toEqual({ vendorId: "VN-003", picks });
    expect(hit("GET /api/v1/purchase-orders")).toHaveLength(1);
    expect(hit("GET /api/v1/requisitions")).toHaveLength(1);
    expect(hit("GET /api/v1/snapshot")).toHaveLength(0);       // both slices have narrow readers
  });

  it("answers null on a refusal so the list can stay where it is", async () => {
    as("buyer");
    serve({ "POST /api/v1/purchase-orders": () => refusal(`Milk 1L (toned) — only 20.000 still pending on ${PRQ.id}`) });
    expect(await S().createPo("VN-003", [{ prq: PRQ.id, line: 0, qty: 30 }])).toBeNull();
    expect(S().toast).toBe(`Milk 1L (toned) — only 20.000 still pending on ${PRQ.id}`);
  });
});

describe("the purchase order's other doors", () => {
  const ok = (message: string, changed: string[] = ["po"]) => () => json({ result: PO, changed, message });
  beforeEach(() => {
    as("buyer");
    serve({
      [`PATCH /api/v1/purchase-orders/${PO.id}/lines/0`]: ok("Milk 1L (toned) at ₹58.00"),
      [`DELETE /api/v1/purchase-orders/${PO.id}/lines/0`]: ok("Milk 1L (toned) returned to the procurement list", ["po", "prq"]),
      [`PATCH /api/v1/purchase-orders/${PO.id}`]: ok(`${PO.id} expected 30-Sep-2026`),
      [`POST /api/v1/purchase-orders/${PO.id}/send`]: ok(`${PO.id} raised on Anandha Provisions — expected 31-Aug-2026`),
      [`POST /api/v1/purchase-orders/${PO.id}/cancel`]: ok(`${PO.id} cancelled — 1 line(s) back on the procurement list`, ["po", "prq"]),
      [`POST /api/v1/purchase-orders/${PO.id}/receive`]: () => json({ result: { po: PO, grns: [GRN] }, changed: ["po", "grn", "stock"], message: "Booked into Central Store — 1 batch(es) against DC-88214" }),
      [`POST /api/v1/purchase-orders/${PO.id}/close-short`]: ok(`${PO.id} closed short — the undelivered balance is back on the procurement list`, ["po", "prq"]),
      "GET /api/v1/purchase-orders": () => json([PO]),
      "GET /api/v1/requisitions": () => json([PRQ]),
      "GET /api/v1/grns": () => json([GRN]),
      "GET /api/v1/stock": () => json(STOCK),
    });
  });

  it("puts a line's quantity and a line's rate in the same PATCH body, one field each", async () => {
    await S().updatePoLine(PO.id, 0, { rate: 58 });
    expect(hit(`PATCH /api/v1/purchase-orders/${PO.id}/lines/0`)[0].body).toEqual({ rate: 58 });
    await S().updatePoLine(PO.id, 0, { qty: 40 });
    expect(hit(`PATCH /api/v1/purchase-orders/${PO.id}/lines/0`)[1].body).toEqual({ qty: 40 });
  });

  it("sends a vendor change and a date change through the order's own PATCH", async () => {
    await S().setPoVendor(PO.id, "VN-002");
    expect(hit(`PATCH /api/v1/purchase-orders/${PO.id}`)[0].body).toEqual({ vendorId: "VN-002" });
    await S().setPoEta(PO.id, "2026-09-30");
    expect(hit(`PATCH /api/v1/purchase-orders/${PO.id}`)[1].body).toEqual({ eta: "2026-09-30" });
  });

  it("sends the receipt's paperwork and every line, and reads stock and the GRNs back", async () => {
    const doc = { dc: "DC-88214", invoice: "INV/AAV/4472", invDate: "2026-09-04" };
    const lines = [{ recv: 30, rejected: 2, batch: "AAV-8893", mrp: 0, mfg: "2026-09-01", exp: "2027-09-01" }];
    expect(await S().receivePo(PO.id, doc, lines)).toBe(true);
    expect(hit(`POST /api/v1/purchase-orders/${PO.id}/receive`)[0].body).toEqual({ ...doc, lines });
    expect(hit("GET /api/v1/grns")).toHaveLength(1);
    expect(hit("GET /api/v1/stock")).toHaveLength(1);
    expect(S().grn[0].id).toBe(GRN.id);
  });

  it("keeps a refusal's words and changes nothing", async () => {
    serve({ [`POST /api/v1/purchase-orders/${PO.id}/cancel`]: () => refusal(`${PO.id} already received against — close it short instead of cancelling`) });
    expect(await S().cancelPo(PO.id, "no reason")).toBe(false);
    expect(S().toast).toBe(`${PO.id} already received against — close it short instead of cancelling`);
    expect(S().po.find((o) => o.id === PO.id)!.st).toBe(FX.seedPo[2].st);
  });
});

describe("vendors, contracts and a new product", () => {
  const V = { ...FX.seedVendors[0], id: "VN-006", n: "Kumaran Traders" };
  const C = { id: "RC-109", vendor: "Aavin Dairy Depot", it: "bread", rate: 38, from: "2026-04-01", to: "2027-03-31", moq: 20, active: true };
  const NPR = { id: "NPR-0013", name: "Iced lemon tea 300ml", why: "", forLoc: "kiosk", by: "Ramesh Kumar", at: "2026-09-04T04:30:00.000Z", st: "Requested" };

  it("posts a vendor and patches one, including the on-off switch", async () => {
    as("buyer");
    serve({
      "POST /api/v1/vendors": () => json({ result: V, changed: ["vendors"], message: `Kumaran Traders added as ${V.id}` }),
      [`PATCH /api/v1/vendors/${V.id}`]: () => json({ result: { ...V, active: false }, changed: ["vendors"], message: "Kumaran Traders deactivated — existing orders keep it, new drafts cannot pick it" }),
      "GET /api/v1/vendors": () => json([V]),
    });
    expect(await S().addVendor({ n: "Kumaran Traders", gstin: "", contact: "", ph: "", terms: "", lead: 2, groups: ["Grocery"] })).toBe(true);
    expect(hit("POST /api/v1/vendors")[0].body).toMatchObject({ n: "Kumaran Traders", lead: 2, groups: ["Grocery"] });
    await S().setVendorActive(V.id, false);
    expect(hit(`PATCH /api/v1/vendors/${V.id}`)[0].body).toEqual({ active: false });
    expect(hit("GET /api/v1/vendors")).toHaveLength(2);
  });

  it("posts a contract by vendor id, not by the name on screen", async () => {
    as("store");
    serve({
      "POST /api/v1/contracts": () => json({ result: C, changed: ["contracts"], message: `${C.id} — Bread loaf, white at ₹38 with Aavin Dairy Depot` }),
      [`DELETE /api/v1/contracts/${C.id}`]: () => json({ result: { ...C, active: false }, changed: ["contracts"], message: `${C.id} closed — it stays on record but no longer prices an order` }),
      "GET /api/v1/contracts": () => json([C]),
    });
    expect(await S().addContract({ vendorId: "VN-001", vendor: "Aavin Dairy Depot", it: "bread", rate: 38, from: "2026-04-01", to: "2027-03-31", moq: 20, active: true })).toBe(true);
    expect(hit("POST /api/v1/contracts")[0].body).toEqual({ vendorId: "VN-001", it: "bread", rate: 38, from: "2026-04-01", to: "2027-03-31", moq: 20 });
    await S().removeContract(C.id);
    expect(S().contracts.find((x) => x.id === C.id)!.active).toBe(false);
  });

  it("answers with the key the server chose, and refetches the catalogue", async () => {
    as("buyer");
    const items = { ...FX.IT, icedlemontea: { c: "MR-3005", n: "Iced lemon tea 300ml", u: "nos", t: "MRP", g: "Snacks", hsn: "2106", gst: 5, rl: 0, cost: 18, mrp: 25 } };
    serve({
      "POST /api/v1/items": () => json({ result: { key: "icedlemontea", item: items.icedlemontea }, changed: ["items"], message: "Iced lemon tea 300ml added to the catalogue" }),
      "GET /api/v1/items": () => json(items),
    });
    const key = await S().createItem({ key: "", name: "Iced lemon tea 300ml", code: "", unit: "nos", type: "MRP", group: "", hsn: "", gst: 5, reorder: 0, cost: 18, mrp: 25 }, "store", 0);
    expect(key).toBe("icedlemontea");
    expect(hit("POST /api/v1/items")[0].body).toMatchObject({ name: "Iced lemon tea 300ml", type: "MRP", cost: 18, mrp: 25, loc: "store", opening: 0 });
    // The registry every screen reads is refreshed, and catalogVersion is what tells React.
    expect(IT.icedlemontea).toBeDefined();
    expect(S().catalogVersion).toBeGreaterThan(0);
  });

  it("raises a shop's ask and answers it, linking the item it became", async () => {
    as("manager");
    serve({
      "POST /api/v1/product-requests": () => json({ result: NPR, changed: ["productReqs"], message: `${NPR.id} sent to the central store — they add it to the master` }),
      [`POST /api/v1/product-requests/${NPR.id}/answer`]: () => json({ result: { ...NPR, st: "Created", itemKey: "bisc" }, changed: ["productReqs"], message: `${NPR.id} — product created on the master` }),
      "GET /api/v1/product-requests": () => json([NPR]),
    });
    expect(await S().requestNewProduct({ name: "Iced lemon tea 300ml", why: "Warm-weather demand", forLoc: "kiosk" })).toBe(true);
    expect(hit("POST /api/v1/product-requests")[0].body).toEqual({ name: "Iced lemon tea 300ml", why: "Warm-weather demand", forLoc: "kiosk" });
    as("buyer");
    expect(await S().answerProductRequest(NPR.id, "Created", "Added as MR-3005", "bisc")).toBe(true);
    expect(hit(`POST /api/v1/product-requests/${NPR.id}/answer`)[0].body).toEqual({ st: "Created", note: "Added as MR-3005", itemKey: "bisc" });
  });
});
```
with `IT` imported from `../data/master`.

Run: `npx vitest run src/__tests__/writes.test.ts` from inside `UI/` → FAIL (every action is still local and calls nothing).

- [ ] **Step 2: The narrow readers and the wire**

`UI/src/data/master.ts` — one function, beside `hydrateMaster`:
```ts
/** Just the item master, for a write that added one (`POST /items` names "items"). The registry
 *  keeps its identity — screens hold a reference to it — so the contents are replaced in place,
 *  and `catalogVersion` in the store is what tells React the lists changed. */
export function hydrateItems(items: MasterData["items"]): void { replaceKeys(IT, items); }
```
`UI/src/api/wire.ts`:
```ts
const ALL_LOC: StockLoc[] = ["store", "kitchen", "rest", "coffee", "kiosk", "quarantine"];
…
/** GET /requisitions -> the desk, times as "HH:MM" and history stamps with them. */
export function applyRequisitions(prq: Snapshot["prq"]): void {
  useApp.setState({ prq: prq.map((p) => ({ ...p, at: t(p.at), hist: hist(p.hist) })) });
}
/** GET /purchase-orders -> the orders. `eta` is a wire date and is shown as DD-MMM-YYYY. */
export function applyPos(po: Snapshot["po"]): void {
  useApp.setState({ po: po.map((o) => ({ ...o, at: t(o.at), eta: fromWireDate(o.eta), recv: o.recv ? t(o.recv) : undefined, hist: hist(o.hist) })) });
}
/** GET /grns -> the receipts. `mfg`, `exp` and `invDate` are the vendor's printed dates, raw. */
export function applyGrns(grn: Snapshot["grn"]): void { useApp.setState({ grn: grn.map((g) => ({ ...g, at: t(g.at) })) }); }
export function applyVendors(vendors: Snapshot["vendors"]): void { useApp.setState({ vendors }); }
export function applyContracts(contracts: Snapshot["contracts"]): void {
  useApp.setState({ contracts: contracts.map((c) => ({ ...c, from: fromWireDate(c.from), to: fromWireDate(c.to) })) });
}
export function applyProductRequests(rows: Snapshot["productReqs"]): void {
  useApp.setState({ productReqs: rows.map((p) => ({ ...p, at: t(p.at) })) });
}
/** GET /items -> the catalogue every screen reads directly. `catalogVersion` is the signal. */
export function applyItems(items: Snapshot["items"]): void {
  hydrateItems(items);
  useApp.setState((s) => ({ catalogVersion: s.catalogVersion + 1 }));
}
```
Each of the six document readers repeats exactly what `applySnapshot` already does for that slice — keep the two in step; if they ever disagree a refetch will silently reformat a date one way and the snapshot the other.

`UI/src/api/refetch.ts` — seven more entries on `NARROW`, and one comment update:
```ts
const NARROW: Partial<Record<Changed, () => Promise<void>>> = {
  bills: () => call(routes.bills).then(applyBills),
  req: () => call(routes.requests).then(applyRequests),
  tkt: () => call(routes.ticketsList).then(applyTickets),
  shopAsks: () => call(routes.shopAsks).then(applyShopAsks),
  pord: () => call(routes.prodOrders).then(applyProdOrders),
  batch: () => call(routes.batches).then(applyBatches),
  prq: () => call(routes.requisitions).then(applyRequisitions),
  po: () => call(routes.purchaseOrders).then(applyPos),
  grn: () => call(routes.grns).then(applyGrns),
  vendors: () => call(routes.vendors).then(applyVendors),
  contracts: () => call(routes.contracts).then(applyContracts),
  productReqs: () => call(routes.productRequests).then(applyProductRequests),
  items: () => call(routes.items).then(applyItems),
};
```
After this every collection a Phase 1–5 write can name has a reader except `prices`, `menu` and `tickets` — so the snapshot fallback is now reached only by the manager's price and menu writes and by Phase 6's support desk. Say so in the function's doc comment.

- [ ] **Step 3: Rewrite `store/procurement.ts`**

The whole file becomes API calls. Delete `claim`, `inDays`, `MON`, the `clone` helper and every import that only served them (`IT`, `LOC`, `poValue`, `procurementList`, `round3`, `fq`, `money`, `money0`, `unitTotal`, `now`) — `knip` and `noUnusedLocals` will tell you which survive. The shape, once, in full; the other thirteen follow it:
```ts
import { routes } from "@rch/contract";
import type { ReceiptDoc, ReceiptLine, Vendor } from "../types";
import type { AppState } from "./index";
import { ApiError, call } from "../api/client";
import { refetch } from "../api/refetch";

type Set_ = (p: Partial<AppState>) => void;
type Get = () => AppState;

/** Every write below is the same three lines: post the body, repeat the sentence the server
 *  answered with, refetch exactly what it said it changed. No rule is previewed here — a
 *  refusal is the server's own words, and the actions that carry a form answer `false` so the
 *  screen can keep what the operator typed in front of them. */
const fail = (get: Get, e: unknown, what: string): false => {
  get().notify(e instanceof ApiError ? e.message : `Could not ${what} — check the connection and try again.`);
  return false;
};

export const createProcurementSlice = (_set: Set_, get: Get): ProcurementSlice => ({
  addVendor: async (v) => {
    try {
      const r = await call(routes.addVendor, { body: { n: v.n.trim(), gstin: v.gstin, contact: v.contact, ph: v.ph, terms: v.terms, lead: v.lead, groups: v.groups } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save the vendor"); }
  },
  …
  createPo: async (vendorId, picks) => {
    try {
      const r = await call(routes.createPo, { body: { vendorId, picks } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return r.result.id;
    } catch (e) { fail(get, e, "raise the order"); return null; }
  },
  …
});
```
The `set` parameter is unused once every action is a call, so the factory takes `_set` (or drops the parameter — check what `store/index.ts`'s spread requires and keep it compiling). Sentences for the `fail` fallbacks, one per action, in the operator's voice: "save the vendor", "save the decision", "raise the order", "change the line", "remove the line", "change the order", "send the order", "cancel the order", "book the goods in", "close the order short".

`setPoVendor` and `setPoEta` both call `routes.patchPo` with one field. `receivePo` sends `{ dc, invoice, invDate, lines }` straight through — the drawer already builds `ReceiptLine[]` positionally, which is exactly what the body wants.

- [ ] **Step 4: Rewrite the four ops actions and `sendRequisition`**

In `store/ops.ts`, `addContract`, `updateContract`, `removeContract`, `requestNewProduct`, `answerProductRequest` and `createItem` become calls in the same shape; `slug` and the `IT[key] = item` mutation are deleted (the refetch is what updates the registry now — spec §10 says so in as many words). `contractRate` stays exactly as it is. The four support actions are untouched: they are Phase 6's.

In `store/index.ts`: `sendRequisition` becomes a call that clears `prqDraft` only on success; the `Seq` interface, the `seq` field in the initial state and `hist` (its last user) are deleted.

- [ ] **Step 5: Selectors, and quarantine in the store's shape**

`UI/src/lib/selectors.ts`:
```ts
export interface StockShape {
  stock: Record<StockLoc, Record<string, number>>;    // quarantine included: the store shows it
  …
}
…
/** The order's value is `@rch/domain`'s arithmetic, not a second copy of it: the server stamps
 *  `needsApproval` from the same function, and two implementations of one number is exactly the
 *  §5.1 defect Phase 5 exists to remove. Kept as a one-line delegate because three screens and
 *  `procurement.test.ts` already import it from here. */
export const poValue = (o: PurchaseOrder) => D.poValue(o.lines);

/** What a button may offer is what the server accepts — one table, two consumers (spec §5.1). */
export const canSendPo = (st: PoStatus) => D.canTransition(D.PO_TRANSITIONS, st, "Ordered");
/** Cancelling is refused at its own door once anything has arrived, so the button asks both. */
export const canCancelPo = (st: PoStatus, anyReceived: boolean) => !anyReceived && D.canTransition(D.PO_TRANSITIONS, st, "Cancelled");
export const canCloseShort = (st: PoStatus) => st === "Partially received";
```
and `store/index.ts`'s `stock` field takes the same type. `PurchaseOrders.tsx` and `PoDrawer.tsx` use the three in place of their inline status comparisons; leave every other status check alone (a filter or a badge is not a control).

- [ ] **Step 6: The screens**

Each form screen gets the same four-line treatment, written once here and applied at every call site listed:
```tsx
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await addVendor(patch);
    setBusy(false);
    if (ok) close();          // clear the form / navigate ONLY on success
  };
  …
  <Btn disabled={busy || !n.trim()} onClick={save}>{busy ? "Saving…" : "Save"}</Btn>
```
- `buyer/VendorDrawer.tsx` — `save()` awaits `addVendor`/`updateVendor` and closes only on success; the Deactivate button awaits `setVendorActive`. Add a GSTIN hint under the field (`Field hint`), matching the server's rule: *"15 characters, like 33AAACA1234F1Z5. Leave it blank if you do not have it yet."* — a hint, not a client-side rule.
- `buyer/RequisitionDrawer.tsx` — `approve`/`decline` awaited behind one busy flag; the drawer closes only on success (the server closes nothing).
- `buyer/ProcurementList.tsx` — `raise()` becomes `async`, awaits each `createPo` in sequence (they claim against the same requisitions, so they must not race each other), collects the ids, and navigates only when at least one came back:
  ```tsx
  const raise = async () => {
    if (busy) return;
    setBusy(true);
    const made: string[] = [];
    for (const o of planned) { const id = await createPo(o.vendor, o.picks); if (id) made.push(id); }
    setBusy(false);
    if (made.length === 0) return;          // every refusal already said why
    if (made.length > 1) notify(`${made.length} draft purchase orders raised across ${made.length} vendors`);
    nav("/orders");
  };
  ```
  and the `before`/`after` `po.length` diff is deleted with it.
- `buyer/PoDrawer.tsx` — delete the re-pricing effect (see above); every line control awaits; Send and Cancel await; `canSendPo`/`canCancelPo` decide whether the two buttons render. **The ETA control converts at the edge** (Global Constraints): the store holds `po.eta` as `"11-Sep-2026"`, and a `type="date"` input renders blank for anything but `YYYY-MM-DD`, so it is `<input type="date" value={toInputDate(po.eta)} onChange={(e) => setPoEta(po.id, e.target.value)} />` — `toInputDate` in, the input's own ISO value straight out to the body, which is what `PatchPoBodySchema.eta`'s `IsoDate` wants. The `DD-Mon-YYYY` text input the drawer has today goes.
- `buyer/PurchaseOrders.tsx` — the list's inline status comparisons become `canSendPo`/`canCancelPo`/`canCloseShort`; its own `LIVE` constant (an open commitment to a vendor, which correctly excludes `Draft`) is **not** merged with `selectors.ts`'s `CLAIMED` — the comment there says why.
- `buyer/PoReceiptDrawer.tsx` — the Rejected column becomes an input (it is fixed at 0 today, with a comment saying there is no reject step; quarantine is the reject step, so the comment goes with it); the button reads **"Book into the central store"** rather than the stale "Book into Procurement Room"; both buttons await behind a busy flag and the drawer closes only on success.
- `buyer/NewProductDrawer.tsx` — `save()` awaits `createItem`, which now returns the key; the `before`/`Object.keys(IT)` diff is deleted; when a request is behind it, `answerProductRequest(req.id, "Created", \`Added as ${IT[key].c}\`, key)` is awaited too, and the drawer closes only when both succeeded.
- `buyer/NewProducts.tsx` — the Decline control awaits.
- `store/Requisitions.tsx` — `send()` awaits `sendRequisition` and clears the note only on success.
- `store/Contracts.tsx` — the vendor control becomes a `<select>` of **active vendors by id** showing their names (the server enforces "vendor and item exist", which is only answerable against an id); `from`/`to` become `<input type="date">` through the same edge conversion as the ETA — `value={toInputDate(draft.from)}`, the input's ISO value posted as-is — while the table below keeps printing `c.from`/`c.to` as the display strings the store holds; `submitAdd`/`saveEdit` await and clear only on success, replacing the `contracts.length` diff.
- `store/NewProductDrawer.tsx` — **new file**, registering `registerDrawer("sitem", NewProductDrawer)`. `store/Stock.tsx` has opened `"sitem"` from two places since the procurement rework and nothing has ever answered it, so the Add product button is dead. Model it on `roles/prod/Stock.tsx`'s drawer, with the store's own scope: every `ItemType`, booking at `store`, opening quantity optional. Import it for its side effect in `store/index.tsx` beside the three already there.
- `store/Stock.tsx` — a Quarantine card under the ledger, listing `Object.keys(s.stock.quarantine)` with `fq`/`U` and the item's name, empty-state *"Nothing has been rejected at goods receipt."* It is a read of a location the store keeper now owns; nothing on it is actionable, because there is no way back out of quarantine (Task 11 parks that).
- `manager/ItemsStock.tsx` — `raiseNew()` awaits `requestNewProduct` and clears its three fields only on success.
- `prod/Stock.tsx` — the kitchen's `save()` awaits `createItem` and closes only on success.

- [ ] **Step 7: Move the tests that moved**

`UI/src/__tests__/fixture.ts` — delete `seq` from `resetStore`, and add `contracts: clone(seedContracts())`, `productReqs: clone(seedProductRequests())` **and `tickets: seedTickets()`** so the ops slice's three collections reset like every other one (import all three from `../data/ops`). `tickets` has never been reset — a pre-existing gap, and the rewritten `fixes.test.ts` case below asserts against the support desk, so it must not read state a previous case left behind.

`UI/src/__tests__/procurement.test.ts` — this file loses every case that drove a store action and keeps every case that reads derived state. **Keep**, unchanged except where noted: `stock locations` — **whose `LOC` assertion already moved in wave 1 (Task 1, F1); leave it exactly as Task 1 left it** and add one line to the same case, `expect(Object.keys(S().stock)).toContain("quarantine")`, which is this task's half of the same fact — `vendor master`, `kitchen distribution`, `procurement list`, `requisition progress`, `onOrder`, `awaitingApproval`, `per-line vendor selection on the procurement list`. **Delete**: `vendor maintenance` → `apps/api/src/modules/vendors/vendors.test.ts`; `requisition approval` and `sending a requisition` → `requisitions.test.ts`; `draft purchase orders` and `sending a purchase order` → `purchaseorders.test.ts`; `receiving against a purchase order` and `end to end: requisition to shelf` → `grn.test.ts` plus Task 11's exit walk; `apportioning a receipt to its sources` → it is `packages/domain/src/apportion.test.ts`'s already.
Four of the kept cases reach their state by calling an action (`procurement list`'s "grows when a new requisition is approved", `requisition progress`'s "reports partly ordered"/"reports partly received, then received", `awaitingApproval`'s "stops counting once the requisition is approved"). Rewrite each to set the state directly — `useApp.setState({ prq: [...], po: [...] })` — because what they are about is the selector, not the write:
```ts
  it("grows when a new requisition is approved", () => {
    const before = procurementList(S()).length;
    useApp.setState({ prq: [{ ...clone(seedPrq[3]), st: "Approved", lines: seedPrq[3].lines.map((l) => ({ ...l, appr: l.qty, ordered: 0 })) }, ...S().prq.filter((p) => p.id !== seedPrq[3].id)] });
    expect(procurementList(S()).length).toBeGreaterThan(before);
  });
```

`UI/src/__tests__/fixes.test.ts` — **M3 stays exactly as it is**: it reads `onOrder` off the seeded state and asserts nothing about a write, and it is the pin on the half of the duplicate-order guard that is easiest to lose. Replace the `a new product a shop wants goes to procurement, not to support` block with a note pointing at the two suites that now hold it (`productreqs.test.ts` for the chain, `catalog.test.ts` for the item), keeping the one assertion that is still this file's business:
```ts
/* -------------------------- a new product goes to procurement, not to support */
describe("a new product a shop wants goes to procurement, not to support", () => {
  // The chain itself is the server's: productreqs.test.ts walks requested -> created with the
  // item it became, and catalog.test.ts pins the item. What is left here is the routing
  // decision this tag was raised for — a product ask is not a support ticket.
  it("has a queue of its own, separate from the support desk", () => {
    expect(S().productReqs.length).toBeGreaterThan(0);
    expect(S().tickets.some((t) => t.subject.toLowerCase().includes("product"))).toBe(false);
  });
});
```

- [ ] **Step 8: Run the tests**

Run: `pnpm turbo typecheck test && pnpm lint` at the repo root.
Expected: PASS. `knip` must stay quiet — `inDays`, `claim` and `slug` are gone, and `UI/src/data/vendors.ts`'s `seedVendors` re-export is still used by `fixture.ts`. If `screens.test.tsx` or `app.test.tsx` goes red, a screen is calling an action with the old signature; the compiler finds those first.

- [ ] **Step 9: Walk it in two browsers**

`pnpm dev`, one window signed in as `RC-2088` (store keeper) and one as `RC-1550` (buyer). Send a requisition in the first; watch it appear on the buyer's desk without a reload. Approve it, raise a draft off the procurement list, watch the store keeper's requisition move to *Partly ordered*. Send the order, receive it with a rejection, and watch the central store's shelf and the quarantine card both move in the store keeper's window. Cancel a different draft and watch its quantity come back onto the list in both. Then refuse one on purpose — a receipt with an expired batch — and confirm the drawer still holds everything that was typed.

- [ ] **Step 10: Commit**

```bash
git add UI/src
git commit -m "$(cat <<'EOF'
Make buying's screens the server's client

Every action in store/procurement.ts and the buying half of store/ops.ts posts a body, repeats
the sentence that came back and refetches exactly what the write named. The claim walk, the
2% tolerance, the expiry rules, the value slab and the rate-contract pricing are all gone from
the browser; what stays is the preview — the derived procurement list, prqProgress, and the
duplicate-order guard that still needs both onOrder and awaitingApproval.

createPo answers with the new draft's id and createItem with the key the server chose, which
retires two places that read the store back to find out what had just happened. The drawer
effect that re-priced a draft off its rate contract is deleted rather than awaited: it would
have fired a write per line on every open, and both places that price a line are server-side
now.

Seven narrow readers land, so no buying write costs a whole snapshot any more. Quarantine
appears on the store keeper's stock screen, and the Add product button that has opened a drawer
nobody registered finally opens one.

Dates stay display strings in the store, as they have since the first snapshot; the two date
inputs buying needs convert at the edge. And selectors' poValue becomes a delegate, so the
order's value is one function rather than the two the server would otherwise have to agree with.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Docs, spec §16, runbook, and the exit check

*(Wave 4, alone and last. It is the only task that edits `docs/`, `README.md`, `CLAUDE.md` and `deploy/RUNBOOK.md`.)*

**Precondition, checked by the controller before dispatch:** Phase 4's own docs commit must already be on the phase branch — the root `CLAUDE.md`, `apps/api/CLAUDE.md` and spec §16's "Amendments recorded during Phase 4" sub-heading. This task rewrites all three and appends a Phase 5 sub-heading below Phase 4's; dispatching it against a tree where Phase 4's docs pass is still uncommitted produces two doc passes over the same paragraphs and a §16 section with the sub-headings out of order. `git log --oneline -5 -- CLAUDE.md docs/superpowers/specs/` before dispatching.

**Files:**
- Modify: `CLAUDE.md`, `apps/api/CLAUDE.md`, `packages/contract/CLAUDE.md`, `packages/domain/CLAUDE.md`, `UI/CLAUDE.md`, `README.md`, `UI/README.md`, `docs/ua-spec.html`, `docs/system-design.html`, `docs/user-flows.html`, `deploy/RUNBOOK.md`, `docs/superpowers/specs/2026-09-03-backend-design.md`

**All of it lands in one commit**, the spec §16 rows included. The five guides are what a fresh agent reads before touching a package; one that still describes Phase 4 sends Phase 6's implementer down a path that no longer exists.

- [ ] **Step 1: The root `CLAUDE.md`**

- *What this is*: "**Phases 1–4 of the backend are implemented**" → "**Phases 1–5**", and rewrite the sentence that follows: the last in-memory paths are the support desk — `raiseTicket`, `replyToTicket`, `setTicketStatus`, `rateTicket` in `store/ops.ts` — which Phase 6 closes along with `UI/src/data/seed.ts`.
- *Domain invariants → "MRP is a hard ceiling"*: add the receipt's half of it — a goods receipt refuses a printed MRP below the item's list-A shelf price, with the same "reprice before selling" sentence the store keeper has always read.
- *Domain invariants → "Nothing is created or destroyed without a document"*: add that a goods receipt is the one buying write that moves stock, that both its moves are positive (`grn_accept` at the central store, `grn_reject` at `quarantine`), and that a delivery with nothing rejected posts no reject move at all, so quarantine never grows a line at zero.
- *Derived state is computed, never stored*: `procurementList`, `prqProgress`, `onOrder` and `awaitingApproval` are unchanged and now read a snapshot the server fills; add that the claim they are derived from — `requisition_lines.ordered_qty` — is the **only** stored number in the procurement list, and that four endpoints move it.
- *The movement rule*: add one line — buying's claim arithmetic is the same shape one layer up. A purchase order **claims**; the goods receipt **moves**. A claim is settled under document row locks, in the order the purchase-order row first and requisition rows second, ascending.
- *Architecture → One Zustand store, three slices*: `procurement.ts` and the buying half of `ops.ts` are API calls; the `Seq` interface is gone entirely.
- *Domain invariants*: add a new bullet — **"A claim comes back the way it went out."** Cutting a purchase-order line, removing it, cancelling the order or closing it short all release the claim **last source first** (`releaseClaim` in `packages/domain/src/claims.ts`), so a shrink and a re-grow land back on the same requisition rather than quietly moving demand between two store keepers.
- *Backend*: status line → "Phases 1–5 (Foundation, Ledger + POS, Movement chain + SSE, Production, Procurement) implemented; phase 6 pending — see spec §14"; note `packages/domain/src/{claims,receipt,purchasing,format}.ts` as the four places buying's shared rules live, and that `quarantine` is a `StockLoc` and not a `LocKey`.
- *Commands*: nothing changes.

- [ ] **Step 2: The four nested guides**

Read each one first; their shape is theirs, not this plan's. Each gains what Phase 5 put in *that* package, in that guide's own voice.

- **`apps/api/CLAUDE.md`** — six new modules (`requisitions`, `purchaseorders`, `grn`, `vendors`, `contracts`, `productreqs`) and one endpoint added to `catalog`, taking the manifest to nineteen writes and six reads more than Phase 4 left. Four rules to state where the guide states rules: (a) **the document lock order** — the purchase-order row before any requisition row, requisition rows ascending, and `createPo` the one write that locks requisitions holding no order lock, which is safe only because it is minting the order; (b) a goods receipt is the phase's only ledger write and it takes **no** `lockBalances` of its own and **no** post-lock re-read, because both its moves are positive — do not add either out of symmetry with `pay`/`handover`/`makeBatch`; (c) a positive move is still only posted for a quantity greater than zero, because `lockBalances` creates the row it locks and a stray zero row reads as "carried" (M12) — that is why a clean delivery posts nothing to quarantine and a new item with no opening stock posts nothing at all; (d) **the insert is the arbiter** for the three uniqueness rules this phase adds (a vendor's name, a live rate contract, an item's name), with the pre-check giving the sentence and the index deciding the race — `addMenuItem`'s pattern. Add `prq`, `po`, `vendor` and `contract` to whatever list of id kinds the guide keeps, and note that a **GRN has no sequence at all**: `GRN-<last 3 of PO>-<nn>` counts that order's own instalments under its row lock.
- **`packages/contract/CLAUDE.md`** — nineteen new write routes and six new reads; `CollectionSchema` gained `"items"`; the one place to say that **`LocKeySchema` is where an operator may act and `StockLocSchema` is where stock may be**, that `quarantine` is only in the second, and that a write body naming a location always takes the first; and one rule about patch bodies — **a `PATCH` body is a `strictObject` of optional, default-free fields, declared explicitly and never as `.partial()` of a defaulted schema**, because Zod carries a default through `.partial()` and the result silently resets every field the caller did not name.
- **`packages/domain/CLAUDE.md`** — four new modules: `claims.ts` (the claim walk, last source first), `receipt.ts` (the eight checks and the 2 % tolerance, in the store keeper's own order), `purchasing.ts` (order value, the finance slab, contract pricing, the ETA), `format.ts` (money, the DD-MMM-YYYY date, the hospital's calendar date, mixed-unit totals — and the note that `credit.ts` and `shelf.ts` now read their formatters from here rather than each keeping a private copy). Two tables joined `transitions.ts`; state the `Partially received` self-edge and why `Ordered → Cancelled` is guarded again at its own door. And restate the rule the package now demonstrates four times over: **a rule two sides enforce lives here; a validation one endpoint runs does not** — which is why the GSTIN pattern stayed in `modules/vendors/service.ts`.
- **`UI/CLAUDE.md`** — `store/procurement.ts` and the buying half of `store/ops.ts` are API calls and hold no rule; `Seq` is gone. Restate the settled pattern with its new members: an action a screen resets a form for answers `Promise<boolean>` (or `Promise<string | null>` where the screen needs the id the server chose — `createPo` and `createItem`), and a button with no form is fire-and-forget. `refetch` now has a narrow reader for every collection except `prices`, `menu` and `tickets`. And the one deletion worth naming: `PoDrawer.tsx`'s re-pricing effect is gone, because both places that price a line are server-side and an effect that writes on render would have fired a request per line on every open.

- [ ] **Step 3: `README.md` and `UI/README.md`**

`README.md`'s status-by-phase section moves Phase 5 to done and says what that means in one line — vendors, rate contracts, requisitions, the purchase-order lifecycle, goods receipt with tolerance and quarantine, and new products. Then, in both files, state what a person can now do against a real server: raise a requisition at the central store, approve it as the buyer, draw an order off the procurement list priced from a live rate contract, send it, receive it against a delivery note with a rejection that lands in quarantine, and close it short so the balance goes back on the list — with the other browser following along. Say plainly that the support desk is the last in-memory path and that `UI/src/data/seed.ts` goes with it in Phase 6.

- [ ] **Step 4: `docs/*.html` — the product contract**

Read each file and change only what this phase changed:
- `docs/user-flows.html`: the buying chain — requisition sent → approved or trimmed → picked onto a draft → sent to the vendor → received in instalments → received or closed short — is the server's. Add that a claim returns to the requisition it came from whenever an order is cut, dropped, cancelled or closed short; that a receipt over 2 % of the ordered quantity is refused whole; that rejected goods go to a quarantine location that never sells and never issues, with no way back out; and that the buyer, not the store keeper, decides a requisition.
- `docs/ua-spec.html`: UA-11 ("Reject 12 of 120 at quality check → 108 to sellable stock, 12 to quarantine, quarantine not offered on any issue screen") is now implemented and tested — name `apps/api/src/modules/grn/grn.test.ts` beside it. Where the spec described a rule the browser enforced, say the server enforces it and the browser shows its sentence. Leave the UAT prose's own identifiers alone; add one line to the identity table saying a goods receipt is numbered `GRN-<last 3 of the PO>-<nn>` from that order's own instalment count. The "debit note proposed" half of UA-11 is **not** implemented — say so.
- `docs/system-design.html`: buying's nineteen endpoints and six reads in the API surface; the note that a goods receipt is one transaction over the ledger; and the location table gains `quarantine` (Store type, not sellable, not issuable).
Run `bash scripts/build-site.sh` afterwards and confirm `dist/` assembles.

- [ ] **Step 5: `deploy/RUNBOOK.md`**

Add a section **11. Procurement and quarantine**, after §10:
- Reading a purchase order's claim: `select l.line_no, l.item_key, l.qty, l.received_qty, s.requisition_id, s.requisition_line_no, s.qty from po_lines l left join po_line_sources s on s.po_id = l.po_id and s.line_no = l.line_no where l.po_id = 'PO-2026-0143' order by l.line_no, s.seq;` — the sources are in the order the buyer picked them, which is the order a release walks **backwards**.
- What is still on the procurement list: `select r.id, l.line_no, l.item_key, l.approved_qty - l.ordered_qty as pending from requisitions r join requisition_lines l on l.requisition_id = r.id where r.status in ('Approved','Partially approved') and l.approved_qty > l.ordered_qty order by r.id, l.line_no;` — there is no pool table; this query *is* the list.
- A claim that looks wrong: `ordered_qty` is only ever moved by `createPo`, `updatePoLine`, `removePoLine`, `cancelPo` and `closePoShort`, each inside one transaction holding the order's row and the requisition rows. If a number is off, read `document_history` for that order first (`select * from document_history where doc_type = 'purchase_order' and doc_id = '…' order by at;`) — do not correct it with an `UPDATE`.
- Reading a goods receipt's ledger: `select * from stock_moves where ref_type = 'grn' and ref_id = 'GRN-143-01';` — one positive row at `store` for what was accepted, one positive row at `quarantine` for what was rejected, and no row at all for a quantity of zero.
- GRN numbering: `GRN-<last 3 of the PO>-<nn>`, where `nn` counts that order's own instalments. There is **no `sequences` row for it**; the count is read under the order's `for update` lock, which is what stops two receipts drawing the same number. Do not "fix" a gap — there cannot be one.
- Quarantine: `select * from stock_balances where loc = 'quarantine';` is what the store keeper's screen shows. Nothing issues, sells or transfers from there and **there is no endpoint that takes stock back out** — a purchase return or a debit note is Phase 6 work at the earliest. Until then, a correction is an `adjustment` move written by hand through `db:rebuild-balances`-safe SQL (the move, never the balance).
- A refused receipt: a `POST …/receive` that answered 422 has written nothing — no GRN row, no move, no change to `received_qty` — because every line is validated before the first write.
- A 500 on reactivating a rate contract: `PATCH /contracts/:id {"active":true}` checks for an existing live contract on that vendor and item, but the check locks nothing when it finds none, so two reactivations of two closed contracts for the same pair race and the partial unique index `rate_contracts_live_uq` is the backstop. The loser gets a 500 and **the retry reads the ordinary refusal** (`<item> already has a live contract with <vendor>`), because the winner is committed by then. No data is at risk; tell the operator to try again.

- [ ] **Step 6: Spec §16 — record every decision this phase took**

Retitle the section "Amendments recorded during Phases 1–5" (and add a sub-heading "Amendments recorded during Phase 5 (2026-09-04)" in the shape Phase 3's and Phase 4's use), then append:

| Section | Amendment | Why |
|---|---|---|
| §7.2 `locations` / §9.2 | **`LocKey` does not gain `quarantine`.** A new `StockLocSchema` (the five plus `quarantine`) keys `SnapshotSchema.stock`, `StockResponseSchema.stock`, the fixtures' `LOC` and `seedStock`, and the UI store's `stock`. `LocKeySchema` stays at five and is what every write body, `user.loc`, a ticket's `from`/`to` and a request's `from` are typed against. `ALL_LOCS` and `OUTLETS` stay five long. | Widening `LocKey` would have let `quarantine` through six write bodies that name a location — pay, availability toggle, transfer, shop-ask, distribute, menus — each then needing a guard and a refusal sentence for a place no operator can reach. §9.2 only ever asked for it to be *returned in the snapshot so the store screens can show it*, which `StockLoc` does. |
| §9.2 `receivePo` move kinds | The two moves are `grn_accept` (at `store`) and `grn_reject` (at `quarantine`), the `move_kind` enum's own names, both **positive**. A receipt takes no `lockBalances` of its own and no post-lock re-read. | Nothing here promises against a balance and nothing can go negative, so the belt-and-braces `pay`/`handover`/`makeBatch` need has nothing to catch. A re-read that cannot fire is noise. |
| §9.2 `receivePo` | A `grn_reject` move is posted **only when `rejected > 0`**, and `POST /items` posts an `opening` move only when `opening > 0`. | `lockBalances` creates the row it locks, and a zero row reads as "this location carries the line" on every stock screen (M12). Otherwise every clean delivery would leave quarantine carrying the item at nothing. |
| §7.3 GRN ids | `GRN-<last 3 of the PO>-<nn>` is computed from `count(*)` of that order's existing GRN rows, under the order's `for update` lock — **there is no `sequences` row and no `"grn"` in `IdKind`**. One GRN row per received line. | §7.3 defines `nn` as the instalment count for that PO, which a global sequence cannot give. The order's own row lock is what serialises two receipts. |
| §9.2 `receivePo` | `lines` is positional against the order's own lines, and a length mismatch is refused with `Give a line for each of the <n> lines on this order`. | The same reasoning §16 already recorded for `approve`'s `appr` array: a short array read as "nothing arrived on the lines you left out" is not what a stale screen means to say. |
| §5.1 lock order | **Documents, refined: the purchase-order row is locked before any requisition row, and requisition rows ascending by id.** `createPo` is the single exception — it locks requisition rows holding no order lock, safe only because it is minting the order and never afterwards waits for an existing one. Recorded in `apps/api/src/lib/ledger.ts`'s header. | Four writes move a claim across two documents. Two writers taking those two locks in opposite orders deadlock; with `createPo` unable to want the second lock, no cycle exists. |
| §9.2 `updatePoLine` / `closePoShort` | The claim walk is `releaseClaim` in `packages/domain/src/claims.ts` and releases **last source first**, in one implementation both sides read. | It was written three times in `store/procurement.ts` and about to be written twice more on the server. A fixed direction is also what makes a shrink and a re-grow land back on the same requisition. |
| §9.2 patch bodies | Recorded as conformance, not an amendment: §9.2 already declares `PATCH /purchase-orders/:id { vendorId?, eta? }` and `PATCH /vendors/:id`, and `setVendorActive` folds into the second as a patch of one field. What **is** an amendment: every patch body is a `strictObject` of optional, **default-free** fields, declared explicitly rather than as `.partial()` of a defaulted schema. | Zod carries a `.default()` through `.partial()`, so `VendorBodySchema.partial().parse({})` yields `{ lead: 0, groups: [] }` — which makes "Nothing to change" unreachable and resets a vendor's lead time and groups on every patch of any other field. `routes.test.ts` pins `parse({}) → {}` for both patch schemas. |
| §9.2 `setPoVendor` | Moving a draft's vendor **re-prices** every line still sitting on the item's standard cost or on the previous vendor's contract rate, and never a rate the buyer typed. `PoDrawer.tsx`'s `useEffect` that did this is deleted. | An effect that issues a write on render would have fired a request per line on every drawer open. The rule is the same one `createPo` applies, so it is written once, server-side. |
| §9.2 `createPo` | Picks are folded per `(prq, line)` **before** the pending check, and a requisition not in an approved status has a pending of zero rather than a 404. | Two picks against one source line must not each pass on their own while their sum overruns it. A pick against an undecided requisition reads the same "only 0 still pending" sentence the buyer's own derived list would have shown them. |
| §9.2 `cancelPo` | The `received > 0` check runs **before** the transition guard. | A partly-received order would otherwise be refused with "is already partially received" — true, and useless. The store's own comment says so; the order moves with it. |
| §5.1 transitions | `REQUISITION_TRANSITIONS` and `PO_TRANSITIONS` join the three existing tables. `PO_TRANSITIONS["Partially received"]` includes **itself**: a second instalment that still does not complete the order re-enters the status it was in, and `receiptStatus` computes the target from the totals. `Ordered → Cancelled` is listed but guarded again at its own door; `Partially received` has no `Cancelled` at all. | §12 wants every unlisted `PoStatus`/`PrqStatus` transition tested as refused, which needs the tables to exist. A self-edge is the honest way to describe a status a document can genuinely re-enter. |
| §9.2 `sendRequisition` | A body naming the same item twice is refused — `Combine the <item> lines into one` — as `POST /requests` already does. | Two lines of one item would be decided twice, claimed twice and received twice, and the store keeper can still fix it on the draft screen. |
| §9.2 `approveRequisition` | It refuses an `appr` array whose length does not match the line count, and **never touches `ordered_qty`**. Free-to-promise is not consulted: `planPrqApproval` takes no `freeFor` callback, unlike `planApproval`. | The array rule is §16's own, from `approve`. The claim belongs to the purchase orders; a decision that reset it would hand a live order's quantity back to the list. And what the central store is holding has nothing to do with what a vendor can supply. |
| §8.3 / §9.2 `createItem` | `POST /items` admits `["store", "prod", "buyer"]`, not `store` alone, and the location it books opening stock at is the caller's — `kitchen` for `prod`, `store` for the other two. | Three screens add a product today: the kitchen's own (`roles/prod/Stock.tsx`), the buyer's answer to a shop's request (`roles/buyer/NewProductDrawer.tsx`) and the store's (whose button opened a drawer nobody had registered until this phase). §8.3's row named only the store keeper — the same omission §16 recorded for `POST /requests` and `prod`. |
| §8.3 / §9.2 `answerProductRequest` | It admits `["store", "buyer"]`. | The only screen that answers one is the buyer's New Products list. |
| §9.2 `createItem` | Two new refusals: `Cost must be more than zero` (the browser's three new-product drawers all disabled the button on it and none of them said it server-side) and `A new product's opening stock is booked at <location>`, derived from the caller's **role** rather than their `claims.loc`. | The cost is what every stock value on every screen is read off, so a zero would make a whole location's valuation wrong silently. The location rule is §8.3's "location decides which rows"; it is role-derived because the buyer's own `loc` is `store`, and that is the line to change if location scoping is ever applied here. |
| §9.2 `createItem` | The key is slugged and de-duplicated with a numeric suffix under a `pg_advisory_xact_lock` on the slug; the **name** clash is decided by `items_name_ci_uq` with the store's own sentence. | Two different names can slug the same way (`Cold coffee 1kg`, `Cold coffee 500g`), and the suffix scan reads before the insert locks — without the advisory lock one of them dies on a primary key with a message about a name that is not the problem. The device is the one `staffCreditTaken` already uses. |
| §7.2 `rate_contracts` | Migration `0006` adds a partial unique index `rate_contracts_live_uq` on `(vendor_id, item_key) where active`, and `addContract`/`updateContract` use the insert-as-arbiter pattern against it. | The store's screen checked before it inserted, and a check reads before the insert takes its lock. Same reasoning as `addMenuItem` (§16, Phase 2). |
| §9.2 `addVendor` | A GSTIN is checked for **format only** when one is given — `/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/` — with a new sentence, and an empty one is still accepted. The pattern stays in `modules/vendors/service.ts` rather than moving to `packages/domain`. | §9.2 asked for the check and the browser never had one. It has one consumer and previews nothing; §5.1's rule is about rules two sides enforce. |
| §9.3 `changed` | A claim that did not move is not announced: a rate-only line patch, a vendor or date patch and `sendPo` name `["po"]` alone. `POST /items` names `["items"]` (a new member of `CollectionSchema`) plus `"stock"` only when opening stock was booked. | `changed` is what every open browser refetches; naming a slice that did not move costs each of them a request. |
| §9.1 reads | The six buying GETs are served by the snapshot module and scoped by `scopeBuying` (a counter sees none of them) and `scopeProductRequests` (a counter sees the asks their own shop raised), which `scope()` now calls too. | §9.1 already listed all six; moving the cut into two helpers keeps the standalone read and the snapshot from ever disagreeing. |
| §5.1 domain | Buying's shared rules are `packages/domain/src/{claims,receipt,purchasing,format}.ts`. `format.ts` also takes over `credit.ts`'s private currency formatter and `shelf.ts`'s private calendar-date helper; both files' existing tests pin their sentences and stayed green untouched, which is the proof the move changed nothing. **One visible change comes with it:** `dmy` renders months from a fixed three-letter table, so a September date reads `"Sep"` where `toLocaleDateString("en-IN", { month: "short" })` gave `"Sept"` on some ICU builds. | The server has to speak the browser's money, dates and mixed-unit totals in its toasts, and a second formatter drifts from the first the moment either changes. The fixed table is the point of the move: a purchase order's expected date must read the same in the server's toast and in the buyer's table, on every runtime, and an ICU-dependent month is exactly what stops that. |
| §10 frontend cutover | Dates stay **display strings** in the store (`applySnapshot` and the six Phase 5 appliers all pass `eta`, `from` and `to` through `fromWireDate`), and the two controls that need `<input type="date">` convert at the edge with `toInputDate`/`fromInputDate` in `UI/src/lib/fmt.ts`. | One convention, or one collection holds raw ISO while another holds display text and every comparison between them is silently wrong. Converting in two controls is smaller than re-rendering every date on every screen. |
| §12 transitions | §12's "every `PoStatus`/`PrqStatus` transition not listed is tested to be refused" is met at the **table** level — `packages/domain/src/transitions.test.ts` walks both new tables — plus one endpoint case per document for the `<id> is already <status>` refusal. It is not asserted pair-by-pair at every endpoint. | The same level Phases 3 and 4 met it at, for the same reason: the table is the single guard both sides read, and a pair-by-pair endpoint sweep would test `assertTransition` rather than the rule. |
| §14 Phase 5 | **No quarantine ledger, no purchase return, no debit note.** Rejected stock lands at `quarantine` and there is no endpoint that takes it back out. `docs/superpowers/specs/2026-08-29-procurement-redesign-design.md` recorded that decision for the frontend and it stands; `docs/ua-spec.html`'s UA-11 "debit note proposed" is explicitly not implemented. | It is a document type nothing in `types.ts` describes and no screen offers. Inventing it here would be a product change made in a cutover phase. |
| §14 Phase 5 | **No finance approval workflow.** `needsApproval` is computed from the order's value against `PO_APPROVAL_LIMIT` and stamped on `sendPo`; nothing consumes it but a badge. | §9.2 asks for the flag, not for an approver. |
| §14 Phase 6 | Still in memory after this phase: the support desk (`raiseTicket`, `replyToTicket`, `setTicketStatus`, `rateTicket`) and `UI/src/data/seed.ts`. | Named here so Phase 6 plans against a short list rather than rediscovering it. |

- [ ] **Step 7: Run the exit check (spec §14 row 5)**

From a clean tree on `feat/phase-5-procurement`:
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
Then, in a second shell, buying end to end:
```bash
API=http://localhost:3000/api/v1
login() { curl -sS -X POST $API/auth/login -H 'content-type: application/json' -d "{\"emp\":\"$1\",\"password\":\"changeme\"}" | jq -r .accessToken; }
STORE=$(login RC-2088); BUYER=$(login RC-1550)
K() { python3 -c 'import uuid;print(uuid.uuid4())'; }
S() { curl -sS -X POST "$API$1" -H "Authorization: Bearer $STORE" -H 'content-type: application/json' -H "Idempotency-Key: $(K)" ${2:+-d "$2"}; }
B() { curl -sS -X POST "$API$1" -H "Authorization: Bearer $BUYER" -H 'content-type: application/json' -H "Idempotency-Key: $(K)" ${2:+-d "$2"}; }
BP() { curl -sS -X PATCH "$API$1" -H "Authorization: Bearer $BUYER" -H 'content-type: application/json' -H "Idempotency-Key: $(K)" -d "$2"; }
pending() { curl -sS -H "Authorization: Bearer $BUYER" $API/requisitions | jq -r "[.[]|select(.id==\"$1\")][0].lines[$2] | .appr - .ordered"; }

# 1. The store keeper asks.
PRQ=$(S /requisitions '{"lines":[{"it":"milk","qty":60},{"it":"butter","qty":6}],"note":"Weekly dairy"}' | jq -r .result.id)
echo "$PRQ"                                                   # PRQ-2026-016
#    an empty ask, and the same item twice, are both refused
S /requisitions '{"lines":[{"it":"milk","qty":0}]}'            | jq -r .error.message
S /requisitions '{"lines":[{"it":"milk","qty":1},{"it":"milk","qty":2}]}' | jq -r .error.message

# 2. The buyer decides, trimming one line.
B /requisitions/$PRQ/approve '{"appr":[60,4],"note":"Butter trimmed"}' | jq -r '.message, (.result.lines|map("\(.it) \(.appr)/\(.qty) short \(.short)")|join(", "))'
#    expect "PRQ-2026-016 partially approved — 2 line(s) on the procurement list"
pending $PRQ 0                                                 # 60

# 3. A draft off the list, priced from Aavin's live milk contract (RC-101, ₹52).
PO=$(B /purchase-orders "{\"vendorId\":\"VN-001\",\"picks\":[{\"prq\":\"$PRQ\",\"line\":0,\"qty\":60},{\"prq\":\"$PRQ\",\"line\":1,\"qty\":4}]}" | jq -r .result.id)
curl -sS -H "Authorization: Bearer $BUYER" $API/purchase-orders | jq -r "[.[]|select(.id==\"$PO\")][0] | \"\(.st) \(.eta) \(.lines|map(\"\(.it)@\(.rate)\")|join(\",\"))\""
#    expect "Draft <today+2> milk@52,butter@248"
pending $PRQ 0                                                 # 0 — the claim moved
#    a second pick beyond what is pending is refused
B /purchase-orders "{\"vendorId\":\"VN-001\",\"picks\":[{\"prq\":\"$PRQ\",\"line\":0,\"qty\":1}]}" | jq -r .error.message

# 4. Cut a line and watch the claim come back, then send the order.
BP /purchase-orders/$PO/lines/0 '{"qty":40}' | jq -r .message
pending $PRQ 0                                                 # 20 — returned to the list
BP /purchase-orders/$PO/lines/0 '{"rate":54}' | jq -r '.message, (.changed|join(","))'   # "po" only
B /purchase-orders/$PO/send | jq -r .message
#    expect "<PO> raised on Aavin Dairy Depot — expected <dd-Mon-yyyy>"

# 5. Receive it, with a rejection, and watch both shelves move.
curl -sS -H "Authorization: Bearer $STORE" $API/stock | jq '{store: .stock.store.milk, q: .stock.quarantine}'
S /purchase-orders/$PO/receive '{"dc":"DC-99001","invoice":"INV/AAV/5512","invDate":"2026-09-04","lines":[{"recv":40,"rejected":3,"batch":"AAV-9001","mrp":0,"mfg":"2026-09-01","exp":"2026-09-08"},{"recv":0}]}' | jq -r '.message, (.result.grns|map(.id)|join(","))'
#    expect "Booked into Central Store — 37.000 L accepted, 3.000 L rejected" and GRN-<tail>-01
curl -sS -H "Authorization: Bearer $STORE" $API/stock | jq '{store: .stock.store.milk, q: .stock.quarantine.milk}'
#    expect store +37, quarantine 3
curl -sS -H "Authorization: Bearer $STORE" $API/purchase-orders | jq -r "[.[]|select(.id==\"$PO\")][0].st"   # Partially received

# 6. The tolerance and the expiry rules refuse, and write nothing.
S /purchase-orders/$PO/receive '{"dc":"DC-99002","invoice":"","invDate":"","lines":[{"recv":10,"rejected":0,"batch":"AAV-9002","mrp":0,"mfg":"2026-09-01","exp":"2027-09-01"},{"recv":0}]}' | jq -r .error.message
#    expect "Milk 1L (toned) — 50.000 exceeds the ordered 40.000 by more than 2%; hold it for purchase approval"
S /purchase-orders/$PO/receive '{"dc":"DC-99003","invoice":"","invDate":"","lines":[{"recv":0},{"recv":4,"rejected":0,"batch":"AAV-9003","mrp":0,"mfg":"2026-09-01","exp":"2026-09-03"}]}' | jq -r .error.message
#    expect "Butter, salted — batch AAV-9003 has already expired; do not book it in"
S /purchase-orders/$PO/receive '{"dc":"","invoice":"","invDate":"","lines":[{"recv":1},{"recv":0}]}' | jq -r .error.message
curl -sS -H "Authorization: Bearer $STORE" $API/grns | jq -r "[.[]|select(.po==\"$PO\")]|length"    # still 1

# 7. Close it short, and the balance goes back on the list.
B /purchase-orders/$PO/close-short '{"reason":"Vendor cannot deliver the balance"}' | jq -r '.message, (.changed|join(","))'
pending $PRQ 0                                                 # still 20 — line 0 was cut to 40 and 40 arrived
pending $PRQ 1                                                 # 4  — the butter line never came at all
#    the 3 rejected litres are NOT short: they arrived and were turned away, so they count as
#    received against the order and sit in quarantine, not back on the list
curl -sS -H "Authorization: Bearer $BUYER" $API/purchase-orders | jq -r "[.[]|select(.id==\"$PO\")][0] | \"\(.st) \(.shortNote)\""
#    expect "Received Vendor cannot deliver the balance"

# 8. Cancelling returns a claim too — the seeded draft PO-2026-0140 holds 30 sugar off PRQ-2026-014.
pending PRQ-2026-014 0                                         # 0
B /purchase-orders/PO-2026-0140/cancel '{"reason":"Sourcing elsewhere"}' | jq -r .message
pending PRQ-2026-014 0                                         # 30 — back on the list
#    and a partly received order refuses the same door
B /purchase-orders/PO-2026-0142/cancel '{"reason":"no"}' | jq -r .error.message

# 9. Vendors, contracts and a new product.
VN=$(B /vendors '{"n":"Kumaran Traders","gstin":"33AAACA1234F1Z5","contact":"Kumar S","ph":"98430 11220","terms":"30 days","lead":2,"groups":["Grocery"]}' | jq -r .result.id)
B /vendors '{"n":"kumaran traders"}' | jq -r .error.message      # already on the list
B /vendors '{"n":"Bad GST Co","gstin":"33AAACA"}' | jq -r .error.message
curl -sS -X PATCH $API/vendors/$VN -H "Authorization: Bearer $BUYER" -H 'content-type: application/json' -H "Idempotency-Key: $(K)" -d '{"active":false}' | jq -r .message
RC=$(S /contracts "{\"vendorId\":\"VN-003\",\"it\":\"bread\",\"rate\":38,\"from\":\"2026-04-01\",\"to\":\"2027-03-31\",\"moq\":20}" | jq -r .result.id)
S /contracts '{"vendorId":"VN-001","it":"milk","rate":55,"from":"2026-04-01","to":"2027-03-31"}' | jq -r .error.message
curl -sS -X DELETE $API/contracts/$RC -H "Authorization: Bearer $STORE" -H "Idempotency-Key: $(K)" | jq -r .message
NPR=$(curl -sS -X POST $API/product-requests -H "Authorization: Bearer $(login RC-3120)" -H 'content-type: application/json' -H "Idempotency-Key: $(K)" -d '{"name":"Iced lemon tea 300ml","why":"Warm-weather demand","forLoc":"kiosk"}' | jq -r .result.id)
KEY=$(S /items '{"name":"Iced lemon tea 300ml","unit":"nos","type":"MRP","cost":18,"mrp":25,"loc":"store","opening":24}' | jq -r '.result.key')
B /product-requests/$NPR/answer "{\"st\":\"Created\",\"note\":\"Added as MR-3005\",\"itemKey\":\"$KEY\"}" | jq -r .message
curl -sS -H "Authorization: Bearer $STORE" $API/stock | jq ".stock.store.\"$KEY\""      # 24

# 10. The cache is exactly the sum of the moves.
curl -sS -H "Authorization: Bearer $STORE" $API/stock > /tmp/rch-before.json
pnpm --filter @rch/api db:rebuild-balances
curl -sS -H "Authorization: Bearer $STORE" $API/stock > /tmp/rch-after.json
diff /tmp/rch-before.json /tmp/rch-after.json && echo "balances reconcile"
```
Then the browser walk (Task 10's Step 9) — one window as `RC-2088` and one as `RC-1550`, the requisition and the order moving in both without a reload, a refused receipt leaving the drawer's boxes full, and quarantine appearing on the store keeper's stock screen.
**Staging** is a release decision made outside this plan: the local run above is what gates the phase. Record both facts in the ledger.

- [ ] **Step 8: Commit**

One commit, everything in it — the five guides, both READMEs, the product contract, the runbook and the spec's amendments:
```bash
git add CLAUDE.md apps/api/CLAUDE.md packages/contract/CLAUDE.md packages/domain/CLAUDE.md UI/CLAUDE.md \
        README.md UI/README.md docs deploy/RUNBOOK.md
git status --short   # nothing under docs/ or CLAUDE.md left unstaged
git commit -m "$(cat <<'EOF'
Document buying's move to the server and record its exit check

The root guide, the four package guides and the README's status-by-phase section all say what
the code says now: a requisition, its decision, a purchase order from draft to received or
cancelled, a goods receipt that splits a delivery between the central store's shelf and
quarantine, and the claim that comes back to the procurement list whenever an order gives one up.

Spec §16 carries the twenty-eight decisions this phase took, including the three it declined to
take — no quarantine ledger and no way back out of it, no finance approver behind the flag, and
no widening of LocKey to a location no operator can name. Four of the rows are about how a
number or a date is written rather than what it means: patch bodies that carry no defaults, a
month table that reads the same on every runtime, dates that stay display strings in the store,
and the level at which §12's transition coverage is met.

The runbook gains the queries an operator needs when a claim looks wrong: the procurement list
is a query, not a table, and ordered_qty is only ever moved by five endpoints inside one
transaction each.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | **1** (contract: nineteen writes, `StockLoc`, the slab constant) ∥ **2** (domain: claims, receipt, purchasing, format, two tables) ∥ **3** (api: six module skeletons, the lock-order header, five builders, migration `0006`) | Worktrees, all three from the phase branch head. Disjoint by package: Task 1 owns `packages/contract/**` **plus one assertion in `UI/src/__tests__/procurement.test.ts`** (the only place in the repo that enumerates `LOC`'s keys, which `LOC.quarantine` breaks — Task 1's own gate would otherwise go red); Task 2 owns `packages/domain/**`, `UI/src/lib/fmt.ts` and two cases in `UI/src/__tests__/api.test.ts`; Task 3 owns `apps/api/**`. Three different `UI` files, none shared. Task 2 deliberately does **not** import `PO_APPROVAL_LIMIT` from Task 1 (`needsApproval` takes the limit as a parameter), so neither worktree waits on the other. Task 1 declares **writes only** — a manifest GET without a handler fails `apps/api/src/contract.test.ts`, which no longer skips a 404. Journal must read `0005_ticket_status_cancelled` before dispatch; it reads `0006_rate_contracts_live_uq` after. |
| 2 | **4** (six reads + quarantine) ∥ **5** (`requisitions`) ∥ **6** (`purchaseorders`) ∥ **7** (`grn`) ∥ **8** (`vendors` + `contracts`) ∥ **9** (`catalog`'s `POST /items` + `productreqs`) | Worktrees, all six from the merge of wave 1. Disjoint: Task 4 owns `apps/api/src/modules/snapshot/**` and `packages/contract/src/{routes.ts,schemas/snapshot.ts}` — the only wave-2 task that touches `packages/contract`, and Task 1 finished with it in wave 1. Each of Tasks 5–9 owns its own module directories, which Task 3 created and registered, so there is no shared registration line. Tasks 6 and 7 both write `po_lines` and `requisition_lines` at runtime but share no file; their column split is in Task 6's opening note. Nothing in wave 2 needs anything from another wave-2 task, and that is enforced rather than hoped for: **Tasks 5, 6, 7 and 8 read documents back through `GET /snapshot`'s slices, never through the six GETs Task 4 adds in the same wave**, which is stated in each of those four task bodies and not only here. Task 7 builds its own purchase orders with `given.po` rather than through Task 6's endpoints. `GET /items` and `GET /stock` are Phase 1 and 2 routes and are safe to read. |
| 3 | **10** (UI cutover) | In-tree or one worktree; it is alone. It needs all six wave-2 tasks merged — every write route it calls and every read route its `refetch` entries name — and it is one coherent change: two store slices, seven narrow readers, three selectors, thirteen screens and four test files. Splitting the store from the screens would fail typecheck in whichever half went first, which is the same reason Phase 4 refused that split. |
| 4 | **11** (guides, docs, spec §16, runbook, exit check) | In-tree, after everything is merged. The only task that edits `docs/`, the two READMEs, the root `CLAUDE.md`, the four package `CLAUDE.md` guides and `deploy/RUNBOOK.md` — all in one commit. |

Worktree agents do not commit to the shared branch; the controller reviews and merges each branch, then dispatches the next wave from the merge commit. **Parallel tasks never edit the same file.** Where a file is needed by more than one task it is written by the earlier wave: `packages/contract/src/routes.ts` by Task 1 in wave 1 and Task 4 in wave 2, never by two at once; `packages/contract/src/schemas/snapshot.ts` likewise; `apps/api/src/modules/index.ts` and `apps/api/src/test/builders.ts` by Task 3 in wave 1 and by nobody afterwards; `UI/src/lib/fmt.ts` by Task 2 in wave 1 and by nobody afterwards (Task 10 is told so explicitly). The two domain tables Task 2 writes are read by Tasks 5, 6, 7 and 10 and written by none of them.
