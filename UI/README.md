# Royal Care - F&B Inventory (React + Vite)

Frontend for the hospital's kitchen, restaurant and retail-counter operation. Five roles,
one shared stock ledger, backed by the `apps/api` Fastify service - all six phases of the backend
are implemented, and the store is an API client end to end.

## Stack

| | |
|---|---|
| Build | Vite 8 |
| UI | React 19 + TypeScript 6, `strict` |
| State | Zustand 5 |
| Routing | React Router 7 (`HashRouter`, so a static build works from any host) |
| Styling | Plain CSS with design tokens - no framework |

## Run

This app is part of the root pnpm + Turborepo workspace - run it from the repo root, not from
inside `UI/` (the API and a local Postgres need to be up too; see `deploy/RUNBOOK.md` for the
full sequence):

```bash
pnpm install
pnpm db:up                                   # postgres:17 in Docker, host port 5439
cp .env.example .env
pnpm --filter @rch/api keys:generate >> .env
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/audit db:migrate          # the audit log's schema, after the API's
pnpm --filter @rch/api db:seed
pnpm dev                                     # apps/api on :3000, apps/audit on :3100, this app on :5173
```

Just this package, once the API is already running elsewhere:

```bash
pnpm --filter @rch/ui dev        # http://localhost:5173
pnpm --filter @rch/ui build      # → dist/
pnpm --filter @rch/ui test
```

The dev server proxies `/api/v1/admin/audit` to the audit service on `:3100` and the rest of `/api`
to the Fastify API on `:3000`. Master data, prices, menus, the
payer roster and every open document are hydrated from `GET /snapshot` on load
(`hydrateMaster`/`hydrateRoster`). Every mutation in the store - fifty-one actions, listed in
`../CLAUDE.md`'s *One Zustand store* - is a server call: billing, availability, prices and
menus, the whole stock-request chain, shop transfers and shop asks, the whole of production, the
whole of buying, the support desk and the two server-side reports, and the audit wave's own four:
the bill void, the kitchen order, the item patch and the adjustment. There is no
in-memory fallback for any of it. `UI/src/api/events.ts` opens one `fetch`-based SSE connection
per session and refetches whatever a write elsewhere changed, so two open tabs stay in sync
without a reload.

Against a real server today, a person can walk a kitchen order across the board, make a batch
that books the finished units onto the kitchen rack and stamps a best-before, dispatch it, hand it over on
a six-digit code and receive it at the counter - with another browser following along live - and
cancel a ticket nobody came for, which puts the stock and the document behind it back where it
stood. Buying, the same way: the store keeper raises a requisition at the central store; the
buyer approves or trims it (or adds items to the procurement list directly, with a reason, from
its "Add items" drawer), draws a purchase order off the procurement list priced from a live
rate contract, and sends it to the vendor; the order is received against a delivery note in
instalments, with a rejection at the door landing in a quarantine shelf that never sells and
never issues; and closing an order short hands the undelivered balance straight back onto the
procurement list. And now: raise a support ticket from any role's own Support screen, watch it
move through the desk's states as a reply lands, and rate the fix - every role sees only its own
tickets - and read the two reports the browser could never assemble on its own, a location's
stock ledger and a payer's credit for the month. A second browser watches every one of these
moves happen live, the same as the rest of the system.

## Sign in

Real authentication - employee id and password, checked against the API. Each account lands
somewhere different and sees a different sidebar.

Staff do not type their id: the form's employee picker is a searchable list of every active staff
account, number and name, read from the public `GET /auth/directory` before anybody signs in. Pick
yourself (by click, or arrows and Enter), then type the password. The super admin is deliberately
not on that list - "Sign in as administrator" swaps the picker for a typed id field, and "Back to
the staff list" swaps it back. If the list cannot be read, the typed field is shown with a line
saying so, so nobody is locked out by it. A super admin lands on `/admin` and never loads the
hospital's snapshot. The seed password is `SEED_PASSWORD` from
`.env` - required, at least twelve characters, with no default, so whoever sets a host up chooses
it; a staging/prod seed sets `must_change_password`, which routes first sign-in through a
change-password step before anything else.

