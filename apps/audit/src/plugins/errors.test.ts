import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { buildApp, type AuditApp } from "../app.js";
import { ForbiddenError, NotFoundError, NotReadyError, UnauthenticatedError } from "../lib/errors.js";
import { testConfig } from "../test/config.js";
import type { LogStream } from "./logging.js";

const lines: Array<Record<string, unknown>> = [];
const logStream: LogStream = { write: (line) => { lines.push(JSON.parse(line) as Record<string, unknown>); } };
const accessLine = (url: string) => lines.find((l) => l.msg === "request" && l.route === url);

let app: AuditApp;
beforeAll(async () => {
  app = await buildApp(testConfig({ LOG_LEVEL: "info", AUDIT_SCHEMA: `t_audit_none_${process.pid}` }), { logStream, drainer: false });
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/t/query", { schema: { querystring: z.object({ n: z.coerce.number().int() }) } }, async (req) => ({ n: req.query.n }));
  r.get("/t/serialize", { schema: { response: { 200: z.object({ n: z.number() }) } } }, async () => ({ n: "seven" }) as unknown as { n: number });
  r.get("/t/unauthenticated", async () => { throw new UnauthenticatedError("Sign in to continue.", "no bearer token"); });
  r.get("/t/forbidden", async () => { throw new ForbiddenError("Only the super admin reads the audit log."); });
  r.get("/t/missing", async () => { throw new NotFoundError("There is no audit entry 9."); });
  r.get("/t/not-ready", async () => { throw new NotReadyError("The audit log is still starting."); });
  r.get("/t/teapot", async () => { throw Object.assign(new Error("This endpoint does not brew."), { statusCode: 418 }); });
  r.get("/t/boom", async () => { throw new Error("connect ECONNREFUSED 10.0.0.9:5432"); });
  await app.ready();
});
afterAll(async () => { await app.close(); });

describe("the error envelope", () => {
  it("answers a request that fails its schema with 400 and the details", async () => {
    const r = await app.inject({ method: "GET", url: "/t/query?n=many" });
    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toBe("The request did not match what this endpoint expects.");
    expect(body.error.details.length).toBeGreaterThan(0);
  });

  it("refuses with an AppError's sentence and logs its cause without sending it", async () => {
    const r = await app.inject({ method: "GET", url: "/t/unauthenticated" });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } });
    expect(r.body).not.toContain("no bearer token");
    await vi.waitFor(() => expect(accessLine("/t/unauthenticated")).toBeDefined());
    expect(accessLine("/t/unauthenticated")!.refusal).toEqual({ code: "unauthenticated", message: "Sign in to continue.", cause: "no bearer token" });
  });

  it("maps a ForbiddenError to 403 and a NotFoundError to 404", async () => {
    const f = await app.inject({ method: "GET", url: "/t/forbidden" });
    expect(f.statusCode).toBe(403);
    expect(f.json()).toEqual({ error: { code: "forbidden", message: "Only the super admin reads the audit log." } });
    const r = await app.inject({ method: "GET", url: "/t/missing" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: { code: "not_found", message: "There is no audit entry 9." } });
  });

  it("sends a 5xx AppError's envelope without recording it as a refusal", async () => {
    const r = await app.inject({ method: "GET", url: "/t/not-ready" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: { code: "not_ready", message: "The audit log is still starting." } });
    await vi.waitFor(() => expect(accessLine("/t/not-ready")).toBeDefined());
    expect(accessLine("/t/not-ready")!.refusal).toBeUndefined();
  });

  it("passes a framework 4xx through as a refusal", async () => {
    const r = await app.inject({ method: "GET", url: "/t/teapot" });
    expect(r.statusCode).toBe(418);
    expect(r.json()).toEqual({ error: { code: "validation", message: "This endpoint does not brew." } });
  });

  it("hides an unhandled error behind a sentence carrying the request id", async () => {
    const r = await app.inject({ method: "GET", url: "/t/boom", headers: { "x-request-id": "req-boom" } });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: { code: "internal", message: "Something went wrong on our side. Reference req-boom." } });
    expect(r.body).not.toContain("ECONNREFUSED");
  });

  it("answers a response that fails its own schema with the same 500", async () => {
    const r = await app.inject({ method: "GET", url: "/t/serialize", headers: { "x-request-id": "req-shape" } });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: { code: "internal", message: "Something went wrong on our side. Reference req-shape." } });
  });
});
