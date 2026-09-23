import { useState } from "react";
import { create } from "zustand";
import { downloadTicketPdf, ticketReceipt } from "../lib/pdf";
import { locName } from "../lib/selectors";
import { useApp } from "../store";
import { Btn, Tip } from "./kit";
import type { Ticket, Trailed } from "../types";

/**
 * Whether the six digits go on the paper. One switch for the slip and the PDF, and for every
 * ticket drawer, because the checkbox sits in the drawer's header and the slip at its foot.
 * Defaults to on: a collector's own copy is what the code is for. It only ever matters where
 * this browser holds the code - the server sends it to the collecting location alone.
 */
const useSlipOtp = create<{ on: boolean; set: (on: boolean) => void }>((set) => ({ on: true, set: (on) => set({ on }) }));

/**
 * The paper a collection ticket is read off at the window, laid out as an 80 mm receipt.
 *
 * Three screens raise or hand over tickets - the store's ticket drawer, the kitchen's, the
 * issue desk's detail panel - and the counter's collects them; whoever stands at the window
 * wants the ticket in hand, not on a screen behind them. `.print-slip` (the `@media print`
 * block at the end of `styles.css`) is the only thing the paper carries. The PDF is drawn
 * from the same `ticketReceipt` model, so the two cannot disagree.
 *
 * The six digits are on it **only when this browser actually has them** and "Include OTP" is
 * ticked. The issuing desk reads `""`, and a slip printed there says whose code it is rather
 * than leaving a blank box that looks like a fault.
 */
export function TicketSlip({ t }: { t: Ticket | Trailed<Ticket> }) {
  const on = useSlipOtp((x) => x.on);
  const r = ticketReceipt(t, on);
  return (
    <div className="print-slip receipt" aria-hidden>
      <div className="rc-c"><b>Royal Care Hospital</b><div className="rc-s">Stock collection ticket</div></div>
      <hr />
      <h2 className="rc-c">{r.id}</h2>
      <div className="rc-c"><b>{r.from} &rarr; {r.to}</b></div>
      <hr />
      <dl>
        <dt>Against</dt><dd>{r.req}</dd>
        <dt>Status</dt><dd>{r.st}</dd>
        {r.issued && <><dt>Issued</dt><dd>{r.issued}</dd></>}
        {r.collected && <><dt>Collected</dt><dd>{r.collected}</dd></>}
        {r.received && <><dt>Received</dt><dd>{r.received}</dd></>}
      </dl>
      <table>
        <thead>
          <tr><th>Item</th><th className="r">Qty</th></tr>
        </thead>
        <tbody>
          {/* Paper with an empty table on it reads as a printing fault. A ticket with no line
              is not one the store keeper should hand anything over against, and the slip has
              to say so rather than leave the collector to work it out. */}
          {r.lines.length === 0 ? (
            <tr><td colSpan={2}>No item on this ticket - nothing is to be collected against it.</td></tr>
          ) : r.lines.map((l, i) => (
            <tr key={l.name + i}>
              <td>{l.name}{l.code && <div className="rc-s">{l.code}</div>}</td>
              <td className="r"><b>{l.qty}</b> {l.unit}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><th>Total</th><th className="r">{r.total}</th></tr>
        </tfoot>
      </table>
      <div className="rc-c rc-otp">
        {r.otp
          ? <>Collection OTP<b>{r.otp}</b></>
          : <>OTP - the collector reads the code out at the window.</>}
      </div>
      <div className="rc-sign">Received by ________________________</div>
      <div className="rc-sign">Name / Emp no. _____________________</div>
    </div>
  );
}

/**
 * Print, download, and whether the code goes on either. Screen-only, so none of it lands on
 * the paper it makes. Where this browser does not hold the code the box is shown switched off,
 * with the reason on its tip, rather than vanishing and leaving the operator to wonder.
 */
export function PrintSlipBtn({ t, size = "xs" }: { t: Ticket | Trailed<Ticket>; size?: "xs" | "sm" }) {
  const { on, set } = useSlipOtp();
  const notify = useApp((x) => x.notify);
  const [busy, setBusy] = useState(false);
  const held = Boolean(t.otp);
  const download = async () => {
    setBusy(true);
    // The PDF writer is fetched at the press, so a dropped connection is a real way for it to fail.
    try { await downloadTicketPdf(t, on); } catch { notify("Could not prepare the PDF - check the connection and try again."); }
    setBusy(false);
  };
  return (
    <span className="no-print slip-ctl">
      <label className="mini">
        <input type="checkbox" checked={held && on} disabled={!held} onChange={(e) => set(e.target.checked)} />
        {" "}Include OTP
      </label>
      {!held && <Tip text={`${locName(t.to)} holds the six digits - only its screen is sent the code, so it cannot go on a copy printed here.`} label="About Include OTP" />}
      <Btn size={size} variant="gh" onClick={() => window.print()}>Print slip</Btn>
      <Btn size={size} variant="gh" disabled={busy} onClick={download}>{busy ? "Preparing…" : "Download PDF"}</Btn>
    </span>
  );
}
