import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { isReqOpen } from "../../lib/selectors";
import { fq, sum, U } from "../../lib/fmt";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import { Alert, Btn, DataTable, Feed, Pill, Section, StatusPill } from "../../ui/kit";

const DOT: Record<string, string> = {
  "Request sent": "var(--c1)",
  "Manager approved": "var(--good)",
  "Partially approved": "var(--warn)",
  "Ticket issued": "var(--accent)",
  Collected: "var(--c2)",
  Received: "var(--good)",
  Rejected: "var(--crit)",
  Cancelled: "var(--ink-4)",
};

function RequestDrawer({ id }: DrawerProps) {
  const req = useApp((s) => s.req.find((r) => r.id === id));
  const close = useApp((s) => s.closeDrawer);
  const cancelRequest = useApp((s) => s.cancelRequest);

  if (!req) {
    return (
      <DrawerFrame title="Request not found" sub={id}>
        <p className="mini">This request is no longer on this terminal.</p>
      </DrawerFrame>
    );
  }

  const L = LOC[req.from];
  const asked = sum(req.lines, (l) => l.qty);
  const appr = sum(req.lines, (l) => l.appr);
  const open = isReqOpen(req.st);

  return (
    <DrawerFrame
      title={<span className="mono">{req.id}</span>}
      sub={`${L.n} · raised by ${req.by} at ${req.at}${req.urg ? " · urgent" : ""}`}
      foot={<>
        <Btn variant="dg" disabled={!open} onClick={() => cancelRequest(req.id)}>Cancel request</Btn>
        <div className="sp" />
        <Btn variant="gh" onClick={close}>Close</Btn>
      </>}
    >
      <div style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 14 }}>
        <StatusPill status={req.st} />
        {req.urg && <Pill tone="cr">Urgent</Pill>}
        <div className="sp" />
        <span className="mini">{req.lines.length} line{req.lines.length === 1 ? "" : "s"} · {asked} asked · {appr} approved</span>
      </div>

      {req.st === "Rejected" && (
        <Alert tone="c" label="REJECTED">
          The outlet manager rejected this request. Nothing will be issued against it — raise a fresh request if the
          counter still needs the stock.
        </Alert>
      )}
      {req.ticket && (
        <Alert tone="g" label="TICKET">
          Pick ticket <b className="mono">{req.ticket}</b> has been issued. Quote it at {LOC.store.n} to collect.
        </Alert>
      )}

      <Section title="Lines" sub="What the counter asked for against what the manager approved." />
      <DataTable
        cols={[
          { h: "Item", cls: "nm", w: "38%" },
          { h: "Code", w: "16%" },
          { h: "Asked", r: true, w: "16%" },
          { h: "Approved", r: true, w: "16%" },
          { h: "Unit", w: "14%" },
        ]}
        rows={req.lines.map((l) => ({
          key: l.it,
          cells: [
            IT[l.it]?.n ?? l.it,
            <span className="mono">{IT[l.it]?.c ?? "—"}</span>,
            fq(l.qty, l.it),
            l.appr > 0
              ? <b style={{ color: l.appr < l.qty ? "var(--warn)" : "var(--good)" }}>{fq(l.appr, l.it)}</b>
              : <span className="dim">—</span>,
            <span className="mini">{U(l.it)}</span>,
          ],
        }))}
        empty={{ title: "This request carries no line" }}
      />

      <Section title="Manager's note" />
      <p style={{ fontSize: 12.5, color: "var(--ink-2)", margin: 0 }}>
        {req.mgrNote || <span className="dim">No note was left with this request.</span>}
      </p>

      <Section title="History" sub="Every hand-off on this request, in order." />
      <Feed items={req.hist.map((h, i) => ({
        key: h.s + i,
        title: h.s,
        body: h.who,
        when: h.t,
        color: DOT[h.s] ?? "var(--c1)",
      }))} />

      <p className="mini mtop">
        {open
          ? "This request can still be cancelled — the outlet manager has not acted on it yet."
          : "Cancelling is only possible while a request reads “Request sent”."}
      </p>
    </DrawerFrame>
  );
}

registerDrawer("creq", RequestDrawer);

export default RequestDrawer;
