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
pnpm --filter @rch/domain test        # vitest run --coverage (floor: lines 99 / branches 94)
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

`src/index.ts` is the public surface. Each file holds one rule, with its `<name>.test.ts` beside it. Three files
need more context than their names give:

- `transitions.ts` holds the status tables, which the server enforces and the UI's buttons read (see below).
- `claims.ts`, `receipt.ts` and `purchasing.ts` hold buying's arithmetic. Only `ordered_qty` is stored; the
  procurement list itself is derived.
- `locations.ts` holds the outlet rules: `outletKeys` / `operationalKeys` (who is open, and in what order),
  `worksAt` / `placesFor` (the one desk-location pairing rule, replacing two hand-written copies),
  `atOutlet` (whether a desk sits at an outlet - the counter's and the manager's - which is how the API and
  the UI ask that without naming `"manager"`, a comparison `scripts/check-boundaries.sh` refuses), and
  `outletKeyFor` (a new outlet's key, minted from its name once). The close's own machinery lives here too -
  `HOLDS_OUTLET` (which statuses of which documents still commit an outlet, exhaustive over each closed union),
  `holding` (reads the held statuses off one of those records) and `closeRefusal` (the one sentence naming
  every blocker at once). `parFactor` (`par.ts`) reads the same location row for its par level.
- `master.ts`'s `Prices` is `Record<string, Record<string, number>>` - every price list, keyed by its id, not
  a fixed pair. `pricing.ts`'s `priceOf` reads whichever id a location's own `list` names and caps it at MRP;
  it does not care how many lists exist.
- `party.ts` holds the one table pairing a tender with the kind of payer it means
  (`payerKindForTender`, `isAccountTender`, `ACCOUNT_TENDERS`) and the words for each party
  (`PARTY_LABEL`, `PARTY_TITLE`). The sale's refusal, the till's picker, the counter's
  `settlementOf` and every receivables query read it, because a tender that accepted the wrong kind of
  payer is a balance nobody can settle. `partyOf` answers `"customer"` for a bill with no payer: a walk-in
  is a party of its own, not a missing one.
- `discount.ts` and `credit.ts` are the two halves of what a party is charged.
  `discountPctFor`/`creditLimitFor` resolve a person's exception over their category's row (`null` means
  inherit); `discountOn` rounds once, so a bill's discount and the sum of its lines cannot disagree by a
  rounding step. `breachesCredit` takes a **nullable** limit - `null` is no ceiling at all and refuses
  nothing, which is emphatically not a ceiling of zero.
- `settlement.ts`'s `allocateSettlement` lays a payment over the open bills oldest first. At most one line
  is ever a part payment and it is always the last, and the lines always add back up to what was allocated.
- `permissions.ts` is roles & permissions: `FEATURES` (the catalogue - label, section, which desks
  may be given each level, and whether it reads hospital-wide), `ACTIONS`, `can`/`holds`,
  `DESK_DEFAULTS` (the five seeded roles, which reproduce each desk's access before roles were
  configurable, except that nobody holds `z_report`), `grantRefusal`, `admits` (a route's `Access`
  against a desk and permissions: `{ ok, wide }` or a 404/403), `readsHospitalWide` and
  `permissionRefusal`. `permissions.test.ts` holds `LEGACY_ACCESS`, the role list every gated
  route carried before roles were configurable, frozen, and pins the seeded roles to it through the
  manifest itself, route by route and desk by desk (the Z excepted).
- `items.ts`'s `ITEM_FIELD_FEATURES` is who may change which field on the item master: the commercial
  half needs `items_stock` at edit, the operational half `item_master` at edit, `active` either.
  `mayEditItemField`, `unauthorisedItemFields` and `mayEditItemImage` take a role's permissions -
  never a desk; a caller with only a desk reads `DESK_DEFAULTS[desk].perms`.
- `items.ts`'s photo section is the one place the 700 KB limit, the three accepted types and every photo
  refusal sentence are written. `mayEditItemImage` is `item_photos` at edit (the seeded manager and counter) - not an `ItemField`,
  because a photo has a door of its own (`PUT /items/:it/image`), not one of the patch's nine boxes.
  `sniffImageType` reads magic bytes only (JPEG, PNG, WebP; SVG and everything else is `null` - SVG is a
  document that can carry script, not a picture), and `checkPhoto` checks size before type so both sides print
  the same sentence. `imageRetiredMessage`, `imageOffMenuMessage` and `imageNoneMessage` are the three refusals
  that name the item (and, for the off-menu one, the outlet); the server decides *which* rule applies (retired,
  off-menu, no photo to remove), this package only supplies the sentence.

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
- `ADJUSTMENT_REQUEST_TRANSITIONS` has no edge back out of `Approved`: approving one both decides it and
  writes the `ADJ-` document in the same step, so there is no ticket stage to withdraw the way a stock
  request's is - `Cancelled` is reachable only from `Request sent`.

## Conventions

- **Every export must be reachable from `src/index.ts` and actually imported** by `apps/api`, `UI` or a test.
  knip (`pnpm lint`) fails on an export nothing uses. A rule with no caller is deleted, not kept "for later".
- **A sentence a rule produces is produced once, here.** The server's refusal repeats it word for word.
- **Tests assert literal expected values**, never the formula re-run, for example
  `expect(apportion(7, [{qty:5},{qty:5}])).toEqual([5,2])`. Table tests list the transitions the floor actually
  walks and the ones it must refuse.
