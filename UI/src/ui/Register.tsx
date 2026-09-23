import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store";
import { locName, openOutlets } from "../lib/selectors";
import { fromWireDay, fromWireTime, money, money0 } from "../lib/fmt";
import {
  Alert, Btn, Card, DataTable, Field, FilterSelect, Kpis, PageHead, Pill, TableFoot,
} from "./kit";
import { RegisterSlip } from "./RegisterSlip";
import CloseShift from "./CloseShift";
import ShiftReports from "./ShiftReports";
import type { LocKey, RegisterReport } from "../types";

/**
 * The register: the X the counter reads mid-shift, and the Z that closes the day.
 *
 * One screen for two roles, which is why it lives here rather than in either role folder - the
 * counter reads its own outlet's register and the manager reads any outlet's, and that is the
 * whole difference between the two. The business day is **Z to Z**, not midnight to midnight:
 * everything on this page is measured from the moment the last Z closed the previous session.
 *
 * An X changes nothing and may be taken as often as anybody likes. A Z is a document: it closes
 * the session for good, and the next sale opens the next one. So the Z sits behind a confirm
 * that says exactly that, and the X does not.
 *
 * Neither read is kept in the store, and both answer `null` on failure rather than an empty
 * report - so a register nobody could read says so, instead of reading as a day nothing was
 * taken on. That is the distinction `AdminAudit.tsx` draws, and it matters more here than
 * anywhere: "₹0.00" on a till report is a statement about the money.
 */
