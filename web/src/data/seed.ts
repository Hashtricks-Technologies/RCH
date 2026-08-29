import type { Bill, Batch, LocKey, ProdOrder, PurchaseOrder, Requisition, StockRequest, Ticket } from "../types";

export const seedStock: Record<LocKey, Record<string, number>> = {
  store:   { milk: 12, beans: 18.4, leaf: 3.2, sugar: 40, maida: 48.5, oil: 30, fill: 12, butter: 4, bread: 20, cup: 2400, box: 820, juice: 156, water: 120, bisc: 60, chips: 88 },
  procure: {},
  kitchen: { maida: 8, oil: 4, fill: 3, butter: 1.2, bread: 6, cup: 200, box: 120, milk: 6, sugar: 4, puff: 24, sand: 8, salad: 5 },
  rest:    { milk: 14, beans: 2, leaf: 0.6, sugar: 3, cup: 220, box: 60, juice: 20, water: 30, chips: 12, puff: 12, sand: 6, salad: 4 },
  coffee:  { milk: 0, beans: 1.2, leaf: 0.4, sugar: 2, cup: 180, juice: 8, water: 12, bisc: 6, chips: 9 },
  kiosk:   { juice: 14, water: 22, bisc: 9, chips: 16, puff: 8 },
};

export const seedReq: StockRequest[] = [
  { id: "REQ-2026-0909", from: "coffee", by: "Kavitha Raman", at: "08:05",
    lines: [{ it: "cup", qty: 600, appr: 500 }], st: "Ticket issued", ticket: "TKT-0440",
    mgrNote: "Trimmed to 500, store stock is tight.",
    hist: [{ s: "Request sent", who: "Kavitha Raman", t: "08:05" }, { s: "Manager approved", who: "Ramesh Kumar", t: "08:20" }, { s: "Ticket issued", who: "Suresh Muthu", t: "08:34" }] },
  { id: "REQ-2026-0910", from: "rest", by: "Ramesh Kumar", at: "08:40",
    lines: [{ it: "sugar", qty: 5, appr: 5 }, { it: "butter", qty: 1, appr: 1 }], st: "Manager approved", ticket: null,
    mgrNote: "Approved in full.",
    hist: [{ s: "Request sent", who: "Ramesh Kumar", t: "08:40" }, { s: "Manager approved", who: "Ramesh Kumar", t: "08:44" }] },
  { id: "REQ-2026-0911", from: "coffee", by: "Kavitha Raman", at: "09:14",
    lines: [{ it: "milk", qty: 20, appr: 0 }], st: "Request sent", ticket: null, mgrNote: "", urg: true,
    hist: [{ s: "Request sent", who: "Kavitha Raman", t: "09:14" }] },
  { id: "REQ-2026-0912", from: "kiosk", by: "Deepa Selvam", at: "09:26",
    lines: [{ it: "juice", qty: 24, appr: 0 }, { it: "water", qty: 12, appr: 0 }, { it: "bisc", qty: 18, appr: 0 }],
    st: "Request sent", ticket: null, mgrNote: "",
    hist: [{ s: "Request sent", who: "Deepa Selvam", t: "09:26" }] },
];

export const seedTkt: Ticket[] = [
  { id: "TKT-0440", req: "REQ-2026-0909", from: "store", to: "coffee", lines: [{ it: "cup", qty: 500 }], st: "Issued" },
];
export const seedPrq: Requisition[] = [
  { id: "PRQ-2026-013", by: "Suresh Muthu", at: "07:50", lines: [{ it: "milk", qty: 60 }, { it: "butter", qty: 6 }],
    st: "Sent", note: "Milk at zero in the coffee shop, store has 12 L left." },
];
export const seedPo: PurchaseOrder[] = [];
export const seedPord: ProdOrder[] = [
  { id: "PRD-2026-029", from: "rest", by: "Ramesh Kumar", at: "07:10", lines: [{ it: "puff", qty: 40 }],
    st: "New", note: "Lunch rush.", hist: [{ s: "New", who: "Ramesh Kumar", t: "07:10" }] },
  { id: "PRD-2026-030", from: "rest", by: "Ramesh Kumar", at: "07:35", lines: [{ it: "sand", qty: 20 }, { it: "salad", qty: 10 }],
    st: "Accepted", note: "", hist: [{ s: "New", who: "Ramesh Kumar", t: "07:35" }, { s: "Accepted", who: "Vinoth Prakash", t: "07:41" }] },
];
export const seedBatch: Batch[] = [
  { id: "BAT-20260826-01", it: "puff", qty: 120, made: 116, at: "06:40", bb: "21:30" },
];
export const seedBills: Bill[] = [
  { no: "CF/1187", loc: "coffee", opr: "Kavitha Raman", oprCol: "#B45309", tot: 110, tax: 13.15, t: "09:02", pay: "UPI",
    lines: [{ it: "juice", qty: 2, rate: 20 }, { it: "chips", qty: 2, rate: 20 }, { it: "bisc", qty: 1, rate: 30 }] },
  { no: "CF/1186", loc: "rest", opr: "Ramesh Kumar", oprCol: "#7C3AED", tot: 155, tax: 7.38, t: "08:48", pay: "Cash",
    lines: [{ it: "puff", qty: 2, rate: 25 }, { it: "sand", qty: 1, rate: 45 }, { it: "capp", qty: 1, rate: 60 }] },
  { no: "CF/1185", loc: "kiosk", opr: "Deepa Selvam", oprCol: "#475569", tot: 82, tax: 11.69, t: "08:31", pay: "Cash",
    lines: [{ it: "water", qty: 2, rate: 18 }, { it: "chips", qty: 1, rate: 18 }, { it: "bisc", qty: 1, rate: 28 }] },
  { no: "CF/1184", loc: "coffee", opr: "Kavitha Raman", oprCol: "#B45309", tot: 90, tax: 6.67, t: "08:12", pay: "Card",
    lines: [{ it: "chai", qty: 2, rate: 25 }, { it: "juice", qty: 1, rate: 20 }, { it: "chips", qty: 1, rate: 20 }] },
  { no: "CF/1183", loc: "rest", opr: "Ramesh Kumar", oprCol: "#7C3AED", tot: 185, tax: 8.81, t: "07:55", pay: "Cash",
    lines: [{ it: "salad", qty: 1, rate: 55 }, { it: "sand", qty: 2, rate: 45 }, { it: "chai", qty: 2, rate: 20 }] },
];
export const seedSales: number[][] = [
  [4120, 3860, 5210], [4480, 4010, 5580], [3920, 3640, 4980], [4760, 4290, 6010], [5240, 4680, 6420],
  [6180, 5120, 7240], [5860, 4940, 6880], [4310, 3980, 5320], [4620, 4180, 5760], [4980, 4460, 6120],
  [5310, 4720, 6480], [6420, 5380, 7510], [6180, 5240, 7180], [5720, 4860, 6640],
];
export const DAY_LABELS = ["12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25"];

/**
 * A ticket that is already issued has stock committed against it, so the
 * reservation ledger must start populated or those units look free (C5).
 */
export const seedRsv = (): Record<string, number> => {
  const rsv: Record<string, number> = {};
  seedTkt
    .filter((t) => t.st === "Issued")
    .forEach((t) => t.lines.forEach((l) => {
      rsv[t.from + ":" + l.it] = (rsv[t.from + ":" + l.it] ?? 0) + l.qty;
    }));
  return rsv;
};
