import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import Approvals from "./Approvals";
import ItemsStock from "./ItemsStock";
import Prices from "./Prices";
import Availability from "./Availability";
import "./ApprovalDrawer";
// ---- bill void: the manager reads a bill in the same drawer the counter does — one bill, one
// way of reading it — and the drawer grows the Void button for the manager alone.
import Bills from "./Bills";
import "../counter/BillDrawer";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard, approvals: Approvals, stock: ItemsStock, prices: Prices, avail: Availability,
  bills: Bills,
};
