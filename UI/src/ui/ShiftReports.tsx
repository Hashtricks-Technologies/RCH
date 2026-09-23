import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { useApp } from "../store";
import { allOutlets, locName } from "../lib/selectors";
import { money } from "../lib/fmt";
import { Alert, Btn, Card, DataTable, FilterSelect, Pill, TableFoot } from "./kit";
import { printShiftSlip, ShiftSlip, stamp } from "./ShiftSlip";
import type { ShiftReport } from "../types";

const ALL = "All outlets";
/** The tenders a hand-over is read by at a glance; the rest are on the slip. */
const AT_A_GLANCE = ["Cash", "UPI", "Card"];

/**
 * The manager's Shift reports: every counter operator's closed shift over the last week, newest
 * first, as each was handed over - who, where, from when to when, the bills, the total and the
 * split by tender - with the slip of any one of them a press away. It follows the change stream:
 * a `shifts` notice from any counter pulls the list back.
 */
export default function ShiftReports() {
  const shifts = useApp((s) => s.shifts);
  const failed = useApp((s) => s.shiftsFailed);
  const loadShifts = useApp((s) => s.loadShifts);
  const catalogVersion = useApp((s) => s.catalogVersion);
  const outlets = useMemo(() => { void catalogVersion; return allOutlets(); }, [catalogVersion]);
  const [where, setWhere] = useState(ALL);
  const [slip, setSlip] = useState<ShiftReport | null>(null);

  useEffect(() => { void loadShifts(); }, [loadShifts]);
  // The slip has to be on the page before it can go to paper, so it is rendered first, synchronously.
  const print = (r: ShiftReport) => { flushSync(() => setSlip(r)); printShiftSlip(); };

  const rows = where === ALL ? shifts : shifts.filter((r) => locName(r.loc) === where);
  const amount = (r: ShiftReport, tender: string) => r.totals.tenders.find((x) => x.tender === tender)?.amount ?? 0;

  return (
    <>
      <Card
        className="mtop"
        title="Shift reports"
        sub={failed ? undefined : `${rows.length} closed shift${rows.length === 1 ? "" : "s"} in the last 7 days`}
        tip="Every counter operator's closed shift: what they billed at their counter from signing in to Close Shift. A shift closed automatically was left open when its operator signed in at another counter."
        right={<FilterSelect label="Outlet" value={where} options={[ALL, ...outlets.map((l) => locName(l))]} onChange={setWhere} />}
        flush
        scroll
      >
        {failed ? (
          <div style={{ padding: 15 }}>
            <Alert tone="c" label="OUTAGE" action={<Btn size="xs" variant="gh" onClick={() => void loadShifts()}>Try again</Btn>}>
              Could not read the shift reports - check the connection and try again.
            </Alert>
          </div>
        ) : (
          <>
            <DataTable
              cols={[
                { h: "Operator", cls: "nm" },
                { h: "Counter" },
                { h: "Opened" },
                { h: "Closed" },
                { h: "Bills", r: true },
                { h: "Total", r: true },
                { h: "Cash · UPI · Card", r: true, tip: "What each of the three collected tenders took. Account tenders are on the slip." },
                { h: "Slip" },
              ]}
              rows={rows.map((r) => ({
                key: r.id,
                onClick: () => setSlip(r),
                cells: [
                  <><b>{r.operator}</b><small className="mono">{r.id}</small></>,
                  locName(r.loc),
                  stamp(r.openedAt),
                  <>{r.closedAt ? stamp(r.closedAt) : "-"}{r.auto && <> <Pill tone="wn">Auto</Pill></>}</>,
                  r.totals.billCount,
                  <b>{money(r.totals.nettSales)}</b>,
                  AT_A_GLANCE.map((t) => money(amount(r, t))).join(" · "),
                  <Btn size="xs" variant="gh" onClick={() => print(r)}>Print</Btn>,
                ],
              }))}
              empty={{ title: "No shift has been closed in the last 7 days", sub: "A counter operator's Close Shift puts their hand-over here." }}
            />
            <TableFoot count={rows.length} extra={slip ? <>On the paper: {slip.id}</> : undefined} />
          </>
        )}
      </Card>
      {slip && <ShiftSlip r={slip} />}
    </>
  );
}
