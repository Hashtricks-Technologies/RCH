import { useCallback, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { canSee, homeFor } from "../nav";
import { useApp } from "../store";
import type { SwitchSideBody, User } from "../types";
import { useDismiss } from "./focus";
import { Modal } from "./Modal";
import { Btn } from "./kit";

/**
 * Where a two-sided role is working, and the way to somewhere else: every outlet its Billing side
 * stands at, and Inventory. Drawn only for a role that has two sides - everybody else's counter is
 * fixed at sign-in and the header only names it.
 *
 * Open bills stay where they are (each belongs to its own counter's till). A stock request being
 * written does not belong to a counter, so one with lines in it is asked about first and then
 * cleared: sent after the move it would be raised from the wrong outlet.
 */
export default function SideSwitcher({ user }: { user: User }) {
  const switchSide = useApp((s) => s.switchSide);
  const drafted = useApp((s) => s.draft.some((l) => l.it));
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState<SwitchSideBody | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, box);
  const sides = user.sides;
  if (!sides) return null;

  const inventory = sides.at === "inventory";
  const here = inventory ? "Central Store" : sides.outlets.find((o) => o.k === user.loc)?.n ?? user.loc;

  const go = (to: SwitchSideBody) => {
    setAsking(null);
    // Stay on the screen, at the new place, where the side has it; otherwise that side's home.
    void switchSide(to, (u) => { if (!canSee(u, pathname.slice(1))) nav("/" + homeFor(u)); });
  };
  const pick = (to: SwitchSideBody) => {
    setOpen(false);
    if (drafted) setAsking(to); else go(to);
  };
  const row = (key: string, to: SwitchSideBody, name: string, note: string, at: boolean) => (
    <button key={key} type="button" role="menuitemradio" aria-checked={at} disabled={at} className={`po${at ? " on" : ""}`} onClick={() => pick(to)}>
      <span className="pb"><b>{name}</b><span>{note}</span></span>
      {at && <span className="pn">Here</span>}
    </button>
  );

  return (
    <div className="pw" ref={box}>
      <button type="button" className="org sidebtn" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Working ${inventory ? "Inventory" : "Billing"} at ${here}. Change.`} onClick={() => setOpen(!open)}>
        <b>{inventory ? "Inventory" : "Billing"}</b><span className="lbl">{here}</span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && (
        <div className="pop bell sidepop" role="menu" aria-label="Where you are working">
          <div className="ph">Where you are working</div>
          <div className="pl">
            <div role="group" aria-label="Billing">
              <div className="pk" aria-hidden="true">Billing</div>
              {sides.outlets.map((o) => row(o.k, { side: "billing", loc: o.k }, o.n, o.c, !inventory && o.k === user.loc))}
            </div>
            <div role="group" aria-label="Inventory">
              <div className="pk" aria-hidden="true">Inventory</div>
              {row("inventory", { side: "inventory" }, "Central Store", "Store and purchasing", inventory)}
            </div>
          </div>
        </div>
      )}
      {asking && (
        <Modal title="Leave this stock request?" onClose={() => setAsking(null)}
          foot={<><Btn variant="gh" onClick={() => setAsking(null)}>Stay here</Btn><Btn onClick={() => go(asking)}>Clear it and move</Btn></>}>
          <p>The stock request you are writing at {here} has not been sent. Moving clears it.</p>
        </Modal>
      )}
    </div>
  );
}
