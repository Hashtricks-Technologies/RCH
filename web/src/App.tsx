import { useEffect } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { useApp } from "./store";
import { HOME, NAV, canSee } from "./nav";
import Shell from "./ui/Shell";
import Login from "./pages/Login";
import Settings from "./pages/Settings";
import Issues from "./pages/Issues";
import { PageHead, Card } from "./ui/kit";
import { screens as counter } from "./roles/counter";
import { screens as manager } from "./roles/manager";
import { screens as store } from "./roles/store";
import { screens as prod } from "./roles/prod";
import { screens as buyer } from "./roles/buyer";
import type { Role } from "./types";

const REGISTRY: Record<Role, Record<string, React.ComponentType>> = { counter, manager, store, prod, buyer };

const labelOf = (k: string) =>
  Object.values(NAV).flat().flatMap((g) => g.items).find((i) => i.k === k)?.label ?? k;

/** UA-01: a refused screen says so on the way out instead of bouncing in silence. */
function Denied({ k }: { k: string }) {
  const user = useApp((s) => s.user)!;
  const notify = useApp((s) => s.notify);
  useEffect(() => {
    const a = /^[AEIOU]/.test(user.rl) ? "an" : "a";
    notify(`${labelOf(k)} is not available to ${a} ${user.rl} — you are back on ${labelOf(HOME[user.r])}`);
  }, [k, user, notify]);
  return <Navigate to={"/" + HOME[user.r]} replace />;
}

function Screen() {
  const { key = "" } = useParams();
  const user = useApp((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  if (!canSee(user.r, key)) return <Denied k={key} />;
  if (key === "settings") return <Settings />;
  if (key === "issues") return <Issues />;
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

export default function App() {
  const user = useApp((s) => s.user);
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={"/" + HOME[user.r]} replace /> : <Login />} />
      <Route path="/:key" element={user ? <Shell><Screen /></Shell> : <Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to={user ? "/" + HOME[user.r] : "/login"} replace />} />
    </Routes>
  );
}
