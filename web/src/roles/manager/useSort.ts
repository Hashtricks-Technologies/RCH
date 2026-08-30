import { useState } from "react";
import type { SortState } from "../../ui/kit";

/** What a row can be ordered on. Strings compare with locale rules, numbers numerically. */
export type SortValue = string | number;

/**
 * Click a header to sort by it, click the same header again to reverse.
 * Numbers open high-to-low (the interesting end first); text opens A-Z.
 */
export function useSort(key: string, dir: SortState["dir"] = "asc") {
  const [sort, setSort] = useState<SortState>({ key, dir });
  const onSort = (next: string) =>
    setSort((s) => (s.key === next ? { key: next, dir: s.dir === "asc" ? "desc" : "asc" } : { key: next, dir: "asc" }));
  return { sort, onSort };
}

/** Order a copy of `rows`; `val` says what each sort key reads off a row. */
export function sortRows<T>(rows: T[], sort: SortState, val: (r: T, key: string) => SortValue): T[] {
  const way = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = val(a, sort.key);
    const y = val(b, sort.key);
    if (typeof x === "number" && typeof y === "number") return (x - y) * way;
    return String(x).localeCompare(String(y), "en-IN") * way;
  });
}

/** Two empty states, so "nothing matches" never reads as "nothing exists". */
export const emptyFor = (filtered: boolean, none: { title: string; sub?: string }) =>
  filtered
    ? { title: "Nothing matches those filters", sub: "Clear the search box or set the filters back to All." }
    : none;
