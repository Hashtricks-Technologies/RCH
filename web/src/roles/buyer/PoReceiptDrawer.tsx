import { useState } from "react";
import { IT } from "../../data/master";
import { vendorName } from "../../data/vendors";
import { useApp } from "../../store";
import { U, fq, money, unitTotal } from "../../lib/fmt";
import { Alert, Btn, BtnRow, DataTable, Field, FormRow, Section, TableFoot } from "../../ui/kit";
import type { Row } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import type { ReceiptDoc, ReceiptLine } from "../../types";

const num = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const today = () => new Date().toISOString().slice(0, 10);
const warn = { color: "var(--warn)" };

function PoReceiptDrawer({ id }: DrawerProps) {
  const s = useApp();
  const receive = useApp((x) => x.receivePo);
  const closeShort = useApp((x) => x.closePoShort);
  const close = useApp((x) => x.closeDrawer);
  const po = s.po.find((x) => x.id === id);

  const [doc, setDoc] = useState<ReceiptDoc>({ dc: "", invoice: "", invDate: "" });
  // recv defaults to the outstanding balance — this is one instalment, not the full order.
  const [lines, setLines] = useState<ReceiptLine[]>(() =>
    (po?.lines ?? []).map((l) => ({
      recv: Math.round(Math.max(0, l.qty - l.recv) * 1000) / 1000,
      rejected: 0,
      batch: "",
      mrp: IT[l.it]?.mrp ?? 0,
      mfg: "",
      exp: "",
    })));
  const [closingShort, setClosingShort] = useState(false);
  const [reason, setReason] = useState("");

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
        <Section title="Goods received" sub="GRNs booked against this order.">
          <DataTable
            cols={[
              { h: "GRN", cls: "nm", w: "16%" },
              { h: "Item", w: "20%" },
              { h: "Accepted", r: true },
              { h: "Rejected", r: true },
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
                <>{g.rejected > 0 ? fq(g.rejected, g.it) : <span className="dim">{fq(0, g.it)}</span>}</>,
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
        </Section>
      </DrawerFrame>
    );
  }

  const at = (i: number, patch: Partial<ReceiptLine>) =>
    setLines((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const good = po.lines.map((_l, i) =>
    Math.max(0, Math.round(((lines[i]?.recv ?? 0) - (lines[i]?.rejected ?? 0)) * 1000) / 1000));
  const value = po.lines.reduce((t, l, i) => t + good[i] * l.rate, 0);
  const balance = po.lines.map((l, i) => ({
    it: l.it,
    qty: Math.max(0, Math.round((l.qty - l.recv - (lines[i]?.recv ?? 0)) * 1000) / 1000),
  }));

  const qtyRows: Row[] = po.lines.map((l, i) => {
    const r = lines[i];
    return {
      key: "q" + l.it + i,
      cells: [
        <>{IT[l.it]?.n ?? l.it}<small>{IT[l.it]?.c ?? ""}</small></>,
        <>{fq(l.qty, l.it)} <span className="dim">{U(l.it)}</span></>,
        <>{fq(l.recv, l.it)}</>,
        <>
          <input type="number" className="mono" min={0} step={U(l.it) === "nos" ? 1 : 0.001}
            value={r.recv} aria-label={`Quantity received for ${IT[l.it]?.n ?? l.it}`}
            onChange={(e) => at(i, { recv: num(e.target.value) })} />
          {l.recv + r.recv > l.qty * 1.02 && (
            <div className="mini" style={warn}>over the ordered {fq(l.qty, l.it)} by more than 2%</div>
          )}
        </>,
        <input type="number" className="mono" min={0} step={U(l.it) === "nos" ? 1 : 0.001}
          value={r.rejected} aria-label={`Rejected at QC for ${IT[l.it]?.n ?? l.it}`}
          onChange={(e) => at(i, { rejected: num(e.target.value) })} />,
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
          ? <input type="number" className="mono" min={0} step="0.01" value={r.mrp}
            aria-label={`Printed MRP for ${IT[l.it]?.n ?? l.it}`}
            onChange={(e) => at(i, { mrp: num(e.target.value) })} />
          : <span className="dim mini">Not printed</span>,
        <input type="date" value={r.mfg} aria-label={`Manufactured on for ${IT[l.it]?.n ?? l.it}`}
          onChange={(e) => at(i, { mfg: e.target.value })} />,
        <>
          <input type="date" value={r.exp} aria-label={`Expires on for ${IT[l.it]?.n ?? l.it}`}
            onChange={(e) => at(i, { exp: e.target.value })} />
          {r.exp && r.mfg && r.exp <= r.mfg && (
            <div className="mini" style={warn}>expiry falls on or before manufacture</div>
          )}
          {r.exp && r.exp < today() && (
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
          {po.st === "Partially received" && (
            <Btn variant="dg" onClick={() => setClosingShort(true)}>Close short</Btn>
          )}
          <div className="sp" />
          <Btn variant="gh" onClick={close}>Close</Btn>
          <Btn variant="ok" onClick={() => receive(po.id, doc, lines)}>Book into Procurement Room</Btn>
        </>
      }
    >
      <Section title="Delivery" sub="Record the vendor's paperwork before booking anything in.">
        <Alert tone="i" label="GOODS RECEIPT">
          Nothing enters stock without a batch behind it. Goods often arrive ahead of the invoice, so only the
          delivery note is required here — add the invoice once it turns up.
        </Alert>
        <FormRow cols="f3">
          <Field label="Delivery note" hint={!doc.dc.trim() ? "Required — nothing books in without it." : undefined}>
            <input value={doc.dc} aria-label="Delivery note number" placeholder="DC number"
              onChange={(e) => setDoc((d) => ({ ...d, dc: e.target.value }))} />
          </Field>
          <Field label="Invoice no.">
            <input value={doc.invoice} placeholder="Optional — add once it arrives"
              onChange={(e) => setDoc((d) => ({ ...d, invoice: e.target.value }))} />
          </Field>
          <Field label="Invoice date">
            <input type="date" value={doc.invDate}
              onChange={(e) => setDoc((d) => ({ ...d, invDate: e.target.value }))} />
          </Field>
        </FormRow>
      </Section>

      <Section title="Quantities" sub="Receiving now defaults to what's still outstanding on this order.">
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "20%" },
              { h: "Ordered", r: true },
              { h: "Already received", r: true, w: "14%" },
              { h: "Receiving now", r: true, w: "14%" },
              { h: "Rejected at QC", r: true, w: "14%" },
              { h: "Into stock", r: true },
              { h: "Value", r: true },
            ]}
            rows={qtyRows}
            empty={{ title: "No lines on this order", sub: "Nothing to receive." }}
          />
        </div>
        <TableFoot count={qtyRows.length} extra={<>{unitTotal(po.lines.map((l, i) => ({ it: l.it, qty: good[i] })))} into stock</>} />
        <div className="totrow big"><span>Value received</span><span>{money(value)}</span></div>
        <div className="totrow"><span>Balance outstanding</span><span>{unitTotal(balance)}</span></div>
      </Section>

      <Section title="Batch and dates" sub="Printed MRP is captured only for items that carry one on the pack.">
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
            empty={{ title: "No lines on this order", sub: "Nothing to receive." }}
          />
        </div>
      </Section>

      {closingShort && (
        <Section title="Close this order short" sub="A reason is required — the undelivered balance returns to the procurement list.">
          <Field label="Reason">
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="Why the balance is not coming…" />
          </Field>
          <BtnRow end>
            <Btn variant="gh" onClick={() => { setClosingShort(false); setReason(""); }}>Never mind</Btn>
            <Btn variant="dg" onClick={() => closeShort(po.id, reason)}>Confirm close short</Btn>
          </BtnRow>
        </Section>
      )}
    </DrawerFrame>
  );
}

registerDrawer("bgrn", PoReceiptDrawer);
export default PoReceiptDrawer;
