import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { money0, sum } from "../../lib/fmt";
import {
  Btn, Card, DataTable, Icon, PageHead, StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { LocKey } from "../../types";

interface ReportDef { k: string; n: string; d: string; icon: string; opens: string }

const REPORTS: ReportDef[] = [
  { k: "ledger", n: "Central store stock ledger", icon: "stock", d: "Every receipt, issue and adjustment against each item in the central store.", opens: "the item-wise stock ledger for the central store, opening to closing balance" },
  { k: "issreg", n: "Issue register by outlet", icon: "tkt", d: "What left the store window, grouped by receiving outlet and by day.", opens: "the issue register grouped by outlet, with quantity and value issued" },
  { k: "turn", n: "Ticket turnaround", icon: "rep", d: "Time from manager approval to ticket, and from ticket to collection.", opens: "ticket turnaround — approval to issue to collection, with the slowest tickets first" },
  { k: "resage", n: "Reservation ageing", icon: "req", d: "Stock reserved against tickets nobody has collected yet.", opens: "reservation ageing — how long each open ticket has been holding stock" },
  { k: "belowrl", n: "Below-reorder exceptions", icon: "need", d: "Lines under reorder level, with the suggested requisition quantity.", opens: "the below-reorder exception list with suggested top-up quantities" },
  { k: "prqst", n: "Requisition status", icon: "order", d: "Requisitions raised on procurement — sent, ordered, received or declined.", opens: "requisition status against procurement, with ageing on anything still Sent" },
  { k: "ageing", n: "Stock ageing", icon: "item", d: "How long each lot has been sitting in the central store against its shelf life.", opens: "stock ageing buckets for the central store, flagging anything near shelf life" },
  { k: "movers", n: "Fast and slow movers", icon: "dash", d: "Issue velocity per item over the last fourteen days.", opens: "fast and slow movers ranked by issue velocity over fourteen days" },
  { k: "resvav", n: "Reserved versus available", icon: "power", d: "Free-to-promise position per item after open ticket reservations.", opens: "reserved versus available, showing free-to-promise stock per item" },
  { k: "disc", n: "Handover discrepancies", icon: "appr", d: "Tickets where the counter confirmed a quantity different from the one issued.", opens: "handover discrepancies — issued quantity against the quantity confirmed by the counter" },
];

interface IssueRow { id: string; to: LocKey; items: number; qty: number; val: number; st: string; when: string }

const HISTORY: IssueRow[] = [
  { id: "TKT-0439", to: "rest", items: 3, qty: 46, val: 3184, st: "Received", when: "Mon 08:12" },
  { id: "TKT-0438", to: "kiosk", items: 2, qty: 60, val: 1548, st: "Received", when: "Mon 11:40" },
  { id: "TKT-0437", to: "coffee", items: 4, qty: 740, val: 2296, st: "Received", when: "Tue 07:55" },
  { id: "TKT-0436", to: "rest", items: 2, qty: 26, val: 1732, st: "Received", when: "Wed 09:18" },
  { id: "TKT-0435", to: "coffee", items: 3, qty: 118, val: 2074, st: "Received", when: "Thu 08:05" },
  { id: "TKT-0434", to: "kiosk", items: 3, qty: 92, val: 1436, st: "Received", when: "Fri 10:22" },
];

export default function Reports() {
  const tkt = useApp((s) => s.tkt);
  const notify = useApp((s) => s.notify);
  const [q, setQ] = useState("");

  const live: IssueRow[] = tkt
    .filter((t) => t.from === "store")
    .map((t) => ({
      id: t.id,
      to: t.to,
      items: t.lines.length,
      qty: sum(t.lines, (l) => l.qty),
      val: sum(t.lines, (l) => l.qty * (IT[l.it]?.cost ?? 0)),
      st: t.st,
      when: "Today",
    }));

  const all = [...live, ...HISTORY];
  const term = q.trim().toLowerCase();
  const rows = all.filter(
    (r) => !term || r.id.toLowerCase().includes(term) || LOC[r.to].n.toLowerCase().includes(term) || r.st.toLowerCase().includes(term),
  );

  const total = sum(rows, (r) => r.val);
  const units = sum(rows, (r) => r.qty);

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Store", "Insights"]}
        title="Store reports"
        sub={`${LOC.store.n} · issue, reservation and replenishment reporting`}
      />

      <Card title="Report library" sub="Ten reports for running the central store">
        <div className="tilegrid">
          {REPORTS.map((r) => (
            <button
              key={r.k}
              type="button"
              className="tile"
              onClick={() => notify(`Opening ${r.n} — ${r.opens}`)}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <Icon name={r.icon} />
                <b style={{ fontSize: 12.5 }}>{r.n}</b>
              </span>
              <span className="mini" style={{ lineHeight: 1.45 }}>{r.d}</span>
            </button>
          ))}
        </div>
      </Card>

      <div className="mtop">
      <Card title="Issue register — this week" sub={`${LOC.store.n} → outlets, at cost`} flush>
        <Toolbar
          placeholder="Search ticket, outlet or status…"
          value={q}
          onSearch={setQ}
          right={<Btn size="sm" variant="gh" onClick={() => notify("Issue register exported to CSV — this week, all outlets")}>Export</Btn>}
        />
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "20%" },
            { h: "Outlet", w: "20%" },
            { h: "Items", r: true },
            { h: "Quantity", r: true },
            { h: "Value", r: true },
            { h: "Status", w: "16%" },
          ]}
          rows={rows.map((r) => ({
            key: r.id,
            cells: [
              <>
                {r.id}
                <small>{r.when}</small>
              </>,
              <>{LOC[r.to].n}<div className="mini">{LOC[r.to].floor}</div></>,
              <>{r.items}</>,
              <b>{r.qty}</b>,
              <>{money0(r.val)}</>,
              <StatusPill status={r.st} />,
            ],
          }))}
          empty={{
            title: "Nothing issued in this period",
            sub: "Generate a ticket on the issue desk and it appears in this register.",
          }}
        />
        <TableFoot
          count={rows.length}
          extra={<>{units} units issued · {money0(total)} at cost</>}
        />
      </Card>
      </div>
    </>
  );
}
