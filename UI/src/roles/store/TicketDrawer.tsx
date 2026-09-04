import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { canCancelTicket, canHandOver } from "../../lib/selectors";
import { U, fq, money, sum } from "../../lib/fmt";
import { Alert, Btn, DataTable, Feed, Field, Otp, Pill, Section, StatusPill } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";

const STEPS = ["Issued", "Collected", "Received"] as const;

function TicketDrawer({ id }: DrawerProps) {
  const tkt = useApp((s) => s.tkt);
  const req = useApp((s) => s.req);
  const close = useApp((s) => s.closeDrawer);
  const handover = useApp((s) => s.handover);
  const [otp, setOtp] = useState("");
  const [override, setOverride] = useState(false);
  // A handover is a server call now, and the stock only leaves once. A second tap inside one
  // round trip would post a second `ticket_out` — refused, but as an error the window reads as
  // its own mistake. One tap, one handover.
  const [busy, setBusy] = useState(false);
  const handOver = async (otpOrNone?: string) => {
    setBusy(true);
    try { await handover(id, otpOrNone); } finally { setBusy(false); }
  };
  const cancelTicket = useApp((s) => s.cancelTicket);
  const [why, setWhy] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const withdraw = async () => {
    setCancelBusy(true);
    // No reset on success: the store action closes the drawer, so this component is gone.
    try { await cancelTicket(id, why.trim()); } finally { setCancelBusy(false); }
  };

  const t = tkt.find((x) => x.id === id);
  if (!t) {
    return (
      <DrawerFrame title="Ticket not found" sub={id}>
        <p className="mini">This ticket is no longer on the issue desk.</p>
      </DrawerFrame>
    );
  }

  const r = req.find((x) => x.id === t.req);
  // A cancelled ticket is not a step on the way to anywhere, so it sits outside this list and
  // `indexOf` answers -1 for it. The read is widened rather than the list.
  const step = (STEPS as readonly string[]).indexOf(t.st);
  const value = sum(t.lines, (l) => l.qty * (IT[l.it]?.cost ?? 0));

  const when = (s: string) => r?.hist.find((h) => h.s === s)?.t;
  const body: Record<string, string> = {
    Issued: `Stock reserved in ${LOC[t.from].n} and the ticket printed at the window.`,
    Collected: `OTP verified at the store window — quantities left ${LOC[t.from].n}.`,
    Received: `${LOC[t.to].n} confirms the goods on the shelf and the request closes.`,
  };

  return (
    <DrawerFrame
      title={t.id}
      sub={`${LOC[t.from].n} → ${LOC[t.to].n} · against ${t.req}`}
      foot={
        <>
          <Btn variant="gh" onClick={close}>Close</Btn>
          <div className="sp" />
          {canHandOver(t.st) ? (
            <Btn variant="ok" disabled={otp.trim().length !== 6 || busy} onClick={() => handOver(otp)}>
              {busy ? "Handing over…" : "Hand over on OTP"}
            </Btn>
          ) : (
            <span className="mini">
              {t.st === "Collected" ? "Waiting on the receiving counter"
                : t.st === "Cancelled" ? "Withdrawn — nothing was collected against it" : "Closed"}
            </span>
          )}
        </>
      }
    >
      <div className="tktbox">
        <div style={{ flex: 1 }}>
          <div className="mini">Collection authority</div>
          <div className="mono-id" style={{ fontSize: 26, letterSpacing: "0.04em" }}>{t.id}</div>
          <div className="mtop" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <StatusPill status={t.st} />
            <span className="mini">{t.lines.length} item{t.lines.length > 1 ? "s" : ""} · {sum(t.lines, (l) => l.qty)} units · {money(value)}</span>
          </div>
          <div className="mini mtop">
            From <b>{LOC[t.from].n}</b> ({LOC[t.from].c}) → To <b>{LOC[t.to].n}</b> ({LOC[t.to].c}, {LOC[t.to].floor})
          </div>
        </div>
        <Otp value={t.otp} />
      </div>

      {canHandOver(t.st) && (
        <div className="mtop">
          <Field
            label="OTP quoted by the collector"
            hint="Six digits, read out at the window. The store refuses a handover on the wrong OTP."
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
                Supervisor override hands the stock over without an OTP. It is recorded against your name.
                {" "}
                <Btn size="xs" variant="dg" disabled={busy} onClick={() => handOver()}>
                  {busy ? "Handing over…" : "Confirm override handover"}
                </Btn>
                {" "}
                <Btn size="xs" variant="gh" onClick={() => setOverride(false)}>Cancel override</Btn>
              </>
            ) : (
              <>
                Collector cannot produce the OTP?{" "}
                <Btn size="xs" variant="gh" onClick={() => setOverride(true)}>Supervisor override</Btn>
              </>
            )}
          </div>
        </div>
      )}

      <div className="mtop">
        <DataTable
          cols={[
            { h: "Item", cls: "nm", w: "44%" },
            { h: "Approved qty", r: true },
            { h: "Unit" },
            { h: "Value", r: true },
          ]}
          rows={t.lines.map((l) => ({
            key: l.it,
            cells: [
              <>
                {IT[l.it]?.n ?? l.it}
                <small>{IT[l.it]?.c}</small>
              </>,
              <b>{fq(l.qty, l.it)}</b>,
              <span className="dim">{U(l.it)}</span>,
              <>{money(l.qty * (IT[l.it]?.cost ?? 0))}</>,
            ],
          }))}
          empty={{ title: "No items on this ticket" }}
        />
      </div>

      {canCancelTicket(t.st) && (
        <Section title="Cancel this ticket" sub="Nobody collected against it, and the stock should go back">
          {cancelling ? (
            <>
              <Field label="Reason" hint="Written to the ticket's history — it is the only record of the cancellation.">
                <input
                  placeholder="Counter closed, wrong outlet…"
                  aria-label={`Why ${t.id} is being cancelled`}
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

      {t.st === "Cancelled" ? (
        <div className="mtop">
          <Alert tone="w" label="CANCELLED">
            This ticket was withdrawn before it was collected — the stock never left {LOC[t.from].n}
            and the hold against it has been released.
          </Alert>
        </div>
      ) : (
        <div className="mtop">
          <div className="mini" style={{ marginBottom: 8 }}>Movement</div>
          <Feed
            items={STEPS.map((sName, i) => ({
              key: sName,
              title: (
                <>
                  {sName}{" "}
                  {i < step ? <Pill tone="ok">Done</Pill> : i === step ? <Pill tone="ac">Now</Pill> : <Pill tone="mu">Pending</Pill>}
                </>
              ),
              body: body[sName],
              when: i <= step ? (when(sName) ?? "today") : undefined,
              color: i < step ? "var(--good)" : i === step ? "var(--accent)" : "var(--line-strong)",
            }))}
          />
        </div>
      )}

      {r && r.mgrNote && (
        <div className="mini mtop">Manager note: {r.mgrNote}</div>
      )}
    </DrawerFrame>
  );
}

registerDrawer("stkt", TicketDrawer);
