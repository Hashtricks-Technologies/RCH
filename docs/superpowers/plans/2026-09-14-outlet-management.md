# Outlet Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The super admin can open, view, edit, close and reopen retail outlets from an Outlets tab on `/admin`, and
every operational rule and screen reads outlets from the database instead of three keys compiled into the code.

**Architecture:**
- **Location keys become checked strings.** `LocKeySchema` changes from a five-member enum to a regex.
- **Readers move off the constants first.** The server and the browser each stop reading `OUTLETS` / `ALL_LOCS`
  / `PAR_FACTOR` and read the `locations` table (server) or the `LOC` registry (browser) through pure functions
  in `@rch/domain`. Only then are the constants deleted.
- **One lock helper guards the writes.** `lib/locations.ts` locks the location row `FOR SHARE` and refuses a
  closed outlet. The admin close takes the same row `FOR UPDATE`, so a sale and a close never interleave.

**Tech Stack:** pnpm 10 + Turborepo, Node 24, Zod 4, Fastify 5 + Drizzle 0.45 on PostgreSQL 17, React 19 +
Zustand 5, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-09-14-outlet-management-design.md`. Read it before any task.

## Global Constraints

- **Worktree:** `W=/Users/srimanikandanr/.superset/worktrees/RCH-outlets`, branch `feature/outlets`.
  - Never `cd`. Use `pnpm --filter <pkg>` from `$W` via `pnpm -C $W …`, or absolute paths.
  - Never commit or push from `/Users/srimanikandanr/.superset/projects/RCH`, which is the shared tree. Never
    push at all.
- **Test database:** your own Postgres on host port **5440**. Every `@rch/api` test command runs with
  `TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test`. Port 5439 belongs to other sessions.
- **Location key regexes:**
  - `LocKeySchema` is `^(?!quarantine$)[a-z][a-z0-9-]{0,23}$`.
  - `StockLocSchema` is `^[a-z][a-z0-9-]{0,23}$`.
- **Closed outlet refusal:** `Refused - <name> is closed`. The void variant appends
  `; reopen it before voiding its bills`.
- **Outlet ordering everywhere:** by name (`localeCompare`), then by key.
- **Lock order stays documents → ids → balances.** The location row lock is in the documents tier: take it before
  `allocateId` / `allocateTicket` / `lockBalances`.
- **Lint and knip are zero-warning.** An export nobody imports fails knip at the final gate.
- **Coverage floors are never lowered:** UI lines 73 / branches 51, `apps/api` 94 / 79, `packages/domain`
  99 / 92, `packages/contract` lines 96.
- **TypeScript:** `strict` + `verbatimModuleSyntax`, so type-only imports use `import type`.
- **Comments:** match the surrounding density. These files explain *why* in prose. Never mention "Task N" or
  "the plan" in code or comments.
- **Toast and refusal copy** is exactly the sentences in this plan.
- **Every commit message ends with these trailers:**
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FmSadpAt28HysLFwj5KRjk
  ```
- **Timing:** the API suite is slow. Inside a task, run the files you touched. Run the whole package suite
  (`pnpm -C $W --filter @rch/api test`) at the end of each API task.

---

### Task 1: Location keys become data

**Files:**
- Modify: `packages/contract/src/schemas/common.ts`
- Modify: `packages/contract/src/schemas/documents.ts` (`LocationSchema`)
- Modify: `packages/contract/src/schemas/snapshot.ts` (`byLoc`, `byStockLoc`)
- Modify: `packages/contract/src/schemas/writes.ts` (`CollectionSchema`)
- Modify: `packages/contract/src/types.ts` (the `StockLoc` doc comment)
- Modify: `packages/contract/src/fixtures/master.ts` (`LOC`)
- Modify: `packages/contract/src/routes.test.ts`
- Create: `packages/domain/src/locations.ts`, `packages/domain/src/locations.test.ts`
- Modify: `packages/domain/src/par.ts`, `packages/domain/src/par.test.ts`, `packages/domain/src/index.ts`
- Modify: `UI/src/api/wire.ts`, `UI/src/store/index.ts`, `UI/src/roles/store/Adjustments.tsx`
- Modify: `apps/api/src/cli/users.ts`

**Interfaces:**
- **Consumes:** nothing new.
- **Produces:**
  - From `@rch/contract`:
    - `STORE: "store"`, `KITCHEN: "kitchen"` (beside the existing `QUARANTINE`).
    - `LocKeySchema` and `StockLocSchema` as regex string schemas. `LocKey` and `StockLoc` are `string`.
    - `Location` gains `active?: boolean` and `par?: number`.
    - `Changed` gains `"locations"` and `"outlets"`.
  - From `@rch/domain`:
    - `outletKeys(locations: Record<string, Pick<Location, "n" | "type" | "active">>, opts?: { open?: boolean }): string[]` (same `locations` type for the next three)
    - `operationalKeys(locations: Record<string, Location>): string[]`
    - `worksAt(role: Role, key: string, location: Location | undefined): boolean`
    - `placesFor(role: Role, locations: Record<string, Location>): string[]`
    - `outletKeyFor(name: string, taken: Iterable<string>): string`
    - `parFactor(locations: Record<string, Location>, loc: string): number`
  - `ALL_LOCS`, `OUTLETS` and `PAR_FACTOR` stay exported as literal constants. Task 10 deletes them.

- [ ] **Step 1: Set up the worktree database and dependencies**

```bash
docker run -d --name rch-outlets-pg -e POSTGRES_USER=rch -e POSTGRES_PASSWORD=rch -e POSTGRES_DB=rch_test -p 5440:5432 postgres:17
pnpm -C /Users/srimanikandanr/.superset/worktrees/RCH-outlets install --frozen-lockfile
```

Expected: the container is up, and install finishes with no lockfile changes. If `rch-outlets-pg` already exists,
run `docker start rch-outlets-pg` instead.

- [ ] **Step 2: Write the failing contract tests**

In `packages/contract/src/routes.test.ts`, find the test near line 137 that asserts quarantine is in
`StockLocSchema.options` but not in `LocKeySchema.options`. `.options` will no longer exist, so replace that test
with this block, importing `LocKeySchema`, `StockLocSchema`, `QUARANTINE`, `STORE`, `KITCHEN` and
`SnapshotSchema` from the package's own sources the way the file already imports:

```ts
describe("location keys", () => {
  it("accepts a key the server minted for an outlet opened after release", () => {
    expect(LocKeySchema.safeParse("juice-bar").success).toBe(true);
    expect(StockLocSchema.safeParse("juice-bar-2").success).toBe(true);
    expect(LocKeySchema.safeParse(STORE).success).toBe(true);
    expect(LocKeySchema.safeParse(KITCHEN).success).toBe(true);
  });
  it("refuses quarantine as a place an operator acts, while still reporting stock there", () => {
    expect(LocKeySchema.safeParse(QUARANTINE).success).toBe(false);
    expect(StockLocSchema.safeParse(QUARANTINE).success).toBe(true);
    // Only the whole word: a key that merely starts with it is an ordinary key.
    expect(LocKeySchema.safeParse("quarantine-2").success).toBe(true);
  });
  it.each(["Rest", "7-eleven", "", "a".repeat(25), "juice bar", "-rest"])("refuses %j as a key", (k) => {
    expect(StockLocSchema.safeParse(k).success).toBe(false);
  });
  it("reads a snapshot's menu and stock for a fourth outlet, and refuses a malformed key", () => {
    expect(SnapshotSchema.shape.menu.safeParse({ "juice-bar": ["juice"] }).success).toBe(true);
    expect(SnapshotSchema.shape.stock.safeParse({ "juice-bar": { juice: 4 }, quarantine: {} }).success).toBe(true);
    expect(SnapshotSchema.shape.menu.safeParse({ Juice: [] }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm -C $W --filter @rch/contract exec vitest run src/routes.test.ts`

Expected: FAIL. `juice-bar` is refused by the enum, and `STORE` / `KITCHEN` are not exported.

- [ ] **Step 4: Flip the contract**

In `packages/contract/src/schemas/common.ts`:

1. Replace line 3 (`export const LocKeySchema = z.enum([...])`) with:

```ts
/**
 * Where an operator acts. A location key is data, not a closed list: the central store and the
 * central kitchen are `STORE` and `KITCHEN` below, and every outlet is a row the super admin opened -
 * so a key is checked for shape here and for existence by the service that reads its row
 * (`apps/api/src/lib/locations.ts`). Lower-case, a letter first, at most 24 characters: the shape
 * `outletKeyFor` in @rch/domain mints. The one key refused by name is the rejected-goods shelf - no
 * write body, no user's home location and neither end of a ticket may ever name quarantine. A
 * lookahead rather than a `.refine`, so this stays a plain string schema a record can be keyed by.
 */
export const LocKeySchema = z.string().regex(/^(?!quarantine$)[a-z][a-z0-9-]{0,23}$/, "Not a location an operator can act at");
```

2. Replace the `StockLocSchema` declaration and the comment block above it with:

```ts
/** Where stock is *reported*: any location key, the rejected-goods shelf included. Stock has to be
 *  shown there; nothing may be sold, issued or moved from there, which `LocKeySchema` holds. */
export const StockLocSchema = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/, "Not a location key");
/** The central store and the central kitchen - one of each in every hospital, and the only two
 *  locations the code may name. Outlets are read from the master, never listed. */
export const STORE = "store";
export const KITCHEN = "kitchen";
```

3. Change `ALL_LOCS` to a literal. It can no longer spread `.options`:

```ts
export const ALL_LOCS: LocKey[] = ["store", "kitchen", "rest", "coffee", "kiosk"];
```

Keep its doc comment and `OUTLETS` as they are. `QUARANTINE` is declared above `StockLocSchema` in this file.
Keep that order, since `StockLocSchema` no longer references it but the comment reads better there.

In `packages/contract/src/schemas/documents.ts`, extend `LocationSchema`:

```ts
export const LocationSchema = z.object({
  n: z.string(), c: z.string(), type: z.enum(["Store", "Kitchen", "Outlet"]),
  floor: z.string(), cc: z.string(), list: PriceListSchema.optional(),
  // ---- outlets. Whether the location still trades, and how much of an item's reorder level one
  // par covers there (`parFactor` in @rch/domain). Absent reads as open and as a full day's cover,
  // the way `Item.active` reads absent: the server always sends both.
  active: z.boolean().optional(),
  par: z.number().positive().optional(),
});
```

In `packages/contract/src/schemas/snapshot.ts`, replace the two helpers and their comments:

```ts
// Not every caller sees every location - a counter operator's snapshot is scoped down to their
// own (`scope()`) - and the set of locations is data, so these are records keyed by a checked key
// rather than exhaustive records over a list.
const byLoc = <T extends z.ZodTypeAny>(v: T) => z.record(LocKeySchema, v);
/** Stock is reported for quarantine too - the store keeper has to see what was rejected - while
 *  `menu` and every write body stay on locations an operator may act on. */
const byStockLoc = <T extends z.ZodTypeAny>(v: T) => z.record(StockLocSchema, v);
```

In `packages/contract/src/schemas/writes.ts`, append `"locations", "outlets"` to the end of the
`CollectionSchema` enum. Add one sentence to its comment: `"locations"` and `"outlets"` are the location
master as the operational screens and the admin page each read it.

In `packages/contract/src/types.ts`, change the `StockLoc` comment to
`/** Everywhere stock is *reported*: any location, the rejected-goods shelf included. */`.

In `packages/contract/src/fixtures/master.ts`, add `active: true` and `par` to every `LOC` row. The `par` values
are today's `PAR_FACTOR`:
- store `par: 1`
- kitchen `par: 0.35`
- rest `par: 0.22`
- coffee `par: 0.18`
- kiosk `par: 0.15`
- quarantine `par: 1`

- [ ] **Step 5: Run the contract tests**

Run: `pnpm -C $W --filter @rch/contract test`

Expected: PASS, with coverage lines ≥ 96.

- [ ] **Step 6: Write the failing domain tests**

Create `packages/domain/src/locations.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as FX from "@rch/contract/fixtures";
import type { Location } from "@rch/contract";
import { operationalKeys, outletKeyFor, outletKeys, placesFor, worksAt } from "./locations";

const juice: Location = { n: "Juice Bar", c: "OT-JB", type: "Outlet", floor: "G", cc: "CC-JB", list: "A", active: true, par: 0.18 };
const closed = (l: Location): Location => ({ ...l, active: false });

describe("outletKeys", () => {
  it("lists the Outlet-type locations by name, never the store, the kitchen or quarantine", () => {
    expect(outletKeys(FX.LOC)).toEqual(["coffee", "rest", "kiosk"]);    // Coffee Shop, Restaurant, Snack Kiosk
  });
  it("leaves a closed outlet out only when asked for the open ones", () => {
    const locs = { ...FX.LOC, kiosk: closed(FX.LOC.kiosk), "juice-bar": juice };
    expect(outletKeys(locs)).toEqual(["coffee", "juice-bar", "rest", "kiosk"]);
    expect(outletKeys(locs, { open: true })).toEqual(["coffee", "juice-bar", "rest"]);
  });
  it("orders two outlets with one printed name by key, so the order never depends on insertion", () => {
    expect(outletKeys({ b: { ...juice }, a: { ...juice } })).toEqual(["a", "b"]);
  });
  it("reads an outlet with no `active` as open", () => {
    const { active: _, ...bare } = juice;
    expect(outletKeys({ x: bare }, { open: true })).toEqual(["x"]);
  });
});

describe("operationalKeys", () => {
  it("is the store, the kitchen, then the open outlets - never quarantine", () => {
    expect(operationalKeys({ ...FX.LOC, kiosk: closed(FX.LOC.kiosk) })).toEqual(["store", "kitchen", "coffee", "rest"]);
  });
  it("leaves out a singleton the master has not sent yet", () => {
    expect(operationalKeys({})).toEqual([]);
  });
});

describe("worksAt / placesFor", () => {
  const locs = { ...FX.LOC, kiosk: closed(FX.LOC.kiosk) };
  it.each([
    ["prod", "kitchen", true], ["prod", "store", false],
    ["store", "store", true], ["buyer", "store", true], ["buyer", "rest", false],
    ["counter", "rest", true], ["manager", "coffee", true], ["counter", "store", false],
    ["counter", "kiosk", false], ["manager", "kiosk", false], ["counter", "nowhere", false],
  ] as const)("%s at %s is %s", (role, key, ok) => {
    expect(worksAt(role, key, locs[key as keyof typeof locs])).toBe(ok);
  });
  it("offers each role exactly the places it may work", () => {
    expect(placesFor("prod", locs)).toEqual(["kitchen"]);
    expect(placesFor("store", locs)).toEqual(["store"]);
    expect(placesFor("buyer", locs)).toEqual(["store"]);
    expect(placesFor("counter", locs)).toEqual(["coffee", "rest"]);
    expect(placesFor("manager", locs)).toEqual(["coffee", "rest"]);
  });
});

describe("outletKeyFor", () => {
  it("makes a lower-case, dash-joined key from the name", () => {
    expect(outletKeyFor("Juice Bar", [])).toBe("juice-bar");
    expect(outletKeyFor("  Dr. Rao's  Café & Tea!! ", [])).toBe("dr-rao-s-caf-tea");
  });
  it("steps past a key already taken, and past the three the code reserves", () => {
    expect(outletKeyFor("Juice Bar", ["juice-bar", "juice-bar-2"])).toBe("juice-bar-3");
    expect(outletKeyFor("Store", [])).toBe("store-2");
    expect(outletKeyFor("Kitchen", [])).toBe("kitchen-2");
    expect(outletKeyFor("Quarantine", [])).toBe("quarantine-2");
  });
  it("starts with a letter and stays inside the 24 characters a key may have", () => {
    expect(outletKeyFor("7 Eleven", [])).toBe("outlet-7-eleven");
    expect(outletKeyFor("!!!", [])).toBe("outlet");
    const long = outletKeyFor("The Very Long Name Of A Hospital Outlet", []);
    expect(long.length).toBeLessThanOrEqual(20);
    expect(long).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
    expect(outletKeyFor("The Very Long Name Of A Hospital Outlet", [long]).length).toBeLessThanOrEqual(24);
  });
});
```

Add to `packages/domain/src/par.test.ts`:

```ts
import * as FX from "@rch/contract/fixtures";
import { parFactor } from "./par";

describe("parFactor", () => {
  it("reads the factor off the location, and a full day where the location carries none", () => {
    expect(parFactor(FX.LOC, "rest")).toBe(0.22);
    expect(parFactor(FX.LOC, "store")).toBe(1);
    expect(parFactor({ x: { n: "X", c: "X", type: "Outlet", floor: "G", cc: "C" } }, "x")).toBe(1);
    expect(parFactor(FX.LOC, "nowhere")).toBe(1);
  });
});
```

(Keep the existing `PAR_FACTOR` test until Task 10.) Check how other domain tests import fixtures. If they use a
different specifier than `@rch/contract/fixtures`, copy theirs.

- [ ] **Step 7: Run them to verify they fail**

Run: `pnpm -C $W --filter @rch/domain exec vitest run src/locations.test.ts src/par.test.ts`

Expected: FAIL, because `./locations` doesn't exist and `parFactor` isn't exported.

- [ ] **Step 8: Implement the domain functions**

Create `packages/domain/src/locations.ts`:

