import { describe, expect, it } from "vitest";
import { createRequisitionsService } from "./service.js";

describe("requisitions", () => {
  it("compiles and exports a service factory", () => {
    expect(typeof createRequisitionsService).toBe("function");
  });
});