A refused sign-in - an unknown id, a wrong password, a deactivated account - says so on the form
itself, in the server's own one sentence for all three, and the sentence stays there until the
next attempt. A browser that cannot reach the server at all says that instead. Neither is a
toast: the sign-in screen is outside the shell, and a sentence that vanishes in seconds is never
read by someone still looking at the keyboard.

| Employee id | Account | Role | Lands on |
|---|---|---|---|
| `RC-4471` | Kavitha Raman | Counter Operator · Coffee Shop | Point of Sale |
| `RC-3120` | Ramesh Kumar | Outlet Manager · All outlets | Approvals |
| `RC-2088` | Suresh Muthu | Store Keeper · Central Store | Issue Desk |
| `RC-1902` | Vinoth Prakash | Kitchen In-charge · Central Kitchen | Orders |
| `RC-1550` | Latha Narayanan | Procurement Officer (not tied to one counter) | Requisitions |
| `RC-4482` | Deepa Selvam | Counter Operator · Kiosk | Point of Sale |
| `RC-0001` | System Administrator | Super Admin - no role or location (typed id, not on the picker) | Staff accounts |

On the staff accounts page the employee id is not typed either: the form shows the next number,
read-only (`nextEmpNo` from `@rch/domain`, one past the highest `RC-<digits>`), and the server
assigns it on save. The super admin's own row reads "Super Admin" with no role or location
pickers. A deactivated staff account gets a Delete button that asks a second time ("Delete
RC-xxxx permanently" or "Keep"); the server still refuses one with any history, and says so.

## Layout

```
src/
  types.ts, nav.ts, drawers.ts, App.tsx   entities · sidebar & route guard · drawer registry · router
  api/                                    client.ts (the one generic client - routes, idempotency, 401-refresh
                                           retry), session.ts (in-memory token), events.ts (SSE change stream),
                                           refetch.ts (pulls back what a write changed), wire.ts (mappers)
  store/{index,procurement,ops,audit}.ts  Zustand, all server-backed - index.ts holds most actions (billing,
                                           availability, prices/menus, the request→ticket chain, production,
                                           the two report reads, the bill void, the kitchen order);
                                           procurement.ts (vendors, requisition approval, the PO lifecycle,
                                           goods receipt); ops.ts (rate contracts, new-product requests,
                                           shop-to-shop transfers, the support desk, the item patch,
                                           adjustments, adjustment requests); audit.ts (the audit log's reads,
                                           its new-events count and the CSV export)
  data/                                   master.ts (empty registries, replaced in place by hydrateMaster() and
                                           hydrateRoster()), vendors.ts - no seed.ts, no ops.ts; nothing here
                                           imports the fixtures
  lib/                                    fmt.ts (money, quantity, time), selectors.ts (qty · resv · avail ·
                                           freeToPromise · availOf · priceOf · procurementList …), theme.ts,
                                           audit.ts (deviceOf, diffFields, auditCsv, auditDayRange)
  ui/                                     kit.tsx (~30 typed components incl. DraftLineInput and EtaInput),
                                           Tip.tsx (the one tooltip: every explanation on a page, card,
                                           field, figure or button opens on hover, focus or tap),
                                           Shell.tsx, Drawer.tsx, ErrorBoundary.tsx, prefs.ts, and four
                                           shared non-kit pieces more than one role needs: TicketSlip.tsx,
                                           NewProductForm.tsx, AdjustmentForm.tsx (store, kitchen, and - in
                                           its request mode - the counter), KitchenOrderForm.tsx
  pages/                                  Login.tsx, ChangePassword.tsx, Settings.tsx, Support.tsx, and the
                                           admin page: AdminDashboard.tsx, AdminUsers.tsx, AdminSupport.tsx,
                                           AdminAudit.tsx, AuditEntryDrawer.tsx
  roles/<role>/                           counter/ manager/ store/ prod/ buyer/
  __tests__/                              store, procurement, fixes, screens/app, audit-screens, time,
                                           drawer, api, session, events, writes, refusals, theme, po-board,
                                           login-picker, admin-accounts, admin-audit, audit-lib
```

Each role folder exports `screens: Record<string, ComponentType>`; `App.tsx` resolves the
route key against the signed-in role. A route the role cannot reach redirects - it is not
merely hidden from the sidebar.

## Domain rules worth knowing

**Two approval stages.** A counter raises a request → the **outlet manager** approves and may
trim quantities → the **store keeper** issues a pick ticket → the counter collects and
receives. Approval reserves stock; the handover scan is what actually moves it. The whole
chain is server-side (`apps/api/src/modules/{requests,tickets}`); a trim beyond what the
central store can still promise is the server's own decision, not the browser's.

**MRP is a hard ceiling, and there is no door that removes one.** Traded goods carry a printed
MRP. No price list, floor or role may sell above it - `savePrice` refuses and says so - and no
role may clear it either: an item that carries a printed MRP keeps one, and an emptied box on the
edit form means "leave it as it is", not "take the ceiling away".

**What a sale takes off the shelf.** Traded goods and finished goods made in the kitchen deduct by
the unit. A made-to-order drink is made at the counter and holds no stock, so selling one moves
nothing.

**Availability is computed.** Traded and finished goods switch off at zero; a made-to-order
item stays on until someone switches it off. The toggle is a manual override on top.

## Recent capabilities

**Correcting a shelf is a document.** A write-off or a stock count is raised from the shelf it
corrects - the store keeper's Adjustments screen for any location including quarantine, and an
Adjust stock drawer on the kitchen's own stock screen. It carries a reason (wastage, breakage,
expired, stock count, returned to vendor, other), a note, a signature and any number of signed
lines: negative writes off, positive counts up, and a positive line is how a location that has
never carried an item comes to carry one without a delivery. A write-off may not take stock a
pick ticket is holding, and the register on the same screen is where a month of it reads back by
reason. An outlet's own shelf is the one exception: the manager does not open that form directly
any more, only a counter does, from a "Request adjustment" button on its own Stock in Hand
screen - the same form, in `mode="request"`, which sends the ask to the outlet manager instead of
writing the ledger. The manager decides it from a card on Approvals, alongside the stock-request
queue: Approve writes the `ADJ-` document and moves the shelf in the same step (there is no ticket
stage after it, since a write-off has nothing to hand over), or Reject with a reason the counter
reads on its own copy of the request.

