# packages/domain — CLAUDE.md

Repo-wide rules and the domain invariants themselves are in the root `../../CLAUDE.md`; the
design contract is `docs/superpowers/specs/2026-09-03-backend-design.md` (§5.1 has the
enforcement mechanism for each rule below). This is what is specific to `@rch/domain`.

## What this is

The business rules, written once, as pure functions. **The server enforces them; the UI only
previews with them.** A rule inlined in a Fastify route handler or in a React component is a
defect — move it here and call it from both sides. Every export is a plain function over plain
data, parameterised by a `Master` (`items`, `locations`, `recipes`) the caller supplies.

## Purity

- **No I/O.** No `fetch`, no `pg`, no Drizzle, no file system, no `process.env`.
- **No framework.** No Fastify, no React, no Zustand. Nothing imports from `apps/api` or `UI`.
- The only dependency is `@rch/contract`, and only for its types and `STAFF_CREDIT_LIMIT`. The
  arrow is contract → domain → api / UI; it never points back.
- No registry reads and no module-level mutable state: a function that needs the item master
  takes a `Master` argument. That is what lets the server call it inside a transaction with the
  master its own write commits against.
- `Intl.DateTimeFormat` with `timeZone: "Asia/Kolkata"` is the one platform API used, in
  `ids.ts` (a batch made at 00:30 IST is dated today, not yesterday).

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
| `approval.ts` | `planApproval` — never more than asked, than typed, or than free to promise; `trimmed` means the store cut it, not the manager |
| `billing.ts` | `planBill` — pricing, GST derived from inclusive prices, and an MTO line exploded into recipe moves |
| `costing.ts` | `recipeCost` / `costOf` — a made item costs its recipe plus overhead, never zero |
| `credit.ts` | `creditRoom`, `breachesCredit`, `creditBreachMessage`, and the re-exported `STAFF_CREDIT_LIMIT` |
| `apportion.ts` | `apportion` — a receipt fills its source lines in order, deterministically |
| `otp.ts` | `makeOtp` — six digits minted from the ticket number; an operational check, not a security token |
| `ids.ts` | `formatId`, `SEQUENCE_START`, `IdKind` — the document numbers exactly as the floor reads them |
| `transitions.ts` | the four status tables and `canTransition` |

`SEQUENCE_START` is the first number each series issues, continuing the seeded documents
(`req: 913`, `tkt: 441`, `bill: 1188`, …). `apps/api/src/lib/ids.ts` inserts those rows and hands
numbers out under a row lock; the test builders deliberately allocate above them.

## Transition tables

`TransitionTable<S> = Readonly<Record<S, readonly S[]>>`, typed against the closed status unions
in `@rch/contract` — so a status added to a schema fails `typecheck` here until its row exists.
One table, two consumers: the server refuses anything not listed (`assertTransition` in
`apps/api/src/lib/rules.ts`) and the UI reads the same table to decide which buttons to render
(`isReqOpen`, `canIssueTicket`, `canHandOver`, `canReceiveTicket`, `canDispatch` in
`UI/src/lib/selectors.ts`). A transition the UI offers but the server refuses is impossible by
construction.

**The trap:** `PROD_ORDER_TRANSITIONS` allows `Dispatched` from **every** open stage
(`New`, `Accepted`, `In kitchen`, `Ready`) on purpose — the kitchen sends an order out the moment
it is ready, whatever word the board is showing, and the guard only refuses one already
`Dispatched` or `Declined`. Phase 4's `POST /prod-orders/:id/status` must not read that as
permission to skip the board's own walk: a status endpoint that gates on this table alone would
let `New → Ready` through. Read the comment in `transitions.ts` and spec §16 before touching it.
`REQUEST_TRANSITIONS` keeps `Received → Closed` reachable although no path writes `Received`
today, so a migrated or hand-corrected row is not stranded.

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
