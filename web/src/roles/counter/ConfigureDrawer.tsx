import { useNavigate } from "react-router-dom";
import { IT, LOC, RCP } from "../../data/master";
import { useApp } from "../../store";
import {
  avail, availOf, daysCover, menuOf, parOf, qty, resv, stateLabel, stateTone,
} from "../../lib/selectors";
import { fq, money, U } from "../../lib/fmt";
import { Alert, Btn, ImagePlaceholder, Pill, Switch } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import { TypeTag } from "./Pos";

/**
 * The built-in on/off control for Stock in Hand — every detail the card
 * already showed, plus the same switch as the dedicated Product Availability
 * screen, reachable without leaving the stock grid. Configure is for a
 * sellable product; a raw ingredient gets its details with a plain note,
 * since there is nothing to switch on or off.
 */
function ConfigureDrawer({ id: it }: DrawerProps) {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const toggleAvail = useApp((x) => x.toggleAvail);
  const nav = useNavigate();
  const close = useApp((x) => x.closeDrawer);
  const loc = user.loc;
  const item = IT[it];
  if (!item) return <DrawerFrame title="Not found"><p className="mini">That product is no longer on the master.</p></DrawerFrame>;

  const held = Object.prototype.hasOwnProperty.call(s.stock[loc] ?? {}, it)
    || (item.t === "MTO" && RCP[it]?.l.some(([g]) => Object.prototype.hasOwnProperty.call(s.stock[loc] ?? {}, g)));
  const on = qty(s, loc, it);
  const rv = resv(s, loc, it);
  const a = avail(s, loc, it);
  const rl = parOf(loc, it);
  const cover = daysCover(a, it, loc);

  const sellableHere = menuOf(s, loc).includes(it);
  const manualOff = Boolean(s.ovr[loc + ":" + it]);
  const computed = availOf(s, loc, it);

  return (
    <DrawerFrame
      title="Configure"
      sub={`${item.n} · ${LOC[loc].n}`}
      foot={<Btn variant="gh" onClick={close}>Close</Btn>}
    >
      <ImagePlaceholder size="card" />
      <div style={{ height: 14 }} />
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap", marginBottom: 12 }}>
        <b style={{ fontSize: 15 }}>{item.n}</b>
        <TypeTag t={item.t} />
        <span className="mini">{item.c} · {item.g}</span>
      </div>

      <div className="stkcard-stats" style={{ marginBottom: 12 }}>
        <div className="totrow"><span>On hand</span><span>{held ? <>{fq(on, it)} {U(it)}</> : "—"}</span></div>
        <div className="totrow"><span>Reserved</span><span className={held && rv > 0 ? undefined : "dim"}>{held ? fq(rv, it) : "—"}</span></div>
        <div className="totrow"><span>Available</span>
          <span style={held && a <= 0 ? { color: "var(--crit)", fontWeight: 600 } : { fontWeight: 600 }}>
            {held ? fq(a, it) : "—"}
          </span>
        </div>
        <div className="totrow"><span>Par here</span><span className="dim">{rl > 0 ? fq(rl, it) : "—"}</span></div>
        <div className="totrow"><span>Days of cover</span>
          <span style={held && a <= 0 ? { color: "var(--crit)" } : undefined}>{held ? `${cover.toFixed(1)} d` : "—"}</span>
        </div>
        <div className="totrow"><span>State</span>
          <span>{held
            ? <Pill tone={stateTone(a, rl)}>{stateLabel(a, rl)}</Pill>
            : <Pill tone="mu">Not stocked</Pill>}</span>
        </div>
      </div>

      {sellableHere ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
            <Switch on={!manualOff} label={`${item.n} at ${LOC[loc].n}`} onChange={() => toggleAvail(loc, it)} />
            <div>
              <b style={{ fontSize: 12.5 }}>Available at {LOC[loc].n}</b>
              <div className="mini">Turn this off when the machine is down or the product is spoiled.</div>
            </div>
          </div>
          <div className="mtop">
            {computed.ok
              ? <Alert tone="g" label="ON">{computed.left} — computed from stock, on top of the switch above.</Alert>
              : <Alert tone="c" label="OFF">{computed.why ?? "unavailable"} — the switch cannot override this by itself.</Alert>}
          </div>
          <p className="mini mtop">
            Sells for {money(s.prices[LOC[loc].list ?? "A"]?.[it] ?? 0)} at this counter.{" "}
            <a onClick={() => { close(); nav("/avail"); }} style={{ cursor: "pointer" }}>
              See every product at once →
            </a>
          </p>
        </>
      ) : (
        <Alert tone="i" label="NOTE">
          Not sold directly at {LOC[loc].n} — it is a recipe ingredient here, so there is nothing to switch on or off.
        </Alert>
      )}
    </DrawerFrame>
  );
}

registerDrawer("cconfig", ConfigureDrawer);

export default ConfigureDrawer;
