# Final review, fix pass B — application code

Worktree `.claude/worktrees/agent-ab7033561b9363bdc`, branch
`worktree-agent-ab7033561b9363bdc`, fast-forwarded onto `feat/phase-1-foundation`
(`756a8ab Restore the session on reload and gate CI on knip`).

Scope kept to `apps/api/src/**`, `apps/api/drizzle/**`, `packages/contract/src/**`,
`UI/src/api/client.ts`, `UI/src/store/index.ts`, `UI/src/__tests__/**` and two paragraphs of
`deploy/RUNBOOK.md`. Nothing under `deploy/chart`, `.github/`, `scripts/`, `.oxlintrc.json` or
`apps/api/src/modules/_template/` was touched.

## I1 — change-password left the client holding two dead credentials

`POST /auth/change-password` now answers with `AuthResponseSchema`.

- `packages/contract/src/routes.ts` — `changePassword.response = AuthResponseSchema`.
- `apps/api/src/modules/auth/service.ts` — `changePassword(userId, current, next, meta)`
  returns a `Session`. In one transaction: set the password, revoke every existing family,
  re-read the user row (so `must_change_password` is already false) and `issue()` a fresh
  family. Minting from the re-read row is what makes the new access token carry `mcp: false`.
- `apps/api/src/modules/auth/routes.ts` — the handler now goes through the login route's
  `respond` helper, so the new refresh cookie is set the same way.
- `UI/src/store/index.ts` — `changePassword` takes `r.accessToken` into `setAccessToken`, sets
  `user` / `mustChangePassword` from the reply, then `loadSnapshot()`.

Tests:

- `apps/api/src/modules/auth/auth.test.ts` → "hands back a working session: the old cookie is
  dead, the new token and cookie are not" (the returned token reaches `/snapshot` with 200, the
  returned cookie refreshes with 200, the pre-change cookie 401s).
- same file → "a must-change user can reach change-password but not /snapshot, and the reply
  un-gates them" now asserts the returned token reaches `/snapshot` with 200 — the exact
  staging-first-login path from the finding.
- `UI/src/__tests__/session.test.ts` → "swaps in the session the change hands back, then loads
  the snapshot" (token replaced, the snapshot call carries the new bearer).

## I2 — rate limiter never saw `req.user`

`apps/api/src/plugins/security.ts` registers `@fastify/rate-limit` with `hook: "preHandler"`,
so the limiter runs after the `authenticate` preHandler `mount()` attaches and the
`keyGenerator` finally sees `req.user.sub`; public routes still fall back to the IP.

Test: `apps/api/src/plugins/security.test.ts` — an app with `RATE_LIMIT_PER_MINUTE: "10"`,
ten `/api/v1/me` calls as u1 (all 200), one as u2 from the same IP (200), u1's eleventh (429,
`rate_limited`).

Two consequences worth knowing, both noted in the code comment:

1. A request `authenticate`/`roleGate` rejects no longer reaches the limiter, so bad tokens
   stop eating an IP budget. The brute-forceable surface (`/auth/login`, `/auth/refresh`) is
   public, has no preHandler in front of the limiter, and keeps its per-IP budget — login also
   keeps its tighter route-level one.
2. The plugin appends to the route's existing preHandler array, so on an authenticated write
   the idempotency claim is inserted before the limiter runs. A throttled write therefore
   leaves a claim row behind; it expires in 24 h and the nightly purge removes it. Getting the
   limiter in between `roleGate` and `idempotency` is not expressible through the plugin's
   `onRoute` hook, and calling the limiter by hand for that was judged not worth it.

## I5 / I7 — request bodies were not strict, and had no maximum lengths

`packages/contract/src/schemas/auth.ts`: `LoginBodySchema`, `ChangePasswordBodySchema` and
`PatchMeBodySchema` are all `z.strictObject` now. `emp` is `.trim().min(1).max(64)`,
`password` `.min(1).max(200)`, `ChangePasswordBodySchema.current` `.max(200)`.

`apps/api/src/modules/auth/service.ts`: `Attempts` is exported and bounded. `hit()` re-inserts
the key so the Map's insertion order doubles as an LRU-ish eviction order, evicts the oldest
once `cap` (default 10 000, constructor-injectable) would be exceeded, and every 1 000 hits
sweeps keys whose window has gone quiet — `hit()` itself can never leave a key's window empty
(it always pushes `now`), so the periodic sweep is the mechanism that reclaims keys nobody
touches again.

Tests:

- `packages/contract/src/routes.test.ts` (new) — every `routes.*.body` accepts its own sample
  and refuses an unknown key, plus a coverage case that fails if a new body route arrives
  without a sample.
- `apps/api/src/modules/auth/auth.test.ts` → "evicts the oldest key once it is full…" (cap 3
  injected via the constructor) and "drops keys whose window has gone quiet".

## I6 — `refresh_tokens.token_hash` unindexed, table never pruned

- `apps/api/src/db/schema/infra.ts` — `uniqueIndex("refresh_tokens_token_hash_uq").on(t.tokenHash)`.
- `apps/api/drizzle/0001_refresh_token_hash.sql` + `meta/0001_snapshot.json`, journal tag
  renamed to `0001_refresh_token_hash`. Generated with `pnpm --filter @rch/api db:generate`;
  the SQL contains no `"public".` (checked).