**A bill can be taken back on the day it was billed.** The outlet manager gets a Bills screen -
every outlet's, over the seven days the server answers for - and a Void button on any bill still
dated today. It needs a typed reason, puts every stocked line back on the shelf, returns a staff member's credit room for
the month, and leaves the bill on every list badged VOIDED rather than disappearing from the day.
Every figure that counts money or quantity sold skips it; the activity feed and the search still
show it. After that day, the answer is an adjustment, and the refusal says so.

**The item master is editable, and editable by desk.** One Edit drawer, reachable from every
master and stock screen, showing each role only the fields their desk owns: the manager the
printed MRP, the standard cost and the GST rate; the store keeper, buyer and kitchen the name,
the group, the HSN code and the reorder level. The other half is greyed out with a sentence
saying whose it is. A product is **retired, never deleted** - refused while any location holds
stock of it or any outlet still lists it, naming them - and a retired line keeps its name on
every document that already carries it while dropping off the pickers that could sell, order or
promise it again. The manager's drawer also carries a `PhotoPicker` at the top, for one photo per
item.

**A product can carry a photo.** The manager sets one for any item, from its Edit drawer; a
counter sets one for whatever its own outlet sells, from the same Configure panel the POS tile
menu and the Stock in Hand card already open - a product not on that outlet's menu shows the
photo with no buttons to change it. The photo is shrunk and checked in the browser before it is
sent, replaces the grey placeholder everywhere a screen already reserved one for an item, and
updates on every open browser over the change stream like everything else.

