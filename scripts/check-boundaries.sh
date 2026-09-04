#!/usr/bin/env bash
#
# Enforces the reuse rules of docs/superpowers/specs/2026-09-03-backend-design.md §5.1
# that oxlint cannot see because they depend on call shape (which Drizzle table a
# statement writes to) or on directory contents (a module's file skeleton), not on
# import statements. Runs from the repo root; see package.json's "check:boundaries".
#
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

fail=0

fail_with() {
  echo "" >&2
  echo "boundary check failed: $1" >&2
  fail=1
}

# ---------------------------------------------------------------------------
# 1) Protected tables. stockMoves, stockBalances, sequences, documentHistory,
#    idempotencyKeys and reservations may be written only from apps/api/src/lib/**,
#    apps/api/src/db/**, apps/api/src/plugins/idempotency.ts, and test files (elsewhere
#    they may be imported for reads only — oxlint cannot see call shape, so this is a
#    grep). `reservations` joined the list with lib/reservations.ts: a reservation is a
#    promise against a balance, and a module that wrote one itself would skip the lock.
# ---------------------------------------------------------------------------
echo "== protected tables: writes stay behind lib/, db/, idempotency.ts =="

allowed_path_re='src/lib/|src/db/|plugins/idempotency\.ts|\.test\.ts'

orm_pattern='insert\(stockMoves\)|insert\(stockBalances\)|update\(stockBalances\)|delete\(stockBalances\)|insert\(sequences\)|update\(sequences\)|insert\(documentHistory\)|insert\(idempotencyKeys\)|update\(idempotencyKeys\)|insert\(reservations\)|update\(reservations\)|delete\(reservations\)'
orm_hits="$(grep -rn -E "$orm_pattern" apps/api/src --include="*.ts" | grep -v -E "$allowed_path_re" || true)"
if [ -n "$orm_hits" ]; then
  fail_with "a protected table is written (via Drizzle) outside apps/api/src/lib, apps/api/src/db, plugins/idempotency.ts, or a test file:"
  echo "$orm_hits" >&2
fi

raw_sql_pattern='insert +into +(stock_moves|stock_balances|sequences|document_history|idempotency_keys|reservations)|update +(stock_balances|sequences|idempotency_keys|reservations)|delete +from +(stock_balances|reservations)'
raw_sql_hits="$(grep -rn -i -E "$raw_sql_pattern" apps/api/src --include="*.ts" | grep -v -E "$allowed_path_re" || true)"
if [ -n "$raw_sql_hits" ]; then
  fail_with "a protected table is written (via raw sql\`...\`) outside apps/api/src/lib, apps/api/src/db, plugins/idempotency.ts, or a test file:"
  echo "$raw_sql_hits" >&2
fi

# ---------------------------------------------------------------------------
# 2) The ledger has one door. postMoves() in apps/api/src/lib/ledger.ts is the only
#    place allowed to insert stock_moves — check 1 above already keeps every insert
#    behind lib/; this additionally proves there is exactly one such call site.
# ---------------------------------------------------------------------------
echo "== the ledger has exactly one door =="

ledger_files="$(grep -rl -E 'insert\(stockMoves\)' apps/api/src --include="*.ts" | grep -v -E '\.test\.ts' || true)"
ledger_count="$(printf '%s\n' "$ledger_files" | grep -c . || true)"
if [ "$ledger_count" != "1" ] || [ "$ledger_files" != "apps/api/src/lib/ledger.ts" ]; then
  fail_with "insert(stockMoves) must appear in exactly one non-test file, apps/api/src/lib/ledger.ts. Found in:"
  echo "${ledger_files:-<nowhere>}" >&2
fi

# ---------------------------------------------------------------------------
# 3) Module skeleton. Every apps/api/src/modules/<name> (except _template, the
#    template itself) has routes.ts, service.ts, repo.ts and at least one *.test.ts.
# ---------------------------------------------------------------------------
echo "== module skeleton: routes.ts, service.ts, repo.ts, *.test.ts =="

for dir in apps/api/src/modules/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  [ "$name" = "_template" ] && continue

  for f in routes.ts service.ts repo.ts; do
    if [ ! -f "${dir}${f}" ]; then
      fail_with "apps/api/src/modules/$name is missing $f (every module needs routes.ts, service.ts, repo.ts and a *.test.ts — see apps/api/src/modules/_template)"
    fi
  done
  # shellcheck disable=SC2086
  if ! ls ${dir}*.test.ts >/dev/null 2>&1; then
    fail_with "apps/api/src/modules/$name has no *.test.ts (every module needs routes.ts, service.ts, repo.ts and a *.test.ts — see apps/api/src/modules/_template)"
  fi
done

if [ "$fail" != "0" ]; then
  echo "" >&2
  echo "One or more reuse-rule boundaries (spec §5.1, 'Reuse rules') were violated." >&2
  echo "See docs/superpowers/specs/2026-09-03-backend-design.md." >&2
  exit 1
fi

echo ""
echo "boundaries OK"
