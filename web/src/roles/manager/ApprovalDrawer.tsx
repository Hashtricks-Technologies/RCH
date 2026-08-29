import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { costOf, freeToPromise, qty } from "../../lib/selectors";
import { fq, money, sum, U, unitTotal } from "../../lib/fmt";
import { Alert, Btn, DataTable, Feed, Pill, Section, StatusPill, Tag } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";

const dotFor = (state: string) =>
  state === "Rejected" || state === "Cancelled" ? "var(--crit)"
    : state === "Received" || state === "Closed" ? "var(--good)"
      : state === "Request sent" ? "var(--warn)" : "var(--c1)";

function ApprovalDrawer({ id }: DrawerProps) {
  const s = useApp();
  const close = useApp((x) => x.closeDrawer);
  const approveRequest = useApp((x) => x.approveRequest);
  const rejectRequest = useApp((x) => x.rejectRequest);

  const req = s.req.find((r) => r.id === id);

  const [appr, setAppr] = useState<number[]>(() =>
    (req?.lines ?? []).map((l) =>
      Math.max(0, Math.min(l.qty, req && req.st === "Request sent" ? freeToPromise(s, "store", l.it) : l.appr))
    )
  );
  const [note, setNote] = useState(req?.mgrNote ?? "");

  if (!req) {
    return (
      <DrawerFrame title="Request not found" sub={id}>
        <p className="mini">This request is no longer in the queue.</p>
      </DrawerFrame>
    );
  }

  const open = req.st === "Request sent";
  const set = (i: number, raw: string) => {
    const max = req.lines[i].qty;
    const n = Number(raw);
    const v = Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
    setAppr(appr.map((x, j) => (j === i ? v : x)));
  };

  const giving = sum(appr, (v) => v);
  const trimmed = req.lines.some((l, i) => (appr[i] ?? 0) < l.qty);
  const value = req.lines.reduce((t, l, i) => t + (open ? appr[i] ?? 0 : l.appr) * costOf(l.it), 0);
  const askedTotal = unitTotal(req.lines);
  const givingTotal = unitTotal(req.lines.map((l, i) => ({ it: l.it, qty: open ? appr[i] ?? 0 : l.appr })));
  const shortOf = (l: { qty: number; appr: number; short?: number }) => l.short ?? Math.max(0, l.qty - l.appr);
  const shortLines = open
    ? []
    : req.lines.filter((l) => shortOf(l) > 0).map((l) => ({ it: l.it, qty: shortOf(l) }));
  const overCommitted = req.lines.filter((l) => freeToPromise(s, "store", l.it) < l.qty);
  const reason = note.trim();

  return (
    <DrawerFrame
      title={req.id}
      sub={`${LOC[req.from].n} · ${LOC[req.from].floor} · raised ${req.at}`}
      foot={
        open ? (
          <>
            <Btn variant="gh" onClick={close}>Close</Btn>
            <Btn
              variant="dg"
              disabled={!reason}
              title={reason ? undefined : "Write the reason in the manager note first"}
              onClick={() => { rejectRequest(req.id, note); close(); }}
            >
              Reject
            </Btn>
            <Btn onClick={() => { approveRequest(req.id, appr, note); close(); }}>
              Approve &amp; forward to store
            </Btn>
          </>
        ) : (
          <Btn variant="gh" onClick={close}>Close</Btn>
        )
      }
    >
      <Section title="Request" sub="Raised by the counter operator">
        <dl className="dl">
          <dt>Outlet</dt>
          <dd>{LOC[req.from].n} <span className="mini">{LOC[req.from].c} · {LOC[req.from].cc}</span></dd>
          <dt>Raised by</dt><dd>{req.by}</dd>
          <dt>Time</dt><dd className="mono">{req.at}</dd>
          <dt>Priority</dt>
          <dd>{req.urg ? <Pill tone="cr">Urgent</Pill> : <Pill tone="mu">Normal</Pill>}</dd>
          <dt>Status</dt><dd><StatusPill status={req.st} /></dd>
          <dt>Counter's note</dt>
          <dd>{req.mgrNote ? req.mgrNote : <span className="dim">No note was left with this request.</span>}</dd>
        </dl>
      </Section>

      <Section
        title="Lines"
        sub={open
          ? "Trim a quantity if the Central Store cannot cover it. You cannot approve more than the counter asked for."
          : "Quantities as they were forwarded to the store keeper."}
      >
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "26%" },
              { h: "Type" },
              { h: "Asked", r: true },
              { h: "On hand", r: true },
              { h: "Free to promise", r: true },
              { h: open ? "Approve" : "Approved", r: true, w: "16%" },
            ]}
            rows={req.lines.map((l, i) => {
              const have = qty(s, "store", l.it);
              const free = freeToPromise(s, "store", l.it);
              const over = free < l.qty;
              return {
                key: l.it + i,
                cells: [
                  <>{IT[l.it]?.n ?? l.it}<small>{IT[l.it]?.c}</small></>,
                  <Tag kind={IT[l.it]?.t === "TRADED" ? "tr" : IT[l.it]?.t === "RAW" ? undefined : "md"}>
                    {IT[l.it]?.t}
                  </Tag>,
                  <>{fq(l.qty, l.it)} <small className="dim">{U(l.it)}</small></>,
                  <>{fq(have, l.it)}</>,
                  over
                    ? <span style={{ color: "var(--warn)" }} title="Already promised elsewhere">{fq(free, l.it)}</span>
                    : <>{fq(free, l.it)}</>,
                  open ? (
                    <input
                      type="number"
                      min={0}
                      max={l.qty}
                      step={U(l.it) === "nos" ? 1 : 0.5}
                      value={appr[i] ?? 0}
                      onChange={(e) => set(i, e.target.value)}
                      aria-label={`Approved quantity for ${IT[l.it]?.n ?? l.it}`}
                    />
                  ) : (
                    <>
                      <b>{fq(l.appr, l.it)}</b>
                      {shortOf(l) > 0 && (
                        <small style={{ display: "block", color: "var(--warn)" }}>
                          {fq(shortOf(l), l.it)} short
                        </small>
                      )}
                    </>
                  ),
                ],
              };
            })}
            empty={{ title: "This request has no lines", sub: "Ask the counter to raise it again." }}
          />
        </div>
        <div className="totrow mtop"><span>Total asked</span><span>{askedTotal}</span></div>
        <div className="totrow">
          <span>{open ? "You are approving" : "Approved"}</span>
          <span>{givingTotal}</span>
        </div>
        {shortLines.length > 0 && (
          <div className="totrow"><span>Not approved</span><span>{unitTotal(shortLines)}</span></div>
        )}
        <div className="totrow"><span>Cost value of the issue</span><span>{money(value)}</span></div>
      </Section>

      {open && overCommitted.length > 0 && (
        <Alert tone="w" label="PROMISED">
          Free to promise is what the Central Store holds less what issued tickets have reserved and what other
          approvals have already promised. It will not cover{" "}
          {overCommitted.map((l) => IT[l.it]?.n ?? l.it).join(", ")} in full.
        </Alert>
      )}
      {open && trimmed && giving > 0 && (
        <Alert tone="w" label="SHORT">
          You are approving less than the counter asked for. The shortfall is recorded on {req.id} — there is no
          back-order document, so the counter raises a fresh request once the Central Store is replenished.
        </Alert>
      )}
      {!open && shortLines.length > 0 && (
        <Alert tone="w" label="SHORT">
          <b>{unitTotal(shortLines)}</b> of what {LOC[req.from].n} asked for was not approved. It is recorded on
          this request; nothing is on back-order, so the counter must raise it again.
        </Alert>
      )}
      {open && giving === 0 && (
        <Alert tone="c" label="NIL">
          Every line is at zero. Forwarding this now records it as a rejection and no pick ticket will be issued.
        </Alert>
      )}

      <Section title="Manager note" sub="Goes to the counter and to the store keeper with this request.">
        <div className="fld">
          <textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why you trimmed a line, or what the counter should do next…"
            disabled={!open}
          />
          <div className="hint" style={open && !reason ? { color: "var(--warn)" } : undefined}>
            {open && !reason
              ? "A reason is required — the counter sees it. Reject stays disabled until you write one."
              : "Kept on the request history against your name."}
          </div>
        </div>
      </Section>

      <Section title="History" sub="Every hand this request has passed through">
        <Feed
          items={req.hist.map((h, i) => ({
            key: h.s + i,
            title: h.s,
            body: h.who,
            when: h.t,
            color: dotFor(h.s),
          }))}
        />
      </Section>
    </DrawerFrame>
  );
}

registerDrawer("mreq", ApprovalDrawer);

export default ApprovalDrawer;
