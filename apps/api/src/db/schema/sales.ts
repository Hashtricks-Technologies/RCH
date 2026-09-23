import { foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { payerKindEnum } from "./enums.js";
import { items, locations, money, payers, qty, ts, users } from "./master.js";

/**
 * One outlet's register between two Z-reports.
 *
 * The business day is Z-to-Z, not midnight-to-midnight. That is the whole reason this table
 * exists: a calendar day cannot say which takings a given Z accounted for, and a timestamp window
 * (`at > previous_z`) cannot either - a sale whose transaction commits a moment after the close
 * would fall outside both Zs and be lost. A bill therefore *belongs* to a session by foreign key,
 * decided inside the sale's own transaction.
 *
 * The locking is the guarantee. A sale takes the open row `FOR SHARE`; the Z-close takes it
 * `FOR UPDATE`. So a sale already in flight commits before the close can count it, and one that
 * starts afterwards finds the session closed and opens the next - the same pairing `lib/locations.ts`
 * uses to close an outlet while sales are running.
 *
 * `closedTotals` is the Z as printed, stored rather than re-derived. Re-deriving it next week
 * against a changed set of bills would answer differently, which is the same reason a settlement's
 * allocation is stored (`apps/api/CLAUDE.md`). Nothing may alter a bill once its session is
 * closed - `voidBill` refuses - so the stored figures and the bills behind them can never drift.
 */
export const registerSessions = pgTable("register_sessions", {
  id: text("id").primaryKey(),
  loc: text("loc").notNull().references(() => locations.key),
  // Null until the Z is taken: an open session has no number, because the number *is* the Z.
  zNo: text("z_no"),
  openedAt: ts("opened_at").notNull().defaultNow(),
  // Null when the session opened itself on the first sale, which is the ordinary case.
  openedBy: text("opened_by").references(() => users.id),
  closedAt: ts("closed_at"),
  closedBy: text("closed_by").references(() => users.id),
  /** The Z as printed. Empty while the session is open. */
  closedTotals: jsonb("closed_totals"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  // At most one open session per outlet, enforced by the database rather than by a read: two
  // concurrent first-sales would otherwise each open one and split the day's takings in half.
  uniqueIndex("register_sessions_one_open_per_loc").on(t.loc).where(sql`${t.closedAt} is null`),
  uniqueIndex("register_sessions_z_no_uq").on(t.zNo),
  index("register_sessions_loc_closed_idx").on(t.loc, t.closedAt),
]);

/**
 * One operator's stint at one counter: opened when they sign in there, closed by Close Shift.
 *
 * A register session is the outlet's day (Z to Z); a shift is a person's hours inside it, so two
 * operators on one till each read only their own bills. `closedTotals` is the shift report as it
 * was handed over, stored for the same reason a Z's figures are.
 */
export const shifts = pgTable("shifts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  loc: text("loc").notNull().references(() => locations.key),
  openedAt: ts("opened_at").notNull().defaultNow(),
  closedAt: ts("closed_at"),
  closedTotals: jsonb("closed_totals"),
}, (t) => [
  // One open shift per person. Signing in at another counter closes the one left open there.
  uniqueIndex("shifts_one_open_per_user").on(t.userId).where(sql`${t.closedAt} is null`),
  index("shifts_loc_opened_idx").on(t.loc, t.openedAt),
]);

export const bills = pgTable("bills", {
  no: text("no").primaryKey(),
  loc: text("loc").notNull().references(() => locations.key),
  operatorId: text("operator_id").notNull().references(() => users.id),
  total: money("total").notNull(),
  tax: money("tax").notNull(),
  at: ts("at").notNull().defaultNow(),
  tender: text("tender").notNull(),
  // ---- the register. Which Z accounted for this bill. Nullable because every bill taken before
  // the register existed has no session and never will; those read as "before the register".
  sessionId: text("session_id").references(() => registerSessions.id),
  payerKind: payerKindEnum("payer_kind"),
  payerId: text("payer_id"),
  payerName: text("payer_name"),
  // ---- the walk-in customer, both optional: a name and a phone the counter may type on the bill.
  customerName: text("customer_name"),
  customerPhone: text("customer_phone"),
  // ---- the party discount. `total` above is unchanged and still means what it always did -
  // what the bill is worth and what is owed - so every sum in the system goes on reading the
  // same column. These two say how it got there: the rate that applied and the rupees it took
  // off. The gross is `total + discount`, derived rather than stored, because a third money
  // column is a third thing that can disagree with the other two. Both default to zero, so
  // every bill taken before this existed reads as the undiscounted bill it was.
  discountPct: numeric("discount_pct", { precision: 5, scale: 2, mode: "number" }).notNull().default(0),
  discount: money("discount").notNull().default(0),
  // ---- bill void. Three nullable columns rather than a status word, because a voided bill is
  // still a bill: its lines, its total and its tax stay exactly as they were printed, and what
  // changes is that reversing moves put the stock back and every sum that counts money skips it.
  // `voided_at` is the flag every one of those filters reads (`voided_at is null`).
  voidedAt: ts("voided_at"),
  voidedBy: text("voided_by").references(() => users.id),
  voidReason: text("void_reason"),
}, (t) => [
  index("bills_loc_at_idx").on(t.loc, t.at),
  // Every credit sale sums what its payer still owes, and the manager's receivables list does
  // the same for everybody at once; without this each of those is a sequential scan that grows
  // with the till's history. It replaced a narrower index partial on `payer_kind = 'staff'`,
  // which was right while staff credit was the only balance anybody could run up.
  index("bills_payer_idx").on(t.payerKind, t.payerId, t.at).where(sql`payer_kind is not null and voided_at is null`),
]);
export const billLines = pgTable("bill_lines", {
  billNo: text("bill_no").notNull().references(() => bills.no),
  lineNo: integer("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  // The printed price, before the party's discount. A bill has to show what the product costs
  // as well as what this person paid for it, and the concession is a figure on the head.
  rate: money("rate").notNull(),
}, (t) => [primaryKey({ columns: [t.billNo, t.lineNo] })]);

/**
 * What somebody paid against what they owe.
 *
 * A numbered document, because a payment nobody can name is a payment nobody can dispute, and
 * voidable on the day it was taken exactly as a bill is - badged, never erased, so a keying
 * mistake leaves a trail rather than a hole. `payer_name` is denormalised for the same reason a
 * bill's is: the register may be renamed, and this is what the receipt said at the time.
 */
export const settlements = pgTable("settlements", {
  id: text("id").primaryKey(),
  kind: payerKindEnum("kind").notNull(),
  payerId: text("payer_id").notNull(),
  payerName: text("payer_name").notNull(),
  amount: money("amount").notNull(),
  mode: text("mode").notNull(),
  note: text("note").notNull().default(""),
  at: ts("at").notNull().defaultNow(),
  by: text("by").notNull().references(() => users.id),
  voidedAt: ts("voided_at"),
  voidedBy: text("voided_by").references(() => users.id),
  voidReason: text("void_reason"),
}, (t) => [
  index("settlements_payer_idx").on(t.kind, t.payerId, t.at),
  foreignKey({ columns: [t.kind, t.payerId], foreignColumns: [payers.kind, payers.id], name: "settlements_payer_fk" }),
]);
/**
 * Which bills a settlement closed, and by how much.
 *
 * Stored rather than derived: the allocation is a decision the server made at one instant
 * against the bills open then (`allocateSettlement` in @rch/domain, oldest first), and
 * re-deriving it a week later against a different set of open bills would answer differently.
 * What a bill still owes is this table subtracted from the bill's own total, counting only the
 * settlements nobody voided.
 */
export const settlementLines = pgTable("settlement_lines", {
  settlementId: text("settlement_id").notNull().references(() => settlements.id),
  billNo: text("bill_no").notNull().references(() => bills.no),
  amount: money("amount").notNull(),
}, (t) => [
  primaryKey({ columns: [t.settlementId, t.billNo] }),
  index("settlement_lines_bill_idx").on(t.billNo),
]);
