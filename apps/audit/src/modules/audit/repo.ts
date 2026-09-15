// repo.ts: SQL only. No rules, no transaction of its own - service.ts opens the read-only
// transaction and passes it in. `events` is unqualified: the pool's search_path is the audit
// schema (spec §3.2), the way the API's repos resolve their own tables.
import { sql, type SQL } from "drizzle-orm";
import type { AuditCounts, AuditEntry, AuditOutcome, AuditRow } from "@rch/contract";
import type { Reader } from "../../lib/db.js";

/** `fromAt` inclusive, `toAt` exclusive (the IST midnight after the last day asked for). */
export type AuditFilter = {
  fromAt: Date; toAt: Date;
  actor?: string; role?: string; loc?: string;
  actions?: string[]; outcome?: AuditOutcome; q?: string;
  before?: number; limit: number;
};

type RowRecord = {
  id: string; at: string; request_id: string; ip: string;
  actor_id: string | null; actor_emp: string; actor_name: string; actor_role: string; actor_loc: string;
  action: string; target: string; target_loc: string; outcome: AuditOutcome; status: number; message: string;
};
type EntryRecord = RowRecord & {
  method: string; path: string; cause: string | null;
  request: unknown; before: unknown; result: unknown; changed: string[]; user_agent: string;
};

/** `at` is formatted here: drizzle's driver hands a timestamptz back as Postgres's own text, and the
 *  wire wants `toISOString()`'s shape. `id` is a bigint, which pg gives as a string. `request_id` and
 *  `ip` are on the row (D4) for the table's CSV export. */
const ROW_COLUMNS = sql.raw(
  `id, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at, request_id, ip, `
  + "actor_id, actor_emp, actor_name, actor_role, actor_loc, action, target, target_loc, outcome, status, message",
);

const toRow = (r: RowRecord): AuditRow => ({
  id: Number(r.id), at: r.at,
  actor: { id: r.actor_id, emp: r.actor_emp, name: r.actor_name, role: r.actor_role, loc: r.actor_loc },
  action: r.action, target: r.target, targetLoc: r.target_loc, outcome: r.outcome, status: r.status, message: r.message,
  requestId: r.request_id, ip: r.ip,
});

/** `%` and `_` in a search are the characters themselves, and so is the escape character. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function matching(f: AuditFilter): SQL {
  const parts: SQL[] = [sql`at >= ${f.fromAt}`, sql`at < ${f.toAt}`];
  if (f.actor !== undefined) parts.push(sql`actor_id = ${f.actor}`);
  if (f.role !== undefined) parts.push(sql`actor_role = ${f.role}`);
  // D9: where the person worked or where the target belongs.
  if (f.loc !== undefined) parts.push(sql`(actor_loc = ${f.loc} or target_loc = ${f.loc})`);
  if (f.actions !== undefined) parts.push(f.actions.length > 0 ? sql`action = any(${sql.param(f.actions)}::text[])` : sql`false`);
  if (f.outcome !== undefined) parts.push(sql`outcome = ${f.outcome}`);
  if (f.q !== undefined) {
    const like = `%${escapeLike(f.q)}%`;
    parts.push(sql`(target ilike ${like} escape '\\' or message ilike ${like} escape '\\' or actor_name ilike ${like} escape '\\' or actor_emp ilike ${like} escape '\\')`);
  }
  return sql.join(parts, sql` and `);
}

export const auditRepo = {
  /** Newest first by id, keyset on `before`. One row past the page says whether there is a next. */
  async page(db: Reader, f: AuditFilter): Promise<{ rows: AuditRow[]; next: number | null }> {
    const cursor = f.before === undefined ? sql`` : sql` and id < ${f.before}`;
    const { rows } = await db.execute(sql`select ${ROW_COLUMNS} from events where ${matching(f)}${cursor} order by id desc limit ${f.limit + 1}`);
    const records = rows as RowRecord[];
    const more = records.length > f.limit;
    const page = (more ? records.slice(0, f.limit) : records).map(toRow);
    return { rows: page, next: more ? page[page.length - 1].id : null };
  },

  /** Over the whole filter, never the page (no `before`, no `limit`). A person is their user id, or
   *  the typed employee number of a sign-in nobody could be matched to. */
  async counts(db: Reader, f: AuditFilter): Promise<AuditCounts> {
    const { rows } = await db.execute(sql`
      select count(*)::int as events,
             count(distinct coalesce(actor_id, actor_emp))::int as people,
             count(*) filter (where outcome <> 'done')::int as refused,
             count(*) filter (where action = 'login' and outcome = 'refused')::int as failed_sign_ins
      from events where ${matching(f)}`);
    const r = rows[0] as { events: number; people: number; refused: number; failed_sign_ins: number };
    return { events: r.events, people: r.people, refused: r.refused, failedSignIns: r.failed_sign_ins };
  },

  async entry(db: Reader, id: number): Promise<AuditEntry | null> {
    const { rows } = await db.execute(sql`
      select ${ROW_COLUMNS}, method, path, cause, request, before, result, changed, user_agent
      from events where id = ${id}`);
    const r = rows[0] as EntryRecord | undefined;
    if (!r) return null;
    return {
      ...toRow(r), method: r.method, path: r.path, cause: r.cause,
      request: r.request, before: r.before, result: r.result, changed: r.changed, userAgent: r.user_agent,
    };
  },
};
