import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { isReqOpen } from "../../lib/selectors";
import { sum, U, unitTotal } from "../../lib/fmt";
import {
  Alert, Btn, BtnRow, Card, type Col, DataTable, Field, FormRow, PageHead, Section,
  StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { DraftLine, ReqLine } from "../../types";

const REQUESTABLE = Object.keys(IT)
  .filter((k) => IT[k].t !== "MTO")
  .sort((a, b) => IT[a].g.localeCompare(IT[b].g) || IT[a].n.localeCompare(IT[b].n));
/** Group then name, so the picker reads like the item master and not like a hash (M7). */
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

export default function Requests() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const loc = user.loc;
  const L = LOC[loc];
  const [note, setNote] = useState("");
  const [priority, setPriority] = useState("Normal");
  const [q, setQ] = useState("");

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
  const clear = () => {
    s.setDraft([]);
    setNote("");
    setPriority("Normal");
    s.notify("Draft request cleared");
  };

  const mine = s.req.filter((r) => r.from === loc);
  const rows = mine
    .filter((r) => {
      const t = q.trim().toLowerCase();
      return !t || r.id.toLowerCase().includes(t) || r.st.toLowerCase().includes(t)
        || r.lines.some((l) => (IT[l.it]?.n ?? "").toLowerCase().includes(t));
    })
    .slice()
    .reverse();

  const openCount = mine.filter((r) => isReqOpen(r.st)).length;
  const usable = draft.filter((l) => !lineErr(l)).length;
  const skipped = draft.length - usable;
  const backOrder = mine.flatMap((r) => shortOf(r.lines));
  const anyShort = rows.some((r) => shortOf(r.lines).length > 0);

  return (
    <>
      <PageHead
        crumbs={["Royal Care", L.n, "Stock Requests"]}
        title="Stock requests"
        sub={`Raise one request for as many items as you need. It goes to the outlet manager first, then to the store keeper for a pick ticket.`}
        actions={<Btn variant="gh" onClick={addLine}>Add line</Btn>}
      />

      {openCount > 0 && (
        <Alert tone="i" label="OPEN">
          {openCount} request{openCount === 1 ? "" : "s"} from {L.n} {openCount === 1 ? "is" : "are"} still with the
          outlet manager. You can cancel a request until the manager acts on it.
        </Alert>
      )}
      {backOrder.length > 0 && (
        <Alert tone="w" label="SHORT">
          {unitTotal(backOrder)} across {backOrder.length} line{backOrder.length === 1 ? "" : "s"} was asked for but
          never approved. Nothing will be issued against the balance — raise a fresh request for what the counter
          still needs.
        </Alert>
      )}

      <Card title="New request" sub={`From ${L.n} (${L.c}) · raised by ${user.n}`}
        right={<Btn variant="gh" size="sm" onClick={addLine}>Add line</Btn>}>
        <div className="tw">
          <table className="lgrid">
            <thead>
              <tr>
                <th style={{ width: "48%" }}>Item</th>
                <th style={{ width: "18%" }}>Quantity</th>
                <th style={{ width: "14%" }}>Unit</th>
                <th style={{ width: "20%" }} className="r">Remove</th>
              </tr>
            </thead>
            <tbody>
              {draft.length === 0 && (
                <tr><td colSpan={4}>
                  <div className="empty">
                    <b>No line on this request yet</b>
                    <p>A request can carry as many items as you need — add the first line to begin.</p>
                    <Btn size="sm" onClick={addLine}>Add line</Btn>
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
                          onChange={(e) => setLine(i, { it: e.target.value })}>
                          <option value="">Choose an item…</option>
                          {REQ_GROUPS.map(([g, ks]) => (
                            <optgroup key={g} label={g}>
                              {ks.map((k) => (
                                <option key={k} value={k}>{IT[k].n} · {IT[k].c}</option>
                              ))}
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
                          aria-label={l.it ? `Quantity of ${IT[l.it].n}` : `Quantity on line ${i + 1}`}
                          onChange={(e) => setLine(i, { qty: Number(e.target.value) || 0 })} />
                      </div>
                    </td>
                    <td className="mini">{l.it ? U(l.it) : "—"}</td>
                    <td className="rt">
                      <Btn size="xs" variant="gh" onClick={() => removeLine(i)}>Remove</Btn>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Section title="Details" sub="The manager sees the priority and the note alongside every line." />
        <FormRow cols="f2">
          <Field label="Priority" hint="Urgent requests are flagged at the top of the manager's queue.">
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option>Normal</option>
              <option>Urgent</option>
            </select>
          </Field>
          <Field label="Lines ready"
            hint={skipped > 0
              ? <span style={{ color: "var(--crit)" }}>
                {skipped} line{skipped === 1 ? "" : "s"} will be dropped — fix the row{skipped === 1 ? "" : "s"} marked in red above.
              </span>
              : "Only lines with an item and a quantity above zero are sent."}>
            <input readOnly value={`${usable} of ${draft.length}`} style={skipped > 0 ? BAD : undefined} />
          </Field>
        </FormRow>
        <Field label="Note to the outlet manager" hint="Say why the counter needs it — the manager may trim quantities.">
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Milk finished at 09:10, cappuccino and tea are both off." />
        </Field>
        <BtnRow>
          <Btn disabled={usable === 0} onClick={submit}>Submit request</Btn>
          <Btn variant="gh" disabled={draft.length === 0 && !note} onClick={clear}>Clear</Btn>
        </BtnRow>
      </Card>

      <div className="mtop" />
      <Card flush>
        <Toolbar placeholder="Search request ID, status or item…" value={q} onSearch={setQ}
          right={<span className="mini">{L.n} · {mine.length} raised today</span>} />
        <DataTable
          cols={[
            { h: "Request ID", cls: "nm", w: "16%" },
            { h: "Raised", w: "8%" },
            { h: "Lines", w: anyShort ? "19%" : "24%" },
            { h: "Asked total", r: true, w: "10%" },
            { h: "Approved total", r: true, w: "11%" },
            ...(anyShort ? [{ h: "Back-ordered", r: true, w: "12%" } as Col] : []),
            { h: "Status", w: "12%" },
            { h: "Ticket ID", w: "10%" },
            { h: "", w: "6%" },
          ]}
          rows={rows.map((r) => {
            const first = IT[r.lines[0]?.it]?.n ?? "—";
            const more = r.lines.length - 1;
            const short = shortOf(r.lines);
            return {
              key: r.id,
              onClick: () => s.openDrawer("creq", r.id),
              cells: [
                <><span className="mono">{r.id}</span><small>by {r.by}{r.urg ? " · urgent" : ""}</small></>,
                <span className="mono">{r.at}</span>,
                <>{r.lines.length} line{r.lines.length === 1 ? "" : "s"} · {first}{more > 0 ? ` +${more} more` : ""}</>,
                sum(r.lines, (l) => l.qty),
                sum(r.lines, (l) => l.appr) || <span className="dim">—</span>,
                ...(anyShort ? [short.length
                  ? <b style={{ color: "var(--warn)" }}>{unitTotal(short)}</b>
                  : <span className="dim">—</span>] : []),
                <StatusPill status={r.st} />,
                r.ticket ? <span className="mono">{r.ticket}</span> : <span className="dim">—</span>,
                isReqOpen(r.st)
                  ? <Btn size="xs" variant="dg" onClick={() => s.cancelRequest(r.id)}>Cancel</Btn>
                  : <Btn size="xs" variant="gh" onClick={() => s.openDrawer("creq", r.id)}>Open</Btn>,
              ],
            };
          })}
          empty={{
            title: q ? "No request matches that search" : "No request raised from this counter yet",
            sub: q ? "Clear the search to see every request from this outlet."
              : "Add a line above and submit — one request can carry every item you are short of.",
            action: <Btn size="sm" onClick={() => (q ? setQ("") : addLine())}>{q ? "Clear search" : "Add line"}</Btn>,
          }}
        />
        <TableFoot count={rows.length}
          extra={<>{L.n} · {L.c} · {openCount} awaiting the outlet manager{backOrder.length ? ` · ${unitTotal(backOrder)} back-ordered` : ""}</>} />
      </Card>
      <p className="mini mtop">
        Quantities are shown in each item's own unit — {draft.filter((l) => l.it).map((l) => `${IT[l.it].n} in ${U(l.it)}`).join(", ") || "milk in L, cups in nos, sugar in kg"}.
        A request stays cancellable only while it reads “Request sent”.
      </p>
    </>
  );
}
