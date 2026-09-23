import { locName } from "../lib/selectors";
import { fromWireDay, fromWireTime, money } from "../lib/fmt";
import type { ShiftReport } from "../types";

/**
 * The paper a counter operator hands over at the end of a shift: their own bills at their
 * counter, from the moment they signed in there to the moment they closed it - per tender, then
 * the totals. Amounts billed only; nobody counts a drawer on it. Shared by the counter's Close
 * Shift dialog and the manager's Shift reports card.
 */
export function ShiftSlip({ r }: { r: ShiftReport }) {
  const t = r.totals;
  return (
    <div className="print-slip shift-slip" aria-hidden>
      <h2>Shift report - {locName(r.loc)}</h2>
      <div>
        {r.closedAt
          ? <>Shift <b>{r.id}</b> - closed{r.auto ? " automatically, at a sign-in at another counter" : ""}.</>
          : <>Shift <b>{r.id}</b> - interim reading; the shift is still open.</>}
      </div>
      <div>Operator {r.operator}</div>
      <div>Opened {stamp(r.openedAt)}</div>
      <div>{r.closedAt ? <>Closed {stamp(r.closedAt)}</> : <>Read {stamp(r.takenAt)}</>}</div>

      <table>
        <thead><tr><th>Tender</th><th className="r">Bills</th><th className="r">Amount</th></tr></thead>
        <tbody>
          {t.tenders.map((x) => (
            <tr key={x.tender}><td>{x.tender}</td><td className="r">{x.bills}</td><td className="r">{money(x.amount)}</td></tr>
          ))}
          <tr><td><b>Total billed</b></td><td className="r"><b>{t.billCount}</b></td><td className="r"><b>{money(t.nettSales)}</b></td></tr>
        </tbody>
      </table>

      <table>
        <tbody>
          <tr><td>Gross</td><td className="r">{money(t.grossSales)}</td></tr>
          <tr><td>Discount</td><td className="r">{money(t.discount)}</td></tr>
          <tr><td><b>Nett</b></td><td className="r"><b>{money(t.nettSales)}</b></td></tr>
          <tr><td>Collected (cash, UPI, card)</td><td className="r">{money(t.collected)}</td></tr>
          <tr><td>Charged to accounts</td><td className="r">{money(t.creditSales)}</td></tr>
          <tr><td>Tax</td><td className="r">{money(t.taxTotal)}</td></tr>
          <tr><td>Voided ({t.voidBills} bill{t.voidBills === 1 ? "" : "s"})</td><td className="r">{money(t.voidAmount)}</td></tr>
        </tbody>
      </table>
      <div className="print-only">Signature ______________________</div>
    </div>
  );
}

/** Print the shift slip on the page and nothing else, even over a page with a slip of its own. */
export function printShiftSlip(): void {
  document.body.classList.add("print-shift");
  window.print();
  document.body.classList.remove("print-shift");
}

/** The hospital's day and clock for an instant, never the host's. */
export const stamp = (iso: string) => `${fromWireDay(iso)} ${fromWireTime(iso)}`;
