import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineRoute, routes } from "@rch/contract";
import { buildTestApp } from "./test/app.js";
import { seedTestDb } from "./test/seed.js";
import { authHeaders } from "./test/auth.js";
import { mount } from "./routes.js";
import type { App } from "./app.js";

let app: App;
beforeAll(async () => {
  app = await buildTestApp({ schema: "routes" });
  await seedTestDb(app.testDb!.db);
  mount(app, defineRoute({ method: "GET", path: "/_test/any", access: "any", response: z.object({ who: z.string() }) }), async (req) => ({ who: req.user.sub }));
  mount(app, defineRoute({ method: "GET", path: "/_test/buyer", access: ["buyer"], response: z.object({ ok: z.literal(true) }) }), async () => ({ ok: true as const }));
  mount(app, defineRoute({ method: "GET", path: "/_test/public", access: "public", response: z.object({ ok: z.literal(true) }) }), async () => ({ ok: true as const }));
  await app.ready();
});
afterAll(async () => { await app.close(); });

describe("manifest", () => {
  it("has unique method+path pairs and API_PREFIX-relative paths", () => {
    const seen = new Set<string>();
    for (const r of Object.values(routes)) { const k = `${r.method} ${r.path}`; expect(seen.has(k), k).toBe(false); seen.add(k); expect(r.path.startsWith("/")).toBe(true); }
  });
});
describe("mount", () => {
  it("public routes need no token", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/_test/public" })).statusCode).toBe(200);
  });
  it("'any' routes need a valid token and expose the caller", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/_test/any" })).statusCode).toBe(401);
    const r = await app.inject({ method: "GET", url: "/api/v1/_test/any", headers: await authHeaders(app, "u1") });
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ who: "u1" });
  });
  it("role-scoped routes are 404 for other roles - the module is absent, like the sidebar", async () => {
    const counter = await app.inject({ method: "GET", url: "/api/v1/_test/buyer", headers: await authHeaders(app, "u1") });
    expect(counter.statusCode).toBe(404); expect(counter.json().error.code).toBe("not_found");
    const buyer = await app.inject({ method: "GET", url: "/api/v1/_test/buyer", headers: await authHeaders(app, "u5") });
    expect(buyer.statusCode).toBe(200);
  });
  it("rejects a token signed with a different key", async () => {
    const other = await buildTestApp({ withDb: false });
    const token = await other.signAccess({ id: "u1", role: "counter", loc: "coffee", mcp: false });
    await other.close();
    const r = await app.inject({ method: "GET", url: "/api/v1/_test/any", headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(401);
  });
});
