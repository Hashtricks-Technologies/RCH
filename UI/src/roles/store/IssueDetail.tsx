import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { freeToPromise } from "../../lib/selectors";
import { U, fq, money, money0, sum } from "../../lib/fmt";
import {
  Alert, Btn, DataTable, Feed, Field, Otp, Pill, Section, StatusPill, TableFoot,
} from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import type { StockRequest } from "../../types";

/** Seeded requests carry no apprBy, so fall back to the last approval on the trail (H6). */
const approver = (r: StockRequest) =>
  r.apprBy
  ?? [...r.hist].reverse().find((h) => h.s === "Manager approved" || h.s === "Partially approved")?.who;

const dotFor = (state: string) =>
  state === "Rejected" || state === "Cancelled" ? "var(--crit)"
    : state === "Request sent" ? "var(--warn)"
      : state === "Ticket issued" ? "var(--accent)" : "var(--good)";

/**
 * One detail view behind every row on the issue desk. The id is a request id,
 * or a ticket id — a ticket is only ever a view of the request behind it, so
 * either way the drawer resolves to the same request and reads the ticket off it.
 */
function IssueDetail({ id }: DrawerProps) {
  const s = useApp();
  const issueTicket = useApp((x) => x.issueTicket);
  const handover = useApp((x) => x.handover);
  const openDrawer = useApp((x) => x.openDrawer);
  const close = useApp((x) => x.closeDrawer);

  const [otp, setOtp] = useState("");
  const [override, setOverride] = useState(false);

  const byTicket = s.tkt.find((t) => t.id === id);
  const r = s.req.find((x) => x.id === (byTicket ? byTicket.req : id));

  if (!r) {
    return (
      <DrawerFrame title="Request not found" sub={id}>
        <div className="empty">
          <b>{id} is no longer on the issue desk</b>
          <p>It may have been collected and closed already. Close this panel and refresh the list.</p>
        </div>
      </DrawerFrame>
    );
  }

  const ticket = byTicket ?? (r.ticket ? s.tkt.find((t) => t.id === r.ticket) : undefined);

  /** freeToPromise nets off every open approval including this one, so add the line back:
   *  what matters is the stock left after the *other* approvals (C6). */
  const freeFor = (it: string, appr: number) => freeToPromise(s, "store", it) + appr;

  const asked = sum(r.lines, (l) => l.qty);
  const appr = sum(r.lines, (l) => l.appr);
  const value = sum(r.lines, (l) => l.appr * (IT[l.it]?.cost ?? 0));
  const shortLines = r.lines.filter((l) => (l.short ?? Math.max(0, l.qty - l.appr)) > 0);
  const uncovered = r.lines.filter((l) => l.appr > 0 && freeFor(l.it, l.appr) < l.appr);

  const canIssue = (r.st === "Manager approved" || r.st === "Partially approved")
    && r.ticket === null && appr > 0 && uncovered.length === 0;

  return (
    <DrawerFrame
      title={r.id}
      sub={`${LOC[r.from].n} · raised by ${r.by} at ${r.at} · ${r.lines.length} item${r.lines.length > 1 ? "s" : ""}`}
      foot={
        <>
          <Btn variant="gh" onClick={close}>Close</Btn>
          <div className="sp" />
          {r.ticket === null && appr > 0 ? (
            <Btn
              disabled={!canIssue}
              title={uncovered.length ? `${IT[uncovered[0].it]?.n ?? uncovered[0].it} is committed elsewhere` : undefined}
              onClick={() => issueTicket(r.id)}
            >
              Generate ticket
            </Btn>
          ) : ticket && ticket.st === "Issued" ? (
            <Btn variant="ok" disabled={otp.trim().length !== 6} onClick={() => handover(ticket.id, otp)}>
              Hand over on OTP
            </Btn>
          ) : (
            <span className="mini">
              {ticket ? (ticket.st === "Collected" ? `In transit to ${LOC[r.from].n}` : "Closed") : "Nothing approved to issue"}
            </span>
          )}
        </>
      }
    >
      <Section
        title="Who asked, and when"
        sub={`${r.by} · ${LOC[r.from].n} (${LOC[r.from].c}, ${LOC[r.from].floor}) · ${r.at}`}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <StatusPill status={r.st} />
          {r.urg && <Pill tone="cr">Urgent</Pill>}
          <span className="mini">
            {asked} asked · {appr} approved · {money0(value)} at cost
          </span>
        </div>
        {shortLines.length > 0 && (
          <div className="mtop">
            <Alert tone="w" label="TRIMMED">
              {shortLines.length} item{shortLines.length > 1 ? "s were" : " was"} cut back by the outlet
              manager — {shortLines.map((l) => IT[l.it]?.n ?? l.it).join(", ")}.
            </Alert>
          </div>
        )}
        {uncovered.length > 0 && (
          <div className="mtop">
            <Alert tone="c" label="SHORT">
              {IT[uncovered[0].it]?.n ?? uncovered[0].it} is promised elsewhere — only{" "}
              {fq(freeFor(uncovered[0].it, uncovered[0].appr), uncovered[0].it)} {U(uncovered[0].it)} is free to
              promise against the {fq(uncovered[0].appr, uncovered[0].it)} approved. No ticket can be raised
              until that clears.
            </Alert>
          </div>
        )}
      </Section>

      <Section title="Items" sub="Asked against approved, and what the central store can actually cover right now">
        <DataTable
          cols={[
            { h: "Item", cls: "nm", w: "26%" },
            { h: "Asked", r: true },
            { h: "Approved", r: true },
            { h: "Short", r: true },
            { h: "Unit" },
            { h: "Free to promise", r: true },
            { h: "Value at cost", r: true },
            { h: "Cover", w: "14%" },
          ]}
          rows={r.lines.map((l, i) => {
            const free = freeFor(l.it, l.appr);
            const short = l.short ?? Math.round(Math.max(0, l.qty - l.appr) * 1000) / 1000;
            const ok = l.appr === 0 || free >= l.appr;
            return {
              key: l.it + i,
              cells: [
                <>
                  {IT[l.it]?.n ?? l.it}
                  <small>{IT[l.it]?.c ?? ""} · {IT[l.it]?.g ?? ""}</small>
                </>,
                <>{fq(l.qty, l.it)}</>,
                <b>{fq(l.appr, l.it)}</b>,
                short > 0
                  ? <span style={{ color: "var(--warn)" }}>{fq(short, l.it)}</span>
                  : <span className="dim">{fq(0, l.it)}</span>,
                <span className="dim">{U(l.it)}</span>,
                <>{fq(free, l.it)}</>,
                <>{money(l.appr * (IT[l.it]?.cost ?? 0))}</>,
                l.appr === 0
                  ? <Pill tone="mu">Nothing approved</Pill>
                  : ok ? <Pill tone="ok">Covered</Pill> : <Pill tone="wn">Short</Pill>,
              ],
            };
          })}
          empty={{ title: "No items on this request" }}
        />
        <TableFoot count={r.lines.length} extra={<>{asked} asked · {appr} approved · {money0(value)} at cost</>} />
      </Section>

      <Section
        title="Manager decision"
        sub={approver(r) ? `${approver(r)} · ${r.st}` : "Not yet approved by an outlet manager"}
      >
        <p className="mini">{r.mgrNote || "No note was left with the decision."}</p>
      </Section>

      {ticket && (
        <Section
          title="Collection ticket"
          sub={`${ticket.id} · ${LOC[ticket.from].n} → ${LOC[ticket.to].n} · ${ticket.st}`}
        >
          <div className="tktbox">
            <div style={{ flex: 1 }}>
              <div className="mini">Collection authority</div>
              <div className="mono-id" style={{ fontSize: 22, letterSpacing: "0.04em" }}>{ticket.id}</div>
              <div className="mtop" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <StatusPill status={ticket.st} />
                <span className="mini">
                  {ticket.lines.length} item{ticket.lines.length > 1 ? "s" : ""} · {sum(ticket.lines, (l) => l.qty)} units
                </span>
                <Btn size="xs" variant="gh" onClick={() => openDrawer("stkt", ticket.id)}>Open ticket</Btn>
              </div>
            </div>
            <Otp value={ticket.otp} />
          </div>

          {ticket.st === "Issued" && (
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
                    <Btn size="xs" variant="dg" onClick={() => handover(ticket.id)}>Confirm override handover</Btn>
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
        </Section>
      )}

      <Section title="History" sub="Every hand this request has passed through">
        <Feed
          items={r.hist.map((h, i) => ({
            key: h.s + i, title: h.s, body: h.who, when: h.t, color: dotFor(h.s),
          }))}
        />
      </Section>
    </DrawerFrame>
  );
}

registerDrawer("sissue", IssueDetail);
