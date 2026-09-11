import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import Approvals from "./Approvals";
import ItemsStock from "./ItemsStock";
import Prices from "./Prices";
import Availability from "./Availability";
import "./ApprovalDrawer";
// ---- adjustments: the "adjstock" drawer is shared with the kitchen, so it is registered
// beside the form both of them open rather than twice, once in each screen.
import "../../ui/AdjustmentForm";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard, approvals: Approvals, stock: ItemsStock, prices: Prices, avail: Availability,
};
