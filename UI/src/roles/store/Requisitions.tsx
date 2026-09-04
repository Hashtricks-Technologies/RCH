import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { suggestVendor, vendorName } from "../../data/vendors";
import { useApp } from "../../store";
import { avail, awaitingApproval, onOrder, prqProgress, qty } from "../../lib/selectors";
import { U, fq, money, money0, sum } from "../../lib/fmt";
import {
  Alert, Btn, BtnRow, Card, DataTable, Field, FilterBtn, FilterSelect, Grid, PageHead, StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { DraftLine } from "../../types";
import "./RequisitionDetail";

/** The progress labels prqProgress() can return, plus "All" — a real filter
 *  over what procurement has done, not over the raw requisition status. */
const STAGES = [
  "All", "Awaiting approval", "Awaiting order", "Partly ordered", "Ordered",
  "Partly received", "Received", "Declined",
] as const;

export default function Requisitions() {
  const s = useApp();
  const prq = useApp((x) => x.prq);
  const prqDraft = useApp((x) => x.prqDraft);
  const setPrqDraft = useApp((x) => x.setPrqDraft);
  const sendRequisition = useApp((x) => x.sendRequisition);
  const notify = useApp((x) => x.notify);

  const openDrawer = useApp((x) => x.openDrawer);

  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [si, setSi] = useState(0);
  const [openOnly, setOpenOnly] = useState(false);

  // `IT` is the registry every screen reads, and a refetch of "items" replaces its contents in
  // place (`applyItems` -> `hydrateItems`) rather than handing back a new object. The list below
  // is therefore built during render and pinned to `catalogVersion`, which is what tells React a
  // product was added.
  void s.catalogVersion;
  const BUYABLE = Object.keys(IT)
    .filter((k) => IT[k].t === "RAW" || IT[k].t === "PACK" || IT[k].t === "MRP")
    .sort((a, b) => IT[a].g.localeCompare(IT[b].g) || IT[a].n.localeCompare(IT[b].n));
  const BUY_GROUPS = [...new Set(BUYABLE.map((k) => IT[k].g))];

  const stage = STAGES[si];

  const setLine = (i: number, patch: Partial<DraftLine>) => {
    const next = prqDraft.map((l, n) => (n === i ? { ...l, ...patch } : l));
    setPrqDraft(next);
  };
  const removeLine = (i: number) => setPrqDraft(prqDraft.filter((_, n) => n !== i));

  /** Ordering something procurement is already sourcing doubles the cover
   *  (M3). onOrder() alone only reflects an approved commitment — a
   *  requisition still awaiting a decision is the highest-risk window for a
   *  duplicate ask, so the guard adds awaitingApproval() in too. */
  const openQty = (it: string) => onOrder(s, it) + awaitingApproval(s, it);
  const warnOnOrder = (it: string) => {
    const open = openQty(it);
    if (open > 0) notify(`${IT[it].n} already has ${fq(open, it)} ${U(it)} on an open requisition`);
  };
  const pickLine = (i: number, it: string) => { setLine(i, { it }); warnOnOrder(it); };
  const addLine = () => {
    const used = new Set(prqDraft.map((l) => l.it));
    const next = BUYABLE.find((k) => !used.has(k)) ?? BUYABLE[0];
    setPrqDraft([...prqDraft, { it: next, qty: 0 }]);
    warnOnOrder(next);
  };

  const low = Object.keys(s.stock.store)
    .filter((it) => IT[it] && IT[it].rl > 0 && avail(s, "store", it) < IT[it].rl)
    .map((it) => ({ it, want: Math.max(1, Math.ceil(IT[it].rl * 1.6 - qty(s, "store", it))) }));

  const fillFromLow = () => {
    if (!low.length) { notify("Every central store line is above its reorder level"); return; }
    const merged = prqDraft.slice();
    for (const l of low) {
      const at = merged.findIndex((x) => x.it === l.it);
      if (at >= 0) merged[at] = { it: l.it, qty: Math.max(merged[at].qty, l.want) };
      else merged.push({ it: l.it, qty: l.want });
    }
    setPrqDraft(merged);
    notify(`${low.length} below-reorder item${low.length > 1 ? "s" : ""} staged on the requisition`);
  };

  /** The draft and its note are cleared only once the server has taken the requisition —
   *  a refusal has to land on what the store keeper just built, not on an empty card. */
  const send = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await sendRequisition(note);
    setBusy(false);
    if (ok) setNote("");
  };

  const draftValue = sum(prqDraft, (l) => (IT[l.it]?.cost ?? 0) * l.qty);
  const draftQty = sum(prqDraft, (l) => l.qty);
  const alreadyOpen = prqDraft.filter((l) => openQty(l.it) > 0);

  const term = q.trim().toLowerCase();
  /** Every purchase order this requisition ended up on — the buyer's paperwork
   *  is exactly what the client wants to search a previous requisition by. */
  const posFor = (id: string) =>
    s.po.filter((o) => o.st !== "Cancelled" && o.lines.some((l) => l.src.some((x) => x.prq === id)));

  const history = prq.filter((p) => {
    const label = prqProgress(s, p.id).label;
    if (stage !== "All" && label !== stage) return false;
    if (openOnly && (label === "Received" || label === "Declined")) return false;
    if (!term) return true;
    const pos = posFor(p.id);
    return p.id.toLowerCase().includes(term)
      || p.by.toLowerCase().includes(term)
      || p.st.toLowerCase().includes(term)
      || label.toLowerCase().includes(term)
      || p.note.toLowerCase().includes(term)
      || p.lines.some((l) => (IT[l.it]?.n ?? l.it).toLowerCase().includes(term) || (IT[l.it]?.c ?? "").toLowerCase().includes(term))
      || pos.some((o) => o.id.toLowerCase().includes(term) || vendorName(s.vendors, o.vendor).toLowerCase().includes(term));
  });
  const filtered = prq.length > 0 && history.length === 0;
  const resetFilters = () => { setQ(""); setSi(0); setOpenOnly(false); };
  const openValue = sum(
    prq.filter((p) => p.st !== "Declined"),
    (p) => sum(p.lines, (l) => (IT[l.it]?.cost ?? 0) * l.qty),
  );

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Store", "Purchasing"]}
        title="Stock requisitions"
        sub={`Raised by the store keeper on the procurement team · ${LOC.store.n}`}
        actions={<Btn variant="gh" onClick={fillFromLow}>Fill from below-reorder items</Btn>}
      />

      {alreadyOpen.length > 0 && (
        <Alert tone="w" label="ALREADY ON ORDER">
          {alreadyOpen.map((l) => `${IT[l.it]?.n ?? l.it} (${fq(openQty(l.it), l.it)} ${U(l.it)})`).join(", ")}
          {" "}{alreadyOpen.length > 1 ? "sit" : "sits"} on a requisition procurement has not closed yet. Requisition
          again only if the open quantity will not cover you.
        </Alert>
      )}

      {low.length > 0 && (
        <Alert tone="w" label="REORDER" action={<Btn size="sm" onClick={fillFromLow}>Stage {low.length} item{low.length > 1 ? "s" : ""}</Btn>}>
          {low.length} central store item{low.length > 1 ? "s are" : " is"} below reorder level. Suggested quantity
          brings each back to 1.6 × the reorder level.
        </Alert>
      )}

      <Grid>
        <Card
          title="New requisition"
          sub={`${prqDraft.length} item${prqDraft.length === 1 ? "" : "s"} · ${draftQty} units · ${money0(draftValue)} estimated`}
          right={<Btn size="sm" variant="gh" onClick={fillFromLow}>Fill from below-reorder items</Btn>}
        >
          <div className="tw">
            <table className="lgrid">
              <thead>
                <tr>
                  <th style={{ width: "28%" }}>Item</th>
                  <th style={{ width: "12%" }} className="r">Quantity</th>
                  <th style={{ width: "8%" }}>Unit</th>
                  <th style={{ width: "11%" }} className="r">On hand</th>
                  <th style={{ width: "12%" }} className="r">On order</th>
                  <th style={{ width: "11%" }} className="r">Reorder</th>
                  <th style={{ width: "12%" }} className="r">Est. value</th>
                  <th style={{ width: "6%" }} />
                </tr>
              </thead>
              <tbody>
                {prqDraft.length === 0 ? (
                  <tr>
                    <td colSpan={8}>
                      <div className="empty">
                        <b>No items on this requisition yet</b>
                        <p>Add an item by hand, or stage every central store item that is below its reorder level.</p>
                        <BtnRow>
                          <Btn size="sm" onClick={addLine}>Add item</Btn>
                          <Btn size="sm" variant="gh" onClick={fillFromLow}>Fill from below-reorder items</Btn>
                        </BtnRow>
                      </div>
                    </td>
                  </tr>
                ) : (
                  prqDraft.map((l, i) => {
                    const it = IT[l.it];
                    const open = openQty(l.it);
                    return (
                      <tr key={l.it + ":" + i}>
                        <td>
                          <select value={l.it} onChange={(e) => pickLine(i, e.target.value)}>
                            {BUY_GROUPS.map((g) => (
                              <optgroup key={g} label={g}>
                                {BUYABLE.filter((k) => IT[k].g === g).map((k) => (
                                  <option key={k} value={k}>{IT[k].n} · {IT[k].c}</option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                        </td>
                        <td className="n">
                          <input
                            type="number"
                            min={0}
                            step={it && it.u === "nos" ? 1 : 0.5}
                            value={l.qty}
                            aria-label={it ? `Quantity of ${it.n}` : `Quantity on item ${i + 1}`}
                            onChange={(e) => setLine(i, { qty: Number(e.target.value) })}
                          />
                        </td>
                        <td className="dim">{U(l.it)}</td>
                        <td className="n">{fq(qty(s, "store", l.it), l.it)}</td>
                        <td className="n">
                          {open > 0
                            ? <b style={{ color: "var(--warn)" }} title="Already on an open requisition">{fq(open, l.it)}</b>
                            : <span className="dim">{fq(0, l.it)}</span>}
                        </td>
                        <td className="n">{fq(it ? it.rl : 0, l.it)}</td>
                        <td className="n">{money0((it?.cost ?? 0) * l.qty)}</td>
                        <td className="rt">
                          <Btn size="xs" variant="gh" onClick={() => removeLine(i)}>Remove</Btn>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="mtop">
            <BtnRow>
              <Btn size="sm" variant="gh" onClick={addLine}>Add item</Btn>
              {prqDraft.length > 0 && (
                <Btn size="sm" variant="gh" onClick={() => setPrqDraft([])}>Clear all items</Btn>
              )}
            </BtnRow>
          </div>

          <div className="mtop">
            <Field
              label="Note to procurement"
              hint={
                prqDraft.length
                  ? `Likely vendors: ${[...new Set(prqDraft.map((l) => suggestVendor(s.vendors, IT[l.it]?.g ?? "")?.n ?? "—"))].join(", ")}`
                  : "Say why the stock is needed — procurement uses this to pick a vendor and a delivery date."
              }
            >
              <textarea
                rows={2}
                value={note}
                placeholder="Milk at zero in the coffee shop, store has 12 L left."
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </div>

          <div className="totrow big">
            <span>Estimated value</span>
            <span>{money(draftValue)}</span>
          </div>

          <BtnRow end>
            <Btn variant="gh" onClick={() => { setPrqDraft([]); setNote(""); }}>Discard</Btn>
            {/* A line with no quantity on it is dropped before the post, so a draft of nothing
                but zeroes would reach the server as an empty `lines` array and come back as a
                generic 400 instead of the service's own sentence. */}
            <Btn disabled={busy || !prqDraft.some((l) => l.qty > 0)} onClick={send}>
              {busy ? "Sending…" : "Send to procurement"}
            </Btn>
          </BtnRow>
        </Card>

        <Card
          title="Previous requisitions"
          sub="Raised by the central store on procurement · open a row to see what was actually ordered"
          flush
        >
          <Toolbar
            placeholder="Search requisition, raiser, item, purchase order or vendor…"
            value={q}
            onSearch={setQ}
            filters={
              <>
                <FilterSelect label="Stage" value={stage} options={STAGES} onChange={(v) => setSi(STAGES.indexOf(v as (typeof STAGES)[number]))} />
                <FilterBtn label="Still open only" active={openOnly} onClick={() => setOpenOnly((v) => !v)} />
              </>
            }
            right={<span className="mini">{money0(openValue)} open with procurement</span>}
          />
          <DataTable
            cols={[
              { h: "Requisition ID", cls: "nm", w: "15%" },
              { h: "Raised", w: "7%" },
              { h: "Raised by", w: "12%" },
              { h: "Items", r: true },
              { h: "Total qty", r: true },
              { h: "Estimated value", r: true },
              { h: "Ordered on", w: "18%" },
              { h: "Received", r: true },
              { h: "Stage", w: "13%" },
            ]}
            rows={history.map((p) => {
              const g = prqProgress(s, p.id);
              const pos = posFor(p.id);
              return {
                key: p.id,
                onClick: () => openDrawer("sprq", p.id),
                cells: [
                  <>
                    {p.id}
                    <small>{p.lines.map((l) => IT[l.it]?.n ?? l.it).join(", ")}</small>
                  </>,
                  <span className="mono">{p.at}</span>,
                  <>{p.by}</>,
                  <>{p.lines.length}</>,
                  <b>{sum(p.lines, (l) => l.qty)}</b>,
                  <>{money0(sum(p.lines, (l) => (IT[l.it]?.cost ?? 0) * l.qty))}</>,
                  pos.length ? (
                    <>
                      <span className="mono-id">{pos.map((o) => o.id).join(", ")}</span>
                      <div className="mini">
                        {[...new Set(pos.map((o) => vendorName(s.vendors, o.vendor)))].join(", ")} · due{" "}
                        {[...new Set(pos.map((o) => o.eta))].join(", ")}
                      </div>
                    </>
                  ) : (
                    <span className="dim">No purchase order yet</span>
                  ),
                  <>
                    {fq(g.received, "")} <span className="dim">of {fq(g.ordered, "")}</span>
                  </>,
                  <>
                    <StatusPill status={g.label} />
                    <div className="mini">{fq(g.ordered, "")} of {fq(g.appr, "")} approved ordered</div>
                  </>,
                ],
              };
            })}
            empty={filtered
              ? {
                title: "Nothing matches those filters",
                sub: `${prq.length} requisition${prq.length > 1 ? "s are" : " is"} on file, but none of them match.`,
                action: <Btn size="sm" variant="gh" onClick={resetFilters}>Reset filters</Btn>,
              }
              : {
                title: "No requisitions raised yet",
                sub: "Build one above and send it to the procurement team.",
                action: <Btn size="sm" onClick={fillFromLow}>Fill from below-reorder items</Btn>,
              }}
          />
          <TableFoot
            count={history.length}
            extra={<>{money0(sum(history, (p) => sum(p.lines, (l) => (IT[l.it]?.cost ?? 0) * l.qty)))} total requisitioned</>}
          />
        </Card>
      </Grid>
    </>
  );
}
