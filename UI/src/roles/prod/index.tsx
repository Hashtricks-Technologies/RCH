import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import Orders from "./Orders";
import MakeDistribute from "./MakeDistribute";
import Stock from "./Stock";
import Availability from "./Availability";
import Requests from "./Requests";
import Tickets from "./Tickets";
import "./OrderDrawer";
import "./TicketDrawer";
// ---- item patch ----
import "../manager/ItemDrawer";
// ---- adjustments: the "adjstock" drawer, pinned to the kitchen by the button that opens it.
import "../../ui/AdjustmentForm";
// ---- recipes: one screen, shared with the manager, so it lives in ui/ rather than here.
import RecipeBook from "../../ui/RecipeBook";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard,
  orders: Orders,
  make: MakeDistribute,
  recipes: RecipeBook,
  stock: Stock,
  avail: Availability,
  requests: Requests,
  tickets: Tickets,
};
