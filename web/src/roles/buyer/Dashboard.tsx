import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IT, LOC } from "../../data/master";
import { vendorName } from "../../data/vendors";
import { useApp } from "../../store";
import { avail, daysCover, poValue, procurementList, stateTone, stockValue } from "../../lib/selectors";
import { U, fq, lakh, money0, sum } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, Feed, FilterBtn, Grid, Kpis, PageHead, Pill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { FeedItem, Row } from "../../ui/kit";
import type { PoStatus, TktLine } from "../../types";
import { cycle } from "./lib";

/** Procurement only ever buys what the central store carries: raw, packing and MRP goods.
 *  Finished goods and made-to-order drinks are produced in-house, never purchased. */
const BOUGHT: string[] = Object.keys(IT).filter(
  (k) => IT[k].t === "RAW" || IT[k].t === "PACK" || IT[k].t === "MRP",
);
const lineValue = (lines: TktLine[]) => sum(lines, (l) => l.qty * (IT[l.it]?.cost ?? 0));
/** A purchase order still represents an open commitment until it is fully
 *  received or cancelled — a partial receipt does not close it. */
const LIVE: PoStatus[] = ["Ordered", "Partially received"];

const STATES = ["All", "Out", "Below reorder", "Healthy"];
const COMMITMENTS = ["All", "On order", "On the list", "Nothing committed"];
const stateOf = (a: number, rl: number) => (a <= 0 ? "Out" : rl > 0 && a < rl ? "Below reorder" : "Healthy");

