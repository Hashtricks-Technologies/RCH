import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import IssueDesk from "./IssueDesk";
import Stock from "./Stock";
import Requisitions from "./Requisitions";
import Contracts from "./Contracts";
import Reports from "./Reports";
// ---- adjustments
import Adjustments from "./Adjustments";
import "./TicketDrawer";
import "./IssueDetail";
import "./RequisitionDetail";
import "./NewProductDrawer";
// ---- item patch ----
// One drawer for all four desks that edit the master; which boxes it greys out is the caller's
// own role, read from `ITEM_FIELD_ROLES`. It lives under `manager/` because that is where the
// item master's own screen is.
import "../manager/ItemDrawer";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard, issue: IssueDesk, stock: Stock,
  procure: Requisitions, contracts: Contracts, reports: Reports,
  // ---- adjustments
  adjust: Adjustments,
};
