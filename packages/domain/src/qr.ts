import type { OrderHoursDay, QrMode, QrOrderStatus } from "@rch/contract";
import { istDate } from "./format.js";

/**
 * QR ordering's rules: the path an order walks, when an outlet takes orders, the caps on one
 * order, and the words a customer reads. The server refuses with these and the customer's page
 * and the counter's queue draw with them.
 */

// ---- the path an order walks

const STEPS: Readonly<Record<QrMode, readonly QrOrderStatus[]>> = {
  pickup: ["Paid", "Preparing", "Ready", "Collected"],
  deliver: ["Paid", "Preparing", "Out for delivery", "Delivered"],
};

/** The statuses a paid order walks on a code of this mode, in order - the customer's stepper. */
export const qrStepsFor = (mode: QrMode): QrOrderStatus[] => [...STEPS[mode]];

/** The counter's one next step for an order at `status`, or `null` where there is none: before
 *  payment, at the end of the path, and on an order refunded, expired or voided. The status door
 *  refuses any other move with a sentence, even one `QR_ORDER_TRANSITIONS` lists - the table lets
 *  `Preparing` go to `Ready` or `Out for delivery`; the mode decides which. */
export function nextQrStep(mode: QrMode, status: QrOrderStatus): QrOrderStatus | null {
  const path = STEPS[mode];
  const i = path.indexOf(status);
  return i === -1 || i === path.length - 1 ? null : path[i + 1];
}

// ---- when an outlet takes QR orders

/** Today's window, if any, and whether an order placed now falls inside it. `why` is the sentence
 *  a customer reads when it does not. */
export type QrOpen = { open: boolean; why?: string; today: { opens: string; closes: string } | null };

const HHMM = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * Whether QR ordering is open at `now`, read on the hospital's clock whatever the host's zone. A
 * window opens at its `opens` minute and shuts at its `closes` minute (08:00-20:00 takes 19:59 and
 * refuses 20:00). A weekday with no window is closed all day - an outlet takes no QR orders until
 * the super admin sets its hours.
 */
export function qrOpenAt(days: readonly OrderHoursDay[], now: Date): QrOpen {
  // The IST calendar date, read back as a UTC midnight, gives the IST weekday.
  const dow = new Date(`${istDate(now)}T00:00:00Z`).getUTCDay();
  const day = days.find((d) => d.dow === dow);
  if (!day) return { open: false, why: "QR ordering is closed today.", today: null };
  const today = { opens: day.opens, closes: day.closes };
  const at = HHMM.format(now);
  if (at < day.opens) return { open: false, why: `QR ordering opens at ${day.opens} today.`, today };
  if (at >= day.closes) return { open: false, why: `QR ordering closed at ${day.closes} today.`, today };
  return { open: true, today };
}

/** Placing an order outside the window: the outlet, then the window's own sentence. */
export const hoursRefusal = (outlet: string, o: QrOpen): string =>
  `${outlet} is not taking QR orders right now - ${o.why ?? "QR ordering is closed."}`;
/** Placing an order while the counter has paused QR ordering. */
export const pausedRefusal = (outlet: string): string =>
  `${outlet} has paused QR orders for now - please order at the counter.`;

/**
 * A phone number the customer typed that is not one, in the customer's own voice - the till's
 * `phoneRefusal` speaks to the operator ("give the customer's 10 digits"), and this page's reader
 * is the customer. The server refuses a QR order with it and the order page checks with it.
 */
export const customerPhoneRefusal = (raw: string): string =>
  `${raw.trim() || "That"} is not a phone number - enter your 10-digit mobile number, with or without +91.`;

// ---- the caps on one order. The line and quantity caps are also `CreateQrOrderBodySchema`'s.

/** Lines on one order. */
export const QR_MAX_LINES = 30;
/** Units of one item on one order. */
export const QR_MAX_QTY = 20;
/** The most one order may come to, in rupees, unless the deployment sets its own. */
export const QR_MAX_RUPEES = 5000;
/** Unpaid orders one phone number may have open at once. */
export const QR_PENDING_PER_PHONE = 3;
/** Unpaid orders one address may have placed in the last thirty minutes. */
export const QR_PENDING_PER_IP = 5;

/** Rupees as the gateway counts them: whole paise. */
export const paise = (rupees: number): number => Math.round(rupees * 100);

// ---- the words a customer reads

/** One sentence per status, for the customer's order page. */
export const QR_STATUS_WORDS: Readonly<Record<QrOrderStatus, string>> = {
  "Awaiting payment": "Waiting for your payment to go through.",
  Paid: "Paid - the counter has your order.",
  Preparing: "Your order is being prepared.",
  Ready: "Your order is ready - collect it at the counter.",
  "Out for delivery": "Your order is on its way to you.",
  Collected: "Collected - enjoy!",
  Delivered: "Delivered - enjoy!",
  Refunded: "We couldn't fill this order, so your payment is being refunded.",
  Expired: "This order expired before it was paid.",
  Voided: "This order was cancelled and your payment is being refunded.",
};
