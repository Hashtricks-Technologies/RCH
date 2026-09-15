import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    env: { TZ: "UTC" }, // same clock as CI, so the IST day bounds of the read routes prove something on every host
    include: ["src/**/*.test.ts"],
    fileParallelism: true,
    // Each file opens a pool of at most 4 against its own schema pair (src/test/db.ts) plus a
    // one-connection admin pool, and the drainer tests add a LISTEN client. Four files at once
    // is ~25 connections, which leaves apps/api's six files room under Postgres's default 100
    // when turbo runs both suites together.
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    setupFiles: ["./src/test/env.ts"],
    // `enabled` is not set: `package.json`'s `test` passes `--coverage`, so `pnpm test` and CI are
    // gated while a one-file `vitest run` is not. The floor starts at the target the spec sets
    // (lines 90 / branches 75); Task 20 sets it to the measured figures. Raise it when the real
    // figure rises; never lower it to clear a red run.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // `src/test/**` is the harness and `db/schema.ts` a declaration. `server.ts` and `cli/**`
      // are the process entry points: a few lines of wiring over `app.ts` and `lib/`, which the
      // tests call directly, and which the image's kind install exercises for real.
      exclude: ["src/**/*.test.ts", "src/test/**", "src/db/schema.ts", "src/server.ts", "src/cli/**"],
      reporter: ["text-summary"],
      thresholds: { lines: 90, branches: 75 },
    },
  },
});
