# packages/contract — CLAUDE.md

Repo-wide rules are in the root `../../CLAUDE.md`; the design contract is
`docs/superpowers/specs/2026-09-03-backend-design.md` (§16 records the amendments this file
points at). This is what is specific to `@rch/contract`.

## What this is

The wire. Every shape that crosses between `UI/` and `apps/api` is a Zod schema declared here and
nowhere else, and every route the API serves is one entry in one manifest. The package imports
nothing from `@rch/domain` or `apps/api` — the dependency arrow is **contract → domain →
api / UI**, never back. Its only runtime dependency is `zod`.

## Commands

```bash
pnpm --filter @rch/contract test        # vitest run — routes.test.ts, schemas/*.test.ts, fixtures.test.ts
pnpm --filter @rch/contract typecheck
pnpm --filter @rch/contract lint        # oxlint
```

There is no build step: `package.json` exports the TypeScript sources directly —
`"."` → `src/index.ts`, `"./fixtures"` → `src/fixtures/index.ts`. Consumers import
`@rch/contract` and `@rch/contract/fixtures`.

## Layout

```
src/index.ts            re-exports types + every schema module + routes
src/types.ts            z.infer aliases only — no type is declared here
src/routes.ts           defineRoute + the `routes` manifest + API_PREFIX
src/schemas/common.ts   closed unions, Qty/Money/Iso*, error envelope, STAFF_CREDIT_LIMIT,
                        StockLocSchema/QUARANTINE, PO_APPROVAL_LIMIT, ALL_LOCS, OUTLETS
src/schemas/documents.ts  every document shape (Item, Ticket, StockRequest, Bill, …)
src/schemas/auth.ts     login / refresh / change-password / me
src/schemas/snapshot.ts SnapshotSchema and the narrow read responses; BILL_DAYS
src/schemas/writes.ts   request bodies, result shapes, CollectionSchema, writeResponse()
src/schemas/events.ts   EVENTS_PATH, EventNoticeSchema
src/schemas/reports.ts  the stock ledger and credit report's query/response shapes (Phase 6)
src/fixtures/*          the demo hospital: master, seed documents, ops, vendors
```

## Rules

- **A wire type is a schema here, and `types.ts` is only `z.infer` aliases.** Never hand-write an
  interface for something that travels; never declare the same shape twice. `LocKey`, `Role`,
  `Tender`, `PayerKind` and every status (`ReqStatus`, `TktStatus`, `PordStatus`, `PoStatus`,
  `PrqStatus`, `ShopAskStatus`) are closed `z.enum`s. **Never widen one with `string`** — let the
  compiler find the call sites. `TktStatusSchema` gained `Cancelled` in Phase 4 (migration
  `0005_ticket_status_cancelled` adds it to the pg enum) — this is the one place to say that a
  status union here and its enum in `apps/api/src/db/schema/enums.ts` are edited together or
  neither: a value in one but not the other fails at the boundary that notices first, either a
  Zod parse on the way out or a Postgres write on the way in.
- **Request bodies are `z.strictObject`.** An unknown key is a client bug (a renamed field, a
  stale build); dropping it silently hides the mistake. `routes.test.ts` proves every body schema
  accepts its own sample and refuses an extra key, and fails if a new route arrives without a
  sample in `SAMPLES`.
- **Positivity is a service rule, not a schema rule — except for `PayBodySchema`.**
  `QtySchema` is `z.number().finite().multipleOf(0.001).max(100000)`: three decimals is the whole
  precision of a quantity (`round3`), so more than that is refused at the door, but a **zero must
  reach the operator as the store's own sentence** ("Add at least one line with a quantity"), not
  a generic 400. `PayBodySchema`'s lines use `.positive()` deliberately — a cart line of zero is
  not a sale to explain, it is a malformed request. Both choices are recorded in spec §16; do not
  "fix" either one.
- **`LocKeySchema` is where an operator may act; `StockLocSchema` is where stock may be.**
  `LocKeySchema` (`schemas/common.ts`) stays the five working locations — no write body, no
  user's home location, neither end of a ticket may ever name `quarantine`. `StockLocSchema` is
  those five plus `quarantine` (the rejected-goods shelf a goods receipt posts to) and is what
  keys `SnapshotSchema.stock`, `StockResponseSchema.stock`, the fixtures' `LOC` and `seedStock`,
  and the UI store's `stock` — everywhere stock is *reported*. A write body that names a
  location always takes `LocKeySchema`; widening it to admit `quarantine` would open six doors
  (pay, availability toggle, transfer, shop-ask, distribute, menus) that then each need a guard
  and a refusal sentence for a place no operator can reach.
