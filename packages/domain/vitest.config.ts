import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    // Same clock as the api and UI configs, so an IST-sensitive test proves something on every host.
    env: { TZ: "UTC" },
    include: ["src/**/*.test.ts"],
  },
});
