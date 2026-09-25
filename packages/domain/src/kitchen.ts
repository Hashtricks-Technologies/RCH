import { KITCHEN } from "@rch/contract";
import type { ItemType, Source, WastageReason } from "@rch/contract";
import { round3 } from "./round.js";

/**
 * The Central Kitchen's two rules about what it holds.
 *
 * **Raw materials and packaging are not stocked at the kitchen.** Only what is issued to it is
 * tracked: whatever lands there - a ticket received, a count-up, an opening figure - counts as
 * used on landing, so the server posts the landing move and an equal `production_consume` move
 * in the same transaction and the kitchen's balance of every raw and packing line is always
 * zero. The ledger still says what was issued, and at what cost; there is simply no shelf for a
 * par level, a low alert or a write-off to read. A loss is recorded as wastage instead.
 *
 * **A finished good is either counted or on/off only.** A counted one (`FG`: puffs, sandwiches)
 * is batched, held, dispatched and sold down as it always was. An on/off-only one (meals, dosa)
 * is `MTO` with `src: "kitchen"`: it is cooked for service and never counted, so - like a
 * counter's own made-to-order drink - selling it moves no stock, and its availability is a
 * switch. The difference is whose switch: the kitchen's, and it reaches every outlet.
 */

/** Whether a quantity of this type landing at this location is used the moment it lands. */
export const usedOnArrival = (t: ItemType, loc: string): boolean => loc === KITCHEN && (t === "RAW" || t === "PACK");

/** Whether this item is one of the kitchen's on/off-only products. */
export const isOnOff = (item: { t: ItemType; src?: Source } | undefined): boolean =>
  item?.t === "MTO" && item.src === "kitchen";

/** Whether the kitchen makes this item - counted or on/off only. What its Product On/Off screen
 *  lists, and what its item drawer offers the Counted / On/off only choice for. */
export const isKitchenMade = (item: { t: ItemType; src?: Source } | undefined): boolean =>
  item?.t === "FG" || isOnOff(item);

/** The reason every counter reads beside an on/off item the kitchen has switched off. */
export const KITCHEN_OFF_REASON = "switched off by the kitchen";

/** The refusal for anything that would count an on/off item: a kitchen order, a batch, a
 *  distribution, a dispatch. `what` finishes the sentence ("ordered from the kitchen"). */
export const onOffRefusal = (name: string, what: string): string =>
  `${name} is on/off only - the kitchen switches it on and off, so it is not ${what}`;

/** Why a counted finished good cannot become on/off only yet: something still holds or carries
 *  it. Each part names where. */
export function toOnOffRefusal(name: string, blockers: { held: readonly string[]; tickets: readonly string[]; orders: readonly string[] }): string | null {
  const parts = [
    blockers.held.length > 0 ? `stock at ${blockers.held.join(", ")}` : "",
    blockers.tickets.length > 0 ? `open ticket${blockers.tickets.length === 1 ? "" : "s"} ${blockers.tickets.join(", ")}` : "",
    blockers.orders.length > 0 ? `open kitchen order${blockers.orders.length === 1 ? "" : "s"} ${blockers.orders.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length === 0 ? null : `${name} cannot become on/off only while there is ${parts.join(" and ")} - sell, write off or finish those first`;
}

/** The kitchen's raw lines are not on a shelf, so a write-off of one has nothing to take down. */
export const notStockedAtKitchenMessage = (name: string): string =>
  `${name} is not stocked at the kitchen - it was used when it arrived; record it as wastage instead`;

/** The four reasons a wastage record may carry, in the order the form offers them. */
export const WASTAGE_REASONS: readonly WastageReason[] = ["wastage", "expired", "breakage", "other"];

/** What a quantity is worth at a unit cost, to the paisa. The wastage record stores it, and the
 *  kitchen's issued report prints the same figure. */
export const valueAtCost = (qty: number, cost: number): number => Math.round(round3(qty) * cost * 100) / 100;
