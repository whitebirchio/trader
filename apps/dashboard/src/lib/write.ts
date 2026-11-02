import { neon } from "@neondatabase/serverless";
import type { NewCommand } from "./commands";

/**
 * Insert one owner command as trader_dashboard. The role defaults to
 * read-only, so the transaction switches itself to READ WRITE first;
 * neon-http's `readOnly: false` option doesn't override the role default
 * (found on staging, 2026-11-02). INSERT on capital_commands is still the
 * only write its grants allow (migration 0016).
 */
export async function insertCommand(databaseUrl: string, command: NewCommand): Promise<string> {
  const sql = neon(databaseUrl);
  const [, rows] = await sql.transaction([
    sql`SET TRANSACTION READ WRITE`,
    sql`INSERT INTO capital_commands (kind, amount, requested_by) VALUES (${command.kind}, ${command.amount}, ${command.requestedBy}) RETURNING id`,
  ]);
  const id = (rows as { id?: string }[] | undefined)?.[0]?.id;
  if (!id) throw new Error("capital_commands insert returned no row");
  return id;
}
