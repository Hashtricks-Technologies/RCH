import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { canHandOver } from "../../lib/selectors";
import { U, fq, sum } from "../../lib/fmt";
import { Alert, Btn, DataTable, Field, Section, StatusPill, TicketTrail } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";

/**
 * The kitchen's own window on a ticket it issued out.
 *
 * Until this existed, every kitchen handover was a **supervisor override**: the board, the
 * distribute screen and the pick-ticket list all called `handover(id)` with no OTP, which the
 * server records in the trail as `Handed over — supervisor override`. The kitchen is the issuing
 * side of these tickets, so it never sees the six digits — but it is the side that has to ask for
 * them, exactly as the store's window does, and it had nowhere to type them.
 *
 * This is that window, and it is a drawer rather than an expander on one row so the three places
 * a kitchen hand can start a handover — the dashboard, Make & Distribute and Pick Tickets — all
 * arrive at the same one.
 */
function TicketDrawer({ id }: DrawerProps) {
  const t = useApp((s) => s.tkt.find((x) => x.id === id));
  const close = useApp((s) => s.closeDrawer);
  const handover = useApp((s) => s.handover);
  const [otp, setOtp] = useState("");
  const [override, setOverride] = useState(false);
  // One tap, one handover: the stock leaves once, and a second tap inside the round trip would
  // post a second `ticket_out` — refused, but the window would read the refusal as its own fault.
  const [busy, setBusy] = useState(false);
  const handOver = async (otpOrNone?: string) => {
    setBusy(true);
    try { await handover(id, otpOrNone); } finally { setBusy(false); }
  };

  if (!t) {
    return (
      <DrawerFrame title="Ticket not found" sub={id}>
        <p className="mini">This ticket is no longer at the pass.</p>
      </DrawerFrame>
    );
  }

  const open = canHandOver(t.st);

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
            {t.st === "Collected" ? `In transit to ${LOC[t.to].n}`
              : t.st === "Cancelled" ? "Withdrawn — nothing was collected against it" : "Closed"}
          </span>
        )}
      </>}
    >
      <div className="tktbox">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mini">Collection authority</div>
          <div className="mono-id" style={{ fontSize: 26, letterSpacing: "0.04em" }}>{t.id}</div>
          <div className="mtop" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <StatusPill status={t.st} />
            <span className="mini">
              {t.lines.length} item{t.lines.length === 1 ? "" : "s"} · {sum(t.lines, (l) => l.qty)} units
            </span>
          </div>
        </div>
        {/* The kitchen is the issuing side, so the server sends it no digits at all — it has to
            ask for them rather than be shown blanks it could read out to itself. */}
        <p className="mini" style={{ maxWidth: 210 }}>
          Ask {LOC[t.to].n} to read out the six digits on their own ticket.
        </p>
      </div>

      {open && (
        <div className="mtop">
          <Field
            label="OTP quoted by the collector"
            hint="Six digits, read out at the pass. The server refuses a handover on the wrong OTP."
          >
            <input
              className="otp-in"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
          </Field>
          <div className="mini">
            {override ? (
              <>
                A supervisor override hands the stock over without an OTP, and is recorded against
                your name on the ticket&apos;s trail.{" "}
                <Btn size="xs" variant="dg" disabled={busy} onClick={() => handOver()}>
                  {busy ? "Handing over…" : "Confirm override handover"}
                </Btn>{" "}
                <Btn size="xs" variant="gh" onClick={() => setOverride(false)}>Cancel override</Btn>
              </>
            ) : (
              <>
                Collector cannot produce the OTP?{" "}
                <Btn size="xs" variant="gh" onClick={() => setOverride(true)}>
                  Hand over without the OTP (supervisor override)
                </Btn>
              </>
            )}
          </div>
        </div>
      )}

      <Section title="On this ticket" sub={`Exactly what ${LOC[t.to].n} may collect against it.`} />
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
            <span className="mono">{IT[l.it]?.c ?? "—"}</span>,
            fq(l.qty, l.it),
            <span className="mini">{U(l.it)}</span>,
          ],
        }))}
        empty={{ title: "No item on this ticket" }}
      />

      {t.st === "Cancelled" && (
        <div className="mtop">
          <Alert tone="w" label="CANCELLED">
            This ticket was withdrawn before it was collected — nothing left the kitchen and the
            hold against it has been released.
          </Alert>
        </div>
      )}

      <Section title="History" sub={`Every hand ${t.id} has passed through`}>
        <TicketTrail hist={t.hist} />
      </Section>
    </DrawerFrame>
  );
}

registerDrawer("ptkt", TicketDrawer);
