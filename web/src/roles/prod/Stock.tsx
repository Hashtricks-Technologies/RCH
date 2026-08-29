import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { isReqOpen, parOf, qty, stateLabel, stateTone, stockValue } from "../../lib/selectors";
import { fq, money, money0, sum } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, PageHead, Pill, TableFoot, Tag, Toolbar,
} from "../../ui/kit";

/* The kitchen works to its own par levels — deliberately smaller than the reorder
   levels the central store keeps for the same item. */
const par = (k: string) => parOf("kitchen", k);
/** Bring the item back to par, never less than one unit of it. */
const topUp = (k: string, have: number) =>
  Math.max(IT[k]?.u === "nos" ? 1 : 0.5, Math.round((par(k) - have) * 1000) / 1000);

export default function Stock() {
  const s = useApp();
  const requestFromStore = useApp((x) => x.requestFromStore);
  const [q, setQ] = useState("");
  const [rq, setRq] = useState("");
  const [want, setWant] = useState<Record<string, string>>({});

  const held = Object.keys(s.stock.kitchen);
  const hit = (term: string) => (k: string) =>
    !term.trim() || (IT[k].n + " " + IT[k].c + " " + IT[k].g).toLowerCase().includes(term.trim().toLowerCase());

  const fg = held.filter((k) => IT[k]?.t === "FG").filter(hit(q));
  const raw = held.filter((k) => IT[k]?.t === "RAW" || IT[k]?.t === "PACK").filter(hit(rq));

  const valueOf = (k: string) => qty(s, "kitchen", k) * IT[k].cost;
  const total = stockValue(s, "kitchen");
  const lowRaw = raw.filter((k) => qty(s, "kitchen", k) < par(k));
  const openReq = (k: string) =>
    s.req.find((r) => r.from === "kitchen" && isReqOpen(r.st) && r.lines.some((l) => l.it === k));

  const ask = (k: string, dflt: number) => {
    requestFromStore(k, Number(want[k] ?? dflt) || 0);
    setWant((w) => { const n = { ...w }; delete n[k]; return n; });
  };

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
    return [
      <>{IT[k].n}<small>{IT[k].c} · {IT[k].g}</small></>,
      <Tag kind={IT[k].t === "FG" ? "md" : undefined}>{IT[k].t}</Tag>,
      <b>{fq(have, k)}</b>,
      IT[k].u,
      money(IT[k].cost),
      money0(valueOf(k)),
      <Pill tone={stateTone(have, par(k))}>{stateLabel(have, par(k))}</Pill>,
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
        <div className="lgrid">
          <DataTable
            cols={[...baseCols, { h: "Request from store", w: "22%" }]}
            rows={raw.map((k) => {
              const have = qty(s, "kitchen", k);
              const dflt = topUp(k, have);
              const open = openReq(k);
              return {
                key: k,
                cells: [
                  ...baseCells(k),
                  have < par(k)
                    ? <>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <input
                            type="number" min={0} step="any" inputMode="decimal"
                            value={want[k] ?? String(dflt)}
                            onChange={(e) => setWant({ ...want, [k]: e.target.value })}
                            aria-label={`Quantity of ${IT[k].n} to request`}
                          />
                          <Btn size="xs" onClick={() => ask(k, dflt)}>Request</Btn>
                        </div>
                        <div className="hint">
                          {open
                            ? <>{open.id} is already with the outlet manager.</>
                            : <>{fq(dflt, k)} {IT[k].u} brings the kitchen back to par {fq(par(k), k)}.</>}
                        </div>
                      </>
                    : <span className="dim mini">Par {fq(par(k), k)}</span>,
                ],
              };
            })}
            empty={{
              title: "No raw materials in the kitchen",
              sub: "Ask the store keeper to issue against a stock request.",
            }}
          />
        </div>
        <TableFoot
          count={raw.length}
          extra={<>Raw &amp; packaging {money0(sum(raw, valueOf))} · Kitchen stock value <b>{money0(total)}</b></>}
        />
      </Card>
    </>
  );
}
