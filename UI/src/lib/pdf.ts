import type { jsPDF } from "jspdf";
import { IT } from "../data/master";
import type { Dated, DatedDoc, Grn, HistEntry, PurchaseOrder, Ticket, Trailed, Vendor } from "../types";
import { U, fq, fromWireDate, fromWireDay, money, unitTotal } from "./fmt";
import { locName, round3 } from "./selectors";

/**
 * The two documents the app hands over as files: a collection ticket's receipt and a goods
 * receipt note. Each is built as a plain model first - the ticket's is also what the printed
 * slip draws, so paper and PDF cannot say different things - and only then drawn with jsPDF,
 * which is imported at the press rather than at load: it is a few hundred KB nobody at a till
 * needs until they ask for a file.
 */

const HOSPITAL = "Royal Care Hospital";

/** jsPDF's built-in fonts are WinAnsi and carry no rupee sign, which prints as a stray glyph. */
const pdfText = (s: string) => s.replace(/₹/g, "Rs. ").replace(/→/g, "->");

type Stamped = HistEntry & Partial<Pick<Dated<HistEntry>, "iso">>;
/** A trail entry as a day and a clock, when it carries the instant to read the day from. */
const stampOf = (h: Stamped | undefined): string =>
  !h ? "" : `${h.iso ? fromWireDay(h.iso) + " " : ""}${h.t} · ${h.who}`;

// ---- the ticket receipt ----------------------------------------------------------------------

export interface TicketReceipt {
  id: string;
  from: string;
  to: string;
  req: string;
  st: string;
  issued: string;
  collected: string;
  received: string;
  lines: { name: string; code: string; qty: string; unit: string }[];
  total: string;
  /** The six digits, or `null` when they are not on this copy. */
  otp: string | null;
}

/**
 * A ticket as its receipt reads. `withOtp` only ever adds digits this browser actually has:
 * the server sends the code to the collecting location's screen and `""` to everyone else.
 */
export function ticketReceipt(t: Ticket | Trailed<Ticket>, withOtp: boolean): TicketReceipt {
  const hist = t.hist as Stamped[];
  return {
    id: t.id,
    from: locName(t.from),
    to: locName(t.to),
    req: t.req,
    st: t.st,
    issued: stampOf(hist.find((h) => h.s === "Issued") ?? hist[0]),
    collected: stampOf(hist.find((h) => h.s.startsWith("Handed over"))),
    received: stampOf(hist.find((h) => h.s === "Received")),
    lines: t.lines.map((l) => ({ name: IT[l.it]?.n ?? l.it, code: IT[l.it]?.c ?? "", qty: fq(l.qty, l.it), unit: U(l.it) })),
    total: unitTotal(t.lines),
    otp: withOtp && t.otp ? t.otp : null,
  };
}

const MM_PER_PT = 25.4 / 72;
/** One line of `size`-point text, in millimetres, at jsPDF's default 1.15 line height. */
const lh = (size: number) => size * MM_PER_PT * 1.15;

