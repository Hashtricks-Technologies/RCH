import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * One row per audited action, moved here from the API's `audit_outbox` by the drainer. Every
 * column is what the event said at the time - the actor's name, role and location as they stood -
 * so a renamed or deleted account still reads correctly, and nothing references the API's tables.
 *
 * Unqualified: the tables resolve through `search_path = AUDIT_SCHEMA` (spec §3.2). Append-only in
 * the database (drizzle/0000_audit_events.sql's trigger), which drizzle-kit cannot see.
 */
export const events = pgTable("events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  /** The outbox row this came from. Unique: the backstop behind the drain's exactly-once move. */
  outboxId: bigint("outbox_id", { mode: "number" }).notNull().unique("events_outbox_id_uq"),
  at: ts("at").notNull(),
  requestId: text("request_id").notNull(),
  /** No foreign key, on purpose: deleting an account must not touch its history. */
  actorId: text("actor_id"),
  actorEmp: text("actor_emp").notNull(),
  actorName: text("actor_name").notNull(),
  actorRole: text("actor_role").notNull(),
  actorLoc: text("actor_loc").notNull(),
  /** A manifest route name or login/logout/changePassword. A plain string, so a removed route's history still reads. */
  action: text("action").notNull(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  target: text("target").notNull().default(""),
  targetLoc: text("target_loc").notNull().default(""),
  outcome: text("outcome", { enum: ["done", "refused", "error"] }).notNull(),
  status: smallint("status").notNull(),
  message: text("message").notNull().default(""),
  cause: text("cause"),
  request: jsonb("request").notNull().default({}),
  before: jsonb("before"),
  result: jsonb("result"),
  changed: text("changed").array().notNull().default(sql`'{}'::text[]`),
  ip: text("ip").notNull().default(""),
  userAgent: text("user_agent").notNull().default(""),
  storedAt: ts("stored_at").notNull().defaultNow(),
}, (t) => [
  check("events_outcome_ck", sql`${t.outcome} in ('done', 'refused', 'error')`),
  // The page is keyset-paged on id; each filter the read route offers has an index that ends in it.
  index("events_at_idx").on(t.at.desc(), t.id.desc()),
  index("events_actor_idx").on(t.actorId, t.id.desc()),
  index("events_target_idx").on(t.target, t.id.desc()),
  index("events_action_idx").on(t.action, t.id.desc()),
  index("events_outcome_idx").on(t.outcome, t.id.desc()),
]);

/** An outbox row whose event failed `AuditEventSchema`, kept whole with the first issue, so a
 *  malformed event is never silently dropped and never blocks the ones behind it. */
export const deadLetters = pgTable("dead_letters", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  outboxId: bigint("outbox_id", { mode: "number" }).notNull(),
  at: ts("at").notNull(),
  event: jsonb("event").notNull(),
  issue: text("issue").notNull(),
  storedAt: ts("stored_at").notNull().defaultNow(),
});
