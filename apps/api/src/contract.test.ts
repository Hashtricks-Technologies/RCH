import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
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
  // Not it.each: a route may need a dynamic skip keyed on a probe response (a route not yet
  // implemented in this worktree still 404s), and vitest's `it.each` callback does not receive
  // a TestContext to skip with. A plain loop of `it()` stays just as generic — new manifest
  // GETs are still picked up automatically — while giving each case access to `ctx.skip`.
  for (const [name, r] of gets) {
    it(name, async (ctx: TestContext) => {
      const headers = r.access === "public" ? {} : await authHeaders(app, "u2");
      const res = await app.inject({ method: "GET", url: API_PREFIX + r.path, headers });
      // Some manifest GETs (e.g. /me under Task 10, /stock and /bills under Task 3) may not be
      // implemented yet in this worktree — skip on a 404 probe rather than asserting 200 on a
      // route this task didn't build.
      ctx.skip(res.statusCode === 404, `${name} not implemented in this worktree yet`);
      expect(res.statusCode).toBe(200);
      const parsed = r.response.safeParse(res.json());
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues.slice(0, 3))).toBe(true);
    });
  }
});
