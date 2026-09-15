import { describe, expect, it } from "vitest";
import { formatId, grnId, nextEmpNo, SEQUENCE_START } from "./ids";

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
    expect(formatId("price_list", 6, at)).toBe("PL-006");
  });
  it("continues each seeded series rather than restarting it", () => {
    expect(SEQUENCE_START.req).toBe(913);
    expect(SEQUENCE_START.tkt).toBe(441);
    expect(SEQUENCE_START.bill).toBe(1188);
    expect(SEQUENCE_START.support).toBe(44);
    expect(SEQUENCE_START.product_req).toBe(13);
    expect(SEQUENCE_START.contract).toBe(109);
    expect(SEQUENCE_START.shop_ask).toBe(63);
    expect(SEQUENCE_START.price_list).toBe(3);
  });
});

describe("a goods receipt's number", () => {
  it("carries the year and the whole order number, so two orders cannot share it", () => {
    expect(grnId("PO-2026-0143", 1)).toBe("GRN-260143-01");
    expect(grnId("PO-2026-0143", 2)).toBe("GRN-260143-02");
    // The old format was the last three characters of the PO id, which these three share.
    expect(grnId("PO-2027-0143", 1)).toBe("GRN-270143-01");
    expect(grnId("PO-2026-1143", 1)).toBe("GRN-261143-01");
    expect(grnId("PO-2027-0143", 1)).not.toBe(grnId("PO-2026-0143", 1));
    expect(grnId("PO-2026-1143", 1)).not.toBe(grnId("PO-2026-0143", 1));
  });

  it("pads the instalment to two, like a batch's", () => {
    expect(grnId("PO-2026-0143", 12)).toBe("GRN-260143-12");
  });
});

// ---- adjustments
describe("an adjustment's number", () => {
  it("carries the year and four digits, so a list of them sorts as text", () => {
    expect(formatId("adj", 1, at)).toBe("ADJ-2026-0001");
    expect(formatId("adj", 12, at)).toBe("ADJ-2026-0012");
    expect(formatId("adj", 1043, at)).toBe("ADJ-2026-1043");
  });
  it("takes the hospital's own calendar date, not the host's", () => {
    // 00:30 on the 1st of January in Chennai is still the 31st of December in UTC. The series
    // is per year, so the wrong answer here would restart the numbering a day early.
    expect(formatId("adj", 1, new Date("2027-01-01T00:30:00+05:30"))).toBe("ADJ-2027-0001");
  });
  it("starts at one - nothing was ever written off through a document before", () => {
    expect(SEQUENCE_START.adj).toBe(1);
  });
});

// ---- adjustment requests
describe("an adjustment request's number", () => {
  it("carries the year, the same shape a stock request's does", () => {
    expect(formatId("adj_req", 1, at)).toBe("ADJREQ-2026-01");
    expect(formatId("adj_req", 12, at)).toBe("ADJREQ-2026-012");
  });
  it("starts at one - nothing was ever raised through this door before", () => {
    expect(SEQUENCE_START.adj_req).toBe(1);
  });
});

describe("the next employee number", () => {
  it("is one past the highest, four digits at least", () => {
    expect(nextEmpNo(["RC-0001"])).toBe("RC-0002");
    expect(nextEmpNo(["RC-4471", "RC-0001", "RC-4482", "RC-3120"])).toBe("RC-4483");
    expect(nextEmpNo(["RC-0009"])).toBe("RC-0010");
  });
  it("starts at RC-0001 when there is nobody yet", () => {
    expect(nextEmpNo([])).toBe("RC-0001");
  });
  it("skips a number typed in another shape rather than parsing it", () => {
    expect(nextEmpNo(["RC-0004", "E2291", "rc-9000", "RC-12a"])).toBe("RC-0005");
  });
  it("keeps a wider number's width once the series has grown past four digits", () => {
    expect(nextEmpNo(["RC-9999"])).toBe("RC-10000");
    expect(nextEmpNo(["RC-00120", "RC-0005"])).toBe("RC-00121");
  });
});
