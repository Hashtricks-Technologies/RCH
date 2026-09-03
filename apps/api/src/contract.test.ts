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
  const gets = Object.entries(routes).filter(([, r]) => r.method === "GET" && !r.params && !r.query);
  // Not it.each: `/me` needs a dynamic skip keyed on a probe response (Task 10 may still be a
  // stub in this worktree), and vitest's `it.each` callback does not receive a TestContext to
  // skip with. A plain loop of `it()` stays just as generic — new manifest GETs are still
  // picked up automatically — while giving each case access to `ctx.skip`.
  for (const [name, r] of gets) {
    it(name, async (ctx: TestContext) => {
      const headers = r.access === "public" ? {} : await authHeaders(app, "u2");
      const res = await app.inject({ method: "GET", url: API_PREFIX + r.path, headers });
      // /me is implemented by Task 10, which may not have merged into this worktree yet.
      ctx.skip(name === "me" && res.statusCode === 404, "/me not implemented in this worktree yet (Task 10 pending)");
      expect(res.statusCode).toBe(200);
      const parsed = r.response.safeParse(res.json());
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues.slice(0, 3))).toBe(true);
    });
  }
});
