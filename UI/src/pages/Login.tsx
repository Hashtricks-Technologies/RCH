import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { HOME } from "../nav";
import { useApp } from "../store";
import { locName } from "../lib/selectors";
import { LOC } from "../data/master";
import { Alert, Tip } from "../ui/kit";
import type { LocKey, SignInEntry } from "../types";
import mark from "../assets/eateszy-mark.png";

/** Only when `switchLocation` could not reach the server at all - it puts the server's own
 *  sentence on the toast, and this screen reads that rather than writing its own. */
const COUNTER_UNREACHABLE = "Could not move to that counter - check the connection and try again.";

/**
 * Sign-in. Staff pick themselves from the directory (`GET /auth/directory`: number and name,
 * active staff only) rather than typing an employee id from memory; the super admin is not in
 * that list, on purpose, and signs in through the typed field behind "Sign in as administrator".
 * If the list cannot be read the typed field is all there is, so nobody is locked out by it.
 *
 * There is a third step for the one account shape that needs it: a consultant posted to more
 * than one counter is asked which one they are signing in to, before anything behind the shell
 * is drawn against the wrong outlet. `postings.length > 1` is the whole test - with one posting
 * (every other account) the sign-in is exactly the two steps it always was, and this never draws.
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
  // ---- step 3, the counter picker. `picking` is only ever set for an account the server said
  // has more than one posting, so nothing here costs a single-posting sign-in anything.
  const [picking, setPicking] = useState(false);
  const [locAt, setLocAt] = useState(0);
  const [moving, setMoving] = useState(false);
  const [locRefused, setLocRefused] = useState<string | null>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const locRef = useRef<HTMLUListElement>(null);
  const loadSignInDirectory = useApp((s) => s.loadSignInDirectory);
  const login = useApp((s) => s.login);
  const auth = useApp((s) => s.auth);
  const refused = useApp((s) => s.authError);
  const postings = useApp((s) => s.postings);
  const switchLocation = useApp((s) => s.switchLocation);
  const dismissToast = useApp((s) => s.dismissToast);
  const nav = useNavigate();

  useEffect(() => {
    let live = true;
    void loadSignInDirectory().then((d) => { if (live) setDir(d); });
    return () => { live = false; };
  }, [loadSignInDirectory]);

  // The list is the step, so it takes the keyboard the moment the step appears - the way the
  // search box does on arrival and the password box does on a pick.
  useEffect(() => { if (picking) locRef.current?.focus(); }, [picking]);

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
  /** Where the session belongs once there is nothing left to ask. */
  const enter = () => {
    const s = useApp.getState();
    nav(s.mustChangePassword ? "/change-password" : "/" + (s.user!.admin ? "admin" : HOME[s.user!.r]));
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emp || !pw) return;
    const ok = await login(emp, pw);
    if (!ok) return;
    const s = useApp.getState();
    // More than one posting: ask which counter before the app routes anywhere. A password still
    // to change is asked for first - there is nothing to stand at until the account is usable.
    if (!s.mustChangePassword && !s.user!.admin && s.postings.length > 1) { setPicking(true); return; }
    enter();
  };

  /**
   * Take the session to the counter chosen. `switchLocation` re-mints the token and reloads the
   * whole snapshot; only once it has answered is the shell allowed to mount, so no screen is
   * ever drawn against the counter the operator did not pick.
   */
  const chooseLoc = async (loc: LocKey) => {
    setMoving(true);
    setLocRefused(null);
    try {
      if (await switchLocation(loc)) { enter(); return; }
      // The store toasts the server's own refusal. A toast is gone in seconds and this screen is
      // outside the shell, so it is moved onto the form beside where `authError` sits, word for
      // word, and stays there until the next attempt.
      setLocRefused(useApp.getState().toast ?? COUNTER_UNREACHABLE);
      dismissToast();
    } finally { setMoving(false); }
  };
  const onLocKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setLocAt((i) => Math.min(i + 1, postings.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setLocAt((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && !moving) {
      e.preventDefault();
      void chooseLoc(postings[locAt]);
    }
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
  const locOptionId = (i: number) => `loc-opt-${i}`;
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
      <div className="lgf">{picking ? (
        /* ---- step 3: which counter. The same plate, the same list, the same arrow-and-Enter
           keyboard as the employee picker above - only the rows are counters. Not a <form>:
           there is nothing left to submit, a counter is chosen the way a person was. */
        <div className="lgi">
          <div className="lgl"><img src={mark} alt="" /><span className="lgwm" role="img" aria-label="eaTesZy" /></div>
          <h2>Which counter?</h2>
          <p className="sub">You are posted to more than one. Choose the one you are signing in to.</p>
          <div className="fg lgpick">
            <div className="tipped" style={{ marginBottom: 5 }}>
              {/* No `htmlFor`: a <ul> is not labelable, and the list is named by
                  `aria-labelledby` instead. */}
              <label id="loc-label" style={{ marginBottom: 0 }}>Counter</label>
              <Tip text="Every screen behind this one - the till, the stock, the tickets - belongs to the counter you pick here. You can move to another of your counters later from the header, without signing out." label="Counter" />
            </div>
            <ul
              ref={locRef}
              id="loc-list"
              role="listbox"
              tabIndex={0}
              aria-labelledby="loc-label"
              aria-activedescendant={locOptionId(locAt)}
              className="lgpick-list lgpick-here"
              onKeyDown={onLocKey}
            >
              {postings.map((l, i) => (
                <li
                  key={l}
                  id={locOptionId(i)}
                  role="option"
                  aria-selected={i === locAt}
                  className={i === locAt ? "on" : undefined}
                  onMouseEnter={() => setLocAt(i)}
                  onClick={() => { if (!moving) void chooseLoc(l); }}
                >
                  <span className="mono">{LOC[l]?.c ?? l}</span>
                  <span>{locName(l)}</span>
                </li>
              ))}
            </ul>
          </div>
          {/* The server's own refusal, on the form rather than in a toast - the same rule the
              two steps before this one keep for `authError`. */}
          {locRefused && <Alert tone="c" label="REFUSED">{locRefused}</Alert>}
          <button className="btn wide" disabled={moving} type="button" onClick={() => { if (!moving) void chooseLoc(postings[locAt]); }}>
            {moving ? "Opening the counter…" : `Sign in at ${locName(postings[locAt])}`}
          </button>
        </div>
      ) : (<form className="lgi" onSubmit={submit}>
        <div className="lgl"><img src={mark} alt="" /><span className="lgwm" role="img" aria-label="eaTesZy" /></div>
        <h2>Sign in</h2>
        <p className="sub">{typing ? "Enter your employee ID and password." : "Choose your employee ID, then enter your password."}</p>

        {typing ? (
          <div className="fg"><label htmlFor="emp">Employee id</label>
            <input className="inp mono" id="emp" name="username" autoComplete="username" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="RC-0000" />
            {typedOnly && <p className="lgpick-note">The staff list could not be loaded - type your employee ID instead.</p>}
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
              // Opened by a click, a keystroke or an arrow - not by the autofocus on arrival, which
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

        <div className="fg">
          {/* Beside the label, never inside it: the bubble's hidden sentence would join its name. */}
          <div className="tipped" style={{ marginBottom: 5 }}>
            <label htmlFor="pw" style={{ marginBottom: 0 }}>Password</label>
            <Tip text="Forgotten your password? Ask an administrator to reset it - you will be asked to choose a new one when you next sign in." label="Password" />
          </div>
          <input ref={pwRef} className="inp mono" id="pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
        {/* The server's own sentence, or that it could not be reached - on the form, where it
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
      </form>)}</div>
    </div>
  );
}
