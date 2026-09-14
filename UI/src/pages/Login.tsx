import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { HOME } from "../nav";
import { useApp } from "../store";
import { Alert } from "../ui/kit";
import mark from "../assets/eateszy-mark.png";

export default function Login() {
  const [emp, setEmp] = useState("");
  const [pw, setPw] = useState("");
  const login = useApp((s) => s.login);
  const auth = useApp((s) => s.auth);
  const refused = useApp((s) => s.authError);
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
        <div className="lgw"><i><img src={mark} alt="eaTesZy" /></i> Royal Care Hospital</div>
        <div className="lgh">
          <h1>Every item, every counter, one ledger.</h1>
          <p>Purchasing, stock, production and billing for the kitchen, the restaurant and every floor shop — running on a single source of truth.</p>
          {/* The counts that stood here were hard-coded, and nothing before sign-in could tell
              the truth about them: the item master and the locations arrive with the snapshot,
              which arrives after. A wrong number is worse than none. */}
        </div>
      </div>
      <div className="lgf"><form className="lgi" onSubmit={submit}>
        <div className="lgl"><img src={mark} alt="" /><span className="lgwm" role="img" aria-label="eaTesZy" /></div>
        <h2>Sign in</h2>
        <p className="sub">Use your employee id and the password you were given. Each role has its own workspace, screens and permissions.</p>
        <div className="fg"><label htmlFor="emp">Employee id</label>
          <input className="inp mono" id="emp" autoComplete="username" autoFocus value={emp} onChange={(e) => setEmp(e.target.value)} placeholder="RC-0000" /></div>
        <div className="fg"><label htmlFor="pw">Password</label>
          <input className="inp mono" id="pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
        {/* The server's own sentence, or that it could not be reached — on the form, where it
            stays until the next attempt, rather than in a toast that is gone in seconds. */}
        {refused && <Alert tone="c" label="REFUSED">{refused}</Alert>}
        <button className="btn wide" disabled={busy || !emp.trim() || !pw} type="submit">{busy ? "Signing in…" : "Sign in"}</button>
        <p className="lgn">Forgotten your password? Ask an administrator to reset it (they run the users CLI) — you will be asked to choose a new one when you next sign in.</p>
      </form></div>
    </div>
  );
}
