import { describe, expect, it } from "vitest";
import { createPosService } from "./service.js";

describe("pos", () => {
  it("is registered and inert until Wave 3 gives it routes", () => {
    expect(typeof createPosService).toBe("function");
  });
});
