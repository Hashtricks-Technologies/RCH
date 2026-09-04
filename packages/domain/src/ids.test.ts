import { describe, expect, it } from "vitest";
import { formatId, grnId, SEQUENCE_START } from "./ids";

const at = new Date("2026-09-03T10:00:00+05:30");

describe("formatId", () => {
  it("matches the formats the frontend already prints", () => {
    expect(formatId("req", 913, at)).toBe("REQ-2026-0913");
    expect(formatId("tkt", 441, at)).toBe("TKT-0441");
    expect(formatId("bill", 1188, at)).toBe("CF/1188");
    expect(formatId("prq", 16, at)).toBe("PRQ-2026-016");
    expect(formatId("po", 143, at)).toBe("PO-2026-0143");
    expect(formatId("prd", 31, at)).toBe("PRD-2026-031");
    expect(formatId("batch", 1, at)).toBe("BAT-20260903-01");
    expect(formatId("vendor", 6, at)).toBe("VN-006");
    expect(formatId("contract", 109, at)).toBe("RC-109");
    expect(formatId("support", 45, at)).toBe("SUP-0045");
    expect(formatId("product_req", 13, at)).toBe("NPR-0013");
    expect(formatId("shop_ask", 62, at)).toBe("ASK-062");
  });
  it("continues each seeded series rather than restarting it", () => {
    expect(SEQUENCE_START.req).toBe(913);
    expect(SEQUENCE_START.tkt).toBe(441);
    expect(SEQUENCE_START.bill).toBe(1188);
    expect(SEQUENCE_START.support).toBe(44);
    expect(SEQUENCE_START.product_req).toBe(13);
    expect(SEQUENCE_START.contract).toBe(109);
    expect(SEQUENCE_START.shop_ask).toBe(63);
  });
});

describe("a goods receipt's number", () => {
  it("carries the year and the whole order number, so two orders cannot share it", () => {
    expect(grnId("PO-2026-0143", 1)).toBe("GRN-260143-01");
    expect(grnId("PO-2026-0143", 2)).toBe("GRN-260143-02");
    // The old format was the last three characters of the PO id, which these three share.
    expect(grnId("PO-2027-0143", 1)).not.toBe(grnId("PO-2026-0143", 1));
    expect(grnId("PO-2026-1143", 1)).not.toBe(grnId("PO-2026-0143", 1));
  });

  it("pads the instalment to two, like a batch's", () => {
    expect(grnId("PO-2026-0143", 12)).toBe("GRN-260143-12");
  });
});
