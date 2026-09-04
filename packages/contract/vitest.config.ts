import { defineConfig } from "vitest/config";
// TZ=UTC like apps/api and UI: every IST-sensitive assertion in this package (id year segments,
// best-before wording, month boundaries) then proves something on every host and not only on one
// already in UTC. Phase 5 left this unpinned as "the tests are TZ-independent"; the pin removes
// the class of failure rather than the current instance of it.
export default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"], env: { TZ: "UTC" } } });
