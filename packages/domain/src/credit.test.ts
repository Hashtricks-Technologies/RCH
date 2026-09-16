import { describe, expect, it } from "vitest";
import { STAFF_CREDIT_LIMIT, breachesCredit, creditBreachMessage, creditRoom } from "./credit";

describe("the credit ceiling", () => {
  it("seeds the staff category at three thousand rupees", () => {
    expect(STAFF_CREDIT_LIMIT).toBe(3000);
  });

  it("lets a bill land exactly on the ceiling, and refuses the rupee after it", () => {
    expect(breachesCredit(2980, 20, 3000)).toBe(false);
    expect(breachesCredit(3000, 0, 3000)).toBe(false);
    expect(breachesCredit(2990, 20, 3000)).toBe(true);
    expect(breachesCredit(0, 3000.01, 3000)).toBe(true);
  });

  it("refuses nothing at all when the manager set no ceiling", () => {
    // `null` is a consultant the till is not meant to argue with. It is emphatically not zero,
    // which is a department switched off for the month - also a thing somebody meant.
    expect(breachesCredit(999999, 5000, null)).toBe(false);
    expect(breachesCredit(0, 0.01, 0)).toBe(true);
  });

  it("says how much room is left, and never a negative amount", () => {
    expect(creditRoom(2980, 3000)).toBe(20);
    expect(creditRoom(0, 3000)).toBe(3000);
    expect(creditRoom(3200, 3000)).toBe(0);
    expect(creditRoom(1000, 1500)).toBe(500);
    expect(creditRoom(0.1 + 0.2, 3000)).toBe(2999.7);   // two decimals, not 2999.7000000000003
  });

  it("answers `null` for the room under no ceiling, so a screen prints words and not a number", () => {
    expect(creditRoom(1200, null)).toBeNull();
  });

  it("writes the refusal the counter already reads on the screen, grouped the Indian way", () => {
    expect(creditBreachMessage(2990, 20, "Vinoth Prakash · Kitchen", 3000))
      .toBe("₹3,010.00 breaches the ₹3,000 credit limit for Vinoth Prakash · Kitchen. Settle the account, take another tender, or split the bill.");
    // Above a lakh the grouping changes; en-IN must be doing that on this runtime, not en-US.
    expect(creditBreachMessage(150000, 0, "Dr A. Rao · Cardiology", 200000))
      .toBe("₹1,50,000.00 breaches the ₹2,00,000 credit limit for Dr A. Rao · Cardiology. Settle the account, take another tender, or split the bill.");
  });
});
