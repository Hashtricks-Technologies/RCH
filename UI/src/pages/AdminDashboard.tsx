import { useNavigate } from "react-router-dom";
import { useApp } from "../store";
import { Btn } from "../ui/kit";
import AdminUsers from "./AdminUsers";

/**
 * The whole of an admin-flagged account's experience — a capability, not a role (root
 * CLAUDE.md), so it gets no operational sidebar built from a `NAV[role]` that would not mean
 * anything for it. `App.tsx` sends such an account here regardless of what path it asked for,
 * and here is the only place it can ever reach — this file supplies the entire page, chrome
 * included, rather than being hosted inside `Shell`.
 */
export default function AdminDashboard() {
  const user = useApp((s) => s.user)!;
  const logout = useApp((s) => s.logout);
  const nav = useNavigate();
  return (
    <div id="admin-dash">
      <header className="adm-top">
        <span className="adm-brand"><i>RC</i> Royal Care · Admin</span>
        <span className="adm-who">{user.n}</span>
        <Btn variant="gh" size="sm" onClick={() => { void logout().then(() => nav("/login")); }}>Sign out</Btn>
      </header>
      <div className="adm-body">
        <AdminUsers />
      </div>
    </div>
  );
}
