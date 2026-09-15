// The one move from the API's outbox into the log. One transaction on the pool: rows are deleted
// from the outbox and inserted into `events` (or `dead_letters`) together, so a row is in exactly
// one place at every instant anyone can see. The outbox and the log share a database; that is what
// makes the move exactly-once rather than at-least-once.
//
// Every delete and insert below is written with its verb and table name on one line:
// scripts/check-boundaries.sh greps for them, and this file is the one it allows.
import { sql, type SQL } from "drizzle-orm";
import { AuditEventSchema, type AuditEvent } from "@rch/contract";
import type { Db } from "../db/client.js";

export type DrainTarget = { auditSchema: string; outboxSchema: string; eventsSchema: string; batch: number };
export type DrainResult = { moved: number; dead: number; issues: Array<{ outboxId: number; issue: string }> };

/** The API's change-stream channel prefix (apps/api/src/lib/events.ts). Restated rather than
 *  imported: apps/audit never imports apps/api. The API listens on `<prefix><its schema>`. */
export const EVENTS_CHANNEL_PREFIX = "rch_events_";

/** What `delete … returning` hands back. `id` is a bigint, which pg gives as a string, and `at` a
 *  timestamptz, which drizzle's driver gives as Postgres's own text. Both go straight back to
 *  Postgres and are never parsed here. */
type Taken = { id: string; at: string; event: unknown };
type Parsed = { row: Taken; event: AuditEvent };
type Refused = { row: Taken; issue: string };

const byOutboxId = (a: string, b: string): number => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

const EVENT_COLUMNS = sql.raw(
  "outbox_id, at, request_id, actor_id, actor_emp, actor_name, actor_role, actor_loc, action, method, path, "
  + "target, target_loc, outcome, status, message, cause, request, before, result, changed, ip, user_agent",
);

/** SQL NULL for an absent value, never the JSON literal `null`: `before` and `result` mean "not
 *  applicable". `request` is `not null` in the table, so a null one is stored as `{}`. */
const jsonb = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

function eventRow(p: Parsed): SQL {
  const e = p.event;
  return sql`(${p.row.id}::bigint, ${e.at}::timestamptz, ${e.requestId},
    ${e.actor.id}, ${e.actor.emp}, ${e.actor.name}, ${e.actor.role}, ${e.actor.loc},
    ${e.action}, ${e.method}, ${e.path}, ${e.target}, ${e.targetLoc},
    ${e.outcome}, ${e.status}::smallint, ${e.message}, ${e.cause},
    ${jsonb(e.request) ?? "{}"}::jsonb, ${jsonb(e.before)}::jsonb, ${jsonb(e.result)}::jsonb,
    ${sql.param(e.changed)}::text[], ${e.ip}, ${e.userAgent})`;
}

const deadLetterRow = (r: Refused): SQL =>
  sql`(${r.row.id}::bigint, ${r.row.at}::timestamptz, ${JSON.stringify(r.row.event)}::jsonb, ${r.issue})`;

/** The operator's line for a refused event: the first issue's path and message, or the message
 *  alone when the whole value is wrong (a string where an object belongs). */
function firstIssue(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  const [first] = issues;
  const path = first.path.map(String).join(".");
  return path ? `${path}: ${first.message}` : first.message;
}

/**
 * Postgres's reason when it refused the *row* - SQLSTATE class 22 (data exception: a status out of
 * `smallint`'s range) or 23 (integrity: `events_outbox_id_uq`, the exactly-once backstop) - and null
 * for any other failure. A row-shaped refusal can never succeed on a retry, so the row is set
 * aside; anything else (a dropped connection, a timeout) is the pass's problem, and rolling the
 * pass back whole loses nothing. Drizzle wraps pg's error and carries it as `.cause`.
 */
function rowRefusal(err: unknown): string | null {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" && /^2[23]/.test(cause.code) ? String(cause.message) : null;
}

export async function drainOnce(db: Db, t: DrainTarget): Promise<DrainResult> {
  // Schema names are quoted through `sql.identifier`; a configured name never becomes syntax.
  const outbox = sql.identifier(t.outboxSchema);
  const audit = sql.identifier(t.auditSchema);
  const insertEvents = (list: Parsed[]): SQL =>
    sql`insert into ${audit}.events (${EVENT_COLUMNS}) values ${sql.join(list.map(eventRow), sql`, `)}`;

  return db.transaction(async (tx) => {
    // `skip locked`: a second replica's pass takes the next rows instead of queueing behind this one.
    // `for update` needs UPDATE on one column, which the audit role's `update (at)` grant is for (D7).
    const taken = (await tx.execute(sql`delete from ${outbox}.audit_outbox where id in (select id from ${outbox}.audit_outbox order by id limit ${t.batch} for update skip locked) returning id, at, event`)).rows as Taken[];
    taken.sort((a, b) => byOutboxId(a.id, b.id));

    let valid: Parsed[] = [];
    const refused: Refused[] = [];
    for (const row of taken) {
      const parsed = AuditEventSchema.safeParse(row.event);
      if (parsed.success) valid.push({ row, event: parsed.data });
      else refused.push({ row, issue: firstIssue(parsed.error.issues) });
    }

    if (valid.length > 0) {
      try {
        await tx.transaction(async (sp) => { await sp.execute(insertEvents(valid)); });
      } catch (err) {
        if (rowRefusal(err) === null) throw err;
        // One row Postgres will never take must not hold the rest of the log up forever: find it
        // row by row, each under its own savepoint, and set it aside.
        const kept: Parsed[] = [];
        for (const p of valid) {
          try {
            await tx.transaction(async (sp) => { await sp.execute(insertEvents([p])); });
            kept.push(p);
          } catch (rowErr) {
            const why = rowRefusal(rowErr);
            if (why === null) throw rowErr;
            refused.push({ row: p.row, issue: `database refused it: ${why}` });
          }
        }
        valid = kept;
      }
    }

    refused.sort((a, b) => byOutboxId(a.row.id, b.row.id));
    if (refused.length > 0) {
      await tx.execute(sql`insert into ${audit}.dead_letters (outbox_id, at, event, issue) values ${sql.join(refused.map(deadLetterRow), sql`, `)}`);
    }

    // Held by Postgres until COMMIT, like the API's own `emitChanged`: a pass that rolls back
    // announces nothing. Only stored events are news; a dead letter shows on no screen.
    if (valid.length > 0) {
      const notice = JSON.stringify({ collections: ["audit"], at: new Date().toISOString() });
      await tx.execute(sql`select pg_notify(${EVENTS_CHANNEL_PREFIX + t.eventsSchema}, ${notice})`);
    }

    return {
      moved: valid.length,
      dead: refused.length,
      issues: refused.map((r) => ({ outboxId: Number(r.row.id), issue: r.issue })),
    };
  });
}

/** How far behind the log is: rows waiting, and the age of the oldest in seconds (0 when none).
 *  Sampled after every pass for `audit_outbox_depth` and `audit_drain_lag_seconds`. */
export async function outboxStats(db: Db, outboxSchema: string): Promise<{ depth: number; lagSeconds: number }> {
  const r = await db.execute(sql`
    select count(*)::int as depth, coalesce(extract(epoch from now() - min(at)), 0)::float8 as lag
    from ${sql.identifier(outboxSchema)}.audit_outbox`);
  const row = r.rows[0] as { depth: number; lag: number };
  return { depth: row.depth, lagSeconds: row.lag };
}
