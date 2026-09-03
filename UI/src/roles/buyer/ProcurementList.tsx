import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IT, LOC } from "../../data/master";
import { suggestVendor, vendorName } from "../../data/vendors";
import { useApp } from "../../store";
import { costOf, procurementList, qty, round3 } from "../../lib/selectors";
import { fq, money, money0, sum, U } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, FilterSelect, Grid, PageHead, Tag, TableFoot, Toolbar,
} from "../../ui/kit";
import type { Row } from "../../ui/kit";
import type { PoolLine } from "../../lib/selectors";
import type { Vendor } from "../../types";
import { contractFor } from "./lib";

const NO_VENDOR = "No suggested vendor";
const STOCK_STATES = ["All", "Below reorder", "At or above reorder"];

export interface PoolGroup {
  it: string;
  pending: number;
  sources: PoolLine[];
  vendor: Vendor | null;
}

/**
 * Several requisitions asking for the same item must read as one row — that
 * folding is the whole point of this screen, so it is a pure, testable step
 * rather than something buried in JSX.
 */
export function groupPool(pool: PoolLine[], vendors: Vendor[]): PoolGroup[] {
  const groups: PoolGroup[] = [];
  for (const line of pool) {
    const g = groups.find((x) => x.it === line.it);
    if (g) {
      g.pending = round3(g.pending + line.pending);
      g.sources.push(line);
    } else {
      groups.push({
        it: line.it,
        pending: line.pending,
        sources: [line],
        vendor: suggestVendor(vendors, IT[line.it]?.g ?? ""),
      });
    }
  }
  return groups;
}

export interface Pick { prq: string; line: number; qty: number }

/**
 * Spread a requested quantity across a group's sources, oldest pick first,
 * never taking more than a single source still has pending. Splitting one
 * pooled row across two vendors is just calling this twice on the same group
 * with two smaller quantities — no separate UI is needed for that.
 */
export function picksFor(g: PoolGroup, wanted: number): Pick[] {
  let left = round3(Math.max(0, wanted));
  const picks: Pick[] = [];
  for (const src of g.sources) {
    if (left <= 0) break;
    const take = round3(Math.min(left, src.pending));
    if (take > 0) {
      picks.push({ prq: src.prq, line: src.line, qty: take });
      left = round3(left - take);
    }
  }
  return picks;
}

/**
 * A purchase order is always to ONE vendor, so a selection spanning several
 * vendors becomes several orders — grouped here rather than forcing one vendor
 * across the whole selection, which is what lets a buyer clear a list whose
 * items come from different suppliers in a single pass.
 */
export function ordersFor(
  picked: { group: PoolGroup; vendor: string; qty: number }[],
): { vendor: string; picks: Pick[] }[] {
  const byVendor = new Map<string, Pick[]>();
  for (const { group, vendor, qty: want } of picked) {
    const p = picksFor(group, want);
    if (!vendor || !p.length) continue;
    byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), ...p]);
  }
  return [...byVendor].map(([vendor, picks]) => ({ vendor, picks }));
}

