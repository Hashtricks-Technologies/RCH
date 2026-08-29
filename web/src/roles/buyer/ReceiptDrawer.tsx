import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { U, fq, money, money0, unitTotal } from "../../lib/fmt";
import { Alert, Btn, DataTable, Section, TableFoot } from "../../ui/kit";
import type { Row } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import type { ReceiptLine } from "../../types";

const num = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const today = () => new Date().toISOString().slice(0, 10);
const warn = { color: "var(--warn)" };

function ReceiptDrawer({ id }: DrawerProps) {
  const s = useApp();
  const receive = useApp((x) => x.receiveRequisition);
  const close = useApp((x) => x.closeDrawer);

  const p = s.prq.find((x) => x.id === id);
  const po = s.po.find((o) => o.prq === id);

  const [lines, setLines] = useState<ReceiptLine[]>(() =>
    (p?.lines ?? []).map((l) => ({
      recv: l.qty, batch: "", mrp: IT[l.it]?.mrp ?? 0, mfg: "", exp: "", rejected: 0,
    })));

  if (!p) {
    return (
      <DrawerFrame title="Requisition not found" sub={id}>
        <div className="empty">
          <b>{id} is no longer on file</b>
          <p>It may have been received or declined already. Close this panel and refresh the list.</p>
        </div>
      </DrawerFrame>
    );
  }

  const at = (i: number, patch: Partial<ReceiptLine>) =>
    setLines((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const open = p.st === "Ordered";
  const rateAt = (i: number) => po?.lines[i]?.rate ?? IT[p.lines[i].it]?.cost ?? 0;
  const good = p.lines.map((l, i) =>
    ({ it: l.it, qty: Math.max(0, (lines[i]?.recv ?? 0) - (lines[i]?.rejected ?? 0)) }));
  const value = p.lines.reduce((t, _l, i) => t + good[i].qty * rateAt(i), 0);
  const booked = s.grn.filter((g) => g.prq === p.id);

  const qtyRows: Row[] = p.lines.map((l, i) => {
    const r = lines[i];
    return {
      key: "q" + l.it + i,
      cells: [
        <>{IT[l.it]?.n ?? l.it}<small>{IT[l.it]?.c ?? ""}</small></>,
        <>{fq(l.qty, l.it)} <span className="dim">{U(l.it)}</span></>,
        <>
          <input type="number" className="mono" min={0} step={U(l.it) === "nos" ? 1 : 0.001}
            value={r.recv} aria-label={`Quantity received for ${IT[l.it]?.n ?? l.it}`}
            onChange={(e) => at(i, { recv: num(e.target.value) })} />
          {r.recv > l.qty * 1.02 && (
            <div className="mini" style={warn}>over the ordered {fq(l.qty, l.it)} by more than 2%</div>
          )}
        </>,
        <input type="number" className="mono" min={0} step={U(l.it) === "nos" ? 1 : 0.001}
          value={r.rejected} aria-label={`Rejected at QC for ${IT[l.it]?.n ?? l.it}`}
          onChange={(e) => at(i, { rejected: num(e.target.value) })} />,
        <b>{fq(good[i].qty, l.it)}</b>,
        <>{money(good[i].qty * rateAt(i))}</>,
      ],
    };
  });

  const batchRows: Row[] = p.lines.map((l, i) => {
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

  if (!open) {
    return (
      <DrawerFrame title={p.id} sub={`${p.st} · raised by ${p.by} · ${p.at}`}>
        <Section title="Goods receipt" sub={`Booked into ${LOC.store.n} against this requisition.`}>
          <DataTable
            cols={[
              { h: "GRN", cls: "nm", w: "20%" },
              { h: "Item", w: "24%" },
              { h: "Accepted", r: true },
              { h: "Rejected", r: true },
              { h: "Batch" },
              { h: "Expiry" },
            ]}
            rows={booked.map((g) => ({
              key: g.id,
              cells: [
                <>{g.id}<small>{g.by} · {g.at}</small></>,
                <>{IT[g.it]?.n ?? g.it}</>,
                <b>{fq(g.qty, g.it)}</b>,
                <>{fq(g.rejected, g.it)}</>,
                <span className="mono">{g.batch}</span>,
                <span className="mono">{g.exp}</span>,
              ],
            }))}
            empty={{
              title: "No goods receipt on this requisition",
              sub: `It is ${p.st.toLowerCase()}, so nothing was booked into ${LOC.store.n} against it.`,
            }}
          />
          <TableFoot count={booked.length} />
        </Section>
      </DrawerFrame>
    );
  }

  return (
    <DrawerFrame
      title={`Receive ${p.id}`}
      sub={po ? `${po.id} · ${po.vendor} · expected ${po.eta}` : `Raised by ${p.by} · ${p.at}`}
      foot={
        <>
          <Btn variant="gh" onClick={close}>Close</Btn>
          <div className="sp" />
          <Btn variant="ok" onClick={() => receive(p.id, lines)}>Book into {LOC.store.n}</Btn>
        </>
      }
    >
      <Section title="Delivery" sub="Record what actually landed at the store window, line by line.">
        <Alert tone="i" label="GOODS RECEIPT">
          Nothing enters stock without a batch behind it. Every line needs a batch or lot number, a manufacturing
          date and an expiry date; anything rejected at QC goes to quarantine instead of the shelf.
        </Alert>
      </Section>

      <Section title="Quantities" sub="Received defaults to the ordered quantity. Trim it if the vendor short-supplied.">
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "24%" },
              { h: "Ordered", r: true },
              { h: "Received", r: true, w: "16%" },
              { h: "Rejected at QC", r: true, w: "14%" },
              { h: "Into stock", r: true },
              { h: "Value", r: true },
            ]}
            rows={qtyRows}
            empty={{ title: "No lines on this requisition", sub: "Nothing to receive." }}
          />
        </div>
        <TableFoot count={qtyRows.length} extra={<>{unitTotal(good)} accepted</>} />
        <div className="totrow big"><span>Value received</span><span>{money(value)}</span></div>
        <div className="totrow"><span>Ordered value</span><span>{money0(po ? po.lines.reduce((t, l) => t + l.qty * l.rate, 0) : 0)}</span></div>
      </Section>

      <Section title="Batch and dates" sub="Printed MRP is captured only for items that carry one on the pack.">
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "24%" },
              { h: "Batch or lot", w: "20%" },
              { h: "Printed MRP", w: "14%" },
              { h: "Manufactured", w: "20%" },
              { h: "Expires", w: "22%" },
            ]}
            rows={batchRows}
            empty={{ title: "No lines on this requisition", sub: "Nothing to receive." }}
          />
        </div>
      </Section>
    </DrawerFrame>
  );
}

registerDrawer("bgrn", ReceiptDrawer);
export default ReceiptDrawer;
