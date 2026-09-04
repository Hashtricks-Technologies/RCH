import { describe, expect, it } from "vitest";
import { createPurchaseOrdersService } from "./service.js";

describe("purchaseorders", () => {
  it("compiles and exports a service factory", () => {
    expect(typeof createPurchaseOrdersService).toBe("function");
  });
});
