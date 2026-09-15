// The counter's own door onto its shelf: an ask, not a write. `AdjustmentForm` in
// `ui/AdjustmentForm.tsx` (`mode="request"`) does the actual work - this only pins it to the
// counter's own outlet and wraps it in a drawer, the same shape `AdjustStockDrawer` there takes
// for the kitchen's direct write-off.
import { useApp } from "../../store";
import { LOC } from "../../data/master";
import AdjustmentForm from "../../ui/AdjustmentForm";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";

function RequestAdjustmentDrawer({ id }: DrawerProps) {
  void id; // always opened as "new" - the ask is against this counter's own outlet, nothing else
  const loc = useApp((x) => x.user)!.loc;
  return (
    <DrawerFrame title={`Request an adjustment - ${LOC[loc].n}`} sub={`${LOC[loc].c} · ${LOC[loc].cc}`}>
      <AdjustmentForm locs={[loc]} fixedLoc={loc} mode="request" />
    </DrawerFrame>
  );
}

registerDrawer("creqadj", RequestAdjustmentDrawer);
