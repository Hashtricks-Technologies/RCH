import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import Pos from "./Pos";
import Bills from "./Bills";
import Stock from "./Stock";
import Availability from "./Availability";
import Requests from "./Requests";
import Tickets from "./Tickets";

// Drawer modules register themselves on import.
import "./BillDrawer";
import "./RequestDrawer";
import "./TicketDrawer";
import "./ConfigureDrawer";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard,
  pos: Pos,
  bills: Bills,
  stock: Stock,
  avail: Availability,
  requests: Requests,
  tickets: Tickets,
};