- **A `PATCH` body is a `strictObject` of optional, default-free fields, declared explicitly —
  never `.partial()` of a defaulted schema.** Zod carries a `.default()` through `.partial()`,
  so a body schema built by relaxing a create schema silently resets every field the caller did
  not name to its default the moment any one field is patched. `PatchPoBodySchema`,
  `PatchVendorBodySchema` and `PatchContractBodySchema` are each declared field by field for
  this reason, and `routes.test.ts` pins `.parse({})` to `{}` for all three — the check that
  "Nothing to change" stays reachable.
- **`TicketSchema.hist` is `z.array(HistEntrySchema)`, required, not optional.** A live ticket's
  trail is never absent — every ticket the server creates writes its own `Issued` row before the
  wire shape can be built — so making the field optional would have let a caller that forgot to
  read history back ship a ticket silently missing it instead of failing to compile. A schema
  change a fixture cannot satisfy fails `typecheck` here first (below): `fixtures/seed.ts`'s
  `seedTkt` carries one history row for exactly this reason.
- **`PayerRosterSchema`** (`{ patients, staff, depts }`, each `PayerSchema[]`) is declared in
  `schemas/documents.ts` right after `PayerSchema` so the reference resolves before use, and
  `SnapshotSchema` gained `roster: PayerRosterSchema` directly after `users` — the till's payer
  picker reads it instead of a fixture, so a patient admitted after the last build is billable.
- **A manifest task lands a route's schema before the module that mounts it exists.** Task 1
  declared five new routes and one widened `access` list in one commit; Task 3, in a later wave,
  wrote the placeholder handlers that kept `apps/api` compiling in between. **One `GET` is
  declared per module, and each of `support`'s four writes is inert — 404, not yet wired — until
  its own module mounts it.** `apps/api/src/contract.test.ts`'s manifest probe only ever checks a
  parameterless `GET`, so a declared-but-unmounted write is invisible to it; the module that
  mounts a write is what actually turns it on, and a route sitting unmounted for more than one
  wave is a defect, not a pattern to repeat casually.

## The manifest

`defineRoute({ method, path, access, params?, query?, body?, response, write?, allowMcp? })`, and
`routes` is the whole API. It drives **both** sides: `apps/api/src/routes.ts`'s `mount()` reads it
to register the route with its schemas, auth, role gate and idempotency preHandler, and
`UI/src/api/client.ts`'s `call(route, input)` reads it to build the URL, the method and the
`Idempotency-Key`. There are no hand-written fetch wrappers and no route declared anywhere else.

- `access`: `"public"` (no token), `"any"` (any signed-in role), or an array of the roles whose
  sidebar has the module. A role not in the array gets a **404**, like a screen that does not
  exist for them.
- `write` defaults to `method !== "GET"`; the auth routes set `write: false` because they carry
  no idempotency key. `allowMcp: true` marks the few routes reachable while a user still
  must-change-password (auth and `/me`).
- A write's response is `writeResponse(Result)` = `{ result, changed, message }` —
  `ChangedSchema` is an array of `CollectionSchema`, the closed list of slices a client may
  refetch. `message` is the operator's sentence; `changed` is what the UI's `refetch` reads.
  `CollectionSchema` (`schemas/writes.ts`) gained `"prq"`, `"po"`, `"grn"`, `"vendors"`,
  `"contracts"`, `"productReqs"` in Phase 5, and `"items"` — `POST /items` is the first write
  that can change the catalogue itself, not just a balance on it.
- **Adding an endpoint is one manifest entry plus a handler.** `apps/api/src/contract.test.ts`
  probes every parameterless GET in the manifest and asserts a 200 that parses against its own
  response schema — so a GET declared without its handler fails the API suite. Declare a GET in
  the same commit as the module that answers it.
- Phase 4 added three writes — `setOrderStatus` (`POST /prod-orders/:id/status`), `makeBatch`
  (`POST /batches`) and `cancelTicket` (`POST /tickets/:id/cancel`) — and two reads,
  `prodOrders` (`GET /prod-orders`) and `batches` (`GET /batches`), the same shape as every
  route above: one manifest entry, nothing hand-written.
- Phase 5 (buying) added nineteen more writes — the requisition desk (`createRequisition`,
  `approveRequisition`, `declineRequisition`), the purchase-order lifecycle
  (`createPo`, `updatePoLine`, `removePoLine`, `patchPo`, `sendPo`, `cancelPo`, `receivePo`,
  `closePoShort`), vendors and rate contracts (`addVendor`, `updateVendor`, `addContract`,
  `updateContract`, `removeContract`), and the master (`createItem`, `createProductRequest`,
  `answerProductRequest`) — and six reads (`requisitions`, `purchaseOrders`, `grns`, `vendors`,
  `contracts`, `productRequests`), the same shape as every route above.
