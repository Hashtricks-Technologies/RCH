// Availability: the flow — transaction, rules, moves, history, id. Compose the helpers in
// apps/api/src/lib/; domain rules belong in packages/domain. See modules/_template/service.ts.
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { availabilityRepo } from "./repo.js";

export function createAvailabilityService(db: Db) {
  return {
    /** Placeholder so the module compiles before Wave 3 gives it real methods. */
    async noop(): Promise<void> {
      await withTransaction(db, (tx) => availabilityRepo.ping(tx));
    },
  };
}
