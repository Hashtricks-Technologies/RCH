# UI - CLAUDE.md

Repo-wide rules and the domain invariants are in the root `CLAUDE.md`. `UI/README.md` describes the app for a
human reader. This file covers what is specific to `@rch/ui`.

## Commands

```bash
pnpm --filter @rch/ui dev         # vite on :5173, proxying /api/v1/admin/audit → http://localhost:3100 and the rest of /api → http://localhost:3000
pnpm --filter @rch/ui test        # vitest run --coverage (jsdom); floor lines 79 / branches 60
pnpm --filter @rch/ui exec vitest run src/__tests__/writes.test.ts   # one file, no coverage gate
pnpm --filter @rch/ui typecheck   # tsc --noEmit -p tsconfig.app.json
pnpm --filter @rch/ui build       # tsc -b && vite build → UI/dist
```

`UI/.oxlintrc.json` decides four rules:

- `react/rules-of-hooks` and `react/exhaustive-deps` are **errors**. When an effect genuinely shouldn't re-run
  on something, fix it by narrowing the value you pass in, never by shortening the dependency array.
- `react/jsx-key` is **off** for `src/**`. Every finding was `DataTable`'s positional cell arrays.
- `react/only-export-components` is **off**. Drawer modules export nothing by design.

## Screens: three files must agree

1. `src/nav.ts`: `NAV[role]` is the sidebar, `HOME[role]` the landing key, and `canSee(role, key)` the guard.
2. `src/roles/<role>/index.tsx` exports `screens: Record<key, Component>` and imports its drawer modules for
   their side effects.
3. `src/App.tsx` resolves the one route, `/:key`, to `REGISTRY[user.r][key]`. A key the role can't see
   redirects home **with a toast saying why**.

