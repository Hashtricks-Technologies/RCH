import { vendorName } from "../../data/vendors";
import { apportion, round3 } from "../../lib/selectors";
import type { AppState } from "../../store";
import type { PoStatus, PurchaseOrder, RateContract, Requisition, Vendor } from "../../types";

/**
 * A rate contract records its vendor by name, while a purchase order carries
 * the vendor's id — both are tried so a contract resolves whichever way the
 * store keeper recorded it.
 */
export function contractFor(
  s: Pick<AppState, "contractRate" | "vendors">, vendorId: string, it: string,
): RateContract | undefined {
  return s.contractRate(vendorName(s.vendors, vendorId), it) ?? s.contractRate(vendorId, it);
}

/** Every contract on file for one vendor, live ones first. */
export const contractsOf = (contracts: RateContract[], v: Vendor): RateContract[] =>
  contracts
    .filter((c) => c.vendor === v.n || c.vendor === v.id)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.it.localeCompare(b.it));

export const liveContractsOf = (contracts: RateContract[], v: Vendor): RateContract[] =>
  contractsOf(contracts, v).filter((c) => c.active);

export type PrqLineStatus = "Not ordered" | "Ordered" | "Partially received" | "Received";

/** One purchase order's claim on a single requisition line. */
export interface PrqOrderRef {
  po: string; vendor: string; qty: number; rate: number; eta: string;
  recv: number; st: PoStatus;
}

export interface PrqLineRecon {
  i: number; it: string;
  /** What the store keeper asked for. */
  asked: number;
  /** What procurement approved. */
  appr: number;
  /** What purchase orders actually claim against this line. */
  ordered: number;
  /** What has landed against this line so far. */
  received: number;
  orders: PrqOrderRef[];
  status: PrqLineStatus;
}

/**
 * Reconcile a requisition against the purchase orders raised from it.
 *
 * Every `PoLine` carries `src: { prq, line, qty }[]` naming the requisition
 * lines that funded it, so ordered quantity is read straight off those claims
 * rather than guessed by matching item codes. Receipts are split back over the
 * same sources with `apportion()` — the identical, order-of-`src` rule
 * `prqProgress()` uses — so the two never disagree. Cancelled orders release
 * their claim, so they are skipped here too.
 */
export function reconcile(
  s: { po: PurchaseOrder[]; vendors: Vendor[] }, p: Requisition,
): PrqLineRecon[] {
  return p.lines.map((l, i) => {
    const orders: PrqOrderRef[] = [];
    let ordered = 0;
    let received = 0;
    for (const o of s.po) {
      if (o.st === "Cancelled") continue;
      for (const pl of o.lines) {
        const got = apportion(pl.recv, pl.src);
        pl.src.forEach((x, si) => {
          if (x.prq !== p.id || x.line !== i) return;
          ordered = round3(ordered + x.qty);
          received = round3(received + got[si]);
          orders.push({
            po: o.id, vendor: vendorName(s.vendors, o.vendor), qty: x.qty,
            rate: pl.rate, eta: o.eta, recv: got[si], st: o.st,
          });
        });
      }
    }
    const status: PrqLineStatus =
      ordered <= 0 ? "Not ordered"
        : received <= 0 ? "Ordered"
          : received < ordered ? "Partially received" : "Received";
    return { i, it: l.it, asked: l.qty, appr: l.appr, ordered, received, orders, status };
  });
}

export interface PrqRecap {
  appr: number; ordered: number; received: number;
  done: number; total: number; label: PrqLineStatus | "Awaiting a decision";
}

/** The same reconciliation, rolled up for a list row. */
export function recap(rows: PrqLineRecon[], decided: boolean): PrqRecap {
  const appr = round3(rows.reduce((t, r) => t + r.appr, 0));
  const ordered = round3(rows.reduce((t, r) => t + r.ordered, 0));
  const received = round3(rows.reduce((t, r) => t + r.received, 0));
  const done = rows.filter((r) => r.status === "Received").length;
  const label: PrqRecap["label"] = !decided ? "Awaiting a decision"
    : ordered <= 0 ? "Not ordered"
      : received <= 0 ? "Ordered"
        : received < ordered ? "Partially received" : "Received";
  return { appr, ordered, received, done, total: rows.length, label };
}
