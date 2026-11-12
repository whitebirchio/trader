/**
 * Create (or rotate) `trader_readonly` on production's Neon branch: the role
 * behind the read-only status scripts Claude may run (ADR-018: risk:status,
 * strategy:show, capital:status, scorecard:show). It can read every table and
 * write none. Unlike the dashboard's role, it has no INSERT on
 * capital_commands, so no session, read-write or not, can start a withdrawal.
 * Then prove it, connecting as the role.
 *
 * Run with the owner role. Re-running rotates the password, so store the new
 * URL (scripts/set-readonly-secret.sh does both).
 *
 *   DATABASE_URL=<owner url> READONLY_ROLE_PASSWORD=<alphanumeric> \
 *     npm run db:readonly-role -w @trader/core [-- --print-url]
 *
 * With --print-url, the role's connection string is the ONLY thing written to
 * stdout (for scripts/put-ssm-secret.sh); everything else goes to stderr.
 */
import { neon } from "@neondatabase/serverless";

const ROLE = "trader_readonly";
const ownerUrl = process.env.DATABASE_URL;
const password = process.env.READONLY_ROLE_PASSWORD;
const log = (msg: string) => process.stderr.write(`${msg}\n`);

if (!ownerUrl) throw new Error("DATABASE_URL (owner role) is not set");
// Alphanumeric only: it's embedded in a URL and interpolated into CREATE ROLE.
if (!password || !/^[A-Za-z0-9]{24,}$/.test(password)) throw new Error("READONLY_ROLE_PASSWORD must be 24+ alphanumeric characters");

const owner = neon(ownerUrl);
log(`Configuring ${ROLE} on ${new URL(ownerUrl).host} …`);
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
  // A second guard: every transaction starts read-only, though its grants alone already allow no write.
  `ALTER ROLE ${ROLE} SET default_transaction_read_only = on`,
  `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${ROLE}', current_database()); END $$`,
  `GRANT USAGE ON SCHEMA public TO ${ROLE}`,
  `REVOKE CREATE ON SCHEMA public FROM ${ROLE}`,
  `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM ${ROLE}`,
  `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE}`,
  // Tables added by later migrations are readable too, and nothing more.
  `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT SELECT ON TABLES TO ${ROLE}`,
];
for (const statement of statements) await owner.query(statement);

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
    WHERE grantee = $1 AND privilege_type <> 'SELECT'`,
  [ROLE],
)) as { table_name: string; privilege_type: string }[];
if (writes.length > 0) throw new Error(`${ROLE} must have SELECT only; found ${JSON.stringify(writes)}`);
log("  ✓ SELECT only");

// Prove it as the role, in read-write transactions too. None of these probes can change data.
const roleUrl = new URL(ownerUrl);
roleUrl.username = ROLE;
roleUrl.password = password;
const reader = neon(roleUrl.toString());

async function expectDenied(label: string, query: string): Promise<void> {
  try {
    await reader.transaction([reader.query("SET TRANSACTION READ WRITE"), reader.query(query)]);
  } catch (e) {
    if (/permission denied/i.test(String((e as Error).message))) {
      log(`  ✓ ${label} (read-write): denied`);
      return;
    }
    throw e;
  }
  throw new Error(`${label} was NOT denied for ${ROLE} in a read-write transaction`);
}

await reader.query("SELECT count(*) FROM strategies");
log("  ✓ can read strategies");
await expectDenied("INSERT capital_commands", "INSERT INTO capital_commands (kind, requested_by) SELECT 'cancel', 'probe' WHERE false");
await expectDenied("INSERT equity_snapshots", "INSERT INTO equity_snapshots (trading_date, equity, cash, long_market_value) SELECT current_date, 1, 1, 1 WHERE false");
await expectDenied("UPDATE risk_state", "UPDATE risk_state SET kill_switch = kill_switch WHERE false");
await expectDenied("DELETE positions", "DELETE FROM positions WHERE false");
await expectDenied("CREATE TABLE", "CREATE TABLE trader_readonly_probe (id int)");
log(`${ROLE} ready.`);

if (process.argv.includes("--print-url")) process.stdout.write(roleUrl.toString());