export default function ProcurementList() {
  const s = useApp();
  const createPo = useApp((x) => x.createPo);
  const notify = useApp((x) => x.notify);
  const nav = useNavigate();

  const [q, setQ] = useState("");
  const [groupFilter, setGroupFilter] = useState("All");
  const [vendorFilter, setVendorFilter] = useState("All");
  const [stockFilter, setStockFilter] = useState("All");
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [qtyOverride, setQtyOverride] = useState<Record<string, number>>({});
  // Vendor is chosen PER LINE, not once for the whole order — the same item can
  // legitimately come from several suppliers, and the buyer picks which one on
  // the row itself. An unset entry means "still following the suggestion".
  const [vendorFor, setVendorFor] = useState<Record<string, string>>({});

  const groups = groupPool(procurementList(s), s.vendors);
  const qtyFor = (g: PoolGroup) => qtyOverride[g.it] ?? g.pending;
  const setQtyForItem = (g: PoolGroup, v: number) =>
    setQtyOverride((m) => ({ ...m, [g.it]: Math.max(0, Math.min(v, g.pending)) }));
  const toggle = (it: string) => setSel((m) => ({ ...m, [it]: !m[it] }));
  const vendorOf = (g: PoolGroup) => vendorFor[g.it] ?? g.vendor?.id ?? "";

  const GROUPS = ["All", ...[...new Set(groups.map((g) => IT[g.it]?.g ?? ""))].sort()];
  const VENDOR_NAMES = ["All", ...[...new Set(groups.map((g) => g.vendor?.n ?? NO_VENDOR))].sort()];

  const t = q.trim().toLowerCase();
  const belowReorder = (it: string) => {
    const rl = IT[it]?.rl ?? 0;
    return rl > 0 && qty(s, "store", it) < rl;
  };
  const shown = groups.filter((g) => {
    const it = IT[g.it];
    return (groupFilter === "All" || it?.g === groupFilter)
      && (vendorFilter === "All" || (g.vendor?.n ?? NO_VENDOR) === vendorFilter)
      && (stockFilter === "All"
        || (stockFilter === "Below reorder" ? belowReorder(g.it) : !belowReorder(g.it)))
      && (!t || it?.n.toLowerCase().includes(t) || it?.c.toLowerCase().includes(t)
        || it?.g.toLowerCase().includes(t)
        || g.sources.some((src) => src.prq.toLowerCase().includes(t)));
  });
  const narrowed = t !== "" || groupFilter !== "All" || vendorFilter !== "All" || stockFilter !== "All";
  const clearFilters = () => {
    setQ("");
    setGroupFilter("All");
    setVendorFilter("All");
    setStockFilter("All");
  };

  const selected = groups.filter((g) => sel[g.it]);
  const runningTotal = sum(selected, (g) => qtyFor(g) * costOf(g.it));
  const activeVendor = (id: string) => s.vendors.find((v) => v.id === id && v.active);

  const planned = ordersFor(
    selected.map((g) => ({ group: g, vendor: vendorOf(g), qty: qtyFor(g) })),
  );
  const missingVendor = selected.filter((g) => !activeVendor(vendorOf(g)));
  const canRaise = planned.length > 0 && missingVendor.length === 0;

  const raise = () => {
    // createPo() returns void and toasts either way (a new draft, or a
    // refusal), so success is read back from the store: navigating away on a
    // refused pick would strand the operator on /orders with no clue why
    // nothing showed up there.
    const before = useApp.getState().po.length;
    for (const o of planned) createPo(o.vendor, o.picks);
    const made = useApp.getState().po.length - before;
    if (made <= 0) return;
    // Each createPo toasts, and only the last would survive — so when the
    // selection fanned out across vendors, say so plainly instead.
    if (made > 1) notify(`${made} draft purchase orders raised across ${made} vendors`);
    nav("/orders");
  };

  const rows: Row[] = shown.map((g) => {
    const it = IT[g.it];
    return {
      key: g.it,
      cells: [
        <input
          type="checkbox" checked={!!sel[g.it]} onChange={() => toggle(g.it)}
          aria-label={`Select ${it?.n ?? g.it}`}
        />,
        <>{it?.n ?? g.it}<small>{it?.c ?? ""}</small></>,
        <>{U(g.it)}</>,
        <>{fq(g.pending, g.it)}</>,
        <input
          type="number" className="mono" min={0} max={g.pending} step={U(g.it) === "nos" ? 1 : 0.5}
          value={qtyFor(g)} aria-label={`Quantity of ${it?.n ?? g.it} to pick`}
          onChange={(e) => setQtyForItem(g, Number(e.target.value))}
        />,
        <>{fq(qty(s, "store", g.it), g.it)}</>,
        <select
          value={vendorOf(g)} aria-label={`Vendor for ${it?.n ?? g.it}`}
          onChange={(e) => setVendorFor((m) => ({ ...m, [g.it]: e.target.value }))}
        >
          <option value="">Choose a vendor…</option>
          {s.vendors.filter((v) => v.active).map((v) => (
            <option key={v.id} value={v.id}>{v.n}</option>
          ))}
        </select>,
        (() => {
          const chosen = vendorOf(g);
          const c = chosen ? contractFor(s, chosen, g.it) : undefined;
          if (!c) return <span className="dim">Off contract</span>;
          return (
            <>
              <b>{money(c.rate)}</b>
              {c.moq > 0 && qtyFor(g) < c.moq && (
                <div className="mini" style={{ color: "var(--warn)" }}>
                  below the {fq(c.moq, g.it)} {U(g.it)} minimum on {c.id}
                </div>
              )}
            </>
          );
        })(),
        <details>
          <summary className="mini">
            {g.sources.length} requisition{g.sources.length > 1 ? "s" : ""}
          </summary>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
            {g.sources.map((src) => (
              <Tag key={src.prq + "-" + src.line}>{src.prq} · {fq(src.pending, src.it)}</Tag>
            ))}
          </div>
        </details>,
      ],
    };
  });

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Procurement", "Procurement List"]}
        title="Procurement list"
        sub="Every approved requisition item not yet claimed by an order, pooled by item — pick what to buy here and raise a purchase order."
      />

      <Grid cols="g21">
      <Card title="Pending lines" sub={`${shown.length} of ${groups.length} item(s) waiting on an order`} flush>
        <Toolbar
          placeholder="Search item name or code…"
          value={q}
          onSearch={setQ}
          filters={
            <>
              <FilterSelect label="Group" value={groupFilter} options={GROUPS} onChange={setGroupFilter} />
              <FilterSelect label="Vendor" value={vendorFilter} options={VENDOR_NAMES} onChange={setVendorFilter} />
              <FilterSelect label="Central store" value={stockFilter} options={STOCK_STATES} onChange={setStockFilter} />
            </>
          }
        />
        <DataTable
          cols={[
            { h: "", w: "3%" },
            { h: "Item", cls: "nm", w: "17%" },
            { h: "Unit" },
            { h: "Pending", r: true },
            { h: "Pick qty", r: true, w: "10%" },
            { h: LOC.store.n, r: true },
            { h: "Vendor", w: "18%" },
            { h: "Contract rate", r: true, w: "13%" },
            { h: "Sources", w: "14%" },
          ]}
          rows={rows}
          empty={narrowed
            ? {
              title: "Nothing matches those filters",
              sub: "Clear the search box, or cycle Group, Vendor and Central store back to All.",
              action: <Btn size="sm" variant="gh" onClick={clearFilters}>Clear filters</Btn>,
            }
            : {
              title: "Nothing on the procurement list",
              sub: "Approve a requisition and its items collect here.",
            }}
        />
        <TableFoot
          count={rows.length}
          extra={<>{money0(sum(groups, (g) => g.pending * costOf(g.it)))} pooled at standard cost</>}
        />
      </Card>

      {groups.length > 0 && (
        <div style={{ position: "sticky", top: 12, alignSelf: "start" }}>
          <Card
            title="Order cart"
            sub={selected.length
              ? `${selected.length} item(s) · ${planned.length} order(s) to raise`
              : "Tick an item to start an order."}
          >
            {selected.length === 0 ? (
              <p className="mini dim">
                Pick the items you want to buy. Items sharing a vendor are combined into one
                order; items on different vendors become separate orders.
              </p>
            ) : (
              <>
                {planned.map((o) => (
                  <div key={o.vendor} className="mtop">
                    <b className="mono-id">{vendorName(s.vendors, o.vendor)}</b>
                    <div className="mini dim">
                      {o.picks.length} source line(s) ·{" "}
                      {selected.filter((g) => vendorOf(g) === o.vendor).map((g) => IT[g.it]?.n ?? g.it).join(", ")}
                    </div>
                  </div>
                ))}
                {missingVendor.length > 0 && (
                  <div className="mtop">
                    <Alert tone="w" label="NO VENDOR">
                      {missingVendor.map((g) => IT[g.it]?.n ?? g.it).join(", ")} still{" "}
                      {missingVendor.length > 1 ? "need" : "needs"} an active vendor on its row.
                    </Alert>
                  </div>
                )}
                <div className="totrow big mtop">
                  <span>Total at standard cost</span><span>{money0(runningTotal)}</span>
                </div>
              </>
            )}
            <div className="mtop">
              <Btn disabled={!canRaise} onClick={raise}>
                {planned.length > 1 ? `Raise ${planned.length} purchase orders` : "Raise purchase order"}
              </Btn>
            </div>
          </Card>
        </div>
      )}
      </Grid>
    </>
  );
}
