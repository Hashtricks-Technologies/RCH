import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IT, LOC } from "../../data/master";
import { suggestVendor } from "../../data/vendors";
import { useApp } from "../../store";
import { costOf, procurementList, qty } from "../../lib/selectors";
import { fq, money0, sum, U } from "../../lib/fmt";
import {
  Btn, Card, DataTable, Field, FilterBtn, PageHead, Tag, TableFoot, Toolbar,
} from "../../ui/kit";
import type { Row } from "../../ui/kit";
import type { PoolLine } from "../../lib/selectors";
import type { Vendor } from "../../types";

const cycle = (list: string[], v: string) => list[(list.indexOf(v) + 1) % list.length];
const NO_VENDOR = "No suggested vendor";

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
      g.pending = Math.round((g.pending + line.pending) * 1000) / 1000;
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
  let left = Math.round(Math.max(0, wanted) * 1000) / 1000;
  const picks: Pick[] = [];
  for (const src of g.sources) {
    if (left <= 0) break;
    const take = Math.round(Math.min(left, src.pending) * 1000) / 1000;
    if (take > 0) {
      picks.push({ prq: src.prq, line: src.line, qty: take });
      left = Math.round((left - take) * 1000) / 1000;
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
  const shown = groups.filter((g) => {
    const it = IT[g.it];
    return (groupFilter === "All" || it?.g === groupFilter)
      && (vendorFilter === "All" || (g.vendor?.n ?? NO_VENDOR) === vendorFilter)
      && (!t || it?.n.toLowerCase().includes(t) || it?.c.toLowerCase().includes(t));
  });

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
    createPo(effectiveVendor, picks);
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
        it?.rl ? <>{fq(it.rl, g.it)}</> : <span className="dim">—</span>,
        g.vendor ? <>{g.vendor.n}</> : <span className="dim">No active vendor</span>,
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
        sub="Every approved requisition line not yet claimed by an order, pooled by item — pick lines here and raise a purchase order."
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
            { h: "Suggested vendor", w: "15%" },
            { h: "Sources", w: "16%" },
          ]}
          rows={rows}
          empty={{
            title: "Nothing on the procurement list",
            sub: "Approve a requisition and its lines collect here.",
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
              ? `${selected.length} line(s) selected across ${picks.length} source(s)`
              : "Tick a line above to start an order."}
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