**The payer register is the super admin's.** Patients, staff members, departments and doctors are
opened, renamed and switched off on `/admin`'s Payers tab, and reach the till's picker over the
change stream without a reload; the `kind,id,name` CSV import
(`pnpm --filter @rch/api payers import --csv`) stays for a ward list nobody types twice. A payer is
deactivated rather than deleted - their balance has to stay findable - so a switched-off account
leaves every till's picker and every bill already charged to it stays exactly as it was.

**Who is billed decides what they pay.** The outlet manager's **Credit & Settlements** screen
carries a rate card: one discount and one credit limit per category - customers, patients, staff,
departments and doctors - with a per-person exception over it for the consultant on terms of their
own. The till shows the gross, the concession and the net, and the printed slip carries all three;
the rate on the screen is a preview, and the server resolves it again inside the sale's own
transaction. The ceiling is on what is **unsettled** rather than on a calendar month, so somebody
who clears their account on the 15th can buy coffee on the 16th, and a party the manager gave no
limit is told so in words rather than shown a number nobody chose.

**And the manager can see who owes what, and take the money.** The same screen lists every account
with what it has been charged, what has been paid and how old the oldest open bill is. Recording a
payment lays it over that person's open bills oldest first and stores which ones it closed, so a
part-settled bill reads as the part that is left; more than is owed is refused, naming the balance.
A payment keyed against the wrong consultant is voided on the day it was taken - badged, never
erased - and the bills it closed reopen.

**An outlet asks in two ways, and the screen decides which desk hears it.** The counter's Stock
Requests screen offers exactly two tiles - **From inventory** and **From other shops**. From
inventory is one picker over one list: everything the central store stocks *and* the finished
goods on that outlet's own menu, interleaved by group, with as many lines as the ask needs. On
send, the screen splits them - finished goods become a production order on the kitchen, the rest
a stock request on the store - so the operator picks products, not departments. Made-to-order
items are absent from the list: they hold no stock and the kitchen's route refuses them by name.
A kitchen line brings a needed-by date with it, which the kitchen's board and drawer both print.
The manager's dashboard keeps its equivalent button for any outlet. Raising either reserves
nothing: dispatching it is still what places the hold. Below the tiles, "With the kitchen" is the
counter's read-only window on the orders the split raised - a production order never appears
under All requests.

**Pay & print actually prints.** The till opens the new bill's drawer on a successful sale, and
the drawer prints a real slip - bill number, outlet, terminal, the hospital's own date, the
operator, every line as qty × rate × amount, taxable value, tax, total, tender and the payer
where there is one. Reprint calls the browser's print dialog instead of announcing that something
was "sent again to the OT-C3 printer", which never happened. Pick tickets print the same way, and
a ticket slip carries the six-digit code only when the reader is entitled to it. The counter's
dashboard lost its invented shift, its hours and its ₹2,000 opening float at the same time -
there are no shifts in this build, so every one of those figures was made up at render time.

**Support, for every role, server-backed.** `/issues` - labelled Support in every sidebar - is
customer care for the portal itself: sign-in trouble, a screen that will not load, a number that
looks wrong, printing, slow or frozen, training, or a feature request; a stock or kitchen
problem goes to the screen that owns it instead. Raising one names a topic and a screen and
requires a subject (not a body); it opens a message thread that moves Open → With support →
Waiting on you → Resolved → Closed, and the raiser rates the fix 1–5 once it is resolved. Every
role sees only the tickets it raised; none of the five answers tickets.

