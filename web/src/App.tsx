import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { useApp } from "./store";
import { HOME, canSee } from "./nav";
import Shell from "./ui/Shell";
import Login from "./pages/Login";
import Settings from "./pages/Settings";
import { PageHead, Card } from "./ui/kit";
import { screens as counter } from "./roles/counter";
import { screens as manager } from "./roles/manager";
import { screens as store } from "./roles/store";
import { screens as prod } from "./roles/prod";
import { screens as buyer } from "./roles/buyer";
import type { Role } from "./types";

const REGISTRY: Record<Role, Record<string, React.ComponentType>> = { counter, manager, store, prod, buyer };

function Screen() {
  const { key = "" } = useParams();
  const user = useApp((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  if (!canSee(user.r, key)) return <Navigate to={"/" + HOME[user.r]} replace />;
  if (key === "settings") return <Settings />;
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
