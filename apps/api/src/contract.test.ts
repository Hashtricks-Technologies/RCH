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
  // `bills`'s `days` has a default) - those routes can all be probed with a bare URL.
  //
  // Every permission-gated GET in the manifest is one the seeded Outlet Manager's role holds -
  // that is what lets one caller, u2, probe nearly all of them. The exceptions: a door that
  // belongs to the counter desk (`currentShift`, a counter operator's own shift) is probed as u1,
  // the seeded counter; the register's Z list, which no seeded role holds (the Z is the super
  // admin's), is probed as u7, the seeded super admin, naming the outlet it wants as it must; and
  // the `access: "admin"` routes are left out: `modules/admin/admin.test.ts` gives them the same
  // "response matches its own schema" proof against a caller its own test flags for them.
  const gets = Object.entries(routes).filter(([, r]) => r.method === "GET" && r.access !== "admin" && !r.params && (!r.query || r.query.safeParse({}).success));
  // A plain loop rather than it.each, so each route is its own named case in the report. Every
  // manifest GET is implemented as of Phase 2, so there is no skip left: a route that regresses
  // to a 404 - dropped from a module, or renamed out from under the manifest - fails here.
  for (const [name, r] of gets) {
    it(name, async () => {
      const who = r.admitAdmin ? "u7" : typeof r.access !== "string" && "desk" in r.access && !r.access.desk.includes("manager") ? "u1" : "u2";
      const headers = r.access === "public" ? {} : await authHeaders(app, who);
      const res = await app.inject({ method: "GET", url: API_PREFIX + r.path + (r.admitAdmin ? "?loc=coffee" : ""), headers });
      expect(res.statusCode, res.body).toBe(200);
      const parsed = r.response.safeParse(res.json());
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues.slice(0, 3))).toBe(true);
    });
  }
});
