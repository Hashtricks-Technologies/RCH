import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../store";
import { Btn } from "../ui/kit";
import Drawer from "../ui/Drawer";
import AdminAudit from "./AdminAudit";
import AdminOutlets from "./AdminOutlets";
import AdminPayers from "./AdminPayers";
import AdminRegisters from "./AdminRegisters";
import AdminRoles from "./AdminRoles";
import AdminSupport from "./AdminSupport";
import AdminUsers from "./AdminUsers";
import mark from "../assets/eateszy-mark.png";

type Tab = "accounts" | "roles" | "outlets" | "registers" | "payers" | "support" | "audit";

/**
 * The whole of an admin-flagged account's experience - a capability, not a role (root
 * CLAUDE.md), so it gets no operational sidebar built from a `NAV[role]` that would not mean
 * anything for it. `App.tsx` sends such an account here regardless of what path it asked for,
 * and here is the only place it can ever reach - this file supplies the entire page, chrome
 * included, rather than being hosted inside `Shell`.
 *
 * Seven tabs: staff accounts, the roles they hold and what each grants, the hospital's retail
 * outlets, every outlet's register (the X, the Zs, and closing the day), the payer register of
 * everyone a bill may be posted to, the support desk that answers every role's tickets, and the
 * audit log of every change and sign-in.
 */
export default function AdminDashboard() {
  const user = useApp((s) => s.user)!;
  const logout = useApp((s) => s.logout);
  const loadDeskTickets = useApp((s) => s.loadDeskTickets);
  const loadAdminLocations = useApp((s) => s.loadAdminLocations);
  const loadAdminPayers = useApp((s) => s.loadAdminPayers);
  const waiting = useApp((s) => s.deskTickets.filter((t) => t.st === "Open" || t.st === "With support").length);
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>("accounts");

  // Read here rather than on the desk tab, so the count beside it is right before it is opened.
  // After this first read the change stream keeps the list current (`refetch`'s `tickets`).
  // The location list is read here too, so every tab has its labels the moment it is opened,
  // not only the Outlets tab that manages them, and the payer register with it.
  useEffect(() => {
    void loadDeskTickets(); void loadAdminLocations(); void loadAdminPayers();
  }, [loadDeskTickets, loadAdminLocations, loadAdminPayers]);

  return (
    <div id="admin-dash">
      <header className="adm-top">
        <span className="adm-brand"><i><img src={mark} alt="eaTesZy" /></i> Royal Care · Admin</span>
        <nav className="adm-tabs" role="tablist" aria-label="Admin">
          <button type="button" role="tab" aria-selected={tab === "accounts"} className={tab === "accounts" ? "on" : undefined}
            onClick={() => setTab("accounts")}>Accounts</button>
          <button type="button" role="tab" aria-selected={tab === "roles"} className={tab === "roles" ? "on" : undefined}
            onClick={() => setTab("roles")}>Roles</button>
          <button type="button" role="tab" aria-selected={tab === "outlets"} className={tab === "outlets" ? "on" : undefined}
            onClick={() => setTab("outlets")}>Outlets</button>
          <button type="button" role="tab" aria-selected={tab === "registers"} className={tab === "registers" ? "on" : undefined}
            onClick={() => setTab("registers")}>Registers</button>
          <button type="button" role="tab" aria-selected={tab === "payers"} className={tab === "payers" ? "on" : undefined}
            onClick={() => setTab("payers")}>Payers</button>
          <button type="button" role="tab" aria-selected={tab === "support"} className={tab === "support" ? "on" : undefined}
            onClick={() => setTab("support")}>
            Support desk
            {waiting > 0 && <span className="adm-count" aria-label={`${waiting} need support`}>{waiting}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === "audit"} className={tab === "audit" ? "on" : undefined}
            onClick={() => setTab("audit")}>Audit log</button>
        </nav>
        <span className="adm-who">{user.n}</span>
        <Btn variant="gh" size="sm" onClick={() => { void logout().then(() => nav("/login")); }}>Sign out</Btn>
      </header>
      <div className="adm-body" role="tabpanel">
        {tab === "accounts" ? <AdminUsers />
          : tab === "roles" ? <AdminRoles />
            : tab === "outlets" ? <AdminOutlets />
              : tab === "registers" ? <AdminRegisters />
                : tab === "payers" ? <AdminPayers />
                  : tab === "support" ? <AdminSupport /> : <AdminAudit />}
      </div>
      {/* Every other screen gets its drawer host from `Shell`, which this page never renders, so it
          mounts its own. The audit log opens each of its entries in a drawer, and Roles its
          permission matrix. */}
      <Drawer />
    </div>
  );
}
