// The 422 half of every write (spec §9.2): the pos, availability and catalog modules refuse
// through here, and later phases add their own callers.
import { RuleError } from "./errors.js";

/**
 * A domain rule. `message` is the sentence the operator reads in the toast.
 * @public — consumed by Phase 2 write endpoints (spec §9.2).
 */
export function assertRule(cond: unknown, message: string, details?: unknown): asserts cond {
  if (!cond) throw new RuleError(message, details);
}
