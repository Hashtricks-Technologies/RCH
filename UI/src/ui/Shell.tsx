import {
  useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject,
} from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { IT, LOC, OUTLETS, homeLabel } from "../data/master";
import { NAV, canSee } from "../nav";
import { useApp, type AppState } from "../store";
import { availOf, isTicketOpen, menuOf, procurementList } from "../lib/selectors";
import type { LocKey, Role } from "../types";
import { useStreamState } from "../api/events";
import { Avatar, Icon, Pill, SearchIcon, Tag, ThemeButton } from "./kit";
import { applyPrefs, readPrefs, usePhoto } from "./prefs";
import Drawer from "./Drawer";

export default function Shell({ children }: { children: ReactNode }) {
  // `open` is the mobile drawer; `collapsed` hides the rail on a wide screen.
  // The burger is the way back in both cases — on desktop it only appears once
  // the sidebar is collapsed, so there is never a state with no way to reopen.
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const user = useApp((s) => s.user)!;
  const logout = useApp((s) => s.logout);
  const toast = useApp((s) => s.toast);
  // NOTE: navCounts builds a fresh object, so it must never be passed to useApp()
  // as a selector — zustand v5 feeds the selector result to useSyncExternalStore and a
  // new identity on every call re-renders forever. Read the whole (stable) state instead.
  const state = useApp();
  const counts = navCounts(state);
  const photo = usePhoto();
  const live = useStreamState();
  const nav = useNavigate();

  // The compact-table preference is stamped on the root, so it outlives Settings.
  useEffect(() => { applyPrefs(readPrefs()); }, []);

  return (
    <div id="app" className={`on${collapsed ? " sc" : ""}`}>
      <aside className={`side${open ? " open" : ""}`}>
        <div className="sh">
          <span className="lm">RC</span>
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
          {NAV[user.r].map((g) => (
            <div key={g.group}>
              <div className="navg">{g.group}</div>
              {g.items.map((it) => (
                <NavLink key={it.k} to={"/" + it.k} onClick={() => setOpen(false)}
                  className={({ isActive }) => (isActive ? "on" : "")}>
                  <Icon name={it.icon} /><span>{it.label}</span>
                  {counts[it.k] > 0 && <span className="ct hot">{counts[it.k]}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sf">
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
          <button className="org" type="button"><span className="dt" />
            <span className="lbl">Royal Care{homeLabel(user) ? ` · ${homeLabel(user)}` : ""}</span></button>
          {/* Nothing is shown while the stream is live: a badge that is always there stops being read. */}
          {live === "reconnecting" && <Pill tone="wn">Reconnecting</Pill>}
          <ThemeButton />
          <Bell counts={counts} />
          <button className="avb" type="button" onClick={() => nav("/settings")}>
            <Avatar name={user.n} color={user.col} size={26} src={photo} />
            <span className="nmx"><b>{user.n.split(" ")[0]}</b><span>{user.rl}</span></span>
          </button>
        </header>
        <div className="pg">{children}</div>
      </div>
      <Drawer />
      {toast && <div className="toast"><span className="ti" /><span>{toast}</span></div>}
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
  const s = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  const lid = useId();
  const hits = useMemo(() => searchHits(s, q), [s, q]);
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
function Bell({ counts }: { counts: Record<string, number> }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, box);

  const items = Object.entries(counts).filter(([k, n]) => n > 0 && NOTE[k]);
  const total = items.reduce((a, [, n]) => a + n, 0);

  return (
    <div className="pw" ref={box}>
      <button className="ib" type="button" aria-haspopup="menu" aria-expanded={open}
        aria-label={total > 0 ? `Notifications — ${total} waiting` : "Notifications — nothing waiting"}
        onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M8 2a4 4 0 0 0-4 4c0 3-1 4-1 4h10s-1-1-1-4a4 4 0 0 0-4-4ZM6.5 12.5a1.5 1.5 0 0 0 3 0" /></svg>
        {total > 0 && <span className="bd">{total}</span>}
      </button>
      {open && (
        <div className="pop" role="menu" aria-label="Notifications">
          <div className="ph">Waiting on you</div>
          {items.length ? (
            <div className="pl">
              {items.map(([k, n]) => (
                <button key={k} type="button" role="menuitem" className="po"
                  onClick={() => { setOpen(false); nav("/" + k); }}>
                  <span className="pb"><b>{NOTE[k][0]}</b><span>{NOTE[k][1]}</span></span>
                  <span className="pn">{n}</span>
                </button>
              ))}
            </div>
          ) : <div className="pe">Nothing is waiting on you right now.</div>}
        </div>
      )}
    </div>
  );
}

/** What each counted queue is, in the words of the person who has to clear it. */
const NOTE: Record<string, [string, string]> = {
  tickets: ["Pick tickets to collect", "Issued to your counter and not yet received"],
  requests: ["Requests awaiting approval", "Sent to the outlet manager, no decision yet"],
  approvals: ["Requests awaiting your approval", "Counters cannot move until you decide"],
  issue: ["Documents on the issue desk", "Approvals to ticket, and tickets to hand over"],
  procure: ["Requisitions with procurement", "Sent and not yet decided on"],
  requisitions: ["Requisitions waiting on you", "Raised by the store keeper"],
  pool: ["Lines on the procurement list", "Approved and not yet claimed by a purchase order"],
  orders: ["New kitchen orders", "Received and not yet accepted"],
  avail: ["Products that cannot be sold", "Switched off, out of stock, or short an ingredient"],
};

/* ---------- search index ---------- */
interface Hit { id: string; to: string; t: string; s: string; kind: string }

/** The first of these destinations the role may actually open. */
const dest = (r: Role, ...keys: string[]) => keys.find((k) => canSee(r, k));

function searchHits(s: AppState, q: string): Hit[] {
  const u = s.user;
  const n = q.trim().toLowerCase();
  if (!u || !n) return [];
  const has = (...v: (string | undefined)[]) => v.some((x) => x?.toLowerCase().includes(n));
  // A counter operator only ever sees its own paperwork.
  const mine = u.r === "counter" ? u.loc : null;

  const navs: Hit[] = NAV[u.r].flatMap((g) => g.items
    .filter((i) => has(i.label, g.group))
    .map((i) => ({ id: "n:" + i.k, to: i.k, t: i.label, s: g.group, kind: "Go to" })));

  const itemTo = dest(u.r, "stock", "inventory");
  const items: Hit[] = !itemTo ? [] : Object.keys(IT)
    .filter((k) => has(IT[k].n, IT[k].c, IT[k].g))
    .map((k) => ({ id: "i:" + k, to: itemTo, t: IT[k].n, s: `${IT[k].c} · ${IT[k].g}`, kind: "Item" }));

  const reqTo = dest(u.r, "requests", "approvals", "issue");
  const reqs: Hit[] = !reqTo ? [] : s.req
    .filter((r) => (!mine || r.from === mine) && has(r.id, r.st, r.by, LOC[r.from].n))
    .map((r) => ({ id: "r:" + r.id, to: reqTo, t: r.id, s: `${LOC[r.from].n} · ${r.st}`, kind: "Request" }));

  const tktTo = dest(u.r, "tickets", "issue");
  const tkts: Hit[] = !tktTo ? [] : s.tkt
    .filter((t) => (!mine || t.to === mine) && has(t.id, t.st, t.req, LOC[t.from].n, LOC[t.to].n))
    .map((t) => ({
      id: "t:" + t.id, to: tktTo, t: t.id, kind: "Ticket",
      s: `${LOC[t.from].n} → ${LOC[t.to].n} · ${t.st}`,
    }));

  const bills: Hit[] = !canSee(u.r, "bills") ? [] : s.bills
    .filter((b) => (!mine || b.loc === mine) && has(b.no, b.pay, b.opr, b.payer?.name))
    .map((b) => ({
      id: "b:" + b.no, to: "bills", t: b.no, kind: "Bill",
      s: `${b.pay} · ₹${b.tot.toFixed(2)} · ${b.t}`,
    }));

  return [navs, reqs, tkts, bills, items].flatMap((x) => x.slice(0, 5)).slice(0, 14);
}

/* ---------- counters ---------- */
/** Listed but unsellable — a manual switch, an empty shelf or a missing ingredient. */
const offCount = (s: AppState, l: LocKey) => menuOf(s, l).filter((it) => !availOf(s, l, it).ok).length;

function navCounts(s: AppState): Record<string, number> {
  const u = s.user;
  if (!u) return {};
  const c: Record<string, number> = {};
  if (u.r === "counter") {
    // What is still coming, not what is merely unconfirmed: a withdrawn ticket has nowhere
    // left to go, and `!== "Received"` kept it on the badge for the rest of the day.
    c.tickets = s.tkt.filter((t) => t.to === u.loc && isTicketOpen(t.st)).length;
    c.requests = s.req.filter((r) => r.from === u.loc && r.st === "Request sent").length;
    c.avail = offCount(s, u.loc);
  }
  if (u.r === "manager") {
    c.approvals = s.req.filter((r) => r.st === "Request sent").length;
    c.avail = OUTLETS.reduce((n, l) => n + offCount(s, l), 0);
  }
  if (u.r === "store") {
    c.issue = s.req.filter((r) => (r.st === "Manager approved" || r.st === "Partially approved") && !r.ticket).length
      + s.tkt.filter((t) => t.from === "store" && t.st === "Issued").length;
    c.procure = s.prq.filter((p) => p.st === "Sent").length;
  }
  if (u.r === "prod") {
    c.orders = s.pord.filter((o) => o.st === "New").length;
    c.avail = Object.keys(s.stock.kitchen)
      .filter((k) => IT[k]?.t === "FG" && !availOf(s, "kitchen", k).ok).length;
  }
  if (u.r === "buyer") {
    c.requisitions = s.prq.filter((p) => p.st === "Sent").length;
    c.pool = procurementList(s).length;
  }
  return c;
}