- `apps/api/src/modules/auth/repo.ts` — `purgeRefreshTokens(db)` deletes rows with
  `expires_at < now()` OR `revoked_at < now() - interval '7 days'`.
- `apps/api/src/cli/purge.ts` calls both purges and prints a count for each.

Tests: `auth.test.ts` → "removes expired and long-revoked rows and keeps live ones" (four
rows, two deleted). `expectedMigrationCount()` is now 2 and
`apps/api/src/db/schema.test.ts` → "makes /readyz green once migrated" still passes.

## I11 — idempotency recorded the key only in `onSend`

`apps/api/src/plugins/idempotency.ts` rewritten around a claim row.

The preHandler inserts `(key, user_id, request_hash, status_code = 0, response = 'null'::jsonb,
expires_at = now()+24h)` with `onConflictDoNothing().returning()` — zero rows back is the
unique violation, without a thrown error that would poison a surrounding transaction. On
conflict it reads the row: different hash → 409 as before; `status_code > 0` → replay;
`status_code = 0` and `created_at` within 60 s → 409 "That request is still being processed —
try again in a moment."; older than 60 s → the claim is taken over with an atomic
`UPDATE … SET created_at = now() WHERE status_code = 0 AND created_at < <stale>` (so two
would-be takers cannot both win) and the request proceeds. `onSend` only ever UPDATEs, and
stores `sql\`'null'::jsonb\`` for an empty body since the column is `jsonb not null`.

One addition beyond the prescription: a 5xx now **deletes** the claim instead of leaving it.
Without that, a server error would lock the key out for the full 60 s stale window, turning a
retryable failure into a 409; the old code likewise recorded nothing for a 5xx.

Tests (`apps/api/src/plugins/idempotency.test.ts`):

- "lets exactly one of two concurrent requests with the same key through" — the first request
  is parked inside `meRepo.update` via a gate so the overlap is deterministic (racing two
  `inject()`s failed intermittently: on a cold path the first request finished before the
  second even claimed, and the second replayed with 200). Asserts 200 + 409, `conflict`, the
  "still being processed" message, one call to the repo, and that a later request with the same
  key replays the winner's exact body with `idempotency-replayed: true`.
- "takes over a claim abandoned by a crash" — the row is rewound to a response-less claim:
  fresh → 409, a minute old → 200 and not a replay.

## Minor — snapshot scope leaked hospital-wide revenue

`apps/api/src/modules/snapshot/scope.ts` keeps `dayLabels` and reduces each `sales` row to the
counter's own outlet column (`["rest","coffee","kiosk"].indexOf(loc)`), or to an empty row when
the counter's location is not an outlet. `snapshot.test.ts`'s counter case now asserts the row
count and labels match the unscoped snapshot, every row has exactly one number, and that number
is the coffee column of the full snapshot.

## Minor — fixtures

`packages/contract/src/fixtures/fixtures.test.ts` asserts display names are unique too, with a
comment pointing at the support-ticket scoping that depends on it.

## I10 + minor — UI client

`UI/src/api/client.ts`: `idempotencyKeyFor(route)` is called once in `call()` and the key is
passed to both `raw()` invocations, so the post-refresh retry carries the same
`Idempotency-Key`. `parse()` wraps `JSON.parse` and throws
`ApiError("internal", "The server returned an unexpected response (<status>).", status)` for a
non-JSON body (ALB 502 page) instead of a raw `SyntaxError`.

Tests (`UI/src/__tests__/api.test.ts`): "reuses one Idempotency-Key across the refresh retry"
and "turns a non-JSON error page into a readable ApiError".

## Docs

`deploy/RUNBOOK.md`: the housekeeping paragraph now says the nightly job also prunes
`refresh_tokens` (expired, and revoked more than seven days ago) and prints a count for each;
the accounts paragraph notes that a first-sign-in password change hands the browser a fresh
session in the same reply. `.env.example` needed no change — no variable's meaning moved.

## Verification

```
$ pnpm turbo typecheck test
@rch/contract:test  Test Files 3 passed (3)   Tests 9 passed (9)
@rch/domain:test    Test Files 4 passed (4)   Tests 7 passed (7)
@rch/ui:test        Test Files 8 passed (8)   Tests 307 passed (307)
@rch/api:test       Test Files 17 passed (17) Tests 83 passed (83)
 Tasks:    8 successful, 8 total

$ pnpm lint
@rch/contract:lint: Found 0 warnings and 0 errors.
@rch/domain:lint:   Found 0 warnings and 0 errors.
@rch/ui:lint:       Found 250 warnings and 0 errors.   # pre-existing react/jsx-key in role screens; none in the files touched here
@rch/api:lint:      Found 0 warnings and 0 errors.
 Tasks:    4 successful, 4 total
knip: silent, exit 0
```

`npx vitest run src/plugins/idempotency.test.ts` was repeated three times on its own and the
whole API suite twice after the gate was introduced — no flakes.
