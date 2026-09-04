# RCH Backend — Phase 6: Ops + go-live — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The last in-memory path closes and the system becomes shippable. The support desk moves to the server; the two figures the browser could only guess at — the central store's ledger and a staff member's credit for the month — become server queries; the ticket's history and the OTP stop being theatre; the payer roster stops being a fixture; `UI/src/data/seed.ts` is deleted along with the test-only `signIn` hook, so nothing in production UI code imports `@rch/contract/fixtures` any more. Around that: a Playwright smoke that signs in as every role and walks the chain across two browser contexts, a load check that measures §12's p95 numbers instead of asserting them, alert rules in the chart, a runbook with a go-live checklist and an executable restore drill, a `values-prod.yaml` that is complete, and `docs/ua-spec.html` rewritten from the product that exists rather than the one that was pitched.

**Architecture:** Two new modules (`support`, `reports`) composing the platform Phases 1–5 built — `withTransaction` → `assertRule` → `allocateId` → `appendHistory` → `emitChanged` → `{ result, changed, message }` — plus edits to three that exist (`tickets`, `snapshot`, `pos`). Nothing here posts a stock move: the support desk is a conversation, and the two reports are reads. **No migration.** Every table Phase 6 needs (`support_tickets`, `support_messages`, `payers`, `document_history`, `stock_moves`) was created by Phase 1's first migration and no column moves, so the journal ends this phase where Phase 5 left it and no wave has to coordinate an idx. The one genuinely new *kind* of work is a fourth artefact alongside the three test levels the repo already has: a top-level `e2e/` workspace holding a Playwright smoke that drives a real browser against a real stack, and a dependency-free load script that reports p95 rather than pinning it.

**Tech Stack:** unchanged from Phases 1–5 — Node 24, pnpm 10, Turborepo 2, TypeScript ~6.0, Fastify 5, fastify-type-provider-zod 7, Zod 4, Drizzle 0.45 + drizzle-kit 0.31, pg 8, PostgreSQL 17, Vitest 4, tsup 8, Helm 3. **Exactly one new dependency, in exactly one task:** `@playwright/test` as a devDependency of the new `e2e` workspace (Task 8). The load check (Task 9) uses Node 24's global `fetch` and `node:perf_hooks` and adds nothing — `k6` is not installed and `autocannon` would have meant a second task editing `pnpm-lock.yaml` in the same wave.

**Spec:** `docs/superpowers/specs/2026-09-03-backend-design.md` — §5.1 (reuse rules), §6 (SSE, error shape), §7.2 (`support_tickets`, `support_messages`, `product_requests`, `payers`, `stock_moves`, `document_history`), §7.3 (`SUP-00n`), §8 (auth, §8.3 roles, §8.4 `/me`, §8.5 user management), §9.1 (reads), §9.2 (**every Phase 6 row**, quoted verbatim in the task that implements it), §9.3 (write responses), §10 (the store becomes an API client — the last in-memory paths and `data/seed.ts` go), §11 (deployment), §12 (**the production-readiness bar — every item is mapped to a task and an evidence line in "The §12 evidence map" below**), §13 (testing, including the Playwright smoke and the load script), §14 row 6, §16 (amendments from Phases 1–5 — **binding, do not reopen**).
**Ledgers:** `docs/superpowers/plans/2026-09-04-backend-phase-3-movement-chain-ledger.md`, `docs/superpowers/plans/2026-09-04-backend-phase-4-production-ledger.md`, `.superpowers/sdd/2026-09-04-backend-phase-5-procurement/progress.md`.

---

## Global Constraints

Every task's requirements implicitly include this section. Most of it is Phases 3–5's, carried forward because it is what keeps the server correct; the rest is this phase's own. Two bullets — the race-test shape and the "`buildTestApp` does not seed" rule — are here rather than in a task because a pre-flight scan found four Phase 6 tasks about to get one or both of them wrong.

