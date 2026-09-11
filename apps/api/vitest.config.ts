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
    // sails past Postgres's default max_connections of 100 — which surfaces as
    // `sorry, too many clients already` in whichever file happened to be unlucky, i.e. as a
    // different flake every run. Six files is at most ~30 connections, comfortably inside it,
    // and the suite is IO-bound on Postgres anyway rather than on cores.
    maxWorkers: 6,
    testTimeout: 30_000, // Argon2 in the auth suites has crossed 20 s under a full parallel gate
    hookTimeout: 60_000,
    setupFiles: ["./src/test/env.ts"],
  },
});
