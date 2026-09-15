import type { Db } from "../db/client.js";
import { idemStore } from "../plugins/idempotency.js";
import { recordAudit } from "./audit.js";
import { recordIdempotent } from "./idempotency-record.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A read may be handed the pool or an open transaction's own client; both answer `select`.
 *  Every reader and read-side repo takes this rather than `Db`, so the same function serves a
 *  standalone GET and a write validating against the master it is about to commit with. */
export type Reader = Db | Tx;

/**
 * All writes go through here so a service cannot forget the transaction - and so the
 * idempotency record cannot be forgotten either.
 *
 * When this transaction is running inside a write request (`mount()` put the request's claim
 * into `idemStore`), the response the transaction produced is written into the claim row as the
 * **last statement before COMMIT**. It therefore commits with the write or not at all: a pod
 * that dies, a pool that times out, or a response that fails its own schema on the way out can
 * no longer leave the hospital with a bill nobody's Idempotency-Key knows about, which is what
 * turned the client's retry into a second bill.
 *
 * A write may open more than one transaction, and only one of them returns the response, so a
 * value the route's schema refuses is not an error here - it means "not this one", and the next
 * transaction is asked in turn. In development and test that leniency is switched off
 * (`ctx.strict`): the first transaction to produce an unrecordable response takes the write down
 * with it, so a write whose answer is not recorded shows up as a failure on the bench rather
 * than as an un-replayable sale in the hospital. Production leaves the write standing, carries
 * the reason out on `ctx.why` for `mount()` to log, and falls back to `onSend`.
 *
 * The record's own UPDATE is deliberately **not** wrapped in a try/catch: if writing the claim
 * row throws, the business write rolls back with it. That is the opposite of the `onSend` hook
 * below it, which warns and lets the response through - and it is the right way round here,
 * because a write that commits without its record is exactly the duplicate-charge hole this
 * whole arrangement closes. Atomicity over availability, on purpose.
 *
 * `opts.response` is `"required"` by default: whatever this transaction returns is the write's
 * answer, and an answer that cannot be recorded is a bug the bench must not let past.
 *
 * `"optional"` is for the one shape that has to **commit something and then refuse**: a counter,
 * an audit row - something that must survive the refusal that follows it. Such a write returns a
 * marker its route's schema refuses, commits, and raises the refusal itself once the transaction
 * is closed. Under `"optional"` a value the schema refuses records nothing, leaves
 * `ctx.idem.recorded` false and throws nothing, and `onSend` then stores the 4xx exactly as it
 * always has (`committed_at` stays null, because a refusal is not an outcome to protect). A
 * value that *does* match is still recorded, so the successful path through such a write is
 * untouched. `modules/tickets/service.ts`'s `handover` is the only caller: a wrong OTP is
 * counted, the count commits, and the sentence is thrown outside. What it costs is a pod that
 * dies between that commit and `onSend` leaving a bare claim, so the retry waits out
 * `CLAIM_STALE_MS` and then counts a second guess - acceptable for a counter, and exactly what
 * `"required"` refuses to accept for a bill. Do not reach for `"optional"` to quieten a response
 * that simply does not match its schema; that is the bug `"required"` is there to catch.
 *
 * The write's audit event is the record's twin: `recordAudit` (`lib/audit.ts`) inserts it straight
 * after a successful record, in the same transaction and unguarded for the same reason, so a write
 * that cannot be audited does not commit either. Only the transaction that records the outcome
 * stores an event, so a write that opens several transactions gets exactly one. `ctx.audit.recorded`
 * is set once that transaction has **committed**, not before, because `plugins/audit.ts` reads it
 * to decide whether the request still needs an event of its own (a refusal, a 5xx, or production's
 * `onSend` fallback).
 */