```ts
import { KITCHEN, QUARANTINE, STORE, type Location, type Role } from "@rch/contract";

/** The master's location registry, keyed by location key - only the fields these rules read, so the
 *  admin page can pass its own list without inventing a par factor. */
type Locations = Record<string, Pick<Location, "n" | "type" | "active">>;

/** Absent reads as open, the way `Item.active` reads absent. */
const open = (l: Pick<Location, "active">): boolean => l.active !== false;

/**
 * The outlets, read from the master - never from a list compiled into either side. By printed name,
 * because that is the order a person scans a picker in, and by key after that so two outlets that
 * share a name still come out in one order everywhere. `open` leaves a closed outlet out: a picker
 * that *starts* something asks for the open ones, and a filter over what already happened asks for
 * all of them, since a closed outlet's bills are still bills.
 */
export function outletKeys(locations: Locations, opts: { open?: boolean } = {}): string[] {
  return Object.entries(locations)
    .filter(([, l]) => l.type === "Outlet" && (!opts.open || open(l)))
    .sort(([ka, a], [kb, b]) => a.n.localeCompare(b.n) || ka.localeCompare(kb))
    .map(([k]) => k);
}

/** Every place an operator works today: the central store, the central kitchen, then the open
 *  outlets. Quarantine is never here - stock is recorded there, and nobody acts there. A singleton
 *  the master has not sent yet is left out rather than named without a row behind it. */
export const operationalKeys = (locations: Locations): string[] =>
  [...[STORE, KITCHEN].filter((k) => locations[k]), ...outletKeys(locations, { open: true })];

/**
 * A role and a location are not independent. The kitchen in-charge works in the kitchen; the store
 * keeper and the buyer work at the central store; a counter operator and an outlet manager work at
 * an outlet that is still open. Nothing downstream checks the pairing - `requireLoc` only compares a
 * request against whatever the token says - so an account paired wrongly is refused nowhere else.
 */
export function worksAt(role: Role, key: string, location: Pick<Location, "type" | "active"> | undefined): boolean {
  if (!location) return false;
  if (role === "prod") return key === KITCHEN;
  if (role === "store" || role === "buyer") return key === STORE;
  return location.type === "Outlet" && open(location);
}

/** The same rule as a picker's list: every location `worksAt` would accept for this role. */
export const placesFor = (role: Role, locations: Locations): string[] =>
  role === "prod" ? [KITCHEN] : role === "store" || role === "buyer" ? [STORE] : outletKeys(locations, { open: true });

/** The keys the code itself names. An outlet called "Store" is fine; its key may not be `store`. */
const RESERVED: ReadonlySet<string> = new Set([STORE, KITCHEN, QUARANTINE]);
/** Twenty, so a `-NNN` suffix still fits inside the 24 characters `LocKeySchema` allows. */
const STEM = 20;

/**
 * The key a new outlet is given, from its name, once - it never changes afterwards, even when the
 * outlet is renamed, because every bill, move and ticket names it. Lower-case, runs of anything
 * outside a-z and 0-9 become one dash, a letter first (a name that starts with a digit, or has no
 * letters at all, is prefixed `outlet`), then `-2`, `-3`, … past a reserved key or one already taken.
 */
export function outletKeyFor(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const trim = (s: string) => s.slice(0, STEM).replace(/-+$/, "");
  const slug = trim(name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, ""));
  const stem = /^[a-z]/.test(slug) ? slug : trim(slug ? `outlet-${slug}` : "outlet");
  if (!RESERVED.has(stem) && !used.has(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const key = `${stem}-${n}`;
    if (!used.has(key)) return key;
  }
}
```

Add to `packages/domain/src/par.ts`, below `PAR_FACTOR`:

```ts
/** The same tuning read off the location itself - `locations.par_factor`, carried on the wire as
 *  `par` - so an outlet opened after release has one without a release. Absent reads as a full day. */
export const parFactor = (locations: Record<string, Location>, loc: string): number => locations[loc]?.par ?? 1;
```

Change par.ts's import to `import type { LocKey, Location } from "@rch/contract";`.

In `packages/domain/src/index.ts`, change the par line and add a locations line:

```ts
export { PAR_FACTOR, parFactor } from "./par.js";
// ---- outlets: which locations are outlets, which are open, who may work where, and a new one's key.
export { operationalKeys, outletKeyFor, outletKeys, placesFor, worksAt } from "./locations.js";
```

- [ ] **Step 9: Run the domain suite**

Run: `pnpm -C $W --filter @rch/domain test`

Expected: PASS, with coverage ≥ 99 lines / 92 branches.

- [ ] **Step 10: Move the three `.options` readers in the UI and the one in the CLI**

`UI/src/api/wire.ts`:
1. Drop `StockLocSchema` from the `@rch/contract` import.
2. Add `LOC` to the `../data/master` import.
3. Replace the `ALL_LOC` constant and `stockOf`, with their comments, by:

```ts
/**
 * A counter operator's snapshot is scoped to its own location, so the server omits the rest. The
 * store's map is exhaustive - an absent location is empty, not missing, or every `stock[loc][it]`
 * read would throw - over every location the master names, quarantine included. Read off `LOC`,
 * which `hydrateMaster` has just filled, rather than a list compiled into the bundle: an outlet the
 * super admin opened this morning is a location like any other.
 */
const stockOf = (s: Snapshot["stock"]): Record<StockLoc, Record<string, number>> =>
  ({ ...Object.fromEntries(Object.keys(LOC).map((l) => [l, {}])), ...s });
```

`applySnapshot` already calls `hydrateMaster` before `stockOf`. Keep that order.

`UI/src/store/index.ts`:
1. Change the import to `import { KITCHEN, QUARANTINE, routes, STORE } from "@rch/contract";`.
2. Replace `EMPTY_STOCK` with:

```ts
/** The shelves every hospital has, empty, until a snapshot says which outlets there are. */
const EMPTY_STOCK: Record<StockLoc, Record<string, number>> = { [STORE]: {}, [KITCHEN]: {}, [QUARANTINE]: {} };
```

`UI/src/roles/store/Adjustments.tsx`:
1. Replace the `StockLocSchema` import with `import { QUARANTINE, STORE } from "@rch/contract";`.
2. Add `ALL_LOCS` to the `../../data/master` import.
3. Replace lines 11–19 (the comment, `FIRST_SHELF` and `SHELVES`) with:

```ts
/** Every shelf the store keeper answers for, which is all of them - the rejected-goods shelf
 *  included. What a goods receipt turned away sits there until somebody destroys it or sends it
 *  back, and nothing else in the system can take it off again. A non-empty tuple, because
 *  `AdjustmentForm` takes one. */
const SHELVES: [StockLoc, ...StockLoc[]] = [STORE, ...ALL_LOCS.filter((l) => l !== STORE), QUARANTINE];
```

`apps/api/src/cli/users.ts`, in `needLoc`: the error line becomes

```ts
  if (!parsed.success) { console.error(`--loc must be a location key - store, kitchen or an outlet's key (got "${v}")`); process.exit(2); }
```

- [ ] **Step 11: Typecheck and run the affected suites**

```bash
pnpm -C $W turbo typecheck
pnpm -C $W --filter @rch/ui test
TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W --filter @rch/api exec vitest run src/modules/snapshot src/contract.test.ts src/routes.test.ts
```

Expected:
- typecheck is clean in all four packages;
- the UI suite passes with coverage floors met;
- the snapshot suites pass.

If typecheck flags code that used `z.infer` of a location enum as a union, that code is now `string`. Fix the
annotation, not the schema.

- [ ] **Step 12: Commit**

```bash
git -C $W add -A packages/contract packages/domain UI/src apps/api/src/cli/users.ts
git -C $W commit -m "Let a location key be data rather than one of five compiled-in names

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FmSadpAt28HysLFwj5KRjk"
```

---

### Task 2: The locations table records open/closed and a par factor

**Files:**
- Modify: `apps/api/src/db/schema/master.ts` (`locations`)
- Create (generated, then hand-edited): `apps/api/drizzle/0015_outlets.sql`, `apps/api/drizzle/meta/0015_snapshot.json`,
  `apps/api/drizzle/meta/_journal.json`
- Modify: `apps/api/src/lib/wire.ts` (`toWireLocation`)
- Modify: `apps/api/src/lib/db.ts` (add `uniqueViolationOf`)
- Modify: `apps/api/src/db/seed.ts` (`seedLocations`)
- Create: `apps/api/src/db/outlets-migration.test.ts`
- Modify: `apps/api/src/lib/master.test.ts`

**Interfaces:**
- **Consumes:** `Location.active`, `Location.par` (Task 1).
- **Produces:**
  - `locations.active` (boolean), `locations.parFactor` (number) in Drizzle.
  - `LocationRow` with both fields.
  - `toWireLocation` emits `active` and `par`.
  - Unique indexes `locations_name_uq` (`lower(name)`) and `locations_code_uq` (`upper(code)`).
  - `uniqueViolationOf(err: unknown): string | undefined`, which returns the constraint name of a 23505.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/db/outlets-migration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { withTestSchema, type TestDb } from "../test/db.js";
import { seedTestDb } from "../test/seed.js";
import { uniqueViolationOf } from "../lib/db.js";

/**
 * The outlets migration against the seeded hospital. The par-factor backfill is the one statement
 * whose effect a freshly migrated schema cannot show - the rows it updates are inserted after it -
 * so the statement is read out of the migration file and run again over rows put back to the
 * column default, which is exactly the state a live database is in when the migration reaches it.
 */
let t: TestDb;
beforeAll(async () => { t = await withTestSchema("outlets_migration"); await seedTestDb(t.db); });
afterAll(async () => { await t.close(); });

const backfill = (): string => {
  const file = readFileSync(new URL("../../drizzle/0015_outlets.sql", import.meta.url), "utf8");
  const stmt = file.split("--> statement-breakpoint").map((s) => s.trim()).find((s) => s.includes(`UPDATE "locations" SET "par_factor"`));
  if (!stmt) throw new Error("0015_outlets.sql carries no par_factor backfill");
  return stmt;
};
const insertOutlet = (key: string, name: string, code: string) =>
  t.db.execute(sql`insert into locations(key, name, code, type, floor, cost_centre) values (${key}, ${name}, ${code}, 'Outlet', 'Ground', 'CC-X')`);
const refusalOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try { await p; return undefined; } catch (e) { return uniqueViolationOf(e); }
};

describe("0015_outlets", () => {
  it("backfills today's par factors, so no par level moves", async () => {
    await t.db.execute(sql`update locations set par_factor = 0.18`);
    await t.db.execute(sql.raw(backfill()));
    const rows = (await t.db.execute(sql`select key, par_factor::float8 as par from locations`)).rows as { key: string; par: number }[];
    expect(Object.fromEntries(rows.map((r) => [r.key, r.par]))).toEqual({ store: 1, kitchen: 0.35, rest: 0.22, coffee: 0.18, kiosk: 0.15, quarantine: 1 });
  });
  it("opens a new location with the default factor", async () => {
    await insertOutlet("juice-bar", "Juice Bar", "OT-JB");
    const [row] = (await t.db.execute(sql`select active, par_factor::float8 as par from locations where key = 'juice-bar'`)).rows;
    expect(row).toEqual({ active: true, par: 0.18 });
  });
  it("refuses a second location with the same name or code in another case", async () => {
    expect(await refusalOf(insertOutlet("juice-bar-2", "JUICE BAR", "OT-J2"))).toBe("locations_name_uq");
    expect(await refusalOf(insertOutlet("juice-bar-3", "Juice Hut", "ot-jb"))).toBe("locations_code_uq");
  });
  it("names no constraint for an error that is not a unique violation", () => {
    expect(uniqueViolationOf(new Error("boom"))).toBeUndefined();
    expect(uniqueViolationOf({ cause: { code: "23503", constraint: "x" } })).toBeUndefined();
  });
});
```

In `apps/api/src/lib/master.test.ts`, add one case in the file's existing style. It should assert that
`loadLocations` returns `kiosk` matching `{ active: true, par: 0.15 }` and `quarantine` matching
`{ active: true, par: 1 }`.

- [ ] **Step 2: Run them to verify they fail**

Run: `TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W --filter @rch/api exec vitest run src/db/outlets-migration.test.ts src/lib/master.test.ts`

Expected: FAIL. The migration file doesn't exist, and `uniqueViolationOf` isn't exported.

- [ ] **Step 3: Change the schema**

In `apps/api/src/db/schema/master.ts`, the `locations` table becomes:

```ts
export const locations = pgTable("locations", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  type: locationTypeEnum("type").notNull(),
  floor: text("floor").notNull(),
  costCentre: text("cost_centre").notNull(),
  priceList: priceListEnum("price_list"),
  sellable: boolean("sellable").notNull().default(false),
  // ---- outlets. Outlets are closed, never deleted: a closed one keeps its row, its menu and every
  // document that names it, and nothing new may name it (`lib/locations.ts`).
  active: boolean("active").notNull().default(true),
  /** How much of an item's reorder level one par covers here (`parFactor` in @rch/domain). */
  parFactor: numeric("par_factor", { precision: 4, scale: 2, mode: "number" }).notNull().default(0.18),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  // Every picker matches a location on its printed name, so two with one name would be one entry;
  // and the code is what the floor staff read off a label.
  uniqueIndex("locations_name_uq").on(sql`lower(${t.name})`),
  uniqueIndex("locations_code_uq").on(sql`upper(${t.code})`),
]);
```

(`sql` and `uniqueIndex` are already imported in this file.)

- [ ] **Step 4: Generate the migration, then add the backfill by hand**

Run: `pnpm -C $W --filter @rch/api db:generate --name outlets`

Expected: new `drizzle/0015_outlets.sql`, `drizzle/meta/0015_snapshot.json` and a journal entry. The SQL should be
two `ADD COLUMN` statements and two `CREATE UNIQUE INDEX` statements. If the number isn't 0015, use the generated
number everywhere this plan says 0015, including the test's file name.

Edit `0015_outlets.sql`. Insert this between the last `ADD COLUMN` and the first `CREATE UNIQUE INDEX`, keeping
the `--> statement-breakpoint` separators:

```sql
-- Today's par factors, so no par level moves: store, kitchen and the three outlets carried these in
-- `PAR_FACTOR` (@rch/domain), and the rejected-goods shelf never had one, which read as a full day.
-- An outlet opened after this migration takes the column default.
UPDATE "locations" SET "par_factor" = CASE "key" WHEN 'store' THEN 1 WHEN 'kitchen' THEN 0.35 WHEN 'rest' THEN 0.22 WHEN 'coffee' THEN 0.18 WHEN 'kiosk' THEN 0.15 WHEN 'quarantine' THEN 1 ELSE "par_factor" END;--> statement-breakpoint
```

- [ ] **Step 5: Emit and seed the new columns; name a unique violation**

`apps/api/src/lib/wire.ts`:

```ts
export const toWireLocation = (r: LocationRow): Location => strip({
  n: r.name, c: r.code, type: r.type, floor: r.floor, cc: r.costCentre, list: r.priceList ?? undefined,
  active: r.active, par: r.parFactor,
});
```

`apps/api/src/db/seed.ts`, `seedLocations`: the values map becomes

```ts
    Object.entries(FX.LOC).map(([key, l]) => ({
      key, name: l.n, code: l.c, type: l.type, floor: l.floor, costCentre: l.cc, priceList: l.list ?? null,
      sellable: l.type === "Outlet", active: l.active ?? true, parFactor: l.par ?? 1,
    })),
```

`apps/api/src/lib/db.ts`, below `isForeignKeyViolation`:

```ts
/** The unique index a statement ran into, when that is why it failed - a refusal can then name the
 *  field that clashed rather than the constraint. Undefined for any other failure. */
export const uniqueViolationOf = (err: unknown): string | undefined => {
  const cause = (err as { cause?: { code?: string; constraint?: string } } | null)?.cause;
  return cause?.code === "23505" ? cause.constraint : undefined;
};
```

- [ ] **Step 6: Run the tests, then the whole API suite**

```bash
TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W --filter @rch/api exec vitest run src/db/outlets-migration.test.ts src/lib/master.test.ts
TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W --filter @rch/api test
```

Expected: PASS. Any suite that deep-compares `locations` to `FX.LOC` still passes, because the fixtures carry the
same `active` and `par`.

- [ ] **Step 7: Commit**

Commit `apps/api` with the message "Record whether a location is open and its par factor on the location itself",
followed by the trailers.

---

### Task 3: One way for a write to name a location

**Files:**
- Create: `apps/api/src/lib/locations.ts`, `apps/api/src/lib/locations.test.ts`
- Modify: `apps/api/src/modules/pos/service.ts` (`pay`, `voidBill`)
- Modify: `apps/api/src/modules/tickets/service.ts` (`transfer`)
- Modify: `apps/api/src/modules/shopasks/service.ts` (`ask`)
- Modify: `apps/api/src/modules/production/service.ts` (`raise`, `distribute`)
- Modify: `apps/api/src/modules/productreqs/service.ts` (`create`)
- Modify: `apps/api/src/modules/adjustments/routes.ts`, `apps/api/src/modules/adjustments/service.ts`
- Modify: `apps/api/src/modules/catalog/service.ts` (`addMenuItem`)
- Modify: `apps/api/src/modules/availability/service.ts` (`toggle`)
- Modify: `apps/api/src/modules/snapshot/readers/stock.ts`

**Interfaces:**
- **Consumes:** `locations.active` (Task 2), `LocationRow` from `lib/wire.ts`.
- **Produces:**
  - `lockLocation(tx: Tx, key: string): Promise<LocationRow>`: `FOR SHARE`; a missing row throws
    `NotFoundError("There is no location <key>.")`.
  - `assertOpen(row: Pick<LocationRow, "name" | "active">, then?: string): void`: a closed row throws
    `RuleError("Refused - <name> is closed" + (then ? "; " + then : ""))`.

- [ ] **Step 1: Write the failing test file**

Create `apps/api/src/lib/locations.test.ts`. Before writing the item picks, check
`packages/contract/src/fixtures/master.ts`:
- `chips` and `juice` are on the kiosk menu and priced on list A.
- For `distribute`, pick an item that is **not** `MTO` and that is on the kiosk menu (for example `puff`, if its
  type is `FG`).

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { App } from "../app.js";
import { buildTestApp } from "../test/app.js";
import { truncateAll } from "../test/db.js";
import { seedTestDb } from "../test/seed.js";
import { authHeaders } from "../test/auth.js";
import { locations } from "../db/schema/index.js";

/**
 * A closed outlet, from every write that can name one. The outlet is closed straight on the row here -
 * the admin route that closes one refuses while stock, documents or staff remain, and each of these
 * writes has to be refused even so, because the row lock is what stops a sale that started a moment
 * before the close committed.
 */
let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "locations_lib" }); await app.ready(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });
afterAll(async () => { await app.close(); });

