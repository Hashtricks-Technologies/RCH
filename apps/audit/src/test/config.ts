import { generateKeyPairSync } from "node:crypto";
import { loadConfig, type AuditConfig } from "../config.js";

const b64 = (pem: string) => Buffer.from(pem).toString("base64");

/** A fresh Ed25519 pair in the shapes the API's `keys:generate` prints: the private key as PEM,
 *  to sign test tokens with, and the public key base64-encoded, for JWT_PUBLIC_KEY. */
export function testKeyPair(): { privateKeyPem: string; publicKeyB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyB64: b64(publicKey.export({ type: "spki", format: "pem" }).toString()),
  };
}

/** A valid test environment with `overrides` on top. A fresh public key unless one is given. */
export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): AuditConfig {
  return loadConfig({
    NODE_ENV: "test", PORT: "0", LOG_LEVEL: "silent",
    AUDIT_DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test",
    JWT_PUBLIC_KEY: overrides.JWT_PUBLIC_KEY ?? testKeyPair().publicKeyB64,
    ...overrides,
  });
}
