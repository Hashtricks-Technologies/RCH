import { useNavigate } from "react-router-dom";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { avail, daysCover, stateTone } from "../../lib/selectors";
import { U, fq, lakh, money0, sum } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, Feed, Grid, HBars, Kpis, PageHead, Pill, TableFoot,
} from "../../ui/kit";
import type { FeedItem, Row } from "../../ui/kit";
import type { TktLine } from "../../types";

/** Procurement only ever buys what the central store carries: raw, packing and traded goods.
 *  Finished goods and made-to-order drinks are produced in-house, never purchased. */
const BOUGHT: string[] = Object.keys(IT).filter(
  (k) => IT[k].t === "RAW" || IT[k].t === "PACK" || IT[k].t === "TRADED",
);
const lineValue = (lines: TktLine[]) => sum(lines, (l) => l.qty * (IT[l.it]?.cost ?? 0));

export default function Dashboard() {
  const s = useApp();
  const nav = useNavigate();

  const waiting = s.prq.filter((p) => p.st === "Sent");
  const ordered = s.po.filter((p) => p.st === "Ordered");
  const openValue = sum(waiting, (p) => lineValue(p.lines));
  const onOrderValue = sum(ordered, (p) => sum(p.lines, (l) => l.qty * l.rate));

  const below = BOUGHT.filter((k) => IT[k].rl > 0 && avail(s, "store", k) < IT[k].rl);
  const zero = BOUGHT.filter((k) => avail(s, "store", k) <= 0);

  const onRequisition = new Set(waiting.flatMap((p) => p.lines.map((l) => l.it)));
  const onOrder = new Set(ordered.flatMap((p) => p.lines.map((l) => l.it)));

  const kpis = [
    {
      l: "Requisitions waiting on you", v: String(waiting.length),
      d: <>from the central store</>, spark: [1, 0, 2, 1, 3, 1, waiting.length], color: "var(--c1)",
    },
    {
      l: "Value of open requisitions", v: money0(openValue),
      d: <>{sum(waiting, (p) => p.lines.length)} lines to price</>,
    },
    {
      l: "Purchase orders placed", v: String(s.po.length),
      d: <>{ordered.length} still open</>, spark: [2, 3, 2, 4, 3, 5, Math.max(1, s.po.length)], color: "var(--c2)",
    },
    {
      l: "Value on order", v: lakh(onOrderValue),
      d: <>across {new Set(ordered.map((p) => p.vendor)).size} vendor(s)</>,
    },
    {
      l: "Below reorder · central store", v: String(below.length),
      d: <>{zero.length} at zero</>, spark: [3, 4, 4, 5, 4, 6, Math.max(1, below.length)], color: "var(--c3)",
    },
    { l: "Average lead time", v: "2.4 d", d: <>order to goods receipt</> },
  ];

  const cover = BOUGHT
    .map((k) => ({ k, a: avail(s, "store", k), dc: daysCover(avail(s, "store", k), k) }))
    .sort((x, y) => x.dc - y.dc)
    .slice(0, 8);

  const coverRows: Row[] = cover.map(({ k, a, dc }) => ({
    key: k,
    cells: [
      <>{IT[k].n}<small>{IT[k].c}</small></>,
      <>{fq(a, k)} {U(k)}</>,
      <>{fq(IT[k].rl, k)}</>,
      <>{dc.toFixed(1)} d</>,
      <Pill tone={stateTone(a, IT[k].rl)}>
        {a <= 0 ? "Out" : IT[k].rl > 0 && a < IT[k].rl ? "Below reorder" : "Healthy"}
      </Pill>,
      onOrder.has(k) ? <Pill tone="in">On order</Pill>
        : onRequisition.has(k) ? <Pill tone="wn">On requisition</Pill>
          : <span className="dim">—</span>,
    ],
  }));

  const byItem = new Map<string, number>();
  ordered.forEach((p) => p.lines.forEach((l) => {
    byItem.set(l.it, (byItem.get(l.it) ?? 0) + l.qty * l.rate);
  }));
  const bars = [...byItem.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 7)
    .map(([k, v]) => ({ n: IT[k]?.n ?? k, v, f: money0(v) }));

  const feed: FeedItem[] = [
    ...s.prq.map((p) => ({
      key: "p" + p.id,
      title: <>{p.id} · {p.st === "Sent" ? "requisition received" : p.st.toLowerCase()}</>,
      body: <>{p.by} · {p.lines.length} line{p.lines.length > 1 ? "s" : ""} · {money0(lineValue(p.lines))}</>,
      when: p.at,
      color: p.st === "Sent" ? "var(--warn)" : p.st === "Declined" ? "var(--crit)" : "var(--c1)",
    })),
    ...s.po.map((o) => ({
      key: "o" + o.id,
      title: <>{o.id} · {o.st === "Received" ? "goods received" : "raised on " + o.vendor}</>,
      body: <>{money0(sum(o.lines, (l) => l.qty * l.rate))} · expected {o.eta}</>,
      when: o.recv ?? o.at,
      color: o.st === "Received" ? "var(--good)" : "var(--c2)",
    })),
  ].sort((a, b) => (b.when ?? "").localeCompare(a.when ?? "")).slice(0, 7);

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Procurement"]}
        title="Procurement dashboard"
        sub={`What the central store needs, what you have on order, and how ${LOC.store.n} is covered.`}
        actions={<Btn variant="gh" onClick={() => nav("/requisitions")}>Open requisitions</Btn>}
      />
      <Kpis items={kpis} />
      <div className="mtop" />

      {waiting.map((p) => (
        <Alert key={p.id} tone="w" label="WAITING"
          action={<Btn size="xs" variant="gh" onClick={() => nav("/requisitions")}>Review &amp; order</Btn>}>
          {p.by} raised <b>{p.id}</b> — {p.lines.length} line{p.lines.length > 1 ? "s" : ""},
          about {money0(lineValue(p.lines))}.{p.note ? " " + p.note : ""}
        </Alert>
      ))}
      {zero.map((k) => (
        <Alert key={k} tone="c" label="AT ZERO"
          action={<Btn size="xs" variant="gh" onClick={() => nav("/inventory")}>See item</Btn>}>
          {IT[k].n} ({IT[k].c}) is at zero in the {LOC.store.n} — reorder level {fq(IT[k].rl, k)} {U(k)}.
        </Alert>
      ))}
      {waiting.length === 0 && zero.length === 0 && (
        <Alert tone="g" label="CLEAR">
          Nothing is waiting on you. The {LOC.store.n} has raised no new requisition.
        </Alert>
      )}
      <div className="mtop" />

      <Grid cols="g21">
        <Card title="Central store cover" sub="Eight items closest to running out"
          right={<Btn variant="gh" size="sm" onClick={() => nav("/inventory")}>Full inventory</Btn>} flush>
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "30%" },
              { h: "On hand", r: true },
              { h: "Reorder", r: true },
              { h: "Days of cover", r: true },
              { h: "State" },
              { h: "Commitment" },
            ]}
            rows={coverRows}
            empty={{ title: "No purchased items on file", sub: "The item master carries nothing to buy." }}
          />
          <TableFoot count={coverRows.length} extra={<>{below.length} of {BOUGHT.length} below reorder</>} />
        </Card>
        <div>
          <Card title="Open commitments" sub="By item, on live purchase orders">
            {bars.length ? <HBars rows={bars} /> : (
              <div className="empty">
                <b>Nothing on order</b>
                <p>Raise a purchase order against a requisition to see commitments here.</p>
                <Btn size="sm" onClick={() => nav("/requisitions")}>Go to requisitions</Btn>
              </div>
            )}
          </Card>
          <div className="mtop" />
          <Card title="Recent procurement activity" sub="Requisitions and purchase orders">
            {feed.length ? <Feed items={feed} /> : (
              <div className="empty"><b>No activity yet</b><p>Activity appears once the store keeper raises a requisition.</p></div>
            )}
          </Card>
        </div>
      </Grid>
    </>
  );
}
