import { z } from "zod";
import { IsoTime, ItemTypeSchema, LocKeySchema, Money, Qty } from "./common.js";

/**
 * QR ordering: a customer scans a code placed at an outlet, orders from their phone, pays through
 * the gateway (Razorpay), and the outlet bills and prepares it. The public shapes here are what a
 * phone with no token reads and sends; the staff shapes are the counter's queue and the super
 * admin's codes and hours. Imports nothing but `common.ts`, so `documents.ts` can take the bill's
 * two new enums from here without a cycle.
 */

/** A code is placed where the customer collects (`pickup`) or where they are served (`deliver`,
 *  "Ward 3B waiting area") - the admin decides per code, and the order's status path follows it. */
export const QrModeSchema = z.enum(["pickup", "deliver"]);
/** An order's life. `Awaiting payment` until the gateway captures; `Paid` is the moment the bill
 *  exists. `Refunded` is a capture nobody could fulfil (sold out, closed, a price that moved);
 *  `Voided` is a paid order whose bill the manager voided. The table is `QR_ORDER_TRANSITIONS`
 *  in @rch/domain. A Postgres enum over the same words changes with this one or not at all. */
export const QrOrderStatusSchema = z.enum([
  "Awaiting payment", "Paid", "Preparing", "Ready", "Out for delivery", "Collected", "Delivered", "Refunded", "Expired", "Voided",
]);
/** A refund owed to a customer, sent to the gateway by the worker. `Failed` waits for a manager's
 *  retry, which puts it back to `Pending` (`REFUND_TRANSITIONS`). */
export const RefundStatusSchema = z.enum(["Pending", "Sent", "Processed", "Failed"]);
/** Why money goes back: a capture the outlet could not fulfil, a voided bill, or a second capture
 *  of an order already paid. */
export const RefundReasonSchema = z.enum(["unfulfillable", "void", "duplicate"]);
/** Where a bill was raised: at a till, or by a QR order's capture. */
export const BillSourceSchema = z.enum(["till", "qr"]);

/** The time of day in IST, as the hours editor and the menu's banner print it. */
const HhMmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time is HH:MM, 24-hour");
/** A code's printed token: 192 random bits, base64url. Only the shape is checked here - an unknown
 *  or inactive token is the same 404 either way. */
const QrTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
/** An order's secret: 256 random bits, base64url, handed to the phone once and stored only as a
 *  hash. The name `secret` on the wire is deliberate - the audit log masks it (`SECRET_KEYS`). */
const QrSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const ItemKeySchema = z.string().min(1).max(64);

// ---- ordering hours. One window per weekday, in IST; a day with no row takes no QR orders.

/** One weekday's window. `dow` is 0 for Sunday, as `Date.getDay` counts. */
export const OrderHoursDaySchema = z.strictObject({ dow: z.number().int().min(0).max(6), opens: HhMmSchema, closes: HhMmSchema });
/** A week's windows: at most one per weekday, each closing after it opens. A window does not
 *  cross midnight - an outlet open past it is two windows, one on each day. */
const OrderHoursDaysSchema = z.array(OrderHoursDaySchema).max(7).superRefine((days, ctx) => {
  if (new Set(days.map((d) => d.dow)).size !== days.length) ctx.addIssue({ code: "custom", message: "A weekday is listed twice" });
  for (const d of days) if (d.closes <= d.opens) ctx.addIssue({ code: "custom", message: "A window must close after it opens" });
});
export const OrderHoursSchema = z.strictObject({ loc: LocKeySchema, days: OrderHoursDaysSchema });
/** The whole week at once, like the postings list: the editor is seven rows, and it sends them all. */
export const SetOrderHoursBodySchema = z.strictObject({ days: OrderHoursDaysSchema });

// ---- the public side: what a phone with no token reads and sends.

/** One line of the menu a code opens: the outlet's till menu at the till's price, capped at MRP.
 *  `max` is how many the customer may add (the per-item cap, or fewer where fewer are on the
 *  shelf); `why` says why a line is not available. `image` is the photo's hash, as `ItemSchema.img`. */
