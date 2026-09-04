# packages/domain — CLAUDE.md

Repo-wide rules and the domain invariants themselves are in the root `../../CLAUDE.md`; the
design contract is `docs/superpowers/specs/2026-09-03-backend-design.md` (§5.1 has the
enforcement mechanism for each rule below). This is what is specific to `@rch/domain`.

## What this is

The business rules, written once, as pure functions. **The server enforces them; the UI only
previews with them.** A rule inlined in a Fastify route handler or in a React component is a
defect — move it here and call it from both sides. Every export is a plain function over plain
data, parameterised by a `Master` (`items`, `locations`, `recipes`) the caller supplies.

**A rule two sides enforce lives here; a validation one endpoint runs does not.** Phase 5
demonstrates the line four times over — the claim walk, the receipt checks, the order value and
its slab, and the shared formatters all moved here because the server's toast and the browser's
screen both have to say the same thing. A GSTIN's shape is the other case: `GSTIN_RE` stays in
`apps/api/src/modules/vendors/service.ts` because it has exactly one consumer and previews
nothing on the browser's side — moving it here would not remove a second copy, it would just
relocate the only one.

## Purity

- **No I/O.** No `fetch`, no `pg`, no Drizzle, no file system, no `process.env`.
- **No framework.** No Fastify, no React, no Zustand. Nothing imports from `apps/api` or `UI`.
- The only dependency is `@rch/contract`, and only for its types and `STAFF_CREDIT_LIMIT`. The
  arrow is contract → domain → api / UI; it never points back.
- No registry reads and no module-level mutable state: a function that needs the item master
  takes a `Master` argument. That is what lets the server call it inside a transaction with the
  master its own write commits against.
- `Intl.DateTimeFormat` with `timeZone: "Asia/Kolkata"` is the platform API used in `ids.ts` (a
  batch made at 00:30 IST is dated today, not yesterday) and in `format.ts`'s `istDate`, which
  `shelf.ts`'s best-before and `purchasing.ts`'s `etaFrom` both read rather than keeping a
  second copy. `receipt.ts`'s expiry check takes `today` as a plain string argument rather than
  computing it — the caller (`apps/api/src/modules/grn/service.ts`) passes `istDate(new
  Date())`, so a delivery is judged against the hospital's own calendar day even when the
  server's own clock reads UTC.

## Commands

```bash
pnpm --filter @rch/domain test        # vitest run
pnpm --filter @rch/domain typecheck
pnpm --filter @rch/domain lint        # oxlint
```

No build step — `package.json` exports `src/index.ts` directly.

## What lives here

`src/index.ts` is the public surface; a file is one rule, with its `<name>.test.ts` beside it.

