import { parseArgs } from "node:util";
import { cliDatabaseUrl, loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { createUser, deactivateUser, resetPassword, setAdmin, type RolePick } from "../lib/users-admin.js";
import { LocKeySchema, MIN_PASSWORD_LENGTH, RoleSchema, type LocKey, type Role } from "@rch/contract";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    emp: { type: "string" }, name: { type: "string" }, email: { type: "string" }, role: { type: "string" }, "role-id": { type: "string" }, loc: { type: "string" }, phone: { type: "string" }, password: { type: "string" },
    on: { type: "boolean" }, off: { type: "boolean" },
  },
});
/** Only the string-valued options - `--on`/`--off` are booleans, read directly off `values`
 *  where `set-admin` needs them, and were never a `need("...")` shape to begin with. */
type StringOption = "emp" | "name" | "email" | "role" | "role-id" | "loc" | "phone" | "password";
const need = (k: StringOption): string => { const v = values[k]; if (!v) { console.error(`--${k} is required`); process.exit(2); } return v; };
const needRole = (): Role => {
  const v = need("role");
  const parsed = RoleSchema.safeParse(v);
  if (!parsed.success) { console.error(`--role must be one of ${RoleSchema.options.join("|")} (got "${v}")`); process.exit(2); }
  return parsed.data;
};
/** `--role-id ROLE-006` gives the account that role; `--role counter` gives it the lowest-numbered
 *  active role on that desk - on an untouched hospital, the desk's own seeded role. */
const needRolePick = (): RolePick => {
  const id = values["role-id"];
  if (id && values.role) { console.error("pass --role or --role-id, not both"); process.exit(2); }
  return id ? { roleId: id } : { role: needRole() };
};
const needLoc = (): LocKey => {
  const v = need("loc");
  const parsed = LocKeySchema.safeParse(v);
  if (!parsed.success) { console.error(`--loc must be a location key - store, kitchen or an outlet's key (got "${v}")`); process.exit(2); }
  return parsed.data;
};
/** What `createUser` will accept, said once here so the operator reads it before the refusal
 *  rather than after: `worksAt` in @rch/domain is the rule, this is its help text. */
const PAIRINGS = "prod works at kitchen; store and buyer at store; counter and manager at an open outlet, by its key (e.g. rest)";
const config = loadConfig(process.env);
const { db, pool } = createDb(cliDatabaseUrl(config), config.databaseSsl, { max: 1 });
try {
  switch (positionals[0]) {
    case "create": {
      // `--emp` is optional: left out, the account gets the next employee number, the same one
      // the admin page would have given it.
      const { id, emp } = await createUser(db, { emp: values.emp, name: need("name"), email: need("email"), ...needRolePick(), loc: needLoc(), phone: values.phone, password: need("password") });
      console.log(`created ${id} (${emp}) - must change password at first sign-in`); break;
    }
    case "reset-password": await resetPassword(db, need("emp"), need("password")); console.log(`password reset for ${values.emp}; sessions revoked`); break;
    case "deactivate": await deactivateUser(db, need("emp")); console.log(`${values.emp} deactivated; sessions revoked`); break;
    case "set-admin": {
      if (values.on === values.off) { console.error("pass exactly one of --on or --off"); process.exit(2); }
      const emp = need("emp");
      await setAdmin(db, emp, Boolean(values.on));
      console.log(values.on
        ? `${emp} is now a super admin - it signs in to account management only, and no longer reaches its role's screens or routes`
        : `${emp} is no longer a super admin - it signs in with its own role and location again`);
      break;
    }
    default:
      console.error("usage: users <create|reset-password|deactivate|set-admin> --emp ... [--name --email --role|--role-id --loc --phone --password] [--on|--off]");
      console.error("  create      --emp is optional; left out, the next employee number is assigned (RC-0001 → RC-0002)");
      console.error(`  --password  at least ${MIN_PASSWORD_LENGTH} characters (the same floor the change-password screen puts on it)`);
      console.error(`  --role/--loc  ${PAIRINGS}`);
      console.error("  --role-id   a role by its id (ROLE-006) instead of --role, which takes the desk's first active role");
      process.exit(2);
  }
} finally { await pool.end(); }
