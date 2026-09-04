import { round3 } from "./round.js";

/**
 * A purchase-order line's claim on the requisition lines that funded it.
 *
 * The procurement list is derived — approved less ordered, `procurementList` in the frontend —
 * so there is no pool to keep in sync: moving `requisition_lines.ordered_qty` is the only thing
 * that adds to it or takes from it. These three functions are the whole of that arithmetic, and
 * both sides read them: the server settles the claim, the buyer's screen previews what a change
 * would give back.
 */
export type ClaimSrc = { prq: string; line: number; qty: number };

/**
 * Give `give` back off a line's sources, **last source first**.
 *
 * A line can be funded by several requisitions, added in the order the buyer picked them. The
 * newest claim is the one to release first: it is the one the buyer is most likely undoing, and
 * a fixed direction is what makes a shrink-then-grow round trip land back where it started
 * rather than quietly moving demand between two store keepers' requisitions.
 */
export function releaseClaim(src: readonly ClaimSrc[], give: number): { released: ClaimSrc[]; left: ClaimSrc[] } {
  let owed = round3(Math.max(0, give));
  const released: ClaimSrc[] = [];
  const left: ClaimSrc[] = [];
  for (const x of [...src].reverse()) {
    const take = Math.min(owed, x.qty);
    owed = round3(owed - take);
    if (take > 0) released.push({ ...x, qty: round3(take) });
    const keep = round3(x.qty - take);
    if (keep > 0) left.unshift({ ...x, qty: keep });
  }
  return { released, left };
}

/** Every delta against the same requisition line, added up and sorted by (requisition, line) —
 *  which is also the order a writer takes its row locks in. */
export function foldClaims(src: readonly ClaimSrc[]): ClaimSrc[] {
  const by = new Map<string, ClaimSrc>();
  for (const x of src) {
    const key = `${x.prq}␟${x.line}`;
    const at = by.get(key);
    if (at) at.qty = round3(at.qty + x.qty);
    else by.set(key, { prq: x.prq, line: x.line, qty: round3(x.qty) });
  }
  return [...by.values()].sort((a, b) => a.prq.localeCompare(b.prq) || a.line - b.line);
}

/** What never arrived, per line, released last source first — a close-short's whole answer. */
export function shortfallClaims(lines: readonly { qty: number; recv: number; src: readonly ClaimSrc[] }[]): ClaimSrc[] {
  return lines.flatMap((l) => releaseClaim(l.src, round3(Math.max(0, l.qty - l.recv))).released);
}
