export type * from "@rch/contract";

// ---- bill void ----
import type { Bill } from "@rch/contract";
/**
 * A bill as the store holds it. The wire carries one ISO instant and the screens have always
 * shown "HH:MM", so `applyBills` converts `t` and keeps the instant beside it under `iso` — a
 * seven-day list cannot say which day a bill belongs to out of "09:12" alone, and the void
 * button has to know whether the bill is still today's before it offers itself.
 *
 * Optional because the fixtures the test suites seed from carry display strings, not instants:
 * a screen treats a missing `iso` as "which day this is cannot be told from here".
 */
export type BillRow = Bill & { iso?: string };
