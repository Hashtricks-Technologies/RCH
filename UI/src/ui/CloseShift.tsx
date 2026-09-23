import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../store";
import { locName } from "../lib/selectors";
import { money } from "../lib/fmt";
import { Alert, Btn, DataTable } from "./kit";
import { Modal } from "./Modal";
import { printShiftSlip, ShiftSlip, stamp } from "./ShiftSlip";
import type { ShiftReport } from "../types";

/**
 * Close Shift: the counter operator's end of a stint at one counter.
 *
 * The press opens a confirmation over the live report - the window, the bills, the amount per
 * tender and the total - with a Print for the interim slip. Confirming closes the shift on the
 * server (which stores the figures and tells the manager), prints the final slip, and signs the
 * operator out, so the next shift anywhere starts with a fresh sign-in at that counter.
 *
 * Shared by the shell's sidebar, the counter's Dashboard and its Register screen, which is why it
 * lives in `ui/`. Mounted for the counter role only.
 */
export default function CloseShift({ wide, variant = "gh" }: { wide?: boolean; variant?: "solid" | "gh" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Btn variant={variant} wide={wide} onClick={() => setOpen(true)}
        tip="Shows what you billed since you signed in here, closes your shift and signs you out.">
        Close shift
      </Btn>
      {open && <CloseShiftDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function CloseShiftDialog({ onClose }: { onClose: () => void }) {
  // Read, not asserted: the sign-out at the end empties it while this is still on the screen.
  const user = useApp((s) => s.user);
  const readCurrentShift = useApp((s) => s.readCurrentShift);
  const closeShift = useApp((s) => s.closeShift);
  const logout = useApp((s) => s.logout);
  const nav = useNavigate();
  // `undefined` not read yet, `null` could not be read, otherwise the server's answer - whose
  // `shift` is itself `null` when this session has none open.
  const [live, setLive] = useState<{ shift: ShiftReport | null } | null | undefined>(undefined);
  const [done, setDone] = useState<ShiftReport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let on = true;
    void readCurrentShift().then((r) => { if (on) setLive(r); });
    return () => { on = false; };
  }, [readCurrentShift]);

  // The final slip has to be on the page before it can go to paper, so the print and the
  // sign-out follow the render that put it there.
  useEffect(() => {
    if (!done) return;
    printShiftSlip();
    void logout().then(() => nav("/login"));
  }, [done, logout, nav]);

  const confirm = async () => {
    setBusy(true);
    const r = await closeShift();
    setBusy(false);
    if (r) setDone(r);
  };
  const signOut = () => { void logout().then(() => nav("/login")); };

  const shift = done ?? live?.shift ?? null;
  const t = shift?.totals;
  return (
    <>
      <Modal
        title="Close your shift"
        sub={user ? `${user.n} · ${locName(user.loc)}` : undefined}
        onClose={onClose}
        foot={<>
          <Btn variant="gh" disabled={busy} onClick={onClose}>Keep working</Btn>
          <Btn variant="gh" disabled={busy || !shift} onClick={printShiftSlip}>Print</Btn>
          {live && !live.shift
            ? <Btn onClick={signOut}>Sign out</Btn>
            : <Btn disabled={busy || !shift || done !== null} onClick={() => void confirm()}>Close shift &amp; sign out</Btn>}
        </>}
      >
        {live === undefined && <p className="mini">Reading your shift…</p>}
        {live === null && (
          <Alert tone="c" label="OUTAGE">
            Could not read your shift - check the connection and try again. Nothing has been closed.
          </Alert>
        )}
        {live && !live.shift && (
          <Alert tone="w" label="NO SHIFT">
            No shift is open for you at {locName(user?.loc ?? "")} - it was closed from another window, or you
            signed in at another counter since. Sign out, and sign in again here to start one.
          </Alert>
        )}
        {shift && t && (
          <>
            <p className="mini">
              {shift.id} · from {stamp(shift.openedAt)} to {shift.closedAt ? stamp(shift.closedAt) : `now (${stamp(shift.takenAt)})`}
            </p>
            <DataTable
              cols={[{ h: "Tender", cls: "nm" }, { h: "Bills", r: true }, { h: "Amount", r: true }]}
              rows={[
                ...t.tenders.map((x) => ({ key: x.tender, cells: [x.tender, x.bills, money(x.amount)] })),
                { key: "total", cells: [<b>Total billed</b>, <b>{t.billCount}</b>, <b>{money(t.nettSales)}</b>] },
              ]}
            />
            <p className="mini" style={{ marginTop: 10 }}>
              Gross {money(t.grossSales)} · discount {money(t.discount)} · tax {money(t.taxTotal)} ·
              voided {t.voidBills} ({money(t.voidAmount)})
            </p>
            {!done && (
              <Alert tone="i" label="CLOSE">
                Closing hands these figures to the outlet manager and signs you out. Your next shift
                starts when you sign in at a counter again.
              </Alert>
            )}
          </>
        )}
      </Modal>
      {shift && <ShiftSlip r={shift} />}
    </>
  );
}