- **Branch model:** work on `feat/phase-6-ops-go-live`, branched from `develop` once Phase 5 has landed there by fast-forward (if it has not, branch from `feat/phase-5-procurement` **head**); never push to `staging`/`production`. Worktree agents start with `git merge --ff-only feat/phase-6-ops-go-live`.
- **Conventions settled in Phases 1–5 (binding):** `apps/api` and `packages/*` relative imports carry `.js`; no constructor parameter properties (`erasableSyntaxOnly`); `strict` TS with `noUnusedLocals`/`noUnusedParameters`/`verbatimModuleSyntax`; type-only imports use `import type`. UI uses bundler resolution (no extensions). Every DB-backed test file calls `buildTestApp({ schema: "<unique>" })`; `withTestSchema` suffixes the schema with the pid, so parallel worktrees sharing one database do not drop each other's schema. Local Postgres is Docker on host port **5439**; Node 24 lives at `$(brew --prefix node@24)/bin`.
- **Every write is one transaction** (`withTransaction`), rules through `assertRule` carrying the operator-facing sentence, transitions through `assertTransition`, quantities through `round3`, ledger moves only through `postMoves`, balance locks only through `lockBalances`, ids only through `allocateId`/`allocateNumber`, history only through `appendHistory`, reservations only through `apps/api/src/lib/reservations.ts`. `scripts/check-boundaries.sh` enforces the protected tables — do not write them anywhere else. (`support_tickets`, `support_messages` and `payers` are **not** protected tables: each is written or read from its own module's `repo.ts`.)
- **Routes only through `mount(app, routes.<name>, handler)`**; every module is `routes.ts / service.ts / repo.ts / <name>.test.ts` (copy `apps/api/src/modules/_template/`). `GET /events` remains the one route outside the manifest; this phase adds none like it.
- **Write response shape (spec §9.3):** `{ result, changed, message }` — `changed` names snapshot collections to refetch. **Phase 6 adds no member to `CollectionSchema`:** `"tickets"` (the support collection) and `"tkt"` (the movement collection) are both already in it, and the four support writes name `["tickets"]` and nothing else. `message` is the toast sentence, moved **verbatim** from the store's current `notify()` text. Where a new sentence is unavoidable it is called out in the task's rules table as **NEW** and recorded in spec §16 by Task 11.
- **Refusals** are `RuleError` (422) with the sentence the store uses today; an unknown document is a `NotFoundError` (404) reading `There is no support ticket <id>.`; role gating is 404 (the module is absent for that role); ownership and location scoping are 403 through `ForbiddenError`/`requireLocOf`.
- **Lock order, server-wide: documents → ids → balances.** A write that needs more than one takes them in that sequence and never another. `apps/api/src/lib/ledger.ts`'s header records it, including Phase 5's refinement (the purchase-order row before any requisition row, requisition rows in ascending id order). **Phase 6 adds no new lock ordering and must not vary the one that is written down.** Every Phase 6 write takes exactly one document lock — its own support ticket's row, or its own movement ticket's row — and no balance lock at all.
- **Every status transition reads its own row `for update`.** A transition guard that reads without the lock is not a guard: two "Mark resolved" taps both see `With support`, both pass `canTransition`, and both write a history row.
- **A test that races two transactions warms the pool first.** `pg` opens connections lazily, so the second of two "concurrent" `withTransaction` calls waits ~5 ms for a socket and begins after the first has committed — the race never happens and the test passes with the lock removed. Call **`warmPool(app.testDb!, n)`** (`apps/api/src/test/db.ts`) before racing `n` transactions — that is the shape every existing race case in this repo uses, not `warmPool(t, n)` — and **prove each such test fails with the lock commented out before keeping it.** Two racing requests must also carry *different* idempotency keys, or the second is a replay rather than a race.
- **`buildTestApp` migrates; it does not seed.** Every DB-backed suite opens with `beforeAll(buildTestApp → app.ready())` and `beforeEach(truncateAll → seedTestDb)`, or `authHeaders` throws `no user u1 - did you seed?` on its first call. Copy the shape from `apps/api/src/modules/tickets/tickets.test.ts:15-17`. From Task 13 onward a suite may reset only the document half with `resetDocuments(db)` instead, seeding the master once per file in `beforeAll`.
- **Test builders are the only place default field values are written** (spec §5.1). `given.{request,ticket,shopAsk,bill,prodOrder,vendor,requisition,po,contract,productRequest}` already exist; Task 3 adds `given.supportTicket`. A suite that hand-builds a document instead of asking for one is rejected in review.
- **Assertions are relative to what the fixtures hold, not to a number typed into the test.** Read the list, act, then assert the difference, and pick the document to act on by filtering rather than by naming `SUP-0043`. The seed moves; a test that hard-codes its arithmetic breaks for a reason that has nothing to do with the code. Because `sequences` survives `truncateAll`, **never assert a literal allocated id** — match the shape (`/^SUP-00\d+$/`) and assert the *relative* step.
- **`emitChanged` is called inside the transaction**, last in the service, with the same array the response's `changed` carries. Postgres withholds a `pg_notify` until the transaction commits, so a refusal announces nothing. There is no after-commit hook — do not go looking for one (spec §16, Phase 3).
- **A writer locks only the cells it moves.** No Phase 6 write touches `stock_balances`, so the M12 phantom-row trap cannot fire here; the rule is restated because Task 6's stock-ledger query reads `stock_moves` and must not be tempted to "fix" a zero balance row it finds. A zero row means "this location carries the line" and is correct.
- **Never widen a status union with `string`.** `TicketStatus` (the support desk's five words) is closed and unchanged this phase; it gains a transition table, not a member. `TktStatus` and `ShopAskStatus` are unchanged in membership; `SHOP_ASK_TRANSITIONS` gains one **edge** (`Sent → Asked`), which is a table entry, not a union member, and needs no migration because the pg enum already holds `Asked`.
- **A widening is swept with a grep, not with a file list.** Phase 4's final review found `Cancelled` handled in the two screens its task named and missed in three it did not. When a phase changes what a field may contain, the sweep is `grep -rn` over **all of `UI/src`** for every place that reads it, and the task's Files block is corrected from what the grep finds. **This phase's two sweeps are `\.otp` and the fixtures import.** Run `grep -rn '\.otp\|<Otp' UI/src` and `grep -rn '@rch/contract/fixtures\|data/seed\|data/ops' UI/src` before claiming either file list is complete. As written, the first finds **eight** code sites and the second finds four; if the merged tree gives a different number, the tree wins.
- **Dates in the store are display strings, everywhere, and ISO on the wire.** `applySnapshot` renders every `at`, `eta`, `from` and `to` through `fromWireTime` / `fromWireDate`, and the two appliers Phase 6 adds do the same. A control that needs `<input type="date">` converts **at the edge**, through `toInputDate` / `fromInputDate` in `UI/src/lib/fmt.ts`. No applier and no store field is exempted.
- **Migrations are generated, never hand-numbered** — and **Phase 6 generates none.** The journal ends at `0006_rate_contracts_live_uq` (Phase 5) and must still read that at the end of this phase. If a task believes it needs a migration, it is wrong about the schema: re-read `apps/api/src/db/schema/ops.ts` and `master.ts` before writing one. (`support_tickets` has no index on `by_user`; the desk is tens of rows and that is recorded as accepted in §16, not fixed with a migration.)
- **Before dispatching a wave, the controller verifies the journal.** `apps/api/drizzle/meta/_journal.json`'s last entry must read `0006_rate_contracts_live_uq` at the start of every wave and at the end of the phase, and every worktree forks from the phase branch **head**, never from an older commit.
- **Every phase ends with its guides refreshed, in one commit with the spec §16 rows.** That is the root `CLAUDE.md`, the root `README.md`'s status-by-phase section, and the four nested guides — `apps/api/CLAUDE.md`, `packages/contract/CLAUDE.md`, `packages/domain/CLAUDE.md`, `UI/CLAUDE.md` — plus `UI/README.md`. A nested guide is what a fresh agent reads before touching that package, so it names what the package now holds and what rule it now enforces.
- **Every task ends green:** `pnpm turbo typecheck test && pnpm lint` (turbo lint + knip + `scripts/check-boundaries.sh`) at the repo root. Never leave a test asserting behaviour that moved — each task that deletes a UI rule test names the server test that replaces it, in the commit body. If turbo replays a stale green for you, re-run the gate with `--force`.
- **`scripts/check-boundaries.sh` greps for call shape**, including `update reservations` case-insensitively in raw SQL. Do not write a comment or a string containing a phrase like `insert into stock_moves` outside `lib/`, or the boundary script fails on prose. Task 6 reads `stock_moves` and must write `select … from stock_moves` only through Drizzle's query builder in `modules/reports/repo.ts`, never as raw SQL prose.
- **Commit messages:** imperative, sentence-case, no prefixes, and no mention of a task number, plus **exactly one trailer**:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

---

## Decisions this plan takes

Stated here so they are not reopened in a task body. Task 11 records each in spec §16.

1. **Who sees a support ticket: only the person who raised it, in every role.** `readSupportTickets` returns every ticket today and `scope()` filters it to `by === user.n` for a counter only, so a buyer currently reads a counter operator's ticket bodies. There is no admin or support role in the five (§8.3), and every §9.2 support write is already scoped "all (own)" — a list showing rows the caller cannot act on is a leak with no use behind it. `GET /support/tickets` and the snapshot's `tickets` slice therefore return the caller's own tickets for **every** role, keyed on `by_user = claims.sub` rather than on a display name. The Support screen's "Only mine" filter and its "Open across the hospital · all roles" KPI go with it (Task 10).
2. **Two reports become server queries; every other report and every dashboard stays in the browser.** The rule is the brief's: *a report that needs more than the caller's snapshot slice becomes a server query.* Applied item by item to `UI/src/roles/store/Reports.tsx`'s ten reports and all five dashboards, exactly two fail it:
   - **The central store stock ledger.** It reconstructs an opening balance as `closing − received + issued out` from GRNs and collected tickets. The snapshot carries no moves at all, so the arithmetic is a guess that a cancelled ticket or an adjustment silently breaks. → `GET /reports/stock-ledger?loc&days`, computed from `stock_moves`.
   - **Staff credit taken.** `Pos.tsx` sums the till's own 7-day, own-outlet bill list while the server settles the ceiling over the calendar month across every outlet (`monthStartIST`, `posRepo.staffCreditTaken`). The screen already prints an apology for the difference. → `GET /reports/credit/:kind/:id`.
   The other eight store reports (issue register, turnaround, reservation ageing, below-reorder, requisition status, stock ageing, movers, reserved-versus-available, handover discrepancies) and all five dashboards read only collections their own snapshot already holds in full, so they stay where they are. Moving them would buy nothing and cost five round trips per screen.
3. **The OTP is withheld from everyone but the collector.** `makeOtp` exists so the person collecting reads six digits aloud and the person handing over types them in — and the store's issue desk prints the number three inches from the box that verifies it (`IssueDetail.tsx:199`, `store/TicketDrawer.tsx:92`, `IssueDesk.tsx:246`), which makes the check theatre. From this phase the wire carries `otp` **only** when the ticket is `Issued` **and** the caller's location is the ticket's `to`; everyone else — the sending location, a manager, anyone after collection — reads `""`. The labelled supervisor override (handover with no OTP, allowed to `store` and `prod`, recorded in `document_history`) is untouched and is the answer when the collector cannot be reached. This is a product decision as much as a security one; Task 11 records it.
4. **The counter gets the door Phase 4 left it.** `POST /tickets/:id/cancel` already scopes on the ticket's own `from` through `requireLocOf`, so the only thing keeping an outlet from withdrawing a shop transfer or a granted shop ask is the route's `access: ["store", "prod"]`. It becomes `["store", "prod", "counter"]` and the service gains one linked-document branch: cancelling a `shop_ask` ticket puts the ask back to `Asked` and clears its grant, so the holding shop can answer again. `SHOP_ASK_TRANSITIONS` gains the edge `Sent: ["Asked"]`.
5. **Ticket history is surfaced.** `TicketSchema` gains `hist`, read from `document_history` like every other document's. The override row Phase 3 writes ("Handed over — supervisor override") and the cancellation row Phase 4 writes have been write-only since they were added; the drawers now show them.
6. **`document_history.status` stays free text — accepted, not fixed.** Rows already read `Handed over — supervisor override` and `Cancelled — Vendor cannot supply this week`, which is a status and a note in one column. Adding a `note` column means a migration plus a backfill of every existing row's suffix, for a field that is only ever rendered as a line of prose. Recorded in §16 as accepted with the trigger for revisiting it: the first consumer that needs to *filter* on status rather than print it.
7. **The payer roster comes from `payers`.** `PATIENTS` / `STAFF` / `DEPTS` are fixtures the browser imports directly while the server has validated the till's payer against the `payers` table since Phase 3. The snapshot gains `roster`, read from `payers` where `active`, and `data/master.ts` hydrates three mutable registries the way it already hydrates `IT` and `LOC`.
8. **If Phase 5's Task 10 left any ops-slice action in memory, Task 10 here cuts it over too — all six, not two.** Phase 5's plan puts `requestNewProduct`, `answerProductRequest`, `addContract`, `updateContract`, `removeContract` and `createItem` in its own Task 10's Produces block, so the expectation is that all six are API calls when this phase starts. At the time this plan was written they were not: on `feat/phase-5-procurement`'s head every one of them was still `=> void` with a local `set(...)` body, and `slug()` was still at `store/ops.ts:57`. Task 10 checks all six —
   ```bash
   grep -n 'requestNewProduct\|answerProductRequest\|addContract\|updateContract\|removeContract\|createItem' UI/src/store/ops.ts
   ```
   — and a body containing `set({` and no `call(` is still local. It converts any that are, with the same shape as the four support actions, and says which in its report. Every route they need already exists (`routes.createProductRequest`, `routes.answerProductRequest`, `routes.addContract`, `routes.updateContract`, `routes.removeContract`, `routes.createItem`), so this is a cutover, not new surface.
9. **Tests keep `@rch/contract/fixtures`; production UI code loses it.** §5.1 makes the fixtures the shared seed for the database, the API suites, the UI suites and the smoke — deleting them is not the goal. What goes is every path by which a *running browser* can see them: `UI/src/data/seed.ts` and `UI/src/data/ops.ts` are deleted, `UI/src/data/vendors.ts` loses its `seedVendors` re-export line and keeps its two helpers, the store's initial state becomes empty, and `signIn`/`signOut` — a test hook that reads `FX.USERS` from inside production code — are deleted. `UI/src/__tests__/fixture.ts` imports `@rch/contract/fixtures` directly and gains `as(role)` / `signedOut()` helpers that set the session the way `login()` leaves it.
10. **The Playwright smoke lives in a new top-level `e2e/` workspace** (spec §13 names `e2e/`), with its own `package.json`, `tsconfig.json` and `playwright.config.ts`, added to `pnpm-workspace.yaml` and to `knip.json`. Its script is `test:e2e`, **not** `test`, so `pnpm turbo typecheck test` — which has no running stack — never invokes it. Eight scenarios, one browser (chromium), fresh seed per run, driven by `E2E_BASE_URL`.
11. **The smoke runs in CI against the kind cluster, not against a second stack.** `deploy/chart/rch/ci/install-test.sh` already installs the chart, seeds, and port-forwards the UI and the API; the smoke is four lines at the end of it, behind `E2E=1` so a local run without browsers still passes. Locally it runs against `pnpm dev`.
12. **The load check runs locally, in the exit check, and not in CI.** §12's numbers are stated "on the staging instance"; a shared GitHub runner's p95 measures the runner. `apps/api/scripts/loadcheck.mjs` is a dependency-free Node script that logs in, hammers `GET /snapshot` and `POST /bills` at a chosen concurrency, prints p50/p95/p99 and a PASS/FAIL against §12's 150 ms and 200 ms, and exits non-zero on FAIL. Task 12 runs it and records the numbers **with the machine they were measured on**.
13. **Alerts ship as a `PrometheusRule` in the chart; a Grafana dashboard does not.** The five §12 alerts plus `sse_listener_up` become a rendered `PrometheusRule` gated by `serviceMonitor.enabled`, so the alert text lives beside the metric it reads and `render.test.sh` proves it renders. A dashboard JSON in a ConfigMap would be a large unversioned blob nothing in CI renders and nothing fails when it drifts; the runbook's PromQL is the durable artefact and Grafana is pointed at it by hand. Recorded in §16 as declined, with the reason.
14. **The first deploy is the user's decision.** Task 12 prepares everything — complete `values-prod.yaml`, a reviewed `deploy.yml`, a go-live checklist, the exact commands — and stops. Promotion to `staging` and `production` is a `git push` of a protected branch plus `DEPLOY_ENABLED=true` plus five AWS secrets, none of which this plan's executor has or should have. **No task in this plan pushes `staging` or `production`.**

---

## What Phase 6 does **not** build

- **A support agent's side of the desk.** `support_messages.from` has two values and only `"user"` is ever written by this application; the replies in the fixtures are seeded, not authored. There is no screen, no role and no §9.2 row for a support agent, and inventing one would mean a sixth role, a new module and an RBAC matrix nobody asked for. Support answers out of band and the rows arrive by seed or by hand. Task 11 parks it.
- **A migration of any kind.** See the Global Constraints. If the schema needs a change, the plan is wrong and the controller re-plans rather than a task improvising an `0007`.
- **`GET /documents/:type/:id/history`.** Ticket history is surfaced by adding `hist` to `TicketSchema` — the shape every other document already uses — not by adding the generic endpoint §9.1 lists. It is still the case that nothing needs to read a *third* document type's history on demand, and the generic route would have to answer for eleven document types and be scoped for each. Still deferred; §16 records it for the third time and names the trigger.
- **A quarantine ledger, a debit note or a way back out of quarantine.** Phase 5 declined it; nothing here changes that.
- **Shift close, wastage, batch-level MRP, FEFO issue or a credit note.** `docs/ua-spec.html` describes all five. They were never built and are not being built now — Task 11's rewrite moves them out of the acceptance table and into a named "not in this release" section rather than leaving twenty-four scenarios of which nine cannot pass.
- **Widening `LocKey`.** `StockLoc` is the reporting union and `LocKey` the acting one; the stock-ledger report takes a `StockLoc` (so quarantine can be reported on) and nothing else changes.
- **RDS itself, the EKS cluster, ECR, External Secrets Operator or DNS.** §11 assumes them. Task 7 makes the chart correct for them and Task 12 writes down what has to exist; creating them is the user's, in their AWS account.

---

## File structure (what Phase 6 adds or changes)

```
packages/contract/src/
  schemas/common.ts      + ALL_LOCS, OUTLETS, PAR_FACTOR move here from fixtures   (Task 1)
  schemas/documents.ts   TicketSchema gains hist; + PayerRosterSchema
  schemas/writes.ts      + 4 support body schemas
  schemas/snapshot.ts    SnapshotSchema gains roster; + SupportTicketsResponseSchema  (Task 1)
                         + StockLedger/Credit response schemas                        (Task 6)
  schemas/reports.ts     the two report shapes                                        (Task 6, new)
  routes.ts              + 4 support writes, + GET /support/tickets, cancelTicket      (Task 1)
                         + GET /reports/stock-ledger, GET /reports/credit/:kind/:id    (Task 6)
  routes.test.ts         + the write samples; + "every body refuses an unknown key"
  fixtures/master.ts     re-exports the three constants that moved
packages/domain/src/
  support.ts             SUPPORT_TRANSITIONS, statusAfterReply, mayRate, mayUserSet   (new)
  reports.ts             ledgerRow, ledgerTotals                                       (new)
  transitions.ts         + SHOP_ASK_TRANSITIONS gains `Sent: ["Asked"]`
  index.ts               the new exports
apps/api/src/
  test/builders.ts       + given.supportTicket
  modules/index.ts       + support, + reports
  modules/support/**     GET /support/tickets (Task 3); the four writes (Task 5)       (new)
  modules/reports/**     the two queries                                        (Task 3 stub, Task 6)
  modules/snapshot/**    roster reader; ticket hist; the withheld OTP; own-tickets      (Task 4)
  modules/tickets/**     the counter's cancel door; the shop-ask branch                 (Task 4)
  modules/pos/{repo,service}.ts  staffCreditTaken moves to lib/credit.ts                (Task 6)
  lib/credit.ts          the one credit-window query, two callers                 (Task 6, new)
UI/src/
  api/refetch.ts         + a narrow reader for "tickets"
  api/wire.ts            + applySupportTickets, hydrateRoster in applySnapshot
  data/master.ts         + PATIENTS/STAFF/DEPTS as registries, + hydrateRoster
  data/seed.ts           DELETED          ·  data/ops.ts  DELETED
  data/vendors.ts        loses its seedVendors re-export, keeps its two helpers
  store/index.ts         signIn/signOut deleted; initial state empty
  store/ops.ts           the four support actions become API calls
  pages/Support.tsx      own-tickets only; awaited writes; the FAQ's stale answer
  roles/store/{IssueDesk,IssueDetail,TicketDrawer}.tsx   the OTP goes
  roles/prod/Tickets.tsx · roles/manager/ItemsStock.tsx  likewise
  roles/counter/{TicketDrawer,Tickets}.tsx  the cancel button; the OTP stays (they collect)
  roles/counter/Pos.tsx  credit from GET /reports/credit
  roles/store/Reports.tsx  the ledger report from GET /reports/stock-ledger
  __tests__/fixture.ts   as() / signedOut(); fixtures imported directly
  __tests__/*            app, screens, theme, writes, store, events updated
e2e/                     package.json, tsconfig.json, playwright.config.ts,
                         tests/*.spec.ts, fixtures/session.ts                          (new)
apps/api/scripts/loadcheck.mjs                                                          (new)
apps/api/src/db/seed.ts        + seedDocuments(tx)                              (Task 13)
apps/api/src/test/db.ts        + resetDocuments(db)                             (Task 13)
apps/api/src/modules/grn/**    the id comes from @rch/domain's grnId            (Task 13)
packages/domain/src/ids.ts     + grnId(poId, n)                                 (Task 13)
packages/{domain,contract}/vitest.config.ts   TZ=UTC, like apps/api and UI      (Task 13)
deploy/chart/rch/templates/prometheusrule.yaml                                          (new)
deploy/chart/rch/{values,values-prod,values-staging}.yaml · tests/render.test.sh
deploy/chart/rch/ci/install-test.sh · .github/workflows/{ci,deploy}.yml
deploy/RUNBOOK.md · docs/ua-spec.html · docs/system-design.html · docs/user-flows.html
CLAUDE.md · README.md · UI/README.md · apps/api/CLAUDE.md · packages/*/CLAUDE.md · UI/CLAUDE.md
pnpm-workspace.yaml · knip.json · package.json · turbo.json
```

---

### Task 1: Contract — the support desk on the wire, the ticket's history, the roster

*(Wave 1, alongside Tasks 2 and 3. It owns `packages/contract/**` and nothing else. Task 2 owns `packages/domain/**`; Task 3 owns `apps/api/**`. No file is shared.)*

**Scope note — the reads it may declare, and the one it may not.** `apps/api/src/contract.test.ts` probes **every param-less GET in the manifest** and asserts a 200 that parses against its own response schema (Phase 2 removed its skip-on-404 branch on purpose), so a GET declared before its handler exists turns the API suite red **in the same wave**. This task declares `GET /support/tickets` because Task 3 mounts a working handler for it in this same wave. It does **not** declare `GET /reports/stock-ledger` (also param-less): Task 6 declares that one in the same commit as the query that answers it. Write routes are inert until a module mounts them, so all four support writes land here.

**Files:**
- Modify: `packages/contract/src/schemas/common.ts`, `packages/contract/src/schemas/documents.ts`, `packages/contract/src/schemas/writes.ts`, `packages/contract/src/schemas/snapshot.ts`, `packages/contract/src/routes.ts`, `packages/contract/src/routes.test.ts`, `packages/contract/src/types.ts`, `packages/contract/src/index.ts`, `packages/contract/src/fixtures/master.ts`

**Interfaces:**
- Consumes: `DocIdParamsSchema`, `writeResponse`, `LocKeySchema`, `PayerSchema`, `HistEntrySchema`, `SupportTicketSchema`, `TicketStatusSchema`, `TicketTopicSchema`, `TicketPrioritySchema` (all already exported).
- Produces (imported by Tasks 3, 4, 5, 6, 8 and 10):
  ```ts
  // packages/contract/src/schemas/common.ts — three constants stop being fixtures
  /** The five places an operator works, in sidebar order. A deployment fact, not demo data:
   *  `LocKeySchema` already enumerates them and the two lists must not be able to disagree.
   *  Typed `LocKey[]`, not `readonly [...]`: six call sites do `OUTLETS.includes(l)` with a
   *  `LocKey`, which a narrowed tuple type refuses. */
  export const ALL_LOCS: LocKey[] = [...LocKeySchema.options];
  /** The three that sell. */
  export const OUTLETS: LocKey[] = ["rest", "coffee", "kiosk"];
  /** How much of a location's average daily issue a par level is meant to cover, per location.
   *  A `Record<LocKey, number>` and NOT a scalar — `parOf` in `UI/src/lib/selectors.ts` reads
   *  `PAR_FACTOR[l] ?? 1`, and collapsing it to one number silently rewrites every par level in
   *  the system. Copy the object out of `fixtures/master.ts` verbatim. */
  export const PAR_FACTOR: Record<LocKey, number> = { store: 1, kitchen: 0.35, rest: 0.22, coffee: 0.18, kiosk: 0.15 };

  // packages/contract/src/schemas/documents.ts
  /** A movement ticket now carries its own trail, like every other document: the issue, the
   *  handover (including "Handed over — supervisor override"), the receipt, the cancellation. */
  export const TicketSchema = z.object({ /* …as today… */ hist: z.array(HistEntrySchema) });
  /** Who a bill may be charged to, from the `payers` table rather than from a fixture. */
  export const PayerRosterSchema = z.strictObject({
    patients: z.array(PayerSchema), staff: z.array(PayerSchema), depts: z.array(PayerSchema),
  });

  // packages/contract/src/schemas/writes.ts
  export const RaiseTicketBodySchema, ReplyToTicketBodySchema, SetTicketStatusBodySchema, RateTicketBodySchema;

  // packages/contract/src/schemas/snapshot.ts
  export const SupportTicketsResponseSchema = z.array(D.SupportTicketSchema);
  // SnapshotSchema.shape.roster : PayerRosterSchema

  // packages/contract/src/types.ts
  export type PayerRoster = z.infer<typeof D.PayerRosterSchema>;

  // packages/contract/src/routes.ts — five new entries, one widened
  routes.raiseTicket      POST   /support/tickets              access "any"
  routes.replyToTicket    POST   /support/tickets/:id/messages access "any"
  routes.setTicketStatus  POST   /support/tickets/:id/status   access "any"
  routes.rateTicket       POST   /support/tickets/:id/rating   access "any"
  routes.tickets          GET    /support/tickets              access "any"
  routes.cancelTicket     access ["store", "prod"] -> ["store", "prod", "counter"]
  ```

**Why `ALL_LOCS`, `OUTLETS` and `PAR_FACTOR` move.** They sit in `packages/contract/src/fixtures/master.ts`, which makes them demo data. Task 10 deletes every path by which production UI code reaches the fixtures, and these three are imported by `UI/src/data/master.ts` for the screens — so either they move or the deletion cannot happen, and Task 10's own proof (`grep -rn '@rch/contract/fixtures' UI/src | grep -v __tests__` must print nothing) is what forces the choice. They are the same argument §16 already recorded for `STAFF_CREDIT_LIMIT` and Phase 5 recorded for `PO_APPROVAL_LIMIT`: a number a rule or a layout reads, not a row of seed. `fixtures/master.ts` re-exports all three exactly as it already re-exports `STAFF_CREDIT_LIMIT`, so no existing import line anywhere changes.

**`PAR_FACTOR` moves with its shape, and that is the whole risk in this step.** At HEAD it is `Record<LocKey, number>` — `{ store: 1, kitchen: 0.35, rest: 0.22, coffee: 0.18, kiosk: 0.15 }` (`packages/contract/src/fixtures/master.ts:71`) — read as `PAR_FACTOR[l] ?? 1` by `parOf` (`UI/src/lib/selectors.ts:45`). Copy the object; do not "simplify" it to a scalar. A scalar typechecks (indexing a `number` with a string is an error, so actually it does not — but a `3` typed as `Record<LocKey, number>` would), reads plausibly, and changes every par level and therefore every below-reorder suggestion in the system. `ALL_LOCS` and `OUTLETS` likewise keep the element type `LocKey`, not a narrowed tuple: `OUTLETS.includes(l)` is called with a `LocKey` at `roles/manager/{Dashboard,Prices,ItemsStock,Availability}.tsx` and a `readonly ["rest","coffee","kiosk"]` refuses it.

**Why the support GET is called `tickets`.** `packages/contract/src/routes.ts` already says so, in a comment written in Phase 3: *"`ticketsList` rather than `tickets`, because `tickets` is the support-ticket collection and will be the Phase 6 route name — two manifest keys must not collide."* Honour it: the movement collection stays `ticketsList`, the support collection is `tickets`, and both match the `CollectionSchema` members (`"tkt"`, `"tickets"`) that `changed` and `refetch` key on.

- [ ] **Step 1: Write the failing contract tests**

`packages/contract/src/routes.test.ts` already fails the "every route that takes a body has a sample here" case the moment a new body route appears. **Add these entries to the existing `SAMPLES` object and leave every entry already there exactly as you find it** (that file is maintained alongside the Phase 2–5 routes and its values may have moved since this plan was written):

```ts
  raiseTicket:     { topic: "A number looks wrong", subject: "Cash collected shows zero all morning",
                     body: "Sales is climbing but cash collected has not moved since I opened.",
                     priority: "Urgent", screen: "Dashboard" },
  replyToTicket:   { body: "Refreshed and it reads correctly now — thank you." },
  setTicketStatus: { st: "Resolved" },
  rateTicket:      { rating: 5 },
```

**Do not add a whole-manifest unknown-key loop.** `packages/contract/src/routes.test.ts:52-62` already runs `` `${name} accepts its own shape and refuses an unknown key` `` over every manifest body, and its completeness case above it fails the moment a body route arrives with no sample. The four `SAMPLES` entries you just added are therefore the whole of this task's coverage for §12's *"Every route has a Zod schema for params, query and body; unknown keys rejected"* — a second identical `describe` would be duplicated logic and would make the evidence map cite new coverage that is not new.

Add two cases at the bottom of the file — both about the support desk specifically, neither a re-run of the loop above:

```ts
describe("what the support desk puts on the wire", () => {
  it("takes a ticket with an empty body — the first message is optional, the subject is not", () => {
    const base = { topic: "Something else", subject: "s", priority: "Low", screen: "Dashboard" } as const;
    expect(RaiseTicketBodySchema.safeParse({ ...base, body: "" }).success).toBe(true);
    // An empty subject is a service rule, not a schema rule: the operator reads the store's own
    // sentence ("Give the ticket a subject so support knows what it is about"), not a 400.
    expect(RaiseTicketBodySchema.safeParse({ ...base, subject: "", body: "" }).success).toBe(true);
    expect(RaiseTicketBodySchema.safeParse({ ...base, body: "", topic: "Kitchen fire" }).success).toBe(false);
  });

  it("takes only the five words a ticket can be in, and only the five ratings", () => {
    expect(SetTicketStatusBodySchema.safeParse({ st: "Closed" }).success).toBe(true);
    // "Waiting on you" is a real status but never one a user may set; the service refuses it
    // with a sentence, so the schema still accepts it. What the schema refuses is a non-status.
    expect(SetTicketStatusBodySchema.safeParse({ st: "Waiting on you" }).success).toBe(true);
    expect(SetTicketStatusBodySchema.safeParse({ st: "Done" }).success).toBe(false);
    expect(RateTicketBodySchema.safeParse({ rating: 3 }).success).toBe(true);
    expect(RateTicketBodySchema.safeParse({ rating: 0 }).success).toBe(false);
    expect(RateTicketBodySchema.safeParse({ rating: 6 }).success).toBe(false);
    expect(RateTicketBodySchema.safeParse({ rating: 4.5 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rch/contract test`
Expected: FAIL — `RaiseTicketBodySchema` and its three siblings are not exported, and `routes.test.ts`'s existing completeness case fails on four routes with no sample.

- [ ] **Step 3: Move the three constants, and widen the two document schemas**

In `packages/contract/src/schemas/common.ts`, below `StockLocSchema`:

```ts
/** The five places an operator works, in the order the sidebar and every stock screen list them.
 *  Spread out of `LocKeySchema` rather than typed out again, so the two can never disagree — and
 *  kept as `LocKey[]` rather than the schema's `readonly` tuple, because the call sites do
 *  `ALL_LOCS.includes(l)` with a `LocKey` and a narrowed tuple type refuses that. */
export const ALL_LOCS: LocKey[] = [...LocKeySchema.options];
/** The three that sell. `sales`'s columns are these, in this order (readers/documents.ts). */
export const OUTLETS: LocKey[] = ["rest", "coffee", "kiosk"];
/** How much of a location's average daily issue one par level covers, per location — read as
 *  `PAR_FACTOR[l] ?? 1` by `parOf` in `UI/src/lib/selectors.ts`. It is a record, not a number:
 *  the central store carries a day, an outlet a fifth of one. */
export const PAR_FACTOR: Record<LocKey, number> = { store: 1, kitchen: 0.35, rest: 0.22, coffee: 0.18, kiosk: 0.15 };
```

`LocKey` is `z.infer<typeof LocKeySchema>` and lives in `types.ts`, which imports from here — so declare the three with a local `type LocKey = z.infer<typeof LocKeySchema>;` above them rather than importing `types.js` and creating a cycle. Check how `STAFF_CREDIT_LIMIT`'s neighbours in this file already handle it before writing the line.

In `packages/contract/src/fixtures/master.ts`, delete the three local declarations and re-export them. **Keep the file's existing two commented re-export lines exactly as they are and add a third** — each of those comments explains *why* a particular constant is not a fixture, and collapsing them into one line throws both away:

```ts
/** Not fixtures: the shape of the deployment and the tuning of a par level. `ALL_LOCS` is
 *  `LocKeySchema`'s own list, `OUTLETS` the three that sell, and `PAR_FACTOR` the per-location
 *  cover a reorder suggestion is worked out against. Re-exported so `UI/src/data/master.ts`
 *  keeps its single import and no screen's import line moves. */
export { ALL_LOCS, OUTLETS, PAR_FACTOR } from "../schemas/common.js";
```

In `packages/contract/src/schemas/documents.ts`, add `hist` to `TicketSchema` and declare the roster:

```ts
export const TicketSchema = z.object({
  id: z.string(), req: z.string(), from: LocKeySchema, to: LocKeySchema,
  lines: z.array(TktLineSchema), st: TktStatusSchema,
  /** Six digits quoted at handover in place of a scanned code — and empty for everyone but the
   *  collector: the wire carries it only while the ticket is `Issued` and only to a caller at
   *  the ticket's `to`. Printing it beside the box that verifies it made the check theatre. */
  otp: z.string(),
  /** Issued, handed over (including a supervisor override), received, withdrawn. */
  hist: z.array(HistEntrySchema),
});

/** Who a bill may be charged to. Served from the `payers` table, not from a fixture: the till
 *  has validated its payer against that table since Phase 3 and the two lists must be one. */
export const PayerRosterSchema = z.strictObject({
  patients: z.array(PayerSchema), staff: z.array(PayerSchema), depts: z.array(PayerSchema),
});
```

`PayerSchema` is declared later in that file than `TicketSchema`; put `PayerRosterSchema` immediately after `PayerSchema`, not next to `TicketSchema`, or the module reference is used before it is initialised.

- [ ] **Step 4: Declare the four bodies**

In `packages/contract/src/schemas/writes.ts`, after the last Phase 5 body:

```ts
// ---- The support desk (spec §9.2). Customer care for the portal itself: every role raises,
// replies to, resolves and rates its own tickets, and nothing here moves stock.
export const RaiseTicketBodySchema = z.strictObject({
  topic: TicketTopicSchema,
  // Non-empty is a service rule, so an empty subject reaches the operator as the store's own
  // sentence rather than a 400 with a Zod path in it. The cap is what a subject line can be.
  subject: z.string().max(200),
  body: z.string().max(4000),
  priority: TicketPrioritySchema,
  screen: z.string().max(60),
});
export const ReplyToTicketBodySchema = z.strictObject({ body: z.string().max(4000) });
/** The schema takes any of the five words; which of them a *user* may choose is the service's
 *  rule (§9.2: "user may set Resolved/Closed only"), because that is a sentence, not a 400. */
export const SetTicketStatusBodySchema = z.strictObject({ st: TicketStatusSchema });
export const RateTicketBodySchema = z.strictObject({ rating: z.number().int().min(1).max(5) });
```

Import `TicketTopicSchema`, `TicketPrioritySchema` and `TicketStatusSchema` from `./documents.js` at the top of the file if they are not already imported there.

- [ ] **Step 5: Add `roster` to the snapshot and the narrow read**

In `packages/contract/src/schemas/snapshot.ts`, add to `SnapshotSchema` (after `users`, which it belongs beside — both are directories of people):

```ts
  roster: D.PayerRosterSchema,
```

and at the bottom, beside the other narrow responses:

```ts
/** The caller's own support tickets. Every role sees only what it raised — there is no support
 *  role among the five, so a list of other people's tickets would be rows nobody can act on. */
export const SupportTicketsResponseSchema = z.array(D.SupportTicketSchema);
```

In `packages/contract/src/types.ts`, add `export type PayerRoster = z.infer<typeof D.PayerRosterSchema>;` beside the other document aliases.

- [ ] **Step 6: Add the five routes and widen the sixth**

In `packages/contract/src/routes.ts`, after the buying GETs:

```ts
  // ---- The support desk (spec §9.2, Phase 6). Every role, own tickets only: `access: "any"`
  // opens the module to all five, and the service scopes each row on `by_user = claims.sub`.
  // A ticket somebody else raised is a 404, not a 403 — the same shape as a role's missing module.
  raiseTicket:     defineRoute({ method: "POST", path: "/support/tickets",              access: "any", body: RaiseTicketBodySchema,     response: writeResponse(SupportTicketSchema) }),
  replyToTicket:   defineRoute({ method: "POST", path: "/support/tickets/:id/messages", access: "any", params: DocIdParamsSchema, body: ReplyToTicketBodySchema,   response: writeResponse(SupportTicketSchema) }),
  setTicketStatus: defineRoute({ method: "POST", path: "/support/tickets/:id/status",   access: "any", params: DocIdParamsSchema, body: SetTicketStatusBodySchema, response: writeResponse(SupportTicketSchema) }),
  rateTicket:      defineRoute({ method: "POST", path: "/support/tickets/:id/rating",   access: "any", params: DocIdParamsSchema, body: RateTicketBodySchema,      response: writeResponse(SupportTicketSchema) }),
  // `tickets`, not `supportTickets`: the name was reserved for this route when `ticketsList`
  // was named, so the manifest key matches the `changed` collection the writes above name.
  tickets:         defineRoute({ method: "GET",  path: "/support/tickets",              access: "any", response: SupportTicketsResponseSchema }),
```

And change the existing `cancelTicket` entry's access, replacing its comment:

```ts
  // The store cancels the store's tickets, the kitchen the kitchen's, and — from Phase 6 — an
  // outlet its own: a shop transfer and a granted shop ask both leave from an outlet, and until
  // now `requireLocOf` on the ticket's `from` put them out of everyone's reach rather than into
  // the counter's. The scoping is unchanged; only the door is wider.
  cancelTicket:   defineRoute({ method: "POST", path: "/tickets/:id/cancel",     access: ["store", "prod", "counter"],  params: DocIdParamsSchema, body: CancelTicketBodySchema,   response: writeResponse(TicketSchema) }),
```

Add `RaiseTicketBodySchema, RateTicketBodySchema, ReplyToTicketBodySchema, SetTicketStatusBodySchema` to the `./schemas/writes.js` import, `SupportTicketSchema` to the `./schemas/documents.js` import, and `SupportTicketsResponseSchema` to the `./schemas/snapshot.js` import. Read `packages/contract/src/index.ts`: it re-exports whole schema modules, so `PayerRosterSchema` is already reachable and nothing there changes — confirm that rather than assuming it, and if the file turns out to list names individually, add `PayerRosterSchema` and say so in the report (`src/index.ts` is in this task's Files either way).

- [ ] **Step 7: Run the whole contract suite**

Run: `pnpm --filter @rch/contract test && pnpm --filter @rch/contract typecheck`
Expected: PASS. `packages/contract/src/fixtures/fixtures.test.ts` may fail if it asserts against a locally-declared `ALL_LOCS`; the re-export makes the value identical, so any failure there is an import that needs re-pointing, not a value that changed.

- [ ] **Step 8: Prove the repo still typechecks, and expect two known reds**

Run: `pnpm turbo typecheck --force`
Expected: **`@rch/contract` and `@rch/domain` PASS; `@rch/api` and `@rch/ui` FAIL**, both on the same thing — `TicketSchema` now requires `hist`, so every place that builds a `Ticket` object without one is a type error. That is the point of doing it in wave 1: Task 3 fixes `apps/api`'s builders and readers in this same wave, and Task 10 fixes `UI`'s in wave 3. **Do not chase either red from this task** and do not add `hist?:` to make it go away — an optional history is a history half the screens will forget to render.

Record the exact failing files in the commit body so Tasks 3, 4 and 10 inherit the list rather than rediscovering it:

```bash
pnpm turbo typecheck --force 2>&1 | grep -E "error TS" | cut -d'(' -f1 | sort -u
```

- [ ] **Step 9: Commit**

```bash
git add packages/contract
git commit -m "$(cat <<'EOF'
Declare the support desk, the ticket's trail and the payer roster on the wire

Four writes and one read for customer care, all `access: "any"` and all scoped to the caller's
own tickets in the service — there is no support role among the five, so a list of somebody
else's tickets would be rows nobody can act on.

A movement ticket now carries `hist` like every other document. The handover's supervisor
override and Phase 4's cancellation have been writing history rows nothing could read since
they were added; this is the shape that lets a drawer show them. It is a required field, not
an optional one, so the compiler names every builder and reader that has to fill it — two of
which are in this wave's other tasks and one in wave 3.

The snapshot gains `roster`, and ALL_LOCS, OUTLETS and PAR_FACTOR stop being fixtures: they are
a deployment's shape and a layout's constant, and Phase 6 deletes every path by which a running
browser can reach the fixture module at all.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Domain — the support desk's rules, the ledger row, and one shop-ask edge

*(Wave 1, alongside Tasks 1 and 3. It owns `packages/domain/**` and nothing else. It deliberately does **not** import anything Task 1 adds, so neither worktree waits on the other.)*

**Files:**
- Create: `packages/domain/src/support.ts`, `packages/domain/src/support.test.ts`, `packages/domain/src/reports.ts`, `packages/domain/src/reports.test.ts`
- Modify: `packages/domain/src/transitions.ts`, `packages/domain/src/transitions.test.ts`, `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: `TicketStatus`, `ShopAskStatus` (types, from `@rch/contract`); `TransitionTable`, `canTransition` (already in `transitions.ts`); `round3` (from `./round.js`).
- Produces (imported by Tasks 4, 5, 6 and 10):
  ```ts
  // packages/domain/src/support.ts
  export const SUPPORT_TRANSITIONS: TransitionTable<TicketStatus>;
  /** Which of the five a person at a screen may choose. §9.2: "user may set Resolved/Closed only". */
  export const mayUserSet: (st: TicketStatus) => boolean;
  /** What a reply from the user does to the ticket's status. §9.2: "Waiting on you / Resolved
   *  -> With support"; anything else is left alone. */
  export const statusAfterReply: (st: TicketStatus) => TicketStatus;
  /** §9.2: a rating is only meaningful once the desk says it is done. */
  export const mayRate: (st: TicketStatus) => boolean;

  // packages/domain/src/reports.ts
  export interface LedgerRow { it: string; opening: number; recd: number; issued: number; closing: number }
  /** One item's line of the stock ledger, from the signed moves either side of the window's start.
   *  `closing` is derived, never passed in: opening + received - issued, and nothing else. */
  export const ledgerRow: (it: string, before: number, inWindow: readonly number[]) => LedgerRow;
  /** The column totals a report foot prints. */
  export const ledgerTotals: (rows: readonly LedgerRow[]) => Omit<LedgerRow, "it">;
  ```

**Why the ledger arithmetic is domain and not SQL.** The server computes the row from `stock_moves` and the browser prints it; §5.1 says the rule is written once. What is SQL is *which* moves — `at < from` versus `at >= from` — and that stays in `modules/reports/repo.ts`. What is a rule is that `closing = opening + received − issued` with `round3` applied at every step and no fourth term, and that a report whose closing column disagrees with `stock_balances` is a defect. One function, two consumers, one place to change if a move kind is ever added.

- [ ] **Step 1: Write the failing tests**

`packages/domain/src/support.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TicketStatus } from "@rch/contract";
import { canTransition, mayRate, mayUserSet, statusAfterReply, SUPPORT_TRANSITIONS } from "./index.js";

const ALL: TicketStatus[] = ["Open", "With support", "Waiting on you", "Resolved", "Closed"];

describe("what a person at a screen may do to their own ticket", () => {
  it("lets them resolve and close it, and nothing else", () => {
    expect(ALL.filter(mayUserSet)).toEqual(["Resolved", "Closed"]);
  });

  it("puts a reply back with support when the desk was waiting on them, or had called it done", () => {
    expect(statusAfterReply("Waiting on you")).toBe("With support");
    expect(statusAfterReply("Resolved")).toBe("With support");
    // A ticket already with support, or newly opened, is not moved by a second message.
    expect(statusAfterReply("With support")).toBe("With support");
    expect(statusAfterReply("Open")).toBe("Open");
    // Closed is closed: replying to it is refused by the service, so the table never sees it.
    expect(statusAfterReply("Closed")).toBe("Closed");
  });

  it("takes a rating only once the desk says it is done", () => {
    expect(ALL.filter(mayRate)).toEqual(["Resolved", "Closed"]);
  });
});

describe("the support desk's transition table", () => {
  it("lets a resolved ticket be reopened and a closed one stay closed", () => {
    expect(canTransition(SUPPORT_TRANSITIONS, "Resolved", "With support")).toBe(true);
    expect(canTransition(SUPPORT_TRANSITIONS, "Resolved", "Closed")).toBe(true);
    expect(canTransition(SUPPORT_TRANSITIONS, "Closed", "With support")).toBe(false);
    expect(canTransition(SUPPORT_TRANSITIONS, "Closed", "Resolved")).toBe(false);
  });

  it("names every status exactly once, so a new word cannot be added without an edge", () => {
    expect(Object.keys(SUPPORT_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });
});
```

`packages/domain/src/reports.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ledgerRow, ledgerTotals } from "./index.js";

describe("one line of the central store's stock ledger", () => {
  it("splits the window's signed moves into received and issued, and derives the close", () => {
    const r = ledgerRow("milk", 40, [37, -12, 3, -0.5]);
    expect(r).toEqual({ it: "milk", opening: 40, recd: 40, issued: 12.5, closing: 67.5 });
  });

  it("carries three decimals and no float dust", () => {
    // 0.1 + 0.2 is the reason round3 exists; a ledger that prints 0.30000000000000004 is a bug
    // an operator reports as "the report is broken", which is worse than being wrong by a gram.
    expect(ledgerRow("sugar", 0, [0.1, 0.2]).closing).toBe(0.3);
  });

  it("opens at whatever the moves before the window sum to, including nothing", () => {
    expect(ledgerRow("bread", 0, []).closing).toBe(0);
    expect(ledgerRow("bread", 0, [])).toEqual({ it: "bread", opening: 0, recd: 0, issued: 0, closing: 0 });
  });

  it("totals the columns for the foot", () => {
    const rows = [ledgerRow("a", 1, [2, -1]), ledgerRow("b", 10, [-4])];
    expect(ledgerTotals(rows)).toEqual({ opening: 11, recd: 2, issued: 5, closing: 8 });
  });
});
```

Add to `packages/domain/src/transitions.test.ts`:

```ts
it("lets a withdrawn grant put the ask back on the shop's desk", () => {
  // Phase 6 gives the counter a cancel door. Withdrawing the ticket a grant raised has to leave
  // the ask somewhere the holding shop can answer it again — Sent with a cancelled ticket behind
  // it would be a lie on both screens.
  expect(canTransition(SHOP_ASK_TRANSITIONS, "Sent", "Asked")).toBe(true);
  expect(canTransition(SHOP_ASK_TRANSITIONS, "Declined", "Asked")).toBe(false);
  expect(canTransition(SHOP_ASK_TRANSITIONS, "Sent", "Declined")).toBe(false);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rch/domain test`
Expected: FAIL — `./support.js` and `./reports.js` do not exist, and `SHOP_ASK_TRANSITIONS.Sent` is `[]`.

- [ ] **Step 3: Write `support.ts`**

```ts
import type { TicketStatus } from "@rch/contract";
import type { TransitionTable } from "./transitions.js";

/**
 * Customer care for the portal, as five words. Spec §5.1: one table, two consumers — the server
 * refuses anything not listed and the drawer reads the same table to decide which button to draw.
 *
 * There is no support agent in this application (§8.3 has five roles and none of them answers
 * tickets), so every edge here is one a *user* can take, plus the two the seeded desk's replies
 * arrive on. `Open -> With support` is what a first reply from the desk does; the app itself
 * only ever walks the user's edges.
 */
export const SUPPORT_TRANSITIONS: TransitionTable<TicketStatus> = {
  Open: ["With support", "Waiting on you", "Resolved", "Closed"],
  "With support": ["Waiting on you", "Resolved", "Closed"],
  "Waiting on you": ["With support", "Resolved", "Closed"],
  // Reopening is the whole point of showing a rating box: the fix did not land, say so.
  Resolved: ["With support", "Closed"],
  // Closed is the end. A new problem is a new ticket, which is also how the desk counts them.
  Closed: [],
};

/** Spec §9.2, `setTicketStatus`: "user may set Resolved/Closed only". The other three are the
 *  desk's words about its own queue, not the reporter's. */
export const mayUserSet = (st: TicketStatus): boolean => st === "Resolved" || st === "Closed";

/** Spec §9.2, `replyToTicket`: "status Waiting on you / Resolved -> With support". A reply to a
 *  ticket that is already with support, or still Open, says something without moving anything. */
export const statusAfterReply = (st: TicketStatus): TicketStatus =>
  st === "Waiting on you" || st === "Resolved" ? "With support" : st;

/** Spec §9.2, `rateTicket`: "1-5; ticket Resolved or Closed". Rating an open ticket rates a
 *  guess at how it will go. */
export const mayRate = (st: TicketStatus): boolean => st === "Resolved" || st === "Closed";
```

- [ ] **Step 4: Write `reports.ts`**

```ts
import { round3 } from "./round.js";

/** One item's line of a location's stock ledger over a window. */
export interface LedgerRow { it: string; opening: number; recd: number; issued: number; closing: number }

/**
 * The ledger's one piece of arithmetic, written once because the server computes it and the
 * browser prints it (spec §5.1).
 *
 * `before` is the sum of every signed move at this location before the window opened — the true
 * opening balance, not a figure worked backwards from today's closing through receipts and
 * issues, which is what the browser had to do when it held no moves and what a cancelled ticket
 * or an adjustment quietly broke. `inWindow` is the window's signed moves: positive is received,
 * negative is issued, and there is no third kind because the ledger has none.
 */
export const ledgerRow = (it: string, before: number, inWindow: readonly number[]): LedgerRow => {
  const recd = round3(inWindow.reduce((t, q) => (q > 0 ? t + q : t), 0));
  const issued = round3(inWindow.reduce((t, q) => (q < 0 ? t - q : t), 0));
  const opening = round3(before);
  return { it, opening, recd, issued, closing: round3(opening + recd - issued) };
};

/** The column totals a report foot prints. */
export const ledgerTotals = (rows: readonly LedgerRow[]): Omit<LedgerRow, "it"> => ({
  opening: round3(rows.reduce((t, r) => t + r.opening, 0)),
  recd: round3(rows.reduce((t, r) => t + r.recd, 0)),
  issued: round3(rows.reduce((t, r) => t + r.issued, 0)),
  closing: round3(rows.reduce((t, r) => t + r.closing, 0)),
});
```

- [ ] **Step 5: Add the shop-ask edge and the exports**

In `packages/domain/src/transitions.ts`:

```ts
export const SHOP_ASK_TRANSITIONS: TransitionTable<ShopAskStatus> = {
  Asked: ["Sent", "Declined"],
  // Withdrawing the ticket a grant raised is the one way back. The holding shop granted, changed
  // its mind before anyone collected, and cancelled the ticket; leaving the ask at Sent would
  // show the asking shop stock that is coming and the holding shop a document it has undone.
  Sent: ["Asked"],
  Declined: [],
};
```

In `packages/domain/src/index.ts`, add two **named** re-export lines in the file's own style. It has no `export *` anywhere, and `packages/domain/CLAUDE.md` requires every export be reachable from the index *and* have a caller — a star export hides which of the two it is:

```ts
export { SUPPORT_TRANSITIONS, mayUserSet, statusAfterReply, mayRate } from "./support.js";
export { ledgerRow, ledgerTotals, type LedgerRow } from "./reports.js";
```

- [ ] **Step 6: Run the suite**

Run: `pnpm --filter @rch/domain test && pnpm --filter @rch/domain typecheck && pnpm --filter @rch/domain lint`
Expected: PASS.

**Note for the controller:** `knip` may report `ledgerTotals`, `SUPPORT_TRANSITIONS` or `mayRate` as unused exports until their consumers land in wave 2 (Tasks 5 and 6) and wave 3 (Task 10). Phase 5 hit the same thing with `prqStatus` and accepted it for one wave. Run `pnpm lint` and, if knip is the only failure and its complaints are exactly these names, record it in the task report and merge; do **not** delete an export the plan says a later task imports.

- [ ] **Step 7: Commit**

```bash
git add packages/domain
git commit -m "$(cat <<'EOF'
Write the support desk's rules and the ledger's arithmetic where both sides can read them

Five words, one transition table, three predicates: who may resolve, what a reply does, when a
rating means anything. The server will refuse from this table and the drawer will draw its
buttons from it, so a button the server refuses cannot be rendered.

The stock ledger's opening balance stops being worked backwards. `ledgerRow` takes the sum of
the moves before the window and the signed moves inside it and derives the close from those two
alone — the browser had to reconstruct an opening from receipts and issues because it held no
moves at all, and a cancelled ticket walked the answer by exactly the quantity it never moved.

A withdrawn grant puts a shop's ask back on the desk it came from, which is the edge the
counter's new cancel door needs and the only membership-free change the tables required.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Server scaffolding — two modules, the support list, and the builder

*(Wave 1, alongside Tasks 1 and 2. It owns `apps/api/**` and nothing else.)*

**Precondition:** this task's own gate will not pass until Task 1's `hist` field is on `TicketSchema`, because `apps/api`'s ticket readers and builders must fill it. **The controller dispatches Task 3 from the phase branch head like the others, and Task 3 declares `hist` locally only if Task 1 has not merged yet** — see Step 1's note. In practice: dispatch all three wave-1 tasks together, merge Task 1 first, then rebase Tasks 2 and 3 onto it before their final gate. If that ordering is inconvenient, dispatch Task 1 alone, merge it, then dispatch 2 and 3 — the wave is only three tasks and the serialisation costs one review cycle.

**Files:**
- Create: `apps/api/src/modules/support/routes.ts`, `apps/api/src/modules/support/service.ts`, `apps/api/src/modules/support/repo.ts`, `apps/api/src/modules/support/support.test.ts`, `apps/api/src/modules/reports/routes.ts`, `apps/api/src/modules/reports/service.ts`, `apps/api/src/modules/reports/repo.ts`, `apps/api/src/modules/reports/reports.test.ts`
- Modify: `apps/api/src/modules/index.ts`, `apps/api/src/test/builders.ts`, `apps/api/src/test/builders.test.ts`, `apps/api/src/modules/snapshot/readers/documents.ts` *(the `hist: []` placeholder in `readTickets`, and nothing else in the file — Task 4 rewrites that function in wave 2)*

**Interfaces:**
- Consumes: `mount` (`apps/api/src/routes.ts`), `routes.tickets` (Task 1), `readSupportTickets` (`modules/snapshot/readers/documents.ts`), `given` (`src/test/builders.ts`), `buildTestApp`, `seedTestDb`, `authHeaders`.
- Produces (imported by Tasks 4, 5 and 6):
  ```ts
  // apps/api/src/modules/support/repo.ts
  export const supportRepo: {
    /** The caller's own tickets, newest first. `by_user`, never a display name: two people can
     *  share a name and a name is not an identity. */
    listFor(db: Db, userId: string): Promise<SupportTicket[]>;
  };
  // apps/api/src/modules/support/service.ts
  export function createSupportService(db: Db): { list(claims: AccessClaims): Promise<SupportTicket[]> };
  // apps/api/src/modules/reports/service.ts
  export function createReportsService(db: Db): Record<string, never>;   // filled by Task 6
  // apps/api/src/test/builders.ts
  given.supportTicket(db, p: {
    id?: string; by?: string; topic?: TicketTopic; subject?: string; priority?: TicketPriority;
    st?: TicketStatus; loc?: LocKey; role?: Role; screen?: string; rating?: 1|2|3|4|5;
    messages?: { from: "user" | "support"; who?: string; body: string }[];
  }): Promise<string>;
  ```

**Why `reports` is an empty registered module in wave 1.** The same reason Phase 5 stood up six empty modules before filling them: `apps/api/src/modules/index.ts` is one file and two wave-2 tasks cannot both add a line to it. Task 3 registers both modules; Task 5 fills `support`'s writes and Task 6 fills `reports`, and neither touches the registration. `scripts/check-boundaries.sh` asserts every module folder has all four skeleton files, so an empty module still has to have them — copy `_template` and keep the placeholder shapes.

- [ ] **Step 1: Fix what Task 1's `hist` broke, and prove it**

`TicketSchema` now requires `hist`. Find every place in `apps/api` that builds a `Ticket`:

```bash
pnpm --filter @rch/api typecheck 2>&1 | grep -E "error TS" | cut -d'(' -f1 | sort -u
```

As written that is `apps/api/src/modules/snapshot/readers/documents.ts`'s `readTickets` and the ticket-shaped results in `modules/tickets/service.ts`. **This task's fix is the minimum that compiles: `hist: []`, with a `// Task 4 fills this from document_history` comment on each** — one added property per site, no other change to either file. Task 4 rewrites `readTickets` in wave 2; the two tasks are in different waves and the placeholder is a line Task 4 deletes, so there is no race and no second author. Do not implement the history read here.

If Task 1 has not merged when this task starts, skip this step and note it in the report; the controller re-runs the gate after the merge.

- [ ] **Step 2: Write the failing builder test**

Add to `apps/api/src/test/builders.test.ts`:

```ts
it("makes a support ticket with a first message, above the fixtures' band", async () => {
  const id = await given.supportTicket(t.db, { by: "u1", subject: "Cash reads zero", messages: [{ from: "user", body: "Since 09:00." }] });
  expect(id).toMatch(/^SUP-00\d+$/);
  // The fixtures stop at SUP-0043 and the sequence starts at 44; `nextId` pads to four, so the
  // builder's band is SUP-000101+ — above both, and a builder-made ticket can collide with
  // neither a seeded one nor an allocated one.
  expect(Number(id.slice(-3))).toBeGreaterThan(100);

  const rows = await t.db.select().from(s.supportTickets).where(eq(s.supportTickets.id, id));
  expect(rows[0]?.status).toBe("Open");
  expect(rows[0]?.byUser).toBe("u1");
  const msgs = await t.db.select().from(s.supportMessages).where(eq(s.supportMessages.ticketId, id));
  expect(msgs).toHaveLength(1);
  expect(msgs[0]?.from).toBe("user");
});

it("draws a second ticket without colliding with the first", async () => {
  const a = await given.supportTicket(t.db, { by: "u1", subject: "One" });
  const b = await given.supportTicket(t.db, { by: "u1", subject: "Two" });
  expect(a).not.toBe(b);
});
```

And write the failing module test, `apps/api/src/modules/support/support.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../app.js";
import { buildTestApp } from "../../test/app.js";
import { truncateAll } from "../../test/db.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "support" }); await app.ready(); });
// `buildTestApp` migrates but does NOT seed, and `authHeaders` throws
// `no user u1 - did you seed?` without this. Copy the shape from
// `modules/tickets/tickets.test.ts:15-17`; every DB-backed module suite has it.
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });
afterAll(async () => { await app.close(); });

const list = async (userId: string) => {
  const res = await app.inject({ method: "GET", url: "/api/v1/support/tickets", headers: await authHeaders(app, userId) });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; by: string }[];
};

describe("GET /support/tickets", () => {
  it("answers with the caller's own tickets and nobody else's, in every role", async () => {
    const mine = await given.supportTicket(app.db, { by: "u1", subject: "Mine" });
    const theirs = await given.supportTicket(app.db, { by: "u3", subject: "Theirs" });

    const asCounter = await list("u1");
    expect(asCounter.map((t) => t.id)).toContain(mine);
    expect(asCounter.map((t) => t.id)).not.toContain(theirs);

    // The store keeper is not a support agent either: own tickets, same as everyone.
    const asStore = await list("u3");
    expect(asStore.map((t) => t.id)).toContain(theirs);
    expect(asStore.map((t) => t.id)).not.toContain(mine);
  });

  it("is open to every role — support is the one module all five share (§8.3)", async () => {
    for (const u of ["u1", "u2", "u3", "u4", "u5"]) {
      const res = await app.inject({ method: "GET", url: "/api/v1/support/tickets", headers: await authHeaders(app, u) });
      expect(res.statusCode).toBe(200);
    }
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/support/tickets" });
    expect(res.statusCode).toBe(401);
  });
});
```

**Check the seeded user ids before running this.** `apps/api/src/test/seed.ts` seeds the fixture users; `u1`…`u6` is the shape Phases 2–5's suites use (`u1` counter at the coffee shop, `u2` manager, `u3` store keeper, `u4` kitchen, `u5` buyer, `u6` the second counter operator at the kiosk), but read the file rather than trusting this plan, and pick by filtering `FX.USERS` on role if they differ.

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm db:up && pnpm --filter @rch/api test -- src/test/builders.test.ts src/modules/support/support.test.ts`
Expected: FAIL — `given.supportTicket` is not a function, and `GET /api/v1/support/tickets` is a 404 because no module mounts it. If instead it fails with `no user u1 - did you seed?`, the `beforeEach` above is missing.

- [ ] **Step 4: Add the builder**

In `apps/api/src/test/builders.ts`, add `sup: 0` to the `counters` object and this method to `given`:

```ts
  /** A support ticket, with as many messages as the case needs. `nextId` pads to four, so the
   *  ids are `SUP-000101`+ — above the fixtures' `SUP-0043` and above the sequence's start at 44
   *  (`formatId("support", n)` is `SUP-00${n}`, unpadded), so a builder-made ticket collides with
   *  neither. `by` is a user id, not a name: that is what the list is scoped on. */
  async supportTicket(db: Db, p: {
    id?: string; by?: string; topic?: TicketTopic; subject?: string; priority?: TicketPriority;
    st?: TicketStatus; loc?: LocKey; role?: Role; screen?: string; rating?: 1 | 2 | 3 | 4 | 5;
    messages?: { from: "user" | "support"; who?: string; body: string }[];
  }): Promise<string> {
    const id = p.id ?? nextId("SUP-00", 100, "sup");
    const by = p.by ?? "u1";
    await db.transaction(async (tx) => {
      const [author] = await tx.select({ name: s.users.name, role: s.users.role, loc: s.users.loc }).from(s.users).where(eq(s.users.id, by));
      await tx.insert(s.supportTickets).values({
        id, topic: p.topic ?? "Something else", subject: p.subject ?? "Something is not right",
        priority: p.priority ?? "Normal", status: p.st ?? "Open", byUser: by,
        role: p.role ?? author?.role ?? "counter", loc: p.loc ?? author?.loc ?? "coffee",
        screen: p.screen ?? "Dashboard", rating: p.rating ?? null,
      });
      const msgs = p.messages ?? [];
      if (msgs.length) {
        await tx.insert(s.supportMessages).values(msgs.map((m, i) => ({
          // Ticket-qualified, exactly as the seed writes them: fixture message ids repeat across
          // tickets and the reader strips the prefix back off.
          id: `${id}/m${i + 1}`, ticketId: id, from: m.from,
          who: m.who ?? (m.from === "support" ? "Portal Support" : author?.name ?? by), body: m.body,
        })));
      }
    });
    return id;
  },
```

Add `TicketPriority`, `TicketStatus`, `TicketTopic` and `Role` to the `import type { … } from "@rch/contract";` line at the top.

- [ ] **Step 5: Stand up the two modules**

`apps/api/src/modules/support/repo.ts`:

```ts
// repo.ts: SQL only. The service opens the transaction; this file never does.
import { asc, desc, eq } from "drizzle-orm";
import type { SupportTicket } from "@rch/contract";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../lib/db.js";
import * as s from "../../db/schema/index.js";

/** Rows -> the wire shape, shared by the list and (Task 5) by every write's `result`. */
export function toWire(head: typeof s.supportTickets.$inferSelect, msgs: (typeof s.supportMessages.$inferSelect)[], byName: string): SupportTicket {
  return {
    id: head.id, topic: head.topic, subject: head.subject, priority: head.priority, st: head.status,
    by: byName, role: head.role, loc: head.loc as SupportTicket["loc"],
    at: head.at.toISOString(), screen: head.screen,
    messages: msgs.map((m) => ({
      id: m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id,
      from: m.from, who: m.who, at: m.at.toISOString(), body: m.body,
    })),
    ...(head.rating === null ? {} : { rating: head.rating as SupportTicket["rating"] }),
  };
}

export const supportRepo = {
  /** The caller's own tickets, newest first, each with its conversation oldest first. */
  async listFor(db: Db | Tx, userId: string): Promise<SupportTicket[]> {
    const heads = await db.select().from(s.supportTickets).where(eq(s.supportTickets.byUser, userId))
      .orderBy(desc(s.supportTickets.at), desc(s.supportTickets.id));
    if (heads.length === 0) return [];
    const ids = heads.map((h) => h.id);
    const msgs = await db.select().from(s.supportMessages)
      .where(inArray(s.supportMessages.ticketId, ids))
      .orderBy(asc(s.supportMessages.at), asc(s.supportMessages.id));
    const [me] = await db.select({ name: s.users.name }).from(s.users).where(eq(s.users.id, userId));
    // Grouped inline. `readers/documents.ts:10` has a private `groupBy` that does exactly this,
    // and it stays private: moving it into `lib/` would mean this wave-1 task editing the reader
    // Task 4 owns in wave 2, for a three-line helper. A shared `lib/groupBy.ts` is the tidy, and
    // it is recorded as one rather than smuggled in here.
    const byTicket = new Map<string, typeof msgs>();
    for (const m of msgs) {
      const list = byTicket.get(m.ticketId);
      if (list) list.push(m); else byTicket.set(m.ticketId, [m]);
    }
    return heads.map((h) => toWire(h, byTicket.get(h.id) ?? [], me?.name ?? userId));
  },
};
```

Import `inArray` from `drizzle-orm` alongside `asc`, `desc` and `eq`. **Do not import or move `groupBy`** — it is a private, unexported `const` at `modules/snapshot/readers/documents.ts:10`, and hoisting it into `lib/` would put this wave-1 task inside the function Task 4 rewrites in wave 2. Record in the report that a shared `lib/groupBy.ts` is the tidy, and leave it for a later hygiene pass.

`apps/api/src/modules/support/service.ts`:

```ts
// service.ts: the flow. Task 5 adds the four writes; this is the read they will all answer with.
import type { SupportTicket } from "@rch/contract";
import type { Db } from "../../db/client.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { supportRepo } from "./repo.js";

export function createSupportService(db: Db) {
  return {
    /** Spec §9.2 scopes every support write to the caller's own tickets, so the list is scoped
     *  the same way: a row nobody may act on is a row nobody should be shown. Keyed on the user
     *  id in the token, never on a display name. */
    async list(claims: AccessClaims): Promise<SupportTicket[]> {
      return supportRepo.listFor(db, claims.sub);
    },
  };
}
```

`apps/api/src/modules/support/routes.ts`:

```ts
// Support: customer care for the portal itself. Every role, own tickets only.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createSupportService } from "./service.js";

export default fp(async (app) => {
  const svc = createSupportService(app.db);
  mount(app, routes.tickets, async (req) => svc.list(req.user));
}, { name: "module:support", dependencies: ["auth", "rbac", "idempotency", "db"] });
```

`apps/api/src/modules/reports/{routes,service,repo}.ts`: copy `_template`'s three files, rename `template` to `reports` throughout, mount nothing, and replace the header comment with:

```ts
// Reports: the two figures the browser cannot compute from its own snapshot — the central store's
// stock ledger, which needs `stock_moves`, and a staff member's credit for the calendar month,
// which needs every outlet's bills and not the till's own seven days. Task 6 fills this in; the
// module is registered empty so `modules/index.ts` is written once, in one wave, by one task.
```

`apps/api/src/modules/reports/reports.test.ts`: one placeholder case so the file is not empty and `check-boundaries.sh`'s four-file rule is satisfied:

```ts
import { describe, expect, it } from "vitest";
import { createReportsService } from "./service.js";
it("is registered and empty until its two queries land", () => {
  expect(typeof createReportsService).toBe("function");
});
```

- [ ] **Step 6: Register both modules**

In `apps/api/src/modules/index.ts`, one import and one `await app.register(...)` line each, after `productreqs`:

```ts
import support from "./support/routes.js";
import reports from "./reports/routes.js";
```
```ts
  await app.register(support);
  await app.register(reports);
```

- [ ] **Step 7: Run the API suite**

Run: `pnpm --filter @rch/api test && pnpm --filter @rch/api typecheck`
Expected: PASS, including `apps/api/src/contract.test.ts` — which now probes `GET /support/tickets` and gets a 200 that parses against `SupportTicketsResponseSchema`.

Then, from the root: `pnpm lint`
Expected: PASS. `check-boundaries.sh` asserts both new module folders have all four files; if it complains, the reports module is missing its test file or its repo.

- [ ] **Step 8: Commit**

```bash
git add apps/api
git commit -m "$(cat <<'EOF'
Stand up the support desk and the reports module, and give a ticket its list

Two modules registered in one place so no later task has to edit the registration: support,
which already answers for the caller's own tickets, and reports, which is empty until the two
queries that need it land beside their contract entries.

The list is scoped on the user id in the token rather than on a display name. Every write the
spec gives the support desk is "all (own)", so a list that showed the whole hospital's tickets
was showing rows the reader could not reply to, resolve or rate — and showing a counter
operator's account of what went wrong to a buyer.

`given.supportTicket` joins the ten builders, in a band above the fixtures and above the
sequence, and every ticket a reader builds now carries an empty history until the read that
fills it lands.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Tickets and the snapshot — a trail, a withheld OTP, the counter's door, the roster

*(Wave 2, alongside Tasks 5, 6, 7, 8 and 9. It owns `apps/api/src/modules/snapshot/**` and `apps/api/src/modules/tickets/**`. Task 5 owns `apps/api/src/modules/support/**`; Task 6 owns `apps/api/src/modules/reports/**`, `apps/api/src/modules/pos/**`, `apps/api/src/lib/credit.ts` and `packages/contract/**`; Tasks 7, 8 and 9 are outside `apps/api/src` entirely. No file is shared.)*

**Read the documents you assert against through `GET /snapshot`, not through the routes another wave-2 task is writing.** This task never calls `GET /support/tickets`'s writes or `GET /reports/*`.

**Files:**
- Modify: `apps/api/src/modules/snapshot/readers/documents.ts`, `apps/api/src/modules/snapshot/readers/master.ts`, `apps/api/src/modules/snapshot/scope.ts`, `apps/api/src/modules/snapshot/service.ts`, `apps/api/src/modules/snapshot/snapshot.test.ts`, `apps/api/src/modules/snapshot/documents.test.ts`, `apps/api/src/modules/tickets/service.ts`, `apps/api/src/modules/tickets/repo.ts`, `apps/api/src/modules/tickets/tickets.test.ts`

**Interfaces:**
- Consumes: `readHistories` (`apps/api/src/lib/history.ts` — already exported, already used by the request and requisition readers), `SHOP_ASK_TRANSITIONS`, `canTransition`, `assertTransition` (Task 2 added the `Sent → Asked` edge), `PayerRosterSchema` (Task 1), `routes.cancelTicket`'s widened access (Task 1), `given.supportTicket` (Task 3).
- Produces (imported by Task 10):
  ```ts
  // apps/api/src/modules/snapshot/scope.ts
  /** The OTP belongs to whoever is collecting. Blank it for everyone else, in place. */
  export const redactOtps: (tkt: Ticket[], who: Who) => Ticket[];
  /** Own tickets, for every role — the same cut GET /support/tickets makes. */
  export const scopeSupportTickets: (rows: SupportTicket[], who: Who & { sub: string }, byUser: Map<string, string>) => SupportTicket[];
  // apps/api/src/modules/snapshot/readers/master.ts
  export function readRoster(db: Db): Promise<PayerRoster>;
  ```

**The four things this task changes, and why each is here rather than somewhere else.**

| Change | Why it is one task |
|---|---|
| `readTickets` reads `document_history` | It is one line in the same reader that already assembles a ticket, and it is what Task 3 left a `hist: []` placeholder for. |
| The OTP is blanked for everyone but the collector | It is a cut on the same rows, in the same `scope.ts`, applied to both `GET /snapshot` and `GET /tickets`. |
| The counter may cancel its own outlet's ticket | `cancel` lives in `modules/tickets/service.ts` and needs a linked-document branch for `shop_ask`; the route's access widened in Task 1. |
| The snapshot carries `roster` | It is one reader in `readers/master.ts` and one field in the service's assembly — and the till's payer list has to stop being a fixture before Task 10 can delete the fixture path. |

Splitting them would put four tasks into the same three files.

**The scoping decision, stated so the implementer does not soften it.** `otp` is non-empty **only** when `st === "Issued"` **and** `who.loc === ticket.to`. Not "except for the store", not "unless the caller issued it". The store keeper types what the collector reads aloud; if the collector is not there, the labelled supervisor override is the door, and it is recorded in `document_history` — which is now visible, which is the point.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/modules/snapshot/snapshot.test.ts`:

```ts
describe("what a ticket carries, and to whom", () => {
  it("gives a ticket its own trail, oldest first", async () => {
    const id = await given.ticket(app.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 4 }] });
    const snap = await snapshotFor("u3");                       // the store keeper
    const t = snap.tkt.find((x) => x.id === id)!;
    expect(t.hist.length).toBeGreaterThan(0);
    expect(t.hist.map((h) => h.s)).toContain("Issued");
    // Times are ISO on the wire, like every other document's history.
    expect(t.hist[0].t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("shows the six digits to the shop that is collecting and to nobody else", async () => {
    const id = await given.ticket(app.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 4 }] });

    const collector = (await snapshotFor("u1")).tkt.find((x) => x.id === id)!;   // counter at coffee
    expect(collector.otp).toMatch(/^\d{6}$/);

    const issuer = (await snapshotFor("u3")).tkt.find((x) => x.id === id)!;      // store keeper
    expect(issuer.otp).toBe("");
    const manager = (await snapshotFor("u2")).tkt.find((x) => x.id === id)!;
    expect(manager.otp).toBe("");
  });

  it("takes the digits back once the ticket has been collected", async () => {
    const id = await given.ticket(app.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 4 }], st: "Collected" });
    expect((await snapshotFor("u1")).tkt.find((x) => x.id === id)!.otp).toBe("");
  });

  it("hands a counter the roster it bills against, from the payers table", async () => {
    const snap = await snapshotFor("u1");
    expect(snap.roster.patients.length).toBeGreaterThan(0);
    expect(snap.roster.staff.length).toBeGreaterThan(0);
    expect(snap.roster.depts.length).toBeGreaterThan(0);
    expect(snap.roster.staff.every((p) => p.kind === "staff")).toBe(true);
    // A payer switched off is not offered at the till.
    await app.db.update(s.payers).set({ active: false }).where(and(eq(s.payers.kind, "staff"), eq(s.payers.id, snap.roster.staff[0].id)));
    expect((await snapshotFor("u1")).roster.staff.length).toBe(snap.roster.staff.length - 1);
  });

  it("shows every role its own support tickets and nobody else's", async () => {
    const mine = await given.supportTicket(app.db, { by: "u4", subject: "Kitchen board is blank" });
    const theirs = await given.supportTicket(app.db, { by: "u5", subject: "Vendor list will not load" });
    expect((await snapshotFor("u4")).tickets.map((t) => t.id)).toEqual(expect.arrayContaining([mine]));
    expect((await snapshotFor("u4")).tickets.map((t) => t.id)).not.toContain(theirs);
  });
});
```

In `apps/api/src/modules/tickets/tickets.test.ts`:

```ts
describe("the counter's cancel door", () => {
  it("lets the shop that granted a transfer withdraw it, and releases the hold", async () => {
    const id = await given.ticket(app.db, { refType: "shop_transfer", refId: "direct", from: "coffee", to: "kiosk", lines: [{ it: "juice", qty: 3 }] });
    const before = await freeAt("coffee", "juice");

    const res = await app.inject({ method: "POST", url: `/api/v1/tickets/${id}/cancel`, headers: { ...(await authHeaders(app, "u1")), "idempotency-key": key() }, payload: { reason: "Kiosk found some of their own" } });
    expect(res.statusCode).toBe(200);
    expect(await freeAt("coffee", "juice")).toBe(before + 3);
  });

  it("refuses a counter at the other end of it — the shop that is receiving cannot withdraw it", async () => {
    const id = await given.ticket(app.db, { refType: "shop_transfer", refId: "direct", from: "coffee", to: "kiosk", lines: [{ it: "juice", qty: 3 }] });
    const res = await app.inject({ method: "POST", url: `/api/v1/tickets/${id}/cancel`, headers: { ...(await authHeaders(app, "u6")), "idempotency-key": key() }, payload: { reason: "no" } });
    expect(res.statusCode).toBe(403);
  });

  it("puts a withdrawn grant's ask back on the desk it came from", async () => {
    const ask = await given.shopAsk(app.db, { from: "kiosk", to: "coffee", it: "juice", qty: 5, st: "Asked" });
    const grant = await app.inject({ method: "POST", url: `/api/v1/shop-asks/${ask}/answer`, headers: { ...(await authHeaders(app, "u1")), "idempotency-key": key() }, payload: { grant: 4 } });
    expect(grant.statusCode).toBe(200);
    const tkt = (grant.json() as { result: { ticket: string } }).result.ticket;

    const res = await app.inject({ method: "POST", url: `/api/v1/tickets/${tkt}/cancel`, headers: { ...(await authHeaders(app, "u1")), "idempotency-key": key() }, payload: { reason: "Sold out before they came" } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { changed: string[] }).changed).toContain("shopAsks");

    const [row] = await app.db.select().from(s.shopAsks).where(eq(s.shopAsks.id, ask));
    expect(row.status).toBe("Asked");
    expect(row.grantedQty).toBeNull();
    expect(row.ticketId).toBeNull();
  });

  it("still refuses the kitchen a shop's ticket", async () => {
    const id = await given.ticket(app.db, { refType: "shop_transfer", refId: "direct", from: "coffee", to: "kiosk", lines: [{ it: "juice", qty: 3 }] });
    const res = await app.inject({ method: "POST", url: `/api/v1/tickets/${id}/cancel`, headers: { ...(await authHeaders(app, "u4")), "idempotency-key": key() }, payload: { reason: "no" } });
    expect(res.statusCode).toBe(403);
  });
});
```

**`u6`, `u1`, `u4` are placeholders for "a counter at `kiosk`", "a counter at `coffee`" and "the kitchen in-charge".** Read `apps/api/src/test/seed.ts` and pick by filtering the fixture users on role and location; the fixtures have two counter operators, which is what makes the second case above possible at all. If they do not, the second case becomes "a manager is refused" and the report says so.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rch/api test -- src/modules/snapshot src/modules/tickets`
Expected: FAIL — `hist` is `[]`, `otp` is present for everyone, `snap.roster` is undefined, and the counter's cancel is a 404 (Task 1 widened the route, so it should be a 403 or a 200 — if it is still 404, Task 1 has not merged).

