import { useState } from "react";
import { LOC } from "../../data/master";
import { useApp } from "../../store";
import { fromWireDate, money, money0, sum } from "../../lib/fmt";
import { Avatar, Btn, Card, DataTable, FilterBtn, FilterSelect, PageHead, Pill, TableFoot, Tip, Toolbar } from "../../ui/kit";
import { billDay, billStatus } from "../counter/status";
import type { LocKey } from "../../types";

/**
 * Every outlet's bills for the last seven days - the window `GET /bills` answers for, so the
 * store already holds exactly what this lists and there is nothing here to filter by date.
 *
 * The counter has had a bill list since the first day; the manager has had none, and voiding a
 * bill is the manager's own door (`POST /bills/:no/void`). The table is the counter's, widened
 * by the one column a counter never needs - which outlet took it - and by the badge on a bill
 * somebody has taken back. The void itself lives in the drawer this opens, where the reason is
 * typed; nothing is decided from this screen.
 */
export default function Bills() {
  const s = useApp();
  const openDrawer = useApp((x) => x.openDrawer);
  const [q, setQ] = useState("");
  const [outlet, setOutlet] = useState<LocKey | null>(null);
  const [tender, setTender] = useState<string | null>(null);

  const bills = s.bills;
  const outlets = Array.from(new Set(bills.map((b) => b.loc))).sort();
  const tenders = Array.from(new Set(bills.map((b) => b.pay))).sort();
  const nameOf = (l: string) => LOC[l]?.n ?? l;

  const rows = bills.filter((b) => {
    if (outlet && b.loc !== outlet) return false;
    if (tender && b.pay !== tender) return false;
    const t = q.trim().toLowerCase();
    if (!t) return true;
    // A phone is matched on its digits, and only when what was typed reads as a number.
    const digits = /^[+\d\s-]+$/.test(t) ? t.replace(/\D/g, "") : "";
    return b.no.toLowerCase().includes(t)
      || b.opr.toLowerCase().includes(t)
      || b.pay.toLowerCase().includes(t)
      || nameOf(b.loc).toLowerCase().includes(t)
      || (b.payer?.name.toLowerCase().includes(t) ?? false)
      || (b.payer?.id.toLowerCase().includes(t) ?? false)
      || (b.voidReason?.toLowerCase().includes(t) ?? false)
      || (b.customerName?.toLowerCase().includes(t) ?? false)
      || (digits !== "" && (b.customerPhone?.includes(digits) ?? false));
  });

  const filtered = Boolean(q || outlet || tender);
  const clearAll = () => { setQ(""); setOutlet(null); setTender(null); };

  // Takings are what the hospital kept: a voided bill was taken back, and counting it here
  // would put a figure on screen that no day's cash ever matched.
  const live = rows.filter((b) => !b.voided);
  const voided = rows.filter((b) => b.voided);
  const billed = sum(live, (b) => b.tot);
  const takenBack = sum(voided, (b) => b.tot);

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Outlets", "Bills"]}
        title="Bills"
        tip="Bills from every outlet in the last seven days."
      />
      <Card flush>
        <Toolbar
          placeholder="Search bill number, outlet, operator, tender, payer, customer or void reason…"
          value={q}
          onSearch={setQ}
          filters={<>
            {outlets.length > 1 && (
              <FilterSelect label="Outlet" value={outlet ? nameOf(outlet) : "All"}
                options={["All", ...outlets.map(nameOf)]}
                onChange={(v) => setOutlet(v === "All" ? null : (outlets.find((l) => nameOf(l) === v) ?? null) as LocKey | null)} />
            )}
            {tenders.length > 1 && (
              <FilterSelect label="Tender" value={tender ?? "All"}
                options={["All", ...tenders]}
                onChange={(v) => setTender(v === "All" ? null : v)} />
            )}
            {filtered && <FilterBtn label="Clear filters" onClick={clearAll} />}
          </>}
          right={<span className="mini">
            Billed {money0(billed)}{voided.length > 0 && <> · {voided.length} voided, {money0(takenBack)} taken back</>}
            {" "}<Tip label="Billed" text={<>
              <b>Billed</b> leaves out anything voided - the stock went back on the shelf and the money was
              never kept, so a voided bill is not takings. A bill can only be voided on the day it was billed;
              after that, write the stock back on with an adjustment instead.
            </>} />
          </span>}
        />
        <DataTable
          cols={[
            { h: "Bill no", cls: "nm", w: "14%" },
            { h: "Day", w: "12%" },
            { h: "Time", w: "8%" },
            { h: "Outlet", w: "14%" },
            { h: "Raised by", cls: "nm", w: "16%" },
            { h: "Tender", w: "14%" },
            { h: "Amount", r: true, w: "12%" },
            { h: "Status", w: "10%" },
          ]}
          rows={rows.map((b) => {
            const st = billStatus(b.pay);
            const day = billDay(b);
            return {
              key: b.no,
              onClick: () => openDrawer("cbill", b.no),
              cells: [
                <><span className="mono">{b.no}</span>{b.src === "qr" && <> <Pill tone="ac">QR</Pill></>}<small>{b.lines.length} item{b.lines.length === 1 ? "" : "s"}</small></>,
                <span className="mono">{day ? fromWireDate(day) : "-"}</span>,
                <span className="mono">{b.t}</span>,
                nameOf(b.loc),
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Avatar name={b.opr} color={b.oprCol} size={22} />
                  <span>{b.opr}</span>
                </div>,
                <>{b.pay}{b.payer && <span className="mini" style={{ display: "block" }}>{b.payer.name}</span>}</>,
                // The net, with what came off it underneath where there was a concession: this
                // is the screen a manager reconciles a day's takings on, and a bill that reads
                // ₹16 against a ₹20 shelf price with nothing to explain it is the question they
                // would otherwise have to open the bill to answer.
                <>{money(b.tot)}{b.disc ? <span className="mini" style={{ display: "block" }}>{b.discPct}% off {money(b.tot + b.disc)}</span> : null}</>,
                b.voided
                  ? <><Pill tone="cr">VOIDED</Pill>{b.voidReason && <span className="mini" style={{ display: "block" }}>{b.voidReason}</span>}</>
                  : <Pill tone={st.tone}>{st.label}</Pill>,
              ],
            };
          })}
          empty={filtered
            ? {
              title: "Nothing matches those filters",
              sub: `No bill matches ${[q && `“${q}”`, outlet && nameOf(outlet), tender && `tender ${tender}`].filter(Boolean).join(", ")}.`,
              action: <Btn size="sm" onClick={clearAll}>Clear filters</Btn>,
            }
            : { title: "No bill raised anywhere in the last seven days", sub: "The counters have not opened a till yet." }}
        />
        <TableFoot count={rows.length} extra={<>billed {money(billed)} · {voided.length} voided</>} />
      </Card>
    </>
  );
}
