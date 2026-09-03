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
  },
});
