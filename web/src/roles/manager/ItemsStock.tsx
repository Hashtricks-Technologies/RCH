import { useState } from "react";
import { ALL_LOCS, IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { costOf, qty, stockValue } from "../../lib/selectors";
import { fq, lakh, money, money0, sum } from "../../lib/fmt";
import {
  Card, DataTable, FilterBtn, Kpis, PageHead, TableFoot, Tag, Toolbar,
} from "../../ui/kit";
import type { ItemType, LocKey } from "../../types";

const TYPES: (ItemType | "All")[] = ["All", "RAW", "PACK", "TRADED", "FG", "MTO"];
const tagKind = (t: ItemType) => (t === "TRADED" ? "tr" : t === "FG" || t === "MTO" ? "md" : undefined);

export default function ItemsStock() {
  const s = useApp();
  const [q, setQ] = useState("");
  const [type, setType] = useState(0);

  const keys = Object.keys(IT);
  const stocked = keys.filter((k) => IT[k].t !== "MTO");
  /* A location either carries the item and holds a number, or does not carry it (M12). */
  const carries = (l: LocKey, k: string) => s.stock[l]?.[k] !== undefined;

  const totalValue = sum(ALL_LOCS, (l) => stockValue(s, l));
  const zeroSomewhere = stocked.filter((k) => ALL_LOCS.some((l) => carries(l, k) && qty(s, l, k) <= 0)).length;
  const belowReorder = stocked.filter((k) => IT[k].rl > 0 && qty(s, "store", k) <= IT[k].rl).length;

  const term = q.trim().toLowerCase();
  const want = TYPES[type];
  const rows = keys
    .filter((k) => (want === "All" ? true : IT[k].t === want))
    .filter((k) => !term || IT[k].n.toLowerCase().includes(term) || IT[k].c.toLowerCase().includes(term))
    .map((k) => {
      const per = ALL_LOCS.map((l) => qty(s, l, k));
      const tot = sum(per, (v) => v);
      return { k, per, tot, held: ALL_LOCS.some((l) => carries(l, k)), value: tot * costOf(k) };
    });

  const shownValue = sum(rows, (r) => r.value);

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Outlets", "Items & Stock"]}
        title="Items and stock in hand"
        sub="Every item on the master with the quantity each of the six locations is holding right now."
      />

      <Kpis
        items={[
          {
            l: "Inventory value · all locations",
            v: lakh(totalValue),
            d: <>Store, {LOC.procure.n}, kitchen and three counters at cost</>,
            spark: ALL_LOCS.map((l) => stockValue(s, l)),
            color: "var(--c1)",
          },
          { l: "Items tracked", v: String(keys.length), d: <>{stocked.length} stocked · {keys.length - stocked.length} made to order</> },
          {
            l: "Items at zero somewhere",
            v: String(zeroSomewhere),
            d: <>A location that carries it is holding none</>,
          },
          {
            l: "Below reorder in Central Store",
            v: String(belowReorder),
            d: <>Needs a requisition to procurement</>,
          },
        ]}
      />

      <Card title="Item master and stock in hand" sub={`${rows.length} of ${keys.length} items`} flush>
        <Toolbar
          placeholder="Search by item name or code…"
          value={q}
          onSearch={setQ}
          filters={
            <FilterBtn
              label="Type"
              value={String(TYPES[type])}
              active={type > 0}
              onClick={() => setType((type + 1) % TYPES.length)}
            />
          }
        />
        <DataTable
          cols={[
            { h: "Item", cls: "nm", w: "20%" },
            { h: "Type" },
            { h: "Unit" },
            { h: "Cost", r: true },
            ...ALL_LOCS.map((l) => ({ h: LOC[l].n, r: true })),
            { h: "Total", r: true },
            { h: "Total value", r: true },
          ]}
          rows={rows.map((r) => ({
            key: r.k,
            cells: [
              <>{IT[r.k].n}<small>{IT[r.k].c} · HSN {IT[r.k].hsn}</small></>,
              <Tag kind={tagKind(IT[r.k].t)}>{IT[r.k].t}</Tag>,
              IT[r.k].u,
              money(costOf(r.k)),
              ...ALL_LOCS.map((l, i) => {
                const v = r.per[i];
                if (!carries(l, r.k))
                  return <span className="dim" title={`${LOC[l].n} does not carry this item`}>–</span>;
                if (v <= 0)
                  return <span style={{ color: "var(--crit)" }} title={`${LOC[l].n} is out of stock`}>{fq(0, r.k)}</span>;
                if (l === "store" && IT[r.k].rl > 0 && v <= IT[r.k].rl)
                  return <span style={{ color: "var(--warn)" }} title={`Reorder level ${IT[r.k].rl}`}>{fq(v, r.k)}</span>;
                return <>{fq(v, r.k)}</>;
              }),
              r.held ? <b>{fq(r.tot, r.k)}</b> : <span className="dim">–</span>,
              r.held ? money0(r.value) : <span className="dim">–</span>,
            ],
          }))}
          empty={{
            title: "No item matches this filter",
            sub: "Clear the search box or cycle the type filter back to All.",
          }}
        />
        <TableFoot
          count={rows.length}
          extra={<>Value shown {lakh(shownValue)} · all locations {lakh(totalValue)}</>}
        />
      </Card>
    </>
  );
}
