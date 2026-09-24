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
    // package's suites do. It measures statements 98.44, branches 85 (17 of 20), functions
    // 85.71 and lines 98.36 today (2026-09-24, with QR ordering's schemas and audit labels); the
    // line floor sits a point or so under that.
    //
    // **`branches` is deliberately not among the thresholds.** The whole package holds twenty
    // branch points, so one branch is five points and a threshold on it would be noise, not a
    // ratchet. A line threshold is the honest one here: a schema or a manifest entry added
    // without a sample in `routes.test.ts` drops it. `--coverage` is on the `test` script rather
    // than `enabled` here, so a single-file run is not judged against the whole package's figure.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary"],
      thresholds: { lines: 97 },
    },
  },
});
