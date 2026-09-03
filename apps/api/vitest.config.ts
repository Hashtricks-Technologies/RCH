import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    env: { TZ: "UTC" }, // same clock as CI, so IST-sensitive tests prove something on every host
    include: ["src/**/*.test.ts"],
    fileParallelism: true,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    setupFiles: ["./src/test/env.ts"],
  },
});
