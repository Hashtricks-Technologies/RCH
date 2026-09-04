import { boolean, date, integer, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("users_emp_no_uq").on(t.empNo)]);

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
});

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
}, (t) => [primaryKey({ columns: [t.kind, t.id] })]);
