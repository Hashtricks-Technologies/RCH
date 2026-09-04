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
