import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, withoutSslParams } from "./client.js";

describe("withoutSslParams", () => {
  it("drops the ssl parameters and keeps the rest", () => {
    expect(withoutSslParams("postgres://u:p@h:5432/d?sslmode=require&application_name=rch")).toBe(
      "postgres://u:p@h:5432/d?application_name=rch",
    );
    expect(withoutSslParams("postgres://u:p@h:5432/d")).toBe("postgres://u:p@h:5432/d");
  });

  it("leaves the bundle in charge when the URL carries sslmode", () => {
    // pgSsl reads the bundle from PG_CA_BUNDLE at call time; a stand-in file is enough here —
    // the point is that the object built from it survives a URL that says sslmode=require.
    const bundle = join(mkdtempSync(join(tmpdir(), "rch-ca-")), "bundle.pem");
    writeFileSync(bundle, "-----BEGIN CERTIFICATE-----\nstand-in\n-----END CERTIFICATE-----\n");
    process.env.PG_CA_BUNDLE = bundle;
    try {
      const { pool } = createDb("postgres://u:p@h:5432/d?sslmode=require", true, { max: 1 });
      const ssl = pool.options.ssl as { rejectUnauthorized: boolean; ca: string };
      expect(ssl.rejectUnauthorized).toBe(true);
      expect(ssl.ca).toContain("BEGIN CERTIFICATE");
      expect(pool.options.connectionString).not.toContain("sslmode");
    } finally {
      delete process.env.PG_CA_BUNDLE;
    }
  });
});
