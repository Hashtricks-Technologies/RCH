import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { createUser, deactivateUser, resetPassword } from "../lib/users-admin.js";
import type { LocKey, Role } from "@rch/contract";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { emp: { type: "string" }, name: { type: "string" }, email: { type: "string" }, role: { type: "string" }, loc: { type: "string" }, phone: { type: "string" }, password: { type: "string" } },
});
const need = (k: keyof typeof values) => { const v = values[k]; if (!v) { console.error(`--${k} is required`); process.exit(2); } return v; };
const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1 });
try {
  switch (positionals[0]) {
    case "create": {
      const { id } = await createUser(db, { emp: need("emp"), name: need("name"), email: need("email"), role: need("role") as Role, loc: need("loc") as LocKey, phone: values.phone, password: need("password") });
      console.log(`created ${id} (${values.emp}) - must change password at first sign-in`); break;
    }
    case "reset-password": await resetPassword(db, need("emp"), need("password")); console.log(`password reset for ${values.emp}; sessions revoked`); break;
    case "deactivate": await deactivateUser(db, need("emp")); console.log(`${values.emp} deactivated; sessions revoked`); break;
    default: console.error("usage: users <create|reset-password|deactivate> --emp ... [--name --email --role --loc --phone --password]"); process.exit(2);
  }
} finally { await pool.end(); }
