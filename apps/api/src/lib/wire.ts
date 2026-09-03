import type { Bill, Item, Location, User, UserMin } from "@rch/contract";
import type { billLines, bills, items, locations, users } from "../db/schema/index.js";
import { iso } from "./time.js";

/** Row -> wire mappers that more than one module needs (modules never import each other). */

/** A nullable column reads back as undefined; dropping the key keeps the object equal to the fixture it came from. */
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export type UserRow = typeof users.$inferSelect;
export const toWireUser = (u: UserRow): User => ({
  id: u.id, n: u.name, e: u.email, r: u.role, rl: u.roleLabel, loc: u.loc as User["loc"], col: u.colour, emp: u.empNo, ph: u.phone,
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
  tot: b.total, tax: b.tax, t: iso(b.at), pay: b.tender,
  lines: lines.map((l) => ({ it: l.itemKey, qty: l.qty, rate: l.rate })),
  payer: b.payerKind ? { kind: b.payerKind, id: b.payerId ?? "", name: b.payerName ?? "" } : undefined,
});
