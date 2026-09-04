import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { canCancelTicket, canReceiveTicket } from "../../lib/selectors";
import { fq, U } from "../../lib/fmt";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import { Alert, Btn, DataTable, Feed, Field, Otp, Section, StatusPill } from "../../ui/kit";
import type { TktStatus } from "../../types";

const STEPS: { st: TktStatus; title: string; body: string }[] = [
  { st: "Issued", title: "Issued", body: "The store keeper has generated this ticket and reserved the stock against it." },
  { st: "Collected", title: "Collected", body: "The goods have been handed over and are in transit to the counter." },
  { st: "Received", title: "Received", body: "Confirmed at the counter — the stock is on the shelf and sellable." },
];
const ORDER: TktStatus[] = ["Issued", "Collected", "Received"];

function TicketDrawer({ id }: DrawerProps) {
  const tkt = useApp((s) => s.tkt.find((t) => t.id === id));
  const user = useApp((s) => s.user)!;
  const close = useApp((s) => s.closeDrawer);
  const receiveTicket = useApp((s) => s.receiveTicket);
  const cancelTicket = useApp((s) => s.cancelTicket);
  const [why, setWhy] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const withdraw = async () => {
    setCancelBusy(true);
    // No reset on success: the store action closes the drawer, so this component is gone.
    try { await cancelTicket(id, why.trim()); } finally { setCancelBusy(false); }
  };

  if (!tkt) {
    return (
      <DrawerFrame title="Ticket not found" sub={id}>
        <p className="mini">This pick ticket is no longer on this terminal.</p>
      </DrawerFrame>
    );
  }

  const at = ORDER.indexOf(tkt.st);
  const canReceive = canReceiveTicket(tkt.st);
  // A transfer this counter granted out of its own stock is its own to withdraw while nobody
  // has collected it. A ticket bound *for* here is the store's or the kitchen's to withdraw.
  const canWithdraw = tkt.from === user.loc && canCancelTicket(tkt.st);
  // The server sends the six digits to the collecting location and to nobody else, so an empty
  // string is not a missing OTP — it is one that was never this screen's to show.
  const holdsOtp = tkt.otp !== "";

  return (
    <DrawerFrame
      title={<span className="mono">{tkt.id}</span>}
      sub={`${LOC[tkt.from].n} → ${LOC[tkt.to].n} · against ${tkt.req}`}
      foot={<>
        <Btn variant="gh" onClick={close}>Close</Btn>
        <div className="sp" />
        <Btn disabled={!canReceive} onClick={() => receiveTicket(tkt.id)}>Confirm receipt</Btn>
      </>}
    >
      <div className="tktbox">
        {holdsOtp && <Otp value={tkt.otp} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 21, fontWeight: 700, letterSpacing: ".02em" }}>{tkt.id}</div>
          <div className="mini" style={{ marginTop: 4 }}>
            {LOC[tkt.from].c} {LOC[tkt.from].n} → {LOC[tkt.to].c} {LOC[tkt.to].n}
          </div>
          <div className="mini">Against {tkt.req} · {tkt.lines.length} item{tkt.lines.length === 1 ? "" : "s"}</div>
          <div style={{ marginTop: 8 }}><StatusPill status={tkt.st} /></div>
        </div>
      </div>
      <p className="mini mtop">
        {holdsOtp
          ? <>Nothing is scanned: whoever collects reads these six digits aloud to the store keeper at {LOC[tkt.from].n},
            who types them in to release the goods.</>
          : <>The six digits sit on {LOC[tkt.to].n}&apos;s own screen — this ticket was raised here, so the
            collector reads them out to you at the window.</>}
      </p>

      <Section title="Approved items" sub="Exactly what may be collected against this ticket." />
      <DataTable
        cols={[
          { h: "Item", cls: "nm", w: "44%" },
          { h: "Code", w: "20%" },
          { h: "Approved qty", r: true, w: "20%" },
          { h: "Unit", w: "16%" },
        ]}
        rows={tkt.lines.map((l) => ({
          key: l.it,
          cells: [
            IT[l.it]?.n ?? l.it,
            <span className="mono">{IT[l.it]?.c ?? "—"}</span>,
            fq(l.qty, l.it),
            <span className="mini">{U(l.it)}</span>,
          ],
        }))}
        empty={{ title: "No item on this ticket" }}
      />

      {canWithdraw && (
        <Section title="Withdraw this ticket" sub={`Nobody collected against it, and the stock should go back to ${LOC[tkt.from].n}`}>
          {cancelling ? (
            <>
              <Field label="Reason" hint="Kept with the ticket's history.">
                <input
                  placeholder="Asked for it back, wrong outlet…"
                  aria-label={`Why ${tkt.id} is being cancelled`}
                  value={why}
                  onChange={(e) => setWhy(e.target.value)}
                />
              </Field>
              <Btn size="xs" variant="dg" disabled={!why.trim() || cancelBusy} onClick={withdraw}>
                {cancelBusy ? "Cancelling…" : "Confirm cancellation"}
              </Btn>{" "}
              <Btn size="xs" variant="gh" onClick={() => setCancelling(false)}>Keep the ticket</Btn>
            </>
          ) : (
            <Btn size="xs" variant="gh" onClick={() => setCancelling(true)}>Cancel ticket</Btn>
          )}
        </Section>
      )}

      {tkt.st === "Cancelled" && (
        <Alert tone="w" label="CANCELLED">
          This ticket was withdrawn before it was collected — nothing was sent. Raise a new request
          if the stock is still needed.
        </Alert>
      )}

      {tkt.st !== "Cancelled" && (
        <>
          <Section title="Where it is" sub="Three steps from the store shelf to this counter." />
          <Feed items={STEPS.map((step, i) => ({
            key: step.st,
            title: <>{step.title}{i === at ? " — this is where it is now" : ""}</>,
            body: step.body,
            when: i < at ? "done" : i === at ? "current" : "pending",
            color: i < at ? "var(--good)" : i === at ? "var(--accent)" : "var(--ink-4)",
          }))} />
        </>
      )}

      <Section title="History" sub={`Every hand ${tkt.id} has passed through`} />
      <Feed items={tkt.hist.map((h, i) => ({
        key: h.s + i,
        title: h.s,
        body: h.who,
        when: h.t,
        color: h.s.startsWith("Cancelled") ? "var(--crit)"
          : h.s === "Received" ? "var(--good)" : "var(--accent)",
      }))} />

      <p className="mini mtop">
        Issued means the store keeper has generated it. Collected means it has been handed over and is in transit.
        Received means confirmed at the counter. {canReceive
          ? "Check the quantities physically, then confirm receipt to add them to this counter's stock."
          : tkt.st === "Issued"
            ? "Collect the goods at " + LOC[tkt.from].n + " first — receipt can only be confirmed once handed over."
            : tkt.st === "Cancelled"
              ? "Nothing was collected against this one, so nothing reached this counter."
              : "This ticket is closed; the stock is already counted at this counter."}
      </p>
    </DrawerFrame>
  );
}

registerDrawer("ctkt", TicketDrawer);
