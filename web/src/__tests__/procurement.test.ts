import { beforeEach, describe, expect, it } from "vitest";
import { ALL_LOCS, LOC, PAR_FACTOR } from "../data/master";
import { seedVendors, suggestVendor, vendorName } from "../data/vendors";
import { apportion, onOrder, parOf, prqProgress, procurementList, qty, resv } from "../lib/selectors";
import type { ReceiptLine } from "../types";
import { as, resetStore, S } from "./fixture";

beforeEach(resetStore);

describe("procurement room location", () => {
  it("is a known location that counts in valuation", () => {
    expect(LOC.procure.n).toBe("Procurement Room");
    expect(ALL_LOCS).toContain("procure");
    expect(S().stock.procure).toBeDefined();
  });

  it("carries no reorder level, because it is a transit room", () => {
    expect(PAR_FACTOR.procure).toBe(0);
    expect(parOf("procure", "milk")).toBe(0);
  });

  it("opens with the stock its partially received order delivered", () => {
    expect(qty(S(), "procure", "milk")).toBe(60);
  });
});

describe("vendor master", () => {
  it("seeds five active vendors with unique ids", () => {
    expect(seedVendors).toHaveLength(5);
    expect(seedVendors.every((v) => v.active)).toBe(true);
    expect(new Set(seedVendors.map((v) => v.id)).size).toBe(5);
  });

  it("suggests the vendor that supplies an item group", () => {
    expect(suggestVendor(seedVendors, "Dairy")!.n).toBe("Aavin Dairy Depot");
    expect(suggestVendor(seedVendors, "Packaging")!.n).toBe("PackWell Industries");
    expect(suggestVendor(seedVendors, "Prepared")!.n).toBe("Green Farm Vegetables");
  });

  it("never suggests an inactive vendor", () => {
    const off = seedVendors.map((v) => (v.groups.includes("Dairy") ? { ...v, active: false } : v));
    expect(suggestVendor(off, "Dairy")).toBeNull();
  });

  it("resolves a name for an inactive vendor so history stays readable", () => {
    const off = seedVendors.map((v) => ({ ...v, active: false }));
    expect(vendorName(off, "VN-001")).toBe("Aavin Dairy Depot");
    expect(vendorName(off, "VN-999")).toBe("Unknown vendor");
  });
});

describe("kitchen distribution", () => {
  it("cannot distribute finished goods into the procurement room", async () => {
    const mod = await import("../roles/prod/MakeDistribute");
    expect(mod.DESTS).not.toContain("procure");
    expect(mod.DESTS).not.toContain("kitchen");
  });
});

describe("vendor maintenance", () => {
  it("adds a vendor with the next id, active by default", () => {
    as("buyer");
    S().addVendor({
      n: "Kovai Cold Storage", gstin: "33AAGCK1102P1ZW", contact: "Ravi T",
      ph: "99401 55823", terms: "21 days", lead: 4, groups: ["Dairy"],
    });
    const v = S().vendors.find((x) => x.n === "Kovai Cold Storage")!;
    expect(v.id).toBe("VN-006");
    expect(v.active).toBe(true);
    expect(S().vendors).toHaveLength(6);
  });

  it("refuses a vendor with no name", () => {
    as("buyer");
    S().addVendor({ n: "  ", gstin: "", contact: "", ph: "", terms: "", lead: 1, groups: [] });
    expect(S().vendors).toHaveLength(5);
    expect(S().toast).toMatch(/name/i);
  });

  it("edits a vendor in place", () => {
    as("buyer");
    S().updateVendor("VN-001", { terms: "45 days", lead: 4 });
    const v = S().vendors.find((x) => x.id === "VN-001")!;
    expect(v.terms).toBe("45 days");
    expect(v.lead).toBe(4);
    expect(v.n).toBe("Aavin Dairy Depot");
  });

  it("deactivates rather than deletes", () => {
    as("buyer");
    S().setVendorActive("VN-001", false);
    expect(S().vendors).toHaveLength(5);
    expect(S().vendors.find((x) => x.id === "VN-001")!.active).toBe(false);
  });
});

