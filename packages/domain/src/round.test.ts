import { describe, expect, it } from "vitest";
import { round3 } from "./round";

describe("round3", () => {
  it("keeps three decimals and kills float noise", () => {
    expect(round3(0.1 + 0.2)).toBe(0.3);
    expect(round3(12 - 0.15 * 3)).toBe(11.55);
    expect(round3(2.0005)).toBe(2.001);
  });
});
