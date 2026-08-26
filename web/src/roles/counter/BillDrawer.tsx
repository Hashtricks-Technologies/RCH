import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { money } from "../../lib/fmt";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import { Avatar, Btn, DataTable, Pill, Section } from "../../ui/kit";
import { billStatus } from "./status";

function BillDrawer({ id }: DrawerProps) {
  const bills = useApp((s) => s.bills);
  const close = useApp((s) => s.closeDrawer);
  const notify = useApp((s) => s.notify);
  const bill = bills.find((b) => b.no === id);

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

  return (
    <DrawerFrame
      title={<span className="mono">{bill.no}</span>}
      sub={`${L.n} · ${bill.t} · ${bill.pay}`}
      foot={<>
        <Btn variant="gh" onClick={close}>Close</Btn>
        <div className="sp" />
        <Btn onClick={() => notify(`${bill.no} sent again to the ${L.c} printer`)}>Reprint</Btn>
      </>}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <Avatar name={bill.opr} color={bill.oprCol} size={38} />
        <div>
          <b style={{ fontSize: 13 }}>{bill.opr}</b>
          <div className="mini">Counter Operator · raised this bill at {bill.t}</div>
        </div>
        <div className="sp" />
        <Pill tone={st.tone}>{st.label}</Pill>
      </div>

      <dl className="dl">
        <dt>Outlet</dt><dd>{L.n} <span className="mini">({L.c})</span></dd>
        <dt>Terminal</dt><dd className="mono">{L.c}</dd>
        <dt>Cost centre</dt><dd className="mono">{L.cc}</dd>
        <dt>Time</dt><dd className="mono">{bill.t}</dd>
        <dt>Tender</dt><dd>{bill.pay}</dd>
      </dl>

      <Section title="Line items" sub={`${bill.lines.length} line${bill.lines.length === 1 ? "" : "s"} · rates are GST inclusive`} />
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
            IT[l.it]?.n ?? l.it,
            <span className="mono">{IT[l.it]?.c ?? "—"}</span>,
            l.qty,
            money(l.rate),
            (IT[l.it]?.gst ?? 0) + "%",
            money(l.rate * l.qty),
          ],
        }))}
        empty={{ title: "This bill carries no line" }}
      />

      <div className="mtop">
        <div className="totrow"><span>Taxable value</span><span>{money(taxable)}</span></div>
        <div className="totrow"><span>CGST</span><span>{money(bill.tax / 2)}</span></div>
        <div className="totrow"><span>SGST</span><span>{money(bill.tax / 2)}</span></div>
        <div className="totrow big"><span>Grand total</span><span>{money(bill.tot)}</span></div>
      </div>
      <p className="mini mtop">
        Royal Care Hospital · GSTIN 33AACCR1234F1ZP · this is a computer generated bill from terminal {L.c}.
      </p>
    </DrawerFrame>
  );
}

registerDrawer("cbill", BillDrawer);

export default BillDrawer;