const send = async (userId: string, method: "POST" | "PATCH", url: string, payload: unknown = {}) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { ...(await authHeaders(app, userId)), "idempotency-key": randomUUID() }, payload });
const setOpen = (key: string, active: boolean) => app.db.update(locations).set({ active }).where(eq(locations.key, key));
const refusal = (r: { statusCode: number; body: string; json: () => { error: { message: string } } }) => {
  expect(r.statusCode, r.body).toBe(422);
  return r.json().error.message;
};
const CLOSED = "Refused - Snack Kiosk is closed";

describe("a closed outlet", () => {
  it("takes no sale", async () => {
    await setOpen("kiosk", false);
    expect(refusal(await send("u6", "POST", "/bills", { loc: "kiosk", tender: "Cash", lines: [{ it: "chips", qty: 1 }] }))).toBe(CLOSED);
  });
  it("has no bill voided until it is reopened", async () => {
    const sale = await send("u6", "POST", "/bills", { loc: "kiosk", tender: "Cash", lines: [{ it: "chips", qty: 1 }] });
    expect(sale.statusCode, sale.body).toBe(200);
    await setOpen("kiosk", false);
    const no = encodeURIComponent(sale.json().result.no);
    expect(refusal(await send("u2", "POST", `/bills/${no}/void`, { reason: "Rang up twice" })))
      .toBe(`${CLOSED}; reopen it before voiding its bills`);
    await setOpen("kiosk", true);
    expect((await send("u2", "POST", `/bills/${no}/void`, { reason: "Rang up twice" })).statusCode).toBe(200);
  });
  it("is neither end of a shop transfer", async () => {
    await setOpen("kiosk", false);
    expect(refusal(await send("u1", "POST", "/transfers", { from: "coffee", to: "kiosk", it: "chips", qty: 1 }))).toBe(CLOSED);
  });
  it("cannot be asked for stock", async () => {
    await setOpen("kiosk", false);
    expect(refusal(await send("u1", "POST", "/shop-asks", { to: "kiosk", it: "chips", qty: 1 }))).toBe(CLOSED);
  });
  it("orders nothing from the kitchen and is sent nothing from it", async () => {
    await setOpen("kiosk", false);
    expect(refusal(await send("u2", "POST", "/prod-orders", { from: "kiosk", lines: [{ it: "puff", qty: 1 }] }))).toBe(CLOSED);
    expect(refusal(await send("u4", "POST", "/distributions", { it: "puff", qty: 1, to: "kiosk" }))).toBe(CLOSED);
  });
  it("asks for no new product, has no stock adjusted, no product listed and nothing switched off", async () => {
    await setOpen("kiosk", false);
    expect(refusal(await send("u2", "POST", "/product-requests", { name: "Mango lassi", forLoc: "kiosk" }))).toBe(CLOSED);
    expect(refusal(await send("u2", "POST", "/adjustments", { loc: "kiosk", reason: "count", lines: [{ it: "chips", qty: 1 }] }))).toBe(CLOSED);
    expect(refusal(await send("u2", "POST", "/menus/kiosk/items", { it: "capp" }))).toBe(CLOSED);
    expect(refusal(await send("u2", "POST", "/availability/toggle", { loc: "kiosk", it: "chips" }))).toBe(CLOSED);
  });
  it("leaves every other outlet trading", async () => {
    await setOpen("kiosk", false);
    expect((await send("u1", "POST", "/bills", { loc: "coffee", tender: "Cash", lines: [{ it: "chips", qty: 1 }] })).statusCode).toBe(200);
  });
});

