import { useEffect, useState } from "react";
import { useApp } from "../store";
import { fromWireDay, fromWireTime, money, money0 } from "../lib/fmt";
import { Alert, Btn, Card, DataTable, Field, Kpis, Pill, TableFoot } from "./kit";
import { RegisterSlip } from "./RegisterSlip";
import ShiftReports from "./ShiftReports";
import type { LocKey, RegisterReport } from "../types";

export interface RegisterPanelProps {
  /** The outlet whose register this is; `null` when there is none to read. */
  loc: LocKey | null;
  /** Its name, passed in rather than read from the location master: the super admin's session
   *  loads no snapshot, so `locName` would answer the bare key there. */
  locName: string;
  /** May read the live X (`x_report` at view). */
  canX: boolean;
  /** May read the closed sessions (`z_report` at view). */
  canZ: boolean;
  /** May close the register and take the Z (`z_report` at edit). */
  canClose: boolean;
  /** Draw the Shift reports card under it (`shift_reports`). */
  showShifts?: boolean;
}

/**
 * One outlet's register: the X read mid-session, the closed sessions, and the Z that closes the
 * day. The operator's Register screen and the super admin's Registers tab both draw it, each
 * saying which of the three the session may do - the server refuses the rest in any case.
 *
 * The business day is **Z to Z**, not midnight to midnight: everything here is measured from the
 * moment the last Z closed the previous session. An X changes nothing and may be taken as often
 * as anybody likes. A Z is a document: it closes the session for good, and the next sale opens
 * the next one - so it sits behind a confirm that says exactly that, and the X does not.
 *
 * Neither read is kept in the store, and both answer `null` on failure rather than an empty
 * report, so a register nobody could read says so instead of reading as a day nothing was taken
 * on. "₹0.00" on a till report is a statement about the money.
 *
 * Keyed on the outlet, so picking another starts every read and the paper afresh.
 */
export default function RegisterPanel(props: RegisterPanelProps) {
  return <Panel key={props.loc ?? ""} {...props} />;
}

