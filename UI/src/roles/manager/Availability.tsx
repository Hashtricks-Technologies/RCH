import { useState } from "react";
import { IT, LOC, OUTLETS } from "../../data/master";
import { useApp } from "../../store";
import { availOf, menuOf } from "../../lib/selectors";
import {
  Alert, Card, DataTable, FilterSelect, ImagePlaceholder, PageHead, Pill, Switch, TableFoot, Tag, Toolbar,
} from "../../ui/kit";
import { emptyFor, sortRows, useSort, type SortValue } from "./useSort";
import type { ItemType, LocKey } from "../../types";

const TYPES: (ItemType | "All")[] = ["All", "MRP", "FG", "MTO"];
const STATES = ["All", "Off somewhere", "Switched off by hand", "Out of stock or short", "Sellable everywhere"] as const;
const tagKind = (t: ItemType) => (t === "MRP" ? "tr" : t === "FG" || t === "MTO" ? "md" : undefined);

export default function Availability() {
  const s = useApp();
  const toggleAvail = useApp((x) => x.toggleAvail);
  const [q, setQ] = useState("");
  const [type, setType] = useState(0);
  const [outlet, setOutlet] = useState(0);
  const [state, setState] = useState(0);
  const sort = useSort("name");

  const listed = (loc: LocKey) => menuOf(s, loc);
  const isOff = (loc: LocKey, it: string) => Boolean(s.ovr[loc + ":" + it]);

  /* Counted against the products this outlet actually lists, and against every
     reason a product cannot be sold — not the manual switch alone (M10). */
  const counts = OUTLETS.map((loc) => {
    const items = listed(loc);
    const bad = items.filter((it) => !availOf(s, loc, it).ok);
    const manual = bad.filter((it) => isOff(loc, it)).length;
    return { loc, listed: items.length, off: bad.length, manual, blocked: bad.length - manual, on: items.length - bad.length };
  });
  const totalOff = counts.reduce((t, c) => t + c.off, 0);
  const totalManual = counts.reduce((t, c) => t + c.manual, 0);

  const outletNames = ["All", ...OUTLETS.map((l) => LOC[l].n)];
  const union = Object.keys(IT).filter((it) => OUTLETS.some((loc) => listed(loc).includes(it)));

  /* Which outlets the state filter looks at — All, or just the one picked. */
  const scope: LocKey[] = outlet === 0 ? OUTLETS : [OUTLETS[outlet - 1]];
  const offCount = (it: string) => scope.filter((l) => listed(l).includes(it) && !availOf(s, l, it).ok).length;
  const manualCount = (it: string) => scope.filter((l) => listed(l).includes(it) && isOff(l, it)).length;

  const term = q.trim().toLowerCase();
  const rows = union
    .filter((it) => TYPES[type] === "All" || IT[it].t === TYPES[type])
    .filter((it) => outlet === 0 || listed(OUTLETS[outlet - 1]).includes(it))
    .filter((it) => {
      if (state === 0) return true;
      if (state === 1) return offCount(it) > 0;
      if (state === 2) return manualCount(it) > 0;
      if (state === 3) return offCount(it) - manualCount(it) > 0;
      return offCount(it) === 0;
    })
    .filter((it) => !term
      || IT[it].n.toLowerCase().includes(term)
      || IT[it].c.toLowerCase().includes(term)
      || IT[it].g.toLowerCase().includes(term));
  const filtered = term !== "" || type > 0 || outlet > 0 || state > 0;

  const sorted = sortRows(rows, sort.sort, (it, k): SortValue => {
    if (k.startsWith("loc:")) {
      const l = k.slice(4) as LocKey;
      if (!listed(l).includes(it)) return 2;
      return availOf(s, l, it).ok ? 0 : 1;
    }
    return k === "type" ? IT[it].t : k === "group" ? IT[it].g : k === "off" ? offCount(it) : IT[it].n;
  });

  const cell = (loc: LocKey, it: string) => {
    if (!listed(loc).includes(it))
      return <span className="dim">not listed</span>;
    const a = availOf(s, loc, it);
    const off = isOff(loc, it);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <Switch on={!off} onChange={() => toggleAvail(loc, it)} label={`${IT[it].n} at ${LOC[loc].n}`} />
        <span className="mini" style={{ color: off ? "var(--warn)" : a.ok ? undefined : "var(--crit)" }}>
          {off ? "off — " + (a.why ?? "switched off") : a.ok ? (a.left ?? "available") + " left" : a.why}
        </span>
      </div>
    );
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Outlets", "Product On / Off"]}
        title="Product availability master"
        sub={`One switch per product per counter. This is the master all ${OUTLETS.length} points of sale read from.`}
      />

      <Alert tone="i" label="LIVE">
        A product switched off here is immediately unsellable at that counter's point of sale — the operator sees
        the tile greyed out and cannot add it to a bill.
      </Alert>
      {totalOff > 0 && (
        <Alert tone="w" label="OFF">
          <b>{totalOff}</b> product-counter combination{totalOff > 1 ? "s" : ""} cannot be sold right now —{" "}
          <b>{totalManual}</b> switched off here, <b>{totalOff - totalManual}</b> out of stock or short an ingredient.
        </Alert>
      )}

      <Card title="Sellable by counter" sub="What each outlet lists, and why anything is off" flush>
        <DataTable
          cols={[
            { h: "Counter", cls: "nm", w: "26%" },
            { h: "Floor" },
            { h: "Listed", r: true },
            { h: "Sellable", r: true },
            { h: "Switched off by hand", r: true },
            { h: "Out of stock or short", r: true },
          ]}
          rows={counts.map((c) => ({
            key: c.loc,
            cells: [
              <>{LOC[c.loc].n}<small>{LOC[c.loc].c} · list {LOC[c.loc].list}</small></>,
              LOC[c.loc].floor,
              c.listed,
              <b>{c.on}</b>,
              c.manual > 0 ? <Pill tone="wn">{c.manual}</Pill> : <span className="dim">0</span>,
              c.blocked > 0 ? <Pill tone="cr">{c.blocked}</Pill> : <span className="dim">0</span>,
            ],
          }))}
          empty={{ title: "No counters configured" }}
        />
        <TableFoot count={counts.length} extra={<>{totalOff} of the combinations cannot be billed</>} />
      </Card>

      <Card title="On / off matrix" sub={`${rows.length} of ${union.length} products`} flush className="mtop">
        <Toolbar
          placeholder="Search product name, code or group…"
          value={q}
          onSearch={setQ}
          filters={
            <>
              <FilterSelect label="Type" value={String(TYPES[type])} options={TYPES}
                onChange={(v) => setType(TYPES.indexOf(v as (typeof TYPES)[number]))} />
              <FilterSelect label="Counter" value={outletNames[outlet]} options={outletNames}
                onChange={(v) => setOutlet(outletNames.indexOf(v))} />
              <FilterSelect label="State" value={STATES[state]} options={STATES}
                onChange={(v) => setState(STATES.indexOf(v as typeof STATES[number]))} />
            </>
          }
        />
        <DataTable
          sort={sort.sort}
          onSort={sort.onSort}
          cols={[
            { h: "Product", cls: "nm", w: "24%", sort: "name" },
            { h: "Type", sort: "type" },
            { h: "Group", sort: "group" },
            { h: "Off at", r: true, sort: "off" },
            ...OUTLETS.map((loc) => ({ h: LOC[loc].n, w: "14%", sort: "loc:" + loc })),
          ]}
          rows={sorted.map((it) => ({
            key: it,
            cells: [
              <span className="nm-pic">
                <ImagePlaceholder />
                <div>{IT[it].n}<small>{IT[it].c} · HSN {IT[it].hsn}</small></div>
              </span>,
              <Tag kind={tagKind(IT[it].t)}>{IT[it].t}</Tag>,
              IT[it].g,
              offCount(it) > 0
                ? <Pill tone="wn">{offCount(it)}</Pill>
                : <span className="dim">0</span>,
              ...OUTLETS.map((loc) => cell(loc, it)),
            ],
          }))}
          empty={emptyFor(filtered, {
            title: "No product is listed at any counter",
            sub: "Add products to a counter from Items & Stock or the Price Lists screen.",
          })}
        />
        <TableFoot
          count={rows.length}
          extra={counts.map((c) => `${LOC[c.loc].n} ${c.on}/${c.listed} sellable`).join(" · ")}
        />
      </Card>
    </>
  );
}
