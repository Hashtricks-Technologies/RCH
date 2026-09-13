# UI — CLAUDE.md

Repo-wide rules, the movement rule and the domain invariants are in the root `../CLAUDE.md`;
`UI/README.md` describes the app for a reader rather than an agent. This is what is specific to
`@rch/ui`.

## What this is

React 19 + Vite 8 + TypeScript (strict, `verbatimModuleSyntax`, `erasableSyntaxOnly`) + Zustand 5.
Routing is `BrowserRouter` with **one** route, `/:key` — plain paths, not `#/key`; every host this
app actually runs behind already falls an unmatched path back to `index.html` (Vite's dev proxy,
Caddy on the single-EC2 box, the EKS ingress), so the SPA-rewrite problem a hash router dodges
does not arise here. The store is an API client end to end: it signs in for real, hydrates from `GET
/snapshot`, and posts every write. `UI/src/data/seed.ts` and `UI/src/data/ops.ts` are gone — no
production file under `UI/src` imports `@rch/contract/fixtures` any more, only the tests do.
Only the theme and a couple of UI prefs reach `localStorage`.

## Commands

```bash
pnpm --filter @rch/ui dev         # vite on :5173, proxying /api -> http://localhost:3000
pnpm --filter @rch/ui test        # vitest run --coverage (jsdom); the floors below are part of it
pnpm --filter @rch/ui typecheck   # tsc --noEmit -p tsconfig.app.json
pnpm --filter @rch/ui lint        # oxlint --max-warnings 0
pnpm --filter @rch/ui build       # tsc -b && vite build -> UI/dist
```

`npx vitest run src/__tests__/writes.test.ts` from inside `UI/` runs one file — **without** the
coverage gate, deliberately: `--coverage` is on the `test` script rather than `enabled` in
`vite.config.ts`, so a whole suite's threshold is never measured against one file.

**Lint is a zero-warning gate, in this package and in every other.** Each one's `lint` script is
`oxlint --max-warnings 0`, so a warning fails the build the same way an error does — there is no
"warnings are fine" tier to accumulate in. `UI/.oxlintrc.json` names its plugins explicitly
(`react`, `typescript`, `unicorn`, `oxc`) so a version bump cannot quietly add or drop one under
that gate, and it makes exactly four decisions:

- **`react/rules-of-hooks`: error.** A conditional hook is a component that will misbehave, not a
  style.
- **`react/exhaustive-deps`: error.** A dependency array that lies is a screen that stops
  updating. The honest exceptions are fixed by narrowing the *value* passed in — the kitchen
  dashboard's memo, the Shell's palette — never by shortening the array.
- **`react/jsx-key`: off for `src/**`,** with the argument written out in the file: all 252
  findings were `DataTable`'s `cells: ReactNode[]`, a positional fixed-length row the table keys
  itself, and keeping the rule on would bury its one real finding under 252 meaningless ones.
- **`react/only-export-components`: off,** because twenty-one of its findings are drawer modules,
  which export nothing and reach the app through `registerDrawer` and a side-effect import — the
  architecture — and the other six export one constant or one pure function *for the suite*.

**Coverage floors are enforced by `vitest run`, per package**, set a point or two under what each
suite measures today so that deleting a test or shipping an untested screen fails rather than
drifting: UI **lines 73 / branches 51**, `apps/api` **94 / 79**, `packages/domain` **99 / 92**,
`packages/contract` **lines 96** (no branch floor — the package holds two branch points and
neither is exercised, so any figure there is unmeetable or meaningless). Raise one when the real
figure rises; never lower one to make a red run green. `turbo.json` marks `test` **uncached** —
turbo hashes source files, not the database the API suite runs against, so a cache hit would
replay a green from before a migration.

## Three files must agree for a screen to exist

1. `src/nav.ts` — `NAV[role]` is the sidebar (groups → `{ k, label, icon }`), `HOME[role]` the
   landing key, `canSee(role, key)` the guard.
