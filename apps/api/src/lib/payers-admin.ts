// Bulk roster loading, for the day the hospital hands over a ward list or a payroll export
// rather than typing three hundred people into a form. Two halves, so the CLI is a thin shell:
// `parsePayerCsv` is pure and answers with every bad row at once, and `importPayers` writes what
// it is given inside **one** transaction — a file is loaded whole or not at all, because half a
// ward on the roster is worse than none (the operator cannot tell which half).
//
// Shares `payers-admin.ts`'s shape with `users-admin.ts`: a CLI's rules live here, beside the
// server's own helpers, and `src/cli/*.ts` only reads argv and prints.
import { eq, and } from "drizzle-orm";
import { PayerKindSchema, type PayerKind } from "@rch/contract";
import type { Db } from "../db/client.js";
import { payers } from "../db/schema/index.js";
import { withTransaction } from "./db.js";

/** One line of the file, once it has a kind the roster knows. */
export type PayerCsvRow = { kind: PayerKind; id: string; name: string };
/** Where the file is wrong, by the line number an editor shows and the column heading. */
export type PayerCsvError = { row: number; column: string; message: string };
export type ImportResult = { added: number; skipped: number; renamed: number };

/** The three columns, in the order the file must carry them. A header row naming them is
 *  optional — a payroll export usually has one, a hand-made list usually does not. */
export const PAYER_CSV_COLUMNS = ["kind", "id", "name"] as const;

const KINDS = PayerKindSchema.options.join(", ");
const badKind = (raw: string): string => `"${raw}" is not a payer kind — use one of ${KINDS}`;

/** How an error reads on the way out of the CLI. One sentence, naming the line and the column,
 *  so the person editing the file knows exactly which cell to fix. */
export const sayCsvError = (e: PayerCsvError): string => `row ${e.row}, column "${e.column}": ${e.message}`;

/**
 * What a row must be before it can reach the roster. Used twice on purpose: by the parser, which
 * reports every bad row in the file at once, and by the import, which refuses the whole file if
 * one is handed to it anyway — a caller that skipped the parse must not get half a load.
 */
export function checkPayerRow(row: { kind: string; id: string; name: string }): { column: string; message: string } | null {
  if (!PayerKindSchema.safeParse(row.kind).success) return { column: "kind", message: badKind(row.kind) };
  if (row.id.trim().length === 0) return { column: "id", message: "an id is required — it is the hospital's own number, not one this tool invents" };
  if (row.name.trim().length === 0) return { column: "name", message: "a name is required" };
  return null;
}

/** Splits one CSV line. Quoted fields are supported because a name may carry a comma
 *  ("Anand Kumar, Ward 3B"); doubled quotes inside a quoted field are one quote. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

const isHeader = (cells: string[]): boolean =>
  cells.length >= 3 && PAYER_CSV_COLUMNS.every((c, i) => cells[i].toLowerCase() === c);

/**
 * Read `kind,id,name` out of a file. Answers with **both** halves: the rows that are good and
 * every row that is not, each named by its line number in the file and the column that is wrong,
 * so one run of the tool tells the administrator everything to fix rather than one thing at a
 * time. Blank lines are skipped and a `#` line is a comment; a leading `kind,id,name` header is
 * recognised and skipped rather than reported as a bad kind.
 */
export function parsePayerCsv(text: string): { rows: PayerCsvRow[]; errors: PayerCsvError[] } {
  const rows: PayerCsvRow[] = [];
  const errors: PayerCsvError[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const row = i + 1;                                    // the line number an editor shows
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const cells = splitCsvLine(line);
    if (i === 0 && isHeader(cells)) continue;
    if (cells.length !== 3) {
      errors.push({ row, column: "row", message: `expected 3 columns (${PAYER_CSV_COLUMNS.join(", ")}), found ${cells.length}` });
      continue;
    }
    const [kind, id, name] = cells;
    const bad = checkPayerRow({ kind, id, name });
    if (bad) { errors.push({ row, ...bad }); continue; }
    rows.push({ kind: kind as PayerKind, id: id.trim(), name: name.trim() });
  }
  return { rows, errors };
}

/**
 * Write the rows onto the roster, in one transaction.
 *
 * An id already on that roster is **skipped**, not overwritten: the roster is the hospital's
 * register and a re-run of the same export must not quietly rename people. `replaceNames` is the
 * deliberate opposite — `--replace-names` on the CLI — and only then does an existing row's name
 * change, and only when it actually differs, so the count means "renamed", not "touched".
 *
 * A bad row takes the whole file down (the transaction rolls back), because a partly-loaded ward
 * list is one nobody can reconcile. `parsePayerCsv` has normally caught it already; this is the
 * guard for a caller that did not ask.
 */
export async function importPayers(db: Db, rows: PayerCsvRow[], opts: { replaceNames?: boolean } = {}): Promise<ImportResult> {
  return withTransaction(db, async (tx) => {
    const result: ImportResult = { added: 0, skipped: 0, renamed: 0 };
    for (const [i, row] of rows.entries()) {
      const bad = checkPayerRow(row);
      if (bad) throw new Error(sayCsvError({ row: i + 1, ...bad }));
      const where = and(eq(payers.kind, row.kind), eq(payers.id, row.id));
      const [existing] = await tx.select().from(payers).where(where).for("update");
      if (!existing) {
        // `onConflictDoNothing` rather than a bare insert: the read above is not a lock on a row
        // that does not exist yet, so a second loader adding the same id in the same instant is
        // the one race this cannot see, and it resolves as a skip rather than as a crash.
        const [inserted] = await tx.insert(payers)
          .values({ kind: row.kind, id: row.id, name: row.name, active: true })
          .onConflictDoNothing().returning();
        if (inserted) result.added += 1; else result.skipped += 1;
        continue;
      }
      if (!opts.replaceNames || existing.name === row.name) { result.skipped += 1; continue; }
      await tx.update(payers).set({ name: row.name, updatedAt: new Date() }).where(where);
      result.renamed += 1;
    }
    return result;
  });
}
