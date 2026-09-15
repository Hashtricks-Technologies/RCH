# packages/domain - CLAUDE.md

Repo-wide rules are in the root `CLAUDE.md`. This file covers what is specific to `@rch/domain`.

## What this is

This package holds the business rules, each written once as a pure function. **The server enforces them; the
UI only previews with them.** A rule written inline in a route handler or a React component is a defect: move it
here and call it from both sides.

The line: a rule that **both sides** need lives here. So does wording both sides print (`REASON_LABEL`,
`creditBreachMessage`), because a sentence written twice drifts. A validation that only one endpoint runs, with
nothing to preview in the browser, stays in that module. `GSTIN_RE` in the vendors service is the example.

There is no build step; `package.json` exports `src/index.ts` directly.

```bash
pnpm --filter @rch/domain test        # vitest run --coverage (floor: lines 99 / branches 92)
pnpm --filter @rch/domain typecheck
pnpm --filter @rch/domain lint
```

## Purity

- **No I/O and no framework.** No `fetch`, `pg`, Drizzle, file system, `process.env`, Fastify, React or
  Zustand. Nothing here imports from `apps/api` or `UI`.
- **The only dependency is `@rch/contract`**, for its types and a few constants.
- **No module-level mutable state.** A function that needs the item master takes a `Master` argument (`items`,
  `locations`). That lets the server call it inside a transaction, against the master that
  transaction commits.
- **Dates use the hospital's calendar**, through `Intl.DateTimeFormat` with `timeZone: "Asia/Kolkata"`
  (`format.ts`'s `istDate`). A rule that needs "today" takes it as an argument instead of reading the clock.

## Layout

`src/index.ts` is the public surface. Each file holds one rule, with its `<name>.test.ts` beside it. Two files
need more context than their names give:

- `transitions.ts` holds the status tables, which the server enforces and the UI's buttons read (see below).
- `claims.ts`, `receipt.ts` and `purchasing.ts` hold buying's arithmetic. Only `ordered_qty` is stored; the
  procurement list itself is derived.
- `master.ts`'s `Prices` is `Record<string, Record<string, number>>` - every price list, keyed by its id, not
  a fixed pair. `pricing.ts`'s `priceOf` reads whichever id a location's own `list` names and caps it at MRP;
  it does not care how many lists exist.

## Transition tables

`TransitionTable<S>` is typed against the closed status enums in `@rch/contract`. Adding a status therefore
fails `typecheck` here until its row exists. The server refuses any edge the table doesn't list
(`assertTransition`), and the UI reads the same table to decide which buttons to draw.

**A table says which status may follow which, never through which door.** Adding a general edge opens it to
every consumer of that table. So an edge that only one endpoint should take is guarded again at that endpoint:

- `PROD_ORDER_TRANSITIONS` allows `Dispatched` from every open stage, on purpose. Dispatch happens whenever
  the kitchen is ready. `POST /prod-orders/:id/status` must still walk New → Accepted → In kitchen → Ready one
  step at a time, and refuses `Dispatched` as both source and destination.
- `TICKET_TRANSITIONS.Issued → Cancelled`, `PROD_ORDER_TRANSITIONS.Dispatched → Ready` and
  `SHOP_ASK_TRANSITIONS.Sent → Asked` are taken only by `POST /tickets/:id/cancel`.
- `REQUEST_TRANSITIONS` has **no** `Ticket issued → Manager approved` edge. A cancelled ticket puts its request
  back through an explicit guard in the tickets service. The edge would also reopen `approve` for a request
  that already holds a live ticket.
- A request can be `Cancelled` from `Manager approved` or `Partially approved` (the withdrawal door), but
  `requests/service.ts` shuts that door once a ticket exists.
- `PO_TRANSITIONS["Partially received"]` includes itself, because a second partial delivery re-enters it.
  `Ordered → Cancelled` is guarded again at `cancel` once anything has been received.

## Conventions

- **Every export must be reachable from `src/index.ts` and actually imported** by `apps/api`, `UI` or a test.
  knip (`pnpm lint`) fails on an export nothing uses. A rule with no caller is deleted, not kept "for later".
- **A sentence a rule produces is produced once, here.** The server's refusal repeats it word for word.
- **Tests assert literal expected values**, never the formula re-run, for example
  `expect(apportion(7, [{qty:5},{qty:5}])).toEqual([5,2])`. Table tests list the transitions the floor actually
  walks and the ones it must refuse.
