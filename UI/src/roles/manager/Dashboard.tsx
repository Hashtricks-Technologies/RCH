import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IT, LOC, OUTLETS } from "../../data/master";
import { useApp } from "../../store";
import { availOf, isTicketOpen, menuOf, stockValue } from "../../lib/selectors";
import { lakh, money, money0, sum, unitTotal } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, FilterSelect, PageHead, Pill, TableFoot, Toolbar,
} from "../../ui/kit";
import { emptyFor, sortRows, useSort, type SortValue } from "./useSort";
import type { LocKey, StockRequest } from "../../types";

interface Off { n: number; manual: number; stock: number; recipe: number }

const why = (o: Off) =>
  [
    o.manual ? `${o.manual} switched off` : "",
    o.stock ? `${o.stock} out of stock` : "",
    o.recipe ? `${o.recipe} missing an ingredient` : "",
  ].filter(Boolean).join(" · ");

const PRIORITY = ["All", "Urgent", "Normal"] as const;
const ACTIVITY = ["All", "Bills", "Requests", "Shop transfers"] as const;

interface Act { key: string; kind: (typeof ACTIVITY)[number]; t: string; what: string; where: string; who: string }

export default function Dashboard() {
  const s = useApp();
  const nav = useNavigate();
  const openDrawer = useApp((x) => x.openDrawer);

  const [rq, setRq] = useState("");
  const [outlet, setOutlet] = useState(0);
  const [prio, setPrio] = useState(0);
  const [aq, setAq] = useState("");
  const [akind, setAkind] = useState(0);

  const queue = useSort("at", "desc");
  const outletSort = useSort("sales", "desc");
  const actSort = useSort("t", "desc");

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

  const outlets = OUTLETS.map((loc) => {
    const bills = s.bills.filter((b) => b.loc === loc);
    const sales = sum(bills, (b) => b.tot);
    return {
      loc,
      name: LOC[loc].n,
      floor: LOC[loc].floor,
      bills: bills.length,
      sales,
      value: stockValue(s, loc),
      off: offAt(loc),
    };
  });

  const total = sum(outlets, (r) => r.sales);
  const offAll: Off = {
    n: sum(outlets, (r) => r.off.n),
    manual: sum(outlets, (r) => r.off.manual),
    stock: sum(outlets, (r) => r.off.stock),
    recipe: sum(outlets, (r) => r.off.recipe),
  };
  const offOutlets = outlets.filter((r) => r.off.n > 0);

  /* Shop to shop: the goods never pass through the manager, so this is oversight only. */
  const transfers = s.tkt.filter((t) => OUTLETS.includes(t.from) && OUTLETS.includes(t.to));
  const moving = transfers.filter((t) => isTicketOpen(t.st));

  const waiting = s.req.filter((r) => r.st === "Request sent");
  const urgent = waiting.filter((r) => r.urg).length;

  /* ---- queue table: search + outlet + priority, all wired ---- */
  const outletNames = ["All", ...OUTLETS.map((l) => LOC[l].n)];
  const rTerm = rq.trim().toLowerCase();
  const lineNames = (r: StockRequest) => r.lines.map((l) => IT[l.it]?.n ?? l.it).join(", ");
  const queueRows = waiting
    .filter((r) => outlet === 0 || LOC[r.from].n === outletNames[outlet])
    .filter((r) => prio === 0 || (prio === 1 ? r.urg : !r.urg))
    .filter((r) => !rTerm
      || r.id.toLowerCase().includes(rTerm)
      || r.by.toLowerCase().includes(rTerm)
      || LOC[r.from].n.toLowerCase().includes(rTerm)
      || lineNames(r).toLowerCase().includes(rTerm));
  const queueVal = (r: StockRequest, k: string): SortValue =>
    k === "id" ? r.id
      : k === "outlet" ? LOC[r.from].n
        : k === "by" ? r.by
          : k === "items" ? r.lines.length
            : k === "prio" ? (r.urg ? 0 : 1)
              : r.at;
  const queueSorted = sortRows(queueRows, queue.sort, queueVal);
  const queueFiltered = rTerm !== "" || outlet > 0 || prio > 0;

  /* ---- recent activity, drawn from what actually happened ---- */
  const acts: Act[] = [
    ...s.bills.slice(0, 12).map((b) => ({
      key: "b" + b.no,
      kind: "Bills" as const,
      t: b.t,
      what: `Bill ${b.no} · ${money(b.tot)} · ${b.pay}`,
      where: LOC[b.loc].n,
      who: b.opr,
    })),
    ...s.req.flatMap((r) =>
      r.hist.map((h, i) => ({
        key: "r" + r.id + i,
        kind: "Requests" as const,
        t: h.t,
        what: `${r.id} — ${h.s} · ${unitTotal(r.lines)}`,
        where: LOC[r.from].n,
        who: h.who,
      }))),
    ...transfers.map((t) => ({
      key: "t" + t.id,
      kind: "Shop transfers" as const,
      t: "—",
      what: `${t.id} — ${t.st.toLowerCase()} · ${unitTotal(t.lines)}`,
      where: `${LOC[t.from].n} to ${LOC[t.to].n}`,
      who: "Shop to shop",
    })),
  ];
  const aTerm = aq.trim().toLowerCase();
  const actRows = acts
    .filter((a) => akind === 0 || a.kind === ACTIVITY[akind])
    .filter((a) => !aTerm
      || a.what.toLowerCase().includes(aTerm)
      || a.where.toLowerCase().includes(aTerm)
      || a.who.toLowerCase().includes(aTerm));
  const actSorted = sortRows(actRows, actSort.sort, (a, k) =>
    k === "what" ? a.what : k === "where" ? a.where : k === "who" ? a.who : k === "kind" ? a.kind : a.t)
    .slice(0, 24);
  const actFiltered = aTerm !== "" || akind > 0;

  const outletVal = (r: (typeof outlets)[number], k: string): SortValue =>
    k === "name" ? r.name
      : k === "floor" ? r.floor
        : k === "bills" ? r.bills
          : k === "value" ? r.value
            : k === "off" ? r.off.n
              : r.sales;

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Outlets", "Dashboard"]}
        title="What needs you today"
        sub="Every selling counter — the decisions waiting on you, and where the stock is."
        actions={<Btn variant="gh" onClick={() => nav("/approvals")}>Open approvals</Btn>}
      />

      {waiting.length > 0 ? (
        <Alert
          tone="w"
          label="QUEUE"
          action={<Btn size="xs" variant="gh" onClick={() => nav("/approvals")}>Review now</Btn>}
        >
          <b>{waiting.length}</b> stock request{waiting.length > 1 ? "s are" : " is"} waiting on your approval
          {urgent > 0 ? <> — <b>{urgent}</b> marked urgent by the counter</> : null}. Nothing moves out of the
          Central Store until you approve the quantities.
        </Alert>
      ) : (
        <Alert tone="g" label="CLEAR">
          No counter request is waiting on you. New requests land here and on the Approvals screen.
        </Alert>
      )}
      {offOutlets.length > 0 && (
        <Alert tone="c" label="OFF" action={<Btn size="xs" variant="gh" onClick={() => nav("/avail")}>Product on / off</Btn>}>
          <b>{offAll.n}</b> product{offAll.n > 1 ? "s" : ""} cannot be billed at{" "}
          {offOutlets.map((r) => r.name).join(", ")} — {why(offAll)}.
        </Alert>
      )}
      {moving.length > 0 && (
        <Alert tone="i" label="SHOP TO SHOP" action={<Btn size="xs" variant="gh" onClick={() => nav("/stock")}>See transfers</Btn>}>
          <b>{moving.length}</b> transfer{moving.length > 1 ? "s are" : " is"} moving directly from one shop to another.
          The goods do not pass through you — this is on record so you know where the stock is.
        </Alert>
      )}

      <Card title="Outlet summary" sub="Today's trade against the stock each counter is holding" flush>
        <DataTable
          sort={outletSort.sort}
          onSort={outletSort.onSort}
          cols={[
            { h: "Outlet", cls: "nm", w: "22%", sort: "name" },
            { h: "Floor", sort: "floor" },
            { h: "Today's sales", r: true, sort: "sales" },
            { h: "Bills", r: true, sort: "bills" },
            { h: "Average bill", r: true },
            { h: "Stock value", r: true, sort: "value" },
            { h: "Products off", r: true, sort: "off" },
          ]}
          rows={sortRows(outlets, outletSort.sort, outletVal).map((r) => ({
            key: r.loc,
            cells: [
              <>{r.name}<small>{LOC[r.loc].c} · {LOC[r.loc].cc}</small></>,
              r.floor,
              <b>{money0(r.sales)}</b>,
              r.bills,
              money(r.bills ? r.sales / r.bills : 0),
              lakh(r.value),
              r.off.n > 0
                ? <><Pill tone="wn">{r.off.n}</Pill><small className="dim" style={{ display: "block" }}>{why(r.off)}</small></>
                : <span className="dim">0</span>,
            ],
          }))}
          empty={{ title: "No outlets configured", sub: "At least one selling counter is expected." }}
        />
        <TableFoot
          count={outlets.length}
          extra={<>Sales {money0(total)} · stock at counters {lakh(sum(outlets, (r) => r.value))}</>}
        />
      </Card>

      <Card title="Requests awaiting your approval" sub={`${queueRows.length} of ${waiting.length}`} flush className="mtop">
        <Toolbar
          placeholder="Search request, outlet, operator or item…"
          value={rq}
          onSearch={setRq}
          filters={
            <>
              <FilterSelect label="Outlet" value={outletNames[outlet]} options={outletNames}
                onChange={(v) => setOutlet(outletNames.indexOf(v))} />
              <FilterSelect label="Priority" value={PRIORITY[prio]} options={PRIORITY}
                onChange={(v) => setPrio(PRIORITY.indexOf(v as typeof PRIORITY[number]))} />
            </>
          }
          right={<Btn size="sm" variant="gh" onClick={() => nav("/approvals")}>Full approvals screen</Btn>}
        />
        <DataTable
          sort={queue.sort}
          onSort={queue.onSort}
          cols={[
            { h: "Request", cls: "nm", w: "20%", sort: "id" },
            { h: "Outlet", sort: "outlet" },
            { h: "Raised by", sort: "by" },
            { h: "Time", r: true, sort: "at" },
            { h: "Items", r: true, sort: "items" },
            { h: "Total asked", r: true },
            { h: "Priority", sort: "prio" },
            { h: "Action", w: "9%" },
          ]}
          rows={queueSorted.map((r) => ({
            key: r.id,
            onClick: () => openDrawer("mreq", r.id),
            cells: [
              <>{r.id}<small>{lineNames(r)}</small></>,
              <>{LOC[r.from].n} <span className="mini">{LOC[r.from].floor}</span></>,
              r.by,
              r.at,
              r.lines.length,
              <b>{unitTotal(r.lines)}</b>,
              r.urg ? <Pill tone="cr">Urgent</Pill> : <Pill tone="mu">Normal</Pill>,
              <Btn size="xs" onClick={() => openDrawer("mreq", r.id)}>Review</Btn>,
            ],
          }))}
          empty={emptyFor(queueFiltered, {
            title: "Nothing waiting on you",
            sub: "Every counter request has been approved or rejected.",
          })}
        />
        <TableFoot count={queueRows.length} extra={<>{urgent} urgent in the full queue</>} />
      </Card>

      <Card title="Recent activity" sub="Bills, request decisions and shop transfers" flush className="mtop">
        <Toolbar
          placeholder="Search activity, outlet or person…"
          value={aq}
          onSearch={setAq}
          filters={
            <FilterSelect label="Kind" value={ACTIVITY[akind]} options={ACTIVITY}
              onChange={(v) => setAkind(ACTIVITY.indexOf(v as typeof ACTIVITY[number]))} />
          }
        />
        <DataTable
          sort={actSort.sort}
          onSort={actSort.onSort}
          cols={[
            { h: "Time", w: "8%", sort: "t" },
            { h: "Kind", w: "13%", sort: "kind" },
            { h: "What happened", cls: "nm", sort: "what" },
            { h: "Where", sort: "where" },
            { h: "Who", sort: "who" },
          ]}
          rows={actSorted.map((a) => ({
            key: a.key,
            cells: [
              <span className="mono">{a.t}</span>,
              <Pill tone={a.kind === "Bills" ? "ok" : a.kind === "Requests" ? "in" : "ac"}>{a.kind}</Pill>,
              a.what,
              a.where,
              a.who,
            ],
          }))}
          empty={emptyFor(actFiltered, {
            title: "Nothing has happened yet today",
            sub: "Bills, approvals and shop transfers appear here as they are recorded.",
          })}
        />
        <TableFoot count={actSorted.length} extra={<>Newest 24 entries · {transfers.length} shop transfer{transfers.length === 1 ? "" : "s"} on record</>} />
      </Card>
    </>
  );
}