describe("a location key the master does not carry", () => {
  it("is a 404 the manager can read, not a crash", async () => {
    const r = await send("u2", "POST", "/menus/juice-bar/items", { it: "juice" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no location juice-bar.");
  });
});

describe("GET /stock", () => {
  it("carries an empty map for a location with nothing on its shelves", async () => {
    await app.db.insert(locations).values({ key: "juice-bar", name: "Juice Bar", code: "OT-JB", type: "Outlet", floor: "Ground", costCentre: "CC-JB", priceList: "A" });
    const r = await app.inject({ method: "GET", url: "/api/v1/stock", headers: await authHeaders(app, "u2") });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().stock["juice-bar"]).toEqual({});
  });
});
```

Adjust payload field names if a schema in `packages/contract/src/schemas/writes.ts` differs. Check
`createProductRequest`'s `why` default and `toggleAvail`'s body, for example. Don't change the expectations.

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W --filter @rch/api exec vitest run src/lib/locations.test.ts`

Expected: FAIL. Every write returns 200 at the closed kiosk, and `GET /stock` drops `juice-bar`.

- [ ] **Step 3: Create the helper**

Create `apps/api/src/lib/locations.ts`:

```ts
import { eq } from "drizzle-orm";
import { locations } from "../db/schema/index.js";
import type { Tx } from "./db.js";
import { NotFoundError, RuleError } from "./errors.js";
import type { LocationRow } from "./wire.js";

/**
 * The one way a write names a location: its row, locked `FOR SHARE`.
 *
 * Shared, so every sale at one outlet still runs beside every other, while the admin's close - which
 * takes the same row `FOR UPDATE` (`modules/admin`) - waits for all of them to commit, and a sale
 * that starts after the close has committed reads the outlet closed. The foreign key every document
 * has onto `locations` takes only a key-share lock, which an `UPDATE` of `active` does not wait for,
 * so the explicit lock is what makes the two exclusive.
 *
 * Master data, so the lock belongs to the documents tier: take it before any id and any balance,
 * and the server-wide order - documents, ids, balances - is unchanged.
 */
export async function lockLocation(tx: Tx, key: string): Promise<LocationRow> {
  const [row] = await tx.select().from(locations).where(eq(locations.key, key)).for("share");
  if (!row) throw new NotFoundError(`There is no location ${key}.`);
  return row;
}

/** Nothing new may name a closed outlet. `then` finishes the sentence where there is a way on. */
export function assertOpen(row: Pick<LocationRow, "name" | "active">, then?: string): void {
  if (!row.active) throw new RuleError(`Refused - ${row.name} is closed${then ? `; ${then}` : ""}`);
}
```

- [ ] **Step 4: Route every write through it**

In every edit below:
- Import `{ assertOpen, lockLocation } from "../../lib/locations.js"`.
- Rename `.n` → `.name` wherever a message read the wire location's name off the replaced object.
- Delete imports that become unused (`OUTLETS`, `loadLocations`, `loadMaster`, `NotFoundError`). Lint fails on
  leftovers.
- Delete comments that say a location key "never reaches here" or that `LocKeySchema` admits only the five seeded
  keys. They are false now.

1. **`pos/service.ts` `pay`.** Directly after `const loc = body.loc;`:

```ts
        // The outlet first - it is the documents tier - so a close waits for this sale to commit,
        // or this sale reads the outlet closed.
        assertOpen(await lockLocation(tx, loc));
```

2. **`pos/service.ts` `voidBill`.** Directly after the same-day `assertRule(istDate(bill.at) === …)`:

```ts
        // A void posts the sale's stock back onto the shelf it came off, and a closed outlet's shelves
        // were emptied to close it.
        assertOpen(await lockLocation(tx, bill.loc), "reopen it before voiding its bills");
```

3. **`tickets/service.ts` `transfer`.** Replace the `loadLocations` / `from` / `to` / `assertRule(... type === "Outlet" ...)` block with:

```ts
        assertRule(body.from !== body.to, "A shop transfer runs between two different outlets");
        const from = await lockLocation(tx, body.from);
        const to = await lockLocation(tx, body.to);
        // The store and the kitchen supply through a request and a ticket the manager sees;
        // this is the shortcut between two shop floors, and nothing else may use it.
        assertRule(from.type === "Outlet" && to.type === "Outlet", "A shop transfer runs between two different outlets");
        assertOpen(from);
        assertOpen(to);
```

  This block must stay above `allocateTicket`. Later in the function, `from.n` / `to.n` become `from.name` /
  `to.name`.

4. **`shopasks/service.ts` `ask`.** Replace `const master = await loadMaster(tx);` and the
   `assertRule(master.locations[...]...)` line with:

```ts
        const asker = await lockLocation(tx, from);
        const holder = await lockLocation(tx, body.to);
        assertRule(holder.type === "Outlet" && asker.type === "Outlet", "Only another shop can be asked directly");
        assertOpen(holder);
        const master = await loadMaster(tx);
```

5. **`production/service.ts` `raise`.** Replace the `fromName` line and the `OUTLETS.includes` assert with:

```ts
        // The kitchen cannot order from itself and the central store carries, it does not sell.
        // Only an outlet has a menu for the tray to land on (M9), which is the next rule down.
        const outlet = await lockLocation(tx, from);
        assertRule(outlet.type === "Outlet", `${outlet.name} is not an outlet - a production order is raised for a counter`);
        assertOpen(outlet);
        const fromName = outlet.name;
```

6. **`production/service.ts` `distribute`.** Replace `const to = master.locations[body.to]; if (!to) throw …` with
   `const to = await lockLocation(tx, body.to);`. Inside `if (to.type === "Outlet") {`, add `assertOpen(to);` as
   the first line, and change `to.n` to `to.name`. The lock must stay above `allocateTicket`, which it already is.
   Remove `OUTLETS` from the imports.

7. **`productreqs/service.ts` `create`.** Replace the `if (claims.role === "manager") { … }` block with:

```ts
        // A counter's own location was already checked against its token in routes.ts. A manager
        // may ask for any of the outlets, but the central store and the kitchen are not shops and
        // have no menu to add a product to - the same sentence `availability` gives a manager
        // reaching past the outlets.
        const outlet = await lockLocation(tx, body.forLoc);
        if (claims.role === "manager") assertRule(outlet.type === "Outlet", `${outlet.name} is not an outlet`);
        assertOpen(outlet);
```

8. **`adjustments/routes.ts`.**
   - Remove `OUTLETS` from the import.
   - The manager branch of `scopeToRole` becomes a bare `return;`, with the comment: `// A manager supervises the outlets and nothing else - held there by the service, from the location row.`
   - In the module header comment, change "the three shops" to "the outlets".

   **`adjustments/service.ts` `create`.** Add as the first lines inside `withTransaction`, before `const at = new Date();`:

```ts
        // The shelf first - documents tier - and it decides the manager's scope: a manager adjusts
        // at an outlet and nowhere else. A 403, as it was when this was a list in routes.ts.
        const shelf = await lockLocation(tx, body.loc);
        if (claims.role === "manager" && shelf.type !== "Outlet") {
          throw new ForbiddenError("You can only adjust stock at an outlet - the central store writes off its own shelves");
        }
        if (shelf.type === "Outlet") assertOpen(shelf);
```

  Also:
  - Import `ForbiddenError` from `../../lib/errors.js`.
  - `const locName = master.locations[loc]?.n ?? loc;` becomes `const locName = shelf.name;`.
  - Check that `claims` is the service's first parameter name. If it isn't, use whatever is.

9. **`catalog/service.ts` `addMenuItem`.** Replace its first three statements (lookup, 404, type assert) with:

```ts
        const location = await lockLocation(tx, loc);
        assertRule(location.type === "Outlet", `${location.name} is not an outlet`);
        assertOpen(location);
```

  Every later `location.n` in the function becomes `location.name`.

10. **`availability/service.ts` `toggle`.** Replace `const loc = master.locations[body.loc];` with
    `const loc = await lockLocation(tx, body.loc);`. Then:
    - Delete the `if (!loc) throw …` line, since `lockLocation` already throws that exact 404.
    - Rename every `loc.n` to `loc.name`. `loc.type` stays.
    - After the manager's `assertRule(loc.type === "Outlet", …)`, add `if (loc.type === "Outlet") assertOpen(loc);`.

    `const master = await loadMaster(tx);` stays, because it is still used for items and recipes. It moves below
    the `lockLocation` line.

11. **`snapshot/readers/stock.ts`.** Import `locations` from the schema and replace `STOCK_LOCS` and `readStock`
    with:

```ts
/** One map per location row, quarantine included - a store keeper has to see what a goods receipt
 *  rejected - so a location with nothing on its shelves, an outlet opened this morning, reads as
 *  empty rather than missing. Every balance names a row (a foreign key), so none is dropped. */
export async function readStock(db: Reader): Promise<Record<StockLoc, Record<string, number>>> {
  const locs = await db.select({ key: locations.key }).from(locations);
  const rows = await db.select().from(stockBalances);
  const out: Record<StockLoc, Record<string, number>> = Object.fromEntries(locs.map((l) => [l.key, {}]));
  for (const r of rows) (out[r.loc] ??= {})[r.itemKey] = r.onHand;
  return out;
}
```

- [ ] **Step 5: Run the new test, then the suites whose messages you touched**

```bash
TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W --filter @rch/api exec vitest run src/lib/locations.test.ts src/modules/pos src/modules/tickets src/modules/shopasks src/modules/production src/modules/productreqs src/modules/adjustments src/modules/catalog src/modules/availability src/modules/snapshot
```

Expected: PASS. If an existing test asserted a 422 for a location key that has no row, it now gets the 404
`There is no location <key>.`. Update that expectation and note it in the commit body. Don't reword refusals to
keep old tests green.

- [ ] **Step 6: Whole API suite, typecheck and lint**

```bash
TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W --filter @rch/api test
pnpm -C $W --filter @rch/api typecheck
pnpm -C $W --filter @rch/api lint
```

Expected: all pass. Coverage stays ≥ 94 lines / 79 branches.

- [ ] **Step 7: Commit**

Message: "Refuse every write at a closed outlet through one locked read of the location", followed by the trailers.

---

### Task 4: Staff pairing reads the locations table

**Files:**
- Modify: `apps/api/src/lib/users-admin.ts`
- Modify: `apps/api/src/lib/users-admin.test.ts`, `apps/api/src/modules/admin/admin.test.ts` (message expectations only)
- Modify: `apps/api/src/cli/users.ts` (`PAIRINGS`)

**Interfaces:**
- **Consumes:** `worksAt` (Task 1), `toWireLocation` (Task 2).
- **Produces:**
  - `createUserTx`, `updateUserRoleLocTx` and `reactivateUserTx` refuse a pairing with `ValidationError`, using
    these sentences:
    - `<Role label> works at the Central Kitchen, not at <location name>` (for `prod`)
    - `<Role label> works at the Central Store, not at <location name>` (for `store` and `buyer`)
    - `<Role label> works at an open outlet, not at <location name>` (for `counter` and `manager`, at a non-outlet)
    - `<Role label> works at an open outlet - <location name> is closed` (for `counter` and `manager`, at a closed
      outlet)
    - `unknown location "<key>"`, unchanged.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/lib/users-admin.test.ts`, add the cases below using the file's own harness (read its top first):

```ts
describe("pairing against the locations table", () => {
  it("creates a counter at an outlet opened after release", async () => {
    await db.insert(locations).values({ key: "juice-bar", name: "Juice Bar", code: "OT-JB", type: "Outlet", floor: "Ground", costCentre: "CC-JB", priceList: "A" });
    const { emp } = await createUser(db, { name: "Arun P", email: "arun.p@royalcare.in", role: "counter", loc: "juice-bar", password: "a-long-enough-password" });
    expect(emp).toMatch(/^RC-\d+$/);
  });
  it("refuses a counter at a closed outlet, and names it", async () => {
    await db.update(locations).set({ active: false }).where(eq(locations.key, "kiosk"));
    await expect(createUser(db, { name: "Arun P", email: "arun.p@royalcare.in", role: "counter", loc: "kiosk", password: "a-long-enough-password" }))
      .rejects.toThrow("Counter Operator works at an open outlet - Snack Kiosk is closed");
  });
  it("refuses to reactivate a counter whose outlet has closed since", async () => {
    await deactivateUser(db, "RC-4482");                        // Deepa, Snack Kiosk
    await db.update(locations).set({ active: false }).where(eq(locations.key, "kiosk"));
    await expect(reactivateUser(db, "RC-4482")).rejects.toThrow("Counter Operator works at an open outlet - Snack Kiosk is closed");
  });
  it("names the place a role works, by its printed name", async () => {
    await expect(createUser(db, { name: "Arun P", email: "arun.p@royalcare.in", role: "prod", loc: "rest", password: "a-long-enough-password" }))
      .rejects.toThrow("Kitchen In-charge works at the Central Kitchen, not at Restaurant");
  });
});
```

(Use the names the file already has for `db`, the seed, and imports of `locations`, `eq`, `createUser`,
`deactivateUser` and `reactivateUser`.)

Then run `git -C $W grep -n "works at" -- apps/api/src UI/src`. Every expectation that pins the old sentence
(`works at kitchen, not at rest`, `works at store`, `works at rest or coffee or kiosk`) is rewritten to the new
sentence for the same pairing.

- [ ] **Step 2: Run to verify they fail**

Run: `TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W --filter @rch/api exec vitest run src/lib/users-admin.test.ts src/modules/admin/admin.test.ts`

Expected: FAIL. `juice-bar` is refused by the static `WORKS_AT`, the old sentences print, and reactivate isn't
checked.

- [ ] **Step 3: Implement**

In `apps/api/src/lib/users-admin.ts`:
1. Remove `OUTLETS` from the contract import.
2. Import `worksAt` from `@rch/domain` (beside `nextEmpNo`) and `toWireLocation` from `./wire.js`.
3. Delete the `WORKS_AT` constant, keeping its comment's reasoning, which now lives on `worksAt` in the domain.
4. Replace `checkPairing` with:

```ts
/** Where each role works, as the refusal says it. The rule itself is `worksAt` in @rch/domain. */
const PLACE: Record<Role, string> = {
  prod: "the Central Kitchen", store: "the Central Store", buyer: "the Central Store",
  counter: "an open outlet", manager: "an open outlet",
};

/**
 * The pairing, against the location's row - read `FOR SHARE`, so an outlet cannot close between
 * this check and the account being written at it (the close takes the row `FOR UPDATE`).
 */
async function checkPairing(tx: Tx, role: Role, loc: string): Promise<void> {
  const [row] = await tx.select().from(locations).where(eq(locations.key, loc)).for("share");
  if (!row) throw new ValidationError(`unknown location "${loc}"`);
  if (worksAt(role, loc, toWireLocation(row))) return;
  const closedOutlet = (role === "counter" || role === "manager") && row.type === "Outlet" && !row.active;
  throw new ValidationError(closedOutlet
    ? `${ROLE_LABEL[role]} works at ${PLACE[role]} - ${row.name} is closed`
    : `${ROLE_LABEL[role]} works at ${PLACE[role]}, not at ${row.name}`);
}
```

5. **`createUserTx`:** replace the unknown-location line and `checkPairing(i.role, i.loc);` with
   `await checkPairing(tx, i.role, i.loc);`. It must stay above `allocateUserNumber`, which is documents before ids.
6. **`updateUserRoleLocTx`:** replace `checkPairing(next.role, next.loc);` with
   `await checkPairing(tx, next.role, next.loc);` and delete the later unknown-location line.
7. **`reactivateUserTx`:** after `const u = await byEmp(tx, emp);`, add

```ts
  // A deactivated account may be based at an outlet that has closed since; it comes back only
  // somewhere it can work.
  await checkPairing(tx, u.role, u.loc);
```

8. Remove `type LocKey` from the import if it's now unused, since `loc: LocKey` is still `string`.

In `apps/api/src/cli/users.ts`:

```ts
const PAIRINGS = "prod works at kitchen; store and buyer at store; counter and manager at an open outlet, by its key (e.g. rest)";
```

Update the comment above it, which says "`lib/users-admin.ts`'s WORKS_AT is the rule": the rule is now
`worksAt` in @rch/domain.

- [ ] **Step 4: Run the tests and the API suite**

```bash
TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W --filter @rch/api exec vitest run src/lib/users-admin.test.ts src/modules/admin
TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W --filter @rch/api test
```

Expected: PASS.

- [ ] **Step 5: Commit**

Message: "Pair staff with locations from the locations table, and never with a closed outlet", followed by the
trailers.

---

### Task 5: Takings are keyed by outlet, not by column

**Files:**
- Modify: `packages/contract/src/schemas/snapshot.ts` (`sales`)
- Modify: `apps/api/src/modules/snapshot/readers/documents.ts` (`readSales`)
- Modify: `apps/api/src/modules/snapshot/scope.ts`
- Modify: `apps/api/src/modules/snapshot/documents.test.ts`, `apps/api/src/modules/snapshot/snapshot.test.ts`
- Modify: `UI/src/store/index.ts` (the `sales` type)

**Interfaces:**
- **Produces:** `Snapshot["sales"]: Record<string, number>[]`. There is one record per day, oldest first (matching
  `dayLabels`), keyed by every Outlet-type location, closed ones included.

- [ ] **Step 1: Rewrite the two tests to the new shape**

In `documents.test.ts`, replace the test named "sales are 14 day-rows of 3 outlet columns…" with:

```ts
  it("sales are 14 day-records keyed by every outlet, closed ones included, with day-of-month labels", async () => {
    await t.db.update(s.locations).set({ active: false }).where(eq(s.locations.key, "kiosk"));
    try {
      const { sales, dayLabels } = await D.readSales(t.db, 14);
      expect(sales.length).toBe(14); expect(dayLabels.length).toBe(14);
      expect(sales.every((row) => Object.keys(row).sort().join() === "coffee,kiosk,rest")).toBe(true);
      const fxToday = (loc: string) => FX.seedBills.filter((b) => b.loc === loc).reduce((sum, b) => sum + b.tot, 0);
      expect(sales[13]).toEqual({ rest: fxToday("rest"), coffee: fxToday("coffee"), kiosk: fxToday("kiosk") });
    } finally {
      await t.db.update(s.locations).set({ active: true }).where(eq(s.locations.key, "kiosk"));
    }
  });
```

In `snapshot.test.ts`, replace the four `sales` lines after `// revenue is not master data` with:

```ts
    // revenue is not master data: the counter gets its own outlet's takings and nobody else's
    const full = await get("u2");
    expect(s.dayLabels).toEqual(full.dayLabels);
    expect(s.sales.length).toBe(full.sales.length);
    expect(s.sales.every((row: Record<string, number>) => Object.keys(row).join() === "coffee")).toBe(true);
    expect(s.sales.map((row: Record<string, number>) => row.coffee)).toEqual(full.sales.map((row: Record<string, number>) => row.coffee));
    expect(full.sales.some((row: Record<string, number>) => Object.keys(row).length > 1)).toBe(true);
```

- [ ] **Step 2: Run to verify they fail**

Run: `TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W --filter @rch/api exec vitest run src/modules/snapshot`

Expected: FAIL, because rows are still arrays.

- [ ] **Step 3: Implement**

In the contract `snapshot.ts`, add `Money` to the `./common.js` import. The `sales` line becomes:

```ts
  // One record per day, oldest first and matching `dayLabels`, keyed by outlet - closed outlets
  // included, since what a closed outlet took last week is still takings.
  sales: z.array(z.record(LocKeySchema, Money)),
```

In `readers/documents.ts`:
1. Remove the `OUTLETS` import.
2. Make sure `eq` and `asc` are imported from `drizzle-orm`. `s` is the schema namespace already used there.
3. Replace `readSales`'s signature and its last three lines with:

```ts
/** Day records (oldest first, today last), each keyed by every outlet, in the hospital's calendar. */
export async function readSales(db: Reader, days: number): Promise<{ sales: Record<string, number>[]; dayLabels: string[] }> {
  const outlets = await db.select({ key: s.locations.key }).from(s.locations).where(eq(s.locations.type, "Outlet")).orderBy(asc(s.locations.key));
  const rows = await db.select({
    // (unchanged select, including the void comment)
  }) /* unchanged from/where/groupBy */;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  const dayKeys = Array.from({ length: days }, (_, i) => fmt.format(new Date(Date.now() - (days - 1 - i) * 86400_000)));
  const sales = dayKeys.map((d) => Object.fromEntries(outlets.map(({ key }) => [key, Number(rows.find((r) => r.day === d && r.loc === key)?.total ?? 0)])));
  return { sales, dayLabels: dayKeys.map((d) => d.slice(8)) };
}
```

(Keep the existing `rows` query body exactly. Only the lines around it change.)

In `scope.ts`:
1. Remove the `OUTLETS` import.
2. Delete `const col = OUTLETS.indexOf(L);` and its comment.
3. The `sales:` line becomes:

```ts
    // `sales` is keyed by outlet, so handing it over whole tells a counter operator the whole
    // hospital's takings. Keep the shape (a record per day, matching dayLabels, which stay) and keep
    // only their own outlet - nothing at all if they are not on one.
    sales: base.sales.map((row) => (L in row ? { [L]: row[L] ?? 0 } : {})),
```

In `UI/src/store/index.ts`, line 46 becomes `sales: Record<string, number>[];`. Update its comment if it says
"columns".

- [ ] **Step 4: Run the tests, typecheck and the UI suite**

```bash
TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W --filter @rch/api exec vitest run src/modules/snapshot
pnpm -C $W turbo typecheck
pnpm -C $W --filter @rch/ui test
pnpm -C $W --filter @rch/contract test
```

Expected: PASS. If a UI test fixture builds `sales` as `number[][]` (for example `bare.test.tsx`), change it to
records with the same zeros.

- [ ] **Step 5: Commit**

Message: "Key each day's takings by outlet rather than by column position", followed by the trailers.

---

### Task 6: Admin outlet routes

**Files:**
- Modify: `packages/contract/src/schemas/admin.ts`, `packages/contract/src/types.ts`, `packages/contract/src/routes.ts`
- Modify: `packages/domain/src/locations.ts`, `packages/domain/src/locations.test.ts`, `packages/domain/src/index.ts`
- Modify: `apps/api/src/modules/admin/repo.ts`, `apps/api/src/modules/admin/service.ts`, `apps/api/src/modules/admin/routes.ts`
- Create: `apps/api/src/modules/admin/outlets.test.ts`
- Modify: `UI/src/pages/AdminUsers.tsx` (the `DID` record only, so the UI still typechecks)

**Interfaces:**
- **Consumes:**
  - `lockLocation` / `assertOpen` (Task 3)
  - `checkPairing` via `createUserTx` (Task 4)
  - `outletKeyFor` (Task 1)
  - `uniqueViolationOf` (Task 2)
- **Produces (contract):**
  - `AdminLocationSchema` / `AdminLocation`:
    `{ key, n, c, type, floor, cc, list?, active, staff }`
  - `CreateOutletBodySchema` / `CreateOutletBody`: `{ name, code, floor, cc, list }`
  - `UpdateOutletBodySchema` / `UpdateOutletBody`: the same fields, all optional
  - `OutletKeyParamsSchema`: `{ key: LocKey }`
  - `AdminActionsQuerySchema`: `{ kind: "accounts" | "outlets" }`, default `"accounts"`
  - `AdminActionSchema.action` gains `outlet_create`, `outlet_update`, `outlet_close`, `outlet_reopen`
  - routes `adminLocations` (`GET /admin/locations`), `createOutlet` (`POST /admin/outlets`), `updateOutlet`
    (`PATCH /admin/outlets/:key`), `closeOutlet` (`POST /admin/outlets/:key/close`), `reopenOutlet`
    (`POST /admin/outlets/:key/reopen`); `adminActions` gains `query`
- **Produces (domain):**
  - `HOLDS_OUTLET`
  - `holding<S extends string>(t: Record<S, boolean>): S[]`
  - `type OutletBlockers = { stock: number; tickets: number; requests: number; kitchenOrders: number; shopAsks: number; productRequests: number; staff: string[] }`
  - `closeRefusal(name: string, b: OutletBlockers): string | null`

- [ ] **Step 1: Write the failing domain tests**

Append to `packages/domain/src/locations.test.ts`, extending the import with `closeRefusal`, `holding` and
`HOLDS_OUTLET`:

```ts
describe("HOLDS_OUTLET", () => {
  it("counts a document as holding an outlet until it is settled", () => {
    expect(holding(HOLDS_OUTLET.ticket)).toEqual(["Issued", "Collected"]);
    expect(holding(HOLDS_OUTLET.request)).toEqual(["Draft", "Request sent", "Manager approved", "Partially approved", "Ticket issued", "Collected", "Received"]);
    // A dispatched order and a sent ask each keep an undo edge in their transition tables, but the
    // ticket they raised is what holds the outlet now - so neither is open here.
    expect(holding(HOLDS_OUTLET.prodOrder)).toEqual(["New", "Accepted", "In kitchen", "Ready"]);
    expect(holding(HOLDS_OUTLET.shopAsk)).toEqual(["Asked"]);
    expect(holding(HOLDS_OUTLET.productReq)).toEqual(["Requested"]);
  });
});

describe("closeRefusal", () => {
  const none = { stock: 0, tickets: 0, requests: 0, kitchenOrders: 0, shopAsks: 0, productRequests: 0, staff: [] };
  it("has nothing to say about an outlet nothing depends on", () => {
    expect(closeRefusal("Juice Bar", none)).toBeNull();
  });
  it("names the one thing left", () => {
    expect(closeRefusal("Juice Bar", { ...none, tickets: 2 })).toBe("Refused - Juice Bar still has 2 open tickets");
    expect(closeRefusal("Juice Bar", { ...none, stock: 1 })).toBe("Refused - Juice Bar still has stock on hand (1 item)");
  });
  it("names every blocker at once, singular for one, the last joined with and", () => {
    expect(closeRefusal("Juice Bar", { stock: 3, tickets: 1, requests: 1, kitchenOrders: 2, shopAsks: 1, productRequests: 1, staff: ["RC-4483", "RC-4484"] }))
      .toBe("Refused - Juice Bar still has stock on hand (3 items), 1 open ticket, 1 open stock request, 2 open kitchen orders, 1 open shop ask, 1 open product request and 2 active staff (RC-4483, RC-4484)");
  });
});
```

- [ ] **Step 2: Implement the domain additions**

Append to `packages/domain/src/locations.ts`, extending the type import with `ProductReqStatus`, `PordStatus`,
`ReqStatus`, `ShopAskStatus` and `TktStatus`:

```ts
/**
 * Which statuses still commit an outlet to something - the documents a close has to wait for.
 *
 * Not read off the transition tables: a dispatched kitchen order and a sent shop ask each keep an
 * undo edge there, yet the ticket each one raised is what holds the outlet from then on. Each record
 * is exhaustive over its closed union, so a status added later fails typecheck here until somebody
 * decides whether it holds an outlet open.
 */
export const HOLDS_OUTLET = {
  request: {
    Draft: true, "Request sent": true, "Manager approved": true, "Partially approved": true, "Ticket issued": true,
    Collected: true, Received: true, Closed: false, Rejected: false, Cancelled: false,
  } satisfies Record<ReqStatus, boolean>,
  ticket: { Issued: true, Collected: true, Received: false, Cancelled: false } satisfies Record<TktStatus, boolean>,
  prodOrder: { New: true, Accepted: true, "In kitchen": true, Ready: true, Dispatched: false, Declined: false } satisfies Record<PordStatus, boolean>,
  shopAsk: { Asked: true, Sent: false, Declined: false } satisfies Record<ShopAskStatus, boolean>,
  productReq: { Requested: true, Created: false, Declined: false } satisfies Record<ProductReqStatus, boolean>,
};

/** The statuses a `HOLDS_OUTLET` record marks as holding, in the record's own order. */
export const holding = <S extends string>(t: Record<S, boolean>): S[] => (Object.keys(t) as S[]).filter((s) => t[s]);

/** What still depends on an outlet, counted by the server under the close's own row lock. */
export type OutletBlockers = {
  stock: number; tickets: number; requests: number; kitchenOrders: number; shopAsks: number; productRequests: number;
  /** Employee numbers of the active accounts based there. */
  staff: string[];
};

/**
 * The close's refusal - every blocker in one sentence, the shape the dispatch rule refuses in, so the
 * admin clears the list once rather than learning it one refusal at a time. `null` when nothing is
 * left and the outlet may close.
 */
export function closeRefusal(name: string, b: OutletBlockers): string | null {
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const parts = [
    b.stock > 0 && `stock on hand (${count(b.stock, "item")})`,
    b.tickets > 0 && count(b.tickets, "open ticket"),
    b.requests > 0 && count(b.requests, "open stock request"),
    b.kitchenOrders > 0 && count(b.kitchenOrders, "open kitchen order"),
    b.shopAsks > 0 && count(b.shopAsks, "open shop ask"),
    b.productRequests > 0 && count(b.productRequests, "open product request"),
    b.staff.length > 0 && `${b.staff.length} active staff (${b.staff.join(", ")})`,
  ].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Refused - ${name} still has ${list}`;
}
```

In `index.ts`, extend the locations export with `closeRefusal`, `holding`, `HOLDS_OUTLET` and
`type OutletBlockers`.

Run: `pnpm -C $W --filter @rch/domain test`

Expected: PASS at ≥ 99 / 92.

- [ ] **Step 3: Add the contract schemas and routes**

Append to `packages/contract/src/schemas/admin.ts`:
1. Change the import from `./common.js` to include `PriceListSchema`.
2. Add `import { LocationSchema } from "./documents.js";`.
3. In `AdminActionSchema`, extend `action` with `"outlet_create", "outlet_update", "outlet_close", "outlet_reopen"`.
4. Append:

```ts
// ---- outlets. Opened, edited, closed and reopened by the super admin; never deleted.

/** A location as the admin page manages it: the wire `Location` plus its key, whether it still
 *  trades, and how many active accounts are based there - the number a close waits on. The store and
 *  the kitchen are listed too, because the Accounts tab labels every home location from this and an
 *  admin token reaches no other location read. Quarantine never is: nobody is based there. */
export const AdminLocationSchema = z.strictObject({
  key: LocKeySchema, n: z.string(), c: z.string(), type: LocationSchema.shape.type,
  floor: z.string(), cc: z.string(), list: PriceListSchema.optional(), active: z.boolean(),
  staff: z.number().int().min(0),
});
const outletFields = {
  name: z.string().trim().min(2).max(40),
  /** Printed on labels and upper-cased on the way in, so `ot-jb` and `OT-JB` are one code. */
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,12}$/, "A code is 2-12 letters, digits or dashes"),
  floor: z.string().trim().min(1).max(40),
  cc: z.string().trim().min(1).max(40),
  list: PriceListSchema,
};
/** No `key`: the server gives an outlet its key, from its name, once (`outletKeyFor`). */
export const CreateOutletBodySchema = z.strictObject(outletFields);
/** Any of the same fields. One that changes nothing is refused by the service, in words. */
export const UpdateOutletBodySchema = z.strictObject(outletFields).partial();
export const OutletKeyParamsSchema = z.strictObject({ key: LocKeySchema });
/** The account feed and the outlet feed are one log read two ways, so each tab shows its own fifty. */
export const AdminActionsQuerySchema = z.strictObject({ kind: z.enum(["accounts", "outlets"]).default("accounts") });
```

In `types.ts`, add:

```ts
export type AdminLocation = z.infer<typeof A.AdminLocationSchema>;
export type CreateOutletBody = z.infer<typeof A.CreateOutletBodySchema>;
export type UpdateOutletBody = z.infer<typeof A.UpdateOutletBodySchema>;
```

In `routes.ts`:
1. Extend the admin import with `AdminActionsQuerySchema, AdminLocationSchema, CreateOutletBodySchema, OutletKeyParamsSchema, UpdateOutletBodySchema`.
2. Give `adminActions` `query: AdminActionsQuerySchema,`.
3. Append after `adminActions`:

```ts
  // ---- admin: outlets. Opened, edited, closed and reopened here and nowhere else - never deleted
  // (root CLAUDE.md). The store and the kitchen are fixed: the outlet routes answer 404 for either.
  adminLocations:        defineRoute({ method: "GET",   path: "/admin/locations",                 access: "admin", response: z.array(AdminLocationSchema) }),
  createOutlet:          defineRoute({ method: "POST",  path: "/admin/outlets",                    access: "admin", body: CreateOutletBodySchema, response: writeResponse(AdminLocationSchema) }),
  updateOutlet:          defineRoute({ method: "PATCH", path: "/admin/outlets/:key",               access: "admin", params: OutletKeyParamsSchema, body: UpdateOutletBodySchema, response: writeResponse(AdminLocationSchema) }),
  closeOutlet:           defineRoute({ method: "POST",  path: "/admin/outlets/:key/close",         access: "admin", params: OutletKeyParamsSchema, response: writeResponse(AdminLocationSchema) }),
  reopenOutlet:          defineRoute({ method: "POST",  path: "/admin/outlets/:key/reopen",        access: "admin", params: OutletKeyParamsSchema, response: writeResponse(AdminLocationSchema) }),