function Panel({ loc, locName, canX, canZ, canClose, showShifts }: RegisterPanelProps) {
  const readXReport = useApp((s) => s.readXReport);
  const readZReports = useApp((s) => s.readZReports);
  const closeRegister = useApp((s) => s.closeRegister);

  // Three states for each read, not two: `undefined` is "not asked yet", `null` is "asked and it
  // failed", and a value is a value. A read the session may not make is never asked.
  const [x, setX] = useState<RegisterReport | null | undefined>(undefined);
  const [zs, setZs] = useState<RegisterReport[] | null | undefined>(undefined);
  const reading = x === undefined;
  const xFailed = x === null;
  const zFailed = zs === null;
  const [counted, setCounted] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  /** What is on the paper right now: the live X, the Z just taken, or a past Z picked off the
   *  list. `cash` is what was counted, which the report itself never carries. */
  const [slip, setSlip] = useState<{ r: RegisterReport; cash?: number } | null>(null);

  const readBoth = (at: LocKey) => Promise.all([
    canX ? readXReport(at) : Promise.resolve(undefined),
    canZ ? readZReports(at) : Promise.resolve(undefined),
  ]);

  // The slip follows the outlet on the way in; after that it is whatever was last asked for,
  // which a background re-read must not take off the paper.
  useEffect(() => {
    if (!loc) return;
    let live = true;
    void Promise.all([
      canX ? readXReport(loc) : Promise.resolve(undefined),
      canZ ? readZReports(loc) : Promise.resolve(undefined),
    ]).then(([xr, zr]) => {
      if (!live) return;
      setX(xr); setZs(zr); setSlip(xr ? { r: xr } : null);
    });
    return () => { live = false; };
  }, [loc, canX, canZ, readXReport, readZReports]);

  /** Read both again, leaving the paper alone. Only ever called from a press. */
  const reload = async (): Promise<RegisterReport | null | undefined> => {
    if (!loc) return null;
    setX(undefined); setZs(undefined);
    const [xr, zr] = await readBoth(loc);
    setX(xr); setZs(zr);
    return xr;
  };

  const cashTyped = counted.trim();
  const cashNum = cashTyped === "" ? null : Number(cashTyped);
  const cashBad = cashNum !== null && (!Number.isFinite(cashNum) || cashNum < 0);

  /** Re-read and print. Nothing is written, nothing is closed, and it may be pressed all day. */
  const takeX = async () => {
    setBusy(true);
    const r = await reload();
    setBusy(false);
    if (!r) return;
    setSlip({ r });
    window.print();
  };

  const close = async () => {
    if (!loc) return;
    setBusy(true);
    const cash = cashBad || cashNum === null ? undefined : cashNum;
    const z = await closeRegister(loc, cash);
    setBusy(false);
    setConfirm(false);
    // The store has already toasted the server's own refusal; the typed cash stays in the box.
    if (!z) return;
    setCounted("");
    setSlip({ r: z, cash });
    await reload();
    window.print();
  };

  const t = x?.totals;
  const zRows = zs ?? [];
  // Without the X there is no session to describe, so the close is offered on the server's word
  // alone: it refuses a register with nothing open, in its own sentence.
  const nothingOpen = canX && !!x && !x.sessionId;

  return (
    <>
      {!loc && (
        <Alert tone="w" label="NO OUTLET">
          No outlet is open, so there is no register to read. An outlet is opened from account
          management.
        </Alert>
      )}

      {canX && xFailed && (
        <Alert tone="c" label="OUTAGE" action={<Btn size="xs" variant="gh" onClick={() => void reload()}>Try again</Btn>}>
          Could not read the register at {locName} - check the connection and try again.
          This is not a session that took nothing: what the till holds is unknown until this reads.
        </Alert>
      )}

      {canX && (
        <Kpis items={[
          {
            l: "Nett sales this session", v: t ? money0(t.nettSales) : "-",
            d: !x ? (reading ? <>reading…</> : <>not read</>) : x.sessionId ? <>since {stamp(x.openedAt)}</> : <>nothing open</>,
            tip: "Gross sales less discount, for everything billed since the last Z closed this register.",
          },
          {
            l: "Collected", v: t ? money0(t.collected) : "-",
            d: t ? <>{t.tenders.length} tender{t.tenders.length === 1 ? "" : "s"}</> : <>-</>,
            tip: "What the tenders actually took. A bill charged to an account collects nothing here.",
          },
          {
            l: "Bills", v: t ? String(t.billCount) : "-",
            d: t ? <>{t.voidBills} voided · {money(t.voidAmount)}</> : <>-</>,
          },
          {
            l: "Credit sales", v: t ? money0(t.creditSales) : "-",
            tip: "Billed to a staff member, a department or a doctor - money owed, not money taken.",
          },
          {
            l: "Old bills collected", v: t ? money0(t.oldBillsTotal) : "-",
            tip: "Taken in this session against bills from an earlier one. It is collection, not sale, and is never added into nett sales.",
          },
          {
            l: "Tax", v: t ? money0(t.taxTotal) : "-",
            d: t ? <>SGST {money(t.sgst)} · CGST {money(t.cgst)}</> : <>-</>,
          },
        ]} />
      )}

      {(canX || canClose) && (
        <Card
          className="mtop"
          title="Take a reading"
          sub={x?.sessionId ? `Session ${x.sessionId}` : undefined}
          tip={canClose
            ? "An X leaves the register exactly as it is. A Z closes it and cannot be undone."
            : "An X leaves the register exactly as it is. Closing the register is the administrator's, or a role given Z reports to change."}
          right={<span className="no-print"><Btn variant="gh" disabled={busy || !slip} onClick={() => window.print()}>Print slip</Btn></span>}
        >
          {/* An empty `sessionId` is the server saying no register is open here - not an open one
              that happens to have taken nothing. */}
          {canX && (
            <p className="mini">
              {!x ? <>The open session cannot be described until the register reads.</>
                : !x.sessionId
                  ? <>Nothing is open here{x.previousZNo ? <> since <span className="mono">{x.previousZNo}</span></> : <> - this outlet has never taken a sale</>}. The register opens by itself on the next sale, and there is nothing to close until then.</>
                  : <>Open since {stamp(x.openedAt)}{x.previousZNo ? <> - this session follows <span className="mono">{x.previousZNo}</span></> : <> - the first session at this outlet</>}.</>}
            </p>
          )}
          <div className="btnrow no-print" style={{ marginTop: 12 }}>
            {canX && (
              <Btn wide disabled={busy || !loc} onClick={() => void takeX()}
                tip="Re-reads the takings and prints them. Nothing is closed and nothing is written.">
                Take X-report
              </Btn>
            )}
            {canClose && (
              <Btn variant={canX ? "gh" : "solid"} disabled={busy || !loc || nothingOpen || confirm} onClick={() => { setConfirm(true); }}
                tip={nothingOpen
                  ? "There is nothing to close - no sale has been taken since the last Z."
                  : "Settles this session and closes the register. The next sale opens a new one."}>
                Close register &amp; take Z
              </Btn>
            )}
          </div>
          {canClose && (
            <div style={{ maxWidth: 260, marginTop: 12 }}>
              <Field
                label="Counted cash"
                hint={cashBad
                  ? "Type the drawer count in rupees, or leave it empty."
                  : "Optional. The Z prints it against the cash the till says it took."}
              >
                <input className="mono" inputMode="decimal" value={counted}
                  onChange={(e) => { setCounted(e.target.value); }} />
              </Field>
            </div>
          )}
          {confirm && (
            <Alert
              tone="c"
              label="CLOSE"
              action={<>
                <Btn size="xs" variant="gh" disabled={busy} onClick={() => { setConfirm(false); }}>Keep it open</Btn>
                <Btn size="xs" disabled={busy || cashBad} onClick={() => void close()}>Yes, take the Z</Btn>
              </>}
            >
              This closes the register at <b>{locName}</b> and settles everything billed since{" "}
              {x ? stamp(x.openedAt) : "the session opened"}. <b>It cannot be undone or taken again</b> - the
              session is closed for good, the next sale opens a new one, and this slip is the only settlement
              for the one being closed.
            </Alert>
          )}
        </Card>
      )}

      {canZ && (
        <Card
          className="mtop"
          title="Past Z-reports"
          sub={zFailed ? undefined : `${zRows.length} closed session${zRows.length === 1 ? "" : "s"}`}
          tip="Every session this outlet has closed, newest first. Open one to put it back on the paper."
          flush
          scroll
        >
          {zFailed ? (
            // Never an empty table: a register that could not be read is not a register that has
            // never been closed.
            <div style={{ padding: 15 }}>
              <Alert tone="c" label="OUTAGE" action={<Btn size="xs" variant="gh" onClick={() => void reload()}>Try again</Btn>}>
                Could not read the closed sessions - check the connection and try again.
              </Alert>
            </div>
          ) : (
            <>
              <DataTable
                cols={[
                  { h: "Z number", cls: "nm", w: "18%" },
                  { h: "Closed", w: "18%" },
                  { h: "Opened", w: "18%" },
                  { h: "Nett sales", r: true },
                  { h: "Collected", r: true },
                  { h: "Bills", r: true },
                  { h: "Slip", w: "10%" },
                ]}
                rows={zRows.map((z) => ({
                  key: z.sessionId,
                  onClick: () => { setSlip({ r: z }); },
                  cells: [
                    <><span className="mono">{z.zNo ?? "-"}</span><small>by {z.takenBy}</small></>,
                    z.closedAt ? stamp(z.closedAt) : <span className="dim">-</span>,
                    stamp(z.openedAt),
                    <b>{money(z.totals.nettSales)}</b>,
                    money(z.totals.collected),
                    z.totals.billCount,
                    <Btn size="xs" variant="gh" onClick={() => { setSlip({ r: z }); window.print(); }}>Print</Btn>,
                  ],
                }))}
                // "Never been closed" is a claim, and it must not be made while the list is still
                // on its way - the same reason a failed read gets an outage line above.
                empty={zs === undefined
                  ? { title: "Reading the closed sessions…", sub: "The register's history comes from the server as this screen opens." }
                  : {
                    title: "This register has never been closed",
                    sub: "The first Z taken here opens this list. Until then the session runs from the outlet's first sale.",
                  }}
              />
              <TableFoot count={zRows.length} extra={slip ? <>On the paper: {slip.r.kind === "Z" ? `Z ${slip.r.zNo ?? "-"}` : "the live X"}</> : undefined} />
            </>
          )}
        </Card>
      )}

      {showShifts && <ShiftReports />}

      {slip && (
        <>
          <p className="mini no-print" style={{ marginTop: 10 }}>
            <Pill tone={slip.r.kind === "Z" ? "ok" : "in"}>{slip.r.kind}-report</Pill>{" "}
            {slip.r.kind === "Z"
              ? <>Z <span className="mono">{slip.r.zNo ?? "-"}</span> is loaded on the printer.</>
              : <>The live X is loaded on the printer.</>}
          </p>
          <RegisterSlip r={slip.r} countedCash={slip.cash} place={locName} />
        </>
      )}
    </>
  );
}

/** The hospital's day and clock for an instant, never the host's. */
const stamp = (iso: string) => `${fromWireDay(iso)} ${fromWireTime(iso)}`;