- [ ] **Step 3: Read the ticket's history**

In `apps/api/src/modules/snapshot/readers/documents.ts`, `readTickets` already fetches heads and lines. Add the histories the way `readRequests` does:

```ts
export async function readTickets(db: Db): Promise<Ticket[]> {
  const [heads, lines, hist] = await Promise.all([
    db.select().from(s.tickets).orderBy(desc(s.tickets.issuedAt), desc(s.tickets.id)),
    db.select().from(s.ticketLines).orderBy(asc(s.ticketLines.lineNo)),
    // One query for every ticket's trail rather than one per ticket: `readHistories` is the same
    // helper the request and requisition readers use, and it is why the ticket drawer can show
    // "Handed over — supervisor override" at all.
    readHistories(db, "ticket"),
  ]);
  const byTicket = groupBy(lines, (l) => l.ticketId);
  return heads.map((t) => ({
    /* …every field as today… */
    hist: hist.get(t.id) ?? [],
  }));
}
```

Import `readHistories` from `../../../lib/history.js`. **Check the `docType` string the ticket writes use** — `grep -n 'appendHistory(tx, "' apps/api/src/modules/tickets/service.ts apps/api/src/lib/tickets.ts` — and pass exactly that, not a guess. As written it is `"ticket"`.

- [ ] **Step 4: Withhold the OTP, and scope the support list, in `scope.ts`**

```ts
/**
 * The six digits belong to whoever is collecting: they read them aloud and the sending location
 * types them in. Sending them to the sending location made the check theatre — the store's issue
 * desk printed the number three inches from the box that verifies it — and sending them to
 * anyone else is a credential in a snapshot for no reason at all.
 *
 * So: the OTP travels only while the ticket is still `Issued` and only to a caller standing at
 * the ticket's `to`. Everyone else reads "". The way past a collector who is not there is the
 * labelled supervisor override on `handover`, which is refused to a counter and recorded in
 * `document_history` — now visible on the ticket itself.
 */
export const redactOtps = (tkt: Ticket[], who: Who): Ticket[] =>
  tkt.map((t) => (t.st === "Issued" && t.to === who.loc ? t : { ...t, otp: "" }));

/**
 * Support is the one module all five roles share (§8.3) and every support write in §9.2 is
 * scoped "all (own)". The list is scoped the same way, by the user id in the token — `by` on the
 * wire is a display name and two people can share one.
 */
export const scopeSupportTickets = (rows: SupportTicket[], who: { sub: string }, byUser: Map<string, string>): SupportTicket[] =>
  rows.filter((t) => byUser.get(t.id) === who.sub);
```

`SupportTicket.by` is a name, so the reader has to hand the scope the id it came from. Change `readSupportTickets` to return the pair — the least invasive shape is a second exported reader used only by the scope:

```ts
/** Ticket id -> the user id that raised it. The wire shape carries a display name, and the scope
 *  has to cut on an identity. */
export async function readSupportTicketOwners(db: Db): Promise<Map<string, string>> {
  const rows = await db.select({ id: s.supportTickets.id, byUser: s.supportTickets.byUser }).from(s.supportTickets);
  return new Map(rows.map((r) => [r.id, r.byUser]));
}
```

In `scope()`, replace `tickets: s.tickets.filter(mine)` with `tickets: scopeSupportTickets(s.tickets, who, owners)` and **move it out of the `if (who.role !== "counter") return s;` early return** — the whole point is that it now applies to every role. `const mine = (x: { by: string }) => x.by === s.user.n;` (`scope.ts:55`) had exactly that one caller, so **delete it too** or `noUnusedLocals` fails the build. The cleanest shape, which keeps that early return for everything else:

```ts
export function scope(s: Snapshot, who: Who & { sub: string }, owners: Map<string, string>): Snapshot {
  // Two cuts apply to every role, not only to a counter: a support ticket is the caller's own,
  // and a ticket's OTP is the collector's.
  const base: Snapshot = { ...s, tickets: scopeSupportTickets(s.tickets, who, owners), tkt: redactOtps(s.tkt, who) };
  if (who.role !== "counter") return base;
  /* …the counter's cuts, applied to `base` rather than to `s`… */
}
```

Apply `redactOtps` to `service.ts`'s standalone `tickets(claims)` read too, or `GET /tickets` hands back what the snapshot withholds and the refetch after a handover puts the digits straight back on the screen.

- [ ] **Step 5: Serve the roster**

In `apps/api/src/modules/snapshot/readers/master.ts`:

```ts
/**
 * Who a bill may be charged to. The till has validated its payer against this table since Phase 3
 * (`posRepo.payer`), while the browser read three arrays out of the fixtures — so a payer added
 * to the database was invisible at the counter and a fixture removed from the browser was still
 * accepted by the server. One table, one list.
 */
export async function readRoster(db: Db): Promise<PayerRoster> {
  const rows = await db.select().from(s.payers).where(eq(s.payers.active, true)).orderBy(asc(s.payers.name));
  const of = (kind: PayerKind) => rows.filter((p) => p.kind === kind).map((p) => ({ kind: p.kind, id: p.id, name: p.name }));
  return { patients: of("patient"), staff: of("staff"), depts: of("dept") };
}
```

In `modules/snapshot/service.ts`, add `M.readRoster(db)` and `D.readSupportTicketOwners(db)` to the `Promise.all`, put `roster` into the assembled `full`, and pass `owners` to `scope(...)`. The roster is **not** scoped: every counter bills every kind of payer, and the list is names the operator already reads off a wristband.

- [ ] **Step 6: Open the counter's door and put the ask back**

`modules/tickets/service.ts`'s `cancel` needs one branch beside the ones it has for `request` and `prod_order`. Read the existing branches first and follow their shape exactly; what is new is:

```ts
        // A granted shop ask that is withdrawn goes back on the asking shop's desk. Leaving it
        // at `Sent` would show the asker stock that is coming and the holder a document it has
        // just undone — and `answerShopAsk` would refuse to grant it a second time.
        if (t.refType === "shop_ask") {
          const ask = await ticketsRepo.linkedShopAsk(tx, t.req);
          if (ask) {
            assertTransition(SHOP_ASK_TRANSITIONS, ask.status, "Asked", ask.id);
            await ticketsRepo.reopenShopAsk(tx, ask.id);
            changed.push("shopAsks");
          }
        }
```

and in `modules/tickets/repo.ts`:

```ts
  /** The ask a shop-ask ticket was raised for, locked: two cancellations of one ticket must not
   *  both reopen it, and the ticket's own `for update` above is taken first (documents in one
   *  order, always). */
  async linkedShopAsk(tx: Tx, askId: string) {
    const [row] = await tx.select().from(s.shopAsks).where(eq(s.shopAsks.id, askId)).for("update");
    return row ?? null;
  },
  /** Back to Asked, with the grant and the ticket cleared, so the holding shop can answer again. */
  async reopenShopAsk(tx: Tx, askId: string): Promise<void> {
    await tx.update(s.shopAsks).set({ status: "Asked", grantedQty: null, ticketId: null }).where(eq(s.shopAsks.id, askId));
  },
```

`t.req` is the ticket's `ref_id`; check the column name in `repo.ts` rather than assuming, and confirm `answerShopAsk` writes the ask's id there. Nothing about the route changes — `requireLocOf(claims, t.from)` was already the rule and Task 1 only widened who may knock.

- [ ] **Step 7: Prove the lock, with a warmed pool**

Add to `tickets.test.ts`:

```ts
it("reopens a withdrawn grant's ask exactly once when two cancellations race", async () => {
  const ask = await given.shopAsk(app.db, { from: "kiosk", to: "coffee", it: "juice", qty: 5, st: "Asked" });
  const granted = await answerAsk(ask, 4);
  const freeBefore = await freeAt("coffee", "juice");
  // `pg` connects lazily: without this the second transaction waits ~5 ms for a socket and
  // begins after the first has committed, and the case passes with the lock removed.
  // Every existing call in this repo is `warmPool(app.testDb!, n)` — not `warmPool(t, n)`.
  await warmPool(app.testDb!, 2);

  const [a, b] = await Promise.allSettled([cancel(granted, "one"), cancel(granted, "two")]);
  const ok = [a, b].filter((r) => r.status === "fulfilled" && r.value.statusCode === 200);
  expect(ok).toHaveLength(1);

  const [row] = await app.db.select().from(s.shopAsks).where(eq(s.shopAsks.id, ask));
  expect(row.status).toBe("Asked");
  // And the hold came back once, not twice.
  expect(await freeAt("coffee", "juice")).toBe(freeBefore);
});
```

Then **comment out the `.for("update")` in `linkedShopAsk` and run this case again.** It must fail. If it passes with the lock removed, the race is not happening — check `warmPool(app.testDb!, 2)` ran and that both requests carry *different* idempotency keys (two calls with the same key are a replay, not a race). Restore the lock before committing and say in the report that you proved it.

- [ ] **Step 8: Run the gate**

Run: `pnpm turbo typecheck test --force && pnpm lint`
Expected: `@rch/api` PASS; `@rch/ui` still FAILS on `TicketSchema.hist` and `SnapshotSchema.roster` — Task 10 fixes the browser in wave 3. Note it in the report; do not touch `UI/`.

- [ ] **Step 9: Commit**

```bash
git add apps/api
git commit -m "$(cat <<'EOF'
Give a ticket its trail, take its OTP back, and let a shop undo its own grant

A ticket now carries the history it has been writing since Phase 3. The supervisor override and
Phase 4's cancellation both wrote a row nothing could read; the drawer can show them now.

The six digits stop travelling to the people who do not need them. They go to the location that
is collecting, while the ticket is still Issued, and to nobody else — the store's issue desk was
printing the number beside the box that checks it, which is not a check. The way past a collector
who cannot be reached is the labelled override, which is refused to a counter and recorded in the
trail this same commit makes visible.

An outlet may withdraw a ticket it raised, which is the door Phase 4 left unbuilt: the route
already scoped on the ticket's own `from`, so nothing about the scoping changed. A withdrawn
grant puts the ask back on the asking shop's desk, under the ask's own row lock — proved by a
race that fails when the lock is taken out.

And the till's payer list comes from the payers table the server has been checking against since
Phase 3, so a patient admitted after the last build is billable.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `support` — raise, reply, resolve, rate

*(Wave 2. It owns `apps/api/src/modules/support/**` and nothing else.)*

**Read the tickets you assert against through `GET /support/tickets`** (Task 3 shipped it in wave 1) **or through `given.supportTicket`, never through `GET /snapshot`** — Task 4 is rewriting the snapshot's scope in this same wave.

**Files:**
- Modify: `apps/api/src/modules/support/routes.ts`, `apps/api/src/modules/support/service.ts`, `apps/api/src/modules/support/repo.ts`, `apps/api/src/modules/support/support.test.ts`

**Interfaces:**
- Consumes: `withTransaction`, `assertRule`, `assertTransition`, `allocateId` (kind `"support"` — `SEQUENCE_START.support` is 44, so the first server-issued id continues the fixtures' `SUP-0043`), `emitChanged`, `NotFoundError`, `ForbiddenError`; `SUPPORT_TRANSITIONS`, `mayUserSet`, `statusAfterReply`, `mayRate` from `@rch/domain` (Task 2); `supportRepo.listFor`, `toWire` from its own repo (Task 3).
- Produces: nothing another task imports. Task 10 calls the four routes.

**Spec §9.2, verbatim — the four rows this task implements:**

| Mutation (today) | Endpoint | Roles | Rules enforced server-side |
|---|---|---|---|
| `raiseTicket(...)` | `POST /support/tickets` | all | subject, body non-empty; first message from `user` |
| `replyToTicket(id, body)` | `POST /support/tickets/:id/messages` `{ body }` | all (own) | status Waiting on you / Resolved → With support |
| `setTicketStatus(id, st)` | `POST /support/tickets/:id/status` `{ st }` | all (own) | user may set Resolved/Closed only |
| `rateTicket(id, rating)` | `POST /support/tickets/:id/rating` `{ rating }` | all (own) | 1–5; ticket Resolved or Closed |

**One deviation from that table, and it is deliberate.** *"subject, body non-empty"* — the subject is enforced; the **body is not**. `UI/src/store/ops.ts` has always taken a ticket with an empty body (`messages: body.trim() ? [ … ] : []`) and the Send button is disabled on an empty *subject* only. Refusing an empty body would refuse a ticket the current screen lets an operator send, for a field whose whole purpose is optional detail. The rule that ships is: **subject non-empty, and a first message written only if a body was given, always `from: "user"`.** Task 11 records it in §16 as an amendment to §9.2, not as an oversight.

**The sentences.** Every one is moved verbatim from `UI/src/store/ops.ts`. Read that file and copy them; do not retype from here.

| Endpoint | Success | Refusal |
|---|---|---|
| `POST /support/tickets` | `` `${id} raised — support replies to urgent tickets within the hour` `` | `Give the ticket a subject so support knows what it is about` |
| `POST /support/tickets/:id/messages` | `` `Reply sent on ${id}` `` | `Write a reply first` · **NEW:** `` `${id} is closed — raise a new ticket if it has come back` `` |
| `POST /support/tickets/:id/status` | `` `${id} — ${st.toLowerCase()}` `` | **NEW:** `` `Only support moves a ticket to ${st.toLowerCase()} — you can mark it resolved or close it` `` |
| `POST /support/tickets/:id/rating` | `` `Thank you — ${rating} out of 5 recorded against ${id}` `` | **NEW:** `` `${id} is not finished yet — rate it once support has resolved it` `` |

Four **NEW** sentences, because the browser had no rule to refuse: `setTicketStatus` set whatever it was handed and `rateTicket` rated anything. Task 11 lists all four in §16.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/modules/support/support.test.ts`:

```ts
const post = async (userId: string, path: string, payload?: unknown) =>
  app.inject({ method: "POST", url: `/api/v1/support${path}`, headers: { ...(await authHeaders(app, userId)), "idempotency-key": randomUUID() }, payload: payload ?? {} });

describe("POST /support/tickets", () => {
  it("raises a ticket for whoever is signed in, with their first message on it", async () => {
    const before = (await list("u1")).length;
    const res = await post("u1", "/tickets", { topic: "A number looks wrong", subject: "Cash reads zero", body: "Since 09:00.", priority: "Urgent", screen: "Dashboard" });
    expect(res.statusCode).toBe(200);
    const { result, changed, message } = res.json() as { result: SupportTicket; changed: string[]; message: string };

    expect(result.id).toMatch(/^SUP-00\d+$/);
    expect(result.st).toBe("Open");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].from).toBe("user");
    expect(changed).toEqual(["tickets"]);
    expect(message).toBe(`${result.id} raised — support replies to urgent tickets within the hour`);
    expect(await list("u1")).toHaveLength(before + 1);
  });

  it("continues the visible series rather than restarting it", async () => {
    const a = await post("u1", "/tickets", { topic: "Something else", subject: "One", body: "", priority: "Low", screen: "Dashboard" });
    const b = await post("u1", "/tickets", { topic: "Something else", subject: "Two", body: "", priority: "Low", screen: "Dashboard" });
    const n = (r: typeof a) => Number((r.json() as { result: SupportTicket }).result.id.slice(4));
    expect(n(b)).toBe(n(a) + 1);
  });

  it("takes a ticket with no detail, and leaves the conversation empty", async () => {
    const res = await post("u1", "/tickets", { topic: "Feature request", subject: "A weekly total", body: "   ", priority: "Low", screen: "Dashboard" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { result: SupportTicket }).result.messages).toEqual([]);
  });

  it("refuses one with no subject, in the store's own words, and writes nothing", async () => {
    const before = (await list("u1")).length;
    const res = await post("u1", "/tickets", { topic: "Something else", subject: "   ", body: "x", priority: "Low", screen: "Dashboard" });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { message: string } }).error.message).toBe("Give the ticket a subject so support knows what it is about");
    expect(await list("u1")).toHaveLength(before);
  });

  it("replays a repeated key without raising a second ticket", async () => {
    const k = randomUUID();
    const body = { topic: "Something else", subject: "Twice", body: "", priority: "Low", screen: "Dashboard" };
    const headers = { ...(await authHeaders(app, "u1")), "idempotency-key": k };
    const first = await app.inject({ method: "POST", url: "/api/v1/support/tickets", headers, payload: body });
    const second = await app.inject({ method: "POST", url: "/api/v1/support/tickets", headers, payload: body });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect((await list("u1")).filter((t) => t.subject === "Twice")).toHaveLength(1);
  });
});

describe("POST /support/tickets/:id/messages", () => {
  it("puts a ticket the desk was waiting on back with support", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "Waiting on you" });
    const res = await post("u1", `/tickets/${id}/messages`, { body: "Refreshed and it reads right now." });
    expect(res.statusCode).toBe(200);
    const { result, message } = res.json() as { result: SupportTicket; message: string };
    expect(result.st).toBe("With support");
    expect(result.messages.at(-1)!.from).toBe("user");
    expect(message).toBe(`Reply sent on ${id}`);
  });

  it("reopens a resolved one, and leaves an open one where it is", async () => {
    const resolved = await given.supportTicket(app.db, { by: "u1", st: "Resolved" });
    expect(((await post("u1", `/tickets/${resolved}/messages`, { body: "It is back." })).json() as { result: SupportTicket }).result.st).toBe("With support");
    const open = await given.supportTicket(app.db, { by: "u1", st: "Open" });
    expect(((await post("u1", `/tickets/${open}/messages`, { body: "One more thing." })).json() as { result: SupportTicket }).result.st).toBe("Open");
  });

  it("refuses an empty reply and a closed ticket", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "With support" });
    expect((await post("u1", `/tickets/${id}/messages`, { body: "  " })).statusCode).toBe(422);
    const closed = await given.supportTicket(app.db, { by: "u1", st: "Closed" });
    const res = await post("u1", `/tickets/${closed}/messages`, { body: "Hello?" });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { message: string } }).error.message).toBe(`${closed} is closed — raise a new ticket if it has come back`);
  });

  it("refuses somebody else's ticket as though it were not there", async () => {
    const theirs = await given.supportTicket(app.db, { by: "u3" });
    const res = await post("u1", `/tickets/${theirs}/messages`, { body: "Nosy." });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { message: string } }).error.message).toBe(`There is no support ticket ${theirs}.`);
  });
});

describe("POST /support/tickets/:id/status", () => {
  it("lets the person who raised it resolve it and close it", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "With support" });
    expect(((await post("u1", `/tickets/${id}/status`, { st: "Resolved" })).json() as { result: SupportTicket }).result.st).toBe("Resolved");
    expect(((await post("u1", `/tickets/${id}/status`, { st: "Closed" })).json() as { result: SupportTicket }).result.st).toBe("Closed");
  });

  it("refuses the desk's own three words", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "Open" });
    for (const st of ["With support", "Waiting on you", "Open"]) {
      const res = await post("u1", `/tickets/${id}/status`, { st });
      expect(res.statusCode).toBe(422);
      expect((res.json() as { error: { message: string } }).error.message)
        .toBe(`Only support moves a ticket to ${st.toLowerCase()} — you can mark it resolved or close it`);
    }
  });

  it("refuses a move the table does not have", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "Closed" });
    expect((await post("u1", `/tickets/${id}/status`, { st: "Resolved" })).statusCode).toBe(422);
  });

  it("writes one status, not two, when two taps race", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "With support" });
    // `warmPool(app.testDb!, n)` — the shape every existing race case in this repo uses.
    await warmPool(app.testDb!, 2);
    const [a, b] = await Promise.all([
      post("u1", `/tickets/${id}/status`, { st: "Resolved" }),
      post("u1", `/tickets/${id}/status`, { st: "Closed" }),
    ]);
    expect([a.statusCode, b.statusCode].filter((c) => c === 200)).toHaveLength(1);
  });
});

describe("POST /support/tickets/:id/rating", () => {
  it("records a rating once the desk has resolved it", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "Resolved" });
    const res = await post("u1", `/tickets/${id}/rating`, { rating: 5 });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { result: SupportTicket }).result.rating).toBe(5);
    expect((res.json() as { message: string }).message).toBe(`Thank you — 5 out of 5 recorded against ${id}`);
  });

  it("refuses one on a ticket that is still running", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "With support" });
    const res = await post("u1", `/tickets/${id}/rating`, { rating: 5 });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { message: string } }).error.message).toBe(`${id} is not finished yet — rate it once support has resolved it`);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rch/api test -- src/modules/support/support.test.ts`
Expected: FAIL — all four write routes are 404 because `routes.ts` mounts only the list.

- [ ] **Step 3: Write the repo's four writes**

In `apps/api/src/modules/support/repo.ts`, beside `listFor` and `toWire`:

```ts
  /** The ticket, locked. Every write here decides on a status, and a transition guard that reads
   *  without the lock is not a guard: two "Mark resolved" taps both see `With support`, both pass
   *  `canTransition`, and both write. */
  async head(tx: Tx, id: string) {
    const [row] = await tx.select().from(s.supportTickets).where(eq(s.supportTickets.id, id)).for("update");
    return row ?? null;
  },
  async insertTicket(tx: Tx, row: typeof s.supportTickets.$inferInsert): Promise<void> {
    await tx.insert(s.supportTickets).values(row);
  },
  /** Message ids are ticket-qualified, exactly as the seed writes them, so "m1" can repeat across
   *  tickets and the reader can strip the prefix back off. */
  async appendMessage(tx: Tx, ticketId: string, from: "user" | "support", who: string, body: string): Promise<void> {
    const [{ n }] = await tx.select({ n: count() }).from(s.supportMessages).where(eq(s.supportMessages.ticketId, ticketId));
    await tx.insert(s.supportMessages).values({ id: `${ticketId}/m${Number(n) + 1}`, ticketId, from, who, body });
  },
  async setStatus(tx: Tx, id: string, status: TicketStatus): Promise<void> {
    await tx.update(s.supportTickets).set({ status, updatedAt: new Date() }).where(eq(s.supportTickets.id, id));
  },
  async setRating(tx: Tx, id: string, rating: number): Promise<void> {
    await tx.update(s.supportTickets).set({ rating, updatedAt: new Date() }).where(eq(s.supportTickets.id, id));
  },
  /** One ticket, whole, for a write's `result`. Reuses `toWire` so the list and the writes cannot
   *  drift into two shapes of the same ticket. */
  async one(tx: Tx, id: string): Promise<SupportTicket | null> {
    const [head] = await tx.select().from(s.supportTickets).where(eq(s.supportTickets.id, id));
    if (!head) return null;
    const msgs = await tx.select().from(s.supportMessages).where(eq(s.supportMessages.ticketId, id))
      .orderBy(asc(s.supportMessages.at), asc(s.supportMessages.id));
    const [author] = await tx.select({ name: s.users.name }).from(s.users).where(eq(s.users.id, head.byUser));
    return toWire(head, msgs, author?.name ?? head.byUser);
  },
  /** The caller's own name, for the `who` on a message they are about to write. */
  async author(tx: Tx, userId: string): Promise<{ name: string }> {
    const [row] = await tx.select({ name: s.users.name }).from(s.users).where(eq(s.users.id, userId));
    return { name: row?.name ?? userId };
  },
