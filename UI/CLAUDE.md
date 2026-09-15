# UI - CLAUDE.md

Repo-wide rules and the domain invariants are in the root `CLAUDE.md`. `UI/README.md` describes the app for a
human reader. This file covers what is specific to `@rch/ui`.

## Commands

```bash
pnpm --filter @rch/ui dev         # vite on :5173, proxying /api → http://localhost:3000
pnpm --filter @rch/ui test        # vitest run --coverage (jsdom); floor lines 73 / branches 51
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
That page has two tabs: `AdminUsers` (staff accounts) and `AdminSupport` (the support desk: every role's tickets).

`screens.test.tsx` and `app.test.tsx` render every `NAV` key for every role. A nav entry with no component fails
the suite, on purpose.

**Drawers are a bare registry** in `src/drawers.ts`:

- A module calls `registerDrawer("key", C)` at the bottom of its file.
- `openDrawer(t, id)` opens it.
- `ui/Drawer.tsx` and `DrawerFrame` supply the chrome and a real focus trap (`aria-modal`).
- `screens.test.tsx`'s `OPEN_OVER` map needs a `key → [id, role]` row for every registered drawer, or the
  suite fails by name.
- A drawer that derives state in `useState` and gets re-pointed without unmounting must key its body on the
  document's id **and the last entry of its trail**. `manager/ApprovalDrawer.tsx`'s `bodyKey` is the example.

Components shared by two or more roles live in `src/ui/`, because role folders don't import each other. That
includes `TicketSlip`, `NewProductForm`, `AdjustmentForm` and `KitchenOrderForm`.

## The store is an API client

`src/store/index.ts` holds the state and most actions. The other slices (`procurement.ts`, `ops.ts`,
`admin.ts`) are merged into the same `create()` and share one `AppState`. Components subscribe
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
- **Some reads have no notify and no refetch**: `readStockLedger`, `readCredit` and
  `loadSignInDirectory` (the sign-in picker's staff list). They return `null` on failure, never an empty list,
  so a screen can tell an outage from genuinely nothing. `Login.tsx` falls back to a typed id on `null`.
- **Account writes (`store/admin.ts`)**: `createAccount` sends no employee number (the server assigns it) and
  returns `{ emp, password } | null`, the number actually given; `AdminUsers.tsx` previews it with
  `nextEmpNo`. `deleteAccount(id)` is the ordinary `Promise<boolean>` write, behind an inline second press.
- **An admin-flagged session loads no snapshot.** `loadSnapshot` sets `auth: "ready"` and returns for one,
  because the server 404s every operational read for its token. Sign-in, restore, a password change and any
  later refetch fallback all go through that one guard.
- **Nothing is previewed as a decision.** `freeToPromise`, `availOf` and `priceOf` are previews while the
  operator types. The server makes the actual decision. When you preview, use the `@rch/domain` function the
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
  If a read-back fails, the write's own sentence is kept and qualified, never replaced. `tickets` is the one
  reader that branches: an admin session reads the desk's list (`GET /admin/support/tickets` into
  `deskTickets`), and everyone else reads their own tickets.
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
  `PL`, `PRICE_LISTS`, `MENU`, `USERS`, and the payer lists). They are empty at import, and `hydrateMaster()` /
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
- **`fixes.test.ts`** pins earlier defects by tag (C6, M3, M8, H4, UA-14…). Read the comment before changing
  what one covers.
- **No production file under `src/` imports `@rch/contract/fixtures`.** Only tests do.
