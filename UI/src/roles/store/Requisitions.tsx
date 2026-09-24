import { useMemo, useState } from "react";
import { isPurchased } from "@rch/domain";
import { IT } from "../../data/master";
import { suggestVendor, vendorName } from "../../data/vendors";
import { useApp } from "../../store";
// ---- item patch ----
import { activeItems, addedByProcurement, avail, awaitingApproval, onOrder, prqDecision, prqProgress, qty, useCan } from "../../lib/selectors";
import { U, fq, money, money0, sum, unitTotal } from "../../lib/fmt";
import {
  Alert, Btn, BtnRow, Card, DataTable, DraftLineInput, Field, FilterBtn, FilterSelect, Grid,
  PageHead, StatusPill, TableFoot, Tip, Toolbar, useLineKeys,
} from "../../ui/kit";
import type { PrqProgressLine } from "../../lib/selectors";
import type { DraftLine } from "../../types";
import "./RequisitionDetail";

/** One of `prqProgress`'s per-line quantities, in the shape `unitTotal` reads. */
const qtyBy = (lines: PrqProgressLine[], pick: "appr" | "ordered" | "received") =>
  lines.map((l) => ({ it: l.it, qty: l[pick] }));

/** The progress labels prqProgress() can return, plus "All" - a real filter
 *  over what procurement has done, not over the raw requisition status. */
const STAGES = [
  "All", "Awaiting approval", "Awaiting order", "Partly ordered", "Ordered",
  "Partly received", "Received", "Declined",
] as const;

