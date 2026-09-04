// The 422 half of every write (spec §9.2): the pos, availability and catalog modules refuse
// through here, and later phases add their own callers.
import { canTransition, type TransitionTable } from "@rch/domain";
import { RuleError } from "./errors.js";

/**
 * A domain rule. `message` is the sentence the operator reads in the toast.
 * @public — consumed by Phase 2 write endpoints (spec §9.2).
 */
export function assertRule(cond: unknown, message: string, details?: unknown): asserts cond {
  if (!cond) throw new RuleError(message, details);
}

/**
 * Spec §5.1: the transition table is data, and both sides read it. The UI hides the button;
 * this is what happens when a stale tab presses it anyway.
 */
export function assertTransition<S extends string>(table: TransitionTable<S>, from: S, to: S, what: string): void {
  assertRule(canTransition(table, from, to), `${what} is already ${String(from).toLowerCase()}`);
}
