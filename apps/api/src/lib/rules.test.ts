import { describe, expect, it } from "vitest";
import { assertRule } from "./rules.js";
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
  it("attaches details when given", () => {
    try {
      assertRule(false, "bad", { field: "x" });
      expect.unreachable();
    } catch (err) {
      expect((err as RuleError).details).toEqual({ field: "x" });
    }
  });
});
