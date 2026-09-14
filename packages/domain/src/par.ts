import type { LocKey, Location } from "@rch/contract";

/**
 * How much of a location's average daily issue one par level covers, per location (M11).
 *
 * It is a record, not a number: the central store carries a full day of cover, an outlet a fifth
 * of one, because a shop that runs out asks the store rather than the vendor. The arithmetic
 * that reads it is `parOf` in `UI/src/lib/selectors.ts` - `PAR_FACTOR[l] ?? 1` against the item's
 * own reorder level - and it lives here rather than in the contract because it is the tuning of
 * a rule, not a shape that crosses the wire.
 */
export const PAR_FACTOR: Record<LocKey, number> = { store: 1, kitchen: 0.35, rest: 0.22, coffee: 0.18, kiosk: 0.15 };

/** The same tuning read off the location itself - `locations.par_factor`, carried on the wire as
 *  `par` - so an outlet opened after release has one without a release. Absent reads as a full day. */
export const parFactor = (locations: Record<string, Location>, loc: string): number => locations[loc]?.par ?? 1;
