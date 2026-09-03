import { bigint, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { moveKindEnum } from "./enums.js";
import { items, locations, qty, ts, users } from "./master.js";

/** Append-only. The only source of truth for quantity. Never updated, never deleted. */
export const stockMoves = pgTable("stock_moves", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  at: ts("at").notNull().defaultNow(),
  loc: text("loc").notNull().references(() => locations.key),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),             // signed
  kind: moveKindEnum("kind").notNull(),
  refType: text("ref_type").notNull(),
  refId: text("ref_id").notNull(),
  byUser: text("by_user").references(() => users.id),
  reversesId: bigint("reverses_id", { mode: "number" }),
}, (t) => [index("stock_moves_loc_item_at_idx").on(t.loc, t.itemKey, t.at), index("stock_moves_ref_idx").on(t.refType, t.refId)]);

/** Cache of Σ moves per (loc, item). Maintained by postMoves(); rebuildable by db:rebuild-balances. */
export const stockBalances = pgTable("stock_balances", {
  loc: text("loc").notNull().references(() => locations.key),
  itemKey: text("item_key").notNull().references(() => items.key),
  onHand: qty("on_hand").notNull().default(0),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.loc, t.itemKey] })]);

export const reservations = pgTable("reservations", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  loc: text("loc").notNull().references(() => locations.key),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  ticketId: text("ticket_id").notNull(),   // text, not an FK: tickets is defined in movement.ts and a
                                            // reference here would create an import cycle; the movement
                                            // service inserts both in one transaction.
  createdAt: ts("created_at").notNull().defaultNow(),
  releasedAt: ts("released_at"),
}, (t) => [index("reservations_open_idx").on(t.loc, t.itemKey).where(sql`released_at is null`)]);

export const availabilityOverrides = pgTable("availability_overrides", {
  loc: text("loc").notNull().references(() => locations.key),
  itemKey: text("item_key").notNull().references(() => items.key),
  reason: text("reason").notNull(),
  byUser: text("by_user").references(() => users.id),
  at: ts("at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.loc, t.itemKey] })]);
