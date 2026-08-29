import { useState } from "react";
import { ALL_LOCS, IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { avail, inTransit, qty, stateTone, stockValue } from "../../lib/selectors";
import { fq, lakh, money, money0, sum } from "../../lib/fmt";
import {
  Card, DataTable, FilterBtn, Kpis, PageHead, Pill, Tag, TableFoot, Toolbar,
} from "../../ui/kit";
import type { Row } from "../../ui/kit";
import type { ItemType, LocKey } from "../../types";

const KEYS = Object.keys(IT);
const TYPES: string[] = ["All", "RAW", "PACK", "TRADED", "FG", "MTO"];
const GROUPS: string[] = ["All", ...[...new Set(KEYS.map((k) => IT[k].g))].sort()];
const cycle = (list: string[], v: string) => list[(list.indexOf(v) + 1) % list.length];
const tagKind = (t: ItemType) => (t === "TRADED" ? "tr" : t === "MTO" || t === "FG" ? "md" : undefined);

export default function Inventory() {
  const s = useApp();
  const [q, setQ] = useState("");
  const [type, setType] = useState("All");
  const [group, setGroup] = useState("All");

  const totalOf = (k: string) => sum(ALL_LOCS, (l) => qty(s, l, k));
  /** A dash means the location does not carry the line at all; zero means it is dry (M12). */
  const stocked = (l: LocKey, k: string) => k in (s.stock[l] ?? {});
  const anywhere = (k: string) => ALL_LOCS.some((l) => stocked(l, k));
  const netValue = sum(ALL_LOCS, (l) => stockValue(s, l));
  const below = KEYS.filter((k) => IT[k].rl > 0 && avail(s, "store", k) < IT[k].rl);
  const zero = KEYS.filter((k) => k in s.stock.store && avail(s, "store", k) <= 0);

  const t = q.trim().toLowerCase();
  const keys = KEYS.filter((k) =>
    (type === "All" || IT[k].t === type)
    && (group === "All" || IT[k].g === group)
    && (!t || IT[k].n.toLowerCase().includes(t) || IT[k].c.toLowerCase().includes(t)));

  const shownValue = sum(keys, (k) => totalOf(k) * IT[k].cost);

  const rows: Row[] = keys.map((k) => {
    const it = IT[k];
    const here = qty(s, "store", k);
    const a = avail(s, "store", k);
    const all = totalOf(k);
    const tr = inTransit(s, k);
    return {
      key: k,
      cells: [
        <>{it.n}<small>{it.c}</small></>,
        <Tag kind={tagKind(it.t)}>{it.t}</Tag>,
        <>{it.g}</>,
        <>{it.u}</>,
        <>{it.hsn}</>,
        <>{it.gst}%</>,
        <>{money(it.cost)}</>,
        <>{stocked("store", k) ? fq(here, k) : <span className="dim">—</span>}</>,
        <>{anywhere(k) ? fq(all, k) : <span className="dim">—</span>}</>,
        <>{tr > 0 ? fq(tr, k) : <span className="dim">{anywhere(k) ? fq(0, k) : "—"}</span>}</>,
        <>{money0(all * it.cost)}</>,
        <>{it.rl > 0 ? fq(it.rl, k) : <span className="dim">—</span>}</>,
        !stocked("store", k)
          ? <Pill tone="mu">Not stocked</Pill>
          : <Pill tone={stateTone(a, it.rl)}>
            {a <= 0 ? "Out" : it.rl > 0 && a < it.rl ? "Below reorder" : "Healthy"}
          </Pill>,
      ],
    };
  });

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Procurement", "Inventory"]}
        title="Inventory"
        sub="Read-only. Procurement observes stock across all six locations — it does not move it. Issues and receipts are made by the store keeper."
      />
      <Kpis items={[
        {
          l: "Inventory value · all locations", v: lakh(netValue),
          d: <>{ALL_LOCS.length} locations valued at cost</>,
          spark: [62, 58, 66, 61, 70, 67, 72], color: "var(--c1)",
        },
        { l: "Items on the master", v: String(KEYS.length), d: <>{GROUPS.length - 1} groups</> },
        {
          l: `Below reorder · ${LOC.store.n}`, v: String(below.length),
          d: <>reorder levels breached</>, spark: [4, 5, 4, 6, 5, 5, Math.max(1, below.length)], color: "var(--c3)",
        },
        { l: `At zero · ${LOC.store.n}`, v: String(zero.length), d: <>stocked items with nothing on hand</> },
      ]} />
      <div className="mtop" />

      <Card title="Item master and stock" sub={`${keys.length} of ${KEYS.length} items`} flush>
        <Toolbar
          placeholder="Search item name or code…"
          value={q}
          onSearch={setQ}
          filters={
            <>
              <FilterBtn label="Type" value={type} onClick={() => setType(cycle(TYPES, type))} />
              <FilterBtn label="Group" value={group} onClick={() => setGroup(cycle(GROUPS, group))} />
            </>
          }
          right={<span className="mini">Valued at standard cost</span>}
        />
        <DataTable
          cols={[
            { h: "Item", cls: "nm", w: "18%" },
            { h: "Type" },
            { h: "Group" },
            { h: "Unit" },
            { h: "HSN" },
            { h: "GST", r: true },
            { h: "Cost", r: true },
            { h: LOC.store.n, r: true },
            { h: "All locations", r: true },
            { h: "In transit", r: true },
            { h: "Value", r: true },
            { h: "Reorder", r: true },
            { h: "State" },
          ]}
          rows={rows}
          empty={{
            title: "No item matches this filter",
            sub: "Clear the search box or cycle the Type and Group filters back to All.",
          }}
        />
        <TableFoot
          count={rows.length}
          extra={<>Inventory value <b className="mono">{money0(shownValue)}</b> of {money0(netValue)} overall</>}
        />
      </Card>
    </>
  );
}
