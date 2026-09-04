import { describe, expect, it } from "vitest";
import { createContractsService } from "./service.js";

describe("contracts", () => {
  it("compiles and exports a service factory", () => {
    expect(typeof createContractsService).toBe("function");
  });
});
