import { useState } from "react";
import { counterName } from "@rch/domain";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { fromWireDay, money } from "../../lib/fmt";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import { Alert, Avatar, Btn, DataTable, Field, Pill, Section } from "../../ui/kit";
import { billStatus, voidableToday } from "./status";
import type { Bill, Dated } from "../../types";

/**
 * The paper a bill is handed over on.
 *
 * "Pay & print" and "Reprint" both printed nothing - there was no `window.print()` in the app
 * and no paper for one to put on a printer, so a counter that had taken money had no receipt
 * to give. `.print-slip` (the one `@media print` block at the end of `styles.css`) is the only
 * thing that reaches the page; the drawer, the shell and every button on them are hidden.
 *
 * Not a second rendering of the same numbers for its own sake: a screen is laid out for a
 * 720 px panel with its own scrollbar, and what a customer needs on 80 mm of till roll is the
 * number, the counter, the time, the lines and what was paid - in that order and nothing else.
 */
function BillSlip({ bill }: { bill: Dated<Bill> }) {
  const L = LOC[bill.loc];
  const taxable = bill.tot - bill.tax;
  return (
    <div className="print-slip" aria-hidden>
      <h2>{bill.no}</h2>
      <div>Royal Care Hospital · {L?.n ?? bill.loc} · {L?.c ?? ""}</div>
      {/* The hospital's calendar day, not the host's and not the raw instant:
          `fromWireDate` is `dmy`, which only parses "YYYY-MM-DD". */}
      <div>{fromWireDay(bill.iso)} {bill.t} · {bill.opr}</div>
      {/* A voided bill can still be reprinted - the paper has to say it is not a receipt. */}
      {bill.voided && <div><b>VOIDED - {bill.voidReason || "no reason recorded"}</b></div>}
      <table>
        <thead>
          <tr><th>Item</th><th className="r">Qty</th><th className="r">Rate</th><th className="r">Amount</th></tr>
        </thead>
        <tbody>
          {bill.lines.length === 0 ? (
            <tr><td colSpan={4}>No item on this bill.</td></tr>
          ) : bill.lines.map((l, i) => (
            <tr key={l.it + i}>
              <td>{IT[l.it]?.n ?? l.it}</td>
              <td className="r">{l.qty}</td>
              <td className="r">{money(l.rate)}</td>
              <td className="r">{money(l.rate * l.qty)}</td>
            </tr>
          ))}
          {/* The concession is on the paper where there was one: `rate` above is the printed
              price, so without these two rows the lines would not add up to the total and the
              customer would have no way to see what they were given. `tot` is the net, and
              gross is `tot + disc` - the same two numbers the server stores. */}
          {bill.disc ? (
            <>
              <tr><td colSpan={3}>Gross</td><td className="r">{money(bill.tot + bill.disc)}</td></tr>
              <tr><td colSpan={3}>Discount {bill.discPct ? `(${bill.discPct}%)` : ""}</td><td className="r">-{money(bill.disc)}</td></tr>
            </>
          ) : null}
          <tr><td colSpan={3}>Taxable value</td><td className="r">{money(taxable)}</td></tr>
          <tr><td colSpan={3}>CGST + SGST</td><td className="r">{money(bill.tax)}</td></tr>
          <tr><td colSpan={3}><b>Total</b></td><td className="r"><b>{money(bill.tot)}</b></td></tr>
        </tbody>
      </table>
      <div>Paid by {bill.pay}{bill.payer ? ` · posted to ${bill.payer.name} (${bill.payer.id})` : ""}</div>
      {(bill.customerName || bill.customerPhone) && (
        <div>Customer {[bill.customerName, bill.customerPhone].filter(Boolean).join(" · ")}</div>
      )}
      <div className="print-only">
        GSTIN 33AACCR1234F1ZP · computer generated from terminal {L?.c ?? bill.loc} · prices are GST inclusive
      </div>
    </div>
  );
}

