// service.ts: the flow. A role is the super admin's: a name, the desk it works at, and what it may
// see and change. Every write is one `withTransaction` that locks the role row `FOR UPDATE`, writes
// its `auditBefore`, applies the rules, bumps `version`, writes one `admin_actions` line and
// announces `roles` - which empties every pod's permission cache (`plugins/access.ts`), so a
// change reaches the next request of everyone holding the role, not their next sign-in.
import { randomUUID } from "node:crypto";
import type { AdminRole, CreateRoleBody, Permissions, UpdateRoleBody, WriteResponse } from "@rch/contract";
import { grantRefusal } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { auditBefore } from "../../lib/audit.js";
import { isUniqueViolation, withTransaction, type Tx } from "../../lib/db.js";
import { ConflictError, NotFoundError, RuleError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { allocateId } from "../../lib/ids.js";
import { iso } from "../../lib/time.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { rolesRepo, type RoleRow } from "./repo.js";

const CHANGED = ["roles"] as const;

const toAdminRole = (r: RoleRow, holders: number): AdminRole => ({
  id: r.id, name: r.name, desk: r.desk, active: r.active, perms: r.perms as Permissions,
  holders, everAssigned: r.everAssigned, updatedAt: iso(r.updatedAt),
});

/** At most this many names in a refusal; past it, a count. The sentence is read in a toast. */
const NAMED = 5;
const nameAll = (people: ReadonlyArray<{ name: string; emp: string }>): string => {
  const named = people.slice(0, NAMED).map((p) => `${p.name} (${p.emp})`);
  const more = people.length - named.length;
  if (more > 0) return `${named.join(", ")} and ${more} more`;
  return named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : named.join("");
};

/** The same permissions, whatever order the editor listed them in: a save that only reorders
 *  changes nothing. */
const samePerms = (a: Permissions, b: Permissions): boolean => {
  const fa = Object.entries(a.f).sort(([x], [y]) => x.localeCompare(y));
  const fb = Object.entries(b.f).sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(fa) === JSON.stringify(fb) && JSON.stringify([...a.a].sort()) === JSON.stringify([...b.a].sort());
};

/** `roles_name_uq` decides; the pre-check only gives the sentence, and a save that races another
 *  past it hears the same one. */
async function refuseClash<T>(name: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (isUniqueViolation(e, "roles_name_uq")) throw new ConflictError(`Refused - a role named ${name} already exists`);
    throw e;
  }
}

/** `committed` runs once a write has committed - the local half of emptying the permission cache
 *  (the `roles` notice is the other, for every pod including this one). */
