#!/usr/bin/env bash
#
# Enforces the repo's reuse rules
# that oxlint cannot see because they depend on call shape (which Drizzle table a
# statement writes to) or on directory contents (a module's file skeleton), not on
# import statements. Runs from the repo root; see package.json's "check:boundaries".
#
# These checks are line-oriented: every pattern below is matched with `grep -E` against one
# line at a time, so a call spread across lines - `db\n  .insert(stockMoves)` - is not caught.
# And they cannot tell code from prose: a module comment that names a protected table alongside
# the words "update" or "delete" trips the same grep a real write would, on purpose - the fix
# there is to reword the comment, not to weaken the pattern.
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
#    they may be imported for reads only - oxlint cannot see call shape, so this is a
#    grep). `reservations` joined the list with lib/reservations.ts: a reservation is a
#    promise against a balance, and a module that wrote one itself would skip the lock.
# ---------------------------------------------------------------------------
echo "== protected tables: writes stay behind lib/, db/, idempotency.ts =="

allowed_path_re='src/lib/|src/db/|plugins/idempotency\.ts|\.test\.ts'

# The two patterns below used to be literal lists - `insert\(stockMoves\)` and friends - which
# matched exactly the spelling lib/ledger.ts happens to use and nothing else. Every other way of
# writing the same statement walked straight past the check whose whole job is to stop it:
# `insert(schema.stockMoves)`, `insert( stockMoves )`, `insert into "stock_moves"`,
# `merge into stock_moves`. They are now written as a shape - any qualifier chain, any spacing,
# a quoted identifier, an optional schema prefix - and all six tables take all three verbs,
# because "written only from lib/" is what the rule says and stock_moves is append-only even
# there. document_history joins update and delete for the same reason: a trail somebody can
# edit is not a trail.
protected_orm='stockMoves|stockBalances|sequences|documentHistory|idempotencyKeys|reservations'
protected_sql='stock_moves|stock_balances|sequences|document_history|idempotency_keys|reservations'
# POSIX classes, not \s and \b: this runs on the maintainers' macOS as well as on CI's GNU grep.
qualifier='([A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*\.[[:space:]]*)*'

orm_pattern='(insert|update|delete)[[:space:]]*\([[:space:]]*'"$qualifier"'('"$protected_orm"')[[:space:]]*\)'
orm_hits="$(grep -rn -E "$orm_pattern" apps/api/src --include="*.ts" | grep -v -E "$allowed_path_re" || true)"
if [ -n "$orm_hits" ]; then
  fail_with "a protected table is written (via Drizzle) outside apps/api/src/lib, apps/api/src/db, plugins/idempotency.ts, or a test file:"
  echo "$orm_hits" >&2
fi

# `merge into` alongside `insert into`: Postgres 15 gained MERGE, and a merge that upserts a
# balance is every bit the write an insert is. The optional `"`/backtick and schema prefix cover
# `insert into "stock_moves"` and `update public.stock_balances`.
sql_verb='((insert|merge)[[:space:]]+into|update|delete[[:space:]]+from)'
# shellcheck disable=SC2016  # the trailing `$` is grep's end-of-line anchor, not a shell expansion
sql_table='["`]?([A-Za-z_][A-Za-z0-9_]*["`]?[[:space:]]*\.[[:space:]]*["`]?)?('"$protected_sql"')([^A-Za-z0-9_]|$)'
raw_sql_pattern="$sql_verb"'[[:space:]]+'"$sql_table"
raw_sql_hits="$(grep -rn -i -E "$raw_sql_pattern" apps/api/src --include="*.ts" | grep -v -E "$allowed_path_re" || true)"
if [ -n "$raw_sql_hits" ]; then
  fail_with "a protected table is written (via raw sql\`...\`) outside apps/api/src/lib, apps/api/src/db, plugins/idempotency.ts, or a test file:"
  echo "$raw_sql_hits" >&2
fi

# ---------------------------------------------------------------------------
# 2) The ledger has one door. postMoves() in apps/api/src/lib/ledger.ts is the only
#    place allowed to insert stock_moves - check 1 above already keeps every insert
#    behind lib/; this additionally proves there is exactly one such call site.
# ---------------------------------------------------------------------------
echo "== the ledger has exactly one door =="

