import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
// ---- item patch ----
import { valueAtCost } from "@rch/domain";
import { activeItems, isReqOpen, useCan } from "../../lib/selectors";
import { money, sum, U, unitTotal } from "../../lib/fmt";
import {
  Alert, Btn, BtnRow, Card, DataTable, DraftLineInput, Field, FilterSelect, FormRow, PageHead,
  Section, StatusPill, TableFoot, Toolbar, useLineKeys,
} from "../../ui/kit";
import type { DraftLine, ReqLine } from "../../types";

/* The kitchen asks the central store for what it consumes - raw materials and
   packaging. Finished goods it makes itself, and MRP goods never pass through it. */
const requestable = () => activeItems()
  .filter((k) => IT[k].t === "RAW" || IT[k].t === "PACK")
  .sort((a, b) => IT[a].g.localeCompare(IT[b].g) || IT[a].n.localeCompare(IT[b].n));
const groupsOf = (keys: string[]) => keys.reduce<[string, string[]][]>((g, k) => {
  const last = g[g.length - 1];
  if (last && last[0] === IT[k].g) last[1].push(k);
  else g.push([IT[k].g, [k]]);
  return g;
}, []);

const BAD = { borderColor: "var(--crit)" };
const lineErr = (l: DraftLine) =>
  !l.it ? "Pick an item - this line will not be sent"
    : l.qty > 0 ? "" : "Quantity must be above zero - this line will not be sent";
const shortOf = (lines: ReqLine[]) =>
  lines.filter((l) => (l.short ?? 0) > 0).map((l) => ({ it: l.it, qty: l.short ?? 0 }));

const SHOW = ["All", "Open", "Closed"] as const;
type Show = (typeof SHOW)[number];