```

In `UI/src/pages/AdminUsers.tsx`, extend `DID` so the UI keeps typechecking:

```ts
  outlet_create: "opened", outlet_update: "edited", outlet_close: "closed", outlet_reopen: "reopened",
```

- [ ] **Step 4: Write the failing API test**

Create `apps/api/src/modules/admin/outlets.test.ts`. Read `src/test/builders.ts` for the exact `given.*`
parameter names, and `src/lib/events.test.ts` for how a test listens for a change notice. Mirror both.

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { App } from "../../app.js";
import { buildTestApp } from "../../test/app.js";
import { truncateAll } from "../../test/db.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { adminActions, locations, users } from "../../db/schema/index.js";

/** u7 (RC-0001) is the seeded super admin; u2 is the outlet manager, u1 a counter at the Coffee Shop. */
let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "admin_outlets" }); await app.ready(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });
afterAll(async () => { await app.close(); });

const as = async (id: string, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { ...(await authHeaders(app, id)), ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }) }, payload });
const admin = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => as("u7", method, url, payload);
const JUICE = { name: "Juice Bar", code: "ot-jb", floor: "Ground", cc: "CC-JB", list: "A" };
const open = async (body: Record<string, unknown> = JUICE) => {
  const r = await admin("POST", "/admin/outlets", body);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().result as { key: string; n: string };
};

describe("GET /admin/locations", () => {
  it("lists the store, the kitchen and every outlet by name, with who is based at each, and never quarantine", async () => {
    const r = await admin("GET", "/admin/locations");
    expect(r.statusCode, r.body).toBe(200);
    const rows = r.json() as { key: string; staff: number; active: boolean }[];
    expect(rows.map((l) => l.key)).toEqual(["kitchen", "store", "coffee", "rest", "kiosk"]);
    // The super admin's own placeholder location is not a posting: it is not counted.
    expect(Object.fromEntries(rows.map((l) => [l.key, l.staff]))).toEqual({ kitchen: 1, store: 2, coffee: 1, rest: 1, kiosk: 1 });
    expect(rows.every((l) => l.active)).toBe(true);
  });
  it("is a 404 to anyone without the flag", async () => {
    expect((await as("u2", "GET", "/admin/locations")).statusCode).toBe(404);
  });
});

describe("POST /admin/outlets", () => {
  it("opens an outlet with a key from its name, an upper-cased code and the default par factor, and logs it", async () => {
    const r = await admin("POST", "/admin/outlets", JUICE);
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json();
    expect(j.result).toEqual({ key: "juice-bar", n: "Juice Bar", c: "OT-JB", type: "Outlet", floor: "Ground", cc: "CC-JB", list: "A", active: true, staff: 0 });
    expect(j.changed).toEqual(["outlets", "locations"]);
    expect(j.message).toBe("Opened Juice Bar (OT-JB) on price list A.");
    const [row] = await app.db.select().from(locations).where(eq(locations.key, "juice-bar"));
    expect(row).toMatchObject({ parFactor: 0.18, sellable: true, active: true });
    const feed = (await admin("GET", "/admin/actions?kind=outlets")).json() as { action: string; target: string; details: Record<string, unknown> }[];
    expect(feed[0]).toMatchObject({ action: "outlet_create", target: "Juice Bar", details: { key: "juice-bar", code: "OT-JB", list: "A" } });
    expect(((await admin("GET", "/admin/actions")).json() as { action: string }[]).some((a) => a.action.startsWith("outlet_"))).toBe(false);
  });
  it("refuses a name or a code another location already has, whatever the case", async () => {
    const byName = await admin("POST", "/admin/outlets", { ...JUICE, name: "restaurant" });
    expect(byName.statusCode).toBe(409);
    expect(byName.json().error.message).toBe("Refused - a location named restaurant already exists");
    const byCode = await admin("POST", "/admin/outlets", { ...JUICE, code: "ot-r1" });
    expect(byCode.statusCode).toBe(409);
    expect(byCode.json().error.message).toBe("Refused - code OT-R1 is already in use");
  });
  it("steps past a key already taken", async () => {
    expect((await open({ ...JUICE, name: "Rest", code: "OT-RS" })).key).toBe("rest-2");
  });
  it("refuses a malformed body at the door", async () => {
    expect((await admin("POST", "/admin/outlets", { ...JUICE, name: "J" })).statusCode).toBe(400);
    expect((await admin("POST", "/admin/outlets", { ...JUICE, code: "OT JB" })).statusCode).toBe(400);
    expect((await admin("POST", "/admin/outlets", { ...JUICE, key: "juice" })).statusCode).toBe(400);
  });
});

describe("PATCH /admin/outlets/:key", () => {
  it("renames an outlet and moves its price list without touching its key, and logs what changed", async () => {
    await open();
    const r = await admin("PATCH", "/admin/outlets/juice-bar", { name: "Juice Hut", list: "B" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result).toMatchObject({ key: "juice-bar", n: "Juice Hut", list: "B" });
    expect(r.json().message).toBe("Saved Juice Hut.");
    const [line] = await app.db.select().from(adminActions).where(eq(adminActions.action, "outlet_update"));
    expect(line.details).toEqual({ key: "juice-bar", name: ["Juice Bar", "Juice Hut"], list: ["A", "B"] });
  });
  it("refuses an edit that changes nothing", async () => {
    await open();
    const r = await admin("PATCH", "/admin/outlets/juice-bar", { name: "Juice Bar" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Nothing to save - Juice Bar already reads that way");
  });
  it("does not reach the store or the kitchen", async () => {
    const r = await admin("PATCH", "/admin/outlets/store", { name: "Main Store" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no outlet store.");
  });
});

describe("closing and reopening", () => {
  it("closes an outlet nothing depends on, keeps it listed, and reopens it", async () => {
    await open({ ...JUICE, name: "Tea Stall", code: "OT-TS" });
    const closed = await admin("POST", "/admin/outlets/tea-stall/close");
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().result.active).toBe(false);
    expect(closed.json().message).toBe("Closed Tea Stall. Its bills and reports are kept.");
    expect((await admin("POST", "/admin/outlets/tea-stall/close")).json().error.message).toBe("Tea Stall is already closed");
    const reopened = await admin("POST", "/admin/outlets/tea-stall/reopen");
    expect(reopened.json().result.active).toBe(true);
    expect(reopened.json().message).toBe("Reopened Tea Stall.");
    expect((await admin("POST", "/admin/outlets/tea-stall/reopen")).json().error.message).toBe("Tea Stall is already open");
  });
  it("refuses to close while anything still depends on the outlet, naming all of it at once", async () => {
    const { key } = await open();
    const hire = await admin("POST", "/admin/users", { name: "Arun P", email: "arun.p@royalcare.in", role: "counter", loc: key });
    expect(hire.statusCode, hire.body).toBe(200);
    const adj = await as("u2", "POST", "/adjustments", { loc: key, reason: "count", lines: [{ it: "juice", qty: 4 }] });
    expect(adj.statusCode, adj.body).toBe(200);
    const db = app.testDb!.db;
    await given.ticket(db, { refType: "shop_transfer", refId: "Shop transfer", from: "coffee", to: key, lines: [{ it: "chips", qty: 2 }] });
    await given.request(db, { from: key, lines: [{ it: "juice", qty: 5 }] });
    await given.prodOrder(db, { from: key });
    await given.shopAsk(db, { from: key, to: "coffee", it: "chips", qty: 1 });
    await given.productRequest(db, { name: "Mango lassi", forLoc: key });
    const r = await admin("POST", `/admin/outlets/${key}/close`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`Refused - Juice Bar still has stock on hand (1 item), 1 open ticket, 1 open stock request, 1 open kitchen order, 1 open shop ask, 1 open product request and 1 active staff (${hire.json().result.emp})`);
    const [row] = await app.db.select().from(locations).where(eq(locations.key, key));
    expect(row.active).toBe(true);
  });
  it("puts no new staff at a closed outlet", async () => {
    const { key } = await open({ ...JUICE, name: "Tea Stall", code: "OT-TS" });
    await admin("POST", `/admin/outlets/${key}/close`);
    const r = await admin("POST", "/admin/users", { name: "Arun P", email: "arun.p@royalcare.in", role: "counter", loc: key });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe("Counter Operator works at an open outlet - Tea Stall is closed");
  });
});

describe("an outlet opened after release", () => {
  it("sells end to end, and its takings reach the manager's snapshot and its own counter's alone", async () => {
    const { key } = await open();
    const hire = (await admin("POST", "/admin/users", { name: "Arun P", email: "arun.p@royalcare.in", role: "counter", loc: key })).json().result;
    await app.db.update(users).set({ mustChangePassword: false }).where(eq(users.id, hire.id));
    expect((await as("u2", "POST", `/menus/${key}/items`, { it: "juice" })).statusCode).toBe(200);
    expect((await as("u2", "POST", "/adjustments", { loc: key, reason: "count", lines: [{ it: "juice", qty: 5 }] })).statusCode).toBe(200);
    const sale = await as(hire.id, "POST", "/bills", { loc: key, tender: "Cash", lines: [{ it: "juice", qty: 2 }] });
    expect(sale.statusCode, sale.body).toBe(200);
    const manager = (await as("u2", "GET", "/snapshot")).json();
    expect(manager.locations[key]).toMatchObject({ n: "Juice Bar", type: "Outlet", active: true, par: 0.18 });
    expect(manager.menu[key]).toContain("juice");
    expect(manager.sales.at(-1)[key]).toBe(sale.json().result.tot);
    const counter = (await as(hire.id, "GET", "/snapshot")).json();
    expect(Object.keys(counter.stock)).toEqual([key]);
    expect(counter.sales.every((row: Record<string, number>) => Object.keys(row).join() === key)).toBe(true);
  });
});
```

Add one more case in the style of `src/lib/events.test.ts`. It subscribes to the schema's channel, opens an
outlet, and asserts that a notice with `collections: ["outlets", "locations"]` arrives.

Run: `TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W --filter @rch/api exec vitest run src/modules/admin/outlets.test.ts`

Expected: FAIL. The routes aren't mounted, so the manifest check fails or requests 404.

- [ ] **Step 5: Implement the repo**

Append to `apps/api/src/modules/admin/repo.ts`:
- Imports:
  - `and`, `inArray`, `like`, `ne`, `notLike`, `or` from `drizzle-orm`
  - `locations`, `prodOrders`, `productRequests`, `shopAsks`, `stockBalances`, `stockRequests`, `tickets` from the
    schema
  - `QUARANTINE` from `@rch/contract`
  - `HOLDS_OUTLET`, `holding` and `type OutletBlockers` from `@rch/domain`
- Add `export type LocationRow = typeof locations.$inferSelect;`.
- Change `recentActions` to take `kind` and filter on it.

```ts
  /** Every location but the rejected-goods shelf, by name, each with the active ordinary accounts
   *  based there. The super admin's own row carries a placeholder location and is not counted. */
  async locations(db: Reader): Promise<Array<LocationRow & { staff: number }>> {
    const rows = await db.select().from(locations).where(ne(locations.key, QUARANTINE)).orderBy(asc(locations.name), asc(locations.key));
    const posted = await db.select({ loc: users.loc, n: sql<number>`count(*)::int` }).from(users)
      .where(and(eq(users.active, true), eq(users.admin, false))).groupBy(users.loc);
    const staff = new Map(posted.map((p) => [p.loc, Number(p.n)]));
    return rows.map((r) => ({ ...r, staff: staff.get(r.key) ?? 0 }));
  },
  async locationKeys(tx: Tx): Promise<string[]> {
    return (await tx.select({ key: locations.key }).from(locations)).map((r) => r.key);
  },
  async locationForUpdate(tx: Tx, key: string): Promise<LocationRow | undefined> {
    return (await tx.select().from(locations).where(eq(locations.key, key)).for("update"))[0];
  },
  async staffAt(tx: Tx, key: string): Promise<string[]> {
    const rows = await tx.select({ emp: users.empNo }).from(users)
      .where(and(eq(users.loc, key), eq(users.active, true), eq(users.admin, false))).orderBy(asc(users.empNo));
    return rows.map((r) => r.emp);
  },
  /** Serialises outlet creation: the key is read from the table and then written to it, and two
   *  opens at once must not both read it free. `SHARE ROW EXCLUSIVE` conflicts with itself and with
   *  row writes, but not with the `FOR SHARE` row locks every sale takes. */
  async lockForOpening(tx: Tx): Promise<void> {
    await tx.execute(sql`lock table locations in share row exclusive mode`);
  },
  async insertOutlet(tx: Tx, row: typeof locations.$inferInsert): Promise<void> {
    await tx.insert(locations).values(row);
  },
  async updateLocation(tx: Tx, key: string, set: Partial<Pick<LocationRow, "name" | "code" | "floor" | "costCentre" | "priceList" | "active">>): Promise<void> {
    await tx.update(locations).set(set).where(eq(locations.key, key));
  },
  /** Everything a close waits on, counted under the close's own row lock. "Open" is `HOLDS_OUTLET`. */
  async closeBlockers(tx: Tx, key: string): Promise<OutletBlockers> {
    const n = (r: { n: number }[]) => Number(r[0]?.n ?? 0);
    const count = sql<number>`count(*)::int`;
    const stock = n(await tx.select({ n: count }).from(stockBalances).where(and(eq(stockBalances.loc, key), ne(stockBalances.onHand, 0))));
    const tkts = n(await tx.select({ n: count }).from(tickets).where(and(or(eq(tickets.fromLoc, key), eq(tickets.toLoc, key)), inArray(tickets.status, holding(HOLDS_OUTLET.ticket)))));
    const requests = n(await tx.select({ n: count }).from(stockRequests).where(and(eq(stockRequests.fromLoc, key), inArray(stockRequests.status, holding(HOLDS_OUTLET.request)))));
    const kitchenOrders = n(await tx.select({ n: count }).from(prodOrders).where(and(eq(prodOrders.fromLoc, key), inArray(prodOrders.status, holding(HOLDS_OUTLET.prodOrder)))));
    const asks = n(await tx.select({ n: count }).from(shopAsks).where(and(or(eq(shopAsks.fromLoc, key), eq(shopAsks.toLoc, key)), inArray(shopAsks.status, holding(HOLDS_OUTLET.shopAsk)))));
    const productReqs = n(await tx.select({ n: count }).from(productRequests).where(and(eq(productRequests.forLoc, key), inArray(productRequests.status, holding(HOLDS_OUTLET.productReq)))));
    const staff = await adminRepo.staffAt(tx, key);
    return { stock, tickets: tkts, requests, kitchenOrders, shopAsks: asks, productRequests: productReqs, staff };
  },
```

(Queries run one after another. A transaction is one pg client, per the `lib/master.ts` note. `adminRepo` is the
object being defined, so reference it as `this.staffAt` only if the object uses method syntax consistently.
Otherwise inline the `staffAt` query.)

`recentActions(db: Reader, kind: "accounts" | "outlets")`: add
`.where(kind === "outlets" ? like(adminActions.action, "outlet_%") : notLike(adminActions.action, "outlet_%"))`
before `.orderBy`. Update its doc comment to say it reads one of the two feeds.

- [ ] **Step 6: Implement the service**

In `apps/api/src/modules/admin/service.ts`:
1. Extend the contract type import with `AdminLocation`, `CreateOutletBody`, `UpdateOutletBody`.
2. Import `closeRefusal` and `outletKeyFor` from `@rch/domain`.
3. Import `emitChanged` from `../../lib/events.js`, `uniqueViolationOf` from `../../lib/db.js`, and `ConflictError`
   from `../../lib/errors.js`.
4. Import `type LocationRow` from `./repo.js`.
5. Update the header comment. Account writes still don't announce themselves. Outlet writes do, because every
   operational browser reads the location master.

Add above `createAdminService`:

```ts
const toAdminLocation = (r: LocationRow, staff: number): AdminLocation => ({
  key: r.key, n: r.name, c: r.code, type: r.type, floor: r.floor, cc: r.costCentre,
  ...(r.priceList ? { list: r.priceList } : {}), active: r.active, staff,
});

/** The two unique indexes, as the sentence the admin reads. Caught rather than checked first, so
 *  two saves racing each other get the same sentence the check would have given. */
async function refuseClash<T>(write: () => Promise<T>, next: { name: string; code: string }): Promise<T> {
  try {
    return await write();
  } catch (e) {
    const clash = uniqueViolationOf(e);
    if (clash === "locations_name_uq") throw new ConflictError(`Refused - a location named ${next.name} already exists`);
    if (clash === "locations_code_uq") throw new ConflictError(`Refused - code ${next.code} is already in use`);
    throw e;
  }
}

/** The fields an edit may change, as the body names them and as the row holds them. */
const EDITABLE = [["name", "name"], ["code", "code"], ["floor", "floor"], ["cc", "costCentre"], ["list", "priceList"]] as const;
const OUTLET_CHANGED = ["outlets", "locations"] as const;
```

Inside the returned object:

