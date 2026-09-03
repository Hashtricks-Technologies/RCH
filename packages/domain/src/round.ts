/** Round to three decimals — the tolerance every quantity in this system is kept at. */
export const round3 = (v: number): number => Math.round(v * 1000) / 1000;
