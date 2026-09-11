import { describe, expect, it } from "vitest";
import { seedGuard } from "./seed-guard.js";

const at = (env: string | undefined, argv: string[], dbName = "rch") => seedGuard({ env, argv, dbName });

describe("seedGuard", () => {
  it("lets a development seed through with no flags at all", () => {
    expect(at("development", [], "rch_dev")).toEqual({ ok: true });
    expect(at(undefined, ["--force"], "rch_dev")).toEqual({ ok: true });
  });

  it("refuses a production seed that names no database, and names the flag it wants", () => {
    expect(at("production", [])).toEqual({
      exit: 2,
      message: 'Refusing to seed rch: seeding rewrites every seeded account\'s password, so it needs --yes-seed rch, and you named nothing.',
    });
  });

  // The chart renders NODE_ENV=production into every pod, so --allow-production was typed on
  // every in-cluster seed and had stopped meaning anything. It is kept only to fail loudly.
  it("refuses --allow-production on its own and names the flag that replaced it", () => {
    expect(at("production", ["--allow-production"])).toEqual({
      exit: 2,
      message: "Refusing to seed rch: --allow-production is not enough on its own — the chart sets NODE_ENV=production in every pod, so pass --yes-seed rch to say which database you mean.",
    });
  });

  it("refuses a production seed that names the wrong database", () => {
    expect(at("production", ["--yes-seed", "rch_dev"])).toEqual({
      exit: 2,
      message: 'Refusing to seed rch: seeding rewrites every seeded account\'s password, so it needs --yes-seed rch, and you named "rch_dev".',
    });
  });

  it("lets a production seed through once the database is named back", () => {
    expect(at("production", ["--yes-seed", "rch"])).toEqual({ ok: true });
    expect(at("production", ["--allow-production", "--yes-seed", "rch"])).toEqual({ ok: true });
  });

  it("asks for --yes-destroy as well before --force empties the tables", () => {
    expect(at("production", ["--force", "--yes-seed", "rch"])).toEqual({
      exit: 2,
      message: "Refusing to empty rch: --force in production needs --yes-destroy rch, and you named nothing.",
    });
    expect(at("production", ["--force", "--yes-seed", "rch", "--yes-destroy", "rch_dev"])).toEqual({
      exit: 2,
      message: 'Refusing to empty rch: --force in production needs --yes-destroy rch, and you named "rch_dev".',
    });
    expect(at("production", ["--force", "--yes-seed", "rch", "--yes-destroy", "rch"])).toEqual({ ok: true });
  });

  it("reads the name that follows the flag, never argv[0], when the flag is absent", () => {
    // `indexOf` answers -1 for a missing flag; argv[argv.length] must not be read as a name.
    expect(at("production", ["rch"])).toMatchObject({ exit: 2 });
    expect(at("production", ["--yes-seed"])).toMatchObject({ exit: 2 });
  });
});
