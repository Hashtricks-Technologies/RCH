import { useState } from "react";
import { sourceOf } from "@rch/domain";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
// ---- item patch ----
import { activeItems, isReqOpen, menuOf, qty } from "../../lib/selectors";
import { fq, U } from "../../lib/fmt";
import {
  Btn, BtnRow, Card, DataTable, DraftLineInput, Field, FormRow, PageHead, Section, StatusPill,
  useLineKeys,
} from "../../ui/kit";
import type { DraftLine } from "../../types";
// ---- prod-order raise ----
import KitchenOrderCard from "./KitchenOrderCard";

const BAD = { borderColor: "var(--crit)" };
const lineErr = (l: DraftLine) =>
  !l.it ? "Pick an item - this line will not be sent"
    : l.qty > 0 ? "" : "Quantity must be above zero - this line will not be sent";

export default function Requests() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const loc = user.loc;
  const L = LOC[loc];
  // `IT` is empty until the snapshot lands and is replaced in place after that
  // (`hydrateMaster` / `hydrateItems`), so this list is built during render and pinned to
  // `catalogVersion` - the signal that tells React the catalogue moved.
  void s.catalogVersion;
  // Anything the operator can be asked for, whichever desk actually supplies it: a store-sourced
  // item goes on the picker whatever its type, and a kitchen-sourced one only when it is a
  // finished good already on this till - the one thing the kitchen can be asked to make for it.
  const listed = new Set(menuOf(s, loc));
  const REQUESTABLE = activeItems()
    .filter((k) => IT[k].t !== "MTO")
    .filter((k) => sourceOf(IT[k]) === "store" || (IT[k].t === "FG" && listed.has(k)))
    .sort((a, b) => IT[a].g.localeCompare(IT[b].g) || IT[a].n.localeCompare(IT[b].n));

  const [note, setNote] = useState("");
  const [priority, setPriority] = useState("Normal");
  const [busy, setBusy] = useState(false);

  const draft = s.draft;
  /** A key per draft row that belongs to the row rather than to its position - `useLineKeys`
   *  (`ui/kit.tsx`) says why, for every screen that draws an editable line table. */
  const [rowKeys, dropKey] = useLineKeys(draft.length);

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    s.setDraft(draft.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => s.setDraft([...draft, { it: "", qty: 0 }]);
  const removeLine = (i: number) => {
    dropKey(i);
    s.setDraft(draft.filter((_, j) => j !== i));
  };

  // The draft, the note and the priority survive a refusal - the store clears only the lines
  // that actually landed, and this clears the rest on the same answer.
  const submit = async () => {
    setBusy(true);
    const ok = await s.submitStockRequest(note.trim(), priority === "Urgent");
    setBusy(false);
    if (!ok) return;
    setNote("");
    setPriority("Normal");
  };
  const clearDraft = () => {
    s.setDraft([]);
    setNote("");
    setPriority("Normal");
    s.notify("Draft request cleared");
  };

  const mine = s.req.filter((r) => r.from === loc).slice().sort((a, b) => b.iso.localeCompare(a.iso));
  const openCount = mine.filter((r) => isReqOpen(r.st)).length;
  const usable = draft.filter((l) => !lineErr(l)).length;
  const skipped = draft.length - usable;

  return (
    <>
      <PageHead
        crumbs={["Royal Care", L.n, "Stock Requests"]}
        title="Stock requests"
        tip="Ask for stock - it is routed to the central store or the kitchen automatically."
        actions={<Btn variant="gh" onClick={addLine}>Add item</Btn>}
      />

      <Card title="New request" sub={`From ${L.n} (${L.c}) · raised by ${user.n}`}
        right={<Btn variant="gh" size="sm" onClick={addLine}>Add item</Btn>}>
        <div className="tw">
          <table className="lgrid">
            <thead>
              <tr>
                <th style={{ width: "32%" }}>Item</th>
                <th style={{ width: "14%" }}>Quantity</th>
                <th style={{ width: "8%" }}>Unit</th>
                <th style={{ width: "14%" }}>Here now</th>
                <th style={{ width: "18%" }}>Goes to</th>
                <th style={{ width: "14%" }} className="r">Remove</th>
              </tr>
            </thead>
            <tbody>
              {draft.length === 0 && (
                <tr><td colSpan={6}>
                  <div className="empty">
                    <b>No item on this request yet</b>
                    <p>One request can carry as many items as this counter is short of - add the first to begin.</p>
                    <Btn size="sm" onClick={addLine}>Add item</Btn>
                  </div>
                </td></tr>
              )}
              {draft.map((l, i) => {
                const err = lineErr(l);
                return (
                  <tr key={rowKeys[i]}>
                    <td>
                      <div className="fld">
                        <select value={l.it} style={l.it ? undefined : BAD}
                          aria-label={`Item on row ${i + 1}`}
                          onChange={(e) => setLine(i, { it: e.target.value })}>
                          <option value="">Choose an item…</option>
                          {REQUESTABLE.map((k) => <option key={k} value={k}>{IT[k].n} · {IT[k].c}</option>)}
                        </select>
                      </div>
                      {err && <div className="hint" style={{ color: "var(--crit)" }}>{err}</div>}
                    </td>
                    <td>
                      <div className="fld">
                        {/* Typed in freely and committed on the way out: `Number(e.target.value)`
                            on every keystroke put 1.5 litres into the draft as 1, then 1.5, and
                            emptying the box to retype set the line to nothing. */}
                        <DraftLineInput
                          value={l.qty} min={0} step={l.it && U(l.it) === "nos" ? 1 : 0.5}
                          invalid={!!l.it && !(l.qty > 0)}
                          ariaLabel={l.it ? `Quantity of ${IT[l.it].n}` : `Quantity on row ${i + 1}`}
                          onCommit={(n) => setLine(i, { qty: Math.max(0, n) })} />
                      </div>
                    </td>
                    <td className="mini">{l.it ? U(l.it) : "-"}</td>
                    <td className="mini">
                      {l.it ? <>{fq(qty(s, loc, l.it), l.it)} {U(l.it)}</> : <span className="dim">-</span>}
                    </td>
                    <td className="mini">
                      {l.it ? (sourceOf(IT[l.it]) === "kitchen" ? "Central Kitchen" : "Central Store") : <span className="dim">-</span>}
                    </td>
                    <td className="rt">
                      <Btn size="xs" variant="gh" onClick={() => removeLine(i)}>Remove</Btn>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Section title="Details" tip="The outlet manager sees the priority and the note alongside every item." />
        <FormRow cols="f2">
          <Field label="Priority" tip="Urgent requests are flagged at the top of the manager's queue.">
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option>Normal</option>
              <option>Urgent</option>
            </select>
          </Field>
          <Field label="Items ready"
            tip="Only rows with an item and a quantity above zero are sent."
            hint={skipped > 0 && <span style={{ color: "var(--crit)" }}>
              {skipped} row{skipped === 1 ? "" : "s"} will be dropped - fix the row{skipped === 1 ? "" : "s"} marked in red above.
            </span>}>
            <input readOnly value={`${usable} of ${draft.length}`} style={skipped > 0 ? BAD : undefined} />
          </Field>
        </FormRow>
        <Field label="Notes" tip="Say what this is for - the outlet manager may trim quantities.">
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Milk finished at 09:10, cappuccino and tea are both off." />
        </Field>
        <BtnRow>
          <Btn disabled={usable === 0 || busy} onClick={submit}>
            {busy ? "Sending…" : "Submit request"}
          </Btn>
          <Btn variant="gh" disabled={draft.length === 0 && !note} onClick={clearDraft}>Clear</Btn>
        </BtnRow>
      </Card>

      <Card title="Requests to the central store" sub={`${mine.length} from ${L.n}`} flush className="mtop"
        tip="Can be cancelled from its detail any time before the store keeper issues a ticket against it - including after the outlet manager has approved it.">
        <DataTable
          cols={[
            { h: "Product", cls: "nm" }, { h: "Items" }, { h: "Raised" }, { h: "Status" },
          ]}
          rows={mine.map((r) => ({
            key: r.id,
            onClick: () => s.openDrawer("creq", r.id),
            cells: [
              <><b>{r.lines.length} item{r.lines.length === 1 ? "" : "s"}</b><small>{r.id}</small></>,
              r.lines.map((l) => IT[l.it]?.n ?? l.it).join(", "),
              r.at,
              <StatusPill status={r.st} />,
            ],
          }))}
          empty={{
            title: "No request raised from this counter yet",
            sub: "Add an item above and submit - one request can carry everything this counter is short of.",
          }}
        />
      </Card>

      {/* ---- prod-order raise ---- what the kitchen makes routes there automatically off the
          same request above; this is only the board it lands on. */}
      <KitchenOrderCard loc={loc} />

      <p className="mini mtop">
        {openCount} request{openCount === 1 ? "" : "s"} from {L.n} {openCount === 1 ? "is" : "are"} still open.
      </p>
    </>
  );
}
