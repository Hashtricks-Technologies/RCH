import type { Tone } from "../../types";

/** How a bill reads on the counter's own list, derived from the tender it was settled with. */
export const billStatus = (pay: string): { label: string; tone: Tone } => {
  if (pay === "Patient bill") return { label: "Posted to IP", tone: "in" };
  if (pay === "Staff credit") return { label: "On credit", tone: "wn" };
  if (pay === "Dept") return { label: "Dept charge", tone: "ac" };
  return { label: "Paid", tone: "ok" };
};
