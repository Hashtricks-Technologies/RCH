import { round3 } from "./round";

/** A receipt fills its source lines in order — deterministic and explainable
 *  when one purchase-order line funds several requisitions. */
export function apportion(recv: number, src: { qty: number }[]): number[] {
  let left = recv;
  return src.map((x) => {
    const take = round3(Math.min(Math.max(left, 0), x.qty));
    left = round3(left - take);
    return take;
  });
}
