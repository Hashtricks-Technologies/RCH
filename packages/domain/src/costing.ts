import type { Master } from "./master.js";

/** Σ(ingredient × its cost) plus the recipe's overhead. 0 when there is no recipe (H1). */
export function recipeCost(m: Master, it: string): number {
  const r = m.recipes[it];
  if (!r) return 0;
  const raw = r.l.reduce((t, [g, q]) => t + q * (m.items[g]?.cost ?? 0), 0);
  return raw * (1 + r.ov / 100);
}

/** What a unit of this item actually costs — from its recipe if it has one. */
export const costOf = (m: Master, it: string): number => (m.recipes[it] ? recipeCost(m, it) : m.items[it]?.cost ?? 0);
