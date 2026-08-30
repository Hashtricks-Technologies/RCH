import { useState } from "react";
import { IT, LOC, OUTLETS } from "../../data/master";
import { useApp } from "../../store";
import { availOf, menuOf } from "../../lib/selectors";
import {
  Alert, Card, DataTable, Kpis, PageHead, Switch, TableFoot, Tag, Toolbar,
} from "../../ui/kit";
import type { ItemType, LocKey } from "../../types";

const tagKind = (t: ItemType) => (t === "MRP" ? "tr" : t === "FG" || t === "MTO" ? "md" : undefined);

export default function Availability() {
  const s = useApp();
  const toggleAvail = useApp((x) => x.toggleAvail);
  const [q, setQ] = useState("");

  const listed = (loc: LocKey) => menuOf(s, loc);
  const isOff = (loc: LocKey, it: string) => Boolean(s.ovr[loc + ":" + it]);

  const union = Object.keys(IT).filter((it) => OUTLETS.some((loc) => listed(loc).includes(it)));
  const term = q.trim().toLowerCase();
  const rows = union.filter(
    (it) => !term || IT[it].n.toLowerCase().includes(term) || IT[it].c.toLowerCase().includes(term)
  );

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
        sub="One switch per product per counter. This is the master the three points of sale read from."
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

      <Kpis
        items={counts.map((c) => ({
          l: LOC[c.loc].n,
          v: <>{c.on} of {c.listed} sellable</>,
          d: <>{c.manual} switched off · {c.blocked} out of stock or short an ingredient · {LOC[c.loc].floor}</>,
        }))}
      />

      <Card title="On / off matrix" sub={`${rows.length} products across ${OUTLETS.length} counters`} flush>
        <Toolbar placeholder="Search product name or code…" value={q} onSearch={setQ} />
        <DataTable
          cols={[
            { h: "Product", cls: "nm", w: "26%" },
            { h: "Type" },
            ...OUTLETS.map((loc) => ({ h: LOC[loc].n, w: "16%" })),
          ]}
          rows={rows.map((it) => ({
            key: it,
            cells: [
              <>{IT[it].n}<small>{IT[it].c} · {IT[it].g}</small></>,
              <Tag kind={tagKind(IT[it].t)}>{IT[it].t}</Tag>,
              ...OUTLETS.map((loc) => cell(loc, it)),
            ],
          }))}
          empty={{
            title: "No product matches that search",
            sub: "Clear the search box to see the full on / off master again.",
          }}
        />
        <TableFoot
          count={rows.length}
          extra={counts.map((c) => `${LOC[c.loc].n} ${c.on}/${c.listed} sellable`).join(" · ")}
        />
      </Card>
    </>
  );
}
