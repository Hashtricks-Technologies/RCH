import { boolean, check, date, foreignKey, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { itemTypeEnum, locationTypeEnum, payerKindEnum, roleEnum, sourceEnum } from "./enums.js";

const qty = (name: string) => numeric(name, { precision: 12, scale: 3, mode: "number" });
const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export { qty, money, ts };

/** A named price list. `id` is server-issued (`allocateId(tx, "price_list")`, e.g. `"PL-006"`),
 *  the same way a vendor's id is - not a bare serial. Which outlets are active on it is never
 *  stored here: it is `locations.price_list_id` pointing back, read out by `pricelists.repo`. */
export const priceLists = pgTable("price_lists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const locations = pgTable("locations", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  type: locationTypeEnum("type").notNull(),
  floor: text("floor").notNull(),
  costCentre: text("cost_centre").notNull(),
  priceListId: text("price_list_id").references(() => priceLists.id, { onDelete: "restrict" }),
  sellable: boolean("sellable").notNull().default(false),
  // ---- outlets. Outlets are closed, never deleted: a closed one keeps its row, its menu and every
  // document that names it, and nothing new may name it (`lib/locations.ts`).
  active: boolean("active").notNull().default(true),
  /** How much of an item's reorder level one par covers here (`parFactor` in @rch/domain). */
  parFactor: numeric("par_factor", { precision: 4, scale: 2, mode: "number" }).notNull().default(0.18),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  // Every picker matches a location on its printed name, so two with one name would be one entry;
  // and the code is what the floor staff read off a label.
  uniqueIndex("locations_name_uq").on(sql`lower(${t.name})`),
  uniqueIndex("locations_code_uq").on(sql`upper(${t.code})`),
]);

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
  // additionally reach the account-management page. Never granted or revoked over the wire -
  // only `pnpm --filter @rch/api users set-admin` flips it, so a compromised admin session can
  // never mint a second one. Default false: nobody has it unless a CLI explicitly said so.
  admin: boolean("admin").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("users_emp_no_uq").on(t.empNo)]);

// Insert-only as far as the code goes: nothing ever updates or deletes a row here. One line per
// admin write - create, reset-password, deactivate, reactivate, update_role_loc, delete - written
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
  src: sourceEnum("src"),
  // ---- item photos ----
  /** sha256 (hex) of the item's photo in the image store; null when it has none. */
  image: text("image"),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("items_name_ci_uq").on(sql`lower(${t.name})`),
  check("items_image_sha256_ck", sql`${t.image} is null or ${t.image} ~ '^[0-9a-f]{64}$'`),
]);

export const locationItems = pgTable("location_items", {
  loc: text("loc").notNull().references(() => locations.key),
  itemKey: text("item_key").notNull().references(() => items.key),
  seq: integer("seq").notNull(),
}, (t) => [primaryKey({ columns: [t.loc, t.itemKey] })]);

export const priceListItems = pgTable("price_list_items", {
  // Deleting a price list (only ever allowed once no outlet is on it) takes its price sheet
  // with it - there is no reason to keep item->price rows for a list nothing can read any more.
  listId: text("list_id").notNull().references(() => priceLists.id, { onDelete: "cascade" }),
  itemKey: text("item_key").notNull().references(() => items.key),
  price: money("price").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.listId, t.itemKey] })]);

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
  // moment later - the pattern `addMenuItem` already uses.
  uniqueIndex("rate_contracts_live_uq").on(t.vendorId, t.itemKey).where(sql`${t.active}`),
]);

/**
 * Who a non-cash bill may be posted to: the patient, payroll and cost-centre rosters the live
 * system would look up, standing here until Phase 6 gives them their own masters. The till
 * sends a name along with the id, but the name on the bill is read from this row - a payer the
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
  // The roster is written by the CSV import, not only by the seed, so it carries the same two
  // stamps every other master table does: when the account was opened, and when it was last
  // renamed or switched off. Neither reaches the wire, but an administrator asking "when was
  // this closed?" has to have somewhere to look, and a CSV import that ran twice has to be
  // tellable from one that did not.
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.kind, t.id] })]);

/**
 * The rate card: what each party is charged, and how much of it they may owe at once.
 *
 * Two tables rather than one, because the two questions are genuinely different. A **category**
 * always has an answer - every consultant is on something, even if it is nothing - so this table
 * has exactly five rows and neither column is nullable except the ceiling, where `null` means
 * "no ceiling" rather than a ceiling of zero. A **person** usually has no answer at all, so that
 * table holds only the exceptions and `null` there means "inherit", which is a third state a
 * single merged table could not express.
 *
 * `cls` is plain text over `BillPartySchema` rather than `payer_kind`: a walk-in customer is not
 * a payer - they are the absence of one - and they still have a rate.
 */
export const payerClassTerms = pgTable("payer_class_terms", {
  cls: text("cls").primaryKey(),
  discountPct: numeric("discount_pct", { precision: 5, scale: 2, mode: "number" }).notNull().default(0),
  creditLimit: money("credit_limit"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by").references(() => users.id),
});
/** One person's exception to their category. Either column may be null, meaning "inherit" - a
 *  doctor on the category's discount but with a ceiling of their own is the common case. The
 *  foreign key is what stops an exception outliving the payer it is about. */
export const payerTerms = pgTable("payer_terms", {
  kind: payerKindEnum("kind").notNull(),
  payerId: text("payer_id").notNull(),
  discountPct: numeric("discount_pct", { precision: 5, scale: 2, mode: "number" }),
  creditLimit: money("credit_limit"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by").references(() => users.id),
}, (t) => [
  primaryKey({ columns: [t.kind, t.payerId] }),
  foreignKey({ columns: [t.kind, t.payerId], foreignColumns: [payers.kind, payers.id], name: "payer_terms_payer_fk" }),
]);
