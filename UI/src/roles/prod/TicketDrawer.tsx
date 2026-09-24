import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { canHandOver, useCan } from "../../lib/selectors";
import { U, fq, sum } from "../../lib/fmt";
import { Alert, Btn, DataTable, Field, Section, StatusPill, TicketTrail, Tip } from "../../ui/kit";
import { PrintSlipBtn, TicketSlip } from "../../ui/TicketSlip";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";

/**
 * The kitchen's own window on a ticket it issued out.
 *
 * The kitchen is the issuing side of these tickets, so it never sees the six digits - but it is
 * the side that has to ask for them, exactly as the store's window does, and it had nowhere to
 * type them. There is no way round the code: the OTP-less supervisor override this window was
 * built beside has since been removed, so a ticket moves on the collector's digits or not at all.
 *
 * This is that window, and it is a drawer rather than an expander on one row so the three places
 * a kitchen hand can start a handover - the dashboard, Make & Distribute and Pick Tickets - all
 * arrive at the same one.
 */
function TicketDrawer({ id }: DrawerProps) {
  const t = useApp((s) => s.tkt.find((x) => x.id === id));
  const close = useApp((s) => s.closeDrawer);
  const handover = useApp((s) => s.handover);
  const may = useCan("kitchen_tickets");
  const [otp, setOtp] = useState("");
  // One tap, one handover: the stock leaves once, and a second tap inside the round trip would
  // post a second `ticket_out` - refused, but the window would read the refusal as its own fault.
  const [busy, setBusy] = useState(false);
  /** The server's own refusal, kept in front of the operator. The store toasts it too, but a
   *  toast is gone in seconds and a wrong code is exactly the moment somebody looks away to
   *  ask for the right one. Cleared the moment they start typing a different code. */
  const [refused, setRefused] = useState("");
  const handOver = async (typed: string) => {
    setBusy(true);
    try {
      const ok = await handover(id, typed);
      // The store has already toasted the server's sentence either way; on a refusal it is
      // held here too, because the toast is gone in seconds and a wrong code is exactly when
      // somebody looks away to ask for the right one.
      setRefused(ok ? "" : (useApp.getState().toast ?? "That OTP was refused."));
      if (!ok) setOtp("");
    } finally { setBusy(false); }
  };

  if (!t) {
    return (
      <DrawerFrame title="Ticket not found" sub={id}>
        <p className="mini">This ticket is no longer at the pass.</p>
      </DrawerFrame>
    );
  }

  const open = may && canHandOver(t.st);

  return (
    <DrawerFrame
      title={<span className="mono">{t.id}</span>}
      sub={`${LOC[t.from].n} → ${LOC[t.to].n} · against ${t.req}`}
      foot={<>
        <Btn variant="gh" onClick={close}>Close</Btn>
        <div className="sp" />
        {open ? (
          <Btn variant="ok" disabled={otp.trim().length !== 6 || busy} onClick={() => handOver(otp)}>
            {busy ? "Handing over…" : "Hand over on OTP"}
          </Btn>
        ) : (
          <span className="mini">
            {t.st === "Issued" ? "Waiting at the pass"
              : t.st === "Collected" ? `In transit to ${LOC[t.to].n}`
              : t.st === "Cancelled" ? "Withdrawn - nothing was collected against it" : "Closed"}
          </span>
        )}
      </>}
    >
      <div className="tktbox">
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* The kitchen is the issuing side, so the server sends it no digits at all - it has to
              ask for them rather than be shown blanks it could read out to itself. */}
          <div className="mini tipped">
            <span>Collection authority</span>
            <Tip text={`Ask ${LOC[t.to].n} to read out the six digits on their own ticket.`} label="Collection authority" />
          </div>
          <div className="mono-id" style={{ fontSize: 26, letterSpacing: "0.04em" }}>{t.id}</div>
          <div className="mtop" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <StatusPill status={t.st} />
            <span className="mini">
              {t.lines.length} item{t.lines.length === 1 ? "" : "s"} · {sum(t.lines, (l) => l.qty)} units
            </span>
            {/* The pass wants the ticket on paper. The kitchen is the issuing side, so the slip
                it prints names whose code it is rather than showing digits it never had. */}
            <PrintSlipBtn t={t} />
          </div>
        </div>
      </div>

      {open && (
        <div className="mtop">
          <Alert tone="i" label="WHERE">
            The six digits are on {LOC[t.to].n}&apos;s own Pick Tickets screen, against {t.id}. Ask
            whoever is collecting to read them out - the kitchen is never shown them, so that the
            side handing the stock over cannot authorise itself.
          </Alert>
          <Field
            label="OTP quoted by the collector"
            tip="Six digits, read out at the pass. The server refuses a handover on the wrong OTP, and locks the ticket after five."
          >
            <input
              className="otp-in"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={otp}
              onChange={(e) => { setOtp(e.target.value.replace(/\D/g, "").slice(0, 6)); setRefused(""); }}
            />
          </Field>
          {refused && <Alert tone="c" label="REFUSED">{refused}</Alert>}
          {/* There is no way round the code any more. A collector who cannot produce one gets a
              new ticket, not a handover on somebody's say-so. */}
          <div className="mini">
            Collector cannot produce the OTP? Cancel {t.id} and issue a new one - it comes with
            fresh digits, and the stock goes back on {LOC[t.from].n}&apos;s shelf until it does.
          </div>
        </div>
      )}

      <Section title="On this ticket" tip={`Exactly what ${LOC[t.to].n} may collect against it.`} />
      <DataTable
        cols={[
          { h: "Item", cls: "nm", w: "44%" },
          { h: "Code", w: "20%" },
          { h: "Quantity", r: true, w: "20%" },
          { h: "Unit", w: "16%" },
        ]}
        rows={t.lines.map((l) => ({
          key: l.it,
          cells: [
            IT[l.it]?.n ?? l.it,
            <span className="mono">{IT[l.it]?.c ?? "-"}</span>,
            fq(l.qty, l.it),
            <span className="mini">{U(l.it)}</span>,
          ],
        }))}
        empty={{ title: "No item on this ticket" }}
      />

      {t.st === "Cancelled" && (
        <div className="mtop">
          <Alert tone="w" label="CANCELLED">
            This ticket was withdrawn before it was collected - nothing left the kitchen and the
            hold against it has been released.
          </Alert>
        </div>
      )}

      <Section title="History" tip={`Every hand ${t.id} has passed through`}>
        <TicketTrail hist={t.hist} />
      </Section>

      <TicketSlip t={t} />
    </DrawerFrame>
  );
}

registerDrawer("ptkt", TicketDrawer);
