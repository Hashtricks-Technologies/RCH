import { useNavigate } from "react-router-dom";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { availOf, menuOf } from "../../lib/selectors";
import { money, money0, sum, unitTotal } from "../../lib/fmt";
import {
  Alert, Avatar, Btn, Card, DataTable, Feed, Grid, Kpis, PageHead, StatusPill,
} from "../../ui/kit";
import { settlementOf } from "./status";
import type { ReqStatus } from "../../types";

const SETTLED: ReqStatus[] = ["Closed", "Cancelled", "Rejected", "Received"];
/** The float handed to the operator at the start of Shift 2, before a single bill is
 *  raised. It is the only figure on this card that is not derived from a bill. */
const OPENING_FLOAT = 2000;

export default function Dashboard() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const nav = useNavigate();
  const loc = user.loc;
  const L = LOC[loc];

  const mine = s.bills.filter((b) => b.loc === loc);
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
  const drawer = OPENING_FLOAT + cashTaken;

  const menu = menuOf(s, loc);
  const off = menu
    .map((it) => ({ it, a: availOf(s, loc, it) }))
    .filter((r) => !r.a.ok);

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
  const recentReq = myReq.slice().reverse().slice(0, 5);

  const rev: Record<string, { qty: number; amt: number }> = {};
  mine.forEach((b) => b.lines.forEach((l) => {
    const e = rev[l.it] ?? { qty: 0, amt: 0 };
    rev[l.it] = { qty: e.qty + l.qty, amt: e.amt + l.qty * l.rate };
  }));
  const top = Object.entries(rev).sort((a, b) => b[1].amt - a[1].amt).slice(0, 5);

  const feed = mine.slice(0, 5).map((b) => ({
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
        sub={`${L.c} · ${L.floor} · price list ${L.list ?? "—"} · figures are for today's shift at this counter only`}
        actions={<>
          <Btn variant="gh" onClick={() => nav("/requests")}>Raise a request</Btn>
          <Btn onClick={() => nav("/pos")}>Open till</Btn>
        </>}
      />

      <Kpis items={[
        { l: "Billed today", v: money0(billed), d: <>{L.n} · every tender</> },
        { l: "Cash in drawer", v: money0(drawer), d: <>float {money0(OPENING_FLOAT)} + {money0(cashTaken)} cash</> },
        { l: "Bills raised", v: String(mine.length), d: <>last bill {mine[0]?.t ?? "—"}</> },
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
        sub={`Everything ${L.n} has asked the central store for today`}
        right={<Btn variant="gh" size="sm" onClick={() => nav("/requests")}>All requests</Btn>}
      >
        <Kpis items={[
          { l: "Raised today", v: String(myReq.length), d: <>{openReq.length} still open</> },
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
                sub: "Open the till — the first bill of the shift starts this table.",
                action: <Btn size="sm" onClick={() => nav("/pos")}>Open till</Btn>,
              }}
            />
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
            <dt>Opening float</dt><dd className="mono">{money(OPENING_FLOAT)}</dd>
            <dt>Cash bills</dt>
            <dd className="mono">
              {money(cashTaken)} <span className="mini">({cashBills.length} of {mine.length})</span>
            </dd>
            <dt>Cash in drawer</dt><dd className="mono"><b>{money(drawer)}</b></dd>
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
            The <b>opening float</b> is the {money0(OPENING_FLOAT)} handed to you at the start of Shift 2, so cash in
            drawer = {money0(OPENING_FLOAT)} float + {money(cashTaken)} taken in cash = <b>{money(drawer)}</b> to count
            out at the end. Card and UPI are taken at the till but settle to the hospital account; patient, staff and
            department bills collect nothing at all. Neither belongs in the drawer, which is why{" "}
            <b>total billed {money(billed)}</b> and the drawer figure differ.
          </p>
        </Card>
      </Grid>
    </>
  );
}
