import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { HOME } from "../nav";
import { useApp } from "../store";

export default function Login() {
  const [emp, setEmp] = useState("");
  const [pw, setPw] = useState("");
  const login = useApp((s) => s.login);
  const auth = useApp((s) => s.auth);
  const nav = useNavigate();
  const busy = auth === "signing-in" || auth === "loading";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emp.trim() || !pw) return;
    const ok = await login(emp.trim(), pw);
    if (!ok) return;
    const s = useApp.getState();
    nav(s.mustChangePassword ? "/change-password" : "/" + HOME[s.user!.r]);
  };

  return (
    <div id="login" style={{ display: "grid" }}>
      <div className="lgb">
        <div className="lgw"><i>RC</i> Royal Care Hospital</div>
        <div className="lgh">
          <h1>Every item, every counter, one ledger.</h1>
          <p>Purchasing, stock, production and billing for the kitchen, the restaurant and every floor shop — running on a single source of truth.</p>
          <div className="lgs">
            <div><b>5</b><span>Locations</span></div>
            <div><b>20</b><span>Items</span></div>
            <div><b>5</b><span>Roles</span></div>
          </div>
        </div>
      </div>
      <div className="lgf"><form className="lgi" onSubmit={submit}>
        <h2>Sign in</h2>
        <p className="sub">Use your employee id and the password you were given. Each role has its own workspace, screens and permissions.</p>
        <div className="fg"><label htmlFor="emp">Employee id</label>
          <input className="inp mono" id="emp" autoComplete="username" autoFocus value={emp} onChange={(e) => setEmp(e.target.value)} placeholder="RC-0000" /></div>
        <div className="fg"><label htmlFor="pw">Password</label>
          <input className="inp mono" id="pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
        <button className="btn wide" disabled={busy || !emp.trim() || !pw} type="submit">{busy ? "Signing in…" : "Sign in"}</button>
        <p className="lgn">Forgotten your password? Ask the store keeper to reset it — you will be asked to choose a new one when you next sign in.</p>
      </form></div>
    </div>
  );
}