```

- [ ] **Step 4: Write the service**

The shape every method takes, with the flow the module guide (`apps/api/CLAUDE.md`) lays out — transaction, lock, rules, write, emit, return:

```ts
export function createSupportService(db: Db) {
  /** Every write below is "own ticket only" (§9.2). A ticket somebody else raised is a 404, not a
   *  403: it is not that this person may not act on it, it is that it is not theirs to see — the
   *  same shape a role's missing module has, and it tells a fisherman nothing. */
  const mine = async (tx: Tx, id: string, sub: string) => {
    const row = await supportRepo.head(tx, id);
    if (!row || row.byUser !== sub) throw new NotFoundError(`There is no support ticket ${id}.`);
    return row;
  };

  return {
    async list(claims: AccessClaims): Promise<SupportTicket[]> { return supportRepo.listFor(db, claims.sub); },

    async raise(claims: AccessClaims, body: RaiseTicketBody): Promise<WriteResponse<SupportTicket>> {
      return withTransaction(db, async (tx) => {
        const subject = body.subject.trim();
        assertRule(subject.length > 0, "Give the ticket a subject so support knows what it is about");
        const me = await supportRepo.author(tx, claims.sub);
        // Documents, then ids: nothing is locked here (the ticket does not exist yet), so the
        // sequence row is the first and only lock this write takes.
        const id = await allocateId(tx, "support");
        await supportRepo.insertTicket(tx, {
          id, topic: body.topic, subject, priority: body.priority, status: "Open",
          byUser: claims.sub, role: claims.role, loc: claims.loc, screen: body.screen.trim(),
        });
        // The browser has always taken a ticket with no detail — the Send button is disabled on an
        // empty subject and nothing else — so a first message is written only if there is one.
        const detail = body.body.trim();
        if (detail) await supportRepo.appendMessage(tx, id, "user", me.name, detail);
        const result = (await supportRepo.one(tx, id))!;
        await emitChanged(tx, ["tickets"]);
        return { result, changed: ["tickets"], message: `${id} raised — support replies to urgent tickets within the hour` };
      });
    },

    async reply(claims: AccessClaims, id: string, body: ReplyToTicketBody): Promise<WriteResponse<SupportTicket>> {
      return withTransaction(db, async (tx) => {
        const row = await mine(tx, id, claims.sub);
        const text = body.body.trim();
        assertRule(text.length > 0, "Write a reply first");
        assertRule(row.status !== "Closed", `${id} is closed — raise a new ticket if it has come back`);
        const me = await supportRepo.author(tx, claims.sub);
        await supportRepo.appendMessage(tx, id, "user", me.name, text);
        const next = statusAfterReply(row.status);
        if (next !== row.status) {
          assertTransition(SUPPORT_TRANSITIONS, row.status, next, id);
          await supportRepo.setStatus(tx, id, next);
        }
        const result = (await supportRepo.one(tx, id))!;
        await emitChanged(tx, ["tickets"]);
        return { result, changed: ["tickets"], message: `Reply sent on ${id}` };
      });
    },

    async setStatus(claims: AccessClaims, id: string, body: SetTicketStatusBody): Promise<WriteResponse<SupportTicket>> {
      return withTransaction(db, async (tx) => {
        const row = await mine(tx, id, claims.sub);
        assertRule(mayUserSet(body.st),
          `Only support moves a ticket to ${body.st.toLowerCase()} — you can mark it resolved or close it`);
        assertTransition(SUPPORT_TRANSITIONS, row.status, body.st, id);
        await supportRepo.setStatus(tx, id, body.st);
        const result = (await supportRepo.one(tx, id))!;
        await emitChanged(tx, ["tickets"]);
        return { result, changed: ["tickets"], message: `${id} — ${body.st.toLowerCase()}` };
      });
    },

    async rate(claims: AccessClaims, id: string, body: RateTicketBody): Promise<WriteResponse<SupportTicket>> {
      return withTransaction(db, async (tx) => {
        const row = await mine(tx, id, claims.sub);
        assertRule(mayRate(row.status), `${id} is not finished yet — rate it once support has resolved it`);
        await supportRepo.setRating(tx, id, body.rating);
        const result = (await supportRepo.one(tx, id))!;
        await emitChanged(tx, ["tickets"]);
        return { result, changed: ["tickets"], message: `Thank you — ${body.rating} out of 5 recorded against ${id}` };
      });
    },
  };
}
```

**No `appendHistory` anywhere in this module, on purpose.** A support ticket's history *is* its conversation: `support_messages` already holds who said what and when, and the status is a column beside it. Writing a second trail into `document_history` for a document whose whole content is a trail would give the drawer two lists to render and two to keep in step. Task 11 records it.

- [ ] **Step 5: Mount the four writes**

In `apps/api/src/modules/support/routes.ts`, beside the list:

```ts
  mount(app, routes.raiseTicket, async (req) => svc.raise(req.user, req.body));
  mount(app, routes.replyToTicket, async (req) => svc.reply(req.user, req.params.id, req.body));
  mount(app, routes.setTicketStatus, async (req) => svc.setStatus(req.user, req.params.id, req.body));
  mount(app, routes.rateTicket, async (req) => svc.rate(req.user, req.params.id, req.body));
```

There is no `requireLoc` here: a support ticket has no location to scope on beyond the one it records, and ownership is the scope. `mount` attaches the idempotency preHandler to all four because they are non-GET and non-public.

- [ ] **Step 6: Prove the status lock**

Comment out the `.for("update")` in `supportRepo.head` and re-run *"writes one status, not two, when two taps race"*. It must fail. Restore the lock and say in the report that you proved it. If it passes either way, check that `warmPool(app.testDb!, 2)` ran and that the two requests carry different idempotency keys.

- [ ] **Step 7: Run the gate**

Run: `pnpm --filter @rch/api test && pnpm turbo typecheck --force && pnpm lint`
Expected: `@rch/api` PASS; `@rch/ui` still red on Task 1's contract changes, as in Task 4.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/support
git commit -m "$(cat <<'EOF'
Move the support desk to the server

Four writes, all scoped to the caller's own ticket, all in one transaction, all announcing the
same one collection. A ticket somebody else raised answers 404 rather than 403: it is not that
you may not touch it, it is that it is not yours to know about.

Three refusals are new, because the browser had none. Marking a ticket "with support" or
"waiting on you" is the desk's word about its own queue and is refused with a sentence that
says what you *can* do; rating a ticket that is still running is refused until it is resolved;
replying to a closed one is refused with an invitation to raise a new one. The two refusals
that existed — no subject, no reply text — arrive word for word from the store.

An empty body still raises a ticket, which is what the screen has always allowed: the Send
button watches the subject and nothing else, and detail is what the conversation is for. The
spec's row says both are required; this is the one place it is not followed and the amendment
says so rather than the code quietly disagreeing.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `reports` — the store's ledger, and the credit the till could not see

*(Wave 2. It owns `apps/api/src/modules/reports/**`, `apps/api/src/modules/pos/{repo,service}.ts`, `apps/api/src/lib/credit.ts` and **all of `packages/contract/**` in this wave** — Task 1 finished with the contract in wave 1 and no other wave-2 task touches it.)*

**Files:**
- Create: `packages/contract/src/schemas/reports.ts`, `apps/api/src/lib/credit.ts`
- Modify: `packages/contract/src/routes.ts`, `packages/contract/src/routes.test.ts`, `packages/contract/src/index.ts`, `packages/contract/src/types.ts`, `apps/api/src/modules/reports/{routes,service,repo,reports.test}.ts`, `apps/api/src/modules/pos/repo.ts`, `apps/api/src/modules/pos/service.ts`, `apps/api/src/modules/pos/pos.test.ts` *(only if it names `posRepo.staffCreditTaken` directly)*

**Interfaces:**
- Consumes: `StockLocSchema`, `PayerKindSchema`, `Qty`, `Money`, `IsoTime` (contract); `ledgerRow`, `ledgerTotals`, `creditRoom`, `STAFF_CREDIT_LIMIT` from `@rch/domain` (Task 2 and earlier); `monthStartIST` (`apps/api/src/lib/time.ts`); `mount`.
- Produces (imported by Task 10 — **not** by Task 8, which imports nothing from the workspace by design):
  ```ts
  // packages/contract/src/schemas/reports.ts
  export const StockLedgerQuerySchema = z.strictObject({
    loc: StockLocSchema, days: z.coerce.number().int().min(1).max(365).default(30),
  });
  export const StockLedgerRowSchema = z.object({ it: z.string(), opening: Qty, recd: Qty, issued: Qty, closing: Qty });
  export const StockLedgerResponseSchema = z.strictObject({
    loc: StockLocSchema, from: IsoTime, to: IsoTime, rows: z.array(StockLedgerRowSchema),
  });
  export const CreditParamsSchema = z.strictObject({ kind: PayerKindSchema, id: z.string().min(1).max(64) });
  export const CreditResponseSchema = z.strictObject({
    kind: PayerKindSchema, id: z.string(), name: z.string(),
    /** Midnight on the first of the month, in the hospital's zone — the window the ceiling is settled over. */
    since: IsoTime,
    taken: Money,
    /** The ceiling only binds `staff`: credit is what the "Staff credit" tender creates and that
     *  tender carries a staff payer. For `patient` and `dept` the same number is reported for
     *  symmetry and `taken` is structurally 0 — the row exists so a screen can say so rather
     *  than having to know which kinds have a ceiling. */
    limit: Money,
    room: Money,
  });

  // packages/contract/src/types.ts — the z.infer aliases both sides import by name
  export type StockLedgerQuery = z.infer<typeof R.StockLedgerQuerySchema>;
  export type StockLedgerRow = z.infer<typeof R.StockLedgerRowSchema>;
  export type StockLedgerResponse = z.infer<typeof R.StockLedgerResponseSchema>;
  export type CreditParams = z.infer<typeof R.CreditParamsSchema>;
  export type CreditResponse = z.infer<typeof R.CreditResponseSchema>;

  // packages/contract/src/routes.ts
  routes.stockLedger  GET /reports/stock-ledger          access ["store", "manager", "buyer", "prod"]
  routes.creditReport GET /reports/credit/:kind/:id      access ["counter", "manager"]

  // apps/api/src/lib/credit.ts
  export function creditTakenThisMonth(db: Db | Tx, kind: PayerKind, payerId: string, at?: Date): Promise<{ taken: number; since: Date }>;
  ```

**Why this task also edits `pos`.** `posRepo.staffCreditTaken` is the query that decides whether a bill breaches the ceiling. The credit report has to return *the same number* — a report that disagrees with the refusal is worse than no report. §5.1: *"Cross-cutting behaviour is a plugin or a helper, never copied."* So the query moves to `apps/api/src/lib/credit.ts` and gets two callers: `pos`'s service, which refuses on it, and `reports`'s service, which prints it. A test in `reports.test.ts` asserts the two agree on the same payer.

**Why `stockLedger` takes a `StockLoc` and not a `LocKey`.** The store keeper has to be able to run this over `quarantine` — that is the only view anyone has of what was rejected, Phase 5 having declined a quarantine ledger of its own. `StockLocSchema` is the reporting union and this is a report; no write body changes.

**Why the ledger's window is `days` and not `from`/`to`.** One parameter the caller can put in a dropdown, one boundary to compute, one thing to get wrong. `from` = now − `days` × 86 400 000 and `to` = now, both returned in the response so the report's foot can print what it actually measured. If somebody later needs a fixed month, that is a second query, not a fourth parameter on this one.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/reports/reports.test.ts` (replacing Task 3's placeholder case). The file opens with the same harness every DB-backed module suite has — `buildTestApp` migrates but does not seed, and `authHeaders` throws `no user u1 - did you seed?` without the `beforeEach`:

```ts
let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "reports" }); await app.ready(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });
afterAll(async () => { await app.close(); });

const round2 = (v: number) => Math.round(v * 100) / 100;
/** Pick payers by filtering the fixtures, never by naming a number — the seed moves. */
const STAFF = FX.STAFF[0];
const DEPT = FX.DEPTS[0];

const ledger = async (loc: string, days = 30): Promise<StockLedgerResponse> => {
  const res = await app.inject({ method: "GET", url: `/api/v1/reports/stock-ledger?loc=${loc}&days=${days}`, headers: await authHeaders(app, "u3") });
  expect(res.statusCode).toBe(200);
  return res.json() as StockLedgerResponse;
};
const total = (b: StockLedgerResponse, col: "opening" | "recd" | "issued" | "closing") =>
  round3(b.rows.reduce((t, r) => t + r[col], 0));

const credit = async (p: { kind: "patient" | "staff" | "dept"; id: string }): Promise<CreditResponse> => {
  const res = await app.inject({ method: "GET", url: `/api/v1/reports/credit/${p.kind}/${p.id}`, headers: await authHeaders(app, "u1") });
  expect(res.statusCode).toBe(200);
  return res.json() as CreditResponse;
};
/** Sell on credit until the ceiling refuses, and hand back the refusal. `water` is on the coffee
 *  shop's menu with plenty on the shelf; 80 x its price clears STAFF_CREDIT_LIMIT in two bills. */
const payUntilRefused = async (payer: { kind: "staff"; id: string; name: string }) => {
  for (let i = 0; i < 5; i++) {
    const res = await app.inject({
      method: "POST", url: "/api/v1/bills",
      headers: { ...(await authHeaders(app, "u1")), "idempotency-key": randomUUID() },
      payload: { loc: "coffee", tender: "Staff credit", payer, lines: [{ it: "water", qty: 80 }] },
    });
    if (res.statusCode === 422) return res;
  }
  throw new Error("the ceiling never refused — check STAFF_CREDIT_LIMIT and the item's price");
};

describe("GET /reports/stock-ledger", () => {
  it("opens at what the moves before the window sum to and closes at the balance", async () => {
    // Pick the item by filtering rather than naming one: the seed moves.
    const [{ itemKey: it }] = await app.db.select({ itemKey: s.stockBalances.itemKey }).from(s.stockBalances)
      .where(and(eq(s.stockBalances.loc, "store"), gt(s.stockBalances.onHand, 0))).limit(1);

    const body = await ledger("store", 30);
    const row = body.rows.find((r) => r.it === it)!;

    // Spec §12: "db:rebuild-balances reproduces stock_balances exactly from stock_moves." The
    // report is the same sum by another route, so its closing column has to agree with the cache
    // — and that is the whole reason this report is a server query and not browser arithmetic.
    const [bal] = await app.db.select().from(s.stockBalances).where(and(eq(s.stockBalances.loc, "store"), eq(s.stockBalances.itemKey, it)));
    expect(row.closing).toBe(Number(bal.onHand));
    expect(row.closing).toBe(round3(row.opening + row.recd - row.issued));
  });

  it("puts a receipt's rejected quantity on quarantine's ledger and not on the store's", async () => {
    const before = await ledger("quarantine");
    await postMovesForTest(/* a grn_reject of 3 at quarantine — see the note below */);
    const after = await ledger("quarantine");
    expect(total(after, "recd") - total(before, "recd")).toBe(3);
  });

  it("counts a window, not everything", async () => {
    const wide = await ledger("store", 365);
    const narrow = await ledger("store", 1);
    expect(total(narrow, "recd")).toBeLessThanOrEqual(total(wide, "recd"));
    // Yesterday's receipts are this window's opening balance, not this window's receipts.
    expect(total(narrow, "opening")).toBeGreaterThanOrEqual(total(wide, "opening"));
    // And whatever the window, the close is the same shelf.
    expect(total(narrow, "closing")).toBe(total(wide, "closing"));
  });

  it("is not a counter operator's report", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/reports/stock-ledger?loc=store", headers: await authHeaders(app, "u1") });
    expect(res.statusCode).toBe(404);
  });

  it("refuses a location that is not one", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/reports/stock-ledger?loc=canteen", headers: await authHeaders(app, "u3") });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /reports/credit/:kind/:id", () => {
  it("answers with exactly the number the till refuses on", async () => {
    // `given.bill` takes the bill's `total` as well as its lines — it is what the credit sum
    // adds up, and the builder does not derive it.
    await given.bill(app.db, { loc: "coffee", tender: "Staff credit", payer: STAFF, total: 20, lines: [{ it: "water", qty: 1, rate: 20 }] });
    const body = await credit(STAFF);

    // The other half of the same fact: sell until the ceiling refuses, and the refusal's own
    // `details.taken` must equal what the report says immediately afterwards.
    const refusal = await payUntilRefused(STAFF);
    const after = await credit(STAFF);
    expect((refusal.json() as { error: { details: { taken: number } } }).error.details.taken).toBe(after.taken);
    expect(body.room).toBe(creditRoom(body.taken));
    expect(body.limit).toBe(STAFF_CREDIT_LIMIT);
  });

  it("counts the calendar month across every outlet, not one till's week", async () => {
    // A bill at the restaurant and a bill at the coffee shop both count against one person.
    await given.bill(app.db, { loc: "rest", tender: "Staff credit", payer: STAFF, total: 20, lines: [{ it: "water", qty: 1, rate: 20 }] });
    const a = (await credit(STAFF)).taken;
    await given.bill(app.db, { loc: "coffee", tender: "Staff credit", payer: STAFF, total: 20, lines: [{ it: "water", qty: 1, rate: 20 }] });
    expect((await credit(STAFF)).taken).toBe(round2(a + 20));
    // `since` is midnight on the 1st in IST, i.e. 18:30 UTC on the last day of the previous month.
    const since = new Date((await credit(STAFF)).since);
    expect(since.toISOString()).toBe(monthStartIST().toISOString());
  });

  it("counts only what the credit tender created", async () => {
    const before = (await credit(STAFF)).taken;
    await given.bill(app.db, { loc: "coffee", tender: "Cash", payer: STAFF, total: 20, lines: [{ it: "water", qty: 1, rate: 20 }] });
    expect((await credit(STAFF)).taken).toBe(before);
  });

  it("answers zero for a payer whose tender never creates credit", async () => {
    const body = await credit({ kind: "dept", id: DEPT.id });
    // Only the "Staff credit" tender runs up a balance, and it carries a staff payer. A
    // department's report is structurally zero — the row exists so a screen can say so.
    expect(body.taken).toBe(0);
    expect(body.room).toBe(body.limit);
  });

  it("is a 404 for a payer who is not on the roster", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/reports/credit/staff/RC-0000", headers: await authHeaders(app, "u1") });
    expect(res.statusCode).toBe(404);
  });
});
```

`postMovesForTest` in the second case: **do not call `postMoves` from a test** — build the receipt through the endpoint (`POST /purchase-orders/:id/receive` with a rejection, exactly as `grn.test.ts` does) or, if that is too much setup for this file, drop that case and rely on `grn.test.ts`'s own quarantine assertions plus a case that simply asks for `loc=quarantine` and gets a 200 with a well-formed body. Say which you chose in the report. The point being pinned is that the report accepts a `StockLoc`, not that the GRN works.

Add to `packages/contract/src/routes.test.ts`'s existing coverage — no `SAMPLES` entry is needed for a GET with no body, but the manifest's "every param-less GET is probed" contract in `apps/api/src/contract.test.ts` means `GET /reports/stock-ledger` will be probed with **no query string at all**. `loc` has no default, so the probe would be a 400. Give `loc` a default of `"store"`:

```ts
export const StockLedgerQuerySchema = z.strictObject({
  /** Defaulted, and not because a caller should omit it: `apps/api/src/contract.test.ts` probes
   *  every param-less GET in the manifest with a bare URL, and a required query would make that
   *  probe a 400. The central store is the report's home screen, so it is also its default. */
  loc: StockLocSchema.default("store"),
  days: z.coerce.number().int().min(1).max(365).default(30),
});
```

**And check what `contract.test.ts` does about `access`** before assuming the probe passes: it signs in as somebody. If it probes as a single fixed role and that role is not in `stockLedger`'s access list, the probe gets a 404 and fails. Read `apps/api/src/contract.test.ts` first; if it probes per role, nothing to do, and if it probes as one role, either that role is in the list or the route is excluded there the way `GET /events` is — and the exclusion is commented with the reason.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rch/api test -- src/modules/reports && pnpm --filter @rch/contract test`
Expected: FAIL — both routes are 404 and the schemas do not exist.

- [ ] **Step 3: Declare the two reads**

Create `packages/contract/src/schemas/reports.ts` with the five schemas from the Interfaces block above, each carrying the comment that explains it. Export the module from `src/index.ts` and add the five `z.infer` aliases to `src/types.ts` — `types.ts` holds aliases only and declares nothing, which is what `packages/contract/CLAUDE.md` says and what every other document type in it already does. Then, in `routes.ts`, after the support entries:

```ts
  // ---- Reports (spec §9.1, Phase 6). Two figures a caller cannot compute from its own snapshot:
  // the ledger, which needs `stock_moves` and which the browser had to reconstruct backwards from
  // receipts and issues, and a payer's credit for the calendar month, which needs every outlet's
  // bills and which the till could only approximate from its own seven days. Every other report
  // and every dashboard reads a slice the snapshot already carries whole and stays in the browser.
  stockLedger:  defineRoute({ method: "GET", path: "/reports/stock-ledger",     access: ["store", "manager", "buyer", "prod"], query: StockLedgerQuerySchema, response: StockLedgerResponseSchema }),
  creditReport: defineRoute({ method: "GET", path: "/reports/credit/:kind/:id", access: ["counter", "manager"],                params: CreditParamsSchema,   response: CreditResponseSchema }),
```

- [ ] **Step 4: Move the credit query into `lib/`**

Create `apps/api/src/lib/credit.ts`:

```ts
import { and, eq, gte, sql } from "drizzle-orm";
import type { PayerKind } from "@rch/contract";
import * as s from "../db/schema/index.js";
import type { Db } from "../db/client.js";
import type { Tx } from "./db.js";
import { monthStartIST } from "./time.js";

/**
 * What one payer has put on credit inside the current calendar month, in the hospital's zone.
 *
 * Two callers, on purpose (spec §5.1): `modules/pos` refuses a bill on it and `modules/reports`
 * prints it. A report that disagreed with the refusal would be worse than no report — and the
 * counter's own screen has been showing a different, smaller figure (its own outlet, its own
 * seven days) with an apology printed underneath it since Phase 3.
 *
 * Credit, and only credit: a bill the same person paid cash for in their own name is not credit
 * and must not eat their room.
 */
export async function creditTakenThisMonth(
  db: Db | Tx, kind: PayerKind, payerId: string, at: Date = new Date(),
): Promise<{ taken: number; since: Date }> {
  const since = monthStartIST(at);
  const [row] = await db.select({ total: sql<string>`coalesce(sum(${s.bills.total}), 0)` }).from(s.bills)
    .where(and(eq(s.bills.tender, "Staff credit"), eq(s.bills.payerKind, kind), eq(s.bills.payerId, payerId), gte(s.bills.at, since)));
  return { taken: Math.round(Number(row?.total ?? 0) * 100) / 100, since };
}
```

Delete `staffCreditTaken` from `apps/api/src/modules/pos/repo.ts` and change `modules/pos/service.ts`'s one call site to `creditTakenThisMonth(tx, "staff", payer.id)`. **Read the existing implementation before deleting it** and carry every detail across — the `payerKind` filter and the tender filter are both there for a reason a test pins (`pos.test.ts`'s `RC-1902` / `RC-1902-b` case). `pos.test.ts` must stay green untouched; if it references `posRepo.staffCreditTaken` directly, re-point it at `creditTakenThisMonth` and say so in the commit body.

**`posRepo.lockStaffCredit` stays exactly where it is.** Spec §16 records that the sale takes a per-payer `pg_advisory_xact_lock` *before* summing, so two tills cannot both read the same room and both post inside it. That lock belongs to the **sale**, not to the sum: the report is a read, needs no lock, and must not take one — an advisory lock held by a report would serialise every till behind whoever opened the credit screen. Move only the query, and leave the lock and its call order in `pos`.

- [ ] **Step 5: Write the ledger query**

`apps/api/src/modules/reports/repo.ts`:

```ts
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import * as s from "../../db/schema/index.js";

/**
 * Two aggregates over `stock_moves` for one location: what the moves before the window sum to per
 * item, and the window's own signed moves per item. Both hit `stock_moves_loc_item_at_idx`
 * — `EXPLAIN` on either must not show a sequential scan (spec §12, Performance).
 */
export const reportsRepo = {
  async openingAt(db: Db, loc: string, from: Date): Promise<Map<string, number>> {
    const rows = await db.select({ it: s.stockMoves.itemKey, total: sql<string>`sum(${s.stockMoves.qty})` })
      .from(s.stockMoves).where(and(eq(s.stockMoves.loc, loc), lt(s.stockMoves.at, from))).groupBy(s.stockMoves.itemKey);
    return new Map(rows.map((r) => [r.it, Number(r.total)]));
  },
  /** The window's moves split by sign in SQL, so a busy shelf does not travel row by row. */
  async movedIn(db: Db, loc: string, from: Date, to: Date): Promise<Map<string, { recd: number; issued: number }>> {
    const rows = await db.select({
      it: s.stockMoves.itemKey,
      recd: sql<string>`sum(case when ${s.stockMoves.qty} > 0 then ${s.stockMoves.qty} else 0 end)`,
      issued: sql<string>`sum(case when ${s.stockMoves.qty} < 0 then -${s.stockMoves.qty} else 0 end)`,
    }).from(s.stockMoves)
      .where(and(eq(s.stockMoves.loc, loc), gte(s.stockMoves.at, from), lt(s.stockMoves.at, to)))
      .groupBy(s.stockMoves.itemKey);
    return new Map(rows.map((r) => [r.it, { recd: Number(r.recd), issued: Number(r.issued) }]));
  },
};
```

`apps/api/src/modules/reports/service.ts`:

```ts
export function createReportsService(db: Db) {
  return {
    async stockLedger(q: StockLedgerQuery): Promise<StockLedgerResponse> {
      const to = new Date();
      const from = new Date(to.getTime() - q.days * 86_400_000);
      const [before, inWindow] = await Promise.all([reportsRepo.openingAt(db, q.loc, from), reportsRepo.movedIn(db, q.loc, from, to)]);
      // Every item this location has ever carried, so a line that opened at 40 and moved nothing
      // still appears — the shelf is there whether or not this window touched it.
      const keys = [...new Set([...before.keys(), ...inWindow.keys()])].sort();
      const rows = keys.map((it) => {
        const w = inWindow.get(it) ?? { recd: 0, issued: 0 };
        // `ledgerRow` takes signed moves; the SQL has already split them, so hand it the two
        // numbers as a two-element window rather than reimplementing the arithmetic here.
        return ledgerRow(it, before.get(it) ?? 0, [w.recd, -w.issued]);
      });
      return { loc: q.loc, from: from.toISOString(), to: to.toISOString(), rows };
    },

    async credit(p: CreditParams): Promise<CreditResponse> {
      const payer = await reportsRepo.payer(db, p.kind, p.id);
      if (!payer) throw new NotFoundError(`There is nobody on the roster with the number ${p.id}.`);
      const { taken, since } = await creditTakenThisMonth(db, p.kind, p.id);
      return { kind: p.kind, id: p.id, name: payer.name, since: since.toISOString(), taken, limit: STAFF_CREDIT_LIMIT, room: creditRoom(taken) };
    },
  };
}
```

`reportsRepo.payer` is a second reader of one table, not a second copy of a rule, so it stays local:

```ts
  /** The same lookup the till makes before it takes a charge (`posRepo.payer`). Inactive payers
   *  are still resolvable here: a report on somebody who has left the hospital is a report, not a
   *  sale, and refusing it would hide the credit they still owe. */
  async payer(db: Db, kind: PayerKind, id: string) {
    const [row] = await db.select().from(s.payers).where(and(eq(s.payers.kind, kind), eq(s.payers.id, id)));
    return row ?? null;
  },
```

`apps/api/src/modules/reports/routes.ts`:

```ts
export default fp(async (app) => {
  const svc = createReportsService(app.db);
  mount(app, routes.stockLedger, async (req) => svc.stockLedger(req.query));
  mount(app, routes.creditReport, async (req) => svc.credit(req.params));
}, { name: "module:reports", dependencies: ["auth", "rbac", "idempotency", "db"] });
```

- [ ] **Step 6: Prove there is no sequential scan**

With a seeded database running:

```bash
pnpm db:up && pnpm --filter @rch/api db:migrate && pnpm --filter @rch/api db:seed --force
psql "postgres://rch:rch@localhost:5439/rch" -c "explain analyze select item_key, sum(qty) from stock_moves where loc = 'store' and at < now() - interval '30 days' group by item_key;"
```

Expected: an `Index Scan` or `Bitmap Index Scan` on `stock_moves_loc_item_at_idx`, not `Seq Scan on stock_moves`. **Paste the plan into the task report** — Task 12 quotes it as the evidence line for §12's "Indexes as listed in §7.2 exist and `EXPLAIN` on the snapshot queries shows no sequential scan on `stock_moves`". On a seed this small Postgres may legitimately choose a sequential scan because the table is a handful of pages; if it does, re-run after `analyze stock_moves;` and, if it still does, record **that** — with the row count — rather than forcing a plan with `enable_seqscan = off`, and say the index exists and is chosen at production cardinality.

- [ ] **Step 7: Run the gate**

Run: `pnpm turbo typecheck test --force && pnpm lint`
Expected: `@rch/api` and both packages PASS; `@rch/ui` still red on Task 1's contract changes.

- [ ] **Step 8: Commit**

```bash
git add packages/contract apps/api
git commit -m "$(cat <<'EOF'
Answer the two questions the browser could only guess at

The central store's ledger stops being reconstructed. The browser held no stock moves at all, so
its opening balance was today's closing worked backwards through goods receipts and collected
tickets — arithmetic a withdrawn ticket walked by exactly the quantity it never moved. The query
sums the moves either side of the window and the report's closing column now has to equal
stock_balances, which is the same fact db:rebuild-balances checks from the other direction. It
takes a StockLoc, so quarantine has a ledger too, which is the only view anyone has of what a
goods receipt turned away.

Staff credit stops being two numbers. The till was summing its own outlet's last seven days and
printing an apology underneath; the server settles the ceiling over the calendar month across
every counter. One query now, in lib/, with the refusal and the report reading it — a report
that disagreed with the refusal would be worse than no report at all.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The chart — alerts, production values, and the switches go-live needs

*(Wave 2. It owns `deploy/**` **except `deploy/chart/rch/ci/install-test.sh`, which is Task 8's**, and `.github/workflows/deploy.yml`. Task 8 owns `.github/workflows/ci.yml`. No file is shared.)*

**Files:**
- Create: `deploy/chart/rch/templates/prometheusrule.yaml`
- Modify: `deploy/chart/rch/values.yaml`, `deploy/chart/rch/values-prod.yaml`, `deploy/chart/rch/values-staging.yaml`, `deploy/chart/rch/templates/api-deployment.yaml`, `deploy/chart/rch/tests/render.test.sh`, `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: `apps/api/src/plugins/metrics.ts`'s metric names — `http_request_duration_seconds` (histogram, labels `method`/`route`/`status`), `sse_clients`, `sse_listener_up`, `sequence_allocations_total{kind}`, `pg_pool_total`/`pg_pool_idle`/`pg_pool_waiting`. **Read that file rather than trusting this list**; an alert on a metric name that does not exist is an alert that never fires.
- Produces: `values.yaml`'s `alerts` block, consumed by nothing but the template; the completed `values-prod.yaml`, read by `deploy.yml` and quoted by Task 11's runbook.

**What is wrong with `values-prod.yaml` today.** It is four lines. It sets `replicas: 3`, an HPA range, an example CORS origin, an example ingress host, `externalSecret.enabled: true` with `remoteKey: rch/prod`, and `serviceMonitor.enabled: true` — and inherits everything else from `values.yaml`, including `resources` sized for staging, a `certificateArn` of `""` (so the ALB has no TLS certificate and the ingress silently comes up HTTP-only), and no alerts at all. Production also wants the two annotations §11 implies but never spells out — access logs and deletion protection on the load balancer — and a `topologySpreadConstraints` so three replicas do not land on one node and lose the PDB's whole point.

- [ ] **Step 1: Write the failing chart assertions**

Add to `deploy/chart/rch/tests/render.test.sh`, in the `values-prod.yaml` block:

```bash
# Phase 6: the five §12 alerts plus the SSE listener ship with the chart, so the alert text lives
# beside the metric it reads instead of only in the runbook.
grep -q 'kind: PrometheusRule' <<<"$out"
for a in RchApiHigh5xxRate RchApiHighLatencyP95 RchApiDown RchApiPoolSaturated RchSseListenerDown; do
  grep -q "alert: $a" <<<"$out" || { echo "missing alert: $a"; exit 1; }
done
# Every rule must name a metric the API actually publishes. `sse_listener_up` and
# `http_request_duration_seconds` are decorated in apps/api/src/plugins/metrics.ts; an alert on a
# metric that does not exist is an alert that never fires, which is worse than no alert.
grep -q 'http_request_duration_seconds_count' <<<"$out"
grep -q 'sse_listener_up' <<<"$out"
# Every alert carries a runbook link, so whoever is woken has somewhere to go.
[ "$(grep -c 'runbook_url:' <<<"$out")" -ge 5 ]

# TLS must be wired, and must never render as an EMPTY annotation — the ALB controller reads
# `certificate-arn: ""` and fails, where an absent annotation falls back cleanly.
# `templates/ingress.yaml:7-9` already guards it on a non-empty `certificateArn`, so the
# assertion has to hold in BOTH states: nothing rendered with the FILL placeholder in place,
# and the real value rendered once one is supplied.
! grep -q 'certificate-arn: *$' <<<"$out"
out_tls=$(helm template rch . -f values-prod.yaml --set image.registry=r,image.tag=t,ingress.certificateArn=arn:aws:acm:x)
grep -q 'alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:x' <<<"$out_tls"
# Three replicas that land on one node make the PodDisruptionBudget decorative.
grep -q 'topologySpreadConstraints' <<<"$out"
# Production resources must be its own, not staging's inherited defaults. `-A6` never reaches
# `resources:` (the api container is `- name: api` and resources is nine lines below it), which
# is why the file's existing tests use a sed range — copy that shape, not a fixed window.
sed -n '/name: api$/,/readinessProbe:/p' <<<"$out" | grep -q 'memory: 1Gi'

# The alerts are off wherever the ServiceMonitor is off: a PrometheusRule with no Prometheus
# Operator installed is a CRD apply that fails the whole release.
out_staging_norule=$(helm template rch . -f values-staging.yaml --set image.registry=r,image.tag=t,secrets.values.DATABASE_URL=x,secrets.values.JWT_PRIVATE_KEY=x,secrets.values.JWT_PUBLIC_KEY=x)
! grep -q 'kind: PrometheusRule' <<<"$out_staging_norule"
```

Run: `pnpm helm:test`
Expected: FAIL on `kind: PrometheusRule`.

- [ ] **Step 2: Write the rule template**

`deploy/chart/rch/templates/prometheusrule.yaml`:

```yaml
{{- if .Values.serviceMonitor.enabled }}
{{- /*
  Spec §12, Operability: "Alerts (documented in deploy/RUNBOOK.md): 5xx rate > 1 % over 5 min,
  p95 latency > 1 s, readiness failing, DB connections > 80 %, RDS free storage < 20 %."

  Three of the five read metrics this API publishes and ship here, beside the code that emits
  them. The two RDS rules need CloudWatch metrics this cluster does not have — they are wired at
  the observability-stack level and stay in the runbook, which says so. `sse_listener_up` is a
  sixth, added because a pod whose LISTEN connection is down serves every request correctly and
  quietly stops delivering live updates, which no other alert here would notice.

  Gated on serviceMonitor.enabled: without the Prometheus Operator the PrometheusRule CRD does
  not exist and applying one fails the whole release.
*/}}
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: {{ .Release.Name }}-api
  labels: { {{ include "rch.labels" . }}, app.kubernetes.io/component: api }
