import { useState } from "react";
import { useApp } from "../store";
import { FilterSelect, PageHead } from "../ui/kit";
import RegisterPanel from "../ui/RegisterPanel";
import type { AdminLocation, LocKey } from "../types";

/** An outlet as the picker prints it - a closed one still has a register to read. */
const labelOf = (l: AdminLocation) => (l.active ? l.n : `${l.n} (closed)`);

/**
 * Every outlet's register, for the super admin: the live X, the closed sessions, and the Z that
 * closes the day. Closing the day is the super admin's by default - no seeded role holds Z
 * reports - so this is where it is done until a role is given it.
 *
 * The admin loads no snapshot, so the outlets come from its own `adminLocations` and each call
 * names its outlet: the register routes admit the admin token only with a `loc`. The panel reads
 * nothing but the X and Z answers, which carry every figure; the outlet's name is passed in.
 */
export default function AdminRegisters() {
  const locations = useApp((s) => s.adminLocations);
  const outlets = locations
    .filter((l) => l.type === "Outlet")
    .sort((a, b) => Number(!a.active) - Number(!b.active) || a.n.localeCompare(b.n));
  const [pick, setPick] = useState<LocKey | null>(null);
  const at = outlets.find((l) => l.key === pick) ?? outlets[0];

  return (
    <>
      <PageHead
        crumbs={["Admin"]}
        title={at ? `${at.n} register` : "Registers"}
        tip={<>
          Every outlet's register. The business day runs <b>Z to Z</b>: an X-report is the takings so
          far and changes nothing; a Z closes the outlet's register and the next sale opens a new one.
        </>}
        actions={outlets.length > 0 ? (
          <FilterSelect
            label="Outlet"
            value={at ? labelOf(at) : ""}
            options={outlets.map(labelOf)}
            active={false}
            onChange={(v) => { setPick(outlets.find((l) => labelOf(l) === v)?.key ?? null); }}
          />
        ) : undefined}
      />
      <RegisterPanel loc={at?.key ?? null} locName={at?.n ?? ""} canX canZ canClose />
    </>
  );
}
