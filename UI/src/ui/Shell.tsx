import {
  useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject,
} from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { bestBeforeAt, type ReadCollection } from "@rch/domain";
import { IT, LOC, homeLabel } from "../data/master";
import { canSee, navFor } from "../nav";
import { useApp, type AppState } from "../store";
import { isToday, money0 } from "../lib/fmt";
import {
  activeItems, availOf, isTicketOpen, locName, menuOf, openOutlets, procurementList, qty, userCan, userReadsWide,
} from "../lib/selectors";
import type { LocKey, Role, User } from "../types";
import type { ScreenKey } from "../screens";
import { useStreamState, type StreamState } from "../api/events";
import { Avatar, Icon, Pill, SearchIcon, Tag, ThemeButton, Tip } from "./kit";
import { applyPrefs, readPrefs, usePhoto } from "./prefs";
import { markSeen, useSeen } from "./seen";
import Drawer from "./Drawer";
import ErrorBoundary from "./ErrorBoundary";
import CloseShift from "./CloseShift";
import mark from "../assets/eateszy-mark.png";

/** What the header's dot says, per stream state. The colour is inline rather than a class
 *  because `.org .dt` paints one colour for all three, and this is the only place it varies. */
const STREAM: Record<StreamState, { dot: string; why: string }> = {
  live: { dot: "var(--good)", why: "Live - this screen is following changes made elsewhere" },
  reconnecting: { dot: "var(--warn)", why: "Reconnecting - changes made elsewhere may not be on this screen yet" },
  off: { dot: "var(--ink-4)", why: "Not connected for live updates - reload to see changes made elsewhere" },
};

