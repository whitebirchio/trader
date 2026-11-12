import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * The tables this connection's role could change: insert, update, delete or
 * truncate. Checked from the catalog, so asking writes nothing. Empty means
 * the role can only read, like the dashboard's (ADR-018: Claude's read-only
 * checks run through it).
 */
export async function writableTables(db: Db): Promise<string[]> {
  const result = await db.execute<{ table: string }>(sql`
    select c.relname as table
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
    order by c.relname`);
  const rows = Array.isArray(result) ? result : (result as { rows: { table: string }[] }).rows;
  return rows.map((r) => r.table);
}
