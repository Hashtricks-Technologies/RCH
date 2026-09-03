import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    server: "src/server.ts",
    "cli/migrate": "src/cli/migrate.ts",
    "cli/seed": "src/cli/seed.ts",
    "cli/users": "src/cli/users.ts",
    "cli/rebuild-balances": "src/cli/rebuild-balances.ts",
    "cli/purge": "src/cli/purge.ts",
    "cli/keys": "src/cli/keys.ts",
  },
  format: ["esm"],
  target: "node24",
  outExtension: () => ({ js: ".mjs" }),
  sourcemap: true,
  clean: true,
  // Workspace packages are TypeScript source; bundle them. Everything else stays external.
  noExternal: [/^@rch\//],
});