/** Draws the receipt down an 80 mm roll and answers where it ended, so the page can be cut to it. */
function drawReceipt(doc: jsPDF, r: TicketReceipt): number {
  const L = 5, R = 75, W = R - L;
  let y = 8;
  const put = (s: string, size: number, opts: { bold?: boolean; align?: "center" | "right"; x?: number; width?: number } = {}) => {
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(size);
    const rows: string[] = doc.splitTextToSize(pdfText(s), opts.width ?? W);
    const x = opts.x ?? (opts.align === "center" ? 40 : opts.align === "right" ? R : L);
    doc.text(rows, x, y, { align: opts.align ?? "left", baseline: "top" });
    return rows.length * lh(size);
  };
  const rule = (gap = 2) => { y += gap; doc.setLineWidth(0.2); doc.line(L, y, R, y); y += gap; };
  const pair = (k: string, v: string) => {
    if (!v) return;
    const h = Math.max(put(k, 8, { width: 22 }), put(v, 8, { x: L + 23, width: W - 23 }));
    y += h + 0.6;
  };

  y += put(HOSPITAL, 11, { bold: true, align: "center" });
  y += put("Stock collection ticket", 8, { align: "center" }) + 1;
  rule();
  y += put(r.id, 14, { bold: true, align: "center" }) + 1;
  y += put(`${r.from} → ${r.to}`, 9, { bold: true, align: "center" }) + 1;
  rule();
  pair("Against", r.req);
  pair("Status", r.st);
  pair("Issued", r.issued);
  pair("Collected", r.collected);
  pair("Received", r.received);
  rule();
  y += Math.max(put("Item", 8, { bold: true }), put("Qty", 8, { bold: true, align: "right" }));
  rule(1);
  if (r.lines.length === 0) {
    y += put("No item on this ticket - nothing is to be collected against it.", 8) + 1;
  }
  for (const l of r.lines) {
    const q = `${l.qty} ${l.unit}`;
    const h = Math.max(put(l.name, 8.5, { width: W - 24 }), put(q, 8.5, { bold: true, align: "right" }));
    y += h;
    if (l.code) y += put(l.code, 7);
    y += 1.2;
  }
  rule(1);
  y += Math.max(put("Total", 8.5, { bold: true }), put(r.total, 8.5, { bold: true, align: "right", x: R, width: W - 14 })) + 1;
  rule();
  if (r.otp) {
    y += put("Collection OTP", 8, { align: "center" });
    y += put(r.otp.split("").join(" "), 22, { bold: true, align: "center" }) + 1;
    y += put("Read out at the window. Keep this slip out of sight.", 7, { align: "center" }) + 1;
  } else {
    y += put("OTP - the collector reads the code out at the window.", 8, { align: "center" }) + 1;
  }
  rule();
  y += 10;
  y += put("Received by ________________________", 8);
  y += 4;
  y += put("Name / Emp no. _____________________", 8);
  return y + 6;
}

const saveAs = (doc: jsPDF, name: string) => doc.save(name.replace(/[^\w.-]+/g, "-"));

/** The receipt as `<ticket>.pdf`: one 80 mm page, as long as the ticket needs. */
export async function downloadTicketPdf(t: Ticket | Trailed<Ticket>, withOtp: boolean): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const r = ticketReceipt(t, withOtp);
  const height = drawReceipt(new jsPDF({ unit: "mm", format: [80, 2000] }), r);
  const doc = new jsPDF({ unit: "mm", format: [80, Math.max(height, 100)] });
  doc.setProperties({ title: `${r.id} - collection ticket`, creator: HOSPITAL });
  drawReceipt(doc, r);
  saveAs(doc, `${r.id}.pdf`);
}

// ---- the goods receipt note ------------------------------------------------------------------

/** One delivery booked in: every GRN row a single receipt wrote shares its instant and its note. */
export interface GrnInstalment {
  key: string;
  ids: string[];
  rows: Dated<Grn>[];
}