export default function Requisitions() {
  const s = useApp();
  const prq = useApp((x) => x.prq);
  const po = useApp((x) => x.po);
  const prqDraft = useApp((x) => x.prqDraft);
  const setPrqDraft = useApp((x) => x.setPrqDraft);
  const sendRequisition = useApp((x) => x.sendRequisition);
  const notify = useApp((x) => x.notify);

  const openDrawer = useApp((x) => x.openDrawer);
  const may = useCan("store_requisitions");

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
  // ---- item patch ----
  // `activeItems()`, not `Object.keys(IT)`: a retired line stays in the registry so past
  // documents still name it, and must not be orderable again.
  const BUYABLE = activeItems()
    .filter((k) => isPurchased(IT[k].t))
    .sort((a, b) => IT[a].g.localeCompare(IT[b].g) || IT[a].n.localeCompare(IT[b].n));
  const BUY_GROUPS = [...new Set(BUYABLE.map((k) => IT[k].g))];

  const stage = STAGES[si];

  /** A key per draft line that survives what is typed into it - `useLineKeys` (`ui/kit.tsx`)
   *  says why neither the index nor the line's own contents will do. */
  const [rowKeys, dropKey] = useLineKeys(prqDraft.length);

  const setLine = (i: number, patch: Partial<DraftLine>) => {
    const next = prqDraft.map((l, n) => (n === i ? { ...l, ...patch } : l));
    setPrqDraft(next);
  };
  const removeLine = (i: number) => {
    dropKey(i);
    setPrqDraft(prqDraft.filter((_, n) => n !== i));
  };

  /** Ordering something procurement is already sourcing doubles the cover
   *  (M3). onOrder() alone only reflects an approved commitment - a
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

  /** The draft and its note are cleared only once the server has taken the requisition -
   *  a refusal has to land on what the store keeper just built, not on an empty card. */
  const send = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await sendRequisition(note);
    setBusy(false);
    if (ok) setNote("");
  };

  const draftValue = sum(prqDraft, (l) => (IT[l.it]?.cost ?? 0) * l.qty);
  const draftQty = unitTotal(prqDraft);
  const alreadyOpen = prqDraft.filter((l) => openQty(l.it) > 0);

  const term = q.trim().toLowerCase();
  /** Every purchase order this requisition ended up on - the buyer's paperwork
   *  is exactly what the client wants to search a previous requisition by. */
  const posFor = (id: string) =>
    po.filter((o) => o.st !== "Cancelled" && o.lines.some((l) => l.src.some((x) => x.prq === id)));

  /** Reconciled once per requisition, then read from the map: `prqProgress` walks every
   *  purchase order, the filter and the row both want the answer, and memoising it on the
   *  two slices it reads - rather than on `s`, a new object after any write anywhere -
   *  is what stops the whole of it re-running because a toast appeared. */
  const progress = useMemo(
    () => new Map(prq.map((p) => [p.id, prqProgress({ prq, po }, p.id)] as const)),
    [prq, po],
  );

  const history = prq.filter((p) => {
    const label = progress.get(p.id)!.label;
    if (stage !== "All" && label !== stage) return false;
    if (openOnly && (label === "Received" || label === "Declined")) return false;
    if (!term) return true;
    const pos = posFor(p.id);
    return p.id.toLowerCase().includes(term)
      || p.by.toLowerCase().includes(term)
      || p.st.toLowerCase().includes(term)
      || label.toLowerCase().includes(term)
      || p.note.toLowerCase().includes(term)
      || (p.apprNote ?? "").toLowerCase().includes(term)
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
        tip="Ask procurement to buy stock."
        readOnly={!may && "store_requisitions"}
        actions={may && <Btn variant="gh" onClick={fillFromLow}>Fill from below-reorder items</Btn>}
      />

      {alreadyOpen.length > 0 && (
        <Alert tone="w" label="ALREADY ON ORDER">
          {alreadyOpen.map((l) => `${IT[l.it]?.n ?? l.it} (${fq(openQty(l.it), l.it)} ${U(l.it)})`).join(", ")}
          {" "}{alreadyOpen.length > 1 ? "sit" : "sits"} on a requisition procurement has not closed yet. Requisition
          again only if the open quantity will not cover you.
        </Alert>
      )}

      {low.length > 0 && (
        <Alert tone="w" label="REORDER" action={may && <Btn size="sm" onClick={fillFromLow}>Stage {low.length} item{low.length > 1 ? "s" : ""}</Btn>}>
          {low.length} central store item{low.length > 1 ? "s are" : " is"} below reorder level. Suggested quantity
          brings each back to 1.6 × the reorder level.
        </Alert>
      )}

      <Grid>
        {may && <Card
          title="New requisition"
          sub={`${prqDraft.length} item${prqDraft.length === 1 ? "" : "s"}${draftQty ? " · " + draftQty : ""} · ${money0(draftValue)} estimated`}
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
                      <tr key={rowKeys[i]}>
                        <td>
                          <select value={l.it} aria-label={`Item on line ${i + 1}`}
                            onChange={(e) => pickLine(i, e.target.value)}>
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
                          {/* Typed in freely and committed on the way out: reading
                              `Number(e.target.value)` on every keystroke meant 12.5 litres of
                              milk went into the draft as 1, then 12, then 12.5 - and emptying
                              the box to retype set the line to nothing. */}
                          <DraftLineInput
                            value={l.qty}
                            min={0}
                            blankZero
                            step={it && it.u === "nos" ? 1 : 0.5}
                            ariaLabel={it ? `Quantity of ${it.n}` : `Quantity on item ${i + 1}`}
                            onCommit={(n) => setLine(i, { qty: Math.max(0, n) })}
                          />
                        </td>
                        <td className="dim">{U(l.it)}</td>
                        <td className="n">{fq(qty(s, "store", l.it), l.it)}</td>
                        <td className="n">
                          {open > 0
                            ? <Tip text="Already on an open requisition"><b style={{ color: "var(--warn)" }}>{fq(open, l.it)}</b></Tip>
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
                  ? `Likely vendors: ${[...new Set(prqDraft.map((l) => suggestVendor(s.vendors, IT[l.it]?.g ?? "")?.n ?? "-"))].join(", ")}`
                  : undefined
              }
              tip="Say why the stock is needed - procurement uses this to pick a vendor and a delivery date."
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
        </Card>}

        <Card
          title="Previous requisitions"
          tip="Raised by the central store on procurement · open a row to see what was actually ordered"
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
              const g = progress.get(p.id)!;
              const pos = posFor(p.id);
              const d = prqDecision(p);
              return {
                key: p.id,
                onClick: () => openDrawer("sprq", p.id),
                cells: [
                  <>
                    {p.id}
                    <small>{p.lines.map((l) => IT[l.it]?.n ?? l.it).join(", ")}</small>
                  </>,
                  <span className="mono">{p.at}</span>,
                  <>{p.by}{addedByProcurement(p) && <small>added by procurement</small>}</>,
                  <>{p.lines.length}</>,
                  <b>{unitTotal(p.lines)}</b>,
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
                  // `fq(x, "")` printed every one of these as though it were countable, so a
                  // requisition for 12 L of milk and 500 cups read "512". Each is totalled per
                  // unit instead, from the per-line breakdown prqProgress now carries (M4).
                  <>
                    {unitTotal(qtyBy(g.lines, "received")) || fq(0, "")}{" "}
                    <span className="dim">of {unitTotal(qtyBy(g.lines, "ordered")) || fq(0, "")}</span>
                  </>,
                  <>
                    <StatusPill status={g.label} />
                    {p.st !== "Declined" && (
                      <div className="mini">
                        {unitTotal(qtyBy(g.lines, "ordered")) || "nothing"} of{" "}
                        {unitTotal(qtyBy(g.lines, "appr")) || "nothing"} approved ordered
                      </div>
                    )}
                    {/* Why the store keeper got less than they asked, in procurement's words. */}
                    {d && d.st !== "Approved" && (
                      <div className="mini">{d.by}: {d.note || "no note was left"}</div>
                    )}
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
                action: may && <Btn size="sm" onClick={fillFromLow}>Fill from below-reorder items</Btn>,
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