export default function Shell({ children }: { children: ReactNode }) {
  // `open` is the mobile drawer; `collapsed` hides the rail on a wide screen.
  // The burger is the way back in both cases - on desktop it only appears once
  // the sidebar is collapsed, so there is never a state with no way to reopen.
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const user = useApp((s) => s.user)!;
  const logout = useApp((s) => s.logout);
  // NOTE: navQueues builds a fresh object, so it must never be passed to useApp()
  // as a selector - zustand v5 feeds the selector result to useSyncExternalStore and a
  // new identity on every call re-renders forever. Read the whole (stable) state instead.
  const state = useApp();
  // Every other badge only has to change when a write changes it - this is the one exception.
  // A batch quietly crosses into "due soon" with no write happening at all, so nothing here
  // would otherwise notice until some unrelated write forced a re-render. This tick is the one
  // thing on the page whose only job is to make the clock's own passage visible.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const queues = navQueues(state);
  // ---- shifts: the manager's bell names the latest hand-over, so the list is read as the shell
  // mounts rather than when the Register screen happens to be opened.
  const loadShifts = useApp((s) => s.loadShifts);
  const shifts = readsShifts(user);
  useEffect(() => { if (shifts) void loadShifts(); }, [shifts, loadShifts]);
  // ---- QR orders: the counter's bell counts the paid orders nobody has started, so the queue
  // is read as the shell mounts too - for whoever holds QR orders.
  const loadQrOrders = useApp((s) => s.loadQrOrders);
  const qr = userCan(user, "qr_orders");
  useEffect(() => { if (qr) void loadQrOrders(); }, [qr, loadQrOrders]);
  // Where this account may work. One is the ordinary case and nothing about the header changes
  // for it; more than one earns the switcher below.
  const photo = usePhoto();
  const live = useStreamState();
  const nav = useNavigate();
  const { pathname } = useLocation();

  // The compact-table preference is stamped on the root, so it outlives Settings.
  useEffect(() => { applyPrefs(readPrefs()); }, []);

  return (
    <div id="app" className={`on${collapsed ? " sc" : ""}`}>
      <aside className={`side${open ? " open" : ""}`}>
        <div className="sh">
          <span className="lm"><img src={mark} alt="eaTesZy" /></span>
          <div><b>Royal Care</b><span>Inventory</span></div>
          <button
            className="ib sx" type="button" aria-label="Hide the sidebar"
            onClick={() => { setCollapsed(true); setOpen(false); }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <nav className="nav">
          {navFor(user).map((g) => (
            <div key={g.group}>
              <div className="navg">{g.group}</div>
              {g.items.map((it) => (
                <NavLink key={it.k} to={"/" + it.k} onClick={() => setOpen(false)}
                  className={({ isActive }) => (isActive ? "on" : "")}>
                  <Icon name={it.icon} /><span>{it.label}</span>
                  {queues[it.k]?.length > 0 && <span className="ct hot">{queues[it.k].length}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sf">
          {/* A counter operator's shift ends here: the live report, the close, and a sign-out. */}
          {user.r === "counter" && <div style={{ marginBottom: 8 }}><CloseShift wide /></div>}
          {/* Navigate once the token and the cookie are actually gone, or the
              guard on /login bounces straight back to the screen just left. */}
          <button className="su" type="button" onClick={() => { void logout().then(() => nav("/login")); }}>
            <Avatar name={user.n} color={user.col} size={30} src={photo} />
            <span className="ut"><b>{user.n}</b><span>{user.rl}</span></span>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M6 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2M10.5 10.5 13 8l-2.5-2.5M13 8H6" />
            </svg>
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="top">
          <button
            className="burger" type="button" aria-label="Show the sidebar"
            onClick={() => { setCollapsed(false); setOpen(!open); }}
          >
            <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <path d="M2 4h12M2 8h12M2 12h12" /></svg>
          </button>
          <Search />
          <div className="tsp" />
          {/* The header dot is the status light the Support FAQ tells an operator to look at,
              so it has to mean something: it follows the live-update stream. It was a <button>
              with no onClick and a green dot painted on, which read as "all well" with the
              stream down. Not interactive, so not a button; what the state means sits behind the
              "i" beside it. */}
          <div className="org">
            <span className="dt" role="img" aria-label={STREAM[live].why} style={{ background: STREAM[live].dot }} />
            {/* Where this session is standing. Named, not offered: the counter is decided at
                sign-in and does not move - somebody taking a shift at another till signs in
                there. */}
            <span className="lbl">Royal Care{homeLabel(user) ? ` · ${homeLabel(user)}` : ""}</span>
            <Tip text={STREAM[live].why} label="Connection" />
          </div>
          {/* Nothing is shown while the stream is live: a badge that is always there stops being read. */}
          {live === "reconnecting" && <Pill tone="wn">Reconnecting</Pill>}
          <ThemeButton />
          <Bell uid={user.id} queues={queues} detail={bellDetail(state)} />
          <button className="avb" type="button" onClick={() => nav("/settings")}>
            <Avatar name={user.n} color={user.col} size={26} src={photo} />
            <span className="nmx"><b>{user.n.split(" ")[0]}</b><span>{user.rl}</span></span>
          </button>
        </header>
        {/* A screen that throws is caught here, inside the shell, so the sidebar, the search
            and the way out stay usable. Keyed on the path so leaving the broken screen resets it. */}
        <div className="pg"><ErrorBoundary key={pathname}>{children}</ErrorBoundary></div>
      </div>
      <Drawer />
    </div>
  );
}

/** Escape, or a click anywhere outside, puts a popover away. */
function useDismiss(on: boolean, close: () => void, box: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!on) return;
    const out = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("pointerdown", out);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", out);
      document.removeEventListener("keydown", esc);
    };
  }, [on, close, box]);
}

/* ---------- global search (P3) ---------- */
function Search() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  const lid = useId();
  // The four slices `searchHits` actually reads, subscribed one at a time rather than through
  // `useApp()`. `[s, q]` was a dependency on the whole store, which is a new object after every
  // write anywhere in the app, so the palette re-ran its whole walk - every request, ticket,
  // bill and item - on a toast appearing. `catalogVersion` stands in for `IT`, which is a
  // module registry replaced in place and so cannot be a dependency of its own.
  const user = useApp((x) => x.user);
  const req = useApp((x) => x.req);
  const tkt = useApp((x) => x.tkt);
  const bills = useApp((x) => x.bills);
  const catalogVersion = useApp((x) => x.catalogVersion);
  const hits = useMemo(() => {
    void catalogVersion;
    return searchHits({ user, req, tkt, bills }, q);
  }, [user, req, tkt, bills, catalogVersion, q]);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, box);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inp.current?.focus();
        inp.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const show = open && q.trim().length > 0;
  const cur = hits.length ? Math.min(sel, hits.length - 1) : 0;

  const go = (h: Hit) => {
    setOpen(false);
    setQ("");
    inp.current?.blur();
    nav("/" + h.to);
  };
  const key = (e: React.KeyboardEvent) => {
    if (!show || !hits.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => (Math.min(i, hits.length - 1) + 1) % hits.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => (Math.min(i, hits.length - 1) + hits.length - 1) % hits.length); }
    else if (e.key === "Enter") { e.preventDefault(); go(hits[cur]); }
  };

  return (
    <div className="search" ref={box}>
      <SearchIcon />
      <input ref={inp} value={q} placeholder="Search…" aria-label="Search" role="combobox"
        aria-expanded={show} aria-autocomplete="list" aria-controls={show ? lid : undefined}
        aria-activedescendant={show && hits.length ? `${lid}-${cur}` : undefined}
        onChange={(e) => { setQ(e.target.value); setSel(0); setOpen(true); }}
        onFocus={() => setOpen(true)} onKeyDown={key} />
      {!q && <kbd>⌘K</kbd>}
      {show && (
        <div className="pop">
          {hits.length ? (
            <ul className="pl" id={lid} role="listbox" aria-label="Search results">
              {hits.map((h, i) => (
                <li key={h.id} id={`${lid}-${i}`} role="option" aria-selected={i === cur}
                  className={`po${i === cur ? " on" : ""}`}
                  onMouseMove={() => setSel(i)} onClick={() => go(h)}>
                  <span className="pb"><b>{h.t}</b><span>{h.s}</span></span>
                  <Tag>{h.kind}</Tag>
                </li>
              ))}
            </ul>
          ) : <div className="pe">Nothing here matches “{q.trim()}”.</div>}
        </div>
      )}
    </div>
  );
}

/* ---------- notifications (P4) ---------- */
/** A row is read once it has been opened, and stays read until a document it has not shown
 *  joins its queue. A read row is still listed, under Earlier - the queue has not gone anywhere. */
function Bell({ uid, queues, detail }: { uid: string; queues: Record<string, string[]>; detail: Record<string, string> }) {
  const nav = useNavigate();
  const role = useApp((s) => s.user?.r);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, box);
  const seen = useSeen(uid);

  const rows = Object.entries(queues)
    .filter(([k, docs]) => docs.length > 0 && NOTE[k])
    .map(([k, docs]) => {
      const was = new Set(seen[k] ?? []);
      return { k, docs, fresh: docs.filter((d) => !was.has(d)).length };
    });
  const fresh = rows.filter((r) => r.fresh > 0);
  const earlier = rows.filter((r) => r.fresh === 0);
  const unread = fresh.reduce((a, r) => a + r.fresh, 0);

  const row = (r: (typeof rows)[number]) => (
    <button key={r.k} type="button" role="menuitem" className={`po${r.fresh ? " nw" : ""}`}
      onClick={() => { markSeen(uid, r.k, r.docs); setOpen(false); nav("/" + ((role && GOES_TO_FOR[role]?.[r.k]) ?? GOES_TO[r.k] ?? r.k)); }}>
      <span className="pb"><b>{NOTE[r.k][0]}</b><span>{detail[r.k] ?? NOTE[r.k][1]}</span></span>
      <span className="pn">{r.fresh && r.fresh < r.docs.length ? `${r.fresh} new · ${r.docs.length}` : r.docs.length}</span>
    </button>
  );

  return (
    <div className="pw" ref={box}>
      <button className="ib" type="button" aria-haspopup="menu" aria-expanded={open}
        aria-label={unread > 0 ? `Notifications - ${unread} unread` : "Notifications - nothing unread"}
        onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M8 2a4 4 0 0 0-4 4c0 3-1 4-1 4h10s-1-1-1-4a4 4 0 0 0-4-4ZM6.5 12.5a1.5 1.5 0 0 0 3 0" /></svg>
        {unread > 0 && <span className="bd">{unread}</span>}
      </button>
      {open && (
        <div className="pop bell" role="menu" aria-label="Notifications">
          <div className="ph">Waiting on you</div>
          {rows.length ? (
            <div className="pl">
              {fresh.length > 0
                ? <div role="group" aria-label="New"><div className="pk" aria-hidden="true">New</div>{fresh.map(row)}</div>
                : <div className="pk">Nothing new since you last looked</div>}
              {earlier.length > 0 && (
                <div role="group" aria-label="Earlier"><div className="pk" aria-hidden="true">Earlier</div>{earlier.map(row)}</div>
              )}
            </div>
          ) : <div className="pe">Nothing is waiting on you right now.</div>}
        </div>
      )}
    </div>
  );
}

