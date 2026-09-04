# SDD ledger — plan: docs/superpowers/plans/2026-09-04-backend-phase-2-ledger-pos.md

Spec: docs/superpowers/specs/2026-09-03-backend-design.md (+§16). Phase 1 ledger: docs/superpowers/plans/2026-09-03-backend-phase-1-foundation-ledger.md.
Branch: feat/phase-2-ledger-pos from develop (e45626a). Same operating rulings as Phase 1: parallel waves in Agent worktrees (each starts with git merge --ff-only feat/phase-2-ledger-pos); controller merges after review; sequential tasks in-tree; .superpowers/ is git-ignored.

## Pre-flight scan
| Pair / task | Finding | Ruling |
|---|---|---|
| T1 ∥ T2 (wave 1) | T1 edits packages/domain + UI/src/lib/selectors.ts (+ domain package.json dep on contract); T2 edits packages/contract only | disjoint — parallel OK |
| T3 after T1+T2 | needs Master type (T1) and route entries (T2); edits snapshot module, wire.ts, contract snapshot/documents schemas (UserMin), UI/src/data/master.ts + fixture.ts | sequential in-tree |
| T4 ∥ T5 ∥ T6 (wave 3) | each owns its module dir; modules/index.ts registration pre-done by T3 stubs; T4 also edits lib/wire.ts (toWireBill) and snapshot readers/documents.ts (reuse) — T9 item 11 also edits readers/documents.ts (names param) | CONFLICT T4↔T9 on readers/documents.ts. Ruling: T4 does NOT touch readers/documents.ts — it adds toWireBill to lib/wire.ts and leaves readBills as is; T9 item 11 owns readers/documents.ts. |
| T8 ∥ wave 3 | ci.yml, deploy/chart/rch/ci/*, RUNBOOK paragraph, spec §16 row | T9 item 12 edits ci.yml/deploy.yml (platforms) → CONFLICT with T8 on ci.yml. Ruling: T9 item 12 moves to T8 (T8 sets platforms: linux/amd64 in ci.yml and deploy.yml). T10 edits RUNBOOK/spec after (sequential). |
| T9 item 8 (menu partialRecord) | contract snapshot schema; T3 edits the same file for UserMin | T3 before T9 — sequential; fine |
| T7 after wave 3 | UI store/tests | in-tree |
| T9 item 13 (family lifetime) vs T4/T5/T6 | auth module only | disjoint |

## Progress
Wave 1 dispatched from bf2c172 (worktrees): Task 1 domain rules (sonnet), Task 2 contract writes (sonnet).
Task 2: implemented (f16f99c). Review dispatched.
Task 2: minor (deferred): PayerSchema (documents.ts) is z.object not strict — nested payer keys stripped; tighten in Task 9 or Phase 3.
Task 2: complete (commits bf2c172..f16f99c, review clean) — merged, worktree removed.
Task 1: implemented (9fbee80). planBill tot/tax left unrounded (test parity with UI); Task 4 rounds before persisting. Review dispatched.
Task 1: minor (deferred): optional-chaining on m.items lookups is defensive vs the UI's non-optional access (no behavioural change).
Task 1: complete (commits bf2c172..9fbee80, review clean) — merged, worktree removed. Wave 1 complete.
Task 3: dispatched (in-tree, opus, base = merge commit)
Task 3: implemented (22a98ae; api 120, ui 307, contract 13, domain 20; migrate 3/3). Deviations: pool gauges register for whichever pool the db plugin has (incl. injected test pools); ledger key separator " " with (loc,item) carried alongside. Review dispatched.
Wave 3 dispatched from 22a98ae (worktrees, ff first): T4 pos (opus), T5 availability (sonnet), T6 catalog (sonnet), T8 kind CI + platforms (sonnet), T9 hygiene minus item 12 (sonnet). Ruling recap: T4 does not touch readers/documents.ts; T9 owns it.
Task 3: complete (commits 187317f..22a98ae, review clean, no issues) — in-tree.
Task 5: implemented (7e22100). Review dispatched.
Task 8: implemented (7a1486a). kind install validated by render/parse/syntax only (kind not local). Review dispatched.
Task 6: implemented (03119f2). Note: transient auth.test flake reported once under parallel load (green on retry) — watch. Review dispatched.
Task 8: review — Needs fixes: (C) login probe path lacks /api/v1; (I) ERR trap bypassed by explicit exit 1 in || blocks. Fix round 1 dispatched (resume). Minor deferred: none beyond folded cat of port-forward logs.
Task 6: review — Approved (minor: stale 'Nothing imports this yet' comment in lib/rules.ts → Task 10 sweep). Merged --no-ff as e19029a; worktree removed.
Task 6: complete
Task 5: review — Needs fixes: (I) unknown/deactivated item key → TypeError 500 before assertRule; (I) concurrent first-toggle insert races on PK → raw 500. Fix round 1 dispatched (resume a31186a3a44d0b0bb). Ruling: unknown item → 404 'There is no item <it>.' to match Task 6's catalog module — consistency across modules — cost if wrong: one sentence to change.
Task 8: fix round 1 — cf03909 (worktree-agent-aa6350e8b7e692b9a); scoped re-review dispatched.
Task 4: implementer DONE — 41e1761 (worktree-agent-a9f0da8f404fcacc2). Concerns carried: readBills keeps its own mapping (T4 barred from readers/documents.ts) → integration edit after T9 merges: readBills reuses toWireBill; auth.test.ts flakes ~1-in-3 under parallel load (pre-existing) → Task 10 must fix or isolate; loadMaster Promise.all on one tx client trips pg deprecation warning → sequential awaits, in-tree after merges. Review dispatched (opus — ledger write path with concurrency).
Task 8: re-review — Approved (both findings addressed, no regressions). Merged --no-ff as c3e3b75; worktree removed. Note: kind run not executed locally (kind absent) — CI is the proving ground; Task 10 exit check records the CI result.
Task 8: complete
Ruling: loadMaster/loadRecipes read sequentially (in-tree f306cf1) — Promise.all on one tx client trips pg's one-query-at-a-time deprecation (Task 4 concern 4) — cost if wrong: two extra round trips per write.
Task 5: fix round 1 — 194fe7f; scoped re-review dispatched.
Task 5: re-review — Approved (both findings addressed; pg 'client already executing' warning in the concurrency test is the loadMaster Promise.all fixed in-tree at f306cf1 — verify silent at the gate). Merged --no-ff as c96d265; worktree removed.
Task 5: complete
Task 4: review — Approved (8 minors). Merged --no-ff as e7f764a; worktree removed.
  Integration sweep (in-tree, after Task 9 merges — it owns readers/documents.ts): pos unknown item → 404 'There is no item X.' (consistency with Tasks 5/6); readBills reuses toWireBill (kills the duplicate mapping, moots the equivalence test); export fq from @rch/domain and drop the pos copy; fix stale comments in modules/index.ts and lib/rules.ts; drop lib/rules.ts from knip ignoreFiles; comment at the post-lock check explaining the two refusal voices.
  Parked: sequence_allocations_total counts allocations that later roll back (metric = attempts, not committed ids) — Ruling: document as 'attempted' in metrics-db.ts during the sweep; a committed-only counter needs an after-commit hook withTransaction does not have — cost if wrong: an over-counting gauge nobody alerts on.
  Parked: pre-check evaluates cart lines independently so a cart sharing an ingredient can pass the pre-check and be caught post-lock with the ingredient-voiced sentence — correctness holds; message quality only.
Task 4: complete
Task 9: implementer DONE — 243a6da (worktree-agent-a04d82aca6dd2543f); also folded Task 2's deferred PayerSchema strictObject. Review dispatched (opus — touches auth refresh lifetimes). Note: parallel worktrees collide on fixed test schema names (shared DB) → integration sweep makes withTestSchema names process-unique.
Integration sweep (part 1, in-tree 3b3b394): pos 404 for unknown item; fq exported from domain; test schemas pid-suffixed + dropped on close (31 stale t_* schemas purged from rch_test); stale comments fixed; knip ignoreFiles trimmed. Gate: api 157, domain 20, lint OK. Part 2 (readBills reuses toWireBill) waits for Task 9's merge.
Task 7: dispatched (opus, worktree — Ruling: worktree instead of in-tree so it overlaps Task 9's review/merge; T9's UI footprint is fmt.ts + api.test.ts only, disjoint from T7's files — cost if wrong: a small merge conflict). BASE 3b3b394.
Task 9: review — Approved (7 minors). Merged --no-ff as e10dda3 (rules.ts header conflict → kept the in-tree wording). Minors folded into integration sweep part 2 (in-tree): cookie expires follows the capped expiresAt; dead-family refresh → 401 (pre-deploy rows) + test; per-collection userNames assertions; TZ=UTC pinned in both vitest configs; ledger test name honest about pool max 4; --loc validated in cli/users; full stop on the change-password sentence; readBills reuses toWireBill.
Task 9: complete
Integration sweep part 2 (in-tree eda27ed, amended — a perl edit first hit bestBefore instead of fromWireBestBefore; restored from git and verified): Task 9 minors folded; TZ pin exposed a real bug — fromWireBestBefore rendered HH:MM in the host zone (fixed via fromWireTime). Gate: api 178, ui 308, typecheck 4/4, lint OK.
Task 7: implementer DONE_WITH_CONCERNS — c8a2c4d (worktree-agent-a3ce113dedf7e6e11). Ruling: refetch reports its own read-back failure instead of falling into the action's catch — the brief's literal snippet would toast "Could not take the bill" after a bill was taken — cost if wrong: one toast wording. Carried to review: Pos.tsx still shows a locally guessed draft bill number that no longer advances. Review dispatched (opus).
Task 7: review — Needs fixes: (I1) prod/Availability.tsx toggles kitchen → 404 (route access counter/manager only); (I2) POS draft bill number frozen at seq.bill+1; (I3) Pay button double-fires into two bills now that pay is async; (m4) refetch failure toast erases the bill number; (m5) BILL_DAYS=7 coupled across packages by coincidence.
  Ruling I1: keep the kitchen switch (an existing control; removing it is a product change) — extend the rule once, server-side: `prod` joins toggleAvail's access, scoped to its own location (`requireLoc … "your own kitchen"`), and at a Kitchen "listed" means "has a recipe" — spec §16 row — cost if wrong: one access entry to revert and a column to hide.
  Ruling I2: no guessed number — the card reads "New bill"; the number arrives in the server's toast and on the Bills screen; `bill` leaves `Seq`.
  Fix round 1 dispatched (resume a3ce113dedf7e6e11).
Task 7: fix round 1 — 1386aaa; scoped re-review dispatched. Note: busy guard is a re-render guard — React flushes discrete click events synchronously, so a double-tap is covered; same-tick programmatic double-dispatch is not reachable from the till. docs/*.html kitchen-switch wording → Task 10.
Task 7: re-review — Approved. Merged --no-ff as faa4205; worktree removed.
Task 7: complete
Gate after Task 7 merge (faa4205): contract 14, domain 20, ui 322, api 181; lint OK; chart renders. Task 9 worktree removed (had been left behind at merge). Task 10 dispatched (sonnet, in-tree). BASE faa4205.
Task 10: implementer DONE — fb1b05a (in-tree). Exit check: 1–6 PASS, 7 SKIPPED (kind absent locally; CI runs it), 8 done. Concern to verify in review: T7 said docs/*.html describe the kitchen switch as a local flip, T10 found nothing stale. Ruling: Task 10's task review (sonnet, docs-scoped) runs in parallel with the whole-branch review (opus); one fix dispatch covers both — cost if wrong: none, both are read-only.
Task 10: task review dispatched (sonnet, docs-scoped) ∥ whole-branch final review dispatched (opus; range e45626a..fb1b05a, 25 commits, 103 files). Phase 3 plan drafting in parallel (opus) → docs/superpowers/plans/2026-09-04-backend-phase-3-movement-chain.md (uncommitted until Phase 2 lands on develop).
Task 10: review — Needs fixes (I): db:rebuild-balances drops seed-written zero-only balance rows (no moves) → three screens' carries/stocked (M12) flip after a documented runbook procedure; the exit-check note in fb1b05a's message called it cosmetic. Ruling: fix rebuildBalances to keep every existing (loc,item) row — zero it, then upsert from moves — a balance row's presence means 'carried' and must survive a rebuild; correct the record in the fix commit's message rather than rewriting fb1b05a — cost if wrong: a rebuild leaves harmless zero rows. Held for the single post-final-review fix wave.
Final whole-branch review (opus) — With fixes. C1 tender free-form string bypasses payer rule; I2 bill_lines read unwindowed on every sale; I3 contract.test skips any 404; I4 `capped` computed and dropped; I5 staff-credit limit only in Pos.tsx; I6 catalog addMenuItem PK race → 500; I7 post-lock check ignores reservations (bites in Phase 3); minors (promise.ts no-op ternary; MTO-without-recipe TypeError in domain; availability location guard; ledger key separator; promise.test decoration; qty precision; RUNBOOK kind sentence; catalog Date twice; rbac 404 reflects URL; FX import in store; price .positive()); recs (global lock order ids→moves; withTransaction onCommit for SSE/metrics; narrow GETs with routes; retire worktree-era skips).
  Rulings: fix now — C1, I2, I3, I6, Task 10's rebuildBalances presence fix, and the cheap minors (ternary, recipe guards, location guard, separator, promise.test, qty multipleOf(0.001), RUNBOOK sentence, catalog Date, price .positive()), plus the lock-order rule in ledger.ts's header and §16.
  Ruling I4: `capped` is not surfaced on the wire — a list price can never exceed MRP (savePrice refuses), so capping only happens when MRP is lowered after pricing; the till applies it silently and the bill's `rate` shows it. Delete `BillPlan.capped`; add the pos test that prices juice at 25 in price_list_items and sells it at 20; §16 row — cost if wrong: one optional field to add later.
  Ruling I5 → Phase 3 (pos: staff-credit limit in packages/domain, enforced server-side against an unscoped query); §16 row now. Ruling I7 → Phase 3 first ledger task (post-lock re-read includes reservations under lock; rsv rows locked); §16 row now. rbac 404 wording and the FX import in the store stay (Phase 6 deletes test-only paths).
  ONE fix dispatch (opus, in-tree, BASE fb1b05a).
Final fix wave — 0e84d4b (30 files). Gate: contract 17, domain 22, ui 322, api 187 (×3 runs, no flakes); lint OK; chart renders. Scoped re-review dispatched (sonnet).
Final fix wave re-review — Approved (all findings addressed, no regressions; gate contract 17 / domain 22 / ui 322 / api 187; lint OK; chart renders). Phase 2 complete at 0e84d4b → ledger copied to docs, fast-forward into develop, workspace deleted.