describe("requisition approval", () => {
  it("approves every line in full", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [60, 6], "Approved in full.");
    const p = S().prq.find((x) => x.id === "PRQ-2026-013")!;
    expect(p.st).toBe("Approved");
    expect(p.lines[0].appr).toBe(60);
    expect(p.lines[0].ordered).toBe(0);
    expect(p.lines[0].short).toBe(0);
    expect(p.apprBy).toBe("Latha Narayanan");
  });

  it("trims a line and records the shortfall", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [40, 6], "Budget cap this week.");
    const p = S().prq.find((x) => x.id === "PRQ-2026-013")!;
    expect(p.st).toBe("Partially approved");
    expect(p.lines[0].appr).toBe(40);
    expect(p.lines[0].short).toBe(20);
  });

  it("never approves more than was asked", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [500, 6], "");
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.lines[0].appr).toBe(60);
  });

  it("declines when nothing is approved", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [0, 0], "Nothing needed this week.");
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.st).toBe("Declined");
  });

  it("refuses to decline-by-zero without a reason", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [0, 0], "   ");
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.st).toBe("Sent");
    expect(S().toast).toMatch(/reason/i);

    S().approveRequisition("PRQ-2026-013", [0, 0], "Nothing needed this week.");
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.st).toBe("Declined");
  });

  it("declines only with a reason", () => {
    as("buyer");
    S().declineRequisition("PRQ-2026-013", "   ");
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.st).toBe("Sent");
    expect(S().toast).toMatch(/reason/i);

    S().declineRequisition("PRQ-2026-013", "Store still holds three weeks of cover.");
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.st).toBe("Declined");
  });

  it("acts only on a requisition still waiting", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-012", [10, 1], "");
    expect(S().prq.find((x) => x.id === "PRQ-2026-012")!.lines[0].appr).toBe(80);
  });
});

describe("sending a requisition", () => {
  it("mints the next id with the new line shape and a history entry", () => {
    as("store");
    S().setPrqDraft([{ it: "milk", qty: 30 }]);
    S().sendRequisition("Coffee shop is running low again.");

    const p = S().prq.find((x) => x.id === "PRQ-2026-016")!;
    expect(p).toBeDefined();
    expect(p.by).toBe("Suresh Muthu");
    expect(p.st).toBe("Sent");
    expect(p.lines[0]).toEqual({ it: "milk", qty: 30, appr: 0, ordered: 0 });
    expect(p.hist).toHaveLength(1);
    expect(p.hist[0].s).toBe("Sent");
    expect(p.hist[0].who).toBe("Suresh Muthu");
  });
});

describe("procurement list", () => {
  it("lists approved lines that are not yet on an order", () => {
    const pool = procurementList(S());
    expect(pool.map((l) => l.it)).toEqual(["maida", "milk"]);
    expect(pool[0].pending).toBe(20);
    expect(pool[0].prq).toBe("PRQ-2026-014");
  });

  it("grows when a new requisition is approved", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [60, 6], "");
    const pool = procurementList(S());
    expect(pool.map((l) => l.it)).toEqual(["maida", "milk", "butter", "milk"]);
    expect(pool.find((l) => l.it === "milk" && l.prq === "PRQ-2026-013")!.pending).toBe(60);
    expect(pool).toHaveLength(4);
  });
});

