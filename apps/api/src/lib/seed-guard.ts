// Whether a seed run is allowed to happen, decided as a pure function of the environment, the
// argv and the name the connection answers to. `cli/seed.ts` is argv-in / print-out around it,
// so the decisions below are testable without a database, a process or an exit code.
//
// Why the production rule is what it is: the chart renders `NODE_ENV=production` into **every**
// pod - the dev namespace and CI's kind cluster included - so `--allow-production` stopped
// meaning "yes, the real hospital" the moment it became the routine in-cluster form. A flag
// typed on every seed is a flag nobody reads. Naming the database instead is a sentence the
// operator has to mean: `--yes-seed rch_dev` cannot be muscle memory for `rch`, which is the
// only mistake this guard exists to prevent.

export type SeedGuardInput = { env: string | undefined; argv: readonly string[]; dbName: string };
export type SeedGuardDecision = { ok: true } | { exit: 2; message: string };

/** The name that follows a flag, or undefined when the flag is absent. `indexOf` answers -1 for
 *  a missing flag, and argv[0] would then be reported back as the name the operator typed. */
function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
}
const said = (v: string | undefined) => (v ? `"${v}"` : "nothing");

/**
 * Seeding rewrites the password of every seeded account, and with `--force` it empties every
 * table first. Locally that is the ordinary way to get a database; in production both are
 * destructions of different sizes, so each asks for the database's own name back:
 *
 * - `--yes-seed <name>` for the plain path (the passwords),
 * - `--yes-destroy <name>` as well for `--force` (the tables).
 *
 * `--allow-production` is kept as an alias for the first so an old runbook line fails loudly
 * rather than silently doing the wrong thing - on its own it is refused, and the refusal names
 * the flag that replaced it.
 */
export function seedGuard({ env, argv, dbName }: SeedGuardInput): SeedGuardDecision {
  if (env !== "production") return { ok: true };

  const yesSeed = valueAfter(argv, "--yes-seed");
  if (yesSeed !== dbName) {
    return {
      exit: 2,
      message: argv.includes("--allow-production") && yesSeed === undefined
        ? `Refusing to seed ${dbName}: --allow-production is not enough on its own - the chart sets NODE_ENV=production in every pod, so pass --yes-seed ${dbName} to say which database you mean.`
        : `Refusing to seed ${dbName}: seeding rewrites every seeded account's password, so it needs --yes-seed ${dbName}, and you named ${said(yesSeed)}.`,
    };
  }

  if (argv.includes("--force")) {
    const yesDestroy = valueAfter(argv, "--yes-destroy");
    if (yesDestroy !== dbName) {
      return { exit: 2, message: `Refusing to empty ${dbName}: --force in production needs --yes-destroy ${dbName}, and you named ${said(yesDestroy)}.` };
    }
  }
  return { ok: true };
}
