import { useState } from "react";
import { ALL_LOCS, IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { avail, inTransit, qty, stateTone, stockValue } from "../../lib/selectors";
import { fq, lakh, money, money0, sum } from "../../lib/fmt";
import {
  Btn, Card, DataTable, FilterSelect, Kpis, PageHead, Pill, Tag, TableFoot, Toolbar,
} from "../../ui/kit";
import type { Col, Row } from "../../ui/kit";
import type { ItemType, LocKey } from "../../types";

const KEYS = Object.keys(IT);
const TYPES: string[] = ["All", "RAW", "PACK", "MRP", "FG", "MTO"];
const GROUPS: string[] = ["All", ...[...new Set(KEYS.map((k) => IT[k].g))].sort()];
const STATES = ["All", "Out", "Below reorder", "Healthy", "Not stocked"];
/** Locations come from the master list, never a hardcoded set — the estate changes. */
const PLACES = ["All", ...ALL_LOCS.map((l) => LOC[l].n)];
const tagKind = (t: ItemType) => (t === "MRP" ? "tr" : t === "MTO" || t === "FG" ? "md" : undefined);

export default function Inventory() {
  const s = useApp();
  const [q, setQ] = useState("");
  const [type, setType] = useState("All");
  const [group, setGroup] = useState("All");
  const [state, setState] = useState("All");
  const [place, setPlace] = useState("All");

  const totalOf = (k: string) => sum(ALL_LOCS, (l) => qty(s, l, k));
  /** A dash means the location does not carry the line at all; zero means it is dry (M12). */
  const stocked = (l: LocKey, k: string) => k in (s.stock[l] ?? {});
  const anywhere = (k: string) => ALL_LOCS.some((l) => stocked(l, k));
  const netValue = sum(ALL_LOCS, (l) => stockValue(s, l));
  const below = KEYS.filter((k) => IT[k].rl > 0 && avail(s, "store", k) < IT[k].rl);
  const zero = KEYS.filter((k) => k in s.stock.store && avail(s, "store", k) <= 0);

  const stateOf = (k: string) => {
    if (!stocked("store", k)) return "Not stocked";
    const a = avail(s, "store", k);
    return a <= 0 ? "Out" : IT[k].rl > 0 && a < IT[k].rl ? "Below reorder" : "Healthy";
  };
  const placeKey = ALL_LOCS.find((l) => LOC[l].n === place);

  const t = q.trim().toLowerCase();
  const keys = KEYS.filter((k) =>
    (type === "All" || IT[k].t === type)
    && (group === "All" || IT[k].g === group)
    && (state === "All" || stateOf(k) === state)
    && (!placeKey || stocked(placeKey, k))
    && (!t || IT[k].n.toLowerCase().includes(t) || IT[k].c.toLowerCase().includes(t)
      || IT[k].g.toLowerCase().includes(t) || IT[k].hsn.includes(t)));
  const narrowed = t !== "" || type !== "All" || group !== "All" || state !== "All" || place !== "All";
  const clear = () => { setQ(""); setType("All"); setGroup("All"); setState("All"); setPlace("All"); };

  const shownValue = sum(keys, (k) => totalOf(k) * IT[k].cost);

  const cols: Col[] = [
    { h: "Item", cls: "nm", w: "16%" },
    { h: "Type" },
    { h: "Group" },
    { h: "Unit" },
    { h: "HSN" },
    { h: "GST", r: true },
    { h: "Cost", r: true },
    ...ALL_LOCS.map((l) => ({ h: LOC[l].n, r: true })),
    { h: "All locations", r: true },
    { h: "In transit", r: true },
    { h: "Value", r: true },
    { h: "Reorder", r: true },
    { h: "State" },
  ];

  const rows: Row[] = keys.map((k) => {
    const it = IT[k];
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
        ...ALL_LOCS.map((l) => (
          stocked(l, k) ? <>{fq(qty(s, l, k), k)}</> : <span className="dim">—</span>
        )),
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
        sub={`Read-only. Procurement observes stock across all ${ALL_LOCS.length} locations — it does not move it. Issues and receipts are made by the store keeper.`}
      />
      <Kpis items={[
        {
          l: "Inventory value · all locations", v: lakh(netValue),
          d: <>{ALL_LOCS.length} locations valued at cost</>,
        },
        { l: "Items on the master", v: String(KEYS.length), d: <>{GROUPS.length - 1} groups</> },
        {
          l: `Below reorder · ${LOC.store.n}`, v: String(below.length),
          d: <>reorder levels breached</>,
        },
        { l: `At zero · ${LOC.store.n}`, v: String(zero.length), d: <>stocked items with nothing on hand</> },
      ]} />
      <div className="mtop" />

      <Card title="Item master and stock" sub={`${keys.length} of ${KEYS.length} items`} flush>
        <Toolbar
          placeholder="Search item name, code, group or HSN…"
          value={q}
          onSearch={setQ}
          filters={
            <>
              <FilterSelect label="Type" value={type} options={TYPES} onChange={setType} />
              <FilterSelect label="Group" value={group} options={GROUPS} onChange={setGroup} />
              <FilterSelect label="State" value={state} options={STATES} onChange={setState} />
              <FilterSelect label="Stocked at" value={place} options={PLACES} onChange={setPlace} />
            </>
          }
          right={<span className="mini">Valued at standard cost</span>}
        />
        <DataTable
          cols={cols}
          rows={rows}
          empty={narrowed
            ? {
              title: "Nothing matches those filters",
              sub: "Clear the search box, or cycle Type, Group, State and Stocked at back to All.",
              action: <Btn size="sm" variant="gh" onClick={clear}>Clear filters</Btn>,
            }
            : {
              title: "No items on the master",
              sub: "The catalogue is empty — the store keeper adds products to it.",
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
