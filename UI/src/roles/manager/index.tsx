import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import Approvals from "./Approvals";
import ItemsStock from "./ItemsStock";
import Prices from "./Prices";
import Availability from "./Availability";
import "./ApprovalDrawer";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard, approvals: Approvals, stock: ItemsStock, prices: Prices, avail: Availability,
};
