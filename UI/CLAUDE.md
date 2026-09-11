# UI — CLAUDE.md

Repo-wide rules, the movement rule and the domain invariants are in the root `../CLAUDE.md`;
`UI/README.md` describes the app for a reader rather than an agent. This is what is specific to
`@rch/ui`.

## What this is

React 19 + Vite 8 + TypeScript (strict, `verbatimModuleSyntax`, `erasableSyntaxOnly`) + Zustand 5.
Routing is `HashRouter` with **one** route, `/:key`, so the static build works from any host with
no SPA rewrite. The store is an API client end to end: it signs in for real, hydrates from `GET
/snapshot`, and posts every write. `UI/src/data/seed.ts` and `UI/src/data/ops.ts` are gone — no
production file under `UI/src` imports `@rch/contract/fixtures` any more, only the tests do.
Only the theme and a couple of UI prefs reach `localStorage`.

## Commands

```bash
pnpm --filter @rch/ui dev         # vite on :5173, proxying /api -> http://localhost:3000
pnpm --filter @rch/ui test        # vitest run (jsdom)
pnpm --filter @rch/ui typecheck   # tsc --noEmit -p tsconfig.app.json
pnpm --filter @rch/ui build       # tsc -b && vite build -> UI/dist
```

`npx vitest run src/__tests__/writes.test.ts` from inside `UI/` runs one file.

## Three files must agree for a screen to exist

1. `src/nav.ts` — `NAV[role]` is the sidebar (groups → `{ k, label, icon }`), `HOME[role]` the
   landing key, `canSee(role, key)` the guard.
2. `src/roles/<role>/index.tsx` — exports `screens: Record<string, ComponentType>` keyed by the
   same route key, and imports its drawer modules for their side effects.
3. `src/App.tsx` — `REGISTRY[user.r][key]`. A key the role cannot see renders `<Denied>`, which
   **toasts why** and redirects home (UA-01); an unknown key renders a "Coming up" placeholder.
   `settings` and `issues` are handled ahead of the registry.

`src/__tests__/screens.test.tsx` and `app.test.tsx` iterate `NAV` × `USERS` and assert every
advertised key renders, bare and in-shell. A nav entry without a component fails the suite; that
coupling is deliberate.

Drawers are a bare registry (`src/drawers.ts`): a module calls `registerDrawer("key", C)` at the
bottom of its file, the role's `index.tsx` imports it for the side effect, `openDrawer(t, id)`
opens it, and `ui/Drawer.tsx` + `DrawerFrame` supply the chrome. `"sitem"`
(`roles/store/NewProductDrawer.tsx`) is the store keeper's own Add Product drawer, registered in
Phase 5 — its button had opened nothing since the procurement rework; `"bnewitem"`
(`roles/buyer/NewProductDrawer.tsx`) is the buyer's, answering a shop's product request.

## The store is an API client

`src/store/index.ts` holds the state and most actions; `store/procurement.ts` and `store/ops.ts`
are merged into the same `create()` and share one `AppState`. Components subscribe narrowly:
`useApp((s) => s.req)`.

**On the server now, every action in the store** — Phase 2: `pay`, `toggleAvail`, `savePrice`,
`addProduct`, `removeProduct`. Phase 3: `submitRequest`, `requestFromStore`, `cancelRequest`,
`approveRequest`, `rejectRequest`, `issueTicket`, `handover`, `receiveTicket`, `dispatchOrder`,
`distribute` (in `store/index.ts`) and `transferToOutlet`, `askShop`, `answerShopAsk`,
`declineShopAsk` (in `store/ops.ts`). Phase 4: `setOrderStatus`, `makeProduct`, `cancelTicket`
(in `store/index.ts`) — production is finished. Phase 5: `sendRequisition` (in
`store/index.ts`); all fourteen of `store/procurement.ts` (`addVendor`, `updateVendor`,
`setVendorActive`, `approveRequisition`, `declineRequisition`, `createPo`, `updatePoLine`,
`removePoLine`, `setPoVendor`, `setPoEta`, `sendPo`, `cancelPo`, `receivePo`, `closePoShort`);
and six more of `store/ops.ts` (`requestNewProduct`, `answerProductRequest`, `addContract`,
`updateContract`, `removeContract`, `createItem`) — buying is finished. **Phase 6, the last
four**: `store/ops.ts`'s support desk (`raiseTicket`, `replyToTicket`, `setTicketStatus`,
`rateTicket`) — the last in-memory path, closed. Two reads join them, not writes:
`readStockLedger(loc, days)` and `readCredit(payer)` (both `store/index.ts`), each a plain `GET`
with no `notify`/`refetch` of its own — `roles/store/Reports.tsx`'s ledger screen and
`roles/counter/Pos.tsx`'s credit panel are the two screens that call them instead of deriving a
number the browser no longer holds. The kitchen's screens keep only previews now: `ceiling` and the
Dispatch cover check, computed with the same `@rch/domain` functions the server enforces with,
not a second copy of the rule. Session actions — `login`, `restore`, `loadSnapshot`, `logout`,
`changePassword`, `saveProfile` — go through the same client.

