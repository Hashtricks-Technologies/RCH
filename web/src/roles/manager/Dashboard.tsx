import { useNavigate } from "react-router-dom";
import { IT, LOC, OUTLETS } from "../../data/master";
import { DAY_LABELS } from "../../data/seed";
import { useApp } from "../../store";
import { availOf, menuOf, stockValue } from "../../lib/selectors";
import { lakh, money, money0, sum } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, Grid, HBars, Kpis, LineChart, PageHead, Pill, TableFoot,
} from "../../ui/kit";
import type { LocKey } from "../../types";

const SERIES_COLOURS = ["var(--c1)", "var(--c2)", "var(--c3)"];

interface Off { n: number; manual: number; stock: number; recipe: number }

const why = (o: Off) =>
  [
    o.manual ? `${o.manual} switched off` : "",
    o.stock ? `${o.stock} out of stock` : "",
    o.recipe ? `${o.recipe} missing an ingredient` : "",
  ].filter(Boolean).join(" · ");

export default function Dashboard() {
  const s = useApp();
  const nav = useNavigate();

  /* A manual switch is only one of the three ways a product stops selling (H5). */
  const offAt = (loc: LocKey): Off => {
    const bad = menuOf(s, loc).map((it) => availOf(s, loc, it)).filter((a) => !a.ok);
    return {
      n: bad.length,
      manual: bad.filter((a) => a.mode === "Manual").length,
      stock: bad.filter((a) => a.mode === "Stock").length,
      recipe: bad.filter((a) => a.mode === "Recipe").length,
    };
  };

  const rows = OUTLETS.map((loc, i) => {
    const bills = s.bills.filter((b) => b.loc === loc);
    const sales = sum(bills, (b) => b.tot);
    return {
      loc,
      i,
      name: LOC[loc].n,
      bills: bills.length,
      sales,
      avg: bills.length ? sales / bills.length : 0,
      value: stockValue(s, loc),
      off: offAt(loc),
      trail: s.sales.map((d) => d[i] ?? 0),
    };
  });

  const total = sum(rows, (r) => r.sales);
  const billCount = sum(rows, (r) => r.bills);
  const best = rows.reduce((a, b) => (b.sales > a.sales ? b : a), rows[0]);
  const offAll: Off = {
    n: sum(rows, (r) => r.off.n),
    manual: sum(rows, (r) => r.off.manual),
    stock: sum(rows, (r) => r.off.stock),
    recipe: sum(rows, (r) => r.off.recipe),
  };
  const totalOff = offAll.n;
  const offOutlets = rows.filter((r) => r.off.n > 0);
  const dayTotals = s.sales.map((d) => (d[0] ?? 0) + (d[1] ?? 0) + (d[2] ?? 0));

  const waiting = s.req.filter((r) => r.st === "Request sent");
  const urgent = waiting.filter((r) => r.urg).length;

  const revenue: Record<string, number> = {};
  for (const b of s.bills) {
    for (const l of b.lines) revenue[l.it] = (revenue[l.it] ?? 0) + l.qty * l.rate;
  }
  const topItems = Object.entries(revenue)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([k, v]) => ({ n: IT[k]?.n ?? k, v, f: money0(v) }));

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Outlets", "Dashboard"]}
        title="Outlet performance"
        sub="Restaurant, Coffee Shop and Snack Kiosk — sales, stock cover and everything waiting on your decision."
        actions={<Btn variant="gh" onClick={() => nav("/approvals")}>Open approvals</Btn>}
      />

      {waiting.length > 0 && (
        <Alert
          tone="w"
          label="QUEUE"
          action={<Btn size="xs" variant="gh" onClick={() => nav("/approvals")}>Review now</Btn>}
        >
          <b>{waiting.length}</b> stock request{waiting.length > 1 ? "s are" : " is"} waiting on your approval
          {urgent > 0 ? <> — <b>{urgent}</b> marked urgent by the counter</> : null}. Nothing moves out of the
          Central Store until you approve the quantities.
        </Alert>
      )}
      {offOutlets.length > 0 && (
        <Alert tone="c" label="OFF" action={<Btn size="xs" variant="gh" onClick={() => nav("/avail")}>Product on / off</Btn>}>
          <b>{totalOff}</b> product{totalOff > 1 ? "s" : ""} cannot be billed at{" "}
          {offOutlets.map((r) => r.name).join(", ")} — {why(offAll)}.
        </Alert>
      )}

      <Kpis
        items={[
          {
            l: "Sales today · all outlets",
            v: money0(total),
            d: <>{billCount} bills across {OUTLETS.length} counters</>,
            spark: dayTotals,
            color: "var(--c1)",
          },
          {
            l: "Best performing outlet",
            v: best.name,
            d: <>{money0(best.sales)} · {total > 0 ? Math.round((best.sales / total) * 100) : 0}% of the day</>,
            spark: best.trail,
            color: SERIES_COLOURS[best.i],
          },
          { l: "Bills today", v: String(billCount), d: <>Last bill {s.bills[0]?.t ?? "—"}</> },
          {
            l: "Average bill",
            v: money(billCount ? total / billCount : 0),
            d: <>Across every counter</>,
          },
          {
            l: "Requests awaiting your approval",
            v: String(waiting.length),
            d: urgent > 0 ? <><Pill tone="cr">{urgent} urgent</Pill></> : <>Nothing marked urgent</>,
          },
          {
            l: "Products that cannot be sold",
            v: String(totalOff),
            d: totalOff > 0 ? <>{why(offAll)}</> : <>Every listed product is sellable</>,
          },
        ]}
      />

      <Grid cols="g21">
        <Card title="Daily sales by outlet" sub="Last 14 days">
          <LineChart
            labels={DAY_LABELS}
            series={rows.map((r) => ({ k: r.name, c: SERIES_COLOURS[r.i], vals: r.trail }))}
          />
        </Card>
        <Card title="Top items by revenue" sub="All outlets, today">
          {topItems.length > 0
            ? <HBars rows={topItems} />
            : <p className="mini">No bills have been raised at any counter yet today.</p>}
        </Card>
      </Grid>

      <Card title="Outlet comparison" sub="Today against stock on hand" flush>
        <DataTable
          cols={[
            { h: "Outlet", cls: "nm", w: "18%" },
            { h: "Floor" },
            { h: "Today's sales", r: true },
            { h: "Bills", r: true },
            { h: "Average bill", r: true },
            { h: "Stock value", r: true },
            { h: "Products off", r: true },
            { h: "Share of sales", w: "15%" },
          ]}
          rows={rows.map((r) => ({
            key: r.loc,
            cells: [
              <>{r.name}<small>{LOC[r.loc].c} · {LOC[r.loc].cc}</small></>,
              LOC[r.loc].floor,
              <b>{money0(r.sales)}</b>,
              r.bills,
              money(r.bills ? r.sales / r.bills : 0),
              lakh(r.value),
              r.off.n > 0
                ? <><Pill tone="wn">{r.off.n}</Pill><small className="dim" style={{ display: "block" }}>{why(r.off)}</small></>
                : <span className="dim">0</span>,
              <>
                <span className="bar" style={{ width: 76 }}>
                  <i style={{ width: `${total > 0 ? (r.sales / total) * 100 : 0}%` }} />
                </span>
                <span className="mini" style={{ marginLeft: 8 }}>
                  {total > 0 ? Math.round((r.sales / total) * 100) : 0}%
                </span>
              </>,
            ],
          }))}
          empty={{ title: "No outlets configured", sub: "Three selling counters are expected." }}
        />
        <TableFoot
          count={rows.length}
          extra={<>Sales {money0(total)} · stock at counters {lakh(sum(rows, (r) => r.value))}</>}
        />
      </Card>
    </>
  );
}
