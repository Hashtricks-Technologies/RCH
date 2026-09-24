import type { ComponentType } from "react";
import type { Role } from "./types";
import type { ScreenKey } from "./screens";
import Settings from "./pages/Settings";
import Support from "./pages/Support";
// ---- the register: one screen for the counter and the manager, so it lives in `ui/` - role
// folders never import one another.
import Register from "./ui/Register";

import CounterDashboard from "./roles/counter/Dashboard";
import Pos from "./roles/counter/Pos";
import CounterBills from "./roles/counter/Bills";
import OutletStock from "./roles/counter/Stock";
import OutletRequests from "./roles/counter/Requests";
import OutletTickets from "./roles/counter/Tickets";

import ManagerDashboard from "./roles/manager/Dashboard";
import Approvals from "./roles/manager/Approvals";
import ItemsStock from "./roles/manager/ItemsStock";
import MenuManagement from "./roles/manager/MenuManagement";
import PriceLists from "./roles/manager/Prices";
import CounterPrices from "./roles/manager/CounterPrices";
import OutletAvailability from "./roles/manager/Availability";
import ManagerBills from "./roles/manager/Bills";
import Credit from "./roles/manager/Credit";

import StoreDashboard from "./roles/store/Dashboard";
import IssueDesk from "./roles/store/IssueDesk";
import StoreStock from "./roles/store/Stock";
import StoreRequisitions from "./roles/store/Requisitions";
import Reports from "./roles/store/Reports";
import Adjustments from "./roles/store/Adjustments";

import KitchenDashboard from "./roles/prod/Dashboard";
import KitchenOrders from "./roles/prod/Orders";
import MakeDistribute from "./roles/prod/MakeDistribute";
import KitchenStock from "./roles/prod/Stock";
import KitchenAvailability from "./roles/prod/Availability";
import KitchenRequests from "./roles/prod/Requests";
import KitchenTickets from "./roles/prod/Tickets";

import BuyerDashboard from "./roles/buyer/Dashboard";
import Requisitions from "./roles/buyer/Requisitions";
import ProcurementList from "./roles/buyer/ProcurementList";
import PurchaseOrders from "./roles/buyer/PurchaseOrders";
import Contracts from "./roles/buyer/Contracts";
import Inventory from "./roles/buyer/Inventory";
import NewProducts from "./roles/buyer/NewProducts";
import Vendors from "./roles/buyer/Vendors";

// Drawer modules register themselves on import. Every drawer is loaded for every session: a
// role may hold screens from more than one desk, and a screen opens its drawers by key.
import "./roles/counter/BillDrawer";
import "./roles/counter/RequestDrawer";
import "./roles/counter/TicketDrawer";
import "./roles/counter/ConfigureDrawer";
// ---- prod-order raise: the counter's, and the manager's way of booking one.
import "./roles/counter/KitchenOrderDrawer";
import "./roles/manager/KitchenOrderDrawer";
// ---- adjustment requests: the counter asks ("creqadj", "cadjreq"); the outlet manager decides
// ("madjreq") - it no longer adjusts an outlet's shelf directly.
import "./roles/counter/AdjustmentRequestForm";
import "./roles/counter/AdjustmentRequestDrawer";
import "./roles/manager/AdjustmentRequestDrawer";
import "./roles/manager/ApprovalDrawer";
// ---- item patch: one drawer for every desk that edits the master; which boxes it greys out is
// the caller's own permissions. It lives under `manager/` because that is where the item
// master's own screen is.
import "./roles/manager/ItemDrawer";
// ---- price-list settings: creating a list, and which list each outlet charges from.
import "./roles/manager/PriceListSettingsDrawer";
// ---- party billing: the statement drawer, opened by key ("stmt") from the Credit screen.
import "./roles/manager/StatementDrawer";
import "./roles/store/TicketDrawer";
import "./roles/store/IssueDetail";
import "./roles/store/RequisitionDetail";
import "./roles/store/NewProductDrawer";
import "./roles/prod/OrderDrawer";
import "./roles/prod/OrderHistoryDrawer";
import "./roles/prod/TicketDrawer";
// ---- adjustments: the "adjstock" drawer, pinned to the shelf by the button that opens it.
import "./ui/AdjustmentForm";
import "./roles/buyer/RequisitionDrawer";
import "./roles/buyer/AddToListDrawer";
import "./roles/buyer/PoDrawer";
import "./roles/buyer/PoReceiptDrawer";
import "./roles/buyer/VendorDrawer";
import "./roles/buyer/NewProductDrawer";
import "./roles/buyer/ContractDrawer";

/**
 * Price lists as the manager once ran them - named lists, cloned, shared between outlets and
 * switched - are hidden, not deleted. The screen, its drawer and every server route stay; with
 * this off, the `prices` key opens the counter price grid instead, where each counter is priced
 * on its own and no list is ever named. Turn it on to bring the old screen back under the same
 * sidebar entry.
 */
const PRICE_LISTS_ENABLED = false;

/** Who is looking, as far as choosing a screen's view goes. */
export interface Viewer { r: Role; wide: boolean }

/** A key whose view depends on who opens it. */
interface Picked { pick: (v: Viewer) => ComponentType }
type Pick = ComponentType | Picked;

const DASHBOARD: Record<Role, ComponentType> = {
  counter: CounterDashboard, manager: ManagerDashboard, store: StoreDashboard, prod: KitchenDashboard, buyer: BuyerDashboard,
};

const COMPONENTS: Record<ScreenKey, Pick> = {
  dash: { pick: (v) => DASHBOARD[v.r] },
  issues: Support,
  settings: Settings,
  pos: Pos,
  // Every outlet's bills for someone who reads hospital-wide; the one counter's otherwise.
  bills: { pick: (v) => (v.wide ? ManagerBills : CounterBills) },
  register: Register,
  credit: Credit,
  approvals: Approvals,
  "items-stock": ItemsStock,
  menu: MenuManagement,
  prices: PRICE_LISTS_ENABLED ? PriceLists : CounterPrices,
  // The kitchen's own board; the manager's every-outlet one when `AVAILABILITY_SCREEN_ENABLED`
  // puts it back on that desk.
  avail: { pick: (v) => (v.r === "prod" ? KitchenAvailability : OutletAvailability) },
  "outlet-stock": OutletStock,
  "outlet-requests": OutletRequests,
  "outlet-tickets": OutletTickets,
  issue: IssueDesk,
  "store-stock": StoreStock,
  adjust: Adjustments,
  procure: StoreRequisitions,
  reports: Reports,
  "kitchen-orders": KitchenOrders,
  make: MakeDistribute,
  "kitchen-stock": KitchenStock,
  "kitchen-requests": KitchenRequests,
  "kitchen-tickets": KitchenTickets,
  requisitions: Requisitions,
  pool: ProcurementList,
  "purchase-orders": PurchaseOrders,
  contracts: Contracts,
  inventory: Inventory,
  newproducts: NewProducts,
  vendors: Vendors,
};

/** The component that draws `key` for this viewer. */
export function screenFor(v: Viewer, key: ScreenKey): ComponentType {
  const c = COMPONENTS[key];
  return "pick" in c ? c.pick(v) : c;
}
