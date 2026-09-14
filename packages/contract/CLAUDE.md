# packages/contract — CLAUDE.md

Repo-wide rules are in the root `CLAUDE.md`. This file covers what is specific to `@rch/contract`.

## What this is

This package is the wire contract. Every shape that crosses between `UI` and `apps/api` is a Zod schema
declared here and nowhere else, and every route the API serves is one entry in one manifest. It imports nothing
from `@rch/domain` or `apps/api`; its only runtime dependency is `zod`.

There is no build step. `package.json` exports the TypeScript source directly: `@rch/contract` resolves to
`src/index.ts`, and `@rch/contract/fixtures` to `src/fixtures/index.ts`.

```bash
pnpm --filter @rch/contract test        # routes.test.ts, schemas/*.test.ts, fixtures.test.ts (floor: lines 96)
pnpm --filter @rch/contract typecheck
pnpm --filter @rch/contract lint
```

## Layout

```
src/routes.ts             defineRoute, the `routes` manifest, API_PREFIX (/api/v1)
src/types.ts              z.infer aliases only — no type is declared by hand
src/schemas/common.ts     closed unions, Qty/Money/Iso, error envelope, LocKey vs StockLoc, shared constants
src/schemas/documents.ts  every document shape (Item, Ticket, StockRequest, Bill, PO, …)
src/schemas/writes.ts     request bodies, result shapes, CollectionSchema, writeResponse()
src/schemas/snapshot.ts   SnapshotSchema and the narrow read responses; BILL_DAYS
src/schemas/{auth,admin,events,reports,recipes}.ts
src/fixtures/*            the demo hospital: master data and seeded documents
```

## The manifest

Each route is `defineRoute({ method, path, access, params?, query?, body?, response, write?, allowMcp? })`. The
manifest drives both sides: `mount()` in `apps/api/src/routes.ts` and `call()` in `UI/src/api/client.ts`.

- **`access`** is one of:
  - `"public"`: no token needed.
  - `"any"`: any signed-in role.
  - `"admin"`: checks the JWT's admin claim, not its role.
  - an array of roles.

  A caller outside `access` gets a 404.
- **`write`** defaults to `method !== "GET"`. A write carries an `Idempotency-Key`. The auth routes set
  `write: false`.
- **`allowMcp: true`** marks the few routes a must-change-password token can still reach.
- **A write's response is `writeResponse(Result)`**, which is `{ result, changed, message }`. `changed` is an
  array of `CollectionSchema` members, the closed list of slices the UI's `refetch` knows. **If you add a
  collection, also add a narrow reader for it in `UI/src/api/refetch.ts`.** Without one, every write naming it
  costs a full snapshot.
- **Add a GET together with the module that answers it.** `apps/api/src/contract.test.ts` probes every
  parameterless GET in the manifest and fails on a route with no handler.
- **The event stream is not in the manifest.** `EVENTS_PATH` and `EventNoticeSchema` live in
  `schemas/events.ts`, because a stream has no JSON response. `routes.test.ts` pins that it never becomes a
  manifest entry.
- **`voidBill`'s path parameter is percent-encoded.** Bill numbers contain a slash (`CF/1188` → `CF%2F1188`).

## Schema rules

- **Closed enums, never widened.** `LocKey`, `Role`, `Tender`, `PayerKind` and every status are `z.enum`s. A
  status enum here and its Postgres enum in `apps/api/src/db/schema/enums.ts` change together or not at all.
- **Request bodies are `z.strictObject`.** An unknown key is a client bug. `routes.test.ts` checks that every
  body accepts its entry in `SAMPLES` and refuses an extra key. A new route without a sample fails.
- **PATCH bodies declare every field as optional, one by one, with no defaults.** Never build one as
  `.partial()` of a create schema that has defaults: Zod carries a default through `.partial()`, so every field
  the caller left out would be silently reset. `routes.test.ts` pins `.parse({})` to `{}` for each PATCH body.
- **Positivity is usually a service rule, not a schema rule.** `QtySchema` allows zero, so the operator hears
  the service's own sentence ("Add at least one line with a quantity") instead of a generic 400.
  `PayBodySchema` is the exception: its lines are `.positive()`, because a zero cart line is a malformed
  request. `SignedQtySchema`, used for adjustments, is the wire's only signed quantity.
- **`LocKeySchema` is where an operator may act; `StockLocSchema` adds `quarantine`**, which is where stock
  may be recorded. Every write body that names a location takes `LocKeySchema`, with one deliberate exception:
  `CreateAdjustmentBodySchema.loc` takes `StockLocSchema`. An adjustment corrects a shelf, and the quarantine
  shelf has to be correctable.
- **Payer data is scoped by role, and the schemas allow for it.** `BillSchema.payer` is optional and the
  roster lists may be empty, because the server strips payer data for `store`, `prod` and `buyer`.
  `PayerSchema` (what a bill embeds) has no `active` field; `PayerRecordSchema` (the manager's register) does.
- **`TicketSchema.hist` is required.** Every ticket writes its first trail row when it is created.

## Constants

- **Declared here:** `STAFF_CREDIT_LIMIT` (₹3,000), `PO_APPROVAL_LIMIT` (₹25,000), `ALL_LOCS`, `OUTLETS` and
  `BILL_DAYS` (7).
- **Declared in `@rch/domain`:** id formats and sequence starts (`ids.ts`) and `PAR_FACTOR`, because they are
  rules, not wire shapes.

## Fixtures

`src/fixtures/` is the demo hospital. It has three readers:

- `apps/api/src/db/seed.ts` writes it into Postgres.
- Both test suites build their cases from it.
- `UI` production code does **not** import it; only UI tests do.

Fixtures are typed against these schemas, so a schema change a fixture can't satisfy fails `typecheck` here
first. `apps/api/src/test/builders.ts` allocates test ids in bands above the fixtures' ids. Read it before
adding a seeded document.