export default function Register() {
  const user = useApp((s) => s.user)!;
  const catalogVersion = useApp((s) => s.catalogVersion);
  const readXReport = useApp((s) => s.readXReport);
  const readZReports = useApp((s) => s.readZReports);
  const closeRegister = useApp((s) => s.closeRegister);

  // The manager is hospital-wide and picks; the counter has exactly one register, its own.
  const anyOutlet = user.r === "manager";
  // `openOutlets()` reads a mutable registry, so `catalogVersion` - the signal that the location
  // master moved - is what tells React to look again.
  const outlets = useMemo(() => { void catalogVersion; return openOutlets(); }, [catalogVersion]);
  const [pick, setPick] = useState<LocKey | null>(null);
  const loc: LocKey | null = anyOutlet ? pick ?? outlets[0] ?? null : user.loc;

  // Three states for each read, not two: `undefined` is "not asked yet", `null` is "asked and it
  // failed", and a value is a value. A register that could not be read must never print as one
  // that took nothing - on a till report a zero is a statement about the money.
  const [x, setX] = useState<RegisterReport | null | undefined>(undefined);
  const [zs, setZs] = useState<RegisterReport[] | null | undefined>(undefined);
  const reading = x === undefined;
  const xFailed = x === null;
  const zFailed = zs === null;
  const [counted, setCounted] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  /** What is on the paper right now: the live X, the Z just taken, or a past Z picked off the
   *  list. `cash` is what the counter said they counted, which the report itself never carries -
   *  the server takes it on the close and prints nothing back. */
  const [slip, setSlip] = useState<{ r: RegisterReport; cash?: number } | null>(null);

  // The slip follows the outlet on the way in and whenever the outlet changes; after that it is
  // whatever the operator last asked for, which a background re-read must not take off the paper.
  useEffect(() => {
    if (!loc) return;
    let live = true;
    void Promise.all([readXReport(loc), readZReports(loc)]).then(([xr, zr]) => {
      if (!live) return;
      setX(xr); setZs(zr); setSlip(xr ? { r: xr } : null); setConfirm(false);
    });
    return () => { live = false; };
  }, [loc, readXReport, readZReports]);

  /** Read both again, leaving the paper alone. Only ever called from a press. */
  const reload = async (): Promise<RegisterReport | null> => {
    if (!loc) return null;
    setX(undefined); setZs(undefined);
    const [xr, zr] = await Promise.all([readXReport(loc), readZReports(loc)]);
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

  return (
    <>
      <PageHead
        crumbs={["Royal Care", anyOutlet ? "Outlets" : locName(loc ?? ""), "Register"]}
        title={loc ? `${locName(loc)} register` : "Register"}
        tip={<>
          The hospital's business day runs <b>Z to Z</b>, not midnight to midnight. An X-report is
          the takings so far and changes nothing - take one as often as you like. A Z closes this
          outlet's register: the session is settled, and the next sale opens a new one.
        </>}
        actions={!anyOutlet ? <CloseShift /> : outlets.length > 0 ? (
          <FilterSelect
            label="Outlet"
            value={loc ? locName(loc) : ""}
            options={outlets.map((l) => locName(l))}
            active={false}
            onChange={(v) => { setX(undefined); setZs(undefined); setPick(outlets.find((l) => locName(l) === v) ?? null); }}
          />
        ) : undefined}
      />

      {!loc && (
        <Alert tone="w" label="NO OUTLET">
          No outlet is open, so there is no register to read. An outlet is opened from account
          management.
        </Alert>
      )}

      {xFailed && (
        <Alert tone="c" label="OUTAGE" action={<Btn size="xs" variant="gh" onClick={() => void reload()}>Try again</Btn>}>
          Could not read the register at {locName(loc ?? "")} - check the connection and try again.
          This is not a session that took nothing: what the till holds is unknown until this reads.
        </Alert>
      )}

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

      <Card
        className="mtop"
        title="Take a reading"
        sub={x?.sessionId ? `Session ${x.sessionId}` : undefined}
        tip="An X leaves the register exactly as it is. A Z closes it and cannot be undone."
        right={<span className="no-print"><Btn variant="gh" disabled={busy || !slip} onClick={() => window.print()}>Print slip</Btn></span>}
      >
        {/* An empty `sessionId` is the server saying no register is open here - not an open one
            that happens to have taken nothing. Printing "Open since <now>" for it would name a
            session that does not exist and offer a Z the server would refuse. */}
        <p className="mini">
          {!x ? <>The open session cannot be described until the register reads.</>
            : !x.sessionId
              ? <>Nothing is open here{x.previousZNo ? <> since <span className="mono">{x.previousZNo}</span></> : <> - this outlet has never taken a sale</>}. The register opens by itself on the next sale, and there is nothing to close until then.</>
              : <>Open since {stamp(x.openedAt)}{x.previousZNo ? <> - this session follows <span className="mono">{x.previousZNo}</span></> : <> - the first session at this outlet</>}.</>}
        </p>
        <div className="btnrow no-print" style={{ marginTop: 12 }}>
          <Btn wide disabled={busy || !loc} onClick={() => void takeX()}
            tip="Re-reads the takings and prints them. Nothing is closed and nothing is written.">
            Take X-report
          </Btn>
          <Btn variant="gh" disabled={busy || !loc || !x?.sessionId || confirm} onClick={() => { setConfirm(true); }}
            tip={x && !x.sessionId
              ? "There is nothing to close - no sale has been taken since the last Z."
              : "Settles this session and closes the register. The next sale opens a new one."}>
            Close register &amp; take Z
          </Btn>
        </div>
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
        {confirm && (
          <Alert
            tone="c"
            label="CLOSE"
            action={<>
              <Btn size="xs" variant="gh" disabled={busy} onClick={() => { setConfirm(false); }}>Keep it open</Btn>
              <Btn size="xs" disabled={busy || cashBad} onClick={() => void close()}>Yes, take the Z</Btn>
            </>}
          >
            This closes the register at <b>{locName(loc ?? "")}</b> and settles everything billed since{" "}
            {x ? stamp(x.openedAt) : "the session opened"}. <b>It cannot be undone or taken again</b> - the
            session is closed for good, the next sale opens a new one, and this slip is the only settlement
            for the one being closed.
          </Alert>
        )}
      </Card>

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

      {anyOutlet && <ShiftReports />}

      {slip && (
        <>
          <p className="mini no-print" style={{ marginTop: 10 }}>
            <Pill tone={slip.r.kind === "Z" ? "ok" : "in"}>{slip.r.kind}-report</Pill>{" "}
            {slip.r.kind === "Z"
              ? <>Z <span className="mono">{slip.r.zNo ?? "-"}</span> is loaded on the printer.</>
              : <>The live X is loaded on the printer.</>}
          </p>
          <RegisterSlip r={slip.r} countedCash={slip.cash} />
        </>
      )}
    </>
  );
}

/** The hospital's day and clock for an instant, never the host's. */
const stamp = (iso: string) => `${fromWireDay(iso)} ${fromWireTime(iso)}`;
