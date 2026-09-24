import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { avail, costOf, freeToPromise, openOutlets, qty, useCan } from "../../lib/selectors";
import { fq, money, sum, U, unitTotal } from "../../lib/fmt";
import { Alert, Btn, DataTable, DraftLineInput, Feed, Field, Pill, Section, StatusPill, Tag, Tip } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import type { DatedDoc, LocKey, StockRequest } from "../../types";

const dotFor = (state: string) =>
  state === "Rejected" || state === "Cancelled" ? "var(--crit)"
    : state === "Received" || state === "Closed" ? "var(--good)"
      : state === "Request sent" ? "var(--warn)" : "var(--c1)";

/** Ready-made reasons the counter will understand; they fill the box, they do not replace it. */
const QUICK = [
  "The Central Store cannot cover this today.",
  "Duplicate of a request already raised for this counter.",
  "Not due yet - the counter is still holding enough.",
  "Raise this against the Central Kitchen, not the store.",
];

/** Who actually took the decision, from the trail the store keeps. */
const decidedBy = (r: StockRequest) => {
  const h = [...r.hist].reverse()
    .find((x) => x.s === "Rejected" || x.s === "Manager approved" || x.s === "Partially approved");
  return h ? { who: h.who, at: h.t, what: h.s } : null;
};

/**
 * C16. Everything below is derived **once**, from the request this drawer opened over -
 * what the store can promise per line, which lines have been struck out, the reason boxes and
 * the manager's note. A `useState` initialiser runs on mount and never again, and this drawer
 * is one long-lived component instance that `openDrawer("mreq", other)` re-points at a second
 * request without unmounting the first: the trims typed against one request were then sitting
 * in the boxes of another, over lines that may not even have the same items.
 *
 * The key is the fix. `req.id` covers being pointed elsewhere; the **last trail entry's**
 * instant covers the same request coming back changed underneath - an SSE refetch after somebody
 * else decided it - and either one forces a fresh instance with freshly derived state.
 *
 * It has to be `hist.at(-1)?.iso` and not `req.iso`: `req.iso` is the instant the counter
 * *raised* the request, which never changes for as long as the document exists, so keying on it
 * was keying on `req.id` twice. Every decision a second browser makes appends to the trail, and
 * that is the only field on the request that moves when one does. `req.iso` is the fallback for
 * a document whose trail has not been read yet, which is the one case where nothing has moved.
 *
 * `bodyKey` is exported so the key can be tested for what it promises - moving when the document
 * does and standing still when it has not - without a screen that happens to render it.
 */
export const bodyKey = (r: DatedDoc<StockRequest>) => `${r.id}:${r.hist.at(-1)?.iso ?? r.iso}`;

function ApprovalDrawer({ id }: DrawerProps) {
  const req = useApp((x) => x.req.find((r) => r.id === id));
  if (!req) {
    return (
      <DrawerFrame title="Request not found" sub={id}>
        <p className="mini">This request is no longer in the queue.</p>
      </DrawerFrame>
    );
  }
  return <ApprovalBody key={bodyKey(req)} req={req} />;
}