**Outlets, on `/admin`.** The admin-flagged account's Outlets tab lists every retail outlet - open ones
first, then by name - with its code, floor, cost centre and how many staff are posted there.
Opening one asks for a name, a code, a floor and a cost centre, and previews the key the server will
actually assign from the name - given once, and kept even through a later rename. A new outlet starts
with no menu and no price list: the outlet manager lists and prices its products from their own Prices
screen, which is also where a price list is created and attached. Each row edits in
place with Save and Cancel, and closes behind a second press, refused in one sentence naming everything
still open against it (stock on the shelf, a ticket, a stock request, a kitchen order, a shop ask, a
product request, or a member of staff) if anything is. A closed outlet is never deleted: its bills,
moves and reports stay, its menu, availability overrides and price list are kept exactly as they were,
and a reopen restores it. The store and the kitchen are fixed and are not listed here; a new outlet
appears in every other picker - the Accounts tab's location select included - the moment it opens.

**The support desk, on `/admin`.** The admin-flagged account's third tab lists every ticket from
every role, most pressing first (open, then with support; urgent before routine), filterable by
status, priority, role and location. Picking one shows who raised it, from which screen, and the
conversation. The admin replies as support under their own name - Send, Send & ask the reporter
(Waiting on you) or Send & resolve - and can pick a ticket up, mark it resolved, reopen it or close
it. Only the moves `SUPPORT_TRANSITIONS` allows are drawn. The reply reaches the reporter's
Support screen over the change stream, and a new ticket or a reporter's reply lands on the desk
the same way.

**The audit log, on `/admin`.** The admin-flagged account's third tab answers who did what, when,
from where and with what result, for every change anyone makes and every sign-in. "Every change
and sign-in, with who made it and when." Filter by period (today, 7 days, 30 days or a custom
range), person, role, location, area and outcome, or search; four counts over the whole filter
read events, people, refused and failed sign-ins. Location finds the person's location or the
target's. The list is newest first and never moves by itself: while it is open, new events raise a
"New events - show" pill, and pressing it reloads.
A row opens the entry - who (as the account stood then), when to the second, the IP and the device,
the method and path, the server's sentence and a refusal's cause, what was sent, what came back,
and for an edit only the fields that changed, before → after. From there, "Everything by this
person" and "Everything on" the target narrow the list. Export CSV downloads the filtered log, up
to 50,000 rows, and says so when it stops there. Passwords, codes and tokens are never in it. The
log is kept by a separate service, `apps/audit`; when that service cannot be reached the tab says
so rather than showing an empty log.

**A six-digit code instead of a scanned one, and it is withheld from the desk that issues it.**
A pick ticket carries a code minted when it is created. The collector reads it aloud to the
store keeper (or the kitchen in-charge), who types it at handover; a wrong code is refused. The
code reaches the wire only for a caller standing at the ticket's own destination while it is
still `Issued` - the issuing desk's own screen, and everyone else's, never shows it. A
supervisor override exists and is labelled as one - restricted to the store and the kitchen -
and is recorded on the ticket's own trail, now visible in the ticket drawer, as
`Handed over - supervisor override`.

**The ticket's own history, on screen.** Every ticket now carries its full trail - `Issued`,
`Handed over` (with the override named when used), `Received`, or `Cancelled - <reason>` - read
back through the same drawer that shows a request's history. A counter can also withdraw a
shop-to-shop transfer it raised, from a "Sent from this counter" card, before anyone collects
it.

