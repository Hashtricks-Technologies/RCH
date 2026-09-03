import { routes, type Changed } from "@rch/contract";
import { call } from "./client";
import { applyBills, applyStock } from "./wire";
import { useApp } from "../store";

/** The slices `GET /stock` answers for, in one call. */
const STOCK: readonly Changed[] = ["stock", "rsv", "ovr"];

/**
 * Pull back exactly what a write said it changed.
 *
 * `stock`/`rsv`/`ovr` come from `GET /stock` and `bills` from `GET /bills`, each fetched
 * at most once however many times the write named them. Anything else — prices, menus, the
 * document slices — has no narrow reader yet, so it costs one snapshot; phase 3 replaces
 * that with SSE and finer GETs.
 */
export async function refetch(changed: readonly Changed[]): Promise<void> {
  const want = new Set<Changed>(changed);
  try {
    if ([...want].some((c) => c !== "bills" && !STOCK.includes(c))) {
      await useApp.getState().loadSnapshot();
      return;
    }
    await Promise.all([
      ...(STOCK.some((c) => want.has(c)) ? [call(routes.stock).then(applyStock)] : []),
      ...(want.has("bills") ? [call(routes.bills).then(applyBills)] : []),
    ]);
  } catch {
    // The write itself landed; only the read-back did not. Saying "could not take the bill"
    // here would send the operator round to do it a second time, so this names what actually
    // failed. (`loadSnapshot` reports its own failures and never throws.)
    useApp.getState().notify("Saved — but the screen could not be refreshed. Reload to see the latest.");
  }
}
