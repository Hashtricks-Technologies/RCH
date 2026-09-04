import type { Vendor } from "../types";

/** First active vendor that supplies this item group. */
export const suggestVendor = (vendors: Vendor[], group: string): Vendor | null =>
  vendors.find((v) => v.active && v.groups.includes(group)) ?? null;

/** Names resolve for inactive vendors too — a deactivated vendor must stay
 *  readable on the orders it already carries. */
export const vendorName = (vendors: Vendor[], id: string): string =>
  vendors.find((v) => v.id === id)?.n ?? "Unknown vendor";
