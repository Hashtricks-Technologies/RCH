// The counter's own door onto its shelf: an ask, not a write. `AdjustmentForm` in
// `ui/AdjustmentForm.tsx` (`mode="request"`) does the actual work - this only pins it to the
// counter's own outlet and wraps it in a drawer, the same shape `AdjustStockDrawer` there takes
// for the kitchen's direct write-off.
import { useApp } from "../../store";
import { LOC } from "../../data/master";
import AdjustmentForm from "../../ui/AdjustmentForm";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import { permissionRefusal } from "@rch/domain";
import { Alert } from "../../ui/kit";
import { useCan } from "../../lib/selectors";

function RequestAdjustmentDrawer({ id }: DrawerProps) {
  void id; // always opened as "new" - the ask is against this counter's own outlet, nothing else
  const loc = useApp((x) => x.user)!.loc;
  const may = useCan("outlet_stock");
  if (!may) {
    return (
      <DrawerFrame title="Request an adjustment" sub="View only">
        <Alert tone="w" label="VIEW ONLY">{permissionRefusal("outlet_stock")}</Alert>
      </DrawerFrame>
    );
  }
  return (
    <DrawerFrame title={`Request an adjustment - ${LOC[loc].n}`} sub={`${LOC[loc].c} · ${LOC[loc].cc}`}>
      <AdjustmentForm locs={[loc]} fixedLoc={loc} mode="request" />
    </DrawerFrame>
  );
}

registerDrawer("creqadj", RequestAdjustmentDrawer);
