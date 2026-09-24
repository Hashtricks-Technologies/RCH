# packages/contract - CLAUDE.md

Repo-wide rules are in the root `CLAUDE.md`. This file covers what is specific to `@rch/contract`.

## What this is

This package is the wire contract. Every shape that crosses between `UI`, `apps/api` and `apps/audit` is a Zod
schema declared here and nowhere else, and every route either service serves is one entry in one manifest. It
imports nothing from `@rch/domain`, `apps/api` or `apps/audit`; its only runtime dependency is `zod`.

There is no build step. `package.json` exports the TypeScript source directly: `@rch/contract` resolves to
`src/index.ts`, and `@rch/contract/fixtures` to `src/fixtures/index.ts`.

```bash
pnpm --filter @rch/contract test        # routes.test.ts, audit.test.ts, schemas/*.test.ts, fixtures.test.ts (floor: lines 97)
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
src/schemas/permissions.ts FeatureSchema, LevelSchema, GrantLevelSchema, ActionSchema, PermissionsSchema
src/schemas/audit.ts      AuditEventSchema (the API → audit service event), AuditRow/Entry/Page/Query schemas
src/schemas/qr.ts         QR ordering: the public menu/order/verify shapes, the counter's queue, the admin's
                          codes and ordering hours, BillSource/RefundStatus, RAZORPAY_WEBHOOK_PATH
src/schemas/images.ts     ITEM_IMAGE_PATH, itemImagePath() - the photo's own path, not a manifest route
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
  - `{ needs }`, built with `need(feature, level)`, `act(action)` and `anyOf(...)`: any one need met
    opens it, the hospital-wide need listed first. `admits` in `@rch/domain` reads it.
  - `{ desk }`, built with `desk(...roles)`: a door that belongs to a desk, not a permission.

  A caller outside `access` gets a 404; one who holds the feature at view where edit is needed gets
  a 403 with `permissionRefusal`'s sentence, if their desk could be given edit (otherwise a 404). There is no bare list of roles any more: every gated route
  is `{ needs }` or `{ desk }`, and `routes.test.ts` pins that. `admitAdmin: true` lets the super admin
  through a route that is not `access: "admin"` - only `xReport`, `zReports` and `closeRegister` carry it.
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
- **`setItemImage`** (`PUT /items/:it/image`) and **`removeItemImage`** (`DELETE /items/:it/image`) are ordinary
  manifest entries, `access: need("item_photos", "edit")`, both `response: writeResponse(ItemResultSchema)`.
  `SetItemImageBodySchema` (`writes.ts`) takes only `{ data: string }`, base64, capped at 1 MB of wire text -
  the 700 KB byte limit and the type check are `@rch/domain`'s `checkPhoto`, refused as a sentence, not a
  schema shape. The photo itself is read at `ITEM_IMAGE_PATH` (`schemas/images.ts`), which is deliberately
  **not** a manifest route the same way `EVENTS_PATH` isn't - see that file above.
- **Roles are the super admin's**: `adminRoles` (`GET /admin/roles`), `createRole`, `updateRole` (PATCH, every
  field optional, no defaults), `deactivateRole`, `reactivateRole` and `deleteRole`, all `access: "admin"`,
  each write labelled in the `roles` audit group ("Roles & permissions"). `CreateAdminUserBodySchema` is
  `{ name, email, roleId, loc, phone? }` and `UpdateAdminUserBodySchema` `{ roleId, loc }`: an account form
  names a role, and the role's desk is the account's `r`.
- **QR ordering** has four `access: "public"` routes (`publicQrMenu`, `createQrOrder`, `verifyQrPayment`,
  `publicQrOrder`), the counter's three under `qr_orders` (`qrOrders` at view, `setQrOrderStatus` and
  `setQrPause` at edit), `retryQrRefund` under `act("void_bill")`, and the admin's five (`adminQrCodes`,
  `createQrCode`, `updateQrCode`, `regenerateQrCode`, `setOrderHours`). The two public writes carry audit
  labels like any write; the API logs them only when accepted, under the system account. `AuditAction`
  also takes `SystemAuditAction` - `qrOrderPaid`, `qrOrderRefunded`, `qrRefundSent`, `qrRefundProcessed`,
  `qrRefundFailed` - events the system writes with no request behind them. The order's secret travels as
  `secret` in bodies and results (so `SECRET_KEYS` masks it) and as `k` on the status read's query.
  `RAZORPAY_WEBHOOK_PATH` is the gateway's webhook, kept out of the manifest like `EVENTS_PATH`.
- **`voidBill`'s path parameter is percent-encoded.** Bill numbers contain a slash (`CF/1188` → `CF%2F1188`).

## Schema rules

- **`Tender` has seven members; the till takes six.** `Online` is the QR capture's alone. `TillTenderSchema`
  (`TenderSchema.exclude(["Online"])`) is what `PayBodySchema` takes, so no till can post an online bill.
  `BillSchema` gains `src` (`till`/`qr`), `qo` (the order) and `refund`, all optional and absent on a
  till's bill.
- **Closed enums, never widened.** `Role`, `Tender`, `PayerKind` and every status are `z.enum`s. A status enum
  here and its Postgres enum in `apps/api/src/db/schema/enums.ts` change together or not at all. Two are
  deliberately not enums: `LocKey` is a checked string (a lower-case slug, `quarantine` refused by a lookahead),
  because an outlet is a row the super admin opens at runtime, not a fixed set - the service that reads a
  location resolves its existence and its name (`apps/api/src/lib/locations.ts`) and the schema only checks its
  shape; and `PriceListIdSchema` is an open, bounded string, because a price list is a manager-created entity
  with a server-issued id (`common.ts`) and as many can exist as a manager creates.
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
  roster lists may be empty, because the server strips payer data for a role holding none of `billing`,
  `credit` and `settlements` (of the seeded roles: the store keeper, the kitchen and the buyer).
  `PayerSchema` (what a bill embeds) has no `active` field: the till only ever reads live payers. The rate
  card (`TermsSchema`) and the receivables list are cut the same way and for the same reason, and both are
  `access: "any"` rather than gated on `credit` or `settlements` so that a credit write does not 403 every
  other role mid-refetch. `FeatureSchema` splits the two: `credit` is the rate card, `settlements` who owes
  what and the payments against it (`void_settlement` hangs off `settlements`).
- **`BillParty` is `PayerKind` plus `"customer"`.** A walk-in is not a missing payer, it is a party of its
  own, and the rate card is keyed by the wider union because "what a customer pays" is a rate the `credit`
  holder sets too. `payer_class_terms.cls` is therefore plain text over `BillPartySchema`, not the `payer_kind` enum.
- **`BillSchema.disc` / `discPct` are optional and omitted at zero**, the same trick `voided`/`voidReason`
  use, so a bill nobody discounted is byte for byte the bill it was before this existed. `tot` is unchanged
  and still the net - what the bill is worth and what is owed - and the gross is `tot + disc`, derived.
- **`TicketSchema.hist` is required.** Every ticket writes its first trail row when it is created.
- **`ItemSchema.img` is an optional sha256** (`/^[0-9a-f]{64}$/`), absent when the item has no photo. It rides
  the existing `items` collection, so `GET /items`, the snapshot, `refetch` and SSE all carry it with no new
  collection to wire up. It is both the photo's version and its address (`itemImagePath`), so a changed photo
  is a new URL and the old one stops being served.

## Constants

- **Declared here:** `STAFF_CREDIT_LIMIT` (₹3,000 - no longer the rule's constant, only the number the
  `staff` row of the rate card is seeded with), `PO_APPROVAL_LIMIT` (₹25,000), `BILL_DAYS` (7), and
  `STORE` / `KITCHEN` / `QUARANTINE` - the three location keys the code itself is allowed to name. Every other
  location key is an outlet, read from the `locations` table, never compiled in.
- **Declared in `@rch/domain`:** id formats and sequence starts (`ids.ts`) and `parFactor`, because they are
  rules, not wire shapes.

## Fixtures

`src/fixtures/` is the demo hospital. It has three readers:

- `apps/api/src/db/seed.ts` writes it into Postgres.
- Both test suites build their cases from it.
- `UI` production code does **not** import it; only UI tests do.

Fixtures are typed against these schemas, so a schema change a fixture can't satisfy fails `typecheck` here
first. `apps/api/src/test/builders.ts` allocates test ids in bands above the fixtures' ids. Read it before
adding a seeded document.
