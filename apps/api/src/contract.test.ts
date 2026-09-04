import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX, routes } from "@rch/contract";
import { buildTestApp } from "./test/app.js";
import { seedTestDb } from "./test/seed.js";
import { authHeaders } from "./test/auth.js";
import type { App } from "./app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "contract" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("every GET in the manifest answers with a body its own schema accepts", () => {
  // No params, and either no query or a query schema that's happy with none supplied (e.g.
  // `bills`'s `days` has a default) — those routes can all be probed with a bare URL.
  const gets = Object.entries(routes).filter(([, r]) => r.method === "GET" && !r.params && (!r.query || r.query.safeParse({}).success));
  // A plain loop rather than it.each, so each route is its own named case in the report. Every
  // manifest GET is implemented as of Phase 2, so there is no skip left: a route that regresses
  // to a 404 — dropped from a module, or renamed out from under the manifest — fails here.
  for (const [name, r] of gets) {
    it(name, async () => {
      const headers = r.access === "public" ? {} : await authHeaders(app, "u2");
      const res = await app.inject({ method: "GET", url: API_PREFIX + r.path, headers });
      expect(res.statusCode, res.body).toBe(200);
      const parsed = r.response.safeParse(res.json());
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues.slice(0, 3))).toBe(true);
    });
  }
});