**`loadSnapshot` sets `auth: "loading"` only when there is genuinely nothing on screen** —
`Object.keys(LOC).length === 0`, the one state with no item master, no locations and no screen
that could render. Every other call to it is a *background* refresh (an SSE `resync`, a
read-back), and blanking the hospital to "Loading…" for one threw away whatever was being read,
closed every open drawer and lost the operator their place. The empty-registry test is also what
distinguishes a failed **first** snapshot (`auth: "failed"`, the shell offers a retry) from a
failed refresh, which keeps the last good screen and only toasts.

`Seq` (`store/index.ts`) is gone entirely — every document the server numbers is numbered there
instead. There is nothing left to cut over: every mutation in the app is a server call.

**Every buyer and store screen that shows what a vendor has delivered reads `netReceived(l)`, not
`l.recv`** — `lib/selectors.ts` (`prqProgress`, `onOrder`), `roles/buyer/lib.ts`'s `reconcile`,
`PoReceiptDrawer`, `PoDrawer`, `PurchaseOrders`, `buyer/Dashboard` and
`store/RequisitionDetail`. `recv` stays the gross arrival record on the wire; the figure a buyer
reasons about is what the shelf accepted, so Accepted + Balance = Ordered holds on every one of
them. Two headers changed with the number under them, and no test or e2e selector pinned either:
`PoDrawer`'s items column is **"Accepted"** and `PoReceiptDrawer`'s is **"Already accepted"** — a
`0` under "Received" after a 120-unit delivery that was turned away reads as a bug, not a
rejection. `PoDrawer`'s GRN table keeps its own "Received" header: it lists what each individual
GRN row booked, which is a different figure. The one deliberate exception is `anyReceived`, which
stays **gross**, mirroring the server's `cancel` guard — a delivery that arrived and was sent back
still left GRN documents, a quarantine balance and a paper trail, so that order is closed short
with a reason, never cancelled.

One deletion is worth naming: `PoDrawer.tsx`'s effect that used to re-price every line when the
vendor changed is gone, not awaited — both places that price a line (`createPo` drafting off
the procurement list, and `PATCH /purchase-orders/:id` re-pricing when the vendor moves) are
server-side now, and an effect that writes on render would have fired one request per line on
every open of the drawer.

Every server-backed action has the same shape, and a new one must too:

```ts
try {
  const r = await call(routes.<name>, { params, body });   // src/api/client.ts
  // clear only client-only state (a cart, a draft) once the server has taken it
  get().notify(r.message);                                  // the server's own sentence
  await refetch(r.changed, r.message);                      // src/api/refetch.ts
  return true;                                              // form-carrying actions only
} catch (e) {
  get().notify(e instanceof ApiError ? e.message : "Could not … — check the connection and try again.");
  return false;
}
```

- **Never invent a success message.** `r.message` is written in the operator's voice by the
  server; an `ApiError`'s `message` is the refusal. The fallback string is only for a network
  failure, when there is no envelope to read.
- **No rule is previewed as a decision.** `freeToPromise`, `availOf` and `priceOf` in
  `lib/selectors.ts` are previews while the operator types; the refusal is the server's. Preview
  with the server's own function where one exists rather than a lookalike: `lib/selectors.ts`
  re-exports `netReceived` and `RECEIPT_TOLERANCE` beside `apportion`/`round3` for exactly that
  reason, and `roles/buyer/PoReceiptDrawer.tsx`'s over-delivery warning now runs the same sum
  `checkReceiptLine` does instead of its own `1.02` literal.
