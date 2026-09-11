import { useState } from "react";
import { IT, PO_APPROVAL_LIMIT } from "../../data/master";
import { vendorName } from "../../data/vendors";
import { useApp } from "../../store";
import { canCancelPo, canSendPo, netReceived, poValue } from "../../lib/selectors";
import { U, fq, money, money0, pct } from "../../lib/fmt";
// The two typed-in boxes this drawer pioneered live in the kit now: six other tables on three
// other screens need the same "absorb the typing, commit once" behaviour, and a second copy is
// how "12.5" starts posting as 12 again on one of them.
import {
  Alert, Btn, BtnRow, DataTable, DraftLineInput, EtaInput, Feed, Field, FormRow, Pill, Section,
  TableFoot,
} from "../../ui/kit";
import type { Row } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import { contractFor } from "./lib";

const warn = { color: "var(--warn)" };

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
  const [busy, setBusy] = useState(false);

  // A draft is priced off its vendor's live rate contract, and a hand-negotiated rate is never
  // overwritten — both of them server-side now: `createPo` prices the draft when it is raised
  // and `PATCH /purchase-orders/:id` re-prices it when the vendor moves. The effect that used
  // to do it here is gone rather than awaited: it would have fired one network write per line
  // on every open of this drawer.

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
  // Gross on purpose, mirroring `cancel`'s own guard server-side: a delivery that arrived and
  // was turned away still left GRN documents and a quarantine balance behind it, so the order
  // is closed short with a reason rather than cancelled as though nothing had come.
  const anyReceived = po.lines.some((l) => l.recv > 0);
  const grns = s.grn.filter((g) => g.po === po.id);
  const vendorLabel = vendorName(s.vendors, po.vendor);

  if (po.st === "Draft") {
    const overSlab = value > PO_APPROVAL_LIMIT;
    const offContract = po.lines.filter((l) => !contractFor(s, po.vendor, l.it)).length;
    const deviating = po.lines.filter((l) => {
      const c = contractFor(s, po.vendor, l.it);
      return c != null && l.rate !== c.rate;
    }).length;
    const belowMoq = po.lines.filter((l) => {
      const c = contractFor(s, po.vendor, l.it);
      return c != null && c.moq > 0 && l.qty < c.moq;
    }).length;

    /** A cancellation carries a reason, so it keeps the box open until the server takes it. */
    const cancel = async () => {
      if (busy) return;
      setBusy(true);
      const ok = await cancelPo(po.id, reason);
      setBusy(false);
      if (ok) close();
    };
    /** Sending is a commitment to a vendor: one press, and the panel closes behind the answer. */
    const send = async () => {
      if (busy) return;
      setBusy(true);
      const ok = await sendPo(po.id);
      setBusy(false);
      if (ok) close();
    };
    const saveEta = async (iso: string) => {
      if (busy) return;
      setBusy(true);
      await setPoEta(po.id, iso);
      setBusy(false);
    };

    const rows: Row[] = po.lines.map((l, i) => {
      const c = contractFor(s, po.vendor, l.it);
      const diff = c ? Math.round((l.rate - c.rate) * 100) / 100 : 0;
      const short = c != null && c.moq > 0 && l.qty < c.moq;
      return {
        key: l.it + i,
        cells: [
          <>{IT[l.it]?.n ?? l.it}<small>{IT[l.it]?.c ?? ""}</small></>,
          <>
            <DraftLineInput
              value={l.qty} min={0} step={U(l.it) === "nos" ? 1 : 0.5} positiveOnly
              ariaLabel={`Quantity of ${IT[l.it]?.n ?? l.it}`}
              onCommit={(n) => { void updatePoLine(po.id, i, { qty: n }); }}
            />
            {short && (
              <div className="mini" style={warn}>
                below the {fq(c!.moq, l.it)} {U(l.it)} minimum on {c!.id}
              </div>
            )}
          </>,
          <>{U(l.it)}</>,
          <DraftLineInput
            value={l.rate} min={0} step={0.01}
            ariaLabel={`Rate for ${IT[l.it]?.n ?? l.it}`}
            onCommit={(n) => { void updatePoLine(po.id, i, { rate: n }); }}
          />,
          c ? (
            <>
              <Pill tone="ok">On contract</Pill>
              <div className="mini">{money(c.rate)} · {c.id} · to {c.to}</div>
              {diff !== 0 && (
                <div className="mini" style={warn}>
                  {money(Math.abs(diff))} {diff > 0 ? "above" : "below"} the contract rate
                  {" "}{money(c.rate)} ({pct(diff / c.rate)})
                </div>
              )}
            </>
          ) : (
            <>
              <Pill tone="mu">Off contract</Pill>
              <div className="mini dim">no live contract with {vendorLabel}</div>
            </>
          ),
          <>{money0(l.qty * l.rate)}</>,
          <>{l.src.map((x, si) => <div key={si}>{x.prq} · {fq(x.qty, l.it)}</div>)}</>,
          <Btn size="xs" variant="gh" onClick={() => { void removePoLine(po.id, i); }}>Remove</Btn>,
        ],
      };
    });

    return (
      <DrawerFrame
        title={po.id}
        sub={`Draft · ${vendorLabel} · ${po.lines.length} item${po.lines.length > 1 ? "s" : ""}`}
        foot={
          <>
            {canCancelPo(po.st, anyReceived) && (
              <Btn variant="dg" onClick={() => setCancelling(true)}>Cancel order</Btn>
            )}
            <div className="sp" />
            <Btn variant="gh" onClick={close}>Close</Btn>
            {canSendPo(po.st) && (
              <Btn disabled={busy} onClick={send}>{busy ? "Sending…" : "Send to vendor"}</Btn>
            )}
          </>
        }
      >
        <Section title="Items" sub="Rates default to the live rate contract for this vendor. Quantity can only be trimmed, not raised, from here — pick another item from the procurement list to add more.">
          <div className="lgrid">
            <DataTable
              cols={[
                { h: "Item", cls: "nm", w: "16%" },
                { h: "Quantity", r: true, w: "13%" },
                { h: "Unit" },
                { h: "Rate", r: true, w: "11%" },
                { h: "Rate contract", w: "22%" },
                { h: "Value", r: true },
                { h: "Source requisition", w: "15%" },
                { h: "" },
              ]}
              rows={rows}
              empty={{
                title: "No items on this order",
                sub: "Every item was removed — cancel the order or pick another item from the procurement list.",
              }}
            />
          </div>
          <TableFoot count={rows.length} extra={<>{money0(value)} order value</>} />
        </Section>

        {deviating > 0 && (
          <Alert tone="w" label="OFF THE CONTRACT RATE">
            {deviating} item(s) are priced away from the rate agreed with {vendorLabel}. Each one names the
            contract rate and the difference above — correct them, or be ready to justify the variance.
          </Alert>
        )}
        {belowMoq > 0 && (
          <Alert tone="w" label="BELOW MINIMUM ORDER">
            {belowMoq} item(s) are under the minimum order quantity on their contract. The vendor may refuse the
            line or drop the contracted rate.
          </Alert>
        )}
        {offContract > 0 && (
          <Alert tone="i" label="OFF CONTRACT">
            {offContract} item(s) have no live rate contract with {vendorLabel} — those rates are yours to
            negotiate. Ask the store keeper to record a contract if this becomes a standing buy.
          </Alert>
        )}

        <Section title="Order terms" sub="Vendor and expected delivery — editable while this order is a draft.">
          <FormRow cols="f2">
            <Field label="Vendor" hint="Changing the vendor re-prices every item off that vendor's contract, unless you typed the rate yourself.">
              <select value={po.vendor} onChange={(e) => { void setPoVendor(po.id, e.target.value); }}>
                {/* The order's own vendor must always have a matching <option>, even when
                    deactivated after this draft was raised — otherwise the browser silently
                    selects the first option in the list, showing a vendor the order isn't on. */}
                {s.vendors.filter((v) => v.active || v.id === po.vendor).map((v) => (
                  <option key={v.id} value={v.id}>{v.active ? v.n : `${v.n} (inactive)`}</option>
                ))}
              </select>
            </Field>
            <Field label="Expected delivery" hint={`Currently ${po.eta}.`}>
              <EtaInput value={po.eta} busy={busy} onCommit={(iso) => { void saveEta(iso); }} />
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
              <Btn variant="dg" disabled={busy} onClick={cancel}>
                {busy ? "Cancelling…" : "Confirm cancellation"}
              </Btn>
            </BtnRow>
          </Section>
        )}
      </DrawerFrame>
    );
  }

  return (
    <DrawerFrame
      title={po.id}
      sub={`${vendorLabel} · ${po.st} · ${po.lines.length} item${po.lines.length > 1 ? "s" : ""}`}
    >
      <Section title="Order" sub={`Raised ${po.at} · expected ${po.eta}`}>
        <Alert tone={po.st === "Cancelled" ? "c" : po.st === "Received" ? "g" : "i"} label={po.st.toUpperCase()}>
          {money0(value)} on this order with {vendorLabel}.
        </Alert>
        {po.needsApproval && <Pill tone="wn">Needed finance approval when raised</Pill>}
      </Section>

      {po.shortNote && (
        <Alert tone="c" label={po.st === "Cancelled" ? "CANCELLED" : "SHORT"}>{po.shortNote}</Alert>
      )}

      <Section title="Items" sub="Ordered, accepted and the balance still outstanding.">
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "18%" },
              { h: "Ordered", r: true },
              { h: "Unit" },
              { h: "Accepted", r: true },
              { h: "Balance", r: true },
              { h: "Rate", r: true },
              { h: "Rate contract", w: "18%" },
              { h: "Value", r: true },
            ]}
            rows={po.lines.map((l, i) => {
              const c = contractFor(s, po.vendor, l.it);
              const diff = c ? Math.round((l.rate - c.rate) * 100) / 100 : 0;
              return {
                key: l.it + i,
                cells: [
                  <>{IT[l.it]?.n ?? l.it}<small>{IT[l.it]?.c ?? ""}</small></>,
                  <>{fq(l.qty, l.it)}</>,
                  <>{U(l.it)}</>,
                  // What was taken in, not what turned up — which is why the column says
                  // "Accepted": accepted plus balance comes to the ordered quantity, with
                  // quarantine on neither side of it.
                  <>{fq(netReceived(l), l.it)}</>,
                  <>{fq(Math.max(0, l.qty - netReceived(l)), l.it)}</>,
                  <>{money(l.rate)}</>,
                  c ? (
                    <>
                      <Pill tone="ok">On contract</Pill>
                      <div className="mini">{money(c.rate)} · {c.id}</div>
                      {diff !== 0 && (
                        <div className="mini" style={warn}>
                          {money(Math.abs(diff))} {diff > 0 ? "above" : "below"} contract
                        </div>
                      )}
                    </>
                  ) : <Pill tone="mu">Off contract</Pill>,
                  <>{money0(l.qty * l.rate)}</>,
                ],
              };
            })}
            empty={{ title: "No items on this order" }}
          />
        </div>
        <TableFoot count={po.lines.length} extra={<>{money0(value)} order value</>} />
      </Section>

      <Section title="Goods received" sub="GRNs booked against this order">
        <DataTable
          cols={[
            { h: "GRN", cls: "nm", w: "18%" },
            { h: "Item", w: "22%" },
            { h: "Received", r: true },
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
