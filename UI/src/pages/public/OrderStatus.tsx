import { useEffect, useMemo } from "react";
import { dmy, istDate, money, QR_STATUS_WORDS, qrStepsFor } from "@rch/domain";
import type { PublicQrOrder, QrOrderStatus } from "@rch/contract";
import { fromWireTime } from "../../lib/fmt";
import { menuPath, secretFromHash } from "../../lib/orderPath";
import { go, recall, remember, usePublicOrder } from "../../store/publicOrder";
import { Dead, Spinner } from "./parts";

/** An instant as the hospital reads it: "24-Sep-2026, 14:05" in Asia/Kolkata. */
export const istStamp = (iso: string): string => `${dmy(istDate(new Date(iso)))}, ${fromWireTime(iso)}`;

/** Where the order ends up, in the customer's words. */
export function whereWords(o: PublicQrOrder): string {
  if (o.mode === "deliver") return `We'll bring it to ${o.spot ? `${o.spot}, ` : ""}${o.label}.`;
  return `Collect it at the ${o.outletName} counter - show this order number.`;
}

/** What happens to the money on an order that will not be filled. */
export function refundWords(o: PublicQrOrder): string | null {
  if (o.status === "Expired") return "Nothing was charged. If money did leave your account, it is refunded automatically.";
  if (o.status !== "Refunded" && o.status !== "Voided") return null;
  const r = o.refund;
  const amount = money(r?.amount ?? o.total);
  if (r?.status === "Processed") return `${amount} has been refunded to the account you paid from. Banks can take 5-7 working days to show it.`;
  if (r?.status === "Failed") return `Your refund of ${amount} needs a second try by the outlet. Show this page at the ${o.outletName} counter and they will sort it out.`;
  return `A refund of ${amount} is on its way to the account you paid from. Banks can take 5-7 working days to show it.`;
}

/** The order number, the last part set large: it is what the counter calls out. */
function OrderNo({ id }: { id: string }) {
  const cut = id.lastIndexOf("-");
  return (
    <p className="qo-no" aria-label={`Order number ${id}`}>
      <span aria-hidden="true">{cut > 0 ? id.slice(0, cut + 1) : ""}</span>
      <strong aria-hidden="true">{cut > 0 ? id.slice(cut + 1) : id}</strong>
    </p>
  );
}

function Steps({ order }: { order: PublicQrOrder }) {
  const steps: QrOrderStatus[] = order.steps.length ? order.steps : qrStepsFor(order.mode);
  const at = steps.indexOf(order.status);
  return (
    <ol className="qo-steps">
      {steps.map((s, i) => (
        <li key={s} className={i < at ? "is-done" : i === at ? "is-now" : ""} aria-current={i === at ? "step" : undefined}>
          <span className="qo-dot" aria-hidden="true" />
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}

function Receipt({ order }: { order: PublicQrOrder }) {
  const gross = order.total + order.discount;
  return (
    <section className="qo-card qo-receipt" aria-labelledby="qo-rcpt">
      <div className="qo-rcpt-head">
        <h2 id="qo-rcpt">Receipt</h2>
        <button type="button" className="qo-btn qo-btn-quiet no-print" onClick={() => { window.print(); }}>Print</button>
      </div>
      <p className="qo-rcpt-meta">
        <span>{order.outletName}</span>
        {order.billNo && <span>Bill {order.billNo}</span>}
        <span>{istStamp(order.paidAt ?? order.at)}</span>
      </p>
      <table className="qo-rcpt-lines">
        <thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Amount</th></tr></thead>
        <tbody>
          {order.lines.map((l) => (
            <tr key={l.it}>
              <td>{l.name}<small>{money(l.rate)} each</small></td>
              <td>{l.qty}</td>
              <td>{money(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="qo-rcpt-sum">
        {order.discount > 0 && <><dt>Subtotal</dt><dd>{money(gross)}</dd><dt>Discount</dt><dd>−{money(order.discount)}</dd></>}
        <dt>GST included</dt><dd>{money(order.tax)}</dd>
        <dt className="qo-rcpt-total">Total</dt><dd className="qo-rcpt-total">{money(order.total)}</dd>
      </dl>
      {order.paidAt && (
        <p className="qo-paid">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
          Paid online
        </p>
      )}
    </section>
  );
}

/**
 * One order's status and e-receipt. The key comes from the fragment (`#k=`), or failing that from
 * this phone's own record of the order it placed, and the page asks again every few seconds while
 * it is on screen (`poll` in the store) until the order reaches the end of its path - still once a
 * minute for two hours after hand-over, and every 15 s while a refund is on its way (`pollDelay`).
 */
export default function OrderStatus({ token, id, hash }: { token: string; id: string; hash: string }) {
  const secret = useMemo(() => secretFromHash(hash) ?? recall(id), [hash, id]);
  const order = usePublicOrder((s) => (s.order?.id === id ? s.order : null));
  const orderState = usePublicOrder((s) => s.orderState);
  const stale = usePublicOrder((s) => s.stale);
  const statusNote = usePublicOrder((s) => s.statusNote);
  const poll = usePublicOrder((s) => s.poll);

  useEffect(() => {
    if (!secret) return;
    remember({ orderId: id, secret, token });
    return poll(id, secret);
  }, [id, secret, token, poll]);
  useEffect(() => { document.title = `Order ${id}`; }, [id]);

  if (!secret) return <Dead title="This order link is incomplete" body="Open the link from the phone you ordered on, or ask at the counter with your order number." />;
  if (orderState === "missing") return <Dead title="Order not found" body="This link does not match an order. Ask at the counter with your order number." />;
  if (!order) {
    if (orderState === "error") return <Dead title="Could not load your order" body="Check your connection - this page tries again when you reload it." />;
    return (
      <main className="qo-col qo-status" aria-busy="true">
        <span className="qo-sr" role="status">Loading your order…</span>
        <span className="qo-sk qo-sk-ticket" aria-hidden="true" />
        <span className="qo-sk qo-sk-card" aria-hidden="true" />
      </main>
    );
  }

  const refund = refundWords(order);
  const onPath = order.steps.includes(order.status) || qrStepsFor(order.mode).includes(order.status);
  return (
    <main className="qo-col qo-status">
      <section className={`qo-ticket${refund ? " is-off" : ""}`} aria-labelledby="qo-ticket-h">
        <h1 id="qo-ticket-h">Your order</h1>
        <OrderNo id={order.id} />
        <div className="qo-tear" aria-hidden="true" />
        <p className="qo-status-words" aria-live="polite" role="status">
          {order.status === "Awaiting payment" && <Spinner />}
          {QR_STATUS_WORDS[order.status]}
        </p>
        {!refund && <p className="qo-where-words">{whereWords(order)}</p>}
      </section>
      {statusNote && order.status === "Awaiting payment" && <p className="qo-note" role="status">{statusNote}</p>}
      {stale && <p className="qo-note">Could not refresh just now - showing the last update.</p>}
      {refund && <p className="qo-banner qo-banner-refund" role="status">{refund}</p>}
      {onPath && <Steps order={order} />}
      {order.lines.length > 0 && order.status !== "Awaiting payment" && order.status !== "Expired" && <Receipt order={order} />}
      <p className="qo-more no-print">
        <a href={menuPath(token)} onClick={(e) => { e.preventDefault(); go(menuPath(token)); }}>Order something else</a>
      </p>
    </main>
  );
}