export default function Requests() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const may = useCan("kitchen_requests");
  const L = LOC.kitchen;
  // `IT` is empty until the snapshot lands and is replaced in place after that
  // (`hydrateMaster` / `hydrateItems`), so this list is built during render and pinned to
  // `catalogVersion` - the signal that tells React the catalogue moved.
  void s.catalogVersion;
  const REQUESTABLE = requestable();
  const REQ_GROUPS = groupsOf(REQUESTABLE);

  const [note, setNote] = useState("");
  const [priority, setPriority] = useState("Normal");
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("All");
  const [busy, setBusy] = useState(false);

  const draft = s.draft;
  /** A key per draft row that belongs to the row rather than to its position - `useLineKeys`
   *  (`ui/kit.tsx`) says why, for all three screens that draw an editable line table. */
  const [rowKeys, dropKey] = useLineKeys(draft.length);

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    s.setDraft(draft.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => s.setDraft([...draft, { it: "", qty: 0 }]);
  const removeLine = (i: number) => {
    dropKey(i);
    s.setDraft(draft.filter((_, j) => j !== i));
  };

  // The draft, the note and the priority survive a refusal - the store clears the draft only
  // once the server has taken it, and this clears the rest on the same answer.
  const submit = async () => {
    setBusy(true);
    const ok = await s.submitRequest(note.trim(), priority === "Urgent");
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

  const mine = s.req.filter((r) => r.from === "kitchen");
  const filtering = Boolean(q.trim() || show !== "All");
  const rows = mine
    .filter((r) => {
      if (show === "Open" && !isReqOpen(r.st)) return false;
      if (show === "Closed" && isReqOpen(r.st)) return false;
      const t = q.trim().toLowerCase();
      return !t || r.id.toLowerCase().includes(t) || r.st.toLowerCase().includes(t)
        || r.by.toLowerCase().includes(t)
        || r.lines.some((l) => ((IT[l.it]?.n ?? "") + " " + (IT[l.it]?.c ?? "")).toLowerCase().includes(t));
    })
    .slice()
    .reverse();

  const openCount = mine.filter((r) => isReqOpen(r.st)).length;
  const usable = draft.filter((l) => !lineErr(l)).length;
  const skipped = draft.length - usable;
  const backOrder = mine.flatMap((r) => shortOf(r.lines));
  const clearFilters = () => { setQ(""); setShow("All"); };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Kitchen", "Stock Requests"]}
        title="Stock requests to the central store"
        tip="Ask the central store for raw materials and packaging."
        readOnly={!may && "kitchen_requests"}
        actions={may && <Btn variant="gh" onClick={addLine}>Add item</Btn>}
      />

      {openCount > 0 && (
        <Alert tone="i" label="OPEN">
          {openCount} request{openCount === 1 ? "" : "s"} from {L.n} {openCount === 1 ? "is" : "are"} still open. A
          request can be withdrawn any time before the store keeper issues a ticket against it -
          including after the outlet manager has approved it.
        </Alert>
      )}
      {backOrder.length > 0 && (
        <Alert tone="w" label="SHORT">
          {unitTotal(backOrder)} across {backOrder.length} item{backOrder.length === 1 ? "" : "s"} was asked for and
          never approved. Nothing will be issued against the balance - raise a fresh request for what the kitchen
          still needs.
        </Alert>
      )}

      {may && <Card title="New request" sub={`From ${L.n} (${L.c}) · raised by ${user.n}`}
        right={<Btn variant="gh" size="sm" onClick={addLine}>Add item</Btn>}>
        <div className="tw">
          <table className="lgrid">
            <thead>
              <tr>
                <th style={{ width: "40%" }}>Item</th>
                <th style={{ width: "16%" }}>Quantity</th>
                <th style={{ width: "10%" }}>Unit</th>
                <th style={{ width: "20%" }}>Value at cost</th>
                <th style={{ width: "14%" }} className="r">Remove</th>
              </tr>
            </thead>
            <tbody>
              {draft.length === 0 && (
                <tr><td colSpan={5}>
                  <div className="empty">
                    <b>No item on this request yet</b>
                    <p>One request can carry as many items as the kitchen is short of - add the first to begin.</p>
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
                          {REQ_GROUPS.map(([g, ks]) => (
                            <optgroup key={g} label={g}>
                              {ks.map((k) => <option key={k} value={k}>{IT[k].n} · {IT[k].c}</option>)}
                            </optgroup>
                          ))}
                        </select>
                      </div>
                      {err && <div className="hint" style={{ color: "var(--crit)" }}>{err}</div>}
                    </td>
                    <td>
                      <div className="fld">
                        {/* Typed in freely and committed on the way out, the same box the store
                            keeper's requisitions use: `Number(e.target.value)` on every keystroke
                            put 12.5 litres of milk into the draft as 1, then 12, then 12.5, and
                            emptying the box to retype set the line to nothing. */}
                        <DraftLineInput
                          value={l.qty} min={0} step={l.it && U(l.it) === "nos" ? 1 : 0.5}
                          invalid={!!l.it && !(l.qty > 0)}
                          ariaLabel={l.it ? `Quantity of ${IT[l.it].n}` : `Quantity on row ${i + 1}`}
                          onCommit={(n) => setLine(i, { qty: Math.max(0, n) })} />
                      </div>
                    </td>
                    <td className="mini">{l.it ? U(l.it) : "-"}</td>
                    {/* The kitchen holds none of what it asks for - each line is used as it arrives -
                        so the line says what it is worth rather than what is on a shelf. */}
                    <td className="mini">
                      {l.it && l.qty > 0 ? money(valueAtCost(l.qty, IT[l.it].cost)) : <span className="dim">-</span>}
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

        <Section title="Details" tip="The manager sees the priority and the note alongside every item." />
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
        <Field label="Note to the outlet manager" tip="Say what the kitchen cannot make without it - the manager may trim quantities.">
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Maida down to 8 kg, tomorrow's puff batch needs 20 kg." />
        </Field>
        <BtnRow>
          <Btn disabled={usable === 0 || busy} onClick={submit}>
            {busy ? "Sending…" : "Submit request"}
          </Btn>
          <Btn variant="gh" disabled={draft.length === 0 && !note} onClick={clearDraft}>Clear</Btn>
        </BtnRow>
      </Card>}

      <div className="mtop" />
      <Card flush>
        <Toolbar
          placeholder="Search request ID, status, person or item…"
          value={q}
          onSearch={setQ}
          filters={<FilterSelect label="Show" value={show} options={SHOW} onChange={(v) => setShow(v as Show)} />}
          right={filtering
            ? <Btn size="sm" variant="gh" onClick={clearFilters}>Clear filters</Btn>
            : <span className="mini">{L.n} · {mine.length} raised today</span>}
        />
        <DataTable
          cols={[
            { h: "Request ID", cls: "nm", w: "18%" },
            { h: "Raised", r: true, w: "8%" },
            { h: "Items", w: "26%" },
            { h: "Asked", r: true, w: "10%", tip: "Quantities are shown in each item's own unit." },
            { h: "Approved", r: true, w: "10%" },
            { h: "Status", w: "14%", tip: <>
              A request can be withdrawn any time before the store keeper issues a ticket against it,
              decided or not; once a ticket is issued it belongs on the Pick Tickets screen.
            </> },
            { h: "Ticket ID", w: "10%" },
            { h: "", w: "6%" },
          ]}
          rows={rows.map((r) => ({
            key: r.id,
            cells: [
              <><span className="mono">{r.id}</span><small>by {r.by}{r.urg ? " · urgent" : ""}</small></>,
              <span className="mono">{r.at}</span>,
              <>{r.lines.length} item{r.lines.length === 1 ? "" : "s"} · {r.lines.map((l) => IT[l.it]?.n ?? l.it).join(", ")}</>,
              sum(r.lines, (l) => l.qty),
              sum(r.lines, (l) => l.appr) || <span className="dim">-</span>,
              <StatusPill status={r.st} />,
              r.ticket ? <span className="mono">{r.ticket}</span> : <span className="dim">-</span>,
              may && isReqOpen(r.st)
                ? <Btn size="xs" variant="dg" onClick={() => s.cancelRequest(r.id)}>Cancel</Btn>
                : <span className="dim mini">-</span>,
            ],
          }))}
          empty={{
            title: filtering ? "Nothing matches those filters" : "No request raised from the kitchen yet",
            sub: filtering
              ? "Clear the search or switch Show back to All."
              : "Add an item above and submit - one request can carry everything the kitchen is short of.",
            action: (filtering || may) && <Btn size="sm" onClick={() => (filtering ? clearFilters() : addLine())}>
              {filtering ? "Clear filters" : "Add item"}
            </Btn>,
          }}
        />
        <TableFoot count={rows.length}
          extra={<>{L.n} · {L.c} · {openCount} still open{backOrder.length ? ` · ${unitTotal(backOrder)} back-ordered` : ""}</>} />
      </Card>
    </>
  );
}