Routing is `BrowserRouter`, with plain paths (`/pos`, `/admin`). An admin-flagged account never gets a
`<Shell>`: it only ever sees `pages/AdminDashboard.tsx` at `/admin`, and any other key bounces it back there.
That page has five tabs: `AdminUsers` (staff accounts), `AdminOutlets` (the hospital's retail outlets - opened,
edited, closed and reopened; never deleted), `AdminPayers` (the payer register: who a bill may be posted to -
added, renamed and switched off, never deleted, so a balance always keeps an id somebody can find),
`AdminSupport` (the support desk: every role's tickets) and
`AdminAudit` (the audit log: every write and sign-in, newest first, with filters, counts and a CSV export).
With no `Shell` around it, `AdminDashboard.tsx` mounts the `<Drawer />` host itself.

`screens.test.tsx` and `app.test.tsx` render every `NAV` key for every role. A nav entry with no component fails
the suite, on purpose.

The manager's own group beyond the outlets is **Credit** (`credit`, `roles/manager/Credit.tsx`): three tabs -
who owes what, the rate card (a discount and a credit limit per category, with per-person exceptions) and the
settlement history. Its statement drawer is `stmt`.

**Drawers are a bare registry** in `src/drawers.ts`:

- A module calls `registerDrawer("key", C)` at the bottom of its file.
- `openDrawer(t, id)` opens it.
- `ui/Drawer.tsx` and `DrawerFrame` supply the chrome and a real focus trap (`aria-modal`).
- `screens.test.tsx`'s `OPEN_OVER` map needs a `key → [id, role]` row for every registered drawer, or the
  suite fails by name.
- `pages/AuditEntryDrawer.tsx` registers `auditEntry`, opened with `openDrawer("auditEntry", String(id))`. It
  reads its entry through `readAuditEntry` as it opens, because an audit entry is never kept in the store.
- A drawer that derives state in `useState` and gets re-pointed without unmounting must key its body on the
  document's id **and the last entry of its trail**. `manager/ApprovalDrawer.tsx`'s `bodyKey` is the example.

Components shared by two or more roles live in `src/ui/`, because role folders don't import each other. That
includes `TicketSlip`, `NewProductForm`, `AdjustmentForm`, `KitchenOrderForm` and `PhotoPicker`.

## The store is an API client

`src/store/index.ts` holds the state and most actions. The other slices (`procurement.ts`, `ops.ts`,
`admin.ts`, `audit.ts`) are merged into the same `create()` and share one `AppState`. Components subscribe
narrowly, for example `useApp((s) => s.req)`.

Every write action has this shape:

```ts
try {
  const r = await call(routes.<name>, { params, body });   // src/api/client.ts
  // clear client-only state (a cart, a draft) only now that the server has taken it
  get().notify(r.message);                                  // the server's own sentence
  await refetch(r.changed, r.message);                      // src/api/refetch.ts
  return true;
} catch (e) {
  get().notify(e instanceof ApiError ? e.message : "Could not … - check the connection and try again.");
  return false;
}
```

- **Never invent a success message.** The fallback string is only for a network failure, when there is no
  envelope to read.
- **Form-carrying actions return `Promise<boolean>`.** The screen awaits the action behind a `busy` flag and
  clears the form only on `true`, so a refusal leaves what was typed. `counter/Pos.tsx` (a single `busy`) and
  `counter/Requests.tsx` (keyed per row) are the two patterns to copy.
- **Actions whose screen needs the new id return `Promise<string | null>`**: `createPo` and `createItem`.
- **Single-press buttons with no form are fire-and-forget**: `handover`, `setOrderStatus`, `dispatchOrder`.
- **`setItemImage(it, bytes)` and `removeItemImage(it)`** are the ordinary `Promise<boolean>` write shape
  above - the bytes arrive already shrunk and type-checked (`ui/PhotoPicker.tsx`, below), and the server checks
  them again and decides, including whether a counter's outlet lists the item.
- **Some reads have no notify and no refetch**: `readStockLedger`, `readCredit` and
  `loadSignInDirectory` (the sign-in picker's staff list). They return `null` on failure, never an empty list,
  so a screen can tell an outage from genuinely nothing. `Login.tsx` falls back to a typed id on `null`.
- **Account writes (`store/admin.ts`)**: `createAccount` sends no employee number (the server assigns it) and
  returns `{ emp, password } | null`, the number actually given; `AdminUsers.tsx` previews it with
  `nextEmpNo`. `deleteAccount(id)` is the ordinary `Promise<boolean>` write, behind an inline second press.
- **The admin slice's outlet state (`store/admin.ts`)**: `adminLocations` (every location but quarantine, with
  who is based at each) and `outletActions` (the `kind=outlets` feed) are loaded by `loadAdminLocations` and
  `loadAdminActions(kind)` - the Outlets tab's table and the Accounts tab's location labels both read
  `adminLocations`. `createOutlet` returns the server's row or `null` on a refusal, the same shape as
  `createAccount`, so the form stays as typed. `updateOutlet` and `setOutletOpen` (close and reopen, one action
  both ways, like `setAccountActive`) are the ordinary `Promise<boolean>` writes.
- **The Credit screen's two lists (`store/receivables.ts`) are read, not kept.** `loadReceivables` answers
  `false` rather than throwing and sets `receivablesFailed`, so the screen shows an outage line instead of
  "nobody owes anything" - the distinction `AdminAudit.tsx` draws. `readStatement` answers `null` the way
  `readAuditEntry` does: a statement is never kept in the store. The four writes are the ordinary shape.
- **The audit log's reads (`store/audit.ts`) return `null` on failure**: `loadAudit` (replaces the rows),
  `loadMoreAudit` (appends the page before `next`), `readAuditEntry` (one full entry, not kept in the store)
  and `exportAudit` (pages at 500 rows until `next` is null or 50,000 rows, and says whether it hit the cap).
  `AdminAudit.tsx` shows an outage line on `null`, never "no events". They have no refetch; an `audit` notice
  only bumps `audit.fresh`.
- **An admin-flagged session loads no snapshot.** `loadSnapshot` sets `auth: "ready"` and returns for one,
  because the server 404s every operational read for its token. Sign-in, restore, a password change and any
  later refetch fallback all go through that one guard.
- **Nothing is previewed as a decision.** `freeToPromise`, `availOf`, `priceOf` and `partyRate` (what a
  party is charged, off the snapshot's rate card) are previews while the operator types. The server makes the actual decision. When you preview, use the `@rch/domain` function the
  server uses, not a lookalike.

## src/api

- **`client.ts`** is the one generic client.
  - It mints an `Idempotency-Key` for every write and an `x-request-id` for every request, once per call, so
    the retry after a token refresh is the same request.
  - `ApiError` carries `code`, `status`, `message` and `requestId`.
  - The 401 refresh is coordinated across tabs. Refresh tokens rotate, and two tabs presenting the same one
    signs everybody out. So the refresh runs under `navigator.locks.request("rch-refresh")`, and the new token
    is broadcast on `BroadcastChannel("rch-session")`. A broadcast only replaces a token a tab already holds;
    it never signs in a tab that's on the sign-in screen.
  - Before refreshing, a tab checks whether the token it used is still current. If not, it retries instead of
    refreshing again.
- **`refetch.ts`** maps each `changed` collection to a narrow `GET` through `NARROW`. The `loadSnapshot`
  fallback exists only for a collection missing from `NARROW`, so **add a reader when you add a collection**.
  If a read-back fails, the write's own sentence is kept and qualified, never replaced. Three readers branch on
  an admin session. `tickets`: an admin session reads the desk's list (`GET /admin/support/tickets` into
  `deskTickets`), and everyone else reads their own tickets. `locations` and `outlets` are read the opposite
  way: `locations` pulls the location master back through `GET /locations` for an operational session (then
  bumps `catalogVersion` so every screen re-renders) and does nothing for the super admin, whose token reaches
  no location read but its own; `outlets` pulls the admin's own list back through `GET /admin/locations` for
  that session alone. `audit`: an admin session calls `bumpAuditFresh()`, so the Audit log tab shows
  "New events - show" without moving its rows, and any other session does nothing. No write names `audit` in
  its `changed`; only the audit service's notice does.
  - **A manager-only collection (`priceLists`, `accounts`) is still broadcast to every open session** - the
    server's `pg_notify` isn't per-role. A non-manager tab open when a price list changes gets a 403/404 on
    its own `NARROW.priceLists()` call, which fails the whole `Promise.all` and shows that tab the generic
    "the screen could not be refreshed" toast, even though nothing of theirs failed. Known, matches the
    existing `accounts` behaviour; not fixed here.
- **`wire.ts`** holds the mappers from server shape to store shape.
  - An ISO time becomes `"HH:MM"` only here, and **`iso` is kept beside it** on every document and history
    entry (`Dated<T>`, `Trailed<T>` and `DatedDoc<T>` in `types.ts`).
  - Sort time columns on `iso`. Filter anything labelled "today" with `isToday(iso)` from `lib/fmt.ts`, which
    uses the Asia/Kolkata midnight.
- **`events.ts`** holds one `fetch`-based SSE connection per session. It isn't `EventSource`, because that
  can't send an `Authorization` header.
  - Notices are debounced 250 ms per collection into one `refetch`.
  - A `resync` frame forces a full `loadSnapshot`.
  - It backs off from 1 s to 30 s between reconnects.
  - The shell's header dot shows the connection state: `live`, `reconnecting` or `off`.
- **`session.ts`** keeps the access token in memory, never in `localStorage`.

`loadSnapshot` shows the loading splash only when nothing is loaded yet (`LOC` is empty). Every later call is
a background refresh and must not blank the screen.

## Master data and derived state

- **Master data lives in shared registries.** `src/data/master.ts` exports mutable registries (`IT`, `LOC`,
  `PL`, `PRICE_LISTS`, `MENU`, `USERS`, the four payer lists and the rate card `CLASS_TERMS` /
  `PAYER_TERMS`). They are empty at import, and `hydrateMaster()` /
  `hydrateRoster()` **fill them in place**, so assign into them and never reassign them. Anything that changes
  them bumps `catalogVersion`, which screens use as a memo key.
- **`PL` is keyed by price-list id, not a fixed pair** - every list a manager has created, `PL[list][it]` its
  item→price map. `PRICE_LISTS[list]` is the entity itself (`{ id, name, outlets }`), for a name to print and
  for the manager's Prices screen to filter by outlet or by name. A `Location.list` names which id an outlet is
  active on; it is never itself the price.
- **`IT` includes retired items**, because old documents still name them. Pickers must read `activeItems()`,
  never `Object.keys(IT)`.
- **`src/lib/selectors.ts` is the source of truth for everything derived.** That covers `qty`, `resv`,
  `avail`, `freeToPromise`, `availOf`, `priceOf`, `procurementList`, `prqProgress`, `prqDecision`, `onOrder`,
  `awaitingApproval`, `inTransit`, `costOf` and the transition predicates (`canHandOver`, `canDispatch`,
  `canSendPo`, …). The predicates read the domain tables, so any button the UI draws is one the server
  accepts.
- **Outlets are read from the location master, never from a list compiled into the bundle.** `openOutlets()`
  is for a picker that *starts* something - counter peers, the kitchen-order drawer, a price or an
  availability list - open ones only. `allOutlets()` is for a filter over history - Approvals, Orders - where
  a closed outlet still belongs, since a closed outlet's approvals are still approvals; it prints as
  `<name> (closed)`. Bills builds its own outlet filter from the bills it holds rather than calling
  `allOutlets()`, so a window with nothing billed at an outlet never offers it. `operationalLocs()` is the
  store, the kitchen and the open outlets together, for anything that lists every place an operator works
  today. `locName(key)` is the one place a location's display name is
  read - the bare key when `LOC` doesn't carry it yet.
- **Delivered quantities on buyer and store screens use `netReceived`**, not gross `recv`.
- **Never hand-format a number or a date.**
  - Numbers: `money`, `money0`, `lakh`, `fq(v, it)` with `U(it)`, `unitTotal`.
  - Wire values: `fromWireTime`, `fromWireDate`, `fromWireDay` (an instant printed as its IST day).
  - The store keeps dates as `dmy` display strings (`"DD-MMM-YYYY"`). The exception is a production order's
    `need`, which stays ISO because its only editor is `<input type="date">`.

## UI kit and styling

- **Use `src/ui/kit.tsx`'s typed components instead of bespoke markup.** These include `Card`, `DataTable`,
  `PageHead`, `Btn`, `Pill`, `Alert`, `Field`, `FormRow`, `Toolbar`, `Kpis` and `Otp`.
- **Explanations live in tooltips; what the operator must see stays on the page.** `Tip` (`ui/Tip.tsx`,
  re-exported by the kit) is the one tooltip. It opens on mouse hover, on keyboard focus, and on a press or tap,
  which pins it. Escape, a press elsewhere, or focus leaving closes it, and Escape never reaches the drawer
  behind it.
  - `PageHead`, `Card`, `Section`, `Field`, a `Kpi` and a `Col` each take a `tip`, drawn as an "i" beside
    the heading or label. A sentence that explains a page, a card, a field or a figure goes there.
  - `sub`, `hint` and a `Kpi`'s `d` stay visible, and only for things read every time: counts, names,
    validation errors, live figures and warnings. An `Alert` is never a tooltip.
  - `<Tip text="…">{value}</Tip>` explains a value in place, and `Btn`'s `tip` explains a button, even a
    disabled one. `title` only names a symbol-only button. It never explains.
  - The bubble is always in the DOM (`hidden` while closed), so tests still find a moved sentence by its text.
    Never put a `Tip` inside a `<label>`, a heading or a `<button>`, where that hidden text would join
    theirs.
- **`ItemImage({ it, size })`** (also in `kit.tsx`) replaces `ImagePlaceholder` at every call site that has an
  item in hand: it draws the item's own photo (`photoSrc`, keyed on its hash) when `IT[it].img` is present and
  the image has not failed to load, and falls back to `ImagePlaceholder` otherwise - a call site with no item
  in hand (nothing selected yet) keeps the bare placeholder. `src/lib/photo.ts` holds `photoSrc` (the URL under
  `API_PREFIX`), `toBase64` (chunked, so a large photo doesn't overflow the call stack) and `shrinkPhoto` (an
  `<input type=file>`'s `File` to at most 800 px on its long edge, JPEG re-encoded, which is also what strips
  EXIF - GPS included). `ui/PhotoPicker.tsx` is the shared Add/Change/Remove control built on `ItemImage`,
  `shrinkPhoto` and the store's `setItemImage`/`removeItemImage`: the manager's `ItemDrawer` and the counter's
  `ConfigureDrawer` (when the item is on that counter's own menu) are its two call sites. A client-side refusal
  (`checkPhoto` from `@rch/domain`) toasts the domain's own sentence and sends nothing.
- **`DraftLineInput`** is the commit-on-blur number box. Every typed quantity uses it, because a controlled
  number input can't take a half-typed `12.`. Its `ariaLabel` is required even beside a `<label>`, because
  `Field` only wires `htmlFor` to a direct DOM child.
- **`useLineKeys(n)`** gives each row of an editable line table a stable key. Call its `drop(i)` next to the
  state update that removes a line.
- **Styling is plain CSS** in `src/styles.css`, with no framework. It has one token set on `:root`, redefined
  under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`, and again under
  `[data-theme="dark"]`.
- **Printing** uses three classes: `.print-slip` (the only thing on paper), `.no-print` and `.print-only`.
- **The bell's rows are queues, not messages.** `navQueues` in `ui/Shell.tsx` returns the documents behind
  each badge. Opening a row stores those ids through `ui/seen.ts` (`localStorage`, per account), which moves
  the row under Earlier. Anything that joins the queue afterwards brings it back under New, in red.
- **The toast is drawn once**, by `ui/Toast.tsx` in `App.tsx`, not by the shell. The sign-in and
  change-password forms don't toast a refusal at all: they show `authError` inline.

## Tests

`src/__tests__/` runs in jsdom with `TZ=UTC` and a 20 s timeout.

- **`fixture.ts`** is the reset point: `resetStore()`, `S()` for the state, `as(role)` to sign in from the
  fixtures, and `signedOut()`.
- **`writes.test.ts`** drives store actions against a stubbed `fetch`. `serve({ "METHOD /path": … })` sets up
  responses, and `calls()` / `hit()` assert bodies and read-backs. Test the wire and the refetch here; the
  rules themselves belong to the API's suites.
- **`screens.test.tsx` / `app.test.tsx`** cover every role × nav key, plus every registered drawer.
- **`bare.test.tsx`** renders every screen against exactly what a `--bare` database serves: six locations and
  nothing else.
- **`login-picker.test.tsx`** drives the sign-in employee picker (list, filter, keyboard, the administrator's
  typed id, the fallback); **`admin-accounts.test.tsx`** drives the account page (next-id preview, the Super
  Admin row, delete's second press). Both stub `fetch` by `"METHOD /path"`; the sign-in screen reads
  `GET /auth/directory` as it mounts, so a case that queues a login response must answer by URL, not in order.
- **`admin-payers.test.tsx`** drives the Payers tab the same way (every kind listed, the create's body and a
  refusal leaving the form as typed, the switch sending `{ active: false }`, a switched-off payer who still
  owes money still listed, and no delete button anywhere on the page). `AdminDashboard` reads the register as
  it mounts, so any case that mounts that page must stub `GET /admin/payers` too.
- **`admin-audit.test.tsx`** drives the Audit log tab against a stubbed `GET /admin/audit`: rows and counts,
  filters reaching the query string, "Load more" sending `before`, an `audit` notice showing the pill without
  changing the rows, before → after listing only changed fields in the drawer, and the outage line against
  the empty state. **`audit-lib.test.ts`** pins `lib/audit.ts`'s `auditDayRange`, `deviceOf`, `diffFields` (one
  level into a nested object, arrays compared whole) and `auditCsv`. `writes.test.ts` covers the slice's reads
  and `refetch`'s `audit` reader.
- **`manager-credit.test.tsx`** drives the Credit screen's three tabs against a stubbed `GET /receivables` and
  `GET /settlements`: the outage line in place of "nobody owes anything", a category rate reaching the wire,
  the oldest-first allocation preview, and Void offering itself only on today's payment.
  **`admin-payers.test.tsx`** drives the register tab - every kind on the table, the add form surviving a
  refusal, the switch, and that no delete control exists anywhere on the page.
- **`fixes.test.ts`** pins earlier defects by tag (C6, M3, M8, H4, UA-14…). Read the comment before changing
  what one covers.
- **No production file under `src/` imports `@rch/contract/fixtures`.** Only tests do.
