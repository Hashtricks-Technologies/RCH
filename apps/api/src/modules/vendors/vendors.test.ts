import { describe, expect, it } from "vitest";
import { createVendorsService } from "./service.js";

describe("vendors", () => {
  it("compiles and exports a service factory", () => {
    expect(typeof createVendorsService).toBe("function");
  });
});
