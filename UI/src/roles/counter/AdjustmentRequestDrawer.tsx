import { counterNameOf } from "../../lib/selectors";
import { useApp } from "../../store";
import { fq, U } from "../../lib/fmt";
import { REASON_LABEL } from "@rch/domain";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import { Alert, Btn, DataTable, Feed, Section, StatusPill } from "../../ui/kit";

const DOT: Record<string, string> = {
  "Request sent": "var(--c1)", Approved: "var(--good)", Rejected: "var(--crit)", Cancelled: "var(--ink-4)",
};

function AdjustmentRequestDrawer({ id }: DrawerProps) {
  const r = useApp((s) => s.adjReq.find((x) => x.id === id));
  const close = useApp((s) => s.closeDrawer);
  const cancelAdjustmentRequest = useApp((s) => s.cancelAdjustmentRequest);

  if (!r) {
    return (
      <DrawerFrame title="Adjustment request not found" sub={id}>
        <p className="mini">This request is no longer on this terminal.</p>
      </DrawerFrame>
    );
  }

  const open = r.st === "Request sent";
  const rejected = [...r.hist].reverse().find((h) => h.s.startsWith("Rejected"));

  return (
    <DrawerFrame
      title={<span className="mono">{r.id}</span>}
      sub={`Raised by ${r.by} at ${r.at}`}
      foot={<>
        <Btn variant="dg" disabled={!open} onClick={() => cancelAdjustmentRequest(r.id)}
          tip={open ? "Withdraw this ask before the outlet manager decides it." : "Only an undecided request can be withdrawn."}>
          Cancel request
        </Btn>
        <div className="sp" />
        <Btn variant="gh" onClick={close}>Close</Btn>
      </>}
    >
      <div style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 14 }}>
        <StatusPill status={r.st} />
        <div className="sp" />
        <span className="mini">{r.lines.length} line{r.lines.length === 1 ? "" : "s"} · {REASON_LABEL[r.reason]}</span>
      </div>

      {r.st === "Rejected" && (
        <Alert tone="c" label="REJECTED">
          The outlet manager rejected this ask.{rejected ? ` ${rejected.s.replace(/^Rejected( - )?/, "")}` : ""}
        </Alert>
      )}
      {r.adjId && (
        <Alert tone="g" label="RECORDED">
          Approved and posted to the register as <b className="mono">{r.adjId}</b>.
        </Alert>
      )}

      <Section title="Lines" tip="Negative writes off; positive counts up." />
      <DataTable
        cols={[{ h: "Item", cls: "nm", w: "40%" }, { h: "Quantity", r: true }, { h: "Unit" }]}
        rows={r.lines.map((l) => ({
          key: l.it,
          cells: [
            counterNameOf(l.it),
            <b style={{ color: l.qty < 0 ? "var(--crit)" : "var(--good)" }}>{l.qty < 0 ? "-" : "+"}{fq(Math.abs(l.qty), l.it)}</b>,
            <span className="mini">{U(l.it)}</span>,
          ],
        }))}
        empty={{ title: "This request carries no item" }}
      />

      <Section title="Note" />
      <p style={{ fontSize: 12.5, color: "var(--ink-2)", margin: 0 }}>
        {r.note || <span className="dim">No note was left with this request.</span>}
      </p>

      <Section title="History" tip="Every hand this request has passed through." />
      <Feed items={r.hist.map((h, i) => ({
        key: h.s + i, title: h.s, body: h.who, when: h.t, color: DOT[h.s.split(" - ")[0]] ?? "var(--c1)",
      }))} />
    </DrawerFrame>
  );
}

registerDrawer("cadjreq", AdjustmentRequestDrawer);
