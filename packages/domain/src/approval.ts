import { round3 } from "./round.js";

export type ApprovalLine = { it: string; qty: number; appr: number; short: number };
export type ApprovalPlan = {
  lines: ApprovalLine[];
  st: "Rejected" | "Manager approved" | "Partially approved";
  trimmed: boolean;
};

/**
 * Which approved status a set of decided lines amounts to. Written once because two callers
 * need the same answer: the approval that first reaches it, and a cancelled ticket putting the
 * request back where the manager left it.
 */
export const approvedStatus = (lines: readonly { qty: number; appr: number }[]): "Manager approved" | "Partially approved" =>
  lines.every((l) => l.appr === l.qty) ? "Manager approved" : "Partially approved";

/** Which decision a set of requisition lines amounts to. A requisition that approves nothing is
 *  a decline in all but name, and the store keeper reads it as one. */
export const prqStatus = (lines: readonly { qty: number; appr: number }[]): "Declined" | "Approved" | "Partially approved" =>
  lines.every((l) => l.appr === 0) ? "Declined"
    : lines.every((l) => l.appr === l.qty) ? "Approved" : "Partially approved";

/**
 * The buyer's decision on a requisition. Never more than the store keeper asked for and never
 * more than the buyer typed — and, unlike a stock request's approval, **never netted against
 * free to promise**: what the central store is holding has nothing to do with what a vendor can
 * supply. That is why this takes no `freeFor` callback and `planApproval` does.
 */
export function planPrqApproval(
  lines: readonly { it: string; qty: number }[], appr: readonly number[],
): { lines: ApprovalLine[]; st: "Declined" | "Approved" | "Partially approved" } {
  const out: ApprovalLine[] = lines.map((l, i) => {
    const want = Number.isFinite(appr[i]) ? appr[i] : 0;
    const ok = round3(Math.max(0, Math.min(l.qty, want)));
    return { it: l.it, qty: l.qty, appr: ok, short: round3(l.qty - ok) };
  });
  return { lines: out, st: prqStatus(out) };
}

/**
 * What the manager may actually promise. Never more than the counter asked for, never more
 * than the manager typed, and never more than is still free to promise once open tickets and
 * other approvals are netted off (C6). `trimmed` says the store, not the manager, is what cut
 * the line — a manager who deliberately types a smaller number has trimmed nothing.
 */
export function planApproval(
  lines: readonly { it: string; qty: number }[],
  appr: readonly number[],
  freeFor: (it: string, index: number) => number,
): ApprovalPlan {
  const asked = (i: number) => (Number.isFinite(appr[i]) ? appr[i] : 0);
  const out: ApprovalLine[] = lines.map((l, i) => {
    const ok = Math.max(0, round3(Math.min(l.qty, asked(i), freeFor(l.it, i))));
    return { it: l.it, qty: l.qty, appr: ok, short: round3(l.qty - ok) };
  });
  const total = out.reduce((t, l) => t + l.appr, 0);
  const st = total === 0 ? "Rejected" : approvedStatus(out);
  const trimmed = out.some((l, i) => l.appr < Math.min(l.qty, asked(i)));
  return { lines: out, st, trimmed };
}
