import { useNavigate } from "react-router-dom";
import { IT, LOC, OUTLETS } from "../../data/master";
import { useApp } from "../../store";
import { availOf, menuOf } from "../../lib/selectors";
import { money, money0, sum } from "../../lib/fmt";
import { Alert, Avatar, Btn, Card, Feed, Grid, HBars, Kpis, PageHead } from "../../ui/kit";
import type { ReqStatus } from "../../types";

const SETTLED: ReqStatus[] = ["Closed", "Cancelled", "Rejected", "Received"];
const OPENING_CASH = 2000;

export default function Dashboard() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const nav = useNavigate();
  const loc = user.loc;
  const L = LOC[loc];

  const mine = s.bills.filter((b) => b.loc === loc);
  const salesToday = sum(mine, (b) => b.tot);
  const itemsSold = sum(mine, (b) => sum(b.lines, (l) => l.qty));
  const avgBill = mine.length ? salesToday / mine.length : 0;
  const cashToday = sum(mine.filter((b) => b.pay === "Cash"), (b) => b.tot);

  const menu = menuOf(s, loc);
  const off = menu
    .map((it) => ({ it, a: availOf(s, loc, it) }))
    .filter((r) => !r.a.ok);

  const openReq = s.req.filter((r) => r.from === loc && !SETTLED.includes(r.st));
  const rejected = s.req.filter((r) => r.from === loc && r.st === "Rejected");
  const waiting = s.tkt.filter((t) => t.to === loc && t.st === "Issued");
  const inTransit = s.tkt.filter((t) => t.to === loc && t.st === "Collected");

  const si = Math.max(0, OUTLETS.indexOf(loc));
  const trend = s.sales.map((r) => r[si] ?? 0).slice(-7);
  const billTrend = trend.map((v) => Math.round(v / 118));
  const itemTrend = trend.map((v) => Math.round(v / 41));

  const rev: Record<string, number> = {};
  mine.forEach((b) => b.lines.forEach((l) => { rev[l.it] = (rev[l.it] ?? 0) + l.qty * l.rate; }));
  const top = Object.entries(rev)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([it, v]) => ({ n: IT[it]?.n ?? it, v, f: money0(v) }));

  const feed = mine.slice(0, 5).map((b) => ({
    key: b.no,
    title: <>{b.no} · {money(b.tot)}</>,
    body: <>{sum(b.lines, (l) => l.qty)} items · {b.pay}</>,
    when: b.t,
    color: b.pay === "Cash" ? "var(--c2)" : "var(--c1)",
  }));

  return (
    <>
      <PageHead
        crumbs={["Royal Care", L.n, "Dashboard"]}
        title={`${L.n} counter`}
        sub={`${L.c} · ${L.floor} · price list ${L.list ?? "—"} · figures are for today's shift at this counter only`}
        actions={<>
          <Btn variant="gh" onClick={() => nav("/requests")}>Raise a request</Btn>
          <Btn onClick={() => nav("/pos")}>Open till</Btn>
        </>}
      />

      <Kpis items={[
        { l: "Sales today", v: money0(salesToday), d: <>{L.n} · all tenders</>, spark: trend, color: "var(--c1)" },
        { l: "Bills raised", v: String(mine.length), d: <>last bill {mine[0]?.t ?? "—"}</>, spark: billTrend, color: "var(--c2)" },
        { l: "Items sold", v: String(itemsSold), d: <>across {menu.length} listed products</>, spark: itemTrend, color: "var(--c3)" },
        { l: "Average bill", v: money0(avgBill), d: <>{mine.length ? money(avgBill) : "no bills yet"}</> },
        { l: "Products switched off", v: String(off.length), d: <>of {menu.length} on this menu</> },
        { l: "Open requests", v: String(openReq.length), d: <>{waiting.length} ticket{waiting.length === 1 ? "" : "s"} to collect</> },
      ]} />

      {off.map((r) => (
        <Alert key={"off-" + r.it} tone="c" label="OFF">
          <b>{IT[r.it].n}</b> is not sellable — {r.a.why ?? "unavailable"} ({r.a.mode.toLowerCase()} check).
        </Alert>
      ))}
      {waiting.map((t) => (
        <Alert key={t.id} tone="w" label="COLLECT"
          action={<Btn size="xs" variant="gh" onClick={() => nav("/tickets")}>Open tickets</Btn>}>
          Ticket <b className="mono">{t.id}</b> is waiting at {LOC[t.from].n} — {t.lines.length} line{t.lines.length === 1 ? "" : "s"} against {t.req}.
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
      <Grid cols="g21">
        <div>
          <Card title="Top five sellers today" sub={`by revenue at ${L.n}`}>
            {top.length ? <HBars rows={top} /> : (
              <p className="mini">No sale has been billed at this counter yet today. Open the till to start.</p>
            )}
          </Card>
          <div className="mtop" />
          <Card title="Last five bills" sub="this counter" right={<Btn variant="gh" size="sm" onClick={() => nav("/bills")}>All bills</Btn>}>
            {feed.length ? <Feed items={feed} /> : (
              <p className="mini">Nothing billed yet. The first bill of the shift will appear here.</p>
            )}
          </Card>
        </div>

        <Card title="Your shift" sub={`Shift 2 · ${L.floor}`}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14 }}>
            <Avatar name={user.n} color={user.col} size={44} />
            <div>
              <b style={{ fontSize: 14 }}>{user.n}</b>
              <div className="mini">{user.rl} · {user.emp}</div>
            </div>
          </div>
          <dl className="dl">
            <dt>Outlet</dt><dd>{L.n} <span className="mini">({L.c})</span></dd>
            <dt>Shift</dt><dd>Shift 2 · 14:00 – 22:00</dd>
            <dt>Terminal</dt><dd className="mono">{L.c}</dd>
            <dt>Cost centre</dt><dd className="mono">{L.cc}</dd>
            <dt>Opening cash</dt><dd className="mono">{money0(OPENING_CASH)}</dd>
            <dt>Cash collected</dt><dd className="mono">{money(cashToday)}</dd>
            <dt>Drawer expected</dt><dd className="mono">{money(OPENING_CASH + cashToday)}</dd>
          </dl>
          <p className="mini mtop">
            Card, UPI and patient-bill takings settle to the hospital account and are not counted in the drawer.
          </p>
        </Card>
      </Grid>
    </>
  );
}
