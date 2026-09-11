import { bigint, check, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ts, users } from "./master.js";

export const documentHistory = pgTable("document_history", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  docType: text("doc_type").notNull(),
  docId: text("doc_id").notNull(),
  status: text("status").notNull(),
  who: text("who").notNull(),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("document_history_doc_idx").on(t.docType, t.docId, t.at)]);

/** Serialised numbering, gapless through a rollback — the counter is a row, and a refused write
 *  undoes its increment with everything else. Allocated with UPDATE … RETURNING inside the
 *  write's transaction, which holds the row lock to the end of it: every other writer in the
 *  series queues there, so a number is taken as late as the write can take it (`lib/ids.ts`). */
export const sequences = pgTable("sequences", {
  kind: text("kind").primaryKey(),
  next: bigint("next", { mode: "number" }).notNull(),
}, (t) => [
  // A series that had run back to zero would re-issue a number already printed on paper.
  check("sequences_next_ck", sql`${t.next} > 0`),
]);

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  requestHash: text("request_hash").notNull(),
  statusCode: integer("status_code").notNull(),
  response: jsonb("response").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
}, (t) => [primaryKey({ columns: [t.key, t.userId] }), index("idempotency_expires_idx").on(t.expiresAt)]);

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => users.id),
  family: uuid("family").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  revokedAt: ts("revoked_at"),
  userAgent: text("user_agent"),
  ip: text("ip"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  // Every refresh and logout looks a token up by its hash; without this index that is a
  // sequential scan over every session the hospital has ever opened. Unique, because two rows
  // sharing a hash would mean two sessions sharing a secret.
  uniqueIndex("refresh_tokens_token_hash_uq").on(t.tokenHash),
  index("refresh_tokens_family_idx").on(t.family),
  index("refresh_tokens_user_idx").on(t.userId),
]);