2. `src/roles/<role>/index.tsx` — exports `screens: Record<string, ComponentType>` keyed by the
   same route key, and imports its drawer modules for their side effects.
3. `src/App.tsx` — `REGISTRY[user.r][key]`. A key the role cannot see renders `<Denied>`, which
   **toasts why** and redirects home (UA-01); an unknown key renders a "Coming up" placeholder.
   `settings` and `issues` are handled ahead of the registry — and, ahead of even those, an
   admin-flagged account (`user.admin`, a capability, not a role — root CLAUDE.md) is diverted
   entirely: `Page()`'s own top-level route skips `<Shell>` for it, `Screen()` renders
   `AdminDashboard` for the `admin` key and bounces every other key straight back to it with a
   toast (`BackToAdmin`, not `<Denied>` — there is no operational role to describe such an
   account by, so it says so in its own words and never reads `HOME[user.r]`). `home` in `Page()`
   is `"admin"` for such an account, never `HOME[user.r]`. `AdminDashboard.tsx` supplies its own
   full-page chrome (a two-line header, sign-out) rather than being hosted inside `Shell` — there
   is no sidebar to hide, and `Settings` carries no link to it any more (an admin-flagged account
   never reaches `Settings` in the first place).

`src/__tests__/screens.test.tsx` and `app.test.tsx` iterate `NAV` × `USERS` and assert every
advertised key renders, bare and in-shell. A nav entry without a component fails the suite; that
coupling is deliberate.

Drawers are a bare registry (`src/drawers.ts`): a module calls `registerDrawer("key", C)` at the
bottom of its file, the role's `index.tsx` imports it for the side effect, `openDrawer(t, id)`
opens it, and `ui/Drawer.tsx` + `DrawerFrame` supply the chrome. `"sitem"`
(`roles/store/NewProductDrawer.tsx`) is the store keeper's own Add Product drawer, registered in
Phase 5 — its button had opened nothing since the procurement rework; `"bnewitem"`
(`roles/buyer/NewProductDrawer.tsx`) is the buyer's, answering a shop's product request.

**`ui/Drawer.tsx` makes `role="dialog" aria-modal="true"` true rather than merely declared**, and
there are four pieces to it — the keyboard goes in on open (to the drawer's own title, which is
`tabIndex={-1}` so Tab still lands on the first real control), **Tab and Shift+Tab wrap** at both
ends of the panel, focus is **restored** to whatever opened the drawer on close (only if that
element is still on the page), and two guards keep the keyboard inside while it is open. The
guards are different mechanisms because the two ways out are different events: a `focusin`
listener on `document` catches the keyboard being **moved** out, and a `MutationObserver` on the
panel catches it being **dropped** — a focused control that unmounts (`store/TicketDrawer.tsx`'s
supervisor override replacing itself) or that merely becomes `disabled` (every busy button in the
app, and the one the operator just pressed is by definition the one holding the keyboard). Both
drop focus to `<body>` firing **no** focus event at all, which is why a listener alone cannot see
them; the observer therefore watches `childList` **and** `attributes` filtered to `disabled`.

**One behaviour change follows from the `focusin` guard and is worth knowing:** ⌘K / Ctrl-K, the
Shell's search shortcut, focuses the palette's input — and while a drawer is open the guard pulls
the keyboard straight back into the panel. The shortcut is not disabled and the palette does
open; the caret just does not stay in it. That is what `aria-modal="true"` promises, so it is
correct, but it is a change from before the trap existed: close the drawer first.

