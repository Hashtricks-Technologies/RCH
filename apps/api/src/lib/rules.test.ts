import { describe, expect, it } from "vitest";
import { TICKET_TRANSITIONS } from "@rch/domain";
import { assertRule, assertTransition } from "./rules.js";
import { RuleError } from "./errors.js";

describe("assertRule", () => {
  it("passes silently when the condition holds", () => {
    expect(() => assertRule(true, "unreachable")).not.toThrow();
  });
  it("throws a RuleError carrying the message when the condition fails", () => {
    try {
      assertRule(false, "Choose a different password from your current one.");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RuleError);
      expect((err as RuleError).message).toBe("Choose a different password from your current one.");
      expect((err as RuleError).status).toBe(422);
    }
  });
  it("assertTransition refuses a status change the table does not list, in the operator's words", () => {
    expect(() => assertTransition(TICKET_TRANSITIONS, "Received", "Collected", "TKT-0440")).toThrow(RuleError);
    expect(() => assertTransition(TICKET_TRANSITIONS, "Received", "Collected", "TKT-0440")).toThrow("TKT-0440 is already received");
    expect(() => assertTransition(TICKET_TRANSITIONS, "Issued", "Collected", "TKT-0440")).not.toThrow();
  });
  it("attaches details when given", () => {
    try {
      assertRule(false, "bad", { field: "x" });
      expect.unreachable();
    } catch (err) {
      expect((err as RuleError).details).toEqual({ field: "x" });
    }
  });
});
