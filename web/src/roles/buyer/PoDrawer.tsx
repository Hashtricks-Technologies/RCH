import { useState } from "react";
import { IT, PO_APPROVAL_LIMIT, RATE_CONTRACT } from "../../data/master";
import { vendorName } from "../../data/vendors";
import { useApp } from "../../store";
import { poValue } from "../../lib/selectors";
import { U, fq, money, money0, pct } from "../../lib/fmt";
import { Alert, Btn, BtnRow, DataTable, Feed, Field, FormRow, Pill, Section, TableFoot } from "../../ui/kit";
import type { Row } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";

/** A rate more than 10% above the contract rate is challenged before the order goes out (M2). */
const TOLERANCE = 0.1;
const overContract = (it: string, rate: number) => {
  const c = RATE_CONTRACT[it];
  return c > 0 && rate > c * (1 + TOLERANCE) ? c : null;
};

const dotFor = (state: string) =>
  state === "Cancelled" ? "var(--crit)"
    : state === "Partially received" ? "var(--warn)"
    : state === "Received" ? "var(--good)"
    : state === "Ordered" ? "var(--info)"
    : "var(--ink-3)";

function PoDrawer({ id }: DrawerProps) {
  const s = useApp();
  const updatePoLine = useApp((x) => x.updatePoLine);
  const removePoLine = useApp((x) => x.removePoLine);
  const setPoVendor = useApp((x) => x.setPoVendor);
  const setPoEta = useApp((x) => x.setPoEta);
  const sendPo = useApp((x) => x.sendPo);
  const cancelPo = useApp((x) => x.cancelPo);
  const close = useApp((x) => x.closeDrawer);
  const po = s.po.find((x) => x.id === id);

  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

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

  const value = poValue(po);
  const grns = s.grn.filter((g) => g.po === po.id);

  if (po.st === "Draft") {
    const overSlab = value > PO_APPROVAL_LIMIT;
    const rows: Row[] = po.lines.map((l, i) => {
      const contract = RATE_CONTRACT[l.it];
      const over = overContract(l.it, l.rate);
      return {
        key: l.it + i,
        cells: [
          <>{IT[l.it]?.n ?? l.it}<small>{IT[l.it]?.c ?? ""}</small></>,
          <input
            type="number" className="mono" min={0} step={U(l.it) === "nos" ? 1 : 0.5}
            value={l.qty} aria-label={`Quantity of ${IT[l.it]?.n ?? l.it}`}
            onChange={(e) => updatePoLine(po.id, i, { qty: Number(e.target.value) })}
          />,
          <>{U(l.it)}</>,
          <input
            type="number" className="mono" min={0} step={0.01}
            value={l.rate} aria-label={`Rate for ${IT[l.it]?.n ?? l.it}`}
            onChange={(e) => updatePoLine(po.id, i, { rate: Number(e.target.value) })}
          />,
          <>
            {contract > 0 ? money(contract) : <span className="dim">—</span>}
            {over != null && (
              <div className="mini" style={{ color: "var(--warn)" }}>
                {pct((l.rate - over) / over)} over contract
              </div>
            )}
          </>,
          <>{money0(l.qty * l.rate)}</>,
          <>{l.src.map((x, si) => <div key={si}>{x.prq} · {x.qty}</div>)}</>,
          <Btn size="xs" variant="gh" onClick={() => removePoLine(po.id, i)}>Remove</Btn>,
        ],
      };
    });

    return (
      <DrawerFrame
        title={po.id}
        sub={`Draft · ${vendorName(s.vendors, po.vendor)} · ${po.lines.length} line${po.lines.length > 1 ? "s" : ""}`}
        foot={
          <>
            <Btn variant="dg" onClick={() => setCancelling(true)}>Cancel order</Btn>
            <div className="sp" />
            <Btn variant="gh" onClick={close}>Close</Btn>
            <Btn onClick={() => sendPo(po.id)}>Send to vendor</Btn>
          </>
        }
      >
        <Section title="Lines" sub="Quantity can only be trimmed, not raised, from here — pick another line from the procurement list to add more.">
          <div className="lgrid">
            <DataTable
              cols={[
                { h: "Item", cls: "nm", w: "18%" },
                { h: "Quantity", r: true },
                { h: "Unit" },
                { h: "Rate", r: true },
                { h: "Contract", r: true },
                { h: "Value", r: true },
                { h: "Source requisition", w: "16%" },
                { h: "" },
              ]}
              rows={rows}
              empty={{
                title: "No lines on this order",
                sub: "Every line was removed — cancel the order or pick another line from the procurement list.",
              }}
            />
          </div>
          <TableFoot count={rows.length} extra={<>{money0(value)} order value</>} />
        </Section>

        <Section title="Order terms" sub="Vendor and expected delivery — editable while this order is a draft.">
          <FormRow cols="f2">
            <Field label="Vendor">
              <select value={po.vendor} onChange={(e) => setPoVendor(po.id, e.target.value)}>
                {s.vendors.filter((v) => v.active).map((v) => (
                  <option key={v.id} value={v.id}>{v.n}</option>
                ))}
              </select>
            </Field>
            <Field label="Expected delivery">
              <input value={po.eta} onChange={(e) => setPoEta(po.id, e.target.value)} placeholder="DD-Mon-YYYY" />
            </Field>
          </FormRow>
        </Section>

        <Alert tone={overSlab ? "c" : "g"} label={overSlab ? "FINANCE APPROVAL" : "WITHIN LIMIT"}>
          {money0(value)} is {overSlab ? "over" : "under"} the {money0(PO_APPROVAL_LIMIT)} finance slab
          {overSlab ? " — sending this order needs finance approval." : " — you can place this order yourself."}
        </Alert>

        {cancelling && (
          <Section title="Cancel this order" sub="A reason is required — it is kept on the order history and any claimed procurement lines return to the pool.">
            <Field label="Reason">
              <textarea
                rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="Why this order is being cancelled…"
              />
            </Field>
            <BtnRow end>
              <Btn variant="gh" onClick={() => { setCancelling(false); setReason(""); }}>Never mind</Btn>
              <Btn variant="dg" onClick={() => cancelPo(po.id, reason)}>Confirm cancellation</Btn>
            </BtnRow>
          </Section>
        )}
      </DrawerFrame>
    );
  }

  return (
    <DrawerFrame
      title={po.id}
      sub={`${vendorName(s.vendors, po.vendor)} · ${po.st} · ${po.lines.length} line${po.lines.length > 1 ? "s" : ""}`}
    >
      <Section title="Order" sub={`Raised ${po.at} · expected ${po.eta}`}>
        <Alert tone={po.st === "Cancelled" ? "c" : po.st === "Received" ? "g" : "i"} label={po.st.toUpperCase()}>
          {money0(value)} on this order with {vendorName(s.vendors, po.vendor)}.
        </Alert>
        {po.needsApproval && <Pill tone="wn">Needed finance approval when raised</Pill>}
      </Section>

      {po.shortNote && (
        <Alert tone="c" label={po.st === "Cancelled" ? "CANCELLED" : "SHORT"}>{po.shortNote}</Alert>
      )}

      <Section title="Lines" sub="Ordered, received and the balance still outstanding.">
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "20%" },
              { h: "Ordered", r: true },
              { h: "Unit" },
              { h: "Received", r: true },
              { h: "Balance", r: true },
              { h: "Rate", r: true },
              { h: "Value", r: true },
            ]}
            rows={po.lines.map((l, i) => ({
              key: l.it + i,
              cells: [
                <>{IT[l.it]?.n ?? l.it}<small>{IT[l.it]?.c ?? ""}</small></>,
                <>{fq(l.qty, l.it)}</>,
                <>{U(l.it)}</>,
                <>{fq(l.recv, l.it)}</>,
                <>{fq(Math.max(0, l.qty - l.recv), l.it)}</>,
                <>{money(l.rate)}</>,
                <>{money0(l.qty * l.rate)}</>,
              ],
            }))}
            empty={{ title: "No lines on this order" }}
          />
        </div>
        <TableFoot count={po.lines.length} extra={<>{money0(value)} order value</>} />
      </Section>

      <Section title="Goods received" sub="GRNs booked against this order">
        <DataTable
          cols={[
            { h: "GRN", cls: "nm", w: "18%" },
            { h: "Item", w: "20%" },
            { h: "Received", r: true },
            { h: "Rejected", r: true },
            { h: "Batch" },
            { h: "Invoice" },
            { h: "Received by" },
          ]}
          rows={grns.map((g) => ({
            key: g.id,
            cells: [
              <>{g.id}<small>{g.at}</small></>,
              <>{IT[g.it]?.n ?? g.it}</>,
              <>{fq(g.qty, g.it)}</>,
              <>{g.rejected > 0 ? fq(g.rejected, g.it) : <span className="dim">{fq(0, g.it)}</span>}</>,
              <>{g.batch}</>,
              <>{g.invoice}</>,
              <>{g.by}</>,
            ],
          }))}
          empty={{ title: "Nothing received yet", sub: "GRNs booked against this order will appear here." }}
        />
      </Section>

      <Section title="History" sub="Every step this order has been through">
        <Feed
          items={po.hist.map((h, i) => ({
            key: h.s + i, title: h.s, body: h.who, when: h.t, color: dotFor(h.s),
          }))}
        />
      </Section>
    </DrawerFrame>
  );
}

registerDrawer("bpo", PoDrawer);
export default PoDrawer;