describe("draft purchase orders", () => {
  const approve13 = () => { as("buyer"); S().approveRequisition("PRQ-2026-013", [60, 6], ""); };

  it("merges two requisitions' worth of the same item into one PO line", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [60, 6], "");
    S().createPo("VN-001", [
      { prq: "PRQ-2026-013", line: 0, qty: 60 },
      { prq: "PRQ-2026-011", line: 0, qty: 25 },
    ]);
    const po = S().po.find((o) => o.st === "Draft" && o.id === "PO-2026-0143")!;
    const milk = po.lines.filter((l) => l.it === "milk");
    expect(milk).toHaveLength(1);
    expect(milk[0].qty).toBe(85);
    expect(milk[0].src).toEqual([
      { prq: "PRQ-2026-013", line: 0, qty: 60 },
      { prq: "PRQ-2026-011", line: 0, qty: 25 },
    ]);
  });

  it("claims against every source requisition of a merged line", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [60, 6], "");
    S().createPo("VN-001", [
      { prq: "PRQ-2026-013", line: 0, qty: 60 },
      { prq: "PRQ-2026-011", line: 0, qty: 25 },
    ]);
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.lines[0].ordered).toBe(60);
    expect(S().prq.find((x) => x.id === "PRQ-2026-011")!.lines[0].ordered).toBe(25);
    expect(procurementList(S()).some((l) => l.it === "milk")).toBe(false);
  });

  it("claims the quantity on the source line as soon as the draft exists", () => {
    approve13();
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 40 }]);
    const p = S().prq.find((x) => x.id === "PRQ-2026-013")!;
    expect(p.lines[0].ordered).toBe(40);
    expect(procurementList(S()).find((l) => l.it === "milk" && l.prq === "PRQ-2026-013")!.pending).toBe(20);
  });

  it("refuses a pick larger than what is still pending", () => {
    approve13();
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 80 }]);
    expect(S().po.some((o) => o.id === "PO-2026-0143")).toBe(false);
    expect(S().toast).toMatch(/only 60/i);
  });

  it("refuses two picks against the same source line that together overrun what's pending", () => {
    approve13();
    S().createPo("VN-001", [
      { prq: "PRQ-2026-013", line: 0, qty: 40 },
      { prq: "PRQ-2026-013", line: 0, qty: 40 },
    ]);
    expect(S().po.some((o) => o.id === "PO-2026-0143")).toBe(false);
    expect(S().toast).toMatch(/only 60/i);
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.lines[0].ordered).toBe(0);
  });

  it("stops two drafts claiming the same quantity", () => {
    approve13();
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 60 }]);
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 60 }]);
    expect(S().po).toHaveLength(4);
    expect(S().po.some((o) => o.id === "PO-2026-0144")).toBe(false);
  });

  it("refuses an unknown or inactive vendor", () => {
    approve13();
    S().setVendorActive("VN-001", false);
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 60 }]);
    expect(S().po.some((o) => o.id === "PO-2026-0143")).toBe(false);
    expect(S().toast).toMatch(/inactive/i);
  });

  it("releases the claim when a line is removed", () => {
    approve13();
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 60 }]);
    const po = S().po.find((o) => o.id === "PO-2026-0143")!;
    S().removePoLine(po.id, 0);
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.lines[0].ordered).toBe(0);
  });

  it("releases the difference when a draft quantity is reduced", () => {
    approve13();
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 60 }]);
    const po = S().po.find((o) => o.id === "PO-2026-0143")!;
    S().updatePoLine(po.id, 0, { qty: 25 });
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.lines[0].ordered).toBe(25);
    expect(S().po.find((o) => o.id === po.id)!.lines[0].src[0].qty).toBe(25);
  });

  it("edits a rate without touching the claim", () => {
    approve13();
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 60 }]);
    const po = S().po.find((o) => o.id === "PO-2026-0143")!;
    S().updatePoLine(po.id, 0, { rate: 56 });
    expect(S().po.find((o) => o.id === po.id)!.lines[0].rate).toBe(56);
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.lines[0].ordered).toBe(60);
  });
});

describe("sending a purchase order", () => {
  it("moves a draft to ordered and stamps the approval slab", () => {
    as("buyer");
    S().sendPo("PO-2026-0140");
    const o = S().po.find((x) => x.id === "PO-2026-0140")!;
    expect(o.st).toBe("Ordered");
    expect(o.needsApproval).toBe(false);
    expect(o.hist.at(-1)!.s).toBe("Ordered");
  });

  it("flags an order over the finance slab but still sends it", () => {
    as("buyer");
    S().updatePoLine("PO-2026-0140", 0, { rate: 2000 });
    S().sendPo("PO-2026-0140");
    const o = S().po.find((x) => x.id === "PO-2026-0140")!;
    expect(o.st).toBe("Ordered");
    expect(o.needsApproval).toBe(true);
    expect(S().toast).toMatch(/finance approval/i);
  });

  it("refuses to send to an inactive vendor", () => {
    as("buyer");
    S().setVendorActive("VN-003", false);
    S().sendPo("PO-2026-0140");
    expect(S().po.find((x) => x.id === "PO-2026-0140")!.st).toBe("Draft");
    expect(S().toast).toMatch(/inactive/i);
  });

  it("refuses to send an empty order", () => {
    as("buyer");
    S().removePoLine("PO-2026-0140", 0);
    S().sendPo("PO-2026-0140");
    expect(S().po.find((x) => x.id === "PO-2026-0140")!.st).toBe("Draft");
    expect(S().toast).toMatch(/no lines/i);
  });

  it("cancels an order and returns every claim to the pool", () => {
    as("buyer");
    S().cancelPo("PO-2026-0140", "Vendor cannot supply this week.");
    expect(S().po.find((x) => x.id === "PO-2026-0140")!.st).toBe("Cancelled");
    const p = S().prq.find((x) => x.id === "PRQ-2026-014")!;
    expect(p.lines[0].ordered).toBe(0);
    expect(procurementList(S()).some((l) => l.it === "sugar")).toBe(true);
  });

  it("will not cancel once anything has been received", () => {
    as("buyer");
    S().cancelPo("PO-2026-0142", "Too late.");
    expect(S().po.find((x) => x.id === "PO-2026-0142")!.st).toBe("Partially received");
    expect(S().toast).toMatch(/already received/i);
  });

  it("requires a reason to cancel", () => {
    as("buyer");
    S().cancelPo("PO-2026-0140", "  ");
    expect(S().po.find((x) => x.id === "PO-2026-0140")!.st).toBe("Draft");
  });
});

