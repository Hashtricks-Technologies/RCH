import { describe, expect, it } from "vitest";
import { defaultSourceFor, sourceOf } from "./routing";

describe("defaultSourceFor", () => {
  it("routes a finished good to the kitchen and everything else to the store", () => {
    expect(defaultSourceFor("FG")).toBe("kitchen");
    for (const t of ["RAW", "PACK", "MRP", "MTO"] as const) expect(defaultSourceFor(t)).toBe("store");
  });
});

describe("sourceOf", () => {
  it("reads the item's own src when it has one", () => {
    expect(sourceOf({ t: "RAW", src: "kitchen" })).toBe("kitchen");
    expect(sourceOf({ t: "FG", src: "store" })).toBe("store");
  });

  it("falls back to the type's default when none is set", () => {
    expect(sourceOf({ t: "FG" })).toBe("kitchen");
    expect(sourceOf({ t: "MRP" })).toBe("store");
  });
});