# Same shape as check 1's, narrowed to the one table and the one verb, plus the raw-SQL spelling
# - a `sql` template that writes stock_moves from inside lib/ is exempt from check 1 by path and
# would otherwise be a second door this check could not see.
ledger_orm='insert[[:space:]]*\([[:space:]]*'"$qualifier"'stockMoves[[:space:]]*\)'
# shellcheck disable=SC2016  # as above: `$` anchors, it does not expand
ledger_sql='(insert|merge)[[:space:]]+into[[:space:]]+["`]?([A-Za-z_][A-Za-z0-9_]*["`]?[[:space:]]*\.[[:space:]]*["`]?)?stock_moves([^A-Za-z0-9_]|$)'
ledger_files="$(grep -rl -i -E "$ledger_orm|$ledger_sql" apps/api/src --include="*.ts" | grep -v -E '\.test\.ts' || true)"
ledger_count="$(printf '%s\n' "$ledger_files" | grep -c . || true)"
if [ "$ledger_count" != "1" ] || [ "$ledger_files" != "apps/api/src/lib/ledger.ts" ]; then
  fail_with "an insert into stock_moves must appear in exactly one non-test file, apps/api/src/lib/ledger.ts. Found in:"
  echo "${ledger_files:-<nowhere>}" >&2
fi

# ---------------------------------------------------------------------------
# 3) Module skeleton. Every apps/api/src/modules/<name> (except _template, the
#    template itself) and every apps/audit/src/modules/<name> has routes.ts,
#    service.ts, repo.ts and at least one *.test.ts.
# ---------------------------------------------------------------------------
echo "== module skeleton: routes.ts, service.ts, repo.ts, *.test.ts =="

