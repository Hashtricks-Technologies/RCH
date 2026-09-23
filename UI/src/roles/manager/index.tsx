import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import Approvals from "./Approvals";
import ItemsStock from "./ItemsStock";
import MenuManagement from "./MenuManagement";
import Prices from "./Prices";
import CounterPrices from "./CounterPrices";
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
// ---- the register: the same screen the counter reads, scoped to whichever outlet the manager
// picks. It lives in `ui/` because role folders never import one another.
import Register from "../../ui/Register";
import { AVAILABILITY_SCREEN_ENABLED } from "../../nav";

/**
 * Price lists as the manager once ran them - named lists, cloned, shared between outlets and
 * switched - are hidden, not deleted. The screen, its drawer and every server route stay; with
 * this off, the `prices` key opens the counter price grid instead, where each counter is priced
 * on its own and no list is ever named. Turn it on to bring the old screen back under the same
 * sidebar entry.
 */
const PRICE_LISTS_ENABLED = false;

export const screens: Record<string, ComponentType> = {
  dash: Dashboard, approvals: Approvals, stock: ItemsStock, menu: MenuManagement,
  prices: PRICE_LISTS_ENABLED ? Prices : CounterPrices, bills: Bills, credit: Credit, register: Register,
  // Hidden with its sidebar entry (`AVAILABILITY_SCREEN_ENABLED` in `nav.ts`): the Prices grid's
  // switch is the manager's one on/off.
  ...(AVAILABILITY_SCREEN_ENABLED ? { avail: Availability } : {}),
};
