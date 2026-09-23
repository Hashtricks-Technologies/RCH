import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "../store";
import { DRAWERS } from "../drawers";
import "../roles/buyer/PoDrawer";
import "../roles/buyer/PoReceiptDrawer";
import "../roles/counter/TicketDrawer";
import "../roles/store/TicketDrawer";
import { downloadGrnPdf, downloadTicketPdf, grnInstalments, grnReport, ticketReceipt } from "../lib/pdf";
import type { Dated, DatedDoc, Grn, PurchaseOrder, Ticket, Trailed } from "../types";
import { as, resetStore, S } from "./fixture";

/** Everything the PDF was asked to draw and what it was saved as - jsPDF itself never runs here. */
const pdf = vi.hoisted(() => ({ texts: [] as string[], saved: [] as string[], tables: [] as unknown[][][], formats: [] as unknown[] }));

vi.mock("jspdf", () => {
  class jsPDF {
    lastAutoTable = { finalY: 40 };
    constructor(o: { format: unknown }) { pdf.formats.push(o.format); }
    setFont() { return this; }
    setFontSize() { return this; }
    setLineWidth() { return this; }
    setProperties() { return this; }
    line() { return this; }
    addPage() { return this; }
    splitTextToSize(s: string) { return [s]; }
    text(s: string | string[]) { pdf.texts.push(...([] as string[]).concat(s)); return this; }
    save(name: string) { pdf.saved.push(name); }
  }
  return { jsPDF };
});
vi.mock("jspdf-autotable", () => ({
  autoTable: (_doc: unknown, o: { body: unknown[][] }) => { pdf.tables.push(o.body); },
}));

beforeEach(() => {
  resetStore();
  pdf.texts.length = 0; pdf.saved.length = 0; pdf.tables.length = 0; pdf.formats.length = 0;
});

const mounted: (() => void)[] = [];
afterEach(() => { mounted.splice(0).forEach((u) => u()); });
function mount(C: ComponentType) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(C)); });
  mounted.push(() => { act(() => { root.unmount(); }); host.remove(); });
  return {
    host,
    button: (label: string) => [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label),
    slip: () => host.querySelector(".print-slip")?.textContent ?? "",
  };
}
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const ticket = (otp: string): Trailed<Ticket> => ({
  id: "TKT-2026-0442", req: "REQ-2026-0910", from: "store", to: "coffee", st: "Received", otp,
  lines: [{ it: "juice", qty: 24 }, { it: "milk", qty: 2.5 }],
  hist: [
    { s: "Issued", who: "Murugan S", t: "09:40", iso: "2026-09-11T04:10:00.000Z" },
    { s: "Handed over", who: "Suresh Muthu", t: "10:05", iso: "2026-09-11T04:35:00.000Z" },
    { s: "Received", who: "Divya R", t: "10:20", iso: "2026-09-11T04:50:00.000Z" },
  ],
});

describe("the ticket receipt", () => {
  it("reads the trail's three stamps, every line and a total per unit", () => {
    const r = ticketReceipt(ticket("481203"), true);
    expect(r).toMatchObject({ id: "TKT-2026-0442", from: "Central Store", to: "Coffee Shop", req: "REQ-2026-0910", otp: "481203" });
    expect(r.issued).toBe("11-Sep-2026 09:40 · Murugan S");
    expect(r.collected).toBe("11-Sep-2026 10:05 · Suresh Muthu");
    expect(r.received).toBe("11-Sep-2026 10:20 · Divya R");
    expect(r.lines[0]).toMatchObject({ name: "Real Juice 200ml", qty: "24", unit: "nos" });
    expect(r.total).toContain("24 nos");
  });

  it("carries the code only when it is asked for and this browser holds it", () => {
    expect(ticketReceipt(ticket("481203"), false).otp).toBeNull();
    expect(ticketReceipt(ticket(""), true).otp).toBeNull();
    const fresh: Ticket = { ...ticket(""), st: "Issued", hist: [{ s: "Issued", who: "Murugan S", t: "09:40" }] };
    expect(ticketReceipt(fresh, true)).toMatchObject({ issued: "09:40 · Murugan S", collected: "", received: "" });
  });

  it("downloads as <ticket>.pdf on an 80 mm page, the digits on it only when included", async () => {
    await downloadTicketPdf(ticket("481203"), true);
    expect(pdf.saved).toEqual(["TKT-2026-0442.pdf"]);
    expect((pdf.formats[1] as number[])[0]).toBe(80);
    expect(pdf.texts).toContain("4 8 1 2 0 3");
    expect(pdf.texts.join("\n")).not.toContain("₹");

    pdf.texts.length = 0;
    await downloadTicketPdf(ticket("481203"), false);
    expect(pdf.texts).not.toContain("4 8 1 2 0 3");
    expect(pdf.texts).toContain("OTP - the collector reads the code out at the window.");
  });

  it("the drawer's Include OTP box takes the digits off the slip, and Download PDF saves it", async () => {
    act(() => { as("counter"); useApp.setState({ tkt: [ticket("481203")] }); });
    const ui = mount(() => createElement(DRAWERS.ctkt, { id: "TKT-2026-0442" }));
    expect(ui.slip()).toContain("481203");
    const box = ui.host.querySelector<HTMLInputElement>(".slip-ctl input[type=checkbox]")!;
    expect(box.checked).toBe(true);
    act(() => { box.click(); });
    expect(ui.slip()).not.toContain("481203");
    expect(ui.slip()).toContain("the collector reads the code out");

    await act(async () => { ui.button("Download PDF")!.click(); });
    await settle();
    expect(pdf.saved).toEqual(["TKT-2026-0442.pdf"]);
    expect(pdf.texts).not.toContain("4 8 1 2 0 3");
    act(() => { box.click(); });
  });

  it("where the destination holds the code the box is off and says why", () => {
    act(() => { as("store"); useApp.setState({ tkt: [ticket("")] }); });
    const ui = mount(() => createElement(DRAWERS.stkt, { id: "TKT-2026-0442" }));
    const box = ui.host.querySelector<HTMLInputElement>(".slip-ctl input[type=checkbox]")!;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(ui.host.textContent).toContain("Coffee Shop holds the six digits");
  });
});

