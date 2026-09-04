import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_LOCS, LOC } from "../data/master";
import { seedPrq } from "../data/seed";
import { seedVendors, suggestVendor, vendorName } from "../data/vendors";
import {
  awaitingApproval, onOrder, poValue, prqProgress, procurementList,
} from "../lib/selectors";
import { useApp } from "../store";
import { ordersFor } from "../roles/buyer/ProcurementList";
import { contractFor } from "../roles/buyer/lib";
import type { PoolGroup } from "../roles/buyer/ProcurementList";
import { clone, resetStore, S } from "./fixture";

/**
 * What buying's screens *derive*, and nothing else.
 *
 * Every rule the store used to hold — the approval arithmetic, the claim walk, the 2 % receipt
 * tolerance, the expiry checks, the finance slab — is the server's from Phase 5, and its tests
 * are `apps/api/src/modules/{requisitions,purchaseorders,grn,vendors,contracts,catalog,
 * productreqs}/*.test.ts`. `writes.test.ts` pins which route each action calls. What is left
 * here is the preview the browser still computes for itself: the pooled procurement list, a
 * requisition's progress, and the two halves of the M3 duplicate-order guard.
 *
 * Cases that used to reach their state by calling an action now set it directly — what each one
 * is about is the selector, not the write.
 */
beforeEach(resetStore);

