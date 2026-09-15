// `db:generate`: drizzle-kit generate (arguments such as `--name` are forwarded to it), then strip
// the literal "public". prefix drizzle-kit writes before a type or a reference, so every audit
// migration resolves through search_path - the migrate CLI and the test harness set it to
// AUDIT_SCHEMA. One script rather than an `a && b` chain, so pnpm's trailing arguments reach
// drizzle-kit and not the strip step (apps/api/scripts/db-generate.mjs tells that story).

import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const generate = spawnSync(join(root, "node_modules", ".bin", "drizzle-kit"), ["generate", ...process.argv.slice(2)], { stdio: "inherit", cwd: root });
if (generate.status !== 0) process.exit(generate.status ?? 1);

const drizzleDir = join(root, "drizzle");
const files = (await readdir(drizzleDir)).filter((f) => f.endsWith(".sql"));
let touched = 0;
for (const file of files) {
  const path = join(drizzleDir, file);
  const original = await readFile(path, "utf8");
  const stripped = original.replaceAll('"public".', "");
  if (stripped !== original) {
    await writeFile(path, stripped);
    touched++;
  }
}
console.log(`strip-public-schema: rewrote ${touched} of ${files.length} file(s) in ${drizzleDir}`);
