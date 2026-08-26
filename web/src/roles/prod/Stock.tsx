import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { qty, stateLabel, stateTone, stockValue } from "../../lib/selectors";
import { fq, money, money0, sum } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, PageHead, Pill, TableFoot, Tag, Toolbar,
} from "../../ui/kit";

/* The kitchen works to its own par levels — they are deliberately smaller than the
   reorder levels the central store keeps for the same item. */
const KPAR: Record<string, number> = {
  maida: 10, oil: 5, fill: 4, butter: 1.5, bread: 8, cup: 150, box: 100, milk: 6, sugar: 4,
};
const parOf = (k: string) => KPAR[k] ?? (IT[k]?.rl ?? 0) * 0.4;

export default function Stock() {
  const s = useApp();
  const notify = useApp((x) => x.notify);
  const [q, setQ] = useState("");
  const [rq, setRq] = useState("");

  const held = Object.keys(s.stock.kitchen);
  const hit = (term: string) => (k: string) =>
    !term.trim() || (IT[k].n + " " + IT[k].c + " " + IT[k].g).toLowerCase().includes(term.trim().toLowerCase());

  const fg = held.filter((k) => IT[k]?.t === "FG").filter(hit(q));
  const raw = held.filter((k) => IT[k]?.t === "RAW" || IT[k]?.t === "PACK").filter(hit(rq));

  const valueOf = (k: string) => qty(s, "kitchen", k) * IT[k].cost;
  const total = stockValue(s, "kitchen");
  const lowRaw = raw.filter((k) => qty(s, "kitchen", k) < parOf(k));

  const baseCols = [
    { h: "Item", cls: "nm", w: "26%" },
    { h: "Type", w: "10%" },
    { h: "On hand", r: true, w: "11%" },
    { h: "Unit", w: "8%" },
    { h: "Cost", r: true, w: "11%" },
    { h: "Value", r: true, w: "12%" },
    { h: "State", w: "12%" },
  ];

  const baseCells = (k: string) => {
    const have = qty(s, "kitchen", k);
    const par = parOf(k);
    return [
      <>{IT[k].n}<small>{IT[k].c} · {IT[k].g}</small></>,
      <Tag kind={IT[k].t === "FG" ? "md" : undefined}>{IT[k].t}</Tag>,
      <b>{fq(have, k)}</b>,
      IT[k].u,
      money(IT[k].cost),
      money0(valueOf(k)),
      <Pill tone={stateTone(have, par)}>{stateLabel(have, par)}</Pill>,
    ];
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Kitchen", "Kitchen Stock"]}
        title="What the kitchen is holding"
        sub={`${LOC.kitchen.n} · ${LOC.kitchen.c} · ${LOC.kitchen.cc} — this location only.`}
        actions={<span className="mini">Stock value {money0(total)}</span>}
      />

      {lowRaw.length > 0 && (
        <Alert tone="w" label="LOW">
          {lowRaw.map((k) => IT[k].n).join(", ")} {lowRaw.length > 1 ? "are" : "is"} under the kitchen par
          level. Raise a request with the store keeper from the table below.
        </Alert>
      )}

      <Card title="Products made here" sub="Finished goods on the kitchen rack" flush className="mtop">
        <Toolbar placeholder="Search item, code or group…" value={q} onSearch={setQ} />
        <DataTable
          cols={baseCols}
          rows={fg.map((k) => ({ key: k, cells: baseCells(k) }))}
          empty={{
            title: "Nothing finished on the rack",
            sub: "Make a batch of puffs, sandwiches or salad from Make & Distribute.",
          }}
        />
        <TableFoot
          count={fg.length}
          extra={<>Finished goods {money0(sum(fg, valueOf))} · Kitchen stock value <b>{money0(total)}</b></>}
        />
      </Card>

      <Card
        title="Raw materials and packaging held"
        sub="Issued to the kitchen by the central store"
        flush
        className="mtop"
      >
        <Toolbar placeholder="Search raw material or packaging…" value={rq} onSearch={setRq} />
        <DataTable
          cols={[...baseCols, { h: "Action", w: "16%" }]}
          rows={raw.map((k) => {
            const have = qty(s, "kitchen", k);
            const par = parOf(k);
            return {
              key: k,
              cells: [
                ...baseCells(k),
                have < par
                  ? <Btn size="xs" variant="gh" onClick={() =>
                      notify(`Request for ${IT[k].n} has gone to the store keeper at ${LOC.store.n}`)}>
                      Request from store
                    </Btn>
                  : <span className="dim mini">Par {fq(par, k)}</span>,
              ],
            };
          })}
          empty={{
            title: "No raw materials in the kitchen",
            sub: "Ask the store keeper to issue against a stock request.",
          }}
        />
        <TableFoot
          count={raw.length}
          extra={<>Raw &amp; packaging {money0(sum(raw, valueOf))} · Kitchen stock value <b>{money0(total)}</b></>}
        />
      </Card>
    </>
  );
}
