import { describe, expect, it } from "vitest";
import { createAvailabilityService } from "./service.js";

describe("availability", () => {
  it("is registered and inert until Wave 3 gives it routes", () => {
    expect(typeof createAvailabilityService).toBe("function");
  });
});
