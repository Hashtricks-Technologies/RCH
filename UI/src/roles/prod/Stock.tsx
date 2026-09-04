import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { isReqOpen, parOf, qty, stateLabel, stateTone, stockValue } from "../../lib/selectors";
import { fq, money, money0, sum } from "../../lib/fmt";
import {
  Alert, Btn, BtnRow, Card, DataTable, Field, FilterSelect, FormRow, PageHead, Pill, Section,
  TableFoot, Tag, Toolbar,
} from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer } from "../../drawers";
import type { ItemType } from "../../types";

/* The kitchen works to its own par levels — deliberately smaller than the reorder
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

/** The kitchen makes and holds. It never invents an MRP good — those are bought in
 *  by procurement and priced off a printed MRP, which the kitchen has no sight of. */
const KITCHEN_TYPES: { t: ItemType; label: string; hint: string }[] = [
  { t: "FG", label: "Finished good (FG)", hint: "Made in the kitchen and sent out to the outlets" },
  { t: "RAW", label: "Raw material (RAW)", hint: "Consumed by a recipe in the kitchen" },
];

function NewProductDrawer() {
  const createItem = useApp((x) => x.createItem);
  const close = useApp((x) => x.closeDrawer);

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [type, setType] = useState<ItemType>("FG");
  const [group, setGroup] = useState("Bakery");
  const [unit, setUnit] = useState("nos");
  const [hsn, setHsn] = useState("2106");
  const [gst, setGst] = useState("5");
  const [reorder, setReorder] = useState("0");
  const [cost, setCost] = useState("");
  const [shelf, setShelf] = useState("");
  const [opening, setOpening] = useState("");

  const trimmed = name.trim();
  const duplicate = trimmed.length > 0
    && Object.values(IT).some((i) => i.n.toLowerCase() === trimmed.toLowerCase());
  const costN = Number(cost);
  const badCost = !(costN > 0);
  const openingN = Number(opening) || 0;
  const nameErr = !trimmed ? "Give the product a name" : duplicate ? `${trimmed} is already in the catalogue` : "";
  const costErr = badCost ? "Cost must be above zero — stock value is read off it" : "";
  const ok = !nameErr && !costErr;

  const save = () => {
    if (!ok) return;
    createItem({
      key: "",
      name: trimmed,
      code: code.trim(),
      unit,
      type,
      group: group.trim() || "Other",
      hsn: hsn.trim() || "2106",
      gst: Number(gst) || 0,
      reorder: Number(reorder) || 0,
      cost: costN,
      ...(Number(shelf) > 0 ? { shelfLife: Number(shelf) } : {}),
    }, "kitchen", openingN);
    close();
  };

  return (
    <DrawerFrame
      title="New product"
      sub="Books into the Central Kitchen · KT-CK"
      foot={<>
        <Btn variant="gh" onClick={close}>Cancel</Btn>
        <Btn disabled={!ok} onClick={save}>Add to the catalogue</Btn>
      </>}
    >
      <Alert tone="i" label="SCOPE">
        A product added here joins the item master for everyone and books its opening stock at the
        Central Kitchen. The kitchen may add what it makes (FG) and what it consumes (RAW) — MRP goods
        are bought in and are added by the central store.
      </Alert>

      <Section title="Identity" sub="The name is what every screen shows; the code is what the store keeper reads." />
      <FormRow cols="f2">
        <Field label="Product name" hint={nameErr
          ? <span style={{ color: "var(--crit)" }}>{nameErr}</span>
          : "Say what it is, the way the kitchen says it."}>
          <input value={name} onChange={(e) => setName(e.target.value)}
            style={nameErr ? { borderColor: "var(--crit)" } : undefined}
            placeholder="Masala bun" />
        </Field>
        <Field label="Item code" hint="Leave blank and one is generated from the name.">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="FG-4004" />
        </Field>
      </FormRow>
      <FormRow cols="f2">
        <Field label="Type" hint={KITCHEN_TYPES.find((k) => k.t === type)?.hint}>
          <select value={type} onChange={(e) => setType(e.target.value as ItemType)}>
            {KITCHEN_TYPES.map((k) => <option key={k.t} value={k.t}>{k.label}</option>)}
          </select>
        </Field>
        <Field label="Group" hint="Groups the picker and the stock tables by.">
          <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Bakery" />
        </Field>
      </FormRow>

      <Section title="Measure and tax" sub="Everything downstream — requests, tickets, GRNs — is quoted in this unit." />
      <FormRow cols="f3">
        <Field label="Unit">
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="nos">nos</option>
            <option value="kg">kg</option>
            <option value="L">L</option>
          </select>
        </Field>
        <Field label="HSN">
          <input value={hsn} onChange={(e) => setHsn(e.target.value)} />
        </Field>
        <Field label="GST %">
          <input type="number" min={0} step="any" value={gst} onChange={(e) => setGst(e.target.value)} />
        </Field>
      </FormRow>

      <Section title="Levels and cost" sub="The reorder level is the central store's; the kitchen par is derived from it." />
      <FormRow cols="f3">
        <Field label="Reorder level" hint="0 if it is never reordered.">
          <input type="number" min={0} step="any" value={reorder} onChange={(e) => setReorder(e.target.value)} />
        </Field>
        <Field label="Cost a unit (₹)" hint={costErr
          ? <span style={{ color: "var(--crit)" }}>{costErr}</span>
          : "What one unit costs the hospital."}>
          <input type="number" min={0} step="any" value={cost} onChange={(e) => setCost(e.target.value)}
            style={costErr ? { borderColor: "var(--crit)" } : undefined} placeholder="0.00" />
        </Field>
        <Field label="Shelf life (hours)" hint="Blank if it does not carry a best-before.">
          <input type="number" min={0} step={1} value={shelf} onChange={(e) => setShelf(e.target.value)} />
        </Field>
      </FormRow>
      <Field label="Opening stock in the kitchen"
        hint={openingN > 0
          ? <>{openingN} {unit} will be booked onto the kitchen rack straight away.</>
          : "Leave at zero and the product joins the catalogue with nothing on the rack yet."}>
        <input type="number" min={0} step="any" value={opening}
          onChange={(e) => setOpening(e.target.value)} placeholder="0" />
      </Field>

      <BtnRow>
        <Btn disabled={!ok} onClick={save}>Add to the catalogue</Btn>
      </BtnRow>
    </DrawerFrame>
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
  /** Which item's request is in flight — the typed quantity is only dropped once it landed. */
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
        actions={<>
          <span className="mini">Stock value {money0(total)}</span>
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
