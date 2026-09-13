import type { Bill, Item, Location, PayerKind, User, UserMin } from "@rch/contract";
import type { billLines, bills, items, locations, users } from "../db/schema/index.js";
import { iso } from "./time.js";

/** Row -> wire mappers that more than one module needs (modules never import each other). */

/** A nullable column reads back as undefined; dropping the key keeps the object equal to the fixture it came from. */
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export type UserRow = typeof users.$inferSelect;
export const toWireUser = (u: UserRow): User => ({
  id: u.id, n: u.name, e: u.email, r: u.role, rl: u.roleLabel, loc: u.loc as User["loc"], col: u.colour, emp: u.empNo, ph: u.phone,
  admin: u.admin,
});
/** What one colleague sees of another: a name badge. Contact details are the caller's own,
 *  and travel only in their own record (`snapshot.user`). */
export const toWireUserMin = (u: UserRow): UserMin => ({
  id: u.id, n: u.name, r: u.role, rl: u.roleLabel, loc: u.loc as UserMin["loc"], col: u.colour,
});

export type ItemRow = typeof items.$inferSelect;
export const toWireItem = (r: ItemRow): Item => strip({
  c: r.code, n: r.name, u: r.unit, t: r.type, g: r.grp, hsn: r.hsn, gst: r.gst, rl: r.reorderLevel, cost: r.cost,
  mrp: r.mrp ?? undefined, sl: r.shelfLifeHours ?? undefined,
  // ---- item patch ----
  // Always on the wire, because `readItems` now carries retired lines too: a document raised
  // before the line was retired still names it, and the screen showing that document needs its
  // name. Every picker filters on this; the registry behind them does not.
  active: r.active,
});

export type LocationRow = typeof locations.$inferSelect;
export const toWireLocation = (r: LocationRow): Location => strip({
  n: r.name, c: r.code, type: r.type, floor: r.floor, cc: r.costCentre, list: r.priceList ?? undefined,
});

export type BillRow = typeof bills.$inferSelect;
export type BillLineRow = typeof billLines.$inferSelect;
/** The operator travels as a name and a colour, never an id: a bill is read on a screen, and
 *  the till that wrote it only ever shows as the badge beside the number. Lines arrive already
 *  in `line_no` order — the caller owns the query. */
export const toWireBill = (b: BillRow, lines: BillLineRow[], operator: { name: string; colour: string }): Bill => strip({
  no: b.no, loc: b.loc as Bill["loc"], opr: operator.name, oprCol: operator.colour,
  tot: b.total, tax: b.tax, t: iso(b.at), pay: b.tender as Bill["pay"],
  lines: lines.map((l) => ({ it: l.itemKey, qty: l.qty, rate: l.rate })),
  payer: b.payerKind ? { kind: b.payerKind, id: b.payerId ?? "", name: b.payerName ?? "" } : undefined,
  // ---- bill void. Both keys are dropped by `strip` on a bill nobody voided, which is nearly
  // every bill: a screen asks `if (b.voided)` and a fixture stays equal to what it was.
  voided: b.voidedAt ? true : undefined,
  voidReason: b.voidedAt ? b.voidReason ?? "" : undefined,
});

/** What the operator calls each kind of payer. One list, so the sentence the till says when the
 *  roster has never heard of a payer and the sentence the roster itself says when the manager
 *  patches one that is not there use the same word. Two modules read it — `pos` at the till and
 *  `payers` at the register — which is why it sits here rather than in either of them. */
export const PAYER_LABEL: Record<PayerKind, string> = { patient: "patient", staff: "staff member", dept: "department" };
