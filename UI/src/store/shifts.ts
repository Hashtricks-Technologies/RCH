// Shifts: a counter operator's stint at one counter, opened by their sign-in there.
//
// The live report is read, not kept - like an X it is a figure of this instant, and the Close
// Shift dialog reads it as it opens. The closed shifts are kept, for the manager: the bell and
// the Register screen's Shift reports card both read them, and a `shifts` notice from any counter
// that closes one pulls the list back live.
import { routes } from "@rch/contract";
import { ApiError, call } from "../api/client";
import { refetch } from "../api/refetch";
import type { ShiftReport } from "../types";
import type { AppState } from "./index";

type Get = () => AppState;
type SetState = (fn: (s: AppState) => Partial<AppState>) => void;

export interface ShiftsSlice {
  /** Closed shifts, newest first - the manager's, every outlet's. Empty until loaded. */
  shifts: ShiftReport[];
  /** Whether the last load failed, so the card shows an outage line instead of "no shift closed". */
  shiftsFailed: boolean;
  loadShifts: () => Promise<boolean>;
  /** `{ shift: null }` is "no shift open on this session"; `null` is "could not be read". */
  readCurrentShift: () => Promise<{ shift: ShiftReport | null } | null>;
  /** The closed shift as stored, or `null` on a refusal (already toasted). */
  closeShift: () => Promise<ShiftReport | null>;
}

export const createShiftsSlice = (set: SetState, get: Get): ShiftsSlice => ({
  shifts: [],
  shiftsFailed: false,

  loadShifts: async () => {
    try {
      const rows = await call(routes.shifts, { query: {} });
      set(() => ({ shifts: rows, shiftsFailed: false }));
      return true;
    } catch {
      set(() => ({ shiftsFailed: true }));
      return false;
    }
  },

  readCurrentShift: async () => {
    try { return await call(routes.currentShift); }
    catch { return null; }
  },

  closeShift: async () => {
    try {
      const r = await call(routes.closeShift);
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return r.result;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not close the shift - check the connection and try again.");
      return null;
    }
  },
});
