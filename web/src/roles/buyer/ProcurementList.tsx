import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IT, LOC } from "../../data/master";
import { suggestVendor } from "../../data/vendors";
import { useApp } from "../../store";
import { costOf, procurementList, qty, round3 } from "../../lib/selectors";
import { fq, money, money0, sum, U } from "../../lib/fmt";
import {
  Btn, Card, DataTable, Field, FilterBtn, PageHead, Tag, TableFoot, Toolbar,
} from "../../ui/kit";
import type { Row } from "../../ui/kit";
import type { PoolLine } from "../../lib/selectors";
import type { Vendor } from "../../types";
import { contractFor, cycle } from "./lib";

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

export default function ProcurementList() {
  const s = useApp();
  const createPo = useApp((x) => x.createPo);
  const nav = useNavigate();

  const [q, setQ] = useState("");
  const [groupFilter, setGroupFilter] = useState("All");
  const [vendorFilter, setVendorFilter] = useState("All");
  const [stockFilter, setStockFilter] = useState("All");
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [qtyOverride, setQtyOverride] = useState<Record<string, number>>({});
  const [vendorId, setVendorId] = useState("");

  const groups = groupPool(procurementList(s), s.vendors);
  const qtyFor = (g: PoolGroup) => qtyOverride[g.it] ?? g.pending;
  const setQtyForItem = (g: PoolGroup, v: number) =>
    setQtyOverride((m) => ({ ...m, [g.it]: Math.max(0, Math.min(v, g.pending)) }));
  const toggle = (it: string) => setSel((m) => ({ ...m, [it]: !m[it] }));

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
  const picks = selected.flatMap((g) => picksFor(g, qtyFor(g)));
  const runningTotal = sum(selected, (g) => qtyFor(g) * costOf(g.it));
  // Sticks to the suggestion for the first selected row until the buyer
  // overrides it — an empty vendorId means "still following the suggestion".
  const suggested = selected[0]?.vendor?.id ?? "";
  const effectiveVendor = vendorId || suggested;
  const vendorOk = s.vendors.some((v) => v.id === effectiveVendor && v.active);
  const canRaise = picks.length > 0 && vendorOk;

  const raise = () => {
    // createPo() returns void and toasts either way (a new draft, or a
    // refusal), so success is read back from the store: navigating away on a
    // refused pick would strand the operator on /orders with no clue why
    // nothing showed up there.
    const before = useApp.getState().po.length;
    createPo(effectiveVendor, picks);
    if (useApp.getState().po.length > before) nav("/orders");
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
        it?.rl ? <>{fq(it.rl, g.it)}</> : <span className="dim">—</span>,
        g.vendor ? <>{g.vendor.n}</> : <span className="dim">No active vendor</span>,
        (() => {
          const c = effectiveVendor ? contractFor(s, effectiveVendor, g.it) : undefined;
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

      <Card title="Pending lines" sub={`${shown.length} of ${groups.length} item(s) waiting on an order`} flush>
        <Toolbar
          placeholder="Search item name or code…"
          value={q}
          onSearch={setQ}
          filters={
            <>
              <FilterBtn label="Group" value={groupFilter} onClick={() => setGroupFilter(cycle(GROUPS, groupFilter))} />
              <FilterBtn label="Vendor" value={vendorFilter} onClick={() => setVendorFilter(cycle(VENDOR_NAMES, vendorFilter))} />
              <FilterBtn label="Central store" value={stockFilter} onClick={() => setStockFilter(cycle(STOCK_STATES, stockFilter))} />
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
            { h: "Reorder", r: true },
            { h: "Suggested vendor", w: "14%" },
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
        <div
          className="mtop"
          style={{
            position: "sticky", bottom: 0, zIndex: 5,
            background: "var(--surface)", borderTop: "1px solid var(--line-strong)",
          }}
        >
          <Card
            title="Raise a purchase order"
            sub={selected.length
              ? `${selected.length} item(s) selected across ${picks.length} source(s)`
              : "Tick an item above to start an order."}
          >
            <div style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ minWidth: 220 }}>
                <Field
                  label="Vendor"
                  hint={!vendorId && suggested
                    ? "Defaulted to the vendor suggested for the first line you picked."
                    : "Only active vendors can be chosen."}
                >
                  <select value={effectiveVendor} onChange={(e) => setVendorId(e.target.value)}>
                    <option value="">Choose a vendor…</option>
                    {s.vendors.filter((v) => v.active).map((v) => (
                      <option key={v.id} value={v.id}>{v.n}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="totrow big" style={{ flex: 1, minWidth: 200, paddingBottom: 8 }}>
                <span>Total at standard cost</span><span>{money0(runningTotal)}</span>
              </div>
              <Btn disabled={!canRaise} onClick={raise}>Raise purchase order</Btn>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
