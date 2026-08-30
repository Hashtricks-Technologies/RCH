export type ItemType = "RAW" | "PACK" | "MRP" | "FG" | "MTO";
export type LocKey = "store" | "kitchen" | "rest" | "coffee" | "kiosk" | "procure";
export type Role = "counter" | "manager" | "store" | "prod" | "buyer";
export type ReqStatus =
  | "Draft" | "Request sent" | "Manager approved" | "Partially approved"
  | "Ticket issued" | "Collected" | "Received" | "Closed" | "Rejected" | "Cancelled";
export type TktStatus = "Issued" | "Collected" | "Received";
export type PrqStatus = "Sent" | "Approved" | "Partially approved" | "Declined";
export type PordStatus = "New" | "Accepted" | "In kitchen" | "Ready" | "Dispatched" | "Declined";
export type Tone = "ok" | "wn" | "cr" | "in" | "ac" | "mu";

export interface Item {
  c: string; n: string; u: string; t: ItemType; g: string;
  hsn: string; gst: number; rl: number; cost: number; mrp?: number; sl?: number;
}
export interface Location {
  n: string; c: string; type: "Store" | "Kitchen" | "Outlet";
  floor: string; cc: string; list?: "A" | "B";
}
export interface User {
  id: string; n: string; e: string; r: Role; rl: string;
  loc: LocKey; col: string; emp: string; ph: string;
}
export interface Recipe { ov: number; l: [string, number][] }
export interface ReqLine { it: string; qty: number; appr: number; short?: number }
export interface HistEntry { s: string; who: string; t: string }
export interface StockRequest {
  id: string; from: LocKey; by: string; at: string;
  lines: ReqLine[]; st: ReqStatus; ticket: string | null;
  mgrNote: string; urg?: boolean; hist: HistEntry[]; apprBy?: string;
}
export interface TktLine { it: string; qty: number }
export interface Ticket {
  id: string; req: string; from: LocKey; to: LocKey;
  lines: TktLine[]; st: TktStatus;
  /** Six digits quoted at handover in place of a scanned code. */
  otp: string;
}
export interface PrqLine { it: string; qty: number; appr: number; ordered: number; short?: number }
export interface Requisition {
  id: string; by: string; at: string;
  lines: PrqLine[]; st: PrqStatus; note: string;
  apprBy?: string; apprNote?: string; hist: HistEntry[];
}
export interface PoLineSrc { prq: string; line: number; qty: number }
export interface PoLine {
  it: string; qty: number; rate: number;
  src: PoLineSrc[];
  recv: number; rejected: number;
}
export type PoStatus = "Draft" | "Ordered" | "Partially received" | "Received" | "Cancelled";
export interface PurchaseOrder {
  id: string; vendor: string; at: string;
  lines: PoLine[]; st: PoStatus; eta: string;
  needsApproval?: boolean; shortNote?: string; recv?: string;
  hist: HistEntry[];
}
export interface ProdOrder {
  id: string; from: LocKey; by: string; at: string;
  lines: TktLine[]; st: PordStatus; note: string; hist: HistEntry[];
}
export interface Batch {
  id: string; it: string; qty: number; made: number; at: string; bb: string; note?: string;
}
export type PayerKind = "patient" | "staff" | "dept";
export interface Payer { kind: PayerKind; id: string; name: string }
/** What a store keeper recorded when the goods actually landed. */
export interface ReceiptLine {
  recv: number; batch: string; mrp: number; mfg: string; exp: string; rejected: number;
}
/** The vendor's paperwork behind one instalment of a delivery. */
export interface ReceiptDoc {
  dc: string; invoice: string; invDate: string;
}
export interface Grn {
  id: string; po: string; it: string; qty: number; rejected: number;
  batch: string; mrp: number; mfg: string; exp: string;
  dc: string; invoice: string; invDate: string;
  at: string; by: string;
}
export interface BillLine { it: string; qty: number; rate: number }
export interface Bill {
  no: string; loc: LocKey; opr: string; oprCol: string;
  tot: number; tax: number; t: string; pay: string; lines: BillLine[]; payer?: Payer;
}
export interface DraftLine { it: string; qty: number }
export interface Availability { ok: boolean; mode: "Manual" | "Recipe" | "Stock"; why?: string; left?: string }
export interface Price { p: number; listed: number; capped: boolean }
export interface DrawerState { t: string; id: string }
export interface Vendor {
  id: string; n: string; gstin: string; contact: string; ph: string;
  terms: string; lead: number; groups: string[]; active: boolean;
}

export type IssueKind = "Stock" | "Equipment" | "Quality" | "System" | "Other";
export type IssuePriority = "Low" | "Normal" | "High";
export type IssueStatus = "Open" | "Acknowledged" | "Resolved" | "Closed";
export interface Issue {
  id: string; kind: IssueKind; title: string; detail: string;
  priority: IssuePriority; st: IssueStatus;
  by: string; role: Role; loc: LocKey; at: string;
  hist: HistEntry[];
}
export interface RateContract {
  id: string; vendor: string; it: string; rate: number;
  from: string; to: string; moq: number; active: boolean;
}

export type ShopAskStatus = "Asked" | "Sent" | "Declined";
/** One shop asking another for stock it is holding. The manager sees it; it never routes through them. */
export interface ShopAsk {
  id: string; from: LocKey; to: LocKey; it: string; qty: number;
  st: ShopAskStatus; by: string; at: string; note: string;
  grant?: number; ticket?: string; reason?: string;
}
