import { useEffect, useState } from "react";
import { REASON_LABEL, usedOnArrival, valueAtCost, WASTAGE_REASONS } from "@rch/domain";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
// ---- item patch ----
import { activeItems, isReqOpen, isRetired, parOf, qty, stateLabel, stateTone, stockValue, useCan } from "../../lib/selectors";
import { fq, fromWireTime, money, money0, sum, U } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, DraftLineInput, Field, FilterSelect, FormRow, PageHead, Pill, TableFoot, Tag, Toolbar, commitTyping,
} from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { NewProductForm } from "../../ui/NewProductForm";
import { registerDrawer } from "../../drawers";
import type { WastageReason } from "../../types";

/* The kitchen works to its own par levels for what it makes - deliberately smaller than the
   reorder levels the central store keeps for the same item. Its raw materials and packaging have
   no par at all: they are used as they arrive, so the kitchen holds none of them. */
const par = (k: string) => parOf("kitchen", k);

const STATES = ["All", "Healthy", "Low", "Out"] as const;
type StateF = (typeof STATES)[number];
const KINDS = ["All", "Raw material", "Packaging"] as const;
type KindF = (typeof KINDS)[number];
/** The three windows the kitchen reads its issues and its wastage over. */
const WINDOWS = ["Today", "Last 7 days", "Last 30 days"] as const;
type WindowF = (typeof WINDOWS)[number];
const DAYS: Record<WindowF, number> = { Today: 1, "Last 7 days": 7, "Last 30 days": 30 };

/** The raw and packing lines the kitchen uses - what it is issued, and what it may record as wasted. */
const usedLines = () => activeItems().filter((k) => usedOnArrival(IT[k].t, "kitchen"))
  .sort((a, b) => IT[a].n.localeCompare(IT[b].n));

/* ------------------------------------------------------------------ new product */

/**
 * The kitchen's own Add Product panel. It is the shared form (`ui/NewProductForm.tsx`) under
 * the `kitchen` scope, which is deliberately narrower than the store keeper's: the kitchen may
 * add what it makes - counted or on/off only - and what it uses (RAW), never an MRP good - those
 * are bought in by procurement and priced off a printed MRP the kitchen has no sight of.
 */
function NewProductDrawer() {
  return (
    <NewProductForm
      scope="kitchen"
      title="New product"
      sub={`Made or used at ${LOC.kitchen.n} · ${LOC.kitchen.c}`}
      intro={
        <Alert tone="i" label="SCOPE">
          A product added here joins the item master for everyone. A counted one is batched onto the
          {" "}{LOC.kitchen.n}'s rack; an on/off-only one is never counted - the kitchen switches it on and
          off at every outlet. MRP goods are bought in and are added by the central store.
        </Alert>
      }
    />
  );
}

registerDrawer("pnew", NewProductDrawer);

/* ------------------------------------------------------------------ wastage */

/**
 * A loss on a raw or packing line: what, how much, why. It touches no stock - there is none at the
 * kitchen to touch - so it is never refused for "more than is free"; it is a record, valued at the
 * item's standard cost, that the kitchen's report reads back.
 */
function WastageDrawer() {
  const recordWastage = useApp((x) => x.recordWastage);
  const close = useApp((x) => x.closeDrawer);
  const catalogVersion = useApp((x) => x.catalogVersion);
  void catalogVersion;
  const lines = usedLines();
  const [it, setIt] = useState(lines[0] ?? "");
  const [qtyN, setQtyN] = useState(0);
  const [reason, setReason] = useState<WastageReason>("wastage");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await recordWastage({ it, qty: qtyN, reason, note });
    setBusy(false);
    if (ok) close();
  };

  return (
    <DrawerFrame
      title="Record wastage"
      sub={`${LOC.kitchen.n} · raw materials and packaging`}
      foot={<>
        <Btn variant="gh" onClick={close}>Cancel</Btn>
        <div className="sp" />
        <span onMouseDown={commitTyping}>
          <Btn disabled={busy || !it} onClick={() => { void save(); }}>{busy ? "Recording…" : "Record wastage"}</Btn>
        </span>
      </>}
    >
      <Alert tone="i" label="RECORD">
        The kitchen holds no raw or packing stock - each line was used as it arrived - so this records the
        loss and its value at cost, and moves nothing.
      </Alert>
      <FormRow cols="f2">
        <Field label="Item">
          <select value={it} onChange={(e) => setIt(e.target.value)}>
            {lines.map((k) => <option key={k} value={k}>{IT[k].n}</option>)}
          </select>
        </Field>
        <Field label={`Quantity${it ? ` (${U(it)})` : ""}`}
          hint={it && qtyN > 0 ? <>{money(valueAtCost(qtyN, IT[it].cost))} at cost</> : undefined}>
          <DraftLineInput value={qtyN} min={0} step={0.001} blankZero onCommit={setQtyN} ariaLabel="Quantity wasted" />
        </Field>
      </FormRow>
      <FormRow cols="f2">
        <Field label="Reason">
          <select value={reason} onChange={(e) => setReason(e.target.value as WastageReason)}>
            {WASTAGE_REASONS.map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
          </select>
        </Field>
        <Field label="Note" tip="Say what happened - required when the reason is Other.">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Sack found damp" />
        </Field>
      </FormRow>
    </DrawerFrame>
  );
}

