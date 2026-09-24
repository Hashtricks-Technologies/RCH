import { useMemo, useState } from "react";
import { useApp } from "../store";
import { locName, openOutlets, useCan, useHolds } from "../lib/selectors";
import { FilterSelect, PageHead } from "./kit";
import CloseShift from "./CloseShift";
import RegisterPanel from "./RegisterPanel";
import type { LocKey } from "../types";

/**
 * The operator's Register screen: the X read mid-shift, the closed sessions, and the Z that
 * closes the day - each drawn only for a role that holds it. `x_report` reads the X,
 * `z_report` at view lists the Zs and at edit takes one, and `shift_reports` adds the Shift
 * reports card. No seeded role holds `z_report`: closing the day is the super admin's (its
 * Registers tab draws the same `RegisterPanel`) until a role is given it.
 *
 * A role that works for every outlet (`all_outlets`, the rule the server scopes X and Z by) picks
 * an outlet, starting on its own; any other role has exactly one register, the one at `user.loc`.
 * The counter desk keeps its Close shift button here.
 */
export default function Register() {
  const user = useApp((s) => s.user)!;
  const catalogVersion = useApp((s) => s.catalogVersion);

  const anyOutlet = useHolds("all_outlets");
  const canX = useCan("x_report", "view");
  const canZ = useCan("z_report", "view");
  const canClose = useCan("z_report", "edit");
  const shiftReports = useCan("shift_reports", "view");
  // `openOutlets()` reads a mutable registry, so `catalogVersion` - the signal that the location
  // master moved - is what tells React to look again.
  const outlets = useMemo(() => { void catalogVersion; return openOutlets(); }, [catalogVersion]);
  const [pick, setPick] = useState<LocKey | null>(null);
  // Where the session stands first - an open outlet - and only then the first open one, for a
  // desk (the manager's) whose own location is not an outlet.
  const home = outlets.includes(user.loc) ? user.loc : outlets[0] ?? null;
  const loc: LocKey | null = anyOutlet ? pick ?? home : user.loc;

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
        actions={<>
          {anyOutlet && outlets.length > 0 && (
            <FilterSelect
              label="Outlet"
              value={loc ? locName(loc) : ""}
              options={outlets.map((l) => locName(l))}
              active={false}
              onChange={(v) => { setPick(outlets.find((l) => locName(l) === v) ?? null); }}
            />
          )}
          {/* The shift is the counter desk's: it opened at this operator's sign-in. */}
          {user.r === "counter" && <CloseShift />}
        </>}
      />
      <RegisterPanel
        loc={loc} locName={locName(loc ?? "")}
        canX={canX} canZ={canZ} canClose={canClose} showShifts={shiftReports}
      />
    </>
  );
}