/** Whether the bell carries the shifts row - whoever reads every counter's closed shifts. */
const readsShifts = (u: User) => userCan(u, "shift_reports");

/** What each counted queue is, in the words of the person who has to clear it. Keyed by the
 *  screen that clears it, so the sidebar badge and the bell row are one count. */
const NOTE: Record<string, [string, string]> = {
  "outlet-tickets": ["Pick tickets to collect", "Issued to your counter and not yet received"],
  "outlet-requests": ["Requests awaiting approval", "Sent to the outlet manager, no decision yet"],
  approvals: ["Requests awaiting your approval", "Counters cannot move until you decide"],
  issue: ["Documents on the issue desk", "Approvals to ticket, and tickets to hand over"],
  procure: ["Requisitions with procurement", "Sent and not yet decided on"],
  requisitions: ["Requisitions waiting on you", "Raised by the store keeper"],
  pool: ["Lines on the procurement list", "Approved and not yet claimed by a purchase order"],
  "kitchen-orders": ["New kitchen orders", "Received and not yet accepted"],
  avail: ["Products that cannot be sold", "Switched off or out of stock"],
  inventory: ["Items below reorder", "Under the central store's reorder level"],
  "store-stock": ["Items below reorder", "Under the central store's reorder level"],
  dash: ["Batches nearing best-before", "Made recently, due within the next 2 hours"],
  shifts: ["Shifts closed today", "Counter hand-overs, on the Register screen"],
  "qr-orders": ["New QR orders", "Paid online and not started yet"],
};

