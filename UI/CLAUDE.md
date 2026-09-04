# UI — CLAUDE.md

Repo-wide rules, the movement rule and the domain invariants are in the root `../CLAUDE.md`;
`UI/README.md` describes the app for a reader rather than an agent. This is what is specific to
`@rch/ui`.

## What this is

React 19 + Vite 8 + TypeScript (strict, `verbatimModuleSyntax`, `erasableSyntaxOnly`) + Zustand 5.
Routing is `HashRouter` with **one** route, `/:key`, so the static build works from any host with
no SPA rewrite. Since Phases 1–3 the store is largely an API client: it signs in for real,
hydrates from `GET /snapshot`, and posts the writes that have moved server-side. Only the theme
and a couple of UI prefs reach `localStorage`.

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
opens it, and `ui/Drawer.tsx` + `DrawerFrame` supply the chrome.

## The store is an API client

`src/store/index.ts` holds the state and most actions; `store/procurement.ts` and `store/ops.ts`
are merged into the same `create()` and share one `AppState`. Components subscribe narrowly:
`useApp((s) => s.req)`.

**On the server now** — Phase 2: `pay`, `toggleAvail`, `savePrice`, `addProduct`,
`removeProduct`. Phase 3: `submitRequest`, `requestFromStore`, `cancelRequest`, `approveRequest`,
`rejectRequest`, `issueTicket`, `handover`, `receiveTicket`, `dispatchOrder`, `distribute` (in
`store/index.ts`) and `transferToOutlet`, `askShop`, `answerShopAsk`, `declineShopAsk` (in
`store/ops.ts`). Session actions — `login`, `restore`, `loadSnapshot`, `logout`,
`changePassword`, `saveProfile` — go through the same client.

**Still local to the store** until their phase lands: the rest of production (`setOrderStatus`,
`makeProduct`), all of `store/procurement.ts` (`sendRequisition`, vendors, PO lifecycle, goods
receipt), and the ops slice's support tickets, rate contracts, new-product requests and
`createItem`.

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
  `busy: string | null`, one per row) are the two patterns; copy one of them.

## Reading back

`src/api/client.ts` is the one generic client: `call(route, input)` builds the URL from the
manifest, mints an `Idempotency-Key` for a write (**once per call**, so the post-refresh retry is
the same write), and on a 401 refreshes once and retries. `ApiError` carries `code`, `status`,
`message`, `details`. There are no hand-written fetch wrappers — add a manifest entry instead.

`src/api/refetch.ts` pulls back exactly what a write said it changed. `stock`, `rsv` and `ovr`
come from `GET /stock`; `NARROW` maps `bills → GET /bills`, `req → GET /requests`,
`tkt → GET /tickets`, `shopAsks → GET /shop-asks`. Anything else — prices, menus, the collections
later phases add — has **no narrow reader**, so it costs one `loadSnapshot`, and a mixed set takes
the snapshot alone. If the read-back fails the write's own sentence is kept and qualified, never
replaced: the operator must not be sent round to do it twice. `src/api/wire.ts` holds the
server-shape → store-shape mappers (`applySnapshot`, `applyStock`, `applyBills`, `applyRequests`,
`applyTickets`, `applyShopAsks`); ISO times become `"HH:MM"` there and nowhere else.

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

## Master data, derived state, formatting

`src/data/master.ts` exports mutable registries (`IT`, `LOC`, `RCP`, `PL`, `MENU`, `USERS`) seeded
from `@rch/contract/fixtures` and **replaced in place** by `hydrateMaster()` when the snapshot
lands — screens import them directly, so assign into them, never reassign them. `data/seed.ts`,
`data/ops.ts` and `data/vendors.ts` are the in-flight documents the still-local slices start from.
`store.signIn(id)` is test-only: the server's directory is `UserMin[]` with no email or employee
number, so a signed-in person's whole record comes from the fixtures.

`src/lib/selectors.ts` is the source of truth for everything derived — `qty`, `resv`, `avail`,
`freeToPromise`, `availOf`, `priceOf`, `procurementList`, `prqProgress`, `onOrder`,
`awaitingApproval`, `inTransit`, `parOf`, `costOf`. Most of it delegates to `@rch/domain` with the
local `MASTER`. **Never mirror a derived value into the store.** The transition predicates
(`isReqOpen`, `canIssueTicket`, `canHandOver`, `canReceiveTicket`, `canDispatch`) read the domain
tables, so a button the UI offers is one the server accepts.

Never hand-format a number: money through `money` / `money0` / `lakh`, quantities through
`fq(v, it)` with `U(it)`, mixed-unit totals through `unitTotal`, wire values through
`fromWireTime` / `fromWireDate` / `fromWireBestBefore` (all in `src/lib/fmt.ts`).

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
to sign in from the fixtures.

- `store.test.ts`, `fixes.test.ts` (regression pins tagged C6, M3, M8, H4, UA-14 — read the
  comment before changing what one covers), `procurement.test.ts` — the still-local slices.
- `writes.test.ts` — the nineteen API-backed actions against a **stubbed `fetch`**: `serve({...})`
  keyed by `"METHOD /path"`, `calls()` / `hit()` to assert the body and the read-backs. Success
  refetches the right slices; a refusal toasts the server's sentence and leaves state untouched.
  Render-level cases drive the real `Pos` and `counter/Requests` components. The rules those
  routes enforce belong to the API's own suites — do not re-assert them here.
- `events.test.ts` — frame parsing, the 250 ms debounce into `refetch`, `resync` forcing a full
  `loadSnapshot`, and the `live` / `reconnecting` / `off` state the pill reads.
- `api.test.ts`, `session.test.ts`, `theme.test.ts`, `screens.test.tsx`, `app.test.tsx`.
