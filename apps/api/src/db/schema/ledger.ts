import { bigint, check, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
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
}, (t) => [
  index("stock_moves_loc_item_at_idx").on(t.loc, t.itemKey, t.at), index("stock_moves_ref_idx").on(t.refType, t.refId),
  // A move of zero is not a movement: it creates a balance row that reads as "this location
  // carries the line" (M12) without anything ever having been carried.
  check("stock_moves_qty_ck", sql`${t.qty} <> 0`),
]);

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
  // Declared here without `.references()`: `tickets` is defined in movement.ts and importing it
  // would close a TypeScript import cycle. The constraint itself is real — migration 0008 adds
  // `reservations_ticket_fk` in SQL — it just cannot be said in Drizzle's own words.
  ticketId: text("ticket_id").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  releasedAt: ts("released_at"),
}, (t) => [
  index("reservations_open_idx").on(t.loc, t.itemKey).where(sql`released_at is null`),
  // Every handover and every cancellation releases by ticket id; without this that is a scan
  // over every hold ever placed.
  index("reservations_ticket_idx").on(t.ticketId).where(sql`released_at is null`),
  // A hold for nothing is not a hold.
  check("reservations_qty_ck", sql`${t.qty} > 0`),
]);

export const availabilityOverrides = pgTable("availability_overrides", {
  loc: text("loc").notNull().references(() => locations.key),
  itemKey: text("item_key").notNull().references(() => items.key),
  reason: text("reason").notNull(),
  byUser: text("by_user").references(() => users.id),
  at: ts("at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.loc, t.itemKey] })]);
