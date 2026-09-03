import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { USERS, homeLabel } from "../data/master";
import { HOME } from "../nav";
import { useApp } from "../store";
import { Avatar } from "../ui/kit";

export default function Login() {
  const [pick, setPick] = useState<string | null>(null);
  const signIn = useApp((s) => s.signIn);
  const nav = useNavigate();
  const chosen = USERS.find((u) => u.id === pick);

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
      <div className="lgf"><div className="lgi">
        <h2>Sign in</h2>
        <p className="sub">Choose an account. Each role has its own workspace, screens and permissions.</p>
        <div className="acl">
          {USERS.map((u) => (
            <button key={u.id} type="button" className="acc" aria-pressed={pick === u.id} onClick={() => setPick(u.id)}>
              <Avatar name={u.n} color={u.col} />
              <span className="at"><b>{u.n}</b><span>{u.rl}{homeLabel(u) ? ` · ${homeLabel(u)}` : ""}</span></span>
              {pick === u.id && (
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" strokeWidth={2}>
                  <path d="M3 8.5 6 11.5l7-7" />
                </svg>
              )}
            </button>
          ))}
        </div>
        <div className="fg"><label htmlFor="em">Email address</label>
          <input className="inp mono" id="em" readOnly value={chosen?.e ?? ""} placeholder="name@royalcare.in" /></div>
        <div className="fg"><label htmlFor="pw">Password</label>
          <input className="inp mono" id="pw" type="password" readOnly value={chosen ? "••••••••••" : ""} /></div>
        <button className="btn wide" disabled={!chosen} type="button"
          onClick={() => { if (!chosen) return; signIn(chosen.id); nav("/" + HOME[chosen.r]); }}>
          Sign in
        </button>
        <p className="lgn">Prototype build — pick an account and the credentials fill themselves. State lives in this browser tab for the session.</p>
      </div></div>
    </div>
  );
}
