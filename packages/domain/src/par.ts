import type { Location } from "@rch/contract";

/**
 * How much of a location's average daily issue one par level covers (M11), read off the location
 * itself - `locations.par_factor`, carried on the wire as `par` - rather than out of a table
 * compiled into the code, so an outlet opened after release has a figure without a release.
 *
 * The tuning is a judgement, not an arithmetic: the central store carries a full day of cover, an
 * outlet a fraction of one, because a shop that runs out asks the store rather than the vendor.
 * It lives here rather than in the contract because it is the tuning of a rule, not a shape that
 * crosses the wire. The fallback is for a key the caller's own master does not carry at all - a
 * location dropped mid-request, a typo, a test double - not for a real row, which always has a
 * `par`; that case reads as a full day, the way `parOf` in `UI/src/lib/selectors.ts` reads it
 * against the item's own reorder level.
 */
export const parFactor = (locations: Record<string, Location>, loc: string): number => locations[loc]?.par ?? 1;
