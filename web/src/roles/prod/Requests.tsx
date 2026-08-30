import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { isReqOpen, qty } from "../../lib/selectors";
import { fq, sum, U, unitTotal } from "../../lib/fmt";
import {
  Alert, Btn, BtnRow, Card, DataTable, Field, FilterBtn, FormRow, PageHead, Section,
  StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { DraftLine, ReqLine } from "../../types";

/* The kitchen asks the central store for what it consumes — raw materials and
   packaging. Finished goods it makes itself, and MRP goods never pass through it. */
const REQUESTABLE = Object.keys(IT)
  .filter((k) => IT[k].t === "RAW" || IT[k].t === "PACK")
  .sort((a, b) => IT[a].g.localeCompare(IT[b].g) || IT[a].n.localeCompare(IT[b].n));
const REQ_GROUPS = REQUESTABLE.reduce<[string, string[]][]>((g, k) => {
  const last = g[g.length - 1];
  if (last && last[0] === IT[k].g) last[1].push(k);
  else g.push([IT[k].g, [k]]);
  return g;
}, []);

const BAD = { borderColor: "var(--crit)" };
const lineErr = (l: DraftLine) =>
  !l.it ? "Pick an item — this line will not be sent"
    : l.qty > 0 ? "" : "Quantity must be above zero — this line will not be sent";
const shortOf = (lines: ReqLine[]) =>
  lines.filter((l) => (l.short ?? 0) > 0).map((l) => ({ it: l.it, qty: l.short ?? 0 }));

const SHOW = ["All", "Open", "Closed"] as const;
type Show = (typeof SHOW)[number];

export default function Requests() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const L = LOC.kitchen;

  const [note, setNote] = useState("");
  const [priority, setPriority] = useState("Normal");
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("All");

  const draft = s.draft;
  const setLine = (i: number, patch: Partial<DraftLine>) =>
    s.setDraft(draft.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => s.setDraft([...draft, { it: "", qty: 0 }]);
  const removeLine = (i: number) => s.setDraft(draft.filter((_, j) => j !== i));

  const submit = () => {
    s.submitRequest(note.trim(), priority === "Urgent");
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
  const cycleShow = () => setShow(SHOW[(SHOW.indexOf(show) + 1) % SHOW.length]);
  const clearFilters = () => { setQ(""); setShow("All"); };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Kitchen", "Stock Requests"]}
        title="Stock requests to the central store"
        sub="The kitchen asks for raw materials and packaging on one request. It goes to the outlet manager first, then to the store keeper for a pick ticket."
        actions={<Btn variant="gh" onClick={addLine}>Add item</Btn>}
      />

      {openCount > 0 && (
        <Alert tone="i" label="OPEN">
          {openCount} request{openCount === 1 ? "" : "s"} from {L.n} {openCount === 1 ? "is" : "are"} still with the
          outlet manager. A request stays cancellable until the manager acts on it.
        </Alert>
      )}
      {backOrder.length > 0 && (
        <Alert tone="w" label="SHORT">
          {unitTotal(backOrder)} across {backOrder.length} item{backOrder.length === 1 ? "" : "s"} was asked for and
          never approved. Nothing will be issued against the balance — raise a fresh request for what the kitchen
          still needs.
        </Alert>
      )}

      <Card title="New request" sub={`From ${L.n} (${L.c}) · raised by ${user.n}`}
        right={<Btn variant="gh" size="sm" onClick={addLine}>Add item</Btn>}>
        <div className="tw">
          <table className="lgrid">
            <thead>
              <tr>
                <th style={{ width: "40%" }}>Item</th>
                <th style={{ width: "16%" }}>Quantity</th>
                <th style={{ width: "10%" }}>Unit</th>
                <th style={{ width: "20%" }}>In the kitchen now</th>
                <th style={{ width: "14%" }} className="r">Remove</th>
              </tr>
            </thead>
            <tbody>
              {draft.length === 0 && (
                <tr><td colSpan={5}>
                  <div className="empty">
                    <b>No item on this request yet</b>
                    <p>One request can carry as many items as the kitchen is short of — add the first to begin.</p>
                    <Btn size="sm" onClick={addLine}>Add item</Btn>
                  </div>
                </td></tr>
              )}
              {draft.map((l, i) => {
                const err = lineErr(l);
                return (
                  <tr key={i}>
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
                        <input type="number" min={0} step="any" value={l.qty === 0 ? "" : l.qty}
                          placeholder="0" style={l.it && !(l.qty > 0) ? BAD : undefined}
                          aria-label={l.it ? `Quantity of ${IT[l.it].n}` : `Quantity on row ${i + 1}`}
                          onChange={(e) => setLine(i, { qty: Number(e.target.value) || 0 })} />
                      </div>
                    </td>
                    <td className="mini">{l.it ? U(l.it) : "—"}</td>
                    <td className="mini">
                      {l.it ? <>{fq(qty(s, "kitchen", l.it), l.it)} {U(l.it)}</> : <span className="dim">—</span>}
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

        <Section title="Details" sub="The manager sees the priority and the note alongside every item." />
        <FormRow cols="f2">
          <Field label="Priority" hint="Urgent requests are flagged at the top of the manager's queue.">
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option>Normal</option>
              <option>Urgent</option>
            </select>
          </Field>
          <Field label="Items ready"
            hint={skipped > 0
              ? <span style={{ color: "var(--crit)" }}>
                {skipped} row{skipped === 1 ? "" : "s"} will be dropped — fix the row{skipped === 1 ? "" : "s"} marked in red above.
              </span>
              : "Only rows with an item and a quantity above zero are sent."}>
            <input readOnly value={`${usable} of ${draft.length}`} style={skipped > 0 ? BAD : undefined} />
          </Field>
        </FormRow>
        <Field label="Note to the outlet manager" hint="Say what the kitchen cannot make without it — the manager may trim quantities.">
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Maida down to 8 kg, tomorrow's puff batch needs 20 kg." />
        </Field>
        <BtnRow>
          <Btn disabled={usable === 0} onClick={submit}>Submit request</Btn>
          <Btn variant="gh" disabled={draft.length === 0 && !note} onClick={clearDraft}>Clear</Btn>
        </BtnRow>
      </Card>

      <div className="mtop" />
      <Card flush>
        <Toolbar
          placeholder="Search request ID, status, person or item…"
          value={q}
          onSearch={setQ}
          filters={<FilterBtn label="Show" value={show} active={show !== "All"} onClick={cycleShow} />}
          right={filtering
            ? <Btn size="sm" variant="gh" onClick={clearFilters}>Clear filters</Btn>
            : <span className="mini">{L.n} · {mine.length} raised today</span>}
        />
        <DataTable
          cols={[
            { h: "Request ID", cls: "nm", w: "18%" },
            { h: "Raised", r: true, w: "8%" },
            { h: "Items", w: "26%" },
            { h: "Asked", r: true, w: "10%" },
            { h: "Approved", r: true, w: "10%" },
            { h: "Status", w: "14%" },
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
              sum(r.lines, (l) => l.appr) || <span className="dim">—</span>,
              <StatusPill status={r.st} />,
              r.ticket ? <span className="mono">{r.ticket}</span> : <span className="dim">—</span>,
              isReqOpen(r.st)
                ? <Btn size="xs" variant="dg" onClick={() => s.cancelRequest(r.id)}>Cancel</Btn>
                : <span className="dim mini">—</span>,
            ],
          }))}
          empty={{
            title: filtering ? "Nothing matches those filters" : "No request raised from the kitchen yet",
            sub: filtering
              ? "Clear the search or switch Show back to All."
              : "Add an item above and submit — one request can carry everything the kitchen is short of.",
            action: <Btn size="sm" onClick={() => (filtering ? clearFilters() : addLine())}>
              {filtering ? "Clear filters" : "Add item"}
            </Btn>,
          }}
        />
        <TableFoot count={rows.length}
          extra={<>{L.n} · {L.c} · {openCount} awaiting the outlet manager{backOrder.length ? ` · ${unitTotal(backOrder)} back-ordered` : ""}</>} />
      </Card>

      <p className="mini mtop">
        Quantities are shown in each item's own unit. A request stays cancellable only while it reads
        “Request sent”; once the store keeper issues a ticket it belongs on the Pick Tickets screen.
      </p>
    </>
  );
}
