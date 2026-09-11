import { useNavigate } from "react-router-dom";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { availOf, menuOf } from "../../lib/selectors";
import { isToday, money, money0, sum, unitTotal } from "../../lib/fmt";
import {
  Alert, Avatar, Btn, Card, DataTable, Feed, Grid, Kpis, PageHead, StatusPill,
} from "../../ui/kit";
import { settlementOf } from "./status";
import type { ReqStatus } from "../../types";

const SETTLED: ReqStatus[] = ["Closed", "Cancelled", "Rejected", "Received"];

export default function Dashboard() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const nav = useNavigate();
  const loc = user.loc;
  const L = LOC[loc];

  // Every figure on this page is labelled "today", and `GET /bills` answers with seven days of
  // them. Until this filter existed the word was simply untrue: a Monday-morning shift opened
  // showing the previous week's takings. `isToday` reads the instant the store kept beside the
  // printed time, and the day it compares against is the hospital's, not the terminal's.
  //
  // ---- bill void: a bill somebody took back is not takings and the items on it were not sold.
  // It stays on the bill list, badged; every figure on this dashboard is drawn from `mine`.
  const mine = s.bills.filter((b) => b.loc === loc && isToday(b.iso) && !b.voided);
  // `?? ""` rather than a bare compare: a row that reaches the store without an instant should
  // sort to the bottom, not throw the whole dashboard into the error boundary.
  const latest = mine.slice().sort((a, b) => (b.iso ?? "").localeCompare(a.iso ?? ""));
  const billed = sum(mine, (b) => b.tot);
  const itemsSold = sum(mine, (b) => sum(b.lines, (l) => l.qty));
  const avgBill = mine.length ? billed / mine.length : 0;

  // Cash is the tender, not the total: a bill charged to a patient, to staff credit
  // or to a department is billed value and never reaches this drawer.
  const cashBills = mine.filter((b) => settlementOf(b.pay) === "drawer");
  const bankBills = mine.filter((b) => settlementOf(b.pay) === "bank");
  const acctBills = mine.filter((b) => settlementOf(b.pay) === "account");
  const cashTaken = sum(cashBills, (b) => b.tot);
  const banked = sum(bankBills, (b) => b.tot);
  const charged = sum(acctBills, (b) => b.tot);

  const menu = menuOf(s, loc);
  const off = menu
    .map((it) => ({ it, a: availOf(s, loc, it) }))
    .filter((r) => !r.a.ok);

  // Requests are not a "today" figure — an ask raised on Friday is still open on Monday — so
  // the whole list stands. Only the order is by instant, newest first.
  const myReq = s.req.filter((r) => r.from === loc);
  const openReq = myReq.filter((r) => !SETTLED.includes(r.st));
  const rejected = myReq.filter((r) => r.st === "Rejected");
  const withManager = myReq.filter((r) => r.st === "Request sent" || r.st === "Draft");
  const awaitingTicket = myReq.filter(
    (r) => (r.st === "Manager approved" || r.st === "Partially approved") && !r.ticket,
  );
  const waiting = s.tkt.filter((t) => t.to === loc && t.st === "Issued");
  const inTransit = s.tkt.filter((t) => t.to === loc && t.st === "Collected");
  // What a manager trimmed off a request and will never be issued against it.
  const shortLines = myReq.flatMap((r) =>
    r.lines.filter((l) => (l.short ?? 0) > 0).map((l) => ({ it: l.it, qty: l.short ?? 0 })));
  const shortReqs = myReq.filter((r) => r.lines.some((l) => (l.short ?? 0) > 0)).length;
  // `myReq` is unfiltered — a request from any day is still this counter's to chase — so this
  // is the one sort here that can meet an older document. Undated sorts last rather than throwing.
  const recentReq = myReq.slice().sort((a, b) => (b.iso ?? "").localeCompare(a.iso ?? "")).slice(0, 5);

  const rev: Record<string, { qty: number; amt: number }> = {};
  mine.forEach((b) => b.lines.forEach((l) => {
    const e = rev[l.it] ?? { qty: 0, amt: 0 };
    rev[l.it] = { qty: e.qty + l.qty, amt: e.amt + l.qty * l.rate };
  }));
  const top = Object.entries(rev).sort((a, b) => b[1].amt - a[1].amt).slice(0, 5);

  const feed = latest.slice(0, 5).map((b) => ({
    key: b.no,
    title: <>{b.no} · {money(b.tot)}</>,
    body: <>{sum(b.lines, (l) => l.qty)} items · {b.pay}</>,
    when: b.t,
    color: settlementOf(b.pay) === "drawer" ? "var(--c2)" : "var(--c1)",
  }));

  return (
    <>
      <PageHead
        crumbs={["Royal Care", L.n, "Dashboard"]}
        title={`${L.n} counter`}
        sub={`${L.c} · ${L.floor} · price list ${L.list ?? "—"} · figures are for today at this counter only`}
        actions={<>
          <Btn variant="gh" onClick={() => nav("/requests")}>Raise a request</Btn>
          <Btn onClick={() => nav("/pos")}>Open till</Btn>
        </>}
      />

      <Kpis items={[
        { l: "Billed today", v: money0(billed), d: <>{L.n} · every tender</> },
        { l: "Cash taken today", v: money0(cashTaken), d: <>{cashBills.length} of {mine.length} bill{mine.length === 1 ? "" : "s"}</> },
        { l: "Bills raised", v: String(mine.length), d: <>last bill {latest[0]?.t ?? "—"}</> },
        { l: "Items sold", v: String(itemsSold), d: <>across {menu.length} listed products</> },
        { l: "Average bill", v: money0(avgBill), d: <>{mine.length ? money(avgBill) : "no bills yet"}</> },
        { l: "Products switched off", v: String(off.length), d: <>of {menu.length} on this menu</> },
      ]} />

      {off.map((r) => (
        <Alert key={"off-" + r.it} tone="c" label="OFF">
          <b>{IT[r.it].n}</b> is not sellable — {r.a.why ?? "unavailable"} ({r.a.mode.toLowerCase()} check).
        </Alert>
      ))}
      {waiting.map((t) => (
        <Alert key={t.id} tone="w" label="COLLECT"
          action={<Btn size="xs" variant="gh" onClick={() => nav("/tickets")}>Open tickets</Btn>}>
          Ticket <b className="mono">{t.id}</b> is waiting at {LOC[t.from].n} — {t.lines.length} item{t.lines.length === 1 ? "" : "s"} against {t.req}.
        </Alert>
      ))}
      {inTransit.map((t) => (
        <Alert key={t.id} tone="i" label="TRANSIT"
          action={<Btn size="xs" variant="gh" onClick={() => nav("/tickets")}>Confirm receipt</Btn>}>
          Ticket <b className="mono">{t.id}</b> has been handed over and is on its way here.
        </Alert>
      ))}
      {rejected.map((r) => (
        <Alert key={r.id} tone="c" label="REJECTED"
          action={<Btn size="xs" variant="gh" onClick={() => nav("/requests")}>View request</Btn>}>
          <b className="mono">{r.id}</b> was rejected by the outlet manager{r.mgrNote ? ` — "${r.mgrNote}"` : ""}.
        </Alert>
      ))}

      <div className="mtop" />
      <Card
        title="Stock requests from this counter"
        sub={`Everything ${L.n} has asked the central store for`}
        right={<Btn variant="gh" size="sm" onClick={() => nav("/requests")}>All requests</Btn>}
      >
        <Kpis items={[
          // Not "today": a request raised on Friday is still open on Monday and is still this
          // counter's to chase, so the whole list is counted rather than one day of it.
          { l: "Requests raised", v: String(myReq.length), d: <>{openReq.length} still open</> },
          { l: "With the outlet manager", v: String(withManager.length), d: <>awaiting approval</> },
          { l: "Approved, no ticket yet", v: String(awaitingTicket.length), d: <>waiting on the store keeper</> },
          { l: "Tickets to collect", v: String(waiting.length), d: <>stock reserved at the store</> },
          { l: "In transit", v: String(inTransit.length), d: <>handed over, not yet received</> },
          {
            l: "Quantity short",
            v: shortLines.length ? unitTotal(shortLines) : "None",
            d: shortLines.length
              ? <>trimmed on {shortReqs} request{shortReqs === 1 ? "" : "s"}</>
              : <>nothing was trimmed</>,
          },
        ]} />
        <div className="mtop" />
        <DataTable
          cols={[
            { h: "Request ID", cls: "nm", w: "22%" },
            { h: "Items", w: "30%" },
            { h: "Asked", r: true, w: "12%" },
            { h: "Approved", r: true, w: "13%" },
            { h: "Status", w: "23%" },
          ]}
          rows={recentReq.map((r) => {
            const first = IT[r.lines[0]?.it]?.n ?? "—";
            const more = r.lines.length - 1;
            const appr = sum(r.lines, (l) => l.appr);
            return {
              key: r.id,
              onClick: () => s.openDrawer("creq", r.id),
              cells: [
                <><span className="mono">{r.id}</span><small>{r.at} · by {r.by}</small></>,
                <>{r.lines.length} item{r.lines.length === 1 ? "" : "s"} · {first}{more > 0 ? ` +${more} more` : ""}</>,
                sum(r.lines, (l) => l.qty),
                appr > 0 ? appr : <span className="dim">—</span>,
                <StatusPill status={r.st} />,
              ],
            };
          })}
          empty={{
            title: "No request raised from this counter yet",
            sub: "Raise one against the central store and it will be tracked here until the stock is on the shelf.",
            action: <Btn size="sm" onClick={() => nav("/requests")}>Raise a request</Btn>,
          }}
        />
      </Card>

      <div className="mtop" />
      <Grid cols="g21">
        <div>
          <Card title="Top five sellers today" sub={`by revenue at ${L.n}`}>
            <DataTable
              cols={[
                { h: "Product", cls: "nm", w: "46%" },
                { h: "Code", w: "18%" },
                { h: "Sold", r: true, w: "16%" },
                { h: "Revenue", r: true, w: "20%" },
              ]}
              rows={top.map(([it, v]) => ({
                key: it,
                cells: [
                  IT[it]?.n ?? it,
                  <span className="mono">{IT[it]?.c ?? "—"}</span>,
                  v.qty,
                  money(v.amt),
                ],
              }))}
              empty={{
                title: "Nothing billed at this counter yet",
                sub: "Open the till — the first bill of the day starts this table.",
                action: <Btn size="sm" onClick={() => nav("/pos")}>Open till</Btn>,
              }}
            />
          </Card>
          <div className="mtop" />
          <Card title="Last five bills" sub="this counter" right={<Btn variant="gh" size="sm" onClick={() => nav("/bills")}>All bills</Btn>}>
            {feed.length ? <Feed items={feed} /> : (
              <p className="mini">Nothing billed today. The first bill will appear here.</p>
            )}
          </Card>
        </div>

        {/* This was "Your shift", and it printed a Shift 2, its hours and a ₹2,000 opening
            float — none of which the system knows: shifts and float declarations were declined
            for this release, so every one of those figures was invented at render time and the
            drawer total built on top of them was wrong by whatever the real float was. What is
            left is what the bills actually say. */}
        <Card title="Today at this counter" sub={L.floor}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14 }}>
            <Avatar name={user.n} color={user.col} size={44} />
            <div>
              <b style={{ fontSize: 14 }}>{user.n}</b>
              <div className="mini">{user.rl} · {user.emp}</div>
            </div>
          </div>
          <dl className="dl">
            <dt>Outlet</dt><dd>{L.n} <span className="mini">({L.c})</span></dd>
            <dt>Terminal</dt><dd className="mono">{L.c}</dd>
            <dt>Cost centre</dt><dd className="mono">{L.cc}</dd>
            <dt>Cash bills</dt>
            <dd className="mono">
              {money(cashTaken)} <span className="mini">({cashBills.length} of {mine.length})</span>
            </dd>
            <dt>Card &amp; UPI</dt>
            <dd className="mono">
              {money(banked)} <span className="mini">({bankBills.length} bill{bankBills.length === 1 ? "" : "s"})</span>
            </dd>
            <dt>Charged to accounts</dt>
            <dd className="mono">
              {money(charged)} <span className="mini">({acctBills.length} bill{acctBills.length === 1 ? "" : "s"})</span>
            </dd>
            <dt>Total billed</dt><dd className="mono"><b>{money(billed)}</b></dd>
          </dl>
          <p className="mini mtop">
            <b>Cash taken {money(cashTaken)}</b> is what the till has collected in notes today — add whatever float you
            were handed to get what should be counted out. Card and UPI are taken here but settle to the hospital
            account; patient, staff and department bills collect nothing at the counter at all. Neither is cash, which
            is why <b>total billed {money(billed)}</b> is the larger figure.
          </p>
        </Card>
      </Grid>
    </>
  );
}
