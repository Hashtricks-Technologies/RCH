import { IT, LOC } from "../data/master";
import { U, fq } from "../lib/fmt";
import { Btn } from "./kit";
import type { Ticket } from "../types";

/**
 * The paper a collection ticket is read off at the window.
 *
 * Three screens raise or hand over tickets — the store's ticket drawer, the kitchen's, and the
 * issue desk's detail panel — and a store keeper standing at the window wants the ticket in his
 * hand, not on a screen behind him. `.print-slip` (the one `@media print` block at the end of
 * `styles.css`) is the only thing the paper carries; everything else on the page is hidden.
 *
 * The six digits are on it **only when this browser actually has them.** The server sends the
 * OTP to the collecting location's own screen and to nobody else, so the issuing desk reads `""`
 * — and a slip printed there says whose code it is rather than leaving a blank box that looks
 * like a fault.
 */
export function TicketSlip({ t }: { t: Ticket }) {
  return (
    <div className="print-slip" aria-hidden>
      <h2>{t.id}</h2>
      <div>{LOC[t.from]?.n ?? t.from} &rarr; {LOC[t.to]?.n ?? t.to}</div>
      <div>Against {t.req} · {t.st}</div>
      <div>
        {t.otp
          ? <>OTP <b>{t.otp}</b></>
          : <>OTP — the collector reads the code out at the window.</>}
      </div>
      <table>
        <thead>
          <tr><th>Item</th><th>Code</th><th className="r">Quantity</th><th>Unit</th></tr>
        </thead>
        <tbody>
          {t.lines.map((l, i) => (
            <tr key={l.it + i}>
              <td>{IT[l.it]?.n ?? l.it}</td>
              <td>{IT[l.it]?.c ?? ""}</td>
              <td className="r">{fq(l.qty, l.it)}</td>
              <td>{U(l.it)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="print-only">Received by ________________________</div>
    </div>
  );
}

/** The button that prints it. Screen-only, so it never lands on the paper it makes. */
export function PrintSlipBtn({ size = "xs" }: { size?: "xs" | "sm" }) {
  return (
    <span className="no-print">
      <Btn size={size} variant="gh" onClick={() => window.print()}>Print slip</Btn>
    </span>
  );
}