export const PublicMenuItemSchema = z.strictObject({
  it: z.string(), name: z.string(), price: Money, mrp: Money.optional(),
  available: z.boolean(), why: z.string().optional(), max: z.number().int().min(0),
  image: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(), type: ItemTypeSchema,
});
export const PublicMenuSchema = z.strictObject({
  outlet: z.strictObject({ loc: LocKeySchema, name: z.string() }),
  qr: z.strictObject({ label: z.string(), mode: QrModeSchema }),
  /** Whether the ordering window is open right now, and today's window (null on a closed day). */
  open: z.strictObject({
    open: z.boolean(), why: z.string().optional(),
    today: z.strictObject({ opens: HhMmSchema, closes: HhMmSchema }).nullable().optional(),
  }),
  /** The counter's own switch: paused, the code takes no orders whatever the hours say. */
  paused: z.boolean(),
  items: z.array(PublicMenuItemSchema),
});

/** The customer's order. `nonce` is minted by the phone per checkout, so a double tap places one
 *  order. The phone is not shaped here: one that is not a phone is `phoneRefusal`'s sentence.
 *  `detail` is where to bring it, on a deliver code ("Bed 12"). Prices are never sent - the
 *  server quotes every line. The caps match `QR_MAX_LINES` and `QR_MAX_QTY` in @rch/domain. */
export const CreateQrOrderBodySchema = z.strictObject({
  nonce: z.uuid(),
  name: z.string().trim().min(1).max(80),
  phone: z.string().max(20),
  detail: z.string().trim().max(80).optional(),
  lines: z.array(z.strictObject({ it: ItemKeySchema, qty: z.number().int().min(1).max(20) })).min(1).max(30),
});

/** One line of an order as the customer's receipt prints it. */
export const QrOrderLineSchema = z.strictObject({ it: z.string(), name: z.string(), qty: Qty, rate: Money, amount: Money });

/** The order as its customer sees it - status and e-receipt, no phone and no staff names.
 *  `steps` is the mode's own path (`qrStepsFor`), so the stepper draws without knowing the rule. */
export const PublicQrOrderSchema = z.strictObject({
  id: z.string(), loc: LocKeySchema, outletName: z.string(), label: z.string(), mode: QrModeSchema,
  /** Where to bring it, as the customer typed it; empty on a pickup code. */
  spot: z.string(),
  status: QrOrderStatusSchema,
  lines: z.array(QrOrderLineSchema),
  total: Money, tax: Money, discount: Money,
  at: IsoTime, paidAt: IsoTime.optional(), billNo: z.string().optional(),
  refund: z.strictObject({ status: RefundStatusSchema, amount: Money }).nullable().optional(),
  steps: z.array(QrOrderStatusSchema),
});

/** What placing an order answers: the order, its secret (once, never again), and what the
 *  gateway's checkout needs - `amount` in paise, as the gateway counts. */
export const QrOrderCreatedSchema = z.strictObject({
  order: PublicQrOrderSchema,
  secret: QrSecretSchema,
  checkout: z.strictObject({
    keyId: z.string(), orderId: z.string(), amount: z.number().int().positive(), currency: z.literal("INR"),
    prefill: z.strictObject({ name: z.string(), contact: z.string() }),
  }),
});

/** The checkout's success handler, forwarded. The signature is checked against the order the
 *  server created; `secret` proves this phone placed it. */
export const VerifyQrPaymentBodySchema = z.strictObject({
  secret: QrSecretSchema,
  razorpay_order_id: z.string().min(1).max(64),
  razorpay_payment_id: z.string().min(1).max(64),
  razorpay_signature: z.string().regex(/^[0-9a-f]{64}$/),
});

export const QrTokenParamsSchema = z.strictObject({ token: QrTokenSchema });
export const QrOrderIdParamsSchema = z.strictObject({ id: z.string().min(1).max(40) });
/** The status page's read. The secret rides the query because a GET has no body; the page itself
 *  keeps it in the URL's fragment, which no server ever sees. */
