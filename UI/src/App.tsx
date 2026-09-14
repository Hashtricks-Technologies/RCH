import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useApp } from "./store";
import { HOME, NAV, canSee } from "./nav";
import Shell from "./ui/Shell";
import Toast from "./ui/Toast";
import Login from "./pages/Login";
import ChangePassword from "./pages/ChangePassword";
import Settings from "./pages/Settings";
import Support from "./pages/Support";
import AdminDashboard from "./pages/AdminDashboard";
import { Btn, PageHead, Card } from "./ui/kit";
import { screens as counter } from "./roles/counter";
import { screens as manager } from "./roles/manager";
import { screens as store } from "./roles/store";
import { screens as prod } from "./roles/prod";
import { screens as buyer } from "./roles/buyer";
import type { Role } from "./types";

const REGISTRY: Record<Role, Record<string, React.ComponentType>> = { counter, manager, store, prod, buyer };

/** The sidebar name for a route key. Several keys are shared and named differently by the roles
 *  that hold them - `orders` is *Orders* to the kitchen and *Purchase Orders* to the buyer - so
 *  the signed-in role's own sidebar is asked first, and any role's only when the key is not on
 *  it. Without that, which name a person is told depended on the order `NAV`'s keys happen to
 *  be declared in, and a kitchen sent back to its board could be told it was on Purchase Orders. */
const labelIn = (role: Role, k: string) => NAV[role].flatMap((g) => g.items).find((i) => i.k === k)?.label;
const labelOf = (role: Role, k: string) =>
  labelIn(role, k) ?? Object.values(NAV).flat().flatMap((g) => g.items).find((i) => i.k === k)?.label
  ?? (k === "admin" ? "Manage staff accounts" : k);

/** UA-01: a refused screen says so on the way out instead of bouncing in silence. */
function Denied({ k }: { k: string }) {
  const user = useApp((s) => s.user)!;
  const notify = useApp((s) => s.notify);
  useEffect(() => {
    const a = /^[AEIOU]/.test(user.rl) ? "an" : "a";
    notify(`${labelOf(user.r, k)} is not available to ${a} ${user.rl} - you are back on ${labelOf(user.r, HOME[user.r])}`);
  }, [k, user, notify]);
  return <Navigate to={"/" + HOME[user.r]} replace />;
}

/** The admin-only equivalent of `<Denied>`: an admin-flagged account has no operational role to
 *  describe it by (a capability, not a role - root CLAUDE.md), so `labelOf` - which reads a
 *  role's own `NAV` - has nothing to answer with here. Says so in its own words instead, and
 *  sends the account back to the one place it has. */
function BackToAdmin() {
  const notify = useApp((s) => s.notify);
  useEffect(() => { notify("That screen is not part of this account - you are back on account management."); }, [notify]);
  return <Navigate to="/admin" replace />;
}

