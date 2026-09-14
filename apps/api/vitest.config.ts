import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    env: { TZ: "UTC" }, // same clock as CI, so IST-sensitive tests prove something on every host
    include: ["src/**/*.test.ts"],
    fileParallelism: true,
    // Every one of the ~47 test files opens its own pg Pool of max 4 against its own schema
    // (src/test/db.ts), plus a single-connection admin pool to create and drop it. Left to
    // itself vitest runs one file per core, so a large machine puts 30+ files in flight and
    // sails past Postgres's default max_connections of 100 - which surfaces as
    // `sorry, too many clients already` in whichever file happened to be unlucky, i.e. as a
    // different flake every run. Six files is at most ~30 connections, comfortably inside it,
    // and the suite is IO-bound on Postgres anyway rather than on cores.
    maxWorkers: 6,
    testTimeout: 30_000, // Argon2 in the auth suites has crossed 20 s under a full parallel gate
    hookTimeout: 60_000,
    setupFiles: ["./src/test/env.ts"],
    // Set a point or two under what the whole suite measures today (statements 92.74, branches
    // 80.00, functions 97.04, lines 95.10): the number is not a target, it is a ratchet - a
    // deleted test or an unexercised branch of a new refusal cannot pass quietly. Raise them
    // when the real figure rises; never lower one to clear a red run.
    //
    // `enabled` is deliberately not set: `package.json`'s `test` script passes `--coverage`, so
    // `pnpm test` and CI's `turbo test` are gated while `npx vitest run src/modules/<x>` - the
    // one-module loop this package's guide documents - is not. A whole suite's threshold
    // measured against one module is a failure about nothing.
    coverage: {
      provider: "v8",
      // Named explicitly so a module with no test at all still counts against the total; left to
      // itself v8 reports only what the run loaded, and an untested file then flatters the score
      // by being absent. `src/test/**` is the harness, and `db/schema` and `drizzle` are
      // declarations rather than behaviour.
      include: ["src/**"],
      exclude: ["src/**/*.test.ts", "src/test/**", "src/db/schema/**"],
      reporter: ["text-summary"],
      thresholds: { lines: 94, branches: 79 },
    },
  },
});
