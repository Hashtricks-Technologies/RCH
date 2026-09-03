import type { Item, Location, Recipe } from "@rch/contract";

/** The master data every rule in this file is parameterised by — no registry reads. */
export type Master = { items: Record<string, Item>; locations: Record<string, Location>; recipes: Record<string, Recipe> };
/** Stock on hand: location -> item -> quantity. */
export type StockMap = Record<string, Record<string, number>>;
/** Reserved quantity, keyed "loc:item". */
export type RsvMap = Record<string, number>;
/** Manual availability override reason, keyed "loc:item". */
export type OvrMap = Record<string, string>;
/** The two till price lists. */
export type Prices = { A: Record<string, number>; B: Record<string, number> };

export const qty = (stock: StockMap, l: string, it: string): number => stock[l]?.[it] ?? 0;
export const resv = (rsv: RsvMap, l: string, it: string): number => rsv[`${l}:${it}`] ?? 0;
export const avail = (stock: StockMap, rsv: RsvMap, l: string, it: string): number =>
  qty(stock, l, it) - resv(rsv, l, it);
