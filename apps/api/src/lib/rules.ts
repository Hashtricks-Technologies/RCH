import { RuleError } from "./errors.js";

/** A domain rule. `message` is the sentence the operator reads in the toast. */
export function assertRule(cond: unknown, message: string, details?: unknown): asserts cond {
  if (!cond) throw new RuleError(message, details);
}