| File | Rule |
|---|---|
| `round.ts` | `round3` — three decimals, the tolerance every quantity is kept at |
| `master.ts` | `Master`, `StockMap`, `RsvMap`, `OvrMap`, `Prices`, and `qty` / `resv` / `avail` |
| `pricing.ts` | `priceOf` — the till price, capped at the printed MRP **at read time**, never stored |
| `availability.ts` | `availOf` — a manual override wins; an MTO item is off when a binding ingredient runs short and the reason names it; a stocked item is off at zero. `fq` formats a quantity in the shelf's voice |
| `promise.ts` | `committed` and `freeToPromise` — on hand, less ticket reservations, less what other approvals already committed (C6) |
| `approval.ts` | `planApproval` — never more than asked, than typed, or than free to promise; `trimmed` means the store cut it, not the manager. `approvedStatus` joins it: which approved status (`Manager approved` / `Partially approved`) a set of decided lines amounts to, written once because two callers need the same answer — the approval that first reaches it, and a cancelled ticket putting its request back where the manager left it |
| `billing.ts` | `planBill` — pricing, GST derived from inclusive prices, and an MTO line exploded into recipe moves |
| `costing.ts` | `recipeCost` / `costOf` — a made item costs its recipe plus overhead, never zero |
| `credit.ts` | `creditRoom`, `breachesCredit`, `creditBreachMessage`, and the re-exported `STAFF_CREDIT_LIMIT` |
| `apportion.ts` | `apportion` — a receipt fills its source lines in order, deterministically |
| `otp.ts` | `makeOtp` — six digits minted from the ticket number; an operational check, not a security token |
| `ids.ts` | `formatId`, `SEQUENCE_START`, `IdKind` — the document numbers exactly as the floor reads them |
| `shelf.ts` | `DEFAULT_SHELF_LIFE_HOURS` (8), `bestBeforeAt`, `bestBeforeText` — the only place a batch's best-before or its H9 wording ("21:30", "21:30 tomorrow", "21:30 04 Sep") is computed |
| `claims.ts` | `releaseClaim` — give a purchase-order line's sources back **last source first**; `foldClaims` — every delta against one requisition line, folded and sorted into lock order; `shortfallClaims` — what never arrived, per line, released the same way. The whole arithmetic of the procurement list, which is derived and stores nothing but `ordered_qty` |
| `receipt.ts` | `checkReceiptLine` — the goods-receipt checks in the store keeper's own order (the 2% tolerance, the rejected-qty bound, the batch/date checks, the MRP-vs-shelf-price floor); `receiptStatus` — `Received` or `Partially received` once an instalment is booked; `RECEIPT_TOLERANCE` (1.02) |
| `purchasing.ts` | `poValue`, `needsApproval` (takes the finance slab as a parameter, never imports it), `rateFor` (a live rate contract, or the item's standard cost), `etaFrom` (a vendor's lead time, counted in the hospital's calendar) |
| `format.ts` | `money`, `money0`, `istDate`, `dmy` (`"2026-08-31"` → `"31-Aug-2026"`, from a fixed month table, not `toLocaleDateString`), `unitTotal` — the words and numbers both sides print. `credit.ts` and `shelf.ts` now import their formatters from here rather than keeping a private copy each |
| `transitions.ts` | the six status tables and `canTransition` |

`SEQUENCE_START` is the first number each series issues, continuing the seeded documents
(`req: 913`, `tkt: 441`, `bill: 1188`, …). `apps/api/src/lib/ids.ts` inserts those rows and hands
numbers out under a row lock; the test builders deliberately allocate above them.

## Transition tables

`TransitionTable<S> = Readonly<Record<S, readonly S[]>>`, typed against the closed status unions
in `@rch/contract` — so a status added to a schema fails `typecheck` here until its row exists.
One table, two consumers: the server refuses anything not listed (`assertTransition` in
`apps/api/src/lib/rules.ts`) and the UI reads the same table to decide which buttons to render
(`isReqOpen`, `canIssueTicket`, `canHandOver`, `canReceiveTicket`, `canDispatch`, and now
`canSendPo`, `canCancelPo` in `UI/src/lib/selectors.ts`). A transition the UI offers but the
server refuses is impossible by construction.

Phase 5 joined `REQUISITION_TRANSITIONS` and `PO_TRANSITIONS`. `PO_TRANSITIONS["Partially
received"]` includes **itself**: a second instalment that still does not complete the order
re-enters the status it was already in, because `receiptStatus` computes the target from the
totals rather than from where the order started. `Ordered → Cancelled` is a real edge in the
table, but `purchaseorders/service.ts`'s `cancel` guards it again at its own door — refusing any
order with `received > 0` before the table is ever consulted — because the table's own refusal
("is already partially received") is not what the buyer needs to hear; the endpoint's own
sentence tells them to close it short instead. `Partially received` has no `Cancelled` edge at
all: a claim on goods that already arrived cannot be given back.

**The trap:** `PROD_ORDER_TRANSITIONS` allows `Dispatched` from **every** open stage
(`New`, `Accepted`, `In kitchen`, `Ready`) on purpose — the kitchen sends an order out the moment
it is ready, whatever word the board is showing, and the guard only refuses one already
`Dispatched` or `Declined`. Phase 4's `POST /prod-orders/:id/status` must not read that as
permission to skip the board's own walk: a status endpoint that gates on this table alone would
let `New → Ready` through. Read the comment in `transitions.ts` and spec §16 before touching it.
`REQUEST_TRANSITIONS` keeps `Received → Closed` reachable although no path writes `Received`
today, so a migrated or hand-corrected row is not stranded.

**An edge reachable through one door only is guarded at that door.** Phase 4 added two edges
neither table's own consumer treats as a button: `TICKET_TRANSITIONS.Issued` gained
`Cancelled`, reachable only through `POST /tickets/:id/cancel`; `PROD_ORDER_TRANSITIONS.Dispatched`
gained `["Ready"]`, reachable only when that same cancellation puts a dispatched order's ticket
back — which is why `setStatus` (`apps/api/src/modules/production/service.ts`) refuses
`Dispatched` as a *source* even though the table allows the edge, and `canMoveOrder`
(`UI/src/lib/selectors.ts`) refuses it too, so the board never draws a button for it. The rule
this states generally: a table says what status may follow what, never *by which door* — so a
general edge in it opens every consumer of that table, not just the one that needed it. That is
also why `REQUEST_TRANSITIONS` is **not** touched for cancellation: a cancelled ticket's
request goes back to `approvedStatus(lines)` through an explicit `status === "Ticket issued"`
guard and a direct write in `modules/tickets/service.ts`, rather than a
`"Ticket issued" → "Manager approved"` table row — a row would also have re-opened `approve`
(whose only guard is that same table lookup) for a request already holding a live ticket, and
through it a second ticket for stock already promised once.

## Conventions

- Every export must be reachable from `src/index.ts` **and** actually used by `apps/api`, `UI`,
  or a test — repo-wide `knip` (run by `pnpm lint` from the root) fails on an export nothing
  imports. A rule with no caller is deleted, not kept "for later".
- Round with `round3`; compare money with the two-decimal helper in `credit.ts`. Never hand-roll
  either.
- A message a rule produces is the sentence the operator reads, and it is produced **once**:
  `creditBreachMessage` is word for word what the counter's screen has said since before there
  was a server, so the server's 422 repeats it rather than inventing a second wording.
- Tests assert **literal expected values**, never the implementation re-run:
  `expect(round3(0.1 + 0.2)).toBe(0.3)`, `expect(apportion(7, [{qty:5},{qty:5}])).toEqual([5,2])`.
  A test that recomputes the formula it is testing proves nothing. Table tests enumerate the
  transitions the floor actually walks and the ones it must refuse.
