import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // `generate` diffs schema.ts against drizzle/meta and never connects; the URL is only here
  // because drizzle-kit's config requires one.
  dbCredentials: { url: process.env.MIGRATE_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch" },
  strict: true,
  verbose: true,
});
