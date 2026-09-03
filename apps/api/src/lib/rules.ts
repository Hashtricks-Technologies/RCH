// Nothing imports this yet: the Phase 2 write endpoints (spec §9.2) are its
// callers, which is why knip.json lists it under `ignoreFiles`.
import { RuleError } from "./errors.js";

/**
 * A domain rule. `message` is the sentence the operator reads in the toast.
 * @public — consumed by Phase 2 write endpoints (spec §9.2).
 */
export function assertRule(cond: unknown, message: string, details?: unknown): asserts cond {
  if (!cond) throw new RuleError(message, details);
}