```ts
    async locations(): Promise<AdminLocation[]> {
      return (await adminRepo.locations(db)).map((r) => toAdminLocation(r, r.staff));
    },

    async openOutlet(claims: AccessClaims, body: CreateOutletBody): Promise<WriteResponse<AdminLocation>> {
      return withTransaction(db, async (tx) => {
        await adminRepo.lockForOpening(tx);
        const key = outletKeyFor(body.name, await adminRepo.locationKeys(tx));
        await refuseClash(() => adminRepo.insertOutlet(tx, {
          key, name: body.name, code: body.code, type: "Outlet", floor: body.floor, costCentre: body.cc,
          priceList: body.list, sellable: true,
        }), body);
        await log(tx, claims.sub, "outlet_create", { id: null, name: body.name }, { key, code: body.code, list: body.list });
        await emitChanged(tx, OUTLET_CHANGED);
        const row = await requireOutletTx(tx, key);
        return { result: toAdminLocation(row, 0), changed: [...OUTLET_CHANGED], message: `Opened ${body.name} (${body.code}) on price list ${body.list}.` };
      });
    },

    async updateOutlet(claims: AccessClaims, key: string, body: UpdateOutletBody): Promise<WriteResponse<AdminLocation>> {
      return withTransaction(db, async (tx) => {
        const row = await requireOutletTx(tx, key);
        const changes: Record<string, [unknown, unknown]> = {};
        for (const [field, column] of EDITABLE) {
          const next = body[field];
          if (next !== undefined && next !== row[column]) changes[field] = [row[column], next];
        }
        if (Object.keys(changes).length === 0) throw new RuleError(`Nothing to save - ${row.name} already reads that way`);
        const next = { name: body.name ?? row.name, code: body.code ?? row.code };
        await refuseClash(() => adminRepo.updateLocation(tx, key, {
          name: next.name, code: next.code, floor: body.floor ?? row.floor, costCentre: body.cc ?? row.costCentre, priceList: body.list ?? row.priceList,
        }), next);
        await log(tx, claims.sub, "outlet_update", { id: null, name: next.name }, { key, ...changes });
        await emitChanged(tx, OUTLET_CHANGED);
        const fresh = await requireOutletTx(tx, key);
        return { result: toAdminLocation(fresh, (await adminRepo.staffAt(tx, key)).length), changed: [...OUTLET_CHANGED], message: `Saved ${fresh.name}.` };
      });
    },

    /** Closed, never deleted. The row is locked `FOR UPDATE` first: every write that names this
     *  outlet holds it `FOR SHARE` (`lib/locations.ts`), so a sale in flight commits before the
     *  blockers are counted, and one that starts afterwards reads the outlet closed. */
    async closeOutlet(claims: AccessClaims, key: string): Promise<WriteResponse<AdminLocation>> {
      return withTransaction(db, async (tx) => {
        const row = await requireOutletTx(tx, key);
        if (!row.active) throw new RuleError(`${row.name} is already closed`);
        const refusal = closeRefusal(row.name, await adminRepo.closeBlockers(tx, key));
        if (refusal) throw new RuleError(refusal);
        await adminRepo.updateLocation(tx, key, { active: false });
        await log(tx, claims.sub, "outlet_close", { id: null, name: row.name }, { key });
        await emitChanged(tx, OUTLET_CHANGED);
        return { result: toAdminLocation({ ...row, active: false }, 0), changed: [...OUTLET_CHANGED], message: `Closed ${row.name}. Its bills and reports are kept.` };
      });
    },

    async reopenOutlet(claims: AccessClaims, key: string): Promise<WriteResponse<AdminLocation>> {
      return withTransaction(db, async (tx) => {
        const row = await requireOutletTx(tx, key);
        if (row.active) throw new RuleError(`${row.name} is already open`);
        await adminRepo.updateLocation(tx, key, { active: true });
        await log(tx, claims.sub, "outlet_reopen", { id: null, name: row.name }, { key });
        await emitChanged(tx, OUTLET_CHANGED);
        return { result: toAdminLocation({ ...row, active: true }, 0), changed: [...OUTLET_CHANGED], message: `Reopened ${row.name}.` };
      });
    },
```

Beside `requireTx` inside `createAdminService`:

```ts
  /** Locked `FOR UPDATE`, and only an outlet: the store and the kitchen are fixed, so an outlet route
   *  naming either reads as a route that does not exist for them. */
  const requireOutletTx = async (tx: Tx, key: string): Promise<LocationRow> => {
    const row = await adminRepo.locationForUpdate(tx, key);
    if (!row || row.type !== "Outlet") throw new NotFoundError(`There is no outlet ${key}.`);
    return row;
  };
```

Change `actions()` to `actions(kind: "accounts" | "outlets")`, passing `kind` through.

Wire the routes in `apps/api/src/modules/admin/routes.ts`:

```ts
  mount(app, routes.adminActions, async (req) => svc.actions(req.query.kind));
  mount(app, routes.adminLocations, async () => svc.locations());
  mount(app, routes.createOutlet, async (req) => svc.openOutlet(req.user, req.body));
  mount(app, routes.updateOutlet, async (req) => svc.updateOutlet(req.user, req.params.key, req.body));
  mount(app, routes.closeOutlet, async (req) => svc.closeOutlet(req.user, req.params.key));
  mount(app, routes.reopenOutlet, async (req) => svc.reopenOutlet(req.user, req.params.key));
```

Update the file's header comment to say the module covers account management and outlets.

- [ ] **Step 7: Run the tests, then everything the change touches**

```bash
TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W --filter @rch/api exec vitest run src/modules/admin
TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W --filter @rch/api test
pnpm -C $W --filter @rch/contract test
pnpm -C $W --filter @rch/domain test
pnpm -C $W turbo typecheck
pnpm -C $W --filter @rch/ui test
pnpm -C $W --filter @rch/api lint
pnpm -C $W check:boundaries
```

Expected: all pass. If the end-to-end sale's `tot` differs from the day's total (because of rounding or tax),
compare against the snapshot's value for the bill's `no` via `manager.bills` instead. The assertion is that the
new outlet's takings are keyed under its key.

- [ ] **Step 8: Commit**

Message: "Let the super admin open, edit, close and reopen outlets", followed by the trailers.

---

### Task 7: The browser reads outlets from the master

**Files:**
- Modify: `UI/src/data/master.ts` (add `hydrateLocations`)
- Modify: `UI/src/lib/selectors.ts`
- Modify: `UI/src/api/wire.ts` (add `applyLocations`, `applyAdminLocations`; `applyAdminActions` gains `kind`)
- Modify: `UI/src/api/refetch.ts` (`locations` and `outlets` readers)
- Modify: `UI/src/store/admin.ts`
- Create: `UI/src/__tests__/outlets-data.test.ts`

**Interfaces:**
- **Consumes:** the Task 6 routes, `outletKeys` / `operationalKeys` / `parFactor` (Task 1).
- **Produces:**
  - `openOutlets(): LocKey[]`
  - `allOutlets(): LocKey[]`
  - `operationalLocs(): LocKey[]`
  - `locName(l: string): string`: the name, suffixed ` (closed)` for a closed outlet, or the key when `LOC`
    doesn't carry it.
  - Store `adminLocations: AdminLocation[]` and `outletActions: Dated<AdminAction>[]`.
  - `loadAdminLocations(): Promise<void>`
  - `loadAdminActions(kind?: "accounts" | "outlets"): Promise<void>`
  - `createOutlet(body: CreateOutletBody): Promise<AdminLocation | null>`
  - `updateOutlet(key: string, body: UpdateOutletBody): Promise<boolean>`
  - `setOutletOpen(key: string, open: boolean): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

Create `UI/src/__tests__/outlets-data.test.ts`. Copy the fetch stub (`json`, `serve`, `hit`) and the
`setAccessToken` / `vi.stubGlobal("fetch", …)` setup from `admin-accounts.test.tsx` lines 1–70, and its
`beforeEach` / `afterEach`.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as FX from "@rch/contract/fixtures";
import { LOC } from "../data/master";
import { allOutlets, locName, openOutlets, operationalLocs, parOf } from "../lib/selectors";
import { refetch } from "../api/refetch";
import { useApp } from "../store";
import { as, resetStore } from "./fixture";
// + the json/serve/hit helpers and fetch setup copied from admin-accounts.test.tsx

beforeEach(resetStore);

describe("outlets, read from the master", () => {
  it("lists the open outlets by name, and every outlet for a filter over history", () => {
    expect(openOutlets()).toEqual(["coffee", "rest", "kiosk"]);
    LOC.kiosk = { ...LOC.kiosk, active: false };
    expect(openOutlets()).toEqual(["coffee", "rest"]);
    expect(allOutlets()).toEqual(["coffee", "rest", "kiosk"]);
    expect(locName("kiosk")).toBe("Snack Kiosk (closed)");
    expect(locName("rest")).toBe("Restaurant");
    expect(locName("juice-bar")).toBe("juice-bar");
    expect(operationalLocs()).toEqual(["store", "kitchen", "coffee", "rest"]);
  });
  it("sizes a par level from the factor the location carries", () => {
    const it0 = Object.keys(FX.IT).find((k) => FX.IT[k].rl > 0 && FX.IT[k].u !== "nos")!;
    expect(parOf(it0, "rest")).toBeCloseTo(FX.IT[it0].rl * 0.22, 3);
  });
});

describe("a change to the locations", () => {
  const JUICE = { n: "Juice Bar", c: "OT-JB", type: "Outlet", floor: "Ground", cc: "CC-JB", list: "A", active: true, par: 0.18 };
  it("pulls the location master back for an operational session and puts the new outlet in every picker", async () => {
    act(() => { as("manager"); });
    serve({ "GET /api/v1/locations": () => json({ ...FX.LOC, "juice-bar": JUICE }) });
    const before = useApp.getState().catalogVersion;
    await refetch(["locations"]);
    expect(openOutlets()).toContain("juice-bar");
    expect(useApp.getState().stock["juice-bar"]).toEqual({});
    expect(useApp.getState().catalogVersion).toBe(before + 1);
  });
  it("reads nothing for the super admin, whose token reaches no location read but its own", async () => {
    useApp.setState({ user: { ...FX.USERS.find((u) => u.admin)! } });
    serve({});
    await refetch(["locations"]);
    expect(hit("GET /api/v1/locations")).toHaveLength(0);
  });
  it("pulls the admin's own list back on `outlets`, and nobody else's session reads it", async () => {
    useApp.setState({ user: { ...FX.USERS.find((u) => u.admin)! } });
    serve({ "GET /api/v1/admin/locations": () => json([{ key: "juice-bar", n: "Juice Bar", c: "OT-JB", type: "Outlet", floor: "Ground", cc: "CC-JB", list: "A", active: true, staff: 0 }]) });
    await refetch(["outlets"]);
    expect(useApp.getState().adminLocations.map((l) => l.key)).toEqual(["juice-bar"]);
    act(() => { as("manager"); });
    fetchMock.mockClear();
    await refetch(["outlets"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the admin store's outlet writes", () => {
  beforeEach(() => { useApp.setState({ user: { ...FX.USERS.find((u) => u.admin)! } }); });
  it("opens an outlet, repeats the server's sentence and refetches its list", async () => {
    const row = { key: "juice-bar", n: "Juice Bar", c: "OT-JB", type: "Outlet", floor: "Ground", cc: "CC-JB", list: "A", active: true, staff: 0 };
    serve({
      "POST /api/v1/admin/outlets": () => json({ result: row, changed: ["outlets", "locations"], message: "Opened Juice Bar (OT-JB) on price list A." }),
      "GET /api/v1/admin/locations": () => json([row]),
    });
    expect(await useApp.getState().createOutlet({ name: "Juice Bar", code: "OT-JB", floor: "Ground", cc: "CC-JB", list: "A" })).toEqual(row);
    expect(useApp.getState().toast?.msg ?? useApp.getState().toast).toContain("Opened Juice Bar (OT-JB) on price list A.");
    expect(useApp.getState().adminLocations).toEqual([row]);
  });
  it("hands back the refusal as the toast and nothing else", async () => {
    serve({ "POST /api/v1/admin/outlets/kiosk/close": () => json({ error: { code: "rule", message: "Refused - Snack Kiosk still has 1 active staff (RC-4482)" } }, 422) });
    expect(await useApp.getState().setOutletOpen("kiosk", false)).toBe(false);
    expect(JSON.stringify(useApp.getState().toast)).toContain("Refused - Snack Kiosk still has 1 active staff (RC-4482)");
  });
});
```

