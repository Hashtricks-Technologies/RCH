// `db:generate` used to be `drizzle-kit generate && node scripts/strip-public-schema.mjs`, a
// two-command chain. pnpm appends any trailing CLI args (`pnpm db:generate --name X`) to the
// LAST command in a `&&` chain, so `--name X` landed on the strip script - which ignores its
// argv - and drizzle-kit, never seeing `--name`, picked one of its own generated names instead.
// This wrapper is the one command left for pnpm's args to land on: it forwards them to
// drizzle-kit itself, then runs the strip step exactly as before.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const drizzleKit = join(here, "..", "node_modules", ".bin", "drizzle-kit");

const generate = spawnSync(drizzleKit, ["generate", ...process.argv.slice(2)], { stdio: "inherit" });
if (generate.status !== 0) process.exit(generate.status ?? 1);

const strip = spawnSync(process.execPath, [join(here, "strip-public-schema.mjs")], { stdio: "inherit" });
// `?? 1`, not `?? 0`: a null status means the strip step was killed by a signal rather than
// exiting, and reporting that as success would leave `"public".`-prefixed SQL in a migration
// nobody was told about - the one failure this wrapper exists to make visible.
process.exit(strip.status ?? 1);
