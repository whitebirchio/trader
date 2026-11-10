import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

/**
 * A Postgres with every real migration applied, in journal order:
 * the same set and order the real migrator applies, so neither the tests nor
 * the replay can drift from production's schema. Not exported from core's
 * index: PGlite is a dev dependency and must stay out of the Lambda bundles.
 * In memory by default; given a directory, its data lives there on disk (a
 * multi-year replay's database grows to several GB, too much to hold in RAM
 * for several at once).
 */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

interface Journal {
  entries: { idx: number; tag: string }[];
}

export async function migratedPglite(dataDir?: string): Promise<PGlite> {
  const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8")) as Journal;
  const pglite = new PGlite(dataDir);
  for (const entry of journal.entries.sort((a, b) => a.idx - b.idx)) {
    for (const statement of readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) await pglite.exec(statement);
    }
  }
  return pglite;
}
