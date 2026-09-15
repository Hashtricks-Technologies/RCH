import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    server: "src/server.ts",
  },
  format: ["esm"],
  target: "node24",
  outExtension: () => ({ js: ".mjs" }),
  sourcemap: true,
  clean: true,
  // Workspace packages are TypeScript source; bundle them. Everything else stays external.
  noExternal: [/^@rch\//],
});
