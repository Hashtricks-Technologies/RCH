import type { Bill, Item, Location, PayerKind, User, UserMin } from "@rch/contract";
import { PARTY_LABEL } from "@rch/domain";
import type { billLines, bills, items, locations, users } from "../db/schema/index.js";
import type { RoleAccess } from "./access.js";
import { iso } from "./time.js";

/** Row -> wire mappers that more than one module needs (modules never import each other). */

/** A nullable column reads back as undefined; dropping the key keeps the object equal to the fixture it came from. */
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export type UserRow = typeof users.$inferSelect;
/** What an admin-flagged account is called wherever a role label would stand. Its `role`/`loc`
 *  columns are placeholders the schema needs and nothing acts on - its token reaches no
 *  operational route (`plugins/rbac.ts`) - so the label says what the account actually is. */
const SUPER_ADMIN_LABEL = "Super Admin";
/** A system account (`lib/system-users.ts`) acts for the server, never for a person or a role. */
const SYSTEM_LABEL = "System";
export const roleLabelOf = (u: Pick<UserRow, "admin" | "roleLabel" | "system">): string =>
  u.admin ? SUPER_ADMIN_LABEL : u.system ? SYSTEM_LABEL : u.roleLabel;
/** The caller's own record. `role` is what `loadAccess` (`lib/access.ts`) read for the account in
 *  the same breath - its role's id and permissions, which ride `/me`, sign-in, refresh and the
 *  snapshot so the browser draws the screens the server will answer. Both keys are absent for the
 *  super admin, which holds no role. `rl` is the role's name (`role_label`, kept equal to it). */
export const toWireUser = (u: UserRow, role: Pick<RoleAccess, "roleId" | "perms"> | null): User => ({
  id: u.id, n: u.name, e: u.email, r: u.role, rl: roleLabelOf(u), loc: u.loc as User["loc"], col: u.colour, emp: u.empNo, ph: u.phone,
  admin: u.admin,
  ...(role && !u.admin ? { rid: role.roleId, perms: role.perms } : {}),
});
/** What one colleague sees of another: a name badge. Contact details are the caller's own,
 *  and travel only in their own record (`snapshot.user`). */
export const toWireUserMin = (u: UserRow): UserMin => ({
  id: u.id, n: u.name, r: u.role, rl: roleLabelOf(u), loc: u.loc as UserMin["loc"], col: u.colour,
});

export type ItemRow = typeof items.$inferSelect;
export const toWireItem = (r: ItemRow): Item => strip({
  c: r.code, n: r.name, dn: r.displayName ?? undefined, u: r.unit, t: r.type, g: r.grp, hsn: r.hsn, gst: r.gst, rl: r.reorderLevel, cost: r.cost,
  mrp: r.mrp ?? undefined, sl: r.shelfLifeHours ?? undefined,
  // ---- item photos ----
  img: r.image ?? undefined,
  // ---- item patch ----
  // Always on the wire, because `readItems` now carries retired lines too: a document raised
  // before the line was retired still names it, and the screen showing that document needs its
  // name. Every picker filters on this; the registry behind them does not.
  active: r.active,
  src: r.src ?? undefined,
});

export type LocationRow = typeof locations.$inferSelect;
export const toWireLocation = (r: LocationRow): Location => strip({
  n: r.name, c: r.code, type: r.type, floor: r.floor, cc: r.costCentre, list: r.priceListId ?? undefined,
  active: r.active, par: r.parFactor,
});

export type BillRow = typeof bills.$inferSelect;
export type BillLineRow = typeof billLines.$inferSelect;
/** The operator travels as a name and a colour, never an id: a bill is read on a screen, and
 *  the till that wrote it only ever shows as the badge beside the number. Lines arrive already
 *  in `line_no` order - the caller owns the query. */
export const toWireBill = (b: BillRow, lines: BillLineRow[], operator: { name: string; colour: string }, refund?: Bill["refund"]): Bill => strip({
  no: b.no, loc: b.loc as Bill["loc"], opr: operator.name, oprCol: operator.colour,
  tot: b.total, tax: b.tax, t: iso(b.at), pay: b.tender as Bill["pay"],
  lines: lines.map((l) => ({ it: l.itemKey, qty: l.qty, rate: l.rate })),
  payer: b.payerKind ? { kind: b.payerKind, id: b.payerId ?? "", name: b.payerName ?? "" } : undefined,
  // ---- the party discount. Dropped by `strip` on a bill nobody discounted, so a wire bill is
  // byte for byte the bill it was before this existed. `tot` above is the net, as it always was.
  disc: b.discount > 0 ? b.discount : undefined,
  discPct: b.discount > 0 ? b.discountPct : undefined,
  // ---- bill void. Both keys are dropped by `strip` on a bill nobody voided, which is nearly
  // every bill: a screen asks `if (b.voided)` and a fixture stays equal to what it was.
  voided: b.voidedAt ? true : undefined,
  voidReason: b.voidedAt ? b.voidReason ?? "" : undefined,
  // ---- the walk-in customer. Dropped by `strip` where nobody typed one.
  customerName: b.customerName ?? undefined,
  customerPhone: b.customerPhone ?? undefined,
  // ---- QR ordering. Dropped by `strip` on a till's bill, so it stays byte for byte what it was.
  // `refund` is the money going back behind a voided QR bill, joined in by the caller that read
  // it (`readBills`, the void itself) - null on a QR bill with none, absent on a till's.
  src: b.source === "qr" ? "qr" : undefined,
  qo: b.qrOrderId ?? undefined,
  refund: b.source === "qr" ? refund ?? null : undefined,
});

/** A refund as the bill drawer prints it beside a voided QR bill: its pill, the rupees, and the
 *  gateway's last answer where a send failed. */
export const billRefundOf = (r: { id: string; status: NonNullable<Bill["refund"]>["status"]; amount: number; lastError: string | null }): NonNullable<Bill["refund"]> => ({
  id: r.id, status: r.status, amount: r.amount, ...(r.lastError ? { lastError: r.lastError } : {}),
});

/** What the operator calls each kind of payer. A thin view on `PARTY_LABEL` (`@rch/domain`),
 *  which has the same words plus the walk-in customer: the sentence the till says when the
 *  roster has never heard of somebody and the sentence the rate card says about the same
 *  somebody have to use the same word, and a word written twice drifts. */
export const PAYER_LABEL: Record<PayerKind, string> = {
  staff: PARTY_LABEL.staff, dept: PARTY_LABEL.dept, doctor: PARTY_LABEL.doctor,
};