/** A bell row whose queue is not a sidebar entry of its own opens this screen instead. Keeping
 *  the key off the sidebar keeps a closed shift - news, not work - from counting on a badge. */
const GOES_TO: Record<string, string> = { shifts: "register" };
/** Per desk, where a queue opens when that desk has no screen of the queue's own name: a counter's
 *  products-off row opens its till, where each tile says why it cannot be sold. */
const GOES_TO_FOR: Partial<Record<Role, Record<string, string>>> = { counter: { avail: "pos" } };

/** A row's live second line, where the newest document says more than the queue's description:
 *  the manager reads who closed a shift, where, and for how much. */
function bellDetail(s: AppState): Record<string, string> {
  const last = s.user && readsShifts(s.user) ? s.shifts.find((r) => r.closedAt && isToday(r.closedAt)) : undefined;
  return last ? { shifts: `${last.operator} closed their shift at ${locName(last.loc)} · ${money0(last.totals.nettSales)}` } : {};
}

/* ---------- search index ---------- */
interface Hit { id: string; to: string; t: string; s: string; kind: string }

/** The first of these destinations the session may actually open. */
const dest = (u: User, ...keys: ScreenKey[]) => keys.find((k) => canSee(u, k));

/** Exactly what the palette reads, so `Search` can subscribe to those four and nothing else. */
type SearchState = Pick<AppState, "user" | "req" | "tkt" | "bills">;

