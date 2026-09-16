import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import Approvals from "./Approvals";
import ItemsStock from "./ItemsStock";
import MenuManagement from "./MenuManagement";
import Prices from "./Prices";
import Availability from "./Availability";
import "./ApprovalDrawer";
// ---- item patch ----
import "./ItemDrawer";
// ---- bill void: the manager reads a bill in the same drawer the counter does - one bill, one
// way of reading it - and the drawer grows the Void button for the manager alone.
import Bills from "./Bills";
import "../counter/BillDrawer";
// ---- prod-order raise ----
import "./KitchenOrderDrawer";
// ---- adjustment requests: the outlet manager decides a counter's ask; it no longer adjusts an
// outlet's shelf directly, so this registers "madjreq" - the manager's own review drawer, not
// the direct-adjust one the counter's "cadjreq" and the kitchen's "adjstock" are.
import "./AdjustmentRequestDrawer";
// ---- price-list settings: creating a list, and which list each outlet charges from - both
// were inline on one outlet's page, where the sharing between outlets could not be seen.
import "./PriceListSettingsDrawer";
// ---- party billing: what each party is charged, what they still owe, and what settles it. The
// statement drawer is registered here for its side effect like every other one, because the
// screen opens it by key ("stmt") and never imports the module.
import Credit from "./Credit";
import "./StatementDrawer";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard, approvals: Approvals, stock: ItemsStock, menu: MenuManagement,
  prices: Prices, avail: Availability, bills: Bills, credit: Credit,
};
