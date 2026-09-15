import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PayerKindSchema } from "@rch/contract";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { importPayers, parsePayerCsv, sayCsvError, PAYER_CSV_COLUMNS } from "../lib/payers-admin.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { csv: { type: "string" }, "replace-names": { type: "boolean" } },
});
const needCsv = (): string => { const v = values.csv; if (!v) { console.error("--csv is required"); process.exit(2); } return v; };

/** What the file has to look like, said before the refusal rather than after it. */
const usage = () => {
  console.error("usage: payers import --csv <file> [--replace-names]");
  console.error(`  the file is ${PAYER_CSV_COLUMNS.join(",")}, one payer a line; a header row naming those columns is optional`);
  console.error(`  --csv            kind must be one of ${PayerKindSchema.options.join("|")}`);
  console.error("  --replace-names  update the name of an id already on the roster (without it, such a row is skipped)");
};

// `statementTimeoutMs: 0` and a pool of one, like every other CLI: a ward list of a few thousand
// rows goes in as one transaction and is allowed to take longer than a request ever may.
const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1, statementTimeoutMs: 0 });
try {
  switch (positionals[0]) {
    case "import": {
      const file = needCsv();
      const { rows, errors } = parsePayerCsv(readFileSync(file, "utf8"));
      if (errors.length > 0) {
        // Every bad row at once, and nothing written: a half-loaded ward list is one nobody can
        // reconcile, so the file is fixed and re-run rather than patched up afterwards.
        console.error(`${file} was not loaded - ${errors.length} row${errors.length === 1 ? "" : "s"} to fix first:`);
        for (const e of errors) console.error(`  ${sayCsvError(e)}`);
        console.error(`  allowed kinds: ${PayerKindSchema.options.join("|")}`);
        process.exit(2);
      }
      const r = await importPayers(db, rows, { replaceNames: values["replace-names"] === true });
      // A rename never reopens a closed account, so say how many of them the till still cannot
      // bill to rather than let "renamed 3" read as three people back on the payer picker.
      const renamed = r.renamedInactive > 0 ? `${r.renamed} renamed (${r.renamedInactive} still inactive)` : `${r.renamed} renamed`;
      console.log(`${file}: ${r.added} added, ${renamed}, ${r.skipped} already on the roster (${rows.length} rows read)`);
      if (r.renamedInactive > 0) console.log("  a deactivated payer keeps its switch - a rename does not put it back on the till");
      if (r.skipped > 0 && values["replace-names"] !== true) console.log("  re-run with --replace-names to update the names of the rows that were skipped");
      break;
    }
    default:
      usage();
      process.exit(2);
  }
} finally { await pool.end(); }
