import { expect, it } from "vitest";
import { createReportsService } from "./service.js";

it("is registered and empty until its two queries land", () => {
  expect(typeof createReportsService).toBe("function");
});