describe("receiving against a purchase order", () => {
  const doc = { dc: "DC-90112", invoice: "INV/SB/8890", invDate: "2026-08-29" };
  const line = (over: Partial<ReceiptLine> = {}): ReceiptLine => ({
    recv: 0, rejected: 0, batch: "SB-4410", mrp: 0,
    mfg: "2026-08-01", exp: "2027-08-01", ...over,
  });

  it("books accepted stock into the procurement room, not the central store", () => {
    as("buyer");
    const store = qty(S(), "store", "juice");
    S().receivePo("PO-2026-0141", doc, [line({ recv: 120 }), line({ recv: 90 })]);
    expect(qty(S(), "procure", "juice")).toBe(120);
    expect(qty(S(), "store", "juice")).toBe(store);
    expect(S().po.find((x) => x.id === "PO-2026-0141")!.st).toBe("Received");
  });

  it("writes one GRN per received line, stamped with the delivery note", () => {
    as("buyer");
    S().receivePo("PO-2026-0141", doc, [line({ recv: 120 }), line({ recv: 90 })]);
    const g = S().grn.filter((x) => x.po === "PO-2026-0141");
    expect(g).toHaveLength(2);
    expect(g[0].dc).toBe("DC-90112");
    expect(g[0].invoice).toBe("INV/SB/8890");
    expect(g[0].by).toBe("Latha Narayanan");
  });

  it("subtracts the rejected quantity without stocking it", () => {
    as("buyer");
    S().receivePo("PO-2026-0141", doc, [line({ recv: 120, rejected: 20 }), line({ recv: 90 })]);
    expect(qty(S(), "procure", "juice")).toBe(100);
    expect(S().grn.find((g) => g.it === "juice")!.rejected).toBe(20);
    expect(S().toast).toMatch(/rejected/i);
  });

  it("reports a mixed-unit instalment's accepted and rejected quantities by unit, not summed", () => {
    as("buyer");
    // PO-2026-0142: milk (L) 80 ordered / 60 received, butter (kg) 6 ordered /
    // 6 received. One instalment touching both units, with a rejection on
    // only the milk line — a bare number here would silently add litres to
    // kilos.
    S().receivePo("PO-2026-0142", doc, [line({ recv: 20, rejected: 5 }), line({ recv: 0.12 })]);
    expect(S().toast).toBe("Booked into Procurement Room — 15.000 L · 0.120 kg accepted, 5.000 L rejected");
  });

  it("accumulates instalments and stays partially received in between", () => {
    as("buyer");
    S().receivePo("PO-2026-0141", doc, [line({ recv: 50 }), line({ recv: 0 })]);
    let o = S().po.find((x) => x.id === "PO-2026-0141")!;
    expect(o.st).toBe("Partially received");
    expect(o.lines[0].recv).toBe(50);

    S().receivePo("PO-2026-0141", doc, [line({ recv: 70 }), line({ recv: 90 })]);
    o = S().po.find((x) => x.id === "PO-2026-0141")!;
    expect(o.st).toBe("Received");
    expect(o.lines[0].recv).toBe(120);
    expect(qty(S(), "procure", "juice")).toBe(120);
  });

  it("refuses a receipt with no delivery note", () => {
    as("buyer");
    S().receivePo("PO-2026-0141", { dc: " ", invoice: "", invDate: "" }, [line({ recv: 10 }), line()]);
    expect(S().po.find((x) => x.id === "PO-2026-0141")!.st).toBe("Ordered");
    expect(S().toast).toMatch(/delivery note/i);
  });

  it("refuses a cumulative over-delivery beyond the 2% tolerance", () => {
    as("buyer");
    S().receivePo("PO-2026-0141", doc, [line({ recv: 100 }), line({ recv: 0 })]);
    S().receivePo("PO-2026-0141", doc, [line({ recv: 40 }), line({ recv: 0 })]);
    expect(S().po.find((x) => x.id === "PO-2026-0141")!.lines[0].recv).toBe(100);
    expect(S().toast).toMatch(/2%/);
  });

  it("refuses a line without a batch or with a bad expiry", () => {
    as("buyer");
    S().receivePo("PO-2026-0141", doc, [line({ recv: 10, batch: "" }), line()]);
    // "/batch/i" alone also matches the success toast ("...N batch(es) against
    // DC-..."), so a deleted guard would let this call through and still pass.
    // Match the guard's own wording, and check the call was actually refused.
    expect(S().toast).toMatch(/batch or lot/i);
    expect(S().po.find((x) => x.id === "PO-2026-0141")!.st).toBe("Ordered");
    expect(S().grn).toHaveLength(2);
    S().receivePo("PO-2026-0141", doc, [line({ recv: 10, mfg: "2026-08-01", exp: "2026-07-01" }), line()]);
    expect(S().toast).toMatch(/expiry/i);
    S().receivePo("PO-2026-0141", doc, [line({ recv: 10, mfg: "2019-01-01", exp: "2020-01-01" }), line()]);
    expect(S().toast).toMatch(/expired/i);
    expect(S().grn).toHaveLength(2);
  });

  it("refuses a rejected quantity larger than what arrived", () => {
    as("buyer");
    S().receivePo("PO-2026-0141", doc, [line({ recv: 10, rejected: 40 }), line()]);
    expect(S().toast).toMatch(/cannot exceed/i);
  });

  it("returns the undelivered balance to the pool when closed short", () => {
    as("buyer");
    S().closePoShort("PO-2026-0142", "Vendor could not supply the balance.");
    const o = S().po.find((x) => x.id === "PO-2026-0142")!;
    expect(o.st).toBe("Received");
    expect(o.shortNote).toMatch(/could not supply/);
    const p = S().prq.find((x) => x.id === "PRQ-2026-012")!;
    expect(p.lines[0].ordered).toBe(60);
    expect(procurementList(S()).find((l) => l.it === "milk")!.pending).toBe(20);
  });

  it("closes short only with a reason, and only when partly received", () => {
    as("buyer");
    S().closePoShort("PO-2026-0142", "  ");
    expect(S().po.find((x) => x.id === "PO-2026-0142")!.st).toBe("Partially received");
    S().closePoShort("PO-2026-0141", "Nothing arrived.");
    expect(S().po.find((x) => x.id === "PO-2026-0141")!.st).toBe("Ordered");
  });

  it("splits a shortfall across multiple source requisitions, releasing the last-added source first", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [60, 6], "Approved in full.");
    // One merged milk line with two src entries: 60 from PRQ-013, 25 from
    // PRQ-011 (already approved in the seed) — every seeded PO line has only
    // one source, so this is the only way to exercise the reverse-walk split.
    S().createPo("VN-001", [
      { prq: "PRQ-2026-013", line: 0, qty: 60 },
      { prq: "PRQ-2026-011", line: 0, qty: 25 },
    ]);
    S().sendPo("PO-2026-0143");
    S().receivePo("PO-2026-0143", doc, [line({ recv: 70 })]);
    expect(S().po.find((x) => x.id === "PO-2026-0143")!.st).toBe("Partially received");

    S().closePoShort("PO-2026-0143", "Vendor could not supply the rest.");
    expect(S().po.find((x) => x.id === "PO-2026-0143")!.st).toBe("Received");

    // The 15-unit shortfall (85 ordered − 70 received) must come off the
    // LAST source added first: PRQ-011 drops from 25 to 10, PRQ-013 is untouched.
    expect(S().prq.find((x) => x.id === "PRQ-2026-011")!.lines[0].ordered).toBe(10);
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.lines[0].ordered).toBe(60);

    const milk = procurementList(S()).find((l) => l.it === "milk")!;
    expect(milk.prq).toBe("PRQ-2026-011");
    expect(milk.pending).toBe(15);
  });
});

