import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../store";
import { Btn } from "../ui/kit";
import AdminSupport from "./AdminSupport";
import AdminUsers from "./AdminUsers";
import mark from "../assets/eateszy-mark.png";

type Tab = "accounts" | "support";

/**
 * The whole of an admin-flagged account's experience - a capability, not a role (root
 * CLAUDE.md), so it gets no operational sidebar built from a `NAV[role]` that would not mean
 * anything for it. `App.tsx` sends such an account here regardless of what path it asked for,
 * and here is the only place it can ever reach - this file supplies the entire page, chrome
 * included, rather than being hosted inside `Shell`.
 *
 * Two tabs: staff accounts, and the support desk that answers every role's tickets.
 */
export default function AdminDashboard() {
  const user = useApp((s) => s.user)!;
  const logout = useApp((s) => s.logout);
  const loadDeskTickets = useApp((s) => s.loadDeskTickets);
  const waiting = useApp((s) => s.deskTickets.filter((t) => t.st === "Open" || t.st === "With support").length);
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>("accounts");

  // Read here rather than on the desk tab, so the count beside it is right before it is opened.
  // After this first read the change stream keeps the list current (`refetch`'s `tickets`).
  useEffect(() => { void loadDeskTickets(); }, [loadDeskTickets]);

  return (
    <div id="admin-dash">
      <header className="adm-top">
        <span className="adm-brand"><i><img src={mark} alt="eaTesZy" /></i> Royal Care · Admin</span>
        <nav className="adm-tabs" role="tablist" aria-label="Admin">
          <button type="button" role="tab" aria-selected={tab === "accounts"} className={tab === "accounts" ? "on" : undefined}
            onClick={() => setTab("accounts")}>Accounts</button>
          <button type="button" role="tab" aria-selected={tab === "support"} className={tab === "support" ? "on" : undefined}
            onClick={() => setTab("support")}>
            Support desk
            {waiting > 0 && <span className="adm-count" aria-label={`${waiting} need support`}>{waiting}</span>}
          </button>
        </nav>
        <span className="adm-who">{user.n}</span>
        <Btn variant="gh" size="sm" onClick={() => { void logout().then(() => nav("/login")); }}>Sign out</Btn>
      </header>
      <div className="adm-body" role="tabpanel">
        {tab === "accounts" ? <AdminUsers /> : <AdminSupport />}
      </div>
    </div>
  );
}
