// Copy this folder to start a module.
//
// <name>.test.ts: every module needs one. This template's only job is to compile and stay
// green so the API suite passes with the template in the tree; replace it with real
// endpoint tests once you copy the folder (see apps/api/src/modules/me/me.test.ts for the
// buildTestApp + seedTestDb + app.inject pattern).
import { describe, expect, it } from "vitest";
import { createTemplateService } from "./service.js";

describe("_template", () => {
  it("compiles and exports a service factory", () => {
    expect(typeof createTemplateService).toBe("function");
  });
});
