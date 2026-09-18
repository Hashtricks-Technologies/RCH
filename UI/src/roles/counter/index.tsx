import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import Pos from "./Pos";
import Bills from "./Bills";
import Stock from "./Stock";
import Requests from "./Requests";
import Tickets from "./Tickets";
// ---- the register: one screen for the counter and the manager, so it lives in `ui/` - role
// folders never import one another.
import Register from "../../ui/Register";

// Drawer modules register themselves on import.
import "./BillDrawer";
import "./RequestDrawer";
import "./TicketDrawer";
import "./ConfigureDrawer";
// ---- prod-order raise ----
import "./KitchenOrderDrawer";
// ---- adjustment requests ----
import "./AdjustmentRequestForm";
import "./AdjustmentRequestDrawer";

// There is no standalone Product Availability screen for the counter - every
// product's on/off state and switch live inline, on the POS tile and the
// Stock in Hand card, behind the kebab menu.
export const screens: Record<string, ComponentType> = {
  dash: Dashboard,
  pos: Pos,
  bills: Bills,
  stock: Stock,
  requests: Requests,
  tickets: Tickets,
  register: Register,
};