function ApprovalBody({ req }: { req: DatedDoc<StockRequest> }) {
  const s = useApp();
  const close = useApp((x) => x.closeDrawer);
  const approveRequest = useApp((x) => x.approveRequest);
  const rejectRequest = useApp((x) => x.rejectRequest);
  const cancelRequest = useApp((x) => x.cancelRequest);
  const redirectRequest = useApp((x) => x.redirectRequest);
  const may = useCan("approvals");

  const [appr, setAppr] = useState<number[]>(() =>
    req.lines.map((l) =>
      Math.max(0, Math.min(l.qty, req.st === "Request sent" ? freeToPromise(s, "store", l.it) : l.appr))
    )
  );
  const [killed, setKilled] = useState<boolean[]>(() => req.lines.map(() => false));
  const [lineWhy, setLineWhy] = useState<string[]>(() => req.lines.map(() => ""));
  const [note, setNote] = useState(req.st === "Request sent" ? "" : req.mgrNote ?? "");
  const [busy, setBusy] = useState<"approve" | "reject" | "withdraw" | "redirect" | null>(null);

  const open = req.st === "Request sent";
  /** Whether this session decides it: an open request, and a role that may change Approvals. A
   *  role that sees Approvals only reads the request as it stands. */
  const decide = open && may;
  // A request the kitchen raised (`req.from === "kitchen"`) has no peer shop to redirect to -
  // only an outlet's own request does. `peers` is every other *open* outlet: a closed one is
  // not trading, so redirecting to it would issue a ticket nobody can collect against.
  const peers = openOutlets().filter((o) => o !== req.from);
  const [redirectTo, setRedirectTo] = useState<LocKey | null>(peers[0] ?? null);
  // A decision this manager made themselves, before the store keeper turns it into a ticket -
  // the one thing left to undo once "Approve & forward" has already gone through. A manager
  // is hospital-wide, so this is not scoped to the outlet that raised it.
  const canWithdraw = may && (req.st === "Manager approved" || req.st === "Partially approved") && !req.ticket;
  /** Clamped to what the counter asked for. The box itself is a `DraftLineInput`, so this is
   *  reached once per edit rather than once per keystroke - reading a half-typed "12." as a
   *  number is what turned a half-litre into 12 and then into 125 clamped back to the line. */
  const set = (i: number, n: number) => {
    const max = req.lines[i].qty;
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
    return [reason, perLine.length ? `Not approved - ${perLine.join("; ")}` : ""]
      .filter(Boolean).join(" · ");
  };

  // The drawer closes only once the server has taken the decision. A refusal - an empty
  // reason, a request someone else has already decided, a dropped connection - leaves every
  // per-line trim and the reason exactly where the manager typed them.
  const doApprove = async () => {
    if (!canApprove || busy) return;
    setBusy("approve");
    const ok = await approveRequest(req.id, effective, composed());
    setBusy(null);
    if (ok) close();
  };
  const doReject = async () => {
    if (!reason || busy) return;
    setBusy("reject");
    const ok = await rejectRequest(req.id, composed());
    setBusy(null);
    if (ok) close();
  };
  const doWithdraw = async () => {
    if (!canWithdraw || busy) return;
    setBusy("withdraw");
    const ok = await cancelRequest(req.id);
    setBusy(null);
    if (ok) close();
  };
  const doRedirect = async () => {
    if (!redirectTo || busy) return;
    setBusy("redirect");
    const ok = await redirectRequest(req.id, redirectTo);
    setBusy(null);
    if (ok) close();
  };

  return (
    <DrawerFrame
      title={req.id}
      sub={`${LOC[req.from].n} · ${LOC[req.from].floor} · raised ${req.at}`}
      foot={
        decide ? (
          <>
            <Btn variant="gh" onClick={close}>Close</Btn>
            <div className="sp" />
            <Btn
              variant="dg"
              disabled={!reason || busy !== null}
              tip={reason ? "Reject the whole request" : "Write the reason below - reject stays locked without one"}
              onClick={doReject}
            >
              {busy === "reject" ? "Rejecting…" : "Reject the request"}
            </Btn>
            <Btn
              disabled={!canApprove || busy !== null}
              tip={giving === 0
                ? "Nothing is left to approve - use Reject the request"
                : missingWhy.length > 0 ? "Give a reason for every rejected item" : undefined}
              onClick={doApprove}
            >
              {busy === "approve"
                ? "Approving…"
                : <>Approve {killedIdx.length > 0 ? "the rest" : ""} &amp; forward</>}
            </Btn>
          </>
        ) : (
          <>
            <Btn variant="gh" onClick={close}>Close</Btn>
            {canWithdraw && (
              <>
                <div className="sp" />
                <Btn variant="dg" disabled={busy !== null} onClick={doWithdraw}>
                  {busy === "withdraw" ? "Withdrawing…" : "Withdraw approval"}
                </Btn>
              </>
            )}
          </>
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
          {canWithdraw && " The store keeper has not issued a ticket yet - this approval can still be withdrawn."}
        </Alert>
      )}

      <Section title="Request" tip="Raised by the counter operator">
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
        tip={open
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
              ...(decide ? [{ h: "This item", w: "26%" }] : []),
            ]}
            rows={req.lines.map((l, i) => {
              const have = qty(s, "store", l.it);
              const free = freeToPromise(s, "store", l.it);
              const over = free < l.qty;
              const dead = killed[i];
              return {
                key: l.it + i,
                cells: [
                  <span key="nm">{IT[l.it]?.n ?? l.it}<small>{IT[l.it]?.c}</small></span>,
                  <Tag key="ty" kind={IT[l.it]?.t === "MRP" ? "tr" : IT[l.it]?.t === "RAW" ? undefined : "md"}>
                    {IT[l.it]?.t}
                  </Tag>,
                  <span key="ask">{fq(l.qty, l.it)} <small className="dim">{U(l.it)}</small></span>,
                  <span key="have">{fq(have, l.it)}</span>,
                  over
                    ? <Tip key="free" text="Already promised elsewhere"><span style={{ color: "var(--warn)" }}>{fq(free, l.it)}</span></Tip>
                    : <span key="free">{fq(free, l.it)}</span>,
                  open && !decide ? (
                    <span key="appr" className="dim">Not decided</span>
                  ) : open ? (
                    dead
                      ? <span key="appr" style={{ color: "var(--crit)" }}>rejected</span>
                      // A half-litre is a real approval. The box absorbs the typing and commits
                      // once, on the way out, so "12.5" is not read as 1, then 12, then 125.
                      : <DraftLineInput
                        key="appr"
                        value={appr[i] ?? 0}
                        min={0}
                        step={U(l.it) === "nos" ? 1 : 0.5}
                        ariaLabel={`Approved quantity for ${IT[l.it]?.n ?? l.it}`}
                        onCommit={(n) => set(i, n)}
                      />
                  ) : (
                    <span key="appr">
                      <b>{fq(l.appr, l.it)}</b>
                      {shortOf(l) > 0 && (
                        <small style={{ display: "block", color: "var(--warn)" }}>
                          {fq(shortOf(l), l.it)} short
                        </small>
                      )}
                    </span>
                  ),
                  ...(decide ? [
                    <div key="act" style={{ display: "flex", flexDirection: "column", gap: 5 }}>
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
          You are approving less than the counter asked for. The shortfall is recorded on {req.id} - there is no
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
          Every item is at zero or rejected. Use <b>Reject the request</b> below - it records the decision against
          your name and sends the reason to {LOC[req.from].n}.
        </Alert>
      )}

      {decide && peers.length > 0 && (
        <Section
          title="Fulfil from another outlet instead"
          tip="If you know a peer shop is already holding this, send it from there instead of the central store - a ticket issues straight from that shop's shelf, for the full amount asked."
        >
          <div className="lgrid">
            <DataTable
              cols={[{ h: "Item", cls: "nm" }, { h: "Asked", r: true }, { h: `Free at ${redirectTo ? LOC[redirectTo].n : "-"}`, r: true }]}
              rows={req.lines.map((l, i) => {
                const free = redirectTo ? avail(s, redirectTo, l.it) : 0;
                const short = free < l.qty;
                return {
                  key: l.it + i,
                  cells: [
                    IT[l.it]?.n ?? l.it,
                    <span key="ask">{fq(l.qty, l.it)} <small className="dim">{U(l.it)}</small></span>,
                    short
                      ? <span key="free" style={{ color: "var(--warn)" }}>{fq(free, l.it)}</span>
                      : <span key="free" style={{ color: "var(--good)" }}>{fq(free, l.it)}</span>,
                  ],
                };
              })}
              empty={{ title: "This request has no items" }}
            />
          </div>
          <div className="mtop" style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
            <Field label="Peer outlet">
              <select value={redirectTo ?? ""} onChange={(e) => setRedirectTo(e.target.value as LocKey)}>
                {peers.map((p) => <option key={p} value={p}>{LOC[p].n}</option>)}
              </select>
            </Field>
            <Btn variant="sub" disabled={!redirectTo || busy !== null} onClick={doRedirect}>
              {busy === "redirect" ? "Redirecting…" : `Redirect from ${redirectTo ? LOC[redirectTo].n : "-"}`}
            </Btn>
          </div>
        </Section>
      )}

      {decide && (
        <Section
          title="Reason for the counter"
          tip="Goes to the counter and to the store keeper with this request, against your name. Required to reject; worth writing whenever you trim. Kept on the request history against your name."
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
            {!reason && (
              <div className="hint" style={{ color: "var(--warn)" }}>
                No reason, no reject - the counter must be told why. Approving without one is allowed.
              </div>
            )}
          </div>
          {/* The footer's own Reject / Approve pair is the canonical one - it is on screen
              wherever the drawer is scrolled to, it carries the busy labels, and it is the
              pair the tests press. A second copy here was a second door onto the same two
              calls, unlocked by a different set of conditions and with no busy state at all:
              pressing it while the footer's was in flight posted the decision twice. */}
        </Section>
      )}

      <Section title="History" tip="Every hand this request has passed through">
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
