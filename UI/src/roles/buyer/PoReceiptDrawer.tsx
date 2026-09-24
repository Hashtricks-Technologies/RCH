import { useState } from "react";
import { istDate, RECEIPT_TOLERANCE } from "@rch/domain";
import { IT } from "../../data/master";
import { vendorName } from "../../data/vendors";
import { useApp } from "../../store";
import { U, fq, money, unitTotal } from "../../lib/fmt";
import { canCloseShort, netReceived, round3, useCan } from "../../lib/selectors";
import {
  Alert, Btn, BtnRow, DataTable, DraftLineInput, Field, FormRow, Section, TableFoot,
} from "../../ui/kit";
import type { Row } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { GrnPdfButtons } from "../../ui/GrnPdf";
import { registerDrawer, type DrawerProps } from "../../drawers";
import type { ReceiptDoc, ReceiptLine } from "../../types";

const warn = { color: "var(--warn)" };

function PoReceiptDrawer({ id }: DrawerProps) {
  const s = useApp();
  const receive = useApp((x) => x.receivePo);
  const closeShort = useApp((x) => x.closePoShort);
  const close = useApp((x) => x.closeDrawer);
  const openDrawer = useApp((x) => x.openDrawer);
  const notify = useApp((x) => x.notify);
  const mayReceive = useCan("goods_receipt");
  const mayShort = useCan("purchase_orders");
  const po = s.po.find((x) => x.id === id);
  /** The hospital's own calendar date, not the host's: a batch that expires tomorrow morning IST
   *  is not expired because the browser is running somewhere still on yesterday. Read per render
   *  rather than at module load, so a window left open overnight does not keep yesterday's. */
  const today = istDate(new Date());

  const [doc, setDoc] = useState<ReceiptDoc>({ dc: "", invoice: "", invDate: "" });
  // recv defaults to the outstanding balance - this is one instalment, not the full order.
  // Whatever is rejected off it goes to quarantine rather than onto the shelf, so it is a
  // number the store keeper types here, not a placeholder.
  const [lines, setLines] = useState<ReceiptLine[]>(() =>
    (po?.lines ?? []).map((l) => ({
      recv: Math.max(0, round3(l.qty - netReceived(l))),
      rejected: 0,
      batch: "",
      mrp: IT[l.it]?.mrp ?? 0,
      mfg: "",
      exp: "",
    })));
  const [closingShort, setClosingShort] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const grns = s.grn.filter((g) => g.po === id);

  if (!po) {
    return (
      <DrawerFrame title="Purchase order not found" sub={id}>
        <div className="empty">
          <b>{id} is no longer on file</b>
          <p>It may have been cancelled or the id no longer matches a purchase order. Close this panel and refresh the list.</p>
        </div>
      </DrawerFrame>
    );
  }

  if (po.st === "Received" || po.st === "Cancelled") {
    return (
      <DrawerFrame title={po.id} sub={`${vendorName(s.vendors, po.vendor)} · ${po.st}`}>
        <Section title="Goods received" tip="GRNs booked against this order.">
          <DataTable
            cols={[
              { h: "GRN", cls: "nm", w: "18%" },
              { h: "Item", w: "22%" },
              { h: "Received", r: true },
              { h: "Batch" },
              { h: "Expiry" },
              { h: "Delivery note" },
            ]}
            rows={grns.map((g) => ({
              key: g.id,
              cells: [
                <>{g.id}<small>{g.by} · {g.at}</small></>,
                <>{IT[g.it]?.n ?? g.it}</>,
                <b>{fq(g.qty, g.it)}</b>,
                <span className="mono">{g.batch}</span>,
                <span className="mono">{g.exp}</span>,
                <>{g.dc}</>,
              ],
            }))}
            empty={{
              title: "No goods receipt on this order",
              sub: `It is ${po.st.toLowerCase()}, so nothing was booked in against it.`,
            }}
          />
          <TableFoot count={grns.length} />
          <GrnPdfButtons po={po} />
        </Section>
      </DrawerFrame>
    );
  }

  const at = (i: number, patch: Partial<ReceiptLine>) =>
    setLines((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  /**
   * What the screen already says in red, said once more where it can stop the write.
   *
   * Answers the sentence the store keeper should read, or `null` when there is nothing to say.
   * Every one of these is the server's refusal too - pressing anyway cost a round trip and an
   * error toast for something the drawer could already see.
   */
  const refusal = (): string | null => {
    if (!doc.dc.trim()) return "Nothing books in without the delivery note - record its number first.";
    if (lines.every((l) => l.recv <= 0)) {
      return "Nothing was received on any line. Enter what actually arrived, or close the order short.";
    }
    const named = (i: number) => IT[po.lines[i].it]?.n ?? po.lines[i].it;
    const over = lines.findIndex((l) => l.rejected > l.recv);
    if (over >= 0) return `${named(over)} - more was rejected than arrived on that line.`;
    const dated = lines.findIndex((l) => Boolean(l.exp && l.mfg && l.exp <= l.mfg));
    if (dated >= 0) return `${named(dated)} - the expiry falls on or before the manufacture date.`;
    return null;
  };

  /** Both doors carry a form - a delivery note and every batch on one, a reason on the other -
   *  so each waits for the server and closes only when it has taken it. A refused receipt
   *  leaves every batch number and date exactly where the store keeper typed it. */
  const book = async () => {
    if (busy) return;
    // Refused here rather than by greying the button out. These four read boxes that commit on
    // blur, and a disabled button never receives the press that would blur one - so a line the
    // store keeper had just corrected could not re-enable the button its old value disabled.
    // A refusal in this app is a sentence saying what was refused and why, not a dead control.
    const no = refusal();
    if (no) { notify(no); return; }
    setBusy(true);
    const ok = await receive(po.id, doc, lines);
    setBusy(false);
    // On to the order itself, where the new GRN is listed with its PDF to download.
    if (ok) openDrawer("bpo", po.id);
  };

  /**
   * Take whatever is being typed before the press is read.
   *
   * `mousedown` runs before `click` and before focus moves, so blurring here commits the box the
   * store keeper is still standing in - otherwise typing a quantity and going straight for the
   * button books the value the line held before they touched it. The refusals above are the net
   * underneath this, not a substitute for it.
   */
  const commitTyping = () => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement) el.blur();
  };
  const confirmShort = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await closeShort(po.id, reason);
    setBusy(false);
    if (ok) close();
  };

  /** What reaches the central store's shelf: what arrived, less what quality control turned
   *  away. The rejected balance is booked to quarantine instead, by the same receipt. */
  const good = po.lines.map((_l, i) => Math.max(
    0, netReceived({ recv: lines[i]?.recv ?? 0, rejected: lines[i]?.rejected ?? 0 }),
  ));
  const value = po.lines.reduce((t, l, i) => t + good[i] * l.rate, 0);
  /** What earlier instalments actually took in. A quantity sent to quarantine is still owed, so
   *  it is not counted here - which is also how the server reads the line (`netReceived`). */
  const already = po.lines.map((l) => netReceived(l));
  const balance = po.lines.map((l, i) => ({
    it: l.it,
    qty: Math.max(0, round3(l.qty - already[i] - good[i])),
  }));

  const qtyRows: Row[] = po.lines.map((l, i) => {
    const r = lines[i];
    return {
      key: "q" + l.it + i,
      cells: [
        <>{IT[l.it]?.n ?? l.it}<small>{IT[l.it]?.c ?? ""}</small></>,
        <>{fq(l.qty, l.it)} <span className="dim">{U(l.it)}</span></>,
        <>{fq(already[i], l.it)}</>,
        <>
          <DraftLineInput
            value={r.recv} min={0} step={U(l.it) === "nos" ? 1 : 0.001}
            ariaLabel={`Quantity received for ${IT[l.it]?.n ?? l.it}`}
            onCommit={(n) => at(i, { recv: Math.max(0, n) })}
          />
          {/* The same sum `checkReceiptLine` runs server-side: what earlier instalments accepted
              plus what is at the door now, against the ordered quantity and its tolerance. */}
          {round3(already[i] + r.recv) > round3(l.qty * RECEIPT_TOLERANCE) && (
            <div className="mini" style={warn}>over the ordered {fq(l.qty, l.it)} by more than 2%</div>
          )}
        </>,
        <>
          <DraftLineInput
            value={r.rejected} min={0} step={U(l.it) === "nos" ? 1 : 0.001}
            ariaLabel={`Quantity rejected for ${IT[l.it]?.n ?? l.it}`}
            onCommit={(n) => at(i, { rejected: Math.max(0, n) })}
          />
          {r.rejected > r.recv && (
            <div className="mini" style={warn}>more than arrived on this line</div>
          )}
        </>,
        <b>{fq(good[i], l.it)}</b>,
        <>{money(good[i] * l.rate)}</>,
      ],
    };
  });

  const batchRows: Row[] = po.lines.map((l, i) => {
    const r = lines[i];
    const priced = IT[l.it]?.mrp != null;
    return {
      key: "b" + l.it + i,
      cells: [
        <>{IT[l.it]?.n ?? l.it}<small>{IT[l.it]?.c ?? ""}</small></>,
        <input value={r.batch} placeholder="Batch or lot no."
          aria-label={`Batch number for ${IT[l.it]?.n ?? l.it}`}
          onChange={(e) => at(i, { batch: e.target.value })} />,
        priced
          ? <DraftLineInput
            value={r.mrp} min={0} step={0.01}
            ariaLabel={`Printed MRP for ${IT[l.it]?.n ?? l.it}`}
            onCommit={(n) => at(i, { mrp: Math.max(0, n) })}
          />
          : <span className="dim mini">Not printed</span>,
        <input type="date" value={r.mfg} aria-label={`Manufactured on for ${IT[l.it]?.n ?? l.it}`}
          onChange={(e) => at(i, { mfg: e.target.value })} />,
        <>
          <input type="date" value={r.exp} aria-label={`Expires on for ${IT[l.it]?.n ?? l.it}`}
            onChange={(e) => at(i, { exp: e.target.value })} />
          {r.exp && r.mfg && r.exp <= r.mfg && (
            <div className="mini" style={warn}>expiry falls on or before manufacture</div>
          )}
          {r.exp && r.exp < today && (
            <div className="mini" style={warn}>this batch has already expired</div>
          )}
        </>,
      ],
    };
  });

  return (
    <DrawerFrame
      title={`Receive ${po.id}`}
      sub={`${vendorName(s.vendors, po.vendor)} · ${po.st} · expected ${po.eta}`}
      foot={
        <>
          {mayShort && canCloseShort(po.st) && (
            <Btn variant="dg" onClick={() => setClosingShort(true)}>Close short</Btn>
          )}
          <div className="sp" />
          <Btn variant="gh" onClick={close}>Close</Btn>
          {/* The press commits whatever is still being typed before `book` reads the lines. */}
          {mayReceive && (
            <span onMouseDown={commitTyping}>
              <Btn variant="ok" disabled={busy} onClick={book}>
                {busy ? "Booking in…" : "Book into the central store"}
              </Btn>
            </span>
          )}
        </>
      }
    >
      <Section title="Delivery" tip="Record the vendor's paperwork before booking anything in.">
        <Alert tone="i" label="GOODS RECEIPT">
          Nothing enters stock without a batch behind it. Goods often arrive ahead of the invoice, so only the
          delivery note is required here - add the invoice once it turns up.
        </Alert>
        <FormRow cols="f3">
          <Field label="Delivery note" hint={!doc.dc.trim() ? "Required - nothing books in without it." : undefined}>
            <input value={doc.dc} aria-label="Delivery note number" placeholder="DC number"
              onChange={(e) => setDoc((d) => ({ ...d, dc: e.target.value }))} />
          </Field>
          <Field label="Invoice no.">
            <input value={doc.invoice} placeholder="Optional - add once it arrives"
              onChange={(e) => setDoc((d) => ({ ...d, invoice: e.target.value }))} />
          </Field>
          <Field label="Invoice date">
            <input type="date" value={doc.invDate}
              onChange={(e) => setDoc((d) => ({ ...d, invDate: e.target.value }))} />
          </Field>
        </FormRow>
      </Section>

      <Section title="Quantities" tip="Receiving now defaults to what's still outstanding on this order. What you reject goes to Quarantine instead of the shelf, and there is no way back out of it.">
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "20%" },
              { h: "Ordered", r: true },
              { h: "Already accepted", r: true, w: "14%" },
              { h: "Receiving now", r: true, w: "14%" },
              { h: "Rejected", r: true, w: "12%" },
              { h: "Into stock", r: true },
              { h: "Value", r: true },
            ]}
            rows={qtyRows}
            empty={{ title: "No items on this order", sub: "Nothing to receive." }}
          />
        </div>
        <TableFoot count={qtyRows.length} extra={<>{unitTotal(po.lines.map((l, i) => ({ it: l.it, qty: good[i] })))} into stock</>} />
        <div className="totrow big"><span>Value received</span><span>{money(value)}</span></div>
        <div className="totrow"><span>Balance outstanding</span><span>{unitTotal(balance)}</span></div>
      </Section>

      <Section title="Batch and dates" tip="Printed MRP is captured only for items that carry one on the pack.">
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "22%" },
              { h: "Batch or lot", w: "18%" },
              { h: "Printed MRP", w: "14%" },
              { h: "Manufactured", w: "18%" },
              { h: "Expires", w: "20%" },
            ]}
            rows={batchRows}
            empty={{ title: "No items on this order", sub: "Nothing to receive." }}
          />
        </div>
      </Section>

      {grns.length > 0 && (
        <Section title="Delivered so far" tip="Every delivery already booked against this order, as its goods receipt note.">
          <GrnPdfButtons po={po} />
        </Section>
      )}

      {closingShort && (
        <Section title="Close this order short" sub="A reason is required - the undelivered balance returns to the procurement list.">
          <Field label="Reason">
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="Why the balance is not coming…" />
          </Field>
          <BtnRow end>
            <Btn variant="gh" onClick={() => { setClosingShort(false); setReason(""); }}>Never mind</Btn>
            <Btn variant="dg" disabled={busy} onClick={confirmShort}>
              {busy ? "Closing…" : "Confirm close short"}
            </Btn>
          </BtnRow>
        </Section>
      )}
    </DrawerFrame>
  );
}

registerDrawer("bgrn", PoReceiptDrawer);
