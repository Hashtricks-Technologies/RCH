import { useState } from "react";
import { LOC, PL, PRICE_LISTS } from "../../data/master";
import { useApp } from "../../store";
import { Alert, Btn, DataTable, Locked, Pill, Section, Tip } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer } from "../../drawers";
import { openOutlets, useCan } from "../../lib/selectors";
import { listFor, listOf, nameOfList, sharers } from "./Prices";
import type { LocKey } from "../../types";

/**
 * Which list each outlet charges from, and every list there is.
 *
 * The mapping used to sit inline on one outlet's own price page, as a picker that switched
 * *that* outlet. Read one outlet at a time, the model is invisible - a manager could not see
 * that two counters were standing on the same list until a price edited for the Restaurant
 * turned up on the Coffee Shop's till. So it is a table of every outlet at once, and each row
 * says out loud who else is on that list.
 *
 * **Creating a list is not here.** It is one short question with two answers, so it is a dialog
 * raised from the New price list button on the Prices page itself (`NewListDialog`), where a
 * manager looking for it looks - rather than a section inside a panel called Settings.
 *
 * Nothing here decides anything. The server owns every refusal - a list an outlet is still
 * active on, an outlet already on the list picked - and each one reaches the operator as the
 * store's toast of the server's own sentence.
 */
function PriceListSettings() {
  // The registries are replaced in place by a refetch, so a component that reads them during
  // render is pinned to `catalogVersion` exactly as every other one is.
  const version = useApp((x) => x.catalogVersion);
  void version;
  const deletePriceList = useApp((x) => x.deletePriceList);
  const setOutletPriceList = useApp((x) => x.setOutletPriceList);
  const may = useCan("prices");

  const [dropList, setDropList] = useState<string | null>(null);
  /** One key per control with a write in flight. Every write on this panel can be refused, so
   *  none of them may clear what was typed or picked until the server has actually taken it. */
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const lock = (k: string, on: boolean) => { setBusy((b) => ({ ...b, [k]: on })); };

  const outlets = openOutlets();
  const allLists = Object.values(PRICE_LISTS).sort((a, b) => a.name.localeCompare(b.name));
  const outletNames = (ls: LocKey[]) => listOf(ls.map((l) => LOC[l]?.n ?? l));

  if (outlets.length === 0) {
    return (
      <DrawerFrame title="Price lists" sub="No outlet is configured yet">
        <Alert tone="w" label="NO OUTLET">
          A price list is attached to an outlet, so there is nothing to attach one to on this
          deployment yet.
        </Alert>
      </DrawerFrame>
    );
  }

  const attach = async (loc: LocKey, listId: string) => {
    lock(`attach:${loc}`, true);
    await setOutletPriceList(loc, listId);
    lock(`attach:${loc}`, false);
  };
  const remove = async (id: string) => {
    lock(`drop:${id}`, true);
    const ok = await deletePriceList(id);
    lock(`drop:${id}`, false);
    if (ok) setDropList(null);
  };

  return (
    <DrawerFrame title="Price lists" sub="Which list each outlet charges from">
      <Section
        title="Which list each outlet charges from"
        tip="One list can serve several outlets. Attaching a different one changes what that counter charges from the next sale."
      >
        <Alert tone="i" label="SHARED">
          A price list is not a shop. Where two outlets sit on the same list, a price edited for
          one of them is the price the other charges too - the rows below say who shares what.
        </Alert>
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Outlet", cls: "nm" },
              { h: "Active list" },
              { h: "Shared with" },
              { h: "Attach a list", w: "32%" },
            ]}
            rows={outlets.map((loc) => {
              // A bare deployment's outlets carry no list at all, which is not the same thing as
              // sharing one: `sharers("")` would otherwise report all three as sharing nothing.
              const active = listFor(loc);
              const others = active === "" ? [] : sharers(active).filter((l) => l !== loc);
              return {
                key: loc,
                cells: [
                  <>{LOC[loc].n}<small>{LOC[loc].c}</small></>,
                  active === "" ? <span className="mini">No list yet</span> : nameOfList(active),
                  active === "" ? <span className="mini">Nothing to share</span>
                    : others.length > 0 ? <Pill tone="wn">{outletNames(others)}</Pill>
                      : <span className="mini">This outlet only</span>,
                  <Locked f="prices" locked={!may}><select
                    value={active}
                    aria-label={`Price list for ${LOC[loc].n}`}
                    disabled={!may || busy[`attach:${loc}`]}
                    onChange={(e) => { if (e.target.value !== "") void attach(loc, e.target.value); }}
                  >
                    {/* The outlet's own list first, and by id rather than by name, so the box
                        still reads correctly in the moment between a create landing and the
                        registry catching up with it. */}
                    <option value={active}>{active === "" ? "Pick a list…" : nameOfList(active)}</option>
                    {allLists.filter((pl) => pl.id !== active).map((pl) => (
                      <option key={pl.id} value={pl.id}>{pl.name}</option>
                    ))}
                  </select></Locked>,
                ],
              };
            })}
          />
        </div>
      </Section>

      <Section
        title="Every price list"
        sub={`${allLists.length} in all`}
        tip="A list can be deleted only once no outlet is charging from it. Attach the outlets on it to another list first."
      >
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Name", cls: "nm" },
              { h: "Outlets" },
              { h: "Items", r: true },
              ...(may ? [{ h: "Actions", w: "30%" }] : []),
            ]}
            empty={{ title: "No price list yet", sub: "Press New price list on the Prices page behind this panel." }}
            rows={allLists.map((pl) => ({
              key: pl.id,
              cells: [
                pl.name,
                pl.outlets.length > 0 ? outletNames(pl.outlets) : <span className="mini">Unattached</span>,
                Object.keys(PL[pl.id] ?? {}).length,
                ...(!may ? [] : [dropList === pl.id ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <Btn size="xs" variant="dg" disabled={busy[`drop:${pl.id}`]} onClick={() => void remove(pl.id)}>
                      {busy[`drop:${pl.id}`] ? "Deleting…" : "Confirm delete"}
                    </Btn>
                    <Btn size="xs" variant="gh" onClick={() => { setDropList(null); }}>Cancel</Btn>
                  </div>
                ) : pl.outlets.length > 0 ? (
                  // Disabled with the reason on it rather than a click the server turns away:
                  // the refusal is knowable from what is already on screen.
                  <span className="tipped">
                    <Btn size="xs" variant="dg" disabled>Delete</Btn>
                    <Tip
                      label="Delete"
                      text={`Refused - ${pl.name} is what ${outletNames(pl.outlets)} ${pl.outlets.length === 1 ? "charges" : "charge"} from - attach ${pl.outlets.length === 1 ? "it" : "them"} to another list first.`}
                    />
                  </span>
                ) : (
                  <Btn size="xs" variant="dg" onClick={() => { setDropList(pl.id); }}>Delete</Btn>
                )]),
              ],
            }))}
          />
        </div>
      </Section>
    </DrawerFrame>
  );
}

registerDrawer("plset", PriceListSettings);
