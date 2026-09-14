import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { HOME } from "../nav";
import { useApp } from "../store";
import { Alert } from "../ui/kit";
import type { SignInEntry } from "../types";
import mark from "../assets/eateszy-mark.png";

/**
 * Sign-in. Staff pick themselves from the directory (`GET /auth/directory`: number and name,
 * active staff only) rather than typing an employee id from memory; the super admin is not in
 * that list, on purpose, and signs in through the typed field behind "Sign in as administrator".
 * If the list cannot be read the typed field is all there is, so nobody is locked out by it.
 */
export default function Login() {
  const [dir, setDir] = useState<SignInEntry[] | null | undefined>(undefined);
  const [typedMode, setTypedMode] = useState(false);
  const [typed, setTyped] = useState("");
  const [chosen, setChosen] = useState<SignInEntry | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pw, setPw] = useState("");
  const pwRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const loadSignInDirectory = useApp((s) => s.loadSignInDirectory);
  const login = useApp((s) => s.login);
  const auth = useApp((s) => s.auth);
  const refused = useApp((s) => s.authError);
  const nav = useNavigate();

  useEffect(() => {
    let live = true;
    void loadSignInDirectory().then((d) => { if (live) setDir(d); });
    return () => { live = false; };
  }, [loadSignInDirectory]);

  // The list could not be read: the typed field is the only way in, and it says why.
  const typedOnly = dir === null;
  const typing = typedMode || typedOnly;
  const q = query.trim().toLowerCase();
  const matches = (dir ?? []).filter((e) => !q || e.emp.toLowerCase().includes(q) || e.n.toLowerCase().includes(q));
  // A password manager fills the search box with the id it saved, not a click on the list, so
  // an exact id typed or filled there counts as picking that person.
  const exact = (dir ?? []).find((e) => e.emp.toLowerCase() === q);
  const emp = typing ? typed.trim() : (chosen?.emp ?? exact?.emp ?? "");

  const busy = auth === "signing-in" || auth === "loading";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emp || !pw) return;
    const ok = await login(emp, pw);
    if (!ok) return;
    const s = useApp.getState();
    nav(s.mustChangePassword ? "/change-password" : "/" + (s.user!.admin ? "admin" : HOME[s.user!.r]));
  };

  const choose = (entry: SignInEntry) => {
    setChosen(entry);
    setQuery("");
    setOpen(false);
    pwRef.current?.focus();
  };
  const change = () => {
    setChosen(null);
    setActive(0);
    setOpen(true);
    // The search box is drawn again by this same update; focus it once it is there.
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      // Enter on an open list picks the highlighted person; it must not submit a form that has
      // no password in it yet.
      if (open && matches[active]) { e.preventDefault(); choose(matches[active]); }
    } else if (e.key === "Escape") {
      if (open) { e.preventDefault(); setOpen(false); } else setQuery("");
    }
  };
  const toTyped = () => { setTypedMode(true); setChosen(null); setQuery(""); setOpen(false); };
  const toList = () => { setTypedMode(false); setTyped(""); };

  const optionId = (i: number) => `emp-opt-${i}`;
  const expanded = open && !typing && chosen === null && dir !== undefined;

  return (
    <div id="login" style={{ display: "grid" }}>
      <div className="lgb">
        <div className="lgw"><i><img src={mark} alt="eaTesZy" /></i> Royal Care Hospital</div>
        <div className="lgh">
          <h1>Every item, every counter, one ledger.</h1>
          <p>Purchasing, stock, kitchen and billing in one place.</p>
          {/* The counts that stood here were hard-coded, and nothing before sign-in could tell
              the truth about them: the item master and the locations arrive with the snapshot,
              which arrives after. A wrong number is worse than none. */}
        </div>
      </div>
      <div className="lgf"><form className="lgi" onSubmit={submit}>
        <div className="lgl"><img src={mark} alt="" /><span className="lgwm" role="img" aria-label="eaTesZy" /></div>
        <h2>Sign in</h2>
        <p className="sub">{typing ? "Enter your employee ID and password." : "Choose your employee ID, then enter your password."}</p>

        {typing ? (
          <div className="fg"><label htmlFor="emp">Employee id</label>
            <input className="inp mono" id="emp" name="username" autoComplete="username" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="RC-0000" />
            {typedOnly && <p className="lgpick-note">The staff list could not be loaded — type your employee ID instead.</p>}
          </div>
        ) : chosen ? (
          <div className="fg"><label htmlFor="emp">Employee</label>
            <div className="lgpick-chosen">
              {/* A real, read-only field holding the id, so a password manager saving this sign-in
                  records the right username beside the password. */}
              <input className="lgpick-id mono" id="emp" name="username" autoComplete="username" readOnly value={chosen.emp} />
              <span className="lgpick-name">{chosen.n}</span>
              <button type="button" className="lgpick-change" onClick={change}>Change</button>
            </div>
          </div>
        ) : (
          <div className="fg lgpick"><label htmlFor="emp" id="emp-label">Employee</label>
            <input
              ref={searchRef}
              className="inp"
              id="emp"
              name="username"
              autoComplete="username"
              autoFocus
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={expanded}
              aria-controls="emp-list"
              aria-activedescendant={expanded && matches[active] ? optionId(active) : undefined}
              placeholder={dir === undefined ? "Loading the staff list…" : "Search by name or employee ID"}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
              // Opened by a click, a keystroke or an arrow — not by the autofocus on arrival, which
              // would drop the whole list over the password box before anybody asked for it.
              onClick={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              onKeyDown={onKey}
            />
            {expanded && (
              <ul id="emp-list" role="listbox" aria-labelledby="emp-label" className="lgpick-list">
                {matches.length === 0 ? (
                  <li className="lgpick-none" role="presentation">
                    {dir!.length === 0 ? "No staff accounts yet." : `Nobody matches “${query.trim()}”.`}
                  </li>
                ) : matches.map((entry, i) => (
                  <li
                    key={entry.emp}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    className={i === active ? "on" : undefined}
                    // Keep focus in the search box, so the blur does not close the list under the click.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(entry)}
                  >
                    <span className="mono">{entry.emp}</span>
                    <span>{entry.n}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="fg"><label htmlFor="pw">Password</label>
          <input ref={pwRef} className="inp mono" id="pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
        {/* The server's own sentence, or that it could not be reached — on the form, where it
            stays until the next attempt, rather than in a toast that is gone in seconds. */}
        {refused && <Alert tone="c" label="REFUSED">{refused}</Alert>}
        <button className="btn wide" disabled={busy || !emp || !pw} type="submit">{busy ? "Signing in…" : "Sign in"}</button>
        {!typedOnly && (
          <p className="lgpick-mode">
            {typing
              ? <button type="button" className="lgpick-link" onClick={toList}>Back to the staff list</button>
              : <button type="button" className="lgpick-link" onClick={toTyped}>Sign in as administrator</button>}
          </p>
        )}
        <p className="lgn">Forgotten your password? Ask an administrator to reset it — you will be asked to choose a new one when you next sign in.</p>
      </form></div>
    </div>
  );
}
