import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { avail } from "../../lib/selectors";
import { fq, money, sum, U } from "../../lib/fmt";
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
      Math.max(0, Math.min(l.qty, req && req.st === "Request sent" ? avail(s, "store", l.it) : l.appr))
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

  const asked = sum(req.lines, (l) => l.qty);
  const giving = sum(appr, (v) => v);
  const trimmed = req.lines.some((l, i) => (appr[i] ?? 0) < l.qty);
  const value = req.lines.reduce(
    (t, l, i) => t + (open ? appr[i] ?? 0 : l.appr) * (IT[l.it]?.cost ?? 0), 0);

  return (
    <DrawerFrame
      title={req.id}
      sub={`${LOC[req.from].n} · ${LOC[req.from].floor} · raised ${req.at}`}
      foot={
        open ? (
          <>
            <Btn variant="gh" onClick={close}>Close</Btn>
            <Btn variant="dg" onClick={() => { rejectRequest(req.id, note); close(); }}>Reject</Btn>
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
              { h: "Item", cls: "nm", w: "34%" },
              { h: "Type" },
              { h: "Asked", r: true },
              { h: "At Central Store", r: true },
              { h: open ? "Approve" : "Approved", r: true, w: "16%" },
            ]}
            rows={req.lines.map((l, i) => {
              const have = avail(s, "store", l.it);
              const short = have < l.qty;
              return {
                key: l.it + i,
                cells: [
                  <>{IT[l.it]?.n ?? l.it}<small>{IT[l.it]?.c}</small></>,
                  <Tag kind={IT[l.it]?.t === "TRADED" ? "tr" : IT[l.it]?.t === "RAW" ? undefined : "md"}>
                    {IT[l.it]?.t}
                  </Tag>,
                  <>{fq(l.qty, l.it)} <small className="dim">{U(l.it)}</small></>,
                  short
                    ? <span style={{ color: "var(--warn)" }}>{fq(have, l.it)}</span>
                    : <>{fq(have, l.it)}</>,
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
                    <b>{fq(l.appr, l.it)}</b>
                  ),
                ],
              };
            })}
            empty={{ title: "This request has no lines", sub: "Ask the counter to raise it again." }}
          />
        </div>
        <div className="totrow mtop"><span>Total asked</span><span>{Math.round(asked * 1000) / 1000} units</span></div>
        <div className="totrow">
          <span>{open ? "You are approving" : "Approved"}</span>
          <span>{Math.round((open ? giving : sum(req.lines, (l) => l.appr)) * 1000) / 1000} units</span>
        </div>
        <div className="totrow"><span>Cost value of the issue</span><span>{money(value)}</span></div>
      </Section>

      {open && trimmed && giving > 0 && (
        <Alert tone="w" label="SHORT">
          You are approving less than the counter asked for. The remainder will park as a back-order against{" "}
          {req.id} — the counter can raise a fresh request once the Central Store is replenished.
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
          <div className="hint">Kept on the request history against your name.</div>
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