- Phase 6 added the last five: four support writes — `raiseTicket` (`POST /support/tickets`),
  `replyToTicket` (`POST /support/tickets/:id/messages`), `setTicketStatus` (`POST
  /support/tickets/:id/status`), `rateTicket` (`POST /support/tickets/:id/rating`), all
  `access: "any"` — and one read, `tickets` (`GET /support/tickets`, `SupportTicketsResponseSchema`
  — not to be confused with the movement collection's own read, `ticketsList` at `GET /tickets`;
  the two share no key and both are members of `CollectionSchema`, `"tickets"` and `"tkt"`).
  `stockLedger` (`GET /reports/stock-ledger`) and `creditReport` (`GET /reports/credit/:kind/:id`)
  are declared the same wave but belong to `reports`, not `support` — see *Constants*, below, for
  why exactly these two reports are on the server. `cancelTicket.access` widened from
  `["store", "prod"]` to `["store", "prod", "counter"]` in the same commit as the four support
  writes, so a counter can withdraw a shop-to-shop transfer it raised.
- `API_PREFIX` is `/api/v1`; manifest paths are relative to it.
- `EVENTS_PATH` (`/events`) and `EventNoticeSchema` live in `schemas/events.ts` and are
  deliberately **not** a manifest route — a stream has no JSON response to serialise. Both sides
  build the URL from `API_PREFIX + EVENTS_PATH`, and `routes.test.ts` pins that it never becomes
  a manifest entry. One notice names one collection, from the same enum `changed` draws on.

## Constants, and where they are not

Numbers that a rule reads live beside the schema that describes their world, and are re-exported
where a caller already imports from:

- `STAFF_CREDIT_LIMIT` (₹3,000) is declared in `schemas/common.ts` and re-exported from
  `fixtures/master.ts` (so the counter's screen keeps one import) and from
  `@rch/domain`'s `credit.ts` (so the rule and its ceiling arrive together).
- `BILL_DAYS` (7) is in `schemas/snapshot.ts` — the snapshot's bill window and `GET /bills`'s
  default, one number so replacing the store's list wholesale stays correct.
- `PO_APPROVAL_LIMIT` (₹25,000, the slab a purchase order's value is checked against before it
  needs finance approval) is declared in `schemas/common.ts` and re-exported from
  `fixtures/master.ts` the same way `STAFF_CREDIT_LIMIT` is — `needsApproval` in `@rch/domain`
  takes it as a parameter rather than importing it, so the rule and the number stay separable.
- `ALL_LOCS` and `OUTLETS` moved here in Phase 6, from three local declarations in
  `fixtures/master.ts` (a value-identical move — `ALL_LOCS` is `[...LocKeySchema.options]`,
  `OUTLETS` the same three strings it always was). Both stay `LocKey[]`, not a narrowed
  `readonly` tuple — six `.includes(l)` call sites across `UI/src/roles/manager` pass a plain
  `LocKey` and would fail to typecheck against a literal tuple. `UI/src/data/master.ts` imports
  all five constants on this line straight from `@rch/contract`, not from `@rch/contract/
  fixtures` — no production file under `UI/src` reaches the fixtures at all (§5.1). At HEAD
  `fixtures/master.ts` still carries the three re-export lines for `ALL_LOCS`, `OUTLETS` and
  `PAR_FACTOR`, but nothing imports through them any more; the Phase 6 fix wave deletes the
  lines rather than leave a re-export with no reader.
- `PAR_FACTOR` lives in `packages/domain` (its one consumer is `parOf` in
  `UI/src/lib/selectors.ts`; no server rule reads it, so it was never a wire shape and does not
  belong here). It passed through `schemas/common.ts` alongside `ALL_LOCS`/`OUTLETS` for one
  Phase 6 task before this move landed — do not go looking for it here. (Lands in the Phase 6
  fix wave.)
- Id formats and the first number of each series are **not** here: `formatId`, `SEQUENCE_START`
  and `IdKind` live in `@rch/domain/src/ids.ts`, because they are a rule, not a wire shape.
  `grnId(poId, n)` joined them in Phase 6 — a goods receipt's id, `GRN-<yy><po number>-<nn>`,
  built once rather than inline in `grn/service.ts`.

## Fixtures

`src/fixtures/` is the demo hospital — `LOC`, `IT`, `RCP`, `PL`, `MENU`, `USERS`, the payer
lists, and the seeded documents (`seedStock`, `seedReq`, `seedTkt`, `seedPrq`, `seedPo`,
`seedGrn`, `seedPord`, `seedBatch`, `seedBills`, `seedSales`, `seedRsv`, `seedVendors`,
`seedTickets`, `seedProductRequests`, `seedContracts`, `seedShopAsks`). It is one source with
three readers: `apps/api/src/db/seed.ts` writes it into Postgres, `UI/src/data/*` re-exports it
as the browser's starting registries, and both test suites build cases from it. Changing a
fixture changes what the seeded database contains and what every test's expectations are worth —
`apps/api/src/test/builders.ts` deliberately allocates ids in bands **above** these, so read that
file before adding a document here.

Fixture values are typed against the schemas in this package (`Item`, `Location`, `User`, …), so a
schema change that a fixture cannot satisfy fails `typecheck` here first.
