import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { homeFor } from "../nav";
import { useApp } from "../store";
import type { SignInCounter, SwitchSideBody } from "../types";
import { Icon } from "../ui/kit";
import mark from "../assets/eateszy-mark.png";

/**
 * Billing or Inventory: what a two-sided role is asked once its password is right, and again
 * whenever its session has no place to stand (the outlet it stood at closed). Billing then asks
 * which outlet, off `user.sides.outlets` - the server's list, named, because the snapshot that
 * would fill the location registry cannot be read until this is answered.
 *
 * `App` draws it in place of every page, so nothing behind it is ever drawn against a side nobody
 * chose. The header's switcher (`ui/SideSwitcher.tsx`) is the same choice later on.
 */
export default function ChooseSide() {
  const user = useApp((s) => s.user)!;
  const switchSide = useApp((s) => s.switchSide);
  const logout = useApp((s) => s.logout);
  const nav = useNavigate();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const outlets = user.sides?.outlets ?? [];

  // The list is the step, so it takes the keyboard as the step opens.
  useEffect(() => { if (picking) list.current?.querySelector("button")?.focus(); }, [picking]);

  const go = async (to: SwitchSideBody) => {
    setBusy(true);
    // A refusal (an outlet closed a moment ago) is toasted, and the question stays up.
    if (!(await switchSide(to, (u) => nav("/" + homeFor(u))))) setBusy(false);
  };
  const billing = () => { if (outlets.length === 1) void go({ side: "billing", loc: outlets[0].k }); else setPicking(true); };

  return (
    <div id="login" style={{ display: "grid" }}>
      <div className="lgb">
        <div className="lgw"><i><img src={mark} alt="eaTesZy" /></i> Royal Care Hospital</div>
        <div className="lgh">
          <h1>Every item, every counter, one ledger.</h1>
          <p>Purchasing, stock, kitchen and billing in one place.</p>
        </div>
      </div>
      <div className="lgf">
        <div className="lgi">
          <div className="lgl"><img src={mark} alt="" /><span className="lgwm" role="img" aria-label="eaTesZy" /></div>
          {picking ? (
            <>
              <h2>Which outlet?</h2>
              <p className="sub">Bills and stock requests belong to the outlet you pick. You can move to another from the header.</p>
              <div className="sidepick" ref={list}>
                {outlets.map((o: SignInCounter) => (
                  <button key={o.k} type="button" className="sideopt sm" disabled={busy} onClick={() => void go({ side: "billing", loc: o.k })}>
                    <span className="mono">{o.c}</span><b>{o.n}</b>
                  </button>
                ))}
              </div>
              <p className="lgpick-mode"><button type="button" className="lgpick-link" disabled={busy} onClick={() => setPicking(false)}>Back</button></p>
            </>
          ) : (
            <>
              <h2>What are you working on?</h2>
              <p className="sub">{user.n}, choose where to start. You can switch from the header without signing out.</p>
              <div className="sidepick">
                <button type="button" className="sideopt" disabled={busy || outlets.length === 0} onClick={billing}>
                  <Icon name="pos" size={22} /><b>Billing</b>
                  <span>{outlets.length === 0 ? "No outlet is open to bill at." : "Bills, stock requests, approvals and registers at any outlet"}</span>
                </button>
                <button type="button" className="sideopt" disabled={busy} onClick={() => void go({ side: "inventory" })}>
                  <Icon name="warehouse" size={22} /><b>Inventory</b>
                  <span>The central store, purchasing, vendors and the item master</span>
                </button>
              </div>
              <p className="lgpick-mode">
                <button type="button" className="lgpick-link" disabled={busy} onClick={() => { void logout().then(() => nav("/login")); }}>Sign out</button>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
