import { describe, expect, it } from "vitest";
import { createProductReqsService } from "./service.js";

describe("productreqs", () => {
  it("compiles and exports a service factory", () => {
    expect(typeof createProductReqsService).toBe("function");
  });
});
