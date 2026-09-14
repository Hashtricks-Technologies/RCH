import { boolean, date, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { itemTypeEnum, locationTypeEnum, payerKindEnum, priceListEnum, roleEnum } from "./enums.js";

const qty = (name: string) => numeric(name, { precision: 12, scale: 3, mode: "number" });
const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export { qty, money, ts };

export const locations = pgTable("locations", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  type: locationTypeEnum("type").notNull(),
  floor: text("floor").notNull(),
  costCentre: text("cost_centre").notNull(),
  priceList: priceListEnum("price_list"),
  sellable: boolean("sellable").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  role: roleEnum("role").notNull(),
  roleLabel: text("role_label").notNull(),
  loc: text("loc").notNull().references(() => locations.key),
  colour: text("colour").notNull(),
  empNo: text("emp_no").notNull(),
  phone: text("phone").notNull(),
  passwordHash: text("password_hash").notNull(),
  mustChangePassword: boolean("must_change_password").notNull().default(true),
  active: boolean("active").notNull().default(true),
  // A capability, not a role: an ordinary account, with an ordinary role and location, that can
  // additionally reach the account-management page. Never granted or revoked over the wire —
  // only `pnpm --filter @rch/api users set-admin` flips it, so a compromised admin session can
  // never mint a second one. Default false: nobody has it unless a CLI explicitly said so.
  admin: boolean("admin").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("users_emp_no_uq").on(t.empNo)]);

// Insert-only as far as the code goes: nothing ever updates or deletes a row here. One line per
// admin write — create, reset-password, deactivate, reactivate, update_role_loc, delete — written
// in the same transaction as the change it records, so a refused write leaves no row behind
// either. The one change a row can see is Postgres's own: deleting an account sets `target_id`
// to null on the lines about it (`ON DELETE SET NULL`), which is why every line also carries
// `target_name`, the name as it stood when the line was written, for the log to fall back on.
export const adminActions = pgTable("admin_actions", {
  id: text("id").primaryKey(),
  at: ts("at").notNull().defaultNow(),
  actorId: text("actor_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  targetId: text("target_id").references(() => users.id, { onDelete: "set null" }),
  targetName: text("target_name").notNull(),
  details: jsonb("details").notNull().default({}),
});

export const items = pgTable("items", {
  key: text("key").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  unit: text("unit").notNull(),
  type: itemTypeEnum("type").notNull(),
  grp: text("grp").notNull(),
  hsn: text("hsn").notNull(),
  gst: numeric("gst", { precision: 5, scale: 2, mode: "number" }).notNull(),
  reorderLevel: qty("reorder_level").notNull().default(0),
  cost: money("cost").notNull().default(0),
  mrp: money("mrp"),
  shelfLifeHours: integer("shelf_life_hours"),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("items_name_ci_uq").on(sql`lower(${t.name})`)]);

export const recipes = pgTable("recipes", {
  itemKey: text("item_key").primaryKey().references(() => items.key),
  overheadPct: numeric("overhead_pct", { precision: 5, scale: 2, mode: "number" }).notNull(),
});
export const recipeLines = pgTable("recipe_lines", {
  itemKey: text("item_key").notNull().references(() => recipes.itemKey),
  ingredientKey: text("ingredient_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  seq: integer("seq").notNull(),
}, (t) => [primaryKey({ columns: [t.itemKey, t.ingredientKey] })]);

export const locationItems = pgTable("location_items", {
  loc: text("loc").notNull().references(() => locations.key),
  itemKey: text("item_key").notNull().references(() => items.key),
  seq: integer("seq").notNull(),
}, (t) => [primaryKey({ columns: [t.loc, t.itemKey] })]);

export const priceListItems = pgTable("price_list_items", {
  list: priceListEnum("list").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  price: money("price").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.list, t.itemKey] })]);

export const vendors = pgTable("vendors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  gstin: text("gstin").notNull().default(""),
  contact: text("contact").notNull().default(""),
  phone: text("phone").notNull().default(""),
  terms: text("terms").notNull().default(""),
  leadDays: integer("lead_days").notNull().default(0),
  groups: text("groups").array().notNull().default(sql`'{}'::text[]`),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("vendors_name_ci_uq").on(sql`lower(${t.name})`)]);

export const rateContracts = pgTable("rate_contracts", {
  id: text("id").primaryKey(),
  vendorId: text("vendor_id").notNull().references(() => vendors.id),
  itemKey: text("item_key").notNull().references(() => items.key),
  rate: money("rate").notNull(),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to").notNull(),
  moq: qty("moq").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  // One live contract per vendor and item. The store's screen checks before it inserts, but a
  // check reads before the insert takes its lock, so two store keepers adding the same contract
  // at once would both pass it. The index is the arbiter: `on conflict do nothing … returning`
  // hands the loser no row, and it reads the same refusal the check would have given it a
  // moment later — the pattern `addMenuItem` already uses.
  uniqueIndex("rate_contracts_live_uq").on(t.vendorId, t.itemKey).where(sql`${t.active}`),
]);

/**
 * Who a non-cash bill may be posted to: the patient, payroll and cost-centre rosters the live
 * system would look up, standing here until Phase 6 gives them their own masters. The till
 * sends a name along with the id, but the name on the bill is read from this row — a payer the
 * counter typed is a second account with its own untouched credit ceiling, so the id has to be
 * one the hospital already knows. Keyed by kind and id together, because the three rosters are
 * numbered independently and a staff number may read like a cost centre.
 */
export const payers = pgTable("payers", {
  kind: payerKindEnum("kind").notNull(),
  id: text("id").notNull(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  // ---- payers ----
  // The roster is written by people now, not only by the seed, so it carries the same two
  // stamps every other master table does: when the account was opened, and when it was last
  // renamed or switched off. Neither reaches the wire — `PayerRecordSchema` is the four fields
  // the register shows — but an administrator asking "when was this closed?" has to have
  // somewhere to look, and a CSV import that ran twice has to be tellable from one that did not.
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.kind, t.id] })]);
