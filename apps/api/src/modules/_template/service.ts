// Copy this folder to start a module.
//
// service.ts: the flow — transaction, rules, moves, history, id. Compose the helpers in
// apps/api/src/lib/ (withTransaction, allocateId, postMoves, appendHistory, assertRule,
// requireLoc); never reimplement them (spec §5.1, "Cross-cutting behaviour is a plugin or a
// helper, never copied"). Domain rules belong in packages/domain, not inlined here.
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { templateRepo } from "./repo.js";

export function createTemplateService(db: Db) {
  return {
    /** Placeholder so the template compiles and has something for _template.test.ts to call.
     *  Delete this once the module has real methods. */
    async noop(): Promise<void> {
      await withTransaction(db, (tx) => templateRepo.ping(tx));
    },
  };
}
