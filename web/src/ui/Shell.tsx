import { useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { LOC } from "../data/master";
import { NAV } from "../nav";
import { useApp } from "../store";
import { Avatar, Icon, SearchIcon } from "./kit";
import Drawer from "./Drawer";

export default function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const user = useApp((s) => s.user)!;
  const signOut = useApp((s) => s.signOut);
  const toast = useApp((s) => s.toast);
  const counts = useApp(navCounts);
  const nav = useNavigate();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div id="app" className="on">
      <aside className={`side${open ? " open" : ""}`}>
        <div className="sh"><span className="lm">RC</span><div><b>Royal Care</b><span>Inventory</span></div></div>
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
          <button className="su" type="button" onClick={() => { signOut(); nav("/login"); }}>
            <Avatar name={user.n} color={user.col} size={30} />
            <span className="ut"><b>{user.n}</b><span>{user.rl}</span></span>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M6 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2M10.5 10.5 13 8l-2.5-2.5M13 8H6" />
            </svg>
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="top">
          <button className="burger" type="button" onClick={() => setOpen(!open)} aria-label="Menu">
            <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <path d="M2 4h12M2 8h12M2 12h12" /></svg>
          </button>
          <div className="search"><SearchIcon /><input placeholder="Search…" aria-label="Search" /><kbd>⌘K</kbd></div>
          <div className="tsp" />
          <button className="org" type="button"><span className="dt" />
            <span className="lbl">Royal Care · {LOC[user.loc].n}</span></button>
          <button className="ib" type="button" aria-label="Notifications">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M8 2a4 4 0 0 0-4 4c0 3-1 4-1 4h10s-1-1-1-4a4 4 0 0 0-4-4ZM6.5 12.5a1.5 1.5 0 0 0 3 0" /></svg>
            {total > 0 && <span className="bd">{total}</span>}
          </button>
          <button className="avb" type="button" onClick={() => nav("/settings")}>
            <Avatar name={user.n} color={user.col} size={26} />
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

function navCounts(s: ReturnType<typeof useApp.getState>): Record<string, number> {
  const u = s.user;
  if (!u) return {};
  const c: Record<string, number> = {};
  if (u.r === "counter") {
    c.tickets = s.tkt.filter((t) => t.to === u.loc && t.st !== "Received").length;
    c.requests = s.req.filter((r) => r.from === u.loc && r.st === "Request sent").length;
  }
  if (u.r === "manager") c.approvals = s.req.filter((r) => r.st === "Request sent").length;
  if (u.r === "store") {
    c.issue = s.req.filter((r) => (r.st === "Manager approved" || r.st === "Partially approved") && !r.ticket).length
      + s.tkt.filter((t) => t.from === "store" && t.st === "Issued").length;
    c.procure = s.prq.filter((p) => p.st === "Sent").length;
  }
  if (u.r === "prod") c.orders = s.pord.filter((o) => o.st === "New").length;
  if (u.r === "buyer") c.requisitions = s.prq.filter((p) => p.st === "Sent").length;
  return c;
}
