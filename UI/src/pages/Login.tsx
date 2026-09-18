import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { HOME } from "../nav";
import { useApp } from "../store";
import { Alert, Tip } from "../ui/kit";
import type { SignInCounter, SignInEntry } from "../types";
import mark from "../assets/eateszy-mark.png";

/** Only when `switchLocation` could not reach the server at all - it puts the server's own
 *  sentence on the toast, and this screen reads that rather than writing its own. */

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
  const pwRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const locRef = useRef<HTMLUListElement>(null);
  const loadSignInDirectory = useApp((s) => s.loadSignInDirectory);
  const login = useApp((s) => s.login);
  const auth = useApp((s) => s.auth);
  const refused = useApp((s) => s.authError);
  /** The counters the chosen person works, off the public directory - the question is asked
   *  before anybody has signed in, so it cannot wait for a token. One counter is the ordinary
   *  case and the step never draws. */
  const counters = chosen?.locs ?? [];
  /** The counter picked for this sign-in, carried into `login`. The whole row and not just the
   *  key, because the name on it is the only one this screen has: `data/master.ts` is filled by
   *  the snapshot, which does not arrive until after sign-in. */
  const [atLoc, setAtLoc] = useState<SignInCounter | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    let live = true;
    void loadSignInDirectory().then((d) => { if (live) setDir(d); });
    return () => { live = false; };
  }, [loadSignInDirectory]);

  // The list is the step, so it takes the keyboard the moment the step appears - the way the
  // search box does on arrival and the password box does on a pick.
  // The list takes the keyboard when the step opens, and the password box takes it back when the
  // step closes - after the render, because neither element is in the DOM at the moment the state
  // that draws it changes.
  useEffect(() => {
    if (picking) locRef.current?.focus();
    else if (chosen) pwRef.current?.focus();
  }, [picking, chosen]);

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
    const ok = await login(emp, pw, atLoc?.k);
    if (!ok) return;
    enter();
  };

  /**
   * The counter this sign-in is for. Nothing is sent yet - the password has not been typed. The
   * server checks the posting when `login` carries it, so a counter this account is not posted to
   * is refused there and lands on the form as `authError`, exactly like a wrong password.
   */
  const chooseLoc = (loc: SignInCounter) => {
    setAtLoc(loc);
    setPicking(false);
  };
  const onLocKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setLocAt((i) => Math.min(i + 1, counters.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setLocAt((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      chooseLoc(counters[locAt]);
    }
  };

  const choose = (entry: SignInEntry) => {
    setChosen(entry);
    setQuery("");
    setOpen(false);
    // Only when there was a question to answer. One posting is the account's home location, which
    // is what the server mints from anyway, so the sign-in goes over the wire exactly as it always
    // did for everyone who works one counter.
    setAtLoc(null);
    // The counter is asked for the moment the person is known, before the password - a consultant
    // arrives already standing where they meant to be, rather than signing in at a home counter
    // and moving off it. One counter is the ordinary case and there is nothing to ask.
    if (entry.locs.length > 1) { setLocAt(0); setPicking(true); return; }
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
        /* ---- step 2 for a consultant who works several: which counter, asked as soon as the
           person is known and before the password. The same plate, list and arrow-and-Enter
           keyboard as the employee picker - only the rows are counters. Not a <form>: nothing is
           submitted here, the answer is carried into the sign-in below. */
        <div className="lgi">
          <div className="lgl"><img src={mark} alt="" /><span className="lgwm" role="img" aria-label="eaTesZy" /></div>
          <h2>Which counter?</h2>
          <p className="sub">{chosen?.n} works more than one counter. Which are you signing in to?</p>
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
              {counters.map((l, i) => (
                <li
                  key={l.k}
                  id={locOptionId(i)}
                  role="option"
                  aria-selected={i === locAt}
                  className={i === locAt ? "on" : undefined}
                  onMouseEnter={() => setLocAt(i)}
                  onClick={() => { chooseLoc(l); }}
                >
                  <span className="mono">{l.c}</span>
                  <span>{l.n}</span>
                </li>
              ))}
            </ul>
          </div>
          {/* Nothing is sent from this step - the password is still to come - so there is no
              refusal of its own to show. A counter this account is not posted to is refused by
              the server when `login` carries it, and lands on the form as `authError` does. */}
          <button className="btn wide" type="button" onClick={() => { chooseLoc(counters[locAt]); }}>
            Continue at {counters[locAt].n}
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

        {/* Which counter this sign-in is for, once it has been asked. Without it the operator
            answers the question and then stares at a form showing no trace of the answer - and
            every screen behind the password belongs to whichever counter this names. */}
        {atLoc && !typing && (
          <div className="fg"><label htmlFor="at-counter">Counter</label>
            <div className="lgpick-chosen">
              <input className="lgpick-id mono" id="at-counter" readOnly value={atLoc.c} />
              <span className="lgpick-name">{atLoc.n}</span>
              <button type="button" className="lgpick-change"
                onClick={() => { setLocAt(Math.max(0, counters.findIndex((l) => l.k === atLoc.k))); setPicking(true); }}>
                Change
              </button>
            </div>
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
