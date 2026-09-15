import { defineConfig } from "vitest/config";
// TZ=UTC like apps/api and UI: every IST-sensitive assertion in this package (id year segments,
// best-before wording, month boundaries) then proves something on every host and not only on one
// already in UTC. Phase 5 left this unpinned as "the tests are TZ-independent"; the pin removes
// the class of failure rather than the current instance of it.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: { TZ: "UTC" },
    // Almost everything here is declarative - Zod schemas, the route manifest, the fixtures -
    // so "covered" means "reached by a parse or an assertion", which is exactly what this
    // package's suites do. It measures statements 97.45, functions 66.66, lines 97.36 today.
    //
    // **`branches` is deliberately not among the thresholds.** The whole package holds two
    // branch points and neither is exercised, so the figure is 0% and any threshold on it is
    // either unmeetable or meaningless. A line threshold is the honest ratchet here: a schema
    // or a manifest entry added without a sample in `routes.test.ts` drops it. `--coverage` is
    // on the `test` script rather than `enabled` here, so a single-file run is not judged
    // against the whole package's figure.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary"],
      thresholds: { lines: 96 },
    },
  },
});