describe("procurement room to central store", () => {
  it("issues a pick ticket and reserves the stock", () => {
    as("buyer");
    S().issueToStore([{ it: "milk", qty: 40 }]);
    const t = S().tkt.at(-1)!;
    expect(t.from).toBe("procure");
    expect(t.to).toBe("store");
    expect(t.st).toBe("Issued");
    expect(t.req).toBe("Procurement transfer");
    expect(resv(S(), "procure", "milk")).toBe(40);
    expect(qty(S(), "procure", "milk")).toBe(60);
  });

  it("refuses more than is free to promise in the room", () => {
    as("buyer");
    S().issueToStore([{ it: "milk", qty: 40 }]);
    S().issueToStore([{ it: "milk", qty: 40 }]);
    expect(S().tkt.filter((t) => t.from === "procure")).toHaveLength(1);
    expect(S().toast).toMatch(/only 20/i);
  });

  it("refuses an empty or zero pick", () => {
    as("buyer");
    S().issueToStore([]);
    S().issueToStore([{ it: "milk", qty: 0 }]);
    expect(S().tkt.filter((t) => t.from === "procure")).toHaveLength(0);
  });

  it("moves stock room to store across handover and receipt", () => {
    as("buyer");
    const before = qty(S(), "store", "milk");
    S().issueToStore([{ it: "milk", qty: 40 }]);
    const id = S().tkt.at(-1)!.id;

    S().handover(id);
    expect(qty(S(), "procure", "milk")).toBe(20);
    expect(resv(S(), "procure", "milk")).toBe(0);
    expect(qty(S(), "store", "milk")).toBe(before);
    expect(S().tkt.find((t) => t.id === id)!.st).toBe("Collected");

    as("store");
    S().receiveTicket(id);
    expect(qty(S(), "store", "milk")).toBe(before + 40);
    expect(S().tkt.find((t) => t.id === id)!.st).toBe("Received");
  });
});

