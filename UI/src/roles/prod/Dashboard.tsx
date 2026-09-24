import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { availOf, canHandOver, hasLeft, isTicketOpen, madeItems, qty } from "../../lib/selectors";
import { fq, isToday, sum, U } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, Feed, Grid, Kpis, PageHead, Pill, StatusPill, TableFoot,
} from "../../ui/kit";

export default function Dashboard() {
  const nav = useNavigate();
  const s = useApp();
  const openDrawer = useApp((x) => x.openDrawer);
  const { pord, batch, tkt, stock, rsv, ovr } = s;

  // The kitchen's own products, off the master rather than a literal - see `madeItems()`.
  const PRODS = useMemo(() => { void s.catalogVersion; return madeItems(); }, [s.catalogVersion]);

  const newOrders = useMemo(() => pord.filter((o) => o.st === "New"), [pord]);
  const working = useMemo(
    () => pord.filter((o) => o.st === "Accepted" || o.st === "In kitchen" || o.st === "Ready"),
    [pord],
  );
  const ready = useMemo(() => pord.filter((o) => o.st === "Ready"), [pord]);
  const raised = useMemo(() => tkt.filter((t) => t.from === "kitchen"), [tkt]);
  // What actually went out: still on its way, or already there. Same reading as Make &
  // Distribute's "Out of the kitchen today", and for the same reason - a ticket that was
  // taken back is not a dispatch, and counting it flattered the day's figure for ever.
  const dispatches = useMemo(() => raised.filter((t) => isTicketOpen(t.st) || hasLeft(t.st)), [raised]);
  const toHand = useMemo(() => dispatches.filter((t) => t.st === "Issued"), [dispatches]);
  // Still on its way: at the pass or in transit. A withdrawn ticket is neither.
  const moving = useMemo(() => dispatches.filter((t) => isTicketOpen(t.st)), [dispatches]);
  // A product the kitchen cannot make is as unavailable as one switched off by hand.
  // Memoised on the three slices `availOf` actually reads - `[s]` was a new object on every
  // write anywhere in the app, so it memoised nothing at all. The three are destructured off `s`
  // at the top rather than trimmed off the dependency array, so the array names every value the
  // memo uses and `react-hooks/exhaustive-deps` can check it instead of being argued with.
  const off = useMemo(
    () => PRODS.map((k) => ({ k, a: availOf({ stock, rsv, ovr }, "kitchen", k) })).filter((x) => !x.a.ok),
    [PRODS, stock, rsv, ovr],
  );

  // "Today" is the hospital's own IST day, not everything `GET /batches` returned: the batch log
  // carries more than one day of baking, and counting the lot under that word overstated the
  // shift from the first minute of it.
  const today = useMemo(() => batch.filter((b) => isToday(b.iso)), [batch]);
  const madeToday = sum(today, (b) => b.qty);
  const perProduct = PRODS.map((k) => ({
    n: IT[k]?.n ?? k,
    v: sum(today.filter((b) => b.it === k), (b) => b.qty),
    made: sum(today.filter((b) => b.it === k), (b) => b.made),
  }));

  const feed = useMemo(() => {
    const items = [
      ...batch.map((b) => ({
        key: "b-" + b.id,
        title: `${b.qty} ${IT[b.it]?.n ?? b.it} made`,
        body: `${b.id} · best before ${b.bb}`,
        when: b.at,
        color: "var(--c2)",
        t: b.at,
      })),
      ...pord.flatMap((o) =>
        o.hist.map((h, i) => ({
          key: `o-${o.id}-${i}`,
          title: `${o.id} - ${h.s}`,
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
        tip="Today's orders, batches and kitchen stock."
        actions={<>
          <Btn variant="gh" onClick={() => nav("/kitchen-orders")}>Orders</Btn>
          <Btn onClick={() => nav("/make")}>Make &amp; distribute</Btn>
        </>}
      />

      <Kpis items={[
        { l: "New orders waiting", v: newOrders.length, tip: <>needing accept or decline</> },
        { l: "Orders in progress", v: working.length, d: <><b>{openQty}</b> units promised</> },
        { l: "Ready to dispatch", v: ready.length, tip: <>waiting on the pass</> },
        { l: "Units made today", v: madeToday, d: <>across <b>{today.length}</b> batch{today.length === 1 ? "" : "es"}</> },
        { l: "Products not available", v: off.length, tip: <>switched off or nothing to give</> },
        { l: "Dispatches out today", v: dispatches.length, d: <><b>{toHand.length}</b> waiting at the pass</> },
      ]} />

      {newOrders.length > 0 && (
        <Alert tone="w" label="ORDERS" action={<Btn size="sm" variant="gh" onClick={() => nav("/kitchen-orders")}>Open orders</Btn>}>
          {newOrders.length} order{newOrders.length > 1 ? "s" : ""} from{" "}
          {[...new Set(newOrders.map((o) => LOC[o.from].n))].join(", ")} need your decision.
        </Alert>
      )}
      {ready.length > 0 && (
        <Alert tone="g" label="READY" action={<Btn size="sm" variant="gh" onClick={() => nav("/kitchen-orders")}>Dispatch</Btn>}>
          {ready.map((o) => o.id).join(", ")} {ready.length > 1 ? "are" : "is"} plated and waiting to go out.
        </Alert>
      )}
      {toHand.length > 0 && (
        <Alert tone="w" label="HAND OVER" action={<Btn size="sm" variant="gh" onClick={() => nav("/make")}>Open the pass</Btn>}>
          {toHand.map((t) => t.id).join(", ")} {toHand.length > 1 ? "are" : "is"} issued and still on the rack -
          scan {toHand.length > 1 ? "them" : "it"} out when the counter arrives.
        </Alert>
      )}
      {off.length > 0 && (
        <Alert tone="c" label="OFF" action={<Btn size="sm" variant="gh" onClick={() => nav("/avail")}>Review</Btn>}>
          {off.map(({ k, a }) => `${IT[k]?.n ?? k} (${a.mode === "Manual" ? "switched off" : a.why})`).join(", ")}{" "}
          - the kitchen cannot issue {off.length > 1 ? "these" : "this"} right now.
        </Alert>
      )}

      <Card title="What the kitchen is holding" tip="On the rack right now" scroll className="mtop">
        <div className="tilegrid">
          {PRODS.map((k) => {
            const on = !ovr["kitchen:" + k];
            const have = qty(s, "kitchen", k);
            return (
              <div className="tile" key={k}>
                <b style={{ fontSize: 12.5 }}>{IT[k]?.n ?? k}</b>
                <span className="mini">{IT[k]?.c ?? ""} · {IT[k]?.sl ?? 0} h shelf life</span>
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

      <Card title="Tickets out of the kitchen" tip="Issued and waiting at the pass, or handed over and in transit" flush scroll className="mtop">
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "18%" },
            { h: "To", w: "18%" },
            { h: "Items" },
            { h: "Qty", r: true, w: "10%" },
            { h: "Status", w: "12%" },
            { h: "Action", w: "17%" },
          ]}
          rows={moving.map((t) => ({
            key: t.id,
            cells: [
              <>{t.id}<small>{t.req}</small></>,
              <>{LOC[t.to].n}<div className="mini">{LOC[t.to].floor}</div></>,
              t.lines.map((l) => `${l.qty} × ${IT[l.it]?.n ?? l.it}`).join(" · "),
              <b>{sum(t.lines, (l) => l.qty)}</b>,
              <StatusPill status={t.st} />,
              // Opens the ticket's own window, where the collector's six digits are typed in.
              // Nothing hands a ticket over without them any more.
              canHandOver(t.st)
                ? <Btn size="sm" variant="ok" onClick={() => openDrawer("ptkt", t.id)}>Hand over</Btn>
                : <span className="mini dim">awaiting confirmation at {LOC[t.to].n}</span>,
            ],
          }))}
          empty={{
            title: "Nothing waiting to go out",
            sub: "Dispatch a ready order, or send stock out from Make & distribute.",
            action: <Btn size="sm" onClick={() => nav("/make")}>Make &amp; distribute</Btn>,
          }}
        />
        <TableFoot
          count={moving.length}
          extra={<>{toHand.length} at the pass · {moving.length - toHand.length} in transit</>}
        />
      </Card>

      <Grid cols="g21">
        <Card title="Units made today" tip="By product, from the batch log" flush scroll>
          <DataTable
            cols={[
              { h: "Product", cls: "nm" },
              { h: "Started", r: true, w: "22%" },
              { h: "Made", r: true, w: "22%" },
            ]}
            rows={perProduct.map((p) => ({
              key: p.n,
              cells: [p.n, <b>{p.v}</b>, <b>{p.made}</b>],
            }))}
            empty={{ title: "Nothing made yet today", sub: "Batches appear here as the kitchen books them." }}
          />
          <TableFoot count={perProduct.length} extra={<>Total made <b>{sum(batch, (b) => b.made)}</b></>} />
        </Card>
        <Card title="Today in the kitchen" tip="Batches and order movement">
          <Feed items={feed.map((f) => ({ key: f.key, title: f.title, body: f.body, when: f.when, color: f.color }))} />
        </Card>
      </Grid>
    </>
  );
}
