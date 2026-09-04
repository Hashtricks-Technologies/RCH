import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp, type AppState } from "../../store";
import { committed, costOf, freeToPromise, onOrder, parOf, qty, resv } from "../../lib/selectors";
import { U, fq, money0, now, pct, sum, unitTotal } from "../../lib/fmt";
import {
  Btn, Card, DataTable, FilterSelect, Icon, PageHead, Pill, StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { Col } from "../../ui/kit";

/** Every report is plain strings: the table renders them and the CSV export ships them (P1, P2). */
interface Rep {
  cols: Col[];
  rows: string[][];
  pill?: number;
  /** Column whose distinct values drive the report's own filter button.
   *  Defaults to the status column where the report has one. */
  facet?: number;
  foot?: string;
  empty: { title: string; sub: string };
}
interface ReportDef { k: string; n: string; d: string; icon: string; build: (s: AppState) => Rep }

const DASH = "—";
const mins = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
/** Times are clock-only, so a negative gap has rolled past midnight. */
const gap = (a: string | undefined, b: string | undefined) => {
  const x = a ? mins(a) : null;
  const y = b ? mins(b) : null;
  if (x === null || y === null) return null;
  return y - x < 0 ? y - x + 1440 : y - x;
};
const dur = (m: number | null) =>
  m === null ? DASH : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
const days = (iso: string) => Math.round((new Date(iso).getTime() - Date.now()) / 86400000);
const storeKeys = (s: AppState) => Object.keys(s.stock.store).filter((k) => IT[k]);
const byCode = (a: string, b: string) => IT[a].c.localeCompare(IT[b].c);
const fromStore = (s: AppState) => s.tkt.filter((t) => t.from === "store");
const stamp = (s: AppState, req: string, st: string) =>
  s.req.find((x) => x.id === req)?.hist.find((h) => h.s === st)?.t;

const ledger = (s: AppState): Rep => {
  const rows = storeKeys(s).sort(byCode).map((k) => {
    const grn = s.grn.filter((g) => g.it === k);
    const recd = sum(grn, (g) => g.qty);
    const out = sum(fromStore(s).filter((t) => t.st !== "Issued"),
      (t) => sum(t.lines.filter((l) => l.it === k), (l) => l.qty));
    const close = qty(s, "store", k);
    return [
      IT[k].n, IT[k].c, U(k),
      fq(close - recd + out, k), fq(recd, k), fq(out, k), fq(close, k),
      money0(close * costOf(k)),
    ];
  });
  return {
    cols: [
      { h: "Item", cls: "nm", w: "18%" }, { h: "Code" }, { h: "Unit" },
      { h: "Opening", r: true }, { h: "Received", r: true },
      { h: "Issued out", r: true }, { h: "Closing", r: true }, { h: "Value at cost", r: true },
    ],
    rows,
    facet: 2,
    foot: `Closing value ${money0(sum(storeKeys(s), (k) => qty(s, "store", k) * costOf(k)))} · receipts from goods receipt notes, issues from collected tickets`,
    empty: { title: "The central store carries no lines", sub: "Receive a purchase order and the ledger opens." },
  };
};

const issreg = (s: AppState): Rep => {
  const out = fromStore(s);
  const rows = [...new Set(out.map((t) => t.to))].map((l) => {
    const ts = out.filter((t) => t.to === l);
    const lines = ts.flatMap((t) => t.lines);
    const st = (k: string) => String(ts.filter((t) => t.st === k).length);
    return [
      LOC[l].n, LOC[l].cc, String(ts.length), String(lines.length), unitTotal(lines),
      money0(sum(lines, (x) => x.qty * costOf(x.it))), st("Received"), st("Collected"), st("Issued"),
    ];
  });
  return {
    cols: [
      { h: "Outlet", cls: "nm", w: "18%" }, { h: "Cost centre" },
      { h: "Tickets", r: true }, { h: "Lines", r: true }, { h: "Quantity", r: true },
      { h: "Value at cost", r: true }, { h: "Confirmed", r: true }, { h: "In transit", r: true },
      { h: "At the window", r: true },
    ],
    rows,
    facet: 0,
    foot: `${out.length} ticket${out.length === 1 ? "" : "s"} raised against ${LOC.store.n}`,
    empty: { title: "Nothing has been issued yet", sub: "Generate a ticket on the issue desk and it lands here." },
  };
};

const turn = (s: AppState): Rep => {
  const rows = fromStore(s)
    .map((t) => {
      const appr = stamp(s, t.req, "Manager approved") ?? stamp(s, t.req, "Partially approved");
      const iss = stamp(s, t.req, "Ticket issued");
      const col = stamp(s, t.req, "Collected");
      const rec = stamp(s, t.req, "Received");
      const a2i = gap(appr, iss);
      return {
        slow: a2i ?? -1,
        cells: [
          t.id, t.req, LOC[t.to].n, appr ?? DASH, iss ?? DASH, dur(a2i),
          col ?? DASH, dur(gap(iss, col)), dur(gap(col, rec)), t.st,
        ],
      };
    })
    .sort((a, b) => b.slow - a.slow)
    .map((x) => x.cells);
  return {
    cols: [
      { h: "Ticket", cls: "nm", w: "13%" }, { h: "Request", w: "14%" }, { h: "Outlet" },
      { h: "Approved" }, { h: "Ticket raised" }, { h: "Approval to ticket", r: true },
      { h: "Collected" }, { h: "Ticket to collection", r: true }, { h: "Collection to confirmed", r: true },
      { h: "Status", w: "10%" },
    ],
    rows,
    pill: 9,
    facet: 9,
    foot: "Slowest approval-to-ticket first. A dash means the ticket has not reached that step yet.",
    empty: { title: "No ticket has been raised yet", sub: "Turnaround is measured from the approval trail on each request." },
  };
};

const resage = (s: AppState): Rep => {
  const rows = fromStore(s)
    .filter((t) => t.st === "Issued")
    .flatMap((t) => {
      const since = stamp(s, t.req, "Ticket issued");
      return t.lines.map((l) => [
        t.id, t.req, LOC[t.to].n, IT[l.it]?.n ?? l.it, fq(l.qty, l.it), U(l.it),
        since ?? DASH, dur(gap(since, now())), money0(l.qty * costOf(l.it)),
      ]);
    });
  const held = Object.entries(s.rsv).filter(([, v]) => v > 0);
  return {
    cols: [
      { h: "Ticket", cls: "nm", w: "13%" }, { h: "Request", w: "14%" }, { h: "Outlet" },
      { h: "Item", w: "16%" }, { h: "Reserved", r: true }, { h: "Unit" },
      { h: "Held since" }, { h: "Age", r: true }, { h: "Value at cost", r: true },
    ],
    rows,
    facet: 2,
    foot: `${held.length} reservation line${held.length === 1 ? "" : "s"} on the ledger, worth ${money0(sum(held, ([k, v]) => v * costOf(k.split(":")[1])))} at cost`,
    empty: { title: "Nothing is reserved", sub: "Stock is reserved when a ticket is generated and released when it is collected." },
  };
};

const belowrl = (s: AppState): Rep => {
  const rows = storeKeys(s)
    .map((k) => ({ k, rl: parOf("store", k), on: qty(s, "store", k), av: qty(s, "store", k) - resv(s, "store", k) }))
    .filter((x) => x.rl > 0 && x.av < x.rl)
    .sort((a, b) => a.av / a.rl - b.av / b.rl)
    .map(({ k, rl, on, av }) => {
      const top = Math.max(1, Math.ceil(rl * 1.6 - on));
      return [
        IT[k].n, IT[k].c, U(k), fq(on, k), fq(resv(s, "store", k), k), fq(av, k), fq(rl, k),
        fq(Math.round((rl - av) * 1000) / 1000, k), fq(onOrder(s, k), k), fq(top, k), money0(top * costOf(k)),
      ];
    });
  return {
    cols: [
      { h: "Item", cls: "nm", w: "17%" }, { h: "Code" }, { h: "Unit" },
      { h: "On hand", r: true }, { h: "Reserved", r: true }, { h: "Available", r: true },
      { h: "Reorder level", r: true }, { h: "Shortfall", r: true }, { h: "On order", r: true },
      { h: "Suggested top-up", r: true }, { h: "Top-up value", r: true },
    ],
    rows,
    facet: 2,
    foot: `Reorder levels are the ${LOC.store.n} par, and the suggestion brings each line back to 1.6 times it`,
    empty: { title: "Every line is above its reorder level", sub: `Nothing in ${LOC.store.n} needs replenishing right now.` },
  };
};

const prqst = (s: AppState): Rep => {
  const rows = s.prq.map((p) => {
    const o = s.po.find((x) => x.lines.some((l) => l.src.some((sr) => sr.prq === p.id)));
    return [
      p.id, p.by, p.at, String(p.lines.length), unitTotal(p.lines),
      money0(sum(p.lines, (l) => l.qty * costOf(l.it))),
      o?.id ?? DASH, o?.vendor ?? DASH, o?.eta ?? DASH,
      p.st === "Sent" ? dur(gap(p.at, now())) : DASH, p.st,
    ];
  });
  const waiting = s.prq.filter((p) => p.st === "Sent").length;
  return {
    cols: [
      { h: "Requisition", cls: "nm", w: "15%" }, { h: "Raised by", w: "12%" }, { h: "Raised" },
      { h: "Lines", r: true }, { h: "Quantity", r: true }, { h: "Estimated value", r: true },
      { h: "Purchase order", w: "13%" }, { h: "Vendor", w: "14%" }, { h: "Expected" },
      { h: "Waiting", r: true }, { h: "Status", w: "10%" },
    ],
    rows,
    pill: 10,
    facet: 10,
    foot: `${waiting} still with procurement · ${s.prq.filter((p) => p.st === "Approved").length} approved · ${s.prq.filter((p) => p.st === "Partially approved").length} partially approved`,
    empty: { title: "No requisition has been raised", sub: "Build one on the requisitions screen and send it to procurement." },
  };
};

const ageing = (s: AppState): Rep => {
  const clock = mins(now()) ?? 0;
  const rows = [
    ...s.grn.map((g) => {
      const left = days(g.exp);
      return [
        g.batch, IT[g.it]?.n ?? g.it, LOC.store.n, `${fq(g.qty, g.it)} ${U(g.it)}`,
        g.mfg, g.exp, `${Math.max(0, -days(g.mfg))} d`,
        left < 0 ? "Expired" : `${left} d left`, money0(g.qty * costOf(g.it)),
      ];
    }),
    ...s.batch.map((b) => {
      const bb = mins(b.bb) ?? 0;
      return [
        b.id, IT[b.it]?.n ?? b.it, LOC.kitchen.n, `${fq(b.qty, b.it)} ${U(b.it)}`,
        `today ${b.at}`, `today ${b.bb}`, dur(gap(b.at, now())),
        clock > bb ? "Past best before" : `${bb - clock} min left`, money0(b.qty * costOf(b.it)),
      ];
    }),
  ];
  return {
    cols: [
      { h: "Lot", cls: "nm", w: "18%" }, { h: "Item", w: "16%" }, { h: "Held at" },
      { h: "Quantity", r: true }, { h: "Made or received" }, { h: "Best before" },
      { h: "Age", r: true }, { h: "Shelf life left", r: true }, { h: "Value at cost", r: true },
    ],
    rows,
    facet: 2,
    foot: `${s.grn.length} purchased lot${s.grn.length === 1 ? "" : "s"} and ${s.batch.length} produced batch${s.batch.length === 1 ? "" : "es"} on file`,
    empty: { title: "No lot is on file", sub: "Purchased lots appear once a goods receipt is booked in; produced lots once the kitchen makes a batch." },
  };
};

const movers = (s: AppState): Rep => {
  const out = fromStore(s);
  const rows = storeKeys(s)
    .map((k) => ({
      k,
      iss: sum(out, (t) => sum(t.lines.filter((l) => l.it === k), (l) => l.qty)),
      sold: sum(s.bills.flatMap((b) => b.lines).filter((l) => l.it === k), (l) => l.qty),
      ask: sum(s.req, (r) => sum(r.lines.filter((l) => l.it === k), (l) => l.qty)),
    }))
    .sort((a, b) => b.iss + b.sold - (a.iss + a.sold) || b.ask - a.ask)
    .map(({ k, iss, sold, ask }) => {
      const on = qty(s, "store", k);
      const rl = parOf("store", k);
      const move = iss + sold > 0
        ? (iss >= rl && rl > 0 ? "Fast" : "Steady")
        : ask > 0 ? "Requested, not yet issued" : "No movement";
      return [
        IT[k].n, IT[k].c, U(k), fq(iss, k), fq(sold, k), fq(ask, k), fq(on, k),
        rl > 0 ? (on / Math.max(0.001, rl / 4)).toFixed(1) + " d" : DASH, move,
      ];
    });
  return {
    cols: [
      { h: "Item", cls: "nm", w: "18%" }, { h: "Code" }, { h: "Unit" },
      { h: "Issued from store", r: true }, { h: "Sold at outlets", r: true },
      { h: "Requested", r: true }, { h: "On hand", r: true }, { h: "Days of cover", r: true },
      { h: "Movement", w: "16%" },
    ],
    rows,
    facet: 8,
    foot: "Ranked by what has left the store window and what the counters have billed",
    empty: { title: "The central store carries no lines", sub: "Velocity is measured against issues and counter sales." },
  };
};

const resvav = (s: AppState): Rep => {
  const rows = storeKeys(s)
    .map((k) => ({ k, on: qty(s, "store", k), rv: resv(s, "store", k), cm: committed(s.req, k) }))
    .sort((a, b) => b.rv + b.cm - (a.rv + a.cm) || byCode(a.k, b.k))
    .map(({ k, on, rv, cm }) => {
      const free = freeToPromise(s, "store", k);
      return [
        IT[k].n, IT[k].c, U(k), fq(on, k), fq(rv, k), fq(cm, k), fq(free, k),
        pct(on > 0 ? (rv + cm) / on : 0, 0), money0(Math.max(0, free) * costOf(k)),
      ];
    });
  return {
    cols: [
      { h: "Item", cls: "nm", w: "18%" }, { h: "Code" }, { h: "Unit" },
      { h: "On hand", r: true }, { h: "Reserved on tickets", r: true },
      { h: "Committed to approvals", r: true }, { h: "Free to promise", r: true },
      { h: "Spoken for", r: true }, { h: "Free value", r: true },
    ],
    rows,
    facet: 2,
    foot: "Free to promise is on hand less open ticket reservations less approvals that have no ticket yet",
    empty: { title: "The central store carries no lines", sub: "Nothing can be promised until stock is received." },
  };
};

const disc = (s: AppState): Rep => {
  const rows = fromStore(s).flatMap((t) => {
    const r = s.req.find((x) => x.id === t.req);
    return t.lines.map((l) => {
      const appr = r?.lines.find((x) => x.it === l.it)?.appr ?? 0;
      const done = t.st === "Received";
      return [
        t.id, t.req, LOC[t.to].n, IT[l.it]?.n ?? l.it, fq(appr, l.it), fq(l.qty, l.it),
        done ? fq(l.qty, l.it) : "Not yet confirmed",
        fq(Math.round((l.qty - appr) * 1000) / 1000, l.it), done ? fq(0, l.it) : DASH, t.st,
      ];
    });
  });
  const open = fromStore(s).filter((t) => t.st !== "Received").length;
  return {
    cols: [
      { h: "Ticket", cls: "nm", w: "13%" }, { h: "Request", w: "14%" }, { h: "Outlet" },
      { h: "Item", w: "15%" }, { h: "Approved", r: true }, { h: "Issued on ticket", r: true },
      { h: "Confirmed by outlet", r: true }, { h: "Ticket less approved", r: true },
      { h: "Confirmed less issued", r: true }, { h: "Status", w: "10%" },
    ],
    rows,
    pill: 9,
    facet: 9,
    foot: `${open} ticket${open === 1 ? " is" : "s are"} still open, so their confirmed quantity is not known yet`,
    empty: { title: "No ticket has left the store", sub: "Discrepancies are measured once a ticket is raised and the outlet confirms it." },
  };
};

const REPORTS: ReportDef[] = [
  { k: "ledger", n: "Central store stock ledger", icon: "stock", build: ledger, d: "Every receipt, issue and adjustment against each item in the central store." },
  { k: "issreg", n: "Issue register by outlet", icon: "tkt", build: issreg, d: "What left the store window, grouped by receiving outlet." },
  { k: "turn", n: "Ticket turnaround", icon: "rep", build: turn, d: "Time from manager approval to ticket, and from ticket to collection." },
  { k: "resage", n: "Reservation ageing", icon: "req", build: resage, d: "Stock reserved against tickets nobody has collected yet." },
  { k: "belowrl", n: "Below-reorder exceptions", icon: "need", build: belowrl, d: "Lines under reorder level, with the suggested requisition quantity." },
  { k: "prqst", n: "Requisition status", icon: "order", build: prqst, d: "Requisitions raised on procurement — sent, approved, partially approved or declined." },
  { k: "ageing", n: "Stock ageing", icon: "item", build: ageing, d: "How long each lot has been sitting against its shelf life." },
  { k: "movers", n: "Fast and slow movers", icon: "dash", build: movers, d: "Issue velocity per item against counter sales." },
  { k: "resvav", n: "Reserved versus available", icon: "power", build: resvav, d: "Free-to-promise position per item after reservations and approvals." },
  { k: "disc", n: "Handover discrepancies", icon: "appr", build: disc, d: "Approved against issued against the quantity the outlet confirmed." },
];

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export default function Reports() {
  const s = useApp();
  const notify = useApp((x) => x.notify);
  const [sel, setSel] = useState("issreg");
  const [q, setQ] = useState("");
  const [fi, setFi] = useState(0);

  const def = REPORTS.find((r) => r.k === sel) ?? REPORTS[0];
  const rep = def.build(s);

  // Each report names the column worth filtering on; its distinct values are
  // the filter, so the button always narrows something that is really there.
  const at = rep.facet ?? rep.pill;
  const facetCol = at != null ? rep.cols[at] : undefined;
  const facetOpts = at == null
    ? ["All"]
    : ["All", ...new Set(rep.rows.map((r) => r[at]).filter((v) => v && v !== DASH))];
  const facet = facetOpts[Math.min(fi, facetOpts.length - 1)];

  const term = q.trim().toLowerCase();
  const rows = rep.rows.filter((r) => {
    if (at != null && facet !== "All" && r[at] !== facet) return false;
    return !term || r.some((c) => c.toLowerCase().includes(term));
  });
  const narrowed = rep.rows.length > 0 && rows.length === 0;
  const pick = (k: string) => { setSel(k); setQ(""); setFi(0); };

  const exportCsv = () => {
    if (!rows.length) { notify(`${def.n} has no rows to export`); return; }
    const csv = [rep.cols.map((c) => c.h), ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(def.n)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    notify(`${def.n} exported — ${rows.length} row${rows.length === 1 ? "" : "s"}`);
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Store", "Insights"]}
        title="Store reports"
        sub={`${LOC.store.n} · issue, reservation and replenishment reporting`}
      />

      <Card title="Report library" sub="Ten reports for running the central store, built from live store data">
        <div className="tilegrid">
          {REPORTS.map((r) => (
            <button
              key={r.k}
              type="button"
              className="tile"
              aria-pressed={sel === r.k}
              style={sel === r.k ? { borderColor: "var(--accent)", background: "var(--accent-soft)" } : undefined}
              onClick={() => pick(r.k)}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <Icon name={r.icon} />
                <b style={{ fontSize: 12.5 }}>{r.n}</b>
              </span>
              <span className="mini" style={{ lineHeight: 1.45 }}>{r.d}</span>
            </button>
          ))}
        </div>
      </Card>

      <div className="mtop">
      <Card
        title={def.n}
        sub={def.d}
        right={<Pill tone={rep.rows.length ? "ac" : "mu"}>{rep.rows.length} row{rep.rows.length === 1 ? "" : "s"}</Pill>}
        flush
      >
        <Toolbar
          placeholder={`Search ${def.n.toLowerCase()}…`}
          value={q}
          onSearch={setQ}
          filters={facetCol && facetOpts.length > 1
            ? <FilterSelect label={facetCol.h} value={facet} options={facetOpts} onChange={(v) => setFi(facetOpts.indexOf(v))} />
            : undefined}
          right={
            <>
              <span className="mini">{rows.length} of {rep.rows.length}</span>
              <Btn size="sm" variant="gh" onClick={exportCsv}>Export</Btn>
            </>
          }
        />
        <DataTable
          cols={rep.cols}
          rows={rows.map((cells, i) => ({
            key: sel + ":" + i,
            cells: cells.map((v, j) => (j === rep.pill ? <StatusPill status={v} /> : v)),
          }))}
          empty={narrowed
            ? {
              title: "Nothing matches those filters",
              sub: `${def.n} has ${rep.rows.length} row${rep.rows.length > 1 ? "s" : ""}, but none of them match.`,
              action: <Btn size="sm" variant="gh" onClick={() => { setQ(""); setFi(0); }}>Reset filters</Btn>,
            }
            : rep.empty}
        />
        <TableFoot count={rows.length} extra={rep.foot} />
      </Card>
      </div>
    </>
  );
}