describe("requisition progress", () => {
  it("reports awaiting approval before a decision", () => {
    expect(prqProgress(S(), "PRQ-2026-013").label).toBe("Awaiting approval");
  });

  it("reports awaiting order once approved but unclaimed", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [60, 6], "");
    expect(prqProgress(S(), "PRQ-2026-013").label).toBe("Awaiting order");
  });

  it("reports partly ordered when only some lines are claimed", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [60, 6], "");
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 60 }]);
    const p = prqProgress(S(), "PRQ-2026-013");
    expect(p.ordered).toBe(60);
    expect(p.appr).toBe(66);
    expect(p.label).toBe("Partly ordered");
  });

  it("reports partly received, then received", () => {
    expect(prqProgress(S(), "PRQ-2026-012").label).toBe("Partly received");
    expect(prqProgress(S(), "PRQ-2026-012").received).toBe(66);
    expect(prqProgress(S(), "PRQ-2026-015").label).toBe("Ordered");
  });

  it("reports declined", () => {
    as("buyer");
    S().declineRequisition("PRQ-2026-013", "Store has three weeks of cover.");
    expect(prqProgress(S(), "PRQ-2026-013").label).toBe("Declined");
  });
});

describe("apportioning a receipt to its sources", () => {
  it("fills sources in order", () => {
    const src = [{ prq: "A", line: 0, qty: 60 }, { prq: "B", line: 0, qty: 25 }];
    expect(apportion(0, src)).toEqual([0, 0]);
    expect(apportion(40, src)).toEqual([40, 0]);
    expect(apportion(70, src)).toEqual([60, 10]);
    expect(apportion(200, src)).toEqual([60, 25]);
  });
});

describe("onOrder", () => {
  it("counts pool pending plus undelivered balance on live orders", () => {
    // maida: 20 pending on the pool, nothing ordered
    expect(onOrder(S(), "maida")).toBe(20);
    // milk: 25 still pending on the pool (PRQ-2026-011), plus a 20-unit
    // undelivered balance on PO-2026-0142 (80 ordered, 60 received) → 45
    expect(onOrder(S(), "milk")).toBe(45);
    // juice: 120 ordered, none received
    expect(onOrder(S(), "juice")).toBe(120);
  });

  it("ignores cancelled and fully received orders", () => {
    as("buyer");
    S().cancelPo("PO-2026-0141", "Vendor closed.");
    expect(onOrder(S(), "juice")).toBe(120);
  });
});
