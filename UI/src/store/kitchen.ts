// The kitchen's raw materials and packaging. They are not stocked there - what lands is used on
// landing - so the kitchen reads what it was issued, and what it threw away, instead of a shelf.
//
// The report is kept, like the shifts: the Kitchen Stock screen reads it for the window it shows
// (today, a week, a month) and reads it again when a `wastage` notice arrives or the kitchen's
// stock moves. A failed read sets `kitchenReportFailed`, so the screen says "could not be read"
// rather than "nothing issued".
import { routes } from "@rch/contract";
import { ApiError, call } from "../api/client";
import { refetch } from "../api/refetch";
import type { KitchenReport, WastageReason } from "../types";
import type { AppState } from "./index";

type Get = () => AppState;
type SetState = (fn: (s: AppState) => Partial<AppState>) => void;

export interface KitchenSlice {
  kitchenReport: KitchenReport | null;
  kitchenReportFailed: boolean;
  /** The window the report was last read for, in days - what a notice reads it again for. */
  kitchenDays: number;
  loadKitchenReport: (days?: number) => Promise<boolean>;
  /** Form-carrying: `true` only once the server has taken the record, so a refusal keeps what was typed. */
  recordWastage: (body: { it: string; qty: number; reason: WastageReason; note: string }) => Promise<boolean>;
}

export const createKitchenSlice = (set: SetState, get: Get): KitchenSlice => ({
  kitchenReport: null,
  kitchenReportFailed: false,
  kitchenDays: 1,

  loadKitchenReport: async (days) => {
    const want = days ?? get().kitchenDays;
    set(() => ({ kitchenDays: want }));
    try {
      const r = await call(routes.kitchenReport, { query: { days: want } });
      // A slower read for a window the screen has since moved off must not overwrite the newer one.
      if (get().kitchenDays === want) set(() => ({ kitchenReport: r, kitchenReportFailed: false }));
      return true;
    } catch {
      set(() => ({ kitchenReportFailed: true }));
      return false;
    }
  },

  recordWastage: async ({ it, qty, reason, note }) => {
    try {
      const r = await call(routes.createWastage, { body: { it, qty, reason, note: note.trim() } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not record the wastage - check the connection and try again.");
      return false;
    }
  },
});
