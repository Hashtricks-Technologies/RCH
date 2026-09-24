import { describe, expect, it } from "vitest";
import { CreateQrOrderBodySchema, QrOrderStatusSchema, type OrderHoursDay } from "@rch/contract";
import {
  customerPhoneRefusal, hoursRefusal, nextQrStep, paise, pausedRefusal, QR_MAX_LINES, QR_MAX_QTY, QR_MAX_RUPEES, QR_PENDING_PER_IP, QR_PENDING_PER_PHONE,
  QR_STATUS_WORDS, qrOpenAt, qrStepsFor,
} from "./qr";

describe("qrStepsFor", () => {
  it("walks a pickup to the counter and a delivery to the spot", () => {
    expect(qrStepsFor("pickup")).toEqual(["Paid", "Preparing", "Ready", "Collected"]);
    expect(qrStepsFor("deliver")).toEqual(["Paid", "Preparing", "Out for delivery", "Delivered"]);
  });
  it("hands out a copy, so a caller cannot rewrite the path", () => {
    qrStepsFor("pickup").pop();
    expect(qrStepsFor("pickup")).toHaveLength(4);
  });
});

describe("nextQrStep", () => {
  it("is the one next step on the code's own path", () => {
    expect(nextQrStep("pickup", "Paid")).toBe("Preparing");
    expect(nextQrStep("pickup", "Preparing")).toBe("Ready");
    expect(nextQrStep("pickup", "Ready")).toBe("Collected");
    expect(nextQrStep("deliver", "Preparing")).toBe("Out for delivery");
    expect(nextQrStep("deliver", "Out for delivery")).toBe("Delivered");
  });
  it("is nothing at the end of the path, before payment, off the path, or once it is over", () => {
    expect(nextQrStep("pickup", "Collected")).toBeNull();
    expect(nextQrStep("deliver", "Delivered")).toBeNull();
    expect(nextQrStep("pickup", "Awaiting payment")).toBeNull();
    expect(nextQrStep("pickup", "Out for delivery")).toBeNull();
    for (const st of ["Refunded", "Expired", "Voided"] as const) expect(nextQrStep("deliver", st), st).toBeNull();
  });
});

describe("qrOpenAt", () => {
  // 24 September 2026 is a Thursday (4) and the 25th a Friday (5), in IST as in UTC. The suite runs
  // at TZ=UTC, so every instant below is read on the hospital's clock or the case fails.
  const days: OrderHoursDay[] = [
    { dow: 4, opens: "08:00", closes: "20:00" },
    { dow: 5, opens: "00:00", closes: "06:00" },
  ];
  const ist = (s: string) => new Date(`${s}+05:30`);

  it("is open inside the window, from its opening minute to the minute before it closes", () => {
    expect(qrOpenAt(days, ist("2026-09-24T08:00:00"))).toEqual({ open: true, today: { opens: "08:00", closes: "20:00" } });
    expect(qrOpenAt(days, ist("2026-09-24T19:59:00")).open).toBe(true);
  });
  it("says when it opens before the window and when it closed after it", () => {
    expect(qrOpenAt(days, ist("2026-09-24T07:59:00"))).toEqual({ open: false, why: "QR ordering opens at 08:00 today.", today: { opens: "08:00", closes: "20:00" } });
    expect(qrOpenAt(days, ist("2026-09-24T20:00:00"))).toEqual({ open: false, why: "QR ordering closed at 20:00 today.", today: { opens: "08:00", closes: "20:00" } });
  });
  it("is closed all day on a weekday with no window, and on every day when none is set", () => {
    expect(qrOpenAt(days, ist("2026-09-27T12:00:00"))).toEqual({ open: false, why: "QR ordering is closed today.", today: null });
    expect(qrOpenAt([], ist("2026-09-24T12:00:00")).open).toBe(false);
  });
  it("reads the weekday in IST, not UTC, across both midnights", () => {
    // 18:45 UTC on Thursday is 00:15 IST on Friday: Friday's early window, not Thursday's closed evening.
    expect(qrOpenAt(days, new Date("2026-09-24T18:45:00Z"))).toEqual({ open: true, today: { opens: "00:00", closes: "06:00" } });
    // 18:29 UTC is still 23:59 IST on Thursday, after Thursday's window.
    expect(qrOpenAt(days, new Date("2026-09-24T18:29:00Z")).why).toBe("QR ordering closed at 20:00 today.");
    // 02:00 UTC on Thursday is 07:30 IST on Thursday - UTC's date and IST's agree, the hour does not.
    expect(qrOpenAt(days, new Date("2026-09-24T02:00:00Z")).why).toBe("QR ordering opens at 08:00 today.");
  });
});

describe("the refusals", () => {
  it("names the outlet and says why", () => {
    expect(hoursRefusal("Coffee Shop", { open: false, why: "QR ordering opens at 08:00 today.", today: null }))
      .toBe("Coffee Shop is not taking QR orders right now - QR ordering opens at 08:00 today.");
    expect(hoursRefusal("Coffee Shop", { open: false, today: null })).toBe("Coffee Shop is not taking QR orders right now - QR ordering is closed.");
    expect(pausedRefusal("Snack Kiosk")).toBe("Snack Kiosk has paused QR orders for now - please order at the counter.");
    expect(customerPhoneRefusal(" 12345 ")).toBe("12345 is not a phone number - enter your 10-digit mobile number, with or without +91.");
    expect(customerPhoneRefusal("  ")).toBe("That is not a phone number - enter your 10-digit mobile number, with or without +91.");
  });
});

describe("the caps", () => {
  it("holds one order to thirty lines of twenty, five thousand rupees, and a few unpaid at once", () => {
    expect([QR_MAX_LINES, QR_MAX_QTY, QR_MAX_RUPEES, QR_PENDING_PER_PHONE, QR_PENDING_PER_IP]).toEqual([30, 20, 5000, 3, 20]);
  });
  it("agrees with the wire's own caps on lines and quantity", () => {
    const body = (lines: number, qty: number) => ({
      nonce: "0b6f2c1e-8d4a-4f3b-9c2d-5e7a1b3c9d10", name: "A", phone: "9843022118",
      lines: Array.from({ length: lines }, (_, i) => ({ it: `it-${i}`, qty })),
    });
    expect(CreateQrOrderBodySchema.safeParse(body(QR_MAX_LINES, QR_MAX_QTY)).success).toBe(true);
    expect(CreateQrOrderBodySchema.safeParse(body(QR_MAX_LINES + 1, 1)).success).toBe(false);
    expect(CreateQrOrderBodySchema.safeParse(body(1, QR_MAX_QTY + 1)).success).toBe(false);
  });
});

describe("paise", () => {
  it("counts rupees in whole paise, without a float's tail", () => {
    expect(paise(40)).toBe(4000);
    expect(paise(40.1)).toBe(4010);
    expect(paise(0.29)).toBe(29);
    expect(paise(19.99)).toBe(1999);
  });
});

describe("QR_STATUS_WORDS", () => {
  it("has a sentence for every status", () => {
    for (const st of QrOrderStatusSchema.options) expect(QR_STATUS_WORDS[st].endsWith(".") || QR_STATUS_WORDS[st].endsWith("!"), st).toBe(true);
    expect(QR_STATUS_WORDS.Ready).toBe("Your order is ready - collect it at the counter.");
  });
});
