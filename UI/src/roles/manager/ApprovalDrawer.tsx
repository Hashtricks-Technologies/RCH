import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { costOf, freeToPromise, qty } from "../../lib/selectors";
import { fq, money, sum, U, unitTotal } from "../../lib/fmt";
import { Alert, Btn, DataTable, Feed, Pill, Section, StatusPill, Tag } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import type { StockRequest } from "../../types";

const dotFor = (state: string) =>
  state === "Rejected" || state === "Cancelled" ? "var(--crit)"
    : state === "Received" || state === "Closed" ? "var(--good)"
      : state === "Request sent" ? "var(--warn)" : "var(--c1)";

/** Ready-made reasons the counter will understand; they fill the box, they do not replace it. */
const QUICK = [
  "The Central Store cannot cover this today.",
  "Duplicate of a request already raised for this counter.",
  "Not due yet — the counter is still holding enough.",
  "Raise this against the Central Kitchen, not the store.",
];

/** Who actually took the decision, from the trail the store keeps. */
const decidedBy = (r: StockRequest) => {
  const h = [...r.hist].reverse()
    .find((x) => x.s === "Rejected" || x.s === "Manager approved" || x.s === "Partially approved");
  return h ? { who: h.who, at: h.t, what: h.s } : null;
};

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
  const [killed, setKilled] = useState<boolean[]>(() => (req?.lines ?? []).map(() => false));
  const [lineWhy, setLineWhy] = useState<string[]>(() => (req?.lines ?? []).map(() => ""));
  const [note, setNote] = useState(req?.st === "Request sent" ? "" : req?.mgrNote ?? "");

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
  const toggleKill = (i: number) => setKilled(killed.map((x, j) => (j === i ? !x : x)));
  const setWhy = (i: number, v: string) => setLineWhy(lineWhy.map((x, j) => (j === i ? v : x)));

  const effective = req.lines.map((_, i) => (killed[i] ? 0 : appr[i] ?? 0));
  const giving = sum(effective, (v) => v);
  const trimmed = req.lines.some((l, i) => effective[i] < l.qty && !killed[i]);
  const value = req.lines.reduce((t, l, i) => t + (open ? effective[i] : l.appr) * costOf(l.it), 0);
  const askedTotal = unitTotal(req.lines);
  const givingTotal = unitTotal(req.lines.map((l, i) => ({ it: l.it, qty: open ? effective[i] : l.appr })));
  const shortOf = (l: { qty: number; appr: number; short?: number }) => l.short ?? Math.max(0, l.qty - l.appr);
  const shortLines = open
    ? []
    : req.lines.filter((l) => shortOf(l) > 0).map((l) => ({ it: l.it, qty: shortOf(l) }));
  const overCommitted = req.lines.filter((l) => freeToPromise(s, "store", l.it) < l.qty);

  const reason = note.trim();
  const killedIdx = req.lines.map((_, i) => i).filter((i) => killed[i]);
  const missingWhy = killedIdx.filter((i) => !lineWhy[i].trim());
  const canApprove = giving > 0 && missingWhy.length === 0;
  const decided = decidedBy(req);

  /* Line reasons travel with the request, because a counter that is told "no" on
     one item and nothing else has no way to find out why. */
  const composed = () => {
    const perLine = killedIdx.map((i) => `${IT[req.lines[i].it]?.n ?? req.lines[i].it}: ${lineWhy[i].trim()}`);
    return [reason, perLine.length ? `Not approved — ${perLine.join("; ")}` : ""]
      .filter(Boolean).join(" · ");
  };

  const doApprove = () => {
    if (!canApprove) return;
    approveRequest(req.id, effective, composed());
    close();
  };
  const doReject = () => {
    if (!reason) return;
    rejectRequest(req.id, composed());
    close();
  };

  return (
    <DrawerFrame
      title={req.id}
      sub={`${LOC[req.from].n} · ${LOC[req.from].floor} · raised ${req.at}`}
      foot={
        open ? (
          <>
            <Btn variant="gh" onClick={close}>Close</Btn>
            <div className="sp" />
            <Btn
              variant="dg"
              disabled={!reason}
              title={reason ? "Reject the whole request" : "Write the reason below — reject stays locked without one"}
              onClick={doReject}
            >
              Reject the request
            </Btn>
            <Btn
              disabled={!canApprove}
              title={giving === 0
                ? "Nothing is left to approve — use Reject the request"
                : missingWhy.length > 0 ? "Give a reason for every rejected item" : undefined}
              onClick={doApprove}
            >
              Approve {killedIdx.length > 0 ? "the rest" : ""} &amp; forward
            </Btn>
          </>
        ) : (
          <Btn variant="gh" onClick={close}>Close</Btn>
        )
      }
    >
      {!open && req.st === "Rejected" && (
        <Alert tone="c" label="REJECTED">
          {decided ? <>Rejected by <b>{decided.who}</b> at <b className="mono">{decided.at}</b>.</> : <>This request was rejected.</>}
          {" "}The counter sees this reason on its own screen: <b>{req.mgrNote || "no reason was recorded"}</b>.
        </Alert>
      )}
      {!open && req.st !== "Rejected" && decided && (
        <Alert tone="i" label="DECIDED">
          {decided.what} by <b>{decided.who}</b> at <b className="mono">{decided.at}</b>.
        </Alert>
      )}

      <Section title="Request" sub="Raised by the counter operator">
        <dl className="dl">
          <dt>Outlet</dt>
          <dd>{LOC[req.from].n} <span className="mini">{LOC[req.from].c} · {LOC[req.from].cc}</span></dd>
          <dt>Raised by</dt><dd>{req.by}</dd>
          <dt>Time</dt><dd className="mono">{req.at}</dd>
          <dt>Priority</dt>
          <dd>{req.urg ? <Pill tone="cr">Urgent</Pill> : <Pill tone="mu">Normal</Pill>}</dd>
          <dt>Status</dt><dd><StatusPill status={req.st} /></dd>
          <dt>Decided by</dt>
          <dd>{decided ? <>{decided.who} <span className="mini">{decided.at}</span></> : <span className="dim">Not decided yet.</span>}</dd>
          <dt>Counter's note</dt>
          <dd>{open && req.mgrNote ? req.mgrNote : !open ? (req.mgrNote || <span className="dim">No note.</span>) : <span className="dim">No note was left with this request.</span>}</dd>
        </dl>
      </Section>

      <Section
        title="Items"
        sub={open
          ? "Trim a quantity the Central Store cannot cover, or reject a single item and approve the rest. You cannot approve more than the counter asked for."
          : "Quantities as they were forwarded to the store keeper."}
      >
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "24%" },
              { h: "Type" },
              { h: "Asked", r: true },
              { h: "On hand", r: true },
              { h: "Free to promise", r: true },
              { h: open ? "Approve" : "Approved", r: true, w: "14%" },
              ...(open ? [{ h: "This item", w: "26%" }] : []),
            ]}
            rows={req.lines.map((l, i) => {
              const have = qty(s, "store", l.it);
              const free = freeToPromise(s, "store", l.it);
              const over = free < l.qty;
              const dead = killed[i];
              return {
                key: l.it + i,
                cells: [
                  <>{IT[l.it]?.n ?? l.it}<small>{IT[l.it]?.c}</small></>,
                  <Tag kind={IT[l.it]?.t === "MRP" ? "tr" : IT[l.it]?.t === "RAW" ? undefined : "md"}>
                    {IT[l.it]?.t}
                  </Tag>,
                  <>{fq(l.qty, l.it)} <small className="dim">{U(l.it)}</small></>,
                  <>{fq(have, l.it)}</>,
                  over
                    ? <span style={{ color: "var(--warn)" }} title="Already promised elsewhere">{fq(free, l.it)}</span>
                    : <>{fq(free, l.it)}</>,
                  open ? (
                    dead
                      ? <span style={{ color: "var(--crit)" }}>rejected</span>
                      : <input
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
                  ...(open ? [
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <Btn size="xs" variant={dead ? "gh" : "dg"} onClick={() => toggleKill(i)}>
                        {dead ? "Put this item back" : "Reject this item"}
                      </Btn>
                      {dead && (
                        <>
                          <input
                            value={lineWhy[i]}
                            onChange={(e) => setWhy(i, e.target.value)}
                            placeholder="Why this item is refused…"
                            aria-label={`Reason for rejecting ${IT[l.it]?.n ?? l.it}`}
                          />
                          {!lineWhy[i].trim() && (
                            <span className="mini" style={{ color: "var(--warn)" }}>
                              A reason is required before you can forward the rest.
                            </span>
                          )}
                        </>
                      )}
                    </div>,
                  ] : []),
                ],
              };
            })}
            empty={{ title: "This request has no items", sub: "Ask the counter to raise it again." }}
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
        {open && killedIdx.length > 0 && (
          <div className="totrow"><span>Items rejected outright</span><span>{killedIdx.length} of {req.lines.length}</span></div>
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
        <Alert tone="c" label="NOTHING LEFT">
          Every item is at zero or rejected. Use <b>Reject the request</b> below — it records the decision against
          your name and sends the reason to {LOC[req.from].n}.
        </Alert>
      )}

      {open && (
        <Section
          title="Reason for the counter"
          sub="Goes to the counter and to the store keeper with this request, against your name. Required to reject; worth writing whenever you trim."
        >
          <div className="btnrow" style={{ flexWrap: "wrap", marginBottom: 8 }}>
            {QUICK.map((r) => (
              <Btn key={r} size="xs" variant="sub" onClick={() => setNote(r)}>{r}</Btn>
            ))}
          </div>
          <div className="fld">
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why you trimmed or refused, and what the counter should do next…"
            />
            <div className="hint" style={!reason ? { color: "var(--warn)" } : undefined}>
              {reason
                ? "Kept on the request history against your name."
                : "No reason, no reject — the counter must be told why. Approving without one is allowed."}
            </div>
          </div>
          <div className="btnrow mtop">
            <Btn variant="dg" wide disabled={!reason} onClick={doReject}>
              Reject the whole request
            </Btn>
            <Btn wide disabled={!canApprove} onClick={doApprove}>
              Approve {killedIdx.length > 0 ? "the remaining items" : "and forward to store"}
            </Btn>
          </div>
        </Section>
      )}

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
