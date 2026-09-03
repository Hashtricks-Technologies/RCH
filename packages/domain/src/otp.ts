/** Six digits quoted at handover. An operational check that the collector is
 *  the person the ticket was issued to — not a security token. */
export const makeOtp = (seed: number): string =>
  String(((seed * 7919 + 104729) % 900000) + 100000);