export const PublicQrOrderQuerySchema = z.strictObject({ k: QrSecretSchema });

// ---- the staff side: the counter's queue and the manager's refunds.

/** A refund as the counter and the manager read it. `lastError` is the gateway's last answer
 *  where a send failed. */
export const QrRefundSchema = z.strictObject({
  id: z.string(), status: RefundStatusSchema, reason: RefundReasonSchema, amount: Money,
  attempts: z.number().int().min(0), lastError: z.string().optional(),
});
/** The order as the counter works it: the customer's name and phone, the bill it became, and the
 *  refund behind it if any. `hist` is the status trail, when the read carries it. */
export const QrOrderSchema = z.strictObject({
  id: z.string(), loc: LocKeySchema, label: z.string(), mode: QrModeSchema, spot: z.string(),
  status: QrOrderStatusSchema,
  name: z.string(), phone: z.string(),
  lines: z.array(QrOrderLineSchema),
  total: Money, tax: Money, discount: Money,
  at: IsoTime, paidAt: IsoTime.optional(), billNo: z.string().optional(),
  refund: QrRefundSchema.nullable(),
  hist: z.array(z.strictObject({ s: z.string(), who: z.string(), t: IsoTime })).optional(),
});
/** The queue, with each outlet's pause switch and ordering hours, so the counter's screen draws
 *  the switch and the window from the same read that fills it. */
export const QrOrdersResponseSchema = z.strictObject({
  orders: z.array(QrOrderSchema),
  paused: z.record(LocKeySchema, z.boolean()),
  hours: z.array(OrderHoursSchema),
});
/** The counter's next step. Which one may follow is `QR_ORDER_TRANSITIONS`, refused as a sentence. */
export const SetQrOrderStatusBodySchema = z.strictObject({ to: QrOrderStatusSchema });
export const QrPauseBodySchema = z.strictObject({ paused: z.boolean() });
export const QrPauseResultSchema = z.strictObject({ loc: LocKeySchema, paused: z.boolean() });

// ---- the super admin's codes.

/** A code as the admin page manages it. `token` is what the printed poster encodes; regenerating
 *  it (`rotatedAt`) makes every poster already printed stop working. */
export const AdminQrCodeSchema = z.strictObject({
  id: z.string(), loc: LocKeySchema, label: z.string(), mode: QrModeSchema, token: QrTokenSchema,
  active: z.boolean(), createdAt: IsoTime, rotatedAt: IsoTime.optional(),
});
export const AdminQrCodesResponseSchema = z.strictObject({ codes: z.array(AdminQrCodeSchema), hours: z.array(OrderHoursSchema) });
const qrLabel = z.string().trim().min(1).max(40);
/** No id and no token: the server numbers a code (`QR-nnn`) and draws its token. */
export const CreateQrCodeBodySchema = z.strictObject({ loc: LocKeySchema, label: qrLabel, mode: QrModeSchema });
/** Every field optional, one by one, no defaults; a patch that changes nothing is refused by the
 *  service in words, like every other PATCH. A code never moves outlet - that is a new code. */
export const UpdateQrCodeBodySchema = z.strictObject({
  label: qrLabel.optional(), mode: QrModeSchema.optional(), active: z.boolean().optional(),
});
export const QrCodeIdParamsSchema = z.strictObject({ id: z.string().min(1).max(40) });

/** The gateway's webhook is deliberately not a manifest route, the way `EVENTS_PATH` is not: it
 *  is signed by the gateway rather than by a token, and it needs the raw body to check that
 *  signature. `apps/api` registers it directly, and the URL given to the gateway is
 *  `API_PREFIX + RAZORPAY_WEBHOOK_PATH` (`/api/v1/public/razorpay/webhook`). */
export const RAZORPAY_WEBHOOK_PATH = "/public/razorpay/webhook";
