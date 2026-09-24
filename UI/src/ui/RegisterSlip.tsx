import { locName } from "../lib/selectors";
import { fromWireDay, fromWireTime, money } from "../lib/fmt";
import type { ReactNode } from "react";
import type { RegisterReport } from "../types";

/**
 * The paper a register reading is torn off on - the X the counter takes mid-shift and the Z that
 * settles the day. Shared by the counter's Register screen and the manager's, which is why it
 * sits in `ui/` rather than in either role folder.
 *
 * It reads in the order the hospital's own till report reads, because the people checking it
 * have been reading that one for years and go down it with a finger: what was sold, what was
 * collected, what came in against earlier bills, the tax, then the totals. `.print-slip` (the
 * one `@media print` block in `styles.css`) is the only thing that reaches the paper.
 *
 * Seven lines on it are always zero today - tip, parcel, delivery and additional charges,
 * complimentary, and the two un-collected lines. They are printed as `0.00` rather than left
 * out **on purpose**: the slip has to line up with the one already in the counter's hand, and a
 * line that appears the day the system starts producing a figure for it is a line somebody has
 * to notice. `oldBills` is money taken in this session against bills from an earlier one, so it
 * is shown apart from the sale figures and is never added into nett sales.
 */
export function RegisterSlip({ r, countedCash, place }: {
  r: RegisterReport; countedCash?: number;
  /** The outlet's name, where the location master is not loaded - the super admin's session
   *  reads no snapshot, so `locName` would print the bare key. */
  place?: string;
}) {
  const t = r.totals;
  // What the drawer itself should hold: the cash tender, not the takings. Card, UPI and anything
  // charged to an account never reach it, which is the whole point of counting it separately.
  const cash = t.tenders.find((x) => x.tender === "Cash")?.amount ?? 0;
  const counted = countedCash ?? null;
  return (
    <div className="print-slip" aria-hidden>
      <h2>{r.kind === "Z" ? "Z-report" : "X-report"} - {place ?? locName(r.loc)}</h2>
      <div>
        {r.kind === "Z"
          ? <>Z number <b>{r.zNo ?? "-"}</b> - this session is closed.</>
          : <>Interim reading - the register stays open and nothing here is settled.</>}
      </div>
      <div>Session {r.sessionId}{r.previousZNo ? ` - follows ${r.previousZNo}` : " - first session at this outlet"}</div>
      <div>Opened {stamp(r.openedAt)}</div>
      <div>{r.kind === "Z" && r.closedAt ? <>Closed {stamp(r.closedAt)}</> : <>Read {stamp(r.takenAt)}</>}</div>
      <div>Taken by {r.takenBy}</div>

      <table>
        <thead><tr><th>Sales</th><th className="r">Amount</th></tr></thead>
        <tbody>
          <Money l="Gross sales" v={t.grossSales} />
          <Money l="Discount" v={t.discount} />
          <Money l="Complimentary" v={t.complimentary} />
          <Money l="Tip" v={t.tip} />
          <Money l="Parcel charge" v={t.parcelCharge} />
          <Money l="Delivery charge" v={t.deliveryCharge} />
          <Money l="Additional charge" v={t.additionalCharge} />
          <Money l="Nett sales" v={t.nettSales} bold />
          <Money l="Credit sales" v={t.creditSales} />
          <Money l="Un-collected" v={t.unCollected} />
          <Money l="Un-collected discount" v={t.unCollectedDiscount} />
          <Row l={`Voided (${t.voidBills} bill${t.voidBills === 1 ? "" : "s"})`} v={money(t.voidAmount)} />
        </tbody>
      </table>

      <table>
        <thead><tr><th>Collections</th><th className="r">Bills</th><th className="r">Amount</th></tr></thead>
        <tbody>
          {t.tenders.length === 0 ? (
            <tr><td colSpan={3}>Nothing was collected in this session.</td></tr>
          ) : t.tenders.map((x) => (
            <tr key={x.tender}>
              <td>{x.tender}</td><td className="r">{x.bills}</td><td className="r">{money(x.amount)}</td>
            </tr>
          ))}
          <tr><td><b>Total collected</b></td><td className="r" /><td className="r"><b>{money(t.collected)}</b></td></tr>
        </tbody>
      </table>

      <table>
        <thead><tr><th>Old bills</th><th className="r">Amount</th></tr></thead>
        <tbody>
          {t.oldBills.length === 0 ? (
            <tr><td colSpan={2}>No earlier bill was settled in this session.</td></tr>
          ) : t.oldBills.map((o) => (
            <tr key={o.mode}><td>{o.mode}</td><td className="r">{money(o.amount)}</td></tr>
          ))}
          <Money l="Old bills total" v={t.oldBillsTotal} bold />
        </tbody>
      </table>
      <div>Old bills are collected against earlier sessions and are not part of nett sales.</div>

      <table>
        <thead><tr><th>Tax</th><th className="r">Amount</th></tr></thead>
        <tbody>
          <Money l="SGST" v={t.sgst} />
          <Money l="CGST" v={t.cgst} />
          <Money l="Total tax" v={t.taxTotal} bold />
        </tbody>
      </table>

      <table>
        <thead><tr><th>Totals</th><th className="r">Amount</th></tr></thead>
        <tbody>
          <Row l="Bills" v={String(t.billCount)} />
          <Money l="Nett sales" v={t.nettSales} bold />
          <Money l="Collected" v={t.collected} />
          <Money l="Old bills collected" v={t.oldBillsTotal} />
          <Money l="Cash the till took" v={cash} />
          {counted === null ? (
            <tr><td>Counted cash</td><td className="r">not counted</td></tr>
          ) : (
            <>
              <Money l="Counted cash" v={counted} />
              <Row l="Over / short" v={diff(counted - cash)} />
            </>
          )}
        </tbody>
      </table>

      <div className="print-only">
        Counter ________________________ &nbsp; Manager ________________________
      </div>
    </div>
  );
}

/** The hospital's day and clock for an instant, never the host's. */
const stamp = (iso: string) => `${fromWireDay(iso)} ${fromWireTime(iso)}`;
/** A drawer difference reads as a direction, not a signed number: "₹120.00 over" is what the
 *  person counting the notes says out loud, and "-₹120.00" is what they have to translate. */
const diff = (v: number) => (v === 0 ? "exact" : `${money(Math.abs(v))} ${v > 0 ? "over" : "short"}`);

const Row = ({ l, v }: { l: ReactNode; v: ReactNode }) => (
  <tr><td>{l}</td><td className="r">{v}</td></tr>
);
const Money = ({ l, v, bold }: { l: string; v: number; bold?: boolean }) => (
  <Row l={bold ? <b>{l}</b> : l} v={bold ? <b>{money(v)}</b> : money(v)} />
);