**A drawer whose derived state must re-derive keys on the trail, never on the document's own
`at`/`iso`.** `manager/ApprovalDrawer.tsx` is the worked example and the only one so far: one
long-lived component instance is re-pointed at a second request by `openDrawer("mreq", other)`
without unmounting, so everything it derives in a `useState` initialiser — the per-line
quantities, the struck-out lines, the reason boxes — would otherwise be the *previous* request's.
The key is `` `${req.id}:${req.hist.at(-1)?.iso ?? req.iso}` `` (`bodyKey`, exported for the
suite). `req.id` covers being pointed elsewhere; the **trail's last entry** covers the same
request coming back changed underneath, from an SSE refetch after somebody else decided it.
`req.iso` alone will not do and was the bug: it is the instant the counter *raised* the request,
which never changes for as long as the document exists, so keying on it was keying on `req.id`
twice. It stays only as the fallback for a document whose trail has not been read.

**The audit wave added three sidebar keys and four drawers**, and two of the drawers break the
one-role-owns-one-drawer habit on purpose. Keys: `manager/bills` (every outlet's bills, seven
days, with the Void button on one still dated today), `manager/roster` (the payer register,
closed accounts included) and `store/adjust` (the write-off register and its form). Drawers:
`"item"` (`roles/manager/ItemDrawer.tsx`) is the first drawer **four** role indexes import — the
manager's, the store's, the buyer's and the kitchen's — and it disables its own boxes off
`@rch/domain`'s `mayEditItemField` rather than off a second list, sending only the fields the
caller owns *and* actually moved so "Nothing to change" stays reachable; `"adjstock"` is
registered in `ui/AdjustmentForm.tsx` rather than in a role screen, because the manager and the
kitchen both open it and registering it twice would be two copies of one key; `"cbill"`
(`roles/counter/BillDrawer.tsx`) is now imported by two role indexes, the counter's and the
manager's, since the manager voids from the same drawer the counter reads; and `"korder"` /
`"cpord"` are the manager's kitchen-order drawer and the counter's read-only view of an order it
raised — deliberately **not** the kitchen's own `"pord"`, which is built around Accept / Start /
Dispatch and reads kitchen shelves a counter is not sent. The counter's way in is a card on the
existing `requests` screen, not a key, so nothing in `nav.ts` moved for it.

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
`rateTicket`) — the last in-memory path, closed. **The audit fix wave added six more, and they
are the only writes since Phase 6**: `voidBill` and `raiseProdOrder` (in `store/index.ts`), and
`updateItem`, `addPayer`, `updatePayer` and `createAdjustment` (in `store/ops.ts`) — fifty-three
actions in all, every one of them a call. Three reads join them, not writes:
`readStockLedger(loc, days)` and `readCredit(payer)` (both `store/index.ts`), each a plain `GET`
with no `notify`/`refetch` of its own — `roles/store/Reports.tsx`'s ledger screen and
`roles/counter/Pos.tsx`'s credit panel are the two screens that call them instead of deriving a
number the browser no longer holds — and `loadPayers` (`store/ops.ts`), which the manager's
Payers screen calls on mount because nothing on the snapshot carries a closed account. It calls
`applyPayers` **directly** rather than going through `refetch`, whose failure sentence ("Saved —
but the screen could not be refreshed") is about a write that already landed; its own is
`Could not read the payer register — check the connection and try again.` The kitchen's screens keep only previews now: `ceiling` and the
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
  one of the fifty-three now answers whether the server took the write, so no action in the store
  is `Promise<void>` where a caller might want to know — **and their screens have caught up**:
  `counter/Pos.tsx` clears the payer, the tender and the price edits only on `true`, and
  `manager/Prices.tsx` keeps a per-row `busy` map (`save:<it>`, `drop:<it>`, `add`) and drops the
  edit only when the save answered `ok`. `manager/ItemsStock.tsx`'s "list an existing product"
  picker is the same shape. A refused write now leaves what was typed on screen everywhere, which
  is the rule this bullet has always stated.
  All six of the audit wave's own writes are this pattern too — `voidBill` (the reason survives a
  refusal and the drawer closes only on success), `raiseProdOrder`, `updateItem`,
  `createAdjustment`, `addPayer` and `updatePayer`.
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
`menu → GET /menus` (`applyMenus`), the manager's two, plus the wave's own three:
`roster → GET /roster` (`applyRoster`, which is `hydrateRoster` and a `catalogVersion` bump, for
the same reason `applyItems` bumps it — the roster is a module-level registry, not store state),
`payers → GET /payers` (`applyPayers`, ordinary store state under `store/ops.ts`'s `payers`
field, because only one screen reads it) and `adjustments → GET /adjustments`
(`applyAdjustments`). A payer write names **both** `roster` and `payers`, which is why the reader
map is keyed per collection and each entry fetched at most once: two collections, two GETs, never
a snapshot.

