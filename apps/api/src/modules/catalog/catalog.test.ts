import { describe, expect, it } from "vitest";
import { createCatalogService } from "./service.js";

describe("catalog", () => {
  it("is registered and inert until Wave 3 gives it routes", () => {
    expect(typeof createCatalogService).toBe("function");
  });
});