function Screen() {
  const { key = "" } = useParams();
  const user = useApp((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  // A capability, not a role (root CLAUDE.md): an admin-flagged account has no `NAV` entry, no
  // sidebar and no operational home - `/admin` is the only key it can ever reach, checked here,
  // ahead of `canSee`, which only ever knows about the five operational roles.
  if (user.admin) return key === "admin" ? <AdminDashboard /> : <BackToAdmin />;
  if (!canSee(user.r, key)) return <Denied k={key} />;
  if (key === "settings") return <Settings />;
  if (key === "issues") return <Support />;
  const C = REGISTRY[user.r][key];
  if (!C) {
    return (
      <>
        <PageHead crumbs={["Royal Care"]} title="Coming up" sub="This screen is not wired yet." />
        <Card title="Placeholder"><p className="mini">Screen key: {key}</p></Card>
      </>
    );
  }
  return <C />;
}

/**
 * The one thing no toast can say, because there is nobody to say it: the terminal has lost the
 * network. Every write in this app is a server call, so a counter that cannot reach the server
 * cannot bill, and "Could not reach the server" once per attempt does not tell the operator it
 * is the cable rather than the hospital's server. This stays up for as long as it is true.
 */
function OfflineBanner() {
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && navigator.onLine === false);
  useEffect(() => {
    const back = () => setOffline(false);
    const gone = () => setOffline(true);
    window.addEventListener("online", back);
    window.addEventListener("offline", gone);
    return () => { window.removeEventListener("online", back); window.removeEventListener("offline", gone); };
  }, []);
  if (!offline) return null;
  // Inline rather than a class: it is one element, and `styles.css` should not gain a rule that
  // is only ever used here.
  return (
    <div
      role="status"
      style={{
        position: "fixed", insetInline: 0, top: 0, zIndex: 400, textAlign: "center",
        padding: "7px 16px", fontSize: 12, fontWeight: 600,
        background: "var(--crit)", color: "var(--ground)",
        // It sits over the top of the header while it is up; nothing on it is clickable, so
        // the burger and the search underneath stay reachable.
        pointerEvents: "none",
      }}
    >
      No network - this terminal is offline
    </div>
  );
}

export default function App() {
  // The toast is drawn here, once, above every page - not by the shell. Sign-in,
  // change-password, the loading gate and the failed page all render outside the shell, and a
  // sentence raised on any of them used to be set in the store and never shown.
  return (
    <>
      <OfflineBanner />
      <Page />
      <Toast />
    </>
  );
}

function Page() {
  const user = useApp((s) => s.user);
  const auth = useApp((s) => s.auth);
  const mcp = useApp((s) => s.mustChangePassword);
  const nav = useNavigate();
  // The snapshot is the whole application's data: show that it is on its way
  // rather than a screen full of the seed nobody asked for.
  if (auth === "loading") {
    return (
      <div className="lgi" style={{ margin: "20vh auto" }}>
        <h2>Loading…</h2>
        <p className="sub">Fetching today's stock, requests and bills.</p>
      </div>
    );
  }
  // Signed in, and the snapshot never arrived. There is no item master, no locations and no
  // menus behind this, so there is no screen to fall back to - every one of them would read an
  // empty registry and throw. One page, one sentence, a button that asks again, and a way out
  // for an operator who signed in as the wrong person rather than a bad connection.
  if (auth === "failed") {
    return (
      <div className="lgi" style={{ margin: "20vh auto" }}>
        <h2>Could not load the hospital's data - check the connection</h2>
        <p className="sub">
          You are signed in, but the server did not send today's item master, stock or documents,
          and nothing can be shown without them.
        </p>
        <div className="btnrow" style={{ marginTop: 14 }}>
          <Btn onClick={() => { void useApp.getState().loadSnapshot(); }}>Retry</Btn>
          {/* Navigate once the token and the cookie are actually gone, or the guard on
              /login bounces straight back to this same failed page. */}
          <Btn variant="gh" onClick={() => { void useApp.getState().logout().then(() => nav("/login")); }}>
            Sign out
          </Btn>
        </div>
      </div>
    );
  }
  // Where a signed-in account lands: `/admin` for the capability, never `HOME[user.r]` - an
  // admin-flagged account's nominal role is bookkeeping the schema needs, not an identity this
  // app shows it (root CLAUDE.md).
  const home = user ? (user.admin ? "admin" : HOME[user.r]) : "login";
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={mcp ? "/change-password" : "/" + home} replace /> : <Login />} />
      <Route path="/change-password" element={user ? <ChangePassword /> : <Navigate to="/login" replace />} />
      <Route
        path="/:key"
        element={user
          ? (mcp ? <Navigate to="/change-password" replace /> : (user.admin ? <Screen /> : <Shell><Screen /></Shell>))
          : <Navigate to="/login" replace />}
      />
      <Route path="*" element={<Navigate to={"/" + home} replace />} />
    </Routes>
  );
}
