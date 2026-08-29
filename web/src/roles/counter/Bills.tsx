import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LOC } from "../../data/master";
import { useApp } from "../../store";
import { cashCollected } from "../../lib/selectors";
import { money, money0, sum } from "../../lib/fmt";
import { Avatar, Btn, Card, DataTable, FilterBtn, PageHead, Pill, TableFoot, Toolbar } from "../../ui/kit";
import { billStatus } from "./status";

export default function Bills() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const nav = useNavigate();
  const loc = user.loc;
  const L = LOC[loc];
  const [q, setQ] = useState("");
  const [tender, setTender] = useState<string | null>(null);

  const mine = s.bills.filter((b) => b.loc === loc);
  const tenders = Array.from(new Set(mine.map((b) => b.pay)));
  const rows = mine.filter((b) => {
    if (tender && b.pay !== tender) return false;
    const t = q.trim().toLowerCase();
    return !t || b.no.toLowerCase().includes(t) || b.opr.toLowerCase().includes(t) || b.pay.toLowerCase().includes(t);
  });

  const billed = sum(rows, (b) => b.tot);
  const cash = cashCollected(rows);

  return (
    <>
      <PageHead
        crumbs={["Royal Care", L.n, "Bills"]}
        title="Bills"
        sub={`Every bill raised at ${L.n} (${L.c}) today. Other outlets are not visible from this counter.`}
        actions={<Btn onClick={() => nav("/pos")}>New bill</Btn>}
      />
      <Card flush>
        <Toolbar
          placeholder="Search bill number, operator or tender…"
          value={q}
          onSearch={setQ}
          filters={<>
            <FilterBtn label="Tender" value={tender ?? "All"} onClick={() => {
              const i = tenders.indexOf(tender ?? "");
              setTender(i + 1 >= tenders.length ? null : tenders[i + 1]);
            }} />
          </>}
          right={<span className="mini">Billed {money0(billed)} · cash collected {money0(cash)}</span>}
        />
        <DataTable
          cols={[
            { h: "Bill no", cls: "nm", w: "14%" },
            { h: "Time", w: "9%" },
            { h: "Raised by", cls: "nm", w: "22%" },
            { h: "Items", r: true, w: "8%" },
            { h: "Tender", w: "14%" },
            { h: "Amount", r: true, w: "14%" },
            { h: "Status", w: "15%" },
          ]}
          rows={rows.map((b) => {
            const st = billStatus(b.pay);
            return {
              key: b.no,
              onClick: () => s.openDrawer("cbill", b.no),
              cells: [
                <><span className="mono">{b.no}</span><small>{b.lines.length} line{b.lines.length === 1 ? "" : "s"}</small></>,
                <span className="mono">{b.t}</span>,
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Avatar name={b.opr} color={b.oprCol} size={22} />
                  <span>{b.opr}</span>
                </div>,
                sum(b.lines, (l) => l.qty),
                <>{b.pay}{b.payer && <span className="mini" style={{ display: "block" }}>{b.payer.name}</span>}</>,
                money(b.tot),
                <Pill tone={st.tone}>{st.label}</Pill>,
              ],
            };
          })}
          empty={{
            title: q || tender ? "No bill matches this filter" : "No bill raised at this counter yet",
            sub: q || tender ? "Clear the search or the tender filter to see the full day." : "Open the till and print the first bill of the shift.",
            action: <Btn size="sm" onClick={() => (q || tender ? (setQ(""), setTender(null)) : nav("/pos"))}>
              {q || tender ? "Clear filters" : "Open till"}
            </Btn>,
          }}
        />
        <TableFoot count={rows.length}
          extra={<>{L.n} · {L.c} · billed {money(billed)} · cash collected {money(cash)}</>} />
      </Card>
      <p className="mini mtop">
        <b>Billed</b> is every tender raised at this counter. <b>Cash collected</b> is what is actually in the drawer —
        card, UPI and patient-bill takings settle to the hospital account and are not counted in the drawer.
      </p>
    </>
  );
}
