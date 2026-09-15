/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { proxy: { "/api": { target: "http://localhost:3000", changeOrigin: false } } },
  test: {
    environment: "jsdom",
    // CI runs in UTC; pin it locally too so a day-boundary test cannot pass on an IST laptop
    // and fail in CI, or the other way round.
    env: { TZ: "UTC" },
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Screen tests render whole role shells; on a busy machine (parallel API suites on the
    // same box) the default 5 s has timed out on a test that passes alone in a second.
    testTimeout: 20_000,
    // The thresholds are set a point or two **under what the whole suite measures today**
    // (statements 77.31, branches 61.55, functions 69.68, lines 80.46 once outlet management
    // landed, 2026-09-15; 74.21 / 56.26 / 65.78 / 77.52 at the close of the audit fix wave,
    // 2026-09-12; 71.07 / 52.74 / 62.37 / 74.42 before it) - the point is not to chase a number,
    // it is that deleting a test or shipping an untested screen cannot pass CI quietly. Raise
    // them when the real figure rises; never lower one to make a red run green.
    //
    // `enabled` is deliberately **not** set here: `package.json`'s `test` script passes
    // `--coverage`, so `pnpm test` and CI's `turbo test` are gated, while `npx vitest run
    // src/__tests__/<one>.test.ts` - the single-file loop this package's guide documents - is
    // not. A whole suite's threshold measured against one file is a failure about nothing.
    coverage: {
      provider: "v8",
      // Named explicitly, so a file with no test at all still counts against the total. Left to
      // itself, v8 reports only what the run happened to load, and an untested screen then
      // improves the percentage by not being there.
      include: ["src/**"],
      exclude: ["src/__tests__/**", "src/main.tsx", "src/vite-env.d.ts"],
      reporter: ["text-summary"],
      thresholds: { lines: 79, branches: 60 },
    },
  },
});
