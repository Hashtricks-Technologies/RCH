import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { qty } from "../../lib/selectors";
import { fq, sum, U } from "../../lib/fmt";
import { Alert, Btn, Card, Feed, Grid, HBars, Kpis, PageHead, Pill } from "../../ui/kit";

const PRODS = ["puff", "sand", "salad"];

export default function Dashboard() {
  const nav = useNavigate();
  const s = useApp();
  const { pord, batch, tkt, ovr } = s;

  const newOrders = useMemo(() => pord.filter((o) => o.st === "New"), [pord]);
  const working = useMemo(
    () => pord.filter((o) => o.st === "Accepted" || o.st === "In kitchen" || o.st === "Ready"),
    [pord],
  );
  const ready = useMemo(() => pord.filter((o) => o.st === "Ready"), [pord]);
  const dispatches = useMemo(() => tkt.filter((t) => t.from === "kitchen"), [tkt]);
  const off = useMemo(
    () => Object.keys(ovr).filter((k) => k.startsWith("kitchen:")).map((k) => k.slice(8)),
    [ovr],
  );

  const madeToday = sum(batch, (b) => b.qty);
  const perProduct = PRODS.map((k) => ({
    n: IT[k].n,
    v: sum(batch.filter((b) => b.it === k), (b) => b.qty),
  }));

  const feed = useMemo(() => {
    const items = [
      ...batch.map((b) => ({
        key: "b-" + b.id,
        title: `${b.qty} ${IT[b.it].n} made`,
        body: `${b.id} · best before ${b.bb}`,
        when: b.at,
        color: "var(--c2)",
        t: b.at,
      })),
      ...pord.flatMap((o) =>
        o.hist.map((h, i) => ({
          key: `o-${o.id}-${i}`,
          title: `${o.id} — ${h.s}`,
          body: `${LOC[o.from].n} · ${h.who}`,
          when: h.t,
          color: h.s === "Dispatched" ? "var(--c3)" : "var(--c1)",
          t: h.t,
        })),
      ),
    ];
    return items.sort((a, b) => b.t.localeCompare(a.t)).slice(0, 12);
  }, [batch, pord]);

  const openQty = sum(working.flatMap((o) => o.lines), (l) => l.qty);

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Kitchen"]}
        title="Kitchen dashboard"
        sub="Orders from the outlets, what has been made today and what is on the kitchen rack."
        actions={<>
          <Btn variant="gh" onClick={() => nav("/orders")}>Orders</Btn>
          <Btn onClick={() => nav("/make")}>Make &amp; distribute</Btn>
        </>}
      />

      <Kpis items={[
        { l: "New orders waiting", v: newOrders.length, d: <>needing accept or decline</>, spark: [1, 0, 2, 1, 3, 2, newOrders.length], color: "var(--c1)" },
        { l: "Orders in progress", v: working.length, d: <><b>{openQty}</b> units promised</>, spark: [2, 3, 2, 4, 3, 3, working.length], color: "var(--c2)" },
        { l: "Ready to dispatch", v: ready.length, d: <>waiting on the pass</> },
        { l: "Units made today", v: madeToday, d: <>across <b>{batch.length}</b> batch{batch.length === 1 ? "" : "es"}</>, spark: [40, 62, 88, 96, 104, 116, madeToday], color: "var(--c3)" },
        { l: "Products switched off", v: off.length, d: <>not being made today</> },
        { l: "Dispatches out today", v: dispatches.length, d: <>pick tickets from the kitchen</> },
      ]} />

      {newOrders.length > 0 && (
        <Alert tone="w" label="ORDERS" action={<Btn size="sm" variant="gh" onClick={() => nav("/orders")}>Open orders</Btn>}>
          {newOrders.length} order{newOrders.length > 1 ? "s" : ""} from{" "}
          {[...new Set(newOrders.map((o) => LOC[o.from].n))].join(", ")} need your decision.
        </Alert>
      )}
      {ready.length > 0 && (
        <Alert tone="g" label="READY" action={<Btn size="sm" variant="gh" onClick={() => nav("/orders")}>Dispatch</Btn>}>
          {ready.map((o) => o.id).join(", ")} {ready.length > 1 ? "are" : "is"} plated and waiting to go out.
        </Alert>
      )}
      {off.length > 0 && (
        <Alert tone="c" label="OFF" action={<Btn size="sm" variant="gh" onClick={() => nav("/avail")}>Review</Btn>}>
          {off.map((k) => IT[k]?.n ?? k).join(", ")} switched off in the kitchen — nothing is being made or issued.
        </Alert>
      )}

      <Card title="What the kitchen is holding" sub="On the rack right now" className="mtop">
        <div className="tilegrid">
          {PRODS.map((k) => {
            const on = !ovr["kitchen:" + k];
            const have = qty(s, "kitchen", k);
            return (
              <div className="tile" key={k}>
                <b style={{ fontSize: 12.5 }}>{IT[k].n}</b>
                <span className="mini">{IT[k].c} · {IT[k].sl ?? 0} h shelf life</span>
                <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-.03em" }}>
                  {fq(have, k)} <span className="mini">{U(k)}</span>
                </div>
                <div className="sp" />
                <Pill tone={on ? (have > 0 ? "ok" : "wn") : "cr"}>{on ? "Switched on" : "Switched off"}</Pill>
              </div>
            );
          })}
        </div>
      </Card>

      <Grid cols="g21">
        <Card title="Units made today" sub="By product, from the batch log">
          <HBars rows={perProduct.map((p) => ({ n: p.n, v: p.v, f: String(p.v) }))} />
        </Card>
        <Card title="Today in the kitchen" sub="Batches and order movement">
          <Feed items={feed.map((f) => ({ key: f.key, title: f.title, body: f.body, when: f.when, color: f.color }))} />
        </Card>
      </Grid>
    </>
  );
}
