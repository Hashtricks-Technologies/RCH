import { generateKeyPairSync } from "node:crypto";
import { buildApp, type App } from "../app.js";
import { loadConfig, type Config } from "../config.js";
import { withTestSchema, type TestDb } from "./db.js";

/** `buildTestApp` decorates a DB-backed app with the schema it created, so tests can seed and
 *  clean up without threading a second handle through every helper. */
declare module "fastify" { interface FastifyInstance { testDb?: TestDb } }

const b64 = (pem: string) => Buffer.from(pem).toString("base64");
const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test", PORT: "0", LOG_LEVEL: "silent",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test",
  CORS_ORIGIN: "http://localhost:5173",
  COOKIE_SECURE: "false", SEED_FORCE_PASSWORD_CHANGE: "false",
};

/** Generates a fresh Ed25519 key pair on every call unless `overrides` supplies one, so two
 *  apps built for the same test are never able to verify each other's tokens (see
 *  routes.test.ts's "rejects a token signed with a different key" case). */
export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  const needsKeys = !overrides.JWT_PRIVATE_KEY || !overrides.JWT_PUBLIC_KEY;
  const keyEnv = needsKeys ? (() => {
    const keys = generateKeyPairSync("ed25519");
    return {
      JWT_PRIVATE_KEY: b64(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
      JWT_PUBLIC_KEY: b64(keys.publicKey.export({ type: "spki", format: "pem" }).toString()),
    };
  })() : {};
  return loadConfig({ ...BASE_ENV, ...keyEnv, ...overrides });
}

/** `schema` is mandatory whenever a database is used: without a caller-chosen name, two
 *  DB-backed test files would default to the same `t_app` schema and race to drop/recreate
 *  it out from under each other when run in parallel. */
type BuildTestAppOpts =
  | { withDb: false; env?: Partial<NodeJS.ProcessEnv> }
  | { withDb?: true; schema: string; env?: Partial<NodeJS.ProcessEnv> };

/** `withDb: false` builds the app without a database (Task 4 tests). Otherwise a fresh
 *  per-file schema is created and migrated, and the app is bound to it. */
export async function buildTestApp(opts: BuildTestAppOpts): Promise<App> {
  const config = testConfig(opts.env);
  if (opts.withDb === false) return buildApp(config);
  const testDb: TestDb = await withTestSchema(opts.schema);
  const app = await buildApp(config, { db: testDb.db, migrationsSchema: testDb.schemaName });
  app.addHook("onClose", async () => { await testDb.close(); });
  return Object.assign(app, { testDb });
}
