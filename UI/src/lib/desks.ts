import type { Role } from "../types";

/**
 * A desk as the admin page names it - where someone works, not the role they hold there. Every
 * role sits on one desk; a support ticket carries only the desk. The words follow the domain's
 * own ("The kitchen desk can't be given…", `grantRefusal`), so a refusal and the picker agree.
 */
export const DESK_LABEL: Readonly<Record<Role, string>> = {
  counter: "Counter", manager: "Outlet manager", store: "Store", prod: "Kitchen", buyer: "Purchasing",
};

/** The desks in the order every picker lists them. */
export const DESKS: readonly Role[] = ["counter", "manager", "store", "prod", "buyer"];
