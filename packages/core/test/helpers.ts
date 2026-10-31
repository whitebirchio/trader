import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "../src/db/client.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

interface Journal {
  entries: { idx: number; tag: string }[];
}

// Migrations in journal order — the same set and order the real migrator
// applies, so the test schema never drifts from production.
const journal = JSON.parse(
  readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
) as Journal;
const migrationSql = journal.entries
  .sort((a, b) => a.idx - b.idx)
  .map((e) => readFileSync(join(migrationsDir, `${e.tag}.sql`), "utf8"));

/**
 * Fresh in-memory Postgres with all real migrations applied. PGlite runs as
 * superuser, so role grants are not exercised here — the append-only trigger
 * is, and docs/SETUP.md verifies the grants against Neon.
 */
export async function createTestDb(): Promise<{ db: Db; pglite: PGlite }> {
  const pglite = new PGlite();
  for (const sql of migrationSql) {
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await pglite.exec(statement);
    }
  }
  const db = drizzle(pglite, { casing: "snake_case" }) as unknown as Db;
  return { db, pglite };
}