spec:
  groups:
    - name: {{ .Release.Name }}-api
      rules:
        - alert: RchApiHigh5xxRate
          expr: |
            sum(rate(http_request_duration_seconds_count{job=~".*{{ .Release.Name }}-api.*",status=~"5.."}[5m]))
              / sum(rate(http_request_duration_seconds_count{job=~".*{{ .Release.Name }}-api.*"}[5m])) > {{ .Values.alerts.errorRate }}
          for: 5m
          labels: { severity: critical }
          annotations:
            summary: "More than {{ .Values.alerts.errorRate }} of requests are failing"
            description: "One in {{ div 1.0 .Values.alerts.errorRate }} requests is a 5xx over the last five minutes."
            runbook_url: "{{ .Values.alerts.runbookUrl }}#9-alerts"
        - alert: RchApiHighLatencyP95
          expr: |
            histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{job=~".*{{ .Release.Name }}-api.*"}[5m])) by (le)) > {{ .Values.alerts.p95Seconds }}
          for: 10m
          labels: { severity: warning }
          annotations:
            summary: "p95 latency is over {{ .Values.alerts.p95Seconds }}s"
            description: "Spec §12 budgets 150ms for /snapshot and 200ms for a write; this fires an order of magnitude above that."
            runbook_url: "{{ .Values.alerts.runbookUrl }}#9-alerts"
        - alert: RchApiDown
          # Prometheus Operator discovers targets from the Service's Endpoints, which lists only
          # pods whose readiness probe passes — so a pod stuck failing /readyz leaves the target
          # set and this is what "readiness failing" looks like from outside.
          expr: up{job=~".*{{ .Release.Name }}-api.*"} == 0
          for: 2m
          labels: { severity: critical }
          annotations:
            summary: "An API pod is not being scraped"
            runbook_url: "{{ .Values.alerts.runbookUrl }}#3-roll-back"
        - alert: RchApiPoolSaturated
          expr: |
            max(pg_pool_waiting{job=~".*{{ .Release.Name }}-api.*"}) > 0
              and max(pg_pool_idle{job=~".*{{ .Release.Name }}-api.*"}) == 0
          for: 5m
          labels: { severity: warning }
          annotations:
            summary: "Requests are queueing for a database connection"
            description: "Ten connections per pod (spec §11.2). Sustained waiting means a slow query or a leaked transaction, not load."
            runbook_url: "{{ .Values.alerts.runbookUrl }}#9-alerts"
        - alert: RchSseListenerDown
          # Not wired into /readyz, deliberately — see RUNBOOK §10. A pod whose listener is down
          # answers every request correctly; what it has stopped doing is delivering other pods'
          # writes to its own browsers. Five minutes, because the plugin reconnects itself.
          expr: min(sse_listener_up{job=~".*{{ .Release.Name }}-api.*"}) == 0
          for: 5m
          labels: { severity: warning }
          annotations:
            summary: "A pod's live-update stream has gone deaf"
            runbook_url: "{{ .Values.alerts.runbookUrl }}#10-server-sent-events-sse"
{{- end }}
```

**Read `deploy/chart/rch/templates/_helpers.tpl` before writing a line of this template.** It defines exactly five helpers — `rch.name`, `rch.labels`, `rch.image`, `rch.secretName`, `rch.sa`, `rch.envList` — and **there is no `rch.fullname`**: every other template in this chart names its objects `{{ .Release.Name }}-api`. `rch.labels` renders as **one comma-joined line**, meant for embedding inside a flow mapping `{ … }` — using it with `nindent` under a block-style `labels:` produces invalid YAML and `helm template` errors out. The two forms above are the ones the rest of the chart uses; copy them, do not invent a third.

Likewise for the `job` matcher: copy whatever `templates/servicemonitor.yaml` actually produces rather than the `job=~".*-api.*"` written here, which is a placeholder. An alert whose selector matches nothing is silence.

- [ ] **Step 3: Add the values it reads**

In `deploy/chart/rch/values.yaml`, after `serviceMonitor`:

```yaml
# Thresholds for the PrometheusRule (rendered only when serviceMonitor.enabled). Spec §12 sets
# the first two; the last is the link an on-call engineer follows at three in the morning.
alerts:
  errorRate: 0.01          # 5xx share of all requests, over 5 minutes
  p95Seconds: 1            # §12's ceiling; the SLO underneath it is 150ms/200ms, measured by the load check
  runbookUrl: https://github.com/<org>/<repo>/blob/production/deploy/RUNBOOK.md
```

- [ ] **Step 4: Complete `values-prod.yaml`**

Replace it wholesale. It is currently three inherited lines; it becomes the file that describes production:

```yaml
# What the hospital runs. Everything here is a deliberate difference from values.yaml, which is
# sized for a laptop and a kind cluster. The placeholders marked FILL are the five facts only the
# account owner has; deploy/RUNBOOK.md §2 "First-time cluster setup" lists where each comes from.
image:
  registry: ""                      # FILL: <account>.dkr.ecr.<region>.amazonaws.com — deploy.yml passes it
api:
  replicas: 3
  # Sized against the load check (apps/api/scripts/loadcheck.mjs): one pod holds ten Postgres
  # connections and the snapshot is the heaviest read in the system.
  resources: { requests: { cpu: 500m, memory: 512Mi }, limits: { cpu: "2", memory: 1Gi } }
  hpa: { enabled: true, minReplicas: 3, maxReplicas: 6, cpu: 70 }
  pdb: { minAvailable: 2 }
  # Three replicas on one node make the PodDisruptionBudget decorative: draining that node takes
  # the whole service with it whatever minAvailable says.
  topologySpread:
    enabled: true
    maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: ScheduleAnyway
  env:
    LOG_LEVEL: info
    CORS_ORIGIN: https://rch.example.com          # FILL: the real hostname, no trailing slash
    RATE_LIMIT_PER_MINUTE: "300"
    LOGIN_RATE_LIMIT_PER_MINUTE: "10"
    LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE: "5"
    DATABASE_SSL: "true"
    COOKIE_SECURE: "true"
    ACCESS_TOKEN_TTL: 15m
    REFRESH_TOKEN_TTL_DAYS: "30"
    TRUST_PROXY: "1"                              # one hop: the ALB. More hops and the client IP is wrong.
    SSE_HEARTBEAT_MS: "25000"
    SSE_RETRY_MS: "1000"
ui:
  replicas: 3
  resources: { requests: { cpu: 100m, memory: 128Mi }, limits: { cpu: 500m, memory: 256Mi } }
ingress:
  enabled: true
  className: alb
  host: rch.example.com                           # FILL
  certificateArn: ""                              # FILL: without it the ALB serves :80 only
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443},{"HTTP":80}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
    alb.ingress.kubernetes.io/ssl-policy: ELBSecurityPolicy-TLS13-1-2-2021-06
    # An hour, because a live-update stream is one request that never ends (RUNBOOK §10). Every
    # timeout on the path — this, nginx's proxy_read_timeout, the heartbeat — moves together.
    alb.ingress.kubernetes.io/load-balancer-attributes: >-
      idle_timeout.timeout_seconds=3600,
      deletion_protection.enabled=true,
      access_logs.s3.enabled=true,
      access_logs.s3.bucket=rch-alb-logs,
      access_logs.s3.prefix=rch
    alb.ingress.kubernetes.io/healthcheck-path: /healthz
    alb.ingress.kubernetes.io/healthcheck-interval-seconds: "15"
    alb.ingress.kubernetes.io/wafv2-acl-arn: ""   # optional; leave empty to skip
secrets:
  create: false
  externalSecret:
    enabled: true
    storeName: aws-secrets-manager
    storeKind: ClusterSecretStore
    remoteKey: rch/prod                           # a JSON secret with the four keys
serviceAccount:
  create: true
  annotations: {}                                 # FILL if the pod itself reads Secrets Manager (IRSA)
serviceMonitor: { enabled: true, interval: 30s }
purge: { enabled: true, schedule: "15 2 * * *" }
alerts:
  errorRate: 0.01
  p95Seconds: 1
  runbookUrl: https://github.com/<org>/<repo>/blob/production/deploy/RUNBOOK.md   # FILL
```

Then add `topologySpreadConstraints` to `templates/api-deployment.yaml`, guarded on `.Values.api.topologySpread.enabled` so `values.yaml`'s default (disabled) renders nothing. **`templates/ingress.yaml` needs no change** — it already renders the certificate-arn annotation guarded on a non-empty `certificateArn` (`ingress.yaml:7-9`), which is exactly the behaviour wanted: a `certificate-arn: ""` annotation is worse than none, because the ALB controller reads it and fails rather than falling back. Leave that file alone.

- [ ] **Step 5: Review `deploy.yml`, and change only what is wrong**

Read `.github/workflows/deploy.yml` end to end. Its shape is right: an OIDC role, a fast-forward guard, ECR push by SHA, `helm upgrade --wait`, secrets through `env:` and `--set-string` rather than interpolated into the command, a GitHub environment gate on production, a tag on success. **Three things to fix and nothing else:**

1. **Nothing verifies the deploy afterwards.** Add a step after `helm upgrade` that proves the new pods answer:
   ```yaml
      - name: Prove it came up
        run: |
          kubectl -n "$NS" rollout status deploy/rch-api --timeout=5m
          kubectl -n "$NS" rollout status deploy/rch-ui --timeout=5m
          # /readyz checks the database and that the applied migration count matches the journal,
          # so a green here is a stronger statement than "the pod started".
          kubectl -n "$NS" run rch-smoke-$RANDOM --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
            curl -fsS --retry 10 --retry-connrefused http://rch-api:3000/readyz
   ```
2. **A failed production upgrade leaves the release in `pending-upgrade`.** Add `--atomic` beside `--wait` so Helm rolls itself back, and raise `--timeout` to `15m` for production (the migrate initContainer runs first and a large migration is not a fast one). Note in the workflow's comment that `--atomic` on a *first* install deletes the release on failure, which is what you want.
3. **The tag step runs after a deploy that might not have been verified.** Move it after the new verification step and keep its `if: success()`.

Do **not** add the Playwright smoke to this workflow. It runs against the kind cluster in `ci.yml` (Task 8); running it against production on every deploy would mean a smoke that writes bills into the hospital's ledger.

- [ ] **Step 6: Run the chart tests**

Run: `pnpm helm:test`
Expected: PASS, including every new assertion. Then render production by hand and read it:

```bash
helm template rch deploy/chart/rch -f deploy/chart/rch/values-prod.yaml \
  --set image.registry=r,image.tag=t,ingress.certificateArn=arn:aws:acm:x | less
```
Check: the ExternalSecret is there and no plain Secret is; every secret env is a `secretKeyRef`; the migrate initContainer's env matches the api container's exactly; the PrometheusRule's `expr` fields are valid PromQL (paste one into `promtool check rules` if it is installed, otherwise read them).

- [ ] **Step 7: Lint the workflow**

Run: `actionlint .github/workflows/deploy.yml` (installed for Phase 5's audit hotfix; if it is not, `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest -color`).
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add deploy .github/workflows/deploy.yml
git commit -m "$(cat <<'EOF'
Ship the alerts with the chart and make values-prod describe production

Five alert rules render beside the metrics they read, gated on the ServiceMonitor because a
PrometheusRule without the operator installed fails the whole release. Three of §12's five read
this API's own metrics; the two RDS ones need CloudWatch and stay in the runbook, which says so.
A sixth watches the LISTEN connection: a pod whose listener is down answers every request
correctly and silently stops delivering other pods' writes to its browsers, which nothing else
here would notice.

values-prod.yaml was three lines inheriting a file sized for a laptop. It now carries its own
resources, an anti-affinity that stops three replicas landing on one node and making the
disruption budget decorative, TLS on the load balancer, access logs, deletion protection, and
the five placeholders only the account owner can fill — each marked, each explained in the
runbook.

The deploy workflow proves the rollout instead of assuming it, rolls itself back on a failed
upgrade rather than leaving the release pending, and tags only after the proof.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `e2e/` — the Playwright smoke

*(Wave 2. It owns the new `e2e/**`, `pnpm-workspace.yaml`, `knip.json`, `turbo.json`, the root `package.json`, `.github/workflows/ci.yml` and `deploy/chart/rch/ci/install-test.sh` — the one file carved out of Task 7's `deploy/**`. Nothing else in wave 2 touches any of them, and this is the only task in the phase that adds a dependency.)*

**Files:**
- Create: `e2e/package.json`, `e2e/tsconfig.json`, `e2e/playwright.config.ts`, `e2e/fixtures/roles.ts`, `e2e/tests/signin.spec.ts`, `e2e/tests/sell.spec.ts`, `e2e/tests/request-chain.spec.ts`, `e2e/tests/kitchen.spec.ts`, `e2e/tests/buying.spec.ts`, `e2e/tests/support.spec.ts`, `e2e/README.md`
- Modify: `pnpm-workspace.yaml`, `knip.json`, `turbo.json`, `package.json`, `.gitignore`, `.github/workflows/ci.yml`, `deploy/chart/rch/ci/install-test.sh`

**Interfaces:**
- Consumes: nothing from the workspace at runtime — the smoke drives the built app through a browser and knows only URLs, employee ids and on-screen text. It imports **no** `@rch/*` package, deliberately: a smoke that shares types with the code under test can pass because both sides changed together.
- Produces: `pnpm test:e2e` at the repo root; the `E2E=1` branch of `install-test.sh`.

**Why it imports nothing.** Every other level of the pyramid (§13) already checks the contract from the inside. What is left for the smoke is the part no unit can see: that a signed-in browser, a real ALB path, an nginx proxy, an SSE stream and a Postgres transaction line up. It asserts on what a person sees — a toast sentence, a row appearing in another window, a number changing — which is also why its assertions read like the UAT scenarios Task 11 writes.

**Scenarios — six files, eight tests, and no more.** More would be a second test suite maintained by hand against a UI that moves.

| File | Test | What it proves that nothing else does |
|---|---|---|
| `signin.spec.ts` | every role signs in and lands on its own home screen | Real auth against a real cookie, and §8.3's five sidebars |
| `signin.spec.ts` | a role's own URL is refused to another role with a toast | UA-01, and the `/:key` guard end to end |
| `sell.spec.ts` | a counter sells a cart for cash and the till roll and the shelf both move | The ledger, through the browser, in one transaction |
| `request-chain.spec.ts` | counter raises → manager approves in a **second context** → the counter's list updates with no reload → store issues → OTP handover → counter receives | SSE, the OTP now being visible only to the collector, and the whole movement rule |
| `kitchen.spec.ts` | a batch consumes its recipe and yields; a short one is refused and the tile keeps its typing | Recipe depletion and a refusal landing on the operator's own screen |
| `buying.spec.ts` | requisition → approve → PO → send → receive with a rejection → quarantine carries it | The claim, the tolerance, the split shelf |
| `support.spec.ts` | raise, reply, mark resolved, rate — and the list holds only your own tickets | The last cutover, and the scoping decision |

- [ ] **Step 1: Create the workspace**

`e2e/package.json`:

```json
{
  "name": "@rch/e2e",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "test:e2e": "playwright test",
    "typecheck": "tsc --noEmit",
    "lint": "oxlint"
  },
  "devDependencies": {
    "@playwright/test": "^1.56.0",
    "@types/node": "^24.13.3",
    "typescript": "~6.0.2"
  }
}
```

**The script is `test:e2e`, not `test`.** `pnpm test` is `turbo run test` across every package and CI runs it with no stack up; a package with a `test` script that needs a browser and a server would fail every run. Nothing in `turbo.json`'s `test` task will pick this up because the script does not exist.

`e2e/tsconfig.json`: extend `../tsconfig.base.json`, `"include": ["**/*.ts"]`, `"compilerOptions": { "types": ["node"], "noEmit": true }`. Read `tsconfig.base.json` first and drop anything it already sets.

`e2e/playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

/**
 * One browser, no retries locally, one worker.
 *
 * The smoke writes into a real database — it sells, it issues, it receives goods — so two workers
 * racing the same seed would fight over the same shelf and fail for reasons that have nothing to
 * do with the code. Retries are off locally for the same reason: a retry re-runs a scenario whose
 * first attempt already moved stock. In CI one retry is allowed *only* because the cluster is
 * thrown away afterwards and a flake there is more often a port-forward than a defect.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  // The app is a HashRouter served from any host with no SPA rewrite, so every URL the smoke
  // navigates to is "/#/<key>" — never "/<key>", which the static server answers with a 404.
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

`e2e/fixtures/roles.ts`:

```ts
import { expect, type Page } from "@playwright/test";

/**
 * The six seeded accounts, by employee number, with the screen each lands on.
 *
 * These are the ids `pnpm --filter @rch/api db:seed` writes, straight out of
 * `packages/contract/src/fixtures/master.ts:58-66`, and `deploy/RUNBOOK.md` §1 lists them.
 * The password is SEED_PASSWORD's dev default. If a seeded id changes, this file is the one
 * place to change it — every spec asks for a role, never for a number.
 *
 * The two that are easy to get wrong: the outlet manager is RC-3120 and the kitchen in-charge
 * is RC-1902, not the other way round; the second counter operator (at the kiosk) is RC-4482.
 * Each `home` is the label of `HOME[role]`'s nav entry, read off `UI/src/nav.ts` — the buyer's
 * is Requisitions, and no role's home is Purchase Orders.
 */
export const ROLES = {
  counter: { emp: "RC-4471", home: "Point of Sale" },
  manager: { emp: "RC-3120", home: "Approvals" },
  store:   { emp: "RC-2088", home: "Issue Desk" },
  prod:    { emp: "RC-1902", home: "Orders" },
  // HOME.buyer is "requisitions" (UI/src/nav.ts) — the buyer lands on Requisitions, not on
  // Purchase Orders, whose route key is `orders`.
  buyer:   { emp: "RC-1550", home: "Requisitions" },
} as const;
export type RoleName = keyof typeof ROLES;
export const PASSWORD = process.env.E2E_PASSWORD ?? "changeme";

/** Sign in and wait for the snapshot to land — `auth: "ready"` is what puts the shell on screen. */
export async function signIn(page: Page, role: RoleName): Promise<void> {
  await page.goto("/#/");
  await page.getByLabel(/employee/i).fill(ROLES[role].emp);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  // The seeded accounts carry must_change_password, so the first sign-in of a fresh database
  // lands on the change-password step. Walk it if it appears; it is a real part of the flow.
  const change = page.getByRole("heading", { name: /change your password/i });
  if (await change.isVisible({ timeout: 2000 }).catch(() => false)) {
    await page.getByLabel(/current/i).fill(PASSWORD);
    await page.getByLabel(/new/i).first().fill(PASSWORD + "1");
    await page.getByRole("button", { name: /change password/i }).click();
  }
  await expect(page.getByRole("navigation")).toBeVisible();
}

/** The toast the store raises, which is the sentence the server sent. */
export const toast = (page: Page) => page.locator(".toast, [role='status']").first();
```

**Every selector in this file and in the specs is a guess until it is run.** Read `UI/src/pages/Login.tsx`, `UI/src/ui/Shell.tsx` and `UI/src/ui/kit.tsx` and use what is actually there — `getByRole` and `getByLabel` where the markup supports them, a `data-testid` added to `UI/src/ui/kit.tsx` **only** if there is no accessible name to hold on to, and in that case say so in the report because `UI/` is Task 10's and a `data-testid` added here is a file two tasks touched.

**If `SEED_FORCE_PASSWORD_CHANGE` makes the change-password step unavoidable, and it changes the password**, every subsequent sign-in in the same run uses the new one. Either set `SEED_FORCE_PASSWORD_CHANGE=false` in the seed the smoke runs against (preferred — say so in `e2e/README.md`), or keep one password throughout by changing it to itself, which `POST /auth/change-password` may refuse. Decide when you run it and record which.

- [ ] **Step 2: Write the two sign-in scenarios**

`e2e/tests/signin.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { ROLES, signIn, type RoleName } from "../fixtures/roles.js";

test.describe("everyone gets their own portal", () => {
  for (const role of Object.keys(ROLES) as RoleName[]) {
    test(`${role} signs in and lands on ${ROLES[role].home}`, async ({ page }) => {
      await signIn(page, role);
      await expect(page.getByRole("heading", { name: new RegExp(ROLES[role].home, "i") })).toBeVisible();
    });
  }

  test("a screen that is not yours refuses by name, it does not fail silently", async ({ page }) => {
    await signIn(page, "counter");
    // UA-01: a counter operator following a direct link to the buyer's purchase orders, whose
    // route key is `orders` (UI/src/nav.ts) — a key that exists for two other roles and for
    // neither of the counter's, which is what makes this a guard test and not a 404 test.
    // `/#/po` is not a key for anybody, so it would redirect on an unknown route and prove
    // nothing about `canSee`.
    await page.goto("/#/orders");
    // Home again, and told why — the guard in App.tsx has raised a toast since before there was
    // a server, and the sidebar never offered the link in the first place.
    await expect(page.getByRole("heading", { name: /point of sale/i })).toBeVisible();
    await expect(page.locator("nav")).not.toContainText(/purchase orders/i);
  });
});
```

- [ ] **Step 3: Write the sale and the kitchen**

`e2e/tests/sell.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { signIn, toast } from "../fixtures/roles.js";

test("a cash sale takes money and moves the shelf", async ({ page }) => {
  await signIn(page, "counter");
  const tile = page.locator(".tile", { hasText: /juice/i }).first();
  const before = Number((await tile.locator(".qty").innerText()).replace(/[^\d.]/g, ""));

  await tile.click();
  await page.getByRole("button", { name: /^cash$/i }).click();
  await page.getByRole("button", { name: /take payment|collect/i }).click();

  // The toast is the server's own sentence, bill number and all.
  await expect(toast(page)).toContainText(/^Bill CF\/\d+ · ₹/);
  // And the shelf the sale came off has one fewer, without a reload: the write named "stock" and
  // the store refetched it.
  await expect(tile.locator(".qty")).toContainText(String(before - 1));
});
```

`e2e/tests/kitchen.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { signIn, toast } from "../fixtures/roles.js";

test("a batch eats its recipe and yields what was made", async ({ page }) => {
  await signIn(page, "prod");
  await page.getByRole("link", { name: /make|production/i }).click();
  const puffs = page.locator(".tile", { hasText: /veg puffs/i }).first();
  await puffs.getByLabel(/quantity of/i).fill("10");
  await puffs.getByRole("button", { name: /^make$/i }).click();

  await expect(toast(page)).toContainText(/^BAT-\d{8}-\d{2} — 10 of 10 Veg puffs yielded/);
});

test("a batch the kitchen cannot cover is refused, and keeps the typing", async ({ page }) => {
  await signIn(page, "prod");
  await page.getByRole("link", { name: /make|production/i }).click();
  const puffs = page.locator(".tile", { hasText: /veg puffs/i }).first();
  await puffs.getByLabel(/quantity of/i).fill("100000");
  await puffs.getByRole("button", { name: /^make$/i }).click();

  await expect(toast(page)).toContainText(/^Kitchen is short of/);
  // Nothing to retype: the refusal landed on the kitchen's own screen, not on an empty box.
  await expect(puffs.getByLabel(/quantity of/i)).toHaveValue("100000");
});
```

- [ ] **Step 4: Write the request chain across two contexts**

`e2e/tests/request-chain.spec.ts` — the one scenario nothing else in the repo can prove:

```ts
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { signIn, toast } from "../fixtures/roles.js";

test("a request walks from the counter to the shelf, live in both windows", async ({ browser }) => {
  const counterCtx: BrowserContext = await browser.newContext();
  const managerCtx: BrowserContext = await browser.newContext();
  const counter: Page = await counterCtx.newPage();
  const manager: Page = await managerCtx.newPage();
  await signIn(counter, "counter");
  await signIn(manager, "manager");

  // 1. The counter asks.
  await counter.getByRole("link", { name: /stock requests/i }).click();
  await counter.getByRole("button", { name: /from inventory/i }).click();
  await counter.getByLabel(/milk/i).first().fill("6");
  await counter.getByPlaceholder(/note|why/i).fill("Milk finished at 09:10");
  await counter.getByRole("button", { name: /submit request/i }).click();
  await expect(toast(counter)).toContainText(/sent to the outlet manager/);
  const req = (await toast(counter).innerText()).match(/REQ-\d{4}-0\d+/)![0];

  // 2. It is on the manager's queue without anybody reloading. This is the SSE assertion: the
  //    manager's window has not navigated since sign-in.
  await manager.getByRole("link", { name: /approvals/i }).click();
  await expect(manager.getByText(req)).toBeVisible({ timeout: 15_000 });

  // 3. The manager approves it, and the counter's own list moves without a reload.
  await manager.getByText(req).click();
  await manager.getByRole("button", { name: /approve/i }).click();
  await expect(counter.getByText(req).locator("..")).toContainText(/approved/i, { timeout: 15_000 });

  // 4. The store issues it and reads the OTP off the collector's screen, not off its own — the
  //    issue desk no longer prints it, which is the whole point of Phase 6's redaction.
  const store: Page = await (await browser.newContext()).newPage();
  await signIn(store, "store");
  await store.getByRole("link", { name: /issue desk/i }).click();
  await store.getByText(req).click();
  await store.getByRole("button", { name: /issue ticket/i }).click();
  // The digits are not on the sending side's screen at all. `.otp-v` is the six-digit face
  // (UI/src/styles.css:360-365, alongside `.otp`, `.otp-l` and `.otp-in`); the issue desk must
  // render none of them. Asserting on a class that does not exist would pass either way, which
  // is the one thing this assertion — the smoke's whole proof of the redaction — must not do.
  await expect(store.locator(".otp-v")).toHaveCount(0);

  await counter.getByRole("link", { name: /tickets/i }).click();
  const otp = (await counter.locator(".otp").first().innerText()).replace(/\D/g, "");
  expect(otp).toMatch(/^\d{6}$/);

  await store.getByLabel(/otp|six digits/i).fill(otp);
  await store.getByRole("button", { name: /hand over/i }).click();
  await expect(toast(store)).toContainText(/handed over/i);

  // 5. The counter receives it, and the shelf it lands on is theirs.
  await counter.getByRole("button", { name: /receive/i }).first().click();
  await expect(toast(counter)).toContainText(/received/i);

  await counterCtx.close();
  await managerCtx.close();
});
```

- [ ] **Step 5: Write buying and support**

`e2e/tests/buying.spec.ts` walks store → buyer → store in three contexts:

```ts
import { expect, test, type Page } from "@playwright/test";
import { signIn, toast } from "../fixtures/roles.js";

test("a requisition becomes an order, and the delivery splits between two shelves", async ({ browser }) => {
  const store: Page = await (await browser.newContext()).newPage();
  const buyer: Page = await (await browser.newContext()).newPage();
  await signIn(store, "store");
  await signIn(buyer, "buyer");

  // 1. The store keeper asks.
  await store.getByRole("link", { name: /requisitions/i }).click();
  await store.getByLabel(/milk/i).first().fill("60");
  await store.getByPlaceholder(/note/i).fill("Weekly dairy");
  await store.getByRole("button", { name: /send to procurement/i }).click();
  await expect(toast(store)).toContainText(/^PRQ-\d{4}-0\d+ sent to procurement/);
  const prq = (await toast(store).innerText()).match(/PRQ-\d{4}-0\d+/)![0];

  // 2. The buyer decides, and the line lands on the procurement list.
  await buyer.getByRole("link", { name: /requisitions/i }).click();
  await expect(buyer.getByText(prq)).toBeVisible({ timeout: 15_000 });
  await buyer.getByText(prq).click();
  await buyer.getByRole("button", { name: /approve/i }).click();
  await expect(toast(buyer)).toContainText(new RegExp(`^${prq} (fully )?approved`));

  // 3. An order off the list, priced from the live rate contract, and sent.
  await buyer.getByRole("link", { name: /procurement list/i }).click();
  await buyer.getByRole("checkbox").first().check();
  await buyer.getByRole("button", { name: /raise (a )?purchase order|create po/i }).click();
  await buyer.getByRole("button", { name: /^send/i }).click();
  await expect(toast(buyer)).toContainText(/^PO-\d{4}-0\d+ raised on /);
  const po = (await toast(buyer).innerText()).match(/PO-\d{4}-0\d+/)![0];

  // 4. The goods arrive, and three of them do not pass quality.
  await store.getByRole("link", { name: /purchase orders|receipts/i }).click();
  await store.getByText(po).click();
  await store.getByLabel(/delivery (challan|note)|dc/i).fill("DC-99001");
  await store.getByLabel(/received/i).first().fill("60");
  await store.getByLabel(/rejected/i).first().fill("3");
  await store.getByLabel(/batch/i).first().fill("AAV-9001");
  await store.getByLabel(/^manufactur/i).first().fill("2026-09-01");
  await store.getByLabel(/^expir/i).first().fill("2027-09-01");
  await store.getByRole("button", { name: /book (it )?in|receive/i }).click();
  await expect(toast(store)).toContainText(/^Booked into Central Store — .*accepted, .*rejected/);

  // 5. The rejected three are on the quarantine shelf, which is the only view anyone has of them.
  await store.getByRole("link", { name: /^stock/i }).click();
  await expect(store.getByRole("region", { name: /quarantine/i })).toContainText(/milk/i);
});
```

Read Phase 5's Task 10 for the screen names and the exact sentences before running this; its wire tests already pin them, and the selectors above are guesses until the first run.

**This spec depends on Phase 5's Task 10 more than any other.** The store keeper's receipt screen, the buyer's procurement list and the quarantine panel on `roles/store/Stock.tsx` are all delivered by it. If it has not merged when this task runs, write the file, mark it `test.describe.skip` with a one-line reason, and say so in the report — a skipped scenario the controller un-skips after the merge is honest; a scenario written against screens that do not exist is not.

`e2e/tests/support.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { signIn, toast } from "../fixtures/roles.js";

test("a ticket is raised, answered, resolved and rated — and stays the raiser's own", async ({ page, browser }) => {
  await signIn(page, "counter");
  await page.getByRole("link", { name: /support/i }).click();
  const subject = `Smoke ${Date.now()}`;
  await page.getByLabel(/subject/i).fill(subject);
  await page.getByLabel(/what happened/i).fill("Raised by the end-to-end smoke.");
  await page.getByRole("button", { name: /send to support/i }).click();
  await expect(toast(page)).toContainText(/raised — support replies to urgent tickets within the hour|raised —/);

  await page.getByText(subject).click();
  await page.getByLabel(/your message/i).fill("Still happening.");
  await page.getByRole("button", { name: /send reply/i }).click();
  await expect(toast(page)).toContainText(/^Reply sent on SUP-/);

  await page.getByRole("button", { name: /mark resolved/i }).click();
  await page.getByRole("button", { name: "5", exact: true }).click();
  await expect(toast(page)).toContainText(/^Thank you — 5 out of 5 recorded against SUP-/);

  // And it is nobody else's business.
  const buyer = await (await browser.newContext()).newPage();
  await signIn(buyer, "buyer");
  await buyer.getByRole("link", { name: /support/i }).click();
  await expect(buyer.getByText(subject)).toHaveCount(0);
});
```

- [ ] **Step 6: Wire the workspace up**

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
  - apps/*
  - UI
  - e2e
```

`knip.json` — a workspace entry, or knip reports the whole of `e2e/` as unused:
```jsonc
    "e2e": {
      // Playwright discovers specs itself; knip has to be told, or every scenario reads as dead
      // code and every fixture as an unused export.
      "entry": ["playwright.config.ts", "tests/**/*.spec.ts"],
      "project": ["**/*.ts"]
    }
```

Root `package.json`: `"test:e2e": "pnpm --filter @rch/e2e test:e2e"`.

`turbo.json`: nothing to add to `test`. Add `e2e` only if you want `turbo run e2e` — do not, and say so: turbo caching a task that needs a live server is a cached green against a stack that was not running.

Run `pnpm install` and commit the lockfile change with everything else.

- [ ] **Step 7: Run it locally against `pnpm dev`**

```bash
pnpm db:up
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed --force
pnpm --filter @rch/e2e exec playwright install --with-deps chromium
pnpm dev &            # api :3000, UI :5173
pnpm test:e2e
```

Expected: 8 passed. **Every selector above is a guess; this is where they become real.** Fix the specs, not the app — except where the app genuinely has no accessible name for something, which is a finding for Task 10 and goes in the report.

Re-run `pnpm --filter @rch/api db:seed --force && pnpm test:e2e` a second time from the same shell and confirm it passes again: a smoke that only works on a virgin database is a smoke nobody will run twice.

- [ ] **Step 8: Run it in CI against the kind cluster**

In `deploy/chart/rch/ci/install-test.sh`, after the UI health check and before `kill_pf`:

```bash
if [ "${E2E:-}" = "1" ]; then
  echo "== playwright smoke against the cluster =="
  # Both port-forwards are up: the UI on 8080 and the API on 3000. The UI's nginx proxies /api
  # and /api/v1/events to the API service inside the cluster, so the browser needs only the one.
  E2E_BASE_URL="$UI" pnpm test:e2e
fi
```

In `.github/workflows/ci.yml`'s `images` job, before the `helm install into kind` step, add the Node and browser setup the job has deliberately not needed until now, and set `E2E=1` on the install step:

```yaml
      - uses: pnpm/action-setup@v4
        with: { version: 10.28.2 }
      - uses: actions/setup-node@v7
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: Install the browser the smoke drives
        run: pnpm --filter @rch/e2e exec playwright install --with-deps chromium
      - name: helm install into kind
        env: { E2E: "1" }
        run: deploy/chart/rch/ci/install-test.sh
      - uses: actions/upload-artifact@v7
        if: failure()
        with: { name: playwright-report, path: e2e/playwright-report, retention-days: 7 }
```

Raise that job's `timeout-minutes` from 20 to **30** and say why in the comment above it: the browser install is two to three minutes and eight scenarios against a kind cluster are another three or four.

Add `e2e/playwright-report/`, `e2e/test-results/` and `e2e/.playwright/` to `.gitignore`.

- [ ] **Step 9: Run the gate**

Run: `pnpm turbo typecheck test --force && pnpm lint && actionlint .github/workflows/ci.yml`
Expected: PASS. `pnpm test` must **not** invoke Playwright — confirm by reading the turbo output for a `@rch/e2e:test` line and finding none.

- [ ] **Step 10: Commit**