function searchHits(s: SearchState, q: string): Hit[] {
  const u = s.user;
  const n = q.trim().toLowerCase();
  if (!u || !n) return [];
  const has = (...v: (string | undefined)[]) => v.some((x) => x?.toLowerCase().includes(n));
  // A session that reads a collection at one counter only ever finds that counter's paperwork -
  // each collection by its own rule, as the server cuts it.
  const mineOf = (c: ReadCollection) => (userReadsWide(u, c) ? null : u.loc);
  const reqAt = mineOf("requests"), tktAt = mineOf("tickets"), billAt = mineOf("bills");

  const navs: Hit[] = navFor(u).flatMap((g) => g.items
    .filter((i) => has(i.label, g.group))
    .map((i) => ({ id: "n:" + i.k, to: i.k, t: i.label, s: g.group, kind: "Go to" })));

  const itemTo = dest(u, "outlet-stock", "items-stock", "store-stock", "kitchen-stock", "inventory");
  const items: Hit[] = !itemTo ? [] : Object.keys(IT)
    .filter((k) => has(IT[k].n, IT[k].c, IT[k].g))
    .map((k) => ({ id: "i:" + k, to: itemTo, t: IT[k].n, s: `${IT[k].c} · ${IT[k].g}`, kind: "Item" }));

  const reqTo = dest(u, "outlet-requests", "kitchen-requests", "approvals", "issue");
  const reqs: Hit[] = !reqTo ? [] : s.req
    .filter((r) => (!reqAt || r.from === reqAt) && has(r.id, r.st, r.by, LOC[r.from].n))
    .map((r) => ({ id: "r:" + r.id, to: reqTo, t: r.id, s: `${LOC[r.from].n} · ${r.st}`, kind: "Request" }));

  const tktTo = dest(u, "outlet-tickets", "kitchen-tickets", "issue");
  const tkts: Hit[] = !tktTo ? [] : s.tkt
    .filter((t) => (!tktAt || t.to === tktAt) && has(t.id, t.st, t.req, LOC[t.from].n, LOC[t.to].n))
    .map((t) => ({
      id: "t:" + t.id, to: tktTo, t: t.id, kind: "Ticket",
      s: `${LOC[t.from].n} → ${LOC[t.to].n} · ${t.st}`,
    }));

  const bills: Hit[] = !canSee(u, "bills") ? [] : s.bills
    .filter((b) => (!billAt || b.loc === billAt) && has(b.no, b.pay, b.opr, b.payer?.name))
    .map((b) => ({
      id: "b:" + b.no, to: "bills", t: b.no, kind: "Bill",
      // ---- bill void: the palette finds a voided bill - it is exactly the one somebody goes
      // looking for - and says so, rather than quoting an amount the hospital never kept.
      s: `${b.pay} · ₹${b.tot.toFixed(2)} · ${b.t}${b.voided ? " · VOIDED" : ""}`,
    }));

  return [navs, reqs, tkts, bills, items].flatMap((x) => x.slice(0, 5)).slice(0, 14);
}

/* ---------- counters ---------- */
/** Listed but unsellable - a manual switch or an empty shelf. */
const offItems = (s: AppState, l: LocKey) => menuOf(s, l).filter((it) => !availOf(s, l, it).ok);

/** The active items the central store carries under their own reorder level - the same test
 *  the buyer's Inventory screen and the store keeper's Stock screen already filter by. */
const belowReorder = (s: AppState) =>
  activeItems().filter((k) => IT[k].rl > 0 && qty(s, "store", k) < IT[k].rl);