**The purchase orders board.** The buyer's Purchase Orders screen is a board, not a stack of
tables: Draft, Ordered, Received and Cancelled columns side by side, sharing the page's width and
scrolling sideways on a narrow screen. Partially and fully received orders share the Received
column; each card there carries its own status, and the column's Show filter narrows it to either.
Every order is a card in its column, newest raised on top (sorted on the order's `iso` instant),
with one search box and Vendor and Approval filters over the whole board. Clicking a card opens
the order's details in the drawer that slides in from the right; a card's own Receive button
opens the goods receipt instead.

**Rate contracts.** Vendor and item, rate, validity window and minimum order quantity, server-
backed since Phase 5. The procurement officer maintains them (`POST`/`PATCH`/`DELETE /contracts`
all admit `buyer`, and the screen lives only on the buyer's own nav - the store keeper never sees
it), adding several products to one vendor's contract at once from a sidebar drawer; procurement
prices an order from them (`createPo` picks a live contract's rate over the item's standard cost)
and is warned on screen when a rate deviates or a quantity falls under the minimum. Only one live
contract may exist for a given vendor and item at a time.

**Adding to the procurement list directly.** The buyer does not have to wait for the store
keeper to ask. "Add items" on the Procurement List opens a drawer of raw, packing and MRP lines
(what the kitchen makes or the counter assembles is never offered) and a required reason, and
`POST /requisitions/direct` records it as a requisition raised and approved by the buyer in one
step. Its lines join the list beside every other approved line, a purchase order claims against
them the same way, and both requisition screens mark it as added by procurement.

**The buyer's decision reaches the store keeper.** A decline needs a reason, and a trim or an
approval can carry a note. Both requisition panels open on the decision itself: who took it, which
way and that note (`prqDecision` / `decisionSentence` in `lib/selectors.ts`). The store keeper's
own words sit below it under their own label, and the note also appears on the history entry that
recorded the decision. The store keeper's requisition list prints the reason beside a declined or
trimmed requisition, and a search finds it. Their dashboard raises a DECLINED or TRIMMED alert for
every decision taken today (IST), with an Open button for the requisition.

**New products.** An outlet manager asks for something not on the master; procurement is the
one who sources it, so procurement is the one who adds it - the store keeper's form (name, code,
type, group, unit, HSN, GST, reorder level, cost, MRP if applicable), limited to the types
procurement buys (RAW, PACK, MRP) and with no opening stock. Stock arrives the normal way,
through a purchase order, not as an opening balance typed in on the spot. Server-backed since
Phase 5 (`POST /product-requests`, answered by `POST /product-requests/:id/answer`), and the
store keeper and the kitchen can each add a product directly too - the kitchen for its own raw
materials and finished goods, the store keeper at the central store.

**Shop-to-shop transfer.** When one outlet needs an MRP product another is holding, the stock
moves directly between them: reserved at the source, released against an OTP, received at the
destination. The outlet manager sees it happen rather than standing in the middle of it.

## What is still client-side, and why

The store holds no business rule of its own any more - every action is a call to the API, and a
refusal is the server's sentence, not a client-side check. What stays in the browser is only
what has nothing on the server to be a client of: `cart`, `draft`, `prqDraft`, `poolVendor` (the
vendor the buyer picked on each procurement-list row, kept until that item is ordered in full),
`drawer`, `toast`, `shopFilter`, `theme`, `catalogVersion` (the signal that repaints a screen pinned to the
catalogue after a live update) - plus the access token, held in memory and never in
`localStorage`, and the theme and a couple of UI preferences, which do reach `localStorage`
because there is nothing for the server to say about which theme a browser prefers.

`@rch/domain`'s functions run client-side too, but as **previews only** - a cart total before
paying, whether an item shows as available, the Dispatch cover check - computed with the same
functions the server enforces with, never a second copy of a rule. The refusal, when one
happens, is always the server's.

## Try it end to end

`apps/api/scripts/loadcheck.mjs` (`../deploy/RUNBOOK.md` §12) measures whether `/snapshot` and
`/bills` meet their latency targets against a running API.

## Out of scope

Barcode scanning, patient-bill posting and GST output registers remain out of scope, along with
a handful of features this document's original spec proposed and the team declined - a
purchase-return or debit-note document out of quarantine (the shelf itself can be corrected with
an adjustment; recovering the money from the vendor cannot), a finance approval role, batch-wise
MRP with FEFO issue, a credit note after the day is out (a bill is voided on the day it was
billed, or not at all), and the shift/day-close workflow: there are no shifts, no cash
declaration, no tender variance and no day lock, and nothing writes stock off on a schedule.
The phase-by-phase status is the table in the root `../README.md`.
