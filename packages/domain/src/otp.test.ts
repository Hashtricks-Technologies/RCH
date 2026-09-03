import { describe, expect, it } from "vitest";
import { makeOtp } from "./otp";

describe("makeOtp", () => {
  it("is six digits and deterministic for a seed", () => {
    expect(makeOtp(441)).toMatch(/^\d{6}$/);
    expect(makeOtp(441)).toBe(makeOtp(441));
    expect(makeOtp(441)).not.toBe(makeOtp(442));
  });
});
