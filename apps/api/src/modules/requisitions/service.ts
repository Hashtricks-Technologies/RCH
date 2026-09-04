// Requisitions: the flow — transaction, rules, ids, history. Composes the helpers in
// apps/api/src/lib/; the arithmetic of a decision is `planPrqApproval` in packages/domain.
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { requisitionsRepo } from "./repo.js";

export function createRequisitionsService(db: Db) {
  return {
    /** Placeholder so the skeleton compiles and has something for its test to call. */
    async noop(): Promise<void> {
      await withTransaction(db, (tx) => requisitionsRepo.ping(tx));
    },
  };
}
