import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { createUser, deactivateUser, resetPassword, setAdmin } from "../lib/users-admin.js";
import { LocKeySchema, MIN_PASSWORD_LENGTH, RoleSchema, type LocKey, type Role } from "@rch/contract";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    emp: { type: "string" }, name: { type: "string" }, email: { type: "string" }, role: { type: "string" }, loc: { type: "string" }, phone: { type: "string" }, password: { type: "string" },
    on: { type: "boolean" }, off: { type: "boolean" },
  },
});
/** Only the string-valued options — `--on`/`--off` are booleans, read directly off `values`
 *  where `set-admin` needs them, and were never a `need("...")` shape to begin with. */
type StringOption = "emp" | "name" | "email" | "role" | "loc" | "phone" | "password";
const need = (k: StringOption): string => { const v = values[k]; if (!v) { console.error(`--${k} is required`); process.exit(2); } return v; };
const needRole = (): Role => {
  const v = need("role");
  const parsed = RoleSchema.safeParse(v);
  if (!parsed.success) { console.error(`--role must be one of ${RoleSchema.options.join("|")} (got "${v}")`); process.exit(2); }
  return parsed.data;
};
const needLoc = (): LocKey => {
  const v = need("loc");
  const parsed = LocKeySchema.safeParse(v);
  if (!parsed.success) { console.error(`--loc must be one of ${LocKeySchema.options.join("|")} (got "${v}")`); process.exit(2); }
  return parsed.data;
};
/** What `createUser` will accept, said once here so the operator reads it before the refusal
 *  rather than after: `lib/users-admin.ts`'s WORKS_AT is the rule, this is its help text. */
const PAIRINGS = "prod works at kitchen; store and buyer at store; counter and manager at one of rest|coffee|kiosk";
const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1 });
try {
  switch (positionals[0]) {
    case "create": {
      const { id } = await createUser(db, { emp: need("emp"), name: need("name"), email: need("email"), role: needRole(), loc: needLoc(), phone: values.phone, password: need("password") });
      console.log(`created ${id} (${values.emp}) - must change password at first sign-in`); break;
    }
    case "reset-password": await resetPassword(db, need("emp"), need("password")); console.log(`password reset for ${values.emp}; sessions revoked`); break;
    case "deactivate": await deactivateUser(db, need("emp")); console.log(`${values.emp} deactivated; sessions revoked`); break;
    case "set-admin": {
      if (values.on === values.off) { console.error("pass exactly one of --on or --off"); process.exit(2); }
      const emp = need("emp");
      await setAdmin(db, emp, Boolean(values.on));
      console.log(`${emp} admin flag set to ${Boolean(values.on)} — the account still signs in with its own role and location; only this flag changed`);
      break;
    }
    default:
      console.error("usage: users <create|reset-password|deactivate|set-admin> --emp ... [--name --email --role --loc --phone --password] [--on|--off]");
      console.error(`  --password  at least ${MIN_PASSWORD_LENGTH} characters (the same floor the change-password screen puts on it)`);
      console.error(`  --role/--loc  ${PAIRINGS}`);
      process.exit(2);
  }
} finally { await pool.end(); }
