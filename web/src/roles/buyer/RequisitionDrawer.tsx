import { useState } from "react";
import { IT, LOC, PO_APPROVAL_LIMIT, RATE_CONTRACT, VENDOR_FOR } from "../../data/master";
import { useApp } from "../../store";
import { avail, stateTone } from "../../lib/selectors";
import { U, fq, money, money0, pct, sum } from "../../lib/fmt";
import {
  Alert, Btn, DataTable, Field, FormRow, Pill, Section, TableFoot,
} from "../../ui/kit";
import type { Row } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";

export const VENDORS = [
  "Aavin Dairy Depot",
  "Sri Balaji Distributors",
  "Anandha Provisions",
  "PackWell Industries",
  "Green Farm Vegetables",
];

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoDay(d);
};
/** Anything more than a tenth above the contracted rate is challenged before it is ordered (M2). */
const TOLERANCE = 0.1;
const overContract = (it: string, rate: number) => {
  const c = RATE_CONTRACT[it];
  return c > 0 && rate > c * (1 + TOLERANCE) ? c : null;
};

export const etaLabel = (v: string) => {
  const [y, m, d] = v.split("-");
  if (!y || !m || !d) return v;
  return `${d}-${MON[Number(m) - 1] ?? m}-${y}`;
};

function RequisitionDrawer({ id }: DrawerProps) {
  const s = useApp();
  const order = useApp((x) => x.orderRequisition);
  const decline = useApp((x) => x.declineRequisition);
  const close = useApp((x) => x.closeDrawer);
  const p = s.prq.find((x) => x.id === id);
  const first = p?.lines[0];

  const [rates, setRates] = useState<number[]>(() => (p?.lines ?? []).map((l) => IT[l.it]?.cost ?? 0));
  const [vendor, setVendor] = useState<string>(() =>
    first ? VENDOR_FOR(IT[first.it]?.g ?? "") : VENDORS[0]);
  const [eta, setEta] = useState<string>(() => inDays(2));

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

  const rateAt = (i: number) => {
    const r = rates[i];
    return Number.isFinite(r) && r > 0 ? r : (IT[p.lines[i].it]?.cost ?? 0);
  };
  const total = sum(p.lines.map((l, i) => l.qty * rateAt(i)), (v) => v);
  const open = p.st === "Sent";
  const challenged = p.lines.filter((l, i) => overContract(l.it, rateAt(i)) !== null);
  const needsApproval = total > PO_APPROVAL_LIMIT;

  const rows: Row[] = p.lines.map((l, i) => {
    const have = avail(s, "store", l.it);
    const it = IT[l.it];
    const contracted = overContract(l.it, rateAt(i));
    return {
      key: l.it + i,
      cells: [
        <>{it?.n ?? l.it}<small>{it?.c ?? ""}</small></>,
        <>{fq(l.qty, l.it)}</>,
        <>{U(l.it)}</>,
        <>
          {fq(have, l.it)}{" "}
          <Pill tone={stateTone(have, it?.rl ?? 0)}>{have <= 0 ? "Out" : have < (it?.rl ?? 0) ? "Low" : "OK"}</Pill>
        </>,
        <>{fq(it?.rl ?? 0, l.it)}</>,
        <>{VENDOR_FOR(it?.g ?? "")}</>,
        <>{RATE_CONTRACT[l.it] > 0 ? money(RATE_CONTRACT[l.it]) : <span className="dim">No contract</span>}</>,
        <>
          <input type="number" className="mono" min={0} step="0.01" value={rates[i] ?? 0}
            disabled={!open} aria-label={`Rate for ${it?.n ?? l.it}`}
            onChange={(e) => {
              const v = Number(e.target.value);
              setRates((r) => r.map((x, j) => (j === i ? v : x)));
            }} />
          {contracted !== null && (
            <div className="mini" style={{ color: "var(--warn)" }}>
              {pct(rateAt(i) / contracted - 1, 0)} over contract
            </div>
          )}
        </>,
        <>{money(l.qty * rateAt(i))}</>,
      ],
    };
  });

  return (
    <DrawerFrame
      title={p.id}
      sub={`Raised by ${p.by} · ${p.at} · ${p.lines.length} line${p.lines.length > 1 ? "s" : ""}`}
      foot={open ? (
        <>
          <Btn variant="dg" onClick={() => decline(p.id)}>Decline</Btn>
          <div className="sp" />
          <Btn variant="gh" onClick={close}>Close</Btn>
          <Btn onClick={() => order(p.id, p.lines.map((_, i) => rateAt(i)), vendor, etaLabel(eta))}>
            {needsApproval ? "Raise for finance approval" : "Raise purchase order"}
          </Btn>
        </>
      ) : undefined}
    >
      <Section title="Requirement from the store keeper"
        sub={`${p.by} · ${LOC.store.n} · raised at ${p.at}`}>
        <Alert tone={p.st === "Sent" ? "i" : "g"} label={p.st.toUpperCase()}>
          {p.note || "No note was left with this requisition."}
        </Alert>
      </Section>

      <Section title="Lines" sub="Rates default to the last landed cost. Edit a rate to price the order.">
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "24%" },
              { h: "Requested", r: true },
              { h: "Unit" },
              { h: "Store now", r: true },
              { h: "Reorder", r: true },
              { h: "Suggested vendor" },
              { h: "Contract rate", r: true },
              { h: "Rate", r: true, w: "12%" },
              { h: "Line value", r: true },
            ]}
            rows={rows}
            empty={{ title: "No lines on this requisition", sub: "Nothing to price." }}
          />
        </div>
        <TableFoot count={rows.length} extra={<>{Math.round(sum(p.lines, (l) => l.qty))} units requested</>} />
        <div className="totrow"><span>Finance approval slab</span><span>{money0(PO_APPROVAL_LIMIT)}</span></div>
        <div className="totrow big"><span>Order total</span><span>{money(total)}</span></div>

        {challenged.length > 0 && (
          <div className="mtop">
            <Alert tone="w" label="RATE CONTRACT">
              {challenged.map((l) => IT[l.it]?.n ?? l.it).join(", ")} priced more than
              {" "}{pct(TOLERANCE, 0)} above the contracted rate. Challenge the vendor or record the reason
              before the order goes out.
            </Alert>
          </div>
        )}
        <div className="mtop">
          {needsApproval ? (
            <Alert tone="c" label="FINANCE APPROVAL">
              {money(total)} is over the {money0(PO_APPROVAL_LIMIT)} slab, so this order cannot be placed on the
              vendor until finance approves it. It is raised and held for approval.
            </Alert>
          ) : (
            <Alert tone="g" label="WITHIN LIMIT">
              {money(total)} is inside the {money0(PO_APPROVAL_LIMIT)} slab — you can place this order yourself.
            </Alert>
          )}
        </div>
      </Section>

      <Section title="Order terms" sub="Applied to the purchase order raised against this requisition.">
        <FormRow cols="f2">
          <Field label="Vendor" hint="Suggested from the group of the first line.">
            <select value={vendor} disabled={!open} onChange={(e) => setVendor(e.target.value)}>
              {VENDORS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Expected delivery" hint={`Recorded on the order as ${etaLabel(eta)}.`}>
            <input type="date" value={eta} disabled={!open} onChange={(e) => setEta(e.target.value)} />
          </Field>
        </FormRow>
      </Section>
    </DrawerFrame>
  );
}

registerDrawer("bprq", RequisitionDrawer);
export default RequisitionDrawer;
