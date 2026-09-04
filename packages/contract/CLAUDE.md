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
src/schemas/common.ts   closed unions, Qty/Money/Iso*, error envelope, STAFF_CREDIT_LIMIT
src/schemas/documents.ts  every document shape (Item, Ticket, StockRequest, Bill, …)
src/schemas/auth.ts     login / refresh / change-password / me
src/schemas/snapshot.ts SnapshotSchema and the narrow read responses; BILL_DAYS
src/schemas/writes.ts   request bodies, result shapes, CollectionSchema, writeResponse()
src/schemas/events.ts   EVENTS_PATH, EventNoticeSchema
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
- **Adding an endpoint is one manifest entry plus a handler.** `apps/api/src/contract.test.ts`
  probes every parameterless GET in the manifest and asserts a 200 that parses against its own
  response schema — so a GET declared without its handler fails the API suite. Declare a GET in
  the same commit as the module that answers it.
- Phase 4 added three writes — `setOrderStatus` (`POST /prod-orders/:id/status`), `makeBatch`
  (`POST /batches`) and `cancelTicket` (`POST /tickets/:id/cancel`) — and two reads,
  `prodOrders` (`GET /prod-orders`) and `batches` (`GET /batches`), the same shape as every
  route above: one manifest entry, nothing hand-written.
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
- `PO_APPROVAL_LIMIT` and `PAR_FACTOR` are fixtures (`fixtures/master.ts`).
- Id formats and the first number of each series are **not** here: `formatId`, `SEQUENCE_START`
  and `IdKind` live in `@rch/domain/src/ids.ts`, because they are a rule, not a wire shape.

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
