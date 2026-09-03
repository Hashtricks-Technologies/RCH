import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./test/app.js";

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp({ withDb: false }); });
afterAll(async () => { await app.close(); });

describe("plumbing", () => {
  it("answers liveness immediately", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });
  it("is not ready without a database check registered", async () => {
    const r = await app.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("not_ready");
  });
  it("returns the error envelope for an unknown route", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: { code: "not_found", message: "There is nothing at GET /api/v1/nope." } });
  });
  it("echoes a request id and generates one when absent", async () => {
    const a = await app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "abc-123" } });
    expect(a.headers["x-request-id"]).toBe("abc-123");
    const b = await app.inject({ method: "GET", url: "/healthz" });
    expect(String(b.headers["x-request-id"])).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("serves prometheus metrics", async () => {
    const r = await app.inject({ method: "GET", url: "/metrics" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("http_request_duration_seconds");
    expect(r.body).toContain("process_cpu_user_seconds_total");
  });
  it("sets security headers", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});
