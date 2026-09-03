import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { routes } from "./routes";

/** One valid body per route that takes one. The coverage case below fails if a new route
 *  arrives without a sample, so "every body schema" stays literally every body schema. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  login: { emp: "RC-4471", password: "changeme" },
  changePassword: { current: "changeme", next: "a-much-longer-secret" },
  patchMe: { n: "Kavitha Raman" },
};
// `routes` is a const object, so `r.body` is a union of every literal schema type; the cast
// keeps this loop about the shared `safeParse` and not about zod's generics.
const withBody: Array<[string, z.ZodTypeAny]> = Object.entries(routes)
  .filter(([, r]) => r.body !== undefined)
  .map(([name, r]) => [name, r.body as z.ZodTypeAny]);

describe("request bodies", () => {
  it("every route that takes a body has a sample here", () => {
    expect(withBody.map(([n]) => n).sort()).toEqual(Object.keys(SAMPLES).sort());
  });
  for (const [name, body] of withBody) {
    it(`${name} accepts its own shape and refuses an unknown key`, () => {
      expect(body.safeParse(SAMPLES[name]).success).toBe(true);
      const bad = body.safeParse({ ...SAMPLES[name], surprise: 1 });
      expect(bad.success, `${name} silently dropped an unknown key`).toBe(false);
    });
  }
});