**Every collection in `CollectionSchema` now has a narrow reader, so a valid `changed` set never
costs a snapshot.** That is the point of the pair: `loadSnapshot` pulls the whole hospital back
down, and until this wave it also put every screen behind the loading splash to do it, so a
one-field price edit blanked the till. The `if (… !NARROW[c] …) loadSnapshot()` fallback stays in
the file as the guard for the **next** collection added to the enum and not to `NARROW` — that is
what it is now for, and the three tests that cover it drive it with a cast
(`"a-collection-with-no-reader" as Changed`) because no real member reaches it. A mixed set still
takes the snapshot alone. If the read-back fails the write's own sentence is kept and qualified, never replaced:
the operator must not be sent round to do it twice. `src/api/wire.ts` holds the server-shape →
store-shape mappers (`applySnapshot`, `applyStock`, `applyBills`, `applyRequests`,
`applyTickets`, `applyShopAsks`, `applyProdOrders`, `applyBatches`, `applyRequisitions`,
`applyPos`, `applyGrns`, `applyVendors`, `applyContracts`, `applyProductRequests`, `applyItems`,
`applySupportTickets`, `hydrateRoster`, and the audit wave's `applyRoster`, `applyPayers` and
`applyAdjustments`); ISO times become `"HH:MM"` there and nowhere else — **and
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
state shown in the same place. **`pages/Settings.tsx`'s password card is the third form on that
field**, and it keeps a local `tried` flag: `authError` is one store field written by `login` as
well as by `changePassword`, and cleared only on the *next* attempt at either, so without the flag
a sign-in refused earlier in the shift was still sitting there when Settings opened and accused
the operator of a refusal they had not made. The card stays silent until it has been submitted
once; leaving the screen resets it. Neither `login` nor `changePassword` was changed for it. `restore()` stays silent on a 401 — a first-time visitor has no
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
never reassign them. **`IT` now holds the whole master, retired lines included** — `readItems` on
the server stopped filtering `active` so that a bill or a purchase order raised months ago still
has a product name to print — so a picker reads `activeItems()`, never `Object.keys(IT)`. The
screens swept for it are the manager's menu picker, the counter's and kitchen's request pickers,
the store's requisition and contract pickers, and the buyer's dashboard (whose below-reorder KPI
was otherwise sending a buyer out to order something the hospital had stopped carrying). Two were
deliberately left: `ui/Shell.tsx`'s global search (finding a retired item by name is arguably
right) and `roles/manager/Availability.tsx` (already constrained to menu listings, which a
retired item cannot be on). `roles/store/Stock.tsx` is the third case and the interesting one —
it keeps a retired line **when the shelf still holds it**, greyed, with a `Retired` tag and no
"Add to requisition", because that stock is exactly the work the retirement is waiting on and
hiding it would hide the work. `madeItems()` is the same shape one rule up: the kitchen's
makeable list is `Object.keys(RCP).filter((k) => IT[k]?.t === "FG")`, read through a `useMemo`
keyed on `catalogVersion`, in place of the three hard-coded item keys it used to be.
`onOrderIndex(s)` / `inTransitIndex(s)` are the whole-store versions of `onOrder` / `inTransit`,
for a screen that would otherwise call the per-item function once per row; they accumulate in the
same order and with the same rounding, so the index equals the function exactly rather than to
three decimals. Three constants — `ALL_LOCS`, `OUTLETS`, `PO_APPROVAL_LIMIT` — are
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
`awaitingApproval`, `inTransit`, `parOf`, `costOf`, `madeItems`, `activeItems`, `isRetired`,
`onOrderIndex`, `inTransitIndex`, `poValue` (a one-line delegate to
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

**One field breaks that rule on purpose, and it is the second shape a date can take here.** A
production order's `need` stays in **wire** form (`"2026-09-11"`) all the way into the store,
while `po.eta` is converted to `dmy`'s display string at the `api/wire.ts` boundary. Both render
through `dmy` at the point of use, so the two read identically on screen — but they are not
stored alike. The reason `need` was left alone: its only editor is an `<input type="date">`,
which speaks ISO in both directions, so converting on the way in would mean converting straight
back out through `toInputDate` for every edit — the round trip `PoDrawer`'s `EtaInput` exists to
manage. If the two are ever normalised, the cheaper direction is to stop converting `eta`, which
no longer has a reason to differ.

`fromWireDay(iso)` (`lib/fmt.ts`) is the third of the `fromWire*` family and the one to reach for
when an **instant** must print as a day. `fromWireDate` is `dmy`, which only matches
`^\d{4}-\d{2}-\d{2}$` — a full ISO instant falls straight through its `?:` unchanged, which is
how the one piece of paper a customer takes away came to read `2026-09-11T03:42:00.000Z`. Reading
the host's day instead would have been the other half of the same defect: 18:30 UTC is already
tomorrow in Asia/Kolkata, so every bill on the evening shift would have printed yesterday's date
beside this morning's time. `fromWireDay` is `dmy(istDate(new Date(iso)))` for an instant and
`dmy(s)` for anything already in date or display form, so it is as re-entrant as its two
siblings, and the slip's day and the till's "today" cannot disagree.

`src/ui/kit.tsx` holds the typed components — `Card`, `DataTable`, `PageHead`, `Btn`, `BtnRow`,
`Pill`, `StatusPill`, `Tag`, `Switch`, `Alert`, `Section`, `Field`, `FormRow`, `Toolbar`,
`FilterBtn`, `FilterSelect`, `TableFoot`, `Kpis`, `Grid`, `Feed`, `Avatar`, `Otp`,
`TileMenu`, `DraftLineInput`, `EtaInput`, `useLineKeys`, … — use them instead of bespoke markup.
`DraftLineInput` and `EtaInput` moved up from `roles/buyer/PoDrawer.tsx` in the audit wave:
`DraftLineInput` is the commit-on-blur number box every editable quantity now uses (a controlled
`Number(e.target.value)` reads a half-typed `12.` as `0` and forces a `"0"` back into the field
mid-number, which is how a decimal quantity used to be impossible to type), and `EtaInput` is its
date sibling. Anything that takes a typed quantity reaches for `DraftLineInput` rather than
rolling a third buffer; the final audit pass swept the last six raw boxes onto it and gave it
optional `id`, `max` and `invalid` passthroughs so nothing was lost in the move. **`ariaLabel` is
required on it even where a `<label>` sits beside it**, and the reason is `Field`'s one limit:
`Field` wires `htmlFor` only to a **direct DOM child** it recognises (`LABELABLE`), so a
component child — `DraftLineInput` among them — leaves the visible label decorative and the box
with no accessible name at all unless it carries its own. `useLineKeys(n)` is the third of that
family: one stable key per line for the three screens that draw an editable line table
(`store/Requisitions.tsx`, `prod/Requests.tsx`, `ui/KitchenOrderForm.tsx`), each of which kept
its own ref ledger and its own `react/refs` suppression until it existed. Call its `drop(i)`
beside the state update that removes a line — the hook only trims from the end, so without it a
Remove on row 0 is the `key={i}` defect it exists to prevent, arrived at the long way round.
`Alert` carries an ARIA role now — `role="alert"` for `tone="c"`, because
a refusal has to interrupt, and `role="status"` for every other tone. **`Sparkline` is gone**, and
so are `Kpi.spark` and `Kpi.color`: the sparkline was drawn by nothing — not one `Kpi` in the app
ever set the field — and an optional field no caller fills is a shape future callers copy without
meaning to. `Kpi` is `{ l, v, d? }` and nothing else. `TableFoot` no longer renders a pager
either: it prints `Showing <n> of <n>` and an optional `extra`, because there is no pagination in
this app and a control that paged nothing was a promise the screens could not keep. `KebabIcon`
is in the file and **not** exported — it is drawn by `TileMenu` and has no caller outside
`kit.tsx`. knip's
`ignoreExportsUsedInFile: { interface, type }` (`knip.json`) means an exported value whose only
consumer is its own file is now reported. Export one only when a second file needs it — and then
put it in this list. Styling is plain CSS in `src/styles.css`: one
token set on `:root`, redefined under `@media (prefers-color-scheme: dark)` guarded by
`:root:not([data-theme="light"])`, and again under `[data-theme="dark"]` so an explicit choice
wins both ways. No CSS framework.

**Four components under `src/ui/` are not kit components**, and each is there because two or more
role folders need it and this repo has no cross-role component import: `TicketSlip.tsx`
(`TicketSlip` + `PrintSlipBtn`, used by the store's and the kitchen's ticket drawers and the
store's issue detail — it prints the OTP only when `t.otp` is non-empty and says whose code it is
otherwise, and says so in words when a ticket carries no line at all, because paper with an empty
table on it reads as a printing fault), `NewProductForm.tsx` (one form with a `scope` prop —
`store` / `buyer` / `kitchen` — carrying the field set, the unit list, the offered types and the
location an opening balance books at, so the three Add Product drawers are ~30-line wrappers over
one validator), `AdjustmentForm.tsx` (the write-off form plus the `"adjstock"` drawer, and the
one file in the app that imports `avail` from `@rch/domain` **directly** rather than through
`lib/selectors` — the selector narrows its location to `LocKey`, which excludes the
rejected-goods shelf, and that shelf is precisely the one this form exists to correct; it takes
`REASON_LABEL` from `@rch/domain` for the same one-wording reason) and `KitchenOrderForm.tsx`
(the outlet's ask of the kitchen, shared by the counter's card and the manager's drawer, offering
`t === "FG"` only).

**Printing is three class names and one `@media print` block** at the end of `styles.css`:
`.print-slip` is the only thing visible on paper (and is hidden on screen by a rule *outside* the
media block, since "hidden on screen" is not expressible inside it), `.no-print` is hidden on
paper, and `.print-only` is the converse of `.print-slip`. The block also neutralises `.drawer`'s
`position: fixed` and `.drb`'s `overflow` — a slip lives inside a fixed 720px scrolling panel, so
without that the paper carries only whatever happened to be scrolled into view. `Reprint` and
`Pay` both end at `window.print()` now; the POS button reads `Pay · ₹<total>`, because printing
moved into the bill drawer the sale opens on success and "& print" on the button was a sentence
about something that never happened.

## Tests

`src/__tests__/`, jsdom, `TZ=UTC` and a 20 s `testTimeout` (`vite.config.ts` — screen tests render
whole role shells), `setupFiles: setup.ts` which installs a working `localStorage` when the host
does not supply one. Reset through `fixture.ts`: `resetStore()` (which resets `payers: []` too — the register is ordinary store
state and leaked between cases before it did), `S()` for the state, `as(role)`
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
  routes enforce belong to the API's own suites — do not re-assert them here. The audit wave's own
  six writes are covered the same way — `voidBill` (including the percent-encoded `CF%2F1188` and
  the `iso` kept beside the `"HH:MM"`), `raiseProdOrder`, `updateItem`, `addPayer`, `updatePayer`
  (whose case stubs the roster and the register **differently**, so the difference between the two
  reads is what the test proves), `createAdjustment` — plus `loadPayers`. Account management's six
  — `loadAccounts`, `loadAdminActions`, `createAccount`, `resetAccountPassword`,
  `setAccountActive` (one action, both directions), `updateAccountRoleLoc` — cover the same shape,
  plus the one-time password each of the first two hands back and never stores. **167 cases.**
  There is no known flake in this file any more, and the one there used to be is worth knowing
  about because of what caused it. `leaves the requisition card and its note alone when
  procurement refuses it` polls on `S().toast !== null`; `notify` used to leave the *previous*
  toast's timer running and have it clear by comparing the **message**, so where two cases refuse
  in the same words — as two in this file do — the first toast's stale timer matched the second
  toast's sentence and took it down partway through, and on a loaded host the poll then ran out.
  `notify` cancels the timer it replaces now (`store/index.ts`), and `refusals.test.tsx`'s
  `gives a repeated sentence its own full stay, not the remains of the last one` pins it. That is
  a real defect fixed, not a test slowed down: the operator saw the same thing, a sentence that
  vanished early because the one before it took it away. Do not re-add a "known flake" note here
  without a reproduction.
- `events.test.ts` — frame parsing, the 250 ms debounce into `refetch`, `resync` forcing a full
  `loadSnapshot`, and the `live` / `reconnecting` / `off` state the pill reads.
- `refusals.test.tsx` — where a refusal is shown: a refused sign-in and password change inline on
  the form (and not as a toast), the toast drawn on the sign-in screen and once inside the shell,
  its `role="status"`, its length-scaled stay and click-to-dismiss, `restore()` speaking up when
  the server cannot be reached, and a screen that throws caught inside the shell.
- `screens.test.tsx` — **147 cases**: the `NAV × USERS` loop, a row per **registered** drawer key,
  and the render-level cases the audit wave added (a refused pay keeping the payer, a refused
  price save keeping the typed value, what actually reaches the printer, the approval drawer's
  decimal quantity and its single Approve/Reject pair, a voided bill badged and out of every
  figure that counts money, a retired product no longer generating work for the buyer or the
  store). The drawer loop iterates `Object.keys(DRAWERS)` against an `OPEN_OVER` map of
  `key → [id, role]`, so a drawer registered with no row there fails the suite by name — the
  hand-written list it replaced had drifted eight keys behind the registry. Its own last four:
  the account-management page itself, rendering its table and form for a flagged account and
  handing back a one-time password once. `app.test.tsx` covers the routing half — `/admin`
  refused by name for an ordinary account, and an admin-flagged account seeing no Shell at all
  and bounced back to `/admin` from any other key.
- `drawer.test.tsx` — **11 cases**, the whole of `aria-modal="true"` being true: a name on the
  dialog, the keyboard going in on open, Tab and Shift+Tab wrapping at both ends, the `focusin`
  guard catching the keyboard being *moved* out, the `MutationObserver` catching it being
  *dropped* — a focused control that unmounts, and one that merely becomes `disabled` — and the
  keyboard going back to whatever opened the drawer on close.
- `audit-screens.test.tsx` — the store, kitchen and buyer screens the audit wave rebuilt, each
  case watched red against the screen it replaced first.
- `time.test.tsx` — everywhere a date or an instant is read: the two dashboards sorting on `iso`,
  a fortnight-old purchase order received this morning sorting on its trail's last entry, the
  bill slip printing the hospital's own day across an IST midnight, and the kitchen's "made
  today" figures cutting the batch log to the hospital's day (the suite runs at `TZ=UTC`, so a
  host-day implementation goes red on every one of them).
- `api.test.ts`, `session.test.ts`, `theme.test.ts`, `app.test.tsx`. **Fourteen files, 536
  passing and one todo** at the time of writing.