function BillDrawer({ id }: DrawerProps) {
  const bills = useApp((s) => s.bills);
  const close = useApp((s) => s.closeDrawer);
  // ---- bill void: the manager's own door, and nobody else's. The counter reads this drawer too.
  const user = useApp((s) => s.user);
  const voidBill = useApp((s) => s.voidBill);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const bill = bills.find((b) => b.no === id);
  // The counter reads its own till's names on screen; the manager and the paper read the real one.
  const nameOf = (it: string) => (IT[it] ? (user?.r === "counter" ? counterName(IT[it]) : IT[it].n) : it);

  if (!bill) {
    return (
      <DrawerFrame title="Bill not found" sub={id}>
        <p className="mini">This bill is no longer on this terminal. Reload the till and try again.</p>
      </DrawerFrame>
    );
  }

  const L = LOC[bill.loc];
  const st = billStatus(bill.pay);
  const taxable = bill.tot - bill.tax;
  // ---- bill void: same hospital day, not already taken back, and the manager alone. The
  // server refuses all three again on its own read - this only decides whether to offer.
  const canVoid = user?.r === "manager" && voidableToday(bill);
  const doVoid = async () => {
    setBusy(true);
    const ok = await voidBill(bill.no, reason);
    setBusy(false);
    // A refusal leaves the reason where it was typed; only a void that landed clears it.
    if (ok) { setReason(""); close(); }
  };

  return (
    <DrawerFrame
      title={<span className="mono">{bill.no}</span>}
      sub={`${L.n} · ${bill.t} · ${bill.pay}`}
      foot={<>
        <Btn variant="gh" onClick={close}>Close</Btn>
        <div className="sp" />
        {canVoid && <Btn variant="dg" disabled={busy || !reason.trim()} onClick={doVoid}>Void bill</Btn>}
        {/* It prints. It used to toast that it had been "sent again to the OT-C3 printer",
            which was a sentence about something that never happened. */}
        <Btn onClick={() => window.print()}>Reprint</Btn>
      </>}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <Avatar name={bill.opr} color={bill.oprCol} size={38} />
        <div>
          <b style={{ fontSize: 13 }}>{bill.opr}</b>
          <div className="mini">Counter Operator · raised this bill at {bill.t}</div>
        </div>
        <div className="sp" />
        {bill.voided ? <Pill tone="cr">VOIDED</Pill> : <Pill tone={st.tone}>{st.label}</Pill>}
      </div>

      {/* ---- bill void ---- */}
      {bill.voided && (
        <Alert tone="w" label="This bill was voided">
          {bill.voidReason || "No reason was recorded."} The stock went back on the shelf it came off,
          and the amount is out of the day's takings.
        </Alert>
      )}
      {canVoid && (
        <Field label="Void this bill" tip="Same-day only. The lines go back on the shelf and the amount leaves the day's takings; the bill stays on the list, badged.">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this bill being voided?"
            maxLength={500}
          />
        </Field>
      )}

      <dl className="dl">
        <dt>Outlet</dt><dd>{L.n} <span className="mini">({L.c})</span></dd>
        <dt>Terminal</dt><dd className="mono">{L.c}</dd>
        <dt>Cost centre</dt><dd className="mono">{L.cc}</dd>
        <dt>Time</dt><dd className="mono">{bill.t}</dd>
        <dt>Tender</dt><dd>{bill.pay}</dd>
        {bill.payer && <><dt>Posted to</dt><dd>{bill.payer.name} <span className="mini mono">({bill.payer.id})</span></dd></>}
        {bill.customerName && <><dt>Customer</dt><dd>{bill.customerName}</dd></>}
        {bill.customerPhone && <><dt>Phone</dt><dd className="mono">{bill.customerPhone}</dd></>}
      </dl>

      <Section title="Items on this bill" sub={`${bill.lines.length} item${bill.lines.length === 1 ? "" : "s"} · rates are GST inclusive`} />
      <DataTable
        cols={[
          { h: "Item", cls: "nm", w: "34%" },
          { h: "Code", w: "16%" },
          { h: "Qty", r: true, w: "10%" },
          { h: "Rate", r: true, w: "13%" },
          { h: "GST %", r: true, w: "11%" },
          { h: "Amount", r: true, w: "16%" },
        ]}
        rows={bill.lines.map((l) => ({
          key: l.it,
          cells: [
            nameOf(l.it),
            <span className="mono">{IT[l.it]?.c ?? "-"}</span>,
            l.qty,
            money(l.rate),
            (IT[l.it]?.gst ?? 0) + "%",
            money(l.rate * l.qty),
          ],
        }))}
        empty={{ title: "This bill carries no item" }}
      />

      <div className="mtop">
        {/* The same two rows the slip carries, for the same reason: the lines are priced at the
            printed rate, so without them nothing on this screen explains the total. */}
        {bill.disc ? (
          <>
            <div className="totrow"><span>Gross</span><span>{money(bill.tot + bill.disc)}</span></div>
            <div className="totrow">
              <span>Discount{bill.discPct ? ` (${bill.discPct}%)` : ""}</span>
              <span style={{ color: "var(--ok)" }}>-{money(bill.disc)}</span>
            </div>
          </>
        ) : null}
        <div className="totrow"><span>Taxable value</span><span>{money(taxable)}</span></div>
        <div className="totrow"><span>CGST</span><span>{money(bill.tax / 2)}</span></div>
        <div className="totrow"><span>SGST</span><span>{money(bill.tax / 2)}</span></div>
        <div className="totrow big"><span>Grand total</span><span>{money(bill.tot)}</span></div>
      </div>
      <p className="mini mtop">
        Royal Care Hospital · GSTIN 33AACCR1234F1ZP · this is a computer generated bill from terminal {L.c}.
      </p>

      <BillSlip bill={bill} />
    </DrawerFrame>
  );
}

registerDrawer("cbill", BillDrawer);
