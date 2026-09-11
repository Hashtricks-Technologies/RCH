import { describe, expect, it } from "vitest";
import { AdjustReasonSchema } from "@rch/contract";
import { REASON_LABEL } from "./adjustments";

describe("how a correction to a shelf is written out", () => {
  it("gives each reason the words the trail and the screen both print", () => {
    expect(REASON_LABEL.wastage).toBe("Wastage");
    expect(REASON_LABEL.breakage).toBe("Breakage");
    expect(REASON_LABEL.expired).toBe("Expired");
    // Not "Count": what the operator did was a stock count, and the trail reads as a sentence.
    expect(REASON_LABEL.count).toBe("Stock count");
    expect(REASON_LABEL.returned_to_vendor).toBe("Returned to vendor");
    expect(REASON_LABEL.other).toBe("Other");
  });

  it("answers for every reason the wire can carry, and no more", () => {
    // A seventh reason added to the schema without a word here would reach the trail as
    // `undefined`; this is what fails first when that happens.
    expect(Object.keys(REASON_LABEL).sort()).toEqual([...AdjustReasonSchema.options].sort());
  });
});
