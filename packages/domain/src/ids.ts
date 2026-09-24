export type IdKind =
  | "req" | "tkt" | "bill" | "prq" | "po" | "prd" | "batch"
  | "vendor" | "contract" | "support" | "product_req" | "shop_ask"
  // ---- adjustments: a write-off or a count-up is a numbered document like any other.
  | "adj"
  // ---- the register: a Z-report closes an outlet's session and is a numbered document, because
  // the whole point of it is that the series is gapless - a missing Z number is a day nobody can
  // account for. One series hospital-wide; each Z names the outlet it closed.
  | "z_report"
  // ---- adjustment requests: the counter's ask, before the manager decides it and it becomes
  // (or does not become) an "adj" document of its own.
  | "adj_req"
  // ---- price lists: a named entity like a vendor, not a document series.
  | "price_list"
  // ---- settlements: what somebody paid against what they owe. A numbered document, because a
  // payment nobody can name is a payment nobody can dispute.
  | "settlement"
  // ---- shifts: one counter operator's stint at one counter, opened by their sign-in there and
  // closed by Close Shift. Numbered so the manager's list and a printed hand-over name the same one.
  | "shift"
  // ---- roles: a named set of permissions the super admin sets up, numbered like a vendor.
  | "role"
  // ---- QR ordering: a customer's order, numbered from the moment it is placed so the phone and
  // the counter name the same one; and a code the super admin places, numbered like a vendor.
  | "qr_order" | "qr_code";

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const ymd = (d: Date) => {
  // Calendar date in the hospital's zone, so a batch made at 00:30 IST is dated today, not yesterday.
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get("year")}${get("month")}${get("day")}`;
};
const year = (d: Date) => ymd(d).slice(0, 4);

/** Document numbers exactly as the frontend has always printed them. */
export function formatId(kind: IdKind, n: number, at: Date = new Date()): string {
  switch (kind) {
    case "req":         return `REQ-${year(at)}-0${n}`;
    case "tkt":         return `TKT-0${n}`;
    case "bill":        return `CF/${n}`;
    case "prq":         return `PRQ-${year(at)}-0${n}`;
    case "po":          return `PO-${year(at)}-0${n}`;
    case "prd":         return `PRD-${year(at)}-0${n}`;
    case "batch":       return `BAT-${ymd(at)}-${pad(n, 2)}`;
    case "vendor":      return `VN-${pad(n, 3)}`;
    case "contract":    return `RC-${n}`;
    case "support":     return `SUP-00${n}`;
    case "product_req": return `NPR-00${n}`;
    case "shop_ask":    return `ASK-0${n}`;
    // ---- adjustments. Padded to four rather than prefixed with a literal zero like `req`/`prq`:
    // the series starts at 1 and a bare `ADJ-2026-1` beside `ADJ-2026-10` sorts wrongly on every
    // screen that sorts a document list as text.
    case "adj":         return `ADJ-${year(at)}-${pad(n, 4)}`;
    // ---- adjustment requests. Same shape as `req`: the series starts low and a bare number
    // beside `req`'s own would not be told apart if it were not for the different prefix.
    case "adj_req":     return `ADJREQ-${year(at)}-0${n}`;
    case "price_list":  return `PL-${pad(n, 3)}`;
    // ---- settlements. Padded to four for the same reason `adj` is: the series starts at one,
    // and `STL-2026-1` sorting beside `STL-2026-10` reads wrongly on every list that sorts as text.
    case "settlement":  return `STL-${year(at)}-${pad(n, 4)}`;
    // ---- the register. Padded to four like `adj` and `settlement`, and carrying the year, so a
    // Z number read out over the phone says which year's books it belongs to.
    case "z_report":    return `Z-${year(at)}-${pad(n, 4)}`;
    // ---- shifts. Padded to four for the same reason as `adj`.
    case "shift":       return `SH-${year(at)}-${pad(n, 4)}`;
    case "role":        return `ROLE-${pad(n, 3)}`;
    // ---- QR ordering. The order padded to four for the same reason as `adj`.
    case "qr_order":    return `QO-${year(at)}-${pad(n, 4)}`;
    case "qr_code":     return `QR-${pad(n, 3)}`;
  }
}

/**
 * A goods receipt's number, derived from the order it books in against rather than drawn from a
 * sequence: `GRN-<yy><po number>-<nn>`, so the second instalment against `PO-2026-0143` is
 * `GRN-260143-02`.
 *
 * The original design said `GRN-<last 3 of PO>-<nn>`, which collides - `PO-2026-0143` and `PO-2027-0143`
 * share a three-character tail, and so do `PO-2026-0143` and `PO-2026-1143`. `grns.id` is a
 * primary key, so the collision surfaced as a failed insert in the middle of a receipt: a 500 at
 * the receiving door, not a duplicate number somebody notices later. Widening the tail to the
 * year's last two digits plus the whole order number makes it unique for as long as PO numbers
 * are unique within a year, which they are (`sequences`).
 */
export function grnId(poId: string, instalment: number): string {
  // "PO-2026-0143" -> ["PO", "2026", "0143"]. Anything that is not that shape falls back to the
  // whole id with its separators stripped, so a hand-corrected order still gets a usable number
  // rather than a silently truncated one.
  const parts = poId.split("-");
  const tail = parts.length === 3 ? `${parts[1].slice(2)}${parts[2]}` : poId.replace(/[^A-Za-z0-9]/g, "");
  return `GRN-${tail}-${pad(instalment, 2)}`;
}

const EMP_NO = /^RC-(\d+)$/;

/**
 * The employee number a new account is given: one past the highest `RC-<digits>` already on
 * `users`, padded to at least four digits (`RC-0001` → `RC-0002`, `RC-4482` → `RC-4483`). An
 * account whose number is not that shape - typed by hand through the users CLI - is skipped
 * rather than parsed. Not a `sequences` series: the number follows whatever accounts exist, so
 * the number a deleted account (never used, by rule) was holding is given out again.
 *
 * The server calls this under the create's own lock and the account page calls it to preview
 * the same number, so the two cannot disagree about which one is next.
 */
export function nextEmpNo(existing: readonly string[]): string {
  let max = 0;
  let width = 4;
  for (const e of existing) {
    const m = EMP_NO.exec(e);
    if (!m) continue;
    max = Math.max(max, Number(m[1]));
    width = Math.max(width, m[1].length);
  }
  return `RC-${pad(max + 1, width)}`;
}

/** The first number each series issues, continuing the seeded documents.
 *  Mirrors the UI store's `seq` and the lengths the ops slice counts from. */
export const SEQUENCE_START: Record<IdKind, number> = {
  req: 913, tkt: 441, bill: 1188, prq: 16, po: 143, prd: 31, batch: 1,
  vendor: 6, contract: 109, support: 44, product_req: 13, shop_ask: 63,
  // ---- adjustments: nothing was ever written off through a document before, so the series
  // starts at one rather than continuing a seeded run.
  adj: 1,
  // ---- adjustment requests: likewise nothing to continue.
  adj_req: 1,
  // ---- price lists: two seeded lists (the old A and B), so the series continues past them.
  price_list: 3,
  // ---- settlements: nothing was ever settled before, so the series starts at one.
  settlement: 1,
  // ---- the register: no day has ever been closed in this system, so the series starts at one.
  z_report: 1,
  // ---- shifts: nobody has ever closed one, so the series starts at one.
  shift: 1,
  // ---- roles: the five seeded roles are ROLE-001 to ROLE-005, so the series continues past them.
  role: 6,
  // ---- QR ordering: no order was ever placed and no code ever printed, so both start at one.
  qr_order: 1,
  qr_code: 1,
};