```bash
git add e2e pnpm-workspace.yaml knip.json package.json pnpm-lock.yaml .gitignore .github/workflows/ci.yml deploy/chart/rch/ci/install-test.sh
git commit -m "$(cat <<'EOF'
Drive the whole stack through a browser, eight times

A new e2e workspace with a Playwright smoke that imports nothing from this repo on purpose: every
other level of the pyramid checks the contract from the inside, and what is left is whether a real
browser, a real cookie, an nginx proxy, a live-update stream and a Postgres transaction line up.
It asserts on what a person sees — a toast sentence, a row appearing in a second window, a number
changing — which is why it reads like the acceptance scenarios rather than like a unit test.

The request chain runs in two browser contexts and never reloads either of them, so the manager's
queue filling up and the counter's list turning "approved" are the live-update path being proved
rather than described. The store keeper reads the six digits off the collector's screen, because
the issue desk no longer prints them.

Its script is test:e2e and not test, so `pnpm turbo typecheck test` — which has no stack running —
never reaches for a browser. In CI it runs at the end of the kind install, which is the only place
a real chart, a real nginx and a real database already exist.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The load check — `/snapshot` and `POST /bills`, measured

*(Wave 2. It owns `apps/api/scripts/loadcheck.mjs` and the one script line in `apps/api/package.json`. It adds no dependency.)*

**Files:**
- Create: `apps/api/scripts/loadcheck.mjs`
- Modify: `apps/api/package.json` (one `scripts` entry)

**Interfaces:**
- Consumes: a running API and a seeded database. Nothing from the workspace — it is a script, not a module, and `node apps/api/scripts/loadcheck.mjs` must work with no build step.
- Produces: `pnpm --filter @rch/api loadcheck`, quoted by Task 12's exit check and by the runbook.

**Why this is a script and not a CI job.** §12's targets — `/snapshot` under **150 ms p95**, writes under **200 ms p95** — are stated "on the staging instance". A GitHub runner sharing a box with a Postgres service container measures the runner; a red there would be noise and a green there would be a lie. It runs where a person can say what hardware it ran on, and Task 12 records the numbers with the machine.

**Why no dependency.** `k6` is not installed and would be a system install; `autocannon` would be a second task editing `pnpm-lock.yaml` in the same wave as Task 8 and a merge conflict on a file no merge strategy resolves well. Node 24 has global `fetch` and `node:perf_hooks`, which is all a p95 needs.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
/**
 * Spec §12, Performance: "/snapshot for the full seed under 150 ms p95 on the staging instance;
 * write endpoints under 200 ms p95."
 *
 * This measures both against a running API and prints PASS or FAIL. It is deliberately not a CI
 * job: on a shared runner it would measure the runner, and a number nobody can attribute to a
 * machine is not evidence. Run it where you can say what the machine was, and write that down.
 *
 *   node apps/api/scripts/loadcheck.mjs --base http://localhost:3000 --emp RC-4471 --password changeme
 *
 * Flags: --base (default http://localhost:3000), --emp, --password, --concurrency (default 10),
 *        --duration (seconds, default 20), --warmup (seconds, default 3), --no-writes.
 *
 * It sells one unit of one item per write, on the counter's own outlet, with a fresh
 * Idempotency-Key each time — so it moves real stock. Point it at a database you can reseed.
 */
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);

const BASE = (arg("base", "http://localhost:3000")).replace(/\/$/, "");
const API = `${BASE}/api/v1`;
const EMP = arg("emp", "RC-4471");
const PASSWORD = arg("password", "changeme");
const CONCURRENCY = Number(arg("concurrency", "10"));
const DURATION_MS = Number(arg("duration", "20")) * 1000;
const WARMUP_MS = Number(arg("warmup", "3")) * 1000;

/** §12's two ceilings, in milliseconds. */
const TARGETS = { "GET /snapshot": 150, "POST /bills": 200 };

const pct = (sorted, p) => (sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);

async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ emp: EMP, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed (${res.status}): ${await res.text()}`);
  const body = await res.json();
  if (body.mustChangePassword) throw new Error("that account still has must_change_password set — change it, or seed with SEED_FORCE_PASSWORD_CHANGE=false");
  return { token: body.accessToken, user: body.user };
}

/** Pick something the counter can actually sell, so a 422 does not masquerade as latency. */
async function pickSellable(token, loc) {
  const snap = await (await fetch(`${API}/snapshot`, { headers: { authorization: `Bearer ${token}` } })).json();
  const listed = snap.menu[loc] ?? [];
  const onHand = snap.stock[loc] ?? {};
  const it = listed.find((k) => (onHand[k] ?? 0) > 5000) ?? listed.find((k) => (onHand[k] ?? 0) > 100);
  if (!it) throw new Error(`nothing at ${loc} has enough stock to hammer; reseed and try again`);
  return it;
}

async function hammer(label, fire, deadline, samples) {
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (performance.now() < deadline) {
      const t0 = performance.now();
      const res = await fire();
      const ms = performance.now() - t0;
      if (res.ok) samples.push(ms);
      else samples.errors.push(res.status);
      // Drain the body: an unread body holds the socket and the next request opens a new one,
      // which measures connection setup rather than the server.
      await res.arrayBuffer().catch(() => {});
    }
  });
  await Promise.all(workers);
  return label;
}

function report(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const target = TARGETS[label];
  const p95 = pct(sorted, 95);
  const pass = p95 <= target;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${label.padEnd(16)} ` +
    `n=${String(sorted.length).padStart(6)}  ` +
    `p50=${pct(sorted, 50).toFixed(1)}ms  p95=${p95.toFixed(1)}ms  p99=${pct(sorted, 99).toFixed(1)}ms  ` +
    `max=${sorted.at(-1)?.toFixed(1)}ms  target p95 <= ${target}ms` +
    (samples.errors.length ? `  (${samples.errors.length} non-2xx: ${[...new Set(samples.errors)].join(",")})` : "")
  );
  return pass;
}

const bucket = () => Object.assign([], { errors: [] });

const { token, user } = await login();
const it = flag("no-writes") ? null : await pickSellable(token, user.loc);
const auth = { authorization: `Bearer ${token}` };

console.log(`# ${CONCURRENCY} concurrent, ${DURATION_MS / 1000}s each, after ${WARMUP_MS / 1000}s warm-up, against ${BASE}`);
console.log(`# node ${process.version} on ${process.platform}/${process.arch} — RECORD THE MACHINE with these numbers\n`);

// Warm-up is thrown away: the first requests pay for a cold pool, a cold plan cache and a JIT
// that has not seen the route handler yet, and a p95 over twenty seconds is dominated by them.
await hammer("warmup", () => fetch(`${API}/snapshot`, { headers: auth }), performance.now() + WARMUP_MS, bucket());

const snapshot = bucket();
await hammer("GET /snapshot", () => fetch(`${API}/snapshot`, { headers: auth }), performance.now() + DURATION_MS, snapshot);
let ok = report("GET /snapshot", snapshot);

if (it) {
  const bills = bucket();
  await hammer("POST /bills", () => fetch(`${API}/bills`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify({ loc: user.loc, tender: "Cash", lines: [{ it, qty: 1 }] }),
  }), performance.now() + DURATION_MS, bills);
  ok = report("POST /bills", bills) && ok;
  console.log(`\n# ${bills.length} bills were written to ${user.loc}. Reseed before using this database for anything else.`);
}

process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Add the script entry**

In `apps/api/package.json`'s `scripts`:

```json
    "loadcheck": "node scripts/loadcheck.mjs",
```

No `--env-file`: the script takes a base URL and an account, not a database. That is what lets it point at staging or at a port-forward without a local `.env`.

- [ ] **Step 3: Run it, twice**

```bash
pnpm db:up && pnpm --filter @rch/api db:migrate && pnpm --filter @rch/api db:seed --force
pnpm --filter @rch/api dev &
pnpm --filter @rch/api loadcheck -- --emp RC-4471 --password changeme
```

Expected: two lines, each `PASS` or `FAIL`, with the machine printed above them. Then run it again at `--concurrency 30` and record both. **A `FAIL` at this stage is a finding, not a blocker for this task** — the task's deliverable is the measurement, and if `/snapshot` is over 150 ms on the seed, that is exactly what §12 wanted to know and Task 12 records it with what the profile showed. Note in the report:
- the p50/p95/p99 for both endpoints at both concurrencies,
- the machine (`node -v`, `uname -sm`, and whether Postgres was in Docker on the same box, which it is locally and is not in production),
- whether the non-2xx count was zero — a run with 422s in it measured refusals, not sales.

- [ ] **Step 4: Check it against a refusal**

Run it once with `--emp` set to a user whose location has nothing sellable, or with the database freshly seeded and `--concurrency 50` so the shelf runs out mid-run. The script must report the non-2xx count rather than silently averaging refusals into the p95 — refusals are fast and would flatter the number. If it does not, fix the script.

- [ ] **Step 5: Commit**

```bash
git add apps/api/scripts/loadcheck.mjs apps/api/package.json
git commit -m "$(cat <<'EOF'
Measure the two latencies the spec sets a number for

A dependency-free script that logs in, warms the pool, hammers the snapshot and the till at a
chosen concurrency, and prints p50, p95 and p99 against §12's 150ms and 200ms. Refusals are
counted separately and never averaged in — a 422 is fast, and a run full of them would flatter
the number it exists to check.

It is not a CI job, and that is the point: on a shared runner it would measure the runner. It
prints the machine above the results so the numbers can be attributed to something, and the exit
check records both.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Hygiene — a cheaper reseed, a GRN number that cannot collide, two TZ pins

*Numbered 13 and placed here because it belongs to **wave 2**: it was added after Tasks 10–12 were written, and renumbering them would have broken every cross-reference in the plan and in the §12 evidence map. Read the wave table, not the numbering, for the order.*

*(Wave 2, alongside Tasks 4–9. It owns `packages/domain/src/ids.ts` and its test, both packages' `vitest.config.ts`, `apps/api/src/db/seed.ts`, `apps/api/src/test/db.ts`, `apps/api/src/modules/grn/**` and `apps/api/src/modules/purchaseorders/purchaseorders.test.ts`. No wave-2 task touches any of them: Task 2 finished with `packages/domain/**` in wave 1, Task 3 with `apps/api/src/test/builders.ts` — a different file from `test/db.ts` — and Task 6 owns `packages/contract/src/**`, not the package-root config.)*

**Three carry-forwards from Phase 5, none of them cosmetic.** Each is small, each is in a file nothing else in this phase opens, and each is the kind of thing that never gets its own phase and so never gets done.

**Files:**
- Modify: `packages/domain/src/ids.ts`, `packages/domain/src/ids.test.ts`, `packages/domain/vitest.config.ts`, `packages/contract/vitest.config.ts`, `apps/api/src/db/seed.ts`, `apps/api/src/test/db.ts`, `apps/api/src/modules/grn/service.ts`, `apps/api/src/modules/grn/grn.test.ts`, `apps/api/src/modules/purchaseorders/purchaseorders.test.ts`

**Interfaces:**
- Consumes: nothing from another Phase 6 task.
- Produces (used by no other task in this phase; the runbook line and the §16 rows are Task 11's, which is written against this task's decisions):
  ```ts
  // packages/domain/src/ids.ts
  /** A goods receipt's number, from the order it books in against. The one place the format lives. */
  export function grnId(poId: string, instalment: number): string;

  // apps/api/src/db/seed.ts
  /** Every document band — requests, tickets, procurement, production, bills, ops — and nothing
   *  above it. The master half (items, locations, recipes, menus, price lists, users, payers)
   *  is invariant and is seeded once per file. */
  export async function seedDocuments(tx: Tx): Promise<void>;

  // apps/api/src/test/db.ts
  /** Truncate only the document and vendor tables and re-seed them. A per-case reset that costs
   *  a fraction of a full `truncateAll` + `seedTestDb`. */
  export async function resetDocuments(db: Db): Promise<void>;
  ```

- [ ] **Step 1: Pin the two clocks**

`packages/domain/vitest.config.ts` and `packages/contract/vitest.config.ts` are both one line and neither pins the timezone, while `apps/api/vitest.config.ts` and `UI/vite.config.ts` both do. Phase 5 left them because "the tests are TZ-independent" — which is a statement about the tests that exist today, not about the ones `ids.ts`, `shelf.ts` and `format.ts` will grow. Both become:

```ts
import { defineConfig } from "vitest/config";
// TZ=UTC like apps/api and UI: every IST-sensitive assertion in this package (id year segments,
// best-before wording, month boundaries) then proves something on every host and not only on one
// already in UTC. Phase 5 left this unpinned as "the tests are TZ-independent"; the pin removes
// the class of failure rather than the current instance of it.
export default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"], env: { TZ: "UTC" } } });
```

Run `TZ=Asia/Kolkata pnpm --filter @rch/domain test && TZ=Asia/Kolkata pnpm --filter @rch/contract test` **before and after**. Both must pass both times; if one fails before the pin and passes after, that is a real bug the pin has just papered over and it goes in the report.

- [ ] **Step 2: Write the failing GRN id test**

Add to `packages/domain/src/ids.test.ts`:

```ts
describe("a goods receipt's number", () => {
  it("carries the year and the whole order number, so two orders cannot share it", () => {
    expect(grnId("PO-2026-0143", 1)).toBe("GRN-260143-01");
    expect(grnId("PO-2026-0143", 2)).toBe("GRN-260143-02");
    // The old format was the last three characters of the PO id, which these three share.
    expect(grnId("PO-2027-0143", 1)).not.toBe(grnId("PO-2026-0143", 1));
    expect(grnId("PO-2026-1143", 1)).not.toBe(grnId("PO-2026-0143", 1));
  });

  it("pads the instalment to two, like a batch's", () => {
    expect(grnId("PO-2026-0143", 12)).toBe("GRN-260143-12");
  });
});
```

Run: `pnpm --filter @rch/domain test`
Expected: FAIL — `grnId` does not exist.

- [ ] **Step 3: Write `grnId` and move the format out of the service**

In `packages/domain/src/ids.ts`, below `formatId`:

```ts
/**
 * A goods receipt's number, derived from the order it books in against rather than drawn from a
 * sequence: `GRN-<yy><po number>-<nn>`, so the second instalment against `PO-2026-0143` is
 * `GRN-260143-02`.
 *
 * Spec §7.3 said `GRN-<last 3 of PO>-<nn>`, which collides — `PO-2026-0143` and `PO-2027-0143`
 * share a three-character tail, and so do `PO-2026-0143` and `PO-2026-1143`. `grns.id` is a
 * primary key, so the collision surfaced as a failed insert in the middle of a receipt: a 500 at
 * the receiving door, not a duplicate number somebody notices later. Widening the tail to the
 * year's last two digits plus the whole order number makes it unique for as long as PO numbers
 * are unique within a year, which they are (`sequences`). §16 records the change.
 */
export function grnId(poId: string, instalment: number): string {
  // "PO-2026-0143" -> ["PO", "2026", "0143"]. Anything that is not that shape falls back to the
  // whole id with its separators stripped, so a hand-corrected order still gets a usable number
  // rather than a silently truncated one.
  const parts = poId.split("-");
  const tail = parts.length === 3 ? `${parts[1].slice(2)}${parts[2]}` : poId.replace(/[^A-Za-z0-9]/g, "");
  return `GRN-${tail}-${pad(instalment, 2)}`;
}
```

Export it from `packages/domain/src/index.ts` in the file's named-re-export style.

In `apps/api/src/modules/grn/service.ts:86`, replace the inline construction:

```ts
-          const grnId = `GRN-${id.slice(-3)}-${String(++n).padStart(2, "0")}`;
+          const receiptId = grnId(id, ++n);
```

and rename the local's four uses in the lines below it (`id: grnId` in the insert, and the `refId: grnId` on the two moves). **Read the surrounding block before editing** — `n` is the instalment counter for this order and its increment must stay exactly where it is, or two lines in one receipt draw the same number.

Update `apps/api/src/modules/grn/grn.test.ts:69,70,134,139` to expect `grnId(id, 1)` / `grnId(id, 2)` rather than the inline `` `GRN-${id.slice(-3)}-01` `` — importing the domain function, so the test and the service cannot drift into two formats. Add one case that a second order sharing the old tail now gets its own numbers:

```ts
// `receive(poId, lines)` is this suite's own helper — read the top of grn.test.ts and use whatever
// it is actually called there rather than the name written here.
it("numbers two orders that used to share a tail apart", async () => {
  // Both end "143" under the old format. Build the second with the builder so no sequence is
  // consumed and no case depends on which numbers the seed happened to reach.
  // `given.po` defaults the vendor to VN-001 and a line's rate to 10; only the id, the status
  // and the line matter here.
  const a = await given.po(app.db, { id: "PO-2026-0143", st: "Ordered", lines: [{ it: "milk", qty: 10 }] });
  const b = await given.po(app.db, { id: "PO-2026-1143", st: "Ordered", lines: [{ it: "milk", qty: 10 }] });
  const ra = await receive(a, [{ recv: 10, rejected: 0, batch: "X1", mrp: 0, mfg: "2026-09-01", exp: "2027-09-01" }]);
  const rb = await receive(b, [{ recv: 10, rejected: 0, batch: "X2", mrp: 0, mfg: "2026-09-01", exp: "2027-09-01" }]);
  expect(ra.result.grns[0].id).not.toBe(rb.result.grns[0].id);
});
```

**Old GRNs are not renumbered.** There is no migration and no backfill: a receipt written before this change keeps the id it was printed with, and the runbook line Task 11 adds says so. A three-character tail on a GRN simply means an older one.

- [ ] **Step 4: Split the seed so a test can reset the cheap half**

Six suites — `purchaseorders`, `grn`, `requisitions`, `contracts`, `vendors`, `productreqs` among them — do `beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); })`, which empties and rebuilds **the whole hospital** for every case: items, locations, recipes, menus, price lists, users, payers and every document, when all that a case needs back is a clean document band. On a suite of forty cases that is forty master seeds nothing reads differently.

In `apps/api/src/db/seed.ts`, the document seeders are already separate private functions (`seedRequestsAndTickets`, `seedProcurement`, `seedProduction`, `seedBills`, `seedOps`). Export one call over them, and have `seedDatabase` call it in place of the five so the two paths cannot diverge:

```ts
/**
 * Every document band and nothing above it. The master half — items, locations, recipes, menus,
 * price lists, users, payers — is invariant across a suite, so a test file can seed it once and
 * reset only this between cases. `seedDatabase` calls it too: one list of document seeders, in
 * one order, or the full seed and the partial reseed drift into two different hospitals.
 */
export async function seedDocuments(tx: Tx): Promise<void> {
  await seedRequestsAndTickets(tx);
  await seedProcurement(tx);
  await seedProduction(tx);
  await seedBills(tx);
  await seedOps(tx);
}
```

Read `seedDatabase` first and keep whatever ordering it has, including `seedOpeningStock` — **opening stock is a ledger write, not a document**, and where it belongs is the one judgement call in this step. It writes `opening` moves and balance rows that a document reset must restore, so it goes **inside** `seedDocuments` if the document tables' truncation cascades to `stock_moves`/`stock_balances`, and outside it if it does not. Determine which by reading `truncateAll` (it truncates every table in the schema except `sequences`, `cascade`) and the reset's own table list in Step 5, and say which you chose and why in the report.

In `apps/api/src/test/db.ts`, beside `truncateAll`:

```ts
/**
 * The per-case reset: empty the document and vendor tables and re-seed them, leaving master data,
 * users and payers exactly as the file's `beforeAll` left them. A suite that was paying for a
 * whole hospital between cases pays for the documents instead.
 *
 * The table list is explicit rather than derived: `truncateAll` takes every table in the schema
 * and that is what makes it slow, and a derived "everything except master" list would silently
 * start truncating each new table a later phase adds. Add a table here on purpose or not at all.
 */
export async function resetDocuments(db: Db): Promise<void> {
  const names = [
    "stock_requests", "stock_request_lines", "tickets", "ticket_lines", "shop_asks",
    "requisitions", "requisition_lines", "purchase_orders", "po_lines", "po_line_sources", "grns",
    "prod_orders", "prod_order_lines", "batches", "bills", "bill_lines",
    "support_tickets", "support_messages", "product_requests",
    "vendors", "rate_contracts",
    "stock_moves", "stock_balances", "reservations", "availability_overrides",
    "document_history", "idempotency_keys",
  ];
  await db.execute(sql.raw(`truncate table ${names.map((n) => `"${n}"`).join(", ")} restart identity cascade`));
  await db.transaction(async (tx) => { await seedDocuments(tx); });
}
```

**Check every name against `apps/api/src/db/schema/*.ts` before running it** — a typo is a Postgres error, which is the good outcome; a *missing* table is a case that inherits the previous one's rows, which is the bad one. `sequences` is deliberately absent, as it is from `truncateAll`: ids must keep advancing across cases, which is why no test asserts a literal allocated id.

- [ ] **Step 5: Use it in one suite, and prove it is equivalent**

Change `apps/api/src/modules/purchaseorders/purchaseorders.test.ts` only:

```ts
beforeAll(async () => { app = await buildTestApp({ schema: "purchaseorders" }); await app.ready(); await seedTestDb(app.testDb!.db); });
beforeEach(async () => { await resetDocuments(app.testDb!.db); });
```

Run the suite before and after and compare: **every case must pass, and the wall-clock must fall.** Record both numbers.

```bash
pnpm --filter @rch/api test -- src/modules/purchaseorders/purchaseorders.test.ts
```

**One suite, not six.** If the equivalence holds here it will hold elsewhere, but each conversion is a chance to discover a case that quietly depended on a master row being rebuilt, and this phase has no budget to debug five of those. Record in the report that `grn`, `requisitions`, `contracts`, `vendors` and `productreqs` are the remaining candidates and that the helper is in place for them.

- [ ] **Step 6: Run the gate**

Run: `pnpm turbo typecheck test --force && pnpm lint`
Expected: `@rch/domain`, `@rch/contract` and `@rch/api` PASS; `@rch/ui` still red on Task 1's contract changes until wave 3, as in every other wave-2 task. Confirm the journal still reads `0006_rate_contracts_live_uq` — this task writes no migration and the GRN change needs none, because `grns.id` is `text`.

- [ ] **Step 7: Commit**

```bash
git add packages/domain apps/api/src/db/seed.ts apps/api/src/test/db.ts apps/api/src/modules/grn apps/api/src/modules/purchaseorders/purchaseorders.test.ts packages/contract/vitest.config.ts packages/domain/vitest.config.ts
git commit -m "$(cat <<'EOF'
Give a goods receipt a number that cannot collide, and stop reseeding the hospital per case

GRN-<last three of the PO>-<nn> collides. PO-2026-0143 and PO-2027-0143 share that tail, and so
do PO-2026-0143 and PO-2026-1143 — and because the id is a primary key, the collision arrived as
a failed insert in the middle of a delivery rather than as a duplicate number somebody spotted
later. The tail is now the year and the whole order number, the format lives in one function in
the domain instead of inline in the service, and receipts written before this keep the ids they
were printed with.

Six suites emptied and rebuilt every item, recipe, menu, price list, user and payer before every
case in order to get a clean document band. The seed now exposes its document half on its own and
the harness can reset that alone; one suite is converted to prove the two are equivalent, and the
other five are named for whoever converts them.

Both remaining vitest configs pin TZ=UTC, matching apps/api and UI. The tests are timezone-
independent today, which is a fact about the tests that exist rather than about the ones these
two packages will grow.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: UI cutover — the support desk, the roster, the withheld OTP, and the end of `data/seed.ts`

*(Wave 3, alone. It owns every file under `UI/src/`. Nothing else is in flight. It is one task and not three because the store, the screens and the tests are one change: splitting the store from the screens fails typecheck in whichever half goes first, which is the same reason Phases 4 and 5 refused that split.)*

**Files:**
- Delete: `UI/src/data/seed.ts`, `UI/src/data/ops.ts`
- Modify: `UI/src/store/index.ts`, `UI/src/store/ops.ts`, `UI/src/api/{wire.ts,refetch.ts}`, `UI/src/data/{master.ts,vendors.ts}`, `UI/src/pages/Support.tsx`, `UI/src/roles/counter/{Pos.tsx,TicketDrawer.tsx,Tickets.tsx}`, `UI/src/roles/store/{IssueDesk.tsx,IssueDetail.tsx,TicketDrawer.tsx,Reports.tsx}`, `UI/src/roles/prod/Tickets.tsx`, `UI/src/roles/manager/ItemsStock.tsx`, `UI/src/lib/selectors.ts`, `UI/src/__tests__/{fixture.ts,app.test.tsx,screens.test.tsx,theme.test.ts,writes.test.ts,store.test.ts,fixes.test.ts,events.test.ts,session.test.ts,procurement.test.ts}`

**Before you touch anything, run the two sweeps.** The Files block above is what they found when this plan was written; the merged tree is the authority.

```bash
grep -rn '\.otp\|<Otp' UI/src                                   # expect 7 sites + the kit's component
grep -rn '@rch/contract/fixtures\|data/seed\|data/ops' UI/src    # expect data/master, data/vendors, store/index, store/ops, __tests__/*
grep -rn 'PATIENTS\|STAFF\b\|DEPTS' UI/src
grep -rn 'signIn\|signOut' UI/src
```

**Interfaces:**
- Consumes: `routes.{raiseTicket,replyToTicket,setTicketStatus,rateTicket,tickets,stockLedger,creditReport,cancelTicket}`; `SnapshotSchema.roster`; `TicketSchema.hist`; `ALL_LOCS`, `OUTLETS`, `PAR_FACTOR` from `@rch/contract` (Task 1); `SUPPORT_TRANSITIONS`, `mayUserSet`, `mayRate`, `ledgerRow`, `ledgerTotals`, `creditRoom` from `@rch/domain` (Task 2); `call`, `ApiError`, `refetch`.
- Produces:
  ```ts
  // UI/src/store/ops.ts — the four support actions, now awaited
  raiseTicket:     (p: { topic: TicketTopic; subject: string; body: string; priority: TicketPriority; screen: string }) => Promise<boolean>;
  replyToTicket:   (id: string, body: string) => Promise<boolean>;
  setTicketStatus: (id: string, st: TicketStatus) => Promise<void>;
  rateTicket:      (id: string, rating: 1 | 2 | 3 | 4 | 5) => Promise<void>;

  // UI/src/api/wire.ts
  export function applySupportTickets(rows: Snapshot["tickets"]): void;

  // UI/src/store/index.ts — the two reads a screen may not make for itself
  readStockLedger: (loc: StockLoc, days: number) => Promise<StockLedgerRow[]>;   // [] on failure, toasted
  readCredit:      (payer: Payer) => Promise<CreditResponse | null>;             // null on failure, silent

  // UI/src/data/master.ts
  export const PATIENTS: Payer[]; export const STAFF: Payer[]; export const DEPTS: Payer[];   // registries, filled by:
  export function hydrateRoster(r: PayerRoster): void;

  // UI/src/__tests__/fixture.ts
  export const as: (role: Role) => void;      // sets user + auth "ready" + a token, as login() leaves it
  export const signedOut: () => void;         // the state logout() leaves
  ```

**Which actions carry a form, and what that means.** Phase 3's fix round settled the rule and Phases 4 and 5 kept it: an action a screen resets a form for answers `Promise<boolean>` and the screen awaits it behind a busy lock, so a refusal lands on the operator's own typing rather than on an empty box. A button on a card is `Promise<void>` with no lock. Here: `raiseTicket` and `replyToTicket` carry forms; `setTicketStatus` and `rateTicket` are buttons.

- [ ] **Step 1: Write the failing wire tests**

Append to `UI/src/__tests__/writes.test.ts` (reuse its `serve`, `json`, `refusal`, `hit`, `calls`, `STOCK` and `snapshot` helpers exactly as they are — and note that `snapshot()` now needs a `roster` key or `applySnapshot` will throw):

```ts
const SUP = {
  id: "SUP-0044", topic: "A number looks wrong", subject: "Cash reads zero", priority: "Urgent",
  st: "Open", by: "Kavitha Raman", role: "counter", loc: "coffee",
  at: "2026-09-04T03:42:00.000Z", screen: "Dashboard",
  messages: [{ id: "m1", from: "user", who: "Kavitha Raman", at: "2026-09-04T03:42:00.000Z", body: "Since 09:00." }],
};

describe("raiseTicket — POST /support/tickets", () => {
  it("sends what the form holds, pulls the desk back, and shows the server's sentence", async () => {
    as("counter");
    serve({
      "POST /api/v1/support/tickets": () => json({ result: SUP, changed: ["tickets"], message: `${SUP.id} raised — support replies to urgent tickets within the hour` }),
      "GET /api/v1/support/tickets": () => json([SUP]),
    });

    expect(await S().raiseTicket({ topic: "A number looks wrong", subject: " Cash reads zero ", body: "Since 09:00.", priority: "Urgent", screen: "Dashboard" })).toBe(true);

    // Trimming is the server's job; the body carries what was typed.
    expect(hit("POST /api/v1/support/tickets")[0].body).toEqual({
      topic: "A number looks wrong", subject: " Cash reads zero ", body: "Since 09:00.", priority: "Urgent", screen: "Dashboard",
    });
    // "tickets" has a narrow reader, so this is one GET and not a whole snapshot.
    expect(hit("GET /api/v1/support/tickets")).toHaveLength(1);
    expect(hit("GET /api/v1/snapshot")).toHaveLength(0);
    expect(S().tickets[0].id).toBe(SUP.id);
    // The wire carries ISO; the store holds what the screen prints.
    expect(S().tickets[0].at).toBe("09:12");
    expect(S().toast).toBe(`${SUP.id} raised — support replies to urgent tickets within the hour`);
  });

  it("answers false and keeps nothing of its own when the server refuses", async () => {
    as("counter");
    serve({ "POST /api/v1/support/tickets": () => refusal("Give the ticket a subject so support knows what it is about") });
    expect(await S().raiseTicket({ topic: "Something else", subject: "  ", body: "", priority: "Low", screen: "Dashboard" })).toBe(false);
    expect(S().tickets).toHaveLength(0);
    expect(S().toast).toBe("Give the ticket a subject so support knows what it is about");
  });
});

describe("replyToTicket / setTicketStatus / rateTicket", () => {
  it("replies on the ticket and reads the desk back", async () => {
    as("counter");
    const replied = { ...SUP, st: "With support", messages: [...SUP.messages, { id: "m2", from: "user", who: "Kavitha Raman", at: "2026-09-04T04:10:00.000Z", body: "Still happening." }] };
    serve({
      "POST /api/v1/support/tickets/SUP-0044/messages": () => json({ result: replied, changed: ["tickets"], message: "Reply sent on SUP-0044" }),
      "GET /api/v1/support/tickets": () => json([replied]),
    });
    expect(await S().replyToTicket("SUP-0044", "Still happening.")).toBe(true);
    expect(hit("POST /api/v1/support/tickets/SUP-0044/messages")[0].body).toEqual({ body: "Still happening." });
    expect(S().toast).toBe("Reply sent on SUP-0044");
  });

  it("marks it resolved through its own endpoint", async () => {
    as("counter");
    serve({
      "POST /api/v1/support/tickets/SUP-0044/status": () => json({ result: { ...SUP, st: "Resolved" }, changed: ["tickets"], message: "SUP-0044 — resolved" }),
      "GET /api/v1/support/tickets": () => json([{ ...SUP, st: "Resolved" }]),
    });
    await S().setTicketStatus("SUP-0044", "Resolved");
    expect(hit("POST /api/v1/support/tickets/SUP-0044/status")[0].body).toEqual({ st: "Resolved" });
  });

  it("rates it, and repeats the refusal when the desk has not finished", async () => {
    as("counter");
    serve({ "POST /api/v1/support/tickets/SUP-0044/rating": () => refusal("SUP-0044 is not finished yet — rate it once support has resolved it") });
    await S().rateTicket("SUP-0044", 5);
    expect(hit("POST /api/v1/support/tickets/SUP-0044/rating")[0].body).toEqual({ rating: 5 });
    expect(S().toast).toBe("SUP-0044 is not finished yet — rate it once support has resolved it");
  });
});

describe("what the browser no longer knows on its own", () => {
  it("takes the payer roster from the snapshot, not from a fixture", async () => {
    as("counter");
    // A patient the fixtures have never heard of, admitted this morning.
    const roster = { patients: [{ kind: "patient", id: "IP-9999", name: "Admitted This Morning" }], staff: [], depts: [] };
    applySnapshot({ ...snapshot(), roster } as never);
    expect(PATIENTS.map((p) => p.id)).toEqual(["IP-9999"]);
  });

  it("asks the server what a staff member has taken, rather than adding up its own week", async () => {
    as("counter");
    serve({ "GET /api/v1/reports/credit/staff/RC-1902": () => json({ kind: "staff", id: "RC-1902", name: "Vinoth Prakash", since: "2026-09-01T00:00:00.000Z", taken: 2480, limit: 3000, room: 520 }) });
    const r = await creditFor({ kind: "staff", id: "RC-1902", name: "Vinoth Prakash" });
    expect(r.taken).toBe(2480);
    expect(r.room).toBe(520);
  });
});
```

`creditFor` is whatever helper `Pos.tsx` ends up using; if the credit read stays inside the component, assert it through a mounted `Pos` instead — the point being pinned is that the number comes off the wire.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rch/ui test`
Expected: FAIL, and also fail to typecheck — `TicketSchema.hist` and `SnapshotSchema.roster` are required and the store does not supply them, which is the red Tasks 1, 4 and 6 left on purpose.

- [ ] **Step 3: Turn the four support actions into API calls**

In `UI/src/store/ops.ts`, replace the four bodies. The shape is the one every other cut-over action already has — read `askShop` in the same file and copy it:

```ts
  raiseTicket: async (p) => {
    try {
      const r = await call(routes.raiseTicket, { body: p });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not raise the ticket."); return false; }
  },
```

`replyToTicket` the same with `{ params: { id }, body: { body } }`; `setTicketStatus` and `rateTicket` the same but returning `void`. **Delete `seedTickets` from the file's imports and `tickets: seedTickets()` from the slice's initial state** — it becomes `tickets: []`.

Then run Decision 8's grep over the same file. **If `slug()` is still there, so is at least one local action, and it is cut over here** with the same shape — Phase 5's Task 10 is the owner of that work but this phase is the one that has to end with the file clean. Whatever the grep finds, say so in the report.

- [ ] **Step 4: Delete the seed path**

1. `rm UI/src/data/seed.ts UI/src/data/ops.ts`.
2. `UI/src/data/vendors.ts`: delete `export { seedVendors } from "@rch/contract/fixtures";`. The two helpers stay. **Two test files import `seedVendors` through it** — `UI/src/__tests__/procurement.test.ts:3` (`import { seedVendors, suggestVendor, vendorName } from "../data/vendors";`) and `UI/src/__tests__/screens.test.tsx:20`. Re-point both at `@rch/contract/fixtures` directly, which is where §5.1 puts a test's fixtures; leave their `suggestVendor` / `vendorName` imports pointing at `../data/vendors`, which is still where those live.
3. `UI/src/store/index.ts`: delete the `import * as FX from "@rch/contract/fixtures";` line, the `../data/seed` import, the `seedVendors` import, and `signIn` / `signOut` — both the interface members and the implementations. Replace every seeded initial value with an empty one:

```ts
/** Every collection starts empty and is filled by `applySnapshot`. Nothing here is data: the
 *  screens do not render until `auth` reaches "ready", which only a snapshot can do. `stock` is
 *  exhaustive because every `stock[loc][it]` read would otherwise throw on a missing location. */
const EMPTY_STOCK = Object.fromEntries(ALL_LOCS.map((l) => [l, {}])) as Record<LocKey, Record<string, number>>;
```
```ts
  stock: EMPTY_STOCK, rsv: {}, ovr: {}, prices: { A: {}, B: {} }, menu: {},
  req: [], tkt: [], prq: [], po: [], pord: [], batch: [], bills: [], grn: [], vendors: [],
  sales: [], dayLabels: [],