- **Form-carrying actions return `Promise<boolean>`** and the screen `await`s them behind a
  `busy` flag, clearing the form only on `true` — so a refusal leaves what was typed on screen.
  `roles/counter/Pos.tsx` (single `busy`) and `roles/counter/Requests.tsx` (a keyed
  `busy: string | null`, one per row) are the two patterns; copy one of them. `makeProduct` and
  `cancelTicket` are this pattern's newest members — a batch form and a cancel-reason form each
  reset only once the server has taken them. Buying adds a whole slice of them:
  `sendRequisition`, `approveRequisition`, `declineRequisition`, `updatePoLine`, `setPoEta`,
  `sendPo`, `cancelPo`, `receivePo`, `closePoShort`, `addVendor`, `updateVendor`,
  `requestNewProduct`, `answerProductRequest`, `addContract`, `updateContract`.
  `cancelRequest` joined them in the audit fix wave — it returns `Promise<boolean>` now, not
  `Promise<void>`, because `manager/ApprovalDrawer.tsx`'s **Withdraw approval** button needs the
  same busy lock and close-on-success its `doApprove`/`doReject` siblings have, and must not close
  the drawer over a refusal. Its two other screens (`counter/RequestDrawer.tsx`,
  `prod/Requests.tsx`) ignore the return value, as they always did.
  **`pay`, `savePrice`, `addProduct` and `removeProduct` joined them in the same wave** — every
  one of the forty-seven now answers whether the server took the write, so no action in the store
  is `Promise<void>` where a caller might want to know. Two of their screens have not caught up
  yet and it is deliberate, not an oversight to copy: `counter/Pos.tsx` still clears the payer and
  the tender after `await s.pay(…)` whatever it answered, and `manager/Prices.tsx` still drops the
  edit after `savePrice(…)`. The return value is there for them to read; reading it is the screen
  change, and it has not landed.
- **Where the screen needs the id the server chose, the action answers `Promise<string | null>`
  instead** — `null` on a refusal, the same as `false`. `createPo` (the drawer needs the new
  draft's id to navigate to it) and `createItem` (the new-product drawers need the catalogue key
  to link a product request or close themselves) are the two members of this variant.
- **A button with no form is fire-and-forget.** `setOrderStatus`, `handover` and `dispatchOrder`
  call, notify and refetch without a `busy` lock or a `Promise<boolean>` — there is no form to
  leave filled in on a refusal, only a toast. `removePoLine`, `setPoVendor`, `setVendorActive`
  and `removeContract` are this pattern's Phase 5 members: each is a single press with nothing
  typed to lose.

## Reading back