export default function Dashboard() {
  const s = useApp();
  const nav = useNavigate();

  const [q, setQ] = useState("");
  const [state, setState] = useState("All");
  const [commitment, setCommitment] = useState("All");

  const waiting = s.prq.filter((p) => p.st === "Sent");
  const pool = procurementList(s);
  const drafts = s.po.filter((o) => o.st === "Draft");
  const live = s.po.filter((o) => LIVE.includes(o.st));
  const partial = s.po.filter((o) => o.st === "Partially received");
  const liveValue = sum(live, poValue);

  const below = BOUGHT.filter((k) => IT[k].rl > 0 && avail(s, "store", k) < IT[k].rl);
  const zero = BOUGHT.filter((k) => avail(s, "store", k) <= 0);

  // The cover table's Commitment column distinguishes an item already tied to
  // a live purchase order from one that is merely approved and pooled,
  // waiting for a buyer to raise an order against it.
  const poolItems = new Set(pool.map((l) => l.it));
  const onLivePo = (k: string) => live.some((o) => o.lines.some((l) => l.it === k && l.qty - l.recv > 0));
  const commitmentOf = (k: string) =>
    onLivePo(k) ? "On order" : poolItems.has(k) ? "On the list" : "Nothing committed";

  const kpis = [
    {
      l: "Requisitions waiting on you", v: String(waiting.length),
      d: <>from the central store</>,
    },
    {
      l: "Items on the procurement list", v: String(pool.length),
      d: <>approved, not yet claimed by an order</>,
    },
    {
      l: "Drafts open", v: String(drafts.length),
      d: <>awaiting your review before they go to a vendor</>,
    },
    {
      l: "Value on order", v: lakh(liveValue),
      d: <>across {new Set(live.map((o) => o.vendor)).size} vendor(s)</>,
    },
    {
      l: `Stock value · ${LOC.store.n}`, v: lakh(stockValue(s, "store")),
      d: <>received goods land here directly</>,
    },
    {
      l: "Below reorder · central store", v: String(below.length),
      d: <>{zero.length} at zero</>,
    },
  ];

  const t = q.trim().toLowerCase();
  const filtered = BOUGHT.filter((k) => {
    const a = avail(s, "store", k);
    return (state === "All" || stateOf(a, IT[k].rl) === state)
      && (commitment === "All" || commitmentOf(k) === commitment)
      && (!t || IT[k].n.toLowerCase().includes(t) || IT[k].c.toLowerCase().includes(t)
        || IT[k].g.toLowerCase().includes(t));
  });
  const narrowed = t !== "" || state !== "All" || commitment !== "All";

  const cover = filtered
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
      <Pill tone={stateTone(a, IT[k].rl)}>{stateOf(a, IT[k].rl)}</Pill>,
      onLivePo(k) ? <Pill tone="in">On order</Pill>
        : poolItems.has(k) ? <Pill tone="wn">On the list</Pill>
          : <span className="dim">—</span>,
    ],
  }));

  // What used to be a bar chart. The same numbers read better as a table, and
  // the quantity outstanding is worth showing next to the money.
  const byItem = new Map<string, { qty: number; value: number }>();
  live.forEach((o) => o.lines.forEach((l) => {
    const at = byItem.get(l.it) ?? { qty: 0, value: 0 };
    at.qty += Math.max(0, l.qty - l.recv);
    at.value += l.qty * l.rate;
    byItem.set(l.it, at);
  }));
  const commitRows: Row[] = [...byItem.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .slice(0, 8)
    .map(([k, v]) => ({
      key: k,
      cells: [
        <>{IT[k]?.n ?? k}<small>{IT[k]?.c ?? ""}</small></>,
        <>{fq(v.qty, k)} <span className="dim">{U(k)}</span></>,
        <>{money0(v.value)}</>,
      ],
    }));

  const feed: FeedItem[] = [
    ...s.prq.map((p) => ({
      key: "p" + p.id,
      title: <>{p.id} · {p.st === "Sent" ? "requisition received" : p.st.toLowerCase()}</>,
      body: <>{p.by} · {p.lines.length} item{p.lines.length > 1 ? "s" : ""} · {money0(lineValue(p.lines))}</>,
      when: p.at,
      color: p.st === "Sent" ? "var(--warn)" : p.st === "Declined" ? "var(--crit)" : "var(--c1)",
    })),
    ...s.po.map((o) => ({
      key: "o" + o.id,
      title: <>{o.id} · {o.st === "Received" ? "goods received" : "raised on " + vendorName(s.vendors, o.vendor)}</>,
      body: <>{money0(poValue(o))} · expected {o.eta}</>,
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
          {p.by} raised <b>{p.id}</b> — {p.lines.length} item{p.lines.length > 1 ? "s" : ""},
          about {money0(lineValue(p.lines))}.{p.note ? " " + p.note : ""}
        </Alert>
      ))}
      {partial.map((o) => (
        <Alert key={o.id} tone="w" label="PARTIAL"
          action={<Btn size="xs" variant="gh" onClick={() => nav("/orders")}>Review</Btn>}>
          <b>{o.id}</b> with {vendorName(s.vendors, o.vendor)} is partially received —
          {" "}{money0(poValue(o))} on order, the balance is still outstanding.
        </Alert>
      ))}
      {zero.map((k) => (
        <Alert key={k} tone="c" label="AT ZERO"
          action={<Btn size="xs" variant="gh" onClick={() => nav("/inventory")}>See item</Btn>}>
          {IT[k].n} ({IT[k].c}) is at zero in the {LOC.store.n} — reorder level {fq(IT[k].rl, k)} {U(k)}.
        </Alert>
      ))}
      {waiting.length === 0 && partial.length === 0 && zero.length === 0 && (
        <Alert tone="g" label="CLEAR">
          Nothing is waiting on you. The {LOC.store.n} has raised no new requisition.
        </Alert>
      )}
      <div className="mtop" />

      <Grid cols="g21">
        <Card title="Central store cover" sub="The eight matching items closest to running out"
          right={<Btn variant="gh" size="sm" onClick={() => nav("/inventory")}>Full inventory</Btn>} flush>
          <Toolbar
            placeholder="Search item, code or group…"
            value={q}
            onSearch={setQ}
            filters={
              <>
                <FilterBtn label="State" value={state} onClick={() => setState(cycle(STATES, state))} />
                <FilterBtn label="Commitment" value={commitment}
                  onClick={() => setCommitment(cycle(COMMITMENTS, commitment))} />
              </>
            }
          />
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
            empty={narrowed
              ? {
                title: "Nothing matches those filters",
                sub: "Clear the search box or cycle State and Commitment back to All.",
                action: <Btn size="sm" variant="gh"
                  onClick={() => { setQ(""); setState("All"); setCommitment("All"); }}>Clear filters</Btn>,
              }
              : { title: "No purchased items on file", sub: "The item master carries nothing to buy." }}
          />
          <TableFoot count={coverRows.length} extra={<>{below.length} of {BOUGHT.length} below reorder</>} />
        </Card>
        <div>
          <Card title="Open commitments" sub="By item, on live purchase orders" flush>
            <DataTable
              cols={[
                { h: "Item", cls: "nm", w: "44%" },
                { h: "Outstanding", r: true },
                { h: "On order", r: true },
              ]}
              rows={commitRows}
              empty={{
                title: "Nothing on order",
                sub: "Raise a purchase order against a requisition to see commitments here.",
                action: <Btn size="sm" onClick={() => nav("/requisitions")}>Go to requisitions</Btn>,
              }}
            />
            <TableFoot count={commitRows.length} extra={<>{money0(liveValue)} on live orders</>} />
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
