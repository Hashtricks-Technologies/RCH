import { beforeEach, describe, expect, it } from "vitest";
import { ALL_LOCS, LOC, PAR_FACTOR } from "../data/master";
import { seedVendors, suggestVendor, vendorName } from "../data/vendors";
import { parOf, procurementList, qty } from "../lib/selectors";
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
    expect(S().toast).toMatch(/batch/i);
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
});
