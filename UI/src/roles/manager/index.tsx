import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import Approvals from "./Approvals";
import ItemsStock from "./ItemsStock";
import Prices from "./Prices";
import Availability from "./Availability";
import "./ApprovalDrawer";
// ---- item patch ----
import "./ItemDrawer";
// ---- bill void: the manager reads a bill in the same drawer the counter does - one bill, one
// way of reading it - and the drawer grows the Void button for the manager alone.
import Bills from "./Bills";
import "../counter/BillDrawer";
// ---- adjustments: the "adjstock" drawer is shared with the kitchen, so it is registered
// beside the form both of them open rather than twice, once in each screen.
import "../../ui/AdjustmentForm";
// ---- prod-order raise ----
import "./KitchenOrderDrawer";
// ---- recipes: the kitchen's screen too, so it lives in ui/ rather than under either role.
import RecipeBook from "../../ui/RecipeBook";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard, approvals: Approvals, stock: ItemsStock, prices: Prices, avail: Availability,
  bills: Bills,
  recipes: RecipeBook,
};
