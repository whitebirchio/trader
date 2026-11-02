import { neon } from "@neondatabase/serverless";
import type { NewCommand } from "./commands";

/**
 * Insert one owner command as trader_dashboard. The role defaults to
 * read-only, so this runs as an explicit READ WRITE transaction; INSERT on
 * capital_commands is the only write its grants allow (migration 0016).
 */
export async function insertCommand(databaseUrl: string, command: NewCommand): Promise<string> {
  const sql = neon(databaseUrl);
  const [rows] = await sql.transaction(
    [sql`INSERT INTO capital_commands (kind, amount, requested_by) VALUES (${command.kind}, ${command.amount}, ${command.requestedBy}) RETURNING id`],
    { readOnly: false },
  );
  const id = (rows as { id?: string }[] | undefined)?.[0]?.id;
  if (!id) throw new Error("capital_commands insert returned no row");
  return id;
}
