import { generateKeyPairSync } from "node:crypto";
import { buildApp, type App } from "../app.js";
import { loadConfig, type Config } from "../config.js";

const keys = generateKeyPairSync("ed25519");
const b64 = (pem: string) => Buffer.from(pem).toString("base64");
const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test", PORT: "0", LOG_LEVEL: "silent",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5432/rch_test",
  CORS_ORIGIN: "http://localhost:5173",
  JWT_PRIVATE_KEY: b64(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
  JWT_PUBLIC_KEY: b64(keys.publicKey.export({ type: "spki", format: "pem" }).toString()),
  COOKIE_SECURE: "false", SEED_FORCE_PASSWORD_CHANGE: "false",
};

export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({ ...TEST_ENV, ...overrides });
}

/** `withDb: false` builds the app without a database (Task 4 tests). Task 5 adds the `withDb` path. */
export async function buildTestApp(opts: { withDb?: boolean; env?: Partial<NodeJS.ProcessEnv> } = {}): Promise<App> {
  const config = testConfig(opts.env);
  const app = await buildApp(config);
  return app;
}
