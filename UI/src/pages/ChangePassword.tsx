import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { HOME } from "../nav";
import { useApp } from "../store";

export default function ChangePassword() {
  const [cur, setCur] = useState(""); const [next, setNext] = useState(""); const [again, setAgain] = useState("");
  const changePassword = useApp((s) => s.changePassword);
  const user = useApp((s) => s.user);
  const notify = useApp((s) => s.notify);
  const nav = useNavigate();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== again) { notify("The two new passwords do not match."); return; }
    if (next.length < 10) { notify("Choose at least ten characters."); return; }
    if (await changePassword(cur, next) && user) nav("/" + HOME[user.r]);
  };
  return (
    <div id="login" style={{ display: "grid" }}>
      <div className="lgf"><form className="lgi" onSubmit={submit}>
        <h2>Choose a new password</h2>
        <p className="sub">You are using a temporary password. Pick your own before you carry on.</p>
        <div className="fg"><label htmlFor="cur">Current password</label><input className="inp mono" id="cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></div>
        <div className="fg"><label htmlFor="new">New password</label><input className="inp mono" id="new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></div>
        <div className="fg"><label htmlFor="again">New password again</label><input className="inp mono" id="again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></div>
        <button className="btn wide" type="submit" disabled={!cur || !next || !again}>Save and continue</button>
      </form></div>
    </div>
  );
}
