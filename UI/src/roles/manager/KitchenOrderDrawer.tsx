import { useState } from "react";
import { LOC } from "../../data/master";
import { useApp } from "../../store";
import { openOutlets } from "../../lib/selectors";
import { Alert, Field, Section } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import KitchenOrderForm from "../../ui/KitchenOrderForm";
import { registerDrawer } from "../../drawers";
import type { LocKey } from "../../types";

/**
 * The manager ordering from the Central Kitchen on an outlet's behalf - the evening's cover
 * booked from the dashboard rather than by ringing the counter and asking them to raise it.
 *
 * One manager supervises all three shops, so unlike the counter's card this one has to *name*
 * the outlet: the server refuses an order with no `from` in exactly those words, and refuses
 * the kitchen and the central store outright. The picker is what keeps the operator out of
 * both refusals.
 */
function KitchenOrderDrawer() {
  const close = useApp((x) => x.closeDrawer);
  // `LOC` is empty until the snapshot lands, and a closed outlet is never offered here either -
  // so `openOutlets()[0]` is `undefined` on either one, typed as a real outlet, and every read of
  // `LOC[loc]` below it would then be reading `LOC[undefined]`. `null` is a state this drawer can
  // render a sentence for; a lie about the type is not.
  const [loc, setLoc] = useState<LocKey | null>(openOutlets()[0] ?? null);

  if (!loc) {
    return (
      <DrawerFrame title="Order from the kitchen" sub="No outlet to order for">
        <Alert tone="w" label="NO OUTLET">
          There is no shop on this deployment for the kitchen to make anything for. A production
          order is raised for an outlet, so one has to exist before this drawer has anything to ask.
        </Alert>
      </DrawerFrame>
    );
  }

  return (
    <DrawerFrame
      title="Order from the kitchen"
      sub="Ask the Central Kitchen to make something for one of the three shops"
    >
      <Field label="Which outlet is this for" tip="The tray is dispatched to this shop and shows on its own screen.">
        <select value={loc} aria-label="Outlet" onChange={(e) => setLoc(e.target.value as LocKey)}>
          {openOutlets().map((l) => <option key={l} value={l}>{LOC[l]?.n ?? l}</option>)}
        </select>
      </Field>

      <Section title="What to make" tip="Finished goods the kitchen bakes and that outlet sells">
        <KitchenOrderForm loc={loc} onDone={close} />
      </Section>

      <Alert tone="i" label="NOT YET HELD">
        Raising an order reserves nothing. The kitchen accepts it, makes it, and holds the stock
        only when it dispatches - which is when the outlet gets its pick ticket.
      </Alert>
    </DrawerFrame>
  );
}

registerDrawer("korder", KitchenOrderDrawer);
