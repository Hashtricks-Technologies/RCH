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

`Seq` (`store/index.ts`) is gone entirely — every document the server numbers is numbered there
instead. There is nothing left to cut over: every mutation in the app is a server call.

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
  `lib/selectors.ts` are previews while the operator types; the refusal is the server's.
- **Form-carrying actions return `Promise<boolean>`** and the screen `await`s them behind a
  `busy` flag, clearing the form only on `true` — so a refusal leaves what was typed on screen.
  `roles/counter/Pos.tsx` (single `busy`) and `roles/counter/Requests.tsx` (a keyed
  `busy: string | null`, one per row) are the two patterns; copy one of them. `makeProduct` and
  `cancelTicket` are this pattern's newest members — a batch form and a cancel-reason form each
  reset only once the server has taken them. Buying adds a whole slice of them:
  `sendRequisition`, `approveRequisition`, `declineRequisition`, `updatePoLine`, `setPoEta`,
  `sendPo`, `cancelPo`, `receivePo`, `closePoShort`, `addVendor`, `updateVendor`,
  `requestNewProduct`, `answerProductRequest`, `addContract`, `updateContract`.
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
manifest, mints an `Idempotency-Key` for a write (**once per call**, so the post-refresh retry is
the same write), and on a 401 refreshes once and retries. `ApiError` carries `code`, `status`,
`message`, `details`. There are no hand-written fetch wrappers — add a manifest entry instead.

`src/api/refetch.ts` pulls back exactly what a write said it changed. `stock`, `rsv` and `ovr`
come from `GET /stock`; `NARROW` maps `bills → GET /bills`, `req → GET /requests`,
`tkt → GET /tickets`, `shopAsks → GET /shop-asks`, `pord → GET /prod-orders`,
`batch → GET /batches`, buying's six — `prq → GET /requisitions`, `po → GET /purchase-orders`,
`grn → GET /grns`, `vendors → GET /vendors`, `contracts → GET /contracts`,
`productReqs → GET /product-requests` — `items → GET /items`, and now
`tickets → GET /support/tickets` (`applySupportTickets`) for the support desk's own `changed`.
`prices` and `menu` (the manager's writes) are the only two collections left without a narrow
reader, so they still cost one `loadSnapshot`, and a mixed `changed` set takes the snapshot
alone. If the read-back fails the write's own sentence is kept and qualified, never replaced:
the operator must not be sent round to do it twice. `src/api/wire.ts` holds the server-shape →
store-shape mappers (`applySnapshot`, `applyStock`, `applyBills`, `applyRequests`,
`applyTickets`, `applyShopAsks`, `applyProdOrders`, `applyBatches`, `applyRequisitions`,
`applyPos`, `applyGrns`, `applyVendors`, `applyContracts`, `applyProductRequests`, `applyItems`,
`applySupportTickets`, `hydrateRoster`); ISO times become `"HH:MM"` there and nowhere else, and
every ticket's `hist` passes through the file's shared `hist()` mapper in both `applySnapshot`
and `applyTickets`, so a raw ISO instant never reaches a ticket drawer's trail whichever path
refetched it. `applySnapshot` and `applyItems` both bump `catalogVersion`, the signal the
catalogue's own screens read since it is a module-level registry (`data/master.ts`) and not
store state — an SSE `resync` no longer leaves a new item invisible until reload, which Phase 5
left as a known gap and Phase 6 closed.

`src/api/events.ts` keeps every tab current: one `fetch`-based SSE connection (not `EventSource`,
which cannot send an `Authorization` header), frames parsed by hand, notices debounced
`EVENT_DEBOUNCE_MS` (250 ms) per collection into **one** `refetch`, a `resync` frame superseding
the lot with a full `loadSnapshot`, a 1 s → 30 s backoff ladder that honours the server's `retry:`
hint first, and the same refresh-once-then-sign-out path as `call`. It follows `state.auth` rather
than hooking `login()`, so `restore()` and `changePassword()` are covered too. `main.tsx` calls
`startEventStream()` once, before `restore()`. `useStreamState()` feeds the shell's pill, which
shows **only** `Reconnecting` — a badge that is always there stops being read.

`src/api/session.ts` holds the access token in memory (never `localStorage`) and fires
`onSessionLost` when a refresh fails.

`auth` (`store/index.ts`) gains a fifth state, `"failed"`, in the Phase 6 fix wave: a sign-in
or a reload whose `GET /snapshot` call fails (not a 401 — `onSessionLost` already handles that)
renders a full-page retry rather than falling back to `"ready"` with a toast saying data is
"showing what is in memory" — there is no memory to fall back to any more, so the old wording
described a state that stopped being true the moment `data/seed.ts` was deleted. (Lands in the
Phase 6 fix wave.)

## Master data, derived state, formatting

`src/data/master.ts` exports mutable registries (`IT`, `LOC`, `RCP`, `PL`, `MENU`, `USERS`) —
**empty at import, no fixtures import anywhere in the file** — **replaced in place** by
`hydrateMaster()` when the snapshot lands; screens import them directly, so assign into them,
never reassign them. `ALL_LOCS`, `OUTLETS`, `PAR_FACTOR`, `STAFF_CREDIT_LIMIT` and
`PO_APPROVAL_LIMIT` are re-exported from `@rch/contract` here, and `MasterData` is typed from
`@rch/contract`'s types rather than `typeof FX.*`. The payer roster is the same shape: `PATIENTS`,
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
`FilterBtn`, `FilterSelect`, `TableFoot`, `Kpis`, `Sparkline`, `Grid`, `Feed`, `Avatar`, `Otp`,
`TileMenu`, … — use them instead of bespoke markup. Styling is plain CSS in `src/styles.css`: one
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
  routes enforce belong to the API's own suites — do not re-assert them here.
- `events.test.ts` — frame parsing, the 250 ms debounce into `refetch`, `resync` forcing a full
  `loadSnapshot`, and the `live` / `reconnecting` / `off` state the pill reads.
- `api.test.ts`, `session.test.ts`, `theme.test.ts`, `screens.test.tsx`, `app.test.tsx`.