export const withTransaction = async <T>(db: Db, fn: (tx: Tx) => Promise<T>, opts: { response?: "required" | "optional" } = {}): Promise<T> => {
  const ctx = idemStore.getStore();
  try {
    const value = await db.transaction(async (tx) => {
      const answer = await fn(tx);
      if (ctx && !ctx.idem.recorded) {
        // "not this transaction's answer, and the caller knows it" - see `opts.response` above.
        // Checked here rather than inside `recordIdempotent` so that its *other* `ok: false` (a
        // claim taken over by a retry mid-write) still takes the straggler down, whatever this
        // caller asked for.
        if (opts.response === "optional" && !ctx.response.safeParse(answer).success) {
          ctx.why = "a write's response failed its own schema and its caller asked for that to be tolerated";
          return answer;
        }
        const outcome = await recordIdempotent(tx, ctx, answer);
        if (outcome.ok) await recordAudit(tx, ctx, outcome.body);
        ctx.idem.recorded = outcome.ok;
        if (!outcome.ok) {
          ctx.why = outcome.why;
          if (ctx.strict) throw new Error(outcome.why);
        }
      }
      return answer;
    });
    // Reached only once COMMIT has returned: the event is durable now, and not a moment sooner.
    if (ctx?.audit.pending) ctx.audit.recorded = true;
    return value;
  } finally {
    if (ctx) ctx.audit.pending = false;
  }
};

/**
 * Every read that makes more than one query goes through here, so **one request takes one
 * connection**.
 *
 * `pg` checks a client out per query, so a read that fans out with `Promise.all` asks the pool
 * for one connection *per reader*: `GET /snapshot`'s twenty-four readers wanted about forty at
 * once, against a pool of ten. Thirty concurrent snapshots therefore queued hundreds of
 * acquisitions behind ten connections and p95 went to 2.9 s with `pg_pool_idle` pinned at 0 -
 * measured, not guessed (RUNBOOK §12). A transaction holds exactly one client from `begin` to
 * `commit`, so the fan-out costs one connection however many queries it makes.
 *
 * `read only` is the honest declaration and also a guard: a reader that ever tried to write
 * would be refused by Postgres rather than quietly committing from a GET.
 *
 * Callers inside one of these `await` their queries **one after another** rather than wrapping
 * them in `Promise.all`. A transaction is a single client and a client runs one query at a
 * time, so `Promise.all` buys no parallelism here - `pg` queues the second query today and
 * will refuse it in pg 9 (the same note `lib/master.ts` has carried since Phase 2). Sequential
 * awaits say what actually happens.
 */
export const withReadTransaction = <T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  db.transaction(fn, { accessMode: "read only" });

/** Postgres reports a unique violation the same way whether the arbiter is a table constraint
 *  or (as for a partial unique index) a unique index - `code` 23505, `constraint` the index's
 *  own name. Drizzle wraps the raw `pg` error in a `DrizzleQueryError` and carries it as
 *  `.cause`, so that is where the code and constraint name are read from. `UPDATE` has no
 *  `onConflictDoNothing`, so this is how a repo makes a rename or a reactivation raced by a
 *  second writer resolve into a refusal instead of a 500 - one home for both callers
 *  (`modules/vendors/repo.ts`, `modules/contracts/repo.ts`). */
export const isUniqueViolation = (err: unknown, constraint: string): boolean => {
  const cause = (err as { cause?: unknown } | null)?.cause as { code?: string; constraint?: string } | undefined;
  return cause?.code === "23505" && cause?.constraint === constraint;
};

/** A statement refused because a row elsewhere still points at the one it touched - `code` 23503,
 *  read off `.cause` for the same reason as above. Any constraint, on purpose: its one caller
 *  (`lib/users-admin.ts`'s `deleteUserTx`) wants "does anything at all still refer to this row",
 *  so a table added later with a reference to it is covered without anyone naming it. */
export const isForeignKeyViolation = (err: unknown): boolean =>
  ((err as { cause?: unknown } | null)?.cause as { code?: string } | undefined)?.code === "23503";

/** The unique index a statement ran into, when that is why it failed - a refusal can then name the
 *  field that clashed rather than the constraint. Undefined for any other failure. */
export const uniqueViolationOf = (err: unknown): string | undefined => {
  const cause = (err as { cause?: { code?: string; constraint?: string } } | null)?.cause;
  return cause?.code === "23505" ? cause.constraint : undefined;
};
