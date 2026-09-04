import { describe, expect, it } from "vitest";
import { ledgerRow } from "./index.js";

describe("one line of the central store's stock ledger", () => {
  it("splits the window's signed moves into received and issued, and derives the close", () => {
    const r = ledgerRow("milk", 40, [37, -12, 3, -0.5]);
    expect(r).toEqual({ it: "milk", opening: 40, recd: 40, issued: 12.5, closing: 67.5 });
  });

  it("carries three decimals and no float dust", () => {
    // 0.1 + 0.2 is the reason round3 exists; a ledger that prints 0.30000000000000004 is a bug
    // an operator reports as "the report is broken", which is worse than being wrong by a gram.
    expect(ledgerRow("sugar", 0, [0.1, 0.2]).closing).toBe(0.3);
  });

  it("opens at whatever the moves before the window sum to, including nothing", () => {
    expect(ledgerRow("bread", 0, []).closing).toBe(0);
    expect(ledgerRow("bread", 0, [])).toEqual({ it: "bread", opening: 0, recd: 0, issued: 0, closing: 0 });
  });

  // There is no `ledgerTotals` beside this: the central store's ledger spans litres, kilos and
  // countable things, so its foot totals each column per unit (`unitTotal`) rather than adding
  // them into one number, and a rule with no caller is deleted rather than kept "for later".
});
