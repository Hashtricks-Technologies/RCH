import { useMemo, useState } from "react";
import { useApp } from "../store";
import { locName, openOutlets, useCan, useWide } from "../lib/selectors";
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
 * A session that reads hospital-wide picks an outlet; one that reads a single counter has
 * exactly one register, its own. The counter desk keeps its Close shift button here.
 */
export default function Register() {
  const user = useApp((s) => s.user)!;
  const catalogVersion = useApp((s) => s.catalogVersion);

  const anyOutlet = useWide();
  const canX = useCan("x_report", "view");
  const canZ = useCan("z_report", "view");
  const canClose = useCan("z_report", "edit");
  const shiftReports = useCan("shift_reports", "view");
  // `openOutlets()` reads a mutable registry, so `catalogVersion` - the signal that the location
  // master moved - is what tells React to look again.
  const outlets = useMemo(() => { void catalogVersion; return openOutlets(); }, [catalogVersion]);
  const [pick, setPick] = useState<LocKey | null>(null);
  const loc: LocKey | null = anyOutlet ? pick ?? outlets[0] ?? null : user.loc;

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
