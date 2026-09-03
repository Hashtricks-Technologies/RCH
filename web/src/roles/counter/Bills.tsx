import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LOC } from "../../data/master";
import { useApp } from "../../store";
import { money, money0, sum } from "../../lib/fmt";
import { Avatar, Btn, Card, DataTable, FilterBtn, FilterSelect, PageHead, Pill, TableFoot, Toolbar } from "../../ui/kit";
import { billStatus, settlementOf, type Settlement } from "./status";

const SETTLEMENTS: { k: Settlement; label: string }[] = [
  { k: "drawer", label: "Cash in drawer" },
  { k: "bank", label: "Card & UPI" },
  { k: "account", label: "Charged" },
];

export default function Bills() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const nav = useNavigate();
  const loc = user.loc;
  const L = LOC[loc];
  const [q, setQ] = useState("");
  const [tender, setTender] = useState<string | null>(null);
  const [settle, setSettle] = useState<Settlement | null>(null);

  const mine = s.bills.filter((b) => b.loc === loc);
  const tenders = Array.from(new Set(mine.map((b) => b.pay))).sort();
  const rows = mine.filter((b) => {
    if (tender && b.pay !== tender) return false;
    if (settle && settlementOf(b.pay) !== settle) return false;
    const t = q.trim().toLowerCase();
    if (!t) return true;
    return b.no.toLowerCase().includes(t)
      || b.opr.toLowerCase().includes(t)
      || b.pay.toLowerCase().includes(t)
      || b.t.includes(t)
      || (b.payer?.name.toLowerCase().includes(t) ?? false)
      || (b.payer?.id.toLowerCase().includes(t) ?? false);
  });

  const filtered = Boolean(q || tender || settle);
  const clearAll = () => { setQ(""); setTender(null); setSettle(null); };

  const billed = sum(rows, (b) => b.tot);
  const cash = sum(rows.filter((b) => settlementOf(b.pay) === "drawer"), (b) => b.tot);
  const settleLabel = settle ? SETTLEMENTS.find((x) => x.k === settle)!.label : "All";

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
          placeholder="Search bill number, operator, tender, time or payer…"
          value={q}
          onSearch={setQ}
          filters={<>
            {tenders.length > 1 && (
              <FilterSelect label="Tender" value={tender ?? "All"}
                options={["All", ...tenders]}
                onChange={(v) => setTender(v === "All" ? null : v)} />
            )}
            <FilterSelect label="Settles to" value={settleLabel}
              options={["All", ...SETTLEMENTS.map((x) => x.label)]}
              onChange={(v) => setSettle(v === "All" ? null : SETTLEMENTS.find((x) => x.label === v)!.k)} />
            {filtered && <FilterBtn label="Clear filters" onClick={clearAll} />}
          </>}
          right={<span className="mini">Billed {money0(billed)} · cash in drawer {money0(cash)}</span>}
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
                <><span className="mono">{b.no}</span><small>{b.lines.length} item{b.lines.length === 1 ? "" : "s"}</small></>,
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
          empty={filtered
            ? {
              title: "Nothing matches those filters",
              sub: `No bill at ${L.n} matches ${[q && `“${q}”`, tender && `tender ${tender}`, settle && `settling to ${settleLabel.toLowerCase()}`].filter(Boolean).join(", ")}.`,
              action: <Btn size="sm" onClick={clearAll}>Clear filters</Btn>,
            }
            : {
              title: "No bill raised at this counter yet",
              sub: "Open the till and print the first bill of the shift.",
              action: <Btn size="sm" onClick={() => nav("/pos")}>Open till</Btn>,
            }}
        />
        <TableFoot count={rows.length}
          extra={<>{L.n} · {L.c} · billed {money(billed)} · cash in drawer {money(cash)}</>} />
      </Card>
      <p className="mini mtop">
        <b>Billed</b> is every tender raised at this counter. <b>Cash in drawer</b> is what is actually in the till —
        card and UPI are taken at the till but settle to the hospital account, and patient, staff and department
        bills collect nothing at the counter at all.
      </p>
    </>
  );
}
