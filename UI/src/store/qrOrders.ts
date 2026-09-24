// QR orders: the counter's queue of orders a customer placed and paid for from their phone.
//
// The bill already exists by the time an order reaches the queue - the gateway's capture raised
// it - so what the counter does here is walk the order along its path (`nextQrStep` in
// @rch/domain), and pause QR ordering at its outlet. The list is kept, like the shifts: the bell
// counts it and the QR orders screen draws it, and a `qrOrders` notice pulls it back live for
// whoever holds QR orders. The instants stay as sent (`at`, `paidAt`); the screen prints them
// with `fromWireTime` and sorts on them.
import { routes } from "@rch/contract";
import { ApiError, call } from "../api/client";
import { refetch } from "../api/refetch";
import type { LocKey, OrderHours, QrOrder, QrOrderStatus } from "../types";
import type { AppState } from "./index";

type Get = () => AppState;
type SetState = (fn: (s: AppState) => Partial<AppState>) => void;

export interface QrOrdersSlice {
  /** Every order the server lets this session read - the counter's own outlet, or every outlet
   *  for a role that reads wide. Empty until loaded. */
  qrOrders: QrOrder[];
  /** Each outlet's pause switch, as the same read answered it. */
  qrPaused: Record<LocKey, boolean>;
  /** Each outlet's ordering hours, for the screen's "open until" line. */
  qrHours: OrderHours[];
  /** Whether the last load failed, so the screen shows an outage line instead of "no orders". */
  qrOrdersFailed: boolean;
  loadQrOrders: () => Promise<boolean>;
  /** One step along the order's path. A single press with no form: the server's sentence is the
   *  whole answer either way. */
  setQrOrderStatus: (id: string, to: QrOrderStatus) => Promise<boolean>;
  /** The counter's switch: paused, the outlet's codes take no orders whatever the hours say. */
  setQrPause: (loc: LocKey, paused: boolean) => Promise<boolean>;
  /** Send a Failed refund to the gateway again - the manager's door, under Void bill. */
  retryQrRefund: (id: string) => Promise<boolean>;
}

export const createQrOrdersSlice = (set: SetState, get: Get): QrOrdersSlice => {
  /** The ordinary write: the server's sentence, then read back what it says changed. */
  const write = async (send: () => Promise<{ changed: Parameters<typeof refetch>[0]; message: string }>, offline: string) => {
    try {
      const r = await send();
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : offline);
      return false;
    }
  };
  return {
    qrOrders: [],
    qrPaused: {},
    qrHours: [],
    qrOrdersFailed: false,

    loadQrOrders: async () => {
      try {
        const r = await call(routes.qrOrders);
        set(() => ({ qrOrders: r.orders, qrPaused: r.paused, qrHours: r.hours, qrOrdersFailed: false }));
        return true;
      } catch {
        set(() => ({ qrOrdersFailed: true }));
        return false;
      }
    },

    setQrOrderStatus: (id, to) => write(
      () => call(routes.setQrOrderStatus, { params: { id }, body: { to } }),
      "Could not move the QR order on - check the connection and try again.",
    ),
    setQrPause: (loc, paused) => write(
      () => call(routes.setQrPause, { params: { loc }, body: { paused } }),
      `Could not ${paused ? "pause" : "resume"} QR ordering - check the connection and try again.`,
    ),
    retryQrRefund: (id) => write(
      () => call(routes.retryQrRefund, { params: { id } }),
      "Could not retry the refund - check the connection and try again.",
    ),
  };
};
