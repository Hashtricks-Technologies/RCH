# packages/contract - CLAUDE.md

Repo-wide rules are in the root `CLAUDE.md`. This file covers what is specific to `@rch/contract`.

## What this is

This package is the wire contract. Every shape that crosses between `UI`, `apps/api` and `apps/audit` is a Zod
schema declared here and nowhere else, and every route either service serves is one entry in one manifest. It
imports nothing from `@rch/domain`, `apps/api` or `apps/audit`; its only runtime dependency is `zod`.

There is no build step. `package.json` exports the TypeScript source directly: `@rch/contract` resolves to
`src/index.ts`, and `@rch/contract/fixtures` to `src/fixtures/index.ts`.

```bash
pnpm --filter @rch/contract test        # routes.test.ts, audit.test.ts, schemas/*.test.ts, fixtures.test.ts (floor: lines 96)
pnpm --filter @rch/contract typecheck
pnpm --filter @rch/contract lint
```

## Layout

```
src/routes.ts             defineRoute, the `routes` manifest, API_PREFIX (/api/v1), serviceOf, isWriteRoute
src/audit.ts              AUDIT_GROUPS, AUDIT_LABELS, auditLabelOf, actionsInGroup, AUDIT_PATH
src/types.ts              z.infer aliases only - no type is declared by hand
src/schemas/common.ts     closed unions, Qty/Money/Iso, error envelope, LocKey vs StockLoc, shared constants
src/schemas/documents.ts  every document shape (Item, Ticket, StockRequest, Bill, PO, …)
src/schemas/writes.ts     request bodies, result shapes, CollectionSchema, writeResponse()
src/schemas/snapshot.ts   SnapshotSchema and the narrow read responses; BILL_DAYS
src/schemas/{auth,admin,events,reports}.ts
src/schemas/audit.ts      AuditEventSchema (the API → audit service event), AuditRow/Entry/Page/Query schemas
src/fixtures/*            the demo hospital: master data and seeded documents
```

## The manifest

Each route is `defineRoute({ method, path, access, service?, params?, query?, body?, response, write?,
allowMcp? })`. The manifest drives all three: `mount()` in `apps/api/src/routes.ts`, `mount()` in
`apps/audit/src/routes.ts`, and `call()` in `UI/src/api/client.ts`.

- **`service`** is `"api"` (the default, read through `serviceOf`) or `"audit"`. Each app's `mount()` throws on
  a route tagged for the other, and each app has a test that it mounts every route tagged for it. `auditLog`
  (`GET /admin/audit`) and `auditEntry` (`GET /admin/audit/:id`) are the audit service's two, both
  `access: "admin"`. `call()` needs no change for them: every proxy in front sends `AUDIT_PATH` under
  `API_PREFIX` to the audit service.

- **`access`** is one of:
  - `"public"`: no token needed.
  - `"any"`: any signed-in role.
  - `"admin"`: checks the JWT's admin claim, not its role.
  - an array of roles.

  A caller outside `access` gets a 404.
- **`write`** defaults to `method !== "GET"`. A write carries an `Idempotency-Key`. The auth routes set
  `write: false`. `isWriteRoute(r)` is the one runtime reading of that rule, and `defineRoute` keeps `method`
  and `write` as literal types so `AuditAction` can apply the same rule at the type level.
- **`allowMcp: true`** marks the few routes a must-change-password token can still reach.
- **A write's response is `writeResponse(Result)`**, which is `{ result, changed, message }`. `changed` is an
  array of `CollectionSchema` members, the closed list of slices the UI's `refetch` knows. **If you add a
  collection, also add a narrow reader for it in `UI/src/api/refetch.ts`.** Without one, every write naming it
  costs a full snapshot.
- **Every write has an audit label.** `AUDIT_LABELS` is a `Record<AuditAction, AuditLabel>`, and `AuditAction`
  is the name of every manifest write route plus `login`, `logout` and `changePassword`. A new write route
  without a label fails `typecheck`. A label is past tense ("Changed a price"), names its `group` (a key of
  `AUDIT_GROUPS`), and carries `refused` only where a refusal means something else (`login` → "Failed
  sign-in"). A route removed from the manifest loses its label; `auditLabelOf` then prints the stored action
  name, so old rows still read.
- **`AuditEventSchema` is the wire between `apps/api` and `apps/audit`**, not a browser shape. The API inserts
  one into `audit_outbox`; the audit service's drainer parses each row with it, and a row that fails lands in
  `audit.dead_letters`. Its `action` is a plain `string` on purpose, so a removed route's history still reads.
  Ship a change to it in both images at once.
- **`audit` is the one collection no write response names.** Only the audit service's drainer announces it,
  and `UI/src/api/refetch.ts`'s reader for it only bumps a counter.
- **Add a GET together with the module that answers it.** `apps/api/src/contract.test.ts` probes every
  parameterless GET in the manifest and fails on a route with no handler.
- **The event stream is not in the manifest.** `EVENTS_PATH` and `EventNoticeSchema` live in
  `schemas/events.ts`, because a stream has no JSON response. `routes.test.ts` pins that it never becomes a
  manifest entry.
- **`voidBill`'s path parameter is percent-encoded.** Bill numbers contain a slash (`CF/1188` → `CF%2F1188`).

## Schema rules

- **Closed enums, never widened.** `LocKey`, `Role`, `Tender`, `PayerKind` and every status are `z.enum`s. A
  status enum here and its Postgres enum in `apps/api/src/db/schema/enums.ts` change together or not at all.
  **`PriceListIdSchema` is the deliberate exception**: a price list is a manager-created entity with a
  server-issued id (`common.ts`), so its id is an open, bounded string, not an enum - as many can exist as a
  manager creates.
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
  `PayerSchema` (what a bill embeds) has no `active` field: the till only ever reads live payers.
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