describe("the goods receipt note", () => {
  const PO: DatedDoc<PurchaseOrder> = {
    id: "PO-2026-0150", vendor: "VN-001", at: "07:10", iso: "2026-09-10T01:40:00.000Z", st: "Partially received", eta: "12-Sep-2026",
    lines: [
      { it: "milk", qty: 100, rate: 52, recv: 70, rejected: 10, src: [] },
      { it: "butter", qty: 6, rate: 480, recv: 0, rejected: 0, src: [] },
    ],
    hist: [],
  };
  const g = (id: string, iso: string, qty: number, rejected: number, dc: string): Dated<Grn> => ({
    id, po: PO.id, it: "milk", qty, rejected, batch: "B-" + id, mrp: 0, mfg: "2026-09-01", exp: "2026-09-20",
    dc, invoice: "INV-9", invDate: "2026-09-10", at: "09:15", iso, by: "Latha Narayanan",
  });
  const GRNS = [
    g("GRN-260150-01", "2026-09-10T03:45:00.000Z", 40, 0, "DC-1"),
    g("GRN-260150-02", "2026-09-11T03:45:00.000Z", 20, 10, "DC-2"),
  ];

  it("groups rows by delivery and reads to-date and pending as of each one", () => {
    const d = grnInstalments(GRNS);
    expect(d.map((x) => x.ids)).toEqual([["GRN-260150-01"], ["GRN-260150-02"]]);

    const first = grnReport(PO, GRNS, S().vendors, d[0].key);
    expect(first.file).toBe("GRN-260150-01.pdf");
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]).toMatchObject({ receivedNow: "40.000", accepted: "40.000", toDate: "40.000", pending: "60.000", batch: "B-GRN-260150-01" });
    expect(first.status).toBe("Partially received");
    expect(first.deliveries[0]).toMatchObject({ dc: "DC-1", invoice: "INV-9", invDate: "10-Sep-2026", at: "10-Sep-2026 09:15" });
    expect(first.vendor.name).not.toBe("Unknown vendor");

    const all = grnReport(PO, GRNS, S().vendors);
    expect(all.file).toBe("GRN-PO-2026-0150.pdf");
    expect(all.lines[1]).toMatchObject({ receivedNow: "30.000", rejected: "10.000", accepted: "20.000", toDate: "60.000", pending: "40.000" });
    expect(all.valueReceived).toBe("₹3,640.00");
    expect(all.valueAccepted).toBe("₹3,120.00");
    expect(all.pending).toContain("40.000");
    expect(all.status).toBe("Partially received");

    const short = grnReport({ ...PO, st: "Received", shortNote: "Vendor out of stock" }, GRNS, S().vendors);
    expect(short.status).toBe("Received - closed short: Vendor out of stock");
  });

  it("downloads the whole order with its line table, rupees spelled out for the PDF font", async () => {
    await downloadGrnPdf(PO, GRNS, S().vendors);
    expect(pdf.saved).toEqual(["GRN-PO-2026-0150.pdf"]);
    expect(pdf.tables).toHaveLength(2);
    expect(pdf.tables[1]).toHaveLength(2);
    expect(pdf.tables[1][0]).toContain("Rs. 52.00");
    expect(pdf.texts.join("\n")).not.toContain("₹");
    expect(pdf.texts).toContain("Vendor representative");
  });

  it("the order drawer offers the GRN once something is booked, and saves it", async () => {
    act(() => { as("buyer"); });
    const po = S().po.find((o) => S().grn.some((x) => x.po === o.id))!;
    const ui = mount(() => createElement(DRAWERS.bpo, { id: po.id }));
    const btn = ui.button("Download GRN (PDF)")!;
    expect(btn).toBeDefined();
    await act(async () => { btn.click(); });
    await settle();
    expect(pdf.saved).toHaveLength(1);
    expect(pdf.saved[0]).toMatch(/\.pdf$/);

    const none = S().po.find((o) => !S().grn.some((x) => x.po === o.id))!;
    const empty = mount(() => createElement(DRAWERS.bpo, { id: none.id }));
    expect(empty.button("Download GRN (PDF)")).toBeUndefined();
  });
});
