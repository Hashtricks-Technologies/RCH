import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { qty } from "../../lib/selectors";
import { U, fq, money, sum } from "../../lib/fmt";
import { Alert, Btn, DataTable, Feed, Field, Section, StatusPill, TableFoot } from "../../ui/kit";
import type { Row } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import { recap, reconcile } from "./lib";

const dotFor = (state: string) =>
  state === "Declined" ? "var(--crit)" : state === "Sent" ? "var(--warn)" : "var(--good)";

const stack = (parts: (string | number)[]) =>
  parts.length
    ? <>{parts.map((p, i) => <div key={i}>{p}</div>)}</>
    : <span className="dim">—</span>;

function RequisitionDrawer({ id }: DrawerProps) {
  const s = useApp();
  const approve = useApp((x) => x.approveRequisition);
  const decline = useApp((x) => x.declineRequisition);
  const close = useApp((x) => x.closeDrawer);
  const p = s.prq.find((x) => x.id === id);

  const [appr, setAppr] = useState<number[]>(() => (p?.lines ?? []).map((l) => l.qty));
  const [note, setNote] = useState("");

  if (!p) {
    return (
      <DrawerFrame title="Requisition not found" sub={id}>
        <div className="empty">
          <b>{id} is no longer on file</b>
          <p>It may have been approved or declined already. Close this panel and refresh the list.</p>
        </div>
      </DrawerFrame>
    );
  }

  const open = p.st === "Sent";
  const decided = p.st === "Approved" || p.st === "Partially approved";
  const apprAt = (i: number) => {
    const v = appr[i];
    return Number.isFinite(v) ? Math.max(0, Math.min(p.lines[i].qty, v)) : 0;
  };
  const setLine = (i: number, raw: string) => {
    const n = Number(raw);
    setAppr((a) => a.map((x, j) => (j === i ? n : x)));
  };
  const approving = p.lines.filter((_, i) => apprAt(i) > 0).length;

  // What purchase orders actually claim against each requisition line, read
  // from each PO line's `src` back-reference rather than matched by item code.
  const recon = reconcile(s, p);
  const roll = recap(recon, decided);

  const rows: Row[] = p.lines.map((l, i) => {
    const it = IT[l.it];
    const have = qty(s, "store", l.it);
    const short = open ? Math.round((l.qty - apprAt(i)) * 1000) / 1000 : (l.short ?? 0);
    return {
      key: l.it + i,
      cells: [
        <>{it?.n ?? l.it}<small>{it?.c ?? ""}</small></>,
        <>{fq(l.qty, l.it)}</>,
        <>{U(l.it)}</>,
        <>{fq(have, l.it)}</>,
        <>{fq(it?.rl ?? 0, l.it)}</>,
        open ? (
          <input type="number" className="mono" min={0} max={l.qty} step={U(l.it) === "nos" ? 1 : 0.5}
            value={appr[i] ?? 0} aria-label={`Approved quantity for ${it?.n ?? l.it}`}
            onChange={(e) => setLine(i, e.target.value)} />
        ) : (
          <b>{fq(l.appr, l.it)}</b>
        ),
        short > 0
          ? <span style={{ color: "var(--warn)" }}>{fq(short, l.it)}</span>
          : <span className="dim">{fq(0, l.it)}</span>,
      ],
    };
  });

  const orderedRows: Row[] = recon.map((r) => {
    const it = IT[r.it];
    const outstanding = Math.round(Math.max(0, r.ordered - r.received) * 1000) / 1000;
    return {
      key: "o" + r.it + r.i,
      cells: [
        <>{it?.n ?? r.it}<small>{it?.c ?? ""}</small></>,
        <>{fq(r.asked, r.it)} <span className="dim">{U(r.it)}</span></>,
        <>{fq(r.appr, r.it)}</>,
        <>{fq(r.ordered, r.it)}</>,
        stack(r.orders.map((o) => o.po)),
        stack(r.orders.map((o) => o.vendor)),
        stack(r.orders.map((o) => money(o.rate))),
        stack(r.orders.map((o) => o.eta)),
        <>
          {fq(r.received, r.it)}
          {outstanding > 0 && r.ordered > 0 && (
            <div className="mini dim">{fq(outstanding, r.it)} still to come</div>
          )}
        </>,
        <StatusPill status={r.status} />,
      ],
    };
  });

  return (
    <DrawerFrame
      title={p.id}
      sub={`Raised by ${p.by} · ${p.at} · ${p.lines.length} item${p.lines.length > 1 ? "s" : ""}`}
      foot={open ? (
        <>
          <Btn variant="dg" onClick={() => decline(p.id, note)}>Decline</Btn>
          <div className="sp" />
          <Btn variant="gh" onClick={close}>Close</Btn>
          <Btn onClick={() => approve(p.id, p.lines.map((_, i) => apprAt(i)), note)}>
            Approve {p.lines.filter((_, i) => apprAt(i) > 0).length} item(s)
          </Btn>
        </>
      ) : undefined}
    >
      <Section title="Requirement from the store keeper" sub={`${p.by} · ${LOC.store.n} · raised at ${p.at}`}>
        <Alert tone={open ? "i" : p.st === "Declined" ? "c" : "g"} label={p.st.toUpperCase()}>
          {p.note || "No note was left with this requisition."}
        </Alert>
      </Section>

      <Section
        title="Items"
        sub={open
          ? "Approved defaults to what was asked. Trim an item if it should not be bought in full — you can never approve more than was asked."
          : "Quantities as they were approved."}
      >
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "22%" },
              { h: "Asked", r: true },
              { h: "Unit" },
              { h: "Store now", r: true },
              { h: "Reorder", r: true },
              { h: open ? "Approve" : "Approved", r: true, w: "16%" },
              { h: "Short", r: true },
            ]}
            rows={rows}
            empty={{ title: "No items on this requisition", sub: "Nothing to approve." }}
          />
        </div>
        <TableFoot count={rows.length} extra={<>{sum(p.lines, (l) => l.qty)} units asked</>} />
      </Section>

      {!open && (
        <Section
          title="What was ordered against this requisition"
          sub="Traced through each purchase order line's source reference — quantity ordered, the order it went on, the vendor, the rate agreed and what has landed."
        >
          <Alert tone={roll.label === "Received" ? "g" : roll.label === "Not ordered" ? "w" : "i"}
            label={roll.label.toUpperCase()}>
            {roll.appr} approved · {roll.ordered} ordered · {roll.received} received —
            {" "}{roll.done} of {roll.total} item(s) fully received.
          </Alert>
          <div className="lgrid">
            <DataTable
              cols={[
                { h: "Item", cls: "nm", w: "16%" },
                { h: "Requested", r: true },
                { h: "Approved", r: true },
                { h: "Ordered", r: true },
                { h: "Purchase order", w: "13%" },
                { h: "Vendor", w: "14%" },
                { h: "Rate", r: true },
                { h: "Expected", w: "11%" },
                { h: "Received", r: true },
                { h: "Status", w: "12%" },
              ]}
              rows={orderedRows}
              empty={{
                title: "No items on this requisition",
                sub: "Nothing was asked for, so nothing could be ordered.",
              }}
            />
          </div>
          <TableFoot
            count={orderedRows.length}
            extra={<>{roll.ordered} ordered against {roll.appr} approved</>}
          />
        </Section>
      )}

      {open && approving === 0 && (
        <Alert tone="c" label="NIL">
          Every item is at zero. Approving now records this requisition as declined and nothing joins the
          procurement list.
        </Alert>
      )}

      {open ? (
        <Section title="Decision note" sub="Required to decline; kept on the requisition history either way.">
          <Field label="Note" hint={!note.trim()
            ? "A reason is required to decline. Optional when approving in full or in part."
            : "Kept on the requisition history against your name."}>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Why you trimmed an item, or why nothing was approved…" />
          </Field>
        </Section>
      ) : (
        <Section title="Decision" sub={`${p.apprBy ?? "—"} · ${p.st}`}>
          <p className="mini">{p.apprNote || "No note was left with the decision."}</p>
        </Section>
      )}

      <Section title="History" sub="Every hand this requisition has passed through">
        <Feed
          items={p.hist.map((h, i) => ({
            key: h.s + i, title: h.s, body: h.who, when: h.t, color: dotFor(h.s),
          }))}
        />
      </Section>
    </DrawerFrame>
  );
}

registerDrawer("bprq", RequisitionDrawer);
export default RequisitionDrawer;
