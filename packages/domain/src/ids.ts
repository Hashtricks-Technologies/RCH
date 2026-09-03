export type IdKind =
  | "req" | "tkt" | "bill" | "prq" | "po" | "prd" | "batch"
  | "vendor" | "contract" | "support" | "product_req" | "shop_ask";

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const ymd = (d: Date) => {
  // Calendar date in the hospital's zone, so a batch made at 00:30 IST is dated today, not yesterday.
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get("year")}${get("month")}${get("day")}`;
};
const year = (d: Date) => ymd(d).slice(0, 4);

/** Document numbers exactly as the frontend has always printed them (spec §7.3). */
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
  }
}

/** The first number each series issues, continuing the seeded documents.
 *  Mirrors the UI store's `seq` and the lengths the ops slice counts from. */
export const SEQUENCE_START: Record<IdKind, number> = {
  req: 913, tkt: 441, bill: 1188, prq: 16, po: 143, prd: 31, batch: 1,
  vendor: 6, contract: 109, support: 44, product_req: 13, shop_ask: 63,
};
