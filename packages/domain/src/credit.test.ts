import { describe, expect, it } from "vitest";
import { STAFF_CREDIT_LIMIT, breachesCredit, creditBreachMessage, creditRoom } from "./credit";

describe("the staff credit ceiling", () => {
  it("is three thousand rupees a month", () => {
    expect(STAFF_CREDIT_LIMIT).toBe(3000);
  });

  it("lets a bill land exactly on the ceiling, and refuses the rupee after it", () => {
    expect(breachesCredit(2980, 20)).toBe(false);
    expect(breachesCredit(3000, 0)).toBe(false);
    expect(breachesCredit(2990, 20)).toBe(true);
    expect(breachesCredit(0, 3000.01)).toBe(true);
  });

  it("says how much room is left, and never a negative amount", () => {
    expect(creditRoom(2980)).toBe(20);
    expect(creditRoom(0)).toBe(3000);
    expect(creditRoom(3200)).toBe(0);
    expect(creditRoom(1000, 1500)).toBe(500);
    expect(creditRoom(0.1 + 0.2)).toBe(2999.7);        // two decimals, not 2999.7000000000003
  });

  it("writes the refusal the counter already reads on the screen, grouped the Indian way", () => {
    expect(creditBreachMessage(2990, 20, "Vinoth Prakash · Kitchen"))
      .toBe("₹3,010.00 breaches the ₹3,000 staff credit limit for Vinoth Prakash · Kitchen. Take another tender or split the bill.");
    // Above a lakh the grouping changes; en-IN must be doing that on this runtime, not en-US.
    expect(creditBreachMessage(150000, 0, "Someone", 200000))
      .toBe("₹1,50,000.00 breaches the ₹2,00,000 staff credit limit for Someone. Take another tender or split the bill.");
  });
});