```

`basePrices()` reads `PL`, which is empty until `hydrateMaster` runs, so `prices: { A: {}, B: {} }` and `basePrices()` are the same thing at boot — use the literal and drop the call if nothing else needs it there.

**Check `App.tsx` first.** The loading gate must already hold every screen back until `auth === "ready"`; if any screen renders at `"signed-out"` or `"loading"` and reads `IT`/`stock`, it will now render against nothing. `grep -n 'auth' UI/src/App.tsx` and confirm, and if there is a gap, close it here and say so — that gap was always there, hidden by seed data.

- [ ] **Step 5: Hydrate the roster, apply the support tickets, and read the ticket's history**

In `UI/src/data/master.ts`:

```ts
/** Who a bill may be charged to. Mutable registries like IT and LOC, for the same reason: the
 *  counter's screen imports them directly, so they must keep their identity — assign into them,
 *  never reassign them. Filled by `hydrateRoster` from the snapshot's `roster`, which the server
 *  reads out of the `payers` table it has been validating the till against since Phase 3. */
export const PATIENTS: Payer[] = [];
export const STAFF: Payer[] = [];
export const DEPTS: Payer[] = [];
export function hydrateRoster(r: PayerRoster): void {
  PATIENTS.splice(0, PATIENTS.length, ...r.patients);
  STAFF.splice(0, STAFF.length, ...r.staff);
  DEPTS.splice(0, DEPTS.length, ...r.depts);
}
```

and change the destructuring line — `export const { PAR_FACTOR, PATIENTS, STAFF, DEPTS, STAFF_CREDIT_LIMIT, PO_APPROVAL_LIMIT } = FX;` — to a re-export from the contract, which is where Task 1 moved the three that were not demo data:

```ts
export { ALL_LOCS, OUTLETS, PAR_FACTOR, STAFF_CREDIT_LIMIT, PO_APPROVAL_LIMIT } from "@rch/contract";
```

`PAR_FACTOR` is a `Record<LocKey, number>` on both sides of that move and `parOf` (`UI/src/lib/selectors.ts:45`) still reads `PAR_FACTOR[l] ?? 1` unchanged. If it arrives as a scalar, Task 1 got it wrong and this task stops and says so rather than adapting `parOf` around it. The `import * as FX from "@rch/contract/fixtures";` line at the top of `data/master.ts` goes with the last of these — that is the import Step 12 proves is gone.

In `UI/src/api/wire.ts`: call `hydrateRoster(s.roster)` inside `applySnapshot` beside `hydrateMaster`; render the ticket's new `hist` through the same `hist()` helper every other document uses (`tkt: s.tkt.map((t) => ({ ...t, hist: hist(t.hist) }))` — `tkt` currently passes straight through because nothing on it was a time, and that is no longer true).

**And give the narrow reader the same treatment.** `UI/src/api/wire.ts:67`'s `applyTickets` is what `refetch("tkt")` calls after every handover, receipt and cancellation; leaving it a pass-through puts raw ISO stamps into the drawer's history the moment anything refetches, which is exactly the bug this phase's date convention exists to prevent:

```ts
/** GET /tickets -> the tickets. The lines and the OTP pass through; the history does not. */
export function applyTickets(tkt: Snapshot["tkt"]): void {
  useApp.setState({ tkt: tkt.map((t) => ({ ...t, hist: hist(t.hist) })) });
}
```

Then add:

```ts
/** GET /support/tickets -> the desk. Times as "HH:MM", on the ticket and on every message. */
export function applySupportTickets(rows: Snapshot["tickets"]): void {
  useApp.setState({ tickets: rows.map((x) => ({ ...x, at: t(x.at), messages: x.messages.map((m) => ({ ...m, at: t(m.at) })) })) });
}
```

In `UI/src/api/refetch.ts`, add to `NARROW`:

```ts
  tickets: () => call(routes.tickets).then(applySupportTickets),
```

- [ ] **Step 6: Rebuild the Support screen**

`UI/src/pages/Support.tsx`, four changes and no more:

1. **The list is already yours.** Delete the `mineOnly` state, the `FilterBtn`, and the `t.by !== user.n` line in the filter. `mine` becomes `tickets`.
2. **The third KPI cannot be answered any more,** and should not be: replace `{ l: "Open across the hospital", v: String(live), d: "all roles" }` with `{ l: "Resolved and closed", v: String(tickets.filter((t) => t.st === "Resolved" || t.st === "Closed").length), d: "your history" }`, and delete `live`.
3. **The "Raised by" column is always you.** Replace it with `{ h: "Raised" }` showing `t.at`, and move the id out of the subtitle if it is now duplicated. Keep the `Avatar` in the conversation, where two people do speak.
4. **The FAQ's fourth answer is a lie.** *"This build keeps data in the browser for the session only. Nothing is saved to a server yet, so a refresh returns to the starting position."* has been wrong since Phase 1 and is now the opposite of true. Replace the pair with something that is:
   ```ts
     ["Someone else's change did not show up on my screen.",
      "It should, within a second, without a reload — the portal keeps a live connection open for exactly that. If the header's status dot is not green, the connection has dropped and is retrying; a reload brings everything back either way."],
   ```

Then make the two form actions awaited behind a busy lock, exactly as `Pos.tsx` and `MakeDistribute.tsx` do:

```tsx
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      // Only clear the form once the server has taken it: a refusal must land on what was typed.
      if (await raiseTicket({ topic, subject, body, priority, screen })) { setSubject(""); setBody(""); setPriority("Normal"); }
    } finally { setBusy(false); }
  };
```

and the same for the drawer's reply. `Mark resolved`, `Reopen` and the five rating buttons stay plain clicks.

`SupportDrawer` also gains the rule it was missing: draw `Mark resolved` / `Reopen` from `SUPPORT_TRANSITIONS` and the rating section from `mayRate(t.st)` rather than from `t.st === "Resolved"`, so a closed ticket can still be rated and a button the server refuses is never drawn (§5.1: *"A transition the UI offers but the server refuses is impossible by construction"*).

- [ ] **Step 7: Take the OTP off the screens that should not have it**

The sweep found seven sites. For each:

| File | What it does now | What it does |
|---|---|---|
| `roles/store/IssueDetail.tsx:199` | `<Otp value={ticket.otp} />` beside the input | Replace with a line: *"Ask {LOC[ticket.to].n} to read out the six digits on their ticket."* Keep the input and the override button, both unchanged. |
| `roles/store/TicketDrawer.tsx:92` | the same panel | The same replacement. |
| `roles/store/IssueDesk.tsx:246` | an OTP column | Remove the column and its header. |
| `roles/store/IssueDesk.tsx:84` | search matches `t.otp` | Remove that clause — it now searches `""` for every row. |
| `roles/manager/ItemsStock.tsx:203` | prints the OTP in a cell | Replace with the destination's name: `LOC[t.to].n`. |
| `roles/prod/Tickets.tsx:166` | `<Otp value={t.otp} />` | Guard it: `t.to === user.loc && t.st === "Issued" ? <Otp value={t.otp} /> : <span className="mini">Held by {LOC[t.to].n}</span>`. |
| `roles/counter/TicketDrawer.tsx:44` | `<Otp value={tkt.otp} />` | **Unchanged.** The counter is the collector; this is the one screen the digits are for. |
| `roles/counter/Tickets.tsx:30` | search matches `t.otp` | **Unchanged.** It searches their own inbound tickets, which carry it. |

The server sends `""`, so nothing breaks if a site is missed — it renders six blanks, which is worse than an honest sentence. That is why this is a table and not "remove where appropriate".

- [ ] **Step 8: Give the counter its cancel button, and the drawers their history**

In `UI/src/roles/counter/TicketDrawer.tsx`, add the withdraw path the store's drawer already has (read `UI/src/roles/store/TicketDrawer.tsx` and copy its shape — a reason field, a busy lock, `cancelTicket(id, reason)` returning `Promise<boolean>`), shown only when `tkt.from === user.loc && tkt.st === "Issued"`. The toast is the server's.

In both ticket drawers and in `roles/store/IssueDetail.tsx`, render `tkt.hist` with the same `<Section title="History">` block the request and requisition drawers use — find one (`grep -rn 'hist.map' UI/src/roles`) and copy it, so a fourth rendering of a history does not invent a fourth layout.

- [ ] **Step 9: Point the two reports at the server**

**Both reads go through the store, not through `call`.** `.oxlintrc.json`'s third override makes `**/api/client` a `no-restricted-imports` **error** under `UI/src/roles/**` and `UI/src/pages/**` — a screen that fetches for itself fails `pnpm lint`, and it is also a screen that cannot be tested without a network. Add two actions to `AppState` in `UI/src/store/index.ts`, beside the other server-backed ones, and implement them in the same `create()` body:

```ts
  /** The central store's ledger over a window, from the server's own sum of `stock_moves`.
   *  Answers `[]` and toasts when the read fails: a report that cannot load says so and leaves
   *  the screen usable, rather than throwing inside a render. */
  readStockLedger: (loc: StockLoc, days: number) => Promise<StockLedgerRow[]>;
  /** What one payer has put on credit this calendar month, hospital-wide — the number the
   *  server will refuse on. `null` when the read fails, so the till can say "checking…" rather
   *  than print a zero, which would read as "no credit taken". */
  readCredit: (payer: Payer) => Promise<CreditResponse | null>;
```
```ts
  readStockLedger: async (loc, days) => {
    try { return (await call(routes.stockLedger, { query: { loc, days } })).rows; }
    catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not read the stock ledger."); return []; }
  },
  readCredit: async (payer) => {
    // Silent on failure on purpose: this runs on every payer selection at a busy till, and a
    // toast per keystroke would bury the sentence that matters. The server still refuses.
    try { return await call(routes.creditReport, { params: { kind: payer.kind, id: payer.id } }); }
    catch { return null; }
  },
```

**`roles/store/Reports.tsx`'s `ledger`.** It is one of ten `build: (s: AppState) => Rep` functions, all synchronous. Rather than making the whole report library async, fetch the ledger when that report is selected and keep it in component state:

```tsx
  // The nine other reports are arithmetic over collections this snapshot already holds whole.
  // This one is not: the ledger's opening balance is a sum of stock moves, which the browser has
  // never held, and reconstructing it backwards from receipts and issues is what a withdrawn
  // ticket used to walk by the quantity it never moved.
  const readStockLedger = useApp((s) => s.readStockLedger);
  const [ledgerRows, setLedgerRows] = useState<StockLedgerRow[] | null>(null);
  useEffect(() => {
    if (sel !== "ledger") return;
    let live = true;
    void readStockLedger("store", 30).then((rows) => { if (live) setLedgerRows(rows); });
    return () => { live = false; };
  }, [sel, readStockLedger]);
```

and `ledger`'s `build` reads `ledgerRows ?? []`, printing an empty-state while it is `null`. Its columns keep their headings; `Value at cost` stays a client calculation over `closing × costOf(k)`, and the foot uses `ledgerTotals`. Delete the backwards `close - recd + out` arithmetic and its comment; the comment explained a workaround that no longer exists.

**`roles/counter/Pos.tsx`'s credit.** Replace the `taken` line and the paragraph under it:

```tsx
  // The ceiling is settled over the calendar month across every counter, which this till cannot
  // see — it holds seven days of its own outlet. Ask the server for the number it will refuse on.
  const readCredit = useApp((s) => s.readCredit);
  const [credit, setCredit] = useState<CreditResponse | null>(null);
  useEffect(() => {
    if (tender !== "Staff credit" || !payer) { setCredit(null); return; }
    let live = true;
    void readCredit(payer).then((r) => { if (live) setCredit(r); });
    return () => { live = false; };
  }, [tender, payer, readCredit]);
  const taken = credit?.taken ?? 0;
  const overLimit = tender === "Staff credit" && !!payer && !!credit && breachesCredit(taken, total, credit.limit);
```

The paragraph loses its apology and says what is true: *"Credit taken by {payer.name} this month **{money(taken)}** of **{money0(credit.limit)}** — this bill would take it to **{money(taken + total)}**."* While `credit` is `null` the Take-payment button is **not** blocked on `overLimit` (the server still refuses, and blocking on a read that has not landed would stop a legitimate sale) — but the paragraph says *"checking…"* rather than showing a zero, which would read as "no credit taken" and is the one wrong thing this screen must not say.

Neither component imports `api/client`, `routes` or `ApiError`; both call a store action through `useApp`, exactly as every other screen in the app reaches the server. That is §5.1's rule and `.oxlintrc.json`'s third override enforces it at error level for everything under `UI/src/roles/` and `UI/src/pages/` — writing `call(...)` in either file fails `pnpm lint`, which is this task's own gate.

- [ ] **Step 10: Rework the test fixture**

`UI/src/__tests__/fixture.ts`, rewritten:

```ts
import * as FX from "@rch/contract/fixtures";
import { useApp } from "../store";
import { setAccessToken } from "../api/session";
import { hydrateMaster, hydrateRoster } from "../data/master";
import { basePrices } from "../lib/selectors";
import type { Role } from "../types";

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
export const S = () => useApp.getState();

/**
 * Sign in, the way `login()` leaves the store: a token in memory, the caller's own whole record,
 * and `auth: "ready"`. The store's own `signIn` hook is gone — it read the fixtures from inside
 * production code, which is exactly what this phase deleted — so the fixtures are imported here,
 * in a test file, where §5.1 says they belong.
 */
export const as = (role: Role) => {
  setAccessToken("test-token");
  useApp.setState({ user: FX.USERS.find((u) => u.r === role)!, auth: "ready", mustChangePassword: false, drawer: null });
};

/** What `logout()` leaves behind. */
export const signedOut = () => {
  setAccessToken(null);
  useApp.setState({ user: null, auth: "signed-out", drawer: null, mustChangePassword: false });
};

/** The demo hospital, in the store. Master data goes through the same two hydrators the snapshot
 *  uses, so a test sees exactly the registries a signed-in browser sees. */
export function resetStore() {
  hydrateMaster({ items: FX.IT, locations: FX.LOC, recipes: FX.RCP, prices: FX.PL, menu: FX.MENU, users: FX.USERS });
  hydrateRoster({ patients: FX.PATIENTS, staff: FX.STAFF, depts: FX.DEPTS });
  useApp.setState({
    user: null, auth: "signed-out",
    stock: clone(FX.seedStock), rsv: clone(FX.seedRsv()), ovr: {}, prices: basePrices(),
    menu: clone(FX.MENU), req: clone(FX.seedReq), tkt: clone(FX.seedTkt), prq: clone(FX.seedPrq),
    po: clone(FX.seedPo), pord: clone(FX.seedPord), batch: clone(FX.seedBatch), bills: clone(FX.seedBills),
    grn: clone(FX.seedGrn), vendors: clone(FX.seedVendors), sales: clone(FX.seedSales), dayLabels: FX.DAY_LABELS,
    contracts: FX.seedContracts(), productReqs: FX.seedProductRequests(), shopAsks: FX.seedShopAsks(),
    tickets: FX.seedTickets(),
    cart: {}, draft: [], prqDraft: [], drawer: null, toast: null, shopFilter: null,
  });
}
```

**It stays `setState` and does not go through `applySnapshot`.** The fixtures' times are display strings (`"09:12"`, `"Yesterday"`, `"27-Aug"`) and `applySnapshot` runs `fromWireTime` over everything it is handed; feeding it fixtures would turn every stamp into garbage. Building the state directly is what `resetStore` has always done and it is still right — what changed is only where the fixtures are imported from. Say this in a comment in the file, or somebody will "tidy" it later.

Then repoint the four suites that called the deleted hooks: `app.test.tsx` and `screens.test.tsx` use `as(role)`; `app.test.tsx`'s sign-out case and `theme.test.ts` use `signedOut()`.

- [ ] **Step 11: Make the make-tile refusal case deterministic**

Phase 4's ledger recorded a flake at `writes.test.ts` ~809 — *"leaves the quantity on the make tile when the kitchen is short"* — under `act()` + a single `setTimeout(0)`. Phase 5's Task 10 was asked to fix it. **Check whether it did** (`grep -n 'settle\|flushUntil' UI/src/__tests__/writes.test.ts`). If `settle` is still one `setTimeout(0)`, replace it:

```ts
  /** One macrotask is not always enough: the click fires an async action whose refusal walks a
   *  fetch rejection, a notify and a setState, and under load the assertion can run between two
   *  of them. Flush until the thing being waited for is true, or give up loudly. */
  const settleUntil = async (fn: () => void, ok: () => boolean, tries = 50) => {
    await act(async () => { fn(); await new Promise((r) => { setTimeout(r, 0); }); });
    for (let i = 0; i < tries && !ok(); i++) await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
    if (!ok()) throw new Error("the condition never became true — the action did not settle");
  };
```

and use it in the two refusal cases: `settleUntil(() => ui.button("Make")!.click(), () => S().toast !== null)`. Leave the passing cases on `settle`. Record in the report whether this was already fixed.

- [ ] **Step 12: Run the whole gate**

Run: `pnpm turbo typecheck test --force && pnpm lint`
Expected: **everything green, for the first time this phase.** Then prove the deletion actually happened:

```bash
grep -rn '@rch/contract/fixtures' UI/src | grep -v '__tests__'    # must print nothing
test ! -f UI/src/data/seed.ts && test ! -f UI/src/data/ops.ts && echo "the seed path is gone"
grep -rn 'signIn\|signOut' UI/src                                  # must print nothing
# The two widened element types: every one of these call sites passes a LocKey, so `OUTLETS` and
# `ALL_LOCS` must still be `LocKey[]` and not a narrowed readonly tuple. `pnpm turbo typecheck`
# is the real proof; this is how you find them if it goes red.
grep -rn 'OUTLETS.includes\|ALL_LOCS.includes' UI/src
# And the par factor kept its shape, not just its name.
grep -rn 'PAR_FACTOR' UI/src packages/contract/src
```

- [ ] **Step 13: Look at it**

`pnpm dev`, sign in as the store keeper and as a counter operator in two windows, and check the five things this task changed by hand:
1. Support shows only your own tickets in both windows; raise one, reply, resolve, rate — every toast is a full sentence.
2. The store's issue desk has no OTP anywhere; the counter's ticket does. Hand over by reading it across.
3. A ticket drawer shows its history, including a supervisor override if you make one.
4. The counter can withdraw a transfer it granted, and the ask comes back on the other shop's screen without a reload.
5. The staff-credit line at the till says "this month" and matches what a refusal reports.

- [ ] **Step 14: Commit**

```bash
git add UI
git rm UI/src/data/seed.ts UI/src/data/ops.ts
git commit -m "$(cat <<'EOF'
Close the last in-memory path and delete the browser's copy of the hospital

The support desk posts and reads like everything else. The store's four actions became four calls;
its ticket list is the caller's own, which is what the server sends and what the screens now say —
the "only mine" filter and the hospital-wide count both went, because neither could be honest any
more.

data/seed.ts and data/ops.ts are gone, data/vendors keeps only its two helpers, and no file under
UI/src outside __tests__ imports the fixtures. The store starts empty and is filled by the
snapshot; the payer roster comes from the payers table the till has been checked against since
Phase 3, so a patient admitted this morning is billable. signIn and signOut went with them: a test
hook that read fixture users from inside production code was the last reason that import existed,
and the tests set the session the way login leaves it instead.

The six digits are off every screen but the collector's, with a line telling the store keeper to
ask for them; the ticket drawers show the trail that has been written since Phase 3 and read by
nobody; a counter can withdraw a transfer it granted; and the two figures the browser was guessing
at — the store's opening balance and a staff member's credit for the month — come off the wire
with the apology under the credit line deleted.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: The product contract, rewritten from the product

*(Wave 4, alone. It is the only task that edits `docs/`, `README.md`, `UI/README.md`, the five `CLAUDE.md` guides and `deploy/RUNBOOK.md`.)*

**Precondition, checked by the controller before dispatch:** Phase 5's own docs commit must already be on the branch — the root `CLAUDE.md`, the four package guides and spec §16's "Amendments recorded during Phase 5" sub-heading (at the time this plan was written §16 had sub-headings for Phases 3 and 4 only). `git log --oneline -5 -- CLAUDE.md docs/superpowers/specs/` before dispatching, **and confirm that every item in `.superpowers/sdd/2026-09-04-backend-phase-5-procurement/task-11-notes.md` appears in §16's Phase 5 sub-heading.** The two phases' Task 11s edit the same twelve files; a Phase 6 rewrite over an unfinished Phase 5 docs commit loses the Phase 5 rows silently, and nothing downstream notices. This task rewrites all of those and appends a Phase 6 sub-heading below Phase 5's.

**Files:**
- Modify: `docs/ua-spec.html`, `docs/system-design.html`, `docs/user-flows.html`, `docs/superpowers/specs/2026-09-03-backend-design.md`, `CLAUDE.md`, `apps/api/CLAUDE.md`, `packages/contract/CLAUDE.md`, `packages/domain/CLAUDE.md`, `UI/CLAUDE.md`, `README.md`, `UI/README.md`, `deploy/RUNBOOK.md`

*(The two `vitest.config.ts` TZ pins and the GRN id change the §16 rows below describe are **Task 13's** code, not this task's. This task records the decisions and adds the runbook line; Task 13 makes the changes, in wave 2. Do not edit a config or an id format here.)*
- Create: `e2e/README.md` if Task 8 did not write one

**All of it lands in one commit.** The guides are what a fresh agent reads before touching a package; one that still describes Phase 5 sends the next person down a path that no longer exists.

- [ ] **Step 1: Rewrite `docs/ua-spec.html`**

This is the largest single piece of writing in the phase and the one §12 explicitly gates on: *"The 24 UAT scenarios in `docs/ua-spec.html` that the frontend implements are encoded as integration tests against the API."* The document is a pre-implementation pitch — Phase 3's ledger flagged it, Phase 4's carried it, and it contradicts the other two docs. It describes nine roles (Indentor, F&B Manager, Purchase Officer, Dietitian, Accounts, Administrator, Management…) where five exist, and nine of its twenty-four scenarios test features that were never built.

**Do not rewrite the whole document.** Its chrome, its CSS, its section numbering and its tone are good and are the house style. Rewrite these sections and leave the rest:

| Section | What is wrong | What it becomes |
|---|---|---|
| 03 "Who logs in" | Nine roles | The five in `packages/contract/src/schemas/common.ts`'s `RoleSchema`, each with its module list from spec §8.3, and the real sign-in: employee number + password, Argon2id, a change-password step, no store picker and no counter PIN |
| 04 "Approval matrix" | Thresholds and approvers that do not exist | What actually gates: the manager on stock requests, the buyer on requisitions, `PO_APPROVAL_LIMIT` as a **flag** with no approver behind it (say so), the OTP at handover with the labelled supervisor override |
| 05 stages 00–12 | Twelve stages, several unbuilt | Six: masters and opening balance · requisition to purchase order to goods receipt · stock at rest, including quarantine · issue by ticket · production · sale and billing. Stages 10, 11 and 12 (consumption without a sale, day close and wastage, settlement) move to the new "not in this release" section |
| 06 "How it looks" | Mock screens with the wrong roles and a store picker on sign-in | Fix the two role tables and the sign-in mock; the other mocks are indicative and stay, with the caption already saying so |
| 07 "Screen inventory" | A list from the pitch | The real one: generate it from `UI/src/nav.ts` — `NAV[role]`'s groups and labels are the sidebar, and that is the inventory |
| 08 "User acceptance" | 24 scenarios, nine unbuildable | 24 scenarios that pass, each with the test that proves it. See below |
| 09 "Added to your flow" · 10 "Your decisions" | A pitch's closing sections | One section: "What was built, what was declined, and why" — the quarantine ledger, the finance approver, the support agent, batch-level MRP, FEFO, shift close, wastage, the credit note. Each with the reason and where it is recorded |

**The 24 scenarios.** Every row is `UA-nn · Role · Action · Expected · Proved by`, and the last column names a real file. Build the table from what is already tested — do not invent a scenario and then go looking. The eight Playwright scenarios (Task 8) become UA rows; the rest come from the server suites. A worked shape for the first three:

| # | Role | Action | Expected | Proved by |
|---|---|---|---|---|
| UA-01 | Counter Operator | Open the purchase-order screen, including by direct link | The sidebar does not offer it and the direct link lands back home with a toast saying why | `e2e/tests/signin.spec.ts` · `UI/src/__tests__/app.test.tsx` · the route's 404 in `purchaseorders.test.ts` |
| UA-02 | Counter Operator | Sell two juices for cash | Bill numbered `CF/n`, GST split out, both shelves down, the till roll up | `e2e/tests/sell.spec.ts` · `apps/api/src/modules/pos/pos.test.ts` |
| UA-03 | Counter Operator | Two counters sell the last unit at the same moment | The first bill succeeds; the second is refused naming what is left; stock never goes negative | `pos.test.ts`'s warmed lock race |

**The remaining 21 are enumerated here so this step is bounded work and not an open brief.** Each is one row in the same five-column shape; the "Proved by" column must name a file that exists and a case whose name appears in the last green test run, which is exactly what Task 12 Step 7 re-checks.

| # | Role | Action | Proved by (a module suite unless noted) |
|---|---|---|---|
| UA-04 | Counter Operator | Sell a made-to-order drink; ingredients move, the finished item does not | `pos.test.ts` |
| UA-05 | Counter Operator | Charge a bill to an inpatient, then to a department | `pos.test.ts` |
| UA-06 | Counter Operator | Run a staff member past the monthly credit ceiling | `pos.test.ts` · `reports.test.ts` (the report agrees with the refusal) |
| UA-07 | Counter Operator | Sell an item switched off by hand | `availability.test.ts` · `pos.test.ts` |
| UA-08 | Outlet Manager | Price a traded item above its printed MRP | `catalog.test.ts` |
| UA-09 | Outlet Manager | Add and remove an item from one outlet's menu | `catalog.test.ts` |
| UA-10 | Counter Operator | Raise a stock request; the manager approves and the counter's screen moves with no reload | `e2e/tests/request-chain.spec.ts` · `requests.test.ts` |
| UA-11 | Outlet Manager | Approve more than the central store can free-to-promise | `requests.test.ts` |
| UA-12 | Store Keeper | Issue a ticket and hand it over on the collector's OTP | `tickets.test.ts` · `e2e/tests/request-chain.spec.ts` |
| UA-13 | Store Keeper | Hand over with no OTP — the labelled supervisor override, recorded and now visible | `tickets.test.ts` |
| UA-14 | Store Keeper | Withdraw a ticket nobody collected; the hold and the request both go back | `tickets.test.ts` |
| UA-15 | Counter Operator | Withdraw a transfer this outlet granted; the ask returns to the other shop's desk | `tickets.test.ts` |
| UA-16 | Counter Operator | Ask another shop for stock; it grants part of it | `shopasks.test.ts` |
| UA-17 | Production | Make a batch: ingredients off, units on, best-before stamped | `production.test.ts` · `e2e/tests/kitchen.spec.ts` |
| UA-18 | Production | Make more than the kitchen can cover — refused, naming the ingredient, nothing moved | `production.test.ts` · `e2e/tests/kitchen.spec.ts` |
| UA-19 | Production | Dispatch a production order short of one line — all-or-nothing | `production.test.ts` |
| UA-20 | Store Keeper / Buyer | Requisition → approve → purchase order; the claim leaves the list | `requisitions.test.ts` · `purchaseorders.test.ts` · `e2e/tests/buying.spec.ts` |
| UA-21 | Store Keeper | Receive 150 against an order for 144 — inside 2 %; then 200 — refused | `grn.test.ts` |
| UA-22 | Store Keeper | Receive a batch already expired, and one whose expiry precedes manufacture | `grn.test.ts` |
| UA-23 | Any role | Raise a support ticket, reply, resolve, rate; another role cannot see it | `support.test.ts` · `e2e/tests/support.spec.ts` |
| UA-24 | Accounts / Store Keeper | **Reconcile: `db:rebuild-balances` reproduces every balance from the moves alone** | `apps/api/src/lib/ledger.test.ts` + Task 12's exit walk, step 7 |

UA-24 keeps its number and its role deliberately: it is the closest thing this system has to the document's original reconciliation scenario, and it is what actually gates go-live.

Replace the "Exit criteria for sign-off" paragraph that names Accounts and the day-close reconciliation with one that names UA-24 as written above plus the §12 checklist, and move the nine scenarios that tested features nobody built into the new "What was built, what was declined, and why" section **by name** rather than deleting them silently.

Delete the "Exit criteria for sign-off" paragraph that names UA-24 and Accounts, and replace it with the rebuild-balances statement plus the §12 checklist reference.

- [ ] **Step 2: Reconcile `system-design.html` and `user-flows.html`**

Read both against the built system and fix what is now false. Specifically: the OTP's visibility, the support desk's scoping, `data/seed.ts` no longer existing, the quarantine location, the five roles, and any sentence claiming the app keeps its data in the browser. Then read all three docs **against each other** — Phase 3's ledger recorded that `ua-spec.html` contradicted the other two, and the fix is not complete if it now contradicts them in a new way.

- [ ] **Step 3: Rewrite the root `CLAUDE.md`**

- *What this is*: "**Phases 1–5 of the backend are implemented**" → "**The backend is complete: all six phases of `docs/superpowers/specs/2026-09-03-backend-design.md` §14 are implemented.**" Then rewrite the paragraph that follows, which currently promises that mutations still run against the in-memory store: **every mutation is a server call**, `UI/src/data/seed.ts` is gone, and the only local state left is what §9.2's last paragraph lists as client-only — `cart`, `draft`, `prqDraft`, `drawer`, `toast`, `shopFilter`, `theme`, `catalogVersion`.
- *Commands*: add `pnpm test:e2e` and `pnpm --filter @rch/api loadcheck`, each with one line saying what it needs running.
- *Repository layout*: add `e2e/`.
- *Architecture → "Derived state is computed, never stored"*: add the exception this phase introduced — two figures are **read**, not derived, because the browser does not hold what they are derived from: the central store's ledger and a payer's credit for the month.
- *Domain invariants*: add **"The OTP belongs to the collector"** as its own invariant, in the same voice as the others.
- *Backend*: replace the "Status: Phase 1 implemented; phases 2–6 pending" line and the build-order paragraph with what is true, and point at §12's checklist and `deploy/RUNBOOK.md`'s go-live section as the operational entry points.

- [ ] **Step 4: The four package guides**

- `apps/api/CLAUDE.md` — "Phases 1–4 are live" → all six; add `support` and `reports` to the module list with one line each; add `lib/credit.ts` to the `lib/` line; add `given.supportTicket` to the builders line; record that a support ticket writes **no** `document_history` row and why; note that `readTickets` now reads histories and that `scope.ts` redacts the OTP; add `roster` to what `/snapshot` returns.
- `packages/contract/CLAUDE.md` — add the five new routes to the manifest section; correct the "Constants, and where they are not" section, which currently says `PO_APPROVAL_LIMIT` and `PAR_FACTOR` are fixtures (Phase 5 moved the first, this phase moved the second along with `ALL_LOCS` and `OUTLETS`); add `schemas/reports.ts` to the layout; record `TicketSchema.hist` and `SnapshotSchema.roster`.
- `packages/domain/CLAUDE.md` — add `support.ts` and `reports.ts`; note the `SHOP_ASK_TRANSITIONS` edge.
- `UI/CLAUDE.md` — the big one: `data/seed.ts` and `data/ops.ts` are gone, no production file imports the fixtures, `signIn`/`signOut` are gone, tests set the session through `__tests__/fixture.ts`'s `as`/`signedOut`, the roster is hydrated, and two screens read a report through a store helper rather than deriving it.

- [ ] **Step 5: Both READMEs**

`README.md`'s status-by-phase table: every row Done, with the exit check each was gated on. Add a "Running it" section that gets a reader from a clone to a signed-in browser in six commands, and a "Going live" pointer to the runbook. `UI/README.md`: the store is an API client with no local rules and no seed; say what is still client-side and why.

- [ ] **Step 6: The runbook**

Add three sections and revise one:

1. **§11 Go-live checklist** — an ordered list, each item a command or a decision with an owner:
   - the AWS facts to fill into `values-prod.yaml` (the five `FILL` markers Task 7 left) and where each comes from;
   - `pnpm --filter @rch/api keys:generate` and putting the pair into Secrets Manager under `rch/prod`;
   - creating the real staff accounts with `pnpm --filter @rch/api users create`, and deactivating the six seeded ones — **including the fact that the seeded accounts must not exist in production**, which nothing has said until now;
   - the restore drill, run once before go-live;
   - `DEPLOY_ENABLED=true` and the five repository secrets;
   - the promotion commands, `develop → staging → production`, and the GitHub environment approval;
   - the first post-deploy checks: `/readyz`, a sign-in, one sale, `db:rebuild-balances` reconciling.
2. **§12 Load check** — how to run `loadcheck.mjs` against a port-forwarded staging pod, what §12's targets are, and what to do when one is missed (the first three things to look at: the snapshot's query count, the pool size, the RDS instance class).
3. **§13 The end-to-end smoke** — `pnpm test:e2e` locally and `E2E=1` in CI, what it writes into the database, and the standing warning that it must never be pointed at production.
4. **Revise §6 Restore drill** so it is executable *locally* as well as against RDS — the current procedure needs a scratch RDS instance, which nobody can run before there is an RDS. Add the Docker equivalent as the rehearsal:
   ```bash
   # Rehearse the drill against the local database, so the real one is not the first time.
   pnpm db:up && pnpm --filter @rch/api db:migrate && pnpm --filter @rch/api db:seed --force
   pg_dump "postgres://rch:rch@localhost:5439/rch" -Fc -f /tmp/rch-drill.dump
   psql "postgres://rch:rch@localhost:5439/postgres" -c 'create database rch_drill'
   pg_restore -d "postgres://rch:rch@localhost:5439/rch_drill" /tmp/rch-drill.dump
   DATABASE_URL="postgres://rch:rch@localhost:5439/rch_drill" pnpm --filter @rch/api db:rebuild-balances
   # The pass condition is an empty diff: the restored balances must equal the source's.
   psql "postgres://rch:rch@localhost:5439/rch"       -c "select loc, item_key, on_hand from stock_balances order by 1,2" > /tmp/src.txt
   psql "postgres://rch:rch@localhost:5439/rch_drill" -c "select loc, item_key, on_hand from stock_balances order by 1,2" > /tmp/dst.txt
   diff /tmp/src.txt /tmp/dst.txt && echo "restore drill: balances reconcile"
   psql "postgres://rch:rch@localhost:5439/postgres" -c 'drop database rch_drill'
   ```
   Keep the RDS procedure below it, unchanged, as the real thing.

Also revise **§9 Alerts** to say the first three now ship as a `PrometheusRule` in the chart (naming the file) and that the two RDS rules remain runbook-only because they need CloudWatch — and add the sixth, `RchSseListenerDown`, cross-referenced from §10 where its rationale already lives.

5. **§8 "Read a document's history" gains a paragraph on GRN numbering**, because it is the one id in the system whose format changed after go-live planning began:
   > A goods receipt is numbered from the order it books in against: `GRN-<yy><po number>-<nn>`, so the second instalment against `PO-2026-0143` is `GRN-260143-02`. It was `GRN-<last three of the PO>-<nn>` until Phase 6, which collided — `PO-2026-0143` and `PO-2027-0143` share a three-character tail, and so do `PO-2026-0143` and `PO-2026-1143`. Because `grns.id` is a primary key, the collision surfaced as a failed insert in the middle of a receipt rather than as a duplicate number. **GRNs written before that change keep their old ids**; nothing was renumbered, and a receipt whose id has a three-character tail is simply an older one. `packages/domain/src/ids.ts`'s `grnId(poId, n)` is the only place the format lives.

   Add the same fact, one line, to §7 "Rebuild balances" where GRN ids are used to trace a `grn_accept` move back to its paperwork.