registerDrawer("kwaste", WastageDrawer);

/* ------------------------------------------------------------------ screen */

export default function Stock() {
  const s = useApp();
  const requestFromStore = useApp((x) => x.requestFromStore);
  const openDrawer = useApp((x) => x.openDrawer);
  const loadKitchenReport = useApp((x) => x.loadKitchenReport);
  const report = useApp((x) => x.kitchenReport);
  const reportFailed = useApp((x) => x.kitchenReportFailed);
  const mayAdjust = useCan("adjustments");
  const mayCreate = useCan("item_master");
  const mayAsk = useCan("kitchen_requests");
  const [q, setQ] = useState("");
  const [fgState, setFgState] = useState<StateF>("All");
  const [rq, setRq] = useState("");
  const [kind, setKind] = useState<KindF>("All");
  const [win, setWin] = useState<WindowF>("Today");
  const [want, setWant] = useState<Record<string, string>>({});
  /** Which item's request is in flight - the typed quantity is only dropped once it landed. */
  const [busy, setBusy] = useState<string | null>(null);

  // The report is read for the window on screen, and again whenever the kitchen's stock moves -
  // a receipt at the kitchen is an issue this report should now carry. A wastage notice re-reads
  // it through `refetch` (`NARROW.wastage`).
  const days = DAYS[win];
  const stockNow = s.stock;
  useEffect(() => { void loadKitchenReport(days); }, [loadKitchenReport, days, stockNow]);

  const held = Object.keys(s.stock.kitchen);
  const hit = (term: string) => (k: string) =>
    !term.trim() || (IT[k].n + " " + IT[k].c + " " + IT[k].g + " " + IT[k].t)
      .toLowerCase().includes(term.trim().toLowerCase());
  const inState = (k: string) =>
    fgState === "All" || stateLabel(qty(s, "kitchen", k), par(k)) === fgState;
  const inKind = (k: string) =>
    kind === "All" || (kind === "Raw material" ? IT[k].t === "RAW" : IT[k].t === "PACK");

  const allFg = held.filter((k) => IT[k]?.t === "FG");
  const fg = allFg.filter(hit(q)).filter(inState);
  const fgFiltering = Boolean(q.trim() || fgState !== "All");
  const clearFg = () => { setQ(""); setFgState("All"); };

  // What was issued over the window, per item - and every other raw or packing line after it, so
  // any of them can be asked for from here.
  const issued = new Map((report?.issued ?? []).map((r) => [r.it, r]));
  const allRaw = [...new Set([...issued.keys(), ...usedLines()])].filter((k) => IT[k])
    .sort((a, b) => Number(issued.has(b)) - Number(issued.has(a)) || IT[a].n.localeCompare(IT[b].n));
  const raw = allRaw.filter(hit(rq)).filter(inKind);
  const rawFiltering = Boolean(rq.trim() || kind !== "All");
  const clearRaw = () => { setRq(""); setKind("All"); };
  const issuedValue = sum(report?.issued ?? [], (r) => r.value);
  const wastage = report?.wastage ?? [];

  const valueOf = (k: string) => qty(s, "kitchen", k) * IT[k].cost;
  const total = stockValue(s, "kitchen");
  const openReq = (k: string) =>
    s.req.find((r) => r.from === "kitchen" && isReqOpen(r.st) && r.lines.some((l) => l.it === k));

  const ask = async (k: string) => {
    setBusy(k);
    const ok = await requestFromStore(k, Number(want[k] ?? "") || 0);
    setBusy(null);
    if (!ok) return;
    setWant((w) => { const n = { ...w }; delete n[k]; return n; });
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Kitchen", "Kitchen Stock"]}
        title="What the kitchen is holding"
        tip="Finished goods on the rack, and the raw materials and packaging issued to the kitchen - those are used as they arrive, so the kitchen holds none."
        actions={<>
          <span className="mini">Stock value {money0(total)}</span>
          {/* ---- adjustments: a tray that went over leaves the rack without going anywhere, and
              the books have to follow it with a reason on them. A raw line has no shelf - its
              loss is a wastage record instead. */}
          {mayAdjust && <Btn variant="gh" onClick={() => openDrawer("adjstock", "kitchen")}>Write off</Btn>}
          {mayAdjust && <Btn variant="gh" onClick={() => openDrawer("kwaste", "new")}>Record wastage</Btn>}
          {mayCreate && <Btn onClick={() => openDrawer("pnew", "new")}>New product</Btn>}
        </>}
      />

      <Card title="Products made here" tip="Counted finished goods on the kitchen rack" flush className="mtop">
        <Toolbar
          placeholder="Search item, code or group…"
          value={q}
          onSearch={setQ}
          filters={<FilterSelect label="State" value={fgState} options={STATES} onChange={(v) => setFgState(v as StateF)} />}
          right={fgFiltering
            ? <Btn size="sm" variant="gh" onClick={clearFg}>Clear filters</Btn>
            : mayCreate && <Btn size="sm" variant="gh" onClick={() => openDrawer("pnew", "new")}>New product</Btn>}
        />
        <DataTable
          cols={[
            { h: "Item", cls: "nm", w: "26%" },
            { h: "Type", w: "10%" },
            { h: "On hand", r: true, w: "11%" },
            { h: "Unit", w: "8%" },
            { h: "Cost", r: true, w: "11%" },
            { h: "Value", r: true, w: "12%" },
            { h: "State", w: "12%" },
            // ---- item patch ----
            { h: "", r: true, w: "8%" },
          ]}
          rows={fg.map((k) => {
            const have = qty(s, "kitchen", k);
            return {
              key: k,
              cells: [
                // ---- item patch ----
                // A retired line the kitchen is still holding reads greyed and says so: that stock
                // has to be used up or written off, and nothing is coming to replace it.
                <>
                  {isRetired(k) ? <span className="dim">{IT[k].n}</span> : IT[k].n}
                  {isRetired(k) && <> <Tag>Retired</Tag></>}
                  <small>{IT[k].c} · {IT[k].g}</small>
                </>,
                <Tag kind="md">{IT[k].t}</Tag>,
                <b>{fq(have, k)}</b>,
                IT[k].u,
                money(IT[k].cost),
                money0(valueOf(k)),
                <Pill tone={stateTone(have, par(k))}>{stateLabel(have, par(k))}</Pill>,
                // ---- item patch ----
                // The kitchen keeps an item's name, group, HSN, reorder level and whether it is
                // counted or on/off only; the drawer greys out the manager's cost, GST and MRP.
                <Btn size="xs" variant="gh" onClick={() => openDrawer("item", k)}>
                  {!mayCreate ? "View" : isRetired(k) ? "Restore" : "Edit"}
                </Btn>,
              ],
            };
          })}
          empty={{
            title: fgFiltering ? "Nothing matches those filters" : "Nothing finished on the rack",
            sub: fgFiltering
              ? `${allFg.length} finished good${allFg.length === 1 ? "" : "s"} are held here with the filters cleared.`
              : "Make a batch from Make & Distribute, or add a new product and say how many were made.",
            action: fgFiltering
              ? <Btn size="sm" onClick={clearFg}>Clear filters</Btn>
              : mayCreate && <Btn size="sm" onClick={() => openDrawer("pnew", "new")}>New product</Btn>,
          }}
        />
        <TableFoot count={fg.length} extra={<>Kitchen stock value <b>{money0(total)}</b></>} />
      </Card>

      {reportFailed && (
        <Alert tone="c" label="OUTAGE">What was issued to the kitchen could not be read just now - reload to try again.</Alert>
      )}

      <Card
        title="Issued to the kitchen"
        tip="Raw materials and packaging the central store issued to the kitchen over the window, valued at cost. The kitchen uses them as they arrive, so none is held here."
        flush
        className="mtop"
      >
        <Toolbar
          placeholder="Search raw material or packaging…"
          value={rq}
          onSearch={setRq}
          filters={<>
            <FilterSelect label="Period" value={win} options={WINDOWS} onChange={(v) => setWin(v as WindowF)} />
            <FilterSelect label="Kind" value={kind} options={KINDS} onChange={(v) => setKind(v as KindF)} />
          </>}
          right={rawFiltering
            ? <Btn size="sm" variant="gh" onClick={clearRaw}>Clear filters</Btn>
            : <span className="mini">{issued.size} issued · {money0(issuedValue)}</span>}
        />
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "28%" },
              { h: "Type", w: "10%" },
              { h: "Issued", r: true, w: "13%" },
              { h: "Unit", w: "8%" },
              { h: "Value at cost", r: true, w: "15%" },
              { h: "Request from store", w: "26%" },
            ]}
            rows={raw.map((k) => {
              const row = issued.get(k);
              const open = openReq(k);
              return {
                key: k,
                cells: [
                  <>{IT[k].n}<small>{IT[k].c} · {IT[k].g}</small></>,
                  <Tag>{IT[k].t}</Tag>,
                  row ? <b>{fq(row.qty, k)}</b> : <span className="dim">-</span>,
                  IT[k].u,
                  row ? money(row.value) : <span className="dim">-</span>,
                  !mayAsk ? <span className="dim mini">-</span> : (
                    <>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          type="number" min={0} step="any" inputMode="decimal"
                          value={want[k] ?? ""}
                          onChange={(e) => setWant({ ...want, [k]: e.target.value })}
                          aria-label={`Quantity of ${IT[k].n} to request`}
                        />
                        <Btn size="xs" disabled={busy !== null} onClick={() => ask(k)}>
                          {busy === k ? "Sending…" : "Request"}
                        </Btn>
                      </div>
                      {open && <div className="hint">{open.id} is already with the outlet manager.</div>}
                    </>
                  ),
                ],
              };
            })}
            empty={{
              title: rawFiltering ? "Nothing matches those filters" : "No raw materials or packaging on the master",
              sub: rawFiltering
                ? `${allRaw.length} raw and packing line${allRaw.length === 1 ? "" : "s"} with the filters cleared.`
                : "Ask the store keeper to add one.",
              action: rawFiltering ? <Btn size="sm" onClick={clearRaw}>Clear filters</Btn> : undefined,
            }}
          />
        </div>
        <TableFoot count={raw.length} extra={<>Issued {win.toLowerCase()} <b>{money0(issuedValue)}</b> at cost</>} />
      </Card>

      <Card
        title="Wastage"
        tip="Raw materials and packaging the kitchen recorded as thrown away over the same window. A record moves no stock."
        right={mayAdjust && <Btn size="sm" variant="gh" onClick={() => openDrawer("kwaste", "new")}>Record wastage</Btn>}
        flush
        className="mtop"
      >
        <DataTable
          cols={[
            { h: "Record", cls: "nm", w: "16%" },
            { h: "Item", w: "24%" },
            { h: "Quantity", r: true, w: "12%" },
            { h: "Reason", w: "14%" },
            { h: "Value at cost", r: true, w: "13%" },
            { h: "By", w: "13%" },
            { h: "At", w: "8%" },
          ]}
          rows={wastage.map((w) => ({
            key: w.id,
            cells: [
              <>{w.id}{w.note && <small>{w.note}</small>}</>,
              IT[w.it]?.n ?? w.it,
              <>{fq(w.qty, w.it)} <span className="dim">{U(w.it)}</span></>,
              REASON_LABEL[w.reason],
              money(w.value),
              w.by,
              fromWireTime(w.at),
            ],
          }))}
          empty={{
            title: "Nothing wasted in this window",
            sub: "A spoiled sack or a split carton is recorded here, with its value at cost.",
          }}
        />
        <TableFoot count={wastage.length} extra={<>Wasted <b>{money0(sum(wastage, (w) => w.value))}</b> at cost</>} />
      </Card>
    </>
  );
}