/** The order's receipts, one entry per delivery, oldest first. */
export function grnInstalments(grns: Dated<Grn>[]): GrnInstalment[] {
  const by = new Map<string, Dated<Grn>[]>();
  for (const g of [...grns].sort((a, b) => a.iso.localeCompare(b.iso) || a.id.localeCompare(b.id))) {
    const k = `${g.iso}|${g.dc}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(g);
  }
  return [...by.entries()].map(([key, rows]) => ({ key, ids: rows.map((g) => g.id), rows }));
}

export interface GrnReportLine {
  grn: string;
  item: string;
  code: string;
  unit: string;
  ordered: string;
  receivedNow: string;
  rejected: string;
  accepted: string;
  toDate: string;
  pending: string;
  rate: string;
  value: string;
  batch: string;
  mfgExp: string;
}

export interface GrnReport {
  file: string;
  title: string;
  po: string;
  poStatus: string;
  vendor: { name: string; gstin: string };
  deliveries: { grns: string; dc: string; invoice: string; invDate: string; by: string; at: string }[];
  lines: GrnReportLine[];
  valueReceived: string;
  valueAccepted: string;
  rejectedTotal: string;
  pending: string;
  status: string;
}

/**
 * A goods receipt note: one delivery (`only`) or every delivery on the order.
 *
 * "To date" and "pending" are read as of each row - what the order had accepted once that
 * delivery was in - so a GRN printed next month still says what it said the day it was booked.
 * A rejected quantity went to quarantine and is still owed, so it never counts as accepted.
 */
export function grnReport(po: DatedDoc<PurchaseOrder>, grns: Dated<Grn>[], vendors: Vendor[], only?: string): GrnReport {
  const all = grnInstalments(grns.filter((g) => g.po === po.id));
  const scope = only ? all.filter((d) => d.key === only) : all;
  const rows = scope.flatMap((d) => d.rows);
  const vendor = vendors.find((v) => v.id === po.vendor);
  const orderedOf = (it: string) => po.lines.filter((l) => l.it === it).reduce((t, l) => t + l.qty, 0);
  const rateOf = (it: string) => po.lines.find((l) => l.it === it)?.rate ?? 0;
  const flat = all.flatMap((d) => d.rows);
  const acceptedBy = (it: string, iso: string) =>
    round3(flat.filter((g) => g.it === it && g.iso <= iso).reduce((t, g) => t + g.qty, 0));
  const asOf = rows.length ? rows[rows.length - 1].iso : "";
  const pendingLines = [...new Set(po.lines.map((l) => l.it))].map((it) => ({
    it, qty: Math.max(0, round3(orderedOf(it) - acceptedBy(it, asOf))),
  }));
  const allIn = pendingLines.every((l) => l.qty <= 0);

  const lines = rows.map((g): GrnReportLine => {
    const toDate = acceptedBy(g.it, g.iso);
    const rate = rateOf(g.it);
    return {
      grn: g.id,
      item: IT[g.it]?.n ?? g.it,
      code: IT[g.it]?.c ?? "",
      unit: U(g.it),
      ordered: fq(orderedOf(g.it), g.it),
      receivedNow: fq(round3(g.qty + g.rejected), g.it),
      rejected: fq(g.rejected, g.it),
      accepted: fq(g.qty, g.it),
      toDate: fq(toDate, g.it),
      pending: fq(Math.max(0, round3(orderedOf(g.it) - toDate)), g.it),
      rate: money(rate),
      value: money(g.qty * rate),
      batch: g.batch,
      mfgExp: [g.mfg ? fromWireDate(g.mfg) : "-", g.exp ? fromWireDate(g.exp) : "-"].join(" / "),
    };
  });

  const status = only
    ? allIn ? "Received" : "Partially received"
    : po.st === "Received" && po.shortNote ? `Received - closed short: ${po.shortNote}` : po.st;
  const one = only ? scope[0] : undefined;
  return {
    file: one ? `${one.ids[0]}.pdf` : `GRN-${po.id}.pdf`,
    title: one ? `Goods Receipt Note ${one.ids.length > 1 ? `${one.ids[0]} to ${one.ids[one.ids.length - 1]}` : one.ids[0]}` : `Goods Receipt Notes - ${po.id}`,
    po: po.id,
    poStatus: po.st,
    vendor: { name: vendor?.n ?? "Unknown vendor", gstin: vendor?.gstin ?? "" },
    deliveries: scope.map((d) => {
      const g = d.rows[0];
      return {
        grns: d.ids.join(", "),
        dc: g.dc,
        invoice: g.invoice,
        invDate: g.invDate ? fromWireDate(g.invDate) : "",
        by: g.by,
        at: `${fromWireDay(g.iso)} ${g.at}`,
      };
    }),
    lines,
    valueReceived: money(rows.reduce((t, g) => t + (g.qty + g.rejected) * rateOf(g.it), 0)),
    valueAccepted: money(rows.reduce((t, g) => t + g.qty * rateOf(g.it), 0)),
    rejectedTotal: unitTotal(rows.filter((g) => g.rejected > 0).map((g) => ({ it: g.it, qty: g.rejected }))),
    pending: allIn ? "Nothing pending" : unitTotal(pendingLines.filter((l) => l.qty > 0)),
    status,
  };
}

/** The report as an A4 landscape PDF, named after the GRN (one delivery) or the order (all). */
export async function downloadGrnPdf(po: DatedDoc<PurchaseOrder>, grns: Dated<Grn>[], vendors: Vendor[], only?: string): Promise<void> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const r = grnReport(po, grns, vendors, only);
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" });
  const L = 12, R = 285;
  let y = 14;
  doc.setProperties({ title: r.title, creator: HOSPITAL });

  doc.setFont("helvetica", "bold").setFontSize(15).text(HOSPITAL, L, y);
  doc.setFont("helvetica", "normal").setFontSize(9).text("Central Store · Goods receipt", L, y + 5);
  doc.setFont("helvetica", "bold").setFontSize(12).text(pdfText(r.title), R, y, { align: "right" });
  doc.setFont("helvetica", "normal").setFontSize(9).text(pdfText(`Purchase order ${r.po} · ${r.status}`), R, y + 5, { align: "right" });
  y += 9;
  doc.setLineWidth(0.3).line(L, y, R, y);
  y += 5;
  doc.setFont("helvetica", "bold").setFontSize(9).text("Vendor", L, y);
  doc.setFont("helvetica", "normal").text(pdfText(r.vendor.name), L + 22, y);
  doc.text(pdfText(`GSTIN ${r.vendor.gstin || "not on file"}`), L + 110, y);
  y += 3;

  autoTable(doc, {
    startY: y,
    margin: { left: L, right: 297 - R },
    head: [["GRN", "Delivery note", "Invoice no.", "Invoice date", "Received by", "Received at"]],
    body: r.deliveries.map((d) => [d.grns, d.dc, d.invoice || "-", d.invDate || "-", d.by, d.at]),
    styles: { fontSize: 8, cellPadding: 1.5 },
    headStyles: { fillColor: [60, 60, 60] },
    theme: "grid",
  });

  const right = { halign: "right" as const };
  autoTable(doc, {
    startY: (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 5,
    margin: { left: L, right: 297 - R },
    head: [["GRN", "Item", "Code", "Unit", "Ordered", "Received now", "Rejected (quarantine)", "Accepted into stock",
      "Accepted to date", "Pending", "Rate", "Value accepted", "Batch", "MFG / EXP"]],
    body: r.lines.length
      ? r.lines.map((l) => [l.grn, l.item, l.code, l.unit, l.ordered, l.receivedNow, l.rejected, l.accepted,
        l.toDate, l.pending, pdfText(l.rate), pdfText(l.value), l.batch, l.mfgExp])
      : [[{ content: "Nothing has been received against this order.", colSpan: 14 }]],
    styles: { fontSize: 7.5, cellPadding: 1.4, overflow: "linebreak" },
    headStyles: { fillColor: [60, 60, 60], fontSize: 7 },
    columnStyles: { 4: right, 5: right, 6: right, 7: right, 8: right, 9: right, 10: right, 11: right },
    theme: "grid",
  });

  y = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  if (y > 170) { doc.addPage(); y = 16; }
  const total = (k: string, v: string) => {
    doc.setFont("helvetica", "normal").setFontSize(9).text(k, R - 90, y);
    doc.setFont("helvetica", "bold").text(pdfText(v), R, y, { align: "right" });
    y += 5;
  };
  total("Value received (at PO rate)", r.valueReceived);
  total("Value accepted into stock", r.valueAccepted);
  total("Rejected to quarantine", r.rejectedTotal || "Nothing");
  total("Pending on the order", r.pending);
  total("Status", r.status);

  y += 16;
  doc.setFont("helvetica", "normal").setFontSize(9).setLineWidth(0.2);
  ["Store keeper", "Buyer", "Vendor representative"].forEach((who, i) => {
    const x = L + i * 95;
    doc.line(x, y, x + 75, y);
    doc.text(who, x, y + 4.5);
  });
  saveAs(doc, r.file);
}