describe("stock locations", () => {
  it("carries the five working locations and the rejected-goods shelf, and no transit room", () => {
    // `ALL_LOCS` is deliberately still five: quarantine is somewhere stock can *be*, never
    // somewhere an operator works, so no screen that iterates the working locations grows a
    // sixth column. It has a name and a shelf, and that is all.
    expect(ALL_LOCS).toEqual(["store", "kitchen", "rest", "coffee", "kiosk"]);
    expect(Object.keys(LOC).sort()).toEqual([...ALL_LOCS, "quarantine"].sort());
    expect(ALL_LOCS).toHaveLength(5);
    expect(ALL_LOCS).not.toContain("quarantine");
    // The shelf half of the same fact: stock is reported for quarantine, so the store keeper
    // can see what a goods receipt turned away.
    expect(Object.keys(S().stock)).toContain("quarantine");
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

describe("rate contract preview honours the validity window", () => {
  // Fixed rather than read off the host: `contractRate` compares against today's date in the
  // hospital's calendar (`istDate`), so a test that let the host's own clock decide "lapsed"
  // vs. "in window" would pass today and quietly go dark the day this contract's `to` arrives.
  const today = new Date("2026-09-04T06:00:00+05:30");
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(today); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not preview a contract that is still marked active but whose window closed yesterday", () => {
    useApp.setState({
      contracts: [{ id: "RC-901", vendor: "Aavin Dairy Depot", it: "milk", rate: 52, from: "01-Jan-2026", to: "03-Sep-2026", moq: 40, active: true }],
    });
    expect(S().contractRate("Aavin Dairy Depot", "milk")).toBeUndefined();
    // `contractFor` (`roles/buyer/lib.ts`, what `PoDrawer` and `ProcurementList` actually call)
    // inherits the same refusal — it is a thin resolver over `contractRate`, not a second copy
    // of the rule.
    expect(contractFor(S(), "VN-001", "milk")).toBeUndefined();
  });

  it("previews a contract whose window covers today", () => {
    useApp.setState({
      contracts: [{ id: "RC-902", vendor: "Aavin Dairy Depot", it: "milk", rate: 52, from: "01-Jan-2026", to: "31-Mar-2027", moq: 40, active: true }],
    });
    expect(S().contractRate("Aavin Dairy Depot", "milk")?.id).toBe("RC-902");
    expect(contractFor(S(), "VN-001", "milk")?.id).toBe("RC-902");
  });

  it("does not preview a contract that has not started yet", () => {
    useApp.setState({
      contracts: [{ id: "RC-903", vendor: "Aavin Dairy Depot", it: "milk", rate: 52, from: "05-Sep-2026", to: "31-Mar-2027", moq: 40, active: true }],
    });
    expect(S().contractRate("Aavin Dairy Depot", "milk")).toBeUndefined();
  });
});

describe("kitchen distribution", () => {
  it("never lists the kitchen as its own destination", async () => {
    const mod = await import("../roles/prod/MakeDistribute");
    expect(mod.DESTS).not.toContain("kitchen");
  });
});

/** Approve PRQ-2026-013 in full, without going near the server. */
const approve13 = () => useApp.setState({
  prq: S().prq.map((p) => (p.id !== seedPrq[3].id ? p : {
    ...clone(p),
    st: "Approved" as const,
    lines: p.lines.map((l) => ({ ...l, appr: l.qty, ordered: 0, short: 0 })),
  })),
});

describe("procurement list", () => {
  it("lists approved lines that are not yet on an order", () => {
    const pool = procurementList(S());
    expect(pool.map((l) => l.it)).toEqual(["maida", "milk"]);
    expect(pool[0].pending).toBe(20);
    expect(pool[0].prq).toBe("PRQ-2026-014");
  });

  it("grows when a new requisition is approved", () => {
    const before = procurementList(S()).length;
    approve13();
    const pool = procurementList(S());
    expect(pool.length).toBeGreaterThan(before);
    expect(pool.map((l) => l.it)).toEqual(["maida", "milk", "butter", "milk"]);
    expect(pool.find((l) => l.it === "milk" && l.prq === seedPrq[3].id)!.pending).toBe(60);
  });
});

describe("requisition progress", () => {
  it("reports awaiting approval before a decision", () => {
    expect(prqProgress(S(), "PRQ-2026-013").label).toBe("Awaiting approval");
  });

  it("reports awaiting order once approved but unclaimed", () => {
    approve13();
    expect(prqProgress(S(), "PRQ-2026-013").label).toBe("Awaiting order");
  });

  it("reports partly ordered when only some lines are claimed", () => {
    approve13();
    // One line of the two carries a purchase order's claim; the other is still on the list.
    useApp.setState({
      prq: S().prq.map((p) => (p.id !== "PRQ-2026-013" ? p : {
        ...p, lines: p.lines.map((l, i) => (i === 0 ? { ...l, ordered: 60 } : l)),
      })),
    });
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
    useApp.setState({
      prq: S().prq.map((p) => (p.id !== "PRQ-2026-013" ? p : {
        ...clone(p), st: "Declined" as const,
        lines: p.lines.map((l) => ({ ...l, appr: 0, ordered: 0, short: l.qty })),
      })),
    });
    expect(prqProgress(S(), "PRQ-2026-013").label).toBe("Declined");
  });
});

describe("the order's value", () => {
  it("is the domain's arithmetic, to the paise", () => {
    const o = S().po.find((x) => x.id === "PO-2026-0141")!;
    expect(poValue(o)).toBe(120 * 14.2 + 90 * 11.5);
    // Rounded to two decimals rather than carried at full float precision — the server stamps
    // `needsApproval` off the same function, and a slab comparison must not disagree by a tail.
    expect(poValue({ ...o, lines: [{ ...o.lines[0], qty: 3, rate: 0.615 }] })).toBe(1.85);
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
    // Cancelling PO-2026-0141 takes its 120 juice off the order and hands the same 120 back to
    // PRQ-2026-015's line, so what a store keeper reads as "on order" does not move.
    useApp.setState({
      po: S().po.map((o) => (o.id !== "PO-2026-0141" ? o : { ...clone(o), st: "Cancelled" as const })),
      prq: S().prq.map((p) => (p.id !== "PRQ-2026-015" ? p : {
        ...clone(p), lines: p.lines.map((l) => ({ ...l, ordered: 0 })),
      })),
    });
    expect(onOrder(S(), "juice")).toBe(120);
  });

  it("counts a Draft PO's claim, not only Ordered/Partially received", () => {
    // PO-2026-0140 is a Draft carrying 30 kg of sugar claimed from
    // PRQ-2026-014 — creating the draft moved that claim out of the pool,
    // before it was ever sent to a vendor. A selector that only recognised
    // Ordered/Partially received would report 0 here while 30 kg sits claimed
    // and unaccounted for.
    expect(onOrder(S(), "sugar")).toBe(30);
  });

  it("does not count a requisition still awaiting approval", () => {
    // PRQ-2026-013 (Sent) asks for 6 units of butter. PRQ-2026-012's butter
    // line is fully claimed (pool pending 0) and PO-2026-0142's butter line
    // is fully received (undelivered balance 0), so onOrder alone — which
    // only reflects an approved commitment — must stay at zero until
    // PRQ-2026-013 is actually decided on.
    expect(onOrder(S(), "butter")).toBe(0);
  });
});

describe("awaitingApproval", () => {
  it("counts a Sent requisition's asked quantity, the half onOrder excludes", () => {
    expect(awaitingApproval(S(), "butter")).toBe(6);
    // This is exactly the expression the M3 raise-side guard uses
    // (Requisitions.tsx's warnOnOrder/alreadyOpen, Stock.tsx's
    // addToRequisition): onOrder alone is 0 here, so without this half the
    // guard would silently miss a duplicate ask for a still-unapproved item.
    expect(onOrder(S(), "butter") + awaitingApproval(S(), "butter")).toBeGreaterThan(0);
    expect(onOrder(S(), "butter") + awaitingApproval(S(), "butter")).toBe(6);
  });

  it("stops counting once the requisition is approved", () => {
    approve13();
    expect(awaitingApproval(S(), "butter")).toBe(0);
  });
});

describe("per-line vendor selection on the procurement list", () => {
  const group = (it: string, sources: { prq: string; line: number; pending: number }[]): PoolGroup => ({
    it,
    pending: sources.reduce((t, x) => t + x.pending, 0),
    sources: sources.map((x) => ({ ...x, it, asked: x.pending, by: "Suresh Muthu", at: "07:00" })),
    vendor: null,
  });
  const milk = () => group("milk", [{ prq: "PRQ-2026-013", line: 0, pending: 60 }]);
  const maida = () => group("maida", [{ prq: "PRQ-2026-014", line: 1, pending: 20 }]);

  it("combines items that share a vendor into one order", () => {
    const orders = ordersFor([
      { group: milk(), vendor: "VN-001", qty: 60 },
      { group: group("butter", [{ prq: "PRQ-2026-013", line: 1, pending: 6 }]), vendor: "VN-001", qty: 6 },
    ]);
    expect(orders).toHaveLength(1);
    expect(orders[0].vendor).toBe("VN-001");
    expect(orders[0].picks).toHaveLength(2);
  });

  it("splits items across vendors into one order each", () => {
    const orders = ordersFor([
      { group: milk(), vendor: "VN-001", qty: 60 },
      { group: maida(), vendor: "VN-003", qty: 20 },
    ]);
    expect(orders.map((o) => o.vendor)).toEqual(["VN-001", "VN-003"]);
    expect(orders.every((o) => o.picks.length === 1)).toBe(true);
  });

  it("drops an item with no vendor rather than folding it into someone else's order", () => {
    const orders = ordersFor([
      { group: milk(), vendor: "VN-001", qty: 60 },
      { group: maida(), vendor: "", qty: 20 },
    ]);
    expect(orders).toHaveLength(1);
    expect(orders[0].picks.map((p) => p.prq)).toEqual(["PRQ-2026-013"]);
  });
});
