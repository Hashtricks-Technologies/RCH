import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    env: { TZ: "UTC" }, // same clock as CI, so IST-sensitive tests prove something on every host
    include: ["src/**/*.test.ts"],
    fileParallelism: true,
    testTimeout: 30_000, // Argon2 in the auth suites has crossed 20 s under a full parallel gate
    hookTimeout: 60_000,
    setupFiles: ["./src/test/env.ts"],
  },
});
