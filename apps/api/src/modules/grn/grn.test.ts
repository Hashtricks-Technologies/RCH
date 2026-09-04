import { describe, expect, it } from "vitest";
import { createGrnService } from "./service.js";

describe("grn", () => {
  it("compiles and exports a service factory", () => {
    expect(typeof createGrnService).toBe("function");
  });
});
