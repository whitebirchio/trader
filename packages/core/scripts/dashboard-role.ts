/**
 * Create (or rotate) the dashboard's read-only role, `trader_dashboard`, on one
 * Neon branch, then prove it can read and cannot write (SPEC-dashboard).
 *
 * Run with the branch's OWNER role, once per branch. Re-running rotates the
 * password, so store the new URL (scripts/set-dashboard-secrets.sh does both).
 *
 *   DATABASE_URL=<owner url> DASHBOARD_ROLE_PASSWORD=<alphanumeric> \
 *     npm run db:dashboard-role -w @trader/core [-- --print-url]
 *
 * With --print-url, the role's connection string is the ONLY thing written to
 * stdout (for scripts/put-ssm-secret.sh); everything else goes to stderr.
 */
import { neon } from "@neondatabase/serverless";

const ROLE = "trader_dashboard";
const ownerUrl = process.env.DATABASE_URL;
const password = process.env.DASHBOARD_ROLE_PASSWORD;
const log = (msg: string) => process.stderr.write(`${msg}\n`);

if (!ownerUrl) throw new Error("DATABASE_URL (owner role) is not set");
// Alphanumeric only: it's embedded in a URL and interpolated into CREATE ROLE.
if (!password || !/^[A-Za-z0-9]{24,}$/.test(password)) {
  throw new Error("DASHBOARD_ROLE_PASSWORD must be 24+ alphanumeric characters");
}

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
  // Every statement this role runs is read-only, whatever it asks for.
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

const [writes] = (await owner.query(
  `SELECT count(*)::int AS n FROM information_schema.role_table_grants
    WHERE grantee = $1 AND privilege_type <> 'SELECT'`,
  [ROLE],
)) as { n: number }[];
if (!writes || writes.n !== 0) throw new Error(`${ROLE} has ${writes?.n} non-SELECT grants`);
log("  ✓ SELECT-only grants");

// Prove it as the role. None of these probes can change data.
const roleUrl = new URL(ownerUrl);
roleUrl.username = ROLE;
roleUrl.password = password;
const reader = neon(roleUrl.toString());

async function expectDenied(label: string, query: string): Promise<void> {
  try {
    await reader.query(query);
  } catch (e) {
    if (/permission denied|read-only transaction/i.test(String((e as Error).message))) {
      log(`  ✓ ${label}: denied`);
      return;
    }
    throw e;
  }
  throw new Error(`${label} was NOT denied for ${ROLE}`);
}

await reader.query("SELECT count(*) FROM strategies");
log("  ✓ can read strategies");
await expectDenied("INSERT", "INSERT INTO equity_snapshots (trading_date, equity, cash, long_market_value) SELECT current_date, 1, 1, 1 WHERE false");
await expectDenied("UPDATE", "UPDATE risk_state SET kill_switch = kill_switch WHERE false");
await expectDenied("DELETE", "DELETE FROM positions WHERE false");
await expectDenied("CREATE TABLE", "CREATE TABLE trader_dashboard_probe (id int)");
log(`${ROLE} ready.`);

if (process.argv.includes("--print-url")) process.stdout.write(roleUrl.toString());
