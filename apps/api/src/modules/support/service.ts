// service.ts: the flow. Task 5 adds the four writes; this is the read they will all answer with.
import type { SupportTicket } from "@rch/contract";
import type { Db } from "../../db/client.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { supportRepo } from "./repo.js";

export function createSupportService(db: Db) {
  return {
    /** Spec §9.2 scopes every support write to the caller's own tickets, so the list is scoped
     *  the same way: a row nobody may act on is a row nobody should be shown. Keyed on the user
     *  id in the token, never on a display name. */
    async list(claims: AccessClaims): Promise<SupportTicket[]> {
      return supportRepo.listFor(db, claims.sub);
    },
  };
}
