/**
 * Create (or rotate) the MCP server's role, `trader_mcp`, on one Neon branch,
 * then prove its access is exactly what the tools need (SPEC-agent, review
 * finding R1): SELECT on everything, plus INSERT on `strategies` and
 * `audit_events` (submit_strategy's writes), `watchlist_notes`
 * (update_watchlist's, #32) and `thesis_lessons` (record_lesson's, #28). No UPDATE, DELETE,
 * TRUNCATE or DDL anywhere, so a leaked MCP credential can't edit positions,
 * orders or risk_state (migration 0021 also guards risk_state by owner).
 *
 * Run with the branch's OWNER role, once per branch. Re-running rotates the
 * password, so store the new URL (scripts/set-mcp-secrets.sh does both).
 *
 *   DATABASE_URL=<owner url> MCP_ROLE_PASSWORD=<alphanumeric> \
 *     npm run db:mcp-role -w @trader/core [-- --print-url]
 *
 * With --check, it changes nothing: it runs the same grant checks and probes
 * against the existing role, connecting with its stored URL.
 *
 *   DATABASE_URL=<owner url> MCP_DATABASE_URL=<the role's url> \
 *     npm run db:mcp-role -w @trader/core -- --check
 *
 * With --print-url, the role's connection string is the ONLY thing written to
 * stdout (for scripts/put-ssm-secret.sh); everything else goes to stderr.
 */
import { neon } from "@neondatabase/serverless";

const ROLE = "trader_mcp";
/** The tables submit_strategy writes (strategy versions and their audit events). */
const WRITES = ["strategies", "audit_events", "watchlist_notes", "thesis_lessons"] as const;
const ownerUrl = process.env.DATABASE_URL;
const check = process.argv.includes("--check");
const password = check ? decodeURIComponent(new URL(process.env.MCP_DATABASE_URL ?? "postgres://x@h").password) : process.env.MCP_ROLE_PASSWORD;
const log = (msg: string) => process.stderr.write(`${msg}\n`);

if (!ownerUrl) throw new Error("DATABASE_URL (owner role) is not set");
if (check && !process.env.MCP_DATABASE_URL) throw new Error("--check needs MCP_DATABASE_URL (the role's stored URL)");
// Alphanumeric only: it's embedded in a URL and interpolated into CREATE ROLE.
if (!password || !/^[A-Za-z0-9]{24,}$/.test(password)) {
  throw new Error("MCP_ROLE_PASSWORD must be 24+ alphanumeric characters");
}

const owner = neon(ownerUrl);
log(`${check ? "Checking" : "Configuring"} ${ROLE} on ${new URL(ownerUrl).host} …`);
if (!check) await configure();

async function configure(): Promise<void> {
  await owner.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN
        ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${password}';
      ELSE
        CREATE ROLE ${ROLE} WITH LOGIN PASSWORD '${password}';
      END IF;
    END $$`);

  const statements = [
    `ALTER ROLE ${ROLE} NOCREATEDB NOCREATEROLE NOINHERIT`,
    `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${ROLE}', current_database()); END $$`,
    `GRANT USAGE ON SCHEMA public TO ${ROLE}`,
    `REVOKE CREATE ON SCHEMA public FROM ${ROLE}`,
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM ${ROLE}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE}`,
    // Tables added by later migrations are readable too, and nothing more.
    `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT SELECT ON TABLES TO ${ROLE}`,
    // submit_strategy's writes: a strategy version (its serial needs the sequence) and its audit event.
    ...WRITES.map((t) => `GRANT INSERT ON ${t} TO ${ROLE}`),
    `GRANT USAGE ON SEQUENCE strategies_version_seq TO ${ROLE}`,
  ];
  for (const statement of statements) await owner.query(statement);
}

const [attrs] = (await owner.query(
  `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
          pg_has_role($1, 'neon_superuser', 'MEMBER') AS neon_superuser
     FROM pg_roles WHERE rolname = $1`,
  [ROLE],
)) as Record<string, boolean>[];
const powers = Object.entries(attrs ?? {}).filter(([, on]) => on).map(([name]) => name);
if (!attrs || powers.length > 0) throw new Error(`${ROLE} has admin powers: ${powers.join(", ")}`);
log("  ✓ no superuser/createdb/createrole/replication/bypassrls/neon_superuser");

const writes = (await owner.query(
  `SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE grantee = $1 AND privilege_type <> 'SELECT' ORDER BY table_name`,
  [ROLE],
)) as { table_name: string; privilege_type: string }[];
const expected = WRITES.map((t) => `${t}:INSERT`).sort().join(",");
if (writes.map((w) => `${w.table_name}:${w.privilege_type}`).sort().join(",") !== expected) {
  throw new Error(`${ROLE} grants must be SELECT plus INSERT on ${WRITES.join(" and ")}; found ${JSON.stringify(writes)}`);
}
log(`  ✓ SELECT, plus INSERT on ${WRITES.join(" and ")} only`);

// Prove it as the role. None of these probes can change data (WHERE false).
// --check connects exactly as the MCP server does, with its stored URL.
const roleUrl = new URL(check ? process.env.MCP_DATABASE_URL! : ownerUrl);
if (!check) {
  roleUrl.username = ROLE;
  roleUrl.password = password;
}
const mcp = neon(roleUrl.toString());

async function expectDenied(label: string, query: string): Promise<void> {
  try {
    await mcp.query(query);
  } catch (e) {
    if (/permission denied/i.test(String((e as Error).message))) {
      log(`  ✓ ${label}: denied`);
      return;
    }
    throw e;
  }
  throw new Error(`${label} was NOT denied for ${ROLE}`);
}

await mcp.query("SELECT count(*) FROM strategies");
await mcp.query("SELECT count(*) FROM broker_activities");
log("  ✓ can read");
await mcp.query("INSERT INTO strategies (authored_by, summary, document) SELECT 'claude', 'probe', '{}' WHERE false");
await mcp.query("INSERT INTO audit_events (actor, kind) SELECT 'claude', 'strategy.activated' WHERE false");
const [seq] = (await mcp.query("SELECT has_sequence_privilege('strategies_version_seq', 'USAGE') AS ok")) as { ok: boolean }[];
if (!seq?.ok) throw new Error(`${ROLE} can't use strategies_version_seq, so submit_strategy would fail`);
log("  ✓ INSERT strategies and audit_events (and the version sequence): allowed");
await expectDenied("INSERT orders", "INSERT INTO orders (client_order_id, intent_key, symbol, side, status) SELECT 'p', 'p', 'VTI', 'buy', 'intent' WHERE false");
await expectDenied("INSERT capital_commands", "INSERT INTO capital_commands (kind, requested_by) SELECT 'cancel', 'probe' WHERE false");
await expectDenied("UPDATE risk_state", "UPDATE risk_state SET kill_switch = kill_switch WHERE false");
await expectDenied("UPDATE positions", "UPDATE positions SET qty = qty WHERE false");
await expectDenied("DELETE positions", "DELETE FROM positions WHERE false");
await expectDenied("UPDATE strategies", "UPDATE strategies SET summary = summary WHERE false");
await expectDenied("CREATE TABLE", "CREATE TABLE trader_mcp_probe (id int)");
log(`${ROLE} ready.`);

if (process.argv.includes("--print-url")) process.stdout.write(roleUrl.toString());