check_skeleton() {
  local modules="$1" dir name f
  for dir in "$modules"/*/; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    [ "$name" = "_template" ] && continue

    for f in routes.ts service.ts repo.ts; do
      if [ ! -f "${dir}${f}" ]; then
        fail_with "$modules/$name is missing $f (every module needs routes.ts, service.ts, repo.ts and a *.test.ts - see apps/api/src/modules/_template)"
      fi
    done
    # shellcheck disable=SC2086
    if ! ls ${dir}*.test.ts >/dev/null 2>&1; then
      fail_with "$modules/$name has no *.test.ts (every module needs routes.ts, service.ts, repo.ts and a *.test.ts - see apps/api/src/modules/_template)"
    fi
  done
}

check_skeleton apps/api/src/modules
check_skeleton apps/audit/src/modules

# ---------------------------------------------------------------------------
# 4) The audit outbox, from the API's side. apps/api appends to audit_outbox from exactly one
#    file, lib/audit.ts - the one place that masks secrets and builds the event - and nothing in
#    apps/api reads it back, updates it, deletes from it or truncates it. The role the API runs as
#    (rch_app) holds INSERT alone on that table; this is the same rule, stated where a reviewer
#    reads code rather than grants. Test files and apps/api/src/test/ are exempt: the suites read
#    the outbox to assert what a write recorded.
# ---------------------------------------------------------------------------
echo "== audit outbox: apps/api appends from lib/audit.ts and never reads it back =="

api_exempt_re='\.test\.ts|^apps/api/src/test/'
# shellcheck disable=SC2016  # `$` anchors, it does not expand
outbox_sql='["`]?([A-Za-z_][A-Za-z0-9_]*["`]?[[:space:]]*\.[[:space:]]*["`]?)?audit_outbox([^A-Za-z0-9_]|$)'
outbox_orm="$qualifier"'auditOutbox[[:space:]]*\)'

outbox_insert='insert[[:space:]]*\([[:space:]]*'"$outbox_orm"'|(insert|merge)[[:space:]]+into[[:space:]]+'"$outbox_sql"
outbox_insert_files="$(grep -rl -i -E "$outbox_insert" apps/api/src --include="*.ts" | grep -v -E "$api_exempt_re" || true)"
if [ "$outbox_insert_files" != "apps/api/src/lib/audit.ts" ]; then
  fail_with "an insert into audit_outbox must appear in exactly one non-test file, apps/api/src/lib/audit.ts. Found in:"
  echo "${outbox_insert_files:-<nowhere>}" >&2
fi

outbox_touch='(update|delete|from)[[:space:]]*\([[:space:]]*'"$outbox_orm"'|(update|delete[[:space:]]+from|from|join|truncate([[:space:]]+table)?)[[:space:]]+'"$outbox_sql"
outbox_touch_hits="$(grep -rn -i -E "$outbox_touch" apps/api/src --include="*.ts" | grep -v -E "$api_exempt_re" || true)"
if [ -n "$outbox_touch_hits" ]; then
  fail_with "apps/api reads, updates, deletes from or truncates audit_outbox - the API only appends to it (lib/audit.ts):"
  echo "$outbox_touch_hits" >&2
fi

# ---------------------------------------------------------------------------
# 5) The audit service's one door. apps/audit moves an event exactly once: lib/drain.ts deletes
#    it from the outbox and inserts it into events (or dead_letters) in one transaction, so that
#    file is the only one that may do either - and nothing in apps/audit inserts into, updates or
#    truncates the outbox, which is the API's to write. The outbox is matched loosely (any token
#    containing `outbox`, any case) because the service names it through OUTBOX_SCHEMA as an
#    interpolated quoted identifier - `delete from ${outbox}` or `"${schema}".audit_outbox` - not a
#    literal the grep could anchor on; the statement's verb and its table still have to share a
#    line. Test files and apps/audit/src/test/ are exempt: the suites fill the outbox themselves.
# ---------------------------------------------------------------------------
echo "== audit service: only lib/drain.ts moves events out of the outbox =="

audit_exempt_re='\.test\.ts|^apps/audit/src/test/'
drain_file="apps/audit/src/lib/drain.ts"
if [ ! -d apps/audit/src ]; then
  fail_with "apps/audit/src is missing - the audit service's boundaries cannot be checked"
else
  drain_delete='delete[[:space:]]+from[[:space:]]+[^[:space:]]*outbox|delete[[:space:]]*\([^)]*outbox'
  drain_delete_files="$(grep -rl -i -E "$drain_delete" apps/audit/src --include="*.ts" | grep -v -E "$audit_exempt_re" || true)"
  if [ "$drain_delete_files" != "$drain_file" ]; then
    fail_with "a delete from the audit outbox must appear in exactly one non-test file, $drain_file. Found in:"
    echo "${drain_delete_files:-<nowhere>}" >&2
  fi

  store_insert='insert[[:space:]]+into[[:space:]]+[^[:space:]]*(events|dead_letters)([^A-Za-z0-9_]|$)|insert[[:space:]]*\([^)]*(events|deadLetters)[[:space:]]*\)'
  store_insert_files="$(grep -rl -i -E "$store_insert" apps/audit/src --include="*.ts" | grep -v -E "$audit_exempt_re" || true)"
  if [ "$store_insert_files" != "$drain_file" ]; then
    fail_with "an insert into events or dead_letters must appear in exactly one non-test file, $drain_file. Found in:"
    echo "${store_insert_files:-<nowhere>}" >&2
  fi

  outbox_write='(insert|merge)[[:space:]]+into[[:space:]]+[^[:space:]]*outbox|update[[:space:]]+[^[:space:]]*outbox|truncate([[:space:]]+table)?[[:space:]]+[^[:space:]]*outbox|(insert|update)[[:space:]]*\([^)]*outbox'
  outbox_write_hits="$(grep -rn -i -E "$outbox_write" apps/audit/src --include="*.ts" | grep -v -E "$audit_exempt_re" || true)"
  if [ -n "$outbox_write_hits" ]; then
    fail_with "apps/audit inserts into, updates or truncates the audit outbox - it only ever deletes what it drained (lib/drain.ts):"
    echo "$outbox_write_hits" >&2
  fi
fi

# ---------------------------------------------------------------------------
# 6) The audit store is append-only. Nothing outside a test updates, deletes from or truncates
#    events or dead_letters, in apps/audit or in apps/api. The triggers refuse it for every role;
#    this refuses it before somebody writes a statement that could only ever fail in production.
# ---------------------------------------------------------------------------
echo "== audit store: events and dead_letters are never updated or deleted =="

store_touch='(update|delete[[:space:]]+from|truncate([[:space:]]+table)?)[[:space:]]+[^[:space:]]*(events|dead_letters)([^A-Za-z0-9_]|$)|(update|delete)[[:space:]]*\([^)]*(events|deadLetters)[[:space:]]*\)'
store_touch_hits="$(grep -rn -i -E "$store_touch" apps/api/src apps/audit/src --include="*.ts" 2>/dev/null | grep -v -E '\.test\.ts|^apps/(api|audit)/src/test/' || true)"
if [ -n "$store_touch_hits" ]; then
  fail_with "the audit store (events, dead_letters) is append-only - nothing may update, delete from or truncate it:"
  echo "$store_touch_hits" >&2
fi

# ---------------------------------------------------------------------------
# 7) A permission is never a desk. What a caller may do is its role's permissions - `can`,
#    `holds`, `req.actor.wide`, a route's `need(...)` - which the super admin edits; the desk
#    (`role` on a token, `r` on a user, `desk` on a role) says only where someone sits. The outlet
#    manager's desk has no mechanics of its own - where it sits is `atOutlet` in @rch/domain,
#    shared with the counter - so an equality against "manager" in the API or the UI is always a
#    permission check wearing a desk's name, the kind the configurable roles replaced: a role given
#    the manager's features would be refused, and a manager whose role lost them let through.
#    Tests are exempt: they sign in as the seeded desks.
# ---------------------------------------------------------------------------
echo "== permissions: no desk-equality check against \"manager\" in apps/api or the UI =="

desk_exempt_re='\.test\.tsx?:|/__tests__/|^apps/api/src/test/'
manager_eq='[!=]==?[[:space:]]*["'\'']manager["'\'']|["'\'']manager["'\''][[:space:]]*[!=]==?|case[[:space:]]+["'\'']manager["'\'']'
manager_hits="$(grep -rn -E "$manager_eq" apps/api/src UI/src --include="*.ts" --include="*.tsx" | grep -v -E "$desk_exempt_re" || true)"
if [ -n "$manager_hits" ]; then
  fail_with "a check compares a desk with \"manager\" - ask the role's permissions instead (can/holds from @rch/domain, req.actor.wide, a route's need), or atOutlet for where a desk sits:"
  echo "$manager_hits" >&2
fi

# ---------------------------------------------------------------------------
# 8) A refund has one writer. payment_refunds - money promised back to a QR customer - is
#    inserted, updated and deleted only by apps/api/src/lib/refunds.ts, which queues each one
#    under its order's lock and moves it only along REFUND_TRANSITIONS. Test files and
#    apps/api/src/test/ are exempt.
# ---------------------------------------------------------------------------
echo "== payment refunds: written only by lib/refunds.ts =="

refund_orm='(insert|update|delete)[[:space:]]*\([[:space:]]*'"$qualifier"'paymentRefunds[[:space:]]*\)'
# shellcheck disable=SC2016  # `$` anchors, it does not expand
refund_sql='((insert|merge)[[:space:]]+into|update|delete[[:space:]]+from)[[:space:]]+["`]?([A-Za-z_][A-Za-z0-9_]*["`]?[[:space:]]*\.[[:space:]]*["`]?)?payment_refunds([^A-Za-z0-9_]|$)'
refund_hits="$(grep -rn -i -E "$refund_orm|$refund_sql" apps/api/src --include="*.ts" | grep -v -E "$api_exempt_re|^apps/api/src/lib/refunds\.ts:" || true)"
if [ -n "$refund_hits" ]; then
  fail_with "payment_refunds is written outside apps/api/src/lib/refunds.ts:"
  echo "$refund_hits" >&2
fi

if [ "$fail" != "0" ]; then
  echo "" >&2
  echo "One or more reuse-rule boundaries were violated." >&2
  exit 1
fi

echo ""
echo "boundaries OK"
