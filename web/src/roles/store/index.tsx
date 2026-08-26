import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import IssueDesk from "./IssueDesk";
import Stock from "./Stock";
import Requisitions from "./Requisitions";
import Reports from "./Reports";
import "./TicketDrawer";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard, issue: IssueDesk, stock: Stock, procure: Requisitions, reports: Reports,
};
