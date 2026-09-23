import { describe, expect, it } from "vitest";
import { RECEIPT_TOLERANCE, checkReceiptLine, netReceived, receiptStatus } from "./receipt.js";

const line = { name: "Real Juice 200ml", unit: "nos", ordered: 120, received: 0 };
const ok = { recv: 120, rejected: 0, batch: "SBD-771", mrp: 20, mfg: "2026-09-01", exp: "2026-12-01" };
const TODAY = "2026-09-04";

describe("checkReceiptLine", () => {
  it("passes a clean instalment", () => {
    expect(checkReceiptLine(line, ok, TODAY)).toBeNull();
  });

  it("allows the 2% over-delivery the hospital accepts without a second thought", () => {
    expect(RECEIPT_TOLERANCE).toBe(1.02);
    expect(checkReceiptLine(line, { ...ok, recv: 122 }, TODAY)).toBeNull();          // 122 <= 122.4
    expect(checkReceiptLine(line, { ...ok, recv: 123 }, TODAY))
      .toBe("Real Juice 200ml - 123 exceeds the ordered 120 by more than 2%; hold it for purchase approval");
  });

  it("counts what earlier instalments already booked in", () => {
    expect(checkReceiptLine({ ...line, received: 100 }, { ...ok, recv: 23 }, TODAY))
      .toBe("Real Juice 200ml - 123 exceeds the ordered 120 by more than 2%; hold it for purchase approval");
  });

  it("refuses a rejection bigger than the delivery, and a negative one", () => {
    expect(checkReceiptLine(line, { ...ok, rejected: 130 }, TODAY)).toBe("Real Juice 200ml - rejected quantity cannot exceed what arrived");
    expect(checkReceiptLine(line, { ...ok, rejected: -1 }, TODAY)).toBe("Real Juice 200ml - rejected quantity cannot exceed what arrived");
  });

  it("will not book stock in without a batch behind it", () => {
    expect(checkReceiptLine(line, { ...ok, batch: "  " }, TODAY)).toBe("Real Juice 200ml needs its batch or lot number");
  });

  it("wants both dates, and them the right way round", () => {
    expect(checkReceiptLine(line, { ...ok, exp: "" }, TODAY)).toBe("Real Juice 200ml needs a manufacturing and an expiry date");
    expect(checkReceiptLine(line, { ...ok, mfg: "" }, TODAY)).toBe("Real Juice 200ml needs a manufacturing and an expiry date");
    expect(checkReceiptLine(line, { ...ok, mfg: "2026-12-01", exp: "2026-12-01" }, TODAY))
      .toBe("Real Juice 200ml - expiry cannot fall on or before the manufacturing date");
  });

  it("refuses stock that has already expired, and takes one expiring today", () => {
    expect(checkReceiptLine(line, { ...ok, exp: "2026-09-03" }, TODAY))
      .toBe("Real Juice 200ml - batch SBD-771 has already expired; do not book it in");
    expect(checkReceiptLine(line, { ...ok, exp: TODAY }, TODAY)).toBeNull();
  });

  it("takes a printed MRP below the shelf price - the till charges at most the MRP anyway", () => {
    expect(checkReceiptLine(line, { ...ok, mrp: 15 }, TODAY)).toBeNull();
    expect(checkReceiptLine(line, { ...ok, mrp: 0 }, TODAY)).toBeNull();   // not printed on the pack
  });

  it("checks in the order the store keeper reads: tolerance, rejection, batch, dates", () => {
    // Everything wrong at once must still name the tolerance, which is the one that stops the
    // delivery at the door. The order is what the browser has always produced.
    expect(checkReceiptLine(line, { recv: 200, rejected: 300, batch: "", mrp: 1, mfg: "", exp: "" }, TODAY))
      .toBe("Real Juice 200ml - 200 exceeds the ordered 120 by more than 2%; hold it for purchase approval");
  });
});

describe("receiptStatus", () => {
  it("is Received only when every line is covered", () => {
    expect(receiptStatus([{ qty: 80, recv: 80, rejected: 0 }, { qty: 6, recv: 6, rejected: 0 }])).toBe("Received");
    expect(receiptStatus([{ qty: 80, recv: 60, rejected: 0 }, { qty: 6, recv: 6, rejected: 0 }])).toBe("Partially received");
    expect(receiptStatus([{ qty: 80, recv: 81, rejected: 0 }])).toBe("Received");
  });

  it("does not count rejected quantity towards covering a line", () => {
    // A delivery turned away whole never entered the hospital, so the vendor still owes every
    // unit of it. `Received` is terminal - an order that reached it can be neither closed short
    // nor cancelled - so a gross reading would strand the requisition's claim for good.
    expect(receiptStatus([{ qty: 100, recv: 100, rejected: 100 }])).toBe("Partially received");
    expect(receiptStatus([{ qty: 120, recv: 120, rejected: 12 }])).toBe("Partially received");
    // The replacement instalment settles it: 132 arrived in all, 12 of them went back.
    expect(receiptStatus([{ qty: 120, recv: 132, rejected: 12 }])).toBe("Received");
    expect(receiptStatus([{ qty: 80, recv: 80, rejected: 0 }, { qty: 6, recv: 6, rejected: 6 }])).toBe("Partially received");
  });
});

describe("netReceived", () => {
  it("is what arrived less what quality control turned away", () => {
    expect(netReceived({ recv: 120, rejected: 12 })).toBe(108);
    expect(netReceived({ recv: 100, rejected: 100 })).toBe(0);
    expect(netReceived({ recv: 0.3, rejected: 0.1 })).toBe(0.2);
  });
});
