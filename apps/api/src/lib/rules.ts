// No production caller yet: the Phase 2 write endpoints (spec §9.2) are its callers.
// rules.test.ts exercises it directly in the meantime.
import { RuleError } from "./errors.js";

/**
 * A domain rule. `message` is the sentence the operator reads in the toast.
 * @public — consumed by Phase 2 write endpoints (spec §9.2).
 */
export function assertRule(cond: unknown, message: string, details?: unknown): asserts cond {
  if (!cond) throw new RuleError(message, details);
}