const APPROACHING_MS = 2 * 3_600_000;
/** A batch is not tracked once its stock joins the shelf - the ledger only knows an item's
 *  total, not which batch it came from - so "approaching" has to work off the batch record
 *  itself. Its best-before instant is recomputed here with the same rule the server used to
 *  produce it (`bestBeforeAt`, off the batch's own made time and the item's shelf life),
 *  because only the printed "best before HH:MM" string survives onto the wire, not the
 *  instant. Counts a batch whose best-before is under two hours away and has not passed yet;
 *  the interval below (`useBadgeTick`) is what makes this true even when nothing else changes. */
const approachingBestBefore = (s: AppState) =>
  s.batch.filter((b) => {
    const left = bestBeforeAt(new Date(b.iso), IT[b.it]?.sl).getTime() - Date.now();
    return left > 0 && left <= APPROACHING_MS;
  });

const ids = <T extends { id: string }>(xs: T[]) => xs.map((x) => x.id);

/** What each badge counts, as the documents themselves - the sidebar shows how many, and the bell
 *  needs to know which, so it can tell a row it has already shown from one that has news in it. */
function navQueues(s: AppState): Record<string, string[]> {
  const u = s.user;
  if (!u) return {};
  const c: Record<string, string[]> = {};
  const sees = (k: ScreenKey) => canSee(u, k);
  // What is still coming, not what is merely unconfirmed: a withdrawn ticket has nowhere
  // left to go, and `!== "Received"` kept it on the badge for the rest of the day.
  if (sees("outlet-tickets")) c["outlet-tickets"] = ids(s.tkt.filter((t) => t.to === u.loc && isTicketOpen(t.st)));
  if (sees("outlet-requests")) c["outlet-requests"] = ids(s.req.filter((r) => r.from === u.loc && r.st === "Request sent"));
  // The counter's own shelf, opened on its till (`GOES_TO_FOR`); the kitchen's board; and the
  // manager's every-outlet board when `AVAILABILITY_SCREEN_ENABLED` puts it back.
  if (u.r === "counter") { if (sees("pos")) c.avail = offItems(s, u.loc); }
  else if (sees("avail")) {
    c.avail = u.r === "prod"
      ? Object.keys(s.stock.kitchen).filter((k) => IT[k]?.t === "FG" && !availOf(s, "kitchen", k).ok)
      : openOutlets().flatMap((l) => offItems(s, l).map((it) => `${l}:${it}`));
  }
  if (sees("approvals")) c.approvals = ids(s.req.filter((r) => r.st === "Request sent"));
  // Paid online at this counter and nobody has started it: work for whoever may move it on.
  if (sees("qr-orders") && userCan(u, "qr_orders", "edit")) c["qr-orders"] = ids(s.qrOrders.filter((o) => o.loc === u.loc && o.status === "Paid"));
  if (readsShifts(u)) c.shifts = ids(s.shifts.filter((r) => r.closedAt && isToday(r.closedAt)));
  if (sees("issue")) {
    c.issue = [
      ...ids(s.req.filter((r) => (r.st === "Manager approved" || r.st === "Partially approved") && !r.ticket)),
      ...ids(s.tkt.filter((t) => t.from === "store" && t.st === "Issued")),
    ];
  }
  if (sees("procure")) c.procure = ids(s.prq.filter((p) => p.st === "Sent"));
  if (sees("store-stock")) c["store-stock"] = belowReorder(s);
  if (sees("kitchen-orders")) c["kitchen-orders"] = ids(s.pord.filter((o) => o.st === "New"));
  if (u.r === "prod") c.dash = ids(approachingBestBefore(s));
  if (sees("requisitions")) c.requisitions = ids(s.prq.filter((p) => p.st === "Sent"));
  if (sees("pool")) c.pool = procurementList(s).map((l) => `${l.prq}:${l.line}`);
  if (sees("inventory")) c.inventory = belowReorder(s);
  return c;
}
