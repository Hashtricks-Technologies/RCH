import { useEffect, useState } from "react";
import { nextQrStep, qrOpenAt } from "@rch/domain";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { counterNameOf, locName, useCan, useHolds } from "../../lib/selectors";
import { fromWireTime, isToday, money } from "../../lib/fmt";
import { Alert, Btn, Card, Locked, PageHead, Pill, Switch, Tip } from "../../ui/kit";
import type { LocKey, QrOrder, QrOrderStatus, RefundStatus, Tone } from "../../types";

/**
 * The counter's queue of QR orders: a customer scanned a code at the outlet, ordered from their
 * phone and paid online, and the gateway's capture has already raised the bill. What is left is
 * to make it and hand it over, one press per step along the code's own path (`nextQrStep` in
 * @rch/domain) - Preparing, then Ready and Collected at a pickup code, or Out for delivery and
 * Delivered at a deliver one. The server refuses any other move with a sentence.
 */

/** The words on the one button that moves an order to `to`. */
const STEP_LABEL: Partial<Record<QrOrderStatus, string>> = {
  Preparing: "Start preparing",
  Ready: "Mark ready",
  "Out for delivery": "Out for delivery",
  Collected: "Collected",
  Delivered: "Delivered",
};

/** The lanes, left to right. Ready and Out for delivery share one: both are waiting on a hand-over. */
const LANES: { title: string; tip: string; has: readonly QrOrderStatus[] }[] = [
  { title: "New", tip: "Paid online and not started yet.", has: ["Paid"] },
  { title: "Preparing", tip: "Being made now.", has: ["Preparing"] },
  { title: "Ready / Out for delivery", tip: "Waiting at the counter for the customer, or on its way to their spot.", has: ["Ready", "Out for delivery"] },
];
/** Where an order's walk ends, one way or another. */
const DONE: readonly QrOrderStatus[] = ["Collected", "Delivered", "Refunded", "Voided"];

const REFUND_TONE: Record<RefundStatus, Tone> = { Pending: "wn", Sent: "in", Processed: "ok", Failed: "cr" };
/** The refund behind an order or a bill, as a pill. */
export const RefundPill = ({ status }: { status: RefundStatus }) => <Pill tone={REFUND_TONE[status]}>Refund {status.toLowerCase()}</Pill>;

/** When the order became the counter's: paid, or placed where it never was. */
const whenOf = (o: QrOrder) => o.paidAt ?? o.at;
const oldestFirst = (a: QrOrder, b: QrOrder) => whenOf(a).localeCompare(whenOf(b));

