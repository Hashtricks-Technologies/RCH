# `e2e/` — the Playwright smoke

Eight scenarios that drive a real browser against a real stack: a real sign-in, a real cookie,
an nginx (or Vite) proxy in front of the API, a live-update stream and a Postgres transaction.

**It imports nothing from this repo, on purpose.** `packages/contract`, `packages/domain`,
`apps/api` and `UI` each check the contract from the inside; a smoke that shared their types
would pass because both sides changed together. This one knows only URLs, employee numbers and
the words on the screen — which is why its assertions read like the acceptance scenarios rather
than like unit tests, and why a change of wording in a toast is meant to fail it.

**The script is `test:e2e`, not `test`.** `pnpm test` is `turbo run test` over every package and
CI runs it with no stack up. Nothing in `turbo.json`'s `test` task reaches this package, because
the script it looks for does not exist here.

## The scenarios

| File | What it proves that nothing else does |
|---|---|
| `tests/signin.spec.ts` | Every role signs in against a real cookie and lands on its own home screen; a role's own URL is refused to another role **with a sentence** (UA-01), and the sidebar never offered the link |
| `tests/sell.spec.ts` | A cash sale takes the money and moves the shelf — the ledger, through the browser, in one transaction |
| `tests/request-chain.spec.ts` | Counter raises → manager approves **in a second window** → the counter's list turns "Manager approved" with no reload → store issues → OTP read off the collector's screen → handover → receive. The live-update path and the whole movement rule |
| `tests/kitchen.spec.ts` | A batch consumes its recipe and books its yield; a short one is refused and the tile keeps what the kitchen typed |
| `tests/buying.spec.ts` | Requisition → approve → purchase order → send → goods receipt with a rejection → the rejected quantity is on the quarantine shelf |
| `tests/support.spec.ts` | A support ticket is raised, answered, resolved and rated — and another role's list does not hold it |

## Running it locally

The smoke needs a stack that is **seeded, same-origin and not rate-limited against itself**.

```bash
pnpm db:up
pnpm --filter @rch/api db:migrate
SEED_FORCE_PASSWORD_CHANGE=false pnpm --filter @rch/api db:seed --force
pnpm --filter @rch/e2e exec playwright install chromium   # once
pnpm dev &                                                # api :3000, UI :5173
pnpm test:e2e
```

Expected: **12 tests, all passing, in about 35 seconds** (the table above counts the sign-in
loop as one scenario; Playwright counts it as five tests plus the guard).

Three settings in the root `.env` matter, and the seed and the API must both be started with
them in place:

| Setting | Why the smoke needs it |
|---|---|
| `SEED_FORCE_PASSWORD_CHANGE=false` | Seeded accounts otherwise land on "Choose a new password" at first sign-in and the password rotates out from under every later role. `signIn` refuses to guess and says so by name. |
| `LOGIN_RATE_LIMIT_PER_MINUTE=200` | The whole run signs in about sixteen times from one address; the default per-IP budget is ten a minute. |
| `LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE=100` | The counter operator alone signs in five times; the default per-employee budget is five a minute. |

`RATE_LIMIT_PER_MINUTE` is deliberately **not** raised: everything else the smoke does stays
inside the 300-a-minute budget production runs, and it should keep doing so.

### Running against a stack on other ports

`E2E_BASE_URL` points the smoke anywhere:

```bash
E2E_BASE_URL=http://localhost:5180 pnpm test:e2e
```

The one thing that cannot move with an environment variable is the Vite dev server's `/api`
proxy target, which `UI/vite.config.ts` pins to `http://localhost:3000`. To drive an API on
another port, serve the built app (`pnpm --filter @rch/ui exec vite build`) behind a proxy of
your own — the browser has to reach the API **same-origin**, because the session is a cookie
and `GET /api/v1/events` carries no CORS headers.

`E2E_PASSWORD` overrides the seeded password (`changeme`).

## Running it in CI

`.github/workflows/ci.yml`'s `images` job installs the real chart into a throwaway kind cluster
and then, with `E2E=1`, `deploy/chart/rch/ci/install-test.sh` runs the smoke through the UI's
own port-forward — the only place in the pipeline where a real chart, a real nginx and a real
database already exist together. The same script sets the three settings above with
`--set-string api.env.…` so a plain (non-E2E) install still proves the chart's own defaults.
On failure the HTML report, traces and screenshots are uploaded as the `playwright-report`
artifact.

## House rules for a new scenario

- **Assert on what a person sees.** A toast sentence, a row appearing in another window, a
  number changing. Never on a network call, a store field or a class that only the test knows.
- **Never `waitForTimeout`.** Wait on the selector, the toast or the row. Every wait in here is
  an `expect` with a timeout, so a failure names what never arrived.
- **Read the id out of the toast**, never from a fixture: `sequences` survives a reseed, so the
  next `REQ-` is not the same number twice. `idFromToast` waits for the sentence that carries
  it, because a screen that warned on the way in still has its own toast up.
- **One worker, no retries locally.** The smoke sells, issues and receives against one real
  database; two workers would fight over the same shelf and a retry would re-run a scenario
  whose first attempt already moved stock.
- **Six files, eight scenarios, and no more.** More would be a second test suite maintained by
  hand against a UI that moves.

## Known switches

Two assertions are gated, because at this tree they would pass whatever the server did — and an
assertion that cannot fail is worse than none. Each prints a `not asserted` annotation into the
run while it is off, so neither can go quiet. Set the variable on the `helm install into kind`
step in `.github/workflows/ci.yml` in the same commit that lands the change, and delete the
switch in the one after.

| Variable | The assertion it turns on | What has to land first |
|---|---|---|
| `E2E_OTP_REDACTED=1` | The issue desk prints none of the six digits it is checking — neither through `<Otp>` nor as the bare `span.mono` column `store/IssueDesk.tsx` and `manager/ItemsStock.tsx` write | The wire withholding `otp` from the sending location, **and** the store's screens no longer rendering it |
| `E2E_SUPPORT_SERVER=1` | A support ticket raised at one counter is not in another role's list | The support desk moving off `UI/src/store/ops.ts`, which today mints the id in the browser and keeps the conversation in memory |