export function createRolesService(db: Db, committed: () => void) {
  const requireTx = async (tx: Tx, id: string): Promise<RoleRow> => {
    const row = await rolesRepo.forUpdate(tx, id);
    if (!row) throw new NotFoundError(`There is no role ${id}.`);
    return row;
  };
  const log = (tx: Tx, actorId: string, action: string, name: string, details: Record<string, unknown>) =>
    rolesRepo.logAction(tx, { id: randomUUID(), actorId, action, targetName: name, details });
  const refuseGrant = (desk: RoleRow["desk"], perms: Permissions) => {
    const refusal = grantRefusal(desk, perms);
    if (refusal) throw new RuleError(refusal);
  };
  const refuseTaken = async (tx: Tx, name: string, self?: string) => {
    const other = await rolesRepo.namedLike(tx, name);
    if (other && other.id !== self) throw new ConflictError(`Refused - a role named ${name} already exists`);
  };
  const after = async <T>(write: Promise<T>): Promise<T> => {
    const out = await write;
    committed();
    return out;
  };

  return {
    async list(): Promise<AdminRole[]> {
      return (await rolesRepo.list(db)).map((r) => toAdminRole(r, r.holders));
    },

    create(claims: AccessClaims, body: CreateRoleBody): Promise<WriteResponse<AdminRole>> {
      return after(withTransaction(db, async (tx) => {
        await refuseTaken(tx, body.name);
        refuseGrant(body.desk, body.perms);
        const id = await allocateId(tx, "role");
        const row = await refuseClash(body.name, () => rolesRepo.insert(tx, { id, name: body.name, desk: body.desk, perms: body.perms }));
        await log(tx, claims.sub, "role_create", body.name, { id, desk: body.desk });
        await emitChanged(tx, CHANGED);
        return { result: toAdminRole(row, 0), changed: [...CHANGED], message: `Created the role ${body.name} (${id}).` };
      }));
    },

    /**
     * A rename, a new set of permissions, or - only while nobody has ever held it - a new desk.
     * The desk is where the holders work and what their postings and shift follow, so once an
     * account has been given the role it stays; a different desk is a different role.
     */
    update(claims: AccessClaims, id: string, body: UpdateRoleBody): Promise<WriteResponse<AdminRole>> {
      return after(withTransaction(db, async (tx) => {
        const row = await requireTx(tx, id);
        const holders = await rolesRepo.holders(tx, id);
        auditBefore(toAdminRole(row, holders.length));
        const perms = row.perms as Permissions;
        const next = { name: body.name ?? row.name, desk: body.desk ?? row.desk, perms: body.perms ?? perms };
        const renamed = next.name !== row.name;
        const moved = next.desk !== row.desk;
        const regranted = !samePerms(next.perms, perms);
        if (!renamed && !moved && !regranted) throw new RuleError(`Nothing to save - ${row.name} already reads that way`);
        if (moved && row.everAssigned) throw new RuleError(`Refused - ${row.name} has been given to staff, so its desk can no longer change. Create a new role for the other desk instead.`);
        if (renamed) await refuseTaken(tx, next.name, id);
        refuseGrant(next.desk, next.perms);
        const fresh = await refuseClash(next.name, () => rolesRepo.update(tx, id, { name: next.name, desk: next.desk, perms: next.perms }));
        if (renamed) await rolesRepo.relabel(tx, id, next.name);
        await log(tx, claims.sub, "role_update", next.name, {
          id, ...(renamed ? { name: [row.name, next.name] } : {}), ...(moved ? { desk: [row.desk, next.desk] } : {}), ...(regranted ? { perms: true } : {}),
        });
        await emitChanged(tx, CHANGED);
        const reach = regranted && holders.length > 0 ? ` It takes effect for ${holders.length === 1 ? "its 1 holder" : `its ${holders.length} holders`} straight away.` : "";
        return { result: toAdminRole(fresh, holders.length), changed: [...CHANGED], message: `Saved ${next.name}.${reach}` };
      }));
    },

    /** Refused while anybody active holds it, naming them: switching a role off under somebody
     *  would leave them signed in to nothing. Move them to another role first. */
    deactivate(claims: AccessClaims, id: string): Promise<WriteResponse<AdminRole>> {
      return after(withTransaction(db, async (tx) => {
        const row = await requireTx(tx, id);
        const holders = await rolesRepo.holders(tx, id);
        auditBefore(toAdminRole(row, holders.length));
        if (!row.active) throw new RuleError(`${row.name} is already deactivated`);
        if (holders.length > 0) throw new RuleError(`Refused - ${row.name} is still held by ${nameAll(holders)}. Move ${holders.length === 1 ? "them" : "each of them"} to another role first.`);
        const fresh = await rolesRepo.update(tx, id, { active: false });
        await log(tx, claims.sub, "role_deactivate", row.name, { id });
        await emitChanged(tx, CHANGED);
        return { result: toAdminRole(fresh, 0), changed: [...CHANGED], message: `Deactivated ${row.name} - it can no longer be given to anybody.` };
      }));
    },

    reactivate(claims: AccessClaims, id: string): Promise<WriteResponse<AdminRole>> {
      return after(withTransaction(db, async (tx) => {
        const row = await requireTx(tx, id);
        const holders = await rolesRepo.holders(tx, id);
        auditBefore(toAdminRole(row, holders.length));
        if (row.active) throw new RuleError(`${row.name} is already active`);
        const fresh = await rolesRepo.update(tx, id, { active: true });
        await log(tx, claims.sub, "role_reactivate", row.name, { id });
        await emitChanged(tx, CHANGED);
        return { result: toAdminRole(fresh, holders.length), changed: [...CHANGED], message: `Reactivated ${row.name}.` };
      }));
    },

    /** Only a role nobody was ever given: an account's history names the role it worked under,
     *  so one that has been held can only be deactivated. */
    remove(claims: AccessClaims, id: string): Promise<WriteResponse<AdminRole>> {
      return after(withTransaction(db, async (tx) => {
        const row = await requireTx(tx, id);
        auditBefore(toAdminRole(row, 0));
        if (row.everAssigned) throw new RuleError(`Refused - ${row.name} has been given to staff, so it can only be deactivated, never deleted`);
        await rolesRepo.remove(tx, id);
        await log(tx, claims.sub, "role_delete", row.name, { id, desk: row.desk });
        await emitChanged(tx, CHANGED);
        return { result: toAdminRole(row, 0), changed: [...CHANGED], message: `Deleted the role ${row.name}.` };
      }));
    },
  };
}
