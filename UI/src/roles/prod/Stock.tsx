import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
// ---- item patch ----
import { isReqOpen, isRetired, parOf, qty, stateLabel, stateTone, stockValue } from "../../lib/selectors";
import { fq, money, money0, sum } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, FilterSelect, PageHead, Pill, TableFoot, Tag, Toolbar,
} from "../../ui/kit";
import { NewProductForm } from "../../ui/NewProductForm";
import { registerDrawer } from "../../drawers";

/* The kitchen works to its own par levels - deliberately smaller than the reorder
   levels the central store keeps for the same item. */
const par = (k: string) => parOf("kitchen", k);
/** Bring the item back to par, never less than one unit of it. */
const topUp = (k: string, have: number) =>
  Math.max(IT[k]?.u === "nos" ? 1 : 0.5, Math.round((par(k) - have) * 1000) / 1000);

const STATES = ["All", "Healthy", "Low", "Out"] as const;
type StateF = (typeof STATES)[number];
const KINDS = ["All", "Raw material", "Packaging"] as const;
type KindF = (typeof KINDS)[number];

/* ------------------------------------------------------------------ new product */

/**
 * The kitchen's own Add Product panel. It is the shared form (`ui/NewProductForm.tsx`) under
 * the `kitchen` scope, which is deliberately narrower than the store keeper's: the kitchen may
 * add what it makes (FG) and what it consumes (RAW), never an MRP good - those are bought in by
 * procurement and priced off a printed MRP the kitchen has no sight of - and it carries a shelf
 * life, which is the one field no other desk fills in.
 */
function NewProductDrawer() {
  return (
    <NewProductForm
      scope="kitchen"
      title="New product"
      sub={`Books into ${LOC.kitchen.n} · ${LOC.kitchen.c}`}
      intro={
        <Alert tone="i" label="SCOPE">
          A product added here joins the item master for everyone and books its opening stock at the
          {" "}{LOC.kitchen.n}. The kitchen may add what it makes (FG) and what it consumes (RAW) - MRP
          goods are bought in and are added by the central store.
        </Alert>
      }
    />
  );
}

registerDrawer("pnew", NewProductDrawer);

/* ------------------------------------------------------------------ screen */

