import { useState } from "react";
import { REASON_LABEL } from "@rch/domain";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { avail } from "../../lib/selectors";
import { fq, U } from "../../lib/fmt";
import { Alert, Btn, BtnRow, DataTable, Feed, Section, StatusPill, Tip } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import type { AdjustmentRequest, DatedDoc } from "../../types";

const dotFor = (state: string) =>
  state.startsWith("Rejected") || state === "Cancelled" ? "var(--crit)"
    : state === "Approved" ? "var(--good)" : "var(--c1)";

/** Ready-made reasons the counter will understand; they fill the box, they do not replace it. */
const QUICK = [
  "Count it again before writing it off.",
  "This looks like a duplicate of one already actioned.",
  "Not enough is free here yet - a ticket is holding the rest.",
];

function AdjustmentRequestDrawer({ id }: DrawerProps) {
  const r = useApp((x) => x.adjReq.find((a) => a.id === id));
  if (!r) {
    return (
      <DrawerFrame title="Adjustment request not found" sub={id}>
        <p className="mini">This request is no longer in the queue.</p>
      </DrawerFrame>
    );
  }
  // Keyed on the trail's own instant, the same reason `ApprovalDrawer`'s `bodyKey` is: this
  // drawer instance survives `openDrawer("madjreq", other)` re-pointing it at a second request,
  // and a decision made elsewhere between two opens must not leave a stale reject-note behind.
  return <Body key={`${r.id}:${r.hist.at(-1)?.iso ?? r.at}`} r={r} />;
}

function Body({ r }: { r: DatedDoc<AdjustmentRequest> }) {
  const s = useApp();
  const close = useApp((x) => x.closeDrawer);
  const approveAdjustmentRequest = useApp((x) => x.approveAdjustmentRequest);
  const rejectAdjustmentRequest = useApp((x) => x.rejectAdjustmentRequest);
  const cancelAdjustmentRequest = useApp((x) => x.cancelAdjustmentRequest);

  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | "cancel" | null>(null);

  const open = r.st === "Request sent";
  const reason = note.trim();
  const down = r.lines.filter((l) => l.qty < 0);
  const overdrawn = down.filter((l) => avail(s, r.loc, l.it) < -l.qty);

  const doApprove = async () => {
    if (busy) return;
    setBusy("approve");
    const ok = await approveAdjustmentRequest(r.id);
    setBusy(null);
    if (ok) close();
  };
  const doReject = async () => {
    if (!reason || busy) return;
    setBusy("reject");
    const ok = await rejectAdjustmentRequest(r.id, reason);
    setBusy(null);
    if (ok) close();
  };
  const doCancel = async () => {
    if (busy) return;
    setBusy("cancel");
    const ok = await cancelAdjustmentRequest(r.id);
    setBusy(null);
    if (ok) close();
  };

  return (
    <DrawerFrame
      title={r.id}
      sub={`${LOC[r.loc].n} · ${LOC[r.loc].floor} · raised by ${r.by} at ${r.at}`}
      foot={
        open ? (
          <>
            <Btn variant="gh" onClick={close}>Close</Btn>
            <div className="sp" />
            <Btn variant="dg" disabled={!reason || busy !== null}
              tip={reason ? "Reject this ask" : "Write the reason below - reject stays locked without one"}
              onClick={doReject}>
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </Btn>
            <Btn disabled={busy !== null}
              tip={overdrawn.length > 0 ? "Approving will be refused - one or more lines exceed what is free here" : undefined}
              onClick={doApprove}>
              {busy === "approve" ? "Approving…" : "Approve & correct the shelf"}
            </Btn>
          </>
        ) : (
          <Btn variant="gh" onClick={close}>Close</Btn>
        )
      }
    >
      {r.st === "Approved" && r.adjId && (
        <Alert tone="g" label="APPROVED">
          Posted to the register as <b className="mono">{r.adjId}</b> - the shelf at {LOC[r.loc].n} has already moved.
        </Alert>
      )}
      {r.st === "Rejected" && (
        <Alert tone="c" label="REJECTED">
          {r.apprBy ? <>Rejected by <b>{r.apprBy}</b>.</> : "Rejected."} Nothing on this shelf has moved.
        </Alert>
      )}
      {r.st === "Cancelled" && (
        <Alert tone="i" label="CANCELLED">Withdrawn before a decision was made.</Alert>
      )}

      <Section title="Request" tip="Raised by the counter operator against its own shelf.">
        <dl className="dl">
          <dt>Outlet</dt>
          <dd>{LOC[r.loc].n} <span className="mini">{LOC[r.loc].c} · {LOC[r.loc].cc}</span></dd>
          <dt>Raised by</dt><dd>{r.by}</dd>
          <dt>Time</dt><dd className="mono">{r.at}</dd>
          <dt>Reason</dt><dd>{REASON_LABEL[r.reason]}</dd>
          <dt>Status</dt><dd><StatusPill status={r.st} /></dd>
          <dt>Counter's note</dt>
          <dd>{r.note || <span className="dim">No note was left with this request.</span>}</dd>
        </dl>
      </Section>

      <Section title="Lines" tip="What the counter says happened, and what is free here right now.">
        <div className="lgrid">
          <DataTable
            cols={[{ h: "Item", cls: "nm", w: "30%" }, { h: "Quantity", r: true }, { h: "Free here", r: true }]}
            rows={r.lines.map((l) => {
              const free = avail(s, r.loc, l.it);
              const over = l.qty < 0 && free < -l.qty;
              return {
                key: l.it,
                cells: [
                  IT[l.it]?.n ?? l.it,
                  <b style={{ color: l.qty < 0 ? "var(--crit)" : "var(--good)" }}>{l.qty < 0 ? "-" : "+"}{fq(Math.abs(l.qty), l.it)} <small className="dim">{U(l.it)}</small></b>,
                  over
                    ? <Tip text="Less than this would write off"><span style={{ color: "var(--warn)" }}>{fq(free, l.it)}</span></Tip>
                    : <span>{fq(free, l.it)}</span>,
                ],
              };
            })}
            empty={{ title: "This request carries no item" }}
          />
        </div>
      </Section>

      {open && overdrawn.length > 0 && (
        <Alert tone="w" label="MORE THAN IS FREE">
          {overdrawn.map((l) => IT[l.it]?.n ?? l.it).join(", ")} would take more than is free at {LOC[r.loc].n}.
          Approving will be refused until the shortfall is explained - reject it instead, or wait for the ticket
          holding the rest to move on.
        </Alert>
      )}

      {open && (
        <Section
          title="Reason for the counter"
          tip="Required to reject; the counter sees it on its own copy of this request."
        >
          <div className="btnrow" style={{ flexWrap: "wrap", marginBottom: 8 }}>
            {QUICK.map((q) => <Btn key={q} size="xs" variant="sub" onClick={() => setNote(q)}>{q}</Btn>)}
          </div>
          <div className="fld">
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Why this is being turned down…" />
          </div>
        </Section>
      )}

      {r.st !== "Cancelled" && open && (
        <BtnRow>
          <Btn variant="dg" size="sm" disabled={busy !== null} onClick={doCancel}>
            {busy === "cancel" ? "Withdrawing…" : "Withdraw without deciding"}
          </Btn>
        </BtnRow>
      )}

      <Section title="History" tip="Every hand this request has passed through." />
      <Feed items={r.hist.map((h, i) => ({
        key: h.s + i, title: h.s, body: h.who, when: h.t, color: dotFor(h.s),
      }))} />
    </DrawerFrame>
  );
}

registerDrawer("madjreq", AdjustmentRequestDrawer);
