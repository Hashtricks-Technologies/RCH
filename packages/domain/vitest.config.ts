import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    // Same clock as the api and UI configs, so an IST-sensitive test proves something on every host.
    env: { TZ: "UTC" },
    include: ["src/**/*.test.ts"],
    // These are the rules, and they are pure functions over plain data: there is no reason for
    // one to be untested, and the suite measures statements 100, branches 93.87, functions 100,
    // lines 100 today. The thresholds sit a point under that so a rule added without a case
    // beside it fails here rather than in whichever screen first calls it. `--coverage` is on
    // the `test` script rather than `enabled` here, so a single-file run is not judged against
    // the whole package's figure.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary"],
      thresholds: { lines: 99, branches: 92 },
    },
  },
});