export default function Stock() {
  const s = useApp();
  const requestFromStore = useApp((x) => x.requestFromStore);
  const openDrawer = useApp((x) => x.openDrawer);
  const [q, setQ] = useState("");
  const [fgState, setFgState] = useState<StateF>("All");
  const [rq, setRq] = useState("");
  const [kind, setKind] = useState<KindF>("All");
  const [want, setWant] = useState<Record<string, string>>({});
  /** Which item's request is in flight - the typed quantity is only dropped once it landed. */
  const [busy, setBusy] = useState<string | null>(null);

  const held = Object.keys(s.stock.kitchen);
  const hit = (term: string) => (k: string) =>
    !term.trim() || (IT[k].n + " " + IT[k].c + " " + IT[k].g + " " + IT[k].t)
      .toLowerCase().includes(term.trim().toLowerCase());
  const inState = (k: string) =>
    fgState === "All" || stateLabel(qty(s, "kitchen", k), par(k)) === fgState;
  const inKind = (k: string) =>
    kind === "All" || (kind === "Raw material" ? IT[k].t === "RAW" : IT[k].t === "PACK");

  const allFg = held.filter((k) => IT[k]?.t === "FG");
  const allRaw = held.filter((k) => IT[k]?.t === "RAW" || IT[k]?.t === "PACK");
  const fg = allFg.filter(hit(q)).filter(inState);
  const raw = allRaw.filter(hit(rq)).filter(inKind);

  const fgFiltering = Boolean(q.trim() || fgState !== "All");
  const rawFiltering = Boolean(rq.trim() || kind !== "All");
  const clearFg = () => { setQ(""); setFgState("All"); };
  const clearRaw = () => { setRq(""); setKind("All"); };

  const valueOf = (k: string) => qty(s, "kitchen", k) * IT[k].cost;
  const total = stockValue(s, "kitchen");
  const lowRaw = allRaw.filter((k) => qty(s, "kitchen", k) < par(k));
  const openReq = (k: string) =>
    s.req.find((r) => r.from === "kitchen" && isReqOpen(r.st) && r.lines.some((l) => l.it === k));

  const ask = async (k: string, dflt: number) => {
    setBusy(k);
    const ok = await requestFromStore(k, Number(want[k] ?? dflt) || 0);
    setBusy(null);
    if (!ok) return;
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
    // ---- item patch ----
    { h: "", r: true, w: "8%" },
  ];

  const baseCells = (k: string) => {
    const have = qty(s, "kitchen", k);
    return [
      // ---- item patch ----
      // A retired line the kitchen is still holding reads greyed and says so: that stock has to
      // be used up or written off, and nothing is coming to replace it.
      <>
        {isRetired(k) ? <span className="dim">{IT[k].n}</span> : IT[k].n}
        {isRetired(k) && <> <Tag>Retired</Tag></>}
        <small>{IT[k].c} · {IT[k].g}</small>
      </>,
      <Tag kind={IT[k].t === "FG" ? "md" : undefined}>{IT[k].t}</Tag>,
      <b>{fq(have, k)}</b>,
      IT[k].u,
      money(IT[k].cost),
      money0(valueOf(k)),
      <Pill tone={stateTone(have, par(k))}>{stateLabel(have, par(k))}</Pill>,
      // ---- item patch ----
      // The kitchen keeps an item's name, group, HSN and reorder level, the same as the store
      // and the buyer; the drawer greys out the manager's cost, GST and printed MRP.
      <Btn size="xs" variant="gh" onClick={() => openDrawer("item", k)}>
        {isRetired(k) ? "Restore" : "Edit"}
      </Btn>,
    ];
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Kitchen", "Kitchen Stock"]}
        title="What the kitchen is holding"
        sub="Ingredients and finished goods in the kitchen."
        actions={<>
          <span className="mini">Stock value {money0(total)}</span>
          {/* ---- adjustments: a tray that went over or a bag that split leaves the kitchen
              without going anywhere, and the books have to follow it with a reason on them. */}
          <Btn variant="gh" onClick={() => openDrawer("adjstock", "kitchen")}>Write off</Btn>
          <Btn onClick={() => openDrawer("pnew", "new")}>New product</Btn>
        </>}
      />

      {lowRaw.length > 0 && (
        <Alert tone="w" label="LOW">
          {lowRaw.map((k) => IT[k].n).join(", ")} {lowRaw.length > 1 ? "are" : "is"} under the kitchen par
          level. Raise a request with the store keeper from the table below.
        </Alert>
      )}

      <Card title="Products made here" sub="Finished goods on the kitchen rack" flush className="mtop">
        <Toolbar
          placeholder="Search item, code or group…"
          value={q}
          onSearch={setQ}
          filters={<FilterSelect label="State" value={fgState} options={STATES} onChange={(v) => setFgState(v as StateF)} />}
          right={fgFiltering
            ? <Btn size="sm" variant="gh" onClick={clearFg}>Clear filters</Btn>
            : <Btn size="sm" variant="gh" onClick={() => openDrawer("pnew", "new")}>New product</Btn>}
        />
        <DataTable
          cols={baseCols}
          rows={fg.map((k) => ({ key: k, cells: baseCells(k) }))}
          empty={{
            title: fgFiltering ? "Nothing matches those filters" : "Nothing finished on the rack",
            sub: fgFiltering
              ? `${allFg.length} finished good${allFg.length === 1 ? "" : "s"} are held here with the filters cleared.`
              : "Make a batch from Make & Distribute, or add a new product and book its opening stock.",
            action: fgFiltering
              ? <Btn size="sm" onClick={clearFg}>Clear filters</Btn>
              : <Btn size="sm" onClick={() => openDrawer("pnew", "new")}>New product</Btn>,
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
        <Toolbar
          placeholder="Search raw material or packaging…"
          value={rq}
          onSearch={setRq}
          filters={<FilterSelect label="Kind" value={kind} options={KINDS} onChange={(v) => setKind(v as KindF)} />}
          right={rawFiltering
            ? <Btn size="sm" variant="gh" onClick={clearRaw}>Clear filters</Btn>
            : <span className="mini">{lowRaw.length} under par</span>}
        />
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
                          <Btn size="xs" disabled={busy !== null} onClick={() => ask(k, dflt)}>
                            {busy === k ? "Sending…" : "Request"}
                          </Btn>
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
              title: rawFiltering ? "Nothing matches those filters" : "No raw materials in the kitchen",
              sub: rawFiltering
                ? `${allRaw.length} raw and packaging item${allRaw.length === 1 ? "" : "s"} are held here with the filters cleared.`
                : "Ask the store keeper to issue against a stock request.",
              action: rawFiltering ? <Btn size="sm" onClick={clearRaw}>Clear filters</Btn> : undefined,
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
