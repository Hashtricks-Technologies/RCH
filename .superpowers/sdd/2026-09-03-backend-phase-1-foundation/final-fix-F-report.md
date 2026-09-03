# Re-review, final fix wave F — idempotency vs. rate limiter and slow-request takeover

Worktree `.claude/worktrees/agent-a743f44ce4e24e9c7`, branch
`worktree-agent-a743f44ce4e24e9c7`, fast-forwarded onto `feat/phase-1-foundation`
(`a7bc625 Merge final fix wave B: auth, idempotency and client hardening`).

Scope kept to `apps/api/src/plugins/idempotency.ts`, `apps/api/src/plugins/idempotency.test.ts`,
`apps/api/src/plugins/security.test.ts` and `apps/api/src/app.ts`. `config.ts` and `.env.example`
were not touched — no new setting was needed.

## N1 — a throttled write's 429 was being recorded as the idempotent response

`plugins/idempotency.ts`'s `onSend` only ever dropped the claim for `statusCode >= 500`. The
rate limiter (`plugins/security.ts`) runs at `preHandler` *after* the idempotency claim is
inserted (it has to, to see `req.user.sub` — see wave B's I2), so a request that gets throttled
already owns a claim row when the 429 lands. `onSend` would previously record that 429 into the
row, and every retry with the same key for the next 24h would replay "too many requests"
instead of ever performing the write.

Fix: `onSend` now deletes the claim for `statusCode === 429` too (503 was already covered —
it's `>= 500`), exactly like the 5xx branch: the client's retry with the same key is a clean
first attempt once its budget refills.

Also added, since it can't be said in `security.ts` (out of scope for this wave): a comment in
the `idempotency` preHandler, right above the claim INSERT, spelling out that a throttled
request still performs the INSERT before being rejected — intentional, because reordering the
limiter ahead of `idempotency`/`roleGate` would mean reordering it ahead of `authenticate` too
and losing the per-user keying wave B fixed (I2). The `hook: "preHandler"` registration in
`security.ts` itself was not touched.

Tests (`apps/api/src/plugins/idempotency.test.ts`):

- "never records a 429 from the rate limiter as the idempotent outcome" — a second Fastify app
  (`buildApp` directly, not `buildTestApp`) sharing `app`'s already-migrated `db`/schema via
  `{ db: app.db, migrationsSchema: app.testDb!.schemaName }`, built with
  `RATE_LIMIT_PER_MINUTE: "10"` (same pattern as `security.test.ts`) so it doesn't drag every
  other test in the file onto a shared limiter. Burns the budget with 10 plain reads (no
  Idempotency-Key needed), then `PATCH /me` with a fresh key → 429, asserts no
  `idempotency_keys` row for that key, then repeats the same key (still throttled) and asserts
  the reply carries no `idempotency-replayed` header — proving it was treated as a fresh claim
  attempt, not a replay.
- "never records a transient 503 as the idempotent outcome" — a third such app with a
  test-only route mounted via the real `mount()` helper *before* `.ready()` (so it picks up the
  real `authenticate → roleGate → idempotency` preHandler chain), whose handler throws an
  `Error` with `statusCode = 503`. Asserts no row survives.

## Minor 5 — nothing bounded a legitimate slow request inside the claim's stale window

`app.ts`'s `Fastify(...)` options now set `requestTimeout: 30_000` and
`connectionTimeout: 10_000`, with a comment tying them to `CLAIM_STALE_MS`. `CLAIM_STALE_MS`
itself moves from `60_000` to `120_000` (comment updated) so a takeover can only happen once
Fastify has already terminated any request that was merely slow, not abandoned.

The existing "takes over a claim abandoned by a crash" test rewinds a claim's `created_at` to
simulate staleness; its offset moved from `120_000` (previously 2× the old 60s window, now
exactly on the new window's boundary) to `130_000`, with a comment on why — sitting exactly on
the boundary would make the assertion depend on how much wall-clock time elapses between the
`UPDATE` and the follow-up request.

Test: `security.test.ts` → new `describe("server timeouts")` asserting
`app.initialConfig.connectionTimeout === 10_000` and, via a documented cast,
`app.initialConfig.requestTimeout === 30_000` — this Fastify version's `initialConfig` TS type
omits `requestTimeout` even though it's a real, validated constructor option (fastify's own
test suite round-trips it through `initialConfig` in JS). Put here rather than in `app.test.ts`
since that file was out of scope for this wave.

## Minor 6 — the claim INSERT still runs ahead of the throttle check

No code change beyond the comment described under N1 above — reordering `hook` was ruled out
per the finding, and with N1 fixed the row left behind by a throttled request's claim is
deleted again in the same request, not merely on the next purge sweep.

## Verification

```
$ pnpm vitest run   (apps/api)
 Test Files  18 passed (18)
      Tests  87 passed (87)

$ pnpm turbo typecheck
 Tasks:    4 successful, 4 total

$ pnpm lint
@rch/contract:lint / @rch/domain:lint / @rch/api:lint: 0 warnings, 0 errors
@rch/ui:lint: 250 warnings (pre-existing react/jsx-key noise, none in files touched here), 0 errors
knip: silent, exit 0
boundaries: OK (protected tables, ledger single door, module skeleton)
```

`git diff --stat` confirms only the four in-scope files changed:
`apps/api/src/app.ts`, `apps/api/src/plugins/idempotency.ts`,
`apps/api/src/plugins/idempotency.test.ts`, `apps/api/src/plugins/security.test.ts`.