(Read how `toast` is shaped in `store/index.ts` and assert on it the way `admin-accounts.test.tsx` does. Replace
the two `toast` lines with that file's idiom. Import `act` from `react` if `as()` needs it, as the other tests do.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C $W --filter @rch/ui exec vitest run src/__tests__/outlets-data.test.ts`

Expected: FAIL, because the selectors, readers and slice members don't exist.

- [ ] **Step 3: Implement**

`UI/src/data/master.ts`, beside `hydrateItems`:

```ts
/** Just the location master, for a write that opened, edited, closed or reopened an outlet
 *  (`changed: ["locations"]`). Screens hold `LOC` by reference, so it is replaced in place. */
export function hydrateLocations(locations: MasterData["locations"]): void { replaceKeys(LOC, locations); }
```

`UI/src/lib/selectors.ts`:
1. Replace the `PAR_FACTOR` import with `import { operationalKeys, outletKeys, parFactor } from "@rch/domain";`,
   and update the comment above it.
2. `parOf`'s factor line becomes `const f = parFactor(LOC, l);`.
3. Add near the other location helpers:

```ts
/** The outlets a new document may name - open ones, by name - read from the location master, never
 *  from a list compiled into the bundle. A picker that *starts* something uses this. */
export const openOutlets = (): LocKey[] => outletKeys(LOC, { open: true });
/** Every outlet, closed ones too, for a filter over what already happened: a closed outlet's bills
 *  are still bills. */
export const allOutlets = (): LocKey[] => outletKeys(LOC);
/** Where an operator works today: the store, the kitchen, the open outlets. */
export const operationalLocs = (): LocKey[] => operationalKeys(LOC);
/** A location as a filter or a table prints it - a closed outlet says so. */
export const locName = (l: string): string => {
  const at = LOC[l];
  if (!at) return l;
  return at.active === false ? `${at.n} (closed)` : at.n;
};
```

`UI/src/api/wire.ts`:
1. Import `hydrateLocations`.
2. Import the types `AdminLocation`.
3. Add:

```ts
/** GET /locations -> the location master, in place, and a map for any location the stock does not
 *  carry yet. `catalogVersion` is what tells React the registry changed underneath it. */
export function applyLocations(locations: Snapshot["locations"]): void {
  hydrateLocations(locations);
  useApp.setState((prev) => ({ catalogVersion: prev.catalogVersion + 1, stock: stockOf(prev.stock) }));
}
/** GET /admin/locations -> the admin page's list. */
export function applyAdminLocations(adminLocations: AdminLocation[]): void { useApp.setState({ adminLocations }); }
```

4. `applyAdminActions` becomes:

```ts
export function applyAdminActions(rows: AdminAction[], kind: "accounts" | "outlets" = "accounts"): void {
  useApp.setState(kind === "outlets" ? { outletActions: rows.map(stamped) } : { adminActions: rows.map(stamped) });
}
```

`UI/src/api/refetch.ts`:
1. Import `applyAdminLocations` and `applyLocations`.
2. Add to `NARROW`, after `accounts`:

```ts
  // ---- outlets. One change, read two ways: an operational session pulls back the location master
  // every screen lists outlets from; the super admin, whose token reaches no location read but its
  // own, pulls back the admin list. Each reader does nothing for the other session.
  locations: () => useApp.getState().user?.admin ? Promise.resolve() : call(routes.locations).then(applyLocations),
  outlets: () => useApp.getState().user?.admin ? call(routes.adminLocations).then(applyAdminLocations) : Promise.resolve(),
```

3. Add `locations`, `outlets` to the long comment's list of collections.

`UI/src/store/admin.ts`:
1. Import `applyAdminLocations` from `../api/wire`.
2. Import the types `AdminLocation`, `CreateOutletBody`, `UpdateOutletBody`.
3. Extend `AdminSlice`:

```ts
  /** Every location but quarantine, with who is based at each - the Outlets tab's table and the
   *  Accounts tab's location labels both read this. */
  adminLocations: AdminLocation[];
  outletActions: Dated<AdminAction>[];
  loadAdminLocations: () => Promise<void>;
  /** The server's row for the new outlet, or `null` on a refusal - the form then stays as typed. */
  createOutlet: (body: CreateOutletBody) => Promise<AdminLocation | null>;
  updateOutlet: (key: string, body: UpdateOutletBody) => Promise<boolean>;
  /** Close and reopen, one action both ways, like `setAccountActive`. */
  setOutletOpen: (key: string, open: boolean) => Promise<boolean>;
```

4. Change `loadAdminActions`'s type to `(kind?: "accounts" | "outlets") => Promise<void>`.

Implementation, in the slice's existing style:

```ts
  adminLocations: [],
  outletActions: [],
  loadAdminLocations: async () => {
    try { applyAdminLocations(await call(routes.adminLocations)); }
    catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not read the outlets - check the connection and try again."); }
  },
  loadAdminActions: async (kind = "accounts") => {
    try { applyAdminActions(await call(routes.adminActions, { query: { kind } }), kind); }
    catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not read recent admin actions - check the connection and try again."); }
  },
  createOutlet: async (body) => {
    try {
      const r = await call(routes.createOutlet, { body });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return r.result;
    } catch (e) { fail(get, e, "open the outlet"); return null; }
  },
  updateOutlet: async (key, body) => {
    try {
      const r = await call(routes.updateOutlet, { params: { key }, body });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save the outlet"); }
  },
  setOutletOpen: async (key, open) => {
    try {
      const r = open
        ? await call(routes.reopenOutlet, { params: { key } })
        : await call(routes.closeOutlet, { params: { key } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, open ? "reopen the outlet" : "close the outlet"); }
  },
```

(Replace the existing `loadAdminActions` with the version above. Check `call`'s input shape for a query in
`api/client.ts`. If it isn't `{ query }`, use whatever `routes.bills` callers pass.)

- [ ] **Step 4: Run the tests and the UI suite**

```bash
pnpm -C $W --filter @rch/ui exec vitest run src/__tests__/outlets-data.test.ts
pnpm -C $W --filter @rch/ui test
pnpm -C $W --filter @rch/ui typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

Message: "Read outlets in the browser from the location master, and keep it live", followed by the trailers.

---

### Task 8: Operational screens stop listing outlets from a constant

**Files:**
- Modify: `UI/src/ui/Shell.tsx:398`
- Modify: `UI/src/roles/prod/Availability.tsx:78`, `UI/src/roles/prod/Orders.tsx:62,160,164`, `UI/src/roles/prod/MakeDistribute.tsx:14`
- Modify: `UI/src/roles/manager/Availability.tsx`, `Approvals.tsx:43`, `ItemsStock.tsx`, `Dashboard.tsx`, `Prices.tsx`, `KitchenOrderDrawer.tsx`
- Modify: `UI/src/roles/counter/Requests.tsx:72`
- Modify: `UI/src/roles/store/IssueDesk.tsx:32`, `UI/src/roles/store/Adjustments.tsx`
- Modify: `UI/src/roles/buyer/Inventory.tsx`
- Modify: `UI/src/__tests__/screens.test.tsx`
- Create: `UI/src/__tests__/outlets-screens.test.tsx`

**Interfaces:**
- **Consumes:** `openOutlets`, `allOutlets`, `operationalLocs`, `locName` (Task 7).
- **Produces:** no screen imports `OUTLETS` or `ALL_LOCS`.

The replacement rule is below. Apply it to every hit of
`git -C $W grep -n "OUTLETS\|ALL_LOCS" -- UI/src/roles UI/src/ui`:

| Where | Replace with | Why |
|---|---|---|
| A picker or column that **starts or shows live** work: `Shell.tsx` avail count; `prod/Availability`; `manager/Availability` (all); `counter/Requests` peers; `manager/ItemsStock` home outlet, shop filter and menu `<select>`, the "{N} counters" prose; `manager/Dashboard` outlet cards and outlet filter; `manager/Prices` (all); `manager/KitchenOrderDrawer` | `openOutlets()` | A closed outlet can take nothing new. |
| Membership tests over **existing documents**: `manager/Dashboard` and `manager/ItemsStock` `transfers` filters (`OUTLETS.includes(t.from) && OUTLETS.includes(t.to)`) | `allOutlets()` | A ticket raised before a close is still a shop transfer. |
| Filters over **history**: `manager/Approvals` outlet names; `prod/Orders` outlet filter and the "·"-joined list | `allOutlets()`, printed with `locName(l)` | A closed outlet's past documents stay findable. |
| `ALL_LOCS` in `prod/MakeDistribute` (`DESTS`), `store/IssueDesk` (`LOC_OPTS`), `buyer/Inventory`, `manager/ItemsStock` | `operationalLocs()` | These are the places an operator works today. |
| `store/Adjustments.tsx` `SHELVES` | `[...operationalLocs(), QUARANTINE]`, computed inside the component, with a non-empty guard | The store keeper adjusts every shelf, and a closed outlet was emptied to close. |

Mechanics:
- **Module-level constants move into the component body.** For example, `const DESTS: LocKey[] = ALL_LOCS.filter(…)`
  at module scope must become a value computed during render. The outlet set changes at runtime, and the module
  initialises before the snapshot lands. If the constant is exported (`DESTS` in `MakeDistribute.tsx`), check
  its importers with `git grep -n "DESTS"` and turn it into a function, `export const dests = (): LocKey[] => …`.
- **Names that compared on `LOC[l].n`** now compare on `locName(l)` wherever the list is `allOutlets()`, so a
  closed outlet prints as `<name> (closed)` in both the option and the comparison.
- **The `AdjustmentForm` tuple:**
  `const [first, ...rest] = [...operationalLocs(), QUARANTINE]; const shelves: [StockLoc, ...StockLoc[]] = [first ?? QUARANTINE, ...rest];`
  (the array always holds at least `QUARANTINE`).
- **Comments:** delete or rewrite any that describe `OUTLETS` as "a deployment constant" or "never empty in this
  hospital" (`Prices.tsx:18–24`, `ItemsStock.tsx:45–47`, `KitchenOrderDrawer.tsx:21–24`). The accurate sentence
  is that outlets come from `LOC`, which is empty until the snapshot lands, and a closed one isn't offered.

- [ ] **Step 1: Write the failing screen test**

Create `UI/src/__tests__/outlets-screens.test.tsx`. Use `screens.test.tsx`'s `mount` / `as` helpers; read its
first 120 lines and copy its imports and `mount`.

```tsx
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { LOC } from "../data/master";
import { useApp } from "../store";
import { screens as manager } from "../roles/manager";
import { screens as counter } from "../roles/counter";
import { as, resetStore } from "./fixture";
// + `mount` exactly as screens.test.tsx defines it

const JUICE = { n: "Juice Bar", c: "OT-JB", type: "Outlet" as const, floor: "Ground", cc: "CC-JB", list: "A" as const, active: true, par: 0.18 };

beforeEach(resetStore);

describe("an outlet opened after release", () => {
  it("is a column on the manager's availability board and an outlet a counter may ask", () => {
    LOC["juice-bar"] = JUICE;
    act(() => { as("manager"); useApp.setState((s) => ({ stock: { ...s.stock, "juice-bar": {} }, menu: { ...s.menu, "juice-bar": [] } })); });
    expect(mount(manager.availability).text()).toContain("Juice Bar");
    act(() => { as("counter"); });
    expect(mount(counter.requests).text()).toContain("Juice Bar");
  });
});

describe("a closed outlet", () => {
  it("is offered nowhere new, but still filters the manager's approvals", () => {
    LOC.kiosk = { ...LOC.kiosk, active: false };
    act(() => { as("manager"); });
    expect(mount(manager.availability).text()).not.toContain("Snack Kiosk");
    expect(mount(manager.approvals).text()).toContain("Snack Kiosk (closed)");
  });
});
```

(Use the screen keys the role registries actually export. Read `UI/src/roles/manager/index.ts` and
`UI/src/roles/counter/index.ts`.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C $W --filter @rch/ui exec vitest run src/__tests__/outlets-screens.test.tsx`

Expected: FAIL. Juice Bar is not a column, and the kiosk still shows as open.

- [ ] **Step 3: Apply the replacement table to every hit, then fix `screens.test.tsx`**

In `screens.test.tsx`:
- **The tests that `OUTLETS.splice(...)` to simulate a one-outlet hospital** (around lines 1111–1121 and 1182–1193)
  now simulate it on `LOC`. Save `LOC.rest` and `LOC.kiosk`, `delete` both, and restore them in `finally`. The
  expectations (`No other outlet to ask`, `covers Coffee Shop`) stay.
- **The "before the locations have landed" test** (about 1196–1211) deletes every outlet from `LOC` and restores
  them. Its comment changes to say that outlets are read from `LOC`, which is empty before the snapshot.
- **Line 676's comment and expectation** assume the drawer opens on the Restaurant. It opens on the first open
  outlet by name, which is the Coffee Shop. Update both to Coffee Shop, and adjust any stock or menu assertion in
  that test to the Coffee Shop's fixtures.
- **Remove `OUTLETS`** from the `../data/master` import.

- [ ] **Step 4: Run the UI suite, typecheck and lint**

```bash
pnpm -C $W --filter @rch/ui test
pnpm -C $W --filter @rch/ui typecheck
pnpm -C $W --filter @rch/ui lint
git -C $W grep -n "OUTLETS\|ALL_LOCS" -- UI/src/roles UI/src/ui
```

Expected:
- tests pass with floors met;
- typecheck and lint are clean;
- the grep prints nothing.

- [ ] **Step 5: Commit**

Message: "List outlets on every operational screen from the master, and offer no closed one", followed by the
trailers.

---

### Task 9: The Outlets tab

**Files:**
- Create: `UI/src/pages/AdminOutlets.tsx`
- Modify: `UI/src/pages/AdminDashboard.tsx`
- Modify: `UI/src/pages/AdminUsers.tsx` (location labels and pickers from `adminLocations`)
- Modify: `UI/src/pages/AdminSupport.tsx` (location labels from `adminLocations`)
- Create: `UI/src/__tests__/admin-outlets.test.tsx`
- Modify: `UI/src/__tests__/admin-accounts.test.tsx` (stub `GET /admin/locations`; add a picker case)

**Interfaces:**
- **Consumes:** `adminLocations`, `outletActions`, `loadAdminLocations`, `loadAdminActions("outlets")`,
  `createOutlet`, `updateOutlet`, `setOutletOpen` (Task 7), and `outletKeyFor` / `placesFor` (Task 1).
- **Produces:** the `/admin` Outlets tab. `AdminUsers` and `AdminSupport` no longer declare `LOC_LABEL` or
  `WORKS_AT`.

- [ ] **Step 1: Write the failing page test**

Create `UI/src/__tests__/admin-outlets.test.tsx`. It uses `admin-accounts.test.tsx`'s harness (the `json`,
`serve`, `hit`, `tick`, `mountPage`, `press` helpers and its `beforeEach` / `afterEach`), mounting
`AdminOutlets` instead of `AdminUsers`.

```tsx
const row = (over: Partial<AdminLocation>): AdminLocation => ({
  key: "rest", n: "Restaurant", c: "OT-R1", type: "Outlet", floor: "Floor 1", cc: "CC-RST", list: "A", active: true, staff: 1, ...over,
});
const STORE_ROW = row({ key: "store", n: "Central Store", c: "WH-CS", type: "Store", floor: "Basement", cc: "CC-STO", list: undefined, staff: 2 });
const REST = row({});
const KIOSK = row({ key: "kiosk", n: "Snack Kiosk", c: "OT-GK", floor: "Ground", cc: "CC-KSK", active: false, staff: 0 });
const ok = (result: AdminLocation, message: string) => () => json({ result, changed: ["outlets", "locations"], message });

describe("the Outlets tab", () => {
  it("lists outlets only - open ones first - with their code, list, staff and status", async () => {
    serve({ "GET /api/v1/admin/locations": () => json([STORE_ROW, KIOSK, REST]), "GET /api/v1/admin/actions": () => json([]) });
    page = await mountPage();
    const rows = [...document.querySelectorAll("tbody tr")].map((tr) => tr.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Restaurant"); expect(rows[0]).toContain("OT-R1"); expect(rows[0]).toContain("Open");
    expect(rows[1]).toContain("Snack Kiosk"); expect(rows[1]).toContain("Closed");
    expect(page.text()).not.toContain("Central Store");
    expect(hit("GET /api/v1/admin/actions")[0][0]).toContain("kind=outlets");
  });
  it("previews the key a new outlet will get, opens it, and clears the form", async () => {
    const JUICE = row({ key: "juice-bar", n: "Juice Bar", c: "OT-JB", floor: "Ground", cc: "CC-JB", staff: 0 });
    serve({
      "GET /api/v1/admin/locations": () => json([REST]), "GET /api/v1/admin/actions": () => json([]),
      "POST /api/v1/admin/outlets": ok(JUICE, "Opened Juice Bar (OT-JB) on price list A."),
    });
    page = await mountPage();
    await typeInto(page.field("Name"), "Juice Bar");
    await typeInto(page.field("Code"), "ot-jb");
    await typeInto(page.field("Floor"), "Ground");
    await typeInto(page.field("Cost centre"), "CC-JB");
    expect(page.text()).toContain("juice-bar");
    await press(page.button("Open outlet"));
    const [, init] = hit("POST /api/v1/admin/outlets")[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: "Juice Bar", code: "ot-jb", floor: "Ground", cc: "CC-JB", list: "A" });
    expect(page.field("Name").value).toBe("");
  });
  it("keeps the form as typed when the server refuses", async () => {
    serve({
      "GET /api/v1/admin/locations": () => json([REST]), "GET /api/v1/admin/actions": () => json([]),
      "POST /api/v1/admin/outlets": () => json({ error: { code: "conflict", message: "Refused - a location named Restaurant already exists" } }, 409),
    });
    page = await mountPage();
    await typeInto(page.field("Name"), "Restaurant");
    await typeInto(page.field("Code"), "OT-R9");
    await typeInto(page.field("Floor"), "G");
    await typeInto(page.field("Cost centre"), "CC");
    await press(page.button("Open outlet"));
    expect(page.field("Name").value).toBe("Restaurant");
  });
  it("edits a row in place and sends only what changed", async () => {
    serve({
      "GET /api/v1/admin/locations": () => json([REST]), "GET /api/v1/admin/actions": () => json([]),
      "PATCH /api/v1/admin/outlets/rest": ok({ ...REST, n: "Main Restaurant" }, "Saved Main Restaurant."),
    });
    page = await mountPage();
    await press(page.button("Edit", page.row("OT-R1")));
    await typeInto(page.row("OT-R1").querySelector<HTMLInputElement>('input[aria-label="Name for OT-R1"]')!, "Main Restaurant");
    await press(page.button("Save", page.row("OT-R1")));
    const [, init] = hit("PATCH /api/v1/admin/outlets/rest")[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: "Main Restaurant" });
  });
  it("closes behind a second press, and reopens in one", async () => {
    serve({
      "GET /api/v1/admin/locations": () => json([REST, KIOSK]), "GET /api/v1/admin/actions": () => json([]),
      "POST /api/v1/admin/outlets/rest/close": ok({ ...REST, active: false }, "Closed Restaurant. Its bills and reports are kept."),
      "POST /api/v1/admin/outlets/kiosk/reopen": ok({ ...KIOSK, active: true }, "Reopened Snack Kiosk."),
    });
    page = await mountPage();
    await press(page.button("Close", page.row("OT-R1")));
    expect(hit("POST /api/v1/admin/outlets/rest/close")).toHaveLength(0);
    await press(page.button("Close Restaurant", page.row("OT-R1")));
    expect(hit("POST /api/v1/admin/outlets/rest/close")).toHaveLength(1);
    await press(page.button("Reopen", page.row("OT-GK")));
    expect(hit("POST /api/v1/admin/outlets/kiosk/reopen")).toHaveLength(1);
  });
});
```

`typeInto` is a small helper. Set the value through the native setter and dispatch `input`, the way
`admin-accounts.test.tsx` fills its fields. Copy theirs, or add:

```ts
const typeInto = async (el: HTMLInputElement, v: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
```

In `admin-accounts.test.tsx`:
1. Add `"GET /api/v1/admin/locations": () => json(LOCS)` to every `serve({...})`, where `LOCS` is the five
   `AdminLocation` rows for store, kitchen, rest, coffee and kiosk.
2. Add this case:

```tsx
  it("offers a counter every open outlet the admin list carries, and no closed one", async () => {
    serve({ /* the file's usual stubs */ "GET /api/v1/admin/locations": () => json([...LOCS, row({ key: "juice-bar", n: "Juice Bar", c: "OT-JB" }), row({ key: "tea", n: "Tea Stall", c: "OT-TS", active: false })]) });
    page = await mountPage();
    const options = [...page.field("Location").querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toContain("Juice Bar");
    expect(options).not.toContain("Tea Stall");
  });
```

(`mountPage` there mounts `AdminUsers` alone. The page loads `adminLocations` itself on mount; see Step 3.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -C $W --filter @rch/ui exec vitest run src/__tests__/admin-outlets.test.tsx src/__tests__/admin-accounts.test.tsx`

Expected: FAIL. `AdminOutlets` doesn't exist, and the Accounts picker is still static.

- [ ] **Step 3: Build the page and rewire the two existing tabs**

Create `UI/src/pages/AdminOutlets.tsx`:

```tsx
import { useEffect, useState } from "react";
import { PriceListSchema } from "@rch/contract";
import { outletKeyFor } from "@rch/domain";
import { useApp } from "../store";
import { Btn, Card, DataTable, Field, FormRow, PageHead, Pill, TableFoot } from "../ui/kit";
import type { AdminAction, AdminLocation, CreateOutletBody, UpdateOutletBody } from "../types";

/** How each logged outlet action reads in the feed - "System Administrator closed Snack Kiosk". */
const DID: Partial<Record<AdminAction["action"], string>> = {
  outlet_create: "opened", outlet_update: "edited", outlet_close: "closed", outlet_reopen: "reopened",
};

const emptyForm: CreateOutletBody = { name: "", code: "", floor: "", cc: "", list: "A" };
type Draft = { name: string; code: string; floor: string; cc: string; list: "A" | "B" };
const draftOf = (l: AdminLocation): Draft => ({ name: l.n, code: l.c, floor: l.floor, cc: l.cc, list: l.list ?? "A" });

/**
 * The hospital's retail outlets - opened, edited, closed and reopened here and nowhere else. An outlet
 * is closed, never deleted: its bills, moves and reports stay, and the server refuses a close while
 * anything still depends on it, naming all of it at once. The store and the kitchen are fixed and are
 * not listed. Every rule is the server's; this page previews the key and repeats the server's words.
 */
export default function AdminOutlets() {
  const locations = useApp((s) => s.adminLocations);
  const actions = useApp((s) => s.outletActions);
  const loadAdminLocations = useApp((s) => s.loadAdminLocations);
  const loadAdminActions = useApp((s) => s.loadAdminActions);
  const createOutlet = useApp((s) => s.createOutlet);
  const updateOutlet = useApp((s) => s.updateOutlet);
  const setOutletOpen = useApp((s) => s.setOutletOpen);
  const notify = useApp((s) => s.notify);

  useEffect(() => { void loadAdminLocations(); void loadAdminActions("outlets"); }, [loadAdminLocations, loadAdminActions]);

  const [form, setForm] = useState<CreateOutletBody>(emptyForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, Draft>>({});
  /** The one row whose Close has been pressed once and is waiting for the second press. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const outlets = locations
    .filter((l) => l.type === "Outlet")
    .sort((a, b) => Number(!a.active) - Number(!b.active) || a.n.localeCompare(b.n));
  // A preview only: the server gives the key inside the open's own transaction, with the same rule.
  const keyPreview = form.name.trim() ? outletKeyFor(form.name, locations.map((l) => l.key)) : "";

  const open = async () => {
    if (!form.name.trim() || !form.code.trim() || !form.floor.trim() || !form.cc.trim()) {
      notify("Give the outlet a name, a code, a floor and a cost centre before opening it");
      return;
    }
    setBusy("create");
    try { if (await createOutlet(form)) setForm(emptyForm); } finally { setBusy(null); }
  };

  const save = async (l: AdminLocation) => {
    const d = editing[l.key];
    if (!d) return;
    const was = draftOf(l);
    const body: UpdateOutletBody = {};
    if (d.name !== was.name) body.name = d.name;
    if (d.code !== was.code) body.code = d.code;
    if (d.floor !== was.floor) body.floor = d.floor;
    if (d.cc !== was.cc) body.cc = d.cc;
    if (d.list !== was.list) body.list = d.list;
    setBusy(l.key);
    try {
      if (await updateOutlet(l.key, body)) setEditing((e) => { const n = { ...e }; delete n[l.key]; return n; });
    } finally { setBusy(null); }
  };

  const toggle = async (l: AdminLocation) => {
    setBusy(l.key);
    try { if (await setOutletOpen(l.key, !l.active)) setConfirming(null); } finally { setBusy(null); }
  };

  const cell = (l: AdminLocation, field: keyof Draft, label: string) => {
    const d = editing[l.key];
    if (!d) return field === "name" ? l.n : field === "code" ? <span className="mono">{l.c}</span> : field === "cc" ? l.cc : field === "list" ? `List ${l.list ?? "-"}` : l.floor;
    if (field === "list") {
      return (
        <select aria-label={`${label} for ${l.c}`} value={d.list} onChange={(e) => setEditing({ ...editing, [l.key]: { ...d, list: e.target.value as Draft["list"] } })}>
          {PriceListSchema.options.map((p) => <option key={p} value={p}>List {p}</option>)}
        </select>
      );
    }
    return <input aria-label={`${label} for ${l.c}`} value={d[field]} onChange={(e) => setEditing({ ...editing, [l.key]: { ...d, [field]: e.target.value } })} />;
  };

  return (
    <>
      <PageHead crumbs={["Admin"]} title="Manage outlets" sub="The hospital's retail outlets, and whether each one is open." />

      <Card title="Open an outlet" sub="It starts with an empty menu - the outlet manager lists its products, and staff are posted to it from Accounts">
        <FormRow cols="f3">
          <Field label="Name" hint={keyPreview ? <>Key <span className="mono">{keyPreview}</span> - given once, and kept through a rename</> : undefined}>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Code"><input className="mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
          <Field label="Price list">
            <select value={form.list} onChange={(e) => setForm({ ...form, list: e.target.value as CreateOutletBody["list"] })}>
              {PriceListSchema.options.map((p) => <option key={p} value={p}>List {p}</option>)}
            </select>
          </Field>
        </FormRow>
        <FormRow cols="f2">
          <Field label="Floor"><input value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} /></Field>
          <Field label="Cost centre"><input value={form.cc} onChange={(e) => setForm({ ...form, cc: e.target.value })} /></Field>
        </FormRow>
        <Btn wide disabled={busy === "create"} onClick={() => void open()}>{busy === "create" ? "Opening…" : "Open outlet"}</Btn>
      </Card>

      <Card title="Every outlet" sub={`${outlets.filter((l) => l.active).length} open`} flush className="mtop">
        <DataTable
          cols={[
            { h: "Name", w: "18%" }, { h: "Code", w: "10%" }, { h: "Floor", w: "12%" }, { h: "Cost centre", w: "12%" },
            { h: "List", w: "8%" }, { h: "Staff", w: "7%", r: true }, { h: "Status", w: "9%" }, { h: "Actions" },
          ]}
          rows={outlets.map((l) => ({
            key: l.key,
            cells: [
              cell(l, "name", "Name"), cell(l, "code", "Code"), cell(l, "floor", "Floor"), cell(l, "cc", "Cost centre"), cell(l, "list", "Price list"),
              <>{l.staff}</>,
              l.active ? <Pill tone="ok">Open</Pill> : <Pill tone="mu">Closed</Pill>,
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {editing[l.key] ? (
                  <>
                    <Btn size="xs" disabled={busy === l.key} onClick={() => void save(l)}>{busy === l.key ? "Saving…" : "Save"}</Btn>
                    <Btn size="xs" variant="gh" disabled={busy === l.key} onClick={() => setEditing((e) => { const n = { ...e }; delete n[l.key]; return n; })}>Cancel</Btn>
                  </>
                ) : confirming === l.key ? (
                  // The second press, in place of the row's other actions: closing an outlet takes it
                  // off every till and picker at once.
                  <>
                    <Btn size="xs" variant="dg" disabled={busy === l.key} onClick={() => void toggle(l)}>{busy === l.key ? "Closing…" : `Close ${l.n}`}</Btn>
                    <Btn size="xs" variant="gh" disabled={busy === l.key} onClick={() => setConfirming(null)}>Keep open</Btn>
                  </>
                ) : (
                  <>
                    <Btn size="xs" disabled={busy === l.key} onClick={() => setEditing({ ...editing, [l.key]: draftOf(l) })}>Edit</Btn>
                    {l.active
                      ? <Btn size="xs" variant="dg" disabled={busy === l.key} onClick={() => setConfirming(l.key)}>Close</Btn>
                      : <Btn size="xs" variant="ok" disabled={busy === l.key} onClick={() => void toggle(l)}>Reopen</Btn>}
                  </>
                )}
              </div>,
            ],
          }))}
          empty={{ title: "No outlets yet", sub: "Open the first one above." }}
        />
        <TableFoot count={outlets.length} />
      </Card>

      <Card title="Recent actions" sub="The last fifty - who opened, edited, closed or reopened what" className="mtop">
        {actions.length === 0 ? <p className="mini">Nothing has happened here yet.</p> : (
          <ul className="feed">
            {actions.map((a, i) => (
              <li key={i} className="mini"><b>{a.actor}</b> {DID[a.action] ?? a.action} <b>{a.target}</b> · {a.at}</li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
```

Check `Col` in `ui/kit.tsx` for the right-align key (`r: true` is used in `buyer/Inventory.tsx`). If a
`DataTable` cell can't be a string, wrap strings in fragments the way `AdminUsers` does.

`UI/src/pages/AdminDashboard.tsx`:
1. Import `AdminOutlets`.
2. `type Tab = "accounts" | "outlets" | "support";`
3. Load the locations at the dashboard so every tab has labels:
   `const loadAdminLocations = useApp((s) => s.loadAdminLocations);` and add `void loadAdminLocations();` inside
   the existing `useEffect`, with the dependency.
4. Add an Outlets tab button between Accounts and Support desk, in the same markup as Accounts.
5. The body becomes
   `{tab === "accounts" ? <AdminUsers /> : tab === "outlets" ? <AdminOutlets /> : <AdminSupport />}`.
6. Update the doc comment from "Two tabs" to three: staff accounts, outlets, and the support desk.

`UI/src/pages/AdminUsers.tsx`:
1. Delete `WORKS_AT` and `LOC_LABEL`, and the `OUTLETS` import.
2. Import `placesFor` from `@rch/domain`. Read `adminLocations` and `loadAdminLocations` from the store, and call
   `loadAdminLocations()` in the mount effect beside the other two loads (the page is also mounted alone in tests).
3. Build, in the component body:

```tsx
  // Labels and pickers from the server's own list: a location the admin opened a minute ago is here,
  // and a closed outlet reads as closed. The pairing itself is the server's (`worksAt`); this only
  // keeps the picker from offering what would plainly be refused.
  const LOCS = Object.fromEntries(adminLocations.map((l) => [l.key, { n: l.n, type: l.type, active: l.active }]));
  const label = (key: string) => { const l = LOCS[key]; return !l ? key : l.active === false ? `${l.n} (closed)` : l.n; };
  /** Where this role may be posted - and, for an account already somewhere it no longer may be
   *  (a closed outlet), that place too, so its row still shows where it is. */
  const places = (role: Role, current?: string) => {
    const ok = placesFor(role, LOCS);
    return current && !ok.includes(current) ? [current, ...ok] : ok;
  };
```

4. Replace every `WORKS_AT[r]` with `placesFor(r, LOCS)`:
   - in the create form's role `onChange`: `loc: placesFor(role, LOCS).includes(form.loc) ? form.loc : placesFor(role, LOCS)[0] ?? ""`;
   - in the row's role `onChange`, the same shape.
5. Every option list uses `places(role, a.loc)` in a row and `placesFor(form.role, LOCS)` in the create form.
6. Every `LOC_LABEL[x]` becomes `label(x)`.
7. `emptyForm.loc` becomes `"" as LocKey`. Before rendering the create form's select, use
   `const formLoc = form.loc || placesFor(form.role, LOCS)[0] || "";` as its `value`, and send `formLoc` in
   `create()`.

`UI/src/pages/AdminSupport.tsx`:
1. Delete `LOC_LABEL` and the module-level `LOC_FILTERS`.
2. In the component, read `adminLocations` from the store, and define
   `const locLabel = (key: string) => adminLocations.find((l) => l.key === key)?.n ?? key;` and
   `const LOC_FILTERS = ["All", ...adminLocations.map((l) => l.n)];`.
3. Replace each `LOC_LABEL[t.loc]` with `locLabel(t.loc)`.

(A support ticket raised from quarantine can't exist, so the list is complete.)

- [ ] **Step 4: Run the tests, the UI suite, typecheck and lint**

```bash
pnpm -C $W --filter @rch/ui exec vitest run src/__tests__/admin-outlets.test.tsx src/__tests__/admin-accounts.test.tsx
pnpm -C $W --filter @rch/ui test
pnpm -C $W --filter @rch/ui typecheck
pnpm -C $W --filter @rch/ui lint
```

Expected: all pass, with coverage ≥ 73 lines / 51 branches.

- [ ] **Step 5: See it work**

Start the stack against the worktree's database, then drive `/admin` in a browser with the `run` skill or the
Playwright tools:
- create a dev database `rch` on 5440;
- run `db:migrate`;
- run `db:seed` with the demo data;
- run the API on `PORT=3011` and the UI with its proxy pointed at it.

Sign in as RC-0001 and:
1. Open "Juice Bar" and check it appears in the table.
2. Try to close the Snack Kiosk and read the refusal toast.
3. Open Accounts and check Juice Bar is in the counter's location picker.
4. Close Juice Bar, then reopen it.

Save screenshots to the scratchpad. **Only local databases: never the live box.**

- [ ] **Step 6: Commit**

Message: "Add the Outlets tab to the admin page, and label accounts and tickets from the live location list",
followed by the trailers.

---

### Task 10: Remove the compiled-in lists

**Files:**
- Modify: `packages/contract/src/schemas/common.ts` (delete `ALL_LOCS`, `OUTLETS`)
- Modify: `packages/contract/src/schemas/documents.ts` (`active`, `par` required)
- Modify: `packages/contract/src/fixtures/master.ts` (comment on quarantine)
- Modify: `packages/domain/src/par.ts`, `par.test.ts`, `index.ts` (delete `PAR_FACTOR`)
- Modify: `UI/src/data/master.ts` (drop the re-export)
- Modify: `UI/src/roles/store/Adjustments.tsx` if Task 8 left `ALL_LOCS` there
- Modify: `apps/api/src/db/seed.ts` (`seedLocations` fallbacks; the `seedDatabase` doc comment)
- Modify: `UI/src/__tests__/procurement.test.ts:29–40`, `UI/src/__tests__/bare.test.tsx` (comment),
  `apps/api/src/db/seed-bare.test.ts` (comment)
- Modify: every remaining comment that names `OUTLETS`, `ALL_LOCS`, `PAR_FACTOR`, `WORKS_AT` or "closed union"
  about locations (`apps/api/src/modules/snapshot/scope.ts:91–92`, `UI/src/ui/AdjustmentForm.tsx`, …)

- [ ] **Step 1: Rewrite the pinning test first**

In `UI/src/__tests__/procurement.test.ts`, replace the "carries the five working locations…" test with:

```ts
  it("works at the store, the kitchen and the open outlets, and reports stock at quarantine too", () => {
    // Quarantine is somewhere stock can *be*, never somewhere an operator works, so no screen that
    // iterates the working locations grows a column for it.
    expect(operationalLocs()).toEqual(["store", "kitchen", "coffee", "rest", "kiosk"]);
    expect(operationalLocs()).not.toContain("quarantine");
    expect(Object.keys(LOC).sort()).toEqual([...operationalLocs(), "quarantine"].sort());
    expect(Object.keys(S().stock)).toContain("quarantine");
```

Keep the rest of the test body. Import `operationalLocs` from `../lib/selectors` and drop `ALL_LOCS`. In
`packages/domain/src/par.test.ts`, delete the `PAR_FACTOR` describe block and its import.

- [ ] **Step 2: Delete the lists and make the location fields required**

1. **`common.ts`:** delete `ALL_LOCS`, `OUTLETS`, their comments, and the `type LocKey` alias if it's now unused.
2. **`documents.ts`:** `active: z.boolean(), par: z.number().positive(),`. The comment says the server always sends
   both.
3. **`par.ts`:**
   - Delete `PAR_FACTOR`.
   - Move the reasoning from its doc comment (a full day at the store, a fraction at a shop, and why it lives in
     the domain) onto `parFactor`.
   - In `index.ts`, export only `parFactor`.
4. **`UI/src/data/master.ts`:** `export { PO_APPROVAL_LIMIT } from "@rch/contract";`.
5. **`seed.ts`:** in `seedLocations`, use `active: l.active, parFactor: l.par`. Rewrite the `seedDatabase` doc
   comment's sentence about locations: the six locations are seeded so a bare hospital starts with the store, the
   kitchen, the rejected-goods shelf and the three outlets it opened with; more are opened from `/admin`.
6. **Fixtures:** the quarantine comment should say nothing is sold, issued, transferred or distributed from there,
   so no screen that lists the working locations shows it.

- [ ] **Step 3: Grep gates**

```bash
git -C $W grep -n "OUTLETS\|ALL_LOCS\|PAR_FACTOR\|WORKS_AT\|LOC_LABEL" -- apps packages UI ':!**/drizzle/**'
git -C $W grep -nE "\"(rest|coffee|kiosk)\"" -- apps/api/src packages/domain/src UI/src packages/contract/src ':!*.test.ts' ':!*.test.tsx' ':!**/__tests__/**' ':!**/fixtures/**' ':!apps/api/src/test/**' ':!apps/api/src/db/seed.ts'
git -C $W grep -n "closed union" -- apps packages UI | grep -i "loc"
```

Expected: all three print nothing. Fix every hit, including comments.

- [ ] **Step 4: The full local gate**

```bash
pnpm -C $W turbo typecheck
TEST_DATABASE_URL=postgres://rch:rch@localhost:5440/rch_test pnpm -C $W turbo test
pnpm -C $W lint
pnpm -C $W check:boundaries
pnpm -C $W --filter @rch/ui build
```

Expected: all green.
- Coverage floors hold in every package. If one has risen, raise its threshold to one point under the new figure,
  as the repo does.
- `knip` (inside `pnpm lint`) reports no unused export. If it flags `holding`, `placesFor` or a selector, the
  consumer is missing: wire it, don't delete it.

- [ ] **Step 5: Commit**

Message: "Remove the compiled-in outlet and location lists", followed by the trailers.

---

### Task 11: Guides

**Files:**
- Modify: `CLAUDE.md`, `apps/api/CLAUDE.md`, `packages/contract/CLAUDE.md`, `packages/domain/CLAUDE.md`, `UI/CLAUDE.md`
- Modify: `README.md`, `UI/README.md`, `deploy/RUNBOOK.md`

Every statement in these files must be true of the code at HEAD. Read each file whole before editing.

- [ ] **Step 1: Root `CLAUDE.md`**

- **"What this is":** keep "three retail outlets" but say they are the ones the hospital opened with, and the super
  admin opens more from `/admin`.
- **Roles and scope, the admin bullet:** the `/admin` page manages staff accounts, **opens, edits, closes and
  reopens outlets**, and answers support tickets.
- **Server-side guarantees, lock order:** add that a write naming a location takes its row `FOR SHARE` through
  `lockLocation` in `apps/api/src/lib/locations.ts`, in the documents tier. A close takes it `FOR UPDATE`.
- **Domain invariants:** add

  > **Outlets are closed, never deleted.** A close is refused while the outlet holds stock, an open ticket, stock
  > request, kitchen order, shop ask or product request, or an active staff member, and the refusal names every
  > one. A closed outlet takes no sale, transfer, ask, kitchen order, adjustment, menu listing or void, and no
  > staff can be posted to it. A reopen restores it as it was.

- **Conventions:** the first bullet becomes

  > `Role` and every status are closed unions. Never widen one with `string`. A location key is data: the central
  > store and kitchen are `STORE` / `KITCHEN` from `@rch/contract`, and outlets are read from the location master
  > (`outletKeys` in `@rch/domain`, `openOutlets()` / `allOutlets()` in the UI), never listed.

- [ ] **Step 2: Nested guides, READMEs, runbook**

- **`apps/api/CLAUDE.md`:**
  - `lib/locations.ts` (`lockLocation`, `assertOpen`) is the one way a write names a location.
  - The admin module owns outlets, including the close blockers (`closeBlockers`, `closeRefusal`,
    `HOLDS_OUTLET`).
  - Outlet writes emit `["outlets", "locations"]`.
- **`packages/contract/CLAUDE.md`:** location keys are checked strings, not an enum. "Closed enums, never widened"
  still applies to roles and statuses.
- **`packages/domain/CLAUDE.md`:** list `locations.ts`, meaning `outletKeys`, `operationalKeys`, `worksAt`,
  `placesFor`, `outletKeyFor`, `HOLDS_OUTLET`, `holding` and `closeRefusal`, plus `parFactor`.
- **`UI/CLAUDE.md`:**
  - the admin page's three tabs;
  - the `openOutlets` / `allOutlets` / `operationalLocs` / `locName` selectors, and when to use which;
  - the `locations` and `outlets` refetch readers;
  - the admin slice's outlet state.
- **`README.md` / `UI/README.md`:** wherever the admin page or the outlets are described.
- **`deploy/RUNBOOK.md`:**
  - Lines 87–92, 673–696 and 1545 name `store|kitchen|rest|coffee|kiosk` for the users CLI and describe the
    locations. Rewrite them: `--loc` takes any location key, and outlets are opened from `/admin`.
  - Note that migration 0015 is additive and backfills par factors.

- [ ] **Step 3: Check and commit**

Run `git -C $W grep -n "OUTLETS\|ALL_LOCS\|PAR_FACTOR\|rest|coffee|kiosk" -- '*.md' ':!docs/superpowers/**'`.

Expected: no hits.

Commit with the message "Bring the guides up to outlet management", followed by the trailers.

---

## After the plan

Run the full local gate once more on the finished branch (Task 10 Step 4). Then report back to the user. **Don't
push, and don't rebase onto `origin/develop`, without the user's go-ahead.** Pushing to `develop` deploys the live
box. When they give it:
- rebase onto `origin/develop`;
- renumber the migration if a parallel change took 0015;
- resolve conflicts with the recipe removal and `feature/audit-log`, which needs `AUDIT_LABELS` entries for the
  five new routes if it has landed.