- [ ] **Step 7: Spec §16 — the Phase 6 rows**

Append a `### Amendments recorded during Phase 6 (2026-09-04)` sub-heading below Phase 5's, in the existing table format. The rows, at minimum:

| Section | Amendment | Why |
|---|---|---|
| §9.1, §9.2 support | Every role sees only the support tickets it raised — `GET /support/tickets` and the snapshot both key on `by_user`, not on a display name, and not only for a counter. | There is no support role among the five, every support write is already "own", and a buyer was being shown a counter operator's account of what went wrong. |
| §9.2 `raiseTicket` | The **subject** is required; the **body** is not. A first message is written only when a body was given. | The screen has always allowed it — Send watches the subject alone — and refusing it would refuse a ticket the operator can send today. |
| §9.2 support, sentences | Four new refusals: a status only support may set, a rating on an unfinished ticket, a reply to a closed one, and the "closed — raise a new one" invitation. | The browser refused none of these because it had no rules; the wording is recorded so the screens repeat the server rather than inventing a second voice. |
| §7.2 `support_tickets` | No `document_history` row is written for a support ticket. | Its history *is* `support_messages` plus a status column; a second trail would give the drawer two lists to keep in step. |
| §7.2 `support_tickets` | No index on `by_user`; accepted, not fixed. | The desk is tens of rows. The trigger for revisiting it is the first month the table passes five figures. |
| §7.2 `document_history` | `status` stays free text and carries composite sentences ("Handed over — supervisor override"). Accepted. | A `note` column means a migration and a backfill of every existing row's suffix, for a field only ever rendered as prose. The trigger is the first consumer that filters on status rather than printing it. |
| §7.2 `tickets` | `TicketSchema` gains `hist`, read from `document_history`. `GET /documents/:type/:id/history` is still not built. | The rows have been written and unread since Phase 3. The generic endpoint would have to answer for eleven document types and be scoped for each; a field on the one document that needed it is smaller and complete. |
| §6, §9.1 | The OTP is on the wire only while a ticket is `Issued` and only for a caller at its `to`. | The store's issue desk printed it beside the box that verifies it, which is not a check. The supervisor override, refused to a counter and recorded in a history that is now visible, is the way past an absent collector. |
| §9.2 `cancelTicket` | `access` gains `counter`; a withdrawn shop-ask ticket returns its ask to `Asked`, clearing the grant. `SHOP_ASK_TRANSITIONS` gains `Sent → Asked`. | Phase 4 recorded that a shop transfer and a shop ask had no cancel door and named Phase 6. The route already scoped on the ticket's `from`, so only the role list changed. |
| §9.1 | `SnapshotSchema` gains `roster`, from `payers` where active. | The till validated against the table and the browser read a fixture; a patient admitted after the last build was unbillable. |
| §9.1 reports | Two server queries — `GET /reports/stock-ledger` and `GET /reports/credit/:kind/:id`. Every other report and all five dashboards stay client-side. | The rule applied: a report that needs more than the caller's snapshot slice becomes a server query. Exactly two do. |
| §5.1, §10 | No file under `UI/src` outside `__tests__` imports `@rch/contract/fixtures`. `data/seed.ts`, `data/ops.ts` and the store's `signIn`/`signOut` are deleted. Tests keep the fixtures, which is what §5.1 asks for. | The fixtures are the shared seed; what had to go was a running browser's path to them. |
| §11.1 | Alerts ship as a `PrometheusRule` gated on `serviceMonitor.enabled`. A Grafana dashboard JSON does **not** ship. | A dashboard in a ConfigMap is an unversioned blob nothing renders in CI and nothing fails when it drifts. |
| §12 | The p95 SLO is measured by `apps/api/scripts/loadcheck.mjs`, run by hand with the machine recorded, not by a CI job. | On a shared runner the number measures the runner. Phase 3 deferred this measurement here; this is where it lands. |
| §13 | The Playwright smoke is a top-level `e2e` workspace whose script is `test:e2e`, run against `pnpm dev` locally and at the end of the kind install in CI. It imports nothing from the workspace. And the load tool is `apps/api/scripts/loadcheck.mjs`, not the `autocannon` §13 names. | A `test` script would be invoked by `pnpm turbo test` with no stack up. Sharing types with the code under test would let both sides change together and still pass. A dependency-free script keeps the phase's only lockfile edit in one task. |
| §14 | Phase 6 adds **no migration**. The journal ends at `0006_rate_contracts_live_uq`. | Every table it needed existed from Phase 1. |
| §14 row 6 | Phase 6 does **not** perform the first production deploy. Task 12 prepares `values-prod.yaml`, the workflow, the go-live checklist and the exact commands, and stops. | Promotion needs a protected-branch push, `DEPLOY_ENABLED=true` and five AWS secrets, none of which the executor has or should have. It is the account owner's decision, not a phase's deliverable. |
| §14 row 6 exit | *"All §12 items verified on prod"* becomes: verified on a local stack and against the kind cluster, with six items marked **when promoted** and named in the evidence map. | Six of them cannot be observed before a production cluster exists. Marking them green would be the one way the exit check can lie. |
| §14 row 6 exit, §13 | *"smoke passes against prod"* becomes: the smoke runs against `pnpm dev` locally and against the kind cluster in CI, and is **never** pointed at production. It writes real bills. | The chart CI installs is the chart production runs; a smoke against the hospital's ledger would sell stock nobody ordered. |
| §7.2 `document_history` | A purchase-order **line** edit writes no history row. Recorded as accepted, with the trigger: the first dispute about who changed a rate. | Phase 5's Task 6 review named it a "Phase 6 audit". Phase 6 surfaces history rather than widening what writes it; a row per line patch is a change to Phase 5's module, not a docs change. |
| §9.2 `updateContract` vs `updateVendor` | A rate-contract PATCH with an empty body is a no-op; a vendor PATCH refuses one. Recorded as accepted asymmetry. | Phase 5's Task 8 review flagged it for "the UI / Phase 6". No screen sends an empty patch, and unifying it would change a sentence two suites pin. |
| §13 testing | `packages/domain/vitest.config.ts` and `packages/contract/vitest.config.ts` now pin `TZ=UTC`, matching `apps/api` and `UI`. | Phase 5's Task 2 left the two unpinned because "the tests are TZ-independent". The pin costs one line and removes the class of failure rather than the instance of it. |
| §7.3 GRN | `GRN-<last 3 of PO>-<nn>` becomes `GRN-<yy><po number>-<nn>` (`PO-2026-0143` → `GRN-260143-01`), built by `grnId(poId, n)` in `packages/domain/src/ids.ts` rather than inline in the service. | The three-character tail collides: `PO-2026-0143` and `PO-2027-0143` share it, and so do `PO-2026-0143` and `PO-2026-1143`. `grns.id` is a primary key, so a collision is a failed insert in the middle of a goods receipt — a 500 at the receiving door, not merely a wrong number. |
| §13 testing | `apps/api/src/db/seed.ts` exports `seedDocuments(tx)` and `apps/api/src/test/db.ts` adds `resetDocuments(db)`: a per-case reset of the document and vendor tables that leaves master data, users and payers seeded once per file. | Six suites re-seed the whole hospital in `beforeEach` — master, items, recipes, menus, price lists, users, payers and every document — to get a clean document band. The master half is invariant and dominates the run. |

Add any decision a wave-2 or wave-3 task's report recorded that is not in this list.

- [ ] **Step 8: Commit**

```bash
git add CLAUDE.md apps/api/CLAUDE.md packages/contract/CLAUDE.md packages/domain/CLAUDE.md UI/CLAUDE.md \
        README.md UI/README.md e2e/README.md docs deploy/RUNBOOK.md
git status --short   # nothing under docs/ or CLAUDE.md left unstaged
git commit -m "$(cat <<'EOF'
Describe the system that exists, and write down how to run it

The user-acceptance spec has described a different product since before any of this was built —
nine roles where there are five, twelve stages where there are six, and nine of its twenty-four
scenarios testing features nobody wrote. It now describes this one, and every scenario names the
test that proves it, which is what the readiness bar asked for and what made the old table
impossible to satisfy.

The five guides say the backend is finished, because it is: every mutation is a server call, the
browser holds no copy of the hospital, and the only state left in it is a cart and a theme.

The runbook gains the three things a first deploy needs and did not have — a go-live checklist
that names who fills in each production value, a restore drill you can rehearse against Docker
before the day you need it against RDS, and the standing warning that the end-to-end smoke writes
real bills and must never be pointed at production. The seeded accounts must not exist there, and
now something says so.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: The exit check — §12 item by item, and everything the first deploy needs

*(Wave 5, alone and last. In-tree, after everything is merged. It changes no behaviour: it verifies, records, and prepares.)*

**Files:**
- Create: `docs/superpowers/plans/2026-09-04-backend-phase-6-ops-go-live-ledger.md` (the phase's execution ledger, copied from `.superpowers/sdd/…/progress.md` the way every phase has done)
- Modify: `deploy/RUNBOOK.md` (evidence lines only — the §12 table below), `docs/superpowers/specs/2026-09-03-backend-design.md` (§12's checklist gains a verified-on column)

**This task's deliverable is evidence, not code.** Anything it finds that is actually broken is a defect the controller schedules as a fix wave; this task records it, it does not quietly patch it. The one exception is a typo or a stale command in a doc, which it may fix inline.

- [ ] **Step 1: The gate, from a clean tree**

```bash
git status --short                      # empty
pnpm install
pnpm turbo typecheck test --force       # every package
pnpm lint                               # oxlint per package + knip + check-boundaries
pnpm helm:test                          # the chart renders, prod and staging
bash scripts/build-site.sh              # index + docs + app assemble
actionlint .github/workflows/*.yml
```
Record each result. `pnpm turbo typecheck test` must be run with `--force` — a replayed cache is not evidence.

- [ ] **Step 2: The full walk, against a real stack**

```bash
pnpm db:up
pnpm --filter @rch/api db:migrate
pnpm --filter @rch/api db:seed --force
pnpm dev                                # api :3000, UI :5173
```
Then, in a second shell, the phase's own chain — the support desk end to end:
```bash
API=http://localhost:3000/api/v1
login() { curl -sS -X POST $API/auth/login -H 'content-type: application/json' -d "{\"emp\":\"$1\",\"password\":\"changeme\"}" | jq -r .accessToken; }
CTR=$(login RC-4471); BUY=$(login RC-1550); STORE=$(login RC-2088)   # counter (coffee), buyer, store keeper
K() { python3 -c 'import uuid;print(uuid.uuid4())'; }
C() { curl -sS -X POST "$API$1" -H "Authorization: Bearer $CTR" -H 'content-type: application/json' -H "Idempotency-Key: $(K)" ${2:+-d "$2"}; }

# 1. A ticket is raised, and belongs to whoever raised it.
SUP=$(C /support/tickets '{"topic":"A number looks wrong","subject":"Cash reads zero","body":"Since 09:00.","priority":"Urgent","screen":"Dashboard"}' | jq -r .result.id)
echo "$SUP"                                                       # SUP-0044
curl -sS -H "Authorization: Bearer $CTR" $API/support/tickets | jq -r "[.[]|select(.id==\"$SUP\")]|length"    # 1
curl -sS -H "Authorization: Bearer $BUY" $API/support/tickets | jq -r "[.[]|select(.id==\"$SUP\")]|length"    # 0
#    and it is not theirs to reply to either
curl -sS -X POST "$API/support/tickets/$SUP/messages" -H "Authorization: Bearer $BUY" -H 'content-type: application/json' -H "Idempotency-Key: $(K)" -d '{"body":"nosy"}' | jq -r .error.message
#    expect "There is no support ticket SUP-0044."

# 2. The four rules the browser never had.
C "/support/tickets/$SUP/status" '{"st":"Waiting on you"}' | jq -r .error.message
#    expect "Only support moves a ticket to waiting on you — you can mark it resolved or close it"
C "/support/tickets/$SUP/rating" '{"rating":5}' | jq -r .error.message
#    expect "SUP-0044 is not finished yet — rate it once support has resolved it"
C "/support/tickets/$SUP/messages" '{"body":"Still happening."}' | jq -r '.message, .result.st'
C "/support/tickets/$SUP/status" '{"st":"Resolved"}' | jq -r .message
C "/support/tickets/$SUP/rating" '{"rating":5}' | jq -r .message
C "/support/tickets/$SUP/status" '{"st":"Closed"}'   | jq -r .message
C "/support/tickets/$SUP/messages" '{"body":"Hello?"}' | jq -r .error.message
#    expect "SUP-0044 is closed — raise a new ticket if it has come back"

# 3. The OTP belongs to the collector.
REQ=$(C /requests '{"lines":[{"it":"milk","qty":4}],"note":"","urgent":false}' | jq -r .result.id)
MGR=$(login RC-3120)                                                  # outlet manager
curl -sS -X POST "$API/requests/$REQ/approve" -H "Authorization: Bearer $MGR" -H 'content-type: application/json' -H "Idempotency-Key: $(K)" -d '{"appr":[4],"note":""}' >/dev/null
TKT=$(curl -sS -X POST "$API/requests/$REQ/issue-ticket" -H "Authorization: Bearer $STORE" -H "Idempotency-Key: $(K)" | jq -r .result.ticket.id)
curl -sS -H "Authorization: Bearer $STORE" $API/tickets | jq -r "[.[]|select(.id==\"$TKT\")][0].otp"   # "" — the sender
OTP=$(curl -sS -H "Authorization: Bearer $CTR" $API/tickets | jq -r "[.[]|select(.id==\"$TKT\")][0].otp")
echo "$OTP" | grep -Eq '^[0-9]{6}$' && echo "the collector has it"
curl -sS -H "Authorization: Bearer $CTR" $API/tickets | jq -r "[.[]|select(.id==\"$TKT\")][0].hist|map(.s)|join(\" > \")"
#    expect "Issued"

# 4. The counter's cancel door, and the ask that comes back.
ASK=$(C /shop-asks '{"to":"kiosk","it":"juice","qty":5,"note":"ran out"}' | jq -r .result.id)
KIO=$(login RC-4482)                                                  # the second counter operator, at the kiosk
G=$(curl -sS -X POST "$API/shop-asks/$ASK/answer" -H "Authorization: Bearer $KIO" -H 'content-type: application/json' -H "Idempotency-Key: $(K)" -d '{"grant":4}' | jq -r .result.ticket)
curl -sS -X POST "$API/tickets/$G/cancel" -H "Authorization: Bearer $KIO" -H 'content-type: application/json' -H "Idempotency-Key: $(K)" -d '{"reason":"Sold out before they came"}' | jq -r '.message, (.changed|join(","))'
curl -sS -H "Authorization: Bearer $CTR" $API/shop-asks | jq -r "[.[]|select(.id==\"$ASK\")][0].st"      # Asked

# 5. The two reports.
curl -sS -H "Authorization: Bearer $STORE" "$API/reports/stock-ledger?loc=store&days=30" | jq -r '.rows[:3][] | "\(.it) \(.opening) + \(.recd) - \(.issued) = \(.closing)"'
curl -sS -H "Authorization: Bearer $STORE" "$API/reports/stock-ledger?loc=quarantine&days=30" | jq -r '.rows|length'
curl -sS -H "Authorization: Bearer $CTR" "$API/reports/credit/staff/RC-1902" | jq -r '"\(.name) \(.taken) of \(.limit), room \(.room), since \(.since)"'
#    and the report agrees with the refusal: sell past the ceiling and compare
C /bills '{"loc":"coffee","tender":"Staff credit","payer":{"kind":"staff","id":"RC-1902","name":"Vinoth Prakash · Kitchen"},"lines":[{"it":"water","qty":200}]}' | jq -r '.error.message, .error.details.taken'

# 6. The roster is the payers table.
curl -sS -H "Authorization: Bearer $CTR" $API/snapshot | jq -r '.roster | "\(.patients|length) patients, \(.staff|length) staff, \(.depts|length) departments"'

# 7. The cache is exactly the sum of the moves.
curl -sS -H "Authorization: Bearer $STORE" $API/stock > /tmp/rch-before.json
pnpm --filter @rch/api db:rebuild-balances
curl -sS -H "Authorization: Bearer $STORE" $API/stock > /tmp/rch-after.json
diff /tmp/rch-before.json /tmp/rch-after.json && echo "balances reconcile"
```

`RC-4482` is Deepa Selvam, the second counter operator, at the kiosk; `RC-3120` is Ramesh Kumar, the outlet manager; `RC-1902` is Vinoth Prakash in the kitchen (`packages/contract/src/fixtures/master.ts:58-66`). The two that are easy to swap are the manager and the kitchen. Confirm every number against `pnpm --filter @rch/api db:seed`'s output or `deploy/RUNBOOK.md` §1 before running rather than trusting this plan.

- [ ] **Step 3: The smoke, twice**

```bash
pnpm --filter @rch/api db:seed --force
pnpm test:e2e                      # against pnpm dev, 8 passed
pnpm --filter @rch/api db:seed --force
pnpm test:e2e                      # again, still 8 passed
```
Then confirm CI's kind path by reading the last `images` job's log for the `playwright smoke against the cluster` block, or by running `E2E=1 deploy/chart/rch/ci/install-test.sh` against a local kind cluster if one is available. If neither is possible in this environment, record **that** — "verified locally against `pnpm dev`; the cluster path is proved by CI run \<url\>" — rather than claiming a run that did not happen.

- [ ] **Step 4: The load check, recorded**

```bash
pnpm --filter @rch/api db:seed --force
pnpm --filter @rch/api dev &
pnpm --filter @rch/api loadcheck -- --emp RC-4471 --password changeme --concurrency 10
pnpm --filter @rch/api loadcheck -- --emp RC-4471 --password changeme --concurrency 30
```
Record both, with `node -v`, `uname -sm`, and the fact that Postgres was in Docker on the same machine — which production's will not be. A `FAIL` is recorded as a finding with the p95 and the machine, and §12's line reads "measured at N ms p95 on \<machine\>; the target is stated for the staging instance and is re-measured there before go-live."

- [ ] **Step 5: SIGTERM, and the rest of Operability**

```bash
pnpm --filter @rch/api dev &
API_PID=$!
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/readyz         # 200
curl -N -H "Authorization: Bearer $(login RC-4471)" http://localhost:3000/api/v1/events &   # hold a stream open
sleep 2
kill -TERM $API_PID
# Expected, in order: a "draining" log line, /readyz turning 503, the open stream closing with a
# `retry:` frame, the pool closing, and the process exiting 0 well inside 25 seconds.
time wait $API_PID
```
Record the elapsed time and paste the drain log lines. Then:
```bash
# Config validated at boot, exits non-zero with a clear message
env -u JWT_PRIVATE_KEY pnpm --filter @rch/api dev; echo "exit=$?"      # 2, with a sentence
# Security headers, CORS and the rate limit. RATE_LIMIT_PER_MINUTE defaults to 300 and is keyed
# per user, so this needs a real token — reuse the counter's from step 2 or mint a fresh one.
TOKEN=$(login RC-4471)
curl -sSI http://localhost:3000/healthz | grep -Ei 'x-frame-options|strict-transport|x-content-type|x-request-id'
for i in $(seq 1 320); do curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" $API/snapshot; done | sort | uniq -c   # some 429s
# No stack traces or SQL in a 500, and an id that matches a log line
curl -sS -D /tmp/rch-500.h -H "Authorization: Bearer $TOKEN" "$API/reports/credit/staff/%00" | jq .
grep -i x-request-id /tmp/rch-500.h                                   # then find that id in the API's log output
```

- [ ] **Step 6: The restore drill, rehearsed**

Run the Docker rehearsal Task 11 added to the runbook, end to end, and record the diff result and the date. This is §12's "Backups are verified by a documented restore drill … Performed before go-live" — the RDS half cannot be run without an RDS, and the runbook says so; what this proves is that the procedure is correct and that `rebuild-balances` reproduces the balances on a restored copy.

- [ ] **Step 7: Walk §12, line by line, and write the evidence into the spec**

First, run the UA table Task 11 wrote as a checklist. For each of its 24 rows, the named file must exist and the named case must appear in the last green run's reporter output:

```bash
pnpm turbo test --force 2>&1 | tee /tmp/rch-tests.txt
# then, per row:
grep -F "<the case name the UA row names>" /tmp/rch-tests.txt
```

**A row naming a test that does not exist is a finding, not a pass** — that is precisely the failure mode the old twenty-four-row table had, and naming files instead of running them would reproduce it one generation on. Record the count of rows verified this way, and list any that could not be.

Then take **"The §12 evidence map"** at the end of this plan, run down it, and for each line write what you actually observed — a test name and a result, a command and its output, a file and a line, or "when promoted" for the six items that can only be true on production. Put the completed table into spec §12 as a new sub-section, `#### Verified — Phase 6 (2026-09-04)`, immediately after the checklist. **A line you could not verify says so and names what would verify it.** An unverifiable line marked green is the only way this task can fail.

- [ ] **Step 8: Prepare the deploy, and stop**

Write the release note into the runbook's go-live section and confirm, without doing any of it:
```bash
# Nothing here is run by this task. It is the list the user works through.
git log --oneline develop..feat/phase-6-ops-go-live | wc -l      # what is about to move
git merge-base --is-ancestor origin/staging origin/develop && echo "staging is an ancestor of develop"
# 1. Fill the five FILL markers in deploy/chart/rch/values-prod.yaml.
# 2. pnpm --filter @rch/api keys:generate  -> AWS Secrets Manager, secret rch/prod
# 3. Repository secrets: AWS_ROLE_ARN, AWS_REGION, ECR_REGISTRY, EKS_CLUSTER_STAGING, EKS_CLUSTER_PROD
#    (staging additionally: DATABASE_URL, JWT_PRIVATE_KEY, JWT_PUBLIC_KEY)
# 4. Repository variable DEPLOY_ENABLED=true
# 5. git checkout develop && git merge --ff-only feat/phase-6-ops-go-live && git push
# 6. git checkout staging    && git merge --ff-only develop && git push     -> deploys rch-staging
# 7. Watch: kubectl -n rch-staging rollout status deploy/rch-api; curl .../readyz; sign in.
# 8. Run the load check against staging and record it against §12's targets.
# 9. Create the real staff accounts; deactivate the six seeded ones.
# 10. git checkout production && git merge --ff-only staging && git push    -> waits for approval
```
**Then stop.** Promotion is the user's decision and the controller does not push `staging` or `production`. Say so, in the report and in the ledger, in those words.

- [ ] **Step 9: Copy the ledger and commit**

```bash
cp .superpowers/sdd/2026-09-04-backend-phase-6-ops-go-live/progress.md \
   docs/superpowers/plans/2026-09-04-backend-phase-6-ops-go-live-ledger.md
git add docs deploy/RUNBOOK.md
git commit -m "$(cat <<'EOF'
Verify the readiness bar line by line and prepare the first deploy

Every item in §12 now carries what was observed rather than what was intended: a test name and a
result, a command and its output, or the words "when promoted" for the six that can only be true
on production. Two lines are findings rather than passes and say what they are and what would
close them.

The p95 numbers are recorded with the machine that produced them, because a latency without a
machine is not a measurement. The restore drill was rehearsed against Docker end to end, so the
day it matters against RDS is not the first time anyone has read the procedure.

Everything the first production deploy needs is written down and nothing is pushed. The five
values only the account owner can fill are marked, the secrets are listed, and the promotion is a
sequence of commands somebody else runs when they decide to.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## The §12 evidence map

Every line of spec §12, the task that satisfies it, and what counts as evidence. Task 12 fills the last column and copies the result into the spec. A line whose evidence column says **when promoted** cannot be observed before there is a production cluster; it is listed so that nobody mistakes its absence for an oversight.

### Correctness

| §12 item | Task | Evidence |
|---|---|---|
| Every write is a single transaction with row locks; a failing rule leaves no partial state | 5, 4 | `support.test.ts`'s "refuses one with no subject … and writes nothing"; every Phase 2–5 suite's equivalent, re-run in the gate |
| `db:rebuild-balances` reproduces `stock_balances` from `stock_moves` | 12, 6 | The exit walk's step 7 diff; and `reports.test.ts`'s ledger closing column equalling `stock_balances` |
| Every §9.2 rule has an integration test for refusal and acceptance | 5, 4, 6 | The four support rows above; the Phase 2–5 suites for the rest |
| Every unlisted status transition is tested to be refused | 2, 5 | `transitions.test.ts`'s "names every status exactly once"; `support.test.ts`'s "refuses a move the table does not have" |
| The 24 UAT scenarios are encoded as integration tests | 11, 8 | `docs/ua-spec.html`'s rewritten §08 — every row names the file that proves it |
| Idempotency: a replayed key returns the identical response and writes nothing | 5 | `support.test.ts`'s "replays a repeated key without raising a second ticket" |
| `db:rebuild-balances` reproduces balances **after every integration test suite** | 12 (13's reset must not break it) | Exit step 1's `pnpm turbo typecheck test --force`, then `db:rebuild-balances` against the surviving test schemas, diffed — and if the schemas are dropped on `close()`, the claim is **narrowed to the seed and the narrowing recorded**, not quietly left as "verified" |
| Every unlisted `ReqStatus` / `TktStatus` / `PoStatus` transition is refused | Phases 3–5, re-run in the gate | `requests.test.ts`, `tickets.test.ts`, `purchaseorders.test.ts`'s transition cases. §12 names those three unions; `SUPPORT_TRANSITIONS` (Task 2) is a fourth table, not a substitute for them |

### Security

| §12 item | Task | Evidence |
|---|---|---|
| Argon2id; EdDSA; refresh rotation with family revocation; cookie flags | — (Phase 1) | `auth.test.ts`, re-run in the gate; `values-prod.yaml`'s `COOKIE_SECURE: "true"` |
| Every route has a Zod schema; unknown keys rejected | 1 | `routes.test.ts`'s existing per-body loop (`routes.test.ts:52-62`), which already covers the whole manifest and which the four new `SAMPLES` entries extend to the support desk |
| RBAC and location scoping tested per role per module | 3, 4, 5, 6 | `support.test.ts`'s "open to every role" and "somebody else's ticket is a 404"; `reports.test.ts`'s "not a counter operator's report"; `tickets.test.ts`'s three cancel-door cases |
| Helmet, CORS allowlist, rate limits, 1 MiB body limit | 12 | Exit step 5's header dump and the 320-request burst |
| No stack traces or SQL in responses; `internal` returns an id matching a log line | 12 | Exit step 5's forced 500 and the matching `x-request-id` in the log |
| Non-root, read-only root FS; images scanned; `pnpm audit` gates CI | 7 | `render.test.sh`'s four `readOnlyRootFilesystem` assertions; `ci.yml`'s Trivy and audit steps |

### Operability

| §12 item | Task | Evidence |
|---|---|---|
| `/healthz`, `/readyz`; readiness fails before traffic and during shutdown | 12 | Exit step 5: 200, then 503 on SIGTERM |
| SIGTERM: stop accepting, finish in flight, close SSE with a `retry` hint, close the pool, exit within 25 s | 12 | Exit step 5's timed drain and the held-open stream's closing frame |
| Config validated at boot; a missing variable exits non-zero with a clear message | 12 | Exit step 5's `env -u JWT_PRIVATE_KEY` run, `exit=2` |
| Structured logs with request id, user id, route, status, duration | 12 | One `request` log line from the walk, pasted whole |
| `/metrics`: request count/duration, pool stats, SSE clients, sequence allocations | 12 | `curl localhost:3000/metrics \| grep -E 'http_request_duration_seconds\|pg_pool_\|sse_\|sequence_allocations'` |
| Migrations forward-only, applied by the pre-upgrade job; the app refuses to serve if behind | 7, 12 | `render.test.sh`'s `dist/cli/migrate.mjs` initContainer assertions; `/readyz` comparing the applied count to the journal |
| Alerts documented in the runbook | 7, 11 | `templates/prometheusrule.yaml` renders five named alerts; RUNBOOK §9 revised |
| Runbook covers deploy, roll back, rotate keys, reset a password, restore drill, rebuild balances, read a history | 11, 12 | RUNBOOK §§2–13; the restore drill rehearsed in exit step 6 |

### Performance

| §12 item | Task | Evidence |
|---|---|---|
| `/snapshot` under 150 ms p95; writes under 200 ms p95 | 9, 12 | `loadcheck.mjs` at two concurrencies, with the machine recorded. Stated for the staging instance, so **re-measured when promoted** |
| Indexes exist; `EXPLAIN` shows no sequential scan on `stock_moves` | 6, 12 | Task 6 step 6's query plan, pasted |

### Only true on production

| §12 item | Evidence |
|---|---|
| RDS Multi-AZ, PITR, 14-day backups, encryption, deletion protection, `rds.force_ssl` | **when promoted** — `values-prod.yaml` sets `DATABASE_SSL: "true"` and the runbook §11 lists the instance settings |
| Automated backups verified by a restore drill against the real snapshot | **when promoted** — rehearsed against Docker in exit step 6; the RDS procedure is RUNBOOK §6 |
| Prometheus scrapes `/metrics` and the five alerts fire | **when promoted** — the `ServiceMonitor` and `PrometheusRule` render under `values-prod.yaml` |
| ALB terminates TLS with the ACM certificate; idle timeout 3600 s | **when promoted** — the annotations render; `certificateArn` is one of the five `FILL` markers |
| The seeded accounts do not exist; real staff are created with the CLI | **when promoted** — RUNBOOK §11 step 9 |
| Smoke passes against the deployed stack | **when promoted** — proved against the kind cluster in CI, which installs the same chart |

---

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | **1** (contract: four support writes, the support read, `hist`, `roster`, three constants, the widened cancel) ∥ **2** (domain: the support table and three predicates, the ledger row, one shop-ask edge) ∥ **3** (api: two module skeletons, `given.supportTicket`, `GET /support/tickets`) | Worktrees, all three from the phase branch head. Disjoint by package: Task 1 owns `packages/contract/**`, Task 2 owns `packages/domain/**`, Task 3 owns `apps/api/**`. No `UI/` file is touched by any of them. **Task 1 makes `TicketSchema.hist` required, which turns `@rch/api` and `@rch/ui` red until Task 3 (this wave) and Task 10 (wave 3) fill it** — that is deliberate and is how the compiler produces the file list instead of a human guessing at one. Merge Task 1 first and rebase 2 and 3 onto it before their final gate, or dispatch Task 1 alone and 2 and 3 after it; the wave is small enough that either is cheap. Task 1 declares **`GET /support/tickets` and no other read** — a manifest GET without a handler fails `apps/api/src/contract.test.ts`, and Task 3 mounts that one in this same wave. Journal must read `0006_rate_contracts_live_uq` before dispatch, and after. |
| 2 | **4** (tickets + snapshot) ∥ **5** (`support`'s four writes) ∥ **6** (`reports` + the credit query's move to `lib/`) ∥ **7** (chart, alerts, prod values, `deploy.yml`) ∥ **8** (`e2e/` + `ci.yml` + `install-test.sh`) ∥ **9** (the load script) ∥ **13** (hygiene: the GRN id, the partial reseed, two TZ pins) | Worktrees, all seven from the merge of wave 1. Disjoint, and the carve-outs are named rather than assumed: **Task 8 owns `deploy/chart/rch/ci/install-test.sh` and `.github/workflows/ci.yml`; Task 7 owns everything else under `deploy/**` and `.github/workflows/deploy.yml`.** Task 6 is the only wave-2 task inside `packages/contract/src`, which Task 1 finished with in wave 1, and the only one inside `modules/pos/**`; **Task 13 owns `packages/contract/vitest.config.ts` and `packages/domain/**`, both at the package root or in a package wave 2's other tasks do not open** — Task 2 finished with `packages/domain` in wave 1. Task 13 also owns `apps/api/src/test/db.ts` (Task 3 owned `test/builders.ts`, a different file, in wave 1), `apps/api/src/db/seed.ts`, `modules/grn/**` and `purchaseorders.test.ts`, none of which any other task opens. **Task 8 is the only task in the phase that touches `pnpm-lock.yaml`** — that is why the load check has no dependency. Nothing in wave 2 needs anything from another wave-2 task, and it is enforced rather than hoped for: **Task 5 reads its tickets through `GET /support/tickets` or through `given.supportTicket`, never through `GET /snapshot`**, which Task 4 is rewriting in the same wave; and **Task 4 never calls a `/reports/*` or a support write.** Tasks 7, 8 and 9 touch no file under `apps/api/src` except Task 9's new script and one `package.json` line. |
| 3 | **10** (UI cutover) | In-tree or one worktree; it is alone. It needs every wave-2 task merged — the four support routes it calls, the two report routes it reads, `roster` in the snapshot and `hist` on the ticket — and it is one coherent change: two store slices, two appliers, the roster's registries, eleven screens, the seed deletion and nine test files. Splitting the store from the screens would fail typecheck in whichever half went first, which is the same reason Phases 4 and 5 refused that split. **This is the first task in the phase whose gate is green everywhere.** |
| 4 | **11** (the UA spec, the guides, both READMEs, the runbook, spec §16) | In-tree, after everything is merged. The only task that edits `docs/`, `README.md`, `UI/README.md`, the five `CLAUDE.md` guides and `deploy/RUNBOOK.md` — all in one commit. Its precondition is Phase 5's own docs commit being on the branch. |
| 5 | **12** (the §12 walk, the exit check, the release preparation) | In-tree, last. It changes no behaviour. It runs the gate, walks the chain by hand, runs the smoke twice and the load check at two concurrencies, rehearses the restore drill, fills in the evidence map, writes it into the spec, and prepares the deploy **without performing it**. Anything it finds broken is recorded and scheduled as a fix wave, not quietly patched. |

Worktree agents do not commit to the shared branch; the controller reviews and merges each branch, then dispatches the next wave from the merge commit. **Parallel tasks never edit the same file.** Where a file is needed by more than one task it is written by the earlier wave: `packages/contract/src/routes.ts` by Task 1 in wave 1 and Task 6 in wave 2, never by two at once; `apps/api/src/modules/index.ts` and `apps/api/src/test/builders.ts` by Task 3 in wave 1 and by nobody afterwards; `apps/api/src/modules/support/{routes,service,repo}.ts` by Task 3 in wave 1 and Task 5 in wave 2; `apps/api/src/modules/snapshot/readers/documents.ts` by Task 3 in wave 1 (one added `hist: []` property) and Task 4 in wave 2 (the real read, which deletes it); `packages/domain/src/index.ts` by Task 2 in wave 1 and Task 13 in wave 2 (one added named re-export each); `deploy/chart/rch/ci/install-test.sh` by Task 8 alone. `UI/src/**` is untouched by every task except 10.

**Two facts every wave-2 agent is given at dispatch, because getting either wrong costs a review cycle.** First: `buildTestApp` migrates but does **not** seed — every DB-backed suite needs `beforeEach(truncateAll → seedTestDb)` or `authHeaders` throws `no user u1 - did you seed?`. Second: a race test warms the pool with `warmPool(app.testDb!, n)`, not `warmPool(t, n)`, and must be shown to fail with its lock commented out before it is kept.

**One thing every wave-2 and wave-3 agent is told at dispatch:** the phase's journal entry is `0006_rate_contracts_live_uq` and **Phase 6 writes no migration**. If a task believes it needs one, it stops and reports rather than running `db:generate`.