`src/api/client.ts` is the one generic client: `call(route, input)` builds the URL from the
manifest, mints an `Idempotency-Key` for a write and an `x-request-id` for **every** request
(both **once per call**, so the post-refresh retry is the same request), and on a 401 refreshes
once and retries. `ApiError` carries `code`, `status`, `message`, `details` and `requestId` —
read off the response's own `x-request-id` where the server echoes one, else the id that was
sent, so the reference the operator can quote is always the one in the server's log line. (The
server forwards what it was handed rather than minting over it; nginx's `map $http_x_request_id
$req_id` does the same on the Compose path.) There are no hand-written fetch wrappers — add a
manifest entry instead.

**The 401 refresh is cross-tab, and getting that wrong signs everybody out.** Refresh tokens
rotate, so two tabs of one operator that 401 in the same instant both present the same rotated
token — which the server's reuse detection reads as a stolen token and answers by revoking the
whole family, signing both out mid-shift. Three pieces, all in `client.ts`:

- The refresh runs inside `navigator.locks.request("rch-refresh", …)` where the browser has a
  lock manager, and falls back to plain single-flight where it does not.
- A successful refresh broadcasts `{ accessToken }` on `BroadcastChannel("rch-session")`; every
  tab opens that channel on its first `call()`. A broadcast **replaces** a token a tab already
  holds and never hands one out — a tab sitting on the sign-in screen must not be walked into
  somebody else's session on a shared terminal.
- **The generation check.** `call()` captures the token its request was built with and passes it
  to `refreshOnce(had)`. Inside the lock, if the current token is no longer `had`, another tab
  has already refreshed, so the answer is *retry*, not *refresh again* — a second refresh is
  exactly what reuse detection reads as theft. `events.ts`'s stream passes the token it opened
  with, for the same reason.

`src/api/refetch.ts` pulls back exactly what a write said it changed. `stock`, `rsv` and `ovr`
come from `GET /stock`; `NARROW` maps `bills → GET /bills`, `req → GET /requests`,
`tkt → GET /tickets`, `shopAsks → GET /shop-asks`, `pord → GET /prod-orders`,
`batch → GET /batches`, buying's six — `prq → GET /requisitions`, `po → GET /purchase-orders`,
`grn → GET /grns`, `vendors → GET /vendors`, `contracts → GET /contracts`,
`productReqs → GET /product-requests` — `items → GET /items`,
`tickets → GET /support/tickets` (`applySupportTickets`) for the support desk's own `changed`,
and — since the audit fix wave — `prices → GET /prices` (`applyPrices`) and
`menu → GET /menus` (`applyMenus`), the manager's two.

**Every collection in `CollectionSchema` now has a narrow reader, so a valid `changed` set never
costs a snapshot.** That is the point of the pair: `loadSnapshot` pulls the whole hospital back
down, and until this wave it also put every screen behind the loading splash to do it, so a
one-field price edit blanked the till. The `if (… !NARROW[c] …) loadSnapshot()` fallback stays in
the file as the guard for the **next** collection added to the enum and not to `NARROW` — that is
what it is now for, and the two tests that cover it drive it with a cast
(`"a-collection-with-no-reader" as Changed`) because no real member reaches it. A mixed set still
takes the snapshot alone. If the read-back fails the write's own sentence is kept and qualified, never replaced:
the operator must not be sent round to do it twice. `src/api/wire.ts` holds the server-shape →
store-shape mappers (`applySnapshot`, `applyStock`, `applyBills`, `applyRequests`,
`applyTickets`, `applyShopAsks`, `applyProdOrders`, `applyBatches`, `applyRequisitions`,
`applyPos`, `applyGrns`, `applyVendors`, `applyContracts`, `applyProductRequests`, `applyItems`,
`applySupportTickets`, `hydrateRoster`); ISO times become `"HH:MM"` there and nowhere else — **and
the instant is kept beside the string**, see *`iso`* below — and
every ticket's `hist` passes through the file's shared `hist()` mapper in both `applySnapshot`
and `applyTickets`, so a raw ISO instant never reaches a ticket drawer's trail whichever path
refetched it. `applySnapshot`, `applyItems`, `applyPrices` and `applyMenus` all bump
`catalogVersion`, the signal the catalogue's own screens read since it is a module-level registry
(`data/master.ts`) and not store state — an SSE `resync` no longer leaves a new item invisible
until reload, which Phase 5 left as a known gap and Phase 6 closed. The last two are built on
`hydratePrices` / `hydrateMenus` in `data/master.ts`, which `hydrateMaster` now reuses rather
than filling those two registries a second way.

### `iso`: the instant beside the printed time

`wire.ts`'s shared `stamped()` helper puts **`iso`** — the raw wire stamp, verbatim — beside the
`"HH:MM"` it formats, on every document (`bills` from `t`; `req`, `prq`, `po`, `pord`, `grn`,
support `tickets`, `productReqs`, `shopAsks` from `at`) and on every history entry, in
`applySnapshot` **and** in each narrow reader. The store types say so: `Dated<T>`, `Trailed<T>`
and `DatedDoc<T>` in `src/types.ts` — `req`/`prq`/`po`/`pord` are `DatedDoc<…>[]`, `tkt` is
`Trailed<Ticket>[]` (a movement ticket has no `at` of its own, only a trail), `bills`/`grn` are
`Dated<…>[]`, and `store/ops.ts` declares `tickets`/`productReqs`/`shopAsks` the same way.

Without it the browser could answer neither question it asks on every screen. **"Is this today?"**
— `GET /bills` returns seven days and nothing filtered them, so a Monday shift opened showing the
previous week's takings under the word "today". **"Which is latest?"** — `"22:00"` sorts above
`"09:00"` whatever day each belongs to, putting yesterday's last bill above this morning's first.

So: **a time column sorts on `iso`, never on the printed string** (ISO-8601 is lexically ordered,
so `useSort`'s `sortRows` needed no change — only the key did), and **anything labelled "today"
filters on `isToday(iso)`** (`lib/fmt.ts`), which compares `istDate` of the two instants so the
day boundary is Asia/Kolkata's midnight and not the host's. Unparseable answers `false`: a figure
labelled "today" must never quietly include a row nobody can date. `now()` in the same file gained
the `timeZone: TZ` it was missing, without which it ran 5 h 30 m behind the converted times in the
next column. `__tests__/time.test.tsx` pins all of it with instants deliberately on the far side
of an IST midnight from their UTC date, so a host-day comparison gets every case wrong.

`src/api/events.ts` keeps every tab current: one `fetch`-based SSE connection (not `EventSource`,
which cannot send an `Authorization` header), frames parsed by hand, notices debounced
`EVENT_DEBOUNCE_MS` (250 ms) per collection into **one** `refetch`, a `resync` frame superseding
the lot with a full `loadSnapshot`, a 1 s → 30 s backoff ladder that honours the server's `retry:`
hint first, and the same refresh-once-then-sign-out path as `call`. It follows `state.auth` rather
than hooking `login()`, so `restore()` and `changePassword()` are covered too. `main.tsx` calls
`startEventStream()` once, before `restore()`.

`useStreamState()` feeds **two** things in `ui/Shell.tsx`, and they say different amounts on
purpose. The `Reconnecting` **pill** appears only in that one state — a badge that is always
there stops being read. The header **dot** (`.org .dt`) is always there and now tells the truth
about all three: `live` → `--good`, `reconnecting` → `--warn`, `off` → `--ink-4`, with the same
sentence on `title` and on the dot's `aria-label`, so colour is never the only way to read it
(`STREAM` at the top of `Shell.tsx`). It used to be a `<button>` with no `onClick` and a
hard-coded green background, which meant the light the Support FAQ points an operator at read
"all well" with the stream down; it is a `<div>`, because it was never interactive. **The colour
is an inline style, not a class**, because `.org .dt` in `styles.css` paints one colour for all
three states. Separately, `App.tsx` renders an `OfflineBanner` above the routes when
`navigator.onLine === false` (following the `online`/`offline` events, `role="status"`,
`pointer-events: none` so the header underneath stays clickable) — the stream state answers "is
this screen current?", `navigator.onLine` answers "is there a network at all?", and an operator
needs both.

`src/api/session.ts` holds the access token in memory (never `localStorage`) and fires
`onSessionLost` when a refresh fails.

`toast` is drawn once, by `src/ui/Toast.tsx`, which `App.tsx` renders above the routes — **not by
`Shell.tsx`**. Sign-in, change-password, the loading gate and the failed page all render outside
the shell, and a sentence raised on any of them used to be set in the store and never shown (the
operator saw the button flip back to "Sign in" and nothing else; the 401 was only in the network
tab). A refusal on the two forms does not toast at all: `login` and `changePassword` clear
`authError` on the way in and write the server's sentence (or the unreachable fallback) to it on
the way out, and `pages/Login.tsx` / `pages/ChangePassword.tsx` render it inline (`Alert
tone="c"`), where it stays until the next attempt. `ChangePassword`'s own two checks are local
state shown in the same place. `restore()` stays silent on a 401 — a first-time visitor has no
cookie — and toasts anything else, since the server being down is not "no cookie". `notify`'s
toast stays up for as long as its sentence takes to read (`toastMs`: 3.4 s plus 30 ms a character
past forty, capped at nine seconds) and `dismissToast` puts it away on a click. `Shell.tsx` wraps
the screen in its own `ErrorBoundary`, keyed on the path, so a screen that throws leaves the
sidebar, the search and sign-out usable and resets when the operator leaves it; `main.tsx`'s outer
boundary is the last resort behind the shell itself.

`auth` (`store/index.ts`) has a fifth state, `"failed"`, landed in the Phase 6 fix wave
(`19d486a`): a sign-in or a reload whose `GET /snapshot` call fails (not a 401 —
`onSessionLost` already handles that) renders a full-page retry (`App.tsx`, `auth === "failed"`)
rather than falling back to `"ready"` with a toast saying data is "showing what is in memory" —
there is no memory to fall back to any more, so the old wording described a state that stopped
being true the moment `data/seed.ts` was deleted.

## Master data, derived state, formatting

`src/data/master.ts` exports mutable registries (`IT`, `LOC`, `RCP`, `PL`, `MENU`, `USERS`) —
**empty at import, no fixtures import anywhere in the file** — **replaced in place** by
`hydrateMaster()` when the snapshot lands; screens import them directly, so assign into them,
never reassign them. Three constants — `ALL_LOCS`, `OUTLETS`, `PO_APPROVAL_LIMIT` — are
re-exported from `@rch/contract` here, not five: `PAR_FACTOR` comes from `@rch/domain`
(`selectors.ts`) since it is a rule's own tuning, not a wire shape, and `STAFF_CREDIT_LIMIT` is
not re-exported at all — the till reads the ceiling live off `GET /reports/credit/:kind/:id`
instead of a bundled number. `MasterData` is typed from `@rch/contract`'s types rather than
`typeof FX.*`. The payer roster is the same shape: `PATIENTS`,
`STAFF`, `DEPTS` start empty and `hydrateRoster(r)` (called from `applySnapshot`) splices the
server's `roster` into them in place — the counter's payer picker reads these, never a fixture.
`data/seed.ts` and `data/ops.ts` are **deleted**; `data/vendors.ts` keeps its two helpers but no
longer re-exports `seedVendors`. `grep -rn '@rch/contract/fixtures' src | grep -v __tests__`
finds nothing — the fixtures are the shared seed (§5.1), reachable now only from tests. The
store's own `signIn`/`signOut` are gone too: a test sets the session through
`__tests__/fixture.ts`'s `as(role)` (calls `hydrateMaster`/`hydrateRoster` from the fixtures and
`setState`s the session directly, with a comment saying why it must not be "tidied" onto
`applySnapshot`) and `signedOut()`, never through a store action that used to read the fixtures
from inside the app.

`src/lib/selectors.ts` is the source of truth for everything derived — `qty`, `resv`, `avail`,
`freeToPromise`, `availOf`, `priceOf`, `procurementList`, `prqProgress`, `onOrder`,
`awaitingApproval`, `inTransit`, `parOf`, `costOf`, `poValue` (a one-line delegate to
`@rch/domain`'s `poValue`, kept because three screens and `procurement.test.ts` already import
it from here). Most of it delegates to `@rch/domain` with the local `MASTER`. **Never mirror a
derived value into the store.** The transition predicates (`isReqOpen`, `canIssueTicket`,
`canHandOver`, `canReceiveTicket`, `canDispatch`, `canMoveOrder`, `canCancelTicket`,
`isTicketOpen`, and now `canSendPo`, `canCancelPo`, `canCloseShort`) read the domain tables, so
a button the UI offers is one the server accepts. `canMoveOrder(st, to)` mirrors `setStatus`'s
own two guards either side of `PROD_ORDER_TRANSITIONS` — `Dispatched` refused as a destination
(it has its own button, `canDispatch`) and as a source (that edge exists only for a
cancellation to take). `isTicketOpen` reads `canHandOver || canReceiveTicket` rather than
`st !== "Received"`, so a cancelled ticket does not count as still moving. `canCancelPo(st,
anyReceived)` mirrors `cancel`'s own two guards the same way `canMoveOrder` mirrors
`setStatus`'s — the transition-table answer, refused again once anything has arrived — and
`canCloseShort` is not a table lookup at all: closing short is the only door out of a
part-delivered order, so the predicate is just `st === "Partially received"`.
`buyer/PurchaseOrders.tsx`'s four status comparisons (Drafts / On order / Partially received /
Closed) are list buckets, not controls — they group the table into cards, and every send,
cancel or close-short button on those cards still reads the predicates above, not the bucket it
sits in.

Never hand-format a number: money through `money` / `money0` / `lakh`, quantities through
`fq(v, it)` with `U(it)`, mixed-unit totals through `unitTotal`, wire values through
`fromWireTime` / `fromWireDate` / `fromWireBestBefore` (all in `src/lib/fmt.ts`). The store
keeps every date as the display string `dmy` produces (`"DD-MMM-YYYY"`); `toInputDate` /
`fromInputDate` convert at the one edge that needs ISO, an `<input type="date">` —
`roles/buyer/PoDrawer.tsx` and `roles/store/Contracts.tsx` are the only callers, and both
convert in through `toInputDate` only, sending the input's own ISO value straight through on
the way out — `fromInputDate` has no production caller today.

`src/ui/kit.tsx` holds the typed components — `Card`, `DataTable`, `PageHead`, `Btn`, `BtnRow`,
`Pill`, `StatusPill`, `Tag`, `Switch`, `Alert`, `Section`, `Field`, `FormRow`, `Toolbar`,
`FilterBtn`, `FilterSelect`, `TableFoot`, `Kpis`, `Grid`, `Feed`, `Avatar`, `Otp`,
`TileMenu`, … — use them instead of bespoke markup. `Sparkline` and `KebabIcon` are in the same
file but are **not** exported — `Sparkline` is drawn by `Kpis`, `KebabIcon` by `TileMenu`, and
neither has a caller outside `kit.tsx`. knip's
`ignoreExportsUsedInFile: { interface, type }` (`knip.json`) means an exported value whose only
consumer is its own file is now reported. Export one only when a second file needs it — and then
put it in this list. Styling is plain CSS in `src/styles.css`: one
token set on `:root`, redefined under `@media (prefers-color-scheme: dark)` guarded by
`:root:not([data-theme="light"])`, and again under `[data-theme="dark"]` so an explicit choice
wins both ways. No CSS framework.

## Tests

`src/__tests__/`, jsdom, `TZ=UTC` and a 20 s `testTimeout` (`vite.config.ts` — screen tests render
whole role shells), `setupFiles: setup.ts` which installs a working `localStorage` when the host
does not supply one. Reset through `fixture.ts`: `resetStore()`, `S()` for the state, `as(role)`
to set the session from the fixtures (`hydrateMaster` + `hydrateRoster`, then `setState` — the
store's own `signIn` is gone, so this is the one sanctioned way a test signs somebody in) and
`signedOut()` for the opposite.

- `store.test.ts`, `fixes.test.ts` (regression pins tagged C6, M3, M8, H4, UA-14 — read the
  comment before changing what one covers). `fixes.test.ts`'s three support-desk cases and
  `store.test.ts`'s ledger-arithmetic case are gone, each with a comment naming the server test
  that replaces it (`apps/api/src/modules/support/support.test.ts`,
  `packages/domain/src/support.test.ts`, `apps/api/src/modules/reports/reports.test.ts`) — that
  is the constraint every deletion in this suite follows, not just these two. `procurement.test.ts`
  no longer tests a still-local slice — every rule it used to pin (the approval arithmetic, the
  claim walk, the 2% receipt tolerance, the finance slab) is the server's, tested in
  `apps/api/src/modules/{requisitions,purchaseorders,grn,vendors,contracts,catalog,
  productreqs}/*.test.ts`. What is left is what the browser still derives for itself: the pooled
  `procurementList`, `prqProgress`, and the M3 duplicate-order guard's two halves.
- `writes.test.ts` — the server-backed actions against a **stubbed `fetch`**: `serve({...})`
  keyed by `"METHOD /path"`, `calls()` / `hit()` to assert the body and the read-backs. Success
  refetches the right slices; a refusal toasts the server's sentence and leaves state untouched.
  Render-level cases drive the real `Pos` and `counter/Requests` components. Buying's own cases
  cover `sendRequisition`, the requisition desk's two decisions, `createPo`, the purchase
  order's other doors (line edits, vendor and eta patches, send, cancel, receive, close-short),
  and vendors/contracts/new-product; Phase 6's own cover the support desk's four writes, the
  roster hydrating from `applySnapshot`, `readCredit`, and a stock-ledger read. The rules those
  routes enforce belong to the API's own suites — do not re-assert them here. **135 cases**, and
  one of them is a known flake on a loaded host: `leaves the requisition card and its note alone
  when procurement refuses it` polls (`settleUntil(() => S().toast !== null)`) and has gone red
  once in a full-suite run sharing a machine with the API suite, passing in isolation every time.
  A red on that name alone is timing, not a regression — re-run the file on its own first.
- `events.test.ts` — frame parsing, the 250 ms debounce into `refetch`, `resync` forcing a full
  `loadSnapshot`, and the `live` / `reconnecting` / `off` state the pill reads.
- `refusals.test.tsx` — where a refusal is shown: a refused sign-in and password change inline on
  the form (and not as a toast), the toast drawn on the sign-in screen and once inside the shell,
  its `role="status"`, its length-scaled stay and click-to-dismiss, `restore()` speaking up when
  the server cannot be reached, and a screen that throws caught inside the shell.
- `api.test.ts`, `session.test.ts`, `theme.test.ts`, `screens.test.tsx`, `app.test.tsx`.
