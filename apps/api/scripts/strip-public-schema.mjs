// drizzle-kit always fully-qualifies CREATE TYPE/REFERENCES with the literal "public" schema.
// Strip it so migrations resolve via search_path — that's what lets each test file build its own private schema.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

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
