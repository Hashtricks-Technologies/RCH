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

export const screens: Record<string, ComponentType> = {
  dash: Dashboard,
  orders: Orders,
  make: MakeDistribute,
  stock: Stock,
  avail: Availability,
  requests: Requests,
  tickets: Tickets,
};