export default function QrOrders() {
  const user = useApp((s) => s.user)!;
  const orders = useApp((s) => s.qrOrders);
  const paused = useApp((s) => s.qrPaused);
  const hours = useApp((s) => s.qrHours);
  const failed = useApp((s) => s.qrOrdersFailed);
  const load = useApp((s) => s.loadQrOrders);
  const step = useApp((s) => s.setQrOrderStatus);
  const setPause = useApp((s) => s.setQrPause);
  const openDrawer = useApp((s) => s.openDrawer);
  const may = useCan("qr_orders");
  const wide = useHolds("all_outlets");
  /** The orders in flight, by id, so a second press on the same card waits for the first. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [pausing, setPausing] = useState(false);
  const [showDone, setShowDone] = useState(false);
  // The hours line reads the clock, so it is read again each minute: a screen left idle at the
  // counter still turns "open until 20:00" into closed at 20:00.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => { setNow(new Date()); }, 60_000);
    return () => { clearInterval(t); };
  }, []);

  // The queue is read as the screen opens, as well as by the shell, so a tab left open on it
  // after an outage has a way back that does not need a write to happen first.
  useEffect(() => { void load(); }, [load]);

  /** The outlet this session stands at, when it stands at one - the switch and the hours line are its. */
  const here: LocKey | null = LOC[user.loc]?.type === "Outlet" ? user.loc : null;
  const mine = orders.filter((o) => wide || o.loc === user.loc);
  const lane = (has: readonly QrOrderStatus[]) => mine.filter((o) => has.includes(o.status)).sort(oldestFirst);
  const done = mine.filter((o) => DONE.includes(o.status) && isToday(whenOf(o)))
    .sort((a, b) => oldestFirst(b, a));

  const move = async (o: QrOrder, to: QrOrderStatus) => {
    setBusy((b) => new Set(b).add(o.id));
    try { await step(o.id, to); }
    finally { setBusy((b) => { const n = new Set(b); n.delete(o.id); return n; }); }
  };
  const togglePause = async () => {
    if (!here) return;
    setPausing(true);
    try { await setPause(here, !paused[here]); } finally { setPausing(false); }
  };

  const status = here ? statusLine(paused[here] === true, hours.find((h) => h.loc === here)?.days ?? [], now) : null;

  const card = (o: QrOrder) => {
    const next = nextQrStep(o.mode, o.status);
    const label = next && STEP_LABEL[next];
    return (
      <div className={`kan-card qr-card${o.status === "Paid" ? " qr-new" : ""}`} key={o.id} data-order={o.id}>
        <div className="kan-top">
          <b className="mono">{o.id}</b>
          <span className="mono kan-t">{fromWireTime(whenOf(o))}</span>
        </div>
        <div className="kan-who">
          <b>{o.label}{(wide && o.loc !== user.loc) ? ` · ${locName(o.loc)}` : ""}</b>
          <span><Pill tone={o.mode === "pickup" ? "ac" : "in"}>{o.mode === "pickup" ? "Pickup" : `Deliver to ${o.spot || o.label}`}</Pill></span>
          <span>{o.name} · <a href={`tel:${o.phone}`} className="mono">{o.phone}</a></span>
        </div>
        <ul className="kan-items">
          {o.lines.map((l) => (
            <li key={l.it}>
              <span className="kan-q mono">{l.qty} ×</span>
              <span className="kan-nm">{user.r === "counter" && IT[l.it] ? counterNameOf(l.it) : l.name}</span>
            </li>
          ))}
        </ul>
        <div className="kan-foot">
          <span className="mini">{money(o.total)} · Paid online</span>
          {o.billNo && (
            <button type="button" className="qr-bill mono" aria-label={`Open bill ${o.billNo}`}
              onClick={() => openDrawer("cbill", o.billNo!)}>{o.billNo}</button>
          )}
          <div className="sp" />
          {o.refund && <RefundPill status={o.refund.status} />}
          {DONE.includes(o.status) && !o.refund && <Pill tone="mu">{o.status}</Pill>}
          {may && label && (
            <Btn size="xs" variant={o.status === "Paid" ? "solid" : "ok"} disabled={busy.has(o.id)}
              onClick={() => void move(o, next)}>{label}</Btn>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", here ? locName(here) : "Outlets", "QR orders"]}
        title="QR orders"
        tip="Orders customers placed and paid for online from a QR code at the outlet. The bill is already raised; make each order and move it along."
        readOnly={!may && "qr_orders"}
        actions={here && (
          <>
            <span className="mini">{paused[here] ? "Paused" : "Taking orders"}</span>
            <Locked f="qr_orders" locked={!may}>
              <Switch on={!paused[here]} label="QR ordering" disabled={!may || pausing} onChange={() => void togglePause()}
                tip={may ? "Switch off to pause QR ordering here - customers who scan are told to order at the counter until you switch it back on. Orders already paid stay in the queue." : undefined} />
            </Locked>
          </>
        )}
      />

      {status && <p className="mini" data-qr-status>{status}</p>}
      {failed && (
        <Alert tone="w" label="OUTAGE">The QR orders could not be read - the queue below may be out of date.</Alert>
      )}

      <div className="kan fill mtop">
        {LANES.map(({ title, tip, has }) => {
          const cards = lane(has);
          return (
            <section className="kan-col" key={title} aria-label={`${title} - ${cards.length} orders`}>
              <div className="kan-h">
                <b>{title}</b>
                <Tip text={tip} label={title} />
                <div className="sp" />
                <span className="kan-n">{cards.length}</span>
              </div>
              {cards.length === 0
                ? <div className="kan-empty"><b>Nothing here</b></div>
                : cards.map(card)}
            </section>
          );
        })}
      </div>

      <Card title={`Done today (${done.length})`} tip="Handed over, refunded or voided today, newest first." className="mtop"
        right={done.length > 0 && <Btn size="sm" variant="gh" onClick={() => setShowDone(!showDone)}>{showDone ? "Hide" : "Show"}</Btn>}>
        {done.length === 0
          ? <p className="mini">No QR order has been finished today.</p>
          : showDone && <div className="kan-col qr-done">{done.map(card)}</div>}
      </Card>
    </>
  );
}

/** The one line under the head: paused, open until when, or why not. */
function statusLine(isPaused: boolean, days: Parameters<typeof qrOpenAt>[0], now: Date): string {
  if (isPaused) return "QR ordering is paused at this counter.";
  const o = qrOpenAt(days, now);
  return o.open && o.today ? `QR ordering open until ${o.today.closes}.` : o.why ?? "QR ordering is closed.";
}
