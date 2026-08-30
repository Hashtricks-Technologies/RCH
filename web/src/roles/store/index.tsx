import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import IssueDesk from "./IssueDesk";
import Inbound from "./Inbound";
import Stock from "./Stock";
import Requisitions from "./Requisitions";
import Contracts from "./Contracts";
import Reports from "./Reports";
import "./TicketDrawer";
import "./IssueDetail";
import "./RequisitionDetail";
import "./NewProduct";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard, issue: IssueDesk, inbound: Inbound, stock: Stock,
  procure: Requisitions, contracts: Contracts, reports: Reports,
};
