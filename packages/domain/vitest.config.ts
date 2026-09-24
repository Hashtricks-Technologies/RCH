import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    // Same clock as the api and UI configs, so an IST-sensitive test proves something on every host.
    env: { TZ: "UTC" },
    include: ["src/**/*.test.ts"],
    // These are the rules, and they are pure functions over plain data: there is no reason for
    // one to be untested, and the suite measures statements 99.78, branches 96.86, functions 100,
    // lines 99.72 today (configurable roles, 2026-09-24). The line floor sits a point under that; the branch floor sits a few
    // points under it on purpose - room for a rule added without a case beside it to still pass
    // here, rather than turn a change unrelated to it red. `--coverage` is on the `test` script
    // rather than `enabled` here, so a single-file run is not judged against the whole package's
    // figure.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary"],
      thresholds: { lines: 99, branches: 94 },
    },
  },
});
